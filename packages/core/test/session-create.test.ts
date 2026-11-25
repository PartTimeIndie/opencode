import { describe, expect } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { DateTime, Effect, Exit, Layer, Stream } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { asc, eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventCheckpointTable, EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { ContentStore } from "@opencode-ai/core/content-store"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionEvent } from "@opencode-ai/core/session/event"
import {
  MessageTable,
  PartTable,
  SessionContextEpochTable,
  SessionInputTable,
  SessionMessageTable,
  SessionTable,
} from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)
const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
const store = SessionStore.layer.pipe(Layer.provide(database))
const sessions = SessionV2.layer.pipe(
  Layer.provide(ContentStore.defaultLayer),
  Layer.provide(events),
  Layer.provide(database),
  Layer.provide(store),
  Layer.provide(projects),
  Layer.provide(Snapshot.defaultLayer),
  Layer.provide(SessionExecution.noopLayer),
)
const handoffAgentItems = [
  new AgentV2.Info({ ...AgentV2.Info.empty(AgentV2.ID.make("build")), mode: "primary" }),
  new AgentV2.Info({ ...AgentV2.Info.empty(AgentV2.ID.make("implement")), mode: "primary" }),
  new AgentV2.Info({ ...AgentV2.Info.empty(AgentV2.ID.make("hidden")), mode: "primary", hidden: true }),
  new AgentV2.Info({ ...AgentV2.Info.empty(AgentV2.ID.make("worker")), mode: "subagent" }),
]
const handoffAgentMap = new Map(handoffAgentItems.map((item) => [item.id, item]))
const handoffAgents = Layer.succeed(
  AgentV2.Service,
  AgentV2.Service.of({
    transform: () => Effect.die("unused"),
    update: () => Effect.die("unused"),
    get: (id) => Effect.succeed(handoffAgentMap.get(id)),
    default: () => Effect.succeed(handoffAgentMap.get(AgentV2.ID.make("build"))),
    resolve: (id) => Effect.succeed(handoffAgentMap.get(AgentV2.ID.make(id ?? "build"))),
    select: (id) => {
      const selected = AgentV2.ID.make(id ?? "build")
      return Effect.succeed({ id: selected, info: handoffAgentMap.get(selected) })
    },
    all: () => Effect.succeed(handoffAgentItems),
  }),
)
const handoffModels = SessionRunnerModel.layerWith((session) =>
  session.model?.providerID === ProviderV2.ID.make("test") &&
  [ModelV2.ID.make("valid-model"), ModelV2.ID.make("agent-model")].includes(session.model.id)
    ? Effect.succeed({} as never)
    : Effect.fail(new SessionRunnerModel.ModelNotSelectedError({ sessionID: session.id })),
)
const handoffLocationServices = Layer.merge(handoffAgents, handoffModels)
const handoffLocations = Layer.succeed(
  LocationServiceMap,
  LocationServiceMap.of({
    bindExecution: () => Effect.void,
    get: () => handoffLocationServices as never,
    invalidate: () => Effect.void,
  }),
)
const handoffSessions = SessionV2.layer.pipe(
  Layer.provide(ContentStore.defaultLayer),
  Layer.provide(events),
  Layer.provide(database),
  Layer.provide(store),
  Layer.provide(projects),
  Layer.provide(Snapshot.defaultLayer),
  Layer.provide(SessionExecution.noopLayer),
  Layer.provide(handoffLocations),
)
const it = testEffect(
  Layer.mergeAll(
    database,
    events,
    projects,
    projector,
    store,
    Snapshot.defaultLayer,
    SessionExecution.noopLayer,
    sessions,
  ),
)
const handoffIt = testEffect(
  Layer.mergeAll(
    database,
    events,
    projects,
    projector,
    store,
    Snapshot.defaultLayer,
    SessionExecution.noopLayer,
    handoffLocations,
    handoffSessions,
  ),
)

const switchLifecycle: string[] = []
const switchExecution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    resume: () => Effect.die("unused"),
    resumeOrJoin: () => Effect.die("unused"),
    wake: () => Effect.die("unused"),
    queueContinuation: () => Effect.die("unused"),
    interrupt: () => Effect.sync(() => switchLifecycle.push("interrupt")),
    interruptActivity: () => Effect.die("unused"),
    wait: () => Effect.sync(() => switchLifecycle.push("wait")),
    cancelTool: () => Effect.die("unused"),
  }),
)
const switchSessions = SessionV2.layer.pipe(
  Layer.provide(ContentStore.defaultLayer),
  Layer.provide(events),
  Layer.provide(database),
  Layer.provide(store),
  Layer.provide(projects),
  Layer.provide(Snapshot.defaultLayer),
  Layer.provide(switchExecution),
)
const switchIt = testEffect(
  Layer.mergeAll(database, events, projects, projector, store, Snapshot.defaultLayer, switchExecution, switchSessions),
)
const identicalSnapshotCalls = {
  track: 0,
  changedFiles: 0,
  patch: 0,
  reverted: [] as Snapshot.RevertPatch[][],
}
const identicalSnapshots = Layer.succeed(
  Snapshot.Service,
  Snapshot.Service.of({
    track: () =>
      Effect.sync(() => {
        identicalSnapshotCalls.track++
        return "rollback-snapshot"
      }),
    changedFiles: () =>
      Effect.sync(() => {
        identicalSnapshotCalls.changedFiles++
        return []
      }),
    patch: (input) =>
      Effect.sync(() => {
        identicalSnapshotCalls.patch++
        return { hash: input.hash, files: [] }
      }),
    restore: () => Effect.void,
    revert: (input) =>
      Effect.sync(() => {
        identicalSnapshotCalls.reverted.push([...input.patches])
      }),
    diff: () => Effect.succeed(undefined),
    diffFull: () => Effect.succeed([]),
  }),
)
const identicalSnapshotSessions = SessionV2.layer.pipe(
  Layer.provide(ContentStore.defaultLayer),
  Layer.provide(events),
  Layer.provide(database),
  Layer.provide(store),
  Layer.provide(projects),
  Layer.provide(identicalSnapshots),
  Layer.provide(SessionExecution.noopLayer),
)
const identicalSnapshotIt = testEffect(
  Layer.mergeAll(
    database,
    events,
    projects,
    projector,
    store,
    identicalSnapshots,
    SessionExecution.noopLayer,
    identicalSnapshotSessions,
  ),
)
const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const id = SessionV2.ID.create()

function checkpointWithBaseline(checkpoint: EventV2.SerializedCheckpoint, baseline: EventV2.CheckpointBaseline) {
  const stored = EventV2.decodeStoredEventData(EventV2.replaceStoredCheckpointBaseline({}, baseline))
  if (typeof stored.baselineHash !== "string") throw new Error("Checkpoint baseline hash is missing")
  return { ...checkpoint, baseline, baselineHash: stored.baselineHash }
}

describe("SessionV2.create", () => {
  it.effect("persists creation metadata and permission defaults", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const metadata = { access_control: { mode: "approve_for_me" } }
      const permission = [{ permission: "edit", pattern: "*", action: "deny" as const }]

      const created = yield* session.create({ location, metadata, permission })
      const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, created.id)).get()

      expect(created.metadata).toEqual(metadata)
      expect(row?.metadata).toEqual(metadata)
      expect(row?.permission).toEqual(permission)
    }),
  )

  identicalSnapshotIt.effect("does not infer ownership from identical snapshot boundaries", () =>
    Effect.gen(function* () {
      identicalSnapshotCalls.track = 0
      identicalSnapshotCalls.changedFiles = 0
      identicalSnapshotCalls.patch = 0
      identicalSnapshotCalls.reverted.length = 0
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location })
      const userID = SessionMessage.ID.create()
      const assistantID = SessionMessage.ID.create()
      const model = ModelV2.Ref.make({ id: ModelV2.ID.make("sonnet"), providerID: ProviderV2.ID.anthropic })

      yield* session.prompt({
        id: userID,
        sessionID: created.id,
        prompt: new Prompt({ text: "make no workspace changes" }),
        resume: false,
      })
      yield* SessionInput.promoteSteers(db, events, created.id, Number.MAX_SAFE_INTEGER)
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID: created.id,
        assistantMessageID: assistantID,
        timestamp: yield* DateTime.now,
        agent: "build",
        model,
        snapshot: "unchanged-snapshot",
      })
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID: created.id,
        assistantMessageID: assistantID,
        timestamp: yield* DateTime.now,
        finish: "stop",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        snapshot: "unchanged-snapshot",
      })

      expect(yield* session.messages({ sessionID: created.id })).toHaveLength(2)
      const rolledBack = yield* session.rollback({ sessionID: created.id, messageID: assistantID })

      expect(rolledBack.revert).toMatchObject({ messageID: userID, status: "blocked", blockedReason: "unattributed" })
      expect(identicalSnapshotCalls).toMatchObject({ track: 0, changedFiles: 0, patch: 0, reverted: [] })
      expect((yield* session.get(created.id)).revert?.blockedReason).toBe("unattributed")
      expect(yield* session.messages({ sessionID: created.id })).toHaveLength(2)
    }),
  )

  it.effect("restores legacy checkpoint rows in bounded SQLite batches", () =>
    Effect.gen(function* () {
      const bulkSessionID = SessionV2.ID.make("ses_checkpoint_bulk_restore")
      const bulkMessageID = SessionV1.MessageID.make("msg_checkpoint_bulk_restore")
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const baseline = {
        adapter: SessionProjector.CheckpointAdapterID,
        version: 2,
        data: {
          session: {
            id: bulkSessionID,
            project_id: ProjectV2.ID.global,
            slug: "bulk-restore",
            directory: "/project",
            title: "bulk restore",
            version: "test",
            cost: 0,
            tokens_input: 0,
            tokens_output: 0,
            tokens_reasoning: 0,
            tokens_cache_read: 0,
            tokens_cache_write: 0,
            time_created: 0,
            time_updated: 0,
          },
          legacyMessages: [
            {
              id: bulkMessageID,
              session_id: bulkSessionID,
              time_created: 0,
              time_updated: 0,
              data: {
                role: "user",
                time: { created: 0 },
                agent: "build",
                model: { providerID: ProviderV2.ID.make("provider"), modelID: ModelV2.ID.make("model") },
              },
            },
          ],
          legacyParts: Array.from({ length: 6_000 }, (_, index) => ({
            id: SessionV1.PartID.make(`prt_checkpoint_bulk_restore_${index}`),
            message_id: bulkMessageID,
            session_id: bulkSessionID,
            time_created: index,
            time_updated: index,
            data: { type: "step-start", snapshot: `snapshot-${index}` },
          })),
          messages: [],
          inputs: [],
        },
      } satisfies EventV2.CheckpointBaseline
      const checkpoint = checkpointWithBaseline(
        {
          aggregateID: bulkSessionID,
          seq: 0,
          version: EventV2.CheckpointVersion,
          baseline,
          baselineHash: "",
          eventHash: "bulk-restore",
        },
        baseline,
      )
      const events = yield* EventV2.Service
      yield* events.replayCheckpoint(checkpoint)

      expect(yield* db.$count(PartTable, eq(PartTable.session_id, bulkSessionID)).pipe(Effect.orDie)).toBe(6_000)
      const stored = yield* events.checkpoint(bulkSessionID)
      if (!stored || stored.version !== EventV2.CheckpointVersion)
        return yield* Effect.die("Bulk checkpoint is missing")
      expect(stored.baseline.version).toBe(SessionProjector.CheckpointAdapterVersion)
    }),
  )

  it.effect("derives stable namespaced external IDs", () =>
    Effect.sync(() => {
      const input = { namespace: "opencord.agent-thread", key: "thread-1" }

      expect(SessionV2.ID.fromExternal(input)).toBe(SessionV2.ID.fromExternal(input))
      expect(SessionV2.ID.fromExternal(input)).toMatch(/^ses_[a-f0-9]{64}$/)
      expect(SessionV2.ID.fromExternal({ ...input, namespace: "another-app" })).not.toBe(
        SessionV2.ID.fromExternal(input),
      )
      expect(SessionV2.ID.fromExternal({ namespace: "a:b", key: "c" })).not.toBe(
        SessionV2.ID.fromExternal({ namespace: "a", key: "b:c" }),
      )
    }),
  )

  it.effect("creates a fresh projected session when the ID is omitted", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service

      const first = yield* session.create({ location })
      const second = yield* session.create({ location })

      expect(second.id).not.toBe(first.id)
      expect(yield* session.list()).toHaveLength(2)
    }),
  )

  it.effect("excludes hidden sessions from list by default", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const hidden = yield* session.create({ id: SessionV2.ID.make("ses_hidden_v2"), location })
      const visible = yield* session.create({ id: SessionV2.ID.make("ses_visible_v2"), location })

      yield* db
        .update(SessionTable)
        .set({ metadata: { opencode: { hidden: true } } })
        .where(eq(SessionTable.id, hidden.id))
        .run()
        .pipe(Effect.orDie)

      expect((yield* session.list()).map((item) => item.id)).toEqual([visible.id])
      expect((yield* session.get(hidden.id)).id).toBe(hidden.id)
      expect((yield* session.list({ includeHidden: true })).map((item) => item.id)).toContain(hidden.id)
    }),
  )

  it.effect("returns the original session when the ID is retried", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const input = { id, location }

      const first = yield* session.create(input)
      const retried = yield* session.create(input)

      expect(retried).toEqual(first)
      expect(yield* session.list()).toEqual([first])
    }),
  )

  it.effect("stores supplied immutable create attributes", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const workspaceID = WorkspaceV2.ID.make("wrk_test")
      const model = ModelV2.Ref.make({
        id: ModelV2.ID.make("sonnet"),
        providerID: ProviderV2.ID.anthropic,
        variant: ModelV2.VariantID.make("fast"),
      })

      expect(
        yield* session.create({
          location: Location.Ref.make({ directory: location.directory, workspaceID }),
          parentID: SessionV2.ID.make("ses_parent_create"),
          title: "Child task",
          agent: AgentV2.ID.make("build"),
          model,
        }),
      ).toMatchObject({
        location: { directory: location.directory, workspaceID },
        parentID: "ses_parent_create",
        title: "Child task",
        agent: "build",
        model,
      })
    }),
  )

  it.effect("returns the existing Session when one ID is reused with different create arguments", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ id, location })
      const changed = [
        { id, location: Location.Ref.make({ directory: AbsolutePath.make("/other") }) },
        { id, location, agent: AgentV2.ID.make("build") },
        {
          id,
          location,
          model: ModelV2.Ref.make({ id: ModelV2.ID.make("sonnet"), providerID: ProviderV2.ID.anthropic }),
        },
      ]

      for (const input of changed) {
        expect(yield* session.create(input)).toEqual(created)
      }
      expect(yield* session.list()).toHaveLength(1)
    }),
  )

  it.effect("returns one recorded session to concurrent exact retries", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const input = { id, location }

      const created = yield* Effect.all([session.create(input), session.create(input)], { concurrency: "unbounded" })

      expect(created[1]).toEqual(created[0])
      expect(yield* session.list()).toEqual([created[0]])
    }),
  )

  it.effect("returns the current Session projection after updates", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const input = { id, location }
      const created = yield* session.create(input)

      yield* db.update(SessionTable).set({ agent: "build" }).where(eq(SessionTable.id, id)).run().pipe(Effect.orDie)

      expect(yield* session.create(input)).toMatchObject({ id: created.id, agent: "build" })
    }),
  )

  it.effect("projects stored revert state into public info", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ id, location })
      const revert = {
        messageID: SessionV1.MessageID.ascending("msg_revert_marker"),
        partID: SessionV1.PartID.ascending("prt_revert_marker"),
        snapshot: "snapshot",
        diff: "diff",
      }

      yield* db.update(SessionTable).set({ revert }).where(eq(SessionTable.id, id)).run().pipe(Effect.orDie)

      expect(yield* session.get(created.id)).toMatchObject({ id: created.id, revert })
      expect(yield* session.list()).toMatchObject([{ id: created.id, revert }])
    }),
  )

  it.effect("blocks unrevert of legacy state without a recorded file action", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location })
      yield* db
        .update(SessionTable)
        .set({
          revert: {
            messageID: SessionV1.MessageID.ascending("msg_legacy_unrevert"),
            status: "reverted",
            snapshot: "legacy",
          },
        })
        .where(eq(SessionTable.id, created.id))
        .run()
        .pipe(Effect.orDie)

      expect((yield* session.unrevert({ sessionID: created.id })).revert).toMatchObject({
        status: "blocked",
        blockedReason: "unattributed",
      })
    }),
  )

  it.effect("preserves a blocked revert instead of clearing it on unrevert", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location })
      yield* db.update(SessionTable).set({ revert: { messageID: SessionV1.MessageID.ascending("msg_blocked_unrevert"), status: "blocked", blockedReason: "conflict" } }).where(eq(SessionTable.id, created.id)).run().pipe(Effect.orDie)

      expect((yield* session.unrevert({ sessionID: created.id })).revert).toMatchObject({ status: "blocked", blockedReason: "conflict" })
    }),
  )

  it.effect("keeps an applied messages-only revert on a repeated request", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location })
      const messageID = SessionMessage.ID.create()
      yield* session.prompt({ id: messageID, sessionID: created.id, prompt: new Prompt({ text: "retain file changes" }), resume: false })
      yield* SessionInput.promoteSteers(db, events, created.id, Number.MAX_SAFE_INTEGER)

      const first = yield* session.revert({ sessionID: created.id, messageID, files: "messages_only" })
      expect((yield* session.revert({ sessionID: created.id, messageID })).revert).toEqual(first.revert)
      expect((yield* session.unrevert({ sessionID: created.id })).revert).toBeUndefined()
    }),
  )

  it.effect("updates title, share, and summary through durable Session events", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ id, location })
      const summary = {
        additions: 3,
        deletions: 1,
        files: 2,
        diffs: [{ file: "src/app.ts", additions: 3, deletions: 1, status: "modified" as const }],
      }

      yield* session.setTitle({ sessionID: created.id, title: "Updated title" })
      yield* session.setShare({ sessionID: created.id, share: { url: "https://share.example.test/session" } })
      yield* session.setSummary({ sessionID: created.id, summary })

      expect(yield* session.get(created.id)).toMatchObject({
        title: "Updated title",
        share: { url: "https://share.example.test/session" },
        summary,
      })
      expect(
        Array.from(yield* session.events({ sessionID: created.id }).pipe(Stream.take(3), Stream.runCollect)).map(
          (event) => event.event.type,
        ),
      ).toEqual(["session.next.title.updated", "session.next.share.updated", "session.next.summary.updated"])

      yield* session.setShare({ sessionID: created.id })
      yield* session.setSummary({ sessionID: created.id })
      expect(yield* session.get(created.id)).toMatchObject({ title: "Updated title" })
      expect((yield* session.get(created.id)).share).toBeUndefined()
      expect((yield* session.get(created.id)).summary).toBeUndefined()
    }),
  )

  it.effect("compacts a verified V2 projection baseline and restores it with an unrenumbered tail", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ id: SessionV2.ID.make("ses_projection_checkpoint"), location })
      yield* session.setTitle({ sessionID: created.id, title: "checkpoint title" })
      yield* session.prompt({
        id: SessionMessage.ID.make("msg_checkpoint_input"),
        sessionID: created.id,
        prompt: new Prompt({ text: "durable input" }),
        resume: false,
      })
      yield* events.publish(SessionV1.Event.MessageUpdated, {
        sessionID: created.id,
        info: {
          id: SessionV1.MessageID.make("msg_checkpoint_legacy"),
          sessionID: created.id,
          role: "user",
          time: { created: 1 },
          agent: "build",
          model: { providerID: ProviderV2.ID.anthropic, modelID: ModelV2.ID.make("sonnet") },
        },
      })
      yield* events.publish(SessionV1.Event.PartUpdated, {
        sessionID: created.id,
        part: {
          id: SessionV1.PartID.make("prt_checkpoint_legacy"),
          sessionID: created.id,
          messageID: SessionV1.MessageID.make("msg_checkpoint_legacy"),
          type: "text",
          text: "legacy checkpoint payload",
        },
        time: 2,
      })

      yield* db
        .update(SessionTable)
        .set({ title: "not produced by replay" })
        .where(eq(SessionTable.id, created.id))
        .run()
      const rejected = yield* events.compactCheckpoint(created.id).pipe(Effect.exit)
      expect(String(rejected)).toContain("Fresh replay projection parity failed")
      expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, created.id)).all()).not.toHaveLength(
        0,
      )

      yield* session.setTitle({ sessionID: created.id, title: "checkpoint title" })
      const legacyMessages = yield* db.select().from(MessageTable).where(eq(MessageTable.session_id, created.id)).all()
      const legacyParts = yield* db.select().from(PartTable).where(eq(PartTable.session_id, created.id)).all()
      const messages = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, created.id))
        .orderBy(SessionMessageTable.seq)
        .all()
      const compacted = yield* events.compactCheckpoint(created.id)
      if (!compacted) return yield* Effect.die("Expected session projection checkpoint")
      expect(compacted.deleted).toBeGreaterThan(0)
      expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, created.id)).all()).toHaveLength(0)
      const stored = yield* db
        .select()
        .from(EventCheckpointTable)
        .where(eq(EventCheckpointTable.aggregate_id, created.id))
        .get()
        .pipe(Effect.orDie)
      expect(stored?.version).toBe(EventV2.CheckpointVersion)
      expect(JSON.stringify(stored?.data)).not.toContain('"events"')
      expect(compacted.checkpoint.baseline).toMatchObject({
        adapter: "session-v2-projection",
        version: SessionProjector.CheckpointAdapterVersion,
      })
      const normalized = EventV2.readStoredCheckpointBaseline(stored!.data)
      expect(normalized.data).toMatchObject({
        legacyMessages: [],
        legacyParts: [],
        messages: [],
        legacyProjectionReference: {
          checkpointSeq: compacted.checkpoint.seq,
          legacyMessageCount: legacyMessages.length,
          legacyPartCount: legacyParts.length,
          messageCount: messages.length,
        },
      })
      const reference = normalized.data.legacyProjectionReference as Record<string, unknown>
      yield* db
        .update(EventCheckpointTable)
        .set({
          data: EventV2.replaceStoredCheckpointBaseline(stored!.data, {
            ...normalized,
            data: {
              ...normalized.data,
              legacyProjectionReference: { ...reference, projectionHash: "0".repeat(64) },
            },
          }),
        })
        .where(eq(EventCheckpointTable.aggregate_id, created.id))
        .run()
        .pipe(Effect.orDie)
      expect(String(yield* events.checkpoint(created.id).pipe(Effect.exit))).toContain(
        "active checkpoint projection reference hash or counts differ",
      )
      yield* db
        .update(EventCheckpointTable)
        .set({ data: stored!.data })
        .where(eq(EventCheckpointTable.aggregate_id, created.id))
        .run()
        .pipe(Effect.orDie)
      yield* db
        .update(EventSequenceTable)
        .set({ seq: compacted.checkpoint.seq + 1 })
        .where(eq(EventSequenceTable.aggregate_id, created.id))
        .run()
        .pipe(Effect.orDie)
      expect(String(yield* events.checkpoint(created.id).pipe(Effect.exit))).toContain(
        "active projection reference sequence differs",
      )
      yield* db
        .update(EventSequenceTable)
        .set({ seq: compacted.checkpoint.seq })
        .where(eq(EventSequenceTable.aggregate_id, created.id))
        .run()
        .pipe(Effect.orDie)
      const hydrated = yield* events.checkpoint(created.id)
      if (!hydrated || hydrated.version !== EventV2.CheckpointVersion)
        return yield* Effect.die("Hydrated checkpoint is missing")
      expect(hydrated.baseline.data.legacyMessages).toEqual(legacyMessages)
      expect(hydrated.baseline.data.legacyParts).toEqual(legacyParts)
      expect(hydrated.baseline.data.messages).toEqual(messages)
      expect(hydrated.baseline.data.legacyProjectionReference).toBeUndefined()
      yield* events.replayCheckpoint(hydrated)
      const afterIdempotentReplay = yield* db
        .select({ data: EventCheckpointTable.data })
        .from(EventCheckpointTable)
        .where(eq(EventCheckpointTable.aggregate_id, created.id))
        .get()
        .pipe(Effect.orDie)
      expect(EventV2.readStoredCheckpointBaseline(afterIdempotentReplay!.data).data).toMatchObject({
        legacyMessages: [],
        legacyParts: [],
        messages: [],
        legacyProjectionReference: expect.objectContaining({ checkpointSeq: compacted.checkpoint.seq }),
      })
      yield* Effect.all(
        [SessionProjector.materializeActiveCheckpoint(db, created.id), events.compactCheckpoint(created.id)],
        { concurrency: "unbounded" },
      )
      expect((yield* events.checkpoint(created.id))?.seq).toBe(compacted.checkpoint.seq)
      yield* SessionProjector.verifyProjectionInFreshRuntime({
        aggregateID: created.id,
        expected: compacted.checkpoint.baseline,
        previous: {
          adapter: "session-v2-projection",
          version: 1,
          data: Object.fromEntries(
            Object.entries(compacted.checkpoint.baseline.data).filter(
              ([key]) => !["legacyMessages", "legacyParts"].includes(key),
            ),
          ),
        },
        previousSeq: compacted.checkpoint.seq,
        events: [],
      })

      yield* session.setTitle({ sessionID: created.id, title: "tail title" })
      const materialized = yield* db
        .select({ data: EventCheckpointTable.data })
        .from(EventCheckpointTable)
        .where(eq(EventCheckpointTable.aggregate_id, created.id))
        .get()
        .pipe(Effect.orDie)
      const materializedBaseline = EventV2.readStoredCheckpointBaseline(materialized!.data)
      expect(materializedBaseline.data.legacyMessages).toEqual(legacyMessages)
      expect(materializedBaseline.data.legacyParts).toEqual(legacyParts)
      expect(materializedBaseline.data.messages).toEqual(messages)
      expect(materializedBaseline.data.legacyProjectionReference).toBeUndefined()
      const tail = (yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, created.id))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)).map((event) => ({
        id: event.id,
        aggregateID: event.aggregate_id,
        seq: event.seq,
        type: event.type,
        data: EventV2.decodeStoredEventData(event.data),
      }))
      expect(tail.map((event) => event.seq)).toEqual([compacted.checkpoint.seq + 1])

      const compatible = [
        {
          version: 1,
          data: Object.fromEntries(
            Object.entries(compacted.checkpoint.baseline.data).filter(
              ([key]) => !["legacyMessages", "legacyParts", "legacyCheckpointOnly"].includes(key),
            ),
          ),
          legacy: false,
        },
        {
          version: 2,
          data: Object.fromEntries(
            Object.entries(compacted.checkpoint.baseline.data).filter(([key]) => key !== "legacyCheckpointOnly"),
          ),
          legacy: true,
        },
      ]
      for (const item of compatible) {
        const checkpoint = checkpointWithBaseline(compacted.checkpoint, {
          adapter: SessionProjector.CheckpointAdapterID,
          version: item.version,
          data: item.data,
        })
        yield* events.remove(created.id)
        yield* db.delete(SessionTable).where(eq(SessionTable.id, created.id)).run().pipe(Effect.orDie)
        yield* events.replayCheckpoint(checkpoint)
        const stored = yield* db
          .select()
          .from(EventCheckpointTable)
          .where(eq(EventCheckpointTable.aggregate_id, created.id))
          .get()
          .pipe(Effect.orDie)
        if (!stored) return yield* Effect.die("Stored compatible checkpoint is missing")
        yield* db
          .update(EventCheckpointTable)
          .set({ data: EventV2.replaceStoredCheckpointBaseline(stored.data, checkpoint.baseline) })
          .where(eq(EventCheckpointTable.aggregate_id, created.id))
          .run()
          .pipe(Effect.orDie)
        yield* events.replayCheckpoint(checkpoint)

        const upgraded = yield* events.checkpoint(created.id)
        if (!upgraded || upgraded.version !== EventV2.CheckpointVersion)
          return yield* Effect.die("Upgraded projection checkpoint is missing")
        expect(upgraded.baseline.version).toBe(SessionProjector.CheckpointAdapterVersion)
        expect(yield* session.get(created.id)).toMatchObject({ title: "checkpoint title" })
        expect(yield* db.select().from(MessageTable).where(eq(MessageTable.session_id, created.id)).all()).toEqual(
          item.legacy ? legacyMessages : [],
        )
        expect(yield* db.select().from(PartTable).where(eq(PartTable.session_id, created.id)).all()).toEqual(
          item.legacy ? legacyParts : [],
        )
      }

      yield* events.remove(created.id)
      yield* db.delete(SessionTable).where(eq(SessionTable.id, created.id)).run().pipe(Effect.orDie)
      yield* events.replayCheckpoint(compacted.checkpoint)
      yield* events.replayAll(tail)

      expect(yield* session.get(created.id)).toMatchObject({ title: "tail title" })
      expect(
        yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.session_id, created.id)).all(),
      ).toHaveLength(1)
      expect(yield* db.select().from(MessageTable).where(eq(MessageTable.session_id, created.id)).all()).toEqual(
        legacyMessages,
      )
      expect(yield* db.select().from(PartTable).where(eq(PartTable.session_id, created.id)).all()).toEqual(legacyParts)
      expect(
        yield* db
          .select({ seq: EventSequenceTable.seq })
          .from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, created.id))
          .get(),
      ).toEqual({ seq: compacted.checkpoint.seq + 1 })
    }),
  )

  it.effect("preserves a non-event-sourced initial context epoch in the first checkpoint", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ id: SessionV2.ID.make("ses_checkpoint_context_epoch"), location })
      yield* session.prompt({
        id: SessionMessage.ID.make("msg_checkpoint_context_epoch"),
        sessionID: created.id,
        prompt: new Prompt({ text: "initialize context" }),
        resume: false,
      })
      const previous = yield* events.compactCheckpoint(created.id)
      if (!previous) return yield* Effect.die("Expected checkpoint without context epoch")
      expect(previous.checkpoint.baseline.data.contextEpoch).toBeUndefined()

      yield* db
        .insert(SessionContextEpochTable)
        .values({
          session_id: created.id,
          baseline: "initial system context",
          snapshot: {},
          baseline_seq: 1,
          agent: AgentV2.ID.make("explore"),
          revision: 0,
        })
        .run()
        .pipe(Effect.orDie)

      yield* session.setTitle({ sessionID: created.id, title: "checkpoint tail" })
      const compacted = yield* events.compactCheckpoint(created.id)
      if (!compacted) return yield* Effect.die("Expected context epoch checkpoint")
      expect(compacted.checkpoint.baseline.data.contextEpoch).toMatchObject({
        session_id: created.id,
        baseline: "initial system context",
        baseline_seq: 1,
        agent: "explore",
        revision: 0,
      })

      yield* session.setTitle({ sessionID: created.id, title: "checkpoint tail" })
      yield* db
        .update(SessionContextEpochTable)
        .set({ revision: 1 })
        .where(eq(SessionContextEpochTable.session_id, created.id))
        .run()
        .pipe(Effect.orDie)
      expect(String(yield* events.compactCheckpoint(created.id).pipe(Effect.exit))).toContain(
        "contextEpoch.revision differs",
      )
    }),
  )

  it.effect("replays title, share, and summary events into a fresh target database", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const sourceDb = (yield* Database.Service).db
      const created = yield* session.create({ id: SessionV2.ID.make("ses_metadata_replay"), location })
      const summary = {
        additions: 9,
        deletions: 4,
        files: 3,
        diffs: [{ file: "src/replay.ts", additions: 9, deletions: 4, status: "modified" as const }],
      }

      yield* session.setTitle({ sessionID: created.id, title: "Replayed metadata" })
      yield* session.setShare({ sessionID: created.id, share: { url: "https://share.example.test/replay" } })
      yield* session.setSummary({ sessionID: created.id, summary })
      yield* session.setShare({ sessionID: created.id })
      const serialized = (yield* sourceDb
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, created.id))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)).map((event) => ({
        id: event.id,
        aggregateID: event.aggregate_id,
        seq: event.seq,
        type: event.type,
        data: event.data,
      }))

      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const targetDatabase = Database.layerFromPath(path.join(tmp.path, "target.sqlite"))
      const targetEvents = EventV2.layer.pipe(Layer.provide(targetDatabase))
      const targetProjector = SessionProjector.layer.pipe(Layer.provide(targetEvents), Layer.provide(targetDatabase))
      const targetStore = SessionStore.layer.pipe(Layer.provide(targetDatabase))

      yield* Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const events = yield* EventV2.Service
        const store = yield* SessionStore.Service
        yield* db
          .insert(ProjectTable)
          .values({ id: ProjectV2.ID.global, worktree: location.directory, sandboxes: [] })
          .run()
          .pipe(Effect.orDie)

        expect(yield* events.replayAll(serialized.slice(0, 4))).toBe(created.id)
        expect(yield* store.get(created.id)).toMatchObject({
          title: "Replayed metadata",
          share: { url: "https://share.example.test/replay" },
          summary,
        })

        expect(yield* events.replayAll(serialized.slice(4))).toBe(created.id)
        expect(yield* store.get(created.id)).toMatchObject({ title: "Replayed metadata", summary })
        expect((yield* store.get(created.id))?.share).toBeUndefined()
      }).pipe(Effect.provide(Layer.fresh(Layer.mergeAll(targetDatabase, targetEvents, targetProjector, targetStore))))
    }),
  )

  it.live("does not use assistant snapshots as ownership evidence for workspace rollback", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const directory = tmp.path
      const location = Location.Ref.make({ directory: AbsolutePath.make(directory) })
      yield* Effect.promise(() => fs.writeFile(path.join(directory, "tracked.txt"), "base\n"))
      yield* Effect.promise(() => fs.writeFile(path.join(directory, "deleted.txt"), "delete me\n"))
      yield* Effect.promise(() => $`git init`.cwd(directory).quiet())
      yield* Effect.promise(() => $`git config core.autocrlf false`.cwd(directory).quiet())
      yield* Effect.promise(() => $`git config core.fsmonitor false`.cwd(directory).quiet())
      yield* Effect.promise(() => $`git config commit.gpgsign false`.cwd(directory).quiet())
      yield* Effect.promise(() => $`git config user.email test@opencode.test`.cwd(directory).quiet())
      yield* Effect.promise(() => $`git config user.name Test`.cwd(directory).quiet())
      yield* Effect.promise(() => $`git add tracked.txt deleted.txt`.cwd(directory).quiet())
      yield* Effect.promise(() => $`git commit -m root`.cwd(directory).quiet())

      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const snapshots = yield* Snapshot.Service
      const created = yield* session.create({ location })
      const userID = SessionMessage.ID.create()
      const assistantID = SessionMessage.ID.create()
      const model = ModelV2.Ref.make({ id: ModelV2.ID.make("sonnet"), providerID: ProviderV2.ID.anthropic })
      yield* session.prompt({
        id: userID,
        sessionID: created.id,
        prompt: new Prompt({ text: "change files" }),
        resume: false,
      })
      yield* SessionInput.promoteSteers(db, events, created.id, Number.MAX_SAFE_INTEGER)
      const start = yield* snapshots.track(location)
      if (!start) return yield* Effect.die("expected git-backed start snapshot")
      yield* Effect.promise(() => fs.writeFile(path.join(directory, "tracked.txt"), "assistant change\n"))
      yield* Effect.promise(() => fs.rm(path.join(directory, "deleted.txt")))
      yield* Effect.promise(() => fs.writeFile(path.join(directory, "added.txt"), "new file\n"))
      const end = yield* snapshots.track(location)
      if (!end) return yield* Effect.die("expected git-backed end snapshot")
      const diffs = yield* snapshots.diffFull({ location, from: start, to: end })
      expect(diffs.find((diff) => diff.file === "tracked.txt")).toMatchObject({
        additions: 1,
        deletions: 1,
        status: "modified",
      })
      expect(diffs.find((diff) => diff.file === "deleted.txt")).toMatchObject({
        additions: 0,
        deletions: 1,
        status: "deleted",
      })
      expect(diffs.find((diff) => diff.file === "added.txt")).toMatchObject({
        additions: 1,
        deletions: 0,
        status: "added",
      })

      yield* events.publish(SessionEvent.Step.Started, {
        sessionID: created.id,
        assistantMessageID: assistantID,
        timestamp: yield* DateTime.now,
        agent: "build",
        model,
        snapshot: start,
      })
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID: created.id,
        assistantMessageID: assistantID,
        timestamp: yield* DateTime.now,
        finish: "stop",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        snapshot: end,
      })

      const blocked = yield* session.revert({ sessionID: created.id, messageID: assistantID })
      expect(blocked.revert?.blockedReason).toBe("unattributed")
      expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "tracked.txt"), "utf8"))).toBe(
        "assistant change\n",
      )
      expect(yield* Effect.promise(() => Bun.file(path.join(directory, "deleted.txt")).exists())).toBe(false)
      expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "added.txt"), "utf8"))).toBe("new file\n")
      const messagesOnly = yield* session.revert({
        sessionID: created.id,
        messageID: assistantID,
        files: "messages_only",
      })
      expect(messagesOnly.revert).toMatchObject({ status: "reverted", fileAction: "messages_only" })
      expect((yield* session.unrevert({ sessionID: created.id })).revert).toBeUndefined()
      expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "tracked.txt"), "utf8"))).toBe(
        "assistant change\n",
      )
    }),
  )

  it.effect("returns the current Session projection after projected updates", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const input = { id, location }
      const created = yield* session.create(input)

      yield* events.publish(SessionV1.Event.Updated, {
        sessionID: id,
        info: SessionV1.SessionInfo.make({
          id,
          slug: "updated",
          version: "test",
          projectID: created.projectID,
          directory: created.location.directory,
          title: "updated",
          agent: "build",
          time: { created: 0, updated: 1 },
        }),
      })

      expect(yield* session.create(input)).toMatchObject({ id, agent: "build" })
    }),
  )

  it.effect("persists creation through the existing legacy created event", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location })

      expect(
        yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, created.id)).all().pipe(Effect.orDie),
      ).toMatchObject([{ type: EventV2.versionedType(SessionV1.Event.Created.type, 1) }])
    }),
  )

  it.effect("persists caller-ID creation through the existing created event", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ id, location })

      expect(
        yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, created.id)).get().pipe(Effect.orDie),
      ).toMatchObject({
        data: { sessionID: id },
      })
    }),
  )

  it.effect("omits legacy creation rows from the V2 Session event stream", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location })
      yield* session.prompt({ sessionID: created.id, prompt: new Prompt({ text: "Hello" }), resume: false })
      yield* SessionInput.promoteSteers(db, events, created.id, Number.MAX_SAFE_INTEGER)

      expect(
        Array.from(yield* session.events({ sessionID: created.id }).pipe(Stream.take(2), Stream.runCollect)),
      ).toMatchObject([
        { cursor: 1, event: { type: "session.next.prompt.admitted", data: { prompt: { text: "Hello" } } } },
        { cursor: 2, event: { type: "session.next.prompt.promoted" } },
      ])
    }),
  )

  it.effect("holds pending inputs across a manual switch and releases one under the selected agent", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location, agent: AgentV2.ID.make("build") })
      const admitted = yield* session.prompt({
        sessionID: created.id,
        prompt: new Prompt({ text: "Queued build work", agent: AgentV2.ID.make("build") }),
        delivery: "queue",
        resume: false,
      })

      yield* session.switchAgent({ sessionID: created.id, agent: "plan" })

      expect(yield* session.heldInputs(created.id)).toMatchObject([{ id: admitted.id, prompt: { agent: "build" } }])
      expect(yield* SessionInput.promoteNextQueued(db, events, created.id)).toBe(false)

      expect(yield* session.releaseInput({ sessionID: created.id, inputID: admitted.id })).toMatchObject({
        id: admitted.id,
      })
      expect(yield* SessionInput.promoteNextQueued(db, events, created.id)).toBe(true)
      expect(yield* session.get(created.id)).toMatchObject({ agent: "plan" })
    }),
  )

  it.effect("replays one prompt lifecycle into a fresh target database", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const sourceEvents = yield* EventV2.Service
      const sourceDb = (yield* Database.Service).db
      const created = yield* session.create({ id: SessionV2.ID.make("ses_fresh_target_replay"), location })
      const admitted = yield* session.prompt({
        sessionID: created.id,
        prompt: new Prompt({ text: "Replay lifecycle" }),
        resume: false,
      })
      yield* SessionInput.promoteSteers(sourceDb, sourceEvents, created.id, Number.MAX_SAFE_INTEGER)
      const serialized = (yield* sourceDb
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, created.id))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)).map((event) => ({
        id: event.id,
        aggregateID: event.aggregate_id,
        seq: event.seq,
        type: event.type,
        data: event.data,
      }))

      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const targetDatabase = Database.layerFromPath(path.join(tmp.path, "target.sqlite"))
      const targetEvents = EventV2.layer.pipe(Layer.provide(targetDatabase))
      const targetProjector = SessionProjector.layer.pipe(Layer.provide(targetEvents), Layer.provide(targetDatabase))
      const targetStore = SessionStore.layer.pipe(Layer.provide(targetDatabase))

      yield* Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const events = yield* EventV2.Service
        const store = yield* SessionStore.Service
        yield* db
          .insert(ProjectTable)
          .values({ id: ProjectV2.ID.global, worktree: location.directory, sandboxes: [] })
          .run()
          .pipe(Effect.orDie)

        expect(yield* store.get(created.id)).toBeUndefined()
        expect(yield* events.replayAll(serialized.slice(0, 2))).toBe(created.id)
        expect(yield* SessionInput.find(db, admitted.id)).toMatchObject({
          id: admitted.id,
          sessionID: created.id,
          prompt: { text: "Replay lifecycle" },
          delivery: "steer",
          admittedSeq: 1,
        })
        expect(yield* store.context(created.id)).toEqual([])

        expect(yield* events.replayAll(serialized.slice(2))).toBe(created.id)
        expect(yield* SessionInput.find(db, admitted.id)).toMatchObject({
          id: admitted.id,
          sessionID: created.id,
          prompt: { text: "Replay lifecycle" },
          delivery: "steer",
          admittedSeq: 1,
          promotedSeq: 2,
        })
        expect(yield* store.context(created.id)).toMatchObject([
          { id: admitted.id, type: "user", text: "Replay lifecycle" },
        ])
        expect(
          (yield* db
            .select()
            .from(EventTable)
            .where(eq(EventTable.aggregate_id, created.id))
            .orderBy(asc(EventTable.seq))
            .all()
            .pipe(Effect.orDie)).map((event) => [event.seq, event.type]),
        ).toEqual([
          [0, EventV2.versionedType(SessionV1.Event.Created.type, 1)],
          [1, EventV2.versionedType(SessionEvent.PromptLifecycle.Admitted.type, 1)],
          [2, EventV2.versionedType(SessionEvent.PromptLifecycle.Promoted.type, 1)],
        ])
      }).pipe(Effect.provide(Layer.fresh(Layer.mergeAll(targetDatabase, targetEvents, targetProjector, targetStore))))
    }),
  )

  it.effect("does not mask unrelated created projector defects", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const event = yield* EventV2.Service
      const defect = new Error("unrelated projector defect")
      yield* event.project(SessionV1.Event.Created, () => Effect.die(defect))

      expect(yield* session.create({ id, location }).pipe(Effect.catchDefect(Effect.succeed))).toBe(defect)
    }),
  )

  it.effect("reports unfinished Session operations as unavailable", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })
      const unavailable = (
        effect: Effect.Effect<void, SessionV2.NotFoundError | SessionV2.OperationUnavailableError>,
      ) =>
        effect.pipe(
          Effect.flip,
          Effect.map((error) => (error instanceof SessionV2.OperationUnavailableError ? error.operation : "not-found")),
        )

      expect(yield* unavailable(session.shell({ sessionID: created.id, command: "pwd" }))).toBe("shell")
      expect(yield* unavailable(session.skill({ sessionID: created.id, skill: "review" }))).toBe("skill")
    }),
  )

  it.effect("switches the selected agent through the durable Session event", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })

      yield* session.switchAgent({ sessionID: created.id, agent: "reviewer" })

      expect(yield* session.get(created.id)).toMatchObject({ agent: "reviewer" })
      expect(
        Array.from(yield* session.events({ sessionID: created.id }).pipe(Stream.take(2), Stream.runCollect)),
      ).toMatchObject([
        { event: { type: "session.next.interrupt.requested" } },
        { event: { type: "session.next.agent.switched", data: { agent: "reviewer" } } },
      ])
    }),
  )

  switchIt.effect("interrupts and awaits cleanup before a manual agent switch becomes durable", () =>
    Effect.gen(function* () {
      switchLifecycle.length = 0
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location, agent: AgentV2.ID.make("build") })

      yield* session.switchAgent({ sessionID: created.id, agent: "plan" })

      expect(switchLifecycle).toEqual(["interrupt", "wait"])
      expect(yield* session.get(created.id)).toMatchObject({ agent: "plan" })
    }),
  )

  it.effect("switches the selected model through the durable Session event", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })
      const model = ModelV2.Ref.make({
        id: ModelV2.ID.make("sonnet"),
        providerID: ProviderV2.ID.anthropic,
        variant: ModelV2.VariantID.make("high"),
      })

      yield* session.switchModel({ sessionID: created.id, model })

      expect(yield* session.get(created.id)).toMatchObject({ model })
      expect(
        Array.from(yield* session.events({ sessionID: created.id }).pipe(Stream.take(1), Stream.runCollect)),
      ).toMatchObject([{ event: { type: "session.next.model.switched", data: { model } } }])
    }),
  )

  handoffIt.effect(
    "rejects hidden, subagent, and unavailable-model handoffs without changing state or admitting a prompt",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        const initialModel = ModelV2.Ref.make({
          id: ModelV2.ID.make("valid-model"),
          providerID: ProviderV2.ID.make("test"),
        })
        const created = yield* session.create({ location, agent: AgentV2.ID.make("build"), model: initialModel })
        const attempt = (agent: string, model?: ModelV2.Ref) =>
          session
            .switchAgentAndPrompt({
              sessionID: created.id,
              agent: AgentV2.ID.make(agent),
              model,
              prompt: new Prompt({ text: `must not be admitted: ${agent}` }),
            })
            .pipe(Effect.exit)

        expect(Exit.isFailure(yield* attempt("hidden"))).toBeTrue()
        expect(Exit.isFailure(yield* attempt("worker"))).toBeTrue()
        expect(
          Exit.isFailure(
            yield* attempt(
              "implement",
              ModelV2.Ref.make({ id: ModelV2.ID.make("missing-model"), providerID: ProviderV2.ID.make("test") }),
            ),
          ),
        ).toBeTrue()
        expect(yield* session.get(created.id)).toMatchObject({ agent: "build", model: initialModel })
        expect(yield* session.messages({ sessionID: created.id })).toEqual([])
        const { db } = yield* Database.Service
        expect(yield* SessionInput.hasPending(db, created.id, "steer")).toBe(false)
      }),
  )

  handoffIt.effect("keeps the current model chain when a handoff overrides the active model", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const initialModel = ModelV2.Ref.make({
        id: ModelV2.ID.make("valid-model"),
        providerID: ProviderV2.ID.make("test"),
        chain: {
          id: "settings-chain",
          name: "Settings chain",
          active: 0,
          steps: [
            { id: ModelV2.ID.make("valid-model"), providerID: ProviderV2.ID.make("test") },
            { id: ModelV2.ID.make("fallback-model"), providerID: ProviderV2.ID.make("fallback") },
          ],
        },
      })
      const nextModel = ModelV2.Ref.make({
        id: ModelV2.ID.make("agent-model"),
        providerID: ProviderV2.ID.make("test"),
        variant: ModelV2.VariantID.make("high"),
      })
      const expectedModel = ModelV2.Ref.make({
        ...nextModel,
        chain: {
          ...initialModel.chain!,
          active: 0,
          steps: [
            { id: nextModel.id, providerID: nextModel.providerID, variant: nextModel.variant },
            initialModel.chain!.steps[1]!,
          ],
        },
      })
      const created = yield* session.create({ location, agent: AgentV2.ID.make("build"), model: initialModel })
      const admitted = yield* session.switchAgentAndPrompt({
        sessionID: created.id,
        agent: AgentV2.ID.make("implement"),
        model: nextModel,
        prompt: new Prompt({ text: "Implement the confirmed plan" }),
      })

      expect(yield* session.get(created.id)).toMatchObject({ agent: "build", model: initialModel })
      expect(yield* session.messages({ sessionID: created.id })).toEqual([])
      yield* SessionInput.promoteSteers(db, events, created.id, Number.MAX_SAFE_INTEGER)
      expect(yield* session.get(created.id)).toMatchObject({ agent: "implement", model: expectedModel })
      expect(
        (yield* session.messages({ sessionID: created.id })).find((item) => item.id === admitted.id),
      ).toMatchObject({
        type: "user",
        text: "Implement the confirmed plan",
      })
    }),
  )

  it.effect("persists repeated switches as distinct durable Session events", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })
      const model = ModelV2.Ref.make({ id: ModelV2.ID.make("sonnet"), providerID: ProviderV2.ID.anthropic })

      yield* session.switchModel({ sessionID: created.id, model })
      yield* session.switchModel({ sessionID: created.id, model })

      const { db } = yield* Database.Service
      expect(
        yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, created.id)).all().pipe(Effect.orDie),
      ).toHaveLength(3)
      expect(yield* session.get(created.id)).toMatchObject({ model })
    }),
  )

  it.effect("rejects a model switch for a missing Session", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const missing = SessionV2.ID.make("ses_missing_model_switch")

      expect(
        yield* session
          .switchModel({
            sessionID: missing,
            model: ModelV2.Ref.make({ id: ModelV2.ID.make("sonnet"), providerID: ProviderV2.ID.anthropic }),
          })
          .pipe(
            Effect.flip,
            Effect.map((error) => error._tag),
          ),
      ).toBe("Session.NotFoundError")
    }),
  )

  it.effect("rejects an agent switch for a missing Session", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const missing = SessionV2.ID.make("ses_missing_agent_switch")

      expect(
        yield* session.switchAgent({ sessionID: missing, agent: "reviewer" }).pipe(
          Effect.flip,
          Effect.map((error) => error._tag),
        ),
      ).toBe("Session.NotFoundError")
    }),
  )
})
