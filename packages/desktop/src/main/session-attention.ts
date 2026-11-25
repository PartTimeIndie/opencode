import { reduceAttention, type AttentionCommand } from "@opencode-ai/app/session-attention/broker"
import { isAttentionSnapshot, type AttentionEntry } from "@opencode-ai/app/session-attention/state"

const STORE = "opencode.session-attention"
const KEY = "entries"
const nonNegativeInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0

export function attentionBroker(storage: {
  get(name: string, key: string): unknown
  set(name: string, key: string, value: Record<string, AttentionEntry>): void
}, isVisible: (key: string) => boolean = () => false) {
  const list = () => {
    const value = storage.get(STORE, KEY)
    if (!value || typeof value !== "object" || Array.isArray(value)) return {} as Record<string, AttentionEntry>
    return value as Record<string, AttentionEntry>
  }
  const update = (command: AttentionCommand) => {
    if (!command || typeof command.key !== "string" || !command.key || command.key.length > 4096 ||
      !["enable", "disable", "refresh", "ack", "claim", "claim-question"].includes(command.type))
      throw new Error("Invalid attention command")
    if (command.type === "claim-question" &&
      (typeof command.requestID !== "string" || !command.requestID || command.requestID.length > 256))
      throw new Error("Invalid attention question ID")
    if (command.type === "ack" || command.type === "claim") {
      if (!nonNegativeInteger(command.cursor)) throw new Error("Invalid attention cursor")
    }
    if (command.type === "enable" || command.type === "refresh") {
      const snapshot = command.snapshot
      if (!isAttentionSnapshot(snapshot) || snapshot.title.length > 512)
        throw new Error("Invalid attention snapshot")
      if (command.type === "enable" && (typeof command.directory !== "string" || !command.directory || command.directory.length > 4096))
        throw new Error("Invalid attention directory")
      if (command.type === "refresh" && !nonNegativeInteger(command.afterSeq)) throw new Error("Invalid attention cursor")
    }
    const entries = list()
    if ((command.type === "claim" || command.type === "claim-question") && isVisible(command.key))
      return { entry: entries[command.key], changed: false, notify: false, stale: false }
    const revision = entries[command.key]?.revision ?? 0
    const result = reduceAttention(entries, command)
    if (result.changed && result.entry) {
      result.entry.revision = revision + 1
      storage.set(STORE, KEY, entries)
    }
    return result
  }
  return { list, update }
}
