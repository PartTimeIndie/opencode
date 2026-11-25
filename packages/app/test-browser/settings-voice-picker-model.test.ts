import { createMemo, createRoot, createSignal } from "solid-js"
import { expect, test } from "bun:test"
import { voicePickerState, type VoicePickerModel } from "../src/components/settings-voice-picker-model"

test("live catalogue, target and language changes preserve the stored voice without writes", () => {
  createRoot((dispose) => {
    const [models, setModels] = createSignal<VoicePickerModel[]>([])
    const [target, setTarget] = createSignal("model:test/one")
    const [language, setLanguage] = createSignal("de")
    const saved = "de-DE-Klaus:MAI-Voice-2"
    const state = createMemo(() => voicePickerState({ target: target(), language: language(), value: saved, models: models(), chains: [] }))
    expect(state().hint).toContain("Nicht überprüfbar")
    setModels([{ providerID: "test", modelID: "one", supported_voices: [saved, "en_paul"] }])
    expect(state().options.map((option) => option.value)).toEqual(["", saved, "en_paul"])
    setLanguage("fr")
    expect(state().hint).toContain("Zusammenfassung: fr")
    expect(state().current.value).toBe(saved)
    setTarget("model:test/two")
    expect(state().hint).toContain("Nicht überprüfbar")
    setModels([{ providerID: "test", modelID: "two", supported_voices: ["fr_FR_Marie"] }])
    expect(state().current.value).toBe(saved)
    expect(state().hint).toContain("Anbieterstandard")
    expect(state().options.map((option) => option.value)).toEqual(["", "fr_FR_Marie", saved])
    const final = state()
    dispose()
    setModels([])
    expect(state()).toBe(final)
  })
})
