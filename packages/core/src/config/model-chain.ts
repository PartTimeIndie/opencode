export * as ConfigModelChain from "./model-chain"

import { Schema } from "effect"
import { ModelV2 } from "../model"
import { ProviderV2 } from "../provider"

export const Step = Schema.Struct({
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
  variant: ModelV2.VariantID.pipe(Schema.optional),
})

export const Chain = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  steps: Schema.NonEmptyArray(Step),
})

export const Info = Schema.Array(Chain)

/** Resolve an agent's explicit target without degrading a missing chain to its first model. */
export function agentTarget(target: string, chains: typeof Info.Type | undefined): ModelV2.Ref {
  if (target.startsWith("chain:")) {
    const id = target.slice("chain:".length)
    if (!id) throw new Error("Invalid agent model chain")
    const chain = chains?.find((item) => item.id === id)
    if (!chain) throw new Error(`Unknown agent model chain: ${id}`)
    const steps = chain.steps.map((step) => ({
      id: step.modelID,
      providerID: step.providerID,
      ...(step.variant ? { variant: step.variant } : {}),
    }))
    return {
      ...steps[0],
      chain: { id: chain.id, name: chain.name, active: 0, steps },
    }
  }
  const value = target.startsWith("model:") ? target.slice("model:".length) : target
  const model = ModelV2.parse(value)
  if (!model.providerID || !model.modelID) throw new Error(`Invalid agent model target: ${target}`)
  return { id: model.modelID, providerID: model.providerID }
}

export function selectedSteps(input: {
  chains: typeof Info.Type | undefined
  chainID: string | undefined
}) {
  const chain = input.chains?.find((item) => item.id === input.chainID)
  if (!chain) return
  return chain.steps.map((step) => ({ ...step }))
}

export function resolve(input: {
  chains: typeof Info.Type | undefined
  chainID: string | undefined
  model: ModelV2.Ref | undefined
  single: boolean
}): ModelV2.Ref | undefined {
  if (input.single) return input.model ? withoutChain(input.model) : undefined
  const chain = input.chains?.find((item) => item.id === input.chainID)
  if (!chain) return input.model
  const steps = chain.steps.map((step) => ({
    id: step.modelID,
    providerID: step.providerID,
    ...(step.variant ? { variant: step.variant } : {}),
  }))
  const active = input.model
    ? steps.findIndex(
        (step) =>
          step.id === input.model?.id &&
          step.providerID === input.model.providerID &&
          (input.model.variant === undefined || step.variant === input.model.variant),
      )
    : 0
  if (input.model && active < 0) return withoutChain(input.model)
  const selected = steps[active]
  return {
    ...(input.model ?? selected),
    ...(selected.variant && input.model?.variant === undefined ? { variant: selected.variant } : {}),
    chain: { id: chain.id, name: chain.name, active, steps },
  }
}

function withoutChain(model: ModelV2.Ref) {
  const { chain: _, ...single } = model
  return single
}