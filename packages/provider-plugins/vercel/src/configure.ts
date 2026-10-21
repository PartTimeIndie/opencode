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
      options: {
        headers: {
          "http-referer": "https://opencode.ai/",
          "x-title": "opencode",
        },
      },
    })
  return loader(input)
}
