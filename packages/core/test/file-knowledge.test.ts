import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Schema } from "effect"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Database } from "@opencode-ai/core/database/database"
import { FileKnowledge } from "@opencode-ai/core/file-knowledge"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProjectV2 } from "@opencode-ai/core/project"
import { SessionTable, SessionMessageTable } from "@opencode-ai/core/session/sql"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { FileKnowledgeReceiptTable } from "@opencode-ai/core/file-knowledge.sql"
import { tmpdir } from "./fixture/tmpdir"
import path from "node:path"

const sessionID = SessionSchema.ID.make("ses_knowledge")
const readID = SessionMessage.ID.make("msg_z_read")
const writeID = SessionMessage.ID.make("msg_a_write")
const fixture = <A, E>(
  body: (store: ReturnType<typeof FileKnowledge.make>, db: Database.Interface["db"]) => Effect.Effect<A, E>,
  filename = ":memory:",
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* db
        .insert(ProjectTable)
        .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/knowledge"), sandboxes: [] })
        .run()
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: ProjectV2.ID.global,
          slug: sessionID,
          directory: AbsolutePath.make("/knowledge"),
          title: "knowledge",
          version: "test",
        })
        .run()
      for (const [id, seq] of [
        [readID, 1],
        [writeID, 2],
      ] as const) {
        const {
          id: encodedID,
          type,
          ...data
        } = Schema.encodeSync(SessionMessage.Message)(
          new SessionMessage.Assistant({
            id,
            type: "assistant",
            agent: "build",
            model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
            content: [],
            time: { created: DateTime.makeUnsafe(0) },
          }),
        )
        yield* db
          .insert(SessionMessageTable)
          .values({ id: SessionMessage.ID.make(encodedID), session_id: sessionID, seq, type, data })
          .run()
      }
      return yield* body(FileKnowledge.make(db), db)
    }).pipe(Effect.provide(Database.layerFromPath(filename))),
  )

// Unit-store queries use the full saved index; production requests freeze their own cutoff.
const context = {
  sessionID,
  assistantMessageID: writeID,
  toolCallID: "write",
  fileKnowledgeCutoff: Number.MAX_SAFE_INTEGER,
}
const read = {
  sessionID,
  assistantMessageID: readID,
  callID: "read",
  target: "/knowledge/a",
  sha256: "version-a",
  coverage: { ranges: [[1, 2]] as [number, number][], end: 4 },
  output: "exact visible output",
}

describe("FileKnowledge", () => {
  test("survives closing and reopening the database; missing evidence fails closed", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "knowledge.db")
    await fixture(
      (store) =>
        store.recordRead(read).pipe(Effect.andThen(store.deliver(sessionID, [{ id: "read", text: read.output }]))),
      filename,
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const restarted = FileKnowledge.make(db)
        expect((yield* restarted.basisFor(context, read.target))?.sha256).toBe("version-a")
        yield* db.delete(FileKnowledgeReceiptTable).run()
        expect(yield* restarted.basisFor(context, read.target)).toBeUndefined()
      }).pipe(Effect.provide(Database.layerFromPath(filename))),
    )
  })

  test("requires exact delivered read output and isolates the request basis", () =>
    fixture((store) =>
      Effect.gen(function* () {
        yield* store.recordRead(read)
        expect(yield* store.basisFor(context, read.target)).toBeUndefined()
        yield* store.deliver(sessionID, [{ id: "read", text: "shortened output" }])
        expect(yield* store.basisFor(context, read.target)).toBeUndefined()
        const cutoff = yield* store.deliver(sessionID, [{ id: "read", text: read.output }])
        const basis = yield* store.basisFor({ ...context, fileKnowledgeCutoff: cutoff }, read.target)
        expect(basis?.coverage.ranges).toEqual([[1, 2]])
        expect(
          yield* store.basisFor({ ...context, assistantMessageID: readID, fileKnowledgeCutoff: cutoff }, read.target),
        ).toBeUndefined()
        yield* store.recordWrite({
          ...context,
          target: read.target,
          sha256: "version-b",
          coverage: { ranges: [[1, 4]], end: 4 },
        })
        expect((yield* store.basisFor({ ...context, fileKnowledgeCutoff: cutoff }, read.target))?.sha256).toBe(
          "version-a",
        )
        // Same-message writes never acquire knowledge from their parallel siblings.
        expect((yield* store.basisFor(context, read.target))?.sha256).toBe("version-a")
      }),
    ))

  test("merges pages only for the same version and grants full coverage only through EOF", () =>
    fixture((store) =>
      Effect.gen(function* () {
        yield* store.recordRead(read)
        yield* store.deliver(sessionID, [{ id: "read", text: read.output }])
        yield* store.recordRead({ ...read, callID: "page2", coverage: { ranges: [[3, 4]], end: 4 }, output: "page2" })
        yield* store.deliver(sessionID, [{ id: "page2", text: "page2" }])
        expect(FileKnowledge.full((yield* store.basisFor(context, read.target))!.coverage)).toBe(true)
        yield* store.recordRead({
          ...read,
          callID: "changed",
          sha256: "different",
          coverage: { ranges: [[3, 4]], end: 4 },
          output: "changed",
        })
        yield* store.deliver(sessionID, [{ id: "changed", text: "changed" }])
        expect(FileKnowledge.full((yield* store.basisFor(context, read.target))!.coverage)).toBe(false)
        expect(
          yield* store.basisFor({ ...context, sessionID: SessionSchema.ID.make("ses_foreign") }, read.target),
        ).toBeUndefined()
      }),
    ))

  test("late delivery of an older read never replaces a confirmed newer write", () =>
    fixture((store) =>
      Effect.gen(function* () {
        yield* store.recordRead(read)
        yield* store.recordWrite({
          ...context,
          assistantMessageID: readID,
          target: read.target,
          sha256: "newer-write",
          coverage: { ranges: [[1, 4]], end: 4 },
        })
        yield* store.deliver(sessionID, [{ id: "read", text: read.output }])
        expect((yield* store.basisFor(context, read.target))?.sha256).toBe("newer-write")
      }),
    ))

  test("coverage is ordered, conservative, and independent of message ID spelling", () => {
    expect(FileKnowledge.merge({ ranges: [[3, 4]] }, { ranges: [[1, 2]], end: 4 })).toEqual({
      ranges: [[1, 4]],
      end: 4,
    })
    expect(
      FileKnowledge.full({
        ranges: [
          [1, 2],
          [4, 5],
        ],
        end: 5,
      }),
    ).toBe(false)
    expect(FileKnowledge.full({ ranges: [], end: 0 })).toBe(true)
  })
})
