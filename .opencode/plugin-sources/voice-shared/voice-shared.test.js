import { describe, expect, test } from "bun:test"
import {
  VOICE_LANGUAGES,
  filterVoicesByLanguage,
  formatCost,
  modelsNeedingEvaluation,
  parseEvaluationNotes,
  parseVoiceLanguage,
  resolveVoice,
  speechModelsFromProviders,
  voiceLabel,
} from "./voice-shared.js"

describe("voice-shared language", () => {
  test("detects voice language from id", () => {
    expect(parseVoiceLanguage("de-DE-Klaus:MAI-Voice-2")).toBe("de")
    expect(parseVoiceLanguage("en-US-Harper:MAI-Voice-2")).toBe("en")
    expect(parseVoiceLanguage("en_paul_sad")).toBe("en")
    expect(parseVoiceLanguage("fr_marie_neutral")).toBe("fr")
    expect(parseVoiceLanguage("")).toBeUndefined()
  })

  test("filters voices by language with fallback", () => {
    const voices = ["de-DE-Klaus:MAI-Voice-2", "en-US-Harper:MAI-Voice-2"]
    expect(filterVoicesByLanguage(voices, "de")).toEqual(["de-DE-Klaus:MAI-Voice-2"])
    expect(filterVoicesByLanguage(voices, "auto")).toEqual(voices)
    expect(filterVoicesByLanguage(["en-US-Harper:MAI-Voice-2"], "de")).toEqual(["en-US-Harper:MAI-Voice-2"])
  })

  test("resolves German voice by default", () => {
    const voices = ["en-US-Harper:MAI-Voice-2", "de-DE-Klaus:MAI-Voice-2"]
    expect(resolveVoice({ voice: "", voices: [], modelVoices: voices, language: "de" })).toBe("de-DE-Klaus:MAI-Voice-2")
    expect(resolveVoice({ voice: "en-US-Harper:MAI-Voice-2", modelVoices: voices, language: "de" })).toBe("de-DE-Klaus:MAI-Voice-2")
    expect(resolveVoice({ voice: "de-DE-Klaus:MAI-Voice-2", modelVoices: voices, language: "de" })).toBe("de-DE-Klaus:MAI-Voice-2")
  })

  test("labels voices with language", () => {
    expect(voiceLabel("de-DE-Klaus:MAI-Voice-2")).toContain("Deutsch")
    expect(voiceLabel("en-US-Harper:MAI-Voice-2", { quality: "gut", cost: "niedrig" })).toContain("gut")
  })
})

describe("voice-shared catalog", () => {
  test("lists speech models with voices and cost", () => {
    const providers = [{
      id: "openrouter",
      models: {
        "microsoft/mai-voice-2": {
          id: "microsoft/mai-voice-2", name: "MAI Voice 2",
          capabilities: { output: { speech: true } },
          supported_voices: ["de-DE-Klaus:MAI-Voice-2"],
          cost: { input: 1, output: 2 },
        },
        "openai/gpt-5": { id: "openai/gpt-5", name: "GPT", capabilities: { output: { speech: false } } },
      },
    }]
    const models = speechModelsFromProviders(providers)
    expect(models).toHaveLength(1)
    expect(models[0].id).toBe("openrouter/microsoft/mai-voice-2")
    expect(models[0].voices).toEqual(["de-DE-Klaus:MAI-Voice-2"])
  })

  test("formats cost and detects unevaluated models", () => {
    expect(formatCost({ input: 0, output: 0 })).toBe("Kosten unbekannt")
    expect(formatCost({ input: 1, output: 2 })).toContain("In 1")
    const models = [{ id: "a" }, { id: "b" }]
    expect(modelsNeedingEvaluation(models, { a: { quality: "gut" } })).toEqual(["b"])
  })

  test("parses evaluation notes safely", () => {
    const models = [{ id: "openrouter/microsoft/mai-voice-2" }]
    const notes = parseEvaluationNotes(JSON.stringify({ "openrouter/microsoft/mai-voice-2": { quality: "gut", german: "gut", cost: "niedrig", latency: "schnell" } }), models)
    expect(notes["openrouter/microsoft/mai-voice-2"].german).toBe("gut")
    expect(parseEvaluationNotes("kein json", models)).toEqual({})
  })

  test("languages offer German default", () => {
    expect(VOICE_LANGUAGES[0].value).toBe("de")
  })
})
