import { ContentStore } from "@opencode-ai/core/content-store"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionArchive } from "@opencode-ai/core/session-archive"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { describe, expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import path from "node:path"
import { locateSessionAttachment } from "../../src/attachment/content"
import { ProofAttachment } from "../../src/attachment/proof"
import { tmpdir } from "../fixture/fixture"

describe("session attachment content", () => {
  test("locates archived content without reactivation and preserves range reads", async () => {
    await using tmp = await tmpdir()
    const sessionID = SessionSchema.ID.make("ses_archived_attachment")
    const database = Database.layerFromPath(path.join(tmp.path, "active.sqlite")).pipe(Layer.fresh)
    const global = Global.layerWith({ data: tmp.path })
    const content = ContentStore.layer.pipe(
      Layer.provide(database),
      Layer.provide(FSUtil.defaultLayer),
      Layer.provide(global),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const store = yield* ContentStore.Service
        yield* db
          .insert(ProjectTable)
          .values({
            id: Project.ID.global,
            worktree: AbsolutePath.make(tmp.path),
            sandboxes: [],
            time_created: 0,
            time_updated: 0,
          })
          .run()
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: Project.ID.global,
            slug: sessionID,
            directory: AbsolutePath.make(tmp.path),
            title: "Archived attachment",
            version: "test",
            time_created: 0,
            time_updated: 0,
          })
          .run()
        const file = yield* store.storeAttachment({
          sessionID,
          key: "archived",
          bytes: new TextEncoder().encode("hello"),
          mime: "text/plain",
          name: "hello.txt",
        })
        const attachmentID = file.uri.slice(ContentStore.URI_PREFIX.length)
        const archive = yield* SessionArchive.make({
          directory: path.join(tmp.path, "archives"),
          inactiveMs: 0,
          now: () => 1,
          isIdle: () => Effect.succeed(true),
        })
        yield* archive.initialize
        yield* db.run(sql`UPDATE attachment SET created_at = 0 WHERE session_id = ${sessionID}`)
        yield* archive.refreshCatalog(sessionID)

        expect(
          yield* locateSessionAttachment({ attachmentID, sessionID, content: store, archive }),
        ).toMatchObject({ name: "hello.txt", mime: "text/plain", sizeBytes: 5 })
        expect(yield* archive.archiveOne(sessionID)).toBeDefined()
        expect(yield* db.get(sql`SELECT id FROM session WHERE id = ${sessionID}`)).toBeUndefined()

        const archived = yield* locateSessionAttachment({ attachmentID, sessionID, content: store, archive })
        expect(archived).toMatchObject({ name: "hello.txt", mime: "text/plain", sizeBytes: 5 })
        expect(yield* archive.getCatalog(sessionID)).toMatchObject({ location: "archived" })
        const range = ProofAttachment.rangeFromHeader("bytes=1-3", archived!.sizeBytes)
        if (!range || range === "invalid") throw new Error("expected valid byte range")
        expect(
          yield* Effect.promise(() => new Response(ProofAttachment.readStream(archived!.path, range)).text()),
        ).toBe("ell")
        expect(
          yield* locateSessionAttachment({
            attachmentID,
            sessionID: "ses_other",
            content: store,
            archive,
          }),
        ).toBeUndefined()
      }).pipe(Effect.provide(Layer.mergeAll(database, content, FSUtil.defaultLayer))),
    )
  })
})
