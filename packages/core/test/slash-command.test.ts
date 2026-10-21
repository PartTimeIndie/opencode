import { describe, expect, test } from "bun:test"
import { findSlashCommandRanges } from "../src/util/slash-command"

function ranges(text: string, names: string[]) {
  return findSlashCommandRanges(text, new Set(names))
}

describe("findSlashCommandRanges", () => {
  test("matches a complete known command at the start", () => {
    expect(ranges("/review please check", ["review"])).toEqual([{ start: 0, end: 7 }])
  })

  test("matches a command preceded by whitespace mid-sentence", () => {
    expect(ranges("please /review this", ["review"])).toEqual([{ start: 7, end: 14 }])
  })

  test("does not match an unknown command", () => {
    expect(ranges("/totally-unknown command", ["review"])).toEqual([])
  })

  test("matches multiple known commands", () => {
    expect(ranges("/review then /init", ["review", "init"])).toEqual([
      { start: 0, end: 7 },
      { start: 13, end: 18 },
    ])
  })

  test("does not highlight a prefix that is not the full token", () => {
    expect(ranges("/visual-qa-testing123", ["visual-qa-testing"])).toEqual([])
    expect(ranges("/review_note", ["review"])).toEqual([])
    expect(ranges("/review.md", ["review"])).toEqual([])
  })

  test("matches exact registered names with punctuation", () => {
    expect(ranges("/review.md", ["review.md"])).toEqual([{ start: 0, end: 10 }])
    expect(ranges("/review_note", ["review_note"])).toEqual([{ start: 0, end: 12 }])
  })

  test("keeps trailing punctuation out of the highlighted range", () => {
    expect(ranges("/review, ok", ["review"])).toEqual([{ start: 0, end: 7 }])
    expect(ranges("/review.", ["review"])).toEqual([{ start: 0, end: 7 }])
  })

  test("ignores slash inside a URL path", () => {
    expect(ranges("see https://example.com/path here", ["path", "com"])).toEqual([])
  })

  test("ignores a unix absolute path token", () => {
    expect(ranges("open /usr/bin", ["usr", "bin"])).toEqual([])
  })

  test("ignores a windows path", () => {
    expect(ranges("C:\\foo\\bar", ["foo", "bar"])).toEqual([])
  })

  test("ignores a slash that is not a word boundary (a/b)", () => {
    expect(ranges("a/b", ["b"])).toEqual([])
  })

  test("handles a command directly after a newline", () => {
    expect(ranges("hi\n/review", ["review"])).toEqual([{ start: 3, end: 10 }])
  })

  test("returns empty for empty text or empty command set", () => {
    expect(findSlashCommandRanges("", new Set(["review"]))).toEqual([])
    expect(findSlashCommandRanges("/review", new Set([]))).toEqual([])
  })

  test("handles unicode command names", () => {
    expect(ranges("/überprüfung", ["überprüfung"])).toEqual([{ start: 0, end: 12 }])
  })
})
