const defaultURL = "http://localhost:3000"
const browserPartition = "persist:opencode-session-browser"

export type SessionBrowserMode = "empty" | "iframe" | "webview"

export type SessionBrowserStatus = {
  tabId: string
  draft: string
  url: string
  error: string
  loading: boolean
  mode: SessionBrowserMode
  actualURL?: string
  canGoBack?: boolean
  canGoForward?: boolean
  webContentsID?: number
}

export type SessionBrowserController = {
  navigate(url: string): SessionBrowserStatus
  openTab(url: string): SessionBrowserStatus & { tabId: string }
  closeTab(tabId?: string): { closed: boolean; tabId?: string }
  status(): SessionBrowserStatus
}

export type BrowserWebviewRuntime = {
  getAttribute(name: string): string | null
  getURL?: () => string
  isLoading?: () => boolean
  canGoBack?: () => boolean
  canGoForward?: () => boolean
  getWebContentsId?: () => number
}

let controller: SessionBrowserController | undefined

export const SessionBrowserControl = {
  register(value: SessionBrowserController) {
    controller = value
    return () => {
      if (controller === value) controller = undefined
    }
  },
  peek() {
    return controller
  },
  current() {
    if (!controller) throw new Error("Session browser dock is not mounted")
    return controller
  },
}

export { browserPartition, defaultURL }

export function normalizeBrowserURL(input: string) {
  const value = input.trim()
  if (!value) return
  const explicitProtocol = value.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1]?.toLowerCase()
  if (explicitProtocol && explicitProtocol !== "http" && explicitProtocol !== "https") return
  if (!explicitProtocol && /^[a-z][a-z0-9+.-]*:/i.test(value) && !looksLikeHostPort(value)) return
  const raw = explicitProtocol ? value : `${defaultProtocol(value)}://${value}`
  if (!URL.canParse(raw)) return
  const url = new URL(raw)
  if (!isAllowedBrowserURL(url.toString())) return
  return url.toString()
}

function defaultProtocol(value: string) {
  return isLocalHost(value) ? "http" : "https"
}

function isLocalHost(value: string) {
  const host = value.startsWith("[")
    ? value.slice(1, value.indexOf("]"))
    : value.split(/[/:?#]/, 1)[0]?.toLowerCase()
  return host === "localhost" || host === "::1" || host === "0.0.0.0" || host?.startsWith("127.") === true
}

function looksLikeHostPort(value: string) {
  return /^[a-z0-9.-]+:\d+(?:[/?#]|$)/i.test(value)
}

export function isAllowedBrowserURL(value: string) {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  return url.protocol === "http:" || url.protocol === "https:"
}

export function readBrowserWebviewStatus(webview: BrowserWebviewRuntime, fallbackURL: string, domReady: boolean) {
  const actualURL = webview.getAttribute("src") ?? fallbackURL
  if (!domReady) return { actualURL, loading: true }
  const webContentsID = webview.getWebContentsId?.()
  return {
    actualURL: webview.getURL?.() || actualURL,
    loading: webview.isLoading?.(),
    canGoBack: webview.canGoBack?.(),
    canGoForward: webview.canGoForward?.(),
    ...(typeof webContentsID === "number" ? { webContentsID } : {}),
  }
}

// A crashed webview guest paints an inert gray surface until it is reloaded;
// only a clean exit (for example an intentional background eviction) should
// leave it alone.
export function crashedWebviewAction(reason: string | undefined): "ignore" | "reload" {
  if (reason === "clean-exit") return "ignore"
  return "reload"
}
