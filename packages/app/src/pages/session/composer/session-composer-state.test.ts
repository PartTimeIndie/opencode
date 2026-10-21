import { describe, expect, test } from "bun:test"
import type { PermissionRequest, SurfaceBlockingRequest, Session } from "@opencode-ai/sdk/v2/client"
import { todoState } from "./session-composer-todo-state"
import { composerModelLoading } from "./session-composer-readiness"
import {
  isImplementationCompleteFollowupQuestion,
  sessionPermissionRequest,
  sessionSurfaceRequest,
  sessionSurfaceRequests,
  sessionTreeIDs,
} from "./session-request-tree"

const session = (input: { id: string; parentID?: string }) =>
  ({
    id: input.id,
    parentID: input.parentID,
  }) as Session

const permission = (id: string, sessionID: string) =>
  ({
    id,
    sessionID,
  }) as PermissionRequest

const question = (id: string, sessionID: string, phase?: SurfaceBlockingRequest["phase"]) =>
  ({
    id,
    sessionID,
    mode: "blocking",
    revision: 1,
    actions: [],
    phase,
    questions: [],
  }) as SurfaceBlockingRequest

describe("composerModelLoading", () => {
  test("does not wait for unrelated agent discovery after project providers load", () => {
    expect(
      composerModelLoading({
        directoryLoading: false,
        directoryHasProviders: true,
        globalLoading: true,
        retrying: false,
      }),
    ).toBe(false)
  })

  test("waits for the project provider query and its global empty fallback", () => {
    expect(
      composerModelLoading({
        directoryLoading: true,
        directoryHasProviders: false,
        globalLoading: false,
        retrying: false,
      }),
    ).toBe(true)
    expect(
      composerModelLoading({
        directoryLoading: false,
        directoryHasProviders: false,
        globalLoading: true,
        retrying: false,
      }),
    ).toBe(true)
    expect(
      composerModelLoading({
        directoryLoading: false,
        directoryHasProviders: false,
        globalLoading: false,
        retrying: false,
      }),
    ).toBe(false)
  })

  test("shows loading while a provider retry runs without hiding the usable catalog", () => {
    expect(
      composerModelLoading({
        directoryLoading: false,
        directoryHasProviders: true,
        globalLoading: false,
        retrying: true,
      }),
    ).toBe(true)
  })
})

describe("sessionPermissionRequest", () => {
  test("prefers the current session permission", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const permissions = {
      root: [permission("perm-root", "root")],
      child: [permission("perm-child", "child")],
    }

    expect(sessionPermissionRequest(sessions, permissions, "root")?.id).toBe("perm-root")
  })

  test("does not return a nested child permission", () => {
    const sessions = [
      session({ id: "root" }),
      session({ id: "child", parentID: "root" }),
      session({ id: "grand", parentID: "child" }),
      session({ id: "other" }),
    ]
    const permissions = {
      grand: [permission("perm-grand", "grand")],
      other: [permission("perm-other", "other")],
    }

    expect(sessionPermissionRequest(sessions, permissions, "root")).toBeUndefined()
  })

  test("returns undefined without a matching session permission", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const permissions = {
      other: [permission("perm-other", "other")],
    }

    expect(sessionPermissionRequest(sessions, permissions, "root")).toBeUndefined()
  })

  test("does not fall back to child permissions when the current session is filtered", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const permissions = {
      root: [permission("perm-root", "root")],
      child: [permission("perm-child", "child")],
    }

    expect(sessionPermissionRequest(sessions, permissions, "root", (item) => item.id !== "perm-root")).toBeUndefined()
  })

  test("returns undefined when all current session permissions are filtered out", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const permissions = {
      root: [permission("perm-root", "root")],
      child: [permission("perm-child", "child")],
    }

    expect(sessionPermissionRequest(sessions, permissions, "root", () => false)).toBeUndefined()
  })
})

describe("sessionSurfaceRequest", () => {
  test("prefers the current session question", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const questions = {
      root: [question("q-root", "root")],
      child: [question("q-child", "child")],
    }

    expect(sessionSurfaceRequest(sessions, questions, "root")?.id).toBe("q-root")
  })

  test("returns a nested subagent question in the parent session", () => {
    const sessions = [
      session({ id: "root" }),
      session({ id: "child", parentID: "root" }),
      session({ id: "grand", parentID: "child" }),
    ]
    const questions = {
      grand: [question("q-grand", "grand")],
    }

    expect(sessionSurfaceRequest(sessions, questions, "root")?.id).toBe("q-grand")
  })

  test("identifies implementation-complete follow-up questions as optional", () => {
    expect(
      isImplementationCompleteFollowupQuestion(question("q-followup", "root", "implementation_complete_followup")),
    ).toBe(true)
    expect(isImplementationCompleteFollowupQuestion(question("q-normal", "root"))).toBe(false)
  })

  test("returns implementation-complete follow-up questions for the current session", () => {
    const sessions = [session({ id: "root" })]
    const questions = {
      root: [question("q-followup", "root", "implementation_complete_followup")],
    }

    expect(sessionSurfaceRequest(sessions, questions, "root")?.id).toBe("q-followup")
  })

  test("returns all current session questions for queue rendering", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const questions = {
      root: [question("q-root-1", "root"), question("q-root-2", "root")],
      child: [question("q-child", "child")],
    }

    expect(sessionSurfaceRequests(sessions, questions, "root").map((item) => item.id)).toEqual([
      "q-root-1",
      "q-root-2",
      "q-child",
    ])
  })

  test("keeps a subagent question visible while the parent changes model", () => {
    const questions = { child: [question("q-child", "child")] }
    const before = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const after = [
      { ...session({ id: "root" }), model: { providerID: "zhipuai-coding-plan", modelID: "glm-5.2" } },
      session({ id: "child", parentID: "root" }),
    ] as Session[]

    expect(sessionSurfaceRequests(before, questions, "root").map((item) => item.id)).toEqual(["q-child"])
    expect(sessionSurfaceRequests(after, questions, "root").map((item) => item.id)).toEqual(["q-child"])
  })

  test("filters current session questions for local dismiss", () => {
    const sessions = [session({ id: "root" })]
    const questions = {
      root: [question("q-root-1", "root"), question("q-root-2", "root")],
    }

    expect(
      sessionSurfaceRequests(sessions, questions, "root", (item) => item.id !== "q-root-1").map((item) => item.id),
    ).toEqual(["q-root-2"])
  })
})

describe("todoState", () => {
  test("hides when there are no todos", () => {
    expect(todoState({ count: 0, done: false, live: true })).toBe("hide")
  })

  test("opens while the session is still working", () => {
    expect(todoState({ count: 2, done: false, live: true })).toBe("open")
  })

  test("closes completed todos after a running turn", () => {
    expect(todoState({ count: 2, done: true, live: true })).toBe("close")
  })

  test("clears stale todos when the turn ends", () => {
    expect(todoState({ count: 2, done: false, live: false })).toBe("clear")
  })

  test("clears completed todos when the session is no longer live", () => {
    expect(todoState({ count: 2, done: true, live: false })).toBe("clear")
  })
})
