import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ModelV2 } from "../src/model"
import { ProviderV2 } from "../src/provider"
import { configuredModelRef, keepsFirmSelection, nextModel, overrideModel, shouldRetryChainStep } from "../src/session/runner/model-chain"

describe("session runner model chains", () => {
  test("retries a clean transient first attempt once before advancing, not after a barrier", () => {
    const input = { hasFallback: true, attempt: 0, retryable: true, deferred: false, replayBarrier: false }
    expect(shouldRetryChainStep(input)).toBe(true)
    expect(shouldRetryChainStep({ ...input, attempt: 1 })).toBe(false)
    expect(shouldRetryChainStep({ ...input, hasFallback: false })).toBe(false)
    expect(shouldRetryChainStep({ ...input, retryable: false })).toBe(false)
    expect(shouldRetryChainStep({ ...input, deferred: true })).toBe(false)
    expect(shouldRetryChainStep({ ...input, replayBarrier: true })).toBe(false)
  })
  test("a direct selection never inherits an agent chain, even when matching its first step", () => {
    const chosen = ModelV2.Ref.make({ providerID: ProviderV2.ID.make("cerebras"), id: ModelV2.ID.make("qwen") })
    const configured = ModelV2.Ref.make({
      ...chosen,
      chain: {
        id: "agent-chain", name: "Agent chain", active: 0,
        steps: [chosen, { providerID: ProviderV2.ID.make("other"), id: ModelV2.ID.make("fallback") }],
      },
    })
    const resolved = { provider: "cerebras", id: "qwen" }
    expect(configuredModelRef(chosen, configured, resolved)).toBe(chosen)
    expect(nextModel(configuredModelRef(chosen, configured, resolved))).toBeUndefined()
    const optedOut = ModelV2.Ref.make({ ...chosen, chain: null })
    expect(configuredModelRef(optedOut, configured, resolved)).toBe(optedOut)
    expect(configuredModelRef(configured, chosen, resolved)).toBe(configured)
    expect(nextModel(configuredModelRef(configured, chosen, resolved))?.id).toBe(ModelV2.ID.make("fallback"))
    expect(configuredModelRef(undefined, configured, resolved)).toBe(configured)
    expect(configuredModelRef(undefined, undefined, resolved)).toEqual(chosen)
  })

  test("advances exactly once in configured order while preserving variants", () => {
    const first = ModelV2.Ref.make({
      providerID: ProviderV2.ID.make("one"),
      id: ModelV2.ID.make("primary"),
      variant: ModelV2.VariantID.make("high"),
      chain: {
        id: "standard",
        name: "Standard",
        active: 0,
        steps: [
          { providerID: ProviderV2.ID.make("one"), id: ModelV2.ID.make("primary"), variant: ModelV2.VariantID.make("high") },
          { providerID: ProviderV2.ID.make("two"), id: ModelV2.ID.make("fallback"), variant: ModelV2.VariantID.make("medium") },
          { providerID: ProviderV2.ID.make("three"), id: ModelV2.ID.make("last") },
        ],
      },
    })
    const second = nextModel(first)
    expect(second).toMatchObject({ providerID: "two", id: "fallback", variant: "medium", chain: { active: 1 } })
    expect(nextModel(second!)).toMatchObject({ providerID: "three", id: "last", chain: { active: 2 } })
    expect(nextModel(nextModel(second!)!)).toBeUndefined()
  })

  test("does not fall back for a single model", () => {
    expect(nextModel(ModelV2.Ref.make({ providerID: ProviderV2.ID.make("one"), id: ModelV2.ID.make("primary") }))).toBeUndefined()
  })

  test("preserves an explicit null chain as a no-fallback selection", () => {
    const selected = Schema.decodeUnknownSync(ModelV2.Ref)({
      providerID: "one",
      id: "primary",
      chain: null,
    })
    const current = ModelV2.Ref.make({
      providerID: ProviderV2.ID.make("one"),
      id: ModelV2.ID.make("primary"),
      chain: {
        id: "standard",
        name: "Standard",
        steps: [
          { providerID: ProviderV2.ID.make("one"), id: ModelV2.ID.make("primary") },
          { providerID: ProviderV2.ID.make("two"), id: ModelV2.ID.make("fallback") },
        ],
      },
    })

    expect(overrideModel(current, selected).chain).toBeNull()
    expect(nextModel(selected)).toBeUndefined()
  })

  test("keeps Settings fallbacks when an agent overrides the active model", () => {
    const current = ModelV2.Ref.make({
      providerID: ProviderV2.ID.make("one"),
      id: ModelV2.ID.make("primary"),
      chain: {
        id: "standard",
        name: "Standard",
        active: 0,
        steps: [
          { providerID: ProviderV2.ID.make("one"), id: ModelV2.ID.make("primary") },
          { providerID: ProviderV2.ID.make("two"), id: ModelV2.ID.make("fallback") },
        ],
      },
    })
    const model = ModelV2.Ref.make({
      providerID: ProviderV2.ID.make("agent"),
      id: ModelV2.ID.make("configured"),
      variant: ModelV2.VariantID.make("high"),
    })

    expect(overrideModel(current, model)).toEqual({
      ...model,
      chain: {
        ...current.chain!,
        active: 0,
        steps: [
          { providerID: model.providerID, id: model.id, variant: model.variant },
          current.chain!.steps[1]!,
        ],
      },
    })
  })

  test("selects an existing matching chain step for an agent override", () => {
    const current = ModelV2.Ref.make({
      providerID: ProviderV2.ID.make("one"),
      id: ModelV2.ID.make("primary"),
      chain: {
        id: "standard",
        name: "Standard",
        active: 0,
        steps: [
          { providerID: ProviderV2.ID.make("one"), id: ModelV2.ID.make("primary") },
          { providerID: ProviderV2.ID.make("two"), id: ModelV2.ID.make("fallback") },
        ],
      },
    })
    const model = ModelV2.Ref.make({
      ...current.chain!.steps[1]!,
      variant: ModelV2.VariantID.make("max"),
    })

    expect(overrideModel(current, model)).toMatchObject({
      ...model,
      chain: { active: 1, steps: [current.chain!.steps[0]!, model] },
    })
  })

  test("a firmly picked model stays fixed while the session runs", () => {
    const firm = ModelV2.Ref.make({
      providerID: ProviderV2.ID.make("openai-api"),
      id: ModelV2.ID.make("gpt-6.2-sol"),
      variant: ModelV2.VariantID.make("high"),
      chain: null,
    })
    const stale = ModelV2.Ref.make({ providerID: ProviderV2.ID.make("zhipuai-coding-plan"), id: ModelV2.ID.make("glm-5.4") })

    // A prompt that only echoes a picker state carries no chain decision.
    expect(keepsFirmSelection(firm, stale)).toBe(true)
    // An explicit new pick (chain: null) or an explicitly selected chain still applies.
    expect(keepsFirmSelection(firm, { ...stale, chain: null })).toBe(false)
    expect(keepsFirmSelection(firm, { ...stale, chain: { id: "standard", name: "Standard", steps: [stale] } })).toBe(false)
    // Sessions without a firm direct selection keep accepting prompt models.
    expect(keepsFirmSelection(undefined, stale)).toBe(false)
    expect(keepsFirmSelection({ ...firm, chain: undefined }, stale)).toBe(false)
  })
})
