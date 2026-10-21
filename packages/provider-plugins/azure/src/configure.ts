import type { ProviderPluginModule, ProviderConfigurationResult, ProviderTransport } from "@opencode-ai/plugin/provider"
import type { ProviderConfigurationModel, ProviderConfigurationRecord } from "@opencode-ai/plugin/provider"
type Model = ProviderConfigurationModel
type Provider = ProviderConfigurationRecord
type Info = Provider
type ProviderSDK = ProviderTransport
type ProviderOptions = Record<string, unknown>

export const configure: NonNullable<ProviderPluginModule["configure"]> = async (input, dep) => {
  const loader: (provider: Info) => Promise<ProviderConfigurationResult> = async function (provider: Info) {
    const env = await dep.env()
    const auth = await dep.auth(provider.id)
    const resource = iife(() => {
      return [
        provider.options?.resourceName,
        auth?.type === "api" ? auth.metadata?.resourceName : undefined,
        env["AZURE_RESOURCE_NAME"],
      ].find((name): name is string => typeof name === "string" && name.trim() !== "")
    })

    if (!resource && !provider.options?.baseURL) {
      return {
        autoload: false,
        async getModel() {
          throw new Error(
            "AZURE_RESOURCE_NAME is missing, set it using env var or reconnecting the azure provider and setting it",
          )
        },
      }
    }

    return {
      autoload: false,
      async getModel(sdk: ProviderSDK, modelID: string, options?: ProviderOptions) {
        return selectAzureLanguageModel(sdk, modelID, Boolean(options?.["useCompletionUrls"]))
      },
      options: {
        resourceName: resource,
      },
      vars(_options): Record<string, string> {
        if (resource) {
          return {
            AZURE_RESOURCE_NAME: resource,
          }
        }
        return {}
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

function iife<T>(fn: () => T) {
  return fn()
}
