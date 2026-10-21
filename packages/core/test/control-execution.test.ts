import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Control } from "../src/control"

describe("surface action execution contract", () => {
  test("command actions default to repeatable when execution is omitted", () => {
    const decoded = Schema.decodeUnknownSync(Control.SurfaceAction)({
      id: "run",
      trigger: { event: "submit" },
      steps: [{ type: "command", command: "bun", arguments: ["run", "x"] }],
    })
    expect(decoded.execution).toBeUndefined()
  })

  test("once execution accepts an optional lock group", () => {
    const decoded = Schema.decodeUnknownSync(Control.SurfaceAction)({
      id: "send",
      trigger: { event: "submit", when: { field: "action", equals: "send" } },
      steps: [{ type: "gmail", mode: "send" }],
      execution: { mode: "once", group: "email-composer.v1:outbound" },
    })
    expect(decoded.execution?.mode).toBe("once")
    expect(decoded.execution?.group).toBe("email-composer.v1:outbound")
  })

  test("GMX delivery locks sibling send and draft actions despite repeatable metadata", () => {
    const send = Schema.decodeUnknownSync(Control.SurfaceAction)({
      id: "send",
      trigger: { event: "submit" },
      steps: [{ type: "gmx", account: "gmx-crisci", mode: "send" }],
      execution: { mode: "repeatable" },
    })
    const draft = Schema.decodeUnknownSync(Control.SurfaceAction)({
      id: "draft",
      trigger: { event: "submit" },
      steps: [{ type: "gmx", account: "gmx-crisci", mode: "draft" }],
    })
    expect(Control.executionModeForAction(send, send.steps)).toBe("once")
    expect(Control.executionGroupForAction(send, "email-composer.v1")).toBe("email-composer.v1:outbound")
    expect(Control.executionGroupForAction(draft, "email-composer.v1")).toBe("email-composer.v1:outbound")
  })

  test("repeatable execution is accepted explicitly", () => {
    const decoded = Schema.decodeUnknownSync(Control.SurfaceAction)({
      id: "preview",
      trigger: { event: "submit" },
      steps: [{ type: "command", command: "bun", arguments: ["preview.ts"] }],
      execution: { mode: "repeatable" },
    })
    expect(decoded.execution?.mode).toBe("repeatable")
  })

  test("once with non-empty group is rejected", () => {
    expect(() =>
      Schema.decodeUnknownSync(Control.SurfaceAction)({
        id: "send",
        trigger: { event: "submit" },
        steps: [{ type: "gmail", mode: "send" }],
        execution: { mode: "once", group: "" },
      }),
    ).toThrow()
  })
})
