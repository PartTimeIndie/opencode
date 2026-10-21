import type { PermissionRequest } from "@opencode-ai/sdk/v2"

export function permissionAllowsAlways(request: Pick<PermissionRequest, "always" | "metadata">) {
  return request.metadata["$opencode.permission.single_use"] !== true && request.always.length > 0
}
