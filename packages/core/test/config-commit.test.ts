import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigCommit } from "@opencode-ai/core/config/commit"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"

describe("ConfigCommit", () => {
  test("uses Cursor Composer as the default commit model", () => {
    expect(ConfigCommit.DEFAULT_COMMIT_MODEL).toBe("cursor/composer")
  })

  test("reads a configured commit model with generation options", () => {
    const input = {
      commit: {
        model: "anthropic/claude-haiku",
        generation: { temperature: 0.1, maxTokens: 256 },
      },
    } as const
    const decoded = Schema.decodeUnknownSync(ConfigV1.Info)(input)
    expect(decoded.commit).toEqual({
      model: "anthropic/claude-haiku",
      generation: { temperature: 0.1, maxTokens: 256 },
    })
  })

  test("encodes the commit config round-trip", () => {
    const input = { commit: { model: "opencode/deepseek-v4-flash-free" } } as const
    expect(Schema.encodeUnknownSync(ConfigV1.Info)(Schema.decodeUnknownSync(ConfigV1.Info)(input))).toEqual(input)
  })
})
