import { describe, expect, test } from "bun:test"
import { isContextOverflow } from "../src/provider-error"
import { isQuotaExceeded } from "../src/provider-quota"

describe("provider error classification", () => {
  test("distinguishes the exact Cerebras minute token quota from terminal account quota", () => {
    const minute = {
      message: "Tokens per minute limit exceeded - too many tokens processed.",
      type: "too_many_tokens_error",
      param: "quota",
      code: "token_quota_exceeded",
    }
    expect(isQuotaExceeded(JSON.stringify(minute))).toBe(false)
    for (const payload of [
      { ...minute, message: "Tokens per day limit exceeded" },
      { ...minute, message: "Token quota exceeded" },
      { ...minute, code: "quota_exceeded" },
      { ...minute, code: "insufficient_quota" },
      { ...minute, code: "usage_limit_reached" },
      { ...minute, code: "1308" },
      { ...minute, code: "1310" },
      { ...minute, message: "Weekly quota reached. Tokens per minute limit exceeded" },
      { ...minute, message: "Account quota exhausted. Tokens per minute limit exceeded" },
      { ...minute, message: "Daily quota exceeded. Tokens per minute limit exceeded" },
    ])
      expect(isQuotaExceeded(JSON.stringify(payload))).toBe(true)
    expect(isQuotaExceeded("rate limit")).toBe(false)
    expect(isQuotaExceeded("payment required")).toBe(false)
    expect(isQuotaExceeded("余额不足")).toBe(true)
  })

  test("classifies ordered context-overflow wording", () => {
    expect(isContextOverflow("input token count (120000) exceeds the maximum allowed by this model")).toBeTrue()
    expect(isContextOverflow("input length 120000 exceeds this model's context length")).toBeTrue()
  })

  test("does not backtrack over oversized provider messages", () => {
    const message = `input length${" exceeds".repeat(40_000)}`
    const started = performance.now()

    expect(isContextOverflow(message)).toBeFalse()
    expect(performance.now() - started).toBeLessThan(1_000)
  })
})
