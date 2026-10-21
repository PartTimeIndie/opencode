import type { ProviderPluginModule, ProviderConfigurationResult, ProviderTransport } from "@opencode-ai/plugin/provider"
import type { ProviderConfigurationModel, ProviderConfigurationRecord } from "@opencode-ai/plugin/provider"
type Model = ProviderConfigurationModel
type Provider = ProviderConfigurationRecord
type Info = Provider
type ProviderSDK = ProviderTransport
type ProviderOptions = Record<string, unknown>

export const configure: NonNullable<ProviderPluginModule["configure"]> = async (input, dep) => {
  const loader: (provider: Info) => Promise<ProviderConfigurationResult> = async function () {
    const resourceName = await dep.get("AZURE_COGNITIVE_SERVICES_RESOURCE_NAME")
    return {
      autoload: false,
      async getModel(sdk: ProviderSDK, modelID: string, options?: ProviderOptions) {
        return selectAzureLanguageModel(sdk, modelID, Boolean(options?.["useCompletionUrls"]))
      },
      options: {
        baseURL: resourceName ? `https://${resourceName}.cognitiveservices.azure.com/openai` : undefined,
      },
    }
  }
  return loader(input)
}

function selectAzureLanguageModel(sdk: ProviderSDK, modelID: string, useChat: boolean) {
  if (useChat && sdk.chat) return sdk.chat(modelID)
  if (sdk.responses) return sdk.responses(modelID)
  if (sdk.messages) return sdk.messages(modelID)
  if (sdk.chat) return sdk.chat(modelID)
  return callLanguageModel(sdk, modelID)
}

function callLanguageModel(sdk: ProviderSDK, modelID: string) {
  if (typeof sdk.languageModel === "function") return sdk.languageModel(modelID)
  if (typeof sdk === "function") return sdk(modelID)
  throw new Error("Provider SDK does not expose a language model factory")
}
