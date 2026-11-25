// Smallest common session-status resolver shared by the session tab avatars,
// the sidebar session rows, and the Session Navigator dock plugin.
//
// It consumes only the existing completion contracts:
//   - session_working: derived from session_status (busy/retry/...). The running signal.
//   - question: an open native question awaiting the user.
//   - turnCompletion: the "session.turn.completed" post-hook result.
//
// Priority is fixed so no marker can stay stale:
//   question/permission > running > terminal (red/green).
// Error and success are only returned when the session is neither running nor asking.
// A pending permission is treated exactly like an open question: the session
// waits on a user decision, so a tool part blocked on permission must never
// look like a hung running shell.

export type TurnCompletionStatus = "done" | "incomplete" | "unknown"

// The visual indicator emitted by resolveSessionStatus. "attention" is reserved for
// an open native question awaiting the user. An unknown completion verdict is
// intentionally not visualized: it is terminal, non-actionable, and must not
// resemble the blue running indicator after the turn has already ended.
export type SessionVisualStatus = "running" | "attention" | "done" | "incomplete" | "unknown"

type SessionToolActivityMessage = {
  id: string
  role?: string
  finish?: string
  time?: { created?: number; completed?: number }
}

type SessionToolActivityStore = {
  message: Record<string, readonly SessionToolActivityMessage[] | undefined>
  part: Record<string, readonly { type: string; state?: { status: string } }[] | undefined>
}

function latestAssistantMessage(store: SessionToolActivityStore, sessionID: string) {
  const messages = store.message[sessionID] ?? []
  return messages.findLast((message) => message.role === "assistant") ?? messages.at(-1)
}

export function latestAssistantCompletedBefore(store: SessionToolActivityStore, sessionID: string, started?: number) {
  const completed = latestAssistantMessage(store, sessionID)?.time?.completed
  return typeof started === "number" && started > 0 && typeof completed === "number" && completed < started
}

function hasRunningOrPendingTool(store: SessionToolActivityStore, messageID: string) {
  return (
    store.part[messageID]?.some(
      (part) => part.type === "tool" && (part.state?.status === "pending" || part.state?.status === "running"),
    ) ?? false
  )
}

export function latestAssistantSettled(store: SessionToolActivityStore, sessionID: string) {
  const latest = latestAssistantMessage(store, sessionID)
  if (!latest) return false
  // A provider step that ended only to run tools is not a finished turn.
  if (latest.finish === "tool-calls") return false
  if (typeof latest.finish === "string") return true
  // time.completed alone marks a step boundary; leftover running tools mean work continues.
  if (typeof latest.time?.completed === "number") return !hasRunningOrPendingTool(store, latest.id)
  return false
}

// Keep the idle fallback for a missed terminal when a run ends without a new
// assistant message. This grace period is a heuristic, not proof of lease expiry.
export const MISSED_TERMINAL_GRACE_MS = 45_000

export function idleSignalSettlesActivity(
  store: SessionToolActivityStore,
  sessionID: string,
  startedAt?: number,
  now = Date.now(),
): boolean {
  if (!latestAssistantSettled(store, sessionID)) return false
  if (startedAt === undefined || !latestAssistantCompletedBefore(store, sessionID, startedAt)) return true
  // Right after activity.started, the latest assistant is still from the previous turn.
  // An idle signal alone must not settle the fresh activity.
  return now - startedAt >= MISSED_TERMINAL_GRACE_MS
}

export function resolveLifecycleStatus(input: {
  activity?: string
  activityTracked?: boolean
  activitySettled?: boolean
  store?: string
  latestAssistantSettled: boolean
}) {
  // A terminal V2 lifecycle event is authoritative. The store may still carry
  // the busy snapshot that caused the refresh, but a closed activity must not
  // resurrect that stale running state in another consumer.
  if (input.activitySettled) return "idle"
  // A durable blocking question is an explicit user wait. It takes precedence
  // over a stale client activity marker so stopped or expired runners do not
  // keep rendering as busy while the question remains answerable.
  if (input.store === "waiting_for_user") return "waiting_for_user"
  // An idle snapshot and a finished assistant may belong to the previous turn.
  // Only suppress a busy marker when the assistant did not finish before this activity began.
  if (input.activity === "busy" && input.store === "idle" && input.latestAssistantSettled && !input.activityTracked) {
    return "idle"
  }
  return input.activity ?? input.store
}

export function hasActiveSessionTool(store: SessionToolActivityStore, sessionID: string) {
  const latest = latestAssistantMessage(store, sessionID)
  if (!latest || latestAssistantSettled(store, sessionID)) return false
  return hasRunningOrPendingTool(store, latest.id)
}

export function sessionIsWorking(
  store: SessionToolActivityStore,
  sessionID: string,
  status?: string,
  activitySettled = false,
) {
  if (activitySettled) return false
  if (status === "waiting_for_user") return false
  if (status !== undefined && status !== "idle") return true
  return hasActiveSessionTool(store, sessionID)
}

export function resolveSessionStatus(input: {
  working: boolean
  question: boolean
  permission?: boolean
  status?: string
  turnCompletion?: TurnCompletionStatus
}): SessionVisualStatus | undefined {
  if (input.question || input.permission || input.status === "waiting_for_user") return "attention"
  // A terminal lifecycle snapshot is authoritative even if an inactive tab still
  // holds a stale running tool part. A missing lifecycle snapshot is not enough:
  // during hydration the active tool remains the better running signal.
  if (input.status === "idle" && input.turnCompletion === "incomplete") return "incomplete"
  if (input.status === "idle" && input.turnCompletion === "done") return "done"
  if (input.working) return "running"
  if (input.turnCompletion === "incomplete") return "incomplete"
  if (input.turnCompletion === "done") return "done"
  return undefined
}
