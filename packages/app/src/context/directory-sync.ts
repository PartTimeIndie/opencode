import { batch, createEffect, createMemo, onCleanup } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { Binary } from "@opencode-ai/core/util/binary"
import { retry } from "@opencode-ai/core/util/retry"
import {
  canUseSessionPrefetch,
  cancelSessionPrefetch,
  clearSessionPrefetch,
  getSessionPrefetch,
  getSessionPrefetchPromise,
  setSessionPrefetch,
} from "./global-sync/session-prefetch"
import type { Message, Part, SessionMessage, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { SESSION_CACHE_LIMIT, dropSessionCaches, pickSessionCacheEvictions } from "./global-sync/session-cache"
import type { State } from "./global-sync/types"
import { adaptSessionMessages } from "./global-sync/session-message-adapter"
import {
  SESSION_MESSAGE_PAGE_LOOKBEHIND,
  SESSION_MESSAGE_WINDOW_LIMIT,
  dropMessageParts,
  mergeByID,
  mergePartsPreservingText,
  windowRawSessionMessages,
  windowSessionMessages,
} from "./global-sync/session-message-window"
import { mergeSessionList, replaceSessionList } from "./global-sync/session-list"
import { missingOptimisticParts } from "./optimistic-parts"
import { diffs as list, message as clean } from "@/utils/diffs"
import { type SyncServerEvent, type createServerSdkContext } from "./server-sdk"
import { type createServerSyncContextInner } from "./server-sync"
import { recordPerfEvent } from "@/utils/perf-recorder"
import { compareMessageTime } from "@/utils/message-order"
import { createSessionLiveProjection, type LiveProjectionAction } from "./global-sync/session-live-projection"
import {
  finishSessionActivity,
  sessionActivity,
  sessionActivityDismissed,
  sessionActivityGeneration,
  sessionActivitySettled,
  startSessionActivity,
  updateSessionActivity,
} from "@/utils/session-activity"
import { clearSessionQueuedInputs, recordQueuedInput, resolveQueuedInput } from "@/utils/session-queued-inputs"
import {
  SESSION_MESSAGE_REQUEST_RETRIES,
  SESSION_MESSAGE_REQUEST_TIMEOUT_MS,
  isSessionMessageRequestTimeoutError,
  withSessionMessageRequestTimeout,
} from "./session-message-request"

export {
  SESSION_MESSAGE_REQUEST_RETRIES,
  SESSION_MESSAGE_REQUEST_TIMEOUT_MS,
  isSessionMessageRequestTimeoutError,
  withSessionMessageRequestTimeout,
} from "./session-message-request"

// Session metadata (session.get) uses the same foreground budget as message
// reads: parity only, no timeout raise. A hung metadata request must not hold
// cold sync or force-refresh forever while messages are already fast.
export const SESSION_METADATA_REQUEST_TIMEOUT_MS = SESSION_MESSAGE_REQUEST_TIMEOUT_MS
export const SESSION_METADATA_REQUEST_RETRIES = SESSION_MESSAGE_REQUEST_RETRIES

const SKIP_PARTS = new Set(["patch", "step-start", "step-finish"])
const SKIP_SYNC_REFRESH = new Set([
  "session.next.prompt.admitted",
  "session.next.prompt.promoted",
  "session.next.agent.switched",
  "session.next.model.switched",
  "session.next.context.updated",
  "session.next.title.updated",
  "session.next.activity.started",
  "session.next.activity.recovered",
  "session.next.activity.interrupted",
  "session.next.step.started",
  "session.next.text.started",
  "session.next.text.delta",
  "session.next.reasoning.started",
  "session.next.reasoning.delta",
  "session.next.tool.input.started",
  "session.next.tool.input.delta",
  "session.next.compaction.started",
  "session.next.compaction.delta",
])
const SESSION_MESSAGE_READ_LIMIT = SESSION_MESSAGE_WINDOW_LIMIT
const SESSION_MESSAGE_API_LIMIT = 200

function sortParts(parts: Part[]) {
  return parts.filter((part) => !!part?.id).sort((a, b) => cmp(a.id, b.id))
}

function runInflight(map: Map<string, Promise<void>>, key: string, task: () => Promise<void>) {
  const pending = map.get(key)
  if (pending) return pending
  const promise = task().finally(() => {
    map.delete(key)
  })
  map.set(key, promise)
  return promise
}

export function shouldSkipForcedSessionRefresh(input: {
  mode?: "replace" | "prepend"
  before?: object
  after?: object
}) {
  return input.mode === "replace" && !!input.after && input.after !== input.before
}

const keyFor = (directory: string, id: string) => `${directory}\n${id}`

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export function createCrossStreamEventDeduplicator() {
  const seen = new Map<string, true>()
  return {
    accept(id?: string) {
      if (!id) return true
      if (seen.has(id)) return false
      seen.set(id, true)
      if (seen.size > 4096) seen.delete(seen.keys().next().value!)
      return true
    },
    clear: () => seen.clear(),
  }
}

export const isSessionNotFoundError = (error: unknown) =>
  error instanceof Error &&
  typeof error.cause === "object" &&
  error.cause !== null &&
  (error.cause as { status?: unknown }).status === 404

export const isInvalidCursorError = (error: unknown) =>
  error instanceof Error &&
  typeof error.cause === "object" &&
  error.cause !== null &&
  (error.cause as { status?: unknown }).status === 400 &&
  (error.message.toLowerCase().includes("invalid cursor") ||
    isInvalidCursorBody((error.cause as { body?: unknown }).body))

export function clearRevertedV2MessageCache(
  cache: Map<string, SessionMessage[]>,
  key: string,
  messageIDs: Iterable<string>,
) {
  const messages = cache.get(key)
  if (!messages) return
  const removed = new Set(messageIDs)
  const next = messages.filter((message) => !removed.has(message.id))
  if (next.length === messages.length) return
  cache.set(key, next)
}

function isInvalidCursorBody(body: unknown) {
  if (typeof body !== "object" || body === null) return false
  return (
    ("_tag" in body && body._tag === "InvalidCursorError") ||
    ("message" in body && typeof body.message === "string" && body.message.toLowerCase().includes("invalid cursor"))
  )
}

type OptimisticStore = {
  message: Record<string, Message[] | undefined>
  part: Record<string, Part[] | undefined>
}

type OptimisticAddInput = {
  sessionID: string
  message: Message
  parts: Part[]
}

type OptimisticRemoveInput = {
  sessionID: string
  messageID: string
}

type OptimisticItem = {
  message: Message
  parts: Part[]
}

type MessagePage = {
  raw: SessionMessage[]
  cursor?: string
  complete: boolean
}

export type AdaptedMessagePage = Omit<MessagePage, "raw"> & {
  session: Message[]
  part: { id: string; part: Part[] }[]
}

export type LegacySessionMessage = {
  info: Message
  parts: Part[]
}

type MessageSource = "v2" | "legacy" | "mixed"

export function mergeAdaptedMessagePages(base: AdaptedMessagePage, overlay: AdaptedMessagePage): AdaptedMessagePage {
  return {
    cursor: base.cursor ?? overlay.cursor,
    complete: base.complete && overlay.complete,
    session: mergeByID(base.session, overlay.session),
    part: mergeByID(base.part, overlay.part),
  }
}

export function shouldOverlayLegacyHistory(input: {
  mode?: "replace" | "prepend"
  requested: number
  adapted: number
  lookbehind?: number
  source?: "v2" | "legacy" | "mixed"
}) {
  if (input.mode === "prepend") return false
  if (input.source === "v2" || input.source === "mixed") return false
  if (input.adapted === 0) return false
  const expected = Math.max(1, input.requested - (input.lookbehind ?? 0))
  return input.adapted < expected
}

export function shouldUseCachedSessionMessages(input: {
  messageLoaded: boolean
  limit?: number
  complete?: boolean
  minLimit: number
}) {
  if (!input.messageLoaded) return false
  if (input.limit === undefined) return false
  return input.complete === true || input.limit >= input.minLimit
}

export function shouldServeCachedSessionMessages(input: { cached: boolean; status?: string; activity?: string }) {
  if (!input.cached) return false
  // A completed page read is itself proof the cached window is usable. An
  // unknown session_status is not evidence of busy work: a fresh prefetch that
  // already filled the timeline must not trigger a redundant read just because
  // bootstrap has not populated the status yet. Explicit busy signals block.
  if (input.status !== undefined && input.status !== "idle") return false
  return input.activity !== "busy"
}

export function shouldRefreshSessionStatus(status?: string) {
  // A cold tab has no cached status yet. It still needs one read so its tab and
  // navigator indicator can represent an already-running background session.
  return status !== "idle"
}

export function hydratedSessionStatus(input: {
  current?: SessionStatus
  incoming?: SessionStatus
  liveBusy: boolean
  liveSettled?: boolean
}): SessionStatus {
  if (input.liveSettled && !input.liveBusy) return { type: "idle" }
  const incoming = input.incoming ?? { type: "idle" as const }
  if (incoming.type !== "idle" || !input.liveBusy) return incoming
  // Preserve the current active status when the server-side refresh reports idle
  // but the SSE connection confirms the session is still working. Retry status
  // must survive hydration the same way busy does — premature demotion to busy
  // before the provider starts creates an empty "Thinking" bubble.
  if (input.current?.type === "busy" || input.current?.type === "retry") return input.current
  return { type: "busy" }
}

export function nextSessionMessageLimit(input: { limit?: number; minLimit: number; maxLimit: number }) {
  return Math.min(Math.max(input.limit ?? input.minLimit, input.minLimit), input.maxLimit)
}

export function nextSessionMessageReadLimit(input: { limit: number; lookbehind: number }) {
  return Math.min(input.limit + input.lookbehind, SESSION_MESSAGE_READ_LIMIT, SESSION_MESSAGE_API_LIMIT)
}

export function shouldMergeCachedSessionMessages(input: {
  mode?: "replace" | "prepend"
  status?: string
  cached: number
  incoming: number
}) {
  if (input.mode === "prepend") return true
  if (input.status && input.status !== "idle") return true
  return input.cached > input.incoming
}

export function shouldLoadAdaptiveLegacyRefresh(input: {
  source?: "v2" | "legacy" | "mixed"
  mode?: "replace" | "prepend"
  cached: number
}) {
  return input.source === "legacy" && input.mode !== "prepend" && input.cached > 0
}

export function syncedSessionMessageID(event: SyncServerEvent) {
  if (!event.syncEvent.type.startsWith("session.next.")) return
  if (SKIP_SYNC_REFRESH.has(event.syncEvent.type.replace(/\.\d+$/, ""))) return
  const data = event.syncEvent.data
  if (!data || typeof data !== "object" || !("sessionID" in data)) return
  if (data.sessionID !== event.syncEvent.aggregateID) return
  return event.syncEvent.aggregateID
}

export function syncedSessionLifecycleStatus(event: SyncServerEvent) {
  const status = sessionLifecycleStatus(event.syncEvent.type.replace(/\.\d+$/, ""))
  if (!status) return
  const data = event.syncEvent.data
  if (!data || typeof data !== "object" || !("sessionID" in data)) return
  if (data.sessionID !== event.syncEvent.aggregateID) return
  return {
    sessionID: event.syncEvent.aggregateID,
    activityID: "activityID" in data && typeof data.activityID === "string" ? data.activityID : undefined,
    evidence: {
      timestamp: "timestamp" in data && typeof data.timestamp === "number" ? data.timestamp : 0,
      eventID: event.syncEvent.id,
      sequence: event.syncEvent.seq,
    },
    status,
  }
}

export function streamedSessionLifecycleStatus(event: { id?: string; type: string; properties?: unknown }) {
  const status = sessionLifecycleStatus(event.type.replace(/\.\d+$/, ""))
  if (!status) return
  const data = event.properties
  if (!data || typeof data !== "object" || !("sessionID" in data) || typeof data.sessionID !== "string") return
  return {
    sessionID: data.sessionID,
    activityID: "activityID" in data && typeof data.activityID === "string" ? data.activityID : undefined,
    evidence: {
      timestamp: "timestamp" in data && typeof data.timestamp === "number" ? data.timestamp : 0,
      eventID: "id" in event && typeof event.id === "string" ? event.id : undefined,
    },
    status,
  }
}

function sessionLifecycleStatus(type: string) {
  if (type === "session.next.activity.started" || type === "session.next.activity.recovered") {
    return { type: "busy" } as const
  }
  if (
    type === "session.next.activity.interrupted" ||
    type === "session.next.activity.completed" ||
    type === "session.next.activity.failed"
  ) {
    return { type: "idle" } as const
  }
}

export function syncedSessionRevertCleanup(event: SyncServerEvent) {
  if (event.syncEvent.type.replace(/\.\d+$/, "") !== "session.next.revert.cleaned") return
  const data = event.syncEvent.data
  if (!data || typeof data !== "object" || !("sessionID" in data) || data.sessionID !== event.syncEvent.aggregateID)
    return
  if (!("messageIDs" in data) || !Array.isArray(data.messageIDs)) return
  return {
    sessionID: event.syncEvent.aggregateID,
    messageIDs: data.messageIDs.filter((id): id is string => typeof id === "string"),
  }
}

export function streamedSessionRevertCleanup(event: { type: string; properties?: unknown }) {
  if (event.type.replace(/\.\d+$/, "") !== "session.next.revert.cleaned") return
  const data = event.properties
  if (!data || typeof data !== "object" || !("sessionID" in data) || typeof data.sessionID !== "string") return
  if (!("messageIDs" in data) || !Array.isArray(data.messageIDs)) return
  return {
    sessionID: data.sessionID,
    messageIDs: data.messageIDs.filter((id): id is string => typeof id === "string"),
  }
}

export function streamedSessionMessageID(event: { type: string; properties?: unknown }) {
  const type = event.type.replace(/\.\d+$/, "")
  if (!type.startsWith("session.next.")) return
  if (SKIP_SYNC_REFRESH.has(type)) return
  const data = event.properties
  if (!data || typeof data !== "object" || !("sessionID" in data) || typeof data.sessionID !== "string") return
  return data.sessionID
}

type V2SessionStreamEvent = {
  id?: string
  type: string
  data?: unknown
}

type V2SessionDeltaStore = {
  part: Readonly<Record<string, readonly Part[] | undefined>>
  part_text_accum_delta: Readonly<Record<string, string | undefined>>
}

type V2SessionDeltaTarget = {
  key: string
  sessionID: string
  messageID: string
  partID: string
  kind: "text" | "reasoning" | "tool-input" | "compaction"
  delta: string
}

type V2SessionBoundaryTarget = Omit<V2SessionDeltaTarget, "delta">

export function createV2SessionDeltaController() {
  const seen = new Map<string, true>()
  const ended = new Map<string, true>()
  const missing = new Map<string, { target: V2SessionDeltaTarget; refreshRequested: boolean }>()
  const boundaries = new Map<string, Map<string, V2SessionBoundaryTarget>>()

  const remember = (items: Map<string, true>, key: string) => {
    if (items.has(key)) return false
    items.set(key, true)
    if (items.size > 4096) items.delete(items.keys().next().value!)
    return true
  }

  const accept = (event: V2SessionStreamEvent) => !event.id || remember(seen, event.id)

  const handle = (event: V2SessionStreamEvent, store: V2SessionDeltaStore) => {
    const delta = v2SessionDeltaTarget(event)
    if (delta) {
      if (!accept(event) || ended.has(delta.key)) {
        return { kind: "delta" as const, applied: false as const, sessionID: delta.sessionID, refresh: false }
      }
      const pending = missing.get(delta.key)
      const target = pending ? { ...delta, delta: pending.target.delta + delta.delta } : delta
      const parts = store.part[delta.messageID]
      const index = parts?.findIndex(
        (part) => part.id === delta.partID && part.sessionID === delta.sessionID && part.messageID === delta.messageID,
      )
      if (index === undefined || index < 0 || !parts) {
        const refresh = !pending?.refreshRequested
        missing.set(delta.key, { target, refreshRequested: true })
        return { kind: "delta" as const, applied: false as const, sessionID: delta.sessionID, refresh }
      }
      const updated = applyV2SessionDelta(
        parts[index]!,
        target,
        store.part_text_accum_delta[delta.partID],
        pending !== undefined,
      )
      missing.delete(delta.key)
      if (!updated)
        return { kind: "delta" as const, applied: false as const, sessionID: delta.sessionID, refresh: false }
      return {
        kind: "delta" as const,
        applied: true as const,
        sessionID: delta.sessionID,
        messageID: delta.messageID,
        partID: delta.partID,
        index,
        part: updated.part,
        accumulatedText: updated.accumulatedText,
        refresh: false as const,
      }
    }

    const boundary = v2SessionBoundaryTarget(event)
    if (!boundary) return
    const freshEvent = accept(event)
    const freshBoundary = remember(ended, boundary.key)
    missing.delete(boundary.key)
    if (!freshEvent || !freshBoundary)
      return {
        kind: "boundary" as const,
        sessionID: boundary.sessionID,
        refresh: false as const,
      }
    const pending = boundaries.get(boundary.sessionID) ?? new Map<string, V2SessionBoundaryTarget>()
    pending.set(boundary.key, boundary)
    boundaries.set(boundary.sessionID, pending)
    return {
      kind: "boundary" as const,
      sessionID: boundary.sessionID,
      refresh: true as const,
    }
  }

  const materialize = (sessionID: string, store: V2SessionDeltaStore) => {
    const actions = [] as Array<{
      kind: "delta"
      applied: true
      sessionID: string
      messageID: string
      partID: string
      index: number
      part: Part
      accumulatedText: string | undefined
      refresh: false
    }>
    for (const [key, pending] of missing) {
      if (pending.target.sessionID !== sessionID) continue
      const parts = store.part[pending.target.messageID]
      const index = parts?.findIndex(
        (part) =>
          part.id === pending.target.partID &&
          part.sessionID === pending.target.sessionID &&
          part.messageID === pending.target.messageID,
      )
      if (index === undefined || index < 0 || !parts) {
        continue
      }
      const updated = applyV2SessionDelta(
        parts[index]!,
        pending.target,
        store.part_text_accum_delta[pending.target.partID],
        true,
      )
      missing.delete(key)
      if (!updated) continue
      actions.push({
        kind: "delta",
        applied: true,
        sessionID,
        messageID: pending.target.messageID,
        partID: pending.target.partID,
        index,
        part: updated.part,
        accumulatedText: updated.accumulatedText,
        refresh: false,
      })
    }
    return actions
  }

  const reconciled = (sessionID: string) => {
    const pending = boundaries.get(sessionID)
    if (!pending) return [] as string[]
    boundaries.delete(sessionID)
    return Array.from(pending.values(), (target) => target.partID)
  }

  const discardBoundary = (event: V2SessionStreamEvent) => {
    const boundary = v2SessionBoundaryTarget(event)
    if (!boundary) return false
    const pending = boundaries.get(boundary.sessionID)
    if (!pending?.delete(boundary.key)) return false
    if (pending.size === 0) boundaries.delete(boundary.sessionID)
    return true
  }

  const clear = () => {
    seen.clear()
    ended.clear()
    missing.clear()
    boundaries.clear()
  }

  return { handle, materialize, reconciled, discardBoundary, clear }
}

function v2SessionDeltaTarget(event: V2SessionStreamEvent): V2SessionDeltaTarget | undefined {
  const type = event.type.replace(/\.\d+$/, "")
  const data = event.data
  if (!data || typeof data !== "object" || !("sessionID" in data) || typeof data.sessionID !== "string") return
  if (
    type === "session.next.text.delta" &&
    "assistantMessageID" in data &&
    typeof data.assistantMessageID === "string" &&
    "textID" in data &&
    typeof data.textID === "string" &&
    "delta" in data &&
    typeof data.delta === "string"
  ) {
    return {
      key: `${data.sessionID}\n${data.assistantMessageID}\ntext\n${data.textID}`,
      sessionID: data.sessionID,
      messageID: data.assistantMessageID,
      partID: `${data.assistantMessageID}:${data.textID}`,
      kind: "text",
      delta: data.delta,
    }
  }
  if (
    type === "session.next.reasoning.delta" &&
    "assistantMessageID" in data &&
    typeof data.assistantMessageID === "string" &&
    "reasoningID" in data &&
    typeof data.reasoningID === "string" &&
    "delta" in data &&
    typeof data.delta === "string"
  ) {
    return {
      key: `${data.sessionID}\n${data.assistantMessageID}\nreasoning\n${data.reasoningID}`,
      sessionID: data.sessionID,
      messageID: data.assistantMessageID,
      partID: data.reasoningID,
      kind: "reasoning",
      delta: data.delta,
    }
  }
  if (
    type === "session.next.tool.input.delta" &&
    "assistantMessageID" in data &&
    typeof data.assistantMessageID === "string" &&
    "callID" in data &&
    typeof data.callID === "string" &&
    "delta" in data &&
    typeof data.delta === "string"
  ) {
    return {
      key: `${data.sessionID}\n${data.assistantMessageID}\ntool-input\n${data.callID}`,
      sessionID: data.sessionID,
      messageID: data.assistantMessageID,
      partID: data.callID,
      kind: "tool-input",
      delta: data.delta,
    }
  }
  if (
    type === "session.next.compaction.delta" &&
    "messageID" in data &&
    typeof data.messageID === "string" &&
    "text" in data &&
    typeof data.text === "string"
  ) {
    return {
      key: `${data.sessionID}\n${data.messageID}\ncompaction`,
      sessionID: data.sessionID,
      messageID: data.messageID,
      partID: `${data.messageID}:summary`,
      kind: "compaction",
      delta: data.text,
    }
  }
}

function v2SessionBoundaryTarget(event: V2SessionStreamEvent): V2SessionBoundaryTarget | undefined {
  const type = event.type.replace(/\.\d+$/, "")
  const data = event.data
  if (!data || typeof data !== "object" || !("sessionID" in data) || typeof data.sessionID !== "string") return
  if (
    type === "session.next.text.ended" &&
    "assistantMessageID" in data &&
    typeof data.assistantMessageID === "string" &&
    "textID" in data &&
    typeof data.textID === "string"
  ) {
    return {
      key: `${data.sessionID}\n${data.assistantMessageID}\ntext\n${data.textID}`,
      sessionID: data.sessionID,
      messageID: data.assistantMessageID,
      partID: `${data.assistantMessageID}:${data.textID}`,
      kind: "text",
    }
  }
  if (
    type === "session.next.reasoning.ended" &&
    "assistantMessageID" in data &&
    typeof data.assistantMessageID === "string" &&
    "reasoningID" in data &&
    typeof data.reasoningID === "string"
  ) {
    return {
      key: `${data.sessionID}\n${data.assistantMessageID}\nreasoning\n${data.reasoningID}`,
      sessionID: data.sessionID,
      messageID: data.assistantMessageID,
      partID: data.reasoningID,
      kind: "reasoning",
    }
  }
  if (
    type === "session.next.tool.input.ended" &&
    "assistantMessageID" in data &&
    typeof data.assistantMessageID === "string" &&
    "callID" in data &&
    typeof data.callID === "string"
  ) {
    return {
      key: `${data.sessionID}\n${data.assistantMessageID}\ntool-input\n${data.callID}`,
      sessionID: data.sessionID,
      messageID: data.assistantMessageID,
      partID: data.callID,
      kind: "tool-input",
    }
  }
  if (type === "session.next.compaction.ended" && "messageID" in data && typeof data.messageID === "string") {
    return {
      key: `${data.sessionID}\n${data.messageID}\ncompaction`,
      sessionID: data.sessionID,
      messageID: data.messageID,
      partID: `${data.messageID}:summary`,
      kind: "compaction",
    }
  }
}

function matchesProjectedToolInputBoundary(
  event: V2SessionStreamEvent,
  projection: LiveProjectionAction | undefined,
  store: V2SessionDeltaStore,
  match: "prefix" | "exact",
) {
  const data = event.data
  if (event.type.replace(/\.\d+$/, "") !== "session.next.tool.input.ended" || projection?.kind !== "part") return false
  if (
    !data ||
    typeof data !== "object" ||
    !("sessionID" in data) ||
    typeof data.sessionID !== "string" ||
    !("assistantMessageID" in data) ||
    typeof data.assistantMessageID !== "string" ||
    !("callID" in data) ||
    typeof data.callID !== "string" ||
    !("text" in data) ||
    typeof data.text !== "string" ||
    projection.sessionID !== data.sessionID ||
    projection.messageID !== data.assistantMessageID ||
    projection.part.type !== "tool" ||
    projection.part.id !== data.callID ||
    projection.part.callID !== data.callID ||
    projection.part.sessionID !== data.sessionID ||
    projection.part.messageID !== data.assistantMessageID ||
    projection.part.state.status !== "pending" ||
    projection.part.state.raw !== data.text
  )
    return false
  const existing = store.part[data.assistantMessageID]?.find((part) => part.id === data.callID)
  return (
    existing?.type === "tool" &&
    existing.callID === data.callID &&
    existing.sessionID === data.sessionID &&
    existing.messageID === data.assistantMessageID &&
    existing.state.status === "pending" &&
    (match === "exact" ? existing.state.raw === data.text : data.text.startsWith(existing.state.raw))
  )
}

function applyV2SessionDelta(
  part: Part,
  target: V2SessionDeltaTarget,
  accumulated: string | undefined,
  recovered: boolean,
) {
  if (target.kind === "tool-input") {
    if (part.type !== "tool" || part.callID !== target.partID || part.state.status !== "pending") return
    const raw = part.state.raw
    const next = recovered ? reconcileMissingDelta(raw, target.delta) : raw + target.delta
    return {
      part: next === raw ? part : ({ ...part, state: { ...part.state, raw: next } } as Part),
      accumulatedText: undefined,
    }
  }
  if (part.type !== (target.kind === "reasoning" ? "reasoning" : "text")) return
  const current = part.text
  const base = accumulated && accumulated.length > current.length ? accumulated : current
  const text = recovered ? reconcileMissingDelta(base, target.delta) : base + target.delta
  return { part: { ...part, text } as Part, accumulatedText: text }
}

function reconcileMissingDelta(current: string, pending: string) {
  if (!pending || current.endsWith(pending)) return current
  for (let length = pending.length - 1; length > 0; length--) {
    if (current.endsWith(pending.slice(0, length))) return current + pending.slice(length)
  }
  return current + pending
}

export function pageLegacyMessages(
  items: LegacySessionMessage[],
  input: { limit: number; cursor?: string },
): AdaptedMessagePage {
  const sorted = items.filter((message) => !!message?.info?.id).sort((a, b) => compareMessageTime(a.info, b.info))
  const end = input.cursor ? sorted.findIndex((message) => message.info.id === input.cursor) : sorted.length
  const pageEnd = end < 0 ? sorted.length : end
  const pageItems = sorted.slice(Math.max(0, pageEnd - input.limit), pageEnd)
  const cursor = pageItems.length > 0 && pageEnd > pageItems.length ? pageItems[0].info.id : undefined
  return {
    session: pageItems.map((message) => clean(message.info)).sort((a, b) => cmp(a.id, b.id)),
    part: pageItems
      .map((message) => ({
        id: message.info.id,
        part: sortParts(message.parts),
      }))
      .sort((a, b) => cmp(a.id, b.id)),
    cursor,
    complete: !cursor,
  }
}

export function pageLegacyMessageResponse(
  items: LegacySessionMessage[],
  input: { limit: number; cursor?: string },
): AdaptedMessagePage {
  const page = pageLegacyMessages(items, { limit: input.limit })
  if (!input.cursor) return page
  return { ...page, cursor: input.cursor, complete: false }
}

export function loadAdaptiveLegacyRefresh(input: {
  cachedIDs: Iterable<string>
  history: { cursor?: string; complete?: boolean }
  initialLimit?: number
  maxLimit?: number
  maxPages?: number
  read: (input: { limit: number; cursor?: string }) => Promise<AdaptedMessagePage>
}) {
  const cached = new Set(input.cachedIDs)
  const cursors = new Set<string>()
  const initialLimit = input.initialLimit ?? 25
  const maxLimit = Math.max(initialLimit, input.maxLimit ?? 200)
  const maxPages = Math.max(1, Math.min(Math.floor(input.maxPages ?? 64), 64))
  const history =
    input.history.complete === undefined
      ? undefined
      : { cursor: input.history.cursor, complete: input.history.complete }

  return readPage({
    limit: initialLimit,
    session: [] as Message[],
    part: [] as { id: string; part: Part[] }[],
    pages: 0,
  })

  async function readPage(state: {
    limit: number
    cursor?: string
    session: Message[]
    part: { id: string; part: Part[] }[]
    pages: number
  }): Promise<{ page: AdaptedMessagePage; mergeCached: boolean; pages: number }> {
    const next = await input.read({ limit: state.limit, cursor: state.cursor })
    const page = {
      session: mergeByID(state.session, next.session),
      part: mergeByID(state.part, next.part),
      cursor: next.cursor,
      complete: next.complete,
    }
    const pages = state.pages + 1
    if (next.session.some((message) => cached.has(message.id))) {
      return {
        page: history ? { ...page, ...history } : page,
        mergeCached: true,
        pages,
      }
    }
    if (next.complete || !next.cursor) return { page, mergeCached: false, pages }
    if (pages >= maxPages) throw new Error(`Legacy message refresh exceeded ${maxPages} pages`)
    if (cursors.has(next.cursor)) throw new Error("Legacy message refresh cursor repeated")
    if (page.session.length === state.session.length) {
      throw new Error("Legacy message refresh did not add messages")
    }
    cursors.add(next.cursor)
    return readPage({
      limit: Math.min(state.limit * 2, maxLimit),
      cursor: next.cursor,
      session: page.session,
      part: page.part,
      pages,
    })
  }
}

const hasParts = (parts: Part[] | undefined, want: Part[]) => {
  return missingOptimisticParts(parts, want).length === 0
}

const mergeParts = (parts: Part[] | undefined, want: Part[]) => {
  if (!parts) return sortParts(want)
  const missing = missingOptimisticParts(parts, want)
  if (missing.length === 0) return parts
  return sortParts([...parts, ...missing])
}

export function mergeOptimisticPage(page: AdaptedMessagePage, items: OptimisticItem[]) {
  if (items.length === 0) return { ...page, confirmed: [] as string[] }

  const session = [...page.session]
  const part = new Map(page.part.map((item) => [item.id, sortParts(item.part)]))
  const confirmed: string[] = []

  for (const item of items) {
    const result = Binary.search(session, item.message.id, (message) => message.id)
    const found = result.found
    if (!found) session.splice(result.index, 0, item.message)

    const current = part.get(item.message.id)
    if (found && hasParts(current, item.parts)) {
      confirmed.push(item.message.id)
      continue
    }

    part.set(item.message.id, mergeParts(current, item.parts))
  }

  return {
    cursor: page.cursor,
    complete: page.complete,
    session,
    part: [...part.entries()].sort((a, b) => cmp(a[0], b[0])).map(([id, part]) => ({ id, part })),
    confirmed,
  }
}

export function mergeFetchedMessageParts(
  current: Part[] | undefined,
  incoming: Part[],
  accumulated: Record<string, string | undefined>,
  authoritative: boolean,
) {
  return mergePartsPreservingText(authoritative ? [] : (current ?? []), incoming, accumulated)
}

export function applyOptimisticAdd(draft: OptimisticStore, input: OptimisticAddInput) {
  const messages = draft.message[input.sessionID]
  if (messages) {
    const result = Binary.search(messages, input.message.id, (m) => m.id)
    if (result.found) messages[result.index] = input.message
    else messages.splice(result.index, 0, input.message)
  } else {
    draft.message[input.sessionID] = [input.message]
  }
  draft.part[input.message.id] = sortParts(input.parts)
}

export function applyOptimisticRemove(draft: OptimisticStore, input: OptimisticRemoveInput) {
  const messages = draft.message[input.sessionID]
  if (messages) {
    const result = Binary.search(messages, input.messageID, (m) => m.id)
    if (result.found) messages.splice(result.index, 1)
  }
  delete draft.part[input.messageID]
}

export function clearOptimisticMessages<T>(optimistic: Map<string, Map<string, T>>, key: string, messageIDs: string[]) {
  const items = optimistic.get(key)
  if (!items) return
  for (const messageID of messageIDs) items.delete(messageID)
  if (items.size === 0) optimistic.delete(key)
}

function setOptimisticAdd(setStore: (...args: unknown[]) => void, input: OptimisticAddInput) {
  setStore("message", input.sessionID, (messages: Message[] | undefined) => {
    if (!messages) return [input.message]
    const result = Binary.search(messages, input.message.id, (m) => m.id)
    const next = [...messages]
    if (result.found) next[result.index] = input.message
    else next.splice(result.index, 0, input.message)
    return next
  })
  setStore("part", input.message.id, sortParts(input.parts))
}

function setOptimisticRemove(setStore: (...args: unknown[]) => void, input: OptimisticRemoveInput) {
  setStore("message", input.sessionID, (messages: Message[] | undefined) => {
    if (!messages) return messages
    const result = Binary.search(messages, input.messageID, (m) => m.id)
    if (!result.found) return messages
    const next = [...messages]
    next.splice(result.index, 1)
    return next
  })
  setStore("part", (part: Record<string, Part[] | undefined>) => {
    if (!(input.messageID in part)) return part
    const next = { ...part }
    delete next[input.messageID]
    return next
  })
}

export const createDirSyncContext = (
  directory: string,
  serverSync: ReturnType<typeof createServerSyncContextInner>,
  serverSDK: ReturnType<typeof createServerSdkContext>,
) => {
  const client = serverSDK.createClient({ directory, throwOnError: true })

  type Child = ReturnType<(typeof serverSync)["child"]>
  type Setter = Child[1]

  const current = createMemo(() => serverSync.child(directory))
  const target = (targetDirectory?: string) => {
    if (!targetDirectory || targetDirectory === directory) return current()
    return serverSync.child(targetDirectory)
  }
  const absolute = (path: string) => (current()[0].path.directory + "/" + path).replace("//", "/")
  const initialMessagePageSize = 25
  const historyMessagePageSize = 200
  const inflight = new Map<string, Promise<void>>()
  const forceRefreshes = new Map<string, Promise<void>>()
  const inflightInfo = new Map<string, Promise<void>>()
  const inflightDiff = new Map<string, Promise<void>>()
  const inflightTodo = new Map<string, Promise<void>>()
  const inflightMetadata = new Map<string, AbortController>()
  const syncRefreshes = new Map<string, { dirty: boolean; promise: Promise<void> }>()
  const v2Deltas = createV2SessionDeltaController()
  const liveProjection = createSessionLiveProjection()
  const crossStreamEvents = createCrossStreamEventDeduplicator()
  const optimistic = new Map<string, Map<string, OptimisticItem>>()
  const v2Messages = new Map<string, SessionMessage[]>()
  const messageSources = new Map<string, MessageSource>()
  const revertedMessages = new Map<string, { generation: number; messageIDs: Set<string> }>()
  const messageLoads = new Map<
    string,
    { generation: number; controller: AbortController; mode: "replace" | "prepend" }
  >()
  const messageLoadPromises = new Map<string, Promise<void>>()
  const maxDirs = 30
  const seen = new Map<string, Set<string>>()
  const [meta, setMeta] = createStore({
    limit: {} as Record<string, number>,
    cursor: {} as Record<string, string | undefined>,
    complete: {} as Record<string, boolean>,
    loading: {} as Record<string, boolean>,
    refreshing: {} as Record<string, boolean>,
  })

  const releaseMessageLoad = (key: string) => {
    const load = messageLoads.get(key)
    if (!load) return
    load.controller.abort()
    if (messageLoads.get(key) !== load) return
    messageLoads.delete(key)
    messageLoadPromises.delete(key)
    batch(() => {
      setMeta("loading", key, false)
      setMeta("refreshing", key, false)
    })
  }

  const revertGeneration = (key: string) => revertedMessages.get(key)?.generation ?? 0
  const currentRevertGeneration = (key: string, generation: number) => revertGeneration(key) === generation
  const filterReverted = <T extends { id: string }>(key: string, values: T[]) => {
    const removed = revertedMessages.get(key)?.messageIDs
    if (!removed || removed.size === 0) return values
    return values.filter((value) => !removed.has(value.id))
  }
  const filterRevertedPage = (key: string, page: AdaptedMessagePage): AdaptedMessagePage => ({
    ...page,
    session: filterReverted(key, page.session),
    part: filterReverted(key, page.part),
  })
  const cacheV2Messages = (input: {
    key: string
    generation: number
    messages: SessionMessage[]
    source?: MessageSource
  }) => {
    if (!currentRevertGeneration(input.key, input.generation)) return
    v2Messages.set(input.key, filterReverted(input.key, input.messages))
    if (input.source) messageSources.set(input.key, input.source)
  }

  const getSession = (sessionID: string) => {
    const store = current()[0]
    const match = Binary.search(store.session, sessionID, (s) => s.id)
    if (match.found) return store.session[match.index]
    return undefined
  }

  const setOptimistic = (directory: string, sessionID: string, item: OptimisticItem) => {
    const key = keyFor(directory, sessionID)
    const list = optimistic.get(key)
    if (list) {
      list.set(item.message.id, { message: item.message, parts: sortParts(item.parts) })
      return
    }
    optimistic.set(key, new Map([[item.message.id, { message: item.message, parts: sortParts(item.parts) }]]))
  }

  const clearOptimistic = (directory: string, sessionID: string, messageID?: string) => {
    const key = keyFor(directory, sessionID)
    if (!messageID) {
      optimistic.delete(key)
      return
    }
    clearOptimisticMessages(optimistic, key, [messageID])
  }

  const getOptimistic = (directory: string, sessionID: string) => [
    ...(optimistic.get(keyFor(directory, sessionID))?.values() ?? []),
  ]

  const seenFor = (directory: string) => {
    const existing = seen.get(directory)
    if (existing) {
      seen.delete(directory)
      seen.set(directory, existing)
      return existing
    }
    const created = new Set<string>()
    seen.set(directory, created)
    while (seen.size > maxDirs) {
      const first = seen.keys().next().value
      if (!first) break
      const stale = [...(seen.get(first) ?? [])]
      seen.delete(first)
      const [, setStore] = serverSync.child(first, { bootstrap: false })
      evict(first, setStore, stale)
    }
    return created
  }

  const clearMeta = (directory: string, sessionIDs: string[]) => {
    if (sessionIDs.length === 0) return
    for (const sessionID of sessionIDs) {
      clearOptimistic(directory, sessionID)
      const key = keyFor(directory, sessionID)
      releaseMessageLoad(key)
      revertedMessages.delete(key)
    }
    setMeta(
      produce((draft) => {
        for (const sessionID of sessionIDs) {
          const key = keyFor(directory, sessionID)
          delete draft.limit[key]
          delete draft.cursor[key]
          delete draft.complete[key]
          delete draft.loading[key]
          delete draft.refreshing[key]
        }
      }),
    )
  }

  const releaseSessionTimeline = (directory: string, store: State, setStore: Setter, sessionID: string) => {
    const key = keyFor(directory, sessionID)
    const messageIDs = (store.message[sessionID] ?? []).map((message) => message.id)
    seen.get(directory)?.delete(sessionID)
    releaseMessageLoad(key)
    clearSessionPrefetch(serverSDK.scope, directory, [sessionID])
    clearOptimistic(directory, sessionID)
    v2Messages.delete(key)
    messageSources.delete(key)
    setStore(
      produce((draft) => {
        dropMessageParts(draft, messageIDs)
        delete draft.message[sessionID]
      }),
    )
    setMeta(
      produce((draft) => {
        delete draft.limit[key]
        delete draft.cursor[key]
        delete draft.complete[key]
        delete draft.loading[key]
        delete draft.refreshing[key]
      }),
    )
  }

  const evict = (directory: string, setStore: Setter, sessionIDs: string[]) => {
    if (sessionIDs.length === 0) return
    clearSessionPrefetch(serverSDK.scope, directory, sessionIDs)
    for (const sessionID of sessionIDs) {
      serverSync.todo.set(directory, sessionID, undefined)
      const key = keyFor(directory, sessionID)
      v2Messages.delete(key)
      messageSources.delete(key)
    }
    setStore(
      produce((draft) => {
        dropSessionCaches(draft, sessionIDs)
      }),
    )
    clearMeta(directory, sessionIDs)
  }

  const evictMissingSession = (directory: string, setStore: Setter, sessionID: string) => {
    seenFor(directory).delete(sessionID)
    evict(directory, setStore, [sessionID])
  }

  const touch = (directory: string, setStore: Setter, sessionID: string) => {
    const stale = pickSessionCacheEvictions({
      seen: seenFor(directory),
      keep: sessionID,
      limit: SESSION_CACHE_LIMIT,
    })
    evict(directory, setStore, stale)
  }

  const fetchMessages = async (input: {
    client: typeof client
    sessionID: string
    limit: number
    cursor?: string
    signal: AbortSignal
  }) => {
    const read = (limit: number, cursor?: string) =>
      withSessionMessageRequestTimeout({
        signal: input.signal,
        task: (signal) =>
          retry(() =>
            input.client.v2.session.messages(
              {
                sessionID: input.sessionID,
                limit,
                ...(cursor ? { cursor } : { order: "desc" as const }),
              },
              { signal },
            ),
          ),
      })
    const limit = nextSessionMessageReadLimit({ limit: input.limit, lookbehind: SESSION_MESSAGE_PAGE_LOOKBEHIND })
    const messages = await read(limit, input.cursor).catch((error) => {
      if (input.cursor && isInvalidCursorError(error)) return read(limit)
      throw error
    })
    const raw = mergeByID(messages.data?.context ?? [], messages.data?.data ?? [])
    const cursor = messages.data?.cursor.next
    return {
      raw,
      cursor,
      complete: !cursor,
    }
  }

  const fetchLegacyMessages = async (input: {
    client: typeof client
    sessionID: string
    limit: number
    cursor?: string
    signal: AbortSignal
  }): Promise<AdaptedMessagePage> => {
    const limit = nextSessionMessageReadLimit({ limit: input.limit, lookbehind: 0 })
    const read = (cursor?: string) =>
      withSessionMessageRequestTimeout({
        signal: input.signal,
        task: (signal) =>
          retry(() =>
            input.client.session.messages(
              {
                sessionID: input.sessionID,
                limit,
                ...(cursor ? { before: cursor } : {}),
              },
              { signal },
            ),
          ),
      })
    const messages = await read(input.cursor).catch((error) => {
      if (input.cursor && isInvalidCursorError(error)) return read()
      throw error
    })
    return pageLegacyMessageResponse(messages.data ?? [], {
      limit,
      cursor: messages.response.headers.get("x-next-cursor") ?? undefined,
    })
  }

  const loadMessagePage = async (input: {
    directory: string
    client: typeof client
    sessionID: string
    limit: number
    cursor?: string
    mode?: "replace" | "prepend"
    cached: Message[]
    history: { cursor?: string; complete?: boolean }
    revertGeneration: number
    signal: AbortSignal
  }) => {
    const key = keyFor(input.directory, input.sessionID)
    const source = messageSources.get(key)
    if (shouldLoadAdaptiveLegacyRefresh({ source, mode: input.mode, cached: input.cached.length })) {
      const refresh = await loadAdaptiveLegacyRefresh({
        cachedIDs: input.cached.map((message) => message.id),
        history: input.history,
        initialLimit: initialMessagePageSize,
        maxLimit: SESSION_MESSAGE_API_LIMIT,
        read: ({ limit, cursor }) => fetchLegacyMessages({ ...input, limit, cursor }),
      })
      return {
        source: "legacy" as const,
        rawCount: refresh.page.session.length,
        cachedRawCount: refresh.page.session.length,
        page: refresh.page,
        mergeCached: refresh.mergeCached,
        refreshPages: refresh.pages,
      }
    }

    if (source === "legacy" || (source === "mixed" && input.mode === "prepend")) {
      const page = await fetchLegacyMessages(input)
      return {
        source: "legacy" as const,
        rawCount: page.session.length,
        cachedRawCount: page.session.length,
        page,
      }
    }

    const page = await fetchMessages(input)
    const raw = windowRawSessionMessages(
      filterReverted(key, input.mode === "prepend" ? mergeByID(v2Messages.get(key) ?? [], page.raw) : page.raw),
      input.mode,
    )
    const adapted = adaptSessionMessages(input.sessionID, raw)
    if (adapted.messages.length > 0) {
      if (
        shouldOverlayLegacyHistory({
          mode: input.mode,
          requested: input.limit,
          adapted: adapted.messages.length,
          lookbehind: SESSION_MESSAGE_PAGE_LOOKBEHIND,
          source,
        })
      ) {
        const legacy = await fetchLegacyMessages(input)
        if (legacy.session.length > adapted.messages.length) {
          cacheV2Messages({ key, generation: input.revertGeneration, messages: raw, source: "mixed" })
          return {
            source: "mixed" as const,
            rawCount: legacy.session.length + page.raw.length,
            cachedRawCount: legacy.session.length + raw.length,
            page: mergeAdaptedMessagePages(legacy, {
              cursor: page.cursor,
              complete: page.complete,
              session: adapted.messages,
              part: adapted.parts,
            }),
          }
        }
      }

      cacheV2Messages({ key, generation: input.revertGeneration, messages: raw, source: "v2" })
      return {
        source: "v2" as const,
        rawCount: page.raw.length,
        cachedRawCount: raw.length,
        page: { cursor: page.cursor, complete: page.complete, session: adapted.messages, part: adapted.parts },
      }
    }

    if (source === "v2") {
      cacheV2Messages({ key, generation: input.revertGeneration, messages: raw })
      return {
        source: "v2" as const,
        rawCount: page.raw.length,
        cachedRawCount: raw.length,
        page: { cursor: page.cursor, complete: page.complete, session: adapted.messages, part: adapted.parts },
      }
    }

    const legacy = await fetchLegacyMessages(input)
    if (legacy.session.length === 0) {
      cacheV2Messages({ key, generation: input.revertGeneration, messages: raw, source: "v2" })
      return {
        source: "v2" as const,
        rawCount: page.raw.length,
        cachedRawCount: raw.length,
        page: { cursor: page.cursor, complete: page.complete, session: adapted.messages, part: adapted.parts },
      }
    }

    if (currentRevertGeneration(key, input.revertGeneration)) {
      v2Messages.delete(key)
      messageSources.set(key, "legacy")
    }
    return {
      source: "legacy" as const,
      rawCount: legacy.session.length,
      cachedRawCount: legacy.session.length,
      page: legacy,
    }
  }

  const tracked = (directory: string, sessionID: string) => seen.get(directory)?.has(sessionID) ?? false

  const timelineHeld = (directory: string, sessionID: string) => {
    if (tracked(directory, sessionID)) return true
    return serverSync.child(directory, { bootstrap: false })[0].message[sessionID] !== undefined
  }

  const loadMessages = async (input: {
    directory: string
    client: typeof client
    setStore: Setter
    sessionID: string
    limit: number
    cursor?: string
    mode?: "replace" | "prepend"
  }): Promise<void> => {
    const key = keyFor(input.directory, input.sessionID)
    const pending = messageLoadPromises.get(key)
    const existing = messageLoads.get(key)
    if (pending && existing) {
      if (input.mode === "prepend" || existing.mode === "replace") return pending
      return pending
        .catch(() => {})
        .then(() => {
          if (disposed || !timelineHeld(input.directory, input.sessionID)) return
          return loadMessages(input)
        })
    }

    const generation = revertGeneration(key)
    const load = {
      generation,
      controller: new AbortController(),
      mode: input.mode === "prepend" ? "prepend" : "replace",
    } as const
    const started = typeof performance === "undefined" ? Date.now() : performance.now()
    messageLoads.set(key, load)
    batch(() => {
      setMeta("loading", key, true)
      setMeta("refreshing", key, input.mode !== "prepend")
    })
    const [initialStore] = serverSync.child(input.directory, { bootstrap: false })
    const promise = loadMessagePage({
      ...input,
      cached: initialStore.message[input.sessionID] ?? [],
      history: { cursor: meta.cursor[key], complete: meta.complete[key] },
      revertGeneration: generation,
      signal: load.controller.signal,
    })
      .then((result) => {
        const fetched = typeof performance === "undefined" ? Date.now() : performance.now()
        if (!timelineHeld(input.directory, input.sessionID)) return
        if (!currentRevertGeneration(key, generation)) return
        const next = mergeOptimisticPage(
          filterRevertedPage(key, result.page),
          getOptimistic(input.directory, input.sessionID),
        )
        const confirmed = new Set(next.confirmed)
        for (const messageID of confirmed) {
          clearOptimistic(input.directory, input.sessionID, messageID)
        }
        const [store] = serverSync.child(input.directory, { bootstrap: false })
        const cached = filterReverted(key, store.message[input.sessionID] ?? [])
        const mergeCached =
          result.mergeCached ??
          shouldMergeCachedSessionMessages({
            mode: input.mode,
            status: store.session_status[input.sessionID]?.type,
            cached: cached.length,
            incoming: next.session.length,
          })
        const windowMode = input.mode === "prepend" || mergeCached ? "prepend" : input.mode
        const windowed = windowSessionMessages(mergeCached ? mergeByID(cached, next.session) : next.session, {
          mode: windowMode,
        })
        const keep = new Set(windowed.messages.map((message) => message.id))
        const prepared = typeof performance === "undefined" ? Date.now() : performance.now()
        batch(() => {
          if (windowed.dropped.length > 0) {
            input.setStore(
              produce((draft) => {
                dropMessageParts(draft, windowed.dropped)
              }),
            )
          }
          input.setStore("message", input.sessionID, reconcile(windowed.messages, { key: "id" }))
          for (const p of next.part) {
            if (!keep.has(p.id)) continue
            const filtered = p.part.filter((x) => !SKIP_PARTS.has(x.type))
            input.setStore(
              "part",
              p.id,
              reconcile(
                mergeFetchedMessageParts(
                  store.part[p.id],
                  filtered,
                  store.part_text_accum_delta,
                  confirmed.has(p.id),
                ),
                { key: "id" },
              ),
            )
          }
          setMeta("limit", key, windowed.messages.length)
          setMeta("cursor", key, next.cursor)
          setMeta("complete", key, next.complete)
          setSessionPrefetch({
            scope: serverSDK.scope,
            directory: input.directory,
            sessionID: input.sessionID,
            limit: windowed.messages.length,
            cursor: next.cursor,
            complete: next.complete,
          })
        })
        const committed = typeof performance === "undefined" ? Date.now() : performance.now()
        recordPerfEvent(serverSDK.server, {
          kind: "ui_session_messages_page",
          directory: input.directory,
          sessionID: input.sessionID,
          source: result.source,
          mode: input.mode ?? "replace",
          requested: input.limit,
          raw: result.rawCount,
          cachedRaw: result.cachedRawCount,
          messages: windowed.messages.length,
          dropped: windowed.dropped.length,
          refreshPages: result.refreshPages,
          fetch_ms: Math.round(fetched - started),
          prepare_ms: Math.round(prepared - fetched),
          commit_ms: Math.round(committed - prepared),
          duration_ms: Math.round(committed - started),
        })
      })
      .catch((error) => {
        if (load.controller.signal.aborted) return
        if (isSessionNotFoundError(error)) {
          const wasTracked = tracked(input.directory, input.sessionID)
          evictMissingSession(input.directory, input.setStore, input.sessionID)
          if (!wasTracked) return
        }
        throw error
      })
      .finally(() => {
        if (messageLoads.get(key) !== load) return
        messageLoads.delete(key)
        messageLoadPromises.delete(key)
        setMeta(
          produce((draft) => {
            if (!timelineHeld(input.directory, input.sessionID)) {
              delete draft.loading[key]
              delete draft.refreshing[key]
              return
            }
            draft.loading[key] = false
            draft.refreshing[key] = false
          }),
        )
      })
    messageLoadPromises.set(key, promise)
    return promise
  }

  const applyLiveProjectionAction = (action: LiveProjectionAction) => {
    if (action.kind === "handled") return
    const reverted = revertedMessages.get(keyFor(directory, action.sessionID))?.messageIDs
    if (reverted?.has(action.kind === "message" ? action.message.id : action.messageID)) return
    if (action.kind === "message") {
      const [store, setStore] = serverSync.child(directory, { bootstrap: false })
      const messages = store.message[action.sessionID]
      batch(() => {
        if (!messages) {
          setStore("message", action.sessionID, [action.message])
        } else {
          const result = Binary.search(messages, action.message.id, (message) => message.id)
          if (result.found) {
            setStore("message", action.sessionID, result.index, reconcile(action.message))
          } else {
            setStore(
              "message",
              action.sessionID,
              produce((draft) => {
                draft.splice(result.index, 0, action.message)
              }),
            )
          }
        }
        if (action.parts?.length) {
          setStore(
            "part",
            action.message.id,
            reconcile(
              mergePartsPreservingText(store.part[action.message.id] ?? [], action.parts, store.part_text_accum_delta),
              { key: "id" },
            ),
          )
        }
      })
      return
    }

    const [store, setStore] = serverSync.child(directory, { bootstrap: false })
    const parts = store.part[action.messageID]
    if (!parts) {
      setStore("part", action.messageID, [action.part])
      return
    }
    const result = Binary.search(parts, action.part.id, (part) => part.id)
    if (result.found) {
      setStore("part", action.messageID, result.index, reconcile(action.part))
      return
    }
    setStore(
      "part",
      action.messageID,
      produce((draft) => {
        draft.splice(result.index, 0, action.part)
      }),
    )
  }

  const applyV2DeltaAction = (action: ReturnType<typeof v2Deltas.materialize>[number]) => {
    if (revertedMessages.get(keyFor(directory, action.sessionID))?.messageIDs.has(action.messageID)) return
    const [, setStore] = serverSync.child(directory, { bootstrap: false })
    batch(() => {
      setStore("part", action.messageID, action.index, reconcile(action.part))
      if (typeof action.accumulatedText === "string") {
        setStore("part_text_accum_delta", action.partID, action.accumulatedText)
      }
    })
  }

  let disposed = false
  const refreshSyncedSession = (sessionID: string) => {
    if (!timelineHeld(directory, sessionID)) return
    const existing = syncRefreshes.get(sessionID)
    if (existing) {
      existing.dirty = true
      return
    }

    const state = { dirty: true, promise: Promise.resolve() }
    state.promise = (async () => {
      do {
        await new Promise((resolve) => setTimeout(resolve, 250))
        state.dirty = false
        if (disposed || !timelineHeld(directory, sessionID)) return
        const key = keyFor(directory, sessionID)
        if (meta.loading[key]) {
          state.dirty = true
          continue
        }
        const [, setStore] = serverSync.child(directory, { bootstrap: false })
        await loadMessages({
          directory,
          client,
          setStore,
          sessionID,
          limit: nextSessionMessageLimit({
            limit: meta.limit[key],
            minLimit: initialMessagePageSize,
            maxLimit: SESSION_MESSAGE_WINDOW_LIMIT,
          }),
        })
        const [refreshed] = serverSync.child(directory, { bootstrap: false })
        for (const action of v2Deltas.materialize(sessionID, refreshed)) applyV2DeltaAction(action)
        if (meta.loading[key]) state.dirty = true
      } while (state.dirty)
      const reconciled = v2Deltas.reconciled(sessionID)
      if (reconciled.length > 0) {
        serverSync.child(directory, { bootstrap: false })[1](
          produce((draft) => {
            for (const partID of reconciled) delete draft.part_text_accum_delta[partID]
          }),
        )
      }
    })().finally(() => {
      if (syncRefreshes.get(sessionID) === state) syncRefreshes.delete(sessionID)
    })
    syncRefreshes.set(sessionID, state)
    void state.promise.catch(() => {})
  }

  const handleV2SessionEvent = (event: V2SessionStreamEvent) => {
    if (
      !event.data ||
      typeof event.data !== "object" ||
      !("sessionID" in event.data) ||
      typeof event.data.sessionID !== "string" ||
      !timelineHeld(directory, event.data.sessionID)
    )
      return false
    const [store] = serverSync.child(directory, { bootstrap: false })
    const projection = liveProjection.handle(event, store)
    const projectedToolInput =
      matchesProjectedToolInputBoundary(event, projection, store, "prefix") &&
      projection?.kind === "part" &&
      !revertedMessages.get(keyFor(directory, projection.sessionID))?.messageIDs.has(projection.messageID)
    if (projection) applyLiveProjectionAction(projection)
    const action = v2Deltas.handle(event, store)
    if (action?.kind === "delta" && action.applied) applyV2DeltaAction(action)
    if (action?.refresh) {
      const key = keyFor(directory, action.sessionID)
      const canSkip = projectedToolInput && !syncRefreshes.has(action.sessionID) && !messageLoads.has(key)
      if (canSkip) v2Deltas.discardBoundary(event)
      if (!canSkip) refreshSyncedSession(action.sessionID)
    }
    return projection !== undefined || action !== undefined
  }

  const clearRevertedMessages = (cleanup: { sessionID: string; messageIDs: string[] } | undefined) => {
    if (!cleanup || !tracked(directory, cleanup.sessionID)) return
    const [, setStore] = serverSync.child(directory, { bootstrap: false })
    const removed = new Set(cleanup.messageIDs)
    const key = keyFor(directory, cleanup.sessionID)
    const previous = revertedMessages.get(key)
    const generation = (previous?.generation ?? 0) + 1
    revertedMessages.set(key, {
      generation,
      messageIDs: new Set([...(previous?.messageIDs ?? []), ...cleanup.messageIDs]),
    })
    if ((messageLoads.get(key)?.generation ?? generation) < generation) releaseMessageLoad(key)
    clearOptimisticMessages(optimistic, key, cleanup.messageIDs)
    clearRevertedV2MessageCache(v2Messages, key, cleanup.messageIDs)
    setStore(
      produce((draft) => {
        const messages = draft.message[cleanup.sessionID]
        if (messages) draft.message[cleanup.sessionID] = messages.filter((message) => !removed.has(message.id))
        dropMessageParts(draft, cleanup.messageIDs)
      }),
    )
  }

  // Mirror server-held queue inputs so the composer can show a waiting count:
  // admitted delivery="queue" adds, promoted removes, and a revert discards the
  // session's pending inputs (the projector drops them there).
  const applyQueuedInputLifecycle = (type: unknown, data: unknown) => {
    if (type === "session.next.prompt.admitted") {
      const payload = data as { sessionID?: string; messageID?: string; delivery?: string }
      if (payload?.sessionID && payload?.messageID && payload.delivery === "queue")
        recordQueuedInput(directory, payload.sessionID, payload.messageID)
      return
    }
    if (type === "session.next.prompt.promoted") {
      const payload = data as { sessionID?: string; messageID?: string }
      if (payload?.sessionID && payload?.messageID) resolveQueuedInput(directory, payload.sessionID, payload.messageID)
      return
    }
    if (type === "session.next.revert.marked") {
      const payload = data as { sessionID?: string }
      if (payload?.sessionID) clearSessionQueuedInputs(directory, payload.sessionID)
    }
  }

  const applyLifecycle = (
    lifecycle: ReturnType<typeof syncedSessionLifecycleStatus> | ReturnType<typeof streamedSessionLifecycleStatus>,
  ) => {
    if (!lifecycle) return
    // Lifecycle state is directory-wide, not message-window state. Inactive tabs might not
    // be tracked by this context, but still need terminal events to clear their spinner.
    if (
      lifecycle.status.type === "busy" &&
      !startSessionActivity(directory, lifecycle.sessionID, lifecycle.activityID, lifecycle.evidence)
    ) {
      return
    }
    if (
      lifecycle.status.type === "idle" &&
      !finishSessionActivity(directory, lifecycle.sessionID, lifecycle.activityID, lifecycle.evidence)
    ) {
      return
    }
    serverSync.child(directory, { bootstrap: false })[1]("session_status", lifecycle.sessionID, lifecycle.status)
  }

  const unsubscribeSync = serverSDK.sync.on(directory, (event) => {
    if (!crossStreamEvents.accept(event.syncEvent.id)) return
    applyLifecycle(syncedSessionLifecycleStatus(event))
    applyQueuedInputLifecycle(event.syncEvent.type, event.syncEvent.data)
    clearRevertedMessages(syncedSessionRevertCleanup(event))
    if (
      handleV2SessionEvent({
        id: event.syncEvent.id,
        type: event.syncEvent.type,
        data: event.syncEvent.data,
      })
    )
      return
    const sessionID = syncedSessionMessageID(event)
    if (sessionID) refreshSyncedSession(sessionID)
  })
  const unsubscribeEvent = serverSDK.event.on(directory, (event) => {
    if (!crossStreamEvents.accept("id" in event && typeof event.id === "string" ? event.id : undefined)) return
    applyLifecycle(streamedSessionLifecycleStatus(event))
    applyQueuedInputLifecycle(event.type, event.properties)
    clearRevertedMessages(streamedSessionRevertCleanup(event))
    if (
      handleV2SessionEvent({
        id: "id" in event && typeof event.id === "string" ? event.id : undefined,
        type: event.type,
        data: event.properties,
      })
    )
      return
    const sessionID = streamedSessionMessageID(event)
    if (sessionID) refreshSyncedSession(sessionID)
  })
  onCleanup(() => {
    disposed = true
    unsubscribeSync()
    unsubscribeEvent()
    for (const load of messageLoads.values()) load.controller.abort()
    for (const controller of inflightMetadata.values()) controller.abort()
    inflightMetadata.clear()
    messageLoads.clear()
    messageLoadPromises.clear()
    forceRefreshes.clear()
    syncRefreshes.clear()
    v2Deltas.clear()
    liveProjection.clear()
    crossStreamEvents.clear()
    revertedMessages.clear()
  })

  const loadSessionInfo = async (input: { directory: string; setStore: Setter; sessionID: string }) =>
    runInflight(inflightInfo, keyFor(input.directory, input.sessionID), () => {
      const key = keyFor(input.directory, input.sessionID)
      // Controller-Erzeugung im tatsächlich gestarteten Task: Concurrent
      // info/sync coalescen auf derselben Promise, ohne einen unbenutzten
      // zweiten Controller zu registrieren. Dispose abortiert damit genau den
      // echten Signalgeber.
      const controller = new AbortController()
      inflightMetadata.set(key, controller)
      return withSessionMessageRequestTimeout({
        signal: controller.signal,
        timeoutMs: SESSION_METADATA_REQUEST_TIMEOUT_MS,
        retries: SESSION_METADATA_REQUEST_RETRIES,
        task: (signal) =>
          retry(
            () =>
              client.session.get(
                { sessionID: input.sessionID },
                // Hey-API Options carry RequestInit signal through to fetch.
                { signal },
              ),
            { attempts: 1 },
          ),
      })
        .then((session) => {
          if (!tracked(input.directory, input.sessionID)) return
          const data = session.data
          if (!data) return
          input.setStore(
            "session",
            produce((draft) => mergeSessionList(draft, data)),
          )
        })
        .catch((error) => {
          if (isSessionNotFoundError(error)) {
            const wasTracked = tracked(input.directory, input.sessionID)
            evictMissingSession(input.directory, input.setStore, input.sessionID)
            if (!wasTracked) return
          }
          throw error
        })
        .finally(() => {
          if (inflightMetadata.get(key) === controller) inflightMetadata.delete(key)
        })
    })

  return {
    get data() {
      return current()[0]
    },
    get set(): Setter {
      return current()[1]
    },
    get status() {
      return current()[0].status
    },
    get ready() {
      return current()[0].status !== "loading"
    },
    get project() {
      const store = current()[0]
      const match = Binary.search(serverSync.data.project, store.project, (p) => p.id)
      if (match.found) return serverSync.data.project[match.index]
      return undefined
    },
    session: {
      get: getSession,
      retain(sessionID: string, _directory = directory) {
        serverSync.session.retain(_directory, sessionID)
      },
      release(sessionID: string, _directory = directory) {
        serverSync.session.release(_directory, sessionID)
      },
      optimistic: {
        add(input: { directory?: string; sessionID: string; message: Message; parts: Part[] }) {
          const _directory = input.directory ?? directory
          const [, setStore] = target(input.directory)
          setOptimistic(_directory, input.sessionID, { message: input.message, parts: input.parts })
          setOptimisticAdd(setStore as (...args: unknown[]) => void, input)
        },
        has(input: { directory?: string; sessionID: string; messageID: string }) {
          return optimistic.get(keyFor(input.directory ?? directory, input.sessionID))?.has(input.messageID) ?? false
        },
        remove(input: { directory?: string; sessionID: string; messageID: string }) {
          const _directory = input.directory ?? directory
          const [, setStore] = target(input.directory)
          clearOptimistic(_directory, input.sessionID, input.messageID)
          setOptimisticRemove(setStore as (...args: unknown[]) => void, input)
        },
      },
      addOptimisticMessage(input: {
        sessionID: string
        messageID: string
        parts: Part[]
        agent: string
        model: { providerID: string; modelID: string }
        variant?: string
      }) {
        const message: Message = {
          id: input.messageID,
          sessionID: input.sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: input.agent,
          model: { ...input.model, variant: input.variant },
        }
        const [, setStore] = target()
        setOptimistic(directory, input.sessionID, { message, parts: input.parts })
        setOptimisticAdd(setStore as (...args: unknown[]) => void, {
          sessionID: input.sessionID,
          message,
          parts: input.parts,
        })
      },
      async info(sessionID: string, opts?: { force?: boolean }) {
        const [store, setStore] = serverSync.child(directory)
        touch(directory, setStore, sessionID)
        if (Binary.search(store.session, sessionID, (s) => s.id).found && !opts?.force) return
        return loadSessionInfo({ directory, setStore, sessionID })
      },
      async sync(sessionID: string, opts?: { force?: boolean; resetMessages?: boolean }) {
        const [store, setStore] = serverSync.child(directory)
        const key = keyFor(directory, sessionID)

        if (opts?.resetMessages && store.message[sessionID] !== undefined) {
          releaseSessionTimeline(directory, store, setStore, sessionID)
        }
        touch(directory, setStore, sessionID)
        if (store.message[sessionID] === undefined) setStore("message", sessionID, [])

        const seeded = getSessionPrefetch(serverSDK.scope, directory, sessionID)
        if (
          canUseSessionPrefetch({
            messageCount: store.message[sessionID]?.length ?? 0,
            info: seeded,
            minLimit: initialMessagePageSize,
          }) &&
          meta.limit[key] === undefined
        ) {
          batch(() => {
            setMeta("limit", key, seeded!.limit)
            setMeta("cursor", key, seeded!.cursor)
            setMeta("complete", key, seeded!.complete)
            setMeta("loading", key, false)
          })
        }

        if (opts?.force) {
          const existingForce = forceRefreshes.get(key)
          if (existingForce) return existingForce
          const before = getSessionPrefetch(serverSDK.scope, directory, sessionID)
          const mode = messageLoads.get(key)?.mode
          while (inflight.has(key)) await inflight.get(key)?.catch(() => {})
          if (disposed || !timelineHeld(directory, sessionID)) return
          const existingAfterWait = forceRefreshes.get(key)
          if (existingAfterWait) return existingAfterWait
          if (
            shouldSkipForcedSessionRefresh({
              mode,
              before,
              after: getSessionPrefetch(serverSDK.scope, directory, sessionID),
            })
          )
            return
        }

        const promise = runInflight(inflight, key, async () => {
          // Passive prefetch requests are deliberately larger than foreground pages. Do not
          // make an opened tab wait on one: a slow historical read otherwise leaves the
          // session visibly frozen even though a normal initial page could be loaded now.
          if (getSessionPrefetchPromise(serverSDK.scope, directory, sessionID)) {
            cancelSessionPrefetch(serverSDK.scope, directory, sessionID)
          }

          const hasSession = Binary.search(store.session, sessionID, (s) => s.id).found
          const statusGeneration = sessionActivityGeneration(directory, sessionID)
          const statusReq = shouldRefreshSessionStatus(store.session_status[sessionID]?.type)
            ? client.session.status().then((response) => {
                if (sessionActivityGeneration(directory, sessionID) !== statusGeneration) return
                const incoming = response.data?.[sessionID]
                if (incoming && incoming.type !== "idle" && sessionActivitySettled(directory, sessionID)) {
                  updateSessionActivity(directory, sessionID, incoming)
                }
                if (
                  (incoming?.type ?? "idle") === "idle" &&
                  sessionActivityDismissed(directory, sessionID) &&
                  sessionActivity(directory, sessionID)
                ) {
                  finishSessionActivity(directory, sessionID)
                }
                setStore(
                  "session_status",
                  sessionID,
                  hydratedSessionStatus({
                    current: store.session_status[sessionID],
                    incoming,
                    liveBusy: sessionActivity(directory, sessionID)?.type === "busy",
                    liveSettled: sessionActivitySettled(directory, sessionID),
                  }),
                )
              })
            : Promise.resolve()
          const cached = shouldUseCachedSessionMessages({
            messageLoaded: store.message[sessionID] !== undefined,
            limit: meta.limit[key],
            complete: meta.complete[key],
            minLimit: initialMessagePageSize,
          })
          const cachedIdle = shouldServeCachedSessionMessages({
            cached,
            status: store.session_status[sessionID]?.type,
            activity: sessionActivity(directory, sessionID)?.type,
          })
          if (cachedIdle && hasSession && !opts?.force) return

          const limit = nextSessionMessageLimit({
            limit: meta.limit[key],
            minLimit: initialMessagePageSize,
            maxLimit: SESSION_MESSAGE_WINDOW_LIMIT,
          })
          const sessionReq =
            hasSession && !opts?.force ? Promise.resolve() : loadSessionInfo({ directory, setStore, sessionID })

          const messagesReq =
            cachedIdle && !opts?.force
              ? Promise.resolve()
              : loadMessages({
                  directory,
                  client,
                  setStore,
                  sessionID,
                  limit,
                })
          void statusReq.catch(() => {})
          await Promise.all([sessionReq, messagesReq])
        })
        if (!opts?.force) return promise
        forceRefreshes.set(key, promise)
        void promise
          .finally(() => {
            if (forceRefreshes.get(key) === promise) forceRefreshes.delete(key)
          })
          .catch(() => {})
        return promise
      },
      async diff(sessionID: string, opts?: { force?: boolean }) {
        const [store, setStore] = serverSync.child(directory)
        touch(directory, setStore, sessionID)
        if (store.session_diff[sessionID] !== undefined && !opts?.force) return

        const key = keyFor(directory, sessionID)
        return runInflight(inflightDiff, key, () =>
          retry(() => client.session.diff({ sessionID }))
            .then((diff) => {
              if (!tracked(directory, sessionID)) return
              setStore("session_diff", sessionID, reconcile(list(diff.data), { key: "file" }))
            })
            .catch((error) => {
              if (isSessionNotFoundError(error)) {
                evictMissingSession(directory, setStore, sessionID)
                return
              }
              throw error
            }),
        )
      },
      async todo(sessionID: string, opts?: { force?: boolean }) {
        const [store, setStore] = serverSync.child(directory)
        touch(directory, setStore, sessionID)
        const existing = store.todo[sessionID]
        const cached = serverSync.todo.get(directory, sessionID)
        if (existing !== undefined) {
          if (cached === undefined) {
            serverSync.todo.set(directory, sessionID, existing)
          }
          if (!opts?.force) return
        }

        if (cached !== undefined) {
          setStore("todo", sessionID, reconcile(cached, { merge: false }))
        }

        const key = keyFor(directory, sessionID)
        return runInflight(inflightTodo, key, () =>
          retry(() => client.session.todo({ sessionID }))
            .then((todo) => {
              if (!tracked(directory, sessionID)) return
              const list = todo.data ?? []
              setStore("todo", sessionID, reconcile(list, { merge: false }))
              serverSync.todo.set(directory, sessionID, list)
            })
            .catch((error) => {
              if (isSessionNotFoundError(error)) {
                evictMissingSession(directory, setStore, sessionID)
                return
              }
              throw error
            }),
        )
      },
      history: {
        more(sessionID: string) {
          const store = current()[0]
          const key = keyFor(directory, sessionID)
          if (store.message[sessionID] === undefined) return false
          if (meta.limit[key] === undefined) return false
          if (meta.complete[key]) return false
          return !!meta.cursor[key]
        },
        loading(sessionID: string) {
          const key = keyFor(directory, sessionID)
          return meta.loading[key] ?? false
        },
        refreshing(sessionID: string) {
          const key = keyFor(directory, sessionID)
          return meta.refreshing[key] ?? false
        },
        async loadMore(sessionID: string, count?: number) {
          const [, setStore] = serverSync.child(directory)
          touch(directory, setStore, sessionID)
          const key = keyFor(directory, sessionID)
          const step = count ?? historyMessagePageSize
          if (meta.loading[key]) return
          if (meta.complete[key]) return
          const cursor = meta.cursor[key]
          if (!cursor) return

          await loadMessages({
            directory,
            client,
            setStore,
            sessionID,
            limit: step,
            cursor,
            mode: "prepend",
          })
        },
      },
      evict(sessionID: string, _directory = directory) {
        const [, setStore] = serverSync.child(_directory)
        seenFor(_directory).delete(sessionID)
        evict(_directory, setStore, [sessionID])
      },
      releaseTimeline(sessionID: string, _directory = directory) {
        const existing = serverSync.existing(_directory)
        if (!existing || existing[0].message[sessionID] === undefined) return
        releaseSessionTimeline(_directory, existing[0], existing[1], sessionID)
      },
      fetch: async (count = 10) => {
        const [store, setStore] = serverSync.child(directory)
        setStore("limit", (x) => x + count)
        await client.session.list().then((x) => {
          const sessions = (x.data ?? [])
            .filter((s) => !!s?.id)
            .sort((a, b) => cmp(a.id, b.id))
            .slice(0, store.limit)
          setStore(
            "session",
            produce((draft) => replaceSessionList(draft, sessions)),
          )
        })
      },
      more: createMemo(() => current()[0].session.length >= current()[0].limit),
      archive: async (sessionID: string) => {
        const [, setStore] = serverSync.child(directory)
        await client.session.update({ sessionID, time: { archived: Date.now() } })
        setStore(
          produce((draft) => {
            const match = Binary.search(draft.session, sessionID, (s) => s.id)
            if (match.found) draft.session.splice(match.index, 1)
          }),
        )
      },
    },
    mcp: {
      load: () => serverSync.child(directory, { bootstrap: false, mcp: true }),
      toggle: (name: string) => serverSync.mcp.toggle(directory, name),
    },
    absolute,
    get directory() {
      return current()[0].path.directory
    },
  }
}
