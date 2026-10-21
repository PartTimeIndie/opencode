import { afterEach, describe, expect, mock } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Flag } from "@opencode-ai/core/flag/flag"
import { SyncPaths } from "../../src/server/routes/instance/httpapi/groups/sync"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { Session } from "@/session/session"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const originalWorkspaces = Flag.OPENCODE_EXPERIMENTAL_WORKSPACES
const context = Context.empty() as Context.Context<unknown>
const it = testEffect(Layer.mergeAll(Session.defaultLayer, httpApiLayer))
const checkpointEventsLayer = EventV2.defaultLayer
const checkpointProjectorLayer = SessionProjector.layer.pipe(
  Layer.provide(checkpointEventsLayer),
  Layer.provide(Database.defaultLayer),
)
const checkpointLayer = Layer.mergeAll(Database.defaultLayer, checkpointEventsLayer, checkpointProjectorLayer)

afterEach(async () => {
  mock.restore()
  Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = originalWorkspaces
  await disposeAllInstances()
  await resetDatabase()
})

describe("sync HttpApi", () => {
  it.instance(
    "serves sync routes",
    () =>
      Effect.gen(function* () {
        Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = true
        const tmp = yield* TestInstance
        const headers = { "x-opencode-directory": tmp.directory, "content-type": "application/json" }
        const title = `sync ${"large synchronized title ".repeat(400)}`
        const session = yield* Session.use.create({ title })

        const started = yield* requestInDirectory(SyncPaths.start, tmp.directory, { method: "POST", headers })
        expect(started.status).toBe(200)
        expect(yield* started.json).toBe(true)

        const history = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({}),
        })
        expect(history.status).toBe(200)
        const rows = (yield* history.json) as Array<{
          id: string
          aggregate_id: string
          seq: number
          type: string
          data: Record<string, unknown>
        }>
        expect(rows.map((row) => row.aggregate_id)).toContain(session.id)
        const created = rows.find((row) => row.aggregate_id === session.id)
        expect(created?.data).not.toHaveProperty("__opencode_event_data_encoding")
        expect((created?.data.info as { title?: string } | undefined)?.title).toBe(title)

        const checkpointHistory = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({ capability: EventV2.CheckpointCapability, cursors: {} }),
        })
        expect(checkpointHistory.status).toBe(200)
        const checkpointHistoryBody = (yield* checkpointHistory.json) as {
          capability: string
          aggregates: Array<{
            aggregateID: string
            checkpoint?: EventV2.SerializedCheckpoint
            events: unknown[]
          }>
        }
        expect(checkpointHistoryBody).toEqual({
          capability: EventV2.CheckpointCapability,
          aggregates: expect.arrayContaining([
            {
              aggregateID: session.id,
              checkpoint: expect.objectContaining({
                seq: expect.any(Number),
                baseline: expect.objectContaining({ adapter: "session-v2-projection" }),
              }),
              events: [],
            },
          ]),
        })
        const checkpoint = checkpointHistoryBody.aggregates.find(
          (aggregate) => aggregate.aggregateID === session.id,
        )?.checkpoint
        if (!checkpoint) return yield* Effect.die("Expected on-demand checkpoint baseline")
        expect(
          yield* Effect.gen(function* () {
            return yield* (yield* EventV2.Service).checkpoint(session.id)
          }).pipe(Effect.provide(checkpointLayer)),
        ).toMatchObject({ seq: checkpoint.seq, version: EventV2.CheckpointVersion })
        yield* Session.use.setTitle({ sessionID: session.id, title: "checkpoint tail" })
        const tailHistory = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({ capability: EventV2.CheckpointCapability, cursors: {} }),
        })
        expect(tailHistory.status).toBe(200)
        const tailHistoryBody = (yield* tailHistory.json) as typeof checkpointHistoryBody
        const tailAggregate = tailHistoryBody.aggregates.find((aggregate) => aggregate.aggregateID === session.id)
        expect(tailAggregate?.checkpoint?.seq).toBe(checkpoint.seq)
        expect(tailAggregate?.events).toEqual([
          expect.objectContaining({ aggregateID: session.id, seq: checkpoint.seq + 1 }),
        ])
        expect(tailAggregate?.events.every((event) => {
          if (typeof event !== "object" || event === null || !("seq" in event)) return false
          return typeof event.seq === "number" && event.seq > checkpoint.seq
        })).toBe(true)

        const checkpointReplay = yield* requestInDirectory(SyncPaths.replay, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({
            directory: tmp.directory,
            capability: EventV2.CheckpointCapability,
            checkpoint,
            events: [],
          }),
        })
        expect(checkpointReplay.status).toBe(200)
        expect(yield* checkpointReplay.json).toEqual({ sessionID: session.id })

        const replayed = yield* requestInDirectory(SyncPaths.replay, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({
            directory: tmp.directory,
            events: rows
              .filter((row) => row.aggregate_id === session.id)
              .map((row) => ({
                id: row.id,
                aggregateID: row.aggregate_id,
                seq: row.seq,
                type: row.type,
                data: row.data,
              })),
          }),
        })
        expect(replayed.status).toBe(200)
        expect(yield* replayed.json).toEqual({ sessionID: session.id })
      }),
    { git: true, config: { formatter: false, lsp: false } },
    { timeout: 15_000 },
  )

  it.instance(
    "ignores an eventless sequence row instead of returning a phantom aggregate",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        yield* Effect.gen(function* () {
          const { db } = yield* Database.Service
          yield* db
            .insert(EventSequenceTable)
            .values({ aggregate_id: "ses_eventless_sequence", seq: 0 })
            .run()
            .pipe(Effect.orDie)
        }).pipe(Effect.provide(Database.defaultLayer))
        const history = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers: { "x-opencode-directory": tmp.directory, "content-type": "application/json" },
          body: JSON.stringify({ capability: EventV2.CheckpointCapability, cursors: {} }),
        })

        expect(history.status).toBe(200)
        expect(yield* history.json).toEqual({ capability: EventV2.CheckpointCapability, aggregates: [] })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "validates seq values",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const headers = { "x-opencode-directory": tmp.directory, "content-type": "application/json" }
        const cases = [
          {
            path: SyncPaths.history,
            body: { aggregate: -1 },
          },
          {
            path: SyncPaths.history,
            body: { aggregate: 1.5 },
          },
          {
            path: SyncPaths.replay,
            body: {
              directory: tmp.directory,
              events: [{ id: "event", aggregateID: "session", seq: -1, type: "session.created", data: {} }],
            },
          },
          {
            path: SyncPaths.replay,
            body: {
              directory: tmp.directory,
              events: [{ id: "event", aggregateID: "session", seq: 1.5, type: "session.created", data: {} }],
            },
          },
          {
            path: SyncPaths.replay,
            body: {
              directory: tmp.directory,
              events: [{ id: "event", aggregateID: "session", seq: 0, type: "session.created", data: {} }],
            },
          },
        ]

        for (const item of cases) {
          const response = yield* requestInDirectory(item.path, tmp.directory, {
            method: "POST",
            headers,
            body: JSON.stringify(item.body),
          })
          expect(response.status).toBe(400)
        }
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves checkpoint baselines and rejects incomplete legacy history after compaction",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const headers = { "x-opencode-directory": tmp.directory, "content-type": "application/json" }
        const session = yield* Session.use.create({ title: "checkpoint source" })
        yield* Session.use.setTitle({ sessionID: session.id, title: "checkpoint updated" })
        const compacted = yield* Effect.gen(function* () {
          const events = yield* EventV2.Service
          return yield* events.compactCheckpoint(session.id)
        }).pipe(Effect.provide(checkpointLayer))
        expect(compacted?.checkpoint.seq).toBeGreaterThan(0)

        const legacy = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({}),
        })
        expect(legacy.status).toBe(409)
        expect(yield* legacy.json).toMatchObject({
          name: "SyncUpgradeRequiredError",
          data: {
            requiredCapability: EventV2.CheckpointCapability,
            reason: "checkpoint_capability_required",
          },
        })

        const capable = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({ capability: EventV2.CheckpointCapability, cursors: {} }),
        })
        expect(capable.status).toBe(200)
        const history = (yield* capable.json) as {
          capability: string
          aggregates: Array<{
            aggregateID: string
            checkpoint?: { seq: number; compactedSeq?: number; baseline: unknown }
            events: unknown[]
          }>
        }
        expect(history.capability).toBe(EventV2.CheckpointCapability)
        expect(history.aggregates.find((aggregate) => aggregate.aggregateID === session.id)).toMatchObject({
          aggregateID: session.id,
          checkpoint: {
            seq: compacted?.checkpoint.seq,
            compactedSeq: compacted?.checkpoint.seq,
            baseline: expect.any(Object),
          },
          events: [],
        })

        const behind = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({ capability: EventV2.CheckpointCapability, cursors: { [session.id]: 0 } }),
        })
        expect(behind.status).toBe(409)
        expect(yield* behind.json).toMatchObject({
          name: "SyncUpgradeRequiredError",
          data: { reason: "checkpoint_reset_required" },
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
    { timeout: 15_000 },
  )

  it.instance(
    "rejects inline data URLs before history export or replay persistence",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const headers = { "x-opencode-directory": tmp.directory, "content-type": "application/json" }
        const storedID = EventV2.ID.create()
        const storedAggregateID = "ses_inline_history"
        yield* Effect.gen(function* () {
          const { db } = yield* Database.Service
          yield* db
            .insert(EventSequenceTable)
            .values({ aggregate_id: storedAggregateID, seq: 1 })
            .run()
            .pipe(Effect.orDie)
          yield* db
            .insert(EventTable)
            .values({
              id: storedID,
              aggregate_id: storedAggregateID,
              seq: 1,
              type: "sync.inline.1",
              data: { nested: { image: "data:image/png;base64,aW5saW5l" } },
            })
            .run()
            .pipe(Effect.orDie)
        }).pipe(Effect.provide(Database.defaultLayer))

        const history = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({}),
        })
        expect(history.status).toBe(409)
        expect(yield* history.json).toMatchObject({
          name: "SyncUpgradeRequiredError",
          data: { reason: "content_externalization_required" },
        })

        const replayID = EventV2.ID.create()
        const replay = yield* requestInDirectory(SyncPaths.replay, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({
            directory: tmp.directory,
            events: [
              {
                id: replayID,
                aggregateID: "ses_inline_replay",
                seq: 1,
                type: "sync.inline.1",
                data: { attachment: "data:application/octet-stream;base64,aW5saW5l" },
              },
            ],
          }),
        })
        expect(replay.status).toBe(409)
        expect(yield* replay.json).toMatchObject({
          name: "SyncUpgradeRequiredError",
          data: { reason: "content_externalization_required" },
        })
        const persisted = yield* Effect.gen(function* () {
          const { db } = yield* Database.Service
          return yield* db.select().from(EventTable).where(eq(EventTable.id, replayID)).all().pipe(Effect.orDie)
        }).pipe(Effect.provide(Database.defaultLayer))
        expect(persisted).toEqual([])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "requires older and unknown checkpoint clients to upgrade",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const headers = { "x-opencode-directory": tmp.directory, "content-type": "application/json" }
        const history = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({ capability: "event-checkpoint-v999", cursors: {} }),
        })
        const replay = yield* requestInDirectory(SyncPaths.replay, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({
            directory: tmp.directory,
            capability: "event-checkpoint-v999",
            checkpoint: { aggregateID: "session", seq: 0, version: 3, baseline: {} },
            events: [],
          }),
        })
        const legacy = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({ capability: EventV2.LegacyCheckpointCapability, cursors: {} }),
        })
        const previous = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({ capability: EventV2.PreviousCheckpointCapability, cursors: {} }),
        })

        expect(history.status).toBe(409)
        expect(yield* history.json).toMatchObject({
          name: "SyncUpgradeRequiredError",
          data: {
            requiredCapability: EventV2.CheckpointCapability,
            reason: "checkpoint_upgrade_required",
          },
        })
        expect(replay.status).toBe(409)
        expect(yield* replay.json).toMatchObject({
          name: "SyncUpgradeRequiredError",
          data: {
            requiredCapability: EventV2.CheckpointCapability,
            reason: "checkpoint_upgrade_required",
          },
        })
        expect(legacy.status).toBe(409)
        expect(yield* legacy.json).toMatchObject({ data: { reason: "checkpoint_upgrade_required" } })
        expect(previous.status).toBe(409)
        expect(yield* previous.json).toMatchObject({
          data: {
            requiredCapability: EventV2.CheckpointCapability,
            reason: "checkpoint_upgrade_required",
          },
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance.skip(
    "returns structured validation errors",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const response = yield* Effect.promise(() =>
          HttpApiApp.webHandler().handler(
            new Request(`http://localhost${SyncPaths.history}`, {
              method: "POST",
              headers: { "x-opencode-directory": tmp.directory, "content-type": "application/json" },
              body: JSON.stringify({ aggregate: -1 }),
            }),
            context,
          ),
        )

        expect(response.status).toBe(400)
        expect(response.headers.get("content-type") ?? "").toContain("application/json")
        const body = (yield* Effect.promise(() => response.json())) as Record<string, unknown>
        expect(body.success).toBe(false)
        expect(Array.isArray(body.error) || Array.isArray(body.errors)).toBe(true)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
