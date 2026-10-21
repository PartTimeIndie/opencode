import { describe, expect, test } from "bun:test"
import type { ServerSync } from "@/context/server-sync"
import type { State } from "@/context/global-sync/types"
import { selectSessionTabStore } from "./session-tab-sync"

describe("selectSessionTabStore", () => {
  test("uses an unpinned peek for inactive tab status stores", () => {
    const store = { session_status: {} } as State
    let peeked = 0
    const sync = {
      existing: () => undefined,
      peek: () => {
        peeked += 1
        return [store, () => undefined]
      },
    } as unknown as Pick<ServerSync, "existing" | "peek">
    const result = selectSessionTabStore({
      directory: "C:/repo/inactive",
      sync,
    })

    expect(result).toBe(store)
    expect(peeked).toBe(1)
  })
})
