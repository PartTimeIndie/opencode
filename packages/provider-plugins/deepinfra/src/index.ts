import { transports } from "./transports"
import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"

export const DeepInfraPlugin: ProviderPluginModule = {
  id: "deepinfra",
  transports,
  async provider(_api) {
    return {
      async "aisdk.sdk"(evt) {
        if (evt.package !== "@ai-sdk/deepinfra") return
        const mod = await import("@ai-sdk/deepinfra")
        evt.sdk = mod.createDeepInfra(evt.options)
      },
    }
  },
}

export default DeepInfraPlugin
