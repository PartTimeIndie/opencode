import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useLocation, useNavigate } from "@solidjs/router"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { useTheme } from "@opencode-ai/ui/theme/context"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { KeybindV2 } from "@opencode-ai/ui/v2/keybind-v2"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"

import { getProjectAvatarVariant, LayoutRoute, useLayout, type LocalProject } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { WindowsAppMenu } from "./windows-app-menu"
import { applyPath, backPath, forwardPath } from "./titlebar-history"
import { useServerSync, type ServerSync } from "@/context/server-sync"
import { ProjectAvatar } from "@opencode-ai/ui/v2/project-avatar-v2"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { displayName, getProjectAvatarMonochrome, getProjectAvatarSource, projectForSession } from "@/pages/layout/helpers"
import { useSessionTabAvatarState } from "@/pages/layout/project-avatar-state"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { createMediaQuery } from "@solid-primitives/media"
import {
  loadSessionTabInfo,
  notifySessionTabsRemoved,
  sessionTabDisplayTitle,
  readSessionTabsRemovedDetail,
  SESSION_TABS_REMOVED_EVENT,
} from "@/components/titlebar-session-events"
import { DialogRenameSession } from "@/components/dialog-rename-session"
import { SessionFavoriteButton } from "@/components/session-favorite-button"
import { useSessionRoute } from "@/context/session-route"
import { useGlobal } from "@/context/global"
import { sessionFavoriteFromSession, useSessionFavorites } from "@/context/session-favorites"
import { useSessionAttention } from "@/context/session-attention"
import { decode64 } from "@/utils/base64"
import { ServerConnection, useServer } from "@/context/server"
import {
  sessionTabDockPaneID,
  sessionTabMatchesRemoved,
  tabHref,
  tabKey,
  useTabs,
  type DraftTab,
  type Tab,
} from "@/context/tabs"
import { PluginSlotOutlet } from "@/plugin/slot-outlet"
import { UI_SLOT_IDS } from "@/plugin/ui-slots"
import { showToast } from "@/utils/toast"
import { copyText } from "@/utils/clipboard"
import { MOBILE_DOCK_MEDIA_QUERY } from "@/context/layout-dock"
import { TitlebarActions } from "./titlebar-actions"
import "./titlebar.css"

type TauriDesktopWindow = {
  startDragging?: () => Promise<void>
  toggleMaximize?: () => Promise<void>
}

type TauriThemeWindow = {
  setTheme?: (theme?: "light" | "dark" | null) => Promise<void>
}

type TauriApi = {
  window?: {
    getCurrentWindow?: () => TauriDesktopWindow
  }
  webviewWindow?: {
    getCurrentWebviewWindow?: () => TauriThemeWindow
  }
}

const tauriApi = () => (window as unknown as { __TAURI__?: TauriApi }).__TAURI__
const currentDesktopWindow = () => tauriApi()?.window?.getCurrentWindow?.()
const currentThemeWindow = () => tauriApi()?.webviewWindow?.getCurrentWebviewWindow?.()
const v2TitlebarHeight = 36
const minTitlebarZoom = 0.25
const windowsControlsBaseWidth = 138 // 3 native Windows caption buttons at 46px each.

export type TitlebarUpdate = {
  version: () => string | undefined
  installing: () => boolean
  install: () => void
}

export function useTitlebarRightMount() {
  const [mount, setMount] = createSignal<HTMLElement | null>(null)
  onMount(() => setMount(document.getElementById("opencode-titlebar-right")))
  return mount
}

export function Titlebar(props: { update?: TitlebarUpdate }) {
  const layout = useLayout()
  const platform = usePlatform()
  const command = useCommand()
  const language = useLanguage()
  const theme = useTheme()
  const server = useServer()
  const titlebarTabs = useTabs()
  const sessionFavorites = useSessionFavorites()
  const global = useGlobal()
  const navigate = useNavigate()
  const location = useLocation()
  const params = useSessionRoute()
  const mobile = createMediaQuery(MOBILE_DOCK_MEDIA_QUERY)

  const mac = createMemo(() => platform.platform === "desktop" && platform.os === "macos")
  const windows = createMemo(() => platform.platform === "desktop" && platform.os === "windows")
  const electronWindows = createMemo(() => windows() && !tauriApi())
  const linux = createMemo(() => platform.platform === "desktop" && platform.os === "linux")
  const zoom = () => platform.webviewZoom?.() ?? 1
  const titlebarZoom = () => (windows() ? Math.max(zoom(), minTitlebarZoom) : zoom())
  const minHeight = () => {
    const height = v2TitlebarHeight
    if (mac()) return `${height / zoom()}px`
    if (windows()) return `${height / Math.min(titlebarZoom(), 1)}px`
    return undefined
  }
  const windowsControlsWidth = () => `${windowsControlsBaseWidth / Math.max(titlebarZoom(), 1)}px`

  const [history, setHistory] = createStore({
    stack: [] as string[],
    index: 0,
    action: undefined as "back" | "forward" | undefined,
  })

  const path = () => `${location.pathname}${location.search}${location.hash}`
  const creating = createMemo(() => {
    if (!params.dir) return false
    if (params.id) return false
    const parts = location.pathname.replace(/\/+$/, "").split("/")
    return parts.at(-1) === "session"
  })
  const selectedHomeProject = () => {
    if (layout.route().type !== "home") return
    const selection = layout.home.selection()
    if (!selection.directory) return
    const conn = global.servers.list().find((item) => ServerConnection.key(item) === selection.server)
    if (!conn) return
    const project = global.createServerCtx(conn).projects.list().find((item: LocalProject) => item.worktree === selection.directory)
    if (!project) return
    return { server: ServerConnection.key(conn), directory: project.worktree }
  }
  const newSessionDirectory = () => params.dir ? decode64(params.dir) : selectedHomeProject()?.directory ?? layout.projects.list()[0]?.worktree

  const openNewSession = () => {
    const selected = selectedHomeProject()
    if (selected) {
      titlebarTabs.newDraft({ server: selected.server, directory: selected.directory }, "")
      return
    }
    const directory = newSessionDirectory()
    if (!directory) return
    layout.projects.open(directory)
    titlebarTabs.newDraft({ server: server.key, directory })
  }

  createEffect(() => {
    const current = path()

    untrack(() => {
      const next = applyPath(history, current)
      if (next === history) return
      setHistory(next)
    })
  })

  const updateState = createMemo<TitlebarUpdatePillState>(() => {
    const installing = props.update?.installing() ?? false
    const version = props.update?.version()
    return {
      visible: version !== undefined || installing,
      installing,
      label: "Update",
      ariaLabel: language.t("toast.update.action.installRestart"),
      title: version ? `Update ${version}` : undefined,
      onInstall: () => props.update?.install(),
    }
  })
  const v2RightState = createMemo<TitlebarV2RightState>(() => ({
    update: updateState(),
  }))

  const back = () => {
    const next = backPath(history)
    if (!next) return
    setHistory(next.state)
    navigate(next.to)
  }

  const forward = () => {
    const next = forwardPath(history)
    if (!next) return
    setHistory(next.state)
    navigate(next.to)
  }

  command.register(() => [
    {
      id: "session.new",
      title: language.t("command.session.new"),
      category: language.t("command.category.session"),
      keybind: "mod+t",
      slash: "new",
      disabled: !newSessionDirectory(),
      onSelect: openNewSession,
    },
    {
      id: "tab.new",
      title: language.t("command.session.new"),
      category: "tab",
      hidden: true,
      disabled: !newSessionDirectory(),
      onSelect: openNewSession,
    },
    {
      id: "common.goBack",
      title: language.t("common.goBack"),
      category: language.t("command.category.view"),
      keybind: "mod+[",
      onSelect: back,
    },
    {
      id: "common.goForward",
      title: language.t("common.goForward"),
      category: language.t("command.category.view"),
      keybind: "mod+]",
      onSelect: forward,
    },
  ])

  const getWin = () => {
    if (platform.platform !== "desktop") return
    return currentDesktopWindow()
  }

  createEffect(() => {
    if (platform.platform !== "desktop") return

    const scheme = theme.colorScheme()
    const value = scheme === "system" ? null : scheme

    const win = currentThemeWindow()
    if (!win?.setTheme) return

    void win.setTheme(value).catch(() => undefined)
  })

  const interactive = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return false

    const selector =
      "button, a, input, textarea, select, option, [role='button'], [role='menuitem'], [contenteditable='true'], [contenteditable='']"

    return !!target.closest(selector)
  }

  const drag = (e: MouseEvent) => {
    if (platform.platform !== "desktop") return
    if (e.buttons !== 1) return
    if (interactive(e.target)) return

    const win = getWin()
    if (!win?.startDragging) return

    e.preventDefault()
    void win.startDragging().catch(() => undefined)
  }

  const maximize = (e: MouseEvent) => {
    if (platform.platform !== "desktop") return
    if (interactive(e.target)) return
    if (e.target instanceof Element && e.target.closest("[data-tauri-decorum-tb]")) return

    const win = getWin()
    if (!win?.toggleMaximize) return

    e.preventDefault()
    void win.toggleMaximize().catch(() => undefined)
  }

  return (
    <header
      classList={{
        "shrink-0 relative flex flex-row": true,
        "h-9 bg-v2-background-bg-deep overflow-visible": true,
      }}
      style={{
        "min-height": minHeight(),
        "padding-left": mac() ? `${84 / zoom()}px` : 0,
        width: electronWindows() ? `env(titlebar-area-width, calc(100vw - ${windowsControlsWidth()}))` : undefined,
        "max-width": electronWindows()
          ? `env(titlebar-area-width, calc(100vw - ${windowsControlsWidth()}))`
          : undefined,
        "align-self": electronWindows() ? "flex-start" : undefined,
      }}
      data-tauri-drag-region
      onMouseDown={drag}
      onDblClick={maximize}
    >
      {(() => {
            const serverSync = useServerSync()
            const layout = useLayout()

            const tabs = useTabs()
            const tabsStore = tabs.store
            const tabsStoreActions = tabs

            const matchRoute = (route: LayoutRoute) => {
              if (route.type === "home") return
              if (route.type === "draft") {
                return tabsStore.find((item) => item.type === "draft" && item.draftID === route.draftID)
              }
              if (route.type === "session") {
                const main = tabsStore.find(
                  (item) =>
                    item.type === "session" && item.server === route.server && item.sessionId === route.sessionId,
                )
                if (main) return main
                const sync = serverSync().createDirSyncContext(route.dir)
                const session = sync.session.get(route.sessionId)
                if (session?.parentID) {
                  const parentID = session.parentID
                  const parent = tabsStore.find(
                    (item) => item.type === "session" && item.server === route.server && item.sessionId === parentID,
                  )
                  if (parent) return parent
                }
              }
            }

            const currentTab = () => matchRoute(layout.route())

            createEffect(() => {
              // Selecting a dock tab intentionally normalizes the URL to `/`.
              // During that transition layout.route() can still expose the old
              // session, so remembering it would immediately undo the user's
              // new tab selection.
              if (location.pathname === "/") return
              const route = layout.route()
              if (!tabs.ready()) return
              const tab = currentTab()
              if (tab) {
                tabs.remember(tab)
                return
              }

              if (route.type === "session") {
                const sync = serverSync().createDirSyncContext(route.dir)
                const session = sync.session.get(route.sessionId)
                if (!session) return
                const sessionId = session.parentID ?? session.id
                const next = {
                  server: route.server ?? server.key,
                  dirBase64: route.dirBase64,
                  sessionId,
                }
                const opened = tabsStoreActions.openSessionTab(next, { activate: false })
                if (opened) tabsStoreActions.remember(opened)
              }
            })

            makeEventListener(window, SESSION_TABS_REMOVED_EVENT, (event) => {
              const detail = readSessionTabsRemovedDetail(event)
              if (!detail) return
              const sessionIDs = new Set(detail.sessionIDs)
              tabsStore
                .filter((tab) => sessionTabMatchesRemoved(tab, { ...detail, sessionIDs }))
                .forEach((tab) => {
                  if (tab.type === "session") layout.dock.removeItem(sessionTabDockPaneID(tab))
                })
              detail.sessionIDs.forEach((id) =>
                sessionFavorites.remove({ server: detail.server, directory: detail.directory, id }),
              )
              tabsStoreActions.removeSessions(detail)
            })

            const toggleHome = () => tabs.toggleHome({ home: tabs.home(), current: currentTab() })
            const openHome = () => {
              if (tabs.home()) return
              tabs.toggleHome({ home: false, current: currentTab() })
            }

            command.register("titlebar-home", () => [
              {
                id: "home.open",
                title: language.t("home.title"),
                category: language.t("command.category.view"),
                hidden: true,
                onSelect: openHome,
              },
              {
                id: "home.toggle",
                title: language.t("home.title"),
                category: language.t("command.category.view"),
                keybind: "mod+b",
                hidden: true,
                onSelect: toggleHome,
              },
            ])

            command.register("tabs", () => {
              const current = currentTab()

              return [
                current && {
                  id: "tab.close",
                  category: "tab",
                  title: language.t("command.tab.close"),
                  keybind: "mod+w",
                  hidden: true,
                  onSelect: () => {
                    tabsStoreActions.removeTab(tabsStore.findIndex((tab) => current === tab))
                  },
                },
                {
                  id: `tab.prev`,
                  category: "tab",
                  title: "",
                  keybind: `mod+option+ArrowLeft`,
                  hidden: true,
                  onSelect: () => {
                    let index = tabsStore.findIndex((tab) => tab === currentTab())
                    if (index === -1) return

                    index -= 1
                    if (index === -1) index = tabsStore.length - 1

                    const next = tabsStore[index]
                    if (next) tabs.select(next)
                  },
                },
                {
                  id: `tab.next`,
                  category: "tab",
                  title: "",
                  keybind: `mod+option+ArrowRight`,
                  hidden: true,
                  onSelect: () => {
                    let index = tabsStore.findIndex((tab) => tab === currentTab())
                    if (index === -1) return

                    index += 1
                    if (index === tabsStore.length) index = 0

                    const next = tabsStore[index]
                    if (next) tabs.select(next)
                  },
                },
                ...Array.from({ length: 9 }, (_, i) => {
                  const index = i
                  const number = index + 1
                  return {
                    id: `tab.${number}`,
                    category: "tab",
                    title: "",
                    keybind: `mod+${number}`,
                    disabled: layout.projects.list().length <= index,
                    hidden: true,
                    onSelect: () => {
                      const tab = tabsStore[index]
                      if (tab) tabs.select(tab)
                    },
                  }
                }),
              ].filter((v) => v !== undefined)
            })

            return (
              <div
                class="h-full flex-1 overflow-hidden flex flex-row items-center gap-1.5 pr-3 pt-2"
                classList={{
                  "pl-2": mac(),
                  "pl-4": !mac(),
                }}
              >
                <ChannelIndicator />
                <Show when={windows() || linux()}>
                  <WindowsAppMenu command={command} platform={platform} variant="v2" />
                </Show>
                <TooltipV2
                  placement="bottom"
                  value={
                    mobile() ? (
                      language.t("command.session.new")
                    ) : (
                      <>
                        {language.t("home.title")}
                        <KeybindV2 keys={command.keybindParts("home.toggle")} variant="neutral" />
                      </>
                    )
                  }
                  class="shrink-0"
                >
                  <IconButtonV2
                    type="button"
                    data-mobile-touch-target
                    data-action={mobile() ? "session-new" : "home-toggle"}
                    variant="ghost-muted"
                    size="large"
                    class="!w-9 shrink-0"
                    icon={<IconV2 name={mobile() ? "plus" : "grid-plus"} />}
                    state={!mobile() && tabs.home() ? "pressed" : undefined}
                    disabled={mobile() && !newSessionDirectory()}
                    onClick={() => (mobile() ? openNewSession() : toggleHome())}
                    aria-label={language.t(mobile() ? "command.session.new" : "home.title")}
                    aria-pressed={mobile() ? undefined : tabs.home()}
                  />
                </TooltipV2>

                <div class="flex-1" />
                <TitlebarV2Right state={v2RightState()} />
                <Show when={windows() && !electronWindows()}>
                  <div data-tauri-decorum-tb class="flex flex-row" />
                </Show>
              </div>
            )
        })()}
    </header>
  )
}

export function BottomSessionTabs() {
  const settings = useSettings()
  const layout = useLayout()
  const platform = usePlatform()
  const language = useLanguage()
  const params = useSessionRoute()
  const location = useLocation()
  const navigate = useNavigate()
  const server = useServer()
  const serverSync = useServerSync()
  const tabs = useTabs()
  const tabsStore = tabs.store
  const creating = createMemo(() => {
    if (!params.dir) return false
    if (params.id) return false
    return location.pathname.replace(/\/+$/, "").split("/").at(-1) === "session"
  })
  const openNewSession = () => {
    const directory = params.dir ? decode64(params.dir) : layout.projects.list()[0]?.worktree
    if (!directory) return
    tabs.newDraft({ server: server.key, directory })
  }
  const matchRoute = (route: LayoutRoute) => {
    if (route.type === "home") return
    if (route.type === "draft") return tabsStore.find((item) => item.type === "draft" && item.draftID === route.draftID)
    if (route.type !== "session") return

    const main = tabsStore.find(
      (item) => item.type === "session" && item.server === route.server && item.sessionId === route.sessionId,
    )
    if (main) return main

    const sync = serverSync().createDirSyncContext(route.dir)
    const session = sync.session.get(route.sessionId)
    if (!session?.parentID) return

    return tabsStore.find(
      (item) => item.type === "session" && item.server === route.server && item.sessionId === session.parentID,
    )
  }
  const currentTab = () => matchRoute(layout.route())
  const visible = createMemo(() => platform.platform === "desktop" && (tabsStore.length > 0 || (creating() && params.dir)))
  const [tabsScrollState, setTabsScrollState] = createSignal({ overflowing: false, canScrollLeft: false, canScrollRight: false })
  const [draggingTabKey, setDraggingTabKey] = createSignal<string>()
  const [dropTabKey, setDropTabKey] = createSignal<string>()
  let tabScrollRef: HTMLDivElement | undefined
  let tabsScrollFrame: number | undefined

  const tabDragProps = (tab: Tab) => {
    const key = tabKey(tab)
    return {
      dragging: () => draggingTabKey() === key,
      dropping: () => dropTabKey() === key && draggingTabKey() !== key,
      onDragStart: (event: DragEvent) => {
        if (event.target instanceof Element && event.target.closest("button, [data-action='session-tab-menu']")) {
          event.preventDefault()
          return
        }
        setDraggingTabKey(key)
        event.dataTransfer?.setData("application/x-opencode-session-tab", key)
        event.dataTransfer?.setData("text/plain", key)
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"
      },
      onDragOver: (event: DragEvent) => {
        if (!draggingTabKey() || draggingTabKey() === key) return
        event.preventDefault()
        setDropTabKey(key)
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
      },
      onDragLeave: () => {
        if (dropTabKey() === key) setDropTabKey(undefined)
      },
      onDrop: (event: DragEvent) => {
        const from = event.dataTransfer?.getData("application/x-opencode-session-tab") || draggingTabKey()
        if (!from || from === key) return
        event.preventDefault()
        tabs.moveTab(from, key)
        setDraggingTabKey(undefined)
        setDropTabKey(undefined)
        refreshTabsScrollState()
      },
      onDragEnd: () => {
        setDraggingTabKey(undefined)
        setDropTabKey(undefined)
      },
    }
  }

  function refreshTabsScrollState() {
    if (tabsScrollFrame !== undefined) return
    tabsScrollFrame = requestAnimationFrame(() => {
      tabsScrollFrame = undefined
      commitTabsScrollState()
    })
  }

  function commitTabsScrollState() {
    if (!tabScrollRef) return
    const maxScrollLeft = tabScrollRef.scrollWidth - tabScrollRef.clientWidth
    const next = {
      overflowing: maxScrollLeft > 1,
      canScrollLeft: tabScrollRef.scrollLeft > 1,
      canScrollRight: tabScrollRef.scrollLeft < maxScrollLeft - 1,
    }
    setTabsScrollState((current) =>
      current.overflowing === next.overflowing &&
      current.canScrollLeft === next.canScrollLeft &&
      current.canScrollRight === next.canScrollRight
        ? current
        : next,
    )
  }

  onCleanup(() => {
    if (tabsScrollFrame !== undefined) cancelAnimationFrame(tabsScrollFrame)
  })

  const scrollTabs = (direction: -1 | 1) => {
    if (!tabScrollRef) return
    tabScrollRef.scrollBy({ left: direction * Math.max(tabScrollRef.clientWidth * 0.75, 160), behavior: "smooth" })
  }

  const onTabsWheel = (event: WheelEvent) => {
    if (!tabScrollRef) return
    if (!tabsScrollState().overflowing) return
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
    if (delta === 0) return
    event.preventDefault()
    tabScrollRef.scrollBy({ left: delta })
  }

  return (
    <Show when={visible()}>
      <nav
        data-component="bottom-session-tabs"
        aria-label="Session tabs"
        class="relative z-20 h-10 shrink-0 border-t border-border-weaker-base bg-v2-background-bg-deep px-2 py-1 flex min-w-0 flex-row items-center gap-1.5"
      >
        <div class="relative min-w-0 flex-1">
          <Show when={tabsScrollState().overflowing}>
            <IconButtonV2
              type="button"
              variant="ghost-muted"
              size="small"
              class="absolute left-0 top-1/2 z-20 -translate-y-1/2 bg-v2-background-bg-deep/90 shadow-sm disabled:opacity-0"
              icon={<IconV2 name="chevron-left" />}
              disabled={!tabsScrollState().canScrollLeft}
              onClick={() => scrollTabs(-1)}
              aria-label="Scroll tabs left"
            />
          </Show>
          <div
            data-slot="bottom-session-tabs-scroll"
            class="flex min-w-0 flex-row items-center gap-1.5 overflow-x-auto no-scrollbar [app-region:no-drag]"
            ref={(el) => {
              tabScrollRef = el
              createResizeObserver(el, refreshTabsScrollState)
            }}
            onScroll={refreshTabsScrollState}
            onWheel={onTabsWheel}
          >
            <div
              class="flex min-w-0 flex-row items-center gap-1.5"
              ref={(el) => createResizeObserver(el, refreshTabsScrollState)}
            >
              <For each={tabsStore}>
                {(tab, i) => {
                  let ref!: HTMLDivElement
                  const divider = () =>
                    i() !== 0 && (
                      <div class="w-[1.5px] h-3 shrink-0 rounded-full bg-[var(--v2-background-bg-layer-02)]" />
                    )

                  if (tab.type === "draft") {
                    return (
                      <>
                        {divider()}
                        <DraftTabItem
                          ref={ref}
                          href={tabHref(tab)}
                          title={language.t("command.session.new")}
                          active={currentTab() === tab}
                          drag={tabDragProps(tab)}
                          onNavigate={() => {
                            tabs.select(tab)
                            ref.scrollIntoView({ behavior: "instant", inline: "nearest" })
                          }}
                          onClose={() => tabs.removeTab(i())}
                        />
                      </>
                    )
                  }

                  return (
                    <>
                      {divider()}
                      <TabNavItem
                        ref={ref}
                        href={tabHref(tab)}
                        server={tab.server}
                        directory={decode64(tab.dirBase64)!}
                        sessionId={tab.sessionId}
                        onNavigate={() => {
                          tabs.select(tab)
                          ref.scrollIntoView({ behavior: "instant", inline: "nearest" })
                        }}
                        onClose={() => tabs.removeTab(i())}
                        active={currentTab() === tab}
                        activeServer={tab.server === server.key}
                        forceTruncate={tabsScrollState().overflowing}
                        drag={tabDragProps(tab)}
                      />
                    </>
                  )
                }}
              </For>
              <Show when={creating() && params.dir}>
                {(_) => {
                  let ref!: HTMLDivElement

                  onMount(() => {
                    ref.scrollIntoView({ behavior: "instant", inline: "nearest" })
                  })

                  return (
                    <>
                      <div class="w-[1.5px] h-3 shrink-0 rounded-full bg-[var(--v2-background-bg-layer-02)]" />
                      <NewSessionTabItem
                        ref={ref}
                        href={`/${params.dir}/session`}
                        title={language.t("command.session.new")}
                        onClose={() => {
                          const tab = tabsStore.at(-1)
                          if (tab) tabs.select(tab)
                          else navigate("/")
                        }}
                      />
                    </>
                  )
                }}
              </Show>
            </div>
          </div>
          <div
            data-slot="bottom-session-tabs-fade-left"
            aria-hidden="true"
            class="pointer-events-none absolute inset-y-0 left-0 z-10 w-8 bg-[linear-gradient(to_right,var(--v2-background-bg-deep),transparent)]"
            classList={{ hidden: !tabsScrollState().canScrollLeft }}
          />
          <div
            data-slot="bottom-session-tabs-fade-right"
            aria-hidden="true"
            class="pointer-events-none absolute inset-y-0 right-0 z-10 w-8 bg-[linear-gradient(to_left,var(--v2-background-bg-deep),transparent)]"
            classList={{ hidden: !tabsScrollState().canScrollRight }}
          />
          <Show when={tabsScrollState().overflowing}>
            <IconButtonV2
              type="button"
              variant="ghost-muted"
              size="small"
              class="absolute right-0 top-1/2 z-20 -translate-y-1/2 bg-v2-background-bg-deep/90 shadow-sm disabled:opacity-0"
              icon={<IconV2 name="chevron-right" />}
              disabled={!tabsScrollState().canScrollRight}
              onClick={() => scrollTabs(1)}
              aria-label="Scroll tabs right"
            />
          </Show>
        </div>
        <Show when={!(creating() && params.dir)}>
          <IconButtonV2
            type="button"
            data-mobile-touch-target
            variant="ghost-muted"
            size="large"
            class="shrink-0"
            icon={<IconV2 name="plus" />}
            onClick={openNewSession}
            aria-label={language.t("command.session.new")}
          />
        </Show>
      </nav>
    </Show>
  )
}

type TitlebarUpdatePillState = {
  visible: boolean
  installing: boolean
  label: string
  ariaLabel: string
  title?: string
  onInstall: () => void
}

type TitlebarV2RightState = {
  update: TitlebarUpdatePillState
}

function TitlebarV2Right(props: { state: TitlebarV2RightState }) {
  return (
    <div class="relative z-20 flex shrink-0 items-center justify-end gap-0 overflow-visible">
      <Show when={props.state.update.visible}>
        <TitlebarUpdateIconButton state={props.state.update} />
      </Show>
      <div id="opencode-titlebar-right" class="flex shrink-0 items-center justify-end gap-0" />
      <TitlebarActions />
    </div>
  )
}

function TitlebarUpdateIconButton(props: { state: TitlebarUpdatePillState }) {
  return (
    <div class="relative isolate mr-3 size-5 shrink-0">
      <button
        type="button"
        class="group absolute right-0 top-0 z-10 flex h-5 w-5 items-center justify-end overflow-hidden rounded-full bg-v2-icon-icon-accent/20 text-v2-icon-icon-accent transition-[width,background-color] duration-150 ease-out hover:z-30 hover:w-[68px] hover:bg-[color-mix(in_srgb,var(--v2-icon-icon-accent)_20%,var(--v2-background-bg-deep))] focus-visible:z-30 focus-visible:w-[68px] focus-visible:bg-[color-mix(in_srgb,var(--v2-icon-icon-accent)_20%,var(--v2-background-bg-deep))] focus-visible:outline-none disabled:opacity-60 motion-reduce:transition-none"
        onClick={props.state.onInstall}
        disabled={props.state.installing}
        aria-busy={props.state.installing}
        aria-label={props.state.ariaLabel}
      >
        <span class="shrink-0 ml-[8px] mr-px text-[11px] text-v2-text-text-accent [font-weight:530] opacity-0 translate-x-2 motion-safe:transition-all duration-150 ease-out group-hover:opacity-100 group-hover:translate-x-0 group-focus-visible:opacity-100 group-focus-visible:translate-x-0 motion-reduce:translate-x-0">
          Update
        </span>
        <span class="flex size-5 shrink-0 items-center justify-center">
          <Show
            when={!props.state.installing}
            fallback={<span data-slot="titlebar-update-loader" aria-hidden="true" />}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M7 11V3M3.5 7.63128L7 11L10.5 7.63128" stroke="currentColor" />
            </svg>
          </Show>
        </span>
      </button>
    </div>
  )
}

type TabDragProps = {
  dragging: () => boolean
  dropping: () => boolean
  onDragStart: (event: DragEvent) => void
  onDragOver: (event: DragEvent) => void
  onDragLeave: () => void
  onDrop: (event: DragEvent) => void
  onDragEnd: () => void
}

function TabNavItem(props: {
  ref?: HTMLDivElement
  href: string
  server: ServerConnection.Key
  directory: string
  sessionId: string
  hideClose?: boolean
  onClose: () => void
  onNavigate: () => void
  active?: boolean
  activeServer: boolean
  forceTruncate?: boolean
  drag: TabDragProps
}) {
  const closeTab = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    props.onClose()
  }
  const global = useGlobal()
  const language = useLanguage()
  const dialog = useDialog()
  const sessionFavorites = useSessionFavorites()
  const attention = useSessionAttention()
  const important = () => props.activeServer && attention.enabled() &&
    attention.current({ directory: props.directory, sessionID: props.sessionId })?.enabled
  const unseen = () => props.activeServer && attention.enabled() &&
    attention.current({ directory: props.directory, sessionID: props.sessionId })?.count
  const [menuOpen, setMenuOpen] = createSignal(false)
  const serverCtx = createMemo(() => {
    const conn = global.servers.list().find((item) => ServerConnection.key(item) === props.server)
    if (conn) return global.createServerCtx(conn)
  })
  const cachedSession = createMemo(() =>
    serverCtx()
      ?.sync.existing(props.directory)?.[0]
      .session.find((item: Session) => item.id === props.sessionId),
  )

  const [session] = createResource(
    () => {
      if (!serverCtx()?.sync || !props.sessionId) return
      return [props.sessionId] as const
    },
    async ([sessionId]) => {
      const sync = serverCtx()?.sync
      if (!sync) return
      // Restored inactive tabs need only their lightweight session metadata. Do not
      // create a directory sync context here: that is the active-session hydration
      // boundary and would bootstrap every restored directory during app startup.
      await loadSessionTabInfo({
        server: props.server,
        directory: props.directory,
        sessionID: sessionId,
        load: () => sync.session.info(props.directory, sessionId),
      })
      return sync.existing(props.directory)?.[0].session.find((item) => item.id === sessionId)
    },
    { initialValue: props.sessionId ? cachedSession() : undefined },
  )
  const favoriteInput = createMemo(() => {
    const value = session.latest ?? cachedSession()
    if (value) return sessionFavoriteFromSession({ server: props.server, directory: props.directory, session: value })
    return { server: props.server, directory: props.directory, id: props.sessionId }
  })
  const visibleSession = createMemo(() => session.latest ?? cachedSession())
  const favorite = createMemo(() => {
    const input = favoriteInput()
    return input ? sessionFavorites.is(input) : false
  })
  const toggleFavorite = () => {
    const input = favoriteInput()
    if (!input) return
    sessionFavorites.set(input, !favorite())
  }
  const updateLocalSession = (sessionId: string, update: (session: Session) => void) => {
    serverCtx()?.sync.child(props.directory, { bootstrap: false })[1](
      "session",
      produce<Session[]>((draft) => {
        const current = draft.find((item) => item.id === sessionId)
        if (current) update(current)
      }),
    )
  }
  const renameSession = () => {
    const current = session.latest
    if (!current) return
    const ctx = serverCtx()
    if (!ctx) return
    const picked = favorite()
    dialog.show(() => (
      <DialogRenameSession
        initialTitle={current.title || current.slug || current.id}
        onRename={async (title) => {
          await ctx.sdk
            .createDirSdkContext(props.directory)
            .client.session.update({ sessionID: current.id, title })
          updateLocalSession(current.id, (session) => {
            session.title = title
          })
          sessionFavorites.set(
            sessionFavoriteFromSession({
              server: props.server,
              directory: props.directory,
              session: { ...current, title },
            }),
            picked,
          )
        }}
      />
    ))
  }
  const archiveSession = async () => {
    const current = session.latest
    if (!current) return
    const ctx = serverCtx()
    if (!ctx) return
    await ctx.sdk.createDirSdkContext(props.directory).client.session.update({
      sessionID: current.id,
      time: { archived: Date.now() },
    })
    serverCtx()?.sync.child(props.directory, { bootstrap: false })[1](
      "session",
      produce<Session[]>((draft) => {
        const index = draft.findIndex((item) => item.id === current.id)
        if (index !== -1) draft.splice(index, 1)
      }),
    )
    sessionFavorites.remove(sessionFavoriteFromSession({ server: props.server, directory: props.directory, session: current }))
    notifySessionTabsRemoved({ server: props.server, directory: props.directory, sessionIDs: [current.id] })
  }
  const deleteSession = async () => {
    const current = session.latest
    if (!current) return
    const ctx = serverCtx()
    if (!ctx) return
    if (!window.confirm(`${language.t("common.delete")} ${current.title || current.slug || current.id}?`)) return
    const protectedState = current.protected === true || favorite()
    if (
      protectedState &&
      !window.confirm(
        language.t("session.delete.protectedConfirm", {
          name: current.title || current.slug || current.id,
        }),
      )
    )
      return
    await ctx.sdk.createDirSdkContext(props.directory).client.session.delete({
      sessionID: current.id,
      overrideProtection: protectedState ? "true" : undefined,
    })
    serverCtx()?.sync.child(props.directory, { bootstrap: false })[1](
      "session",
      produce<Session[]>((draft) => {
        const removed = new Set<string>([current.id])
        let changed = true
        while (changed) {
          changed = false
          for (const item of draft) {
            if (item.parentID && removed.has(item.parentID) && !removed.has(item.id)) {
              removed.add(item.id)
              changed = true
            }
          }
        }
        for (let i = draft.length - 1; i >= 0; i--) {
          if (removed.has(draft[i].id)) draft.splice(i, 1)
        }
      }),
    )
    sessionFavorites.remove(sessionFavoriteFromSession({ server: props.server, directory: props.directory, session: current }))
    notifySessionTabsRemoved({ server: props.server, directory: props.directory, sessionIDs: [current.id] })
  }

  return (
    <div
      ref={props.ref}
      draggable
      class="group relative flex h-7 min-w-40 max-w-60 flex-row items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-[6px] bg-[var(--tab-bg)] pl-1.5 pr-22 [--tab-bg:var(--v2-background-bg-deep)] hover:[--tab-bg:var(--v2-background-bg-layer-02)] data-[active='true']:[--tab-bg:var(--v2-overlay-simple-overlay-pressed)] data-[active='true']:shadow-[inset_0_0_0_0.5px_var(--v2-border-border-muted)] data-[dragging='true']:opacity-50 data-[drop-target='true']:ring-1 data-[drop-target='true']:ring-[var(--v2-border-border-focus)] focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--v2-border-border-focus)]"
      data-active={props.active}
      data-session-id={props.sessionId}
      data-dragging={props.drag.dragging()}
      data-drop-target={props.drag.dropping()}
      onMouseDown={(event) => {
        if (event.button !== 1) return
        closeTab(event)
      }}
      onDragStart={props.drag.onDragStart}
      onDragOver={props.drag.onDragOver}
      onDragLeave={props.drag.onDragLeave}
      onDrop={props.drag.onDrop}
      onDragEnd={props.drag.onDragEnd}
    >
      <Show
        when={visibleSession()}
        fallback={
          <a
            href={props.href}
            onClick={(event) => {
              event.preventDefault()
              props.onNavigate()
            }}
            class="flex h-full min-w-0 flex-1 flex-row items-center gap-1.5 text-[13px] font-medium text-v2-text-text-faint group-data-[active='true']:text-v2-text-text-base"
          >
            <span data-slot="project-avatar-slot">
              <ProjectTabAvatar
                directory={props.directory}
                sessionId={props.sessionId}
                activeServer={props.activeServer}
                active={props.active}
                sync={() => serverCtx()?.sync}
              />
            </span>
            <span class="min-w-0 flex-1">{displayName({ worktree: props.directory })}</span>
            <Show when={important()}><span aria-label={language.t(unseen() ? "session.attention.unseen" : "session.attention.marked")} classList={{ "text-text-warning-base font-bold": !!unseen() }}>✦</span></Show>
          </a>
        }
      >
        {(session) => {
          const project = createMemo<LocalProject | undefined>(() =>
            projectForSession<LocalProject>(session(), serverCtx()?.projects.list() ?? []),
          )

          return (
            <a
              href={props.href}
              onClick={(event) => {
                event.preventDefault()
                props.onNavigate()
              }}
              class="flex h-full min-w-0 flex-1 flex-row items-center gap-1.5 text-[13px] font-medium text-v2-text-text-faint group-data-[active='true']:text-v2-text-text-base"
            >
              <span data-slot="project-avatar-slot">
                <ProjectTabAvatar
                  project={project()}
                  directory={session().directory}
                  sessionId={session().id}
                  activeServer={props.activeServer}
                  active={props.active}
                  sync={() => serverCtx()?.sync}
                />
              </span>
              <span class="min-w-0 flex-1">{sessionTabDisplayTitle(session())}</span>
              <Show when={important()}><span aria-label={language.t(unseen() ? "session.attention.unseen" : "session.attention.marked")} classList={{ "text-text-warning-base font-bold": !!unseen() }}>✦</span></Show>
            </a>
          )
        }}
      </Show>

      <div
        class="absolute right-0 inset-y-0 flex w-22 flex-row items-center gap-0.5 py-1 pl-2 pr-1 group-data-[active=true]:bg-[var(--tab-bg)]"
        data-truncate={props.forceTruncate}
        data-menu={menuOpen()}
      >
        <div
          class="absolute inset-0 rounded-r-[6px] bg-(image:--inactive-bg) group-hover:bg-(image:--active-bg) group-data-[active=true]:bg-(image:--active-bg)"
          style={{
            "--inactive-bg": "linear-gradient(to right, transparent 0%, var(--tab-bg) 80%)",
            "--active-bg": "linear-gradient(90deg, transparent 0%, var(--tab-bg) 25%)",
          }}
        />
        <SessionFavoriteButton
          picked={favorite()}
          disabled={!favoriteInput()}
          label={favorite() ? language.t("command.session.favorite.remove") : language.t("command.session.favorite.add")}
          onToggle={toggleFavorite}
        />
        <MenuV2 gutter={4} modal={false} placement="bottom-end" open={menuOpen()} onOpenChange={setMenuOpen}>
          <MenuV2.Trigger
            as={IconButtonV2}
            size="small"
            variant="ghost-muted"
            class="opacity-0 group-hover:opacity-100 group-data-[active='true']:opacity-100 data-[expanded]:opacity-100 z-10"
            data-action="session-tab-menu"
            data-session-id={props.sessionId}
            icon={<IconV2 name="outline-dots" />}
            aria-label={language.t("common.moreOptions")}
            onPointerDown={(event: PointerEvent) => {
              event.stopPropagation()
            }}
            onMouseDown={(event: MouseEvent) => {
              event.preventDefault()
              event.stopPropagation()
            }}
            onClick={(event: MouseEvent) => {
              event.stopPropagation()
            }}
          />
          <MenuV2.Portal>
            <MenuV2.Content>
              <MenuV2.Item
                disabled={!session.latest}
                onSelect={() => {
                  renameSession()
                  setMenuOpen(false)
                }}
              >
                {language.t("common.rename")}
              </MenuV2.Item>
              <MenuV2.Item
                disabled={!favoriteInput()}
                onSelect={() => {
                  toggleFavorite()
                  setMenuOpen(false)
                }}
              >
                {favorite() ? language.t("command.session.favorite.remove") : language.t("command.session.favorite.add")}
              </MenuV2.Item>
              <MenuV2.Item
                onSelect={() => {
                  void copyText(props.sessionId).then(
                    () =>
                      showToast({
                        variant: "success",
                        title: language.t("session.share.copy.copied"),
                        description: props.sessionId,
                      }),
                    () => showToast({ variant: "error", title: language.t("toast.session.share.copyFailed.title") }),
                  )
                  setMenuOpen(false)
                }}
              >
                {language.t("common.copySessionId")}
              </MenuV2.Item>
              <MenuV2.Separator />
              <MenuV2.Item
                disabled={!session.latest}
                onSelect={() => {
                  void archiveSession()
                  setMenuOpen(false)
                }}
              >
                {language.t("common.archive")}
              </MenuV2.Item>
              <MenuV2.Item
                disabled={!session.latest}
                onSelect={() => {
                  void deleteSession()
                  setMenuOpen(false)
                }}
              >
                {language.t("common.delete")}
              </MenuV2.Item>
              <PluginSlotOutlet slot={UI_SLOT_IDS.sessionTabMenu} class="contents" target={props.sessionId ? { directory: props.directory, sessionID: props.sessionId } : undefined} />
            </MenuV2.Content>
          </MenuV2.Portal>
        </MenuV2>
        <IconButtonV2
          size="small"
          variant="ghost-muted"
          class="opacity-0 group-hover:opacity-100 group-data-[active='true']:opacity-100 z-10"
          onClick={closeTab}
          icon={<IconV2 name="xmark-small" />}
          aria-label={language.t("command.tab.close")}
        />
      </div>
    </div>
  )
}

function ProjectTabAvatar(props: {
  project?: LocalProject
  directory: string
  sessionId: string
  activeServer: boolean
  active?: boolean
  sync?: () => ServerSync | undefined
}) {
  const directory = () => props.directory
  const sessionId = () => props.sessionId
  const activeServer = () => props.activeServer
  const state = useSessionTabAvatarState(
    directory,
    sessionId,
    () => activeServer() && !!props.active,
    props.sync,
    activeServer,
  )
  return (
    <ProjectAvatar
      fallback={displayName(props.project ?? { worktree: props.directory })}
      src={getProjectAvatarSource(props.project?.id, props.project?.icon)}
      monochrome={getProjectAvatarMonochrome(props.project?.id, props.project?.icon)}
      variant={getProjectAvatarVariant(props.project?.icon?.color)}
      unread={state.unread()}
      loading={state.loading()}
      status={state.status()}
    />
  )
}

function DraftTabItem(props: {
  ref?: HTMLDivElement
  href: string
  title: string
  active?: boolean
  drag: TabDragProps
  onNavigate: () => void
  onClose: () => void
}) {
  const closeTab = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    props.onClose()
  }
  return (
    <div
      ref={props.ref}
      draggable
      data-active={props.active}
      data-dragging={props.drag.dragging()}
      data-drop-target={props.drag.dropping()}
      class="group relative shrink-0 flex h-7 max-w-60 flex-row items-center gap-1.5 overflow-hidden rounded-[6px] bg-[var(--tab-bg)] pl-1.5 pr-8 whitespace-nowrap [--tab-bg:var(--v2-background-bg-deep)] hover:[--tab-bg:var(--v2-background-bg-layer-02)] data-[active='true']:[--tab-bg:var(--v2-overlay-simple-overlay-pressed)] data-[dragging='true']:opacity-50 data-[drop-target='true']:ring-1 data-[drop-target='true']:ring-[var(--v2-border-border-focus)] focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--v2-border-border-focus)]"
      onMouseDown={(event) => {
        if (event.button !== 1) return
        closeTab(event)
      }}
      onDragStart={props.drag.onDragStart}
      onDragOver={props.drag.onDragOver}
      onDragLeave={props.drag.onDragLeave}
      onDrop={props.drag.onDrop}
      onDragEnd={props.drag.onDragEnd}
    >
      <a
        href={props.href}
        onClick={(event) => {
          event.preventDefault()
          props.onNavigate()
        }}
        class="flex h-full min-w-0 flex-1 flex-row items-center gap-1.5 overflow-hidden text-[13px] font-medium leading-5 text-v2-text-text-faint group-data-[active='true']:text-[var(--v2-text-text-base)]"
      >
        <span class="flex size-4 shrink-0 rotate-90 items-center justify-center">
          <IconV2 name="edit" />
        </span>
        <span class="truncate leading-5">{props.title}</span>
      </a>
      <div class="absolute right-0 inset-y-0 flex w-7 items-center justify-center">
        <IconButtonV2
          size="small"
          variant="ghost-muted"
          onMouseDown={(event) => {
            event.preventDefault()
            event.stopPropagation()
          }}
          onClick={closeTab}
          icon={<IconV2 name="xmark-small" />}
          aria-label="Close tab"
        />
      </div>
    </div>
  )
}

function NewSessionTabItem(props: { ref?: HTMLDivElement; href: string; title: string; onClose: () => void }) {
  const closeTab = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    props.onClose()
  }
  return (
    <div
      ref={props.ref}
      class="group relative shrink-0 flex h-7 max-w-60 flex-row items-center gap-1.5 overflow-hidden rounded-[6px] bg-[var(--v2-overlay-simple-overlay-pressed)] pl-1.5 pr-8 whitespace-nowrap focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--v2-border-border-focus)]"
      onMouseDown={(event) => {
        if (event.button !== 1) return
        closeTab(event)
      }}
    >
      <a
        href={props.href}
        aria-current="page"
        class="flex h-full min-w-0 flex-1 flex-row items-center gap-1.5 overflow-hidden text-[13px] font-medium leading-5 text-[var(--v2-text-text-base)]"
      >
        <span class="flex size-4 shrink-0 rotate-90 items-center justify-center">
          <IconV2 name="edit" />
        </span>
        <span class="truncate leading-5">{props.title}</span>
      </a>
      <div class="absolute right-0 inset-y-0 flex w-7 items-center justify-center">
        <IconButtonV2
          size="small"
          variant="ghost-muted"
          onMouseDown={(event) => {
            event.preventDefault()
            event.stopPropagation()
          }}
          onClick={closeTab}
          icon={<IconV2 name="xmark-small" />}
          aria-label="Close tab"
        />
      </div>
    </div>
  )
}

function ChannelIndicator() {
  return (
    <>
      {["beta", "dev"].includes(import.meta.env.VITE_OPENCODE_CHANNEL) && (
        <div class="bg-icon-interactive-base text-[#FFF] font-medium px-2 rounded-sm uppercase font-mono">
          {import.meta.env.VITE_OPENCODE_CHANNEL.toUpperCase()}
        </div>
      )}
    </>
  )
}
