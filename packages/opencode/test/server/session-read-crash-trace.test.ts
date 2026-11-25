import { expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { CrashActivity } from "@opencode-ai/core/observability/crash-activity"
import { traceSessionRead } from "@/server/routes/instance/httpapi/middleware/session-read-crash-trace"

test("records only allowlisted read routes around the HTTP handler", async () => {
  const events: CrashActivity.Update[] = []
  const trace = CrashActivity.create()
  trace.configure((event) => events.push(event))
  const handler = traceSessionRead(
    Effect.sync(() => {
      expect(events.at(-1)).toMatchObject({ phase: "start" })
      return HttpServerResponse.empty({ status: 404 })
    }),
    trace.track,
  )
  for (const [path, name] of [
    ["/session/ses_test", "session.get"],
    ["/session/ses_test/exists", "session.exists"],
    ["/session/ses_test/message", "session.messages"],
    ["/api/session/ses_test/message", "v2.session.messages"],
  ] as const) {
    events.length = 0
    const response = await Effect.runPromise(
      handler.pipe(Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(new Request(`http://localhost${path}?directory=/private&before=opaque`)),
      )),
    )
    expect(response.status).toBe(404)
    expect(events).toEqual([
      { phase: "start", id: expect.any(Number), kind: "session-read", sessionID: "ses_test", name },
      { phase: "end", id: events[0]?.id, outcome: "success" },
    ])
  }
  events.length = 0
  const unrelated = traceSessionRead(Effect.succeed(HttpServerResponse.empty()), trace.track)
  for (const [path, method] of [
    ["/api/session/ses_test/message", "POST"],
    ["/session/ses_test/message/msg_one", "GET"],
    ["/session/ses_test%20private/exists", "GET"],
    ["/global/event", "GET"],
  ]) {
    await Effect.runPromise(unrelated.pipe(Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(new Request(`http://localhost${path}`, { method })),
    )))
  }
  expect(events).toEqual([])
})
