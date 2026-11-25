import { expect, test } from "bun:test"
import { applyResult, markSeen, isAttentionSnapshot, type AttentionEntry } from "./state"

const initial: AttentionEntry = { enabled: true, cursor: 4, seen: 4, count: 0, error: false, title: "Example" }

test("new results accumulate by session; failures survive a newer success and duplicate snapshots", () => {
  const failed = applyResult(initial, { cursor: 8, count: 1, lastFailureSeq: 8, last: { id: "a", status: "failed", closedSeq: 8 }, title: "Example", working: false })
  const completed = applyResult(failed, { cursor: 12, count: 1, last: { id: "b", status: "completed", closedSeq: 12 }, title: "Example", working: true })
  expect(completed).toMatchObject({ cursor: 12, count: 2, error: true, working: true })
  expect(applyResult(completed, { cursor: 12, count: 0, title: "Example", working: false })).toEqual(completed)
  expect(markSeen(completed, 8)).toMatchObject({ count: 2, error: true })
  expect(markSeen(completed, 12)).toMatchObject({ count: 0, error: false, seen: 12, enabled: true })
})

test("malformed HTTP summaries cannot poison the durable cursor or count", () => {
  expect(isAttentionSnapshot({ cursor: 3, count: 1, title: "S", working: false })).toBe(true)
  expect(isAttentionSnapshot({ cursor: undefined, count: 0, title: "S", working: false })).toBe(false)
  expect(isAttentionSnapshot({ cursor: 3, count: NaN, title: "S", working: false })).toBe(false)
  expect(isAttentionSnapshot({ cursor: 3, count: 0, title: "S", working: false,
    last: { id: "a", status: "unknown", closedSeq: 3 } })).toBe(false)
})

test("out-of-order snapshots never resurrect an acknowledged result", () => {
  const seen = markSeen({ ...initial, cursor: 9, count: 1, error: true }, 9)
  expect(applyResult(seen, { cursor: 8, count: 1, lastFailureSeq: 8, title: "Example", working: false })).toEqual(seen)
})
