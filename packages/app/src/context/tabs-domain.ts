import type { Session } from "@opencode-ai/sdk/v2/client"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { ServerConnection } from "./server"
import { pathKey } from "@/utils/path-key"

export type SessionTab = {
  type: "session"
  server: ServerConnection.Key
  dirBase64: string
  sessionId: string
  createdEmpty?: boolean
}

export type DraftTab = {
  type: "draft"
  draftID: string
  server: ServerConnection.Key
  directory: string
  worktree?: string
}

export type Tab = SessionTab | DraftTab

export type RecentLocalState = {
  loaded: boolean
  write: number
  key?: string
}

// Value-stable recent-key write: returns undefined when the resolved key is
// unchanged so re-selecting the active tab does not create a new signal
// identity. Keyed subtrees downstream remount on identity changes, so a
// no-op navigation must stay a true no-op.
export function nextRecentLocal(current: RecentLocalState, key: string | undefined) {
  if (current.loaded && current.key === key) return
  return { loaded: true, write: current.write + 1, key }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const draftHref = (_draftID: string) => "/"

export const tabHref = (_tab: Tab) => "/"

export const tabKey = (tab: Tab) =>
  tab.type === "draft" ? `draft:${tab.draftID}` : `${tab.server}\n${tab.dirBase64}\n${tab.sessionId}`

export const sessionTabIdentity = (tab: Pick<SessionTab, "server" | "sessionId">) => `${tab.server}\n${tab.sessionId}`

export const sessionTabDockPaneID = (tab: SessionTab) => `tab:${base64Encode(tabKey(tab))}`

export function sessionHasOpenTab(tabs: Tab[], server: ServerConnection.Key, session: Session) {
  const identity = sessionTabIdentity({ server, sessionId: session.id })
  return tabs.some((tab) => tab.type === "session" && sessionTabIdentity(tab) === identity)
}

export function reconcileSessionTab(tabs: Tab[], next: SessionTab) {
  const identity = sessionTabIdentity(next)
  const matches = tabs.filter(
    (tab): tab is SessionTab => tab.type === "session" && sessionTabIdentity(tab) === identity,
  )
  const existing = matches[0]
  if (!existing) return [...tabs, next]

  const merged = {
    ...existing,
    ...next,
    // A session stays disposable only while every known copy is still unused.
    createdEmpty: matches.every((tab) => tab.createdEmpty === true) && next.createdEmpty !== false ? true : undefined,
  }
  if (
    matches.length === 1 &&
    existing.dirBase64 === merged.dirBase64 &&
    existing.createdEmpty === merged.createdEmpty
  )
    return tabs
  return tabs.flatMap((tab) => {
    if (tab.type !== "session" || sessionTabIdentity(tab) !== identity) return [tab]
    return tab === existing ? [merged] : []
  })
}

export function sessionTabReplacementForKey(tabs: Tab[], key: string) {
  if (tabs.some((tab) => tabKey(tab) === key)) return
  const [server, dirBase64, sessionId, ...extra] = key.split("\n")
  if (!server || !dirBase64 || !sessionId || extra.length > 0) return
  const next = tabs.find(
    (tab): tab is SessionTab => tab.type === "session" && tab.server === server && tab.sessionId === sessionId,
  )
  if (!next) return
  return {
    previous: {
      type: "session" as const,
      server: ServerConnection.Key.make(server),
      dirBase64,
      sessionId,
    },
    next,
  }
}

export function migrateStoredTabs(value: unknown, fallback: ServerConnection.Key) {
  if (!Array.isArray(value)) return value
  return value
    .flatMap((tab): Tab[] => {
      if (!isRecord(tab)) return []
      if (tab.type === "draft") {
        if (typeof tab.draftID !== "string" || typeof tab.directory !== "string") return []
        return [
          {
            type: "draft",
            draftID: tab.draftID,
            server: typeof tab.server === "string" ? ServerConnection.Key.make(tab.server) : fallback,
            directory: tab.directory,
            ...(typeof tab.worktree === "string" ? { worktree: tab.worktree } : {}),
          },
        ]
      }
      if (tab.type !== "session") return []
      if (typeof tab.dirBase64 !== "string" || typeof tab.sessionId !== "string") return []
      const next = {
        type: "session" as const,
        server: typeof tab.server === "string" ? ServerConnection.Key.make(tab.server) : fallback,
        dirBase64: tab.dirBase64,
        sessionId: tab.sessionId,
      }
      return tab.createdEmpty === true ? [{ ...next, createdEmpty: true }] : [next]
    })
    .reduce((tabs, tab) => (tab.type === "session" ? reconcileSessionTab(tabs, tab) : [...tabs, tab]), [] as Tab[])
}

export function moveSessionTabs(
  tabs: Tab[],
  input: {
    server: ServerConnection.Key
    fromDirectory: string
    toDirectory: string
    sessionIDs: string[]
  },
) {
  const sessionIDs = new Set(input.sessionIDs)
  const nextDirBase64 = base64Encode(input.toDirectory)
  const fromDirectory = pathKey(input.fromDirectory)
  const seen = new Set<string>()
  return tabs
    .map((tab) => {
      if (tab.type !== "session") return tab
      if (tab.server !== input.server) return tab
      if (pathKey(atob(tab.dirBase64)) !== fromDirectory) return tab
      if (!sessionIDs.has(tab.sessionId)) return tab
      return { ...tab, dirBase64: nextDirBase64 }
    })
    .filter((tab) => {
      const key = tab.type === "session" ? sessionTabIdentity(tab) : tabKey(tab)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

export function sessionTabMatchesRemoved(
  tab: Tab | undefined,
  input: {
    server: ServerConnection.Key
    directory: string
    sessionIDs: ReadonlySet<string>
  },
) {
  if (!tab || tab.type !== "session") return false
  if (tab.server !== input.server) return false
  if (pathKey(atob(tab.dirBase64)) !== pathKey(input.directory)) return false
  return input.sessionIDs.has(tab.sessionId)
}

export function reorderTabs(tabs: Tab[], fromKey: string, toKey: string) {
  const fromIndex = tabs.findIndex((tab) => tabKey(tab) === fromKey)
  const toIndex = tabs.findIndex((tab) => tabKey(tab) === toKey)
  if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return tabs

  const next = [...tabs]
  const [tab] = next.splice(fromIndex, 1)
  if (!tab) return tabs
  next.splice(toIndex, 0, tab)
  return next
}
