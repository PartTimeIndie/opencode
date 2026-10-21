import { beforeEach, describe, expect, test } from "bun:test"
import { captureFocusedTextInput } from "./focused-text-input"

beforeEach(() => {
  document.body.replaceChildren()
})

describe("captureFocusedTextInput", () => {
  test("inserts at the captured input selection and dispatches input", () => {
    const input = document.createElement("input")
    input.value = "hello world"
    document.body.append(input)
    input.focus()
    input.setSelectionRange(6, 11)
    let events = 0
    input.addEventListener("input", () => events++)

    const target = captureFocusedTextInput()
    expect(target?.insertText("OpenCode")).toEqual({ ok: true })
    expect(input.value).toBe("hello OpenCode")
    expect(events).toBe(1)
  })

  test("inserts into a captured textarea without stealing later focus", () => {
    const textarea = document.createElement("textarea")
    const other = document.createElement("input")
    textarea.value = "before after"
    document.body.append(textarea, other)
    textarea.focus()
    textarea.setSelectionRange(7, 7)
    const target = captureFocusedTextInput()
    other.focus()

    expect(target?.insertText("speech ")).toEqual({ ok: true })
    expect(textarea.value).toBe("before speech after")
    expect(document.activeElement).toBe(other)
  })

  test("supports contenteditable selections", () => {
    const editor = document.createElement("div")
    editor.contentEditable = "true"
    editor.textContent = "hello world"
    document.body.append(editor)
    editor.focus()
    const range = document.createRange()
    range.setStart(editor.firstChild!, 6)
    range.setEnd(editor.firstChild!, 11)
    document.getSelection()?.removeAllRanges()
    document.getSelection()?.addRange(range)

    const target = captureFocusedTextInput()
    expect(target?.insertText("OpenCode")).toEqual({ ok: true })
    expect(editor.textContent).toBe("hello OpenCode")
  })

  test("finds text fields through shadow roots", () => {
    const host = document.createElement("div")
    const shadow = host.attachShadow({ mode: "open" })
    const input = document.createElement("input")
    shadow.append(input)
    document.body.append(host)
    input.focus()

    expect(captureFocusedTextInput()?.insertText("shadow")).toEqual({ ok: true })
    expect(input.value).toBe("shadow")
  })

  test("skips Composer fields", () => {
    const composer = document.createElement("div")
    composer.dataset.component = "prompt-input"
    const input = document.createElement("textarea")
    composer.append(input)
    document.body.append(composer)
    input.focus()

    expect(captureFocusedTextInput()).toBeUndefined()
  })

  test("rejects readonly and disconnected targets", () => {
    const input = document.createElement("input")
    document.body.append(input)
    input.focus()
    const readonly = captureFocusedTextInput()
    input.readOnly = true
    expect(readonly?.insertText("no")).toEqual({ ok: false, error: "The focused text field is not editable" })

    input.readOnly = false
    const disconnected = captureFocusedTextInput()
    input.remove()
    expect(disconnected?.insertText("no")).toEqual({
      ok: false,
      error: "The focused text field is no longer available",
    })
  })
})
