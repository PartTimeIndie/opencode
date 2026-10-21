import { transports } from "./transports"
import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"

export const TogetherAIPlugin: ProviderPluginModule = {
  id: "togetherai",
  transports,
  async provider(_api) {
    return {
      async "aisdk.sdk"(evt) {
        if (evt.package !== "@ai-sdk/togetherai") return
        const mod = await import("@ai-sdk/togetherai")
        evt.sdk = mod.createTogetherAI(evt.options)
      },
    }
  },
}

export default TogetherAIPlugin
