import { nativeModels } from "./native"
import { requestProfiles } from "./request-profiles"
import { transports } from "./transports"
import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"

export const OpenAICompatiblePlugin: ProviderPluginModule = {
  id: "openai-compatible",
  requestProfiles,
  nativeModels,
  modelDefaults(model) {
    return model.api.npm === "@ai-sdk/openai-compatible" && model.api.id.includes("deepseek")
      ? { interleaved: { field: "reasoning_content" } } : {}
  },
  async prepareTransport(model, options) {
    if (model.api.npm.includes("@ai-sdk/openai-compatible") && options.includeUsage !== false) options.includeUsage = true
  },
  transports,
  async provider(_api) {
    return {
      async "aisdk.sdk"(evt) {
        if (evt.sdk) return
        if (!evt.package.includes("@ai-sdk/openai-compatible")) return
        if (evt.options.includeUsage !== false) evt.options.includeUsage = true
        const mod = await import("@ai-sdk/openai-compatible")
        evt.sdk = mod.createOpenAICompatible(evt.options as unknown as Parameters<typeof mod.createOpenAICompatible>[0])
      },
    }
  },
}

export default OpenAICompatiblePlugin
