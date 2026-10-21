import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"

export function configuredModelRef(current: ModelV2.Ref | undefined, configured: ModelV2.Ref | undefined, model: { id: string; provider: string }) {
  // A stored direct choice is authoritative even when it omits chain: null.
  // Agent defaults apply only to sessions that have not selected a model.
  return current ?? configured ?? ModelV2.Ref.make({
    id: ModelV2.ID.make(model.id),
    providerID: ProviderV2.ID.make(model.provider),
  })
}

export function nextModel(model: ModelV2.Ref): ModelV2.Ref | undefined {
  if (!model.chain) return
  const active = model.chain.active ?? 0
  const step = model.chain.steps[active + 1]
  if (!step) return
  return {
    ...step,
    chain: {
      ...model.chain,
      active: active + 1,
    },
  }
}

// The persisted record normalizes an absent variant to "default", so a
// selection sent without a variant is the same step.
const normalizeVariant = (variant: string | undefined) => variant ?? "default"

export function sameChainStep(a: ModelV2.ChainStep | undefined, b: ModelV2.ChainStep | undefined) {
  if (!a || !b) return a === b
  return a.providerID === b.providerID && a.id === b.id && normalizeVariant(a.variant) === normalizeVariant(b.variant)
}

export function sameChain(a: ModelV2.Chain | null | undefined, b: ModelV2.Chain | null | undefined) {
  if (!a || !b) return a === b
  if (a.id !== b.id) return false
  const activeA = a.active ?? 0
  const activeB = b.active ?? 0
  if (activeA !== activeB) return false
  if (a.steps.length !== b.steps.length) return false
  return a.steps.every((step, index) => sameChainStep(step, b.steps[index]))
}

// Same stored selection means the runner would continue identically: same
// model identity (provider+model+normalized variant) and same effective chain.
// A different chain id, step list, or active step changes how the session
// continues, so it must never be discarded as a no-op switch.
export function sameChainSelection(a: ModelV2.Ref | undefined, b: ModelV2.Ref | undefined) {
  if (!a || !b) return a === b
  if (a.providerID !== b.providerID) return false
  if (a.id !== b.id) return false
  if (normalizeVariant(a.variant) !== normalizeVariant(b.variant)) return false
  return sameChain(a.chain, b.chain)
}

export function overrideModel(current: ModelV2.Ref | undefined, model: ModelV2.Ref): ModelV2.Ref {
  const chain = model.chain === undefined ? current?.chain : model.chain
  if (chain === null) return { ...model, chain: null }
  if (!chain) return model
  const step = {
    id: model.id,
    providerID: model.providerID,
    ...(model.variant ? { variant: model.variant } : {}),
  }
  if (chain.steps.length === 0) return { ...model, chain: { ...chain, active: 0, steps: [step] } }
  const matching = chain.steps.findIndex((item) => item.id === model.id && item.providerID === model.providerID)
  const active = matching >= 0 ? matching : Math.min(Math.max(chain.active ?? 0, 0), chain.steps.length - 1)
  return {
    ...model,
    chain: {
      ...chain,
      active,
      steps: chain.steps.map((item, index) => (index === active ? step : item)),
    },
  }
}
