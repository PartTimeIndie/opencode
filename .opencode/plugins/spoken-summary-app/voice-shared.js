export const VOICE_LANGUAGES = [
  { value: "de", label: "Deutsch" },
  { value: "en", label: "English" },
  { value: "fr", label: "Français" },
  { value: "auto", label: "Automatisch" },
]

export const VOICE_NOTES_KEY = "voice-notes.v1"

export function parseVoiceLanguage(voice) {
  const value = String(voice ?? "").toLowerCase()
  if (!value) return undefined
  const prefix = value.match(/^([a-z]{2})[-_]/)
  if (prefix) return prefix[1]
  if (value.includes("klaus") || value.includes("harper") === false && value.includes("deutsch")) return "de"
  if (value.includes("paul") || value.includes("marie")) {
    if (value.startsWith("en_") || value.startsWith("en-")) return "en"
    if (value.startsWith("fr_") || value.startsWith("fr-")) return "fr"
  }
  return undefined
}

export function voiceLabel(voice, note) {
  const language = parseVoiceLanguage(voice)
  const languageTag = language === "de" ? "Deutsch" : language === "en" ? "English" : language === "fr" ? "Français" : "Sprache unbekannt"
  const extra = note?.quality ? ` · ${note.quality}` : ""
  const cost = note?.cost ? ` · ${note.cost}` : ""
  return `${voice} (${languageTag}${extra}${cost})`
}

export function filterVoicesByLanguage(voices, language) {
  const list = Array.isArray(voices) ? voices.filter((voice) => typeof voice === "string" && voice.trim()) : []
  if (language !== "de" && language !== "en" && language !== "fr") return list
  const matching = list.filter((voice) => parseVoiceLanguage(voice) === language)
  return matching.length ? matching : list
}

export function resolveVoice({ voice, voices, modelVoices, language }) {
  const preferred = typeof voice === "string" ? voice.trim() : ""
  const candidates = Array.isArray(modelVoices) && modelVoices.length
    ? modelVoices
    : Array.isArray(voices) ? Object.values(voices).flat() : []
  const pool = filterVoicesByLanguage(candidates.length ? candidates : [preferred], language)
  if (preferred && pool.includes(preferred)) return preferred
  if (preferred && parseVoiceLanguage(preferred) === language) return preferred
  return pool[0] ?? preferred ?? ""
}

export function speechModelsFromProviders(providers) {
  const list = []
  const all = Array.isArray(providers) ? providers : Object.values(providers ?? {})
  for (const provider of all) {
    for (const model of Object.values(provider?.models ?? {})) {
      if (model?.capabilities?.output?.speech !== true) continue
      list.push({
        id: `${provider.id}/${model.id}`,
        providerID: provider.id,
        modelID: model.id,
        name: model.name ?? model.id,
        voices: Array.isArray(model.supported_voices) ? model.supported_voices.filter(Boolean) : [],
        cost: model.cost,
      })
    }
  }
  return list.sort((a, b) => a.id.localeCompare(b.id))
}

export function formatCost(cost) {
  if (!cost || typeof cost.input !== "number") return ""
  if (!cost.input && !cost.output) return "Kosten unbekannt"
  return `In ${cost.input} / Out ${cost.output}`
}

export function voiceNotes(notes, modelID) {
  if (!notes || typeof notes !== "object") return undefined
  const note = notes[modelID]
  return note && typeof note === "object" ? note : undefined
}

export function modelsNeedingEvaluation(models, notes) {
  return models.filter((model) => !voiceNotes(notes, model.id)).map((model) => model.id)
}

export function mergeVoiceNotes(previous, updates) {
  return { ...(previous ?? {}), ...(updates ?? {}) }
}

export function evaluationPrompt(models) {
  return {
    system: "Bewerte kurze TTS-Modellinfos als JSON. Antworte nur mit JSON wie {\"<model-id>\": {\"quality\": \"gut|mittel|schlecht\", \"german\": \"gut|mittel|schlecht\", \"cost\": \"niedrig|mittel|hoch\", \"latency\": \"schnell|mittel|langsam\"}}. Keine Erklärung, kein Markdown. Grundlage sind Modellname, Anbieter und bekannte Stimmen-IDs; erfinde keine Messwerte, markiere Unsicherheit mit mittel.",
    prompt: `Modelle:\n${models.map((model) => `- ${model.id} (${model.name}); Stimmen: ${(model.voices ?? []).slice(0, 8).join(", ") || "unbekannt"}`).join("\n")}`,
  }
}

export function parseEvaluationNotes(text, models) {
  const cleaned = String(text ?? "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim()
  const parsed = JSON.parse(cleaned)
  const allowed = new Set(models.map((model) => model.id))
  const result = {}
  for (const [modelID, note] of Object.entries(parsed ?? {})) {
    if (!allowed.has(modelID) || !note || typeof note !== "object") continue
    const pick = (value) => typeof value === "string" ? value.slice(0, 32) : undefined
    result[modelID] = { quality: pick(note.quality), german: pick(note.german), cost: pick(note.cost), latency: pick(note.latency) }
  }
  return result
}
