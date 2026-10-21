import { describe, expect, test } from "bun:test"
import { verifyBrowserControlBundle } from "./verify-browser-control-bundle"

const directBundle = 'webContents.fromId(id); contents.executeJavaScript(code); "browser.snapshot"'

describe("verifyBrowserControlBundle", () => {
  test("accepts the exact Electron webContents contract", () => {
    expect(() => verifyBrowserControlBundle([directBundle])).not.toThrow()
  })

  test("rejects a bundle that regresses to Playwright or chromium-bidi", () => {
    expect(() => verifyBrowserControlBundle([`${directBundle}; import("playwright-core")`])).toThrow("Playwright")
    expect(() => verifyBrowserControlBundle([`${directBundle}; import "chromium-bidi"`])).toThrow("chromium-bidi")
  })

  test("rejects a bundle missing the direct execution path", () => {
    expect(() => verifyBrowserControlBundle(['"browser.snapshot"'])).toThrow("exact Electron webContents")
    expect(() => verifyBrowserControlBundle(["webContents.fromId(id); browser.snapshot"])).toThrow("direct webContents execution")
  })
})
