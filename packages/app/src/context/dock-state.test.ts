import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { createRoot } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { sortedRootSessions } from "../pages/layout/helpers"
import { mergeSessionList, replaceSessionList } from "./global-sync/session-list"

const session = (id: string, created: number): Session => ({
  id,
  slug: id,
  projectID: "project",
  directory: "C:/project",
  title: id,
  version: "dev",
  time: { created, updated: created },
})

describe("mergeSessionList", () => {
  test("keeps a created session valid when a warm-session insert shifts it", () => {
    createRoot((dispose) => {
      const [store, setStore] = createStore({
        session: [session("ses_first", 1), session("ses_new", 3), session("ses_third", 4)],
      })
      const created = store.session[1]!

      setStore(
        "session",
        produce((draft) => mergeSessionList(draft, session("ses_middle", 2))),
      )

      expect(store.session.map((item) => item.id)).toEqual(["ses_first", "ses_middle", "ses_new", "ses_third"])
      expect(created.id).toBe("ses_new")
      expect(created.time.updated).toBe(3)
      expect(Object.keys(created).sort()).toEqual(
        ["directory", "id", "projectID", "slug", "time", "title", "version"].sort(),
      )
      dispose()
    })
  })

  test("preserves session identities while replacing and reordering the loaded list", () => {
    createRoot((dispose) => {
      const [store, setStore] = createStore({
        path: { directory: "C:/project" },
        session: [session("ses_first", 1), session("ses_new", 3), session("ses_third", 4)],
      })
      const created = store.session[1]!

      setStore(
        "session",
        produce((draft) =>
          replaceSessionList(draft, [
            session("ses_first", 5),
            session("ses_middle", 2),
            session("ses_new", 6),
            session("ses_third", 4),
          ]),
        ),
      )

      expect(store.session.map((item) => item.id)).toEqual(["ses_first", "ses_middle", "ses_new", "ses_third"])
      expect(created.id).toBe("ses_new")
      expect(created.time.updated).toBe(6)
      expect(sortedRootSessions(store, 10).map((item) => item.id)).toEqual([
        "ses_new",
        "ses_first",
        "ses_third",
        "ses_middle",
      ])
      expect(store.session.every((item) => item?.time?.updated !== undefined)).toBe(true)
      dispose()
    })
  })

  test("keeps sorting valid when the replacement reuses store proxies", () => {
    createRoot((dispose) => {
      const [store, setStore] = createStore({
        path: { directory: "C:/project" },
        session: [session("ses_first", 1), session("ses_new", 3), session("ses_third", 4)],
      })
      expect(sortedRootSessions(store, 10).map((item) => item.id)).toEqual(["ses_third", "ses_new", "ses_first"])
      const next = [store.session[0]!, session("ses_middle", 2), store.session[1]!, store.session[2]!]

      setStore(
        "session",
        produce((draft) => replaceSessionList(draft, next)),
      )

      expect(sortedRootSessions(store, 10).map((item) => item.id)).toEqual([
        "ses_third",
        "ses_new",
        "ses_middle",
        "ses_first",
      ])
      expect(store.session.every((item) => item?.time?.updated !== undefined)).toBe(true)
      dispose()
    })
  })

  test("replaces an existing session without changing list order", () => {
    createRoot((dispose) => {
      const [store, setStore] = createStore({
        session: [session("ses_first", 1), session("ses_second", 2)],
      })

      setStore(
        "session",
        produce((draft) => mergeSessionList(draft, session("ses_second", 4))),
      )

      expect(store.session.map((item) => item.id)).toEqual(["ses_first", "ses_second"])
      expect(store.session[1]?.time.updated).toBe(4)
      dispose()
    })
  })

  test("normalizes ISO timestamps from live V2 session events", () => {
    createRoot((dispose) => {
      const [store, setStore] = createStore({
        path: { directory: "C:/project" },
        session: [session("ses_existing", 1)],
      })
      const live = {
        ...session("ses_live", 2),
        time: {
          created: "2026-09-20T21:46:12.000Z",
          updated: "2026-09-20T21:46:12.073Z",
        },
      } as unknown as Session

      setStore(
        "session",
        produce((draft) => mergeSessionList(draft, live)),
      )

      expect(store.session.map((item) => item.id)).toEqual(["ses_existing", "ses_live"])
      expect(store.session[1]?.time).toEqual({
        created: Date.parse("2026-09-20T21:46:12.000Z"),
        updated: Date.parse("2026-09-20T21:46:12.073Z"),
        archived: undefined,
      })
      expect(() => sortedRootSessions(store, Date.now())).not.toThrow()
      dispose()
    })
  })
})
