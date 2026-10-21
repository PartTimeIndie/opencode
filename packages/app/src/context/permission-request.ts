import type { OpencodeClient, PermissionRequest, PermissionV2Request } from "@opencode-ai/sdk/v2/client"

const PROTOCOL_KEY = "$opencode.permission.protocol"

export function normalizePermissionRequest(input: PermissionRequest | PermissionV2Request): PermissionRequest {
  if ("permission" in input) return input
  return {
    id: input.id,
    sessionID: input.sessionID,
    permission: input.action,
    patterns: input.resources,
    metadata: { ...input.metadata, [PROTOCOL_KEY]: "v2" },
    always: input.save ?? [],
    ...(input.source?.type === "tool"
      ? { tool: { messageID: input.source.messageID, callID: input.source.callID } }
      : {}),
  }
}

export function isV2PermissionRequest(input: PermissionRequest) {
  return input.metadata[PROTOCOL_KEY] === "v2"
}

export async function loadPendingPermissions(client: OpencodeClient, directory: string, signal?: AbortSignal) {
  const results = await Promise.allSettled([
    client.permission.list({ directory }, { signal }),
    client.v2.permission.request.list({ location: { directory } }, { signal }),
  ])
  if (results[0].status === "rejected" && results[1].status === "rejected") throw results[1].reason
  const legacy = results[0].status === "fulfilled" ? (results[0].value.data ?? []) : []
  const current = results[1].status === "fulfilled" ? (results[1].value.data?.data ?? []) : []
  const merged = new Map<string, PermissionRequest>()
  legacy
    .filter((permission) => !!permission?.id && !!permission.sessionID)
    .forEach((permission) => merged.set(permission.id, permission))
  current
    .filter((permission) => !!permission.id && !!permission.sessionID)
    .map(normalizePermissionRequest)
    .forEach((permission) => merged.set(permission.id, permission))
  return { pending: [...merged.values()], complete: results.every((result) => result.status === "fulfilled") }
}

export function respondPermission(
  client: OpencodeClient,
  input: {
    request: PermissionRequest
    response: "once" | "always" | "reject"
    directory?: string
  },
) {
  if (isV2PermissionRequest(input.request))
    return client.v2.session.permission
      .reply({
        sessionID: input.request.sessionID,
        requestID: input.request.id,
        reply: input.response,
      })
      .then(() => undefined)
  return client.permission
    .respond({
      sessionID: input.request.sessionID,
      permissionID: input.request.id,
      response: input.response,
      directory: input.directory,
    })
    .then(() => undefined)
}
