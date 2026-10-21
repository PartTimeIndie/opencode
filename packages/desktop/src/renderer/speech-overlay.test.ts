import { describe, expect, test } from "bun:test"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { desktopServiceOverlayView } from "./speech-overlay-state"

const dir = dirname(fileURLToPath(import.meta.url))

describe("generic desktop service overlay", () => {
  test("uses plugin labels and progress for a neutral operation", () => {
    expect(desktopServiceOverlayView({ phase: "active", label: "Exporting archive", detail: "12 files", actionLabel: "Pause", progress: 0.25 })).toEqual({
      label: "Exporting archive", detail: "12 files", actionLabel: "Pause", shortcutVisible: true, telemetry: "25%", telemetryVisible: true,
    })
  })
  test("does not invent captions, devices or actions", () => {
    expect(desktopServiceOverlayView({ phase: "error", label: "Archive target unavailable" })).toMatchObject({
      label: "Archive target unavailable", detail: "", shortcutVisible: false, telemetryVisible: false,
    })
    expect(desktopServiceOverlayView({ phase: "success", label: "Exported", actionLabel: "Stale action", elapsedMs: 61_000 })).toMatchObject({ shortcutVisible: false, telemetry: "01:01", telemetryVisible: true })
    expect(desktopServiceOverlayView({ phase: "active", label: "Waiting" }).shortcutVisible).toBe(false)
  })
})

/**
 * The overlay window is driven by `speech-overlay.ts` looking up fixed element
 * IDs in `speech-overlay.html`. When the script requires an element the HTML
 * never shipped, the subscribe callback drops every state and the overlay stays
 * on the static "OpenCode is getting ready" fallback forever (reported bug:
 * global Speech to Text overlay never showed what was happening).
 */
describe("speech overlay html/script wiring", () => {
  const html = () => Bun.file(join(dir, "speech-overlay.html")).text()
  const script = () => Bun.file(join(dir, "speech-overlay.ts")).text()

  test("every element id the overlay script requires exists in speech-overlay.html", async () => {
    const required = [...(await script()).matchAll(/getElementById\(["']([^"']+)["']\)/g)].map((match) => match[1])
    expect(required.length).toBeGreaterThan(5)
    const content = await html()
    for (const id of required) {
      expect(content).toContain(`id="${id}"`)
    }
  })

  test("overlay html keeps the static getting-ready fallback status", async () => {
    const content = await html()
    expect(content).toContain('id="status"')
    expect(content).toMatch(/<strong id="status"[^>]*>OpenCode is getting ready<\/strong>/)
  })

  test("conditional overlay fields stay hidden until the first state arrives", async () => {
    const content = await html()
    // The pre-state fallback must not fabricate telemetry, detail, or action hints.
    for (const id of ["elapsed", "detail", "detail-separator", "shortcut"]) {
      const tag = content.match(new RegExp(`<[^>]*id="${id}"[^>]*>`))?.[0]
      expect(tag, `#${id} element`).toBeDefined()
      expect(tag).toMatch(/(^|\s)hidden(\s|$|>)/)
    }
  })

  test("subscribed states render through the real script against the real html", async () => {
    const content = await html()
    const ids = new Set([...content.matchAll(/id="([^"']+)"/g)].map((match) => match[1]))
    const initialHidden = new Set(
      [...content.matchAll(/<[^>]*id="([^"]+)"[^>]*>/g)]
        .filter((match) => /(^|\s)hidden(\s|$|>)/.test(match[0]))
        .map((match) => match[1]),
    )
    const elements = new Map<string, { textContent: string; title: string; hidden: boolean; dataset: Record<string, string> }>()
    const element = (id: string) => {
      if (!ids.has(id)) return null
      const existing = elements.get(id)
      if (existing) return existing
      const created = { textContent: "", title: "", hidden: initialHidden.has(id), dataset: {} as Record<string, string> }
      elements.set(id, created)
      return created
    }
    const document = { getElementById: (id: string) => element(id) }
    let subscriber: ((state: unknown) => void) | undefined
    const window = {
      speechOverlay: {
        subscribe(callback: (state: unknown) => void) {
          subscriber = callback
          return () => {}
        },
      },
    }
    const globals = { document, window } as unknown as Record<string, unknown>
    const restore: Array<[string, unknown]> = []
    for (const [key, value] of Object.entries(globals)) {
      restore.push([key, (globalThis as Record<string, unknown>)[key]])
      ;(globalThis as Record<string, unknown>)[key] = value
    }
    try {
      await import("./speech-overlay.ts")
    } finally {
      for (const [key, value] of restore) (globalThis as Record<string, unknown>)[key] = value
    }
    expect(subscriber).toBeFunction()
    expect(elements.get("elapsed")?.hidden).toBe(true)

    subscriber?.({
      phase: "active",
      label: "OpenCode is listening",
      elapsedMs: 61_000,
      detail: "USB microphone",
      actionLabel: "Stop",
      application: "msedge",
      accelerator: "Ctrl+Shift+Space",
    })
    // Missing #detail / #detail-separator in the html must not silently drop states.
    expect(elements.get("status")?.textContent).toBe("OpenCode is listening")
    expect(elements.get("detail")?.textContent).toBe("USB microphone")
    expect(elements.get("detail")?.hidden).toBe(false)
    expect(elements.get("detail-separator")?.hidden).toBe(false)
    expect(elements.get("elapsed")?.textContent).toBe("01:01")
    expect(elements.get("elapsed")?.hidden).toBe(false)
    expect(elements.get("hint")?.textContent).toBe("Stop")
    expect(elements.get("shortcut")?.hidden).toBe(false)
    expect(elements.get("overlay")?.dataset.phase).toBe("active")

    subscriber?.({ phase: "success", label: "Text inserted", application: "msedge", accelerator: "Ctrl+Shift+Space" })
    expect(elements.get("status")?.textContent).toBe("Text inserted")
    expect(elements.get("shortcut")?.hidden).toBe(true)
    expect(elements.get("detail")?.hidden).toBe(true)
    expect(elements.get("elapsed")?.hidden).toBe(true)
    expect(elements.get("overlay")?.dataset.phase).toBe("success")
  })
})
