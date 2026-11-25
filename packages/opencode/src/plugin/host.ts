import { Effect, Exit, Fiber, Scope, Schema } from "effect"
import { and, desc, eq } from "drizzle-orm"
import type { ServerPluginHost } from "@opencode-ai/plugin/server"
import { AgentV2 } from "@opencode-ai/core/agent"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionLinks } from "@opencode-ai/core/session/links"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionInputTable } from "@opencode-ai/core/session/sql"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { CrashActivity } from "@opencode-ai/core/observability/crash-activity"
import { SessionExecutionView } from "@opencode-ai/core/session/execution-view"
import { OutputFormat } from "@opencode-ai/core/session/prompt"
import { Database } from "@opencode-ai/core/database/database"
import { SessionArchive } from "@opencode-ai/core/session-archive"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { LocalTool } from "@opencode-ai/core/tool/local"
import { Tools } from "@opencode-ai/core/tool/tools"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { isAlwaysVisible } from "@opencode-ai/core/tool/tool"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { SessionPlanDocument } from "@opencode-ai/core/session/plan-document"
import { Surface } from "@opencode-ai/core/surface"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { EffectBridge } from "@/effect/bridge"
import { completionRegistry, goalOwnershipRegistry } from "./completion"
import { mediaRegistry } from "./media"
import { samePluginScope } from "./directory"
import { FanoutWorkflow } from "@opencode-ai/core/fanout-workflow"
import { InstallationVersion } from "@opencode-ai/core/installation/version"

/** The loader supplies identity, location and a lifetime; none come from plugin requests. */
export function createPluginHost(input: { pluginID: string; directory: string; bridge: EffectBridge.Shape; disposers: Array<() => Promise<void>> }): { host: ServerPluginHost; dispose(): Promise<void> } {
  const lifetime = input.bridge.promise(Scope.make())
  const controller = new AbortController()
  let disposal: Promise<void> | undefined
  const dispose = () => {
    controller.abort()
    return disposal ??= lifetime.then((scope) => input.bridge.promise(Scope.close(scope, Exit.void)))
  }
  input.disposers.push(dispose)
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>, registration = false) => input.bridge.promise(Effect.gen(function* () {
    if (controller.signal.aborted) return yield* Effect.fail(new Error("Plugin host has been unloaded"))
    const scope = yield* Effect.promise(() => lifetime)
    if (controller.signal.aborted) return yield* Effect.fail(new Error("Plugin host has been unloaded"))
    const locations = yield* LocationServiceMap
    return yield* Effect.gen(function* () {
      const operationScope = registration ? yield* Scope.fork(scope) : scope
      return yield* effect.pipe(
        Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(input.directory) }))),
        Effect.provideService(Scope.Scope, operationScope),
        Effect.onExit((exit) => registration && Exit.isFailure(exit) ? Scope.close(operationScope, exit) : Effect.void),
      )
    }).pipe(Effect.forkIn(scope), Effect.flatMap(Fiber.join))
  }))
  const identity = (link: { source_session_id: string; target_session_id: string }) => ({ sourceSessionID: link.source_session_id, targetSessionID: link.target_session_id })
  const host: ServerPluginHost = {
    version: InstallationVersion,
    signal: controller.signal,
    media: { register: async (adapters) => {
      if (controller.signal.aborted) throw new Error("Plugin host has been unloaded")
      const scope = await lifetime
      if (controller.signal.aborted) throw new Error("Plugin host has been unloaded")
      const release = mediaRegistry.register(input.directory, adapters)
      await input.bridge.promise(Scope.addFinalizer(scope, Effect.sync(release)))
    } },
    fanout: { register: (definition) => run(Effect.gen(function* () {
      yield* (yield* FanoutWorkflow.Service).register(input.pluginID, definition)
    }), true) },
    sessions: {
      completion: {
        register: async (policy) => {
          if (controller.signal.aborted) throw new Error("Plugin host has been unloaded")
          const scope = await lifetime
          if (controller.signal.aborted) throw new Error("Plugin host has been unloaded")
          const release = completionRegistry.register(input.directory, policy)
          await input.bridge.promise(Scope.addFinalizer(scope, Effect.sync(release)))
        },
      },
      goalOwnership: {
        project: (request) => run(Effect.gen(function* () {
          const sessions = yield* SessionV2.Service
          const sessionID = SessionSchema.ID.make(request.sessionID)
          const session = yield* sessions.get(sessionID)
          if (!(yield* Effect.promise(() => samePluginScope(session.location.directory, input.directory)))) throw new Error("Session belongs to another plugin location")
          if (!sessions.compareAndPatchMetadata) throw new Error("Goal status CAS is unavailable")
          return yield* sessions.compareAndPatchMetadata({ sessionID,
            expectedMetadata: { "opencode.session.goal": request.condition, "opencode.session.goal_run": request.runID, "opencode.session.goal_status": request.expectedStatus },
            patch: { set: { "opencode.session.goal_status": request.status } },
          })
        })),
        clear: (request) => run(Effect.gen(function* () {
          if (!request.runID) throw new Error("Goal cleanup requires a run ID")
          const sessions = yield* SessionV2.Service
          const sessionID = SessionSchema.ID.make(request.sessionID)
          const session = yield* sessions.get(sessionID)
          if (!(yield* Effect.promise(() => samePluginScope(session.location.directory, input.directory)))) throw new Error("Session belongs to another plugin location")
          yield* sessions.patchMetadata({
            sessionID,
            expectedMetadata: { "opencode.session.goal": request.condition, "opencode.session.goal_run": request.runID },
            patch: { unset: ["opencode.session.goal", "opencode.session.goal_run", "opencode.session.goal_status"] },
          })
        })),
        register: async (policy) => {
          if (controller.signal.aborted) throw new Error("Plugin host has been unloaded")
          const scope = await lifetime
          if (controller.signal.aborted) throw new Error("Plugin host has been unloaded")
          const release = goalOwnershipRegistry.register(input.directory, policy)
          await input.bridge.promise(Scope.addFinalizer(scope, Effect.sync(release)))
        },
      },
      admissionHead: (request) => run(Effect.gen(function* () {
        const sessionID = SessionSchema.ID.make(request.sessionID)
        const session = yield* (yield* SessionV2.Service).get(sessionID)
        if (!(yield* Effect.promise(() => samePluginScope(session.location.directory, input.directory)))) throw new Error("Session belongs to another plugin location")
        const { db } = yield* Database.Service
        const latest = yield* db.select({ id: SessionInputTable.id }).from(SessionInputTable)
          .where(eq(SessionInputTable.session_id, sessionID)).orderBy(desc(SessionInputTable.admitted_seq))
          .limit(1).get().pipe(Effect.orDie)
        return { id: latest?.id ?? null }
      })),
      prompt: (request) => run(Effect.gen(function* () {
        const sessions = yield* SessionV2.Service
        const sessionID = SessionSchema.ID.make(request.sessionID)
        const session = yield* sessions.get(sessionID)
        if (!(yield* Effect.promise(() => samePluginScope(session.location.directory, input.directory)))) throw new Error("Session belongs to another plugin location")
        const id = request.goal ? SessionMessage.ID.create() : undefined
        const goalStatus = request.goal ? JSON.stringify({ ...JSON.parse(request.goal.status), active: { promptID: id } }) : undefined
        // The host, not request text, attests plugin-generated admissions.
        const admitted = yield* sessions.prompt({
          sessionID,
          ...(id ? { id } : {}),
          ...(request.goal ? {
            expectedMetadata: { "opencode.session.goal": request.goal.condition, "opencode.session.goal_run": request.goal.runID, "opencode.session.goal_status": request.goal.expectedStatus },
            metadataPatchOnAdmission: { set: { "opencode.session.goal_status": goalStatus } },
          } : {}),
          prompt: {
            text: request.text,
            ...(request.format === undefined ? {} : { format: Schema.decodeUnknownSync(OutputFormat)(request.format) }),
          },
          origin: "plugin",
          ...(request.expectedLatestInputID === undefined ? {} : {
            expectedLatestInputID: request.expectedLatestInputID === null ? null : SessionMessage.ID.make(request.expectedLatestInputID),
          }),
        })
        return { id: admitted.id, ...(goalStatus ? { goalStatus } : {}) }
      })),
      inputOrigin: (request) => run(Effect.gen(function* () {
        const { db } = yield* Database.Service
        const row = yield* db
          .select({ origin: SessionInputTable.origin })
          .from(SessionInputTable)
          .where(
            and(
              eq(SessionInputTable.id, SessionMessage.ID.make(request.inputID)),
              eq(SessionInputTable.session_id, SessionSchema.ID.make(request.sessionID)),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        return row?.origin ?? "unknown"
      })),
      exists: (sessionID) => run(Effect.gen(function* () {
        const active = yield* (yield* SessionV2.Service).get(SessionSchema.ID.make(sessionID)).pipe(Effect.option)
        if (active._tag === "Some") return yield* Effect.promise(() => samePluginScope(active.value.location.directory, input.directory))
        const archive = yield* Effect.serviceOption(SessionArchive.Service)
        if (archive._tag === "None") return false
        return yield* archive.value.getCatalog(SessionSchema.ID.make(sessionID)).pipe(
          Effect.flatMap((entry) => entry.location === "archived" ? Effect.promise(() => samePluginScope(entry.directory, input.directory)) : Effect.succeed(false)),
          Effect.catchTag("SessionArchive.NotFoundError", () => Effect.succeed(false)),
        )
      })),
      execution: {
        read: (request) => run(Effect.gen(function* () {
          const session = yield* (yield* SessionV2.Service).get(SessionSchema.ID.make(request.sessionID))
          if (!(yield* Effect.promise(() => samePluginScope(session.location.directory, input.directory)))) return yield* Effect.fail(new Error("Session belongs to another plugin location"))
          return yield* SessionExecutionView.read(yield* Database.Service, request)
        })),
        readMainTask: (request) => {
          const binding = { ...request }
          return run(Effect.gen(function* () {
            const sessions = yield* SessionV2.Service
            const assertScope = Effect.gen(function* () {
              for (const id of [binding.parentSessionID, binding.sessionID]) {
                const session = yield* sessions.get(SessionSchema.ID.make(id))
                if (!(yield* Effect.promise(() => samePluginScope(session.location.directory, input.directory))))
                  return yield* Effect.fail(new Error("Session belongs to another plugin location"))
              }
            })
            yield* assertScope
            const observation = yield* SessionExecutionView.readMainTask(yield* Database.Service, binding)
            yield* assertScope
            return observation
          }))
        },
      },
      links: {
        get: (sessionID) => run(Effect.gen(function* () {
          const link = yield* (yield* SessionLinks.Service).get({ pluginID: input.pluginID, sessionID: SessionSchema.ID.make(sessionID) })
          return link && identity(link)
        })),
        start: (request) => run(Effect.gen(function* () {
          const sessions = yield* SessionV2.Service
          const target = yield* sessions.get(SessionSchema.ID.make(request.targetSessionID))
          if (!(yield* Effect.promise(() => samePluginScope(target.location.directory, input.directory)))) return yield* Effect.fail(new Error("Session belongs to another plugin location"))
          const links = yield* SessionLinks.Service
          return identity(yield* links.start({
            ...request, pluginID: input.pluginID,
            sourceSessionID: SessionSchema.ID.make(request.sourceSessionID), targetSessionID: SessionSchema.ID.make(request.targetSessionID),
            agent: AgentV2.ID.make(request.agent), model: request.model ? Schema.decodeUnknownSync(ModelV2.Ref)(request.model) : undefined,
          }, sessions.create))
        })),
        end: (sourceSessionID) => run(Effect.gen(function* () {
          yield* (yield* SessionLinks.Service).end({ pluginID: input.pluginID, sourceSessionID: SessionSchema.ID.make(sourceSessionID) })
        })),
        read: (sourceSessionID) => run(Effect.gen(function* () {
          return yield* (yield* SessionLinks.Service).read({ pluginID: input.pluginID, sourceSessionID: SessionSchema.ID.make(sourceSessionID) })
        })),
      },
      dispatch: {
        send: (request) => run(Effect.gen(function* () {
          return yield* (yield* SessionLinks.Service).send({ ...request, pluginID: input.pluginID,
            sourceSessionID: SessionSchema.ID.make(request.sourceSessionID), sourceMessageID: SessionMessage.ID.make(request.sourceMessageID),
          })
        })),
      },
    },
    agents: {
      register: (agent) => run(Effect.gen(function* () {
        const agents = yield* AgentV2.Service
        yield* agents.update((editor) => {
          if (editor.get(AgentV2.ID.make(agent.id))) throw new Error(`Agent already registered: ${agent.id}`)
          editor.update(AgentV2.ID.make(agent.id), (item) => {
            item.system = agent.system
            item.description = agent.description
            item.mode = agent.mode ?? "all"
            item.hidden = agent.hidden ?? false
            item.tools = agent.tools
            item.permissions = agent.permissions ?? []
          })
        })
      }), true),
    },
    tools: {
      register: (definitions) => run(Effect.gen(function* () {
        const location = yield* Location.Service
        const permission = yield* Effect.serviceOption(PermissionV2.Service)
        const documents = yield* Effect.serviceOption(SessionPlanDocument.Service)
        const surface = yield* Effect.serviceOption(Surface.Service)
        const adapted = Object.entries(definitions).map(([name, definition]) => [
          name,
          LocalTool.adapt({
            ...definition,
            execute(args, context) {
              const signal = AbortSignal.any([context.abort, controller.signal])
              return new Promise((resolve, reject) => {
                const abort = () => reject(new Error("Plugin tool execution was cancelled"))
                if (signal.aborted) return abort()
                signal.addEventListener("abort", abort, { once: true })
                Promise.resolve().then(() => {
                  if (signal.aborted) throw new Error("Plugin tool execution was cancelled")
                  return CrashActivity.trackPromise(
                    { kind: "plugin", pluginID: input.pluginID, sessionID: context.sessionID, name: `tool.${name}` },
                    async () => definition.execute(args, { ...context, abort: signal }),
                  )
                }).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
              })
            },
          }, location, { permission, documents, surface }),
        ] as const)
        // Always-visible protocol tools (for example the scheduler result tool)
        // must survive idle eviction of the location service scope: the
        // per-location tool registry is replaced wholesale when the idle
        // location cache drops the scope and plugin.init() never re-runs, so a
        // scheduled run that wakes an idle project would silently lose its
        // contracted result tool while the plugin's completion policy survives
        // and forces an unwinnable loop. The application-level registry lives
        // outside that scope and every location materialization merges its
        // entries. The global entry is added only after the scoped registration
        // succeeded and is removed when the plugin host unloads, so disabling a
        // plugin cannot leave an executable ghost behind; surviving a location
        // eviction is unaffected because eviction never closes the plugin host
        // scope. Always-visible plugin tools must stay location-independent:
        // the adapted closure binds the registering location's services, and
        // after eviction every location would run that first binding.
        const alwaysVisible = adapted.filter(([, tool]) => isAlwaysVisible(tool))
        const applicationTools = alwaysVisible.length > 0
          ? yield* Effect.serviceOption(ApplicationTools.Service)
          : undefined
        if (alwaysVisible.length > 0 && applicationTools?._tag !== "Some")
          yield* Effect.logWarning(
            "always-visible plugin tool registered without an application registry; it will be lost when the location scope is evicted",
            { pluginID: input.pluginID, tools: alwaysVisible.map(([name]) => name) },
          )
        yield* (yield* Tools.Service).register(Object.fromEntries(adapted))
        if (applicationTools?._tag === "Some" && alwaysVisible.length > 0) {
          const applicationRegistry = applicationTools.value
          const globalTools = alwaysVisible.map(([, tool]) => tool)
          yield* applicationRegistry.register(Object.fromEntries(alwaysVisible))
          yield* Effect.addFinalizer(() => applicationRegistry.unregister(globalTools))
        }
      }), true),
    },
  }
  return { host, dispose }
}
