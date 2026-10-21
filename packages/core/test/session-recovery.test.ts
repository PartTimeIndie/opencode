import { describe, expect } from "bun:test"
import { Cause, Clock, Context, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import * as TestConsole from "effect/testing/TestConsole"
import * as TestClock from "effect/testing/TestClock"
import { desc, eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { InvalidRequestReason, LLMError } from "@opencode-ai/llm"
import { QuestionV2 } from "@opencode-ai/core/question"
import { QuestionTable } from "@opencode-ai/core/question/sql"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { ContentStore } from "@opencode-ai/core/content-store"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionActivity } from "@opencode-ai/core/session/activity"
import { SessionRecovery } from "@opencode-ai/core/session/recovery"
import { SessionExecutionLocal } from "@opencode-ai/core/session/execution/local"
import { SessionInputTable, SessionActivityTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import { Identifier } from "@opencode-ai/core/util/identifier"
import { BackgroundJobTable } from "@opencode-ai/core/background-job.sql"
import { Integration } from "@opencode-ai/core/integration"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
const store = SessionStore.layer.pipe(Layer.provide(database))
const activityLayer = SessionActivity.layer.pipe(Layer.provide(events), Layer.provide(database))

const wakeCalls: Array<{ sessionID: string; seq?: number }> = []
const resumeCalls: string[] = []
let wakeDefect: Error | undefined
let resumeDefect: Error | undefined
const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    resumeOrJoin: () => Effect.void,
    resume: (sessionID) =>
      Effect.gen(function* () {
        resumeCalls.push(sessionID)
        if (resumeDefect) yield* Effect.die(resumeDefect)
      }),
    queueContinuation: () => Effect.void,
    interrupt: () => Effect.void,
    interruptActivity: () => Effect.succeed(false),
    cancelTool: () => Effect.succeed(false),
    wait: () => Effect.void,
    wake: (sessionID, seq) =>
      Effect.gen(function* () {
        wakeCalls.push({ sessionID, seq })
        if (wakeDefect) yield* Effect.die(wakeDefect)
      }),
  }),
)

const sessions = SessionV2.layer.pipe(
  Layer.provide(ContentStore.defaultLayer),
  Layer.provide(events),
  Layer.provide(database),
  Layer.provide(store),
  Layer.provide(Project.defaultLayer),
  Layer.provide(execution),
)
const recovery = SessionRecovery.layer.pipe(
  Layer.provide(store),
  Layer.provide(execution),
  Layer.provide(activityLayer),
  Layer.provide(database),
)

const it = testEffect(Layer.mergeAll(database, events, projector, store, activityLayer, execution, sessions, recovery))
const sessionID = SessionV2.ID.make("ses_recovery_test")

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "recovery-test",
      directory: "/project",
      title: "Recovery Test",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

describe("SessionRecovery", () => {
  it.effect("defers desktop recovery until after the server handshake", () =>
    Effect.sync(() => {
      expect(SessionExecutionLocal.startupRecoveryDelayMs({})).toBe(5_000)
      expect(SessionExecutionLocal.startupRecoveryDelayMs({ OPENCODE_DEFER_BACKGROUND_STARTUP: "1" })).toBe(
        SessionExecutionLocal.DESKTOP_STARTUP_RECOVERY_DELAY_MS,
      )
    }),
  )

  it.effect("defers an explicit resume while a durable blocking question is pending", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const questionID = QuestionV2.ID.make("que_resume_guard")
      yield* db
        .insert(QuestionTable)
        .values({
          id: questionID,
          session_id: sessionID,
          seq: 1,
          state: "active",
          mode: "blocking",
          detached: false,
          request: {
            id: questionID,
            sessionID,
            mode: "blocking",
            revision: 1,
            actions: [],
            questions: [{ question: "Continue?", options: [{ label: "Yes", description: "Continue" }] }],
          },
        })
        .run()
        .pipe(Effect.orDie)

      expect(yield* SessionExecutionLocal.hasPendingBlockingQuestion(db, sessionID)).toBeTrue()
      yield* db
        .update(QuestionTable)
        .set({ state: "replied" })
        .where(eq(QuestionTable.id, questionID))
        .run()
        .pipe(Effect.orDie)
      expect(yield* SessionExecutionLocal.hasPendingBlockingQuestion(db, sessionID)).toBeFalse()
    }),
  )

  it.effect("startup recovery leaves pending inputs for explicit continuation", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service

      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Fix the bug" }),
        resume: false,
      })

      const { db } = yield* Database.Service
      const pending = yield* db
        .select()
        .from(SessionInputTable)
        .where(eq(SessionInputTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      expect(pending?.promoted_seq).toBeNull()

      // A restart must not replay an admitted provider turn automatically. The
      // user can explicitly resume the session, while the durable inbox stays
      // available for that continuation.
      wakeCalls.length = 0
      const recovery = yield* SessionRecovery.Service
      yield* recovery.startup()

      expect(wakeCalls).toHaveLength(0)
      const stillPending = yield* db
        .select()
        .from(SessionInputTable)
        .where(eq(SessionInputTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      expect(stillPending?.promoted_seq).toBeNull()
    }),
  )

  it.effect("startup completes without replaying pending inputs", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service

      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Fix the bug" }),
        resume: false,
      })

      wakeCalls.length = 0
      const recovery = yield* SessionRecovery.Service
      yield* recovery.startup()

      expect(wakeCalls).toHaveLength(0)
      expect(yield* TestConsole.logLines).toContain("SessionRecovery: startup scan complete")
    }),
  )

  it.effect("local startup recovery leaves pending inputs untouched", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service

      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Fix the bug" }),
        resume: false,
      })

      wakeCalls.length = 0
      const activity = yield* SessionActivity.Service
      const exec = yield* SessionExecution.Service
      const { db } = yield* Database.Service
      yield* SessionExecutionLocal.runStartupRecovery(activity, db)

      expect(wakeCalls).toHaveLength(0)
      expect(yield* TestConsole.logLines).toContain("SessionRecovery: startup scan complete")
    }),
  )

  it.effect("local startup recovery interrupts claimed stale activity without replay", () =>
    Effect.gen(function* () {
      yield* setup
      const activity = yield* SessionActivity.Service
      const exec = yield* SessionExecution.Service
      const { db } = yield* Database.Service
      const activityID = Identifier.ascending()
      yield* db
        .insert(SessionActivityTable)
        .values({
          id: activityID,
          session_id: sessionID,
          status: "running",
          kind: "prompt",
          owner_id: "old_owner",
          opened_seq: -2,
          lease_until: -1,
          heartbeat_at: -1,
          time_created: -1,
          time_updated: -1,
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(EventSequenceTable)
        .values({ aggregate_id: sessionID, seq: 1 })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(EventTable)
        .values({
          id: EventV2.ID.make("evt_safe_recovery_input_started"),
          aggregate_id: sessionID,
          seq: 1,
          type: EventV2.versionedType(SessionEvent.Tool.Input.Started.type, 1),
          data: { callID: "call_safe_recovery" },
        })
        .run()
        .pipe(Effect.orDie)

      resumeCalls.length = 0
      yield* SessionExecutionLocal.runStartupRecovery(activity, db)

      expect(resumeCalls).toEqual([])
      const recovered = yield* activity.get(activityID)
      expect(recovered?.status).toBe("interrupted")
      expect(recovered?.reason).toBe("stale-lease")
      expect(recovered?.recoveryAttempts).toBe(0)
      expect(recovered?.closedSeq).toBeDefined()
    }),
  )

  it.effect("local startup recovery preserves an expired running activity with a durable blocking question", () =>
    Effect.gen(function* () {
      yield* setup
      const activity = yield* SessionActivity.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const lifecycle: string[] = []
      yield* events.listen((event) => Effect.sync(() => lifecycle.push(event.type)))
      const activityID = Identifier.ascending()
      const currentActivityID = Identifier.ascending()
      const questionID = QuestionV2.ID.make("que_expired_running_activity")
      const nextQuestionID = QuestionV2.ID.make("que_after_expired_running_activity")
      yield* db
        .insert(SessionActivityTable)
        .values([
          {
            id: activityID,
            session_id: sessionID,
            status: "running",
            kind: "prompt",
            owner_id: "expired_owner",
            lease_until: -1,
            heartbeat_at: -SessionActivity.LEASE_DURATION_MS - 1,
            time_created: -1,
            time_updated: -1,
          },
          {
            id: currentActivityID,
            session_id: sessionID,
            status: "running",
            kind: "prompt",
            owner_id: "current_owner",
            lease_until: SessionActivity.LEASE_DURATION_MS,
            heartbeat_at: 0,
            time_created: 0,
            time_updated: 0,
          },
        ])
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(QuestionTable)
        .values([
          {
            id: questionID,
            session_id: sessionID,
            seq: 1,
            state: "active",
            mode: "blocking",
            activity_id: activityID,
            request: {
              id: questionID,
              sessionID,
              mode: "blocking",
              revision: 1,
              actions: [],
              questions: [{ question: "Continue?", options: [{ label: "Yes", description: "Continue" }] }],
            },
          },
          {
            id: nextQuestionID,
            session_id: sessionID,
            seq: 2,
            state: "queued",
            mode: "blocking",
            activity_id: currentActivityID,
            request: {
              id: nextQuestionID,
              sessionID,
              mode: "blocking",
              revision: 1,
              actions: [],
              questions: [{ question: "Next?", options: [{ label: "Yes", description: "Continue" }] }],
            },
          },
        ])
        .run()
        .pipe(Effect.orDie)

      yield* SessionExecutionLocal.runStartupRecovery(activity, db)
      yield* SessionExecutionLocal.runStartupRecovery(activity, db)

      expect(yield* activity.get(activityID)).toMatchObject({ status: "running" })
      expect(
        yield* db.select().from(QuestionTable).where(eq(QuestionTable.id, questionID)).get().pipe(Effect.orDie),
      ).toMatchObject({
        state: "active",
        time_settled: null,
      })
      expect(
        yield* db.select().from(QuestionTable).where(eq(QuestionTable.id, nextQuestionID)).get().pipe(Effect.orDie),
      ).toMatchObject({ state: "queued" })
      expect(lifecycle.filter((type) => type === QuestionV2.Event.Dismissed.type)).toHaveLength(0)
      expect(lifecycle.filter((type) => type === QuestionV2.Event.Requested.type)).toHaveLength(0)
    }),
  )

  it.effect("stale activity preservation does not invoke orphan reconciliation", () =>
    Effect.gen(function* () {
      yield* setup
      const activity = yield* SessionActivity.Service
      const { db } = yield* Database.Service
      const activityID = Identifier.ascending()
      const questionID = QuestionV2.ID.make("que_stale_reconciliation_rollback")
      yield* db
        .insert(SessionActivityTable)
        .values({
          id: activityID,
          session_id: sessionID,
          status: "running",
          kind: "prompt",
          owner_id: "expired_owner",
          lease_until: -1,
          heartbeat_at: -SessionActivity.LEASE_DURATION_MS - 1,
          time_created: -1,
          time_updated: -1,
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(QuestionTable)
        .values({
          id: questionID,
          session_id: sessionID,
          seq: 1,
          state: "active",
          mode: "blocking",
          activity_id: activityID,
          request: {
            id: questionID,
            sessionID,
            mode: "blocking",
            revision: 1,
            actions: [],
            questions: [{ question: "Continue?", options: [{ label: "Yes", description: "Continue" }] }],
          },
        })
        .run()
        .pipe(Effect.orDie)
      yield* db.run(`CREATE TEMP TRIGGER fail_stale_question_reconciliation
        BEFORE UPDATE OF state ON session_question
        WHEN NEW.state = 'orphaned'
        BEGIN
          SELECT RAISE(ABORT, 'forced stale question reconciliation failure');
        END`)

      expect(Exit.isSuccess(yield* Effect.exit(activity.interruptStale(activityID, 1)))).toBeTrue()
      yield* db.run("DROP TRIGGER fail_stale_question_reconciliation")

      const preserved = yield* activity.get(activityID)
      expect(preserved).toMatchObject({ status: "running" })
      expect(preserved?.closedSeq).toBeUndefined()
      expect(
        yield* db.select().from(QuestionTable).where(eq(QuestionTable.id, questionID)).get().pipe(Effect.orDie),
      ).toMatchObject({
        state: "active",
        time_settled: null,
      })
    }),
  )

  it.effect("local startup recovery preserves an exhausted controlled wait idempotently", () =>
    Effect.gen(function* () {
      yield* setup
      const activity = yield* SessionActivity.Service
      const exec = yield* SessionExecution.Service
      const { db } = yield* Database.Service
      const activityID = Identifier.ascending()
      const questionID = QuestionV2.ID.make("que_exhausted_recovery_activity")
      yield* db
        .insert(SessionActivityTable)
        .values({
          id: activityID,
          session_id: sessionID,
          status: "recovering",
          kind: "recovery",
          reason: SessionActivity.interruptReason("owner-shutdown"),
          owner_id: "exhausted_owner",
          recovery_attempts: SessionActivity.MAX_CONTROLLED_RECOVERY_ATTEMPTS,
          lease_until: -1,
          heartbeat_at: -SessionActivity.LEASE_DURATION_MS - 1,
          time_created: -1,
          time_updated: -1,
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(QuestionTable)
        .values({
          id: questionID,
          session_id: sessionID,
          seq: 1,
          state: "active",
          mode: "blocking",
          activity_id: activityID,
          request: {
            id: questionID,
            sessionID,
            mode: "blocking",
            revision: 1,
            actions: [],
            questions: [{ question: "Continue?", options: [{ label: "Yes", description: "Continue" }] }],
          },
        })
        .run()
        .pipe(Effect.orDie)

      resumeCalls.length = 0
      yield* SessionExecutionLocal.runStartupRecovery(activity, db, () => new Set(), exec.resume)
      const terminal = yield* activity.get(activityID)
      yield* SessionExecutionLocal.runStartupRecovery(activity, db, () => new Set(), exec.resume)

      expect(terminal).toMatchObject({
        status: "recovering",
        reason: "owner-shutdown",
        recoveryAttempts: SessionActivity.MAX_CONTROLLED_RECOVERY_ATTEMPTS,
      })
      expect(yield* activity.get(activityID)).toEqual(terminal)
      expect(
        yield* db.select().from(QuestionTable).where(eq(QuestionTable.id, questionID)).get().pipe(Effect.orDie),
      ).toMatchObject({
        state: "active",
        time_settled: null,
      })
      expect(resumeCalls).toEqual([])
    }),
  )

  it.effect("local startup recovery protects a currently leased activity", () =>
    Effect.gen(function* () {
      yield* setup
      const activity = yield* SessionActivity.Service
      const { db } = yield* Database.Service
      const activityID = Identifier.ascending()
      yield* db
        .insert(SessionActivityTable)
        .values({
          id: activityID,
          session_id: sessionID,
          status: "running",
          kind: "prompt",
          owner_id: "current_owner",
          lease_until: SessionActivity.LEASE_DURATION_MS,
          heartbeat_at: 0,
          time_created: 0,
          time_updated: 0,
        })
        .run()
        .pipe(Effect.orDie)

      yield* SessionExecutionLocal.runStartupRecovery(activity, db)

      expect(yield* activity.get(activityID)).toMatchObject({
        status: "running",
        ownerID: "current_owner",
        leaseUntil: SessionActivity.LEASE_DURATION_MS,
      })
    }),
  )

  it.effect("local startup recovery resumes a controlled owner shutdown exactly once", () =>
    Effect.gen(function* () {
      yield* setup
      const activity = yield* SessionActivity.Service
      const exec = yield* SessionExecution.Service
      const { db } = yield* Database.Service
      const info = yield* activity.open({
        sessionID,
        kind: "prompt",
        ownerID: "controlled_owner",
        openedSeq: 1,
      })
      yield* activity.prepareOwnerShutdown("controlled_owner", SessionActivity.interruptReason("owner-shutdown"))

      resumeCalls.length = 0
      yield* SessionExecutionLocal.runStartupRecovery(activity, db, () => new Set(), exec.resume)

      expect(resumeCalls).toEqual([sessionID])
      expect(yield* activity.get(info.id)).toMatchObject({
        status: "interrupted",
        reason: "owner-shutdown",
      })

      yield* SessionExecutionLocal.runStartupRecovery(activity, db, () => new Set(), exec.resume)
      expect(resumeCalls).toEqual([sessionID])
    }),
  )

  it.effect("local startup recovery isolates controlled resume defects between sessions", () =>
    Effect.gen(function* () {
      yield* setup
      const activity = yield* SessionActivity.Service
      const exec = yield* SessionExecution.Service
      const { db } = yield* Database.Service
      const secondSessionID = SessionV2.ID.make("ses_recovery_second")
      yield* db
        .insert(SessionTable)
        .values({
          id: secondSessionID,
          project_id: Project.ID.global,
          slug: "recovery-second",
          directory: "/project",
          title: "Recovery Second",
          version: "test",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionActivityTable)
        .values(
          [sessionID, secondSessionID].map((id) => ({
            id: Identifier.ascending(),
            session_id: id,
            status: "running" as const,
            kind: "prompt" as const,
            reason: SessionActivity.interruptReason("owner-shutdown"),
            owner_id: `owner_${id}`,
            opened_seq: 1,
            lease_until: -1,
            heartbeat_at: -1,
            time_created: -1,
            time_updated: -1,
          })),
        )
        .run()
        .pipe(Effect.orDie)

      resumeCalls.length = 0
      resumeDefect = new Error("resume failed")
      yield* SessionExecutionLocal.runStartupRecovery(activity, db, () => new Set(), exec.resume).pipe(
        Effect.ensuring(Effect.sync(() => (resumeDefect = undefined))),
      )

      expect(resumeCalls.sort()).toEqual([sessionID, secondSessionID].sort())
      const terminal = yield* db
        .select()
        .from(SessionActivityTable)
        .where(eq(SessionActivityTable.reason, SessionActivity.interruptReason("owner-shutdown")))
        .all()
        .pipe(Effect.orDie)
      expect(terminal).toHaveLength(2)
      expect(terminal.every((row) => row.status === "interrupted")).toBeTrue()
    }),
  )

  it.effect("local startup recovery terminalizes only expired background tasks without replay", () =>
    Effect.gen(function* () {
      yield* setup
      const activity = yield* SessionActivity.Service
      const exec = yield* SessionExecution.Service
      const { db } = yield* Database.Service
      const staleID = SessionV2.ID.make("ses_stale_background_task")
      const liveID = SessionV2.ID.make("ses_live_background_task")
      yield* db
        .insert(BackgroundJobTable)
        .values(
          [staleID, liveID].map((id) => ({
            id,
            type: "task",
            status: "running",
            parent_session_id: sessionID,
            child_session_id: id,
            parent_message_id: `msg_${id}`,
            parent_call_id: `call_${id}`,
            title: `Task ${id}`,
            metadata: { background: true, rootSessionID: sessionID },
            owner_id: `owner_${id}`,
            lease_until: id === staleID ? -1 : SessionActivity.LEASE_DURATION_MS,
            heartbeat_at: 0,
            delivery_status: "pending",
            time_created: 0,
            time_updated: 0,
          })),
        )
        .run()
        .pipe(Effect.orDie)

      resumeCalls.length = 0
      yield* SessionExecutionLocal.runStartupRecovery(activity, db)

      const stale = yield* db
        .select()
        .from(BackgroundJobTable)
        .where(eq(BackgroundJobTable.id, staleID))
        .get()
        .pipe(Effect.orDie)
      const live = yield* db
        .select()
        .from(BackgroundJobTable)
        .where(eq(BackgroundJobTable.id, liveID))
        .get()
        .pipe(Effect.orDie)
      expect(resumeCalls).toEqual([])
      expect(stale).toMatchObject({
        status: "error",
        delivery_status: "available",
        lease_until: null,
      })
      // E4 contract: stale rows settle as typed lease-expiration failures, resumable from the checkpoint.
      expect(stale?.error).toContain("lease expired")
      expect(stale?.time_completed).toBeDefined()
      expect(live?.status).toBe("running")
    }),
  )

  it.effect("local startup recovery never retries stale provider work", () =>
    Effect.gen(function* () {
      yield* setup
      const activity = yield* SessionActivity.Service
      const exec = yield* SessionExecution.Service
      const { db } = yield* Database.Service
      const activityID = Identifier.ascending()
      yield* db
        .insert(SessionActivityTable)
        .values({
          id: activityID,
          session_id: sessionID,
          status: "recovering",
          kind: "prompt",
          owner_id: "old_owner",
          opened_seq: -2,
          lease_until: -1,
          heartbeat_at: -1,
          time_created: -1,
          time_updated: -1,
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(EventSequenceTable)
        .values({ aggregate_id: sessionID, seq: 1 })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(EventTable)
        .values({
          id: EventV2.ID.make("evt_unsafe_recovery_called"),
          aggregate_id: sessionID,
          seq: 1,
          type: EventV2.versionedType(SessionEvent.Tool.Called.type, 1),
          data: { callID: "call_unsafe_recovery" },
        })
        .run()
        .pipe(Effect.orDie)

      resumeCalls.length = 0

      yield* SessionExecutionLocal.runStartupRecovery(activity, db)

      const recovered = yield* activity.get(activityID)
      expect(resumeCalls).toEqual([])
      expect(recovered?.status).toBe("interrupted")
      expect(recovered?.recoveryAttempts).toBe(0)
      expect(recovered?.lastError).toBeUndefined()
      expect(recovered?.closedSeq).toBeDefined()
    }),
  )

  it.effect("service startup recovery interrupts claimed stale activity without replay", () =>
    Effect.gen(function* () {
      yield* setup
      const activity = yield* SessionActivity.Service
      const { db } = yield* Database.Service
      const activityID = Identifier.ascending()
      yield* db
        .insert(SessionActivityTable)
        .values({
          id: activityID,
          session_id: sessionID,
          status: "running",
          kind: "prompt",
          owner_id: "old_owner",
          opened_seq: -2,
          lease_until: -1,
          heartbeat_at: -1,
          time_created: -1,
          time_updated: -1,
        })
        .run()
        .pipe(Effect.orDie)

      resumeCalls.length = 0
      yield* SessionRecovery.Service.pipe(Effect.flatMap((recovery) => recovery.startup()))

      expect(resumeCalls).toEqual([])
      const recovered = yield* activity.get(activityID)
      expect(recovered?.status).toBe("interrupted")
      expect(recovered?.closedSeq).toBeDefined()
    }),
  )

  it.effect("local recovery watchdog closes an expired orphan but excludes the current active activity", () =>
    Effect.gen(function* () {
      yield* setup
      const activity = yield* SessionActivity.Service
      const exec = yield* SessionExecution.Service
      const { db } = yield* Database.Service
      const orphanID = Identifier.ascending()
      const activeID = Identifier.ascending()
      yield* db
        .insert(SessionActivityTable)
        .values(
          [orphanID, activeID].map((id) => ({
            id,
            session_id: sessionID,
            status: "running",
            kind: "prompt",
            owner_id: "old_owner",
            opened_seq: -2,
            lease_until: SessionActivity.LEASE_DURATION_MS,
            heartbeat_at: 0,
            time_created: 0,
            time_updated: 0,
          })),
        )
        .run()
        .pipe(Effect.orDie)

      yield* SessionExecutionLocal.runStartupRecovery(activity, db, () => new Set([activeID]))
      expect((yield* activity.get(orphanID))?.status).toBe("running")

      yield* TestClock.adjust(SessionActivity.LEASE_DURATION_MS + 1_001)
      yield* Effect.yieldNow

      const orphan = yield* activity.get(orphanID)
      expect(orphan?.status).toBe("interrupted")
      expect(orphan?.closedSeq).toBeDefined()
      expect((yield* activity.get(activeID))?.status).toBe("running")
    }),
  )

  it.effect("provider progress renews a delayed local heartbeat without self-terminalizing the active run", () =>
    Effect.gen(function* () {
      yield* setup
      const activity = yield* SessionActivity.Service
      const { db } = yield* Database.Service
      const ownerID = "owner_live_reasoning"
      const startedAt = 1_000_000
      yield* TestClock.setTime(startedAt)
      yield* db
        .insert(SessionActivityTable)
        .values({
          id: "activity_previous_interrupted",
          session_id: sessionID,
          status: "interrupted",
          kind: "prompt",
          reason: "stale-lease",
          opened_seq: 1,
          closed_seq: 80,
          time_created: startedAt - 1,
          time_updated: startedAt - 1,
        })
        .run()
        .pipe(Effect.orDie)
      const current = yield* activity.open({
        sessionID,
        kind: "resume",
        ownerID,
        openedSeq: 82,
      })
      const active = new Map([[sessionID, current.id]])
      const heartbeats = new Map<string, number>()
      SessionActivity.retainLocal(current.id)

      yield* TestClock.adjust(SessionActivity.LEASE_DURATION_MS + 1)
      expect(yield* activity.interruptStale(current.id, 582)).toBeUndefined()
      yield* SessionExecutionLocal.heartbeatActivityProgress(activity, active, heartbeats, ownerID, {
        data: { sessionID, reasoningID: "reasoning_live" },
      })

      const renewed = yield* activity.get(current.id)
      expect(renewed).toMatchObject({
        status: "running",
        kind: "resume",
        openedSeq: 82,
        heartbeatAt: startedAt + SessionActivity.LEASE_DURATION_MS + 1,
        leaseUntil: startedAt + SessionActivity.LEASE_DURATION_MS * 2 + 1,
      })

      yield* activity.complete(current.id, ownerID, 583)
      SessionActivity.releaseLocal(current.id)
      const rows = yield* db
        .select()
        .from(SessionActivityTable)
        .where(eq(SessionActivityTable.session_id, sessionID))
        .orderBy(desc(SessionActivityTable.time_created))
        .all()
        .pipe(Effect.orDie)
      expect(rows.map((row) => ({ status: row.status, openedSeq: row.opened_seq, closedSeq: row.closed_seq }))).toEqual(
        [
          { status: "completed", openedSeq: 82, closedSeq: 583 },
          { status: "interrupted", openedSeq: 1, closedSeq: 80 },
        ],
      )
      expect(rows[0]?.heartbeat_at).toBeNull()
      expect(rows[0]?.lease_until).toBeNull()
    }),
  )

  it.effect("rejects a former owner's progress heartbeat after another service takes over the expired lease", () =>
    Effect.gen(function* () {
      yield* setup
      const databaseService = yield* Database.Service
      const eventService = yield* EventV2.Service
      const dependencies = Layer.mergeAll(
        Layer.succeed(Database.Service, databaseService),
        Layer.succeed(EventV2.Service, eventService),
      )
      const serviceLayer = SessionActivity.layer.pipe(Layer.provide(dependencies))
      const ownerA = Context.get(yield* Layer.build(Layer.fresh(serviceLayer)), SessionActivity.Service)
      const ownerB = Context.get(yield* Layer.build(Layer.fresh(serviceLayer)), SessionActivity.Service)
      const startedAt = 2_000_000
      yield* TestClock.setTime(startedAt)
      const current = yield* ownerA.open({ sessionID, kind: "resume", ownerID: "owner_a", openedSeq: 90 })
      const active = new Map([[sessionID, current.id]])
      const heartbeats = new Map<string, number>()
      const ownershipLost = yield* Deferred.make<void>()

      yield* TestClock.adjust(SessionActivity.LEASE_DURATION_MS + 1)
      expect(yield* ownerB.recoverStaleByID(current.id, "owner_b")).toMatchObject({
        id: current.id,
        ownerID: "owner_b",
        status: "recovering",
      })
      yield* SessionExecutionLocal.heartbeatActivityProgress(
        ownerA,
        active,
        heartbeats,
        "owner_a",
        { data: { sessionID, reasoningID: "late_owner_a_progress" } },
        () => Deferred.succeed(ownershipLost, undefined),
      )

      expect(yield* Deferred.isDone(ownershipLost)).toBeTrue()
      expect(heartbeats.has(current.id)).toBeFalse()
      expect(yield* ownerB.get(current.id)).toMatchObject({
        ownerID: "owner_b",
        heartbeatAt: startedAt + SessionActivity.LEASE_DURATION_MS + 1,
        leaseUntil: startedAt + SessionActivity.LEASE_DURATION_MS * 2 + 1,
      })
    }),
  )

  it.effect("releases every local registration when interrupted before heartbeat setup completes", () =>
    Effect.gen(function* () {
      yield* setup
      const activity = yield* SessionActivity.Service
      const active = new Map<SessionV2.ID, string>()
      const heartbeats = new Map<string, number>()
      const registered = yield* Deferred.make<string>()
      const finishSetup = yield* Deferred.make<void>()
      const fiber = yield* SessionExecutionLocal.withLocalActivity(
        activity,
        active,
        heartbeats,
        {
          sessionID,
          kind: "resume",
          ownerID: "owner_setup",
          openedSeq: 91,
        },
        (info) =>
          Effect.gen(function* () {
            heartbeats.set(info.id, yield* Clock.currentTimeMillis)
            yield* Deferred.succeed(registered, info.id)
            yield* Deferred.await(finishSetup)
          }),
      ).pipe(Effect.forkChild)
      const activityID = yield* Deferred.await(registered)
      expect(active.get(sessionID)).toBe(activityID)
      expect(heartbeats.has(activityID)).toBeTrue()

      yield* Fiber.interrupt(fiber)
      expect(active.has(sessionID)).toBeFalse()
      expect(heartbeats.has(activityID)).toBeFalse()

      yield* TestClock.adjust(SessionActivity.LEASE_DURATION_MS + 1)
      expect(
        yield* activity.open({ sessionID, kind: "recovery", ownerID: "owner_recovery", openedSeq: 92 }),
      ).toMatchObject({
        id: activityID,
        ownerID: "owner_recovery",
        status: "recovering",
      })
    }),
  )

  it.effect("ignores late terminal events from a previous activity generation", () =>
    Effect.gen(function* () {
      yield* setup
      const activity = yield* SessionActivity.Service
      const startedAt = 1_000_000
      yield* TestClock.setTime(startedAt)

      const first = yield* activity.open({
        sessionID,
        kind: "prompt",
        ownerID: "owner_first",
        openedSeq: 1,
      })
      yield* activity.complete(first.id, "owner_first", 1)
      const second = yield* activity.open({
        sessionID,
        kind: "prompt",
        ownerID: "owner_second",
        openedSeq: 2,
      })
      const active = new Map([[sessionID, second.id]])
      const heartbeats = new Map([[second.id, startedAt]])
      const ownershipLost = yield* Deferred.make<string>()
      yield* TestClock.adjust(SessionActivity.HEARTBEAT_INTERVAL_MS)

      for (const type of [
        SessionEvent.Activity.Completed.type,
        SessionEvent.Activity.Failed.type,
        SessionEvent.Activity.Interrupted.type,
      ]) {
        yield* SessionExecutionLocal.heartbeatActivityProgress(
          activity,
          active,
          heartbeats,
          "owner_first",
          { type, data: { sessionID, activityID: first.id } },
          (_, activityID) => Deferred.succeed(ownershipLost, activityID).pipe(Effect.asVoid),
        )
      }

      expect(yield* Deferred.isDone(ownershipLost)).toBeFalse()
      expect(heartbeats.get(second.id)).toBe(startedAt)
      expect(yield* activity.get(second.id)).toMatchObject({
        status: "running",
        ownerID: "owner_second",
        heartbeatAt: startedAt,
        leaseUntil: startedAt + SessionActivity.LEASE_DURATION_MS,
      })
    }),
  )

  it.effect("stops the periodic heartbeat fiber when its scope closes", () =>
    Effect.gen(function* () {
      yield* setup
      const activity = yield* SessionActivity.Service
      const ownerID = "owner_heartbeat_fiber"
      const startedAt = 1_000_000
      yield* TestClock.setTime(startedAt)
      const info = yield* activity.open({
        sessionID,
        kind: "prompt",
        ownerID,
        openedSeq: 1,
      })
      const heartbeats = new Map<string, number>()
      const ownershipLost = yield* Deferred.make<void>()
      const scope = yield* Scope.make()
      const fiber = yield* SessionExecutionLocal.activityHeartbeat(
        activity,
        info.id,
        ownerID,
        heartbeats,
        () => Deferred.succeed(ownershipLost, undefined).pipe(Effect.asVoid),
      ).pipe(Effect.forkIn(scope, { startImmediately: true }))

      yield* TestClock.adjust(SessionActivity.HEARTBEAT_INTERVAL_MS)
      expect(heartbeats.get(info.id)).toBe(startedAt + SessionActivity.HEARTBEAT_INTERVAL_MS)
      const renewed = yield* activity.get(info.id)
      expect(renewed).toMatchObject({
        heartbeatAt: startedAt + SessionActivity.HEARTBEAT_INTERVAL_MS,
        leaseUntil: startedAt + SessionActivity.HEARTBEAT_INTERVAL_MS + SessionActivity.LEASE_DURATION_MS,
      })

      yield* Scope.close(scope, Exit.void)
      expect(Exit.isFailure(yield* Fiber.await(fiber))).toBeTrue()
      yield* TestClock.adjust(SessionActivity.HEARTBEAT_INTERVAL_MS * 3)

      expect(yield* Deferred.isDone(ownershipLost)).toBeFalse()
      expect(heartbeats.get(info.id)).toBe(startedAt + SessionActivity.HEARTBEAT_INTERVAL_MS)
      expect(yield* activity.get(info.id)).toMatchObject({
        heartbeatAt: renewed?.heartbeatAt,
        leaseUntil: renewed?.leaseUntil,
      })
    }),
  )

  it.effect("releases a claimed activity when interrupted during its Started event", () =>
    Effect.gen(function* () {
      yield* setup
      const databaseService = yield* Database.Service
      const eventService = yield* EventV2.Service
      const publishStarted = yield* Deferred.make<string>()
      const releasePublish = yield* Deferred.make<void>()
      const blockedEvents = EventV2.Service.of({
        ...eventService,
        publish: (definition, data, options) => {
          if (definition.type !== SessionEvent.Activity.Started.type) return eventService.publish(definition, data, options)
          const started = data as EventV2.Data<typeof SessionEvent.Activity.Started>
          return Deferred.succeed(publishStarted, started.activityID).pipe(
            Effect.andThen(Deferred.await(releasePublish)),
            Effect.andThen(eventService.publish(definition, data, options)),
          )
        },
      })
      const activity = Context.get(
        yield* Layer.build(
          Layer.fresh(
            SessionActivity.layer.pipe(
              Layer.provide(Layer.succeed(Database.Service, databaseService)),
              Layer.provide(Layer.succeed(EventV2.Service, blockedEvents)),
            ),
          ),
        ),
        SessionActivity.Service,
      )
      const ownerID = "owner_blocked_publisher"
      const startedAt = 1_000_000
      yield* TestClock.setTime(startedAt)
      const active = new Map<SessionV2.ID, string>()
      const heartbeats = new Map<string, number>()
      const fiber = yield* SessionExecutionLocal.withLocalActivity(
        activity,
        active,
        heartbeats,
        {
          sessionID,
          kind: "prompt",
          ownerID,
          openedSeq: 1,
        },
        () => Effect.never,
      ).pipe(Effect.forkChild)

      const activityID = yield* Deferred.await(publishStarted)
      expect(active.get(sessionID)).toBe(activityID)
      yield* Fiber.interrupt(fiber)
      expect(active.has(sessionID)).toBeFalse()
      expect(heartbeats.has(activityID)).toBeFalse()
      expect(yield* activity.get(activityID)).toMatchObject({
        status: "running",
        ownerID,
        reason: SessionActivity.interruptReason("owner-interrupted"),
        leaseUntil: startedAt,
      })
      expect(yield* activity.recoverStaleByID(activityID, "recovery_owner")).toMatchObject({
        id: activityID,
        status: "recovering",
        ownerID: "recovery_owner",
      })
    }),
  )

  it.effect("restart before staggered foreign lease expiries schedules one scan after the observed cohort", () =>
    Effect.gen(function* () {
      yield* setup
      const activity = yield* SessionActivity.Service
      const { db } = yield* Database.Service
      const restartNow = 1_000_000
      yield* TestClock.setTime(restartNow)
      const activityID = Identifier.ascending()
      const laterActivityID = Identifier.ascending()
      yield* db
        .insert(SessionActivityTable)
        .values([
          {
            id: activityID,
            session_id: sessionID,
            status: "running" as const,
            kind: "prompt" as const,
            owner_id: "crashed_sidecar_owner_early",
            lease_until: restartNow + 5_000,
            heartbeat_at: restartNow,
            time_created: restartNow,
            time_updated: restartNow,
          },
          {
            id: laterActivityID,
            session_id: sessionID,
            status: "running" as const,
            kind: "prompt" as const,
            owner_id: "crashed_sidecar_owner_late",
            lease_until: restartNow + 10_000,
            heartbeat_at: restartNow,
            time_created: restartNow,
            time_updated: restartNow,
          },
        ])
        .run()
        .pipe(Effect.orDie)

      yield* SessionExecutionLocal.runStartupRecovery(activity, db)
      expect(yield* activity.get(activityID)).toMatchObject({
        status: "running",
        ownerID: "crashed_sidecar_owner_early",
        leaseUntil: restartNow + 5_000,
      })
      expect(yield* activity.get(laterActivityID)).toMatchObject({
        status: "running",
        ownerID: "crashed_sidecar_owner_late",
        leaseUntil: restartNow + 10_000,
      })

      // The first lease has expired, but the single follow-up is intentionally
      // held until the latest lease observed at startup has expired as well.
      yield* TestClock.adjust(10_249)
      yield* Effect.yieldNow
      expect(yield* activity.get(activityID)).toMatchObject({ status: "running" })
      expect(yield* activity.get(laterActivityID)).toMatchObject({ status: "running" })

      yield* TestClock.adjust(1)
      yield* Effect.yieldNow
      const terminal = yield* activity.get(activityID)
      expect(terminal).toMatchObject({ status: "interrupted", reason: "stale-lease" })
      expect(terminal?.ownerID).toBeUndefined()
      expect(terminal?.leaseUntil).toBeUndefined()
      expect(terminal?.heartbeatAt).toBeUndefined()
      const laterTerminal = yield* activity.get(laterActivityID)
      expect(laterTerminal).toMatchObject({ status: "interrupted", reason: "stale-lease" })
      expect(laterTerminal?.ownerID).toBeUndefined()
      expect(laterTerminal?.leaseUntil).toBeUndefined()
      expect(laterTerminal?.heartbeatAt).toBeUndefined()
    }),
  )

  it.live("activity recovery claims stale leases", () =>
    Effect.gen(function* () {
      yield* setup
      const activity = yield* SessionActivity.Service
      const { db } = yield* Database.Service

      const expiredTime = Date.now() - 60_000
      const activityID = Identifier.ascending()
      yield* db
        .insert(SessionActivityTable)
        .values({
          id: activityID,
          session_id: sessionID,
          status: "running",
          kind: "prompt",
          owner_id: "old_owner",
          lease_until: expiredTime,
          heartbeat_at: expiredTime,
          time_created: expiredTime,
          time_updated: expiredTime,
        })
        .run()
        .pipe(Effect.orDie)

      const claimed = yield* activity.recoverStale("new_owner", 10)
      expect(claimed).toHaveLength(1)
      expect(claimed[0]!.status).toBe("recovering")
      expect(claimed[0]!.ownerID).toBe("new_owner")
    }),
  )

  it.effect("claims only the requested legacy activity when its lease is missing", () =>
    Effect.gen(function* () {
      yield* setup
      const activity = yield* SessionActivity.Service
      const { db } = yield* Database.Service
      const firstID = Identifier.ascending()
      const secondID = Identifier.ascending()
      const now = Date.now()
      yield* db
        .insert(SessionActivityTable)
        .values(
          [firstID, secondID].map((id) => ({
            id,
            session_id: sessionID,
            status: "running",
            kind: "prompt",
            owner_id: `old_${id}`,
            time_created: now,
            time_updated: now,
          })),
        )
        .run()
        .pipe(Effect.orDie)

      expect(yield* activity.recoverStaleByID(firstID, "question_settlement_owner")).toMatchObject({
        id: firstID,
        status: "recovering",
        ownerID: "question_settlement_owner",
      })
      expect((yield* activity.get(secondID))?.status).toBe("running")
    }),
  )

  it.effect("does not claim active (non-stale) activities", () =>
    Effect.gen(function* () {
      yield* setup
      const activity = yield* SessionActivity.Service
      const { db } = yield* Database.Service

      const futureTime = Date.now() + 300_000
      yield* db
        .insert(SessionActivityTable)
        .values({
          id: Identifier.ascending(),
          session_id: sessionID,
          status: "running",
          kind: "prompt",
          owner_id: "active_owner",
          lease_until: futureTime,
          heartbeat_at: Date.now(),
          time_created: Date.now(),
          time_updated: Date.now(),
        })
        .run()
        .pipe(Effect.orDie)

      const claimed = yield* activity.recoverStale("new_owner", 10)
      expect(claimed).toHaveLength(0)
    }),
  )

  it.effect("serializes opens behind a live same-session lease", () =>
    Effect.gen(function* () {
      yield* setup
      const activity = yield* SessionActivity.Service
      const first = yield* activity.open({
        sessionID,
        kind: "prompt",
        ownerID: "first_owner",
        leaseDurationMs: 300_000,
        openedSeq: 1,
      })
      const secondStarted = yield* Deferred.make<SessionActivity.Info>()
      const second = yield* activity
        .open({
          sessionID,
          kind: "prompt",
          ownerID: "second_owner",
          leaseDurationMs: 300_000,
          openedSeq: 2,
        })
        .pipe(
          Effect.tap((info) => Deferred.succeed(secondStarted, info)),
          Effect.forkChild,
        )

      yield* Effect.yieldNow
      expect(yield* Deferred.isDone(secondStarted)).toBeFalse()
      expect((yield* activity.listForSession(sessionID)).filter((info) => info.status === "running")).toHaveLength(1)

      yield* activity.complete(first.id, "first_owner", 1)
      yield* TestClock.adjust(251)
      const successor = yield* Deferred.await(secondStarted)
      expect(successor.id).not.toBe(first.id)
      expect(successor.ownerID).toBe("second_owner")
      expect((yield* activity.listForSession(sessionID)).filter((info) => info.status === "running")).toHaveLength(1)
      yield* activity.complete(successor.id, "second_owner", 2)
      yield* Fiber.join(second)
    }),
  )

  it.effect("takes over an expired same-session lease without creating a parallel activity", () =>
    Effect.gen(function* () {
      yield* setup
      const activity = yield* SessionActivity.Service
      const { db } = yield* Database.Service
      const activityID = Identifier.ascending()
      yield* db
        .insert(SessionActivityTable)
        .values({
          id: activityID,
          session_id: sessionID,
          status: "running",
          kind: "prompt",
          owner_id: "expired_owner",
          lease_until: 0,
          heartbeat_at: 0,
          opened_seq: 1,
          time_created: 0,
          time_updated: 0,
        })
        .run()
        .pipe(Effect.orDie)

      const claimed = yield* activity.open({
        sessionID,
        kind: "resume",
        ownerID: "new_owner",
        leaseDurationMs: 300_000,
        openedSeq: 2,
      })

      expect(claimed).toMatchObject({ id: activityID, status: "recovering", ownerID: "new_owner" })
      expect(
        (yield* activity.listForSession(sessionID)).filter(
          (info) => info.status === "running" || info.status === "recovering",
        ),
      ).toHaveLength(1)
    }),
  )

  it.effect("owner shutdown leaves running activity recoverable", () =>
    Effect.gen(function* () {
      yield* setup
      const activity = yield* SessionActivity.Service

      const info = yield* activity.open({
        sessionID,
        kind: "resume",
        ownerID: "test_owner",
        leaseDurationMs: 300_000,
        openedSeq: 1,
      })

      const prepared = yield* activity.prepareOwnerShutdown("test_owner", "shutdown-test")
      expect(prepared).toHaveLength(1)
      expect(prepared[0]!.status).toBe("running")
      expect(prepared[0]!.reason).toBe("shutdown-test")
      expect(prepared[0]!.leaseUntil).toBeLessThanOrEqual(Date.now())

      const after = yield* activity.get(info.id)
      expect(after?.status).toBe("running")
      expect(after?.reason).toBe("shutdown-test")
      expect(after?.closedSeq).toBeUndefined()

      const claimed = yield* activity.recoverStale("new_owner", 10)
      expect(claimed).toHaveLength(1)
      expect(claimed[0]!.status).toBe("recovering")
      expect(claimed[0]!.ownerID).toBe("new_owner")
    }),
  )

  it.effect("explicit abort terminalizes an AbortError runner exit as interrupted", () =>
    Effect.gen(function* () {
      yield* setup
      const activity = yield* SessionActivity.Service
      const info = yield* activity.open({
        sessionID,
        kind: "prompt",
        ownerID: "explicit_abort_owner",
        openedSeq: 1,
      })

      yield* SessionExecutionLocal.terminalizeActivity(activity, {
        activityID: info.id,
        ownerID: "explicit_abort_owner",
        explicitlyInterrupted: true,
        closedSeq: 2,
        exit: Exit.fail(new DOMException("This operation was aborted", "AbortError")),
      })

      const terminal = yield* activity.get(info.id)
      expect(terminal?.status).toBe("interrupted")
      expect(terminal?.lastError).toBeUndefined()
      expect(terminal?.openedSeq).toBe(1)
      expect(terminal?.closedSeq).toBe(2)
      expect(terminal?.ownerID).toBeUndefined()
      expect(terminal?.leaseUntil).toBeUndefined()
      expect(terminal?.heartbeatAt).toBeUndefined()

      const { db } = yield* Database.Service
      const eventTypes = yield* db
        .select({ type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .all()
        .pipe(
          Effect.orDie,
          Effect.map((rows) => rows.map((row) => row.type)),
        )
      expect(eventTypes).toContain(EventV2.versionedType(SessionEvent.Activity.Interrupted.type, 1))
      expect(eventTypes).not.toContain(EventV2.versionedType(SessionEvent.Activity.Failed.type, 1))
    }),
  )

  it.effect("a marked provider interrupt terminalizes only its activity and keeps the owner alive", () =>
    Effect.gen(function* () {
      yield* setup
      const activity = yield* SessionActivity.Service
      const { db } = yield* Database.Service
      const secondSessionID = SessionV2.ID.make("ses_provider_interrupt_sibling")
      yield* db.insert(SessionTable).values({
        id: secondSessionID, project_id: Project.ID.global, slug: "interrupt-sibling",
        directory: "/project", title: "Unaffected sibling", version: "test",
      }).run()
      const affected = yield* activity.open({ sessionID, kind: "prompt", ownerID: "live_owner", openedSeq: 1 })
      const sibling = yield* activity.open({ sessionID: secondSessionID, kind: "prompt", ownerID: "live_owner", openedSeq: 1 })
      const cause = Cause.combine(Cause.interrupt(), Cause.fail(new SessionRunner.ProviderInterruptedError()))
      expect(Cause.hasInterrupts(cause)).toBe(true)
      yield* SessionExecutionLocal.terminalizeActivity(activity, {
        activityID: affected.id, ownerID: "live_owner", explicitlyInterrupted: false,
        closedSeq: 2, exit: Exit.failCause(cause),
      })
      const terminal = yield* activity.get(affected.id)
      expect(terminal?.status).toBe("interrupted")
      expect(terminal?.reason).toBe("owner-interrupted")
      expect(terminal?.closedSeq).toBe(2)
      expect(terminal?.ownerID).toBeUndefined()
      expect(terminal?.leaseUntil).toBeUndefined()
      const untouched = yield* activity.get(sibling.id)
      expect(untouched?.status).toBe("running")
      expect(untouched?.leaseUntil).toBe(sibling.leaseUntil)
      expect(untouched?.ownerID).toBe("live_owner")
      expect(untouched?.reason).toBeUndefined()
    }),
  )

  it.effect("does not label an owner interruption as a user stop", () =>
    Effect.gen(function* () {
      yield* setup
      const activity = yield* SessionActivity.Service
      const info = yield* activity.open({
        sessionID,
        kind: "prompt",
        ownerID: "owner_interrupted",
        openedSeq: 1,
      })

      yield* SessionExecutionLocal.terminalizeActivity(activity, {
        activityID: info.id,
        ownerID: "owner_interrupted",
        explicitlyInterrupted: false,
        closedSeq: 2,
        exit: Exit.interrupt(),
        explicitInterruptReason: SessionActivity.interruptReason("user-stop"),
      })

      const retained = yield* activity.get(info.id)
      expect(retained).toMatchObject({
        status: "running",
        reason: "owner-interrupted",
      })
      expect(retained?.closedSeq).toBeUndefined()
      expect(retained?.leaseUntil).toBeLessThanOrEqual(Date.now())
    }),
  )

  it.effect("terminalizes an early provider authorization error with a typed failure", () =>
    Effect.gen(function* () {
      yield* setup
      const activity = yield* SessionActivity.Service
      const info = yield* activity.open({
        sessionID,
        kind: "prompt",
        ownerID: "auth_failure_owner",
        openedSeq: 1,
      })

      yield* SessionExecutionLocal.terminalizeActivity(activity, {
        activityID: info.id,
        ownerID: "auth_failure_owner",
        explicitlyInterrupted: false,
        closedSeq: 2,
        exit: Exit.fail(new Integration.AuthorizationError({ cause: new Error("opaque credential failure") })),
      })

      const { db } = yield* Database.Service
      const failed = yield* db
        .select({ data: EventTable.data })
        .from(EventTable)
        .where(eq(EventTable.type, EventV2.versionedType(SessionEvent.Activity.Failed.type, 2)))
        .get()
        .pipe(Effect.orDie)
      expect(failed?.data).toMatchObject({
        failure: {
          code: "provider.auth",
          message: "Provider authentication failed; credentials or access need attention.",
          remediation: "report",
        },
      })
    }),
  )

  it.effect("terminalizes an unrecovered event-only provider error as failed without completing", () =>
    Effect.gen(function* () {
      yield* setup
      const activity = yield* SessionActivity.Service
      const events = yield* EventV2.Service
      const info = yield* activity.open({
        sessionID,
        kind: "prompt",
        ownerID: "terminal_event_owner",
        openedSeq: 1,
      })
      // The exact typed runner failure the session runner now returns for an
      // unrecovered terminal event-only provider error (for example a permanent
      // HTTP 400 delivered as a providerError event in a successful stream):
      // LocalExecution must mark the activity failed, never completed, and no
      // advisory wake may replay the settled failure.
      const runnerFailure = new LLMError({
        module: "SessionRunner",
        method: "runProviderStream",
        reason: new InvalidRequestReason({
          message: "The provider rejected the request as invalid.",
        }),
      })
      const completedEvents: string[] = []
      yield* events.listen((event) => Effect.sync(() => completedEvents.push(event.type)))

      yield* SessionExecutionLocal.terminalizeActivity(activity, {
        activityID: info.id,
        ownerID: "terminal_event_owner",
        explicitlyInterrupted: false,
        closedSeq: 2,
        exit: Exit.fail(runnerFailure),
      })

      const terminal = yield* activity.get(info.id)
      expect(terminal?.status).toBe("failed")
      expect(terminal?.closedSeq).toBe(2)
      const { db } = yield* Database.Service
      const eventTypes = yield* db
        .select({ type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .all()
        .pipe(
          Effect.orDie,
          Effect.map((rows) => rows.map((row) => row.type)),
        )
      expect(eventTypes).toContain(EventV2.versionedType(SessionEvent.Activity.Failed.type, 2))
      expect(eventTypes).not.toContain(EventV2.versionedType(SessionEvent.Activity.Completed.type, 1))
      expect(completedEvents).not.toContain(SessionEvent.Activity.Completed.type)
    }),
  )

  it.effect("keeps an explicit interrupt marker until a delayed coordinator unwind is terminalized", () =>
    Effect.gen(function* () {
      yield* setup
      const activity = yield* SessionActivity.Service
      const info = yield* activity.open({
        sessionID,
        kind: "prompt",
        ownerID: "delayed_interrupt_owner",
        openedSeq: 1,
      })
      const activeActivityBySession = new Map([[sessionID, "act_noop"]])
      const explicitlyInterrupted = new Set<SessionV2.ID>()
      const unwind = yield* Deferred.make<void>()
      const unwindFiber = yield* Effect.gen(function* () {
        yield* Deferred.await(unwind)
        const wasExplicitlyInterrupted = explicitlyInterrupted.delete(sessionID)
        yield* SessionExecutionLocal.terminalizeActivity(activity, {
          activityID: info.id,
          ownerID: "delayed_interrupt_owner",
          explicitlyInterrupted: wasExplicitlyInterrupted,
          closedSeq: 2,
          exit: Exit.fail(new DOMException("This operation was aborted", "AbortError")),
          explicitInterruptReason: SessionActivity.interruptReason("user-stop"),
        })
        activeActivityBySession.delete(sessionID)
      }).pipe(Effect.forkChild)
      activeActivityBySession.set(sessionID, info.id)

      yield* SessionExecutionLocal.interruptActivity(
        activeActivityBySession,
        explicitlyInterrupted,
        sessionID,
        Effect.void,
      )

      expect(explicitlyInterrupted.has(sessionID)).toBeTrue()
      expect(activeActivityBySession.get(sessionID)).toBe(info.id)
      expect(yield* activity.get(info.id)).toMatchObject({ status: "running", ownerID: "delayed_interrupt_owner" })

      yield* Deferred.succeed(unwind, undefined)
      yield* Fiber.join(unwindFiber)
      expect(activeActivityBySession.has(sessionID)).toBeFalse()
      expect(explicitlyInterrupted.has(sessionID)).toBeFalse()
      const terminal = yield* activity.get(info.id)
      expect(terminal).toMatchObject({
        status: "interrupted",
        reason: "user-stop",
        closedSeq: 2,
      })
      expect(terminal?.ownerID).toBeUndefined()
      expect(terminal?.leaseUntil).toBeUndefined()
      expect(terminal?.heartbeatAt).toBeUndefined()

      yield* SessionExecutionLocal.interruptActivity(new Map(), explicitlyInterrupted, sessionID, Effect.void)
      expect(explicitlyInterrupted.has(sessionID)).toBeFalse()
    }),
  )

  it.effect("does not interrupt a newer activity when the requested activity is no longer owned", () =>
    Effect.gen(function* () {
      const activeActivityBySession = new Map([[sessionID, "act_newer"]])
      const explicitlyInterrupted = new Set<SessionV2.ID>()
      let calls = 0

      const interrupted = yield* SessionExecutionLocal.interruptOwnedActivity(
        activeActivityBySession,
        explicitlyInterrupted,
        sessionID,
        "act_older",
        Effect.sync(() => {
          calls++
        }),
      )

      expect(interrupted).toBeFalse()
      expect(calls).toBe(0)
      expect(explicitlyInterrupted.has(sessionID)).toBeFalse()
    }),
  )

  it.effect("terminalizing an explicit interrupt records the interrupt reason on the activity", () =>
    Effect.gen(function* () {
      yield* setup
      const activity = yield* SessionActivity.Service
      const info = yield* activity.open({
        sessionID,
        kind: "prompt",
        ownerID: "reason_owner",
        openedSeq: 1,
      })

      yield* SessionExecutionLocal.terminalizeActivity(activity, {
        activityID: info.id,
        ownerID: "reason_owner",
        explicitlyInterrupted: true,
        closedSeq: 3,
        exit: Exit.fail(new DOMException("This operation was aborted", "AbortError")),
        explicitInterruptReason: SessionActivity.interruptReason("user-stop"),
      })

      const terminal = yield* activity.get(info.id)
      expect(terminal?.status).toBe("interrupted")
      expect(terminal?.reason).toBe("user-stop")

      const { db } = yield* Database.Service
      const eventTypes = yield* db
        .select({ type: EventTable.type, data: EventTable.data })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      const interrupted = eventTypes.find((row) => row.type.includes("activity.interrupted"))
      expect(interrupted).toBeDefined()
      if (!interrupted) return
      expect(JSON.stringify(interrupted.data)).toContain('"user-stop"')
    }),
  )

  it.live("recovery can reclaim stale recovering activities", () =>
    Effect.gen(function* () {
      yield* setup
      const activity = yield* SessionActivity.Service
      const { db } = yield* Database.Service

      const info = yield* activity.open({
        sessionID,
        kind: "prompt",
        ownerID: "old_owner",
        openedSeq: 1,
      })
      yield* db
        .update(SessionActivityTable)
        .set({
          status: "recovering",
          owner_id: "recovering_owner",
          lease_until: Date.now() - 60_000,
          heartbeat_at: Date.now() - 60_000,
          time_updated: Date.now() - 60_000,
        })
        .where(eq(SessionActivityTable.id, info.id))
        .run()
        .pipe(Effect.orDie)

      const claimed = yield* activity.recoverStale("new_owner", 10)
      expect(claimed).toHaveLength(1)
      expect(claimed[0]!.status).toBe("recovering")
      expect(claimed[0]!.ownerID).toBe("new_owner")
    }),
  )

  it.effect("activity lifecycle: open then complete", () =>
    Effect.gen(function* () {
      yield* setup
      const activity = yield* SessionActivity.Service

      const info = yield* activity.open({
        sessionID,
        kind: "resume",
        ownerID: "test_owner",
        openedSeq: 1,
      })
      expect(info.status).toBe("running")
      expect(info.ownerID).toBe("test_owner")

      yield* activity.complete(info.id, "test_owner", 2)

      const after = yield* activity.get(info.id)
      expect(after?.status).toBe("completed")
      expect(after?.openedSeq).toBe(1)
      expect(after?.closedSeq).toBe(2)
      expect(after?.ownerID).toBeUndefined()
      expect(after?.leaseUntil).toBeUndefined()
      expect(after?.heartbeatAt).toBeUndefined()
    }),
  )

  it.effect("activity fail records error", () =>
    Effect.gen(function* () {
      yield* setup
      const activity = yield* SessionActivity.Service

      const info = yield* activity.open({
        sessionID,
        kind: "prompt",
        ownerID: "test_owner",
        openedSeq: 1,
      })

      yield* activity.fail(info.id, "test_owner", "Something went wrong", 2)

      const after = yield* activity.get(info.id)
      expect(after?.status).toBe("failed")
      expect(after?.lastError).toBe("Something went wrong")
      expect(after?.openedSeq).toBe(1)
      expect(after?.closedSeq).toBe(2)
      expect(after?.ownerID).toBeUndefined()
      expect(after?.leaseUntil).toBeUndefined()
      expect(after?.heartbeatAt).toBeUndefined()

      const { db } = yield* Database.Service
      const failed = yield* db
        .select({ data: EventTable.data })
        .from(EventTable)
        .where(eq(EventTable.type, EventV2.versionedType(SessionEvent.Activity.Failed.type, 2)))
        .all()
        .pipe(Effect.orDie)
      const event = failed
        .map((row) => EventV2.decodeStoredEventData(row.data))
        .find((data) => data.activityID === info.id)
      expect(event).toBeDefined()
      if (!event) return
      expect((event.error as { readonly message: string }).message).toBe("Something went wrong")
    }),
  )

  it.effect("bounds oversized schema route errors in the activity row and failure event", () =>
    Effect.gen(function* () {
      yield* setup
      const activity = yield* SessionActivity.Service
      const info = yield* activity.open({
        sessionID,
        kind: "prompt",
        ownerID: "large_error_owner",
        openedSeq: 1,
      })
      const error = [
        "err_route_schema_42: POST /api/session/:sessionID request schema validation failed",
        ...Array.from(
          { length: 600 },
          (_, index) => `  issues[${index}].path: expected string but received object while routing request`,
        ),
        "route-schema-tail-that-must-not-be-persisted",
      ].join("\n")

      yield* activity.fail(info.id, "large_error_owner", error, 2)

      const { db } = yield* Database.Service
      const row = yield* db
        .select()
        .from(SessionActivityTable)
        .where(eq(SessionActivityTable.id, info.id))
        .get()
        .pipe(Effect.orDie)
      const normalized = SessionActivity.normalizeError(error)
      expect(row?.status).toBe("failed")
      expect(row?.closed_seq).toBe(2)
      expect(row?.owner_id).toBeNull()
      expect(row?.last_error).toBe(normalized)
      if (!row?.last_error) return
      expect(Buffer.byteLength(row.last_error, "utf8")).toBeLessThanOrEqual(SessionActivity.MAX_PERSISTED_ERROR_BYTES)
      expect(row.last_error.startsWith("err_route_schema_42")).toBeTrue()
      expect(row.last_error).toContain("[truncated;")
      expect(row.last_error).toContain("original-bytes=")
      expect(row.last_error).toContain("sha256=")
      expect(row.last_error).toContain("POST /api/session")
      expect(row.last_error).not.toContain("route-schema-tail-that-must-not-be-persisted")
      expect(SessionActivity.normalizeError(error)).toBe(normalized)
      expect(SessionActivity.normalizeError(`${error}\nchanged-tail`)).not.toBe(normalized)

      const failed = yield* db
        .select({ data: EventTable.data })
        .from(EventTable)
        .where(eq(EventTable.type, EventV2.versionedType(SessionEvent.Activity.Failed.type, 2)))
        .all()
        .pipe(Effect.orDie)
      const event = failed
        .map((event) => EventV2.decodeStoredEventData(event.data))
        .find((data) => data.activityID === info.id)
      expect(event).toBeDefined()
      if (!event) return
      const eventError = (event.error as { readonly message: string }).message
      expect(eventError).toBe(row.last_error)
      expect(Buffer.byteLength(eventError, "utf8")).toBeLessThanOrEqual(SessionActivity.MAX_PERSISTED_ERROR_BYTES)
    }),
  )
})
