import { configure } from "./configure"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"

export const SapAICorePlugin: ProviderPluginModule = {
  id: "sap-ai-core",
  configure,
  async provider(api) {
    return {
      async "aisdk.sdk"(evt) {
        if (evt.model.providerID !== "sap-ai-core") return
        const serviceKey =
          process.env.AICORE_SERVICE_KEY ??
          (typeof evt.options.serviceKey === "string" ? evt.options.serviceKey : undefined)
        if (serviceKey && !process.env.AICORE_SERVICE_KEY) process.env.AICORE_SERVICE_KEY = serviceKey

        const mod = await import(await api.modules.resolve(evt.package)) as Record<string, (options: Record<string, unknown>) => unknown>
        const match = Object.keys(mod).find((name) => name.startsWith("create"))
        if (!match) throw new Error(`Package ${evt.package} has no provider factory export`)

        evt.sdk = mod[match](
          serviceKey
            ? { deploymentId: process.env.AICORE_DEPLOYMENT_ID, resourceGroup: process.env.AICORE_RESOURCE_GROUP }
            : {},
        )
      },
      async "aisdk.language"(evt) {
        if (evt.model.providerID !== "sap-ai-core") return
        evt.language = (evt.sdk as (modelID: string) => LanguageModelV3)(evt.model.api.id)
      },
    }
  },
}

export default SapAICorePlugin
