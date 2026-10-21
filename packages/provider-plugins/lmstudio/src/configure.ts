import type { ProviderPluginModule, ProviderConfigurationResult, ProviderTransport } from "@opencode-ai/plugin/provider"
import type { ProviderConfigurationModel, ProviderConfigurationRecord } from "@opencode-ai/plugin/provider"
type Model = ProviderConfigurationModel
type Provider = ProviderConfigurationRecord
type Info = Provider
type ProviderSDK = ProviderTransport
type ProviderOptions = Record<string, unknown>

export const configure: NonNullable<ProviderPluginModule["configure"]> = async (input, dep) => {
  const loader: (provider: Info) => Promise<ProviderConfigurationResult> = async function (input: Info) {
    const auth = await dep.auth(input.id)
    const provider = auth?.type === "api" ? { ...input, key: auth.key } : input
    return {
      autoload: input.source === "config",
      replaceDiscoveredModels: true,
      async discoverModels() {
        return discoverLMStudioModels(provider)
      },
    }
  }
  return loader(input)
}

async function discoverLMStudioModels(provider: Info) {
  const baseURL = openAICompatibleBaseURL(provider)
  if (!baseURL) return {}

  const models = await discoverLMStudioApiModels(provider, baseURL)
  if (models) return models
  return discoverOpenAICompatibleModels(provider)
}

function openAICompatibleBaseURL(provider: Info) {
  const value =
    typeof provider.options.baseURL === "string"
      ? provider.options.baseURL
      : Object.values(provider.models).find((model) => model.api.url)?.api.url
  const baseURL = value?.trim()
  if (!baseURL || !URL.canParse(baseURL)) return
  return new URL(baseURL).toString().replace(/\/+$/, "")
}

async function discoverOpenAICompatibleModels(provider: Info) {
  const baseURL = openAICompatibleBaseURL(provider)
  if (!baseURL) return {}

  const response = await fetch(openAICompatibleModelsURL(baseURL), {
    headers: openAICompatibleAuthHeaders(provider),
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok) return {}

  const body = await response.json()
  if (!isRecord(body) || !Array.isArray(body.data)) return {}

  return Object.fromEntries(
    body.data
      .filter((item): item is { id: string } => isRecord(item) && typeof item.id === "string" && item.id.trim() !== "")
      .map((item) => {
        const modelID = item.id.trim()
        return [modelID, discoveredOpenAICompatibleModel(provider, modelID, baseURL)]
      }),
  )
}

async function discoverLMStudioApiModels(provider: Info, baseURL: string): Promise<Record<string, Model> | undefined> {
  const models = await fetchLMStudioModels(baseURL, openAICompatibleAuthHeaders(provider))
  if (!models) return
  return Object.fromEntries(
    models
      .map((item) => discoveredLMStudioModel(provider, item, baseURL))
      .filter((item): item is [string, Model] => Boolean(item)),
  )
}

export async function fetchLMStudioModels(
  baseURL: string,
  headers?: RequestInit["headers"],
  signal?: AbortSignal,
): Promise<unknown[] | undefined> {
  try {
    const response = await fetch(lmStudioModelsURL(baseURL), {
      headers,
      signal: AbortSignal.any([AbortSignal.timeout(5_000), ...(signal ? [signal] : [])]),
    })
    if (!response.ok) return undefined

    const body = await response.json()
    if (!isRecord(body) || !Array.isArray(body.data)) return undefined

    return body.data
  } catch {
    return undefined
  }
}

function openAICompatibleModelsURL(baseURL: string) {
  const url = new URL(baseURL)
  const pathname = url.pathname.replace(/\/+$/, "")
  url.pathname = pathname.endsWith("/v1") ? `${pathname}/models` : `${pathname}/v1/models`
  return url.toString()
}

function lmStudioModelsURL(baseURL: string) {
  const url = new URL(baseURL)
  const pathname = url.pathname.replace(/\/+$/, "")
  const basePath = pathname.endsWith("/v1") ? pathname.slice(0, -3) : pathname
  url.pathname = `${basePath}/api/v0/models`
  return url.toString()
}

function openAICompatibleAuthHeaders(provider: Info) {
  const apiKey = typeof provider.options.apiKey === "string" ? provider.options.apiKey : provider.key
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined
}

function discoveredLMStudioModel(provider: Info, input: unknown, baseURL: string): [string, Model] | undefined {
  const loaded = loadedLMStudioModel(input)
  if (!loaded) return
  const model = discoveredOpenAICompatibleModel(provider, loaded.id, baseURL)
  if (loaded.context !== undefined) model.limit.context = loaded.context
  if (loaded.tools !== undefined) model.capabilities.toolcall = loaded.tools
  if (loaded.vision) {
    model.capabilities.attachment = true
    model.capabilities.input.image = true
  }
  return [model.id, model]
}

export function loadedLMStudioModel(input: unknown) {
  if (!isRecord(input) || typeof input.id !== "string" || input.id.trim() === "") return
  if (input.type === "embeddings" || input.state !== "loaded") return
  return {
    id: input.id.trim(),
    // The architecture maximum is not the context allocated to the loaded instance.
    context:
      typeof input.loaded_context_length === "number" &&
      Number.isSafeInteger(input.loaded_context_length) &&
      input.loaded_context_length > 0
        ? input.loaded_context_length
        : undefined,
    tools: Array.isArray(input.capabilities) ? input.capabilities.includes("tool_use") : undefined,
    vision: input.type === "vlm",
  }
}

function discoveredOpenAICompatibleModel(provider: Info, modelID: string, baseURL: string): Model {
  const existing = provider.models[modelID]
  return {
    id: modelID,
    providerID: provider.id,
    name: existing?.name ?? modelID,
    family: existing?.family ?? "",
    api: {
      id: modelID,
      url: baseURL,
      npm: existing?.api.npm ?? "@ai-sdk/openai-compatible",
    },
    status: existing?.status ?? "active",
    headers: existing?.headers ?? {},
    options: existing?.options ?? {},
    cost: existing?.cost ?? { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: existing ? { ...existing.limit } : { context: 32_768, output: 4_096 },
    capabilities: existing
      ? structuredClone(existing.capabilities)
      : {
          temperature: true,
          reasoning: false,
          attachment: false,
          toolcall: true,
          input: {
            text: true,
            audio: false,
            image: false,
            video: false,
            pdf: false,
          },
          output: {
            text: true,
            audio: false,
            image: false,
            video: false,
            pdf: false,
            transcription: false,
          },
          interleaved: false,
        },
    release_date: existing?.release_date ?? "",
    variants: existing?.variants ?? {},
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
