import { expect, test } from "bun:test"
import { emojiCatalog, frequentEmojis, searchEmojis } from "./emoji-catalog"

test("offline catalog is large, unique and searchable in both languages", () => {
  expect(emojiCatalog.length).toBeGreaterThanOrEqual(300)
  expect(new Set(emojiCatalog.map((entry) => entry.id)).size).toBe(emojiCatalog.length)
  expect(emojiCatalog[0].category).toBe("practical")
  expect(searchEmojis("Warnung")[0].glyph).toBe("⚠️")
  expect(searchEmojis("warning")[0].glyph).toBe("⚠️")
  expect(searchEmojis("<script>")).toHaveLength(0)
  expect(frequentEmojis({}).map((entry) => entry.glyph)).toEqual(["👉", "❌", "✅"])
  expect(frequentEmojis({ "💻": { count: 5, last: 1 }, "⚠️": { count: 5, last: 2 } }).slice(0, 2).map((entry) => entry.glyph)).toEqual(["⚠️", "💻"])
})
