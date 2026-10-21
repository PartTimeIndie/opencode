import { expect, test } from "bun:test"
import { parseDesktopAccelerator } from "./desktop-accelerator"

test("preserves Electron single shortcuts and normalizes supported double taps", () => {
  expect(parseDesktopAccelerator("Ctrl+Shift+Space")).toEqual({ kind: "single", accelerator: "Ctrl+Shift+Space" })
  expect(parseDesktopAccelerator("Ctrl+C Ctrl+C")).toEqual({ kind: "double-tap", id: "1:67", key: 67, modifiers: 1 })
  expect(parseDesktopAccelerator("Control+Shift+F12 Shift+Ctrl+F12")).toEqual({ kind: "double-tap", id: "5:123", key: 123, modifiers: 5 })
  expect(parseDesktopAccelerator("Meta+Enter Super+Return")).toEqual({ kind: "double-tap", id: "8:13", key: 13, modifiers: 8 })
})

test("rejects unequal, unsupported, bare, and ambiguous double taps", () => {
  for (const value of ["", "Ctrl+C Ctrl+V", "C C", "Ctrl+C Ctrl+C Ctrl+C", "Ctrl+Ctrl+C Ctrl+C", "Ctrl+Unknown Ctrl+Unknown", "Ctrl++ Ctrl++", "Ctrl+Alt Ctrl+Alt", "Ctrl + C Ctrl + C"])
    expect(parseDesktopAccelerator(value)).toBeUndefined()
})
