import { resolveHostAIChain } from "./host-ai-chain"
import { parseModelTarget } from "./model-target"
import type { ModelChain, ModelChainStep } from "@/context/model-chain"

export type GitCommitChainResolution =
  { status: "chain"; steps: ModelChainStep[] } | { status: "invalid"; reason: string }

export type GitCommitTargetResolution =
  | { status: "chain"; steps: ModelChainStep[] }
  | { status: "model"; model: string }
  | { status: "invalid"; reason: string }

/**
 * Resolves the selected Git Workbench AI-commit chain using the same validation
 * as every other chain consumer. Missing or broken selections fail closed.
 */
export function resolveGitCommitChain(
  chainID: string | undefined,
  chains: ModelChain[],
  defaultChainID: string | undefined,
): GitCommitChainResolution {
  if (!chainID?.trim()) return { status: "invalid", reason: "No AI commit model chain is configured." }
  const resolution = resolveHostAIChain(chainID, chains, defaultChainID)
  if (resolution.status === "chain") return { status: "chain", steps: resolution.steps }
  if (resolution.status === "none") return { status: "invalid", reason: "No AI commit model chain is configured." }
  return { status: "invalid", reason: resolution.reason }
}

export function resolveGitCommitTarget(
  value: string | undefined,
  chains: ModelChain[],
  defaultChainID: string | undefined,
  availableModels: ReadonlyArray<{ providerID: string; modelID: string }>,
): GitCommitTargetResolution {
  const target = parseModelTarget(
    value,
    chains.map((chain) => chain.id),
  )
  if (target.kind === "none") return { status: "invalid", reason: "No AI commit model or chain is configured." }
  if (target.kind === "model") {
    const model = `${target.providerID}/${target.modelID}`
    if (!availableModels.some((item) => item.providerID === target.providerID && item.modelID === target.modelID))
      return { status: "invalid", reason: `The configured AI commit model ${model} is unavailable.` }
    return { status: "model", model }
  }
  const chain = resolveGitCommitChain(target.id, chains, defaultChainID)
  if (chain.status === "chain") return chain
  return { status: "invalid", reason: chain.reason }
}
