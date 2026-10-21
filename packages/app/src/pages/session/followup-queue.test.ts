import { describe, expect, test } from "bun:test"
import { selectQueuedFollowup, type FollowupItem } from "./followup-queue"

const followup = (sessionID: string, id: string): FollowupItem => ({
  id,
  sessionID,
  sessionDirectory: "/repo/main",
  prompt: [{ type: "text", content: id, start: 0, end: id.length }],
  context: [],
  agent: "build",
  model: { providerID: "provider", modelID: "model" },
})

describe("selectQueuedFollowup", () => {
  test("selects an eligible queued followup from an inactive session", () => {
    expect(
      selectQueuedFollowup({
        activeSessionID: "session-active",
        items: {
          "session-active": [],
          "session-inactive": [followup("session-inactive", "message-inactive")],
        },
        failed: {},
        isBusy: () => false,
        isChild: () => false,
        isBlocked: () => false,
      }),
    ).toMatchObject({ sessionID: "session-inactive", item: { id: "message-inactive" } })
  })

  test("does not let the active session block eligible inactive queues", () => {
    expect(
      selectQueuedFollowup({
        activeSessionID: "session-active",
        items: {
          "session-active": [followup("session-active", "message-active")],
          "session-inactive": [followup("session-inactive", "message-inactive")],
        },
        failed: {},
        isBusy: () => false,
        isChild: () => false,
        isBlocked: (sessionID) => sessionID === "session-active",
      }),
    ).toMatchObject({ sessionID: "session-inactive", item: { id: "message-inactive" } })
  })

  test("does not let active-session busy state block eligible inactive queues", () => {
    expect(
      selectQueuedFollowup({
        activeSessionID: "session-active",
        items: {
          "session-active": [followup("session-active", "message-active")],
          "session-inactive": [followup("session-inactive", "message-inactive")],
        },
        failed: {},
        isBusy: (sessionID) => sessionID === "session-active",
        isChild: () => false,
        isBlocked: () => false,
      }),
    ).toMatchObject({ sessionID: "session-inactive", item: { id: "message-inactive" } })
  })

  test("prefers the active session when both queues are eligible", () => {
    expect(
      selectQueuedFollowup({
        activeSessionID: "session-active",
        items: {
          "session-inactive": [followup("session-inactive", "message-inactive")],
          "session-active": [followup("session-active", "message-active")],
        },
        failed: {},
        isBusy: () => false,
        isChild: () => false,
        isBlocked: () => false,
      }),
    ).toMatchObject({ sessionID: "session-active", item: { id: "message-active" } })
  })

  test("skips blocked inactive sessions", () => {
    expect(
      selectQueuedFollowup({
        activeSessionID: "session-active",
        items: {
          "session-active": [],
          "session-blocked": [followup("session-blocked", "message-blocked")],
          "session-ready": [followup("session-ready", "message-ready")],
        },
        failed: {},
        isBusy: () => false,
        isChild: () => false,
        isBlocked: (sessionID) => sessionID === "session-blocked",
      }),
    ).toMatchObject({ sessionID: "session-ready", item: { id: "message-ready" } })
  })

  test("skips failed, busy, and child sessions", () => {
    expect(
      selectQueuedFollowup({
        items: {
          failed: [followup("failed", "message-failed")],
          busy: [followup("busy", "message-busy")],
          child: [followup("child", "message-child")],
          ready: [followup("ready", "message-ready")],
        },
        failed: { failed: "message-failed" },
        isBusy: (sessionID) => sessionID === "busy",
        isChild: (sessionID) => sessionID === "child",
        isBlocked: () => false,
      }),
    ).toMatchObject({ sessionID: "ready", item: { id: "message-ready" } })
  })

  test("drains a queued followup after its tracked activity completed even if status is stale", () => {
    expect(
      selectQueuedFollowup({
        activeSessionID: "session-busy",
        items: { "session-busy": [followup("session-busy", "message-goal")] },
        failed: {},
        isBusy: () => true,
        isActivitySettled: () => true,
        isChild: () => false,
        isBlocked: () => false,
      }),
    ).toMatchObject({ sessionID: "session-busy", item: { id: "message-goal" } })
  })

  test("keeps followups paused after a manual agent switch until the user releases one", () => {
    expect(
      selectQueuedFollowup({
        activeSessionID: "session-paused",
        items: {
          "session-paused": [followup("session-paused", "message-paused")],
          "session-ready": [followup("session-ready", "message-ready")],
        },
        failed: {},
        paused: { "session-paused": true },
        isBusy: () => false,
        isChild: () => false,
        isBlocked: () => false,
      }),
    ).toMatchObject({ sessionID: "session-ready", item: { id: "message-ready" } })
  })
})
