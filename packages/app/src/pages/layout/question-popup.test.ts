import { describe, expect, test } from "bun:test"
import type { ControlPartData, ControlSurfaceAction, ControlSurfaceActionStep, SurfaceBlockingRequest, SurfaceControlRequest } from "@opencode-ai/sdk/v2/client"
import { handoffCacheDecision, handoffPopupKey, matchesQuestionPopup, pendingHandoffStep, shouldShowQuestionPopup } from "./question-popup-match"

const switchStep: ControlSurfaceActionStep = {
  type: "switchAgentAndPrompt",
  agent: "build",
  prompt: "continue with the plan",
  model: { mode: "planning-model" },
}

const clickSwitchAction: ControlSurfaceAction = {
  id: "act_switch",
  trigger: { event: "click" },
  steps: [switchStep],
}

const controlRequest = (mode: SurfaceControlRequest["mode"], actions: ControlPartData["actions"]): SurfaceControlRequest => ({
  id: "req_1",
  sessionID: "ses_1",
  revision: 3,
  actions: [],
  mode,
  surface: { version: 1, controlID: "ctl_1", controls: [], actions },
})

const blockingRequest = (): SurfaceBlockingRequest => ({
  id: "req_1",
  sessionID: "ses_1",
  revision: 3,
  actions: [],
  mode: "blocking",
  questions: [],
})

describe("matchesQuestionPopup", () => {
  test("scopes identical session and request IDs to their directory", () => {
    const item = {
      directory: "C:\\Repos\\Project-A",
      request: { sessionID: "ses_same", id: "que_same" },
    }

    expect(matchesQuestionPopup(item, "c:/repos/project-a/", item.request)).toBe(true)
    expect(matchesQuestionPopup(item, "C:/Repos/Project-B", item.request)).toBe(false)
  })
})

describe("shouldShowQuestionPopup", () => {
  test("ignores persisted viewed state and shows only pending, open requests", () => {
    expect(shouldShowQuestionPopup({ pending: true, dismissed: false, minimized: false })).toBe(true)
  })

  test("keeps dismissed or minimized requests closed", () => {
    expect(shouldShowQuestionPopup({ pending: true, dismissed: true, minimized: false })).toBe(false)
    expect(shouldShowQuestionPopup({ pending: true, dismissed: false, minimized: true })).toBe(false)
  })

  test("keeps settled requests closed", () => {
    expect(shouldShowQuestionPopup({ pending: false, dismissed: false, minimized: false })).toBe(false)
  })
})

describe("handoffPopupKey", () => {
  test("scopes key by directory with session and request ids", () => {
    expect(handoffPopupKey("C:\\Repos\\Project-A", { sessionID: "ses_1", id: "req_1" })).toBe(
      handoffPopupKey("c:/repos/project-a", { sessionID: "ses_1", id: "req_1" }),
    )
    expect(handoffPopupKey("C:\\Repos\\Project-A", { sessionID: "ses_2", id: "req_1" })).not.toBe(
      handoffPopupKey("C:\\Repos\\Project-A", { sessionID: "ses_1", id: "req_1" }),
    )
    expect(handoffPopupKey("C:\\Repos\\Project-A", { sessionID: "ses_1", id: "req_2" })).not.toBe(
      handoffPopupKey("C:\\Repos\\Project-A", { sessionID: "ses_1", id: "req_1" }),
    )
  })
})

describe("pendingHandoffStep", () => {
  test("accepts one explicit click switch action on an interactive request", () => {
    const step = pendingHandoffStep(controlRequest("interactive", [clickSwitchAction]))

    expect(step?.step.agent).toBe("build")
    expect(step?.step.prompt).toBe("continue with the plan")
    expect(step?.action.id).toBe("act_switch")
  })

  test("never accepts blocking requests", () => {
    expect(pendingHandoffStep(blockingRequest())).toBeUndefined()
  })

  test("rejects switch actions hidden behind extra steps", () => {
    const hidden: ControlSurfaceAction = { id: "act_hidden", trigger: { event: "click" }, steps: [switchStep, { type: "dismiss" }] }

    expect(pendingHandoffStep(controlRequest("interactive", [hidden]))).toBeUndefined()
  })

  test("rejects non-click triggers and missing actions", () => {
    expect(pendingHandoffStep(controlRequest("interactive", [{ ...clickSwitchAction, trigger: { event: "submit" } }]))).toBeUndefined()
    expect(pendingHandoffStep(controlRequest("interactive", []))).toBeUndefined()
  })
})

describe("handoffCacheDecision", () => {
  const cachedRequest = { id: "req_1", sessionID: "ses_1", revision: 3, actions: [], mode: "interactive" as const, surface: { version: 1 as const, controlID: "ctl_1", controls: [], actions: [] } }
  const newerRequest = { ...cachedRequest, revision: 7 }

  test("keeps the cache while the authoritative snapshot is unavailable", () => {
    expect(handoffCacheDecision({ cachedRequest, authoritativeRequests: undefined })).toBe("keep-cache")
  })

  test("prefers the authoritative request when the same id exists", () => {
    expect(handoffCacheDecision({ cachedRequest, authoritativeRequests: [newerRequest] })).toBe("authoritative")
  })

  test("never overrides a settled authoritative request with the cache", () => {
    const settled = { id: "req_1", sessionID: "ses_1", revision: 7, actions: [], mode: "blocking" as const, questions: [] }
    expect(handoffCacheDecision({ cachedRequest, authoritativeRequests: [settled] })).toBe("authoritative")
  })

  test("drops the cache entry when the authoritative snapshot no longer has the request", () => {
    expect(handoffCacheDecision({ cachedRequest, authoritativeRequests: [] })).toBe("drop")
  })
})
