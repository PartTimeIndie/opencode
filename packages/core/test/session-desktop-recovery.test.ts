import { expect } from "bun:test"
import { Cause, DateTime, Effect, Exit, Layer, Schema } from "effect"

const interrupted = (exit: Exit.Exit<unknown, unknown>) => Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionActivity } from "@opencode-ai/core/session/activity"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionMessageUpdater } from "@opencode-ai/core/session/message-updater"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionActivityTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { FileMutationPendingTable } from "@opencode-ai/core/file-knowledge.sql"
import { QuestionTable } from "@opencode-ai/core/question/sql"
import { QuestionV2 } from "@opencode-ai/core/question"
import { BackgroundJobTable } from "@opencode-ai/core/background-job.sql"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const activity = SessionActivity.layer.pipe(Layer.provide(database), Layer.provide(events))
const projector = SessionProjector.layer.pipe(Layer.provide(database), Layer.provide(events))
const it = testEffect(Layer.mergeAll(database, events, activity, projector))
const sessionID = SessionSchema.ID.make("ses_desktop_recovery")
const model = { providerID: "fixture", id: "model", variant: "high" }
const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/fixture"), sandboxes: [] }).run()
  yield* db.insert(SessionTable).values({
    id: sessionID, project_id: Project.ID.global, slug: "fixture", directory: "/fixture", title: "Fixture", version: "test",
    agent: "build", model,
  }).run()
  yield* db.insert(EventSequenceTable).values({ aggregate_id: sessionID, seq: 1 }).run()
  yield* db.insert(SessionActivityTable).values({
    id: "act_crashed", session_id: sessionID, status: "running", kind: "prompt", owner_id: "old-owner",
    lease_until: 0, opened_seq: 0, time_created: 1, time_updated: 1,
  }).run()
  const data = { agent: "build", model, content: [{ type: "text", id: "partial", text: "Saved partial" }], time: { created: 2 } }
  yield* db.insert(SessionMessageTable).values({
    id: SessionMessage.ID.make("msg_partial"), session_id: sessionID, seq: 1, type: "assistant", time_created: 2, data,
  }).run()
  return db
})
const claim = () => SessionActivity.Service.use((activity) => activity.open({
  sessionID, ownerID: "replacement-owner", openedSeq: 1, kind: "recovery",
  crash: { activityID: "act_crashed", previousOwner: "old-owner" },
}))

it.effect("atomically claims the exact predecessor once, preserves identity and records a system notice", () => Effect.gen(function* () {
  const db = yield* setup
  const first = yield* claim()
  expect(first.id).toBe("act_crashed")
  expect(first.recoveryAttempts).toBe(1)
  expect(first.reason).toBe("desktop-crash:old-owner")
  expect(interrupted(yield* Effect.exit(claim()))).toBe(true)
  const messages = yield* db.select().from(SessionMessageTable).all()
  expect(messages.filter((message) => message.type === "system")).toHaveLength(1)
  expect(messages.filter((message) => message.type === "user")).toHaveLength(0)
  const stored = yield* db.select().from(EventTable).where(eq(EventTable.type,
    EventV2.versionedType(SessionEvent.ContextUpdated.type, SessionEvent.ContextUpdated.sync?.version ?? 1))).get()
  expect(stored).toBeDefined()
  if (!stored) throw new Error("missing durable notice event")
  const replay: SessionMessageUpdater.MemoryState = { messages: [] }
  yield* SessionMessageUpdater.update(SessionMessageUpdater.memory(replay), {
    id: stored.id, type: SessionEvent.ContextUpdated.type, replay: true,
    data: Schema.decodeUnknownSync(SessionEvent.ContextUpdated.data)(EventV2.decodeStoredEventData(stored.data)),
  })
  expect(replay.messages[0].metadata).toEqual({ systemNotice: "server-recovery" })
  const session = yield* db.select().from(SessionTable).get()
  expect(session?.model).toEqual(model)
  expect(session?.agent).toBe("build")
}))

for (const kind of ["pending-tool", "running-tool", "error-tool", "question", "orphaned-question", "mutation", "job", "stop", "retry", "failure", "model-change", "missing-model", "budget", "child"] as const) {
  it.effect(`pauses ${kind} without changing or replaying the unsafe evidence`, () => Effect.gen(function* () {
    const db = yield* setup
    if (kind.endsWith("tool")) {
      const status = kind === "pending-tool" ? "pending" : kind === "running-tool" ? "running" : "error"
      const state = status === "pending" ? { status, input: "{}" } : {
        status, input: {}, structured: {}, content: [], ...(status === "error" ? { error: { type: "unknown", message: "unknown outcome" } } : {}),
      }
      const data = {
        agent: "build", model, time: { created: 2 },
        content: [{ type: "tool", id: "call_uncertain", name: "bash", state, time: { created: 2 } }],
      }
      yield* db.update(SessionMessageTable).set({ data }).where(eq(SessionMessageTable.id, SessionMessage.ID.make("msg_partial"))).run()
    }
    if (kind === "question" || kind === "orphaned-question") yield* db.insert(QuestionTable).values({
      id: QuestionV2.ID.make("que_crash"), session_id: sessionID, activity_id: "act_crashed", seq: 2,
      state: kind === "question" ? "active" : "orphaned", mode: "blocking", detached: false,
      request: { id: QuestionV2.ID.make("que_crash"), sessionID, mode: "blocking", revision: 1, actions: [], questions: [{ question: "Allow?", options: [{ label: "Yes", description: "Allow" }] }] },
    }).run()
    if (kind === "mutation") yield* db.insert(FileMutationPendingTable).values({ target: "/fixture/a", operation_id: "op", session_id: sessionID, receipt_id: 1 }).run()
    if (kind === "job") yield* db.insert(BackgroundJobTable).values({ id: "job_crash", type: "task", status: "running", parent_session_id: sessionID }).run()
    if (kind === "stop" || kind === "retry" || kind === "failure") yield* db.insert(EventTable).values({
      id: EventV2.ID.make(`evt_${kind}`), aggregate_id: sessionID, seq: 1,
      type: kind === "stop" ? SessionEvent.InterruptRequested.type : kind === "retry" ? SessionEvent.Retried.type : SessionEvent.Step.Failed.type, data: {},
    }).run()
    if (kind === "model-change") yield* db.update(SessionTable).set({ model: { ...model, variant: "low" } }).run()
    if (kind === "missing-model") yield* db.update(SessionTable).set({ model: null }).run()
    if (kind === "budget") yield* db.update(SessionActivityTable).set({ recovery_attempts: 3 }).run()
    if (kind === "child") yield* db.update(SessionTable).set({ parent_id: SessionSchema.ID.make("ses_parent") }).run()
    expect(interrupted(yield* Effect.exit(claim()))).toBe(true)
    const row = yield* db.select().from(SessionActivityTable).get()
    expect(row?.status).toBe("interrupted")
    expect(row?.reason).toBe("desktop-crash-blocked")
    expect(row?.last_error).toBeTruthy()
    if (kind.endsWith("tool")) expect(row?.last_error).toContain("Tool-Aufruf")
    expect(interrupted(yield* Effect.exit(claim()))).toBe(true)
    const notices = yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.type, "system")).all()
    expect(notices).toHaveLength(1)
    if (kind.includes("question")) {
      const question = yield* db.select().from(QuestionTable).get()
      expect(question?.state).toBe(kind === "question" ? "active" : "orphaned")
    }
    if (kind === "mutation") expect(yield* db.select().from(FileMutationPendingTable).all()).toHaveLength(1)
  }))
}

for (const status of ["completed", "failed", "interrupted"] as const) {
  it.effect(`does not revive a ${status} activity`, () => Effect.gen(function* () {
    const db = yield* setup
    yield* db.update(SessionActivityTable).set({ status }).run()
    expect(interrupted(yield* Effect.exit(claim()))).toBe(true)
    expect((yield* db.select().from(SessionActivityTable).get())?.status).toBe(status)
    expect(yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.type, "system")).all()).toHaveLength(0)
  }))
}

it.effect("a real versioned interrupt event blocks crash admission even before the old activity terminalizes", () => Effect.gen(function* () {
  const db = yield* setup
  const events = yield* EventV2.Service
  yield* events.publish(SessionEvent.InterruptRequested, { sessionID, timestamp: DateTime.makeUnsafe(4) })
  expect(interrupted(yield* Effect.exit(claim()))).toBe(true)
  expect((yield* db.select().from(SessionActivityTable).get())?.last_error).toContain("Stop")
}))

for (const event of [SessionEvent.ModelSwitched, SessionEvent.AgentSwitched]) {
  for (const versioned of [false, true]) {
    it.effect(`pauses ${event.type} (${versioned ? "versioned" : "unversioned"}) even when saved selections match again`, () => Effect.gen(function* () {
      const db = yield* setup
      yield* db.insert(EventTable).values({
        id: EventV2.ID.make("evt_selection_boundary"), aggregate_id: sessionID, seq: 1,
        type: versioned ? EventV2.versionedType(event.type, event.sync?.version ?? 1) : event.type,
        data: {},
      }).run()
      expect(interrupted(yield* Effect.exit(claim()))).toBe(true)
      const row = yield* db.select().from(SessionActivityTable).get()
      expect(row?.status).toBe("interrupted")
      expect(row?.last_error).toContain("Auswahlwechsel")
      expect((yield* db.select().from(SessionTable).get())?.model).toEqual(model)
    }))
  }
}

it.effect("recovers when selection persistence precedes the activity's first model call", () => Effect.gen(function* () {
  const db = yield* setup
  // Mirror the production ordering of a first-input promotion or runner adoption:
  // the selection is persisted between activity claim and the first Step.Started,
  // so the boundary events precede the oldest executed assistant message.
  yield* db.update(SessionMessageTable).set({ seq: 3 }).where(eq(SessionMessageTable.id, SessionMessage.ID.make("msg_partial"))).run()
  yield* db.update(EventSequenceTable).set({ seq: 5 }).where(eq(EventSequenceTable.aggregate_id, sessionID)).run()
  yield* db.insert(EventTable).values({
    id: EventV2.ID.make("evt_setup_agent"), aggregate_id: sessionID, seq: 1,
    type: EventV2.versionedType(SessionEvent.AgentSwitched.type, SessionEvent.AgentSwitched.sync?.version ?? 1), data: {},
  }).run()
  yield* db.insert(EventTable).values({
    id: EventV2.ID.make("evt_setup_model"), aggregate_id: sessionID, seq: 2,
    type: EventV2.versionedType(SessionEvent.ModelSwitched.type, SessionEvent.ModelSwitched.sync?.version ?? 1), data: {},
  }).run()
  const first = yield* claim()
  expect(first.id).toBe("act_crashed")
  expect(first.recoveryAttempts).toBe(1)
  const row = yield* db.select().from(SessionActivityTable).get()
  expect(row?.status).toBe("recovering")
  const notices = yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.type, "system")).all()
  expect(notices).toHaveLength(1)
  expect(JSON.stringify(notices[0]?.data)).toContain("setze die unterbrochene Arbeit")
}))

it.effect("pauses when the selection changes after the activity's first model call", () => Effect.gen(function* () {
  const db = yield* setup
  yield* db.insert(EventTable).values({
    id: EventV2.ID.make("evt_late_model_switch"), aggregate_id: sessionID, seq: 4,
    type: EventV2.versionedType(SessionEvent.ModelSwitched.type, SessionEvent.ModelSwitched.sync?.version ?? 1), data: {},
  }).run()
  expect(interrupted(yield* Effect.exit(claim()))).toBe(true)
  const row = yield* db.select().from(SessionActivityTable).get()
  expect(row?.status).toBe("interrupted")
  expect(row?.last_error).toContain("Auswahlwechsel")
}))

it.effect("a different owner is never taken over", () => Effect.gen(function* () {
  const db = yield* setup
  yield* db.update(SessionActivityTable).set({ owner_id: "unrelated", lease_until: Date.now() + 60_000 }).run()
  expect(interrupted(yield* Effect.exit(claim()))).toBe(true)
  expect((yield* db.select().from(SessionActivityTable).get())?.owner_id).toBe("unrelated")
}))
