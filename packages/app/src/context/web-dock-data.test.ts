import { describe, expect, test } from "bun:test"
import { findWebDockOrphans, readWebDockItems, validateWebDock } from "./web-dock-data"

describe("web dock definitions", () => {
  test("validates names, IDs and safe web addresses", () => {
    expect(validateWebDock({ id: "abc-1", name: " Docs ", startURL: "https://example.com" })).toEqual({ id: "abc-1", name: "Docs", startURL: "https://example.com/" })
    expect(validateWebDock({ id: "abc", name: " ", startURL: "https://example.com" })).toBeUndefined()
    expect(validateWebDock({ id: "abc", name: "Docs", startURL: "https://user:secret@example.com" })).toBeUndefined()
    expect(validateWebDock({ id: "abc", name: "Docs", startURL: "file:///secret" })).toBeUndefined()
  })
  test("rejects control characters and oversized names", () => {
    expect(validateWebDock({ id: "abc", name: "Docs\nHidden", startURL: "https://example.com/" })).toBeUndefined()
    expect(validateWebDock({ id: "abc", name: "a".repeat(101), startURL: "https://example.com/" })).toBeUndefined()
  })
  test("repairs only absent definitions, preserving malformed and future records", () => {
    const bad = { id: "bad", name: "", startURL: "invalid" }
    const panes = ["browser", "plugin:other", "web-dock:bad", "web-dock:missing", "web-dock:missing"]
    expect(findWebDockOrphans({ version: 1, items: { bad } }, panes)).toEqual(["web-dock:missing"])
    expect(findWebDockOrphans({ version: 2, items: {} }, panes)).toEqual([])
  })
  test("isolates bad entries and does not interpret future schemas", () => {
    const good = { id: "good", name: "Good", startURL: "https://example.com/" }
    expect(readWebDockItems({ version: 1, items: { good, bad: { ...good, id: "other" } } })).toEqual([good])
    expect(readWebDockItems({ version: 2, items: { good } })).toEqual([])
  })
})
