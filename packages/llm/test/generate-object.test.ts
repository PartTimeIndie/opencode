import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { LLM, LLMError, ToolDefinition } from "../src"
import * as OpenAIChat from "../src/protocols/openai-chat"
import { Gemini, OpenAIResponses } from "../src/protocols"
import { Auth } from "../src/route"
import { Tool, toDefinitions } from "../src/tool"
import { it } from "./lib/effect"
import { dynamicResponse } from "./lib/http"
import { finishChunk, toolCallChunk, usageChunk } from "./lib/openai-chunks"
import { sseEvents } from "./lib/sse"

type OpenAIChatBody = {
  readonly tool_choice?: unknown
  readonly tools?: ReadonlyArray<{
    readonly function: {
      readonly parameters: unknown
    }
  }>
}

const model = OpenAIChat.route
  .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
  .model({ id: "gpt-4o-mini" })

const Json = Schema.fromJsonString(Schema.Unknown)
const decodeJson = Schema.decodeUnknownSync(Json)
const decodeBody = (text: string): OpenAIChatBody => decodeJson(text) as OpenAIChatBody

describe("Tool.make (dynamic JSON Schema)", () => {
  test("forwards JSON Schema and description through toDefinitions", () => {
    const jsonSchema = {
      type: "object" as const,
      properties: { city: { type: "string" } },
      required: ["city"],
    }
    const lookup = Tool.make({
      description: "Look up something",
      jsonSchema,
      execute: () => Effect.succeed({ ok: true }),
    })
    const [definition] = toDefinitions({ lookup })
    expect(definition?.name).toBe("lookup")
    expect(definition?.description).toBe("Look up something")
    expect(definition?.inputSchema).toEqual(jsonSchema)
  })

  test("execute receives the raw input untouched", async () => {
    const seen: unknown[] = []
    const tool = Tool.make({
      description: "echo",
      jsonSchema: { type: "object" },
      execute: (params) =>
        Effect.sync(() => {
          seen.push(params)
          return { ok: true }
        }),
    })
    const result = await Effect.runPromise(tool.execute({ hello: "world" }))
    expect(seen).toEqual([{ hello: "world" }])
    expect(result).toEqual({ ok: true })
  })
})

describe("LLM.generateObject", () => {
  for (const fixture of [
    {
      route: OpenAIResponses.route,
      response: (text: string) => sseEvents(
        { type: "response.output_text.delta", item_id: "answer", delta: text },
        { type: "response.completed", response: { id: "fixture", status: "completed", output: [] } },
      ),
      format: { text: { format: { type: "json_schema", strict: false } } },
    },
    {
      route: Gemini.route,
      response: (text: string) => sseEvents({ candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }] }),
      format: { generationConfig: { responseMimeType: "application/json" } },
    },
  ]) {
    for (const retryCount of [0, 1]) {
      it.effect(`validates and bounds native ${fixture.route.id} corrections with retryCount=${retryCount}`, () =>
        Effect.gen(function* () {
          const bodies: Array<unknown> = []
          const layer = dynamicResponse((input) => Effect.sync(() => {
            bodies.push(decodeJson(input.text))
            return input.respond(fixture.response(bodies.length === 1 ? '{"age":"bad"}' : '{"age":30}'),
              { headers: { "content-type": "text/event-stream" } })
          }))
          const exit = yield* LLM.generateObject({
            model: fixture.route.with({ auth: Auth.bearer("test") }).model({ id: "fixture" }),
            retryCount, prompt: "Return age", jsonSchema: { type: "object", properties: { age: { type: "number" } }, required: ["age"] },
          }).pipe(Effect.provide(layer), Effect.exit)
          expect(exit._tag).toBe(retryCount === 0 ? "Failure" : "Success")
          expect(bodies).toHaveLength(retryCount === 0 ? 1 : 2)
          expect(bodies[0]).toMatchObject(fixture.format)
          if (exit._tag === "Success") expect(exit.value.object).toEqual({ age: 30 })
        }),
      )
    }
  }

  for (const first of ['{"age":"bad"}', "", "not JSON", '{"age":30}{"age":31}']) {
    it.effect("uses native direct JSON, validates it and keeps the schema unchanged during correction", () =>
      Effect.gen(function* () {
        const bodies: Array<Record<string, unknown>> = []
        const schema = {
          type: "object" as const, properties: { age: { type: "number" } },
          required: ["age"], additionalProperties: false,
        }
        const layer = dynamicResponse((input) => Effect.sync(() => {
          bodies.push(decodeJson(input.text) as Record<string, unknown>)
          return input.respond(sseEvents({ id: "native", choices: [{
            delta: { content: bodies.length === 1 ? first : '{"age":30}' }, finish_reason: "stop",
          }] }), { headers: { "content-type": "text/event-stream" } })
        }))
        const result = yield* LLM.generateObject({
          model: OpenAIChat.route.with({ auth: Auth.bearer("test") }).model({ id: "gpt-4o-mini" }),
          prompt: "Return age", jsonSchema: schema,
        }).pipe(Effect.provide(layer))
        expect(result.object).toEqual({ age: 30 })
        expect(bodies).toHaveLength(2)
        expect(bodies[0]?.response_format).toEqual({
          type: "json_schema", json_schema: { name: "structured_output", schema, strict: true },
        })
        expect(bodies[1]?.response_format).toEqual(bodies[0]?.response_format)
        expect(bodies[0]?.tools).toBeUndefined()
        expect(bodies[1]?.tools).toBeUndefined()
        expect(result.responses).toHaveLength(2)
      }),
    )
  }

  for (const first of [
    sseEvents(finishChunk("stop")),
    sseEvents(toolCallChunk("bad", "generate_object", '{"age":"thirty"}'), finishChunk("tool_calls")),
  ]) {
    it.effect("corrects a missing or invalid result exactly once with the same transport contract", () =>
      Effect.gen(function* () {
        const bodies: OpenAIChatBody[] = []
        const layer = dynamicResponse((input) => Effect.sync(() => {
          bodies.push(decodeBody(input.text))
          return input.respond(bodies.length === 1 ? first : sseEvents(
            toolCallChunk("good", "generate_object", '{"age":30}'), finishChunk("tool_calls"),
          ), { headers: { "content-type": "text/event-stream" } })
        }))
        const result = yield* LLM.generateObject({
          model, prompt: "Extract age", jsonSchema: { type: "object", properties: { age: { type: "number" } }, required: ["age"] },
        }).pipe(Effect.provide(layer))
        expect(result.object).toEqual({ age: 30 })
        expect(bodies).toHaveLength(2)
        expect(bodies[1]?.tools).toEqual(bodies[0]?.tools)
        expect(bodies[1]?.tool_choice).toEqual(bodies[0]?.tool_choice)
        expect(result.responses).toHaveLength(2)
      }),
    )
  }

  for (const retryCount of [0, 1, 5]) {
    it.effect(`bounds correction requests for retryCount=${retryCount}`, () =>
      Effect.gen(function* () {
        const bodies: string[] = []
        const layer = dynamicResponse((input) => Effect.sync(() => {
          bodies.push(input.text)
          return input.respond(sseEvents(finishChunk("stop")), { headers: { "content-type": "text/event-stream" } })
        }))
        const exit = yield* LLM.generateObject({
          model, retryCount, prompt: "Extract age", schema: Schema.Struct({ age: Schema.Number }),
        }).pipe(Effect.provide(layer), Effect.exit)
        expect(exit._tag).toBe("Failure")
        expect(bodies).toHaveLength(retryCount === 0 ? 1 : 2)
      }),
    )
  }

  it.effect("does not correct a provider refusal or an HTTP failure", () =>
    Effect.gen(function* () {
      for (const failure of [
        { status: 200, body: sseEvents(finishChunk("content_filter")) },
        { status: 403, body: '{"error":{"message":"fixture refusal"}}' },
      ]) {
        const bodies: string[] = []
        const layer = dynamicResponse((input) => Effect.sync(() => {
          bodies.push(input.text)
          return input.respond(failure.body, { status: failure.status, headers: { "content-type": "text/event-stream" } })
        }))
        const exit = yield* LLM.generateObject({ model, prompt: "Return age", schema: Schema.Struct({ age: Schema.Number }) })
          .pipe(Effect.provide(layer), Effect.exit)
        expect(exit._tag).toBe("Failure")
        expect(bodies).toHaveLength(1)
      }
    }),
  )

  it.effect("does not inherit default or configured HTTP retries into a format correction", () =>
    Effect.gen(function* () {
      for (const retries of [undefined, 4]) {
        const bodies: string[] = []
        const layer = dynamicResponse((input) => Effect.sync(() => {
          bodies.push(input.text)
          return bodies.length === 1
            ? input.respond(sseEvents(finishChunk("stop")), { headers: { "content-type": "text/event-stream" } })
            : input.respond('{"error":{"message":"fixture unavailable"}}', { status: 503, headers: { "retry-after": "0" } })
        }))
        const error = yield* LLM.generateObject({
          model, prompt: "Return age", schema: Schema.Struct({ age: Schema.Number }),
          ...(retries === undefined ? {} : { http: { retries } }),
        }).pipe(Effect.provide(layer), Effect.flip)
        expect(bodies).toHaveLength(2)
        expect(error).toMatchObject({ structuredOutputCorrectionAttempted: true, reason: { _tag: "ProviderInternal" } })
      }
    }),
  )

  for (const failure of ["authentication", "provider", "invalid"] as const) {
    it.effect(`marks consumed correction budget without hiding a ${failure} failure`, () =>
      Effect.gen(function* () {
        const bodies: string[] = []
        const layer = dynamicResponse((input) => Effect.sync(() => {
          bodies.push(input.text)
          if (bodies.length === 1 || failure === "invalid")
            return input.respond(sseEvents(finishChunk("stop")), { headers: { "content-type": "text/event-stream" } })
          return input.respond('{"error":{"message":"fixture unavailable"}}', {
            status: failure === "authentication" ? 403 : 503,
          })
        }))
        const error = yield* LLM.generateObject({
          model, prompt: "Return age", schema: Schema.Struct({ age: Schema.Number }), http: { retries: 0 },
        }).pipe(Effect.provide(layer), Effect.flip)
        expect(bodies).toHaveLength(2)
        expect(error).toMatchObject({ structuredOutputCorrectionAttempted: true })
        expect(error.reason._tag).toBe(failure === "invalid" ? "InvalidProviderOutput"
          : failure === "authentication" ? "Authentication" : "ProviderInternal")
        const decoded = Schema.decodeUnknownSync(Schema.fromJsonString(LLMError))(JSON.stringify(error))
        expect(decoded).toMatchObject({ structuredOutputCorrectionAttempted: true })
      }),
    )
  }

  it.effect("retains both responses and accounts for the usage of both requests", () =>
    Effect.gen(function* () {
      const bodies: string[] = []
      const layer = dynamicResponse((input) => Effect.sync(() => {
        bodies.push(input.text)
        return input.respond(sseEvents(
          toolCallChunk(`call_${bodies.length}`, "generate_object", bodies.length === 1 ? '{"age":"bad"}' : '{"age":30}'),
          finishChunk("tool_calls"), usageChunk({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }),
        ), { headers: { "content-type": "text/event-stream" } })
      }))
      const result = yield* LLM.generateObject({ model, prompt: "Return age", schema: Schema.Struct({ age: Schema.Number }) })
        .pipe(Effect.provide(layer))
      expect(result.responses[0]?.toolCalls[0]?.input).toEqual({ age: "bad" })
      expect(result.responses[1]?.toolCalls[0]?.input).toEqual({ age: 30 })
      expect(result.usage).toMatchObject({ inputTokens: 20, outputTokens: 10, totalTokens: 30 })
    }),
  )

  it.effect("does not accept a valid result alongside a malformed sibling result", () =>
    Effect.gen(function* () {
      const layer = dynamicResponse((input) => Effect.sync(() => input.respond(sseEvents(
        toolCallChunk("valid", "generate_object", '{"age":30}', 0),
        toolCallChunk("malformed", "generate_object", '{"age":', 1), finishChunk("tool_calls"),
      ), { headers: { "content-type": "text/event-stream" } })))
      const exit = yield* LLM.generateObject({ model, retryCount: 0, prompt: "Return age", schema: Schema.Struct({ age: Schema.Number }) })
        .pipe(Effect.provide(layer), Effect.exit)
      expect(exit._tag).toBe("Failure")
    }),
  )

  it.effect("corrects malformed JSON arguments once without executing the failed result", () =>
    Effect.gen(function* () {
      const bodies: string[] = []
      const layer = dynamicResponse((input) => Effect.sync(() => {
        bodies.push(input.text)
        return input.respond(sseEvents(toolCallChunk(`call_${bodies.length}`, "generate_object",
          bodies.length === 1 ? '{"age":' : '{"age":30}'), finishChunk("tool_calls")),
          { headers: { "content-type": "text/event-stream" } })
      }))
      const result = yield* LLM.generateObject({ model, prompt: "Return age", schema: Schema.Struct({ age: Schema.Number }) })
        .pipe(Effect.provide(layer))
      expect(result.object).toEqual({ age: 30 })
      expect(bodies).toHaveLength(2)
      expect(result.responses[0]?.events.some((event) => event.type === "tool-error")).toBe(true)
    }),
  )

  it.effect("does not accept duplicate result calls", () =>
    Effect.gen(function* () {
      const bodies: string[] = []
      const layer = dynamicResponse((input) => Effect.sync(() => {
        bodies.push(input.text)
        return input.respond(sseEvents(
          toolCallChunk("one", "generate_object", '{"age":30}', 0),
          toolCallChunk("two", "generate_object", '{"age":31}', 1), finishChunk("tool_calls"),
        ), { headers: { "content-type": "text/event-stream" } })
      }))
      const exit = yield* LLM.generateObject({ model, retryCount: 0, prompt: "Return age", schema: Schema.Struct({ age: Schema.Number }) })
        .pipe(Effect.provide(layer), Effect.exit)
      expect(exit._tag).toBe("Failure")
      expect(bodies).toHaveLength(1)
    }),
  )

  it.effect("validates typed inputs before a decoder can silently remove extra fields", () =>
    Effect.gen(function* () {
      const layer = dynamicResponse((input) => Effect.sync(() => input.respond(sseEvents(
        toolCallChunk("one", "generate_object", '{"age":30,"extra":"must not disappear"}'), finishChunk("tool_calls"),
      ), { headers: { "content-type": "text/event-stream" } })))
      const exit = yield* LLM.generateObject({ model, retryCount: 0, prompt: "Return age", schema: Schema.Struct({ age: Schema.Number }) })
        .pipe(Effect.provide(layer), Effect.exit)
      expect(exit._tag).toBe("Failure")
    }),
  )

  it.effect("delivers a low-level tool response contract to the native HTTP body", () =>
    Effect.gen(function* () {
      const bodies: OpenAIChatBody[] = []
      const layer = dynamicResponse((input) => Effect.sync(() => {
        bodies.push(decodeBody(input.text))
        return input.respond(sseEvents(finishChunk("stop")), { headers: { "content-type": "text/event-stream" } })
      }))
      const tool = ToolDefinition.make({ name: "answer", description: "Return answer", inputSchema: { type: "object" } })
      yield* LLM.generate(LLM.request({ model, prompt: "Return answer", responseFormat: { type: "tool", tool } }))
        .pipe(Effect.provide(layer))
      expect(bodies[0]?.tool_choice).toEqual({ type: "function", function: { name: "answer" } })
      expect(bodies[0]?.tools?.[0]?.function.parameters).toEqual(tool.inputSchema)
    }),
  )

  it.effect("forces a synthetic tool call and decodes the input", () =>
    Effect.gen(function* () {
      const bodies: OpenAIChatBody[] = []
      const layer = dynamicResponse((input) =>
        Effect.sync(() => {
          bodies.push(decodeBody(input.text))
          return input.respond(
            sseEvents(
              toolCallChunk("call_1", "generate_object", '{"city":"Paris","temp":22}'),
              finishChunk("tool_calls"),
            ),
            { headers: { "content-type": "text/event-stream" } },
          )
        }),
      )

      const response = yield* LLM.generateObject({
        model,
        prompt: "Return a structured weather report.",
        schema: Schema.Struct({ city: Schema.String, temp: Schema.Number }),
      }).pipe(Effect.provide(layer))

      expect(response.object).toEqual({ city: "Paris", temp: 22 })
      expect(response.response.toolCalls).toHaveLength(1)
      expect(bodies).toHaveLength(1)
      expect(bodies[0].tool_choice).toEqual({ type: "function", function: { name: "generate_object" } })
      const tool = bodies[0].tools?.[0]
      expect(bodies[0].tools).toHaveLength(1)
      expect(tool).toMatchObject({
        type: "function",
        function: { name: "generate_object" },
      })
      const params = tool?.function.parameters as {
        readonly type?: unknown
        readonly required?: unknown
        readonly properties?: Record<string, unknown>
      }
      expect(params.type).toBe("object")
      expect(params.required).toEqual(["city", "temp"])
      expect(params.properties?.city).toMatchObject({ type: "string" })
      expect(params.properties?.temp).toBeDefined()
    }),
  )

  it.effect("accepts a raw JSON Schema and returns the input untouched", () =>
    Effect.gen(function* () {
      const bodies: OpenAIChatBody[] = []
      const layer = dynamicResponse((input) =>
        Effect.sync(() => {
          bodies.push(decodeBody(input.text))
          return input.respond(
            sseEvents(toolCallChunk("call_1", "generate_object", '{"name":"Ada","age":30}'), finishChunk("tool_calls")),
            { headers: { "content-type": "text/event-stream" } },
          )
        }),
      )

      const response = yield* LLM.generateObject({
        model,
        prompt: "Extract the user.",
        jsonSchema: {
          type: "object",
          properties: { name: { type: "string" }, age: { type: "number" } },
          required: ["name", "age"],
        },
      }).pipe(Effect.provide(layer))

      expect(response.object).toEqual({ name: "Ada", age: 30 })
      expect(bodies[0].tools?.[0]?.function.parameters).toEqual({
        type: "object",
        properties: { name: { type: "string" }, age: { type: "number" } },
        required: ["name", "age"],
      })
    }),
  )

  it.effect("rejects a dynamic result that violates its original JSON Schema", () =>
    Effect.gen(function* () {
      const layer = dynamicResponse((input) =>
        Effect.sync(() =>
          input.respond(
            sseEvents(toolCallChunk("call_invalid", "generate_object", '{"age":"thirty"}'), finishChunk("tool_calls")),
            { headers: { "content-type": "text/event-stream" } },
          ),
        ),
      )
      const exit = yield* LLM.generateObject({
        model,
        prompt: "Extract the age.",
        jsonSchema: { type: "object", properties: { age: { type: "number" } }, required: ["age"] },
      }).pipe(Effect.provide(layer), Effect.exit)
      expect(exit._tag).toBe("Failure")
    }),
  )

  it.effect("refuses unsupported schema constraints before sending a provider request", () =>
    Effect.gen(function* () {
      const bodies: string[] = []
      const layer = dynamicResponse((input) => Effect.sync(() => {
        bodies.push(input.text)
        return input.respond(sseEvents(finishChunk("stop")), { headers: { "content-type": "text/event-stream" } })
      }))
      const exit = yield* LLM.generateObject({
        model,
        prompt: "Return a value.",
        jsonSchema: { type: "object", not: { type: "null" } },
      }).pipe(Effect.provide(layer), Effect.exit)
      expect(exit._tag).toBe("Failure")
      expect(bodies).toHaveLength(0)
    }),
  )

  it.effect("validates required properties without changing a frozen input schema", () =>
    Effect.gen(function* () {
      const bodies: OpenAIChatBody[] = []
      const layer = dynamicResponse((input) => Effect.sync(() => {
        bodies.push(decodeBody(input.text))
        return input.respond(
          sseEvents(toolCallChunk("call_closed", "generate_object", '{"blocked":1}'), finishChunk("tool_calls")),
          { headers: { "content-type": "text/event-stream" } },
        )
      }))
      const schema = Object.freeze({
        type: "object" as const,
        properties: Object.freeze({}),
        required: ["blocked"],
        additionalProperties: false,
      })
      const exit = yield* LLM.generateObject({ model, prompt: "Return an object", jsonSchema: schema })
        .pipe(Effect.provide(layer), Effect.exit)
      expect(exit._tag).toBe("Failure")
      expect(schema.properties).toEqual({})
      expect(bodies[0]?.tools?.[0]?.function.parameters).toEqual(schema)
    }),
  )

  it.effect("fails when the model does not call the synthetic tool", () =>
    Effect.gen(function* () {
      const layer = dynamicResponse((input) =>
        Effect.sync(() =>
          input.respond(sseEvents({ id: "x", choices: [{ delta: { content: "no thanks" }, finish_reason: "stop" }] }), {
            headers: { "content-type": "text/event-stream" },
          }),
        ),
      )

      const exit = yield* LLM.generateObject({
        model,
        prompt: "Return a structured value.",
        schema: Schema.Struct({ value: Schema.Number }),
      }).pipe(Effect.provide(layer), Effect.exit)

      expect(exit._tag).toBe("Failure")
    }),
  )

  it.effect("fails with a decode error when the tool input does not match the schema", () =>
    Effect.gen(function* () {
      const layer = dynamicResponse((input) =>
        Effect.sync(() =>
          input.respond(
            sseEvents(
              toolCallChunk("call_1", "generate_object", '{"value":"not-a-number"}'),
              finishChunk("tool_calls"),
            ),
            { headers: { "content-type": "text/event-stream" } },
          ),
        ),
      )

      const exit = yield* LLM.generateObject({
        model,
        prompt: "Return a structured value.",
        schema: Schema.Struct({ value: Schema.Number }),
      }).pipe(Effect.provide(layer), Effect.exit)

      expect(exit._tag).toBe("Failure")
    }),
  )
})
