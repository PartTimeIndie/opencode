import { NamedError } from "@opencode-ai/core/util/error"
import { ConfigErrorV1 } from "@opencode-ai/core/v1/config/error"
import { Cause, Effect } from "effect"
import { HttpRouter, HttpServerError, HttpServerRespondable, HttpServerResponse } from "effect/unstable/http"

// Keep typed HttpApi failures on their declared error path; this boundary only replaces defect-only empty 500s.
export const errorLayer = HttpRouter.middleware<{ handles: unknown }>()((effect) =>
  effect.pipe(
    Effect.catchCause((cause) => {
      const defect = cause.reasons.filter(Cause.isDieReason).find((reason) => {
        if (HttpServerResponse.isHttpServerResponse(reason.defect)) return false
        if (HttpServerError.isHttpServerError(reason.defect)) return false
        if (HttpServerRespondable.isRespondable(reason.defect)) return false
        return true
      })
      if (!defect) return Effect.failCause(cause)

      const error = defect.defect
      if (
        ConfigErrorV1.JsonError.isInstance(error) ||
        ConfigErrorV1.InvalidError.isInstance(error) ||
        ConfigErrorV1.FrontmatterError.isInstance(error) ||
        ConfigErrorV1.DirectoryTypoError.isInstance(error)
      ) {
        return Effect.succeed(HttpServerResponse.jsonUnsafe(error.toObject(), { status: 400 }))
      }

      const ref = `err_${crypto.randomUUID().slice(0, 8)}`
      if (isDiskFullError(error)) {
        return Effect.logError("failed", { ref, error, cause: Cause.pretty(cause) }).pipe(
          Effect.as(
            HttpServerResponse.jsonUnsafe(
              new NamedError.Unknown({
                message: "Not enough disk space to complete the request. Free up disk space and try again.",
                ref,
              }).toObject(),
              { status: 507 },
            ),
          ),
        )
      }

      return Effect.logError("failed", { ref, error, cause: Cause.pretty(cause) }).pipe(
        Effect.as(
          HttpServerResponse.jsonUnsafe(
            new NamedError.Unknown({
              message: "Unexpected server error. Check server logs for details.",
              ref,
            }).toObject(),
            { status: 500 },
          ),
        ),
      )
    }),
  ),
).layer

function isDiskFullError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return typeof error === "string" && /(?:ENOSPC|no space left on device)/i.test(error)
  }

  const data = error as { code?: unknown; message?: unknown; cause?: unknown }
  if (data.code === "ENOSPC") return true
  if (typeof data.message === "string" && /(?:ENOSPC|no space left on device)/i.test(data.message)) return true
  return isDiskFullError(data.cause)
}
