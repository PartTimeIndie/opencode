import type { Message, Session } from "@opencode-ai/sdk/v2/client"
import { showToast } from "@/utils/toast"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { Binary } from "@opencode-ai/core/util/binary"
import { produce } from "solid-js/store"
import { useSearchParams } from "@solidjs/router"
import { batch, type Accessor } from "solid-js"
import type { FileSelection } from "@/context/file"
import { useServer } from "@/context/server"
import { useTabs } from "@/context/tabs"
import { useServerSync, type ServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useLocal } from "@/context/local"
import { usePermission } from "@/context/permission"
import { isPromptEqual, type ContextItem, type ImageAttachmentPart, type Prompt, usePrompt } from "@/context/prompt"
import { useSDK, type DirectorySDK } from "@/context/sdk"
import { useSync, type DirectorySync } from "@/context/sync"
import { Identifier } from "@/utils/id"
import { Worktree as WorktreeState } from "@/utils/worktree"
import { buildRequestParts, imageAttachmentPromptFile } from "./build-request-parts"
import { setCursorPosition } from "./editor-dom"
import { formatServerError } from "@/utils/server-errors"
import { ScopedKey } from "@/utils/server-scope"
import { useSettings } from "@/context/settings"
import { buildPromptOptimization } from "@/utils/prompt-optimization"
import { useSessionRoute } from "@/context/session-route"
import { mergeSessionList } from "@/context/global-sync/session-list"
import { unavailableModelChainStep } from "@/context/model-chain"
import { recordPerfEvent } from "@/utils/perf-recorder"
import { finishSessionActivity, sessionActivityGeneration, sessionActivityID } from "@/utils/session-activity"
import {
  currentPromptRetry,
  deletePromptRetry,
  deleteSharedPromptSubmit,
  promptRetry,
  setSharedPromptSubmit,
  sharedPromptSubmit,
  type SharedPromptSubmit,
} from "./submit-state"

type PendingPrompt = {
  abort: AbortController
  cleanup: (mode?: "restore" | "discard") => void
}

const pending = new Map<string, PendingPrompt>()
const ACCESS_CONTROL_SYNC_TIMEOUT_MS = 2500

export type FollowupDraft = {
  sessionID: string
  sessionDirectory: string
  messageID?: string
  prompt: Prompt
  requestText?: string
  system?: string
  context: (ContextItem & { key: string })[]
  agent: string
  model: { providerID: string; modelID: string }
  variant?: string
  chain?: { id: string; name: string; steps: { providerID: string; modelID: string; variant?: string }[] }
}

type FollowupSendInput = {
  client: DirectorySDK["client"]
  serverSync: ServerSync
  sync: DirectorySync
  draft: FollowupDraft
  messageID?: string
  optimisticBusy?: boolean
  queued?: boolean
  delivery?: "queue" | "steer"
  before?: () => Promise<boolean> | boolean
}
const draftText = (prompt: Prompt) => prompt.map((part) => ("content" in part ? part.content : "")).join("")

const draftImages = (prompt: Prompt) => prompt.filter((part): part is ImageAttachmentPart => part.type === "image")

const clonePrompt = (prompt: Prompt): Prompt => prompt.map((part) => ({ ...part }))

function isSelectionEqual(a?: FileSelection, b?: FileSelection) {
  if (!a && !b) return true
  if (!a || !b) return false
  return (
    a.startLine === b.startLine && a.startChar === b.startChar && a.endLine === b.endLine && a.endChar === b.endChar
  )
}

function isContextItemEqual(a: ContextItem, b: ContextItem) {
  return (
    a.type === b.type &&
    a.path === b.path &&
    isSelectionEqual(a.selection, b.selection) &&
    a.comment === b.comment &&
    a.commentID === b.commentID &&
    a.commentOrigin === b.commentOrigin &&
    a.preview === b.preview
  )
}

function structuredPartKey(part: Prompt[number]): string | undefined {
  if (part.type === "text") return undefined
  if (part.type === "image") return JSON.stringify(["image", part.id])
  if (part.type === "agent") return JSON.stringify(["agent", part.name])
  return JSON.stringify([
    "file",
    part.path,
    part.selection?.startLine,
    part.selection?.startChar,
    part.selection?.endLine,
    part.selection?.endChar,
  ])
}

function dedupeStructuredParts<T extends Prompt[number]>(parts: T[]) {
  const seen = new Set<string>()
  return parts.filter((part) => {
    const key = structuredPartKey(part)
    if (!key) return true
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function promptContainsPrompt(prompt: Prompt, expected: Prompt) {
  const expectedText = draftText(expected)
  const promptText = draftText(prompt)
  if (expectedText && promptText !== expectedText && !promptText.startsWith(expectedText)) return false

  return expected.every((part) => {
    if (part.type === "text") return true
    if (part.type === "image") return prompt.some((candidate) => candidate.type === "image" && candidate.id === part.id)
    if (part.type === "agent")
      return prompt.some((candidate) => candidate.type === "agent" && candidate.name === part.name)
    return prompt.some(
      (candidate) =>
        candidate.type === "file" &&
        candidate.path === part.path &&
        candidate.selection?.startLine === part.selection?.startLine &&
        candidate.selection?.startChar === part.selection?.startChar &&
        candidate.selection?.endLine === part.selection?.endLine &&
        candidate.selection?.endChar === part.selection?.endChar,
    )
  })
}

function mergePromptSnapshots(failed: Prompt, pending: Prompt): Prompt {
  if (isPromptEqual(failed, pending) || promptContainsPrompt(pending, failed)) {
    return clonePrompt(dedupeStructuredParts(pending))
  }

  const failedContent = failed.filter((part) => part.type !== "image")
  const pendingContent = pending.filter((part) => part.type !== "image")
  const content = dedupeStructuredParts([
    ...failedContent,
    ...(draftText(failedContent).length && draftText(pendingContent).length
      ? [{ type: "text" as const, content: "\n\n", start: 0, end: 0 }]
      : []),
    ...pendingContent,
  ])
  let position = 0
  const normalized = content.map((part) => {
    const next = { ...part, start: position, end: position + part.content.length }
    position = next.end
    return next
  })
  const images = dedupeStructuredParts([...draftImages(failed), ...draftImages(pending)])
  return [...normalized, ...images.map((part) => ({ ...part }))]
}

function promptSubmitSignature(input: {
  sessionID: string
  prompt: Prompt
  context: (ContextItem & { key: string })[]
  agent: string
  model: { providerID: string; modelID: string }
  variant?: string
  chain?: { id: string; name: string; steps: { providerID: string; modelID: string; variant?: string }[] }
  requestText?: string
  system?: string
  delivery?: "queue" | "steer"
}) {
  return JSON.stringify({
    sessionID: input.sessionID,
    agent: input.agent,
    model: toV2Model(input.model, input.variant, input.chain),
    prompt: input.prompt,
    context: input.context,
    requestText: input.requestText,
    system: input.system,
    delivery: input.delivery,
  })
}

const toV2Model = (
  model: { providerID: string; modelID: string },
  variant?: string,
  chain?: { id: string; name: string; steps: { providerID: string; modelID: string; variant?: string }[] },
) => ({
  providerID: model.providerID,
  id: model.modelID,
  ...(variant === undefined ? {} : { variant }),
  ...(chain
    ? {
        chain: {
          id: chain.id,
          name: chain.name,
          active: 0,
          steps: chain.steps.map((step) => ({
            providerID: step.providerID,
            id: step.modelID,
            ...(step.variant ? { variant: step.variant } : {}),
          })),
        },
      }
    : {}),
})

const imagePromptFiles = (images: ImageAttachmentPart[]) =>
  images.flatMap((attachment) => {
    const file = imageAttachmentPromptFile(attachment)
    return file ? [file] : []
  })

type SlashCommandSubmit = {
  name: string
  arguments: string
  visibleGoal?: string
}

type PromptSubmitOperation = {
  kind: "prompt" | "command" | "shell"
  signature: string
  commandIntent?: string
}

function promptSubmitOperation(input: {
  sessionID: string
  prompt: Prompt
  context: (ContextItem & { key: string })[]
  mode: "normal" | "shell"
  text: string
  command?: SlashCommandSubmit
  agent: string
  model: { providerID: string; modelID: string }
  variant?: string
  chain?: { id: string; name: string; steps: { providerID: string; modelID: string; variant?: string }[] }
  files: ReturnType<typeof imagePromptFiles>
  requestText?: string
  system?: string
  delivery?: "queue" | "steer"
}): PromptSubmitOperation {
  if (input.mode === "shell") {
    return {
      kind: "shell",
      signature: JSON.stringify({
        sessionID: input.sessionID,
        agent: input.agent,
        command: input.text,
      }),
    }
  }

  if (input.command) {
    return {
      kind: "command",
      signature: JSON.stringify({
        sessionID: input.sessionID,
        command: input.command.name,
        arguments: input.command.arguments,
        agent: input.agent,
        model: toV2Model(input.model, input.variant, input.chain),
        files: input.files,
      }),
      commandIntent: JSON.stringify({
        sessionID: input.sessionID,
        command: input.command.name,
        arguments: input.command.arguments,
      }),
    }
  }

  return {
    kind: "prompt",
    signature: promptSubmitSignature({
      sessionID: input.sessionID,
      prompt: input.prompt,
      context: input.context,
      agent: input.agent,
      model: input.model,
      variant: input.variant,
      chain: input.chain,
      requestText: input.requestText,
      system: input.system,
      delivery: input.delivery,
    }),
  }
}

async function sendSlashCommand(input: {
  client: DirectorySDK["client"]
  sessionID: string
  messageID: string
  name: string
  arguments: string
  agent: string
  model: { providerID: string; modelID: string }
  variant?: string
  chain?: { id: string; name: string; steps: { providerID: string; modelID: string; variant?: string }[] }
  images: ImageAttachmentPart[]
}) {
  const files = imagePromptFiles(input.images)
  await input.client.v2.session.command({
    sessionID: input.sessionID,
    id: input.messageID,
    command: input.name,
    arguments: input.arguments,
    agent: input.agent,
    model: toV2Model(input.model, input.variant, input.chain),
    ...(files.length ? { files } : {}),
  })
}

const GOAL_CLEAR_COMMANDS = new Set(["clear", "stop", "off", "reset", "none", "cancel"])
const GOAL_STATUS_COMMANDS = new Set(["status", "history", "list", "pause", "resume", "focus"])

function visibleGoalFromCommandArguments(value: string) {
  const args = value.trim()
  const normalized = args.toLowerCase()
  // These controls own plugin state; only server metadata can confirm the focused goal.
  if (!args || GOAL_STATUS_COMMANDS.has(normalized) || /^(?:add|edit|sisyphus|focus)(?:\s|$)/.test(normalized)) {
    return undefined
  }
  if (GOAL_CLEAR_COMMANDS.has(normalized)) return ""
  return args
}

function waitForAccessControlSync(sync: Promise<void>) {
  let timer: number | undefined
  return Promise.race([
    sync.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = window.setTimeout(() => resolve(false), ACCESS_CONTROL_SYNC_TIMEOUT_MS)
    }),
  ]).finally(() => {
    if (timer === undefined) return
    window.clearTimeout(timer)
  })
}

export async function sendFollowupDraft(input: FollowupSendInput) {
  const text = draftText(input.draft.prompt)
  const images = draftImages(input.draft.prompt)
  const [, setStore] = input.serverSync.child(input.draft.sessionDirectory)

  const setBusy = () => {
    if (!input.optimisticBusy) return
    setStore("session_status", input.draft.sessionID, { type: "busy" })
  }

  const setIdle = () => {
    if (!input.optimisticBusy) return
    setStore("session_status", input.draft.sessionID, { type: "idle" })
  }

  const wait = async () => {
    const ok = await input.before?.()
    if (ok === false) return false
    return true
  }

  const messageID = input.messageID ?? input.draft.messageID ?? Identifier.ascending("message")
  const [head, ...tail] = text.split(" ")
  const cmd = head?.startsWith("/") ? head.slice(1) : undefined
  const command = cmd ? input.sync.data.command.find((item) => item.name === cmd) : undefined
  if (cmd && command && command.source !== "skill" && !input.queued) {
    setBusy()
    try {
      if (!(await wait())) {
        setIdle()
        return false
      }

      await sendSlashCommand({
        client: input.client,
        sessionID: input.draft.sessionID,
        messageID,
        name: cmd,
        arguments: tail.join(" "),
        agent: input.draft.agent,
        model: input.draft.model,
        variant: input.draft.variant,
        chain: input.draft.chain,
        images,
      })
      return true
    } catch (err) {
      setIdle()
      throw err
    }
  }

  const { requestPrompt, optimisticParts } = buildRequestParts({
    prompt: input.draft.prompt,
    context: input.draft.context,
    images,
    text,
    requestText: input.draft.requestText,
    sessionID: input.draft.sessionID,
    messageID,
    sessionDirectory: input.draft.sessionDirectory,
  })

  const message: Message = {
    id: messageID,
    sessionID: input.draft.sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: input.draft.agent,
    model: { ...input.draft.model, variant: input.draft.variant },
  }

  const add = () =>
    input.sync.session.optimistic.add({
      directory: input.draft.sessionDirectory,
      sessionID: input.draft.sessionID,
      message,
      parts: optimisticParts,
    })

  const remove = () =>
    input.sync.session.optimistic.remove({
      directory: input.draft.sessionDirectory,
      sessionID: input.draft.sessionID,
      messageID,
    })

  batch(() => {
    setBusy()
    add()
  })

  try {
    if (!(await wait())) {
      batch(() => {
        setIdle()
        remove()
      })
      return false
    }

    await input.client.v2.session.prompt({
      sessionID: input.draft.sessionID,
      id: messageID,
      agent: input.draft.agent,
      model: toV2Model(input.draft.model, input.draft.variant, input.draft.chain),
      prompt: requestPrompt,
      system: input.draft.system,
      ...(input.delivery ? { delivery: input.delivery } : {}),
    })
    return true
  } catch (err) {
    batch(() => {
      setIdle()
      remove()
    })
    throw err
  }
}

type PromptSubmitInput = {
  beforeSubmit?: (context: {
    directory: string
    sessionID?: string
    getAgent(): string | undefined
    canSetAgent(name: string): boolean
    setAgent(name: string): boolean
  }) => Promise<boolean>
  prompt: ReturnType<typeof usePrompt>
  info: Accessor<
    | {
        id: string
        agent?: string
        model?: { id: string; providerID: string; variant?: string }
      }
    | undefined
  >
  imageAttachments: Accessor<ImageAttachmentPart[]>
  commentCount: Accessor<number>
  mode: Accessor<"normal" | "shell">
  working: Accessor<boolean>
  editor: () => HTMLDivElement | undefined
  queueScroll: () => void
  promptLength: (prompt: Prompt) => number
  addToHistory: (prompt: Prompt, mode: "normal" | "shell") => void
  resetHistoryNavigation: () => void
  setMode: (mode: "normal" | "shell") => void
  setPopover: (popover: "at" | "slash" | null) => void
  draftID?: Accessor<string | undefined>
  newSessionWorktree?: Accessor<string | undefined>
  onNewSessionWorktreeReset?: () => void
  shouldQueue?: Accessor<boolean>
  onQueue?: (draft: FollowupDraft) => void
  forceSteer?: Accessor<boolean>
  onForceSteerSent?: () => void
  onGoal?: (input: { sessionID: string; sessionDirectory: string; goal: string }) => void
  onAbort?: () => void
  onSubmit?: () => void
}

type ProgrammaticPromptSubmitInput = {
  text: string
  delivery: "steer" | "queue"
}

export type PromptSubmitOptions = {
  prompt?: Prompt
  context?: (ContextItem & { key: string })[]
  delivery?: "steer" | "queue"
  preserveComposer?: boolean
  skipBeforeSubmit?: boolean
  waitForAdmission?: boolean
  /** Set when resubmitting a history entry so the empty-composer resume branch cannot recurse. */
  resume?: boolean
}

type CommentItem = {
  path: string
  selection?: FileSelection
  comment?: string
  commentID?: string
  commentOrigin?: "review" | "file"
  preview?: string
}

export function createPromptSubmit(input: PromptSubmitInput) {
  const sdk = useSDK()
  const sync = useSync()
  const serverSync = useServerSync()
  const scopedPrompt = usePrompt()
  const local = useLocal()
  const permission = usePermission()
  const prompt = input.prompt
  const layout = useLayout()
  const language = useLanguage()
  const settings = useSettings()
  const params = useSessionRoute()
  const [search] = useSearchParams<{ draftId?: string }>()
  const server = useServer()
  const tabs = useTabs()
  const pendingKey = (sessionID: string) => ScopedKey.from(sdk().scope, sessionID)

  const errorMessage = (err: unknown) => {
    if (err && typeof err === "object" && "data" in err) {
      const data = err.data
      if (data && typeof data === "object" && "message" in data && typeof data.message === "string") {
        return data.message
      }
    }
    if (err instanceof Error) return err.message
    return language.t("common.requestFailed")
  }

  const abort = async () => {
    const sessionID = params.id
    if (!sessionID) return Promise.resolve()
    const started = performance.now()
    const wasWorking = input.working()
    const directory = sdk().directory
    const activityID = sessionActivityID(directory, sessionID)
    const activityGeneration = sessionActivityGeneration(directory, sessionID)
    const client = sdk()

    serverSync().todo.set(directory, sessionID, [])
    const [, setStore] = serverSync().child(directory)
    setStore("todo", sessionID, [])

    const key = pendingKey(sessionID)
    const queued = pending.get(key)
    if (queued) {
      queued.abort.abort()
      queued.cleanup("discard")
      pending.delete(key)
    }
    if (!wasWorking) {
      input.onAbort?.()
      return Promise.resolve()
    }

    return client.client.v2.session
      .interrupt({
        sessionID,
      })
      .then(() => {
        input.onAbort?.()
        if (activityID) {
          if (!finishSessionActivity(directory, sessionID, activityID)) return
        } else if (sessionActivityGeneration(directory, sessionID) !== activityGeneration) {
          return
        } else {
          finishSessionActivity(directory, sessionID)
        }
        batch(() => {
          setStore("session_status", sessionID, { type: "idle" })
        })
      })
      .catch((err: unknown) => {
        showToast({
          title: language.t("common.requestFailed"),
          description: errorMessage(err),
        })
      })
      .finally(() =>
        recordPerfEvent(server.current, {
          kind: "ui_session_load",
          action: "abort",
          sessionID,
          duration_ms: performance.now() - started,
        }),
      )
  }

  const restoreCommentItems = (items: CommentItem[]) => {
    for (const item of items) {
      prompt.context.add({
        type: "file",
        path: item.path,
        selection: item.selection,
        comment: item.comment,
        commentID: item.commentID,
        commentOrigin: item.commentOrigin,
        preview: item.preview,
      })
    }
  }

  const removeUnchangedContextItems = (items: (ContextItem & { key: string })[]) => {
    for (const item of items) {
      const current = prompt.context.items().find((candidate) => candidate.key === item.key)
      if (!current || !isContextItemEqual(current, item)) continue
      prompt.context.remove(item.key)
    }
  }

  const seed = (dir: string, info: Session) => {
    const [, setStore] = serverSync().child(dir)
    setStore(
      "session",
      produce((draft) => mergeSessionList(draft, info)),
    )
  }

  const sharedKey = (draftID?: string) =>
    ScopedKey.from(sdk().scope, sdk().directory, "prompt-submit", draftID ? `draft:${draftID}` : "new-session")

  const attachSharedOwner = (record: SharedPromptSubmit) => {
    const capturePendingPrompt = () => {
      const value = clonePrompt(prompt.current())
      const baseline = record.clearedPrompt ?? record.prompt
      record.pendingPrompt = isPromptEqual(value, baseline)
        ? undefined
        : {
            prompt: value,
            cursor: prompt.cursor() ?? input.promptLength(value),
          }
    }

    record.owner = {
      clearInput() {
        capturePendingPrompt()
        prompt.reset()
        record.clearedPrompt = clonePrompt(prompt.current())
        if (record.pendingPrompt) prompt.set(record.pendingPrompt.prompt, record.pendingPrompt.cursor)
        input.setMode("normal")
        input.setPopover(null)
      },
      restoreInput() {
        capturePendingPrompt()
        const restored = record.pendingPrompt
          ? mergePromptSnapshots(record.prompt, record.pendingPrompt.prompt)
          : record.prompt
        const cursor = input.promptLength(restored)
        prompt.set(restored, cursor)
        record.clearedPrompt = undefined
        record.pendingPrompt = undefined
        input.setMode(record.mode)
        input.setPopover(null)
        requestAnimationFrame(() => {
          const activeTab = tabs.active()
          const editor = input.editor()
          if (!editor) return
          const active = record.draftID
            ? activeTab?.type === "draft" && activeTab.draftID === record.draftID
            : !activeTab && !params.id && !search.draftId && editor.isConnected
          if (!active) return
          editor.focus()
          setCursorPosition(editor, cursor)
          input.queueScroll()
        })
      },
      activateCreatedSession() {
        if (record.finalized || !record.session) return
        record.finalized = true
        capturePendingPrompt()
        const nextTab = {
          server: server.key,
          dirBase64: base64Encode(record.sessionDirectory),
          sessionId: record.session.id,
          createdEmpty: false,
        }
        const scope = { dir: record.sessionDirectory, id: record.session.id }
        if (record.pendingPrompt) scopedPrompt.set(record.pendingPrompt.prompt, record.pendingPrompt.cursor, scope)
        for (const item of prompt.context.items()) {
          scopedPrompt.context.add(
            {
              type: "file",
              path: item.path,
              selection: item.selection ? { ...item.selection } : undefined,
              comment: item.comment,
              commentID: item.commentID,
              commentOrigin: item.commentOrigin,
              preview: item.preview,
            },
            scope,
          )
        }
        local.session.promote(record.sessionDirectory, record.session.id)
        input.onNewSessionWorktreeReset?.()
        const activeTab = tabs.active()
        const activateDraft = activeTab?.type === "draft" && activeTab.draftID === record.draftID
        const activateRoot = !record.draftID && !params.id && !search.draftId
        if (record.draftID) tabs.promoteDraft(record.draftID, nextTab)
        if (activateRoot || (activateDraft && search.draftId !== record.draftID)) {
          layout.handoff.setTabs(base64Encode(record.sessionDirectory), record.session.id)
          tabs.openSessionTab(nextTab)
        }
        if (!record.draftID && !activateRoot) tabs.openSessionTab(nextTab, { activate: false })
        tabs.markSessionUsed({ server: server.key, directory: record.sessionDirectory, sessionID: record.session.id })
        deleteSharedPromptSubmit(record)
      },
      onGoal: input.onGoal,
    }
  }

  const mountedDraftID = input.draftID?.() ?? search.draftId
  const mountedRecord = sharedPromptSubmit(sharedKey(mountedDraftID))
  if (mountedRecord) attachSharedOwner(mountedRecord)

  const submit = async (options?: PromptSubmitOptions) => {
    const submitStarted = performance.now()

    if (!options?.skipBeforeSubmit && input.beforeSubmit) {
      const serverID = server.key
      const directory = sdk().directory
      const sessionID = params.id
      const accepted = await input.beforeSubmit({
        directory,
        sessionID,
        getAgent: () => local.agent.current()?.name,
        canSetAgent: (name) => local.agent.list().some((agent) => agent.name === name),
        setAgent: (name) => {
          local.agent.set(name)
          return local.agent.current()?.name === name
        },
      })
      if (!accepted || server.key !== serverID || sdk().directory !== directory || params.id !== sessionID) return
    }

    const selectionSettled = await local.session.settled().then(
      () => true,
      (error) => {
        showToast({ title: language.t("common.error"), description: formatServerError(error) })
        return false
      },
    )
    if (!selectionSettled) return

    // A resume submit sends a short continuation prompt instead of duplicating the
    // previous full user message in the conversation.
    let currentPrompt = options?.resume
      ? [{ type: "text" as const, content: "Continue", start: 0, end: "Continue".length }]
      : clonePrompt(options?.prompt ?? prompt.current())
    const submittedPrompt = currentPrompt
    let text = draftText(currentPrompt)
    const mode = input.mode()
    const goal = text.trim().match(/^\/goal(?:\s+([\s\S]*))?$/)
    const images = draftImages(currentPrompt).map((part) => ({ ...part }))
    const context =
      options?.context ??
      prompt.context.items().map((item) => ({
        ...item,
        selection: item.selection ? { ...item.selection } : undefined,
      }))

    if (
      text.trim().length === 0 &&
      images.length === 0 &&
      (options ? context.filter((item) => !!item.comment?.trim()).length : input.commentCount()) === 0
    ) {
      // An empty submit while working must not stop the run. Stopping is the explicit
      // stop button / Esc path; a stray empty Enter stays a no-op instead of killing
      // in-flight provider work mid-turn.
      return
    }

    const storedSelection = input.info()
    const currentModel = local.model.current()
    const chain = local.model.chain?.current()
    const selectedChainID = local.model.chain?.selected()
    const selectedKey = local.model.selected()
    const model = currentModel
      ? { modelID: currentModel.id, providerID: currentModel.provider.id }
      : selectedKey === undefined && storedSelection?.model
        ? { modelID: storedSelection.model.id, providerID: storedSelection.model.providerID }
        : undefined
    const agent = local.agent.current()?.name ?? storedSelection?.agent ?? sync().data.config.default_agent ?? "build"
    const variant = currentModel ? local.model.variant.current() : storedSelection?.model?.variant
    if (selectedChainID && !chain) {
      showToast({
        title: language.t("prompt.toast.modelUnavailable.title"),
        description: selectedChainID,
      })
      return
    }
    const unavailableChainStep =
      chain &&
      unavailableModelChainStep(chain, (step) =>
        local.model.list().find((model) => model.provider.id === step.providerID && model.id === step.modelID),
      )
    if (unavailableChainStep) {
      showToast({
        title: language.t("prompt.toast.modelUnavailable.title"),
        description: `${unavailableChainStep.providerID}/${unavailableChainStep.modelID}`,
      })
      return
    }
    if (selectedKey !== undefined && !currentModel) {
      // The user explicitly picked this model but it is no longer resolvable (provider
      // disconnected or model removed). Never silently submit a substituted model; that
      // re-pins the session to a different provider without any user-visible signal.
      showToast({
        title: language.t("prompt.toast.modelUnavailable.title"),
        description: language.t("prompt.toast.modelUnavailable.description"),
      })
      return
    }
    if (!model) {
      showToast({
        title: language.t("prompt.toast.modelAgentRequired.title"),
        description: language.t("prompt.toast.modelAgentRequired.description"),
      })
      return
    }

    const goalCommand = goal && mode === "normal" ? sync().data.command.find((item) => item.name === "goal") : undefined
    if (goal && mode === "normal" && !goalCommand) {
      showToast({
        title: language.t("prompt.toast.commandSendFailed.title"),
        description: language.t("common.requestFailed"),
      })
      return
    }
    const goalArgs = goal?.[1]?.trim() ?? ""
    const pinGoal = goal && mode === "normal" && goalCommand ? visibleGoalFromCommandArguments(goalArgs) : undefined
    if (pinGoal) {
      currentPrompt = [
        { type: "text" as const, content: pinGoal, start: 0, end: pinGoal.length },
        ...currentPrompt.filter((part) => part.type !== "text"),
      ]
      text = draftText(currentPrompt)
    }

    const projectDirectory = sdk().directory
    const draftID = input.draftID?.() ?? search.draftId
    const submittedSessionID = params.id
    const isNewSession = !submittedSessionID || Boolean(draftID)
    const worktreeSelection = input.newSessionWorktree?.() || "main"
    const working = input.working()
    const [commandHead, ...commandTail] = text.split(" ")
    const commandName = commandHead?.startsWith("/") ? commandHead.slice(1) : undefined
    const spawnNewAgentSkill =
      commandName === "spawn-new-agent" &&
      sync().data.command.some((item) => item.name === commandName && item.source === "skill")
    const forceSteer = !isNewSession && mode === "normal" && (options?.delivery === "steer" || input.forceSteer?.())
    const shouldQueue =
      !forceSteer &&
      !isNewSession &&
      mode === "normal" &&
      !spawnNewAgentSkill &&
      (options?.delivery === "queue" || input.shouldQueue?.())
    const customCommand =
      mode === "normal" && !working && !shouldQueue && commandName
        ? sync().data.command.find((item) => item.name === commandName && item.source !== "skill")
        : undefined
    const command: SlashCommandSubmit | undefined =
      goal && goalCommand && mode === "normal" && !pinGoal
        ? {
            name: "goal",
            arguments: goalArgs,
            visibleGoal: visibleGoalFromCommandArguments(goalArgs),
          }
        : customCommand && commandName
          ? { name: commandName, arguments: commandTail.join(" ") }
          : undefined
    const optimization =
      mode === "normal" && !command
        ? buildPromptOptimization({
            text,
            settings: {
              optimizationProfile: settings.optimizations.optimizationProfile(),
              toolContextCompression: settings.optimizations.toolContextCompression(),
              externalContextReduction: settings.optimizations.externalContextReduction(),
              sourceTestContextPack: settings.optimizations.sourceTestContextPack(),
              compactVerifierContext: settings.optimizations.compactVerifierContext(),
              selfTestPolicy: settings.optimizations.selfTestPolicy(),
              coreSearchLimits: settings.optimizations.coreSearchLimits(),
              toolMaterializationCache: settings.optimizations.toolMaterializationCache(),
              runnerRequestMetrics: settings.optimizations.runnerRequestMetrics(),
              sessionTabPrefetch: settings.optimizations.sessionTabPrefetch(),
            },
            contextFileCount: context.filter((item) => item.type === "file").length,
            fileAttachmentCount: currentPrompt.filter((item) => item.type === "file").length,
          })
        : { requestText: undefined, system: undefined, compactedVerifierContext: false }
    const activeFollowup = !forceSteer && !isNewSession && mode === "normal" && working
    const activeFollowupDelivery =
      options?.delivery ??
      (forceSteer
        ? ("steer" as const)
        : activeFollowup && spawnNewAgentSkill
          ? ("queue" as const)
          : activeFollowup && settings.general.followup() === "queue"
            ? ("queue" as const)
            : undefined)
    const retryKey = ScopedKey.from(
      sdk().scope,
      projectDirectory,
      "prompt-admission",
      submittedSessionID ?? (draftID ? `draft:${draftID}` : "new-session"),
    )
    const previousRetry = currentPromptRetry(retryKey)
    let shared = isNewSession ? sharedPromptSubmit(sharedKey(draftID)) : undefined

    if (shared?.inFlight) {
      attachSharedOwner(shared)
      await shared.inFlight
      return
    }

    const operationFor = (sessionID: string) =>
      promptSubmitOperation({
        sessionID,
        prompt: currentPrompt,
        context,
        mode,
        text,
        command,
        agent,
        model,
        variant,
        chain,
        files: imagePromptFiles(images),
        requestText: optimization.requestText,
        system: optimization.system,
        delivery: activeFollowupDelivery,
      })
    const sharedOperation = shared ? operationFor(shared.sessionID) : undefined
    const canReuseShared =
      shared &&
      shared.worktreeSelection === worktreeSelection &&
      shared.operation === sharedOperation?.kind &&
      shared.signature === sharedOperation.signature

    if (canReuseShared && sharedOperation?.kind === "shell" && shared?.shellUnknown) {
      showToast({
        title: language.t("prompt.toast.shellSendFailed.title"),
        description: "The previous request may already have run. Edit the command before submitting it again.",
      })
      return
    }

    if (
      shared?.commandUnknown &&
      shared.worktreeSelection === worktreeSelection &&
      sharedOperation?.kind === "command" &&
      shared.commandIntent === sharedOperation.commandIntent &&
      shared.signature !== sharedOperation.signature
    ) {
      showToast({
        title: language.t("prompt.toast.commandSendFailed.title"),
        description: "The previous request may already have run. Edit the command before submitting it again.",
      })
      return
    }

    if (!canReuseShared && isNewSession) {
      const sessionID = Identifier.ascending("session")
      const operation = operationFor(sessionID)
      shared = {
        key: sharedKey(draftID),
        draftID,
        signature: operation.signature,
        sessionID,
        messageID: Identifier.ascending("message"),
        projectDirectory,
        sessionDirectory: projectDirectory,
        worktreeSelection,
        prompt: currentPrompt,
        context,
        images,
        mode,
        agent,
        model,
        variant,
        chain,
        operation: operation.kind,
        commandIntent: operation.commandIntent,
      }
      setSharedPromptSubmit(shared)
    }

    const operation = shared ? operationFor(shared.sessionID) : operationFor(submittedSessionID!)

    if (
      !isNewSession &&
      previousRetry?.commandUnknown &&
      operation.kind === "command" &&
      previousRetry.operation === "command" &&
      previousRetry.commandIntent === operation.commandIntent &&
      previousRetry.signature !== operation.signature
    ) {
      showToast({
        title: language.t("prompt.toast.commandSendFailed.title"),
        description: "The previous request may already have run. Edit the command before submitting it again.",
      })
      return
    }

    if (
      !isNewSession &&
      operation.kind === "shell" &&
      previousRetry?.operation === "shell" &&
      previousRetry.signature === operation.signature &&
      previousRetry.shellUnknown
    ) {
      showToast({
        title: language.t("prompt.toast.shellSendFailed.title"),
        description: "The previous request may already have run. Edit the command before submitting it again.",
      })
      return
    }

    const retry = isNewSession
      ? undefined
      : promptRetry(retryKey, {
          operation: operation.kind,
          signature: operation.signature,
          commandIntent: operation.commandIntent,
        })
    const retryingExisting =
      !isNewSession && previousRetry?.operation === operation.kind && previousRetry.signature === operation.signature
    if (!options?.resume && ((shared && !shared.historyAdded) || (!shared && !retryingExisting))) {
      input.addToHistory(currentPrompt, mode)
      input.resetHistoryNavigation()
      if (shared) shared.historyAdded = true
    }

    if (shared) {
      attachSharedOwner(shared)
      shared.inFlight = new Promise<void>((resolve) => {
        shared.resolveInFlight = resolve
      })
    }
    const submitAgent = shared?.agent ?? agent
    const submitModel = shared?.model ?? model
    const submitVariant = shared?.variant ?? variant
    const submitChain = shared?.chain ?? chain

    let clearedPrompt: Prompt | undefined
    let pendingPrompt: { prompt: Prompt; cursor: number } | undefined
    const capturePendingPrompt = () => {
      const value = clonePrompt(prompt.current())
       const baseline = clearedPrompt ?? submittedPrompt
      pendingPrompt = isPromptEqual(value, baseline)
        ? undefined
        : { prompt: value, cursor: prompt.cursor() ?? input.promptLength(value) }
    }
    const clearInput = () => {
      if (options?.preserveComposer) return
      if (shared) {
        shared.owner?.clearInput()
        return
      }
      capturePendingPrompt()
      prompt.reset()
      clearedPrompt = clonePrompt(prompt.current())
      if (pendingPrompt) prompt.set(pendingPrompt.prompt, pendingPrompt.cursor)
      input.setMode("normal")
      input.setPopover(null)
    }
    const restoreInput = () => {
      if (options?.preserveComposer) return
      if (shared) {
        shared.owner?.restoreInput()
        return
      }
      capturePendingPrompt()
      const restored = pendingPrompt ? mergePromptSnapshots(currentPrompt, pendingPrompt.prompt) : currentPrompt
      const cursor = input.promptLength(restored)
      prompt.set(restored, cursor)
      input.setMode(mode)
      input.setPopover(null)
      requestAnimationFrame(() => {
        const activeTab = tabs.active()
        const editor = input.editor()
        if (!editor || activeTab?.type !== "session" || activeTab.sessionId !== submittedSessionID) return
        editor.focus()
        setCursorPosition(editor, cursor)
        input.queueScroll()
      })
    }

    try {
      let sessionDirectory = shared?.sessionDirectory ?? projectDirectory
      let client = sdk().client

      if (isNewSession) {
        if (worktreeSelection === "create" && sessionDirectory === projectDirectory) {
          const createdWorktree = await client.worktree
            .create({ directory: projectDirectory })
            .then((x) => x.data)
            .catch((err) => {
              showToast({
                title: language.t("prompt.toast.worktreeCreateFailed.title"),
                description: errorMessage(err),
              })
              return undefined
            })

          if (!createdWorktree?.directory) {
            showToast({
              title: language.t("prompt.toast.worktreeCreateFailed.title"),
              description: language.t("common.requestFailed"),
            })
            return
          }
          WorktreeState.pending(sdk().scope, createdWorktree.directory)
          sessionDirectory = createdWorktree.directory
        }

        if (worktreeSelection !== "main" && worktreeSelection !== "create") {
          sessionDirectory = worktreeSelection
        }
        if (shared) shared.sessionDirectory = sessionDirectory

        if (sessionDirectory !== projectDirectory) {
          client = sdk().createClient({
            directory: sessionDirectory,
            throwOnError: true,
          })
          serverSync().child(sessionDirectory)
        }
      }

      let session = isNewSession
        ? shared?.session
        : (input.info() ?? (submittedSessionID ? { id: submittedSessionID } : undefined))
      if (!session && isNewSession && shared) {
        const sessionCreateStarted = performance.now()
        const createdID = await client.v2.session
          .create({
            id: shared.sessionID,
            agent: submitAgent,
            model: toV2Model(submitModel, submitVariant, submitChain),
            location: { directory: sessionDirectory },
          })
          .then((result) => result.data?.data.id)
          .catch((err) => {
            showToast({
              title: language.t("prompt.toast.sessionCreateFailed.title"),
              description: errorMessage(err),
            })
            return undefined
          })
        const created = createdID
          ? await client.session
              .get({ sessionID: createdID })
              .then((result) => result.data ?? undefined)
              .catch((err) => {
                showToast({
                  title: language.t("prompt.toast.sessionCreateFailed.title"),
                  description: errorMessage(err),
                })
                return undefined
              })
          : undefined
        if (created) {
          recordPerfEvent(server.current, {
            kind: "ui_session_load",
            action: "session_create",
            sessionID: created.id,
            directory_changed: sessionDirectory !== projectDirectory,
            duration_ms: performance.now() - sessionCreateStarted,
          })
          seed(sessionDirectory, created)
          session = created
          shared.session = created
          permission.applyAccessControlDefault(session.id, sessionDirectory)
        }
      }
      if (!session) {
        showToast({
          title: language.t("prompt.toast.promptSendFailed.title"),
          description: language.t("prompt.toast.promptSendFailed.description"),
        })
        return
      }

      if (!isNewSession) {
        tabs.markSessionUsed({ server: server.key, directory: sessionDirectory, sessionID: session.id })
      }
      recordPerfEvent(server.current, {
        kind: "ui_session_load",
        action: "submit_prepare",
        sessionID: session.id,
        new_session: isNewSession,
        directory_changed: sessionDirectory !== projectDirectory,
        duration_ms: performance.now() - submitStarted,
      })

      await waitForAccessControlSync(permission.syncAccessControlProfile(session.id, sessionDirectory))

      const messageID = shared?.messageID ?? retry!.messageID
      const completeAdmission = () => {
        if (pinGoal) {
          const onGoal = shared?.owner?.onGoal ?? input.onGoal
          onGoal?.({
            sessionID: session.id,
            sessionDirectory,
            goal: pinGoal,
          })
        }
        if (shared) shared.owner?.activateCreatedSession()
        if (retry) deletePromptRetry(retryKey, retry)
      }

      if (command?.name === "goal") {
        clearInput()
        const sending = sendSlashCommand({
          client,
          sessionID: session.id,
          messageID,
          name: command.name,
          arguments: command.arguments,
          agent: submitAgent,
          model: submitModel,
          variant: submitVariant,
          chain: submitChain,
          images,
        })
          .then(() => {
            removeUnchangedContextItems(context)
            const onGoal = shared?.owner?.onGoal ?? input.onGoal
            if (command.visibleGoal !== undefined && onGoal) {
              onGoal({
                sessionID: session.id,
                sessionDirectory,
                goal: command.visibleGoal,
              })
            }
            completeAdmission()
          })
          .catch((err) => {
            if (shared) shared.commandUnknown = true
            if (retry) retry.commandUnknown = true
            showToast({
              title: language.t("prompt.toast.commandSendFailed.title"),
              description: formatServerError(err, language.t, language.t("common.requestFailed")),
            })
            restoreInput()
          })
        if (isNewSession) await sending
        return
      }

      const draft: FollowupDraft = {
        sessionID: session.id,
        sessionDirectory,
        messageID,
        prompt: currentPrompt,
        requestText: optimization.requestText,
        system: optimization.system,
        context,
        agent: submitAgent,
        model: submitModel,
        variant: submitVariant,
        chain: submitChain,
      }

      if (shouldQueue) {
        if (pinGoal) {
          input.onGoal?.({
            sessionID: session.id,
            sessionDirectory,
            goal: pinGoal,
          })
        }
        input.onQueue?.(draft)
        removeUnchangedContextItems(context)
        clearInput()
        if (retry) deletePromptRetry(retryKey, retry)
        return
      }

      input.onSubmit?.()

      if (mode === "shell") {
        clearInput()
        const sending = client.v2.session
          .shell({
            sessionID: session.id,
            agent: submitAgent,
            command: text,
          })
          .then(completeAdmission)
          .catch((err: unknown) => {
            if (shared) shared.shellUnknown = true
            if (retry) retry.shellUnknown = true
            showToast({
              title: language.t("prompt.toast.shellSendFailed.title"),
              description: `${errorMessage(err)} The command status is unknown, so it will not be retried unchanged.`,
            })
            restoreInput()
          })
        if (isNewSession) await sending
        return
      }

      if (command) {
        clearInput()
        const sending = sendSlashCommand({
          client,
          sessionID: session.id,
          messageID,
          name: command.name,
          arguments: command.arguments,
          agent: submitAgent,
          model: submitModel,
          variant: submitVariant,
          chain: submitChain,
          images,
        })
          .then(completeAdmission)
          .catch((err) => {
            if (shared) shared.commandUnknown = true
            if (retry) retry.commandUnknown = true
            showToast({
              title: language.t("prompt.toast.commandSendFailed.title"),
              description: formatServerError(err, language.t, language.t("common.requestFailed")),
            })
            restoreInput()
          })
        if (isNewSession) await sending
        return
      }

      const commentItems = context.filter((item) => item.type === "file" && !!item.comment?.trim())

      const removeOptimisticMessage = () => {
        sync().session.optimistic.remove({
          directory: sessionDirectory,
          sessionID: session.id,
          messageID,
        })
      }

      removeUnchangedContextItems(commentItems)
      clearInput()

      const waitForWorktree = async () => {
        const worktree = WorktreeState.get(sdk().scope, sessionDirectory)
        if (!worktree || worktree.status !== "pending") return true

        if (sessionDirectory === projectDirectory) {
          sync().set("session_status", session.id, { type: "busy" })
        }

        const controller = new AbortController()
        const cleanup = (mode: "restore" | "discard" = "restore") => {
          if (sessionDirectory === projectDirectory) {
            sync().set("session_status", session.id, { type: "idle" })
          }
          removeOptimisticMessage()
          if (mode === "restore") {
            restoreCommentItems(commentItems)
            restoreInput()
          }
        }

        pending.set(pendingKey(session.id), { abort: controller, cleanup })

        const abortWait = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
          if (controller.signal.aborted) {
            resolve({ status: "failed", message: "aborted" })
            return
          }
          controller.signal.addEventListener(
            "abort",
            () => {
              resolve({ status: "failed", message: "aborted" })
            },
            { once: true },
          )
        })

        const timeoutMs = 5 * 60 * 1000
        const timer = { id: undefined as number | undefined }
        const timeout = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
          timer.id = window.setTimeout(() => {
            resolve({
              status: "failed",
              message: language.t("workspace.error.stillPreparing"),
            })
          }, timeoutMs)
        })

        const result = await Promise.race([
          WorktreeState.wait(sdk().scope, sessionDirectory),
          abortWait,
          timeout,
        ]).finally(() => {
          if (timer.id === undefined) return
          clearTimeout(timer.id)
        })
        pending.delete(pendingKey(session.id))
        if (controller.signal.aborted) return false
        if (result.status === "failed") throw new Error(result.message)
        return true
      }

      const sendStarted = performance.now()
      const sending = sendFollowupDraft({
        client,
        sync: sync(),
        serverSync: serverSync(),
        draft,
        messageID,
        optimisticBusy: sessionDirectory === projectDirectory,
        queued: activeFollowup,
        ...(activeFollowupDelivery ? { delivery: activeFollowupDelivery } : {}),
        before: waitForWorktree,
      })
        .then((sent) => {
          if (sent && forceSteer) input.onForceSteerSent?.()
          recordPerfEvent(server.current, {
            kind: "ui_question",
            action: "prompt_send",
            sessionID: session.id,
            messageID,
            new_session: isNewSession,
            duration_ms: performance.now() - sendStarted,
          })
          if (sent) completeAdmission()
          return sent
        })
        .catch((err) => {
          pending.delete(pendingKey(session.id))
          if (sessionDirectory === projectDirectory) {
            sync().set("session_status", session.id, { type: "idle" })
          }
          showToast({
            title: language.t("prompt.toast.promptSendFailed.title"),
            description: errorMessage(err),
          })
          removeOptimisticMessage()
          restoreCommentItems(commentItems)
          restoreInput()
          return false
        })
      if (isNewSession || options?.waitForAdmission) return await sending
    } finally {
      if (shared) {
        shared.resolveInFlight?.()
        shared.resolveInFlight = undefined
        shared.inFlight = undefined
      }
    }
  }

  let submitting = false
  const handleSubmit = (event: Event, options?: PromptSubmitOptions) => {
    event.preventDefault()
    if (submitting) return Promise.resolve()
    submitting = true
    const running = submit(options)
    void running.finally(() => {
      submitting = false
    })
    return running
  }

  return {
    abort,
    handleSubmit,
    async submitText(input: ProgrammaticPromptSubmitInput) {
      const sent = await handleSubmit({ preventDefault() {} } as Event, {
        prompt: [{ type: "text", content: input.text, start: 0, end: input.text.length }],
        context: [],
        delivery: input.delivery,
        preserveComposer: true,
        skipBeforeSubmit: true,
        waitForAdmission: true,
      })
      if (sent) return { ok: true }
      return { ok: false, error: "Composer submission was blocked" }
    },
  }
}
