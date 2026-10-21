import type { ProviderPluginModule, ProviderConfigurationResult, ProviderTransport } from "@opencode-ai/plugin/provider"
import type { ProviderConfigurationModel, ProviderConfigurationRecord } from "@opencode-ai/plugin/provider"
type Model = ProviderConfigurationModel
type Provider = ProviderConfigurationRecord
type Info = Provider
type ProviderSDK = ProviderTransport
type ProviderOptions = Record<string, unknown>

export const configure: NonNullable<ProviderPluginModule["configure"]> = async (input, dep) => {
  const loader: (provider: Info) => Promise<ProviderConfigurationResult> = async function () {
    const auth = await dep.auth("sap-ai-core")
    // TODO: Using process.env directly because Env.set only updates a shallow copy (not process.env),
    // until the scope of the Env API is clarified (test only or runtime?)
    const envServiceKey = iife(() => {
      const envAICoreServiceKey = process.env.AICORE_SERVICE_KEY
      if (envAICoreServiceKey) return envAICoreServiceKey
      if (auth?.type === "api") {
        process.env.AICORE_SERVICE_KEY = auth.key
        return auth.key
      }
      return undefined
    })
    const deploymentId = process.env.AICORE_DEPLOYMENT_ID
    const resourceGroup = process.env.AICORE_RESOURCE_GROUP

    return {
      autoload: !!envServiceKey,
      options: envServiceKey ? { deploymentId, resourceGroup } : {},
      async getModel(sdk: ProviderSDK, modelID: string) {
        return callLanguageModel(sdk, modelID)
      },
    }
  }
  return loader(input)
}

function callLanguageModel(sdk: ProviderSDK, modelID: string) {
  if (typeof sdk.languageModel === "function") return sdk.languageModel(modelID)
  if (typeof sdk === "function") return sdk(modelID)
  throw new Error("Provider SDK does not expose a language model factory")
}

function iife<T>(fn: () => T) {
  return fn()
}
