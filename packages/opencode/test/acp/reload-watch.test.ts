import { describe, expect, test } from "bun:test"
import { createReloadBatch, shouldReloadPath } from "../../src/acp/reload-watch"

describe("ACP runtime reload watch", () => {
  test("ignores generated scheduler state and logs", () => {
    expect(shouldReloadPath("scheduler\\scopes\\scope-a\\jobs\\photo-face.json", { generatedRoot: true })).toBe(false)
    expect(shouldReloadPath("scheduler/tasks/photo-face.ps1", { generatedRoot: true })).toBe(false)
    expect(shouldReloadPath("logs\\scheduler\\scope-a\\photo-face.log", { generatedRoot: true })).toBe(false)
  })

  test("ignores dependency and git metadata writes", () => {
    expect(shouldReloadPath("node_modules/pkg/index.js")).toBe(false)
    expect(shouldReloadPath("plugins/demo/.git/index")).toBe(false)
  })

  test("keeps real config, plugin, and skill edits reloadable", () => {
    expect(shouldReloadPath("opencode.json", { generatedRoot: true })).toBe(true)
    expect(shouldReloadPath("plugins/scheduler/index.js", { generatedRoot: true })).toBe(true)
    expect(shouldReloadPath("plugins/scheduler/index.js")).toBe(true)
    expect(shouldReloadPath("skills/logs/SKILL.md")).toBe(true)
  })

  test("does not dispose global runtime for an unclassified config event", () => {
    expect(shouldReloadPath(null, { generatedRoot: true })).toBe(false)
    expect(shouldReloadPath(null)).toBe(true)
  })

  test("classifies callbacks from recursive child watchers against their root", () => {
    expect(shouldReloadPath("photo-face.json", { generatedRoot: true, prefix: "scheduler/scopes/jobs" })).toBe(false)
    expect(shouldReloadPath("index.js", { generatedRoot: true, prefix: "plugins/scheduler" })).toBe(true)
  })
})

describe("ACP runtime reload batching", () => {
  test("disposes once and refreshes two directories in one batch", async () => {
    const runs: Array<ReadonlyMap<string, string>> = []
    const errors: unknown[] = []
    const batch = createReloadBatch({
      delay: 500,
      run: async (entries) => {
        runs.push(entries)
      },
      onError: (error) => errors.push(error),
    })

    batch.schedule("C:/one", "global:config")
    batch.schedule("C:/two", "global:config")
    await batch.flush()

    expect(runs).toHaveLength(1)
    expect(Array.from(runs[0] ?? [])).toEqual([
      ["C:/one", "global:config"],
      ["C:/two", "global:config"],
    ])
    expect(errors).toEqual([])
    await batch.dispose()
  })

  test("cancels closed and watch-off directories before flush", async () => {
    const runs: Array<ReadonlyMap<string, string>> = []
    const batch = createReloadBatch({
      delay: 500,
      run: async (entries) => {
        runs.push(entries)
      },
      onError: () => {},
    })

    batch.schedule("C:/closed", "project:edit")
    batch.schedule("C:/active", "project:edit")
    const flushed = batch.flush()
    batch.cancel("C:/closed")
    await flushed

    expect(Array.from(runs[0] ?? [])).toEqual([["C:/active", "project:edit"]])
    await batch.dispose()
  })

  test("silently drops callbacks after disposal", async () => {
    const runs: Array<ReadonlyMap<string, string>> = []
    const batch = createReloadBatch({
      delay: 0,
      run: async (entries) => {
        runs.push(entries)
      },
      onError: () => {},
    })

    batch.schedule("C:/closed", "project:edit")
    await batch.dispose()
    batch.schedule("C:/late", "project:late")
    await batch.flush()

    expect(runs).toEqual([])
  })
})
