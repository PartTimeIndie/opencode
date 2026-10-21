import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { Show, createEffect, createMemo } from "solid-js"
import { ModelSelectorPopover, type ModelSelectorModelState } from "@/components/dialog-select-model"
import { useModels } from "@/context/models"
import { MODEL_TARGET_CHAIN_PREFIX, MODEL_TARGET_MODEL_PREFIX } from "@/plugin/model-target"
import {
  modelTargetPickerChains,
  modelTargetPickerModels,
  resolveModelTargetSelection,
  shouldAutoSelectModelTarget,
  type SettingsModelChainPickerFilter,
} from "./settings-model-target-picker-model"

export type { SettingsModelChainPickerFilter }

/**
 * Unified model-target picker: the same popover lists concrete models and
 * configured model chains, and persists one durable reference
 * (`model:<provider>/<model>` or `chain:<id>`). Legacy persisted values are
 * accepted and migrate on the next selection.
 */
export function SettingsModelTargetPickerV2(props: {
  value: string
  label: string
  onChange: (value: string) => void
  filter?: SettingsModelChainPickerFilter
  required?: boolean
  autoSelectSingle?: boolean
  autoSelectDefault?: boolean
  placeholder?: string
}) {
  const models = useModels()
  const available = createMemo(() =>
    models.list().map((model) => ({
      providerID: model.provider.id,
      modelID: model.id,
      name: model.name,
      capabilities: model.capabilities,
      modalities: legacyModalities(model),
    })),
  )
  const pickerModels = createMemo(() => modelTargetPickerModels(available(), props.filter))
  const chains = createMemo(() => models.chain.list())
  const pickerChains = createMemo(() => modelTargetPickerChains(chains(), available(), props.filter))
  const selection = createMemo(() =>
    resolveModelTargetSelection(props.value, {
      chains: chains(),
      models: available(),
      defaultChainID: models.chain.default(),
    }),
  )
  const state: ModelSelectorModelState = {
    current: () => {
      const target = selection().target
      if (target.kind !== "model") return
      return models.find({ providerID: target.providerID, modelID: target.modelID })
    },
    recent: () => [],
    list: () => {
      const allowed = new Set(pickerModels().map((model) => `${model.providerID}/${model.modelID}`))
      return models.list().filter((model) => allowed.has(`${model.provider.id}/${model.id}`))
    },
    set: (model) => {
      if (!model) return
      props.onChange(`${MODEL_TARGET_MODEL_PREFIX}${model.providerID}/${model.modelID}`)
    },
    visible: () => true,
    chain: {
      ready: models.chain.ready,
      managementReady: models.chain.managementReady,
      list: pickerChains,
      current: () => {
        const target = selection().target
        if (target.kind !== "chain") return
        return models.chain.find(target.id === "default" ? models.chain.default() : target.id)
      },
      selected: () => {
        const target = selection().target
        return target.kind === "chain" && target.id !== "default" ? target.id : undefined
      },
      set: (id) => {
        if (id && pickerChains().some((chain) => chain.id === id)) props.onChange(`${MODEL_TARGET_CHAIN_PREFIX}${id}`)
      },
      default: models.chain.default,
      setDefault: models.chain.setDefault,
      save: models.chain.save,
      remove: models.chain.remove,
      move: models.chain.move,
    },
  }

  createEffect(() => {
    const next = shouldAutoSelectModelTarget({
      autoSelectSingle: props.autoSelectSingle,
      autoSelectDefault: props.autoSelectDefault,
      defaultChainID: models.chain.default(),
      value: props.value,
      chainIDs: pickerChains().map((chain) => chain.id),
      modelKeys: pickerModels().map((model) => `${model.providerID}/${model.modelID}`),
    })
    if (next && next !== props.value) props.onChange(next)
  })

  return (
    <div class="flex min-w-0 items-center justify-end gap-1.5">
      <ModelSelectorPopover
        model={state}
        triggerAs={ButtonV2}
        triggerProps={{
          type: "button",
          variant: "ghost-muted",
          class: "min-w-0 max-w-[280px] justify-start gap-1.5",
          "aria-label": props.label,
        }}
      >
        <span class="truncate">
          {selection().label ??
            props.placeholder ??
            (props.required ? "No model or chain configured" : "No model or chain")}
        </span>
        <Show when={selection().unavailable}>
          <span class="shrink-0 text-v2-text-weak">Unavailable</span>
        </Show>
        <Icon name="chevron-down" size="small" class="text-v2-icon-icon-muted shrink-0" />
      </ModelSelectorPopover>
      {!props.required && props.value ? (
        <ButtonV2 type="button" variant="ghost-muted" size="small" onClick={() => props.onChange("")}>
          Clear
        </ButtonV2>
      ) : null}
    </div>
  )
}

function legacyModalities(value: unknown) {
  if (!value || typeof value !== "object" || !("modalities" in value)) return
  const modalities = value.modalities
  if (!modalities || typeof modalities !== "object" || !("input" in modalities)) return
  if (!Array.isArray(modalities.input)) return
  return { input: modalities.input.filter((item): item is string => typeof item === "string") }
}
