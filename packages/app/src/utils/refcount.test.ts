import { describe, expect, test } from "bun:test"
import { createRoot, onCleanup } from "solid-js"
import { createRefCountMap } from "./refcount"
import { pathKey } from "./path-key"

describe("createRefCountMap", () => {
  test("removes an item after its last owner is disposed", async () => {
    const removed: string[] = []
    const map = createRefCountMap(
      (key) => key,
      (key) => removed.push(key),
    )
    const first = createRoot((dispose) => {
      map("/project")
      return dispose
    })
    const second = createRoot((dispose) => {
      map("/project")
      return dispose
    })

    first()
    expect(removed).toEqual([])
    second()
    await Promise.resolve()
    expect(removed).toEqual(["/project"])
  })

  test("keeps equivalent path consumers until the last owner is disposed", async () => {
    const removed: string[] = []
    const map = createRefCountMap(
      (key) => key,
      (key) => removed.push(key),
      pathKey,
    )
    const first = createRoot((dispose) => {
      map("C:\\repo")
      return dispose
    })
    const second = createRoot((dispose) => {
      map("C:/repo/")
      return dispose
    })

    first()
    expect(removed).toEqual([])
    second()
    await Promise.resolve()
    expect(removed).toEqual(["C:/repo"])
  })

  test("keeps the shared item owner alive until the final consumer is disposed", async () => {
    const cleaned: string[] = []
    const map = createRefCountMap((key) => {
      onCleanup(() => cleaned.push(key))
      return key
    })
    const first = createRoot((dispose) => {
      map("/project")
      return dispose
    })
    const second = createRoot((dispose) => {
      map("/project")
      return dispose
    })

    first()
    expect(cleaned).toEqual([])
    second()
    await Promise.resolve()
    expect(cleaned).toEqual(["/project"])
  })

  test("reuses an item when its last consumer is replaced in the same turn", async () => {
    const created: object[] = []
    const cleaned: object[] = []
    const map = createRefCountMap(() => {
      const value = {}
      created.push(value)
      onCleanup(() => cleaned.push(value))
      return value
    })
    const first = createRoot((dispose) => ({ value: map("/project"), dispose }))

    first.dispose()
    const second = createRoot((dispose) => ({ value: map("/project"), dispose }))
    await Promise.resolve()

    expect(second.value).toBe(first.value)
    expect(created).toHaveLength(1)
    expect(cleaned).toEqual([])

    second.dispose()
    await Promise.resolve()
    expect(cleaned).toEqual([first.value])
  })
})
