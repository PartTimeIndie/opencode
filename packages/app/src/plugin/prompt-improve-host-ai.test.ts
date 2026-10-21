import { describe, expect, test } from "bun:test"
import path from "node:path"

const { normalizeSettings, promptImproveAIRequest, promptImproveMaxTokens } = await import(
  `${path.resolve("../../.opencode/plugin-sources/prompt-improve-app/index.js")}?test=${Date.now()}`
)

describe("prompt-improve-app host AI model-target contract", () => {
  test("reserves output capacity for reasoning as well as the visible rewrite", () => {
    expect(promptImproveMaxTokens("short")).toBe(8192)
    expect(promptImproveMaxTokens("x".repeat(20_000))).toBe(14_096)
    expect(promptImproveMaxTokens("x".repeat(40_000))).toBe(16_384)
  })

  test("uses a configured chain and trims its reference", () => {
    expect(promptImproveAIRequest(normalizeSettings({ modelChain: " chain:rewrite-chain " }))).toEqual({
      chain: "rewrite-chain",
    })
  })

  test("uses a configured direct model without collapsing it into a chain", () => {
    expect(promptImproveAIRequest(normalizeSettings({ modelChain: "model:zhipuai-coding-plan/glm-5.3" }))).toEqual({
      model: "zhipuai-coding-plan/glm-5.3",
    })
  })

  test("uses the Settings default chain until the runtime persists its concrete id", () => {
    expect(promptImproveAIRequest(normalizeSettings({}))).toEqual({ chain: "default" })
  })

  test("unrelated legacy settings do not override the durable default target", () => {
    expect(promptImproveAIRequest(normalizeSettings({ model: "legacy/provider", useDefaultChain: false }))).toEqual({
      chain: "default",
    })
  })

  test("normalizes an empty chain to the safe default reference", () => {
    expect(normalizeSettings({ modelChain: "   " })).toMatchObject({ modelChain: "chain:default" })
  })
})
