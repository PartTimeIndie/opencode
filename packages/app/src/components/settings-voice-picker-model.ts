import { resolveModelTargetSelection } from "./settings-model-target-picker-model"
import type { ModelChainPickerChain, ModelChainPickerModel } from "./settings-model-chain-picker-model"

export type VoicePickerModel = ModelChainPickerModel & { supported_voices?: readonly string[] }
export type VoicePickerOption = { value: string; label: string; models: string[] }

const languageNames = new Intl.DisplayNames(["de"], { type: "language", fallback: "none" })

/** Catalogue membership is not an acoustic quality or accent guarantee. */
export function voicePickerState(input: {
  target: string
  value: string
  language?: string
  models: readonly VoicePickerModel[]
  chains: readonly ModelChainPickerChain[]
}) {
  const selection = resolveModelTargetSelection(input.target, input)
  const steps = selection.model ? [selection.model] : selection.chain?.steps ?? []
  const entries = steps.flatMap((step) => {
    const model = input.models.find((item) => item.providerID === step.providerID && item.modelID === step.modelID)
    return model ? [model] : []
  })
  const voices = [...new Set(entries.flatMap((model) => (model.supported_voices ?? []).filter((voice) => voice.trim())))]
  const options: VoicePickerOption[] = [
    { value: "", label: "Anbieterstandard · Sprache abhängig vom Modell", models: [] },
    ...voices.map((voice) => {
      const supported = entries.filter((model) => model.supported_voices?.includes(voice))
      return {
        value: voice,
        label: `${voice} · ${voiceLanguageLabel(voice)} · ${supported.map((model) => model.name ?? `${model.providerID}/${model.modelID}`).join(", ")}`,
        models: supported.map((model) => `${model.providerID}/${model.modelID}`),
      }
    }),
  ]
  const known = options.find((option) => option.value === input.value)
  const current = known ?? { value: input.value, label: `${input.value} · ${voiceLanguageLabel(input.value)} · Nicht im Katalog`, models: [] }
  if (!known) options.push(current)
  const partial = current.value && current.models.length > 0 && steps.some((step) => !current.models.includes(`${step.providerID}/${step.modelID}`))
  const hint = !steps.length || !voices.length
    ? "Nicht überprüfbar: Kein aufgelöstes Sprachmodell oder keine Stimmen im Katalog. Eigene IDs bleiben möglich."
    : !known
      ? "Für das gewählte Modell nicht im Katalog; die Wiedergabe kann den Anbieterstandard verwenden."
      : partial
        ? "Diese Stimme ist nicht für alle Kettenmodelle katalogisiert. Andere Schritte können den Anbieterstandard verwenden."
        : "Sprachhinweise stammen aus der Stimmen-ID, nicht aus einer Hörprüfung."
  return {
    options,
    current,
    hint: input.language ? `${hint} Sprache der Zusammenfassung: ${input.language}.` : hint,
  }
}

function voiceLanguageLabel(voice: string) {
  const match = /^([a-z]{2})[-_](?:([a-z]{2}|\d{3})(?=[-_]|$))?/iu.exec(voice)
  if (!match) return "Sprache/Eignung unbekannt"
  const language = match[1].toLowerCase()
  const label = languageNames.of(language)
  if (!label) return "Sprache/Eignung unbekannt"
  return `${label} (${language}${match[2] ? `-${match[2].toUpperCase()}` : ""})`
}
