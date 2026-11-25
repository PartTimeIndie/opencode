import type { AppHostGitHistoryError } from "@opencode-ai/plugin/app"
import { formatServerError } from "../utils/server-errors"

export async function readGitResponse(response: Response, typedError = false) {
  const text = await response.text()
  if (response.status === 499) throw new DOMException("Request cancelled", "AbortError")
  let body: unknown = {}
  if (text) {
    try {
      body = JSON.parse(text) as unknown
    } catch {
      if (response.ok) throw new Error("Git server returned an invalid JSON response")
      body = text
    }
  }
  if (!response.ok) {
    const data =
      typeof body === "object" && body !== null && typeof (body as Record<string, unknown>).data === "object"
        ? ((body as Record<string, unknown>).data as Record<string, unknown>)
        : undefined
    const detail = typeof data?.message === "string" && data.message
      ? data.message
      : formatServerError(body, undefined, response.statusText)
    const message = response.status === 503 && text.trim() === "Server is starting"
      ? "OpenCode server is starting (HTTP 503). Refresh the Git status before retrying an action."
      : `Git request failed (HTTP ${response.status}): ${detail}`
    if (typedError) {
      const error = new Error(message) as AppHostGitHistoryError
      error.code = typeof data?.code === "string" ? data.code : "process_failed"
      error.recovery = typeof data?.recovery === "string" ? data.recovery : "retry"
      error.status = response.status
      throw error
    }
    throw new Error(message)
  }
  return body
}
