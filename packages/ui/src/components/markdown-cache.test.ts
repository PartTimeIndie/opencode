import { describe, expect, test } from "bun:test"
import { createMarkdownCache } from "./markdown-cache"

const entry = (raw: string) => ({ raw, hash: "h", html: "x" })

describe("Markdown cache", () => {
  test("evicts least-recently-used entries when the retained byte budget is reached", () => {
    const cache = createMarkdownCache({ maxEntries: 10, maxBytes: 12 })
    cache.set("first", entry("a"))
    cache.set("second", entry("b"))
    expect(cache.get("first")).toEqual(entry("a"))

    cache.set("third", entry("c"))

    expect(cache.get("second")).toBeUndefined()
    expect(cache.get("first")).toEqual(entry("a"))
    expect(cache.get("third")).toEqual(entry("c"))
  })

  test("does not retain a single entry larger than the byte budget", () => {
    const cache = createMarkdownCache({ maxEntries: 10, maxBytes: 12 })
    cache.set("document", entry("a"))

    cache.set("document", entry("oversized"))

    expect(cache.get("document")).toBeUndefined()
  })

  test("replacing an entry updates its retained byte accounting", () => {
    const cache = createMarkdownCache({ maxEntries: 10, maxBytes: 14 })
    cache.set("replace", entry("a"))
    cache.set("replace", entry("bb"))
    cache.set("other", entry("a"))

    expect(cache.get("replace")).toEqual(entry("bb"))
    expect(cache.get("other")).toEqual(entry("a"))
  })

  test("does not evict retained entries for a new entry larger than the byte budget", () => {
    const cache = createMarkdownCache({ maxEntries: 10, maxBytes: 12 })
    cache.set("retained", entry("a"))

    cache.set("oversized", entry("too large"))

    expect(cache.get("retained")).toEqual(entry("a"))
    expect(cache.get("oversized")).toBeUndefined()
  })

  test("evicts multiple least-recently-used entries when needed", () => {
    const cache = createMarkdownCache({ maxEntries: 10, maxBytes: 18 })
    cache.set("first", entry("a"))
    cache.set("second", entry("b"))
    cache.set("third", entry("c"))

    cache.set("fourth", entry("xy"))

    expect(cache.get("first")).toBeUndefined()
    expect(cache.get("second")).toBeUndefined()
    expect(cache.get("third")).toEqual(entry("c"))
    expect(cache.get("fourth")).toEqual(entry("xy"))
  })

  test("evicts an entry whose key is empty", () => {
    const cache = createMarkdownCache({ maxEntries: 10, maxBytes: 12 })
    cache.set("", entry("a"))
    cache.set("second", entry("b"))

    cache.set("third", entry("c"))

    expect(cache.get("")).toBeUndefined()
    expect(cache.get("second")).toEqual(entry("b"))
    expect(cache.get("third")).toEqual(entry("c"))
  })

  test("keeps the existing entry-count bound", () => {
    const cache = createMarkdownCache({ maxEntries: 2, maxBytes: 100 })
    cache.set("first", entry("a"))
    cache.set("second", entry("b"))
    cache.set("third", entry("c"))

    expect(cache.get("first")).toBeUndefined()
    expect(cache.get("second")).toEqual(entry("b"))
    expect(cache.get("third")).toEqual(entry("c"))
  })
})
