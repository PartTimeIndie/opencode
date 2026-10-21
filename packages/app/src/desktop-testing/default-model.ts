import type { ModelChain } from "@/context/model-chain"
import type { ModelKey } from "@/context/models"

export function desktopTestingDefaultModel(
  chain: ModelChain | undefined,
  selected?: ModelKey,
  variant?: string | null,
) {
  const primary = chain?.steps[0]
  if (!chain || !primary) {
    if (!selected) return
    return {
      providerID: selected.providerID,
      id: selected.modelID,
      ...(variant ? { variant } : {}),
    }
  }
  return {
    providerID: primary.providerID,
    id: primary.modelID,
    ...(primary.variant ? { variant: primary.variant } : {}),
    chain: {
      id: chain.id,
      name: chain.name,
      active: 0,
      steps: chain.steps.map((step) => ({
        providerID: step.providerID,
        id: step.modelID,
        ...(step.variant ? { variant: step.variant } : {}),
      })),
    },
  }
}

/**
 * Resolves the model a desktop-testing `session.prompt` should send.
 *
 * Forcing every automation to name a concrete provider model is what let a
 * testing prompt run a session on GPT-5.6 while the configured Standard Coder
 * Chain was the reported default. An explicit model is forwarded untouched. An
 * omitted model must not guess: an existing session keeps its stored model
 * (`undefined` makes the server stay sticky), and a session that never chose
 * one follows the same Settings default chain that `app.status` reports.
 */
export function desktopTestingPromptModel(input: {
  requested?: { providerID: string; modelID: string }
  variant?: string
  sessionModel?: { providerID: string; id: string } | null
  chain?: ModelChain
  selected?: ModelKey
  selectedVariant?: string | null
}) {
  if (input.requested)
    return {
      providerID: input.requested.providerID,
      id: input.requested.modelID,
      ...(input.variant ? { variant: input.variant } : {}),
    }
  if (input.sessionModel) return undefined
  const fallback = desktopTestingDefaultModel(input.chain, input.selected, input.selectedVariant)
  if (!fallback) return undefined
  const chain = "chain" in fallback ? fallback.chain : undefined
  return {
    providerID: fallback.providerID,
    id: fallback.id,
    ...(input.variant ? { variant: input.variant } : fallback.variant ? { variant: fallback.variant } : {}),
    ...(chain ? { chain } : {}),
  }
}
