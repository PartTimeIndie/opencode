import { describe, expect, test } from "bun:test"
import { resolveGitCommitChain, resolveGitCommitTarget } from "./git-commit-chain"
import type { ModelChain } from "@/context/model-chain"

const chains: ModelChain[] = [
  {
    id: "commit-chain",
    name: "Commit fallback",
    steps: [
      { providerID: "zhipuai-coding-plan", modelID: "glm-5.3" },
      { providerID: "openai", modelID: "gpt-5.6-sol", variant: "medium" },
    ],
  },
]

describe("resolveGitCommitChain", () => {
  test("resolves a concrete configured chain", () => {
    expect(resolveGitCommitChain("commit-chain", chains, undefined)).toEqual({
      status: "chain",
      steps: chains[0]!.steps,
    })
  })

  test("resolves the default reference through Settings", () => {
    expect(resolveGitCommitChain("default", chains, "commit-chain").status).toBe("chain")
  })

  test("fails closed for missing, stale, or broken selections", () => {
    expect(resolveGitCommitChain(undefined, chains, "commit-chain").status).toBe("invalid")
    expect(resolveGitCommitChain("missing", chains, "commit-chain").status).toBe("invalid")
    expect(resolveGitCommitChain("default", chains, undefined).status).toBe("invalid")
    expect(resolveGitCommitChain("broken", [{ id: "broken", name: "Broken", steps: [] }], undefined).status).toBe(
      "invalid",
    )
  })
})

describe("resolveGitCommitTarget", () => {
  const available = [
    { providerID: "zhipuai-coding-plan", modelID: "glm-5.3" },
    { providerID: "openai", modelID: "gpt-5.6-sol" },
  ]

  test("supports one direct model or one validated chain", () => {
    expect(resolveGitCommitTarget("model:zhipuai-coding-plan/glm-5.3", chains, undefined, available)).toEqual({
      status: "model",
      model: "zhipuai-coding-plan/glm-5.3",
    })
    expect(resolveGitCommitTarget("chain:commit-chain", chains, undefined, available)).toEqual({
      status: "chain",
      steps: chains[0]!.steps,
    })
  })

  test("fails closed for a stale direct model", () => {
    expect(resolveGitCommitTarget("model:openai/removed", chains, undefined, available)).toEqual({
      status: "invalid",
      reason: "The configured AI commit model openai/removed is unavailable.",
    })
  })
})
