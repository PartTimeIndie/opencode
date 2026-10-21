import type { FollowupDraft } from "@/components/prompt-input/submit"

export type FollowupItem = FollowupDraft & { id: string }

export function selectQueuedFollowup(input: {
  items: Record<string, FollowupItem[] | undefined>
  failed: Record<string, string | undefined>
  paused?: Record<string, boolean | undefined>
  activeSessionID?: string
  isBusy: (sessionID: string, directory: string) => boolean
  isActivitySettled?: (sessionID: string, directory: string) => boolean
  isChild: (sessionID: string, directory: string) => boolean
  isBlocked: (sessionID: string, directory: string) => boolean
}) {
  const entries = Object.entries(input.items)
  const ordered = input.activeSessionID
    ? [
        ...entries.filter(([sessionID]) => sessionID === input.activeSessionID),
        ...entries.filter(([sessionID]) => sessionID !== input.activeSessionID),
      ]
    : entries

  for (const [sessionID, items] of ordered) {
    const item = items?.[0]
    if (!item) continue
    if (input.paused?.[sessionID]) continue
    if (input.failed[sessionID] === item.id) continue
    if (input.isChild(sessionID, item.sessionDirectory)) continue
    if (input.isBlocked(sessionID, item.sessionDirectory)) continue
    if (
      input.isBusy(sessionID, item.sessionDirectory) &&
      !input.isActivitySettled?.(sessionID, item.sessionDirectory)
    )
      continue
    return { sessionID, item }
  }
}
