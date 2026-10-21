import { configureCatalog } from "./configure-catalog"
import { requestProfiles } from "./request-profiles"
import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"
import { oauth, applyToken, resolveAccessToken, PACKAGE } from "./auth"


const CURSOR_AISDK_PACKAGE = PACKAGE
const CURSOR_CACHE_FILE = "cursor-models.json"

import { cursorModelsFromCache } from "./models"
export { cursorModelsFromCache, cursorLabel } from "./models"

export const Plugin: ProviderPluginModule = {
  id: "cursor",
  configureCatalog,
  requestProfiles,
  transports: { "cursor-opencode-provider": async (options) => { const { createCursor } = await import("./upstream/index.js"); return createCursor(options) } },
  integrations: ["cursor"],
  async provider(api) {
    await api.integrations.update((editor) => {
      editor.update("cursor", (integration) => { integration.name = "Cursor" })
      editor.method.update(oauth)
      editor.method.update({ integrationID: "cursor", method: { type: "key", label: "API key (cursor.com/settings)" } })
      editor.method.update({ integrationID: "cursor", method: { type: "env", names: ["CURSOR_API_KEY"] } })
    })
    const models = cursorModelsFromCache(await api.cache.readJSON(CURSOR_CACHE_FILE).catch(() => undefined))
    if (models.length > 0) {
      await api.catalog.transform((editor) => {
        editor.provider.update("cursor", (provider) => {
          provider.name = "Cursor"
          provider.api = {
            type: "aisdk",
            package: CURSOR_AISDK_PACKAGE,
          }
        })
        for (const item of models) {
          const modelID = item.id
          editor.model.update("cursor", modelID, (model) => {
            model.name = item.name
            model.api = {
              id: modelID,
              type: "aisdk",
              package: CURSOR_AISDK_PACKAGE,
            }
            model.capabilities = {
              tools: true,
              input: item.images ? ["text", "image"] : ["text"],
              output: ["text"],
            }
            model.variants = item.variants.map((variant) => ({
              id: variant.id,
              headers: {},
              body: {},
              generation: {},
              options: { cursorVariantParameters: variant.parameters.map((parameter) => ({ ...parameter })) },
            }))
            model.time.released = 0
            model.status = "active"
            model.enabled = true
            model.limit = {
              context: item.context,
              output: 8192,
            }
          })
        }
      })
    }

    return {
      async "aisdk.sdk"(evt) {
        if (evt.package !== CURSOR_AISDK_PACKAGE) return
        const token = await resolveAccessToken(api)
        if (token) applyToken(evt.options, token)
        const { createCursor } = await import("./upstream/index.js")
        evt.sdk = createCursor({ ...evt.options, name: typeof evt.options.name === "string" ? evt.options.name : "cursor" })
      },
    }
  },
}

export default Plugin
