import { describe, expect, test } from "bun:test"
import { localFileHref } from "./markdown-sanitize"

// The full DOM contracts are preserved in local-file-links.spec.ts under Chromium.
// Happy DOM does not faithfully implement DOMPurify's attribute-removal behavior.
describe("local file anchor policy", () => {
  test("preserves local Windows and POSIX file destinations", () => {
    expect(localFileHref("file:///C:/Projects/example/docs/sample-report.pdf")).toBe(
      "file:///C:/Projects/example/docs/sample-report.pdf",
    )
    expect(localFileHref("file:///tmp/report.pdf")).toBe("file:///tmp/report.pdf")
    expect(localFileHref("FILE:///C:/My Documents/report.pdf#page=2")).toBe(
      "file:///C:/My%20Documents/report.pdf#page=2",
    )
  })

  test("does not decode filename characters into URL delimiters", () => {
    const href = "file:///C:/Meine%20Dateien/Pr%C3%BCfung%23%25.pdf#page=2"
    expect(localFileHref(href)).toBe(href)
  })

  test("rejects scripts, data, remote files, controls and ordinary navigation", () => {
    for (const value of [
      "javascript:alert(1)",
      "data:text/html,unsafe",
      "file://server/share/report.pdf",
      "file:////server/share/report.pdf",
      "file:///C:/report\n.pdf",
      "https://opencode.ai",
      "/session/example",
      "invalid",
    ])
      expect(localFileHref(value)).toBeUndefined()
  })
})
