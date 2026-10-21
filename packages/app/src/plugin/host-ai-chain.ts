import { AIChain } from "@opencode-ai/core/ai-chain"
import type { ModelChain, ModelChainStep } from "@/context/model-chain"

export type HostAIChainResolution =
  | { status: "none" }
  | { status: "chain"; steps: ModelChainStep[] }
  | { status: "invalid"; reason: string }

/**
 * Resolves a plugin's host AI chain reference into the bounded step snapshot
 * the host AI endpoint accepts. The chain definition itself lives exactly once
 * in the app models store; plugins only reference it by ID or "default" and the
 * runtime sends the snapshot with the request.
 *
 * An absent or blank reference means "no chain requested" and keeps the legacy
 * single-model path. Every present reference must resolve to a chain that
 * satisfies the core chain contract: a missing default chain, an unknown ID, or
 * an invalid snapshot is reported as `invalid` so the caller fails closed
 * instead of silently falling back to the plugin's single model. There is never
 * a chains[0] fallback for an unresolved "default" reference.
 */
export function resolveHostAIChain(
  chainRef: string | undefined,
  chains: ModelChain[],
  defaultChainID: string | undefined,
): HostAIChainResolution {
  const reference = chainRef?.trim()
  if (!reference) return { status: "none" }
  const id = reference === "default" ? defaultChainID?.trim() : reference
  if (!id) return { status: "invalid", reason: `no default model chain is configured for chain reference "${reference}"` }
  const chain = chains.find((item) => item.id === id)
  if (!chain) return { status: "invalid", reason: `no model chain with id "${id}" is configured` }
  // Both sides validate with the same core rules so a corrupted or oversized
  // chain snapshot can never silently reorder the user's fallback path.
  const normalized = AIChain.normalizeAIChainSteps(chain.steps)
  const steps = normalized.steps
  if (normalized.error || !steps?.length)
    return {
      status: "invalid",
      reason: `model chain "${id}" is invalid: ${normalized.error ?? "chain must contain at least one step"}`,
    }
  return { status: "chain", steps }
}
