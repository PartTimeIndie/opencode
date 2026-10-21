import { transports } from "./transports"
import { configure } from "./configure"
import { createSDK } from "./sdk"
import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"

export const CerebrasPlugin: ProviderPluginModule = {
  id: "cerebras",
  transports,
  configure,
  requestProfiles: {
    "@ai-sdk/cerebras": {
      namespace: "cerebras",
      semantics: {
        reasoningEffort: "reasoningEffort",
        reasoning_effort: "reasoningEffort",
        reasoning_format: "reasoning_format",
      },
    },
  },
  async provider(_api) {
    return {
      async "catalog.transform"(ctx) {
        for (const item of ctx.provider.list()) {
          if (item.provider.api.type !== "aisdk") continue
          if (item.provider.api.package !== "@ai-sdk/cerebras") continue
          ctx.provider.update(item.provider.id, (provider) => {
            provider.request.headers["X-Cerebras-3rd-Party-Integration"] = "opencode"
          })
        }
      },
      async "aisdk.sdk"(evt) {
        if (evt.package !== "@ai-sdk/cerebras") return
        evt.sdk = await createSDK(evt.options)
      },
    }
  },
}

export default CerebrasPlugin
