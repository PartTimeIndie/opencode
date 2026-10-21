export type ModelSelection = {
  model?: { providerID: string; modelID: string }
  variant?: string | null
  chainID?: string
}

export type AgentSelection = {
  model?: {
    providerID: string
    modelID: string
    variant?: string
    chain?: { id: string } | null
  }
  variant?: string
}

export type RestoredModel = {
  providerID: string
  modelID: string
  variant?: string | null
  chain?: { id: string } | null
}

// A new tab starts from the default agent, then the global chain/model default.
// Never inherit a previous tab's visible picker state.
export function resolveNewTabSelection(input: {
  agent?: { name: string; model?: AgentSelection["model"]; variant?: string }
  defaultChainID?: string
  visible?: ModelSelection
  fallback?: ModelSelection
}): ModelSelection & { agent?: string } {
  const configured: AgentSelection | undefined = input.agent?.model
    ? { model: input.agent.model, variant: input.agent.variant }
    : undefined
  return {
    ...(input.agent ? { agent: input.agent.name } : {}),
    ...resolveSessionModelSelection({
      agent: configured,
      fresh: true,
      defaultChainID: input.defaultChainID,
      fallback: input.fallback,
    }),
  }
}

export function resolveRestoredSessionSelection(input: {
  previous?: ModelSelection
  model: RestoredModel
  force?: boolean
  hasChain: (id: string) => boolean
  isValidModel: (model: NonNullable<ModelSelection["model"]>) => boolean
}): { action: "skip" } | { action: "restore"; selection: ModelSelection } | undefined {
  if (!input.force && input.previous?.chainID && input.hasChain(input.previous.chainID)) return { action: "skip" }
  if (!input.force && input.previous?.model && input.isValidModel(input.previous.model)) return { action: "skip" }

  const chainID = input.model.chain?.id
  // Session metadata is canonical and can arrive before Settings chains finish
  // hydrating. Keep the ID so the selector resolves automatically once the
  // matching chain becomes available instead of collapsing it to one step.
  if (chainID) {
    return { action: "restore", selection: { chainID, variant: null } }
  }

  const model = { providerID: input.model.providerID, modelID: input.model.modelID }
  if (!input.isValidModel(model)) return
  return {
    action: "restore",
    selection: {
      model,
      variant: input.model.variant ?? null,
    },
  }
}

export function resolveSessionModelSelection(input: {
  agent?: AgentSelection
  defaultChainID?: string
  visible?: ModelSelection
  fallback?: ModelSelection
  fresh?: boolean
}): ModelSelection {
  const configured = input.agent?.model
  if (configured?.chain?.id) return { chainID: configured.chain.id, variant: null }
  if (configured) {
    return {
      model: { providerID: configured.providerID, modelID: configured.modelID },
      variant: input.agent?.variant ?? configured.variant ?? null,
    }
  }
  if (!input.fresh && input.visible) return clone(input.visible)
  if (input.defaultChainID) return { chainID: input.defaultChainID, variant: null }
  if (input.fallback) return clone(input.fallback)
  return {}
}

function clone(selection: ModelSelection | undefined): ModelSelection {
  if (!selection) return {}
  return {
    ...(selection.model ? { model: { ...selection.model } } : {}),
    ...(selection.variant === undefined ? {} : { variant: selection.variant }),
    ...(selection.chainID ? { chainID: selection.chainID } : {}),
  }
}

// The session's agent is authoritative server-side (session.agent); the
// persisted copy only remembers local model nuances. A handoff, another
// window, or a resume can change the server agent (plan -> build), so a
// restored selection must let the record win over the stale persisted agent.
export function reconcileRestoredSelection<T extends { agent?: string }>(input: {
  persisted: T | undefined
  sessionAgent: string | undefined
}): T | undefined {
  if (!input.persisted) return input.persisted
  if (!input.sessionAgent || input.sessionAgent === input.persisted.agent) return input.persisted
  return { ...input.persisted, agent: input.sessionAgent }
}
