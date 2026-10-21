import { describe, expect, test } from "bun:test"
import { messageIdFromHash } from "./message-id-from-hash"
import { createHashNavigationGate } from "./hash-navigation"

describe("messageIdFromHash", () => {
  test("parses hash with leading #", () => {
    expect(messageIdFromHash("#message-abc123")).toBe("abc123")
  })

  test("parses raw hash fragment", () => {
    expect(messageIdFromHash("message-42")).toBe("42")
  })

  test("ignores non-message anchors", () => {
    expect(messageIdFromHash("#review-panel")).toBeUndefined()
  })
})

describe("hash navigation gate", () => {
  test("applies the initial bottom anchor once per session", () => {
    const gate = createHashNavigationGate()
    expect(gate.shouldApply("", "ses-one")).toBe(true)
    expect(gate.shouldApply("", "ses-one")).toBe(false)
    expect(gate.shouldApply("", "ses-two")).toBe(true)
  })

  test("reapplies explicit hash targets while ignoring same-session ready flips without a hash", () => {
    const gate = createHashNavigationGate()
    expect(gate.shouldApply("#message-abc123", "ses-one")).toBe(true)
    expect(gate.shouldApply("#message-abc123", "ses-one")).toBe(true)
    expect(gate.shouldApply("", "ses-one")).toBe(false)
  })
})
