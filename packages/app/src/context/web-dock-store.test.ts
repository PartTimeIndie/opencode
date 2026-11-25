import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createWebDockStore } from "./web-dock-store"
import type { Platform } from "./platform"
import { PersistTesting } from "@/utils/persist"

const web: Platform = { platform: "web", openLink() {}, async restart() {}, back() {}, forward() {}, async notify() {} }
const key = "opencode.global.dat:web-docks.v1"
const samples = ['{"version":2,"items":[{"future":true}]}', '{"version":1,"items":[]}', '{"items":{}}', '{invalid JSON']

for (const raw of samples) {
  test(`preserves a blocked raw web envelope: ${raw}`, () => {
    localStorage.setItem(key, raw)
    createRoot((dispose) => {
      try {
        const store = createWebDockStore(web)
        expect(store.writable()).toBe(false)
        expect(store.orphans(["web-dock:kept"])).toEqual([])
        expect(() => store.put({ id: "new", name: "New", startURL: "https://example.com/" })).toThrow("storage")
        expect(localStorage.getItem(key)).toBe(raw)
      } finally { dispose() }
    })
  })
  test(`preserves a blocked raw delayed desktop envelope: ${raw}`, async () => {
    const operations: string[] = []
    let release!: (value: string) => void
    const pending = new Promise<string>((done) => { release = done })
    let reads = 0
    const storage = {
      getItem: () => { reads++; return pending },
      async setItem() { operations.push("write") },
      async removeItem() { operations.push("remove") },
    }
    // Evict this key through the real cache adapter before attaching a new backend.
    await PersistTesting.asyncStorageWithCache({ ...storage, async removeItem() {} }, "opencode.global.dat").removeItem("web-docks.v1")
    const owned = createRoot((dispose) => ({ store: createWebDockStore({ ...web, platform: "desktop", os: "windows", async openDirectoryPickerDialog() { return null }, storage: () => storage }), dispose }))
    try {
      expect(owned.store.writable()).toBe(false)
      expect(owned.store.orphans(["web-dock:kept"])).toEqual([])
      release(raw)
      await owned.store.ready.promise
      await Promise.resolve()
      expect(owned.store.writable()).toBe(false)
      expect(owned.store.orphans(["web-dock:kept"])).toEqual([])
      expect(reads).toBe(1)
      expect(operations).toEqual([])
    } finally { owned.dispose() }
  })
}

test("initializes only confirmed absence and round-trips valid v1 data", () => {
  PersistTesting.localStorageWithPrefix("opencode.global.dat").removeItem("web-docks.v1")
  createRoot((dispose) => {
    try {
      const store = createWebDockStore(web)
      expect(store.writable()).toBe(true)
      store.put({ id: "new", name: " New ", startURL: "https://example.com" })
      expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ version: 1, items: { new: { id: "new", name: "New", startURL: "https://example.com/" } } })
    } finally { dispose() }
  })
})
