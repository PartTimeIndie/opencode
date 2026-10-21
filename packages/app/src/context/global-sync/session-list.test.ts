import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2"
import { createStore, produce } from "solid-js/store"
import { mergeSessionList, replaceSessionList } from "./session-list"

const session: Session = {
  id: "ses_restore",
  projectID: "global",
  directory: "/project",
  slug: "restore",
  title: "Restore",
  version: "test",
  time: { created: 1, updated: 1 },
}

describe("restored session snapshots", () => {
  test("clears a revert omitted from a complete live session update", () => {
    const [store, setStore] = createStore({
      sessions: [{ ...session, revert: { messageID: "msg_restored" } }] as Session[],
    })
    setStore(
      "sessions",
      produce((items) => mergeSessionList(items, { ...session, time: { created: 1, updated: 2 } })),
    )
    expect(store.sessions[0]?.revert).toBeUndefined()
  })

  test("clears the restored boundary on refresh without losing session identity", () => {
    const items = [{ ...session, revert: { messageID: "msg_restored" } }] as Session[]
    const original = items[0]
    replaceSessionList(items, [session])
    expect(items[0]).toBe(original)
    expect(items[0]?.revert).toBeUndefined()
  })
})
