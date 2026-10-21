import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import { selectQueuedFollowup } from "../src/pages/session/followup-queue"
import { ServerScope } from "../src/utils/server-scope"

type FollowupStoreModule = typeof import("../src/pages/session/followup-store")

const values = new Map<string, string>()
let releaseRead: () => void = () => {}
const readGate = new Promise<void>((resolve) => {
  releaseRead = resolve
})

const backing = {
  getItem: async (key: string) => {
    await readGate
    return values.get(key) ?? null
  },
  setItem: async (key: string, value: string) => {
    values.set(key, value)
  },
  removeItem: async (key: string) => {
    values.delete(key)
  },
}

const FOLLOWUP_KEY = "workspace:followup"
const DIRECTORY = "C:\\GitRepros\\demo"
const INPUT = { scope: ServerScope.local, directory: DIRECTORY }

const queuedItem = {
  id: "msg_queued_1",
  sessionID: "ses_antrag",
  sessionDirectory: DIRECTORY,
  messageID: undefined,
  prompt: [{ type: "text" as const, content: "finaler Antrag", start: 0, end: 13 }],
  context: [],
  agent: "plan",
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

let followupStoreModule: FollowupStoreModule

beforeAll(async () => {
  mock.module("@/context/platform", () => ({
    usePlatform: () => ({ platform: "desktop", storage: () => backing }),
  }))
  followupStoreModule = await import("../src/pages/session/followup-store")
})

beforeEach(() => {
  values.clear()
  followupStoreModule.clearFollowupStoreCache()
})

describe("followup persisted store", () => {
  test("a write before hydration cannot wipe the persisted queue (reload race)", async () => {
    values.set(FOLLOWUP_KEY, JSON.stringify({ items: { ses_antrag: [queuedItem] }, failed: {}, paused: {}, edit: {} }))

    await createRoot((dispose) => {
      const [followup, setFollowup] = followupStoreModule.followupStore(INPUT)

      // The renderer can write before the async workspace file resolves, for
      // example when the dock's Pause button fires on a freshly mounted page.
      setFollowup("paused", "ses_antrag", true)
      expect(followup.items.ses_antrag).toBeUndefined()

      releaseRead()
      return tick().then(() => {
        // The queued item must survive both in memory and in the file.
        expect(followup.items.ses_antrag?.[0]?.id).toBe("msg_queued_1")
        const persisted = JSON.parse(values.get(FOLLOWUP_KEY)!)
        expect(persisted.items.ses_antrag?.[0]?.id).toBe("msg_queued_1")
        expect(persisted.paused.ses_antrag).toBe(true)
        dispose()
      })
    })
  })

  test("hydration still applies when nothing was written early", async () => {
    values.set(FOLLOWUP_KEY, JSON.stringify({ items: { ses_antrag: [queuedItem] }, failed: {}, paused: {}, edit: {} }))

    await createRoot((dispose) => {
      const [followup] = followupStoreModule.followupStore(INPUT)
      releaseRead()
      return tick().then(() => {
        expect(followup.items.ses_antrag?.[0]?.id).toBe("msg_queued_1")
        dispose()
      })
    })
  })

  test("multiple session mounts share one store so a stale copy cannot clobber the queue", async () => {
    values.set(FOLLOWUP_KEY, JSON.stringify({ items: {}, failed: {}, paused: {}, edit: {} }))

    await createRoot((dispose) => {
      const first = followupStoreModule.followupStore(INPUT)
      const second = followupStoreModule.followupStore(INPUT)

      // Same project directory must never hydrate a second independent copy:
      // two whole-value stores on one file are how queued followups were lost.
      expect(second[0]).toBe(first[0])

      releaseRead()
      return tick().then(async () => {
        second[1]("items", "ses_antrag", (items) => [...(items ?? []), queuedItem])
        await tick()
        const persisted = JSON.parse(values.get(FOLLOWUP_KEY)!)
        expect(persisted.items.ses_antrag?.[0]?.id).toBe("msg_queued_1")
        expect(first[0].items.ses_antrag?.[0]?.id).toBe("msg_queued_1")
        dispose()
      })
    })
  })

  test("an explicitly resumed queue drains again after the pause", async () => {
    values.set(FOLLOWUP_KEY, JSON.stringify({ items: { ses_antrag: [queuedItem] }, failed: {}, paused: {}, edit: {} }))

    await createRoot((dispose) => {
      const [followup, setFollowup] = followupStoreModule.followupStore(INPUT)
      releaseRead()
      return tick().then(async () => {
        const drain = () =>
          selectQueuedFollowup({
            items: followup.items,
            failed: followup.failed,
            paused: followup.paused,
            isBusy: () => false,
            isChild: () => false,
            isBlocked: () => false,
          })

        setFollowup("paused", "ses_antrag", true)
        expect(drain()).toBeUndefined()

        // The dock's Weiterführen button writes exactly this explicit release.
        setFollowup("paused", "ses_antrag", false)
        expect(drain()?.item.id).toBe("msg_queued_1")

        await tick()
        expect(JSON.parse(values.get(FOLLOWUP_KEY)!).paused.ses_antrag).toBe(false)
        dispose()
      })
    })
  })

  test("distinct directories keep independent stores", () => {
    createRoot((dispose) => {
      const a = followupStoreModule.followupStore(INPUT)
      const b = followupStoreModule.followupStore({ scope: ServerScope.local, directory: "C:\\GitRepros\\other" })

      expect(b[0]).not.toBe(a[0])
      dispose()
    })
  })

  test("post-hydration queue and drain writes keep persisting", async () => {
    values.set(FOLLOWUP_KEY, JSON.stringify({ items: {}, failed: {}, paused: {}, edit: {} }))

    await createRoot((dispose) => {
      const [followup, setFollowup] = followupStoreModule.followupStore(INPUT)
      releaseRead()
      return tick().then(async () => {
        setFollowup("items", "ses_antrag", (items) => [...(items ?? []), queuedItem])
        await tick()
        expect(JSON.parse(values.get(FOLLOWUP_KEY)!).items.ses_antrag?.[0]?.id).toBe("msg_queued_1")

        setFollowup("items", "ses_antrag", (items) => (items ?? []).filter((item) => item.id !== queuedItem.id))
        await tick()
        const drained = JSON.parse(values.get(FOLLOWUP_KEY)!)
        expect(drained.items.ses_antrag).toEqual([])
        expect(followup.items.ses_antrag).toEqual([])
        dispose()
      })
    })
  })
})
