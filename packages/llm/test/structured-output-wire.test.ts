import { expect } from "bun:test"
import { Effect, Schema } from "effect"
import { LLM, ToolDefinition } from "../src"
import { AnthropicMessages, BedrockConverse, Gemini, OpenAIChat, OpenAIResponses } from "../src/protocols"
import { Auth } from "../src/route"
import { it } from "./lib/effect"
import { dynamicResponse } from "./lib/http"
import { finishChunk } from "./lib/openai-chunks"
import { sseEvents } from "./lib/sse"

const schema = {
  type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false,
}
const decode = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)

for (const fixture of [
  {
    route: OpenAIChat.route,
    finish: sseEvents(finishChunk("stop")),
    body: { response_format: { type: "json_schema", json_schema: { name: "structured_output", schema, strict: true } } },
  },
  {
    route: OpenAIResponses.route,
    finish: sseEvents({ type: "response.completed", response: { id: "fixture", status: "completed", output: [] } }),
    body: { text: { format: { type: "json_schema", name: "structured_output", schema, strict: true } } },
  },
  {
    route: Gemini.route,
    finish: sseEvents({ candidates: [{ content: { role: "model", parts: [{ text: "{}" }] }, finishReason: "STOP" }] }),
    body: { generationConfig: { responseMimeType: "application/json", responseJsonSchema: schema } },
  },
]) {
  it.effect(`preserves the JSON schema in the serialized ${fixture.route.id} request`, () =>
    Effect.gen(function* () {
      const bodies: unknown[] = []
      const layer = dynamicResponse((input) => Effect.sync(() => {
        bodies.push(decode(input.text))
        return input.respond(fixture.finish, { headers: { "content-type": "text/event-stream" } })
      }))
      const model = fixture.route.with({ auth: Auth.bearer("fixture") }).model({ id: "fixture" })
      yield* LLM.generate(LLM.request({ model, prompt: "Return JSON", responseFormat: { type: "json", schema } }))
        .pipe(Effect.provide(layer))
      expect(bodies).toHaveLength(1)
      expect(bodies[0]).toMatchObject(fixture.body)
    }),
  )
}

for (const route of [AnthropicMessages.route, BedrockConverse.route]) {
  it.effect(`rejects unsupported native JSON on ${route.id} before HTTP`, () =>
    Effect.gen(function* () {
      const bodies: string[] = []
      const layer = dynamicResponse((input) => Effect.sync(() => {
        bodies.push(input.text)
        return input.respond("")
      }))
      const model = route.with({ auth: Auth.none, endpoint: { baseURL: "https://provider.test/" } }).model({ id: "fixture" })
      const exit = yield* LLM.generate(LLM.request({
        model, prompt: "Return JSON", responseFormat: { type: "json", schema },
      })).pipe(Effect.provide(layer), Effect.exit)
      expect(exit._tag).toBe("Failure")
      expect(bodies).toHaveLength(0)
    }),
  )
}

for (const body of [
  { response_format: { type: "text" } },
  { text: { format: { type: "text" } } },
  { generationConfig: { responseMimeType: "text/plain" } },
  { tools: [] },
]) {
  it.effect("rejects an HTTP overlay that replaces the structured contract before HTTP", () =>
    Effect.gen(function* () {
      const bodies: string[] = []
      const layer = dynamicResponse((input) => Effect.sync(() => {
        bodies.push(input.text)
        return input.respond(sseEvents(finishChunk("stop")), { headers: { "content-type": "text/event-stream" } })
      }))
      const model = OpenAIChat.route.with({ auth: Auth.none }).model({ id: "fixture" })
      const exit = yield* LLM.generate(LLM.request({
        model, prompt: "Return JSON", responseFormat: { type: "json", schema }, http: { body },
      })).pipe(Effect.provide(layer), Effect.exit)
      expect(exit._tag).toBe("Failure")
      expect(bodies).toHaveLength(0)
    }),
  )
}

it.effect("rejects unsupported native schema semantics before HTTP", () =>
  Effect.gen(function* () {
    const bodies: string[] = []
    const layer = dynamicResponse((input) => Effect.sync(() => {
      bodies.push(input.text)
      return input.respond(sseEvents(finishChunk("stop")), { headers: { "content-type": "text/event-stream" } })
    }))
    const model = OpenAIChat.route.with({ auth: Auth.none }).model({ id: "fixture" })
    const exit = yield* LLM.generate(LLM.request({
      model, prompt: "Return JSON", responseFormat: { type: "json", schema: { type: "object", not: {} } },
    })).pipe(Effect.provide(layer), Effect.exit)
    expect(exit._tag).toBe("Failure")
    expect(bodies).toHaveLength(0)
  }),
)

it.effect("keeps the known auto-only Responses deployment usable with local result validation", () =>
  Effect.gen(function* () {
    const bodies: unknown[] = []
    const layer = dynamicResponse((input) => Effect.sync(() => {
      bodies.push(decode(input.text))
      return input.respond(sseEvents({ type: "response.completed", response: { id: "fixture", status: "completed", output: [] } }),
        { headers: { "content-type": "text/event-stream" } })
    }))
    const model = OpenAIResponses.route.with({ provider: "opencode-go", auth: Auth.none }).model({ id: "fixture" })
    const tool = ToolDefinition.make({ name: "answer", description: "Return answer", inputSchema: schema })
    yield* LLM.generate(LLM.request({ model, prompt: "Return JSON", responseFormat: { type: "tool", tool } }))
      .pipe(Effect.provide(layer))
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({ tool_choice: "auto", tools: [{ name: "answer", parameters: schema }] })
  }),
)
