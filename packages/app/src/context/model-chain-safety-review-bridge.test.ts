import { describe, expect, test } from "bun:test"
import {
  safetyReviewBridgeWrite,
  safetyReviewChainSnapshot,
  safetyReviewTargetReference,
  safetyReviewTargetWrite,
} from "./model-chain-safety-review-snapshot"

const chain = [
  { providerID: "zhipuai-coding-plan", modelID: "glm-5.3" },
  { providerID: "openai", modelID: "gpt-6-sol", variant: "medium" },
]

describe("safetyReviewChainSnapshot", () => {
  test("persists the exact validated Settings chain and removes divergent model pins", () => {
    expect(
      safetyReviewChainSnapshot({ model: "legacy/reviewer", fallback: { model: "legacy/fallback" } }, chain, "review"),
    ).toEqual({
      chain_id: "review",
      model: undefined,
      variant: undefined,
      fallback: undefined,
      chain,
    })
  })

  test("does not rewrite an identical snapshot", () => {
    expect(safetyReviewChainSnapshot({ chain_id: "review", chain }, chain, "review")).toBeUndefined()
  })

  test("clears a legacy variant-only pin when the chain is already current", () => {
    expect(safetyReviewChainSnapshot({ chain_id: "review", chain, variant: "legacy" }, chain, "review")).toEqual({
      chain_id: "review",
      model: undefined,
      variant: undefined,
      fallback: undefined,
      chain,
    })
  })

  test("fails closed for an invalid snapshot instead of choosing another chain", () => {
    expect(safetyReviewChainSnapshot({ chain }, [chain[0], chain[0]])).toEqual({
      model: undefined,
      variant: undefined,
      fallback: undefined,
      chain: undefined,
    })
  })

  test("keeps a model-only pin when no valid default chain exists", () => {
    expect(safetyReviewChainSnapshot({ model: "legacy/reviewer" }, [])).toBeUndefined()
  })

  test("adopts a valid chain and clears a model-only pin", () => {
    expect(safetyReviewChainSnapshot({ model: "legacy/reviewer" }, chain)).toEqual({
      model: undefined,
      variant: undefined,
      fallback: undefined,
      chain,
    })
  })

  test("keeps legacy pins and removes only the chain when no default chain exists", () => {
    expect(
      safetyReviewChainSnapshot({ prompt: "custom prompt", model: "legacy/reviewer", variant: "high", chain }, []),
    ).toEqual({
      prompt: "custom prompt",
      model: "legacy/reviewer",
      variant: "high",
      chain: undefined,
    })
  })

  test("does not rewrite a chain that differs only in key order or absent optional keys", () => {
    const steps = [
      { modelID: "glm-5.3", providerID: "zhipuai-coding-plan", variant: undefined },
      { variant: "medium", modelID: "gpt-6-sol", providerID: "openai" },
    ]
    expect(safetyReviewChainSnapshot({ chain }, steps)).toBeUndefined()
  })

  test("rewrites when a step semantically diverges", () => {
    expect(
      safetyReviewChainSnapshot({ chain }, [
        { providerID: "zhipuai-coding-plan", modelID: "glm-5.3", variant: "high" },
        chain[1],
      ]),
    ).not.toBeUndefined()
  })
})

describe("safetyReviewBridgeWrite", () => {
  const chain = [{ providerID: "opencode", modelID: "global-reviewer" }]
  const write = (overrides: Partial<Parameters<typeof safetyReviewBridgeWrite>[0]>) =>
    safetyReviewBridgeWrite({
      modelsReady: true,
      modelChainsReady: true,
      permissionReady: true,
      globalConfigReady: true,
      defaultChainID: "chain-global",
      chains: [{ id: "chain-global", steps: chain }],
      current: { prompt: "custom prompt" },
      ...overrides,
    })

  test("holds the chain write until the global config has hydrated", () => {
    expect(write({ globalConfigReady: false })).toBeUndefined()
    expect(write({ modelChainsReady: false })).toBeUndefined()
    // Read-only management may become available after a failed config fetch,
    // but the bridge must stay gated on successful hydration.
    expect(write({ modelChainsReady: false, globalConfigReady: false })).toBeUndefined()
    expect(write({ modelsReady: false })).toBeUndefined()
    expect(write({ permissionReady: false })).toBeUndefined()
  })

  test("preserves a server-side prompt once the config is ready", () => {
    expect(write({})).toEqual({
      prompt: "custom prompt",
      chain_id: "default",
      model: undefined,
      variant: undefined,
      fallback: undefined,
      chain,
    })
  })

  test("preserves an explicitly recorded chain when the global default changes", () => {
    expect(
      write({
        defaultChainID: "chain-next",
        chains: [
          { id: "chain-global", steps: chain },
          { id: "chain-next", steps: [{ providerID: "openai", modelID: "gpt-6-sol" }] },
        ],
        current: { chain_id: "chain-global", chain },
      }),
    ).toBeUndefined()
  })

  test("follows default-derived snapshots when the global default changes", () => {
    const initial = write({})!
    expect(initial.chain_id).toBe("default")

    const nextChain = [{ providerID: "openai", modelID: "gpt-6-sol" }]
    expect(
      write({
        defaultChainID: "chain-next",
        chains: [
          { id: "chain-global", steps: chain },
          { id: "chain-next", steps: nextChain },
        ],
        current: initial,
      }),
    ).toMatchObject({ chain_id: "default", chain: nextChain })
  })

  test("preserves an explicitly recorded chain when the global default is cleared", () => {
    expect(write({ defaultChainID: undefined, current: { chain_id: "chain-global", chain } })).toBeUndefined()
  })

  test("clears the snapshot but keeps following the default when no default remains", () => {
    expect(write({ defaultChainID: undefined, current: { chain_id: "default", chain } })).toEqual({
      chain_id: "default",
      chain: undefined,
    })
  })

  test("migrates an existing matching snapshot to a durable chain id", () => {
    expect(write({ defaultChainID: undefined, current: { chain } })).toEqual({
      chain_id: "chain-global",
      model: undefined,
      variant: undefined,
      fallback: undefined,
      chain,
    })
  })

  test("keeps an unavailable configured id visible while clearing its stale snapshot", () => {
    expect(write({ defaultChainID: undefined, chains: [], current: { chain_id: "removed", chain } })).toEqual({
      chain_id: "removed",
      chain: undefined,
    })
  })

  test("never replaces a configured direct model with the default chain", () => {
    expect(write({ current: { model: "zhipuai-coding-plan/glm-5.3" } })).toBeUndefined()
  })

  test("an explicitly selected valid chain replaces a stale legacy model pin", () => {
    expect(
      write({ current: { chain_id: "chain-global", model: "opencode/deepseek-v4-flash-free", prompt: "keep me" } }),
    ).toEqual({
      chain_id: "chain-global",
      model: undefined,
      prompt: "keep me",
      variant: undefined,
      fallback: undefined,
      chain,
    })
  })
})

describe("safety review model target", () => {
  const chains = [{ id: "review", steps: chain }]

  test("resolves a bridge-owned default target to the current default chain", () => {
    expect(
      safetyReviewTargetReference({
        current: { chain_id: "default", chain },
        chains: [
          { id: "review", steps: chain },
          { id: "next", steps: [{ providerID: "openai", modelID: "gpt-6-sol" }] },
        ],
        defaultChainID: "next",
      }),
    ).toBe("chain:next")
    expect(
      safetyReviewTargetReference({
        current: { chain_id: "default", chain },
        chains,
      }),
    ).toBe("")
  })

  test("shows an explicitly selected valid chain over a stale model pin", () => {
    expect(
      safetyReviewTargetReference({
        current: { chain_id: "review", chain, model: "opencode/deepseek-v4-flash-free" },
        chains,
      }),
    ).toBe("chain:review")
  })

  test("exposes and persists a direct model target", () => {
    expect(
      safetyReviewTargetReference({
        current: { model: "zhipuai-coding-plan/glm-5.3" },
        chains,
        defaultChainID: "review",
      }),
    ).toBe("model:zhipuai-coding-plan/glm-5.3")
    expect(
      safetyReviewTargetWrite({
        current: { chain_id: "review", chain },
        value: "model:zhipuai-coding-plan/glm-5.3",
        chains,
        defaultChainID: "review",
      }),
    ).toEqual({
      chain_id: undefined,
      chain: undefined,
      model: "zhipuai-coding-plan/glm-5.3",
      variant: undefined,
      fallback: undefined,
    })
  })

  test("persists the validated chain snapshot when a chain is selected", () => {
    expect(
      safetyReviewTargetWrite({
        current: { model: "zhipuai-coding-plan/glm-5.3" },
        value: "chain:review",
        chains,
      }),
    ).toEqual({
      chain_id: "review",
      chain,
      model: undefined,
      variant: undefined,
      fallback: undefined,
    })
  })
})
