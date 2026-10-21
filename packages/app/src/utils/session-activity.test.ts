import { describe, expect, test } from "bun:test"
import {
  activeSessionActivityIDs,
  finishSessionActivity,
  sessionActivity,
  sessionActivitySettled,
  sessionActivityStartedAt,
  sessionActivityDirectoryGeneration,
  sessionActivityGeneration,
  startSessionActivity,
  updateSessionActivity,
} from "./session-activity"

describe("session activity registry", () => {
  test("shares running state across equivalent directory spellings and clears on idle", () => {
    updateSessionActivity("C:\\GitRepros\\opencode", "ses_registry", { type: "busy" })
    expect(sessionActivity("c:/gitrepros/opencode", "ses_registry")?.type).toBe("busy")

    updateSessionActivity("C:/GitRepros/opencode", "ses_registry", { type: "idle" })
    expect(sessionActivity("C:\\GitRepros\\opencode", "ses_registry")).toBeUndefined()
  })

  test("exposes only the active lifecycle start timestamp for each session", () => {
    const directory = "C:/GitRepros/activity-start-time"
    startSessionActivity(directory, "ses_first", "activity_first", { timestamp: 1_780_000_010_000 })
    startSessionActivity(directory, "ses_second", "activity_second", { timestamp: 1_780_000_020_000 })
    expect(sessionActivityStartedAt(directory, "ses_first")).toBe(1_780_000_010_000)
    expect(sessionActivityStartedAt(directory, "ses_second")).toBe(1_780_000_020_000)
    finishSessionActivity(directory, "ses_first", "activity_first", { timestamp: 1_780_000_030_000 })
    expect(sessionActivityStartedAt(directory, "ses_first")).toBeUndefined()
    expect(sessionActivityStartedAt(directory, "ses_second")).toBe(1_780_000_020_000)
  })

  test("ignores a stale idle snapshot until the lifecycle emits a terminal event", () => {
    const generation = sessionActivityGeneration("C:\\GitRepros\\opencode", "ses_lifecycle")
    const directoryGeneration = sessionActivityDirectoryGeneration("C:\\GitRepros\\opencode")
    startSessionActivity("C:\\GitRepros\\opencode", "ses_lifecycle")
    expect(sessionActivityGeneration("C:/GitRepros/opencode", "ses_lifecycle")).toBe(generation + 1)
    expect(sessionActivityDirectoryGeneration("C:/GitRepros/opencode")).toBe(directoryGeneration + 1)
    updateSessionActivity("C:\\GitRepros\\opencode", "ses_lifecycle", { type: "idle" })
    expect(sessionActivity("C:\\GitRepros\\opencode", "ses_lifecycle")?.type).toBe("busy")
    expect(sessionActivityGeneration("C:/GitRepros/opencode", "ses_lifecycle")).toBe(generation + 1)

    finishSessionActivity("C:\\GitRepros\\opencode", "ses_lifecycle")
    expect(sessionActivity("C:\\GitRepros\\opencode", "ses_lifecycle")).toBeUndefined()
    expect(sessionActivitySettled("C:/GitRepros/opencode", "ses_lifecycle")).toBeTrue()
    expect(sessionActivityGeneration("C:/GitRepros/opencode", "ses_lifecycle")).toBe(generation + 2)
    expect(sessionActivityDirectoryGeneration("C:/GitRepros/opencode")).toBe(directoryGeneration + 2)
  })

  test("ignores a terminal event from an older activity", () => {
    const directory = "C:/GitRepros/activity-order"
    startSessionActivity(directory, "ses_order", "activity_a")
    finishSessionActivity(directory, "ses_order", "activity_a")
    startSessionActivity(directory, "ses_order", "activity_b")

    expect(startSessionActivity(directory, "ses_order", "activity_a")).toBeFalse()
    expect(finishSessionActivity(directory, "ses_order", "activity_a")).toBeFalse()
    expect(sessionActivity(directory, "ses_order")?.type).toBe("busy")
    expect(finishSessionActivity(directory, "ses_order", "activity_b")).toBeTrue()
    expect(sessionActivity(directory, "ses_order")).toBeUndefined()
  })

  test("ignores duplicate starts for the currently active activity", () => {
    const directory = "C:/GitRepros/activity-duplicate"
    expect(startSessionActivity(directory, "ses_duplicate", "activity_same")).toBeTrue()
    const generation = sessionActivityGeneration(directory, "ses_duplicate")

    expect(startSessionActivity(directory, "ses_duplicate", "activity_same")).toBeFalse()
    expect(sessionActivityGeneration(directory, "ses_duplicate")).toBe(generation)
    expect(sessionActivity(directory, "ses_duplicate")?.type).toBe("busy")

    finishSessionActivity(directory, "ses_duplicate", "activity_same")
  })

  test("keeps an unseen terminal as ordering evidence against its delayed start", () => {
    const directory = "C:/GitRepros/activity-reorder"
    expect(finishSessionActivity(directory, "ses_reorder", "activity_b", { timestamp: 2, eventID: "evt_2" })).toBeTrue()
    expect(sessionActivity(directory, "ses_reorder")).toBeUndefined()
    expect(startSessionActivity(directory, "ses_reorder", "activity_b", { timestamp: 1, eventID: "evt_1" })).toBeFalse()
    expect(sessionActivity(directory, "ses_reorder")).toBeUndefined()
  })

  test("tombstones an untracked terminal when a status-only record exists", () => {
    const directory = "C:/GitRepros/activity-status-only"
    updateSessionActivity(directory, "ses_snapshot", { type: "busy" })

    expect(finishSessionActivity(directory, "ses_snapshot", "activity_x")).toBeTrue()
    expect(sessionActivity(directory, "ses_snapshot")).toBeUndefined()
    expect(startSessionActivity(directory, "ses_snapshot", "activity_x")).toBeFalse()
    expect(sessionActivity(directory, "ses_snapshot")).toBeUndefined()
  })

  test("keeps idle when a second pipeline replays start after a tracked close", () => {
    const directory = "C:/GitRepros/activity-pair-replay"
    expect(startSessionActivity(directory, "ses_pair", "activity_pair")).toBeTrue()
    expect(finishSessionActivity(directory, "ses_pair", "activity_pair")).toBeTrue()
    expect(startSessionActivity(directory, "ses_pair", "activity_pair")).toBeFalse()
    expect(sessionActivity(directory, "ses_pair")).toBeUndefined()
  })

  test("rejects a start superseded by a newer closed activity", () => {
    const directory = "C:/GitRepros/activity-superseded"
    startSessionActivity(directory, "ses_superseded", "activity_a")
    finishSessionActivity(directory, "ses_superseded", "activity_a")
    startSessionActivity(directory, "ses_superseded", "activity_b")
    finishSessionActivity(directory, "ses_superseded", "activity_b")

    // activity_b closed after activity_a; a start of a is genuinely stale because SSE
    // ordering means the server cannot have emitted started(a) after completed(b).
    expect(startSessionActivity(directory, "ses_superseded", "activity_a")).toBeFalse()
    expect(sessionActivity(directory, "ses_superseded")).toBeUndefined()
  })

  test("rejects an unseen older start after a newer activity completed, including equal timestamps", () => {
    const directory = "C:/GitRepros/activity-evidence"
    startSessionActivity(directory, "ses_evidence", "activity_b", { timestamp: 2, eventID: "evt_0002" })
    finishSessionActivity(directory, "ses_evidence", "activity_b", { timestamp: 3, eventID: "evt_0003" })

    expect(startSessionActivity(directory, "ses_evidence", "activity_a", { timestamp: 1, eventID: "evt_0001" })).toBeFalse()
    expect(startSessionActivity(directory, "ses_evidence", "activity_a", { timestamp: 3, eventID: "evt_0002" })).toBeFalse()
    expect(sessionActivity(directory, "ses_evidence")).toBeUndefined()
  })

  test("enumerates active sessions for authoritative cold-store recovery", () => {
    const directory = "C:/GitRepros/activity-recovery"
    startSessionActivity(directory, "ses_active", "activity_active")
    startSessionActivity("C:/GitRepros/other", "ses_other", "activity_other")

    expect(activeSessionActivityIDs("c:\\gitrepros\\activity-recovery")).toEqual(["ses_active"])
    finishSessionActivity(directory, "ses_active", "activity_active")
    finishSessionActivity("C:/GitRepros/other", "ses_other", "activity_other")
  })
})
