import { transports } from "./transports"
import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"

export const AlibabaPlugin: ProviderPluginModule = {
  id: "alibaba",
  transports,
  async provider(_api) {
    return {
      async "aisdk.sdk"(evt) {
        if (evt.package !== "@ai-sdk/alibaba") return
        const mod = await import("@ai-sdk/alibaba")
        evt.sdk = mod.createAlibaba(evt.options)
      },
    }
  },
}

export default AlibabaPlugin
