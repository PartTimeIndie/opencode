import { describe, expect, test } from "bun:test"
import {
  crashedWebviewAction,
  isAllowedBrowserURL,
  normalizeBrowserURL,
  readBrowserWebviewStatus,
} from "./session-browser-control"

describe("session browser dock URL handling", () => {
  test("normalizes host and host:port inputs", () => {
    expect(normalizeBrowserURL("localhost:3000")).toBe("http://localhost:3000/")
    expect(normalizeBrowserURL("127.0.0.1:5173/app")).toBe("http://127.0.0.1:5173/app")
    expect(normalizeBrowserURL("example.com:8080/docs")).toBe("https://example.com:8080/docs")
    expect(normalizeBrowserURL("example.com")).toBe("https://example.com/")
    expect(normalizeBrowserURL("http://localhost:5173")).toBe("http://localhost:5173/")
  })

  test("rejects non-web protocols", () => {
    expect(normalizeBrowserURL("file:///tmp/index.html")).toBeUndefined()
    expect(normalizeBrowserURL("javascript:alert(1)")).toBeUndefined()
    expect(isAllowedBrowserURL("file:///tmp/index.html")).toBe(false)
    expect(isAllowedBrowserURL("https://example.com")).toBe(true)
  })

  test("does not call Electron webview methods before dom-ready", () => {
    const calls: string[] = []
    const webview = {
      getAttribute: (name: string) => (name === "src" ? "https://example.com/" : null),
      getURL: () => {
        calls.push("getURL")
        throw new Error("webview is not ready")
      },
      isLoading: () => {
        calls.push("isLoading")
        return false
      },
    }

    expect(readBrowserWebviewStatus(webview, "https://fallback.test/", false)).toEqual({
      actualURL: "https://example.com/",
      loading: true,
    })
    expect(calls).toEqual([])
  })

  test("reads Electron webview methods after dom-ready", () => {
    const webview = {
      getAttribute: (name: string) => (name === "src" ? "https://example.com/" : null),
      getURL: () => "https://example.com/live",
      isLoading: () => false,
      canGoBack: () => true,
      canGoForward: () => false,
    }

    expect(readBrowserWebviewStatus(webview, "https://fallback.test/", true)).toEqual({
      actualURL: "https://example.com/live",
      loading: false,
      canGoBack: true,
      canGoForward: false,
    })
  })

  test("exposes the Electron webContents identity for exact CDP targeting", () => {
    const webview = {
      getAttribute: () => "https://example.com/",
      getURL: () => "https://example.com/",
      getWebContentsId: () => 42,
    }

    expect(readBrowserWebviewStatus(webview, "https://fallback.test/", true)).toMatchObject({
      actualURL: "https://example.com/",
      webContentsID: 42,
    })
  })

  test("reloads crashed webview guests but not clean exits", () => {
    expect(crashedWebviewAction("crashed")).toBe("reload")
    expect(crashedWebviewAction("oom")).toBe("reload")
    expect(crashedWebviewAction("killed")).toBe("reload")
    expect(crashedWebviewAction(undefined)).toBe("reload")
    expect(crashedWebviewAction("clean-exit")).toBe("ignore")
  })
})

describe("destroyed webview guest recovery", () => {
  // Electron throws "Object has been destroyed" once a webview guest is gone
  // (for example a background eviction). The dock status must report the
  // destroyed marker instead of throwing, so the controller can rebuild the
  // frame and the automation bridge keeps working.
  test("reports a destroyed webview as loading with the destroyed marker", () => {
    const webview = {
      getAttribute: (name: string) => (name === "src" ? "https://example.com/" : null),
      getWebContentsId: () => {
        throw new Error("Object has been destroyed")
      },
    }

    expect(readBrowserWebviewStatus(webview, "https://fallback.test/", true)).toEqual({
      actualURL: "https://example.com/",
      loading: true,
      destroyed: true,
    })
  })

  test("does not surface the destroyed marker for a live webview", () => {
    const webview = {
      getAttribute: (name: string) => (name === "src" ? "https://example.com/" : null),
      getURL: () => "https://example.com/live",
      isLoading: () => false,
      getWebContentsId: () => 7,
    }

    const status = readBrowserWebviewStatus(webview, "https://fallback.test/", true)
    expect(status).toEqual({
      actualURL: "https://example.com/live",
      loading: false,
      webContentsID: 7,
    })
    expect("destroyed" in status).toBe(false)
  })

  test("recovers when any native webview method hits the destroyed guest", () => {
    const webview = {
      getAttribute: (name: string) => (name === "src" ? "https://example.com/" : null),
      getWebContentsId: () => 42,
      getURL: () => {
        throw new Error("Object has been destroyed")
      },
    }

    expect(readBrowserWebviewStatus(webview, "https://fallback.test/", true)).toEqual({
      actualURL: "https://example.com/",
      loading: true,
      destroyed: true,
    })
  })
})
