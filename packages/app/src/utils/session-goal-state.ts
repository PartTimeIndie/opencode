export const sessionGoalMetadataKey = "opencode.session.goal"

export type GoalMetadataState = { present: boolean; value: string }

export type GoalOverride = {
  value: string
  before: GoalMetadataState
  localBefore?: string
  confirmed: boolean
}

export function readGoalMetadata(metadata: Record<string, unknown> | undefined): GoalMetadataState {
  if (!metadata || !Object.prototype.hasOwnProperty.call(metadata, sessionGoalMetadataKey)) {
    return { present: false, value: "" }
  }
  return {
    present: true,
    value: typeof metadata[sessionGoalMetadataKey] === "string" ? metadata[sessionGoalMetadataKey].trim() : "",
  }
}

export function sameGoalMetadata(left: GoalMetadataState, right: GoalMetadataState) {
  return left.present === right.present && left.value === right.value
}

export function prepareGoalMetadataUpdate(goalInput: string, metadata: Record<string, unknown> | undefined) {
  const goal = goalInput.trim()
  const before = readGoalMetadata(metadata)
  const expected = goal ? { present: true, value: goal } : { present: false, value: "" }

  return { goal, before, expected, isIdempotent: sameGoalMetadata(before, expected) }
}

export function confirmGoalOverride(override: GoalOverride | undefined, isCurrentRevision: boolean) {
  if (!isCurrentRevision || !override) return
  return { ...override, confirmed: true }
}

// Idempotency compares against the last OBSERVED metadata. While another goal
// write is still in flight that observation is stale, so an explicit set with
// identical text must still issue a fresh patch (fresh run ID) or an in-flight
// clear could erase the new set.
export function shouldWriteGoalPatch(isIdempotent: boolean, hasPendingOverride: boolean) {
  return !isIdempotent || hasPendingOverride
}

export const sessionGoalStatusMetadataKey = "opencode.session.goal_status"
export const sessionGoalRunMetadataKey = "opencode.session.goal_run"

// A goal change and its old display-only status must be cleared in one host
// metadata update. A later plugin projection may set a fresh status.
export function goalMetadataPatch(goal: string, runID: string = crypto.randomUUID()) {
  return {
    ...(goal ? { set: { [sessionGoalMetadataKey]: goal, [sessionGoalRunMetadataKey]: runID } } : {}),
    unset: goal ? [sessionGoalStatusMetadataKey] : [sessionGoalMetadataKey, sessionGoalRunMetadataKey, sessionGoalStatusMetadataKey],
  }
}

export type GoalStatus = {
  phase: "working" | "verification-pending" | "verifying" | "paused" | "achieved"
  stopped: boolean
  stopReason: string
  /**
   * Monotonic order of lifecycle/control transitions within one goal run,
   * projected by the goal plugin. Absent in older projections; used only to
   * reject out-of-order control responses, never as authority.
   */
  controlRevision?: number
}

/**
 * Display-only projection the goal plugin writes as session metadata. Absent,
 * malformed or unknown payloads return undefined so the dock keeps the previous
 * plain rendering; this value is never authorization.
 */
export function readGoalStatusMetadata(metadata: Record<string, unknown> | undefined, goal: string): GoalStatus | undefined {
  const raw = metadata?.[sessionGoalStatusMetadataKey]
  if (typeof raw !== "string" || !raw) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  const value = parsed as Record<string, unknown>
  const runID = metadata?.[sessionGoalRunMetadataKey]
  if (typeof runID !== "string" || !runID || value.runID !== runID) return undefined
  if (value.condition !== goal.trim() || typeof value.stopped !== "boolean" || typeof value.stopReason !== "string") return undefined
  const phases: GoalStatus["phase"][] = ["working", "verification-pending", "verifying", "paused", "achieved"]
  const phase = phases.find((candidate) => candidate === value.phase)
  if (!phase || (phase === "paused" && value.stopped !== true)) return undefined
  const controlRevision = value.controlRevision
  if (
    controlRevision !== undefined &&
    controlRevision !== null &&
    (typeof controlRevision !== "number" || !Number.isSafeInteger(controlRevision) || controlRevision < 0)
  )
    return undefined
  return {
    phase,
    stopped: value.stopped === true,
    stopReason: typeof value.stopReason === "string" ? value.stopReason : "",
    ...(typeof controlRevision === "number" ? { controlRevision } : {}),
  }
}

export function goalStatusLabel(status: GoalStatus): string {
  if (status.stopped) return status.stopReason ? `Paused: ${status.stopReason}` : "Paused"
  if (status.phase === "verification-pending" || status.phase === "verifying") return "Completion check"
  if (status.phase === "achieved") return "Achieved"
  return "Working"
}

export type GoalControlDecision =
  | { kind: "available"; action: "pause" | "resume"; label: "Pause" | "Continue" }
  | { kind: "unavailable"; label: "Continue"; reason: string }

/**
 * What the goal dock's single Pause/Continue control should offer for the
 * current validated status. A terminal goal must never offer a resumable
 * Continue; every other stopped state stays explicitly resumable.
 */
export function goalControlAction(status: GoalStatus | undefined): GoalControlDecision {
  if (!status?.stopped) return { kind: "available", action: "pause", label: "Pause" }
  if (status.phase === "achieved") return { kind: "unavailable", label: "Continue", reason: "Goal completed" }
  return { kind: "available", action: "resume", label: "Continue" }
}
