import { describe, expect, test } from "bun:test"
import { markdownPreviewHref } from "./markdown-links"

describe("markdown preview destinations", () => {
  test("local Markdown documents only use the desktop file-opening path", () => {
    for (const href of ["file:///C:/notes.md", " FILE:///tmp/notes.markdown#section ", "file:///tmp/notes.md?raw=1"]) {
      expect(markdownPreviewHref(href, "oc://renderer/index.html")).toBe(false)
    }
  })

  test("preserves network and relative Markdown previews", () => {
    for (const href of ["https://example.com/notes.md", "/notes.markdown", "./notes.md?raw=1", "notes.md#section"]) {
      expect(markdownPreviewHref(href, "https://opencode.ai/")).toBe(true)
    }
    expect(markdownPreviewHref("report.pdf", "https://opencode.ai/")).toBe(false)
    expect(markdownPreviewHref("", "https://opencode.ai/")).toBe(false)
    expect(markdownPreviewHref("http://[invalid", "https://opencode.ai/")).toBe(false)
  })

  test("does not advertise unsupported protocols or Windows drive paths", () => {
    for (const href of [
      "javascript:notes.md",
      "data:text/plain,notes.md",
      "C:/notes.md",
      "C:\\notes.md",
      "ftp://example.com/notes.md",
    ]) {
      expect(markdownPreviewHref(href, "https://opencode.ai/")).toBe(false)
    }
  })
})
