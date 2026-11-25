import { expect, test } from "bun:test"
import { reduceAttention, type AttentionCommand } from "./broker"
import { refreshAttention } from "./refresh"
import type { AttentionEntry } from "./state"

const snapshot = (cursor: number, count: number) => ({ title: "Example", working: false, cursor, count,
  last: { id: `activity-${cursor}`, status: "completed", closedSeq: cursor } })

function fixture() {
  const entries: Record<string, AttentionEntry> = {}
  const key = "server\nproject\nsession"
  reduceAttention(entries, { type: "enable", key, directory: "project", snapshot: snapshot(0, 0) })
  const updates: AttentionCommand[] = []
  let visible = false
  let enabled = true
  const run = (live: boolean) => refreshAttention({
    key, current: () => entries[key], fetch: async (afterSeq) => afterSeq ? snapshot(1, 0) : snapshot(1, 1),
    update: async (command) => { updates.push(command); return reduceAttention(entries, command) },
    receive: () => {}, enabled: () => enabled, visible: () => visible, live: () => live,
  })
  return { entries, key, updates, run, setVisible: (value: boolean) => { visible = value },
    setEnabled: (value: boolean) => { enabled = value } }
}

test("concurrent live results retry stale snapshots and only one window claims a toast", async () => {
  const state = fixture()
  expect((await Promise.all([state.run(true), state.run(true)])).filter(Boolean)).toHaveLength(1)
  expect(state.entries[state.key]).toMatchObject({ cursor: 1, count: 1, notified: 1 })
  expect(state.updates.filter((item) => item.type === "claim")).toHaveLength(1)
  expect(await state.run(true)).toBe(false)
})

test("a live event arriving while recovery fetches promotes the result before claiming", async () => {
  const state = fixture()
  let complete!: (value: ReturnType<typeof snapshot>) => void
  const fetching = new Promise<ReturnType<typeof snapshot>>((resolve) => { complete = resolve })
  let live = false
  const job = refreshAttention({
    key: state.key, current: () => state.entries[state.key], fetch: () => fetching,
    update: async (command) => { state.updates.push(command); return reduceAttention(state.entries, command) },
    receive: () => {}, enabled: () => true, visible: () => false, live: () => live,
  })
  live = true
  complete(snapshot(1, 1))
  expect(await job).toBe(true)
  expect(state.updates.filter((item) => item.type === "claim")).toHaveLength(1)
})

test("visible session or paused plugin never attempts a system toast claim", async () => {
  const state = fixture()
  state.setVisible(true)
  expect(await state.run(true)).toBe(false)
  expect(state.updates.some((item) => item.type === "claim")).toBe(false)
  const paused = fixture()
  paused.setEnabled(false)
  expect(await paused.run(true)).toBe(false)
  expect(paused.updates).toHaveLength(0)
})
