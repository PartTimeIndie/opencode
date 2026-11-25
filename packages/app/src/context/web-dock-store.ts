import { createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import type { Platform } from "./platform"
import { Persist, persisted } from "@/utils/persist"
import { findWebDockOrphans, hydrateWebDockStore, readWebDockItems, validateWebDock, type WebDockDefinition, type WebDockStore } from "./web-dock-data"

export function createWebDockStore(platform: Platform) {
  const [store, setStore, _, ready] = persisted(
    { ...Persist.global("web-docks.v1"), hydrate: hydrateWebDockStore },
    createStore<WebDockStore>({ version: 1, items: {} }),
    platform,
  )
  const items = createMemo(() => readWebDockItems(store))
  const writable = () => ready() && store.version === 1 && !!store.items && typeof store.items === "object" && !Array.isArray(store.items)
  return {
    items,
    ready,
    writable,
    invalidCount: () => writable() ? Object.keys(store.items).length - items().length : 0,
    orphans: (paneIDs: string[]) => ready() ? findWebDockOrphans(store, paneIDs) : [],
    put(input: WebDockDefinition) {
      if (!writable()) throw new Error("Web dock storage is unavailable or uses a newer version")
      const item = validateWebDock(input)
      if (!item) throw new Error("Enter a name and a valid HTTP(S) address without credentials")
      setStore("items", item.id, item)
      return item
    },
    remove(id: string) {
      if (!writable()) throw new Error("Web dock storage is unavailable or uses a newer version")
      setStore("items", id, undefined!)
    },
  }
}
