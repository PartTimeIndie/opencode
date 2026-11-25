import { batch } from "solid-js"
import { createStore } from "solid-js/store"

export type BrowserTab = {
  id: string
  draft: string
  url: string
  currentURL: string
  error: string
  loading: boolean
  request: number
}

type BrowserState = {
  tabs: Record<string, BrowserTab>
  order: string[]
  activeTabId: string
  docked: Record<string, string>
}

// Ownership is independent of both DOM mounts and URL identity. Frames can stay
// alive while desktop/mobile panes and session shells are replaced.
export function createSessionBrowserRuntime(defaultURL: string) {
  let sequence = 0
  const createTab = (): BrowserTab => ({
    id: `bt-${++sequence}`, draft: defaultURL, url: "", currentURL: "", error: "", loading: false, request: 0,
  })
  const initial = createTab()
  const [browserStore, setBrowserStore] = createStore<BrowserState>({
    tabs: { [initial.id]: initial }, order: [initial.id], activeTabId: initial.id, docked: {},
  })
  return {
    browserStore,
    setBrowserStore,
    createTab,
    dock(tabID: string, dockID: string) {
      if (!browserStore.order.includes(tabID) || !browserStore.tabs[tabID]?.url) throw new Error("The browser tab is no longer available")
      if (browserStore.docked[dockID]) throw new Error("The web dock already owns a page")
      const order = [...browserStore.order]
      const active = browserStore.activeTabId
      const remaining = order.filter((id) => id !== tabID)
      const fresh = remaining.length ? undefined : createTab()
      batch(() => {
        if (fresh) {
          setBrowserStore("tabs", fresh.id, fresh)
          remaining.push(fresh.id)
        }
        setBrowserStore("docked", dockID, tabID)
        setBrowserStore("order", remaining)
        if (active === tabID) setBrowserStore("activeTabId", remaining[0]!)
      })
      return () => {
        if (browserStore.docked[dockID] !== tabID) return
        batch(() => {
          setBrowserStore("docked", dockID, undefined!)
          setBrowserStore("order", order)
          setBrowserStore("activeTabId", active)
          if (fresh) setBrowserStore("tabs", fresh.id, undefined!)
        })
      }
    },
    returnToBrowser(dockID: string) {
      const tabID = browserStore.docked[dockID]
      if (!tabID) return
      batch(() => {
        setBrowserStore("docked", dockID, undefined!)
        setBrowserStore("order", (order) => [...order, tabID])
        setBrowserStore("activeTabId", tabID)
      })
      return tabID
    },
    removeDock(dockID: string) {
      const tabID = browserStore.docked[dockID]
      if (!tabID) return
      batch(() => {
        setBrowserStore("docked", dockID, undefined!)
        setBrowserStore("tabs", tabID, undefined!)
      })
      return tabID
    },
  }
}
