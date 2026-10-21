import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { createStore, reconcile } from "solid-js/store"
import { mergeLoadedSessions } from "./session-load"

const session = (id: string, created: number): Session => ({
  id,
  slug: id,
  projectID: "project",
  directory: "C:/project",
  title: id,
  version: "dev",
  time: { created, updated: created },
})

describe("mergeLoadedSessions", () => {
  test("does not replace a newer live title with an older list response", () => {
    const old = session("ses_title", 1)
    const updated = { ...old, title: "New", time: { ...old.time, updated: 2 } }
    expect(mergeLoadedSessions({ loaded: [old], current: [updated], initialIDs: new Set([old.id]) })[0]?.title).toBe("New")
  })

  test("accepts newer list metadata over an older cached title", () => {
    const old = session("ses_title", 1)
    const updated = { ...old, title: "New", time: { ...old.time, updated: 2 } }
    expect(mergeLoadedSessions({ loaded: [updated], current: [old], initialIDs: new Set([old.id]) })[0]?.title).toBe("New")
  })

  test("preserves a root created while an older session-list request is in flight", () => {
    const first = session("ses_first", 1)
    const second = session("ses_second", 2)
    const created = session("ses_created", 3)
    const [store, setStore] = createStore({ session: [first, second] })
    const initialIDs = new Set(store.session.map((item) => item.id))

    setStore("session", (current) => [current[0]!, created, current[1]!])
    setStore(
      "session",
      reconcile(
        mergeLoadedSessions({ loaded: [first, second], current: store.session, initialIDs }),
        { key: "id" },
      ),
    )

    expect(store.session.map((item) => item.id)).toEqual(["ses_first", "ses_second", "ses_created"])
    expect(store.session.find((item) => item.id === created.id)?.time.updated).toBe(3)
  })

  test("still removes roots that existed before the request and disappeared from the response", () => {
    const kept = session("ses_kept", 1)
    const removed = session("ses_removed", 2)

    expect(
      mergeLoadedSessions({
        loaded: [kept],
        current: [kept, removed],
        initialIDs: new Set([kept.id, removed.id]),
      }).map((item) => item.id),
    ).toEqual([kept.id])
  })

  test("keeps a locally created root across a later stale list response until the server confirms it", () => {
    const loaded = session("ses_loaded", 1)
    const created = session("ses_created", 2)

    expect(
      mergeLoadedSessions({
        loaded: [loaded],
        current: [loaded, created],
        initialIDs: new Set([loaded.id, created.id]),
        preserveIDs: new Set([created.id]),
      }).map((item) => item.id),
    ).toEqual([loaded.id, created.id])
  })
})
