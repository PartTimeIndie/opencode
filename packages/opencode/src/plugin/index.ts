import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { createHash } from "node:crypto"
import type {
  Hooks,
  PluginInput,
  Plugin as PluginInstance,
  PluginModule,
  WorkspaceAdapter as PluginWorkspaceAdapter,
} from "@opencode-ai/plugin"
import { Config } from "@/config/config"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { ServerAuth } from "@/server/auth"
import { Session } from "@/session/session"
import { NamedError } from "@opencode-ai/core/util/error"
import { Effect, Layer, Context } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { errorMessage } from "@opencode-ai/core/util/error"
import { PluginLoader } from "./loader"
import { builtinServerPlugins } from "./builtin-server"
import { legacyServerPlugins, parsePluginSpecifier, readPluginId, readV1Plugin, resolvePluginId } from "./shared"
import { registerAdapter } from "@/control-plane/adapters"
import type { WorkspaceAdapter } from "@/control-plane/types"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstallationChannel } from "@opencode-ai/core/installation/version"
import type { ServerServiceCall } from "@opencode-ai/plugin/server"
import { createPluginServiceRegistry, PluginServiceError, type PluginServiceCaller } from "./services"
import { createPluginHost } from "./host"
import { SessionV2 } from "@opencode-ai/core/session"
import { Database } from "@opencode-ai/core/database/database"
import { ShellEnvironment } from "@opencode-ai/core/shell-environment"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { sessionRuntimeLayer } from "@opencode-ai/server/handlers"
import { absolutePluginDirectory, sameDirectory } from "./directory"
import { pluginEventType, runPluginEventHooks } from "./event"
import { registerShellEnvironment } from "./shell-environment"
import { CrashActivity } from "@opencode-ai/core/observability/crash-activity"

type PluginHooks = { pluginID: string; hooks: Hooks }
type State = {
  hooks: PluginHooks[]
  services: ReturnType<typeof createPluginServiceRegistry>
  directory: string
  projectID: string
}

// Hook names that follow the (input, output) => Promise<void> trigger pattern
type TriggerName = {
  [K in keyof Hooks]-?: NonNullable<Hooks[K]> extends (input: any, output: any) => Promise<void> ? K : never
}[keyof Hooks]

export interface Interface {
  readonly trigger: <
    Name extends TriggerName,
    Input = Parameters<Required<Hooks>[Name]>[0],
    Output = Parameters<Required<Hooks>[Name]>[1],
  >(
    name: Name,
    input: Input,
    output: Output,
  ) => Effect.Effect<Output>
  readonly list: () => Effect.Effect<Hooks[]>
  readonly init: () => Effect.Effect<void>
  readonly call: (
    request: ServerServiceCall,
    caller: Pick<PluginServiceCaller, "pluginID" | "signal" | "capabilities"> & { sessionID?: string },
  ) => Effect.Effect<unknown, PluginServiceError | Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Plugin") {}

export function experimentalWebSocketsEnabled(input: { enabled: boolean; channel?: string }) {
  return input.enabled || ["local", "dev", "beta"].includes(input.channel ?? InstallationChannel)
}

async function applyPlugin(
  load: PluginLoader.Loaded,
  input: Omit<PluginInput, "services" | "host">,
  hooks: PluginHooks[],
  services: State["services"],
  disposers: Array<() => Promise<void>>,
  bridge: EffectBridge.Shape,
) {
  const plugin = readV1Plugin(load.mod, load.spec, "server", "detect")
  const pluginID =
    !plugin && load.source === "file"
      ? `legacy-${createHash("sha256").update(load.target).digest("hex")}`
      : await resolvePluginId(load.source, load.spec, load.target, readPluginId(plugin?.id, load.spec), load.pkg)
  const binding = services.bind({ pluginID, directory: input.directory, projectID: input.project.id })
  disposers.push(binding.dispose)
  const hostBinding = createPluginHost({ pluginID, directory: input.directory, bridge, disposers })
  const initialization = { kind: "plugin", pluginID, name: "server.initialize" } as const
  try {
    if (plugin) {
      hooks.push({ pluginID, hooks: await CrashActivity.trackPromise(initialization,
        () => (plugin as PluginModule).server(
          { ...input, services: binding.services, host: hostBinding.host },
          load.options,
        ),
      ) })
      return
    }

    for (const server of legacyServerPlugins(load.mod)) {
      hooks.push({ pluginID, hooks: await CrashActivity.trackPromise(initialization,
        () => (server as PluginInstance)(
          { ...input, services: binding.services, host: hostBinding.host },
          load.options,
        ),
      ) })
    }
  } catch (error) {
    await Promise.all([binding.dispose(), hostBinding.dispose()])
    throw error
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const config = yield* Config.Service
    const flags = yield* RuntimeFlags.Service
    const sessions = yield* SessionV2.Service
    const database = yield* Database.Service
    const shellEnvironment = yield* ShellEnvironment.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("Plugin.state")(function* (ctx) {
        const directory = absolutePluginDirectory(ctx.directory)
        const hooks: PluginHooks[] = []
        const services = createPluginServiceRegistry({
          authorize: ({ caller, target }) =>
            caller.capabilities?.includes(`services:${target.pluginID}:${target.serviceID}`) ?? false,
        })
        const disposers: Array<() => Promise<void>> = []
        // Register before initialization so partial loads are cleaned as well.
        // Services must stop accepting work before plugin dispose hooks run.
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* Effect.forEach(
              disposers,
              (dispose) =>
                Effect.tryPromise({
                  try: dispose,
                  catch: errorMessage,
                }).pipe(
                  Effect.tapError((error) => Effect.logError("plugin service disposal failed", { error })),
                  Effect.ignore,
                ),
              { discard: true, concurrency: "unbounded" },
            )
            yield* Effect.forEach(
              hooks,
              ({ pluginID, hooks: hook }) =>
                Effect.tryPromise({
                  try: () => hook.dispose
                    ? CrashActivity.trackPromise({ kind: "plugin", pluginID, name: "server.dispose" },
                        async () => hook.dispose!())
                    : Promise.resolve(),
                  catch: errorMessage,
                }).pipe(
                  Effect.tapError((error) => Effect.logError("plugin dispose hook failed", { error })),
                  Effect.ignore,
                ),
              { discard: true },
            )
          }),
        )
        // Deferred instance callbacks must retain the host services, not just
        // the location layer's public services, which do not export Database.
        const bridge = yield* EffectBridge.make().pipe(
          Effect.provideService(SessionV2.Service, sessions),
          Effect.provideService(Database.Service, database),
        )

        function publishPluginError(message: string) {
          bridge.fork(events.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() }))
        }

        const { Server } = yield* Effect.promise(() => import("../server/server"))

        const serverUrl = Server.url
        const inProcessFetch: typeof fetch | undefined = serverUrl
          ? undefined
          : Object.assign(
              (request: RequestInfo | URL, init?: RequestInit) =>
                Promise.resolve(Server.Default().app.fetch(new Request(request, init))),
              { preconnect: fetch.preconnect },
            )
        const clientOptions = {
          baseUrl: serverUrl?.toString() ?? "http://localhost:4096",
          directory,
          headers: ServerAuth.headers(),
          ...(inProcessFetch ? { fetch: inProcessFetch } : {}),
        }
        const client = createOpencodeClient(clientOptions)
        const sdkV2 = yield* Effect.promise(() => import("@opencode-ai/sdk/v2"))
        const clientV2 = sdkV2.createOpencodeClient(clientOptions)
        const cfg = yield* config.get()
        const input: Omit<PluginInput, "services" | "host"> = {
          client,
          clientV2,
          project: ctx.project,
          worktree: ctx.worktree,
          directory,
          experimental_workspace: {
            register(type: string, adapter: PluginWorkspaceAdapter) {
              registerAdapter(ctx.project.id, type, adapter as WorkspaceAdapter)
            },
          },
          get serverUrl(): URL {
            return Server.url ?? new URL("http://localhost:4096")
          },
          // @ts-expect-error
          $: typeof Bun === "undefined" ? undefined : Bun.$,
        }

        const configured = flags.pure ? [] : (cfg.plugin_origins ?? [])
        if (configured.length) yield* config.waitForDependencies()
        const plugins = [
          ...(flags.disableDefaultPlugins
            ? []
            : builtinServerPlugins({
                experimentalWebSockets: experimentalWebSocketsEnabled({ enabled: flags.experimentalWebSockets }),
              })),
          ...configured,
        ]

        const loaded = yield* Effect.promise(() =>
          PluginLoader.loadExternal({
            items: plugins,
            kind: "server",
            report: {
              start(candidate) {},
              missing(candidate, _retry, message) {},
              error(candidate, _retry, stage, error, resolved) {
                const spec = candidate.plan.spec
                const cause = error instanceof Error ? (error.cause ?? error) : error
                const message = stage === "load" ? errorMessage(error) : errorMessage(cause)

                if (stage === "install") {
                  const parsed = parsePluginSpecifier(spec)
                  publishPluginError(`Failed to install plugin ${parsed.pkg}@${parsed.version}: ${message}`)
                  return
                }

                if (stage === "compatibility") {
                  publishPluginError(`Plugin ${spec} skipped: ${message}`)
                  return
                }

                if (stage === "entry") {
                  publishPluginError(`Failed to load plugin ${spec}: ${message}`)
                  return
                }

                publishPluginError(`Failed to load plugin ${spec}: ${message}`)
              },
            },
          }),
        )
        for (const load of loaded) {
          if (!load) continue

          // Keep plugin execution sequential so hook registration and execution
          // order remains deterministic across plugin runs.
          yield* Effect.tryPromise({
            try: () => applyPlugin(load, input, hooks, services, disposers, bridge),
            catch: (err) => {
              const message = errorMessage(err)
              return message
            },
          }).pipe(
            Effect.tapError((error) => Effect.logError("failed to load plugin", { path: load.spec, error })),
            Effect.catch(() => {
              // TODO: make proper events for this
              // events.publish(Session.Event.Error, {
              //   error: new NamedError.Unknown({
              //     message: `Failed to load plugin ${load.spec}: ${message}`,
              //   }).toObject(),
              // })
              return Effect.void
            }),
          )
        }

        // Notify plugins of current config
        for (const { pluginID, hooks: hook } of hooks) {
          yield* Effect.tryPromise({
            try: () => hook.config
              ? CrashActivity.trackPromise({ kind: "plugin", pluginID, name: "server.config" },
                  async () => (hook as any).config(cfg))
              : Promise.resolve(),
            catch: errorMessage,
          }).pipe(
            Effect.tapError((error) => Effect.logError("plugin config hook failed", { error })),
            Effect.ignore,
          )
        }

        const unsubscribe = yield* events.listen((event) => {
          if (!event.location?.directory || !sameDirectory(event.location.directory, directory)) return Effect.void
          const input = {
            event: { id: event.id, type: pluginEventType(event.type), properties: event.data } as any,
          }
          return Effect.tryPromise({
            try: () => runPluginEventHooks(hooks.map(({ pluginID, hooks }) => {
              const hook = hooks.event
              return hook && ((event: typeof input) => CrashActivity.trackPromise(
                { kind: "plugin", pluginID, name: "server.event" }, async () => hook(event),
              ))
            }), input),
            catch: errorMessage,
          }).pipe(
            Effect.flatMap((errors) =>
              Effect.forEach(
                errors,
                (error) =>
                  Effect.logError("plugin event hook failed", {
                    event: input.event.type,
                    error: errorMessage(error),
                  }),
                { discard: true },
              ),
            ),
            Effect.tapError((error) => Effect.logError("plugin event dispatch failed", { event: input.event.type, error })),
            Effect.ignore,
            Effect.forkDetach,
            Effect.asVoid,
          )
        })
        yield* Effect.addFinalizer(() => unsubscribe)

        // Host routes rebuild plugin state under a lightweight instance for a
        // directory the main instance already registered; the registry's first
        // handler keeps serving, so a duplicate must not kill the whole init.
        yield* registerShellEnvironment(directory, hooks.map(({ hooks, pluginID }) => ({
          "shell.env": hooks["shell.env"] && ((input, output) => CrashActivity.trackPromise(
            { kind: "plugin", pluginID, sessionID: input.sessionID, name: "server.shell.env" },
            async () => hooks["shell.env"]!(input, output),
          )),
        }))).pipe(
          Effect.provideService(ShellEnvironment.Service, shellEnvironment),
          Effect.tapError((error) =>
            Effect.logWarning("plugin shell environment registration skipped; existing registration stays active for this directory", { directory, error: errorMessage(error) })
          ),
          Effect.ignore,
        )

        return { hooks, services, directory, projectID: ctx.project.id }
      }),
    )

    const trigger = Effect.fn("Plugin.trigger")(function* <
      Name extends TriggerName,
      Input = Parameters<Required<Hooks>[Name]>[0],
      Output = Parameters<Required<Hooks>[Name]>[1],
    >(name: Name, input: Input, output: Output) {
      if (!name) return output
      const s = yield* InstanceState.get(state)
      for (const { pluginID, hooks: hook } of s.hooks) {
        const fn = hook[name] as any
        if (!fn) continue
        yield* Effect.promise(() => CrashActivity.trackPromise(
          { kind: "plugin", pluginID, name: `server.${name}` }, async () => fn(input, output),
        ))
      }
      return output
    })

    const list = Effect.fn("Plugin.list")(function* () {
      const s = yield* InstanceState.get(state)
      return s.hooks.map(({ hooks }) => hooks)
    })

    const init = Effect.fn("Plugin.init")(function* () {
      yield* InstanceState.get(state)
    })

    const call: Interface["call"] = (request, caller) =>
      Effect.gen(function* () {
        const s = yield* InstanceState.get(state)
        return yield* Effect.tryPromise({
          try: () => s.services.invoke(request, { ...caller, directory: s.directory, projectID: s.projectID }),
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        })
      })
    return Service.of({ trigger, list, init, call })
  }),
).pipe(
  Layer.provide(sessionRuntimeLayer),
  Layer.provide(LocationServiceMap.layer),
  Layer.provide(Database.defaultLayer),
)

export const defaultLayer = layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(RuntimeFlags.defaultLayer),
)

export const node = LayerNode.make(layer, [EventV2Bridge.node, Config.node, RuntimeFlags.node])

export * as Plugin from "."
