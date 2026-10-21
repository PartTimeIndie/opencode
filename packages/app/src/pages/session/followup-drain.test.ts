import { describe, expect, test } from "bun:test"
import { followupSendKey, selectNextDrainableFollowup, type DrainableFollowupStore } from "./followup-drain"
import type { FollowupItem } from "./followup-queue"
import type { FollowupState } from "./followup-store"

const followup = (sessionID: string, id: string, directory = "/repo/main"): FollowupItem => ({
  id,
  sessionID,
  sessionDirectory: directory,
  prompt: [{ type: "text", content: id, start: 0, end: id.length }],
  context: [],
  agent: "build",
  model: { providerID: "provider", modelID: "model" },
})

const store = (directory: string, items: FollowupItem[], extra?: Partial<FollowupState>): DrainableFollowupStore => ({
  directory,
  followup: { items: Object.fromEntries(items.map((item) => [item.sessionID, [item]])), failed: {}, paused: {}, edit: {}, ...extra },
})

describe("selectNextDrainableFollowup", () => {
  test("drains a settled background-directory queue while the active session is busy", () => {
    // Regression: only the rendered session tab used to drain its own store, so
    // this release only happened after re-selecting the background tab.
    expect(
      selectNextDrainableFollowup({
        stores: [
          store("/repo/main", [followup("session-active", "message-active")]),
          store("/repo/other", [followup("session-background", "message-background", "/repo/other")]),
        ],
        activeSessionID: "session-active",
        activeDirectory: "/repo/main",
        isBusy: (sessionID) => sessionID === "session-active",
        isActivitySettled: (sessionID) => sessionID === "session-background",
        isChild: () => false,
        isBlocked: () => false,
      }),
    ).toMatchObject({ directory: "/repo/other", sessionID: "session-background", item: { id: "message-background" } })
  })

  test("prefers the active session's directory but skips queues that are not eligible", () => {
    expect(
      selectNextDrainableFollowup({
        stores: [
          store("/repo/other", [followup("session-background", "message-background", "/repo/other")]),
          store("/repo/main", [followup("session-paused", "message-paused")], { paused: { "session-paused": true } }),
        ],
        activeSessionID: "session-paused",
        activeDirectory: "/repo/main",
        isBusy: () => false,
        isChild: () => false,
        isBlocked: () => false,
      }),
    ).toMatchObject({ directory: "/repo/other", item: { id: "message-background" } })
  })

  test("returns the active directory's first eligible followup when it is ready", () => {
    expect(
      selectNextDrainableFollowup({
        stores: [
          store("/repo/other", [followup("session-background", "message-background", "/repo/other")]),
          store("/repo/main", [followup("session-active", "message-active")]),
        ],
        activeSessionID: "session-active",
        activeDirectory: "/repo/main",
        isBusy: () => false,
        isChild: () => false,
        isBlocked: () => false,
      }),
    ).toMatchObject({ directory: "/repo/main", sessionID: "session-active", item: { id: "message-active" } })
  })

  test("returns nothing when every queued followup is blocked", () => {
    expect(
      selectNextDrainableFollowup({
        stores: [store("/repo/main", [followup("session-blocked", "message-blocked")])],
        isBusy: () => false,
        isChild: () => false,
        isBlocked: () => true,
      }),
    ).toBeUndefined()
  })

  test("parks a whole store whose sync data has not finished loading", () => {
    expect(
      selectNextDrainableFollowup({
        stores: [store("/repo/loading", [followup("session-b", "message-b")])],
        isBusy: () => false,
        isChild: () => false,
        isBlocked: () => false,
        isReady: (directory) => directory !== "/repo/loading",
      }),
    ).toBeUndefined()
  })

  test("skips items claimed by an in-flight send and drains the next eligible one", () => {
    const claimed = followup("session-a", "message-a")
    expect(
      selectNextDrainableFollowup({
        stores: [store("/repo/main", [claimed, followup("session-a", "message-b")])],
        isBusy: () => false,
        isChild: () => false,
        isBlocked: () => false,
        isClaimed: (item) => item.id === claimed.id,
      }),
    ).toMatchObject({ sessionID: "session-a", item: { id: "message-b" } })
  })

  test("drains a draft whose agent differs from the session's authoritative agent", () => {
    // Drafts send with the agent recorded at queue time, so a session-side
    // agent change must not veto or reorder the release.
    expect(
      selectNextDrainableFollowup({
        stores: [store("/repo/main", [followup("session-a", "message-a")])],
        activeSessionID: "session-a",
        activeDirectory: "/repo/main",
        isBusy: () => false,
        isChild: () => false,
        isBlocked: () => false,
      }),
    ).toMatchObject({ sessionID: "session-a", item: { id: "message-a" } })
  })

  test("does not consult readiness or child gates for restored stores without queue content", () => {
    const readinessCalls: string[] = []
    const childCalls: string[] = []
    const result = selectNextDrainableFollowup({
      stores: [
        store("/repo/empty-1", []),
        store("/repo/empty-2", []),
        store("/repo/main", [followup("session-b", "message-b")]),
      ],
      isBusy: () => false,
      isChild: (sessionID, directory) => {
        childCalls.push(`${directory}:${sessionID}`)
        return false
      },
      isBlocked: () => false,
      isReady: (directory) => {
        readinessCalls.push(directory)
        return true
      },
    })

    // Empty restored stores must never reach the readiness lookup: the runner
    // resolves it through serverSync.child(directory), whose default bootstrap
    // would start a full background-project bootstrap per empty tab on startup.
    expect(readinessCalls).toEqual(["/repo/main"])
    expect(childCalls).toEqual(["/repo/main:session-b"])
    expect(result).toMatchObject({ directory: "/repo/main", sessionID: "session-b", item: { id: "message-b" } })
  })

  test("still gates stores with real queue content through readiness and safety callbacks", () => {
    const order: string[] = []
    const result = selectNextDrainableFollowup({
      stores: [store("/repo/other", [followup("session-b", "message-b", "/repo/other")])],
      isBusy: () => {
        order.push("busy")
        return false
      },
      isChild: () => {
        order.push("child")
        return false
      },
      isBlocked: () => {
        order.push("blocked")
        return false
      },
      isReady: (directory) => {
        order.push(`ready:${directory}`)
        return true
      },
    })

    expect(order).toEqual(["ready:/repo/other", "child", "blocked", "busy"])
    expect(result).toMatchObject({ directory: "/repo/other", item: { id: "message-b" } })
  })
})

describe("followupSendKey", () => {
  test("matches the shared in-flight claim key used by the composer's manual send", () => {
    expect(followupSendKey("http://127.0.0.1:4096", followup("session-1", "message-1", "/repo/main"))).toBe(
      "http://127.0.0.1:4096:/repo/main:session-1:message-1",
    )
  })
})
