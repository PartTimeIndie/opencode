import { useFilteredList } from "@opencode-ai/ui/hooks"
import { useSpring } from "@opencode-ai/ui/motion-spring"
import {
  createEffect,
  on,
  Component,
  splitProps,
  For,
  Show,
  onCleanup,
  createMemo,
  createSignal,
  createResource,
  createUniqueId,
  Switch,
  Match,
  onMount,
  type JSX,
} from "solid-js"
import { createStore, type SetStoreFunction, type Store } from "solid-js/store"
import { createMediaQuery } from "@solid-primitives/media"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import type { useLocal } from "@/context/local"
import { selectionFromLines, type SelectedLineRange, useFile } from "@/context/file"
import { encodeFilePath } from "@/context/file/path"
import { insertPromptDraft, promptInsertionIdentity } from "@/context/prompt-insert"
import {
  ContentPart,
  DEFAULT_PROMPT,
  isPromptEqual,
  Prompt,
  usePrompt,
  PromptAttachmentPart,
  AgentPart,
  FileAttachmentPart,
} from "@/context/prompt"
import { getProjectAvatarVariant, useLayout } from "@/context/layout"
import { MOBILE_DOCK_MEDIA_QUERY } from "@/context/layout-dock"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { composerRegistry } from "@/plugin/composer-registry"
import { useSync } from "@/context/sync"
import { useComments } from "@/context/comments"
import { DockShellForm, DockTray } from "@opencode-ai/ui/dock-surface"
import { Icon } from "@opencode-ai/ui/icon"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Select } from "@opencode-ai/ui/select"
import { Spinner } from "@opencode-ai/ui/spinner"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { matchKeybind, parseKeybind, useCommand } from "@/context/command"
import { Persist, persisted } from "@/utils/persist"
import { usePermission } from "@/context/permission"
import type { AccessControlMode } from "@/context/permission"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { slashCommandColorDefaults, useSettings } from "@/context/settings"
import { createSessionTabs } from "@/pages/session/helpers"
import {
  createTextFragment,
  getCursorPositionOrNull,
  isPlaceholderBreak,
  setCursorPosition,
  setRangeEdge,
} from "./prompt-input/editor-dom"
import { createPromptAttachments } from "./prompt-input/attachments"
import {
  ComposerAccessControl,
  ComposerAgentControl,
  ComposerModelControl,
  ComposerPicker,
  type ComposerAccessControlState,
  type ComposerAgentControlState,
  type ComposerModelControlState,
  type ComposerPickerState,
} from "./prompt-input/composer-controls"
import { ACCEPTED_FILE_TYPES, pickAttachmentFiles } from "./prompt-input/files"
import { compactComposerToolbar } from "./prompt-input/composer-layout"
import {
  canNavigateHistoryAtCursor,
  navigatePromptHistory,
  prependHistoryEntry,
  migratePromptHistoryState,
  type PromptHistoryComment,
  type PromptHistoryEntry,
  type PromptHistoryState,
  type PromptHistoryStoredEntry,
  promptLength,
  resumeLastPromptEntry,
} from "./prompt-input/history"
import { createPromptSubmit, type FollowupDraft, type PromptSubmitOptions } from "./prompt-input/submit"
import { preventNativeSubmit } from "./prompt-input/submit-event"
import { PromptPopover, type AtOption, type SlashCommand } from "./prompt-input/slash-popover"
import {
  commandToSlashCommand,
  normalizeSlashSuffix,
  searchSlashCommands,
  slashSearchContext,
  supportsSlashCommand,
  type SlashSearchContext,
} from "./prompt-input/slash-search"
import { PromptContextItems } from "./prompt-input/context-items"
import { PromptAttachments } from "./prompt-input/image-attachments"
import { AttachmentPreviewOverlay, type Attachment } from "./message/attachment-preview-overlay"
import { PromptDragOverlay } from "./prompt-input/drag-overlay"
import { promptPlaceholder } from "./prompt-input/placeholder"
import { showToast } from "@/utils/toast"
import { pathKey } from "@/utils/path-key"
import { displayName, getProjectAvatarMonochrome, getProjectAvatarSource } from "@/pages/layout/helpers"
import { PluginSlotOutlet } from "@/plugin/slot-outlet"
import { PluginToolbarMobileOverflow, PluginToolbarOutlet } from "@/plugin/toolbar-outlet"
import { UI_SLOT_IDS } from "@/plugin/ui-slots"
import { SessionContextUsage } from "@/components/session-context-usage"
import { ProjectAvatar } from "@opencode-ai/ui/v2/project-avatar-v2"
import { useTheme } from "@opencode-ai/ui/theme/context"
import { normalizeCommandList } from "@/context/global-sync/utils"
import { findSlashCommandRanges } from "@opencode-ai/core/util/slash-command"

export type PromptInputState = ReturnType<typeof usePrompt>

export type PromptInputElement = HTMLDivElement & {
  restorePromptFocus?: () => void
}

export type PromptInputHistory = {
  entries: (mode: "normal" | "shell") => PromptHistoryStoredEntry[]
  add: (prompt: Prompt, mode: "normal" | "shell", comments: PromptHistoryComment[]) => void
}

export type PromptInputSubmission = {
  abort: () => Promise<void> | void
  handleSubmit: (event: Event, options?: PromptSubmitOptions) => Promise<void> | void
  submitText?: (input: {
    text: string
    delivery: "steer" | "queue"
  }) => Promise<{ ok: boolean; error?: string }>
}

export type PromptInputControls = {
  selection: ReturnType<typeof useLocal>["selection"]
  agents: {
    available: {
      name: string
      hidden?: boolean
      mode: string
      tools?: {
        mode: "inherit" | "explicit"
        entries: Record<string, { visible?: boolean; permission?: "allow" | "ask" | "deny" }>
      }
    }[]
    options: string[]
    current: string
    loading: boolean
    visible: boolean
    refresh: () => Promise<void>
    select: (name: string | undefined) => void
  }
  model: {
    selection: ReturnType<typeof useLocal>["model"]
    paid: boolean
    loading: boolean
    error: boolean
    retrying: boolean
    retry: () => void
  }
  projects: {
    available: {
      id?: string
      name?: string
      worktree: string
      sandboxes?: string[]
      icon?: { color?: string; url?: string; override?: string }
    }[]
    directory: string
    disabled?: boolean
    select: (worktree: string) => void
    add: (title: string) => void
  }
  session: {
    id?: string
    tabs: {
      active: () => string | undefined
      all: () => string[]
      open: (tab: string) => void | Promise<void>
      setActive: (tab: string) => void
    }
    reviewPanel: {
      opened: () => boolean
      open: () => void
    }
  }
}

type SelectionSnapshot = ReturnType<PromptInputControls["selection"]["snapshot"]>

export function createPromptInputHistory(): PromptInputHistory {
  const [normal, setNormal] = createStore<PromptHistoryState>({ entries: [] })
  const [shell, setShell] = createStore<PromptHistoryState>({ entries: [] })
  return createPromptInputHistoryStore(normal, setNormal, shell, setShell)
}

function createPromptInputHistoryStore(
  normal: Store<PromptHistoryState>,
  setNormal: SetStoreFunction<PromptHistoryState>,
  shell: Store<PromptHistoryState>,
  setShell: SetStoreFunction<PromptHistoryState>,
): PromptInputHistory {
  return {
    entries: (mode) => (mode === "shell" ? shell.entries : normal.entries),
    add(prompt, mode, comments) {
      const current = mode === "shell" ? shell : normal
      const setCurrent = mode === "shell" ? setShell : setNormal
      const next = prependHistoryEntry(current.entries, prompt, comments)
      if (next === current.entries) return
      setCurrent("entries", next)
    },
  }
}

function createPersistedPromptInputHistory() {
  const [normal, setNormal] = persisted(
    { ...Persist.global("prompt-history", ["prompt-history.v1"]), migrate: migratePromptHistoryState },
    createStore<PromptHistoryState>({ entries: [] }),
  )
  const [shell, setShell] = persisted(
    { ...Persist.global("prompt-history-shell", ["prompt-history-shell.v1"]), migrate: migratePromptHistoryState },
    createStore<PromptHistoryState>({ entries: [] }),
  )
  return createPromptInputHistoryStore(normal, setNormal, shell, setShell)
}

export interface PromptInputProps {
  class?: string
  disabled?: boolean
  variant?: "dock" | "new-session"
  state?: PromptInputState
  history?: PromptInputHistory
  submission?: PromptInputSubmission
  draftID?: string
  controls: PromptInputControls
  footerStatus?: JSX.Element
  ref?: (el: HTMLDivElement) => void
  newSessionWorktree?: string
  onNewSessionWorktreeReset?: () => void
  edit?: { id: string; prompt: Prompt; context: FollowupDraft["context"] }
  onEditLoaded?: () => void
  shouldQueue?: () => boolean
  onQueue?: (draft: FollowupDraft) => void
  forceSteer?: () => boolean
  onForceSteerSent?: () => void
  onGoal?: (input: { sessionID: string; sessionDirectory: string; goal: string }) => void
  onAbort?: () => void
  onSubmit?: () => void
}

const EXAMPLES = [
  "prompt.example.1",
  "prompt.example.2",
  "prompt.example.3",
  "prompt.example.4",
  "prompt.example.5",
  "prompt.example.6",
  "prompt.example.7",
  "prompt.example.8",
  "prompt.example.9",
  "prompt.example.10",
  "prompt.example.11",
  "prompt.example.12",
  "prompt.example.13",
  "prompt.example.14",
  "prompt.example.15",
  "prompt.example.16",
  "prompt.example.17",
  "prompt.example.18",
  "prompt.example.19",
  "prompt.example.20",
  "prompt.example.21",
  "prompt.example.22",
  "prompt.example.23",
  "prompt.example.24",
  "prompt.example.25",
] as const

export const PromptInput: Component<PromptInputProps> = (props) => {
  const composerID = props.controls.session.id || props.draftID || createUniqueId()
  const sdk = useSDK()
  const server = useServer()
  const mobileLayout = createMediaQuery(MOBILE_DOCK_MEDIA_QUERY)
  const [toolbarCompact, setToolbarCompact] = createSignal(mobileLayout())
  let toolbarControls: HTMLDivElement | undefined
  let fullToolbarWidth = 640
  const syncToolbarLayout = () => {
    if (!toolbarControls) return
    if (!toolbarCompact()) {
      const left = toolbarControls.querySelector<HTMLElement>('[data-slot="composer-toolbar-left"]')
      const right = toolbarControls.querySelector<HTMLElement>('[data-slot="composer-toolbar-right"]')
      if (left && right) fullToolbarWidth = Math.max(640, left.scrollWidth + right.scrollWidth + 16)
    }
    const next =
      mobileLayout() ||
      compactComposerToolbar({ width: toolbarControls.clientWidth, required: fullToolbarWidth, compact: toolbarCompact() })
    if (toolbarCompact() && !next) {
      setToolbarCompact(false)
      // The full outlets were unmounted while compact; measure their current contents before paint.
      queueMicrotask(syncToolbarLayout)
      return
    }
    setToolbarCompact(next)
  }
  createResizeObserver(() => toolbarControls, syncToolbarLayout)
  createEffect(syncToolbarLayout)
  onMount(() => {
    if (!toolbarControls) return
    const observer = new MutationObserver(() => queueMicrotask(syncToolbarLayout))
    observer.observe(toolbarControls, { childList: true, subtree: true })
    requestAnimationFrame(syncToolbarLayout)
    onCleanup(() => observer.disconnect())
  })

  const sync = useSync()
  const files = useFile()
  const prompt = props.state ?? usePrompt()
  const layout = useLayout()
  const comments = useComments()
  const dialog = useDialog()
  const command = useCommand()
  const settings = useSettings()
  const theme = useTheme()
  const permission = usePermission()
  const language = useLanguage()
  const platform = usePlatform()
  const tabs = () => props.controls.session.tabs
  let editorRef!: HTMLDivElement
  let fileInputRef: HTMLInputElement | undefined
  let scrollRef!: HTMLDivElement
  let slashPopoverRef!: HTMLDivElement
  let projectSearchRef: HTMLInputElement | undefined

  const mirror = { input: false }
  const inset = 56
  const space = `${inset}px`

  const scrollCursorIntoView = () => {
    const container = scrollRef
    const selection = window.getSelection()
    if (!container || !selection || selection.rangeCount === 0) return

    const range = selection.getRangeAt(0)
    if (!editorRef.contains(range.startContainer)) return

    const cursor = getCursorPositionOrNull(editorRef)
    if (cursor === null) return
    const length = promptLength(prompt.current().filter((part) => part.type !== "image"))
    if (cursor >= length) {
      container.scrollTop = container.scrollHeight
      return
    }

    const rect = range.getClientRects().item(0) ?? range.getBoundingClientRect()
    if (!rect.height) return

    const containerRect = container.getBoundingClientRect()
    const top = rect.top - containerRect.top + container.scrollTop
    const bottom = rect.bottom - containerRect.top + container.scrollTop
    const padding = 12

    if (top < container.scrollTop + padding) {
      container.scrollTop = Math.max(0, top - padding)
      return
    }

    if (bottom > container.scrollTop + container.clientHeight - inset) {
      container.scrollTop = bottom - container.clientHeight + inset
    }
  }

  const queueScroll = (count = 2) => {
    requestAnimationFrame(() => {
      scrollCursorIntoView()
      if (count > 1) queueScroll(count - 1)
    })
  }

  const activeFileTab = createSessionTabs({
    tabs,
    pathFromTab: files.pathFromTab,
    normalizeTab: (tab) => (tab.startsWith("file://") ? files.tab(tab) : tab),
  }).activeFileTab

  const commentInReview = (path: string) => {
    const sessionID = props.controls.session.id
    if (!sessionID) return false

    const diffs = sync().data.session_diff[sessionID]
    if (!diffs) return false
    return diffs.some((diff) => diff.file === path)
  }

  const openComment = (item: { path: string; commentID?: string; commentOrigin?: "review" | "file" }) => {
    if (!item.commentID) return

    const focus = { file: item.path, id: item.commentID }
    comments.setActive(focus)

    const queueCommentFocus = (attempts = 6) => {
      const schedule = (left: number) => {
        requestAnimationFrame(() => {
          comments.setFocus({ ...focus })
          if (left <= 0) return
          requestAnimationFrame(() => {
            const current = comments.focus()
            if (!current) return
            if (current.file !== focus.file || current.id !== focus.id) return
            schedule(left - 1)
          })
        })
      }

      schedule(attempts)
    }

    const wantsReview = item.commentOrigin === "review" || (item.commentOrigin !== "file" && commentInReview(item.path))
    if (wantsReview) {
      if (!props.controls.session.reviewPanel.opened()) props.controls.session.reviewPanel.open()
      layout.fileTree.setTab("changes")
      tabs().setActive("review")
      queueCommentFocus()
      return
    }

    if (!props.controls.session.reviewPanel.opened()) props.controls.session.reviewPanel.open()
    layout.fileTree.setTab("all")
    const tab = files.tab(item.path)
    void tabs().open(tab)
    tabs().setActive(tab)
    void Promise.resolve(files.load(item.path)).finally(() => queueCommentFocus())
  }

  const recent = createMemo(() => {
    const all = tabs().all()
    const active = activeFileTab()
    const order = active ? [active, ...all.filter((x) => x !== active)] : all
    const seen = new Set<string>()
    const paths: string[] = []

    for (const tab of order) {
      const path = files.pathFromTab(tab)
      if (!path) continue
      if (seen.has(path)) continue
      seen.add(path)
      paths.push(path)
    }

    return paths
  })
  const info = createMemo(() => (props.controls.session.id ? sync().session.get(props.controls.session.id) : undefined))
  const working = createMemo(() => sync().data.session_working(props.controls.session.id ?? ""))
  const promptAttachments = createMemo(() =>
    prompt.current().filter((part): part is PromptAttachmentPart => part.type === "image"),
  )

  const [store, setStore] = createStore<{
    popover: "at" | "slash" | null
    historyIndex: number
    savedPrompt: PromptHistoryEntry | null
    placeholder: number
    draggingType: "image" | "@mention" | null
    mode: "normal" | "shell"
    applyingHistory: boolean
    agentOpen: boolean
    variantOpen: boolean
    slashSearch?: SlashSearchContext
    temporarySelection?: {
      trigger: string
      snapshot: SelectionSnapshot
    }
  }>({
    popover: null,
    historyIndex: -1,
    savedPrompt: null as PromptHistoryEntry | null,
    placeholder: Math.floor(Math.random() * EXAMPLES.length),
    draggingType: null,
    mode: "normal",
    applyingHistory: false,
    agentOpen: false,
    variantOpen: false,
    slashSearch: undefined,
    temporarySelection: undefined,
  })
  const [picker, setPicker] = createStore({
    projectOpen: false,
    projectSearch: "",
  })
  const [activePromptAttachment, setActivePromptAttachment] = createSignal<Attachment | null>(null)
  const [submitPending, setSubmitPending] = createSignal(false)
  const [showSubmitOverlay, setShowSubmitOverlay] = createSignal(false)
  let submitOverlayTimer: number | undefined
  let commandRefresh: Promise<void> | undefined
  let commandRefreshAt = 0

  createEffect(
    on(
      () => store.popover,
      (popover) => {
        if (popover !== "slash" || commandRefresh || Date.now() - commandRefreshAt < 1_000) return
        commandRefreshAt = Date.now()
        commandRefresh = sdk()
          .client.v2.command.list()
          .then((response) => {
            if (!response.data?.data) return
            sync().set("command", normalizeCommandList(response.data.data))
          })
          .catch(() => {
            commandRefreshAt = 0
          })
          .finally(() => {
            commandRefresh = undefined
          })
      },
    ),
  )
  const promptAttachmentUrl = (attachment: PromptAttachmentPart) =>
    attachment.dataUrl ?? (attachment.sourcePath ? `file://${encodeFilePath(attachment.sourcePath)}` : undefined)

  const openPromptAttachment = (attachment: PromptAttachmentPart) => {
    const url = promptAttachmentUrl(attachment)
    if (!url) return
    setActivePromptAttachment({
      id: attachment.id,
      mediaType: attachment.mime,
      url,
      filename: attachment.filename,
    })
  }

  const clampCursor = (cursor: number, parts: Prompt) => Math.max(0, Math.min(cursor, promptLength(parts)))

  const focusEditor = (cursor = prompt.cursor() ?? promptLength(prompt.current()), parts = prompt.current()) => {
    editorRef.focus({ preventScroll: true })
    setCursorPosition(editorRef, clampCursor(cursor, parts))
    queueScroll()
  }

  const bindEditorRef = (el: HTMLDivElement) => {
    editorRef = el
    const input = el as PromptInputElement
    input.restorePromptFocus = focusEditor
    props.ref?.(el)
  }

  const buttonsSpring = useSpring(() => (store.mode === "normal" ? 1 : 0), { visualDuration: 0.2, bounce: 0 })
  const motion = (value: number) => ({
    opacity: value,
    transform: `scale(${0.98 + value * 0.02})`,
    filter: `blur(${(1 - value) * 2}px)`,
    "pointer-events": value > 0.5 ? ("auto" as const) : ("none" as const),
  })
  const buttons = createMemo(() => motion(buttonsSpring()))
  const shell = createMemo(() => motion(1 - buttonsSpring()))
  const control = createMemo(() => ({ height: "28px", ...buttons() }))

  const commentCount = createMemo(() => {
    if (store.mode === "shell") return 0
    return prompt.context.items().filter((item) => !!item.comment?.trim()).length
  })
  const blank = createMemo(() => {
    const text = prompt
      .current()
      .map((part) => ("content" in part ? part.content : ""))
      .join("")
    return text.trim().length === 0 && promptAttachments().length === 0 && commentCount() === 0
  })
  const stopping = createMemo(() => working() && blank())
  const tip = () => {
    if (stopping()) {
      return (
        <div class="flex items-center gap-2">
          <span>{language.t("prompt.action.stop")}</span>
          <span class="text-icon-base text-12-medium text-[10px]!">{language.t("common.key.esc")}</span>
        </div>
      )
    }

    return (
      <div class="flex items-center gap-2">
        <span>{language.t("prompt.action.send")}</span>
        <Icon name="enter" size="small" class="text-icon-base" />
      </div>
    )
  }

  const contextItems = createMemo(() => {
    const items = prompt.context.items()
    if (store.mode !== "shell") return items
    return items.filter((item) => !item.comment?.trim())
  })

  const hasUserPrompt = createMemo(() => {
    const sessionID = props.controls.session.id
    if (!sessionID) return false
    const messages = sync().data.message[sessionID]
    if (!messages) return false
    return messages.some((m) => m.role === "user")
  })

  const history = props.history ?? createPersistedPromptInputHistory()
  // An empty idle composer with a previous prompt can restart the last run from the
  // submit button, mirroring the Enter-key behavior.
  const canResumeLastPrompt = createMemo(() =>
    resumeLastPromptEntry({
      mode: store.mode,
      working: working(),
      historyIndex: store.historyIndex,
      hasSession: !!props.controls.session.id,
      blank: blank(),
      hasPendingContext: prompt.context.items().length > 0,
      entries: history.entries("normal"),
    }) !== undefined,
  )

  const suggest = createMemo(() => !hasUserPrompt())

  const placeholder = createMemo(() =>
    promptPlaceholder({
      mode: store.mode,
      commentCount: commentCount(),
      example: suggest() ? (store.mode === "shell" ? "git status" : language.t(EXAMPLES[store.placeholder])) : "",
      suggest: suggest(),
      t: (key, params) => language.t(key as Parameters<typeof language.t>[0], params as never),
    }),
  )

  const historyComments = () => {
    const byID = new Map(comments.all().map((item) => [`${item.file}\n${item.id}`, item] as const))
    return prompt.context.items().flatMap((item) => {
      if (item.type !== "file") return []
      const comment = item.comment?.trim()
      if (!comment) return []

      const selection = item.commentID ? byID.get(`${item.path}\n${item.commentID}`)?.selection : undefined
      const nextSelection =
        selection ??
        (item.selection
          ? ({
              start: item.selection.startLine,
              end: item.selection.endLine,
            } satisfies SelectedLineRange)
          : undefined)
      if (!nextSelection) return []

      return [
        {
          id: item.commentID ?? item.key,
          path: item.path,
          selection: { ...nextSelection },
          comment,
          time: item.commentID ? (byID.get(`${item.path}\n${item.commentID}`)?.time ?? Date.now()) : Date.now(),
          origin: item.commentOrigin,
          preview: item.preview,
        } satisfies PromptHistoryComment,
      ]
    })
  }

  const applyHistoryComments = (items: PromptHistoryComment[]) => {
    comments.replace(
      items.map((item) => ({
        id: item.id,
        file: item.path,
        selection: { ...item.selection },
        comment: item.comment,
        time: item.time,
      })),
    )
    prompt.context.replaceComments(
      items.map((item) => ({
        type: "file" as const,
        path: item.path,
        selection: selectionFromLines(item.selection),
        comment: item.comment,
        commentID: item.id,
        commentOrigin: item.origin,
        preview: item.preview,
      })),
    )
  }

  const applyHistoryPrompt = (entry: PromptHistoryEntry, position: "start" | "end") => {
    const p = entry.prompt
    const length = position === "start" ? 0 : promptLength(p)
    setStore("applyingHistory", true)
    applyHistoryComments(entry.comments)
    prompt.set(p, length)
    requestAnimationFrame(() => {
      focusEditor(length, p)
      setStore("applyingHistory", false)
    })
  }

  const getCaretState = () => {
    const selection = window.getSelection()
    const textLength = promptLength(prompt.current())
    if (!selection || selection.rangeCount === 0) {
      return { collapsed: false, cursorPosition: prompt.cursor() ?? 0, textLength }
    }
    const anchorNode = selection.anchorNode
    if (!anchorNode || !editorRef.contains(anchorNode)) {
      return { collapsed: false, cursorPosition: prompt.cursor() ?? 0, textLength }
    }
    return {
      collapsed: selection.isCollapsed,
      cursorPosition: getCursorPositionOrNull(editorRef) ?? prompt.cursor() ?? 0,
      textLength,
    }
  }

  const escBlur = () => platform.platform === "desktop" && platform.os === "macos"

  const pick = () => {
    pickAttachmentFiles({
      picker: platform.openAttachmentPickerDialog,
      directory: () => sdk().directory,
      fallback: () => fileInputRef?.click(),
      onFile: addAttachment,
      onError: (error) =>
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: error instanceof Error ? error.message : String(error),
        }),
    })
  }

  const setMode = (mode: "normal" | "shell") => {
    setStore("mode", mode)
    setStore("popover", null)
    restoreFocus()
  }

  const shellModeKey = "mod+shift+x"
  const normalModeKey = "mod+shift+e"
  const toolbarCycleKey = "shift+space"
  const toolbarMultiActivateKey = "ctrl+shift+space"
  const toolbarCycleDoubleTapMs = 650
  const toolbarCycleSelectionTimeoutMs = 3000

  command.register("prompt-input", () => [
    {
      id: "file.attach",
      title: language.t("prompt.action.attachFile"),
      category: language.t("command.category.file"),
      keybind: "mod+u",
      disabled: store.mode !== "normal",
      onSelect: pick,
    },
    {
      id: "prompt.mode.shell",
      title: language.t("command.prompt.mode.shell"),
      category: language.t("command.category.session"),
      keybind: shellModeKey,
      disabled: store.mode === "shell",
      onSelect: () => setMode("shell"),
    },
    {
      id: "prompt.mode.normal",
      title: language.t("command.prompt.mode.normal"),
      category: language.t("command.category.session"),
      keybind: normalModeKey,
      disabled: store.mode === "normal",
      onSelect: () => setMode("normal"),
    },
    {
      id: "prompt.toolbar.cycle",
      title: language.t("command.prompt.toolbar.cycle"),
      description: language.t("command.prompt.toolbar.cycle.description"),
      category: language.t("command.category.session"),
      keybind: toolbarCycleKey,
      disabled: true,
      onSelect: () => {},
    },
    {
      id: "prompt.toolbar.multiActivate",
      title: `${language.t("command.prompt.toolbar.cycle")} (multi)`,
      description: language.t("command.prompt.toolbar.cycle.description"),
      category: language.t("command.category.session"),
      keybind: toolbarMultiActivateKey,
      disabled: true,
      onSelect: () => {},
    },
  ])

  const closePopover = () => {
    setStore("popover", null)
    setStore("slashSearch", undefined)
  }

  const resetHistoryNavigation = (force = false) => {
    if (!force && (store.historyIndex < 0 || store.applyingHistory)) return
    setStore("historyIndex", -1)
    setStore("savedPrompt", null)
  }

  const clearEditor = () => {
    editorRef.innerHTML = ""
  }

  const setEditorText = (text: string) => {
    clearEditor()
    editorRef.textContent = text
  }

  const editorTextHTML = (text: string) => {
    if (!text) return ""
    const html = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>")
    return text.endsWith("\n") ? `${html}&#8203;` : html
  }

  const replaceEditorTextWithUndo = (text: string) => {
    editorRef.focus({ preventScroll: true })
    const selection = window.getSelection()
    if (!selection) return false
    const range = document.createRange()
    range.selectNodeContents(editorRef)
    selection.removeAllRanges()
    selection.addRange(range)
    if (!text) return document.execCommand("delete")
    return document.execCommand("insertHTML", false, editorTextHTML(text))
  }

  const promptText = () =>
    prompt
      .current()
      .map((part) => ("content" in part ? part.content : ""))
      .join("")

  const setPromptText = (text: string) => {
    const images = promptAttachments()
    closePopover()
    resetHistoryNavigation(true)
    if (replaceEditorTextWithUndo(text)) {
      handleInput()
      requestAnimationFrame(() => {
        focusEditor(text.length, [{ type: "text", content: text, start: 0, end: text.length }, ...images])
      })
      return
    }

    const next = [{ type: "text" as const, content: text, start: 0, end: text.length }, ...images]
    setEditorText(text)
    prompt.set(text.length === 0 && images.length === 0 ? DEFAULT_PROMPT : next, text.length)
    requestAnimationFrame(() => focusEditor(text.length, next))
  }

  const appendPromptText = (value: string) => {
    const text = value.trim()
    if (!text) return
    const content = prompt.current().filter((part) => part.type !== "image").map((part) => ({ ...part }))
    const suffix = `${promptText().trim() ? "\n\n" : ""}${text}`
    const last = content.at(-1)
    if (last?.type === "text") last.content += suffix
    else content.push({ type: "text", content: suffix, start: 0, end: 0 })
    let position = 0
    const next: Prompt = [...content.map((part) => {
      const start = position
      position += part.content.length
      return { ...part, start, end: position }
    }), ...promptAttachments()]
    prompt.set(next, promptLength(next))
  }

  const focusEditorEnd = () => {
    requestAnimationFrame(() => focusEditor(promptLength(prompt.current())))
  }

  const currentCursor = () => {
    return getCursorPositionOrNull(editorRef)
  }

  const restoreFocus = () => {
    requestAnimationFrame(() => focusEditor())
  }

  const persistCurrentCursor = () => {
    const cursor = currentCursor()
    if (cursor === null) return
    const nextCursor = clampCursor(cursor, prompt.current())
    if (nextCursor === prompt.cursor()) return
    prompt.set(prompt.current(), nextCursor)
  }

  const renderEditorWithCursor = (parts: Prompt) => {
    const cursor = currentCursor() ?? prompt.cursor()
    renderEditor(parts)
    if (cursor !== undefined && editorRef.contains(document.activeElement))
      setCursorPosition(editorRef, clampCursor(cursor, parts))
  }

  createEffect(() => {
    props.controls.session.id
    if (props.controls.session.id) return
    if (!suggest()) return
    const interval = setInterval(() => {
      setStore("placeholder", (prev) => (prev + 1) % EXAMPLES.length)
    }, 6500)
    onCleanup(() => clearInterval(interval))
  })

  const [composing, setComposing] = createSignal(false)
  const isImeComposing = (event: KeyboardEvent) => event.isComposing || composing() || event.keyCode === 229

  const handleBlur = () => {
    persistCurrentCursor()
    closePopover()
    setComposing(false)
  }

  const handleCompositionStart = () => {
    setComposing(true)
  }

  const handleCompositionEnd = () => {
    setComposing(false)
    requestAnimationFrame(() => {
      if (composing()) return
      reconcile(prompt.current().filter((part) => part.type !== "image"))
    })
  }

  const agentList = createMemo(() =>
    props.controls.agents.available
      .filter((agent) => !agent.hidden && agent.mode !== "primary")
      .map((agent): AtOption => ({ type: "agent", name: agent.name, display: agent.name })),
  )

  const handleAtSelect = (option: AtOption | undefined) => {
    if (!option) return
    if (option.type === "agent") {
      addPart({ type: "agent", name: option.name, content: "@" + option.name, start: 0, end: 0 })
    } else {
      addPart({ type: "file", path: option.path, content: "@" + option.path, start: 0, end: 0 })
    }
  }

  const atKey = (x: AtOption | undefined) => {
    if (!x) return ""
    return x.type === "agent" ? `agent:${x.name}` : `file:${x.path}`
  }

  const {
    flat: atFlat,
    active: atActive,
    setActive: setAtActive,
    onInput: atOnInput,
    onKeyDown: atOnKeyDown,
  } = useFilteredList<AtOption>({
    items: async (query) => {
      const agents = agentList()
      const open = recent()
      const seen = new Set(open)
      const pinned: AtOption[] = open.map((path) => ({ type: "file", path, display: path, recent: true }))
      if (!query.trim()) return [...agents, ...pinned]
      const paths = await files.searchFilesAndDirectories(query)
      const fileOptions: AtOption[] = paths
        .filter((path) => !seen.has(path))
        .map((path) => ({ type: "file", path, display: path }))
      return [...agents, ...pinned, ...fileOptions]
    },
    key: atKey,
    filterKeys: ["display"],
    skipFilter: (item) => item.type === "file" && !item.recent,
    groupBy: (item) => {
      if (item.type === "agent") return "agent"
      if (item.recent) return "recent"
      return "file"
    },
    sortGroupsBy: (a, b) => {
      const rank = (category: string) => {
        if (category === "agent") return 0
        if (category === "recent") return 1
        return 2
      }
      return rank(a.category) - rank(b.category)
    },
    onSelect: handleAtSelect,
  })

  const slashCommands = createMemo<SlashCommand[]>(() => {
    const builtin = command.options
      .filter((opt) => !opt.disabled && !opt.id.startsWith("suggested.") && opt.slash)
      .map((opt) => ({
        id: opt.id,
        trigger: opt.slash!,
        title: opt.title,
        description: opt.description,
        keybind: opt.keybind,
        type: "builtin" as const,
      }))

    const custom = sync()
      .data.command.filter((cmd) => !(cmd.name === "goal" && builtin.some((item) => item.trigger === cmd.name)))
      .map(commandToSlashCommand)
      .filter((cmd) =>
        supportsSlashCommand(
          cmd,
          props.controls.agents.available.find((agent) => agent.name === props.controls.agents.current),
        ),
      )

    return [...custom, ...builtin]
  })
  const knownSlashCommands = createMemo(() => new Set(slashCommands().map((item) => item.trigger)))

  const modelFromCommand = (cmd: SlashCommand) => {
    if (!cmd.model) return
    const [providerID, ...modelID] = cmd.model.split("/")
    if (!providerID || modelID.length === 0) return
    return { providerID, modelID: modelID.join("/") }
  }

  const findModel = (model: { providerID: string; modelID: string } | undefined) => {
    if (!model) return props.controls.model.selection.current()
    return props.controls.model.selection
      .list()
      .find((item) => item.provider.id === model.providerID && item.id === model.modelID)
  }

  const clearTemporarySelection = (notify?: boolean) => {
    if (!store.temporarySelection) return false
    props.controls.selection.clearTemporary()
    setStore("temporarySelection", undefined)
    if (notify) {
      showToast({
        title: language.t("prompt.toast.skillOverrideRestored.title"),
        variant: "success",
      })
    }
    return true
  }

  const applyTemporarySelection = (cmd: SlashCommand) => {
    if (!cmd.agent && !cmd.model && !cmd.variant) return

    const nextModel = modelFromCommand(cmd)
    const targetModel = findModel(nextModel)
    const variants = targetModel?.variants ? Object.keys(targetModel.variants) : []
    if ((nextModel && !targetModel) || (cmd.agent && !props.controls.agents.options.includes(cmd.agent))) {
      showToast({
        title: language.t("prompt.toast.skillOverrideUnavailable.title"),
        description: language.t("prompt.toast.skillOverrideUnavailable.description"),
      })
      return
    }
    if (cmd.variant && variants.length > 0 && !variants.includes(cmd.variant)) {
      showToast({
        title: language.t("prompt.toast.skillOverrideUnavailable.title"),
        description: language.t("prompt.toast.skillOverrideUnavailable.description"),
      })
      return
    }

    clearTemporarySelection(false)
    const snapshot = props.controls.selection.snapshot()
    props.controls.selection.applyTemporary({
      ...(cmd.agent ? { agent: cmd.agent } : {}),
      ...(nextModel ? { model: nextModel } : {}),
      variant: cmd.variant ?? (nextModel ? null : snapshot.variant),
    })
    setStore("temporarySelection", { trigger: cmd.trigger, snapshot })
    showToast({
      title: language.t("prompt.toast.skillOverride.title"),
      description: language.t("prompt.toast.skillOverride.description"),
      duration: 5000,
    })
  }

  const handleSlashSelect = (cmd: SlashCommand | undefined) => {
    if (!cmd) return
    const images = promptAttachments()

    if (cmd.type === "custom") {
      const full = prompt
        .current()
        .map((part) => ("content" in part ? part.content : ""))
        .join("")
      const cursor = clampCursor(currentCursor() ?? prompt.cursor() ?? full.length, prompt.current())
      const before = full.slice(0, cursor)
      const search = slashSearchContext(full, cursor)
      const token = search ? undefined : before.match(/(?:^|\s)\/(\S*)$/)
      const slashAt = search ? search.slashAt : token ? token.index! + token[0].length - token[1].length - 1 : cursor
      const suffixBeforeCursor = search ? normalizeSlashSuffix(before.slice(search.tokenEnd)) : ""
      const suffixAfterCursor = full.slice(cursor)
      const spacer = !suffixBeforeCursor && !/^\s/.test(suffixAfterCursor) ? " " : ""
      const inserted = `/${cmd.trigger}${spacer}${suffixBeforeCursor}`
      const text = full.slice(0, slashAt) + inserted + suffixAfterCursor
      const nextCursor = slashAt + inserted.length
      closePopover()
      setEditorText(text)
      setCursorPosition(editorRef, nextCursor)
      prompt.set([{ type: "text", content: text, start: 0, end: text.length }, ...images], nextCursor)
      applyTemporarySelection(cmd)
      requestAnimationFrame(() => {
        if (
          prompt
            .current()
            .map((part) => ("content" in part ? part.content : ""))
            .join("") !== text
        )
          return
        focusEditor(nextCursor, [{ type: "text", content: text, start: 0, end: text.length }, ...images])
      })
      return
    }

    closePopover()
    clearEditor()
    prompt.set([...DEFAULT_PROMPT, ...images], 0)
    command.trigger(cmd.id, "slash")
  }

  const {
    flat: slashFlat,
    active: slashActive,
    setActive: setSlashActive,
    onInput: slashOnInput,
    onKeyDown: slashOnKeyDown,
  } = useFilteredList<SlashCommand>({
    items: () => searchSlashCommands(slashCommands(), store.slashSearch),
    key: (x) => x?.id,
    // Slash results are already ranked into direct and extended matches above.
    skipFilter: () => true,
    onSelect: handleSlashSelect,
  })

  const shouldSubmitExactSlashSearch = () => {
    const search = store.slashSearch
    if (!search?.rest) return false
    const active = slashFlat().find((cmd) => cmd.id === slashActive()) ?? slashFlat()[0]
    return active?.match === "direct" && active.trigger.toLowerCase() === search.token.toLowerCase()
  }

  const createPill = (part: FileAttachmentPart | AgentPart) => {
    const pill = document.createElement("span")
    pill.textContent = part.content
    pill.setAttribute("data-type", part.type)
    if (part.type === "file") pill.setAttribute("data-path", part.path)
    if (part.type === "agent") pill.setAttribute("data-name", part.name)
    pill.setAttribute("contenteditable", "false")
    pill.style.userSelect = "text"
    pill.style.cursor = "default"
    return pill
  }

  const createEditorTextFragment = (content: string) => {
    const ranges = findSlashCommandRanges(content, knownSlashCommands())
    if (ranges.length === 0) return createTextFragment(content)
    const fragment = document.createDocumentFragment()
    let cursor = 0
    ranges.forEach((range) => {
      fragment.appendChild(createTextFragment(content.slice(cursor, range.start)))
      const command = document.createElement("span")
      command.dataset.type = "slash-command"
      command.textContent = content.slice(range.start, range.end)
      fragment.appendChild(command)
      cursor = range.end
    })
    fragment.appendChild(createTextFragment(content.slice(cursor)))
    return fragment
  }

  const isNormalizedNode = (node: Node): boolean => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? ""
      if (!text.includes("\u200B")) return true
      if (text !== "\u200B") return false

      const prev = node.previousSibling
      const next = node.nextSibling
      const prevIsBr = prev?.nodeType === Node.ELEMENT_NODE && (prev as HTMLElement).tagName === "BR"
      return !!prevIsBr && !next
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return false
    const el = node as HTMLElement
    if (el.dataset.type === "file") return true
    if (el.dataset.type === "agent") return true
    if (el.dataset.type === "slash-command") return Array.from(el.childNodes).every(isNormalizedNode)
    if (el.tagName === "BR") return true
    if (el.tagName === "DIV" || el.tagName === "P") return Array.from(el.childNodes).every(isNormalizedNode)
    return false
  }

  const isNormalizedEditor = (parts: Prompt) => {
    if (!Array.from(editorRef.childNodes).every(isNormalizedNode)) return false
    const text = parts.map((part) => ("content" in part ? part.content : "")).join("")
    const expected = findSlashCommandRanges(text, knownSlashCommands()).map((range) => text.slice(range.start, range.end))
    const actual = Array.from(editorRef.querySelectorAll<HTMLElement>('[data-type="slash-command"]')).map(
      (element) => element.textContent ?? "",
    )
    return expected.length === actual.length && expected.every((command, index) => command === actual[index])
  }

  const renderEditor = (parts: Prompt) => {
    clearEditor()
    for (const part of parts) {
      if (part.type === "text") {
        editorRef.appendChild(createEditorTextFragment(part.content))
        continue
      }
      if (part.type === "file" || part.type === "agent") {
        editorRef.appendChild(createPill(part))
      }
    }

    const last = editorRef.lastChild
    if (last?.nodeType === Node.ELEMENT_NODE && (last as HTMLElement).tagName === "BR") {
      editorRef.appendChild(document.createTextNode("\u200B"))
    }
  }

  // Auto-scroll active command into view when navigating with keyboard
  createEffect(() => {
    const activeId = slashActive()
    if (!activeId || !slashPopoverRef) return

    requestAnimationFrame(() => {
      const element = slashPopoverRef.querySelector(`[data-slash-id="${activeId}"]`)
      element?.scrollIntoView({ block: "nearest", behavior: "smooth" })
    })
  })
  const selectPopoverActive = () => {
    if (store.popover === "at") {
      const items = atFlat()
      if (items.length === 0) return
      const active = atActive()
      const item = items.find((entry) => atKey(entry) === active) ?? items[0]
      handleAtSelect(item)
      return
    }

    if (store.popover === "slash") {
      const items = slashFlat()
      if (items.length === 0) return
      const active = slashActive()
      const item = items.find((entry) => entry.id === active) ?? items[0]
      handleSlashSelect(item)
    }
  }

  const reconcile = (input: Prompt) => {
    if (mirror.input) {
      mirror.input = false
      if (isNormalizedEditor(input)) return

      renderEditorWithCursor(input)
      return
    }

    const dom = parseFromDOM()
    if (isNormalizedEditor(input) && isPromptEqual(input, dom)) return

    renderEditorWithCursor(input)
  }

  createEffect(
    on(
      () => prompt.current(),
      (parts) => {
        if (composing()) return
        reconcile(parts.filter((part) => part.type !== "image"))
      },
    ),
  )

  const parseFromDOM = (): Prompt => {
    const parts: Prompt = []
    let position = 0
    let buffer = ""

    const flushText = () => {
      let content = buffer
      if (content.includes("\r")) content = content.replace(/\r\n?/g, "\n")
      if (content.includes("\u00A0")) content = content.replace(/\u00A0/g, " ")
      if (content.includes("\u200B")) content = content.replace(/\u200B/g, "")
      buffer = ""
      if (!content) return
      parts.push({ type: "text", content, start: position, end: position + content.length })
      position += content.length
    }

    const pushFile = (file: HTMLElement) => {
      const content = file.textContent ?? ""
      parts.push({
        type: "file",
        path: file.dataset.path!,
        content,
        start: position,
        end: position + content.length,
      })
      position += content.length
    }

    const pushAgent = (agent: HTMLElement) => {
      const content = agent.textContent ?? ""
      parts.push({
        type: "agent",
        name: agent.dataset.name!,
        content,
        start: position,
        end: position + content.length,
      })
      position += content.length
    }

    const visit = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        buffer += node.textContent ?? ""
        return
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return

      const el = node as HTMLElement
      if (el.dataset.type === "file") {
        flushText()
        pushFile(el)
        return
      }
      if (el.dataset.type === "agent") {
        flushText()
        pushAgent(el)
        return
      }
      if (el.tagName === "BR") {
        if (isPlaceholderBreak(el)) return
        buffer += "\n"
        return
      }

      for (const child of Array.from(el.childNodes)) {
        visit(child)
      }
    }

    const children = Array.from(editorRef.childNodes)
    children.forEach((child, index) => {
      const isBlock = child.nodeType === Node.ELEMENT_NODE && ["DIV", "P"].includes((child as HTMLElement).tagName)
      visit(child)
      if (isBlock && index < children.length - 1) {
        buffer += "\n"
      }
    })

    flushText()

    if (parts.length === 0) parts.push(...DEFAULT_PROMPT)
    return parts
  }

  createEffect(
    on(
      knownSlashCommands,
      () => {
        if (composing()) return
        reconcile(prompt.current().filter((part) => part.type !== "image"))
      },
      { defer: true },
    ),
  )

  const handleInput = () => {
    const rawParts = parseFromDOM()
    const images = promptAttachments()
    const cursorPosition = clampCursor(currentCursor() ?? prompt.cursor() ?? promptLength(rawParts), rawParts)
    const rawText =
      rawParts.length === 1 && rawParts[0]?.type === "text"
        ? rawParts[0].content
        : rawParts.map((p) => ("content" in p ? p.content : "")).join("")
    const hasNonText = rawParts.some((part) => part.type !== "text")
    const textContent = (editorRef.textContent ?? "").replace(/\u200B/g, "")
    const shouldReset =
      textContent.length === 0 && rawText.replace(/\n/g, "").length === 0 && !hasNonText && images.length === 0

    if (shouldReset) {
      closePopover()
      resetHistoryNavigation()
      if (prompt.dirty()) {
        mirror.input = true
        prompt.set(DEFAULT_PROMPT, 0)
      }
      queueScroll()
      return
    }

    const shellMode = store.mode === "shell"

    if (!shellMode) {
      const atMatch = rawText.substring(0, cursorPosition).match(/@(\S*)$/)
      const slashSearch = slashSearchContext(rawText, cursorPosition)

      if (atMatch) {
        atOnInput(atMatch[1])
        setStore("slashSearch", undefined)
        setStore("popover", "at")
      } else if (slashSearch) {
        setStore("slashSearch", slashSearch)
        slashOnInput(slashSearch.query)
        setStore("popover", "slash")
      } else {
        closePopover()
      }
    } else {
      closePopover()
    }

    resetHistoryNavigation()

    mirror.input = true
    prompt.set([...rawParts, ...images], cursorPosition)
    queueScroll()
  }

  const addPart = (part: ContentPart) => {
    if (part.type === "image") return false

    const selection = window.getSelection()
    if (!selection) return false

    if (selection.rangeCount === 0 || !editorRef.contains(selection.anchorNode)) {
      focusEditor()
    }

    if (selection.rangeCount === 0) return false
    const range = selection.getRangeAt(0)
    if (!editorRef.contains(range.startContainer)) return false

    if (part.type === "file" || part.type === "agent") {
      const cursorPosition = clampCursor(
        currentCursor() ?? prompt.cursor() ?? promptLength(prompt.current()),
        prompt.current(),
      )
      const rawText = prompt
        .current()
        .map((p) => ("content" in p ? p.content : ""))
        .join("")
      const textBeforeCursor = rawText.substring(0, cursorPosition)
      const atMatch = textBeforeCursor.match(/@(\S*)$/)
      const pill = createPill(part)
      const gap = document.createTextNode(" ")

      if (atMatch) {
        const start = atMatch.index ?? cursorPosition - atMatch[0].length
        setRangeEdge(editorRef, range, "start", start)
        setRangeEdge(editorRef, range, "end", cursorPosition)
      }

      range.deleteContents()
      range.insertNode(gap)
      range.insertNode(pill)
      range.setStartAfter(gap)
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
    }

    if (part.type === "text") {
      const fragment = createTextFragment(part.content)
      const last = fragment.lastChild
      range.deleteContents()
      range.insertNode(fragment)
      if (last) {
        if (last.nodeType === Node.TEXT_NODE) {
          const text = last.textContent ?? ""
          if (text === "\u200B") {
            range.setStart(last, 0)
          }
          if (text !== "\u200B") {
            range.setStart(last, text.length)
          }
        }
        if (last.nodeType !== Node.TEXT_NODE) {
          const isBreak = last.nodeType === Node.ELEMENT_NODE && (last as HTMLElement).tagName === "BR"
          const next = last.nextSibling
          const emptyText = next?.nodeType === Node.TEXT_NODE && (next.textContent ?? "") === ""
          if (isBreak && (!next || emptyText)) {
            const placeholder = next && emptyText ? next : document.createTextNode("\u200B")
            if (!next) last.parentNode?.insertBefore(placeholder, null)
            placeholder.textContent = "\u200B"
            range.setStart(placeholder, 0)
          } else {
            range.setStartAfter(last)
          }
        }
      }
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
    }

    handleInput()
    closePopover()
    return true
  }

  const addToHistory = (prompt: Prompt, mode: "normal" | "shell") => {
    history.add(prompt, mode, mode === "shell" ? [] : historyComments())
  }

  createEffect(
    on(
      () => props.edit?.id,
      (id) => {
        const edit = props.edit
        if (!id || !edit) return

        for (const item of prompt.context.items()) {
          prompt.context.remove(item.key)
        }

        for (const item of edit.context) {
          prompt.context.add({
            type: item.type,
            path: item.path,
            selection: item.selection,
            comment: item.comment,
            commentID: item.commentID,
            commentOrigin: item.commentOrigin,
            preview: item.preview,
          })
        }

        setStore("mode", "normal")
        setStore("popover", null)
        setStore("historyIndex", -1)
        setStore("savedPrompt", null)
        prompt.set(edit.prompt, promptLength(edit.prompt))
        requestAnimationFrame(() => {
          focusEditor(promptLength(edit.prompt), edit.prompt)
        })
        props.onEditLoaded?.()
      },
      { defer: true },
    ),
  )

  const navigateHistory = (direction: "up" | "down") => {
    const result = navigatePromptHistory({
      direction,
      entries: history.entries(store.mode),
      historyIndex: store.historyIndex,
      currentPrompt: prompt.current(),
      currentComments: historyComments(),
      savedPrompt: store.savedPrompt,
    })
    if (!result.handled) return false
    setStore("historyIndex", result.historyIndex)
    setStore("savedPrompt", result.savedPrompt)
    applyHistoryPrompt(result.entry, result.cursor)
    return true
  }

  const { addAttachment, addAttachments, removeAttachment, handlePaste } = createPromptAttachments({
    prompt,
    editor: () => editorRef,
    isDialogActive: () => !!dialog.active,
    setDraggingType: (type) => setStore("draggingType", type),
    focusEditor: () => {
      focusEditor(promptLength(prompt.current()))
    },
    addPart,
    readClipboardImage: platform.readClipboardImage,
    getPathForFile: platform.getPathForFile,
  })

  const fileAttachmentInput = () => (
    <input
      ref={(el) => (fileInputRef = el)}
      type="file"
      multiple
      accept={ACCEPTED_FILE_TYPES.join(",")}
      class="hidden"
      onChange={(e) => {
        const list = e.currentTarget.files
        if (list) void addAttachments(Array.from(list))
        e.currentTarget.value = ""
      }}
    />
  )

  const variants = createMemo(() => ["default", ...props.controls.model.selection.variant.list()])
  // Check provider variants directly: `variants` also includes the UI-only default option.
  const showVariantControl = createMemo(() => props.controls.model.selection.variant.list().length > 0)
  const accessControlState = createMemo<ComposerAccessControlState>(() => {
    const profile = permission.accessControlProfile(props.controls.session.id, sdk().directory)
    return {
      mode: profile.mode,
      style: control(),
      updateProjectDefault: permission.accessControlUpdateProjectDefault(),
      updateUserDefault: permission.accessControlUpdateUserDefault(),
      onModeSelect: (mode) => {
        permission.setAccessControlMode({ sessionID: props.controls.session.id, directory: sdk().directory, mode })
        restoreFocus()
      },
      onUpdateProjectDefault: (value) => {
        permission.setAccessControlUpdateProjectDefault(value)
        if (!value) return
        permission.setAccessControlMode({
          sessionID: props.controls.session.id,
          directory: sdk().directory,
          mode: profile.mode,
        })
      },
      onUpdateUserDefault: (value) => {
        permission.setAccessControlUpdateUserDefault(value)
        if (!value) return
        permission.setAccessControlMode({
          sessionID: props.controls.session.id,
          directory: sdk().directory,
          mode: profile.mode,
        })
      },
    }
  })

  const submission =
    props.submission ??
    createPromptSubmit({
      beforeSubmit: async (context) => {
        const result = await composerRegistry.runBeforeSubmit({
          serverID: server.key,
          directory: context.directory,
          sessionID: context.sessionID,
          composerID,
        }, context)
        if (!result.ok && result.error) showToast({ variant: "error", title: "Prompt not sent", description: result.error })
        return result.ok
      },
      prompt,
      info,
      imageAttachments: promptAttachments,
      commentCount,
      mode: () => store.mode,
      working,
      editor: () => editorRef,
      queueScroll,
      promptLength,
      addToHistory,
      resetHistoryNavigation: () => {
        resetHistoryNavigation(true)
      },
      setMode: (mode) => setStore("mode", mode),
      setPopover: (popover) => setStore("popover", popover),
      draftID: () => props.draftID,
      newSessionWorktree: () => props.newSessionWorktree,
      onNewSessionWorktreeReset: props.onNewSessionWorktreeReset,
      shouldQueue: props.shouldQueue,
      onQueue: props.onQueue,
      forceSteer: props.forceSteer,
      onForceSteerSent: props.onForceSteerSent,
      onGoal: props.onGoal,
      onAbort: props.onAbort,
      onSubmit: props.onSubmit,
    })
  const abort = submission.abort
  const handleSubmit = submission.handleSubmit

  createEffect(() => {
    const target = {
      serverID: server.key,
      directory: props.controls.projects.directory,
      sessionID: props.controls.session.id,
      composerID,
    }
    onCleanup(composerRegistry.register(target, {
      read: () => ({
        directory: props.controls.projects.directory,
        sessionID: props.controls.session.id,
        composerID,
        text: promptText(),
        mode: store.mode,
        model: ((model) => model ? `${model.provider.id}/${model.id}` : undefined)(props.controls.model.selection.current()),
      }),
      change: setPromptText,
      appendText: appendPromptText,
      insertText(input) {
        if (store.mode !== "normal") return { ok: false, error: "Composer is not available for text insertion" }
        const inserted = insertPromptDraft(
          prompt,
          input,
          promptInsertionIdentity({
            serverID: server.key,
            directory: props.controls.projects.directory,
            sessionID: props.controls.session.id,
            composerID,
          }),
        )
        if (inserted.ok) requestAnimationFrame(() => focusEditor())
        return inserted
      },
      async submitText(text) {
        if (props.disabled) return { ok: false, error: "Composer is disabled" }
        if (store.mode !== "normal") return { ok: false, error: "Continue is only available in normal composer mode" }
        if (submitPending()) return { ok: false, error: "Composer submission is already in progress" }
        if (!blank() || prompt.context.items().length > 0) return { ok: false, error: "Send or clear the current draft before continuing" }
        if (!submission.submitText) return { ok: false, error: "Composer is not available for submission" }
        setSubmitPending(true)
        return submission.submitText({ text, delivery: "steer" })
          .catch((error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))
          .finally(() => setSubmitPending(false))
      },
    }))
  })

  onCleanup(() => {
    if (submitOverlayTimer !== undefined) window.clearTimeout(submitOverlayTimer)
  })

  const submit = preventNativeSubmit((event: Event, options?: PromptSubmitOptions) => {
    if (props.disabled) {
      return Promise.resolve()
    }
    if (submitPending()) return Promise.resolve()

    // An empty idle composer submit restarts the last agent run, mirroring the Enter-key behavior.
    if (!options?.resume && blank() && !working() && resumeLastPrompt(event)) return Promise.resolve()

    handleInput()
    setSubmitPending(true)
    setShowSubmitOverlay(false)
    submitOverlayTimer = window.setTimeout(() => {
      setShowSubmitOverlay(true)
    }, 3000)

    const result = Promise.resolve(handleSubmit(event, options)).finally(() => {
      if (submitOverlayTimer !== undefined) {
        window.clearTimeout(submitOverlayTimer)
        submitOverlayTimer = undefined
      }
      setSubmitPending(false)
      setShowSubmitOverlay(false)
    })
    void result.then(() => clearTemporarySelection(false))
    return result
  })

  const resumeLastPrompt = (event: Event) => {
    const eligible = resumeLastPromptEntry({
      mode: store.mode,
      working: working(),
      historyIndex: store.historyIndex,
      hasSession: !!props.controls.session.id,
      blank: blank(),
      hasPendingContext: prompt.context.items().length > 0,
      entries: history.entries("normal"),
    })
    // An empty idle composer continues the last run instead of resending its full prompt.
    if (!eligible || !submission.submitText) return false
    void submission.submitText({ text: "Continue", delivery: "steer" })
    return true
  }
  const [toolbarCycleIndex, setToolbarCycleIndex] = createSignal(-1)
  const [toolbarCyclePending, setToolbarCyclePending] = createSignal(false)
  const [toolbarCycleMode, setToolbarCycleMode] = createSignal<"single" | "multi" | undefined>()
  const toolbarMultiSelected = new Set<HTMLElement>()
  let toolbarCycleElement: HTMLElement | undefined
  let toolbarCycleDoubleTapTimer: number | undefined
  let toolbarCycleSelectionTimer: number | undefined

  const toolbarCycleItems = () => {
    const form = editorRef.closest("form")
    if (!form) return []
    const mobileTrigger = form.querySelector<HTMLButtonElement>('[data-action="plugin-toolbar-more"]')
    if (mobileTrigger && mobileTrigger.getAttribute("aria-expanded") !== "true") mobileTrigger.click()
    const mobileMenu = document.getElementById(mobileTrigger?.getAttribute("aria-controls") ?? "")
    return [
      ...form.querySelectorAll<HTMLElement>(
        [
          '[data-component="plugin-toolbar-outlet"][data-plugin-toolbar-placement="composer"][data-plugin-toolbar-align="right"] button',
          '[data-component="plugin-toolbar-outlet"][data-plugin-toolbar-placement="composer"][data-plugin-toolbar-align="right"] [role="button"]',
          '[data-component="plugin-toolbar-outlet"][data-plugin-toolbar-placement="composer"][data-plugin-toolbar-align="right"] a[href]',
        ].join(", "),
      ),
      ...(mobileMenu?.querySelectorAll<HTMLElement>(
        [
          '[data-plugin-toolbar-align="right"] button',
          '[data-plugin-toolbar-align="right"] [role="button"]',
          '[data-plugin-toolbar-align="right"] a[href]',
        ].join(", "),
      ) ?? []),
    ]
      .filter((item, index, items) => items.indexOf(item) === index && item.offsetParent !== null)
      .toSorted((a, b) => {
        const aRect = a.getBoundingClientRect()
        const bRect = b.getBoundingClientRect()
        return aRect.top - bRect.top || aRect.left - bRect.left
      })
  }

  const isToolbarActionEnabled = (element: HTMLElement) => {
    if (element instanceof HTMLButtonElement && element.disabled) return false
    return element.getAttribute("aria-disabled") !== "true"
  }

  const toolbarCycleActions = () => toolbarCycleItems().filter(isToolbarActionEnabled)

  const setToolbarCycleElement = (element: HTMLElement | undefined) => {
    if (toolbarCycleElement && toolbarCycleElement !== element) {
      delete toolbarCycleElement.dataset.composerToolbarCycleActive
    }
    toolbarCycleElement = element
    if (!element) return
    element.dataset.composerToolbarCycleActive = "true"
    element.scrollIntoView({ block: "nearest", inline: "nearest" })
  }

  const clearToolbarCycleTimers = () => {
    if (toolbarCycleDoubleTapTimer !== undefined) {
      window.clearTimeout(toolbarCycleDoubleTapTimer)
      toolbarCycleDoubleTapTimer = undefined
    }
    if (toolbarCycleSelectionTimer !== undefined) {
      window.clearTimeout(toolbarCycleSelectionTimer)
      toolbarCycleSelectionTimer = undefined
    }
  }

  const resetToolbarCycle = () => {
    clearToolbarCycleTimers()
    setToolbarCycleElement(undefined)
    toolbarMultiSelected.forEach((element) => delete element.dataset.composerToolbarCycleSelected)
    toolbarMultiSelected.clear()
    setToolbarCycleIndex(-1)
    setToolbarCyclePending(false)
    setToolbarCycleMode(undefined)
    const form = editorRef.closest("form")
    const mobileTrigger = form?.querySelector<HTMLButtonElement>('[data-action="plugin-toolbar-more"]')
    if (mobileTrigger?.getAttribute("aria-expanded") === "true") mobileTrigger.click()
  }

  const startToolbarCycleSelectionTimeout = () => {
    if (toolbarCycleSelectionTimer !== undefined) {
      window.clearTimeout(toolbarCycleSelectionTimer)
      toolbarCycleSelectionTimer = undefined
    }
    if (toolbarCycleMode() === "multi") return
    toolbarCycleSelectionTimer = window.setTimeout(resetToolbarCycle, toolbarCycleSelectionTimeoutMs)
  }

  const isToolbarItemPressed = (element: HTMLElement) =>
    element.getAttribute("aria-pressed") === "true" || element.closest('[aria-pressed="true"]') !== null

  const isToolbarItemToggle = (element: HTMLElement) =>
    element.getAttribute("aria-pressed") !== null || element.closest("[aria-pressed]") !== null

  const selectToolbarMultiAction = (element: HTMLElement, index: number) => {
    setToolbarCycleIndex(index)
    setToolbarCycleElement(element)
    toolbarMultiSelected.add(element)
    element.dataset.composerToolbarCycleSelected = "true"
    if (isToolbarItemToggle(element) && !isToolbarItemPressed(element)) element.click()
    startToolbarCycleSelectionTimeout()
    return true
  }

  const activateToolbarMultiSelection = () => {
    const items = toolbarCycleItems()
    const currentIndex = toolbarCycleElement ? items.indexOf(toolbarCycleElement) : toolbarCycleIndex()
    const nextIndex = currentIndex >= 0 ? currentIndex + 1 : Math.max(toolbarCycleIndex(), 0)
    const element = items.slice(nextIndex).find(isToolbarActionEnabled)
    if (!element) {
      startToolbarCycleSelectionTimeout()
      return true
    }

    return selectToolbarMultiAction(element, toolbarCycleActions().indexOf(element))
  }

  const cycleToolbarAction = (mode: "single" | "multi") => {
    const actions = toolbarCycleActions()
    if (actions.length === 0) return false
    if (toolbarCycleMode() && toolbarCycleMode() !== mode) resetToolbarCycle()
    if (toolbarCycleIndex() < 0) {
      if (!toolbarCyclePending()) {
        setToolbarCycleMode(mode)
        setToolbarCyclePending(true)
        toolbarCycleDoubleTapTimer = window.setTimeout(resetToolbarCycle, toolbarCycleDoubleTapMs)
        return true
      }
      clearToolbarCycleTimers()
      setToolbarCycleMode(mode)
      setToolbarCyclePending(false)
      if (mode === "multi") return selectToolbarMultiAction(actions[0], 0)
      setToolbarCycleIndex(0)
      setToolbarCycleElement(actions[0])
      startToolbarCycleSelectionTimeout()
      return true
    }
    if (mode === "multi") return activateToolbarMultiSelection()
    const next = (toolbarCycleIndex() + 1) % actions.length
    setToolbarCycleIndex(next)
    setToolbarCycleElement(actions[next])
    startToolbarCycleSelectionTimeout()
    return true
  }

  const clickToolbarCycleSelection = () => {
    const element = toolbarCycleElement
    resetToolbarCycle()
    if (!element?.isConnected) return
    element.click()
  }

  const clickToolbarMultiReleaseSelection = () => {
    const selected = toolbarCycleItems().filter((element) => toolbarMultiSelected.has(element))
    resetToolbarCycle()
    selected.forEach((element) => {
      if (!element.isConnected || !isToolbarActionEnabled(element) || isToolbarItemToggle(element)) return
      element.click()
    })
  }

  type ToolbarKeybindModifier = "ctrl" | "meta" | "shift" | "alt"

  const toolbarKeybind = (id: string, fallback: string) => settings.keybinds.get(id) ?? fallback

  const matchesToolbarKey = (event: KeyboardEvent, id: string, fallback: string) =>
    matchKeybind(parseKeybind(toolbarKeybind(id, fallback)), event)

  const releasedKeybindModifier = (event: KeyboardEvent): ToolbarKeybindModifier | undefined => {
    if (event.key === "Control") return "ctrl"
    if (event.key === "Meta") return "meta"
    if (event.key === "Shift") return "shift"
    if (event.key === "Alt") return "alt"
  }

  const releasedToolbarModifier = (event: KeyboardEvent, mode: "single" | "multi") => {
    const modifier = releasedKeybindModifier(event)
    if (!modifier) return false
    return parseKeybind(
      mode === "single"
        ? toolbarKeybind("prompt.toolbar.cycle", toolbarCycleKey)
        : toolbarKeybind("prompt.toolbar.multiActivate", toolbarMultiActivateKey),
    ).some((keybind) => keybind[modifier])
  }

  onMount(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") return
      resetToolbarCycle()
    }
    const handleKeyUp = (event: KeyboardEvent) => {
      const mode = toolbarCycleMode()
      if (!mode || !releasedToolbarModifier(event, mode) || (!toolbarCyclePending() && toolbarCycleIndex() < 0)) return
      event.preventDefault()
      event.stopPropagation()
      if (mode === "multi") {
        clickToolbarMultiReleaseSelection()
        return
      }
      if (toolbarCycleIndex() < 0) {
        resetToolbarCycle()
        return
      }
      clickToolbarCycleSelection()
    }
    window.addEventListener("keyup", handleKeyUp, true)
    window.addEventListener("blur", resetToolbarCycle)
    document.addEventListener("visibilitychange", handleVisibilityChange)
    onCleanup(() => {
      resetToolbarCycle()
      window.removeEventListener("keyup", handleKeyUp, true)
      window.removeEventListener("blur", resetToolbarCycle)
      document.removeEventListener("visibilitychange", handleVisibilityChange)
    })
  })

  const handleKeyDown = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "u") {
      event.preventDefault()
      if (store.mode !== "normal") return
      pick()
      return
    }

    if (event.key === "Backspace") {
      const selection = window.getSelection()
      if (selection && selection.isCollapsed) {
        const node = selection.anchorNode
        const offset = selection.anchorOffset
        if (node && node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent ?? ""
          if (/^\u200B+$/.test(text) && offset > 0) {
            const range = document.createRange()
            range.setStart(node, 0)
            range.collapse(true)
            selection.removeAllRanges()
            selection.addRange(range)
          }
        }
      }
    }

    if (event.key === "!" && store.mode === "normal") {
      const cursorPosition = currentCursor()
      if (cursorPosition === 0) {
        setStore("mode", "shell")
        setStore("popover", null)
        event.preventDefault()
        return
      }
    }

    if (event.key === "Escape") {
      if (toolbarCyclePending() || toolbarCycleIndex() >= 0) {
        resetToolbarCycle()
        event.preventDefault()
        event.stopPropagation()
        return
      }

      if (store.popover) {
        closePopover()
        event.preventDefault()
        event.stopPropagation()
        return
      }

      if (store.mode === "shell") {
        setStore("mode", "normal")
        event.preventDefault()
        event.stopPropagation()
        return
      }

      if (clearTemporarySelection(true)) {
        event.preventDefault()
        event.stopPropagation()
        return
      }

      if (working()) {
        void abort()
        event.preventDefault()
        event.stopPropagation()
        return
      }

      if (escBlur()) {
        editorRef.blur()
        event.preventDefault()
        event.stopPropagation()
        return
      }
    }

    if (store.mode === "shell") {
      const { collapsed, cursorPosition, textLength } = getCaretState()
      if (event.key === "Backspace" && collapsed && cursorPosition === 0 && textLength === 0) {
        setStore("mode", "normal")
        event.preventDefault()
        return
      }
    }

    if (matchesToolbarKey(event, "prompt.toolbar.cycle", toolbarCycleKey) && !store.popover) {
      const handled = event.repeat ? toolbarCyclePending() || toolbarCycleIndex() >= 0 : cycleToolbarAction("single")
      if (handled) {
        event.preventDefault()
        event.stopPropagation()
        return
      }
    }

    if (matchesToolbarKey(event, "prompt.toolbar.multiActivate", toolbarMultiActivateKey) && !store.popover) {
      const handled = event.repeat ? toolbarCyclePending() || toolbarCycleIndex() >= 0 : cycleToolbarAction("multi")
      if (handled) {
        event.preventDefault()
        event.stopPropagation()
        return
      }
    }

    // Handle Shift+Enter BEFORE IME check - Shift+Enter is never used for IME input
    // and should always insert a newline regardless of composition state
    if (event.key === "Enter" && event.shiftKey) {
      addPart({ type: "text", content: "\n", start: 0, end: 0 })
      event.preventDefault()
      return
    }

    if (event.key === "Enter" && isImeComposing(event)) {
      return
    }

    const ctrl = event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey

    if (store.popover) {
      if (event.key === "Tab") {
        selectPopoverActive()
        event.preventDefault()
        return
      }
      const nav = event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Enter"
      const ctrlNav = ctrl && (event.key === "n" || event.key === "p")
      if (nav || ctrlNav) {
        if (store.popover === "at") {
          atOnKeyDown(event)
          event.preventDefault()
          return
        }
        if (store.popover === "slash") {
          if (event.key === "Enter" && shouldSubmitExactSlashSearch()) {
            closePopover()
          } else {
            slashOnKeyDown(event)
            event.preventDefault()
            return
          }
        } else {
          event.preventDefault()
          return
        }
      }
    }

    if (ctrl && event.code === "KeyG") {
      if (store.popover) {
        closePopover()
        event.preventDefault()
        return
      }
      if (working()) {
        void abort()
        event.preventDefault()
      }
      return
    }

    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      if (event.altKey || event.ctrlKey || event.metaKey) return
      const { collapsed } = getCaretState()
      if (!collapsed) return

      const cursorPosition = currentCursor()
      if (cursorPosition === null) return
      const textContent = prompt
        .current()
        .map((part) => ("content" in part ? part.content : ""))
        .join("")
      const direction = event.key === "ArrowUp" ? "up" : "down"
      if (!canNavigateHistoryAtCursor(direction, textContent, cursorPosition, store.historyIndex >= 0)) return
      // An empty idle composer restarts the last agent run instead of only loading history
      if (direction === "up" && !submitPending() && resumeLastPrompt(event)) {
        event.preventDefault()
        return
      }
      if (navigateHistory(direction)) {
        event.preventDefault()
      }
      return
    }

    // Note: Shift+Enter is handled earlier, before IME check
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      event.stopPropagation()
      if (event.repeat) return
      if (blank()) {
        if (working()) return
        // An empty idle composer restarts the last agent run instead of doing nothing
        if (resumeLastPrompt(event)) return
      }
      void submit(event)
    }
  }

  const agentsLoading = () => props.controls.agents.loading
  const agentsShouldFadeIn = createMemo((prev) => prev ?? agentsLoading())
  const providersLoading = () => props.controls.model.loading
  const providersShouldFadeIn = createMemo((prev) => prev ?? providersLoading())

  const [promptReady] = createResource(
    () => prompt.ready().promise,
    (p) => p,
  )

  const designPlaceholder = () => {
    if (store.mode === "shell") return placeholder()
    return "Ask anything, / for commands, @ for context..."
  }

  const selectedChainLabel = () => {
    const chain = props.controls.model.selection.chain.current()
    if (!chain) return
    return `${chain.name}: ${chain.steps.map((step) => {
      const model = props.controls.model.selection.list().find(
        (item) => item.provider.id === step.providerID && item.id === step.modelID,
      )
      return `${model?.name ?? `${step.providerID}/${step.modelID}`}${step.variant ? ` (${step.variant})` : ""}${model ? "" : " — unavailable"}`
    }).join(" → ")}`
  }

  const modelControlState = createMemo<ComposerModelControlState>(() => ({
    loading: providersLoading(),
    paid: props.controls.model.paid,
    error: props.controls.model.error,
    retrying: props.controls.model.retrying,
    onRetry: props.controls.model.retry,
    title: selectedChainLabel() ?? language.t("command.model.choose"),
    keybind: command.keybind("model.choose"),
    model: props.controls.model.selection,
    providerID: props.controls.model.selection.current()?.provider?.id,
    modelName: selectedChainLabel() ?? props.controls.model.selection.current()?.name ?? language.t("dialog.model.select.title"),
    style: control(),
    onClose: restoreFocus,
    onUnpaidClick: () => {
      void import("@/components/dialog-select-model-unpaid").then((x) => {
        dialog.show(() => <x.DialogSelectModelUnpaid model={props.controls.model.selection} />)
      })
    },
  }))

  const newSession = () => props.variant === "new-session"
  const projects = createMemo(() => props.controls.projects.available)
  const projectForDirectory = (directory: string | undefined) => {
    if (!directory) return
    const key = pathKey(directory)
    return projects().find(
      (project) => pathKey(project.worktree) === key || project.sandboxes?.some((sandbox) => pathKey(sandbox) === key),
    )
  }
  const projectAvatar = (project: ReturnType<typeof projects>[number]) => (
    <ProjectAvatar
      fallback={displayName(project)}
      src={getProjectAvatarSource(project.id, project.icon)}
      monochrome={getProjectAvatarMonochrome(project.id)}
      variant={getProjectAvatarVariant(project.icon?.color)}
    />
  )
  const selectedProject = createMemo(() => projectForDirectory(props.controls.projects.directory))
  const projectResults = createMemo(() => {
    const search = picker.projectSearch.trim().toLowerCase()
    if (!search) return projects()
    return projects().filter((project) => displayName(project).toLowerCase().includes(search))
  })
  const showAgentControl = createMemo(() => props.controls.agents.options.length > 0)
  const selectProject = (worktree: string) => {
    setPicker({
      projectOpen: false,
      projectSearch: "",
    })
    if (pathKey(worktree) === pathKey(selectedProject()?.worktree ?? "")) {
      restoreFocus()
      return
    }
    props.controls.projects.select(worktree)
    restoreFocus()
  }
  const addProject = () => {
    props.controls.projects.add(language.t("command.project.open"))
  }

  const projectPickerState = createMemo<ComposerPickerState>(() => ({
    open: picker.projectOpen,
    trigger: {
      action: "prompt-project",
      avatar: selectedProject() ? projectAvatar(selectedProject()!) : undefined,
      label: selectedProject() ? displayName(selectedProject()!) : language.t("session.new.project.new"),
      class: "max-w-[203px]",
      style: control(),
      disabled: props.controls.projects.disabled,
      onPress: () => setPicker("projectOpen", true),
    },
    search: picker.projectSearch,
    searchPlaceholder: language.t("session.new.project.search"),
    clearLabel: language.t("common.clear"),
    items: projectResults().map((project) => ({
      avatar: projectAvatar(project),
      label: displayName(project),
      selected: selectedProject()?.worktree === project.worktree,
      onSelect: () => selectProject(project.worktree),
    })),
    action: {
      icon: "plus",
      label: language.t("session.new.project.add"),
      onSelect: () => {
        setPicker("projectOpen", false)
        void addProject()
      },
    },
    onOpenChange: (open) => {
      setPicker("projectOpen", open)
      if (open) requestAnimationFrame(() => projectSearchRef?.focus())
    },
    onSearchInput: (value) => setPicker("projectSearch", value),
    onSearchClear: () => setPicker("projectSearch", ""),
    searchRef: (el) => (projectSearchRef = el),
  }))
  const selectAgentFromSettings = (agent: string) => {
    if (!props.controls.agents.options.includes(agent)) return
    props.controls.agents.select(agent)
  }
  const agentControlState = createMemo<ComposerAgentControlState>(() => ({
    title: language.t("command.agent.cycle"),
    keybind: command.keybind("agent.cycle"),
    options: props.controls.agents.options,
    current: props.controls.agents.current,
    open: store.agentOpen,
    style: control(),
    onOpenChange: (open) => {
      setStore("agentOpen", open)
      if (open) void props.controls.agents.refresh()
    },
    onSelect: (value) => {
      if (!store.agentOpen) return
      props.controls.agents.select(value)
      restoreFocus()
    },
    onConfigure: (agent) => {
      void import("@/components/settings-v2").then((settings) => {
        dialog.show(() => (
          <settings.DialogSettings
            initialTab="agents"
            initialAgent={agent}
            initialDirectory={sdk().directory}
            onAgentSelect={selectAgentFromSettings}
          />
        ))
      })
    },
    onCreate: () => {
      void import("@/components/settings-v2").then((settings) => {
        dialog.show(() => (
          <settings.DialogSettings
            initialTab="agents"
            createAgent
            initialDirectory={sdk().directory}
            onAgentSelect={selectAgentFromSettings}
          />
        ))
      })
    },
  }))
  return (
    <div
      class="relative size-full flex flex-col gap-0"
      style={{
        "--composer-slash-command-color":
          settings.appearance.slashCommandColor(theme.themeId(), theme.mode()) ??
          slashCommandColorDefaults[theme.mode()],
      }}
    >
      {(promptReady(), null)}
      <AttachmentPreviewOverlay attachment={activePromptAttachment()} onClose={() => setActivePromptAttachment(null)} />
      <PromptPopover
        popover={store.popover}
        setSlashPopoverRef={(el) => (slashPopoverRef = el)}
        atFlat={atFlat()}
        atActive={atActive() ?? undefined}
        atKey={atKey}
        setAtActive={setAtActive}
        onAtSelect={handleAtSelect}
        slashFlat={slashFlat()}
        slashActive={slashActive() ?? undefined}
        setSlashActive={setSlashActive}
        onSlashSelect={handleSlashSelect}
        commandKeybind={command.keybind}
        t={(key) => language.t(key as Parameters<typeof language.t>[0])}
      />
      <div class="flex flex-col gap-3">
        <DockShellForm
          data-component={newSession() ? "session-new-composer" : "session-composer"}
          onSubmit={submit}
          classList={{
            "group/prompt-input relative min-h-[96px] w-full rounded-xl bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]": true,
            "border-icon-info-active border-dashed": store.draggingType !== null,
            [props.class ?? ""]: !!props.class,
          }}
        >
          <PromptDragOverlay
            type={store.draggingType}
            label={language.t(
              store.draggingType === "@mention" ? "prompt.dropzone.file.label" : "prompt.dropzone.label",
            )}
          />
          <PromptSubmitOverlay visible={showSubmitOverlay()} />
          <PromptContextItems
            items={contextItems()}
            active={(item) => {
              const active = comments.active()
              return !!item.commentID && item.commentID === active?.id && item.path === active?.file
            }}
            openComment={openComment}
            remove={(item) => {
              if (item.commentID) comments.remove(item.path, item.commentID)
              prompt.context.remove(item.key)
            }}
            t={(key) => language.t(key as Parameters<typeof language.t>[0])}
          />
          <PromptAttachments
            attachments={promptAttachments()}
            onOpen={openPromptAttachment}
            onRemove={removeAttachment}
            removeLabel={language.t("prompt.attachment.remove")}
          />
          <div
            class="relative min-h-[52px]"
            onMouseDown={(e) => {
              const target = e.target
              if (!(target instanceof Node)) return
              const element = target instanceof Element ? target : undefined
              if (element?.closest('[data-action^="prompt-"]')) return
              if (editorRef.contains(target)) {
                editorRef.focus({ preventScroll: true })
                return
              }
              focusEditor()
            }}
          >
            <div class="relative max-h-[180px] overflow-y-auto no-scrollbar" ref={(el) => (scrollRef = el)}>
              <div
                data-component="prompt-input"
                data-session-id={props.controls.session.id}
                ref={bindEditorRef}
                role="textbox"
                aria-multiline="true"
                aria-label={designPlaceholder()}
                contenteditable="true"
                autocapitalize={store.mode === "normal" ? "sentences" : "off"}
                autocorrect={store.mode === "normal" ? "on" : "off"}
                spellcheck={store.mode === "normal"}
                inputMode="text"
                // @ts-expect-error
                autocomplete="off"
                onInput={handleInput}
                onPaste={handlePaste}
                onCompositionStart={handleCompositionStart}
                onCompositionEnd={handleCompositionEnd}
                onBlur={handleBlur}
                onKeyDown={handleKeyDown}
                classList={{
                  "select-text": true,
                  "min-h-[52px] w-full px-4 pt-4 pb-2 focus:outline-none whitespace-pre-wrap leading-5 text-[13px] font-[440] text-v2-text-text-base": true,
                  "[&_[data-type=file]]:text-syntax-property": true,
                  "[&_[data-type=agent]]:text-syntax-type": true,
                  "[&_[data-type=slash-command]]:text-[var(--composer-slash-command-color)] [&_[data-type=slash-command]]:font-medium": true,
                  "font-mono!": store.mode === "shell",
                }}
              />
              <div
                data-component={newSession() ? "session-new-design-text" : "session-composer-text"}
                class="absolute top-0 inset-x-0 px-4 pt-4 pointer-events-none whitespace-nowrap truncate leading-5 text-[13px] font-[440] text-v2-text-text-faint [font-family:Inter,var(--font-family-sans)]"
                classList={{ "font-mono!": store.mode === "shell", hidden: prompt.dirty() }}
              >
                {designPlaceholder()}
              </div>
            </div>
          </div>
          <div
            ref={(element) => {
              toolbarControls = element
              syncToolbarLayout()
            }}
            class="flex min-h-11 items-center gap-y-1 px-2 py-2"
            classList={{ "flex-wrap": toolbarCompact(), "flex-nowrap": !toolbarCompact() }}
          >
            <div
              data-slot="composer-toolbar-left"
              class="flex min-w-0 flex-1 items-center gap-0"
              classList={{ "flex-wrap": toolbarCompact(), "flex-nowrap": !toolbarCompact() }}
            >
              {fileAttachmentInput()}
              <TooltipKeybind
                placement="top"
                title={language.t("prompt.action.attachFile")}
                keybind={command.keybind("file.attach")}
              >
                <IconButton
                  data-action="prompt-attach"
                  data-mobile-touch-target
                  type="button"
                  icon="plus"
                  variant="ghost"
                  class="size-7 rounded-md p-[6px] text-v2-icon-icon-muted"
                  style={buttons()}
                  onClick={pick}
                  disabled={store.mode !== "normal"}
                  tabIndex={store.mode === "normal" ? undefined : -1}
                  aria-label={language.t("prompt.action.attachFile")}
                />
              </TooltipKeybind>
              <Show when={showAgentControl()}>
                <ComposerAgentControl state={agentControlState()} />
              </Show>
              <ComposerModelControl state={modelControlState()} />
              <Show when={store.mode !== "shell" && showVariantControl()}>
                <div
                  data-component="prompt-variant-control"
                  classList={{
                    "hidden group-hover/prompt-input:block group-focus-within/prompt-input:block":
                      !props.controls.model.selection.variant.current() && !store.variantOpen,
                  }}
                >
                  <TooltipKeybind
                    placement="top"
                    gutter={4}
                    title={language.t("command.model.variant.cycle")}
                    keybind={command.keybind("model.variant.cycle")}
                  >
                    <Select
                      size="normal"
                      disallowEmptySelection
                      options={variants()}
                      current={props.controls.model.selection.variant.current() ?? "default"}
                      label={(x) => (x === "default" ? language.t("common.default") : x)}
                      onOpenChange={(open) => setStore("variantOpen", open)}
                      onSelect={(value) => {
                        // Kobalte's single-select can emit a selection change while syncing
                        // its value on mount. Only a pick from the opened listbox is a real
                        // user selection; a sync event would clobber the configured variant.
                        if (!store.variantOpen) return
                        props.controls.model.selection.variant.set(value === "default" ? undefined : value, {
                          remember: store.variantOpen,
                        })
                        restoreFocus()
                      }}
                      class="capitalize max-w-[160px] justify-start text-v2-text-text-faint"
                      valueClass="truncate text-[13px] font-[440] leading-5 text-v2-text-text-faint"
                      triggerStyle={control()}
                      triggerProps={{
                        "data-action": "prompt-model-variant",
                        "data-mobile-touch-target": "",
                      }}
                      variant="ghost"
                    />
                  </TooltipKeybind>
                </div>
              </Show>
              <Show when={store.mode !== "shell"}>
                <ComposerAccessControl state={accessControlState()} />
              </Show>
              <Show when={!toolbarCompact()}>
                <PluginToolbarOutlet
                  placement="composer"
                  align="left"
                  directory={props.controls.projects.directory}
                  sessionID={props.controls.session.id}
                  composerID={composerID}
                  class="flex shrink-0 items-center gap-0"
                />
              </Show>
              <PluginSlotOutlet slot={UI_SLOT_IDS.composerActions} class="contents" />
            </div>
            <div
              data-slot="composer-toolbar-right"
              class="ml-auto flex min-w-0 items-center justify-end gap-0"
              classList={{ "flex-wrap": toolbarCompact(), "flex-nowrap": !toolbarCompact() }}
            >
              <SessionContextUsage action="compact" sessionID={props.controls.session.id} />
              <Show when={toolbarCompact()}>
                <PluginToolbarOutlet
                  placement="composer"
                  align="right"
                  mobile="visible"
                  directory={props.controls.projects.directory}
                  sessionID={props.controls.session.id}
                  composerID={composerID}
                  class="flex items-center"
                />
                <PluginToolbarMobileOverflow
                  directory={props.controls.projects.directory}
                  sessionID={props.controls.session.id}
                  composerID={composerID}
                  compact={!mobileLayout()}
                  class="relative"
                />
              </Show>
              <Show when={!toolbarCompact()}>
                <PluginToolbarOutlet
                  placement="composer"
                  align="right"
                  directory={props.controls.projects.directory}
                  sessionID={props.controls.session.id}
                  composerID={composerID}
                  class="mr-1 flex shrink-0 items-center justify-end gap-0"
                />
              </Show>
              <Show when={working() && !blank()}>
                <Tooltip placement="top" value={language.t("prompt.action.stop")}>
                  <IconButton
                    data-action="prompt-interrupt"
                    data-mobile-touch-target
                    type="button"
                    onClick={() => void abort()}
                    icon="stop"
                    variant="secondary"
                    class="mr-1 size-7 rounded-md p-[6px]"
                    aria-label={language.t("prompt.action.stop")}
                  />
                </Tooltip>
              </Show>
              <Tooltip placement="top" inactive={!working() && blank() && !canResumeLastPrompt()} value={tip()}>
                <IconButton
                  data-action="prompt-submit"
                  data-mobile-touch-target
                  type={stopping() ? "button" : "submit"}
                  disabled={props.disabled || (!working() && blank() && !canResumeLastPrompt())}
                  tabIndex={store.mode === "normal" ? undefined : -1}
                  icon={stopping() ? "stop" : store.mode === "shell" ? "arrow-undo-down" : "arrow-up"}
                  variant="primary"
                  class="size-7 rounded-md p-[6px] text-v2-icon-icon-inverse shadow-[var(--v2-elevation-button-contrast)] disabled:opacity-50 [&_[data-slot=icon-svg]]:text-v2-icon-icon-inverse"
                  style={{
                    "background-image":
                      "linear-gradient(180deg,var(--v2-alpha-light-20) 0%,var(--v2-alpha-light-0) 100%),linear-gradient(90deg,var(--v2-background-bg-contrast) 0%,var(--v2-background-bg-contrast) 100%)",
                  }}
                  aria-label={stopping() ? language.t("prompt.action.stop") : language.t("prompt.action.send")}
                  onClick={
                    stopping()
                      ? (event) => {
                          event.preventDefault()
                          void abort()
                        }
                      : undefined
                  }
                />
              </Tooltip>
            </div>
          </div>
        </DockShellForm>
        <Show when={newSession() || props.controls.session.id}>
          <div class="flex h-7 min-w-0 items-center gap-2 px-2">
            <ComposerPicker state={projectPickerState()} />
            {props.footerStatus}
          </div>
        </Show>
      </div>
    </div>
  )
}

function PromptSubmitOverlay(props: { visible: boolean }) {
  return (
    <Show when={props.visible}>
      <div
        data-component="prompt-submit-loading-overlay"
        class="absolute inset-0 z-20 flex items-center justify-center rounded-[inherit] bg-v2-overlay-simple-overlay-scrim backdrop-blur-[1px]"
      >
        <div class="flex max-w-[320px] items-center gap-3 rounded-md bg-v2-background-bg-base px-4 py-3 text-v2-text-text-base shadow-[var(--v2-elevation-overlay)]">
          <Spinner class="size-4 shrink-0 text-v2-icon-icon-base" />
          <div class="min-w-0">
            <div class="text-[13px] font-[520] leading-5">Sending message...</div>
            <div class="text-[12px] font-[400] leading-4 text-v2-text-text-faint">
              OpenCode is still preparing the session.
            </div>
          </div>
        </div>
      </div>
    </Show>
  )
}
