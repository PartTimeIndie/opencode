import { expect, test } from "bun:test"
import { navigateBrowserDock, returnBrowserDock, removeBrowserDock } from "./session-browser-dock"
import type { Platform } from "@/context/platform"

const platform: Platform = { platform: "web", openLink() {}, async restart() {}, back() {}, forward() {}, async notify() {} }

test("returning an unloaded definition refuses success, while explicit removal is safe", async () => {
  await expect(returnBrowserDock("unloaded", platform)).rejects.toThrow("not loaded")
  await expect(removeBrowserDock("unloaded", platform)).resolves.toBeUndefined()
})

test("an unloaded dock accepts a valid next start address without creating a live page", () => {
  expect(() => navigateBrowserDock("unloaded", "https://example.com/next")).not.toThrow()
  expect(() => navigateBrowserDock("unloaded", "javascript:alert(1)")).toThrow("HTTP(S)")
})
