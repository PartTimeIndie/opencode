import type { ProviderPluginModule, ProviderConfigurationResult, ProviderTransport } from "@opencode-ai/plugin/provider"
import type { ProviderConfigurationModel, ProviderConfigurationRecord } from "@opencode-ai/plugin/provider"
type Model = ProviderConfigurationModel
type Provider = ProviderConfigurationRecord
type Info = Provider
type ProviderSDK = ProviderTransport
type ProviderOptions = Record<string, unknown>

export const configure: NonNullable<ProviderPluginModule["configure"]> = async (input, dep) => {
  const loader: (provider: Info) => Promise<ProviderConfigurationResult> = () =>
    Promise.resolve({
      autoload: false,
      async getModel(sdk: ProviderSDK, modelID: string, _options?: ProviderOptions, model?: Model) {
        if (sdk.responses === undefined && sdk.chat === undefined) return callLanguageModel(sdk, modelID)
        const endpoint = model && "endpoint" in model.api ? model.api.endpoint : undefined
        if (endpoint === "responses" && sdk.responses) return sdk.responses(modelID)
        if (endpoint === "chat" && sdk.chat) return sdk.chat(modelID)
        const match = /^gpt-(\d+)/.exec(modelID)
        if (match && Number(match[1]) >= 5 && !modelID.startsWith("gpt-5-mini") && sdk.responses)
          return sdk.responses(modelID)
        return sdk.chat?.(modelID) ?? callLanguageModel(sdk, modelID)
      },
      options: {},
    })
  return loader(input)
}

function callLanguageModel(sdk: ProviderSDK, modelID: string) {
  if (typeof sdk.languageModel === "function") return sdk.languageModel(modelID)
  if (typeof sdk === "function") return sdk(modelID)
  throw new Error("Provider SDK does not expose a language model factory")
}
