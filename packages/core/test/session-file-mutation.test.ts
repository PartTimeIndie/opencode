import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer, Schema } from "effect"
import { count } from "drizzle-orm"
import { ContentBlobTable } from "@opencode-ai/core/attachment.sql"
import { Database } from "@opencode-ai/core/database/database"
import { ContentStore } from "@opencode-ai/core/content-store"
import { FileMutation } from "@opencode-ai/core/file-mutation"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { ModelV2 } from "@opencode-ai/core/model"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionFileMutation } from "@opencode-ai/core/session/file-mutation"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionFileBlobTable, SessionFileMutationTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const created = DateTime.makeUnsafe(0)
const encodeMessage = Schema.encodeSync(SessionMessage.Message)
const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }
const it = testEffect(Layer.empty)

function provide<A, E, R>(directory: string, effect: Effect.Effect<A, E, R>) {
  const database = Database.layerFromPath(":memory:")
  const filesystem = FSUtil.defaultLayer
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
  )
  const resolution = LocationMutation.layer.pipe(Layer.provide(filesystem), Layer.provide(activeLocation))
  const mutation = FileMutation.layer.pipe(Layer.provide(filesystem))
  const content = ContentStore.layer.pipe(
    Layer.provide(database),
    Layer.provide(filesystem),
    Layer.provide(Global.layerWith({ data: directory })),
  )
  const journal = SessionFileMutation.layer.pipe(
    Layer.provide(database),
    Layer.provide(filesystem),
    Layer.provide(content),
  )
  return effect.pipe(
    Effect.provide(Layer.mergeAll(database, filesystem, activeLocation, resolution, mutation, content, journal)),
  )
}

function withTmp<A, E, R>(f: (directory: string) => Effect.Effect<A, E, R>) {
  return Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((tmp) => f(tmp.path)))
}

function messageRow(message: SessionMessage.Message, sessionID: SessionV2.ID, seq: number) {
  const { id, type, ...data } = encodeMessage(message)
  return {
    id: SessionMessage.ID.make(id),
    session_id: sessionID,
    type,
    seq,
    time_created: DateTime.toEpochMillis(message.time.created),
    data,
  }
}

const userMessage = (id: SessionMessage.ID) =>
  new SessionMessage.User({ id, type: "user", text: "change", files: [], agents: [], time: { created } })

const assistantMessage = (id: SessionMessage.ID, content: SessionMessage.AssistantContent[] = []) =>
  new SessionMessage.Assistant({ id, type: "assistant", agent: "build", model, content, time: { created } })

function setupSession(directory: string, sessionID: SessionV2.ID, messages: SessionMessage.Message[]) {
  return Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make(directory), sandboxes: [] })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({ id: sessionID, project_id: Project.ID.global, slug: "test", directory, title: "test", version: "test" })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionMessageTable)
      .values(messages.map((message, index) => messageRow(message, sessionID, index + 1)))
      .run()
      .pipe(Effect.orDie)
  })
}

function writeAndRecord(input: {
  readonly path: string
  readonly content: string
  readonly sessionID: SessionV2.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly callID: string
}) {
  return Effect.gen(function* () {
    const target = yield* (yield* LocationMutation.Service).resolve({ path: input.path })
    const result = yield* (yield* FileMutation.Service).write({ target, content: input.content })
    yield* (yield* SessionFileMutation.Service).record({
      sessionID: input.sessionID,
      assistantMessageID: input.assistantMessageID,
      callID: input.callID,
      mutations: [result.mutation],
    })
  })
}

describe("SessionFileMutation", () => {
  it.live("persists native mode evidence and refuses an external mode-only change", () =>
    withTmp((directory) => provide(directory, Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_mode_drift")
      const userID = SessionMessage.ID.make("msg_mode_drift_user")
      const assistantID = SessionMessage.ID.make("msg_mode_drift_assistant")
      yield* setupSession(directory, sessionID, [userMessage(userID), assistantMessage(assistantID)])
      const target = path.join(directory, "tracked.txt")
      yield* Effect.promise(() => fs.writeFile(target, "base"))
      const mode = (yield* Effect.promise(() => fs.stat(target))).mode & 0o777
      yield* writeAndRecord({ path: "tracked.txt", content: "ours", sessionID, assistantMessageID: assistantID, callID: "mode-write" })
      const db = (yield* Database.Service).db
      expect(yield* db.select({ before: SessionFileMutationTable.before_mode, after: SessionFileMutationTable.after_mode }).from(SessionFileMutationTable).all())
        .toEqual([{ before: mode, after: mode }])
      yield* Effect.promise(() => fs.chmod(target, 0o444))
      const result = yield* (yield* SessionFileMutation.Service).revert({ sessionID, revert: { messageID: userID } })
      expect(result.conflicts).toHaveLength(1)
      expect(result.conflicts[0]).toMatchObject({ expected: { mode }, actual: { mode: 0o444 } })
      expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("ours")
    }))),
  )

  it.live("restores a deleted file's recorded mode instead of the process default", () =>
    withTmp((directory) => provide(directory, Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_mode_restore")
      const userID = SessionMessage.ID.make("msg_mode_restore_user")
      const assistantID = SessionMessage.ID.make("msg_mode_restore_assistant")
      yield* setupSession(directory, sessionID, [userMessage(userID), assistantMessage(assistantID)])
      const target = { canonical: path.join(directory, "deleted.txt"), resource: "deleted.txt" }
      yield* Effect.promise(() => fs.writeFile(target.canonical, "before"))
      yield* Effect.promise(() => fs.chmod(target.canonical, 0o444))
      const files = yield* FileMutation.Service
      const journal = yield* SessionFileMutation.Service
      const removal = yield* files.remove({ target })
      expect(removal.mutation.before.mode).toBe(0o444)
      yield* journal.record({ sessionID, assistantMessageID: assistantID, callID: "delete-mode", mutations: [removal.mutation] })
      expect(yield* journal.revert({ sessionID, revert: { messageID: userID } })).toEqual({ mutations: 1, conflicts: [] })
      expect(yield* Effect.promise(() => fs.readFile(target.canonical, "utf8"))).toBe("before")
      expect((yield* Effect.promise(() => fs.stat(target.canonical))).mode & 0o777).toBe(0o444)
    }))),
  )

  it.live("restores owned file writes for the reverted session range", () =>
    withTmp((directory) =>
      provide(
        directory,
        Effect.gen(function* () {
          const sessionID = SessionV2.ID.make("ses_file_mutation_restore")
          const userID = SessionMessage.ID.make("msg_file_mutation_restore_user")
          const assistantID = SessionMessage.ID.make("msg_file_mutation_restore_assistant")
          yield* setupSession(directory, sessionID, [userMessage(userID), assistantMessage(assistantID)])
          yield* Effect.promise(() => fs.writeFile(path.join(directory, "tracked.txt"), "base"))

          yield* writeAndRecord({
            path: "tracked.txt",
            content: "ours",
            sessionID,
            assistantMessageID: assistantID,
            callID: "call-write",
          })
          yield* writeAndRecord({
            path: "created.txt",
            content: "created",
            sessionID,
            assistantMessageID: assistantID,
            callID: "call-create",
          })
          const db = (yield* Database.Service).db
          expect((yield* db.select({ value: count() }).from(ContentBlobTable).get())?.value).toBe(3)
          expect((yield* db.select({ value: count() }).from(SessionFileBlobTable).get())?.value).toBe(0)

          expect(
            yield* (yield* SessionFileMutation.Service).revert({ sessionID, revert: { messageID: userID } }),
          ).toEqual({
            mutations: 2,
            conflicts: [],
          })
          expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "tracked.txt"), "utf8"))).toBe("base")
          expect(
            yield* Effect.promise(() =>
              fs.stat(path.join(directory, "created.txt")).then(
                () => true,
                () => false,
              ),
            ),
          ).toBe(false)
        }),
      ),
    ),
  )

  it.live("blocks atomically when a file changed outside the reverted session range", () =>
    withTmp((directory) =>
      provide(
        directory,
        Effect.gen(function* () {
          const sessionID = SessionV2.ID.make("ses_file_mutation_conflict")
          const userID = SessionMessage.ID.make("msg_file_mutation_conflict_user")
          const assistantID = SessionMessage.ID.make("msg_file_mutation_conflict_assistant")
          yield* setupSession(directory, sessionID, [userMessage(userID), assistantMessage(assistantID)])
          yield* Effect.promise(() => fs.writeFile(path.join(directory, "tracked.txt"), "base"))

          yield* writeAndRecord({
            path: "tracked.txt",
            content: "ours",
            sessionID,
            assistantMessageID: assistantID,
            callID: "call-write",
          })
          yield* Effect.promise(() => fs.writeFile(path.join(directory, "tracked.txt"), "other-chat"))

          const result = yield* (yield* SessionFileMutation.Service).revert({
            sessionID,
            revert: { messageID: userID },
          })

          expect(result.mutations).toBe(1)
          expect(result.conflicts).toMatchObject([{ resource: "tracked.txt" }])
          expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "tracked.txt"), "utf8"))).toBe(
            "other-chat",
          )
        }),
      ),
    ),
  )

  it.live("blocks when another session changed the file between owned writes", () =>
    withTmp((directory) =>
      provide(
        directory,
        Effect.gen(function* () {
          const sessionA = SessionV2.ID.make("ses_file_mutation_interleaved_a")
          const sessionB = SessionV2.ID.make("ses_file_mutation_interleaved_b")
          const userA = SessionMessage.ID.make("msg_file_mutation_interleaved_user_a")
          const assistantA = SessionMessage.ID.make("msg_file_mutation_interleaved_assistant_a")
          const userB = SessionMessage.ID.make("msg_file_mutation_interleaved_user_b")
          const assistantB = SessionMessage.ID.make("msg_file_mutation_interleaved_assistant_b")
          yield* setupSession(directory, sessionA, [userMessage(userA), assistantMessage(assistantA)])
          const db = (yield* Database.Service).db
          yield* db
            .insert(SessionTable)
            .values({
              id: sessionB,
              project_id: Project.ID.global,
              slug: "test-b",
              directory,
              title: "test-b",
              version: "test",
            })
            .run()
            .pipe(Effect.orDie)
          yield* db
            .insert(SessionMessageTable)
            .values([
              messageRow(userMessage(userB), sessionB, 1),
              messageRow(assistantMessage(assistantB), sessionB, 2),
            ])
            .run()
            .pipe(Effect.orDie)
          yield* Effect.promise(() => fs.writeFile(path.join(directory, "shared.txt"), "base"))

          yield* writeAndRecord({
            path: "shared.txt",
            content: "session-a-before",
            sessionID: sessionA,
            assistantMessageID: assistantA,
            callID: "call-a-before",
          })
          yield* writeAndRecord({
            path: "shared.txt",
            content: "session-b-edit",
            sessionID: sessionB,
            assistantMessageID: assistantB,
            callID: "call-b",
          })
          yield* writeAndRecord({
            path: "shared.txt",
            content: "session-a-after",
            sessionID: sessionA,
            assistantMessageID: assistantA,
            callID: "call-a-after",
          })

          const result = yield* (yield* SessionFileMutation.Service).revert({
            sessionID: sessionA,
            revert: { messageID: userA },
          })

          expect(result.conflicts).toHaveLength(1)
          expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "shared.txt"), "utf8"))).toBe(
            "session-a-after",
          )
        }),
      ),
    ),
  )

  it.live("blocks a later foreign mutation even when the final bytes match the owned write", () =>
    withTmp((directory) =>
      provide(
        directory,
        Effect.gen(function* () {
          const sessionA = SessionV2.ID.make("ses_file_mutation_later_a")
          const sessionB = SessionV2.ID.make("ses_file_mutation_later_b")
          const userA = SessionMessage.ID.make("msg_file_mutation_later_user_a")
          const assistantA = SessionMessage.ID.make("msg_file_mutation_later_assistant_a")
          const assistantB = SessionMessage.ID.make("msg_file_mutation_later_assistant_b")
          yield* setupSession(directory, sessionA, [userMessage(userA), assistantMessage(assistantA)])
          const db = (yield* Database.Service).db
          yield* db
            .insert(SessionTable)
            .values({
              id: sessionB,
              project_id: Project.ID.global,
              slug: "other",
              directory,
              title: "other",
              version: "test",
            })
            .run()
            .pipe(Effect.orDie)
          yield* db
            .insert(SessionMessageTable)
            .values([
              messageRow(userMessage(SessionMessage.ID.make("msg_file_mutation_later_user_b")), sessionB, 1),
              messageRow(assistantMessage(assistantB), sessionB, 2),
            ])
            .run()
            .pipe(Effect.orDie)
          yield* Effect.promise(() => fs.writeFile(path.join(directory, "shared.txt"), "base"))
          yield* writeAndRecord({
            path: "shared.txt",
            content: "owned",
            sessionID: sessionA,
            assistantMessageID: assistantA,
            callID: "call-owned",
          })
          yield* writeAndRecord({
            path: "shared.txt",
            content: "foreign",
            sessionID: sessionB,
            assistantMessageID: assistantB,
            callID: "call-foreign",
          })
          yield* writeAndRecord({
            path: "shared.txt",
            content: "owned",
            sessionID: sessionB,
            assistantMessageID: assistantB,
            callID: "call-foreign-again",
          })

          const result = yield* (yield* SessionFileMutation.Service).revert({
            sessionID: sessionA,
            revert: { messageID: userA },
          })
          expect(result.conflicts).toHaveLength(1)
          expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "shared.txt"), "utf8"))).toBe("owned")
        }),
      ),
    ),
  )

  it.live("blocks unjournaled edits between owned mutations without changing other files", () =>
    withTmp((directory) =>
      provide(
        directory,
        Effect.gen(function* () {
          const sessionID = SessionV2.ID.make("ses_file_mutation_gap")
          const userID = SessionMessage.ID.make("msg_file_mutation_gap_user")
          const assistantID = SessionMessage.ID.make("msg_file_mutation_gap_assistant")
          yield* setupSession(directory, sessionID, [userMessage(userID), assistantMessage(assistantID)])
          yield* Effect.promise(() => fs.writeFile(path.join(directory, "shared.txt"), "base"))
          yield* Effect.promise(() => fs.writeFile(path.join(directory, "untouched.txt"), "base"))
          yield* writeAndRecord({
            path: "shared.txt",
            content: "owned-first",
            sessionID,
            assistantMessageID: assistantID,
            callID: "call-first",
          })
          yield* Effect.promise(() => fs.writeFile(path.join(directory, "shared.txt"), "user-edit"))
          yield* writeAndRecord({
            path: "shared.txt",
            content: "owned-last",
            sessionID,
            assistantMessageID: assistantID,
            callID: "call-last",
          })
          yield* writeAndRecord({
            path: "untouched.txt",
            content: "owned-other",
            sessionID,
            assistantMessageID: assistantID,
            callID: "call-other",
          })

          const result = yield* (yield* SessionFileMutation.Service).revert({
            sessionID,
            revert: { messageID: userID },
          })
          expect(result.conflicts).toHaveLength(1)
          expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "shared.txt"), "utf8"))).toBe(
            "owned-last",
          )
          expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "untouched.txt"), "utf8"))).toBe(
            "owned-other",
          )
        }),
      ),
    ),
  )

  it.live("uses assistant part boundaries when selecting owned mutations", () =>
    withTmp((directory) =>
      provide(
        directory,
        Effect.gen(function* () {
          const sessionID = SessionV2.ID.make("ses_file_mutation_part")
          const userID = SessionMessage.ID.make("msg_file_mutation_part_user")
          const assistantID = SessionMessage.ID.make("msg_file_mutation_part_assistant")
          const beforeTool = new SessionMessage.AssistantTool({
            type: "tool",
            id: "call-before",
            name: "write",
            state: new SessionMessage.ToolStateCompleted({
              status: "completed",
              input: {},
              content: [],
              structured: {},
            }),
            time: { created },
          })
          const marker = new SessionMessage.AssistantText({ type: "text", id: "text-marker", text: "keep before" })
          const afterTool = new SessionMessage.AssistantTool({
            type: "tool",
            id: "call-after",
            name: "write",
            state: new SessionMessage.ToolStateCompleted({
              status: "completed",
              input: {},
              content: [],
              structured: {},
            }),
            time: { created },
          })
          yield* setupSession(directory, sessionID, [
            userMessage(userID),
            assistantMessage(assistantID, [beforeTool, marker, afterTool]),
          ])
          yield* Effect.promise(() =>
            Promise.all([
              fs.writeFile(path.join(directory, "before.txt"), "base-before"),
              fs.writeFile(path.join(directory, "after.txt"), "base-after"),
            ]),
          )

          yield* writeAndRecord({
            path: "before.txt",
            content: "changed-before",
            sessionID,
            assistantMessageID: assistantID,
            callID: "call-before",
          })
          yield* writeAndRecord({
            path: "after.txt",
            content: "changed-after",
            sessionID,
            assistantMessageID: assistantID,
            callID: "call-after",
          })

          expect(
            yield* (yield* SessionFileMutation.Service).revert({
              sessionID,
              revert: { messageID: assistantID, partID: "text-marker" },
            }),
          ).toEqual({ mutations: 1, conflicts: [] })
          expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "before.txt"), "utf8"))).toBe(
            "changed-before",
          )
          expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "after.txt"), "utf8"))).toBe("base-after")
          const journal = yield* SessionFileMutation.Service
          expect(
            yield* journal.revert({
              sessionID,
              revert: { messageID: userID },
              from: { messageID: assistantID, partID: "text-marker" },
            }),
          ).toEqual({ mutations: 2, conflicts: [] })
          expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "before.txt"), "utf8"))).toBe(
            "base-before",
          )
          expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "after.txt"), "utf8"))).toBe("base-after")
          expect(
            yield* journal.revert({
              sessionID,
              revert: { messageID: assistantID, partID: "text-marker" },
              from: { messageID: userID },
            }),
          ).toEqual({ mutations: 2, conflicts: [] })
          expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "before.txt"), "utf8"))).toBe(
            "changed-before",
          )
          expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "after.txt"), "utf8"))).toBe("base-after")
          expect(
            yield* journal.unrevert({ sessionID, revert: { messageID: assistantID, partID: "text-marker" } }),
          ).toEqual({ mutations: 1, conflicts: [] })
          expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "after.txt"), "utf8"))).toBe(
            "changed-after",
          )
        }),
      ),
    ),
  )
})
