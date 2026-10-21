import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { OpenApi } from "effect/unstable/httpapi"
import { SummaryFailed } from "@opencode-ai/core/session/compaction"
import { MessageDecodeError } from "@opencode-ai/core/session/error"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { Api } from "../src/api"
import { ServiceUnavailableError, UnknownError } from "../src/errors"
import { sessionCompactionFailure } from "../src/handlers/session"

const sessionID = SessionSchema.ID.make("ses_compaction_http_error")

test("compaction summary failures map to a typed 503, including model-switch preflight", async () => {
  const error = await Effect.runPromise(
    sessionCompactionFailure(new SummaryFailed({ sessionID, reason: "Provider unavailable" })).pipe(Effect.flip),
  )
  expect(error).toBeInstanceOf(ServiceUnavailableError)
  expect(Schema.encodeUnknownSync(ServiceUnavailableError)(error)).toEqual({
    _tag: "ServiceUnavailableError",
    message: "Provider unavailable",
    service: "session-compaction",
  })
})

test("message decode failures map to a typed 500 without exposing message identifiers", async () => {
  const error = await Effect.runPromise(
    sessionCompactionFailure(
      new MessageDecodeError({ sessionID, messageID: SessionMessage.ID.make("msg_private") }),
    ).pipe(Effect.flip),
  )
  expect(error).toBeInstanceOf(UnknownError)
  const encoded = Schema.encodeUnknownSync(UnknownError)(error)
  expect(encoded).toMatchObject({
    _tag: "UnknownError",
    message: "Unexpected server error. Check server logs for details.",
    ref: expect.stringMatching(/^err_[a-f0-9]{8}$/),
  })
  expect(JSON.stringify(encoded)).not.toContain("msg_private")
  expect(JSON.stringify(encoded)).not.toContain(sessionID)
})

test("both HTTP endpoints declare the compaction 500 and 503 response contracts", () => {
  const spec = OpenApi.fromApi(Api)
  for (const path of ["/api/session/{sessionID}/model", "/api/session/{sessionID}/compact"]) {
    const responses = spec.paths[path]?.post?.responses
    expect(responses).toBeDefined()
    expect(Object.keys(responses ?? {})).toContain("500")
    expect(Object.keys(responses ?? {})).toContain("503")
  }
})
