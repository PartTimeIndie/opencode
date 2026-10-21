import { transports } from "./transports"
import { configure } from "./configure"
import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"

export const VercelPlugin: ProviderPluginModule = {
  id: "vercel",
  transports,
  configure,
  async provider(_api) {
    return {
      async "catalog.transform"(evt) {
        for (const item of evt.provider.list()) {
          if (item.provider.api.type !== "aisdk") continue
          if (item.provider.api.package !== "@ai-sdk/vercel") continue
          evt.provider.update(item.provider.id, (provider) => {
            provider.request.headers["http-referer"] = "https://opencode.ai/"
            provider.request.headers["x-title"] = "opencode"
          })
        }
      },
      async "aisdk.sdk"(evt) {
        if (evt.package !== "@ai-sdk/vercel") return
        const mod = await import("@ai-sdk/vercel")
        evt.sdk = mod.createVercel(evt.options)
      },
    }
  },
}

export default VercelPlugin
