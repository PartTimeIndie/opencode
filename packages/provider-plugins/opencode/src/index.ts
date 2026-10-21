import { configure } from "./configure"
import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"

export const OpencodePlugin: ProviderPluginModule = {
  id: "opencode",
  configure,
  async provider(api) {
    const integrations = api.integrations
    let hasKey = false
    return {
      async "catalog.transform"(evt) {
        const item = evt.provider.get("opencode")
        if (!item) return
        const integration = await integrations.get(item.provider.id)
        hasKey = Boolean(
          process.env.OPENCODE_API_KEY || integration?.connections.length || item.provider.request.body.apiKey,
        )
        evt.provider.update(item.provider.id, (provider) => {
          if (!hasKey) provider.request.body.apiKey = "public"
        })
        if (hasKey) return
        for (const model of item.models.values()) {
          if (!model.cost.some((cost) => cost.input > 0)) continue
          evt.model.update(item.provider.id, model.id, (draft) => {
            draft.enabled = false
          })
        }
      },
    }
  },
}

export default OpencodePlugin
