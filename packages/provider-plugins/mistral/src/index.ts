import { transports } from "./transports"
import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"

export const MistralPlugin: ProviderPluginModule = {
  id: "mistral",
  transports,
  async provider(_api) {
    return {
      async "aisdk.sdk"(evt) {
        if (evt.package !== "@ai-sdk/mistral") return
        const mod = await import("@ai-sdk/mistral")
        evt.sdk = mod.createMistral(evt.options)
      },
    }
  },
}

export default MistralPlugin
