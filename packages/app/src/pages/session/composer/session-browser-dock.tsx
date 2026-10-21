import { usePlatform } from "@/context/platform"
import { Button } from "@opencode-ai/ui/button"
import { createEffect, createMemo, createRoot, For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import {
  browserPartition,
  crashedWebviewAction,
  defaultURL,
  isAllowedBrowserURL,
  normalizeBrowserURL,
  readBrowserWebviewStatus,
  SessionBrowserControl,
  type SessionBrowserStatus,
} from "./session-browser-control"

export { isAllowedBrowserURL, normalizeBrowserURL }

type BrowserTab = {
  id: string
  draft: string
  url: string
  currentURL: string
  error: string
  loading: boolean
  request: number
}

type BrowserDockState = {
  tabs: Record<string, BrowserTab>
  order: string[]
  activeTabId: string
}

let tabSeq = 0
function createTab(): BrowserTab {
  const id = `bt-${++tabSeq}`
  return { id, draft: defaultURL, url: "", currentURL: "", error: "", loading: false, request: 0 }
}

const initialTab = createTab()
const [browserStore, setBrowserStore] = createStore<BrowserDockState>({
  tabs: { [initialTab.id]: initialTab },
  order: [initialTab.id],
  activeTabId: initialTab.id,
})

type BrowserWebviewElement = HTMLElement & {
  reload?: () => void
  reloadIgnoringCache?: () => void
  getURL?: () => string
  isLoading?: () => boolean
  canGoBack?: () => boolean
  canGoForward?: () => boolean
  getWebContentsId?: () => number
}
type BrowserFrameMode = "iframe" | "webview"
type BrowserFrameElement = HTMLIFrameElement | BrowserWebviewElement

type FrameSingleton = {
  tabId: string
  host: HTMLDivElement
  frame: BrowserFrameElement
  mode: BrowserFrameMode
  ready: boolean
  loadedRequest: number
  dispose?: () => void
}

// Each browser sub-tab owns a persistent frame element that is created once and
// never reparented/removed for its lifetime, so switching tabs (or session/dock
// tabs) never reloads the page. Only the active tab's frame is positioned over
// the dock slot; the others stay alive but hidden.
const frames = new Map<string, FrameSingleton>()
let trackedSlot: HTMLElement | null = null
let viewportObserver: ResizeObserver | undefined
let resizeListener: (() => void) | undefined
let scrollListener: (() => void) | undefined

function syncLocation(tabId: string, url: string) {
  if (!isAllowedBrowserURL(url)) return
  setBrowserStore("tabs", tabId, { draft: url, currentURL: url })
}

function ensureFrame(tabId: string, mode: BrowserFrameMode): FrameSingleton | undefined {
  const existing = frames.get(tabId)
  if (existing) return existing
  if (typeof document === "undefined") return

  const host = document.createElement("div")
  host.dataset.slot = "browser-frame-overlay"
  // The host is always laid out (never display:none) and starts off-screen
  // with a concrete size. <webview> guests attach at their element's rendered
  // size; if the host is display:none/0x0 at attach time the guest gets stuck
  // at the default 150px height and never resizes, so the page renders into a
  // tiny strip and the rest stays blank. Keeping the host laid out lets the
  // guest attach at a real size and resize when the element changes.
  host.style.cssText =
    "position:fixed;left:-99999px;top:0;width:800px;height:600px;overflow:hidden;visibility:hidden;z-index:30;"

  const onWebviewNavigate = (event: Event) => {
    const url = (event as Event & Record<string, unknown>).url
    if (typeof url === "string" && url) syncLocation(tabId, url)
  }
  const onWebviewFail = (event: Event) => {
    const value = (key: string) => (event as Event & Record<string, unknown>)[key]
    if (value("isMainFrame") === false || value("errorCode") === -3) return
    const description = value("errorDescription")
    const validated = value("validatedURL")
    const tab = browserStore.tabs[tabId]
    setBrowserStore("tabs", tabId, {
      error: `${typeof description === "string" ? description : "Failed to load"}: ${typeof validated === "string" ? validated : tab?.url ?? ""}`,
      loading: false,
    })
  }

  let frame: BrowserFrameElement
  if (mode === "webview") {
    const webview = document.createElement("webview") as BrowserWebviewElement
    webview.dataset.slot = "browser-frame"
    webview.dataset.tabId = tabId
    webview.setAttribute("partition", browserPartition)
    webview.style.cssText = "width:100%;height:100%;border:0;display:flex;"
    webview.addEventListener("dom-ready", () => {
      const s = frames.get(tabId)
      if (s) s.ready = true
    })
    webview.addEventListener("did-stop-loading", () => setBrowserStore("tabs", tabId, "loading", false))
    webview.addEventListener("did-navigate", onWebviewNavigate)
    webview.addEventListener("did-navigate-in-page", onWebviewNavigate)
    webview.addEventListener("did-fail-load", onWebviewFail)
    // A crashed guest renderer leaves an inert gray rect in the dock; reload
    // it so the tab recovers instead of staying dead until a manual reload.
    webview.addEventListener("render-process-gone", (event) => {
      const reason = (event as Event & { reason?: string }).reason
      if (crashedWebviewAction(reason) === "ignore") return
      setBrowserStore("tabs", tabId, {
        error: reason ? `Browser renderer crashed (${reason}); reloading` : "Browser renderer crashed; reloading",
        loading: true,
      })
      webview.reloadIgnoringCache?.()
    })
    frame = webview
  } else {
    const iframe = document.createElement("iframe")
    iframe.dataset.slot = "browser-frame"
    iframe.dataset.tabId = tabId
    iframe.referrerPolicy = "no-referrer"
    iframe.setAttribute("sandbox", "allow-downloads allow-forms allow-modals allow-popups allow-same-origin allow-scripts")
    iframe.style.cssText = "width:100%;height:100%;border:0;display:block;"
    iframe.addEventListener("load", () => setBrowserStore("tabs", tabId, "loading", false))
    frame = iframe
  }

  if (mode === "iframe") host.appendChild(frame)
  document.body.appendChild(host)
  const singleton: FrameSingleton = { tabId, host, frame, mode, ready: mode === "iframe", loadedRequest: -1 }
  frames.set(tabId, singleton)
  const dispose = createRoot((dispose) => {
    createEffect(() => {
      const s = frames.get(tabId)
      if (!s) return
      const tab = browserStore.tabs[tabId]
      if (!tab) return
      if (!tab.url) return
      if (s.mode === "webview") {
        positionFrames()
        if (!hasVisibleFrameRect(s)) return
      }
      loadFrameSource(s, tab)
    })
    createEffect(() => {
      void browserStore.activeTabId
      const active = browserStore.tabs[browserStore.activeTabId]
      if (active) void active.url
      positionFrames()
    })
    return dispose
  })
  singleton.dispose = dispose
  positionFrames()
  return singleton
}

function disposeFrame(tabId: string) {
  const s = frames.get(tabId)
  if (!s) return
  s.dispose?.()
  s.host.remove()
  frames.delete(tabId)
}

export function disposeSessionBrowserFrames() {
  Array.from(frames.keys()).forEach(disposeFrame)
}

function hasVisibleFrameRect(s: FrameSingleton) {
  const rect = s.frame.isConnected ? s.frame.getBoundingClientRect() : s.host.getBoundingClientRect()
  return s.host.style.visibility === "visible" && rect.width > 0 && rect.height > 0
}

function loadFrameSource(s: FrameSingleton, tab: BrowserTab) {
  if (s.loadedRequest === tab.request) return
  s.loadedRequest = tab.request
  if (s.frame.getAttribute("src") !== tab.url) {
    if (s.mode === "webview") s.frame.setAttribute("src", tab.url)
    else (s.frame as HTMLIFrameElement).src = tab.url
    return
  }
  if (s.mode === "webview") {
    if (s.ready && s.frame.isConnected) (s.frame as BrowserWebviewElement).reload?.()
    return
  }
  ;(s.frame as HTMLIFrameElement).src = tab.url
}

function positionFrames() {
  const slot = trackedSlot
  const activeId = browserStore.activeTabId
  const activeTab = browserStore.tabs[activeId]
  const rect = slot?.getBoundingClientRect()
  const hasRect = !!rect && rect.width > 0 && rect.height > 0
  for (const [id, s] of frames) {
    // Never toggle display:none here: a <webview> whose host is display:none
    // attaches its guest at 0x0 (clamped to the 150px default) and fails to
    // resize afterwards. Keep every host display:block; show the active frame
    // over the slot and park inactive frames off-screen with visibility hidden.
    if (id === activeId && hasRect && activeTab?.url) {
      s.host.style.left = `${rect.left}px`
      s.host.style.top = `${rect.top}px`
      s.host.style.width = `${rect.width}px`
      s.host.style.height = `${rect.height}px`
      s.host.style.visibility = "visible"
      s.frame.style.width = `${rect.width}px`
      s.frame.style.height = `${rect.height}px`
      if (s.mode === "webview" && s.frame.parentElement !== s.host) s.host.appendChild(s.frame)
      loadFrameSource(s, activeTab)
    } else {
      s.host.style.visibility = "hidden"
      s.host.style.left = "-99999px"
    }
  }
}

function trackBrowserFrame(el: HTMLElement | null) {
  if (trackedSlot === el) {
    positionFrames()
    return
  }
  viewportObserver?.disconnect()
  if (resizeListener) window.removeEventListener("resize", resizeListener)
  if (scrollListener) window.removeEventListener("scroll", scrollListener, true)
  trackedSlot = el
  if (!el) {
    positionFrames()
    return
  }
  const reposition = () => positionFrames()
  resizeListener = reposition
  scrollListener = reposition
  window.addEventListener("resize", resizeListener)
  window.addEventListener("scroll", scrollListener, true)
  viewportObserver = new ResizeObserver(reposition)
  viewportObserver.observe(el)
  positionFrames()
}

function frameStatus(tabId: string): Partial<SessionBrowserStatus> {
  const s = frames.get(tabId)
  if (!s) return {}
  const tab = browserStore.tabs[tabId]
  if (s.mode === "webview") {
    return readBrowserWebviewStatus(s.frame as BrowserWebviewElement, tab?.currentURL || tab?.url || "", s.ready)
  }
  return { actualURL: (s.frame as HTMLIFrameElement).src }
}

function tabTitle(tab: BrowserTab | undefined) {
  if (!tab || !tab.url) return "New tab"
  try {
    return new URL(tab.currentURL || tab.url).host || tab.currentURL || tab.url
  } catch {
    return tab.currentURL || tab.url
  }
}

export function SessionBrowserDock() {
  const platform = usePlatform()
  let slotRef: HTMLDivElement | undefined

  const mode = (): BrowserFrameMode =>
    platform.platform === "desktop" && platform.embeddedBrowser === "webview" ? "webview" : "iframe"

  const activeTab = createMemo(() => browserStore.tabs[browserStore.activeTabId])

  const status = (): SessionBrowserStatus => {
    const tab = activeTab()
    const hostStatus = frameStatus(browserStore.activeTabId)
    return {
      ...hostStatus,
      tabId: browserStore.activeTabId,
      draft: tab?.draft ?? defaultURL,
      url: tab?.currentURL || tab?.url || "",
      error: tab?.error ?? "",
      loading: hostStatus.loading ?? tab?.loading ?? false,
      mode: !tab?.url ? "empty" : mode(),
    }
  }

  const navigateActive = (input: string): SessionBrowserStatus => {
    const url = normalizeBrowserURL(input)
    if (!url) throw new Error("Browser URL must be http:// or https://")
    const id = browserStore.activeTabId
    ensureFrame(id, mode())
    setBrowserStore("tabs", id, { url, draft: url, currentURL: url, error: "", loading: true, request: (browserStore.tabs[id]?.request ?? 0) + 1 })
    return status()
  }

  const load = () => {
    const tab = activeTab()
    if (!tab) return
    const url = normalizeBrowserURL(tab.draft)
    if (!url) {
      setBrowserStore("tabs", browserStore.activeTabId, "error", "Enter an http:// or https:// URL")
      return
    }
    ensureFrame(browserStore.activeTabId, mode())
    setBrowserStore("tabs", browserStore.activeTabId, { url, draft: url, currentURL: url, error: "", loading: true, request: tab.request + 1 })
  }

  const activateTab = (id: string) => {
    if (browserStore.activeTabId === id) return
    setBrowserStore("activeTabId", id)
    ensureFrame(id, mode())
    positionFrames()
  }

  const addTab = () => {
    const tab = createTab()
    setBrowserStore("tabs", tab.id, tab)
    setBrowserStore("order", [...browserStore.order, tab.id])
    setBrowserStore("activeTabId", tab.id)
    positionFrames()
  }

  const closeTab = (id: string) => {
    const index = browserStore.order.indexOf(id)
    if (index === -1) return
    const nextOrder = browserStore.order.filter((tabId) => tabId !== id)
    const nextTabs = { ...browserStore.tabs }
    delete nextTabs[id]
    if (nextOrder.length === 0) {
      // Always keep at least one tab.
      const fresh = createTab()
      setBrowserStore({ tabs: { [fresh.id]: fresh }, order: [fresh.id], activeTabId: fresh.id })
    } else {
      const nextActive = browserStore.activeTabId === id ? nextOrder[Math.min(index, nextOrder.length - 1)] : browserStore.activeTabId
      setBrowserStore({ tabs: nextTabs, order: nextOrder, activeTabId: nextActive })
    }
    disposeFrame(id)
    positionFrames()
  }

  onMount(() => {
    ensureFrame(browserStore.activeTabId, mode())
    const unregister = SessionBrowserControl.register({
      navigate(input) {
        return navigateActive(input)
      },
      openTab(input) {
        const url = normalizeBrowserURL(input)
        if (!url) throw new Error("Browser URL must be http:// or https://")
        const tab = createTab()
        setBrowserStore("tabs", tab.id, { ...tab, url, draft: url, currentURL: url, error: "", loading: true, request: 1 })
        setBrowserStore("order", (order) => [...order, tab.id])
        setBrowserStore("activeTabId", tab.id)
        ensureFrame(tab.id, mode())
        positionFrames()
        return { ...status(), tabId: tab.id }
      },
      closeTab(tabId) {
        const id = tabId ?? browserStore.activeTabId
        if (!browserStore.tabs[id]) return { closed: false }
        closeTab(id)
        return { closed: true, tabId: id }
      },
      status,
    })
    trackBrowserFrame(slotRef ?? null)
    onCleanup(() => {
      unregister()
      trackBrowserFrame(null)
    })
  })

  return (
    <section data-component="session-browser-dock">
      <div data-slot="browser-tabs">
        <For each={browserStore.order}>
          {(tabId) => (
            <div
              data-slot="browser-tab"
              data-tab-id={tabId}
              data-active={tabId === browserStore.activeTabId ? "true" : undefined}
              onClick={() => activateTab(tabId)}
            >
              <span>{tabTitle(browserStore.tabs[tabId])}</span>
              <button
                type="button"
                data-slot="browser-tab-close"
                aria-label="Close tab"
                onClick={(event) => {
                  event.stopPropagation()
                  closeTab(tabId)
                }}
              >
                ×
              </button>
            </div>
          )}
        </For>
        <button type="button" data-slot="browser-tab-new" aria-label="New browser tab" onClick={() => addTab()}>
          +
        </button>
      </div>
      <form
        data-slot="browser-toolbar"
        onSubmit={(event) => {
          event.preventDefault()
          load()
        }}
      >
        <input
          data-slot="browser-url"
          value={activeTab()?.draft ?? ""}
          spellcheck={false}
          placeholder="https://example.com"
          onInput={(event) => setBrowserStore("tabs", browserStore.activeTabId, "draft", event.currentTarget.value)}
        />
        <Button type="submit" size="small" variant="secondary">
          {activeTab()?.loading ? "Loading" : "Open"}
        </Button>
        <Button
          type="button"
          size="small"
          variant="ghost"
          disabled={!activeTab()?.url}
          onClick={() => {
            const url = activeTab()?.currentURL || activeTab()?.url
            if (url) platform.openLink(url)
          }}
        >
          Pop out
        </Button>
      </form>
      <div data-slot="browser-status">
        <Show when={activeTab()?.error}>{(error) => <div data-slot="browser-error">{error()}</div>}</Show>
      </div>
      <div data-slot="browser-frame-slot" ref={slotRef} class="relative min-h-0 overflow-hidden">
        <Show when={!activeTab()?.url}>
          <div data-slot="browser-empty" class="absolute inset-0 flex items-center justify-center p-3">
            Open a local dev server or docs page.
          </div>
        </Show>
      </div>
    </section>
  )
}
