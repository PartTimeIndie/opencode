import { expect, test } from "bun:test"
import { MAXIMUM_CLIPBOARD_TEXT_LENGTH, isOwningWindowSender, writeClipboardText } from "./clipboard-text"

test("clipboard text writes validate the value and report native failures", () => {
  const writes: string[] = []
  const write = (text: string) => {
    writes.push(text)
  }
  expect(writeClipboardText("", write)).toEqual({ ok: false, error: "The clipboard text is empty." })
  expect(writeClipboardText(42, write)).toEqual({ ok: false, error: "The clipboard text is empty." })
  expect(writeClipboardText("x".repeat(MAXIMUM_CLIPBOARD_TEXT_LENGTH + 1), write)).toEqual({ ok: false, error: "The clipboard text is too large." })
  expect(writeClipboardText("dictation ü", write)).toEqual({ ok: true })
  expect(writes).toEqual(["dictation ü"])
  expect(writeClipboardText("dictation", () => { throw new Error("clipboard busy") })).toEqual({ ok: false, error: "clipboard busy" })
})

test("only a window's own main frame may request clipboard writes", () => {
  const main = {}
  const child = {}
  expect(isOwningWindowSender({ senderFrame: main, mainFrame: main, getType: () => "window" })).toBe(true)
  expect(isOwningWindowSender({ senderFrame: child, mainFrame: main, getType: () => "window" })).toBe(false)
  expect(isOwningWindowSender({ senderFrame: undefined, mainFrame: main, getType: () => "window" })).toBe(false)
  expect(isOwningWindowSender({ senderFrame: null, mainFrame: null, getType: () => "browser" })).toBe(false)
  expect(isOwningWindowSender({ senderFrame: main, mainFrame: main, getType: () => "webview" })).toBe(false)
})
