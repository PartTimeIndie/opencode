import { describe, expect, test } from "bun:test"
import { Token } from "@opencode-ai/core/util/token"

describe("Token.estimateFootprint", () => {
  test("counts plain request content by characters", () => {
    const text = "z".repeat(40_000)
    expect(Token.estimateFootprint({ messages: [{ role: "user", content: text }] })).toBeGreaterThanOrEqual(10_000)
  })

  test("prices base64 image data URLs as flat media tokens instead of text", () => {
    const image = `data:image/png;base64,${"A".repeat(1_000_000)}`
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "look at this screenshot" },
          { type: "file", data: image, mediaType: "image/png" },
        ],
      },
    ]
    const withImage = Token.estimateFootprint(messages)
    expect(withImage).toBeGreaterThanOrEqual(1_600)
    expect(withImage).toBeLessThan(3_000)
  })

  test("prices raw base64 media parts from tool results as media tokens", () => {
    const output = {
      type: "content",
      value: [
        { type: "text", text: "screenshot captured" },
        { type: "media", mediaType: "image/png", data: "B".repeat(500_000) },
      ],
    }
    expect(Token.estimateFootprint(output)).toBeLessThan(3_000)
  })

  test("prices media parts holding binary data as media tokens", () => {
    const part = { type: "media", mediaType: "image/png", data: new Uint8Array(100_000) }
    expect(Token.estimateFootprint({ messages: [part] })).toBeLessThan(3_000)
  })

  test("keeps counting short and http media references as text", () => {
    const parts = [
      { type: "file", uri: "C:/repo/src/index.ts", mime: "text/plain" },
      { type: "image", image: `https://example.com/${"x".repeat(2_000)}` },
    ]
    const estimate = Token.estimateFootprint(parts)
    expect(estimate).toBeGreaterThan(500)
    expect(estimate).toBeLessThan(700)
  })
})
