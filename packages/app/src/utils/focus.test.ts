import { afterEach, describe, expect, test } from "bun:test"
import { canFocusWithoutStealing, focusDockPromptInputForSession, focusWithoutStealing } from "./focus"

const documentHasFocus = (value: boolean) => {
  Object.defineProperty(document, "hasFocus", {
    configurable: true,
    value: () => value,
  })
}

afterEach(() => {
  document.body.innerHTML = ""
})

describe("focusWithoutStealing", () => {
  test("focuses when the app is focused and no element owns focus", () => {
    documentHasFocus(true)
    document.body.innerHTML = `<button id="target"></button>`
    const target = document.getElementById("target") as HTMLElement

    expect(focusWithoutStealing(target)).toBe(true)
    expect(document.activeElement).toBe(target)
  })

  test("preserves focus owned by another element", () => {
    documentHasFocus(true)
    document.body.innerHTML = `<input id="active" /><button id="target"></button>`
    const active = document.getElementById("active") as HTMLElement
    const target = document.getElementById("target") as HTMLElement
    active.focus()

    expect(focusWithoutStealing(target)).toBe(false)
    expect(document.activeElement).toBe(active)
  })

  test("allows focus inside the same scope", () => {
    documentHasFocus(true)
    document.body.innerHTML = `<div id="scope"><input id="active" /></div>`
    const scope = document.getElementById("scope") as HTMLElement
    const active = document.getElementById("active") as HTMLElement
    active.focus()

    expect(canFocusWithoutStealing(scope)).toBe(true)
  })

  test("does not refocus when the element already owns focus", () => {
    documentHasFocus(true)
    document.body.innerHTML = `<button id="target"></button>`
    const target = document.getElementById("target") as HTMLElement
    target.focus()
    let calls = 0
    target.focus = () => {
      calls += 1
    }

    expect(focusWithoutStealing(target)).toBe(true)
    expect(calls).toBe(0)
  })

  test("does not refocus when a child already owns focus", () => {
    documentHasFocus(true)
    document.body.innerHTML = `<div id="target"><input id="active" /></div>`
    const target = document.getElementById("target") as HTMLElement
    const active = document.getElementById("active") as HTMLElement
    active.focus()
    let calls = 0
    target.focus = () => {
      calls += 1
    }

    expect(focusWithoutStealing(target)).toBe(true)
    expect(document.activeElement).toBe(active)
    expect(calls).toBe(0)
  })

  test("does not focus when the app window is not focused", () => {
    documentHasFocus(false)
    document.body.innerHTML = `<button id="target"></button>`
    const target = document.getElementById("target") as HTMLElement

    expect(focusWithoutStealing(target)).toBe(false)
    expect(document.activeElement).not.toBe(target)
  })

  test("focuses without moving scroll position", () => {
    documentHasFocus(true)
    document.body.innerHTML = `<button id="target"></button>`
    const target = document.getElementById("target") as HTMLElement
    const focus = target.focus.bind(target)
    let options: FocusOptions | undefined
    target.focus = (value?: FocusOptions) => {
      options = value
      focus(value)
    }

    expect(focusWithoutStealing(target)).toBe(true)
    expect(options).toEqual({ preventScroll: true })
  })

  test("dock activation does not steal focus from an open picker", async () => {
    documentHasFocus(true)
    document.body.innerHTML = `
      <div data-dock-area="middle">
        <div data-dock-tab data-session-id="ses_mobile">
          <button role="tab" aria-selected="true"></button>
        </div>
        <div data-component="prompt-input" tabindex="0"></div>
      </div>
      <input id="model-search" />
    `
    const search = document.getElementById("model-search") as HTMLInputElement
    search.focus()

    focusDockPromptInputForSession("ses_mobile")
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(document.activeElement).toBe(search)
  })

  test("forced dock activation restores focus after the prompt node is replaced", async () => {
    documentHasFocus(true)
    document.body.innerHTML = `
      <div data-dock-area="middle">
        <div data-dock-tab data-session-id="ses_branch">
          <button role="tab" aria-selected="true"></button>
        </div>
        <div data-component="prompt-input" data-session-id="ses_branch" tabindex="0"></div>
      </div>
      <button id="message-action"></button>
    `
    const action = document.getElementById("message-action") as HTMLElement
    action.focus()

    focusDockPromptInputForSession("ses_branch", 1, true)
    await new Promise((resolve) => setTimeout(resolve, 35))

    const oldPrompt = document.querySelector('[data-component="prompt-input"]') as HTMLElement
    const replacement = oldPrompt.cloneNode(true) as HTMLElement
    oldPrompt.replaceWith(replacement)
    await new Promise((resolve) => setTimeout(resolve, 75))

    expect(document.activeElement).toBe(replacement)
  })
})
