import type { GoalStatus } from "./session-goal-state"

export type SessionGoalControlAction = "pause" | "resume"

export type GoalControlRequest = {
  sessionID: string
  action: SessionGoalControlAction
  operationID: string
  runID?: string
  expectedRevision?: number
}

export type GoalControlResponse = {
  ok?: boolean
  error?: string
  runID?: string
  controlRevision?: number
  repeated?: boolean
}

/**
 * Bind a control click to the exact session, goal run and revision the UI saw.
 * The request is idempotent on the plugin side; the optimistic guards only
 * prevent a stale window from mutating a newer state twice.
 */
export function buildGoalControlRequest(input: {
  sessionID: string
  action: SessionGoalControlAction
  goalRunMetadata?: unknown
  status?: GoalStatus
}): GoalControlRequest {
  const runID = typeof input.goalRunMetadata === "string" && input.goalRunMetadata ? input.goalRunMetadata : undefined
  const expectedRevision =
    input.status && typeof input.status.controlRevision === "number" ? input.status.controlRevision : undefined
  return {
    sessionID: input.sessionID,
    action: input.action,
    operationID: crypto.randomUUID(),
    ...(runID ? { runID } : {}),
    ...(expectedRevision !== undefined ? { expectedRevision } : {}),
  }
}

/**
 * Whether a delayed control response is older than the goal state the UI now
 * shows. Mutations ack only; the canonical status always comes from session
 * metadata, so a stale response must never overwrite a newer revision.
 */
export function goalControlResponseStale(request: GoalControlRequest, response: GoalControlResponse): boolean {
  if (request.runID && typeof response.runID === "string" && response.runID && response.runID !== request.runID)
    return true
  if (
    typeof request.expectedRevision === "number" &&
    typeof response.controlRevision === "number" &&
    response.controlRevision < request.expectedRevision
  )
    return true
  return false
}

/**
 * The endpoint answers `{ ok: true, data: <plugin outcome> }`; the plugin
 * outcome itself carries `ok: false` for semantic rejections (stale run,
 * revision mismatch, no goal). Unwrap that envelope exactly once.
 */
export function parseGoalControlResponse(body: { ok?: boolean; data?: unknown } | undefined): GoalControlResponse | undefined {
  const outcome = body?.data
  if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) return undefined
  return outcome as GoalControlResponse
}

/** Human-readable text for the plugin's terse semantic rejection codes. */
export function goalControlErrorText(error: string | undefined): string {
  switch (error) {
    case "no-goal":
      return "The goal is no longer active."
    case "stale-run":
      return "This control belongs to an earlier version of the goal."
    case "revision":
      return "The goal changed since this control was pressed."
    case "session-mismatch":
      return "This control does not belong to this session."
    case "persist":
      return "The goal state could not be saved."
    case "projection":
      return "The goal status could not be updated."
    case "invalid-action":
      return "Unknown goal control action."
    default:
      return "The session goal control failed."
  }
}
