import { createStore, produce, reconcile } from "solid-js/store"
import { batch, createEffect, createMemo, createSignal, onCleanup, onMount, type Accessor } from "solid-js"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { makeEventListener } from "@solid-primitives/event-listener"
import { useServerSync } from "./server-sync"
import { useServerSDK } from "./server-sdk"
import { ServerConnection, useServer } from "./server"
import { usePlatform } from "./platform"
import type { Project } from "@opencode-ai/sdk/v2"
import { Persist, persisted, removePersisted } from "@/utils/persist"
import { decode64 } from "@/utils/base64"
import { same } from "@/utils/same"
import { createScrollPersistence, type SessionScroll } from "./layout-scroll"
import { createPathHelpers } from "./file/path"
import type { ProjectAvatarVariant } from "@opencode-ai/ui/v2/project-avatar-v2"
import { migrateLegacySessionStateKeys, ServerScope, SessionStateKey } from "@/utils/server-scope"
import {
  handoffRequestKey,
  hasHandoffRequestInSession,
  isHandoffRequestIdentity,
  type HandoffRequestIdentity,
} from "@/utils/handoff-request"
import { showToast } from "@/utils/toast"
import { createSessionKeyReader, ensureSessionKey, pruneSessionKeys } from "./layout-helpers"
import { migrateControlPanelLayout } from "./migrate-control-panel-layout"
import {
  DOCK_AREAS,
  MOBILE_DOCK_MEDIA_QUERY,
  migrateDockState,
  repairedActiveAfterClose,
  removeDockItemState,
  replaceDockItemState,
  type DockArea,
  type DockItemRequest,
} from "./layout-dock"
import { useSessionRoute } from "@/context/session-route"

export { createSessionKeyReader, ensureSessionKey, pruneSessionKeys }

export type { ProjectAvatarVariant }

const AVATAR_COLOR_KEYS = ["pink", "mint", "orange", "purple", "cyan", "lime"] as const
const DEFAULT_SIDEBAR_WIDTH = 344
const DEFAULT_FILE_TREE_WIDTH = 200
const DEFAULT_SESSION_WIDTH = 600
const DEFAULT_TERMINAL_HEIGHT = 280
export type AvatarColorKey = (typeof AVATAR_COLOR_KEYS)[number]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export function getAvatarColors(key?: string) {
  if (key && AVATAR_COLOR_KEYS.includes(key as AvatarColorKey)) {
    return {
      background: `var(--avatar-background-${key})`,
      foreground: `var(--avatar-text-${key})`,
    }
  }
  return {
    background: "var(--surface-info-base)",
    foreground: "var(--text-base)",
  }
}

export function getProjectAvatarVariant(key?: string): ProjectAvatarVariant {
  if (key === "orange") return "orange"
  if (key === "pink") return "pink"
  if (key === "cyan") return "cyan"
  if (key === "purple") return "purple"
  if (key === "mint") return "cyan"
  if (key === "lime") return "green"
  return "gray"
}

type SessionTabs = {
  active?: string
  all: string[]
}

type SessionView = {
  scroll: Record<string, SessionScroll>
  reviewOpen?: string[]
  pendingMessage?: string
  pendingMessageAt?: number
  todoCollapsed?: boolean
}

type TabHandoff = {
  scope: ServerScope
  dir: string
  id: string
  at: number
}

export type StoredControlPanel = {
  id: string
  directory: string
  sessionID: string
  messageID: string
  partID: string
  controlID: string
  title?: string
  data: unknown
}

export type LocalProject = Partial<Project> & { worktree: string; expanded: boolean }

export type ReviewDiffStyle = "unified" | "split"

export type LayoutRoute =
  | { type: "home" }
  | { type: "draft"; draftID: string; server?: ServerConnection.Key }
  | { type: "dir-new-session"; dir: string; dirBase64: string; server?: ServerConnection.Key }
  | { type: "session"; dir: string; dirBase64: string; sessionId: string; server?: ServerConnection.Key }

function nextSessionTabsForOpen(current: SessionTabs | undefined, tab: string): SessionTabs {
  const all = current?.all ?? []
  if (tab === "review") return { all: all.filter((x) => x !== "review"), active: tab }
  if (tab === "context") return { all: [tab, ...all.filter((x) => x !== tab)], active: tab }
  if (!all.includes(tab)) return { all: [...all, tab], active: tab }
  return { all, active: tab }
}

const sessionPath = (key: string) => {
  const dir = SessionStateKey.route(key).split("/")[0]
  if (!dir) return
  const root = decode64(dir)
  if (!root) return
  return createPathHelpers(() => root)
}

const normalizeSessionTab = (path: ReturnType<typeof createPathHelpers> | undefined, tab: string) => {
  if (!tab.startsWith("file://")) return tab
  if (!path) return tab
  return path.tab(tab)
}

const normalizeSessionTabList = (path: ReturnType<typeof createPathHelpers> | undefined, all: string[]) => {
  const seen = new Set<string>()
  return all.flatMap((tab) => {
    const value = normalizeSessionTab(path, tab)
    if (seen.has(value)) return []
    seen.add(value)
    return [value]
  })
}

const normalizeStoredSessionTabs = (key: string, tabs: SessionTabs) => {
  const path = sessionPath(key)
  return {
    all: normalizeSessionTabList(path, tabs.all),
    active: tabs.active ? normalizeSessionTab(path, tabs.active) : tabs.active,
  }
}

export const { use: useLayout, provider: LayoutProvider } = createSimpleContext({
  name: "Layout",
  gate: false,
  init: () => {
    const serverSdk = useServerSDK()
    const serverSync = useServerSync()
    const server = useServer()
    const platform = usePlatform()
    const params = useSessionRoute()
    const route = createMemo(() => {
      const dirBase64 = params.dir
      if (!dirBase64) return { type: "home" as const }
      const dir = decode64(dirBase64)
      if (!dir) return { type: "home" as const }
      const id = params.id
      if (id) return { type: "session" as const, dir, dirBase64, sessionId: id, server: server.key }
      return { type: "dir-new-session" as const, dir, dirBase64, server: server.key }
    })

    const migrate = (value: unknown) => {
      if (!isRecord(value)) return value

      const sidebar = value.sidebar
      const migratedSidebar = (() => {
        if (!isRecord(sidebar)) return sidebar
        if (typeof sidebar.workspaces !== "boolean") return sidebar
        return {
          ...sidebar,
          workspaces: {},
          workspacesDefault: sidebar.workspaces,
        }
      })()

      const review = value.review
      const fileTree = value.fileTree
      const migratedFileTree = (() => {
        if (!isRecord(fileTree)) return fileTree
        if (fileTree.tab === "changes" || fileTree.tab === "all") return fileTree

        const width = typeof fileTree.width === "number" ? fileTree.width : DEFAULT_FILE_TREE_WIDTH
        return {
          ...fileTree,
          opened: true,
          width: width === 260 ? DEFAULT_FILE_TREE_WIDTH : width,
          tab: "changes",
        }
      })()

      const migratedReview = (() => {
        if (!isRecord(review)) return review
        if (typeof review.panelOpened === "boolean") return review

        const opened = isRecord(fileTree) && typeof fileTree.opened === "boolean" ? fileTree.opened : true
        return {
          ...review,
          panelOpened: opened,
        }
      })()

      const sessionTabs = migrateLegacySessionStateKeys(value.sessionTabs)
      const sessionView = migrateLegacySessionStateKeys(value.sessionView)
      const migratedDockInput = {
        ...value,
        review: migratedReview,
        fileTree: migratedFileTree,
        sessionTabs,
        sessionView,
      }
      const migratedSessionTabs = (() => {
        if (!isRecord(sessionTabs)) return sessionTabs

        let changed = false
        const next = Object.fromEntries(
          Object.entries(sessionTabs).map(([key, tabs]) => {
            if (!isRecord(tabs) || !Array.isArray(tabs.all)) return [key, tabs]

            const current = {
              all: tabs.all.filter((tab): tab is string => typeof tab === "string"),
              active: typeof tabs.active === "string" ? tabs.active : undefined,
            }
            const normalized = normalizeStoredSessionTabs(key, current)
            if (current.all.length !== tabs.all.length) changed = true
            if (!same(current.all, normalized.all) || current.active !== normalized.active) changed = true
            if (tabs.active !== undefined && typeof tabs.active !== "string") changed = true
            return [key, normalized]
          }),
        )

        if (!changed) return sessionTabs
        return next
      })()
      const migratedHome = (() => {
        const home = value.home
        if (!isRecord(home)) return { selection: { server: server.key } }
        const selection = home.selection
        if (!isRecord(selection) || typeof selection.server !== "string") return { selection: { server: server.key } }
        return home
      })()
      const controlPanels = isRecord(value.controlPanels) ? value.controlPanels : undefined
      const {
        dock: migratedDockWithPanels,
        dockChanged: migratedDockChanged,
        controlPanels: migratedControlPanels,
      } = migrateControlPanelLayout({ ...migratedDockInput, controlPanels })

      if (
        migratedSidebar === sidebar &&
        migratedReview === review &&
        migratedFileTree === fileTree &&
        !migratedDockChanged &&
        migratedSessionTabs === value.sessionTabs &&
        sessionView === value.sessionView &&
        migratedHome === value.home &&
        migratedControlPanels === controlPanels
      ) {
        return value
      }

      return {
        ...value,
        sidebar: migratedSidebar,
        review: migratedReview,
        fileTree: migratedFileTree,
        dock: migratedDockWithPanels,
        sessionTabs: migratedSessionTabs,
        sessionView,
        home: migratedHome,
        controlPanels: migratedControlPanels,
      }
    }

    const target = Persist.serverGlobal(serverSdk().scope, "layout", ["layout.v6"])
    const [store, setStore, _, ready] = persisted(
      { ...target, migrate },
      createStore({
        sidebar: {
          opened: false,
          width: DEFAULT_SIDEBAR_WIDTH,
          workspaces: {} as Record<string, boolean>,
          workspacesDefault: false,
        },
        terminal: {
          height: DEFAULT_TERMINAL_HEIGHT,
          opened: false,
        },
        review: {
          diffStyle: "split" as ReviewDiffStyle,
          panelOpened: true,
        },
        fileTree: {
          opened: false,
          width: DEFAULT_FILE_TREE_WIDTH,
          tab: "changes" as "changes" | "all",
        },
        session: {
          width: DEFAULT_SESSION_WIDTH,
        },
        dock: migrateDockState({}),
        mobileSidebar: {
          opened: false,
        },
        sessionTabs: {} as Record<string, SessionTabs>,
        sessionView: {} as Record<string, SessionView>,
        handoff: {
          tabs: undefined as TabHandoff | undefined,
        },
        handoffCleanup: {} as Record<string, HandoffRequestIdentity>,
        controlPanels: {
          closed: {} as Record<string, true>,
          pinned: {} as Record<string, StoredControlPanel>,
        },
        home: {
          selection: { server: server.key } as { server: ServerConnection.Key; directory?: string },
        },
      }),
    )
    const [mobileDock, setMobileDock] = createStore({
      opened: false,
      attention: {} as Record<string, true>,
    })
    const [registeredDockPaneIDs, setRegisteredDockPaneIDs] = createSignal<Set<string>>(new Set())
    const [dismissedHandoffs, setDismissedHandoffs] = createStore<Record<string, true>>({})
    const [visibleHandoffRequestKeys, setVisibleHandoffRequestKeys] = createSignal<string[]>([], {
      equals: (previous, next) => previous.length === next.length && previous.every((key, index) => key === next[index]),
    })
    const handoffCleanupInFlight = new Map<string, Promise<void>>()
    const handoffCleanupRecovered = new Set<string>()

    const clearHandoffCleanup = (request: HandoffRequestIdentity) => {
      const key = handoffRequestKey(request)
      if (!store.handoffCleanup?.[key]) return
      setStore(
        "handoffCleanup",
        produce((draft) => {
          delete draft[key]
        }),
      )
    }

    const retryHandoffCleanup = (request: HandoffRequestIdentity) => {
      const key = handoffRequestKey(request)
      setDismissedHandoffs(key, true)
      const current = handoffCleanupInFlight.get(key)
      if (current) return current

      const task = (async () => {
        const client = serverSdk().createClient({ directory: request.directory, throwOnError: true })
        const pending = await client.v2.session.surface.list({ sessionID: request.sessionID })
        const requests = pending.data?.data
        if (!requests) throw new Error("Could not confirm whether the handoff request is still pending.")
        if (!requests.some((item) => item.id === request.requestID)) {
          clearHandoffCleanup(request)
          return
        }
        await client.v2.session.surface.dismiss({ sessionID: request.sessionID, requestID: request.requestID })
        clearHandoffCleanup(request)
      })()
        .catch((cause) => {
          showToast({
            variant: "error",
            persistent: true,
            title: "Agent switch started; cleanup failed",
            description: `The completed handoff remains closed. Retry cleanup to remove its request; this will not repeat the agent switch. ${cause instanceof Error ? cause.message : String(cause)}`,
            actions: [{ label: "Retry cleanup", onClick: () => void retryHandoffCleanup(request) }],
          })
        })
        .finally(() => handoffCleanupInFlight.delete(key))
      handoffCleanupInFlight.set(key, task)
      return task
    }

    const dismissHandoffRequest = (request: HandoffRequestIdentity) => {
      const key = handoffRequestKey(request)
      batch(() => {
        setDismissedHandoffs(key, true)
        setStore("handoffCleanup", key, request)
      })
      handoffCleanupRecovered.add(key)
      return retryHandoffCleanup(request)
    }

    createEffect(() => {
      if (!ready()) return
      Object.values(store.handoffCleanup ?? {}).forEach((request) => {
        if (!isHandoffRequestIdentity(request)) return
        const key = handoffRequestKey(request)
        setDismissedHandoffs(key, true)
        if (handoffCleanupRecovered.has(key)) return
        handoffCleanupRecovered.add(key)
        void retryHandoffCleanup(request)
      })
    })

    const MAX_SESSION_KEYS = 50
    const PENDING_MESSAGE_TTL_MS = 2 * 60 * 1000
    const usage = {
      active: undefined as string | undefined,
      pruned: false,
      used: new Map<string, number>(),
    }

    const SESSION_STATE_KEYS = [
      { key: "prompt", legacy: "prompt", version: "v2" },
      { key: "terminal", legacy: "terminal", version: "v1" },
      { key: "file-view", legacy: "file", version: "v1" },
    ] as const

    const dropSessionState = (keys: string[]) => {
      for (const key of keys) {
        const scope = SessionStateKey.scope(key)
        const parts = SessionStateKey.route(key).split("/")
        const dir = parts[0]
        const session = parts[1]
        if (!dir) continue

        for (const entry of SESSION_STATE_KEYS) {
          const target = session
            ? Persist.serverSession(scope, dir, session, entry.key)
            : Persist.serverWorkspace(scope, dir, entry.key)
          void removePersisted(target, platform)

          if (scope !== ServerScope.local) continue
          const legacyKey = `${dir}/${entry.legacy}${session ? "/" + session : ""}.${entry.version}`
          void removePersisted({ key: legacyKey }, platform)
        }
      }
    }

    function prune(keep?: string) {
      const drop = pruneSessionKeys({
        keep,
        max: MAX_SESSION_KEYS,
        used: usage.used,
        view: Object.keys(store.sessionView),
        tabs: Object.keys(store.sessionTabs),
      })
      if (drop.length === 0) return

      setStore(
        produce((draft) => {
          for (const key of drop) {
            delete draft.sessionView[key]
            delete draft.sessionTabs[key]
          }
        }),
      )

      scroll.drop(drop)
      dropSessionState(drop)

      for (const key of drop) {
        usage.used.delete(key)
      }
    }

    function touch(sessionKey: string) {
      usage.active = sessionKey
      usage.used.set(sessionKey, Date.now())

      if (!ready()) return
      if (usage.pruned) return

      usage.pruned = true
      prune(sessionKey)
    }

    const scroll = createScrollPersistence({
      debounceMs: 250,
      getSnapshot: (sessionKey) => store.sessionView[sessionKey]?.scroll,
      onFlush: (sessionKey, next) => {
        const current = store.sessionView[sessionKey]
        const keep = usage.active ?? sessionKey
        if (!current) {
          setStore("sessionView", sessionKey, { scroll: next })
          prune(keep)
          return
        }

        setStore("sessionView", sessionKey, "scroll", (prev) => ({ ...prev, ...next }))
        prune(keep)
      },
    })

    const ensureKey = (key: string) => ensureSessionKey(key, touch, (sessionKey) => scroll.seed(sessionKey))

    createEffect(() => {
      if (!ready()) return
      if (usage.pruned) return
      const active = usage.active
      if (!active) return
      usage.pruned = true
      prune(active)
    })

    onMount(() => {
      const flush = () => batch(() => scroll.flushAll())
      const handleVisibility = () => {
        if (document.visibilityState !== "hidden") return
        flush()
      }

      makeEventListener(window, "pagehide", flush)
      makeEventListener(document, "visibilitychange", handleVisibility)

      onCleanup(() => {
        scroll.dispose()
      })
    })

    const [colors, setColors] = createStore<Record<string, AvatarColorKey>>({})

    function pickAvailableColor(used: Set<string>): AvatarColorKey {
      const available = AVATAR_COLOR_KEYS.filter((c) => !used.has(c))
      if (available.length === 0) return AVATAR_COLOR_KEYS[Math.floor(Math.random() * AVATAR_COLOR_KEYS.length)]
      return available[Math.floor(Math.random() * available.length)]
    }

    function enrich(project: LocalProject): LocalProject {
      const metadata = serverSync().data.project.find((x) => x.worktree === project.worktree)
      return {
        ...metadata,
        ...project,
        icon: metadata?.icon ? { ...project.icon, ...metadata.icon } : project.icon,
        iconGeneration: metadata?.iconGeneration,
      }
    }

    const roots = createMemo(() => {
      const map = new Map<string, string>()
      for (const project of serverSync().data.project) {
        const sandboxes = project.sandboxes ?? []
        for (const sandbox of sandboxes) {
          map.set(sandbox, project.worktree)
        }
      }
      return map
    })

    const rootFor = (directory: string) => {
      const map = roots()
      if (map.size === 0) return directory

      const visited = new Set<string>()
      const chain = [directory]

      while (chain.length) {
        const current = chain[chain.length - 1]
        if (!current) return directory

        const next = map.get(current)
        if (!next) return current

        if (visited.has(next)) return directory
        visited.add(next)
        chain.push(next)
      }

      return directory
    }

    createEffect(() => {
      const projects = server.projects.list()
      const seen = new Set(projects.map((project) => project.worktree))

      batch(() => {
        for (const project of projects) {
          const root = rootFor(project.worktree)
          if (root === project.worktree) continue

          server.projects.close(project.worktree)

          if (!seen.has(root)) {
            server.projects.open(root)
            seen.add(root)
          }

          if (project.expanded) server.projects.expand(root)
        }
      })
    })

    const enriched = createMemo(() => server.projects.list().map(enrich))
    const list = createMemo(() => {
      const projects = enriched()
      return projects.map((project) => {
        const color = project.icon?.color ?? colors[project.worktree]
        if (!color) return project
        const icon = project.icon ? { ...project.icon, color } : { color }
        return { ...project, icon }
      })
    })

    createEffect(() => {
      const projects = enriched()
      if (projects.length === 0) return

      const used = new Set<string>()
      for (const project of projects) {
        const color = project.icon?.color ?? colors[project.worktree]
        if (color) used.add(color)
      }

      for (const project of projects) {
        if (project.icon?.color || project.icon?.override || project.icon?.url) continue
        const worktree = project.worktree
        const existing = colors[worktree]
        const color = existing ?? pickAvailableColor(used)
        if (!existing) {
          used.add(color)
          setColors(worktree, color)
        }
      }
    })

    function addDockTab(tabs: string[], id: string) {
      if (tabs.includes(id)) return tabs
      return [...tabs, id]
    }

    function removeDockTab(tabs: string[], id: string) {
      return tabs.filter((item) => item !== id)
    }

    function reorderDockTab(tabs: string[], id: string, toIndex?: number) {
      const next = tabs.filter((item) => item !== id)
      if (toIndex === undefined || toIndex < 0 || toIndex >= next.length) return [...next, id]
      return [...next.slice(0, toIndex), id, ...next.slice(toIndex)]
    }

    function ensureDockItem(id: string, area: DockArea, visible: boolean) {
      if (store.dock.items[id]) return
      batch(() => {
        setStore("dock", "items", id, { area, visible })
        setStore("dock", area, "tabs", addDockTab(store.dock[area].tabs, id))
      })
    }

    function ensureDockItemState(id: string, fallback: DockArea, visible: boolean) {
      const area = store.dock.items[id]?.area ?? fallback
      if (store.dock.items[id]) return area
      setStore("dock", "items", id, { area, visible })
      setStore("dock", area, "tabs", addDockTab(store.dock[area].tabs, id))
      return area
    }

    function dockItemVisible(id: string, visible: boolean, changedID: string) {
      if (id === changedID) return visible
      return store.dock.items[id]?.visible ?? false
    }

    function syncLegacyDockItem(id: string, visible: boolean) {
      if (id === "terminal") {
        if (!store.terminal) {
          setStore("terminal", { height: DEFAULT_TERMINAL_HEIGHT, opened: visible })
          return
        }
        setStore("terminal", "opened", visible)
        return
      }

      if (id === "review") {
        if (!store.review) {
          setStore("review", { diffStyle: "split" as ReviewDiffStyle, panelOpened: visible })
          return
        }
        setStore("review", "panelOpened", visible)
        return
      }

      if (id === "fileTree" || id === "gitChanges") {
        const next = dockItemVisible("fileTree", visible, id) || dockItemVisible("gitChanges", visible, id)
        if (!store.fileTree) {
          setStore("fileTree", {
            opened: next,
            width: DEFAULT_FILE_TREE_WIDTH,
            tab: id === "fileTree" ? "all" : "changes",
          })
          return
        }
        setStore("fileTree", "opened", next)
      }
    }

    function moveDockItem(id: string, area: DockArea, toIndex?: number) {
      const item = store.dock.items[id]
      const visible = item?.visible ?? true
      const previous = item?.area
      batch(() => {
        setStore("dock", "items", id, { area, visible })
        setStore("dock", area, "tabs", reorderDockTab(store.dock[area].tabs, id, toIndex))
        if (previous && previous !== area) {
          const nextTabs = removeDockTab(store.dock[previous].tabs, id)
          setStore("dock", previous, "tabs", nextTabs)
          if (store.dock[previous].active === id) setStore("dock", previous, "active", nextTabs[0])
        }
      })
    }

    function clearMobileDockAttention(id: string) {
      if (!mobileDock.attention[id]) return
      setMobileDock(
        "attention",
        produce((draft) => {
          delete draft[id]
        }),
      )
    }

    function repairMobileDockActiveItem(id: string) {
      if (store.dock.mobile.activeItem !== id) return
      const registered = registeredDockPaneIDs()
      const next = DOCK_AREAS.flatMap((area) => store.dock[area].tabs).find(
        (candidate) =>
          candidate !== id &&
          candidate !== "session" &&
          !candidate.startsWith("tab:") &&
          registered.has(candidate) &&
          store.dock.items[candidate]?.visible,
      )
      setStore("dock", "mobile", "activeItem", next)
    }

    function requestDockItem(id: string, request: DockItemRequest = {}) {
      const item = store.dock.items[id]
      if (!item && !request.area) return
      const area = request.area ?? item?.area
      if (!area) return
      batch(() => {
        if (!item) ensureDockItem(id, area, true)
        else moveDockItem(id, area)
        setStore("dock", "items", id, "visible", true)
        setStore("dock", area, "visible", true)
        setStore("dock", area, "active", id)
        syncLegacyDockItem(id, true)
      })
      if (typeof window === "undefined" || !window.matchMedia(MOBILE_DOCK_MEDIA_QUERY).matches) return
      if (request.reveal === false) {
        setMobileDock("attention", id, true)
        return
      }
      batch(() => {
        setStore("dock", "mobile", "activeItem", id)
        setMobileDock("opened", true)
        clearMobileDockAttention(id)
      })
    }

    // Invariant: `terminal.opened`, `review.panelOpened`, and `fileTree.opened`
    // are persisted legacy mirrors of the corresponding dock items. Every
    // mutation MUST go through the dock setters or the matching `sync*Dock`
    // helper so the two representations can never drift. Effects that read one
    // must not assume the other is stale.
    function syncDockItemVisible(id: string, fallback: DockArea, visible: boolean) {
      const area = ensureDockItemState(id, fallback, visible)
      setStore("dock", "items", id, "visible", visible)
      if (visible) setStore("dock", area, "visible", true)
      syncLegacyDockItem(id, visible)
    }

    function syncTerminalDock(visible: boolean) {
      batch(() => {
        syncDockItemVisible("terminal", "bottom", visible)
      })
    }

    function syncReviewDock(visible: boolean) {
      batch(() => {
        syncDockItemVisible("review", "right", visible)
      })
    }

    function syncFileTreeDock(visible: boolean) {
      batch(() => {
        syncDockItemVisible("fileTree", "right", visible)
        syncDockItemVisible("gitChanges", "right", visible)
      })
    }

    return {
      route,
      ready,
      home: {
        selection: createMemo(() => store.home.selection),
        setSelection(next: { server: ServerConnection.Key; directory?: string }) {
          setStore("home", "selection", next)
        },
      },
      handoff: {
        tabs: createMemo(() => store.handoff?.tabs),
        setTabs(dir: string, id: string) {
          setStore("handoff", "tabs", { scope: server.scope(), dir, id, at: Date.now() })
        },
        clearTabs() {
          if (!store.handoff?.tabs) return
          setStore("handoff", "tabs", undefined)
        },
      },
      handoffRequests: {
        isDismissed(request: HandoffRequestIdentity) {
          const key = handoffRequestKey(request)
          return dismissedHandoffs[key] === true || !!store.handoffCleanup?.[key]
        },
        hasDismissedRequestInSession(request: Pick<HandoffRequestIdentity, "directory" | "sessionID">) {
          return (
            hasHandoffRequestInSession(dismissedHandoffs, request) ||
            hasHandoffRequestInSession(store.handoffCleanup ?? {}, request)
          )
        },
        dismiss: dismissHandoffRequest,
      },
      projects: {
        list,
        open(directory: string) {
          const root = rootFor(directory)
          if (server.projects.list().find((x) => x.worktree === root)) return
          void serverSync().project.loadSessions(root)
          server.projects.open(root)
        },
        close(directory: string) {
          server.projects.close(directory)
        },
        expand(directory: string) {
          server.projects.expand(directory)
        },
        collapse(directory: string) {
          server.projects.collapse(directory)
        },
        move(directory: string, toIndex: number) {
          server.projects.move(directory, toIndex)
        },
      },
      sidebar: {
        opened: createMemo(() => store.sidebar.opened),
        open() {
          setStore("sidebar", "opened", true)
        },
        close() {
          setStore("sidebar", "opened", false)
        },
        toggle() {
          setStore("sidebar", "opened", (x) => !x)
        },
        width: createMemo(() => store.sidebar.width),
        resize(width: number) {
          setStore("sidebar", "width", width)
        },
        workspaces(directory: string) {
          return () => store.sidebar.workspaces[directory] ?? store.sidebar.workspacesDefault ?? false
        },
        setWorkspaces(directory: string, value: boolean) {
          setStore("sidebar", "workspaces", directory, value)
        },
        toggleWorkspaces(directory: string) {
          const current = store.sidebar.workspaces[directory] ?? store.sidebar.workspacesDefault ?? false
          setStore("sidebar", "workspaces", directory, !current)
        },
      },
      terminal: {
        height: createMemo(() => store.terminal.height),
        resize(height: number) {
          setStore("terminal", "height", height)
          setStore("dock", "bottom", "size", height)
        },
      },
      review: {
        diffStyle: createMemo(() => store.review?.diffStyle ?? "split"),
        setDiffStyle(diffStyle: ReviewDiffStyle) {
          if (!store.review) {
            setStore("review", { diffStyle, panelOpened: true })
            return
          }
          setStore("review", "diffStyle", diffStyle)
        },
      },
      fileTree: {
        opened: createMemo(
          () =>
            store.dock.items.fileTree?.visible ||
            store.dock.items.gitChanges?.visible ||
            (store.fileTree?.opened ?? true),
        ),
        width: createMemo(() => store.fileTree?.width ?? DEFAULT_FILE_TREE_WIDTH),
        tab: createMemo(() => store.fileTree?.tab ?? "changes"),
        setTab(tab: "changes" | "all") {
          if (!store.fileTree) {
            setStore("fileTree", { opened: true, width: DEFAULT_FILE_TREE_WIDTH, tab })
            return
          }
          setStore("fileTree", "tab", tab)
        },
        open() {
          if (!store.fileTree) {
            setStore("fileTree", { opened: true, width: DEFAULT_FILE_TREE_WIDTH, tab: "changes" })
            syncFileTreeDock(true)
            return
          }
          setStore("fileTree", "opened", true)
          syncFileTreeDock(true)
        },
        close() {
          if (!store.fileTree) {
            setStore("fileTree", { opened: false, width: DEFAULT_FILE_TREE_WIDTH, tab: "changes" })
            syncFileTreeDock(false)
            return
          }
          setStore("fileTree", "opened", false)
          syncFileTreeDock(false)
        },
        toggle() {
          if (!store.fileTree) {
            setStore("fileTree", { opened: true, width: DEFAULT_FILE_TREE_WIDTH, tab: "changes" })
            syncFileTreeDock(true)
            return
          }
          const next = !store.fileTree.opened
          setStore("fileTree", "opened", next)
          syncFileTreeDock(next)
        },
        resize(width: number) {
          if (!store.fileTree) {
            setStore("fileTree", { opened: true, width, tab: "changes" })
            setStore("dock", "right", "size", width)
            return
          }
          setStore("fileTree", "width", width)
          setStore("dock", "right", "size", width)
        },
      },
      session: {
        width: createMemo(() => store.session?.width ?? DEFAULT_SESSION_WIDTH),
        resize(width: number) {
          if (!store.session) {
            setStore("session", { width })
            setStore("dock", "middle", "size", width)
            return
          }
          setStore("session", "width", width)
          setStore("dock", "middle", "size", width)
        },
      },
      dock: {
        areas: DOCK_AREAS,
        area(area: DockArea) {
          return {
            visible: createMemo(() => store.dock[area].visible),
            size: createMemo(() => store.dock[area].size),
            tabs: createMemo(() => store.dock[area].tabs),
            active: createMemo(() => store.dock[area].active),
          }
        },
        setVisible(area: DockArea, visible: boolean) {
          const next = area === "middle" ? true : visible
          const terminalArea = store.dock.items.terminal?.area ?? "bottom"
          batch(() => {
            setStore("dock", area, "visible", next)
            if (area === "bottom" && terminalArea === "bottom") {
              setStore("terminal", "opened", next)
              setStore("dock", "items", "terminal", "visible", next)
            }
            if (area === "right" && next && !store.dock.right.active) setStore("dock", "right", "active", "review")
          })
        },
        toggle(area: DockArea) {
          if (area === "middle") return
          const next = !store.dock[area].visible
          const terminalArea = store.dock.items.terminal?.area ?? "bottom"
          batch(() => {
            setStore("dock", area, "visible", next)
            if (area === "bottom" && terminalArea === "bottom") {
              setStore("terminal", "opened", next)
              setStore("dock", "items", "terminal", "visible", next)
            }
            if (area === "right" && next && !store.dock.right.active) setStore("dock", "right", "active", "review")
          })
        },
        resize(area: DockArea, size: number) {
          setStore("dock", area, "size", size)
        },
        setActive(area: DockArea, tab: string | undefined) {
          setStore("dock", area, "active", tab)
        },
        request(id: string, request?: DockItemRequest) {
          requestDockItem(id, request)
        },
        item(id: string) {
          return {
            area: () => store.dock.items[id]?.area,
            visible: () => store.dock.items[id]?.visible ?? false,
          }
        },
        itemArea(id: string) {
          return store.dock.items[id]?.area
        },
        itemVisible(id: string) {
          return store.dock.items[id]?.visible ?? false
        },
        ensureItem(id: string, area: DockArea, visible: boolean) {
          ensureDockItem(id, area, visible)
        },
        setRegisteredPaneIDs(ids: string[]) {
          setRegisteredDockPaneIDs(new Set(ids))
        },
        setItemArea(id: string, area: DockArea) {
          moveDockItem(id, area)
        },
        moveItem(id: string, area: DockArea, toIndex?: number) {
          moveDockItem(id, area, toIndex)
          setStore("dock", area, "visible", true)
          setStore("dock", area, "active", id)
        },
        openItem(id: string, area?: DockArea) {
          requestDockItem(id, { area })
        },
        closeItem(id: string) {
          const item = store.dock.items[id]
          if (!item) return
          batch(() => {
            setStore("dock", "items", id, "visible", false)
            const area = item.area
            // Prefer a renderable pane: a stale control-panel item can stay
            // visible in the dock store after its retained panel was pruned,
            // while the registry no longer renders it. Falling back to such
            // an orphan keeps the stored active ID away from the live handoff
            // and re-enables a duplicate global popup.
            const nextActive = repairedActiveAfterClose(
              store.dock[area].tabs,
              store.dock[area].active,
              id,
              (candidate) => store.dock.items[candidate]?.visible ?? false,
              {
                isRenderable: (candidate) => registeredDockPaneIDs().has(candidate),
                passive: ["browser"],
              },
            )
            if (nextActive !== store.dock[area].active) setStore("dock", area, "active", nextActive)
            repairMobileDockActiveItem(id)
          })
          clearMobileDockAttention(id)
          syncLegacyDockItem(id, false)
        },
        removeItem(id: string) {
          repairMobileDockActiveItem(id)
          setStore("dock", reconcile(removeDockItemState(store.dock, id)))
          clearMobileDockAttention(id)
        },
        replaceItem(from: string, to: string) {
          setStore("dock", reconcile(replaceDockItemState(store.dock, from, to)))
          if (!mobileDock.attention[from]) return
          setMobileDock("attention", to, true)
          clearMobileDockAttention(from)
        },
        setItemVisible(id: string, visible: boolean) {
          const item = store.dock.items[id]
          if (!item) return
          batch(() => {
            setStore("dock", "items", id, "visible", visible)
            if (visible) setStore("dock", item.area, "visible", true)
            if (!visible) repairMobileDockActiveItem(id)
          })
          if (!visible) clearMobileDockAttention(id)
          syncLegacyDockItem(id, visible)
        },
        mobile: {
          opened: createMemo(() => mobileDock.opened),
          size: createMemo(() => store.dock.mobile.size),
          activeItem: createMemo(() => store.dock.mobile.activeItem),
          attention: createMemo(() => Object.keys(mobileDock.attention)),
          hasAttention(id: string) {
            return mobileDock.attention[id] === true
          },
          open(id?: string) {
            batch(() => {
              if (id) setStore("dock", "mobile", "activeItem", id)
              setMobileDock("opened", true)
              if (id) clearMobileDockAttention(id)
            })
          },
          close() {
            setMobileDock("opened", false)
          },
          toggle() {
            setMobileDock("opened", (opened) => !opened)
          },
          setActive(id: string) {
            setStore("dock", "mobile", "activeItem", id)
          },
          activate(id: string) {
            batch(() => {
              setStore("dock", "mobile", "activeItem", id)
              setMobileDock("opened", true)
              clearMobileDockAttention(id)
            })
          },
          resize(size: number) {
            setStore("dock", "mobile", "size", size)
          },
        },
      },
      controlPanels: {
        closed: createMemo(() => store.controlPanels?.closed ?? {}),
        pinned: createMemo(() => store.controlPanels?.pinned ?? {}),
        visibleHandoffRequestKeys,
        setVisibleHandoffRequestKeys,
        close(id: string) {
          if (!store.controlPanels) {
            setStore("controlPanels", { closed: { [id]: true }, pinned: {} })
            return
          }
          setStore("controlPanels", "closed", id, true)
        },
        open(id: string) {
          if (!store.controlPanels?.closed[id]) return
          setStore(
            "controlPanels",
            "closed",
            produce((draft) => {
              delete draft[id]
            }),
          )
        },
        pin(panel: StoredControlPanel) {
          if (!store.controlPanels) {
            setStore("controlPanels", { closed: {}, pinned: { [panel.id]: panel } })
            return
          }
          setStore("controlPanels", "pinned", panel.id, panel)
        },
        unpin(id: string) {
          if (!store.controlPanels?.pinned[id]) return
          setStore(
            "controlPanels",
            "pinned",
            produce((draft) => {
              delete draft[id]
            }),
          )
        },
      },
      mobileSidebar: {
        opened: createMemo(() => store.mobileSidebar?.opened ?? false),
        show() {
          setStore("mobileSidebar", "opened", true)
        },
        hide() {
          setStore("mobileSidebar", "opened", false)
        },
        toggle() {
          setStore("mobileSidebar", "opened", (x) => !x)
        },
      },
      pendingMessage: {
        set(sessionKey: string, messageID: string) {
          const at = Date.now()
          touch(sessionKey)
          const current = store.sessionView[sessionKey]
          if (!current) {
            setStore("sessionView", sessionKey, {
              scroll: {},
              pendingMessage: messageID,
              pendingMessageAt: at,
            })
            prune(usage.active ?? sessionKey)
            return
          }

          setStore(
            "sessionView",
            sessionKey,
            produce((draft) => {
              draft.pendingMessage = messageID
              draft.pendingMessageAt = at
            }),
          )
        },
        consume(sessionKey: string) {
          const current = store.sessionView[sessionKey]
          const message = current?.pendingMessage
          const at = current?.pendingMessageAt
          if (!message || !at) return

          setStore(
            "sessionView",
            sessionKey,
            produce((draft) => {
              delete draft.pendingMessage
              delete draft.pendingMessageAt
            }),
          )

          if (Date.now() - at > PENDING_MESSAGE_TTL_MS) return
          return message
        },
      },
      view(sessionKey: string | Accessor<string>) {
        const key = createSessionKeyReader(sessionKey, ensureKey)
        const s = createMemo(() => store.sessionView[key()] ?? { scroll: {} })
        const terminalOpened = createMemo(() => store.dock.items.terminal?.visible ?? store.terminal?.opened ?? false)
        const reviewPanelOpened = createMemo(
          () => store.dock.items.review?.visible ?? store.review?.panelOpened ?? true,
        )

        function setTerminalOpened(next: boolean) {
          const current = store.terminal
          if (!current) {
            setStore("terminal", { height: DEFAULT_TERMINAL_HEIGHT, opened: next })
            syncTerminalDock(next)
            return
          }

          const value = current.opened ?? false
          if (value !== next) setStore("terminal", "opened", next)
          syncTerminalDock(next)
        }

        function setReviewPanelOpened(next: boolean) {
          const current = store.review
          if (!current) {
            setStore("review", { diffStyle: "split" as ReviewDiffStyle, panelOpened: next })
            syncReviewDock(next)
            return
          }

          const value = current.panelOpened ?? true
          if (value !== next) setStore("review", "panelOpened", next)
          syncReviewDock(next)
        }

        return {
          scroll(tab: string) {
            return scroll.scroll(key(), tab)
          },
          setScroll(tab: string, pos: SessionScroll) {
            scroll.setScroll(key(), tab, pos)
          },
          todoCollapsed: {
            get: () => s().todoCollapsed ?? false,
            set(collapsed: boolean) {
              const session = key()
              const current = store.sessionView[session]
              if (!current) {
                setStore("sessionView", session, { scroll: {}, todoCollapsed: collapsed })
              } else {
                setStore("sessionView", session, "todoCollapsed", collapsed)
              }
            },
          },
          terminal: {
            opened: terminalOpened,
            open() {
              setTerminalOpened(true)
            },
            close() {
              setTerminalOpened(false)
            },
            toggle() {
              setTerminalOpened(!terminalOpened())
            },
          },
          reviewPanel: {
            opened: reviewPanelOpened,
            open() {
              setReviewPanelOpened(true)
            },
            close() {
              setReviewPanelOpened(false)
            },
            toggle() {
              setReviewPanelOpened(!reviewPanelOpened())
            },
          },
          review: {
            open: createMemo(() => s().reviewOpen ?? []),
            setOpen(open: string[]) {
              const session = key()
              const next = Array.from(new Set(open))
              const current = store.sessionView[session]
              if (!current) {
                setStore("sessionView", session, {
                  scroll: {},
                  reviewOpen: next,
                })
                return
              }

              if (same(current.reviewOpen, next)) return
              setStore("sessionView", session, "reviewOpen", next)
            },
            openPath(path: string) {
              const session = key()
              const current = store.sessionView[session]
              if (!current) {
                setStore("sessionView", session, {
                  scroll: {},
                  reviewOpen: [path],
                })
                return
              }

              if (!current.reviewOpen) {
                setStore("sessionView", session, "reviewOpen", [path])
                return
              }

              if (current.reviewOpen.includes(path)) return
              setStore("sessionView", session, "reviewOpen", current.reviewOpen.length, path)
            },
            closePath(path: string) {
              const session = key()
              const current = store.sessionView[session]?.reviewOpen
              if (!current) return

              const index = current.indexOf(path)
              if (index === -1) return
              setStore(
                "sessionView",
                session,
                "reviewOpen",
                produce((draft) => {
                  if (!draft) return
                  draft.splice(index, 1)
                }),
              )
            },
            togglePath(path: string) {
              const session = key()
              const current = store.sessionView[session]?.reviewOpen
              if (!current || !current.includes(path)) {
                this.openPath(path)
                return
              }

              this.closePath(path)
            },
          },
        }
      },
      tabs(sessionKey: string | Accessor<string>) {
        const key = createSessionKeyReader(sessionKey, ensureKey)
        const path = createMemo(() => sessionPath(key()))
        const tabs = createMemo(() => store.sessionTabs[key()] ?? { all: [] })
        const normalize = (tab: string) => normalizeSessionTab(path(), tab)
        const normalizeAll = (all: string[]) => normalizeSessionTabList(path(), all)
        return {
          tabs,
          active: createMemo(() => tabs().active),
          all: createMemo(() => tabs().all.filter((tab) => tab !== "review")),
          setActive(tab: string | undefined) {
            const session = key()
            const next = tab ? normalize(tab) : tab
            if (!store.sessionTabs[session]) {
              setStore("sessionTabs", session, { all: [], active: next })
            } else {
              setStore("sessionTabs", session, "active", next)
            }
          },
          setAll(all: string[]) {
            const session = key()
            const next = normalizeAll(all).filter((tab) => tab !== "review")
            if (!store.sessionTabs[session]) {
              setStore("sessionTabs", session, { all: next, active: undefined })
            } else {
              setStore("sessionTabs", session, "all", next)
            }
          },
          async open(tab: string) {
            const session = key()
            const next = nextSessionTabsForOpen(store.sessionTabs[session], normalize(tab))
            setStore("sessionTabs", session, next)
          },
          close(tab: string) {
            const session = key()
            const current = store.sessionTabs[session]
            if (!current) return

            if (tab === "review") {
              if (current.active !== tab) return
              setStore("sessionTabs", session, "active", current.all[0])
              return
            }

            const all = current.all.filter((x) => x !== tab)
            if (current.active !== tab) {
              setStore("sessionTabs", session, "all", all)
              return
            }

            const index = current.all.findIndex((f) => f === tab)
            const next = current.all[index - 1] ?? current.all[index + 1] ?? all[0]
            batch(() => {
              setStore("sessionTabs", session, "all", all)
              setStore("sessionTabs", session, "active", next)
            })
          },
          move(tab: string, to: number) {
            const session = key()
            const current = store.sessionTabs[session]
            if (!current) return
            const index = current.all.findIndex((f) => f === tab)
            if (index === -1) return
            setStore(
              "sessionTabs",
              session,
              "all",
              produce((opened) => {
                opened.splice(to, 0, opened.splice(index, 1)[0])
              }),
            )
          },
        }
      },
    }
  },
})
