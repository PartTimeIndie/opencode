import { selectQueuedFollowup, type FollowupItem } from "./followup-queue"
import type { FollowupState } from "./followup-store"

export type DrainableFollowupStore = {
  directory: string
  followup: FollowupState
}

// Pick the one queued followup the global drain should release next. Every
// cached store of the server scope competes — not just the rendered session
// tab's store — so a parked followup releases as soon as its session settles,
// even while another directory owns the active tab.
//
// Drafts send with the agent recorded at queue time, so a session-side agent
// change never vetoes a release; only an explicit user pause does.
//
// isReady gates whole stores whose sync data has not finished loading:
// releasing into an unknown session list or empty permission/question
// snapshots could bypass child-session or blocking-request guards. isClaimed
// skips items that already have a send in flight.
export function selectNextDrainableFollowup(input: {
  stores: DrainableFollowupStore[]
  activeSessionID?: string
  activeDirectory?: string
  isBusy: (sessionID: string, directory: string) => boolean
  isActivitySettled?: (sessionID: string, directory: string) => boolean
  isChild: (sessionID: string, directory: string) => boolean
  isBlocked: (sessionID: string, directory: string) => boolean
  isReady?: (directory: string) => boolean
  isClaimed?: (item: FollowupItem) => boolean
}) {
  const ordered = input.activeDirectory
    ? [
        ...input.stores.filter((store) => store.directory === input.activeDirectory),
        ...input.stores.filter((store) => store.directory !== input.activeDirectory),
      ]
    : input.stores

  for (const store of ordered) {
    const items: Record<string, FollowupItem[] | undefined> = {}
    for (const [sessionID, list] of Object.entries(store.followup.items ?? {})) {
      const rest = (list ?? []).filter((item) => !input.isClaimed?.(item))
      if (rest.length > 0) items[sessionID] = rest
    }
    // No remaining candidates: skip before readiness. The runner resolves
    // readiness through serverSync.child(directory), whose default bootstrap
    // would start a full background-project bootstrap per empty restored tab.
    if (Object.keys(items).length === 0) continue
    if (input.isReady && !input.isReady(store.directory)) continue
    const next = selectQueuedFollowup({
      activeSessionID: input.activeSessionID,
      items,
      failed: store.followup.failed,
      paused: store.followup.paused,
      isBusy: input.isBusy,
      isActivitySettled: input.isActivitySettled,
      isChild: input.isChild,
      isBlocked: input.isBlocked,
    })
    if (!next) continue
    return { directory: store.directory, sessionID: next.sessionID, item: next.item }
  }
}

export type DrainableFollowup = NonNullable<ReturnType<typeof selectNextDrainableFollowup>>

export function followupSendKey(scope: string, item: FollowupItem) {
  return `${scope}:${item.sessionDirectory}:${item.sessionID}:${item.id}`
}
