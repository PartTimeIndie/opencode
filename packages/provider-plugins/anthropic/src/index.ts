import { nativeModels } from "./native"
import { requestProfiles } from "./request-profiles"
import { transports } from "./transports"
import { configure } from "./configure"
import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"

export const AnthropicPlugin: ProviderPluginModule = {
  id: "anthropic",
  requestProfiles,
  nativeModels,
  transports,
  configure,
  async provider(_api) {
    return {
      async "catalog.transform"(evt) {
        for (const item of evt.provider.list()) {
          if (item.provider.api.type !== "aisdk") continue
          if (item.provider.api.package !== "@ai-sdk/anthropic") continue
          evt.provider.update(item.provider.id, (provider) => {
            provider.request.headers["anthropic-beta"] =
              "interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14"
          })
        }
      },
      async "aisdk.sdk"(evt) {
        if (evt.package !== "@ai-sdk/anthropic") return
        const mod = await import("@ai-sdk/anthropic")
        evt.sdk = mod.createAnthropic(evt.options)
      },
    }
  },
}

export default AnthropicPlugin
