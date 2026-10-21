import { describe, expect, test } from "bun:test"
import { ModelRequest } from "@opencode-ai/core/model-request"
import { requestProfiles } from "../../provider-plugins/openai/src/request-profiles"

describe("ModelRequest", () => {
  test("helper defaults reserve reasoning capacity even for short visible answers", () => {
    expect(ModelRequest.helperGeneration()).toEqual({ maxTokens: 8192 })
    expect(ModelRequest.helperGeneration({ temperature: 0 })).toEqual({ temperature: 0, maxTokens: 8192 })
  })

  test("helper defaults preserve explicit generation limits and sampling settings", () => {
    const generation = { maxTokens: 256, temperature: 0.2, topP: 0.9 }
    expect(ModelRequest.helperGeneration(generation)).toEqual(generation)
    expect(generation).toEqual({ maxTokens: 256, temperature: 0.2, topP: 0.9 })
  })

  test("partitions AI SDK model and models.dev mode options", () => {
    expect(
      ModelRequest.normalizeAiSdkOptions("@ai-sdk/openai", {
        maxOutputTokens: 4096,
        temperature: 0.2,
        reasoning: { mode: "pro" },
        reasoningEffort: "high",
        reasoningMode: "pro",
        serviceTier: "priority",
        custom_extension: { enabled: true },
      }, requestProfiles),
    ).toEqual({
      generation: { maxTokens: 4096, temperature: 0.2 },
      options: { reasoning: { mode: "pro" }, reasoningEffort: "high", reasoningMode: "pro", serviceTier: "priority" },
      body: { custom_extension: { enabled: true } },
    })
  })

  test("keeps unknown-provider options as compatibility fields", () => {
    expect(ModelRequest.normalizeAiSdkOptions(undefined, { temperature: 0.2, reasoningEffort: "high" })).toEqual({
      generation: { temperature: 0.2 },
      options: {},
      body: { reasoningEffort: "high" },
    })
  })

  test("does not consult inherited package-name properties", () => {
    expect(ModelRequest.normalizeAiSdkOptions("__proto__", { reasoningEffort: "high" })).toEqual({
      generation: {},
      options: {},
      body: { reasoningEffort: "high" },
    })
  })

  test("normalizes models.dev wire aliases owned by native protocols", () => {
    expect(ModelRequest.normalizeAiSdkOptions("@ai-sdk/openai", { service_tier: "priority" }, requestProfiles)).toEqual({
      generation: {},
      options: { serviceTier: "priority" },
      body: {},
    })
  })

  test("keeps an exact Cursor variant tuple in the provider option namespace", async () => {
    const cursor = await import("../../provider-plugins/cursor/src/request-profiles")
    const cursorVariantParameters = [
      { id: "context", value: "272k" },
      { id: "reasoning", value: "medium" },
      { id: "fast", value: "false" },
    ]

    expect(ModelRequest.namespace("cursor-opencode-provider", cursor.requestProfiles)).toBe("cursor")
    expect(
      ModelRequest.normalizeAiSdkOptions(
        "cursor-opencode-provider",
        { cursorVariantParameters },
        cursor.requestProfiles,
      ),
    ).toEqual({
      generation: {},
      options: { cursorVariantParameters },
      body: {},
    })
  })
})
