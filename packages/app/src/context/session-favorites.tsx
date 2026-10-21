import type { Session } from "@opencode-ai/sdk/v2/client"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createEffect, createMemo, onCleanup, untrack } from "solid-js"
import { createStore, reconcile, type SetStoreFunction } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"
import { pathKey } from "@/utils/path-key"
import { ServerConnection, useServer } from "./server"
import { useGlobal } from "./global"
import { readAppState, writeAppState } from "@/utils/app-state"

export type SessionFavorite = {
  server: ServerConnection.Key
  directory: string
  id: string
  parentID?: string | null
  title?: string
  slug?: string
  time?: Session["time"]
}

export type SessionFavoriteStore = {
  items: Record<string, SessionFavorite>
  // A server may not have loaded its shared state yet, so deletions must outlive the local item.
  tombstones: Record<string, number>
  generation: number
}

const LEGACY_PLUGIN_FAVORITES_KEY = "opencode.app-plugin.session-navigator-app.favorites.v1"
const LEGACY_IMPORT_KEY = "opencode.session-favorites.imported.session-navigator-app.v1"
const SHARED_FAVORITES_STATE_KEY = "session-favorites.v1"

export function sessionFavoriteKey(input: Pick<SessionFavorite, "server" | "directory" | "id">) {
  return `${input.server}\n${pathKey(input.directory)}\n${input.id}`
}

export function sessionFavoriteFromSession(input: {
  server: ServerConnection.Key
  directory: string
  session: Session
}): SessionFavorite {
  return normalizeFavorite({
    server: input.server,
    directory: input.directory,
    id: input.session.id,
    parentID: input.session.parentID ?? null,
    title: input.session.title,
    slug: input.session.slug,
    time: input.session.time,
  })
}

export const { use: useSessionFavorites, provider: SessionFavoritesProvider } = createSimpleContext({
  name: "SessionFavorites",
  gate: false,
  init: () => {
    const server = useServer()
    const global = useGlobal()
    const [store, setStore, _, ready] = persisted(
      {
        ...Persist.global("session-favorites", ["session-favorites.v1"]),
        migrate: migrateSessionFavoriteStore,
      },
      createStore<SessionFavoriteStore>({ items: {}, tombstones: {}, generation: 0 }),
    )
    const loadedSharedFavorites = new Set<ServerConnection.Key>()
    const loadingSharedFavorites = new Set<ServerConnection.Key>()
    const migratedProtection = new Set<string>()
    const migratingProtection = new Set<ServerConnection.Key>()

    const all = createMemo(() => Object.values(store.items).toSorted(compareFavorites))
    const keys = createMemo(() => new Set(Object.keys(store.items)))

    const protectionKey = (input: Pick<SessionFavorite, "server" | "directory" | "id">) =>
      `${sessionFavoriteKey(input)}\nprotection`

    const setRemoteProtection = async (input: Pick<SessionFavorite, "server" | "directory" | "id">, protectedState: boolean) => {
      const conn = global.servers.list().find((item) => ServerConnection.key(item) === input.server)
      if (!conn) throw new Error(`Server is not available: ${input.server}`)
      await global
        .createServerCtx(conn)
        .sdk.createDirSdkContext(input.directory)
        .client.session.protection({ sessionID: input.id, protected: protectedState })
    }

    const migrateProtection = async (key: ServerConnection.Key, favorites: SessionFavorite[]) => {
      if (migratingProtection.has(key)) return
      migratingProtection.add(key)
      try {
        for (const favorite of favorites) {
          const migrationKey = protectionKey(favorite)
          if (migratedProtection.has(migrationKey)) continue
          try {
            await setRemoteProtection(favorite, true)
            migratedProtection.add(migrationKey)
          } catch (error) {
            console.warn("[session-protection] failed to migrate favorite", { favorite, error })
          }
        }
      } finally {
        migratingProtection.delete(key)
      }
    }

    const setFavorite = (input: SessionFavorite, favorite = true) => {
      const previous = isFavorite(input)
      setStore(reconcile(updateSessionFavoriteStore(store, input, favorite)))
      if (previous === favorite) return
      void setRemoteProtection(input, favorite).catch((error) => {
        if (isFavorite(input) === favorite) setStore(reconcile(updateSessionFavoriteStore(store, input, previous)))
        console.warn("[session-protection] failed to update favorite protection", { input, favorite, error })
      })
    }

    const isFavorite = (input: Pick<SessionFavorite, "server" | "directory" | "id">) =>
      keys().has(sessionFavoriteKey(input))

    createEffect(() => {
      if (!ready()) return
      importLegacyPluginFavorites(server.key, store.tombstones, setStore)
    })

    createEffect(() => {
      if (!ready()) return
      const conn = server.current
      if (!conn) return
      const key = ServerConnection.key(conn)
      if (loadedSharedFavorites.has(key) || loadingSharedFavorites.has(key)) return
      loadingSharedFavorites.add(key)

      void (async () => {
        const readback = prepareSharedFavoriteWriteback(store, key)
        const remote = parseSharedFavorites(await readAppState(conn.http, SHARED_FAVORITES_STATE_KEY), key)
        const next = reconcileSharedFavoriteStore(store, key, remote)
        const merged = Object.values(next.items).filter((item) => item.server === key)
        setStore(reconcile(next))
        if (sharedFavoritesSnapshot(remote) === sharedFavoritesSnapshot(merged)) {
          setStore(reconcile(acknowledgeSharedFavoriteWriteback(store, readback.tombstones)))
          return
        }
        await commitSharedFavoriteWriteback({
          current: () => store,
          writeback: prepareSharedFavoriteWriteback(next, key),
          write: (favorites) =>
            writeAppState(conn.http, SHARED_FAVORITES_STATE_KEY, { items: favorites.map(sharedFavorite) }),
          apply: (value) => setStore(reconcile(value)),
        })
      })()
        .catch((error) => console.warn("[app-state] failed to load shared favorites", error))
        .finally(() => {
          loadedSharedFavorites.add(key)
          loadingSharedFavorites.delete(key)
        })
    })

    createEffect(() => {
      if (!ready()) return
      const conn = server.current
      if (!conn) return
      const key = ServerConnection.key(conn)
      if (!loadedSharedFavorites.has(key)) return
      void migrateProtection(key, all().filter((item) => item.server === key))
    })

    createEffect(() => {
      if (!ready()) return
      const conn = server.current
      if (!conn) return
      const key = ServerConnection.key(conn)
      if (!loadedSharedFavorites.has(key)) return
      const favorites = all().filter((item) => item.server === key)
      const generation = store.generation
      const writeback = untrack(() => ({
        ...prepareSharedFavoriteWriteback(store, key),
        favorites,
        generation,
      }))
      const timer = setTimeout(() => {
        void commitSharedFavoriteWriteback({
          current: () => store,
          writeback,
          write: (items) =>
            writeAppState(conn.http, SHARED_FAVORITES_STATE_KEY, { items: items.map(sharedFavorite) }),
          apply: (value) => setStore(reconcile(value)),
        }).catch((error) => console.warn("[app-state] failed to save shared favorites", error))
      }, 250)
      onCleanup(() => clearTimeout(timer))
    })

    return {
      ready,
      list: all,
      byServer: (key: ServerConnection.Key) => all().filter((item) => item.server === key),
      is: isFavorite,
      set: setFavorite,
      remove: (input: SessionFavorite) => setFavorite(input, false),
      toggle(input: SessionFavorite) {
        const next = !isFavorite(input)
        setFavorite(input, next)
        return next
      },
    }
  },
})

export type SharedFavoriteWriteback = {
  favorites: SessionFavorite[]
  tombstones: Record<string, number>
  generation: number
}

export function migrateSessionFavoriteStore(value: unknown): SessionFavoriteStore {
  const input = isRecord(value) ? value : {}
  const items: Record<string, SessionFavorite> = {}
  if (isRecord(input.items)) {
    for (const value of Object.values(input.items)) {
      const item = parseStoredFavorite(value)
      if (item) items[sessionFavoriteKey(item)] = item
    }
  }

  const tombstones: Record<string, number> = {}
  const storedGeneration = validGeneration(input.generation) ? input.generation : 0
  const state = { generation: storedGeneration }
  if (isRecord(input.tombstones)) {
    for (const [rawKey, value] of Object.entries(input.tombstones)) {
      const key = normalizeTombstoneKey(rawKey)
      if (!key) continue
      if (value === true) {
        state.generation++
        tombstones[key] = state.generation
        continue
      }
      if (!validGeneration(value) || value === 0) continue
      state.generation = Math.max(state.generation, value)
      tombstones[key] = Math.max(tombstones[key] ?? 0, value)
    }
  }
  for (const key of Object.keys(tombstones)) delete items[key]
  return { items, tombstones, generation: state.generation }
}

export function prepareSharedFavoriteWriteback(
  store: SessionFavoriteStore,
  server: ServerConnection.Key,
): SharedFavoriteWriteback {
  const prefix = `${server}\n`
  return {
    favorites: Object.values(store.items).filter((item) => item.server === server).toSorted(compareFavorites),
    tombstones: Object.fromEntries(Object.entries(store.tombstones).filter(([key]) => key.startsWith(prefix))),
    generation: store.generation,
  }
}

export function acknowledgeSharedFavoriteWriteback(
  store: SessionFavoriteStore,
  acknowledgement: Record<string, number>,
): SessionFavoriteStore {
  const tombstones = { ...store.tombstones }
  for (const [key, generation] of Object.entries(acknowledgement)) {
    if (tombstones[key] === generation) delete tombstones[key]
  }
  return { items: { ...store.items }, tombstones, generation: store.generation }
}

export async function commitSharedFavoriteWriteback(input: {
  current: () => SessionFavoriteStore
  writeback: SharedFavoriteWriteback
  write: (favorites: SessionFavorite[]) => Promise<unknown>
  apply: (store: SessionFavoriteStore) => void
}) {
  await input.write(input.writeback.favorites)
  input.apply(acknowledgeSharedFavoriteWriteback(input.current(), input.writeback.tombstones))
}

export function updateSessionFavoriteStore(
  store: SessionFavoriteStore,
  input: SessionFavorite,
  favorite = true,
): SessionFavoriteStore {
  const item = normalizeFavorite(input)
  const key = sessionFavoriteKey(item)
  const items = { ...store.items }
  const tombstones = { ...store.tombstones }
  if (!favorite) {
    const generation = store.generation + 1
    delete items[key]
    tombstones[key] = generation
    return { items, tombstones, generation }
  }
  items[key] = item
  delete tombstones[key]
  return { items, tombstones, generation: store.generation }
}

export function reconcileSharedFavoriteStore(
  store: SessionFavoriteStore,
  server: ServerConnection.Key,
  remote: SessionFavorite[],
): SessionFavoriteStore {
  const local = Object.values(store.items).filter((item) => item.server === server)
  const merged = mergeFavorites(remote, local).filter((item) => !store.tombstones[sessionFavoriteKey(item)])
  const items = Object.fromEntries(Object.entries(store.items).filter(([, item]) => item.server !== server))
  for (const item of merged) items[sessionFavoriteKey(item)] = item
  return { items, tombstones: { ...store.tombstones }, generation: store.generation }
}

function parseStoredFavorite(value: unknown) {
  if (!isRecord(value)) return
  if (typeof value.server !== "string" || !value.server.trim()) return
  if (typeof value.directory !== "string" || !value.directory.trim()) return
  if (typeof value.id !== "string" || !value.id.trim()) return
  return normalizeFavorite({
    server: ServerConnection.Key.make(value.server),
    directory: value.directory,
    id: value.id,
    parentID: typeof value.parentID === "string" || value.parentID === null ? value.parentID : undefined,
    title: typeof value.title === "string" ? value.title : undefined,
    slug: typeof value.slug === "string" ? value.slug : undefined,
    time: isRecord(value.time) ? (value.time as Session["time"]) : undefined,
  })
}

function normalizeTombstoneKey(value: string) {
  const parts = value.split("\n")
  if (parts.length !== 3 || parts.some((part) => !part.trim())) return
  return sessionFavoriteKey({ server: ServerConnection.Key.make(parts[0]), directory: parts[1], id: parts[2] })
}

function validGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function normalizeFavorite(input: SessionFavorite): SessionFavorite {
  return {
    server: input.server,
    directory: input.directory,
    id: input.id,
    parentID: input.parentID,
    title: input.title,
    slug: input.slug,
    time: input.time,
  }
}

function compareFavorites(a: SessionFavorite, b: SessionFavorite) {
  return (b.time?.updated ?? b.time?.created ?? 0) - (a.time?.updated ?? a.time?.created ?? 0) || a.id.localeCompare(b.id)
}

function sharedFavorite(input: SessionFavorite) {
  return {
    directory: input.directory,
    id: input.id,
    parentID: input.parentID,
    title: input.title,
    slug: input.slug,
    time: input.time,
  }
}

function sharedFavoritesSnapshot(items: SessionFavorite[]) {
  return JSON.stringify(
    items
      .map(sharedFavorite)
      .toSorted(
        (a, b) => pathKey(a.directory).localeCompare(pathKey(b.directory)) || a.id.localeCompare(b.id),
      ),
  )
}

function parseSharedFavorites(value: unknown, server: ServerConnection.Key) {
  if (!isRecord(value) || !Array.isArray(value.items)) return []
  return value.items.flatMap((item): SessionFavorite[] => {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.directory !== "string") return []
    return [
      normalizeFavorite({
        server,
        directory: item.directory,
        id: item.id,
        parentID: typeof item.parentID === "string" || item.parentID === null ? item.parentID : undefined,
        title: typeof item.title === "string" ? item.title : undefined,
        slug: typeof item.slug === "string" ? item.slug : undefined,
        time: isRecord(item.time) ? (item.time as Session["time"]) : undefined,
      }),
    ]
  })
}

function mergeFavorites(primary: SessionFavorite[], secondary: SessionFavorite[]) {
  const result = new Map<string, SessionFavorite>()
  for (const item of [...secondary, ...primary]) {
    result.set(sessionFavoriteKey(item), item)
  }
  return [...result.values()].toSorted(compareFavorites)
}

function importLegacyPluginFavorites(
  server: ServerConnection.Key,
  tombstones: Record<string, number>,
  setStore: SetStoreFunction<SessionFavoriteStore>,
) {
  if (typeof localStorage === "undefined") return
  if (localStorage.getItem(LEGACY_IMPORT_KEY)) return
  for (const item of readLegacyPluginFavorites(server)) {
    if (tombstones[sessionFavoriteKey(item)]) continue
    setStore("items", sessionFavoriteKey(item), item)
  }
  localStorage.setItem(LEGACY_IMPORT_KEY, "true")
}

function readLegacyPluginFavorites(server: ServerConnection.Key) {
  if (typeof localStorage === "undefined") return []
  const raw = localStorage.getItem(LEGACY_PLUGIN_FAVORITES_KEY)
  if (!raw) return []
  try {
    const value = JSON.parse(raw) as unknown
    if (!isRecord(value)) return []
    return Object.values(value).flatMap((item) => {
      if (!isRecord(item) || typeof item.id !== "string" || typeof item.directory !== "string") return []
      return normalizeFavorite({
        server,
        directory: item.directory,
        id: item.id,
        parentID: typeof item.parentID === "string" || item.parentID === null ? item.parentID : undefined,
        title: typeof item.title === "string" ? item.title : undefined,
        slug: typeof item.slug === "string" ? item.slug : undefined,
        time: isRecord(item.time) ? (item.time as Session["time"]) : undefined,
      })
    })
  } catch {
    return []
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
