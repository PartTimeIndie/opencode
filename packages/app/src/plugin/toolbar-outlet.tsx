import { For, Show, createEffect, createMemo, createSignal, createUniqueId, onCleanup } from "solid-js"
import { Portal } from "solid-js/web"
import { Icon, type IconProps } from "@opencode-ai/ui/icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { DIALOG_OPEN_EVENT } from "@opencode-ai/ui/context/dialog"
import { useLayout } from "@/context/layout"
import { showToast } from "@/utils/toast"
import { visualViewportBounds } from "@/utils/visual-viewport"
import { useAppPluginRuntime, type ToolbarItem } from "./app-runtime"
import { mountPluginElement } from "./mount-lifecycle"
import {
  filterToolbarItems,
  toolbarAlign,
  toolbarItemEnabled,
  type ToolbarAlign,
  type ToolbarContext,
  type ToolbarPlacement,
} from "./toolbar"

export function PluginToolbarOutlet(props: {
  placement?: ToolbarPlacement
  align?: ToolbarAlign
  directory?: string
  sessionID?: string
  composerID?: string
  mobile?: "visible"
  class?: string
}) {
  const plugins = useAppPluginRuntime()
  const layout = useLayout()
  const context = createMemo<ToolbarContext>(() => {
    const placement = props.placement ?? "top"
    const align = props.align ?? (placement === "composer" ? "left" : "right")
    const route = layout.route()
    return {
      placement,
      align,
      directory:
        props.directory ?? (route.type === "session" || route.type === "dir-new-session" ? route.dir : undefined),
      sessionID: props.sessionID ?? (route.type === "session" ? route.sessionId : undefined),
      composerID: props.composerID,
    }
  })
  const items = createMemo(() =>
    filterToolbarItems(plugins.toolbarItems(), context(), plugins.toolbarItemOrder(context().directory)).filter(
      (item) =>
        plugins.toolbarItemVisible(item.id, context().directory) &&
        (props.mobile !== "visible" || item.mobile === "visible"),
    ),
  )
  return (
    <Show when={items().length > 0}>
      <div
        data-component="plugin-toolbar-outlet"
        data-plugin-toolbar-placement={context().placement}
        data-plugin-toolbar-align={context().align}
        class={props.class ?? "contents"}
      >
        <For each={items()}>
          {(item) => (
            <Show
              when={(item.kind ?? "icon") === "mount"}
              fallback={<PluginToolbarButton item={item} context={context()} />}
            >
              <PluginToolbarMount item={item} context={context()} />
            </Show>
          )}
        </For>
      </div>
    </Show>
  )
}

export function PluginToolbarMobileOverflow(props: {
  directory?: string
  sessionID?: string
  composerID?: string
  compact?: boolean
  class?: string
}) {
  const plugins = useAppPluginRuntime()
  const layout = useLayout()
  const menuID = createUniqueId()
  const [open, setOpen] = createSignal(false)
  const [position, setPosition] = createSignal({ left: 8, top: 8, width: 304, maxHeight: 400 })
  let root: HTMLDivElement | undefined
  let menu: HTMLDivElement | undefined
  const closeForDialog = () => setOpen(false)

  const context = (align: ToolbarAlign): ToolbarContext => {
    const route = layout.route()
    return {
      placement: "composer",
      align,
      directory:
        props.directory ?? (route.type === "session" || route.type === "dir-new-session" ? route.dir : undefined),
      sessionID: props.sessionID ?? (route.type === "session" ? route.sessionId : undefined),
      composerID: props.composerID,
    }
  }
  const items = createMemo(() =>
    (["left", "right"] as const).flatMap((align) =>
      filterToolbarItems(
        plugins.toolbarItems(),
        context(align),
        plugins.toolbarItemOrder(context(align).directory),
      ).filter((item) =>
        plugins.toolbarItemVisible(item.id, context(align).directory) && item.mobile !== "visible",
      ),
    ),
  )

  const updatePosition = () => {
    if (!root) return
    const rect = root.getBoundingClientRect()
    const viewport = visualViewportBounds(window)
    const margin = 8
    const gap = 6
    const width = Math.min(304, Math.max(0, viewport.width - margin * 2))
    const above = Math.max(0, rect.top - viewport.top - margin - gap)
    const below = Math.max(0, viewport.bottom - rect.bottom - margin - gap)
    const openAbove = above >= Math.min(menu?.scrollHeight ?? 240, 240) || above >= below
    const available = openAbove ? above : below
    const maxHeight = Math.min(400, available)
    const height = Math.min(menu?.scrollHeight || maxHeight, maxHeight)
    const left = Math.min(
      Math.max(viewport.left + margin, rect.right - width),
      Math.max(viewport.left + margin, viewport.right - width - margin),
    )
    const top = openAbove
      ? Math.max(viewport.top + margin, rect.top - height - gap)
      : Math.min(rect.bottom + gap, viewport.bottom - height - margin)
    setPosition({ left, top, width, maxHeight })
  }

  createEffect(() => {
    if (!open()) return
    updatePosition()
    queueMicrotask(updatePosition)
    const syncPosition = () => updatePosition()
    const close = (event: PointerEvent) => {
      if (root?.contains(event.target as Node)) return
      if (menu?.contains(event.target as Node)) return
      setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      setOpen(false)
    }
    window.addEventListener("resize", syncPosition)
    window.addEventListener("scroll", syncPosition, true)
    window.visualViewport?.addEventListener("resize", syncPosition)
    window.visualViewport?.addEventListener("scroll", syncPosition)
    document.addEventListener(DIALOG_OPEN_EVENT, closeForDialog)
    document.addEventListener("pointerdown", close)
    document.addEventListener("keydown", escape)
    onCleanup(() => {
      window.removeEventListener("resize", syncPosition)
      window.removeEventListener("scroll", syncPosition, true)
      window.visualViewport?.removeEventListener("resize", syncPosition)
      window.visualViewport?.removeEventListener("scroll", syncPosition)
      document.removeEventListener(DIALOG_OPEN_EVENT, closeForDialog)
      document.removeEventListener("pointerdown", close)
      document.removeEventListener("keydown", escape)
    })
  })

  createEffect(() => {
    if (items().length > 0) return
    setOpen(false)
  })

  return (
    <Show when={items().length > 0}>
      <div ref={root} data-component="plugin-toolbar-mobile-overflow" class={props.class ?? "relative"}>
        <Tooltip placement="top" value="More tools">
          <IconButtonV2
            data-action="plugin-toolbar-more"
            type="button"
            variant="ghost-muted"
            size="large"
            class={props.compact ? "!size-7 shrink-0" : "!size-11 shrink-0"}
            aria-label="More tools"
            aria-expanded={open()}
            aria-controls={menuID}
            onClick={() => setOpen((value) => !value)}
            icon={<Icon name="menu" size="normal" />}
          />
        </Tooltip>
        <Portal mount={document.body}>
          <div
            ref={menu}
            id={menuID}
            data-component="plugin-toolbar-mobile-menu"
            role="group"
            aria-label="Plugin tools"
            hidden={!open()}
            inert={!open()}
            aria-hidden={!open()}
            class="fixed z-[1900] overflow-y-auto rounded-xl border border-border-weak-base bg-background-stronger p-1 shadow-lg"
            style={{
              left: `${position().left}px`,
              top: `${position().top}px`,
              width: `${position().width}px`,
              "max-height": `${position().maxHeight}px`,
            }}
          >
            <For each={items()}>
              {(item) => {
                const itemContext = () => context(toolbarAlign(item))
                return (
                  <div
                    data-plugin-toolbar-mobile-row={item.id}
                    data-plugin-toolbar-align={toolbarAlign(item)}
                    role="none"
                    class="flex min-h-11 items-center gap-2 rounded-lg px-2 text-13-regular text-text-base"
                  >
                    <span class="min-w-0 flex-1 truncate">{item.title}</span>
                    <Show
                      when={(item.kind ?? "icon") === "mount"}
                      fallback={<PluginToolbarButton item={item} context={itemContext()} />}
                    >
                      <PluginToolbarMount item={item} context={itemContext()} />
                    </Show>
                  </div>
                )
              }}
            </For>
          </div>
        </Portal>
      </div>
    </Show>
  )
}

function PluginToolbarButton(props: { item: ToolbarItem; context: ToolbarContext }) {
  const plugins = useAppPluginRuntime()
  const armed = () => plugins.toolbarItemArmed(props.item.id, props.context)
  const [running, setRunning] = createSignal(false)
  const enabled = () => !running() && !!props.item.run && toolbarItemEnabled(props.item, props.context)
  const label = () => props.item.tooltip ?? props.item.title
  const iconSize = () => (props.context.placement === "composer" ? "small" : (props.item.icon?.size ?? "normal"))
  const iconImageClass = () => {
    if (props.context.placement === "composer") return "size-4"
    return iconSize() === "large" ? "size-5" : iconSize() === "small" ? "size-3.5" : "size-4"
  }

  const run = async () => {
    if (!enabled()) return
    setRunning(true)
    try {
      await props.item.run?.(props.context)
    } catch (error) {
      showToast({
        title: `${props.item.title} failed`,
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setRunning(false)
    }
  }

  return (
    <Tooltip placement={props.context.placement === "composer" ? "top" : "bottom"} value={label()}>
      <IconButtonV2
        data-plugin-toolbar-item={props.item.id}
        data-plugin-toolbar-kind="button"
        type="button"
        variant="ghost-muted"
        size="large"
        classList={{
          "shrink-0": true,
          "size-7": props.context.placement === "composer",
          "!w-9": props.context.placement !== "composer",
        }}
        disabled={!enabled()}
        onClick={() => void run()}
        aria-pressed={armed()}
        style={
          armed()
            ? { background: "var(--background-element-hover)", "box-shadow": "inset 0 0 0 1px currentColor" }
            : undefined
        }
        aria-label={props.item.title}
        icon={
          <Show
            when={props.item.icon?.src}
            fallback={<Icon name={(props.item.icon?.name ?? "code") as IconProps["name"]} size={iconSize()} />}
          >
            {(src) => (
              <span
                class={`${iconImageClass()} block shrink-0 bg-current`}
                style={{
                  "-webkit-mask": iconMaskImage(src()),
                  mask: iconMaskImage(src()),
                }}
                aria-hidden="true"
              />
            )}
          </Show>
        }
      />
    </Tooltip>
  )
}

function iconMaskImage(src: string) {
  return `url("${src.replace(/["\\]/g, "\\$&").replace(/[\n\r\f]/g, "")}") center / contain no-repeat`
}

function PluginToolbarMount(props: { item: ToolbarItem; context: ToolbarContext }) {
  let root: HTMLDivElement | undefined
  let cleanup: (() => void) | undefined

  const dispose = () => {
    cleanup?.()
    cleanup = undefined
  }

  createEffect(() => {
    const element = root
    if (!element || !props.item.mount) {
      dispose()
      return
    }

    dispose()
    cleanup = mountPluginElement({
      element,
      mount: (signal) => props.item.mount!({ element, signal, context: props.context }),
      onError: (error) => {
        console.error("[app-plugin] toolbar mount failed", { id: props.item.id, error })
        element.replaceChildren()
      },
    })
  })

  onCleanup(dispose)

  return (
    <div
      ref={root}
      data-component="plugin-toolbar-mount"
      data-plugin-toolbar-item={props.item.id}
      class="flex h-7 shrink-0 items-center text-v2-icon-icon-base"
    />
  )
}
