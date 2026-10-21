import type { Message, Part, SessionMessage } from "@opencode-ai/sdk/v2/client"
import { resolvePartText } from "@opencode-ai/ui/message-part-text"
import { compareMessageTime } from "@/utils/message-order"

export const SESSION_MESSAGE_WINDOW_LIMIT = 600
export const SESSION_MESSAGE_REOPEN_LIMIT = 200
export const SESSION_MESSAGE_WINDOW_EDGE = 300
export const SESSION_MESSAGE_PAGE_LOOKBEHIND = 12

type MessageWindowStore = {
  message: Record<string, Message[] | undefined>
  part: Record<string, Part[] | undefined>
  part_text_accum_delta: Record<string, string | undefined>
}

type WindowMode = "replace" | "prepend" | "append"

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export function mergeByID<T extends { id: string }>(current: readonly T[], incoming: readonly T[]) {
  const map = new Map(current.map((item) => [item.id, item] as const))
  for (const item of incoming) map.set(item.id, item)
  return [...map.values()].sort((a, b) => cmp(a.id, b.id))
}

export function mergePartsPreservingText(
  current: readonly Part[],
  incoming: readonly Part[],
  accumulated: Record<string, string | undefined>,
) {
  // V2 user files have stable positional IDs. Once that representation arrives,
  // random optimistic/legacy IDs are aliases, not additional attachments. Keep
  // this independent of the short-lived optimistic registry and delivery order.
  const projectedFileMessages = new Set([...current, ...incoming].filter(isProjectedUserFile).map((part) => part.messageID))
  const keep = (part: Part) =>
    !!part?.id && (part.type !== "file" || !projectedFileMessages.has(part.messageID) || isProjectedUserFile(part))
  const map = new Map(current.filter(keep).map((part) => [part.id, part] as const))
  for (const part of incoming) {
    if (!keep(part)) continue
    map.set(part.id, preservePartText(map.get(part.id), part, accumulated[part.id]))
  }
  return [...map.values()].sort((a, b) => cmp(a.id, b.id))
}

function isProjectedUserFile(part: Part) {
  if (part?.type !== "file") return false
  // The adapter and prompt.promoted projection synthesize file:N for admitted
  // user files; assistant/tool attachments use attachment:N instead.
  const prefix = `${part.messageID}:file:`
  return part.id.startsWith(prefix) && /^\d+$/.test(part.id.slice(prefix.length))
}

function preservePartText(current: Part | undefined, incoming: Part, accumulated: string | undefined) {
  const incomingText = readText(incoming)
  if (incomingText === undefined) return incoming
  const resolved = resolvePartText(incomingText, accumulated)
  if (resolved.keepAccumulated) return { ...incoming, text: resolved.text } as Part

  const currentText = readText(current)
  if (currentText && currentText.length > incomingText.length && currentText.startsWith(incomingText)) {
    return { ...incoming, text: currentText } as Part
  }
  return incoming
}

function readText(part: Part | undefined) {
  if (!part || !("text" in part) || typeof part.text !== "string") return
  return part.text
}

export function windowSessionMessages(
  messages: readonly Message[],
  options: { limit?: number; edge?: number; mode?: WindowMode; protect?: Iterable<string> } = {},
) {
  const limit = options.limit ?? SESSION_MESSAGE_WINDOW_LIMIT
  const sorted = messages.slice().sort((a, b) => cmp(a.id, b.id))
  if (sorted.length <= limit) return { messages: sorted, dropped: [] as string[] }

  const chronological = messages.slice().sort(compareMessageTime)
  const protect = new Set(options.protect ?? [])
  const keep = new Set<string>()
  const add = (message: Message | undefined) => {
    if (message) keep.add(message.id)
  }

  if (options.mode === "prepend") {
    const edge = Math.max(1, Math.min(limit - 1, options.edge ?? SESSION_MESSAGE_WINDOW_EDGE))
    chronological.slice(0, edge).forEach(add)
    chronological.slice(-(limit - edge)).forEach(add)
  } else {
    chronological.slice(-limit).forEach(add)
  }

  sorted.filter((message) => protect.has(message.id)).forEach(add)

  for (const message of sorted) {
    if (message.role === "assistant" && keep.has(message.id)) keep.add(message.parentID)
  }
  for (const message of sorted) {
    if (message.role === "assistant" && keep.has(message.parentID)) keep.add(message.id)
  }

  const next = sorted.filter((message) => keep.has(message.id))
  return {
    messages: next,
    dropped: sorted.filter((message) => !keep.has(message.id)).map((message) => message.id),
  }
}

export function windowRawSessionMessages(messages: SessionMessage[], mode?: "replace" | "prepend") {
  const limit = 900
  if (messages.length <= limit) return messages.slice().sort((a, b) => cmp(a.id, b.id))
  const sorted = messages.slice().sort(compareMessageTime)
  const edge = Math.floor(limit / 2)
  const selected = mode === "prepend" ? [...sorted.slice(0, edge), ...sorted.slice(-edge)] : sorted.slice(-limit)
  // Store consumers still use binary ID lookups; only window selection uses time.
  return selected.sort((a, b) => cmp(a.id, b.id))
}

export function dropMessageParts(store: MessageWindowStore, messageIDs: Iterable<string>) {
  for (const messageID of messageIDs) {
    const parts = store.part[messageID]
    if (parts) {
      for (const part of parts) delete store.part_text_accum_delta[part.id]
    }
    delete store.part[messageID]
  }
}
