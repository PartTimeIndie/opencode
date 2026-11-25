import { expect, test } from "bun:test"
import { createSessionBrowserRuntime } from "./session-browser-runtime"

function runtime() {
  const runtime = createSessionBrowserRuntime("https://example.com/")
  const id = runtime.browserStore.activeTabId
  runtime.setBrowserStore("tabs", id, { url: "https://example.com/", currentURL: "https://example.com/live", request: 7 })
  return { runtime, id }
}

test("moves the last normal tab without replacing its identity or load request", () => {
  const { runtime: state, id } = runtime()
  state.dock(id, "a")
  expect(state.browserStore.docked.a).toBe(id)
  expect(state.browserStore.order).not.toContain(id)
  expect(state.browserStore.order).toHaveLength(1)
  expect(state.browserStore.tabs[state.browserStore.activeTabId]!.url).toBe("")
  expect(state.browserStore.tabs[id]!.request).toBe(7)
  expect(state.browserStore.tabs[id]!.currentURL).toBe("https://example.com/live")
  expect(state.returnToBrowser("a")).toBe(id)
  expect(state.browserStore.activeTabId).toBe(id)
  expect(state.browserStore.tabs[id]!.request).toBe(7)
  expect(state.returnToBrowser("a")).toBeUndefined()
  expect(state.browserStore.order.filter((tab) => tab === id)).toHaveLength(1)
})

test("does not deduplicate a separate normal tab with the same URL", () => {
  const { runtime: state, id } = runtime()
  const tab = state.createTab()
  state.setBrowserStore("tabs", tab.id, { ...tab, url: "https://example.com/", request: 1 })
  state.setBrowserStore("order", (order) => [...order, tab.id])
  state.dock(id, "a")
  expect(state.browserStore.order).toEqual([tab.id])
  expect(state.browserStore.docked.a).toBe(id)
  expect(state.browserStore.tabs[id]!.request).toBe(7)
  expect(state.browserStore.tabs[tab.id]!.request).toBe(1)
})

test("rolls back only its live move and makes repeated rollback harmless", () => {
  const { runtime: state, id } = runtime()
  const undo = state.dock(id, "a")
  const replacement = state.browserStore.activeTabId
  undo()
  undo()
  expect(state.browserStore.order).toEqual([id])
  expect(state.browserStore.activeTabId).toBe(id)
  expect(state.browserStore.tabs[replacement]).toBeUndefined()
  expect(state.browserStore.tabs[id]!.request).toBe(7)
  expect(state.browserStore.docked.a).toBeUndefined()
})

test("rejects disappeared, empty and already owned sources without side effects", () => {
  const { runtime: state, id } = runtime()
  expect(() => state.dock("missing", "a")).toThrow("no longer available")
  state.dock(id, "a")
  expect(() => state.dock(id, "b")).toThrow("no longer available")
  expect(() => state.dock(state.browserStore.activeTabId, "b")).toThrow("no longer available")
  expect(state.browserStore.docked).toEqual({ a: id })
})

test("removal disposes only the selected ownership record exactly once", () => {
  const { runtime: state, id } = runtime()
  state.dock(id, "a")
  const normal = state.browserStore.activeTabId
  expect(state.removeDock("a")).toBe(id)
  expect(state.removeDock("a")).toBeUndefined()
  expect(state.browserStore.tabs[id]).toBeUndefined()
  expect(state.browserStore.tabs[normal]).toBeDefined()
})
