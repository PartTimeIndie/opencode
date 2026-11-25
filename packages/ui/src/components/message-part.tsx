import {
  Component,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  onMount,
  Show,
  Switch,
  onCleanup,
  Index,
  type JSX,
} from "solid-js"
import { createStore } from "solid-js/store"
import stripAnsi from "strip-ansi"
import { Dynamic, Portal } from "solid-js/web"
import {
  AgentPart,
  AssistantMessage,
  type FileContent,
  FilePart,
  Message as MessageType,
  Part as PartType,
  ReasoningPart,
  Session,
  TextPart,
  ToolPart,
  UserMessage,
  Todo,
  QuestionV2Answer,
  QuestionV2Info,
  PromptFileAttachment,
} from "@opencode-ai/sdk/v2"
import { useData } from "../context"
import { useFileComponent } from "../context/file"
import { useDialog } from "../context/dialog"
import { type UiI18n, useI18n } from "../context/i18n"
import { BasicTool, GenericTool } from "./basic-tool"
import { ZoomableImage } from "./image-zoom"
import { Accordion } from "./accordion"
import { StickyAccordionHeader } from "./sticky-accordion-header"
import { Collapsible } from "./collapsible"
import { FileIcon } from "./file-icon"
import { Icon } from "./icon"
import { ToolErrorCard } from "./tool-error-card"
import { Checkbox } from "./checkbox"
import { DiffChanges } from "./diff-changes"
import { Markdown, type MarkdownImageResolver } from "./markdown"
import { ImagePreview } from "./image-preview"
import { getDirectory as _getDirectory, getFilename } from "@opencode-ai/core/util/path"
import { checksum } from "@opencode-ai/core/util/encode"
import { Tooltip } from "./tooltip"
import { IconButton } from "./icon-button"
import { Spinner } from "./spinner"
import { TextShimmer } from "./text-shimmer"
import { AnimatedCountList } from "./tool-count-summary"
import { ToolStatusTitle } from "./tool-status-title"
import { patchFiles } from "./apply-patch-file"
import { ShellSubmessage } from "./shell-submessage"
import { useLocation } from "@solidjs/router"
import { attached, contentUrl, inline, kind } from "./message-file"
import { MessageAttachmentImage } from "./message-attachment-image"
import { readPartText } from "./message-part-text"
import { findSlashCommandRanges } from "@opencode-ai/core/util/slash-command"
import { reviewerDetails } from "@opencode-ai/core/util/tool-details"

async function writeClipboard(text: string): Promise<boolean> {
  const body = typeof document === "undefined" ? undefined : document.body
  if (body) {
    const textarea = document.createElement("textarea")
    textarea.value = text
    textarea.setAttribute("readonly", "")
    textarea.style.position = "fixed"
    textarea.style.opacity = "0"
    textarea.style.pointerEvents = "none"
    body.appendChild(textarea)
    textarea.select()
    const copied = document.execCommand("copy")
    body.removeChild(textarea)
    if (copied) return true
  }

  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard
  if (!clipboard?.writeText) return false
  return clipboard.writeText(text).then(
    () => true,
    () => false,
  )
}

interface Diagnostic {
  range: {
    start: { line: number; character: number }
    end: { line: number; character: number }
  }
  message: string
  severity?: number
}

function diagnostic(value: unknown): value is Diagnostic {
  const item = record(value)
  const range = record(item?.range)
  const start = record(range?.start)
  const end = record(range?.end)
  return (
    typeof item?.message === "string" &&
    typeof start?.line === "number" &&
    typeof start?.character === "number" &&
    typeof end?.line === "number" &&
    typeof end?.character === "number" &&
    (item.severity === undefined || typeof item.severity === "number")
  )
}

function getDiagnostics(diagnosticsByFile: unknown, filePath: string | undefined): Diagnostic[] {
  if (!filePath) return []
  const diagnostics = record(diagnosticsByFile)?.[filePath]
  if (!Array.isArray(diagnostics)) return []
  return diagnostics
    .filter(diagnostic)
    .filter((d) => d.severity === 1)
    .slice(0, 3)
}

function DiagnosticsDisplay(props: { diagnostics: Diagnostic[] }): JSX.Element {
  const i18n = useI18n()
  return (
    <Show when={props.diagnostics.length > 0}>
      <div data-component="diagnostics">
        <For each={props.diagnostics}>
          {(diagnostic) => (
            <div data-slot="diagnostic">
              <span data-slot="diagnostic-label">{i18n.t("ui.messagePart.diagnostic.error")}</span>
              <span data-slot="diagnostic-location">
                [{diagnostic.range.start.line + 1}:{diagnostic.range.start.character + 1}]
              </span>
              <span data-slot="diagnostic-message">{diagnostic.message}</span>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}

export interface MessageProps {
  message: MessageType
  parts: PartType[]
  actions?: UserActions
  slashCommands?: ReadonlySet<string>
  showAssistantCopyPartID?: string | null
  showReasoningSummaries?: boolean
  customPartRenderer?: CustomPartRenderer
  readFile?: (path: string) => Promise<FileContent | undefined>
}

export type SessionAction = (input: { sessionID: string; messageID: string }) => Promise<void> | void
export type ToolCancelAction = (input: { sessionID: string; callID: string }) => Promise<void> | void

export type UserActions = {
  fork?: SessionAction
  revert?: SessionAction
  restoreCheckpoint?: SessionAction
  restoreMessage?: SessionAction
}

export interface MessagePartProps {
  part: PartType
  message: MessageType
  hideDetails?: boolean
  defaultOpen?: boolean
  toolOpen?: boolean
  onToolOpenChange?: (open: boolean) => void
  deferToolContent?: boolean
  virtualizeDiff?: boolean
  onContentRendered?: () => void
  showAssistantCopyPartID?: string | null
  turnDurationMs?: number
  turnCompletedAt?: number
  customPartRenderer?: CustomPartRenderer
  readFile?: (path: string) => Promise<FileContent | undefined>
  onToolCancel?: ToolCancelAction
}

export type PartComponent = Component<MessagePartProps>
export type CustomPart = PartType & {
  type: "custom"
  kind: string
  data: unknown
  title?: string
  fallback?: string
  metadata?: Record<string, unknown>
  time?: {
    start: number
    end?: number
  }
}
export type CustomPartRenderer = (input: { part: CustomPart; message: MessageType }) => JSX.Element | null | undefined

export const PART_MAPPING: Record<string, PartComponent | undefined> = {}

const TEXT_RENDER_PACE_MS = 24
const TEXT_RENDER_IMMEDIATE = 512
const TEXT_RENDER_SNAP = /[\s.,!?;:)\]]/

function step(size: number) {
  if (size <= 12) return 2
  if (size <= 48) return 4
  if (size <= 96) return 8
  return Math.min(256, Math.ceil(size / 4))
}

function next(text: string, start: number) {
  const end = Math.min(text.length, start + step(text.length - start))
  const max = Math.min(text.length, end + 8)
  for (let i = end; i < max; i++) {
    if (TEXT_RENDER_SNAP.test(text[i] ?? "")) return i + 1
  }
  return end
}

function createPacedValue(getValue: () => string, live?: () => boolean) {
  const [value, setValue] = createSignal(getValue())
  let shown = getValue()
  let timeout: ReturnType<typeof setTimeout> | undefined

  const clear = () => {
    if (!timeout) return
    clearTimeout(timeout)
    timeout = undefined
  }

  const sync = (text: string) => {
    shown = text
    setValue(text)
  }

  const run = () => {
    timeout = undefined
    const text = getValue()
    if (!live?.()) {
      sync(text)
      return
    }
    if (!text.startsWith(shown) || text.length <= shown.length) {
      sync(text)
      return
    }
    if (text.length - shown.length <= TEXT_RENDER_IMMEDIATE) {
      sync(text)
      return
    }
    const end = next(text, shown.length)
    sync(text.slice(0, end))
    if (end < text.length) timeout = setTimeout(run, TEXT_RENDER_PACE_MS)
  }

  createEffect(() => {
    const text = getValue()
    if (!live?.()) {
      clear()
      sync(text)
      return
    }
    if (!text.startsWith(shown) || text.length < shown.length) {
      clear()
      sync(text)
      return
    }
    if (text.length - shown.length <= TEXT_RENDER_IMMEDIATE) {
      clear()
      sync(text)
      return
    }
    if (text.length === shown.length || timeout) return
    timeout = setTimeout(run, TEXT_RENDER_PACE_MS)
  })

  onCleanup(() => {
    clear()
  })

  return value
}

function PacedMarkdown(props: {
  text: string
  cacheKey: string
  streaming: boolean
  resolveImageSrc?: MarkdownImageResolver
  readFile?: (path: string) => Promise<FileContent | undefined>
}) {
  const value = createPacedValue(
    () => props.text,
    () => props.streaming,
  )

  return (
    <Show when={value()}>
      <Markdown
        text={value()}
        cacheKey={props.cacheKey}
        streaming={props.streaming}
        resolveImageSrc={props.resolveImageSrc}
        readFile={props.readFile}
      />
    </Show>
  )
}

function relativizeProjectPath(path: string, directory?: string) {
  if (!path) return ""
  if (!directory) return path
  if (directory === "/") return path
  if (directory === "\\") return path
  if (path === directory) return ""

  const separator = directory.includes("\\") ? "\\" : "/"
  const prefix = directory.endsWith(separator) ? directory : directory + separator
  if (!path.startsWith(prefix)) return path
  return path.slice(directory.length)
}

function getDirectory(path: string | undefined) {
  const data = useData()
  return relativizeProjectPath(_getDirectory(path), data.directory)
}

import type { IconProps } from "./icon"
import { normalize, resolveFileDiff } from "./session-diff"

export type ToolInfo = {
  icon: IconProps["name"]
  title: string
  subtitle?: string
}

function agentTitle(i18n: UiI18n, type?: string) {
  if (!type) return i18n.t("ui.tool.agent.default")
  return i18n.t("ui.tool.agent", { type })
}

const agentTones: Record<string, string> = {
  ask: "var(--icon-agent-ask-base)",
  build: "var(--icon-agent-build-base)",
  docs: "var(--icon-agent-docs-base)",
  plan: "var(--icon-agent-plan-base)",
}

const agentPalette = [
  "var(--icon-agent-ask-base)",
  "var(--icon-agent-build-base)",
  "var(--icon-agent-docs-base)",
  "var(--icon-agent-plan-base)",
  "var(--syntax-info)",
  "var(--syntax-success)",
  "var(--syntax-warning)",
  "var(--syntax-property)",
  "var(--syntax-constant)",
  "var(--text-diff-add-base)",
  "var(--text-diff-delete-base)",
  "var(--icon-warning-base)",
]

function tone(name: string) {
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return agentPalette[hash % agentPalette.length]
}

function taskAgent(
  raw: unknown,
  list?: readonly { name: string; color?: string }[],
): { name?: string; color?: string } {
  if (typeof raw !== "string" || !raw) return {}
  const key = raw.toLowerCase()
  const item = list?.find((entry) => entry.name === raw || entry.name.toLowerCase() === key)
  return {
    name: item?.name ?? `${raw[0]!.toUpperCase()}${raw.slice(1)}`,
    color: item?.color ?? agentTones[key] ?? tone(key),
  }
}

function webSearchProviderLabel(provider: unknown) {
  if (provider === "parallel") return "Parallel Web Search"
  if (provider === "exa") return "Exa Web Search"
  return "Web Search"
}

function stringField(input: Record<string, unknown>, key: string) {
  const value = input[key]
  return typeof value === "string" ? value : undefined
}

function numberField(input: Record<string, unknown>, key: string) {
  const value = input[key]
  return typeof value === "number" ? value : undefined
}

function toolPath(input: Record<string, unknown>) {
  return stringField(input, "filePath") ?? stringField(input, "path")
}

type ToolFileDiff = {
  file?: string
  patch?: string
  before?: string
  after?: string
  additions?: number
  deletions?: number
}

function toolFileDiff(value: unknown): ToolFileDiff | undefined {
  const item = record(value)
  if (!item) return
  return {
    file: stringField(item, "file"),
    patch: stringField(item, "patch"),
    before: stringField(item, "before"),
    after: stringField(item, "after"),
    additions: numberField(item, "additions"),
    deletions: numberField(item, "deletions"),
  }
}

function diffChanges(value: ToolFileDiff | undefined) {
  if (!value) return
  return { additions: value.additions ?? 0, deletions: value.deletions ?? 0 }
}

export function getToolInfo(
  tool: string,
  input: Record<string, unknown> = {},
  metadata: Record<string, unknown> | undefined = {},
): ToolInfo {
  const i18n = useI18n()
  const filePath = stringField(input, "filePath")
  const path = stringField(input, "path")
  const pattern = stringField(input, "pattern")
  const description = stringField(input, "description")
  switch (tool) {
    case "read":
      return {
        icon: "glasses",
        title: i18n.t("ui.tool.read"),
        subtitle: filePath ? getFilename(filePath) : undefined,
      }
    case "list":
      return {
        icon: "bullet-list",
        title: i18n.t("ui.tool.list"),
        subtitle: path ? getFilename(path) : undefined,
      }
    case "glob":
      return {
        icon: "magnifying-glass-menu",
        title: i18n.t("ui.tool.glob"),
        subtitle: pattern,
      }
    case "grep":
      return {
        icon: "magnifying-glass-menu",
        title: i18n.t("ui.tool.grep"),
        subtitle: pattern,
      }
    case "webfetch":
      return {
        icon: "window-cursor",
        title: i18n.t("ui.tool.webfetch"),
        subtitle: stringField(input, "url"),
      }
    case "websearch":
      return {
        icon: "window-cursor",
        title: webSearchProviderLabel(metadata?.provider),
        subtitle: stringField(input, "query"),
      }
    case "task": {
      const type =
        typeof input.subagent_type === "string" && input.subagent_type
          ? input.subagent_type[0]!.toUpperCase() + input.subagent_type.slice(1)
          : undefined
      return {
        icon: "task",
        title: agentTitle(i18n, type),
        subtitle: description,
      }
    }
    case "bash":
      return {
        icon: "console",
        title: i18n.t("ui.tool.shell"),
        subtitle: description,
      }
    case "edit":
      return {
        icon: "code-lines",
        title: i18n.t("ui.messagePart.title.edit"),
        subtitle: filePath ? getFilename(filePath) : undefined,
      }
    case "write":
      return {
        icon: "code-lines",
        title: i18n.t("ui.messagePart.title.write"),
        subtitle: filePath ? getFilename(filePath) : undefined,
      }
    case "apply_patch": {
      const files = Array.isArray(input.files) ? input.files : []
      return {
        icon: "code-lines",
        title: i18n.t("ui.tool.patch"),
        subtitle: files.length
          ? `${files.length} ${i18n.t(files.length > 1 ? "ui.common.file.other" : "ui.common.file.one")}`
          : undefined,
      }
    }
    case "todowrite":
      return {
        icon: "checklist",
        title: i18n.t("ui.tool.todos"),
      }
    case "question":
      return {
        icon: "bubble-5",
        title: i18n.t("ui.tool.questions"),
      }
    case "skill":
      return {
        icon: "brain",
        title: stringField(input, "name") || i18n.t("ui.tool.skill"),
      }
    default:
      return {
        icon: "mcp",
        title: tool,
      }
  }
}

function urls(text: string | undefined) {
  if (!text) return []
  const seen = new Set<string>()
  return [...text.matchAll(/https?:\/\/[^\s<>"'`)\]]+/g)]
    .map((item) => item[0].replace(/[),.;:!?]+$/g, ""))
    .filter((item) => {
      if (seen.has(item)) return false
      seen.add(item)
      return true
    })
}

function sessionLink(id: string | undefined, path: string, href?: (id: string) => string | undefined) {
  if (!id) return

  const direct = href?.(id)
  if (direct) return direct

  const idx = path.indexOf("/session")
  if (idx === -1) return
  return `${path.slice(0, idx)}/session/${id}`
}

function taskSessionID(metadata: Record<string, unknown>) {
  const value = metadata.task_id ?? metadata.sessionID ?? metadata.sessionId
  if (typeof value === "string" && value) return value
}

function taskSession(input: Record<string, unknown>, parentID: string | undefined, sessions: Session[] | undefined) {
  if (!parentID) return
  const description = typeof input.description === "string" ? input.description : ""
  const agent = typeof input.subagent_type === "string" ? input.subagent_type.toLowerCase() : ""
  return (sessions ?? [])
    .filter((session) => session.parentID === parentID && !session.time?.archived)
    .filter((session) => (description ? session.title.startsWith(description) : true))
    .filter((session) => (agent ? session.title.toLowerCase().includes(`@${agent}`) : true))
    .sort((a, b) => (b.time.created ?? 0) - (a.time.created ?? 0))[0]?.id
}

const CONTEXT_GROUP_TOOLS = new Set(["read", "glob", "grep", "list"])
const HIDDEN_TOOLS = new Set(["todowrite"])

function list<T>(value: T[] | undefined | null, fallback: T[]) {
  if (Array.isArray(value)) return value
  return fallback
}

function same<T>(a: readonly T[] | undefined, b: readonly T[] | undefined) {
  if (a === b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  return a.every((x, i) => x === b[i])
}

export type PartRef = {
  messageID: string
  partID: string
}

export type PartGroup =
  | {
      key: string
      type: "part"
      ref: PartRef
    }
  | {
      key: string
      type: "context"
      refs: PartRef[]
    }

function sameRef(a: PartRef, b: PartRef) {
  return a.messageID === b.messageID && a.partID === b.partID
}

function sameGroup(a: PartGroup, b: PartGroup) {
  if (a === b) return true
  if (a.key !== b.key) return false
  if (a.type !== b.type) return false
  if (a.type === "part") {
    if (b.type !== "part") return false
    return sameRef(a.ref, b.ref)
  }
  if (b.type !== "context") return false
  if (a.refs.length !== b.refs.length) return false
  return a.refs.every((ref, i) => sameRef(ref, b.refs[i]!))
}

export function sameGroups(a: readonly PartGroup[] | undefined, b: readonly PartGroup[] | undefined) {
  if (a === b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  return a.every((item, i) => sameGroup(item, b[i]!))
}

export function groupParts(parts: { messageID: string; part: PartType }[]) {
  const result: PartGroup[] = []
  let start = -1

  const flush = (end: number) => {
    if (start < 0) return
    const first = parts[start]
    const last = parts[end]
    if (!first || !last) {
      start = -1
      return
    }
    result.push({
      key: `context:${first.part.id}`,
      type: "context",
      refs: parts.slice(start, end + 1).map((item) => ({
        messageID: item.messageID,
        partID: item.part.id,
      })),
    })
    start = -1
  }

  parts.forEach((item, index) => {
    if (isContextGroupTool(item.part)) {
      if (start < 0) start = index
      return
    }

    flush(index - 1)
    result.push({
      key: `part:${item.messageID}:${item.part.id}`,
      type: "part",
      ref: {
        messageID: item.messageID,
        partID: item.part.id,
      },
    })
  })

  flush(parts.length - 1)
  return result
}

function index<T extends { id: string }>(items: readonly T[]) {
  return new Map(items.map((item) => [item.id, item] as const))
}

export function renderable(part: PartType, showReasoningSummaries = true) {
  if (part.type === "tool") {
    if (HIDDEN_TOOLS.has(part.tool)) return false
    return true
  }
  if (part.type === "text") return !!part.text?.trim()
  if (part.type === "reasoning") return showReasoningSummaries && !!part.text?.trim()
  if (part.type === "custom") return true
  return !!PART_MAPPING[part.type]
}

function toolDefaultOpen(tool: string, shell = false, edit = false) {
  if (tool === "bash") return shell
  if (tool === "edit" || tool === "write" || tool === "apply_patch") return edit
}

export function partDefaultOpen(part: PartType, shell = false, edit = false) {
  if (part.type !== "tool") return
  return toolDefaultOpen(part.tool, shell, edit)
}

function toolRunning(part: ToolPart) {
  return part.state.status === "pending" || part.state.status === "running"
}

function toolCancellable(part: ToolPart) {
  return part.state.status === "running"
}

function toolStartTime(part: ToolPart) {
  return "time" in part.state ? part.state.time.start : undefined
}

export function AssistantParts(props: {
  messages: AssistantMessage[]
  showAssistantCopyPartID?: string | null
  turnDurationMs?: number
  turnCompletedAt?: number
  working?: boolean
  showReasoningSummaries?: boolean
  shellToolDefaultOpen?: boolean
  editToolDefaultOpen?: boolean
  customPartRenderer?: CustomPartRenderer
  readFile?: (path: string) => Promise<FileContent | undefined>
}) {
  const data = useData()
  const emptyParts: PartType[] = []
  const emptyTools: ToolPart[] = []
  const msgs = createMemo(() => index(props.messages))
  const part = createMemo(
    () =>
      new Map(
        props.messages.map((message) => [message.id, index(list(data.store.part?.[message.id], emptyParts))] as const),
      ),
  )

  const grouped = createMemo(
    () =>
      groupParts(
        props.messages.flatMap((message) =>
          list(data.store.part?.[message.id], emptyParts)
            .filter((part) => renderable(part, props.showReasoningSummaries ?? true))
            .map((part) => ({
              messageID: message.id,
              part,
            })),
        ),
      ),
    [] as PartGroup[],
    { equals: sameGroups },
  )

  const last = createMemo(() => grouped().at(-1)?.key)

  return (
    <Index each={grouped()}>
      {(entryAccessor) => {
        const entryType = createMemo(() => entryAccessor().type)

        return (
          <Switch>
            <Match when={entryType() === "context"}>
              {(() => {
                const parts = createMemo(
                  () => {
                    const entry = entryAccessor()
                    if (entry.type !== "context") return emptyTools
                    return entry.refs
                      .map((ref) => part().get(ref.messageID)?.get(ref.partID))
                      .filter((part): part is ToolPart => !!part && isContextGroupTool(part))
                  },
                  emptyTools,
                  { equals: same },
                )
                const busy = createMemo(() => props.working && last() === entryAccessor().key)

                return (
                  <Show when={parts().length > 0}>
                    <ContextToolGroup parts={parts()} busy={busy()} />
                  </Show>
                )
              })()}
            </Match>
            <Match when={entryType() === "part"}>
              {(() => {
                const message = createMemo(() => {
                  const entry = entryAccessor()
                  if (entry.type !== "part") return
                  return msgs().get(entry.ref.messageID)
                })
                const item = createMemo(() => {
                  const entry = entryAccessor()
                  if (entry.type !== "part") return
                  return part().get(entry.ref.messageID)?.get(entry.ref.partID)
                })

                return (
                  <Show when={message()}>
                    <Show when={item()}>
                      <Part
                        part={item()!}
                        message={message()!}
                        showAssistantCopyPartID={props.showAssistantCopyPartID}
                        turnDurationMs={props.turnDurationMs}
                        turnCompletedAt={props.turnCompletedAt}
                        defaultOpen={partDefaultOpen(item()!, props.shellToolDefaultOpen, props.editToolDefaultOpen)}
                        customPartRenderer={props.customPartRenderer}
                        readFile={props.readFile}
                      />
                    </Show>
                  </Show>
                )
              })()}
            </Match>
          </Switch>
        )
      }}
    </Index>
  )
}

function isContextGroupTool(part: PartType): part is ToolPart {
  return part.type === "tool" && CONTEXT_GROUP_TOOLS.has(part.tool)
}

function contextToolDetail(part: ToolPart): string | undefined {
  const info = getToolInfo(
    part.tool,
    part.state.input ?? {},
    "metadata" in part.state ? part.state.metadata : undefined,
  )
  if (info.subtitle) return info.subtitle
  if (part.state.status === "error") return part.state.error
  if ((part.state.status === "running" || part.state.status === "completed") && part.state.title)
    return part.state.title
  const description = part.state.input?.description
  if (typeof description === "string") return description
  return undefined
}

function contextToolTrigger(part: ToolPart, i18n: ReturnType<typeof useI18n>) {
  const input = (part.state.input ?? {}) as Record<string, unknown>
  const path = typeof input.path === "string" ? input.path : "/"
  const filePath = typeof input.filePath === "string" ? input.filePath : undefined
  const pattern = typeof input.pattern === "string" ? input.pattern : undefined
  const include = typeof input.include === "string" ? input.include : undefined
  const offset = typeof input.offset === "number" ? input.offset : undefined
  const limit = typeof input.limit === "number" ? input.limit : undefined

  switch (part.tool) {
    case "read": {
      const args: string[] = []
      if (offset !== undefined) args.push("offset=" + offset)
      if (limit !== undefined) args.push("limit=" + limit)
      return {
        title: i18n.t("ui.tool.read"),
        subtitle: filePath ? getFilename(filePath) : "",
        args,
      }
    }
    case "list":
      return {
        title: i18n.t("ui.tool.list"),
        subtitle: getDirectory(path),
      }
    case "glob":
      return {
        title: i18n.t("ui.tool.glob"),
        subtitle: getDirectory(path),
        args: pattern ? ["pattern=" + pattern] : [],
      }
    case "grep": {
      const args: string[] = []
      if (pattern) args.push("pattern=" + pattern)
      if (include) args.push("include=" + include)
      return {
        title: i18n.t("ui.tool.grep"),
        subtitle: getDirectory(path),
        args,
      }
    }
    default: {
      const info = getToolInfo(part.tool, input, "metadata" in part.state ? part.state.metadata : undefined)
      return {
        title: info.title,
        subtitle: info.subtitle || contextToolDetail(part),
        args: [],
      }
    }
  }
}

function contextToolSummary(parts: ToolPart[]) {
  const read = parts.filter((part) => part.tool === "read").length
  const search = parts.filter((part) => part.tool === "glob" || part.tool === "grep").length
  const list = parts.filter((part) => part.tool === "list").length
  return { read, search, list }
}

function ExaOutput(props: { output?: string }) {
  const links = createMemo(() => urls(props.output))

  return (
    <Show when={links().length > 0}>
      <div data-component="exa-tool-output">
        <div data-slot="exa-tool-links">
          <For each={links()}>
            {(url) => (
              <a
                data-slot="exa-tool-link"
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => event.stopPropagation()}
              >
                {url}
              </a>
            )}
          </For>
        </div>
      </div>
    </Show>
  )
}

export function registerPartComponent(type: string, component: PartComponent) {
  PART_MAPPING[type] = component
}

export function Message(props: MessageProps) {
  return (
    <Switch>
      <Match when={props.message.role === "user" && props.message}>
        {(userMessage) => (
          <UserMessageDisplay
            message={userMessage() as UserMessage}
            parts={props.parts}
            actions={props.actions}
            slashCommands={props.slashCommands}
          />
        )}
      </Match>
      <Match when={props.message.role === "assistant" && props.message}>
        {(assistantMessage) => (
          <AssistantMessageDisplay
            message={assistantMessage() as AssistantMessage}
            parts={props.parts}
            showAssistantCopyPartID={props.showAssistantCopyPartID}
            showReasoningSummaries={props.showReasoningSummaries}
            customPartRenderer={props.customPartRenderer}
            readFile={props.readFile}
          />
        )}
      </Match>
    </Switch>
  )
}

export function AssistantMessageDisplay(props: {
  message: AssistantMessage
  parts: PartType[]
  showAssistantCopyPartID?: string | null
  showReasoningSummaries?: boolean
  customPartRenderer?: CustomPartRenderer
  readFile?: (path: string) => Promise<FileContent | undefined>
}) {
  const emptyTools: ToolPart[] = []
  const part = createMemo(() => index(props.parts))
  const grouped = createMemo(
    () =>
      groupParts(
        props.parts
          .filter((part) => renderable(part, props.showReasoningSummaries ?? true))
          .map((part) => ({
            messageID: props.message.id,
            part,
          })),
      ),
    [] as PartGroup[],
    { equals: sameGroups },
  )

  return (
    <Index each={grouped()}>
      {(entryAccessor) => {
        const entryType = createMemo(() => entryAccessor().type)

        return (
          <Switch>
            <Match when={entryType() === "context"}>
              {(() => {
                const parts = createMemo(
                  () => {
                    const entry = entryAccessor()
                    if (entry.type !== "context") return emptyTools
                    return entry.refs
                      .map((ref) => part().get(ref.partID))
                      .filter((part): part is ToolPart => !!part && isContextGroupTool(part))
                  },
                  emptyTools,
                  { equals: same },
                )

                return (
                  <Show when={parts().length > 0}>
                    <ContextToolGroup parts={parts()} />
                  </Show>
                )
              })()}
            </Match>
            <Match when={entryType() === "part"}>
              {(() => {
                const item = createMemo(() => {
                  const entry = entryAccessor()
                  if (entry.type !== "part") return
                  return part().get(entry.ref.partID)
                })

                return (
                  <Show when={item()}>
                    <Part
                      part={item()!}
                      message={props.message}
                      showAssistantCopyPartID={props.showAssistantCopyPartID}
                      customPartRenderer={props.customPartRenderer}
                      readFile={props.readFile}
                    />
                  </Show>
                )
              })()}
            </Match>
          </Switch>
        )
      }}
    </Index>
  )
}

export function ContextToolGroup(props: {
  parts: ToolPart[]
  busy?: boolean
  onSizeChange?: () => void
  onToolCancel?: ToolCancelAction
}) {
  const i18n = useI18n()
  const [open, setOpen] = createSignal(false)
  const timefmt = createMemo(() => new Intl.DateTimeFormat(i18n.locale(), { timeStyle: "medium" }))
  const pending = createMemo(() => !!props.busy || props.parts.some(toolRunning))
  const summary = createMemo(() => contextToolSummary(props.parts))
  const handleOpenChange = (value: boolean) => {
    setOpen(value)
    props.onSizeChange?.()
  }
  const startTitle = (part: ToolPart) => {
    const start = toolStartTime(part)
    if (start === undefined) return
    return i18n.t("ui.messagePart.tool.startedAt", { time: timefmt().format(start) })
  }
  const cancelTool = (part: ToolPart, event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    void props.onToolCancel?.({ sessionID: part.sessionID, callID: part.callID || part.id })
  }

  return (
    <Collapsible
      open={open()}
      onOpenChange={handleOpenChange}
      variant="ghost"
      class="tool-collapsible"
      data-timeline-part-ids={props.parts.map((part) => part.id).join(",")}
    >
      <Collapsible.Trigger>
        <div data-component="context-tool-group-trigger">
          <span
            data-slot="context-tool-group-title"
            class="min-w-0 flex items-center gap-2 text-14-medium text-text-strong"
          >
            <span data-slot="context-tool-group-label" class="shrink-0">
              <ToolStatusTitle
                active={pending()}
                activeText={i18n.t("ui.sessionTurn.status.gatheringContext")}
                doneText={i18n.t("ui.sessionTurn.status.gatheredContext")}
                split={false}
              />
            </span>
            <span
              data-slot="context-tool-group-summary"
              class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-normal text-text-base"
            >
              <AnimatedCountList
                items={[
                  {
                    key: "read",
                    count: summary().read,
                    one: i18n.t("ui.messagePart.context.read.one"),
                    other: i18n.t("ui.messagePart.context.read.other"),
                  },
                  {
                    key: "search",
                    count: summary().search,
                    one: i18n.t("ui.messagePart.context.search.one"),
                    other: i18n.t("ui.messagePart.context.search.other"),
                  },
                  {
                    key: "list",
                    count: summary().list,
                    one: i18n.t("ui.messagePart.context.list.one"),
                    other: i18n.t("ui.messagePart.context.list.other"),
                  },
                ]}
                fallback=""
              />
            </span>
          </span>
          <Collapsible.Arrow />
        </div>
      </Collapsible.Trigger>
      <Collapsible.Content>
        <div data-component="context-tool-group-list">
          <Index each={props.parts}>
            {(partAccessor) => {
              const trigger = createMemo(() => contextToolTrigger(partAccessor(), i18n))
              const running = createMemo(() => toolRunning(partAccessor()))
              const cancellable = createMemo(() => toolCancellable(partAccessor()))
              return (
                <div data-slot="context-tool-group-item">
                  <div data-component="tool-trigger" title={startTitle(partAccessor())}>
                    <div data-slot="basic-tool-tool-trigger-content">
                      <div data-slot="basic-tool-tool-info">
                        <div data-slot="basic-tool-tool-info-structured">
                          <div data-slot="basic-tool-tool-info-main">
                            <span data-slot="basic-tool-tool-title">
                              <TextShimmer text={trigger().title} active={running()} />
                            </span>
                            <Show when={!running() && trigger().subtitle}>
                              <span data-slot="basic-tool-tool-subtitle">{trigger().subtitle}</span>
                            </Show>
                            <Show when={!running() && trigger().args?.length}>
                              <For each={trigger().args}>
                                {(arg) => <span data-slot="basic-tool-tool-arg">{arg}</span>}
                              </For>
                            </Show>
                          </div>
                        </div>
                      </div>
                    </div>
                    <Show when={cancellable() && props.onToolCancel}>
                      <span data-slot="basic-tool-tool-action">
                        <Tooltip value={i18n.t("ui.messagePart.tool.cancel")} placement="top" gutter={4}>
                          <IconButton
                            icon="stop"
                            size="small"
                            variant="ghost"
                            aria-label={i18n.t("ui.messagePart.tool.cancel")}
                            onClick={(event) => cancelTool(partAccessor(), event)}
                          />
                        </Tooltip>
                      </span>
                    </Show>
                  </div>
                </div>
              )
            }}
          </Index>
        </div>
      </Collapsible.Content>
    </Collapsible>
  )
}

function UserMessageAttachment(props: { file: FilePart; onOpenImage: (part: FilePart, alt: string) => void }) {
  const i18n = useI18n()
  const data = useData()
  const fileKind = () => kind(props.file)
  const name = () => props.file.filename ?? i18n.t("ui.message.attachment.alt")
  const [url] = createResource(
    () => (fileKind() === "image" ? undefined : props.file),
    (file) => data.resolveMediaUrl?.(file, "content") ?? contentUrl(file),
  )

  return (
    <div
      data-slot="user-message-attachment"
      data-type={fileKind()}
      data-clickable={fileKind() === "image" ? "true" : undefined}
      title={fileKind() === "file" ? name() : undefined}
      onClick={() => {
        if (fileKind() === "image") props.onOpenImage(props.file, name())
      }}
    >
      <Switch>
        <Match when={fileKind() === "image"}>
          <MessageAttachmentImage part={props.file} slot="user-message-attachment-image" alt={name()} />
        </Match>
        <Match when={fileKind() === "video"}>
          <video data-slot="user-message-attachment-video" src={url()} controls preload="metadata" />
        </Match>
        <Match when={fileKind() === "audio"}>
          <audio data-slot="user-message-attachment-audio" src={url()} controls preload="metadata" />
        </Match>
        <Match when={fileKind() === "file"}>
          <a data-slot="user-message-attachment-file" href={url()} download={name()}>
            <FileIcon node={{ path: name(), type: "file" }} />
            <span data-slot="user-message-attachment-name">{name()}</span>
          </a>
        </Match>
      </Switch>
    </div>
  )
}

export function UserMessageDisplay(props: {
  message: UserMessage
  parts: PartType[]
  actions?: UserActions
  slashCommands?: ReadonlySet<string>
}) {
  const data = useData()
  const dialog = useDialog()
  const i18n = useI18n()
  const [state, setState] = createStore({
    copied: false,
    busy: false,
  })
  const copied = () => state.copied
  const busy = () => state.busy

  const textPart = createMemo(
    () => props.parts?.find((p) => p.type === "text" && !(p as TextPart).synthetic) as TextPart | undefined,
  )

  const text = createMemo(() => textPart()?.text || "")

  const files = createMemo(() => (props.parts?.filter((p) => p.type === "file") as FilePart[]) ?? [])

  const attachments = createMemo(() => files().filter(attached))

  const inlineFiles = createMemo(() => files().filter(inline))

  const agents = createMemo(() => (props.parts?.filter((p) => p.type === "agent") as AgentPart[]) ?? [])

  const model = createMemo(() => {
    const providerID = props.message.model?.providerID
    const modelID = props.message.model?.modelID
    if (!providerID || !modelID) return ""
    const match = data.store.provider?.all?.get(providerID)
    return match?.models?.[modelID]?.name ?? modelID
  })
  const timefmt = createMemo(() => new Intl.DateTimeFormat(i18n.locale(), { timeStyle: "short" }))

  const stamp = createMemo(() => {
    const created = props.message.time?.created
    if (typeof created !== "number") return ""
    return timefmt().format(created)
  })

  const metaHead = createMemo(() => {
    const agent = props.message.agent
    const items = [agent ? agent[0]?.toUpperCase() + agent.slice(1) : "", model()]
    return items.filter((x) => !!x).join("\u00A0\u00B7\u00A0")
  })

  const metaTail = stamp

  const openImagePreview = (part: FilePart, alt?: string) => {
    void Promise.resolve(data.resolveMediaUrl?.(part, "content") ?? contentUrl(part)).then((url) => {
      dialog.show(() => <ImagePreview src={url} alt={alt} annotateLabel={data.annotateImageLabel} onAnnotate={data.onAnnotateImage && !proofAttachmentUrl(part.url) && /^image\/(png|jpeg|webp)$/.test(part.mime) ? () => { dialog.close(); data.onAnnotateImage?.(part) } : undefined} />)
    })
  }

  const handleCopy = async () => {
    const content = text()
    if (!content) return
    if (await writeClipboard(content)) {
      setState("copied", true)
      setTimeout(() => setState("copied", false), 2000)
    }
  }

  const runAction = (act?: SessionAction) => {
    if (!act || busy()) return
    setState("busy", true)
    void Promise.resolve()
      .then(() =>
        act({
          sessionID: props.message.sessionID,
          messageID: props.message.id,
        }),
      )
      .finally(() => setState("busy", false))
  }

  return (
    <div data-component="user-message" data-timeline-part-id={textPart()?.id}>
      <Show when={attachments().length > 0}>
        <div data-slot="user-message-attachments">
          <For each={attachments()}>
            {(file) => <UserMessageAttachment file={file} onOpenImage={openImagePreview} />}
          </For>
        </div>
      </Show>
      <Show when={text()}>
        <>
          <div data-slot="user-message-body">
            <div data-slot="user-message-text">
              <HighlightedText
                text={text()}
                references={inlineFiles()}
                agents={agents()}
                slashCommands={props.slashCommands}
              />
            </div>
          </div>
          <div data-slot="user-message-copy-wrapper">
            <Show when={metaHead() || metaTail()}>
              <span data-slot="user-message-meta-wrap">
                <Show when={metaHead()}>
                  <span data-slot="user-message-meta" class="text-12-regular text-text-weak cursor-default">
                    {metaHead()}
                  </span>
                </Show>
                <Show when={metaHead() && metaTail()}>
                  <span data-slot="user-message-meta-sep" class="text-12-regular text-text-weak cursor-default">
                    {"\u00A0\u00B7\u00A0"}
                  </span>
                </Show>
                <Show when={metaTail()}>
                  <span data-slot="user-message-meta-tail" class="text-12-regular text-text-weak cursor-default">
                    {metaTail()}
                  </span>
                </Show>
              </span>
            </Show>
            <Show when={props.actions?.fork}>
              <Tooltip value={i18n.t("command.session.fork")} placement="top" gutter={4}>
                <IconButton
                  icon="fork"
                  size="normal"
                  variant="ghost"
                  disabled={busy()}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(event) => {
                    event.stopPropagation()
                    runAction(props.actions?.fork)
                  }}
                  aria-label={i18n.t("command.session.fork")}
                />
              </Tooltip>
            </Show>
            <Show when={props.actions?.restoreMessage}>
              <Tooltip value={i18n.t("ui.message.restoreMessage")} placement="top" gutter={4}>
                <IconButton
                  icon="prompt"
                  size="normal"
                  variant="ghost"
                  disabled={busy()}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(event) => {
                    event.stopPropagation()
                    runAction(props.actions?.restoreMessage)
                  }}
                  aria-label={i18n.t("ui.message.restoreMessage")}
                />
              </Tooltip>
            </Show>
            <Show when={props.actions?.restoreCheckpoint}>
              <Tooltip value={i18n.t("ui.message.restoreCheckpoint")} placement="top" gutter={4}>
                <IconButton
                  icon="branch"
                  size="normal"
                  variant="ghost"
                  disabled={busy()}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(event) => {
                    event.stopPropagation()
                    runAction(props.actions?.restoreCheckpoint)
                  }}
                  aria-label={i18n.t("ui.message.restoreCheckpoint")}
                />
              </Tooltip>
            </Show>
            <Show when={props.actions?.revert}>
              <Tooltip
                value={
                  props.actions?.restoreMessage || props.actions?.restoreCheckpoint
                    ? i18n.t("ui.message.restoreBoth")
                    : i18n.t("ui.message.revertMessage")
                }
                placement="top"
                gutter={4}
              >
                <IconButton
                  icon="reset"
                  size="normal"
                  variant="ghost"
                  disabled={busy()}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(event) => {
                    event.stopPropagation()
                    runAction(props.actions?.revert)
                  }}
                  aria-label={
                    props.actions?.restoreMessage || props.actions?.restoreCheckpoint
                      ? i18n.t("ui.message.restoreBoth")
                      : i18n.t("ui.message.revertMessage")
                  }
                />
              </Tooltip>
            </Show>
            <Tooltip
              value={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copyMessage")}
              placement="top"
              gutter={4}
            >
              <IconButton
                icon={copied() ? "check" : "copy"}
                size="normal"
                variant="ghost"
                onMouseDown={(e) => e.preventDefault()}
                onClick={(event) => {
                  event.stopPropagation()
                  void handleCopy()
                }}
                aria-label={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copyMessage")}
              />
            </Tooltip>
          </div>
        </>
      </Show>
    </div>
  )
}

type HighlightSegment = { text: string; type?: "file" | "agent" | "slash" }

function HighlightedText(props: {
  text: string
  references: FilePart[]
  agents: AgentPart[]
  slashCommands?: ReadonlySet<string>
}) {
  const segments = createMemo(() => {
    const text = props.text

    const references: { start: number; end: number; type: "file" | "agent" }[] = [
      ...props.references
        .filter((r) => r.source?.text?.start !== undefined && r.source?.text?.end !== undefined)
        .map((r) => ({ start: r.source!.text!.start, end: r.source!.text!.end, type: "file" as const })),
      ...props.agents
        .filter((a) => a.source?.start !== undefined && a.source?.end !== undefined)
        .map((a) => ({ start: a.source!.start, end: a.source!.end, type: "agent" as const })),
    ].sort((a, b) => a.start - b.start)
    const slash = findSlashCommandRanges(text, props.slashCommands ?? new Set()).filter(
      (range) => !references.some((ref) => range.start < ref.end && range.end > ref.start),
    )
    const allRefs = [...references, ...slash.map((range) => ({ ...range, type: "slash" as const }))].sort(
      (a, b) => a.start - b.start,
    )

    const result: HighlightSegment[] = []
    let lastIndex = 0

    for (const ref of allRefs) {
      if (ref.start < lastIndex) continue

      if (ref.start > lastIndex) {
        result.push({ text: text.slice(lastIndex, ref.start) })
      }

      result.push({ text: text.slice(ref.start, ref.end), type: ref.type })
      lastIndex = ref.end
    }

    if (lastIndex < text.length) {
      result.push({ text: text.slice(lastIndex) })
    }

    return result
  })

  return <For each={segments()}>{(segment) => <span data-highlight={segment.type}>{segment.text}</span>}</For>
}

export function Part(props: MessagePartProps) {
  const component = createMemo(() => PART_MAPPING[props.part.type])
  return (
    <Show when={component()}>
      <Dynamic
        component={component()}
        part={props.part}
        message={props.message}
        hideDetails={props.hideDetails}
        defaultOpen={props.defaultOpen}
        toolOpen={props.toolOpen}
        onToolOpenChange={props.onToolOpenChange}
        deferToolContent={props.deferToolContent}
        virtualizeDiff={props.virtualizeDiff}
        onContentRendered={props.onContentRendered}
        showAssistantCopyPartID={props.showAssistantCopyPartID}
        turnDurationMs={props.turnDurationMs}
        turnCompletedAt={props.turnCompletedAt}
        customPartRenderer={props.customPartRenderer}
        readFile={props.readFile}
        onToolCancel={props.onToolCancel}
      />
    </Show>
  )
}

// Feature 2 — render assistant-side file parts (tool-result attachments, e.g.
// from the `attach` tool or `read` on images/PDFs). Previously these parts had
// no mapping and were invisible on the assistant side. Images open a fullscreen
// overlay; videos get an inline player + fullscreen; other files get a card.
PART_MAPPING["file"] = function FilePartDisplay(props) {
  const i18n = useI18n()
  const data = useData()
  const part = () => props.part as FilePart
  const fileKind = () => kind(part())
  const name = () => part().filename ?? i18n.t("ui.message.attachment.alt")
  const proof = () => proofAttachmentUrl(part().url)
  const [url] = createResource(part, (value) => data.resolveMediaUrl?.(value, "content") ?? contentUrl(value))
  const [open, setOpen] = createSignal(false)

  return (
    <div
      data-component="assistant-attachment"
      data-kind={fileKind()}
      data-timeline-part-id={part().id}
      class="my-1.5 max-w-full"
    >
      <Show when={proof()}>
        <span class="mb-1 inline-flex w-fit rounded-full border border-border-weak-base px-2 py-0.5 text-11-medium uppercase tracking-wide text-text-weak">
          Proof
        </span>
      </Show>
      <Show
        when={fileKind() === "image"}
        fallback={
          <Show
            when={fileKind() === "video"}
            fallback={
              <a
                data-attachment-kind="file"
                class="inline-flex items-center gap-2 rounded-lg border border-border-weak-base px-3 py-2 text-13-medium text-text-strong hover:bg-surface-raised-base-hover"
                href={url()}
                download={name()}
              >
                <FileIcon node={{ path: name(), type: "file" }} class="size-4 shrink-0" />
                <span>{name()}</span>
              </a>
            }
          >
            <div
              data-attachment-kind="video"
              class="max-w-full overflow-hidden rounded-lg border border-border-weak-base bg-black"
            >
              <video class="max-h-72 max-w-full" src={url()} controls preload="metadata" />
            </div>
          </Show>
        }
      >
        <button
          data-attachment-kind="image"
          class="block overflow-hidden rounded-lg border border-border-weak-base"
          onClick={() => setOpen(true)}
        >
          <MessageAttachmentImage part={part()} class="max-h-72 max-w-full object-contain" alt={name()} />
        </button>
      </Show>

      <Show when={open()}>
        <Portal>
          <div
            data-component="attachment-fullscreen-overlay"
            class="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-6"
            onClick={() => setOpen(false)}
          >
            <button
              class="absolute right-4 top-4 flex size-9 items-center justify-center rounded-full bg-surface-raised-stronger text-text-strong"
              aria-label="Close"
              onClick={(e) => {
                e.stopPropagation()
                setOpen(false)
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
            <Show when={fileKind() === "image"}>
              <Show when={data.onAnnotateImage && !proof() && /^image\/(png|jpeg|webp)$/.test(part().mime)}><button type="button" data-action="annotate-copy" class="absolute left-4 top-4 rounded-md bg-surface-raised-stronger px-3 py-2" onClick={(event) => { event.stopPropagation(); setOpen(false); data.onAnnotateImage?.(part()) }}>{data.annotateImageLabel ?? "Edit as new copy"}</button></Show>
              <ZoomableImage
                src={url() ?? ""}
                alt={name()}
                imgClass="max-h-[85vh] max-w-[90vw] rounded-lg object-contain"
                onClose={() => setOpen(false)}
              />
            </Show>
            <Show when={fileKind() === "video"}>
              <video
                class="max-h-[85vh] max-w-[90vw] rounded-lg"
                src={url()}
                controls
                autoplay
                onClick={(e) => e.stopPropagation()}
              />
            </Show>
          </div>
        </Portal>
      </Show>
    </div>
  )
}

function attachString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function attachDataMime(value: string | undefined) {
  return value?.match(/^data:([^;,]+)/)?.[1]
}

function attachFileUrl(value: string) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value
  const normalized = value.replace(/\\/g, "/")
  if (/^[A-Za-z]:\//.test(normalized)) return encodeURI(`file:///${normalized}`)
  if (normalized.startsWith("/")) return encodeURI(`file://${normalized}`)
  return value
}

function attachToolUrl(input: Record<string, unknown>) {
  const data = attachString(input.data)
  if (data?.startsWith("data:")) return data
  const filePath = attachString(input.filePath)
  return attachString(input.url) ?? (filePath ? attachFileUrl(filePath) : undefined)
}

function attachToolFilename(input: Record<string, unknown>) {
  const filename = attachString(input.filename)
  if (filename) return filename
  const filePath = attachString(input.filePath)
  if (!filePath) return "attachment"
  return getFilename(filePath.replace(/\\/g, "/")) || "attachment"
}

type ToolAttachment = FilePart | PromptFileAttachment

function attachToolMime(input: Record<string, unknown>, url: string) {
  return attachString(input.mime) ?? attachDataMime(url) ?? "application/octet-stream"
}

function attachToolKind(mime: string) {
  if (mime.toLowerCase().startsWith("image/")) return "image"
  if (mime.toLowerCase().startsWith("video/")) return "video"
  return "file"
}

function proofAttachmentUrl(url: string | undefined) {
  return url?.startsWith("/app/attachment/proof/")
}

function proofToolInput(input: Record<string, unknown>, url: string | undefined) {
  return input.purpose === "proof" || proofAttachmentUrl(url)
}

function redactedProofToolInput(input: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(input).filter(([key]) => !["data", "filePath", "url"].includes(key)))
}

function toolAttachmentUrl(attachment: ToolAttachment) {
  return "url" in attachment ? attachment.url : attachment.uri
}

function toolAttachmentName(attachment: ToolAttachment) {
  return "url" in attachment ? attachment.filename : attachment.name
}

function markdownImageKey(value: unknown) {
  if (typeof value !== "string") return
  const trimmed = value.trim()
  if (!trimmed) return

  try {
    const url = new URL(trimmed)
    if (url.protocol === "file:") {
      const pathname = decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:\/)/, "$1")
      return pathname.replace(/\\/g, "/").toLowerCase()
    }
    return url.toString().replace(/\\/g, "/").toLowerCase()
  } catch {}

  return trimmed.replace(/\\/g, "/").toLowerCase()
}

function addMarkdownImageKey(keys: Set<string>, value: unknown) {
  const key = markdownImageKey(value)
  if (!key) return
  keys.add(key)
  const filename = getFilename(key)
  if (filename) keys.add(filename.toLowerCase())
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function createMarkdownImageResolver(parts: PartType[]): MarkdownImageResolver | undefined {
  const images = parts.flatMap((part) => {
    if (part.type !== "tool" || part.state.status !== "completed") return []
    return (part.state.attachments ?? []).flatMap((attachment) => {
      const url = toolAttachmentUrl(attachment)
      const mime = attachment.mime || attachDataMime(url) || ""
      if (!mime.toLowerCase().startsWith("image/")) return []

      const keys = new Set<string>()
      const input = part.state.input
      const metadata = record("metadata" in part.state ? part.state.metadata : undefined)
      addMarkdownImageKey(keys, url)
      addMarkdownImageKey(keys, toolAttachmentName(attachment))
      addMarkdownImageKey(keys, input.filePath)
      addMarkdownImageKey(keys, input.url)
      addMarkdownImageKey(keys, input.filename)
      addMarkdownImageKey(keys, input.description)
      addMarkdownImageKey(keys, metadata?.filename)
      addMarkdownImageKey(keys, metadata?.filepath)
      addMarkdownImageKey(keys, metadata?.description)
      return [{ url, keys }]
    })
  })

  if (images.length === 0) return
  return (input) => {
    const keys = [markdownImageKey(input.src), markdownImageKey(input.alt)].filter((key): key is string => !!key)
    return images.find((image) => keys.some((key) => image.keys.has(key)))?.url
  }
}

type LocalMarkdownImage = { status: "loading" | "loaded" | "failed"; url?: string }

const localMarkdownImagePlaceholder = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="

const markdownImagePathExtension = /\.(?:png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i

function stripPathQueryAndHash(input: string) {
  const hash = input.indexOf("#")
  const query = input.indexOf("?")
  if (hash === -1 && query === -1) return input
  if (hash === -1) return input.slice(0, query)
  if (query === -1) return input.slice(0, hash)
  return input.slice(0, Math.min(hash, query))
}

function decodePath(input: string) {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

function normalizedPathKey(input: string) {
  const normalized = input.replace(/\\/g, "/").replace(/\/+$/, "")
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized
}

function localMarkdownImagePath(input: { src: string; directory: string }) {
  const value = input.src.trim()
  if (!value) return

  const windowsAbsolute = /^[A-Za-z]:[\\/]/.test(value)
  const raw = windowsAbsolute
    ? value
    : (() => {
        try {
          const url = new URL(value)
          if (url.protocol !== "file:") return
          return url.pathname.replace(/^\/([A-Za-z]:\/)/, "$1")
        } catch {
          if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return
          return value
        }
      })()
  if (!raw) return

  const path = decodePath(stripPathQueryAndHash(raw)).replace(/\\/g, "/").replace(/^\.\//, "")
  if (!markdownImagePathExtension.test(path)) return

  const root = input.directory.replace(/\\/g, "/").replace(/\/+$/, "")
  const absolute = /^[A-Za-z]:\//.test(path) || path.startsWith("/")
  if (absolute) {
    const rootKey = normalizedPathKey(root)
    const pathKey = normalizedPathKey(path)
    if (!rootKey) return
    if (pathKey !== rootKey && !pathKey.startsWith(rootKey + "/")) return
    return path.slice(root.length).replace(/^\/+/, "")
  }

  if (path === "." || path === "..") return
  if (path.startsWith("../") || path.includes("/../") || path.endsWith("/..")) return
  return path.replace(/^\/+/, "")
}

function createLocalMarkdownImageResolver(input: {
  directory: string
  readFile?: (path: string) => Promise<FileContent | undefined>
  images: Map<string, LocalMarkdownImage>
  onChange: () => void
}): MarkdownImageResolver | undefined {
  const readFile = input.readFile
  if (!readFile) return

  return (image) => {
    const path = localMarkdownImagePath({ src: image.src, directory: input.directory })
    if (!path) return

    const key = `${normalizedPathKey(input.directory)}\n${path.toLowerCase()}`
    const current = input.images.get(key)
    if (current?.status === "loaded") return current.url
    if (current) return localMarkdownImagePlaceholder

    input.images.set(key, { status: "loading" })
    void readFile(path)
      .then((content) => {
        const mime = content?.mimeType?.toLowerCase()
        input.images.set(
          key,
          content?.type === "binary" && content.encoding === "base64" && mime?.startsWith("image/")
            ? { status: "loaded", url: `data:${content.mimeType};base64,${content.content}` }
            : { status: "failed" },
        )
        input.onChange()
      })
      .catch(() => {
        input.images.set(key, { status: "failed" })
        input.onChange()
      })
    return localMarkdownImagePlaceholder
  }
}

export interface ToolProps {
  input: Record<string, unknown>
  metadata: Record<string, unknown>
  tool: string
  sessionID?: string
  callID?: string
  output?: string
  error?: string
  status?: string
  attachments?: ToolAttachment[]
  hideDetails?: boolean
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  deferContent?: boolean
  virtualizeDiff?: boolean
  onContentRendered?: () => void
  forceOpen?: boolean
  locked?: boolean
  action?: JSX.Element
  hoverTitle?: string
}

export type ToolComponent = Component<ToolProps>

const state: Record<
  string,
  {
    name: string
    render?: ToolComponent
  }
> = {}

export function registerTool(input: { name: string; render?: ToolComponent }) {
  state[input.name] = input
  return input
}

export function getTool(name: string) {
  return state[name]?.render
}

export const ToolRegistry = {
  register: registerTool,
  render: getTool,
}

ToolRegistry.register({
  name: "attach",
  render(props) {
    const data = useData()
    // Prefer the durable result attachment. Normal attachments are data URLs;
    // proof attachments are same-origin artifact URLs that stay out of model context.
    const resultAttachment = createMemo(() => props.attachments?.[0])
    const proofInput = createMemo(() => props.input.purpose === "proof")
    const inputPreview = createMemo(() => props.status === "pending" || props.status === "running")
    const url = createMemo(() => {
      const attachment = resultAttachment()
      if (attachment) return toolAttachmentUrl(attachment)
      if (proofInput() && !inputPreview()) return
      return attachToolUrl(props.input)
    })
    const mime = createMemo(() => resultAttachment()?.mime ?? attachToolMime(props.input, url() ?? ""))
    const name = createMemo(() => {
      const attachment = resultAttachment()
      return (attachment ? toolAttachmentName(attachment) : undefined) ?? attachToolFilename(props.input)
    })
    const description = createMemo(() => attachString(props.input.description))
    const kind = createMemo(() => attachToolKind(mime()))
    const proof = createMemo(() => proofToolInput(props.input, url()))
    const fallbackInput = createMemo(() =>
      proofInput() && !inputPreview() ? redactedProofToolInput(props.input) : props.input,
    )
    const [open, setOpen] = createSignal(false)

    return (
      <Show
        when={url()}
        fallback={
          <GenericTool
            tool={props.tool}
            status={props.status}
            hideDetails={props.hideDetails}
            input={fallbackInput()}
          />
        }
      >
        {(source) => (
          <div
            data-component="attach-tool-renderer"
            data-attachment-kind={kind()}
            class="my-1.5 flex max-w-full flex-col gap-1.5"
          >
            <Show when={description() || name()}>
              <div class="flex min-w-0 flex-col gap-0.5 px-1">
                <Show when={proof()}>
                  <span class="inline-flex w-fit rounded-full border border-border-weak-base px-2 py-0.5 text-11-medium uppercase tracking-wide text-text-weak">
                    Proof
                  </span>
                </Show>
                <Show when={description()}>
                  {(label) => <span class="text-12-medium text-text-weak">{label()}</span>}
                </Show>
                <span class="truncate text-11-regular text-text-weak">{name()}</span>
              </div>
            </Show>
            <Switch>
              <Match when={kind() === "image"}>
                <button
                  data-attachment-inline="image"
                  class="block max-w-full overflow-hidden rounded-lg border border-border-weak-base bg-surface-base"
                  title={name()}
                  onClick={() => setOpen(true)}
                >
                  <img class="max-h-80 max-w-full object-contain" src={source()} alt={name()} />
                </button>
              </Match>
              <Match when={kind() === "video"}>
                <div
                  data-attachment-inline="video"
                  class="max-w-full overflow-hidden rounded-lg border border-border-weak-base bg-black"
                >
                  <video class="max-h-80 max-w-full" src={source()} controls preload="metadata" />
                </div>
              </Match>
              <Match when={true}>
                <a
                  data-attachment-inline="file"
                  class="inline-flex w-fit max-w-full items-center gap-2 rounded-lg border border-border-weak-base px-3 py-2 text-13-medium text-text-strong hover:bg-surface-raised-base-hover"
                  href={source()}
                  download={name()}
                >
                  <FileIcon node={{ path: name(), type: "file" }} class="size-4 shrink-0" />
                  <span class="truncate">{name()}</span>
                </a>
              </Match>
            </Switch>
            <Show when={open()}>
              <Portal>
                <div
                  data-component="attach-fullscreen-overlay"
                  class="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-6"
                  onClick={() => setOpen(false)}
                >
                  <button
                    class="absolute right-4 top-4 flex size-9 items-center justify-center rounded-full bg-surface-raised-stronger text-text-strong"
                    aria-label="Close"
                    onClick={(event) => {
                      event.stopPropagation()
                      setOpen(false)
                    }}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M18 6 6 18M6 6l12 12" />
                    </svg>
                  </button>
                  <Show when={kind() === "image"}>
                    <Show when={data.onAnnotateImage && !proof() && !inputPreview() && props.sessionID && /^image\/(png|jpeg|webp)$/.test(mime())}><button type="button" data-action="annotate-copy" class="absolute left-4 top-4 rounded-md bg-surface-raised-stronger px-3 py-2" onClick={(event) => { event.stopPropagation(); setOpen(false); data.onAnnotateImage?.({ type: "file", id: props.callID ?? "attachment", messageID: "", sessionID: props.sessionID!, url: source(), mime: mime(), filename: name() }) }}>{data.annotateImageLabel ?? "Edit as new copy"}</button></Show>
                    <ZoomableImage
                      src={source()}
                      alt={name()}
                      imgClass="max-h-[85vh] max-w-[90vw] rounded-lg object-contain"
                      onClose={() => setOpen(false)}
                    />
                  </Show>
                  <Show when={kind() === "video"}>
                    <video
                      class="max-h-[85vh] max-w-[90vw] rounded-lg"
                      src={source()}
                      controls
                      autoplay
                      onClick={(event) => event.stopPropagation()}
                    />
                  </Show>
                </div>
              </Portal>
            </Show>
          </div>
        )}
      </Show>
    )
  },
})

function ToolFileAccordion(props: { path: string; actions?: JSX.Element; children: JSX.Element }) {
  const value = createMemo(() => props.path || "tool-file")

  return (
    <Accordion
      multiple
      data-scope="apply-patch"
      style={{ "--sticky-accordion-offset": "calc(32px + var(--tool-content-gap))" }}
      defaultValue={[value()]}
    >
      <Accordion.Item value={value()}>
        <StickyAccordionHeader>
          <Accordion.Trigger>
            <div data-slot="apply-patch-trigger-content">
              <div data-slot="apply-patch-file-info">
                <FileIcon node={{ path: props.path, type: "file" }} />
                <div data-slot="apply-patch-file-name-container">
                  <Show when={props.path.includes("/")}>
                    <span data-slot="apply-patch-directory">{`\u202A${getDirectory(props.path)}\u202C`}</span>
                  </Show>
                  <span data-slot="apply-patch-filename">{getFilename(props.path)}</span>
                </div>
              </div>
              <div data-slot="apply-patch-trigger-actions">
                {props.actions}
                <Icon name="chevron-grabber-vertical" size="small" />
              </div>
            </div>
          </Accordion.Trigger>
        </StickyAccordionHeader>
        <Accordion.Content>{props.children}</Accordion.Content>
      </Accordion.Item>
    </Accordion>
  )
}

PART_MAPPING["tool"] = function ToolPartDisplay(props) {
  const data = useData()
  const i18n = useI18n()
  const part = () => props.part as ToolPart
  if (part().tool === "todowrite") return null

  const emptyInput: Record<string, unknown> = {}
  const emptyMetadata: Record<string, unknown> = {}

  const input = () => part().state?.input ?? emptyInput
  // @ts-expect-error
  const partMetadata = () => part().state?.metadata ?? emptyMetadata
  const taskId = createMemo(() => {
    if (part().tool !== "task") return
    return taskSessionID(partMetadata())
  })
  const taskHref = createMemo(() => {
    if (part().tool !== "task") return
    return sessionLink(taskId(), useLocation().pathname, data.sessionHref)
  })
  const openTaskSession = (event: MouseEvent) => {
    if (!data.navigateToSession) return
    if (event.button !== 0 && event.button !== 1) return
    const id = taskId()
    if (!id) return
    event.preventDefault()
    event.stopPropagation()
    data.navigateToSession(id)
  }
  const taskSubtitle = createMemo(() => {
    if (part().tool !== "task") return undefined
    const value = input().description
    if (typeof value === "string" && value) return value
    return taskId()
  })

  const render = createMemo(() => ToolRegistry.render(part().tool) ?? GenericTool)
  const controlledOpen = () => (props.onToolOpenChange ? (props.toolOpen ?? props.defaultOpen) : undefined)
  const handleToolOpenChange = (open: boolean) => props.onToolOpenChange?.(open)
  const running = createMemo(() => toolRunning(part()))
  const cancellable = createMemo(() => toolCancellable(part()))
  const timefmt = createMemo(() => new Intl.DateTimeFormat(i18n.locale(), { timeStyle: "medium" }))
  const hoverTitle = createMemo(() => {
    const start = toolStartTime(part())
    if (start === undefined) return
    return i18n.t("ui.messagePart.tool.startedAt", { time: timefmt().format(start) })
  })
  const cancelTool = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    void props.onToolCancel?.({ sessionID: part().sessionID, callID: part().callID || part().id })
  }
  const action = createMemo(() => {
    if (!cancellable() || !props.onToolCancel) return
    return (
      <Tooltip value={i18n.t("ui.messagePart.tool.cancel")} placement="top" gutter={4}>
        <IconButton
          icon="stop"
          size="small"
          variant="ghost"
          aria-label={i18n.t("ui.messagePart.tool.cancel")}
          onClick={cancelTool}
        />
      </Tooltip>
    )
  })
  const error = createMemo(() => {
    const state = part().state
    return state.status === "error" ? state.error : undefined
  })
  const questionStatus = createMemo(() => {
    if (part().tool !== "question") return
    if (part().state.status === "pending") return i18n.t("ui.messagePart.questions.preparing")
    if (part().state.status === "running") return i18n.t("ui.messagePart.questions.waiting")
  })

  return (
    <div data-component="tool-part-wrapper" data-timeline-part-id={part().id}>
      <Switch>
        <Match when={questionStatus()}>
          {(status) => (
            <div
              data-component="question-tool-status"
              data-status={part().state.status}
              role="status"
              aria-live="polite"
            >
              <Spinner />
              <span>{status()}</span>
            </div>
          )}
        </Match>
        <Match when={part().tool !== "bash" && part().tool !== "multi_agent_fanout" ? error() : undefined}>
          {(error) => {
            const cleaned = error().replace("Error: ", "")
            if (part().tool === "question" && cleaned.includes("dismissed this question")) {
              return (
                <div style="width: 100%; display: flex; justify-content: flex-end;">
                  <span class="text-13-regular text-text-weak cursor-default">
                    {i18n.t("ui.messagePart.questions.dismissed")}
                  </span>
                </div>
              )
            }
            return (
              <ToolErrorCard
                tool={part().tool}
                error={error()}
                title={part().tool === "websearch" ? webSearchProviderLabel(partMetadata().provider) : undefined}
                defaultOpen={props.defaultOpen}
                open={controlledOpen()}
                onOpenChange={props.onToolOpenChange ? handleToolOpenChange : undefined}
                subtitle={taskSubtitle()}
                href={data.navigateToSession ? undefined : taskHref()}
                onSubtitleClick={data.navigateToSession ? openTaskSession : undefined}
                onSubtitleAuxClick={data.navigateToSession ? openTaskSession : undefined}
              />
            )
          }}
        </Match>
        <Match when={true}>
          <Dynamic
            component={render()}
            input={input()}
            tool={part().tool}
            sessionID={part().sessionID}
            callID={part().callID || part().id}
            metadata={partMetadata()}
            // @ts-expect-error
            output={part().state.output}
            status={part().state.status}
            error={error()}
            // @ts-expect-error — attachments only exist on completed tool state
            attachments={part().state.attachments}
            hideDetails={props.hideDetails}
            defaultOpen={props.defaultOpen}
            open={controlledOpen()}
            onOpenChange={props.onToolOpenChange ? handleToolOpenChange : undefined}
            deferContent={props.deferToolContent}
            virtualizeDiff={props.virtualizeDiff}
            onContentRendered={props.onContentRendered}
            action={action()}
            hoverTitle={hoverTitle()}
          />
        </Match>
      </Switch>
    </div>
  )
}

export function MessageDivider(props: { label: string }) {
  return (
    <div data-component="compaction-part">
      <div data-slot="compaction-part-divider">
        <span data-slot="compaction-part-line" />
        <span data-slot="compaction-part-label" class="text-12-regular text-text-weak">
          {props.label}
        </span>
        <span data-slot="compaction-part-line" />
      </div>
    </div>
  )
}

PART_MAPPING["compaction"] = function CompactionPartDisplay() {
  const i18n = useI18n()
  return <MessageDivider label={i18n.t("ui.messagePart.compaction")} />
}

PART_MAPPING["text"] = function TextPartDisplay(props) {
  const data = useData()
  const i18n = useI18n()
  const numfmt = createMemo(() => new Intl.NumberFormat(i18n.locale()))
  const part = () => props.part as TextPart
  const interrupted = createMemo(
    () =>
      props.message.role === "assistant" && (props.message as AssistantMessage).error?.name === "MessageAbortedError",
  )

  const model = createMemo(() => {
    if (props.message.role !== "assistant") return ""
    const message = props.message as AssistantMessage
    const match = data.store.provider?.all?.get(message.providerID)
    return match?.models?.[message.modelID]?.name ?? message.modelID
  })

  const duration = createMemo(() => {
    if (props.message.role !== "assistant") return ""
    const message = props.message as AssistantMessage
    const completed = message.time.completed
    const ms =
      typeof props.turnDurationMs === "number"
        ? props.turnDurationMs
        : typeof completed === "number"
          ? completed - message.time.created
          : -1
    if (!(ms >= 0)) return ""
    const total = Math.round(ms / 1000)
    if (total < 60) return i18n.t("ui.message.duration.seconds", { count: numfmt().format(total) })
    const minutes = Math.floor(total / 60)
    const seconds = total % 60
    return i18n.t("ui.message.duration.minutesSeconds", {
      minutes: numfmt().format(minutes),
      seconds: numfmt().format(seconds),
    })
  })

  const timefmt = createMemo(() => new Intl.DateTimeFormat(i18n.locale(), { timeStyle: "short" }))

  const completedStamp = createMemo(() => {
    if (props.message.role !== "assistant") return ""
    const completed =
      typeof props.turnCompletedAt === "number"
        ? props.turnCompletedAt
        : (props.message as AssistantMessage).time.completed
    if (typeof completed !== "number") return ""
    return timefmt().format(completed)
  })

  const meta = createMemo(() => {
    if (props.message.role !== "assistant") return ""
    const agent = (props.message as AssistantMessage).agent
    const items = [
      agent ? agent[0]?.toUpperCase() + agent.slice(1) : "",
      model(),
      duration(),
      completedStamp(),
      interrupted() ? i18n.t("ui.message.interrupted") : "",
    ]
    return items.filter((x) => !!x).join(" \u00B7 ")
  })

  const streaming = createMemo(
    () => props.message.role === "assistant" && typeof (props.message as AssistantMessage).time.completed !== "number",
  )
  const text = () => readPartText(data.store.part_text_accum_delta, part())
  const isLastTextPart = createMemo(() => {
    const last = (data.store.part?.[props.message.id] ?? [])
      .filter((item): item is TextPart => item?.type === "text" && !!item.text?.trim())
      .at(-1)
    return last?.id === part().id
  })
  const showCopy = createMemo(() => {
    if (props.message.role !== "assistant") return isLastTextPart()
    if (props.showAssistantCopyPartID === null) return false
    if (typeof props.showAssistantCopyPartID === "string") return props.showAssistantCopyPartID === part().id
    return isLastTextPart()
  })
  const localImages = new Map<string, LocalMarkdownImage>()
  const [localImageVersion, setLocalImageVersion] = createSignal(0)
  let mounted = true
  onCleanup(() => {
    mounted = false
  })
  const notifyLocalImageChange = () => {
    if (!mounted) return
    setLocalImageVersion((version) => version + 1)
  }
  const resolveImageSrc = createMemo(() => {
    const attachmentResolver = createMarkdownImageResolver(data.store.part?.[props.message.id] ?? [])
    const localResolver =
      text().includes("![") || /<img\s/i.test(text())
        ? createLocalMarkdownImageResolver({
            directory: data.directory,
            readFile: props.readFile,
            images: localImages,
            onChange: notifyLocalImageChange,
          })
        : undefined
    localImageVersion()
    if (!attachmentResolver && !localResolver) return
    return (input: { src: string; alt: string }) => attachmentResolver?.(input) ?? localResolver?.(input)
  })
  const [copied, setCopied] = createSignal(false)

  const handleCopy = async () => {
    const content = text()
    if (!content) return
    if (await writeClipboard(content)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <Show when={text()}>
      <div data-component="text-part" data-timeline-part-id={part().id}>
        <div data-slot="text-part-body">
          <Show
            when={streaming()}
            fallback={
              <Markdown
                text={text()}
                cacheKey={part().id}
                streaming={false}
                resolveImageSrc={resolveImageSrc()}
                readFile={props.readFile}
              />
            }
          >
            <PacedMarkdown
              text={text()}
              cacheKey={part().id}
              streaming={streaming()}
              resolveImageSrc={resolveImageSrc()}
              readFile={props.readFile}
            />
          </Show>
        </div>
        <Show when={showCopy()}>
          <div data-slot="text-part-copy-wrapper" data-interrupted={interrupted() ? "" : undefined}>
            <Tooltip
              value={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copyResponse")}
              placement="top"
              gutter={4}
            >
              <IconButton
                icon={copied() ? "check" : "copy"}
                size="normal"
                variant="ghost"
                onMouseDown={(e) => e.preventDefault()}
                onClick={handleCopy}
                aria-label={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copyResponse")}
              />
            </Tooltip>
            <Show when={meta()}>
              <span data-slot="text-part-meta" class="text-12-regular text-text-weak cursor-default">
                {meta()}
              </span>
            </Show>
          </div>
        </Show>
      </div>
    </Show>
  )
}

PART_MAPPING["custom"] = function CustomPartDisplay(props) {
  let root: HTMLDivElement | undefined
  const part = () => props.part as CustomPart
  const rendered = createMemo(() => props.customPartRenderer?.({ part: part(), message: props.message }))
  const notifyRendered = () => requestAnimationFrame(() => props.onContentRendered?.())

  onMount(() => {
    notifyRendered()
    if (!root || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(notifyRendered)
    observer.observe(root)
    onCleanup(() => observer.disconnect())
  })

  createEffect(() => {
    rendered()
    notifyRendered()
  })

  return (
    <Show when={rendered() !== null}>
      <div ref={root} data-component="custom-part" data-custom-kind={part().kind} data-timeline-part-id={part().id}>
        <Show
          keyed
          when={rendered()}
          fallback={
            <div class="rounded-md border border-border-weak-base bg-surface-panel px-3 py-2 text-13-regular text-text-weak">
              <Show when={part().title}>
                {(title) => <div class="mb-1 text-13-medium text-text-strong">{title()}</div>}
              </Show>
              <Show when={part().fallback} fallback={<span>{part().kind}</span>}>
                {(fallback) => (
                  <Markdown text={fallback()} cacheKey={part().id} streaming={false} readFile={props.readFile} />
                )}
              </Show>
            </div>
          }
        >
          {(node) => node}
        </Show>
      </div>
    </Show>
  )
}

PART_MAPPING["reasoning"] = function ReasoningPartDisplay(props) {
  const data = useData()
  const part = () => props.part as ReasoningPart
  const streaming = createMemo(
    () => props.message.role === "assistant" && typeof (props.message as AssistantMessage).time.completed !== "number",
  )
  const text = () => readPartText(data.store.part_text_accum_delta, part())

  return (
    <Show when={text()}>
      <div data-component="reasoning-part" data-timeline-part-id={part().id}>
        <Show
          when={streaming()}
          fallback={<Markdown text={text()} cacheKey={part().id} streaming={false} readFile={props.readFile} />}
        >
          <PacedMarkdown text={text()} cacheKey={part().id} streaming={streaming()} readFile={props.readFile} />
        </Show>
      </div>
    </Show>
  )
}

ToolRegistry.register({
  name: "read",
  render(props) {
    const data = useData()
    const i18n = useI18n()
    const args: string[] = []
    const path = toolPath(props.input)
    const offset = numberField(props.input, "offset")
    const limit = numberField(props.input, "limit")
    if (offset !== undefined) args.push("offset=" + offset)
    if (limit !== undefined) args.push("limit=" + limit)
    const loaded = createMemo(() => {
      if (props.status !== "completed") return []
      const value = props.metadata.loaded
      if (!value || !Array.isArray(value)) return []
      return value.filter((p): p is string => typeof p === "string")
    })
    return (
      <>
        <BasicTool
          {...props}
          icon="glasses"
          trigger={{
            title: i18n.t("ui.tool.read"),
            subtitle: path ? getFilename(path) : "",
            args,
          }}
        />
        <For each={loaded()}>
          {(filepath) => (
            <div data-component="tool-loaded-file">
              <Icon name="enter" size="small" />
              <span>
                {i18n.t("ui.tool.loaded")} {relativizeProjectPath(filepath, data.directory)}
              </span>
            </div>
          )}
        </For>
      </>
    )
  },
})

ToolRegistry.register({
  name: "list",
  render(props) {
    const i18n = useI18n()
    const path = stringField(props.input, "path") ?? "/"
    return (
      <BasicTool
        {...props}
        icon="bullet-list"
        trigger={{ title: i18n.t("ui.tool.list"), subtitle: getDirectory(path) }}
      >
        <Show when={props.output}>
          <div data-component="tool-output" data-scrollable>
            <Markdown text={props.output!} />
          </div>
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "glob",
  render(props) {
    const i18n = useI18n()
    const path = stringField(props.input, "path") ?? "/"
    const pattern = stringField(props.input, "pattern")
    return (
      <BasicTool
        {...props}
        icon="magnifying-glass-menu"
        trigger={{
          title: i18n.t("ui.tool.glob"),
          subtitle: getDirectory(path),
          args: pattern ? ["pattern=" + pattern] : [],
        }}
      >
        <Show when={props.output}>
          <div data-component="tool-output" data-scrollable>
            <Markdown text={props.output!} />
          </div>
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "grep",
  render(props) {
    const i18n = useI18n()
    const args: string[] = []
    const path = stringField(props.input, "path") ?? "/"
    const pattern = stringField(props.input, "pattern")
    const include = stringField(props.input, "include")
    if (pattern) args.push("pattern=" + pattern)
    if (include) args.push("include=" + include)
    return (
      <BasicTool
        {...props}
        icon="magnifying-glass-menu"
        trigger={{
          title: i18n.t("ui.tool.grep"),
          subtitle: getDirectory(path),
          args,
        }}
      >
        <Show when={props.output}>
          <div data-component="tool-output" data-scrollable>
            <Markdown text={props.output!} />
          </div>
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "webfetch",
  render(props) {
    const i18n = useI18n()
    const pending = createMemo(() => props.status === "pending" || props.status === "running")
    const url = createMemo(() => {
      const value = props.input.url
      if (typeof value !== "string") return ""
      return value
    })
    return (
      <BasicTool
        {...props}
        hideDetails
        icon="window-cursor"
        trigger={
          <div data-slot="basic-tool-tool-info-structured">
            <div data-slot="basic-tool-tool-info-main">
              <span data-slot="basic-tool-tool-title">
                <TextShimmer text={i18n.t("ui.tool.webfetch")} active={pending()} />
              </span>
              <Show when={!pending() && url()}>
                <a
                  data-slot="basic-tool-tool-subtitle"
                  class="clickable subagent-link"
                  href={url()}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(event) => event.stopPropagation()}
                >
                  {url()}
                </a>
              </Show>
            </div>
            <Show when={!pending() && url()}>
              <div data-component="tool-action">
                <Icon name="square-arrow-top-right" size="small" />
              </div>
            </Show>
          </div>
        }
      />
    )
  },
})

ToolRegistry.register({
  name: "websearch",
  render(props) {
    const query = createMemo(() => {
      const value = props.input.query
      if (typeof value !== "string") return ""
      return value
    })
    const title = createMemo(() => webSearchProviderLabel(props.metadata.provider))

    return (
      <BasicTool
        {...props}
        icon="window-cursor"
        trigger={{
          title: title(),
          subtitle: query(),
          subtitleClass: "exa-tool-query",
        }}
      >
        <ExaOutput output={props.output} />
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "task",
  render(props) {
    const data = useData()
    const i18n = useI18n()
    const location = useLocation()
    const childSessionId = createMemo(() => {
      return taskSessionID(props.metadata) ?? taskSession(props.input, props.sessionID, data.store.session)
    })
    const agent = createMemo(() => taskAgent(props.input.subagent_type, data.store.agent))
    const title = createMemo(() => agent().name ?? i18n.t("ui.tool.agent.default"))
    const tone = createMemo(() => agent().color)
    const subtitle = createMemo(() => {
      const value =
        typeof props.input.description === "string" && props.input.description
          ? props.input.description
          : childSessionId()
      if (!value) return value
      if (props.metadata.background === true) return `${value} (background)`
      return value
    })
    const running = createMemo(() => props.status === "pending" || props.status === "running")

    const href = createMemo(() => sessionLink(childSessionId(), location.pathname, data.sessionHref))
    const clickable = createMemo(() => !!(childSessionId() && (data.navigateToSession || href())))

    const open = () => {
      const id = childSessionId()
      if (!id) return
      if (data.navigateToSession) {
        data.navigateToSession(id)
        return
      }
      const value = href()
      if (value) window.location.assign(value)
    }

    const navigate = (event: MouseEvent) => {
      if (!data.navigateToSession) return
      if (event.button !== 0 && event.button !== 1) return
      event.preventDefault()
      event.stopPropagation()
      open()
    }

    const trigger = () => (
      <div data-component="task-tool-card">
        <div data-slot="basic-tool-tool-info-structured">
          <div data-slot="basic-tool-tool-info-main">
            <Show when={running()}>
              <span data-component="task-tool-spinner" style={{ color: tone() ?? "var(--icon-interactive-base)" }}>
                <Spinner />
              </span>
            </Show>
            <span data-component="task-tool-title" style={{ color: tone() ?? "var(--text-strong)" }}>
              {title()}
            </span>
            <Show when={subtitle()}>
              <span data-slot="basic-tool-tool-subtitle">{subtitle()}</span>
            </Show>
          </div>
        </div>
        <Show when={clickable()}>
          <div data-component="task-tool-action">
            <Icon name="square-arrow-top-right" size="small" />
          </div>
        </Show>
      </div>
    )

    return (
      <BasicTool
        {...props}
        icon="task"
        status={props.status}
        trigger={trigger()}
        hideDetails
        triggerHref={data.navigateToSession ? undefined : href()}
        clickable={clickable()}
        onTriggerClick={navigate}
        onTriggerAuxClick={navigate}
      />
    )
  },
})

ToolRegistry.register({
  name: "multi_agent_fanout",
  render(props) {
    const i18n = useI18n()
    const data = useData()
    const location = useLocation()
    const reviewers = createMemo(() => reviewerDetails(props.metadata))
    const labels = () => ({
      queued: i18n.t("ui.tool.details.queued"),
      starting: i18n.t("ui.tool.details.starting"),
      running: i18n.t("ui.tool.details.running"),
      completed: i18n.t("ui.tool.details.completed"),
      repaired: i18n.t("ui.tool.details.repaired"),
      partial: i18n.t("ui.tool.details.partial"),
      error: i18n.t("ui.tool.details.failed"),
      unknown: i18n.t("ui.tool.details.unknown"),
    })
    return (
      <BasicTool
        {...props}
        icon="brain"
        inspectWhileRunning
        defer={props.deferContent}
        trigger={{ title: i18n.t("ui.tool.details.fanout"), subtitle: stringField(props.input, "workflow") }}
      >
        <div data-component="fanout-details">
          <Show when={stringField(props.input, "prompt")}>
            {(prompt) => <pre data-slot="fanout-prompt">{prompt()}</pre>}
          </Show>
          <Index each={reviewers()}>
            {(reviewer) => (
              <section data-slot="fanout-reviewer" data-status={reviewer().state}>
                <div data-slot="fanout-reviewer-heading">
                  <strong>
                    {reviewer().model}
                    {reviewer().variant ? ` · ${reviewer().variant}` : ""}
                  </strong>
                  <span role="status">{labels()[reviewer().state]}</span>
                </div>
                <Show when={reviewer().sessionID}>
                  {(id) => (
                    <a
                      href={sessionLink(id(), location.pathname, data.sessionHref)}
                      onClick={(event) => {
                        event.stopPropagation()
                        if (
                          event.button !== 0 ||
                          event.ctrlKey ||
                          event.metaKey ||
                          event.shiftKey ||
                          event.altKey ||
                          !data.navigateToSession
                        )
                          return
                        event.preventDefault()
                        data.navigateToSession(id())
                      }}
                    >
                      {i18n.t("ui.tool.details.openSession")}
                    </a>
                  )}
                </Show>
                <Show when={reviewer().text}>
                  <pre data-slot="fanout-result">{reviewer().text}</pre>
                </Show>
                <Show when={reviewer().recovery}>
                  {(recovery) => (
                    <div data-slot="fanout-recovery">
                      <Show when={recovery().issues.length}>
                        <details><summary>{i18n.t("ui.tool.details.issues")}</summary>
                          <pre>{recovery().issues.join("\n")}</pre>
                        </details>
                      </Show>
                      <details><summary>{i18n.t("ui.tool.details.original")}</summary>
                        <pre data-slot="fanout-original">{recovery().original}</pre>
                      </details>
                      <Show when={recovery().repaired}>
                         {(text) => <details><summary>{i18n.t(recovery().repairStatus === "success" ? "ui.tool.details.repair" : "ui.tool.details.repairFailed")}</summary><pre>{text()}</pre></details>}
                      </Show>
                    </div>
                  )}
                </Show>
                <Show when={reviewer().state === "unknown"}>
                  <p data-slot="fanout-reviewer-unknown">{i18n.t("ui.tool.details.unknownReason")}</p>
                </Show>
              </section>
            )}
          </Index>
          <Show when={reviewers().length === 0}>
            <p data-slot="tool-detail-meta">{i18n.t("ui.tool.details.waitingReviewers")}</p>
            <Show when={props.output}>
              <pre data-slot="fanout-result">{props.output}</pre>
            </Show>
          </Show>
          <Show when={props.error}>
            <p role="alert">{props.error}</p>
          </Show>
        </div>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "bash",
  render(props) {
    const i18n = useI18n()
    const capture = createMemo(() => record(props.metadata.capture))
    const captureUrl = createMemo(() => {
      const uri = capture()?.uri
      if (typeof uri !== "string" || !uri.startsWith("attachment://") || !props.sessionID) return
      return contentUrl({
        id: "shell-capture",
        messageID: "shell-capture",
        sessionID: props.sessionID,
        type: "file",
        mime: "text/plain",
        url: uri,
      })
    })
    const pending = () => props.status === "pending" || props.status === "running"
    const sawPending = pending()
    const text = createMemo(() => {
      const cmd = stringField(props.input, "command") ?? stringField(props.metadata, "command") ?? ""
      const out = stripAnsi(stringField(props.metadata, "output") || props.output || "").replace(/\r\n?/g, "\n")
      const warnings = Array.isArray(props.metadata.warnings)
        ? props.metadata.warnings.filter((value): value is string => typeof value === "string")
        : []
      return `$ ${cmd || i18n.t("ui.tool.details.preparing")}${out ? "\n\n" + out : ""}${warnings.length ? "\n\n" + warnings.join("\n") : ""}${props.error ? "\n\n" + props.error : ""}`
    })
    const description = createMemo(() => stringField(props.input, "description"))
    const [copied, setCopied] = createSignal(false)

    const handleCopy = async () => {
      const content = text()
      if (!content) return
      if (await writeClipboard(content)) {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      }
    }

    return (
      <BasicTool
        {...props}
        icon="console"
        inspectWhileRunning
        defer={props.deferContent}
        trigger={
          <div data-slot="basic-tool-tool-info-structured">
            <div data-slot="basic-tool-tool-info-main">
              <span data-slot="basic-tool-tool-title">
                <TextShimmer text={i18n.t("ui.tool.shell")} active={pending()} />
              </span>
              <Show when={!pending() && description()}>
                {(value) => <ShellSubmessage text={value()} animate={sawPending} />}
              </Show>
            </div>
          </div>
        }
      >
        <div data-component="bash-output">
          <div data-slot="bash-copy">
            <Tooltip
              value={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copy")}
              placement="top"
              gutter={4}
            >
              <IconButton
                icon={copied() ? "check" : "copy"}
                size="small"
                variant="secondary"
                onMouseDown={(e) => e.preventDefault()}
                onClick={handleCopy}
                aria-label={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copy")}
              />
            </Tooltip>
          </div>
          <div data-slot="bash-scroll" data-scrollable>
            <Show when={stringField(props.metadata, "cwd") ?? stringField(props.input, "workdir")}>
              {(cwd) => <p data-slot="tool-detail-meta">{cwd()}</p>}
            </Show>
            <pre data-slot="bash-pre">
              <code>{text()}</code>
            </pre>
            <Show when={pending() && !stringField(props.metadata, "output")}>
              <p data-slot="tool-detail-meta">{i18n.t("ui.tool.details.waitingOutput")}</p>
            </Show>
            <Show when={props.metadata.truncated === true}>
              <p data-slot="tool-detail-meta">{i18n.t("ui.tool.details.truncated")}</p>
            </Show>
            <Show when={captureUrl()}>
              {(url) => (
                <a href={url()} target="_blank" rel="noopener noreferrer">
                  {i18n.t(
                    capture()?.complete === true ? "ui.tool.details.fullCapture" : "ui.tool.details.partialCapture",
                  )}
                </a>
              )}
            </Show>
            <Show when={typeof props.metadata.exitCode === "number"}>
              <p data-slot="tool-detail-meta">
                {i18n.t("ui.tool.details.exitCode", { code: String(props.metadata.exitCode) })}
              </p>
            </Show>
            <Show when={props.metadata.timedOut === true}>
              <p data-slot="tool-detail-meta">{i18n.t("ui.tool.details.timedOut")}</p>
            </Show>
          </div>
        </div>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "edit",
  render(props) {
    const i18n = useI18n()
    const fileComponent = useFileComponent()
    const filePath = createMemo(() => toolPath(props.input) ?? "")
    const diagnostics = createMemo(() => getDiagnostics(props.metadata.diagnostics, filePath()))
    const filediff = createMemo(() => toolFileDiff(props.metadata.filediff))
    const changes = createMemo(() => diffChanges(filediff()))
    const path = createMemo(() => filediff()?.file || filePath())
    const filename = () => getFilename(filePath())
    const pending = () => props.status === "pending" || props.status === "running"
    const diffSource = createMemo(
      () => {
        const value = filediff()
        if (!value) return
        return {
          file: value.file || filePath(),
          patch: value.patch,
          before: value.before,
          after: value.after,
        }
      },
      undefined,
      {
        equals: (a, b) =>
          a?.file === b?.file && a?.patch === b?.patch && a?.before === b?.before && a?.after === b?.after,
      },
    )

    const fileCompProps = createMemo(() => {
      try {
        const source = diffSource()
        if (source) {
          const fileDiff = resolveFileDiff(source)
          if (fileDiff) return { fileDiff, hunkSeparators: fileDiff.isPartial ? "simple" : "line-info-basic" }
        }
      } catch {}

      return {
        before: {
          name: filediff()?.file || filePath(),
          contents: filediff()?.before || stringField(props.input, "oldString") || "",
        },
        after: {
          name: filediff()?.file || filePath(),
          contents: filediff()?.after || stringField(props.input, "newString") || "",
        },
      }
    })

    return (
      <div data-component="edit-tool">
        <BasicTool
          {...props}
          icon="code-lines"
          defer={props.deferContent !== false}
          trigger={
            <div data-component="edit-trigger">
              <div data-slot="message-part-title-area">
                <div data-slot="message-part-title">
                  <span data-slot="message-part-title-text">
                    <TextShimmer text={i18n.t("ui.messagePart.title.edit")} active={pending()} />
                  </span>
                  <Show when={!pending()}>
                    <span data-slot="message-part-title-filename">{filename()}</span>
                  </Show>
                </div>
                <Show when={!pending() && filePath().includes("/")}>
                  <div data-slot="message-part-path">
                    <span data-slot="message-part-directory">{getDirectory(filePath())}</span>
                  </div>
                </Show>
              </div>
              <div data-slot="message-part-actions">
                <Show when={!pending() && changes()}>{(value) => <DiffChanges changes={value()} />}</Show>
              </div>
            </div>
          }
        >
          <Show when={path()}>
            <ToolFileAccordion
              path={path()}
              actions={<Show when={!pending() && changes()}>{(value) => <DiffChanges changes={value()} />}</Show>}
            >
              <div data-component="edit-content">
                <Dynamic
                  component={fileComponent}
                  mode="diff"
                  virtualize={props.virtualizeDiff}
                  onRendered={props.onContentRendered}
                  {...fileCompProps()}
                />
              </div>
            </ToolFileAccordion>
          </Show>
          <DiagnosticsDisplay diagnostics={diagnostics()} />
        </BasicTool>
      </div>
    )
  },
})

ToolRegistry.register({
  name: "write",
  render(props) {
    const i18n = useI18n()
    const fileComponent = useFileComponent()
    const filePath = createMemo(() => toolPath(props.input) ?? "")
    const content = createMemo(() => stringField(props.input, "content") ?? "")
    const diagnostics = createMemo(() => getDiagnostics(props.metadata.diagnostics, filePath()))
    const filename = () => getFilename(filePath())
    const pending = () => props.status === "pending" || props.status === "running"
    return (
      <div data-component="write-tool">
        <BasicTool
          {...props}
          icon="code-lines"
          defer={props.deferContent !== false}
          trigger={
            <div data-component="write-trigger">
              <div data-slot="message-part-title-area">
                <div data-slot="message-part-title">
                  <span data-slot="message-part-title-text">
                    <TextShimmer text={i18n.t("ui.messagePart.title.write")} active={pending()} />
                  </span>
                  <Show when={!pending()}>
                    <span data-slot="message-part-title-filename">{filename()}</span>
                  </Show>
                </div>
                <Show when={!pending() && filePath().includes("/")}>
                  <div data-slot="message-part-path">
                    <span data-slot="message-part-directory">{getDirectory(filePath())}</span>
                  </div>
                </Show>
              </div>
              <div data-slot="message-part-actions">{/* <DiffChanges diff={diff} /> */}</div>
            </div>
          }
        >
          <Show when={content() && filePath()}>
            <ToolFileAccordion path={filePath()}>
              <div data-component="write-content">
                <Dynamic
                  component={fileComponent}
                  mode="text"
                  file={{
                    name: filePath(),
                    contents: content(),
                    cacheKey: checksum(content()),
                  }}
                  overflow="scroll"
                  onRendered={props.onContentRendered}
                />
              </div>
            </ToolFileAccordion>
          </Show>
          <DiagnosticsDisplay diagnostics={diagnostics()} />
        </BasicTool>
      </div>
    )
  },
})

ToolRegistry.register({
  name: "apply_patch",
  render(props) {
    const i18n = useI18n()
    const fileComponent = useFileComponent()
    const files = createMemo(() => patchFiles(props.metadata.files))
    const pending = createMemo(() => props.status === "pending" || props.status === "running")
    const single = createMemo(() => {
      const list = files()
      if (list.length !== 1) return
      return list[0]
    })
    const [expanded, setExpanded] = createSignal<string[]>([])
    let seeded = false

    createEffect(() => {
      const list = files()
      if (list.length === 0) return
      if (seeded) return
      seeded = true
      setExpanded(list.filter((f) => f.type !== "delete").map((f) => f.filePath))
    })

    const subtitle = createMemo(() => {
      const count = files().length
      if (count === 0) return ""
      return `${count} ${i18n.t(count > 1 ? "ui.common.file.other" : "ui.common.file.one")}`
    })

    return (
      <Show
        when={single()}
        fallback={
          <div data-component="apply-patch-tool">
            <BasicTool
              {...props}
              icon="code-lines"
              defer={props.deferContent !== false}
              trigger={{
                title: i18n.t("ui.tool.patch"),
                subtitle: subtitle(),
              }}
            >
              <Show when={files().length > 0}>
                <Accordion
                  multiple
                  data-scope="apply-patch"
                  style={{ "--sticky-accordion-offset": "calc(32px + var(--tool-content-gap))" }}
                  value={expanded()}
                  onChange={(value) => setExpanded(Array.isArray(value) ? value : value ? [value] : [])}
                >
                  <For each={files()}>
                    {(file) => {
                      const active = createMemo(() => expanded().includes(file.filePath))
                      const [visible, setVisible] = createSignal(false)

                      createEffect(() => {
                        if (!active()) {
                          setVisible(false)
                          return
                        }

                        requestAnimationFrame(() => {
                          if (!active()) return
                          setVisible(true)
                        })
                      })

                      return (
                        <Accordion.Item value={file.filePath} data-type={file.type}>
                          <StickyAccordionHeader>
                            <Accordion.Trigger>
                              <div data-slot="apply-patch-trigger-content">
                                <div data-slot="apply-patch-file-info">
                                  <FileIcon node={{ path: file.relativePath, type: "file" }} />
                                  <div data-slot="apply-patch-file-name-container">
                                    <Show when={file.relativePath.includes("/")}>
                                      <span data-slot="apply-patch-directory">{`\u202A${getDirectory(file.relativePath)}\u202C`}</span>
                                    </Show>
                                    <span data-slot="apply-patch-filename">{getFilename(file.relativePath)}</span>
                                  </div>
                                </div>
                                <div data-slot="apply-patch-trigger-actions">
                                  <Switch>
                                    <Match when={file.type === "add"}>
                                      <span data-slot="apply-patch-change" data-type="added">
                                        {i18n.t("ui.patch.action.created")}
                                      </span>
                                    </Match>
                                    <Match when={file.type === "delete"}>
                                      <span data-slot="apply-patch-change" data-type="removed">
                                        {i18n.t("ui.patch.action.deleted")}
                                      </span>
                                    </Match>
                                    <Match when={file.type === "move"}>
                                      <span data-slot="apply-patch-change" data-type="modified">
                                        {i18n.t("ui.patch.action.moved")}
                                      </span>
                                    </Match>
                                    <Match when={true}>
                                      <DiffChanges changes={{ additions: file.additions, deletions: file.deletions }} />
                                    </Match>
                                  </Switch>
                                  <Icon name="chevron-grabber-vertical" size="small" />
                                </div>
                              </div>
                            </Accordion.Trigger>
                          </StickyAccordionHeader>
                          <Accordion.Content>
                            <Show when={props.deferContent === false || visible()}>
                              <div data-component="apply-patch-file-diff">
                                <Dynamic
                                  component={fileComponent}
                                  mode="diff"
                                  virtualize={props.virtualizeDiff}
                                  fileDiff={file.view.fileDiff}
                                  hunkSeparators={file.view.fileDiff.isPartial ? "simple" : "line-info-basic"}
                                  onRendered={props.onContentRendered}
                                />
                              </div>
                            </Show>
                          </Accordion.Content>
                        </Accordion.Item>
                      )
                    }}
                  </For>
                </Accordion>
              </Show>
            </BasicTool>
          </div>
        }
      >
        <div data-component="apply-patch-tool">
          <BasicTool
            {...props}
            icon="code-lines"
            defer={props.deferContent !== false}
            trigger={
              <div data-component="edit-trigger">
                <div data-slot="message-part-title-area">
                  <div data-slot="message-part-title">
                    <span data-slot="message-part-title-text">
                      <TextShimmer text={i18n.t("ui.tool.patch")} active={pending()} />
                    </span>
                    <Show when={!pending()}>
                      <span data-slot="message-part-title-filename">{getFilename(single()!.relativePath)}</span>
                    </Show>
                  </div>
                  <Show when={!pending() && single()!.relativePath.includes("/")}>
                    <div data-slot="message-part-path">
                      <span data-slot="message-part-directory">{getDirectory(single()!.relativePath)}</span>
                    </div>
                  </Show>
                </div>
                <div data-slot="message-part-actions">
                  <Show when={!pending()}>
                    <DiffChanges changes={{ additions: single()!.additions, deletions: single()!.deletions }} />
                  </Show>
                </div>
              </div>
            }
          >
            <ToolFileAccordion
              path={single()!.relativePath}
              actions={
                <Switch>
                  <Match when={single()!.type === "add"}>
                    <span data-slot="apply-patch-change" data-type="added">
                      {i18n.t("ui.patch.action.created")}
                    </span>
                  </Match>
                  <Match when={single()!.type === "delete"}>
                    <span data-slot="apply-patch-change" data-type="removed">
                      {i18n.t("ui.patch.action.deleted")}
                    </span>
                  </Match>
                  <Match when={single()!.type === "move"}>
                    <span data-slot="apply-patch-change" data-type="modified">
                      {i18n.t("ui.patch.action.moved")}
                    </span>
                  </Match>
                  <Match when={true}>
                    <DiffChanges changes={{ additions: single()!.additions, deletions: single()!.deletions }} />
                  </Match>
                </Switch>
              }
            >
              <div data-component="apply-patch-file-diff">
                <Dynamic
                  component={fileComponent}
                  mode="diff"
                  virtualize={props.virtualizeDiff}
                  fileDiff={single()!.view.fileDiff}
                  onRendered={props.onContentRendered}
                />
              </div>
            </ToolFileAccordion>
          </BasicTool>
        </div>
      </Show>
    )
  },
})

ToolRegistry.register({
  name: "todowrite",
  render(props) {
    const i18n = useI18n()
    const todos = createMemo(() => {
      const meta = props.metadata?.todos
      if (Array.isArray(meta)) return meta

      const input = props.input.todos
      if (Array.isArray(input)) return input

      return []
    })

    const subtitle = createMemo(() => {
      const list = todos()
      if (list.length === 0) return ""
      return `${list.filter((t: Todo) => t.status === "completed").length}/${list.length}`
    })

    return (
      <BasicTool
        {...props}
        defaultOpen
        icon="checklist"
        trigger={{
          title: i18n.t("ui.tool.todos"),
          subtitle: subtitle(),
        }}
      >
        <Show when={todos().length}>
          <div data-component="todos">
            <For each={todos()}>
              {(todo: Todo) => (
                <Checkbox readOnly checked={todo.status === "completed"}>
                  <span
                    data-slot="message-part-todo-content"
                    data-completed={todo.status === "completed" ? "completed" : undefined}
                  >
                    {todo.content}
                  </span>
                </Checkbox>
              )}
            </For>
          </div>
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "question",
  render(props) {
    const i18n = useI18n()
    const questions = createMemo(() => (props.input.questions ?? []) as QuestionV2Info[])
    const answers = createMemo(() => (props.metadata.answers ?? []) as QuestionV2Answer[])
    const completed = createMemo(() => answers().length > 0)

    const subtitle = createMemo(() => {
      const count = questions().length
      if (count === 0) return ""
      if (completed()) return i18n.t("ui.question.subtitle.answered", { count })
      return `${count} ${i18n.t(count > 1 ? "ui.common.question.other" : "ui.common.question.one")}`
    })

    return (
      <BasicTool
        {...props}
        defaultOpen={completed()}
        icon="bubble-5"
        trigger={{
          title: i18n.t("ui.tool.questions"),
          subtitle: subtitle(),
        }}
      >
        <Show when={completed()}>
          <div data-component="question-answers">
            <For each={questions()}>
              {(q, i) => {
                const answer = () => answers()[i()] ?? []
                return (
                  <div data-slot="question-answer-item">
                    <div data-slot="question-text">{q.question}</div>
                    <div data-slot="answer-text">{answer().join(", ") || i18n.t("ui.question.answer.none")}</div>
                  </div>
                )
              }}
            </For>
          </div>
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "skill",
  render(props) {
    const i18n = useI18n()
    const title = createMemo(() => stringField(props.input, "name") || i18n.t("ui.tool.skill"))
    const running = createMemo(() => props.status === "pending" || props.status === "running")

    const titleContent = () => <TextShimmer text={title()} active={running()} />

    const trigger = () => (
      <div data-slot="basic-tool-tool-info-structured">
        <div data-slot="basic-tool-tool-info-main">
          <span data-slot="basic-tool-tool-title" class="capitalize agent-title">
            {titleContent()}
          </span>
        </div>
      </div>
    )

    return <BasicTool {...props} icon="brain" status={props.status} trigger={trigger()} hideDetails />
  },
})
