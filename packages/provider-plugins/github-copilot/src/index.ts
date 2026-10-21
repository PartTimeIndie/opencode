import { transports } from "./transports"
import { configure } from "./configure"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"

function isGpt5ChatLatest(modelID: string) {
  return /(?:^|\/)gpt-5(?:[.-]\d+)?-chat-latest$/.test(modelID)
}

function shouldUseResponses(modelID: string) {
  // Copilot supports Responses for GPT-5 class models, except mini variants
  // which still need the chat-completions endpoint.
  const match = /^gpt-(\d+)/.exec(modelID)
  if (!match) return false
  return Number(match[1]) >= 5 && !modelID.startsWith("gpt-5-mini")
}

export const GithubCopilotPlugin: ProviderPluginModule = {
  id: "github-copilot",
  async configureCatalog(catalog) {
    const provider = catalog.providers["github-copilot"]
    if (!provider) return
    for (const id of Object.keys(provider.models)) if (isGpt5ChatLatest(id)) delete provider.models[id]
  },
  transports,
  configure,
  async provider(api) {
    return {
      async "aisdk.sdk"(evt) {
        if (evt.package !== "@ai-sdk/github-copilot") return
        const mod = await import("./transport/copilot-provider")
        evt.sdk = mod.createOpenaiCompatible(evt.options)
      },
      async "aisdk.language"(evt) {
        if (evt.model.providerID !== "github-copilot") return
        if ((evt.sdk as CopilotSDK).responses === undefined && (evt.sdk as CopilotSDK).chat === undefined) {
          evt.language = (evt.sdk as CopilotSDK).languageModel(evt.model.api.id)
          return
        }
        evt.language = shouldUseResponses(evt.model.api.id)
          ? (evt.sdk as CopilotSDK).responses(evt.model.api.id)
          : (evt.sdk as CopilotSDK).chat(evt.model.api.id)
      },
      async "catalog.transform"(evt) {
        const item = evt.provider.get("github-copilot")
        if (!item) return
        for (const modelID of item.models.keys()) {
          if (!isGpt5ChatLatest(modelID)) continue
          evt.model.update(item.provider.id, modelID, (model) => {
            // These chat-only aliases conflict with the Copilot GPT-5 Responses route,
            // so hide them only for Copilot rather than for every provider catalog.
            model.enabled = false
          })
        }
      },
    }
  },
}

type CopilotSDK = { responses(modelID: string): LanguageModelV3; chat(modelID: string): LanguageModelV3; languageModel(modelID: string): LanguageModelV3 }

export default GithubCopilotPlugin
