import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { DateTime, Effect, Exit, Layer, Schema } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventSequenceTable } from "@opencode-ai/core/event/sql"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionContextEpoch } from "@opencode-ai/core/session/context-epoch"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionFork } from "@opencode-ai/core/session/fork"
import { SessionHistory } from "@opencode-ai/core/session/history"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import {
  SessionContextEpochTable,
  SessionInputTable,
  SessionMessageTable,
  SessionTable,
} from "@opencode-ai/core/session/sql"
import { SystemContext } from "@opencode-ai/core/system-context/index"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const it = testEffect(database)
const events = EventV2.layer.pipe(Layer.provide(database))
const projected = testEffect(Layer.mergeAll(database, events, SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))))
const sessionID = SessionSchema.ID.make("ses_fork_source")
const userID = SessionMessage.ID.make("msg_fork_user")
const assistantID = SessionMessage.ID.make("msg_fork_assistant")
const model = { id: "model", providerID: "provider", variant: "high" }
const user = { text: "Do the work", time: { created: 1 } }
const assistant = {
  agent: "build",
  model,
  content: [{ type: "text", id: "text", text: "Completed turn" }],
  finish: "stop",
  time: { created: 2, completed: 3 },
}

function inFlightData(content: unknown, finish?: "tool-calls") {
  const {
    id: _,
    type: __,
    ...data
  } = Schema.encodeSync(SessionMessage.Message)(
    Schema.decodeUnknownSync(SessionMessage.Message)({
      id: "msg_fork_inflight",
      type: "assistant",
      ...assistant,
      content,
      finish,
      time: { created: 4 },
    }),
  )
  return data
}

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/fork"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: ProjectV2.ID.global,
      directory: "/fork",
      slug: "fork",
      title: "source",
      version: "test",
      agent: "build",
      model,
      metadata: { main: true, capabilityLease: "not inherited" },
      permission: [{ permission: "bash", pattern: "*", action: "deny" }],
    })
    .run()
    .pipe(Effect.orDie)
  yield* db.insert(EventSequenceTable).values({ aggregate_id: sessionID, seq: 10 }).run().pipe(Effect.orDie)
  yield* db
    .insert(SessionContextEpochTable)
    .values({
      session_id: sessionID,
      agent: AgentV2.ID.make("build"),
      baseline: "baseline",
      baseline_seq: 0,
      snapshot: {},
      revision: 2,
    })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionMessageTable)
    .values([
      { id: userID, session_id: sessionID, type: "user", seq: 1, data: user },
      { id: assistantID, session_id: sessionID, type: "assistant", seq: 3, data: assistant },
    ])
    .run()
    .pipe(Effect.orDie)
  return db
})

function reason(effect: ReturnType<typeof SessionFork.capture>) {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    if (Exit.isSuccess(exit)) throw new Error("Expected capture to fail closed")
    const failure = exit.cause.reasons.find((cause) => cause._tag === "Fail")
    if (failure?._tag !== "Fail") return undefined
    expect(failure.error.message).toBe(`Session fork capture refused (${failure.error.reason})`)
    return failure.error.reason
  })
}

describe("read-only V2 fork capture (not child provisioning)", () => {
  it.effect(
    "captures an exact event fence, completed history, epoch and actual model without metadata or admissions",
    () =>
      Effect.gen(function* () {
        const db = yield* setup
        const result = yield* SessionFork.capture(db, { sessionID, throughSeq: 10 })
        expect(result).toMatchObject({
          sourceSessionID: sessionID,
          throughSeq: 10,
          selectedModel: model,
          actualModel: model,
          epoch: { baseline: "baseline", revision: 2, baseline_seq: 0 },
          permission: [{ permission: "bash", action: "deny" }],
        })
        expect(result.entries.map((entry) => entry.message.id)).toEqual([userID, assistantID])
        expect(result).not.toHaveProperty("metadata")
        expect(result).not.toHaveProperty("input")
        expect(yield* db.select().from(SessionTable).all().pipe(Effect.orDie)).toHaveLength(1)
        expect(yield* db.select().from(SessionInputTable).all().pipe(Effect.orDie)).toEqual([])
      }),
  )

  for (const throughSeq of [-1, 9, 11, 10.5, NaN]) {
    it.effect(`rejects a stale, future or invalid fence ${throughSeq}`, () =>
      Effect.gen(function* () {
        const db = yield* setup
        expect(yield* reason(SessionFork.capture(db, { sessionID, throughSeq }))).toBe("boundary")
      }),
    )
  }

  it.effect("uses the observed agent without inventing a default for a nullable selection", () =>
    Effect.gen(function* () {
      const db = yield* setup
      yield* db.update(SessionTable).set({ agent: null }).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
      expect(yield* SessionFork.capture(db, { sessionID, throughSeq: 10 })).toMatchObject({
        selectedAgent: null,
        actualAgent: "build",
      })
      yield* db
        .update(SessionContextEpochTable)
        .set({ agent: AgentV2.ID.make("other") })
        .where(eq(SessionContextEpochTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)
      expect(yield* reason(SessionFork.capture(db, { sessionID, throughSeq: 10 }))).toBe("epoch")
    }),
  )

  it.effect("rejects queued and held inputs instead of silently omitting assigned work", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const pendingID = SessionMessage.ID.make("msg_fork_pending")
      yield* db
        .insert(SessionInputTable)
        .values({
          id: pendingID,
          session_id: sessionID,
          admitted_seq: 9,
          prompt: { text: "New assignment" },
          delivery: "queue",
          held_at: 1,
        })
        .run()
        .pipe(Effect.orDie)
      expect(yield* reason(SessionFork.capture(db, { sessionID, throughSeq: 10 }))).toBe("pending")
    }),
  )

  for (const change of [
    { replacement_seq: 8 },
    { baseline_seq: 11 },
    { agent: AgentV2.ID.make("other") },
    { revision: -1 },
    { snapshot: { invalid: { revision: "wrong" } } },
  ]) {
    it.effect(`rejects incompatible context state ${JSON.stringify(change)}`, () =>
      Effect.gen(function* () {
        const db = yield* setup
        // The malformed persisted snapshot deliberately exercises the decoder.
        yield* db
          .run(
            `UPDATE session_context_epoch SET ${Object.entries(change)
              .map(([key, value]) => `${key} = '${typeof value === "object" ? JSON.stringify(value) : value}'`)
              .join(", ")}`,
          )
          .pipe(Effect.orDie)
        expect(yield* reason(SessionFork.capture(db, { sessionID, throughSeq: 10 }))).toBe("epoch")
      }),
    )
  }

  it.effect("refuses a half-finished tool pair even in an earlier assistant message", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const data = {
        ...assistant,
        content: [
          { type: "tool", id: "call", name: "write", state: { status: "pending", input: "{}" }, time: { created: 2 } },
        ],
      }
      yield* db
        .insert(SessionMessageTable)
        .values({
          id: SessionMessage.ID.make("msg_earlier_tool"),
          session_id: sessionID,
          type: "assistant",
          seq: 2,
          data,
        })
        .run()
        .pipe(Effect.orDie)
      expect(yield* reason(SessionFork.capture(db, { sessionID, throughSeq: 10 }))).toBe("history")
    }),
  )

  it.effect("rejects a still-streaming last assistant and corrupt persisted history", () =>
    Effect.gen(function* () {
      const db = yield* setup
      yield* db
        .update(SessionMessageTable)
        .set({ data: { ...assistant, time: { created: 2 } } })
        .where(eq(SessionMessageTable.id, assistantID))
        .run()
        .pipe(Effect.orDie)
      expect(yield* reason(SessionFork.capture(db, { sessionID, throughSeq: 10 }))).toBe("boundary")
      yield* db.run("UPDATE session_message SET data='{}' WHERE type='assistant'").pipe(Effect.orDie)
      expect(yield* reason(SessionFork.capture(db, { sessionID, throughSeq: 10 }))).toBe("history")
    }),
  )

  const runningCall = {
    type: "tool",
    id: "call",
    name: "orchestrator",
    state: { status: "running", input: {}, structured: {}, content: [] },
    time: { created: 4 },
  }
  it.effect("keeps imported system history across child baseline replacement without retaining superseded child updates", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const makeData = (message: unknown) => {
        const { id: _id, type: _type, ...data } = Schema.encodeSync(SessionMessage.Message)(
          Schema.decodeUnknownSync(SessionMessage.Message)(message),
        )
        return data
      }
      const inherited = SessionMessage.ID.make("msg_inherited_update")
      const compact = SessionMessage.ID.make("msg_inherited_compaction")
      const superseded = SessionMessage.ID.make("msg_child_superseded_update")
      const current = SessionMessage.ID.make("msg_child_current_update")
      yield* db.update(SessionTable).set({ fork_history_seq: 4, parent_id: SessionSchema.ID.make("ses_parent") })
        .where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
      yield* db.insert(SessionMessageTable).values([
        { id: inherited, session_id: sessionID, seq: 2, type: "system", data: makeData({ id: inherited, type: "system", text: "Inherited", time: { created: 2 } }) },
        { id: compact, session_id: sessionID, seq: 4, type: "compaction", data: makeData({ id: compact, type: "compaction", reason: "manual", summary: "Summary", recent: "", time: { created: 4 } }) },
        { id: superseded, session_id: sessionID, seq: 5, type: "system", data: makeData({ id: superseded, type: "system", text: "Superseded", time: { created: 5 } }) },
        { id: current, session_id: sessionID, seq: 7, type: "system", data: makeData({ id: current, type: "system", text: "Current", time: { created: 7 } }) },
      ]).run().pipe(Effect.orDie)
      const entries = yield* SessionHistory.entriesForRunner(db, sessionID, 6)
      expect(entries.map((entry) => entry.message.id)).toEqual([inherited, compact, current])
    }),
  )
  it.effect("uses the latest compaction and retains system updates in their original order for native dispatch", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const assignment = SessionMessage.ID.make("msg_fork_latest_assignment")
      const assistantMessageID = SessionMessage.ID.make("msg_fork_inflight")
      const makeData = (message: unknown) => {
        const { id: _id, type: _type, ...data } = Schema.encodeSync(SessionMessage.Message)(
          Schema.decodeUnknownSync(SessionMessage.Message)(message),
        )
        return data
      }
      const update1 = SessionMessage.ID.make("msg_fork_update_one")
      const update2 = SessionMessage.ID.make("msg_fork_update_two")
      const compact1 = SessionMessage.ID.make("msg_fork_compaction_one")
      const compact2 = SessionMessage.ID.make("msg_fork_compaction_two")
      const update3 = SessionMessage.ID.make("msg_fork_update_after_user")
      yield* db.insert(SessionInputTable).values({ id: assignment, session_id: sessionID,
        prompt: { text: "Latest assignment" }, delivery: "steer", admitted_seq: 7, promoted_seq: 8 }).run().pipe(Effect.orDie)
      yield* db.insert(SessionMessageTable).values([
        { id: update1, session_id: sessionID, seq: 2, type: "system", data: makeData({ id: update1, type: "system", text: "First update", time: { created: 2 } }) },
        { id: compact1, session_id: sessionID, seq: 4, type: "compaction", data: makeData({ id: compact1, type: "compaction", reason: "manual", summary: "First summary", recent: "", time: { created: 4 } }) },
        { id: update2, session_id: sessionID, seq: 5, type: "system", data: makeData({ id: update2, type: "system", text: "Second update", time: { created: 5 } }) },
        { id: compact2, session_id: sessionID, seq: 6, type: "compaction", data: makeData({ id: compact2, type: "compaction", reason: "manual", summary: "Latest summary", recent: "", time: { created: 6 } }) },
        { id: assignment, session_id: sessionID, seq: 8, type: "user", data: makeData({ id: assignment, type: "user", ...user, text: "Latest assignment" }) },
        { id: update3, session_id: sessionID, seq: 9, type: "system", data: makeData({ id: update3, type: "system", text: "Update after the user", time: { created: 9 } }) },
        { id: assistantMessageID, session_id: sessionID, seq: 10, type: "assistant", data: inFlightData([{ ...runningCall, name: "task" }]) },
      ]).run().pipe(Effect.orDie)
      const captured = yield* SessionFork.capture(db, { sessionID, throughSeq: 10, dispatch: { assistantMessageID, toolCallID: "call" } })
      expect(captured.entries.map((entry) => entry.message.id)).toEqual([update1, update2, compact2, assignment, update3])
    }),
  )
  for (const tail of ["assistant", "system", "compaction"] as const) {
    it.effect(`binds native fanout to durable input outside compacted history with ${tail} tail`, () =>
      Effect.gen(function* () {
        const db = yield* setup
        const dispatch = { assistantMessageID: SessionMessage.ID.make("msg_fork_inflight"), toolCallID: "call" }
        const makeData = (message: unknown) => {
          const { id: _id, type: _type, ...data } = Schema.encodeSync(SessionMessage.Message)(
            Schema.decodeUnknownSync(SessionMessage.Message)(message),
          )
          return data
        }
        yield* db.insert(SessionInputTable).values({ id: userID, session_id: sessionID,
          prompt: { text: user.text }, delivery: "steer", admitted_seq: 0, promoted_seq: 1 }).run().pipe(Effect.orDie)
        yield* db.insert(SessionMessageTable).values([
          { id: SessionMessage.ID.make("msg_compacted_assignment"), session_id: sessionID, seq: 4, type: "compaction",
            data: makeData({ id: "msg_compacted_assignment", type: "compaction", reason: "manual", summary: "Untrusted summary of the assignment", recent: "", time: { created: 4 } }) },
          ...(tail === "compaction" ? [] : [{ id: SessionMessage.ID.make("msg_after_compaction"), session_id: sessionID,
            seq: 5, type: tail, data: makeData({ id: "msg_after_compaction", type: tail,
              ...(tail === "assistant" ? assistant : { text: "Context update", time: { created: 5 } }) }) }]),
          { id: dispatch.assistantMessageID, session_id: sessionID, seq: 6, type: "assistant",
            data: inFlightData([{ ...runningCall, name: "multi_agent_fanout" }]) },
        ]).run().pipe(Effect.orDie)
        const captured = yield* SessionFork.capture(db, { sessionID, throughSeq: 10, dispatch })
        expect(captured.entries.map((entry) => entry.seq)).toEqual(tail === "compaction" ? [4] : [4, 5])
        expect(captured.dispatchInput?.message.id).toBe(userID)
        expect(captured.entries.some((entry) => entry.message.id === userID)).toBe(false)
        if (tail === "compaction") {
          yield* db.update(SessionMessageTable).set({ data: makeData({ id: "msg_compacted_assignment", type: "compaction",
            reason: "manual", summary: "", recent: "", time: { created: 4 } }) })
            .where(eq(SessionMessageTable.id, SessionMessage.ID.make("msg_compacted_assignment"))).run().pipe(Effect.orDie)
          expect(yield* reason(SessionFork.capture(db, { sessionID, throughSeq: 10, dispatch }))).toBe("boundary")
          yield* db.update(SessionMessageTable).set({ data: makeData({ id: "msg_compacted_assignment", type: "compaction",
            reason: "manual", summary: "Untrusted summary of the assignment", recent: "", time: { created: 4 } }) })
            .where(eq(SessionMessageTable.id, SessionMessage.ID.make("msg_compacted_assignment"))).run().pipe(Effect.orDie)
        }
        // Neither a summary nor an older valid input can replace the newest durable User.
        yield* db.insert(SessionMessageTable).values({ id: SessionMessage.ID.make("msg_unbound_new_user"),
          session_id: sessionID, seq: 2, type: "user", data: user }).run().pipe(Effect.orDie)
        expect(yield* reason(SessionFork.capture(db, { sessionID, throughSeq: 10, dispatch }))).toBe("boundary")
        yield* db.delete(SessionMessageTable).where(eq(SessionMessageTable.id, SessionMessage.ID.make("msg_unbound_new_user"))).run().pipe(Effect.orDie)
        yield* db.update(SessionInputTable).set({ prompt: { text: "Different input" } })
          .where(eq(SessionInputTable.id, userID)).run().pipe(Effect.orDie)
        expect(yield* reason(SessionFork.capture(db, { sessionID, throughSeq: 10, dispatch }))).toBe("boundary")
        yield* db.update(SessionInputTable).set({ prompt: { text: user.text }, promoted_seq: 2 })
          .where(eq(SessionInputTable.id, userID)).run().pipe(Effect.orDie)
        expect(yield* reason(SessionFork.capture(db, { sessionID, throughSeq: 10, dispatch }))).toBe("boundary")
      }),
    )
  }

  it.effect("captures a bound native dispatch without importing any sibling tool calls", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const assignment = SessionMessage.ID.make("msg_fork_native_assignment")
      const dispatch = { assistantMessageID: SessionMessage.ID.make("msg_fork_inflight"), toolCallID: "task-call" }
      const { id: _id, type: _type, ...assignmentData } = Schema.encodeSync(SessionMessage.Message)(
        Schema.decodeUnknownSync(SessionMessage.Message)({ id: assignment, type: "user", ...user, text: "Current assignment" }),
      )
      yield* db.insert(SessionInputTable).values({
        id: assignment, session_id: sessionID, prompt: { text: "Current assignment" },
        delivery: "steer", admitted_seq: 4, promoted_seq: 5,
      }).run().pipe(Effect.orDie)
      yield* db.insert(SessionMessageTable).values([
        { id: assignment, session_id: sessionID, type: "user", seq: 5, data: assignmentData },
        { id: dispatch.assistantMessageID, session_id: sessionID, type: "assistant", seq: 6,
          data: inFlightData([{ ...runningCall, id: "task-call", name: "task" }, { ...runningCall, id: "sibling", name: "bash" }]) },
      ]).run().pipe(Effect.orDie)
      const captured = yield* SessionFork.capture(db, { sessionID, throughSeq: 10, dispatch })
      expect(captured.entries.map((entry) => entry.message.id)).toEqual([userID, assistantID, assignment])
      expect(captured.actualAgent).toBe("build")
      const update = SessionMessage.ID.make("msg_fork_update")
      const compact = SessionMessage.ID.make("msg_fork_compaction")
      const { id: _updateID, type: _updateType, ...updateData } = Schema.encodeSync(SessionMessage.Message)(
        Schema.decodeUnknownSync(SessionMessage.Message)({ id: update, type: "system", text: "Chronological update", time: { created: 2 } }),
      )
      const { id: _compactID, type: _compactType, ...compactData } = Schema.encodeSync(SessionMessage.Message)(
        Schema.decodeUnknownSync(SessionMessage.Message)({ id: compact, type: "compaction", reason: "manual", summary: "Current summary", recent: "", time: { created: 4 } }),
      )
      yield* db.insert(SessionMessageTable).values([
        { id: update, session_id: sessionID, seq: 2, type: "system", data: updateData },
        { id: compact, session_id: sessionID, seq: 4, type: "compaction", data: compactData },
      ]).run().pipe(Effect.orDie)
      expect((yield* SessionFork.capture(db, { sessionID, throughSeq: 10, dispatch })).entries.map((entry) => entry.message.id))
        .toEqual([update, compact, assignment])
      yield* db.delete(SessionMessageTable).where(eq(SessionMessageTable.id, update)).run().pipe(Effect.orDie)
      yield* db.delete(SessionMessageTable).where(eq(SessionMessageTable.id, compact)).run().pipe(Effect.orDie)
      yield* db.update(SessionMessageTable).set({ data: inFlightData([
        { ...runningCall, id: "task-call", name: "multi_agent_fanout" },
        { ...runningCall, id: "sibling", name: "bash" },
      ]) }).where(eq(SessionMessageTable.id, dispatch.assistantMessageID)).run().pipe(Effect.orDie)
      expect((yield* SessionFork.capture(db, { sessionID, throughSeq: 10, dispatch })).entries.map((entry) => entry.message.id))
        .toEqual([userID, assistantID, assignment])
      expect(yield* reason(SessionFork.capture(db, { sessionID, throughSeq: 10, dispatch: { ...dispatch, toolCallID: "sibling" } }))).toBe("boundary")
      expect(yield* reason(SessionFork.capture(db, { sessionID, throughSeq: 10, dispatch: { ...dispatch, toolCallID: "missing" } }))).toBe("boundary")
      expect(yield* reason(SessionFork.capture(db, { sessionID, throughSeq: 9, dispatch }))).toBe("boundary")
      for (const content of [
        [{ ...runningCall, id: "task-call", name: "task", state: { status: "pending", input: "{}" } }],
        [{ ...runningCall, id: "task-call", name: "task" }, { ...runningCall, id: "task-call", name: "task" }],
        [{ ...runningCall, id: "task-call", name: "task" }, { type: "custom", id: "custom", kind: "control", data: {} }],
      ]) {
        yield* db.update(SessionMessageTable).set({ data: inFlightData(content) }).where(eq(SessionMessageTable.id, dispatch.assistantMessageID)).run().pipe(Effect.orDie)
        expect(yield* reason(SessionFork.capture(db, { sessionID, throughSeq: 10, dispatch }))).toBe("boundary")
      }
      yield* db.update(SessionMessageTable).set({ data: inFlightData([{ ...runningCall, id: "task-call", name: "task" }], "tool-calls") })
        .where(eq(SessionMessageTable.id, dispatch.assistantMessageID)).run().pipe(Effect.orDie)
      expect(yield* reason(SessionFork.capture(db, { sessionID, throughSeq: 10, dispatch }))).toBe("boundary")
      yield* db.update(SessionMessageTable).set({ data: inFlightData([{ ...runningCall, id: "task-call", name: "task" }]) })
        .where(eq(SessionMessageTable.id, dispatch.assistantMessageID)).run().pipe(Effect.orDie)
      yield* db.delete(SessionInputTable).where(eq(SessionInputTable.id, assignment)).run().pipe(Effect.orDie)
      expect(yield* reason(SessionFork.capture(db, { sessionID, throughSeq: 10, dispatch }))).toBe("boundary")
    }),
  )
  for (const [name, content] of [
    ["empty", []],
    ["text instead of a call", [{ type: "text", id: "text", text: "Starting" }]],
    ["mixed with custom authority", [{ type: "custom", id: "custom", kind: "control", data: {} }, runningCall]],
    ["mixed with another call", [runningCall, { ...runningCall, id: "other", name: "bash" }]],
  ] as const) {
    it.effect(`does not omit an in-flight assistant with ${name} content`, () =>
      Effect.gen(function* () {
        const db = yield* setup
        yield* db
          .insert(SessionMessageTable)
          .values({
            id: SessionMessage.ID.make("msg_fork_inflight"),
            session_id: sessionID,
            type: "assistant",
            seq: 4,
            data: inFlightData(content),
          })
          .run()
          .pipe(Effect.orDie)
        expect(yield* reason(SessionFork.capture(db, { sessionID, throughSeq: 10 }))).toBe("boundary")
      }),
    )
  }

  it.effect("never omits a retired engine call from a completed provider-turn basis", () =>
    Effect.gen(function* () {
      const db = yield* setup
      yield* db
        .insert(SessionMessageTable)
        .values({
          id: SessionMessage.ID.make("msg_fork_inflight"),
          session_id: sessionID,
          type: "assistant",
          seq: 4,
          data: inFlightData([
            {
              type: "reasoning",
              id: "reasoning",
              text: "",
              providerMetadata: { openai: { encryptedContent: "fixture" } },
            },
            { type: "text", id: "text", text: "Starting" },
            runningCall,
          ]),
        })
        .run()
        .pipe(Effect.orDie)
      expect(yield* reason(SessionFork.capture(db, { sessionID, throughSeq: 10 }))).toBe("boundary")
    }),
  )

  it.effect("does not omit an unfinished call with a prematurely recorded finish reason", () =>
    Effect.gen(function* () {
      const db = yield* setup
      yield* db
        .insert(SessionMessageTable)
        .values({
          id: SessionMessage.ID.make("msg_fork_inflight"),
          session_id: sessionID,
          type: "assistant",
          seq: 4,
          data: inFlightData([runningCall], "tool-calls"),
        })
        .run()
        .pipe(Effect.orDie)
      expect(yield* reason(SessionFork.capture(db, { sessionID, throughSeq: 10 }))).toBe("boundary")
    }),
  )

  it.effect("retains a bound native assignment and resolves the actual dispatch model", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const assignment = SessionMessage.ID.make("msg_fork_assignment")
      yield* db
        .insert(SessionInputTable)
        .values({
          id: assignment,
          session_id: sessionID,
          prompt: { text: "New assignment" },
          delivery: "steer",
          admitted_seq: 4,
          promoted_seq: 5,
        })
        .run()
        .pipe(Effect.orDie)
      const {
        id: _id,
        type: _type,
        ...assignmentData
      } = Schema.encodeSync(SessionMessage.Message)(
        Schema.decodeUnknownSync(SessionMessage.Message)({
          id: assignment,
          type: "user",
          ...user,
          text: "New assignment",
        }),
      )
      yield* db
        .insert(SessionMessageTable)
        .values([
          { id: assignment, session_id: sessionID, type: "user", seq: 5, data: assignmentData },
          {
            id: SessionMessage.ID.make("msg_fork_inflight"),
            session_id: sessionID,
            type: "assistant",
            seq: 6,
            data: inFlightData([{ ...runningCall, name: "task" }]),
          },
        ])
        .run()
        .pipe(Effect.orDie)
      expect(yield* reason(SessionFork.capture(db, { sessionID, throughSeq: 10 }))).toBe("boundary")
      const dispatch = {
        assistantMessageID: SessionMessage.ID.make("msg_fork_inflight"),
        toolCallID: "call",
      }
      expect(
        (yield* SessionFork.capture(db, { sessionID, throughSeq: 10, dispatch })).entries.map(
          (entry) => entry.message.id,
        ),
      ).toEqual([userID, assistantID, assignment])
      expect(
        yield* reason(
          SessionFork.capture(db, {
            sessionID,
            throughSeq: 10,
            dispatch: { ...dispatch, toolCallID: "missing" },
          }),
        ),
      ).toBe("boundary")
      const {
        id: _previousID,
        type: _previousType,
        ...previousData
      } = Schema.encodeSync(SessionMessage.Message)(
        Schema.decodeUnknownSync(SessionMessage.Message)({
          id: assistantID,
          type: "assistant",
          ...assistant,
          model: { ...model, id: "previous-model" },
        }),
      )
      yield* db
        .update(SessionMessageTable)
        .set({ data: previousData })
        .where(eq(SessionMessageTable.id, assistantID))
        .run()
        .pipe(Effect.orDie)
      const switched = yield* SessionFork.capture(db, { sessionID, throughSeq: 10, dispatch })
      expect(switched.actualModel).toMatchObject(model)
      expect(switched.entries.find((entry) => entry.message.id === assistantID)?.message).toMatchObject({ type: "assistant", model: { id: "previous-model" } })
    }),
  )

  for (const predecessor of ["user", "failed assistant"] as const) {
    projected.effect(`checks the ${predecessor} before projected model switches at native dispatch`, () =>
      Effect.gen(function* () {
        const db = yield* setup
        const events = yield* EventV2.Service
        const assignmentID = SessionMessage.ID.create()
        const text = "New interactive assignment"
        yield* SessionInput.admit(db, events, {
          id: assignmentID, sessionID, prompt: new Prompt({ text }), delivery: "steer", origin: "interactive",
        })
        expect(yield* SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER)).toBe(1)
        const timestamp = DateTime.makeUnsafe(20)
        const original = { id: ModelV2.ID.make(model.id), providerID: ProviderV2.ID.make(model.providerID) }
        if (predecessor === "failed assistant") {
          const failed = { sessionID, assistantMessageID: SessionMessage.ID.create(), timestamp }
          yield* events.publish(SessionEvent.Step.Started, { ...failed, agent: "build", model: original })
          yield* events.publish(SessionEvent.Step.Failed, { ...failed, error: { type: "unknown", message: "Provider failed" } })
        }
        const markers = [SessionMessage.ID.create(), SessionMessage.ID.create()]
        const fallback = { ...original, id: ModelV2.ID.make("fallback") }
        yield* events.publish(SessionEvent.ModelSwitched, { sessionID, messageID: markers[0], timestamp, model: original })
        yield* events.publish(SessionEvent.ModelSwitched, { sessionID, messageID: markers[1], timestamp, model: fallback })
        // The runner prepares the replacement epoch before starting the next step.
        yield* SessionContextEpoch.prepare(db, events, Effect.succeed(SystemContext.make({
          key: SystemContext.Key.make("test/fallback"), codec: Schema.toCodecJson(Schema.String),
          load: Effect.succeed("Fallback model instructions"), baseline: String, update: (_previous, current) => current,
        })), sessionID, Location.Ref.make({ directory: AbsolutePath.make("/fork") }), AgentV2.ID.make("build"))
        const dispatch = { assistantMessageID: SessionMessage.ID.create(), toolCallID: "dispatch" }
        const step = { sessionID, assistantMessageID: dispatch.assistantMessageID, timestamp }
        const call = { ...step, callID: dispatch.toolCallID }
        yield* events.publish(SessionEvent.Step.Started, { ...step, agent: "build", model: fallback })
        yield* events.publish(SessionEvent.Tool.Input.Started, { ...call, name: "task" })
        yield* events.publish(SessionEvent.Tool.Input.Ended, { ...call, text: "{}" })
        yield* events.publish(SessionEvent.Tool.Called, { ...call, tool: "task", input: {}, provider: { executed: false } })

        const throughSeq = yield* SessionInput.latestSeq(db, sessionID)
        const capture = SessionFork.capture(db, { sessionID, throughSeq, dispatch })
        if (predecessor === "failed assistant") {
          expect(yield* reason(capture)).toBe("boundary")
          return
        }
        const result = yield* capture
        expect(result.dispatchInput?.message).toMatchObject({ id: assignmentID, type: "user", text })
        expect(result.actualModel).toEqual(fallback)
        expect(result.entries.map((entry) => entry.message.id)).toEqual([userID, assistantID, assignmentID, ...markers])
      }),
    )
  }

  for (const withSystem of [false, true]) {
    it.effect(`captures first-turn native dispatch with system context ${withSystem} and its assignment`, () =>
      Effect.gen(function* () {
        const db = yield* setup
        yield* db
          .delete(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, sessionID))
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(SessionInputTable)
          .values({
            id: userID,
            session_id: sessionID,
            prompt: { text: "Do the work" },
            delivery: "steer",
            admitted_seq: 0,
            promoted_seq: 1,
          })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(SessionMessageTable)
          .values([
            { id: userID, session_id: sessionID, type: "user", seq: 1, data: user },
            {
              id: SessionMessage.ID.make("msg_fork_inflight"),
              session_id: sessionID,
              type: "assistant",
              seq: 2,
              data: inFlightData([{ ...runningCall, name: "task" }]),
            },
          ])
          .run()
          .pipe(Effect.orDie)
        if (withSystem) {
          yield* db.update(SessionContextEpochTable).set({ baseline_seq: -1 }).run().pipe(Effect.orDie)
          yield* db
            .insert(SessionMessageTable)
            .values({
              id: SessionMessage.ID.make("msg_fork_system"),
              session_id: sessionID,
              type: "system",
              seq: 0,
              data: Schema.encodeSync(SessionMessage.System)(
                Schema.decodeUnknownSync(SessionMessage.System)({
                  id: "msg_fork_system",
                  type: "system",
                  text: "Host-resolved manual skill context",
                  time: { created: 0 },
                }),
              ),
            })
            .run()
            .pipe(Effect.orDie)
        }
        const dispatch = {
          assistantMessageID: SessionMessage.ID.make("msg_fork_inflight"),
          toolCallID: "call",
        }
        const captured = yield* SessionFork.capture(db, { sessionID, throughSeq: 10, dispatch })
        expect(captured.entries.map((entry) => entry.message.id)).toEqual(
          withSystem ? [SessionMessage.ID.make("msg_fork_system"), userID] : [userID],
        )
        expect(captured.dispatchInput?.message.id).toBe(userID)
        expect(captured.actualModel).toMatchObject(model)
        expect(captured.actualAgent).toBe("build")
        expect(yield* reason(SessionFork.capture(db, { sessionID, throughSeq: 10 }))).toBe("boundary")
        if (withSystem) {
          // Context does not replace the bound current assignment.
          yield* db.update(SessionInputTable).set({ prompt: { text: "Changed assignment" } })
            .where(eq(SessionInputTable.id, userID))
            .run().pipe(Effect.orDie)
          expect(yield* reason(SessionFork.capture(db, { sessionID, throughSeq: 10, dispatch }))).toBe("boundary")
        }
      }),
    )
  }

  for (const finish of ["length", "unknown", "error", "content-filter"]) {
    it.effect(`rejects incomplete or failed last finish ${finish}`, () =>
      Effect.gen(function* () {
        const db = yield* setup
        const data = { ...assistant, finish }
        yield* db
          .update(SessionMessageTable)
          .set({ data })
          .where(eq(SessionMessageTable.id, assistantID))
          .run()
          .pipe(Effect.orDie)
        expect(yield* reason(SessionFork.capture(db, { sessionID, throughSeq: 10 }))).toBe("boundary")
      }),
    )
  }
})
