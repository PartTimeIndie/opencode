import type { PermissionRequest, Session, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { cmp } from "./utils"
import { SESSION_RECENT_LIMIT, SESSION_RECENT_WINDOW } from "./types"

export function sessionUpdatedAt(session: Session) {
  return session.time.updated ?? session.time.created
}

export function compareSessionRecent(a: Session, b: Session) {
  const aUpdated = sessionUpdatedAt(a)
  const bUpdated = sessionUpdatedAt(b)
  if (aUpdated !== bUpdated) return bUpdated - aUpdated
  return cmp(a.id, b.id)
}

export function takeRecentSessions(sessions: Session[], limit: number, cutoff: number) {
  if (limit <= 0) return [] as Session[]
  const selected: Session[] = []
  const seen = new Set<string>()
  for (const session of sessions) {
    if (!session?.id) continue
    if (seen.has(session.id)) continue
    seen.add(session.id)
    if (sessionUpdatedAt(session) <= cutoff) continue
    const index = selected.findIndex((x) => compareSessionRecent(session, x) < 0)
    if (index === -1) selected.push(session)
    if (index !== -1) selected.splice(index, 0, session)
    if (selected.length > limit) selected.pop()
  }
  return selected
}

export function trimSessions(
  input: Session[],
  options: {
    limit: number
    permission: Record<string, PermissionRequest[]>
    preserve?: ReadonlySet<string>
    now?: number
  },
) {
  const limit = Math.max(0, options.limit)
  const cutoff = (options.now ?? Date.now()) - SESSION_RECENT_WINDOW
  const all = input
    .filter((s) => !!s?.id)
    .filter((s) => !s.time?.archived)
    .sort((a, b) => cmp(a.id, b.id))
  const roots = all.filter((s) => !s.parentID)
  roots.sort(compareSessionRecent)
  const children = all.filter((s) => !!s.parentID)
  const base = roots.slice(0, limit)
  const recent = takeRecentSessions(roots.slice(limit), SESSION_RECENT_LIMIT, cutoff)
  const selectedRootIDs = new Set([...base, ...recent].map((session) => session.id))
  const preservedRootIDs = new Set(
    [...(options.preserve ?? [])].map(
      (id) => children.find((session) => session.id === id)?.parentID ?? id,
    ),
  )
  const keepRoots = roots.filter(
    (session) => selectedRootIDs.has(session.id) || preservedRootIDs.has(session.id),
  )
  const keepRootIds = new Set(keepRoots.map((s) => s.id))
  const keepChildren = children.filter((s) => {
    if (options.preserve?.has(s.id)) return true
    if (s.parentID && keepRootIds.has(s.parentID)) return true
    const perms = options.permission[s.id] ?? []
    if (perms.length > 0) return true
    return sessionUpdatedAt(s) > cutoff
  })
  return [...keepRoots, ...keepChildren].sort((a, b) => cmp(a.id, b.id))
}

export function sessionTrimPreserveIDs(input: {
  retained?: ReadonlySet<string>
  status: Record<string, SessionStatus | undefined>
  permission: Record<string, readonly unknown[] | undefined>
  question: Record<string, readonly unknown[] | undefined>
}) {
  return new Set([
    ...(input.retained ?? []),
    ...Object.entries(input.status)
      .filter(([, status]) => !!status && status.type !== "idle")
      .map(([sessionID]) => sessionID),
    ...Object.entries(input.permission)
      .filter(([, requests]) => (requests?.length ?? 0) > 0)
      .map(([sessionID]) => sessionID),
    ...Object.entries(input.question)
      .filter(([, requests]) => (requests?.length ?? 0) > 0)
      .map(([sessionID]) => sessionID),
  ])
}
