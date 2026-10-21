import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import { createStore } from "solid-js/store"
import { directoryKey } from "@/context/global-sync/utils"

type Activity = {
  status?: SessionStatus
  activityID?: string
  closedActivityIDs?: readonly string[]
  lastClosedActivityID?: string
  dismissed?: boolean
  lifecycle: boolean
  generation: number
  evidence?: SessionActivityEvidence
}

export type SessionActivityEvidence = {
  timestamp: number
  eventID?: string
  sequence?: number
}

const [activity, setActivity] = createStore<Record<string, Activity | undefined>>({})
const directoryGeneration = new Map<string, number>()

const key = (directory: string, sessionID: string) => `${directoryKey(directory)}\n${sessionID}`
const bumpDirectoryGeneration = (directory: string) => {
  const id = directoryKey(directory)
  directoryGeneration.set(id, (directoryGeneration.get(id) ?? 0) + 1)
}

export function sessionActivity(directory: string, sessionID: string) {
  return activity[key(directory, sessionID)]?.status
}

// A terminal lifecycle event clears the activity status but keeps a generation
// record. Consumers that drain queued UI work can use that terminal marker to
// override a stale session_status snapshot without treating an untracked session
// as settled.
export function sessionActivityStartedAt(directory: string, sessionID: string) {
  const state = activity[key(directory, sessionID)]
  return state?.lifecycle && state.status?.type === "busy" ? state.evidence?.timestamp : undefined
}

export function sessionActivitySettled(directory: string, sessionID: string) {
  const state = activity[key(directory, sessionID)]
  return !!state && !state.lifecycle && state.status === undefined
}

export function sessionActivityDismissed(directory: string, sessionID: string) {
  return activity[key(directory, sessionID)]?.dismissed === true
}

export function sessionActivityID(directory: string, sessionID: string) {
  return activity[key(directory, sessionID)]?.activityID
}

export function activeSessionActivityIDs(directory: string) {
  const prefix = `${directoryKey(directory)}\n`
  return Object.entries(activity)
    .filter(([id, state]) => id.startsWith(prefix) && state?.status)
    .map(([id]) => id.slice(prefix.length))
}

export function sessionActivityGeneration(directory: string, sessionID: string) {
  return activity[key(directory, sessionID)]?.generation ?? 0
}

export function sessionActivityGenerationSnapshot(directory: string) {
  const prefix = `${directoryKey(directory)}\n`
  return new Map(
    Object.entries(activity).flatMap(([id, state]) => {
      if (!id.startsWith(prefix) || !state) return []
      return [[id.slice(prefix.length), state.generation] as const]
    }),
  )
}

export function sessionActivityDirectoryGeneration(directory: string) {
  return directoryGeneration.get(directoryKey(directory)) ?? 0
}

export function startSessionActivity(
  directory: string,
  sessionID: string,
  activityID?: string,
  evidence?: SessionActivityEvidence,
) {
  const id = key(directory, sessionID)
  if (evidence && activity[id]?.evidence && compareEvidence(evidence, activity[id].evidence) <= 0) return false
  if (activityID && activity[id]?.activityID === activityID && activity[id]?.lifecycle) return false
  if (activityID && activity[id]?.closedActivityIDs?.includes(activityID)) {
    // A tracked close is terminal. Dual-pipeline replays still deliver the original
    // start after interrupt/complete; restoring busy made Stop look like it worked
    // and then immediately continue.
    return false
  }
  setActivity(id, {
    status: { type: "busy" },
    activityID,
    closedActivityIDs: activity[id]?.closedActivityIDs,
    lastClosedActivityID: undefined,
    dismissed: false,
    lifecycle: true,
    generation: (activity[id]?.generation ?? 0) + 1,
    evidence: evidence ?? activity[id]?.evidence,
  })
  bumpDirectoryGeneration(directory)
  return true
}

export function finishSessionActivity(
  directory: string,
  sessionID: string,
  activityID?: string,
  evidence?: SessionActivityEvidence,
) {
  const id = key(directory, sessionID)
  const existing = activity[id]
  if (evidence && existing?.evidence && compareEvidence(evidence, existing.evidence) <= 0) return false
  if (activityID && existing?.activityID && existing.activityID !== activityID) return false
  setActivity(id, {
    status: undefined,
    activityID: activityID ?? existing?.activityID,
    closedActivityIDs:
      activityID
        ? [...(existing?.closedActivityIDs ?? []).filter((item) => item !== activityID), activityID].slice(-16)
        : existing?.closedActivityIDs,
    lastClosedActivityID: activityID ?? existing?.lastClosedActivityID,
    dismissed: false,
    lifecycle: false,
    generation: (existing?.generation ?? 0) + 1,
    evidence: evidence ?? existing?.evidence,
  })
  bumpDirectoryGeneration(directory)
  return true
}

export function dismissSessionActivity(directory: string, sessionID: string) {
  const id = key(directory, sessionID)
  const existing = activity[id]
  if (!existing?.lifecycle) return
  setActivity(id, { ...existing, dismissed: true })
}

export function updateSessionActivity(directory: string, sessionID: string, status: SessionStatus) {
  const id = key(directory, sessionID)
  if (status.type === "idle" && activity[id]?.lifecycle) return
  setActivity(id, {
    status: status.type === "idle" ? undefined : status,
    activityID: activity[id]?.activityID,
    closedActivityIDs: activity[id]?.closedActivityIDs,
    lastClosedActivityID: activity[id]?.lastClosedActivityID,
    dismissed: activity[id]?.dismissed,
    lifecycle: false,
    generation: (activity[id]?.generation ?? 0) + 1,
    evidence: activity[id]?.evidence,
  })
  bumpDirectoryGeneration(directory)
}

function compareEvidence(incoming: SessionActivityEvidence, current: SessionActivityEvidence) {
  if (incoming.timestamp !== current.timestamp) return incoming.timestamp - current.timestamp
  if (incoming.sequence !== undefined && current.sequence !== undefined && incoming.sequence !== current.sequence) {
    return incoming.sequence - current.sequence
  }
  if (incoming.eventID && current.eventID && incoming.eventID !== current.eventID) {
    return incoming.eventID > current.eventID ? 1 : -1
  }
  return 0
}
