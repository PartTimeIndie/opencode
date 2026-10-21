import { EventStreamCodec } from "@smithy/eventstream-codec"
import { fromUtf8, toUtf8 } from "@smithy/util-utf8"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LLM } from "../../src"
import { Auth, LLMClient } from "../../src/route"
import { AnthropicMessages } from "../../src/protocols/anthropic-messages"
import { BedrockConverse } from "../../src/protocols/bedrock-converse"
import { Gemini } from "../../src/protocols/gemini"
import { it } from "../lib/effect"
import { fixedResponse } from "../lib/http"
import { sseEvents } from "../lib/sse"

const codec = new EventStreamCodec(toUtf8, fromUtf8)
const encoder = new TextEncoder()
const bedrockBody = (events: readonly (readonly [string, object])[]) =>
  new Blob(
    events.map(([type, payload]) =>
      Uint8Array.from(
        codec.encode({
          headers: {
            ":message-type": { type: "string", value: "event" },
            ":event-type": { type: "string", value: type },
            ":content-type": { type: "string", value: "application/json" },
          },
          body: encoder.encode(JSON.stringify(payload)),
        }),
      ),
    ),
  )

const anthropic = AnthropicMessages.route
  .with({ endpoint: { baseURL: "https://anthropic.test/" }, auth: Auth.none })
  .model({ id: "claude-test" })
const gemini = Gemini.route
  .with({ endpoint: { baseURL: "https://gemini.test/" }, auth: Auth.none })
  .model({ id: "gemini-test" })
const bedrock = BedrockConverse.route
  .with({ endpoint: { baseURL: "https://bedrock.test/" }, auth: Auth.bearer("fixture") })
  .model({ id: "claude-test" })

describe("native provider stream completion", () => {
  it.effect("Anthropic preserves a terminal provider error without replacing it with EOF recovery", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(LLM.request({ model: anthropic, prompt: "Continue" })).pipe(
        Effect.provide(
          fixedResponse(sseEvents({ type: "error", error: { type: "authentication_error", message: "Denied" } })),
        ),
      )
      expect(response.events).toEqual([{ type: "provider-error", message: "authentication_error: Denied" }])
    }),
  )

  it.effect("Bedrock preserves throttling error without an additional EOF error", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(LLM.request({ model: bedrock, prompt: "Continue" })).pipe(
        Effect.provide(
          fixedResponse(bedrockBody([["throttlingException", { message: "Throttled" }]]), {
            headers: { "content-type": "application/vnd.amazon.eventstream" },
          }),
        ),
      )
      expect(response.events.filter((event) => event.type === "provider-error")).toEqual([
        expect.objectContaining({ message: "Throttled", retryable: true }),
      ])
    }),
  )

  it.effect("Bedrock retains usage arriving before a real messageStop", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(LLM.request({ model: bedrock, prompt: "Continue" })).pipe(
        Effect.provide(
          fixedResponse(
            bedrockBody([
              ["contentBlockDelta", { contentBlockIndex: 0, delta: { text: "Complete" } }],
              ["metadata", { usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } }],
              ["messageStop", { stopReason: "end_turn" }],
            ]),
            { headers: { "content-type": "application/vnd.amazon.eventstream" } },
          ),
        ),
      )
      expect(response.text).toBe("Complete")
      expect(response.usage).toMatchObject({ inputTokens: 1, outputTokens: 2, totalTokens: 3 })
      expect(response.events.some((event) => event.type === "provider-error")).toBe(false)
      expect(response.events.filter((event) => event.type === "finish")).toHaveLength(1)
    }),
  )

  for (const fixture of [
    { name: "empty", events: [] },
    {
      name: "partial text",
      events: [{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Partial" } }],
    },
    { name: "usage without stop reason", events: [{ type: "message_delta", usage: { output_tokens: 3 } }] },
  ]) {
    it.effect(`Anthropic EOF rejects ${fixture.name} without a stop reason`, () =>
      Effect.gen(function* () {
        const response = yield* LLMClient.generate(LLM.request({ model: anthropic, prompt: "Continue" })).pipe(
          Effect.provide(fixedResponse(sseEvents(...fixture.events))),
        )
        expect(response.events.filter((event) => event.type === "provider-error")).toEqual([
          expect.objectContaining({ type: "provider-error", retryable: true }),
        ])
        expect(response.events.some((event) => event.type === "finish")).toBe(false)
      }),
    )
  }

  for (const fixture of [
    { name: "empty", events: [] },
    { name: "partial text", events: [{ candidates: [{ content: { role: "model", parts: [{ text: "Partial" }] } }] }] },
    {
      name: "usage without finish reason",
      events: [{ usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 } }],
    },
  ]) {
    it.effect(`Gemini EOF rejects ${fixture.name} without a finish reason`, () =>
      Effect.gen(function* () {
        const response = yield* LLMClient.generate(LLM.request({ model: gemini, prompt: "Continue" })).pipe(
          Effect.provide(fixedResponse(sseEvents(...fixture.events))),
        )
        expect(response.events.filter((event) => event.type === "provider-error")).toEqual([
          expect.objectContaining({ type: "provider-error", retryable: true }),
        ])
        expect(response.events.some((event) => event.type === "finish")).toBe(false)
      }),
    )
  }

  for (const fixture of [
    { name: "empty", events: [] },
    { name: "partial text", events: [["contentBlockDelta", { contentBlockIndex: 0, delta: { text: "Partial" } }]] },
    {
      name: "metadata without messageStop",
      events: [["metadata", { usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } }]],
    },
  ] satisfies { name: string; events: [string, object][] }[]) {
    it.effect(`Bedrock EOF rejects ${fixture.name}`, () =>
      Effect.gen(function* () {
        const response = yield* LLMClient.generate(LLM.request({ model: bedrock, prompt: "Continue" })).pipe(
          Effect.provide(
            fixedResponse(bedrockBody(fixture.events), {
              headers: { "content-type": "application/vnd.amazon.eventstream" },
            }),
          ),
        )
        expect(response.events.filter((event) => event.type === "provider-error")).toEqual([
          expect.objectContaining({ type: "provider-error", retryable: true }),
        ])
        expect(response.events.some((event) => event.type === "finish")).toBe(false)
      }),
    )
  }
})
