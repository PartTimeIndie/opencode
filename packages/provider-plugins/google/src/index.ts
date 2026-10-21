import { transports } from "./transports"
import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"

export const GooglePlugin: ProviderPluginModule = {
  id: "google",
  transports,
  async provider(_api) {
    return {
      async "aisdk.sdk"(evt) {
        if (evt.package !== "@ai-sdk/google") return
        const mod = await import("@ai-sdk/google")
        evt.sdk = mod.createGoogleGenerativeAI(evt.options)
      },
    }
  },
}

export default GooglePlugin
