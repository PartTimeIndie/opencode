import { expect, test } from "bun:test"
import { closeToTray, showFromTray } from "./tray-lifecycle"

test("close hides only when a usable tray exists and no quit is underway", () => {
  for (const available of [false, true]) {
    for (const quitting of [false, true]) {
      const calls: string[] = []
      expect(closeToTray({ available, quitting, preventDefault: () => calls.push("prevent"), hide: () => calls.push("hide") }))
        .toBe(available && !quitting)
      expect(calls).toEqual(available && !quitting ? ["prevent", "hide"] : [])
    }
  }
})

test("tray and secondary launch restore a minimized window before focusing", () => {
  const calls: string[] = []
  const window = {
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: () => calls.push("restore"),
    show: () => calls.push("show"),
    focus: () => calls.push("focus"),
  }
  showFromTray(window)
  expect(calls).toEqual(["restore", "show", "focus"])
  calls.length = 0
  showFromTray({ ...window, isDestroyed: () => true })
  showFromTray(null)
  expect(calls).toEqual([])
})
