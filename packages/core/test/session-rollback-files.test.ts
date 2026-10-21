import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Cause, DateTime, Effect, Layer, Schema } from "effect"
import { ContentStore } from "@opencode-ai/core/content-store"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { FileMutation } from "@opencode-ai/core/file-mutation"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionFileMutation } from "@opencode-ai/core/session/file-mutation"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionFileMutationTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const created = DateTime.makeUnsafe(0)
const encodeMessage = Schema.encodeSync(SessionMessage.Message)
const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }
const it = testEffect(Layer.empty)

// Rollback may only restore files through the SessionFileMutation journal
// (V2 Session Core contract). These tests pin the wired runtime behavior:
// Files restore immediately; messages stay recoverable until a new prompt commits.

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
  const sessions = SessionV2.layer.pipe(
    Layer.provide(content),
    Layer.provide(events),
    Layer.provide(database),
    Layer.provide(store),
    Layer.provide(projects),
    Layer.provide(journal),
    Layer.provide(SessionExecution.noopLayer),
  )
  return effect.pipe(
    Effect.provide(
      Layer.mergeAll(
        database,
        filesystem,
        activeLocation,
        resolution,
        mutation,
        content,
        journal,
        events,
        projector,
        store,
        projects,
        sessions,
      ),
    ),
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
  new SessionMessage.User({ id, type: "user", text: "turn", files: [], agents: [], time: { created } })

const assistantMessage = (id: SessionMessage.ID) =>
  new SessionMessage.Assistant({ id, type: "assistant", agent: "build", model, content: [], time: { created } })

const writeAndRecord = (input: {
  readonly path: string
  readonly content: string
  readonly sessionID: SessionV2.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly callID: string
}) =>
  Effect.gen(function* () {
    const target = yield* (yield* LocationMutation.Service).resolve({ path: input.path })
    const result = yield* (yield* FileMutation.Service).write({ target, content: input.content })
    yield* (yield* SessionFileMutation.Service).record({
      sessionID: input.sessionID,
      assistantMessageID: input.assistantMessageID,
      callID: input.callID,
      mutations: [result.mutation],
    })
  })

describe("SessionV2 rollback with the file journal wired", () => {
  it.live("keeps rollback recoverable, restores both, and commits only on a new prompt", () =>
    withTmp((directory) =>
      provide(
        directory,
        Effect.gen(function* () {
          const db = (yield* Database.Service).db
          yield* db
            .insert(ProjectTable)
            .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make(directory), sandboxes: [] })
            .run()
            .pipe(Effect.orDie)
          const sessionID = SessionV2.ID.make("ses_rollback_files")
          const firstUserID = SessionMessage.ID.make("msg_rollback_files_user_1")
          const firstAssistantID = SessionMessage.ID.make("msg_rollback_files_assistant_1")
          const secondUserID = SessionMessage.ID.make("msg_rollback_files_user_2")
          const secondAssistantID = SessionMessage.ID.make("msg_rollback_files_assistant_2")
          yield* db
            .insert(SessionTable)
            .values({
              id: sessionID,
              project_id: ProjectV2.ID.global,
              slug: "test",
              directory,
              title: "test",
              version: "test",
            })
            .run()
            .pipe(Effect.orDie)
          yield* db
            .insert(SessionMessageTable)
            .values([
              messageRow(userMessage(firstUserID), sessionID, 1),
              messageRow(assistantMessage(firstAssistantID), sessionID, 2),
              messageRow(userMessage(secondUserID), sessionID, 3),
              messageRow(assistantMessage(secondAssistantID), sessionID, 4),
            ])
            .run()
            .pipe(Effect.orDie)

          yield* Effect.promise(() => fs.writeFile(path.join(directory, "tracked.txt"), "initial"))
          yield* writeAndRecord({
            path: "tracked.txt",
            content: "base",
            sessionID,
            assistantMessageID: firstAssistantID,
            callID: "call-first-write",
          })
          yield* writeAndRecord({
            path: "tracked.txt",
            content: "ours",
            sessionID,
            assistantMessageID: secondAssistantID,
            callID: "call-write",
          })
          yield* writeAndRecord({
            path: "created.txt",
            content: "created",
            sessionID,
            assistantMessageID: secondAssistantID,
            callID: "call-create",
          })

          const session = yield* SessionV2.Service
          yield* session.rollback({ sessionID, messageID: secondUserID })

          expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "tracked.txt"), "utf8"))).toBe("base")
          expect(
            yield* Effect.promise(() =>
              fs.stat(path.join(directory, "created.txt")).then(
                () => true,
                () => false,
              ),
            ),
          ).toBe(false)
          expect((yield* session.messages({ sessionID, order: "asc" })).map((message) => message.id)).toEqual([
            firstUserID,
            firstAssistantID,
            secondUserID,
            secondAssistantID,
          ])
          expect((yield* session.get(sessionID)).revert).toMatchObject({
            messageID: secondUserID,
            status: "reverted",
            fileAction: "journal",
          })
          // An exact retry must not restore files twice.
          yield* session.rollback({ sessionID, messageID: secondUserID })
          yield* session.unrevert({ sessionID })
          expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "tracked.txt"), "utf8"))).toBe("ours")
          expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "created.txt"), "utf8"))).toBe("created")
          expect((yield* session.get(sessionID)).revert).toBeUndefined()
          yield* session.rollback({ sessionID, messageID: secondUserID })
          yield* Effect.promise(() => fs.writeFile(path.join(directory, "tracked.txt"), "external"))
          const failedTransition = yield* session.rollback({ sessionID, messageID: firstUserID }).pipe(Effect.exit)
          expect(failedTransition._tag).toBe("Failure")
          if (failedTransition._tag === "Failure")
            expect(Cause.squash(failedTransition.cause)).toBeInstanceOf(SessionV2.RollbackBlockedError)
          expect((yield* session.get(sessionID)).revert).toMatchObject({
            messageID: secondUserID,
            status: "reverted",
            fileAction: "journal",
          })
          expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "tracked.txt"), "utf8"))).toBe("external")
          yield* Effect.promise(() => fs.writeFile(path.join(directory, "tracked.txt"), "base"))
          expect((yield* session.rollback({ sessionID, messageID: firstUserID })).revert).toMatchObject({
            messageID: firstUserID,
            status: "reverted",
            fileAction: "journal",
          })
          expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "tracked.txt"), "utf8"))).toBe("initial")
          expect((yield* session.rollback({ sessionID, messageID: secondUserID })).revert).toMatchObject({
            messageID: secondUserID,
            status: "reverted",
            fileAction: "journal",
          })
          expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "tracked.txt"), "utf8"))).toBe("base")
          yield* Effect.promise(() => fs.writeFile(path.join(directory, "tracked.txt"), "external"))
          expect((yield* session.unrevert({ sessionID })).revert?.status).toBe("blocked")
          yield* Effect.promise(() => fs.writeFile(path.join(directory, "tracked.txt"), "base"))
          expect((yield* session.unrevert({ sessionID })).revert).toBeUndefined()
          expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "tracked.txt"), "utf8"))).toBe("ours")
          yield* session.rollback({ sessionID, messageID: secondUserID })
          const finalUserID = SessionMessage.ID.make("msg_rollback_no_file_changes")
          yield* db
            .insert(SessionMessageTable)
            .values(messageRow(userMessage(finalUserID), sessionID, 5))
            .run()
            .pipe(Effect.orDie)
          expect((yield* session.rollback({ sessionID, messageID: finalUserID })).revert).toMatchObject({
            messageID: finalUserID,
            status: "reverted",
            fileAction: "journal",
          })
          expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "tracked.txt"), "utf8"))).toBe("ours")
          const journalRows = yield* db.select().from(SessionFileMutationTable).all().pipe(Effect.orDie)
          yield* db.delete(SessionFileMutationTable).run().pipe(Effect.orDie)
          expect((yield* session.unrevert({ sessionID })).revert).toMatchObject({
            status: "blocked",
            blockedReason: "unattributed",
            fileAction: "journal",
          })
          expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "tracked.txt"), "utf8"))).toBe("ours")
          yield* db.insert(SessionFileMutationTable).values(journalRows).run().pipe(Effect.orDie)
          expect((yield* session.unrevert({ sessionID })).revert).toBeUndefined()
          yield* session.rollback({ sessionID, messageID: secondUserID })
          yield* session.prompt({
            sessionID,
            prompt: new Prompt({ text: "Continue from the checkpoint" }),
            resume: false,
          })
          expect((yield* session.messages({ sessionID, order: "asc" })).map((message) => message.id)).toEqual([
            firstUserID,
            firstAssistantID,
          ])
          expect((yield* session.get(sessionID)).revert).toBeUndefined()
        }),
      ),
    ),
  )
})
