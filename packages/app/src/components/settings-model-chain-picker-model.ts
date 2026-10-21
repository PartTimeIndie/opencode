import {
  applyAudioPurposeCapabilities,
  looksLikeSpeechModel,
  looksLikeTranscriptionModel,
} from "@opencode-ai/core/audio-model-purpose"

export type SettingsModelChainPickerFilter = {
  providerIDs?: string[]
  inputModalities?: Array<"text" | "audio" | "image" | "video" | "pdf">
  purpose?: "transcription" | "speech"
}

export type ModelChainPickerModel = {
  providerID: string
  modelID: string
  name?: string
  capabilities?: {
    input?: {
      text?: boolean
      audio?: boolean
      image?: boolean
      video?: boolean
      pdf?: boolean
    }
    output?: {
      transcription?: boolean
      speech?: boolean
    }
  }
  modalities?: {
    input?: readonly string[]
  }
}

export type ModelChainPickerChain = {
  id: string
  name: string
  steps: readonly ModelChainPickerStep[]
}

export type ModelChainPickerStep = {
  providerID: string
  modelID: string
  variant?: string
}

export type ModelChainPickerOption = {
  value: string
  label: string
  unavailable?: boolean
  chain?: ModelChainPickerChain
  models?: ModelChainPickerModel[]
}

export function modelMatchesChainPickerFilter(item: ModelChainPickerModel, filter?: SettingsModelChainPickerFilter) {
  if (!filter) return true
  if (filter.providerIDs && filter.providerIDs.length > 0 && !filter.providerIDs.includes(item.providerID)) {
    return false
  }
  if (filter.inputModalities && filter.inputModalities.length > 0) {
    const capabilities = item.capabilities?.input
    const legacy = item.modalities?.input
    const ok = (modality: NonNullable<SettingsModelChainPickerFilter["inputModalities"]>[number]) => {
      if (modality === "audio" && looksLikeTranscriptionModel(item.modelID)) return true
      if (capabilities) {
        if (modality === "text") return capabilities.text !== false
        return capabilities[modality] === true
      }
      if (legacy) {
        if (modality === "text") return legacy.includes("text")
        return legacy.includes(modality)
      }
      return modality === "text"
    }
    if (!filter.inputModalities.every(ok)) return false
  }
  if (filter.purpose === "transcription") {
    const catalogued = item.capabilities?.input?.audio === true && item.capabilities.output?.transcription === true
    if (!catalogued && !looksLikeTranscriptionModel(item.modelID)) return false
  }
  if (filter.purpose === "speech") {
    if (item.capabilities?.output?.speech !== true && !looksLikeSpeechModel(item.modelID)) return false
  }
  return true
}

export function resolveChainStepModel(
  step: ModelChainPickerStep,
  models: readonly ModelChainPickerModel[],
): ModelChainPickerModel | undefined {
  return models.find((item) => item.providerID === step.providerID && item.modelID === step.modelID)
}

function unresolvedAudioStep(step: ModelChainPickerStep): ModelChainPickerModel {
  return {
    providerID: step.providerID,
    modelID: step.modelID,
    capabilities: applyAudioPurposeCapabilities(step.modelID, {
      input: {},
      output: {},
    }),
  }
}

function allowsUnresolvedAudioSteps(filter?: SettingsModelChainPickerFilter) {
  return (
    filter?.purpose === "transcription" ||
    filter?.purpose === "speech" ||
    filter?.inputModalities?.includes("audio") === true
  )
}

export function chainMatchesChainPickerFilter(
  chain: ModelChainPickerChain,
  models: readonly ModelChainPickerModel[],
  filter?: SettingsModelChainPickerFilter,
) {
  if (chain.steps.length === 0) return false
  return chain.steps.every((step) => {
    const model = resolveChainStepModel(step, models)
    if (model) return modelMatchesChainPickerFilter(model, filter)
    if (!allowsUnresolvedAudioSteps(filter) || step.providerID !== "openrouter") return false
    return modelMatchesChainPickerFilter(unresolvedAudioStep(step), filter)
  })
}

export function validModelChains(
  chains: readonly ModelChainPickerChain[],
  models: readonly ModelChainPickerModel[],
  filter?: SettingsModelChainPickerFilter,
) {
  return chains.filter((chain) => chainMatchesChainPickerFilter(chain, models, filter))
}

export function formatModelChainLabel(chain: ModelChainPickerChain, models: readonly ModelChainPickerModel[]) {
  const steps = chain.steps
    .map((step) => {
      const model = resolveChainStepModel(step, models)
      return model?.name ?? `${step.providerID}/${step.modelID}`
    })
    .join(" → ")
  return steps ? `${chain.name} · ${steps}` : chain.name
}

export function getModelChainPickerOptions(input: {
  chains: readonly ModelChainPickerChain[]
  models: readonly ModelChainPickerModel[]
  value: string
  filter?: SettingsModelChainPickerFilter
  required?: boolean
}): ModelChainPickerOption[] {
  const valid = validModelChains(input.chains, input.models, input.filter)
  const empty = input.required === true ? [] : [{ value: "", label: "No chain" }]
  const selected =
    input.value && !valid.some((chain) => chain.id === input.value)
      ? input.chains.find((chain) => chain.id === input.value)
      : undefined
  const unavailable =
    input.value && !valid.some((chain) => chain.id === input.value)
      ? [
          {
            value: input.value,
            label: selected
              ? `${formatModelChainLabel(selected, input.models)} (unavailable)`
              : `${input.value} (unavailable)`,
            unavailable: true,
            chain: selected,
            models: selected
              ? selected.steps
                  .map((step) => resolveChainStepModel(step, input.models))
                  .filter((item): item is ModelChainPickerModel => !!item)
              : [],
          } satisfies ModelChainPickerOption,
        ]
      : []
  return [
    ...empty,
    ...unavailable,
    ...valid.map((chain) => ({
      value: chain.id,
      label: formatModelChainLabel(chain, input.models),
      chain,
      models: chain.steps
        .map((step) => resolveChainStepModel(step, input.models))
        .filter((item): item is ModelChainPickerModel => !!item),
    })),
  ]
}

export function shouldAutoSelectSingleModelChain(input: {
  autoSelectSingle?: boolean
  autoSelectDefault?: boolean
  defaultChainID?: string
  value: string
  validChainIDs: readonly string[]
}): string | undefined {
  if (
    input.autoSelectDefault === true &&
    input.defaultChainID &&
    input.validChainIDs.includes(input.defaultChainID) &&
    !input.validChainIDs.includes(input.value)
  )
    return input.defaultChainID
  if (input.autoSelectSingle !== true) return undefined
  if (input.validChainIDs.length !== 1) return undefined
  const only = input.validChainIDs[0]
  if (input.value && input.validChainIDs.includes(input.value)) return undefined
  return only
}
