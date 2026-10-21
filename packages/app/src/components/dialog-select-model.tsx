import { Popover as Kobalte } from "@kobalte/core/popover"
import { Component, ComponentProps, createMemo, For, JSX, Show, ValidComponent } from "solid-js"
import { createStore } from "solid-js/store"
import { useLocal } from "@/context/local"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { popularProviders } from "@/hooks/use-providers"
import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tag } from "@opencode-ai/ui/tag"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { ModelTooltip } from "./model-tooltip"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import type { ModelChain } from "@/context/model-chain"
import { createModelSelectorSearch, modelSelectorChains, modelSelectorListOptions } from "./model-selector"

const isFree = (provider: string, cost: { input: number } | undefined) =>
  provider === "opencode" && (!cost || cost.input === 0)

type ModelState = ReturnType<typeof useLocal>["model"]
type ModelChainSelectorState = Omit<ModelState["chain"], "ready" | "managementReady"> &
  Partial<Pick<ModelState["chain"], "ready" | "managementReady">>
export type ModelSelectorModelState = Pick<ModelState, "current" | "recent" | "list" | "set" | "visible"> & {
  chain?: ModelChainSelectorState
}
export type ModelChainManagerState = ModelSelectorModelState & { chain: ModelChainSelectorState }
type ModelItem = NonNullable<ReturnType<ModelState["current"]>>
type ModelListReadyItem = ModelItem & {
  id: string
  name: string
  provider: NonNullable<ModelItem["provider"]> & { id: string; name: string }
  limit: { context: number }
}
type ModelListItem = ModelListReadyItem & { group: string; recent: boolean }

const isModelItem = (item: ModelItem | undefined): item is ModelListReadyItem => {
  return !!item?.id && !!item.name && !!item.provider?.id && !!item.provider.name && typeof item.limit?.context === "number"
}

const ModelList: Component<{
  provider?: string
  class?: string
  onSelect: () => void
  action?: JSX.Element
  model?: ModelSelectorModelState
  showModels?: boolean
}> = (props) => {
  const model = props.model ?? useLocal().model
  const language = useLanguage()
  const settings = useSettings()
  const recentGroup = () => language.t("model.group.recent")
  const key = (providerID: string, modelID: string) => `${providerID}:${modelID}`
  const recentModels = createMemo(() =>
    model
      .recent()
      .filter(isModelItem)
      .filter((m) => model.visible({ modelID: m.id, providerID: m.provider.id }))
      .filter((m) => (props.provider ? m.provider.id === props.provider : true))
      .slice(0, settings.models.recentLimit()),
  )
  const recentKeys = createMemo(() => new Set(recentModels().map((m) => key(m.provider.id, m.id))))
  const recentModelRank = createMemo(
    () => new Map(recentModels().map((m, index) => [key(m.provider.id, m.id), index] as const)),
  )
  const recentProviderRank = createMemo(() => {
    const entries = new Map<string, number>()
    for (const item of recentModels()) {
      if (entries.has(item.provider.id)) continue
      entries.set(item.provider.id, entries.size)
    }
    return entries
  })

  const current = createMemo<ModelListItem | undefined>(() => {
    const item = model.current()
    if (!isModelItem(item)) return
    return { ...item, group: "", recent: false }
  })
  const chains = createMemo(() => props.provider ? [] : modelSelectorChains(model.chain?.list() ?? []))
  const chainPath = (chain: ModelChain) =>
    chain.steps.map((step) => {
      const item = model.list().find((entry) => entry.provider.id === step.providerID && entry.id === step.modelID)
      return `${item?.name ?? `${step.providerID}/${step.modelID}`}${step.variant ? ` (${step.variant})` : ""}${item ? "" : " — unavailable"}`
    }).join(" → ")
  const search = createModelSelectorSearch(() => language.t("dialog.model.search.placeholder"), () => props.action)

  const models = createMemo<ModelListItem[]>(() =>
    props.showModels === false
      ? []
      : [
      ...recentModels().map((m) => ({ ...m, group: recentGroup(), recent: true })),
      ...model
        .list()
        .filter(isModelItem)
        .filter((m) => model.visible({ modelID: m.id, providerID: m.provider.id }))
        .filter((m) => (props.provider ? m.provider.id === props.provider : true))
        .filter((m) => !recentKeys().has(key(m.provider.id, m.id)))
        .map((m) => ({ ...m, group: m.provider.name, recent: false })),
    ],
  )

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <List
      {...modelSelectorListOptions}
      scrollHeader={
      <Show when={chains().length > 0}>
        <div class="pt-2" role="listbox" aria-label="Model chains">
          <For each={chains()}>{(chain) => (
            <button
              type="button"
              role="option"
              aria-selected={model.chain?.current()?.id === chain.id}
              class="w-full rounded-md px-2 py-2 text-left hover:bg-surface-raised-base"
              classList={{ "bg-surface-raised-base": model.chain?.current()?.id === chain.id }}
              onClick={() => {
                model.chain?.set(chain.id)
                props.onSelect()
              }}
            >
              <div class="text-13-medium">{chain.name}</div>
              <div class="whitespace-normal text-12-regular text-text-weak">{chainPath(chain)}</div>
            </button>
          )}</For>
        </div>
      </Show>
      }
      class={`mobile-model-list flex-1 px-3 min-h-0 [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0 ${props.class ?? ""}`}
      search={search()}
      emptyMessage={language.t("dialog.model.empty")}
      key={(x) => `${x.provider.id}:${x.id}`}
      items={models}
      current={current()}
      filterKeys={["provider.name", "name", "id"]}
      sortBy={(a, b) => {
        if (a.recent && b.recent)
          return (
            (recentModelRank().get(key(a.provider.id, a.id)) ?? 0) -
            (recentModelRank().get(key(b.provider.id, b.id)) ?? 0)
          )
        return a.name.localeCompare(b.name)
      }}
      groupBy={(x) => x.group}
      sortGroupsBy={(a, b) => {
        const recent = recentGroup()
        if (a.category === recent && b.category !== recent) return -1
        if (b.category === recent && a.category !== recent) return 1
        const aProvider = a.items[0]?.provider.id ?? ""
        const bProvider = b.items[0]?.provider.id ?? ""
        const aRecent = recentProviderRank().get(aProvider)
        const bRecent = recentProviderRank().get(bProvider)
        if (aRecent !== undefined && bRecent !== undefined) return aRecent - bRecent
        if (aRecent !== undefined) return -1
        if (bRecent !== undefined) return 1
        if (popularProviders.includes(aProvider) && !popularProviders.includes(bProvider)) return -1
        if (!popularProviders.includes(aProvider) && popularProviders.includes(bProvider)) return 1
        return popularProviders.indexOf(aProvider) - popularProviders.indexOf(bProvider)
      }}
      itemWrapper={(item, node) => (
        <Tooltip
          class="w-full"
          placement="right-start"
          gutter={12}
          value={<ModelTooltip model={item} latest={item.latest} free={isFree(item.provider.id, item.cost)} />}
        >
          {node}
        </Tooltip>
      )}
      onSelect={(x) => {
        model.set(x ? { modelID: x.id, providerID: x.provider.id } : undefined, {
          recent: true,
        })
        props.onSelect()
      }}
    >
      {(i) => (
        <div class="w-full flex items-center gap-x-2 text-13-regular">
          <span class="truncate">{i.name}</span>
          <Show when={isFree(i.provider.id, i.cost)}>
            <Tag>{language.t("model.tag.free")}</Tag>
          </Show>
          <Show when={i.latest}>
            <Tag>{language.t("model.tag.latest")}</Tag>
          </Show>
        </div>
      )}
      </List>
    </div>
  )
}

type ModelSelectorTriggerProps = Omit<ComponentProps<typeof Kobalte.Trigger>, "as" | "ref">
type Dismiss = "escape" | "outside" | "select" | "manage" | "provider"

export function ModelSelectorPopover(props: {
  provider?: string
  model?: ModelSelectorModelState
  children?: JSX.Element
  triggerAs?: ValidComponent
  triggerProps?: ModelSelectorTriggerProps
  onClose?: (cause: "escape" | "select") => void
  showModels?: boolean
}) {
  const model = props.model ?? useLocal().model
  const [store, setStore] = createStore<{
    open: boolean
    dismiss: Dismiss | null
  }>({
    open: false,
    dismiss: null,
  })
  const dialog = useDialog()

  const close = (dismiss: Dismiss) => {
    setStore("dismiss", dismiss)
    setStore("open", false)
  }

  const handleManage = () => {
    close("manage")
    void import("./dialog-manage-models").then((x) => {
      dialog.show(() => <x.DialogManageModels />)
    })
  }

  const handleManageChains = () => {
    if (!(model.chain?.managementReady?.() ?? model.chain?.ready?.())) return
    close("manage")
    void import("./dialog-manage-model-chains").then((x) => {
      dialog.show(() => <x.DialogManageModelChains model={model as ModelChainManagerState} />)
    })
  }

  const handleConnectProvider = () => {
    close("provider")
    void import("./dialog-select-provider").then((x) => {
      dialog.show(() => <x.DialogSelectProvider />)
    })
  }
  const language = useLanguage()

  return (
    <Kobalte
      open={store.open}
      onOpenChange={(next) => {
        if (next) setStore("dismiss", null)
        setStore("open", next)
      }}
      modal={false}
      placement="top-start"
      gutter={4}
    >
      <Kobalte.Trigger as={props.triggerAs ?? "div"} {...props.triggerProps}>
        {props.children}
      </Kobalte.Trigger>
      <Kobalte.Portal>
        <Kobalte.Content
          data-component="model-selector-popover"
          class="w-80 max-w-[calc(100vw-16px)] h-[30rem] max-h-[min(70vh,30rem,var(--kb-popper-content-available-height,70vh))] flex flex-col p-2 rounded-md border border-border-base bg-surface-raised-stronger-non-alpha shadow-md outline-none overflow-hidden"
          style={{ "z-index": 3000 }}
          onEscapeKeyDown={(event) => {
            close("escape")
            event.preventDefault()
            event.stopPropagation()
          }}
          onPointerDownOutside={() => close("outside")}
          onFocusOutside={() => close("outside")}
          onCloseAutoFocus={(event) => {
            const dismiss = store.dismiss
            if (dismiss === "outside") event.preventDefault()
            if (dismiss === "escape" || dismiss === "select") {
              event.preventDefault()
              props.onClose?.(dismiss)
            }
            setStore("dismiss", null)
          }}
        >
          <Kobalte.Title class="sr-only">{language.t("dialog.model.select.title")}</Kobalte.Title>
          <ModelList
            provider={props.provider}
            model={model}
            showModels={props.showModels}
            onSelect={() => close("select")}
            class="p-1"
            action={
              <div class="flex items-center gap-1">
                <Show when={model.chain}>
                  <Button
                    size="small"
                    variant="ghost"
                    disabled={!(model.chain?.managementReady?.() ?? model.chain?.ready?.())}
                    onClick={handleManageChains}
                  >
                    Chains
                  </Button>
                </Show>
                <Tooltip placement="top" value={language.t("command.provider.connect")}>
                  <IconButton
                    icon="plus-small"
                    variant="ghost"
                    iconSize="normal"
                    class="size-6"
                    data-mobile-touch-target
                    data-action="model-provider-connect"
                    aria-label={language.t("command.provider.connect")}
                    onClick={handleConnectProvider}
                  />
                </Tooltip>
                <Tooltip placement="top" value={language.t("dialog.model.manage")}>
                  <IconButton
                    icon="sliders"
                    variant="ghost"
                    iconSize="normal"
                    class="size-6"
                    data-mobile-touch-target
                    data-action="model-manage"
                    aria-label={language.t("dialog.model.manage")}
                    onClick={handleManage}
                  />
                </Tooltip>
              </div>
            }
          />
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}

export const DialogSelectModel: Component<{ provider?: string; model?: ModelState }> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const model = props.model ?? useLocal().model

  const provider = () => {
    void import("./dialog-select-provider").then((x) => {
      dialog.show(() => <x.DialogSelectProvider />)
    })
  }

  const manage = () => {
    void import("./dialog-manage-models").then((x) => {
      dialog.show(() => <x.DialogManageModels />)
    })
  }

  const manageChains = () => {
    if (!(model.chain?.managementReady?.() ?? model.chain?.ready?.())) return
    void import("./dialog-manage-model-chains").then((x) => {
      dialog.show(() => <x.DialogManageModelChains model={model} />)
    })
  }

  return (
    <Dialog
      title={language.t("dialog.model.select.title")}
      action={
        <Button
          data-mobile-touch-target
          data-action="model-provider-connect"
          class="h-7 -my-1 text-14-medium"
          icon="plus-small"
          tabIndex={-1}
          onClick={provider}
        >
          {language.t("command.provider.connect")}
        </Button>
      }
    >
      <ModelList provider={props.provider} model={model} onSelect={() => dialog.close()} />
      <Show when={model.chain}>
        <Button
          variant="ghost"
          class="ml-3 mt-3 text-text-base self-start"
          disabled={!(model.chain?.managementReady?.() ?? model.chain?.ready?.())}
          onClick={manageChains}
        >
          Manage model chains
        </Button>
      </Show>
      <Button
        data-mobile-touch-target
        data-action="model-manage"
        variant="ghost"
        class="ml-3 mt-5 mb-6 text-text-base self-start"
        onClick={manage}
      >
        {language.t("dialog.model.manage")}
      </Button>
    </Dialog>
  )
}
