import { expect, test } from "bun:test"
import { toUsage } from "@opencode-ai/core/session/runner/aisdk"

test("SDK cache usage distinguishes missing wire evidence from an explicit zero", () => {
  const usage = {
    inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
  }
  for (const raw of [
    { input_tokens: 100 },
    { input_tokens: 100, input_tokens_details: null },
    { input_tokens: 100, input_tokens_details: {} },
    { input_tokens: 100, input_tokens_details: { cached_tokens: "0" } },
    { prompt_tokens: 100 },
    { prompt_tokens: 100, prompt_tokens_details: null },
    { prompt_tokens: 100, prompt_tokens_details: {} },
    { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: "0" } },
  ]) {
    const result = toUsage({ ...usage, raw }, undefined)
    expect(result?.cacheReadInputTokens).toBeUndefined()
  }
  for (const count of [0, 79, 80, -1, 101]) {
    for (const raw of [
      { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: count } },
      { input_tokens: 100, input_tokens_details: { cached_tokens: count } },
    ]) {
      const result = toUsage({ ...usage, raw }, undefined)
      expect(result?.cacheReadInputTokens).toBe(count)
    }
  }
  expect(
    toUsage(
      {
        ...usage,
        inputTokens: { ...usage.inputTokens, cacheRead: 80 },
        raw: { input_tokens: 20, cache_read_input_tokens: 80 },
      },
      undefined,
    )?.cacheReadInputTokens,
  ).toBe(80)
  expect(
    toUsage(
      { ...usage, inputTokens: { ...usage.inputTokens, cacheRead: 80 }, raw: { provider_specific: true } },
      undefined,
    )?.cacheReadInputTokens,
  ).toBe(80)
})
