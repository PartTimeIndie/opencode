import type { AssistantMessage, Message, Part, SessionStatus, UserMessage } from "@opencode-ai/sdk/v2"
import { createMemo, type Accessor } from "solid-js"
import { compareMessageTime } from "@/utils/message-order"
import { Timeline, TimelineRow } from "./rows"

const emptyAssistantMessages: AssistantMessage[] = []
const emptyParts: Part[] = []

export function createTimelineProjection(input: {
  messages: Accessor<Message[]>
  userMessages: Accessor<UserMessage[]>
  parts: (messageID: string) => Part[]
  status: Accessor<SessionStatus>
  showReasoningSummaries: Accessor<boolean>
}) {
  const chronologicalMessages = createMemo(() => input.messages().slice().sort(compareMessageTime))
  const messageByID = createMemo(() => new Map(input.messages().map((message) => [message.id, message] as const)))
  const assistantMessagesByParent = createMemo(() => {
    const result = new Map<string, AssistantMessage[]>()
    chronologicalMessages().forEach((message) => {
      if (message.role !== "assistant") return
      const messages = result.get(message.parentID)
      if (messages) {
        messages.push(message)
        return
      }
      result.set(message.parentID, [message])
    })
    return result
  })
  const activeMessageID = createMemo(() => {
    const parentID = chronologicalMessages()
      .findLast(
        (message): message is AssistantMessage =>
          message.role === "assistant" && typeof message.time.completed !== "number",
      )?.parentID
    if (parentID) {
      const message = messageByID().get(parentID)
      if (message?.role === "user") return message.id
    }

    if (input.status().type === "idle") return
    return chronologicalMessages().findLast((message) => message.role === "user")?.id
  })
  const messageRowCache = createMessageRowCache()
  const rows = createMemo((previous: TimelineRow.TimelineRow[] | undefined) =>
    reuseTimelineRows(
      previous,
      buildRows({
        userMessages: input.userMessages(),
        parts: input.parts,
        assistantMessagesByParent: assistantMessagesByParent(),
        showReasoningSummaries: input.showReasoningSummaries(),
        status: input.status().type,
        activeMessageID: activeMessageID(),
        cache: messageRowCache,
      }),
    ),
  )
  const rowByKey = createMemo(() => new Map(rows().map((row) => [TimelineRow.key(row), row] as const)))
  const messageRowIndex = createMemo(() => {
    const result = new Map<string, number>()
    rows().forEach((row, index) => {
      if (!("userMessageID" in row) || result.has(row.userMessageID)) return
      result.set(row.userMessageID, index)
    })
    return result
  })
  const messageLastRowIndex = createMemo(() => {
    const result = new Map<string, number>()
    rows().forEach((row, index) => {
      if ("userMessageID" in row) result.set(row.userMessageID, index)
    })
    return result
  })
  const lastAssistantGroupKey = createMemo(() => {
    const result = new Map<string, string>()
    rows().forEach((row) => {
      if (row._tag === "AssistantPart") result.set(row.userMessageID, row.group.key)
    })
    return result
  })

  return {
    activeMessageID,
    assistantMessagesByParent,
    lastAssistantGroupKey,
    messageByID,
    messageRowIndex,
    messageLastRowIndex,
    rowByKey,
    rows,
  }
}

export function createMessageRowCache() {
  const cache = new Map<string, MessageRowCacheEntry>()
  return {
    rows(input: MessageRowCacheInput) {
      const signature = messageRowSignature(input)
      const previous = cache.get(input.userMessage.id)
      if (previous && sameMessageRowSignature(previous.signature, signature)) return previous.rows
      const parts = new Map<string, Part[]>([
        [input.userMessage.id, input.userParts],
        ...input.assistantMessages.map((message, index) => [message.id, input.assistantParts[index] ?? emptyParts] as const),
      ])
      const rows = reuseTimelineRows(
        previous?.rows,
        Timeline.constructMessageRows(
          input.userMessage,
          (messageID) => parts.get(messageID) ?? emptyParts,
          input.assistantMessages,
          input.previousUserMessage ? 1 : 0,
          input.showReasoningSummaries,
          input.status,
          input.active,
        ),
      )
      cache.set(input.userMessage.id, { signature, rows })
      return rows
    },
    prune(userMessageIDs: ReadonlySet<string>) {
      Array.from(cache.keys())
        .filter((key) => !userMessageIDs.has(key))
        .forEach((key) => cache.delete(key))
    },
  }
}

type MessageRowCache = ReturnType<typeof createMessageRowCache>

type MessageRowCacheInput = {
  readonly userMessage: UserMessage
  readonly userParts: Part[]
  readonly assistantMessages: AssistantMessage[]
  readonly assistantParts: ReadonlyArray<Part[]>
  readonly previousUserMessage: boolean
  readonly showReasoningSummaries: boolean
  readonly status: SessionStatus["type"]
  readonly active: boolean
}

type MessageRowSignature = {
  readonly userMessageID: string
  readonly userSummary: SummaryDiffSignature[]
  readonly userParts: PartSignature[]
  readonly assistantMessages: AssistantMessageSignature[]
  readonly assistantParts: PartSignature[][]
  readonly previousUserMessage: boolean
  readonly active: boolean
  readonly activeStatus?: SessionStatus["type"]
}

type SummaryDiffSignature = {
  readonly file?: string
  readonly additions: number
  readonly deletions: number
  readonly status?: "added" | "deleted" | "modified"
  readonly patch?: string
}

type AssistantMessageSignature = {
  readonly id: string
  readonly errorName?: string
  readonly errorMessage?: unknown
}

type PartSignature = {
  readonly id: string
  readonly messageID: string
  readonly type: Part["type"]
  readonly textVisible?: boolean
  readonly syntheticText?: string
  readonly hiddenHeadingText?: string
  readonly tool?: string
  readonly state?: string
}

type MessageRowCacheEntry = {
  readonly signature: MessageRowSignature
  readonly rows: TimelineRow.TimelineRow[]
}

function buildRows(input: {
  readonly userMessages: ReadonlyArray<UserMessage>
  readonly parts: (messageID: string) => Part[]
  readonly assistantMessagesByParent: ReadonlyMap<string, AssistantMessage[]>
  readonly showReasoningSummaries: boolean
  readonly status: SessionStatus["type"]
  readonly activeMessageID: string | undefined
  readonly cache: MessageRowCache
}) {
  const current = new Set(input.userMessages.map((message) => message.id))
  input.cache.prune(current)
  return input.userMessages.flatMap((userMessage, index) => {
    const assistantMessages = input.assistantMessagesByParent.get(userMessage.id) ?? emptyAssistantMessages
    return input.cache.rows({
      userMessage,
      userParts: input.parts(userMessage.id),
      assistantMessages,
      assistantParts: assistantMessages.map((message) => input.parts(message.id)),
      previousUserMessage: index > 0,
      showReasoningSummaries: input.showReasoningSummaries,
      status: input.status,
      active: input.activeMessageID === userMessage.id,
    })
  })
}

function messageRowSignature(input: MessageRowCacheInput): MessageRowSignature {
  const activeBusy = input.active && input.status === "busy"
  return {
    userMessageID: input.userMessage.id,
    userSummary: summarySignature(input.userMessage.summary),
    userParts: partListSignature(input.userParts, {
      user: true,
      activeBusy,
      showReasoningSummaries: input.showReasoningSummaries,
    }),
    assistantMessages: input.assistantMessages.map(assistantMessageSignature),
    assistantParts: input.assistantParts.map((parts) =>
      partListSignature(parts, { user: false, activeBusy, showReasoningSummaries: input.showReasoningSummaries }),
    ),
    previousUserMessage: input.previousUserMessage,
    active: input.active,
    activeStatus: input.active ? input.status : undefined,
  }
}

function sameMessageRowSignature(a: MessageRowSignature, b: MessageRowSignature) {
  return (
    a.userMessageID === b.userMessageID &&
    sameArray(a.userSummary, b.userSummary, sameSummaryDiffSignature) &&
    sameArray(a.userParts, b.userParts, samePartSignature) &&
    a.previousUserMessage === b.previousUserMessage &&
    a.active === b.active &&
    a.activeStatus === b.activeStatus &&
    sameArray(a.assistantMessages, b.assistantMessages, sameAssistantMessageSignature) &&
    sameArray(a.assistantParts, b.assistantParts, (left, right) => sameArray(left, right, samePartSignature))
  )
}

function summarySignature(summary: UserMessage["summary"]) {
  return (summary?.diffs ?? []).map((diff) => ({
    file: diff.file,
    additions: diff.additions,
    deletions: diff.deletions,
    status: diff.status,
    patch: diff.patch,
  }))
}

function sameSummaryDiffSignature(
  a: MessageRowSignature["userSummary"][number],
  b: MessageRowSignature["userSummary"][number],
) {
  return (
    a.file === b.file &&
    a.additions === b.additions &&
    a.deletions === b.deletions &&
    a.status === b.status &&
    a.patch === b.patch
  )
}

function assistantMessageSignature(message: AssistantMessage) {
  return {
    id: message.id,
    errorName: message.error?.name,
    errorMessage: message.error?.data.message,
  }
}

function sameAssistantMessageSignature(
  a: MessageRowSignature["assistantMessages"][number],
  b: MessageRowSignature["assistantMessages"][number],
) {
  return a.id === b.id && a.errorName === b.errorName && a.errorMessage === b.errorMessage
}

function partListSignature(
  parts: Part[],
  options: { user: boolean; activeBusy: boolean; showReasoningSummaries: boolean },
) {
  return parts.map((part) => partSignature(part, options))
}

function partSignature(
  part: Part,
  options: { user: boolean; activeBusy: boolean; showReasoningSummaries: boolean },
): PartSignature {
  const base = { id: part.id, messageID: part.messageID, type: part.type }
  if (part.type === "text") {
    return {
      ...base,
      textVisible: !!part.text?.trim(),
      syntheticText: options.user && part.synthetic ? part.text : undefined,
    }
  }
  if (part.type === "reasoning") {
    return {
      ...base,
      textVisible: options.showReasoningSummaries && !!part.text?.trim(),
      hiddenHeadingText: options.activeBusy && !options.showReasoningSummaries ? part.text : undefined,
    }
  }
  if (part.type === "tool") {
    return { ...base, tool: part.tool, state: part.state.status }
  }
  return base
}

function samePartSignature(
  a: PartSignature,
  b: PartSignature,
) {
  return (
    a.id === b.id &&
    a.messageID === b.messageID &&
    a.type === b.type &&
    a.textVisible === b.textVisible &&
    a.syntheticText === b.syntheticText &&
    a.hiddenHeadingText === b.hiddenHeadingText &&
    a.tool === b.tool &&
    a.state === b.state
  )
}

function sameArray<T>(a: ReadonlyArray<T>, b: ReadonlyArray<T>, same: (left: T, right: T) => boolean) {
  return a.length === b.length && a.every((value, index) => same(value, b[index]!))
}

export function reuseTimelineRows(previous: TimelineRow.TimelineRow[] | undefined, rows: TimelineRow.TimelineRow[]) {
  if (!previous?.length) return rows
  const byKey = new Map(previous.map((row) => [TimelineRow.key(row), row] as const))
  const next = rows.map((row) => {
    const existing = byKey.get(TimelineRow.key(row))
    if (!existing) return row
    return TimelineRow.equals(existing, row) ? existing : row
  })
  if (previous.length === next.length && previous.every((row, index) => row === next[index])) return previous
  return next
}
