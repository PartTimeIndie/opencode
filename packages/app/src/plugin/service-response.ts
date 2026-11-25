import type { AppPluginApi } from "@opencode-ai/plugin/app"

/** Keep transport failures distinguishable from plugin-level refusals. */
export async function pluginServiceResponse(response: Response): Promise<Awaited<ReturnType<AppPluginApi["services"]["call"]>>> {
  const body: unknown = await response.json().catch(() => undefined)
  const record = body && typeof body === "object" && !Array.isArray(body) ? body : undefined
  if (response.ok && record && "ok" in record && record.ok === true)
    return { ok: true, data: "data" in record ? record.data : undefined }
  return {
    ok: false,
    error: record && "message" in record && typeof record.message === "string" ? record.message : "Plugin service failed",
    ...(!response.ok ? { status: response.status } : {}),
  }
}
