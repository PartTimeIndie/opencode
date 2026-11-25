import { usePlatform, type Platform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogWebDock } from "@/components/dialog-web-dock"
import { Button } from "@opencode-ai/ui/button"
import { batch, createEffect, createMemo, createRoot, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { createSessionBrowserRuntime, type BrowserTab } from "./session-browser-runtime"
import { createBrowserTransferLock } from "./browser-transfer-lock"
import { createBrowserFrameSlots } from "./browser-frame-slots"
import { reloadBrowserFrame } from "./browser-frame-reload"
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

const browserRuntime = createSessionBrowserRuntime(defaultURL)
const { browserStore, setBrowserStore, createTab } = browserRuntime

const dockTickets = new Map<string, { id: number; ticket: string }>()
const transfers = createBrowserTransferLock()

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
const frameSlots = createBrowserFrameSlots()

function syncLocation(tabId: string, url: string) {
  if (!isAllowedBrowserURL(url)) return
  setBrowserStore("tabs", tabId, { draft: url, currentURL: url })
}

function ensureFrame(tabId: string, mode: BrowserFrameMode, transfer?: Platform["browserTransfer"]): FrameSingleton | undefined {
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
      const dockID = Object.keys(browserStore.docked).find((id) => browserStore.docked[id] === tabId)
      const guestID = webview.getWebContentsId?.()
      if (!dockID || !guestID || dockTickets.get(dockID)?.id === guestID) return
      // Restored docks create fresh guests. They need the same main-process
      // ownership fence as a live tab transfer, not just renderer exclusion.
      void transfers.run(`dock:${dockID}`, async () => {
        if (!transfer) throw new Error("Desktop browser transfer is unavailable")
        const ticket = await transfer("reserve", guestID)
        if (typeof ticket !== "string") throw new Error("The browser is currently in use")
        try {
          if (browserStore.docked[dockID] !== tabId || frames.get(tabId) !== s) throw new Error("The browser page is no longer available")
          if (await transfer("commit", guestID, ticket) !== true) throw new Error("Browser ownership could not be confirmed")
          dockTickets.set(dockID, { id: guestID, ticket })
          positionFrames()
        } catch (error) {
          if (await transfer("release", guestID, ticket) !== true) throw new Error("Browser ownership could not be released", { cause: error })
          throw error
        }
      }).catch((error: unknown) => {
        if (browserStore.docked[dockID] !== tabId || frames.get(tabId) !== s) return
        // A rejected restore must not leave an unfenced guest available to
        // automation. Keep the definition and error; an explicit retry creates
        // a fresh guest and repeats admission.
        disposeFrame(tabId)
        setBrowserStore("tabs", tabId, "error", error instanceof Error ? error.message : "Browser ownership could not be confirmed")
      })
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
  const activeId = browserStore.activeTabId
  const blocked = !!document.querySelector('[data-component="dialog"], [data-component="dock-add-menu"], [role="menu"][data-expanded]')
  for (const [id, s] of frames) {
    const dockID = Object.keys(browserStore.docked).find((key) => browserStore.docked[key] === id)
    const slot = dockID ? frameSlots.get(`dock:${dockID}`) : id === activeId ? frameSlots.get("browser") : undefined
    const activeTab = browserStore.tabs[id]
    const rect = slot?.getBoundingClientRect()
    const hasRect = !!slot && !!rect && rect.width > 0 && rect.height > 0 && slot.getClientRects().length > 0 && getComputedStyle(slot).visibility !== "hidden" && !blocked
    // Never toggle display:none here: a <webview> whose host is display:none
    // attaches its guest at 0x0 (clamped to the 150px default) and fails to
    // resize afterwards. Keep every host display:block; show the active frame
    // over the slot and park inactive frames off-screen with visibility hidden.
    if (hasRect && rect && activeTab?.url) {
      s.host.style.left = `${rect.left}px`
      s.host.style.top = `${rect.top}px`
      s.host.style.width = `${rect.width}px`
      s.host.style.height = `${rect.height}px`
      // Restored desktop guests must load off-screen until Main confirms
      // committed ownership. Geometry/attachment alone is not admission.
      s.host.style.visibility = dockID && s.mode === "webview" && !dockTickets.has(dockID) ? "hidden" : "visible"
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

function trackBrowserFrame(owner: string, element: HTMLElement, visible: () => boolean) {
  const unregister = frameSlots.register(owner, element, visible)
  // Each mount owns its listener closures, even when desktop and mobile slots
  // briefly overlap. Never disconnect the replacement mount's observers.
  const reposition = () => positionFrames()
  const resize = new ResizeObserver(reposition)
  resize.observe(element)
  const mutation = new MutationObserver(reposition)
  mutation.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "hidden", "data-expanded", "data-state", "aria-hidden"] })
  window.addEventListener("resize", reposition)
  window.addEventListener("scroll", reposition, true)
  window.addEventListener("opencode:dock-resize", reposition)
  positionFrames()
  return () => {
    unregister()
    resize.disconnect()
    mutation.disconnect()
    window.removeEventListener("resize", reposition)
    window.removeEventListener("scroll", reposition, true)
    window.removeEventListener("opencode:dock-resize", reposition)
    positionFrames()
  }
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

export async function dockBrowserTab(tabID: string, dockID: string, platform: Platform, save: (url: string) => () => void) {
  return transfers.run(`tab:${tabID}`, () => transferBrowserTab(tabID, dockID, platform, save))
}

async function transferBrowserTab(tabID: string, dockID: string, platform: Platform, save: (url: string) => () => void) {
  if (browserStore.docked[dockID]) throw new Error("The web dock already owns a page")
  const tab = browserStore.tabs[tabID]
  if (!tab || !browserStore.order.includes(tabID) || !tab.url) throw new Error("The browser tab is no longer available")
  const frame = frames.get(tabID)
  // A destroyed guest must fail the transfer honestly instead of crashing the
  // whole renderer action with "Object has been destroyed".
  let webviewID: number | undefined
  try {
    webviewID = frame?.mode === "webview" && frame.ready ? (frame.frame as BrowserWebviewElement).getWebContentsId?.() : undefined
  } catch {
    webviewID = undefined
  }
  let ticket: string | undefined
  if (frame?.mode === "webview") {
    if (!webviewID || !platform.browserTransfer) throw new Error("Desktop browser transfer is unavailable")
    const result = await platform.browserTransfer("reserve", webviewID)
    if (typeof result !== "string") throw new Error("The browser is currently in use")
    ticket = result
  }
  let undoMove: (() => void) | undefined
  let rollback: (() => void) | undefined
  try {
    if (!browserStore.order.includes(tabID)) throw new Error("The browser tab is no longer available")
    const url = frame?.mode === "webview" ? (frame.frame as BrowserWebviewElement).getURL?.() : tab.url
    if (!url || !isAllowedBrowserURL(url)) throw new Error("The browser address is not available")
    const parsed = new URL(url)
    if (parsed.username || parsed.password) throw new Error("Addresses containing credentials cannot be saved")
    if (ticket && webviewID) {
      if (await platform.browserTransfer!("commit", webviewID, ticket) !== true) throw new Error("Browser transfer could not be confirmed")
      dockTickets.set(dockID, { id: webviewID, ticket })
    }
    batch(() => {
      rollback = save(url)
      undoMove = browserRuntime.dock(tabID, dockID)
    })
    positionFrames()
  } catch (error) {
    batch(() => {
      undoMove?.()
      rollback?.()
    })
    dockTickets.delete(dockID)
    if (ticket && webviewID && await platform.browserTransfer!("release", webviewID, ticket) !== true) {
      throw new Error("Browser transfer failed and its desktop reservation could not be released", { cause: error })
    }
    throw error
  }
}

export async function returnBrowserDock(dockID: string, platform: Platform) {
  return transfers.run(`dock:${dockID}`, () => releaseBrowserDock(dockID, platform, false))
}

export async function removeBrowserDock(dockID: string, platform: Platform) {
  return transfers.run(`dock:${dockID}`, () => releaseBrowserDock(dockID, platform, true))
}

async function releaseBrowserDock(dockID: string, platform: Platform, remove: boolean) {
  const tabID = browserStore.docked[dockID]
  if (!tabID) {
    if (!remove) throw new Error("The web dock is not loaded; open it before returning it to the browser")
    return
  }
  const ticket = dockTickets.get(dockID)
  if (ticket && (!platform.browserTransfer || await platform.browserTransfer("release", ticket.id, ticket.ticket) !== true)) {
    throw new Error("Browser transfer could not be released")
  }
  dockTickets.delete(dockID)
  if (remove) {
    disposeFrame(tabID)
    browserRuntime.removeDock(dockID)
    return
  }
  browserRuntime.returnToBrowser(dockID)
  positionFrames()
}

export function navigateBrowserDock(dockID: string, url: string) {
  if (transfers.has(`dock:${dockID}`)) throw new Error("Browser transfer is in progress")
  const id = browserStore.docked[dockID]
  const normalized = normalizeBrowserURL(url)
  if (!normalized) throw new Error("Enter an HTTP(S) address")
  // Hidden definitions may not have created a page yet. Their saved address
  // is consumed on first display; no runtime navigation is needed.
  if (!id) return
  const tab = browserStore.tabs[id]
  if (!tab) throw new Error("The browser page is unavailable")
  setBrowserStore("tabs", id, { url: normalized, currentURL: normalized, draft: normalized, error: "", loading: true, request: tab.request + 1 })
}

export function reloadBrowserDock(dockID: string) {
  if (transfers.has(`dock:${dockID}`)) throw new Error("Browser transfer is in progress")
  const id = browserStore.docked[dockID]
  const frame = id && frames.get(id)
  if (!frame) throw new Error("The browser page is unavailable")
  reloadBrowserFrame(frame.mode === "webview"
    ? { mode: "webview", ready: frame.ready, frame: frame.frame as BrowserWebviewElement }
    : { mode: "iframe", frame: frame.frame as HTMLIFrameElement })
}

export function SessionWebDock(props: { id: string; startURL: string; visible: boolean }) {
  const platform = usePlatform()
  const language = useLanguage()
  const pageState = () => {
    const id = browserStore.docked[props.id]
    return id ? browserStore.tabs[id] : undefined
  }
  let slot: HTMLDivElement | undefined
  const mode = (): BrowserFrameMode => platform.platform === "desktop" && platform.embeddedBrowser === "webview" ? "webview" : "iframe"
  let initialized = false
  createEffect(() => {
    if (initialized) return
    if (browserStore.docked[props.id]) {
      initialized = true
      return
    }
    if (!props.visible) return
    initialized = true
    const tab = createTab()
    setBrowserStore("tabs", tab.id, { ...tab, url: props.startURL, currentURL: props.startURL, draft: props.startURL, request: 1, loading: true })
    setBrowserStore("docked", props.id, tab.id)
    ensureFrame(tab.id, mode(), platform.browserTransfer)
  })
  createEffect(() => {
    void props.visible
    void browserStore.docked[props.id]
    positionFrames()
  })
  onMount(() => {
    if (!slot) return
    onCleanup(trackBrowserFrame(`dock:${props.id}`, slot, () => props.visible && !pageState()?.error))
  })
  return <div data-component="session-web-dock" data-web-dock-id={props.id} class="relative size-full min-h-0 overflow-hidden" ref={slot}>
    <Show when={pageState()?.error}>{(error) => <div role="alert" class="flex size-full flex-col items-start justify-center gap-3 overflow-auto p-4">
      <p class="break-words text-12-regular text-text-weak">{error()}</p>
      <Button size="small" variant="secondary" onClick={() => { navigateBrowserDock(props.id, props.startURL); const id = browserStore.docked[props.id]; if (id) ensureFrame(id, mode(), platform.browserTransfer) }}>{language.t("webDock.start")}</Button>
      <Button size="small" variant="ghost" onClick={() => platform.openLink(props.startURL)}>{language.t("webDock.external")}</Button>
    </div>}</Show>
  </div>
}

function tabTitle(tab: BrowserTab | undefined) {
  if (!tab || !tab.url) return "New tab"
  try {
    return new URL(tab.currentURL || tab.url).host || tab.currentURL || tab.url
  } catch {
    return tab.currentURL || tab.url
  }
}

export function SessionBrowserDock(props: { visible?: boolean; onDock?: (tabID: string, name: string) => Promise<void> }) {
  const platform = usePlatform()
  const language = useLanguage()
  const dialog = useDialog()
  const [docking, setDocking] = createSignal(false)
  createEffect(() => {
    void props.visible
    positionFrames()
  })
  let slotRef: HTMLDivElement | undefined

  const mode = (): BrowserFrameMode =>
    platform.platform === "desktop" && platform.embeddedBrowser === "webview" ? "webview" : "iframe"

  const activeTab = createMemo(() => browserStore.tabs[browserStore.activeTabId])

  const status = (): SessionBrowserStatus => {
    const tab = activeTab()
    const id = browserStore.activeTabId
    const hostStatus = frameStatus(id)
    if (hostStatus.destroyed) return rebuildDestroyedFrame(id)
    return {
      ...hostStatus,
      tabId: id,
      draft: tab?.draft ?? defaultURL,
      url: tab?.currentURL || tab?.url || "",
      error: tab?.error ?? "",
      loading: hostStatus.loading ?? tab?.loading ?? false,
      mode: !tab?.url ? "empty" : mode(),
    }
  }

  // A destroyed webview guest must never poison the dock: the stale frame
  // singleton would throw "Object has been destroyed" on every later native
  // call, so dispose it and create a fresh frame for the same tab. The fresh
  // webview loads the tab's committed URL through the normal load effect, and
  // the caller sees an honest loading status instead of a bridge failure.
  const rebuildDestroyedFrame = (id: string): SessionBrowserStatus => {
    const tab = activeTab()
    disposeFrame(id)
    ensureFrame(id, mode(), platform.browserTransfer)
    positionFrames()
    return {
      tabId: id,
      draft: tab?.draft ?? defaultURL,
      url: tab?.currentURL || tab?.url || "",
      error: "",
      loading: true,
      mode: !tab?.url ? "empty" : mode(),
    }
  }

  const navigateActive = (input: string): SessionBrowserStatus => {
    if (transfers.has(`tab:${browserStore.activeTabId}`)) throw new Error("Browser transfer is in progress")
    const url = normalizeBrowserURL(input)
    if (!url) throw new Error("Browser URL must be http:// or https://")
    const id = browserStore.activeTabId
    ensureFrame(id, mode(), platform.browserTransfer)
    setBrowserStore("tabs", id, { url, draft: url, currentURL: url, error: "", loading: true, request: (browserStore.tabs[id]?.request ?? 0) + 1 })
    return status()
  }

  const load = () => {
    if (transfers.has(`tab:${browserStore.activeTabId}`)) return
    const tab = activeTab()
    if (!tab) return
    const url = normalizeBrowserURL(tab.draft)
    if (!url) {
      setBrowserStore("tabs", browserStore.activeTabId, "error", "Enter an http:// or https:// URL")
      return
    }
    ensureFrame(browserStore.activeTabId, mode(), platform.browserTransfer)
    setBrowserStore("tabs", browserStore.activeTabId, { url, draft: url, currentURL: url, error: "", loading: true, request: tab.request + 1 })
  }

  const activateTab = (id: string) => {
    if (browserStore.activeTabId === id) return
    setBrowserStore("activeTabId", id)
    ensureFrame(id, mode(), platform.browserTransfer)
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
    if (transfers.has(`tab:${id}`)) throw new Error("Browser transfer is in progress")
    const index = browserStore.order.indexOf(id)
    if (index === -1) return
    const nextOrder = browserStore.order.filter((tabId) => tabId !== id)
    const nextTabs = { ...browserStore.tabs }
    delete nextTabs[id]
    if (nextOrder.length === 0) {
      // Always keep at least one tab.
      const fresh = createTab()
      setBrowserStore({ tabs: { ...nextTabs, [fresh.id]: fresh }, order: [fresh.id], activeTabId: fresh.id })
    } else {
      const nextActive = browserStore.activeTabId === id ? nextOrder[Math.min(index, nextOrder.length - 1)] : browserStore.activeTabId
      setBrowserStore({ tabs: nextTabs, order: nextOrder, activeTabId: nextActive })
    }
    disposeFrame(id)
    positionFrames()
  }

  onMount(() => {
    ensureFrame(browserStore.activeTabId, mode(), platform.browserTransfer)
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
        ensureFrame(tab.id, mode(), platform.browserTransfer)
        positionFrames()
        return { ...status(), tabId: tab.id }
      },
      closeTab(tabId) {
        const id = tabId ?? browserStore.activeTabId
        if (!browserStore.tabs[id] || !browserStore.order.includes(id)) return { closed: false }
        closeTab(id)
        return { closed: true, tabId: id }
      },
      status,
    })
    const untrackFrame = slotRef ? trackBrowserFrame("browser", slotRef, () => props.visible !== false) : () => {}
    onCleanup(() => {
      unregister()
      untrackFrame()
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
        <Button type="button" size="small" variant="ghost" disabled={!activeTab()?.url || activeTab()?.loading || !props.onDock || docking()} onClick={() => {
          const tabID = browserStore.activeTabId
          const tab = browserStore.tabs[tabID]
          if (!tab?.url || !props.onDock) return
          const name = tabTitle(tab)
          dialog.show(() => <DialogWebDock title={language.t("webDock.create")} label={language.t("webDock.name")} initial={name} hint={mode() === "iframe" ? language.t("webDock.webHint") : undefined} onSubmit={async (value) => {
            setDocking(true)
            try { await props.onDock!(tabID, value) } finally { setDocking(false) }
          }} />)
        }}>Dock</Button>
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
