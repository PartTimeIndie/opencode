import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createFileTreeStore } from "./tree-store"

describe("file tree requests", () => {
  test("retries an initial same-scope 499 and restores the root tree", async () => {
    const errors: string[] = []
    const nodes = [
      {
        name: "README.md",
        path: "README.md",
        type: "file" as const,
        absolute: "C:/GitRepros/opencode/README.md",
        ignored: false,
      },
    ]
    let calls = 0
    const dispose = createRoot((cleanup) => {
      const tree = createFileTreeStore({
        scope: () => "C:/GitRepros/opencode",
        normalizeDir: (input) => input,
        list: async () => {
          calls += 1
          if (calls === 1)
            throw new Error(
              "opencode server GET http://127.0.0.1:64115/file?path=&directory=C%3A%5CGitRepros%5Copencode → 499 unknown: (empty response body)",
            )
          return nodes
        },
        onError: (message) => errors.push(message),
      })
      return { cleanup, tree }
    })

    await dispose.tree.listDir("")

    expect(calls).toBe(2)
    expect(dispose.tree.children("")).toEqual(nodes)
    expect(dispose.tree.dirState("")?.loaded).toBe(true)
    expect(dispose.tree.dirState("")?.loading).toBe(false)
    expect(dispose.tree.dirState("")?.error).toBeUndefined()
    expect(errors).toEqual([])
    dispose.cleanup()
  })

  test("preserves existing children after a cancelled refresh exhausts its retries", async () => {
    const errors: string[] = []
    const existing = {
      name: "kept.ts",
      path: "src/kept.ts",
      type: "file" as const,
      absolute: "C:/GitRepros/opencode/src/kept.ts",
      ignored: false,
    }
    let calls = 0
    const dispose = createRoot((cleanup) => {
      const tree = createFileTreeStore({
        scope: () => "C:/GitRepros/opencode",
        normalizeDir: (input) => input,
        list: async () => {
          calls += 1
          if (calls === 1) return [existing]
          throw new DOMException("The operation was aborted", "AbortError")
        },
        onError: (message) => errors.push(message),
      })
      return { cleanup, tree }
    })

    await dispose.tree.listDir("")
    await dispose.tree.listDir("", { force: true })

    expect(calls).toBe(4)
    expect(dispose.tree.children("")).toEqual([existing])
    expect(dispose.tree.dirState("")?.loaded).toBe(true)
    expect(dispose.tree.dirState("")?.loading).toBe(false)
    expect(dispose.tree.dirState("")?.error).toBeUndefined()
    expect(errors).toEqual([])
    dispose.cleanup()
  })

  test("reports the first failure and skips repeated identical error toasts", async () => {
    const errors: string[] = []
    const failure = new Error("Unexpected server error. Check server logs for details.")
    const nodes = [
      {
        name: "README.md",
        path: "README.md",
        type: "file" as const,
        absolute: "C:/GitRepros/opencode/README.md",
        ignored: false,
      },
    ]
    let calls = 0
    const dispose = createRoot((cleanup) => {
      const tree = createFileTreeStore({
        scope: () => "C:/GitRepros/opencode",
        normalizeDir: (input) => input,
        list: async () => {
          calls += 1
          if (calls !== 3) throw failure
          return nodes
        },
        onError: (message) => errors.push(message),
      })
      return { cleanup, tree }
    })

    await dispose.tree.listDir("")
    await dispose.tree.listDir("", { force: true })

    expect(calls).toBe(2)
    expect(errors).toEqual([failure.message])
    expect(dispose.tree.dirState("")?.error).toBe(failure.message)

    // A success clears the marker so the next failure is reported again.
    await dispose.tree.listDir("", { force: true })
    await dispose.tree.listDir("", { force: true })

    expect(calls).toBe(4)
    expect(errors).toEqual([failure.message, failure.message])
    expect(dispose.tree.dirState("")?.error).toBe(failure.message)
    dispose.cleanup()
  })

  test("keeps silent watcher refreshes out of error toasts", async () => {
    const errors: string[] = []
    const failure = new Error("Unexpected server error. Check server logs for details.")
    const dispose = createRoot((cleanup) => {
      const tree = createFileTreeStore({
        scope: () => "C:/GitRepros/opencode",
        normalizeDir: (input) => input,
        list: async () => {
          throw failure
        },
        onError: (message) => errors.push(message),
      })
      return { cleanup, tree }
    })

    await dispose.tree.listDir("", { force: true, silent: true })

    expect(dispose.tree.dirState("")?.error).toBe(failure.message)
    expect(errors).toEqual([])

    await dispose.tree.listDir("", { force: true })

    // A user-triggered refresh still toasts once for the unchanged failure.
    expect(errors).toEqual([failure.message])

    await dispose.tree.listDir("", { force: true })

    expect(errors).toEqual([failure.message])
    dispose.cleanup()
  })
})
