import { describe, expect, test } from "bun:test"
import {
  clearSessionQueuedInputs,
  recordQueuedInput,
  resolveQueuedInput,
  sessionQueuedInputCount,
} from "./session-queued-inputs"

const dir = "/repo/main"
const sid = "ses_queued_test"

describe("session queued inputs", () => {
  test("counts admitted queue inputs per session, idempotently", () => {
    clearSessionQueuedInputs(dir, sid)
    recordQueuedInput(dir, sid, "msg-a")
    recordQueuedInput(dir, sid, "msg-b")
    recordQueuedInput(dir, sid, "msg-a")
    expect(sessionQueuedInputCount(dir, sid)).toBe(2)
  })

  test("promoted events resolve the count and suppress replayed admissions", () => {
    clearSessionQueuedInputs(dir, sid)
    recordQueuedInput(dir, sid, "msg-a")
    recordQueuedInput(dir, sid, "msg-b")
    resolveQueuedInput(dir, sid, "msg-a")
    expect(sessionQueuedInputCount(dir, sid)).toBe(1)
    recordQueuedInput(dir, sid, "msg-a")
    expect(sessionQueuedInputCount(dir, sid)).toBe(1)
    resolveQueuedInput(dir, sid, "msg-b")
    expect(sessionQueuedInputCount(dir, sid)).toBe(0)
  })

  test("keys stay separate across directories and sessions", () => {
    clearSessionQueuedInputs(dir, sid)
    clearSessionQueuedInputs("/repo/other", sid)
    clearSessionQueuedInputs(dir, "ses_other")
    recordQueuedInput(dir, sid, "msg-a")
    expect(sessionQueuedInputCount("/repo/other", sid)).toBe(0)
    expect(sessionQueuedInputCount(dir, "ses_other")).toBe(0)
    expect(sessionQueuedInputCount(dir, sid)).toBe(1)
  })

  test("promoted before admitted stays suppressed on the late replay", () => {
    clearSessionQueuedInputs(dir, sid)
    resolveQueuedInput(dir, sid, "msg-late")
    recordQueuedInput(dir, sid, "msg-late")
    expect(sessionQueuedInputCount(dir, sid)).toBe(0)
  })

  test("revert cleanup resets the session state", () => {
    clearSessionQueuedInputs(dir, sid)
    recordQueuedInput(dir, sid, "msg-a")
    clearSessionQueuedInputs(dir, sid)
    expect(sessionQueuedInputCount(dir, sid)).toBe(0)
    recordQueuedInput(dir, sid, "msg-a")
    expect(sessionQueuedInputCount(dir, sid)).toBe(1)
  })
})
