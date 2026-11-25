export * as ReviewerLoopPolicy from "./reviewer-loop-policy"

/**
 * Qualitative loop evidence for reviewer children. Long runtime, repeated tool
 * names, or missing telemetry are never evidence: identical successful actions
 * count only with identical FULL output, a matching observed source stamp, and
 * a child correction hint that was actually delivered. Anything less is at most
 * a warning; stopping stays bound to one child.
 */
export type Observation = {
  readonly signature: string
  readonly fullOutputHash?: string
  readonly outputComplete: boolean
  readonly sourceStamp?: string
}

export type Evidence = {
  readonly repeats: number
  readonly fullOutputEqual: boolean
  readonly sourceStampEqual: boolean
  readonly correctionHintDelivered: boolean
}

export type Decision = { readonly action: "none" } | { readonly action: "warn"; readonly reason: string } | { readonly action: "abort-child"; readonly reason: string }

export type AbortMode = "suspicion" | "verified-loop"

// Host-attested per-run overrides. The only legitimate writer is a proven
// human host handoff bound to session, call and run; prompt text, quoted
// sentences, tool output and client flags never populate this store. With no
// attested entry the exception stays locked and the fail-safe default applies.
const overrides = new Map<string, AbortMode>()

export const grantOverride = (input: {
  readonly sessionID: string
  readonly callID: string
  readonly runID: string
  readonly attested: true
  readonly mode: AbortMode
}) => {
  if (!input.attested) return false
  overrides.set(`${input.sessionID}\u0000${input.callID}\u0000${input.runID}`, input.mode)
  return true
}

export const clearOverride = (input: { sessionID: string; callID: string; runID: string }) =>
  overrides.delete(`${input.sessionID}\u0000${input.callID}\u0000${input.runID}`)

export const overrideFor = (input: { sessionID: string; callID: string; runID: string }): AbortMode | undefined =>
  overrides.get(`${input.sessionID}\u0000${input.callID}\u0000${input.runID}`)

export const decide = (mode: AbortMode, evidence: Evidence): Decision => {
  if (evidence.repeats < 2) return { action: "none" }
  if (
    evidence.repeats >= 4 &&
    evidence.fullOutputEqual &&
    evidence.sourceStampEqual &&
    evidence.correctionHintDelivered
  )
    return { action: "abort-child", reason: `verified identical-action loop (${evidence.repeats} repeats with full evidence)` }
  if (mode === "suspicion")
    return { action: "abort-child", reason: `suspicious identical-action repeat (${evidence.repeats} repeats; host-granted suspicion stop)` }
  return { action: "warn", reason: `repeated identical actions (${evidence.repeats} repeats); evidence incomplete for a verified loop` }
}

// Suspicion mode must be at least as conservative as the verified default
// until a real host attestation exists; the map above stays empty without one.
export const mode = (input: { sessionID: string; callID: string; runID: string }): AbortMode =>
  overrideFor(input) ?? "verified-loop"
