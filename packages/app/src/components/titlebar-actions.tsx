import { createEffect, createMemo, createSignal, on, onMount, onCleanup, Show } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { Icon, type IconProps } from "@opencode-ai/ui/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useLayout } from "@/context/layout"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { useTabs, sessionTabDockPaneID, tabKey } from "@/context/tabs"
import { MOBILE_DOCK_MEDIA_QUERY } from "@/context/layout-dock"
import { SessionStateKey, SessionRouteKey } from "@/utils/server-scope"
import { toggleTitlebarDock } from "./titlebar-dock"
import { observeTitlebarFocus } from "./titlebar-focus"

export function TitlebarActions() {
  const layout = useLayout()
  const command = useCommand()
  const language = useLanguage()
  const server = useServer()
  const tabs = useTabs()
  const mobile = createMediaQuery(MOBILE_DOCK_MEDIA_QUERY)
  const [focus, setFocus] = createSignal<{ pane: string; tab?: string }>()
  createEffect(on(() => {
    const tab = tabs.active()
    return tab ? tabKey(tab) : undefined
  }, () => setFocus(undefined)))
  onMount(() => {
    onCleanup(observeTitlebarFocus(document, (pane) => {
      const tab = tabs.active()
      setFocus({ pane, tab: tab ? tabKey(tab) : undefined })
    }))
    const listener = (event: Event) => {
      if (!(event instanceof CustomEvent) || typeof event.detail?.active !== "string") return
      const tab = tabs.active()
      setFocus({ pane: event.detail.active, tab: tab ? tabKey(tab) : undefined })
    }
    window.addEventListener("opencode:dock-resize", listener)
    onCleanup(() => window.removeEventListener("opencode:dock-resize", listener))
  })
  const session = () => {
    const tab = tabs.active()
    if (tab?.type !== "session" || tab.server !== server.key) return
    if (focus()?.tab === tabKey(tab) && focus()?.pane !== sessionTabDockPaneID(tab)) return
    return layout.view(SessionStateKey.from(server.scope(), SessionRouteKey.fromRoute(tab.dirBase64, tab.sessionId)))
  }
  const toggle = (area: "top" | "left" | "right" | "bottom") => toggleTitlebarDock({
    area,
    dock: layout.dock,
    fileTreeOpened: layout.fileTree.opened(),
    session: session(),
  })
  const state = createMemo(() => ({
    settingsLabel: language.t("command.settings.open"),
    topDockOpened: layout.dock.area("top").visible(),
    leftDockOpened: layout.dock.area("left").visible(),
    rightDockOpened: layout.dock.area("right").visible(),
    bottomDockOpened: layout.dock.area("bottom").visible(),
    mobile: mobile(),
    mobileDockOpened: layout.dock.mobile.opened(),
    mobileDockAttention: layout.dock.mobile.attention().length,
    onSettingsOpen: () => command.trigger("settings.open"),
    onTopDockToggle: () => toggle("top"),
    onLeftDockToggle: () => toggle("left"),
    onRightDockToggle: () => toggle("right"),
    onBottomDockToggle: () => toggle("bottom"),
    onMobileDockToggle: () => layout.dock.mobile.toggle(),
  }))
  return <TitlebarActionButtons state={state()} />
}

type TitlebarActionsState = {
  settingsLabel: string
  topDockOpened: boolean
  leftDockOpened: boolean
  rightDockOpened: boolean
  bottomDockOpened: boolean
  mobile: boolean
  mobileDockOpened: boolean
  mobileDockAttention: number
  onSettingsOpen: () => void
  onTopDockToggle: () => void
  onLeftDockToggle: () => void
  onRightDockToggle: () => void
  onBottomDockToggle: () => void
  onMobileDockToggle: () => void
}

function TitlebarActionButtons(props: { state: TitlebarActionsState }) {
  return <div data-component="global-titlebar-actions" class="flex items-center gap-2">
      <HeaderDockButton label={props.state.settingsLabel} icon="settings-gear" onClick={props.state.onSettingsOpen} />
      <Show
        when={props.state.mobile}
        fallback={
          <div class="flex items-center gap-1">
            <HeaderDockButton
              label="Toggle top dock"
              pressed={props.state.topDockOpened}
              icon={props.state.topDockOpened ? "layout-bottom-full" : "layout-bottom-partial"}
              iconClass="rotate-180"
              onClick={props.state.onTopDockToggle}
            />
            <HeaderDockButton
              label="Toggle left dock"
              pressed={props.state.leftDockOpened}
              icon={props.state.leftDockOpened ? "layout-left-full" : "layout-left-partial"}
              onClick={props.state.onLeftDockToggle}
            />
            <HeaderDockButton
              label="Toggle right dock"
              pressed={props.state.rightDockOpened}
              icon={props.state.rightDockOpened ? "layout-right-full" : "layout-right-partial"}
              onClick={props.state.onRightDockToggle}
            />
            <HeaderDockButton
              label="Toggle bottom dock"
              pressed={props.state.bottomDockOpened}
              icon={props.state.bottomDockOpened ? "layout-bottom-full" : "layout-bottom-partial"}
              onClick={props.state.onBottomDockToggle}
            />
          </div>
        }
      >
        <MobileDockButton state={props.state} />
      </Show>
  </div>
}

function MobileDockButton(props: { state: TitlebarActionsState }) {
  const label = () => (props.state.mobileDockOpened ? "Close dock" : "Open dock")
  return (
    <div class="relative shrink-0">
      <Tooltip placement="bottom" value={label()}>
        <IconButtonV2
          type="button"
          data-action="mobile-dock-launcher"
          variant="ghost-muted"
          size="large"
          class="!size-11 shrink-0"
          state={props.state.mobileDockOpened ? "pressed" : undefined}
          onClick={props.state.onMobileDockToggle}
          aria-label={label()}
          aria-expanded={props.state.mobileDockOpened}
          icon={
            <Icon name={props.state.mobileDockOpened ? "layout-bottom-full" : "layout-bottom-partial"} size="small" />
          }
        />
      </Tooltip>
      <Show when={props.state.mobileDockAttention > 0}>
        <span
          data-component="mobile-dock-attention"
          class="pointer-events-none absolute right-0.5 top-0.5 min-w-4 h-4 px-1 rounded-full bg-accent-primary-base text-10-medium text-white flex items-center justify-center"
          aria-label={`${props.state.mobileDockAttention} dock updates`}
        >
          {Math.min(props.state.mobileDockAttention, 9)}
        </span>
      </Show>
    </div>
  )
}

function HeaderDockButton(props: {
  label: string
  pressed?: boolean
  icon: IconProps["name"]
  iconClass?: string
  onClick: () => void
}) {
  return (
    <Tooltip placement="bottom" value={props.label}>
      <IconButtonV2
        type="button"
        data-mobile-touch-target
        variant="ghost-muted"
        size="large"
        class="!w-9 shrink-0"
        state={props.pressed ? "pressed" : undefined}
        onClick={props.onClick}
        aria-label={props.label}
        aria-expanded={props.pressed}
        icon={<Icon name={props.icon} size="small" class={props.iconClass} />}
      />
    </Tooltip>
  )
}
