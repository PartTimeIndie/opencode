import { applyResult, markSeen, type AttentionEntry, type AttentionSnapshot } from "./state"

export type AttentionCommand =
  | { type: "enable"; key: string; directory: string; snapshot: AttentionSnapshot }
  | { type: "disable"; key: string }
  | { type: "refresh"; key: string; afterSeq: number; snapshot: AttentionSnapshot }
  | { type: "ack"; key: string; cursor: number }
  | { type: "claim"; key: string; cursor: number }
  | { type: "claim-question"; key: string; requestID: string }

export type AttentionResult = { entry?: AttentionEntry; changed: boolean; notify: boolean; stale: boolean }

/** All commands are applied by one synchronous desktop main-process writer. */
export function reduceAttention(entries: Record<string, AttentionEntry>, command: AttentionCommand): AttentionResult {
  const prior = entries[command.key]
  if (command.type === "enable") {
    if (prior?.enabled) return { entry: prior, changed: false, notify: false, stale: false }
    if (command.snapshot.archived) return { entry: prior, changed: false, notify: false, stale: false }
    const entry: AttentionEntry = {
      enabled: true, directory: command.directory, cursor: command.snapshot.cursor, seen: command.snapshot.cursor,
      count: 0, error: false, title: command.snapshot.title, working: command.snapshot.working,
    }
    entries[command.key] = entry
    return { entry, changed: true, notify: false, stale: false }
  }
  if (!prior) return { changed: false, notify: false, stale: false }
  if (command.type === "disable") {
    if (!prior.enabled) return { entry: prior, changed: false, notify: false, stale: false }
    const entry = { ...prior, enabled: false, count: 0, error: false }
    entries[command.key] = entry
    return { entry, changed: true, notify: false, stale: false }
  }
  if (!prior.enabled) return { entry: prior, changed: false, notify: false, stale: false }
  if (command.type === "claim-question") {
    const claimed = Array.isArray(prior.questionNotified) ? prior.questionNotified : []
    if (claimed.includes(command.requestID)) return { entry: prior, changed: false, notify: false, stale: false }
    const entry = { ...prior, questionNotified: [...claimed, command.requestID].slice(-256) }
    entries[command.key] = entry
    return { entry, changed: true, notify: true, stale: false }
  }
  if (command.type === "refresh") {
    if (command.afterSeq !== prior.cursor) return { entry: prior, changed: false, notify: false, stale: true }
    if (command.snapshot.archived) {
      if (prior.archived) return { entry: prior, changed: false, notify: false, stale: false }
      const entry = { ...prior, archived: true, count: 0, error: false, working: false }
      entries[command.key] = entry
      return { entry, changed: true, notify: false, stale: false }
    }
    const entry = applyResult(prior, command.snapshot)
    if (entry === prior) return { entry, changed: false, notify: false, stale: false }
    entries[command.key] = entry
    return { entry, changed: true, notify: command.snapshot.count > 0, stale: false }
  }
  if (command.type === "ack") {
    const entry = markSeen(prior, command.cursor)
    if (entry === prior) return { entry, changed: false, notify: false, stale: false }
    entries[command.key] = entry
    return { entry, changed: true, notify: false, stale: false }
  }
  if (prior.count === 0 || prior.seen >= command.cursor || prior.cursor < command.cursor ||
    (prior.notified ?? 0) >= command.cursor)
    return { entry: prior, changed: false, notify: false, stale: false }
  const entry = { ...prior, notified: command.cursor }
  entries[command.key] = entry
  return { entry, changed: true, notify: true, stale: false }
}
