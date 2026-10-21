/**
 * Wiring regression test for the session rollback file journal.
 *
 * The defect this guards against: `sessionRuntimeLayer` assembling the core
 * SessionV2 service WITHOUT SessionFileMutation, which silently degrades every
 * file-restoring rollback to blocked/unattributed. Removing the journal provide
 * in src/handlers.ts must turn this test red while the core-level behavior test
 * (packages/core/test/session-rollback-files.test.ts) stays green.
 *
 * Isolation follows the httpapi-exercise pattern: XDG roots and OPENCODE_DB are
 * redirected into a temp directory before the handler module (and its
 * module-load Global paths) are imported.
 */
import { afterAll, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Cause, DateTime, Effect, Layer, Schema } from "effect"
import type * as SessionMessageModule from "@opencode-ai/core/session/message"
import type * as SessionV2Module from "@opencode-ai/core/session"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-server-rollback-wiring-"))
process.env.XDG_DATA_HOME = path.join(root, "data")
process.env.XDG_CONFIG_HOME = path.join(root, "config")
process.env.XDG_STATE_HOME = path.join(root, "state")
process.env.XDG_CACHE_HOME = path.join(root, "cache")

const { Flag } = await import("@opencode-ai/core/flag/flag")
Flag.OPENCODE_DB = path.join(root, "opencode-test.db")

const { sessionRuntimeLayer } = await import("../src/handlers")
const { ContentStore } = await import("@opencode-ai/core/content-store")
const { Database } = await import("@opencode-ai/core/database/database")
const { FileMutation } = await import("@opencode-ai/core/file-mutation")
const { FSUtil } = await import("@opencode-ai/core/fs-util")
const { Global } = await import("@opencode-ai/core/global")
const { Location } = await import("@opencode-ai/core/location")
const { LocationMutation } = await import("@opencode-ai/core/location-mutation")
const { ModelV2 } = await import("@opencode-ai/core/model")
const { EventV2 } = await import("@opencode-ai/core/event")
const { Project } = await import("@opencode-ai/core/project")
const { ProjectV2 } = await import("@opencode-ai/core/project")
const { ProjectTable } = await import("@opencode-ai/core/project/sql")
const { AbsolutePath } = await import("@opencode-ai/core/schema")
const { SessionExecutionLocal } = await import("@opencode-ai/core/session/execution/local")
const { SessionActivity } = await import("@opencode-ai/core/session/activity")
const { SessionProjector } = await import("@opencode-ai/core/session/projector")
const { SessionV2 } = await import("@opencode-ai/core/session")
const { SessionFileMutation } = await import("@opencode-ai/core/session/file-mutation")
const { SessionMessage } = await import("@opencode-ai/core/session/message")
const { SessionMessageTable, SessionTable } = await import("@opencode-ai/core/session/sql")
const { SessionStore } = await import("@opencode-ai/core/session/store")
const { Snapshot } = await import("@opencode-ai/core/snapshot")
const { LocationServiceMap } = await import("@opencode-ai/core/location-layer")
const { ProviderV2 } = await import("@opencode-ai/core/provider")

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
})

// Writer-side journal built independently from the runtime's private layer.
// Effect memoizes the shared Database.defaultLayer reference, so both sides see
// one application database while the journal instances stay separate like the
// location-scoped tool writer and the session-side restorer in production.
const writerContent = ContentStore.layer.pipe(
  Layer.provide(Database.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Global.defaultLayer),
)
const writerJournal = SessionFileMutation.layer.pipe(
  Layer.provide(Database.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(writerContent),
)
const activeLocation = Layer.succeed(
  Location.Service,
  Location.Service.of({
    directory: AbsolutePath.make(root),
    workspaceID: undefined,
    project: { id: Project.ID.global, directory: AbsolutePath.make(root) },
    vcs: undefined,
  }),
)
const resolution = LocationMutation.layer.pipe(Layer.provide(FSUtil.defaultLayer), Layer.provide(activeLocation))

// Close the runtime's open requirements with the same public layers production
// handlerLayer uses. The file journal itself is NOT mirrored here: it must come
// from sessionRuntimeLayer's own wiring, which is exactly what this test pins.
const runtime = sessionRuntimeLayer.pipe(
  Layer.provide(SessionExecutionLocal.layer),
  Layer.provide(SessionActivity.layer),
  Layer.provide(SessionProjector.layer),
  Layer.provide(SessionStore.layer),
  Layer.provide(LocationServiceMap.layer.pipe(Layer.provide(SessionStore.layer))),
  Layer.provide(EventV2.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(Snapshot.defaultLayer),
)

const created = DateTime.makeUnsafe(0)
const encodeMessage = Schema.encodeSync(SessionMessage.Message)
const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }

function messageRow(message: SessionMessageModule.Message, sessionID: SessionV2Module.ID, seq: number) {
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

const userMessage = (id: SessionMessageModule.ID) =>
  new SessionMessage.User({ id, type: "user", text: "turn", files: [], agents: [], time: { created } })

const assistantMessage = (id: SessionMessageModule.ID) =>
  new SessionMessage.Assistant({ id, type: "assistant", agent: "build", model, content: [], time: { created } })

const writeAndRecord = (input: {
  readonly file: string
  readonly content: string
  readonly sessionID: SessionV2Module.ID
  readonly assistantMessageID: SessionMessageModule.ID
  readonly callID: string
}) =>
  Effect.gen(function* () {
    const target = yield* (yield* LocationMutation.Service).resolve({ path: input.file })
    const result = yield* (yield* FileMutation.Service).write({ target, content: input.content })
    yield* (yield* SessionFileMutation.Service).record({
      sessionID: input.sessionID,
      assistantMessageID: input.assistantMessageID,
      callID: input.callID,
      mutations: [result.mutation],
    })
  })

test("sessionRuntimeLayer restores journaled file writes on rollback", async () => {
  const program = Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db
      .insert(ProjectTable)
      .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make(root), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    const sessionID = SessionV2.ID.make("ses_rollback_wiring")
    const firstUserID = SessionMessage.ID.make("msg_rollback_wiring_user_1")
    const firstAssistantID = SessionMessage.ID.make("msg_rollback_wiring_assistant_1")
    const secondUserID = SessionMessage.ID.make("msg_rollback_wiring_user_2")
    const secondAssistantID = SessionMessage.ID.make("msg_rollback_wiring_assistant_2")
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: ProjectV2.ID.global,
        slug: "test",
        directory: root,
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

    yield* Effect.promise(() => fs.writeFile(path.join(root, "tracked.txt"), "base"))
    yield* writeAndRecord({
      file: "tracked.txt",
      content: "ours",
      sessionID,
      assistantMessageID: secondAssistantID,
      callID: "call-write",
    })
    yield* writeAndRecord({
      file: "created.txt",
      content: "created",
      sessionID,
      assistantMessageID: secondAssistantID,
      callID: "call-create",
    })

    const session = yield* SessionV2.Service
    yield* session.rollback({ sessionID, messageID: secondUserID })

    expect(yield* Effect.promise(() => fs.readFile(path.join(root, "tracked.txt"), "utf8"))).toBe("base")
    expect(
      yield* Effect.promise(() =>
        fs.stat(path.join(root, "created.txt")).then(
          () => true,
          () => false,
        ),
      ),
    ).toBe(false)
    expect((yield* session.get(sessionID)).revert).toMatchObject({
      messageID: secondUserID,
      status: "reverted",
      fileAction: "journal",
    })
    expect((yield* session.messages({ sessionID, order: "asc" })).map((message) => message.id)).toEqual([
      firstUserID,
      firstAssistantID,
      secondUserID,
      secondAssistantID,
    ])
    yield* session.cleanupRevert(sessionID)
    const remaining = yield* session.messages({ sessionID, order: "asc" })
    expect(remaining.map((message) => message.id)).toEqual([firstUserID, firstAssistantID])
    expect((yield* session.get(sessionID)).revert).toBeUndefined()
  })

  const exit = await Effect.runPromiseExit(
    program.pipe(
      Effect.provide(
        Layer.mergeAll(
          runtime,
          writerJournal,
          resolution,
          activeLocation,
          FileMutation.layer.pipe(Layer.provide(FSUtil.defaultLayer)),
          Database.defaultLayer,
        ),
      ),
    ),
  )
  if (exit._tag === "Failure") console.error(Cause.pretty(exit.cause))
  expect(exit._tag).toBe("Success")
})
