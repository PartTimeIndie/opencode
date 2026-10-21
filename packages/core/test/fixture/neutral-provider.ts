import type { ProviderHost, ProviderPluginModule } from "@opencode-ai/plugin/provider"

/** A second consumer deliberately knows no Core modules, branded IDs, or Effect services. */
export function neutralProvider(observe: (api: ProviderHost) => void): ProviderPluginModule {
  return {
    id: "neutral-provider",
    integrations: ["neutral"],
    async provider(api) {
      observe(api)
      await api.integrations.update((editor) => {
        editor.update("neutral", (integration) => { integration.name = "Neutral" })
        editor.method.update({ integrationID: "neutral", method: { type: "key", label: "Neutral key" } })
      })
      await api.catalog.transform((editor) => {
        editor.provider.update("neutral", (provider) => {
          provider.name = "Neutral"
          provider.api = { type: "aisdk", package: "neutral-sdk" }
        })
        editor.model.update("neutral", "speech", (model) => {
          model.name = "Neutral Speech"
          model.time.released = 1234
          model.capabilities.output = ["audio"]
          model.limit = { context: 8192, output: 2048 }
        })
      })
      return {
        async "catalog.transform"(editor) {
          editor.provider.update("neutral", (provider) => { provider.request.headers["X-Neutral"] = "yes" })
        },
        async "aisdk.sdk"(event) {
          if (event.package === "neutral-sdk") event.sdk = { name: "neutral-sdk", options: event.options }
        },
      }
    },
  }
}
