import { ServerConnection } from "@/context/server"
import { isSessionNotFoundError } from "@/context/directory-sync"
import { pathKey } from "@/utils/path-key"
import type { SessionTab } from "@/context/tabs-domain"
import { sessionTitle } from "@/utils/session-title"

export const SESSION_TABS_REMOVED_EVENT = "opencode:session-tabs-removed"
export const SESSION_TAB_RECONCILED_EVENT = "opencode:session-tab-reconciled"

export type SessionTabsRemovedDetail = {
  server: ServerConnection.Key
  directory: string
  sessionIDs: string[]
}

export type SessionTabReconciledDetail = {
  previous: SessionTab[]
  next: SessionTab
}

const pending = new Set<string>()
let sessionTabInfoQueue = Promise.resolve()
const infoLoads = new Map<string, Promise<"loaded" | "retained" | "missing">>()

async function loadSessionTabInfoNow(input: {
  server: ServerConnection.Key
  directory: string
  sessionID: string
  load: () => Promise<unknown>
  onMissing?: (detail: SessionTabsRemovedDetail) => void
}) {
  try {
    await input.load()
    return "loaded" as const
  } catch (error) {
    if (!isSessionNotFoundError(error)) {
      try {
        await input.load()
        return "loaded" as const
      } catch (retryError) {
        if (!isSessionNotFoundError(retryError)) return "retained" as const
        error = retryError
      }
    }
    const detail = { server: input.server, directory: input.directory, sessionIDs: [input.sessionID] }
    void (input.onMissing ?? notifySessionTabsRemoved)(detail)
    return "missing" as const
  }
}

export function loadSessionTabInfo(input: {
  server: ServerConnection.Key
  directory: string
  sessionID: string
  load: () => Promise<unknown>
  onMissing?: (detail: SessionTabsRemovedDetail) => void
}) {
  const key = `${input.server}\n${pathKey(input.directory)}\n${input.sessionID}`
  const existing = infoLoads.get(key)
  if (existing) return existing
  const task = sessionTabInfoQueue.then(() => loadSessionTabInfoNow(input))
  infoLoads.set(key, task)
  sessionTabInfoQueue = task.then(
    () => undefined,
    () => undefined,
  )
  void task.finally(() => {
    if (infoLoads.get(key) === task) infoLoads.delete(key)
  })
  return task
}

export function sessionTabDisplayTitle(session: { id: string; title?: string; slug?: string }) {
  return sessionTitle(session.title)?.trim() || session.slug?.trim() || session.id
}

export function notifySessionTabsRemoved(input: SessionTabsRemovedDetail) {
  const key = `${input.server}\n${pathKey(input.directory)}\n${input.sessionIDs.toSorted().join("\n")}`
  if (pending.has(key)) return false
  pending.add(key)
  window.dispatchEvent(new CustomEvent(SESSION_TABS_REMOVED_EVENT, { detail: input }))
  queueMicrotask(() => pending.delete(key))
  return true
}

export function notifySessionTabReconciled(input: SessionTabReconciledDetail) {
  window.dispatchEvent(new CustomEvent(SESSION_TAB_RECONCILED_EVENT, { detail: input }))
}

export function readSessionTabReconciledDetail(event: Event): SessionTabReconciledDetail | undefined {
  if (!(event instanceof CustomEvent)) return
  const detail: unknown = event.detail
  if (!detail || typeof detail !== "object") return
  if (!("previous" in detail) || !("next" in detail)) return
  if (!Array.isArray(detail.previous) || !detail.next || typeof detail.next !== "object") return
  const valid = (tab: object): tab is SessionTab =>
    "type" in tab &&
    tab.type === "session" &&
    "server" in tab &&
    typeof tab.server === "string" &&
    "dirBase64" in tab &&
    typeof tab.dirBase64 === "string" &&
    "sessionId" in tab &&
    typeof tab.sessionId === "string"
  if (!valid(detail.next) || !detail.previous.every((tab) => tab && typeof tab === "object" && valid(tab))) return
  return { previous: detail.previous, next: detail.next }
}

export function readSessionTabsRemovedDetail(event: Event): SessionTabsRemovedDetail | undefined {
  if (!(event instanceof CustomEvent)) return undefined

  const detail: unknown = event.detail
  if (!detail || typeof detail !== "object") return undefined
  if (!("directory" in detail)) return undefined
  if (!("sessionIDs" in detail)) return undefined
  if (typeof detail.directory !== "string") return undefined
  if (!Array.isArray(detail.sessionIDs)) return undefined

  const sessionIDs = detail.sessionIDs.filter((id): id is string => typeof id === "string")
  if (sessionIDs.length === 0) return undefined
  if (!("server" in detail) || typeof detail.server !== "string" || !detail.server.trim()) return undefined

  return {
    server: ServerConnection.Key.make(detail.server),
    directory: detail.directory,
    sessionIDs,
  }
}
