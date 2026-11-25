import { describe, expect, test } from "bun:test"
import { voicePickerState } from "./settings-voice-picker-model"

const german = "de-DE-Klaus:MAI-Voice-2"
const english = "en-US-Harper:MAI-Voice-2"
const models = [
  { providerID: "test", modelID: "one", name: "First", supported_voices: [german, english, "alloy"] },
  { providerID: "test", modelID: "two", name: "Second", supported_voices: [german, "fr_FR_Marie"] },
]
const chains = [{ id: "speech", name: "Speech TTS", steps: [
  { providerID: "test", modelID: "two" }, { providerID: "test", modelID: "one" },
] }]
const state = (target = "model:test/one", value = "", language = "de") =>
  voicePickerState({ target, value, language, models, chains })

describe("voice picker catalogue contract", () => {
  test("direct and legacy models use original IDs and keep all languages", () => {
    expect(state().options).toEqual(state("test/one").options)
    expect(state().options.map((item) => item.value)).toEqual(["", german, english, "alloy"])
    expect(state().options[1].label).toContain("Deutsch (de-DE)")
    expect(state().options[2].label).toContain("Englisch (en-US)")
    expect(state().options[3].label).toContain("Sprache/Eignung unbekannt")
    expect(state().options[1].label).toContain("First")
  })

  test("explicit and legacy chains include every step, merge IDs and preserve model order", () => {
    const result = state("chain:speech", german)
    expect(result.options).toEqual(state("speech", german).options)
    expect(result.options.map((item) => item.value)).toEqual(["", german, "fr_FR_Marie", english, "alloy"])
    expect(result.current.models).toEqual(["test/two", "test/one"])
    expect(result.current.label).toContain("Second, First")
    expect(state("chain:speech", english).hint).toContain("nicht für alle")
  })

  test.each(["de_DE_Klaus", "DE-de-Klaus", "De_dE_Klaus", "de-DE"])("locale prefix %s is a hint, not a quality score", (voice) => {
    const result = voicePickerState({ target: "test/one", value: voice, models: [{ ...models[0], supported_voices: [voice] }], chains: [] })
    expect(result.current.label).toContain("Deutsch (de-DE)")
    expect(result.current.label).not.toContain("akzentfrei")
  })

  test("no name-based guesses; language does not filter or change selection", () => {
    expect(state("test/one", english).current.value).toBe(english)
    expect(state("test/one", english, "de").options).toEqual(state("test/one", english, "fr").options)
    const result = voicePickerState({ target: "test/one", value: "Klaus", models: [{ ...models[0], supported_voices: ["Klaus"] }], chains: [] })
    expect(result.current.label).toContain("unbekannt")
  })

  test("unknown saved and custom values are preserved with a fallback warning", () => {
    const result = state("test/one", "my exact custom ID")
    expect(result.current.value).toBe("my exact custom ID")
    expect(result.options).toContainEqual(result.current)
    expect(result.hint).toContain("Anbieterstandard")
  })

  test("missing catalogue, unresolved target and speech default never invent support", () => {
    for (const target of ["test/missing", "chain:missing", "chain:default", ""]) {
      const result = state(target, german)
      expect(result.current.value).toBe(german)
      expect(result.hint).toContain("Nicht überprüfbar")
    }
    const empty = voicePickerState({ target: "test/empty", value: german, models: [{ providerID: "test", modelID: "empty" }], chains: [] })
    expect(empty.hint).toContain("Nicht überprüfbar")
    expect(state().current.value).toBe("")
    expect(state().current.label).toContain("Anbieterstandard")
  })

  test("unknown chain steps make partial support explicit; inputs are not mutated", () => {
    const input = { target: "chain:partial", value: german, models: structuredClone(models), chains: [
      { id: "partial", name: "Partial", steps: [{ providerID: "test", modelID: "one" }, { providerID: "test", modelID: "missing" }] },
    ] }
    const before = structuredClone(input)
    expect(voicePickerState(input).hint).toContain("nicht für alle")
    expect(input).toEqual(before)
  })
})
