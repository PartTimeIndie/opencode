import { describe, expect, test } from "bun:test"
import { readPartText } from "./message-part-text"

describe("readPartText", () => {
  test("returns empty string when accum is undefined and part text is undefined", () => {
    expect(readPartText(undefined, { id: "part_1" })).toBe("")
  })

  test("returns trimmed part text when accum is undefined", () => {
    expect(readPartText(undefined, { id: "part_1", text: "  hello  " })).toBe("hello")
  })

  test("prefers streamed accum when the part snapshot has not caught up", () => {
    expect(readPartText({ part_1: "hello wor" }, { id: "part_1", text: "hello" })).toBe("hello wor")
  })

  test("prefers authoritative part text when it contains the streamed snapshot", () => {
    expect(readPartText({ part_1: "hello" }, { id: "part_1", text: "hello world" })).toBe("hello world")
  })

  test("prefers longer part text when accum is a stale partial snapshot", () => {
    expect(readPartText({ part_1: "partial" }, { id: "part_1", text: "partial and complete" })).toBe(
      "partial and complete",
    )
  })

  test("falls back to part text when accum misses", () => {
    expect(readPartText({ other_part: "ignored" }, { id: "part_1", text: "  from part  " })).toBe("from part")
  })

  test("prefers the current snapshot when accum is a divergent stale snippet", () => {
    expect(
      readPartText({ part_1: "Loading messages..." }, { id: "part_1", text: "Docker bleibt ein separater Blocker." }),
    ).toBe("Docker bleibt ein separater Blocker.")
  })

  test("returns empty string for whitespace-only text", () => {
    expect(readPartText(undefined, { id: "part_1", text: "   \n\t  " })).toBe("")
  })

  test("trims leading and trailing whitespace", () => {
    expect(readPartText(undefined, { id: "part_1", text: "\n  body  \n" })).toBe("body")
  })
})
