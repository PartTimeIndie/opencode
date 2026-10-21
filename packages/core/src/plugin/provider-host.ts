import type {
  ProviderAuthMethod,
  ProviderCatalogEditor,
  ProviderCatalogRecord,
  ProviderHost,
  ProviderIntegrationEditor,
  ProviderModel,
  ProviderPluginModule,
} from "@opencode-ai/plugin/provider"
import { Effect, Option, Schema, Scope } from "effect"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { Catalog } from "../catalog"
import { Credential } from "../credential"
import { Global } from "../global"
import { Integration } from "../integration"
import { InstallationVersion } from "../installation/version"
import { ModelV2 } from "../model"
import { Npm } from "../npm"
import { PluginV2 } from "../plugin"
import { ProviderV2 } from "../provider"

function modelDTO(model: ModelV2.Info): ProviderModel {
  return catalogSnapshot(Schema.encodeSync(ModelV2.Info)(model)) as ProviderModel
}

// Transport options may contain fetch functions or SDK instances. Copy data containers
// without cloning those opaque transport values, which must keep their identity.
function catalogSnapshot<T>(value: T): T {
  if (Array.isArray(value)) return value.map(catalogSnapshot) as T
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, catalogSnapshot(item)])) as T
  return value
}

/** Edits cross a schema boundary; reads are detached snapshots and cannot bypass update validation. */
export function providerCatalogEditor(editor: Catalog.Editor): ProviderCatalogEditor {
  const record = (value: Catalog.ProviderRecord): ProviderCatalogRecord => ({
    provider: catalogSnapshot(Schema.encodeSync(ProviderV2.Info)(value.provider)),
    // Most hooks first filter provider metadata. Avoid serializing every model
    // in the entire catalog once for every registered provider hook.
    get models() { return new Map(Array.from(value.models, ([id, model]) => [id, modelDTO(model)])) },
  })
  return {
    provider: {
      list: () => editor.provider.list().map(record),
      get(id) {
        const value = editor.provider.get(ProviderV2.ID.make(id))
        return value && record(value)
      },
      update(id, update) {
        editor.provider.update(ProviderV2.ID.make(id), (current) => {
          const next = catalogSnapshot(Schema.encodeSync(ProviderV2.Info)(current))
          update(next)
          if (next.id !== id) throw new Error("Provider catalog updates cannot change identity")
          const decoded = Schema.decodeUnknownSync(ProviderV2.Info)(next)
          for (const key of Object.keys(current)) if (!(key in decoded)) Reflect.deleteProperty(current, key)
          Object.assign(current, decoded)
        })
      },
      remove: (id) => editor.provider.remove(ProviderV2.ID.make(id)),
    },
    model: {
      get(providerID, modelID) {
        const value = editor.model.get(ProviderV2.ID.make(providerID), ModelV2.ID.make(modelID))
        return value && modelDTO(value)
      },
      update(providerID, modelID, update) {
        editor.model.update(ProviderV2.ID.make(providerID), ModelV2.ID.make(modelID), (current) => {
          const next = modelDTO(current)
          update(next)
          if (next.id !== modelID || next.providerID !== providerID)
            throw new Error("Provider model updates cannot change identity")
          const decoded = Schema.decodeUnknownSync(ModelV2.Info)(next)
          for (const key of Object.keys(current)) if (!(key in decoded)) Reflect.deleteProperty(current, key)
          Object.assign(current, decoded)
        })
      },
      remove: (providerID, modelID) => editor.model.remove(ProviderV2.ID.make(providerID), ModelV2.ID.make(modelID)),
      default: {
        get: () => editor.model.default.get(),
        set: (providerID, modelID) => editor.model.default.set(ProviderV2.ID.make(providerID), ModelV2.ID.make(modelID)),
      },
    },
  }
}

function authMethod(value: ProviderAuthMethod, signal: AbortSignal): Integration.Implementation {
  const integrationID = Integration.ID.make(value.integrationID)
  if (!("authorize" in value)) {
    if (value.method.type === "env") return { integrationID, method: Schema.decodeUnknownSync(Integration.EnvMethod)(value.method) }
    return { integrationID, method: Schema.decodeUnknownSync(Integration.KeyMethod)(value.method) }
  }
  return {
    integrationID,
    method: Schema.decodeUnknownSync(Integration.OAuthMethod)(value.method),
    authorize: (inputs) => Effect.gen(function* () {
      const attempt = new AbortController()
      yield* Effect.addFinalizer(() => Effect.sync(() => attempt.abort()))
      const result = yield* Effect.tryPromise(() => value.authorize(inputs, AbortSignal.any([signal, attempt.signal])))
      if (result.mode === "code") return {
        mode: "code" as const,
        url: result.url,
        instructions: result.instructions,
        callback: (code: string) => Effect.tryPromise(() => result.callback(code)).pipe(Effect.map(Schema.decodeUnknownSync(Credential.Info))),
      }
      return {
        mode: "auto" as const,
        url: result.url,
        instructions: result.instructions,
        callback: Effect.tryPromise(() => result.callback).pipe(Effect.map(Schema.decodeUnknownSync(Credential.Info))),
      }
    }),
    refresh: value.refresh ? (credential) => Effect.tryPromise((requestSignal) => value.refresh!(credential, AbortSignal.any([signal, requestSignal]))).pipe(
      Effect.map(Schema.decodeUnknownSync(Credential.OAuth)),
    ) : undefined,
  }
}

/** Public provider factories enter the same scoped registry as other Core hooks. */
export function providerRegistration(module: ProviderPluginModule, options?: Readonly<Record<string, unknown>>) {
  return PluginV2.define({
    id: PluginV2.ID.make(module.id),
    requestProfiles: module.requestProfiles,
    nativeModels: module.nativeModels,
    effect: Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const catalog = yield* Catalog.Service
      const credentials = yield* Credential.Service
      const integrations = yield* Integration.Service
      const global = yield* Global.Service
      const npm = yield* Npm.Service
      const controller = new AbortController()
      const disposers = new Set<() => void | Promise<void>>()
      yield* Effect.addFinalizer(() => Effect.gen(function* () {
        controller.abort()
        yield* Effect.forEach(Array.from(disposers).reverse(), (dispose) => Effect.promise(async () => dispose()).pipe(
          Effect.catchCause((cause) => Effect.logError("Provider plugin disposal failed", { id: module.id, cause })),
        ), { discard: true })
        disposers.clear()
      }))
      const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => {
        controller.signal.throwIfAborted()
        return Effect.runPromise(effect.pipe(Scope.provide(scope)), { signal: controller.signal })
      }
      const allowed = new Set(module.integrations ?? [])
      const integrationID = (id: string) => {
        if (!allowed.has(id)) throw new Error(`Provider plugin ${module.id} cannot access integration ${id}`)
        return Integration.ID.make(id)
      }
      const cacheRoot = path.join(global.cache, "provider-plugins", createHash("sha256").update(module.id).digest("hex"))
      const cacheFile = (name: string) => {
        if (!name || name === "." || name === ".." || /[\\/:]/.test(name)) throw new Error("Invalid provider cache name")
        return path.join(cacheRoot, name)
      }
      const api: ProviderHost = {
        app: { version: InstallationVersion },
        lifecycle: {
          signal: controller.signal,
          onDispose(dispose) {
            controller.signal.throwIfAborted()
            disposers.add(dispose)
            return () => { disposers.delete(dispose) }
          },
        },
        catalog: {
          transform: (update) => run(Effect.gen(function* () {
            const transform = yield* catalog.transform()
            yield* transform((editor) => update(providerCatalogEditor(editor)))
          })),
        },
        credentials: { list: (id) => run(credentials.list(integrationID(id))).then((values) => structuredClone(values)) },
        integrations: {
          get: (id) => run(integrations.get(Integration.ID.make(id))).then((value) => value ? {
            id: value.id, name: value.name, connections: value.connections.map((connection) => ({ ...connection })),
          } : undefined),
          update: (update) => run(integrations.update((editor) => {
            const publicEditor: ProviderIntegrationEditor = {
              update: (id, change) => editor.update(integrationID(id), (current) => {
                const next = { id: current.id, name: current.name }
                change(next)
                if (next.id !== id) throw new Error("Provider integration updates cannot change identity")
                current.name = next.name
              }),
              method: { update: (method) => {
                integrationID(method.integrationID)
                editor.method.update(authMethod(method, controller.signal))
              } },
            }
            update(publicEditor)
          })),
          connection: {
            forIntegration: (id) => run(integrations.connection.forIntegration(integrationID(id))).then((value) => value && structuredClone(value)),
            credential: async (id) => {
              const stored = await run(credentials.get(Credential.ID.make(id)))
              if (!stored) return
              integrationID(stored.integrationID)
              return run(integrations.connection.credential(stored.id)).then((value) => value && structuredClone(value))
            },
          },
        },
        cache: {
          readJSON: (name) => {
            controller.signal.throwIfAborted()
            return readFile(cacheFile(name), { encoding: "utf8", signal: controller.signal }).then((text) => JSON.parse(text) as unknown)
          },
          writeJSON: async (name, value) => {
            controller.signal.throwIfAborted()
            const file = cacheFile(name)
            await mkdir(cacheRoot, { recursive: true })
            await writeFile(file, JSON.stringify(value), { signal: controller.signal })
          },
        },
        modules: {
          resolve: async (specifier) => {
            controller.signal.throwIfAborted()
            if (specifier.startsWith("file://")) return specifier
            const entry = Option.getOrUndefined((await run(npm.add(specifier))).entrypoint)
            if (!entry) throw new Error(`Package ${specifier} has no import entrypoint`)
            return entry.startsWith("file://") ? entry : pathToFileURL(entry).href
          },
        },
      }
      const hooks = yield* Effect.promise(() => module.provider(api, options))
      if (!hooks) return
      return {
        "catalog.transform": hooks["catalog.transform"] ? (event) => Effect.promise(() => hooks["catalog.transform"]!(providerCatalogEditor(event))) : undefined,
        "aisdk.sdk": hooks["aisdk.sdk"] ? (event) => Effect.promise(async () => {
          const request = { model: modelDTO(event.model), package: event.package, options: event.options, sdk: event.sdk as unknown }
          await hooks["aisdk.sdk"]!(request)
          event.sdk = request.sdk
        }) : undefined,
        "aisdk.language": hooks["aisdk.language"] ? (event) => Effect.promise(async () => {
          const request = { model: modelDTO(event.model), sdk: event.sdk as unknown, options: event.options, language: event.language }
          await hooks["aisdk.language"]!(request)
          event.language = request.language
        }) : undefined,
      } satisfies PluginV2.HookFunctions
    }),
  })
}
