import { describe, expect, test } from "bun:test"
import path from "path"
import { LLM, LLMClient, LLMEvent, type LLMRequest, Message, Model, ToolFailure } from "@opencode-ai/llm"
import { route } from "@opencode-ai/llm/protocols/openai-chat"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Config } from "@opencode-ai/core/config"
import { ConfigOptimization } from "@opencode-ai/core/config/optimization"
import { ContentStore } from "@opencode-ai/core/content-store"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { FileAttachment, Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionRunCoordinator } from "@opencode-ai/core/session/run-coordinator"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { layer } from "@opencode-ai/core/session/runner/llm"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { Effect, Layer, Option, Schema, Stream } from "effect"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

const model = Model.make({
  id: "tool-context",
  provider: "fake",
  route: route.with({ limits: { context: 200_000, output: 4_000 } }),
})

let configEntries: Config.Entry[] = []
const config = Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed(configEntries) }))

const noisyLog = () => {
  const lines = ["$ deploy --project acme"]
  for (let index = 0; index < 320; index++)
    lines.push(
      `2026-09-21T10:${String(index % 60).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}Z step ${index}: compiling module ${index} ok`,
    )
  lines.push("2026-09-21T10:59:00Z ERROR connect ECONNREFUSED 127.0.0.1:3001 at src/a.ts:12")
  for (let index = 0; index < 320; index++)
    lines.push(
      `2026-09-21T10:${String(index % 60).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}Z step ${index}: emitting chunk ${index} ok`,
    )
  lines.push("2026-09-21T10:59:01Z error: deploy failed with exit code 1")
  return `${lines.join("\n")}\n`
}

const requests: LLMRequest[] = []
let responses: LLMEvent[][] = []
const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: (request) => {
      requests.push(request)
      const queued = responses.shift()
      if (queued === undefined) throw new Error("response queue exhausted")
      return Stream.fromIterable(queued)
    },
    generate: () => Effect.die("unused"),
  }),
)

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.void,
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    materializationRules: () => Effect.succeed([]),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const makeTools = (registry: Layer.Layer<ToolRegistry.Service>) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const registered = yield* ToolRegistry.Service
      yield* registered.register({
        noisy_echo: Tool.make({
          description: "Emit a large deploy log",
          input: Schema.Struct({ text: Schema.String }),
          output: Schema.Struct({ text: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
          execute: ({ text }) => Effect.sync(() => ({ text: noisyLog() + text })),
        }),
      })
    }),
  ).pipe(Layer.provide(permission), Layer.provide(registry))

const harness = <A, E, R>(body: (session: SessionV2.Interface, directory: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => {
      const database = Database.layerFromPath(":memory:")
      const global = Global.layerWith({ data: tmp.path })
      const contentStore = ContentStore.layer.pipe(
        Layer.provide(database),
        Layer.provide(FSUtil.defaultLayer),
        Layer.provide(global),
      )
      const toolOutputStore = ToolOutputStore.layer.pipe(
        Layer.provide(contentStore),
        Layer.provide(FSUtil.defaultLayer),
        Layer.provide(global),
        Layer.provide(config),
      )
      const events = EventV2.layer.pipe(Layer.provide(database))
      const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
      const store = SessionStore.layer.pipe(Layer.provide(database))
      const plugins = PluginV2.layer.pipe(Layer.provide(events))
      const applications = ApplicationTools.layer
      const registry = ToolRegistry.layer.pipe(
        Layer.provide(permission),
        Layer.provide(applications),
        Layer.provide(toolOutputStore),
        Layer.provideMerge(plugins),
      )
      const agents = AgentV2.layer
      const location = Location.layer({ directory: AbsolutePath.make(tmp.path) }).pipe(
        Layer.provide(Project.defaultLayer),
      )
      const systemContext = SystemContextRegistry.layer
      const skillGuidance = Layer.mock(SkillGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
      const referenceGuidance = Layer.mock(ReferenceGuidance.Service, {
        load: () => Effect.succeed(SystemContext.empty),
      })
      const models = SessionRunnerModel.layerWith(
        () => Effect.succeed(model),
        () => Effect.succeed(Option.none()),
        () => Effect.succeed([]),
      )
      const runner = layer.pipe(
        Layer.provide(database),
        Layer.provide(store),
        Layer.provide(events),
        Layer.provide(client),
        Layer.provide(permission),
        Layer.provideMerge(plugins),
        Layer.provide(registry),
        Layer.provide(toolOutputStore),
        Layer.provide(contentStore),
        Layer.provide(models),
        Layer.provide(systemContext),
        Layer.provide(location),
        Layer.provide(agents),
        Layer.provide(skillGuidance),
        Layer.provide(referenceGuidance),
        Layer.provide(config),
      )
      const coordinator = SessionRunCoordinator.layer.pipe(Layer.provide(runner))
      const execution = Layer.effect(
        SessionExecution.Service,
        SessionRunCoordinator.Service.pipe(
          Effect.map((coordinator) =>
            SessionExecution.Service.of({
              resume: coordinator.run,
              resumeOrJoin: coordinator.runOrJoin,
              wake: coordinator.wake,
              queueContinuation: coordinator.queueContinuation,
              wait: (sessionID) => coordinator.awaitIdle(sessionID).pipe(Effect.ignore),
              interrupt: coordinator.interrupt,
              interruptActivity: () => Effect.succeed(false),
              cancelTool: () => Effect.succeed(false),
            }),
          ),
        ),
      ).pipe(Layer.provide(coordinator))
      const sessions = SessionV2.layer.pipe(
        Layer.provide(contentStore),
        Layer.provide(events),
        Layer.provide(database),
        Layer.provide(store),
        Layer.provide(Project.defaultLayer),
        Layer.provide(execution),
      )
      const layers = Layer.mergeAll(
        database,
        events,
        projector,
        store,
        client,
        permission,
        plugins,
        applications,
        agents,
        registry,
        makeTools(registry),
        models,
        systemContext,
        location,
        skillGuidance,
        config,
        runner,
        coordinator,
        execution,
        sessions,
      )
      return Effect.gen(function* () {
        return yield* body(yield* SessionV2.Service, tmp.path)
      }).pipe(Effect.provide(layers))
    },
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const setup = (sessionID: SessionV2.ID, directory: string) =>
  Effect.gen(function* () {
    requests.length = 0
    responses = []
    configEntries = []
    const database = yield* Database.Service
    yield* database.db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make(directory), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* database.db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: sessionID,
        directory,
        title: "tool-context",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

const toolTurn = (id: string, name: string, input: object) => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.toolCall({ id, name, input }),
  LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
  LLMEvent.finish({ reason: "tool-calls" }),
]

const textTurn = (id: string, text: string) => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.textStart({ id }),
  LLMEvent.textDelta({ id, text }),
  LLMEvent.textEnd({ id }),
  LLMEvent.stepFinish({ index: 0, reason: "stop" }),
  LLMEvent.finish({ reason: "stop" }),
]

const toolMessageTexts = (request: LLMRequest | undefined) =>
  (request?.messages ?? [])
    .filter((message) => message.role === "tool")
    .flatMap((message) =>
      (Array.isArray(message.content) ? message.content : [message.content]).flatMap((content) => {
        if (typeof content === "string") return [content]
        const part = content as { type?: string; result?: unknown }
        if (
          part.type === "tool-result" &&
          part.result &&
          typeof part.result === "object" &&
          "value" in (part.result as Record<string, unknown>)
        ) {
          const value = (part.result as Record<string, unknown>).value
          if (typeof value === "string") return [value]
        }
        return []
      }),
    )

describe("tool-context recorded provider requests", () => {
  it.effect("passes only retained prepared-request group results into tool settlement", () =>
    harness((session, directory) =>
      Effect.gen(function* () {
        const sessionID = SessionV2.ID.make("ses_group_retained_request")
        yield* setup(sessionID, directory)
        const output = '<skill_group id="family" revision="fixture">direct descriptions</skill_group>'
        const observed: ReadonlyArray<string>[] = []
        const registry = yield* ToolRegistry.Service
        yield* registry.register({
          skill: Tool.make({
            description: "Controlled group context probe",
            input: Schema.Struct({ group: Schema.String }),
            output: Schema.Struct({ text: Schema.String }),
            toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
            execute: (_input, context) =>
              Effect.sync(() => {
                observed.push(context.skillGroupOutputs ?? [])
                return { text: output }
              }),
          }),
        })
        responses = [
          toolTurn("group-first", "skill", { group: "family" }),
          toolTurn("group-again", "skill", { group: "family" }),
          textTurn("group-done", "Done"),
        ]
        yield* session.prompt({
          sessionID,
          prompt: new Prompt({ text: "Open the fixture group twice" }),
          resume: false,
        })
        yield* session.resume(sessionID)
        expect(requests).toHaveLength(3)
        expect(observed).toEqual([[], [output]])
        expect(toolMessageTexts(requests[1])).toContain(output)
      }),
    ),
  )

  it.effect("on by default: continuation and replay both carry the compact view, originals stay session-owned", () =>
    harness((session, directory) =>
      Effect.gen(function* () {
        const sessionID = SessionV2.ID.make("ses_tc_default_on")
        yield* setup(sessionID, directory)
        responses = [toolTurn("call-noisy", "noisy_echo", { text: "go" }), textTurn("text-final", "Done")]

        yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Run the deploy" }), resume: false })
        yield* session.resume(sessionID)

        expect(requests.length).toBe(2)
        // the follow-up request (initial continuation) must carry the compact view
        const continuation = toolMessageTexts(requests[1]).join("\n")
        expect(continuation).toContain("omitted")
        expect(continuation).toContain("exit code 1")
        expect(continuation).not.toContain("compiling module 7 ok")

        // durable state keeps the session-owned original reference
        const context = yield* session.context(sessionID)
        const toolPart = context
          .flatMap((message) => (message.type === "assistant" ? message.content : []))
          .find(
            (item): item is Extract<typeof item, { type: "tool" }> => item.type === "tool" && item.id === "call-noisy",
          )
        expect(toolPart?.state.status).toBe("completed")
        const structured = (toolPart?.state as { structured?: Record<string, any> }).structured
        const contextView = structured?.$opencode?.contextView
        expect(contextView).toBeDefined()
        expect(contextView.original.ref).toStartWith("attachment://")
        expect(contextView.original.complete).toBe(true)
        expect(contextView.estimates.viewBytes).toBeLessThan(contextView.estimates.originalBytes)

        // the provider text channel itself names the session-owned original so the model can grep it
        const originalRef = contextView.original.ref as string
        expect(continuation).toContain(`Full original: ${originalRef}`)

        // replay: a second prompt must not re-expand the raw original
        responses = [textTurn("text-second", "Again done")]
        yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Summarize" }), resume: false })
        yield* session.resume(sessionID)
        const replay = toolMessageTexts(requests[2]).join("\n")
        expect(replay).toContain("omitted")
        expect(replay).not.toContain("compiling module 7 ok")
        expect(replay).toContain(`Full original: ${originalRef}`)
      }),
    ),
  )

  it.effect("explicit feature off: exact output, no contextView, no claimed savings", () =>
    harness((session, directory) =>
      Effect.gen(function* () {
        const sessionID = SessionV2.ID.make("ses_tc_off")
        yield* setup(sessionID, directory)
        configEntries = [
          new Config.Document({
            type: "document",
            info: new Config.Info({
              optimization: new ConfigOptimization.Info({
                features: new ConfigOptimization.Features({ tool_context_compression: false }),
              }),
            }),
          }),
        ]
        responses = [toolTurn("call-noisy-off", "noisy_echo", { text: "go" }), textTurn("text-final-off", "Done")]

        yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Run the deploy" }), resume: false })
        yield* session.resume(sessionID)

        expect(requests.length).toBe(2)
        const continuation = toolMessageTexts(requests[1]).join("\n")
        expect(continuation).toContain("compiling module 7 ok")
        expect(continuation).not.toContain("Full original:")

        const context = yield* session.context(sessionID)
        const toolPartOff = context
          .flatMap((message) => (message.type === "assistant" ? message.content : []))
          .find(
            (item): item is Extract<typeof item, { type: "tool" }> =>
              item.type === "tool" && item.id === "call-noisy-off",
          )
        const structured = (toolPartOff?.state as { structured?: Record<string, any> }).structured
        expect(structured?.$opencode?.contextView).toBeUndefined()
      }),
    ),
  )

  it.effect("file attachments and error results stay untouched by the view replacement", () =>
    harness((session, directory) =>
      Effect.gen(function* () {
        const sessionID = SessionV2.ID.make("ses_tc_media")
        yield* setup(sessionID, directory)
        responses = [textTurn("text-plain", "Just text")]
        yield* session.prompt({
          sessionID,
          prompt: new Prompt({
            text: "See attachment",
            files: [
              new FileAttachment({ uri: "data:image/png;base64,aGVsbG8=", mime: "image/png", name: "pixel.png" }),
            ],
          }),
          resume: false,
        })
        yield* session.resume(sessionID)
        // the recorded request still contains the user-attached media path
        expect(requests[0]).toBeDefined()
        expect(requests[0]!.messages[0]?.role).toBe("user")
      }),
    ),
  )
})
