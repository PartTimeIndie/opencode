import { afterEach, describe, expect, test } from "bun:test"
import { createDesktopTestingSnapshot, installDesktopTestingDebugCapture } from "./snapshot"

describe("desktop testing snapshot", () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  test("captures text, layout hints, focus and redacted console entries", () => {
    document.documentElement.dataset.theme = "oc-2"
    document.head.insertAdjacentHTML("beforeend", `<style id="oc-theme">:root { color-scheme: dark; }</style>`)
    document.body.innerHTML = `
      <svg id="opencode-icon-sprite"><symbol id="large-icon"></symbol></svg>
      <div id="root"><button data-component="test-action" aria-label="Run test">Run</button></div>
    `
    const button = document.querySelector("button")!
    button.focus()

    installDesktopTestingDebugCapture()
    window.dispatchEvent(new ErrorEvent("error", { message: "authorization=secret-token" }))

    const snapshot = createDesktopTestingSnapshot()

    expect(snapshot.text).toContain("Run")
    expect(snapshot.dom).toContain("test-action")
    expect(snapshot.dom).not.toContain("opencode-icon-sprite")
    expect(snapshot.theme.dataset.theme).toBe("oc-2")
    expect(snapshot.theme.stylePresent).toBe(true)
    expect(snapshot.layout.some((item) => item.label === "Run test")).toBe(true)
    expect(snapshot.focusedElement?.label).toBe("Run test")
    expect(snapshot.console.at(-1)?.message).toContain("authorization=<redacted>")
  })

  test("captures the error stack and build identity for uncaught renderer errors", () => {
    const thrown = new Error("Cannot read properties of undefined")
    thrown.stack = "Error: Cannot read properties of undefined\n    at throwSite (chunk-abc.js:1:2)"

    installDesktopTestingDebugCapture()
    window.dispatchEvent(new ErrorEvent("error", { message: "Uncaught TypeError: boom", error: thrown }))

    const snapshot = createDesktopTestingSnapshot()
    const entry = snapshot.console.at(-1)
    expect(entry?.level).toBe("error")
    expect(entry?.message).toContain("Uncaught TypeError: boom")
    expect(entry?.message).toContain("at throwSite (chunk-abc.js:1:2)")
    expect(snapshot.build.userAgent.length).toBeGreaterThan(0)
  })
})
