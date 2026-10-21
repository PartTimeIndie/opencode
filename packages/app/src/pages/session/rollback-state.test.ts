import { describe, expect, test } from "bun:test"
import { rollbackTimelineBoundary, rollbackUsersBefore } from "./rollback-state"
import { selectVisibleUserMessages } from "./timeline/model"
import type { UserMessage } from "@opencode-ai/sdk/v2"

describe("rollback timeline boundary", () => {
  test("does not blank the timeline when file restoration is blocked", () => {
    expect(rollbackTimelineBoundary({ messageID: "msg_first", status: "blocked" }, "msg_first")).toBeUndefined()
  })

  test("uses the applied server boundary instead of the clicked message", () => {
    expect(rollbackTimelineBoundary({ messageID: "msg_user", status: "reverted" }, "msg_assistant")).toBe("msg_user")
  })

  test("keeps the local boundary during prompt cleanup and clears when unmarked", () => {
    expect(rollbackTimelineBoundary(undefined, "msg_pending_cleanup")).toBe("msg_pending_cleanup")
    expect(rollbackTimelineBoundary(undefined)).toBeUndefined()
  })

  test("keeps 180 mixed-generation turns ordered by time at repeated rollback boundaries", () => {
    const users: UserMessage[] = Array.from({ length: 180 }, (_, index) => ({
      id: `msg_${index === 0 ? "80_legacy" : `06_${180 - index}`}`,
      role: "user",
      sessionID: "ses_long_rollback",
      time: { created: index },
      agent: "build",
      model: { providerID: "test", modelID: "test" },
    }))
    expect(selectVisibleUserMessages(users, users[120]!.id)).toEqual(users.slice(0, 120))
    expect(selectVisibleUserMessages(users, users[80]!.id)).toEqual(users.slice(0, 80))
    expect(selectVisibleUserMessages(users, users[160]!.id)).toEqual(users.slice(0, 160))
    expect(rollbackUsersBefore(users, "msg_missing_older_boundary")).toEqual([])
    const assistantBoundary = { ...users[120]!, id: "msg_00_assistant", time: { created: 120.5 } }
    expect(rollbackUsersBefore(users, assistantBoundary.id, assistantBoundary)).toEqual(users.slice(0, 121))
    expect(rollbackUsersBefore(users)).toBe(users)
  })
})
