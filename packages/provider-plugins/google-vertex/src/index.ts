import { transports } from "./transports"
import { configure } from "./configure"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import type { ProviderPluginModule } from "@opencode-ai/plugin/provider"

function resolveProject(options: Record<string, unknown>) {
  // models.dev advertises GOOGLE_VERTEX_PROJECT for Vertex, while Google SDKs
  // and ADC examples commonly use the broader Google Cloud project aliases.
  return (
    stringOption(options, "project") ??
    process.env.GOOGLE_VERTEX_PROJECT ??
    process.env.GOOGLE_CLOUD_PROJECT ??
    process.env.GCP_PROJECT ??
    process.env.GCLOUD_PROJECT
  )
}

function resolveLocation(options: Record<string, unknown>) {
  return (
    stringOption(options, "location") ??
    process.env.GOOGLE_VERTEX_LOCATION ??
    process.env.GOOGLE_CLOUD_LOCATION ??
    process.env.VERTEX_LOCATION ??
    "us-central1"
  )
}

function stringOption(options: Record<string, unknown>, key: string) {
  return typeof options[key] === "string" ? options[key] : undefined
}

function vertexEndpoint(location: string) {
  if (location === "global") return "aiplatform.googleapis.com"
  return `${location}-aiplatform.googleapis.com`
}

function replaceVertexVars(value: string, project: string | undefined, location: string) {
  // Vertex OpenAI-compatible endpoints are stored as templates in the catalog;
  // expand them after provider config/env project and location have been resolved.
  return value
    .replaceAll("${GOOGLE_VERTEX_PROJECT}", project ?? "${GOOGLE_VERTEX_PROJECT}")
    .replaceAll("${GOOGLE_VERTEX_LOCATION}", location)
    .replaceAll("${GOOGLE_VERTEX_ENDPOINT}", vertexEndpoint(location))
}

function authFetch(fetchWithRuntimeOptions?: unknown) {
  // Native Vertex SDKs handle ADC internally. OpenAI-compatible Vertex endpoints
  // do not, so inject a Google access token into their fetch path.
  return async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const { GoogleAuth } = await import("google-auth-library")
    const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] })
    const client = await auth.getClient()
    const token = await client.getAccessToken()
    const headers = new Headers(init?.headers)
    headers.set("Authorization", `Bearer ${token.token}`)
    return typeof fetchWithRuntimeOptions === "function"
      ? fetchWithRuntimeOptions(input, { ...init, headers })
      : fetch(input, { ...init, headers })
  }
}

export const GoogleVertexPlugin: ProviderPluginModule = {
  id: "google-vertex",
  async prepareTransport(model, options) {
    if (model.providerID !== "google-vertex") return
    if (model.api.npm === "@ai-sdk/google-vertex/anthropic" && !options.baseURL && typeof options.project === "string" &&
      (options.location === "eu" || options.location === "us"))
      options.baseURL = `https://aiplatform.${options.location}.rep.googleapis.com/v1/projects/${options.project}/locations/${options.location}/publishers/anthropic/models`
    if (!model.api.npm.includes("@ai-sdk/openai-compatible")) delete options.fetch
  },
  transports,
  configure,
  async provider(api) {
    return {
      async "catalog.transform"(evt) {
        for (const item of evt.provider.list()) {
          if (item.provider.api.type !== "aisdk") continue
          if (
            item.provider.api.package !== "@ai-sdk/google-vertex" &&
            !(
              item.provider.id === "google-vertex" &&
              item.provider.api.package.includes("@ai-sdk/openai-compatible")
            )
          )
            continue
          const project = resolveProject(item.provider.request.body)
          const location = String(resolveLocation(item.provider.request.body))
          evt.provider.update(item.provider.id, (provider) => {
            if (project) provider.request.body.project = project
            provider.request.body.location = location
            if (provider.api.type === "aisdk" && provider.api.url) {
              provider.api.url = replaceVertexVars(provider.api.url, project, location)
            }
            if (provider.api.type === "aisdk" && provider.api.package.includes("@ai-sdk/openai-compatible")) {
              provider.request.body.fetch = authFetch(provider.request.body.fetch)
            }
          })
        }
      },
      async "aisdk.sdk"(evt) {
        if (evt.model.providerID === "google-vertex" && evt.package.includes("@ai-sdk/openai-compatible")) {
          evt.options.fetch = authFetch(evt.options.fetch)
          return
        }
        if (evt.package !== "@ai-sdk/google-vertex") return
        const mod = await import("@ai-sdk/google-vertex")
        const project = resolveProject(evt.options)
        const location = resolveLocation(evt.options)
        const options = { ...evt.options }
        delete options.fetch
        evt.sdk = mod.createVertex({
          ...options,
          project,
          location,
        })
      },
      async "aisdk.language"(evt) {
        if (evt.model.providerID !== "google-vertex") return
        evt.language = (evt.sdk as { languageModel(modelID: string): LanguageModelV3 }).languageModel(String(evt.model.api.id).trim())
      },
    }
  },
}

export default GoogleVertexPlugin
