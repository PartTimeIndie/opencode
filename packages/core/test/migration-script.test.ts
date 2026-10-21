import { describe, expect, test } from "bun:test"
import { matchesGeneratedFile } from "../script/migration-util"

describe("migration script", () => {
  test("accepts platform line endings without hiding content drift", () => {
    expect(matchesGeneratedFile("first\r\nsecond\r\n", "first\nsecond\n")).toBe(true)
    expect(matchesGeneratedFile("first\r\nchanged\r\n", "first\nsecond\n")).toBe(false)
  })
})
