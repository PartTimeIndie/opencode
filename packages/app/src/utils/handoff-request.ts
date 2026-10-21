import { directoryKey } from "@/utils/path-key"

export type HandoffRequestIdentity = {
  directory: string
  sessionID: string
  requestID: string
}

export function handoffRequestKey(request: HandoffRequestIdentity) {
  return `${directoryKey(request.directory)}:${request.sessionID}:${request.requestID}`
}

export function hasHandoffRequestInSession(
  entries: Record<string, unknown>,
  request: Pick<HandoffRequestIdentity, "directory" | "sessionID">,
) {
  const prefix = handoffRequestKey({ ...request, requestID: "" })
  return Object.keys(entries).some((key) => key.startsWith(prefix))
}

export function isHandoffRequestIdentity(value: unknown): value is HandoffRequestIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  return (
    "directory" in value && typeof value.directory === "string" && value.directory.length > 0 &&
    "sessionID" in value && typeof value.sessionID === "string" && value.sessionID.length > 0 &&
    "requestID" in value && typeof value.requestID === "string" && value.requestID.length > 0
  )
}
