import { expect, test } from "bun:test"
import { attentionBroker } from "./session-attention"
import type { AttentionEntry } from "@opencode-ai/app/session-attention/state"

const snapshot = (cursor: number, count: number, failed = false) => ({
  title: "Build", working: false, cursor, count,
  last: { id: `activity-${cursor}`, status: failed ? "failed" : "completed", closedSeq: cursor },
  lastFailureSeq: failed ? cursor : undefined,
})

test("desktop writer serializes windows, acknowledgements and one OS-notification claim", () => {
  let saved: Record<string, AttentionEntry> = {}
  const store = { get: () => structuredClone(saved), set: (_: string, __: string, value: Record<string, AttentionEntry>) => { saved = structuredClone(value) } }
  const first = attentionBroker(store)
  const second = attentionBroker(store)
  const key = "server\nproject\nsession"
  expect(first.update({ type: "enable", key, directory: "project", snapshot: snapshot(2, 1) }).entry).toMatchObject({ count: 0, cursor: 2 })
  expect(second.update({ type: "refresh", key, afterSeq: 2, snapshot: snapshot(4, 1, true) }).notify).toBe(true)
  expect(first.update({ type: "refresh", key, afterSeq: 2, snapshot: snapshot(4, 1, true) }).stale).toBe(true)
  expect(first.update({ type: "claim", key, cursor: 4 }).notify).toBe(true)
  expect(second.update({ type: "claim", key, cursor: 4 }).notify).toBe(false)
  expect(second.update({ type: "ack", key, cursor: 3 }).changed).toBe(false)
  expect(first.update({ type: "ack", key, cursor: 4 }).entry).toMatchObject({ enabled: true, count: 0, seen: 4 })
  expect(second.update({ type: "refresh", key, afterSeq: 4, snapshot: snapshot(6, 1) }).entry).toMatchObject({ count: 1, error: false })
  expect(first.update({ type: "disable", key }).entry?.enabled).toBe(false)
  expect(second.update({ type: "refresh", key, afterSeq: 6, snapshot: snapshot(7, 1) }).changed).toBe(false)
  expect(first.list()[key]?.enabled).toBe(false)
})

test("a different focused window showing the same session blocks the toast claim", () => {
  let saved: Record<string, AttentionEntry> = {}
  const key = "server\nproject\nsession"
  const storage = { get: () => structuredClone(saved), set: (_: string, __: string, value: Record<string, AttentionEntry>) => { saved = structuredClone(value) } }
  let focused = key
  const broker = attentionBroker(storage, (target) => target === focused)
  broker.update({ type: "enable", key, directory: "project", snapshot: snapshot(0, 0) })
  broker.update({ type: "refresh", key, afterSeq: 0, snapshot: snapshot(1, 1) })
  expect(broker.update({ type: "claim", key, cursor: 1 }).notify).toBe(false)
  expect(broker.list()[key]?.notified).toBeUndefined()
  focused = ""
  expect(broker.update({ type: "claim", key, cursor: 1 }).notify).toBe(true)
  focused = key
  expect(broker.update({ type: "claim-question", key, requestID: "question-1" }).notify).toBe(false)
  expect(broker.list()[key]?.questionNotified).toBeUndefined()
  focused = ""
  expect(broker.update({ type: "claim-question", key, requestID: "question-1" }).notify).toBe(true)
  expect(broker.update({ type: "claim-question", key, requestID: "question-1" }).notify).toBe(false)
  expect(broker.list()[key]).toMatchObject({ enabled: true, count: 1, questionNotified: ["question-1"] })
  expect(broker.update({ type: "claim-question", key, requestID: "question-2" }).notify).toBe(true)
  expect(broker.update({ type: "claim-question", key, requestID: "question-1" }).notify).toBe(false)
})

test("desktop writer rejects malformed IPC data without changing persisted state", () => {
  let writes = 0
  const broker = attentionBroker({ get: () => ({}), set: () => { writes++ } })
  const key = "server\nproject\nsession"
  expect(() => broker.update({ type: "enable", key, directory: "project", snapshot: { ...snapshot(1, 0), cursor: NaN } })).toThrow()
  expect(() => broker.update({ type: "enable", key, directory: "project", snapshot: { ...snapshot(1, 0), title: "x".repeat(513) } })).toThrow()
  expect(() => broker.update({ type: "ack", key, cursor: -1 })).toThrow()
  expect(() => broker.update({ type: "refresh", key, afterSeq: 0, snapshot: { ...snapshot(1, 0), count: -2 } })).toThrow()
  expect(() => broker.update({ type: "refresh", key, afterSeq: 0, snapshot: {
    ...snapshot(1, 0), last: { id: "activity-1", status: "unknown", closedSeq: 1 },
  } })).toThrow()
  expect(() => broker.update({ type: "claim-question", key, requestID: "" })).toThrow()
  expect(() => broker.update({ type: "claim-question", key, requestID: "x".repeat(257) })).toThrow()
  expect(writes).toBe(0)
})

test("archiving clears stale badges but keeps the important mark", () => {
  let saved: Record<string, AttentionEntry> = {}
  const broker = attentionBroker({ get: () => structuredClone(saved), set: (_: string, __: string, value: Record<string, AttentionEntry>) => { saved = structuredClone(value) } })
  const key = "server\nproject\nsession"
  broker.update({ type: "enable", key, directory: "project", snapshot: snapshot(0, 0) })
  broker.update({ type: "refresh", key, afterSeq: 0, snapshot: snapshot(2, 1) })
  expect(broker.update({ type: "refresh", key, afterSeq: 2, snapshot: { ...snapshot(2, 0), archived: true } }).entry).toMatchObject({ enabled: true, archived: true, count: 0 })
  expect(broker.update({ type: "refresh", key, afterSeq: 2, snapshot: snapshot(3, 1) }).entry).toMatchObject({ enabled: true, archived: false, count: 1 })
})
