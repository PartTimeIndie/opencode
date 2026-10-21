import { describe, expect, test } from "bun:test"
import type { OpencodeClient, PermissionRequest, PermissionV2Request } from "@opencode-ai/sdk/v2/client"
import { isV2PermissionRequest, loadPendingPermissions, normalizePermissionRequest, respondPermission } from "./permission-request"

describe("permission requests", () => {
  test("forwards cancellation to both pending permission endpoints", async () => {
    const controller = new AbortController()
    const signals: Array<AbortSignal | undefined> = []
    const client = {
      permission: {
        list: async (_parameters: unknown, options?: { signal?: AbortSignal }) => {
          signals.push(options?.signal)
          return { data: [] }
        },
      },
      v2: {
        permission: {
          request: {
            list: async (_parameters: unknown, options?: { signal?: AbortSignal }) => {
              signals.push(options?.signal)
              return { data: { data: [] } }
            },
          },
        },
      },
    } as unknown as OpencodeClient

    await loadPendingPermissions(client, "C:/repo", controller.signal)

    expect(signals).toEqual([controller.signal, controller.signal])
  })

  test("normalizes V2 requests for the existing permission UI", () => {
    const request = normalizePermissionRequest({
      id: "per_v2",
      sessionID: "ses_1",
      action: "external_directory",
      resources: ["C:/Users/test/.config/opencode/*"],
      save: ["C:/Users/test/.config/opencode/*"],
      metadata: { reason: "read config" },
      source: { type: "tool", messageID: "msg_1", callID: "call_1" },
    } satisfies PermissionV2Request)

    expect(request).toMatchObject({
      id: "per_v2",
      sessionID: "ses_1",
      permission: "external_directory",
      patterns: ["C:/Users/test/.config/opencode/*"],
      always: ["C:/Users/test/.config/opencode/*"],
      tool: { messageID: "msg_1", callID: "call_1" },
      metadata: { reason: "read config" },
    })
    expect(isV2PermissionRequest(request)).toBe(true)
  })

  test("routes replies to the protocol that owns the pending request", async () => {
    const legacy: unknown[] = []
    const current: unknown[] = []
    const client = {
      permission: {
        respond: async (input: unknown) => {
          legacy.push(input)
        },
      },
      v2: {
        session: {
          permission: {
            reply: async (input: unknown) => {
              current.push(input)
            },
          },
        },
      },
    } as unknown as OpencodeClient
    const legacyRequest = {
      id: "per_legacy",
      sessionID: "ses_1",
      permission: "read",
      patterns: ["*"],
      metadata: {},
      always: ["*"],
    } satisfies PermissionRequest
    const currentRequest = normalizePermissionRequest({
      id: "per_v2",
      sessionID: "ses_1",
      action: "external_directory",
      resources: ["C:/Users/test/.config/opencode/*"],
    } satisfies PermissionV2Request)

    await respondPermission(client, { request: legacyRequest, response: "once", directory: "C:/repo" })
    await respondPermission(client, { request: currentRequest, response: "always", directory: "C:/repo" })

    expect(legacy).toEqual([
      {
        sessionID: "ses_1",
        permissionID: "per_legacy",
        response: "once",
        directory: "C:/repo",
      },
    ])
    expect(current).toEqual([{ sessionID: "ses_1", requestID: "per_v2", reply: "always" }])
  })
})
