import { normalizeModelTargetReference, parseModelTarget, type ModelTargetSelection } from "@/plugin/model-target"
import {
  chainMatchesChainPickerFilter,
  modelMatchesChainPickerFilter,
  type ModelChainPickerChain,
  type ModelChainPickerModel,
  type SettingsModelChainPickerFilter,
} from "./settings-model-chain-picker-model"

export type { SettingsModelChainPickerFilter }

export type ModelTargetPickerSelection = {
  target: ModelTargetSelection
  /** Resolved picker model for a direct selection; undefined when unavailable. */
  model: ModelChainPickerModel | undefined
  /** Resolved chain for a chain selection; undefined for unknown ids. */
  chain: ModelChainPickerChain | undefined
  /** True when the persisted selection no longer matches a selectable target. */
  unavailable: boolean
  label: string | undefined
}

/**
 * Resolves a persisted model-target value (durable or legacy) against the
 * configured chains and models. Legacy values render exactly like their
 * migrated durable form so an unreloaded setting never looks empty.
 */
export function resolveModelTargetSelection(
  value: string,
  input: {
    chains: readonly ModelChainPickerChain[]
    models: readonly ModelChainPickerModel[]
    defaultChainID?: string
  },
): ModelTargetPickerSelection {
  const chainIDs = input.chains.map((chain) => chain.id)
  const target = parseModelTarget(value, chainIDs)
  if (target.kind === "model") {
    const model = input.models.find((item) => item.providerID === target.providerID && item.modelID === target.modelID)
    return {
      target,
      model,
      chain: undefined,
      unavailable: !model,
      label: model?.name ?? `${target.providerID}/${target.modelID}`,
    }
  }
  if (target.kind === "chain") {
    const chain =
      target.id === "default"
        ? input.chains.find((item) => item.id === input.defaultChainID)
        : input.chains.find((item) => item.id === target.id)
    return {
      target,
      model: undefined,
      chain,
      unavailable: !chain,
      label: chain?.name ?? (target.id === "default" ? "Default model chain" : target.id),
    }
  }
  return { target, model: undefined, chain: undefined, unavailable: false, label: undefined }
}

export function modelTargetPickerModels<T extends ModelChainPickerModel>(
  models: readonly T[],
  filter?: SettingsModelChainPickerFilter,
) {
  return models.filter((model) => modelMatchesChainPickerFilter(model, filter))
}

export function modelTargetPickerChains<T extends ModelChainPickerChain>(
  chains: readonly T[],
  models: readonly ModelChainPickerModel[],
  filter?: SettingsModelChainPickerFilter,
) {
  return chains.filter((chain) => chainMatchesChainPickerFilter(chain, models, filter))
}

/**
 * Auto-select semantics stay chain-only and never replace an explicit user
 * decision: auto-selection fires exclusively while no selection is persisted
 * at all. A persisted selection — direct model, chain, `chain:default`, or an
 * id that is currently unavailable because the provider/model list flickered —
 * always wins and is only re-picked by the user. Unavailable selections render
 * with their raw label through `resolveModelTargetSelection` instead.
 */
export function shouldAutoSelectModelTarget(input: {
  autoSelectSingle?: boolean
  autoSelectDefault?: boolean
  defaultChainID?: string
  value: string
  chainIDs: readonly string[]
  modelKeys?: readonly string[]
}): string | undefined {
  const current = parseModelTarget(input.value, input.chainIDs)
  if (current.kind !== "none") return undefined
  if (input.autoSelectDefault === true && input.defaultChainID && input.chainIDs.includes(input.defaultChainID))
    return `chain:${input.defaultChainID}`
  if (input.autoSelectSingle !== true) return undefined
  const targets = [
    ...input.chainIDs.map((id) => `chain:${id}`),
    ...(input.modelKeys ?? []).map((model) => `model:${model}`),
  ]
  if (targets.length !== 1) return undefined
  return targets[0]
}

/**
 * Reload/migration seam for persisted plugin settings: rewrites legacy bare
 * chain ids and bare `provider/model` values into the durable reference format
 * without ever dropping an unknown chain id.
 */
export function migrateModelTargetSetting(input: { value: unknown; chainIDs: readonly string[] }): string | undefined {
  const current = typeof input.value === "string" ? input.value.trim() : ""
  const normalized = normalizeModelTargetReference(input.value, input.chainIDs)
  if (current === normalized) return undefined
  return normalized
}
