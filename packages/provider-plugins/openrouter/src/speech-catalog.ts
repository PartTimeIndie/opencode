import type { ProviderConfigurationRecord } from "@opencode-ai/plugin/provider"

type SpeechModel = { id: string; name: string; voices: string[] }
const cache = new Map<string, { expires: number; models: SpeechModel[] }>()

/** The default OpenRouter /models response excludes speech models. Configured
 * speech placeholders therefore need the purpose-specific live catalogue. */
export async function refreshSpeechCatalog(provider: ProviderConfigurationRecord, signal: AbortSignal) {
  if (!Object.values(provider.models).some((model) => model.capabilities.output.speech)) return
  const configured = provider.options.baseURL
  const base = (typeof configured === "string" ? configured : "https://openrouter.ai/api/v1").replace(/\/+$/, "")
  const endpoint = `${base}/models?output_modalities=speech`
  const previous = cache.get(endpoint)
  const models = previous && previous.expires > Date.now()
    ? previous.models
    : await fetch(endpoint, { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Speech catalogue returned ${response.status}`)
        const body: unknown = await response.json()
        if (!body || typeof body !== "object" || !("data" in body) || !Array.isArray(body.data))
          throw new Error("Invalid speech catalogue")
        return body.data.map((item: unknown): SpeechModel => {
          if (!item || typeof item !== "object" || !("id" in item) || typeof item.id !== "string" ||
            !("supported_voices" in item) || (item.supported_voices !== null && !Array.isArray(item.supported_voices)))
            throw new Error("Invalid speech model")
          return {
            id: item.id,
            name: "name" in item && typeof item.name === "string" ? item.name : item.id,
            voices: (item.supported_voices ?? []).filter((voice): voice is string => typeof voice === "string" && !!voice.trim()),
          }
        })
      }).then((models) => {
        cache.set(endpoint, { models, expires: Date.now() + 60_000 })
        return models
      }).catch(() => {
        signal.throwIfAborted()
        // A catalogue outage must not hide configured models or prevent chat startup.
        return undefined
      })
  if (!models) return
  signal.throwIfAborted()
  const available = new Set(models.map((model) => model.id))
  for (const [id, model] of Object.entries(provider.models))
    if (model.capabilities.output.speech && !available.has(id)) delete provider.models[id]
  for (const model of models) {
    const existing = provider.models[model.id]
    if (existing) {
      existing.supported_voices = [...model.voices]
      continue
    }
    provider.models[model.id] = {
      id: model.id, providerID: provider.id, name: model.name,
      api: { id: model.id, url: base, npm: "@openrouter/ai-sdk-provider" },
      capabilities: {
        temperature: false, reasoning: false, attachment: false, toolcall: false, interleaved: false,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: false, audio: false, image: false, video: false, pdf: false, speech: true },
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 0, output: 0 }, status: "active", options: {}, headers: {}, release_date: "",
      supported_voices: [...model.voices], variants: {},
    }
  }
}
