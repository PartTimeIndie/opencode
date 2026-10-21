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
    // models.dev advertises GOOGLE_VERTEX_PROJECT for Vertex; keep the wider
    // Google Cloud project env names as fallbacks for existing ADC setups.
    const project =
      (typeof provider.options?.project === "string" ? provider.options.project : undefined) ??
      env["GOOGLE_VERTEX_PROJECT"] ??
      env["GOOGLE_CLOUD_PROJECT"] ??
      env["GCP_PROJECT"] ??
      env["GCLOUD_PROJECT"]

    const location = String(
      provider.options?.location ??
        env["GOOGLE_VERTEX_LOCATION"] ??
        env["GOOGLE_CLOUD_LOCATION"] ??
        env["VERTEX_LOCATION"] ??
        "us-central1",
    )

    const autoload = Boolean(project)
    if (!autoload) return { autoload: false }
    return {
      autoload: true,
      vars(_options: ProviderOptions) {
        const endpoint = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`
        return {
          ...(project && { GOOGLE_VERTEX_PROJECT: project }),
          GOOGLE_VERTEX_LOCATION: location,
          GOOGLE_VERTEX_ENDPOINT: endpoint,
        }
      },
      options: {
        project,
        location,
        fetch: async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const { GoogleAuth } = await import("google-auth-library")
          const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] })
          const client = await auth.getClient()
          const token = await client.getAccessToken()

          const headers = new Headers(init?.headers)
          headers.set("Authorization", `Bearer ${token.token}`)

          return fetch(input, { ...init, headers })
        },
      },
      async getModel(sdk: ProviderSDK, modelID: string) {
        const id = String(modelID).trim()
        return callLanguageModel(sdk, id)
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
