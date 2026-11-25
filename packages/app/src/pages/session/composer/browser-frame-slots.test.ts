import { expect, test } from "bun:test"
import { createBrowserFrameSlots } from "./browser-frame-slots"

test("uses reactive owner visibility, not the size of a hidden pane", () => {
  const slots = createBrowserFrameSlots()
  const element = document.createElement("div")
  document.body.append(element)
  let visible = false
  const dispose = slots.register("dock:a", element, () => visible)
  expect(slots.get("dock:a")).toBeUndefined()
  visible = true
  expect(slots.get("dock:a")).toBe(element)
  element.remove()
  expect(slots.get("dock:a")).toBeUndefined()
  dispose()
})

test("stale cleanup cannot unregister a replacement and owners stay independent", () => {
  const slots = createBrowserFrameSlots()
  const old = document.createElement("div")
  const replacement = document.createElement("div")
  const browser = document.createElement("div")
  document.body.append(old, replacement, browser)
  const stale = slots.register("dock:a", old, () => true)
  const current = slots.register("dock:a", replacement, () => true)
  const other = slots.register("browser", browser, () => true)
  stale()
  expect(slots.get("dock:a")).toBe(replacement)
  expect(slots.get("browser")).toBe(browser)
  current()
  expect(slots.get("dock:a")).toBeUndefined()
  expect(slots.get("browser")).toBe(browser)
  other()
  old.remove()
  replacement.remove()
  browser.remove()
})
