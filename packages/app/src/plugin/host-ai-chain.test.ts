import { describe, expect, test } from "bun:test"
import { resolveHostAIChain } from "./host-ai-chain"
import type { ModelChain } from "@/context/model-chain"

const chains: ModelChain[] = [
  {
    id: "chain-a",
    name: "Quota fallback",
    steps: [
      { providerID: "zhipuai-coding-plan", modelID: "glm-5.3" },
      { providerID: "openai", modelID: "gpt-5.6-sol", variant: "medium" },
    ],
  },
  {
    id: "chain-b",
    name: "Cheap",
    steps: [{ providerID: "opencode", modelID: "deepseek-v4-flash-free" }],
  },
]

describe("resolveHostAIChain", () => {
  test("reports none only when no chain reference is requested", () => {
    expect(resolveHostAIChain(undefined, chains, "chain-a")).toEqual({ status: "none" })
    expect(resolveHostAIChain("", chains, "chain-a")).toEqual({ status: "none" })
    expect(resolveHostAIChain("   ", chains, "chain-a")).toEqual({ status: "none" })
  })

  test("resolves the default reference through the configured defaultChainID", () => {
    expect(resolveHostAIChain("default", chains, "chain-a")).toEqual({
      status: "chain",
      steps: [
        { providerID: "zhipuai-coding-plan", modelID: "glm-5.3" },
        { providerID: "openai", modelID: "gpt-5.6-sol", variant: "medium" },
      ],
    })
  })

  test("resolves an explicit chain ID and preserves exact order and variants", () => {
    expect(resolveHostAIChain("chain-b", chains, "chain-a")).toEqual({
      status: "chain",
      steps: [{ providerID: "opencode", modelID: "deepseek-v4-flash-free" }],
    })
  })

  test("fails closed when default is requested but no default chain is configured", () => {
    for (const defaultChainID of [undefined, "", "   "]) {
      const result = resolveHostAIChain("default", chains, defaultChainID)
      expect(result.status).toBe("invalid")
      if (result.status === "invalid") expect(result.reason).toContain("no default model chain")
    }
  })

  test("fails closed for unknown chain IDs instead of falling back to the model", () => {
    const result = resolveHostAIChain("missing", chains, "chain-a")
    expect(result.status).toBe("invalid")
    if (result.status === "invalid") expect(result.reason).toContain('"missing"')
  })

  test("fails closed for chains that no longer satisfy the host chain contract", () => {
    const oversized: ModelChain = {
      id: "chain-big",
      name: "Too long",
      steps: Array.from({ length: 6 }, (_, index) => ({ providerID: `p${index}`, modelID: "m" })),
    }
    expect(resolveHostAIChain("chain-big", [oversized], "chain-big").status).toBe("invalid")

    const duplicate: ModelChain = {
      id: "chain-dup",
      name: "Duplicate",
      steps: [
        { providerID: "openai", modelID: "gpt" },
        { providerID: "openai", modelID: "gpt" },
      ],
    }
    expect(resolveHostAIChain("chain-dup", [duplicate], "chain-dup").status).toBe("invalid")
  })

  test("fails closed when the referenced chain has no steps", () => {
    const empty: ModelChain = { id: "chain-empty", name: "Empty", steps: [] }
    const result = resolveHostAIChain("chain-empty", [empty, ...chains], "chain-empty")
    expect(result.status).toBe("invalid")
    if (result.status === "invalid") expect(result.reason).toContain("at least one step")
  })
})
