import { DateTime, Effect, Scope, Stream } from "effect"
import { Catalog } from "../catalog"
import { Integration } from "../integration"
import { EventV2 } from "../event"
import { ModelV2 } from "../model"
import { ModelRequest } from "../model-request"
import { ModelsDev } from "../models-dev"
import { PluginV2 } from "../plugin"
import { ProviderV2 } from "../provider"

function released(date: string) {
  const time = Date.parse(date)
  return DateTime.makeUnsafe(Number.isFinite(time) ? time : 0)
}

function cost(input: ModelsDev.Model["cost"]) {
  const base: ModelV2.Cost = {
    input: input?.input ?? 0,
    output: input?.output ?? 0,
    cache: {
      read: input?.cache_read ?? 0,
      write: input?.cache_write ?? 0,
    },
  }
  const tiers: ModelV2.Cost[] = (input?.tiers ?? []).map((item) => ({
    tier: { ...item.tier },
    input: item.input,
    output: item.output,
    cache: {
      read: item.cache_read ?? 0,
      write: item.cache_write ?? 0,
    },
  }))
  const legacy: ModelV2.Cost | undefined = input?.context_over_200k
    ? {
        tier: {
          type: "context" as const,
          size: 200_000,
        },
        input: input.context_over_200k.input,
        output: input.context_over_200k.output,
        cache: {
          read: input.context_over_200k.cache_read ?? 0,
          write: input.context_over_200k.cache_write ?? 0,
        },
      }
    : undefined
  const items = [base, ...tiers, ...(legacy ? [legacy] : [])]
  return items.filter((item, index) => items.findIndex((candidate) => sameCost(candidate, item)) === index)
}

function sameCost(a: ModelV2.Cost, b: ModelV2.Cost) {
  return (
    a.tier?.type === b.tier?.type &&
    a.tier?.size === b.tier?.size &&
    a.input === b.input &&
    a.output === b.output &&
    a.cache.read === b.cache.read &&
    a.cache.write === b.cache.write
  )
}

function modeVariants(model: ModelsDev.Model, packageName: string | undefined, profiles: ModelRequest.Profiles) {
  return Object.entries(model.experimental?.modes ?? {}).map(([id, item]) => ({
    id: ModelV2.VariantID.make(id),
    headers: { ...(item.provider?.headers ?? {}) },
    ...ModelRequest.normalizeAiSdkOptions(packageName, item.provider?.body ?? {}, profiles),
  }))
}

function modeCost(model: ModelsDev.Model, override: ModelsDev.Model["cost"]) {
  if (!override) return model.cost
  return {
    input: override.input,
    output: override.output,
    cache_read: override.cache_read ?? 0,
    cache_write: override.cache_write ?? 0,
    tiers: override.tiers ?? model.cost?.tiers,
    context_over_200k: override.context_over_200k ?? model.cost?.context_over_200k,
  }
}

export const ModelsDevPlugin = PluginV2.define({
  id: PluginV2.ID.make("models-dev"),
  effect: Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const plugins = yield* PluginV2.Service
    const integrations = yield* Integration.Service
    const modelsDev = yield* ModelsDev.Service
    const events = yield* EventV2.Service
    const scope = yield* Scope.Scope
    const transform = yield* catalog.transform()
    const integrationTransform = yield* integrations.transform()
    const refresh = Effect.fn("ModelsDevPlugin.refresh")(function* () {
      const data = yield* modelsDev.get()
      yield* integrationTransform((integrations) => {
        for (const item of Object.values(data)) {
          if (item.env.length === 0) continue
          const integrationID = Integration.ID.make(item.id)
          integrations.update(integrationID, (integration) => (integration.name = item.name))
          integrations.method.update({
            integrationID,
            method: { type: "key" },
          })
          integrations.method.update({
            integrationID,
            method: { type: "env", names: [...item.env] },
          })
        }
      })
      yield* transform((catalog) => {
        for (const item of Object.values(data)) {
          const providerID = ProviderV2.ID.make(item.id)
          catalog.provider.update(providerID, (provider) => {
            provider.name = item.name
            provider.api = item.npm
              ? {
                  type: "aisdk",
                  package: item.npm,
                  url: item.api,
                }
              : {
                  type: "native",
                  url: item.api,
                  settings: {},
                }
          })

          for (const model of Object.values(item.models)) {
            const modelID = ModelV2.ID.make(model.id)
            const packageName = model.provider?.npm ?? item.npm
            const apiURL = model.provider?.api ?? item.api
            catalog.model.update(providerID, modelID, (draft) => {
              draft.name = model.name
              draft.family = model.family ? ModelV2.Family.make(model.family) : undefined
              draft.api = packageName
                ? {
                    id: modelID,
                    type: "aisdk",
                    package: packageName,
                    url: apiURL,
                  }
                : {
                    id: modelID,
                    type: "native",
                    url: apiURL,
                    settings: {},
                  }
              draft.capabilities = {
                tools: model.tool_call,
                  reasoning: model.reasoning,
                input: [...(model.modalities?.input ?? [])],
                output: [...(model.modalities?.output ?? [])],
              }
              draft.variants = modeVariants(model, packageName, plugins.requestProfiles())
              draft.time.released = released(model.release_date)
              draft.cost = cost(model.cost)
              draft.status = model.status ?? "active"
              draft.enabled = true
              draft.limit = {
                context: model.limit.context,
                input: model.limit.input,
                output: model.limit.output,
              }
            })
            for (const [mode, options] of Object.entries(model.experimental?.modes ?? {})) {
              const modeID = ModelV2.ID.make(`${model.id}-${mode}`)
              catalog.model.update(providerID, modeID, (draft) => {
                draft.name = `${model.name} ${mode[0].toUpperCase()}${mode.slice(1)}`
                draft.family = model.family ? ModelV2.Family.make(model.family) : undefined
                draft.api = packageName
                  ? {
                      id: modelID,
                      type: "aisdk",
                      package: packageName,
                      url: apiURL,
                    }
                  : {
                      id: modelID,
                      type: "native",
                      url: apiURL,
                      settings: {},
                    }
                draft.capabilities = {
                  tools: model.tool_call,
                  reasoning: model.reasoning,
                  input: [...(model.modalities?.input ?? [])],
                  output: [...(model.modalities?.output ?? [])],
                }
                ModelRequest.assign(draft.request, {
                  headers: options.provider?.headers,
                  ...ModelRequest.normalizeAiSdkOptions(packageName, options.provider?.body ?? {}, plugins.requestProfiles()),
                })
                draft.variants = []
                draft.time.released = released(model.release_date)
                draft.cost = cost(modeCost(model, options.cost))
                draft.status = model.status ?? "active"
                draft.enabled = true
                draft.limit = {
                  context: model.limit.context,
                  input: model.limit.input,
                  output: model.limit.output,
                }
              })
            }
          }
        }
      })
    })
    yield* refresh()
    yield* events.subscribe(ModelsDev.Event.Refreshed).pipe(
      Stream.runForEach(() => refresh()),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})
