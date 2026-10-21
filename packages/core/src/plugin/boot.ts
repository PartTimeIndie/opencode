export * as PluginBoot from "./boot"

import { Context, Deferred, Effect, Layer } from "effect"
import { Credential } from "../credential"
import { Integration } from "../integration"
import { AgentV2 } from "../agent"
import { Catalog } from "../catalog"
import { CommandV2 } from "../command"
import { Config } from "../config"
import { ConfigAgentPlugin } from "../config/plugin/agent"
import { ConfigCommandPlugin } from "../config/plugin/command"
import { ConfigSkillPlugin } from "../config/plugin/skill"
import { ConfigReferencePlugin } from "../config/plugin/reference"
import { EventV2 } from "../event"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { Location } from "../location"
import { ModelsDev } from "../models-dev"
import { Npm } from "../npm"
import { PluginV2 } from "../plugin"
import { AgentPlugin } from "./agent"
import { CommandPlugin } from "./command"
import { SkillPlugin } from "./skill"
import { SkillCommandPlugin } from "./skill-command"
import { ConfigProviderPlugin } from "../config/plugin/provider"
import { ModelsDevPlugin } from "./models-dev"
import { McpCommandPlugin } from "./mcp-command"
import { ProviderCacheMigrations, ProviderPackages } from "./provider"
import { loadProviderPackage, migrateProviderCaches, providerPackageDirectory } from "./provider-loader"
import { providerRegistration } from "./provider-host"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { SkillV2 } from "../skill"
import { Reference } from "../reference"
import { McpPrompt } from "../mcp/prompt"

type Plugin = {
  id: PluginV2.ID
  requestProfiles?: import("@opencode-ai/plugin/provider").ProviderPluginModule["requestProfiles"]
  nativeModels?: import("@opencode-ai/plugin/provider").ProviderPluginModule["nativeModels"]
  effect: PluginV2.Effect<
    | Catalog.Service
    | CommandV2.Service
    | Credential.Service
    | Integration.Service
    | AgentV2.Service
    | Npm.Service
    | EventV2.Service
    | FSUtil.Service
    | Global.Service
    | Location.Service
    | PluginV2.Service
    | Config.Service
    | ModelsDev.Service
    | SkillV2.Service
    | Reference.Service
    | McpPrompt.Service
  >
}

export interface Interface {
  readonly wait: (options?: { mcpCommands?: boolean }) => Effect.Effect<void>
  readonly refreshMcpCommands: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/PluginBoot") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const commands = yield* CommandV2.Service
    const plugin = yield* PluginV2.Service
    const credentials = yield* Credential.Service
    const integrations = yield* Integration.Service
    const agents = yield* AgentV2.Service
    const config = yield* Config.Service
    const location = yield* Location.Service
    const modelsDev = yield* ModelsDev.Service
    const npm = yield* Npm.Service
    const events = yield* EventV2.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const skill = yield* SkillV2.Service
    const references = yield* Reference.Service
    const mcpPrompt = yield* McpPrompt.Service
    const done = yield* Deferred.make<void>()
    const mcpCommandsDone = yield* Deferred.make<void>()

    const add = Effect.fn("PluginBoot.add")(function* (input: Plugin) {
      yield* plugin.add({
        id: input.id,
        requestProfiles: input.requestProfiles,
        nativeModels: input.nativeModels,
        effect: input.effect.pipe(
          Effect.provideService(Catalog.Service, catalog),
          Effect.provideService(CommandV2.Service, commands),
          Effect.provideService(Credential.Service, credentials),
          Effect.provideService(Integration.Service, integrations),
          Effect.provideService(AgentV2.Service, agents),
          Effect.provideService(Config.Service, config),
          Effect.provideService(Location.Service, location),
          Effect.provideService(ModelsDev.Service, modelsDev),
          Effect.provideService(Npm.Service, npm),
          Effect.provideService(EventV2.Service, events),
          Effect.provideService(FSUtil.Service, fs),
          Effect.provideService(Global.Service, global),
          Effect.provideService(SkillV2.Service, skill),
          Effect.provideService(Reference.Service, references),
          Effect.provideService(McpPrompt.Service, mcpPrompt),
          Effect.provideService(PluginV2.Service, plugin),
        ),
      })
    })

    const boot = Effect.gen(function* () {
      yield* add(AgentPlugin.Plugin)
      yield* add(CommandPlugin.Plugin)
      yield* add(SkillPlugin.Plugin)
      yield* Effect.promise(() => migrateProviderCaches(global.cache, ProviderCacheMigrations))
      const directory = providerPackageDirectory()
      const entries = [
        ...ProviderPackages.map((name) => ({ package: pathToFileURL(path.join(directory, name)).href, options: undefined as Readonly<Record<string, unknown>> | undefined })),
        ...(yield* config.entries()).flatMap((entry) => entry.type !== "document" ? [] : (entry.info.plugins ?? []).map((value) => {
          const item = typeof value === "string" ? { package: value, options: undefined } : value
          return { ...item, package: item.package.startsWith(".") && entry.path
            ? pathToFileURL(path.resolve(path.dirname(entry.path), item.package)).href : item.package }
        })),
      ]
      const loaded = yield* Effect.promise((signal) => Promise.all(entries.map(async (item) => ({
        module: await loadProviderPackage(item.package, (specifier) => Effect.runPromise(npm.add(specifier), { signal }).then((resolved) => resolved.directory)),
        options: item.options,
      }))))
      for (const item of loaded) {
        if (item.module) yield* add(providerRegistration(item.module, item.options))
      }
      yield* add(ModelsDevPlugin)
      yield* add(ConfigProviderPlugin.Plugin)
      yield* add(ConfigAgentPlugin.Plugin)
      yield* add(ConfigCommandPlugin.Plugin)
      yield* add(ConfigSkillPlugin.Plugin)
      yield* add(SkillCommandPlugin.Plugin)
      yield* add(ConfigReferencePlugin.Plugin)
    }).pipe(Effect.withSpan("PluginBoot.boot"))

    yield* boot.pipe(Deferred.into(done), Effect.forkScoped)

    const refreshMcpCommands = () => add(McpCommandPlugin.Plugin)

    yield* Deferred.await(done).pipe(
      Effect.andThen(refreshMcpCommands()),
      Effect.withSpan("PluginBoot.mcpCommands"),
      Deferred.into(mcpCommandsDone),
      Effect.forkScoped,
    )

    return Service.of({
      wait: (options) => Deferred.await(options?.mcpCommands ? mcpCommandsDone : done),
      refreshMcpCommands,
    })
  }),
)

export const locationLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provideMerge(Integration.locationLayer),
    Layer.provideMerge(Catalog.locationLayer),
    Layer.provideMerge(CommandV2.locationLayer),
    Layer.provideMerge(Config.locationLayer),
    Layer.provideMerge(AgentV2.locationLayer),
     Layer.provideMerge(SkillV2.locationLayer.pipe(Layer.provideMerge(Config.locationLayer))),
    Layer.provideMerge(Reference.locationLayer),
    Layer.provideMerge(McpPrompt.locationLayer),
  ),
)
