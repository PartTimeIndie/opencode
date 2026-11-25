import { describe, expect, test } from "bun:test"
import {
  buildGoalControlRequest,
  goalControlErrorText,
  goalControlResponseStale,
  parseGoalControlResponse,
} from "./session-goal-control"

describe("session goal control request", () => {
  test("binds session, run and revision from the current UI state", () => {
    const request = buildGoalControlRequest({
      sessionID: "ses_1",
      action: "pause",
      goalRunMetadata: "run-1",
      status: { phase: "working", stopped: false, stopReason: "", controlRevision: 5 },
    })
    expect(request.sessionID).toBe("ses_1")
    expect(request.action).toBe("pause")
    expect(request.runID).toBe("run-1")
    expect(request.expectedRevision).toBe(5)
    expect(typeof request.operationID).toBe("string")
    expect(request.operationID.length).toBeGreaterThan(0)
  })

  test("omits optional guards when the projection has no run or revision", () => {
    const request = buildGoalControlRequest({ sessionID: "ses_1", action: "resume" })
    expect(request.runID).toBeUndefined()
    expect(request.expectedRevision).toBeUndefined()
    expect(buildGoalControlRequest({
      sessionID: "ses_1",
      action: "pause",
      goalRunMetadata: "",
      status: { phase: "working", stopped: false, stopReason: "" },
    }).runID).toBeUndefined()
  })

  test("each request carries a fresh unique operation id", () => {
    const first = buildGoalControlRequest({ sessionID: "ses_1", action: "pause" })
    const second = buildGoalControlRequest({ sessionID: "ses_1", action: "resume" })
    expect(first.operationID).not.toBe(second.operationID)
  })
})

describe("goal control response ordering", () => {
  test("accepts an ack for the same run at or above the observed revision", () => {
    const request = buildGoalControlRequest({
      sessionID: "ses_1",
      action: "pause",
      goalRunMetadata: "run-1",
      status: { phase: "working", stopped: false, stopReason: "", controlRevision: 5 },
    })
    expect(goalControlResponseStale(request, { ok: true, runID: "run-1", controlRevision: 5 })).toBe(false)
    expect(goalControlResponseStale(request, { ok: true, runID: "run-1", controlRevision: 6 })).toBe(false)
  })

  test("rejects a delayed response from an older revision or replaced run", () => {
    const request = buildGoalControlRequest({
      sessionID: "ses_1",
      action: "pause",
      goalRunMetadata: "run-2",
      status: { phase: "working", stopped: false, stopReason: "", controlRevision: 6 },
    })
    expect(goalControlResponseStale(request, { ok: true, runID: "run-2", controlRevision: 5 })).toBe(true)
    expect(goalControlResponseStale(request, { ok: true, runID: "run-1", controlRevision: 9 })).toBe(true)
  })

  test("a response without version evidence is not treated as stale", () => {
    const request = buildGoalControlRequest({
      sessionID: "ses_1",
      action: "pause",
      goalRunMetadata: "run-1",
      status: { phase: "working", stopped: false, stopReason: "", controlRevision: 5 },
    })
    expect(goalControlResponseStale(request, { ok: true })).toBe(false)
    expect(goalControlResponseStale(request, {})).toBe(false)
  })
})

describe("goal control response envelope", () => {
  test("unwraps the plugin outcome from the endpoint envelope exactly once", () => {
    expect(parseGoalControlResponse({ ok: true, data: { ok: true, runID: "run-1", controlRevision: 7 } })).toEqual({
      ok: true,
      runID: "run-1",
      controlRevision: 7,
    })
    expect(
      parseGoalControlResponse({ ok: true, data: { ok: false, error: "revision", runID: "run-1", controlRevision: 3 } }),
    ).toEqual({ ok: false, error: "revision", runID: "run-1", controlRevision: 3 })
  })

  test("a body without a plugin outcome yields no result", () => {
    expect(parseGoalControlResponse(undefined)).toBeUndefined()
    expect(parseGoalControlResponse({ ok: true })).toBeUndefined()
    expect(parseGoalControlResponse({ ok: true, data: "garbage" })).toBeUndefined()
    expect(parseGoalControlResponse({ ok: true, data: [1, 2] })).toBeUndefined()
  })

  test("plugin rejection codes map to readable text", () => {
    expect(goalControlErrorText("stale-run")).toBe("This control belongs to an earlier version of the goal.")
    expect(goalControlErrorText("revision")).toBe("The goal changed since this control was pressed.")
    expect(goalControlErrorText("no-goal")).toBe("The goal is no longer active.")
    expect(goalControlErrorText(undefined)).toBe("The session goal control failed.")
  })
})
