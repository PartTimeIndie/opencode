import { AIChain } from "@opencode-ai/core/ai-chain"
import { modelTargetReference, parseModelTarget } from "@/plugin/model-target"
import type { AccessControlSafetyReview } from "./permission-auto-respond"

const DEFAULT_CHAIN_TARGET = "default"

export function safetyReviewChainSnapshot(
  current: AccessControlSafetyReview,
  steps: unknown,
  chainID?: string,
): AccessControlSafetyReview | undefined {
  const chain = normalizedChain(steps)
  // A valid Settings chain is the sole reviewer source: adopting it clears the
  // legacy single-model pins.
  if (chain) {
    if (
      sameSafetyReviewChain(current.chain, chain) &&
      current.chain_id === chainID &&
      !current.model &&
      !current.variant &&
      !current.fallback
    )
      return
    return {
      ...current,
      ...(chainID ? { chain_id: chainID } : {}),
      model: undefined,
      variant: undefined,
      fallback: undefined,
      chain,
    }
  }
  // Without a valid selected chain the legacy pins stay exactly as configured;
  // only a previously written chain snapshot is removed so no consumer keeps
  // resolving a retired chain.
  if (!current.chain) return
  return { ...current, chain: undefined }
}

function normalizedChain(value: unknown) {
  const normalized = AIChain.normalizeAIChainSteps(value)
  return normalized.error ? undefined : normalized.steps
}

// Key order and absent optional keys must not trigger a rewrite: both sides
// go through the same normalization and are compared field by field, in order.
export function sameSafetyReviewChain(left: unknown, right: unknown) {
  const a = normalizedChain(left)
  const b = normalizedChain(right)
  if (!a || !b || a.length !== b.length) return false
  return a.every(
    (step, index) =>
      step.providerID === b[index].providerID && step.modelID === b[index].modelID && step.variant === b[index].variant,
  )
}

// The bridge must not write before the server-side global config has
// hydrated: globalSafetyReview() falls back to the empty default until then,
// and a snapshot taken from that default silently drops a configured prompt,
// options, or generation on the server.
export function safetyReviewBridgeWrite(input: {
  modelsReady: boolean
  modelChainsReady: boolean
  permissionReady: boolean
  globalConfigReady: boolean
  defaultChainID: string | undefined
  chains: Array<{ id: string; steps: unknown }>
  current: AccessControlSafetyReview
}) {
  if (!input.modelsReady || !input.modelChainsReady || !input.permissionReady || !input.globalConfigReady) return
  const chainTarget = input.current.chain_id?.trim()
  if (
    input.current.model &&
    chainTarget !== DEFAULT_CHAIN_TARGET &&
    !input.chains.some((chain) => chain.id === chainTarget)
  )
    return
  const migrated = chainTarget
    ? undefined
    : input.chains.find((chain) => sameSafetyReviewChain(input.current.chain, chain.steps))?.id
  const followsDefault = chainTarget === DEFAULT_CHAIN_TARGET || (!chainTarget && !migrated)
  // The `default` marker distinguishes bridge-owned snapshots from explicit
  // Settings chain selections, which keep their durable chain id.
  const id =
    chainTarget === DEFAULT_CHAIN_TARGET
      ? input.defaultChainID?.trim()
      : chainTarget || migrated || input.defaultChainID?.trim()
  const selected = id ? input.chains.find((chain) => chain.id === id) : undefined
  return safetyReviewChainSnapshot(input.current, selected?.steps ?? [], followsDefault ? DEFAULT_CHAIN_TARGET : id)
}

export function safetyReviewTargetReference(input: {
  current: AccessControlSafetyReview
  chains: Array<{ id: string; steps: unknown }>
  defaultChainID?: string
}) {
  const id = input.current.chain_id?.trim()
  if (id === DEFAULT_CHAIN_TARGET && input.defaultChainID)
    return modelTargetReference({ kind: "chain", id: input.defaultChainID })
  if (id === DEFAULT_CHAIN_TARGET) return ""
  if (id && input.chains.some((chain) => chain.id === id)) return modelTargetReference({ kind: "chain", id })
  const model = parseModelTarget(input.current.model)
  if (model.kind === "model") return modelTargetReference(model)
  if (id) return modelTargetReference({ kind: "chain", id })
  const migrated = input.chains.find((chain) => sameSafetyReviewChain(input.current.chain, chain.steps))?.id
  if (migrated) return modelTargetReference({ kind: "chain", id: migrated })
  return input.defaultChainID ? modelTargetReference({ kind: "chain", id: input.defaultChainID }) : ""
}

export function safetyReviewTargetWrite(input: {
  current: AccessControlSafetyReview
  value: string
  chains: Array<{ id: string; steps: unknown }>
  defaultChainID?: string
}) {
  const target = parseModelTarget(
    input.value,
    input.chains.map((chain) => chain.id),
  )
  if (target.kind === "none") return
  if (target.kind === "model") {
    const model = `${target.providerID}/${target.modelID}`
    if (
      input.current.model === model &&
      !input.current.variant &&
      !input.current.fallback &&
      !input.current.chain_id &&
      !input.current.chain
    )
      return
    return {
      ...input.current,
      model,
      variant: undefined,
      fallback: undefined,
      chain_id: undefined,
      chain: undefined,
    }
  }
  const id = target.id === "default" ? input.defaultChainID : target.id
  const selected = id ? input.chains.find((chain) => chain.id === id) : undefined
  if (!selected) return
  return safetyReviewChainSnapshot(input.current, selected.steps, id)
}
