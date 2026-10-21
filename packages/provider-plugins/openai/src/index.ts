import { nativeModels } from "./native"
import { requestProfiles } from "./request-profiles"
import { transports } from "./transports"
import { configure } from "./configure"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"
import { authMethods } from "./auth"
import { openaiReasoningVariants } from "./reasoning"

function isGpt5ChatLatest(modelID: string) {
  return /(?:^|\/)gpt-5(?:[.-]\d+)?-chat-latest$/.test(modelID)
}

export const OpenAIPlugin: ProviderPluginModule = {
  id: "openai",
  requestProfiles,
  nativeModels,
  async configureCatalog(catalog) {
    const provider = catalog.providers["openai"]
    if (!provider) return
    for (const id of Object.keys(provider.models)) if (isGpt5ChatLatest(id)) delete provider.models[id]
  },
  transports,
  configure,
  integrations: ["openai"],
  async provider(api) {
    await api.integrations.update((editor) => {
      for (const method of authMethods(api.app.version)) editor.method.update(method)
    })
    return {
      async "aisdk.sdk"(evt) {
        if (evt.package !== "@ai-sdk/openai") return
        const mod = await import("@ai-sdk/openai")
        evt.sdk = mod.createOpenAI(evt.options)
      },
      async "aisdk.language"(evt) {
        if (evt.model.providerID !== "openai") return
        evt.language = (evt.sdk as { responses(modelID: string): LanguageModelV3 }).responses(evt.model.api.id)
      },
      async "catalog.transform"(evt) {
        for (const item of evt.provider.list()) {
          for (const modelID of item.models.keys()) {
            evt.model.update(item.provider.id, modelID, (model) => {
              // Catalog hooks see raw model APIs before provider-level defaults are projected.
              const api =
                model.api.type === "native" && !model.api.url && Object.keys(model.api.settings).length === 0
                  ? item.provider.api
                  : model.api
              if (api.type !== "aisdk" || api.package !== "@ai-sdk/openai") return
              const variants = openaiReasoningVariants({
                id: model.api.id,
                reasoning: model.capabilities.reasoning,
                release_date: new Date(model.time.released).toISOString().slice(0, 10),
                variants: model.variants,
              })
              model.variants = [...variants, ...model.variants]
              if (item.provider.id !== "openai" || !isGpt5ChatLatest(modelID)) return
              // OpenAIPlugin sends OpenAI models through Responses; these aliases are
              // chat-completions-only models, so hide them only from OpenAI's catalog.
              model.enabled = false
            })
          }
        }
      },
    }
  },
}

export default OpenAIPlugin
