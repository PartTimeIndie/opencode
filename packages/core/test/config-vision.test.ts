import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigVision } from "@opencode-ai/core/config/vision"

describe("ConfigVision", () => {
  test("accepts empty object (all fields optional)", () => {
    const result = Schema.decodeUnknownSync(ConfigVision.Info)({})
    expect(result.enabled).toBeUndefined()
    expect(result.primary).toBeUndefined()
    expect(result.fallbacks).toBeUndefined()
    expect(result.prompt_template).toBeUndefined()
  })

  test("accepts full config with primary + fallbacks", () => {
    const result = Schema.decodeUnknownSync(ConfigVision.Info)({
      enabled: true,
      primary: { model: "openai/gpt-4o" },
      fallbacks: [{ model: "anthropic/claude-sonnet-4-5", variant: "high" }],
      prompt_template: "Describe: {{user_message}} {{image_name}}",
    })
    expect(result.enabled).toBe(true)
    expect(result.primary?.model).toBe("openai/gpt-4o")
    expect(result.fallbacks).toHaveLength(1)
    expect(result.fallbacks?.[0]?.variant).toBe("high")
  })

  test("rejects invalid enabled type", () => {
    expect(() => Schema.decodeUnknownSync(ConfigVision.Info)({ enabled: "yes" })).toThrow()
  })

  test("ModelRef variant is optional", () => {
    const result = Schema.decodeUnknownSync(ConfigVision.Info)({
      primary: { model: "google/gemini-2.5-flash" },
    })
    expect(result.primary?.variant).toBeUndefined()
  })
})
