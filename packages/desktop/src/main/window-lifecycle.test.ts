import { describe, expect, test } from "bun:test"
import { liveWindow } from "./window-lifecycle"

describe("desktop window lifecycle", () => {
  test("rejects windows whose BrowserWindow or WebContents has been destroyed", () => {
    const active = createWindow(false, false)

    expect(liveWindow(active)).toBe(active)
    expect(liveWindow(createWindow(true, false))).toBeNull()
    expect(liveWindow(createWindow(false, true))).toBeNull()
  })
})

function createWindow(windowDestroyed: boolean, contentsDestroyed: boolean) {
  return {
    isDestroyed: () => windowDestroyed,
    webContents: { isDestroyed: () => contentsDestroyed },
  } as never
}
