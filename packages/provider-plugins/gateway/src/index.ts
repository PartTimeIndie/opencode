import { transports } from "./transports"
import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"

export const GatewayPlugin: ProviderPluginModule = {
  id: "gateway",
  transports,
  async provider(_api) {
    return {
      async "aisdk.sdk"(evt) {
        if (evt.package !== "@ai-sdk/gateway") return
        const mod = await import("@ai-sdk/gateway")
        evt.sdk = mod.createGateway(evt.options)
      },
    }
  },
}

export default GatewayPlugin
