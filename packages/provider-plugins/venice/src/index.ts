import { transports } from "./transports"
import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"

export const VenicePlugin: ProviderPluginModule = {
  id: "venice",
  transports,
  async provider(_api) {
    return {
      async "aisdk.sdk"(evt) {
        if (evt.package !== "venice-ai-sdk-provider") return
        const mod = await import("venice-ai-sdk-provider")
        evt.sdk = mod.createVenice(evt.options)
      },
    }
  },
}

export default VenicePlugin
