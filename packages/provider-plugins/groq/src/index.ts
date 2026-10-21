import { transports } from "./transports"
import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"

export const GroqPlugin: ProviderPluginModule = {
  id: "groq",
  transports,
  async provider(_api) {
    return {
      async "aisdk.sdk"(evt) {
        if (evt.package !== "@ai-sdk/groq") return
        const mod = await import("@ai-sdk/groq")
        evt.sdk = mod.createGroq(evt.options)
      },
    }
  },
}

export default GroqPlugin
