import { base64Encode } from "@opencode-ai/core/util/encode"
import type { PermissionRequest, SurfaceRequest, Session } from "@opencode-ai/sdk/v2/client"
import { directoryKey } from "@/utils/path-key"

export function questionRequestKey(request: Pick<SurfaceRequest, "sessionID" | "id">) {
  return `${request.sessionID}:${request.id}`
}

export function questionDockPaneId(request: Pick<SurfaceRequest, "sessionID" | "id">) {
  return `question:${questionRequestKey(request)}`
}

export function controlPanelPaneId(directory: string, sessionID: string, messageID: string, partID: string) {
  return `control-panel:${base64Encode([directoryKey(directory), sessionID, messageID, partID].join("\0"))}`
}

export function isImplementationCompleteFollowupQuestion(request: SurfaceRequest) {
  return request.mode === "blocking" && request.phase === "implementation_complete_followup"
}

export function isDetachedSurfaceRequest(request: SurfaceRequest) {
  return request.mode !== "blocking" || request.detached === true
}

export function sessionTreeIDs(session: Session[], sessionID?: string) {
  if (!sessionID) return []
  const children = session.reduce((result, item) => {
    if (!item.parentID) return result
    const current = result.get(item.parentID)
    if (current) current.push(item.id)
    if (!current) result.set(item.parentID, [item.id])
    return result
  }, new Map<string, string[]>())
  const result = [sessionID]
  const seen = new Set(result)
  for (const id of result) {
    for (const child of children.get(id) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      result.push(child)
    }
  }
  return result
}

export function sessionInTree(session: Session[], sessionID: string | undefined, candidateID: string) {
  return sessionTreeIDs(session, sessionID).includes(candidateID)
}

export function sessionPermissionRequest(
  _session: Session[],
  request: Record<string, PermissionRequest[] | undefined>,
  sessionID?: string,
  include: (item: PermissionRequest) => boolean = () => true,
) {
  if (!sessionID) return
  return request[sessionID]?.find(include)
}

export function sessionSurfaceRequest(
  session: Session[],
  request: Record<string, SurfaceRequest[] | undefined>,
  sessionID?: string,
  include?: (item: SurfaceRequest) => boolean,
) {
  return sessionSurfaceRequests(session, request, sessionID, include)[0]
}

export function sessionSurfaceRequests(
  session: Session[],
  request: Record<string, SurfaceRequest[] | undefined>,
  sessionID?: string,
  include: (item: SurfaceRequest) => boolean = () => true,
) {
  return sessionTreeIDs(session, sessionID).flatMap((id) => request[id]?.filter(include) ?? [])
}
