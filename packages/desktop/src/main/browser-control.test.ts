import { describe, expect, test } from "bun:test"
import { createBrowserAutomation } from "./browser-control"

describe("browser control webContents seam", () => {
  test("waits for a webContentsID after renderer status becomes webview", async () => {
    let statusCalls = 0
    const contents = {
      id: 42,
      isDestroyed: () => false,
      getURL: () => "https://example.com/",
      executeJavaScript: async (code: string) => code.includes("snapshotScript") ? { text: "Example", accessibility: "Example", elements: [] } : "Example Domain",
      capturePage: async () => ({ toJPEG: () => Buffer.from("") }),
      subscribeEvidence: () => () => undefined,
    }
    const automation = createBrowserAutomation({
      status: async () => ({ browser: { mode: "webview", url: "https://example.com/", actualURL: "https://example.com/", ...(statusCalls++ < 2 ? {} : { webContentsID: 42 }) } }),
      webContentsForId: () => contents,
    })
    await expect(automation.snapshot({ timeout: 500 })).resolves.toMatchObject({ text: "Example", url: "https://example.com/" })
    expect(statusCalls).toBeGreaterThanOrEqual(4)
  })

  test("fails once with a bounded webContentsID error when the ID never appears", async () => {
    let statusCalls = 0
    const automation = createBrowserAutomation({
      status: async () => {
        statusCalls += 1
        return { browser: { mode: "webview", url: "https://example.com/", actualURL: "https://example.com/" } }
      },
      webContentsForId: () => undefined,
    })
    const started = Date.now()
    await expect(automation.snapshot({ timeout: 150 })).rejects.toThrow("Could not resolve the active Browser Dock webContents ID within 150ms")
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(statusCalls).toBeGreaterThan(1)
  })

  test("uses the exact Browser Dock webContents for snapshot, click, type, and wait", async () => {
    const calls: string[] = []
    let evidenceListener: ((kind: "console" | "network", value: string) => void) | undefined
    const contents = {
      id: 42,
      isDestroyed: () => false,
      getURL: () => "https://example.com/",
      capturePage: async () => ({ toJPEG: () => Buffer.from("jpeg") }),
      subscribeEvidence: (listener: (kind: "console" | "network", value: string) => void) => {
        evidenceListener = listener
        return () => undefined
      },
      executeJavaScript: async (code: string) => {
        calls.push(code)
        if (code.includes("snapshotScript")) {
          for (let index = 0; index < 60; index += 1) {
            evidenceListener?.("console", `[log] ${index}`)
            evidenceListener?.("network", `[404] https://example.com/missing/${index}`)
          }
          return { text: "Example", accessibility: "Example", elements: [{ ref: "e1" }] }
        }
        if (code.includes("document.title")) return "Example Domain"
        if (code.includes("const element = settings.ref")) return { exists: true, visible: true }
        return undefined
      },
    }
    const automation = createBrowserAutomation({
      status: async () => ({ browser: { mode: "webview", url: "https://example.com/", actualURL: "https://example.com/", webContentsID: 42 } }),
      webContentsForId: () => contents,
    })

    const snapshot = await automation.snapshot({})
    expect(snapshot).toMatchObject({ url: "https://example.com/", title: "Example Domain", elements: [{ ref: "e1" }] })
    expect(snapshot.evidence.console).toHaveLength(50)
    expect(snapshot.evidence.network).toHaveLength(50)
    expect(snapshot.evidence.console[0]).toBe("[log] 10")
    expect(snapshot.evidence.network[49]).toBe("[404] https://example.com/missing/59")
    await expect(automation.click({ ref: "e1", button: "right" })).resolves.toMatchObject({ title: "Example Domain" })
    await expect(automation.type({ ref: "e1", text: "hello" })).resolves.toMatchObject({ title: "Example Domain" })
    await expect(automation.wait({ text: "Example" })).resolves.toMatchObject({ waited: 'text "Example"' })
    expect(calls.some((code) => code.includes("snapshotScript"))).toBe(true)
    expect(calls.some((code) => code.includes("native") || code.includes("Object.getOwnPropertyDescriptor"))).toBe(true)
    expect(calls.some((code) => code.includes("keypress") && code.includes("keyup") && code.includes('"right"'))).toBe(true)
  })

  test("rejects a resolved adapter whose identity does not match status", async () => {
    const automation = createBrowserAutomation({
      status: async () => ({ browser: { mode: "webview", url: "https://example.com/", webContentsID: 42 } }),
      webContentsForId: () => ({ id: 7, isDestroyed: () => false, getURL: () => "https://example.com/", executeJavaScript: async () => undefined, capturePage: async () => ({ toJPEG: () => Buffer.from("") }), subscribeEvidence: () => () => undefined }),
    })
    await expect(automation.snapshot({ timeout: 1 })).rejects.toThrow("Could not resolve the active Browser Dock webContents")
  })

  test("rejects a navigation race after the adapter was resolved", async () => {
    let statusCalls = 0
    const contents = { id: 42, isDestroyed: () => false, getURL: () => "https://example.com/", executeJavaScript: async () => ({ text: "", accessibility: "", elements: [] }), capturePage: async () => ({ toJPEG: () => Buffer.from("") }), subscribeEvidence: () => () => undefined }
    const automation = createBrowserAutomation({
      status: async () => ({ browser: statusCalls++ < 1 ? { mode: "webview", url: "https://example.com/", webContentsID: 42 } : { mode: "webview", url: "https://other.example/", webContentsID: 99 } }),
      webContentsForId: () => contents,
    })
    await expect(automation.snapshot({ timeout: 100 })).rejects.toThrow("changed during resolution")
  })

  test("rejects a same-webContents cross-origin navigation after execution", async () => {
    let url = "https://example.com/"
    let executions = 0
    const contents = {
      id: 42,
      isDestroyed: () => false,
      getURL: () => url,
      executeJavaScript: async () => {
        executions += 1
        if (executions === 1) url = "https://other.example/"
        return { text: "", accessibility: "", elements: [] }
      },
      capturePage: async () => ({ toJPEG: () => Buffer.from("") }),
      subscribeEvidence: () => () => undefined,
    }
    const automation = createBrowserAutomation({
      status: async () => ({ browser: { mode: "webview", url, actualURL: url, webContentsID: 42 } }),
      webContentsForId: () => contents,
    })
    await expect(automation.snapshot({})).rejects.toThrow("origin changed from https://example.com to https://other.example")
  })

  test("does not pin an origin after navigation between live URL and status confirmation", async () => {
    let statusCalls = 0
    let liveURL = "https://example.com/"
    const contents = {
      id: 42,
      isDestroyed: () => false,
      getURL: () => liveURL,
      executeJavaScript: async () => ({ text: "", accessibility: "", elements: [] }),
      capturePage: async () => ({ toJPEG: () => Buffer.from("") }),
      subscribeEvidence: () => () => undefined,
    }
    const automation = createBrowserAutomation({
      status: async () => {
        statusCalls += 1
        if (statusCalls === 2) {
          liveURL = "https://other.example/"
          return { browser: { mode: "webview", url: liveURL, actualURL: liveURL, webContentsID: 42 } }
        }
        return { browser: { mode: "webview", url: "https://example.com/", actualURL: "https://example.com/", webContentsID: 42 } }
      },
      webContentsForId: () => contents,
    })
    await expect(automation.snapshot({})).rejects.toThrow("origin changed from https://example.com to https://other.example")
  })

  test("cleans evidence subscriptions and bounded state when the active webContents changes", async () => {
    let activeID = 42
    const unsubscribed: number[] = []
    const makeContents = (id: number) => ({
      id,
      isDestroyed: () => false,
      getURL: () => `https://example.com/${id}`,
      executeJavaScript: async (code: string) => code.includes("snapshotScript") ? { text: "", accessibility: "", elements: [] } : "title",
      capturePage: async () => ({ toJPEG: () => Buffer.from("") }),
      subscribeEvidence: () => () => unsubscribed.push(id),
    })
    const contents = new Map([[42, makeContents(42)], [43, makeContents(43)]])
    const automation = createBrowserAutomation({
      cdpUrl: "http://unused",
      status: async () => ({ browser: { mode: "webview", url: "https://example.com/", actualURL: "https://example.com/", webContentsID: activeID } }),
      webContentsForId: (id) => contents.get(id),
    })
    await automation.snapshot({})
    activeID = 43
    await automation.snapshot({})
    expect(unsubscribed).toEqual([42])
  })
})
