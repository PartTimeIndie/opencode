import type {
  ProviderPluginModule,
  ProviderConfigurationHost,
  ProviderConfigurationResult,
  ProviderTransport,
} from "@opencode-ai/plugin/provider"
import { ProviderPackages, ProviderCacheMigrations } from "@opencode-ai/core/plugin/provider"
import {
  loadProviderPackage,
  migrateProviderCaches,
  providerPackageDirectory,
  readProviderCache,
} from "@opencode-ai/core/plugin/provider-loader"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import fuzzysort from "fuzzysort"
import { Config } from "@/config/config"
import { mapValues, mergeDeep, omit, pickBy, sortBy } from "remeda"
import { NoSuchModelError } from "ai"
import { Npm } from "@opencode-ai/core/npm"
import { Hash } from "@opencode-ai/core/util/hash"
import { Plugin } from "../plugin"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { type LanguageModelV3 } from "@ai-sdk/provider"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { Credential } from "@opencode-ai/core/credential"
import { applyAudioPurposeCapabilities } from "@opencode-ai/core/audio-model-purpose"
import { Auth } from "../auth"
import { Env } from "../env"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { iife } from "@/util/iife"
import { Global } from "@opencode-ai/core/global"
import path from "path"
import { fileURLToPath, pathToFileURL } from "url"
import { Effect, Layer, Context, Schema } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { EffectPromise } from "@/effect/promise"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { isRecord } from "@opencode-ai/core/util/record"
import { ProviderTransform } from "./transform"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderError } from "./error"
import {
  ConfigProvidersResult,
  Info,
  InitError,
  ListResult,
  Model,
  ModelNotFoundError,
  NoModelsError,
  NoProvidersError,
  type DefaultModelError,
} from "./schema"

export {
  ConfigProvidersResult,
  Info,
  InitError,
  ListResult,
  Model,
  ModelNotFoundError,
  NoModelsError,
  NoProvidersError,
} from "./schema"
export type { DefaultModelError, Error } from "./schema"

type ProviderOptions = Record<string, unknown>
type ProviderFactoryOptions = ProviderOptions & { name: string; baseURL?: string }

function wrapSSE(res: Response, ms: number, ctl: AbortController) {
  if (typeof ms !== "number" || ms <= 0) return res
  if (!res.body) return res
  if (!res.headers.get("content-type")?.includes("text/event-stream")) return res

  const reader = res.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      const part = await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
        const id = setTimeout(() => {
          const err = new ProviderError.ResponseStreamError("SSE read timed out")
          ctl.abort(err)
          void reader.cancel(err).catch(() => {})
          reject(err)
        }, ms)

        reader.read().then(
          (part) => {
            clearTimeout(id)
            resolve(part)
          },
          (err) => {
            clearTimeout(id)
            reject(err)
          },
        )
      })

      if (part.done) {
        ctrl.close()
        return
      }

      ctrl.enqueue(part.value)
    },
    async cancel(reason) {
      ctl.abort(reason)
      await reader.cancel(reason)
    },
  })

  return new Response(body, {
    headers: new Headers(res.headers),
    status: res.status,
    statusText: res.statusText,
  })
}

function timeoutController(ms: number) {
  const ctl = new AbortController()
  const id = setTimeout(() => ctl.abort(new ProviderError.HeaderTimeoutError(ms)), ms)
  return {
    signal: ctl.signal,
    clear: () => clearTimeout(id),
  }
}

type CustomModelLoader = NonNullable<ProviderConfigurationResult["getModel"]>
type CustomVarsLoader = NonNullable<ProviderConfigurationResult["vars"]>
type CustomDiscoverModels = () => Promise<Record<string, Model>>

function callLanguageModel(sdk: ProviderTransport, modelID: string) {
  if (typeof sdk.languageModel === "function") return sdk.languageModel(modelID)
  if (typeof sdk === "function") return sdk(modelID)
  throw new Error("Provider SDK does not expose a language model factory")
}

export function toPublicInfo(provider: Info): Info {
  return JSON.parse(
    JSON.stringify(provider, (_, value) => {
      if (typeof value === "function" || typeof value === "symbol" || value === undefined) return undefined
      if (typeof value === "bigint") return value.toString()
      return value
    }),
  )
}

export function defaultModelIDs<T extends { models: Record<string, { id: string }> }>(providers: Record<string, T>) {
  return Object.fromEntries(
    Object.entries(providers).flatMap(([id, item]) => {
      const model = sort(Object.values(item.models))[0]
      return model ? [[id, model.id]] : []
    }),
  )
}

export interface Interface {
  readonly list: () => Effect.Effect<Record<ProviderV2.ID, Info>>
  readonly getProvider: (providerID: ProviderV2.ID) => Effect.Effect<Info>
  readonly getModel: (providerID: ProviderV2.ID, modelID: ModelV2.ID) => Effect.Effect<Model, ModelNotFoundError>
  readonly getLanguage: (model: Model) => Effect.Effect<LanguageModelV3, ModelNotFoundError | InitError>
  readonly closest: (
    providerID: ProviderV2.ID,
    query: string[],
  ) => Effect.Effect<{ providerID: ProviderV2.ID; modelID: string } | undefined>
  readonly getSmallModel: (providerID: ProviderV2.ID) => Effect.Effect<Model | undefined>
  readonly defaultModel: () => Effect.Effect<{ providerID: ProviderV2.ID; modelID: ModelV2.ID }, DefaultModelError>
}

interface State {
  signal: AbortSignal
  providerPackages: ProviderPluginModule[]
  models: Map<string, LanguageModelV3>
  providers: Record<ProviderV2.ID, Info>
  catalog: Record<ProviderV2.ID, Info>
  sdk: Map<string, ProviderTransport>
  modelLoaders: Record<string, CustomModelLoader>
  varsLoaders: Record<string, CustomVarsLoader>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Provider") {}

export const use = serviceUse(Service)

function cost(c: ModelsDev.Model["cost"]): Model["cost"] {
  const result: Model["cost"] = {
    input: c?.input ?? 0,
    output: c?.output ?? 0,
    cache: {
      read: c?.cache_read ?? 0,
      write: c?.cache_write ?? 0,
    },
  }
  if (c?.tiers) {
    result.tiers = c.tiers.map((item) => ({
      input: item.input,
      output: item.output,
      cache: {
        read: item.cache_read ?? 0,
        write: item.cache_write ?? 0,
      },
      tier: item.tier,
    }))
  }
  if (c?.context_over_200k) {
    result.experimentalOver200K = {
      cache: {
        read: c.context_over_200k.cache_read ?? 0,
        write: c.context_over_200k.cache_write ?? 0,
      },
      input: c.context_over_200k.input,
      output: c.context_over_200k.output,
    }
  }
  return result
}

function normalizeInterleaved(value: unknown): Model["capabilities"]["interleaved"] {
  if (value === undefined || value === false) return false
  if (value === true || typeof value === "string") return true
  if (!isRecord(value)) return false
  if (
    value.field === "reasoning" ||
    value.field === "reasoning_content" ||
    value.field === "reasoning_details"
  ) {
    return { field: value.field }
  }
  return true
}

function fromModelsDevModel(
  provider: ModelsDev.Provider,
  model: ModelsDev.Model,
  modules: readonly ProviderPluginModule[],
): Model {
  const base: Model = {
    id: ModelV2.ID.make(model.id),
    providerID: ProviderV2.ID.make(provider.id),
    name: model.name,
    family: model.family,
    api: {
      id: model.id,
      url: model.provider?.api ?? provider.api ?? "",
      npm: model.provider?.npm ?? provider.npm ?? "@ai-sdk/openai-compatible",
    },
    status: model.status ?? "active",
    headers: {},
    options: {},
    cost: cost(model.cost),
    limit: {
      context: model.limit.context,
      input: model.limit.input,
      output: model.limit.output,
    },
    capabilities: {
      temperature: model.temperature ?? false,
      reasoning: model.reasoning ?? false,
      attachment: model.attachment ?? false,
      toolcall: model.tool_call ?? true,
      input: {
        text: model.modalities?.input?.includes("text") ?? false,
        audio: model.modalities?.input?.includes("audio") ?? false,
        image: model.modalities?.input?.includes("image") ?? false,
        video: model.modalities?.input?.includes("video") ?? false,
        pdf: model.modalities?.input?.includes("pdf") ?? false,
      },
      output: {
        text: model.modalities?.output?.includes("text") ?? false,
        audio: model.modalities?.output?.includes("audio") ?? false,
        image: model.modalities?.output?.includes("image") ?? false,
        video: model.modalities?.output?.includes("video") ?? false,
        pdf: model.modalities?.output?.includes("pdf") ?? false,
        transcription: model.modalities?.output?.includes("transcription") ?? false,
        speech: model.modalities?.output?.includes("speech") ?? false,
      },
      interleaved: normalizeInterleaved(model.interleaved),
    },
    release_date: model.release_date ?? "",
    supported_voices: model.supported_voices ? [...model.supported_voices] : undefined,
    variants: {},
  }

  applyAudioPurposeCapabilities(model.id, base.capabilities)
  ProviderTransform.bindModel(base, modules)

  return {
    ...base,
    variants: mapValues(ProviderTransform.variants(base), (v) => v),
  }
}

export function fromModelsDevProvider(
  provider: ModelsDev.Provider,
  modules: readonly ProviderPluginModule[] = [],
): Info {
  const models: Record<string, Model> = {}
  for (const [key, model] of Object.entries(provider.models)) {
    models[key] = fromModelsDevModel(provider, model, modules)
    for (const [mode, opts] of Object.entries(model.experimental?.modes ?? {})) {
      const id = `${model.id}-${mode}`
      const base = fromModelsDevModel(provider, model, modules)
      models[id] = {
        ...base,
        id: ModelV2.ID.make(id),
        name: `${model.name} ${mode[0].toUpperCase()}${mode.slice(1)}`,
        cost: opts.cost ? mergeDeep(base.cost, cost(opts.cost)) : base.cost,
        options: opts.provider?.body
          ? Object.fromEntries(
              Object.entries(opts.provider.body).map(([k, v]) => [
                k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()),
                v,
              ]),
            )
          : base.options,
        headers: opts.provider?.headers ?? base.headers,
      }
    }
  }
  return {
    id: ProviderV2.ID.make(provider.id),
    source: "custom",
    name: provider.name,
    env: [...(provider.env ?? [])],
    options: {},
    models,
  }
}

function modelSuggestions(provider: Info | undefined, modelID: ModelV2.ID, enableExperimentalModels: boolean) {
  const available = provider
    ? Object.keys(provider.models).filter((id) => {
        const model = provider.models[id]
        if (model.status === "deprecated") return false
        if (model.status === "alpha" && !enableExperimentalModels) return false
        return true
      })
    : []
  const fuzzy = fuzzysort.go(modelID, available, { limit: 3, threshold: -10000 }).map((m) => m.target)
  if (fuzzy.length) return fuzzy
  const query = modelID
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length > 1)
  return sortBy(
    available
      .map((id) => ({
        id,
        score: query.filter((part) => id.toLowerCase().includes(part)).length,
      }))
      .filter((item) => item.score > 0),
    [(item) => item.score, "desc"],
    [(item) => item.id, "asc"],
  )
    .slice(0, 3)
    .map((item) => item.id)
}

async function resolvePackageEntrypoint(dir: string) {
  const { readFile } = await import("fs/promises")
  const pkg = await readFile(path.join(dir, "package.json"), "utf8")
    .then((content) => JSON.parse(content) as unknown)
    .catch(() => undefined)
  const entry = packageEntrypoint(pkg)
  if (!entry) return
  if (entry.startsWith("file://") || path.isAbsolute(entry)) return entry
  return path.join(dir, entry)
}

async function resolveImportEntrypoint(entrypoint: string | undefined, dir: string) {
  if (!entrypoint) return resolvePackageEntrypoint(dir)
  const target = entrypoint.startsWith("file://") ? fileURLToPath(entrypoint) : entrypoint
  if (path.isAbsolute(target) && (await isDirectory(target))) return resolvePackageEntrypoint(dir)
  return entrypoint
}

async function isDirectory(input: string) {
  const { stat } = await import("fs/promises")
  return stat(input)
    .then((result) => result.isDirectory())
    .catch(() => false)
}

function packageEntrypoint(pkg: unknown): string | undefined {
  if (!isRecord(pkg)) return
  const exported = exportEntrypoint(pkg.exports)
  if (exported) return exported
  if (typeof pkg.module === "string") return pkg.module
  if (typeof pkg.main === "string") return pkg.main
}

function exportEntrypoint(input: unknown): string | undefined {
  if (typeof input === "string") return input
  if (!isRecord(input)) return

  const root = input["."] ?? input
  if (typeof root === "string") return root
  if (!isRecord(root)) return

  return [root.import, root.default, root.module, root.require].find((item): item is string => typeof item === "string")
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const config = yield* Config.Service
    const auth = yield* Auth.Service
    const env = yield* Env.Service
    const credential = yield* Credential.Service
    const plugin = yield* Plugin.Service
    const modelsDevSvc = yield* ModelsDev.Service
    const runtimeFlags = yield* RuntimeFlags.Service

    const state = yield* InstanceState.make<State>(() =>
      Effect.gen(function* () {
        const bridge = yield* EffectBridge.make()
        const cfg = yield* config.get()
        const directory = yield* InstanceState.directory
        const lifecycle = new AbortController()
        yield* Effect.addFinalizer(() => Effect.sync(() => lifecycle.abort()))
        const providerPackages = yield* Effect.promise(async (signal) => {
          await migrateProviderCaches(Global.Path.cache, ProviderCacheMigrations)
          const specs = [
            ...ProviderPackages.map((name) => pathToFileURL(path.join(providerPackageDirectory(), name)).href),
            ...(cfg.plugin ?? []).map((entry) => (typeof entry === "string" ? entry : entry[0])),
          ]
          const modules = new Map<string, ProviderPluginModule>()
          const loaded = await Promise.all(
            specs.map(async (spec) => {
              signal.throwIfAborted()
              return loadProviderPackage(
                spec.startsWith(".") ? pathToFileURL(path.resolve(directory, spec)).href : spec,
                async (specifier) => (await Npm.add(specifier)).directory,
              )
            }),
          )
          for (const module of loaded) if (module) modules.set(module.id, module)
          return [...modules.values()]
        })
        // The auth file is protected by a cross-process journal. Re-reading it
        // for every provider hook makes startup cost grow with journal history.
        // A provider-state build uses one consistent snapshot; callbacks kept
        // by loaders switch back to fresh reads once initialization completes.
        const auths = yield* auth.all().pipe(Effect.orDie)
        let initializing = true
        const configurationHost = (module: ProviderPluginModule): ProviderConfigurationHost => ({
          version: InstallationVersion,
          directory,
          signal: lifecycle.signal,
          sortModels: sort,
          cache: { readJSON: (name) => readProviderCache(Global.Path.cache, module.id, name, lifecycle.signal) },
          auth: (id) => {
            if (id !== module.id && !module.integrations?.includes(id))
              throw new Error("Provider plugin " + module.id + " cannot access integration " + id)
            if (initializing) return Promise.resolve(auths[id])
            return bridge.promise(auth.get(id).pipe(Effect.orDie))
          },
          config: () => bridge.promise(config.get()),
          env: () => bridge.promise(env.all()),
          get: (key) => bridge.promise(env.get(key)),
        })
        const modelsDev = yield* modelsDevSvc.get()
        const catalog = mapValues(modelsDev, (provider) => fromModelsDevProvider(provider, providerPackages))
        const database = mapValues(catalog, toPublicInfo)

        const providers: Record<ProviderV2.ID, Info> = {} as Record<ProviderV2.ID, Info>
        const languages = new Map<string, LanguageModelV3>()
        const modelLoaders: {
          [providerID: string]: CustomModelLoader
        } = {}
        const varsLoaders: {
          [providerID: string]: CustomVarsLoader
        } = {}
        const sdk = new Map<string, ProviderTransport>()
        const discoveryLoaders: {
          [providerID: string]: { discoverModels: CustomDiscoverModels; replace: boolean }
        } = {}

        function mergeProvider(providerID: ProviderV2.ID, provider: Partial<Info>) {
          const existing = providers[providerID]
          if (existing) {
            // @ts-expect-error
            providers[providerID] = mergeDeep(existing, provider)
            return
          }
          const match = database[providerID]
          if (!match) return
          // @ts-expect-error
          providers[providerID] = mergeDeep(match, provider)
        }

        // load plugins first so config() hook runs before reading cfg.provider
        const plugins = yield* plugin.list()

        // now read config providers - includes any modifications from plugin config() hook
        const configProviders = Object.entries(cfg.provider ?? {})
        const disabled = new Set(cfg.disabled_providers ?? [])
        const enabled = cfg.enabled_providers ? new Set(cfg.enabled_providers) : null

        function isProviderAllowed(providerID: ProviderV2.ID): boolean {
          if (enabled && !enabled.has(providerID)) return false
          if (disabled.has(providerID)) return false
          return true
        }

        for (const hook of plugins) {
          const p = hook.provider
          const models = p?.models
          if (!p || !models) continue

          const providerID = ProviderV2.ID.make(p.id)
          if (disabled.has(providerID)) continue

          const provider =
            database[providerID] ??
            (database[providerID] = {
              id: providerID,
              name: p.id,
              env: [],
              options: {},
              source: "custom",
              models: {},
            })
          const pluginAuth = auths[providerID]

          provider.models = yield* Effect.promise(async () => {
            const next = await models(toPublicInfo(provider), { auth: pluginAuth })
            return Object.fromEntries(
              Object.entries(next).map(([id, model]) => [
                id,
                {
                  ...model,
                  id: ModelV2.ID.make(id),
                  providerID,
                },
              ]),
            )
          })
        }

        // extend database from config
        for (const [providerID, provider] of configProviders) {
          const existing = database[providerID]
          const parsed: Info = {
            id: ProviderV2.ID.make(providerID),
            name: provider.name ?? existing?.name ?? providerID,
            env: provider.env ?? existing?.env ?? [],
            options: mergeDeep(existing?.options ?? {}, provider.options ?? {}),
            source: "config",
            models: existing?.models ?? {},
          }

          for (const [modelID, model] of Object.entries(provider.models ?? {})) {
            const existingModel = parsed.models[model.id ?? modelID]
            const apiID = model.id ?? existingModel?.api.id ?? modelID
            const apiNpm =
              model.provider?.npm ??
              provider.npm ??
              existingModel?.api.npm ??
              modelsDev[providerID]?.npm ??
              "@ai-sdk/openai-compatible"
            const name = iife(() => {
              if (model.name) return model.name
              if (model.id && model.id !== modelID) return modelID
              return existingModel?.name ?? modelID
            })
            const defaults = Object.assign(
              {},
              ...providerPackages.map((module) =>
                module.modelDefaults?.({
                  id: modelID,
                  providerID,
                  api: { id: apiID, npm: apiNpm, url: model.provider?.api ?? provider.api ?? "" },
                }),
              ),
            ) as Partial<Model["capabilities"]>
            const parsedModel: Model = {
              id: ModelV2.ID.make(modelID),
              api: {
                id: apiID,
                npm: apiNpm,
                url: model.provider?.api ?? provider?.api ?? existingModel?.api.url ?? modelsDev[providerID]?.api ?? "",
                endpoint: model.provider?.endpoint ?? existingModel?.api.endpoint,
              },
              status: model.status ?? existingModel?.status ?? "active",
              name,
              providerID: ProviderV2.ID.make(providerID),
              capabilities: {
                temperature: model.temperature ?? existingModel?.capabilities.temperature ?? false,
                reasoning: model.reasoning ?? existingModel?.capabilities.reasoning ?? false,
                attachment: model.attachment ?? existingModel?.capabilities.attachment ?? false,
                toolcall: model.tool_call ?? existingModel?.capabilities.toolcall ?? true,
                input: {
                  text: model.modalities?.input?.includes("text") ?? existingModel?.capabilities.input.text ?? true,
                  audio: model.modalities?.input?.includes("audio") ?? existingModel?.capabilities.input.audio ?? false,
                  image: model.modalities?.input?.includes("image") ?? existingModel?.capabilities.input.image ?? false,
                  video: model.modalities?.input?.includes("video") ?? existingModel?.capabilities.input.video ?? false,
                  pdf: model.modalities?.input?.includes("pdf") ?? existingModel?.capabilities.input.pdf ?? false,
                },
                output: {
                  text: model.modalities?.output?.includes("text") ?? existingModel?.capabilities.output.text ?? true,
                  audio:
                    model.modalities?.output?.includes("audio") ?? existingModel?.capabilities.output.audio ?? false,
                  image:
                    model.modalities?.output?.includes("image") ?? existingModel?.capabilities.output.image ?? false,
                  video:
                    model.modalities?.output?.includes("video") ?? existingModel?.capabilities.output.video ?? false,
                  pdf: model.modalities?.output?.includes("pdf") ?? existingModel?.capabilities.output.pdf ?? false,
                  transcription:
                    model.modalities?.output?.some((modality) => (modality as string) === "transcription") ??
                    existingModel?.capabilities.output.transcription ??
                    false,
                  speech:
                    model.modalities?.output?.some((modality) => (modality as string) === "speech") ??
                    existingModel?.capabilities.output.speech ??
                    false,
                },
                interleaved: normalizeInterleaved(
                  model.interleaved ?? existingModel?.capabilities.interleaved ?? defaults.interleaved,
                ),
              },
              cost: {
                input: model?.cost?.input ?? existingModel?.cost?.input ?? 0,
                output: model?.cost?.output ?? existingModel?.cost?.output ?? 0,
                cache: {
                  read: model?.cost?.cache_read ?? existingModel?.cost?.cache.read ?? 0,
                  write: model?.cost?.cache_write ?? existingModel?.cost?.cache.write ?? 0,
                },
              },
              options: mergeDeep(existingModel?.options ?? {}, model.options ?? {}),
              supported_voices: model.supported_voices ?? existingModel?.supported_voices,
              limit: {
                context: model.limit?.context ?? existingModel?.limit?.context ?? 0,
                input: model.limit?.input ?? existingModel?.limit?.input,
                output: model.limit?.output ?? existingModel?.limit?.output ?? 0,
              },
              headers: mergeDeep(existingModel?.headers ?? {}, model.headers ?? {}),
              family: model.family ?? existingModel?.family ?? "",
              release_date: model.release_date ?? existingModel?.release_date ?? "",
              variants: {},
            }
            applyAudioPurposeCapabilities(modelID, parsedModel.capabilities)
            ProviderTransform.bindModel(parsedModel, providerPackages, lifecycle.signal)
            const merged = mergeDeep(ProviderTransform.variants(parsedModel), model.variants ?? {})
            parsedModel.variants = mapValues(
              pickBy(merged, (v) => !v.disabled),
              (v) => omit(v, ["disabled"]),
            )
            parsed.models[modelID] = parsedModel
          }
          database[providerID] = parsed
        }

        // load env
        const envs = yield* env.all()
        for (const [id, provider] of Object.entries(database)) {
          const providerID = ProviderV2.ID.make(id)
          if (disabled.has(providerID)) continue
          const apiKey = provider.env.map((item) => envs[item]).find(Boolean)
          if (!apiKey) continue
          mergeProvider(providerID, {
            source: "env",
            key: provider.env.length === 1 ? apiKey : undefined,
          })
        }

        // load apikeys
        for (const [id, provider] of Object.entries(auths)) {
          const providerID = ProviderV2.ID.make(id)
          if (disabled.has(providerID)) continue
          if (provider.type === "api") {
            mergeProvider(providerID, {
              source: "api",
              key: provider.key,
            })
          }
        }

        // load credentials stored through the app's /connect dialog so those
        // providers resolve their key without an auth.json entry
        const storedCredentials = yield* credential.all().pipe(Effect.orDie)
        for (const entry of storedCredentials) {
          const providerID = ProviderV2.ID.make(entry.integrationID)
          if (disabled.has(providerID)) continue
          if (entry.value.type !== "key") continue
          mergeProvider(providerID, {
            source: "api",
            key: entry.value.key,
          })
        }

        // plugin auth loader - database now has entries for config providers
        for (const plugin of plugins) {
          if (!plugin.auth) continue
          const providerID = ProviderV2.ID.make(plugin.auth.provider)
          if (disabled.has(providerID)) continue

          const stored = auths[providerID]
          if (!stored) continue
          if (!plugin.auth.loader) continue
          const provider = database[providerID]
          if (!provider) {
            yield* Effect.logWarning("skipping plugin auth loader for missing provider", { providerID })
            continue
          }

          // Plugin auth callbacks use the public plugin Auth shape; the stored runtime auth is narrowed at this boundary.
          const loadAuth = (() => Promise.resolve(auths[providerID])) as Parameters<
            NonNullable<typeof plugin.auth.loader>
          >[0]
          const options = yield* Effect.promise(() => plugin.auth!.loader!(loadAuth, toPublicInfo(provider)))
          const opts = options ?? {}
          const patch: Partial<Info> = providers[providerID] ? { options: opts } : { source: "custom", options: opts }
          mergeProvider(providerID, patch)
        }

        for (const module of providerPackages) {
          if (!module.configure) continue
          const id = module.id
          const providerID = ProviderV2.ID.make(id)
          if (disabled.has(providerID)) continue
          const data = database[providerID]
          if (!data) {
            continue
          }
          const result = yield* Effect.promise(() => module.configure!(toPublicInfo(data), configurationHost(module)))
          const configured = cfg.provider?.[providerID] !== undefined
          if (result && (result.autoload || providers[providerID] || configured)) {
            if (result.getModel) modelLoaders[providerID] = result.getModel
            if (result.vars) varsLoaders[providerID] = result.vars
            if (result.discoverModels)
              discoveryLoaders[providerID] = {
                discoverModels: async () =>
                  Object.fromEntries(
                    Object.entries(await result.discoverModels!()).map(([id, model]) => [
                      id,
                      Schema.decodeUnknownSync(Model)(model) as Model,
                    ]),
                  ),
                replace: result.replaceDiscoveredModels ?? false,
              }
            const opts = result.options ?? {}
            const patch: Partial<Info> = providers[providerID]
              ? { options: opts }
              : { source: configured ? "config" : "custom", options: opts }
            mergeProvider(providerID, patch)
          }
        }

        // load config - re-apply with updated data
        for (const [id, provider] of configProviders) {
          const providerID = ProviderV2.ID.make(id)
          const partial: Partial<Info> = { source: "config" }
          if (provider.env) partial.env = provider.env
          if (provider.name) partial.name = provider.name
          if (provider.options) partial.options = provider.options
          mergeProvider(providerID, partial)
        }

        for (const [id, loader] of Object.entries(discoveryLoaders)) {
          const providerID = ProviderV2.ID.make(id)
          if (!providers[providerID] || !isProviderAllowed(providerID)) continue

          const discovered = yield* Effect.tryPromise(() => loader.discoverModels()).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("provider model discovery failed", { providerID, cause }).pipe(Effect.as({})),
            ),
          )
          if (loader.replace) {
            providers[providerID].models = discovered
            continue
          }

          for (const [modelID, model] of Object.entries(discovered)) {
            if (!providers[providerID].models[modelID]) providers[providerID].models[modelID] = model
          }
        }

        for (const module of providerPackages) {
          if (!module.configureCatalog) continue
          yield* Effect.promise(() =>
            module.configureCatalog!({ providers, modelLoaders, varsLoaders, disabled }, configurationHost(module)),
          )
        }
        for (const [id, provider] of Object.entries(providers)) {
          if (provider.id !== id) throw new Error(`Provider catalogue identity changed: ${id}`)
          for (const [modelID, model] of Object.entries(provider.models))
            if (model.id !== modelID || model.providerID !== id)
              throw new Error(`Provider catalogue model identity changed: ${id}/${modelID}`)
        }

        for (const [id, provider] of Object.entries(providers)) {
          const providerID = ProviderV2.ID.make(id)
          if (!isProviderAllowed(providerID)) {
            delete providers[providerID]
            continue
          }

          const configProvider = cfg.provider?.[providerID]

          for (const [modelID, model] of Object.entries(provider.models)) {
            ProviderTransform.bindModel(model, providerPackages, lifecycle.signal)
            model.api.id = model.api.id ?? model.id ?? modelID
            if (model.status === "alpha" && !runtimeFlags.enableExperimentalModels) delete provider.models[modelID]
            if (model.status === "deprecated") delete provider.models[modelID]
            if (
              (configProvider?.blacklist && configProvider.blacklist.includes(modelID)) ||
              (configProvider?.whitelist && !configProvider.whitelist.includes(modelID))
            )
              delete provider.models[modelID]

            if (!model.variants || Object.keys(model.variants).length === 0) {
              model.variants = mapValues(ProviderTransform.variants(model), (v) => v)
            }

            const configVariants = configProvider?.models?.[modelID]?.variants
            if (configVariants && model.variants) {
              const merged = mergeDeep(model.variants, configVariants)
              model.variants = mapValues(
                pickBy(merged, (v) => !v.disabled),
                (v) => omit(v, ["disabled"]),
              )
            }
          }

          if (Object.keys(provider.models).length === 0) {
            delete providers[providerID]
            continue
          }
        }

        initializing = false
        return {
          signal: lifecycle.signal,
          models: languages,
          providerPackages,
          providers,
          catalog,
          sdk,
          modelLoaders,
          varsLoaders,
        }
      }),
    )

    const list = Effect.fn("Provider.list")(() => InstanceState.use(state, (s) => s.providers))

    async function resolveSDK(model: Model, s: State, envs: Record<string, string | undefined>) {
      try {
        const provider = s.providers[model.providerID]
        const options = { ...provider.options }

        for (const module of s.providerPackages) await module.prepareTransport?.(model, options)

        const baseURL = iife(() => {
          let url =
            typeof options["baseURL"] === "string" && options["baseURL"] !== "" ? options["baseURL"] : model.api.url
          if (!url) return

          const loader = s.varsLoaders[model.providerID]
          if (loader) {
            const vars = loader(options)
            for (const [key, value] of Object.entries(vars)) {
              const field = "${" + key + "}"
              url = url.replaceAll(field, value)
            }
          }

          url = url.replace(/\$\{([^}]+)\}/g, (item, key) => {
            const val = envs[String(key)]
            return val ?? item
          })
          return url
        })

        if (baseURL !== undefined) options["baseURL"] = baseURL
        if (options["apiKey"] === undefined && provider.key) options["apiKey"] = provider.key
        if (model.headers)
          options["headers"] = {
            ...options["headers"],
            ...model.headers,
          }

        const key = Hash.fast(
          JSON.stringify({
            providerID: model.providerID,
            npm: model.api.npm,
            options,
          }),
        )
        const existing = s.sdk.get(key)
        if (existing) return existing

        const customFetch = typeof options["fetch"] === "function" ? (options["fetch"] as typeof fetch) : undefined
        const chunkTimeout = options["chunkTimeout"]
        const headerTimeout = options["headerTimeout"]
        delete options["chunkTimeout"]
        delete options["headerTimeout"]

        options["fetch"] = async (input: Parameters<typeof fetch>[0], init?: BunFetchRequestInit) => {
          const fetchFn = customFetch ?? fetch
          const opts = init ?? {}
          const chunkAbortCtl = typeof chunkTimeout === "number" && chunkTimeout > 0 ? new AbortController() : undefined
          const headerTimeoutMs = headerTimeout === false ? undefined : headerTimeout
          const headerTimeoutCtl = typeof headerTimeoutMs === "number" ? timeoutController(headerTimeoutMs) : undefined
          const signals: AbortSignal[] = []

          if (opts.signal) signals.push(opts.signal)
          if (chunkAbortCtl) signals.push(chunkAbortCtl.signal)
          if (headerTimeoutCtl) signals.push(headerTimeoutCtl.signal)
          if (typeof options["timeout"] === "number") signals.push(AbortSignal.timeout(options["timeout"]))

          const combined = signals.length === 0 ? null : signals.length === 1 ? signals[0] : AbortSignal.any(signals)
          if (combined) opts.signal = combined

          const res = await fetchFn(input, {
            ...opts,
            // @ts-ignore see here: https://github.com/oven-sh/bun/issues/16682
            timeout: false,
          }).finally(() => headerTimeoutCtl?.clear())

          if (!chunkAbortCtl) return res
          return wrapSSE(res, chunkTimeout, chunkAbortCtl)
        }

        const factory = s.providerPackages.flatMap((module) => module.transports?.[model.api.npm] ?? [])[0]
        if (factory) {
          const loaded = await factory({ name: model.providerID, ...options })
          s.sdk.set(key, loaded)
          return loaded
        }

        const installedPath = await (async () => {
          if (model.api.npm.startsWith("file://")) {
            return model.api.npm
          }
          const item = await Npm.add(model.api.npm)
          const entrypoint = await resolveImportEntrypoint(item.entrypoint, item.directory)
          if (!entrypoint) throw new Error(`Package ${model.api.npm} has no import entrypoint`)
          return entrypoint
        })()

        // `installedPath` is a local entry path or an existing `file://` URL. Normalize
        // only path inputs so Node on Windows accepts the dynamic import.
        const importSpec = installedPath.startsWith("file://") ? installedPath : pathToFileURL(installedPath).href
        const mod = await import(importSpec)

        const createKey = Object.keys(mod).find((key) => key.startsWith("create"))
        const fn = createKey ? mod[createKey] : undefined
        if (typeof fn !== "function") throw new Error(`Package ${model.api.npm} has no provider factory export`)
        const loaded = (fn as (options: ProviderFactoryOptions) => ProviderTransport)({
          name: model.providerID,
          ...options,
        })
        s.sdk.set(key, loaded)
        return loaded
      } catch (e) {
        throw new InitError({ providerID: model.providerID, cause: e })
      }
    }

    const getProvider = Effect.fn("Provider.getProvider")((providerID: ProviderV2.ID) =>
      InstanceState.use(state, (s) => s.providers[providerID]),
    )

    const getModel = Effect.fn("Provider.getModel")(function* (providerID: ProviderV2.ID, modelID: ModelV2.ID) {
      const s = yield* InstanceState.get(state)
      const provider = s.providers[providerID]
      if (!provider) {
        const catalogProvider = s.catalog[providerID]
        const suggestions = catalogProvider
          ? modelSuggestions(catalogProvider, modelID, runtimeFlags.enableExperimentalModels)
          : fuzzysort
              .go(providerID, Object.keys({ ...s.catalog, ...s.providers }), { limit: 3, threshold: -10000 })
              .map((m) => m.target)
        return yield* new ModelNotFoundError({ providerID, modelID, suggestions })
      }

      const info = provider.models[modelID]
      if (!info) {
        const current = modelSuggestions(provider, modelID, runtimeFlags.enableExperimentalModels)
        const suggestions = current.length
          ? current
          : modelSuggestions(s.catalog[providerID], modelID, runtimeFlags.enableExperimentalModels)
        return yield* new ModelNotFoundError({ providerID, modelID, suggestions })
      }
      return info
    })

    const getLanguage = Effect.fn("Provider.getLanguage")(function* (model: Model) {
      const s = yield* InstanceState.get(state)
      const envs = yield* env.all()
      const key = `${model.providerID}/${model.id}`
      if (s.models.has(key)) return s.models.get(key)!

      const provider = s.providers[model.providerID]
      return yield* EffectPromise.refineRejection(
        async () => {
          const sdk = await resolveSDK(model, s, envs)
          const language = s.modelLoaders[model.providerID]
            ? await s.modelLoaders[model.providerID](
                sdk,
                model.api.id,
                {
                  ...provider.options,
                  ...model.options,
                },
                model,
              )
            : callLanguageModel(sdk, model.api.id)
          s.models.set(key, language)
          return language
        },
        (cause) =>
          cause instanceof NoSuchModelError
            ? new ModelNotFoundError({ modelID: model.id, providerID: model.providerID, cause })
            : InitError.isInstance(cause)
              ? cause
              : undefined,
      )
    })

    const closest = Effect.fn("Provider.closest")(function* (providerID: ProviderV2.ID, query: string[]) {
      const s = yield* InstanceState.get(state)
      const provider = s.providers[providerID]
      if (!provider) return undefined
      for (const item of query) {
        for (const modelID of Object.keys(provider.models)) {
          if (modelID.includes(item)) return { providerID, modelID }
        }
      }
      return undefined
    })

    const getSmallModel = Effect.fn("Provider.getSmallModel")(function* (providerID: ProviderV2.ID) {
      const cfg = yield* config.get()

      if (cfg.small_model) {
        const parsed = parseModel(cfg.small_model)
        return yield* getModel(parsed.providerID, parsed.modelID).pipe(
          Effect.catchTag("ProviderModelNotFoundError", () => Effect.succeed(undefined)),
        )
      }

      const s = yield* InstanceState.get(state)
      const provider = s.providers[providerID]
      if (!provider) return undefined

      const experimental = yield* plugin.trigger<"experimental.provider.small_model">(
        "experimental.provider.small_model",
        { provider: toPublicInfo(provider) },
        { model: undefined },
      )
      if (experimental.model) {
        return ProviderTransform.bindModel(
          {
            ...experimental.model,
            id: ModelV2.ID.make(experimental.model.id),
            providerID: ProviderV2.ID.make(experimental.model.providerID),
          },
          s.providerPackages,
          s.signal,
        )
      }

      for (const module of [...s.providerPackages].reverse()) {
        const selected = module.selectSmallModel?.(provider)
        if (selected !== undefined && provider.models[selected]) return provider.models[selected]
      }

      return undefined
    })

    const defaultModel = Effect.fn("Provider.defaultModel")(function* () {
      const cfg = yield* config.get()
      if (cfg.model) return parseModel(cfg.model)

      const s = yield* InstanceState.get(state)
      const recent = yield* fs.readJson(path.join(Global.Path.state, "model.json")).pipe(
        Effect.map((x): { providerID: ProviderV2.ID; modelID: ModelV2.ID }[] => {
          if (!isRecord(x) || !Array.isArray(x.recent)) return []
          return x.recent.flatMap((item) => {
            if (!isRecord(item)) return []
            if (typeof item.providerID !== "string") return []
            if (typeof item.modelID !== "string") return []
            return [{ providerID: ProviderV2.ID.make(item.providerID), modelID: ModelV2.ID.make(item.modelID) }]
          })
        }),
        Effect.catch(() => Effect.succeed([] as { providerID: ProviderV2.ID; modelID: ModelV2.ID }[])),
      )
      for (const entry of recent) {
        const provider = s.providers[entry.providerID]
        if (!provider) continue
        if (!provider.models[entry.modelID]) continue
        return { providerID: entry.providerID, modelID: entry.modelID }
      }

      const provider = Object.values(s.providers).find((p) => !cfg.provider || Object.keys(cfg.provider).includes(p.id))
      if (!provider) return yield* new NoProvidersError()
      const [model] = sort(Object.values(provider.models))
      if (!model) return yield* new NoModelsError({ providerID: provider.id })
      return {
        providerID: provider.id,
        modelID: model.id,
      }
    })

    return Service.of({ list, getProvider, getModel, getLanguage, closest, getSmallModel, defaultModel })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(Env.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(ModelsDev.defaultLayer),
    Layer.provide(RuntimeFlags.defaultLayer),
    Layer.provide(Credential.defaultLayer),
  ),
)

const priority = ["gpt-5", "claude-sonnet-4", "big-pickle", "gemini-3-pro"]
export function sort<T extends { id: string }>(models: T[]) {
  return sortBy(
    models,
    [(model) => priority.findIndex((filter) => model.id.includes(filter)), "desc"],
    [(model) => (model.id.includes("latest") ? 0 : 1), "asc"],
    [(model) => model.id, "desc"],
  )
}

export function parseModel(model: string) {
  const [providerID, ...rest] = model.split("/")
  return {
    providerID: ProviderV2.ID.make(providerID),
    modelID: ModelV2.ID.make(rest.join("/")),
  }
}

export const node = LayerNode.make(layer, [
  FSUtil.node,
  Config.node,
  Auth.node,
  Env.node,
  Plugin.node,
  ModelsDev.node,
  RuntimeFlags.node,
  Credential.node,
])

export * as Provider from "./provider"
