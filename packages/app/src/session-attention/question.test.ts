import { expect, test } from "bun:test"
import { pendingAttentionQuestion } from "./question"
import { reduceAttention } from "./broker"
import type { AttentionEntry } from "./state"

test("only blocking questions for the marked session need an attention notice", () => {
  const requests = [
    { id: "interactive", sessionID: "marked", mode: "interactive" },
    { id: "foreign", sessionID: "other", mode: "blocking" },
    { id: "pending", sessionID: "marked", mode: "blocking" },
  ]
  expect(pendingAttentionQuestion(requests, "marked")).toBe("pending")
  expect(pendingAttentionQuestion(requests, "absent")).toBeUndefined()
  expect(pendingAttentionQuestion([], "marked")).toBeUndefined()
})

test("a question can claim one desktop alert across windows without consuming a result or the mark", () => {
  const key = "server\nproject\nsession"
  const initial: AttentionEntry = { enabled: true, cursor: 4, seen: 3, count: 1, error: false, title: "Example" }
  const entries = { [key]: initial }
  const claim = { type: "claim-question" as const, key, requestID: "question-1" }
  expect(reduceAttention(entries, claim).notify).toBe(true)
  expect(reduceAttention(entries, claim).notify).toBe(false)
  expect(entries[key]).toMatchObject({ enabled: true, count: 1, cursor: 4, questionNotified: ["question-1"] })
  expect(reduceAttention(entries, { ...claim, requestID: "question-2" }).notify).toBe(true)
  expect(reduceAttention(entries, claim).notify).toBe(false)
  expect(reduceAttention(entries, { type: "disable", key }).entry?.enabled).toBe(false)
  expect(reduceAttention(entries, claim).notify).toBe(false)
})
