import { afterEach, describe, expect, test } from "bun:test"
import { createFloatingHost } from "./floating"

afterEach(() => { window.dispatchEvent(new Event("pagehide")); document.body.replaceChildren(); localStorage.clear() })

describe("nonmodal floating plugin host", () => {
  function fixture() {
    const listeners = new Set<(navigation: { directory?: string; sessionID?: string }) => void>()
    const cleanups: Array<() => void> = []
    const host = createFloatingHost({
      authorized: () => true,
      track: (dispose) => { cleanups.push(dispose); return dispose },
      subscribe: (handler) => { listeners.add(handler); return () => { listeners.delete(handler) } },
    })
    return { host, listeners, cleanups, navigate(sessionID: string) { listeners.forEach((fn) => fn({ directory: "/project", sessionID })) } }
  }
  const scope = { directory: "/project", ids: ["worker", "voice"] }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  test("does not capture focus, block the page or remount on navigation within the session pair", async () => {
    const f = fixture()
    const composer = document.createElement("input")
    document.body.append(composer)
    composer.focus()
    const mounts: AbortSignal[] = []
    const options = { id: "voice", title: "Voice", sessions: scope, mount: (ctx: { signal: AbortSignal }) => { mounts.push(ctx.signal) } }
    const handle = f.host.open(options)
    await settle()
    expect(document.activeElement).toBe(composer)
    expect(document.querySelector('[data-component="app-plugin-overlay"]')).toBeNull()
    expect(document.querySelector('[data-component="app-plugin-floating"]')?.getAttribute("aria-modal")).toBe("false")
    expect(document.querySelector<HTMLElement>('[data-component="app-plugin-floating"]')?.style.top).toBe("96px")
    composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    f.navigate("voice")
    f.navigate("worker")
    expect(f.host.open(options)).toBe(handle)
    expect(mounts).toHaveLength(1)
    expect(mounts[0].aborted).toBe(false)
    composer.value = "Normal draft remains editable"
    expect(composer.value).toBe("Normal draft remains editable")
    f.navigate("unrelated")
    expect(mounts[0].aborted).toBe(false)
    expect(document.querySelector('[data-component="app-plugin-floating"]')).not.toBeNull()
    f.listeners.forEach((fn) => fn({ sessionID: "worker" }))
    expect(mounts[0].aborted).toBe(false)
    expect(document.querySelector('[data-component="app-plugin-floating"]')).not.toBeNull()
    f.listeners.forEach((fn) => fn({}))
    expect(mounts[0].aborted).toBe(true)
    expect(mounts[0].reason.name).toBe("AbortError")
    expect(mounts[0].reason.stack).toBe("")
    expect(document.querySelector('[data-component="app-plugin-floating"]')).toBeNull()
  })

  test("drags, clamps, restores and resets a persisted panel position", async () => {
    const f = fixture(); f.host.open({ id: "voice", title: "Voice", sessions: scope, mount() {} }); await settle()
    const panel = document.querySelector<HTMLElement>('[data-component="app-plugin-floating"]')!; const header = panel.querySelector("header")!
    panel.getBoundingClientRect = () => ({ x: 844, y: 96, left: 844, top: 96, right: 1264, bottom: 396, width: 420, height: 300, toJSON() {} })
    const pointer = (type: string, x: number, y: number) => { const event = new Event(type, { bubbles: true }); Object.assign(event, { button: 0, pointerId: 1, clientX: x, clientY: y }); header.dispatchEvent(event) }
    pointer("pointerdown", 900, 120); pointer("pointermove", 700, 200); pointer("pointerup", 700, 200)
    const clampedX = window.innerWidth - 420 - 8
    expect(panel.style.left).toBe(`${clampedX}px`); expect(panel.style.top).toBe("176px")
    expect(JSON.parse(localStorage.getItem("opencode.app-plugin-floating.position.v1:voice")!)).toEqual({ x: clampedX, y: 176 })
    window.dispatchEvent(new Event("pagehide")); f.host.open({ id: "voice", title: "Voice", sessions: scope, mount() {} }); await settle()
    const restored = document.querySelector<HTMLElement>('[data-component="app-plugin-floating"]')!; expect(restored.style.left).toBe(`${clampedX}px`)
    restored.querySelector("header")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))
    expect(restored.style.left).toBe(""); expect(restored.style.right).toBe("16px"); expect(restored.style.top).toBe("96px"); expect(localStorage.getItem("opencode.app-plugin-floating.position.v1:voice")).toBeNull()
  })

  test("reclamps a persisted position when the viewport shrinks", async () => {
    const f = fixture(); f.host.open({ id: "voice", title: "Voice", sessions: scope, mount() {} }); await settle()
    const panel = document.querySelector<HTMLElement>('[data-component="app-plugin-floating"]')!
    panel.style.left = "800px"; panel.style.top = "96px"
    panel.getBoundingClientRect = () => ({ x: 800, y: 96, left: 800, top: 96, right: 1220, bottom: 396, width: 420, height: 300, toJSON() {} })
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 })
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 })
    window.dispatchEvent(new Event("resize"))
    expect(Number.parseFloat(panel.style.left)).toBe(8)
    expect(Number.parseFloat(panel.style.top)).toBeGreaterThanOrEqual(8)
  })

  test("disposes a late mount once after close and does not restart it on a new scope", async () => {
    const f = fixture()
    const pending = Promise.withResolvers<() => void>()
    let disposed = 0
    const handle = f.host.open({ id: "voice", title: "Voice", sessions: scope, mount: () => pending.promise })
    await settle()
    handle.close()
    handle.close()
    pending.resolve(() => { disposed++ })
    await settle()
    expect(disposed).toBe(1)
    const signals: AbortSignal[] = []
    f.host.open({ id: "voice", title: "Voice", sessions: scope, mount: ({ signal }) => { signals.push(signal) } })
    await settle()
    window.dispatchEvent(new Event("pagehide"))
    expect(signals[0].aborted).toBe(true)
    f.cleanups.forEach((fn) => fn())
    expect(disposed).toBe(1)
  })

  test("handles synchronous mount failure and rejects missing capability", async () => {
    const f = fixture()
    f.host.open({ id: "voice", title: "Voice", sessions: scope, mount() { throw new Error("Mount unavailable") } })
    await settle()
    expect(document.querySelector('[data-component="app-plugin-floating-content"]')?.textContent).toBe("Mount unavailable")
    expect(() => createFloatingHost({ authorized: () => false, track: (fn) => fn, subscribe: () => () => {} })
      .open({ id: "voice", title: "Voice", sessions: scope, mount() {} })).toThrow("Missing ui:floating capability")
  })
})
