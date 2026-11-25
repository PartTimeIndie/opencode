import { Popover as KobaltePopover } from "@kobalte/core/popover"
import { Button } from "@opencode-ai/ui/button"
import { Icon, type IconProps } from "@opencode-ai/ui/icon"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { Spinner } from "@opencode-ai/ui/spinner"
import { createMemo, createSignal, For, onCleanup, onMount, Show, splitProps, type ComponentProps, type JSX } from "solid-js"
import { ModelSelectorPopover } from "@/components/dialog-select-model"
import type { useLocal } from "@/context/local"
import type { AccessControlMode } from "@/context/permission"
import { visualViewportBounds } from "@/utils/visual-viewport"

export type ComposerPickerItemState = {
  icon?: IconProps["name"]
  avatar?: JSX.Element
  label: string
  selected?: boolean
  disabled?: boolean
  onSelect: () => void
}

export type ComposerPickerTriggerState = {
  action: string
  icon?: IconProps["name"]
  avatar?: JSX.Element
  label: string
  class?: string
  disabled?: boolean
  style: JSX.CSSProperties | undefined
  onPress: () => void
}

export type ComposerPickerState = {
  open: boolean
  trigger: ComposerPickerTriggerState
  search: string
  searchPlaceholder: string
  clearLabel: string
  items: ComposerPickerItemState[]
  action: ComposerPickerItemState
  listClass?: string
  searchRef: (el: HTMLInputElement) => void
  onOpenChange: (open: boolean) => void
  onSearchInput: (value: string) => void
  onSearchClear: () => void
}

export type ComposerAgentControlState = {
  title: string
  keybind: string
  options: string[]
  current: string
  open: boolean
  disabled?: boolean
  style: JSX.CSSProperties | undefined
  onOpenChange: (open: boolean) => void
  onSelect: (value: string | undefined) => void
  onConfigure: (value: string) => void
  onCreate: () => void
}

export type ComposerModelControlState = {
  loading: boolean
  paid: boolean
  error: boolean
  retrying: boolean
  disabled?: boolean
  onRetry: () => void
  title: string
  keybind: string
  model: ReturnType<typeof useLocal>["model"]
  providerID?: string
  modelName: string
  style: JSX.CSSProperties | undefined
  onClose: () => void
  onUnpaidClick: () => void
}

export type ComposerAccessControlState = {
  mode: AccessControlMode
  style: JSX.CSSProperties | undefined
  updateProjectDefault: boolean
  updateUserDefault: boolean
  onModeSelect: (mode: AccessControlMode) => void
  onUpdateProjectDefault: (value: boolean) => void
  onUpdateUserDefault: (value: boolean) => void
}

export function ComposerPickerTrigger(props: ComponentProps<"button"> & { state: ComposerPickerTriggerState }) {
  const [local, rest] = splitProps(props, ["state", "class", "style", "onClick"])
  return (
    <button
      {...rest}
      data-action={local.state.action}
      data-mobile-touch-target
      type="button"
      disabled={local.state.disabled}
      class={`flex h-7 min-w-0 items-center gap-1.5 rounded px-2 text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-faint transition-colors hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent ${local.state.class ?? ""}`}
      style={local.state.style}
      onClick={() => {
        if (local.state.disabled) return
        local.state.onPress()
      }}
    >
      <Show
        when={local.state.avatar}
        fallback={
          <Show when={local.state.icon}>
            {(icon) => <Icon name={icon()} size="small" class="shrink-0 text-v2-icon-icon-muted" />}
          </Show>
        }
      >
        {(avatar) => <span class="shrink-0">{avatar()}</span>}
      </Show>
      <span class="min-w-0 truncate leading-5">{local.state.label}</span>
      <Icon name="chevron-down" size="small" class="shrink-0 text-v2-icon-icon-muted" />
    </button>
  )
}

function ComposerPickerMenuItem(props: { state: ComposerPickerItemState }) {
  return (
    <button
      type="button"
      data-component="composer-picker-item"
      data-label={props.state.label}
      data-selected={props.state.selected ? "" : undefined}
      aria-selected={props.state.selected}
      data-mobile-touch-target
      disabled={props.state.disabled}
      class="flex h-7 w-full items-center gap-2 rounded px-3 text-left text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-base hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
      onClick={props.state.onSelect}
    >
      <Show
        when={props.state.avatar}
        fallback={
          <Show when={props.state.icon}>
            {(icon) => <Icon name={icon()} size="small" class="shrink-0 text-v2-icon-icon-base" />}
          </Show>
        }
      >
        {(avatar) => <span class="shrink-0">{avatar()}</span>}
      </Show>
      <span class="min-w-0 flex-1 truncate leading-5">{props.state.label}</span>
      <Show when={props.state.selected}>
        <Icon name="check-small" size="small" class="shrink-0 text-v2-icon-icon-base" />
      </Show>
    </button>
  )
}

export function ComposerPicker(props: { state: ComposerPickerState }) {
  const [maxHeight, setMaxHeight] = createSignal(
    typeof window === "undefined" ? 640 : Math.max(0, visualViewportBounds(window).height - 16),
  )

  onMount(() => {
    const sync = () => setMaxHeight(Math.max(0, visualViewportBounds(window).height - 16))
    sync()
    window.addEventListener("resize", sync)
    window.visualViewport?.addEventListener("resize", sync)
    window.visualViewport?.addEventListener("scroll", sync)
    onCleanup(() => {
      window.removeEventListener("resize", sync)
      window.visualViewport?.removeEventListener("resize", sync)
      window.visualViewport?.removeEventListener("scroll", sync)
    })
  })

  return (
    <KobaltePopover
      open={props.state.open}
      placement="bottom-start"
      gutter={4}
      modal={false}
      onOpenChange={props.state.onOpenChange}
    >
      <KobaltePopover.Trigger as={ComposerPickerTrigger} state={props.state.trigger} />
      <KobaltePopover.Portal>
        <KobaltePopover.Content
          data-component="composer-project-picker"
          class="flex w-[243px] min-h-0 flex-col overflow-hidden rounded-md bg-v2-background-bg-layer-01 shadow-[var(--v2-elevation-floating)] focus:outline-none"
          style={{ "max-height": `${maxHeight()}px` }}
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <div class="flex shrink-0 flex-col p-0.5">
            <div
              data-component="composer-project-search"
              data-mobile-touch-target
              class="flex h-7 items-center gap-2 rounded px-3 text-v2-icon-icon-muted"
            >
              <Icon name="magnifying-glass" size="small" class="shrink-0" />
              <input
                data-mobile-touch-target
                ref={props.state.searchRef}
                value={props.state.search}
                placeholder={props.state.searchPlaceholder}
                class="h-7 min-w-0 flex-1 border-0 bg-transparent text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint"
                onInput={(event) => props.state.onSearchInput(event.currentTarget.value)}
              />
              <Show when={props.state.search.trim()}>
                <button
                  type="button"
                  data-mobile-touch-target
                  class="flex size-5 items-center justify-center rounded text-v2-icon-icon-muted hover:bg-v2-overlay-simple-overlay-hover"
                  onClick={props.state.onSearchClear}
                  aria-label={props.state.clearLabel}
                >
                  <Icon name="close-small" size="small" />
                </button>
              </Show>
            </div>
          </div>
          <div
            data-component="composer-project-items"
            class={`flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain p-0.5 ${props.state.listClass ?? ""}`}
          >
            <For each={props.state.items}>{(item) => <ComposerPickerMenuItem state={item} />}</For>
          </div>
          <div class="h-px shrink-0 bg-v2-border-border-muted" />
          <div class="flex shrink-0 flex-col p-0.5">
            <ComposerPickerMenuItem state={props.state.action} />
          </div>
        </KobaltePopover.Content>
      </KobaltePopover.Portal>
    </KobaltePopover>
  )
}

export function ComposerAgentControl(props: { state: ComposerAgentControlState }) {
  return (
    <KobaltePopover
      open={props.state.open}
      placement="bottom-start"
      gutter={4}
      modal={false}
      onOpenChange={props.state.onOpenChange}
    >
      <TooltipKeybind placement="top" gutter={4} title={props.state.title} keybind={props.state.keybind}>
        <KobaltePopover.Trigger
          data-action="prompt-agent"
          data-mobile-touch-target
          type="button"
          disabled={props.state.disabled}
          aria-disabled={props.state.disabled ? "true" : undefined}
          class="flex h-7 min-w-0 max-w-[175px] items-center gap-1.5 rounded px-2 text-[13px] font-[440] leading-5 text-v2-text-text-faint hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
          style={props.state.style}
        >
          <Icon name="sliders" size="small" class="shrink-0 text-v2-icon-icon-muted" />
          <span class="min-w-0 truncate">{props.state.current || "Agent"}</span>
          <Icon name="chevron-down" size="small" class="shrink-0 text-v2-icon-icon-muted" />
        </KobaltePopover.Trigger>
      </TooltipKeybind>
      <KobaltePopover.Portal>
        <KobaltePopover.Content class="w-[270px] overflow-hidden rounded-md bg-v2-background-bg-layer-01 p-0.5 shadow-[var(--v2-elevation-floating)] focus:outline-none">
          <div class="flex max-h-[300px] flex-col overflow-y-auto" role="listbox" aria-label="Agents">
            <For each={props.state.options}>
              {(agent) => (
                <div class="group flex min-w-0 items-center rounded hover:bg-v2-overlay-simple-overlay-hover">
                  <button
                    type="button"
                    data-mobile-touch-target
                    role="option"
                    aria-selected={agent === props.state.current}
                    class="flex h-8 min-w-0 flex-1 items-center gap-2 px-3 text-left text-[13px] text-v2-text-text-base focus-visible:outline-none"
                    onClick={() => {
                      if (props.state.disabled) return
                      props.state.onSelect(agent)
                      props.state.onOpenChange(false)
                    }}
                  >
                    <Icon name="brain" size="small" class="shrink-0 text-v2-icon-icon-muted" />
                    <span class="min-w-0 flex-1 truncate">{agent}</span>
                    <Show when={agent === props.state.current}>
                      <Icon name="check-small" size="small" class="shrink-0" />
                    </Show>
                  </button>
                  <button
                    type="button"
                    data-action={`prompt-agent-configure-${agent}`}
                    data-mobile-touch-target
                    class="mr-1 flex size-7 shrink-0 items-center justify-center rounded text-v2-icon-icon-muted opacity-70 hover:bg-v2-overlay-simple-overlay-active hover:opacity-100 focus-visible:outline-none"
                    aria-label={`Configure ${agent}`}
                    title={`Configure ${agent}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      if (props.state.disabled) return
                      props.state.onOpenChange(false)
                      props.state.onConfigure(agent)
                    }}
                  >
                    <Icon name="settings-gear" size="small" />
                  </button>
                </div>
              )}
            </For>
          </div>
          <div class="my-0.5 h-px bg-v2-border-border-muted" />
          <button
            type="button"
            data-action="prompt-agent-create"
            data-mobile-touch-target
            class="flex h-8 w-full items-center gap-2 rounded px-3 text-left text-[13px] text-v2-text-text-base hover:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none"
            onClick={() => {
              if (props.state.disabled) return
              props.state.onOpenChange(false)
              props.state.onCreate()
            }}
          >
            <Icon name="plus" size="small" />
            <span>Create agent…</span>
          </button>
        </KobaltePopover.Content>
      </KobaltePopover.Portal>
    </KobaltePopover>
  )
}

type AccessControlOption = {
  mode: AccessControlMode
  label: string
  trigger: string
  description: string
  icon: IconProps["name"]
  colorClass: string
}

const accessControlAskOption: AccessControlOption = {
  mode: "ask",
  label: "Ask for approval",
  trigger: "Ask",
  description: "Use configured permission rules and ask whenever an action requires approval.",
  icon: "shield",
  colorClass: "text-v2-state-fg-success",
}

const accessControlOptions: AccessControlOption[] = [
  accessControlAskOption,
  {
    mode: "approve_for_me",
    label: "Approve for me",
    trigger: "Approve for me",
    description: "Use an LLM safety review to approve safe actions and ask for risky ones.",
    icon: "circle-check",
    colorClass: "text-v2-state-fg-warning",
  },
  {
    mode: "full_access",
    label: "Full access",
    trigger: "Full access",
    description: "YOLO mode. Allow all OpenCode tool actions without approval prompts.",
    icon: "warning",
    colorClass: "text-v2-state-fg-danger",
  },
]

function isAccessControlMode(value: string): value is AccessControlMode {
  return value === "ask" || value === "approve_for_me" || value === "full_access"
}

export function ComposerAccessControl(props: { state: ComposerAccessControlState }) {
  const current = createMemo(
    () => accessControlOptions.find((option) => option.mode === props.state.mode) ?? accessControlAskOption,
  )

  return (
    <MenuV2 gutter={4} modal={false} placement="bottom-start">
      <MenuV2.Trigger
        data-action="prompt-access-control"
        data-mobile-touch-target
        type="button"
        class="flex h-7 min-w-0 items-center gap-1.5 rounded px-2 text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-faint transition-colors hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none"
        classList={{
          "text-v2-state-fg-success": props.state.mode === "ask",
          "text-v2-state-fg-warning": props.state.mode === "approve_for_me",
          "text-v2-state-fg-danger": props.state.mode === "full_access",
        }}
        style={props.state.style}
        aria-label="Access control"
      >
        <Icon name={current().icon} size="small" class={`shrink-0 ${current().colorClass}`} />
        <span class="min-w-0 truncate leading-5">{current().trigger}</span>
        <Icon name="chevron-down" size="small" class={`shrink-0 ${current().colorClass}`} />
      </MenuV2.Trigger>
      <MenuV2.Portal>
        <MenuV2.Content class="w-[320px]">
          <MenuV2.Group>
            <MenuV2.GroupLabel>How should OpenCode actions be approved?</MenuV2.GroupLabel>
            <MenuV2.RadioGroup
              value={props.state.mode}
              onChange={(value) => {
                if (!isAccessControlMode(value)) return
                props.state.onModeSelect(value)
              }}
            >
              <For each={accessControlOptions}>
                {(option) => (
                  <MenuV2.RadioItem value={option.mode} style={{ height: "auto", "min-height": "48px", padding: "8px 12px" }}>
                    <Icon name={option.icon} size="small" class={`shrink-0 ${option.colorClass}`} />
                    <span class="flex min-w-0 flex-col gap-1">
                      <span class={`truncate ${option.colorClass}`}>{option.label}</span>
                      <span class="whitespace-normal text-[11px] font-[400] leading-4 text-v2-text-text-faint">
                        {option.description}
                      </span>
                    </span>
                  </MenuV2.RadioItem>
                )}
              </For>
            </MenuV2.RadioGroup>
          </MenuV2.Group>
          <MenuV2.Separator />
          <MenuV2.CheckboxItem checked={props.state.updateProjectDefault} onChange={props.state.onUpdateProjectDefault}>
            Update Project default
          </MenuV2.CheckboxItem>
          <MenuV2.CheckboxItem checked={props.state.updateUserDefault} onChange={props.state.onUpdateUserDefault}>
            Update User default
          </MenuV2.CheckboxItem>
          <div class="px-3 py-2 text-[11px] leading-4 text-v2-text-text-faint">
            Permissions are approval UX, not a sandbox. OS, credential, network, and provider failures can still block actions.
          </div>
        </MenuV2.Content>
      </MenuV2.Portal>
    </MenuV2>
  )
}

export function ComposerModelControl(props: { state: ComposerModelControlState }) {
  return (
    <div
      data-component="composer-model-control"
      data-provider-error={props.state.error ? "true" : "false"}
      data-provider-loading={props.state.loading ? "true" : "false"}
      class="flex min-w-0 items-center gap-1"
    >
      <Show
        when={props.state.paid || !!props.state.model.chain.current()}
        fallback={
          <TooltipKeybind placement="top" gutter={4} title={props.state.title} keybind={props.state.keybind}>
            <Button
              data-action="prompt-model"
              data-mobile-touch-target
              as="div"
              variant="ghost"
              size="normal"
              class="min-w-0 max-w-[220px] justify-start text-[13px] font-[440] leading-5 text-v2-text-text-faint group"
              style={props.state.style}
              aria-disabled={props.state.disabled ? "true" : undefined}
              onClick={props.state.onUnpaidClick}
            >
              <Show when={props.state.providerID}>
                {(providerID) => (
                  <ProviderIcon
                    id={providerID()}
                    class="size-4 shrink-0 opacity-40 group-hover:opacity-100 transition-opacity duration-150"
                    style={{ "will-change": "opacity", transform: "translateZ(0)" }}
                  />
                )}
              </Show>
              <span class="truncate">{props.state.modelName}</span>
              <Icon name="chevron-down" size="small" class="shrink-0 text-v2-icon-icon-muted" />
            </Button>
          </TooltipKeybind>
        }
      >
        <TooltipKeybind placement="top" gutter={4} title={props.state.title} keybind={props.state.keybind}>
          <ModelSelectorPopover
            model={props.state.model}
            triggerAs={Button}
            triggerProps={{
              variant: "ghost",
              size: "normal",
              style: props.state.style,
              class:
                "min-w-0 max-w-[220px] justify-start text-[13px] font-[440] leading-5 text-v2-text-text-faint group",
              disabled: props.state.disabled,
              "aria-disabled": props.state.disabled ? "true" : undefined,
              "data-action": "prompt-model",
              "data-mobile-touch-target": "",
            }}
            onClose={props.state.onClose}
          >
            <Show when={props.state.providerID}>
              {(providerID) => (
                <ProviderIcon
                  id={providerID()}
                  class="size-4 shrink-0 opacity-40 group-hover:opacity-100 transition-opacity duration-150"
                  style={{ "will-change": "opacity", transform: "translateZ(0)" }}
                />
              )}
            </Show>
            <span class="truncate">{props.state.modelName}</span>
            <Icon name="chevron-down" size="small" class="shrink-0 text-v2-icon-icon-muted" />
          </ModelSelectorPopover>
        </TooltipKeybind>
      </Show>
      <Show when={props.state.loading}>
        <span
          data-component="provider-catalog-loading"
          role="status"
          aria-label="Loading provider catalog"
          title="Loading provider catalog"
          class="flex size-5 shrink-0 items-center justify-center text-v2-icon-icon-muted"
        >
          <Spinner class="size-3" />
          <span class="sr-only">Loading provider catalog</span>
        </span>
      </Show>
      <Show when={props.state.error}>
        <span data-component="provider-catalog-error">
          <Button
            data-action="provider-catalog-retry"
            data-mobile-touch-target
            variant="ghost"
            size="small"
            class="h-6 shrink-0 px-1.5 text-[11px] text-v2-state-fg-danger"
            aria-label="Retry provider catalog"
            title="Provider catalog unavailable. Retry discovery."
            disabled={props.state.retrying}
            onClick={props.state.onRetry}
          >
            Retry
          </Button>
        </span>
      </Show>
    </div>
  )
}
