import { describe, expect, test } from "bun:test"
import { hasActiveSessionTool, resolveSessionStatus, sessionIsWorking } from "./session-status"

// Regression (opencode.log 2026-09-02, ses_062f6d9ba001t9CjobRNBwY8VA): a bash
// tool call blocked on a manual permission prompt kept its running tool part,
// so a non-focused session looked like a hung shell. A pending permission must
// resolve the session to "attention" (waiting on the user) instead of
// "running", which is what the tab avatars, sidebar rows, and the Session
// Navigator dock derive their indicator from.
describe("resolveSessionStatus with pending permission", () => {
  test("a working session with a pending permission waits on the user, not on a shell", () => {
    expect(resolveSessionStatus({ working: true, question: false, permission: true, turnCompletion: undefined })).toBe(
      "attention",
    )
  })

  test("permission outranks a terminal lifecycle snapshot exactly like an open question", () => {
    expect(resolveSessionStatus({ working: false, question: false, permission: true, status: "idle", turnCompletion: "done" })).toBe(
      "attention",
    )
    expect(resolveSessionStatus({ working: false, question: false, permission: false, status: "idle", turnCompletion: "done" })).toBe(
      "done",
    )
  })

  test("question and permission combined still wait on the user", () => {
    expect(resolveSessionStatus({ working: true, question: true, permission: true, turnCompletion: "done" })).toBe("attention")
  })

  test("without a pending permission the running signal is unchanged", () => {
    expect(resolveSessionStatus({ working: true, question: false, permission: false, turnCompletion: undefined })).toBe("running")
    expect(resolveSessionStatus({ working: true, question: false, turnCompletion: undefined })).toBe("running")
  })

  test("a permission without other activity also waits on the user", () => {
    expect(resolveSessionStatus({ working: false, question: false, permission: true, turnCompletion: undefined })).toBe("attention")
  })
})

// The spinner source itself stays intact: the blocked bash part is still a
// running tool part, so `working` remains true and only the explicit
// permission flag flips the presentation to attention.
describe("tool activity while a permission is pending", () => {
  const store = {
    message: { ses_a: [{ id: "msg_1", role: "assistant" }] },
    part: { msg_1: [{ type: "tool", state: { status: "running" } }] },
  }

  test("the blocked tool part still counts as active session tool", () => {
    expect(hasActiveSessionTool(store, "ses_a")).toBe(true)
    expect(sessionIsWorking(store, "ses_a", "idle")).toBe(true)
  })

  test("waiting_for_user lifecycle still suppresses the working signal", () => {
    expect(sessionIsWorking(store, "ses_a", "waiting_for_user")).toBe(false)
  })
})
