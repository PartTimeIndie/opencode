import { describe, expect, test, vi } from "bun:test"
import {
  applyRichTextLink,
  captureRichTextSelection,
  restoreRichTextSelection,
  safeRichTextHref,
} from "./session-question-rich-text"

function rejectBrowserPrompt() {
  const original = globalThis.prompt
  globalThis.prompt = () => {
    throw new Error("browser prompt must not be used")
  }
  return () => {
    globalThis.prompt = original
  }
}

describe("rich text link dialog behavior", () => {
  test("applies a safe URL to the captured editor selection without a browser prompt", async () => {
    const restorePrompt = rejectBrowserPrompt()
    const input = document.createElement("div")
    input.contentEditable = "true"
    input.textContent = "selected text"
    document.body.append(input)
    const range = document.createRange()
    range.setStart(input.firstChild!, 0)
    range.setEnd(input.firstChild!, 8)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    const captured = captureRichTextSelection(input)
    const exec = vi.fn(() => true)

    try {
      expect(applyRichTextLink(input, captured, " https://example.test/path ", exec)).toBe(true)
      expect(exec).toHaveBeenCalledWith("createLink", false, " https://example.test/path ")
      expect(selection.toString()).toBe("selected")
      expect(document.activeElement).toBe(input)
      const source = await Bun.file(new URL("./session-question-dock.tsx", import.meta.url)).text()
      expect(source).not.toContain("window.prompt")
    } finally {
      input.remove()
      restorePrompt()
    }
  })

  test("treats cancel and unsafe URLs as no-ops", () => {
    const restorePrompt = rejectBrowserPrompt()
    const input = document.createElement("div")
    const exec = vi.fn(() => true)

    try {
      expect(safeRichTextHref(undefined)).toBeUndefined()
      expect(safeRichTextHref("javascript:alert(1)")).toBeUndefined()
      expect(applyRichTextLink(input, undefined, undefined, exec)).toBe(false)
      expect(applyRichTextLink(input, undefined, "   ", exec)).toBe(false)
      expect(applyRichTextLink(input, undefined, "javascript:alert(1)", exec)).toBe(false)
      expect(exec).not.toHaveBeenCalled()
    } finally {
      restorePrompt()
    }
  })

  test("restores the captured range when the dialog is cancelled", () => {
    const input = document.createElement("div")
    input.textContent = "keep selection"
    document.body.append(input)
    const range = document.createRange()
    range.selectNodeContents(input)
    const other = document.createElement("button")
    document.body.append(other)
    other.focus()

    try {
      restoreRichTextSelection(input, range)
      expect(document.activeElement).toBe(input)
      expect(window.getSelection()?.toString()).toBe("keep selection")
    } finally {
      input.remove()
      other.remove()
    }
  })
})
