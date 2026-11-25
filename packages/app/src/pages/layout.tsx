import { navigationHandoffs } from "@/plugin/navigation-handoff"
import { permissionAllowsAlways } from "@/utils/permission-options"
import {
  batch,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  ParentProps,
  Show,
  untrack,
  type Accessor,
} from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { useLocation, useNavigate } from "@solidjs/router"
import { useLayout, LocalProject } from "@/context/layout"
import { useServerSync } from "@/context/server-sync"
import { Persist, persisted } from "@/utils/persist"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { decode64 } from "@/utils/base64"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Dialog } from "@opencode-ai/ui/dialog"
import { getFilename } from "@opencode-ai/core/util/path"
import type {
  Message,
  Part,
  PermissionRequest,
  PermissionV2Request,
  SurfaceBlockingRequest,
  SurfaceControlRequest,
  SurfaceRequest,
  Session,
} from "@opencode-ai/sdk/v2/client"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { createStore, produce, reconcile } from "solid-js/store"
import { DragDropProvider, DragDropSensors, DragOverlay, SortableProvider, closestCenter } from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import { useProviders } from "@/hooks/use-providers"
import { useModels } from "@/context/models"
import { toaster } from "@opencode-ai/ui/toast"
import { setV2Toast, showToast, ToastRegion } from "@/utils/toast"
import { useServerSDK } from "@/context/server-sdk"
import { clearWorkspaceTerminals } from "@/context/terminal"
import { dropSessionCaches, pickSessionCacheEvictions } from "@/context/global-sync/session-cache"
import { adaptSessionMessages } from "@/context/global-sync/session-message-adapter"
import {
  SESSION_MESSAGE_PAGE_LOOKBEHIND,
  dropMessageParts,
  mergePartsPreservingText,
  windowSessionMessages,
} from "@/context/global-sync/session-message-window"
import {
  activeSessionReadyForBackgroundPrefetch,
  clearSessionPrefetchInflight,
  clearSessionPrefetch,
  getSessionPrefetch,
  isSessionPrefetchCurrent,
  markSessionPrefetchFailed,
  runSessionPrefetch,
  sessionPrefetchCoolingDown,
  sessionPrefetchRevision,
  setSessionPrefetch,
  shouldSkipSessionPrefetch,
} from "@/context/global-sync/session-prefetch"
import { useNotification } from "@/context/notification"
import {
  SESSION_MESSAGE_REQUEST_TIMEOUT_MS,
  withSessionMessageRequestTimeout,
} from "@/context/session-message-request"
import { usePermission } from "@/context/permission"
import { normalizePermissionRequest } from "@/context/permission-request"
import { loadPendingQuestions, markSurfaceRequestProtocol } from "@/context/question-request"
import {
  markQuestionChanged,
  questionChangedAfter,
  questionRevision,
} from "@/context/global-sync/question-revision"
import { sessionTabDockPaneID, tabKey, useTabs } from "@/context/tabs"
import { Binary } from "@opencode-ai/core/util/binary"
import { retry } from "@opencode-ai/core/util/retry"
import { playSoundById } from "@/utils/sound"
import { createAim } from "@/utils/aim"
import { setNavigate } from "@/utils/notification-click"
import { Worktree as WorktreeState } from "@/utils/worktree"
import { setSessionHandoff } from "@/pages/session/handoff"
import { SessionRouteKey, SessionStateKey } from "@/utils/server-scope"
import { useSessionRoute } from "@/context/session-route"
import { recordPerfEvent } from "@/utils/perf-recorder"

import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useTheme, type ColorScheme } from "@opencode-ai/ui/theme/context"
import { useCommand, type CommandOption } from "@/context/command"
import { ConstrainDragXAxis, getDraggableId } from "@/utils/solid-dnd"
import { DebugBar } from "@/components/debug-bar"
import { HelpButton } from "@/components/help-button"
import { Titlebar, type TitlebarUpdate } from "@/components/titlebar"
import {
  notifySessionTabsRemoved,
  readSessionTabReconciledDetail,
  SESSION_TAB_RECONCILED_EVENT,
} from "@/components/titlebar-session-events"
import { useDirectoryPicker } from "@/components/directory-picker"
import { ServerConnection, useServer } from "@/context/server"
import { useLanguage, type Locale } from "@/context/language"
import { directoryKey, pathKey } from "@/utils/path-key"
import {
  displayName,
  effectiveWorkspaceOrder,
  errorMessage,
  latestRootSession,
  resumedProjectDirectories,
  sortedRootSessions,
  visibleRootSessions,
} from "./layout/helpers"
import {
  collectNewSessionDeepLinks,
  collectOpenProjectDeepLinks,
  collectPluginHandoffDeepLinks,
  consumeDeepLinkEvent,
  deepLinkEvent,
  drainPendingDeepLinks,
} from "./layout/deep-links"
import { createInlineEditorController } from "./layout/inline-editor"
import {
  LocalWorkspace,
  SortableWorkspace,
  WorkspaceDragOverlay,
  type WorkspaceSidebarContext,
} from "./layout/sidebar-workspace"
import { ProjectDragOverlay, SortableProject, type ProjectSidebarContext } from "./layout/sidebar-project"
import { SidebarContent } from "./layout/sidebar-shell"
import {
  ActiveAgentHandoffPopup,
  AgentHandoffPopupRequest,
  HandoffPopup,
  QuestionPopup,
  questionPopupKey,
  type ActiveQuestionPopup,
  type QuestionPopupRequest,
} from "./layout/question-popup"
import {
  handoffCoveredByDock,
  handoffCacheDecision,
  handoffCoveredByCurrentSession,
  handoffPopupKey,
  matchesQuestionPopup,
  pendingHandoffStep,
  removePopupKeys,
  shouldShowHandoffPopup,
  shouldShowQuestionPopup,
} from "./layout/question-popup-match"
import type { HandoffRequestIdentity } from "@/utils/handoff-request"
import {
  isDetachedSurfaceRequest,
  isImplementationCompleteFollowupQuestion,
  sessionInTree,
} from "./session/composer/session-request-tree"

const sessionPrefetchSkippedParts = new Set(["patch", "step-start", "step-finish"])

const SPAWN_AGENT_METADATA_KEY = "opencode_spawn_agent"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isSpawnedAgentSession(session: Session) {
  return isRecord(session.metadata) && isRecord(session.metadata[SPAWN_AGENT_METADATA_KEY])
}

function sessionHrefTarget(href: string) {
  const pathname = href.startsWith("/")
    ? (href.split(/[?#]/)[0] ?? "")
    : (() => {
        try {
          return new URL(href).pathname
        } catch {
          return ""
        }
      })()
  const [slug, segment, rawID, ...extra] = pathname.split("/").filter(Boolean)
  if (!slug || segment !== "session" || !rawID || extra.length > 0) return

  try {
    const directory = decode64(slug)
    if (!directory) return
    return { directory, sessionID: decodeURIComponent(rawID) }
  } catch {
    return
  }
}

export default function Layout(props: ParentProps) {
  const serverSDK = useServerSDK()
  const [store, setStore, , ready] = persisted(
    Persist.serverGlobal(serverSDK().scope, "layout.page", ["layout.page.v1"]),
    createStore({
      lastProjectSession: {} as { [directory: string]: { directory: string; id: string; at: number } },
      activeProject: undefined as string | undefined,
      activeWorkspace: undefined as string | undefined,
      workspaceOrder: {} as Record<string, string[]>,
      workspaceName: {} as Record<string, string>,
      workspaceBranchName: {} as Record<string, Record<string, string>>,
      workspaceExpanded: {} as Record<string, boolean>,
      gettingStartedDismissed: false,
      viewedQuestionPopups: {} as Record<string, true>,
    }),
  )

  const pageReady = createMemo(() => ready())
  const [pageVisible, setPageVisible] = createSignal(
    typeof document === "undefined" || document.visibilityState === "visible",
  )

  let scrollContainerRef: HTMLDivElement | undefined
  let dialogRun = 0
  let dialogDead = false

  const params = useSessionRoute()
  const serverSync = useServerSync()
  const layout = useLayout()
  const layoutReady = createMemo(() => layout.ready())
  const platform = usePlatform()
  const pickDirectory = useDirectoryPicker()
  const settings = useSettings()
  const server = useServer()
  const notification = useNotification()
  const permission = usePermission()
  const navigate = useNavigate()
  const tabs = useTabs()
  const providers = useProviders()
  const models = useModels()
  const dialog = useDialog()
  const command = useCommand()
  const theme = useTheme()
  const language = useLanguage()
  createEffect(() => setV2Toast(true))
  const initialDirectory = decode64(params.dir)
  const location = useLocation()
  const route = createMemo(() => {
    const slug = params.dir
    if (!slug) return { slug, dir: "" }
    const dir = decode64(slug)
    if (!dir) return { slug, dir: "" }
    const store = serverSync().peek(dir, { bootstrap: false })
    return {
      slug,
      store,
      dir: store[0].path.directory || dir,
    }
  })

  createEffect(() => {
    const unsubscribe = serverSDK().event.listen((e) => {
      const event = e.details
      if (event.type !== "session.created") return
      const session = event.properties.info
      if (!isSpawnedAgentSession(session)) return
      tabs.openSessionTab(
        {
          server: server.key,
          dirBase64: base64Encode(session.directory),
          sessionId: session.id,
          createdEmpty: false,
        },
        { activate: false },
      )
    })
    onCleanup(unsubscribe)
  })

  const availableThemeEntries = createMemo(() => theme.ids().map((id) => [id, theme.themes()[id]] as const))
  const colorSchemeOrder: ColorScheme[] = ["system", "light", "dark"]
  const colorSchemeKey: Record<ColorScheme, "theme.scheme.system" | "theme.scheme.light" | "theme.scheme.dark"> = {
    system: "theme.scheme.system",
    light: "theme.scheme.light",
    dark: "theme.scheme.dark",
  }
  const colorSchemeLabel = (scheme: ColorScheme) => language.t(colorSchemeKey[scheme])
  const currentDir = createMemo(() => route().dir)

  const [state, setState] = createStore({
    autoselect: !initialDirectory,
    busyWorkspaces: {} as Record<string, boolean>,
    dismissedQuestionPopups: {} as Record<string, true>,
    minimizedQuestionPopups: {} as Record<string, true>,
    dismissedHandoffPopups: {} as Record<string, true>,
    minimizedHandoffPopups: {} as Record<string, true>,
    hoverProject: undefined as string | undefined,
    scrollSessionKey: undefined as string | undefined,
    questionPopups: {} as Record<string, QuestionPopupRequest>,
    handoffPopups: {} as Record<string, AgentHandoffPopupRequest>,
    nav: undefined as HTMLElement | undefined,
    sortNow: Date.now(),
    sizing: false,
    peek: undefined as string | undefined,
    peeked: false,
  })

  const updateVersion = () => {
    const state = platform.updater?.state()
    if (state?.status !== "ready") return
    return state.version
  }
  const installUpdate = () => void platform.updater?.install()
  const upsertQuestionPopup = (directory: string, request: SurfaceRequest) => {
    if (request.mode !== "blocking") {
      if (request.mode === "interactive") upsertHandoffPopup(directory, request)
      return
    }
    const key = questionPopupKey(directory, request)
    if (isImplementationCompleteFollowupQuestion(request)) {
      setStore("viewedQuestionPopups", key, true)
      removeQuestionPopup(directory, request.sessionID, request.id)
      return
    }
    setState("questionPopups", key, { directory, request })
  }
  const removeQuestionPopup = (directory: string, sessionID: string, requestID: string) => {
    const keys = Object.entries(state.questionPopups)
      .filter(([, item]) => (item ? matchesQuestionPopup(item, directory, { sessionID, id: requestID }) : false))
      .map(([key]) => key)
    setState(
      "questionPopups",
      produce((draft) => {
        keys.forEach((key) => delete draft[key])
      }),
    )
    setState(
      "minimizedQuestionPopups",
      produce((draft) => {
        keys.forEach((key) => delete draft[key])
      }),
    )
    removeHandoffPopup(directory, sessionID, requestID)
  }
  const upsertHandoffPopup = (directory: string, request: SurfaceControlRequest) => {
    if (!pendingHandoffStep(request)) return
    const key = handoffPopupKey(directory, request)
    if (state.dismissedHandoffPopups[key]) return
    setState("handoffPopups", key, { directory, request })
  }
  const removeHandoffPopup = (directory: string, sessionID: string, requestID: string) => {
    const keys = removePopupKeys(state.handoffPopups, directory, { sessionID, id: requestID })
    const minimizedKeys = removePopupKeys(state.minimizedHandoffPopups, directory, { sessionID, id: requestID })
    setState(
      "handoffPopups",
      produce((draft) => {
        keys.forEach((key) => delete draft[key])
      }),
    )
    setState(
      "minimizedHandoffPopups",
      produce((draft) => {
        minimizedKeys.forEach((key) => delete draft[key])
      }),
    )
  }
  const minimizeHandoffPopup = (directory: string, request: SurfaceControlRequest) => {
    setState("minimizedHandoffPopups", handoffPopupKey(directory, request), true)
  }
  const hideHandoffPopup = (directory: string, sessionID: string, requestID: string) => {
    const key = handoffPopupKey(directory, { sessionID, id: requestID })
    setState("dismissedHandoffPopups", key, true)
    removeHandoffPopup(directory, sessionID, requestID)
  }
  const dismissHandoffPopup = (directory: string, request: SurfaceControlRequest) => {
    hideHandoffPopup(directory, request.sessionID, request.id)
  }
  const completeHandoffPopup = (request: HandoffRequestIdentity) => {
    hideHandoffPopup(request.directory, request.sessionID, request.requestID)
    return layout.handoffRequests.dismiss(request)
  }
  const minimizeQuestionPopup = (directory: string, request: SurfaceBlockingRequest) => {
    setState("minimizedQuestionPopups", questionPopupKey(directory, request), true)
  }
  const dismissQuestionPopup = (directory: string, request: SurfaceBlockingRequest) => {
    const key = questionPopupKey(directory, request)
    setState("dismissedQuestionPopups", key, true)
    removeQuestionPopup(directory, request.sessionID, request.id)
  }
  const titlebarUpdate: TitlebarUpdate = {
    version: updateVersion,
    installing: () => platform.updater?.state().status === "installing",
    install: installUpdate,
  }

  const editor = createInlineEditorController()
  const setBusy = (directory: string, value: boolean) => {
    const key = pathKey(directory)
    if (value) {
      setState("busyWorkspaces", key, true)
      return
    }
    setState(
      "busyWorkspaces",
      produce((draft) => {
        delete draft[key]
      }),
    )
  }
  const isBusy = (directory: string) => !!state.busyWorkspaces[pathKey(directory)]
  const navLeave = { current: undefined as number | undefined }
  const sortNow = () => state.sortNow
  let sizet: number | undefined
  let sortNowInterval: ReturnType<typeof setInterval> | undefined
  const sortNowTimeout = setTimeout(
    () => {
      setState("sortNow", Date.now())
      sortNowInterval = setInterval(() => setState("sortNow", Date.now()), 60_000)
    },
    60_000 - (Date.now() % 60_000),
  )

  const aim = createAim({
    enabled: () => !layout.sidebar.opened(),
    active: () => state.hoverProject,
    el: () => state.nav?.querySelector<HTMLElement>("[data-component='sidebar-rail']") ?? state.nav,
    onActivate: (directory) => {
      setState("hoverProject", directory)
    },
  })

  onCleanup(() => {
    dialogDead = true
    dialogRun += 1
    if (navLeave.current !== undefined) clearTimeout(navLeave.current)
    clearTimeout(sortNowTimeout)
    if (sortNowInterval) clearInterval(sortNowInterval)
    if (sizet !== undefined) clearTimeout(sizet)
    if (peekt !== undefined) clearTimeout(peekt)
    aim.reset()
  })

  onMount(() => {
    const stop = () => setState("sizing", false)
    const blur = () => reset()
    const visibility = () => {
      const visible = document.visibilityState === "visible"
      setPageVisible(visible)
      if (visible) return
      reset()
    }
    visibility()
    makeEventListener(window, "pointerup", stop)
    makeEventListener(window, "pointercancel", stop)
    makeEventListener(window, "blur", stop)
    makeEventListener(window, "blur", blur)
    makeEventListener(document, "visibilitychange", visibility)
  })

  const sidebarHovering = createMemo(() => !layout.sidebar.opened() && state.hoverProject !== undefined)
  const sidebarExpanded = createMemo(() => layout.sidebar.opened() || sidebarHovering())
  const setHoverProject = (value: string | undefined) => {
    setState("hoverProject", value)
    if (value !== undefined) return
    aim.reset()
  }
  const clearHoverProjectSoon = () => queueMicrotask(() => setHoverProject(undefined))

  const disarm = () => {
    if (navLeave.current === undefined) return
    clearTimeout(navLeave.current)
    navLeave.current = undefined
  }

  const reset = () => {
    disarm()
    setHoverProject(undefined)
  }

  const arm = () => {
    if (layout.sidebar.opened()) return
    if (state.hoverProject === undefined) return
    disarm()
    navLeave.current = window.setTimeout(() => {
      navLeave.current = undefined
      setHoverProject(undefined)
    }, 300)
  }

  let peekt: number | undefined

  const hoverProjectData = createMemo(() => {
    const id = state.hoverProject
    if (!id) return
    return layout.projects.list().find((project) => project.worktree === id)
  })

  const peekProject = createMemo(() => {
    const id = state.peek
    if (!id) return
    return layout.projects.list().find((project) => project.worktree === id)
  })

  createEffect(() => {
    const p = hoverProjectData()
    if (p) {
      if (peekt !== undefined) {
        clearTimeout(peekt)
        peekt = undefined
      }
      setState("peek", p.worktree)
      setState("peeked", true)
      return
    }

    setState("peeked", false)
    if (state.peek === undefined) return
    if (peekt !== undefined) clearTimeout(peekt)
    peekt = window.setTimeout(() => {
      peekt = undefined
      setState("peek", undefined)
    }, 180)
  })

  createEffect(() => {
    if (!layout.sidebar.opened()) return
    setHoverProject(undefined)
  })

  createEffect(() => {
    if (!state.autoselect) return
    const dir = params.dir
    if (!dir) return
    const directory = decode64(dir)
    if (!directory) return
    setState("autoselect", false)
  })

  const editorOpen = editor.editorOpen
  const openEditor = editor.openEditor
  const closeEditor = editor.closeEditor
  const setEditor = editor.setEditor
  const InlineEditor = editor.InlineEditor

  const clearSidebarHoverState = () => {
    if (layout.sidebar.opened()) return
    reset()
  }

  const navigateWithSidebarReset = (href: string) => {
    clearSidebarHoverState()
    navigate(href)
    layout.mobileSidebar.hide()
  }

  const navigateToSessionTarget = (directory: string, sessionID: string, targetServer = server.key) => {
    clearSidebarHoverState()
    server.projects.forServer(targetServer).open(directory)
    const tab = {
      type: "session" as const,
      server: targetServer,
      dirBase64: base64Encode(directory),
      sessionId: sessionID,
    }
    const resolved = tabs.openSessionTab(tab, { activate: false })
    if (!resolved) return
    const paneID = sessionTabDockPaneID(resolved)
    // A pending handoff must not take focus back from a server the user selected meanwhile.
    if (targetServer !== server.key) return
    layout.dock.openItem(paneID, layout.dock.itemArea(paneID) ?? "middle")
    tabs.select(resolved)
    layout.mobileSidebar.hide()
  }

  const navigateToHref = (href: string) => {
    const target = sessionHrefTarget(href)
    if (!target) {
      navigateWithSidebarReset(href)
      return
    }
    navigateToSessionTarget(target.directory, target.sessionID)
  }

  setNavigate(navigateToHref)

  makeEventListener(window, SESSION_TAB_RECONCILED_EVENT, (event) => {
    const detail = readSessionTabReconciledDetail(event)
    if (!detail) return
    const next = sessionTabDockPaneID(detail.next)
    detail.previous.forEach((tab) => layout.dock.replaceItem(sessionTabDockPaneID(tab), next))
  })

  function cycleTheme(direction = 1) {
    const ids = availableThemeEntries().map(([id]) => id)
    if (ids.length === 0) return
    const currentIndex = ids.indexOf(theme.themeId())
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + direction + ids.length) % ids.length
    const nextThemeId = ids[nextIndex]
    theme.setTheme(nextThemeId)
    showToast({
      title: language.t("toast.theme.title"),
      description: theme.name(nextThemeId),
    })
  }

  function cycleColorScheme(direction = 1) {
    const current = theme.colorScheme()
    const currentIndex = colorSchemeOrder.indexOf(current)
    const nextIndex =
      currentIndex === -1 ? 0 : (currentIndex + direction + colorSchemeOrder.length) % colorSchemeOrder.length
    const next = colorSchemeOrder[nextIndex]
    theme.setColorScheme(next)
    showToast({
      title: language.t("toast.scheme.title"),
      description: colorSchemeLabel(next),
    })
  }

  function setLocale(next: Locale) {
    if (next === language.locale()) return
    language.setLocale(next)
    showToast({
      title: language.t("toast.language.title"),
      description: language.t("toast.language.description", { language: language.label(next) }),
    })
  }

  function cycleLanguage(direction = 1) {
    const locales = language.locales
    const currentIndex = locales.indexOf(language.locale())
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + direction + locales.length) % locales.length
    const next = locales[nextIndex]
    if (!next) return
    setLocale(next)
  }

  const notificationToastByRequest = new Map<
    string,
    { toastId: number; sessionKey: string; requestID: string }
  >()
  const notificationAlertedAtBySession = new Map<string, number>()
  const notificationCooldownMs = 5000

  const dismissSessionAlert = (sessionKey: string, requestID?: string) => {
    const matches = [...notificationToastByRequest.entries()].filter(
      ([, toast]) => toast.sessionKey === sessionKey && (!requestID || toast.requestID === requestID),
    )
    matches.forEach(([key, toast]) => {
      toaster.dismiss(toast.toastId)
      notificationToastByRequest.delete(key)
    })
    if ([...notificationToastByRequest.values()].some((toast) => toast.sessionKey === sessionKey)) return
    notificationAlertedAtBySession.delete(sessionKey)
  }

  const useSDKNotificationToasts = () =>
    createEffect(() => {
      const currentSDK = serverSDK()
      const unsub = currentSDK.event.listen((e) => {
        const permissionAsked = e.details?.type === "permission.asked" || e.details?.type === "permission.v2.asked"
        const permissionSettled =
          e.details?.type === "permission.replied" || e.details?.type === "permission.v2.replied"
        const questionAsked = e.details?.type === "surface.asked"
        const questionSettled =
          e.details?.type === "surface.replied" || e.details?.type === "surface.dismissed"

        if (e.details?.type === "worktree.ready") {
          setBusy(e.name, false)
          WorktreeState.ready(serverSDK().scope, e.name)
          return
        }

        if (e.details?.type === "worktree.failed") {
          setBusy(e.name, false)
          WorktreeState.failed(
            serverSDK().scope,
            e.name,
            e.details.properties?.message ?? language.t("common.requestFailed"),
          )
          return
        }

        if (questionSettled || permissionSettled) {
          const props = e.details.properties as { sessionID: string; requestID?: string; permissionID?: string }
          if (questionSettled && props.requestID) removeQuestionPopup(e.name, props.sessionID, props.requestID)
          const sessionKey = `${directoryKey(e.name)}:${props.sessionID}`
          if (permissionSettled) dismissSessionAlert(sessionKey, props.requestID ?? props.permissionID)
          return
        }

        if (!permissionAsked && !questionAsked) return
        const icon = permissionAsked ? ("checklist" as const) : ("bubble-5" as const)
        const directory = e.name
        const permissionRequest = permissionAsked
          ? normalizePermissionRequest(e.details.properties as PermissionRequest | PermissionV2Request)
          : undefined
        const review = permissionRequest?.metadata["$opencode.permission.safety_review"] as
          | { cause?: string; context?: { goal?: string; action?: string } }
          | undefined
        const title = permissionAsked
          ? language.t("notification.permission.title")
          : language.t("notification.question.title")
        const props = permissionRequest ?? e.details.properties
        if (permissionRequest && permission.autoResponds(permissionRequest, directory)) return

        const [store] = serverSync().child(directory, { bootstrap: false })
        const session = store.session.find((s) => s.id === props.sessionID)
        const sessionKey = `${directoryKey(directory)}:${props.sessionID}`

        const sessionTitle = session?.title ?? language.t("command.session.new")
        const projectName = getFilename(directory)
        const description = permissionAsked
          ? language.t("notification.permission.description", { sessionTitle, projectName })
          : language.t("notification.question.description", { sessionTitle, projectName })
        const href = `/${base64Encode(directory)}/session/${props.sessionID}`

        const now = Date.now()
        const lastAlerted = notificationAlertedAtBySession.get(sessionKey) ?? 0

        if (questionAsked) {
          const request = markSurfaceRequestProtocol(props as SurfaceRequest, "v2")
          upsertQuestionPopup(directory, request)
          if (isImplementationCompleteFollowupQuestion(request)) return
          if (now - lastAlerted >= notificationCooldownMs) {
            notificationAlertedAtBySession.set(sessionKey, now)
            if (settings.sounds.agentEnabled()) {
              window.setTimeout(() => void playSoundById(settings.sounds.agent()), 500)
            }
            if (settings.notifications.agent()) {
              window.setTimeout(() => void platform.notify(title, description, href), 500)
            }
          }
          return
        }

        if (now - lastAlerted >= notificationCooldownMs) {
          notificationAlertedAtBySession.set(sessionKey, now)
          if (settings.sounds.permissionsEnabled()) {
            window.setTimeout(() => void playSoundById(settings.sounds.permissions()), 500)
          }
          if (settings.notifications.permissions()) {
            window.setTimeout(() => void platform.notify(title, description, href), 500)
          }
        }

        const currentSession = params.id
        if (directoryKey(directory) === directoryKey(currentDir()) && props.sessionID === currentSession) return
        if (!permissionRequest) return

        const request = permissionRequest
        const requestKey = `${sessionKey}:${request.id}`
        const requestDescription = `${description} — ${review?.context?.goal ? `Goal: ${review.context.goal} — ` : ""}${review?.context?.action ? `Agent's next step: ${review.context.action} — ` : ""}${request.permission}${
          request.patterns.length ? `: ${request.patterns.join(", ")}` : ""
        }`
        dismissSessionAlert(sessionKey, request.id)

        function showPermissionToast() {
          let responding = false
          const decide = (response: "once" | "always" | "reject") => () => {
            if (responding) return
            responding = true
            permission.respond({ request, response, directory }).catch((err: unknown) => {
              const failure = err instanceof Error ? err.message : String(err)
              showToast({ title: language.t("common.requestFailed"), description: failure })
              if (notificationToastByRequest.get(requestKey)?.toastId !== toastId) return
              notificationToastByRequest.set(requestKey, {
                toastId: showPermissionToast(),
                sessionKey,
                requestID: request.id,
              })
            })
          }
          const toastId = showToast({
            persistent: true,
            icon,
            title,
            description: requestDescription,
            actions: [
              {
                label: language.t("notification.action.goToSession"),
                onClick: () => navigateToHref(href),
              },
              {
                label: language.t("ui.permission.deny"),
                onClick: decide("reject"),
              },
              ...(permissionAllowsAlways(request) ? [{
                label: language.t("ui.permission.allowAlways"),
                onClick: decide("always"),
              }] : []),
              {
                label: language.t("ui.permission.allowOnce"),
                onClick: decide("once"),
              },
            ],
          })
          return toastId
        }
        notificationToastByRequest.set(requestKey, {
          toastId: showPermissionToast(),
          sessionKey,
          requestID: request.id,
        })
      })
      onCleanup(unsub)

      createEffect(() => {
        const currentSession = params.id
        if (!currentDir() || !currentSession) return
        const sessionKey = `${directoryKey(currentDir())}:${currentSession}`
        dismissSessionAlert(sessionKey)
      })
    })

  useSDKNotificationToasts()

  function scrollToSession(sessionId: string, sessionKey: string) {
    if (!scrollContainerRef) return
    if (state.scrollSessionKey === sessionKey) return
    const element = scrollContainerRef.querySelector(`[data-session-id="${sessionId}"]`)
    if (!element) return
    const containerRect = scrollContainerRef.getBoundingClientRect()
    const elementRect = element.getBoundingClientRect()
    if (elementRect.top >= containerRect.top && elementRect.bottom <= containerRect.bottom) {
      setState("scrollSessionKey", sessionKey)
      return
    }
    setState("scrollSessionKey", sessionKey)
    element.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }

  const projectLookup = createMemo(() => {
    const byWorktree = new Map<string, LocalProject>()
    const byWorktreeKey = new Map<string, LocalProject>()
    const bySandboxKey = new Map<string, LocalProject>()
    layout.projects.list().forEach((project) => {
      byWorktree.set(project.worktree, project)
      byWorktreeKey.set(pathKey(project.worktree), project)
      project.sandboxes?.forEach((sandbox) => bySandboxKey.set(pathKey(sandbox), project))
    })
    return { byWorktree, byWorktreeKey, bySandboxKey }
  })

  const currentProject = createMemo(() => {
    const directory = currentDir()
    if (!directory) return
    const key = pathKey(directory)

    const lookup = projectLookup()

    const sandbox = lookup.bySandboxKey.get(key)
    if (sandbox) return sandbox

    const direct = lookup.byWorktreeKey.get(key)
    if (direct) return direct

    const [child] = serverSync().child(directory, { bootstrap: false })
    const id = child.project
    if (!id) return

    const meta = serverSync().data.project.find((p) => p.id === id)
    const root = meta?.worktree
    if (!root) return

    return lookup.byWorktree.get(root)
  })

  const [autoselecting] = createResource(async () => {
    await ready.promise
    await layout.ready.promise
    if (!untrack(() => state.autoselect)) return

    const list = layout.projects.list()
    const last = server.projects.last()

    if (list.length === 0) {
      if (!last) return
      await openProject(last, true)
    } else {
      const next = list.find((project) => project.worktree === last) ?? list[0]
      if (!next) return
      await openProject(next.worktree, true)
    }
  })

  const workspaceName = (directory: string, projectId?: string, branch?: string) => {
    const key = pathKey(directory)
    const direct = store.workspaceName[key] ?? store.workspaceName[directory]
    if (direct) return direct
    if (!projectId) return
    if (!branch) return
    return store.workspaceBranchName[projectId]?.[branch]
  }

  const setWorkspaceName = (directory: string, next: string, projectId?: string, branch?: string) => {
    const key = pathKey(directory)
    setStore("workspaceName", key, next)
    if (!projectId) return
    if (!branch) return
    if (!store.workspaceBranchName[projectId]) {
      setStore("workspaceBranchName", projectId, {})
    }
    setStore("workspaceBranchName", projectId, branch, next)
  }

  const workspaceLabel = (directory: string, branch?: string, projectId?: string) =>
    workspaceName(directory, projectId, branch) ?? branch ?? getFilename(directory)

  const workspaceSetting = createMemo(() => {
    const project = currentProject()
    if (!project) return false
    if (project.vcs !== "git") return false
    return layout.sidebar.workspaces(project.worktree)()
  })

  const visibleSessionDirs = createMemo(() => {
    const project = currentProject()
    if (!project) return [] as string[]
    if (!workspaceSetting()) return [project.worktree]

    const activeDir = currentDir()
    return workspaceIds(project).filter((directory) => {
      const expanded = store.workspaceExpanded[directory] ?? directory === project.worktree
      const active = pathKey(directory) === pathKey(activeDir)
      return expanded || active
    })
  })

  createEffect(() => {
    if (!pageReady()) return
    if (!layoutReady()) return
    const projects = layout.projects.list()
    for (const [directory, expanded] of Object.entries(store.workspaceExpanded)) {
      if (!expanded) continue
      const key = pathKey(directory)
      const project = projects.find(
        (item) => pathKey(item.worktree) === key || item.sandboxes?.some((sandbox) => pathKey(sandbox) === key),
      )
      if (!project) continue
      if (project.vcs === "git" && layout.sidebar.workspaces(project.worktree)()) continue
      setStore("workspaceExpanded", directory, false)
    }
  })

  const currentSessions = createMemo(() => {
    return visibleRootSessions(visibleSessionDirs(), serverSync().child, Date.now())
  })

  type PrefetchQueue = {
    inflight: Set<string>
    pending: string[]
    pendingSet: Set<string>
    running: number
  }

  const prefetchChunk = 80
  // A passive history read must never compete with the foreground session for
  // the server's SQLite connection or event loop.
  const prefetchConcurrency = 1
  const prefetchPendingLimit = 10
  const span = 4
  const prefetchToken = { value: 0 }
  const prefetchQueues = new Map<string, PrefetchQueue>()
  const [prefetchGateReady, setPrefetchGateReady] = createSignal(false)
  const [prefetchResetVersion, setPrefetchResetVersion] = createSignal(0)
  let prefetchFrame: number | undefined
  let prefetchTimer: number | undefined

  const PREFETCH_MAX_SESSIONS_PER_DIR = 10
  const prefetchedByDir = new Map<string, Set<string>>()

  const activeSessionReadyForPrefetch = () => {
    sessionPrefetchRevision()
    const id = params.id
    if (!id) return true
    const directory = currentDir()
    if (!directory) return false
    const store = serverSync().existing(directory)?.[0] ?? serverSync().child(directory, { bootstrap: false })[0]
    return activeSessionReadyForBackgroundPrefetch({
      message: store.message[id] !== undefined,
      info: getSessionPrefetch(serverSDK().scope, directory, id),
    })
  }

  const visibleSessionWorking = () =>
    visibleSessionDirs().some((directory) => {
      const store = serverSync().existing(directory)?.[0]
      if (!store) return false
      return Object.keys(store.session_status).some((id) => store.session_working(id))
    })

  const sessionPrefetchEnabled = () =>
    settings.optimizations.optimizationProfile() !== "off" && settings.optimizations.sessionTabPrefetch()

  const canRunSessionPrefetch = () =>
    sessionPrefetchEnabled() && prefetchGateReady() && activeSessionReadyForPrefetch() && !visibleSessionWorking()

  const resetPrefetchGate = () => {
    setPrefetchGateReady(false)
    if (prefetchFrame !== undefined) cancelAnimationFrame(prefetchFrame)
    if (prefetchTimer !== undefined) window.clearTimeout(prefetchTimer)
    prefetchFrame = undefined
    prefetchTimer = undefined
  }

  function pumpPrefetchQueues() {
    for (const directory of prefetchQueues.keys()) pumpPrefetch(directory)
  }

  const schedulePrefetchQueues = () => {
    if (!sessionPrefetchEnabled()) return
    if (canRunSessionPrefetch()) {
      pumpPrefetchQueues()
      return
    }
    if (prefetchGateReady()) return
    if (prefetchFrame !== undefined || prefetchTimer !== undefined) return

    prefetchFrame = requestAnimationFrame(() => {
      prefetchFrame = undefined
      prefetchTimer = window.setTimeout(() => {
        prefetchTimer = undefined
        setPrefetchGateReady(true)
        pumpPrefetchQueues()
      }, 750)
    })
  }

  createEffect(() => {
    if (!canRunSessionPrefetch()) return
    pumpPrefetchQueues()
  })

  createEffect(() => {
    const ready = activeSessionReadyForPrefetch()
    const foreground = pageVisible()
    const directories = visibleSessionDirs()
    const hasSessions = currentSessions().length > 0
    const foregroundReady = ready && foreground && hasSessions
    serverSync().setSessionStatusReconciliationScope({
      activeDirectory: currentDir(),
      visibleDirectories: directories,
      activeSessionMessagesReady: ready,
      pageVisible: foreground,
      hasSessions,
    })
    void serverSync().loadVisibleSidebarIndicators(
      foregroundReady ? directories : [],
      (directory) =>
        ready &&
        foreground &&
        pageVisible() &&
        activeSessionReadyForPrefetch() &&
        hasSessions &&
        currentSessions().length > 0 &&
        visibleSessionDirs().some((visible) => directoryKey(visible) === directoryKey(directory)),
    )
  })

  createEffect(() => {
    if (sessionPrefetchEnabled()) return
    resetPrefetchGate()
    prefetchToken.value += 1
    clearSessionPrefetchInflight(serverSDK().scope)
    prefetchQueues.clear()
  })

  onCleanup(resetPrefetchGate)

  const lruFor = (directory: string) => {
    const existing = prefetchedByDir.get(directory)
    if (existing) return existing
    const created = new Set<string>()
    prefetchedByDir.set(directory, created)
    return created
  }

  const markPrefetched = (directory: string, sessionID: string) => {
    const lru = lruFor(directory)
    return pickSessionCacheEvictions({
      seen: lru,
      keep: sessionID,
      limit: PREFETCH_MAX_SESSIONS_PER_DIR,
      preserve: params.id && pathKey(directory) === pathKey(currentDir()) ? [params.id] : undefined,
    })
  }

  createEffect(() => {
    const active = new Set(visibleSessionDirs())
    for (const directory of prefetchedByDir.keys()) {
      if (active.has(directory)) continue
      prefetchedByDir.delete(directory)
    }
  })

  createEffect(() => {
    route()
    params.id
    serverSDK().url

    resetPrefetchGate()
    prefetchToken.value += 1
    clearSessionPrefetchInflight(serverSDK().scope)
    prefetchQueues.clear()
    setPrefetchResetVersion((value) => value + 1)
  })

  createEffect(() => {
    const visible = new Set(visibleSessionDirs())
    for (const [directory, q] of prefetchQueues) {
      if (visible.has(directory)) continue
      q.pending.length = 0
      q.pendingSet.clear()
      if (q.running === 0) prefetchQueues.delete(directory)
    }
  })

  const queueFor = (directory: string) => {
    const existing = prefetchQueues.get(directory)
    if (existing) return existing

    const created: PrefetchQueue = {
      inflight: new Set(),
      pending: [],
      pendingSet: new Set(),
      running: 0,
    }
    prefetchQueues.set(directory, created)
    return created
  }

  const mergeByID = <T extends { id: string }>(current: T[], incoming: T[]) => {
    if (current.length === 0) {
      return incoming.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    }

    const map = new Map<string, T>()
    for (const item of current) {
      map.set(item.id, item)
    }
    for (const item of incoming) {
      map.set(item.id, item)
    }
    return [...map.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }

  const prefetchParts = (parts: Part[]) =>
    parts.filter((item): item is Part & { id: string } => !!item?.id && !sessionPrefetchSkippedParts.has(item.type))

  async function prefetchMessages(directory: string, sessionID: string, token: number) {
    const [store, setStore] = serverSync().child(directory, { bootstrap: false })
    const started = typeof performance === "undefined" ? Date.now() : performance.now()

    return runSessionPrefetch({
      scope: serverSDK().scope,
      directory,
      sessionID,
      task: (rev, signal) =>
        (async () => {
          const client = serverSDK().createClient({ directory, throwOnError: true })
          const read = (limit: number, cursor?: string) =>
            withSessionMessageRequestTimeout({
              signal,
              task: (requestSignal) =>
                client.v2.session.messages(
                  {
                    sessionID,
                    limit,
                    ...(cursor ? { cursor } : { order: "desc" as const }),
                  },
                  { signal: requestSignal },
                ),
              timeoutMs: SESSION_MESSAGE_REQUEST_TIMEOUT_MS,
              retries: 0,
            })
          const messages = await read(prefetchChunk + SESSION_MESSAGE_PAGE_LOOKBEHIND)
          const raw = mergeByID(messages.data?.context ?? [], messages.data?.data ?? [])
          const cursor = messages.data?.cursor.next
          return { raw, cursor }
        })()
          .then((messages) => {
            if (prefetchToken.value !== token) return
            if (!isSessionPrefetchCurrent(serverSDK().scope, directory, sessionID, rev)) return

            const adapted = adaptSessionMessages(sessionID, messages.raw)
            const next = adapted.messages.filter((m): m is Message => !!m?.id)
            const sorted = mergeByID([], next)
            const stale = markPrefetched(directory, sessionID)
            const cursor = messages.cursor

            if (stale.length > 0) {
              clearSessionPrefetch(serverSDK().scope, directory, stale)
              for (const id of stale) {
                serverSync().todo.set(directory, id, undefined)
              }
            }

            const current = store.message[sessionID] ?? []
            const merged = mergeByID(
              current.filter((item): item is Message => !!item?.id),
              sorted,
            )
            const windowed = windowSessionMessages(merged, {
              mode: current.length > 0 ? "prepend" : "replace",
            })
            const keep = new Set(windowed.messages.map((message) => message.id))
            const meta = {
              limit: windowed.messages.length,
              cursor,
              complete: !cursor,
              at: Date.now(),
            }

            if (!isSessionPrefetchCurrent(serverSDK().scope, directory, sessionID, rev)) return

            batch(() => {
              if (stale.length > 0) {
                setStore(
                  produce((draft) => {
                    dropSessionCaches(draft, stale)
                  }),
                )
              }
              if (windowed.dropped.length > 0) {
                setStore(
                  produce((draft) => {
                    dropMessageParts(draft, windowed.dropped)
                  }),
                )
              }

              setStore("message", sessionID, reconcile(windowed.messages, { key: "id" }))
              setSessionPrefetch({ scope: serverSDK().scope, directory, sessionID, ...meta })

              for (const message of adapted.parts) {
                if (!keep.has(message.id)) continue
                const currentParts = store.part[message.id] ?? []
                const mergedParts = mergePartsPreservingText(
                  prefetchParts(currentParts),
                  prefetchParts(message.part),
                  store.part_text_accum_delta,
                )

                setStore("part", message.id, reconcile(mergedParts, { key: "id" }))
              }
              recordPerfEvent(server.current, {
                kind: "ui_session_prefetch_messages",
                directory,
                sessionID,
                requested: prefetchChunk,
                raw: messages.raw.length,
                messages: windowed.messages.length,
                dropped: windowed.dropped.length,
                duration_ms: Math.round(
                  (typeof performance === "undefined" ? Date.now() : performance.now()) - started,
                ),
              })
            })

            return meta
          })
          .catch((error) => {
            if (prefetchToken.value !== token || signal.aborted) return undefined
            if (!isSessionPrefetchCurrent(serverSDK().scope, directory, sessionID, rev)) return undefined
            markSessionPrefetchFailed(serverSDK().scope, directory, sessionID)
            recordPerfEvent(server.current, {
              kind: "ui_session_prefetch_failed",
              directory,
              sessionID,
              reason: error instanceof Error ? error.message : String(error),
              duration_ms: Math.round(
                (typeof performance === "undefined" ? Date.now() : performance.now()) - started,
              ),
            })
            return undefined
          }),
    })
  }

  function pumpPrefetch(directory: string) {
    if (!sessionPrefetchEnabled()) return
    if (!canRunSessionPrefetch()) {
      schedulePrefetchQueues()
      return
    }

    const q = queueFor(directory)
    if (q.running >= prefetchConcurrency) return

    const sessionID = q.pending.shift()
    if (!sessionID) return

    q.pendingSet.delete(sessionID)
    q.inflight.add(sessionID)
    q.running += 1

    const token = prefetchToken.value

    void prefetchMessages(directory, sessionID, token).finally(() => {
      q.running -= 1
      q.inflight.delete(sessionID)
      pumpPrefetch(directory)
    })
  }

  const prefetchSession = (session: Session, priority: "high" | "low" = "low") => {
    if (!sessionPrefetchEnabled()) return
    const directory = session.directory
    if (!directory) return
    if (sessionPrefetchCoolingDown(serverSDK().scope, directory, session.id)) return

    const [store] = serverSync().child(directory, { bootstrap: false })
    const cached = untrack(() => {
      const info = getSessionPrefetch(serverSDK().scope, directory, session.id)
      return shouldSkipSessionPrefetch({
        message: store.message[session.id] !== undefined,
        info,
        chunk: prefetchChunk,
      })
    })
    if (cached) return

    const q = queueFor(directory)
    if (q.inflight.has(session.id)) return
    if (q.pendingSet.has(session.id)) {
      if (priority !== "high") return
      const index = q.pending.indexOf(session.id)
      if (index > 0) {
        q.pending.splice(index, 1)
        q.pending.unshift(session.id)
      }
      return
    }

    const lru = lruFor(directory)
    const known = lru.has(session.id)
    if (!known && lru.size >= PREFETCH_MAX_SESSIONS_PER_DIR && priority !== "high") return

    if (priority === "high") q.pending.unshift(session.id)
    if (priority !== "high") q.pending.push(session.id)
    q.pendingSet.add(session.id)

    while (q.pending.length > prefetchPendingLimit) {
      const dropped = q.pending.pop()
      if (!dropped) continue
      q.pendingSet.delete(dropped)
    }

    schedulePrefetchQueues()
  }

  const warm = (sessions: Session[], index: number) => {
    for (let offset = 1; offset <= span; offset++) {
      const next = sessions[index + offset]
      if (next) prefetchSession(next, offset === 1 ? "high" : "low")

      const prev = sessions[index - offset]
      if (prev) prefetchSession(prev, offset === 1 ? "high" : "low")
    }
  }

  createEffect(() => {
    prefetchResetVersion()
    const sessions = currentSessions()
    if (sessions.length === 0) return

    const index = params.id ? sessions.findIndex((s) => s.id === params.id) : 0
    if (index === -1) return

    if (!params.id) {
      const first = sessions[index]
      if (first) prefetchSession(first, "high")
    }

    warm(sessions, index)
  })

  function navigateSessionByOffset(offset: number) {
    const sessions = currentSessions()
    if (sessions.length === 0) return

    const sessionIndex = params.id ? sessions.findIndex((s) => s.id === params.id) : -1

    let targetIndex: number
    if (sessionIndex === -1) {
      targetIndex = offset > 0 ? 0 : sessions.length - 1
    } else {
      targetIndex = (sessionIndex + offset + sessions.length) % sessions.length
    }

    const session = sessions[targetIndex]
    if (!session) return

    prefetchSession(session, "high")
    warm(sessions, targetIndex)

    navigateToSession(session)
  }

  function navigateProjectByOffset(offset: number) {
    const projects = layout.projects.list()
    if (projects.length === 0) return

    const current = currentProject()?.worktree
    const fallback = currentDir() ? projectRoot(currentDir()) : undefined
    const active = current ?? fallback
    const index = active ? projects.findIndex((project) => project.worktree === active) : -1

    const target =
      index === -1
        ? offset > 0
          ? projects[0]
          : projects[projects.length - 1]
        : projects[(index + offset + projects.length) % projects.length]
    if (!target) return

    // warm up child store to prevent flicker
    serverSync().child(target.worktree)
    void openProject(target.worktree)
  }

  function navigateToProjectIndex(index: number) {
    const projects = layout.projects.list()
    const target = projects[index]
    if (!target) return

    serverSync().child(target.worktree)
    void openProject(target.worktree)
  }

  function navigateSessionByUnseen(offset: number) {
    const sessions = currentSessions()
    if (sessions.length === 0) return

    const hasUnseen = sessions.some((session) => notification.session.unseenCount(session.id) > 0)
    if (!hasUnseen) return

    const activeIndex = params.id ? sessions.findIndex((s) => s.id === params.id) : -1
    const start = activeIndex === -1 ? (offset > 0 ? -1 : 0) : activeIndex

    for (let i = 1; i <= sessions.length; i++) {
      const index = offset > 0 ? (start + i) % sessions.length : (start - i + sessions.length) % sessions.length
      const session = sessions[index]
      if (!session) continue
      if (notification.session.unseenCount(session.id) === 0) continue

      prefetchSession(session, "high")
      warm(sessions, index)

      navigateToSession(session)
      return
    }
  }

  async function archiveSession(session: Session) {
    const owner = server.key
    const [store, setStore] = serverSync().child(session.directory)
    const sessions = store.session ?? []
    const index = sessions.findIndex((s) => s.id === session.id)
    const nextSession = sessions[index + 1] ?? sessions[index - 1]

    await serverSDK().client.session.update({
      directory: session.directory,
      sessionID: session.id,
      time: { archived: Date.now() },
    })
    setStore(
      produce((draft) => {
        const match = Binary.search(draft.session, session.id, (s) => s.id)
        if (match.found) draft.session.splice(match.index, 1)
        else if (draft.session.some((s) => s.id === session.id)) {
          draft.session = draft.session.filter((s) => s.id !== session.id)
        }
      }),
    )
    notifySessionTabsRemoved({ server: owner, directory: session.directory, sessionIDs: [session.id] })
    if (session.id === params.id) {
      if (nextSession) {
        navigate(`/${params.dir}/session/${nextSession.id}`)
      } else {
        navigate(`/${params.dir}/session`)
      }
    }
  }

  command.register("layout", () => {
    const commands: CommandOption[] = [
      {
        id: "sidebar.toggle",
        title: language.t("command.sidebar.toggle"),
        category: language.t("command.category.view"),
        keybind: undefined,
        onSelect: () => layout.sidebar.toggle(),
      },
      {
        id: "project.open",
        title: language.t("command.project.open"),
        category: language.t("command.category.project"),
        keybind: "mod+o",
        onSelect: () => chooseProject(),
      },
      {
        id: "project.previous",
        title: language.t("command.project.previous"),
        category: language.t("command.category.project"),
        keybind: "mod+alt+arrowup",
        onSelect: () => navigateProjectByOffset(-1),
      },
      {
        id: "project.next",
        title: language.t("command.project.next"),
        category: language.t("command.category.project"),
        keybind: "mod+alt+arrowdown",
        onSelect: () => navigateProjectByOffset(1),
      },
      {
        id: "provider.connect",
        title: language.t("command.provider.connect"),
        category: language.t("command.category.provider"),
        onSelect: () => connectProvider(),
      },
      {
        id: "server.switch",
        title: language.t("command.server.switch"),
        category: language.t("command.category.server"),
        onSelect: () => openServer(),
      },
      {
        id: "settings.open",
        title: language.t("command.settings.open"),
        category: language.t("command.category.settings"),
        keybind: "mod+comma",
        onSelect: () => openSettings(),
      },
      ...(platform.platform === "desktop" && platform.exportDebugLogs
        ? [
            {
              id: "logs.export",
              title: "Export logs",
              category: language.t("command.category.settings"),
              onSelect: () => {
                void platform.exportDebugLogs?.()
              },
            },
          ]
        : []),
      {
        id: "session.previous",
        title: language.t("command.session.previous"),
        category: language.t("command.category.session"),
        keybind: "alt+arrowup",
        onSelect: () => navigateSessionByOffset(-1),
      },
      {
        id: "session.next",
        title: language.t("command.session.next"),
        category: language.t("command.category.session"),
        keybind: "alt+arrowdown",
        onSelect: () => navigateSessionByOffset(1),
      },
      {
        id: "session.previous.unseen",
        title: language.t("command.session.previous.unseen"),
        category: language.t("command.category.session"),
        keybind: "shift+alt+arrowup",
        onSelect: () => navigateSessionByUnseen(-1),
      },
      {
        id: "session.next.unseen",
        title: language.t("command.session.next.unseen"),
        category: language.t("command.category.session"),
        keybind: "shift+alt+arrowdown",
        onSelect: () => navigateSessionByUnseen(1),
      },
      {
        id: "session.archive",
        title: language.t("command.session.archive"),
        category: language.t("command.category.session"),
        keybind: "mod+shift+backspace",
        disabled: !params.dir || !params.id,
        onSelect: () => {
          const session = currentSessions().find((s) => s.id === params.id)
          if (session) void archiveSession(session)
        },
      },
      {
        id: "workspace.new",
        title: language.t("workspace.new"),
        category: language.t("command.category.workspace"),
        keybind: "mod+shift+w",
        disabled: !workspaceSetting(),
        onSelect: () => {
          const project = currentProject()
          if (!project) return
          return createWorkspace(project)
        },
      },
      {
        id: "workspace.toggle",
        title: language.t("command.workspace.toggle"),
        description: language.t("command.workspace.toggle.description"),
        category: language.t("command.category.workspace"),
        slash: "workspace",
        disabled: !currentProject() || currentProject()?.vcs !== "git",
        onSelect: () => {
          const project = currentProject()
          if (!project) return
          if (project.vcs !== "git") return
          const wasEnabled = layout.sidebar.workspaces(project.worktree)()
          layout.sidebar.toggleWorkspaces(project.worktree)
          showToast({
            title: wasEnabled
              ? language.t("toast.workspace.disabled.title")
              : language.t("toast.workspace.enabled.title"),
            description: wasEnabled
              ? language.t("toast.workspace.disabled.description")
              : language.t("toast.workspace.enabled.description"),
          })
        },
      },
      {
        id: "theme.cycle",
        title: language.t("command.theme.cycle"),
        category: language.t("command.category.theme"),
        keybind: "mod+shift+t",
        onSelect: () => cycleTheme(1),
      },
    ]

    for (const [id] of availableThemeEntries()) {
      commands.push({
        id: `theme.set.${id}`,
        title: language.t("command.theme.set", { theme: theme.name(id) }),
        category: language.t("command.category.theme"),
        onSelect: () => theme.commitPreview(),
        onHighlight: () => {
          theme.previewTheme(id)
          return () => theme.cancelPreview()
        },
      })
    }

    commands.push({
      id: "theme.scheme.cycle",
      title: language.t("command.theme.scheme.cycle"),
      category: language.t("command.category.theme"),
      keybind: "mod+shift+s",
      onSelect: () => cycleColorScheme(1),
    })

    for (const scheme of colorSchemeOrder) {
      commands.push({
        id: `theme.scheme.${scheme}`,
        title: language.t("command.theme.scheme.set", { scheme: colorSchemeLabel(scheme) }),
        category: language.t("command.category.theme"),
        onSelect: () => theme.commitPreview(),
        onHighlight: () => {
          theme.previewColorScheme(scheme)
          return () => theme.cancelPreview()
        },
      })
    }

    commands.push({
      id: "language.cycle",
      title: language.t("command.language.cycle"),
      category: language.t("command.category.language"),
      onSelect: () => cycleLanguage(1),
    })

    for (const locale of language.locales) {
      commands.push({
        id: `language.set.${locale}`,
        title: language.t("command.language.set", { language: language.label(locale) }),
        category: language.t("command.category.language"),
        onSelect: () => setLocale(locale),
      })
    }

    return commands
  })

  function connectProvider() {
    const run = ++dialogRun
    void import("@/components/dialog-select-provider").then((x) => {
      if (dialogDead || dialogRun !== run) return
      dialog.show(() => <x.DialogSelectProvider />)
    })
  }

  function openServer() {
    const run = ++dialogRun
    void import("@/components/dialog-select-server").then((x) => {
      if (dialogDead || dialogRun !== run) return
      dialog.show(() => <x.DialogSelectServer />)
    })
  }

  function openSettings() {
    const run = ++dialogRun
    void import("@/components/settings-v2").then((x) => {
      if (dialogDead || dialogRun !== run) return
      dialog.show(() => <x.DialogSettings initialDirectory={currentDir()} />)
    })
  }

  function projectRoot(directory: string) {
    const key = pathKey(directory)
    const lookup = projectLookup()
    const project = lookup.byWorktreeKey.get(key) ?? lookup.bySandboxKey.get(key)
    if (project) return project.worktree

    const known = Object.entries(store.workspaceOrder).find(
      ([root, dirs]) => pathKey(root) === key || dirs.some((item) => pathKey(item) === key),
    )
    if (known) return known[0]

    const [child] = serverSync().child(directory, { bootstrap: false })
    const id = child.project
    if (!id) return directory

    const meta = serverSync().data.project.find((item) => item.id === id)
    return meta?.worktree ?? directory
  }

  function activeProjectRoot(directory: string) {
    return currentProject()?.worktree ?? projectRoot(directory)
  }

  function rememberSessionRoute(directory: string, id: string, root = activeProjectRoot(directory)) {
    setStore("lastProjectSession", root, { directory, id, at: Date.now() })
    return root
  }

  function clearLastProjectSession(root: string) {
    if (!store.lastProjectSession[root]) return
    setStore(
      "lastProjectSession",
      produce((draft) => {
        delete draft[root]
      }),
    )
  }

  function syncSessionRoute(directory: string, id: string, root = activeProjectRoot(directory)) {
    rememberSessionRoute(directory, id, root)
    notification.session.markViewed(id)
    const expanded = untrack(() => store.workspaceExpanded[directory])
    if (expanded === false) {
      setStore("workspaceExpanded", directory, true)
    }
    requestAnimationFrame(() => scrollToSession(id, `${directory}:${id}`))
    return root
  }

  async function navigateToProject(directory: string | undefined) {
    if (!directory) return
    const root = projectRoot(directory)
    server.projects.touch(root)
    const project = layout.projects.list().find((item) => item.worktree === root)
    let dirs = project
      ? effectiveWorkspaceOrder(root, [root, ...(project.sandboxes ?? [])], store.workspaceOrder[root])
      : [root]
    const canOpen = (value: string | undefined) => {
      if (!value) return false
      return dirs.some((item) => pathKey(item) === pathKey(value))
    }
    const refreshDirs = async (target?: string) => {
      if (!target || target === root || canOpen(target)) return canOpen(target)
      const listed = await serverSDK()
        .client.worktree.list({ directory: root })
        .then((x) => x.data ?? [])
        .catch(() => [] as string[])
      dirs = effectiveWorkspaceOrder(root, [root, ...listed], store.workspaceOrder[root])
      return canOpen(target)
    }
    const openSession = async (target: { directory: string; id: string }) => {
      if (!canOpen(target.directory)) return false
      const [data] = serverSync().child(target.directory, { bootstrap: false })
      if (data.session.some((item) => item.id === target.id)) {
        setStore("lastProjectSession", root, { directory: target.directory, id: target.id, at: Date.now() })
        navigateWithSidebarReset(`/${base64Encode(target.directory)}/session/${target.id}`)
        return true
      }
      const resolved = await serverSDK()
        .client.session.get({ sessionID: target.id })
        .then((x) => x.data)
        .catch(() => undefined)
      if (!resolved?.directory) return false
      if (!canOpen(resolved.directory)) return false
      setStore("lastProjectSession", root, { directory: resolved.directory, id: resolved.id, at: Date.now() })
      navigateWithSidebarReset(`/${base64Encode(resolved.directory)}/session/${resolved.id}`)
      return true
    }

    const projectSession = store.lastProjectSession[root]
    if (projectSession?.id) {
      await refreshDirs(projectSession.directory)
      const opened = await openSession(projectSession)
      if (opened) return
      clearLastProjectSession(root)
    }

    const latest = latestRootSession([serverSync().child(root, { bootstrap: false })[0]], Date.now())
    if (latest && (await openSession(latest))) {
      return
    }

    const fetched = latestRootSession(
      [
        {
          path: { directory: root },
          session: await serverSDK()
            .client.session.list({ directory: root })
            .then((x) => x.data ?? [])
            .catch(() => []),
        },
      ],
      Date.now(),
    )
    if (fetched && (await openSession(fetched))) {
      return
    }

    navigateWithSidebarReset(`/${base64Encode(root)}/session`)
  }

  function navigateToSession(session: Session | undefined) {
    if (!session) return
    navigateWithSidebarReset(`/${base64Encode(session.directory)}/session/${session.id}`)
  }

  async function openProject(directory: string, navigate = true) {
    const key = server.key
    const real = await layout.projects.register(directory)
    if (navigate && real && server.key === key) return navigateToProject(real)
  }

  const pluginHandoffScope = createMemo(() => {
    const serverID = server.key
    const controller = new AbortController()
    onCleanup(() => controller.abort())
    return { serverID, signal: controller.signal }
  })

  const handleDeepLinks = (urls: string[]) => {
    if (!server.isLocal()) return

    for (const directory of collectOpenProjectDeepLinks(urls)) {
      void openProject(directory)
    }

    for (const link of collectNewSessionDeepLinks(urls)) {
      void openProject(link.directory, false)
      const slug = base64Encode(link.directory)
      if (link.prompt) {
        setSessionHandoff(SessionStateKey.from(server.scope(), SessionRouteKey.fromLegacy(slug)), {
          prompt: link.prompt,
        })
      }
      const href = link.prompt ? `/${slug}/session?prompt=${encodeURIComponent(link.prompt)}` : `/${slug}/session`
      navigateWithSidebarReset(href)
    }

    for (const link of collectPluginHandoffDeepLinks(urls)) {
      const scope = pluginHandoffScope()
      void navigationHandoffs.dispatch(link, { ...scope, source: "external" }, true).then((result) => {
        if (!result.ok && !scope.signal.aborted) showToast({ title: "Plugin handoff failed", description: result.error })
      })
    }
  }

  onMount(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ urls: string[] }>).detail
      const urls = detail?.urls ?? []
      if (urls.length === 0) return
      handleDeepLinks(consumeDeepLinkEvent(window, urls))
    }

    makeEventListener(window, deepLinkEvent, handler as EventListener)
    handleDeepLinks(drainPendingDeepLinks(window))
  })

  async function renameProject(project: LocalProject, next: string) {
    const current = displayName(project)
    if (next === current) return
    const name = next === getFilename(project.worktree) ? "" : next

    if (project.id && project.id !== "global") {
      await serverSDK().client.project.update({ projectID: project.id, directory: project.worktree, name })
      return
    }

    serverSync().project.meta(project.worktree, { name })
  }

  const renameWorkspace = (directory: string, next: string, projectId?: string, branch?: string) => {
    const current = workspaceName(directory, projectId, branch) ?? branch ?? getFilename(directory)
    if (current === next) return
    setWorkspaceName(directory, next, projectId, branch)
  }

  function closeProject(directory: string) {
    const list = layout.projects.list()
    const key = pathKey(directory)
    const index = list.findIndex((x) => pathKey(x.worktree) === key)
    const active = pathKey(currentProject()?.worktree ?? "") === key
    if (index === -1) return

    if (!active) {
      layout.projects.close(directory)
      return
    }

    if (list.length === 1) {
      layout.projects.close(directory)
      navigate("/")
      return
    }

    const next = list[index + 1] ?? list[index - 1]

    navigateWithSidebarReset(`/${base64Encode(next.worktree)}/session`)
    layout.projects.close(directory)
    queueMicrotask(() => {
      void navigateToProject(next.worktree)
    })
  }

  function toggleProjectWorkspaces(project: LocalProject) {
    const enabled = layout.sidebar.workspaces(project.worktree)()
    if (enabled) {
      layout.sidebar.toggleWorkspaces(project.worktree)
      return
    }
    if (project.vcs !== "git") return
    layout.sidebar.toggleWorkspaces(project.worktree)
  }

  const showEditProjectDialog = (conn: ServerConnection.Any, project: LocalProject) => {
    const run = ++dialogRun
    void import("@/components/dialog-edit-project").then((x) => {
      if (dialogDead || dialogRun !== run) return
      dialog.show(() => <x.DialogEditProject server={conn} project={project} />)
    })
  }

  function chooseProject() {
    const conn = server.current
    if (!conn) return
    function resolve(result: string | string[] | null) {
      if (Array.isArray(result)) {
        for (const directory of result) {
          void openProject(directory, false)
        }
        void navigateToProject(result[0])
      } else if (result) {
        void openProject(result)
      }
    }

    pickDirectory({
      server: conn,
      title: language.t("command.project.open"),
      multiple: true,
      onSelect: resolve,
    })
  }

  const deleteWorkspace = async (root: string, directory: string, leaveDeletedWorkspace = false) => {
    if (directory === root) return

    const current = currentDir()
    const currentKey = pathKey(current)
    const deletedKey = pathKey(directory)
    const shouldLeave = leaveDeletedWorkspace || (!!params.dir && currentKey === deletedKey)
    if (!leaveDeletedWorkspace && shouldLeave) {
      navigateWithSidebarReset(`/${base64Encode(root)}/session`)
    }

    setBusy(directory, true)

    const result = await serverSDK()
      .client.worktree.remove({ directory: root, worktreeRemoveInput: { directory } })
      .then((x) => x.data)
      .catch((err) => {
        showToast({
          title: language.t("workspace.delete.failed.title"),
          description: errorMessage(err, language.t("common.requestFailed")),
        })
        return false
      })

    setBusy(directory, false)

    if (!result) return

    if (pathKey(store.lastProjectSession[root]?.directory ?? "") === pathKey(directory)) {
      clearLastProjectSession(root)
    }

    serverSync().set(
      "project",
      produce((draft) => {
        const project = draft.find((item) => item.worktree === root)
        if (!project) return
        project.sandboxes = (project.sandboxes ?? []).filter((sandbox) => sandbox !== directory)
      }),
    )
    setStore("workspaceOrder", root, (order) => (order ?? []).filter((workspace) => workspace !== directory))

    layout.projects.close(directory)
    layout.projects.open(root)

    if (shouldLeave) return

    const nextCurrent = currentDir()
    const nextKey = pathKey(nextCurrent)
    const project = layout.projects.list().find((item) => item.worktree === root)
    const dirs = project
      ? effectiveWorkspaceOrder(root, [root, ...(project.sandboxes ?? [])], store.workspaceOrder[root])
      : [root]
    const valid = dirs.some((item) => pathKey(item) === nextKey)

    if (params.dir && projectRoot(nextCurrent) === root && !valid) {
      navigateWithSidebarReset(`/${base64Encode(root)}/session`)
    }
  }

  const resetWorkspace = async (root: string, directory: string) => {
    if (directory === root) return
    setBusy(directory, true)

    const progress = showToast({
      persistent: true,
      title: language.t("workspace.resetting.title"),
      description: language.t("workspace.resetting.description"),
    })
    const dismiss = () => toaster.dismiss(progress)

    const sessions: Session[] = await serverSDK()
      .client.session.list({ directory })
      .then((x) => x.data ?? [])
      .catch(() => [])

    clearWorkspaceTerminals(
      directory,
      sessions.map((s) => s.id),
      platform,
      serverSDK().scope,
    )
    await serverSDK()
      .client.instance.dispose({ directory })
      .catch(() => undefined)

    const result = await serverSDK()
      .client.worktree.reset({ directory: root, worktreeResetInput: { directory } })
      .then((x) => x.data)
      .catch((err) => {
        showToast({
          title: language.t("workspace.reset.failed.title"),
          description: errorMessage(err, language.t("common.requestFailed")),
        })
        return false
      })

    if (!result) {
      setBusy(directory, false)
      dismiss()
      return
    }

    const archivedAt = Date.now()
    await Promise.all(
      sessions
        .filter((session) => session.time.archived === undefined)
        .map((session) =>
          serverSDK()
            .client.session.update({
              sessionID: session.id,
              directory: session.directory,
              time: { archived: archivedAt },
            })
            .catch(() => undefined),
        ),
    )

    setBusy(directory, false)
    dismiss()

    showToast({
      title: language.t("workspace.reset.success.title"),
      description: language.t("workspace.reset.success.description"),
      actions: [
        {
          label: language.t("command.session.new"),
          onClick: () => {
            const href = `/${base64Encode(directory)}/session`
            navigate(href)
            layout.mobileSidebar.hide()
          },
        },
        {
          label: language.t("common.dismiss"),
          onClick: "dismiss",
        },
      ],
    })
  }

  function DialogDeleteWorkspace(props: { root: string; directory: string }) {
    const name = createMemo(() => getFilename(props.directory))
    const [data, setData] = createStore({
      status: "loading" as "loading" | "ready" | "error",
      dirty: false,
    })

    onMount(() => {
      serverSDK()
        .client.vcs.status({ directory: props.directory })
        .then((x) => {
          const files = x.data ?? []
          const dirty = files.length > 0
          setData({ status: "ready", dirty })
        })
        .catch(() => {
          setData({ status: "error", dirty: false })
        })
    })

    const handleDelete = () => {
      const leaveDeletedWorkspace = !!params.dir && pathKey(currentDir()) === pathKey(props.directory)
      if (leaveDeletedWorkspace) {
        navigateWithSidebarReset(`/${base64Encode(props.root)}/session`)
      }
      dialog.close()
      void deleteWorkspace(props.root, props.directory, leaveDeletedWorkspace)
    }

    const description = () => {
      if (data.status === "loading") return language.t("workspace.status.checking")
      if (data.status === "error") return language.t("workspace.status.error")
      if (!data.dirty) return language.t("workspace.status.clean")
      return language.t("workspace.status.dirty")
    }

    return (
      <Dialog title={language.t("workspace.delete.title")} fit>
        <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
          <div class="flex flex-col gap-1">
            <span class="text-14-regular text-text-strong">
              {language.t("workspace.delete.confirm", { name: name() })}
            </span>
            <span class="text-12-regular text-text-weak">{description()}</span>
          </div>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button variant="primary" size="large" disabled={data.status === "loading"} onClick={handleDelete}>
              {language.t("workspace.delete.button")}
            </Button>
          </div>
        </div>
      </Dialog>
    )
  }

  function DialogResetWorkspace(props: { root: string; directory: string }) {
    const name = createMemo(() => getFilename(props.directory))
    const [state, setState] = createStore({
      status: "loading" as "loading" | "ready" | "error",
      dirty: false,
      sessions: [] as Session[],
    })

    const refresh = async () => {
      const sessions = await serverSDK()
        .client.session.list({ directory: props.directory })
        .then((x) => x.data ?? [])
        .catch(() => [])
      const active = sessions.filter((session) => session.time.archived === undefined)
      setState({ sessions: active })
    }

    onMount(() => {
      serverSDK()
        .client.vcs.status({ directory: props.directory })
        .then((x) => {
          const files = x.data ?? []
          const dirty = files.length > 0
          setState({ status: "ready", dirty })
          void refresh()
        })
        .catch(() => {
          setState({ status: "error", dirty: false })
        })
    })

    const handleReset = () => {
      dialog.close()
      void resetWorkspace(props.root, props.directory)
    }

    const archivedCount = () => state.sessions.length

    const description = () => {
      if (state.status === "loading") return language.t("workspace.status.checking")
      if (state.status === "error") return language.t("workspace.status.error")
      if (!state.dirty) return language.t("workspace.status.clean")
      return language.t("workspace.status.dirty")
    }

    const archivedLabel = () => {
      const count = archivedCount()
      if (count === 0) return language.t("workspace.reset.archived.none")
      if (count === 1) return language.t("workspace.reset.archived.one")
      return language.t("workspace.reset.archived.many", { count })
    }

    return (
      <Dialog title={language.t("workspace.reset.title")} fit>
        <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
          <div class="flex flex-col gap-1">
            <span class="text-14-regular text-text-strong">
              {language.t("workspace.reset.confirm", { name: name() })}
            </span>
            <span class="text-12-regular text-text-weak">
              {description()} {archivedLabel()} {language.t("workspace.reset.note")}
            </span>
          </div>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button variant="primary" size="large" disabled={state.status === "loading"} onClick={handleReset}>
              {language.t("workspace.reset.button")}
            </Button>
          </div>
        </div>
      </Dialog>
    )
  }

  const activeRoute = {
    session: "",
    sessionProject: "",
    directory: "",
  }

  createEffect(
    on(
      () => {
        return [pageReady(), route().slug, params.id, currentProject()?.worktree, currentDir()] as const
      },
      ([ready, slug, id, root, dir]) => {
        if (!ready || !slug || !dir) {
          activeRoute.session = ""
          activeRoute.sessionProject = ""
          activeRoute.directory = ""
          return
        }

        if (!id) {
          activeRoute.session = ""
          activeRoute.sessionProject = ""
          activeRoute.directory = ""
          return
        }

        const session = `${slug}/${id}`

        if (!root) {
          activeRoute.session = session
          activeRoute.directory = dir
          activeRoute.sessionProject = ""
          return
        }

        if (server.projects.last() !== root) server.projects.touch(root)

        const changed = session !== activeRoute.session || dir !== activeRoute.directory
        if (changed) {
          activeRoute.session = session
          activeRoute.directory = dir
          activeRoute.sessionProject = syncSessionRoute(dir, id, root)
          return
        }

        if (root === activeRoute.sessionProject) return
        activeRoute.directory = dir
        activeRoute.sessionProject = rememberSessionRoute(dir, id, root)
      },
    ),
  )

  createEffect(() => {
    document.documentElement.style.setProperty("--dialog-left-margin", "0px")
  })

  const side = createMemo(() => Math.max(layout.sidebar.width(), 244))
  const panel = createMemo(() => Math.max(side() - 64, 0))

  const loadedSessionDirs = new Set<string>()

  createEffect(
    on(
      visibleSessionDirs,
      (dirs) => {
        if (dirs.length === 0) {
          loadedSessionDirs.clear()
          return
        }

        const next = new Set(dirs)
        for (const directory of next) {
          if (loadedSessionDirs.has(directory)) continue
          void serverSync().project.loadSessions(directory)
        }

        loadedSessionDirs.clear()
        for (const directory of next) {
          loadedSessionDirs.add(directory)
        }
      },
      { defer: true },
    ),
  )

  function handleDragStart(event: unknown) {
    const id = getDraggableId(event)
    if (!id) return
    setHoverProject(undefined)
    setStore("activeProject", id)
  }

  function handleDragOver(event: DragEvent) {
    const { draggable, droppable } = event
    if (draggable && droppable) {
      const projects = layout.projects.list()
      const fromIndex = projects.findIndex((p) => p.worktree === draggable.id.toString())
      const toIndex = projects.findIndex((p) => p.worktree === droppable.id.toString())
      if (fromIndex !== toIndex && toIndex !== -1) {
        layout.projects.move(draggable.id.toString(), toIndex)
      }
    }
  }

  function handleDragEnd() {
    setStore("activeProject", undefined)
  }

  function workspaceIds(project: LocalProject | undefined) {
    if (!project) return []
    const local = project.worktree
    const dirs = [local, ...(project.sandboxes ?? [])]
    const active = currentProject()
    const directory = pathKey(active?.worktree ?? "") === pathKey(project.worktree) ? currentDir() : undefined
    const extra =
      directory && pathKey(directory) !== pathKey(local) && !dirs.some((item) => pathKey(item) === pathKey(directory))
        ? directory
        : undefined
    const pending = extra ? WorktreeState.get(serverSDK().scope, extra)?.status === "pending" : false

    const ordered = effectiveWorkspaceOrder(local, dirs, store.workspaceOrder[project.worktree])
    if (pending && extra) return [local, extra, ...ordered.filter((item) => item !== local)]
    if (!extra) return ordered
    if (pending) return ordered
    return [...ordered, extra]
  }

  const sidebarProject = createMemo(() => {
    if (layout.sidebar.opened()) return currentProject()
    const hovered = hoverProjectData()
    if (hovered) return hovered
    return currentProject()
  })

  function handleWorkspaceDragStart(event: unknown) {
    const id = getDraggableId(event)
    if (!id) return
    setStore("activeWorkspace", id)
  }

  function handleWorkspaceDragOver(event: DragEvent) {
    const { draggable, droppable } = event
    if (!draggable || !droppable) return

    const project = sidebarProject()
    if (!project) return

    const ids = workspaceIds(project)
    const fromIndex = ids.findIndex((dir) => dir === draggable.id.toString())
    const toIndex = ids.findIndex((dir) => dir === droppable.id.toString())
    if (fromIndex === -1 || toIndex === -1) return
    if (fromIndex === toIndex) return

    const result = ids.slice()
    const [item] = result.splice(fromIndex, 1)
    if (!item) return
    result.splice(toIndex, 0, item)
    setStore(
      "workspaceOrder",
      project.worktree,
      result.filter((directory) => pathKey(directory) !== pathKey(project.worktree)),
    )
  }

  function handleWorkspaceDragEnd() {
    setStore("activeWorkspace", undefined)
  }

  const createWorkspace = async (project: LocalProject) => {
    clearSidebarHoverState()
    const created = await serverSDK()
      .client.worktree.create({ directory: project.worktree })
      .then((x) => x.data)
      .catch((err) => {
        showToast({
          title: language.t("workspace.create.failed.title"),
          description: errorMessage(err, language.t("common.requestFailed")),
        })
        return undefined
      })

    if (!created?.directory) return

    setWorkspaceName(created.directory, created.branch ?? getFilename(created.directory), project.id, created.branch)

    const local = project.worktree
    const key = pathKey(created.directory)
    const root = pathKey(local)

    setBusy(created.directory, true)
    WorktreeState.pending(serverSDK().scope, created.directory)
    setStore("workspaceExpanded", key, true)
    if (key !== created.directory) {
      setStore("workspaceExpanded", created.directory, true)
    }
    setStore("workspaceOrder", project.worktree, (prev) => {
      const existing = prev ?? []
      const next = existing.filter((item) => {
        const id = pathKey(item)
        return id !== root && id !== key
      })
      return [created.directory, ...next]
    })

    serverSync().child(created.directory)
    navigateWithSidebarReset(`/${base64Encode(created.directory)}/session`)
  }

  const workspaceSidebarCtx: WorkspaceSidebarContext = {
    currentDir,
    navList: currentSessions,
    sidebarExpanded,
    sidebarHovering,
    clearHoverProjectSoon,
    prefetchSession,
    archiveSession,
    workspaceName,
    renameWorkspace,
    editorOpen,
    openEditor,
    closeEditor,
    setEditor,
    InlineEditor,
    isBusy,
    workspaceExpanded: (directory, local) => store.workspaceExpanded[directory] ?? local,
    setWorkspaceExpanded: (directory, value) => setStore("workspaceExpanded", directory, value),
    showResetWorkspaceDialog: (root, directory) =>
      dialog.show(() => <DialogResetWorkspace root={root} directory={directory} />),
    showDeleteWorkspaceDialog: (root, directory) =>
      dialog.show(() => <DialogDeleteWorkspace root={root} directory={directory} />),
    setScrollContainerRef: (el, mobile) => {
      if (!mobile) scrollContainerRef = el
    },
  }

  const projectSidebarCtx: ProjectSidebarContext = {
    currentDir,
    currentProject,
    sidebarOpened: () => layout.sidebar.opened(),
    sidebarHovering,
    hoverProject: () => state.hoverProject,
    onProjectMouseEnter: (worktree, event) => aim.enter(worktree, event),
    onProjectMouseLeave: (worktree) => aim.leave(worktree),
    onProjectFocus: (worktree) => aim.activate(worktree),
    onHoverOpenChanged: (worktree, hoverOpen) => {
      if (!hoverOpen && state.hoverProject && state.hoverProject !== worktree) return
      setState("hoverProject", hoverOpen ? worktree : undefined)
    },
    navigateToProject,
    openSidebar: () => layout.sidebar.open(),
    closeProject,
    showEditProjectDialog: (proj) => showEditProjectDialog(server.current!, proj),
    toggleProjectWorkspaces,
    workspacesEnabled: (project) => project.vcs === "git" && layout.sidebar.workspaces(project.worktree)(),
    workspaceIds,
    workspaceLabel,
    sessionProps: {
      navList: currentSessions,
      sidebarExpanded,
      clearHoverProjectSoon,
      prefetchSession,
      archiveSession,
    },
  }

  const SidebarPanel = (panelProps: {
    project: Accessor<LocalProject | undefined>
    mobile?: boolean
    merged?: boolean
  }) => {
    const project = panelProps.project
    const merged = createMemo(() => panelProps.mobile || (panelProps.merged ?? layout.sidebar.opened()))
    const hover = createMemo(() => !panelProps.mobile && panelProps.merged === false && !layout.sidebar.opened())
    const empty = createMemo(() => !params.dir && layout.projects.list().length === 0)
    const projectName = createMemo(() => {
      const item = project()
      if (!item) return ""
      return item.name || getFilename(item.worktree)
    })
    const projectId = createMemo(() => project()?.id ?? "")
    const worktree = createMemo(() => project()?.worktree ?? "")
    const slug = createMemo(() => {
      const dir = worktree()
      if (!dir) return ""
      return base64Encode(dir)
    })
    const workspaces = createMemo(() => {
      const item = project()
      if (!item) return [] as string[]
      return workspaceIds(item)
    })
    const unseenCount = createMemo(() =>
      workspaces().reduce((total, directory) => total + notification.project.unseenCount(directory), 0),
    )
    const clearNotifications = () =>
      workspaces()
        .filter((directory) => notification.project.unseenCount(directory) > 0)
        .forEach((directory) => notification.project.markViewed(directory))
    const workspacesEnabled = createMemo(() => {
      const item = project()
      if (!item) return false
      if (item.vcs !== "git") return false
      return layout.sidebar.workspaces(item.worktree)()
    })
    const canToggle = createMemo(() => {
      const item = project()
      if (!item) return false
      return item.vcs === "git" || layout.sidebar.workspaces(item.worktree)()
    })
    const homedir = createMemo(() => serverSync().data.path.home)

    return (
      <div
        classList={{
          "flex flex-col min-h-0 min-w-0 box-border rounded-tl-[12px] px-3": true,
          "border border-b-0 border-border-weak-base": !merged(),
          "border-l border-t border-border-weaker-base": merged(),
          "bg-background-base": merged() || hover(),
          "bg-background-stronger": !merged() && !hover(),
          "flex-1 min-w-0": panelProps.mobile,
          "max-w-full overflow-hidden": panelProps.mobile,
        }}
        style={{
          width: panelProps.mobile ? undefined : `${panel()}px`,
        }}
      >
        <Show
          when={project()}
          fallback={
            <Show when={empty()}>
              <div class="flex-1 min-h-0 -mt-4 flex items-center justify-center px-6 pb-64 text-center">
                <div class="mt-8 flex max-w-60 flex-col items-center gap-6 text-center">
                  <div class="flex flex-col gap-3">
                    <div class="text-14-medium text-text-strong">{language.t("sidebar.empty.title")}</div>
                    <div class="text-14-regular text-text-base" style={{ "line-height": "var(--line-height-normal)" }}>
                      {language.t("sidebar.empty.description")}
                    </div>
                  </div>
                  <Button size="large" icon="folder-add-left" onClick={chooseProject}>
                    {language.t("command.project.open")}
                  </Button>
                </div>
              </div>
            </Show>
          }
          keyed
        >
          {(project) => (
            <>
              <div class="shrink-0 pl-1 py-1">
                <div class="group/project flex items-start justify-between gap-2 py-2 pl-2 pr-0">
                  <div class="flex flex-col min-w-0">
                    <InlineEditor
                      id={`project:${projectId()}`}
                      value={projectName}
                      onSave={(next) => {
                        void renameProject(project, next)
                      }}
                      class="text-14-medium text-text-strong truncate"
                      displayClass="text-14-medium text-text-strong truncate"
                      stopPropagation
                    />

                    <Tooltip
                      placement="bottom"
                      gutter={2}
                      value={worktree()}
                      class="shrink-0"
                      contentStyle={{
                        "max-width": "640px",
                        transform: "translate3d(52px, 0, 0)",
                      }}
                    >
                      <span class="text-12-regular text-text-base truncate select-text">
                        {worktree().replace(homedir(), "~")}
                      </span>
                    </Tooltip>
                  </div>

                  <DropdownMenu modal={!sidebarHovering()}>
                    <DropdownMenu.Trigger
                      as={IconButton}
                      icon="dot-grid"
                      variant="ghost"
                      data-action="project-menu"
                      data-project={slug()}
                      class="shrink-0 size-6 rounded-md transition-opacity data-[expanded]:bg-surface-base-active"
                      classList={{
                        "opacity-100": panelProps.mobile || merged(),
                        "opacity-0 group-hover/project:opacity-100 group-focus-within/project:opacity-100 data-[expanded]:opacity-100":
                          !panelProps.mobile && !merged(),
                      }}
                      aria-label={language.t("common.moreOptions")}
                    />
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content class="mt-1">
                        <DropdownMenu.Item
                          onSelect={() => {
                            showEditProjectDialog(server.current!, project)
                          }}
                        >
                          <DropdownMenu.ItemLabel>{language.t("common.edit")}</DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          data-action="project-workspaces-toggle"
                          data-project={slug()}
                          disabled={!canToggle()}
                          onSelect={() => {
                            toggleProjectWorkspaces(project)
                          }}
                        >
                          <DropdownMenu.ItemLabel>
                            {workspacesEnabled()
                              ? language.t("sidebar.workspaces.disable")
                              : language.t("sidebar.workspaces.enable")}
                          </DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          data-action="project-clear-notifications"
                          data-project={slug()}
                          disabled={unseenCount() === 0}
                          onSelect={clearNotifications}
                        >
                          <DropdownMenu.ItemLabel>
                            {language.t("sidebar.project.clearNotifications")}
                          </DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                        <DropdownMenu.Separator />
                        <DropdownMenu.Item
                          data-action="project-close-menu"
                          data-project={slug()}
                          onSelect={() => {
                            const dir = worktree()
                            if (!dir) return
                            closeProject(dir)
                          }}
                        >
                          <DropdownMenu.ItemLabel>{language.t("common.close")}</DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu>
                </div>
              </div>

              <div class="flex-1 min-h-0 flex flex-col">
                <Show
                  when={workspacesEnabled()}
                  fallback={
                    <>
                      <div class="shrink-0 py-4">
                        <Button
                          size="large"
                          icon="new-session"
                          class="w-full"
                          onClick={() => {
                            const dir = worktree()
                            if (!dir) return
                            navigateWithSidebarReset(`/${base64Encode(dir)}/session`)
                          }}
                        >
                          {language.t("command.session.new")}
                        </Button>
                      </div>
                      <div class="flex-1 min-h-0">
                        <LocalWorkspace
                          ctx={workspaceSidebarCtx}
                          project={project}
                          sortNow={sortNow}
                          mobile={panelProps.mobile}
                        />
                      </div>
                    </>
                  }
                >
                  <>
                    <div class="shrink-0 py-4">
                      <Button
                        size="large"
                        icon="plus-small"
                        class="w-full"
                        onClick={() => {
                          void createWorkspace(project)
                        }}
                      >
                        {language.t("workspace.new")}
                      </Button>
                    </div>
                    <div class="relative flex-1 min-h-0">
                      <DragDropProvider
                        onDragStart={handleWorkspaceDragStart}
                        onDragEnd={handleWorkspaceDragEnd}
                        onDragOver={handleWorkspaceDragOver}
                        collisionDetector={closestCenter}
                      >
                        <DragDropSensors />
                        <ConstrainDragXAxis />
                        <div
                          ref={(el) => {
                            if (!panelProps.mobile) scrollContainerRef = el
                          }}
                          class="size-full flex flex-col py-2 gap-4 overflow-y-auto no-scrollbar [overflow-anchor:none]"
                        >
                          <SortableProvider ids={workspaces()}>
                            <For each={workspaces()}>
                              {(directory) => (
                                <SortableWorkspace
                                  ctx={workspaceSidebarCtx}
                                  directory={directory}
                                  project={project}
                                  sortNow={sortNow}
                                  mobile={panelProps.mobile}
                                />
                              )}
                            </For>
                          </SortableProvider>
                        </div>
                        <DragOverlay>
                          <WorkspaceDragOverlay
                            sidebarProject={sidebarProject}
                            activeWorkspace={() => store.activeWorkspace}
                            workspaceLabel={workspaceLabel}
                          />
                        </DragOverlay>
                      </DragDropProvider>
                    </div>
                  </>
                </Show>
              </div>
            </>
          )}
        </Show>

        <div
          class="shrink-0 px-3 py-3"
          classList={{
            hidden: store.gettingStartedDismissed || !(providers.all().size > 0 && providers.paid().length === 0),
          }}
        >
          <div class="rounded-xl bg-background-base shadow-xs-border-base" data-component="getting-started">
            <div class="p-3 flex flex-col gap-6">
              <div class="flex flex-col gap-2">
                <div class="text-14-medium text-text-strong">{language.t("sidebar.gettingStarted.title")}</div>
                <div class="text-14-regular text-text-base" style={{ "line-height": "var(--line-height-normal)" }}>
                  {language.t("sidebar.gettingStarted.line1")}
                </div>
                <div class="text-14-regular text-text-base" style={{ "line-height": "var(--line-height-normal)" }}>
                  {language.t("sidebar.gettingStarted.line2")}
                </div>
              </div>
              <div data-component="getting-started-actions">
                <Button size="large" icon="plus-small" onClick={connectProvider}>
                  {language.t("command.provider.connect")}
                </Button>
                <Button size="large" variant="ghost" onClick={() => setStore("gettingStartedDismissed", true)}>
                  {language.t("toast.update.action.notYet")}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const projects = () => layout.projects.list()
  makeEventListener(document, "visibilitychange", () => {
    if (document.visibilityState !== "visible") return
    // Restoring a window must not cold-boot every saved project. Keep active
    // work and pending questions fresh without starting unrelated services.
    const directories = resumedProjectDirectories({
      current: currentDir(),
      projects: projects().map((project) => project.worktree),
      questions: Object.values(state.questionPopups).map((item) => item.directory),
      loaded: (directory) => serverSync().existing(directory)?.[0].status === "complete",
    })
    void Promise.allSettled(directories.map((directory) => serverSync().refresh(directory)))
  })
  const isQuestionPopupPending = (directory: string, request: SurfaceBlockingRequest) => {
    const [dirStore] = serverSync().child(directory, { bootstrap: false })
    const requests = dirStore.question[request.sessionID]
    if (requests) return requests.some((item) => item.id === request.id)
    if (dirStore.status !== "loading" && dirStore.session.some((session) => session.id === request.sessionID))
      return false
    return dirStore.status !== "complete"
  }
  const questionPopupRequests = createMemo(() => {
    const items = new Map<string, QuestionPopupRequest>()
    const candidates = [currentDir(), ...Object.values(state.questionPopups).map((item) => item.directory)].filter(
      (directory): directory is string => !!directory,
    )
    const directories = candidates.filter(
      (directory, index) => candidates.findIndex((item) => directoryKey(item) === directoryKey(directory)) === index,
    )

    for (const directory of directories) {
      const [dirStore] = serverSync().child(directory, { bootstrap: false })
      Object.values(dirStore.question).forEach((requests) => {
        requests?.forEach((request) => {
          if (request.mode !== "blocking") return
          if (isImplementationCompleteFollowupQuestion(request)) return
          const key = questionPopupKey(directory, request)
          if (shouldShowQuestionPopup({ pending: true, dismissed: !!state.dismissedQuestionPopups[key], minimized: !!state.minimizedQuestionPopups[key] }))
            items.set(key, { directory, request })
        })
      })
    }

    Object.values(state.questionPopups).forEach((item) => {
      if (isImplementationCompleteFollowupQuestion(item.request)) return
      const key = questionPopupKey(item.directory, item.request)
      if (shouldShowQuestionPopup({ pending: isQuestionPopupPending(item.directory, item.request), dismissed: !!state.dismissedQuestionPopups[key], minimized: !!state.minimizedQuestionPopups[key] }))
        items.set(key, item)
    })

    return Array.from(items.values()).sort((a, b) =>
      questionPopupKey(a.directory, a.request).localeCompare(questionPopupKey(b.directory, b.request)),
    )
  })
  let questionPopupSessionRoute: string | undefined | null = null
  let questionPopupRouteRun = 0
  createEffect(() => {
    const directory = currentDir()
    const sessionID = params.id
    const routeKey = directory && sessionID ? `${directoryKey(directory)}:${sessionID}` : undefined
    if (routeKey === questionPopupSessionRoute) return

    questionPopupSessionRoute = routeKey
    const run = ++questionPopupRouteRun
    if (!routeKey || !sessionID) return

    // An inactive session tab can miss a Surface event, so activation reconciles its authoritative pending list.
    const [dirStore, setDirStore] = serverSync().child(directory, { bootstrap: false })
    const revision = questionRevision(dirStore)
    void retry(() => loadPendingQuestions(serverSDK().createClient({ directory, throwOnError: true }), directory))
      .then((snapshot) => {
        if (run !== questionPopupRouteRun || routeKey !== questionPopupSessionRoute) return
        const requests = snapshot.pending.filter(
          (item): item is SurfaceBlockingRequest =>
            item.mode === "blocking" && sessionInTree(dirStore.session, sessionID, item.sessionID),
        )
        const pending = new Set(requests.map((request) => `${request.sessionID}:${request.id}`))
        batch(() => {
          Object.entries(dirStore.question).forEach(([candidateSessionID, current]) => {
            if (!current || !sessionInTree(dirStore.session, sessionID, candidateSessionID)) return
            const next = current.filter((request) => {
              if (request.mode !== "blocking") return true
              if (pending.has(`${request.sessionID}:${request.id}`)) return true
              if (questionChangedAfter(dirStore, request.id, revision)) return true
              markQuestionChanged(dirStore, request.id)
              return false
            })
            if (next.length === current.length) return
            setDirStore("question", candidateSessionID, reconcile(next, { key: "id" }))
          })
          requests.forEach((request) => {
            if (questionChangedAfter(dirStore, request.id, revision)) return
            markQuestionChanged(dirStore, request.id)
            setDirStore(
              "question",
              request.sessionID,
              reconcile(
                [...(dirStore.question[request.sessionID] ?? []).filter((item) => item.id !== request.id), request].sort(
                  (a, b) => a.id.localeCompare(b.id),
                ),
                { key: "id" },
              ),
            )
          })
        })
      })
      .catch(() => undefined)
  })
  const handoffPopupCandidates = createMemo(() => {
    const candidates = [
      currentDir(),
      ...projects().map((project) => project.worktree),
      ...Object.values(state.handoffPopups).map((item) => item.directory),
    ].filter((directory): directory is string => !!directory)
    return candidates.filter(
      (directory, index) => candidates.findIndex((item) => directoryKey(item) === directoryKey(directory)) === index,
    )
  })
  const authoritativeHandoffRequests = (directory: string, sessionID: string) => {
    const [dirStore] = serverSync().child(directory, { bootstrap: false })
    return dirStore.status === "complete" ? (dirStore.question[sessionID] ?? []) : undefined
  }
  const handoffPopupRequests = createMemo(() => {
    const items = new Map<string, AgentHandoffPopupRequest>()
    for (const directory of handoffPopupCandidates()) {
      const [dirStore] = serverSync().child(directory, { bootstrap: false })
      Object.values(dirStore.question).forEach((requests) => {
        requests?.forEach((request) => {
          if (request.mode !== "interactive" || !pendingHandoffStep(request)) return
          const key = handoffPopupKey(directory, request)
          const dismissed = layout.handoffRequests.isDismissed({
            directory,
            sessionID: request.sessionID,
            requestID: request.id,
          })
          if (
            shouldShowHandoffPopup({
              ready: layoutReady(),
              pending: true,
              dismissed: !!state.dismissedHandoffPopups[key] || dismissed,
              minimized: !!state.minimizedHandoffPopups[key],
            })
          )
            items.set(key, { directory, request: request as SurfaceControlRequest })
        })
      })
    }

    Object.values(state.handoffPopups).forEach((item) => {
      const key = handoffPopupKey(item.directory, item.request)
      const dismissed = layout.handoffRequests.isDismissed({
        directory: item.directory,
        sessionID: item.request.sessionID,
        requestID: item.request.id,
      })
      if (
        !shouldShowHandoffPopup({
          ready: layoutReady(),
          pending: !!pendingHandoffStep(item.request),
          dismissed: !!state.dismissedHandoffPopups[key] || dismissed,
          minimized: !!state.minimizedHandoffPopups[key],
        })
      ) return
      const decision = handoffCacheDecision({
        cachedRequest: item.request,
        authoritativeRequests: authoritativeHandoffRequests(item.directory, item.request.sessionID),
      })
      if (decision !== "keep-cache") return
      items.set(key, item)
    })

    return Array.from(items.values()).sort((a, b) =>
      handoffPopupKey(a.directory, a.request).localeCompare(handoffPopupKey(b.directory, b.request)),
    )
  })
  const activeHandoffPopup = createMemo((): ActiveAgentHandoffPopup | undefined => {
    for (const item of handoffPopupRequests()) {
      const [dirStore] = serverSync().child(item.directory, { bootstrap: false })
      const session = dirStore.session.find((candidate) => candidate.id === item.request.sessionID)
      const currentSession = params.id
      const currentDirectoryStore = serverSync().existing(currentDir())?.[0]
      if (
        handoffCoveredByCurrentSession({
          routeDirectory: currentDir(),
          requestDirectory: item.directory,
          currentSessionID: currentSession,
          requestSessionID: item.request.sessionID,
          routeSessions: currentDirectoryStore?.session ?? [],
          requestSessions: dirStore.session,
        })
      )
        continue
      if (
        handoffCoveredByDock({
          directory: item.directory,
          request: item.request,
          visibleRequestKeys: layout.controlPanels.visibleHandoffRequestKeys(),
        })
      )
        continue

      const sessionTitle = session?.title ?? language.t("command.session.new")
      const projectName = getFilename(item.directory)
      const step = pendingHandoffStep(item.request)
      return {
        ...item,
        sessionTitle,
        projectName,
        description: step
          ? language.t("notification.handoff.description", {
              sessionTitle,
              projectName,
              agent: step.step.agent,
            })
          : language.t("notification.question.description", { sessionTitle, projectName }),
        href: `/${base64Encode(item.directory)}/session/${item.request.sessionID}`,
      }
    }
  })
  createEffect(() => {
    const popup = activeHandoffPopup()
    if (!popup) return
    const key = handoffPopupKey(popup.directory, popup.request)
    setState("handoffPopups", key, { directory: popup.directory, request: popup.request })
  })
  createEffect(() => {
    for (const item of Object.values(state.handoffPopups)) {
      const stale = !pendingHandoffStep(item.request) ||
        handoffCacheDecision({
          cachedRequest: item.request,
          authoritativeRequests: authoritativeHandoffRequests(item.directory, item.request.sessionID),
        }) === "drop"
      if (stale) removeHandoffPopup(item.directory, item.request.sessionID, item.request.id)
    }
  })
  const activeQuestionPopup = createMemo((): ActiveQuestionPopup | undefined => {
    for (const item of questionPopupRequests()) {
      const [dirStore] = serverSync().child(item.directory, { bootstrap: false })
      const session = dirStore.session.find((candidate) => candidate.id === item.request.sessionID)
      const currentSession = params.id
      const detached = isDetachedSurfaceRequest(item.request)
      if (
        directoryKey(item.directory) === directoryKey(currentDir()) &&
        sessionInTree(dirStore.session, currentSession, item.request.sessionID) &&
        !detached
      )
        continue

      const sessionTitle = session?.title ?? language.t("command.session.new")
      const projectName = getFilename(item.directory)
      return {
        ...item,
        sessionTitle,
        projectName,
        description: detached
          ? `Detached action in ${sessionTitle}`
          : language.t("notification.question.description", { sessionTitle, projectName }),
        href: `/${base64Encode(item.directory)}/session/${item.request.sessionID}`,
        detached,
      }
    }
  })
  createEffect(() => {
    const popup = activeQuestionPopup()
    if (!popup) return
    const key = questionPopupKey(popup.directory, popup.request)
    setState("questionPopups", key, { directory: popup.directory, request: popup.request })
  })
  const projectOverlay = () => <ProjectDragOverlay projects={projects} activeProject={() => store.activeProject} />
  const sidebarContent = (mobile?: boolean) => (
    <SidebarContent
      mobile={mobile}
      opened={() => layout.sidebar.opened()}
      aimMove={aim.move}
      projects={projects}
      renderProject={(project) => (
        <SortableProject ctx={projectSidebarCtx} project={project()} sortNow={sortNow} mobile={mobile} />
      )}
      handleDragStart={handleDragStart}
      handleDragEnd={handleDragEnd}
      handleDragOver={handleDragOver}
      openProjectLabel={language.t("command.project.open")}
      openProjectKeybind={() => command.keybind("project.open")}
      onOpenProject={chooseProject}
      renderProjectOverlay={projectOverlay}
      settingsLabel={() => language.t("sidebar.settings")}
      settingsKeybind={() => command.keybind("settings.open")}
      onOpenSettings={openSettings}
      docsLabel={() => language.t("sidebar.docs")}
      onOpenDocs={() => platform.openLink("https://opencode.ai/docs")}
      helpLabel={() => language.t("sidebar.help")}
      onOpenHelp={() => platform.openLink("https://opencode.ai/desktop-feedback")}
      renderPanel={() =>
        mobile ? <SidebarPanel project={currentProject} mobile /> : <SidebarPanel project={currentProject} merged />
      }
    />
  )

  return (
    <div class="relative bg-v2-background-bg-deep flex-1 min-h-0 min-w-0 flex flex-col select-none [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text">
      {autoselecting() ?? ""}
      <Titlebar update={titlebarUpdate} />
      <IconButton
        data-action="mobile-sidebar-toggle"
        icon="menu"
        variant="ghost"
        class="xl:hidden absolute top-1 left-2 z-30 titlebar-icon rounded-md shrink-0"
        aria-label={language.t("sidebar.nav.projectsAndSessions")}
        onClick={() => layout.mobileSidebar.toggle()}
      />
      <div class="xl:hidden">
        <div
          data-component="mobile-sidebar-overlay"
          classList={{
            "fixed inset-x-0 top-10 bottom-0 z-40 bg-black/20 transition-opacity duration-200": true,
            "opacity-100 pointer-events-auto": layout.mobileSidebar.opened(),
            "opacity-0 pointer-events-none": !layout.mobileSidebar.opened(),
          }}
          onClick={() => layout.mobileSidebar.hide()}
        />
        <nav
          aria-label={language.t("sidebar.nav.projectsAndSessions")}
          data-component="sidebar-nav-mobile"
          classList={{
            "@container fixed top-10 bottom-0 left-0 z-50 w-full max-w-[400px] overflow-hidden border-r border-border-weaker-base bg-background-base transition-transform duration-200 ease-out":
              true,
            "translate-x-0": layout.mobileSidebar.opened(),
            "-translate-x-full": !layout.mobileSidebar.opened(),
          }}
          onClick={(event) => {
            event.stopPropagation()
            if (!(event.target instanceof Element)) return
            const href = event.target.closest("a")?.getAttribute("href")
            if (!href?.includes("/session/")) return
            layout.mobileSidebar.hide()
          }}
        >
          {sidebarContent(true)}
        </nav>
      </div>
      <main class="flex-1 min-h-0 min-w-0 overflow-x-hidden flex flex-col items-start contain-strict">
        <Show when={!autoselecting.loading} fallback={<div class="size-full" />}>
          {props.children}
        </Show>
      </main>
      {import.meta.env.DEV && import.meta.env.VITE_DISABLE_DEBUG_BAR !== "1" && <DebugBar />}
      <HelpButton />
      <QuestionPopup
        popup={activeQuestionPopup()}
        goToSession={navigateToHref}
        minimize={minimizeQuestionPopup}
        dismiss={dismissQuestionPopup}
        language={language}
      />
      <HandoffPopup
        popup={activeHandoffPopup()}
        goToSession={navigateToHref}
        minimize={minimizeHandoffPopup}
        dismiss={dismissHandoffPopup}
        complete={completeHandoffPopup}
        planAndGoToSession={(directory, request) => {
          dismissHandoffPopup(directory, request)
          navigateToHref(`/${base64Encode(directory)}/session/${request.sessionID}`)
        }}
        language={language}
      />
      <ToastRegion v2 />
    </div>
  )
}
