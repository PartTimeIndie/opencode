export type ModelTargetSelection =
  { kind: "none" } | { kind: "model"; providerID: string; modelID: string } | { kind: "chain"; id: string }

export const MODEL_TARGET_MODEL_PREFIX = "model:"
export const MODEL_TARGET_CHAIN_PREFIX = "chain:"

/**
 * Durable Settings reference for a model target. Every model target setting
 * stores exactly one of:
 * - `model:<providerID>/<modelID>` for a direct model selection
 * - `chain:<chainID>` for a configured model chain (`default` allowed where the
 *   consumer supports it)
 *
 * Legacy persisted values stay readable so no user selection is lost:
 * - bare `provider/model` (contains `/`) is a direct model selection
 * - any other bare token, including the literal `default`, is a chain id
 */
export function parseModelTarget(value: unknown, chainIDs?: readonly string[]): ModelTargetSelection {
  if (typeof value !== "string") return { kind: "none" }
  const reference = value.trim()
  if (!reference) return { kind: "none" }
  if (reference.startsWith(MODEL_TARGET_MODEL_PREFIX)) {
    const model = parseModelKey(reference.slice(MODEL_TARGET_MODEL_PREFIX.length))
    return model ? { kind: "model", ...model } : { kind: "none" }
  }
  if (reference.startsWith(MODEL_TARGET_CHAIN_PREFIX)) {
    const id = reference.slice(MODEL_TARGET_CHAIN_PREFIX.length).trim()
    return id ? { kind: "chain", id } : { kind: "none" }
  }
  if (reference === "default") return { kind: "chain", id: "default" }
  if (chainIDs?.includes(reference)) return { kind: "chain", id: reference }
  const legacyModel = parseModelKey(reference)
  // Unknown bare tokens without `/` are preserved as chain ids so a retired
  // chain fails closed at resolution time instead of being silently dropped.
  return legacyModel ? { kind: "model", ...legacyModel } : { kind: "chain", id: reference }
}

export function modelTargetReference(target: ModelTargetSelection): string {
  if (target.kind === "model") return `${MODEL_TARGET_MODEL_PREFIX}${target.providerID}/${target.modelID}`
  if (target.kind === "chain") return `${MODEL_TARGET_CHAIN_PREFIX}${target.id}`
  return ""
}

/** Rewrites a possibly legacy persisted value into the durable format. */
export function normalizeModelTargetReference(value: unknown, chainIDs?: readonly string[]): string {
  return modelTargetReference(parseModelTarget(value, chainIDs))
}

/** Host calls send `model` for a direct selection and `chain` for a chain. */
export function modelTargetRequestPayload(value: unknown, chainIDs?: readonly string[]) {
  const target = parseModelTarget(value, chainIDs)
  if (target.kind === "model") return { model: `${target.providerID}/${target.modelID}` } as const
  if (target.kind === "chain") return { chain: target.id } as const
  return undefined
}

/**
 * Tolerant reader for host `model` fields: plugins resolve their Settings
 * reference themselves, but a durable `model:` reference must never break a
 * caller that forwarded the raw persisted value.
 */
export function stripModelTargetModelPrefix(value: string | undefined): string {
  const reference = typeof value === "string" ? value.trim() : ""
  return reference.startsWith(MODEL_TARGET_MODEL_PREFIX) ? reference.slice(MODEL_TARGET_MODEL_PREFIX.length) : reference
}

function parseModelKey(value: string): { providerID: string; modelID: string } | undefined {
  const separator = value.indexOf("/")
  if (separator <= 0 || separator === value.length - 1) return
  return { providerID: value.slice(0, separator), modelID: value.slice(separator + 1) }
}
