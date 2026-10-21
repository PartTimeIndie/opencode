import { createMediaQuery } from "@solid-primitives/media"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { Tabs } from "@opencode-ai/ui/tabs"
import { Icon, type IconProps } from "@opencode-ai/ui/icon"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { DIALOG_OPEN_EVENT, useDialog } from "@opencode-ai/ui/context/dialog"
import { useSearchParams } from "@solidjs/router"
import {
  DOCK_AREAS,
  MOBILE_BROWSER_DOCK_MIN_SIZE,
  MOBILE_DOCK_COLLAPSE_THRESHOLD,
  MOBILE_DOCK_MEDIA_QUERY,
  MOBILE_DOCK_MIN_SIZE,
  dockItemIsRendered,
  mobileDockMaxSize,
  resolveDockActiveTab,
  shouldCloseMobileDockForKeyboard,
  shouldSyncDockActiveTab,
} from "@/context/layout-dock"
import { pinnedControlPanelPaneId } from "@/context/control-panel-key"
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
  untrack,
  type JSX,
} from "solid-js"
import { Portal } from "solid-js/web"
import { useLanguage } from "@/context/language"
import { getProjectAvatarVariant, useLayout, type LocalProject, type StoredControlPanel } from "@/context/layout"
import { ServerConnection, useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync, type ServerSync } from "@/context/server-sync"
import { useNotification } from "@/context/notification"
import { useGlobal } from "@/context/global"
import { sessionFavoriteFromSession, useSessionFavorites, type SessionFavorite } from "@/context/session-favorites"
import { loadSessionTabInfo, notifySessionTabsRemoved } from "@/components/titlebar-session-events"
import { DialogRenameSession } from "@/components/dialog-rename-session"
import { SessionFavoriteButton } from "@/components/session-favorite-button"
import { tabKey, useTabs, type Tab } from "@/context/tabs"
import { useDockStateActions } from "@/context/dock-state"
import { useAppPluginRuntime, type DockArea } from "@/plugin/app-runtime"
import { PluginDockMount } from "@/plugin/dock-mount"
import { PluginSlotOutlet } from "@/plugin/slot-outlet"
import { UI_SLOT_IDS } from "@/plugin/ui-slots"
import { ExtensionManagerDockPane } from "@/components/extension-manager"
import { createSizing } from "@/pages/session/helpers"
import { useSessionLayout } from "@/pages/session/session-layout"
import { SessionBrowserDock } from "@/pages/session/composer/session-browser-dock"
import { SessionControlPanelPane, type ControlPanelPaneInfo } from "@/pages/session/composer/session-control-panel-pane"
import { SessionControlPanelPopup } from "@/pages/session/composer/session-control-panel-popup"
import { SessionQuestionDock } from "@/pages/session/composer/session-question-dock"
import { SessionSurfaceProviders } from "@/pages/session/composer/session-surface-providers"
import { shouldDockControlPanel } from "@/utils/control-panel-presentation"
import { surfaceContainsAgentHandoff } from "@/components/control-surface-runtime"
import { controlPanelPaneId, questionDockPaneId, sessionTreeIDs } from "@/pages/session/composer/session-request-tree"
import { useDockContent } from "@/pages/session/dock-content-registry"
import { UsageDashboard } from "@/pages/session/usage-dashboard"
import {
  displayName,
  getProjectAvatarMonochrome,
  getProjectAvatarSource,
  projectForSession,
} from "@/pages/layout/helpers"
import { useSessionTabAvatarState } from "@/pages/layout/project-avatar-state"
import { sessionTitle } from "@/utils/session-title"
import { handoffRequestKey } from "@/utils/handoff-request"
import { decode64 } from "@/utils/base64"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { ProjectAvatar } from "@opencode-ai/ui/v2/project-avatar-v2"
import { canDockInArea, filterDockAddItems, type DockAddMenuItemBase } from "./dock-add-filter"
import { sanitizeCustomPart, type CustomPart } from "@/plugin/custom-part"
import type { Part, SurfaceBlockingRequest, SurfaceControlRequest, SurfacePersistentTool } from "@opencode-ai/sdk/v2/client"
import { produce } from "solid-js/store"
import { focusDockPromptInputForSession } from "@/utils/focus"
import { showToast } from "@/utils/toast"
import { copyText } from "@/utils/clipboard"
import { LayoutRegions } from "@/components/surface/layout-regions"
import { visualViewportBounds } from "@/utils/visual-viewport"
import {
  isStaleRetainedHandoffRequest,
  matchesRetainedHandoffRequest,
  retainedHandoffRequest,
  resolveActiveSessionScan,
  shouldKeepRetainedHandoffPanel,
  updateVisiblePanelCache,
} from "./active-session-scan"

type IconName = IconProps["name"]

type DockPane = DockAddMenuItemBase & {
  id: string
  title: string
  icon: IconName
  leading?: () => JSX.Element
  category: string
  defaultArea: DockArea
  source: "host" | "plugin"
  sessionId?: string
  favorite?: SessionFavorite
  mount: (ctx: { area: DockArea; visible: boolean }) => JSX.Element
  // Keep the pane mounted across tab switches (hidden via CSS instead of
  // unmounted) so stateful content like the Browser webview does not reload.
  keepAlive?: boolean | (() => boolean)
  onActivate?: () => void
  onClose?: () => void | Promise<void>
}

type DockAddMenuItem = DockAddMenuItemBase & {
  icon: IconName
  action?: (area: DockArea) => void
}

const browserDockPane: DockPane = {
  id: "browser",
  title: "Browser",
  icon: "window-cursor",
  defaultArea: "right",
  category: "Built-in",
  source: "host",
  keepAlive: true,
  mount: () => <SessionBrowserDock />,
}
const passiveDockTabs = [browserDockPane.id]

const dockPaneIdForTab = (tab: Tab) => `tab:${base64Encode(tabKey(tab))}`
const persistentSurfaceToolPaneId = (toolID: string) => `surface-tool:${toolID}`
const controlPanelPartKinds = new Set(["opencode/control-panel"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readControlPanelData(data: unknown) {
  if (!isRecord(data) || data.version !== 1 || typeof data.controlID !== "string") return
  return {
    controlID: data.controlID,
    title: typeof data.title === "string" ? data.title : undefined,
    dock: data.dock === true,
  }
}

function sourcePartFromStored(panel: StoredControlPanel): CustomPart {
  return sanitizeCustomPart({
    id: panel.partID,
    sessionID: panel.sessionID,
    messageID: panel.messageID,
    type: "custom",
    kind: "opencode/control-panel",
    data: panel.data,
    title: panel.title,
    metadata: { controlID: panel.controlID },
  })
}

function sourcePartFromPersistentTool(tool: SurfacePersistentTool): CustomPart {
  return sanitizeCustomPart({
    id: `surface_tool_${tool.id}`,
    sessionID: tool.origin?.sessionID ?? tool.id,
    messageID: tool.origin?.requestID ?? tool.id,
    type: "custom",
    kind: "opencode/control-panel",
    data: { ...tool.surface, values: tool.state.values },
    title: tool.surface.title,
    metadata: { controlID: tool.surface.controlID, surfaceToolID: tool.id },
  })
}

function sourcePartFromPart(part: Part): CustomPart | undefined {
  if (part.type !== "custom" || !("kind" in part) || typeof part.kind !== "string") return
  if (!controlPanelPartKinds.has(part.kind)) return
  return sanitizeCustomPart(part as CustomPart)
}

export function SessionDockShell(props: { middle: JSX.Element }) {
  const layout = useLayout()
  const language = useLanguage()
  const server = useServer()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const global = useGlobal()
  const dockContent = useDockContent()
  const content = dockContent.parts
  const tabs = useTabs()
  const notification = useNotification()
  const dockState = useDockStateActions()
  const sessionFavorites = useSessionFavorites()
  const dialog = useDialog()
  const plugins = useAppPluginRuntime()
  const { view, params } = useSessionLayout()
  const [searchParams, setSearchParams] = useSearchParams<{ pluginRoute?: string }>()
  const [activatedPluginRoute, setActivatedPluginRoute] = createSignal<string>()
  const [persistentTools, setPersistentTools] = createSignal<SurfacePersistentTool[]>([])
  const [draggingPane, setDraggingPane] = createSignal<string>()
  const [pointerDrag, setPointerDrag] = createSignal<{ id: string; x: number; y: number; moved: boolean }>()
  const [viewport, setViewport] = createSignal({
    width: typeof window === "undefined" ? 1440 : (window.visualViewport?.width ?? window.innerWidth),
    height: typeof window === "undefined" ? 900 : (window.visualViewport?.height ?? window.innerHeight),
  })
  let mobileViewportBaseline = typeof window === "undefined" ? 900 : window.innerHeight
  let mobileViewportBaselineWidth = typeof window === "undefined" ? 1440 : window.innerWidth
  let resetMobileViewportBaseline = false
  const isMobile = createMediaQuery(MOBILE_DOCK_MEDIA_QUERY)
  const sizing = createSizing()

  const dockArea = (area: DockArea) => layout.dock.area(area)
  const isDockItemRendered = (id: string, area?: DockArea) => {
    if (!layout.dock.itemVisible(id)) return false
    const zoneRef = area ? layout.dock.area(area) : null
    const mobile = isMobile()
    if (mobile) {
      const active = mobileActive()
      return active === id && layout.dock.mobile.opened()
    }
    if (zoneRef) {
      const zoneActive = zoneRef.active()
      const zoneVisible = zoneRef.visible()
      return zoneActive === id && (zoneVisible || area === "middle")
    }
    const itemAreaStr = layout.dock.itemArea(id)
    if (!itemAreaStr) return false
    const zone = layout.dock.area(itemAreaStr as DockArea)
    return zone.active() === id && (zone.visible() || itemAreaStr === "middle")
  }
  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)
  const middleMin = () => (viewport().width < 980 ? 320 : 420)
  const verticalMax = () => Math.max(120, viewport().height * 0.62)
  const mobileMax = () => mobileDockMaxSize(viewport().height)
  const sideMax = () =>
    Math.max(220, (viewport().width - middleMin() - 32) / Math.max(1, Number(leftVisible()) + Number(rightVisible())))
  const sideSize = (area: "left" | "right") => clamp(dockArea(area).size(), area === "left" ? 180 : 220, sideMax())
  const verticalSize = (area: "top" | "bottom") =>
    clamp(dockArea(area).size(), area === "top" ? 96 : 100, verticalMax())
  const mobileSize = () => clamp(layout.dock.mobile.size(), MOBILE_DOCK_MIN_SIZE, mobileMax())
  // Draft-aware: the shell follows the active tab's directory directly so it
  // never depends on the routed (directory-scoped) sync context below it.
  // Declared before the memos that read them; createMemo bodies run eagerly.
  const currentDirectory = createMemo(() => {
    const tab = tabs.active()
    if (!tab) return undefined
    if (tab.type === "session") return decode64(tab.dirBase64)
    return tab.directory
  })
  const currentDirectoryStore = createMemo(() => {
    const directory = currentDirectory()
    if (!directory) return undefined
    return serverSync().peek(directory, { bootstrap: false })[0]
  })
  const currentSession = createMemo(() => {
    const id = params.id
    if (!id) return undefined
    const store = currentDirectoryStore()
    if (!store) return undefined
    return store.session.find((session) => session.id === id)
  })
  let persistentToolLoad = 0
  const persistentToolTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const persistentToolWrites = new Map<string, Promise<void>>()
  const refreshPersistentTools = async (directory = currentDirectory()) => {
    if (!directory) {
      setPersistentTools([])
      return
    }
    const generation = ++persistentToolLoad
    const result = await serverSDK()
      .createClient({ directory, throwOnError: true })
      .v2.surface.tool.list({ location: { directory }, includeHidden: "true" })
    if (generation !== persistentToolLoad) return
    setPersistentTools(result.data?.data ?? [])
  }
  createEffect(() => {
    const directory = currentDirectory()
    if (!directory) {
      setPersistentTools([])
      return
    }
    void refreshPersistentTools(directory).catch(() => setPersistentTools([]))
  })
  onCleanup(() => {
    for (const timer of persistentToolTimers.values()) clearTimeout(timer)
    persistentToolTimers.clear()
  })

  const serverCtxFor = (key: ServerConnection.Key) => {
    const conn = global.servers.list().find((item) => ServerConnection.key(item) === key)
    if (conn) return global.createServerCtx(conn)
  }

  const renamePaneSession = (pane: DockPane) => {
    const favorite = pane.favorite
    if (!favorite) return
    const ctx = serverCtxFor(favorite.server)
    if (!ctx) return
    const picked = sessionFavorites.is(favorite)
    dialog.show(() => (
      <DialogRenameSession
        initialTitle={favorite.title || favorite.slug || favorite.id}
        onRename={async (title) => {
          await ctx.sdk.createDirSdkContext(favorite.directory).client.session.update({
            sessionID: favorite.id,
            title,
          })
          ctx.sync.peek(favorite.directory, { bootstrap: false })[1](
            "session",
            produce((draft) => {
              const session = draft.find((item) => item.id === favorite.id)
              if (session) session.title = title
            }),
          )
          setSessionInfoVersion((version) => version + 1)
          sessionFavorites.set({ ...favorite, title }, picked)
        }}
      />
    ))
  }

  const archivePaneSession = async (pane: DockPane) => {
    const favorite = pane.favorite
    if (!favorite) return
    const ctx = serverCtxFor(favorite.server)
    if (!ctx) return
    await ctx.sdk.createDirSdkContext(favorite.directory).client.session.update({
      sessionID: favorite.id,
      time: { archived: Date.now() },
    })
    ctx.sync.peek(favorite.directory, { bootstrap: false })[1](
      "session",
      produce((draft) => {
        const index = draft.findIndex((item) => item.id === favorite.id)
        if (index !== -1) draft.splice(index, 1)
      }),
    )
    sessionFavorites.remove(favorite)
    notifySessionTabsRemoved({
      server: favorite.server,
      directory: favorite.directory,
      sessionIDs: [favorite.id],
    })
  }

  const deletePaneSession = async (pane: DockPane) => {
    const favorite = pane.favorite
    if (!favorite) return
    const ctx = serverCtxFor(favorite.server)
    if (!ctx) return
    if (!window.confirm(`${language.t("common.delete")} ${favorite.title || favorite.slug || favorite.id}?`)) return
    const protectedState = sessionFavorites.is(favorite)
    if (
      protectedState &&
      !window.confirm(
        language.t("session.delete.protectedConfirm", {
          name: favorite.title || favorite.slug || favorite.id,
        }),
      )
    )
      return
    await ctx.sdk.createDirSdkContext(favorite.directory).client.session.delete({
      sessionID: favorite.id,
      overrideProtection: protectedState ? "true" : undefined,
    })
    ctx.sync.peek(favorite.directory, { bootstrap: false })[1](
      "session",
      produce((draft) => {
        const removed = new Set([favorite.id])
        let changed = true
        while (changed) {
          changed = false
          for (const session of draft) {
            if (!session.parentID || !removed.has(session.parentID) || removed.has(session.id)) continue
            removed.add(session.id)
            changed = true
          }
        }
        for (let i = draft.length - 1; i >= 0; i--) {
          if (removed.has(draft[i].id)) draft.splice(i, 1)
        }
      }),
    )
    sessionFavorites.remove(favorite)
    notifySessionTabsRemoved({
      server: favorite.server,
      directory: favorite.directory,
      sessionIDs: [favorite.id],
    })
  }

  onMount(() => {
    if (typeof window === "undefined") return
    const sync = () => {
      const input = keyboardInputElement(document.activeElement)
      if (
        resetMobileViewportBaseline ||
        !input ||
        Math.abs(window.innerWidth - mobileViewportBaselineWidth) > 1
      ) {
        mobileViewportBaseline = window.innerHeight
        mobileViewportBaselineWidth = window.innerWidth
        resetMobileViewportBaseline = false
      } else {
        mobileViewportBaseline = Math.max(mobileViewportBaseline, window.innerHeight)
      }
      setViewport({
        width: window.visualViewport?.width ?? window.innerWidth,
        height: window.visualViewport?.height ?? window.innerHeight,
      })
      if (
        isMobile() &&
        window.visualViewport &&
        shouldCloseMobileDockForKeyboard(
          window.innerHeight,
          window.visualViewport.height,
          mobileViewportBaseline,
          !!input &&
            !input.closest('[data-dock-wrapper="mobile"], [data-mobile-dock-overlay="true"]'),
        )
      )
        layout.dock.mobile.close()
    }
    const resetBaseline = () => {
      resetMobileViewportBaseline = true
    }
    sync()
    window.addEventListener("resize", sync)
    window.addEventListener("orientationchange", resetBaseline)
    document.addEventListener("focusin", sync)
    window.visualViewport?.addEventListener("resize", sync)
    onCleanup(() => {
      window.removeEventListener("resize", sync)
      window.removeEventListener("orientationchange", resetBaseline)
      document.removeEventListener("focusin", sync)
      window.visualViewport?.removeEventListener("resize", sync)
    })
  })

  const activeTab = createMemo(() => tabs.active())
  const routeMatchesTab = (tab: Tab) => activeTab() && tabKey(activeTab()!) === tabKey(tab)
  let sessionInfoFrame: number | undefined
  let sessionInfoTimer: number | undefined
  const sessionInfoPending = new Set<string>()
  const sessionInfoLoaded = new Set<string>()
  const [sessionInfoVersion, setSessionInfoVersion] = createSignal(0)

  const clearSessionInfoWarmup = () => {
    if (sessionInfoFrame !== undefined) cancelAnimationFrame(sessionInfoFrame)
    if (sessionInfoTimer !== undefined) window.clearTimeout(sessionInfoTimer)
    sessionInfoFrame = undefined
    sessionInfoTimer = undefined
  }

  createEffect(() => {
    clearSessionInfoWarmup()

    const missing = tabs.store.flatMap((tab) => {
      if (tab.type !== "session") return []
      const directory = decode64(tab.dirBase64)
      if (!directory) return []
      const sync = serverCtxFor(tab.server)?.sync
      if (!sync) return []
      const store = sync.existing(directory)?.[0]
      if (store?.session.some((session) => session.id === tab.sessionId)) return []
      const key = tabKey(tab)
      if (sessionInfoPending.has(key) || sessionInfoLoaded.has(key)) return []
      return [{ active: routeMatchesTab(tab), key, sync, server: tab.server, directory, sessionID: tab.sessionId }]
    })

    if (missing.length === 0) return
    missing.sort((a, b) => Number(b.active) - Number(a.active))
    sessionInfoFrame = requestAnimationFrame(() => {
      sessionInfoFrame = undefined
      sessionInfoTimer = window.setTimeout(() => {
        sessionInfoTimer = undefined
        missing.forEach((item) => {
          sessionInfoPending.add(item.key)
          void loadSessionTabInfo({
            server: item.server,
            directory: item.directory,
            sessionID: item.sessionID,
            load: () => item.sync.session.info(item.directory, item.sessionID),
          }).finally(() => {
            sessionInfoPending.delete(item.key)
            sessionInfoLoaded.add(item.key)
            setSessionInfoVersion((version) => version + 1)
          })
        })
      }, 0)
    })
  })

  onCleanup(clearSessionInfoWarmup)

  const sessionPaneForTab = (tab: Tab): DockPane => {
    const closeTab = () => {
      const currentIndex = tabs.store.findIndex((item) => tabKey(item) === tabKey(tab))
      if (currentIndex === -1) return
      return tabs.removeTab(currentIndex)
    }
    if (tab.type === "draft") {
      return {
        id: dockPaneIdForTab(tab),
        title: language.t("command.session.new"),
        icon: "new-session",
        leading: () => <SessionDockAvatar directory={tab.directory} />,
        defaultArea: "middle",
        category: "Session",
        source: "host",
        keepAlive: true,
        mount: () => (
          <Show when={routeMatchesTab(tab)} fallback={<DockSessionPlaceholder title={language.t("command.session.new")} />}>
            {props.middle}
          </Show>
        ),
        onActivate: () => tabs.remember(tab),
        onClose: closeTab,
      }
    }

    sessionInfoVersion()
    const directory = decode64(tab.dirBase64)
    const ctx = serverCtxFor(tab.server)
    const session = directory && ctx ? ctx.sync.existing(directory)?.[0].session.find((item) => item.id === tab.sessionId) : undefined
    const title = sessionTitle(session?.title) ?? language.t("command.session.new")
    return {
      id: dockPaneIdForTab(tab),
      title,
      icon: "prompt",
      leading: () => (
        <SessionDockAvatar
          project={() => {
            const current =
              directory && ctx ? ctx.sync.existing(directory)?.[0].session.find((item) => item.id === tab.sessionId) : undefined
            const projects = tab.server === server.key ? layout.projects.list() : ctx?.projects.list() ?? []
            return current ? projectForSession(current, projects) : undefined
          }}
          directory={directory}
          sessionId={tab.sessionId}
          active={tab.server === server.key}
          visible={() => !!routeMatchesTab(tab)}
          sync={() => ctx?.sync}
          loading={() =>
            !directory
              ? false
              : tab.server === server.key && currentDirectory() === directory
                ? !!currentDirectoryStore()?.session_working(tab.sessionId)
                : !!ctx?.sync.existing(directory)?.[0].session_working(tab.sessionId)
          }
        />
      ),
      defaultArea: "middle",
      category: "Session",
      source: "host",
      keepAlive: true,
      sessionId: tab.sessionId,
      favorite:
        directory
          ? session
            ? sessionFavoriteFromSession({ server: tab.server, directory, session })
            : { server: tab.server, directory, id: tab.sessionId }
          : undefined,
      mount: () => (
        <Show when={routeMatchesTab(tab)} fallback={<DockSessionPlaceholder title={title} />}>
          {props.middle}
        </Show>
      ),
      onActivate: () => {
        notification.session.markViewed(tab.sessionId)
        tabs.select(tab)
        focusDockPromptInputForSession(tab.sessionId)
      },
      onClose: async () => {
        await closeTab()
        dockState.cleanupEmptySession(tab)
      },
    }
  }

  const activeRoutePaneID = createMemo(() => {
    const tab = activeTab()
    return tab ? dockPaneIdForTab(tab) : undefined
  })

  const sessionPaneCache = new Map<string, { signature: string; pane: DockPane }>()
  const sessionPanes = createMemo<DockPane[]>(() => {
    const seen = new Set<string>()
    const panes = tabs.store.map((tab) => {
      const pane = sessionPaneForTab(tab)
      seen.add(pane.id)
      const signature = `${pane.title}\n${pane.sessionId ?? ""}\n${JSON.stringify(pane.favorite)}`
      const cached = sessionPaneCache.get(pane.id)
      if (cached?.signature === signature) return cached.pane
      sessionPaneCache.set(pane.id, { signature, pane })
      return pane
    })
    for (const id of sessionPaneCache.keys()) if (!seen.has(id)) sessionPaneCache.delete(id)
    return panes
  })

  const activeControlPanels = createMemo<ControlPanelPaneInfo[]>(() => {
    const panels: ControlPanelPaneInfo[] = []
    const seen = new Set<string>()
    const scan = resolveActiveSessionScan({
      directory: currentDirectory(),
      sessionID: params.id,
      resolve: (directory) => serverSync().existing(directory)?.[0],
    })
    if (!scan) return panels
    const collect = () => {
      const { directory, sessionID, store } = scan
      for (const treeSessionID of sessionTreeIDs(store.session, sessionID)) {
        const requests = store.question[treeSessionID] ?? []
        const requestMirrors = new Set(
          requests
            .filter((request): request is SurfaceControlRequest => request.mode !== "blocking" && !!request.tool?.messageID)
            .map((request) => `${request.tool!.messageID}\0${request.surface.controlID}`),
        )
        const unanchoredRequestControls = new Set(
          requests
            .filter((request): request is SurfaceControlRequest => request.mode !== "blocking" && !request.tool?.messageID)
            .map((request) => request.surface.controlID),
        )
        for (const message of store.message[treeSessionID] ?? []) {
          for (const part of store.part[message.id] ?? []) {
            const sourcePart = sourcePartFromPart(part)
            const data = sourcePart ? readControlPanelData(sourcePart.data) : undefined
            if (!sourcePart || !data) continue
            const hasLiveRequest =
              requestMirrors.has(`${message.id}\0${data.controlID}`) || unanchoredRequestControls.has(data.controlID)
            const isHandoff = surfaceContainsAgentHandoff(sourcePart.data)
            if (
              isHandoff
                ? !shouldKeepRetainedHandoffPanel({
                    requestID: undefined,
                    dismissed: layout.handoffRequests.hasDismissedRequestInSession({ directory, sessionID: treeSessionID }),
                    hasLiveRequest,
                    snapshotAvailable: true,
                    requestsLoaded: store.status === "complete",
                    ready: layout.ready(),
                  })
                : hasLiveRequest
            )
              continue
            const paneId = controlPanelPaneId(directory, treeSessionID, message.id, part.id)
            if (seen.has(paneId) || layout.controlPanels.closed()[paneId]) continue
            seen.add(paneId)
            panels.push({
              id: paneId,
              paneID: paneId,
              directory,
              sessionID: treeSessionID,
              messageID: message.id,
              partID: part.id,
              controlID: data.controlID,
              title: data.title ?? sourcePart.title,
              dock: data.dock,
              data: sourcePart.data,
              sourcePart,
            })
          }
        }
        for (const request of store.question[treeSessionID] ?? []) {
          if (request.mode === "blocking") continue
          if (surfaceContainsAgentHandoff(request.surface) && (
            !layout.ready() ||
            layout.handoffRequests.isDismissed({ directory, sessionID: treeSessionID, requestID: request.id })
          ))
            continue
          const messageID = request.tool?.messageID ?? request.id
          const partID = `surface_${request.id}`
          const paneId = controlPanelPaneId(directory, treeSessionID, messageID, partID)
          if (seen.has(paneId) || layout.controlPanels.closed()[paneId]) continue
          seen.add(paneId)
          const stored: StoredControlPanel = {
            id: paneId,
            directory,
            sessionID: treeSessionID,
            messageID,
            partID,
            controlID: request.surface.controlID,
            title: request.surface.title,
            data: request.surface,
          }
          panels.push({
            ...stored,
            paneID: paneId,
            dock: request.surface.dock,
            requestID: request.id,
            requestRevision: request.revision,
            requestCapability: request.tool?.confirmationToken,
            requestMode: request.mode,
            canPinGlobal: request.mode === "passive" && request.actions.length === 0,
            sourcePart: sourcePartFromStored(stored),
          })
        }
      }
    }

    collect()
    return panels
  })

  const retainedControlPanelCache = new Map<string, ControlPanelPaneInfo>()
  const retainedControlPanels = createMemo(() => {
    const active = activeControlPanels()
    const retained = updateVisiblePanelCache({
      cache: retainedControlPanelCache,
      active,
      closed: layout.controlPanels.closed(),
      visible: layout.dock.itemVisible,
      keep: (panel) => {
        if (!surfaceContainsAgentHandoff(panel.data)) return true
        const store = serverSync().existing(panel.directory)?.[0]
        const requests = store
          ? sessionTreeIDs(store.session, panel.sessionID).flatMap((sessionID) => store.question[sessionID] ?? [])
          : []
        const dismissed = panel.requestID
          ? layout.handoffRequests.isDismissed({
              directory: panel.directory,
              sessionID: panel.sessionID,
              requestID: panel.requestID,
            })
          : layout.handoffRequests.hasDismissedRequestInSession({ directory: panel.directory, sessionID: panel.sessionID })
        return shouldKeepRetainedHandoffPanel({
          requestID: panel.requestID,
          dismissed,
          hasLiveRequest: requests.some(
            (request) => request.mode !== "blocking" && matchesRetainedHandoffRequest({ panel, request }),
          ),
          snapshotAvailable: !!store,
          requestsLoaded: store?.status === "complete",
          ready: layout.ready(),
        })
      },
    })
    return retained.map((panel) => {
      if (!surfaceContainsAgentHandoff(panel.data) || !panel.requestID) return panel
      const store = serverSync().existing(panel.directory)?.[0]
      const requests = store
        ? sessionTreeIDs(store.session, panel.sessionID).flatMap((sessionID) => store.question[sessionID] ?? [])
        : []
      const live = retainedHandoffRequest({
        panel: { requestID: panel.requestID },
        requests: requests.filter(
          (request): request is SurfaceControlRequest => request.mode !== "blocking",
        ),
      })
      if (!live || !isStaleRetainedHandoffRequest({ panel, request: live })) return panel
      const stored: StoredControlPanel = {
        id: panel.paneID,
        directory: panel.directory,
        sessionID: panel.sessionID,
        messageID: live.tool?.messageID ?? live.id,
        partID: `surface_${live.id}`,
        controlID: live.surface.controlID,
        title: live.surface.title,
        data: live.surface,
      }
      return {
        ...panel,
        messageID: stored.messageID,
        partID: stored.partID,
        controlID: stored.controlID,
        title: stored.title,
        data: stored.data,
        sourcePart: sourcePartFromStored(stored),
        requestRevision: live.revision,
        requestCapability: live.tool?.confirmationToken,
        requestMode: live.mode,
      }
    })
  })

  const pinnedControlPanels = createMemo<ControlPanelPaneInfo[]>(() => [
    ...Object.values(layout.controlPanels.pinned()).map((panel) => ({
      ...panel,
      paneID: panel.id,
      pinned: true,
      sourcePart: sourcePartFromStored(panel),
    })),
    ...persistentTools()
      .filter((tool) => !tool.hidden)
      .map((tool) => ({
        id: persistentSurfaceToolPaneId(tool.id),
        paneID: persistentSurfaceToolPaneId(tool.id),
        directory: tool.directory,
        sessionID: tool.origin?.sessionID ?? "",
        messageID: tool.origin?.requestID ?? tool.id,
        partID: `surface_tool_${tool.id}`,
        controlID: tool.surface.controlID,
        title: tool.surface.title,
        data: { ...tool.surface, values: tool.state.values },
        pinned: true,
        toolID: tool.id,
        toolRevision: tool.revision,
        toolStateRevision: tool.state.revision,
        sourcePart: sourcePartFromPersistentTool(tool),
      })),
  ])

  const controlPanels = createMemo(() => {
    const panels = [...activeControlPanels(), ...retainedControlPanels(), ...pinnedControlPanels()]
    return [...new Map(panels.map((panel) => [panel.paneID, panel])).values()]
  })
  const dockedControlPanels = createMemo(() =>
    controlPanels().filter((panel) => shouldDockControlPanel(panel) || layout.dock.itemVisible(panel.paneID)),
  )
  const visibleHandoffRequestKeys = createMemo(() =>
    dockedControlPanels().flatMap((panel) => {
      if (!panel.requestID || !surfaceContainsAgentHandoff(panel.data) || !isDockItemRendered(panel.paneID)) return []
      return [
        handoffRequestKey({ directory: panel.directory, sessionID: panel.sessionID, requestID: panel.requestID }),
      ]
    }),
  )
  createEffect(() => layout.controlPanels.setVisibleHandoffRequestKeys(visibleHandoffRequestKeys()))
  onCleanup(() => layout.controlPanels.setVisibleHandoffRequestKeys([]))
  const popupControlPanel = createMemo(() => {
    const panels = activeControlPanels().filter((panel) =>
      surfaceContainsAgentHandoff(panel.data)
        ? !isDockItemRendered(panel.paneID)
        : !shouldDockControlPanel(panel) && !layout.dock.itemVisible(panel.paneID),
    )
    const directory = currentDirectory()
    const sessionID = currentSession()?.id
    if (!directory || !sessionID) return panels.at(-1)
    const treeIDs = new Set(sessionTreeIDs(currentDirectoryStore()?.session ?? [], sessionID))
    return panels.findLast((panel) => panel.directory === directory && treeIDs.has(panel.sessionID)) ?? panels.at(-1)
  })

  const activeQuestions = createMemo<SurfaceBlockingRequest[]>(() => {
    const id = params.id
    if (!id) return []
    return (currentDirectoryStore()?.question[id] ?? []).filter(
      (request): request is SurfaceBlockingRequest => request.mode === "blocking",
    )
  })

  // Plugin runtime dock items are re-emitted as fresh objects on unrelated
  // store writes (e.g. directory changes), but DockKeepAlivePane keeps its
  // mounted content keyed on pane identity. Cache panes by item id and only
  // rebuild when the dock-relevant metadata actually changes, so plugin panes
  // like the Session Navigator stay mounted across session/project switches.
  const pluginPaneCache = new Map<string, { signature: string; pane: DockPane }>()
  const pluginPanes = createMemo<DockPane[]>(() => {
    const items = plugins.dockItems()
    const seen = new Set<string>()
    const panes = items.flatMap((item) => {
      if (seen.has(item.id)) return []
      seen.add(item.id)
      const signature = `${item.title}\n${item.pluginID ?? ""}\n${item.icon ?? ""}\n${item.defaultArea}\n${(item.allowedAreas ?? []).join(",")}`
      const cached = pluginPaneCache.get(item.id)
      if (cached?.signature === signature) return [cached.pane]
      const pane: DockPane = {
        id: item.id,
        title: item.title,
        category: item.pluginID ? `Plugin ${item.pluginID}` : "Plugin",
        icon: (item.icon ?? "code") as IconName,
        defaultArea: item.defaultArea,
        allowedAreas: item.allowedAreas,
        source: "plugin",
        mount: (ctx) => <PluginDockMount item={item} area={ctx.area} visible={ctx.visible} />,
      }
      pluginPaneCache.set(item.id, { signature, pane })
      return [pane]
    })
    for (const id of pluginPaneCache.keys()) if (!seen.has(id)) pluginPaneCache.delete(id)
    return panes
  })

  const pinControlPanel = async (
    panel: ControlPanelPaneInfo,
    area: DockArea,
    scope: "project" | "global" = "project",
  ) => {
    if (panel.requestID && panel.requestRevision) {
      const client = serverSDK().createClient({ directory: panel.directory, throwOnError: true })
      const result = await client.v2.session.surface.pin({
        sessionID: panel.sessionID,
        requestID: panel.requestID,
        scope,
        expectedRevision: panel.requestRevision,
      })
      const tool = result.data
      if (!tool) return
      setPersistentTools((current) => [...current.filter((item) => item.id !== tool.id), tool])
      await client.v2.session.surface.dismiss({ sessionID: panel.sessionID, requestID: panel.requestID })
      layout.dock.closeItem(panel.paneID)
      layout.controlPanels.close(panel.paneID)
      layout.dock.openItem(persistentSurfaceToolPaneId(tool.id), area)
      return
    }
    const id = pinnedControlPanelPaneId(panel.directory, panel.controlID)
    layout.controlPanels.pin({
      id,
      directory: panel.directory,
      sessionID: panel.sessionID,
      messageID: panel.messageID,
      partID: panel.partID,
      controlID: panel.controlID,
      title: panel.title,
      data: panel.data,
    })
    layout.dock.openItem(id, area)
    if (panel.paneID !== id) {
      layout.dock.closeItem(panel.paneID)
      layout.controlPanels.close(panel.paneID)
    }
  }

  const hidePersistentTool = async (panel: ControlPanelPaneInfo) => {
    if (!panel.toolID) return
    const result = await serverSDK()
      .createClient({ directory: panel.directory, throwOnError: true })
      .v2.surface.tool.visibility({
        toolID: panel.toolID,
        location: { directory: panel.directory },
        hidden: true,
      })
    if (result.data)
      setPersistentTools((current) => current.map((tool) => (tool.id === result.data!.id ? result.data! : tool)))
    layout.dock.closeItem(panel.paneID)
  }

  const removePersistentTool = async (panel: ControlPanelPaneInfo) => {
    if (!panel.toolID) return
    await serverSDK()
      .createClient({ directory: panel.directory, throwOnError: true })
      .v2.surface.tool.remove({ toolID: panel.toolID, location: { directory: panel.directory } })
    setPersistentTools((current) => current.filter((tool) => tool.id !== panel.toolID))
    layout.dock.removeItem(panel.paneID)
  }

  const persistToolValues = (panel: ControlPanelPaneInfo, values: Record<string, unknown>) => {
    if (!panel.toolID) return
    const timer = persistentToolTimers.get(panel.toolID)
    if (timer) clearTimeout(timer)
    persistentToolTimers.set(
      panel.toolID,
      setTimeout(() => {
        persistentToolTimers.delete(panel.toolID!)
        const previous = persistentToolWrites.get(panel.toolID!) ?? Promise.resolve()
        const next = previous.then(async () => {
          const current = persistentTools().find((tool) => tool.id === panel.toolID)
          if (!current) return
          const result = await serverSDK()
            .createClient({ directory: panel.directory, throwOnError: true })
            .v2.surface.tool.state({
              toolID: panel.toolID!,
              location: { directory: panel.directory },
              expectedRevision: current.state.revision,
              values,
            })
          if (result.data)
            setPersistentTools((tools) => tools.map((tool) => (tool.id === result.data!.id ? result.data! : tool)))
        })
        persistentToolWrites.set(
          panel.toolID!,
          next.catch(() => undefined),
        )
      }, 220),
    )
  }

  const closeControlPanel = (panel: ControlPanelPaneInfo) => {
    layout.controlPanels.close(panel.paneID)
    if (!panel.requestID) return
    const store = serverSync().existing(panel.directory)?.[0]
    for (const part of store?.part[panel.messageID] ?? []) {
      const sourcePart = sourcePartFromPart(part)
      const data = sourcePart ? readControlPanelData(sourcePart.data) : undefined
      if (!data || data.controlID !== panel.controlID) continue
      layout.controlPanels.close(controlPanelPaneId(panel.directory, panel.sessionID, panel.messageID, part.id))
    }
    if (surfaceContainsAgentHandoff(panel.data)) {
      void layout.handoffRequests.dismiss({
        directory: panel.directory,
        sessionID: panel.sessionID,
        requestID: panel.requestID,
      })
      return
    }
    void serverSDK()
      .createClient({ directory: panel.directory, throwOnError: true })
      .v2.session.surface.dismiss({ sessionID: panel.sessionID, requestID: panel.requestID })
      .catch(() => undefined)
  }

  const dockControlPanel = (panel: ControlPanelPaneInfo, area: DockArea) => {
    layout.dock.openItem(panel.paneID, area)
  }

  // Registry-backed panes must keep a stable identity for the whole shell
  // lifetime: DockKeepAlivePane re-runs mount when the pane object (or the
  // registry content it reads) changes, so recreating these inside the
  // registry memo would remount review/terminal/file tree content on every
  // unrelated store write. They stay keepAlive so zone tab switches never
  // dispose their content either.
  const reviewPane: DockPane = {
    id: "review",
    title: language.t("session.tab.review"),
    icon: "review",
    defaultArea: "right",
    category: "Built-in",
    source: "host",
    keepAlive: true,
    mount: () => content()?.review ?? null,
    onActivate: () => view().reviewPanel.open(),
  }
  const gitChangesPane: DockPane = {
    id: "gitChanges",
    title: language.t("session.review.change.other"),
    icon: "review",
    defaultArea: "right",
    category: "Built-in",
    source: "host",
    keepAlive: true,
    mount: () => content()?.changes ?? null,
    onActivate: () => {
      layout.fileTree.open()
      layout.fileTree.setTab("changes")
    },
  }
  const fileTreePane: DockPane = {
    id: "fileTree",
    title: language.t("session.files.all"),
    icon: "file-tree",
    defaultArea: "right",
    category: "Built-in",
    source: "host",
    keepAlive: true,
    mount: () => content()?.files ?? null,
    onActivate: () => {
      layout.fileTree.open()
      layout.fileTree.setTab("all")
    },
  }
  const terminalPane: DockPane = {
    id: "terminal",
    title: language.t("terminal.title"),
    icon: "terminal",
    defaultArea: "bottom",
    category: "Built-in",
    source: "host",
    keepAlive: true,
    mount: () => content()?.bottom() ?? null,
    onActivate: () => view().terminal.open(),
  }
  // Stable identity like the keepAlive panes above: DockKeepAlivePane re-runs
  // mount when the pane object changes, so creating this inside the registry
  // memo would rebuild the Usage dashboard (losing scroll position and
  // selection) on every unrelated registry re-evaluation.
  const usagePane: DockPane = {
    id: "usage",
    title: "Usage",
    icon: "status",
    defaultArea: "right",
    category: "Built-in",
    source: "host",
    keepAlive: true,
    mount: () => <UsageDashboard />,
  }

  const registry = createMemo<DockPane[]>(() => [
    ...sessionPanes(),
    reviewPane,
    gitChangesPane,
    fileTreePane,
    terminalPane,
    {
      id: "pluginManager",
      title: "Plugin Manager",
      icon: "code",
      defaultArea: "left",
      category: "Built-in",
      source: "host",
      mount: () => <ExtensionManagerDockPane />,
    },
    usagePane,
    browserDockPane,
    ...dockedControlPanels().map(
      (panel): DockPane => ({
        id: panel.paneID,
        title: panel.title || panel.controlID,
        icon: "sliders",
        defaultArea: "middle",
        category: "Control Panel",
        source: "host",
        mount: ({ area }) => (
          <SessionControlPanelPane
            panel={panel}
            currentArea={area}
            pinned={panel.pinned === true}
            onDock={(target) => layout.dock.moveItem(panel.paneID, target)}
            onPin={() => void pinControlPanel(panel, area).catch(() => undefined)}
            onUnpin={() =>
              panel.toolID
                ? void hidePersistentTool(panel).catch(() => undefined)
                : layout.controlPanels.unpin(panel.paneID)
            }
            onRemove={panel.toolID ? () => void removePersistentTool(panel).catch(() => undefined) : undefined}
            onValuesChange={panel.toolID ? (values) => persistToolValues(panel, values) : undefined}
            onClose={() => {
              closePane(panel.paneID)
              if (panel.toolID) {
                void hidePersistentTool(panel).catch(() => undefined)
                return
              }
              closeControlPanel(panel)
            }}
          />
        ),
        onClose: () => {
          if (panel.pinned) {
            if (panel.toolID) {
              void hidePersistentTool(panel).catch(() => undefined)
              return
            }
            layout.controlPanels.unpin(panel.paneID)
            return
          }
          closeControlPanel(panel)
        },
      }),
    ),
    ...activeQuestions().map(
      (request): DockPane => ({
        id: questionDockPaneId(request),
        title:
          request.questions[0]?.header ??
          request.questions[0]?.form?.title ??
          request.questions[0]?.question ??
          "Question",
        icon: "prompt",
        defaultArea: "bottom",
        category: "Question",
        source: "host",
        mount: ({ area }) => (
          <Show when={currentDirectory()}>
            {(directory) => (
              <SessionSurfaceProviders directory={directory()} sessionID={request.sessionID}>
                <div class="size-full min-h-0 overflow-auto bg-background-stronger p-2">
                  <SessionQuestionDock
                    request={request}
                    autofocus={false}
                    dock={{
                      currentArea: area,
                      pinned: true,
                      onDock: (target) => layout.dock.openItem(questionDockPaneId(request), target),
                      onUnpin: () => closePane(questionDockPaneId(request)),
                    }}
                    onSubmit={() => content()?.onResponseSubmit?.()}
                  />
                </div>
              </SessionSurfaceProviders>
            )}
          </Show>
        ),
        onClose: () => layout.dock.closeItem(questionDockPaneId(request)),
      }),
    ),
    ...pluginPanes(),
  ])
  const registryByID = createMemo(() => new Map(registry().map((pane) => [pane.id, pane] as const)))
  createEffect(() => layout.dock.setRegisteredPaneIDs(registry().map((pane) => pane.id)))
  onCleanup(() => layout.dock.setRegisteredPaneIDs([]))

  const dockCatalog = createMemo<DockAddMenuItem[]>(() => {
    const newSessionItem: DockAddMenuItem = {
      id: "newSession",
      title: language.t("command.session.new"),
      category: "Session",
      icon: "new-session",
      defaultArea: "middle",
      action: (area) => {
        const directory = currentDirectory() ?? layout.projects.list()[0]?.worktree
        if (!directory) return
        layout.projects.open(directory)
        const draftID = tabs.newDraft({ server: server.key, directory }, undefined, { navigate: false })
        const tab = tabs.draft(draftID)
        const paneID = dockPaneIdForTab(tab)
        layout.dock.moveItem(paneID, area)
        layout.dock.setItemVisible(paneID, true)
        layout.dock.setActive(area, paneID)
        tabs.select(tab)
        queueMicrotask(() => activate(area, paneID))
        window.dispatchEvent(new CustomEvent("opencode:dock-resize", { detail: { area } }))
      },
    }
    const items: DockAddMenuItem[] = registry()
      .filter((pane) => pane.category !== "Session")
      .map((pane) => ({
        id: pane.id,
        title: pane.title,
        category: pane.category,
        icon: pane.icon,
        defaultArea: pane.defaultArea,
        allowedAreas: pane.allowedAreas,
      }))
    items.push(
      ...persistentTools()
        .filter((tool) => tool.hidden)
        .map((tool) => ({
          id: persistentSurfaceToolPaneId(tool.id),
          title: tool.surface.title || tool.surface.controlID,
          category: "Surface Tool",
          icon: "sliders" as IconName,
          defaultArea: "middle" as DockArea,
          action: (area: DockArea) => {
            void serverSDK()
              .createClient({ directory: tool.directory, throwOnError: true })
              .v2.surface.tool.visibility({
                toolID: tool.id,
                location: { directory: tool.directory },
                hidden: false,
              })
              .then((result) => {
                if (!result.data) return
                setPersistentTools((current) =>
                  current.map((item) => (item.id === result.data!.id ? result.data! : item)),
                )
                queueMicrotask(() => layout.dock.openItem(persistentSurfaceToolPaneId(tool.id), area))
              })
              .catch(() => undefined)
          },
        })),
    )
    const priority = (item: DockAddMenuItem) => {
      if (item.id.includes("/")) return 0
      if (item.id === "pluginManager") return 1
      if (item.category === "Built-in") return 3
      return 2
    }
    return [newSessionItem, ...items.toSorted((a, b) => priority(a) - priority(b) || a.title.localeCompare(b.title))]
  })
  const dockCatalogByID = createMemo(() => new Map(dockCatalog().map((item) => [item.id, item] as const)))

  const itemArea = (id: string, fallback: DockArea, allowed?: DockArea[]) => {
    const current = layout.dock.item(id).area()
    if (!current) return fallback
    if (!allowed?.length) return current
    return allowed.includes(current) ? current : fallback
  }

  const itemVisible = (id: string) => layout.dock.item(id).visible()
  const draggablePanes = createMemo(() => registry().filter((pane) => itemVisible(pane.id)))

  createEffect(() => {
    for (const pane of sessionPanes()) {
      const existing = layout.dock.item(pane.id).area()
      if (existing) continue
      const legacy = layout.dock.item("session").visible() ? layout.dock.item("session").area() : undefined
      layout.dock.ensureItem(pane.id, legacy ?? pane.defaultArea, true)
    }
  })

  createEffect(() => {
    for (const pane of plugins.dockItems()) {
      const existing = layout.dock.item(pane.id).area()
      if (existing) continue
      layout.dock.ensureItem(pane.id, pane.defaultArea, false)
    }
  })

  const initializedControlPanels = new Set<string>()
  createEffect(() => {
    for (const pane of dockedControlPanels()) {
      if (initializedControlPanels.has(pane.paneID)) continue
      initializedControlPanels.add(pane.paneID)
      const existing = layout.dock.item(pane.paneID).area()
      if (existing && pane.pinned) continue
      if (existing) layout.dock.moveItem(pane.paneID, "middle")
      layout.dock.ensureItem(pane.paneID, "middle", true)
      layout.dock.setItemVisible(pane.paneID, true)
      layout.dock.setVisible("middle", true)
      layout.dock.setActive("middle", pane.paneID)
    }
  })

  const panes = (area: DockArea) =>
    createMemo<DockPane[]>(() =>
      dockArea(area)
        .tabs()
        .flatMap((id) => {
          const pane = registryByID().get(id)
          if (!pane) return []
          if (itemArea(pane.id, pane.defaultArea, pane.allowedAreas) !== area) return []
          if (!itemVisible(pane.id)) return []
          return [pane]
        }),
    )

  const topPanes = panes("top")
  const leftPanes = panes("left")
  const middlePanes = panes("middle")
  const rightPanes = panes("right")
  const bottomPanes = panes("bottom")

  const zoneVisible = (area: DockArea, list: () => DockPane[]) =>
    createMemo(() => {
      if (area === "middle") return true
      if (!dockArea(area).visible()) return false
      if (list().length > 0) return true
      return true
    })

  const topVisible = zoneVisible("top", topPanes)
  const leftVisible = zoneVisible("left", leftPanes)
  const rightVisible = zoneVisible("right", rightPanes)
  const bottomVisible = zoneVisible("bottom", bottomPanes)

  const active = (area: DockArea, list: () => DockPane[]) => {
    const zone = dockArea(area)
    const [previous, setPrevious] = createSignal<string>()
    const resolved = createMemo(() => {
      const ids = list().map((pane) => pane.id)
      return resolveDockActiveTab(ids, zone.active(), previous(), passiveDockTabs)
    })
    createEffect(() => {
      const next = resolved()
      if (!next) return
      setPrevious(next)
      const current = zone.active()
      if (shouldSyncDockActiveTab(zone.tabs(), current, next)) layout.dock.setActive(area, next)
    })
    return resolved
  }

  const topActive = active("top", topPanes)
  const leftActive = active("left", leftPanes)
  const middleActive = active("middle", middlePanes)
  const rightActive = active("right", rightPanes)
  const bottomActive = active("bottom", bottomPanes)
  const paneList = (area: DockArea) => {
    if (area === "top") return topPanes()
    if (area === "left") return leftPanes()
    if (area === "right") return rightPanes()
    if (area === "bottom") return bottomPanes()
    return middlePanes()
  }
  const mobilePanes = createMemo(() => {
    const seen = new Set<string>()
    return DOCK_AREAS.flatMap((area) => paneList(area)).filter((pane) => {
      if (pane.category === "Session" || seen.has(pane.id)) return false
      seen.add(pane.id)
      return true
    })
  })
  const mobileActive = createMemo(() => {
    const ids = mobilePanes().map((pane) => pane.id)
    return resolveDockActiveTab(ids, layout.dock.mobile.activeItem(), undefined, passiveDockTabs)
  })
  createEffect(() => {
    const active = mobileActive()
    if (!layout.dock.mobile.opened() || !active || !layout.dock.mobile.hasAttention(active)) return
    layout.dock.mobile.activate(active)
  })
  const dockInsertionIndex = (area: DockArea, toIndex?: number) => {
    if (toIndex === undefined) return undefined
    const target = paneList(area)[toIndex]
    if (!target) return undefined
    const index = dockArea(area).tabs().indexOf(target.id)
    return index === -1 ? undefined : index
  }

  const activate = (area: DockArea, id: string) => {
    const pane = registryByID().get(id)
    layout.dock.setVisible(area, true)
    layout.dock.setItemVisible(id, true)
    layout.dock.setActive(area, id)
    pane?.onActivate?.()
    window.dispatchEvent(new CustomEvent("opencode:dock-resize", { detail: { area, active: id } }))
  }

  const activateMobile = (id: string) => {
    const pane = registryByID().get(id)
    if (id === browserDockPane.id)
      layout.dock.mobile.resize(Math.max(layout.dock.mobile.size(), MOBILE_BROWSER_DOCK_MIN_SIZE))
    layout.dock.mobile.activate(id)
    pane?.onActivate?.()
    window.dispatchEvent(new CustomEvent("opencode:dock-resize", { detail: { area: "mobile", active: id } }))
  }

  const placeMobilePane = (id: string) => {
    const item = dockCatalogByID().get(id) ?? registryByID().get(id)
    if (!item) return
    const area = itemArea(id, item.defaultArea, item.allowedAreas)
    if ("action" in item && item.action) {
      item.action(area)
      return
    }
    placePane(area, id)
    if (id === browserDockPane.id)
      layout.dock.mobile.resize(Math.max(layout.dock.mobile.size(), MOBILE_BROWSER_DOCK_MIN_SIZE))
    layout.dock.mobile.activate(id)
  }

  createEffect(() => {
    const id = activeRoutePaneID()
    if (!id) return

    untrack(() => {
      const area = layout.dock.item(id).area() ?? "middle"
      layout.dock.ensureItem(id, area, true)
      layout.dock.setItemVisible(id, true)
      layout.dock.setVisible(area, true)
      layout.dock.setActive(area, id)
    })
  })

  const placePane = (area: DockArea, id: string, toIndex?: number) => {
    const item = dockCatalogByID().get(id) ?? registryByID().get(id)
    if (!item) return
    const target = canDockInArea(item, area) ? area : item.defaultArea
    if ("action" in item && item.action) {
      item.action(target)
      return
    }
    layout.dock.moveItem(id, target, dockInsertionIndex(target, toIndex))
    activate(target, id)
  }

  const closePane = async (id: string) => {
    const pane = registryByID().get(id)
    const area = layout.dock.item(id).area()
    layout.dock.closeItem(id)
    await pane?.onClose?.()
    if (area) window.dispatchEvent(new CustomEvent("opencode:dock-resize", { detail: { area, closed: id } }))
  }

  const closeManyPanes = async (ids: string[]) => {
    const idSet = new Set(ids)
    const panes = ids.flatMap((id) => {
      const pane = registryByID().get(id)
      return pane ? [pane] : []
    })
    const tabsToRemove = tabs.store.filter((tab) => idSet.has(dockPaneIdForTab(tab)))
    for (const id of ids) {
      const area = layout.dock.item(id).area()
      layout.dock.closeItem(id)
      if (area) window.dispatchEvent(new CustomEvent("opencode:dock-resize", { detail: { area, closed: id } }))
    }
    await tabs.removeTabs(tabsToRemove.map(tabKey))
    for (const pane of panes) {
      if (pane.sessionId !== undefined) {
        const tab = tabsToRemove.find((item) => item.type === "session" && item.sessionId === pane.sessionId)
        if (tab?.type === "session") dockState.cleanupEmptySession(tab)
        continue
      }
      await pane.onClose?.()
    }
  }

  const beginPointerDrag = (id: string, event: PointerEvent) => {
    if (event.button !== 0) return
    if (isDockTabActionTarget(event.target)) return
    setPointerDrag({ id, x: event.clientX, y: event.clientY, moved: false })
    setDraggingPane(id)
  }

  const updatePointerDrag = (event: PointerEvent) => {
    setPointerDrag((current) => {
      if (!current) return current
      const moved = current.moved || Math.hypot(event.clientX - current.x, event.clientY - current.y) > 8
      return moved === current.moved ? current : { ...current, moved }
    })
  }

  const endPointerDrag = () => {
    setPointerDrag(undefined)
    setDraggingPane(undefined)
  }

  createEffect(() => {
    const route = searchParams.pluginRoute
    if (!route) return
    if (activatedPluginRoute() === route) return
    const routeItems = plugins.routeItems()
    const item = routeItems
      .find(
        (candidate) =>
          candidate.id === route || candidate.path === route || `${candidate.pluginID}/${candidate.path}` === route,
      )
    if (!item) return
    if (!plugins.dockItems().some((candidate) => candidate.id === item.id)) return
    setActivatedPluginRoute(route)
    if (middleActive() !== item.id) placePane("middle", item.id)
    setSearchParams({ ...searchParams, pluginRoute: undefined }, { replace: true })
  })

  const resize = (area: DockArea, size: number) => {
    sizing.touch()
    layout.dock.resize(area, size)
    if (area === "bottom") layout.terminal.resize(size)
    if (area === "right") layout.fileTree.resize(size)
    if (area === "middle") layout.session.resize(size)
    window.dispatchEvent(new CustomEvent("opencode:dock-resize", { detail: { area, size } }))
  }

  const resizeMobile = (size: number) => {
    sizing.touch()
    layout.dock.mobile.resize(clamp(size, MOBILE_DOCK_MIN_SIZE, mobileMax()))
    window.dispatchEvent(new CustomEvent("opencode:dock-resize", { detail: { area: "mobile", size } }))
  }

  const gridRows = createMemo(
    () =>
      `${topVisible() ? verticalSize("top") : 0}px minmax(0, 1fr) ${bottomVisible() ? verticalSize("bottom") : 0}px`,
  )

  const gridColumns = createMemo(
    () =>
      `${leftVisible() ? sideSize("left") : 0}px minmax(${middleMin()}px, 1fr) ${
        rightVisible() ? sideSize("right") : 0
      }px`,
  )

  const zoneClass = (area: DockArea) => ({
    "relative min-w-0 min-h-0 overflow-hidden bg-background-stronger": true,
    "size-full": true,
    "rounded-[10px] shadow-[var(--v2-elevation-raised)]": true,
    "border border-border-weaker-base": false,
    "border-b": area === "top" && false,
    "border-t": area === "bottom" && false,
  })

  return (
    <>
      <Switch>
        <Match when={!isMobile()}>
          <div
            data-component="session-dock-shell"
            data-layout="desktop-grid"
            data-surface-region={LayoutRegions.popupFirst(true)}
            class="flex-1 min-h-0 grid overflow-hidden"
            classList={{
              "gap-2 p-2": true,
            }}
            style={{
              "grid-template-rows": gridRows(),
              "grid-template-columns": gridColumns(),
              "grid-template-areas": '"top top top" "left middle right" "bottom bottom bottom"',
            }}
          >
            <Show when={topVisible()}>
              <div data-dock-wrapper="top" class="relative min-w-0 min-h-0" style={{ "grid-area": "top" }}>
                <DockZone
                  area="top"
                  panes={topPanes()}
                  active={topActive()}
                  classList={zoneClass("top")}
                  onActivate={(id) => activate("top", id)}
                  onClose={closePane}
                  onMove={(id, toIndex) => placePane("top", id, toIndex)}
                  dragEnabled={!isMobile()}
                  dragging={draggingPane}
                  onDragStart={setDraggingPane}
                  onDragEnd={endPointerDrag}
                  pointerDrag={pointerDrag}
                  onPointerDragStart={beginPointerDrag}
                  onPointerDragMove={updatePointerDrag}
                  onPointerDragEnd={endPointerDrag}
                  addItems={dockCatalog()}
                  dropItems={draggablePanes()}
                  onAdd={(id) => placePane("top", id)}
                  onRenameSession={renamePaneSession}
                  onArchiveSession={archivePaneSession}
                  onDeleteSession={deletePaneSession}
                />
                <ResizeHandle
                  direction="vertical"
                  edge="end"
                  aria-label="Resize top dock"
                  size={dockArea("top").size()}
                  min={96}
                  max={verticalMax()}
                  onResize={(size) => resize("top", size)}
                  onCollapse={() => layout.dock.setVisible("top", false)}
                  onPointerDown={() => sizing.start()}
                />
              </div>
            </Show>

            <Show when={leftVisible()}>
              <div data-dock-wrapper="left" class="relative min-w-0 min-h-0" style={{ "grid-area": "left" }}>
                <DockZone
                  area="left"
                  panes={leftPanes()}
                  active={leftActive()}
                  classList={zoneClass("left")}
                  onActivate={(id) => activate("left", id)}
                  onClose={closePane}
                  onMove={(id, toIndex) => placePane("left", id, toIndex)}
                  dragEnabled={!isMobile()}
                  dragging={draggingPane}
                  onDragStart={setDraggingPane}
                  onDragEnd={endPointerDrag}
                  pointerDrag={pointerDrag}
                  onPointerDragStart={beginPointerDrag}
                  onPointerDragMove={updatePointerDrag}
                  onPointerDragEnd={endPointerDrag}
                  addItems={dockCatalog()}
                  dropItems={draggablePanes()}
                  onAdd={(id) => placePane("left", id)}
                  onRenameSession={renamePaneSession}
                  onArchiveSession={archivePaneSession}
                  onDeleteSession={deletePaneSession}
                />
                <ResizeHandle
                  direction="horizontal"
                  edge="end"
                  aria-label="Resize left dock"
                  size={dockArea("left").size()}
                  min={180}
                  max={sideMax()}
                  onResize={(size) => resize("left", size)}
                  onCollapse={() => layout.dock.setVisible("left", false)}
                  onPointerDown={() => sizing.start()}
                />
              </div>
            </Show>

            <DockZone
              area="middle"
              tabCloseMenu
              panes={middlePanes()}
              active={middleActive()}
              classList={zoneClass("middle")}
              style={{ "grid-area": "middle" }}
              onActivate={(id) => activate("middle", id)}
              onClose={closePane}
              onCloseMany={closeManyPanes}
              onMove={(id, toIndex) => placePane("middle", id, toIndex)}
              dragEnabled={!isMobile()}
              dragging={draggingPane}
              onDragStart={setDraggingPane}
              onDragEnd={endPointerDrag}
              pointerDrag={pointerDrag}
              onPointerDragStart={beginPointerDrag}
              onPointerDragMove={updatePointerDrag}
              onPointerDragEnd={endPointerDrag}
              addItems={dockCatalog()}
              dropItems={draggablePanes()}
              onAdd={(id) => placePane("middle", id)}
              onRenameSession={renamePaneSession}
              onArchiveSession={archivePaneSession}
              onDeleteSession={deletePaneSession}
            />

            <Show when={rightVisible()}>
              <div data-dock-wrapper="right" class="relative min-w-0 min-h-0" style={{ "grid-area": "right" }}>
                <ResizeHandle
                  direction="horizontal"
                  edge="start"
                  aria-label="Resize right dock"
                  size={dockArea("right").size()}
                  min={220}
                  max={sideMax()}
                  onResize={(size) => resize("right", size)}
                  onCollapse={() => layout.dock.setVisible("right", false)}
                  onPointerDown={() => sizing.start()}
                />
                <DockZone
                  area="right"
                  panes={rightPanes()}
                  active={rightActive()}
                  classList={zoneClass("right")}
                  onActivate={(id) => activate("right", id)}
                  onClose={closePane}
                  onMove={(id, toIndex) => placePane("right", id, toIndex)}
                  dragEnabled={!isMobile()}
                  dragging={draggingPane}
                  onDragStart={setDraggingPane}
                  onDragEnd={endPointerDrag}
                  pointerDrag={pointerDrag}
                  onPointerDragStart={beginPointerDrag}
                  onPointerDragMove={updatePointerDrag}
                  onPointerDragEnd={endPointerDrag}
                  addItems={dockCatalog()}
                  dropItems={draggablePanes()}
                  onAdd={(id) => placePane("right", id)}
                  onRenameSession={renamePaneSession}
                  onArchiveSession={archivePaneSession}
                  onDeleteSession={deletePaneSession}
                />
              </div>
            </Show>

            <Show when={bottomVisible()}>
              <div data-dock-wrapper="bottom" class="relative min-w-0 min-h-0" style={{ "grid-area": "bottom" }}>
                <ResizeHandle
                  direction="vertical"
                  edge="start"
                  aria-label="Resize bottom dock"
                  size={dockArea("bottom").size()}
                  min={100}
                  max={verticalMax()}
                  onResize={(size) => resize("bottom", size)}
                  onCollapse={() => layout.dock.setVisible("bottom", false)}
                  onPointerDown={() => sizing.start()}
                />
                <DockZone
                  area="bottom"
                  panes={bottomPanes()}
                  active={bottomActive()}
                  classList={zoneClass("bottom")}
                  onActivate={(id) => activate("bottom", id)}
                  onClose={closePane}
                  onMove={(id, toIndex) => placePane("bottom", id, toIndex)}
                  dragEnabled={!isMobile()}
                  dragging={draggingPane}
                  onDragStart={setDraggingPane}
                  onDragEnd={endPointerDrag}
                  pointerDrag={pointerDrag}
                  onPointerDragStart={beginPointerDrag}
                  onPointerDragMove={updatePointerDrag}
                  onPointerDragEnd={endPointerDrag}
                  addItems={dockCatalog()}
                  dropItems={draggablePanes()}
                  onAdd={(id) => placePane("bottom", id)}
                  onRenameSession={renamePaneSession}
                  onArchiveSession={archivePaneSession}
                  onDeleteSession={deletePaneSession}
                />
              </div>
            </Show>
          </div>
        </Match>
        <Match when={true}>
          <div
            data-component="session-dock-shell"
            data-layout="mobile-stack"
            data-surface-region={LayoutRegions.popupFirst(true)}
            class="flex-1 min-h-0 flex flex-col"
          >
            <div class="flex-1 min-h-0">
              {content()?.mobileChangesOpen() ? (content()?.mobileChanges ?? props.middle) : props.middle}
            </div>
            <Show when={layout.dock.mobile.opened()}>
              <div
                data-dock-wrapper="mobile"
                class="relative shrink-0 min-h-32 border-t border-border-weaker-base bg-background-stronger flex flex-col"
                style={{ height: `${mobileSize()}px` }}
              >
                <ResizeHandle
                  direction="vertical"
                  edge="start"
                  aria-label="Resize mobile dock"
                  class="mobile-dock-resize-handle"
                  size={mobileSize()}
                  min={MOBILE_DOCK_MIN_SIZE}
                  max={mobileMax()}
                  collapseThreshold={MOBILE_DOCK_COLLAPSE_THRESHOLD}
                  onResize={resizeMobile}
                  onCollapse={() => layout.dock.mobile.close()}
                  onPointerDown={() => sizing.start()}
                />
                <DockZone
                  area="middle"
                  dataArea="mobile"
                  panes={mobilePanes()}
                  active={mobileActive()}
                  classList={{ "flex-1 min-h-0": true }}
                  paneArea={(pane) => itemArea(pane.id, pane.defaultArea, pane.allowedAreas)}
                  attention={(id) => layout.dock.mobile.hasAttention(id)}
                  aggregateAdd
                  onActivate={activateMobile}
                  onClose={closePane}
                  onMove={(id) => placeMobilePane(id)}
                  dragEnabled={false}
                  dragging={draggingPane}
                  onDragStart={setDraggingPane}
                  onDragEnd={endPointerDrag}
                  pointerDrag={pointerDrag}
                  onPointerDragStart={beginPointerDrag}
                  onPointerDragMove={updatePointerDrag}
                  onPointerDragEnd={endPointerDrag}
                  addItems={dockCatalog()}
                  dropItems={draggablePanes()}
                  onAdd={placeMobilePane}
                  onRenameSession={renamePaneSession}
                  onArchiveSession={archivePaneSession}
                  onDeleteSession={deletePaneSession}
                />
              </div>
            </Show>
          </div>
        </Match>
      </Switch>
      <Show when={popupControlPanel()?.paneID} keyed>
        {(paneID) => {
          const initialPanel = popupControlPanel()!
          const panel = () => {
            const current = popupControlPanel()
            if (current?.paneID === paneID) return current
            return initialPanel
          }
          return (
            <SessionControlPanelPopup
              panel={panel()}
              onDock={() => dockControlPanel(panel(), "middle")}
              onPin={(scope) => void pinControlPanel(panel(), "middle", scope).catch(() => undefined)}
              onClose={() => closeControlPanel(panel())}
            />
          )
        }}
      </Show>
    </>
  )
}

function DockSessionPlaceholder(props: { title: string }) {
  return (
    <div class="size-full min-h-0 flex items-center justify-center bg-background-stronger text-13-regular text-text-weak">
      {props.title}
    </div>
  )
}

function keyboardInputElement(element: Element | null) {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element
  if (element instanceof HTMLElement && element.isContentEditable) return element
}

function isDockTabActionTarget(target: EventTarget | null) {
  return (
    target instanceof Element &&
    !!target.closest("[data-action='session-tab-actions'], [data-action='session-tab-menu'], [data-action='session-tab-favorite']")
  )
}

type DockTabMenuProps = {
  favoritePicked: () => boolean
  favoriteLabel: () => string
  favoriteDisabled: () => boolean
  actionDisabled: () => boolean
  onRename: () => void
  onToggleFavorite: () => void
  onArchive: () => void
  onDelete: () => void
  sessionID?: string
  bulkClose?: {
    all: () => void
    left: () => void
    right: () => void
    others: () => void
    leftDisabled: () => boolean
    rightDisabled: () => boolean
    othersDisabled: () => boolean
  }
}

function DockTabMenuContent(props: DockTabMenuProps) {
  const language = useLanguage()
  const copySessionID = () => {
    if (!props.sessionID) return
    void copyText(props.sessionID).then(
      () =>
        showToast({
          variant: "success",
          title: language.t("session.share.copy.copied"),
          description: props.sessionID,
        }),
      () => showToast({ variant: "error", title: language.t("toast.session.share.copyFailed.title") }),
    )
  }

  return (
    <>
      <MenuV2.Item disabled={props.actionDisabled()} onSelect={props.onRename}>
        {language.t("common.rename")}
      </MenuV2.Item>
      <MenuV2.Item disabled={props.favoriteDisabled()} onSelect={props.onToggleFavorite}>
        {props.favoriteLabel()}
      </MenuV2.Item>
      <MenuV2.Item disabled={!props.sessionID} onSelect={copySessionID}>
        {language.t("common.copySessionId")}
      </MenuV2.Item>
      <MenuV2.Separator />
      <Show when={props.bulkClose}>
        {(bulkClose) => (
          <>
            <MenuV2.Item onSelect={bulkClose().all}>{language.t("command.tab.closeAll")}</MenuV2.Item>
            <MenuV2.Item disabled={bulkClose().leftDisabled()} onSelect={bulkClose().left}>
              {language.t("command.tab.closeLeft")}
            </MenuV2.Item>
            <MenuV2.Item disabled={bulkClose().rightDisabled()} onSelect={bulkClose().right}>
              {language.t("command.tab.closeRight")}
            </MenuV2.Item>
            <MenuV2.Item disabled={bulkClose().othersDisabled()} onSelect={bulkClose().others}>
              {language.t("command.tab.closeOthers")}
            </MenuV2.Item>
            <MenuV2.Separator />
          </>
        )}
      </Show>
      <MenuV2.Item disabled={props.actionDisabled()} onSelect={props.onArchive}>
        {language.t("common.archive")}
      </MenuV2.Item>
      <MenuV2.Item disabled={props.actionDisabled()} onSelect={props.onDelete}>
        {language.t("common.delete")}
      </MenuV2.Item>
      <PluginSlotOutlet slot={UI_SLOT_IDS.sessionTabMenu} class="contents" />
    </>
  )
}

function DockTabActions(
  props: DockTabMenuProps & {
    mobile: boolean
    closeLabel: string
    menuLabel: string
    onClose: () => void
  },
) {
  return (
    <div
      class="flex items-center gap-0.5"
      data-action="session-tab-actions"
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => {
        // Cancel the mouse default so a draggable tab ancestor cannot steal the click as a native drag.
        if (!props.mobile) event.preventDefault()
        event.stopPropagation()
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <Show when={props.sessionID}>
        <SessionFavoriteButton
          picked={props.favoritePicked()}
          disabled={props.favoriteDisabled()}
          mobile={props.mobile}
          label={props.favoriteLabel()}
          onToggle={props.onToggleFavorite}
        />
      </Show>
      <MenuV2 gutter={4} modal={false} placement="bottom-end">
        <MenuV2.Trigger
          as={IconButtonV2}
          size="small"
          variant="ghost-muted"
          class={props.mobile ? "!size-11" : "size-5"}
          data-action="session-tab-menu"
          data-session-id={props.sessionID}
          icon={<IconV2 name="outline-dots" />}
          aria-label={props.menuLabel}
          onClick={(event) => event.stopPropagation()}
        />
        <MenuV2.Portal>
          <MenuV2.Content>
            <DockTabMenuContent {...props} />
          </MenuV2.Content>
        </MenuV2.Portal>
      </MenuV2>
      <button
        type="button"
        class="flex items-center justify-center rounded-sm text-icon-weak hover:bg-surface-hover-base hover:text-icon-base focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-strong"
        classList={{ "size-11": props.mobile, "size-5": !props.mobile }}
        aria-label={props.closeLabel}
        onClick={(event) => {
          event.stopPropagation()
          props.onClose()
        }}
      >
        <Icon name="close-small" size="small" />
      </button>
    </div>
  )
}

function SessionDockAvatar(props: {
  project?: () => LocalProject | undefined
  directory?: string
  sessionId?: string
  active?: boolean
  visible?: () => boolean
  sync?: () => ServerSync | undefined
  loading?: () => boolean | undefined
}) {
  if (!props.directory || !props.sessionId) {
    return <Icon name="prompt" size="small" class="text-icon-weak shrink-0" />
  }

  const directory = () => props.directory!
  const sessionId = () => props.sessionId!
  const activeServer = () => props.active !== false
  const project = createMemo(() => props.project?.())
  const state = useSessionTabAvatarState(
    directory,
    sessionId,
    () => activeServer() && (props.visible?.() ?? false),
    props.sync,
    activeServer,
  )
  return (
    <span class="shrink-0" data-slot="project-avatar-slot">
      <ProjectAvatar
        fallback={displayName(project() ?? { worktree: props.directory })}
        src={getProjectAvatarSource(project()?.id, project()?.icon)}
        monochrome={getProjectAvatarMonochrome(project()?.id)}
        variant={getProjectAvatarVariant(project()?.icon?.color)}
        unread={state.unread()}
        loading={!state.status() && ((props.loading?.() ?? false) || state.loading())}
        status={state.status()}
      />
    </span>
  )
}

// Mounts a keepAlive dock pane exactly once and never recreates it, so
// stateful content like the Browser webview survives tab switches. The memo
// only depends on the pane identity and area, never on which tab is active.
function DockKeepAlivePane(props: { pane: DockPane; area: DockArea }) {
  const content = createMemo(() => props.pane.mount({ area: props.area, visible: true }))
  return <>{content()}</>
}

function DockZone(props: {
  area: DockArea
  dataArea?: string
  tabCloseMenu?: boolean
  panes: DockPane[]
  active: string | undefined
  classList: Record<string, boolean>
  style?: JSX.CSSProperties
  paneArea?: (pane: DockPane) => DockArea
  attention?: (id: string) => boolean
  aggregateAdd?: boolean
  onActivate: (id: string) => void
  onClose: (id: string) => void | Promise<void>
  onCloseMany?: (ids: string[]) => void | Promise<void>
  onMove: (id: string, toIndex?: number) => void
  dragEnabled: boolean
  dragging: () => string | undefined
  onDragStart: (id: string | undefined) => void
  onDragEnd: () => void
  pointerDrag: () => { id: string; x: number; y: number; moved: boolean } | undefined
  onPointerDragStart: (id: string, event: PointerEvent) => void
  onPointerDragMove: (event: PointerEvent) => void
  onPointerDragEnd: () => void
  addItems: DockAddMenuItem[]
  dropItems: DockPane[]
  onAdd: (id: string) => void
  onRenameSession: (pane: DockPane) => void
  onArchiveSession: (pane: DockPane) => void
  onDeleteSession: (pane: DockPane) => void
}) {
  const language = useLanguage()
  const sessionFavorites = useSessionFavorites()
  let tabListRef: HTMLDivElement | undefined
  let cancelActiveTabScroll: (() => void) | undefined
  const [tabListWidth, setTabListWidth] = createSignal(0)
  const [tabsOverflow, setTabsOverflow] = createSignal({ start: false, end: false })
  const draggedItem = (event: DragEvent) =>
    event.dataTransfer?.getData("application/x-opencode-dock-pane") || props.dragging()
  const canDrop = (id: string | undefined) => {
    if (!id) return false
    const item =
      props.dropItems.find((candidate) => candidate.id === id) ??
      props.addItems.find((candidate) => candidate.id === id)
    return !!item && canDockInArea(item, props.area)
  }
  const onDragOver = (event: DragEvent) => {
    if (!canDrop(draggedItem(event))) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
  }
  const onDrop = (event: DragEvent, toIndex?: number) => {
    const id = draggedItem(event)
    if (!canDrop(id)) return
    event.preventDefault()
    event.stopPropagation()
    props.onMove(id!, toIndex)
  }
  const onPointerDrop = (event: PointerEvent, toIndex?: number) => {
    if (!props.dragEnabled) return
    props.onPointerDragMove(event)
    const drag = props.pointerDrag()
    if (!drag?.moved) {
      props.onPointerDragEnd()
      return
    }
    if (canDrop(drag.id)) {
      event.preventDefault()
      event.stopPropagation()
      props.onMove(drag.id, toIndex)
    }
    props.onPointerDragEnd()
  }
  const onTabsWheel = (event: WheelEvent) => {
    if (!tabListRef) return
    if (tabListRef.scrollWidth - tabListRef.clientWidth <= 1) return
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
    if (delta === 0) return
    event.preventDefault()
    tabListRef.scrollBy({ left: delta })
  }
  const syncTabsOverflow = () => {
    if (!tabListRef) return
    const overflow = tabListRef.scrollWidth - tabListRef.clientWidth
    setTabsOverflow({ start: tabListRef.scrollLeft > 1, end: tabListRef.scrollLeft < overflow - 1 })
  }
  const scrollTabsToEdge = (direction: -1 | 1) => {
    if (!tabListRef) return
    cancelActiveTabScroll?.()
    cancelActiveTabScroll = undefined
    tabListRef.scrollTo({ left: direction < 0 ? 0 : tabListRef.scrollWidth })
  }
  const closePanes = async (ids: string[], active?: string) => {
    // Start all closes before awaiting navigation transitions. A transition from
    // one session must not prevent the next bulk-close operation from starting.
    await Promise.all(ids.toReversed().map((id) => props.onClose(id)))
    if (active) props.onActivate(active)
  }

  const closeMany = (ids: string[], active?: string) => {
    const result = props.onCloseMany?.(ids) ?? closePanes(ids)
    if (active) return Promise.resolve(result).then(() => props.onActivate(active))
    return result
  }

  const paneKeepAlive = (pane: DockPane) => (typeof pane.keepAlive === "function" ? pane.keepAlive() : pane.keepAlive === true)

  const scrollActiveTabIntoView = (active: string) => {
    const list = tabListRef
    if (!list) return
    const tab = [...list.querySelectorAll<HTMLElement>("[data-dock-tab]")].find(
      (element) => element.dataset.dockTab === active,
    )
    if (!tab) return
    const listRect = list.getBoundingClientRect()
    const target = tab.querySelector<HTMLElement>('[data-action="session-tab-actions"] > :last-child') ?? tab
    const targetRect = target.getBoundingClientRect()
    const overflow = list.scrollWidth - list.clientWidth
    const left = listRect.left + (props.dataArea === "mobile" && list.scrollLeft > 1 ? 24 : 0)
    const right = listRect.right - (props.dataArea === "mobile" && list.scrollLeft < overflow - 1 ? 24 : 0)
    if (targetRect.right > right) list.scrollLeft += targetRect.right - right
    if (targetRect.left < left) list.scrollLeft -= left - targetRect.left
  }

  const scheduleActiveTabScroll = (active: string) => {
    cancelActiveTabScroll?.()
    let secondFrame = 0
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => scrollActiveTabIntoView(active))
    })
    const cancel = () => {
      cancelAnimationFrame(firstFrame)
      if (secondFrame) cancelAnimationFrame(secondFrame)
    }
    cancelActiveTabScroll = cancel
    return cancel
  }

  createEffect(() => {
    const active = props.active
    const panes = props.panes
    tabListWidth()
    if (!active || !panes.some((pane) => pane.id === active)) return
    onCleanup(scheduleActiveTabScroll(active))
  })

  return (
    <section
      data-component="dock-zone"
      data-dock-area={props.dataArea ?? props.area}
      classList={props.classList}
      style={props.style}
      onDragOver={onDragOver}
      onDrop={(event) => onDrop(event)}
      onPointerMove={(event) => props.dragEnabled && props.onPointerDragMove(event)}
      onPointerUp={(event) => onPointerDrop(event)}
    >
      <Show
        when={props.panes.length > 0}
        fallback={
          <div class="size-full min-w-0 min-h-0 bg-background-stronger flex flex-col">
            <div
              class="shrink-0 border-b border-border-weaker-base bg-background-stronger flex items-center justify-end px-1"
              classList={{ "h-11": props.dataArea === "mobile", "h-9": props.dataArea !== "mobile" }}
            >
              <DockAddMenu
                area={props.aggregateAdd ? undefined : props.area}
                label={props.dataArea}
                mobile={props.dataArea === "mobile"}
                items={props.addItems}
                onSelect={props.onAdd}
              />
            </div>
            <div class="flex-1 min-h-0" />
          </div>
        }
      >
        <Tabs
          value={props.active}
          class="size-full min-w-0 min-h-0 flex flex-col"
        >
          <div
            class="relative shrink-0 border-b border-border-weaker-base bg-background-stronger flex items-center"
            classList={{ "h-11": props.dataArea === "mobile", "h-9": props.dataArea !== "mobile" }}
          >
            <Tabs.List
              ref={(el: HTMLDivElement) => {
                tabListRef = el
                el.addEventListener("wheel", onTabsWheel, { passive: false })
                el.addEventListener("scroll", syncTabsOverflow, { passive: true })
                setTabListWidth(el.clientWidth)
                const observer = new ResizeObserver(() => {
                  setTabListWidth(el.clientWidth)
                  syncTabsOverflow()
                })
                observer.observe(el)
                queueMicrotask(syncTabsOverflow)
                const resize = () => {
                  if (props.active) scheduleActiveTabScroll(props.active)
                }
                el.ownerDocument.defaultView?.addEventListener("resize", resize)
                onCleanup(() => {
                  observer.disconnect()
                  el.removeEventListener("wheel", onTabsWheel)
                  el.removeEventListener("scroll", syncTabsOverflow)
                  el.ownerDocument.defaultView?.removeEventListener("resize", resize)
                })
              }}
              onKeyUp={(event: KeyboardEvent) => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
                const id = document.activeElement?.closest("[data-dock-tab]")?.getAttribute("data-dock-tab")
                if (id) props.onActivate(id)
              }}
              class="h-full min-w-0 flex-1 overflow-x-auto bg-transparent border-b-0"
            >
              <For each={props.panes}>
                {(pane, index) => {
                  const menu: DockTabMenuProps = {
                    favoritePicked: () => !!pane.favorite && sessionFavorites.is(pane.favorite),
                    favoriteLabel: () =>
                      pane.favorite && sessionFavorites.is(pane.favorite)
                        ? language.t("command.session.favorite.remove")
                        : language.t("command.session.favorite.add"),
                    favoriteDisabled: () => !pane.favorite,
                    actionDisabled: () => !pane.favorite,
                    onRename: () => props.onRenameSession(pane),
                    onToggleFavorite: () => {
                      if (!pane.favorite) return
                      sessionFavorites.set(pane.favorite, !sessionFavorites.is(pane.favorite))
                    },
                    onArchive: () => props.onArchiveSession(pane),
                    onDelete: () => props.onDeleteSession(pane),
                    sessionID: pane.sessionId,
                    bulkClose: props.tabCloseMenu
                      ? {
                          all: () => closeMany(props.panes.map((item) => item.id)),
                          left: () =>
                            closeMany(
                              props.panes.slice(0, index()).map((item) => item.id),
                              pane.id,
                            ),
                          right: () =>
                            closeMany(
                              props.panes.slice(index() + 1).map((item) => item.id),
                              pane.id,
                            ),
                          others: () =>
                            closeMany(
                              props.panes.filter((item) => item.id !== pane.id).map((item) => item.id),
                              pane.id,
                            ),
                          leftDisabled: () => index() === 0,
                          rightDisabled: () => index() === props.panes.length - 1,
                          othersDisabled: () => props.panes.length === 1,
                        }
                      : undefined,
                  }
                  const trigger = () => (
                    <Tabs.Trigger
                      value={pane.id}
                      class="max-w-52"
                      aria-label={pane.title}
                      title={pane.title}
                      onClick={() => {
                        props.onActivate(pane.id)
                        scrollActiveTabIntoView(pane.id)
                        scheduleActiveTabScroll(pane.id)
                      }}
                      closeButton={
                        <DockTabActions
                          {...menu}
                          mobile={props.dataArea === "mobile"}
                          closeLabel={`Close ${pane.title}`}
                          menuLabel={language.t("common.moreOptions")}
                          onClose={() => props.onClose(pane.id)}
                        />
                      }
                      onMiddleClick={() => props.onClose(pane.id)}
                    >
                      <div class="flex min-w-0 items-center gap-1.5">
                        {pane.leading?.() ?? <Icon name={pane.icon} size="small" class="text-icon-weak shrink-0" />}
                        <span class="truncate">{pane.title}</span>
                        <Show when={props.attention?.(pane.id)}>
                          <span
                            data-dock-attention={pane.id}
                            class="size-1.5 shrink-0 rounded-full bg-surface-info-base"
                            aria-label={`New activity in ${pane.title}`}
                          />
                        </Show>
                      </div>
                    </Tabs.Trigger>
                  )

                  return (
                    <div
                      ref={(el: HTMLDivElement) => {
                        const nativeDragOver = (event: Event) => onDragOver(event as DragEvent)
                        const nativeDrop = (event: Event) => onDrop(event as DragEvent, index())
                        el.addEventListener("dragover", nativeDragOver)
                        el.addEventListener("drop", nativeDrop)
                        onCleanup(() => {
                          el.removeEventListener("dragover", nativeDragOver)
                          el.removeEventListener("drop", nativeDrop)
                        })
                      }}
                      data-dock-tab={pane.id}
                      data-session-id={pane.sessionId}
                      draggable={props.dragEnabled}
                      class="h-full min-w-0 shrink-0"
                      classList={{ "cursor-grab active:cursor-grabbing": props.dragEnabled }}
                      onPointerDown={(event) => {
                        if (!props.dragEnabled && !isDockTabActionTarget(event.target)) props.onActivate(pane.id)
                        if (props.dragEnabled) props.onPointerDragStart(pane.id, event)
                      }}
                      onPointerUp={(event) => onPointerDrop(event, index())}
                      onDragStart={(event) => {
                        if (!props.dragEnabled) return
                        if (isDockTabActionTarget(event.target)) {
                          event.preventDefault()
                          event.stopPropagation()
                          return
                        }
                        props.onDragStart(pane.id)
                        event.dataTransfer?.setData("application/x-opencode-dock-pane", pane.id)
                        event.dataTransfer?.setData("text/plain", pane.id)
                        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"
                      }}
                      onDragEnd={props.onDragEnd}
                    >
                      <Show when={props.tabCloseMenu} fallback={trigger()}>
                        <MenuV2.Context gutter={4} modal={false}>
                          <MenuV2.Context.Trigger class="h-full">{trigger()}</MenuV2.Context.Trigger>
                          <MenuV2.Context.Portal>
                            <MenuV2.Context.Content>
                              <DockTabMenuContent {...menu} />
                            </MenuV2.Context.Content>
                          </MenuV2.Context.Portal>
                        </MenuV2.Context>
                      </Show>
                    </div>
                  )
                }}
              </For>
            </Tabs.List>
            <Show when={props.dataArea === "mobile" && (tabsOverflow().start || tabsOverflow().end)}>
              <button
                type="button"
                data-dock-tabs-scroll="left"
                class="absolute left-0 top-0 z-10 flex h-full w-6 items-center justify-center border-r border-border-weaker-base bg-background-stronger text-icon-weak hover:text-icon-base disabled:invisible"
                disabled={!tabsOverflow().start}
                aria-label="Scroll dock tabs left"
                onClick={() => scrollTabsToEdge(-1)}
              >
                <Icon name="chevron-left" size="small" />
              </button>
              <button
                type="button"
                data-dock-tabs-scroll="right"
                class="absolute right-12 top-0 z-10 flex h-full w-6 items-center justify-center border-l border-border-weaker-base bg-background-stronger text-icon-weak hover:text-icon-base disabled:invisible"
                disabled={!tabsOverflow().end}
                aria-label="Scroll dock tabs right"
                onClick={() => scrollTabsToEdge(1)}
              >
                <Icon name="chevron-right" size="small" />
              </button>
            </Show>
            <DockAddMenu
              area={props.aggregateAdd ? undefined : props.area}
              label={props.dataArea}
              mobile={props.dataArea === "mobile"}
              items={props.addItems}
              onSelect={props.onAdd}
            />
          </div>
          <Index each={props.panes}>
            {(pane) => (
              <Tabs.Content
                value={pane().id}
                data-dock-pane={pane().id}
                forceMount={paneKeepAlive(pane())}
                class="flex-1 min-h-0 overflow-hidden contain-strict"
                classList={{
                  hidden: paneKeepAlive(pane()) && props.active !== pane().id,
                }}
              >
                <Show
                  when={paneKeepAlive(pane())}
                  fallback={
                    <Show when={props.active === pane().id}>
                      {pane().mount({ area: props.paneArea?.(pane()) ?? props.area, visible: true })}
                    </Show>
                  }
                >
                  <DockKeepAlivePane pane={pane()} area={props.paneArea?.(pane()) ?? props.area} />
                </Show>
              </Tabs.Content>
            )}
          </Index>
        </Tabs>
      </Show>
    </section>
  )
}

function DockAddMenu(props: {
  area: DockArea | undefined
  label?: string
  mobile?: boolean
  items: DockAddMenuItem[]
  onSelect: (id: string) => void
}) {
  let root: HTMLDivElement | undefined
  let menu: HTMLDivElement | undefined
  let input: HTMLInputElement | undefined
  const [open, setOpen] = createSignal(false)
  const [query, setQuery] = createSignal("")
  const [active, setActive] = createSignal(0)
  const [position, setPosition] = createSignal({
    left: 0,
    top: 0,
    width: 288,
    maxHeight: 360,
  })
  let pointerGesture:
    | {
        id: number
        target: HTMLElement
        x: number
        y: number
        moved: boolean
      }
    | undefined
  let compatibilityClickTarget: HTMLElement | undefined
  let compatibilityClickTimer: number | undefined
  const items = createMemo(() => filterDockAddItems(props.items, props.area, query()))

  const updatePosition = () => {
    if (!root || typeof window === "undefined") return
    const rect = root.getBoundingClientRect()
    const viewport = visualViewportBounds(window)
    const margin = 8
    const gap = 6
    const width = Math.min(288, Math.max(0, viewport.width - margin * 2))
    const below = Math.max(0, viewport.bottom - rect.bottom - margin - gap)
    const above = Math.max(0, rect.top - viewport.top - margin - gap)
    const openAbove = below < 260 && above > below
    const maxHeight = Math.min(380, openAbove ? above : below)
    const left = Math.min(
      Math.max(viewport.left + margin, rect.right - width),
      Math.max(viewport.left + margin, viewport.right - width - margin),
    )
    const top = openAbove
      ? Math.max(viewport.top + margin, rect.top - maxHeight - gap)
      : Math.min(rect.bottom + gap, viewport.bottom - maxHeight - margin)
    setPosition({ left, top, width, maxHeight })
  }

  const close = () => {
    setOpen(false)
    setQuery("")
    setActive(0)
  }

  const select = (item: DockAddMenuItem | undefined) => {
    if (!item) return
    props.onSelect(item.id)
    close()
  }

  const toggle = () => {
    const next = !open()
    setOpen(next)
    if (!next) return
    queueMicrotask(() => {
      updatePosition()
      input?.focus()
    })
  }
  const onActivationPointerDown = (event: PointerEvent) => {
    if (
      !props.mobile ||
      !event.isPrimary ||
      event.button !== 0 ||
      (event.pointerType !== "touch" && event.pointerType !== "pen") ||
      event.defaultPrevented ||
      !(event.currentTarget instanceof HTMLElement) ||
      pointerGesture
    )
      return
    pointerGesture = {
      id: event.pointerId,
      target: event.currentTarget,
      x: event.clientX,
      y: event.clientY,
      moved: false,
    }
  }
  const onActivationPointerMove = (event: PointerEvent) => {
    if (!pointerGesture || pointerGesture.id !== event.pointerId || pointerGesture.target !== event.currentTarget) return
    if ((event.clientX - pointerGesture.x) ** 2 + (event.clientY - pointerGesture.y) ** 2 > 100)
      pointerGesture.moved = true
  }
  const cancelPointerGesture = (event: PointerEvent) => {
    if (pointerGesture?.id !== event.pointerId) return
    pointerGesture = undefined
  }
  const onActivationPointerUp = (event: PointerEvent, activate: () => void) => {
    const gesture = pointerGesture
    if (
      !gesture ||
      gesture.id !== event.pointerId ||
      gesture.target !== event.currentTarget ||
      (event.pointerType !== "touch" && event.pointerType !== "pen")
    )
      return
    pointerGesture = undefined
    if (
      !event.isPrimary ||
      event.button !== 0 ||
      gesture.moved ||
      event.defaultPrevented
    )
      return
    const hit = document.elementFromPoint(event.clientX, event.clientY)
    if (hit && !gesture.target.contains(hit)) return
    compatibilityClickTarget = gesture.target
    if (compatibilityClickTimer !== undefined) window.clearTimeout(compatibilityClickTimer)
    compatibilityClickTimer = window.setTimeout(() => {
      if (compatibilityClickTarget === gesture.target) compatibilityClickTarget = undefined
      compatibilityClickTimer = undefined
    }, 0)
    activate()
  }
  const onActivationClick = (event: MouseEvent, activate: () => void) => {
    if (event.detail > 0 && compatibilityClickTarget === event.currentTarget) {
      compatibilityClickTarget = undefined
      if (compatibilityClickTimer !== undefined) window.clearTimeout(compatibilityClickTimer)
      compatibilityClickTimer = undefined
      return
    }
    activate()
  }

  onCleanup(() => {
    if (compatibilityClickTimer !== undefined) window.clearTimeout(compatibilityClickTimer)
  })

  createEffect(() => {
    const count = items().length
    if (active() < count) return
    setActive(Math.max(0, count - 1))
  })

  createEffect(() => {
    if (!open()) return
    updatePosition()
    const syncPosition = () => updatePosition()
    window.addEventListener("resize", syncPosition)
    window.addEventListener("scroll", syncPosition, true)
    window.visualViewport?.addEventListener("resize", syncPosition)
    window.visualViewport?.addEventListener("scroll", syncPosition)
    document.addEventListener(DIALOG_OPEN_EVENT, close)
    const onPointerDown = (event: PointerEvent) => {
      if (!root || !menu) return
      if (event.target instanceof Node && root.contains(event.target)) return
      if (event.target instanceof Node && menu.contains(event.target)) return
      close()
    }
    document.addEventListener("pointerdown", onPointerDown)
    onCleanup(() => {
      window.removeEventListener("resize", syncPosition)
      window.removeEventListener("scroll", syncPosition, true)
      window.visualViewport?.removeEventListener("resize", syncPosition)
      window.visualViewport?.removeEventListener("scroll", syncPosition)
      document.removeEventListener(DIALOG_OPEN_EVENT, close)
      document.removeEventListener("pointerdown", onPointerDown)
    })
  })

  const onKeyDown = (event: KeyboardEvent) => {
    if (!open()) return
    if (event.key === "Escape") {
      event.preventDefault()
      close()
      return
    }

    if (event.key === "ArrowDown") {
      event.preventDefault()
      setActive((value) => Math.min(value + 1, Math.max(0, items().length - 1)))
      return
    }

    if (event.key === "ArrowUp") {
      event.preventDefault()
      setActive((value) => Math.max(0, value - 1))
      return
    }

    if (event.key === "Enter") {
      event.preventDefault()
      select(items()[active()])
    }
  }

  return (
    <div ref={root} class="relative shrink-0 px-1" onKeyDown={onKeyDown}>
      <button
        type="button"
        class="rounded-md flex items-center justify-center text-icon-weak hover:text-icon-base hover:bg-surface-hover-base focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-strong"
        classList={{ "size-11": props.mobile, "size-7": !props.mobile }}
        data-action={props.mobile ? "mobile-dock-add" : undefined}
        data-mobile-touch-target={props.mobile ? true : undefined}
        aria-label={`Add dock item to ${props.label ?? props.area ?? "mobile"}`}
        aria-expanded={open()}
        onPointerDown={onActivationPointerDown}
        onPointerMove={onActivationPointerMove}
        onPointerCancel={cancelPointerGesture}
        onLostPointerCapture={cancelPointerGesture}
        onPointerUp={(event) => onActivationPointerUp(event, toggle)}
        onClick={(event) => onActivationClick(event, toggle)}
      >
        <Icon name="plus-small" size="small" />
      </button>
      <Show when={open()}>
        <Portal>
          <div
            ref={menu}
            data-component="dock-add-menu"
            data-mobile-dock-overlay={props.mobile ? "true" : undefined}
            class="fixed z-[1900] max-h-full overflow-hidden rounded-lg border border-border-weak-base bg-surface-raised-stronger-non-alpha text-text-base shadow-[var(--v2-elevation-raised)] p-2 flex flex-col"
            style={{
              left: `${position().left}px`,
              top: `${position().top}px`,
              width: `${position().width}px`,
              "max-height": `${position().maxHeight}px`,
            }}
            onKeyDown={onKeyDown}
          >
            <div class="shrink-0 flex items-center gap-2 rounded-md border border-border-weak-base bg-background-base px-2">
              <Icon name="magnifying-glass" size="small" class="text-icon-weak shrink-0" />
              <input
                ref={input}
                aria-label="Search dock items"
                class="h-11 min-w-0 flex-1 bg-transparent text-13-regular text-text-base outline-none placeholder:text-text-disabled"
                placeholder="Search panes"
                value={query()}
                onInput={(event) => {
                  setQuery(event.currentTarget.value)
                  setActive(0)
                }}
              />
            </div>
            <div class="mt-2 min-h-0 flex-1 overflow-y-auto">
              <Show
                when={items().length > 0}
                fallback={<div class="px-2 py-4 text-center text-12-regular text-text-weak">No panes found</div>}
              >
                <For each={items()}>
                  {(item, index) => (
                    <button
                      type="button"
                      data-dock-add-item={item.id}
                      class="w-full min-w-0 rounded-md px-2 py-2 text-left flex items-center gap-2 hover:bg-surface-hover-base focus-visible:outline-none"
                      classList={{
                        "bg-surface-hover-base": index() === active(),
                      }}
                      onMouseEnter={() => setActive(index())}
                      onPointerDown={onActivationPointerDown}
                      onPointerMove={onActivationPointerMove}
                      onPointerCancel={cancelPointerGesture}
                      onLostPointerCapture={cancelPointerGesture}
                      onPointerUp={(event) => onActivationPointerUp(event, () => select(item))}
                      onClick={(event) => onActivationClick(event, () => select(item))}
                    >
                      <Icon name={item.icon} size="small" class="text-icon-weak shrink-0" />
                      <span class="min-w-0 flex-1">
                        <span class="block truncate text-13-medium text-text-base">{item.title}</span>
                        <span class="block truncate text-11-regular text-text-weak">{item.category}</span>
                      </span>
                    </button>
                  )}
                </For>
              </Show>
            </div>
          </div>
        </Portal>
      </Show>
    </div>
  )
}
