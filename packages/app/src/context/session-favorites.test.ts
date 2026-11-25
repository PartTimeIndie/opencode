import { describe, expect, test } from "bun:test"
import { ServerConnection } from "./server"
import {
  migrateSessionFavoriteStore,
  sessionFavoriteKey,
  updateSessionFavoriteStore,
  type SessionFavorite,
  type SessionFavoriteStore,
} from "./session-favorites"

const server = ServerConnection.Key.make("server-a")
const empty: SessionFavoriteStore = { items: {} }

describe("session favorite identity", () => {
  test("keeps one entry per server and session id across directories and casing", () => {
    const first: SessionFavorite = { server, directory: "C:\\GitRepros\\opencode", id: "ses_same", title: "Same" }
    const second: SessionFavorite = { server, directory: "e:/GITREPROS/OpenCode", id: "ses_same", slug: "second" }

    const store = updateSessionFavoriteStore(updateSessionFavoriteStore(empty, first), second)

    expect(Object.keys(store.items)).toEqual([`${server}\nses_same`])
    expect(store.items[sessionFavoriteKey(first)]).toEqual({
      server,
      directory: "e:/GITREPROS/OpenCode",
      id: "ses_same",
      title: "Same",
      slug: "second",
    })
    expect(empty.items).toEqual({})
  })

  test("keeps the same session id on another server as a separate entry", () => {
    const other = ServerConnection.Key.make("server-b")
    const favorite: SessionFavorite = { server, directory: "C:/GitRepros/opencode", id: "ses_same" }

    const store = updateSessionFavoriteStore(updateSessionFavoriteStore(empty, favorite), {
      ...favorite,
      server: other,
    })

    expect(Object.keys(store.items)).toEqual([`${server}\nses_same`, `${other}\nses_same`])
  })

  test("removes by session id regardless of the directory passed", () => {
    const favorite: SessionFavorite = {
      server,
      directory: "C:\\GitRepros\\opencode",
      id: "ses_remove",
      title: "Remove",
    }
    const store = updateSessionFavoriteStore(empty, favorite)

    const removed = updateSessionFavoriteStore(store, { ...favorite, directory: "E:/GitRepros/opencode" }, false)

    expect(removed.items).toEqual({})
    // A removed favorite leaves nothing behind that a later load could merge back in.
    expect(Object.keys(JSON.parse(JSON.stringify(removed)))).toEqual(["items"])
    expect(store.items[sessionFavoriteKey(favorite)]).toEqual(favorite)
    expect(updateSessionFavoriteStore(store, { ...favorite, id: "ses_other" }, false).items).toEqual(store.items)
  })
})

describe("session favorite migration", () => {
  test("collapses composite-keyed legacy items to one entry per id: newest wins, later entry wins ties", () => {
    const newer: SessionFavorite = {
      server,
      directory: "E:\\GitRepros\\opencode",
      id: "ses_dup",
      title: "E drive",
      time: { created: 1_700_000_000_000, updated: 1_700_000_000_200 },
    }
    const older: SessionFavorite = {
      server,
      directory: "C:\\GitRepros\\opencode",
      id: "ses_dup",
      title: "C drive",
      time: { created: 1_700_000_000_000, updated: 1_700_000_000_100 },
    }
    const tieFirst: SessionFavorite = { server, directory: "C:\\GitRepros\\opencode", id: "ses_tie", title: "First" }
    const tieLater: SessionFavorite = { server, directory: "E:\\GitRepros\\opencode", id: "ses_tie", title: "Later" }
    const single: SessionFavorite = { server, directory: "E:\\GitRepros\\opencode", id: "ses_single" }
    const gone: SessionFavorite = { server, directory: "C:\\GitRepros\\opencode", id: "ses_gone" }
    const legacyKey = (item: SessionFavorite) => `${item.server}\n${item.directory.replaceAll("\\", "/")}\n${item.id}`

    const migrated = migrateSessionFavoriteStore({
      items: {
        [legacyKey(newer)]: newer,
        [legacyKey(older)]: older,
        [legacyKey(tieFirst)]: tieFirst,
        [legacyKey(tieLater)]: tieLater,
        [legacyKey(single)]: single,
      },
      tombstones: { [legacyKey(gone)]: 4 },
      generation: 4,
    })

    expect(migrated).toEqual({
      items: {
        [sessionFavoriteKey(newer)]: newer,
        [sessionFavoriteKey(tieLater)]: tieLater,
        [sessionFavoriteKey(single)]: single,
      },
    })
    expect(Object.keys(migrated)).toEqual(["items"])
    expect(migrateSessionFavoriteStore(migrated)).toEqual(migrated)
  })

  test("sanitizes null, non-object, and invalid persisted entries", () => {
    const valid: SessionFavorite = { server, directory: "C:/valid", id: "ses_valid", title: "Valid" }

    expect(migrateSessionFavoriteStore(null)).toEqual({ items: {} })
    expect(migrateSessionFavoriteStore([])).toEqual({ items: {} })
    expect(migrateSessionFavoriteStore({ items: null, tombstones: null, generation: null })).toEqual({ items: {} })
    expect(migrateSessionFavoriteStore({ items: [valid] })).toEqual({ items: {} })

    const migrated = migrateSessionFavoriteStore({
      items: {
        valid,
        nothing: null,
        missingServer: { directory: "C:/invalid", id: "ses_invalid" },
        missingDirectory: { server: "server-a", id: "ses_invalid" },
        missingId: { server: "server-a", directory: "C:/invalid" },
        blank: { server: "server-a", directory: "  ", id: "ses_blank" },
        untyped: { server: "server-a", directory: "C:/invalid", id: "ses_untyped", parentID: 7, title: 5, time: "now" },
      },
    })

    expect(migrated.items).toEqual({
      [sessionFavoriteKey(valid)]: valid,
      [`${server}\nses_untyped`]: { server, directory: "C:/invalid", id: "ses_untyped" },
    })
  })
})

describe("session favorite updates", () => {
  test("keeps stored fields on a partial update and lets parentID: null replace the stored parent", () => {
    const stored: SessionFavorite = {
      server,
      directory: "C:\\GitRepros\\opencode",
      id: "ses_partial",
      parentID: "ses_parent",
      title: "Title",
      slug: "slug",
      time: { created: 1_700_000_000_000, updated: 1_700_000_000_050 },
    }
    const key = sessionFavoriteKey(stored)

    const refreshed = updateSessionFavoriteStore(updateSessionFavoriteStore(empty, stored), {
      server,
      directory: "E:\\GitRepros\\opencode",
      id: "ses_partial",
    })

    expect(refreshed.items[key]).toEqual({ ...stored, directory: "E:\\GitRepros\\opencode" })

    const detached = updateSessionFavoriteStore(refreshed, {
      server,
      directory: "E:\\GitRepros\\opencode",
      id: "ses_partial",
      parentID: null,
    })

    expect(detached.items[key]).toEqual({ ...stored, directory: "E:\\GitRepros\\opencode", parentID: null })
    expect(stored.parentID).toBe("ses_parent")
  })
})
