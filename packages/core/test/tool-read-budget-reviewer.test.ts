import { expect, test } from "bun:test"
import { ToolReadBudget } from "@opencode-ai/core/session/runner/tool-read-budget"

test("reviewers without an explicit budget never hit input-only read or poll caps", () => {
  const reviewer = ToolReadBudget.forSession({ reviewer: true, enabled: true })
  for (let index = 0; index < 50; index++) {
    expect(reviewer.check("read", { path: "unchanged" }).exceeded).toBe(false)
    expect(reviewer.check("poll", { command: "unchanged" }).exceeded).toBe(false)
  }
  expect(ToolReadBudget.forSession({ reviewer: true, enabled: true, limits: { read: 1 } }).check("read").exceeded).toBe(false)
  expect(ToolReadBudget.forSession({ reviewer: false, enabled: true }).check("read").exceeded).toBe(false)
})

test("an explicit reviewer tool budget still rejects calls beyond the configured limit", () => {
  const reviewer = ToolReadBudget.forSession({ reviewer: true, enabled: true, limits: { read: 1 } })
  expect(reviewer.check("read", { path: "first" }).exceeded).toBe(false)
  expect(reviewer.check("read", { path: "second" }).exceeded).toBe(true)
})
