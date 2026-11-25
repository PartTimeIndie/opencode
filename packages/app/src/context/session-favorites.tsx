import type { Session } from "@opencode-ai/sdk/v2/client"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createEffect, createMemo, untrack } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"
import { ServerConnection, useServer } from "./server"
import { useGlobal } from "./global"

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
}

// The same session reaches this store with different directory strings (tab vs. session directory,
// drive letter, casing), so only the server-scoped session id identifies a favorite. `directory`
// is a routing hint.
export function sessionFavoriteKey(input: Pick<SessionFavorite, "server" | "id">) {
  return `${input.server}\n${input.id}`
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
      createStore<SessionFavoriteStore>({ items: {} }),
    )
    const migratedProtection = new Set<ServerConnection.Key>()

    const all = createMemo(() => Object.values(store.items).toSorted(compareFavorites))
    const keys = createMemo(() => new Set(Object.keys(store.items)))

    const setRemoteProtection = async (input: Pick<SessionFavorite, "server" | "directory" | "id">, protectedState: boolean) => {
      const conn = global.servers.list().find((item) => ServerConnection.key(item) === input.server)
      if (!conn) throw new Error(`Server is not available: ${input.server}`)
      await global
        .createServerCtx(conn)
        .sdk.createDirSdkContext(input.directory)
        .client.session.protection({ sessionID: input.id, protected: protectedState })
    }

    // Protection only keeps the server from cleaning up a favorited session, so it is best-effort:
    // a failed call is logged and never rolls the favorite back.
    const migrateProtection = async (key: ServerConnection.Key) => {
      for (const favorite of all().filter((item) => item.server === key)) {
        await setRemoteProtection(favorite, true).catch((error) => {
          console.warn("[session-protection] failed to migrate favorite", { favorite, error })
        })
      }
    }

    const isFavorite = (input: Pick<SessionFavorite, "server" | "directory" | "id">) =>
      keys().has(sessionFavoriteKey(input))

    const setFavorite = (input: SessionFavorite, favorite = true) => {
      const changed = isFavorite(input) !== favorite
      setStore(reconcile(updateSessionFavoriteStore(store, input, favorite)))
      if (!changed) return
      void setRemoteProtection(input, favorite).catch((error) => {
        console.warn("[session-protection] failed to update favorite protection", { input, favorite, error })
      })
    }

    createEffect(() => {
      if (!ready()) return
      const conn = server.current
      if (!conn) return
      const key = ServerConnection.key(conn)
      if (migratedProtection.has(key)) return
      migratedProtection.add(key)
      untrack(() => {
        void migrateProtection(key)
      })
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

export function migrateSessionFavoriteStore(value: unknown): SessionFavoriteStore {
  const input = isRecord(value) ? value : {}
  const items: Record<string, SessionFavorite> = {}
  if (isRecord(input.items)) {
    // Legacy stores kept one session under every directory it was favorited from; the newest
    // entry wins and an exact tie keeps the later one.
    for (const entry of Object.values(input.items)) {
      const item = parseStoredFavorite(entry)
      if (!item) continue
      const key = sessionFavoriteKey(item)
      if (!items[key] || favoriteTime(item) >= favoriteTime(items[key])) items[key] = item
    }
  }
  return { items }
}

export function updateSessionFavoriteStore(
  store: SessionFavoriteStore,
  input: SessionFavorite,
  favorite = true,
): SessionFavoriteStore {
  const item = normalizeFavorite(input)
  const key = sessionFavoriteKey(item)
  const items = { ...store.items }
  if (!favorite) {
    delete items[key]
    return { items }
  }
  // Callers pass only the fields they know: undefined keeps the stored value, parentID: null replaces it.
  const previous = items[key]
  items[key] = {
    server: item.server,
    directory: item.directory,
    id: item.id,
    parentID: item.parentID === undefined ? previous?.parentID : item.parentID,
    title: item.title === undefined ? previous?.title : item.title,
    slug: item.slug === undefined ? previous?.slug : item.slug,
    time: item.time === undefined ? previous?.time : item.time,
  }
  return { items }
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

function favoriteTime(item: SessionFavorite) {
  const time = item.time?.updated ?? item.time?.created
  return typeof time === "number" ? time : 0
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
  return favoriteTime(b) - favoriteTime(a) || a.id.localeCompare(b.id)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
