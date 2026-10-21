import fs from "node:fs/promises"
import path from "node:path"
import { DateTime, Effect, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { FileKnowledge } from "@opencode-ai/core/file-knowledge"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionMessage } from "@opencode-ai/core/session/message"
import type { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTable, SessionMessageTable } from "@opencode-ai/core/session/sql"

/** Existing leaf tests start with a declared prior delivered read of fixture files.
 * This is synthetic test setup, not real-run evidence. End-to-end read enforcement
 * and negative/no-read cases are separately tested in known-file-tools.test.ts. */
export const fileKnowledgeBaseline = (
  directory: string,
  sessionID: SessionSchema.ID,
  writeID: SessionMessage.ID,
  extraFiles: string[] = [],
) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db
      .insert(ProjectTable)
      .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make(directory), sandboxes: [] })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: ProjectV2.ID.global,
        slug: sessionID,
        directory,
        title: "leaf-test",
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
    const readID = SessionMessage.ID.make("msg_baseline_read")
    for (const [id, seq] of [
      [readID, 1],
      [writeID, 2],
    ] as const) {
      const encoded = Schema.encodeSync(SessionMessage.Message)(
        new SessionMessage.Assistant({
          id,
          type: "assistant",
          agent: "build",
          model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
          content: [],
          time: { created: DateTime.makeUnsafe(0) },
        }),
      )
      const { id: encodedID, type, ...data } = encoded
      yield* db
        .insert(SessionMessageTable)
        .values({ id: SessionMessage.ID.make(encodedID), session_id: sessionID, seq, type, data })
        .run()
        .pipe(Effect.orDie)
    }
    const entries = yield* Effect.promise(() => fs.readdir(directory, { withFileTypes: true, recursive: true }))
    const paths = [
      ...entries.filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name)),
      ...extraFiles,
    ]
    const store = FileKnowledge.make(db)
    for (const [index, file] of paths.entries()) {
      const canonical = yield* Effect.promise(() => fs.realpath(file))
      const bytes = yield* Effect.promise(() => fs.readFile(canonical))
      const content = bytes.toString("utf8")
      const end = content === "" ? 0 : content.replace(/\r?\n$/, "").split(/\r?\n/).length
      const callID = `baseline-${index}`
      const output = `Synthetic prior delivered fixture read ${index}`
      yield* store.recordRead({
        sessionID,
        assistantMessageID: readID,
        callID,
        target: canonical,
        sha256: FileKnowledge.hash(bytes),
        coverage: { ranges: end ? [[1, end]] : [], end },
        output,
      })
      yield* store.deliver(sessionID, [{ id: callID, text: output }])
    }
    return yield* store.deliver(sessionID, [])
  })
