import { Context, Effect, Equal, Hash, Layer, LayerMap, Option, Scope } from "effect"
import { Location } from "./location"
import { Policy } from "./policy"
import { Config } from "./config"
import { PluginV2 } from "./plugin"
import { Catalog } from "./catalog"
import { Integration } from "./integration"
import { CommandV2 } from "./command"
import { AgentV2 } from "./agent"
import { PluginBoot } from "./plugin/boot"
import { Project } from "./project"
import { ProjectCopy } from "./project/copy"
import { ProjectDirectories } from "./project/directories"
import { EventV2 } from "./event"
import { Credential } from "./credential"
import { Npm } from "./npm"
import { ModelsDev } from "./models-dev"
import { FSUtil } from "./fs-util"
import { Git } from "./git"
import { Global } from "./global"
import { Database } from "./database/database"
import { PermissionV2 } from "./permission"
import { PermissionSafetyReview } from "./permission/safety-review"
import { PermissionSaved } from "./permission/saved"
import { FileSystem } from "./filesystem"
import { Ripgrep } from "./ripgrep"
import { Watcher } from "./filesystem/watcher"
import { LocationMutation } from "./location-mutation"
import { FileMutation } from "./file-mutation"
import { Reference } from "./reference"
import { ReferenceGuidance } from "./reference/guidance"
import { RepositoryCache } from "./repository-cache"
import { Pty } from "./pty"
import { SkillV2 } from "./skill"
import { SkillGuidance } from "./skill/guidance"
import { BuiltInTools } from "./tool/builtins"
import { LocalTool } from "./tool/local"
import { Image } from "./image"
import { ImageGeneration } from "./image-generation"
import { ToolRegistry } from "./tool/registry"
import { ApplicationTools } from "./tool/application-tools"
import { ShellEnvironment } from "./shell-environment"
import { TaskTool } from "./tool/task"
import { TaskIntegrateTool } from "./tool/task-integrate"
import { MirrorIntegrateTool } from "./tool/mirror-integrate"
import { DelegationPreferencesTool } from "./tool/delegation-preferences"
import { DelegationSettings } from "./session/delegation-settings"
import { ConfigFileWriter } from "./config/file-writer"
import { EffectFlock } from "./util/effect-flock"
import { TaskJob } from "./tool/task-job"
import { SpawnAgentTool } from "./tool/spawn-agent"
import { WorkspaceCheckout } from "./session/workspace/checkout"
import { BackgroundJob } from "./background-job"
import { ToolOutputStore } from "./tool-output-store"
import { ContentStore } from "./content-store"
import { AppProcess } from "./process"
import { Snapshot } from "./snapshot"
import { SessionStore } from "./session/store"
import { SessionExecution } from "./session/execution"
import { SessionAccess } from "./session/access"
import { SessionLinks } from "./session/links"
import { FanoutWorkflow } from "./fanout-workflow"
import { SessionFileMutation } from "./session/file-mutation"
import { SessionTodo } from "./session/todo"
import { SessionPlanDocument } from "./session/plan-document"
import { SessionToolCancellation } from "./session/tool-cancellation"
import { NativeJob } from "./session/native-job"
import { QuestionV2 } from "./question"
import { ControlConfig } from "./control-config"
import { ControlLive } from "./control-live"
import { McpPrompt } from "./mcp/prompt"
import { McpClient } from "./mcp/client"
import { McpTool } from "./mcp/tool"
import { CapabilityLease } from "./capability/lease"
import { LLMClient } from "@opencode-ai/llm"
import { RequestExecutor, WebSocketExecutor } from "@opencode-ai/llm/route"
import * as SessionRunnerLLM from "./session/runner/llm"
import { SessionRunnerModel } from "./session/runner/model"
import { SessionRunCoordinator } from "./session/run-coordinator"
import { AISDK } from "./aisdk"
import { SystemContextBuiltIns } from "./system-context/builtins"
import { Memory } from "./memory"
import { FetchHttpClient } from "effect/unstable/http"

const databaseDependency = Layer.unwrap(
  Effect.serviceOption(Database.Service).pipe(
    Effect.map((service) =>
      Option.match(service, {
        onNone: () => Database.defaultLayer,
        onSome: (value) => Layer.succeed(Database.Service, value),
      }),
    ),
  ),
)

const eventDependency = Layer.unwrap(
  Effect.serviceOption(EventV2.Service).pipe(
    Effect.map((service) =>
      Option.match(service, {
        onNone: () => EventV2.defaultLayer,
        onSome: (value) => Layer.succeed(EventV2.Service, value),
      }),
    ),
  ),
)

const sessionStoreDependency = Layer.unwrap(
  Effect.serviceOption(SessionStore.Service).pipe(
    Effect.map((service) =>
      Option.match(service, {
        onNone: () => SessionStore.layer.pipe(Layer.provide(databaseDependency)),
        onSome: (value) => Layer.succeed(SessionStore.Service, value),
      }),
    ),
  ),
)

const locationServices = (ref: Location.Ref, execution: SessionExecution.Interface, nativeJob: Layer.Layer<NativeJob.Bridge>) => {
  const boot = Layer.effectDiscard(
    Effect.logInfo("booting location services", { directory: ref.directory, workspaceID: ref.workspaceID }),
  )
  const location = Location.layer(ref)
  const systemContext = SystemContextBuiltIns.locationLayer
  const mcpClient = McpClient.locationLayer
  const mcpPrompt = McpPrompt.layer.pipe(Layer.provide(mcpClient))
  const base = Layer.mergeAll(
    location,
    Policy.locationLayer,
    Config.locationLayer,
    Reference.locationLayer,
    PluginV2.locationLayer,
    Catalog.locationLayer,
    Integration.locationLayer,
    CommandV2.locationLayer,
    AgentV2.locationLayer,
    PluginBoot.locationLayer,
    ProjectCopy.locationLayer,
    FileSystem.locationLayer,
    Watcher.locationLayer,
    Pty.locationLayer,
    SkillV2.locationLayer.pipe(Layer.provideMerge(Config.locationLayer)),
    mcpClient,
    mcpPrompt,
    systemContext,
    LocationMutation.locationLayer.pipe(Layer.orDie),
  ).pipe(Layer.provideMerge(location))
  const content = ContentStore.layer.pipe(
    Layer.provide(databaseDependency),
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(Global.defaultLayer),
  )
  const memory = Memory.layer.pipe(Layer.provide(databaseDependency))
  const resources = ToolOutputStore.layer.pipe(Layer.provide(base), Layer.provide(content))
  const sessionAccess = SessionAccess.layer.pipe(
    Layer.provide(databaseDependency),
    Layer.provide(eventDependency),
    Layer.provide(sessionStoreDependency),
    Layer.provide(content),
  )
  const safetyReview = PermissionSafetyReview.layer.pipe(Layer.provide(base))
  const sessionLinks = SessionLinks.layer.pipe(Layer.provide(databaseDependency), Layer.provide(sessionAccess))
  const capabilityLeases = CapabilityLease.layer.pipe(Layer.provide(base))
  const permissionsAndTools = ToolRegistry.layer.pipe(
    Layer.provide(databaseDependency),
    Layer.provide(capabilityLeases),
    Layer.provideMerge(PermissionV2.locationLayer),
    Layer.provide(safetyReview),
    Layer.provide(resources),
    Layer.provide(base),
  )
  const services = Layer.mergeAll(
    FanoutWorkflow.locationLayer.pipe(Layer.provide(base)),
    base,
    content,
    memory,
    resources,
    safetyReview,
    permissionsAndTools,
    capabilityLeases,
    SessionToolCancellation.layer,
  )
  const image = Image.layer.pipe(Layer.provide(services))
  const imageGeneration = ImageGeneration.defaultLayer
  const mutation = FileMutation.locationLayer.pipe(Layer.provide(services))
  const sessionFileMutation = SessionFileMutation.layer.pipe(Layer.provide(services))
  const skillGuidance = SkillGuidance.locationLayer.pipe(Layer.provide(services))
  const referenceGuidance = ReferenceGuidance.locationLayer.pipe(Layer.provide(services))
  const todos = SessionTodo.layer.pipe(Layer.provide(services))
  const planDocument = SessionPlanDocument.layer.pipe(Layer.provide(databaseDependency))
  const configWriter = ConfigFileWriter.layer.pipe(
    Layer.provide(EffectFlock.layer.pipe(Layer.provide(Global.defaultLayer), Layer.provide(FSUtil.defaultLayer))),
  )
  const delegationSettings = DelegationSettings.layer.pipe(
    Layer.provide(services), Layer.provide(configWriter),
    Layer.provide(databaseDependency), Layer.provide(eventDependency), Layer.provide(sessionStoreDependency),
  )
  const delegationPreferencesTool = DelegationPreferencesTool.layer.pipe(
    Layer.provide(services), Layer.provide(delegationSettings),
  )
  const questions = QuestionV2.locationLayer.pipe(Layer.provide(services), Layer.provide(databaseDependency))
  const controlConfig = ControlConfig.locationLayer.pipe(Layer.provide(services))
  const controlLive = ControlLive.locationLayer.pipe(Layer.provide(services))
  const builtInTools = BuiltInTools.locationLayer.pipe(
    Layer.provide(services),
    Layer.provide(databaseDependency),
    Layer.provide(mutation),
    Layer.provide(sessionFileMutation),
    Layer.provide(resources),
    Layer.provide(todos),
    Layer.provide(planDocument),
    Layer.provide(questions),
    Layer.provide(image),
    Layer.provide(imageGeneration),
    Layer.provide(sessionAccess),
    Layer.provide(sessionLinks),
    // Managed-child workspace guards revalidate checkout identity from the
    // write/edit/bash/apply_patch tools; the resolver itself is stateless.
    Layer.provide(WorkspaceCheckout.layer),
  )
  // Local project tools read the confirmed-handoff surface and session plan
  // documents through sessionContext; those services live outside `services`
  // (they depend on it), so they must be provided here explicitly or every
  // project tool sees empty plan/invocation context (fail-closed tools like
  // daily_review_implementation can never resolve a confirmed handoff).
  const localTools = LocalTool.locationLayer.pipe(
    Layer.provide(services),
    Layer.provide(planDocument),
    Layer.provide(questions),
  )
  const mcpTools = McpTool.locationLayer.pipe(Layer.provide(services))
  const aisdk = AISDK.layer.pipe(Layer.provide(services))
  const model = SessionRunnerModel.locationLayer.pipe(Layer.provide(services), Layer.provide(aisdk))
  const runner = SessionRunnerLLM.defaultLayer.pipe(
    Layer.provide(services),
    Layer.provide(model),
    Layer.provide(skillGuidance),
    Layer.provide(referenceGuidance),
    Layer.provide(mcpTools),
    Layer.provide(Snapshot.defaultLayer),
  )
  const taskJobs = TaskJob.layer.pipe(
    Layer.provide(BackgroundJob.defaultLayer),
    Layer.provide(eventDependency),
    Layer.provide(databaseDependency),
  )
  const taskTool = TaskTool.locationLayer.pipe(
    Layer.provide(services),
    Layer.provide(questions),
    Layer.provide(model),
    Layer.provide(Layer.effect(LLMClient.Service, LLMClient.Service)),
    Layer.provide(Layer.succeed(SessionExecution.Service, execution)),
    Layer.provide(taskJobs),
  )
  const taskIntegrateTool = TaskIntegrateTool.locationLayer.pipe(
    Layer.provide(services),
    Layer.provide(sessionFileMutation),
    Layer.provide(FileMutation.layer.pipe(Layer.provide(FSUtil.defaultLayer))),
  )
  const mirrorIntegrateTool = MirrorIntegrateTool.locationLayer.pipe(
    Layer.provide(services),
    Layer.provide(sessionFileMutation),
    Layer.provide(FileMutation.layer.pipe(Layer.provide(FSUtil.defaultLayer))),
  )
  const spawnAgentJobs = BackgroundJob.defaultLayer
  const spawnAgentTool = SpawnAgentTool.locationLayer.pipe(
    Layer.provide(services),
    Layer.provide(runner),
    Layer.provide(spawnAgentJobs),
  )
  // Kick off a background project copy refresh to update locations now that we
  // have a location
  const projectCopyRefresh = Layer.effectDiscard(ProjectCopy.refreshAfterBoot).pipe(Layer.provide(services))

  return Layer.mergeAll(
    boot,
    services,
    image,
    imageGeneration,
    mutation,
    sessionFileMutation,
    resources,
    sessionAccess,
    sessionLinks,
    todos,
    planDocument,
    configWriter,
    delegationSettings,
    delegationPreferencesTool,
    questions,
    controlConfig,
    controlLive,
    aisdk,
    // Manual compaction uses the same process client as the location runner.
    Layer.effect(LLMClient.Service, LLMClient.Service),
    model,
    runner,
    taskJobs,
    spawnAgentJobs,
    builtInTools,
    localTools,
    mcpTools,
    taskTool,
    taskIntegrateTool,
    mirrorIntegrateTool,
    spawnAgentTool,
    WorkspaceCheckout.layer,
    referenceGuidance,
    projectCopyRefresh,
    nativeJob,
  ).pipe(Layer.fresh)
}

type LocationServices = Layer.Success<ReturnType<typeof locationServices>>
type LocationServiceError = Layer.Error<ReturnType<typeof locationServices>>
type LocationMap = Effect.Success<typeof LocationServiceMap>

class LocationCacheKey implements Equal.Equal, Hash.Hash {
  readonly key: string

  constructor(readonly ref: Location.Ref) {
    this.key = Location.identity(ref)
  }

  [Equal.symbol](that: unknown) {
    return that instanceof LocationCacheKey && this.key === that.key
  }

  [Hash.symbol]() {
    return Hash.hash(this.key)
  }
}

export class LocationServiceMap extends Context.Service<
  LocationServiceMap,
  {
    readonly get: (ref: Location.Ref) => Layer.Layer<LocationServices, LocationServiceError>
    readonly invalidate: (ref: Location.Ref) => Effect.Effect<void>
    readonly bindExecution: (execution: SessionExecution.Interface) => Effect.Effect<void, never, Scope.Scope>
  }
>()("@opencode/example/LocationServiceMap") {}

const locationServiceMapDependencies = Layer.mergeAll(
  Project.defaultLayer,
  eventDependency,
  Credential.defaultLayer,
  Npm.defaultLayer,
  ModelsDev.defaultLayer,
  FSUtil.defaultLayer,
  Git.defaultLayer,
  AppProcess.defaultLayer,
  Global.defaultLayer,
  Ripgrep.defaultLayer,
  databaseDependency,
  ProjectDirectories.defaultLayer,
  sessionStoreDependency,
  PermissionSaved.defaultLayer,
  RepositoryCache.defaultLayer,
  LLMClient.layer.pipe(Layer.provide(Layer.mergeAll(RequestExecutor.defaultLayer, WebSocketExecutor.layer))),
  FetchHttpClient.layer,
  ToolOutputStore.defaultCleanupLayer,
  // ApplicationTools is intentionally NOT provided here: it is exposed once
  // through the provideMerge below so the ambient environment and the
  // location tool registries share exactly one instance (single provision by
  // layer identity).
)

export const locationServiceMapLayer = Layer.effect(
  LocationServiceMap,
  Effect.gen(function* () {
    // Location construction precedes the process execution owner, which itself
    // routes through this map. Bind once after construction, never create a
    // second coordinator or capture an unowned runner as a fallback.
    let owner: SessionExecution.Interface | undefined
    const use = <A, E>(f: (execution: SessionExecution.Interface) => Effect.Effect<A, E>) =>
      Effect.suspend(() => (owner ? f(owner) : Effect.die("Session execution owner is not bound")))
    const execution: SessionExecution.Interface = {
      resume: (id) => use((service) => service.resume(id)),
      resumeOrJoin: (id) => use((service) => service.resumeOrJoin(id)),
      wake: (id, seq) => use((service) => service.wake(id, seq)),
      queueContinuation: (id) => use((service) => service.queueContinuation(id)),
      interrupt: (id, seq) => use((service) => service.interrupt(id, seq)),
      interruptActivity: (id, activityID, seq) => use((service) => service.interruptActivity(id, activityID, seq)),
      wait: (id) => use((service) => service.wait(id)),
      cancelTool: (id, callID) => use((service) => service.cancelTool(id, callID)),
      withIdle: (id, effect) => Effect.suspend(() =>
        owner?.withIdle ? owner.withIdle(id, effect) : Effect.fail(new SessionRunCoordinator.Busy())),
    }
    let current: LocationMap | undefined
    const jobServices = Context.make(Database.Service, yield* Database.Service).pipe(
      Context.add(EventV2.Service, yield* EventV2.Service),
      Context.add(SessionStore.Service, yield* SessionStore.Service),
      Context.add(Project.Service, yield* Project.Service),
    )
    // The map is constructed after its cache; each Location receives the
    // finished map lazily so tools can reach other physical checkouts.
    const nativeJob = Layer.effect(NativeJob.Bridge, Effect.suspend(() =>
      current ? Effect.succeed(NativeJob.bridge(current, () => owner, jobServices)) : Effect.die("Location service map is not constructed"),
    ))
    const cache = yield* LayerMap.make((key: LocationCacheKey) => locationServices(key.ref, execution, nativeJob), {
      idleTimeToLive: "60 minutes",
    })
    const map = LocationServiceMap.of({
      bindExecution: (execution) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            if (owner) throw new Error("Session execution owner is already bound")
            owner = execution
          }),
          () =>
            Effect.sync(() => {
              if (owner === execution) owner = undefined
            }),
        ),
      get: (ref) => cache.get(new LocationCacheKey(ref)),
      invalidate: (ref) => cache.invalidate(new LocationCacheKey(ref)),
    })
    current = map
    return map
  }),
).pipe(
  // Expose the same application-level tool registry instance that location
  // tool registries merge, so plugin hosts can register always-visible
  // protocol tools outside the evictable per-location scopes (see the plugin
  // host tools.register) instead of losing them with an idle location.
  Layer.provideMerge(ApplicationTools.layer),
  Layer.provideMerge(ShellEnvironment.layer),
  Layer.provide(locationServiceMapDependencies),
)

export namespace LocationServiceMap {
  export const get = (ref: Location.Ref) =>
    Layer.unwrap(Effect.map(LocationServiceMap, (locations) => locations.get(ref)))

  export const layer = locationServiceMapLayer
}
