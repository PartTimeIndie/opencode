export type AttentionEntry = {
  enabled: boolean
  revision?: number
  cursor: number
  seen: number
  notified?: number
  questionNotified?: string[]
  count: number
  error: boolean
  title: string
  directory?: string
  working?: boolean
  archived?: boolean
  outcome?: "completed" | "failed"
}

export type AttentionSnapshot = {
  cursor: number
  count: number
  lastFailureSeq?: number
  last?: { id: string; status: string; closedSeq: number }
  title: string
  working: boolean
  archived?: boolean
}

export function isAttentionSnapshot(value: unknown): value is AttentionSnapshot {
  if (!value || typeof value !== "object") return false
  const input = value as Record<string, unknown>
  const seq = (item: unknown) => Number.isSafeInteger(item) && (item as number) >= 0
  if (!seq(input.cursor) || !seq(input.count) || typeof input.title !== "string" ||
    typeof input.working !== "boolean" || (input.archived !== undefined && typeof input.archived !== "boolean") ||
    (input.lastFailureSeq !== undefined && !seq(input.lastFailureSeq))) return false
  if (input.last === undefined) return true
  if (!input.last || typeof input.last !== "object") return false
  const last = input.last as Record<string, unknown>
  return typeof last.id === "string" && (last.status === "completed" || last.status === "failed") && seq(last.closedSeq)
}

/** A cursor identifies the observed boundary, not a claim that a task was successful. */
export function applyResult(entry: AttentionEntry, snapshot: AttentionSnapshot): AttentionEntry {
  if (!entry.enabled || snapshot.cursor < entry.cursor || (snapshot.cursor === entry.cursor && !entry.archived)) return entry
  return {
    ...entry, cursor: snapshot.cursor, title: snapshot.title, working: snapshot.working, archived: false,
    count: entry.count + snapshot.count,
    error: entry.error || snapshot.lastFailureSeq !== undefined,
    outcome: snapshot.last?.status === "failed" ? "failed" : snapshot.last?.status === "completed" ? "completed" : entry.outcome,
  }
}

export function markSeen(entry: AttentionEntry, cursor: number): AttentionEntry {
  if (cursor < entry.cursor || entry.count === 0) return entry
  return { ...entry, seen: entry.cursor, count: 0, error: false }
}
