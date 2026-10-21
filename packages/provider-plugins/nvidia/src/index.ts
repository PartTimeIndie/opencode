import { configure } from "./configure"
import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"

export const NvidiaPlugin: ProviderPluginModule = {
  id: "nvidia",
  configure,
  async provider(_api) {
    return {
      async "catalog.transform"(evt) {
        for (const item of evt.provider.list()) {
          if (item.provider.api.type !== "aisdk") continue
          if (item.provider.api.package !== "@ai-sdk/openai-compatible") continue
          if (item.provider.api.url !== "https://integrate.api.nvidia.com/v1") continue
          evt.provider.update(item.provider.id, (provider) => {
            provider.request.headers["HTTP-Referer"] = "https://opencode.ai/"
            provider.request.headers["X-Title"] = "opencode"
            provider.request.headers["X-BILLING-INVOKE-ORIGIN"] ??= "OpenCode"
          })
        }
      },
    }
  },
}

export default NvidiaPlugin
