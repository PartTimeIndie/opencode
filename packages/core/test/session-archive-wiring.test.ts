import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { eq } from "drizzle-orm"
import { AgentV2 } from "@opencode-ai/core/agent"
import { ContentStore } from "@opencode-ai/core/content-store"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionAgentPolicy } from "@opencode-ai/core/session/agent-policy"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionArchive } from "@opencode-ai/core/session-archive"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { FileAttachment, Prompt } from "@opencode-ai/core/session/prompt"
import { SessionInputTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { testEffect } from "./lib/effect"

const archivedID = SessionV2.ID.make("ses_archived_b")
const firstMessageID = SessionMessage.ID.make("msg_archived_1")
const secondMessageID = SessionMessage.ID.make("msg_archived_2")
const directory = AbsolutePath.make("/archive-project")
const state = { refreshes: 0, catalogReads: 0, ensures: 0, activations: 0 }

const entries = [
  catalog(SessionV2.ID.make("ses_archived_a"), "Archive A", 100),
  catalog(archivedID, "Archive B", 100),
  catalog(SessionV2.ID.make("ses_archived_c"), "Archive C", 100),
]

const archivedRows: SessionArchive.MessagePage["rows"] = [
  {
    id: firstMessageID,
    session_id: archivedID,
    type: "user",
    seq: 1,
    time_created: 1,
    time_updated: 1,
    data: JSON.stringify({ text: "first archived turn", time: { created: 1 } }),
  },
  {
    id: secondMessageID,
    session_id: archivedID,
    type: "user",
    seq: 2,
    time_created: 2,
    time_updated: 2,
    data: JSON.stringify({ text: "second archived turn", time: { created: 2 } }),
  },
]

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
const store = SessionStore.layer.pipe(Layer.provide(database))
const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (input) => Effect.succeed({ id: ProjectV2.ID.global, directory: input }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)
const content = Layer.succeed(
  ContentStore.Service,
  ContentStore.Service.of({
    putBlob: (input) =>
      Effect.succeed({ sha256: "0".repeat(64), mime: input.mime, path: "content", sizeBytes: input.bytes.byteLength }),
    locateBlob: () => Effect.succeed(undefined),
    readBlob: () => Effect.succeed(undefined),
    storeAttachment: (input) =>
      Effect.succeed(new FileAttachment({ uri: "attachment://fake", mime: input.mime, name: input.name })),
    storeTextAttachment: (input) =>
      Effect.succeed(new FileAttachment({ uri: "attachment://fake-text", mime: input.mime, name: input.name })),
    normalizePrompt: (input) => Effect.succeed(input.prompt),
    normalizeFiles: (input) => Effect.succeed(input.files),
    resolve: () => Effect.succeed(undefined),
    locate: () => Effect.succeed(undefined),
    materialize: (input) => Effect.succeed(input.file),
  }),
)
const archive = Layer.effect(
  SessionArchive.Service,
  Database.Service.use(({ db }) =>
    Effect.succeed(
      SessionArchive.Service.of({
        initialize: Effect.void,
        refreshCatalog: () =>
          Effect.sync(() => {
            state.refreshes++
          }),
        getCatalog: (sessionID) => {
          const entry = entries.find((item) => item.sessionID === sessionID)
          return entry
            ? Effect.succeed(entry)
            : Effect.fail(new SessionArchive.NotFoundError({ sessionID }))
        },
        listCatalog: (options = {}) =>
          Effect.sync(() => {
            state.catalogReads++
            const order = options.order ?? "created-desc"
            const sorted = entries
              .filter((entry) => {
                if (!options.anchor) return true
                if (order === "created-asc")
                  return entry.timeCreated > options.anchor.timeCreated ||
                    (entry.timeCreated === options.anchor.timeCreated && entry.sessionID > options.anchor.sessionID)
                return entry.timeCreated < options.anchor.timeCreated ||
                  (entry.timeCreated === options.anchor.timeCreated && entry.sessionID < options.anchor.sessionID)
              })
              .toSorted((a, b) => {
                const value = a.timeCreated - b.timeCreated || a.sessionID.localeCompare(b.sessionID)
                return value * (order === "created-asc" ? 1 : -1)
              })
            const rows = sorted.slice(0, options.limit ?? 100)
            const last = rows.at(-1)
            return {
              rows,
              hasMore: sorted.length > rows.length,
              ...(last
                ? {
                    nextAnchor: {
                      sessionID: last.sessionID,
                      timeCreated: last.timeCreated,
                      timeLastModified: last.timeLastModified,
                      title: last.title,
                    },
                  }
                : {}),
            }
          }),
        candidateStats: Effect.succeed({ backlog: 0 }),
        candidates: () => Effect.succeed([]),
        archiveOne: () => Effect.succeed(undefined),
        purgeCandidates: () => Effect.succeed([]),
        purgeOne: () => Effect.succeed(undefined),
        readMessages: (sessionID, options = {}) => {
          if (sessionID !== archivedID) return Effect.fail(new SessionArchive.NotFoundError({ sessionID }))
          const rows = options.order === "asc" ? archivedRows : archivedRows.toReversed()
          return Effect.succeed({
            rows,
            hasOlder: false,
            hasNewer: false,
            hasPrevious: false,
            hasNext: false,
          })
        },
        readMessage: (sessionID, messageID) => {
          if (sessionID !== archivedID) return Effect.fail(new SessionArchive.NotFoundError({ sessionID }))
          const row = archivedRows.find((item) => item.id === messageID)
          return row
            ? Effect.succeed(row)
            : Effect.fail(new SessionArchive.NotFoundError({ sessionID, itemID: messageID }))
        },
        readLegacyMessages: (sessionID) => Effect.fail(new SessionArchive.NotFoundError({ sessionID })),
        readLegacyMessage: (sessionID, messageID) =>
          Effect.fail(new SessionArchive.NotFoundError({ sessionID, itemID: messageID })),
        resolveMessageTarget: (sessionID) => Effect.fail(new SessionArchive.NotFoundError({ sessionID })),
        readAttachment: (sessionID) => Effect.fail(new SessionArchive.NotFoundError({ sessionID })),
        readInputs: (sessionID) => Effect.fail(new SessionArchive.NotFoundError({ sessionID })),
        readEventReplay: (sessionID) => Effect.fail(new SessionArchive.NotFoundError({ sessionID })),
        ensureActive: (sessionID) =>
          Effect.gen(function* () {
            state.ensures++
            const existing = yield* db
              .select({ id: SessionTable.id })
              .from(SessionTable)
              .where(eq(SessionTable.id, sessionID))
              .get()
              .pipe(Effect.orDie)
            if (existing) return { sessionID, revision: 1, reactivated: false }
            const entry = entries.find((item) => item.sessionID === sessionID)
            if (!entry) return yield* new SessionArchive.NotFoundError({ sessionID })
            state.activations++
            yield* db.insert(SessionTable).values(sessionRow(entry)).run().pipe(Effect.orDie)
            return { sessionID, revision: 1, reactivated: true }
          }),
      }),
    ),
  ),
).pipe(Layer.provide(database))
const sessions = SessionV2.layer.pipe(
  Layer.provide(content),
  Layer.provide(archive),
  Layer.provide(events),
  Layer.provide(database),
  Layer.provide(store),
  Layer.provide(projects),
  Layer.provide(SessionExecution.noopLayer),
)
const it = testEffect(
  Layer.mergeAll(database, events, projector, store, projects, content, archive, SessionExecution.noopLayer, sessions),
)

const setup = Database.Service.use(({ db }) =>
  Effect.gen(function* () {
    state.refreshes = 0
    state.catalogReads = 0
    state.ensures = 0
    state.activations = 0
    yield* db.delete(SessionInputTable).run().pipe(Effect.orDie)
    yield* db.delete(SessionTable).run().pipe(Effect.orDie)
    yield* db
      .insert(ProjectTable)
      .values({ id: ProjectV2.ID.global, worktree: directory, sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  }),
)

describe("SessionV2 archive wiring", () => {
  it.effect("reads archived Sessions without reactivating them", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const db = (yield* Database.Service).db

      expect((yield* session.get(archivedID)).title).toBe("Archive B")
      expect(
        (yield* session.messages({ sessionID: archivedID })).map((message) =>
          message.type === "user" ? message.text : undefined,
        ),
      ).toEqual([
        "second archived turn",
        "first archived turn",
      ])
      const message = yield* session.message({ sessionID: archivedID, messageID: firstMessageID })
      expect(message?.type === "user" ? message.text : undefined).toBe("first archived turn")
      expect((yield* session.list({ order: "desc", limit: 2 })).map((item) => String(item.id))).toEqual([
        "ses_archived_c",
        "ses_archived_b",
      ])
      expect(state.catalogReads).toBe(1)
      expect(
        (
          yield* session.list({
            order: "desc",
            anchor: { id: archivedID, time: 100, direction: "next" },
          })
        ).map((item) => String(item.id)),
      ).toEqual(["ses_archived_a"])
      expect(
        (
          yield* session.list({
            order: "desc",
            anchor: { id: archivedID, time: 100, direction: "previous" },
          })
        ).map((item) => String(item.id)),
      ).toEqual(["ses_archived_c"])
      expect(yield* db.select().from(SessionTable).where(eq(SessionTable.id, archivedID)).get().pipe(Effect.orDie)).toBeUndefined()
      expect(state.ensures).toBe(0)
      expect(state.activations).toBe(0)
    }),
  )

  it.effect("merges active and archived keysets without refreshing the full catalog", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const activeID = SessionV2.ID.make("ses_zzactive")
      yield* (yield* Database.Service).db
        .insert(SessionTable)
        .values(sessionRow({ sessionID: activeID, title: "Active Z", timeCreated: 100 }))
        .run()
        .pipe(Effect.orDie)

      expect((yield* session.list({ order: "desc", limit: 2 })).map((item) => String(item.id))).toEqual([
        "ses_zzactive",
        "ses_archived_c",
      ])
      expect(state.refreshes).toBe(0)
      expect(state.catalogReads).toBe(1)
    }),
  )

  it.effect("reactivates once before concurrent exact-retry admission", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const messageID = SessionMessage.ID.make("msg_archive_exact_retry")
      const input = {
        id: messageID,
        sessionID: archivedID,
        prompt: new Prompt({ text: "resume archived session" }),
        resume: false,
      }

      const admitted = yield* Effect.all([session.prompt(input), session.prompt(input)], { concurrency: "unbounded" })
      yield* session.prompt({
        id: SessionMessage.ID.make("msg_archive_queue"),
        sessionID: archivedID,
        prompt: new Prompt({ text: "queue after reactivation" }),
        delivery: "queue",
        resume: false,
      })
      const rows = yield* (yield* Database.Service).db
        .select()
        .from(SessionInputTable)
        .where(eq(SessionInputTable.session_id, archivedID))
        .all()
        .pipe(Effect.orDie)

      expect(admitted.map((item) => item.id)).toEqual([messageID, messageID])
      expect(rows).toHaveLength(2)
      expect(state.refreshes).toBe(0)
      expect(state.ensures).toBe(3)
      expect(state.activations).toBe(1)
    }),
  )

  it.effect("adopts an archived caller ID instead of creating a duplicate", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const adopted = yield* session.create({ id: archivedID, location: { directory } })

      expect(adopted.id).toBe(archivedID)
      expect(adopted.title).toBe("Archive B")
      expect(state.activations).toBe(1)
      expect(
        yield* (yield* Database.Service).db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, archivedID))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(1)
    }),
  )

  it.effect("decodes raw-row catalog projections with a stringified agent policy", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const childID = SessionV2.ID.make("ses_archived_agent_policy_string")

      yield* withEntry(
        policyEntry(childID, JSON.stringify(childAgentPolicy)),
        Effect.gen(function* () {
          const info = yield* session.get(childID)
          expect(info.agentPolicy).toEqual(childAgentPolicy)

          const listed = yield* session.list({ order: "asc" })
          const listedChild = listed.find((item) => item.id === childID)
          expect(listedChild?.agentPolicy).toEqual(childAgentPolicy)
        }),
      )
    }),
  )

  it.effect("decodes catalog projections that already store the agent policy as an object", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const childID = SessionV2.ID.make("ses_archived_agent_policy_object")

      yield* withEntry(
        policyEntry(childID, childAgentPolicy),
        Effect.gen(function* () {
          expect((yield* session.get(childID)).agentPolicy).toEqual(childAgentPolicy)
        }),
      )
    }),
  )

  it.effect("rejects corrupted agent policy projections instead of hiding them", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const childID = SessionV2.ID.make("ses_archived_agent_policy_corrupt")

      for (const corrupted of ['{"tools":', "[]"]) {
        yield* withEntry(
          policyEntry(childID, corrupted),
          Effect.gen(function* () {
            const exit = yield* session.get(childID).pipe(Effect.exit)
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) {
              const squashed = Cause.squash(exit.cause)
              const message = squashed instanceof Error ? squashed.message : String(squashed)
              expect(message).toContain("Archived Session projection cannot be decoded")
            }

            const listed = yield* session.list({ order: "asc" }).pipe(Effect.exit)
            expect(Exit.isFailure(listed)).toBe(true)
          }),
        )
      }
    }),
  )
})

function catalog(sessionID: SessionV2.ID, title: string, created: number): SessionArchive.CatalogEntry {
  return {
    sessionID,
    projectID: ProjectV2.ID.global,
    title,
    directory,
    sessionData: sessionRow({ sessionID, title, timeCreated: created }),
    location: "archived",
    shardID: "archive-1.db",
    revision: 1,
    contentHash: "0".repeat(64),
    messageCount: sessionID === archivedID ? 2 : 0,
    inputCount: 0,
    logicalBytes: 100,
    timeCreated: created,
    timeLastModified: created,
    timeArchived: created + 1,
  }
}

function sessionRow(input: Pick<SessionArchive.CatalogEntry, "sessionID" | "title" | "timeCreated">) {
  return {
    id: input.sessionID,
    project_id: ProjectV2.ID.global,
    workspace_id: null,
    parent_id: null,
    slug: input.sessionID,
    directory,
    path: null,
    title: input.title,
    version: "test",
    share_url: null,
    summary_additions: null,
    summary_deletions: null,
    summary_files: null,
    summary_diffs: null,
    metadata: null,
    cost: 0,
    tokens_input: 0,
    tokens_output: 0,
    tokens_reasoning: 0,
    tokens_cache_read: 0,
    tokens_cache_write: 0,
    revert: null,
    permission: null,
    agent: null,
    model: null,
    time_created: input.timeCreated,
    time_updated: input.timeCreated,
    time_compacting: null,
    time_archived: null,
  }
}

const childAgentPolicy = {
  tools: { mode: "explicit", entries: { read: { visible: true, permission: "allow" } } },
  permissionLayers: [[{ action: "bash", resource: "*", effect: "allow" }]],
  source: { type: "task", sessionID: "ses_agent_policy_parent", agent: AgentV2.ID.make("build") },
} satisfies SessionAgentPolicy.Info

// Mirrors SessionArchive.refreshCatalog/scanActive, which store the raw SQLite row in
// `session_data`, so drizzle `text({ mode: "json" })` columns arrive as JSON strings.
function policyEntry(sessionID: SessionV2.ID, agentPolicy: unknown): SessionArchive.CatalogEntry {
  return {
    ...catalog(sessionID, "Agent policy child", 150),
    sessionData: {
      ...sessionRow({ sessionID, title: "Agent policy child", timeCreated: 150 }),
      agent_policy: agentPolicy,
    },
  }
}

const withEntry = <A, E>(entry: SessionArchive.CatalogEntry, effect: Effect.Effect<A, E>) =>
  Effect.suspend(() => {
    entries.push(entry)
    return Effect.onExit(effect, () =>
      Effect.sync(() => {
        const index = entries.indexOf(entry)
        if (index >= 0) entries.splice(index, 1)
      }),
    )
  })
