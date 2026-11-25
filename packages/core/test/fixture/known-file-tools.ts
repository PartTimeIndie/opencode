import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { DateTime, Effect, Layer, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { FileKnowledge } from "@opencode-ai/core/file-knowledge"
import { FileMutation } from "@opencode-ai/core/file-mutation"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Location } from "@opencode-ai/core/location"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { Image } from "@opencode-ai/core/image"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { WorkspaceCheckout } from "@opencode-ai/core/session/workspace/checkout"
import { SessionTable, SessionMessageTable } from "@opencode-ai/core/session/sql"
import { ReadTool } from "@opencode-ai/core/tool/read"
import { ReadToolFileSystem } from "@opencode-ai/core/tool/read-filesystem"
import { WriteTool } from "@opencode-ai/core/tool/write"
import { EditTool } from "@opencode-ai/core/tool/edit"
import { ApplyPatchTool } from "@opencode-ai/core/tool/apply-patch"
import { AgentV2 } from "@opencode-ai/core/agent"
import { location } from "./location"

export type Call = { name: "read" | "write" | "edit" | "apply_patch"; input: unknown; withoutCutoff?: boolean }
type Client = {
  call: (call: Call) => Effect.Effect<ToolRegistry.Settlement>
  batch: (calls: Call[]) => Effect.Effect<ToolRegistry.Settlement[]>
}
export function withKnownFileTools<A, E>(
  directory: string,
  body: (harness: {
    call: Client["call"]
    batch: Client["batch"]
    newSession: (id: string) => Effect.Effect<Client>
    database: Database.Interface
    store: ReturnType<typeof FileKnowledge.make>
    afterPermission: (effect: Effect.Effect<void>) => void
  }) => Effect.Effect<A, E>,
) {
  const database = Database.layerFromPath(":memory:")
  let afterPermission: Effect.Effect<void> = Effect.void
  const permission = Layer.succeed(
    PermissionV2.Service,
    PermissionV2.Service.of({
      assert: () => Effect.suspend(() => afterPermission),
      ask: () => Effect.die("unused"),
      reply: () => Effect.die("unused"),
      materializationRules: () => Effect.succeed([]),
      get: () => Effect.die("unused"),
      forSession: () => Effect.die("unused"),
      list: () => Effect.die("unused"),
    }),
  )
  const base = Layer.mergeAll(
    database,
    WorkspaceCheckout.layer,
    permission,
    FSUtil.defaultLayer,
    Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
    Layer.succeed(
      Image.Service,
      Image.Service.of({ normalize: () => Effect.fail(new Image.ResizerUnavailableError()) }),
    ),
  )
  const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(permission))
  const resolution = LocationMutation.layer.pipe(Layer.provide(base))
  const files = FileMutation.layer.pipe(Layer.provide(base))
  const reader = ReadToolFileSystem.layer.pipe(Layer.provide(base))
  const dependencies = Layer.mergeAll(base, registry, resolution, files, reader)
  const tools = Layer.mergeAll(ReadTool.layer, WriteTool.layer, EditTool.layer, ApplyPatchTool.layer).pipe(
    Layer.provide(dependencies),
  )
  return Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const registry = yield* ToolRegistry.Service
    const store = FileKnowledge.make(db)
    yield* db
      .insert(ProjectTable)
      .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make(directory), sandboxes: [] })
      .run()
      .pipe(Effect.orDie)
    const newSession = (id: string) =>
      Effect.gen(function* () {
        const sessionID = SessionSchema.ID.make(id)
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: ProjectV2.ID.global,
            slug: sessionID,
            directory,
            title: "known tools",
            version: "test",
          })
          .run()
          .pipe(Effect.orDie)
        let seq = 0
        const outputs: { id: string; text: string }[] = []
        const batch = (calls: Call[]) =>
          Effect.gen(function* () {
            const fileKnowledgeCutoff = yield* store.deliver(sessionID, outputs).pipe(Effect.orDie)
            const assistantMessageID = SessionMessage.ID.make(`msg_${sessionID}_${++seq}`)
            const message = Schema.encodeSync(SessionMessage.Message)(
              new SessionMessage.Assistant({
                id: assistantMessageID,
                type: "assistant",
                agent: "build",
                model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
                content: [],
                time: { created: DateTime.makeUnsafe(0) },
              }),
            )
            const { id, type, ...data } = message
            yield* db
              .insert(SessionMessageTable)
              .values({ id: SessionMessage.ID.make(id), session_id: sessionID, seq, type, data })
              .run()
              .pipe(Effect.orDie)
            const materialized = yield* registry.materialize()
            return yield* Effect.forEach(
              calls,
              (call, index) =>
                Effect.gen(function* () {
                  const callID = `${seq}-${index}`
                  const result = yield* materialized
                    .settle({
                      sessionID,
                      assistantMessageID,
                      agent: AgentV2.ID.make("build"),
                      fileKnowledgeCutoff: call.withoutCutoff ? undefined : fileKnowledgeCutoff,
                      call: { type: "tool-call", id: callID, name: call.name, input: call.input },
                    })
                    .pipe(Effect.orDie)
                  if (call.name === "read" && result.result.type === "text" && typeof result.result.value === "string")
                    outputs.push({ id: callID, text: result.result.value })
                  return result
                }),
              { concurrency: "unbounded" },
            )
          })
        return { batch, call: (call: Call) => batch([call]).pipe(Effect.map((results) => results[0]!)) }
      })
    return yield* body({
      ...(yield* newSession("ses_known_tools")),
      newSession,
      database,
      store,
      afterPermission: (effect) => {
        afterPermission = effect
      },
    })
  }).pipe(Effect.provide(Layer.mergeAll(dependencies, tools)))
}
