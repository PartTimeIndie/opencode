export * as ModelPolicy from "./model-policy"

import { ModelV2 } from "../model"
import { overrideModel } from "../session/runner/model-chain"

/**
 * Authoritative subagent model selection.
 *
 * Settings and agent configuration decide which models a child session may
 * run on: the selected agent's configured model, the parent session's current
 * model, every step of their configured model chains (Settings fallbacks), and
 * additional Settings-configured refs that trusted server code passes through
 * the tool context (multi-agent reviewers). Catalog models that were never
 * configured are neither offered nor executed; a model override that does not
 * resolve into that set fails closed with the allowed list.
 */

export type Selection =
  | { readonly ok: true; readonly model: ModelV2.Ref | undefined }
  | { readonly ok: false; readonly requested: string; readonly allowed: ReadonlyArray<ModelV2.Ref> }

export function allowedModels(input: {
  readonly agent?: ModelV2.Ref | undefined
  readonly parent?: ModelV2.Ref | undefined
  readonly extra?: ReadonlyArray<ModelV2.Ref> | undefined
}): ReadonlyArray<ModelV2.Ref> {
  const refs = [
    ...(input.agent ? [input.agent] : []),
    ...(input.agent?.chain?.steps ?? []),
    ...(input.parent ? [input.parent] : []),
    ...(input.parent?.chain?.steps ?? []),
    ...(input.extra ?? []),
  ]
  const seen = new Set<string>()
  return refs.filter((ref) => {
    const key = `${ref.providerID}\u0000${ref.id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function selectModel(input: {
  readonly model?: string | undefined
  readonly variant?: string | undefined
  readonly agent?: ModelV2.Ref | undefined
  readonly parent?: ModelV2.Ref | undefined
  /**
   * Model inherited when no override is requested. Defaults to the agent
   * model, then the parent model. spawn_agent passes the spawning session's
   * current model so an in-session model switch survives spawning, while the
   * agent model still extends the policy through `agent`.
   */
  readonly inherit?: ModelV2.Ref | undefined
  readonly extra?: ReadonlyArray<ModelV2.Ref> | undefined
}): Selection {
  const base = input.inherit ?? input.agent ?? input.parent
  if (input.model === undefined) {
    if (base === undefined) return { ok: true, model: undefined }
    // An inherited model without its own chain keeps the closest configured
    // Settings fallback chain (agent chain first, then the parent chain).
    const chainSource = input.parent?.chain === null ? undefined : input.agent?.chain ? input.agent : input.parent
    const inherited = base.chain || !chainSource?.chain ? base : overrideModel(chainSource, base)
    if (input.variant === undefined) return { ok: true, model: inherited }
    return { ok: true, model: { ...inherited, variant: ModelV2.VariantID.make(input.variant) } }
  }
  const allowed = allowedModels(input)
  const match = matchRef(input.model, allowed)
  if (!match) return { ok: false, requested: input.model, allowed }
  const variant = input.variant === undefined ? match.variant : ModelV2.VariantID.make(input.variant)
  const step = { id: match.id, providerID: match.providerID, ...(variant === undefined ? {} : { variant }) }
  const chainBase =
    input.parent?.chain === null
      ? input.parent
      : input.agent?.chain
        ? input.agent
        : input.parent?.chain
          ? input.parent
          : base
  return { ok: true, model: chainBase ? overrideModel(chainBase, step) : step }
}

/**
 * Resolve one configured model for a requested reference. `provider/model` is
 * matched exactly. Model IDs may themselves contain slashes (for example
 * `stealth/ox-alpha` on openrouter), so a reference whose provider segment is
 * not configured still resolves when the raw string unambiguously matches one
 * configured model ID. Ambiguous or unknown references fail closed.
 */
function matchRef(requested: string, allowed: ReadonlyArray<ModelV2.Ref>): ModelV2.Ref | undefined {
  const parsed = ModelV2.parse(requested)
  const exact = allowed.find((ref) => ref.providerID === parsed.providerID && ref.id === parsed.modelID)
  if (exact) return exact
  const byID = allowed.filter((ref) => ref.id === requested)
  return byID.length === 1 ? byID[0] : undefined
}

export function formatModel(ref: ModelV2.Ref) {
  return ref.variant ? `${ref.providerID}/${ref.id} (${ref.variant})` : `${ref.providerID}/${ref.id}`
}

/**
 * Convert persisted reviewer entries into model refs. Only entries that
 * trusted server code proved configured (Settings reviewer lists) may take
 * this path into the enforced policy; model-provided reviewer lists must
 * never be passed here.
 */
export function refs(
  reviewers: ReadonlyArray<{ readonly model: string; readonly variant?: string | undefined }>,
): ReadonlyArray<ModelV2.Ref> {
  return reviewers.flatMap((reviewer) => {
    const parsed = ModelV2.parse(reviewer.model)
    return [
      {
        id: parsed.modelID,
        providerID: parsed.providerID,
        ...(reviewer.variant === undefined ? {} : { variant: ModelV2.VariantID.make(reviewer.variant) }),
      },
    ]
  })
}

export function rejectionMessage(rejection: { readonly requested: string; readonly allowed: ReadonlyArray<ModelV2.Ref> }) {
  const allowed = rejection.allowed.map(formatModel)
  return [
    `Model ${rejection.requested} is not configured for this agent or session.`,
    allowed.length
      ? `Allowed models: ${allowed.join(", ")}.`
      : "No models are configured for this agent or session; omit the model override.",
    "Configure the model on the agent or add it to the Settings model chain to make it available.",
  ].join(" ")
}
