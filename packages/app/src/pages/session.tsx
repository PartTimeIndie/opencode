import type { Project, UserMessage } from "@opencode-ai/sdk/v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { createQuery, skipToken, useMutation, useQueryClient } from "@tanstack/solid-query"
import {
  batch,
  onCleanup,
  Show,
  Match,
  Switch,
  createMemo,
  createEffect,
  createComputed,
  on,
  onMount,
  untrack,
} from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createMediaQuery } from "@solid-primitives/media"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { debounce } from "@solid-primitives/scheduled"
import { useLocal } from "@/context/local"
import { selectionFromLines, useFile, type FileSelection, type SelectedLineRange } from "@/context/file"
import { createStore } from "solid-js/store"
import { Select } from "@opencode-ai/ui/select"
import { createAutoScroll } from "@opencode-ai/ui/hooks"
import { previewSelectedLines } from "@opencode-ai/ui/pierre/selection-bridge"
import { Button } from "@opencode-ai/ui/button"
import { Spinner } from "@opencode-ai/ui/spinner"
import { showToast } from "@/utils/toast"
import { focusDockPromptInputForSession, focusWithPromptRestore, focusWithoutStealing } from "@/utils/focus"
import { base64Encode, checksum } from "@opencode-ai/core/util/encode"
import { useLocation, useNavigate, useSearchParams } from "@solidjs/router"
import { NewSessionDesignView, SessionHeader } from "@/components/session"
import { useComments } from "@/context/comments"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePrompt } from "@/context/prompt"
import type { Prompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { useSettings } from "@/context/settings"
import { useSync } from "@/context/sync"
import { useTerminal } from "@/context/terminal"
import { usePermission } from "@/context/permission"
import { type FollowupDraft, sendFollowupDraft } from "@/components/prompt-input/submit"
import { createSessionComposerState, SessionComposerRegion } from "@/pages/session/composer"
import { createOpenReviewFile, createSessionTabs, createSizing, shouldShowFileTree } from "@/pages/session/helpers"
import { MessageTimeline } from "@/pages/session/timeline/message-timeline"
import { createTimelineModel, selectWindowedUserMessages, shouldAutoFillHistory } from "@/pages/session/timeline/model"
import { createRefreshIndicator } from "@/pages/session/timeline/refresh-indicator"
import { type DiffStyle, SessionReviewTab, type SessionReviewTabProps } from "@/pages/session/review-tab"
import { useSessionLayout } from "@/pages/session/session-layout"
import { ServerConnection, useServer } from "@/context/server"
import {
  selectSessionModelSource,
  sessionModelSourceKey,
  syncSessionModel,
} from "@/pages/session/session-model-helpers"
import { useDockContent } from "@/pages/session/dock-content-registry"
import {
  confirmGoalOverride,
  goalMetadataPatch,
  prepareGoalMetadataUpdate,
  readGoalMetadata,
  readGoalStatusMetadata,
  sameGoalMetadata,
  sessionGoalMetadataKey,
  sessionGoalRunMetadataKey,
  shouldWriteGoalPatch,
  type GoalOverride,
} from "@/utils/session-goal-state"
import {
  buildGoalControlRequest,
  goalControlErrorText,
  goalControlResponseStale,
  parseGoalControlResponse,
  type SessionGoalControlAction,
} from "@/utils/session-goal-control"
import { SessionSidePanel } from "@/pages/session/session-side-panel"
import { TerminalPanel } from "@/pages/session/terminal-panel"
import { useSessionCommands } from "@/pages/session/use-session-commands"
import { rollbackTimelineBoundary, rollbackUsersBefore } from "@/pages/session/rollback-state"
import { useSessionHashScroll } from "@/pages/session/use-session-hash-scroll"
import { Identifier } from "@/utils/id"
import { didMessageTailAdvance } from "@/utils/message-order"
import { diffs as list } from "@/utils/diffs"
import { Persist, persisted } from "@/utils/persist"
import { extractPromptFromParts } from "@/utils/prompt"
import { formatServerError } from "@/utils/server-errors"
import { useUsageExceededDialogs } from "./session/usage-exceeded-dialogs"
import { messageIdFromHash } from "./session/message-id-from-hash"
import { promptLength } from "@/components/prompt-input/history"
import { notifySessionTabsRemoved } from "@/components/titlebar-session-events"
import { useTabs } from "@/context/tabs"
import { type FollowupItem } from "./session/followup-queue"
import { followupSendKey } from "./session/followup-drain"
import { claimFollowupSend, followupStore, releaseFollowupSend, type FollowupEdit } from "./session/followup-store"
import { sessionTitle } from "@/utils/session-title"
import { sessionActivitySettled } from "@/utils/session-activity"

const emptyFollowups: FollowupItem[] = []
const branchPromptHandoffPrefix = "opencode.branchPromptHandoff."

type ChangeMode = "git" | "branch" | "turn"
type VcsMode = "git" | "branch"

function branchPromptHandoffKey(id: string) {
  return `${branchPromptHandoffPrefix}${id}`
}

function readBranchPromptHandoff(id: string) {
  try {
    const raw = localStorage.getItem(branchPromptHandoffKey(id))
    localStorage.removeItem(branchPromptHandoffKey(id))
    if (!raw) return
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return
    if (!("prompt" in parsed) || !("cursor" in parsed)) return
    if (!Array.isArray(parsed.prompt) || typeof parsed.cursor !== "number") return
    return { prompt: parsed.prompt as Prompt, cursor: parsed.cursor }
  } catch {
    return
  }
}

export default function Page() {
  const serverSync = useServerSync()
  const layout = useLayout()
  const local = useLocal()
  const file = useFile()
  const sync = useSync()
  const queryClient = useQueryClient()
  const dialog = useDialog()
  const language = useLanguage()
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const settings = useSettings()
  const permission = usePermission()
  const prompt = usePrompt()
  const comments = useComments()
  const terminal = useTerminal()
  const server = useServer()
  const sessionTabs = useTabs()
  const dockContent = useDockContent()
  const [searchParams, setSearchParams] = useSearchParams<{ focus?: string; prompt?: string; promptHandoff?: string }>()
  const location = useLocation()
  const navigate = useNavigate()
  const { params, sessionKey, workspaceKey, tabs, view } = useSessionLayout()
  createEffect(() => {
    if (!prompt.ready()) return
    untrack(() => {
      if (params.id) return
      const text = searchParams.prompt
      if (!text) return
      prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
      setSearchParams({ ...searchParams, prompt: undefined })
    })
  })

  const [ui, setUi] = createStore({
    pendingMessage: undefined as string | undefined,
    reviewSnap: false,
    scrollGesture: 0,
    scroll: {
      overflow: false,
      bottom: true,
      jump: false,
    },
  })

  const composer = createSessionComposerState()

  const workspaceTabs = createMemo(() => layout.tabs(workspaceKey))

  createEffect(
    on(
      () => params.id,
      (id, prev) => {
        if (!id) return
        if (prev) return

        const pending = layout.handoff.tabs()
        if (!pending) return
        if (Date.now() - pending.at > 60_000) {
          layout.handoff.clearTabs()
          return
        }
        if (pending.scope !== server.scope()) return

        if (pending.id !== id) return
        layout.handoff.clearTabs()
        if (pending.dir !== (params.dir ?? "")) return

        const from = workspaceTabs().tabs()
        if (from.all.length === 0 && !from.active) return

        const current = tabs().tabs()
        if (current.all.length > 0 || current.active) return

        const all = normalizeTabs(from.all)
        const active = from.active ? normalizeTab(from.active) : undefined
        tabs().setAll(all)
        tabs().setActive(active && all.includes(active) ? active : all[0])

        workspaceTabs().setAll([])
        workspaceTabs().setActive(undefined)
      },
      { defer: true },
    ),
  )

  const isDesktop = createMediaQuery("(min-width: 768px)")
  const size = createSizing()
  const desktopReviewOpen = createMemo(() => isDesktop() && view().reviewPanel.opened())
  const desktopFileTreeOpen = createMemo(
    () =>
      isDesktop() &&
      shouldShowFileTree({
        visible: settings.visibility.fileTree(),
        opened: layout.fileTree.opened(),
      }),
  )
  const desktopSidePanelOpen = createMemo(() => desktopReviewOpen() || desktopFileTreeOpen())
  const sessionPanelWidth = createMemo(() => {
    if (!desktopSidePanelOpen()) return "100%"
    if (desktopReviewOpen()) return `${layout.session.width()}px`
    return `calc(100% - ${layout.fileTree.width()}px)`
  })
  const centered = createMemo(() => isDesktop() && !desktopReviewOpen())
  const [store, setStore] = createStore({
    messageId: undefined as string | undefined,
    revertBoundary: undefined as string | undefined,
    rollbackDraftSessionID: undefined as string | undefined,
    mobileTab: "session" as "session" | "changes",
    changes: "git" as ChangeMode,
    newSessionWorktree: "main",
    deferRender: false,
    deferTimeline: false,
  })

  function normalizeTab(tab: string) {
    if (!tab.startsWith("file://")) return tab
    return file.tab(tab)
  }

  function normalizeTabs(list: string[]) {
    const seen = new Set<string>()
    const next: string[] = []
    for (const item of list) {
      const value = normalizeTab(item)
      if (seen.has(value)) continue
      seen.add(value)
      next.push(value)
    }
    return next
  }

  const openReviewPanel = () => {
    if (!view().reviewPanel.opened()) view().reviewPanel.open()
  }

  const info = createMemo(() => (params.id ? sync().session.get(params.id) : undefined))
  const sessionShellReady = createMemo(() => !params.id || !!info())
  const isChildSession = createMemo(() => !!info()?.parentID)
  const diffs = createMemo(() => (params.id ? list(sync().data.session_diff[params.id]) : []))
  const canReview = createMemo(() => !!sync().project)
  const reviewTab = createMemo(() => isDesktop())
  const tabState = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab,
    review: reviewTab,
    hasReview: canReview,
  })
  const activeTab = tabState.activeTab
  const activeFileTab = tabState.activeFileTab
  const revertMessageID = createMemo(() => rollbackTimelineBoundary(info()?.revert, store.revertBoundary))
  const timeline = createTimelineModel({
    sessionID: () => params.id,
    revertMessageID,
    active: () => {
      const tab = sessionTabs.active()
      if (!tab) return true
      return (
        tab?.type === "session" &&
        tab.server === ServerConnection.key(serverSDK().server) &&
        tab.dirBase64 === params.dir &&
        tab.sessionId === params.id
      )
    },
    onSessionNotFound: ({ server: owner, directory, error, sessionID }) => {
      notifySessionTabsRemoved({ server: owner, directory, sessionIDs: [sessionID] })
      if (params.id !== sessionID || sdk().directory !== directory) return
      if (ServerConnection.key(serverSDK().server) !== owner) return
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: formatServerError(error, language.t),
      })
      navigate(`/${params.dir}/session`, { replace: true })
    },
  })
  const historyLoading = timeline.history.loading
  const historyMore = timeline.history.more
  const lastUserMessage = timeline.lastUserMessage
  const messages = timeline.messages
  const messagesReady = timeline.ready
  const sessionSync = timeline.resource
  const userMessages = timeline.userMessages
  const visibleUserMessages = timeline.visibleUserMessages
  const showRefreshIndicator = createRefreshIndicator({
    sessionID: () => params.id,
    refreshing: timeline.refreshing,
    ready: timeline.ready,
  })

  const closeUnavailableSessionTab = () => {
    const id = params.id
    if (!id) return
    const index = sessionTabs.store.findIndex(
      (tab) =>
        tab.type === "session" && tab.server === server.key && tab.dirBase64 === params.dir && tab.sessionId === id,
    )
    if (index === -1) return
    sessionTabs.removeTab(index)
  }

  createEffect(() => {
    const tab = activeFileTab()
    if (!tab) return

    const path = file.pathFromTab(tab)
    if (path) void file.load(path)
  })

  // Switching into a session always loads that session active model/agent from
  // its last message, instead of a stale remembered composer selection. Within
  // a session a deliberate model pick is preserved against new messages.
  let forceModelSync = true

  createEffect(
    on(
      () => ({ dir: params.dir, id: params.id }),
      (next, prev) => {
        if (next.id && (!prev || next.id !== prev.id)) forceModelSync = true
        if (!prev) return
        if (next.dir === prev.dir && next.id === prev.id) return
        if (prev.id && !next.id) local.session.reset()
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => {
        const msg = selectSessionModelSource(lastUserMessage(), info())
        if (!msg) return
        return sessionModelSourceKey(msg)
      },
      () => {
        const msg = selectSessionModelSource(lastUserMessage(), info())
        if (!msg) return
        syncSessionModel(local, msg, { force: forceModelSync })
        if (msg.sessionID === params.id && msg.model.providerID && msg.model.modelID) forceModelSync = false
      },
    ),
  )

  const timelineUserMessages = createMemo(() =>
    selectWindowedUserMessages(visibleUserMessages(), {
      limit: 160,
      before: 40,
      targetID: ui.pendingMessage ?? store.messageId ?? messageIdFromHash(location.hash),
    }),
  )

  const [followup, setFollowup] = followupStore({ scope: serverSDK().scope, directory: sdk().directory })
  const heldInputsQuery = createQuery(() => {
    const sessionID = params.id
    return {
      queryKey: ["session-held-inputs", sdk().directory, sessionID, info()?.time.updated] as const,
      enabled: !!sessionID,
      queryFn: sessionID
        ? ({ signal }) =>
            sdk()
              .client.v2.session.heldInputs({ sessionID }, { signal, throwOnError: true })
              .then((result) => result.data.data)
        : skipToken,
    }
  })
  const heldInputIDs = createMemo(() => new Set((heldInputsQuery.data ?? []).map((item) => item.id)))
  const [goals, setGoals] = persisted(
    Persist.serverWorkspace(serverSDK().scope, sdk().directory, "goals", ["goals.v1"]),
    createStore<{
      items: Record<string, string | undefined>
    }>({
      items: {},
    }),
  )
  const [goalOverrides, setGoalOverrides] = createStore<Record<string, GoalOverride | undefined>>({})
  const goalOverrideRevisions = new Map<string, number>()
  const goalOverrideTimers = new Map<string, number>()

  let sessionShellFrame: number | undefined
  let sessionTimelineTimer: number | undefined

  createComputed((prev) => {
    const key = sessionKey()
    if (key !== prev) {
      if (sessionShellFrame !== undefined) cancelAnimationFrame(sessionShellFrame)
      if (sessionTimelineTimer !== undefined) clearTimeout(sessionTimelineTimer)
      batch(() => {
        setStore("deferRender", true)
        setStore("deferTimeline", true)
      })
      sessionShellFrame = requestAnimationFrame(() => {
        sessionShellFrame = undefined
        if (sessionKey() !== key) return
        setStore("deferRender", false)
        // A timeline mount performs virtual-row measurement and style visibility
        // checks. Let the title and composer paint first, and cancel this work when
        // the user moves through tabs faster than the timeline can become useful.
        sessionTimelineTimer = window.setTimeout(() => {
          sessionTimelineTimer = undefined
          if (sessionKey() === key) setStore("deferTimeline", false)
        }, 80)
      })
    }
    return key
  }, sessionKey())

  onCleanup(() => {
    if (sessionShellFrame !== undefined) cancelAnimationFrame(sessionShellFrame)
    if (sessionTimelineTimer !== undefined) clearTimeout(sessionTimelineTimer)
  })

  let reviewFrame: number | undefined
  let todoFrame: number | undefined
  let todoTimer: number | undefined
  let diffFrame: number | undefined
  let diffTimer: number | undefined

  createComputed((prev) => {
    const open = desktopReviewOpen()
    if (prev === undefined || prev === open) return open

    if (reviewFrame !== undefined) cancelAnimationFrame(reviewFrame)
    setUi("reviewSnap", true)
    reviewFrame = requestAnimationFrame(() => {
      reviewFrame = undefined
      setUi("reviewSnap", false)
    })
    return open
  }, desktopReviewOpen())

  const turnDiffs = createMemo(() => list(lastUserMessage()?.summary?.diffs))
  const nogit = createMemo(() => {
    const project = sync().project
    return !!project && project.vcs !== "git"
  })
  const changesOptions = createMemo<ChangeMode[]>(() => {
    const list: ChangeMode[] = []
    const project = sync().project
    const vcs = sync().data.vcs
    if (project?.vcs === "git") list.push("git")
    if (project?.vcs === "git" && vcs?.branch && vcs?.default_branch && vcs.branch !== vcs.default_branch) {
      list.push("branch")
    }
    list.push("turn")
    return list
  })
  const mobileChanges = createMemo(() => !isDesktop() && store.mobileTab === "changes")
  const wantsReview = createMemo(() =>
    isDesktop()
      ? desktopFileTreeOpen() || (desktopReviewOpen() && activeTab() === "review")
      : store.mobileTab === "changes",
  )
  const vcsMode = createMemo<VcsMode | undefined>(() => {
    if (store.changes === "git" || store.changes === "branch") return store.changes
  })
  const vcsKey = createMemo(
    () =>
      ["session-vcs", sdk().directory, sync().data.vcs?.branch ?? "", sync().data.vcs?.default_branch ?? ""] as const,
  )
  const vcsQuery = createQuery(() => {
    const mode = vcsMode()
    const enabled = wantsReview() && sync().project?.vcs === "git"

    return {
      queryKey: [...vcsKey(), mode] as const,
      enabled,
      queryFn: mode
        ? ({ signal }) =>
            sdk()
              .client.vcs.diff({ mode }, { signal, throwOnError: true })
              .then((result) => list(result.data))
              .catch((error) => {
                if (signal.aborted) throw error
                console.debug("[session-review] failed to load vcs diff", { mode, error })
                return []
              })
        : skipToken,
    }
  })
  const refreshVcs = debounce(() => void queryClient.invalidateQueries({ queryKey: vcsKey() }), 100)
  const reviewDiffs = () => {
    if (store.changes === "git" || store.changes === "branch")
      // avoids suspense
      return vcsQuery.isFetched ? (vcsQuery.data ?? []) : []
    return turnDiffs()
  }
  const reviewCount = () => reviewDiffs().length
  const hasReview = () => reviewCount() > 0
  const reviewReady = () => {
    if (store.changes === "git" || store.changes === "branch") return !vcsQuery.isPending
    return true
  }

  const newSessionWorktree = createMemo(() => {
    if (store.newSessionWorktree === "create") return "create"
    const project = sync().project
    if (project && sdk().directory !== project.worktree) return sdk().directory
    return "main"
  })

  const setActiveMessage = (message: UserMessage | undefined) => {
    messageMark = scrollMark
    setStore("messageId", message?.id)
  }

  const anchor = (id: string) => `message-${id}`

  const cursor = () => {
    const root = scroller
    if (!root) return store.messageId

    const box = root.getBoundingClientRect()
    const line = box.top + 100
    const list = [...root.querySelectorAll<HTMLElement>("[data-message-id]")]
      .map((el) => {
        const id = el.dataset.messageId
        if (!id) return

        const rect = el.getBoundingClientRect()
        return { id, top: rect.top, bottom: rect.bottom }
      })
      .filter((item): item is { id: string; top: number; bottom: number } => !!item)

    const shown = list.filter((item) => item.bottom > box.top && item.top < box.bottom)
    const hit = shown.find((item) => item.top <= line && item.bottom >= line)
    if (hit) return hit.id

    const near = [...shown].sort((a, b) => {
      const da = Math.abs(a.top - line)
      const db = Math.abs(b.top - line)
      if (da !== db) return da - db
      return a.top - b.top
    })[0]
    if (near) return near.id

    return list.filter((item) => item.top <= line).at(-1)?.id ?? list[0]?.id ?? store.messageId
  }

  function navigateMessageByOffset(offset: number) {
    const msgs = visibleUserMessages()
    if (msgs.length === 0) return

    const current = store.messageId && messageMark === scrollMark ? store.messageId : cursor()
    const base = current ? msgs.findIndex((m) => m.id === current) : msgs.length
    const currentIndex = base === -1 ? msgs.length : base
    const targetIndex = currentIndex + offset
    if (targetIndex < 0 || targetIndex > msgs.length) return

    if (targetIndex === msgs.length) {
      resumeScroll()
      return
    }

    autoScroll.pause()
    scrollToMessage(msgs[targetIndex], "auto")
  }

  function upsert(next: Project) {
    const list = serverSync().data.project
    sync().set("project", next.id)
    const idx = list.findIndex((item) => item.id === next.id)
    if (idx >= 0) {
      serverSync().set(
        "project",
        list.map((item, i) => (i === idx ? { ...item, ...next } : item)),
      )
      return
    }
    const at = list.findIndex((item) => item.id > next.id)
    if (at >= 0) {
      serverSync().set("project", [...list.slice(0, at), next, ...list.slice(at)])
      return
    }
    serverSync().set("project", [...list, next])
  }

  const gitMutation = useMutation(() => ({
    mutationFn: () => sdk().client.project.initGit(),
    onSuccess: (x) => {
      if (!x.data) return
      upsert(x.data)
    },
    onError: (err) => {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: formatServerError(err, language.t),
      })
    },
  }))

  function initGit() {
    if (gitMutation.isPending) return
    gitMutation.mutate()
  }

  let inputRef!: HTMLDivElement
  let promptDock: HTMLDivElement | undefined
  let dockHeight = 0
  let scroller: HTMLDivElement | undefined
  let content: HTMLDivElement | undefined
  let revealMessage = (_id: string) => {}
  let scrollToEnd = () => {}
  let scrollMark = 0
  let messageMark = 0

  const scrollGestureWindowMs = 250

  const markScrollGesture = (target?: EventTarget | null) => {
    const root = scroller
    if (!root) return

    const el = target instanceof Element ? target : undefined
    const nested = el?.closest("[data-scrollable]")
    if (nested && nested !== root) return

    setUi("scrollGesture", Date.now())
  }

  const hasScrollGesture = () => Date.now() - ui.scrollGesture < scrollGestureWindowMs

  createEffect(
    on(
      () => {
        const id = params.id
        return [
          sdk().directory,
          id,
          id ? (sync().data.session_status[id]?.type ?? "idle") : "idle",
          id ? composer.blocked() : false,
        ] as const
      },
      ([dir, id, status, blocked]) => {
        if (todoFrame !== undefined) cancelAnimationFrame(todoFrame)
        if (todoTimer !== undefined) window.clearTimeout(todoTimer)
        todoFrame = undefined
        todoTimer = undefined
        if (!id) return
        if (status === "idle" && !blocked) return
        const cached = untrack(() => sync().data.todo[id] ?? serverSync().todo.get(dir, id))

        todoFrame = requestAnimationFrame(() => {
          todoFrame = undefined
          todoTimer = window.setTimeout(
            () => {
              todoTimer = undefined
              if (sdk().directory !== dir || params.id !== id) return
              untrack(() => {
                if (cached?.length === 0) return
                void sync().session.todo(id, cached ? { force: true } : undefined)
              })
            },
            cached === undefined ? 1000 : 0,
          )
        })
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => visibleUserMessages().at(-1),
      (last, previous) => {
        if (didMessageTailAdvance(previous, last)) {
          setStore("messageId", undefined)
        }
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      sessionKey,
      () => {
        setStore("messageId", undefined)
        setStore("revertBoundary", undefined)
        setStore("changes", "git")
        setUi("pendingMessage", undefined)
      },
      { defer: true },
    ),
  )

  const stopVcs = sdk().event.listen((evt) => {
    if (evt.details.type !== "file.watcher.updated") return
    const props =
      typeof evt.details.properties === "object" && evt.details.properties
        ? (evt.details.properties as Record<string, unknown>)
        : undefined
    const file = typeof props?.file === "string" ? props.file : undefined
    if (!file || file.startsWith(".git/")) return
    refreshVcs()
  })
  onCleanup(stopVcs)

  createEffect(
    on(
      () => params.dir,
      (dir) => {
        if (!dir) return
        setStore("newSessionWorktree", "main")
      },
      { defer: true },
    ),
  )

  const selectionPreview = (path: string, selection: FileSelection) => {
    const content = file.get(path)?.content?.content
    if (!content) return undefined
    return previewSelectedLines(content, { start: selection.startLine, end: selection.endLine })
  }

  const addCommentToContext = (input: {
    file: string
    selection: SelectedLineRange
    comment: string
    preview?: string
    origin?: "review" | "file"
  }) => {
    const selection = selectionFromLines(input.selection)
    const preview = input.preview ?? selectionPreview(input.file, selection)
    const saved = comments.add({
      file: input.file,
      selection: input.selection,
      comment: input.comment,
    })
    prompt.context.add({
      type: "file",
      path: input.file,
      selection,
      comment: input.comment,
      commentID: saved.id,
      commentOrigin: input.origin,
      preview,
    })
  }

  const updateCommentInContext = (input: {
    id: string
    file: string
    selection: SelectedLineRange
    comment: string
    preview?: string
  }) => {
    comments.update(input.file, input.id, input.comment)
    prompt.context.updateComment(input.file, input.id, {
      comment: input.comment,
      ...(input.preview ? { preview: input.preview } : {}),
    })
  }

  const removeCommentFromContext = (input: { id: string; file: string }) => {
    comments.remove(input.file, input.id)
    prompt.context.removeComment(input.file, input.id)
  }

  const reviewCommentActions = createMemo(() => ({
    moreLabel: language.t("common.moreOptions"),
    editLabel: language.t("common.edit"),
    deleteLabel: language.t("common.delete"),
    saveLabel: language.t("common.save"),
  }))

  const isEditableTarget = (target: EventTarget | null | undefined) => {
    if (!(target instanceof HTMLElement)) return false
    return /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName) || target.isContentEditable
  }

  const deepActiveElement = () => {
    let current: Element | null = document.activeElement
    while (current instanceof HTMLElement && current.shadowRoot?.activeElement) {
      current = current.shadowRoot.activeElement
    }
    return current instanceof HTMLElement ? current : undefined
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    const path = event.composedPath()
    const target = path.find((item): item is HTMLElement => item instanceof HTMLElement)
    const activeElement = deepActiveElement()

    const protectedTarget = path.some(
      (item) => item instanceof HTMLElement && item.closest("[data-prevent-autofocus]") !== null,
    )
    if (protectedTarget || isEditableTarget(target)) return

    if (activeElement) {
      const isProtected = activeElement.closest("[data-prevent-autofocus]")
      const isInput = isEditableTarget(activeElement)
      if (isProtected || isInput) return
    }
    if (dialog.active) return

    if (activeElement === inputRef) {
      if (event.key === "Escape") inputRef?.blur()
      return
    }

    // Only treat explicit scroll keys as potential "user scroll" gestures.
    if (event.key === "PageUp" || event.key === "PageDown" || event.key === "Home" || event.key === "End") {
      markScrollGesture()
      return
    }

    if (event.key.length === 1 && event.key !== "Unidentified" && !(event.ctrlKey || event.metaKey)) {
      if (composer.blocked() || isChildSession()) return
      focusWithoutStealing(inputRef)
    }
  }

  createEffect(() => {
    const list = changesOptions()
    if (list.includes(store.changes)) return
    const next = list[0]
    if (!next) return
    setStore("changes", next)
  })

  createEffect(
    on(
      () => sync().data.session_status[params.id ?? ""]?.type,
      (next, prev) => {
        if (next !== "idle" || prev === undefined || prev === "idle") return
        refreshVcs()
      },
      { defer: true },
    ),
  )

  const fileTreeTab = () => layout.fileTree.tab()
  const setFileTreeTab = (value: "changes" | "all") => layout.fileTree.setTab(value)

  const [tree, setTree] = createStore({
    reviewScroll: undefined as HTMLDivElement | undefined,
    pendingDiff: undefined as string | undefined,
    activeDiff: undefined as string | undefined,
  })

  createEffect(
    on(
      sessionKey,
      () => {
        setTree({
          reviewScroll: undefined,
          pendingDiff: undefined,
          activeDiff: undefined,
        })
      },
      { defer: true },
    ),
  )

  const showAllFiles = () => {
    if (fileTreeTab() !== "changes") return
    setFileTreeTab("all")
  }

  const focusInput = (options?: { force?: boolean }) => {
    if (isChildSession() || !inputRef) return false
    if (options?.force) {
      return focusWithPromptRestore(inputRef)
    }
    return focusWithoutStealing(inputRef)
  }

  createEffect(() => {
    if (!params.id) return
    if (!prompt.ready()) return
    const promptHandoff = searchParams.promptHandoff
    if (searchParams.focus !== "prompt" && !promptHandoff) return

    const restored = promptHandoff ? readBranchPromptHandoff(promptHandoff) : undefined
    if (restored) prompt.set(restored.prompt, restored.cursor)
    setSearchParams({ focus: undefined, promptHandoff: undefined }, { replace: true })
    requestAnimationFrame(() => focusInput())
  })

  useSessionCommands({
    navigateMessageByOffset,
    setActiveMessage,
    focusInput,
    onRollbackDraftRestored: (sessionID) => setStore("rollbackDraftSessionID", sessionID),
    review: reviewTab,
  })

  const openReviewFile = createOpenReviewFile({
    showAllFiles,
    tabForPath: file.tab,
    openTab: tabs().open,
    setActive: tabs().setActive,
    loadFile: file.load,
  })

  const changesTitle = () => {
    if (!canReview()) {
      return null
    }

    const label = (option: ChangeMode) => {
      if (option === "git") return language.t("ui.sessionReview.title.git")
      if (option === "branch") return language.t("ui.sessionReview.title.branch")
      return language.t("ui.sessionReview.title.lastTurn")
    }

    return (
      <Select
        options={changesOptions()}
        current={store.changes}
        label={label}
        onSelect={(option) => option && setStore("changes", option)}
        variant="ghost"
        size="small"
        valueClass="text-14-medium"
      />
    )
  }

  const empty = (text: string) => (
    <div class="h-full pb-64 -mt-4 flex flex-col items-center justify-center text-center gap-6">
      <div class="text-14-regular text-text-weak max-w-56">{text}</div>
    </div>
  )

  const createGit = (input: { emptyClass: string }) => (
    <div class={input.emptyClass}>
      <div class="flex flex-col gap-3">
        <div class="text-14-medium text-text-strong">{language.t("session.review.noVcs.createGit.title")}</div>
        <div class="text-14-regular text-text-base max-w-md" style={{ "line-height": "var(--line-height-normal)" }}>
          {language.t("session.review.noVcs.createGit.description")}
        </div>
      </div>
      <Button size="large" disabled={gitMutation.isPending} onClick={initGit}>
        {gitMutation.isPending
          ? language.t("session.review.noVcs.createGit.actionLoading")
          : language.t("session.review.noVcs.createGit.action")}
      </Button>
    </div>
  )

  const reviewEmptyText = createMemo(() => {
    if (store.changes === "git") return language.t("session.review.noUncommittedChanges")
    if (store.changes === "branch") return language.t("session.review.noBranchChanges")
    return language.t("session.review.noChanges")
  })

  const reviewEmpty = (input: { loadingClass: string; emptyClass: string }) => {
    if (store.changes === "git" || store.changes === "branch") {
      if (!reviewReady()) return <div class={input.loadingClass}>{language.t("session.review.loadingChanges")}</div>
      return empty(reviewEmptyText())
    }

    if (store.changes === "turn") {
      if (nogit()) return createGit(input)
      return empty(reviewEmptyText())
    }

    return (
      <div class={input.emptyClass}>
        <div class="text-14-regular text-text-weak max-w-56">{reviewEmptyText()}</div>
      </div>
    )
  }

  const reviewContent = (input: {
    diffStyle: DiffStyle
    onDiffStyleChange?: (style: DiffStyle) => void
    classes?: SessionReviewTabProps["classes"]
    loadingClass: string
    emptyClass: string
  }) => (
    <Show when={!store.deferRender}>
      <SessionReviewTab
        title={changesTitle()}
        empty={reviewEmpty(input)}
        diffs={reviewDiffs}
        view={view}
        diffStyle={input.diffStyle}
        onDiffStyleChange={input.onDiffStyleChange}
        onScrollRef={(el) => setTree("reviewScroll", el)}
        focusedFile={tree.activeDiff}
        onLineComment={(comment) => addCommentToContext({ ...comment, origin: "review" })}
        onLineCommentUpdate={updateCommentInContext}
        onLineCommentDelete={removeCommentFromContext}
        lineCommentActions={reviewCommentActions()}
        commentMentions={{
          items: file.searchFilesAndDirectories,
        }}
        comments={comments.all()}
        focusedComment={comments.focus()}
        onFocusedCommentChange={comments.setFocus}
        onViewFile={openReviewFile}
        classes={input.classes}
      />
    </Show>
  )

  const reviewPanel = () => (
    <div class="flex flex-col h-full overflow-hidden bg-background-stronger contain-strict">
      <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
        {reviewContent({
          diffStyle: layout.review.diffStyle(),
          onDiffStyleChange: layout.review.setDiffStyle,
          loadingClass: "px-6 py-4 text-text-weak",
          emptyClass: "h-full pb-64 -mt-4 flex flex-col items-center justify-center text-center gap-6",
        })}
      </div>
    </div>
  )

  createEffect(
    on(
      activeFileTab,
      (active) => {
        if (!active) return
        if (fileTreeTab() !== "changes") return
        showAllFiles()
      },
      { defer: true },
    ),
  )

  const reviewDiffId = (path: string) => {
    const sum = checksum(path)
    if (!sum) return
    return `session-review-diff-${sum}`
  }

  const reviewDiffTop = (path: string) => {
    const root = tree.reviewScroll
    if (!root) return

    const id = reviewDiffId(path)
    if (!id) return

    const el = document.getElementById(id)
    if (!(el instanceof HTMLElement)) return
    if (!root.contains(el)) return

    const a = el.getBoundingClientRect()
    const b = root.getBoundingClientRect()
    return a.top - b.top + root.scrollTop
  }

  const scrollToReviewDiff = (path: string) => {
    const root = tree.reviewScroll
    if (!root) return false

    const top = reviewDiffTop(path)
    if (top === undefined) return false

    view().setScroll("review", { x: root.scrollLeft, y: top })
    root.scrollTo({ top, behavior: "auto" })
    return true
  }

  const focusReviewDiff = (path: string) => {
    openReviewPanel()
    view().review.openPath(path)
    setTree({ activeDiff: path, pendingDiff: path })
  }

  createEffect(() => {
    const pending = tree.pendingDiff
    if (!pending) return
    if (!tree.reviewScroll) return
    if (!reviewReady()) return

    const attempt = (count: number) => {
      if (tree.pendingDiff !== pending) return
      if (count > 60) {
        setTree("pendingDiff", undefined)
        return
      }

      const root = tree.reviewScroll
      if (!root) {
        requestAnimationFrame(() => attempt(count + 1))
        return
      }

      if (!scrollToReviewDiff(pending)) {
        requestAnimationFrame(() => attempt(count + 1))
        return
      }

      const top = reviewDiffTop(pending)
      if (top === undefined) {
        requestAnimationFrame(() => attempt(count + 1))
        return
      }

      if (Math.abs(root.scrollTop - top) <= 1) {
        setTree("pendingDiff", undefined)
        return
      }

      requestAnimationFrame(() => attempt(count + 1))
    }

    requestAnimationFrame(() => attempt(0))
  })

  createEffect(() => {
    const id = params.id
    if (!id) return

    if (!wantsReview()) return
    if (sync().data.session_diff[id] !== undefined) return
    if (sync().status === "loading") return

    void sync().session.diff(id)
  })

  createEffect(
    on(
      () => [sessionKey(), wantsReview()] as const,
      ([key, wants]) => {
        if (diffFrame !== undefined) cancelAnimationFrame(diffFrame)
        if (diffTimer !== undefined) window.clearTimeout(diffTimer)
        diffFrame = undefined
        diffTimer = undefined
        if (!wants) return

        const id = params.id
        if (!id) return
        if (!untrack(() => sync().data.session_diff[id] !== undefined)) return

        diffFrame = requestAnimationFrame(() => {
          diffFrame = undefined
          diffTimer = window.setTimeout(() => {
            diffTimer = undefined
            if (sessionKey() !== key) return
            void sync().session.diff(id, { force: true })
          }, 0)
        })
      },
      { defer: true },
    ),
  )

  let treeDir: string | undefined
  createEffect(() => {
    const dir = sdk().directory
    if (!isDesktop()) return
    if (!layout.fileTree.opened()) return
    if (sync().status === "loading") return

    fileTreeTab()
    const refresh = treeDir !== dir
    treeDir = dir
    void (refresh ? file.tree.refresh("") : file.tree.list(""))
  })

  createEffect(
    on(
      () => sdk().directory,
      () => {
        const tab = activeFileTab()
        if (!tab) return
        const path = file.pathFromTab(tab)
        if (!path) return
        void file.load(path, { force: true })
      },
      { defer: true },
    ),
  )

  const autoScroll = createAutoScroll({
    working: () => true,
    overflowAnchor: "none",
  })
  createEffect(
    on(
      () => params.id,
      (id, previous) => {
        if (!id || !previous || id === previous) return
        if (location.hash || store.messageId || ui.pendingMessage) return
        autoScroll.resume()
      },
    ),
  )

  let scrollStateFrame: number | undefined
  let scrollStateTarget: HTMLDivElement | undefined
  let fillFrame: number | undefined

  const jumpThreshold = (el: HTMLDivElement) => Math.max(400, el.clientHeight)

  const updateScrollState = (el: HTMLDivElement) => {
    const max = el.scrollHeight - el.clientHeight
    const distance = max - el.scrollTop
    const overflow = max > 1
    const bottom = !overflow || distance <= 2
    const jump = overflow && distance > jumpThreshold(el)

    if (ui.scroll.overflow === overflow && ui.scroll.bottom === bottom && ui.scroll.jump === jump) return
    setUi("scroll", { overflow, bottom, jump })
  }

  const scheduleScrollState = (el: HTMLDivElement) => {
    scrollStateTarget = el
    if (scrollStateFrame !== undefined) return

    scrollStateFrame = requestAnimationFrame(() => {
      scrollStateFrame = undefined

      const target = scrollStateTarget
      scrollStateTarget = undefined
      if (!target) return

      updateScrollState(target)
    })
  }

  const resumeScroll = () => {
    setStore("messageId", undefined)
    autoScroll.resume()
    scrollToEnd()
    clearMessageHash()

    const el = scroller
    if (el) scheduleScrollState(el)
  }

  // When the user returns to the bottom, treat the active message as "latest".
  createEffect(
    on(
      autoScroll.userScrolled,
      (scrolled) => {
        if (scrolled) return
        setStore("messageId", undefined)
        clearMessageHash()
      },
      { defer: true },
    ),
  )

  let fill = () => {}

  const setScrollRef = (el: HTMLDivElement | undefined) => {
    scroller = el
    autoScroll.scrollRef(el)
    if (!el) return
    scheduleScrollState(el)
    fill()
  }

  const markUserScroll = () => {
    scrollMark += 1
  }

  createResizeObserver(
    () => content,
    () => {
      const el = scroller
      if (el) scheduleScrollState(el)
      fill()
    },
  )

  let captureHistoryAnchor = () => {}
  let restoreHistoryAnchor = (_done: boolean) => {}
  const loadOlder = () => {
    const messageID = cursor()
    const message = messageID ? visibleUserMessages().find((item) => item.id === messageID) : undefined
    if (message) setActiveMessage(message)
    return timeline.history.loadOlder({ before: () => captureHistoryAnchor(), after: restoreHistoryAnchor })
  }
  const onHistoryScroll = (options?: { force?: boolean }) => {
    if (!options?.force && !autoScroll.userScrolled()) return
    if (!scroller || scroller.scrollTop >= 200) return
    void loadOlder()
  }

  fill = () => {
    if (fillFrame !== undefined) return

    fillFrame = requestAnimationFrame(() => {
      fillFrame = undefined

      if (!params.id || !messagesReady()) return
      if (autoScroll.userScrolled() || historyLoading()) return

      const el = scroller
      if (!el) return
      if (
        !shouldAutoFillHistory({
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
        })
      )
        return
      if (!historyMore()) return

      void loadOlder()
    })
  }

  createEffect(
    on(
      () =>
        [
          params.id,
          messagesReady(),
          historyMore(),
          historyLoading(),
          autoScroll.userScrolled(),
          timelineUserMessages().length,
        ] as const,
      ([id, ready, more, loading, scrolled]) => {
        if (!id || !ready || loading || scrolled) return
        if (!more) return
        fill()
      },
      { defer: true },
    ),
  )

  const draft = (id: string) =>
    extractPromptFromParts(sync().data.part[id] ?? [], {
      directory: sdk().directory,
      attachmentName: language.t("common.attachment"),
    })

  const draftPreview = (id: string) => {
    const text = draft(id)
      .map((part) => {
        if (part.type === "image") return `[image:${part.filename}]`
        if (part.type === "file") return `[file:${part.path}]`
        if (part.type === "agent") return `@${part.name}`
        return part.content
      })
      .join("")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => !!line)

    if (text) return text
    return `[${language.t("common.attachment")}]`
  }

  const loadMessageDraft = (input: { sessionID: string; messageID: string }) => {
    const scope = { dir: params.dir!, id: input.sessionID }
    const value = draft(input.messageID)
    prompt.set(value, promptLength(value), scope)
    if (info()?.revert?.status === "reverted") setStore("rollbackDraftSessionID", input.sessionID)
    if (params.id !== input.sessionID || params.dir !== scope.dir) return
    requestAnimationFrame(() => {
      if (params.id !== input.sessionID || params.dir !== scope.dir) return
      focusInput({ force: true })
    })
  }

  const fail = (err: unknown) => {
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: formatServerError(err, language.t),
    })
  }

  const forkMutation = useMutation(() => ({
    mutationFn: async (input: { sessionID: string; messageID: string }) => {
      try {
        const value = draft(input.messageID)
        const cursor = promptLength(value)
        const forked = await sdk().client.session.fork({ sessionID: input.sessionID, messageID: input.messageID })
        if (!forked.data) {
          showToast({ variant: "error", title: language.t("common.requestFailed") })
          return
        }

        const dirBase64 = base64Encode(forked.data.directory)
        prompt.set(value, cursor, { dir: dirBase64, id: forked.data.id })
        sessionTabs.openSessionTab({ server: server.key, dirBase64, sessionId: forked.data.id })
        focusDockPromptInputForSession(forked.data.id, 200, true)
      } catch (err) {
        fail(err)
      }
    },
  }))

  const storeFor = (directory: string) =>
    directory === sdk().directory ? sync().data : serverSync().child(directory)[0]
  const busy = (sessionID: string, directory = sdk().directory) => {
    const store = storeFor(directory)
    if (directory !== sdk().directory && store.status !== "complete") return true
    return store.session_working(sessionID)
  }
  const isChild = (sessionID: string, directory = sdk().directory) =>
    storeFor(directory).session.find((session) => session.id === sessionID)?.parentID !== undefined

  const queuedFollowups = createMemo(() => {
    const id = params.id
    if (!id) return emptyFollowups
    return followup.items[id] ?? emptyFollowups
  })

  const editingFollowup = createMemo(() => {
    const id = params.id
    if (!id) return
    return followup.edit[id]
  })

  const followupMutation = useMutation(() => ({
    mutationFn: async (input: { sessionID: string; id: string; manual?: boolean }) => {
      const items = followup.items[input.sessionID] ?? []
      const index = items.findIndex((entry) => entry.id === input.id)
      const item = items[index]
      if (!item) return

      setFollowup("failed", input.sessionID, undefined)
      if (
        !input.manual &&
        busy(input.sessionID, item.sessionDirectory) &&
        !sessionActivitySettled(item.sessionDirectory, input.sessionID)
      )
        return false

      const removeQueuedFollowup = () => {
        setFollowup("items", input.sessionID, (items) => (items ?? []).filter((entry) => entry.id !== input.id))
      }
      const restoreQueuedFollowup = () => {
        setFollowup("items", input.sessionID, (items) => {
          const list = items ?? []
          if (list.some((entry) => entry.id === input.id)) return list
          const at = Math.min(index, list.length)
          return [...list.slice(0, at), item, ...list.slice(at)]
        })
      }

      removeQueuedFollowup()

      const messageID = Identifier.ascending("message")
      const sent = sendFollowupDraft({
        client:
          item.sessionDirectory === sdk().directory
            ? sdk().client
            : serverSDK().createClient({ directory: item.sessionDirectory, throwOnError: true }),
        sync: sync(),
        serverSync: serverSync(),
        draft: { ...item, messageID },
        messageID,
        optimisticBusy: true,
        queued: true,
        delivery: input.manual ? "steer" : "queue",
      }).catch((err) => {
        batch(() => {
          restoreQueuedFollowup()
          setFollowup("failed", input.sessionID, input.id)
        })
        fail(err)
        return false
      })

      if (input.manual) {
        resumeScroll()
      }

      await sent
    },
  }))

  const followupBusy = (sessionID: string) =>
    followupMutation.isPending && followupMutation.variables?.sessionID === sessionID

  const sendingFollowup = createMemo(() => {
    const id = params.id
    if (!id) return
    if (!followupBusy(id)) return
    return followupMutation.variables?.id
  })

  const queueEnabled = createMemo(() => {
    const id = params.id
    if (!id) return false
    return settings.general.followup() === "queue" && (busy(id) || !!composer.questionRequest()) && !isChildSession()
  })

  const followupText = (item: FollowupDraft) => {
    const text = item.prompt
      .map((part) => {
        if (part.type === "image") return `[image:${part.filename}]`
        if (part.type === "file") return `[file:${part.path}]`
        if (part.type === "agent") return `@${part.name}`
        return part.content
      })
      .join("")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => !!line)

    if (text) return text
    return `[${language.t("common.attachment")}]`
  }

  const queueFollowup = (draft: FollowupDraft) => {
    const id = draft.messageID ?? Identifier.ascending("message")
    setFollowup("items", draft.sessionID, (items) => [...(items ?? []), { id, ...draft, messageID: undefined }])
    setFollowup("failed", draft.sessionID, undefined)
  }

  const followupDock = createMemo(() => [
    ...queuedFollowups().map((item) => ({ id: item.id, text: followupText(item) })),
    ...(heldInputsQuery.data ?? []).map((item) => ({ id: item.id, text: item.prompt.text })),
  ])
  const currentGoal = createMemo(() => {
    const id = params.id
    if (!id) return ""
    const override = goalOverrides[id]
    if (override) return override.value
    const metadata = info()?.metadata
    if (metadata && Object.prototype.hasOwnProperty.call(metadata, sessionGoalMetadataKey)) {
      const value = metadata[sessionGoalMetadataKey]
      return typeof value === "string" ? value.trim() : ""
    }
    return goals.items[id]?.trim() ?? ""
  })

  const clearGoalOverride = (sessionID: string) => {
    const timer = goalOverrideTimers.get(sessionID)
    if (timer !== undefined) clearTimeout(timer)
    goalOverrideTimers.delete(sessionID)
    setGoalOverrides(sessionID, undefined)
  }

  const setGoalOverrideTimer = (sessionID: string, revision: number) => {
    const previous = goalOverrideTimers.get(sessionID)
    if (previous !== undefined) clearTimeout(previous)
    goalOverrideTimers.set(
      sessionID,
      window.setTimeout(() => {
        if (goalOverrideRevisions.get(sessionID) !== revision) return
        const override = goalOverrides[sessionID]
        if (override?.confirmed) setGoals("items", sessionID, override.localBefore)
        clearGoalOverride(sessionID)
      }, 10_000),
    )
  }

  const setGoal = (input: { sessionID: string; goal: string }) => {    const update = prepareGoalMetadataUpdate(input.goal, info()?.metadata)
    const goal = update.goal
    const previousLocal = goals.items[input.sessionID]
    const revision = (goalOverrideRevisions.get(input.sessionID) ?? 0) + 1
    goalOverrideRevisions.set(input.sessionID, revision)
    setGoals("items", input.sessionID, goal || undefined)
    if (!shouldWriteGoalPatch(update.isIdempotent, goalOverrides[input.sessionID] !== undefined)) {
      clearGoalOverride(input.sessionID)
      return
    }
    setGoalOverrideTimer(input.sessionID, revision)
    setGoalOverrides(input.sessionID, {
      value: goal,
      before: update.before,
      localBefore: previousLocal,
      confirmed: false,
    })
    void Promise.resolve()
      .then(() => {
        if (goalOverrideRevisions.get(input.sessionID) !== revision) return
        return sdk().client.session.update({
          sessionID: input.sessionID,
          metadataPatch: goalMetadataPatch(goal),
        })
      })
      .then(() => {
        const confirmed = confirmGoalOverride(
          goalOverrides[input.sessionID],
          goalOverrideRevisions.get(input.sessionID) === revision,
        )
        if (!confirmed) return
        setGoalOverrides(input.sessionID, confirmed)
      })
      .catch((error) => {
        if (goalOverrideRevisions.get(input.sessionID) !== revision) return
        setGoals("items", input.sessionID, previousLocal)
        setGoalOverrides(input.sessionID, undefined)
        showToast({
          title: "Session goal could not be saved",
          description: error instanceof Error ? error.message : "The session metadata update failed.",
        })
      })
  }

  const [goalControlPending, setGoalControlPending] = createStore<Record<string, boolean>>({})
  // The control mutates a run-bound lifecycle: without the goal run metadata
  // there is no safely addressable target, so the dock shows a disabled
  // control with a reason instead of letting a click mutate "whatever runs".
  const goalControlUnavailableReason = (sessionID: string) => {
    const runID = info()?.metadata?.[sessionGoalRunMetadataKey]
    return typeof runID === "string" && runID ? undefined : "Goal control unavailable for this goal"
  }
  const controlGoal = async (action: SessionGoalControlAction) => {
    const sessionID = params.id
    const goal = currentGoal()
    if (!sessionID || !goal) return
    if (goalControlPending[sessionID]) return
    const status = readGoalStatusMetadata(info()?.metadata, goal)
    const request = buildGoalControlRequest({
      sessionID,
      action,
      goalRunMetadata: info()?.metadata?.[sessionGoalRunMetadataKey],
      status,
    })
    setGoalControlPending(sessionID, true)
    const failureToast = (description: string) =>
      showToast({
        title: action === "pause" ? "Goal could not be paused" : "Goal could not be continued",
        description,
      })
    try {
      const response = await sdk().client.pluginServices.sessionGoal({
        sessionID: request.sessionID,
        action: request.action,
        operationID: request.operationID,
        ...(request.runID ? { runID: request.runID } : {}),
        ...(request.expectedRevision !== undefined ? { expectedRevision: request.expectedRevision } : {}),
      })
      // The endpoint wraps the plugin outcome: `{ ok: true, data: outcome }`.
      // Semantic rejections (stale run/revision, no goal) are `outcome.ok ===
      // false` on an otherwise successful HTTP response.
      const outcome = parseGoalControlResponse(response?.data as { ok?: boolean; data?: unknown } | undefined)
      if (!outcome) {
        failureToast("The session goal control returned no result.")
        return
      }
      if (!outcome.ok && !outcome.repeated) {
        failureToast(goalControlErrorText(typeof outcome.error === "string" ? outcome.error : undefined))
        return
      }
      // The mutation response is only an acknowledgement; the canonical goal
      // status arrives through session metadata. A stale response for a
      // replaced run or older revision is ignored outright.
      if (goalControlResponseStale(request, outcome)) return
    } catch (error) {
      failureToast(error instanceof Error ? error.message : "The session goal control failed.")
    } finally {
      setGoalControlPending(sessionID, false)
    }
  }

  createEffect(() => {
    const id = params.id
    const override = id ? goalOverrides[id] : undefined
    if (!id || !override?.confirmed) return
    const metadata = readGoalMetadata(info()?.metadata)
    if (sameGoalMetadata(metadata, override.before)) return
    if (!sameGoalMetadata(metadata, { present: !!override.value, value: override.value })) {
      setGoals("items", id, override.localBefore)
    }
    clearGoalOverride(id)
  })

  onCleanup(() => {
    goalOverrideTimers.forEach((timer) => clearTimeout(timer))
  })

  const sendFollowup = (sessionID: string, id: string, opts?: { manual?: boolean }) => {
    const item = (followup.items[sessionID] ?? []).find((entry) => entry.id === id)
    if (!item) return Promise.resolve()
    if (isChild(sessionID, item.sessionDirectory)) return Promise.resolve()
    if (followupMutation.isPending) return Promise.resolve()
    if (!claimFollowupSend(followupSendKey(sdk().scope, item))) return Promise.resolve()

    return followupMutation
      .mutateAsync({ sessionID, id, manual: opts?.manual })
      .finally(() => releaseFollowupSend(followupSendKey(sdk().scope, item)))
  }

  const editFollowup = (id: string) => {
    const sessionID = params.id
    if (!sessionID) return
    if (followupBusy(sessionID)) return

    const item = queuedFollowups().find((entry) => entry.id === id)
    if (!item) return

    const edit = (prompt = item.prompt) => {
      setFollowup("items", sessionID, (items) => (items ?? []).filter((entry) => entry.id !== id))
      setFollowup("failed", sessionID, (value) => (value === id ? undefined : value))
      setFollowup("edit", sessionID, { id: item.id, prompt, context: item.context })
    }
    const refs = item.prompt.flatMap((part) => part.type === "image" && part.annotation ? [part.annotation] : [])
    if (!refs.length) { edit(); return }
    void import("@/components/image-annotation/storage").then(async ({ restoreQueuedAnnotation }) => {
      const { annotationPart } = await import("@/components/image-annotation/draft-controller")
      const prompt = await Promise.all(item.prompt.map((part) => part.type === "image" && part.annotation ? annotationPart(part.annotation) : part))
      await Promise.all(refs.map(restoreQueuedAnnotation))
      if (params.id !== sessionID || !(followup.items[sessionID] ?? []).some((entry) => entry.id === id)) return
      edit(prompt)
    }).catch(fail)
  }

  const deleteFollowup = (id: string) => {
    const sessionID = params.id
    if (!sessionID) return
    if (followupBusy(sessionID)) return

    const item = (followup.items[sessionID] ?? []).find((entry) => entry.id === id)
    const remove = () => {
      setFollowup("items", sessionID, (items) => (items ?? []).filter((entry) => entry.id !== id))
      setFollowup("failed", sessionID, (value) => (value === id ? undefined : value))
      setFollowup("edit", sessionID, (value) => (value?.id === id ? undefined : value))
    }
    const refs = item?.prompt.flatMap((part) => part.type === "image" && part.annotation ? [part.annotation] : []) ?? []
    if (!refs.length) { remove(); return }
    void import("@/components/image-annotation/storage").then(async ({ removeAnnotation }) => {
      await Promise.all(refs.map(removeAnnotation))
      remove()
    }).catch(fail)
  }

  const moveFollowup = (id: string, beforeID: string) => {
    const sessionID = params.id
    if (!sessionID) return
    if (followupBusy(sessionID)) return

    setFollowup("items", sessionID, (items) => {
      const list = items ?? []
      const from = list.findIndex((entry) => entry.id === id)
      const to = list.findIndex((entry) => entry.id === beforeID)
      if (from < 0 || to < 0 || from === to) return list
      const moving = list[from]
      if (!moving) return list
      const without = list.filter((entry) => entry.id !== id)
      const index = without.findIndex((entry) => entry.id === beforeID)
      if (index < 0) return list
      return [...without.slice(0, index), moving, ...without.slice(index)]
    })
  }

  const clearFollowupEdit = () => {
    const id = params.id
    if (!id) return
    setFollowup("edit", id, undefined)
  }

  const halt = (sessionID: string) =>
    busy(sessionID)
      ? sdk()
          .client.v2.session.interrupt({ sessionID })
          .catch(() => {})
      : Promise.resolve()

  const revertMutation = useMutation(() => ({
    mutationFn: async (input: {
      sessionID: string
      messageID: string
      restoreMessage?: boolean
      files?: "messages_only"
    }) => {
      const client = sdk().client
      const sessionSync = sync()
      const scope = { dir: params.dir!, id: input.sessionID }
      const value = input.restoreMessage ? draft(input.messageID) : undefined
      const previousPrompt = value ? prompt.current().slice() : undefined
      const previousBoundary = store.revertBoundary
      if (value) prompt.set(value, promptLength(value), scope)
      await client.v2.session
        .rollback({ sessionID: input.sessionID, messageID: input.messageID, files: input.files })
        .then((result) => {
          batch(() => {
            const revert = result.data?.data.revert
            sessionSync.set("session", (items) =>
              items.map((item) => item.id === input.sessionID ? { ...item, revert } : item),
            )
            if (params.id === input.sessionID && params.dir === scope.dir) {
              setStore("revertBoundary", revert?.messageID)
            }
            sessionSync.set("session_status", input.sessionID, { type: "idle" })
            if (value) setStore("rollbackDraftSessionID", input.sessionID)
          })
          if (!value) return
          if (params.id !== input.sessionID || params.dir !== scope.dir) return
          requestAnimationFrame(() => {
            if (params.id !== input.sessionID || params.dir !== scope.dir) return
            focusInput({ force: true })
          })
        })
        .catch((err) => {
          if (params.id === input.sessionID && params.dir === scope.dir) setStore("revertBoundary", previousBoundary)
          if (previousPrompt) prompt.set(previousPrompt, promptLength(previousPrompt), scope)
          fail(err)
        })
    },
  }))

  const unrevertMutation = useMutation(() => ({
    mutationFn: async (input: { sessionID: string; messageID?: string; restoreMessage?: boolean }) => {
      const client = sdk().client
      const sessionSync = sync()
      const scope = { dir: params.dir!, id: input.sessionID }
      const value = input.restoreMessage && input.messageID ? draft(input.messageID) : undefined
      await halt(input.sessionID)
        .then(() => client.session.unrevert({ sessionID: input.sessionID }))
        .then((result) => {
          const restored = result.data
          if (!restored) return
          batch(() => {
            sessionSync.set("session", (items) => items.map((item) =>
              item.id === input.sessionID ? { ...restored, revert: restored.revert } : item,
            ))
            if (params.id === input.sessionID && params.dir === scope.dir) {
              setStore("revertBoundary", restored.revert?.messageID)
              setStore("rollbackDraftSessionID", undefined)
            }
            if (value && !restored.revert) prompt.set(value, promptLength(value), scope)
          })
          if (!value || restored.revert || params.id !== input.sessionID || params.dir !== scope.dir) return
          requestAnimationFrame(() => {
            if (params.id === input.sessionID && params.dir === scope.dir) focusInput({ force: true })
          })
        })
        .catch(fail)
    },
  }))

  const reverting = createMemo(() => revertMutation.isPending)

  const restoreMessage = (input: { sessionID: string; messageID: string }) => {
    if (reverting()) return
    return revertMutation.mutateAsync({ ...input, restoreMessage: true })
  }

  const revert = restoreMessage

  const restoreCheckpoint = (input: { sessionID: string; messageID: string }) => {
    if (reverting()) return
    return revertMutation.mutateAsync(input)
  }

  const unreverting = createMemo(() => unrevertMutation.isPending)

  const restoreRevertedCheckpoint = (input: { sessionID: string; messageID: string }) => {
    if (unreverting()) return
    return unrevertMutation.mutateAsync(input)
  }

  const restoreRevertedBoth = (input: { sessionID: string; messageID: string }) => {
    if (unreverting()) return
    return unrevertMutation.mutateAsync({ ...input, restoreMessage: true })
  }

  const fork = (input: { sessionID: string; messageID: string }) => {
    if (forkMutation.isPending) return
    return forkMutation.mutateAsync(input)
  }

  const actions = { fork, restoreCheckpoint, restoreMessage, revert }

  const revertedDock = createMemo(() => {
    const sessionID = params.id
    const boundary = info()?.revert?.messageID ?? store.revertBoundary
    if (!sessionID || !boundary) return
    const currentRevert = info()?.revert

    const before = new Set(rollbackUsersBefore(userMessages(), boundary, messages().find((message) => message.id === boundary)))
    const items = userMessages()
      .filter((message) => !before.has(message))
      .map((message) => ({ id: message.id, text: draftPreview(message.id) }))
    if (items.length === 0) return

    return {
      items,
      blocked: currentRevert?.status === "blocked",
      blockedReason:
        currentRevert?.status === "blocked" && !currentRevert.conflicts?.length
          ? ("unattributed" as const)
          : ("conflict" as const),
      conflicts: currentRevert?.conflicts?.map((conflict) => ({
        resource: conflict.resource,
        message: conflict.message,
      })),
      restoring: unreverting() ? unrevertMutation.variables?.messageID : undefined,
      disabled: reverting() || unreverting(),
      onRestoreCheckpoint: () => void restoreRevertedCheckpoint({ sessionID, messageID: boundary }),
      onKeepFiles: () => void revertMutation.mutateAsync({ sessionID, messageID: boundary, files: "messages_only" }),
      onRestoreMessage: (messageID: string) => loadMessageDraft({ sessionID, messageID }),
      onRestoreBoth: (messageID: string) => void restoreRevertedBoth({ sessionID, messageID }),
    }
  })

  createEffect(() => {
    const boundary = store.revertBoundary
    if (!boundary) return
    if (userMessages().some((item) => item.id === boundary)) return
    setStore("revertBoundary", undefined)
  })

  createEffect(() => {
    const sessionID = params.id
    if (!sessionID) return

    const sent = queuedFollowups().filter(
      (item) =>
        visibleUserMessages().some((message) => message.id === item.id) &&
        !sync().session.optimistic.has({
          directory: item.sessionDirectory,
          sessionID,
          messageID: item.id,
        }),
    )
    if (sent.length > 0) {
      const ids = new Set(sent.map((item) => item.id))
      batch(() => {
        setFollowup("items", sessionID, (items) => (items ?? []).filter((item) => !ids.has(item.id)))
        setFollowup("failed", sessionID, (value) => (value && ids.has(value) ? undefined : value))
        setFollowup("edit", sessionID, (value) => (value && ids.has(value.id) ? undefined : value))
      })
    }
    // Automatic queue release lives in the server-scoped FollowupQueueDrain so
    // parked followups also send while this session's tab is in the background.
    // This page only reconciles items that are already visible as sent messages.
  })

  createResizeObserver(
    () => promptDock,
    ({ height }) => {
      const next = Math.ceil(height)

      if (next === dockHeight) return

      const el = scroller
      const delta = next - dockHeight
      const stick = el
        ? !autoScroll.userScrolled() || el.scrollHeight - el.clientHeight - el.scrollTop < 10 + Math.max(0, delta)
        : false

      dockHeight = next

      if (stick) scrollToEnd()

      if (el) scheduleScrollState(el)
      fill()
    },
  )

  const { clearMessageHash, scrollToMessage } = useSessionHashScroll({
    sessionKey,
    sessionID: () => params.id,
    messagesReady,
    visibleUserMessages,
    historyMore,
    historyLoading,
    loadMore: (sessionID) => sync().session.history.loadMore(sessionID),
    currentMessageId: () => store.messageId,
    pendingMessage: () => ui.pendingMessage,
    setPendingMessage: (value) => setUi("pendingMessage", value),
    setActiveMessage,
    autoScroll: {
      pause: autoScroll.pause,
      forceScrollToBottom: () => {
        autoScroll.resume()
        scrollToEnd()
      },
    },
    scroller: () => scroller,
    anchor,
    revealMessage: (id) => revealMessage(id),
    scheduleScrollState,
    consumePendingMessage: layout.pendingMessage.consume,
  })

  createEffect(
    on(
      () => params.id,
      (id) => {
        if (!id) requestAnimationFrame(() => focusWithoutStealing(inputRef))
      },
    ),
  )

  onMount(() => {
    makeEventListener(document, "keydown", handleKeyDown)
  })

  onCleanup(() => {
    if (reviewFrame !== undefined) cancelAnimationFrame(reviewFrame)
    if (todoFrame !== undefined) cancelAnimationFrame(todoFrame)
    if (todoTimer !== undefined) window.clearTimeout(todoTimer)
    if (diffFrame !== undefined) cancelAnimationFrame(diffFrame)
    if (diffTimer !== undefined) window.clearTimeout(diffTimer)
    if (scrollStateFrame !== undefined) cancelAnimationFrame(scrollStateFrame)
    if (fillFrame !== undefined) cancelAnimationFrame(fillFrame)
  })

  useUsageExceededDialogs()

  const composerDisabled = createMemo(() =>
    info()?.revert?.status === "blocked" ||
    (reverting() && revertMutation.variables?.sessionID === params.id) ||
    (unreverting() && unrevertMutation.variables?.sessionID === params.id),
  )
  const composerRegion = (placement: "dock" | "inline") => (
    <SessionComposerRegion
      state={composer}
      ready={!store.deferRender && sessionShellReady()}
      disabled={composerDisabled()}
      centered={placement === "dock" && centered()}
      placement={placement}
      inputRef={(el) => {
        inputRef = el
      }}
      newSessionWorktree={newSessionWorktree()}
      onNewSessionWorktreeReset={() => setStore("newSessionWorktree", "main")}
      onSubmit={() => {
        // Keep the local revert boundary until message.removed arrives, otherwise
        // the restored prompt can render beside the message it is replacing.
        comments.clear()
        resumeScroll()
      }}
      onResponseSubmit={resumeScroll}
      followup={
        params.id && !isChildSession()
          ? {
              queue: queueEnabled,
              forceSteer: () => store.rollbackDraftSessionID === params.id || info()?.revert?.status === "reverted",
              onForceSteerSent: () => setStore("rollbackDraftSessionID", undefined),
              items: followupDock(),
              sending: sendingFollowup(),
              failed: followup.failed[params.id],
              paused: followup.paused[params.id],
              onPause: () => {
                const id = params.id
                if (!id) return
                // The only pause writer: an explicit user click. The drain
                // never pauses on its own.
                setFollowup("paused", id, true)
              },
              onResume: () => {
                const id = params.id
                if (!id) return
                setFollowup("paused", id, false)
              },
              edit: editingFollowup(),
              onQueue: queueFollowup,
              onGoal: setGoal,
              onAbort: () => {
                const id = params.id
                if (!id) return
                setFollowup("edit", id, undefined)
              },
              onSend: (id) => {
                if (heldInputIDs().has(id)) {
                  void sdk()
                    .client.v2.session.releaseInput({ sessionID: params.id!, inputID: id }, { throwOnError: true })
                    .then(() =>
                      queryClient.invalidateQueries({ queryKey: ["session-held-inputs", sdk().directory, params.id] }),
                    )
                    .catch((error) =>
                      showToast({ title: language.t("common.error"), description: formatServerError(error) }),
                    )
                  return
                }
                void sendFollowup(params.id!, id, { manual: true })
              },
              onEdit: editFollowup,
              onDelete: deleteFollowup,
              onMove: moveFollowup,
              onEditLoaded: clearFollowupEdit,
            }
          : undefined
      }
      goal={
        params.id && currentGoal()
          ? {
              value: currentGoal(),
              onClear: () => setGoal({ sessionID: params.id!, goal: "" }),
              status: readGoalStatusMetadata(info()?.metadata, currentGoal()),
              onControl: (action) => void controlGoal(action),
              controlPending: goalControlPending[params.id!] === true,
              controlUnavailableReason: goalControlUnavailableReason(params.id!),
            }
          : undefined
      }
      revert={revertedDock()}
      setPromptDockRef={(el) => {
        promptDock = el
      }}
    />
  )

  const mobileChangesContent = () => (
    <div class="relative h-full overflow-hidden">
      {reviewContent({
        diffStyle: "unified",
        classes: {
          root: "pb-8",
          header: "px-4",
          container: "px-4",
        },
        loadingClass: "px-4 py-4 text-text-weak",
        emptyClass: "h-full pb-64 -mt-4 flex flex-col items-center justify-center text-center gap-6",
      })}
    </div>
  )

  const middleContent = () => (
    <div class="@container relative flex flex-col min-h-0 h-full flex-1">
      <div
        classList={{
          "flex-1 min-h-0 flex flex-col bg-background-stronger": true,
          "rounded-[10px] overflow-hidden": true,
          "shadow-[var(--v2-elevation-raised)]": !!params.id,
        }}
      >
        <div class="relative flex-1 min-h-0 overflow-hidden">
          <Show when={showRefreshIndicator()}>
            <div
              data-testid="session-refresh-indicator"
              role="status"
              aria-live="polite"
              class="pointer-events-none absolute top-14 left-1/2 z-40 -translate-x-1/2 flex items-center gap-2 rounded-full bg-surface-raised-stronger/95 px-3 py-1.5 text-12-medium text-text-base shadow-lg"
            >
              <Spinner class="size-3.5 shrink-0" />
              <span>{language.t("session.messages.loading")}</span>
            </div>
          </Show>
          <Show
            when={timeline.error()}
            keyed
            fallback={
              <Switch>
                <Match when={params.id}>
                  <Show when={sessionShellReady() ? params.id : undefined} keyed>
                    {(_id) => (
                      <Show
                        when={!store.deferTimeline}
                        fallback={
                          <div
                            data-slot="session-timeline-pending"
                            aria-busy="true"
                            class="h-full min-w-0 w-full px-5 pt-4 md:px-8"
                          >
                            <Show when={sessionTitle(info()?.title)} keyed>
                              {(title) => <h1 class="text-14-medium text-text-strong truncate">{title}</h1>}
                            </Show>
                          </div>
                        }
                      >
                        <MessageTimeline
                          actions={actions}
                          scroll={ui.scroll}
                          onResumeScroll={resumeScroll}
                          setScrollRef={setScrollRef}
                          onScheduleScrollState={scheduleScrollState}
                          onAutoScrollHandleScroll={autoScroll.handleScroll}
                          onMarkScrollGesture={markScrollGesture}
                          hasScrollGesture={hasScrollGesture}
                          onUserScroll={markUserScroll}
                          onHistoryScroll={onHistoryScroll}
                          onAutoScrollInteraction={autoScroll.handleInteraction}
                          shouldAnchorBottom={() =>
                            !location.hash && !store.messageId && !ui.pendingMessage && !autoScroll.userScrolled()
                          }
                          centered={centered()}
                          setContentRef={(el) => {
                            content = el
                            autoScroll.contentRef(el)

                            const root = scroller
                            if (root) scheduleScrollState(root)
                          }}
                          userMessages={timelineUserMessages()}
                          checkpoints={visibleUserMessages()}
                          setHistoryAnchor={(handlers) => {
                            captureHistoryAnchor = handlers.capture
                            restoreHistoryAnchor = handlers.restore
                          }}
                          anchor={anchor}
                          setRevealMessage={(fn) => {
                            revealMessage = fn
                          }}
                          setScrollToEnd={(fn) => {
                            scrollToEnd = fn
                          }}
                        />
                      </Show>
                    )}
                  </Show>
                </Match>
                <Match when={true}>
                  <NewSessionDesignView>{composerRegion("inline")}</NewSessionDesignView>
                </Match>
              </Switch>
            }
          >
            {(failure) => (
              <div
                data-testid="session-load-error"
                class="size-full flex items-center justify-center bg-background-stronger px-6"
              >
                <div class="max-w-md flex flex-col items-center gap-3 text-center">
                  <div class="text-16-medium text-text-strong">{language.t("session.messages.unavailable.title")}</div>
                  <div class="text-13-regular text-text-weak">
                    {language.t("session.messages.unavailable.description")}
                  </div>
                  <div class="max-w-full line-clamp-3 break-all text-12-regular text-text-weaker">
                    {formatServerError(failure.error, language.t)}
                  </div>
                  <div class="flex items-center gap-2 pt-1">
                    <Button
                      type="button"
                      size="large"
                      variant="primary"
                      disabled={sessionSync.loading}
                      onClick={() => void timeline.retry()}
                    >
                      {language.t("session.messages.unavailable.retry")}
                    </Button>
                    <Button type="button" size="large" variant="ghost" onClick={closeUnavailableSessionTab}>
                      {language.t("common.closeTab")}
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </Show>
        </div>

        <Show when={params.id && !timeline.error()}>{composerRegion("dock")}</Show>
      </div>
    </div>
  )

  const rightDockContent = (mode: "review" | "changes" | "all") => (
    <SessionSidePanel
      mode={mode}
      canReview={canReview}
      diffs={reviewDiffs}
      diffsReady={reviewReady}
      empty={reviewEmptyText}
      hasReview={hasReview}
      reviewCount={reviewCount}
      reviewPanel={reviewPanel}
      activeDiff={tree.activeDiff}
      focusReviewDiff={focusReviewDiff}
      reviewSnap={ui.reviewSnap}
      size={size}
    />
  )

  // The server-scoped dock shell renders our header, review/file tree panes,
  // terminal, and mobile changes; registration lives under this page's owner
  // so disposing the routed subtree (directory switch) clears it atomically.
  dockContent.register({
    header: () => <SessionHeader />,
    review: () => rightDockContent("review"),
    changes: () => rightDockContent("changes"),
    files: () => rightDockContent("all"),
    // Keep terminal construction lazy: registering hidden dock content must not
    // create a PTY until the terminal pane is actually mounted.
    bottom: () => <TerminalPanel docked />,
    mobileChanges: mobileChangesContent,
    mobileChangesOpen: () => !!params.id && mobileChanges(),
    onResponseSubmit: resumeScroll,
  })

  return (
    <div class="relative size-full overflow-hidden flex flex-col">
      {sessionSync() ?? ""}
      {middleContent()}
    </div>
  )
}
