export type SelectionModelSnapshot = {
  providerID?: string
  modelID?: string
  variant?: string | null
  chainID?: string
}

export type AgentSelectionReadback = {
  agent: string
  updatedAt?: number
  model?: SelectionModelSnapshot
}

export type AgentSelectionReadbackOutcome = "stale" | "intermediate" | "confirmed" | "external"

export function classifyAgentSelectionReadback(input: {
  expected: { agent: string; model?: SelectionModelSnapshot }
  previousModel?: SelectionModelSnapshot
  pendingSelections?: readonly { agent: string; model?: SelectionModelSnapshot }[]
  baselineUpdatedAt: number
  readback: AgentSelectionReadback
}): AgentSelectionReadbackOutcome {
  const updatedAt = input.readback.updatedAt
  if (updatedAt === undefined || !Number.isFinite(updatedAt) || updatedAt <= input.baselineUpdatedAt) return "stale"
  if (input.readback.agent === input.expected.agent && sameModel(input.readback.model, input.expected.model))
    return "confirmed"
  // Earlier serialized picker writes can publish after a newer local choice.
  // They are our own intermediate states, not a change from another window.
  if (
    input.pendingSelections?.some(
      (selection) => selection.agent === input.readback.agent && sameModel(input.readback.model, selection.model),
    )
  )
    return "intermediate"
  if (input.readback.agent !== input.expected.agent) return "external"
  if (input.previousModel && sameModel(input.readback.model, input.previousModel)) return "intermediate"
  return "external"
}

function sameModel(readback: SelectionModelSnapshot | undefined, expected: SelectionModelSnapshot | undefined) {
  if (!expected) return true
  if (!readback) return false
  if (expected.chainID) return readback.chainID === expected.chainID
  return (
    readback.providerID === expected.providerID &&
    readback.modelID === expected.modelID &&
    (readback.variant ?? null) === (expected.variant ?? null)
  )
}
