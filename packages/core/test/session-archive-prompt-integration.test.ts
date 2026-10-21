import { describe, expect, test } from "bun:test"
import { and, asc, eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import path from "node:path"
import { SessionArchiveCatalogTable, SessionArchiveJournalTable } from "@opencode-ai/core/archive.sql"
import { ContentStore } from "@opencode-ai/core/content-store"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionArchive } from "@opencode-ai/core/session-archive"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { FileAttachment, Prompt } from "@opencode-ai/core/session/prompt"
import { SessionInputTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { tmpdir } from "./fixture/tmpdir"

const now = Date.UTC(2026, 6, 13, 12)
const modified = now - 10 * 24 * 60 * 60 * 1_000
const directory = AbsolutePath.make("/archive-prompt-project")

describe("SessionV2 archived prompt integration", () => {
  test("reactivates once, admits exact retries once, and preserves archived history", async () => {
    await using tmp = await tmpdir()
    await Effect.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionV2.Service
        const archive = yield* SessionArchive.Service
        const { db } = yield* Database.Service
        const sessionID = SessionV2.ID.make("ses_archived_public_prompt")
        const firstHistoryID = SessionMessage.ID.make("msg_archived_history_1")
        const secondHistoryID = SessionMessage.ID.make("msg_archived_history_2")

        yield* archive.initialize
        yield* db
          .insert(ProjectTable)
          .values({ id: ProjectV2.ID.global, worktree: directory, sandboxes: [] })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        yield* sessions.create({ id: sessionID, location: Location.Ref.make({ directory }), title: "Archived prompt" })
        yield* sessions.synthetic({ id: firstHistoryID, sessionID, text: "first archived history" })
        yield* sessions.synthetic({ id: secondHistoryID, sessionID, text: "second archived history" })
        yield* db
          .update(SessionTable)
          .set({ time_created: modified, time_updated: modified })
          .where(eq(SessionTable.id, sessionID))
          .run()
          .pipe(Effect.orDie)
        yield* db
          .update(SessionMessageTable)
          .set({ time_created: modified, time_updated: modified })
          .where(eq(SessionMessageTable.session_id, sessionID))
          .run()
          .pipe(Effect.orDie)

        yield* archive.refreshCatalog(sessionID)
        const archived = yield* archive.archiveOne(sessionID)
        expect(archived).toBeDefined()
        expect((yield* archive.getCatalog(sessionID)).location).toBe("archived")
        expect(
          yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).all().pipe(Effect.orDie),
        ).toEqual([])
        const historyBeforePrompt = yield* sessions.messages({ sessionID, order: "asc" })
        expect(historyBeforePrompt.map((message) => message.id)).toEqual([firstHistoryID, secondHistoryID])
        expect(
          historyBeforePrompt.map((message) => (message.type === "synthetic" ? message.text : undefined)),
        ).toEqual(["first archived history", "second archived history"])

        const steerID = SessionMessage.ID.make("msg_archived_steer")
        const steer = {
          id: steerID,
          sessionID,
          prompt: new Prompt({ text: "resume with steer" }),
          delivery: "steer" as const,
          resume: false,
        }
        const first = yield* sessions.prompt(steer)
        const retried = yield* sessions.prompt(steer)
        const queueID = SessionMessage.ID.make("msg_archived_queue")
        const queued = yield* sessions.prompt({
          id: queueID,
          sessionID,
          prompt: new Prompt({ text: "queue after reactivation" }),
          delivery: "queue",
          resume: false,
        })

        const inputs = yield* db
          .select({ id: SessionInputTable.id, delivery: SessionInputTable.delivery })
          .from(SessionInputTable)
          .where(eq(SessionInputTable.session_id, sessionID))
          .orderBy(asc(SessionInputTable.admitted_seq))
          .all()
          .pipe(Effect.orDie)
        const reactivations = yield* db
          .select({ id: SessionArchiveJournalTable.id, state: SessionArchiveJournalTable.state })
          .from(SessionArchiveJournalTable)
          .where(
            and(
              eq(SessionArchiveJournalTable.session_id, sessionID),
              eq(SessionArchiveJournalTable.operation, "reactivate"),
            ),
          )
          .all()
          .pipe(Effect.orDie)
        const catalog = yield* db
          .select({ location: SessionArchiveCatalogTable.location, revision: SessionArchiveCatalogTable.revision })
          .from(SessionArchiveCatalogTable)
          .where(eq(SessionArchiveCatalogTable.session_id, sessionID))
          .get()
          .pipe(Effect.orDie)
        const historyAfterPrompt = yield* sessions.messages({ sessionID, order: "asc" })

        expect(first.id).toBe(steerID)
        expect(retried).toEqual(first)
        expect(queued.id).toBe(queueID)
        expect(inputs).toEqual([
          { id: steerID, delivery: "steer" },
          { id: queueID, delivery: "queue" },
        ])
        expect(reactivations).toHaveLength(1)
        expect(reactivations[0]?.state).toBe("completed")
        expect(catalog).toEqual({ location: "active", revision: 1 })
        expect(
          yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).all().pipe(Effect.orDie),
        ).toHaveLength(1)
        expect(historyAfterPrompt).toEqual(historyBeforePrompt)
      }).pipe(Effect.provide(testLayer(path.join(tmp.path, "active.sqlite"), path.join(tmp.path, "archives"))), Effect.scoped),
    )
  }, 60_000)
})

function testLayer(filename: string, archives: string) {
  const database = Database.layerFromPath(filename)
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
  const archive = SessionArchive.layer({
    directory: archives,
    now: () => now,
    isIdle: () => Effect.succeed(true),
  }).pipe(Layer.provide(database))
  const dependencies = Layer.mergeAll(
    database,
    events,
    projector,
    store,
    projects,
    content,
    archive,
    SessionExecution.noopLayer,
  )
  return Layer.merge(
    dependencies,
    SessionV2.layer.pipe(
      Layer.provide(content),
      Layer.provide(archive),
      Layer.provide(events),
      Layer.provide(database),
      Layer.provide(store),
      Layer.provide(projects),
      Layer.provide(SessionExecution.noopLayer),
    ),
  )
}
