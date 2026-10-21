import { describe, expect, test } from "bun:test"
import { ReadReceipt } from "@opencode-ai/core/tool/read-receipt"
import { ReadToolFileSystem } from "@opencode-ai/core/tool/read-filesystem"
import { FileKnowledge } from "@opencode-ai/core/file-knowledge"

const text = (content: string) => ({
  encoding: "utf8" as const,
  content,
  mime: "text/plain",
  uri: "file:///a",
  name: "a",
  sha256: "version",
})

describe("read receipt coverage", () => {
  test("only actually rendered lines count; large line and line-cap omissions are unknown", () => {
    expect(ReadReceipt.coverage(text("a\nb\n"))).toEqual({ ranges: [[1, 2]], end: 2 })
    const capped = ReadReceipt.coverage(text("x".repeat(ReadToolFileSystem.MAX_LINE_LENGTH + 1)))!
    expect(capped.ranges).toEqual([])
    expect(FileKnowledge.full(capped)).toBe(false)
    const many = ReadReceipt.coverage(text(Array.from({ length: 2001 }, () => "x").join("\n")))!
    expect(many.ranges).toEqual([[1, 2000]])
    expect(FileKnowledge.full(many)).toBe(false)
  })
  test("pages expose their offset and EOF without granting unread prefixes", () => {
    const page = new ReadToolFileSystem.TextPage({
      type: "text-page",
      content: "c\nd",
      mime: "text/plain",
      offset: 3,
      truncated: false,
      sha256: "version",
    })
    expect(ReadReceipt.coverage(page)).toEqual({ ranges: [[3, 4]], end: 4 })
    expect(FileKnowledge.full(ReadReceipt.coverage(page)!)).toBe(false)
    expect(ReadReceipt.coverage({ ...page, truncated: true })).toEqual({ ranges: [[3, 4]] })
  })
  test("listings, images and truncation markers grant no bytes; empty text is fully known", () => {
    expect(
      ReadReceipt.coverage({ encoding: "base64", content: "eA==", mime: "image/png", uri: "file:///a", name: "a" }),
    ).toBeUndefined()
    expect(ReadReceipt.coverage(text(""))).toEqual({ ranges: [], end: 0 })
    expect(ReadReceipt.coverage(text(`visible${ReadToolFileSystem.MAX_LINE_SUFFIX}`))?.ranges).toEqual([])
  })
})
