import type { ProviderPluginModule, ProviderConfigurationResult, ProviderTransport } from "@opencode-ai/plugin/provider"
import type { ProviderConfigurationModel, ProviderConfigurationRecord } from "@opencode-ai/plugin/provider"
type Model = ProviderConfigurationModel
type Provider = ProviderConfigurationRecord
type Info = Provider
type ProviderSDK = ProviderTransport
type ProviderOptions = Record<string, unknown>

export const configure: NonNullable<ProviderPluginModule["configure"]> = async (input, dep) => {
  const loader: (provider: Info) => Promise<ProviderConfigurationResult> = async function () {
    const env = await dep.env()
    const project = env["GOOGLE_CLOUD_PROJECT"] ?? env["GCP_PROJECT"] ?? env["GCLOUD_PROJECT"]
    const location = env["GOOGLE_CLOUD_LOCATION"] ?? env["VERTEX_LOCATION"] ?? "global"
    const autoload = Boolean(project)
    if (!autoload) return { autoload: false }
    const baseURL = googleVertexAnthropicBaseURL(project, location)
    return {
      autoload: true,
      options: {
        project,
        location,
        ...(baseURL && { baseURL }),
      },
      async getModel(sdk: ProviderSDK, modelID: string) {
        const id = String(modelID).trim()
        return callLanguageModel(sdk, id)
      },
    }
  }
  return loader(input)
}

function googleVertexAnthropicBaseURL(project: string | undefined, location: string | undefined) {
  if (!project) return
  if (location !== "eu" && location !== "us") return
  // Continental multi-regions require Regional Endpoint Platform domains.
  return `https://aiplatform.${location}.rep.googleapis.com/v1/projects/${project}/locations/${location}/publishers/anthropic/models`
}

function callLanguageModel(sdk: ProviderSDK, modelID: string) {
  if (typeof sdk.languageModel === "function") return sdk.languageModel(modelID)
  if (typeof sdk === "function") return sdk(modelID)
  throw new Error("Provider SDK does not expose a language model factory")
}
