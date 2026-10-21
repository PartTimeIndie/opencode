import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test"

const html = await Bun.file(new URL("../../desktop/src/renderer/index.html", import.meta.url)).text()
const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1]
if (!script) throw new Error("Desktop startup recovery script missing")

beforeEach(() => {
  vi.useFakeTimers()
  document.body.innerHTML = html.slice(html.indexOf('<div id="desktop-startup"'), html.indexOf('<div id="root"'))
  Function(script)()
})

afterEach(() => {
  window.dispatchEvent(new Event("opencode:renderer-mounted"))
  vi.useRealTimers()
  document.body.innerHTML = ""
})

describe("desktop startup before the application bundle", () => {
  test("shows a visible loading surface before the renderer mounts", () => {
    expect(document.getElementById("desktop-startup")?.textContent).toContain("OpenCode")
    expect(document.getElementById("desktop-startup-retry")?.hidden).toBe(true)
  })

  test("offers recovery when the entry module fails to load", () => {
    const entry = document.createElement("script")
    entry.type = "module"
    document.body.append(entry)
    entry.dispatchEvent(new Event("error"))
    expect(document.getElementById("desktop-startup-retry")?.hidden).toBe(false)
    expect(document.getElementById("desktop-startup-message")?.textContent).toContain("could not start")
  })

  test("offers recovery for a startup exception", () => {
    window.dispatchEvent(new ErrorEvent("error", { message: "bundle evaluation failed" }))
    expect(document.getElementById("desktop-startup-retry")?.hidden).toBe(false)
  })

  test("offers recovery for a rejected startup promise independently", () => {
    expect(document.getElementById("desktop-startup-retry")?.hidden).toBe(true)
    window.dispatchEvent(new Event("unhandledrejection"))
    expect(document.getElementById("desktop-startup-retry")?.hidden).toBe(false)
    expect(document.getElementById("desktop-startup-message")?.textContent).toContain("could not start")
  })

  test("offers reload at the timeout", () => {
    vi.advanceTimersByTime(14999)
    expect(document.getElementById("desktop-startup-retry")?.hidden).toBe(true)
    vi.advanceTimersByTime(1)
    expect(document.getElementById("desktop-startup-retry")?.hidden).toBe(false)
    expect(document.getElementById("desktop-startup-message")?.textContent).toContain("longer than expected")
  })

  test("cancels the delayed-start message on failure or successful mount", () => {
    window.dispatchEvent(new ErrorEvent("error", { message: "startup failed" }))
    vi.advanceTimersByTime(15000)
    expect(document.getElementById("desktop-startup-message")?.textContent).toContain("could not start")
    window.dispatchEvent(new Event("opencode:renderer-mounted"))
    expect(vi.getTimerCount()).toBe(0)
  })

  test("ignores failed images and removes recovery after mount", () => {
    const message = document.getElementById("desktop-startup-message")
    const text = message?.textContent
    const image = document.createElement("img")
    document.body.append(image)
    image.dispatchEvent(new Event("error"))
    expect(document.getElementById("desktop-startup-retry")?.hidden).toBe(true)
    window.dispatchEvent(new Event("opencode:renderer-mounted"))
    vi.advanceTimersByTime(15000)
    expect(message?.textContent).toBe(text)
    expect(document.getElementById("desktop-startup")).toBeNull()
    window.dispatchEvent(new Event("unhandledrejection"))
    expect(document.getElementById("desktop-startup")).toBeNull()
  })
})
