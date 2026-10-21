import { nativeModels } from "./native"
import { requestProfiles } from "./request-profiles"
import { transports } from "./transports"
import { configure } from "./configure"
import { refreshSpeechCatalog } from "./speech-catalog"
import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"

function isGpt5ChatLatest(modelID: string) {
  return /(?:^|\/)gpt-5(?:[.-]\d+)?-chat-latest$/.test(modelID)
}

function isOpenRouterUnsupportedAlias(modelID: string) {
  return isGpt5ChatLatest(modelID) || modelID === "openai/gpt-5-chat"
}

export const OpenRouterPlugin: ProviderPluginModule = {
  id: "openrouter",
  requestProfiles,
  nativeModels,
  async configureCatalog(catalog, host) {
    const provider = catalog.providers["openrouter"]
    if (!provider) return
    for (const [id, model] of Object.entries(provider.models)) {
      if (isOpenRouterUnsupportedAlias(id)) delete provider.models[id]
      if (audioPurpose(id) === "transcription") {
        model.capabilities.input.audio = true
        model.capabilities.output.transcription = true
      }
      if (audioPurpose(id) === "speech") {
        model.capabilities.input.text = true
        model.capabilities.output.speech = true
      }
    }
    await refreshSpeechCatalog(provider, host.signal)
  },
  transports,
  configure,
  async provider(_api) {
    return {
      async "catalog.transform"(evt) {
        for (const item of evt.provider.list()) {
          if (item.provider.api.type !== "aisdk") continue
          if (item.provider.api.package !== "@openrouter/ai-sdk-provider") continue
          evt.provider.update(item.provider.id, (provider) => {
            provider.request.headers["HTTP-Referer"] = "https://opencode.ai/"
            provider.request.headers["X-Title"] = "opencode"
          })
          for (const modelID of item.models.keys()) {
            const purpose = audioPurpose(modelID)
            if (purpose) evt.model.update(item.provider.id, modelID, (model) => {
              const input = purpose === "transcription" ? "audio" : "text"
              const output = purpose === "transcription" ? "text" : "audio"
              if (!model.capabilities.input.includes(input)) model.capabilities.input.push(input)
              if (!model.capabilities.output.includes(output)) model.capabilities.output.push(output)
            })
            if (!isOpenRouterUnsupportedAlias(modelID)) continue
            evt.model.update(item.provider.id, modelID, (model) => {
              // These are OpenRouter-specific OpenAI chat aliases that do not work
              // on the generic path. Keep custom providers with matching IDs untouched.
              model.enabled = false
            })
          }
        }
      },
      async "aisdk.sdk"(evt) {
        if (evt.package !== "@openrouter/ai-sdk-provider") return
        const mod = await import("@openrouter/ai-sdk-provider")
        evt.sdk = mod.createOpenRouter(evt.options)
      },
    }
  },
}

export default OpenRouterPlugin

function audioPurpose(modelID: string) {
  if (/^deepgram\/nova-/i.test(modelID) || modelID === "mistralai/voxtral-mini-3b-2507") return "transcription"
  if (/^microsoft\/mai-voice/i.test(modelID)) return "speech"
}
