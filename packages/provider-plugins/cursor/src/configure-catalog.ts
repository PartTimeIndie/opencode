import type { ProviderPluginModule, ProviderConfigurationHost, ProviderConfigurationRecord, ProviderConfigurationModel, ProviderConfigurationResult } from "@opencode-ai/plugin/provider"
import { cursorModelsFromCache } from "./models"
type Info = ProviderConfigurationRecord
type Model = ProviderConfigurationModel
type CustomModelLoader = NonNullable<ProviderConfigurationResult["getModel"]>
type CustomVarsLoader = NonNullable<ProviderConfigurationResult["vars"]>

export const configureCatalog: NonNullable<ProviderPluginModule["configureCatalog"]> = async (catalog, host) => {
  await addCursorAlias(catalog.providers, catalog.modelLoaders, catalog.varsLoaders, catalog.disabled, host)
}

async function addCursorAlias(
  providers: Record<string, Info>,
  modelLoaders: Record<string, CustomModelLoader>,
  varsLoaders: Record<string, CustomVarsLoader>,
  disabled: ReadonlySet<string>,
  dep: ProviderConfigurationHost,
) {
  if (disabled.has("cursor")) return
  const existing = providers["cursor"]
  if (existing) {
    if (Object.keys(existing.models).length === 0) applyCursorCacheModels(existing, cursorModelsFromCache(await dep.cache.readJSON("cursor-models.json").catch(() => undefined)))
    addCursorComposerModel(existing, dep)
    return
  }
  if (disabled.has("github-copilot")) return
  const source = providers["github-copilot"]
  if (!source) return

  const candidates = Object.values(source.models).filter(
    (model) => model.id !== "gpt-5-chat-latest" && model.status !== "deprecated",
  )
  const base =
    ["gpt-5.4-nano", "gpt-5-mini", "gpt-4.1", "gpt-4o-mini", "gpt-4o"]
      .map((id) => source.models[id])
      .find((model) => model && candidates.includes(model)) ?? dep.sortModels(candidates)[0]
  if (!base) return

  const composerID = "composer"
  providers["cursor"] = {
    ...source,
    id: "cursor",
    name: "Cursor",
    env: [],
    options: { ...source.options },
    models: {
      [composerID]: {
        ...base,
        id: composerID,
        providerID: "cursor",
        name: "Cursor Composer",
        api: { ...base.api },
      },
    },
  }
  addCursorFableModel(providers["cursor"], source.models["claude-fable-5"] ?? base)
  if (modelLoaders["github-copilot"]) {
    modelLoaders["cursor"] = modelLoaders["github-copilot"]
  }
  if (varsLoaders["github-copilot"]) {
    varsLoaders["cursor"] = varsLoaders["github-copilot"]
  }
}

function applyCursorCacheModels(provider: Info, models: ReturnType<typeof cursorModelsFromCache>) {
  for (const item of models) {
    const modelID = item.id
    provider.models[modelID] = {
      id: modelID,
      providerID: "cursor",
      name: item.name,
      family: "",
      api: {
        id: item.id,
        url: "",
        npm: "cursor-opencode-provider",
      },
      status: "active",
      headers: {},
      options: {},
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: item.context, output: 8192 },
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: item.images,
        toolcall: true,
        input: {
          text: true,
          audio: false,
          image: item.images,
          video: false,
          pdf: false,
        },
        output: {
          text: true,
          audio: false,
          image: false,
          video: false,
          pdf: false,
          transcription: false,
        },
        interleaved: false,
      },
      release_date: "",
      variants: Object.fromEntries(item.variants.map((variant) => [variant.id, {}])),
    }
  }
}

function addCursorComposerModel(provider: Info, dep: ProviderConfigurationHost) {
  const composerID = "composer"
  const candidates = Object.values(provider.models).filter((model) => model.status !== "deprecated")
  const base =
    ["composer-2.5", "composer-2", "composer-1"]
      .map((id) => provider.models[id])
      .find((model) => model && candidates.includes(model)) ?? dep.sortModels(candidates)[0]

  if (!provider.models[composerID] && base) {
    provider.models[composerID] = {
      ...base,
      id: composerID,
      providerID: "cursor",
      name: "Cursor Composer",
      api: { ...base.api },
    }
  }
  addCursorFableModel(provider, provider.models["claude-fable-5"] ?? base)
}

function addCursorFableModel(provider: Info, base: Model | undefined) {
  if (!base || provider.models["claude-fable-5"]) return
  provider.models["claude-fable-5"] = {
    ...base,
    id: "claude-fable-5",
    providerID: "cursor",
    name: "Claude Fable 5",
    api: { ...base.api, id: "claude-fable-5" },
    variants: {},
  }
}