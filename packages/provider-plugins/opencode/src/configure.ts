import type { ProviderPluginModule, ProviderConfigurationResult, ProviderTransport } from "@opencode-ai/plugin/provider"
import type { ProviderConfigurationModel, ProviderConfigurationRecord } from "@opencode-ai/plugin/provider"
type Model = ProviderConfigurationModel
type Provider = ProviderConfigurationRecord
type Info = Provider
type ProviderSDK = ProviderTransport
type ProviderOptions = Record<string, unknown>

export const configure: NonNullable<ProviderPluginModule["configure"]> = async (input, dep) => {
  const loader: (provider: Info) => Promise<ProviderConfigurationResult> = async function (input: Info) {
    const env = await dep.env()
    const hasKey = iife(() => {
      if (input.env.some((item) => env[item])) return true
      return false
    })
    const ok =
      hasKey ||
      Boolean(await dep.auth(input.id)) ||
      Boolean((await dep.config()).provider?.["opencode"]?.options?.apiKey)

    if (!ok) {
      for (const [key, value] of Object.entries(input.models)) {
        if (value.cost.input === 0) continue
        delete input.models[key]
      }
    }

    return {
      autoload: Object.keys(input.models).length > 0,
      options: ok ? {} : { apiKey: "public" },
      discoverModels: async () => input.models,
      replaceDiscoveredModels: true,
    }
  }
  return loader(input)
}

function iife<T>(fn: () => T) {
  return fn()
}
