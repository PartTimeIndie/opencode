import { CorsConfig, isAllowedRequestHost, isAllowedRequestOrigin } from "@opencode-ai/server/cors"
import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

// CORS response headers never stop a cross-site page from SENDING a simple
// request (including a text/plain form post). State-changing routes therefore
// need a request-side gate: reject mutations whose Origin is present and not
// allowed, and reject every request served to a Host that a DNS-rebinding
// page could control. The PTY connect flow already paired these checks.
// Registered with router.addGlobalMiddleware so every /app route is covered.
export const mutationOriginGuard = (effect: Effect.Effect<HttpServerResponse.HttpServerResponse, unknown>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const cors = yield* CorsConfig
    if (!isAllowedRequestHost(request.headers.host, cors))
      return HttpServerResponse.jsonUnsafe({ error: "Request host is not allowed" }, { status: 403 })
    const method = request.method.toLowerCase()
    if (method === "get" || method === "head" || method === "options") return yield* effect
    if (isAllowedRequestOrigin(request.headers.origin, request.headers.host, cors)) return yield* effect
    return HttpServerResponse.jsonUnsafe({ error: "Cross-origin mutation is not allowed" }, { status: 403 })
  })
