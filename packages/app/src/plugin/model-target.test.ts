import { describe, expect, test } from "bun:test"
import {
  modelTargetRequestPayload,
  normalizeModelTargetReference,
  parseModelTarget,
  stripModelTargetModelPrefix,
} from "./model-target"

const chains = ["review", "speech"]

describe("model target references", () => {
  test("parses explicit model and chain targets", () => {
    expect(parseModelTarget("model:openai/gpt-5.6-sol", chains)).toEqual({
      kind: "model",
      providerID: "openai",
      modelID: "gpt-5.6-sol",
    })
    expect(parseModelTarget("chain:review", chains)).toEqual({ kind: "chain", id: "review" })
  })

  test("migrates legacy values without changing the selected target", () => {
    expect(normalizeModelTargetReference("openai/gpt-5.6-sol", chains)).toBe("model:openai/gpt-5.6-sol")
    expect(normalizeModelTargetReference("review", chains)).toBe("chain:review")
    expect(normalizeModelTargetReference("default", chains)).toBe("chain:default")
  })

  test("creates the mutually exclusive host request payload", () => {
    expect(modelTargetRequestPayload("model:openai/gpt-5.6-sol", chains)).toEqual({
      model: "openai/gpt-5.6-sol",
    })
    expect(modelTargetRequestPayload("chain:review", chains)).toEqual({ chain: "review" })
    expect(modelTargetRequestPayload("", chains)).toBeUndefined()
  })

  test("tolerates a durable model reference at legacy host boundaries", () => {
    expect(stripModelTargetModelPrefix("model:openrouter/qwen/qwen3-asr-flash")).toBe("openrouter/qwen/qwen3-asr-flash")
  })
})
