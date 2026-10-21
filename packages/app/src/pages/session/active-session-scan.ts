import type { SurfaceControlRequest } from "@opencode-ai/sdk/v2/client"

export function resolveActiveSessionScan<T>(input: {
  directory: string | undefined
  sessionID: string | undefined
  resolve: (directory: string) => T | undefined
}) {
  if (!input.directory || !input.sessionID) return
  const store = input.resolve(input.directory)
  if (!store) return
  return { directory: input.directory, sessionID: input.sessionID, store }
}

export function shouldKeepHistoricalHandoffFallback(input: {
  hasLiveRequest: boolean
  requestsLoaded: boolean
  ready: boolean
}) {
  return input.ready && !input.hasLiveRequest && !input.requestsLoaded
}

export function matchesRetainedHandoffRequest(input: {
  panel: { requestID?: string; messageID: string; controlID: string }
  request: Pick<SurfaceControlRequest, "id" | "tool" | "surface">
}) {
  if (input.panel.requestID) return input.request.id === input.panel.requestID
  if (input.request.tool?.messageID) {
    return input.request.tool.messageID === input.panel.messageID && input.request.surface.controlID === input.panel.controlID
  }
  return input.request.surface.controlID === input.panel.controlID
}

export function retainedHandoffRequest<TRequest extends Pick<SurfaceControlRequest, "id">>(input: {
  panel: { requestID?: string }
  requests: readonly TRequest[]
}) {
  if (!input.panel.requestID) return undefined
  return input.requests.find((request) => request.id === input.panel.requestID)
}

export function isStaleRetainedHandoffRequest(input: {
  panel: { requestRevision?: number; requestCapability?: string }
  request: Pick<SurfaceControlRequest, "revision" | "tool">
}) {
  if (input.panel.requestRevision !== undefined && input.panel.requestRevision !== input.request.revision) return true
  if (
    input.panel.requestCapability !== undefined &&
    input.request.tool?.confirmationToken !== undefined &&
    input.panel.requestCapability !== input.request.tool.confirmationToken
  )
    return true
  return false
}

export function shouldKeepRetainedHandoffPanel(input: {
  requestID: string | undefined
  dismissed: boolean
  hasLiveRequest: boolean
  snapshotAvailable: boolean
  requestsLoaded: boolean
  ready: boolean
}) {
  if (!input.ready || !input.snapshotAvailable || input.dismissed) return false
  if (input.requestID) {
    return input.hasLiveRequest || !input.requestsLoaded
  }
  return shouldKeepHistoricalHandoffFallback(input)
}

export function updateVisiblePanelCache<T extends { paneID: string }>(input: {
  cache: Map<string, T>
  active: T[]
  closed: Record<string, boolean | undefined>
  visible: (id: string) => boolean
  keep?: (panel: T) => boolean
}) {
  input.active
    .filter((panel) => input.visible(panel.paneID) && input.keep?.(panel) !== false)
    .forEach((panel) => input.cache.set(panel.paneID, panel))
  for (const [id, panel] of input.cache) {
    if (input.closed[id] || !input.visible(id) || input.keep?.(panel) === false) input.cache.delete(id)
  }
  return [...input.cache.values()]
}
