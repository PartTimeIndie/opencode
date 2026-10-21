import { describe, expect, test } from "bun:test"
import {
  createTextFragment,
  getCursorPosition,
  getCursorPositionOrNull,
  getNodeLength,
  getTextLength,
  setCursorPosition,
} from "./editor-dom"

describe("prompt-input editor dom", () => {
  test("createTextFragment preserves newlines with consecutive br nodes", () => {
    const fragment = createTextFragment("foo\n\nbar")
    const container = document.createElement("div")
    container.appendChild(fragment)

    expect(container.childNodes.length).toBe(4)
    expect(container.childNodes[0]?.textContent).toBe("foo")
    expect((container.childNodes[1] as HTMLElement).tagName).toBe("BR")
    expect((container.childNodes[2] as HTMLElement).tagName).toBe("BR")
    expect(container.childNodes[3]?.textContent).toBe("bar")
  })

  test("createTextFragment keeps trailing newline as terminal break", () => {
    const fragment = createTextFragment("foo\n")
    const container = document.createElement("div")
    container.appendChild(fragment)

    expect(container.childNodes.length).toBe(2)
    expect(container.childNodes[0]?.textContent).toBe("foo")
    expect((container.childNodes[1] as HTMLElement).tagName).toBe("BR")
  })

  test("createTextFragment avoids break-node explosion for large multiline content", () => {
    const content = Array.from({ length: 220 }, () => "line").join("\n")
    const fragment = createTextFragment(content)
    const container = document.createElement("div")
    container.appendChild(fragment)

    expect(container.childNodes.length).toBe(1)
    expect(container.childNodes[0]?.nodeType).toBe(Node.TEXT_NODE)
    expect(container.textContent).toBe(content)
  })

  test("createTextFragment keeps terminal break in large multiline fallback", () => {
    const content = `${Array.from({ length: 220 }, () => "line").join("\n")}\n`
    const fragment = createTextFragment(content)
    const container = document.createElement("div")
    container.appendChild(fragment)

    expect(container.childNodes.length).toBe(2)
    expect(container.childNodes[0]?.textContent).toBe(content.slice(0, -1))
    expect((container.childNodes[1] as HTMLElement).tagName).toBe("BR")
  })

  test("length helpers treat breaks as one char and ignore zero-width chars", () => {
    const container = document.createElement("div")
    container.appendChild(document.createTextNode("ab\u200B"))
    container.appendChild(document.createElement("br"))
    container.appendChild(document.createTextNode("cd"))

    expect(getNodeLength(container.childNodes[0]!)).toBe(2)
    expect(getNodeLength(container.childNodes[1]!)).toBe(1)
    expect(getTextLength(container)).toBe(5)
  })

  test("setCursorPosition and getCursorPosition round-trip with pills and breaks", () => {
    const container = document.createElement("div")
    const pill = document.createElement("span")
    pill.dataset.type = "file"
    pill.textContent = "@file"
    container.appendChild(document.createTextNode("ab"))
    container.appendChild(pill)
    container.appendChild(document.createElement("br"))
    container.appendChild(document.createTextNode("cd"))
    document.body.appendChild(container)

    setCursorPosition(container, 2)
    expect(getCursorPosition(container)).toBe(2)

    setCursorPosition(container, 7)
    expect(getCursorPosition(container)).toBe(7)

    setCursorPosition(container, 8)
    expect(getCursorPosition(container)).toBe(8)

    container.remove()
  })

  test("setCursorPosition and getCursorPosition round-trip across blank lines", () => {
    const container = document.createElement("div")
    container.appendChild(document.createTextNode("a"))
    container.appendChild(document.createElement("br"))
    container.appendChild(document.createElement("br"))
    container.appendChild(document.createTextNode("b"))
    document.body.appendChild(container)

    setCursorPosition(container, 2)
    expect(getCursorPosition(container)).toBe(2)

    setCursorPosition(container, 3)
    expect(getCursorPosition(container)).toBe(3)

    container.remove()
  })

  test("nullable cursor distinguishes unknown selection from offset zero", () => {
    const container = document.createElement("div")
    const other = document.createElement("div")
    container.textContent = "prompt"
    other.textContent = "outside"
    document.body.append(container, other)

    const range = document.createRange()
    const selection = window.getSelection()
    range.setStart(other.firstChild!, 3)
    range.collapse(true)
    selection?.removeAllRanges()
    selection?.addRange(range)

    expect(getCursorPositionOrNull(container)).toBeNull()
    expect(getCursorPosition(container)).toBe(0)

    selection?.removeAllRanges()
    container.remove()
    other.remove()
  })

  test("setCursorPosition ignores editors removed during navigation", () => {
    const active = document.createElement("div")
    active.textContent = "active"
    document.body.appendChild(active)

    const range = document.createRange()
    const selection = window.getSelection()
    range.setStart(active.firstChild!, 3)
    range.collapse(true)
    selection?.removeAllRanges()
    selection?.addRange(range)

    const removed = document.createElement("div")
    removed.textContent = "draft"
    setCursorPosition(removed, 2)

    expect(selection?.anchorNode).toBe(active.firstChild)
    expect(selection?.anchorOffset).toBe(3)

    selection?.removeAllRanges()
    active.remove()
  })

  test("setCursorPosition and getCursorPositionOrNull round-trip through block wrappers", () => {
    const container = document.createElement("div")
    const first = document.createElement("div")
    const second = document.createElement("p")
    first.textContent = "hello"
    second.textContent = "world"
    container.append(first, second)
    document.body.appendChild(container)

    expect(getTextLength(container)).toBe(11)

    setCursorPosition(container, 7)
    expect(getCursorPositionOrNull(container)).toBe(7)
    expect(window.getSelection()?.anchorNode).toBe(second.firstChild)
    expect(window.getSelection()?.anchorOffset).toBe(1)

    setCursorPosition(container, 5)
    expect(getCursorPositionOrNull(container)).toBe(5)
    expect(window.getSelection()?.anchorNode).toBe(first.firstChild)
    expect(window.getSelection()?.anchorOffset).toBe(5)

    window.getSelection()?.removeAllRanges()
    container.remove()
  })

  test("block wrapper placeholder breaks do not add extra cursor length", () => {
    const container = document.createElement("div")
    const first = document.createElement("div")
    const blank = document.createElement("div")
    const second = document.createElement("div")
    first.textContent = "foo"
    blank.appendChild(document.createElement("br"))
    second.textContent = "bar"
    container.append(first, blank, second)
    document.body.appendChild(container)

    expect(getTextLength(container)).toBe("foo\n\nbar".length)

    setCursorPosition(container, 5)
    expect(getCursorPositionOrNull(container)).toBe(5)
    expect(window.getSelection()?.anchorNode).toBe(second.firstChild)
    expect(window.getSelection()?.anchorOffset).toBe(0)

    window.getSelection()?.removeAllRanges()
    container.remove()
  })
})
