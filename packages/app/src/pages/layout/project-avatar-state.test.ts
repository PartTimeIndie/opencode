import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { selectSessionTabStore, selectSessionTabSync } from "./session-tab-sync"
import { sessionTabStatus, sessionTabUnread } from "./project-avatar-unread"
import { reconcileSessionStatusSnapshot, type ServerSync } from "@/context/server-sync"
import {
  finishSessionActivity,
  sessionActivity,
  sessionActivityGenerationSnapshot,
  sessionActivitySettled,
  sessionActivityStartedAt,
  startSessionActivity,
} from "@/utils/session-activity"
import {
  latestAssistantCompletedBefore,
  latestAssistantSettled,
  resolveLifecycleStatus,
  resolveSessionStatus,
  sessionIsWorking,
} from "@/utils/session-status"
import type { TurnCompletionStatus } from "@/utils/session-status"

// Regression coverage for the tab avatar using the same canonical directory store as the
// Session Navigator. A separately materialized child store can lag behind the existing store
// across tab switches, hiding running and completion indicators in the title bar.

describe("session tab sync source precedence", () => {
  const current = {} as ServerSync
  const tabBound = {} as ServerSync

  test("uses the tab-bound sync when one is injected", () => {
    expect(
      selectSessionTabSync({
        context: current,
        injected: tabBound,
      }),
    ).toBe(tabBound)
  })

  test("falls back to current context when no tab-bound sync exists", () => {
    expect(
      selectSessionTabSync({
        context: current,
      }),
    ).toBe(current)
  })
})

describe("session tab store selection", () => {
  test("uses an existing directory store without peeking a new store", () => {
    const existing = {}
    let peekCalls = 0
    const sync = {
      existing: () => [existing],
      peek: () => {
        peekCalls++
        return [{}]
      },
    } as unknown as Pick<ServerSync, "existing" | "peek">

    expect(selectSessionTabStore({ directory: "/project", sync }) as unknown).toBe(existing)
    expect(peekCalls).toBe(0)
  })

  test("peeks an unpinned store only when no existing directory store is available", () => {
    const created = {}
    let peekInput: { directory?: string; bootstrap?: boolean } = {}
    const sync = {
      existing: () => undefined,
      peek: (directory: string, options: { bootstrap?: boolean }) => {
        peekInput = { directory, bootstrap: options.bootstrap }
        return [created]
      },
    } as unknown as Pick<ServerSync, "existing" | "peek">

    expect(selectSessionTabStore({ directory: "/project", sync }) as unknown).toBe(created)
    expect(peekInput).toEqual({ directory: "/project", bootstrap: false })
  })
})

type TestStore = {
  session_status: Record<string, { type: string } | undefined>
  question: Record<string, boolean | undefined>
  turnCompletion: Record<string, TurnCompletionStatus | undefined>
}

function makeStore(
  overrides: Partial<Pick<TestStore, "session_status" | "question" | "turnCompletion">> = {},
): TestStore {
  return {
    session_status: overrides.session_status ?? {},
    question: overrides.question ?? {},
    turnCompletion: overrides.turnCompletion ?? {},
  }
}

// Mirrors the new direct-read pattern from useSessionTabAvatarState
function computeResolved(store: TestStore, sessionID: string) {
  const status = store.session_status[sessionID]?.type
  return resolveSessionStatus({
    working: sessionIsWorking({ message: {}, part: {} }, sessionID, status),
    question: store.question[sessionID] ?? false,
    status,
    turnCompletion: store.turnCompletion[sessionID],
  })
}

describe("tab avatar status computation per store snapshot", () => {
  test("busy session_status resolves to running", () => {
    const store = makeStore({ session_status: { ses_1: { type: "busy" } } })
    expect(computeResolved(store, "ses_1")).toBe("running")
  })

  test("retry session_status resolves to running", () => {
    const store = makeStore({ session_status: { ses_1: { type: "retry" } } })
    expect(computeResolved(store, "ses_1")).toBe("running")
  })

  test("waiting_for_user resolves to attention before questions hydrate", () => {
    const store = makeStore({ session_status: { ses_1: { type: "waiting_for_user" } } })
    expect(computeResolved(store, "ses_1")).toBe("attention")
  })

  test("open question resolves to attention before a busy session spinner", () => {
    const store = makeStore({
      session_status: { ses_1: { type: "busy" } },
      question: { ses_1: true },
    })
    expect(computeResolved(store, "ses_1")).toBe("attention")
  })

  test("idle + no turnCompletion resolves to undefined (no dot)", () => {
    const store = makeStore()
    expect(computeResolved(store, "ses_1")).toBeUndefined()
  })

  test("idle + done resolves to done (green)", () => {
    const store = makeStore({ turnCompletion: { ses_1: "done" } })
    expect(computeResolved(store, "ses_1")).toBe("done")
  })

  test("idle + incomplete resolves to incomplete (red)", () => {
    const store = makeStore({ turnCompletion: { ses_1: "incomplete" } })
    expect(computeResolved(store, "ses_1")).toBe("incomplete")
  })

  test("idle + unknown hides the non-actionable terminal marker", () => {
    const store = makeStore({ turnCompletion: { ses_1: "unknown" } })
    expect(computeResolved(store, "ses_1")).toBeUndefined()
  })

  test("busy beats stale done marker (running > terminal)", () => {
    const store = makeStore({
      session_status: { ses_1: { type: "busy" } },
      turnCompletion: { ses_1: "done" },
    })
    expect(computeResolved(store, "ses_1")).toBe("running")
  })

})

describe("tab avatar unread presentation", () => {
  test("shows a completed unread session only while it is inactive", () => {
    expect(
      sessionTabUnread({ active: false, hasPermissions: false, hasQuestions: false, notificationUnread: true }),
    ).toBe(true)
    expect(
      sessionTabUnread({ active: true, hasPermissions: false, hasQuestions: false, notificationUnread: true }),
    ).toBe(false)
  })

  test("keeps attention indicators independent from notification unread", () => {
    expect(
      sessionTabUnread({ active: true, hasPermissions: true, hasQuestions: false, notificationUnread: false }),
    ).toBe(true)
    expect(
      sessionTabUnread({ active: true, hasPermissions: false, hasQuestions: true, notificationUnread: false }),
    ).toBe(true)
  })

  test("shows terminal status only for an unread inactive session", () => {
    expect(sessionTabStatus({ active: false, unread: true, hasQuestions: false, resolved: "done" })).toBe("done")
    expect(sessionTabStatus({ active: true, unread: true, hasQuestions: false, resolved: "done" })).toBeUndefined()
    expect(sessionTabStatus({ active: false, unread: false, hasQuestions: false, resolved: "done" })).toBeUndefined()
    expect(sessionTabStatus({ active: true, unread: false, hasQuestions: false, resolved: "running" })).toBeUndefined()
    expect(sessionTabStatus({ active: true, unread: false, hasQuestions: true, resolved: "attention" })).toBe(
      "question",
    )
  })
})

describe("active → away → back lifecycle", () => {
  test("running is stable across tab switches because the store is shared", () => {
    // Simulate the store snapshots as the user switches tabs and comes back.
    // The store never changes during a pure tab switch (no session lifecycle event).

    // Active tab, session running
    const activeRunning = makeStore({ session_status: { ses: { type: "busy" } } })
    expect(computeResolved(activeRunning, "ses")).toBe("running")

    // Away — same store, same status
    expect(computeResolved(activeRunning, "ses")).toBe("running")

    // Back — still running, spinner preserved
    expect(computeResolved(activeRunning, "ses")).toBe("running")
  })

  test("running → done after success (away) → back shows green", () => {
    let store = makeStore({ session_status: { ses: { type: "busy" } } })
    expect(computeResolved(store, "ses")).toBe("running")

    // Completes successfully while away
    store = makeStore({
      session_status: { ses: { type: "idle" } },
      turnCompletion: { ses: "done" },
    })
    expect(computeResolved(store, "ses")).toBe("done")

    // Back — green dot visible
    expect(computeResolved(store, "ses")).toBe("done")
  })

  test("done → resume work → running clears green (stale-clear)", () => {
    // Previous turn done
    let store = makeStore({ turnCompletion: { ses: "done" } })
    expect(computeResolved(store, "ses")).toBe("done")

    // New turn starts — event reducer clears turnCompletion, sets busy
    store = makeStore({ session_status: { ses: { type: "busy" } } })
    expect(computeResolved(store, "ses")).toBe("running")
  })
})

describe("Solid store reactivity compatibility", () => {
  test("setStore updates are visible through direct reads in createStore stores", () => {
    const [store, setStore] = createStore<TestStore>(makeStore())
    // Before
    expect((store.session_status["ses"]?.type ?? "idle") !== "idle").toBe(false)
    // After setStore
    setStore("session_status", "ses", { type: "busy" })
    expect((store.session_status["ses"]?.type ?? "idle") !== "idle").toBe(true)
    // Clean up
    setStore("session_status", "ses", { type: "idle" })
    expect((store.session_status["ses"]?.type ?? "idle") !== "idle").toBe(false)
  })
})

describe("tab avatar lifecycle resolver wiring", () => {
  test("keeps the spinner running after an idle snapshot at the start of a new turn", () => {
    const directory = "/tab-avatar-fresh-activity"
    const sessionID = "ses_fresh_avatar"
    const startedAt = Date.now()
    const store = {
      session_status: { [sessionID]: { type: "busy" } },
      message: {
        [sessionID]: [
          {
            id: "msg_previous",
            role: "assistant",
            finish: "stop",
            time: { created: startedAt - 10_000, completed: startedAt - 5_000 },
          },
        ],
      },
      part: { msg_previous: [{ type: "text" }] },
    } as never
    startSessionActivity(directory, sessionID, "activity_fresh", { timestamp: startedAt })
    try {
      const snapshot = reconcileSessionStatusSnapshot({
        directory,
        sessionID,
        generations: sessionActivityGenerationSnapshot(directory),
        incoming: { type: "idle" },
        store,
      })
      const settled = sessionActivitySettled(directory, sessionID)
      const status = resolveLifecycleStatus({
        activity: sessionActivity(directory, sessionID)?.type,
        activityTracked: latestAssistantCompletedBefore(store, sessionID, sessionActivityStartedAt(directory, sessionID)),
        activitySettled: settled,
        store: snapshot?.type,
        latestAssistantSettled: latestAssistantSettled(store, sessionID),
      })
      expect(
        resolveSessionStatus({ working: sessionIsWorking(store, sessionID, status, settled), question: false, status }),
      ).toBe("running")
    } finally {
      finishSessionActivity(directory, sessionID, "activity_fresh")
    }
  })

  test("clears the spinner when store idle and the latest assistant has finished", () => {
    const messages = {
      message: { ses: [{ id: "msg", role: "assistant" as const, finish: "stop", time: { completed: 1 } }] },
      part: { msg: [{ type: "tool", state: { status: "running" } }] },
    }
    const status = resolveLifecycleStatus({
      activity: "busy",
      store: "idle",
      latestAssistantSettled: latestAssistantSettled(messages, "ses"),
    })
    expect(
      resolveSessionStatus({
        working: sessionIsWorking(messages, "ses", status),
        question: false,
        status,
      }),
    ).toBeUndefined()
  })
})
