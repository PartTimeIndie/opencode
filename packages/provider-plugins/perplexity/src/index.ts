import { transports } from "./transports"
import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"

export const PerplexityPlugin: ProviderPluginModule = {
  id: "perplexity",
  transports,
  async provider(_api) {
    return {
      async "aisdk.sdk"(evt) {
        if (evt.package !== "@ai-sdk/perplexity") return
        const mod = await import("@ai-sdk/perplexity")
        evt.sdk = mod.createPerplexity(evt.options)
      },
    }
  },
}

export default PerplexityPlugin
