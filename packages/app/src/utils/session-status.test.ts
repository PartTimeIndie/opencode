import { describe, expect, test } from "bun:test"
import {
  hasActiveSessionTool,
  latestAssistantCompletedBefore,
  latestAssistantSettled,
  resolveLifecycleStatus,
  resolveSessionStatus,
  sessionIsWorking,
} from "./session-status"

describe("hasActiveSessionTool", () => {
  const store = (status: string) => ({
    message: { ses: [{ id: "msg" }] },
    part: { msg: [{ type: "tool", state: { status } }] },
  })

  test("keeps a session running while a tool is pending or running", () => {
    expect(hasActiveSessionTool(store("pending"), "ses")).toBe(true)
    expect(hasActiveSessionTool(store("running"), "ses")).toBe(true)
  })

  test("does not keep a session running after the tool reaches a terminal state", () => {
    expect(hasActiveSessionTool(store("completed"), "ses")).toBe(false)
    expect(hasActiveSessionTool(store("error"), "ses")).toBe(false)
  })

  test("does not keep a session running after the latest assistant has finished", () => {
    const settled = {
      message: { ses: [{ id: "msg", role: "assistant" as const, finish: "stop", time: { completed: 1 } }] },
      part: { msg: [{ type: "tool", state: { status: "running" } }] },
    }
    expect(latestAssistantSettled(settled, "ses")).toBe(true)
    expect(hasActiveSessionTool(settled, "ses")).toBe(false)
    expect(sessionIsWorking(settled, "ses", "idle")).toBe(false)
  })

  test("keeps a tool-calls step working through a premature idle snapshot", () => {
    const midTurn = {
      message: { ses: [{ id: "msg", role: "assistant" as const, finish: "tool-calls", time: { completed: 1 } }] },
      part: { msg: [{ type: "tool", state: { status: "running" } }] },
    }
    expect(latestAssistantSettled(midTurn, "ses")).toBe(false)
    expect(hasActiveSessionTool(midTurn, "ses")).toBe(true)
    expect(sessionIsWorking(midTurn, "ses", "idle")).toBe(true)
  })
})

describe("sessionIsWorking", () => {
  const store = {
    message: { ses: [{ id: "msg" }] },
    part: { msg: [{ type: "tool", state: { status: "running" } }] },
  }

  test("keeps an active tool visible through a premature idle lifecycle snapshot", () => {
    expect(sessionIsWorking(store, "ses")).toBe(true)
    expect(sessionIsWorking(store, "ses", "busy")).toBe(true)
    expect(sessionIsWorking(store, "ses", "retry")).toBe(true)
    expect(sessionIsWorking(store, "ses", "idle")).toBe(true)
    expect(sessionIsWorking(store, "ses", "waiting_for_user")).toBe(false)
  })

  test("does not invent work for an idle session without an active tool", () => {
    expect(sessionIsWorking({ message: {}, part: {} }, "ses", "idle")).toBe(false)
  })

  test("ignores a stale running tool once a later assistant response is visible", () => {
    expect(
      hasActiveSessionTool(
        {
          message: { ses: [{ id: "tool", role: "assistant" }, { id: "final", role: "assistant" }] },
          part: {
            tool: [{ type: "tool", state: { status: "running" } }],
            final: [{ type: "text" }],
          },
        },
        "ses",
      ),
    ).toBe(false)
  })
})

describe("resolveSessionStatus", () => {
  test("returns undefined for an idle session with no completion signal", () => {
    expect(resolveSessionStatus({ working: false, question: false, turnCompletion: undefined })).toBeUndefined()
  })

  test("resolves running when working and there is no open question", () => {
    expect(resolveSessionStatus({ working: true, question: false, turnCompletion: undefined })).toBe("running")
    expect(resolveSessionStatus({ working: true, question: false, turnCompletion: "incomplete" })).toBe("running")
    expect(resolveSessionStatus({ working: true, question: false, turnCompletion: "done" })).toBe("running")
  })

  test("resolves attention only for an open question", () => {
    expect(resolveSessionStatus({ working: true, question: true, turnCompletion: undefined })).toBe("attention")
    expect(resolveSessionStatus({ working: false, question: true, turnCompletion: "incomplete" })).toBe("attention")
    expect(resolveSessionStatus({ working: false, question: true, turnCompletion: "done" })).toBe("attention")
  })

  test("resolves waiting_for_user as attention before the question store hydrates", () => {
    expect(
      resolveSessionStatus({
        working: false,
        question: false,
        status: "waiting_for_user",
        turnCompletion: "done",
      }),
    ).toBe("attention")
  })

  test("resolves terminal states only after work stops", () => {
    expect(resolveSessionStatus({ working: false, question: false, turnCompletion: "incomplete" })).toBe("incomplete")
    expect(resolveSessionStatus({ working: false, question: false, turnCompletion: "done" })).toBe("done")
    expect(resolveSessionStatus({ working: false, question: false, turnCompletion: "unknown" })).toBeUndefined()
    expect(resolveSessionStatus({ working: true, question: false, turnCompletion: "done" })).not.toBe("done")
    expect(resolveSessionStatus({ working: true, question: false, turnCompletion: "incomplete" })).not.toBe("incomplete")
  })

  test("lets an idle terminal event clear a stale running tool projection", () => {
    expect(resolveSessionStatus({ working: true, question: false, status: "idle", turnCompletion: "done" })).toBe(
      "done",
    )
    expect(
      resolveSessionStatus({ working: true, question: false, status: "idle", turnCompletion: "incomplete" }),
    ).toBe("incomplete")
    expect(resolveSessionStatus({ working: true, question: false, status: "busy", turnCompletion: "done" })).toBe(
      "running",
    )
  })
})

describe("resolveLifecycleStatus", () => {
  test("keeps client activity busy through a premature idle snapshot while the assistant is in flight", () => {
    expect(resolveLifecycleStatus({ activity: "busy", store: "idle", latestAssistantSettled: false })).toBe("busy")
  })

  test("trusts idle once the latest assistant has settled even if client activity is still busy", () => {
    expect(resolveLifecycleStatus({ activity: "busy", store: "idle", latestAssistantSettled: true })).toBe("idle")
  })

  test("keeps live activity busy when store status has not hydrated yet", () => {
    expect(resolveLifecycleStatus({ activity: "busy", store: undefined, latestAssistantSettled: true })).toBe("busy")
  })

  test("keeps independently tracked activities busy despite stale idle snapshots from earlier turns", () => {
    const started = 1_780_000_010_000
    for (const sessionID of ["first", "second"]) {
      const store = {
        message: { [sessionID]: [{ id: sessionID, role: "assistant", finish: "stop", time: { completed: started - 1_000 } }] },
        part: {},
      }
      expect(resolveLifecycleStatus({
        activity: "busy",
        activityTracked: latestAssistantCompletedBefore(store, sessionID, started),
        store: "idle",
        latestAssistantSettled: latestAssistantSettled(store, sessionID),
      }), sessionID).toBe("busy")
    }
  })

  test("trusts idle when the assistant completed after the tracked activity began", () => {
    const store = {
      message: { ses: [{ id: "msg", role: "assistant", finish: "stop", time: { completed: 1_780_000_011_000 } }] },
      part: {},
    }
    expect(resolveLifecycleStatus({
      activity: "busy",
      activityTracked: latestAssistantCompletedBefore(store, "ses", 1_780_000_010_000),
      store: "idle",
      latestAssistantSettled: latestAssistantSettled(store, "ses"),
    })).toBe("idle")
  })

  test("keeps a new turn busy when the previous assistant is already settled", () => {
    expect(resolveLifecycleStatus({ activity: "busy", store: "busy", latestAssistantSettled: true })).toBe("busy")
  })

  test("does not resurrect stale store busy after a terminal activity event", () => {
    expect(
      resolveLifecycleStatus({ activitySettled: true, store: "busy", latestAssistantSettled: false }),
    ).toBe("idle")
  })

  test("shows a durable user wait instead of a stale busy activity", () => {
    expect(
      resolveLifecycleStatus({ activity: "busy", store: "waiting_for_user", latestAssistantSettled: false }),
    ).toBe("waiting_for_user")
  })
})

describe("sessionIsWorking lifecycle authority", () => {
  const store = {
    message: { ses: [{ id: "msg", role: "assistant" }] },
    part: { msg: [{ type: "tool", state: { status: "running" } }] },
  }

  test("does not resurrect stale tools after a settled activity", () => {
    expect(sessionIsWorking(store, "ses", "idle", true)).toBeFalse()
  })

  test("keeps an active tool during a premature server-idle snapshot", () => {
    expect(sessionIsWorking(store, "ses", "idle")).toBeTrue()
  })

  test("keeps a new busy activity working", () => {
    expect(sessionIsWorking(store, "ses", "busy", false)).toBeTrue()
  })

  test("keeps timeline progress visible during a premature idle snapshot, then stops at settlement", () => {
    const snapshot = { message: {}, part: {} }
    const running = resolveLifecycleStatus({ activity: "busy", store: "idle", latestAssistantSettled: false })
    expect(sessionIsWorking(snapshot, "ses", running)).toBeTrue()
    const settled = resolveLifecycleStatus({ activitySettled: true, store: "busy", latestAssistantSettled: false })
    expect(sessionIsWorking(snapshot, "ses", settled, true)).toBeFalse()
  })
})
