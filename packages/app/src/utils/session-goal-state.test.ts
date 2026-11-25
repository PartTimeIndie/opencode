import { describe, expect, test } from "bun:test"
import {
  confirmGoalOverride,
  goalControlAction,
  goalMetadataPatch,
  goalStatusLabel,
  prepareGoalMetadataUpdate,
  readGoalStatusMetadata,
  sessionGoalStatusMetadataKey,
  sessionGoalRunMetadataKey,
  shouldWriteGoalPatch,
  type GoalOverride,
} from "./session-goal-state"

describe("session goal optimistic state", () => {
  test("recognizes an idempotent metadata update before creating an override", () => {
    expect(prepareGoalMetadataUpdate("  ship it  ", { "opencode.session.goal": "ship it" })).toMatchObject({
      goal: "ship it",
      isIdempotent: true,
    })
  })

  test("does not confirm a disappeared or stale override when an ack arrives", () => {
    const override: GoalOverride = {
      value: "ship it",
      before: { present: false, value: "" },
      confirmed: false,
    }

    expect(confirmGoalOverride(undefined, true)).toBeUndefined()
    expect(confirmGoalOverride(override, false)).toBeUndefined()
    expect(confirmGoalOverride(override, true)).toEqual({ ...override, confirmed: true })
  })

  test("writes a fresh patch for an explicit set while another goal write is pending", () => {
    expect(shouldWriteGoalPatch(true, false)).toBe(false)
    expect(shouldWriteGoalPatch(false, false)).toBe(true)
    expect(shouldWriteGoalPatch(true, true)).toBe(true)
    expect(shouldWriteGoalPatch(false, true)).toBe(true)
  })
})

describe("display-only goal status", () => {
  test("clears an old status atomically with a goal change, even when the text is reused", () => {
    expect(goalMetadataPatch("ship it", "run-new")).toEqual({
      set: { "opencode.session.goal": "ship it", [sessionGoalRunMetadataKey]: "run-new" },
      unset: [sessionGoalStatusMetadataKey],
    })
    expect(goalMetadataPatch("")).toEqual({
      unset: ["opencode.session.goal", sessionGoalRunMetadataKey, sessionGoalStatusMetadataKey],
    })
  })

  test("reads a valid phase and pause reason", () => {
    const status = readGoalStatusMetadata({
      [sessionGoalRunMetadataKey]: "run-new",
      [sessionGoalStatusMetadataKey]: JSON.stringify({ runID: "run-new", condition: "ship it", phase: "verifying", stopped: true, stopReason: "awaiting user" }),
    }, "ship it")
    expect(status).toEqual({ phase: "verifying", stopped: true, stopReason: "awaiting user" })
    expect(goalStatusLabel(status!)).toBe("Paused: awaiting user")
  })

  test("reads an optional control revision and rejects a malformed one", () => {
    const metadata = {
      [sessionGoalRunMetadataKey]: "run-new",
      [sessionGoalStatusMetadataKey]: JSON.stringify({ runID: "run-new", condition: "ship it", phase: "paused", stopped: true, stopReason: "paused", controlRevision: 7 }),
    }
    expect(readGoalStatusMetadata(metadata, "ship it")).toEqual({
      phase: "paused", stopped: true, stopReason: "paused", controlRevision: 7,
    })
    expect(readGoalStatusMetadata({
      [sessionGoalRunMetadataKey]: "run-new",
      [sessionGoalStatusMetadataKey]: JSON.stringify({ runID: "run-new", condition: "ship it", phase: "working", stopped: false, stopReason: "", controlRevision: -1 }),
    }, "ship it")).toBeUndefined()
    expect(readGoalStatusMetadata({
      [sessionGoalRunMetadataKey]: "run-new",
      [sessionGoalStatusMetadataKey]: JSON.stringify({ runID: "run-new", condition: "ship it", phase: "working", stopped: false, stopReason: "", controlRevision: 1.5 }),
    }, "ship it")).toBeUndefined()
  })

  test("the dock control offers Pause while active and Continue when stopped", () => {
    expect(goalControlAction(undefined)).toEqual({ kind: "available", action: "pause", label: "Pause" })
    expect(goalControlAction({ phase: "working", stopped: false, stopReason: "" })).toEqual({ kind: "available", action: "pause", label: "Pause" })
    expect(goalControlAction({ phase: "paused", stopped: true, stopReason: "paused" })).toEqual({ kind: "available", action: "resume", label: "Continue" })
    expect(goalControlAction({ phase: "verifying", stopped: true, stopReason: "awaiting user" })).toEqual({ kind: "available", action: "resume", label: "Continue" })
  })

  test("a terminal achieved goal must not offer a resumable Continue", () => {
    expect(goalControlAction({ phase: "achieved", stopped: true, stopReason: "" })).toEqual({
      kind: "unavailable", label: "Continue", reason: "Goal completed",
    })
  })

  test("rejects a delayed old run status after the same goal text is reused", () => {
    const delayed = { condition: "ship it", runID: "run-old", phase: "paused", stopped: true, stopReason: "old failure" }
    expect(readGoalStatusMetadata({
      [sessionGoalRunMetadataKey]: "run-new",
      [sessionGoalStatusMetadataKey]: JSON.stringify(delayed),
    }, "ship it")).toBeUndefined()
    expect(readGoalStatusMetadata({
      [sessionGoalRunMetadataKey]: "run-old",
      [sessionGoalStatusMetadataKey]: JSON.stringify(delayed),
    }, "ship it")?.stopReason).toBe("old failure")
  })

  test("ignores missing, malformed and unknown metadata", () => {
    expect(readGoalStatusMetadata(undefined, "ship it")).toBeUndefined()
    expect(readGoalStatusMetadata({ [sessionGoalStatusMetadataKey]: "not json" }, "ship it")).toBeUndefined()
    expect(readGoalStatusMetadata({ [sessionGoalStatusMetadataKey]: JSON.stringify({ condition: "ship it", phase: "unknown" }) }, "ship it")).toBeUndefined()
    expect(readGoalStatusMetadata({ [sessionGoalStatusMetadataKey]: JSON.stringify({ condition: "old goal", phase: "paused" }) }, "ship it")).toBeUndefined()
    expect(readGoalStatusMetadata({ [sessionGoalStatusMetadataKey]: JSON.stringify({ condition: "ship it", phase: "achieved", stopped: "yes", stopReason: 7 }) }, "ship it")).toBeUndefined()
    expect(readGoalStatusMetadata({ [sessionGoalStatusMetadataKey]: JSON.stringify({ condition: "ship it", phase: "paused", stopped: false, stopReason: "" }) }, "ship it")).toBeUndefined()
    expect(goalStatusLabel({ phase: "verification-pending", stopped: false, stopReason: "" })).toBe("Completion check")
    expect(goalStatusLabel({ phase: "working", stopped: false, stopReason: "" })).toBe("Working")
  })
})
