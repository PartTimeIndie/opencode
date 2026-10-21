export * as ReadLifecycle from "./read-lifecycle"

import type { SessionMessage } from "../message"

/**
 * Deterministic stale/superseded read lifecycle for provider projections.
 *
 * Contracts:
 * - Only the mutable tail after the latest accepted user prompt is rewritten; each
 *   closed prompt segment's projection stays fixed (no rewrite-on-every-request loop).
 * - A read view is superseded only when a later read of the same canonical path proves
 *   the same content version (identical page sha256) and fully covers the older range.
 * - The latest read stays exact. Failed edits without recorded mutation change nothing
 *   here: nothing is invalidated by mutation evidence, only proven-identical rereads
 *   fold older duplicates.
 * - Fresh unique source evidence is never summarized, only exact duplicates collapse.
 */

type ReadView = {
  readonly callID: string
  readonly path: string
  readonly offset: number
  readonly sha256: string | undefined
  readonly truncated: boolean
  readonly next: number | undefined
  readonly raw: boolean
  readonly inMutableTail: boolean
  readonly index: number
}

const readViewOf = (tool: SessionMessage.AssistantTool, inMutableTail: boolean, index: number): ReadView | undefined => {
  if (tool.state.status !== "completed") return undefined
  const input = tool.state.input as Record<string, unknown>
  const path = typeof input.path === "string" ? input.path : undefined
  if (path === undefined) return undefined
  const structured = tool.state.structured as Record<string, unknown>
  if (structured?.type !== "text-page") return undefined
  const sha256 = typeof structured.sha256 === "string" ? structured.sha256 : undefined
  const offset = typeof structured.offset === "number" ? structured.offset : 1
  return {
    callID: tool.id,
    path,
    offset,
    sha256,
    truncated: structured.truncated === true,
    next: typeof structured.next === "number" ? structured.next : undefined,
    raw: input.raw === true,
    inMutableTail,
    index,
  }
}

const covers = (newer: ReadView, older: ReadView) => {
  if (newer.offset > older.offset) return false
  // a complete newer page reaches end-of-file for the same content version
  if (!newer.truncated) return true
  // otherwise the newer finite page must extend at or beyond the older finite page
  return older.truncated && newer.next !== undefined && older.next !== undefined && newer.next >= older.next
}

/** Call IDs of superseded read views mapped to the deterministic marker text. */
export const supersededReadMarkers = (messages: readonly SessionMessage.Message[]): Map<string, string> => {
  const markers = new Map<string, string>()
  let lastUserIndex = -1
  messages.forEach((message, index) => {
    if (message.type === "user") lastUserIndex = index
  })
  const reads: ReadView[] = []
  messages.forEach((message, index) => {
    if (message.type !== "assistant") return
    const inMutableTail = index > lastUserIndex
    for (const item of message.content) {
      if (item.type !== "tool" || item.name !== "read") continue
      const view = readViewOf(item, inMutableTail, index)
      if (view !== undefined && view.sha256 !== undefined && !view.raw) reads.push(view)
    }
  })
  for (const older of reads) {
    if (!older.inMutableTail) continue
    let newest: ReadView | undefined
    for (const newer of reads) {
      if (newer.index <= older.index || newer.callID === older.callID) continue
      if (newer.path !== older.path || newer.sha256 !== older.sha256) continue
      if (!covers(newer, older)) continue
      if (newest === undefined || newer.index > newest.index) newest = newer
    }
    if (newest !== undefined) {
      markers.set(
        older.callID,
        `[Superseded read of ${older.path} from line ${older.offset}: the same content version (sha256 ${older.sha256?.slice(0, 12)}…) was shown again exactly by read call ${newest.callID} from line ${newest.offset}; consult that result instead]`,
      )
    }
  }
  return markers
}
