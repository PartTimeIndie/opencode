import { Show, createMemo } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { ModelSelectorPopover, type ModelSelectorModelState } from "@/components/dialog-select-model"
import { useModels, type ModelKey } from "@/context/models"

type Props = {
  value?: string
  label: string
  allowClear?: boolean
  variant?: string
  showVariantPicker?: boolean
  onChange: (value: string | undefined) => void
  onVariantChange?: (value: string | undefined) => void
  rememberRecent?: boolean
  filter?: {
    providerIDs?: string[]
    inputModalities?: Array<"text" | "audio" | "image" | "video" | "pdf">
  }
}

export function SettingsModelPicker(props: Props) {
  const state = modelState(() => props.value, props.onChange, true, props.filter)
  return (
    <div class="flex min-w-0 items-center justify-end gap-1.5">
      <ModelSelectorPopover
        model={state}
        triggerAs={Button}
        triggerProps={{
          variant: "secondary",
          size: "small",
          class: "min-w-0 max-w-[280px] justify-start gap-1.5",
          "aria-label": props.label,
        }}
      >
        <ModelLabel value={props.value} />
        <Icon name="chevron-down" size="small" class="shrink-0" />
      </ModelSelectorPopover>
      <Show when={props.allowClear && props.value}>
        <Button variant="ghost" size="small" onClick={() => props.onChange(undefined)}>
          Clear
        </Button>
      </Show>
    </div>
  )
}

export function SettingsModelPickerV2(props: Props) {
  const state = modelState(
    () => props.value,
    props.onChange,
    props.rememberRecent !== false,
    props.filter,
    props.onVariantChange,
  )
  const models = useModels()
  const key = createMemo(() => parseModelKey(props.value ?? ""))
  const current = createMemo(() => {
    const value = key()
    if (!value) return
    return models.find(value)
  })
  const variants = createMemo(() => Object.keys(current()?.variants ?? {}))
  const variantOptions = createMemo(() => ["default", ...variants()])
  const selectedVariant = createMemo(() => {
    const value = key()
    if (!value) return
    const variant = props.onVariantChange ? props.variant : models.variant.get(value)
    if (variant && variants().includes(variant)) return variant
  })
  return (
    <div class="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-1.5">
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
        <ModelLabel value={props.value} />
        <IconV2 name="chevron-down" size="small" class="text-v2-icon-icon-muted shrink-0" />
      </ModelSelectorPopover>
      <Show when={props.allowClear && props.value}>
        <ButtonV2 type="button" variant="ghost-muted" size="small" onClick={() => props.onChange(undefined)}>
          Clear
        </ButtonV2>
      </Show>
      <Show when={props.showVariantPicker !== false && variants().length > 0}>
        <SelectV2
          appearance="inline"
          options={variantOptions()}
          current={selectedVariant() ?? "default"}
          label={variantLabel}
          onSelect={(value) => {
            if (!value) return
            const model = key()
            const variant = value === "default" ? undefined : value
            if (props.onVariantChange) {
              if (props.variant !== variant) props.onVariantChange(variant)
              return
            }
            if (model) models.variant.set(model, variant)
          }}
          aria-label={`${props.label} thinking amount`}
          class="capitalize max-w-[160px] justify-start text-v2-text-text-faint"
          valueClass="truncate text-[13px] font-[440] leading-5 text-v2-text-text-faint"
        />
      </Show>
    </div>
  )
}

function variantLabel(value: string) {
  if (value === "default") return "Default"
  return value.slice(0, 1).toUpperCase() + value.slice(1)
}

function ModelLabel(props: { value?: string }) {
  const models = useModels()
  const current = createMemo(() => {
    const key = parseModelKey(props.value ?? "")
    if (!key) return
    return models.find(key)
  })

  return (
    <Show when={current()} fallback={<span class="truncate">{props.value || "Select model"}</span>}>
      {(model) => (
        <>
          <ProviderIcon id={model().provider.id} class="size-4 shrink-0" />
          <span class="truncate">{model().name}</span>
        </>
      )}
    </Show>
  )
}

function modelState(
  value: () => string | undefined,
  onChange: (value: string | undefined) => void,
  rememberRecent = true,
  filter?: Props["filter"],
  onVariantChange?: (value: string | undefined) => void,
): ModelSelectorModelState {
  const models = useModels()
  const allowed = (model: ReturnType<typeof models.list>[number]) => {
    if (filter?.providerIDs && !filter.providerIDs.includes(model.provider.id)) return false
    const legacyInput =
      "modalities" in model &&
      typeof model.modalities === "object" &&
      model.modalities !== null &&
      "input" in model.modalities &&
      Array.isArray(model.modalities.input)
        ? model.modalities.input
        : []
    if (
      filter?.inputModalities?.some(
        (modality) => !model.capabilities?.input?.[modality] && !legacyInput.includes(modality),
      )
    )
      return false
    return true
  }
  const list = createMemo(() => models.list().filter(allowed))
  const current = createMemo(() => {
    const key = parseModelKey(value() ?? "")
    if (!key) return
    return models.find(key)
  })
  const recent = createMemo(() =>
    models
      .recent
      .list()
      .map(models.find)
      .filter(
        (model): model is NonNullable<ReturnType<typeof models.find>> => model !== undefined && allowed(model),
      ),
  )
  return {
    current,
    recent,
    list,
    set(model, options) {
      if (!model) return
      models.setVisibility(model, true)
      if (rememberRecent && options?.recent) models.recent.push(model)
      if (onVariantChange) onVariantChange(undefined)
      if (!onVariantChange) models.variant.set(model, undefined)
      onChange(`${model.providerID}/${model.modelID}`)
    },
    chain: {
      ready: models.chain.ready,
      managementReady: models.chain.managementReady,
      list: () =>
        models.chain
          .list()
          .filter((chain) =>
            chain.steps.every((step) => {
              const model = models.find({ providerID: step.providerID, modelID: step.modelID })
              return !!model && allowed(model)
            }),
          ),
      current: () => undefined,
      selected: () => undefined,
      set(id) {
        // A single-model setting stores a model reference, so a chain selection is a
        // convenient shortcut to its first valid step. Chain-valued settings use
        // SettingsModelChainPickerV2 and persist the chain ID itself.
        const step = models.chain.find(id)?.steps[0]
        if (!step) return
        const model = models.find({ providerID: step.providerID, modelID: step.modelID })
        if (!model || !allowed(model)) return
        models.setVisibility({ providerID: step.providerID, modelID: step.modelID }, true)
        if (rememberRecent) models.recent.push({ providerID: step.providerID, modelID: step.modelID })
        onChange(`${step.providerID}/${step.modelID}`)
        if (onVariantChange) {
          onVariantChange(step.variant)
          return
        }
        models.variant.set({ providerID: step.providerID, modelID: step.modelID }, step.variant)
      },
      default: models.chain.default,
      setDefault: models.chain.setDefault,
      save: models.chain.save,
      remove: models.chain.remove,
      move: models.chain.move,
    },
    visible: models.visible,
  }
}

function parseModelKey(value: string): ModelKey | undefined {
  const separator = value.indexOf("/")
  if (separator <= 0 || separator === value.length - 1) return
  return { providerID: value.slice(0, separator), modelID: value.slice(separator + 1) }
}
