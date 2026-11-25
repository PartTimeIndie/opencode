import { expect, test } from "bun:test"
import { reloadBrowserFrame } from "./browser-frame-reload"

test("reloads the live desktop document only after it is ready", () => {
  let reloads = 0
  const frame = { reload: () => { reloads++ } }
  expect(() => reloadBrowserFrame({ mode: "webview", ready: false, frame })).toThrow("still loading")
  expect(reloads).toBe(0)
  reloadBrowserFrame({ mode: "webview", ready: true, frame })
  expect(reloads).toBe(1)
})

test("reloads an accessible iframe without assigning its original source", () => {
  let reloads = 0
  const frame = { contentWindow: { location: { reload: () => { reloads++ } } } }
  reloadBrowserFrame({ mode: "iframe", frame })
  expect(reloads).toBe(1)
})

test("reports unreadable cross-origin live locations instead of silently returning to the start address", () => {
  const frame = { contentWindow: { get location(): never { throw new Error("SecurityError") } } }
  expect(() => reloadBrowserFrame({ mode: "iframe", frame })).toThrow("cannot be reloaded here")
  expect(() => reloadBrowserFrame({ mode: "iframe", frame: { contentWindow: null } })).toThrow("cannot be reloaded here")
})
