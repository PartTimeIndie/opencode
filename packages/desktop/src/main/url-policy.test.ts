import { describe, expect, test } from "bun:test"
import { isAllowedBrowserUrl, isAllowedExternalUrl } from "./url-policy"

describe("isAllowedBrowserUrl", () => {
  test("keeps browser navigation limited to http and https", () => {
    expect(isAllowedBrowserUrl("https://opencode.ai")).toBe(true)
    expect(isAllowedBrowserUrl("obsidian://open?vault=Notes")).toBe(false)
  })

  test("allows Obsidian only for trusted explicit external-link IPC", () => {
    expect(isAllowedExternalUrl("https://opencode.ai")).toBe(true)
    expect(isAllowedExternalUrl("obsidian://open?vault=Notes")).toBe(true)
  })

  test("rejects dangerous or unrelated schemes", () => {
    expect(isAllowedBrowserUrl("javascript:alert(1)")).toBe(false)
    expect(isAllowedBrowserUrl("file:///secret.txt")).toBe(false)
    expect(isAllowedExternalUrl("javascript:alert(1)")).toBe(false)
    expect(isAllowedExternalUrl("file:///secret.txt")).toBe(false)
  })
})
