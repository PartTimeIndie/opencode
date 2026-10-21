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
