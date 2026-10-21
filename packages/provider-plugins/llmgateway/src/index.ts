import { configure } from "./configure"
import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"

export const LLMGatewayPlugin: ProviderPluginModule = {
  id: "llmgateway",
  configure,
  async provider(api) {
    const integrations = api.integrations
    return {
      async "catalog.transform"(evt) {
        for (const item of evt.provider.list()) {
          if (item.provider.disabled) continue
          if (!(await integrations.get(item.provider.id))) continue
          if (item.provider.api.type !== "aisdk") continue
          if (item.provider.api.package !== "@ai-sdk/openai-compatible") continue
          if (item.provider.api.url !== "https://api.llmgateway.io/v1") continue
          evt.provider.update(item.provider.id, (provider) => {
            provider.request.headers["HTTP-Referer"] = "https://opencode.ai/"
            provider.request.headers["X-Title"] = "opencode"
            provider.request.headers["X-Source"] = "opencode"
          })
        }
      },
    }
  },
}

export default LLMGatewayPlugin
