export type WebDockDefinition = { id: string; name: string; startURL: string }
export type WebDockStore = { version: number; items: Record<string, WebDockDefinition> }

export function hydrateWebDockStore(raw: string): WebDockStore {
  try {
    const value: unknown = JSON.parse(raw)
    if (
      value && typeof value === "object" &&
      "version" in value && value.version === 1 &&
      "items" in value && value.items && typeof value.items === "object" && !Array.isArray(value.items)
    ) return value as WebDockStore
  } catch {}
  // This sentinel exists only in memory. The raw corrupt/future envelope stays
  // untouched, and version checks prohibit both writes and orphan repair.
  return { version: 0, items: {} }
}

export function validateWebDock(value: WebDockDefinition) {
  const name = value.name.trim()
  if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) return
  if (!/^[a-zA-Z0-9-]+$/.test(value.id)) return
  if (!URL.canParse(value.startURL)) return
  const url = new URL(value.startURL)
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return
  return { id: value.id, name, startURL: url.toString() }
}

export function findWebDockOrphans(store: WebDockStore, paneIDs: string[]) {
  if (store.version !== 1 || !store.items || typeof store.items !== "object" || Array.isArray(store.items)) return []
  // Keep malformed records for recovery. Only genuinely missing definitions
  // authorize removing this feature's own layout entries.
  return [...new Set(paneIDs)].filter((id) => id.startsWith("web-dock:") && !Object.hasOwn(store.items, id.slice("web-dock:".length)))
}

export function readWebDockItems(store: WebDockStore) {
  if (store.version !== 1 || !store.items || typeof store.items !== "object" || Array.isArray(store.items)) return []
  return Object.entries(store.items).flatMap(([id, value]) => {
    if (!value || typeof value !== "object" || value.id !== id || typeof value.name !== "string" || typeof value.startURL !== "string") return []
    const item = validateWebDock(value)
    return item ? [item] : []
  })
}
