import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import {
  handoffCoveredByDock,
  handoffCoveredByCurrentSession,
  handoffPopupKey,
  removePopupKeys,
  shouldShowHandoffPopup,
} from "./question-popup-match"

const session = (id: string, parentID?: string): Session => ({
  id,
  slug: id,
  projectID: "proj_handoff_popup",
  directory: "C:/OpenCode/HandoffPopup",
  title: id,
  version: "dev",
  time: { created: 1, updated: 1 },
  parentID,
})

describe("handoffCoveredByCurrentSession", () => {
  test("suppresses the global popup for a request in the current session tree", () => {
    expect(
      handoffCoveredByCurrentSession({
        routeDirectory: "C:/OpenCode/HandoffPopup",
        requestDirectory: "C:/OpenCode/HandoffPopup",
        currentSessionID: "root",
        requestSessionID: "child",
        routeSessions: [session("root"), session("child", "root")],
        requestSessions: [],
      }),
    ).toBe(true)
  })

  test("matches normalized directory aliases when the route snapshot lacks the child", () => {
    expect(
      handoffCoveredByCurrentSession({
        routeDirectory: "C:\\OpenCode\\HandoffPopup\\",
        requestDirectory: "c:/opencode/handoffpopup",
        currentSessionID: "root",
        requestSessionID: "child",
        routeSessions: [session("root")],
        requestSessions: [session("root"), session("child", "root")],
      }),
    ).toBe(true)
  })

  test("keeps the global popup for a request outside the current session tree", () => {
    expect(
      handoffCoveredByCurrentSession({
        routeDirectory: "C:/OpenCode/HandoffPopup",
        requestDirectory: "C:/OpenCode/OtherProject",
        currentSessionID: "current",
        requestSessionID: "background",
        routeSessions: [session("current")],
        requestSessions: [session("background")],
      }),
    ).toBe(false)
  })
})

describe("handoffCoveredByDock", () => {
  test("matches a dock-owned request across normalized directory aliases", () => {
    const request = { id: "que_handoff", sessionID: "ses_handoff" }
    const dockDirectory = "C:\\OpenCode\\HandoffPopup\\"
    const popupDirectory = "c:/opencode/handoffpopup"

    expect(
      handoffCoveredByDock({
        directory: popupDirectory,
        request,
        visibleRequestKeys: [handoffPopupKey(dockDirectory, request)],
      }),
    ).toBe(true)
    expect(handoffCoveredByDock({ directory: popupDirectory, request, visibleRequestKeys: [] })).toBe(false)
  })
})

describe("removePopupKeys", () => {
  test("removes minimized markers by their request identity and ignores malformed cache values", () => {
    const directory = "C:/OpenCode/HandoffPopup"
    const request = { id: "que_handoff", sessionID: "ses_handoff" }
    const key = handoffPopupKey(directory, request)
    const otherKey = handoffPopupKey(directory, { ...request, id: "que_other" })
    const legacyKey = "legacy-handoff"

    expect(
      removePopupKeys(
        {
          [key]: true,
          [otherKey]: true,
          [legacyKey]: { directory: "C:\\OpenCode\\HandoffPopup\\", request },
          malformed: { directory, request: {} },
          missingDirectory: { request },
          empty: null,
        },
        directory,
        request,
      ),
    ).toEqual([key, legacyKey])
  })
})

describe("shouldShowHandoffPopup", () => {
  test("waits for persisted layout state before showing a pending request", () => {
    const request = { pending: true, dismissed: false, minimized: false }

    expect(shouldShowHandoffPopup({ ...request, ready: false })).toBe(false)
    expect(shouldShowHandoffPopup({ ...request, ready: true })).toBe(true)
  })
})
