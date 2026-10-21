import type { Session, SurfaceControlRequest, SurfaceRequest } from "@opencode-ai/sdk/v2/client"
import { agentHandoffStep, type SurfaceAction } from "@/components/control-surface-runtime"
import { directoryKey } from "@/utils/path-key"
import { handoffRequestKey } from "@/utils/handoff-request"
import { sessionInTree } from "../session/composer/session-request-tree"

export function shouldShowQuestionPopup(input: { pending: boolean; dismissed: boolean; minimized: boolean }) {
  return input.pending && !input.dismissed && !input.minimized
}

export function shouldShowHandoffPopup(input: {
  ready: boolean
  pending: boolean
  dismissed: boolean
  minimized: boolean
}) {
  return input.ready && input.pending && !input.dismissed && !input.minimized
}

export function matchesQuestionPopup(
  item: { directory: string; request: Pick<SurfaceRequest, "id" | "sessionID"> },
  directory: string,
  request: Pick<SurfaceRequest, "id" | "sessionID">,
) {
  return (
    directoryKey(item.directory) === directoryKey(directory) &&
    item.request.sessionID === request.sessionID &&
    item.request.id === request.id
  )
}

export function removePopupKeys(
  entries: Record<string, unknown>,
  directory: string,
  request: Pick<SurfaceRequest, "id" | "sessionID">,
) {
  const key = handoffRequestKey({ directory, sessionID: request.sessionID, requestID: request.id })
  return Object.entries(entries ?? {})
    .filter(([entryKey, item]) =>
      entryKey === key ||
      (isPopupEntry(item) && matchesQuestionPopup(item, directory, request)),
    )
    .map(([key]) => key)
}

function isPopupEntry(value: unknown): value is {
  directory: string
  request: Pick<SurfaceRequest, "id" | "sessionID">
} {
  if (typeof value !== "object" || value === null) return false
  if (!("directory" in value) || typeof value.directory !== "string") return false
  if (!("request" in value) || typeof value.request !== "object" || value.request === null) return false
  return (
    "id" in value.request && typeof value.request.id === "string" &&
    "sessionID" in value.request && typeof value.request.sessionID === "string"
  )
}

/**
 * An agent switch confirmation also arrives as a surface request, only with
 * an interactive (never blocking) mode. It is pending until the request is
 * dismissed, so the revision only identifies the exact form, never liveness.
 */
export function handoffPopupKey(directory: string, request: Pick<SurfaceControlRequest, "id" | "sessionID">) {
  return handoffRequestKey({ directory, sessionID: request.sessionID, requestID: request.id })
}

export function handoffCoveredByCurrentSession(input: {
  routeDirectory: string
  requestDirectory: string
  currentSessionID?: string
  requestSessionID: string
  routeSessions: Session[]
  requestSessions: Session[]
}) {
  if (sessionInTree(input.routeSessions, input.currentSessionID, input.requestSessionID)) return true
  if (directoryKey(input.routeDirectory) !== directoryKey(input.requestDirectory)) return false
  return sessionInTree(input.requestSessions, input.currentSessionID, input.requestSessionID)
}

export function handoffCoveredByDock(input: {
  directory: string
  request: Pick<SurfaceControlRequest, "id" | "sessionID">
  visibleRequestKeys: readonly string[]
}) {
  const key = handoffRequestKey({
    directory: input.directory,
    sessionID: input.request.sessionID,
    requestID: input.request.id,
  })
  return input.visibleRequestKeys.includes(key)
}

export function pendingHandoffStep(request: SurfaceRequest) {
  if (request.mode === "blocking") return undefined
  const action = request.surface.actions?.[0]
  if (!action) return undefined
  const step = agentHandoffStep(action as SurfaceAction)
  return step ? { action, step } : undefined
}

/**
 * A cached handoff popup may outlive its request (missed dismissal event) or
 * fall behind a newer revision. Once the directory's authoritative snapshot is
 * available ("complete"), it always wins: a request with the same id replaces
 * the cache entry, a missing request drops it, and only a missing snapshot
 * keeps the cache as fallback.
 */
export function handoffCacheDecision(input: {
  cachedRequest: Pick<SurfaceRequest, "id">
  authoritativeRequests: readonly SurfaceRequest[] | undefined
}) {
  if (!input.authoritativeRequests) return "keep-cache" as const
  if (input.authoritativeRequests.some((request) => request.id === input.cachedRequest.id)) return "authoritative" as const
  return "drop" as const
}
