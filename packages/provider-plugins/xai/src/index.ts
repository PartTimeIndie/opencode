import { transports } from "./transports"
import { configure } from "./configure"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"

export const XAIPlugin: ProviderPluginModule = {
  id: "xai",
  transports,
  configure,
  async provider(api) {
    return {
      async "aisdk.sdk"(evt) {
        if (evt.package !== "@ai-sdk/xai") return
        const mod = await import("@ai-sdk/xai")
        evt.sdk = mod.createXai(evt.options)
      },
      async "aisdk.language"(evt) {
        if (evt.model.providerID !== "xai") return
        evt.language = (evt.sdk as { responses(modelID: string): LanguageModelV3 }).responses(evt.model.api.id)
      },
    }
  },
}

export default XAIPlugin
