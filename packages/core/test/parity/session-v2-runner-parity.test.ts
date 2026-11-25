import { describe, expect, test } from "bun:test"
import {
  AuthenticationReason,
  LLM,
  LLMClient,
  LLMError,
  LLMEvent,
  Message,
  Model,
  ProviderInternalReason,
  ToolFailure,
  TransportReason,
  type LLMRequest,
} from "@opencode-ai/llm"
import { route } from "@opencode-ai/llm/protocols/openai-chat"
import { Database } from "@opencode-ai/core/database/database"
import { FileKnowledge } from "@opencode-ai/core/file-knowledge"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { ModelV2 } from "@opencode-ai/core/model"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { QuestionV2 } from "@opencode-ai/core/question"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { ContentStore } from "@opencode-ai/core/content-store"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { FileAttachment, Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionRunCoordinator } from "@opencode-ai/core/session/run-coordinator"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { layer, shouldPublishGeneratedTitle } from "@opencode-ai/core/session/runner/llm"
import { SessionStore } from "@opencode-ai/core/session/store"
import {
  SessionActivityTable,
  SessionTable,
  SessionMessageTable,
  SessionInputTable,
  SessionContextEpochTable,
  TodoTable,
} from "@opencode-ai/core/session/sql"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Config } from "@opencode-ai/core/config"
import { ConfigCompaction } from "@opencode-ai/core/config/compaction"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Location } from "@opencode-ai/core/location"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { SurfaceTool } from "@opencode-ai/core/tool/surface"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { Cause, DateTime, Deferred, Effect, Fiber, Layer, Option, Schema, Stream } from "effect"
import { and, eq } from "drizzle-orm"
import { testEffect } from "../lib/effect"
import path from "path"

type ParityScenario = {
  readonly id: string
  readonly status: "active" | "pending"
  readonly owner?: string
}

const requiredScenarios = [
  "prompt-tool-loop-answer",
  "steering",
  "queue",
  "abort",
  "compaction-trigger",
  "revert",
  "question-tool",
  "permission-ask-deny",
  "permission-assert-decline",
  "task-shaped-tool-settlement",
  "real-subagent-task",
  "attachments",
  "retry-after-errors",
  "title-generation",
  "structured-output",
  "summary-file-diff",
] as const

const scenarios: readonly ParityScenario[] = [
  { id: "prompt-tool-loop-answer", status: "active" },
  { id: "steering", status: "active" },
  { id: "queue", status: "active" },
  { id: "abort", status: "active" },
  { id: "compaction-trigger", status: "active" },
  { id: "revert", status: "active" },
  { id: "question-tool", status: "active" },
  { id: "permission-ask-deny", status: "active" },
  { id: "permission-assert-decline", status: "active" },
  { id: "task-shaped-tool-settlement", status: "active" },
  { id: "real-subagent-task", status: "pending", owner: "Stage 2.5/4.1" },
  { id: "attachments", status: "active" },
  { id: "retry-after-errors", status: "active" },
  { id: "title-generation", status: "active" },
  { id: "structured-output", status: "active", owner: "Stage 4.3 session-runner.test.ts" },
  { id: "summary-file-diff", status: "active", owner: "Stage 4.3 session-runner.test.ts" },
]

const database = Database.layerFromPath(":memory:")
const global = Global.layerWith({ data: path.join(Global.Path.tmp, `session-runner-parity-${process.pid}`) })
const contentStore = ContentStore.layer.pipe(
  Layer.provide(database),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(global),
)
const toolOutputStore = ToolOutputStore.layer.pipe(
  Layer.provide(contentStore),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(global),
)
const events = EventV2.layer.pipe(Layer.provide(database))
const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
const store = SessionStore.layer.pipe(Layer.provide(database))
const requests: LLMRequest[] = []
let responses: LLMEvent[][] = []
let titleResponses: LLMEvent[][] = []
let streamGate: Deferred.Deferred<void> | undefined
let streamStarted: Deferred.Deferred<void> | undefined
let titleStreamGate: Deferred.Deferred<void> | undefined
let streamFailure: LLMError | undefined
let streamFailures: Array<LLMError | undefined> = []
const executions: string[] = []
const tasks: Array<{ readonly description: string; readonly prompt: string; readonly subagent_type: string }> = []
const permissionRequests: PermissionV2.AssertInput[] = []
const pendingPermissions = new Map<
  PermissionV2.ID,
  {
    readonly request: PermissionV2.Request
    readonly deferred: Deferred.Deferred<void, PermissionV2.DeclinedError | PermissionV2.CorrectedError>
  }
>()
let permissionDecision: "allow" | "ask" | "decline" | "deny" = "allow"

const permissionRequest = (input: PermissionV2.AssertInput): PermissionV2.Request => ({
  id: input.id ?? PermissionV2.ID.create(),
  sessionID: input.sessionID,
  action: input.action,
  resources: input.resources,
  save: input.save,
  metadata: input.metadata,
  source: input.source,
})

const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: (request) => {
      requests.push(request)
      const title = String(request.model.id) === "title-small"
      // Exhausted queues must fail loudly: a bare empty stream would now be treated
      // as a retryable empty completion and silently mask missing fixture turns.
      const next = (): LLMEvent[] => {
        const queued = title ? titleResponses.shift() : responses.shift()
        if (queued === undefined) throw new Error(`parity ${title ? "title " : ""}response queue exhausted`)
        return queued
      }
      if (titleStreamGate && title)
        return Stream.unwrap(Deferred.await(titleStreamGate).pipe(Effect.map(() => Stream.fromIterable(next()))))
      if (title) return Stream.fromIterable(next())
      const failure = streamFailures.length > 0 ? streamFailures.shift() : streamFailure
      const events = failure ? Stream.fail(failure) : Stream.fromIterable(next())
      if (!streamGate) return events
      return Stream.unwrap(
        (streamStarted ? Deferred.succeed(streamStarted, undefined) : Effect.void).pipe(
          Effect.andThen(Deferred.await(streamGate)),
          Effect.as(events),
        ),
      )
    },
    generate: () => Effect.die("unused"),
  }),
)

const model = Model.make({ id: "parity", provider: "fake", route })
const titleModel = Model.make({ id: "title-small", provider: "fake", route })
const recoveryModel = Model.make({
  id: "recovery",
  provider: "fake",
  route: route.with({ limits: { context: 20_000, output: 1_000 } }),
})
let currentModel = model
let currentModelFailure: SessionRunnerModel.Error | undefined
let currentSmallModel: Option.Option<Model> = Option.none()
let currentModelCost: ModelV2.Cost[] = []
const models = SessionRunnerModel.layerWith(
  () => (currentModelFailure ? Effect.fail(currentModelFailure) : Effect.succeed(currentModel)),
  () => Effect.succeed(currentSmallModel),
  () => Effect.succeed(currentModelCost),
)
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    ask: (input) =>
      Effect.sync(() => {
        permissionRequests.push(input)
        return {
          id: input.id ?? PermissionV2.ID.create(),
          effect: permissionDecision === "allow" ? "allow" : permissionDecision === "deny" ? "deny" : "ask",
        }
      }),
    assert: (input) =>
      Effect.gen(function* () {
        permissionRequests.push(input)
        if (permissionDecision === "deny") return yield* new PermissionV2.DeniedError({ rules: [] })
        if (permissionDecision === "decline") return yield* Effect.die(new PermissionV2.DeclinedError())
        if (permissionDecision === "allow") return
        const request = permissionRequest(input)
        const deferred = yield* Deferred.make<void, PermissionV2.DeclinedError | PermissionV2.CorrectedError>()
        pendingPermissions.set(request.id, { request, deferred })
        return yield* Deferred.await(deferred).pipe(
          Effect.catchTag("PermissionV2.DeclinedError", (error) => Effect.die(error)),
          Effect.ensuring(Effect.sync(() => pendingPermissions.delete(request.id))),
        )
      }),
    reply: (input) =>
      Effect.gen(function* () {
        const pending = pendingPermissions.get(input.requestID)
        if (!pending) return
        if (input.reply === "reject") {
          yield* Deferred.fail(pending.deferred, new PermissionV2.DeclinedError())
          pendingPermissions.delete(input.requestID)
          return
        }
        yield* Deferred.succeed(pending.deferred, undefined)
        pendingPermissions.delete(input.requestID)
      }),
    materializationRules: () => Effect.succeed([]),
    get: (id) => Effect.succeed(pendingPermissions.get(id)?.request),
    forSession: (sessionID) =>
      Effect.succeed(
        Array.from(pendingPermissions.values(), (item) => item.request).filter((item) => item.sessionID === sessionID),
      ),
    list: () => Effect.succeed(Array.from(pendingPermissions.values(), (item) => item.request)),
  }),
)
const applications = ApplicationTools.layer
const plugins = PluginV2.layer.pipe(Layer.provide(events))
const questions = QuestionV2.layer.pipe(Layer.provide(events), Layer.provide(database))
const registry = ToolRegistry.layer.pipe(
  Layer.provide(permission),
  Layer.provide(applications),
  Layer.provide(toolOutputStore),
  Layer.provideMerge(plugins),
)
const questionTool = SurfaceTool.layer.pipe(
  Layer.provide(registry),
  Layer.provide(permission),
  Layer.provide(questions),
)
const tools = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const permission = yield* PermissionV2.Service
    yield* registry.register({
      echo: Tool.make({
        description: "Echo text",
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
        toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
        execute: ({ text }) =>
          Effect.sync(() => {
            executions.push(text)
            return { text }
          }),
      }),
      permission_echo: Tool.make({
        description: "Echo text after permission assertion",
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
        toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
        execute: ({ text }, context) =>
          permission
            .assert({
              sessionID: context.sessionID,
              action: "parity.permission_echo",
              resources: [text],
              source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
            })
            .pipe(
              Effect.catch((error) =>
                error instanceof PermissionV2.DeniedError
                  ? Effect.fail(new ToolFailure({ message: "Permission denied: permission_echo" }))
                  : Effect.die(error),
              ),
              Effect.andThen(
                Effect.sync(() => {
                  executions.push(text)
                  return { text }
                }),
              ),
            ),
      }),
      task: Tool.make({
        description: "Task-shaped subagent call",
        input: Schema.Struct({
          description: Schema.String,
          prompt: Schema.String,
          subagent_type: Schema.String,
        }),
        output: Schema.Struct({ text: Schema.String }),
        toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
        execute: (input) =>
          Effect.sync(() => {
            tasks.push(input)
            return { text: `subagent ${input.subagent_type} complete` }
          }),
      }),
    })
  }),
).pipe(Layer.provide(permission), Layer.provide(registry))
const agents = AgentV2.layer
const location = Location.layer({ directory: AbsolutePath.make("/project") }).pipe(Layer.provide(Project.defaultLayer))
const systemContext = SystemContextRegistry.layer
const skillGuidance = Layer.mock(SkillGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const referenceGuidance = Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () =>
      Effect.succeed([
        new Config.Document({
          type: "document",
          info: new Config.Info({
            compaction: new ConfigCompaction.Info({
              buffer: 3_000,
              keep: new ConfigCompaction.Keep({ tokens: 1_000 }),
            }),
          }),
        }),
      ]),
  }),
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
const it = testEffect(
  Layer.mergeAll(
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
    questions,
    questionTool,
    tools,
    models,
    systemContext,
    location,
    skillGuidance,
    config,
    runner,
    coordinator,
    execution,
    sessions,
  ),
)

const reset = Effect.sync(() => {
  requests.length = 0
  responses = []
  titleResponses = []
  streamGate = undefined
  streamStarted = undefined
  titleStreamGate = undefined
  streamFailure = undefined
  streamFailures = []
  executions.length = 0
  tasks.length = 0
  permissionRequests.length = 0
  pendingPermissions.clear()
  permissionDecision = "allow"
  currentModel = model
  currentModelFailure = undefined
  currentSmallModel = Option.none()
  currentModelCost = []
})

const setup = (sessionID: SessionV2.ID) =>
  Effect.gen(function* () {
    yield* reset
    const database = yield* Database.Service
    yield* database.db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* database.db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: sessionID,
        directory: "/project",
        title: "parity",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    return yield* SessionV2.Service
  })

const openActivity = (sessionID: SessionV2.ID, id: string) =>
  Database.Service.use((database) =>
    database.db
      .insert(SessionActivityTable)
      .values({
        id,
        session_id: sessionID,
        status: "running",
        kind: "prompt",
        owner_id: `owner_${id}`,
        time_created: Date.now(),
        time_updated: Date.now(),
      })
      .run()
      .pipe(Effect.orDie),
  )

const textTurn = (id: string, text: string) => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.textStart({ id }),
  LLMEvent.textDelta({ id, text }),
  LLMEvent.textEnd({ id }),
  LLMEvent.stepFinish({ index: 0, reason: "stop" }),
  LLMEvent.finish({ reason: "stop" }),
]

const emptyTurn = () => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.textStart({ id: "text-parity-empty-turn" }),
  LLMEvent.stepFinish({ index: 0, reason: "stop" }),
  LLMEvent.finish({ reason: "stop" }),
]

const toolTurn = (id: string, name: string, input: object) => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.toolCall({ id, name, input }),
  LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
  LLMEvent.finish({ reason: "tool-calls" }),
]

const providerPatchErrorTurn = (id: string) => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.toolCall({
    id,
    name: "apply_patch",
    input: { patchText: "*** Begin Patch\n*** End Patch" },
    providerExecuted: true,
  }),
  LLMEvent.toolError({ id, name: "apply_patch", message: "apply_patch rejected: stale context" }),
  LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
  LLMEvent.finish({ reason: "tool-calls" }),
]

const providerPatchSuccessTurn = (id: string) => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.toolCall({
    id,
    name: "apply_patch",
    input: { patchText: "*** Begin Patch\n*** Update File: file.txt\n@@\n-old\n+new\n*** End Patch" },
    providerExecuted: true,
  }),
  LLMEvent.toolResult({
    id,
    name: "apply_patch",
    result: { type: "text", value: "Applied patch sequentially:\nM file.txt" },
    providerExecuted: true,
  }),
  LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
  LLMEvent.finish({ reason: "tool-calls" }),
]

const twoTextTurn = (firstID: string, first: string, secondID: string, second: string) => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.textStart({ id: firstID }),
  LLMEvent.textDelta({ id: firstID, text: first }),
  LLMEvent.textEnd({ id: firstID }),
  LLMEvent.textStart({ id: secondID }),
  LLMEvent.textDelta({ id: secondID, text: second }),
  LLMEvent.textEnd({ id: secondID }),
  LLMEvent.stepFinish({ index: 0, reason: "stop" }),
  LLMEvent.finish({ reason: "stop" }),
]

const providerUnavailable = () =>
  new LLMError({
    module: "parity",
    method: "stream",
    reason: new TransportReason({ message: "Provider unavailable" }),
  })

const providerOverloaded = () =>
  new LLMError({
    module: "parity",
    method: "stream",
    reason: new ProviderInternalReason({ message: "Provider overloaded", status: 503, retryAfterMs: 0 }),
  })

const retryableTransportUnavailable = () =>
  new LLMError({
    module: "parity",
    method: "stream",
    reason: new TransportReason({
      message: "WebSocket closed before the first event",
      kind: "close",
      canRetry: true,
    }),
  })

const authenticationFailed = () =>
  new LLMError({
    module: "parity",
    method: "stream",
    reason: new AuthenticationReason({ message: "Invalid API key", kind: "invalid" }),
  })

const userTexts = (request: LLMRequest) =>
  request.messages.flatMap((message) =>
    message.role === "user"
      ? message.content.flatMap((content) => (content.type === "text" ? [content.text] : []))
      : [],
  )

describe("SessionV2 runner parity manifest", () => {
  test("declares covered and pending Stage 1 parity work", () => {
    expect(scenarios.map((scenario) => scenario.id)).toEqual([...requiredScenarios])
    expect(scenarios.filter((scenario) => scenario.status === "pending")).toEqual([
      { id: "real-subagent-task", status: "pending", owner: "Stage 2.5/4.1" },
    ])
  })
})

describe("SessionV2 runner parity harness", () => {
  it.effect("covers prompt -> local tool loop -> final answer", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_parity_tool_loop")
      const session = yield* setup(sessionID)
      responses = [toolTurn("call-echo", "echo", { text: "hello" }), textTurn("text-final", "Done")]

      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Echo this" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0])).toEqual(["Echo this"])
      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
      expect(executions).toEqual(["hello"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Echo this" },
        { type: "assistant", content: [{ type: "tool", id: "call-echo", state: { status: "completed" } }] },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Done" }] },
      ])
    }),
  )

  ;["opencode", "opencode-go"].forEach((provider) => {
    it.effect(`preserves installed client attribution on the ${provider} request wire`, () =>
      Effect.gen(function* () {
        const sessionID = SessionV2.ID.make(`ses_parity_headers_${provider}`)
        const session = yield* setup(sessionID)
        currentModel = Model.make({ id: "parity", provider, route })
        responses = [textTurn("text-provider-headers", "Done")]

        yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Inspect headers" }), resume: false })
        yield* session.resume(sessionID)

        expect(requests).toHaveLength(1)
        const request = requests[0]
        const user = (yield* session.context(sessionID)).find((message) => message.type === "user")
        expect(user).toBeDefined()
        const prepared = yield* route.prepareTransport(yield* route.body.from(request), request)
        expect(prepared.request.headers).toMatchObject({
          "x-opencode-client": Flag.OPENCODE_CLIENT,
          "x-opencode-session": sessionID,
          "x-opencode-request": user?.id,
          "x-opencode-project": Project.ID.global,
        })
        expect(prepared.request.headers["user-agent"]).toContain("opencode/")
      }),
    )
  })

  for (const late of [false, true]) it.effect(
    `delivers host identity through tool follow-up, child, root resume and compaction without plugin hooks (late=${late})`,
    () =>
      Effect.gen(function* () {
        const rootID = SessionV2.ID.make("ses_host_identity_root")
        const childID = SessionV2.ID.make("ses_host_identity_child")
        const session = yield* setup(rootID)
        yield* setup(childID)
        currentModel = Model.make({ id: "parity", provider: "test", route: { ...route, runtimeContext: late ? "late-system" : undefined } })
        const database = yield* Database.Service
        yield* database.db
          .update(SessionTable)
          .set({ parent_id: rootID })
          .where(eq(SessionTable.id, childID))
          .run()
          .pipe(Effect.orDie)
        responses = [toolTurn("host-echo", "echo", { text: "ok" }), textTurn("host-final", "Done")]
        yield* session.prompt({
          sessionID: rootID,
          prompt: new Prompt({ text: "Inspect current host" }),
          resume: false,
        })
        yield* session.resume(rootID)
        const marker = "OpenCode host session (authoritative): "
        const identity = (request: LLMRequest) => {
          const entries = (late ? request.runtimeContext ?? [] : request.system).map((part) => part.text).filter((text) => text.startsWith(marker))
          if (late) expect(request.system.some((part) => part.text.startsWith(marker))).toBe(false)
          else expect(request.runtimeContext).toBeUndefined()
          if (late) expect(entries[0]).toContain("OpenCode host working directory: ")
          expect(entries).toHaveLength(1)
          return JSON.parse(entries[0]!.slice(marker.length).split("\n")[0]!)
        }
        expect(requests).toHaveLength(2)
        for (const request of requests)
          expect(identity(request)).toEqual({ app: "opencode", sessionID: rootID, parentSessionID: null, role: "main" })
        responses = [textTurn("host-child-final", "Reviewed")]
        yield* session.prompt({
          sessionID: childID,
          prompt: new Prompt({ text: "Delegated read-only review" }),
          resume: false,
        })
        yield* session.resume(childID)
        expect(identity(requests[2]!)).toEqual({
          app: "opencode",
          sessionID: childID,
          parentSessionID: rootID,
          role: "child",
        })
        responses = [textTurn("host-root-followup", "Continued")]
        yield* session.prompt({ sessionID: rootID, prompt: new Prompt({ text: "Continue" }), resume: false })
        yield* session.resume(rootID)
        expect(identity(requests[3]!)).toEqual({
          app: "opencode",
          sessionID: rootID,
          parentSessionID: null,
          role: "main",
        })
        responses = [textTurn("host-summary", "## Goal\nContinue current authorized task")]
        yield* session.compact({ sessionID: rootID })
        expect(requests).toHaveLength(5)
        expect(requests[4]!.system.some((part) => part.text.startsWith(marker))).toBe(false)
        expect(requests[4]!.runtimeContext).toBeUndefined()
        responses = [textTurn("host-post-compaction", "Resumed")]
        yield* session.prompt({
          sessionID: rootID,
          prompt: new Prompt({ text: "Resume after compaction" }),
          resume: false,
        })
        yield* session.resume(rootID)
        expect(identity(requests[5]!)).toEqual({
          app: "opencode",
          sessionID: rootID,
          parentSessionID: null,
          role: "main",
        })
      }),
  )

  for (const transformed of [false, true])
    it.effect(`binds file knowledge to the actual post-plugin provider request (transformed=${transformed})`, () =>
      Effect.gen(function* () {
        const sessionID = SessionV2.ID.make(`ses_parity_file_knowledge_${transformed}`)
        const session = yield* setup(sessionID)
        const store = FileKnowledge.make((yield* Database.Service).db)
        const registry = yield* ToolRegistry.Service
        const plugin = yield* PluginV2.Service
        const id = PluginV2.ID.make(`file-knowledge-${transformed}`)
        yield* registry.register({
          read: Tool.make({
            description: "Read receipt integration fixture",
            input: Schema.Struct({}),
            output: Schema.String,
            toModelOutput: ({ output }) => [{ type: "text", text: output }],
            execute: (_, context) =>
              store
                .recordRead({
                  sessionID: context.sessionID,
                  assistantMessageID: context.assistantMessageID,
                  callID: context.toolCallID,
                  target: "/project/a",
                  sha256: "fixture-version",
                  coverage: { ranges: [[1, 1]], end: 1 },
                  output: "visible file content",
                })
                .pipe(Effect.orDie, Effect.as("visible file content")),
          }),
          inspect_file_knowledge: Tool.make({
            description: "Inspect host request basis",
            input: Schema.Struct({}),
            output: Schema.String,
            toModelOutput: ({ output }) => [{ type: "text", text: output }],
            execute: (_, context) =>
              store.basisFor(context, "/project/a").pipe(
                Effect.orDie,
                Effect.map((basis) => {
                  const value = basis?.sha256 ?? "unknown"
                  executions.push(value)
                  return value
                }),
              ),
          }),
        })
        yield* plugin.add({
          id,
          effect: Effect.succeed({
            "experimental.chat.messages.transform": Effect.fn(function* (evt) {
              // After the empty provider turn, remove the read from retained context.
              // A successful finish must already have persisted its receipt.
              if (requests.length >= 2) {
                evt.messages = evt.messages.filter(
                  (message) =>
                    message.role !== "tool" ||
                    !message.content.some((part) => part.type === "tool-result" && part.name === "read"),
                )
                return
              }
              if (!transformed) return
              evt.messages = evt.messages.map((message) =>
                message.role !== "tool"
                  ? message
                  : {
                      ...message,
                      content: message.content.map((part) =>
                        part.type === "tool-result" && part.name === "read"
                          ? { ...part, result: { type: "text" as const, value: "shortened by plugin" } }
                          : part,
                      ),
                    },
              )
            }),
          }),
        })
        responses = [
          toolTurn("file-read", "read", {}),
          emptyTurn(),
          toolTurn("file-inspect", "inspect_file_knowledge", {}),
          textTurn("file-done", "Done"),
        ]
        yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Check file receipt delivery" }), resume: false })
        yield* session.resume(sessionID)
        expect(executions).toEqual([transformed ? "unknown" : "fixture-version"])
        expect(FileKnowledge.retainedReads(requests[1]!.messages)).toEqual([
          { id: "file-read", text: transformed ? "shortened by plugin" : "visible file content" },
        ])
        yield* plugin.remove(id)
      }),
    )

  for (const backend of ["google/gemini-fixture", "anthropic/fixture", "openrouter/fixture"])
    it.effect(`SDK backend ID does not change ordinary request routing: ${backend}`, () =>
      Effect.gen(function* () {
        const { createOpenAI } = yield* Effect.promise(() => import("@ai-sdk/openai"))
        const { model } = yield* Effect.promise(() => import("../plugin/provider-helper"))
        const { SessionRunnerAISDK } = yield* Effect.promise(() => import("@opencode-ai/core/session/runner/aisdk"))
        const bodies: string[] = []
        const language = createOpenAI({
          apiKey: "fixture-not-a-secret",
          fetch: Object.assign(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
            bodies.push(String(init?.body))
            return new Response('data: {"choices":[{"index":0,"delta":{"content":"Done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
              { headers: { "content-type": "text/event-stream" } })
          }, { preconnect: fetch.preconnect }),
        }).chat(backend)
        const plugin = yield* PluginV2.Service
        const id = PluginV2.ID.make("sdk-namespace-probe")
        yield* plugin.add({ id, effect: Effect.succeed({
          "chat.params": (event) => Effect.sync(() => { event.options = { parallelToolCalls: false } }),
        }) })
        const sessionID = SessionV2.ID.make("ses_sdk_namespace")
        const session = yield* setup(sessionID)
        currentModel = SessionRunnerModel.fromAISDKModel(model("openai", "fixture"), language)
        responses = [textTurn("sdk-namespace", "Done")]
        yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Preserve OpenAI options" }), resume: false })
        yield* session.resume(sessionID)
        const prepared = requests[0]
        if (!prepared) return yield* Effect.die("Missing prepared runner request")
        expect(prepared.providerOptions?.openai?.parallelToolCalls).toBe(false)
        expect(prepared.providerOptions?.gemini).toBeUndefined()
        expect(prepared.providerOptions?.anthropic).toBeUndefined()
        expect(prepared.generation?.maxTokens).not.toBe(2048)
        yield* SessionRunnerAISDK.stream(language, prepared).pipe(Stream.runDrain)
        expect(bodies).toHaveLength(1)
        expect(JSON.parse(bodies[0] ?? "{}").parallel_tool_calls).toBe(false)
        yield* plugin.remove(id)
      }),
    )

  for (const late of [false, true]) it.effect(`applies plugin chat request hooks before streaming (late=${late})`, () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const id = PluginV2.ID.make("runner-chat-hooks")
      yield* plugin.add({
        id,
        effect: Effect.succeed({
          "experimental.chat.system.transform": Effect.fn(function* (evt) {
            evt.system.push("hook system")
          }),
          "experimental.chat.messages.transform": Effect.fn(function* (evt) {
            evt.messages.push(Message.user("hook message"))
          }),
          "chat.params": Effect.fn(function* (evt) {
            evt.temperature = 0.25
            evt.topP = 0.75
            evt.topK = 12
            evt.frequencyPenalty = 0.1
            evt.presencePenalty = 0.2
            evt.seed = 42
            evt.stop = ["STOP"]
            evt.maxOutputTokens = 123
            evt.options = { openai: { hookOption: true } }
          }),
          "chat.headers": Effect.fn(function* (evt) {
            evt.headers["x-plugin-hook"] = "yes"
          }),
        }),
      })

      const sessionID = SessionV2.ID.make("ses_parity_plugin_chat")
      const session = yield* setup(sessionID)
      currentModel = Model.make({ id: "parity", provider: "test", route: { ...route, runtimeContext: late ? "late-system" : undefined } })
      responses = [textTurn("text-plugin-hooks", "Hooks applied")]

      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Use hooks" }), resume: false })
      yield* session.resume(sessionID)

      const request = requests[0]
      expect(request).toBeDefined()
      if (!request) return
      expect(request.system.map((part) => part.text)).toContain("hook system")
      expect((late ? request.runtimeContext : request.system)?.at(-1)?.text).toStartWith("OpenCode host session (authoritative): ")
      expect(userTexts(request)).toEqual(["Use hooks", "hook message"])
      expect(request.generation?.temperature).toBe(0.25)
      expect(request.generation?.topP).toBe(0.75)
      expect(request.generation?.topK).toBe(12)
      expect(request.generation?.frequencyPenalty).toBe(0.1)
      expect(request.generation?.presencePenalty).toBe(0.2)
      expect(request.generation?.seed).toBe(42)
      expect(request.generation?.stop).toEqual(["STOP"])
      expect(request.generation?.maxTokens).toBe(123)
      expect(request.providerOptions?.openai?.hookOption).toBe(true)
      expect(request.http?.headers?.["x-session-affinity"]).toBe(sessionID)
      expect(request.http?.headers?.["X-Session-Id"]).toBe(sessionID)
      expect(request.http?.headers?.["User-Agent"]).toContain("opencode/")
      expect(request.http?.headers?.["x-plugin-hook"]).toBe("yes")
      yield* plugin.remove(id)
    }),
  )

  it.effect("applies plugin tool execute hooks around local settlement", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const id = PluginV2.ID.make("runner-tool-hooks")
      yield* plugin.add({
        id,
        effect: Effect.succeed({
          "tool.execute.before": Effect.fn(function* (evt) {
            if (evt.tool !== "echo") return
            evt.args = { text: "hooked" }
          }),
          "tool.execute.after": Effect.fn(function* (evt) {
            if (evt.tool !== "echo") return
            evt.result = { type: "text", value: "after hook" }
            evt.output = { structured: { text: "after hook" }, content: [{ type: "text", text: "after hook" }] }
          }),
        }),
      })

      const sessionID = SessionV2.ID.make("ses_parity_plugin_tool")
      const session = yield* setup(sessionID)
      responses = [toolTurn("call-echo", "echo", { text: "original" }), textTurn("text-final", "Done")]

      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Echo this" }), resume: false })
      yield* session.resume(sessionID)

      expect(executions).toEqual(["hooked"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Echo this" },
        {
          type: "assistant",
          content: [{ type: "tool", state: { status: "completed", content: [{ text: "after hook" }] } }],
        },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Done" }] },
      ])
      yield* plugin.remove(id)
    }),
  )

  it.effect("covers steering while a provider turn is active", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_parity_steering")
      const session = yield* setup(sessionID)
      responses = [textTurn("text-steering-first", "Starting"), textTurn("text-steering-second", "Redirected")]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Start working" }), resume: false })
      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Change direction" }) })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined
      streamStarted = undefined
      yield* Effect.yieldNow

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0])).toEqual(["Start working"])
      expect(userTexts(requests[1])).toEqual(["Start working", "Change direction"])
    }),
  )

  it.effect("covers queued delivery at the next turn boundary while the activity runs", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_parity_queue")
      const session = yield* setup(sessionID)
      responses = [
        toolTurn("call-echo", "echo", { text: "queued" }),
        textTurn("text-queue-first", "Queued activity complete"),
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Start working" }), resume: false })
      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Wait until the next activity" }),
        delivery: "queue",
      })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0])).toEqual(["Start working"])
      expect(userTexts(requests[1])).toEqual(["Start working", "Wait until the next activity"])
    }),
  )

  it.effect("covers interrupt preserving durable steering input for later resume", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_parity_abort")
      const session = yield* setup(sessionID)
      const database = yield* Database.Service
      responses = [[], textTurn("text-after-interrupt", "Resumed")]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Interrupt current work" }), resume: false })
      const running = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Steer after interrupt" }) })
      yield* session.interrupt(sessionID)

      expect(yield* Fiber.await(running)).toMatchObject({ _tag: "Failure" })
      expect(yield* SessionInput.hasPending(database.db, sessionID, "steer")).toBe(true)

      streamStarted = yield* Deferred.make<void>()
      const resumed = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted).pipe(
        Effect.timeoutOrElse({
          duration: "5 seconds",
          orElse: () => Effect.fail(new Error("post-interrupt resume never reached provider stream")),
        }),
      )
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(resumed)
      streamGate = undefined
      streamStarted = undefined

      expect(userTexts(requests[1])).toEqual(["Interrupt current work", "Steer after interrupt"])
    }),
  )

  it.effect("manual SessionV2 compaction calls the summarizer and preserves durable state", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_manual_compaction_integration")
      const session = yield* setup(sessionID)
      const db = (yield* Database.Service).db
      currentModel = Model.make({
        id: "manual-summary",
        provider: "fake",
        route: route.with({ limits: { context: 100_000, output: 1_000 } }),
      })
      responses = [textTurn("earlier", "Original answer with open authorized work")]
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Original plan: preserve owner, queued input, and open work. ".repeat(500) }),
        resume: false,
      })
      yield* session.resume(sessionID)
      yield* db
        .insert(TodoTable)
        .values({
          session_id: sessionID,
          position: 0,
          content: "Finish the authorized plan",
          status: "in_progress",
          priority: "high",
        })
        .run()
        .pipe(Effect.orDie)
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Queued input must remain admitted" }),
        resume: false,
        delivery: "queue",
      })
      const messagesBefore = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      const inputsBefore = yield* db
        .select()
        .from(SessionInputTable)
        .where(eq(SessionInputTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      const activitiesBefore = yield* db
        .select()
        .from(SessionActivityTable)
        .where(eq(SessionActivityTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      const todosBefore = yield* db
        .select()
        .from(TodoTable)
        .where(eq(TodoTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      const epochBefore = yield* db
        .select()
        .from(SessionContextEpochTable)
        .where(eq(SessionContextEpochTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      const summary = "## Goal\n- Preserve the authorized plan\n## Next Steps\n- Finish the authorized plan"
      requests.length = 0
      responses = [textTurn("summary", summary)]
      yield* session.compact({ sessionID })
      expect(requests).toHaveLength(1)
      expect(userTexts(requests[0]).join("\n")).toContain("Finish the authorized plan")
      const messagesAfter = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      expect(messagesAfter.filter((row) => messagesBefore.some((old) => old.id === row.id))).toEqual(messagesBefore)
      expect(messagesAfter.find((row) => row.type === "compaction")?.data).toMatchObject({ summary })
      expect(
        yield* db
          .select()
          .from(SessionInputTable)
          .where(eq(SessionInputTable.session_id, sessionID))
          .all()
          .pipe(Effect.orDie),
      ).toEqual(inputsBefore)
      expect(
        yield* db
          .select()
          .from(SessionActivityTable)
          .where(eq(SessionActivityTable.session_id, sessionID))
          .all()
          .pipe(Effect.orDie),
      ).toEqual(activitiesBefore)
      expect(
        yield* db.select().from(TodoTable).where(eq(TodoTable.session_id, sessionID)).all().pipe(Effect.orDie),
      ).toEqual(todosBefore)
      const epochAfter = yield* db
        .select()
        .from(SessionContextEpochTable)
        .where(eq(SessionContextEpochTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      expect(epochBefore).toBeDefined()
      expect(epochAfter?.revision).toBeGreaterThan(epochBefore?.revision ?? -1)
      expect(epochAfter?.agent).toBe(epochBefore?.agent)
      responses = [emptyTurn()]
      const failed = yield* session.compact({ sessionID }).pipe(Effect.flip)
      expect(failed).toBeInstanceOf(SessionCompaction.SummaryFailed)
      if (failed instanceof SessionCompaction.SummaryFailed)
        expect(failed.reason).toBe("the provider returned an empty summary without usable text")
      expect(
        yield* db
          .select()
          .from(SessionInputTable)
          .where(eq(SessionInputTable.session_id, sessionID))
          .all()
          .pipe(Effect.orDie),
      ).toEqual(inputsBefore)
      expect(
        yield* db
          .select()
          .from(SessionContextEpochTable)
          .where(eq(SessionContextEpochTable.session_id, sessionID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual(epochAfter)
    }),
  )

  it.effect("automatic compaction false settles the actual runner with a finite preserved-history failure", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_auto_compaction_finite_failure")
      const session = yield* setup(sessionID)
      currentModel = Model.make({
        id: "finite-failure",
        provider: "fake",
        route: route.with({ limits: { context: 1_000, output: 100 } }),
      })
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Oversized original history ".repeat(2_000) }),
        resume: false,
      })
      expect(yield* session.resume(sessionID).pipe(Effect.timeout("3 seconds"), Effect.exit)).toMatchObject({
        _tag: "Failure",
      })
      expect(requests).toHaveLength(0)
      const messages = yield* session.messages({ sessionID, order: "asc" })
      expect(JSON.stringify(messages)).toContain("conversation is preserved")
      expect(messages.find((message) => message.type === "assistant")).toMatchObject({
        finish: "error",
        failure: { code: "provider.context-overflow", retryability: "resume" },
        error: { type: "unknown", message: expect.stringContaining("1000 input token budget") },
      })
      expect(
        messages.some((message) => message.type === "user" && message.text.includes("Oversized original history")),
      ).toBeTrue()
      // This adapter owns a real coordinator, but not LocalExecution activities.
      yield* session.wait(sessionID).pipe(Effect.timeout("3 seconds"))
      expect(requests).toHaveLength(0)
    }),
  )

  it.effect("covers compaction retry after provider context overflow", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_parity_compaction")
      const session = yield* setup(sessionID)
      responses = [textTurn("text-earlier", "Earlier answer")]
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Earlier question ".repeat(700) }),
        resume: false,
      })
      yield* session.resume(sessionID)

      // Keep enough context headroom to exercise provider-overflow recovery, not preflight compaction.
      currentModel = Model.make({
        id: "large-recovery",
        provider: "fake",
        route: route.with({ limits: { context: 1_000_000, output: 1_000 } }),
      })
      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
        ],
        textTurn("text-summary", "## Goal\n- Recover overflow"),
        textTurn("text-final", "Recovered"),
      ]

      yield* session.prompt({
        sessionID,
        prompt: new Prompt({
          text: "Continue",
          files: [new FileAttachment({ uri: "data:image/png;base64,cmVwbGF5", mime: "image/png" })],
        }),
        resume: false,
      })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(3)
      const finalUserTexts = userTexts(requests[2])
      expect(finalUserTexts).toHaveLength(1)
      expect(finalUserTexts[0]).toContain("<summary>\n## Goal\n- Recover overflow\n</summary>")
      expect(finalUserTexts[0]).toContain("[User]: Continue")
      expect(finalUserTexts[0]).toContain("[Attached image/png:")
      expect(finalUserTexts[0]).not.toContain("data:image/png")
      expect(yield* session.context(sessionID)).toMatchObject([
        {
          type: "compaction",
          summary: "## Goal\n- Recover overflow",
          recent: expect.stringContaining("[User]: Continue"),
        },
        { type: "assistant", finish: "stop" },
      ])
    }),
  )

  it.effect("includes committed same-turn content without replaying the user prompt", () =>
    Effect.gen(function* () {
      yield* reset
      const published: EventV2.Payload[] = []
      const compaction = SessionCompaction.make({
        events: {
          publish: (definition, data) =>
            Effect.sync(() => {
              const event = {
                id: EventV2.ID.create(),
                type: definition.type,
                data,
                seq: published.length + 1,
              } as EventV2.Payload<typeof definition>
              published.push(event)
              return event
            }),
          subscribe: () => Stream.empty,
          all: () => Stream.empty,
          aggregateEvents: () => Stream.empty,
          sync: () => Effect.succeed(Effect.void),
          listen: () => Effect.succeed(Effect.void),
          beforeCommit: () => Effect.void,
          project: () => Effect.void,
          registerCheckpointAdapter: () => Effect.void,
          replay: () => Effect.void,
          replayAll: () => Effect.succeed(undefined),
          createCheckpoint: () => Effect.succeed(undefined),
          checkpoint: () => Effect.succeed(undefined),
          compactCheckpoint: () => Effect.succeed(undefined),
          replayCheckpoint: () => Effect.succeed(undefined),
          remove: () => Effect.void,
          claim: () => Effect.void,
        },
        llm: {
          stream: (request) => {
            requests.push(request)
            return Stream.fromIterable(textTurn("text-direct-summary", "## Goal\n- Direct boundary"))
          },
        },
        config: [
          new Config.Document({
            type: "document",
            info: new Config.Info({
              compaction: new ConfigCompaction.Info({ keep: new ConfigCompaction.Keep({ tokens: 1 }) }),
            }),
          }),
        ],
      })
      const directModel = Model.make({
        id: "direct-boundary",
        provider: "fake",
        route: route.with({ limits: { context: 1_000_000, output: 1_000 } }),
      })
      const timestamp = DateTime.makeUnsafe(0)
      const replayUser = new SessionMessage.User({
        id: SessionMessage.ID.create(),
        type: "user",
        text: "Use tool then continue",
        time: { created: timestamp },
      })

      expect(
        yield* compaction.compactAfterOverflow({
          sessionID: SessionV2.ID.make("ses_direct_compaction_boundary"),
          entries: [
            {
              seq: 1,
              message: new SessionMessage.User({
                id: SessionMessage.ID.create(),
                type: "user",
                text: "Previous context",
                time: { created: timestamp },
              }),
            },
            { seq: 2, message: replayUser },
            {
              seq: 3,
              message: new SessionMessage.Assistant({
                id: SessionMessage.ID.create(),
                type: "assistant",
                agent: "build",
                model: { id: ModelV2.ID.make("direct-boundary"), providerID: ProviderV2.ID.make("fake") },
                content: [
                  new SessionMessage.AssistantText({ type: "text", id: "same-turn-text", text: "same-turn output" }),
                ],
                time: { created: timestamp, completed: timestamp },
              }),
            },
          ],
          model: directModel,
          request: LLM.request({ model: directModel, messages: [Message.user("oversized")], tools: [] }),
        }),
      ).toBe(true)

      const summaryInput = userTexts(requests[0]).join("\n")
      const checkpoint = published.find(
        (event): event is typeof SessionEvent.Compaction.Ended.Type =>
          event.type === SessionEvent.Compaction.Ended.type,
      )
      expect(summaryInput).toContain("Use tool then continue")
      expect(`${summaryInput}${checkpoint?.data.recent}`).toContain("same-turn output")
      expect(published.some((event) => event.type === SessionEvent.Prompted.type)).toBeFalse()
    }),
  )

  it.effect("does not replay removed dialogue or its compaction summary after rollback continuation", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_rollback_compaction")
      const session = yield* setup(sessionID)
      responses = [textTurn("keep-answer", "Keep answer"), textTurn("removed-answer", "Removed answer")]
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Keep original plan ".repeat(500) }),
        resume: false,
      })
      yield* session.resume(sessionID)
      const removed = yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Removed dialogue ".repeat(500) }),
        resume: false,
      })
      yield* session.resume(sessionID)
      responses = [textTurn("summary", "## Goal\n- Removed dialogue summary\n## Next Steps\n- Removed task")]
      yield* session.compact({ sessionID })
      expect((yield* session.context(sessionID)).some((message) => message.type === "compaction")).toBe(true)

      yield* session.rollback({ sessionID, messageID: removed.id, files: "messages_only" })
      requests.length = 0
      responses = [textTurn("replacement-answer", "Replacement complete")]
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Replacement after rollback" }), resume: false })
      yield* session.resume(sessionID)
      expect(requests).toHaveLength(1)
      expect(userTexts(requests[0]).join("\n")).toContain("Keep original plan")
      expect(userTexts(requests[0]).join("\n")).toContain("Replacement after rollback")
      expect(JSON.stringify(requests[0])).not.toContain("Removed dialogue")
      expect(JSON.stringify(requests[0])).not.toContain("Removed task")

      responses = [
        textTurn("replacement-summary", "## Goal\n- Keep original plan\n## Next Steps\n- Continue replacement"),
      ]
      yield* session.compact({ sessionID })
      requests.length = 0
      responses = [textTurn("after-summary", "Continued safely")]
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Continue after new compaction" }), resume: false })
      yield* session.resume(sessionID)
      expect(JSON.stringify(requests[0])).toContain("Continue after new compaction")
      expect(JSON.stringify(requests[0])).not.toContain("Removed dialogue")
      expect(JSON.stringify(requests[0])).not.toContain("Removed task")
    }),
  )

  it.effect("covers revert cleanup before post-revert continuation", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_parity_revert")
      const session = yield* setup(sessionID)
      responses = [textTurn("text-first", "First answer"), textTurn("text-second", "Second answer")]

      const first = yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Keep this" }), resume: false })
      yield* session.resume(sessionID)
      const second = yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Remove this" }), resume: false })
      yield* session.resume(sessionID)

      const beforeRevert = yield* session.context(sessionID)
      expect(beforeRevert).toMatchObject([
        { type: "user", text: "Keep this" },
        { type: "assistant", content: [{ type: "text", text: "First answer" }] },
        { type: "user", text: "Remove this" },
        { type: "assistant", content: [{ type: "text", text: "Second answer" }] },
      ])

      expect(yield* session.revert({ sessionID, messageID: second.id, files: "messages_only" })).toMatchObject({
        revert: { messageID: second.id },
      })
      expect(yield* session.context(sessionID)).toHaveLength(4)

      requests.length = 0
      responses = [textTurn("text-after-revert", "After revert")]
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Continue after revert" }), resume: false })
      yield* session.resume(sessionID)

      expect(userTexts(requests[0])).toEqual(["Keep this", "Continue after revert"])
      expect(userTexts(requests[0])).not.toContain("Remove this")
      expect(yield* session.context(sessionID)).toMatchObject([
        { id: first.id, type: "user", text: "Keep this" },
        { type: "assistant", content: [{ type: "text", text: "First answer" }] },
        { type: "user", text: "Continue after revert" },
        { type: "assistant", content: [{ type: "text", text: "After revert" }] },
      ])
      expect((yield* session.get(sessionID)).revert).toBeUndefined()

      const database = yield* Database.Service
      const durable = yield* database.db
        .select({ type: EventTable.type, data: EventTable.data })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      expect(durable.map((event) => event.type)).toEqual(
        expect.arrayContaining([
          EventV2.versionedType(SessionEvent.Revert.Marked.type, 1),
          EventV2.versionedType(SessionEvent.Revert.Cleaned.type, 1),
        ]),
      )
      const cleaned = durable.find((event) => event.type === EventV2.versionedType(SessionEvent.Revert.Cleaned.type, 1))
      const removedIDs = beforeRevert.slice(2).map((message) => message.id)
      expect(cleaned?.data.messageIDs).toEqual(expect.arrayContaining(removedIDs))
      expect((cleaned?.data.messageIDs as string[] | undefined)?.length).toBe(removedIDs.length)
    }),
  )

  it.effect("covers assistant part revert semantics and unrevert", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_parity_revert_part")
      const session = yield* setup(sessionID)
      responses = [twoTextTurn("text-first-part", "First part", "text-second-part", "Second part")]

      const first = yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Question" }), resume: false })
      yield* session.resume(sessionID)
      const assistant = (yield* session.context(sessionID)).find((message) => message.type === "assistant")
      if (!assistant || assistant.type !== "assistant") return yield* Effect.die("assistant message missing")

      expect(
        (yield* session.revert({ sessionID, messageID: assistant.id, partID: "missing-part" })).revert,
      ).toBeUndefined()
      expect(
        yield* session.revert({
          sessionID,
          messageID: assistant.id,
          partID: "text-first-part",
          files: "messages_only",
        }),
      ).toMatchObject({
        revert: { messageID: first.id },
      })
      expect(yield* session.unrevert({ sessionID })).toMatchObject({ revert: undefined })

      expect(
        yield* session.revert({
          sessionID,
          messageID: assistant.id,
          partID: "text-second-part",
          files: "messages_only",
        }),
      ).toMatchObject({
        revert: { messageID: assistant.id, partID: "text-second-part" },
      })
      responses = [textTurn("text-after-part-revert", "After partial revert")]
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Continue after partial revert" }), resume: false })
      yield* session.resume(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { id: first.id, type: "user", text: "Question" },
        { id: assistant.id, type: "assistant", content: [{ id: "text-first-part", text: "First part" }] },
        { type: "user", text: "Continue after partial revert" },
        { type: "assistant", content: [{ type: "text", text: "After partial revert" }] },
      ])

      const database = yield* Database.Service
      const durable = yield* database.db
        .select({ type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      expect(durable.map((event) => event.type)).toEqual(
        expect.arrayContaining([
          EventV2.versionedType(SessionEvent.Revert.Marked.type, 1),
          EventV2.versionedType(SessionEvent.Revert.Cleared.type, 1),
          EventV2.versionedType(SessionEvent.Revert.Cleaned.type, 1),
        ]),
      )
    }),
  )

  it.effect("rejects revert mutations while a Session activity is running", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_parity_revert_busy")
      const session = yield* setup(sessionID)
      const database = yield* Database.Service
      const revert = { messageID: SessionMessage.ID.make("msg_busy_revert") }
      yield* database.db
        .update(SessionTable)
        .set({ revert })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* database.db
        .insert(SessionActivityTable)
        .values({
          id: "act_busy_revert",
          session_id: sessionID,
          status: "running",
          kind: "resume",
          owner_id: "owner_busy_revert",
          lease_until: Date.now() + 60_000,
          heartbeat_at: Date.now(),
          time_created: Date.now(),
          time_updated: Date.now(),
        })
        .run()
        .pipe(Effect.orDie)

      const revertExit = yield* session
        .revert({ sessionID, messageID: SessionMessage.ID.make("msg_any_revert") })
        .pipe(Effect.exit)
      const unrevertExit = yield* session.unrevert({ sessionID }).pipe(Effect.exit)
      const cleanupExit = yield* session.cleanupRevert(sessionID).pipe(Effect.exit)

      for (const exit of [revertExit, unrevertExit, cleanupExit]) {
        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") expect(Cause.squash(exit.cause)).toBeInstanceOf(SessionV2.BusyError)
      }
    }),
  )

  it.effect("covers blocking Surface reply and continuation", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_parity_question_reply")
      const session = yield* setup(sessionID)
      const questions = yield* QuestionV2.Service
      const input = {
        mode: "blocking" as const,
        questions: [
          {
            question: "Which path?",
            options: [{ label: "Fast", description: "Continue quickly" }],
          },
        ],
      }
      responses = [toolTurn("call-question", "surface", input), textTurn("text-question", "Question handled")]

      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Ask before continuing" }), resume: false })
      yield* openActivity(sessionID, "act_parity_question_reply")
      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      let pending = yield* questions.list()
      while (pending.length === 0) {
        yield* Effect.yieldNow
        pending = yield* questions.list()
      }

      expect(pending).toMatchObject([{ sessionID, questions: input.questions, tool: { callID: "call-question" } }])
      yield* questions.reply({ requestID: pending[0]!.id, answers: [["Fast"]] })
      yield* Fiber.join(run)

      expect(requests).toHaveLength(2)
      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Ask before continuing" },
        { type: "assistant", content: [{ type: "tool", id: "call-question", state: { status: "completed" } }] },
        { type: "assistant", content: [{ type: "text", text: "Question handled" }] },
      ])
    }),
  )

  it.effect("covers blocking Surface rejection interrupting continuation", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_parity_question_reject")
      const session = yield* setup(sessionID)
      const questions = yield* QuestionV2.Service
      responses = [
        toolTurn("call-question-reject", "surface", {
          mode: "blocking",
          questions: [{ type: "confirm", question: "Proceed?" }],
        }),
      ]

      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Ask and stop if dismissed" }), resume: false })
      yield* openActivity(sessionID, "act_parity_question_reject")
      const run = yield* session.resume(sessionID).pipe(Effect.exit, Effect.forkChild)
      let pending = yield* questions.list()
      while (pending.length === 0) {
        yield* Effect.yieldNow
        pending = yield* questions.list()
      }

      yield* questions.reject(pending[0]!.id).pipe(Effect.timeout("1 second"))
      const exit = yield* Fiber.join(run).pipe(Effect.timeout("1 second"))

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Ask and stop if dismissed" },
        { type: "assistant", content: [{ type: "tool", id: "call-question-reject", state: { status: "error" } }] },
      ])
    }),
  )

  it.effect("covers permission ask reply and continuation", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_parity_permission_ask_reply")
      const session = yield* setup(sessionID)
      const permission = yield* PermissionV2.Service
      permissionDecision = "ask"
      responses = [
        toolTurn("call-permission", "permission_echo", { text: "needs approval" }),
        textTurn("text-permission", "Approved"),
      ]

      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Ask permission" }), resume: false })
      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      let pending = yield* permission.list()
      while (pending.length === 0) {
        yield* Effect.yieldNow
        pending = yield* permission.list()
      }

      expect(pending).toMatchObject([
        { sessionID, action: "parity.permission_echo", source: { callID: "call-permission" } },
      ])
      yield* permission.reply({ requestID: pending[0]!.id, reply: "once" })
      yield* Fiber.join(run)

      expect(executions).toEqual(["needs approval"])
      expect(requests).toHaveLength(2)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Ask permission" },
        { type: "assistant", content: [{ type: "tool", id: "call-permission", state: { status: "completed" } }] },
        { type: "assistant", content: [{ type: "text", text: "Approved" }] },
      ])
    }),
  )

  it.effect("covers permission ask rejection interrupting continuation", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_parity_permission_ask_reject")
      const session = yield* setup(sessionID)
      const permission = yield* PermissionV2.Service
      permissionDecision = "ask"
      responses = [toolTurn("call-permission-reject", "permission_echo", { text: "blocked" })]

      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Reject permission" }), resume: false })
      const run = yield* session.resume(sessionID).pipe(Effect.exit, Effect.forkChild)
      let pending = yield* permission.list()
      while (pending.length === 0) {
        yield* Effect.yieldNow
        pending = yield* permission.list()
      }

      yield* permission.reply({ requestID: pending[0]!.id, reply: "reject" })
      const exit = yield* Fiber.join(run)

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(executions).toEqual([])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Reject permission" },
        { type: "assistant", content: [{ type: "tool", id: "call-permission-reject", state: { status: "error" } }] },
      ])
    }),
  )

  it.effect("covers permission assertion allow, deny, and decline paths", () =>
    Effect.gen(function* () {
      const allowedID = SessionV2.ID.make("ses_parity_permission_allow")
      const allowed = yield* setup(allowedID)
      responses = [toolTurn("call-allowed", "permission_echo", { text: "safe" }), textTurn("text-allowed", "Allowed")]

      yield* allowed.prompt({ sessionID: allowedID, prompt: new Prompt({ text: "Call allowed" }), resume: false })
      yield* allowed.resume(allowedID)

      expect(permissionRequests).toHaveLength(1)
      expect(executions).toEqual(["safe"])

      const deniedID = SessionV2.ID.make("ses_parity_permission_deny")
      const denied = yield* setup(deniedID)
      permissionDecision = "deny"
      responses = [toolTurn("call-denied", "permission_echo", { text: "blocked" }), textTurn("text-denied", "Denied")]

      yield* denied.prompt({ sessionID: deniedID, prompt: new Prompt({ text: "Call denied" }), resume: false })
      yield* denied.resume(deniedID)

      expect(permissionRequests).toHaveLength(1)
      expect(executions).toEqual([])
      expect(yield* denied.context(deniedID)).toMatchObject([
        { type: "user", text: "Call denied" },
        { type: "assistant", content: [{ type: "tool", id: "call-denied", state: { status: "error" } }] },
        { type: "assistant", content: [{ type: "text", text: "Denied" }] },
      ])

      const declinedID = SessionV2.ID.make("ses_parity_permission_decline")
      const declined = yield* setup(declinedID)
      permissionDecision = "decline"
      responses = [toolTurn("call-declined", "permission_echo", { text: "blocked" })]

      yield* declined.prompt({ sessionID: declinedID, prompt: new Prompt({ text: "Call declined" }), resume: false })
      const exit = yield* declined.resume(declinedID).pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(permissionRequests).toHaveLength(1)
      expect(yield* declined.context(declinedID)).toMatchObject([
        { type: "user", text: "Call declined" },
        { type: "assistant", content: [{ type: "tool", id: "call-declined", state: { status: "error" } }] },
      ])
    }),
  )

  it.effect("covers task-shaped subagent tool calls", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_parity_subagent_task")
      const session = yield* setup(sessionID)
      // This locks the SessionRunner tool-settlement shape until the real task tool moves into Core.
      responses = [
        toolTurn("call-task", "task", {
          description: "Review change",
          prompt: "Read the diff",
          subagent_type: "review-gpt-high",
        }),
        textTurn("text-task", "Task complete"),
      ]

      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Delegate review" }), resume: false })
      yield* session.resume(sessionID)

      expect(tasks).toEqual([
        { description: "Review change", prompt: "Read the diff", subagent_type: "review-gpt-high" },
      ])
      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
    }),
  )

  it.effect("keeps the drain active after a rejected provider apply_patch", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_parity_apply_patch_reject")
      const session = yield* setup(sessionID)
      responses = [providerPatchErrorTurn("call-patch-reject"), providerPatchSuccessTurn("call-patch-success")]

      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Patch the file" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant"])
      expect(requests[1]?.messages[1]?.content).toMatchObject([
        { type: "tool-call", id: "call-patch-reject", providerExecuted: true },
        {
          type: "tool-result",
          id: "call-patch-reject",
          providerExecuted: true,
          result: { type: "error", value: { error: { message: "apply_patch rejected: stale context" } } },
        },
      ])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Patch the file" },
        { type: "assistant", content: [{ type: "tool", id: "call-patch-reject", state: { status: "error" } }] },
        { type: "assistant", content: [{ type: "tool", id: "call-patch-success", state: { status: "completed" } }] },
      ])
    }),
  )

  it.effect("covers attachment lowering into model input", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_parity_attachments")
      const session = yield* setup(sessionID)
      responses = [textTurn("text-attachment", "Saw it")]

      yield* session.prompt({
        sessionID,
        prompt: new Prompt({
          text: "Describe this image",
          files: [
            new FileAttachment({
              uri: "data:image/png;base64,aGVsbG8=",
              mime: "image/png",
              name: "pixel.png",
              description: "one pixel",
            }),
          ],
        }),
        resume: false,
      })
      yield* session.resume(sessionID)

      expect(requests[0]?.messages[0]?.content).toMatchObject([
        { type: "text", text: "Describe this image" },
        { type: "media", mediaType: "image/png", data: "data:image/png;base64,aGVsbG8=", filename: "pixel.png" },
      ])
    }),
  )

  it.effect("covers failed run fanout and later retry", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_parity_retry")
      const session = yield* setup(sessionID)
      streamFailure = providerUnavailable()
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Retry after failure" }), resume: false })
      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      const second = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Effect.yieldNow

      expect(requests).toHaveLength(1)
      yield* Deferred.succeed(streamGate, undefined)
      const exits = yield* Effect.all([Fiber.await(first), Fiber.await(second)])
      expect(exits[1]).toEqual(exits[0])

      streamFailure = undefined
      streamGate = undefined
      streamStarted = undefined
      responses = [textTurn("text-retry", "Recovered")]
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      const context = yield* session.context(sessionID)
      expect(context).toMatchObject([
        { type: "user", text: "Retry after failure" },
        { type: "assistant", finish: "error", error: { message: "Provider unavailable" } },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Recovered" }] },
      ])
    }),
  )

  it.live("retries retryable transport failures before surfacing an assistant error", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_parity_retryable_provider_failure")
      const session = yield* setup(sessionID)
      const { db } = yield* Database.Service
      streamFailures = [retryableTransportUnavailable()]
      responses = [textTurn("text-recovered", "Recovered")]

      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Retry transient failure" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Retry transient failure" },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Recovered" }] },
      ])
      const retried = yield* db
        .select()
        .from(EventTable)
        .where(
          and(
            eq(EventTable.aggregate_id, sessionID),
            eq(EventTable.type, EventV2.versionedType("session.next.retried", 1)),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      expect(retried).toHaveLength(1)
      expect(retried[0]?.data).toMatchObject({
        sessionID,
        attempt: 1,
        error: { message: "WebSocket closed before the first event", isRetryable: true },
      })
    }),
  )

  it.effect("surfaces non-retryable provider failures as visible assistant errors", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_parity_non_retryable_provider_failure")
      const session = yield* setup(sessionID)
      const { db } = yield* Database.Service
      streamFailure = authenticationFailed()

      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Fail visibly" }), resume: false })
      const exit = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail visibly" },
        { type: "assistant", finish: "error", error: { message: "Invalid API key" } },
      ])
      const retried = yield* db
        .select()
        .from(EventTable)
        .where(
          and(
            eq(EventTable.aggregate_id, sessionID),
            eq(EventTable.type, EventV2.versionedType("session.next.retried", 1)),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      expect(retried).toHaveLength(0)
    }),
  )

  it.effect("accumulates assistant usage and cost into the session row", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_parity_usage_cost")
      const session = yield* setup(sessionID)
      currentModelCost = [
        { input: 1, output: 2, cache: { read: 0.25, write: 0.5 } },
        { tier: { type: "context", size: 200_000 }, input: 10, output: 20, cache: { read: 2.5, write: 5 } },
      ]
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-usage" }),
          LLMEvent.textDelta({ id: "text-usage", text: "Usage tracked" }),
          LLMEvent.textEnd({ id: "text-usage" }),
          LLMEvent.stepFinish({
            index: 0,
            reason: "stop",
            usage: {
              inputTokens: 15,
              nonCachedInputTokens: 10,
              outputTokens: 8,
              reasoningTokens: 3,
              cacheReadInputTokens: 2,
              cacheWriteInputTokens: 3,
            },
          }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Track usage" }), resume: false })
      yield* session.resume(sessionID)

      const expectedTokens = { input: 10, output: 5, reasoning: 3, cache: { read: 2, write: 3 } }
      const info = yield* session.get(sessionID)
      expect(info.tokens).toEqual(expectedTokens)
      expect(info.cost).toBeCloseTo(0.000028)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Track usage" },
        { type: "assistant", finish: "stop", cost: 0.000028, tokens: expectedTokens },
      ])
    }),
  )

  it.effect("persists measured generation time on streamed steps and keeps tool-only steps unknown", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_parity_generation_time")
      const session = yield* setup(sessionID)
      // Scripted streams play instantly, so measured windows are sub-millisecond.
      // The contract here is wiring through the real runner: streamed steps carry
      // measured (zero) time, and tool-only steps stay unknown because bare
      // tool-call events must not count as provider token streaming.
      responses = [
        toolTurn("call-generation-echo", "echo", { text: "hello" }),
        textTurn("text-generation-final", "Done"),
      ]

      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Track generation time" }), resume: false })
      yield* session.resume(sessionID)

      const context = yield* session.context(sessionID)
      const assistants = context.filter((message): message is SessionMessage.Assistant => message.type === "assistant")
      const toolStep = assistants.find((message) => message.finish === "tool-calls")
      expect(toolStep?.tokenMeasurement).toBeUndefined()
      const finalStep = assistants.find((message) => message.finish === "stop")
      expect(finalStep?.tokenMeasurement).toMatchObject({ version: 1 })
      expect(typeof finalStep?.tokenMeasurement?.generationMilliseconds).toBe("number")
      expect(finalStep?.tokenMeasurement?.generationMilliseconds ?? 0).toBeLessThan(50)
    }),
  )

  it.effect("surfaces content-filter finishes as visible assistant errors while retaining usage", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_parity_content_filter")
      const session = yield* setup(sessionID)
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({
            index: 0,
            reason: "content-filter",
            usage: { inputTokens: 4, nonCachedInputTokens: 4, outputTokens: 0 },
          }),
          LLMEvent.finish({ reason: "content-filter" }),
        ],
      ]

      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Trigger filter" }), resume: false })
      expect(yield* session.resume(sessionID).pipe(Effect.exit)).toMatchObject({ _tag: "Failure" })

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Trigger filter" },
        {
          type: "assistant",
          finish: "error",
          error: { message: "The response was blocked by the provider's content filter" },
          failure: { code: "provider.content-policy", remediation: "continue" },
          tokens: { input: 4, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      ])
    }),
  )

  it.effect("recovers after five consecutive retryable provider errors", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_parity_retryable_provider_error_long_outage")
      const session = yield* setup(sessionID)
      const { db } = yield* Database.Service
      responses = [
        ...Array.from({ length: 5 }, () => [
          LLMEvent.providerError({ message: "Provider still overloaded", retryable: true, retryAfterMs: 0 }),
        ]),
        textTurn("text-recovered-after-long-outage", "Recovered after extended retries"),
      ]

      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Retry a longer provider outage" }),
        resume: false,
      })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(6)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Retry a longer provider outage" },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Recovered after extended retries" }] },
      ])
      const retried = yield* db
        .select()
        .from(EventTable)
        .where(
          and(
            eq(EventTable.aggregate_id, sessionID),
            eq(EventTable.type, EventV2.versionedType("session.next.retried", 1)),
          ),
        )
        .orderBy(EventTable.seq)
        .all()
        .pipe(Effect.orDie)
      expect(retried.map((event) => event.data)).toMatchObject([
        { attempt: 1 },
        { attempt: 2 },
        { attempt: 3 },
        { attempt: 4 },
        { attempt: 5 },
      ])
    }),
  )

  it.effect("recovers at the retry limit without replaying tool work", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_parity_retryable_provider_error_tool_barrier")
      const session = yield* setup(sessionID)
      const { db } = yield* Database.Service
      responses = [
        ...Array.from({ length: 5 }, (_, index) => [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: `call-provider-retry-${index}`, name: "echo", input: { text: `settled-${index}` } }),
          LLMEvent.providerError({ message: "Provider failed after tool work", retryable: true, retryAfterMs: 0 }),
        ]),
        textTurn("text-recovered-after-tool-barriers", "Recovered without replaying tools"),
      ]

      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Retry safely after tool work" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(6)
      expect(executions).toEqual(["settled-0", "settled-1", "settled-2", "settled-3", "settled-4"])
      expect((yield* session.context(sessionID)).filter((message) => message.type === "assistant")).toMatchObject([
        { content: [{ type: "tool", id: "call-provider-retry-0" }] },
        { content: [{ type: "tool", id: "call-provider-retry-1" }] },
        { content: [{ type: "tool", id: "call-provider-retry-2" }] },
        { content: [{ type: "tool", id: "call-provider-retry-3" }] },
        { content: [{ type: "tool", id: "call-provider-retry-4" }] },
        { finish: "stop", content: [{ type: "text", text: "Recovered without replaying tools" }] },
      ])
      const retried = yield* db
        .select()
        .from(EventTable)
        .where(
          and(
            eq(EventTable.aggregate_id, sessionID),
            eq(EventTable.type, EventV2.versionedType("session.next.retried", 1)),
          ),
        )
        .orderBy(EventTable.seq)
        .all()
        .pipe(Effect.orDie)
      expect(retried.map((event) => event.data)).toMatchObject([
        { attempt: 1 },
        { attempt: 2 },
        { attempt: 3 },
        { attempt: 4 },
        { attempt: 5 },
      ])
    }),
  )

  it.effect("surfaces retryable provider-error events after the retry budget is exhausted", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_parity_retryable_provider_error_exhausted")
      const session = yield* setup(sessionID)
      const { db } = yield* Database.Service
      responses = Array.from({ length: 6 }, () => [
        LLMEvent.providerError({ message: "Provider still overloaded", retryable: true, retryAfterMs: 0 }),
      ])

      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Retry provider error" }), resume: false })
      // After the shared budget is exhausted the barren error stream settles as
      // a typed runner failure so LocalExecution marks it failed, not completed.
      const result = yield* Effect.exit(session.resume(sessionID))

      expect(requests).toHaveLength(6)
      expect(result._tag).toBe("Failure")
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Retry provider error" },
        { type: "assistant", finish: "error", error: { message: "Provider still overloaded" } },
      ])
      const retried = yield* db
        .select()
        .from(EventTable)
        .where(
          and(
            eq(EventTable.aggregate_id, sessionID),
            eq(EventTable.type, EventV2.versionedType("session.next.retried", 1)),
          ),
        )
        .orderBy(EventTable.seq)
        .all()
        .pipe(Effect.orDie)
      expect(retried.map((event) => event.data)).toMatchObject([
        { attempt: 1 },
        { attempt: 2 },
        { attempt: 3 },
        { attempt: 4 },
        { attempt: 5 },
      ])
    }),
  )

  it.effect("retries a premature stream termination (no finish reason) and recovers", () =>
    Effect.gen(function* () {
      // Mirrors the GLM 5.2 symptom: the provider drops the SSE connection
      // before emitting a finish_reason or [DONE]. openai-chat.ts marks that
      // provider-error as retryable, so the runner should re-issue the request
      // and succeed when the second turn completes normally.
      const sessionID = SessionV2.ID.make("ses_parity_retry_premature_eof")
      const session = yield* setup(sessionID)
      const { db } = yield* Database.Service
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.providerError({
            message: "OpenAI Chat stream ended without a finish reason",
            retryable: true,
            retryAfterMs: 0,
          }),
        ],
        textTurn("text-recovered", "Recovered after retry"),
      ]

      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Retry EOF" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Retry EOF" },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Recovered after retry" }] },
      ])
      const retried = yield* db
        .select()
        .from(EventTable)
        .where(
          and(
            eq(EventTable.aggregate_id, sessionID),
            eq(EventTable.type, EventV2.versionedType("session.next.retried", 1)),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      expect(retried).toHaveLength(1)
    }),
  )

  it.effect("keeps provider errors visible when they arrive after step finish", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_parity_provider_error_after_step_finish")
      const session = yield* setup(sessionID)
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({
            index: 0,
            reason: "stop",
            usage: { inputTokens: 8, nonCachedInputTokens: 8, outputTokens: 2 },
          }),
          LLMEvent.providerError({ message: "Provider failed after finish" }),
        ],
      ]

      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Error after finish" }), resume: false })
      const exit = yield* session.resume(sessionID).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Error after finish" },
        { type: "assistant", finish: "error", error: { message: "Provider failed after finish" } },
      ])
    }),
  )

  it.effect("ignores a duplicated provider step finish", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_parity_duplicate_step_finish")
      const session = yield* setup(sessionID)
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "duplicate-step-finish-text" }),
          LLMEvent.textDelta({ id: "duplicate-step-finish-text", text: "Recovered" }),
          LLMEvent.textEnd({ id: "duplicate-step-finish-text" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Duplicate finish" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Duplicate finish" },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Recovered" }] },
      ])
    }),
  )

  it.effect("continues in a fresh provider turn after a retryable error follows a step finish", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_parity_retryable_after_step_finish")
      const session = yield* setup(sessionID)
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({
            index: 0,
            reason: "stop",
            usage: { inputTokens: 8, nonCachedInputTokens: 8, outputTokens: 2 },
          }),
          LLMEvent.providerError({ message: "Provider failed after finish", retryable: true, retryAfterMs: 0 }),
        ],
        textTurn("text-recovered-after-step-finish", "Recovered"),
      ]

      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Retry after finish" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Retry after finish" },
        { type: "assistant", finish: "error", error: { message: "Provider failed after finish" } },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Recovered" }] },
      ])
    }),
  )

  it.effect("subtracts usage when revert cleanup removes assistant messages", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_parity_revert_usage_decrement")
      const session = yield* setup(sessionID)
      currentModelCost = [{ input: 1, output: 2, cache: { read: 0, write: 0 } }]
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-revert-usage" }),
          LLMEvent.textDelta({ id: "text-revert-usage", text: "Usage to remove" }),
          LLMEvent.textEnd({ id: "text-revert-usage" }),
          LLMEvent.stepFinish({
            index: 0,
            reason: "stop",
            usage: { inputTokens: 6, nonCachedInputTokens: 6, outputTokens: 4, reasoningTokens: 1 },
          }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      const prompt = yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Spend tokens" }), resume: false })
      yield* session.resume(sessionID)

      expect((yield* session.get(sessionID)).tokens).toEqual({
        input: 6,
        output: 3,
        reasoning: 1,
        cache: { read: 0, write: 0 },
      })

      yield* session.revert({ sessionID, messageID: prompt.id, files: "messages_only" })
      yield* session.cleanupRevert(sessionID)

      const info = yield* session.get(sessionID)
      expect(info.cost).toBe(0)
      expect(info.tokens).toEqual({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
      expect(yield* session.context(sessionID)).toEqual([])
    }),
  )

  it.effect("generates a title after the first real user prompt", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_parity_title_generation")
      const session = yield* setup(sessionID)
      const agents = yield* AgentV2.Service
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ title: "New session - 2026-07-08T00:00:00.000Z" })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* agents.update((editor) => {
        editor.update(AgentV2.ID.make("title"), (agent) => {
          agent.hidden = true
          agent.mode = "primary"
          agent.system = "Return only a concise title."
        })
      })
      currentSmallModel = Option.some(titleModel)
      responses = [textTurn("text-answer", "Done")]
      titleResponses = [[LLMEvent.textDelta({ id: "title", text: "Generated Title\n" })]]

      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Please implement title parity" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      const titleRequest = requests.find((request) => String(request.model.id) === "title-small")
      expect(titleRequest).toBeDefined()
      expect(titleRequest!.system.some((part) => part.text.startsWith("OpenCode host session (authoritative): "))).toBe(
        false,
      )
      expect(userTexts(titleRequest!)).toEqual([
        "Generate a title for this conversation:\n",
        "Please implement title parity",
      ])
      expect((yield* session.get(sessionID)).title).toBe("Generated Title")
    }),
  )

  it.effect("keeps repeated turns and title generation on the runtime LLM model realm", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_parity_foreign_model_boundary")
      const session = yield* setup(sessionID)
      const agents = yield* AgentV2.Service
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ title: "New session - 2026-07-08T00:00:00.000Z" })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* agents.update((editor) => {
        editor.update(AgentV2.ID.make("title"), (agent) => {
          agent.hidden = true
          agent.mode = "primary"
          agent.system = "Return only a concise title."
        })
      })

      // This is the shape returned by an independently bundled provider. It is
      // intentionally not an instance of this runtime's Model class.
      const foreign = { id: "parity", provider: "fake", route } as unknown as Model
      const foreignTitle = { id: "title-small", provider: "fake", route } as unknown as Model
      currentModel = foreign
      currentSmallModel = Option.some(foreignTitle)
      responses = [textTurn("foreign-turn-1", "First turn"), textTurn("foreign-turn-2", "Second turn")]
      titleResponses = [[LLMEvent.textDelta({ id: "foreign-title", text: "Foreign Realm Title\n" })]]

      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First foreign-model turn" }), resume: false })
      yield* session.resume(sessionID)
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Second foreign-model turn" }), resume: false })
      yield* session.resume(sessionID)

      for (let attempt = 0; attempt < 100; attempt++) {
        if ((yield* session.get(sessionID)).title === "Foreign Realm Title") break
        yield* Effect.sleep("10 millis")
      }

      expect(requests).toHaveLength(3)
      expect(requests.every((request) => request.model instanceof Model)).toBe(true)
      expect((yield* session.get(sessionID)).title).toBe("Foreign Realm Title")
      expect((yield* session.context(sessionID)).filter((message) => message.type === "user")).toHaveLength(2)
    }),
  )

  it.effect("generates a missing title when explicitly resuming already-promoted history", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_parity_title_already_promoted")
      const session = yield* setup(sessionID)
      const agents = yield* AgentV2.Service
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* db
        .update(SessionTable)
        .set({ title: "New session - 2026-07-08T00:00:00.000Z" })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* agents.update((editor) => {
        editor.update(AgentV2.ID.make("title"), (agent) => {
          agent.hidden = true
          agent.mode = "primary"
          agent.system = "Return only a concise title."
        })
      })
      currentSmallModel = Option.some(titleModel)
      responses = [textTurn("text-answer", "Done")]
      titleResponses = [[LLMEvent.textDelta({ id: "title", text: "Recovered Semantic Title\n" })]]

      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Recover naming from promoted history" }),
        resume: false,
      })
      expect(yield* SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER)).toBe(1)
      yield* session.resume(sessionID)
      yield* Effect.gen(function* () {
        for (let attempt = 0; attempt < 100; attempt++) {
          if ((yield* session.get(sessionID)).title === "Recovered Semantic Title") return
          yield* Effect.sleep("10 millis")
        }
        return yield* Effect.die("Timed out waiting for title generation from promoted history")
      })

      expect((yield* session.get(sessionID)).title).toBe("Recovered Semantic Title")
    }),
  )

  it.effect("normalizes generated titles to one concise semantic line", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_parity_title_concise")
      const session = yield* setup(sessionID)
      const agents = yield* AgentV2.Service
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ title: "New session - 2026-07-08T00:00:00.000Z" })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* agents.update((editor) => {
        editor.update(AgentV2.ID.make("title"), (agent) => {
          agent.hidden = true
          agent.mode = "primary"
          agent.system = "Return only a concise title."
        })
      })
      currentSmallModel = Option.some(titleModel)
      responses = [textTurn("text-answer", "Done")]
      titleResponses = [
        [
          LLMEvent.textDelta({
            id: "title",
            text: '# Title: "Improve automatic session naming for reasoning models without overlong dock tabs"\n',
          }),
        ],
      ]

      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Keep generated titles concise" }), resume: false })
      yield* session.resume(sessionID)

      const generated = (yield* session.get(sessionID)).title
      expect(generated).toContain("Improve automatic session")
      expect(generated.startsWith("Title:")).toBe(false)
      expect(generated.length).toBeLessThanOrEqual(35)
      expect(generated.endsWith("...")).toBe(true)
    }),
  )

  it.effect("retries title generation without max_output_tokens when the provider rejects it", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_parity_title_output_limit_retry")
      const session = yield* setup(sessionID)
      const agents = yield* AgentV2.Service
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ title: "New session - 2026-07-08T00:00:00.000Z" })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* agents.update((editor) => {
        editor.update(AgentV2.ID.make("title"), (agent) => {
          agent.hidden = true
          agent.mode = "primary"
          agent.system = "Return only a concise title."
        })
      })
      currentSmallModel = Option.some(
        Model.make({
          id: "title-small",
          provider: "fake",
          route: route.with({ generation: { maxTokens: 512 } }),
        }),
      )
      responses = [textTurn("text-answer", "Done")]
      titleResponses = [
        [
          LLMEvent.providerError({
            message:
              'RequestExecutor.execute: Provider request failed with HTTP 400: {"detail":"Unsupported parameter: max_output_tokens"}',
          }),
        ],
        [LLMEvent.textDelta({ id: "title-retry", text: "Retried Title\n" })],
      ]

      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Handle providers with different title limits" }),
        resume: false,
      })
      yield* session.resume(sessionID)
      yield* Effect.gen(function* () {
        for (let attempt = 0; attempt < 100; attempt++) {
          if ((yield* session.get(sessionID)).title === "Retried Title") return
          yield* Effect.sleep("10 millis")
        }
        return yield* Effect.die("Timed out waiting for retried title generation")
      })

      const titleRequests = requests.filter((request) => String(request.model.id) === "title-small")
      expect(titleRequests).toHaveLength(2)
      expect(titleRequests[0]?.generation?.maxTokens).toBe(256)
      expect(titleRequests[1]?.generation?.maxTokens).toBeUndefined()
      expect((yield* session.get(sessionID)).title).toBe("Retried Title")
    }),
  )

  it.effect("retries title generation without a token limit when capped output is empty", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_parity_title_empty_output_retry")
      const session = yield* setup(sessionID)
      const agents = yield* AgentV2.Service
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ title: "New session - 2026-07-08T00:00:00.000Z" })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* agents.update((editor) => {
        editor.update(AgentV2.ID.make("title"), (agent) => {
          agent.hidden = true
          agent.mode = "primary"
          agent.system = "Return only a concise title."
        })
      })
      currentSmallModel = Option.some(titleModel)
      responses = [textTurn("text-answer", "Done")]
      titleResponses = [[], [LLMEvent.textDelta({ id: "title-retry", text: "Semantic Retry Title\n" })]]

      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Name a reasoning-heavy title request" }),
        resume: false,
      })
      yield* session.resume(sessionID)
      yield* Effect.gen(function* () {
        for (let attempt = 0; attempt < 100; attempt++) {
          if ((yield* session.get(sessionID)).title === "Semantic Retry Title") return
          yield* Effect.sleep("10 millis")
        }
        return yield* Effect.die("Timed out waiting for title retry after empty output")
      })

      const titleRequests = requests.filter((request) => String(request.model.id) === "title-small")
      expect(titleRequests).toHaveLength(2)
      expect(titleRequests[0]?.generation?.maxTokens).toBe(256)
      expect(titleRequests[1]?.generation?.maxTokens).toBeUndefined()
      expect((yield* session.get(sessionID)).title).toBe("Semantic Retry Title")
    }),
  )

  it.effect("uses the first prompt when the title provider returns no usable title", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_parity_title_provider_fallback")
      const session = yield* setup(sessionID)
      const agents = yield* AgentV2.Service
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ title: "New session - 2026-07-08T00:00:00.000Z" })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* agents.update((editor) => {
        editor.update(AgentV2.ID.make("title"), (agent) => {
          agent.hidden = true
          agent.mode = "primary"
          agent.system = "Return only a concise title."
        })
      })
      currentSmallModel = Option.some(titleModel)
      responses = [textTurn("text-answer", "Done")]
      titleResponses = [[LLMEvent.providerError({ message: "Title model unavailable" })]]

      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Implement robust automatic title fallback" }),
        resume: false,
      })
      yield* session.resume(sessionID)
      const expectedTitle = "Implement robust automatic..."
      yield* Effect.gen(function* () {
        for (let attempt = 0; attempt < 100; attempt++) {
          if ((yield* session.get(sessionID)).title === expectedTitle) return
          yield* Effect.sleep("10 millis")
        }
        return yield* Effect.die("Timed out waiting for prompt-based title fallback")
      })

      expect(requests).toHaveLength(2)
      expect((yield* session.get(sessionID)).title).toBe(expectedTitle)
    }),
  )

  it.live("settles title generation independently when main model resolution fails before streaming", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_parity_title_early_model_failure")
      const session = yield* setup(sessionID)
      const agents = yield* AgentV2.Service
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ title: "New session - 2026-07-08T00:00:00.000Z" })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* agents.update((editor) => {
        editor.update(AgentV2.ID.make("title"), (agent) => {
          agent.hidden = true
          agent.mode = "primary"
          agent.system = "Return only a concise title."
        })
      })
      currentSmallModel = Option.some(titleModel)
      currentModelFailure = new SessionRunnerModel.NativeModelError({
        providerID: ProviderV2.ID.make("openai"),
        modelID: ModelV2.ID.make("gpt-5.6"),
        apiID: ModelV2.ID.make("gpt-5.6-sol"),
        reason: "reasoning-mode",
        message: "GPT-5.6 max is unavailable for the current OAuth connection",
      })
      titleResponses = [[LLMEvent.textDelta({ id: "title", text: "OAuth Model Failure\n" })]]

      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Diagnose the blank assistant" }), resume: false })
      const exit = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      yield* Effect.gen(function* () {
        for (let attempt = 0; attempt < 100; attempt++) {
          if ((yield* session.get(sessionID)).title === "OAuth Model Failure") return
          yield* Effect.sleep("10 millis")
        }
        return yield* Effect.die("Timed out waiting for title generation after early model failure")
      })
      expect(requests).toHaveLength(1)
      expect(String(requests[0]?.model.id)).toBe("title-small")
      expect((yield* session.get(sessionID)).title).toBe("OAuth Model Failure")
    }),
  )

  it.effect("does not keep the main activity busy while title generation is stalled", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_parity_title_generation_stalled")
      const session = yield* setup(sessionID)
      const agents = yield* AgentV2.Service
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ title: "New session - 2026-07-08T00:00:00.000Z" })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* agents.update((editor) => {
        editor.update(AgentV2.ID.make("title"), (agent) => {
          agent.hidden = true
          agent.mode = "primary"
        })
      })
      currentSmallModel = Option.some(titleModel)
      responses = [textTurn("text-answer", "Done")]
      titleResponses = [[LLMEvent.textDelta({ id: "title", text: "Delayed Title\n" })]]
      titleStreamGate = yield* Deferred.make<void>()

      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Do not let naming block this turn" }),
        resume: false,
      })
      yield* session.resume(sessionID).pipe(Effect.timeout("1 second"))

      expect(requests).toHaveLength(2)
      expect((yield* session.get(sessionID)).title).toBe("New session - 2026-07-08T00:00:00.000Z")
      yield* Deferred.succeed(titleStreamGate, undefined)
      yield* Effect.gen(function* () {
        for (let attempt = 0; attempt < 100; attempt++) {
          if ((yield* session.get(sessionID)).title === "Delayed Title") return
          yield* Effect.sleep("10 millis")
        }
        return yield* Effect.die("Timed out waiting for delayed title generation")
      })
      expect((yield* session.get(sessionID)).title).toBe("Delayed Title")
    }),
  )

  test("preserves a manual rename while a generated title is in flight", () => {
    const observed = "New session - 2026-07-08T00:00:00.000Z"
    expect(shouldPublishGeneratedTitle(observed, observed)).toBe(true)
    expect(shouldPublishGeneratedTitle("Manual Title", observed)).toBe(false)
  })

  it.effect("does not apply message transform hooks to title generation", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const id = PluginV2.ID.make("title-message-transform")
      yield* plugin.add({
        id,
        effect: Effect.succeed({
          "experimental.chat.messages.transform": Effect.fn(function* (evt) {
            evt.messages.push(Message.user("hooked title pollution"))
          }),
        }),
      })

      const sessionID = SessionV2.ID.make("ses_parity_title_message_transform")
      const session = yield* setup(sessionID)
      const agents = yield* AgentV2.Service
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ title: "New session - 2026-07-08T00:00:00.000Z" })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* agents.update((editor) => {
        editor.update(AgentV2.ID.make("title"), (agent) => {
          agent.hidden = true
          agent.mode = "primary"
        })
      })
      currentSmallModel = Option.some(titleModel)
      responses = [textTurn("text-answer", "Done")]
      titleResponses = [[LLMEvent.textDelta({ id: "title", text: "Clean Title\n" })]]

      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Keep title clean" }), resume: false })
      yield* session.resume(sessionID)

      const titleRequest = requests.find((request) => String(request.model.id) === "title-small")
      expect(titleRequest).toBeDefined()
      if (!titleRequest) return
      expect(userTexts(titleRequest)).toEqual(["Generate a title for this conversation:\n", "Keep title clean"])
      expect((yield* session.get(sessionID)).title).toBe("Clean Title")
      yield* plugin.remove(id)
    }),
  )

  it.effect("generates the title from the first user when steering adds another prompt", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_parity_title_generation_steering")
      const session = yield* setup(sessionID)
      const agents = yield* AgentV2.Service
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ title: "New session - 2026-07-08T00:00:00.000Z" })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* agents.update((editor) => {
        editor.update(AgentV2.ID.make("title"), (agent) => {
          agent.hidden = true
          agent.mode = "primary"
          agent.system = "Return only a concise title."
        })
      })
      currentSmallModel = Option.some(titleModel)
      responses = [textTurn("text-title-first", "Starting"), textTurn("text-title-second", "Redirected")]
      titleResponses = [[LLMEvent.textDelta({ id: "title", text: "Steered Title\n" })]]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Start working" }), resume: false })
      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Change direction" }) })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)

      expect(requests).toHaveLength(3)
      const titleRequest = requests.find((request) => String(request.model.id) === "title-small")
      expect(titleRequest).toBeDefined()
      expect(userTexts(titleRequest!)).toEqual(["Generate a title for this conversation:\n", "Start working"])
      expect((yield* session.get(sessionID)).title).toBe("Steered Title")
    }),
  )

  it.effect("preserves a non-default title without calling the title model", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_parity_title_generation_existing")
      const session = yield* setup(sessionID)
      const agents = yield* AgentV2.Service
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ title: "Already named" })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* agents.update((editor) => {
        editor.update(AgentV2.ID.make("title"), (agent) => {
          agent.hidden = true
          agent.mode = "primary"
        })
      })
      responses = [textTurn("text-answer", "Done")]

      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Do not rename" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect((yield* session.get(sessionID)).title).toBe("Already named")
    }),
  )

  it.effect("adopts the agent's configured model when a session never chose one", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_parity_agent_model_adoption")
      const session = yield* setup(sessionID)
      const agents = yield* AgentV2.Service
      const standardCoderModel = () => ({
        id: ModelV2.ID.make("glm-step"),
        providerID: ProviderV2.ID.make("zhipuai-coding-plan"),
        chain: {
          id: "standard-coder",
          name: "Standard Coder",
          active: 0,
          steps: [
            { id: ModelV2.ID.make("glm-step"), providerID: ProviderV2.ID.make("zhipuai-coding-plan") },
            {
              id: ModelV2.ID.make("sol-step"),
              providerID: ProviderV2.ID.make("cursor"),
              variant: ModelV2.VariantID.make("medium"),
            },
          ],
        },
      })
      yield* agents.update((editor) => {
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.model = standardCoderModel()
        })
      })
      responses = [textTurn("text-answer", "Done")]

      // The REST and desktop-bridge shape: the session and the prompt carry no
      // model, so the turn must adopt the configured chain instead of drifting
      // to the newest catalog model.
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Use the configured chain" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      // SessionInfo materializes absent variants as "default" on the DB roundtrip.
      expect((yield* session.get(sessionID)).model).toEqual({
        ...standardCoderModel(),
        variant: ModelV2.VariantID.make("default"),
      })
    }),
  )

  it.effect("keeps an explicit model choice over the agent's configured model", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_parity_explicit_model_wins")
      const session = yield* setup(sessionID)
      const agents = yield* AgentV2.Service
      yield* agents.update((editor) => {
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.model = {
            id: ModelV2.ID.make("glm-step"),
            providerID: ProviderV2.ID.make("zhipuai-coding-plan"),
            chain: {
              id: "standard-coder",
              name: "Standard Coder",
              active: 0,
              steps: [{ id: ModelV2.ID.make("glm-step"), providerID: ProviderV2.ID.make("zhipuai-coding-plan") }],
            },
          }
        })
      })
      const explicit = ModelV2.Ref.make({ id: ModelV2.ID.make("sol-step"), providerID: ProviderV2.ID.make("cursor") })
      responses = [textTurn("text-answer", "Done")]

      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Explicitly choose this model", model: explicit }),
        resume: false,
      })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect((yield* session.get(sessionID)).model).toEqual({
        ...explicit,
        variant: ModelV2.VariantID.make("default"),
      })
    }),
  )
})
