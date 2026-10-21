import { describe, expect, test } from "bun:test"
import { compactComposerToolbar } from "./composer-layout"

describe("compactComposerToolbar", () => {
  test("keeps the desktop toolbar when its actual contents fit", () => {
    expect(compactComposerToolbar({ width: 980, required: 900, compact: false })).toBe(false)
  })

  test("moves crowded plugins to overflow even above the mobile width threshold", () => {
    expect(compactComposerToolbar({ width: 980, required: 1200, compact: false })).toBe(true)
  })

  test("holds compact mode until the full toolbar fits with a return margin", () => {
    expect(compactComposerToolbar({ width: 1205, required: 1200, compact: true })).toBe(true)
    expect(compactComposerToolbar({ width: 1212, required: 1200, compact: true })).toBe(false)
  })

  test("keeps the existing narrow-width fallback before contents have been measured", () => {
    expect(compactComposerToolbar({ width: 639, required: 0, compact: false })).toBe(true)
    expect(compactComposerToolbar({ width: 640, required: 0, compact: false })).toBe(false)
  })
})
