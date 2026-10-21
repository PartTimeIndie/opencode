import { describe, expect } from "bun:test"
import { Effect, JsonSchema, Schema } from "effect"
import { HttpClientRequest } from "effect/unstable/http"
import { LLM, Message, ToolCallPart } from "../../src"
import { Auth, LLMClient } from "../../src/route"
import * as OpenAICompatible from "../../src/providers/openai-compatible"
import * as OpenAICompatibleChat from "../../src/protocols/openai-compatible-chat"
import type { OpenAIChatBody } from "../../src/protocols/openai-chat"
import { openAiToolInputSchema } from "../../src/protocols/shared"
import { it } from "../lib/effect"
import { dynamicResponse, fixedResponse } from "../lib/http"
import { sseEvents } from "../lib/sse"

const Json = Schema.fromJsonString(Schema.Unknown)
const decodeJson = Schema.decodeUnknownSync(Json)

const model = OpenAICompatibleChat.route
  .with({
    provider: "deepseek",
    endpoint: { baseURL: "https://api.deepseek.test/v1/", query: { "api-version": "2026-01-01" } },
    auth: Auth.bearer("test-key"),
  })
  .model({ id: "deepseek-chat" })

const request = LLM.request({
  id: "req_1",
  model,
  system: "You are concise.",
  prompt: "Say hello.",
  generation: { maxTokens: 20, temperature: 0 },
})

const prepareToolSchema = (inputSchema: JsonSchema.JsonSchema) =>
  LLMClient.prepare<OpenAIChatBody>(
    LLM.updateRequest(request, {
      tools: [{ name: "question", description: "Ask a question", inputSchema }],
    }),
  )

const deltaChunk = (delta: object, finishReason: string | null = null) => ({
  id: "chatcmpl_fixture",
  choices: [{ delta, finish_reason: finishReason }],
  usage: null,
})

const usageChunk = (usage: object) => ({
  id: "chatcmpl_fixture",
  choices: [],
  usage,
})

const providerFamilies = [
  ["baseten", OpenAICompatible.baseten, "https://inference.baseten.co/v1"],
  ["cerebras", OpenAICompatible.cerebras, "https://api.cerebras.ai/v1"],
  ["deepinfra", OpenAICompatible.deepinfra, "https://api.deepinfra.com/v1/openai"],
  ["deepseek", OpenAICompatible.deepseek, "https://api.deepseek.com/v1"],
  ["fireworks", OpenAICompatible.fireworks, "https://api.fireworks.ai/inference/v1"],
  ["togetherai", OpenAICompatible.togetherai, "https://api.together.xyz/v1"],
] as const

describe("OpenAI-compatible Chat route", () => {
  it.effect("prepares generic Chat target", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIChatBody>(
        LLM.updateRequest(request, {
          tools: [{ name: "lookup", description: "Lookup data", inputSchema: { type: "object" } }],
          toolChoice: { type: "required" },
        }),
      )

      expect(prepared.route).toBe("openai-compatible-chat")
      expect(prepared.model).toMatchObject({
        id: "deepseek-chat",
        provider: "deepseek",
        route: { id: "openai-compatible-chat" },
      })
      expect(prepared.model.route.endpoint).toMatchObject({
        baseURL: "https://api.deepseek.test/v1/",
        query: { "api-version": "2026-01-01" },
      })
      expect(prepared.body).toEqual({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: "You are concise." },
          { role: "user", content: "Say hello." },
        ],
        tools: [
          {
            type: "function",
            function: { name: "lookup", description: "Lookup data", parameters: { type: "object" } },
          },
        ],
        tool_choice: "required",
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 20,
        temperature: 0,
      })
    }),
  )

  it.effect("dereferences local top-level tool schema refs", () =>
    Effect.gen(function* () {
      const prepared = yield* prepareToolSchema({
        $ref: "#/$defs/ToolInput",
        $defs: {
          ToolInput: {
            type: "object",
            properties: {
              questions: { type: "array", items: { $ref: "#/$defs/Question" } },
            },
            required: ["questions"],
            additionalProperties: false,
          },
          Question: {
            type: "object",
            properties: { question: { type: "string" } },
            required: ["question"],
            additionalProperties: false,
          },
        },
      })

      expect(prepared.body.tools?.[0]?.function.parameters).toMatchObject({
        type: "object",
        properties: {
          questions: { type: "array", items: { $ref: "#/$defs/Question" } },
        },
        required: ["questions"],
        additionalProperties: false,
        $defs: {
          Question: {
            type: "object",
            properties: { question: { type: "string" } },
            required: ["question"],
            additionalProperties: false,
          },
        },
      })
      expect(prepared.body.tools?.[0]?.function.parameters).not.toHaveProperty("$ref")
    }),
  )

  it.effect("preserves structural siblings on local root refs", () =>
    Effect.gen(function* () {
      const prepared = yield* prepareToolSchema({
        $ref: "#/$defs/ToolInput",
        properties: { own: { type: "string" } },
        required: ["own"],
        $defs: {
          ToolInput: {
            type: "object",
            properties: { questions: { type: "array" } },
            required: ["questions"],
            additionalProperties: false,
          },
        },
      })

      expect(prepared.body.tools?.[0]?.function.parameters).toMatchObject({
        $ref: "#/$defs/ToolInput",
        type: "object",
        properties: { own: { type: "string" } },
        required: ["own"],
      })
      expect(prepared.body.tools?.[0]?.function.parameters).not.toHaveProperty("properties.questions")
    }),
  )

  it.effect("does not resolve inherited root definitions", () =>
    Effect.gen(function* () {
      const prepared = yield* prepareToolSchema({ $ref: "#/$defs/__proto__", $defs: {} })

      expect(prepared.body.tools?.[0]?.function.parameters).toEqual({
        $ref: "#/$defs/__proto__",
        $defs: {},
        type: "object",
      })
    }),
  )

  it.effect("does not dereference an inherited root ref", () =>
    Effect.gen(function* () {
      const schema = Object.assign(Object.create({ $ref: "#/$defs/ToolInput" }), {
        $defs: {
          ToolInput: {
            type: "object",
            properties: { inherited: { type: "string" } },
          },
        },
      })
      const parameters = openAiToolInputSchema(schema)

      expect(parameters).toMatchObject({
        $ref: "#/$defs/ToolInput",
        type: "object",
      })
      expect(parameters).not.toHaveProperty("properties.inherited")
    }),
  )

  it.effect("does not dereference inherited root defs", () =>
    Effect.gen(function* () {
      const schema = Object.assign(
        Object.create({
          $defs: {
            ToolInput: {
              type: "object",
              properties: { inherited: { type: "string" } },
            },
          },
        }),
        { $ref: "#/$defs/ToolInput" },
      )
      const parameters = openAiToolInputSchema(schema)

      expect(parameters).toMatchObject({
        $ref: "#/$defs/ToolInput",
        type: "object",
      })
      expect(parameters).not.toHaveProperty("properties.inherited")
    }),
  )

  it.effect("provides model helpers for compatible provider families", () =>
    Effect.gen(function* () {
      expect(
        providerFamilies.map(([provider, family]) => {
          const model = family.configure({ apiKey: "test-key" }).model(`${provider}-model`)
          return {
            id: String(model.id),
            provider: String(model.provider),
            route: model.route.id,
            baseURL: model.route.endpoint.baseURL,
          }
        }),
      ).toEqual(
        providerFamilies.map(([provider, _, baseURL]) => ({
          id: `${provider}-model`,
          provider,
          route: "openai-compatible-chat",
          baseURL,
        })),
      )

      const custom = OpenAICompatible.deepseek
        .configure({
          apiKey: "test-key",
          baseURL: "https://custom.deepseek.test/v1",
        })
        .model("deepseek-chat")
      expect(custom).toMatchObject({
        provider: "deepseek",
        route: { id: "openai-compatible-chat" },
      })
      expect(custom.route.endpoint.baseURL).toBe("https://custom.deepseek.test/v1")
    }),
  )

  it.effect("uses Cerebras-supported reasoning fields and omits unsupported request options", () =>
    Effect.gen(function* () {
      const cerebrasModel = OpenAICompatible.cerebras.configure({ apiKey: "test-key" }).model("qwen-3.8-27b")
      const response = yield* LLMClient.generate(
        LLM.request({
          model: cerebrasModel,
          messages: [
            Message.assistant([
              { type: "reasoning", text: "Think through the problem." },
              { type: "text", text: "Previous answer." },
            ]),
            Message.user("Continue."),
          ],
          providerOptions: { openai: { reasoningEffort: "high", store: false } },
        }),
      ).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              const body = decodeJson(input.text)
              expect(body).toMatchObject({
                model: "qwen-3.8-27b",
                messages: [
                  { role: "assistant", content: "Previous answer.", reasoning: "Think through the problem." },
                  { role: "user", content: "Continue." },
                ],
                stream: true,
                reasoning_effort: "high",
              })
              expect(body).not.toHaveProperty("messages.0.reasoning_content")
              expect(body).not.toHaveProperty("stream_options")
              expect(body).not.toHaveProperty("store")
              return input.respond(sseEvents(deltaChunk({ content: "Done." }), deltaChunk({}, "stop")), {
                headers: { "content-type": "text/event-stream" },
              })
            }),
          ),
        ),
      )

      expect(response.text).toBe("Done.")
    }),
  )

  it.effect("parses Cerebras reasoning deltas", () =>
    Effect.gen(function* () {
      const cerebrasModel = OpenAICompatible.cerebras.configure({ apiKey: "test-key" }).model("qwen-3.8-27b")
      const response = yield* LLMClient.generate(LLM.request({ model: cerebrasModel, prompt: "Explain." })).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(deltaChunk({ reasoning: "Let me reason." }), deltaChunk({ content: "Here is the answer." }), deltaChunk({}, "stop")),
            { headers: { "content-type": "text/event-stream" } },
          ),
        ),
      )

      expect(response.reasoning).toBe("Let me reason.")
      expect(response.text).toBe("Here is the answer.")
    }),
  )

  it.effect("matches AI SDK compatible basic request body fixture", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(request)

      expect(prepared.body).toEqual({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: "You are concise." },
          { role: "user", content: "Say hello." },
        ],
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 20,
        temperature: 0,
      })
    }),
  )

  it.effect("matches AI SDK compatible tool request body fixture", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          id: "req_tool_parity",
          model,
          tools: [
            {
              name: "lookup",
              description: "Lookup data",
              inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
            },
          ],
          toolChoice: "lookup",
          messages: [
            Message.user("What is the weather?"),
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "lookup", input: { query: "weather" } })]),
            Message.tool({ id: "call_1", name: "lookup", result: { forecast: "sunny" } }),
          ],
        }),
      )

      expect(prepared.body).toEqual({
        model: "deepseek-chat",
        messages: [
          { role: "user", content: "What is the weather?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "lookup", arguments: '{"query":"weather"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: '{"forecast":"sunny"}' },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "lookup",
              description: "Lookup data",
              parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "lookup" } },
        stream: true,
        stream_options: { include_usage: true },
      })
    }),
  )

  it.effect("posts to the configured compatible endpoint and parses text usage", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
              expect(web.url).toBe("https://api.deepseek.test/v1/chat/completions?api-version=2026-01-01")
              expect(web.headers.get("authorization")).toBe("Bearer test-key")
              expect(decodeJson(input.text)).toMatchObject({
                model: "deepseek-chat",
                stream: true,
                messages: [
                  { role: "system", content: "You are concise." },
                  { role: "user", content: "Say hello." },
                ],
              })
              return input.respond(
                sseEvents(
                  deltaChunk({ role: "assistant", content: "Hello" }),
                  deltaChunk({ content: "!" }),
                  deltaChunk({}, "stop"),
                  usageChunk({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }),
                ),
                { headers: { "content-type": "text/event-stream" } },
              )
            }),
          ),
        ),
      )

      expect(response.text).toBe("Hello!")
      expect(response.usage).toMatchObject({ inputTokens: 5, outputTokens: 2, totalTokens: 7 })
      expect(response.events.at(-1)).toMatchObject({ type: "finish", reason: "stop" })
    }),
  )

  it.effect("rejects an empty stopped provider response as retryable", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(sseEvents(deltaChunk({}, "stop")), {
            headers: { "content-type": "text/event-stream" },
          }),
        ),
      )

      expect(response.events).toEqual([
        {
          type: "provider-error",
          message: "OpenAI Chat provider returned stop without assistant content or a tool call",
          retryable: true,
        },
      ])
    }),
  )

  it.effect("accepts Zhipu's explicit DONE marker when finish_reason is omitted", () =>
    Effect.gen(function* () {
      const zhipuModel = OpenAICompatibleChat.route
        .with({
          provider: "zhipuai-coding-plan",
          endpoint: { baseURL: "https://open.bigmodel.cn/api/paas/v4" },
          auth: Auth.bearer("test-key"),
        })
        .model({ id: "glm-5.2" })
      const body = sseEvents(
        {
          id: "glm_fixture",
          model: "glm-5.2",
          choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "check" }, finish_reason: null }],
          usage: null,
        },
        {
          id: "glm_fixture",
          model: "glm-5.2",
          choices: [{ index: 0, delta: { content: "Looks good." }, finish_reason: null }],
          usage: null,
        },
        {
          id: "glm_fixture",
          model: "glm-5.2",
          choices: [],
          usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
        },
      )
      const response = yield* LLMClient.generate(LLM.updateRequest(request, { model: zhipuModel })).pipe(
        Effect.provide(fixedResponse(body)),
      )

      expect(response.reasoning).toBe("check")
      expect(response.text).toBe("Looks good.")
      expect(response.usage).toMatchObject({ inputTokens: 12, outputTokens: 4, totalTokens: 16 })
      expect(response.events.at(-1)).toMatchObject({ type: "finish", reason: "stop" })
      expect(response.events).not.toContainEqual({
        type: "provider-error",
        message: "OpenAI Chat stream ended without a finish reason",
      })
    }),
  )
})
