import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { createEffect, createMemo } from "solid-js"
import { ModelSelectorPopover, type ModelSelectorModelState } from "@/components/dialog-select-model"
import { useModels } from "@/context/models"
import {
  chainMatchesChainPickerFilter,
  shouldAutoSelectSingleModelChain,
  type SettingsModelChainPickerFilter,
} from "./settings-model-chain-picker-model"

export type { SettingsModelChainPickerFilter }

export function SettingsModelChainPickerV2(props: {
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
  const valid = createMemo(() =>
    models.chain.list().filter((chain) => chainMatchesChainPickerFilter(chain, available(), props.filter)),
  )
  const current = createMemo(() => models.chain.find(props.value))
  const state: ModelSelectorModelState = {
    current: () => undefined,
    recent: () => [],
    list: models.list,
    set: () => undefined,
    visible: () => true,
    chain: {
      ready: models.chain.ready,
      managementReady: models.chain.managementReady,
      list: valid,
      current,
      selected: () => props.value || undefined,
      set: (id) => {
        if (id && valid().some((chain) => chain.id === id)) props.onChange(id)
      },
      default: models.chain.default,
      setDefault: models.chain.setDefault,
      save: models.chain.save,
      remove: models.chain.remove,
      move: models.chain.move,
    },
  }

  createEffect(() => {
    const next = shouldAutoSelectSingleModelChain({
      autoSelectSingle: props.autoSelectSingle,
      autoSelectDefault: props.autoSelectDefault,
      defaultChainID: models.chain.default(),
      value: props.value,
      validChainIDs: valid().map((chain) => chain.id),
    })
    if (next) props.onChange(next)
  })

  return (
    <div class="flex min-w-0 items-center justify-end gap-1.5">
      <ModelSelectorPopover
        model={state}
        showModels={false}
        triggerAs={ButtonV2}
        triggerProps={{
          type: "button",
          variant: "ghost-muted",
          class: "min-w-0 max-w-[280px] justify-start gap-1.5",
          "aria-label": props.label,
        }}
      >
        <span class="truncate">
          {current()?.name ?? props.placeholder ?? (props.required ? "No valid model chain configured" : "No chain")}
        </span>
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
