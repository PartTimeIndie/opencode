export type LocalModelKey = {
  providerID: string
  modelID: string
  variant?: string
}

export type LocalModelSelection = {
  model?: LocalModelKey
  variant?: string | null
  chainID?: string
}

export type LocalModelChain = {
  id: string
  name: string
  steps: LocalModelKey[]
}

export function migrateLocalSelectionStore<State>(value: unknown): {
  session: Record<string, State | undefined>
} {
  if (!value || typeof value !== "object") return { session: {} }

  const item = value as {
    session?: Record<string, State | undefined>
    pick?: Record<string, State | undefined>
  }
  if (item.session && typeof item.session === "object") return { session: item.session }
  if (!item.pick || typeof item.pick !== "object") return { session: {} }
  return { session: Object.fromEntries(Object.entries(item.pick).filter(([key]) => key !== "__workspace__")) }
}

export function resolveLocalModel(input: {
  explicit?: LocalModelKey
  agent?: LocalModelKey
  fallback?: LocalModelKey
  isValid: (model: LocalModelKey) => boolean
}) {
  if (input.explicit) return input.isValid(input.explicit) ? input.explicit : undefined
  if (input.agent) return input.isValid(input.agent) ? input.agent : undefined
  if (input.fallback && input.isValid(input.fallback)) return input.fallback
}

export function isExplicitVariantSelection(options?: { remember?: boolean }) {
  return options?.remember !== false
}

export function toSessionModelRef(selection: LocalModelSelection, chains: LocalModelChain[]) {
  const chain = chains.find((item) => item.id === selection.chainID)
  const first = chain?.steps[0]
  if (chain && first) {
    return {
      id: first.modelID,
      providerID: first.providerID,
      ...(first.variant ? { variant: first.variant } : {}),
      chain: {
        id: chain.id,
        name: chain.name,
        active: 0,
        steps: chain.steps.map((step) => ({
          id: step.modelID,
          providerID: step.providerID,
          ...(step.variant ? { variant: step.variant } : {}),
        })),
      },
    }
  }

  if (!selection.model) return
  const variant = selection.variant ?? selection.model.variant
  // A picked model is a deliberate direct selection. Without the explicit null the
  // server keeps the session's chain and only moves its active step, so the chain
  // would still advance to later models after the user chose a single model.
  return {
    id: selection.model.modelID,
    providerID: selection.model.providerID,
    ...(variant ? { variant } : {}),
    chain: null,
  }
}
