import { ConfigModelChain } from "@opencode-ai/core/config/model-chain"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"

type Model = { providerID: string; id: string; variant?: string }
type Chain = {
  id: string
  name: string
  steps: readonly { providerID: string; modelID: string; variant?: string }[]
}
type Provider = {
  id: string
  models: Record<string, { variants?: Record<string, unknown> }>
}

export function resolveRunModel(input: {
  explicit: Model | undefined
  agent: Model | undefined
  chains: readonly Chain[] | undefined
  defaultChainID: string | undefined
  variant?: string
  providers?: readonly Provider[]
}) {
  const selected = input.explicit ?? input.agent
  const model = selected ? { ...selected, variant: input.variant ?? selected.variant } : undefined
  const modelRef = model
    ? ModelV2.Ref.make({
        providerID: ProviderV2.ID.make(model.providerID),
        id: ModelV2.ID.make(model.id),
        ...(model.variant ? { variant: ModelV2.VariantID.make(model.variant) } : {}),
      })
    : undefined
  if (input.explicit !== undefined) return modelRef
  const chains = input.chains?.map((chain) => ({
    ...chain,
    steps: chain.steps.map((step) => ({
      providerID: ProviderV2.ID.make(step.providerID),
      modelID: ModelV2.ID.make(step.modelID),
      ...(step.variant ? { variant: ModelV2.VariantID.make(step.variant) } : {}),
    })),
  })) as typeof ConfigModelChain.Info.Type | undefined
  const resolved = ConfigModelChain.resolve({
    chains,
    chainID: input.defaultChainID,
    model: modelRef,
    single: false,
  })
  const fallback = ConfigModelChain.resolve({ chains, chainID: input.defaultChainID, model: undefined, single: false })
  const chain = resolved?.chain ?? fallback?.chain
  if (
    input.agent &&
    model?.variant !== undefined &&
    !chain?.steps.some(
      (step) =>
        step.providerID === model.providerID && step.id === model.id && step.variant === model.variant,
    )
  ) {
    return modelRef
  }
  const chained =
    resolved?.chain || !selected
      ? resolved
      : fallback ?? modelRef
  const variant =
    !chained || selected || !input.variant
      ? chained
      : ConfigModelChain.resolve({
          chains,
          chainID: input.defaultChainID,
          model: ModelV2.Ref.make({ ...chained, variant: ModelV2.VariantID.make(input.variant) }),
          single: false,
        })
  if (!variant?.chain || !input.providers) return variant

  const available = (step: (typeof variant.chain.steps)[number]) => {
    const candidate = input.providers?.find((provider) => provider.id === step.providerID)?.models[step.id]
    if (!candidate) return false
    if (!step.variant) return true
    return step.variant in (candidate.variants ?? {})
  }
  const preferred = model
    ? variant.chain.steps.findIndex(
        (step) =>
          step.providerID === model.providerID &&
          step.id === model.id &&
          step.variant === model.variant &&
          available(step),
      )
    : -1
  const active = preferred >= 0 ? preferred : variant.chain.steps.findIndex(available)
  if (active < 0) throw new Error(`chain-unavailable: no available steps in model chain "${variant.chain.name}"`)
  const step = variant.chain.steps[active]
  return {
    providerID: step.providerID,
    id: step.id,
    ...(step.variant ? { variant: step.variant } : {}),
    chain: { ...variant.chain, active },
  }
}
