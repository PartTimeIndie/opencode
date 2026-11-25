import { CrashActivity } from "@opencode-ai/core/observability/crash-activity"
import { Effect } from "effect"
import { HttpServerRequest } from "effect/unstable/http"

const sessionRead = /^(?:https?:\/\/[^/?#]+)?\/(api\/)?session\/(ses_[\w-]{1,120})(?:\/(exists|message|children|attention))?(?=[?#]|$)/

export function traceSessionRead<A, E, R>(effect: Effect.Effect<A, E, R>, track = CrashActivity.track) {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (request.method !== "GET") return yield* effect
    const match = sessionRead.exec(request.url)
    if (!match) return yield* effect
    const [, v2, sessionID, suffix] = match
    const name = suffix === "message" ? "messages" : (suffix ?? "get")
    return yield* track({ kind: "session-read", sessionID, name: `${v2 ? "v2." : ""}session.${name}` }, effect)
  })
}
