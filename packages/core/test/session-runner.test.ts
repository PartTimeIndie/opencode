import { describe, expect, test } from "bun:test"
import {
  LLMClient,
  LLMError,
  LLMEvent,
  Model,
  QuotaExceededReason,
  RateLimitReason,
  ToolDefinition,
  TransportReason,
  InvalidRequestReason,
  AuthenticationReason,
  type LLMClientShape,
  type LLMRequest,
} from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { OpenRouter } from "@opencode-ai/llm/providers"
import { RequestExecutor } from "@opencode-ai/llm/route"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { EventTable } from "@opencode-ai/core/event/sql"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { QuestionV2 } from "@opencode-ai/core/question"
import { QuestionTable } from "@opencode-ai/core/question/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionActivity } from "@opencode-ai/core/session/activity"
import { ContentStore } from "@opencode-ai/core/content-store"
import { AttachmentTable, ContentBlobTable } from "@opencode-ai/core/attachment.sql"
import { ContextSnapshotDecodeError } from "@opencode-ai/core/session/error"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionForkEvent } from "@opencode-ai/core/session/fork-event"
import { SessionHostContext } from "@opencode-ai/core/session/host-context"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionResume } from "@opencode-ai/core/session/resume"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionToolCancellation } from "@opencode-ai/core/session/tool-cancellation"
import { SessionTurnContinuation } from "@opencode-ai/core/session/turn-continuation"
import { FileAttachment, Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionExecutionOwner } from "@opencode-ai/core/session/execution/owner"
import { SessionExecutionLocal } from "@opencode-ai/core/session/execution/local"
import { SessionContextEpoch } from "@opencode-ai/core/session/context-epoch"
import { SessionRunCoordinator } from "@opencode-ai/core/session/run-coordinator"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import * as SessionRunnerLLM from "@opencode-ai/core/session/runner/llm"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { SessionRunnerAISDK } from "@opencode-ai/core/session/runner/aisdk"
import { createSDK } from "../../provider-plugins/cerebras/src/sdk"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { SurfaceTool } from "@opencode-ai/core/tool/surface"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { AgentV2 } from "@opencode-ai/core/agent"
import { CapabilityLease } from "@opencode-ai/core/capability/lease"
import { Catalog } from "@opencode-ai/core/catalog"
import { Config } from "@opencode-ai/core/config"
import { ConfigCompaction } from "@opencode-ai/core/config/compaction"
import { ConfigVision } from "@opencode-ai/core/config/vision"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Integration } from "@opencode-ai/core/integration"
import { Tool } from "@opencode-ai/core/tool/tool"
import {
  SessionContextEpochTable,
  SessionActivityTable,
  SessionInputTable,
  SessionMessageTable,
  SessionTable,
} from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { ModelV2 } from "@opencode-ai/core/model"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Layer, Option, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { asc, and, eq, inArray, isNotNull, sql } from "drizzle-orm"
import { readFile } from "fs/promises"
import path from "path"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const global = Global.layerWith({ data: path.join(Global.Path.tmp, `session-runner-${process.pid}`) })
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
const plugins = PluginV2.layer.pipe(Layer.provide(events))
const questions = QuestionV2.layer.pipe(Layer.provide(events), Layer.provide(database))
const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
const store = SessionStore.layer.pipe(Layer.provide(database))
const requests: LLMRequest[] = []
let response: LLMEvent[] = []
let responses: LLMEvent[][] | undefined
let responseStream: Stream.Stream<LLMEvent, LLMError> | undefined
let responseStreamFactory: ((request: LLMRequest) => Stream.Stream<LLMEvent, LLMError>) | undefined
let streamGate: Deferred.Deferred<void> | undefined
let streamStarted: Deferred.Deferred<void> | undefined
let streamFailure: LLMError | undefined
let toolExecutionGate: Deferred.Deferred<void> | undefined
let toolExecutionsStarted: Deferred.Deferred<void> | undefined
let toolExecutionsReady = 5
let activeToolExecutions = 0
let maxActiveToolExecutions = 0
let snapshotTracks: Array<string | undefined> = []
let snapshotDiffs: Snapshot.FileDiff[] = []
let snapshotTrackHook = Effect.void
const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: ((request: LLMRequest) => {
      requests.push(request)
      if (responseStream) {
        const stream = responseStream
        responseStream = undefined
        return stream
      }
      if (responseStreamFactory) return responseStreamFactory(request)
      const events = streamFailure
        ? Stream.fail(streamFailure)
        : Stream.fromIterable(responses === undefined ? response : (responses.shift() ?? []))
      if (!streamGate) return events
      return Stream.unwrap(
        (streamStarted ? Deferred.succeed(streamStarted, undefined) : Effect.void).pipe(
          Effect.andThen(Deferred.await(streamGate)),
          Effect.as(events),
        ),
      )
    }) as unknown as LLMClientShape["stream"],
    generate: () => Effect.die("unused"),
  }),
)
const model = Model.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route })
const replacementModel = Model.make({ id: "replacement", provider: "fake", route: OpenAIChat.route })
const chainModelRef = () =>
  ModelV2.Ref.make({
    id: ModelV2.ID.make("fake-model"),
    providerID: ProviderV2.ID.make("fake"),
    chain: {
      id: "standard",
      name: "Standard",
      active: 0,
      steps: [
        { id: ModelV2.ID.make("fake-model"), providerID: ProviderV2.ID.make("fake") },
        {
          id: ModelV2.ID.make("replacement"),
          providerID: ProviderV2.ID.make("fake"),
          variant: ModelV2.VariantID.make("medium"),
        },
      ],
    },
  })
const textOnlyModel = Model.make({ id: "glm-5.2", provider: "zhipuai-coding-plan", route: OpenAIChat.route })
const visionModel = Model.make({ id: "vision", provider: "fake", route: OpenAIChat.route })
const compactModel = Model.make({
  id: "compact",
  provider: "fake",
  route: OpenAIChat.route.with({ limits: { context: 6_000, output: 50 } }),
})
const largerSummaryModel = Model.make({
  id: "larger-summary",
  provider: "fake",
  route: OpenAIChat.route.with({ limits: { context: 120_000, input: 100_000, output: 1_000 } }),
})
const smallTargetModel = Model.make({
  id: "small-target",
  provider: "fake",
  route: OpenAIChat.route.with({ limits: { context: 50_000, input: 50_000, output: 1_000 } }),
})
const recoveryModel = Model.make({
  id: "recovery",
  provider: "fake",
  route: OpenAIChat.route.with({ limits: { context: 20_000, output: 1_000 } }),
})
const pressureModel = Model.make({
  id: "pressure",
  provider: "fake",
  route: OpenAIChat.route.with({ limits: { context: 100_000, output: 1_000 } }),
})
let compactionFallbackCatalog: ModelV2.Info[] = []
const compactionFallbackInfo = (id: string, context: number) =>
  new ModelV2.Info({
    ...ModelV2.Info.empty(ProviderV2.ID.make("fake"), ModelV2.ID.make(id)),
    capabilities: { tools: false, input: ["text"], output: ["text"] },
    limit: { context, input: context, output: 1_000 },
  })
const authorizations: Tool.Context[] = []
const executions: string[] = []
let toolExecutionHook = Effect.void
let capabilitySkillEnabled = false
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.die("unused"),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    materializationRules: () =>
      Effect.succeed(
        capabilitySkillEnabled ? [{ action: "skill", resource: "*", effect: "allow" as const }] : [],
      ),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const applications = ApplicationTools.layer
const capabilityConfig = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () =>
      Effect.succeed([
        new Config.Document({
          type: "document",
          info: new Config.Info({ skill_capabilities: { "computer-use": ["browser_read"] } }),
        }),
      ]),
  }),
)
const capabilityLeases = CapabilityLease.layer.pipe(Layer.provide(capabilityConfig))
const registry = ToolRegistry.layer.pipe(
  Layer.provide(permission),
  Layer.provide(applications),
  Layer.provide(toolOutputStore),
  Layer.provide(capabilityLeases),
)
const agents = AgentV2.layer
const echo = Layer.effectDiscard(
  ToolRegistry.Service.use((registry) =>
    registry.register({
      echo: Tool.make({
        description: "Echo text",
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
        toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
        execute: ({ text }, context) =>
          Effect.gen(function* () {
            yield* toolExecutionHook
            authorizations.push(context)
            executions.push(text)
            activeToolExecutions++
            maxActiveToolExecutions = Math.max(maxActiveToolExecutions, activeToolExecutions)
            if (activeToolExecutions === toolExecutionsReady && toolExecutionsStarted) {
              yield* Deferred.succeed(toolExecutionsStarted, undefined)
            }
            if (toolExecutionGate) yield* Deferred.await(toolExecutionGate)
            return { text }
          }).pipe(Effect.ensuring(Effect.sync(() => activeToolExecutions--))),
      }),
      defect: Tool.make({
        description: "Fail unexpectedly",
        input: Schema.Struct({}),
        output: Schema.Struct({}),
        execute: () => Effect.die("unexpected tool defect"),
      }),
      failure: Tool.make({
        description: "Fail recoverably",
        input: Schema.Struct({}),
        output: Schema.Struct({}),
        execute: () => Effect.fail(new Tool.Failure({ message: "patch rejected" })),
      }),
    }),
  ),
).pipe(Layer.provide(registry))
const capabilityTools = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const leases = yield* CapabilityLease.Service
    yield* registry.register({
      skill: Tool.withDefaultDisabled(
        Tool.make({
          description: "Activate computer-use",
          input: Schema.Struct({ name: Schema.String }),
          output: Schema.Struct({ name: Schema.String }),
          execute: (input, context) =>
            leases
              .activate({ sessionID: context.sessionID, agent: context.agent, skill: input.name, requested: ["browser_read"] })
              .pipe(
                Effect.as({ name: input.name }),
                Effect.mapError((error) => new Tool.Failure({ message: error.message })),
              ),
        }),
      ),
      browser_snapshot: Tool.withCapabilities(
        Tool.make({
          description: "Inspect browser",
          input: Schema.Struct({}),
          output: Schema.Struct({ ok: Schema.Boolean }),
          execute: () => Effect.succeed({ ok: true }),
        }),
        ["browser_read"],
      ),
    })
  }),
).pipe(Layer.provide(registry), Layer.provide(capabilityLeases))
let modelResolveHook: Effect.Effect<void, SessionRunnerModel.Error> = Effect.void
let currentModel = model
let currentModelSupportsTools = true
let compactionAuto = true
const visionConfig = Schema.decodeUnknownSync(ConfigVision.Info)({
  enabled: true,
  primary: { model: "fake/vision" },
})
const models = SessionRunnerModel.layerWith(
  (session) =>
    modelResolveHook.pipe(
      Effect.as(
        session.model?.id === "replacement"
          ? replacementModel
          : session.model?.id === "larger-summary"
            ? largerSummaryModel
            : session.model?.id === "vision"
              ? visionModel
              : currentModel,
      ),
    ),
  undefined,
  undefined,
  () => Effect.succeed({ tools: currentModelSupportsTools, input: ["text"], output: ["text"] }),
)
const systemContextKey = SystemContext.Key.make("test/context")
let systemBaseline = "Initial context"
let systemRemoved = false
let systemUnavailable = false
let systemLoadHook = Effect.void
const skillBaselines = new Map<AgentV2.ID, string>()
const systemContext = Layer.effectDiscard(
  SystemContextRegistry.Service.pipe(
    Effect.flatMap((registry) =>
      registry.register({
        key: systemContextKey,
        load: Effect.sync(() =>
          SystemContext.combine(
            systemRemoved
              ? []
              : [
                  SystemContext.make({
                    key: systemContextKey,
                    codec: Schema.toCodecJson(Schema.String),
                    load: systemLoadHook.pipe(
                      Effect.andThen(
                        Effect.sync(() => (systemUnavailable ? SystemContext.unavailable : systemBaseline)),
                      ),
                    ),
                    baseline: String,
                    update: (_previous, current) => current,
                    removed: () => "System context source removed: test/context",
                  }),
                ],
          ),
        ),
      }),
    ),
  ),
).pipe(Layer.provideMerge(SystemContextRegistry.layer))
const location = Location.layer({ directory: AbsolutePath.make("/project") }).pipe(Layer.provide(Project.defaultLayer))
const skillGuidance = Layer.mock(SkillGuidance.Service, {
  load: (agent) =>
    Effect.succeed(
      skillBaselines.has(agent.id)
        ? SystemContext.make({
            key: SystemContext.Key.make("test/skill-guidance"),
            codec: Schema.toCodecJson(Schema.String),
            load: Effect.succeed(skillBaselines.get(agent.id)!),
            baseline: String,
            update: (_previous, current) => current,
            removed: () => "Skill guidance removed",
          })
        : SystemContext.empty,
    ),
})
const referenceGuidance = Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const compactionCatalog = Layer.mock(Catalog.Service, {
  provider: {
    get: () => Effect.fail(new Catalog.ProviderNotFoundError({ providerID: ProviderV2.ID.make("unused") })),
    all: () => Effect.succeed([]),
    available: () => Effect.succeed([]),
  },
  model: {
    get: () => Effect.fail(new Catalog.ModelNotFoundError({ providerID: ProviderV2.ID.make("fake"), modelID: ModelV2.ID.make("unused") })),
    all: () => Effect.succeed([]),
    available: () => Effect.sync(() => compactionFallbackCatalog),
    default: () => Effect.succeed(Option.none()),
    small: () => Effect.succeed(Option.none()),
  },
})
const snapshots = Layer.succeed(
  Snapshot.Service,
  Snapshot.Service.of({
    track: () =>
      Effect.gen(function* () {
        yield* snapshotTrackHook
        return snapshotTracks.shift()
      }),
    changedFiles: () => Effect.succeed([]),
    patch: (input) => Effect.succeed({ hash: input.hash, files: [] }),
    restore: () => Effect.void,
    revert: () => Effect.void,
    diff: () => Effect.succeed(undefined),
    diffFull: () => Effect.sync(() => [...snapshotDiffs]),
  }),
)
const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () =>
      Effect.succeed([
        new Config.Document({
          type: "document",
          info: new Config.Info({
            compaction: new ConfigCompaction.Info({
              auto: compactionAuto,
              buffer: 3_000,
              keep: new ConfigCompaction.Keep({ tokens: 1_000 }),
            }),
            vision: visionConfig,
          }),
        }),
      ]),
  }),
)
const runner = SessionRunnerLLM.layer.pipe(
  Layer.provide(plugins),
  Layer.provide(database),
  Layer.provide(store),
  Layer.provide(events),
  Layer.provide(client),
  Layer.provide(permission),
  Layer.provide(registry),
  Layer.provide(capabilityLeases),
  Layer.provide(contentStore),
  Layer.provide(toolOutputStore),
  Layer.provide(models),
  Layer.provide(systemContext),
  Layer.provide(location),
  Layer.provide(agents),
  Layer.provide(SessionToolCancellation.layer),
  Layer.provide(skillGuidance),
  Layer.provide(referenceGuidance),
  Layer.provide(snapshots),
  Layer.provide(config),
  Layer.provide(Layer.mergeAll(compactionCatalog, questions)),
)
// The unit execution adapter below skips LocalExecution. Supply its private
// scope only for explicitly owner-backed structured-correction fixtures.
const ownedRunner = Layer.effect(SessionRunner.Service, Effect.gen(function* () {
  const service = yield* SessionRunner.Service
  const { db } = yield* Database.Service
  return SessionRunner.Service.of({
    ...service,
    run: (input) => Effect.gen(function* () {
      const activity = yield* db.select().from(SessionActivityTable)
        .where(eq(SessionActivityTable.id, "structured-test-owner")).get().pipe(Effect.orDie)
      return yield* activity && activity.session_id === input.sessionID
        ? SessionExecutionOwner.withOwner({ sessionID: input.sessionID, activityID: activity.id, ownerID: "structured-test-owner" }, service.run(input))
        : service.run(input)
    }),
  })
})).pipe(Layer.provide(runner), Layer.provide(database))
const coordinator = SessionRunCoordinator.layer.pipe(Layer.provide(ownedRunner))
const execution = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const coordinator = yield* SessionRunCoordinator.Service
    const cancellation = yield* SessionToolCancellation.Service
    const sessionStore = yield* SessionStore.Service
    return SessionExecution.Service.of({
      resume: coordinator.run,
      resumeOrJoin: coordinator.runOrJoin,
      wake: coordinator.wake,
      queueContinuation: coordinator.queueContinuation,
      wait: (sessionID) => coordinator.awaitIdle(sessionID).pipe(Effect.ignore),
      interrupt: coordinator.interrupt,
      interruptActivity: () => Effect.succeed(false),
      cancelTool: (sessionID, callID) =>
        Effect.gen(function* () {
          if (yield* cancellation.cancel({ sessionID, callID })) return true
          return yield* SessionExecutionLocal.reconcilePendingTool(sessionStore, coordinator, sessionID, callID)
        }),
    })
  }),
).pipe(Layer.provide(coordinator), Layer.provide(SessionToolCancellation.layer), Layer.provide(store))
// This harness already constructs the location-scoped runner; the map only
// enables SessionV2's location-scoped model-switch preflight path.
const sessionLocations = Layer.succeed(
  LocationServiceMap,
  LocationServiceMap.of({
    bindExecution: () => Effect.void,
    get: () => Layer.empty as never,
    invalidate: () => Effect.void,
  }),
)
const sessions = SessionV2.layer.pipe(
  Layer.provide(runner),
  Layer.provide(contentStore),
  Layer.provide(events),
  Layer.provide(database),
  Layer.provide(store),
  Layer.provide(Project.defaultLayer),
  Layer.provide(execution),
  Layer.provide(sessionLocations),
)
const baseLayer = Layer.mergeAll(
  plugins,
  database,
  events,
  questions,
  projector,
  store,
  client,
  permission,
  applications,
  agents,
  SessionToolCancellation.layer,
)
const supportLayer = Layer.mergeAll(registry, echo, capabilityTools, models, systemContext, location, skillGuidance, config, capabilityLeases)
const sessionLayer = Layer.mergeAll(coordinator, execution, sessions)
const it = testEffect(Layer.mergeAll(baseLayer, supportLayer, runner, sessionLayer))
const sessionID = SessionV2.ID.make("ses_runner_test")
const hostContext = SessionHostContext.render({ id: sessionID })
const otherSessionID = SessionV2.ID.make("ses_runner_other")

const insertSession = (id: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        slug: id,
        directory: "/project",
        title: "test",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

// Successful completion carrying content; replaces bare empty streams as the
// normal way to end a turn now that empty completions recover with retries.
const contentStopResponse: LLMEvent[] = [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.textStart({ id: "text-content-stop" }),
  LLMEvent.textDelta({ id: "text-content-stop", text: "Done" }),
  LLMEvent.textEnd({ id: "text-content-stop" }),
  LLMEvent.stepFinish({ index: 0, reason: "stop" }),
  LLMEvent.finish({ reason: "stop" }),
]
const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  response = contentStopResponse
  systemBaseline = "Initial context"
  systemRemoved = false
  systemUnavailable = false
  systemLoadHook = Effect.void
  modelResolveHook = Effect.void
  toolExecutionHook = Effect.void
  capabilitySkillEnabled = false
  compactionFallbackCatalog = []
  executions.length = 0
  currentModel = model
  currentModelSupportsTools = true
  compactionAuto = true
  skillBaselines.clear()
  responses = undefined
  streamFailure = undefined
  responseStream = undefined
  responseStreamFactory = undefined
  streamGate = undefined
  streamStarted = undefined
  toolExecutionGate = undefined
  toolExecutionsStarted = undefined
  toolExecutionsReady = 5
  activeToolExecutions = 0
  maxActiveToolExecutions = 0
  snapshotTracks = []
  snapshotDiffs = []
  snapshotTrackHook = Effect.void
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* insertSession(sessionID)
})

const setBuildAgentSteps = (steps: number) =>
  AgentV2.Service.use((agents) =>
    agents.update((editor) =>
      editor.update(AgentV2.ID.make("build"), (agent) => {
        agent.steps = steps
      }),
    ),
  )

const providerUnavailable = (canRetry = false) =>
  new LLMError({
    module: "test",
    method: "stream",
    reason: new TransportReason({ message: "Provider unavailable", canRetry }),
  })

const quotaExceeded = () =>
  new LLMError({
    module: "RequestExecutor",
    method: "execute",
    reason: new QuotaExceededReason({
      message:
        'Provider request failed with HTTP 429: {"error":{"code":"1310","message":"weekly/monthly usage limit reached"}}',
    }),
  })

const setupOverflowRecovery = Effect.gen(function* () {
  yield* setup
  const session = yield* SessionV2.Service
  response = fragmentFixture("text", "text-earlier", ["Earlier answer"]).completeEvents
  yield* session.prompt({
    sessionID,
    prompt: new Prompt({ text: "Earlier question ".repeat(700) }),
    resume: false,
  })
  yield* session.resume(sessionID)
  currentModel = recoveryModel
  requests.length = 0
  return session
})

const waitForCompactionQuestion = (sessionID: SessionV2.ID) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 1_000; attempt++) {
      const request = (yield* QuestionV2.Service.use((questions) => questions.list())).find(
        (item) =>
          item.sessionID === sessionID &&
          item.mode === "blocking" &&
          item.questions.some((question) => question.header === "Context summary"),
      )
      if (request) return request
      yield* Effect.yieldNow
    }
  })

const addActiveQuestionActivity = (id: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = Date.now()
    yield* db
      .insert(SessionActivityTable)
      .values({
        id,
        session_id: sessionID,
        status: "running",
        kind: "prompt",
        owner_id: id,
        lease_until: now + 60_000,
        time_created: now,
        time_updated: now,
      })
      .run()
      .pipe(Effect.orDie)
  })

const withStructuredOwner = <A, E, R>(operation: Effect.Effect<A, E, R>) => Effect.gen(function* () {
  const ownerID = "structured-test-owner"
  yield* addActiveQuestionActivity(ownerID)
  return yield* SessionExecutionOwner.withOwner({ sessionID, activityID: ownerID, ownerID }, operation)
})

function seedSurfaceRecovery(
  state: "replied" | "rejected" | "active" | "queued" = "replied",
  source = false,
  hosted = false,
  answerSource: "user" | "main" | "recommended" | null = "user",
) {
  return Effect.gen(function* () {
    const session = yield* SessionV2.Service
    const events = yield* EventV2.Service
    const { db } = yield* Database.Service
    yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Recover the answered Surface" }), resume: false })
    yield* SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER)
    const assistantMessageID = SessionMessage.ID.create()
    const callID = "call-recovery-surface"
    const requestID = QuestionV2.ID.make("que_recovery_surface")
    const info: QuestionV2.Info = {
      question: "Continue after restart?",
      header: "Recovery",
      options: [{ label: "Continue", description: "Continue the saved workflow" }],
    }
    const input = source
      ? { mode: "blocking" as const, sourceFile: { path: "/never-read-source.json", sha256: "a".repeat(64), count: 1 } }
      : { mode: "blocking" as const, questions: [info] }
    yield* events.publish(SessionEvent.Step.Started, {
      sessionID, assistantMessageID, timestamp: yield* DateTime.now, agent: "build",
      model: { id: ModelV2.ID.make("fake-model"), providerID: ProviderV2.ID.make("fake") },
    })
    yield* events.publish(SessionEvent.Tool.Input.Started, {
      sessionID, assistantMessageID, callID, name: "surface", timestamp: yield* DateTime.now,
    })
    yield* events.publish(SessionEvent.Tool.Input.Ended, {
      sessionID, assistantMessageID, callID, text: JSON.stringify(input), timestamp: yield* DateTime.now,
    })
    yield* events.publish(SessionEvent.Tool.Called, {
      sessionID, assistantMessageID, callID, tool: "surface", input, provider: { executed: hosted }, timestamp: yield* DateTime.now,
    })
    const request: QuestionV2.BlockingRequest = {
      id: requestID, sessionID, mode: "blocking", revision: 1, actions: [], questions: [info],
      tool: { messageID: assistantMessageID, callID },
    }
    yield* db.insert(QuestionTable).values({
      id: requestID, session_id: sessionID, seq: 1, state, request, mode: "blocking", revision: 1,
      action_metadata: [], detached: false, allow_concurrent: false,
      assistant_message_id: assistantMessageID, tool_call_id: callID,
      answers: state === "replied" ? [["Continue"]] : null,
      answer_source: state === "replied" ? answerSource : null,
      receipt: state === "replied" || state === "rejected" ? "receipt_saved_surface" : null,
      time_created: Date.now(), time_updated: Date.now(),
    })
    return { assistantMessageID, callID, requestID, info, request }
  })
}

const userTexts = (request: LLMRequest) =>
  request.messages.flatMap((message) =>
    message.role === "user"
      ? message.content.flatMap((content) => (content.type === "text" ? [content.text] : []))
      : [],
  )

const localToolTurn = (id: string, input: Record<string, unknown>) => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.toolCall({ id, name: "echo", input }),
  LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
  LLMEvent.finish({ reason: "tool-calls" }),
]

const activateComputerUseTurn = (id: string) => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.toolCall({ id, name: "skill", input: { name: "computer-use" } }),
  LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
  LLMEvent.finish({ reason: "tool-calls" }),
]

const detachedQuestionInput = {
  mode: "interactive" as const,
  version: 1 as const,
  controlID: "review-action",
  controls: [{ id: "open", type: "button" as const, label: "Open" }],
} as const

const surfaceQuestionTurn = (id: string) => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.toolCall({
    id,
    name: "surface",
    input: {
      mode: "blocking",
      questions: [
        {
          question: "Which color should the banner use?",
          options: [
            { id: "blue", label: "Blue", description: "Use the calm blue palette" },
            { id: "red", label: "Red", description: "Use the alert red palette" },
          ],
          allowOther: true,
        },
      ],
    },
  }),
  LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
  LLMEvent.finish({ reason: "tool-calls" }),
]

const registerInteractiveSurfaceTool = Effect.gen(function* () {
  const registry = yield* ToolRegistry.Service
  const questions = yield* QuestionV2.Service
  yield* registry.register({
    surface: Tool.make({
      description: "Open an interactive surface",
      input: SurfaceTool.Input,
      output: SurfaceTool.Output,
      toModelOutput: ({ input, output }) => SurfaceTool.toModelContent(input, output),
      execute: (input, context) => {
        if (input.mode === "blocking") return Effect.die("blocking surfaces are not used in this test")
        const { mode, ...surface } = input
        return questions
          .present({
            sessionID: context.sessionID,
            mode,
            surface,
            tool: { messageID: context.assistantMessageID, callID: context.toolCallID },
          })
          .pipe(
            Effect.map((request) => ({
              mode: request.mode,
              requestID: request.id,
              revision: request.revision,
              controlID: request.surface.controlID,
            })),
            Effect.orDie,
          )
      },
    }),
  })
})

const replaySessionProjection = (id: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const recorded = yield* db
      .select()
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, id))
      .orderBy(asc(EventTable.seq))
      .all()
      .pipe(Effect.orDie)

    yield* events.remove(id)
    yield* db.delete(SessionInputTable).where(eq(SessionInputTable.session_id, id)).run().pipe(Effect.orDie)
    yield* db.delete(SessionMessageTable).where(eq(SessionMessageTable.session_id, id)).run().pipe(Effect.orDie)
    yield* events.replayAll(
      recorded.map((event) => ({
        id: event.id,
        aggregateID: event.aggregate_id,
        seq: event.seq,
        type: event.type,
        data: EventV2.decodeStoredEventData(event.data),
      })),
    )
  })

type FragmentKind = "text" | "reasoning" | "tool input"

type FragmentFixture = {
  readonly delta: EventV2.Definition
  readonly completeEvents: LLMEvent[]
  readonly partialEvents: LLMEvent[]
  readonly expectedAssistant: unknown
  readonly expectedContent: unknown
}

const fragmentKinds: readonly FragmentKind[] = ["text", "reasoning", "tool input"]

const fragmentID = (kind: FragmentKind, suffix: string) => `${kind === "tool input" ? "call" : kind}-${suffix}`

const fragmentFixture = (kind: FragmentKind, id: string, chunks: readonly string[]): FragmentFixture => {
  const text = chunks.join("")
  switch (kind) {
    case "text": {
      const partialEvents = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id }),
        ...chunks.map((text) => LLMEvent.textDelta({ id, text })),
      ]
      const expectedContent = { type: "text", id, text }
      return {
        delta: SessionEvent.Text.Delta,
        partialEvents,
        completeEvents: [
          ...partialEvents,
          LLMEvent.textEnd({ id }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        expectedAssistant: { type: "assistant", finish: "stop", content: [expectedContent] },
        expectedContent,
      }
    }
    case "reasoning": {
      const partialEvents = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id }),
        ...chunks.map((text) => LLMEvent.reasoningDelta({ id, text })),
      ]
      const expectedContent = { type: "reasoning", id, text }
      const finalText = { type: "text", id: `${id}-answer`, text: "Done" }
      return {
        delta: SessionEvent.Reasoning.Delta,
        partialEvents,
        completeEvents: [
          ...partialEvents,
          LLMEvent.reasoningEnd({ id }),
          LLMEvent.textStart({ id: finalText.id }),
          LLMEvent.textDelta({ id: finalText.id, text: finalText.text }),
          LLMEvent.textEnd({ id: finalText.id }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        expectedAssistant: { type: "assistant", finish: "stop", content: [expectedContent, finalText] },
        expectedContent,
      }
    }
    case "tool input": {
      const partialEvents = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id, name: "echo" }),
        ...chunks.map((text) => LLMEvent.toolInputDelta({ id, name: "echo", text })),
      ]
      const expectedContent = { type: "tool", id, state: { status: "pending", input: text } }
      return {
        delta: SessionEvent.Tool.Input.Delta,
        partialEvents,
        completeEvents: [...partialEvents, LLMEvent.toolInputEnd({ id, name: "echo" })],
        expectedAssistant: { type: "assistant", content: [expectedContent] },
        expectedContent,
      }
    }
  }
}

const verifyEphemeralDeltas = (kind: FragmentKind) =>
  Effect.gen(function* () {
    yield* setup
    const session = yield* SessionV2.Service
    const prompt = `Stream ${kind}`
    const chunks = Array.from({ length: 32 }, (_, index) => `${index},`)
    const fixture = fragmentFixture(kind, fragmentID(kind, "many"), chunks)
    const expectedContext =
      kind === "tool input"
        ? [
            { type: "user", text: prompt },
            {
              type: "assistant",
              content: [{ type: "tool", id: fragmentID(kind, "many"), state: { status: "error" } }],
            },
            { type: "assistant", finish: "stop", content: [{ type: "text", text: "Done" }] },
          ]
        : [{ type: "user", text: prompt }, fixture.expectedAssistant]
    yield* session.prompt({ sessionID, prompt: new Prompt({ text: prompt }), resume: false })
    const events = yield* EventV2.Service
    const live = yield* events.subscribe(fixture.delta).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
    yield* Effect.yieldNow
    if (kind === "tool input") responses = [[...fixture.completeEvents, LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }), LLMEvent.finish({ reason: "tool-calls" })], contentStopResponse]
    if (kind !== "tool input") response = fixture.completeEvents

    yield* session.resume(sessionID)

    const { db } = yield* Database.Service
    const deltas = yield* db
      .select({ type: EventTable.type })
      .from(EventTable)
      .where(eq(EventTable.type, EventV2.versionedType(fixture.delta.type, 1)))
      .all()
      .pipe(Effect.orDie)
    const published = Array.from(yield* Fiber.join(live))
    expect(published).toHaveLength(1)
    expect(published.map((event) => (event.data as { delta: string }).delta).join("")).toBe(chunks.join(""))
    expect(deltas).toHaveLength(0)
    expect(yield* session.context(sessionID)).toMatchObject(expectedContext)

    yield* replaySessionProjection(sessionID)

    expect(yield* session.context(sessionID)).toMatchObject(expectedContext)
  })

const verifyPartialFlushOnFailure = (kind: FragmentKind) =>
  Effect.gen(function* () {
    yield* setup
    const session = yield* SessionV2.Service
    const prompt = `Fail after ${kind}`
    const fixture = fragmentFixture(kind, fragmentID(kind, "partial"), ["Partial"])
    const failure = providerUnavailable()
    yield* session.prompt({ sessionID, prompt: new Prompt({ text: prompt }), resume: false })
    responseStream = Stream.concat(Stream.fromIterable(fixture.partialEvents), Stream.fail(failure))

    expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(failure)
    expect(yield* session.context(sessionID)).toMatchObject([
      { type: "user", text: prompt },
      {
        type: "assistant",
        finish: "error",
        error: { type: "unknown", message: "Provider unavailable" },
        content: [
          kind === "tool input"
            ? { type: "tool", id: fragmentID(kind, "partial"), state: { status: "error" } }
            : fixture.expectedContent,
        ],
      },
    ])
  })

const verifyPartialFlushOnInterruption = (kind: FragmentKind) =>
  Effect.gen(function* () {
    yield* setup
    const session = yield* SessionV2.Service
    const prompt = `Interrupt after ${kind}`
    const fixture = fragmentFixture(kind, fragmentID(kind, "interrupted"), ["Partial"])
    const streamed = yield* Deferred.make<void>()
    yield* session.prompt({ sessionID, prompt: new Prompt({ text: prompt }), resume: false })
    responseStream = Stream.concat(
      Stream.fromIterable(fixture.partialEvents),
      Stream.fromEffect(Deferred.succeed(streamed, undefined)).pipe(Stream.flatMap(() => Stream.never)),
    )

    const runner = yield* SessionRunner.Service
    const fiber = yield* runner.run({ sessionID, force: true }).pipe(Effect.forkChild)
    yield* Deferred.await(streamed)
    yield* Fiber.interrupt(fiber)
    expect(yield* session.context(sessionID)).toMatchObject([
      { type: "user", text: prompt },
      {
        type: "assistant",
        content: [
          kind === "tool input"
            ? { type: "tool", id: fragmentID(kind, "interrupted"), state: { status: "error" } }
            : fixture.expectedContent,
        ],
      },
    ])
  })

describe("SessionRunnerLLM", () => {
  it.live("Cerebras replays durable reasoning after exactly one tool execution and a later prompt", () =>
    Effect.gen(function* () {
      yield* setup
      const bodies: Record<string, unknown>[] = []
      const sdk = yield* Effect.promise(() => createSDK({
        apiKey: "fixture-key",
        fetch: Object.assign(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const body: Record<string, unknown> = JSON.parse(String(init?.body))
          bodies.push(body)
          if (Array.isArray(body.messages) && body.messages.some((message) => message.role === "assistant" && "reasoning_content" in message))
            return Response.json({ message: "assistant.reasoning_content is unsupported", type: "invalid_request_error", param: "messages", code: "unsupported" }, { status: 422 })
          const first = bodies.length === 1
          return new Response([
            { choices: [{ index: 0, delta: { reasoning: first ? "Inspect before echo." : "The tool already ran." }, finish_reason: null }] },
            { choices: [{ index: 0, delta: first ? { tool_calls: [{ index: 0, id: "call-cerebras-echo", type: "function", function: { name: "echo", arguments: '{"text":"once"}' } }] } : { content: "Finished." }, finish_reason: first ? "tool_calls" : "stop" }] },
          ].map((chunk) => `data: ${JSON.stringify({ id: "fixture", model: "qwen-3.8-27b", created: 0, ...chunk })}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
        }, { preconnect: fetch.preconnect }),
      }))
      const language = sdk("qwen-3.8-27b")
      responseStreamFactory = (request) => SessionRunnerAISDK.stream(language, request)
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Use echo once" }), resume: false })
      yield* session.resume(sessionID)
      expect(bodies).toHaveLength(2)
      expect(executions).toEqual(["once"])
      expect(bodies[1]?.messages).toContainEqual(expect.objectContaining({ role: "assistant", reasoning: "Inspect before echo." }))
      expect(bodies[1]?.messages).toContainEqual(expect.objectContaining({ role: "tool", tool_call_id: "call-cerebras-echo" }))
      yield* replaySessionProjection(sessionID)
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Continue without repeating the tool" }), resume: false })
      yield* session.resume(sessionID)
      expect(bodies).toHaveLength(3)
      expect(executions).toEqual(["once"])
      expect(bodies[2]?.messages).toContainEqual(expect.objectContaining({ role: "assistant", reasoning: "Inspect before echo." }))
      expect(bodies[2]?.messages).toContainEqual(expect.objectContaining({ role: "assistant", reasoning: "The tool already ran.", content: "Finished." }))
      for (const body of bodies) {
        expect(body).not.toHaveProperty("store")
        expect(body).not.toHaveProperty("stream_options")
      }
      const context = yield* session.context(sessionID)
      expect(context.filter((item) => item.type === "assistant").at(-1)).toMatchObject({ finish: "stop", content: [{ type: "reasoning", text: "The tool already ran." }, { type: "text", text: "Finished." }] })
      responseStreamFactory = undefined
    }),
  )

  test("bounds implicit OpenRouter output without overriding explicit limits or other providers", () => {
    const openrouter = Model.make({ provider: "openrouter", id: "large", route: OpenRouter.route })
    const smaller = Model.make({
      provider: "openrouter",
      id: "small",
      route: OpenRouter.route.with({ limits: { context: 32_000, output: 2_048 } }),
    })

    expect(SessionRunnerLLM.defaultOpenRouterMaxTokens(openrouter, undefined)).toEqual({ maxTokens: 2_048 })
    expect(SessionRunnerLLM.defaultOpenRouterMaxTokens(smaller, undefined)).toEqual({ maxTokens: 2_048 })
    expect(SessionRunnerLLM.defaultOpenRouterMaxTokens(openrouter, { maxTokens: 4_096 })).toEqual({ maxTokens: 4_096 })
    expect(SessionRunnerLLM.defaultOpenRouterMaxTokens(model, undefined)).toBeUndefined()
  })

  test("keeps long OpenRouter prompts within the effective context budget", () => {
    // A real installed-build smoke rejected an OpenRouter request with
    // "Prompt tokens limit exceeded 32741 > 27492". OpenRouter's effective
    // budget is prompt tokens plus the requested output reservation, so
    // the previous 8192 reservation only allowed up to 19300 prompt tokens.
    // A long 24549-token repository prompt overflowed it
    // (24549 + 8192 = 32741 > 27492). The implicit 2048 reservation keeps
    // such prompts usable (24549 + 2048 = 26597 <= 27492).
    const openrouter = Model.make({ provider: "openrouter", id: "large", route: OpenRouter.route })
    const promptTokens = 24_549
    const effectiveBudget = 27_492
    const implicit = SessionRunnerLLM.defaultOpenRouterMaxTokens(openrouter, undefined)?.maxTokens ?? 0

    expect(promptTokens + implicit).toBeLessThanOrEqual(effectiveBudget)
  })

  test("does not retry deterministic OpenRouter 402 failures", () => {
    const failure = (status: number) =>
      new LLMError({
        module: "test",
        method: "stream",
        reason: Object.assign(new TransportReason({ message: `HTTP ${status}`, canRetry: true }), {
          http: { response: { status }, body: "quota" },
        }),
      })
    const openrouter = Model.make({ provider: "openrouter", id: "large", route: OpenRouter.route })

    expect(SessionRunnerLLM.retryableProviderFailure(openrouter, failure(402))).toBe(false)
    expect(SessionRunnerLLM.retryableProviderFailure(openrouter, failure(429))).toBe(true)
    expect(SessionRunnerLLM.retryableProviderFailure(model, failure(402))).toBe(true)
  })

  test("forces tool streaming only for Zhipu GLM 5.3 requests with tools", () => {
    const target = Model.make({ provider: "zhipuai-coding-plan", id: "glm-5.3", route: OpenAIChat.route })
    const otherModel = Model.make({ provider: "zhipuai-coding-plan", id: "glm-5.2", route: OpenAIChat.route })
    const otherProvider = Model.make({ provider: "openai", id: "glm-5.3", route: OpenAIChat.route })
    const body = { trace: "keep", tool_stream: false }
    const tools = [ToolDefinition.make({ name: "surface", description: "surface", inputSchema: { type: "object" } })]

    expect(SessionRunnerLLM.providerRequestBody(target, tools, body)).toEqual({ trace: "keep", tool_stream: true })
    expect(SessionRunnerLLM.providerRequestBody(target, tools)).toEqual({ tool_stream: true })
    expect(SessionRunnerLLM.providerRequestBody(target, [], body)).toBe(body)
    expect(SessionRunnerLLM.providerRequestBody(otherModel, tools, body)).toBe(body)
    expect(SessionRunnerLLM.providerRequestBody(otherProvider, tools, body)).toBe(body)
  })

  it.effect("sends tool_stream through the runner for Zhipu GLM 5.3 turns with tools", () =>
    Effect.gen(function* () {
      yield* setup
      currentModel = Model.make({ provider: "zhipuai-coding-plan", id: "glm-5.3", route: OpenAIChat.route })
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Open a surface" }), resume: false })

      requests.length = 0
      response = fragmentFixture("text", "text-zhipu-tool-stream", ["Done"]).completeEvents
      yield* session.resume(sessionID)

      const request = requests.at(-1)
      expect(request?.tools.length).toBeGreaterThan(0)
      expect(request?.http?.body).toMatchObject({ tool_stream: true })
    }),
  )

  it.effect("continues a Windows session after directory casing changes across restart", () =>
    Effect.gen(function* () {
      if (process.platform !== "win32") return
      yield* setup
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ directory: (yield* Location.Service).directory.toUpperCase() })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      requests.length = 0
      response = fragmentFixture("text", "text-restarted-location", ["continued"]).completeEvents
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Continue after restart" }), resume: false })

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Continue after restart" },
        { type: "assistant", content: [{ type: "text", text: "continued" }] },
      ])
      requests.length = 0
    }),
  )

  it.effect("advertises and executes a globally attached application tool", () =>
    Effect.gen(function* () {
      yield* setup
      const applicationTools = yield* ApplicationTools.Service
      const session = yield* SessionV2.Service
      const contexts: Tool.Context[] = []
      yield* applicationTools.register({
        application_context: Tool.make({
          description: "Read application context",
          input: Schema.Struct({ query: Schema.String }),
          output: Schema.Struct({ answer: Schema.String }),
          execute: ({ query }, context) =>
            Effect.sync(() => {
              contexts.push(context)
              return { answer: query.toUpperCase() }
            }),
        }),
      })
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Use application context" }), resume: false })
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-application", name: "application_context", input: { query: "hello" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        contentStopResponse,
      ]

      yield* session.resume(sessionID)

      expect(requests[0]?.tools.map((tool) => tool.name)).toContain("application_context")
      expect(contexts).toEqual([
        {
          sessionID,
          agent: AgentV2.ID.make("build"),
          assistantMessageID: expect.stringMatching(/^msg_/),
          toolCallID: "call-application",
          fileKnowledgeCutoff: 0,
          progress: expect.any(Function),
          skillGroupOutputs: [],
        },
      ])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Use application context" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-application",
              state: { status: "completed", structured: { answer: "HELLO" } },
            },
          ],
        },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Done" }] },
      ])
    }),
  )

  it.effect("rebuilds the prepared turn after a skill activates capability tools", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      capabilitySkillEnabled = true
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Use computer use" }), resume: false })
      requests.length = 0
      responses = [activateComputerUseTurn("call-computer-use"), contentStopResponse]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(requests[0]?.tools.map((tool) => tool.name)).not.toContain("browser_snapshot")
      expect(requests[1]?.tools.map((tool) => tool.name)).toContain("browser_snapshot")
      const skillCalls = (yield* session.context(sessionID)).flatMap((message) =>
        message.type === "assistant"
          ? message.content.filter((content) => content.type === "tool" && content.id === "call-computer-use")
          : [],
      )
      expect(skillCalls).toHaveLength(1)
    }),
  )

  it.effect("does not rebuild again when a repeated skill load keeps capability keys unchanged", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      capabilitySkillEnabled = true
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Load computer use twice" }), resume: false })
      requests.length = 0
      responses = [
        activateComputerUseTurn("call-computer-use-1"),
        activateComputerUseTurn("call-computer-use-2"),
        contentStopResponse,
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(3)
      expect(requests[0]?.tools.map((tool) => tool.name)).not.toContain("browser_snapshot")
      expect(requests[1]?.tools.map((tool) => tool.name)).toContain("browser_snapshot")
      expect(requests[2]?.tools.map((tool) => tool.name)).toContain("browser_snapshot")
      const skillCalls = (yield* session.context(sessionID)).flatMap((message) =>
        message.type === "assistant"
          ? message.content.filter((content) => content.type === "tool" && content.id.startsWith("call-computer-use-"))
          : [],
      )
      expect(skillCalls).toHaveLength(2)
    }),
  )

  it.effect("forces the StructuredOutput tool and stores the structured assistant value", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      requests.length = 0
      const schema = {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
        additionalProperties: false,
      }
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Return structured output", format: { type: "json_schema", schema } }),
        resume: false,
      })
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "call-structured", name: "StructuredOutput", input: { answer: "yes" } }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]

      yield* session.resume(sessionID)

      const tool = requests[0]?.tools.find((tool) => tool.name === "StructuredOutput")
      expect(tool?.description).toContain("Return the final answer as JSON matching the requested schema")
      expect(tool?.inputSchema).toEqual({
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
        additionalProperties: false,
      })
      expect(requests[0]?.toolChoice).toMatchObject({ type: "required" })
      expect(requests[0]?.system.map((part) => part.text).join("\n")).toContain(
        "MUST use the StructuredOutput tool for the final answer",
      )
      const assistant = (yield* session.context(sessionID)).find(
        (message): message is SessionMessage.Assistant => message.type === "assistant",
      )
      expect(assistant?.finish).toBe("stop")
      expect(assistant?.structured).toEqual({ answer: "yes" })
      expect(assistant?.content).toMatchObject([
        {
          type: "tool",
          id: "call-structured",
          name: "StructuredOutput",
          state: { status: "completed", structured: { valid: true } },
        },
      ])
    }),
  )

  it.effect("runs the registered review result shape with bounded confidence", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      requests.length = 0
      // Portable review plugin contract: keep numeric bounds in the runner path,
      // not just the collector decoder or an unconstrained fixture schema.
      const schema = {
        type: "object",
        properties: {
          findings: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" }, evidence: { type: "string" },
                risk: { enum: ["low", "medium", "high"] }, suggestedFix: { type: "string" },
                testRequirement: { type: "string" }, confidence: { type: "number", minimum: 0, maximum: 1 },
              },
              required: ["title", "evidence", "risk", "suggestedFix", "testRequirement", "confidence"],
              additionalProperties: false,
            },
          },
          notes: { type: "array", items: { type: "string" } },
        },
        required: ["findings", "notes"], additionalProperties: false,
      }
      const report = {
        findings: [{ title: "Defect", evidence: "source", risk: "low", suggestedFix: "fix", testRequirement: "test", confidence: 1 }],
        notes: [],
      }
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Review the change", format: { type: "json_schema", schema } }),
        resume: false,
      })
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "call-review-result", name: "StructuredOutput", input: report }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]
      yield* session.resume(sessionID)
      expect(requests).toHaveLength(1)
      expect(requests[0]?.tools.find((tool) => tool.name === "StructuredOutput")?.inputSchema).toEqual(schema)
      const assistant = (yield* session.context(sessionID)).find(
        (message): message is SessionMessage.Assistant => message.type === "assistant",
      )
      expect(assistant?.finish).toBe("stop")
      expect(assistant?.structured).toEqual(report)
      // A forced/advisory drain may observe a completed assignment, but must
      // never ask the model for an extra closure or a replacement report.
      const rerun = yield* (yield* SessionRunner.Service).run({ sessionID, force: true }).pipe(Effect.exit)
      expect(rerun._tag).toBe("Failure")
      expect(requests).toHaveLength(1)
      expect((yield* session.context(sessionID)).find((message) => message.id === assistant?.id))
        .toMatchObject({ structured: report, finish: "stop" })
    }),
  )

  it.effect("persists the structured attempt before entering the provider stream", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      requests.length = 0
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Return structured output", format: {
          type: "json_schema", schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
        } }),
        resume: false,
      })
      responseStreamFactory = () => Stream.unwrap(Effect.gen(function* () {
        const assistant = (yield* session.context(sessionID).pipe(Effect.orDie)).findLast(
          (message): message is SessionMessage.Assistant => message.type === "assistant",
        )
        expect(assistant?.structuredOutputAttempt).toMatchObject({
          version: 1, phase: "initial", mode: "tool", model: { id: "fake-model", providerID: "fake" },
        })
        return Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-pre-http", name: "StructuredOutput", input: { answer: "yes" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ])
      }))
      yield* session.resume(sessionID)
      expect(requests).toHaveLength(1)
    }),
  )

  for (const [index, finishes] of [
    [],
    [LLMEvent.stepFinish({ index: 0, reason: "length" })],
    [LLMEvent.stepFinish({ index: 0, reason: "stop" }), LLMEvent.stepFinish({ index: 1, reason: "stop" })],
  ].entries()) {
    it.effect(`refuses structured success without exactly one clean finish (${index})`, () =>
      Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        yield* session.prompt({ sessionID, resume: false, prompt: new Prompt({
          text: "Return an answer", format: { type: "json_schema", schema: {
            type: "object", properties: { answer: { type: "string" } }, required: ["answer"],
          }, retryCount: 10 },
        }) })
        requests.length = 0
        response = [LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-finish-contract", name: "StructuredOutput", input: { answer: "yes" } }),
          ...finishes, LLMEvent.finish({ reason: "stop" })]
        const exit = yield* session.resume(sessionID).pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
        expect(requests).toHaveLength(1)
        const assistant = (yield* session.context(sessionID)).findLast(
          (message): message is SessionMessage.Assistant => message.type === "assistant",
        )
        expect(assistant?.structured).toBeUndefined()
        expect(assistant?.finish).toBe("error")
      }),
    )
  }

  it.effect("rejects unsupported structured-output schema semantics before provider work", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      requests.length = 0
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Return an answer", format: {
          type: "json_schema", schema: { type: "object", not: {} },
        } }),
        resume: false,
      })
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "call-unsupported", name: "StructuredOutput", input: { answer: "yes" } }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]
      const exit = yield* session.resume(sessionID).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      expect(requests).toHaveLength(0)
    }),
  )

  it.effect("injects one provider-only instruction for an armed incomplete successor without losing its budget", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Complete the original task" }),
        resume: false,
      })
      yield* session.resume(sessionID)
      requests.length = 0

      expect(yield* SessionTurnContinuation.arm(db, sessionID, "activity_incomplete_1")).toMatchObject({ attempts: 1 })
      yield* session.resume(sessionID)

      expect(requests[0]?.system.map((part) => part.text).join("\n")).toContain(
        "The previous turn was judged incomplete",
      )
      expect(yield* SessionTurnContinuation.pending(db, sessionID)).toBeUndefined()
      expect(yield* SessionTurnContinuation.read(db, sessionID)).toMatchObject({
        activityID: "activity_incomplete_1",
        attempts: 1,
        consumedAt: expect.any(Number),
      })

      yield* session.resume(sessionID)
      expect(requests[1]?.system.map((part) => part.text).join("\n")).not.toContain(
        "The previous turn was judged incomplete",
      )
      expect(yield* SessionTurnContinuation.read(db, sessionID)).toMatchObject({ attempts: 1 })

      expect(yield* SessionTurnContinuation.arm(db, sessionID, "activity_incomplete_2")).toMatchObject({ attempts: 2 })
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Start a new explicit request" }),
        resume: false,
      })
      yield* session.resume(sessionID)
      expect(requests[2]?.system.map((part) => part.text).join("\n")).not.toContain(
        "The previous turn was judged incomplete",
      )
      expect(yield* SessionTurnContinuation.read(db, sessionID)).toBeUndefined()
    }),
  )

  it.effect("marks formatted prompts failed when the model omits StructuredOutput", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      requests.length = 0
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({
          text: "Return structured output",
          format: { type: "json_schema", schema: { type: "object", properties: { answer: { type: "string" } } }, retryCount: 0 },
        }),
        resume: false,
      })
      response = fragmentFixture("text", "text-unstructured", ["plain text"]).completeEvents

      const exit = yield* session.resume(sessionID).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")

      const assistant = (yield* session.context(sessionID)).find(
        (message): message is SessionMessage.Assistant => message.type === "assistant",
      )
      expect(requests[0]?.toolChoice).toMatchObject({ type: "required" })
      expect(assistant?.finish).toBe("error")
      expect(assistant?.error).toEqual({ type: "unknown", message: "Model did not produce structured output" })
      expect(assistant?.failure).toMatchObject({
        code: "provider.invalid-response",
        retryability: "none",
        remediation: "retry",
        cause: { detail: "structured output" },
      })
      expect(assistant?.structured).toBeUndefined()
    }),
  )

  it.effect("marks schema-formatted StructuredOutput failed when findings arrive as a JSON string", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      requests.length = 0
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({
          text: "Return structured output",
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: {
                findings: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: { title: { type: "string" } },
                    required: ["title"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["findings"],
              additionalProperties: false,
            },
            retryCount: 0,
          },
        }),
        resume: false,
      })
      // Mirrors reviewer evidence 1729: the provider delivered findings as a
      // JSON-encoded string instead of the required array. That payload must
      // not settle as completed/valid structured output.
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({
          id: "call-structured-string-findings",
          name: "StructuredOutput",
          input: { findings: JSON.stringify([{ title: "kept evidence" }]) },
        }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]

      const failure = yield* session.resume(sessionID).pipe(Effect.flip)

      expect(failure).toBeInstanceOf(LLMError)
      expect(failure).toMatchObject({
        reason: { kind: "invalid-tool-input", canRetry: false },
      })

      const assistant = (yield* session.context(sessionID)).find(
        (message): message is SessionMessage.Assistant => message.type === "assistant",
      )
      expect(assistant?.finish).toBe("error")
      expect(assistant?.error).toEqual({
        type: "unknown",
        message: "StructuredOutput input does not match the requested schema",
      })
      expect(assistant?.failure).toMatchObject({
        code: "provider.invalid-response",
        retryability: "none",
        remediation: "retry",
        cause: { detail: "structured output" },
      })
      expect(assistant?.structured).toBeUndefined()
      expect(assistant?.content).not.toMatchObject([
        {
          type: "tool",
          id: "call-structured-string-findings",
          name: "StructuredOutput",
          state: { status: "completed", structured: { valid: true } },
        },
      ])
    }),
  )

  it.effect("accepts a valid findings array and rejects excess properties on the same schema", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const schema = {
        type: "object",
        properties: {
          findings: {
            type: "array",
            items: {
              type: "object",
              properties: { title: { type: "string" } },
              required: ["title"],
              additionalProperties: false,
            },
          },
        },
        required: ["findings"],
        additionalProperties: false,
      }
      // Positive shape: the array form the 1729 reviewer actually produced
      // (before string encoding) must settle completed/valid.
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Return structured output", format: { type: "json_schema", schema } }),
        resume: false,
      })
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({
          id: "call-structured-array-findings",
          name: "StructuredOutput",
          input: { findings: [{ title: "kept evidence" }] },
        }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]
      yield* session.resume(sessionID)
      const valid = (yield* session.context(sessionID)).find(
        (message): message is SessionMessage.Assistant => message.type === "assistant",
      )
      expect(valid?.finish).toBe("stop")
      expect(valid?.structured).toEqual({ findings: [{ title: "kept evidence" }] })

      // Excess properties on a closed schema must not be silently stripped
      // into a valid marker: the parent JSON decoder would reject them.
      const excessSessionID = SessionV2.ID.make(`ses_runner_structured_excess_${Date.now()}`)
      yield* insertSession(excessSessionID)
      yield* session.prompt({
        sessionID: excessSessionID,
        prompt: new Prompt({ text: "Return structured output", format: { type: "json_schema", schema, retryCount: 0 } }),
        resume: false,
      })
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({
          id: "call-structured-excess-findings",
          name: "StructuredOutput",
          input: { findings: [{ title: "kept evidence", extra: 1 }] },
        }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]
      const failure = yield* session.resume(excessSessionID).pipe(Effect.flip)
      expect(failure).toBeInstanceOf(LLMError)
      expect(failure).toMatchObject({
        reason: { kind: "invalid-tool-input", canRetry: false },
      })
      const invalid = (yield* session.context(excessSessionID)).find(
        (message): message is SessionMessage.Assistant => message.type === "assistant",
      )
      expect(invalid?.finish).toBe("error")
      expect(invalid?.failure).toMatchObject({
        code: "provider.invalid-response",
        cause: { detail: "structured output" },
      })
      expect(invalid?.structured).toBeUndefined()
      expect(invalid?.content).not.toMatchObject([
        {
          type: "tool",
          id: "call-structured-excess-findings",
          name: "StructuredOutput",
          state: { status: "completed", structured: { valid: true } },
        },
      ])
    }),
  )

  it.effect("settles schema-invalid StructuredOutput as runner error without provider replay", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const execution = yield* SessionExecution.Service
      const { db } = yield* Database.Service
      const lifecycleID = SessionV2.ID.make(`ses_runner_structured_lifecycle_${Date.now()}`)
      yield* insertSession(lifecycleID)
      const schema = {
        type: "object",
        properties: {
          findings: {
            type: "array",
            items: {
              type: "object",
              properties: { title: { type: "string" } },
              required: ["title"],
              additionalProperties: false,
            },
          },
        },
        required: ["findings"],
        additionalProperties: false,
      }
      yield* session.prompt({
        sessionID: lifecycleID,
        prompt: new Prompt({ text: "Return structured output", format: { type: "json_schema", schema, retryCount: 0 } }),
        resume: false,
      })
      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({
          id: "call-structured-lifecycle",
          name: "StructuredOutput",
          input: { findings: JSON.stringify([{ title: "kept evidence" }]) },
        }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]
      const settled: Array<EventV2.Data<typeof SessionRunner.Settled>> = []
      const unsubscribe = yield* EventV2.Service.pipe(
        Effect.flatMap((events) =>
          events.listen((event) => {
            if (event.type === SessionRunner.Settled.type)
              settled.push(event.data as EventV2.Data<typeof SessionRunner.Settled>)
            return Effect.void
          }),
        ),
      )
      const failure = yield* session.resume(lifecycleID).pipe(Effect.flip)
      expect(failure).toBeInstanceOf(LLMError)
      expect(failure).toMatchObject({
        reason: { kind: "invalid-tool-input", canRetry: false },
      })
      yield* unsubscribe
      // The failed run settles the runner as error: no completed settlement
      // may overwrite the typed schema failure.
      expect(settled).toEqual([{ sessionID: lifecycleID, status: "error" }])
      const lifecycle = (yield* session.context(lifecycleID)).find(
        (message): message is SessionMessage.Assistant => message.type === "assistant",
      )
      expect(lifecycle?.finish).toBe("error")
      expect(lifecycle?.structured).toBeUndefined()
      expect(lifecycle?.failure).toMatchObject({
        code: "provider.invalid-response",
        cause: { detail: "structured output" },
      })
      // An advisory wake without pending input must not replay the provider:
      // the durable failure stands and no new provider turn starts. The
      // runner-fixture wake schedules the coordinator drain; wait() observes
      // its settlement. This is the runner-level no-replay contract: the
      // LocalExecution Activity FAILED/noCompleted drain is covered by the
      // session-empty-wake probe pattern, not duplicated here.
      const providerTurns = requests.length
      yield* execution.wake(lifecycleID)
      yield* execution.wait(lifecycleID)
      expect(requests.length).toBe(providerTurns)
      const afterWake = (yield* session.context(lifecycleID)).findLast(
        (message): message is SessionMessage.Assistant => message.type === "assistant",
      )
      expect(afterWake?.finish).toBe("error")
      // The runner-level settlement contract: SessionRunner.Settled error was
      // already asserted above, and the durable assistant carries the typed
      // Step.Failed evidence. No completed settlement may overwrite it, and
      // the advisory wake above produced no new provider turn.
      expect(settled.some((entry) => entry.status === "completed")).toBe(false)
    }),
  )

  it.effect("accepts valid $defs-referenced StructuredOutput values", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({
          text: "Return structured output",
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: { answer: { $ref: "#/$defs/Answer" } },
              required: ["answer"],
              additionalProperties: false,
              $defs: { Answer: { type: "string" } },
            },
          },
        }),
        resume: false,
      })
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "call-structured-defs", name: "StructuredOutput", input: { answer: "yes" } }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]
      yield* session.resume(sessionID)
      const assistant = (yield* session.context(sessionID)).find(
        (message): message is SessionMessage.Assistant => message.type === "assistant",
      )
      expect(assistant?.finish).toBe("stop")
      expect(assistant?.structured).toEqual({ answer: "yes" })
    }),
  )

  it.effect("accepts legacy definitions-referenced StructuredOutput values", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({
          text: "Return structured output",
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: { answer: { $ref: "#/definitions/Answer" } },
              required: ["answer"],
              additionalProperties: false,
              definitions: { Answer: { type: "string" } },
            },
          },
        }),
        resume: false,
      })
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({
          id: "call-structured-definitions",
          name: "StructuredOutput",
          input: { answer: "yes" },
        }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]
      yield* session.resume(sessionID)
      const assistant = (yield* session.context(sessionID)).find(
        (message): message is SessionMessage.Assistant => message.type === "assistant",
      )
      expect(assistant?.finish).toBe("stop")
      expect(assistant?.structured).toEqual({ answer: "yes" })
    }),
  )

  it.effect("fails schema-invalid StructuredOutput even when the same turn settles another tool", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const schema = {
        type: "object",
        properties: {
          findings: {
            type: "array",
            items: {
              type: "object",
              properties: { title: { type: "string" } },
              required: ["title"],
              additionalProperties: false,
            },
          },
        },
        required: ["findings"],
        additionalProperties: false,
      }
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Return structured output", format: { type: "json_schema", schema, retryCount: 0 } }),
        resume: false,
      })
      requests.length = 0
      // With correction disabled, a settled local tool cannot rescue an
      // invalid result in the same provider turn.
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "call-echo-mixed", name: "echo", input: { text: "kept" } }),
        LLMEvent.toolCall({
          id: "call-structured-mixed-invalid",
          name: "StructuredOutput",
          input: { findings: JSON.stringify([{ title: "kept evidence" }]) },
        }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]
      const failure = yield* session.resume(sessionID).pipe(Effect.flip)
      expect(failure).toBeInstanceOf(LLMError)
      expect(failure).toMatchObject({
        reason: { kind: "invalid-tool-input", canRetry: false },
      })
      expect(requests.length).toBe(1)
      const assistant = (yield* session.context(sessionID)).find(
        (message): message is SessionMessage.Assistant => message.type === "assistant",
      )
      expect(assistant?.finish).toBe("error")
      expect(assistant?.structured).toBeUndefined()
      expect(assistant?.failure).toMatchObject({
        code: "provider.invalid-response",
        cause: { detail: "structured output" },
      })
    }),
  )

  for (const retryCount of [0, 1]) {
    it.effect(`missing-output exhaustion: normal lane fails after ${retryCount} correction turns`, () =>
      Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID,
          prompt: new Prompt({
            text: "Return the required answer",
            format: {
              type: "json_schema",
              schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
              retryCount,
            },
          }),
          resume: false,
        })
        requests.length = 0
        responses = Array.from({ length: retryCount + 1 }, () => contentStopResponse)
        const exit = yield* withStructuredOwner(session.resume(sessionID)).pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
        expect(requests).toHaveLength(retryCount + 1)
        expect((yield* session.context(sessionID)).findLast((message) => message.type === "assistant")?.finish).toBe(
          "error",
        )
      }),
    )
  }

  for (const steps of [undefined, 0]) {
    for (const retryCount of [1, 10]) {
      it.effect(`corrects an invalid result once with durable receipts (steps=${steps}, retryCount=${retryCount})`, () =>
        Effect.gen(function* () {
          yield* setup
          if (steps !== undefined) yield* setBuildAgentSteps(steps)
          const session = yield* SessionV2.Service
          yield* session.prompt({ sessionID, resume: false, prompt: new Prompt({
            text: "Return structured output",
            format: { type: "json_schema", schema: {
              type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false,
            }, retryCount },
          }) })
          requests.length = 0
          responses = [
            [LLMEvent.stepStart({ index: 0 }),
              LLMEvent.toolCall({ id: "invalid-first", name: "StructuredOutput", input: { answer: 42 } }),
              LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }), LLMEvent.finish({ reason: "tool-calls" })],
            [LLMEvent.stepStart({ index: 0 }),
              LLMEvent.toolCall({ id: "valid-correction", name: "StructuredOutput", input: { answer: "yes" } }),
              LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }), LLMEvent.finish({ reason: "tool-calls" })],
          ]
          yield* withStructuredOwner(session.resume(sessionID))
          expect(requests).toHaveLength(2)
          expect(requests[1]?.tools.map((tool) => tool.name)).toEqual(["StructuredOutput"])
          const assistants = (yield* session.context(sessionID)).filter(
            (message): message is SessionMessage.Assistant => message.type === "assistant",
          )
          expect(assistants.map((message) => message.structuredOutputAttempt?.phase)).toEqual(["initial", "correction"])
          expect(assistants[0]?.error).toBeUndefined()
          expect(assistants[0]?.content).toMatchObject([{ type: "tool", state: { status: "error" } }])
          expect(assistants[1]?.structured).toEqual({ answer: "yes" })
          expect(assistants[1]?.structuredOutputAttempt).toMatchObject({
            ...assistants[0]?.structuredOutputAttempt, phase: "correction",
          })
          const execution = yield* SessionExecution.Service
          yield* execution.wake(sessionID)
          yield* execution.wait(sessionID)
          expect(requests).toHaveLength(2)
        }),
      )
    }
  }

  it.effect("retries a schema-formatted turn when the model initially omits StructuredOutput", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      requests.length = 0
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({
          text: "Return structured output",
          format: {
            type: "json_schema",
            schema: { type: "object", properties: { answer: { type: "string" } } },
            retryCount: 1,
          },
        }),
        resume: false,
      })
      responses = [
        fragmentFixture("text", "text-unstructured-retry", ["plain text"]).completeEvents,
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-structured-retry", name: "StructuredOutput", input: { answer: "yes" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
      ]

      yield* withStructuredOwner(session.resume(sessionID))

      expect(requests).toHaveLength(2)
      expect(requests[0]?.tools.map((tool) => tool.name)).toContain("StructuredOutput")
      expect(requests[1]?.tools.map((tool) => tool.name)).toEqual(["StructuredOutput"])
      expect(requests[1]?.toolChoice).toMatchObject({ type: "required" })
      expect(requests[1]?.system.map((part) => part.text).join("\n")).toContain(
        "still missing or did not match the requested schema",
      )
      expect((yield* session.context(sessionID)).findLast((message) => message.type === "assistant")).toMatchObject({
        structured: { answer: "yes" },
      })
    }),
  )

  it.effect("updates session summary from a file-mutating runner turn", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      snapshotTracks = ["snap-start", "snap-end"]
      snapshotDiffs = [
        {
          file: "src/example.ts",
          patch: "diff --git a/src/example.ts b/src/example.ts",
          additions: 2,
          deletions: 1,
          status: "modified",
        },
      ]
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Edit a file" }), resume: false })
      responses = [
        localToolTurn("call-file-edit", { text: "Edit src/example.ts" }),
        fragmentFixture("text", "text-file-edit", ["Edited"]).completeEvents,
      ]

      yield* session.resume(sessionID)

      expect(snapshotTracks).toEqual([])
      expect((yield* session.get(sessionID)).summary).toEqual({
        additions: 2,
        deletions: 1,
        files: 1,
        diffs: snapshotDiffs,
      })
    }),
  )

  it.effect("starts a real runner turn after default prompt recording", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      requests.length = 0
      responses = undefined
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()
      response = contentStopResponse

      const message = yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Run automatically" }) })
      yield* Deferred.await(streamStarted)

      expect(requests).toHaveLength(1)
      expect(yield* session.messages({ sessionID })).toMatchObject([
        { id: message.id, type: "user", text: "Run automatically" },
      ])
      yield* Deferred.succeed(streamGate, undefined)
      yield* SessionRunCoordinator.Service.pipe(Effect.flatMap((coordinator) => coordinator.awaitIdle(sessionID)))
      streamGate = undefined
      streamStarted = undefined
    }),
  )

  it.effect("publishes a process-local settlement when a runner exits", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Publish settlement" }), resume: false })

      const settled: Array<EventV2.Data<typeof SessionRunner.Settled>> = []
      const unsubscribe = yield* EventV2.Service.pipe(
        Effect.flatMap((events) =>
          events.listen((event) => {
            if (event.type === SessionRunner.Settled.type)
              settled.push(event.data as EventV2.Data<typeof SessionRunner.Settled>)
            return Effect.void
          }),
        ),
      )
      const runner = yield* SessionRunner.Service
      yield* runner.run({ sessionID, force: true })
      yield* unsubscribe

      expect(settled).toEqual([{ sessionID, status: "completed" }])
    }),
  )

  it.effect("externalizes duplicate user media before admission and materializes it only for the provider", () =>
    Effect.gen(function* () {
      yield* setup
      yield* insertSession(otherSessionID)
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const blobsBefore =
        (yield* db
          .select({ value: sql<number>`count(*)` })
          .from(ContentBlobTable)
          .get())?.value ?? 0
      const attachmentsBefore =
        (yield* db
          .select({ value: sql<number>`count(*)` })
          .from(AttachmentTable)
          .get())?.value ?? 0
      const file = new FileAttachment({
        uri: "data:image/png;base64,aGVsbG8=",
        mime: "image/png",
        name: "pixel.png",
      })
      const first = yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Inspect the first image", files: [file] }),
        resume: false,
      })
      const second = yield* session.prompt({
        sessionID: otherSessionID,
        prompt: new Prompt({ text: "Inspect the same image", files: [file] }),
        resume: false,
      })

      const inputs = yield* db
        .select({ id: SessionInputTable.id, prompt: SessionInputTable.prompt })
        .from(SessionInputTable)
        .where(inArray(SessionInputTable.id, [first.id, second.id]))
        .all()
        .pipe(Effect.orDie)
      const recorded = yield* db
        .select({ data: EventTable.data })
        .from(EventTable)
        .where(inArray(EventTable.aggregate_id, [sessionID, otherSessionID]))
        .all()
        .pipe(Effect.orDie)
      for (const durable of [JSON.stringify(inputs), JSON.stringify(recorded)]) {
        expect(durable).toContain(ContentStore.URI_PREFIX)
        expect(durable).not.toContain("data:image")
        expect(durable).not.toContain(";base64,")
      }
      expect(
        (yield* db
          .select({ value: sql<number>`count(*)` })
          .from(ContentBlobTable)
          .get())!.value - blobsBefore,
      ).toBe(1)
      expect(
        (yield* db
          .select({ value: sql<number>`count(*)` })
          .from(AttachmentTable)
          .get())!.value - attachmentsBefore,
      ).toBe(2)

      requests.length = 0
      response = contentStopResponse
      yield* session.resume(sessionID)

      const durableMessages = yield* db
        .select({ data: SessionMessageTable.data })
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      expect(JSON.stringify(durableMessages)).toContain(ContentStore.URI_PREFIX)
      expect(JSON.stringify(durableMessages)).not.toContain("data:image")
      expect(requests).toHaveLength(1)
      expect(requests[0]?.messages[0]?.content).toEqual([
        { type: "text", text: "Inspect the first image" },
        {
          type: "media",
          mediaType: "image/png",
          data: "data:image/png;base64,aGVsbG8=",
          filename: "pixel.png",
          metadata: undefined,
        },
      ])
    }),
  )

  it.effect("materializes stored images before delegating them for a text-only model", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      currentModel = textOnlyModel
      const message = yield* session.prompt({
        sessionID,
        prompt: new Prompt({
          text: "What is shown?",
          files: [
            new FileAttachment({
              uri: "data:image/png;base64,aGVsbG8=",
              mime: "image/png",
              name: "pixel.png",
            }),
          ],
        }),
        resume: false,
      })
      const analysis = "The image contains a small test pixel."
      requests.length = 0
      responses = [
        fragmentFixture("text", "vision-analysis", [analysis]).completeEvents,
        fragmentFixture("text", "target-answer", ["It contains a test pixel."]).completeEvents,
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(requests[0]?.model).toBe(visionModel)
      expect(requests[0]?.system.some((part) => part.text.startsWith("OpenCode host session (authoritative): "))).toBe(false)
      expect(requests[1]?.system.filter((part) => part.text.startsWith("OpenCode host session (authoritative): "))).toHaveLength(1)
      expect(requests[0]?.messages).toMatchObject([
        {
          role: "user",
          content: [
            {
              type: "media",
              mediaType: "image/png",
              data: "data:image/png;base64,aGVsbG8=",
              filename: "pixel.png",
            },
          ],
        },
      ])
      expect(requests[1]?.model).toBe(textOnlyModel)
      expect(JSON.stringify(requests[1]?.messages)).toContain("vision analysis by delegated model")
      expect(JSON.stringify(requests[1]?.messages)).toContain(analysis)
      expect(JSON.stringify(requests[1]?.messages)).not.toContain("omitted: unsupported attachment type")
      expect(
        (yield* db
          .select({ metadata: SessionTable.metadata })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get()
          .pipe(Effect.orDie))?.metadata?.vision_analysis,
      ).toEqual({ [`${message.id}:0`]: analysis })
    }),
  )

  it.live("fails message materialization terminally when its total deadline expires", () =>
    Effect.gen(function* () {
      let interrupted = false
      const failure = yield* SessionRunnerLLM.withMessageMaterializationBoundary(
        sessionID,
        Effect.never.pipe(Effect.ensuring(Effect.sync(() => (interrupted = true)))),
        10,
      ).pipe(Effect.flip)

      expect(failure).toBeInstanceOf(ContentStore.StorageError)
      expect(failure).toMatchObject({
        operation: "read",
        resource: `session:${sessionID}:messages`,
      })
      expect(interrupted).toBe(true)
    }),
  )

  it.live("fails open when delegated vision model resolution times out", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      currentModel = textOnlyModel
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({
          text: "Describe this image",
          files: [
            new FileAttachment({
              uri: "data:image/png;base64,aGVsbG8=",
              mime: "image/png",
              name: "pixel.png",
            }),
          ],
        }),
        resume: false,
      })

      let resolutions = 0
      modelResolveHook = Effect.suspend(() => (++resolutions === 2 ? Effect.never : Effect.void))
      requests.length = 0
      const previous = process.env.OPENCODE_SESSION_VISION_MODEL_RESOLVE_TIMEOUT_MS
      process.env.OPENCODE_SESSION_VISION_MODEL_RESOLVE_TIMEOUT_MS = "10"
      try {
        yield* session.resume(sessionID)
      } finally {
        modelResolveHook = Effect.void
        if (previous === undefined) delete process.env.OPENCODE_SESSION_VISION_MODEL_RESOLVE_TIMEOUT_MS
        else process.env.OPENCODE_SESSION_VISION_MODEL_RESOLVE_TIMEOUT_MS = previous
      }

      expect(requests.map((request) => request.model)).toEqual([textOnlyModel])
      expect(JSON.stringify(requests[0]?.messages)).toContain("omitted: unsupported attachment type")
      expect(JSON.stringify(requests[0]?.messages)).not.toContain("vision analysis by delegated model")
    }),
  )

  it.live("fails open when the delegated vision stream times out", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      currentModel = textOnlyModel
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({
          text: "Describe this image",
          files: [
            new FileAttachment({
              uri: "data:image/png;base64,aGVsbG8=",
              mime: "image/png",
              name: "pixel.png",
            }),
          ],
        }),
        resume: false,
      })

      let streams = 0
      responseStreamFactory = () => (++streams === 1 ? Stream.never : Stream.fromIterable(contentStopResponse))
      requests.length = 0
      const previous = process.env.OPENCODE_SESSION_VISION_STREAM_TIMEOUT_MS
      process.env.OPENCODE_SESSION_VISION_STREAM_TIMEOUT_MS = "10"
      try {
        yield* session.resume(sessionID)
      } finally {
        responseStreamFactory = undefined
        if (previous === undefined) delete process.env.OPENCODE_SESSION_VISION_STREAM_TIMEOUT_MS
        else process.env.OPENCODE_SESSION_VISION_STREAM_TIMEOUT_MS = previous
      }

      expect(requests.map((request) => request.model)).toEqual([visionModel, textOnlyModel])
      expect(JSON.stringify(requests[1]?.messages)).toContain("omitted: unsupported attachment type")
      expect(JSON.stringify(requests[1]?.messages)).not.toContain("vision analysis by delegated model")
    }),
  )

  it.effect("fails open on vision errors and preserves external interruption", () =>
    Effect.gen(function* () {
      expect(
        yield* SessionRunnerLLM.withVisionBoundary({
          sessionID,
          phase: "model_resolve",
          timeoutMs: 60_000,
          effect: Effect.fail(new Error("vision unavailable")),
          fallback: "original",
        }),
      ).toBe("original")

      let interrupted = false
      const fiber = yield* Effect.forkScoped(
        SessionRunnerLLM.withVisionBoundary({
          sessionID,
          phase: "delegation",
          timeoutMs: 60_000,
          effect: Effect.never.pipe(Effect.ensuring(Effect.sync(() => (interrupted = true)))),
          fallback: "fallback",
        }),
      )
      yield* Effect.yieldNow
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)

      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(interrupted).toBe(true)
    }),
  )

  it.effect("streams one request with registry definitions from chronological V2 user history", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First" }), resume: false })
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Second" }), resume: false })

      requests.length = 0
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = contentStopResponse
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.model).toBe(model)
      expect(requests[0]?.tools.map((tool) => tool.name)).toEqual(["echo", "defect", "failure"])
      expect(requests[0]?.messages.map((message) => ({ role: message.role, content: message.content }))).toEqual([
        { role: "user", content: [{ type: "text", text: "First" }] },
        { role: "user", content: [{ type: "text", text: "Second" }] },
      ])
      expect(yield* session.messages({ sessionID })).toHaveLength(3)
    }),
  )

  it.effect("omits registry definitions for models without tool support", () =>
    Effect.gen(function* () {
      yield* setup
      currentModelSupportsTools = false
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Answer without tools" }), resume: false })

      requests.length = 0
      response = contentStopResponse
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.tools).toEqual([])
    }),
  )

  it.effect("reuses run-local history for tool continuation without reloading older rows", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const cacheSessionID = SessionV2.ID.make("ses_runner_history_cache")
      yield* insertSession(cacheSessionID)
      const earlier = yield* session.prompt({
        sessionID: cacheSessionID,
        prompt: new Prompt({ text: "Earlier" }),
        resume: false,
      })
      response = fragmentFixture("text", "text-earlier-cache", ["Earlier answer"]).completeEvents
      yield* session.resume(cacheSessionID)

      requests.length = 0
      responses = [
        localToolTurn("call-cache", { text: "cached" }),
        fragmentFixture("text", "text-final-cache", ["Done"]).completeEvents,
      ]
      toolExecutionHook = db
        .update(SessionMessageTable)
        .set({ data: sql`json('{}')` })
        .where(eq(SessionMessageTable.id, earlier.id))
        .run()
        .pipe(Effect.orDie)
      yield* session.prompt({
        sessionID: cacheSessionID,
        prompt: new Prompt({ text: "Use cached continuation" }),
        resume: false,
      })

      yield* session.resume(cacheSessionID)

      expect(requests).toHaveLength(2)
      expect(requests[1]?.messages.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
        "tool",
      ])
      expect(userTexts(requests[1]!)).toEqual(["Earlier", "Use cached continuation"])
      expect(executions).toEqual(["cached"])
    }),
  )

  it.effect("reloads tool continuation history when system context advances", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const contextSessionID = SessionV2.ID.make("ses_runner_history_context")
      yield* insertSession(contextSessionID)
      requests.length = 0
      responses = [
        localToolTurn("call-context", { text: "advance context" }),
        fragmentFixture("text", "text-context-final", ["Done"]).completeEvents,
      ]
      toolExecutionHook = Effect.sync(() => {
        systemBaseline = "Changed context"
      })
      yield* session.prompt({
        sessionID: contextSessionID,
        prompt: new Prompt({ text: "Use tool after context change" }),
        resume: false,
      })

      yield* session.resume(contextSessionID)

      expect(requests).toHaveLength(2)
      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "system"])
      expect(requests[1]?.messages.at(-1)?.content).toEqual([{ type: "text", text: "Changed context" }])
    }),
  )

  it.effect("reloads tool continuation history when a steer arrives during tool settlement", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const steerSessionID = SessionV2.ID.make("ses_runner_history_steer")
      yield* insertSession(steerSessionID)
      requests.length = 0
      responses = [
        localToolTurn("call-steer", { text: "steer" }),
        fragmentFixture("text", "text-steer-final", ["Done"]).completeEvents,
      ]
      toolExecutionHook = session
        .prompt({ sessionID: steerSessionID, prompt: new Prompt({ text: "Steer during tool" }), resume: false })
        .pipe(Effect.asVoid, Effect.orDie)
      yield* session.prompt({
        sessionID: steerSessionID,
        prompt: new Prompt({ text: "Start tool work" }),
        resume: false,
      })

      yield* session.resume(steerSessionID)

      expect(requests).toHaveLength(2)
      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "user"])
      expect(userTexts(requests[1]!)).toEqual(["Start tool work", "Steer during tool"])
    }),
  )

  it.live("records request assembly and provider turn perf events", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const metricsSessionID = SessionV2.ID.make(`ses_runner_metrics_${Date.now()}`)
      yield* insertSession(metricsSessionID)
      yield* session.prompt({
        sessionID: metricsSessionID,
        prompt: new Prompt({ text: "Measure runner" }),
        resume: false,
      })
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-metrics" }),
        LLMEvent.textDelta({ id: "text-metrics", text: "ok" }),
        LLMEvent.textEnd({ id: "text-metrics" }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]

      yield* session.resume(metricsSessionID)

      const events = (yield* Effect.promise(() => readFile(path.join(Global.Path.log, "perf.jsonl"), "utf8")))
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              kind?: string
              source?: string
              sessionID?: string
              history_load_ms?: number
              session_load_ms?: number
              plugin_boot_ms?: number
              agent_selection_ms?: number
              context_epoch_ms?: number
              model_resolution_ms?: number
              model_cost_ms?: number
              model_capabilities_ms?: number
              history_bound_ms?: number
              mcp_ensure_ms?: number
              permission_materialization_ms?: number
              tool_materialization_ms?: number
              snapshot_start_ms?: number
              message_materialization_ms?: number
              vision_delegation_ms?: number
              model_messages_ms?: number
              prepare_llm_request_ms?: number
              hook_system_transform_ms?: number
              hook_messages_transform_ms?: number
              hook_params_ms?: number
              hook_headers_ms?: number
              request_assembly_ms?: number
              message_count?: number
              system_prompt_chars?: number
              system_prompt_estimate_tokens?: number
              tool_count?: number
              tool_ids?: string[]
              surface_available?: boolean
              tool_policy_source?: string
              tool_schema_bytes?: number
              context_estimate_ms?: number
              context_estimate_tokens?: number
              first_event_ms?: number
              ttfb_ms?: number
            },
        )
        .filter((event) => event.sessionID === metricsSessionID)
      expect(
        events.some(
          (event) =>
            event.kind === "request_assembly" &&
            event.source === "core-session-runner" &&
            typeof event.history_load_ms === "number" &&
            typeof event.session_load_ms === "number" &&
            typeof event.plugin_boot_ms === "number" &&
            typeof event.agent_selection_ms === "number" &&
            typeof event.context_epoch_ms === "number" &&
            typeof event.model_resolution_ms === "number" &&
            typeof event.model_cost_ms === "number" &&
            typeof event.model_capabilities_ms === "number" &&
            typeof event.history_bound_ms === "number" &&
            typeof event.mcp_ensure_ms === "number" &&
            typeof event.permission_materialization_ms === "number" &&
            typeof event.tool_materialization_ms === "number" &&
            typeof event.snapshot_start_ms === "number" &&
            typeof event.message_materialization_ms === "number" &&
            typeof event.vision_delegation_ms === "number" &&
            typeof event.model_messages_ms === "number" &&
            typeof event.prepare_llm_request_ms === "number" &&
            typeof event.hook_system_transform_ms === "number" &&
            typeof event.hook_messages_transform_ms === "number" &&
            typeof event.hook_params_ms === "number" &&
            typeof event.hook_headers_ms === "number" &&
            typeof event.request_assembly_ms === "number" &&
            typeof event.message_count === "number" &&
            typeof event.system_prompt_chars === "number" &&
            typeof event.system_prompt_estimate_tokens === "number" &&
            typeof event.tool_count === "number" &&
            Array.isArray(event.tool_ids) &&
            event.surface_available === event.tool_ids.includes("surface") &&
            typeof event.tool_policy_source === "string" &&
            typeof event.tool_schema_bytes === "number" &&
            typeof event.context_estimate_ms === "number" &&
            event.context_estimate_ms >= 0 &&
            typeof event.context_estimate_tokens === "number",
        ),
      ).toBe(true)
      expect(
        events.some(
          (event) =>
            event.kind === "provider_turn" &&
            event.source === "core-session-runner" &&
            typeof event.first_event_ms === "number" &&
            typeof event.ttfb_ms === "number",
        ),
      ).toBe(true)

      const structuralSessionID = SessionV2.ID.make(`ses_runner_structural_${Date.now()}`)
      yield* insertSession(structuralSessionID)
      yield* session.prompt({
        sessionID: structuralSessionID,
        prompt: new Prompt({ text: "Measure structural" }),
        resume: false,
      })
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-structural" }),
        LLMEvent.stepFinish({ index: 0, reason: "content-filter" }),
        LLMEvent.finish({ reason: "content-filter" }),
      ]

      expect(yield* session.resume(structuralSessionID).pipe(Effect.exit)).toMatchObject({ _tag: "Failure" })

      const structuralTurn = (yield* Effect.promise(() => readFile(path.join(Global.Path.log, "perf.jsonl"), "utf8")))
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              kind?: string
              source?: string
              sessionID?: string
              first_event_ms?: number
              ttfb_ms?: number
              success?: boolean
            },
        )
        .find(
          (event) =>
            event.sessionID === structuralSessionID &&
            event.kind === "provider_turn" &&
            event.source === "core-session-runner",
        )
      expect(typeof structuralTurn?.first_event_ms).toBe("number")
      expect(structuralTurn?.ttfb_ms).toBeUndefined()
      expect(structuralTurn?.success).toBe(false)
    }),
  )

  it.effect("retries the first provider turn after system context becomes available", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const messageID = SessionMessage.ID.create()
      systemUnavailable = true
      yield* session.prompt({ id: messageID, sessionID, prompt: new Prompt({ text: "First" }), resume: false })
      requests.length = 0

      const exit = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(SystemContext.InitializationBlocked)
      expect(requests).toHaveLength(0)
      expect(yield* SessionInput.hasPending(db, sessionID, "steer")).toBe(true)
      expect(
        yield* db
          .select()
          .from(SessionContextEpochTable)
          .where(eq(SessionContextEpochTable.session_id, sessionID))
          .get(),
      ).toBeUndefined()

      systemUnavailable = false
      yield* session.prompt({ id: messageID, sessionID, prompt: new Prompt({ text: "First" }) })
      yield* (yield* SessionRunCoordinator.Service).awaitIdle(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.messages.map((message) => message.role)).toEqual(["user"])
    }),
  )

  it.effect("interrupts a source Location runner after a Session moves", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First" }), resume: false })
      requests.length = 0
      response = contentStopResponse
      yield* session.resume(sessionID)

      yield* events.publish(SessionEvent.Moved, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        location: Location.Ref.make({ directory: AbsolutePath.make("/moved") }),
      })
      expect(
        yield* db
          .select()
          .from(SessionContextEpochTable)
          .where(eq(SessionContextEpochTable.session_id, sessionID))
          .get(),
      ).toBeUndefined()

      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Second" }), resume: false })
      const exit = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(requests).toHaveLength(1)
      expect(yield* SessionInput.hasPending(db, sessionID, "steer")).toBe(true)
    }),
  )

  it.effect("fails gracefully when a stored context snapshot cannot be decoded", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First" }), resume: false })
      response = contentStopResponse
      yield* session.resume(sessionID)
      yield* db
        .update(SessionContextEpochTable)
        .set({ snapshot: { invalid: { value: "bad" } } })
        .where(eq(SessionContextEpochTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Second" }), resume: false })
      requests.length = 0

      const exit = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(ContextSnapshotDecodeError)
      expect(requests).toHaveLength(0)
    }),
  )

  it.effect("does not create a source Location epoch after a concurrent Session move", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      let moved = false
      systemLoadHook = Effect.suspend(() => {
        if (moved) return Effect.void
        moved = true
        return events
          .publish(SessionEvent.Moved, {
            sessionID,
            timestamp: DateTime.makeUnsafe(1),
            location: Location.Ref.make({ directory: AbsolutePath.make("/moved") }),
          })
          .pipe(Effect.asVoid)
      })
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First" }), resume: false })

      expect(Exit.isFailure(yield* session.resume(sessionID).pipe(Effect.exit))).toBe(true)
      expect(yield* SessionInput.hasPending(db, sessionID, "steer")).toBe(true)
      expect(
        yield* db
          .select()
          .from(SessionContextEpochTable)
          .where(eq(SessionContextEpochTable.session_id, sessionID))
          .get(),
      ).toBeUndefined()
      expect((yield* session.get(sessionID)).location.directory).toBe(AbsolutePath.make("/moved"))
    }),
  )

  it.effect("reuses one durable baseline after the context producer changes", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First" }), resume: false })

      requests.length = 0
      response = contentStopResponse
      yield* session.resume(sessionID)
      systemBaseline = "Changed context"
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        ["Initial context", hostContext],
        ["Initial context", hostContext],
      ])
      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "system"])
      expect(requests[1]?.messages.at(-1)?.content).toEqual([{ type: "text", text: "Changed context" }])
      expect(yield* session.messages({ sessionID })).toHaveLength(5)
      const { db } = yield* Database.Service
      expect(
        yield* db
          .select({ id: EventTable.id })
          .from(EventTable)
          .where(eq(EventTable.type, "session.next.context.updated.1"))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(1)
      yield* replaySessionProjection(sessionID)
      expect(yield* session.messages({ sessionID })).toHaveLength(5)
    }),
  )

  it.effect("includes the effective default agent system before durable context", () =>
    Effect.gen(function* () {
      yield* setup
      const agent = yield* AgentV2.Service
      yield* agent.update((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.system = "Build agent instructions"
          agent.mode = "primary"
        }),
      )
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First" }), resume: false })

      requests.length = 0
      response = fragmentFixture("text", "text-build", ["Done"]).completeEvents
      yield* session.resume(sessionID)

      expect(requests.at(-1)?.system.map((part) => part.text)).toEqual(["Build agent instructions", "Initial context", hostContext])
    }),
  )

  it.effect("applies the effective agent request overrides", () =>
    Effect.gen(function* () {
      yield* setup
      const agent = yield* AgentV2.Service
      yield* agent.update((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.request.headers["x-agent-review"] = "bounded"
          agent.request.body.maxOutputTokens = 4_096
          agent.request.body.reasoningEffort = "high"
          agent.request.body.reviewMode = "focused"
        }),
      )
      currentModel = Model.make({
        id: "fake-model",
        provider: "fake",
        route: OpenAIChat.route.with({ generation: { temperature: 0.25 } }),
      })
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Review this" }), resume: false })

      requests.length = 0
      response = fragmentFixture("text", "text-review-request", ["Done"]).completeEvents
      yield* session.resume(sessionID)

      const request = requests.at(-1)
      expect(request?.generation?.maxTokens).toBe(4_096)
      expect(request?.generation?.temperature).toBe(0.25)
      expect(request?.providerOptions?.openai?.reasoningEffort).toBe("high")
      expect(request?.http?.headers?.["x-agent-review"]).toBe("bounded")
      expect(request?.http?.body?.reviewMode).toBe("focused")
    }),
  )

  it.effect("normalizes OpenRouter agent options for a custom provider ID", () =>
    Effect.gen(function* () {
      yield* setup
      const agent = yield* AgentV2.Service
      yield* agent.update((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.request.body.promptCacheKey = "configured-key"
          agent.request.body.reasoning = { effort: "high" }
          agent.request.body.usage = true
        }),
      )
      currentModel = Model.make({
        id: "openai/gpt-5.6",
        provider: "custom-openrouter",
        route: OpenRouter.route,
      })
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Review this" }), resume: false })

      requests.length = 0
      response = fragmentFixture("text", "text-custom-openrouter-request", ["Done"]).completeEvents
      yield* session.resume(sessionID)

      const request = requests.at(-1)
      expect(request?.generation?.maxTokens).toBe(2_048)
      expect(request?.providerOptions?.openrouter).toEqual({
        promptCacheKey: sessionID,
        reasoning: { effort: "high" },
        usage: true,
      })
      expect(request?.providerOptions?.openai).toBeUndefined()
      expect(request?.http?.body).toEqual({})
    }),
  )

  it.effect("uses the configured default agent system for omitted-agent sessions", () =>
    Effect.gen(function* () {
      yield* setup
      const agent = yield* AgentV2.Service
      yield* agent.update((editor) => {
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.system = "Build agent instructions"
          agent.mode = "primary"
        })
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.system = "Reviewer instructions"
          agent.mode = "primary"
        })
        editor.default(AgentV2.ID.make("reviewer"))
      })
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First" }), resume: false })

      requests.length = 0
      response = fragmentFixture("text", "text-reviewer", ["Done"]).completeEvents
      yield* session.resume(sessionID)

      expect(requests.at(-1)?.system.map((part) => part.text)).toEqual(["Reviewer instructions", "Initial context", hostContext])
      expect((yield* session.messages({ sessionID }))[0]).toMatchObject({ type: "assistant", agent: "reviewer" })
    }),
  )

  it.effect("uses an explicitly selected non-build agent system", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const agent = yield* AgentV2.Service
      yield* agent.update((editor) =>
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.system = "Reviewer instructions"
          agent.mode = "primary"
        }),
      )
      yield* db
        .update(SessionTable)
        .set({ agent: "reviewer" })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First" }), resume: false })

      requests.length = 0
      response = fragmentFixture("text", "text-selected", ["Done"]).completeEvents
      yield* session.resume(sessionID)

      expect(requests.at(-1)?.system.map((part) => part.text)).toEqual(["Reviewer instructions", "Initial context", hostContext])
      expect((yield* session.messages({ sessionID }))[0]).toMatchObject({ type: "assistant", agent: "reviewer" })
    }),
  )

  it.effect("composes selected-agent skill guidance and replaces it after an agent switch", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      skillBaselines.set(AgentV2.ID.make("build"), "Build skills")
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First" }), resume: false })

      requests.length = 0
      response = contentStopResponse
      yield* session.resume(sessionID)
      skillBaselines.set(AgentV2.ID.make("reviewer"), "Reviewer skills")
      yield* events.publish(SessionEvent.AgentSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(1),
        agent: "reviewer",
      })
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        ["Initial context\n\nBuild skills", hostContext],
        ["Initial context\n\nReviewer skills", hostContext],
      ])
    }),
  )

  it.effect("retries first-epoch preparation when the selected agent changes during observation", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      skillBaselines.set(AgentV2.ID.make("build"), "Build skills")
      skillBaselines.set(AgentV2.ID.make("reviewer"), "Reviewer skills")
      let switched = false
      systemLoadHook = Effect.suspend(() => {
        if (switched) return Effect.void
        switched = true
        return events
          .publish(SessionEvent.AgentSwitched, {
            sessionID,
            messageID: SessionMessage.ID.create(),
            timestamp: DateTime.makeUnsafe(1),
            agent: "reviewer",
          })
          .pipe(Effect.asVoid)
      })
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First" }), resume: false })

      requests.length = 0
      response = contentStopResponse
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        ["Initial context\n\nReviewer skills", hostContext],
      ])
    }),
  )

  it.effect("opens a queued activity once when the selected agent changes during observation", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      skillBaselines.set(AgentV2.ID.make("build"), "Build skills")
      skillBaselines.set(AgentV2.ID.make("reviewer"), "Reviewer skills")
      let switched = false
      systemLoadHook = Effect.suspend(() => {
        if (switched) return Effect.void
        switched = true
        return events
          .publish(SessionEvent.AgentSwitched, {
            sessionID,
            messageID: SessionMessage.ID.create(),
            timestamp: DateTime.makeUnsafe(1),
            agent: "reviewer",
          })
          .pipe(Effect.asVoid)
      })
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Queued" }),
        delivery: "queue",
        resume: false,
      })

      requests.length = 0
      response = contentStopResponse
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect((yield* session.context(sessionID)).filter((message) => message.type === "user")).toHaveLength(1)
    }),
  )

  it.effect("retries an agent switch before the final provider-dispatch boundary", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      skillBaselines.set(AgentV2.ID.make("build"), "Build skills")
      skillBaselines.set(AgentV2.ID.make("reviewer"), "Reviewer skills")
      let switched = false
      modelResolveHook = Effect.suspend(() => {
        if (switched) return Effect.void
        switched = true
        return events
          .publish(SessionEvent.AgentSwitched, {
            sessionID,
            messageID: SessionMessage.ID.create(),
            timestamp: DateTime.makeUnsafe(1),
            agent: "reviewer",
          })
          .pipe(Effect.asVoid)
      })
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First" }), resume: false })

      requests.length = 0
      response = contentStopResponse
      yield* session.resume(sessionID)
      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        ["Initial context\n\nReviewer skills", hostContext],
      ])
      expect(
        yield* db
          .select({ replacementSeq: SessionContextEpochTable.replacement_seq })
          .from(SessionContextEpochTable)
          .where(eq(SessionContextEpochTable.session_id, sessionID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ replacementSeq: null })
    }),
  )

  it.effect("retries a model switch before the final provider-dispatch boundary", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      let switched = false
      modelResolveHook = Effect.suspend(() => {
        if (switched) return Effect.void
        switched = true
        return events
          .publish(SessionEvent.ModelSwitched, {
            sessionID,
            messageID: SessionMessage.ID.create(),
            timestamp: DateTime.makeUnsafe(1),
            model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
          })
          .pipe(Effect.asVoid)
      })
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First" }), resume: false })

      requests.length = 0
      response = contentStopResponse
      yield* session.resume(sessionID)
      expect(requests.map((request) => request.model)).toEqual([replacementModel])
      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([["Initial context", hostContext]])
    }),
  )

  it.effect("adopts the model from the first promoted prompt in a migrated session", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      response = fragmentFixture("text", "text-first-migrated-model", ["Ready"]).completeEvents
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "First migrated prompt" }),
        model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
        resume: false,
      })

      requests.length = 0
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.model)).toEqual([replacementModel])
      expect(
        yield* db
          .select({ model: SessionTable.model })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ model: { id: "replacement", providerID: "fake" } })
    }),
  )

  it.live("assembles the first promoted-model turn exactly once", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const perfSessionID = SessionV2.ID.make(`ses_runner_first_model_perf_${Date.now()}`)
      yield* insertSession(perfSessionID)
      let modelResolutions = 0
      let snapshotTrackCount = 0
      modelResolveHook = Effect.sync(() => {
        modelResolutions++
      })
      snapshotTrackHook = Effect.sync(() => {
        snapshotTrackCount++
      })
      snapshotTracks = ["snap-first-model-start"]
      response = fragmentFixture("text", "text-first-model-perf", ["Ready"]).completeEvents
      yield* session.prompt({
        sessionID: perfSessionID,
        prompt: new Prompt({ text: "First migrated prompt" }),
        model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
        resume: false,
      })

      requests.length = 0
      yield* session.resume(perfSessionID)

      const requestAssemblies = (yield* Effect.promise(() =>
        readFile(path.join(Global.Path.log, "perf.jsonl"), "utf8"),
      ))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { kind?: string; sessionID?: string })
        .filter((event) => event.kind === "request_assembly" && event.sessionID === perfSessionID)
      expect(requestAssemblies).toHaveLength(1)
      expect(modelResolutions).toBe(1)
      // A text-only turn needs the speculative start snapshot because mutating tools are
      // available, but it must not pay for an end snapshot when none was called.
      expect(snapshotTrackCount).toBe(1)
      expect(requests.map((request) => request.model)).toEqual([replacementModel])
    }),
  )

  it.effect("assembles the request while the start snapshot is in flight and joins before provider dispatch", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const snapshotStarted = yield* Deferred.make<void>()
      const assemblyAdvanced = yield* Deferred.make<void>()
      const releaseSnapshot = yield* Deferred.make<void>()
      let snapshotTrackCount = 0
      snapshotTrackHook = Effect.gen(function* () {
        snapshotTrackCount++
        if (snapshotTrackCount !== 1) return
        yield* Deferred.succeed(snapshotStarted, undefined)
        yield* Deferred.await(releaseSnapshot)
      })
      modelResolveHook = Deferred.succeed(assemblyAdvanced, undefined)
      snapshotTracks = ["snap-overlap-start"]
      response = fragmentFixture("text", "text-snapshot-overlap", ["Ready"]).completeEvents
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Overlap safe request assembly" }),
        resume: false,
      })

      requests.length = 0
      const running = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Effect.all([Deferred.await(snapshotStarted), Deferred.await(assemblyAdvanced)], {
        discard: true,
        concurrency: 2,
      }).pipe(Effect.timeout("1 second"))

      expect(requests).toHaveLength(0)
      yield* Deferred.succeed(releaseSnapshot, undefined)
      yield* Fiber.join(running)

      expect(requests).toHaveLength(1)
      expect(snapshotTrackCount).toBe(1)
    }),
  )

  it.effect("rebuilds when a steer arrives before provider dispatch", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      let admitted = false
      snapshotTrackHook = Effect.gen(function* () {
        if (admitted) return
        admitted = true
        yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Late steer before stream" }), resume: false })
      }).pipe(Effect.orDie)
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Initial" }), resume: false })

      requests.length = 0
      response = contentStopResponse
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(userTexts(requests[0]!)).toEqual(["Initial", "Late steer before stream"])
    }),
  )

  it.effect("fences an unchanged epoch read across an agent ABA replacement request", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First" }), resume: false })
      response = contentStopResponse
      yield* session.resume(sessionID)
      let switched = false
      systemLoadHook = Effect.suspend(() => {
        if (switched) return Effect.void
        switched = true
        return events
          .publish(SessionEvent.AgentSwitched, {
            sessionID,
            messageID: SessionMessage.ID.create(),
            timestamp: DateTime.makeUnsafe(1),
            agent: AgentV2.ID.make("reviewer"),
          })
          .pipe(
            Effect.andThen(
              events.publish(SessionEvent.AgentSwitched, {
                sessionID,
                messageID: SessionMessage.ID.create(),
                timestamp: DateTime.makeUnsafe(2),
                agent: AgentV2.defaultID,
              }),
            ),
            Effect.asVoid,
          )
      })
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Second" }), resume: false })

      requests.length = 0
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(
        yield* db
          .select({ replacementSeq: SessionContextEpochTable.replacement_seq })
          .from(SessionContextEpochTable)
          .where(eq(SessionContextEpochTable.session_id, sessionID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ replacementSeq: null })
    }),
  )

  it.effect("rejects stale agent guidance when committing an existing-epoch replacement", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First" }), resume: false })
      response = contentStopResponse
      yield* session.resume(sessionID)
      yield* events.publish(SessionEvent.AgentSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(1),
        agent: AgentV2.ID.make("reviewer"),
      })
      const context = (text: string) =>
        Effect.succeed(
          SystemContext.make({
            key: systemContextKey,
            codec: Schema.toCodecJson(Schema.String),
            load: Effect.succeed(text),
            baseline: String,
            update: (_previous, current) => current,
          }),
        )
      const location = (yield* session.get(sessionID)).location

      expect(
        yield* SessionContextEpoch.prepare(
          db,
          events,
          context("Stale build context"),
          sessionID,
          location,
          AgentV2.defaultID,
        ).pipe(Effect.catchDefect(Effect.succeed)),
      ).toBeInstanceOf(SessionContextEpoch.AgentMismatch)

      expect(
        yield* SessionContextEpoch.prepare(
          db,
          events,
          context("Reviewer context"),
          sessionID,
          location,
          AgentV2.ID.make("reviewer"),
        ),
      ).toMatchObject({ baseline: "Reviewer context" })
    }),
  )

  it.effect("reinitializes a switched agent and blocks while its fresh context is unavailable", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      skillBaselines.set(AgentV2.defaultID, "Build skills")
      skillBaselines.set(AgentV2.ID.make("reviewer"), "Reviewer skills")
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First" }), resume: false })
      response = contentStopResponse
      yield* session.resume(sessionID)
      yield* events.publish(SessionEvent.AgentSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(1),
        agent: AgentV2.ID.make("reviewer"),
      })
      systemUnavailable = true
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Second" }), resume: false })

      requests.length = 0
      const blocked = yield* session.resume(sessionID).pipe(Effect.exit)
      expect(Exit.isFailure(blocked)).toBe(true)
      if (Exit.isFailure(blocked))
        expect(Cause.squash(blocked.cause)).toBeInstanceOf(SystemContext.InitializationBlocked)
      expect(requests).toHaveLength(0)

      systemUnavailable = false
      yield* session.resume(sessionID)
      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        ["Initial context\n\nReviewer skills", hostContext],
      ])
    }),
  )

  it.effect("runs imported history under the child agent's own baseline", () =>
    Effect.gen(function* () {
      yield* setup
      yield* insertSession(otherSessionID)
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const session = yield* SessionV2.Service
      yield* db.update(SessionTable).set({ parent_id: otherSessionID, agent: "reviewer" })
        .where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
      skillBaselines.set(AgentV2.ID.make("reviewer"), "Reviewer skills")
      const entries = [
        { type: "user", text: "Earlier user" },
        { type: "system", text: "Earlier update" },
      ] as const
      let throughSeq = -1
      for (const [index, entry] of entries.entries()) {
        const message = Schema.decodeUnknownSync(SessionMessage.Message)({
          ...entry, id: SessionMessage.ID.make(`msg_child_import_${index}`), time: { created: index + 1 },
        })
        const imported = yield* events.publish(SessionForkEvent.MessageImported, {
          sessionID, sourceSessionID: otherSessionID,
          sourceMessageID: SessionMessage.ID.make(`msg_source_import_${index}`),
          timestamp: yield* DateTime.now, message,
        })
        if (imported.seq === undefined) throw new Error("Missing imported sequence")
        throughSeq = imported.seq
      }
      yield* events.publish(SessionForkEvent.HistoryBoundaryImported, {
        sessionID, sourceSessionID: otherSessionID, throughSeq,
      })
      requests.length = 0
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Child assignment" }), resume: false })
      yield* session.resume(sessionID)
      expect(requests).toHaveLength(1)
      expect(requests[0]?.system.map((part) => part.text)).toEqual([
        "Initial context\n\nReviewer skills", SessionHostContext.render({ id: sessionID, parentID: otherSessionID }),
      ])
      expect(requests[0]?.messages.map((message) => message.role)).toEqual(["user", "system", "user"])
      expect(requests[0]?.messages[1]?.content).toEqual([{ type: "text", text: "Earlier update" }])
    }),
  )

  for (const name of ["task", "multi_agent_fanout"]) for (const failed of [false, true])
    it.live(`waits for the provider stream before native dispatch (${name}, failed=${failed})`, () =>
      Effect.gen(function* () {
        yield* setup
        const events = yield* EventV2.Service
        const session = yield* SessionV2.Service
        const observed: string[] = []
        yield* events.listen((event) => Effect.sync(() => {
          if (event.type === SessionEvent.Text.Ended.type) observed.push("text-ended")
        }))
        yield* ToolRegistry.Service.use((registry) => registry.register({
          [name]: Tool.make({
            description: "Probe native dispatch start boundary",
            input: Schema.Struct({}),
            output: Schema.String,
            toModelOutput: ({ output }) => [{ type: "text", text: output }],
            execute: () => Effect.sync(() => {
              observed.push("dispatch")
              return "done"
            }),
          }),
        }))
        yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Delegate after narration settles" }), resume: false })
        responseStream = Stream.make(
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "dispatch-narration" }),
          LLMEvent.textDelta({ id: "dispatch-narration", text: "I will delegate this." }),
          LLMEvent.toolCall({ id: "dispatch-start", name, input: {} }),
        ).pipe(Stream.concat(Stream.unwrap(Effect.sleep("20 millis").pipe(Effect.as(
          failed ? Stream.fail(new LLMError({ module: "test", method: "stream",
            reason: new AuthenticationReason({ message: "Fixture stream refused", kind: "invalid" }) }))
            : Stream.make(
                LLMEvent.textEnd({ id: "dispatch-narration" }),
                LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
                LLMEvent.finish({ reason: "tool-calls" }),
              ),
        )))))
        yield* session.resume(sessionID).pipe(Effect.exit)
        expect(observed.filter((entry) => entry === "dispatch")).toHaveLength(failed ? 0 : 1)
        if (!failed) expect(observed.indexOf("text-ended")).toBeLessThan(observed.indexOf("dispatch"))
      }),
    )

  it.effect("refuses ordinary questions in a native task child when delegation preferences disable them", () =>
    Effect.gen(function* () {
      yield* setup
      yield* insertSession(otherSessionID)
      const { db } = yield* Database.Service
      yield* db.update(SessionTable).set({
        parent_id: otherSessionID,
        agent_policy: {
          tools: { mode: "explicit", entries: { surface: { visible: true, permission: "allow" } } },
          permissionLayers: [],
          source: { type: "task", sessionID: otherSessionID, agent: AgentV2.ID.make("build") },
        },
      }).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
      yield* db.update(SessionTable).set({
        metadata: {
          "opencode.delegation_preferences": {
            version: 1, revision: 1, session: { ordinaryQuestions: false }, tasks: {},
          },
        },
      }).where(eq(SessionTable.id, otherSessionID)).run().pipe(Effect.orDie)
      const executions: string[] = []
      yield* ToolRegistry.Service.use((registry) =>
        registry.register({
          surface: Tool.make({
            description: "Ask the user a blocking question",
            input: SurfaceTool.Input,
            output: SurfaceTool.Output,
            toModelOutput: () => [{ type: "text", text: "question answered" }],
            execute: (input) =>
              Effect.sync(() => {
                executions.push(input.mode)
                return { mode: "blocking" as const, answers: [["yes"]] }
              }),
          }),
        }),
      )
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Decide the banner color" }), resume: false })
      requests.length = 0
      responses = [surfaceQuestionTurn("call-surface-question"), contentStopResponse]
      yield* session.resume(sessionID)
      expect(executions).toEqual([])
      expect(requests).toHaveLength(2)
      expect(JSON.stringify(requests[1])).toContain("Ordinary questions are disabled for this delegated task")
      const messages = yield* db.select({ data: SessionMessageTable.data }).from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID)).all().pipe(Effect.orDie)
      expect(JSON.stringify(messages)).toContain("Ordinary questions are disabled for this delegated task")
      expect(yield* db.select({ id: QuestionTable.id }).from(QuestionTable)
        .where(eq(QuestionTable.session_id, sessionID)).all().pipe(Effect.orDie)).toHaveLength(0)
    }),
  )

  it.effect("keeps ordinary questions reachable without a disabling preference and for non-task children", () =>
    Effect.gen(function* () {
      yield* setup
      yield* insertSession(otherSessionID)
      const { db } = yield* Database.Service
      const executions: string[] = []
      yield* ToolRegistry.Service.use((registry) =>
        registry.register({
          surface: Tool.make({
            description: "Ask the user a blocking question",
            input: SurfaceTool.Input,
            output: SurfaceTool.Output,
            toModelOutput: () => [{ type: "text", text: "question answered" }],
            execute: (input) =>
              Effect.sync(() => {
                executions.push(input.mode)
                return { mode: "blocking" as const, answers: [["yes"]] }
              }),
          }),
        }),
      )
      const session = yield* SessionV2.Service
      const childPolicy = (type: "task" | "spawn_agent") => ({
        tools: { mode: "explicit" as const, entries: { surface: { visible: true, permission: "allow" as const } } },
        permissionLayers: [],
        source: { type, sessionID: otherSessionID, agent: AgentV2.ID.make("build") },
      })
      yield* db.update(SessionTable).set({ parent_id: otherSessionID, agent_policy: childPolicy("task") })
        .where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Decide the banner color" }), resume: false })
      requests.length = 0
      responses = [surfaceQuestionTurn("call-surface-allowed"), contentStopResponse]
      yield* session.resume(sessionID)
      expect(executions).toEqual(["blocking"])
      expect(requests).toHaveLength(2)
      expect(JSON.stringify(requests[1])).not.toContain("Ordinary questions are disabled for this delegated task")
      expect(JSON.stringify(requests[1])).toContain("question answered")

      // The same disabling preference must not mute a non-task child.
      yield* db.update(SessionTable).set({
        metadata: {
          "opencode.delegation_preferences": {
            version: 1, revision: 1, session: { ordinaryQuestions: false }, tasks: {},
          },
        },
      }).where(eq(SessionTable.id, otherSessionID)).run().pipe(Effect.orDie)
      yield* db.update(SessionTable).set({ agent_policy: childPolicy("spawn_agent") })
        .where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
      executions.length = 0
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Decide again" }), resume: false })
      requests.length = 0
      responses = [surfaceQuestionTurn("call-surface-spawn"), contentStopResponse]
      yield* session.resume(sessionID)
      expect(executions).toEqual(["blocking"])
      expect(requests).toHaveLength(2)
      expect(JSON.stringify(requests[1])).not.toContain("Ordinary questions are disabled for this delegated task")
    }),
  )

  it.effect("lets an explicit task preference override the session default for exactly that child", () =>
    Effect.gen(function* () {
      yield* setup
      yield* insertSession(otherSessionID)
      const { db } = yield* Database.Service
      yield* db.update(SessionTable).set({
        parent_id: otherSessionID,
        agent_policy: {
          tools: { mode: "explicit", entries: { surface: { visible: true, permission: "allow" } } },
          permissionLayers: [],
          source: { type: "task", sessionID: otherSessionID, agent: AgentV2.ID.make("build") },
        },
      }).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
      yield* db.update(SessionTable).set({
        metadata: {
          "opencode.delegation_preferences": {
            version: 1, revision: 1, session: { ordinaryQuestions: true },
            tasks: { [sessionID]: { ordinaryQuestions: false } },
          },
        },
      }).where(eq(SessionTable.id, otherSessionID)).run().pipe(Effect.orDie)
      const executions: string[] = []
      yield* ToolRegistry.Service.use((registry) =>
        registry.register({
          surface: Tool.make({
            description: "Ask the user a blocking question",
            input: SurfaceTool.Input,
            output: SurfaceTool.Output,
            toModelOutput: () => [{ type: "text", text: "question answered" }],
            execute: (input) =>
              Effect.sync(() => {
                executions.push(input.mode)
                return { mode: "blocking" as const, answers: [["yes"]] }
              }),
          }),
        }),
      )
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Decide the banner color" }), resume: false })
      requests.length = 0
      responses = [surfaceQuestionTurn("call-surface-task-scope"), contentStopResponse]
      yield* session.resume(sessionID)
      expect(executions).toEqual([])
      expect(requests).toHaveLength(2)
      expect(JSON.stringify(requests[1])).toContain("Ordinary questions are disabled for this delegated task")
    }),
  )

  it.effect("adopts and persists the default agent for a session without a saved selection", () =>
    Effect.gen(function* () {
      yield* setup
      // Mirror production: PluginBoot installs the selectable default agents before
      // the runner resolves a selection for an agent-less session.
      yield* AgentV2.Service.use((agents) =>
        agents.update((editor) =>
          editor.update(AgentV2.ID.make("build"), (agent) => {
            agent.mode = "primary"
          }),
        ),
      )
      const session = yield* SessionV2.Service
      // Scheduled prompts and direct REST sessions arrive without an agent; the
      // runner must persist the executed default selection so crash recovery can
      // verify it instead of pausing on a missing saved selection.
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Run without a saved agent" }), resume: false })
      yield* session.resume(sessionID)
      const { db } = yield* Database.Service
      const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get()
      expect(row?.agent).toBe("build")
      const switched = yield* db.select().from(EventTable).where(and(
        eq(EventTable.aggregate_id, sessionID),
        inArray(EventTable.type, [
          SessionEvent.AgentSwitched.type,
          EventV2.versionedType(SessionEvent.AgentSwitched.type, SessionEvent.AgentSwitched.sync?.version ?? 1),
        ]),
      )).all()
      expect(switched).toHaveLength(1)
      const assistant = yield* db.select().from(SessionMessageTable).where(and(
        eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "assistant"),
      )).orderBy(asc(SessionMessageTable.seq)).get()
      expect(assistant?.type).toBe("assistant")
      expect(assistant && "agent" in assistant.data ? assistant.data.agent : undefined).toBe("build")
      // A follow-up turn reuses the persisted selection instead of re-publishing it.
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Second turn" }), resume: false })
      yield* session.resume(sessionID)
      const switchedAgain = yield* db.select().from(EventTable).where(and(
        eq(EventTable.aggregate_id, sessionID),
        inArray(EventTable.type, [
          SessionEvent.AgentSwitched.type,
          EventV2.versionedType(SessionEvent.AgentSwitched.type, SessionEvent.AgentSwitched.sync?.version ?? 1),
        ]),
      )).all()
      expect(switchedAgain).toHaveLength(1)
    }),
  )

  it.effect("admits removed context as a chronological System message", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First" }), resume: false })

      requests.length = 0
      response = contentStopResponse
      yield* session.resume(sessionID)
      systemRemoved = true
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "system"])
      expect(requests[1]?.messages.at(-1)?.content).toEqual([
        { type: "text", text: "System context source removed: test/context" },
      ])
      expect(yield* session.messages({ sessionID })).toHaveLength(5)
    }),
  )

  it.effect("replaces the baseline lazily after a model switch and drops prior System updates", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First" }), resume: false })

      requests.length = 0
      response = contentStopResponse
      yield* session.resume(sessionID)
      systemBaseline = "Changed context"
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)
      yield* events.publish(SessionEvent.ModelSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(1),
        model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
      })
      systemBaseline = "Replacement context"
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Third" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        ["Initial context", hostContext],
        ["Initial context", hostContext],
        ["Replacement context", hostContext],
      ])
      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "system"])
      expect(requests[2]?.messages.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
        "user",
      ])
      expect((yield* session.context(sessionID)).map((message) => message.type)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
        "model-switched",
        "user",
        "assistant",
      ])
      yield* replaySessionProjection(sessionID)
      expect(yield* session.messages({ sessionID })).toHaveLength(8)
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Fourth" }), resume: false })
      yield* session.resume(sessionID)
    }),
  )

  it.effect("defers replacement while admitted context is temporarily unavailable", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First" }), resume: false })

      requests.length = 0
      response = contentStopResponse
      yield* session.resume(sessionID)
      yield* events.publish(SessionEvent.ModelSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(1),
        model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
      })
      systemUnavailable = true
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)
      systemUnavailable = false
      systemBaseline = "Replacement context"
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Third" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        ["Initial context", hostContext],
        ["Initial context", hostContext],
        ["Replacement context", hostContext],
      ])
    }),
  )

  it.effect("advances a pending replacement to the latest invalidation boundary", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First" }), resume: false })
      response = contentStopResponse
      yield* session.resume(sessionID)

      yield* events.publish(SessionEvent.ModelSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(1),
        model: { id: ModelV2.ID.make("replacement-1"), providerID: ProviderV2.ID.make("fake") },
      })
      yield* events.publish(SessionEvent.ModelSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(2),
        model: { id: ModelV2.ID.make("replacement-2"), providerID: ProviderV2.ID.make("fake") },
      })
      const latest = yield* SessionInput.latestSeq(db, sessionID)

      expect(
        yield* db
          .select({ replacementSeq: SessionContextEpochTable.replacement_seq })
          .from(SessionContextEpochTable)
          .where(eq(SessionContextEpochTable.session_id, sessionID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ replacementSeq: latest })
    }),
  )

  it.effect("retries epoch preparation until observation-time invalidations settle", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First" }), resume: false })
      response = contentStopResponse
      yield* session.resume(sessionID)

      requests.length = 0
      systemBaseline = "Changed context"
      let invalidations = 0
      systemLoadHook = Effect.suspend(() => {
        if (invalidations === 4) return Effect.void
        invalidations++
        return events
          .publish(SessionEvent.ModelSwitched, {
            sessionID,
            messageID: SessionMessage.ID.create(),
            timestamp: DateTime.makeUnsafe(invalidations),
            model: { id: ModelV2.ID.make(`replacement-${invalidations}`), providerID: ProviderV2.ID.make("fake") },
          })
          .pipe(Effect.asVoid)
      })
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Second" }), resume: false })

      yield* session.resume(sessionID)

      expect(invalidations).toBe(4)
      expect(requests).toHaveLength(1)
      expect(requests[0]?.system.map((part) => part.text)).toEqual(["Changed context", hostContext])
    }),
  )

  it.effect("replays retained context projections while replacement is pending", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First" }), resume: false })

      requests.length = 0
      response = contentStopResponse
      yield* session.resume(sessionID)
      systemBaseline = "Changed context"
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)
      yield* events.publish(SessionEvent.ModelSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(1),
        model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
      })

      yield* replaySessionProjection(sessionID)
      systemBaseline = "Replacement context"
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Third" }), resume: false })
      yield* session.resume(sessionID)
      expect(requests.at(-1)?.system.map((part) => part.text)).toEqual(["Replacement context", hostContext])
    }),
  )

  it.effect("replaces the baseline lazily after completed compaction without reopening replacement on replay", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First" }), resume: false })

      requests.length = 0
      response = contentStopResponse
      yield* session.resume(sessionID)
      const compactionID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(1),
        reason: "manual",
      })
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(2),
        reason: "manual",
        text: "summary",
        recent: "",
      })
      systemBaseline = "Replacement context"
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        ["Initial context", hostContext],
        ["Replacement context", hostContext],
      ])
      yield* replaySessionProjection(sessionID)
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Third" }), resume: false })
      yield* session.resume(sessionID)
    }),
  )

  it.effect("does not preflight compact storage-only tool copies before replaying history", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      currentModel = Model.make({
        id: "history-budget",
        provider: "fake",
        route: OpenAIChat.route.with({ limits: { context: 1_000_000 } }),
      })
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Continue the original task" }), resume: false })
      yield* SessionInput.promoteSteers((yield* Database.Service).db, events, sessionID, Number.MAX_SAFE_INTEGER)
      const assistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        timestamp: yield* DateTime.now,
        agent: "build",
        model: { id: ModelV2.ID.make(currentModel.id), providerID: ProviderV2.ID.make("fake") },
      })
      yield* events.publish(SessionEvent.Tool.Input.Started, {
        sessionID,
        assistantMessageID,
        timestamp: yield* DateTime.now,
        callID: "call-history",
        name: "echo",
      })
      yield* events.publish(SessionEvent.Tool.Input.Ended, {
        sessionID,
        assistantMessageID,
        timestamp: yield* DateTime.now,
        callID: "call-history",
        text: "{}",
      })
      yield* events.publish(SessionEvent.Tool.Called, {
        sessionID,
        assistantMessageID,
        timestamp: yield* DateTime.now,
        callID: "call-history",
        tool: "echo",
        input: {},
        provider: { executed: false },
      })
      yield* events.publish(SessionEvent.Tool.Success, {
        sessionID,
        assistantMessageID,
        timestamp: yield* DateTime.now,
        callID: "call-history",
        structured: { content: "storage-only duplicate ".repeat(60_000) },
        content: [{ type: "text", text: "actual tool output ".repeat(5_000) }],
        provider: { executed: false },
      })
      requests.length = 0
      response = contentStopResponse
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(userTexts(requests[0])[0]).toBe("Continue the original task")
      expect(JSON.stringify(requests[0].messages)).toContain("actual tool output")
      expect(JSON.stringify(requests[0].messages)).not.toContain("storage-only duplicate")
      expect((yield* session.context(sessionID)).some((message) => message.type === "compaction")).toBe(false)

      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Continue the next step" }), resume: false })
      yield* session.resume(sessionID)
      expect(requests).toHaveLength(2)
      expect(userTexts(requests[1])).toEqual(["Continue the original task", "Continue the next step"])
      expect((yield* session.context(sessionID)).some((message) => message.type === "compaction")).toBe(false)
    }),
  )

  it.effect("automatically compacts into a completed summary and retained recent turn", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      response = fragmentFixture("text", "text-first", ["Earlier answer"]).completeEvents
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Earlier question ".repeat(700) }),
        resume: false,
      })
      yield* session.resume(sessionID)

      currentModel = compactModel
      requests.length = 0
      responses = [
        fragmentFixture("text", "text-summary", ["## Goal\n- Preserve the task"]).completeEvents,
        fragmentFixture("text", "text-final", ["Continued"]).completeEvents,
      ]
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Recent exact request ".repeat(180) }),
        resume: false,
      })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0])[0]).toContain("## Goal")
      expect(userTexts(requests[1])).toHaveLength(1)
      expect(userTexts(requests[1])[0]).toContain("<summary>\n## Goal\n- Preserve the task\n</summary>")
      expect(userTexts(requests[1])[0]).toContain("Recent exact request ".repeat(180))

      const context = yield* (yield* SessionStore.Service).context(sessionID)
      expect(context.map((message) => message.type)).toEqual(["compaction", "assistant"])
      expect(context[0]).toMatchObject({
        type: "compaction",
        summary: "## Goal\n- Preserve the task",
        recent: expect.stringContaining("Recent exact request ".repeat(180)),
      })

      requests.length = 0
      responses = [
        fragmentFixture("text", "text-summary-2", ["## Goal\n- Preserve the updated task"]).completeEvents,
        fragmentFixture("text", "text-final-2", ["Continued again"]).completeEvents,
      ]
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Newest exact request ".repeat(700) }),
        resume: false,
      })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0])[0]).toContain(
        "<previous-summary>\n## Goal\n- Preserve the task\n</previous-summary>",
      )
      expect(userTexts(requests[0])[0]).toContain("Newest exact request")
      expect((yield* (yield* SessionStore.Service).context(sessionID))[0]).toMatchObject({
        type: "compaction",
        summary: "## Goal\n- Preserve the updated task",
      })
    }),
  )

  it.effect("teaches bounded tool output in the system prompt on limited-context models", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      currentModel = pressureModel
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Look around" }), resume: false })
      yield* session.resume(sessionID)

      const system = requests
        .at(-1)!
        .system.map((part) => part.text)
        .join("\n")
      expect(system).toContain(SessionRunnerLLM.TOOL_OUTPUT_CONTEXT_GUIDANCE)
      expect(system).not.toContain("Context pressure:")
    }),
  )

  it.effect("warns about context pressure before auto compaction is required", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      currentModel = pressureModel
      response = fragmentFixture("text", "text-pressure-earlier", ["Earlier answer"]).completeEvents
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Start with a short answer" }),
        resume: false,
      })
      yield* session.resume(sessionID)

      expect(
        requests
          .at(-1)!
          .system.map((part) => part.text)
          .join("\n"),
      ).not.toContain("Context pressure:")
      requests.length = 0
      response = contentStopResponse
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Context filler ".repeat(7_500) }),
        resume: false,
      })
      yield* session.resume(sessionID)

      const pressuredSystem = requests.at(-1)!.system
      const system = pressuredSystem.map((part) => part.text).join("\n")
      expect(system).toContain(SessionRunnerLLM.TOOL_OUTPUT_CONTEXT_GUIDANCE)
      expect(system).toContain("Context pressure:")
      expect(system).toContain("100,000")
      requests.length = 0
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "More context ".repeat(1_000) }),
        resume: false,
      })
      yield* session.resume(sessionID)
      expect(requests.at(-1)!.system).toEqual(pressuredSystem)
      expect((yield* session.context(sessionID)).some((message) => message.type === "compaction")).toBe(false)
    }),
  )

  it.effect("promotes direct steers into the first request after automatic compaction", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      response = fragmentFixture("text", "text-first", ["Earlier answer"]).completeEvents
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Earlier question ".repeat(700) }),
        resume: false,
      })
      yield* session.resume(sessionID)

      currentModel = compactModel
      requests.length = 0
      responses = [
        fragmentFixture("text", "text-summary", ["## Goal\n- Preserve the task"]).completeEvents,
        fragmentFixture("text", "text-final", ["Continued"]).completeEvents,
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Recent exact request ".repeat(180) }),
        resume: false,
      })
      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      streamStarted = undefined

      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Steer correction one" }), resume: false })
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Steer correction two" }), resume: false })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(run)
      streamGate = undefined

      expect(requests).toHaveLength(2)
      const final = requests[1]!
      expect(final.messages.map((message) => message.role)).toEqual(["user", "system", "user", "user"])
      expect(final.messages[1]?.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("current, binding steering or correction"),
      })
      expect(userTexts(final)).toEqual([
        expect.stringContaining("Recent exact request ".repeat(180)),
        "Steer correction one",
        "Steer correction two",
      ])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "compaction", recent: expect.stringContaining("Recent exact request ".repeat(180)) },
        { type: "user", text: "Steer correction one" },
        { type: "user", text: "Steer correction two" },
        { type: "assistant", finish: "stop" },
      ])
    }),
  )

  for (const interruption of [false, true]) {
    it.effect(
      `review regression: overflow hint cannot override ${interruption ? "stream interruption" : "raw authentication failure"}`,
      () =>
        Effect.gen(function* () {
          const session = yield* setupOverflowRecovery
          responseStream = Stream.concat(
            Stream.succeed(
              LLMEvent.providerError({ message: "context_length_exceeded", classification: "context-overflow" }),
            ),
            interruption
              ? Stream.fromEffect(Effect.interrupt)
              : Stream.fail(
                  new LLMError({
                    module: "fixture",
                    method: "stream",
                    reason: new AuthenticationReason({ message: "raw authentication rejection", kind: "invalid" }),
                  }),
                ),
          )
          responses = [
            fragmentFixture("text", "summary-forbidden", ["Usable summary"]).completeEvents,
            contentStopResponse,
          ]
          yield* session.prompt({
            sessionID,
            prompt: new Prompt({ text: "Preserve failure authority" }),
            resume: false,
          })
          const exit = yield* session.resume(sessionID).pipe(Effect.exit)
          expect(exit._tag).toBe("Failure")
          if (exit._tag === "Failure") {
            if (interruption) expect(Cause.hasInterrupts(exit.cause)).toBe(true)
            if (!interruption) expect(Cause.pretty(exit.cause)).toContain("raw authentication rejection")
          }
          expect(requests).toHaveLength(1)
        }),
    )
  }

  it.effect("records a context overflow instead of recompacting an unfit finite-model request", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      currentModel = Model.make({ id: "finite", provider: "fake",
        route: OpenAIChat.route.with({ limits: { context: 1_000, output: 100 } }) })
      requests.length = 0
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Preserve oversized work ".repeat(2_000) }), resume: false })
      const exit = yield* session.resume(sessionID).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.pretty(exit.cause)).not.toContain("Post-compaction provider attempt cannot recover another overflow")
      expect(requests).toHaveLength(0)
      const context = yield* session.context(sessionID)
      expect(context.find((entry) => entry.type === "assistant")).toMatchObject({
        finish: "error", failure: { code: "provider.context-overflow" },
      })
      expect(context.some((entry) => entry.type === "user" && entry.text.includes("Preserve oversized work"))).toBe(true)
    }),
  )

  it.effect("forces one compaction and retries after provider context overflow", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
        ],
        fragmentFixture("text", "text-summary", ["## Goal\n- Recover overflow"]).completeEvents,
        fragmentFixture("text", "text-final", ["Recovered"]).completeEvents,
      ]
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Continue" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(3)
      expect(userTexts(requests[1])[0]).toContain("## Goal")
      expect(userTexts(requests[2])[0]).toContain("<summary>\n## Goal\n- Recover overflow\n</summary>")
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "compaction", summary: "## Goal\n- Recover overflow", recent: expect.stringContaining("Continue") },
        { type: "assistant", finish: "stop" },
      ])
      yield* replaySessionProjection(sessionID)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "compaction", recent: expect.stringContaining("Continue") },
        { type: "assistant", finish: "stop" },
      ])
    }),
  )

  it.effect("asks before using a larger-context summarizer and keeps the selected target model", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      const target = ModelV2.Ref.make({ id: ModelV2.ID.make("small-target"), providerID: ProviderV2.ID.make("fake") })
      currentModel = smallTargetModel
      compactionFallbackCatalog = [compactionFallbackInfo("larger-summary", 120_000)]
      yield* session.switchModel({ sessionID, model: target })
      expect(requests).toHaveLength(0)
      requests.length = 0
      responses = [
        [LLMEvent.providerError({ message: "summary context exceeded", classification: "context-overflow" })],
        fragmentFixture("text", "text-fallback-summary", ["## Goal\n- Summarized with a larger context"]).completeEvents,
        fragmentFixture("text", "text-target-final", ["Continued with the selected model"]).completeEvents,
      ]
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Context detail ".repeat(16_000) }), resume: false })
      yield* addActiveQuestionActivity("activity_compaction_fallback_approval")
      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      const question = yield* waitForCompactionQuestion(sessionID)

      expect(question).toBeDefined()
      if (!question) return
      expect(question.mode).toBe("blocking")
      if (question.mode !== "blocking") return
      expect(question.questions[0]).toMatchObject({
        type: "confirm",
        header: "Context summary",
        question: expect.stringContaining("larger-summary"),
        body: [
          expect.objectContaining({
            type: "markdown",
            content: expect.stringContaining("does not change the Session's selected model"),
          }),
        ],
      })
      expect(requests.map((request) => String(request.model.id))).toEqual(["small-target"])
      yield* QuestionV2.Service.use((questions) =>
        questions.reply({ sessionID, requestID: question.id, answers: [["Yes"]] }),
      )
      yield* Fiber.join(run)

      expect(requests.map((request) => String(request.model.id))).toEqual([
        "small-target",
        "larger-summary",
        "small-target",
      ])
      expect(yield* session.get(sessionID)).toMatchObject({ model: target })
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "compaction", summary: "## Goal\n- Summarized with a larger context" },
        { type: "assistant", finish: "stop" },
      ])
    }),
  )

  it.effect("precompacts before switching and asks detached approval if the target cannot summarize", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const original = ModelV2.Ref.make({ id: ModelV2.ID.make("fake-model"), providerID: ProviderV2.ID.make("fake") })
      yield* session.switchModel({ sessionID, model: original })
      yield* addActiveQuestionActivity("activity_compaction_switch_approval")
      responses = [contentStopResponse]
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Older context ".repeat(18_000) }), resume: false })
      yield* session.resume(sessionID)
      const { db } = yield* Database.Service
      yield* db
        .update(SessionActivityTable)
        .set({ status: "completed" })
        .where(eq(SessionActivityTable.id, "activity_compaction_switch_approval"))
        .run()
        .pipe(Effect.orDie)

      const target = ModelV2.Ref.make({ id: ModelV2.ID.make("small-target"), providerID: ProviderV2.ID.make("fake") })
      currentModel = smallTargetModel
      compactionFallbackCatalog = [compactionFallbackInfo("larger-summary", 120_000)]
      requests.length = 0
      responses = [
        [LLMEvent.providerError({ message: "summary context exceeded", classification: "context-overflow" })],
        fragmentFixture("text", "text-switch-fallback-summary", ["## Goal\n- Prepared for the selected model"]).completeEvents,
      ]
      const runner = yield* SessionRunner.Service
      expect(yield* runner.requiresModelSwitchCompaction({ sessionID, model: target })).toBe(true)
      const switching = yield* session.switchModel({ sessionID, model: target }).pipe(Effect.forkChild)
      const question = yield* waitForCompactionQuestion(sessionID)

      expect(question).toBeDefined()
      if (!question) return
      expect(yield* QuestionV2.Service.use((questions) => questions.settlementTarget(question.id, sessionID))).toEqual({
        detached: true,
      })
      expect(yield* session.get(sessionID)).toMatchObject({ model: original })
      yield* QuestionV2.Service.use((questions) =>
        questions.reply({ sessionID, requestID: question.id, answers: [["Yes"]] }),
      )
      yield* Fiber.join(switching)

      expect(requests.map((request) => String(request.model.id))).toEqual(["small-target", "larger-summary"])
      expect(yield* session.get(sessionID)).toMatchObject({ model: target })
      expect((yield* session.context(sessionID)).some((message) => message.type === "compaction")).toBe(true)
    }),
  )

  it.effect("keeps the target model and reports overflow when no larger text model is available", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      const target = ModelV2.Ref.make({ id: ModelV2.ID.make("small-target"), providerID: ProviderV2.ID.make("fake") })
      currentModel = smallTargetModel
      compactionFallbackCatalog = [
        compactionFallbackInfo("same-context", 50_000),
        new ModelV2.Info({
          ...compactionFallbackInfo("image-only", 120_000),
          capabilities: { tools: false, input: ["image/*"], output: ["text"] },
        }),
      ]
      yield* session.switchModel({ sessionID, model: target })
      requests.length = 0
      responses = [[LLMEvent.providerError({ message: "summary context exceeded", classification: "context-overflow" })]]
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Context detail ".repeat(16_000) }), resume: false })

      expect(yield* session.resume(sessionID).pipe(Effect.exit)).toMatchObject({ _tag: "Failure" })
      expect(requests.length).toBeGreaterThan(0)
      expect(requests.every((request) => request.model.id === "small-target")).toBe(true)
      expect((yield* session.context(sessionID)).some((message) => message.type === "compaction")).toBe(false)
      expect(yield* session.get(sessionID)).toMatchObject({ model: target })
      expect(
        (yield* QuestionV2.Service.use((questions) => questions.list())).some(
          (request) => request.mode === "blocking" && request.questions.some((question) => question.header === "Context summary"),
        ),
      ).toBe(false)
    }),
  )

  it.effect("preserves the selected target when the user declines a larger-context summarizer", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      const target = ModelV2.Ref.make({ id: ModelV2.ID.make("small-target"), providerID: ProviderV2.ID.make("fake") })
      currentModel = smallTargetModel
      compactionFallbackCatalog = [compactionFallbackInfo("larger-summary", 120_000)]
      yield* session.switchModel({ sessionID, model: target })
      requests.length = 0
      responses = [[LLMEvent.providerError({ message: "summary context exceeded", classification: "context-overflow" })]]
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Context detail ".repeat(16_000) }), resume: false })
      yield* addActiveQuestionActivity("activity_compaction_fallback_decline")
      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      const question = yield* waitForCompactionQuestion(sessionID)

      expect(question).toBeDefined()
      if (!question) return
      yield* QuestionV2.Service.use((questions) =>
        questions.reply({ sessionID, requestID: question.id, answers: [["No"]] }),
      )
      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })

      expect(requests.length).toBeGreaterThan(0)
      expect(requests.every((request) => request.model.id === "small-target")).toBe(true)
      expect(yield* session.get(sessionID)).toMatchObject({ model: target })
      expect((yield* session.context(sessionID)).some((message) => message.type === "compaction")).toBe(false)
    }),
  )

  it.effect("preflights oversized history when automatic compaction is disabled", () =>
    Effect.gen(function* () {
      yield* setup
      requests.length = 0
      compactionAuto = false
      const session = yield* SessionV2.Service
      response = fragmentFixture("text", "text-earlier", ["Earlier answer"]).completeEvents
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Earlier question ".repeat(700) }),
        resume: false,
      })
      yield* session.resume(sessionID)
      response = fragmentFixture("text", "text-more", ["More earlier answer"]).completeEvents
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Additional earlier context ".repeat(1_000) }),
        resume: false,
      })
      yield* session.resume(sessionID)
      currentModel = Model.make({
        id: "preflight",
        provider: "fake",
        route: OpenAIChat.route.with({ limits: { context: 6_000, output: 100 } }),
      })
      requests.length = 0
      responses = [
        fragmentFixture("text", "text-summary", ["## Goal\n- Preserve the task"]).completeEvents,
        fragmentFixture("text", "text-final", ["Recovered before provider request"]).completeEvents,
      ]
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Continue" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0])[0]).toContain("Create a new anchored summary")
      expect(userTexts(requests[1])[0]).toContain("<conversation-checkpoint>")
      expect(userTexts(requests[1])[0]).toContain("Goal, In Progress, and Next Steps remain binding")
      expect(userTexts(requests[1])[0]).toContain("continue the active task automatically")
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "compaction", recent: expect.stringContaining("Continue") },
        { type: "assistant", finish: "stop" },
      ])
    }),
  )

  it.effect("does not send a request that still exceeds the context limit", () =>
    Effect.gen(function* () {
      yield* setup
      requests.length = 0
      compactionAuto = false
      currentModel = Model.make({
        id: "preflight-impossible",
        provider: "fake",
        route: OpenAIChat.route.with({ limits: { context: 128, output: 64 } }),
      })
      systemBaseline = "x".repeat(28_000)
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Continue" }), resume: false })
      expect(yield* session.resume(sessionID).pipe(Effect.exit)).toMatchObject({ _tag: "Failure" })

      expect(requests).toHaveLength(0)
      expect((yield* session.context(sessionID)).slice(-2)).toMatchObject([
        { type: "user", text: "Continue" },
        {
          type: "assistant",
          finish: "error",
          // The local block names the model it was computed for and is not a provider answer.
          error: {
            message: expect.stringMatching(/^Request was not sent to fake\/preflight-impossible: .*local pre-send block, not a provider error/),
          },
        },
      ])
    }),
  )

  it.effect("persists a second context overflow after one recovery", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      const overflow = () => [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
      ]
      responses = [
        overflow(),
        fragmentFixture("text", "text-summary", ["## Goal\n- Recover once"]).completeEvents,
        overflow(),
      ]
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Continue" }), resume: false })
      expect(yield* session.resume(sessionID).pipe(Effect.exit)).toMatchObject({ _tag: "Failure" })

      expect(requests).toHaveLength(3)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "compaction", recent: expect.stringContaining("Continue") },
        { type: "assistant", finish: "error", error: { message: "prompt too long" } },
      ])
    }),
  )

  it.effect("recovers once from a raw context overflow failure", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      responseStream = Stream.fail(
        new LLMError({
          module: "test",
          method: "stream",
          reason: new InvalidRequestReason({
            message: "prompt too long",
            classification: "context-overflow",
          }),
        }),
      )
      responses = [
        fragmentFixture("text", "text-summary", ["## Goal\n- Recover raw overflow"]).completeEvents,
        fragmentFixture("text", "text-final", ["Recovered"]).completeEvents,
      ]
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Continue" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(3)
      expect(yield* session.context(sessionID)).toMatchObject([
        {
          type: "compaction",
          summary: "## Goal\n- Recover raw overflow",
          recent: expect.stringContaining("Continue"),
        },
        { type: "assistant", finish: "stop" },
      ])
    }),
  )

  it.effect("publishes the original overflow when recovery summarization fails", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      responses = [
        [LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" })],
        [LLMEvent.providerError({ message: "summary unavailable" })],
      ]
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Continue" }), resume: false })
      expect(yield* session.resume(sessionID).pipe(Effect.exit)).toMatchObject({ _tag: "Failure" })

      expect(requests).toHaveLength(2)
      const context = yield* session.context(sessionID)
      expect(context.some((message) => message.type === "compaction")).toBe(false)
      expect(context.slice(-2)).toMatchObject([
        { type: "user", text: "Continue" },
        { type: "assistant", finish: "error", error: { message: "prompt too long" } },
      ])
    }),
  )

  it.effect("interrupts overflow recovery while the summary provider is running", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      responses = [
        [LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" })],
        fragmentFixture("text", "text-summary", ["## Goal\n- Interrupted"]).completeEvents,
      ]
      const firstGate = yield* Deferred.make<void>()
      const summaryGate = yield* Deferred.make<void>()
      streamGate = firstGate
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Continue" }), resume: false })
      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 1) yield* Effect.yieldNow
      streamGate = summaryGate
      yield* Deferred.succeed(firstGate, undefined)
      while (requests.length < 2) yield* Effect.yieldNow

      yield* session.interrupt(sessionID)
      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      streamGate = undefined
      expect(requests).toHaveLength(2)
      expect((yield* session.context(sessionID)).some((message) => message.type === "compaction")).toBe(false)
    }),
  )

  it.effect("preserves effective System updates while compaction replacement is blocked", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First" }), resume: false })

      requests.length = 0
      response = contentStopResponse
      yield* session.resume(sessionID)
      systemBaseline = "Changed context"
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)
      const compactionID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(1),
        reason: "manual",
      })
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(2),
        reason: "manual",
        text: "summary",
        recent: "",
      })
      systemUnavailable = true
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Third" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests.at(-1)?.system.map((part) => part.text)).toEqual(["Initial context", hostContext])
      expect(
        requests
          .at(-1)
          ?.messages.some(
            (message) =>
              message.role === "system" &&
              message.content[0]?.type === "text" &&
              message.content[0].text === "Changed context",
          ),
      ).toBe(true)
    }),
  )

  it.effect("projects reasoning and tool events without executing or continuing tools", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Use tools" }), resume: false })

      requests.length = 0
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id: "reasoning-1" }),
        LLMEvent.reasoningDelta({ id: "reasoning-1", text: "Think" }),
        LLMEvent.reasoningEnd({ id: "reasoning-1" }),
        LLMEvent.toolInputStart({ id: "call-error", name: "write" }),
        LLMEvent.toolInputDelta({ id: "call-error", name: "write", text: '{"path":"README.md"}' }),
        LLMEvent.toolInputEnd({ id: "call-error", name: "write" }),
        LLMEvent.toolCall({ id: "call-error", name: "write", input: { path: "README.md" }, providerExecuted: true }),
        LLMEvent.toolError({ id: "call-error", name: "write", message: "Denied" }),
        LLMEvent.toolResult({ id: "call-error", name: "write", result: { type: "error", value: "Denied" } }),
        LLMEvent.toolCall({
          id: "call-provider",
          name: "web_search",
          input: { query: "hello" },
          providerExecuted: true,
          providerMetadata: { fake: { source: "provider" } },
        }),
        LLMEvent.toolResult({
          id: "call-provider",
          name: "web_search",
          result: {
            type: "content",
            value: [
              { type: "text", text: "Hello" },
              { type: "file", uri: "data:image/png;base64,aGVsbG8=", mime: "image/png", name: "hello.png" },
            ],
          },
          output: {
            structured: { source: "hosted-media" },
            content: [{ type: "text", text: "Hosted media result" }],
          },
          providerExecuted: true,
          providerMetadata: { fake: { source: "provider" } },
        }),
        LLMEvent.stepFinish({
          index: 0,
          reason: "tool-calls",
          usage: {
            inputTokens: 10,
            nonCachedInputTokens: 8,
            outputTokens: 4,
            reasoningTokens: 1,
            cacheReadInputTokens: 2,
          },
        }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.tools.map((tool) => tool.name)).toEqual(["echo", "defect", "failure"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Use tools" },
        {
          type: "assistant",
          finish: "tool-calls",
          tokens: { input: 8, output: 3, reasoning: 1, cache: { read: 2, write: 0 } },
          content: [
            { type: "reasoning", id: "reasoning-1", text: "Think" },
            {
              type: "tool",
              id: "call-error",
              name: "write",
              state: {
                status: "error",
                input: { path: "README.md" },
                error: { type: "unknown", message: "Denied" },
              },
            },
            {
              type: "tool",
              id: "call-provider",
              name: "web_search",
              provider: { executed: true, metadata: { fake: { source: "provider" } } },
              state: {
                status: "completed",
                input: { query: "hello" },
                structured: { source: "hosted-media" },
                content: [{ type: "text", text: "Hosted media result" }],
                result: {
                  type: "content",
                  value: [
                    { type: "text", text: "Hello" },
                    {
                      type: "file",
                      mime: "image/png",
                      uri: expect.stringMatching(/^attachment:\/\//),
                      name: "hello.png",
                    },
                  ],
                },
              },
            },
          ],
        },
      ])
    }),
  )

  it.effect("continues with reloaded history after durably settling one local tool call", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Echo this" }), resume: false })

      requests.length = 0
      authorizations.length = 0
      executions.length = 0
      streamGate = undefined
      streamStarted = undefined
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-echo",
            name: "echo",
            input: { text: "hello" },
            providerMetadata: { openai: { itemId: "call-echo-provider-item" } },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-final" }),
          LLMEvent.textDelta({ id: "text-final", text: "Done" }),
          LLMEvent.textEnd({ id: "text-final" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
      expect(authorizations).toMatchObject([{ sessionID, toolCallID: "call-echo" }])
      expect(executions).toEqual(["hello"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Echo this" },
        {
          type: "assistant",
          finish: "tool-calls",
          content: [
            {
              type: "tool",
              id: "call-echo",
              name: "echo",
              provider: {
                executed: false,
                metadata: { openai: { itemId: "call-echo-provider-item" } },
              },
              state: {
                status: "completed",
                input: { text: "hello" },
                structured: { text: "hello" },
                content: [{ type: "text", text: "hello" }],
                outputPaths: [],
              },
            },
          ],
        },
        { type: "assistant", finish: "stop", content: [{ type: "text", id: "text-final", text: "Done" }] },
      ])
    }),
  )

  it.effect("enforces the stricter configured agent budget while synthesis continues", () =>
    Effect.gen(function* () {
      yield* setup
      const agents = yield* AgentV2.Service
      yield* agents.update((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.toolBudget = { read: 1 }
        }),
      )
      const { db } = yield* Database.Service
      const registry = yield* ToolRegistry.Service
      yield* registry.register({
        read: Tool.make({
          description: "Read a test file",
          input: Schema.Struct({ path: Schema.String }),
          output: Schema.Struct({ text: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
          execute: ({ path }) => Effect.succeed({ text: `contents:${path}` }),
        }),
      })
      yield* db
        .update(SessionTable)
        .set({ metadata: { tool_budget: { read: 2 } } })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)

      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Inspect and summarize" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-read-allowed", name: "read", input: { path: "first.ts" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-read-rejected", name: "read", input: { path: "second.ts" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-budget-summary" }),
          LLMEvent.textDelta({ id: "text-budget-summary", text: "Summary from gathered evidence" }),
          LLMEvent.textEnd({ id: "text-budget-summary" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(3)
      expect(requests[2]?.tools).toEqual([])
      expect(requests[2]?.system.map((part) => part.text).join("\n")).toContain(
        "investigation tool budget has been exhausted",
      )
      expect(requests[2]?.messages.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "tool",
        "assistant",
        "tool",
      ])
      const context = yield* session.context(sessionID)
      // The first turn of an agent-less session persists its adopted default
      // selection, mirroring the durable model-switched message.
      expect(context).toMatchObject([
        { type: "agent-switched", agent: "build" },
        { type: "user", text: "Inspect and summarize" },
        {
          type: "assistant",
          finish: "tool-calls",
          content: [
            {
              type: "tool",
              id: "call-read-allowed",
              state: { status: "completed", content: [{ type: "text", text: "contents:first.ts" }] },
            },
          ],
        },
        {
          type: "assistant",
          finish: "tool-calls",
          content: [
            {
              type: "tool",
              id: "call-read-rejected",
              state: {
                status: "error",
                error: {
                  type: "unknown",
                  message: expect.stringContaining("Read-tool budget exceeded"),
                },
              },
            },
          ],
        },
        {
          type: "assistant",
          finish: "stop",
          content: [{ type: "text", id: "text-budget-summary", text: "Summary from gathered evidence" }],
        },
      ])
    }),
  )

  it.effect("adopts a model selected after the run starts at the next tool continuation boundary", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Echo this" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-echo", name: "echo", input: { text: "hello" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-auto-stop" }),
          LLMEvent.textDelta({ id: "text-auto-stop", text: "Done" }),
          LLMEvent.textEnd({ id: "text-auto-stop" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      toolExecutionGate = yield* Deferred.make<void>()
      toolExecutionsStarted = yield* Deferred.make<void>()
      toolExecutionsReady = 1
      const run = yield* Effect.forkChild(session.resume(sessionID))
      yield* Deferred.await(toolExecutionsStarted)
      yield* events.publish(SessionEvent.ModelSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(1),
        model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
      })
      systemBaseline = "Replacement context"
      yield* Deferred.succeed(toolExecutionGate, undefined)
      yield* Fiber.join(run)

      expect(requests.map((request) => request.model)).toEqual([model, replacementModel])
      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        ["Initial context", hostContext],
        ["Replacement context", hostContext],
      ])
      expect((yield* session.context(sessionID)).filter((message) => message.type === "model-switched")).toContainEqual(
        expect.objectContaining({ model: { id: "replacement", providerID: "fake" } }),
      )
    }),
  )

  it.effect("restores durable reasoning provider metadata in a second-turn request", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Think first" }), resume: false })

      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id: "reasoning-anthropic" }),
        LLMEvent.reasoningDelta({ id: "reasoning-anthropic", text: "Signed thought" }),
        LLMEvent.reasoningEnd({ id: "reasoning-anthropic", providerMetadata: { anthropic: { signature: "sig_1" } } }),
        LLMEvent.reasoningStart({
          id: "reasoning-openai",
          providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: null } },
        }),
        LLMEvent.reasoningDelta({ id: "reasoning-openai", text: "Encrypted thought" }),
        LLMEvent.reasoningEnd({
          id: "reasoning-openai",
          providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
        }),
        LLMEvent.textStart({ id: "reasoning-answer" }),
        LLMEvent.textDelta({ id: "reasoning-answer", text: "Done" }),
        LLMEvent.textEnd({ id: "reasoning-answer" }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      yield* session.resume(sessionID)
      yield* replaySessionProjection(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Think first" },
        {
          type: "assistant",
          content: [
            { type: "reasoning", text: "Signed thought", providerMetadata: { anthropic: { signature: "sig_1" } } },
            {
              type: "reasoning",
              text: "Encrypted thought",
              providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
            },
            { type: "text", text: "Done" },
          ],
        },
      ])

      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Continue" }), resume: false })
      response = contentStopResponse
      yield* session.resume(sessionID)

      expect(requests[1]?.messages[1]?.content).toEqual([
        { type: "reasoning", text: "Signed thought", providerMetadata: { anthropic: { signature: "sig_1" } } },
        {
          type: "reasoning",
          text: "Encrypted thought",
          providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
        },
        { type: "text", text: "Done" },
      ])
    }),
  )

  it.effect("replays durable provider-executed tool results inline in a second-turn request", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Search first" }), resume: false })

      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({
          id: "hosted-search",
          name: "web_search",
          input: { query: "Effect" },
          providerExecuted: true,
          providerMetadata: { openai: { itemId: "hosted-search" } },
        }),
        LLMEvent.toolResult({
          id: "hosted-search",
          name: "web_search",
          result: { type: "json", value: [{ title: "Effect" }] },
          providerExecuted: true,
          providerMetadata: { anthropic: { blockType: "web_search_tool_result" } },
        }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      yield* session.resume(sessionID)
      yield* replaySessionProjection(sessionID)

      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Continue" }), resume: false })
      response = contentStopResponse
      yield* session.resume(sessionID)

      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"])
      expect(requests[1]?.messages[1]?.content).toMatchObject([
        {
          type: "tool-call",
          id: "hosted-search",
          name: "web_search",
          input: { query: "Effect" },
          providerExecuted: true,
          providerMetadata: { openai: { itemId: "hosted-search" } },
        },
        {
          type: "tool-result",
          id: "hosted-search",
          name: "web_search",
          result: { type: "json", value: [{ title: "Effect" }] },
          providerExecuted: true,
          providerMetadata: { anthropic: { blockType: "web_search_tool_result" } },
        },
      ])
    }),
  )

  it.effect("stores exact medium provider tool text once and replays a bounded preview", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const text = `medium-provider-${"x".repeat(16 * 1024)}`
      const blobsBefore =
        (yield* db
          .select({ value: sql<number>`count(*)` })
          .from(ContentBlobTable)
          .get())?.value ?? 0
      const attachmentsBefore =
        (yield* db
          .select({ value: sql<number>`count(*)` })
          .from(AttachmentTable)
          .get())?.value ?? 0
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Fetch medium hosted text" }), resume: false })

      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({
          id: "hosted-medium",
          name: "web_search",
          input: { query: "medium" },
          providerExecuted: true,
        }),
        LLMEvent.toolResult({
          id: "hosted-medium",
          name: "web_search",
          result: { type: "text", value: text },
          output: { structured: {}, content: [{ type: "text", text }] },
          providerExecuted: true,
        }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      yield* session.resume(sessionID)
      yield* replaySessionProjection(sessionID)

      const rows = yield* db
        .select({ data: SessionMessageTable.data })
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      const durable = JSON.stringify(rows.map((row) => row.data))
      expect(durable).toContain(ContentStore.URI_PREFIX)
      expect(durable).not.toContain(text)
      expect(
        (yield* db
          .select({ value: sql<number>`count(*)` })
          .from(ContentBlobTable)
          .get())!.value - blobsBefore,
      ).toBe(1)
      expect(
        (yield* db
          .select({ value: sql<number>`count(*)` })
          .from(AttachmentTable)
          .get())!.value - attachmentsBefore,
      ).toBe(2)

      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Continue" }), resume: false })
      response = contentStopResponse
      yield* session.resume(sessionID)

      const assistant = requests[1]?.messages.find((message) => message.role === "assistant")
      const tool = assistant?.content.find((part) => part.type === "tool-result" && part.id === "hosted-medium")
      const restored = tool?.type === "tool-result" && tool.result.type === "text" ? tool.result.value : undefined
      expect(typeof restored).toBe("string")
      if (typeof restored !== "string") throw new Error("expected bounded medium provider text")
      expect(Buffer.byteLength(restored, "utf8")).toBeLessThanOrEqual(ToolOutputStore.MAX_PROVIDER_PREVIEW_BYTES)
      expect(restored).toContain("medium-provider-")
      expect(restored).not.toBe(text)
    }),
  )

  it.effect("restores non-identical large provider text from its result pointer", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const text = `result-head-${"x".repeat(ToolOutputStore.MAX_BYTES + 8_192)}-result-tail`
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Fetch distinct hosted text" }), resume: false })

      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({
          id: "hosted-distinct",
          name: "web_search",
          input: { query: "distinct" },
          providerExecuted: true,
        }),
        LLMEvent.toolResult({
          id: "hosted-distinct",
          name: "web_search",
          result: { type: "text", value: text },
          output: { structured: { source: "hosted" }, content: [{ type: "text", text: "Visible summary" }] },
          providerExecuted: true,
        }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      yield* session.resume(sessionID)
      yield* replaySessionProjection(sessionID)

      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Continue" }), resume: false })
      response = contentStopResponse
      yield* session.resume(sessionID)

      const assistant = requests[1]?.messages.find((message) => message.role === "assistant")
      const tool = assistant?.content.find((part) => part.type === "tool-result" && part.id === "hosted-distinct")
      const restored = tool?.type === "tool-result" && tool.result.type === "text" ? tool.result.value : undefined
      expect(typeof restored).toBe("string")
      if (typeof restored !== "string") throw new Error("expected restored text result")
      expect(Buffer.byteLength(restored, "utf8")).toBeLessThanOrEqual(ToolOutputStore.MAX_PROVIDER_PREVIEW_BYTES)
      expect(restored).toContain("result-head-")
      expect(restored).toContain("-result-tail")
      expect(restored).not.toBe(text)
    }),
  )

  it.effect("externalizes and restores large provider error text without JSON quoting", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const error = `error-head-${"x".repeat(ToolOutputStore.MAX_BYTES + 8_192)}-error-tail`
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Fetch hosted error" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "hosted-error",
            name: "web_search",
            input: { query: "error" },
            providerExecuted: true,
          }),
          LLMEvent.toolResult({
            id: "hosted-error",
            name: "web_search",
            result: { type: "error", value: error },
            providerExecuted: true,
          }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-auto-stop" }),
          LLMEvent.textDelta({ id: "text-auto-stop", text: "Done" }),
          LLMEvent.textEnd({ id: "text-auto-stop" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      yield* session.resume(sessionID)
      yield* replaySessionProjection(sessionID)

      const { db } = yield* Database.Service
      const rows = yield* db
        .select({ data: SessionMessageTable.data })
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      const durable = JSON.stringify(rows.map((row) => row.data))
      expect(durable).toContain(ContentStore.URI_PREFIX)
      expect(durable).not.toContain(error)
      const projected = yield* session.context(sessionID)
      const projectedTool = projected
        .find((message) => message.type === "assistant")
        ?.content.find((part) => part.type === "tool" && part.id === "hosted-error")
      const projectedError =
        projectedTool?.type === "tool" && projectedTool.state.status === "error"
          ? projectedTool.state.error.message
          : undefined
      expect(projectedError).toContain("error-head-")
      expect(projectedError).not.toContain("$opencode")

      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Continue" }), resume: false })
      responses = undefined
      response = contentStopResponse
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(3)
      const assistant = requests[2]?.messages.find((message) => message.role === "assistant")
      const tool = assistant?.content.find((part) => part.type === "tool-result" && part.id === "hosted-error")
      const restored = tool?.type === "tool-result" && tool.result.type === "error" ? tool.result.value : undefined
      expect(typeof restored).toBe("string")
      if (typeof restored !== "string") throw new Error("expected restored error text")
      expect(Buffer.byteLength(restored, "utf8")).toBeLessThanOrEqual(ToolOutputStore.MAX_PROVIDER_PREVIEW_BYTES)
      expect(restored).toContain("error-head-")
      expect(restored).toContain("-error-tail")
      expect(restored.startsWith('"')).toBeFalse()
      expect(restored).not.toBe(error)
    }),
  )

  it.effect("externalizes provider tool media and large output until the next request", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const image = `data:image/png;base64,${Buffer.from("exact-provider-image").toString("base64")}`
      const text = "exact provider text\n".repeat(Math.ceil((ToolOutputStore.MAX_STRUCTURED_BYTES + 4_096) / 20))
      const structured = { payload: "exact-provider-json".repeat(16_384) }
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Fetch large hosted results" }), resume: false })

      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({
          id: "hosted-media",
          name: "web_search",
          input: { query: "media" },
          providerExecuted: true,
        }),
        LLMEvent.toolResult({
          id: "hosted-media",
          name: "web_search",
          result: {
            type: "content",
            value: [
              { type: "text", text },
              { type: "file", uri: image, mime: "image/png", name: "provider.png" },
            ],
          },
          providerExecuted: true,
        }),
        LLMEvent.toolCall({
          id: "hosted-json",
          name: "web_search",
          input: { query: "json" },
          providerExecuted: true,
        }),
        LLMEvent.toolResult({
          id: "hosted-json",
          name: "web_search",
          result: { type: "json", value: structured },
          output: {
            structured: { source: "hosted-json" },
            content: [{ type: "text", text: "Hosted JSON result" }],
          },
          providerExecuted: true,
        }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      yield* session.resume(sessionID)
      yield* replaySessionProjection(sessionID)

      const { db } = yield* Database.Service
      const rows = yield* db
        .select({ data: SessionMessageTable.data })
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      const recorded = yield* db
        .select({ data: EventTable.data })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      const durableMessages = JSON.stringify(rows.map((row) => row.data))
      const durableEvents = JSON.stringify(recorded.map((row) => EventV2.decodeStoredEventData(row.data)))
      for (const durable of [durableMessages, durableEvents]) {
        expect(durable).toContain(ContentStore.URI_PREFIX)
        expect(durable).not.toContain("data:image")
        expect(durable).not.toContain(text)
        expect(durable).not.toContain(structured.payload)
      }

      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Continue" }), resume: false })
      response = contentStopResponse
      yield* session.resume(sessionID)

      const assistant = requests[1]?.messages.find((message) => message.role === "assistant")
      const media = assistant?.content.find((part) => part.type === "tool-result" && part.id === "hosted-media")
      const json = assistant?.content.find((part) => part.type === "tool-result" && part.id === "hosted-json")
      const mediaResult = media?.type === "tool-result" ? media.result : undefined
      expect(mediaResult?.type).toBe("content")
      if (mediaResult?.type !== "content") throw new Error("expected bounded provider content")
      expect(mediaResult.value[0]?.type).toBe("text")
      if (mediaResult.value[0]?.type !== "text") throw new Error("expected bounded provider text")
      expect(Buffer.byteLength(mediaResult.value[0].text, "utf8")).toBeLessThanOrEqual(
        ToolOutputStore.MAX_PROVIDER_PREVIEW_BYTES,
      )
      expect(mediaResult.value[0].text).not.toBe(text)
      expect(mediaResult.value[1]).toEqual({
        type: "file",
        uri: image,
        mime: "image/png",
        name: "provider.png",
      })
      const jsonResult = json?.type === "tool-result" ? json.result : undefined
      expect(jsonResult?.type).toBe("json")
      if (jsonResult?.type !== "json" || typeof jsonResult.value !== "object" || jsonResult.value === null)
        throw new Error("expected bounded provider JSON")
      const metadata = "$opencode" in jsonResult.value ? jsonResult.value.$opencode : undefined
      expect(metadata).toMatchObject({ type: "content-reference", uri: expect.stringMatching(/^attachment:\/\//) })
      if (typeof metadata !== "object" || metadata === null || !("preview" in metadata))
        throw new Error("expected bounded structured preview")
      expect(Buffer.byteLength(String(metadata.preview), "utf8")).toBeLessThanOrEqual(
        ToolOutputStore.MAX_PROVIDER_PREVIEW_BYTES,
      )
      expect(String(metadata.preview)).not.toContain(structured.payload)
    }),
  )

  it.effect("shares one bounded tool-output replay budget across a provider request", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const values = Array.from(
        { length: 8 },
        (_, index) => `provider-${index}-head-${"x".repeat(16 * 1024)}-provider-${index}-tail`,
      )
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Fetch many hosted results" }), resume: false })

      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        ...values.flatMap((value, index) => [
          LLMEvent.toolCall({
            id: `hosted-budget-${index}`,
            name: "web_search",
            input: { query: `${index}` },
            providerExecuted: true,
          }),
          LLMEvent.toolResult({
            id: `hosted-budget-${index}`,
            name: "web_search",
            result: { type: "text", value },
            providerExecuted: true,
          }),
        ]),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      yield* session.resume(sessionID)
      yield* replaySessionProjection(sessionID)

      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Continue" }), resume: false })
      response = contentStopResponse
      yield* session.resume(sessionID)

      const assistant = requests[1]?.messages.find((message) => message.role === "assistant")
      const results = assistant?.content.flatMap((part) =>
        part.type === "tool-result" && part.result.type === "text" && typeof part.result.value === "string"
          ? [part.result.value]
          : [],
      )
      expect(results).toHaveLength(values.length)
      expect(
        results
          ?.filter((value) => value !== ToolOutputStore.PROVIDER_BUDGET_OMISSION)
          .reduce((total, value) => total + Buffer.byteLength(value, "utf8"), 0),
      ).toBeLessThanOrEqual(ToolOutputStore.MAX_PROVIDER_TOTAL_PREVIEW_BYTES)
      expect(
        results?.every((value) => Buffer.byteLength(value, "utf8") <= ToolOutputStore.MAX_PROVIDER_PREVIEW_BYTES),
      ).toBe(true)
      expect(results).toContain(ToolOutputStore.PROVIDER_BUDGET_OMISSION)
      expect(results).not.toContain(values[0])
    }),
  )

  it.effect("starts recorded local tools eagerly and awaits settlement before continuing", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Echo five times" }), resume: false })

      requests.length = 0
      executions.length = 0
      toolExecutionGate = yield* Deferred.make<void>()
      toolExecutionsStarted = yield* Deferred.make<void>()
      const providerGate = yield* Deferred.make<void>()
      response = contentStopResponse
      responses = undefined
      const initial = Stream.fromIterable([
        LLMEvent.stepStart({ index: 0 }),
        ...Array.from({ length: 5 }, (_, index) =>
          LLMEvent.toolCall({ id: `call-echo-${index}`, name: "echo", input: { text: `${index}` } }),
        ),
      ])
      const final = Stream.fromIterable([
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ])
      streamGate = undefined
      responseStream = Stream.concat(
        initial,
        Stream.fromEffect(Deferred.await(providerGate)).pipe(Stream.flatMap(() => final)),
      )

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(toolExecutionsStarted)

      expect(executions).toHaveLength(5)
      expect(maxActiveToolExecutions).toBe(5)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Echo five times" },
        {
          type: "assistant",
          content: Array.from({ length: 5 }, (_, index) => ({
            type: "tool",
            id: `call-echo-${index}`,
            state: { status: "running", input: { text: `${index}` } },
          })),
        },
      ])

      yield* Deferred.succeed(providerGate, undefined)
      yield* Effect.yieldNow
      expect(requests).toHaveLength(1)

      yield* Deferred.succeed(toolExecutionGate, undefined)
      yield* Fiber.join(run)
      toolExecutionGate = undefined
      toolExecutionsStarted = undefined

      expect(executions).toHaveLength(5)
      expect(maxActiveToolExecutions).toBe(5)
      expect(requests).toHaveLength(2)
    }),
  )

  it.effect("cancels one active local tool call without interrupting sibling tools", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const execution = yield* SessionExecution.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Echo twice" }), resume: false })

      requests.length = 0
      executions.length = 0
      toolExecutionGate = yield* Deferred.make<void>()
      toolExecutionsStarted = yield* Deferred.make<void>()
      toolExecutionsReady = 2
      const providerGate = yield* Deferred.make<void>()
      response = contentStopResponse
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-final" }),
          LLMEvent.textDelta({ id: "text-final", text: "Recovered" }),
          LLMEvent.textEnd({ id: "text-final" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-cancel", name: "echo", input: { text: "cancel" } }),
          LLMEvent.toolCall({ id: "call-keep", name: "echo", input: { text: "keep" } }),
        ]),
        Stream.fromEffect(Deferred.await(providerGate)).pipe(
          Stream.flatMap(() =>
            Stream.fromIterable([
              LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
              LLMEvent.finish({ reason: "tool-calls" }),
            ]),
          ),
        ),
      )

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(toolExecutionsStarted)
      expect(executions).toEqual(["cancel", "keep"])

      expect(yield* execution.cancelTool(sessionID, "call-cancel")).toBe(true)
      yield* Deferred.succeed(providerGate, undefined)
      yield* Effect.yieldNow
      expect(requests).toHaveLength(1)

      yield* Deferred.succeed(toolExecutionGate, undefined)
      yield* Fiber.join(run)
      toolExecutionGate = undefined
      toolExecutionsStarted = undefined

      expect(yield* execution.cancelTool(sessionID, "call-keep")).toBe(false)
      expect(requests).toHaveLength(2)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Echo twice" },
        {
          type: "assistant",
          finish: "tool-calls",
          content: [
            {
              type: "tool",
              id: "call-cancel",
              state: {
                status: "error",
                input: { text: "cancel" },
                error: { message: SessionToolCancellation.ManualCancelMessage },
              },
            },
            {
              type: "tool",
              id: "call-keep",
              state: {
                status: "completed",
                input: { text: "keep" },
                structured: { text: "keep" },
              },
            },
          ],
        },
        { type: "assistant", finish: "stop", content: [{ type: "text", id: "text-final", text: "Recovered" }] },
      ])
    }),
  )

  it.effect("settles repeated provider-local tool call IDs against their owning assistant messages", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Echo twice" }), resume: false })

      requests.length = 0
      executions.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "tool_0", name: "echo", input: { text: "first" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "tool_0", name: "echo", input: { text: "second" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        contentStopResponse,
      ]

      yield* session.resume(sessionID)

      expect(executions).toEqual(["first", "second"])
      expect(requests).toHaveLength(3)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Echo twice" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "tool_0",
              state: { status: "completed", structured: { text: "first" }, content: [{ type: "text", text: "first" }] },
            },
          ],
        },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "tool_0",
              state: {
                status: "completed",
                structured: { text: "second" },
                content: [{ type: "text", text: "second" }],
              },
            },
          ],
        },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Done" }] },
      ])

      yield* replaySessionProjection(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Echo twice" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "tool_0",
              state: { status: "completed", structured: { text: "first" }, content: [{ type: "text", text: "first" }] },
            },
          ],
        },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "tool_0",
              state: {
                status: "completed",
                structured: { text: "second" },
                content: [{ type: "text", text: "second" }],
              },
            },
          ],
        },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Done" }] },
      ])
    }),
  )

  it.effect("joins concurrent resume calls into one active provider run", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Run once" }), resume: false })

      requests.length = 0
      responses = undefined
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-once" }),
        LLMEvent.textDelta({ id: "text-once", text: "Once" }),
        LLMEvent.textEnd({ id: "text-once" }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      const second = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Effect.yieldNow

      expect(requests).toHaveLength(1)
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Run once" },
        { type: "assistant", finish: "stop", content: [{ type: "text", id: "text-once", text: "Once" }] },
      ])
    }),
  )

  it.effect("steers an active provider turn with newly recorded prompts", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Start working" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-auto-stop" }),
          LLMEvent.textDelta({ id: "text-auto-stop", text: "Done" }),
          LLMEvent.textEnd({ id: "text-auto-stop" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-auto-stop" }),
          LLMEvent.textDelta({ id: "text-auto-stop", text: "Done" }),
          LLMEvent.textEnd({ id: "text-auto-stop" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Change direction" }) })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined
      streamStarted = undefined
      yield* Effect.yieldNow

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0]!)).toEqual(["Start working"])
      expect(userTexts(requests[1]!)).toEqual(["Start working", "Change direction"])
      expect((yield* session.context(sessionID)).map((message) => message.type)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
      ])
    }),
  )

  it.live("fails open on a hanging end snapshot and still promotes a pending steer", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const previousBoundary = process.env.OPENCODE_SNAPSHOT_BOUNDARY_TIMEOUT_MS
      process.env.OPENCODE_SNAPSHOT_BOUNDARY_TIMEOUT_MS = "25"
      const trackStarted = yield* Deferred.make<void>()
      const trackRelease = yield* Deferred.make<void>()
      let snapshotTrackCalls = 0
      snapshotTrackHook = Effect.gen(function* () {
        snapshotTrackCalls++
        // Only the end snapshot after the tool turn may wedge; the start snapshot and any
        // later calls resolve immediately so the observed timing stays the incident shape.
        if (snapshotTrackCalls !== 2) return
        yield* Deferred.succeed(trackStarted, undefined)
        yield* Deferred.await(trackRelease)
      })
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          // Live clock: the boundary timers are real, so release any snapshot wait
          // the fail-open timeout abandoned instead of leaving fibers parked on the gate.
          yield* Deferred.succeed(trackRelease, undefined)
          yield* Effect.sync(() => {
            snapshotTrackHook = Effect.void
            if (previousBoundary === undefined) delete process.env.OPENCODE_SNAPSHOT_BOUNDARY_TIMEOUT_MS
            else process.env.OPENCODE_SNAPSHOT_BOUNDARY_TIMEOUT_MS = previousBoundary
          })
        }),
      )

      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Work with echo" }), resume: false })
      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-snapshot-hang", name: "echo", input: { text: "hello" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        contentStopResponse,
      ]
      const drained = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(trackStarted)
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Steer while snapshot hangs" }) })
      yield* Fiber.join(drained)

      expect(requests).toHaveLength(2)
      // The end snapshot after the successful tool turn never resolves; the fail-open boundary
      // still settles Step.Ended, promotes the pending steer, and runs the follow-up turn.
      expect(userTexts(requests[0]!)).toEqual(["Work with echo"])
      expect(userTexts(requests[1]!)).toEqual(["Work with echo", "Steer while snapshot hangs"])

      const sessionEvents = yield* db
        .select({ seq: EventTable.seq, type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)
      const stepEndedSeqs = sessionEvents
        .filter((event) => event.type.startsWith("session.next.step.ended"))
        .map((event) => event.seq)
      const promotedSeqs = sessionEvents
        .filter((event) => event.type.startsWith("session.next.prompt.promoted"))
        .map((event) => event.seq)
      const promotedInputs = yield* db
        .select({ id: SessionInputTable.id })
        .from(SessionInputTable)
        .where(and(eq(SessionInputTable.session_id, sessionID), isNotNull(SessionInputTable.promoted_seq)))
        .all()
        .pipe(Effect.orDie)
      expect(promotedSeqs.length).toBe(2)
      expect(promotedInputs).toHaveLength(2)
      expect(stepEndedSeqs.length).toBeGreaterThanOrEqual(2)
      // The tool turn settled before the steer was promoted: no invisible busy-wait.
      expect(stepEndedSeqs[0]!).toBeLessThan(promotedSeqs[1]!)
      expect(yield* SessionInput.hasPending(db, sessionID, "steer")).toBe(false)
      const types = (yield* session.context(sessionID)).map((message) => message.type)
      expect(types.filter((type) => type === "user")).toHaveLength(2)
      expect(types.filter((type) => type === "assistant")).toHaveLength(2)
    }),
  )

  it.effect("promotes queued input at the next turn boundary while the activity runs", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Start working" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-echo", name: "echo", input: { text: "hello" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-auto-stop" }),
          LLMEvent.textDelta({ id: "text-auto-stop", text: "Done" }),
          LLMEvent.textEnd({ id: "text-auto-stop" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

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
      expect(userTexts(requests[0]!)).toEqual(["Start working"])
      expect(userTexts(requests[1]!)).toEqual(["Start working", "Wait until the next activity"])
    }),
  )

  it.effect("gives steering priority over queued input at the same turn boundary", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Start working" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-echo", name: "echo", input: { text: "hello" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-auto-stop" }),
          LLMEvent.textDelta({ id: "text-auto-stop", text: "Steered" }),
          LLMEvent.textEnd({ id: "text-auto-stop" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-auto-stop" }),
          LLMEvent.textDelta({ id: "text-auto-stop", text: "Done" }),
          LLMEvent.textEnd({ id: "text-auto-stop" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Queued correction" }),
        delivery: "queue",
      })
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Immediate correction" }),
      })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(3)
      expect(userTexts(requests[0]!)).toEqual(["Start working"])
      expect(userTexts(requests[1]!)).toEqual(["Start working", "Immediate correction"])
      expect(userTexts(requests[2]!)).toEqual(["Start working", "Immediate correction", "Queued correction"])
    }),
  )

  it.effect("preserves durable queued input for a later wake after interruption", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Interrupt current work" }), resume: false })

      requests.length = 0
      responses = [
        contentStopResponse,
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-auto-stop" }),
          LLMEvent.textDelta({ id: "text-auto-stop", text: "Done" }),
          LLMEvent.textEnd({ id: "text-auto-stop" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Run after interrupt" }),
        delivery: "queue",
      })
      yield* session.interrupt(sessionID)
      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      expect(requests).toHaveLength(1)
      expect(yield* SessionInput.hasPending(db, sessionID, "queue")).toBe(true)
      const resumed = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 2) yield* Effect.yieldNow
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(resumed)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0]!)).toEqual(["Interrupt current work"])
      expect(userTexts(requests[1]!)).toEqual(["Interrupt current work", "Run after interrupt"])
    }),
  )

  it.effect("preserves durable steering input for a later resume after interruption", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Interrupt current work" }), resume: false })

      requests.length = 0
      responses = [
        contentStopResponse,
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-auto-stop" }),
          LLMEvent.textDelta({ id: "text-auto-stop", text: "Done" }),
          LLMEvent.textEnd({ id: "text-auto-stop" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Steer after interrupt" }),
      })
      yield* session.interrupt(sessionID)
      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      expect(requests).toHaveLength(1)
      expect(yield* SessionInput.hasPending(db, sessionID, "steer")).toBe(true)

      const resumed = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 2) yield* Effect.yieldNow
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(resumed)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0]!)).toEqual(["Interrupt current work"])
      expect(userTexts(requests[1]!)).toEqual(["Interrupt current work", "Steer after interrupt"])
    }),
  )

  it.effect("runs queued active inputs as separate FIFO activities", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Start working" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-auto-stop" }),
          LLMEvent.textDelta({ id: "text-auto-stop", text: "Done" }),
          LLMEvent.textEnd({ id: "text-auto-stop" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-auto-stop" }),
          LLMEvent.textDelta({ id: "text-auto-stop", text: "Done" }),
          LLMEvent.textEnd({ id: "text-auto-stop" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-auto-stop" }),
          LLMEvent.textDelta({ id: "text-auto-stop", text: "Done" }),
          LLMEvent.textEnd({ id: "text-auto-stop" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Queue first" }), delivery: "queue" })
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Queue second" }), delivery: "queue" })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(3)
      expect(userTexts(requests[0]!)).toEqual(["Start working"])
      expect(userTexts(requests[1]!)).toEqual(["Start working", "Queue first"])
      expect(userTexts(requests[2]!)).toEqual(["Start working", "Queue first", "Queue second"])
    }),
  )

  it.effect("opens queued input after idle steering activity settles", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Start steering activity" }), resume: false })
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Queue later activity" }),
        delivery: "queue",
        resume: false,
      })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-auto-stop" }),
          LLMEvent.textDelta({ id: "text-auto-stop", text: "Done" }),
          LLMEvent.textEnd({ id: "text-auto-stop" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-auto-stop" }),
          LLMEvent.textDelta({ id: "text-auto-stop", text: "Done" }),
          LLMEvent.textEnd({ id: "text-auto-stop" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0]!)).toEqual(["Start steering activity"])
      expect(userTexts(requests[1]!)).toEqual(["Start steering activity", "Queue later activity"])
    }),
  )

  it.effect("coalesces steers into the active queued activity before starting the next queued activity", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Start working" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-auto-stop" }),
          LLMEvent.textDelta({ id: "text-auto-stop", text: "Done" }),
          LLMEvent.textEnd({ id: "text-auto-stop" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-auto-stop" }),
          LLMEvent.textDelta({ id: "text-auto-stop", text: "Done" }),
          LLMEvent.textEnd({ id: "text-auto-stop" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-auto-stop" }),
          LLMEvent.textDelta({ id: "text-auto-stop", text: "Done" }),
          LLMEvent.textEnd({ id: "text-auto-stop" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-auto-stop" }),
          LLMEvent.textDelta({ id: "text-auto-stop", text: "Done" }),
          LLMEvent.textEnd({ id: "text-auto-stop" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      const firstGate = yield* Deferred.make<void>()
      const secondGate = yield* Deferred.make<void>()
      streamGate = firstGate

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 1) yield* Effect.yieldNow
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Queue first" }), delivery: "queue" })
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Queue second" }), delivery: "queue" })
      streamGate = secondGate
      yield* Deferred.succeed(firstGate, undefined)
      while (requests.length < 2) yield* Effect.yieldNow
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Steer first queued activity" }) })
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Also steer first queued activity" }) })
      yield* Deferred.succeed(secondGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined

      expect(requests).toHaveLength(4)
      expect(userTexts(requests[0]!)).toEqual(["Start working"])
      expect(userTexts(requests[1]!)).toEqual(["Start working", "Queue first"])
      expect(userTexts(requests[2]!)).toEqual([
        "Start working",
        "Queue first",
        "Steer first queued activity",
        "Also steer first queued activity",
      ])
      expect(userTexts(requests[3]!)).toEqual([
        "Start working",
        "Queue first",
        "Steer first queued activity",
        "Also steer first queued activity",
        "Queue second",
      ])
    }),
  )

  it.effect("coalesces multiple active steering prompts into one continuation turn", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Start working" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-auto-stop" }),
          LLMEvent.textDelta({ id: "text-auto-stop", text: "Done" }),
          LLMEvent.textEnd({ id: "text-auto-stop" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-auto-stop" }),
          LLMEvent.textDelta({ id: "text-auto-stop", text: "Done" }),
          LLMEvent.textEnd({ id: "text-auto-stop" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First steer" }) })
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Second steer" }) })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined
      streamStarted = undefined
      yield* Effect.yieldNow

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[1]!)).toEqual(["Start working", "First steer", "Second steer"])
      yield* (yield* SessionRunCoordinator.Service).wake(sessionID)
      yield* Effect.yieldNow
      expect(requests).toHaveLength(2)
    }),
  )

  it.effect("runs steering input accepted while the active provider turn fails", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Start working" }), resume: false })

      requests.length = 0
      responses = undefined
      response = contentStopResponse
      streamFailure = providerUnavailable()
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Recover with this" }) })
      yield* Deferred.succeed(streamGate, undefined)
      expect(yield* Fiber.join(first).pipe(Effect.flip)).toBe(streamFailure)

      streamFailure = undefined
      streamGate = undefined
      streamStarted = undefined
      yield* (yield* SessionRunCoordinator.Service).awaitIdle(sessionID)

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[1]!)).toEqual(["Start working", "Recover with this"])
    }),
  )

  it.effect("rebuilds a retry request when steering arrives after a retryable provider failure", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Start retry work" }), resume: false })

      requests.length = 0
      responses = [
        [LLMEvent.providerError({ message: "Retry later", retryable: true, retryAfterMs: 0 })],
        fragmentFixture("text", "text-retry-steer", ["Recovered"]).completeEvents,
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Retry with this steer" }), resume: false })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(run)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0]!)).toEqual(["Start retry work"])
      expect(userTexts(requests[1]!)).toEqual(["Start retry work", "Retry with this steer"])
    }),
  )

  it.effect("retries a failed chain step once before advancing without duplicating the prompt", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Use the configured chain" }),
        model: chainModelRef(),
        resume: false,
      })

      requests.length = 0
      responses = [
        [LLMEvent.providerError({ message: "Primary unavailable", retryable: true, retryAfterMs: 0 })],
        [LLMEvent.providerError({ message: "Primary unavailable", retryable: true, retryAfterMs: 0 })],
        fragmentFixture("text", "text-chain-fallback", ["Recovered"]).completeEvents,
      ]
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.model)).toEqual([model, model, replacementModel])
      expect(requests.map(userTexts)).toEqual(Array.from({ length: 3 }, () => ["Use the configured chain"]))
      expect((yield* session.get(sessionID)).model).toMatchObject({
        id: "replacement",
        providerID: "fake",
        variant: "medium",
        chain: { id: "standard", active: 1 },
      })
    }),
  )

  it.effect("advances a persisted model chain when model resolution authorization refresh fails", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const authorization = new Integration.AuthorizationError({
        cause: new Error("refresh failed"),
      })
      modelResolveHook = Effect.suspend(() => {
        modelResolveHook = Effect.void
        return Effect.fail(authorization)
      })
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Recover the authorization refresh" }),
        model: chainModelRef(),
        resume: false,
      })

      requests.length = 0
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.model)).toEqual([replacementModel])
      expect(userTexts(requests[0]!)).toEqual(["Recover the authorization refresh"])
      expect((yield* session.get(sessionID)).model).toMatchObject({
        id: "replacement",
        providerID: "fake",
        variant: "medium",
        chain: { id: "standard", active: 1 },
      })
    }),
  )

  it.effect("advances only to the next persisted chain step when the selected model is missing", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      modelResolveHook = Effect.suspend(() => {
        modelResolveHook = Effect.void
        return Effect.fail(
          new Catalog.ModelNotFoundError({
            providerID: ProviderV2.ID.make("openrouter"),
            modelID: ModelV2.ID.make("stealth/ox-alpha"),
          }),
        )
      })
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Recover the delisted chain step" }),
        model: chainModelRef(),
        resume: false,
      })

      requests.length = 0
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.model)).toEqual([replacementModel])
      expect(userTexts(requests[0]!)).toEqual(["Recover the delisted chain step"])
      expect((yield* session.get(sessionID)).model).toMatchObject({
        id: "replacement",
        providerID: "fake",
        variant: "medium",
        chain: { id: "standard", active: 1 },
      })
    }),
  )

  it.effect("preserves model resolution authorization failures without a persisted chain", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const authorization = new Integration.AuthorizationError({
        cause: new Error("refresh failed"),
      })
      modelResolveHook = Effect.fail(authorization)
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Keep the authorization failure" }),
        resume: false,
      })

      requests.length = 0
      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(authorization)
      expect(requests).toHaveLength(0)
    }),
  )

  it.live(
    "advances the model chain when pre-provider model init stalls past the deadline",
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Continue after init stall" }),
        model: chainModelRef(),
        resume: false,
      })

      requests.length = 0
      let hangs = 1
      modelResolveHook = Effect.suspend(() => (hangs-- > 0 ? Effect.never : Effect.void))
      response = contentStopResponse
      process.env.OPENCODE_SESSION_MODEL_RESOLVE_INIT_TIMEOUT_MS = "25"
      try {
        yield* session.resume(sessionID)
      } finally {
        modelResolveHook = Effect.void
        delete process.env.OPENCODE_SESSION_MODEL_RESOLVE_INIT_TIMEOUT_MS
      }

      // The stalled first attempt never dispatched a stream; exactly one stream
      // runs, and only on the advanced fallback model.
      expect(requests.map((request) => request.model)).toEqual([replacementModel])
      expect((yield* session.get(sessionID)).model).toMatchObject({
        id: "replacement",
        providerID: "fake",
        chain: { id: "standard", active: 1 },
      })
      // The durable input promoted exactly once, before the stalled attempt.
      const context = yield* session.context(sessionID)
      expect(context.filter((message) => message.type === "user")).toHaveLength(1)
      expect(context.some((message) => message.type === "model-switched")).toBe(true)
    }),
    10_000,
  )

  it.live(
    "fails the turn terminally when stalled pre-provider model init has no chain fallback",
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Stall without fallback" }), resume: false })

      requests.length = 0
      modelResolveHook = Effect.never
      process.env.OPENCODE_SESSION_MODEL_RESOLVE_INIT_TIMEOUT_MS = "25"
      let failure: unknown
      try {
        failure = yield* session.resume(sessionID).pipe(Effect.flip)
      } finally {
        modelResolveHook = Effect.void
        delete process.env.OPENCODE_SESSION_MODEL_RESOLVE_INIT_TIMEOUT_MS
      }
      expect((failure as SessionRunnerModel.ModelResolveTimeoutError)._tag).toBe(
        "SessionRunnerModel.ModelResolveTimeoutError",
      )
      // The stalled attempt never reached a provider stream.
      expect(requests).toHaveLength(0)

      // A follow-up resume is safe: it streams once against the promoted
      // history without re-promoting the durable input.
      response = contentStopResponse
      yield* session.resume(sessionID)
      const context = yield* session.context(sessionID)
      expect(context.filter((message) => message.type === "user")).toHaveLength(1)
      expect(requests).toHaveLength(1)
    }),
    10_000,
  )

  it.live(
    "keeps a concurrent model switch over the stalled timeout chain fallback",
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Keep the newer switch" }),
        model: chainModelRef(),
        resume: false,
      })

      requests.length = 0
      let stalled = false
      const resolveStarted = yield* Deferred.make<void>()
      // The hook only signals that the stalled resolve started; the concurrent
      // switch is published from the test environment once the runner is stuck.
      modelResolveHook = Effect.gen(function* () {
        if (stalled) return Effect.void
        stalled = true
        yield* Deferred.succeed(resolveStarted, undefined)
        return yield* Effect.never
      })
      response = contentStopResponse
      process.env.OPENCODE_SESSION_MODEL_RESOLVE_INIT_TIMEOUT_MS = "500"
      const resumed = yield* session.resume(sessionID).pipe(Effect.forkScoped)
      try {
        yield* Deferred.await(resolveStarted)
        yield* events.publish(SessionEvent.ModelSwitched, {
          sessionID,
          messageID: SessionMessage.ID.create(),
          timestamp: yield* DateTime.now,
          model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
        })
        // The test releases this once the switch is durably applied, so the
        // deadline handler's reload deterministically observes the newer
        // persisted model.
        const pollDeadline = Date.now() + 5_000
        while (Date.now() < pollDeadline) {
          if ((yield* session.get(sessionID)).model?.id === "replacement") break
          yield* Effect.sleep(5)
        }
      } finally {
        delete process.env.OPENCODE_SESSION_MODEL_RESOLVE_INIT_TIMEOUT_MS
      }
      // The newer persisted model stays even if the join fails; hook and env
      // cleanup must run regardless of the resume outcome.
      yield* Fiber.join(resumed).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            modelResolveHook = Effect.void
            delete process.env.OPENCODE_SESSION_MODEL_RESOLVE_INIT_TIMEOUT_MS
          }),
        ),
      )

      // The stale chain fallback is neither published nor streamed: exactly two
      // switches remain — the promoted prompt's chain head and the concurrent
      // newer replacement — and no fallback step (chain active=1).
      expect(requests.map((request) => request.model)).toEqual([replacementModel])
      expect((yield* session.get(sessionID)).model).toMatchObject({ id: "replacement", providerID: "fake" })
      const context = yield* session.context(sessionID)
      const switches = context.filter((message) => message.type === "model-switched")
      expect(switches).toHaveLength(2)
      expect(switches[0]).toMatchObject({
        model: { id: "fake-model", providerID: "fake", chain: { id: "standard", active: 0 } },
      })
      expect(switches[1]).toMatchObject({ model: { id: "replacement", providerID: "fake" } })
      expect(switches.some((message) => message.model.chain?.active === 1)).toBe(false)
      expect(context.filter((message) => message.type === "user")).toHaveLength(1)
    }),
    10_000,
  )

  it.live(
    "treats a newer chain revision of the same base model as a conflicting switch",
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Keep the newer chain state" }),
        model: chainModelRef(),
        resume: false,
      })

      requests.length = 0
      let stalled = false
      const resolveStarted = yield* Deferred.make<void>()
      // The concurrent actor advanced the same base model's chain (active=1);
      // full Ref equivalence must treat that as conflicting with the captured
      // active=0 revision even though id and provider are unchanged.
      modelResolveHook = Effect.gen(function* () {
        if (stalled) return
        stalled = true
        yield* Deferred.succeed(resolveStarted, undefined)
        return yield* Effect.never
      })
      response = contentStopResponse
      process.env.OPENCODE_SESSION_MODEL_RESOLVE_INIT_TIMEOUT_MS = "500"
      const resumed = yield* session.resume(sessionID).pipe(Effect.forkScoped)
      try {
        yield* Deferred.await(resolveStarted)
        yield* events.publish(SessionEvent.ModelSwitched, {
          sessionID,
          messageID: SessionMessage.ID.create(),
          timestamp: yield* DateTime.now,
          model: {
            id: ModelV2.ID.make("fake-model"),
            providerID: ProviderV2.ID.make("fake"),
            chain: {
              id: "standard",
              name: "Standard",
              active: 1,
              steps: [
                { id: ModelV2.ID.make("fake-model"), providerID: ProviderV2.ID.make("fake") },
                { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
              ],
            },
          },
        })
        const pollDeadline = Date.now() + 5_000
        while (Date.now() < pollDeadline) {
          if ((yield* session.get(sessionID)).model?.chain?.active === 1) break
          yield* Effect.sleep(5)
        }
      } finally {
        delete process.env.OPENCODE_SESSION_MODEL_RESOLVE_INIT_TIMEOUT_MS
      }
      yield* Fiber.join(resumed).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            modelResolveHook = Effect.void
          }),
        ),
      )

      // The stale active=0 fallback is rejected: no replacement-model stream
      // runs and no third switch appears.
      expect(requests.map((request) => request.model)).toEqual([model])
      expect((yield* session.get(sessionID)).model).toMatchObject({
        id: "fake-model",
        providerID: "fake",
        chain: { id: "standard", active: 1 },
      })
      const context = yield* session.context(sessionID)
      const switches = context.filter((message) => message.type === "model-switched")
      expect(switches).toHaveLength(2)
      expect(switches[0]).toMatchObject({ model: { id: "fake-model", chain: { active: 0 } } })
      expect(switches[1]).toMatchObject({ model: { id: "fake-model", chain: { active: 1 } } })
      expect(context.filter((message) => message.type === "user")).toHaveLength(1)
    }),
    10_000,
  )

  it.live(
    "serializes a competing switch behind the guarded fallback commit window",
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Serialize the commit window" }),
        model: chainModelRef(),
        resume: false,
      })

      requests.length = 0
      let stalled = false
      const resolveStarted = yield* Deferred.make<void>()
      const afterEqualityGuard = yield* Deferred.make<void>()
      const releaseFallbackCommit = yield* Deferred.make<void>()
      // Registered after the production equality guard: this gate fires only
      // once the observed model was confirmed equal and pauses the immediate
      // commit transaction before the fallback is written.
      yield* events.beforeCommit((event) => {
        if (event.type !== SessionEvent.ModelSwitched.type) return Effect.void
        if (event.metadata?.[SessionEvent.ModelSwitchedExpectedMetadataKey] === undefined) return Effect.void
        return Effect.gen(function* () {
          yield* Deferred.succeed(afterEqualityGuard, undefined)
          yield* Deferred.await(releaseFallbackCommit)
        })
      })
      modelResolveHook = Effect.gen(function* () {
        if (stalled) return
        stalled = true
        yield* Deferred.succeed(resolveStarted, undefined)
        return yield* Effect.never
      })
      response = contentStopResponse
      process.env.OPENCODE_SESSION_MODEL_RESOLVE_INIT_TIMEOUT_MS = "150"
      const resumed = yield* session.resume(sessionID).pipe(Effect.forkScoped)
      let competingSettled = false
      const commitWindow = Effect.gen(function* () {
        yield* Deferred.await(resolveStarted)
        // The equality check passed; while the guarded commit transaction is
        // paused after it, the competing switch must not complete. It is only
        // started now so it queues behind the open transaction.
        yield* Deferred.await(afterEqualityGuard)
        const competing = yield* Effect.forkScoped(
          Effect.gen(function* () {
            yield* events.publish(SessionEvent.ModelSwitched, {
              sessionID,
              messageID: SessionMessage.ID.create(),
              timestamp: yield* DateTime.now,
              model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
            })
            competingSettled = true
          }),
        )
        yield* Effect.sleep(120)
        expect(competingSettled).toBe(false)
        yield* Deferred.succeed(releaseFallbackCommit, undefined).pipe(Effect.ignore)
        yield* Fiber.join(competing)
        yield* Fiber.join(resumed)
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            // Release first: every failure path must unblock the paused commit
            // transaction before fibers are interrupted.
            yield* Deferred.succeed(releaseFallbackCommit, undefined).pipe(Effect.ignore)
            modelResolveHook = Effect.void
            delete process.env.OPENCODE_SESSION_MODEL_RESOLVE_INIT_TIMEOUT_MS
          }),
        ),
      )
      yield* commitWindow

      // Commit order: guarded fallback first, then the newer user switch.
      const eventRows = yield* db
        .select({ seq: EventTable.seq, type: EventTable.type, data: EventTable.data })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      const switchEvents = eventRows
        .filter((row) => row.type.includes("model.switched"))
        .map((row) => ({
          seq: row.seq,
          model: (row.data as { model: { id: string; chain?: { active: number } } }).model,
        }))
      expect(switchEvents).toHaveLength(3)
      expect(switchEvents[0]).toMatchObject({ model: { id: "fake-model", chain: { active: 0 } } })
      expect(switchEvents[1]).toMatchObject({ model: { id: "replacement", chain: { active: 1 } } })
      expect(switchEvents[2]).toMatchObject({ model: { id: "replacement" } })
      expect(switchEvents[2]!.model).not.toHaveProperty("chain")
      // The rebuild streams exactly once, on the final newer user choice.
      expect(requests.map((request) => request.model)).toEqual([replacementModel])
      const persisted = yield* session.get(sessionID)
      expect(persisted.model).toMatchObject({ id: "replacement", providerID: "fake" })
      expect(persisted.model?.chain).toBeUndefined()
      expect(competingSettled).toBe(true)
    }),
    15_000,
  )

  it.live("advances a model chain after a provider stream becomes inactive", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Recover the stalled chain step" }),
        model: chainModelRef(),
        resume: false,
      })

      requests.length = 0
      let stalls = 0
      responseStreamFactory = () => ++stalls <= 2
        ? Stream.never
        : Stream.fromIterable(fragmentFixture("text", "text-chain-stall-fallback", ["Recovered"]).completeEvents)
      const previous = process.env.OPENCODE_PROVIDER_STREAM_IDLE_TIMEOUT_MS
      process.env.OPENCODE_PROVIDER_STREAM_IDLE_TIMEOUT_MS = "10"
      yield* session.resume(sessionID).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) delete process.env.OPENCODE_PROVIDER_STREAM_IDLE_TIMEOUT_MS
            else process.env.OPENCODE_PROVIDER_STREAM_IDLE_TIMEOUT_MS = previous
          }),
        ),
      )

      expect(requests.map((request) => request.model)).toEqual([model, model, replacementModel])
      expect(requests.map(userTexts)).toEqual(Array.from({ length: 3 }, () => ["Recover the stalled chain step"]))
      expect((yield* session.get(sessionID)).model).toMatchObject({
        id: "replacement",
        providerID: "fake",
        variant: "medium",
        chain: { id: "standard", active: 1 },
      })
    }),
  )

  it.effect("never attaches an agent fallback chain to an explicit direct model", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* (yield* AgentV2.Service).update((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          const configured = chainModelRef()
          agent.model = {
            ...configured,
            chain: configured.chain ? { ...configured.chain, steps: [...configured.chain.steps] } : undefined,
          }
        }),
      )
      const selected = ModelV2.Ref.make({ id: ModelV2.ID.make("fake-model"), providerID: ProviderV2.ID.make("fake") })
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Use only my selected model" }), model: selected, resume: false })
      requests.length = 0
      responseStream = Stream.fail(quotaExceeded())
      response = fragmentFixture("text", "unwanted-fallback", ["Wrong provider"]).completeEvents
      const result = yield* session.resume(sessionID).pipe(Effect.result)
      expect(result._tag).toBe("Failure")
      expect(requests.map((request) => request.model)).toEqual([model])
      expect((yield* session.get(sessionID)).model).toMatchObject(selected)
      expect((yield* session.get(sessionID)).model?.chain).toBeUndefined()
    }),
  )

  it.effect("advances a model chain immediately after a known quota response", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const agentService = yield* AgentV2.Service
      const configuredModel = chainModelRef()
      yield* agentService.update((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.model = {
            ...configuredModel,
            chain: configuredModel.chain
              ? { ...configuredModel.chain, steps: [...configuredModel.chain.steps] }
              : undefined,
          }
        }),
      )
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Recover the quota-limited chain step" }),
        model: configuredModel,
        resume: false,
      })

      requests.length = 0
      responseStream = Stream.fail(quotaExceeded())
      response = fragmentFixture("text", "text-chain-quota-fallback", ["Recovered"]).completeEvents
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.model)).toEqual([model, replacementModel])
      expect(requests.map(userTexts)).toEqual([
        ["Recover the quota-limited chain step"],
        ["Recover the quota-limited chain step"],
      ])
      expect((yield* session.get(sessionID)).model).toMatchObject({
        id: "replacement",
        providerID: "fake",
        variant: "medium",
        chain: { id: "standard", active: 1 },
      })
    }),
  )

  it.effect("continues a model chain after a quota failure follows durable assistant output", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Continue the worker after its model reaches quota" }),
        model: chainModelRef(),
        resume: false,
      })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-before-chain-quota" }),
          LLMEvent.textDelta({ id: "text-before-chain-quota", text: "Partial work" }),
          LLMEvent.textEnd({ id: "text-before-chain-quota" }),
          LLMEvent.providerError({
            message: "weekly/monthly usage limit reached",
            retryable: false,
          }),
        ],
        fragmentFixture("text", "text-after-chain-quota", ["Recovered on fallback"]).completeEvents,
      ]

      yield* session.resume(sessionID)

      expect(requests.map((request) => request.model)).toEqual([model, replacementModel])
      expect(requests.map(userTexts)).toEqual([
        ["Continue the worker after its model reaches quota"],
        ["Continue the worker after its model reaches quota"],
      ])
      expect((yield* session.get(sessionID)).model).toMatchObject({
        id: "replacement",
        providerID: "fake",
        variant: "medium",
        chain: { id: "standard", active: 1 },
      })
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "model-switched", model: { id: "fake-model", providerID: "fake" } },
        { type: "user", text: "Continue the worker after its model reaches quota" },
        { type: "assistant", finish: "error", content: [{ type: "text", text: "Partial work" }] },
        { type: "model-switched", model: { id: "replacement", providerID: "fake" } },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Recovered on fallback" }] },
      ])
    }),
  )

  it.effect("continues a model chain without replaying a completed local tool", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Continue the worker without replaying tools" }),
        model: chainModelRef(),
        resume: false,
      })

      requests.length = 0
      const executionCount = executions.length
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-before-chain-quota", name: "echo", input: { text: "settled once" } }),
          LLMEvent.providerError({ message: "Usage limit reached", retryable: false }),
        ],
        fragmentFixture("text", "text-after-chain-tool", ["Recovered on fallback"]).completeEvents,
      ]

      yield* session.resume(sessionID)

      expect(requests.map((request) => request.model)).toEqual([model, replacementModel])
      expect(requests.map(userTexts)).toEqual([
        ["Continue the worker without replaying tools"],
        ["Continue the worker without replaying tools"],
      ])
      expect(executions.slice(executionCount)).toEqual(["settled once"])
      expect((yield* session.context(sessionID)).filter((entry) => entry.type === "assistant")).toMatchObject([
        { finish: "error", content: [{ type: "tool", id: "call-before-chain-quota" }] },
        { finish: "stop", content: [{ type: "text", text: "Recovered on fallback" }] },
      ])
    }),
  )

  it.effect("continues a model chain after a remote stream abort follows durable assistant output", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Continue the worker after its stream aborts" }),
        model: chainModelRef(),
        resume: false,
      })

      requests.length = 0
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-before-chain-abort" }),
          LLMEvent.textDelta({ id: "text-before-chain-abort", text: "Partial work" }),
          LLMEvent.textEnd({ id: "text-before-chain-abort" }),
        ]),
        Stream.fail(
          new LLMError({
            module: "test",
            method: "stream",
            reason: new TransportReason({ message: "Stream abgebrochen", canRetry: false }),
          }),
        ),
      )
      response = fragmentFixture("text", "text-after-chain-abort", ["Recovered on fallback"]).completeEvents

      yield* session.resume(sessionID)

      expect(requests.map((request) => request.model)).toEqual([model, replacementModel])
      expect((yield* session.get(sessionID)).model).toMatchObject({
        id: "replacement",
        providerID: "fake",
        chain: { id: "standard", active: 1 },
      })
      expect((yield* session.context(sessionID)).filter((entry) => entry.type === "assistant")).toMatchObject([
        { finish: "error", content: [{ type: "text", text: "Partial work" }] },
        { finish: "stop", content: [{ type: "text", text: "Recovered on fallback" }] },
      ])
    }),
  )

  it.effect("fails a quota-limited model chain only after one attempt per configured step", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Exhaust the quota-limited chain" }),
        model: chainModelRef(),
        resume: false,
      })

      requests.length = 0
      responseStreamFactory = () => Stream.fail(quotaExceeded())

      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBeInstanceOf(LLMError)
      expect(requests.map((request) => request.model)).toEqual([model, replacementModel])
      expect((yield* session.get(sessionID)).model).toMatchObject({
        id: "replacement",
        providerID: "fake",
        chain: { id: "standard", active: 1 },
      })
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "model-switched", model: { id: "fake-model", providerID: "fake" } },
        { type: "user", text: "Exhaust the quota-limited chain" },
        { type: "model-switched", model: { id: "replacement", providerID: "fake" } },
        {
          type: "assistant",
          finish: "error",
          error: {
            message: expect.stringContaining("weekly/monthly usage limit reached"),
          },
        },
      ])
    }),
  )

  it.effect("advances a model chain after provider-stream authorization fails", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Recover the unauthorized chain step" }),
        model: chainModelRef(),
        resume: false,
      })

      requests.length = 0
      responseStream = Stream.fail(
        new LLMError({
          module: "test",
          method: "stream",
          reason: Object.assign(new TransportReason({ message: "Request failed: 401", canRetry: false }), {
            http: { response: { status: 401 }, body: "Unauthorized" },
          }),
        }),
      )
      response = fragmentFixture("text", "text-chain-authorization-fallback", ["Recovered"]).completeEvents
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.model)).toEqual([model, replacementModel])
      expect(requests.map(userTexts)).toEqual([
        ["Recover the unauthorized chain step"],
        ["Recover the unauthorized chain step"],
      ])
      expect((yield* session.get(sessionID)).model).toMatchObject({
        id: "replacement",
        providerID: "fake",
        variant: "medium",
        chain: { id: "standard", active: 1 },
      })
    }),
  )

  it.effect("advances a model chain after provider-stream inactivity", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Recover the stalled chain step" }),
        model: chainModelRef(),
        resume: false,
      })

      requests.length = 0
      let failures = 0
      responseStreamFactory = () => ++failures <= 2
        ? Stream.fail(new LLMError({
            module: "SessionRunner",
            method: "runProviderStream",
            reason: new TransportReason({
              message: "Provider stream stalled: no events for 60 seconds",
              kind: "stream-inactivity",
              canRetry: true,
              retryAfterMs: 0,
            }),
          }))
        : Stream.fromIterable(fragmentFixture("text", "text-chain-inactivity-fallback", ["Recovered"]).completeEvents)
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.model)).toEqual([model, model, replacementModel])
      expect(requests.map(userTexts)).toEqual(Array.from({ length: 3 }, () => ["Recover the stalled chain step"]))
      expect((yield* session.get(sessionID)).model).toMatchObject({
        id: "replacement",
        providerID: "fake",
        variant: "medium",
        chain: { id: "standard", active: 1 },
      })
    }),
  )

  it.effect("keeps a user interruption distinct from provider inactivity", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Interrupt this chain step" }),
        model: chainModelRef(),
        resume: false,
      })

      requests.length = 0
      responseStream = Stream.never
      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length === 0) yield* Effect.yieldNow
      yield* Fiber.interrupt(run)
      const exit = yield* Fiber.await(run)

      expect(exit._tag === "Failure" && Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(requests.map((request) => request.model)).toEqual([model])
      expect((yield* session.get(sessionID)).model).toMatchObject({
        id: "fake-model",
        providerID: "fake",
        chain: { id: "standard", active: 0 },
      })
    }),
  )

  it.effect("advances a model chain after an empty completion", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Recover the empty chain step" }),
        model: chainModelRef(),
        resume: false,
      })

      requests.length = 0
      responses = [[], [], fragmentFixture("text", "text-chain-empty-fallback", ["Recovered"]).completeEvents]
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.model)).toEqual([model, model, replacementModel])
      expect(requests.map(userTexts)).toEqual(Array.from({ length: 3 }, () => ["Recover the empty chain step"]))
      expect((yield* session.get(sessionID)).model).toMatchObject({
        id: "replacement",
        providerID: "fake",
        variant: "medium",
        chain: { id: "standard", active: 1 },
      })
    }),
  )

  it.effect("advances a persisted model chain for authentication failures", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Recover from invalid provider credentials" }),
        model: chainModelRef(),
        resume: false,
      })

      requests.length = 0
      responses = [
        [LLMEvent.providerError({ message: "invalid_api_key: authentication failed", retryable: false })],
        fragmentFixture("text", "text-chain-authentication-fallback", ["Recovered"]).completeEvents,
      ]
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.model)).toEqual([model, replacementModel])
      expect(requests.map(userTexts)).toEqual([
        ["Recover from invalid provider credentials"],
        ["Recover from invalid provider credentials"],
      ])
      const switches = (yield* session.context(sessionID)).filter((message) => message.type === "model-switched")
      expect(switches.map((message) => message.model.chain?.active)).toEqual([0, 1])
      expect(switches[1]).toMatchObject({
        type: "model-switched",
        model: { id: "replacement", providerID: "fake", variant: "medium", chain: { id: "standard", active: 1 } },
      })
      expect((yield* session.get(sessionID)).model).toMatchObject({
        id: "replacement",
        providerID: "fake",
        variant: "medium",
        chain: { id: "standard", active: 1 },
      })
    }),
  )

  it.effect("backs off exponentially before retrying transient provider errors", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Retry empty reasoning" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.reasoningStart({
            id: "reasoning-empty",
            providerMetadata: { openai: { itemId: "rs_empty", reasoningEncryptedContent: "cipher" } },
          }),
          LLMEvent.reasoningEnd({ id: "reasoning-empty" }),
          LLMEvent.providerError({ message: "server_error: Try again", retryable: true }),
        ],
        [LLMEvent.providerError({ message: "server_error: Try again", retryable: true })],
        [LLMEvent.providerError({ message: "server_error: Try again", retryable: true })],
        fragmentFixture("text", "text-after-empty-reasoning", ["Recovered"]).completeEvents,
      ]

      const retriedEvents: Array<{ attempt?: number; requestCount: number }> = []
      const subscription = yield* events.subscribe(SessionEvent.Retried).pipe(
        Stream.map((event) => retriedEvents.push({ attempt: event.data.attempt, requestCount: requests.length })),
        Stream.runDrain,
        Effect.forkChild,
      )
      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Effect.forEach([2_000, 4_000, 8_000], (delay, index) =>
        Effect.gen(function* () {
          while (requests.length < index + 1) yield* Effect.yieldNow
          expect(requests).toHaveLength(index + 1)
          yield* TestClock.adjust(delay - 1)
          expect(requests).toHaveLength(index + 1)
          yield* TestClock.adjust(1)
        }),
      )
      yield* Fiber.join(run)

      expect(requests).toHaveLength(4)
      expect(requests.every((request) => request.http?.retries === 0)).toBe(true)
      expect(retriedEvents).toEqual([
        { attempt: 1, requestCount: 1 },
        { attempt: 2, requestCount: 2 },
        { attempt: 3, requestCount: 3 },
      ])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Retry empty reasoning" },
        {
          type: "assistant",
          finish: "stop",
          content: [
            { type: "reasoning", id: "reasoning-empty", text: "" },
            { type: "text", id: "text-after-empty-reasoning", text: "Recovered" },
          ],
        },
      ])
      yield* Fiber.interrupt(subscription)
    }),
  )

  it.effect("retries instead of stopping when a provider returns an empty successful completion", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Retry empty completion" }),
        resume: false,
      })

      requests.length = 0
      // First request completes successfully without any text, reasoning, or tool call.
      // The runner must recover with another provider turn instead of ending the activity.
      responses = [[], fragmentFixture("text", "text-after-empty-completion", ["Recovered"]).completeEvents]
      const retriedEvents: Array<{ attempt?: number; next?: number }> = []
      const subscription = yield* events.subscribe(SessionEvent.Retried).pipe(
        Stream.map((event) => retriedEvents.push({ attempt: event.data.attempt, next: event.data.next })),
        Stream.runDrain,
        Effect.forkChild,
      )

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 1) yield* Effect.yieldNow
      // The empty completion recovers with an immediate retry; no timer is involved.
      yield* Fiber.join(run)
      yield* Effect.yieldNow

      expect(requests).toHaveLength(2)
      expect(retriedEvents).toEqual([{ attempt: 1, next: expect.any(Number) }])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Retry empty completion" },
        {
          type: "assistant",
          finish: "stop",
          content: [{ type: "text", id: "text-after-empty-completion", text: "Recovered" }],
        },
      ])
      yield* Fiber.interrupt(subscription)
    }),
  )

  it.effect("does not accept an empty started assistant block as a successful provider turn", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Retry an empty started block" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-empty-started" }),
          LLMEvent.textEnd({ id: "text-empty-started" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { inputTokens: 5, outputTokens: 1 } }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        fragmentFixture("text", "text-after-empty-started", ["Recovered"]).completeEvents,
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      const recovered = (yield* session.context(sessionID)).at(-1)
      expect(recovered).toMatchObject({ type: "assistant", finish: "stop" })
      expect(
        recovered?.type === "assistant" &&
          recovered.content.some((part) => part.type === "text" && part.text === "Recovered"),
      ).toBeTrue()
    }),
  )

  it.effect("publishes a visible retry before reissuing a response-header timeout", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Recover a stalled request" }), resume: false })

      const timeout = new LLMError({
        module: "RequestExecutor",
        method: "execute",
        reason: new TransportReason({
          message: "HTTP response headers timed out",
          kind: "Timeout",
          canRetry: true,
        }),
      })
      let streamAttempts = 0
      responseStreamFactory = () => {
        streamAttempts++
        return streamAttempts === 1 ? Stream.fail(timeout) : Stream.fromIterable(contentStopResponse)
      }
      requests.length = 0

      const retriedEvents: Array<{ attempt?: number; requestCount: number }> = []
      const subscription = yield* events.subscribe(SessionEvent.Retried).pipe(
        Stream.map((event) => retriedEvents.push({ attempt: event.data.attempt, requestCount: requests.length })),
        Stream.runDrain,
        Effect.forkChild,
      )
      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 1) yield* Effect.yieldNow
      yield* TestClock.adjust(1_999)
      expect(requests).toHaveLength(1)
      yield* TestClock.adjust(1)
      yield* Fiber.join(run)

      expect(retriedEvents).toEqual([{ attempt: 1, requestCount: 1 }])
      expect(requests).toHaveLength(2)
      expect(requests.every((request) => request.http?.retries === 0)).toBe(true)
      yield* Fiber.interrupt(subscription)
    }),
  )

  it.effect("fails the activity after exhausting retries on consecutive empty completions", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Exhaust empty completions" }),
        resume: false,
      })

      requests.length = 0
      responses = Array.from({ length: 6 }, () => [] as LLMEvent[])

      const run = yield* session.resume(sessionID).pipe(Effect.flip, Effect.forkChild)
      while (requests.length < 6) yield* Effect.yieldNow
      yield* Fiber.join(run)

      expect(requests).toHaveLength(6)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Exhaust empty completions" },
        {
          type: "assistant",
          finish: "error",
          error: {
            message: "Provider returned an empty completion without usable final text or tool results",
          },
          failure: {
            code: "provider.invalid-response",
            remediation: "retry",
            cause: { detail: "empty provider completion" },
          },
        },
      ])
    }),
  )

  it.effect("honors provider retry delays before retrying transient errors", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Retry after provider delay" }), resume: false })

      requests.length = 0
      responses = [
        [LLMEvent.providerError({ message: "server_error: Try again", retryable: true, retryAfterMs: 1_234 })],
        fragmentFixture("text", "text-after-provider-delay", ["Recovered"]).completeEvents,
      ]

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 1) yield* Effect.yieldNow
      yield* TestClock.adjust(1_233)
      expect(requests).toHaveLength(1)
      yield* TestClock.adjust(1)
      yield* Fiber.join(run)

      expect(requests).toHaveLength(2)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Retry after provider delay" },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Recovered" }] },
      ])
    }),
  )

  for (const seconds of [59, 60]) {
    it.effect(`waits the complete Cerebras ${seconds}-second minute quota deadline through the actual SDK`, () =>
      Effect.gen(function* () {
        yield* setup
        const bodies: string[] = []
        const sdk = yield* Effect.promise(() =>
          createSDK({
            apiKey: "fixture-key",
            fetch: Object.assign(
              async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
                bodies.push(String(init?.body))
                if (bodies.length === 1)
                  return Response.json(
                    {
                      message: "Tokens per minute limit exceeded - too many tokens processed.",
                      type: "too_many_tokens_error",
                      param: "quota",
                      code: "token_quota_exceeded",
                    },
                    { status: 429, headers: { "retry-after": String(seconds) } },
                  )
                return new Response(
                  'data: {"id":"recovered","created":0,"model":"qwen-3.8-27b","choices":[{"index":0,"delta":{"content":"Recovered"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
                  { headers: { "content-type": "text/event-stream" } },
                )
              },
              { preconnect: fetch.preconnect },
            ),
          }),
        )
        responseStreamFactory = (request) => SessionRunnerAISDK.stream(sdk("qwen-3.8-27b"), request)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            responseStreamFactory = undefined
          }),
        )
        const retryScheduled = yield* Deferred.make<void>()
        const unsubscribe = yield* (yield* EventV2.Service).listen((event) => {
          if (event.type === SessionEvent.Retried.type) Deferred.doneUnsafe(retryScheduled, Effect.void)
          return Effect.void
        })
        yield* Effect.addFinalizer(() => unsubscribe)
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID,
          prompt: new Prompt({ text: "Recover after the minute limit" }),
          resume: false,
        })
        const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
        yield* Deferred.await(retryScheduled)
        yield* TestClock.adjust(seconds * 1000 - 1)
        expect(bodies).toHaveLength(1)
        yield* TestClock.adjust(1)
        yield* Fiber.join(run)
        expect(bodies).toHaveLength(2)
        expect(yield* session.context(sessionID)).toMatchObject([
          { type: "user", text: "Recover after the minute limit" },
          { type: "assistant", finish: "stop", content: [{ type: "text", text: "Recovered" }] },
        ])
      }),
    )
  }

  it.effect("durably fails local tools left running by a prior process before continuing", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Recover interrupted tool" }), resume: false })
      yield* SessionInput.promoteSteers((yield* Database.Service).db, events, sessionID, Number.MAX_SAFE_INTEGER)
      const assistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        timestamp: yield* DateTime.now,
        agent: "build",
        model: { id: ModelV2.ID.make("fake-model"), providerID: ProviderV2.ID.make("fake") },
      })
      yield* events.publish(SessionEvent.Tool.Input.Started, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-interrupted",
        name: "echo",
      })
      yield* events.publish(SessionEvent.Tool.Input.Ended, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-interrupted",
        text: '{"text":"stale"}',
      })
      yield* events.publish(SessionEvent.Tool.Called, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-interrupted",
        tool: "echo",
        input: { text: "stale" },
        provider: { executed: false },
      })
      requests.length = 0
      response = contentStopResponse
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Recover interrupted tool" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-interrupted",
              state: { status: "error", error: { type: "unknown", message: "Tool execution interrupted" } },
            },
          ],
        },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Done" }] },
      ])
    }),
  )

  it.effect("recovers exact settled inline Surface answers before the next provider turn without replaying a tool", () =>
    Effect.gen(function* () {
      yield* setup
      const fixture = yield* seedSurfaceRecovery()
      requests.length = 0
      yield* SessionV2.Service.use((session) => session.resume(sessionID))
      const message = (yield* SessionV2.Service.use((session) => session.context(sessionID))).find(
        (message) => message.id === fixture.assistantMessageID,
      )
      expect(message).toMatchObject({
        content: [{ type: "tool", state: { status: "completed", structured: { mode: "blocking", answers: [["Continue"]] } } }],
      })
      expect(requests).toHaveLength(1)
      expect(JSON.stringify(requests[0]?.messages)).toContain("User has answered your questions")
      expect(JSON.stringify(requests[0]?.messages)).toContain("Continue")
      expect(JSON.stringify(requests[0]?.messages)).not.toContain("Tool execution interrupted")
      expect(executions).toEqual([])
      expect(yield* (yield* Database.Service).db.select().from(QuestionTable).all()).toHaveLength(1)
      yield* SessionV2.Service.use((session) => session.resume(sessionID))
      const successes = yield* (yield* Database.Service).db
        .select()
        .from(EventTable)
        .where(eq(EventTable.type, EventV2.versionedType(SessionEvent.Tool.Success.type, 1)))
        .all()
      expect(successes).toHaveLength(1)
    }),
  )

  for (const answerSource of ["main", "recommended", null] as const)
    it.effect(`recovered Surface answers retain ${answerSource ?? "unknown legacy"} provenance`, () =>
      Effect.gen(function* () {
        yield* setup
        const fixture = yield* seedSurfaceRecovery("replied", false, false, answerSource)
        requests.length = 0
        yield* SessionV2.Service.use((session) => session.resume(sessionID))
        const history = yield* SessionV2.Service.use((session) => session.context(sessionID))
        expect(history.find((message) => message.id === fixture.assistantMessageID)).toMatchObject({
          content: [{ type: "tool", state: { status: "completed", structured: { answerSource } } }],
        })
        expect(requests).toHaveLength(1)
        const messages = JSON.stringify(requests[0]?.messages)
        expect(messages).toContain(`Answer source: ${answerSource ?? "unknown"}`)
        expect(messages).not.toContain("User has answered your questions")
        expect(executions).toEqual([])
      }),
    )

  it.live("controlled Surface reply reaches the real runner with its durable answer after a crashed waiter", () =>
    Effect.gen(function* () {
      yield* setup
      const fixture = yield* seedSurfaceRecovery("active")
      const { db } = yield* Database.Service
      const activity = yield* SessionActivity.Service
      const runner = yield* SessionRunner.Service
      const old = yield* activity.open({ sessionID, kind: "prompt", ownerID: "crashed_surface_owner", openedSeq: 0 })
      yield* db.update(SessionActivityTable).set({ lease_until: -1 }).where(eq(SessionActivityTable.id, old.id))
      yield* db.update(QuestionTable).set({ activity_id: old.id }).where(eq(QuestionTable.id, fixture.requestID))
      yield* SessionExecutionLocal.listenForControlledQuestionReplies(activity, db, (id) =>
        runner.run({ sessionID: id, force: true }),
      )
      requests.length = 0
      yield* QuestionV2.Service.use((question) =>
        question.reply({ sessionID, requestID: fixture.requestID, answers: [["Continue"]] }),
      )
      expect(yield* activity.get(old.id)).toMatchObject({ status: "interrupted", reason: "stale-lease" })
      expect(requests).toHaveLength(1)
      expect(JSON.stringify(requests[0]?.messages)).toContain("User has answered your questions")
      expect(JSON.stringify(requests[0]?.messages)).not.toContain("Tool execution interrupted")
      expect(executions).toEqual([])
      expect(yield* db.select({ state: QuestionTable.state, answers: QuestionTable.answers }).from(QuestionTable).get())
        .toEqual({ state: "replied", answers: [["Continue"]] })
    }).pipe(Effect.provide(SessionActivity.layer)),
  )

  for (const mismatch of ["rejected", "active", "queued", "session", "message", "call", "payload", "phase", "answers", "receipt", "source", "detached", "hosted", "request-tool", "request-session"] as const) {
    it.effect(`keeps ${mismatch} Surface recovery fail-closed without replaying tools or questions`, () =>
      Effect.gen(function* () {
        yield* setup
        const fixture = yield* seedSurfaceRecovery(
          mismatch === "rejected" || mismatch === "active" || mismatch === "queued" ? mismatch : "replied",
          mismatch === "source",
          mismatch === "hosted",
        )
        const { db } = yield* Database.Service
        if (mismatch === "session") {
          yield* insertSession(otherSessionID)
          yield* db.update(QuestionTable).set({ session_id: otherSessionID }).where(eq(QuestionTable.id, fixture.requestID))
        }
        if (mismatch === "message") yield* db.update(QuestionTable).set({ assistant_message_id: "msg_unrelated" }).where(eq(QuestionTable.id, fixture.requestID))
        if (mismatch === "call") yield* db.update(QuestionTable).set({ tool_call_id: "call_unrelated" }).where(eq(QuestionTable.id, fixture.requestID))
        if (mismatch === "payload" || mismatch === "phase" || mismatch === "request-tool" || mismatch === "request-session") {
          yield* db.update(QuestionTable).set({ request: {
            ...fixture.request,
            ...(mismatch === "payload" ? { questions: [{ ...fixture.info, question: "Different question?" }] } : {}),
            ...(mismatch === "phase" ? { phase: "implementation_complete_followup" as const } : {}),
            ...(mismatch === "request-tool" ? { tool: { messageID: "msg_unrelated", callID: fixture.callID } } : {}),
            ...(mismatch === "request-session" ? { sessionID: otherSessionID } : {}),
          } }).where(eq(QuestionTable.id, fixture.requestID))
        }
        if (mismatch === "answers") yield* db.update(QuestionTable).set({ answers: [] }).where(eq(QuestionTable.id, fixture.requestID))
        if (mismatch === "receipt") yield* db.update(QuestionTable).set({ receipt: null }).where(eq(QuestionTable.id, fixture.requestID))
        if (mismatch === "detached") yield* db.update(QuestionTable).set({ detached: true }).where(eq(QuestionTable.id, fixture.requestID))
        yield* SessionV2.Service.use((session) => session.resume(sessionID))
        const message = (yield* SessionV2.Service.use((session) => session.context(sessionID))).find(
          (message) => message.id === fixture.assistantMessageID,
        )
        expect(message).toMatchObject({ content: [{ type: "tool", state: { status: "error" } }] })
        expect(executions).toEqual([])
        expect(yield* db.select().from(QuestionTable).all()).toHaveLength(1)
      }),
    )
  }

  it.effect("durably fails hosted tools left running by a prior process before continuing inline", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Recover interrupted hosted tool" }),
        resume: false,
      })
      yield* SessionInput.promoteSteers((yield* Database.Service).db, events, sessionID, Number.MAX_SAFE_INTEGER)
      const assistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        timestamp: yield* DateTime.now,
        agent: "build",
        model: { id: ModelV2.ID.make("fake-model"), providerID: ProviderV2.ID.make("fake") },
      })
      yield* events.publish(SessionEvent.Tool.Input.Started, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-hosted-interrupted",
        name: "web_search",
      })
      yield* events.publish(SessionEvent.Tool.Input.Ended, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-hosted-interrupted",
        text: '{"query":"stale"}',
      })
      yield* events.publish(SessionEvent.Tool.Called, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-hosted-interrupted",
        tool: "web_search",
        input: { query: "stale" },
        provider: { executed: true, metadata: { openai: { itemId: "call-hosted-interrupted" } } },
      })
      requests.length = 0
      response = contentStopResponse
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant"])
      expect(requests[0]?.messages[1]?.content).toMatchObject([
        {
          type: "tool-call",
          id: "call-hosted-interrupted",
          providerExecuted: true,
          providerMetadata: { openai: { itemId: "call-hosted-interrupted" } },
        },
        { type: "tool-result", id: "call-hosted-interrupted", providerExecuted: true, result: { type: "error" } },
      ])
    }),
  )

  it.effect("interrupts runner continuation when permission approval is declined", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      yield* registry.register({
        declined: Tool.make({
          description: "Fail because the user declined approval",
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: () => Effect.die(new PermissionV2.DeclinedError()),
        }),
      })
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Call declined" }), resume: false })

      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "call-declined", name: "declined", input: {} }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]

      const exit = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call declined" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-declined",
              state: { status: "error", error: { message: "Tool execution interrupted" } },
            },
          ],
        },
      ])
    }),
  )

  it.effect("passes a safety correction back as a tool error and continues the agent turn", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      yield* registry.register({
        unsafeEdit: Tool.make({
          description: "Attempt a broad edit",
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: () =>
            Effect.die(new PermissionV2.CorrectedError({ feedback: "Edit only the requested localization entry" })),
        }),
      })
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Fix one translation" }), resume: false })
      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-unsafe", name: "unsafeEdit", input: {} }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-corrected" }),
          LLMEvent.textDelta({ id: "text-corrected", text: "I will edit just that entry." }),
          LLMEvent.textEnd({ id: "text-corrected" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      yield* session.resume(sessionID)
      expect(requests).toHaveLength(2)
      expect(JSON.stringify(requests[1]?.messages)).toContain("Edit only the requested localization entry")
    }),
  )

  it.effect("cancel reconciles persisted pending tool input without a controller and continues", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const execution = yield* SessionExecution.Service
      const events = yield* EventV2.Service
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Recover interrupted tool input" }),
        resume: false,
      })
      yield* SessionInput.promoteSteers((yield* Database.Service).db, events, sessionID, Number.MAX_SAFE_INTEGER)
      const assistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        timestamp: yield* DateTime.now,
        agent: "build",
        model: { id: ModelV2.ID.make("fake-model"), providerID: ProviderV2.ID.make("fake") },
      })
      yield* events.publish(SessionEvent.Tool.Input.Started, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-pending-interrupted",
        name: "echo",
      })
      requests.length = 0
      response = contentStopResponse
      expect(yield* execution.cancelTool(sessionID, "call-pending-interrupted")).toBe(true)
      yield* execution.wait(sessionID)

      expect(requests).toHaveLength(1)
      expect(executions).toEqual([])
      expect(requests[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Recover interrupted tool input" },
        { type: "assistant", content: [{ type: "tool", id: "call-pending-interrupted", state: { status: "error" } }] },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Done" }] },
      ])
      expect(yield* execution.cancelTool(sessionID, "call-pending-interrupted")).toBe(false)
    }),
  )

  it.effect("starts the first queued activity when woken while idle", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Wait for fresh activity" }),
        delivery: "queue",
        resume: false,
      })

      requests.length = 0
      const coordinator = yield* SessionRunCoordinator.Service
      yield* coordinator.wake(sessionID)
      yield* coordinator.awaitIdle(sessionID)

      expect(requests).toHaveLength(1)
      expect(userTexts(requests[0]!)).toEqual(["Wait for fresh activity"])
    }),
  )

  it.effect("owns a fresh five-attempt provider allowance for each queued activity", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "First queued task" }),
        delivery: "queue",
        resume: false,
      })
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Second queued task" }),
        delivery: "queue",
        resume: false,
      })
      requests.length = 0
      responses = ["first", "second"].flatMap(() => [
        ...Array.from({ length: 5 }, () => [
          LLMEvent.providerError({ message: "connection reset fixture", retryable: true, retryAfterMs: 0 }),
        ]),
        contentStopResponse,
      ])
      yield* session.resume(sessionID)
      expect(requests).toHaveLength(12)
      expect(userTexts(requests[5])).toEqual(["First queued task"])
      expect(userTexts(requests[11])).toEqual(["First queued task", "Second queued task"])
    }),
  )

  it.effect("does not spend one activity step budget across queued activities", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const queued = Array.from({ length: 26 }, (_, index) => `Queued activity ${index + 1}`)
      for (const text of queued) {
        yield* session.prompt({ sessionID, prompt: new Prompt({ text }), delivery: "queue", resume: false })
      }

      requests.length = 0
      responses = queued.map(() => [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-auto-stop" }),
        LLMEvent.textDelta({ id: "text-auto-stop", text: "Done" }),
        LLMEvent.textEnd({ id: "text-auto-stop" }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ])

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(queued.length)
      expect(userTexts(requests.at(-1)!)).toEqual(queued)
    }),
  )

  it.effect("retries inbox input after prompt projection rolls back", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const defect = new Error("fail after prompt promotion")
      let fail = true
      yield* events.project(SessionEvent.PromptLifecycle.Promoted, () => (fail ? Effect.die(defect) : Effect.void))
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Recover promoted input" }), resume: false })

      expect(yield* session.resume(sessionID).pipe(Effect.catchDefect(Effect.succeed))).toBe(defect)
      fail = false
      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-auto-stop" }),
        LLMEvent.textDelta({ id: "text-auto-stop", text: "Done" }),
        LLMEvent.textEnd({ id: "text-auto-stop" }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]

      yield* (yield* SessionRunCoordinator.Service).wake(sessionID)
      while (requests.length === 0) yield* Effect.yieldNow

      expect(userTexts(requests[0]!)).toEqual(["Recover promoted input"])
    }),
  )

  it.effect("does not strand a committed promotion when a post-commit listener defects", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* events.listen((event) =>
        event.type === SessionEvent.PromptLifecycle.Promoted.type
          ? Effect.die("fail after prompt promotion commits")
          : Effect.void,
      )
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Run committed promotion" }),
        resume: false,
      })

      requests.length = 0
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(userTexts(requests[0]!)).toEqual(["Run committed promotion"])
    }),
  )

  it.effect("runs different sessions concurrently", () =>
    Effect.gen(function* () {
      yield* setup
      yield* insertSession(otherSessionID)
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Run first" }), resume: false })
      yield* session.prompt({ sessionID: otherSessionID, prompt: new Prompt({ text: "Run second" }), resume: false })

      requests.length = 0
      responses = undefined
      response = contentStopResponse
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      streamStarted = yield* Deferred.make<void>()
      const second = yield* session.resume(otherSessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)

      expect(requests).toHaveLength(2)
      expect(requests.map((request) => request.providerOptions?.openai?.promptCacheKey)).toEqual([
        sessionID,
        otherSessionID,
      ])
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      streamGate = undefined
      streamStarted = undefined
    }),
  )

  it.effect("bounds external session prompt cache keys", () =>
    Effect.gen(function* () {
      yield* setup
      const externalSessionID = SessionV2.ID.fromExternal({
        namespace: "discord",
        key: "thread-one",
      })
      const otherExternalSessionID = SessionV2.ID.fromExternal({
        namespace: "discord",
        key: "thread-two",
      })
      yield* insertSession(externalSessionID)
      yield* insertSession(otherExternalSessionID)
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID: externalSessionID,
        prompt: new Prompt({ text: "Run external session" }),
        resume: false,
      })
      yield* session.prompt({
        sessionID: otherExternalSessionID,
        prompt: new Prompt({ text: "Run other external session" }),
        resume: false,
      })

      requests.length = 0
      yield* session.resume(externalSessionID)
      yield* session.resume(otherExternalSessionID)

      const keys = requests.map((request) => request.providerOptions?.openai?.promptCacheKey)
      expect(keys).toEqual([externalSessionID.slice(4), otherExternalSessionID.slice(4)])
      expect(keys.every((key) => typeof key === "string" && key.length === 64)).toBe(true)
      expect(keys[0]).not.toBe(keys[1])
    }),
  )

  it.effect("fans out one failed run and allows a later retry", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Retry after failure" }), resume: false })

      requests.length = 0
      responses = undefined
      response = contentStopResponse
      streamFailure = providerUnavailable()
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      const second = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Effect.yieldNow

      expect(requests).toHaveLength(1)
      yield* Deferred.succeed(streamGate, undefined)
      const [firstExit, secondExit] = yield* Effect.all([Fiber.await(first), Fiber.await(second)])
      expect(secondExit).toEqual(firstExit)

      streamFailure = undefined
      streamGate = undefined
      streamStarted = undefined
      yield* session.resume(sessionID)
      expect(requests).toHaveLength(2)
    }),
  )

  it.effect("durably settles local tool failures before continuing", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Call missing" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-missing", name: "missing", input: {} }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-after-error" }),
          LLMEvent.textDelta({ id: "text-after-error", text: "Recovered" }),
          LLMEvent.textEnd({ id: "text-after-error" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = undefined
      streamStarted = undefined

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call missing" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-missing",
              state: { status: "error", error: { message: "Unknown tool: missing" } },
            },
          ],
        },
        { type: "assistant", finish: "stop", content: [{ type: "text", id: "text-after-error", text: "Recovered" }] },
      ])
    }),
  )

  it.effect("returns unexpected local tool defects to the model before continuing", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Call defect" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-defect", name: "defect", input: {} }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-after-defect" }),
          LLMEvent.textDelta({ id: "text-after-defect", text: "Recovered" }),
          LLMEvent.textEnd({ id: "text-after-defect" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
      expect(requests[1]?.messages.find((message) => message.role === "tool")?.content).toContainEqual(
        expect.objectContaining({
          type: "tool-result",
          id: "call-defect",
          result: { type: "error", value: "Tool execution failed: unexpected tool defect" },
        }),
      )
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call defect" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-defect",
              state: {
                status: "error",
                error: { type: "unknown", message: "Tool execution failed: unexpected tool defect" },
              },
            },
          ],
        },
        { type: "assistant", finish: "stop", content: [{ type: "text", id: "text-after-defect", text: "Recovered" }] },
      ])
    }),
  )

  it.effect("returns recoverable local tool failures to the model before continuing", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Call failure" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-failure", name: "failure", input: {} }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-after-failure" }),
          LLMEvent.textDelta({ id: "text-after-failure", text: "Recovered" }),
          LLMEvent.textEnd({ id: "text-after-failure" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
      expect(requests[1]?.messages.find((message) => message.role === "tool")?.content).toContainEqual(
        expect.objectContaining({
          type: "tool-result",
          id: "call-failure",
          result: { type: "error", value: "patch rejected" },
        }),
      )
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call failure" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-failure",
              state: {
                status: "error",
                error: { type: "unknown", message: "patch rejected" },
              },
            },
          ],
        },
        { type: "assistant", finish: "stop", content: [{ type: "text", id: "text-after-failure", text: "Recovered" }] },
      ])
    }),
  )

  it.effect("continues after a successfully opened interactive surface", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const questions = yield* QuestionV2.Service
      yield* registerInteractiveSurfaceTool
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Open without waiting" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-question-detached",
            name: "surface",
            input: detachedQuestionInput,
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        fragmentFixture("text", "text-after-detached-question", ["Unexpected continuation"]).completeEvents,
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Open without waiting" },
        {
          type: "assistant",
          content: [{ type: "tool", id: "call-question-detached", state: { status: "completed" } }],
        },
        { type: "assistant", content: [{ type: "text", text: "Unexpected continuation" }] },
      ])
      const pending = yield* questions.list()
      expect(pending).toMatchObject([{ sessionID, mode: "interactive", surface: { controlID: "review-action" } }])
      yield* questions.reject(pending[0]!.id)
    }),
  )

  it.effect("continues a mixed tool turn that also opens an interactive surface", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const questions = yield* QuestionV2.Service
      yield* registerInteractiveSurfaceTool
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Open and continue" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-question-detached-mixed",
            name: "surface",
            input: detachedQuestionInput,
          }),
          LLMEvent.toolCall({ id: "call-echo-after-detached", name: "echo", input: { text: "continue" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        fragmentFixture("text", "text-after-detached-mixed", ["Continued"]).completeEvents,
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Open and continue" },
        {
          type: "assistant",
          content: [
            { type: "tool", id: "call-question-detached-mixed", state: { status: "completed" } },
            { type: "tool", id: "call-echo-after-detached", state: { status: "completed" } },
          ],
        },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Continued" }] },
      ])
      const pending = yield* questions.list()
      yield* questions.reject(pending[0]!.id)
    }),
  )

  it.live("records a clear blocking Surface dismissal and interrupts the runner", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      const questions = yield* QuestionV2.Service
      const { db } = yield* Database.Service
      yield* db
        .insert(SessionActivityTable)
        .values({
          id: "activity_question_runner_test",
          session_id: sessionID,
          status: "running",
          kind: "prompt",
          time_created: Date.now(),
          time_updated: Date.now(),
        })
        .run()
        .pipe(Effect.orDie)
      yield* registry.register({
        surface: Tool.make({
          description: "Ask the user",
          input: Schema.Struct({ mode: Schema.Literal("blocking") }),
          output: Schema.Struct({}),
          execute: (_, context) =>
            questions.ask({ sessionID: context.sessionID, questions: [] }).pipe(Effect.as({}), Effect.orDie),
        }),
      })
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Ask then stop" }), resume: false })

      requests.length = 0
      responseStream = Stream.fromIterable([
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "call-question", name: "surface", input: { mode: "blocking" } }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ])
      const run = yield* session.resume(sessionID).pipe(Effect.exit, Effect.forkChild)
      let pending = yield* questions.list()
      while (pending.length === 0) {
        yield* Effect.yieldNow
        pending = yield* questions.list()
      }
      yield* questions.reject(pending[0]!.id)
      const exit = yield* Fiber.join(run)

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Ask then stop" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-question",
              state: {
                status: "error",
                error: { type: "unknown", message: "The user dismissed this question" },
              },
            },
          ],
        },
      ])

      responses = [fragmentFixture("text", "text-after-question-dismiss", ["Fresh turn"]).completeEvents]
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Start cleanly after dismiss" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Ask then stop" },
        {
          type: "assistant",
          content: [{ type: "tool", id: "call-question", state: { status: "error" } }],
        },
        { type: "user", text: "Start cleanly after dismiss" },
        { type: "assistant", content: [{ type: "text", text: "Fresh turn" }] },
      ])
    }),
  )

  it.live("keeps a blocking question active after the provider stream finishes", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      const questions = yield* QuestionV2.Service
      const { db } = yield* Database.Service
      yield* db
        .insert(SessionActivityTable)
        .values({
          id: "activity_question_stream_finish_test",
          session_id: sessionID,
          status: "running",
          kind: "prompt",
          time_created: Date.now(),
          time_updated: Date.now(),
        })
        .run()
        .pipe(Effect.orDie)
      yield* registry.register({
        surface: Tool.make({
          description: "Ask the user",
          input: Schema.Struct({ mode: Schema.Literal("blocking") }),
          output: Schema.Struct({}),
          execute: (_, context) =>
            questions
              .askDurable({
                sessionID: context.sessionID,
                questions: [
                  {
                    type: "review_section",
                    header: "Review",
                    question: "Choose",
                    options: [{ label: "Later" }],
                  },
                ],
              })
              .pipe(Effect.as({}), Effect.orDie),
        }),
      })
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Ask and wait" }), resume: false })

      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-question", name: "surface", input: { mode: "blocking" } }),
        ]),
        Stream.fromEffect(Effect.interrupt),
      )
      responses = [fragmentFixture("text", "text-after-question", ["Continued"]).completeEvents]
      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      let pending = yield* questions.list()
      while (pending.length === 0) {
        yield* Effect.yieldNow
        pending = yield* questions.list()
      }

      expect(pending[0]?.id).toBeDefined()
      expect(run.pollUnsafe()).toBeUndefined()
      yield* questions.reply({ requestID: pending[0]!.id, answers: [[]] })
      yield* Fiber.join(run)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Ask and wait" },
        {
          type: "assistant",
          content: [{ type: "tool", id: "call-question", state: { status: "completed" } }],
        },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Continued" }] },
      ])
    }),
  )

  it.effect("awaits started local tools before surfacing provider stream failure", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Settle before failing" }), resume: false })
      const failure = providerUnavailable()
      toolExecutionGate = yield* Deferred.make<void>()
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-before-failure", name: "echo", input: { text: "settle" } }),
        ]),
        Stream.fail(failure),
      )

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (executions.length === 0) yield* Effect.yieldNow
      yield* Effect.yieldNow
      yield* Deferred.succeed(toolExecutionGate, undefined)
      expect(yield* Fiber.join(run).pipe(Effect.flip)).toBe(failure)
      toolExecutionGate = undefined

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Settle before failing" },
        {
          type: "assistant",
          content: [
            { type: "tool", id: "call-before-failure", state: { status: "completed", structured: { text: "settle" } } },
          ],
        },
      ])
    }),
  )

  it.effect("durably fails blocked local tools when a provider turn is interrupted", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Interrupt blocked tool" }), resume: false })
      executions.length = 0
      toolExecutionGate = yield* Deferred.make<void>()
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-before-interrupt", name: "echo", input: { text: "blocked" } }),
        ]),
        Stream.never,
      )

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (executions.length === 0) yield* Effect.yieldNow
      yield* session.interrupt(sessionID)
      toolExecutionGate = undefined

      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      yield* session.interrupt(sessionID)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Interrupt blocked tool" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-before-interrupt",
              state: { status: "error", error: { type: "unknown", message: "Tool execution interrupted" } },
            },
          ],
        },
      ])

      yield* replaySessionProjection(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Interrupt blocked tool" },
        { type: "assistant", content: [{ type: "tool", id: "call-before-interrupt", state: { status: "error" } }] },
      ])
      requests.length = 0
      responseStream = undefined
      response = contentStopResponse
      yield* session.resume(sessionID)
      expect(requests[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
    }),
  )

  it.effect("interrupts a blocked provider turn without local tool activity", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Interrupt provider" }), resume: false })
      requests.length = 0
      const fixture = fragmentFixture("text", "text-provider-interrupted", ["Partial"])
      streamStarted = yield* Deferred.make<void>()
      responseStream = Stream.concat(
        Stream.fromIterable(fixture.partialEvents),
        Stream.fromEffect(Deferred.succeed(streamStarted, undefined)).pipe(Stream.flatMap(() => Stream.never)),
      )

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.interrupt(sessionID)
      const exit = yield* Fiber.await(run)
      streamStarted = undefined

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBeTrue()
      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Interrupt provider" },
        { type: "assistant", finish: "interrupted", content: [fixture.expectedContent] },
      ])
      yield* session.interrupt(sessionID)
    }),
  )

  it.effect("durably fails blocked local tools when interrupted while awaiting settlement", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Interrupt tool settlement" }), resume: false })
      executions.length = 0
      toolExecutionGate = yield* Deferred.make<void>()
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "call-await-interrupt", name: "echo", input: { text: "blocked" } }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]

      const runner = yield* SessionRunner.Service
      const run = yield* runner.run({ sessionID, force: true }).pipe(Effect.forkChild)
      while (executions.length === 0) yield* Effect.yieldNow
      yield* Fiber.interrupt(run)
      toolExecutionGate = undefined

      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Interrupt tool settlement" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-await-interrupt",
              state: { status: "error", error: { type: "unknown", message: "Tool execution interrupted" } },
            },
          ],
        },
      ])
    }),
  )

  it.effect("continues past 25 local tool turns when the agent has no configured step limit", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Complete a long task" }), resume: false })

      requests.length = 0
      authorizations.length = 0
      executions.length = 0
      streamGate = undefined
      streamStarted = undefined
      responses = [
        ...Array.from({ length: 25 }, (_, index) => [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: `call-long-${index}`, name: "echo", input: { text: `${index}` } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ]),
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-long-complete" }),
          LLMEvent.textDelta({ id: "text-long-complete", text: "Done" }),
          LLMEvent.textEnd({ id: "text-long-complete" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(26)
      expect(executions).toHaveLength(25)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Complete a long task" },
        ...Array.from({ length: 25 }, () => ({ type: "assistant" })),
        { type: "assistant", content: [{ type: "text", text: "Done" }] },
      ])
    }),
  )

  it.effect("forces a text-only response after the configured number of local tool continuation steps", () =>
    Effect.gen(function* () {
      yield* setup
      yield* setBuildAgentSteps(25)
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Loop forever" }), resume: false })

      requests.length = 0
      authorizations.length = 0
      executions.length = 0
      streamGate = undefined
      streamStarted = undefined
      responses = [
        ...Array.from({ length: 25 }, (_, index) => [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: `call-echo-${index}`, name: "echo", input: { text: `${index}` } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ]),
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-limit-summary" }),
          LLMEvent.textDelta({ id: "text-limit-summary", text: "Final answer from gathered evidence" }),
          LLMEvent.textEnd({ id: "text-limit-summary" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(26)
      expect(executions).toHaveLength(25)
      expect(requests[25]?.tools).toEqual([])
    }),
  )

  for (const missingStructured of [false, true]) {
    it.effect(
      `review regression: final lane fails ${missingStructured ? "a missing structured answer" : "a forbidden tool without execution"}`,
      () =>
        Effect.gen(function* () {
          yield* setup
          yield* setBuildAgentSteps(1)
          const session = yield* SessionV2.Service
          yield* session.prompt({
            sessionID,
            prompt: new Prompt({
              text: "One tool then a final answer",
              ...(missingStructured
                ? {
                    format: {
                      type: "json_schema" as const,
                      schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
                      retryCount: 0,
                    },
                  }
                : {}),
            }),
            resume: false,
          })
          requests.length = 0
          responses = [
            localToolTurn("first", { text: "allowed" }),
            missingStructured ? contentStopResponse : localToolTurn("forbidden", { text: "must not execute" }),
          ]
          const exit = yield* session.resume(sessionID).pipe(Effect.exit)
          expect(exit._tag).toBe("Failure")
          expect(requests).toHaveLength(2)
          expect(executions).toEqual(["allowed"])
        }),
    )
  }

  it.effect("keeps only StructuredOutput available on the final bounded provider turn", () =>
    Effect.gen(function* () {
      yield* setup
      yield* setBuildAgentSteps(1)
      const session = yield* SessionV2.Service
      const schema = {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
        additionalProperties: false,
      }
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Inspect once, then answer", format: { type: "json_schema", schema } }),
        resume: false,
      })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-bounded-echo", name: "echo", input: { text: "evidence" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-bounded-structured", name: "StructuredOutput", input: { answer: "done" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(requests[1]?.tools.map((tool) => tool.name)).toEqual(["StructuredOutput"])
      expect(requests[1]?.toolChoice).toMatchObject({ type: "required" })
      expect((yield* session.context(sessionID)).findLast((message) => message.type === "assistant")).toMatchObject({
        structured: { answer: "done" },
      })
    }),
  )

  it.effect("fails malformed StructuredOutput on the final bounded provider turn when correction is disabled", () =>
    Effect.gen(function* () {
      yield* setup
      yield* setBuildAgentSteps(1)
      const session = yield* SessionV2.Service
      const schema = {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
        additionalProperties: false,
      }
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Inspect once, then answer", format: { type: "json_schema", schema, retryCount: 0 } }),
        resume: false,
      })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-bounded-echo", name: "echo", input: { text: "evidence" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-bounded-structured-invalid",
            name: "StructuredOutput",
            input: { answer: 42 },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
      ]

      const failure = yield* session.resume(sessionID).pipe(Effect.flip)
      expect(failure).toBeInstanceOf(LLMError)
      expect(failure).toMatchObject({
        reason: { kind: "invalid-tool-input", canRetry: false },
      })
      expect(requests).toHaveLength(2)
      const assistant = (yield* session.context(sessionID)).findLast(
        (message): message is SessionMessage.Assistant => message.type === "assistant",
      )
      expect(assistant?.finish).toBe("error")
      expect(assistant?.structured).toBeUndefined()
    }),
  )

  it.effect("does not restart a capped tool loop for a coalesced stale wake", () =>
    Effect.gen(function* () {
      yield* setup
      yield* setBuildAgentSteps(25)
      const session = yield* SessionV2.Service
      const coordinator = yield* SessionRunCoordinator.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Loop forever" }), resume: false })

      requests.length = 0
      responses = [
        ...Array.from({ length: 25 }, (_, index) => [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: `call-capped-${index}`, name: "echo", input: { text: `${index}` } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ]),
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-capped-summary" }),
          LLMEvent.textDelta({ id: "text-capped-summary", text: "Final answer" }),
          LLMEvent.textEnd({ id: "text-capped-summary" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* coordinator.wake(sessionID)
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(run)
      streamGate = undefined
      streamStarted = undefined
      yield* Effect.yieldNow

      expect(requests).toHaveLength(26)
    }),
  )

  it.effect("accepts a terminal response on the final bounded provider turn", () =>
    Effect.gen(function* () {
      yield* setup
      yield* setBuildAgentSteps(25)
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Finish at the limit" }), resume: false })

      requests.length = 0
      responses = [
        ...Array.from({ length: 24 }, (_, index) => [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: `call-terminal-${index}`, name: "echo", input: { text: `${index}` } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ]),
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-auto-stop" }),
          LLMEvent.textDelta({ id: "text-auto-stop", text: "Done" }),
          LLMEvent.textEnd({ id: "text-auto-stop" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(25)
    }),
  )

  it.effect("projects provider errors as terminal assistant step failures", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Fail durably" }), resume: false })

      requests.length = 0
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [LLMEvent.stepStart({ index: 0 }), LLMEvent.providerError({ message: "Provider unavailable" })]

      const exit = yield* session.resume(sessionID).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail durably" },
        { type: "assistant", finish: "error", error: { type: "unknown", message: "Provider unavailable" } },
      ])
    }),
  )

  it.effect("projects provider errors emitted before assistant step start", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Fail before step" }), resume: false })

      requests.length = 0
      response = [LLMEvent.providerError({ message: "Provider unavailable" })]

      const exit = yield* session.resume(sessionID).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail before step" },
        { type: "assistant", finish: "error", error: { type: "unknown", message: "Provider unavailable" } },
      ])
    }),
  )

  it.effect("does not recover context overflow after durable assistant output", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Fail after output" }), resume: false })

      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-partial" }),
        LLMEvent.textDelta({ id: "text-partial", text: "Partial" }),
        LLMEvent.textEnd({ id: "text-partial" }),
        LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
      ]
      const exit = yield* session.resume(sessionID).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail after output" },
        {
          type: "assistant",
          finish: "error",
          error: { message: "prompt too long" },
          failure: { code: "provider.context-overflow", retryability: "resume" },
          content: [{ type: "text", text: "Partial" }],
        },
      ])
    }),
  )

  it.effect("projects raw provider stream failures as terminal assistant step failures", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Fail raw stream durably" }), resume: false })
      const failure = providerUnavailable()
      responseStream = Stream.fail(failure)

      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(failure)
      yield* replaySessionProjection(sessionID)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail raw stream durably" },
        { type: "assistant", finish: "error", error: { type: "unknown", message: "Provider unavailable" } },
      ])
    }),
  )

  it.effect("prefers raw provider failures over synthetic retry exhaustion errors", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Fail with the authoritative error" }),
        resume: false,
      })
      const failure = new LLMError({
        module: "test",
        method: "stream",
        reason: new RateLimitReason({
          message: "Provider request failed with HTTP 429: quota exhausted",
          retryAfterMs: 0,
        }),
      })
      responseStreamFactory = () =>
        Stream.concat(
          Stream.make(
            LLMEvent.providerError({
              message: "OpenAI Chat stream ended without a finish reason",
              retryable: true,
            }),
          ),
          Stream.fail(failure),
        )
      requests.length = 0

      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(failure)
      yield* replaySessionProjection(sessionID)
      // One request plus every throttle retry: a short-term 429 keeps the
      // patient rate-limit budget until the raw failure settles the activity.
      expect(requests).toHaveLength(1 + SessionResume.THROTTLE_RETRY_ATTEMPTS)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail with the authoritative error" },
        {
          type: "assistant",
          finish: "error",
          error: { type: "unknown", message: "Provider request failed with HTTP 429: quota exhausted" },
        },
      ])
    }),
  )

  it.effect("continues in a fresh provider turn after a retryable error follows a local tool call", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Continue failed provider safely" }),
        resume: false,
      })

      requests.length = 0
      const executionCount = executions.length
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-before-provider-error", name: "echo", input: { text: "settled" } }),
          LLMEvent.providerError({ message: "Provider unavailable", retryable: true, retryAfterMs: 0 }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-after-retryable-error" }),
          LLMEvent.textDelta({ id: "text-after-retryable-error", text: "Recovered" }),
          LLMEvent.textEnd({ id: "text-after-retryable-error" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(executions.slice(executionCount)).toEqual(["settled"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Continue failed provider safely" },
        { type: "assistant", finish: "error", content: [{ type: "tool", id: "call-before-provider-error" }] },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Recovered" }] },
      ])
    }),
  )

  it.live("recovers a stalled provider after a local tool call without replaying the tool", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Continue after a stalled provider" }),
        resume: false,
      })

      const stalled = new LLMError({
        module: "SessionRunner",
        method: "runProviderStream",
        reason: new TransportReason({
          message: "Provider stream stalled: no meaningful events for 60 seconds",
          kind: "stream-inactivity",
          canRetry: true,
        }),
      })
      const executionCount = executions.length
      let attempt = 0
      requests.length = 0
      responseStreamFactory = () => {
        attempt++
        if (attempt === 1)
          return Stream.concat(
            Stream.fromIterable([
              LLMEvent.stepStart({ index: 0 }),
              LLMEvent.toolCall({ id: "call-before-provider-stall", name: "echo", input: { text: "settled" } }),
            ]),
            Stream.fail(stalled),
          )
        return Stream.fromIterable(fragmentFixture("text", "text-after-provider-stall", ["Recovered"]).completeEvents)
      }

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(executions.slice(executionCount)).toEqual(["settled"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Continue after a stalled provider" },
        { type: "assistant", finish: "error", content: [{ type: "tool", id: "call-before-provider-stall" }] },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Recovered" }] },
      ])
    }),
  )

  it.effect(
    "review regression: a published terminal error never retries into the same failed publisher after a raw read failure",
    () =>
      Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        yield* session.prompt({ sessionID, prompt: new Prompt({ text: "No false completion" }), resume: false })
        requests.length = 0
        responseStream = Stream.concat(
          Stream.succeed(LLMEvent.providerError({ message: "invalid_api_key", retryable: false })),
          Stream.fail(
            new LLMError({
              module: "fixture",
              method: "stream",
              reason: new TransportReason({ message: "genuine raw read failure", kind: "read", canRetry: true }),
            }),
          ),
        )
        response = contentStopResponse
        const exit = yield* session.resume(sessionID).pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
        expect(requests).toHaveLength(1)
      }),
  )

  it.effect("review regression: terminal event flags cannot advertise retryable auth", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Keep auth terminal" }), resume: false })
      response = [LLMEvent.providerError({ message: "invalid_api_key", retryable: true })]
      const failure = yield* session.resume(sessionID).pipe(Effect.flip)
      expect(failure).toMatchObject({ reason: { canRetry: false } })
    }),
  )

  for (const schemaFailure of [true, false]) {
    it.effect(
      `review regression: capability activation cannot bypass ${schemaFailure ? "schema rejection" : "terminal provider failure"}`,
      () =>
        Effect.gen(function* () {
          yield* setup
          capabilitySkillEnabled = true
          const session = yield* SessionV2.Service
          yield* session.prompt({
            sessionID,
            prompt: new Prompt({
              text: "Activate once without rescuing failures",
              ...(schemaFailure
                ? {
                    format: {
                      type: "json_schema" as const,
                      schema: {
                        type: "object",
                        properties: { findings: { type: "array", items: { type: "string" } } },
                        required: ["findings"],
                      },
                    },
                  }
                : {}),
            }),
            resume: false,
          })
          requests.length = 0
          responses = [
            [
              LLMEvent.stepStart({ index: 0 }),
              LLMEvent.toolCall({ id: "call_skill_once", name: "skill", input: { name: "computer-use" } }),
              schemaFailure
                ? LLMEvent.toolCall({ id: "call_invalid", name: "StructuredOutput", input: { findings: "invalid" } })
                : LLMEvent.providerError({ message: "invalid_api_key", retryable: false }),
              LLMEvent.finish({ reason: "tool-calls" }),
            ],
            contentStopResponse,
          ]
          const exit = yield* session.resume(sessionID).pipe(Effect.exit)
          expect(exit._tag).toBe("Failure")
          expect(requests).toHaveLength(1)
          const tools = (yield* session.context(sessionID)).flatMap((message) =>
            message.type === "assistant"
              ? message.content.filter(
                  (part) => part.type === "tool" && part.name === "skill" && part.state.status === "completed",
                )
              : [],
          )
          expect(tools).toHaveLength(1)
        }),
    )
  }

  for (const message of ["invalid_api_key", "insufficient_quota"]) {
    it.effect(`retains terminal ${message} evidence when provider cleanup aborts`, () =>
      Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID,
          prompt: new Prompt({ text: "Do not retry terminal rejection" }),
          resume: false,
        })
        requests.length = 0
        responseStream = Stream.fromIterable([LLMEvent.providerError({ message, retryable: false })]).pipe(
          Stream.ensuring(
            Effect.sync(() => {
              const controller = new AbortController()
              controller.abort()
              controller.signal.throwIfAborted()
            }),
          ),
        )
        response = contentStopResponse
        const exit = yield* session.resume(sessionID).pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") expect(Cause.pretty(exit.cause)).toContain(message)
        expect(requests).toHaveLength(1)
      }),
    )
  }

  it.effect("shares one recovery budget across request retries, partial failures and successful tool turns", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Recover with one activity budget" }),
        resume: false,
      })
      requests.length = 0
      const retried: number[] = []
      const events = yield* EventV2.Service
      const unsubscribe = yield* events.listen((event) => {
        if (event.type === SessionEvent.Retried.type) retried.push((event.data as { attempt: number }).attempt)
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsubscribe)
      const failure = LLMEvent.providerError({ message: "connection reset", retryable: true, retryAfterMs: 0 })
      const partial = (id: string) => [...fragmentFixture("text", id, ["Partial"]).partialEvents, failure]
      responses = [
        [failure],
        [failure],
        partial("budget-before-tool"),
        localToolTurn("call-budget-once", { text: "executed once" }),
        partial("budget-after-tool"),
        [failure],
        partial("budget-exhausted"),
        contentStopResponse,
      ]
      const exit = yield* session.resume(sessionID).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      expect(requests).toHaveLength(7)
      expect(retried).toEqual([1, 2, 3, 4, 5])
      expect(executions).toEqual(["executed once"])
    }),
  )

  it.effect("bounds fresh-turn recovery after repeated partial retryable failures", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Bound partial stream recovery" }), resume: false })

      requests.length = 0
      responses = Array.from({ length: 6 }, (_, index) => [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: `text-partial-${index}` }),
        LLMEvent.textDelta({ id: `text-partial-${index}`, text: `Partial ${index}` }),
        LLMEvent.textEnd({ id: `text-partial-${index}` }),
        LLMEvent.providerError({ message: "Provider unavailable", retryable: true, retryAfterMs: 0 }),
      ])

      const exit = yield* session.resume(sessionID).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")

      expect(requests).toHaveLength(6)
      expect((yield* session.context(sessionID)).filter((message) => message.type === "assistant")).toHaveLength(6)
    }),
  )

  it.live("retries a transport error from a separately bundled provider", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Recover foreign transport error" }),
        resume: false,
      })

      requests.length = 0
      // Provider plugins can bundle their own copy of @opencode-ai/llm.
      const foreign = Object.assign(new Error("HTTP transport failed"), {
        _tag: "LLM.Error",
        module: "RouteClient",
        method: "stream",
        reason: { _tag: "Transport", message: "HTTP transport failed", canRetry: true },
      }) as unknown as LLMError
      responseStream = Stream.fail(foreign)
      response = fragmentFixture("text", "text-after-foreign-error", ["Recovered"]).completeEvents

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Recover foreign transport error" },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Recovered" }] },
      ])
    }),
  )

  for (const code of [1302, 1308, 1310]) {
    it.live(`handles native Z.AI HTTP 429 code ${code} on the selected direct model`, () =>
      Effect.gen(function* () {
        yield* setup
        const native = yield* Effect.service(LLMClient.Service).pipe(
          Effect.provide(LLMClient.layer.pipe(Layer.provide(RequestExecutor.defaultLayer))),
        )
        let requestsOnWire = 0
        const server = yield* Effect.acquireRelease(
          Effect.sync(() => Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
            if (++requestsOnWire > 1) {
              return new Response(
                'data: {"id":"chat","model":"glm-5.4","created":0,"choices":[{"index":0,"delta":{"content":"Recovered"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
                { headers: { "content-type": "text/event-stream" } },
              )
            }
            // The business code must win over the generic quota wording used by some gateways.
            return Response.json({ error: { code: String(code), message: code === 1302 ? "Request rate quota reached" : "Usage limit reached" } }, {
              status: 429, headers: { "retry-after": "0" },
            })
          } })),
          (server) => Effect.promise(() => server.stop(true)),
        )
        currentModel = Model.make({
          id: "glm-5.4", provider: "zhipuai-coding-plan",
          route: OpenAIChat.route.with({ endpoint: { baseURL: `http://127.0.0.1:${server.port}` } }),
        })
        const observed: Array<{ type: string; data: unknown }> = []
        const events = yield* EventV2.Service
        const unsubscribe = yield* events.listen((event) => Effect.sync(() => { observed.push(event) }))
        yield* Effect.addFinalizer(() => unsubscribe)
        responseStreamFactory = (request) => native.stream(request)
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID, prompt: new Prompt({ text: "Answer on this model" }), resume: false,
          model: ModelV2.Ref.make({ id: ModelV2.ID.make("glm-5.4"), providerID: ProviderV2.ID.make("zhipuai-coding-plan") }),
        })
        const result = yield* session.resume(sessionID).pipe(Effect.exit)
        const retries = observed.filter((event) => event.type === SessionEvent.Retried.type)
        if (code === 1302) {
          expect(result._tag).toBe("Success")
          expect(requestsOnWire).toBe(2)
          expect(retries).toMatchObject([{ data: {
            attempt: 1, provider: "zhipuai-coding-plan", code: "provider.rate-limit",
            error: { statusCode: 429, responseBody: expect.stringContaining("1302") },
          } }])
          expect((yield* session.context(sessionID)).slice(-2)).toMatchObject([
            { type: "user" }, { type: "assistant", finish: "stop", content: [{ type: "text", text: "Recovered" }] },
          ])
          return
        }
        expect(result._tag).toBe("Failure")
        expect(requestsOnWire).toBe(1)
        expect(retries).toEqual([])
        expect(observed.filter((event) => event.type === SessionEvent.Step.Failed.type)).toMatchObject([{ data: {
          failure: {
            code: "provider.rate-limit", retryability: "none", httpStatus: 429,
            providerRef: "zhipuai-coding-plan/glm-5.4", cause: { raw: expect.stringContaining(String(code)) },
          },
        } }])
      }),
    )
  }

  it.live("continues a partial raw transport failure without replaying the failed request", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Recover partial HTTP stream" }), resume: false })

      requests.length = 0
      const fixture = fragmentFixture("text", "text-partial-transport", ["Partial"])
      responseStream = Stream.concat(
        Stream.fromIterable([...fixture.partialEvents, LLMEvent.textEnd({ id: "text-partial-transport" })]),
        Stream.fail(providerUnavailable(true)),
      )
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-after-transport-recovery" }),
        LLMEvent.textDelta({ id: "text-after-transport-recovery", text: "Recovered" }),
        LLMEvent.textEnd({ id: "text-after-transport-recovery" }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Recover partial HTTP stream" },
        { type: "assistant", finish: "error", content: [{ type: "text", text: "Partial" }] },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Recovered" }] },
      ])
    }),
  )

  it.effect("continues after a provider-executed tool returns an error", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Retry failed hosted patch" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-hosted-server-error",
            name: "local_shell",
            input: { command: "apply patch" },
            providerExecuted: true,
          }),
          LLMEvent.toolResult({
            id: "call-hosted-server-error",
            name: "local_shell",
            result: { type: "error", value: { code: "server_error", message: "Try again" } },
            providerExecuted: true,
          }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-after-hosted-error" }),
          LLMEvent.textDelta({ id: "text-after-hosted-error", text: "Recovered" }),
          LLMEvent.textEnd({ id: "text-after-hosted-error" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant"])
      expect(requests[1]?.messages.find((message) => message.role === "assistant")?.content).toContainEqual(
        expect.objectContaining({
          type: "tool-result",
          id: "call-hosted-server-error",
          result: { type: "error", value: { code: "server_error", message: "Try again" } },
          providerExecuted: true,
        }),
      )
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Retry failed hosted patch" },
        {
          type: "assistant",
          content: [{ type: "tool", id: "call-hosted-server-error", state: { status: "error" } }],
        },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Recovered" }] },
      ])
    }),
  )

  it.effect("durably fails a hosted tool when its provider errors before returning a result", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Fail hosted tool durably" }), resume: false })

      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({
          id: "call-hosted-provider-error",
          name: "web_search",
          input: { query: "effect" },
          providerExecuted: true,
        }),
        LLMEvent.providerError({ message: "Provider unavailable" }),
      ]

      expect(yield* session.resume(sessionID).pipe(Effect.exit)).toMatchObject({ _tag: "Failure" })

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail hosted tool durably" },
        {
          type: "assistant",
          content: [{ type: "tool", id: "call-hosted-provider-error", state: { status: "error" } }],
        },
      ])
    }),
  )

  it.live("durably fails a hosted tool left unresolved at normal provider EOF and recovers in a fresh turn", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Fail hosted tool at EOF" }), resume: false })
      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-hosted-eof",
            name: "web_search",
            input: { query: "effect" },
            providerExecuted: true,
          }),
        ],
        contentStopResponse,
      ]

      yield* session.resume(sessionID)
      yield* replaySessionProjection(sessionID)
      expect(requests).toHaveLength(2)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail hosted tool at EOF" },
        {
          type: "assistant",
          finish: "error",
          content: [{ type: "tool", id: "call-hosted-eof", state: { status: "error" } }],
        },
        { type: "assistant", finish: "stop" },
      ])
    }),
  )

  it.effect("durably fails a hosted tool left unresolved by a raw provider stream failure", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Fail hosted tool on raw failure" }),
        resume: false,
      })
      const failure = providerUnavailable()
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-hosted-raw-failure",
            name: "web_search",
            input: { query: "effect" },
            providerExecuted: true,
          }),
        ]),
        Stream.fail(failure),
      )

      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(failure)
      yield* replaySessionProjection(sessionID)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail hosted tool on raw failure" },
        {
          type: "assistant",
          finish: "error",
          error: { type: "unknown", message: "Provider unavailable" },
          content: [{ type: "tool", id: "call-hosted-raw-failure", state: { status: "error" } }],
        },
      ])
    }),
  )

  it.effect("keeps interleaved assistant text blocks separate", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Two blocks" }), resume: false })

      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-1" }),
        LLMEvent.textStart({ id: "text-2" }),
        LLMEvent.textDelta({ id: "text-1", text: "First" }),
        LLMEvent.textDelta({ id: "text-2", text: "Second" }),
        LLMEvent.textEnd({ id: "text-1" }),
        LLMEvent.textEnd({ id: "text-2" }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]

      yield* session.resume(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Two blocks" },
        {
          type: "assistant",
          content: [
            { type: "text", id: "text-1", text: "First" },
            { type: "text", id: "text-2", text: "Second" },
          ],
        },
      ])
    }),
  )

  for (const kind of fragmentKinds) {
    it.effect(`broadcasts provider ${kind} deltas without storing projection rewrites`, () =>
      verifyEphemeralDeltas(kind),
    )

    it.effect(`durably closes partial ${kind} when the provider stream fails`, () => verifyPartialFlushOnFailure(kind))

    it.effect(`durably closes partial ${kind} when the provider stream is interrupted`, () =>
      verifyPartialFlushOnInterruption(kind),
    )
  }

  it.effect("rejects duplicate streamed text starts", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [LLMEvent.textStart({ id: "text-1" }), LLMEvent.textStart({ id: "text-1" })]

      expect(yield* session.resume(sessionID).pipe(Effect.catchDefect(Effect.succeed))).toBe(
        "Duplicate text start: text-1",
      )
    }),
  )

  for (const [kind, raw] of [
    ["empty", ""],
    ["invalid JSON", "{"],
  ] as const) {
    it.effect(`terminalizes ${kind} streamed tool input and continues`, () =>
      Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        yield* session.prompt({ sessionID, prompt: new Prompt({ text: `Recover ${kind} tool input` }), resume: false })

        requests.length = 0
        responses = [
          [
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.toolInputStart({ id: `call-${kind}`, name: "echo" }),
            ...(raw === "" ? [] : [LLMEvent.toolInputDelta({ id: `call-${kind}`, name: "echo", text: raw })]),
            LLMEvent.toolInputEnd({ id: `call-${kind}`, name: "echo" }),
            LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
            LLMEvent.finish({ reason: "tool-calls" }),
          ],
          contentStopResponse,
        ]

        yield* session.resume(sessionID)

        expect(requests).toHaveLength(2)
        expect(executions).toEqual([])
        expect(yield* session.context(sessionID)).toMatchObject([
          { type: "user", text: `Recover ${kind} tool input` },
          {
            type: "assistant",
            finish: "tool-calls",
            content: [
              {
                type: "tool",
                id: `call-${kind}`,
                state: {
                  status: "error",
                  error: { message: "Provider stream ended before completing the tool call" },
                },
              },
            ],
          },
          { type: "assistant", finish: "stop", content: [{ type: "text", text: "Done" }] },
        ])
      }),
    )
  }

  it.effect("transitions streamed raw tool input to parsed called input", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Call provider tool" }), resume: false })

      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id: "call-parsed", name: "web_search" }),
        LLMEvent.toolInputDelta({ id: "call-parsed", name: "web_search", text: '{"query":"hello"}' }),
        LLMEvent.toolInputEnd({ id: "call-parsed", name: "web_search" }),
        LLMEvent.toolCall({ id: "call-parsed", name: "web_search", input: { query: "hello" }, providerExecuted: true }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]

      yield* session.resume(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call provider tool" },
        {
          type: "assistant",
          content: [{ type: "tool", id: "call-parsed", state: { status: "error", input: { query: "hello" } } }],
        },
      ])
    }),
  )

  it.effect("stream completion contract: content filtering fails the drain while retaining usage", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Keep the filter terminal" }), resume: false })
      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.stepFinish({
          index: 0,
          reason: "content-filter",
          usage: { inputTokens: 4, nonCachedInputTokens: 4, outputTokens: 0 },
        }),
        LLMEvent.finish({ reason: "content-filter" }),
      ]
      const exit = yield* session.resume(sessionID).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user" },
        {
          type: "assistant",
          finish: "error",
          failure: { code: "provider.content-policy" },
          tokens: { input: 4, output: 0 },
        },
      ])
    }),
  )

  it.effect("stream completion contract: an explicit error finish fails without an extra request", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Report explicit provider failure" }),
        resume: false,
      })
      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "explicit-error" }),
        LLMEvent.textDelta({ id: "explicit-error", text: "Partial" }),
        LLMEvent.textEnd({ id: "explicit-error" }),
        LLMEvent.stepFinish({
          index: 0,
          reason: "error",
          usage: { inputTokens: 4, nonCachedInputTokens: 4, outputTokens: 1 },
        }),
        LLMEvent.finish({ reason: "error" }),
      ]
      const failure = yield* session.resume(sessionID).pipe(Effect.flip)
      expect(failure).toMatchObject({ reason: { _tag: "InvalidProviderOutput" } })
      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user" },
        {
          type: "assistant",
          finish: "error",
          failure: { code: "provider.invalid-response" },
          tokens: { input: 4, output: 1 },
          content: [{ type: "text", text: "Partial" }],
        },
      ])
    }),
  )

  it.effect("stream completion contract: an empty explicit error finish never retries", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Retain an empty terminal provider failure" }),
        resume: false,
      })
      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.stepFinish({ index: 0, reason: "error" }),
        LLMEvent.finish({ reason: "error" }),
      ]
      const failure = yield* session.resume(sessionID).pipe(Effect.flip)
      expect(failure).toMatchObject({ reason: { _tag: "InvalidProviderOutput" } })
      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user" },
        { type: "assistant", finish: "error", failure: { code: "provider.invalid-response" } },
      ])
    }),
  )

  it.live("stream completion contract: a filter finish retains precedence over a cleanup abort", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Keep filter failure after cleanup" }),
        resume: false,
      })
      requests.length = 0
      responseStream = Stream.fromIterable([
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.stepFinish({
          index: 0,
          reason: "content-filter",
          usage: { inputTokens: 4, nonCachedInputTokens: 4, outputTokens: 0 },
        }),
        LLMEvent.finish({ reason: "content-filter" }),
      ]).pipe(
        Stream.ensuring(
          Effect.sync(() => {
            throw new DOMException("cleanup aborted", "AbortError")
          }),
        ),
      )
      const failure = yield* session.resume(sessionID).pipe(Effect.flip)
      expect(failure).toMatchObject({ reason: { _tag: "ContentPolicy" } })
      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user" },
        {
          type: "assistant",
          finish: "error",
          failure: { code: "provider.content-policy" },
          tokens: { input: 4, output: 0 },
        },
      ])
    }),
  )

  for (const kind of ["text", "reasoning", "tool"] as const) {
    it.live(`stream completion contract: unfinished ${kind} EOF recovers from fresh history without replay`, () =>
      Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        yield* session.prompt({ sessionID, prompt: new Prompt({ text: `Complete ${kind} EOF` }), resume: false })
        requests.length = 0
        responses = [
          kind === "tool"
            ? [
                LLMEvent.stepStart({ index: 0 }),
                LLMEvent.toolCall({ id: "call-eof-once", name: "echo", input: { text: "executed once" } }),
              ]
            : fragmentFixture(kind, "fragment-eof", ["Partial"]).partialEvents,
          contentStopResponse,
        ]
        yield* session.resume(sessionID)
        expect(requests).toHaveLength(2)
        expect(executions).toEqual(kind === "tool" ? ["executed once"] : [])
        const context = yield* session.context(sessionID)
        expect(context).toMatchObject([
          { type: "user" },
          { type: "assistant", finish: "error" },
          { type: "assistant", finish: "stop" },
        ])
        expect(JSON.stringify(requests[1].messages)).toContain(kind === "tool" ? "executed once" : "Partial")
      }),
    )
  }

  for (const finish of ["length", "unknown"] as const) {
    it.live(
      `stream completion contract: ${finish} finish recovers from durable output and preserves completed tools`,
      () =>
        Effect.gen(function* () {
          yield* setup
          const session = yield* SessionV2.Service
          yield* session.prompt({
            sessionID,
            prompt: new Prompt({ text: `Complete ${finish} response` }),
            resume: false,
          })
          requests.length = 0
          responses = [
            localToolTurn("call-before-incomplete", { text: "executed once" }),
            fragmentFixture("text", "incomplete-finish", ["Partial"]).completeEvents.map((event) =>
              event.type === "step-finish"
                ? LLMEvent.stepFinish({
                    ...event,
                    reason: finish,
                    usage: { inputTokens: 4, nonCachedInputTokens: 4, outputTokens: 1 },
                  })
                : event.type === "finish"
                  ? LLMEvent.finish({ ...event, reason: finish })
                  : event,
            ),
            contentStopResponse,
          ]
          yield* session.resume(sessionID)
          expect(requests).toHaveLength(3)
          expect(executions).toEqual(["executed once"])
          expect(JSON.stringify(requests[2].messages)).toContain("executed once")
          expect(JSON.stringify(requests[2].messages)).toContain("Partial")
          expect(yield* session.context(sessionID)).toMatchObject([
            { type: "user" },
            { type: "assistant", finish: "tool-calls" },
            {
              type: "assistant",
              finish: "error",
              failure: { code: "provider.invalid-response" },
              tokens: { input: 4, output: 1 },
            },
            { type: "assistant", finish: "stop" },
          ])
        }),
    )
  }

  it.live("stream completion contract: a pending before hook preserves its announced local tool", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const plugin = yield* PluginV2.Service
      const hookEntered = yield* Deferred.make<void>()
      const releaseHook = yield* Deferred.make<void>()
      const providerEnded = yield* Deferred.make<void>()
      const pluginID = PluginV2.ID.make("delayed-local-tool-hook")
      yield* plugin.add({
        id: pluginID,
        effect: Effect.succeed({
          "tool.execute.before": Effect.fn(function* (event) {
            if (event.tool !== "echo") return
            yield* Deferred.succeed(hookEntered, undefined)
            yield* Deferred.await(releaseHook)
          }),
        }),
      })
      yield* Effect.addFinalizer(() =>
        Deferred.succeed(releaseHook, undefined).pipe(Effect.andThen(plugin.remove(pluginID))),
      )
      const ended: unknown[] = []
      const failed: unknown[] = []
      const retried: unknown[] = []
      const events = yield* EventV2.Service
      const unsubscribe = yield* events.listen((event) => {
        if (event.type === SessionEvent.Step.Ended.type) ended.push(event.data)
        if (event.type === SessionEvent.Step.Failed.type) failed.push(event.data)
        if (event.type === SessionEvent.Retried.type) retried.push(event.data)
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsubscribe)
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Complete the announced tool despite its pending hook" }),
        resume: false,
      })
      requests.length = 0
      responseStream = Stream.fromIterable([
        ...fragmentFixture("reasoning", "pending-hook-thinking", ["Preparing the tool"]).partialEvents,
        LLMEvent.toolCall({ id: "pending-hook-tool", name: "echo", input: { text: "executed once" } }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]).pipe(Stream.ensuring(Deferred.succeed(providerEnded, undefined)))
      response = contentStopResponse
      const run = yield* session.resume(sessionID).pipe(Effect.exit, Effect.forkChild)
      yield* Deferred.await(hookEntered)
      yield* Deferred.await(providerEnded)
      for (let turn = 0; turn < 10; turn++) yield* Effect.yieldNow
      expect(ended).toHaveLength(0)
      yield* Deferred.succeed(releaseHook, undefined)
      expect(yield* Fiber.join(run)).toMatchObject({ _tag: "Success" })
      expect(executions).toEqual(["executed once"])
      expect(requests).toHaveLength(2)
      expect(failed).toEqual([])
      expect(retried).toEqual([])
      expect(JSON.stringify(requests[1]?.messages)).toContain("executed once")
    }),
  )

  for (const final of [false, true]) {
    it.live(
      `stream completion contract: reasoning-only ${final ? "final" : "normal"} answer continues from fresh history`,
      () =>
        Effect.gen(function* () {
          yield* setup
          if (final) yield* setBuildAgentSteps(1)
          const session = yield* SessionV2.Service
          yield* session.prompt({
            sessionID,
            prompt: new Prompt({ text: "Finish visibly after reasoning" }),
            resume: false,
          })
          requests.length = 0
          responses = [
            ...(final ? [localToolTurn("call-before-reasoning", { text: "executed once" })] : []),
            [
              LLMEvent.stepStart({ index: 0 }),
              LLMEvent.reasoningStart({ id: "only-reasoning" }),
              LLMEvent.reasoningDelta({ id: "only-reasoning", text: "Preserved thinking" }),
              LLMEvent.reasoningEnd({ id: "only-reasoning" }),
              LLMEvent.stepFinish({ index: 0, reason: "stop" }),
              LLMEvent.finish({ reason: "stop" }),
            ],
            contentStopResponse,
          ]
          yield* session.resume(sessionID)
          expect(requests).toHaveLength(final ? 3 : 2)
          expect(JSON.stringify(requests.at(-1)?.messages)).toContain("Preserved thinking")
          expect(executions).toEqual(final ? ["executed once"] : [])
          if (final) expect(requests.at(-1)?.tools).toEqual([])
          const assistants = (yield* session.context(sessionID)).filter((message) => message.type === "assistant")
          expect(assistants.at(-2)).toMatchObject({
            finish: "error",
            failure: { code: "provider.invalid-response" },
            content: [{ type: "reasoning", text: "Preserved thinking" }],
          })
          expect(assistants.at(-1)).toMatchObject({ finish: "stop", content: [{ type: "text", text: "Done" }] })
        }),
    )
  }

  it.effect("stream completion contract: repeated reasoning-only stops exhaust the shared recovery budget", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Bound reasoning-only responses" }),
        resume: false,
      })
      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id: "only-reasoning" }),
        LLMEvent.reasoningDelta({ id: "only-reasoning", text: "Preserved thinking" }),
        LLMEvent.reasoningEnd({ id: "only-reasoning" }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      const retried: number[] = []
      const events = yield* EventV2.Service
      const unsubscribe = yield* events.listen((event) => {
        if (event.type === SessionEvent.Retried.type) retried.push((event.data as { attempt: number }).attempt)
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsubscribe)
      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (!run.pollUnsafe()) {
        yield* TestClock.adjust("1 second")
        yield* Effect.yieldNow
      }
      expect((yield* Fiber.await(run))._tag).toBe("Failure")
      expect(requests).toHaveLength(6)
      expect(retried).toEqual([1, 2, 3, 4, 5])
      expect(executions).toEqual([])
      expect((yield* session.context(sessionID)).filter((message) => message.type === "assistant")).toHaveLength(6)
    }),
  )

  it.effect("rejects malformed streamed tool input ordering", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [LLMEvent.toolInputDelta({ id: "call-1", name: "read", text: "{}" })]

      expect(yield* session.resume(sessionID).pipe(Effect.catchDefect(Effect.succeed))).toBe(
        "Tool input delta before start: call-1",
      )
    }),
  )

  describe("implementation-task chain lane", () => {
    // Native `task` children advance their chain on every eligible provider failure
    // and get one full second pass; every other session keeps the same-model retry first.
    const taskChildPolicy = (
      type: "task" | "spawn_agent" | "orchestrator" = "task",
      entries: Record<string, { visible: true; permission: "allow" }> = { echo: { visible: true, permission: "allow" } },
    ) => ({
      tools: { mode: "explicit" as const, entries },
      permissionLayers: [],
      source: { type, sessionID: otherSessionID, agent: AgentV2.ID.make("build") },
    })
    const asTaskChild = (input: { readonly policy?: ReturnType<typeof taskChildPolicy>; readonly agent?: "review" } = {}) =>
      Effect.gen(function* () {
        yield* insertSession(otherSessionID)
        const { db } = yield* Database.Service
        yield* db
          .update(SessionTable)
          .set({
            parent_id: otherSessionID,
            agent_policy: input.policy ?? taskChildPolicy(),
            ...(input.agent === undefined ? {} : { agent: input.agent }),
          })
          .where(eq(SessionTable.id, sessionID))
          .run()
          .pipe(Effect.orDie)
      })
    const clearTaskChild = Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ parent_id: null, agent_policy: null, agent: null })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
    })
    const rateLimited = (retryAfterMs: number) =>
      new LLMError({
        module: "test",
        method: "stream",
        reason: new RateLimitReason({ message: "Too many requests", retryAfterMs }),
      })
    const collectRetries = Effect.gen(function* () {
      const attempts: number[] = []
      const events = yield* EventV2.Service
      const unsubscribe = yield* events.listen((event) => {
        if (event.type === SessionEvent.Retried.type) attempts.push((event.data as { attempt: number }).attempt)
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsubscribe)
      return attempts
    })
    const failingStreams = (factory: (attempt: number) => Stream.Stream<LLMEvent, LLMError>) => {
      let attempt = 0
      responseStreamFactory = () => factory(++attempt)
      return Effect.addFinalizer(() => Effect.sync(() => (responseStreamFactory = undefined)))
    }
    const lastAssistant = (context: ReadonlyArray<SessionMessage.Message>) => {
      const last = context.at(-1)
      return last?.type === "assistant" ? last : undefined
    }

    it.effect("advances to the next chain model at once without a same-model retry", () =>
      Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        yield* asTaskChild()
        yield* Effect.addFinalizer(() => clearTaskChild)
        yield* session.prompt({
          sessionID,
          prompt: new Prompt({ text: "Task chain work" }),
          model: chainModelRef(),
          resume: false,
        })

        requests.length = 0
        responses = [
          [LLMEvent.providerError({ message: "Too many requests", retryable: true, retryAfterMs: 0 })],
          fragmentFixture("text", "text-task-chain-fallback", ["Recovered"]).completeEvents,
        ]
        const retried = yield* collectRetries
        yield* session.resume(sessionID)

        expect(requests.map((request) => request.model)).toEqual([model, replacementModel])
        expect(retried).toEqual([])
        expect((yield* session.get(sessionID)).model).toMatchObject({
          id: "replacement",
          chain: { id: "standard", active: 1 },
        })
        const assistants = (yield* session.context(sessionID)).filter((message) => message.type === "assistant")
        expect(assistants).toMatchObject([{ finish: "stop" }])
      }),
    )

    it.effect("runs exactly one new full pass after the chain is exhausted, then fails visibly with structured details", () =>
      Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        yield* asTaskChild()
        yield* Effect.addFinalizer(() => clearTaskChild)
        yield* session.prompt({
          sessionID,
          prompt: new Prompt({ text: "Exhaust the task chain" }),
          model: chainModelRef(),
          resume: false,
        })

        requests.length = 0
        yield* failingStreams(() => Stream.fail(rateLimited(1_500)))
        const retried = yield* collectRetries
        const run = yield* session.resume(sessionID).pipe(Effect.flip, Effect.forkChild)
        while (requests.length < 2) yield* Effect.yieldNow
        // The second pass honors the Retry-After of the first pass before it starts.
        yield* TestClock.adjust(1_499)
        expect(requests.map((request) => request.model)).toEqual([model, replacementModel])
        yield* TestClock.adjust(1)
        const failure = yield* Fiber.join(run)

        expect(requests.map((request) => request.model)).toEqual([
          model,
          replacementModel,
          model,
          replacementModel,
        ])
        expect(retried).toEqual([2])
        expect(failure).toBeInstanceOf(LLMError)
        expect(failure.message).toContain("Task model chain exhausted after 2 passes")
        const context = yield* session.context(sessionID)
        const last = lastAssistant(context)
        expect(last).toMatchObject({ type: "assistant", finish: "error" })
        expect(last?.error?.message).toContain(
          "fake/fake-model:provider.rate-limit, fake/replacement:provider.rate-limit, fake/fake-model:provider.rate-limit, fake/replacement:provider.rate-limit",
        )
        expect(last?.error?.message).toContain(`task_id ${sessionID}`)
        expect(last?.failure).toMatchObject({
          code: "provider.rate-limit",
          providerRef: "fake/replacement",
          retryability: "none",
          remediation: "retry",
        })
        expect(last?.failure?.cause?.detail).toBe(
          "task-chain-exhausted;passes=2;attempts=fake/fake-model:provider.rate-limit,fake/replacement:provider.rate-limit,fake/fake-model:provider.rate-limit,fake/replacement:provider.rate-limit",
        )
        expect(
          context
            .filter((message) => message.type === "model-switched")
            .map((message) => (message.type === "model-switched" ? message.model.chain?.active : undefined)),
        ).toEqual([0, 1, 0, 1])
      }),
    )

    it.effect("treats a single configured model as a one-step chain with one second pass", () =>
      Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        yield* asTaskChild()
        yield* Effect.addFinalizer(() => clearTaskChild)
        yield* session.prompt({ sessionID, prompt: new Prompt({ text: "One step task" }), resume: false })

        requests.length = 0
        yield* failingStreams((attempt) =>
          attempt === 1
            ? Stream.fail(rateLimited(2_000))
            : Stream.fromIterable(fragmentFixture("text", "text-task-one-step", ["Recovered"]).completeEvents),
        )
        const retried = yield* collectRetries
        const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
        while (requests.length < 1) yield* Effect.yieldNow
        yield* TestClock.adjust(1_999)
        expect(requests).toHaveLength(1)
        yield* TestClock.adjust(1)
        yield* Fiber.join(run)

        expect(requests.map((request) => request.model)).toEqual([model, model])
        expect(retried).toEqual([1])
        expect((yield* session.context(sessionID)).filter((message) => message.type === "model-switched")).toEqual([])
      }),
    )

    it.effect("does not restart a mixed task chain through a model with exhausted quota", () =>
      Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        yield* asTaskChild()
        yield* Effect.addFinalizer(() => clearTaskChild)
        yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Respect quota across passes" }),
          model: chainModelRef(), resume: false })

        requests.length = 0
        yield* failingStreams((attempt) => attempt === 1 ? Stream.fail(quotaExceeded()) : Stream.fail(rateLimited(0)))
        const failed = yield* session.resume(sessionID).pipe(Effect.flip)

        expect(requests.map((request) => request.model)).toEqual([model, replacementModel])
        expect(failed.message).toContain("after 1 pass")
      }),
    )

    it.effect("never retries early when Retry-After exceeds the automatic wait limit and reports the earliest retry time", () =>
      Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        yield* asTaskChild()
        yield* Effect.addFinalizer(() => clearTaskChild)
        yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Deferred task" }), resume: false })

        requests.length = 0
        const before = Date.now()
        const retryAfterMs = SessionResume.MAX_AUTO_RETRY_WAIT_MS + 1
        yield* failingStreams(() => Stream.fail(rateLimited(retryAfterMs)))
        const retried = yield* collectRetries
        const failure = yield* session.resume(sessionID).pipe(Effect.flip)

        expect(requests.map((request) => request.model)).toEqual([model])
        expect(retried).toEqual([])
        expect(failure.message).toContain(
          `Retry-After ${retryAfterMs} ms exceeds the ${SessionResume.MAX_AUTO_RETRY_WAIT_MS} ms automatic wait limit`,
        )
        const last = lastAssistant(yield* session.context(sessionID))
        expect(last).toMatchObject({ type: "assistant", finish: "error" })
        expect(last?.failure).toMatchObject({
          code: "provider.rate-limit",
          retryability: "none",
          remediation: "retry",
          providerRef: "fake/fake-model",
          retryAfterMs,
          resetAt: expect.any(Number),
        })
        const displayedRetryAt = last?.error?.message.match(/Earliest retry time: (\S+)\./)?.[1]
        expect(Date.parse(displayedRetryAt ?? "")).toBeGreaterThanOrEqual(before + retryAfterMs)
        expect(last?.error?.message).toContain("Earliest retry time:")
        expect(last?.error?.message).toContain("Task model chain exhausted after 1 pass")
      }),
    )

    it.effect("never re-runs a turn that already executed a tool call", () =>
      Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        yield* asTaskChild()
        yield* Effect.addFinalizer(() => clearTaskChild)
        yield* session.prompt({
          sessionID,
          prompt: new Prompt({ text: "Tool before failure" }),
          model: chainModelRef(),
          resume: false,
        })

        requests.length = 0
        const executionCount = executions.length
        responses = [
          [
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.toolCall({ id: "call-task-before-failure", name: "echo", input: { text: "settled once" } }),
            LLMEvent.providerError({ message: "Too many requests", retryable: true, retryAfterMs: 0 }),
          ],
          fragmentFixture("text", "text-task-after-tool", ["Recovered"]).completeEvents,
        ]
        const retried = yield* collectRetries
        const failure = yield* session.resume(sessionID).pipe(Effect.flip)
        expect(failure.message).toContain("Too many requests")

        // The failed request is not replayed after the tool ran.
        expect(executions.slice(executionCount)).toEqual(["settled once"])
        expect(requests.map((request) => request.model)).toEqual([model])
        expect(
          (yield* session.context(sessionID)).filter((message) => message.type === "assistant"),
        ).toMatchObject([
          { finish: "error", content: [{ type: "tool", id: "call-task-before-failure" }] },
        ])
        expect(retried).toEqual([])
      }),
    )

    it.effect("never retries or restarts for a non-retryable authentication failure", () =>
      Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        yield* asTaskChild()
        yield* Effect.addFinalizer(() => clearTaskChild)
        yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Authentication failure" }), resume: false })

        requests.length = 0
        yield* failingStreams(() =>
          Stream.fail(
            new LLMError({
              module: "test",
              method: "stream",
              reason: new AuthenticationReason({ message: "invalid_api_key", kind: "invalid" }),
            }),
          ),
        )
        const retried = yield* collectRetries
        const failure = yield* session.resume(sessionID).pipe(Effect.flip)

        expect(requests.map((request) => request.model)).toEqual([model])
        expect(retried).toEqual([])
        expect(failure.message).toContain("invalid_api_key")
        const last = lastAssistant(yield* session.context(sessionID))
        expect(last).toMatchObject({ type: "assistant", finish: "error" })
        expect(last?.failure?.code).toBe("provider.auth")
      }),
    )

    it.effect("moves to a different configured model for an account quota without retrying the failed step", () =>
      Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        yield* asTaskChild()
        yield* Effect.addFinalizer(() => clearTaskChild)
        yield* session.prompt({
          sessionID,
          prompt: new Prompt({ text: "Quota then fallback" }),
          model: chainModelRef(),
          resume: false,
        })

        requests.length = 0
        yield* failingStreams((attempt) =>
          attempt === 1
            ? Stream.fail(quotaExceeded())
            : Stream.fromIterable(fragmentFixture("text", "text-task-quota-fallback", ["Recovered"]).completeEvents),
        )
        const retried = yield* collectRetries
        yield* session.resume(sessionID)

        expect(requests.map((request) => request.model)).toEqual([model, replacementModel])
        expect(retried).toEqual([])
      }),
    )

    it.effect("never retries or restarts after a user interruption", () =>
      Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        yield* asTaskChild()
        yield* Effect.addFinalizer(() => clearTaskChild)
        yield* session.prompt({
          sessionID,
          prompt: new Prompt({ text: "Interrupt the task" }),
          model: chainModelRef(),
          resume: false,
        })

        requests.length = 0
        responseStream = Stream.never
        yield* Effect.addFinalizer(() => Effect.sync(() => (responseStream = undefined)))
        const retried = yield* collectRetries
        const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
        while (requests.length === 0) yield* Effect.yieldNow
        yield* session.interrupt(sessionID)
        const exit = yield* Fiber.await(run)

        expect(exit._tag === "Failure" && Cause.hasInterrupts(exit.cause)).toBe(true)
        expect(requests.map((request) => request.model)).toEqual([model])
        expect(retried).toEqual([])
        yield* (yield* SessionRunCoordinator.Service).awaitIdle(sessionID)
      }),
    )

    it.effect("never retries or restarts when a permission is declined", () =>
      Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        const registry = yield* ToolRegistry.Service
        yield* registry.register({
          declined: Tool.make({
            description: "Fail because the user declined approval",
            input: Schema.Struct({}),
            output: Schema.Struct({}),
            execute: () => Effect.die(new PermissionV2.DeclinedError()),
          }),
        })
        yield* asTaskChild({ policy: taskChildPolicy("task", { declined: { visible: true, permission: "allow" } }) })
        yield* Effect.addFinalizer(() => clearTaskChild)
        yield* session.prompt({
          sessionID,
          prompt: new Prompt({ text: "Call declined" }),
          model: chainModelRef(),
          resume: false,
        })

        requests.length = 0
        responses = [
          [
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.toolCall({ id: "call-task-declined", name: "declined", input: {} }),
            LLMEvent.providerError({ message: "Too many requests", retryable: true, retryAfterMs: 0 }),
          ],
          fragmentFixture("text", "text-never-reached", ["Never"]).completeEvents,
        ]
        const retried = yield* collectRetries
        const exit = yield* session.resume(sessionID).pipe(Effect.exit)

        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        expect(requests.map((request) => request.model)).toEqual([model])
        expect(retried).toEqual([])
      }),
    )

    it.effect("never restarts the chain over a model selection that changed during the wait", () =>
      Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        yield* asTaskChild()
        yield* Effect.addFinalizer(() => clearTaskChild)
        yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Switch during the wait" }), resume: false })

        requests.length = 0
        yield* failingStreams((attempt) =>
          attempt === 1
            ? Stream.fail(rateLimited(5_000))
            : Stream.fromIterable(fragmentFixture("text", "text-after-switch", ["Recovered"]).completeEvents),
        )
        const retryScheduled = yield* Deferred.make<void>()
        const events = yield* EventV2.Service
        const unsubscribe = yield* events.listen((event) => {
          if (event.type === SessionEvent.Retried.type) Deferred.doneUnsafe(retryScheduled, Effect.void)
          return Effect.void
        })
        yield* Effect.addFinalizer(() => unsubscribe)
        const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
        yield* Deferred.await(retryScheduled)
        expect(requests).toHaveLength(1)

        // A different persisted selection is a new binding: the old chain is not restarted over it.
        const { db } = yield* Database.Service
        yield* db
          .update(SessionTable)
          .set({ model: { id: "replacement", providerID: "fake", variant: "medium" } })
          .where(eq(SessionTable.id, sessionID))
          .run()
          .pipe(Effect.orDie)
        yield* TestClock.adjust(5_000)
        yield* Fiber.join(run)

        expect(requests.map((request) => request.model)).toEqual([model, replacementModel])
        expect((yield* session.context(sessionID)).filter((message) => message.type === "model-switched")).toEqual([])
        expect((yield* session.context(sessionID)).at(-1)).toMatchObject({ type: "assistant", finish: "stop" })
      }),
    )

    it.effect("keeps the same-model retry before advancing for non-task children", () =>
      Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        yield* asTaskChild({ policy: taskChildPolicy("spawn_agent") })
        yield* Effect.addFinalizer(() => clearTaskChild)
        yield* session.prompt({
          sessionID,
          prompt: new Prompt({ text: "Spawned child chain" }),
          model: chainModelRef(),
          resume: false,
        })

        requests.length = 0
        responses = [
          [LLMEvent.providerError({ message: "Too many requests", retryable: true, retryAfterMs: 0 })],
          [LLMEvent.providerError({ message: "Too many requests", retryable: true, retryAfterMs: 0 })],
          fragmentFixture("text", "text-spawned-fallback", ["Recovered"]).completeEvents,
        ]
        const retried = yield* collectRetries
        yield* session.resume(sessionID)

        expect(requests.map((request) => request.model)).toEqual([model, model, replacementModel])
        expect(retried).toEqual([1])
      }),
    )

    it.effect("keeps today's recovery order for registered fanout and reviewer workers", () =>
      Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        // A reviewer worker runs the `review` agent even when it inherits a chain.
        yield* asTaskChild({ agent: "review" })
        yield* Effect.addFinalizer(() => clearTaskChild)
        yield* session.prompt({
          sessionID,
          prompt: new Prompt({ text: "Reviewer with chain" }),
          model: chainModelRef(),
          resume: false,
        })

        requests.length = 0
        responses = [
          [LLMEvent.providerError({ message: "Too many requests", retryable: true, retryAfterMs: 0 })],
          [LLMEvent.providerError({ message: "Too many requests", retryable: true, retryAfterMs: 0 })],
          fragmentFixture("text", "text-reviewer-fallback", ["Recovered"]).completeEvents,
        ]
        yield* session.resume(sessionID)
        expect(requests.map((request) => request.model)).toEqual([model, model, replacementModel])

        // A workflow worker's direct model (`chain: null`) keeps same-model retries and never gets a second pass.
        const { db } = yield* Database.Service
        yield* db.update(SessionTable).set({ agent: null }).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
        yield* session.prompt({
          sessionID,
          prompt: new Prompt({ text: "Direct worker model" }),
          model: ModelV2.Ref.make({
            id: ModelV2.ID.make("fake-model"),
            providerID: ProviderV2.ID.make("fake"),
            chain: null,
          }),
          resume: false,
        })
        requests.length = 0
        yield* failingStreams((attempt) =>
          attempt <= 3
            ? Stream.fail(rateLimited(0))
            : Stream.fromIterable(fragmentFixture("text", "text-direct-worker", ["Recovered"]).completeEvents),
        )
        yield* session.resume(sessionID)
        expect(requests.map((request) => request.model)).toEqual([model, model, model, model])
        const switches = (yield* session.context(sessionID)).filter((message) => message.type === "model-switched")
        expect(switches.at(-1)?.model.chain).toBeNull()
        expect(switches.filter((message) => message.model.chain?.active === 1)).toHaveLength(1)
      }),
    )
  })
})
