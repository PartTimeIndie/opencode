import { transports } from "./transports"
import { configure } from "./configure"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"

export const GoogleVertexAnthropicPlugin: ProviderPluginModule = {
  id: "google-vertex-anthropic",
  transports,
  configure,
  async provider(api) {
    return {
      async "catalog.transform"(evt) {
        for (const item of evt.provider.list()) {
          if (item.provider.api.type !== "aisdk") continue
          if (item.provider.api.package !== "@ai-sdk/google-vertex/anthropic") continue
          const project =
            item.provider.request.body.project ??
            process.env.GOOGLE_CLOUD_PROJECT ??
            process.env.GCP_PROJECT ??
            process.env.GCLOUD_PROJECT
          const location =
            item.provider.request.body.location ??
            process.env.GOOGLE_CLOUD_LOCATION ??
            process.env.VERTEX_LOCATION ??
            "global"
          evt.provider.update(item.provider.id, (provider) => {
            if (project) provider.request.body.project = project
            provider.request.body.location = location
          })
        }
      },
      async "aisdk.sdk"(evt) {
        if (evt.package !== "@ai-sdk/google-vertex/anthropic") return
        const mod = await import("@ai-sdk/google-vertex/anthropic")
        const project =
          typeof evt.options.project === "string"
            ? evt.options.project
            : (process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCP_PROJECT ?? process.env.GCLOUD_PROJECT)
        const location =
          typeof evt.options.location === "string"
            ? evt.options.location
            : (process.env.GOOGLE_CLOUD_LOCATION ?? process.env.VERTEX_LOCATION ?? "global")
        evt.sdk = mod.createVertexAnthropic({
          ...evt.options,
          project,
          location,
          // Continental multi-regions (eu, us) require Regional Endpoint Platform
          // domains; the default {region}-aiplatform.googleapis.com does not resolve.
          ...((location === "eu" || location === "us") && project && !evt.options.baseURL
            ? {
                baseURL: `https://aiplatform.${location}.rep.googleapis.com/v1/projects/${project}/locations/${location}/publishers/anthropic/models`,
              }
            : {}),
        })
      },
      async "aisdk.language"(evt) {
        if (evt.model.providerID !== "google-vertex-anthropic") return
        evt.language = (evt.sdk as { languageModel(modelID: string): LanguageModelV3 }).languageModel(String(evt.model.api.id).trim())
      },
    }
  },
}

export default GoogleVertexAnthropicPlugin
