import { configure } from "./configure"
import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"

export const ZenmuxPlugin: ProviderPluginModule = {
  id: "zenmux",
  configure,
  async provider(_api) {
    return {
      async "catalog.transform"(evt) {
        for (const item of evt.provider.list()) {
          if (item.provider.api.type !== "aisdk") continue
          if (item.provider.api.package !== "@ai-sdk/openai-compatible") continue
          if (item.provider.api.url !== "https://zenmux.ai/api/v1") continue
          evt.provider.update(item.provider.id, (provider) => {
            provider.request.headers["HTTP-Referer"] ??= "https://opencode.ai/"
            provider.request.headers["X-Title"] ??= "opencode"
          })
        }
      },
    }
  },
}

export default ZenmuxPlugin
