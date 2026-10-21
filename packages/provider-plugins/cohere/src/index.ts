import { transports } from "./transports"
import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"

export const CoherePlugin: ProviderPluginModule = {
  id: "cohere",
  transports,
  async provider(_api) {
    return {
      async "aisdk.sdk"(evt) {
        if (evt.package !== "@ai-sdk/cohere") return
        const mod = await import("@ai-sdk/cohere")
        evt.sdk = mod.createCohere(evt.options)
      },
    }
  },
}

export default CoherePlugin
