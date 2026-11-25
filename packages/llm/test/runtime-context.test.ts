import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LLM, LLMRequest, Message, SystemPart } from "../src"
import { configure } from "../src/providers/openai"
import { LLMClient } from "../src/route"
import { it } from "./lib/effect"
import { dynamicResponse } from "./lib/http"
import { sseEvents } from "./lib/sse"

const model = configure({ apiKey: "fixture" }).responses("gpt-4.1")
const request = LLM.request({
  model,
  system: "Shared instructions",
  messages: [Message.user("Assigned work"), Message.assistant("Shared answer"), Message.system("<operator> & update")],
  runtimeContext: [SystemPart.make("Host-owned child identity")],
})

describe("late privileged runtime context", () => {
  test("survives both request update paths without becoming history", () => {
    for (const updated of [
      LLMRequest.update(request, { id: "updated" }),
      LLM.updateRequest(request, { id: "updated" }),
    ]) {
      expect(updated.runtimeContext).toEqual(request.runtimeContext)
      expect(updated.messages).toEqual(request.messages)
      expect(updated.system).toEqual(request.system)
    }
    expect(LLMRequest.update(request, { runtimeContext: [] }).runtimeContext).toEqual([])
  })

  it.effect("serializes native Responses context after history while operator updates stay unprivileged", () =>
    LLMClient.generate(request).pipe(
      Effect.provide(
        dynamicResponse((input) =>
          Effect.sync(() => {
            expect(JSON.parse(input.text).input).toEqual([
              { role: "system", content: "Shared instructions" },
              { role: "user", content: [{ type: "input_text", text: "Assigned work" }] },
              { role: "assistant", content: [{ type: "output_text", text: "Shared answer" }] },
              {
                role: "user",
                content: [
                  { type: "input_text", text: "<system-update>\n&lt;operator&gt; &amp; update\n</system-update>" },
                ],
              },
              { role: "system", content: "Host-owned child identity" },
            ])
            return input.respond(sseEvents({ type: "response.completed", response: {} }), {
              headers: { "content-type": "text/event-stream" },
            })
          }),
        ),
      ),
    ),
  )

  it.effect("refuses unsupported routes and request/default overlays before transport", () =>
    Effect.gen(function* () {
      const attempts = [
        LLM.updateRequest(request, { model: configure({ apiKey: "fixture" }).chat("gpt-4.1") }),
        ...[
          "input",
          "messages",
          "instructions",
          "system",
          "model",
          "prompt",
          "previous_response_id",
          "conversation",
          "truncation",
        ].flatMap((key) => [
          LLM.updateRequest(request, { http: { body: { [key]: "override" } } }),
          LLM.updateRequest(request, {
            model: model.route.with({ http: { body: { [key]: "override" } } }).model({ id: model.id }),
          }),
        ]),
        ...["instructions", "previousResponseId", "conversation", "prompt", "truncation"].map((key) =>
          LLM.updateRequest(request, { providerOptions: { openai: { [key]: "override" } } }),
        ),
        LLM.updateRequest(request, { providerOptions: { openai: { systemMessageMode: "remove" } } }),
      ]
      for (const attempt of attempts) {
        const result = yield* LLMClient.prepare(attempt).pipe(Effect.result)
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") {
          expect(result.failure.reason._tag).toBe("InvalidRequest")
          expect(result.failure.retryable).toBe(false)
        }
      }
    }),
  )
})
