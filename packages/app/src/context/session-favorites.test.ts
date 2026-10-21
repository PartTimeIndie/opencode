import { describe, expect, test } from "bun:test"
import { ServerConnection } from "./server"
import {
  acknowledgeSharedFavoriteWriteback,
  commitSharedFavoriteWriteback,
  migrateSessionFavoriteStore,
  prepareSharedFavoriteWriteback,
  reconcileSharedFavoriteStore,
  sessionFavoriteKey,
  updateSessionFavoriteStore,
  type SessionFavorite,
  type SessionFavoriteStore,
} from "./session-favorites"

describe("session favorite tombstones", () => {
  test("does not resurrect an inactive server-A favorite when A shared state loads later", () => {
    const serverA = ServerConnection.Key.make("server-a")
    const serverB = ServerConnection.Key.make("server-b")
    const directory = "C:/shared/project"
    const favoriteA: SessionFavorite = { server: serverA, directory, id: "ses_same", title: "Server A" }
    const favoriteB: SessionFavorite = { server: serverB, directory, id: "ses_same", title: "Server B" }
    const initial: SessionFavoriteStore = {
      items: {
        [sessionFavoriteKey(favoriteA)]: favoriteA,
        [sessionFavoriteKey(favoriteB)]: favoriteB,
      },
      tombstones: {},
      generation: 0,
    }

    const removedOnB = updateSessionFavoriteStore(initial, favoriteA, false)
    const persisted = JSON.parse(JSON.stringify(removedOnB)) as SessionFavoriteStore
    const afterSwitchToA = reconcileSharedFavoriteStore(persisted, serverA, [favoriteA])

    expect(afterSwitchToA.items[sessionFavoriteKey(favoriteA)]).toBeUndefined()
    expect(afterSwitchToA.items[sessionFavoriteKey(favoriteB)]).toEqual(favoriteB)
    expect(afterSwitchToA.tombstones[sessionFavoriteKey(favoriteA)]).toBeGreaterThan(0)
    expect(afterSwitchToA.tombstones[sessionFavoriteKey(favoriteB)]).toBeUndefined()
  })

  test("clears only the exact owner tombstone when the user favorites the session again", () => {
    const serverA = ServerConnection.Key.make("server-a")
    const serverB = ServerConnection.Key.make("server-b")
    const directory = "C:/shared/project"
    const favoriteA: SessionFavorite = { server: serverA, directory, id: "ses_same" }
    const favoriteB: SessionFavorite = { server: serverB, directory, id: "ses_same" }
    const removedA = updateSessionFavoriteStore(
      updateSessionFavoriteStore({ items: {}, tombstones: {}, generation: 0 }, favoriteB, false),
      favoriteA,
      false,
    )
    const restoredA = updateSessionFavoriteStore(removedA, favoriteA)

    expect(restoredA.items[sessionFavoriteKey(favoriteA)]).toEqual(favoriteA)
    expect(restoredA.tombstones[sessionFavoriteKey(favoriteA)]).toBeUndefined()
    expect(restoredA.tombstones[sessionFavoriteKey(favoriteB)]).toBeGreaterThan(0)
  })

  test("sanitizes null, non-object, and invalid persisted entries", () => {
    const server = ServerConnection.Key.make("server-a")
    const valid: SessionFavorite = { server, directory: "C:/valid", id: "ses_valid", title: "Valid" }
    const deleted: SessionFavorite = { server, directory: "C:/deleted", id: "ses_deleted" }
    const deletedKey = sessionFavoriteKey(deleted)

    expect(migrateSessionFavoriteStore(null)).toEqual({ items: {}, tombstones: {}, generation: 0 })
    expect(migrateSessionFavoriteStore([])).toEqual({ items: {}, tombstones: {}, generation: 0 })
    expect(migrateSessionFavoriteStore({ items: null, tombstones: null, generation: null })).toEqual({
      items: {},
      tombstones: {},
      generation: 0,
    })

    const migrated = migrateSessionFavoriteStore({
      items: {
        valid,
        deleted,
        null: null,
        missingServer: { directory: "C:/invalid", id: "ses_invalid" },
        invalidDirectory: { server: "server-a", directory: "", id: "ses_invalid" },
      },
      tombstones: {
        [deletedKey]: true,
        malformed: 9,
        "server-a\nC:/invalid\nses_zero": 0,
        "server-a\nC:/invalid\nses_fraction": 1.5,
        "server-a\nC:/invalid\nses_string": "4",
      },
      generation: "invalid",
    })

    expect(migrated.items).toEqual({ [sessionFavoriteKey(valid)]: valid })
    expect(migrated.tombstones).toEqual({ [deletedKey]: 1 })
    expect(migrated.generation).toBe(1)
  })

  test("compacts one thousand acknowledged deletions after an empty remote read", () => {
    const server = ServerConnection.Key.make("server-a")
    const removed = Array.from({ length: 1_000 }, (_, index) => index).reduce(
      (store, index) =>
        updateSessionFavoriteStore(store, {
          server,
          directory: "C:/shared/project",
          id: `ses_${index}`,
        }, false),
      { items: {}, tombstones: {}, generation: 0 } as SessionFavoriteStore,
    )
    const readback = prepareSharedFavoriteWriteback(removed, server)
    const reconciled = reconcileSharedFavoriteStore(removed, server, [])
    const compacted = acknowledgeSharedFavoriteWriteback(reconciled, readback.tombstones)

    expect(Object.keys(removed.tombstones)).toHaveLength(1_000)
    expect(Object.keys(compacted.tombstones)).toHaveLength(0)
    expect(compacted.generation).toBe(1_000)
  })

  test("acknowledges tombstones only after a successful remote write", async () => {
    const server = ServerConnection.Key.make("server-a")
    const favorite: SessionFavorite = { server, directory: "C:/shared/project", id: "ses_deleted" }
    let current = updateSessionFavoriteStore({ items: {}, tombstones: {}, generation: 0 }, favorite, false)
    const writes: SessionFavorite[][] = []

    await commitSharedFavoriteWriteback({
      current: () => current,
      writeback: prepareSharedFavoriteWriteback(current, server),
      write: async (items) => {
        writes.push(items)
      },
      apply: (next) => {
        current = next
      },
    })

    expect(writes).toEqual([[]])
    expect(current.tombstones).toEqual({})
  })

  test("retains tombstones when remote writeback fails", async () => {
    const server = ServerConnection.Key.make("server-a")
    const favorite: SessionFavorite = { server, directory: "C:/shared/project", id: "ses_deleted" }
    let current = updateSessionFavoriteStore({ items: {}, tombstones: {}, generation: 0 }, favorite, false)
    const generation = current.tombstones[sessionFavoriteKey(favorite)]

    await expect(
      commitSharedFavoriteWriteback({
        current: () => current,
        writeback: prepareSharedFavoriteWriteback(current, server),
        write: async () => {
          throw new Error("offline")
        },
        apply: (next) => {
          current = next
        },
      }),
    ).rejects.toThrow("offline")

    expect(current.tombstones[sessionFavoriteKey(favorite)]).toBe(generation)
  })

  test("does not acknowledge a newer re-deletion while an older writeback is in flight", async () => {
    const server = ServerConnection.Key.make("server-a")
    const favorite: SessionFavorite = { server, directory: "C:/shared/project", id: "ses_deleted" }
    const key = sessionFavoriteKey(favorite)
    let current = updateSessionFavoriteStore({ items: {}, tombstones: {}, generation: 0 }, favorite, false)
    const firstGeneration = current.tombstones[key]
    let release!: () => void
    const pending = commitSharedFavoriteWriteback({
      current: () => current,
      writeback: prepareSharedFavoriteWriteback(current, server),
      write: () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
      apply: (next) => {
        current = next
      },
    })
    await Promise.resolve()

    expect(current.tombstones[key]).toBe(firstGeneration)
    current = updateSessionFavoriteStore(current, favorite, false)
    const secondGeneration = current.tombstones[key]
    expect(secondGeneration).toBeGreaterThan(firstGeneration)

    release()
    await pending
    expect(current.tombstones[key]).toBe(secondGeneration)
  })
})
