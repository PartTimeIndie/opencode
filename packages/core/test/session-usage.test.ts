import { afterAll, describe, expect } from "bun:test"
import { Context, Effect, Fiber, Layer } from "effect"
import { randomUUID } from "node:crypto"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { ContentStore } from "@opencode-ai/core/content-store"
import { EventV2 } from "@opencode-ai/core/event"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionUsage } from "@opencode-ai/core/session/usage"
import { PartTable, MessageTable, SessionActivityTable, SessionInputTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const it = testEffect(database)
const snapshotPath = join(tmpdir(), `opencode-session-usage-${randomUUID()}.db`)

class SnapshotReader extends Context.Service<SnapshotReader, Database.Interface>()("test/SessionUsageSnapshotReader") {}
class SnapshotWriter extends Context.Service<SnapshotWriter, Database.Interface>()("test/SessionUsageSnapshotWriter") {}

const snapshotDatabases = Layer.mergeAll(
  Layer.effect(SnapshotReader, Effect.map(Database.Service, SnapshotReader.of)).pipe(
    Layer.provide(Database.layerFromPath(snapshotPath)),
  ),
  Layer.effect(SnapshotWriter, Effect.map(Database.Service, SnapshotWriter.of)).pipe(
    Layer.provide(Database.layerFromPath(snapshotPath)),
  ),
)
const itSnapshot = testEffect(snapshotDatabases)

afterAll(async () => {
  await Promise.all([snapshotPath, `${snapshotPath}-wal`, `${snapshotPath}-shm`].map((file) => rm(file, { force: true })))
})

const projectID = ProjectV2.ID.global
const worktree = AbsolutePath.make("/usage-test")

function insertProject(db: Database.Interface["db"]) {
  return db.insert(ProjectTable).values({ id: projectID, worktree, sandboxes: [] }).run()
}

function insertSession(
  db: Database.Interface["db"],
  input: {
    id: string
    parentID?: string
    input?: number
    output?: number
    reasoning?: number
    cacheRead?: number
    cacheWrite?: number
    cost?: number
    generationMs?: number
  },
) {
  return db
    .insert(SessionTable)
    .values({
      id: SessionV2.ID.make(input.id),
      project_id: projectID,
      parent_id: input.parentID ? SessionV2.ID.make(input.parentID) : undefined,
      slug: input.id,
      directory: worktree,
      title: input.id,
      version: "test",
      agent: "build",
      cost: input.cost ?? 0,
      tokens_input: input.input ?? 0,
      tokens_output: input.output ?? 0,
      tokens_reasoning: input.reasoning ?? 0,
      tokens_cache_read: input.cacheRead ?? 0,
      tokens_cache_write: input.cacheWrite ?? 0,
      generation_ms: input.generationMs ?? 0,
    })
    .run()
}

function insertActivity(
  db: Database.Interface["db"],
  input: {
    id: string
    sessionID: string
    opened?: number
    closed?: number
    timeCreated: number
    timeUpdated: number
    status?: "running" | "recovering" | "completed" | "failed" | "interrupted"
    recoveryAttempts?: number
  },
) {
  return db
    .insert(SessionActivityTable)
    .values({
      id: input.id,
      session_id: SessionV2.ID.make(input.sessionID),
      status: input.status ?? (input.closed === undefined ? "running" : "completed"),
      kind: "prompt",
      opened_seq: input.opened,
      closed_seq: input.closed,
      recovery_attempts: input.recoveryAttempts ?? 0,
      time_created: input.timeCreated,
      time_updated: input.timeUpdated,
    })
    .run()
}

function insertAssistantMessage(
  db: Database.Interface["db"],
  input: {
    id: string
    sessionID: string
    seq: number
    timeCreated: number
    tokens?: { input: number; output: number; reasoning?: number; cacheRead?: number; cacheWrite?: number }
    tokenMeasurement?: unknown
    content?: unknown[]
    cost?: number
  },
) {
  return db
    .insert(SessionMessageTable)
    .values({
      id: SessionV1.MessageID.make(input.id),
      session_id: SessionV2.ID.make(input.sessionID),
      type: "assistant",
      seq: input.seq,
      time_created: input.timeCreated,
      time_updated: input.timeCreated,
      data: {
        agent: "build",
        model: { id: "gpt-6-astra", providerID: "openai" },
        content: input.content ?? [],
        time: { created: input.timeCreated },
        ...(input.tokens
          ? {
              tokens: {
                input: input.tokens.input,
                output: input.tokens.output,
                reasoning: input.tokens.reasoning ?? 0,
                cache: { read: input.tokens.cacheRead ?? 0, write: input.tokens.cacheWrite ?? 0 },
              },
            }
          : {}),
        ...(input.tokenMeasurement === undefined ? {} : { tokenMeasurement: input.tokenMeasurement }),
        ...(input.cost === undefined ? {} : { cost: input.cost }),
      },
    } as unknown as typeof SessionMessageTable.$inferInsert)
    .run()
}

function insertLegacyMessage(db: Database.Interface["db"], input: { id: string; sessionID: string; timeCreated: number }) {
  // Parts reference the legacy message table, which shares the V2 message id space.
  return db
    .insert(MessageTable)
    .values({
      id: SessionV1.MessageID.make(input.id),
      session_id: SessionV2.ID.make(input.sessionID),
      time_created: input.timeCreated,
      time_updated: input.timeCreated,
      data: { role: "assistant", agent: "build" },
    } as typeof MessageTable.$inferInsert)
    .run()
}

function insertPart(db: Database.Interface["db"], input: { id: string; sessionID: string; messageID: string; childSessionID: string }) {
  return db
    .insert(PartTable)
    .values({
      id: SessionV1.PartID.make(input.id),
      session_id: SessionV2.ID.make(input.sessionID),
      message_id: SessionV1.MessageID.make(input.messageID),
      time_created: 0,
      time_updated: 0,
      data: {
        type: "tool",
        callID: "call_test",
        tool: "task",
        state: { status: "completed", metadata: { task_id: input.childSessionID } },
      },
    } as typeof PartTable.$inferInsert)
    .run()
}

describe("SessionUsage", () => {
  itSnapshot.effect("keeps Usage reads on one SQLite snapshot while another connection writes", () =>
    Effect.gen(function* () {
      const reader = yield* SnapshotReader
      const writer = yield* SnapshotWriter
      yield* insertProject(writer.db)
      yield* insertSession(writer.db, { id: "ses_snapshot", input: 1 })

      let announceRead!: () => void
      const readStarted = new Promise<void>((resolve) => (announceRead = resolve))
      let resumeRead!: () => void
      const continueRead = new Promise<void>((resolve) => (resumeRead = resolve))
      const read = SessionUsage.readSnapshot(reader.db, (tx) =>
        Effect.gen(function* () {
          const before = yield* tx
            .select({ cost: SessionTable.cost })
            .from(SessionTable)
            .where(eq(SessionTable.id, SessionV2.ID.make("ses_snapshot")))
            .get()
          yield* Effect.sync(announceRead)
          yield* Effect.promise(() => continueRead)
          const after = yield* tx
            .select({ cost: SessionTable.cost })
            .from(SessionTable)
            .where(eq(SessionTable.id, SessionV2.ID.make("ses_snapshot")))
            .get()
          return [before?.cost, after?.cost]
        }),
      )
      const fiber = yield* read.pipe(Effect.forkScoped)
      yield* Effect.promise(() => readStarted)
      yield* writer.db
        .update(SessionTable)
        .set({ cost: 4 })
        .where(eq(SessionTable.id, SessionV2.ID.make("ses_snapshot")))
        .run()
      resumeRead()

      expect(yield* Fiber.join(fiber)).toEqual([0, 0])
      const current = yield* writer.db
        .select({ cost: SessionTable.cost })
        .from(SessionTable)
        .where(eq(SessionTable.id, SessionV2.ID.make("ses_snapshot")))
        .get()
      expect(current?.cost).toBe(4)
    }),
  )

  it.effect("sums the session tree exactly once and keeps child sessions separate", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* insertProject(db)
      yield* insertSession(db, { id: "ses_parent", input: 100, output: 20, cost: 0.5 })
      yield* insertSession(db, { id: "ses_child", parentID: "ses_parent", input: 50, output: 10 })
      yield* insertSession(db, { id: "ses_grandchild", parentID: "ses_child", input: 7 })

      const parent = yield* Database.Service.use(({ db: database }) => SessionUsage.summarize(database, { sessionID: "ses_parent" }))
      expect(parent.session.own.total).toBe(120)
      expect(parent.session.descendants.total).toBe(67)
      expect(parent.session.total.total).toBe(187)
      expect(parent.session.descendantSessions).toBe(2)
      expect(parent.session.complete).toBe(true)
      expect(parent.run).toBeNull()

      const child = yield* Database.Service.use(({ db: database }) => SessionUsage.summarize(database, { sessionID: "ses_child" }))
      expect(child.session.own.total).toBe(60)
      expect(child.session.descendants.total).toBe(7)
      expect(child.session.total.total).toBe(67)
    }),
  )

  it.effect("attributes run windows by activity seq and child provenance without double counting", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* insertProject(db)
      yield* insertSession(db, { id: "ses_run_parent" })
      yield* insertSession(db, { id: "ses_run_child", parentID: "ses_run_parent" })
      yield* insertSession(db, { id: "ses_run_other", parentID: "ses_run_parent" })

      // Run 1: seq window [10, 11], closed. Child work at t=1500 belongs here.
      yield* insertActivity(db, { id: "act_1", sessionID: "ses_run_parent", opened: 10, closed: 11, timeCreated: 1000, timeUpdated: 2000 })
      yield* insertAssistantMessage(db, { id: "msg_run1", sessionID: "ses_run_parent", seq: 11, timeCreated: 1100, tokens: { input: 30, output: 5 }, cost: 0.01 })
      yield* insertLegacyMessage(db, { id: "msg_run1", sessionID: "ses_run_parent", timeCreated: 1100 })
      yield* insertPart(db, { id: "prt_1", sessionID: "ses_run_parent", messageID: "msg_run1", childSessionID: "ses_run_child" })
      yield* insertAssistantMessage(db, { id: "msg_child_1", sessionID: "ses_run_child", seq: 1, timeCreated: 1500, tokens: { input: 40, output: 6 } })
      // Outside run 1's window: must not be counted in run 1.
      yield* insertAssistantMessage(db, { id: "msg_child_late", sessionID: "ses_run_child", seq: 2, timeCreated: 5000, tokens: { input: 999, output: 999 } })
      // The projector maintains session-row totals; mirror the final maintained state here.
      yield* db
        .update(SessionTable)
        .set({ tokens_input: 34, tokens_output: 6 })
        .where(eq(SessionTable.id, SessionV2.ID.make("ses_run_parent")))
        .run()
      yield* db
        .update(SessionTable)
        .set({ tokens_input: 1039, tokens_output: 1005 })
        .where(eq(SessionTable.id, SessionV2.ID.make("ses_run_child")))
        .run()

      // Run 2: still running, later window. The reused child is called again,
      // so its provenance part lives in run 2's own window.
      yield* insertActivity(db, { id: "act_2", sessionID: "ses_run_parent", opened: 20, timeCreated: 3000, timeUpdated: 3000 })
      yield* insertAssistantMessage(db, { id: "msg_run2", sessionID: "ses_run_parent", seq: 21, timeCreated: 3100, tokens: { input: 4, output: 1 } })
      yield* insertLegacyMessage(db, { id: "msg_run2", sessionID: "ses_run_parent", timeCreated: 3100 })
      yield* insertPart(db, { id: "prt_2", sessionID: "ses_run_parent", messageID: "msg_run2", childSessionID: "ses_run_child" })

      const run1 = yield* Database.Service.use(({ db: database }) =>
        SessionUsage.summarize(database, { sessionID: "ses_run_parent", activityID: "act_1" }),
      )
      expect(run1.activityID).toBe("act_1")
      expect(run1.run).not.toBeNull()
      expect(run1.run!.own.total).toBe(35)
      expect(run1.run!.descendants.total).toBe(46)
      expect(run1.run!.total.total).toBe(81)
      expect(run1.run!.running).toBe(false)
      expect(run1.run!.complete).toBe(true)

      const run2 = yield* Database.Service.use(({ db: database }) => SessionUsage.summarize(database, { sessionID: "ses_run_parent" }))
      expect(run2.activityID).toBe("act_2")
      expect(run2.run!.running).toBe(true)
      expect(run2.run!.own.total).toBe(5)
      // Reused child's late message lands in run 2, its early message stayed in run 1.
      expect(run2.run!.descendants.total).toBe(1998)
      // Session totals include every message exactly once regardless of run windows.
      expect(run2.session.total.total).toBe(35 + 46 + 1998 + 5)
    }),
  )

  it.effect("marks runs of sessions with unlinked descendants incomplete", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* insertProject(db)
      yield* insertSession(db, { id: "ses_orphan_parent", input: 1, output: 1 })
      yield* insertSession(db, { id: "ses_orphan_child", parentID: "ses_orphan_parent" })
      yield* insertActivity(db, { id: "act_orphan", sessionID: "ses_orphan_parent", opened: 10, closed: 11, timeCreated: 1000, timeUpdated: 2000 })
      yield* insertAssistantMessage(db, { id: "msg_orphan", sessionID: "ses_orphan_parent", seq: 11, timeCreated: 1100, tokens: { input: 1, output: 1 } })

      const summary = yield* Database.Service.use(({ db: database }) => SessionUsage.summarize(database, { sessionID: "ses_orphan_parent" }))
      expect(summary.run!.complete).toBe(false)
      expect(summary.run!.reason).toBeDefined()
      // Session totals stay exact even when run attribution is incomplete.
      expect(summary.session.total.total).toBe(2)
    }),
  )

  it.effect("attributes mixed task and fanout results without scanning unrelated message IDs", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* insertProject(db)
      yield* insertSession(db, { id: "ses_fanout_parent" })
      yield* insertSession(db, { id: "ses_fanout_child", parentID: "ses_fanout_parent" })
      yield* insertSession(db, { id: "ses_fanout_second", parentID: "ses_fanout_parent" })
      yield* insertSession(db, { id: "ses_fanout_unrelated" })
      yield* insertActivity(db, {
        id: "act_fanout",
        sessionID: "ses_fanout_parent",
        opened: 10,
        closed: 11,
        timeCreated: 1000,
        timeUpdated: 2000,
      })
      const fanout = {
        results: [
          { task: { sessionID: "ses_fanout_child" } },
          { task: { sessionID: "ses_fanout_second" } },
          { task: { sessionID: "ses_fanout_unrelated" } },
        ],
      }
      yield* insertAssistantMessage(db, {
        id: "msg_fanout",
        sessionID: "ses_fanout_parent",
        seq: 11,
        timeCreated: 1100,
        tokens: { input: 1, output: 1 },
        content: [
          { type: "text", text: "An unrelated ID: ses_fanout_unrelated" },
          {
            type: "tool",
            name: "task",
            state: { status: "completed", structured: { task_id: "ses_fanout_child" } },
          },
          { type: "tool", name: "multi_agent_fanout", state: { status: "completed", structured: fanout } },
        ],
      })
      yield* insertLegacyMessage(db, { id: "msg_fanout", sessionID: "ses_fanout_parent", timeCreated: 1100 })
      yield* db
        .insert(PartTable)
        .values({
          id: SessionV1.PartID.make("prt_fanout"),
          session_id: SessionV2.ID.make("ses_fanout_parent"),
          message_id: SessionV1.MessageID.make("msg_fanout"),
          time_created: 1100,
          time_updated: 1100,
          data: {
            type: "tool",
            callID: "call_fanout",
            tool: "multi_agent_fanout",
            state: { status: "completed", structured: fanout },
          },
        } as unknown as typeof PartTable.$inferInsert)
        .run()
      yield* insertAssistantMessage(db, {
        id: "msg_fanout_child",
        sessionID: "ses_fanout_child",
        seq: 1,
        timeCreated: 1300,
        tokens: { input: 10, output: 1 },
      })
      yield* insertAssistantMessage(db, {
        id: "msg_fanout_second",
        sessionID: "ses_fanout_second",
        seq: 1,
        timeCreated: 1400,
        tokens: { input: 20, output: 2 },
      })

      const summary = yield* Database.Service.use(({ db: database }) =>
        SessionUsage.summarize(database, { sessionID: "ses_fanout_parent" }),
      )
      expect(summary.run?.descendants.total).toBe(33)
      expect(summary.run?.complete).toBe(true)
      expect(summary.run?.attribution.status).toBe("complete")
    }),
  )

  it.effect("attributes legacy sessionId and externalized task/fanout provenance", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* insertProject(db)
      const parentID = "ses_external_provenance_parent"
      const taskID = "ses_external_provenance_task"
      const fanoutID = "ses_external_provenance_fanout"
      const legacyID = "ses_external_provenance_legacy"
      yield* insertSession(db, { id: parentID })
      yield* insertSession(db, { id: taskID, parentID })
      yield* insertSession(db, { id: fanoutID, parentID })
      yield* insertSession(db, { id: legacyID, parentID })
      yield* insertActivity(db, {
        id: "act_external_provenance",
        sessionID: parentID,
        opened: 10,
        closed: 11,
        timeCreated: 1000,
        timeUpdated: 2000,
      })
      const taskURI = "attachment://external-task"
      const fanoutURI = "attachment://external-fanout"
      yield* insertAssistantMessage(db, {
        id: "msg_external_provenance",
        sessionID: parentID,
        seq: 11,
        timeCreated: 1100,
        tokens: { input: 1, output: 1 },
        content: [
          {
            type: "tool",
            name: "task",
            state: {
              status: "completed",
              structured: { $opencode: { type: "content-reference", uri: taskURI, mime: "application/json" } },
            },
          },
          {
            type: "tool",
            name: "multi_agent_fanout",
            state: {
              status: "completed",
              structured: { $opencode: { type: "content-reference", uri: fanoutURI, mime: "application/json" } },
            },
          },
        ],
      })
      yield* insertLegacyMessage(db, { id: "msg_external_provenance", sessionID: parentID, timeCreated: 1100 })
      yield* db
        .insert(PartTable)
        .values({
          id: SessionV1.PartID.make("prt_legacy_session_id"),
          session_id: SessionV2.ID.make(parentID),
          message_id: SessionV1.MessageID.make("msg_external_provenance"),
          time_created: 1100,
          time_updated: 1100,
          data: {
            type: "tool",
            callID: "call_legacy_session_id",
            tool: "task",
            state: { status: "completed", metadata: { sessionId: legacyID } },
          },
        } as unknown as typeof PartTable.$inferInsert)
        .run()
      for (const [id, sessionID, input] of [
        ["msg_external_task", taskID, 10],
        ["msg_external_fanout", fanoutID, 20],
        ["msg_legacy_session_id", legacyID, 30],
      ] as const) {
        yield* insertAssistantMessage(db, { id, sessionID, seq: 1, timeCreated: 1200, tokens: { input, output: 0 } })
      }

      const unused = () => Effect.die(new Error("unused content-store method"))
      const contentStore = ContentStore.Service.of({
        putBlob: unused,
        locateBlob: unused,
        readBlob: unused,
        storeAttachment: unused,
        storeTextAttachment: unused,
        normalizePrompt: unused,
        normalizeFiles: unused,
        resolve: (input) =>
          Effect.succeed(
            input.sessionID !== parentID
              ? undefined
              : input.uri === taskURI
                ? {
                    id: "external-task",
                    sha256: "0".repeat(64),
                    mime: "application/json",
                    bytes: Buffer.from(JSON.stringify({ task_id: taskID })),
                  }
                : input.uri === fanoutURI
                  ? {
                      id: "external-fanout",
                      sha256: "1".repeat(64),
                      mime: "application/json",
                      bytes: Buffer.from(JSON.stringify({ results: [{ task: { sessionID: fanoutID } }] })),
                    }
                  : undefined,
          ),
        locate: unused,
        materialize: unused,
      })
      const summary = yield* SessionUsage.summarize(db, { sessionID: parentID }).pipe(
        Effect.provideService(ContentStore.Service, contentStore),
      )
      expect(summary.run?.descendants.total).toBe(60)
      expect(summary.run?.complete).toBe(true)
      expect(summary.run?.attribution.status).toBe("complete")
    }),
  )

  it.effect("bounds a recovered running Activity by its original start and current event sequence", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* insertProject(db)
      yield* insertSession(db, { id: "ses_recovered_usage" })
      yield* insertActivity(db, {
        id: "act_recovered_usage",
        sessionID: "ses_recovered_usage",
        opened: 20,
        timeCreated: 1000,
        timeUpdated: 3000,
        status: "recovering",
        recoveryAttempts: 1,
      })
      yield* db.insert(EventSequenceTable).values({ aggregate_id: "ses_recovered_usage", seq: 12 }).run()
      yield* db
        .insert(EventTable)
        .values({
          id: EventV2.ID.make("evt_recovered_usage_started"),
          aggregate_id: "ses_recovered_usage",
          seq: 10,
          type: EventV2.versionedType(SessionEvent.Activity.Started.type, 1),
          data: { sessionID: "ses_recovered_usage", activityID: "act_recovered_usage" },
        })
        .run()
      yield* insertAssistantMessage(db, {
        id: "msg_recovered_usage_before_start",
        sessionID: "ses_recovered_usage",
        seq: 8,
        timeCreated: 1100,
        tokens: { input: 999, output: 0 },
      })
      yield* insertAssistantMessage(db, {
        id: "msg_recovered_usage_inside_1",
        sessionID: "ses_recovered_usage",
        seq: 10,
        timeCreated: 1200,
        tokens: { input: 4, output: 0 },
      })
      yield* insertAssistantMessage(db, {
        id: "msg_recovered_usage_inside_2",
        sessionID: "ses_recovered_usage",
        seq: 12,
        timeCreated: 1300,
        tokens: { input: 6, output: 0 },
      })
      yield* insertAssistantMessage(db, {
        id: "msg_recovered_usage_after_snapshot",
        sessionID: "ses_recovered_usage",
        seq: 13,
        timeCreated: 1400,
        tokens: { input: 999, output: 0 },
      })

      const summary = yield* SessionUsage.summarize(db, { sessionID: "ses_recovered_usage" })
      expect(summary.sequence).toBe(12)
      expect(summary.run).toMatchObject({
        activityID: "act_recovered_usage",
        status: "recovering",
        running: true,
        timeStart: 1000,
        openedSeq: 9,
        own: { total: 10 },
      })
      expect(summary.run?.closedSeq).toBeUndefined()
    }),
  )

  it.effect("reports own provider streaming time for run windows and the session row", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* insertProject(db)
      yield* insertSession(db, { id: "ses_generation_time", generationMs: 1200 })
      yield* insertActivity(db, {
        id: "act_generation_time",
        sessionID: "ses_generation_time",
        opened: 10,
        closed: 11,
        timeCreated: 1000,
        timeUpdated: 2000,
      })
      yield* insertAssistantMessage(db, {
        id: "msg_generation_time",
        sessionID: "ses_generation_time",
        seq: 11,
        timeCreated: 1100,
        tokens: { input: 5, output: 4, reasoning: 2 },
        tokenMeasurement: {
          version: 1,
          inputTokens: 5,
          outputTokens: 6,
          reasoningTokens: 2,
          generationMilliseconds: 750,
        },
      })
      // A legacy step without the measurement contributes zero time, not unknown.
      yield* insertActivity(db, {
        id: "act_generation_time_legacy",
        sessionID: "ses_generation_time",
        opened: 20,
        closed: 21,
        timeCreated: 3000,
        timeUpdated: 4000,
      })
      yield* insertAssistantMessage(db, {
        id: "msg_generation_time_legacy",
        sessionID: "ses_generation_time",
        seq: 21,
        timeCreated: 3100,
        tokens: { input: 1, output: 1 },
      })

      const legacy = yield* Database.Service.use(({ db: database }) =>
        SessionUsage.summarize(database, { sessionID: "ses_generation_time", activityID: "act_generation_time_legacy" }),
      )
      expect(legacy.run?.generationMs).toBe(0)

      const summary = yield* Database.Service.use(({ db: database }) =>
        SessionUsage.summarize(database, { sessionID: "ses_generation_time", activityID: "act_generation_time" }),
      )
      expect(summary.run?.generationMs).toBe(750)
      expect(summary.session.generationMs).toBe(1200)

      // A tampered or degraded negative row clamps to zero instead of a negative rate.
      yield* db
        .update(SessionTable)
        .set({ generation_ms: -5 })
        .where(eq(SessionTable.id, SessionV2.ID.make("ses_generation_time")))
        .run()
      const clamped = yield* Database.Service.use(({ db: database }) =>
        SessionUsage.summarize(database, { sessionID: "ses_generation_time" }),
      )
      expect(clamped.session.generationMs).toBe(0)
    }),
  )

  it.effect("fails for unknown sessions and mismatched activities", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* insertProject(db)
      yield* insertSession(db, { id: "ses_known" })
      yield* insertActivity(db, { id: "act_known", sessionID: "ses_known", opened: 10, closed: 11, timeCreated: 1000, timeUpdated: 2000 })

      const missing = yield* Database.Service.use(({ db: database }) =>
        SessionUsage.summarize(database, { sessionID: "ses_missing" }).pipe(
          Effect.as(undefined),
          Effect.catch((error) => Effect.succeed(error._tag)),
        ),
      )
      expect(missing).toBe("SessionUsage.NotFound")

      const mismatch = yield* Database.Service.use(({ db: database }) =>
        SessionUsage.summarize(database, { sessionID: "ses_known", activityID: "act_unknown" }).pipe(
          Effect.as(undefined),
          Effect.catch((error) => Effect.succeed(error._tag)),
        ),
      )
      expect(mismatch).toBe("SessionUsage.ActivityMismatch")
    }),
  )

  it.effect("keeps a failed activity as the last run and preserves measured zero versus unknown", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* insertProject(db)
      yield* insertSession(db, { id: "ses_usage_measurement", input: 100, output: 50 })
      yield* insertActivity(db, {
        id: "act_usage_measurement",
        sessionID: "ses_usage_measurement",
        opened: 10,
        closed: 12,
        timeCreated: 1000,
        timeUpdated: 3000,
        status: "failed",
      })
      yield* insertAssistantMessage(db, {
        id: "msg_usage_measurement",
        sessionID: "ses_usage_measurement",
        seq: 11,
        timeCreated: 1500,
        tokens: { input: 0, output: 0 },
        tokenMeasurement: {
          version: 1,
          inputTokens: 0,
          outputTokens: 0,
          nonCachedInputTokens: 0,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 0,
          totalTokens: 0,
        },
      })
      const chain = {
        id: "chain_usage_test",
        name: "Reliable",
        steps: [
          { id: "gpt-test", providerID: "openai", variant: "high" },
          { id: "claude-test", providerID: "anthropic" },
        ],
        active: 0,
      }
      yield* db
        .insert(SessionInputTable)
        .values([{
          id: SessionMessage.ID.make("msg_usage_input"),
          session_id: SessionV2.ID.make("ses_usage_measurement"),
          prompt: {
            text: "test prompt",
            model: { id: "gpt-test", providerID: "openai", variant: "high", chain },
          } as unknown as typeof SessionInputTable.$inferInsert.prompt,
          delivery: "queue",
          admitted_seq: 10,
          promoted_seq: 11,
          time_created: 1000,
        }])
        .run()

      const summary = yield* SessionUsage.summarize(db, { sessionID: "ses_usage_measurement" })
      expect(summary.run).toMatchObject({
        activityID: "act_usage_measurement",
        status: "failed",
        running: false,
        timeStart: 1000,
        timeEnd: 3000,
        own: { total: 0 },
        measurement: {
          own: {
            categories: {
              input: { known: 0, complete: true },
              outputTotal: { known: 0, complete: true },
              reasoning: { complete: false },
              total: { known: 0, complete: true },
            },
          },
        },
        models: {
          selected: [{ model: { id: "gpt-test", providerID: "openai", variant: "high", chain }, source: "prompt", sequence: 11 }],
          observed: [{ model: { id: "gpt-6-astra", providerID: "openai" }, sequence: 11 }],
          complete: true,
        },
      })
      expect(summary.run?.measurement.own.complete).toBe(false)
      expect(summary.session.total.total).toBe(150)
      expect(summary.run?.total.total).not.toBe(summary.session.total.total)
    }),
  )

  it.effect("keeps empty descendant measurements neutral for unknown and legacy Run totals", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* insertProject(db)
      yield* insertSession(db, { id: "ses_unknown_measurement" })
      yield* insertActivity(db, {
        id: "act_unknown_measurement",
        sessionID: "ses_unknown_measurement",
        opened: 10,
        closed: 11,
        timeCreated: 1000,
        timeUpdated: 2000,
      })
      yield* insertAssistantMessage(db, {
        id: "msg_unknown_measurement",
        sessionID: "ses_unknown_measurement",
        seq: 11,
        timeCreated: 1100,
      })
      yield* insertSession(db, { id: "ses_legacy_measurement" })
      yield* insertActivity(db, {
        id: "act_legacy_measurement",
        sessionID: "ses_legacy_measurement",
        opened: 10,
        closed: 11,
        timeCreated: 1000,
        timeUpdated: 2000,
      })
      yield* insertAssistantMessage(db, {
        id: "msg_legacy_measurement",
        sessionID: "ses_legacy_measurement",
        seq: 11,
        timeCreated: 1100,
        tokens: { input: 30, output: 5 },
      })

      const unknown = yield* Database.Service.use(({ db: database }) =>
        SessionUsage.summarize(database, { sessionID: "ses_unknown_measurement" }),
      )
      expect(unknown.run?.measurement.total.categories.total).toMatchObject({ complete: false })
      expect(unknown.run?.measurement.total.categories.total).not.toHaveProperty("known")

      const legacy = yield* Database.Service.use(({ db: database }) =>
        SessionUsage.summarize(database, { sessionID: "ses_legacy_measurement" }),
      )
      expect(legacy.run?.total.total).toBe(35)
      expect(legacy.run?.measurement.total.categories.total).toMatchObject({ complete: false })
      expect(legacy.run?.measurement.total.categories.total).not.toHaveProperty("known")
    }),
  )
})
