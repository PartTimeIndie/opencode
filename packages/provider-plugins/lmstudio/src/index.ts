import { configure, fetchLMStudioModels, loadedLMStudioModel } from "./configure"
import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"

const plugin: ProviderPluginModule = {
  id: "lmstudio",
  configure,
  async provider(api) {
    return {
      async "catalog.transform"(catalog) {
        const record = catalog.provider.get("lmstudio")
        if (!record || record.provider.disabled) return
        const baseURL = record.provider.api.url ?? [...record.models.values()].find((model) => model.api.url)?.api.url
        if (!baseURL || !URL.canParse(baseURL)) return
        const headers = new Headers(record.provider.request.headers)
        const key = record.provider.request.body.apiKey ?? record.provider.api.settings?.apiKey
        if (typeof key === "string" && !headers.has("authorization")) headers.set("authorization", `Bearer ${key}`)
        const models = await fetchLMStudioModels(baseURL, headers, api.lifecycle.signal)
        if (!models || api.lifecycle.signal.aborted) return
        for (const input of models) {
          const loaded = loadedLMStudioModel(input)
          if (!loaded) continue
          const aliases = [...record.models.values()].filter(
            (model) => model.api.id === loaded.id || model.id === loaded.id,
          )
          for (const id of aliases.length ? aliases.map((model) => model.id) : [loaded.id]) {
            const existing = catalog.model.get("lmstudio", id)
            catalog.model.update("lmstudio", id, (model) => {
              if (!existing) {
                model.api = { id: loaded.id, type: "aisdk", package: "@ai-sdk/openai-compatible", url: baseURL }
                model.limit = { context: 32_768, output: 4_096 }
                model.capabilities = { tools: true, input: ["text/*"], output: ["text/*"] }
              }
              if (loaded.context !== undefined) model.limit.context = loaded.context
              if (loaded.tools !== undefined) model.capabilities.tools = loaded.tools
              if (loaded.vision && !model.capabilities.input.includes("image/*"))
                model.capabilities.input.push("image/*")
            })
          }
        }
      },
    }
  },
}

export default plugin
