import os from "node:os"
import type { ProviderPluginModule, ProviderConfigurationResult, ProviderTransport } from "@opencode-ai/plugin/provider"
import type { ProviderConfigurationModel, ProviderConfigurationRecord } from "@opencode-ai/plugin/provider"
type Model = ProviderConfigurationModel
type Provider = ProviderConfigurationRecord
type Info = Provider
type ProviderSDK = ProviderTransport
type ProviderOptions = Record<string, unknown>

export const configure: NonNullable<ProviderPluginModule["configure"]> = async (input, dep) => {
  const loader: (provider: Info) => Promise<ProviderConfigurationResult> = async function (input: Info) {
    // When baseURL is already configured (e.g. corporate config routing through a proxy/gateway),
    // skip the account ID check because the URL is already fully specified.
    if (input.options?.baseURL) return { autoload: false }

    const auth = await dep.auth(input.id)
    const env = await dep.env()
    const accountId = env["CLOUDFLARE_ACCOUNT_ID"] || (auth?.type === "api" ? auth.metadata?.accountId : undefined)
    if (!accountId)
      return {
        autoload: false,
        async getModel() {
          throw new Error(
            "CLOUDFLARE_ACCOUNT_ID is missing. Set it with: export CLOUDFLARE_ACCOUNT_ID=<your-account-id>",
          )
        },
      }

    const apiKey = env["CLOUDFLARE_API_KEY"] || (auth?.type === "api" ? auth.key : undefined)

    return {
      autoload: !!apiKey,
      options: {
        apiKey,
        headers: {
          "User-Agent": `opencode/${dep.version} cloudflare-workers-ai (${os.platform()} ${os.release()}; ${os.arch()})`,
        },
      },
      async getModel(sdk: ProviderSDK, modelID: string) {
        return callLanguageModel(sdk, modelID)
      },
      vars(_options) {
        return {
          CLOUDFLARE_ACCOUNT_ID: accountId,
        }
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
