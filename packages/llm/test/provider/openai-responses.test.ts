import { describe, expect } from "bun:test"
import { ConfigProvider, Effect, Fiber, Layer, Stream } from "effect"
import { Headers, HttpClientRequest } from "effect/unstable/http"
import { LLM, LLMError, Message, Model, ToolCallPart, Usage } from "../../src"
import { normalizeModelInput } from "../../src/schema/options"
import { Auth, LLMClient, RequestExecutor, WebSocketExecutor } from "../../src/route"
import * as Azure from "../../src/providers/azure"
import * as OpenAI from "../../src/providers/openai"
import * as OpenAIResponses from "../../src/protocols/openai-responses"
import * as ProviderShared from "../../src/protocols/shared"
import { continuationRequest, nativeOpenAIResponsesContinuation } from "../continuation-scenarios"
import { it } from "../lib/effect"
import { dynamicResponse, fixedResponse } from "../lib/http"
import { sseEvents } from "../lib/sse"

const model = OpenAIResponses.route
  .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
  .model({ id: "gpt-4.1-mini" })

const request = LLM.request({
  id: "req_1",
  model,
  system: "You are concise.",
  prompt: "Say hello.",
  generation: { maxTokens: 20, temperature: 0 },
})

const configEnv = (env: Record<string, string>) => Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })))

type OpenAIToolOutput = Extract<
  OpenAIResponses.OpenAIResponsesBody["input"][number],
  { readonly type: "function_call_output" }
>

const expectToolOutput = (body: OpenAIResponses.OpenAIResponsesBody): OpenAIToolOutput => {
  const output = body.input.find(
    (item): item is OpenAIToolOutput => "type" in item && item.type === "function_call_output",
  )
  expect(output).toBeDefined()
  return output!
}

describe("OpenAI Responses route", () => {
  for (const codex of [false, true]) {
    for (const affinity of [undefined, "ocf_shared_family"]) {
      it.effect(`maps explicit cache affinity to Codex session-id only (codex=${codex}, affinity=${affinity})`, () =>
        Effect.gen(function* () {
          const headers = { "Session-Id": "actual-child-session", ...(affinity ? { "X-Session-Affinity": affinity } : {}) }
          const input = LLM.updateRequest(request, {
            model: (codex ? OpenAIResponses.codexRoute : OpenAIResponses.route)
              .with({ auth: Auth.bearer("test-token").andThen(Auth.headers({ "ChatGPT-Account-Id": "test-account" })) })
              .model({ id: "fixture" }),
            providerOptions: { openai: { store: false, promptCacheKey: "body-cache-key" } },
            http: { headers, body: { max_output_tokens: 999, metadata: { local: "kept" } } },
          })
          yield* LLMClient.generate(input).pipe(Effect.provide(dynamicResponse((transport) =>
            Effect.gen(function* () {
              const web = yield* HttpClientRequest.toWeb(transport.request).pipe(Effect.orDie)
              expect(web.headers.get("session-id")).toBe(codex && affinity ? affinity : "actual-child-session")
              expect(web.headers.get("authorization")).toBe("Bearer test-token")
              expect(web.headers.get("chatgpt-account-id")).toBe("test-account")
              const body = yield* Effect.promise(() => web.json())
              expect(body).toMatchObject({ prompt_cache_key: "body-cache-key", store: false, metadata: { local: "kept" } })
              if (codex) expect(body).not.toHaveProperty("max_output_tokens")
              else expect(body).toHaveProperty("max_output_tokens", 999)
              return transport.respond(sseEvents({ type: "response.completed", response: {} }), {
                headers: { "content-type": "text/event-stream" },
              })
            }),
          )))
          expect(input.http?.headers).toEqual(headers)
          expect(headers["Session-Id"]).toBe("actual-child-session")
        }),
      )
    }
  }

  for (const codex of [false, true]) {
    for (const overlay of [false, true]) {
      it.effect(
        `preserves HTTP request semantics with ${codex ? "Codex" : "API-key"} auth and overlay=${overlay}`,
        () =>
          Effect.gen(function* () {
            const input = LLM.updateRequest(request, {
              model: (codex ? OpenAIResponses.codexRoute : OpenAIResponses.route)
                .with({
                  auth: Auth.bearer("test-token").andThen(Auth.headers({ "ChatGPT-Account-Id": "test-account" })),
                })
                .model({ id: "gpt-6-astra" }),
              providerOptions: { openai: { store: false, reasoningEffort: "high" } },
              tools: [{ name: "read", description: "Read a file", inputSchema: { type: "object" } }],
              http: {
                headers: { "x-request-test": "kept" },
                query: { trace: "kept" },
                ...(overlay ? { body: { max_output_tokens: 4096, metadata: { trace: "kept" } } } : {}),
              },
            })
            const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(input)
            const expected = { ...prepared.body, ...(overlay ? input.http?.body : {}) }
            if (codex) delete expected.max_output_tokens
            const response = yield* LLMClient.generate(input).pipe(
              Effect.provide(
                dynamicResponse((transport) =>
                  Effect.gen(function* () {
                    const web = yield* HttpClientRequest.toWeb(transport.request).pipe(Effect.orDie)
                    expect(web.url).toBe(
                      `${codex ? "https://chatgpt.com/backend-api/codex" : "https://api.openai.com/v1"}/responses?trace=kept`,
                    )
                    expect(web.headers.get("authorization")).toBe("Bearer test-token")
                    expect(web.headers.get("chatgpt-account-id")).toBe("test-account")
                    expect(web.headers.get("x-request-test")).toBe("kept")
                    expect(yield* Effect.promise(() => web.json())).toEqual(expected)
                    return transport.respond(
                      sseEvents(
                        { type: "response.output_text.delta", item_id: "msg_1", delta: "Ready" },
                        { type: "response.completed", response: {} },
                      ),
                      { headers: { "content-type": "text/event-stream" } },
                    )
                  }),
                ),
              ),
            )
            expect(response.text).toBe("Ready")
            expect(input.generation?.maxTokens).toBe(20)
            if (overlay) expect(input.http?.body?.max_output_tokens).toBe(4096)
          }),
      )
    }
  }

  for (const codex of [false, true]) {
    it.effect(`sends optional function parameters in best-effort mode for ${codex ? "Codex" : "API-key"} requests`, () =>
      Effect.gen(function* () {
        const input = LLM.updateRequest(request, {
          model: (codex ? OpenAIResponses.codexRoute : OpenAIResponses.route)
            .with({
              auth: Auth.bearer("test-token").andThen(Auth.headers({ "ChatGPT-Account-Id": "test-account" })),
            })
            .model({ id: "gpt-6-astra" }),
          tools: [
            {
              name: "session_read",
              description: "Read a Session page.",
              inputSchema: {
                type: "object",
                properties: {
                  session_id: { type: "string", pattern: "^ses_" },
                  cursor: {
                    type: "object",
                    properties: {
                      id: { type: "string", pattern: "^msg_" },
                      direction: { type: "string", enum: ["previous", "next"] },
                    },
                    required: ["id", "direction"],
                    additionalProperties: false,
                  },
                },
                required: ["session_id"],
                additionalProperties: false,
              },
            },
          ],
        })

        yield* LLMClient.generate(input).pipe(
          Effect.provide(
            dynamicResponse((transport) =>
              Effect.gen(function* () {
                const web = yield* HttpClientRequest.toWeb(transport.request).pipe(Effect.orDie)
                const body = yield* Effect.promise(() => web.json())
                expect(body).toMatchObject({
                  tools: [
                    {
                      type: "function",
                      name: "session_read",
                      strict: false,
                      parameters: {
                        type: "object",
                        properties: { cursor: { type: "object" } },
                      },
                    },
                  ],
                })
                const required = (body as { tools: Array<{ parameters: { required: string[] } }> }).tools[0]?.parameters
                  .required
                expect(required).toEqual(["session_id"])
                expect(required).not.toContain("cursor")
                return transport.respond(
                  sseEvents(
                    { type: "response.output_text.delta", item_id: "msg_1", delta: "Ready" },
                    { type: "response.completed", response: {} },
                  ),
                  { headers: { "content-type": "text/event-stream" } },
                )
              }),
            ),
          ),
        )
      }),
    )
  }

  it.effect("prepares OpenAI Responses target", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(request)

      expect(prepared.body).toEqual({
        model: "gpt-4.1-mini",
        input: [
          { role: "system", content: "You are concise." },
          { role: "user", content: [{ type: "input_text", text: "Say hello." }] },
        ],
        stream: true,
        prompt_cache_key: "req_1",
        max_output_tokens: 20,
        temperature: 0,
      })
    }),
  )

  it.effect("lets an explicit empty generation override clear route defaults", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model: OpenAIResponses.route
            .with({
              endpoint: { baseURL: "https://api.openai.test/v1/" },
              auth: Auth.bearer("test"),
              generation: { maxTokens: 512, temperature: 1 },
            })
            .model({ id: "gpt-4.1-mini" }),
          prompt: "Generate a title.",
          generation: {},
        }),
      )

      expect(prepared.body).not.toHaveProperty("max_output_tokens")
      expect(prepared.body).not.toHaveProperty("temperature")
    }),
  )

  it.effect("lowers semantic service tier options", () =>
    Effect.gen(function* () {
      const input = LLM.updateRequest(request, { providerOptions: { openai: { serviceTier: "priority" } } })
      expect(input.providerOptions).toEqual({ openai: { serviceTier: "priority" } })
      const prepared = yield* LLMClient.prepare(input)

      expect(prepared.body).toMatchObject({ service_tier: "priority" })
      expect(prepared.body).not.toHaveProperty("serviceTier")
    }),
  )

  it.effect("omits unsupported semantic service tiers", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.updateRequest(request, { providerOptions: { openai: { serviceTier: "unsupported" } } }),
      )

      expect(prepared.body).not.toHaveProperty("service_tier")
    }),
  )

  it.effect("flattens top-level object unions in function schemas", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.updateRequest(request, {
          tools: [
            {
              name: "read",
              description: "Read a path or resource.",
              inputSchema: {
                type: "object",
                anyOf: [
                  {
                    type: "object",
                    properties: {
                      path: { type: "string" },
                      reference: { anyOf: [{ type: "string" }, { type: "null" }] },
                      limit: { type: "integer", maximum: 2000 },
                    },
                    required: ["path"],
                  },
                  {
                    type: "object",
                    properties: { resource: { type: "string" }, limit: { type: "integer", maximum: 51200 } },
                    required: ["resource"],
                  },
                ],
              },
            },
          ],
        }),
      )

      expect(prepared.body.tools).toEqual([
        {
          type: "function",
          name: "read",
          description: "Read a path or resource.",
          strict: false,
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
              reference: { type: "string" },
              limit: {
                anyOf: [{ type: "integer", maximum: 2000 }, { type: "integer", maximum: 51200 }],
              },
              resource: { type: "string" },
            },
            additionalProperties: false,
          },
        },
      ])
    }),
  )

  it.effect("retains every management action when flattening a discriminated tool union", () =>
    Effect.gen(function* () {
      const actions = ["dispatch", "status", "wait", "review", "answer", "integrate", "cancel", "settle"]
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.updateRequest(request, {
          tools: [{
            name: "orchestrator",
            description: "Manage commissioned work.",
            inputSchema: {
              anyOf: [
                { type: "object", properties: { tasks: { type: "array", items: { type: "object" } } }, required: ["tasks"] },
                ...actions.map((action) => ({
                  type: "object",
                  properties: { action: { const: action }, originInputID: { type: "string" } },
                  required: ["action"],
                })),
              ],
            },
          }],
        }),
      )
      expect(prepared.body.tools?.[0]).toMatchObject({
        type: "function",
        name: "orchestrator",
        parameters: {
          type: "object",
          properties: {
            action: { anyOf: actions.map((action) => ({ type: "string", enum: [action] })) },
            originInputID: { type: "string" },
            tasks: { type: "array", items: { type: "object" } },
          },
          additionalProperties: false,
        },
      })
    }),
  )

  it.effect("sanitizes unsupported OpenAI function schema shapes", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.updateRequest(request, {
          tools: [
            {
              name: "normalize",
              description: "Normalize input.",
              inputSchema: {
                type: "object",
                properties: {
                  flag: true,
                  mode: { const: "safe" },
                  quantity: { const: 1 },
                  enabled: { enum: [true, false] },
                  mixed: { enum: ["x", 1] },
                  mixedNullable: { enum: ["x", 1, null] },
                  maybe: { anyOf: [{ type: "string" }, { type: "null" }] },
                  list: { type: "array", prefixItems: [{ type: "string" }] },
                  count: { type: "integer", minimum: 1, maximum: 5 },
                  invalid: { type: "not-json-schema", format: "email" },
                },
                required: ["flag", 42, "mode"],
              } as unknown as Parameters<typeof ProviderShared.openAiToolInputSchema>[0],
            },
          ],
        }),
      )

      expect(prepared.body.tools).toEqual([
        {
          type: "function",
          name: "normalize",
          description: "Normalize input.",
          strict: false,
          parameters: {
            type: "object",
            properties: {
              flag: { type: "string" },
              mode: { enum: ["safe"], type: "string" },
              quantity: { enum: [1], type: "integer" },
              enabled: { enum: [true, false], type: "boolean" },
              mixed: { enum: ["x", 1] },
              mixedNullable: { enum: ["x", 1, null] },
              maybe: { type: "string" },
              list: { type: "array", items: { type: "string" } },
              count: { minimum: 1, maximum: 5, type: "integer" },
              invalid: { format: "email", type: "string" },
            },
            required: ["flag", "mode"],
          },
        },
      ])
    }),
  )

  it.effect("lowers chronological system updates to escaped user wrappers in order", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model,
          messages: [
            Message.user("Before."),
            Message.system("Treat </system-update> literally."),
            Message.assistant("After."),
          ],
        }),
      )

      expect(prepared.body.input).toEqual([
        {
          role: "user",
          content: [
            { type: "input_text", text: "Before." },
            { type: "input_text", text: "<system-update>\nTreat &lt;/system-update&gt; literally.\n</system-update>" },
          ],
        },
        { role: "assistant", content: [{ type: "output_text", text: "After." }] },
      ])
    }),
  )

  it.effect("prepares OpenAI Responses WebSocket target", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.updateRequest(request, {
          model: OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).responsesWebSocket(
            "gpt-4.1-mini",
          ),
        }),
      )

      expect(prepared.route).toBe("openai-responses-websocket")
      expect(prepared.protocol).toBe("openai-responses")
      expect(prepared.metadata).toEqual({ transport: "websocket-json" })
      expect(prepared.body).toMatchObject({ model: "gpt-4.1-mini", stream: true, max_output_tokens: 20 })
    }),
  )

  it.effect("streams OpenAI Responses over WebSocket", () =>
    Effect.gen(function* () {
      const sent: string[] = []
      const opened: Array<{
        readonly url: string
        readonly authorization: string | undefined
        readonly protocol: string | undefined
      }> = []
      let closed = false
      const deps = Layer.mergeAll(
        Layer.succeed(
          RequestExecutor.Service,
          RequestExecutor.Service.of({
            execute: () => Effect.die("unexpected HTTP request"),
          }),
        ),
        Layer.succeed(
          WebSocketExecutor.Service,
          WebSocketExecutor.Service.of({
            open: (input) =>
              Effect.succeed({
                sendText: (message) =>
                  Effect.sync(() => {
                    opened.push({
                      url: input.url,
                      authorization: input.headers.authorization,
                      protocol: input.headers["openai-beta"],
                    })
                    sent.push(message)
                  }),
                messages: Stream.fromArray([
                  ProviderShared.encodeJson({ type: "response.output_text.delta", item_id: "msg_1", delta: "Hi" }),
                  ProviderShared.encodeJson({ type: "response.completed", response: { id: "resp_ws" } }),
                ]),
                close: Effect.sync(() => {
                  closed = true
                }),
              }),
          }),
        ),
      )
      const response = yield* LLMClient.generate(
        LLM.request({
          model: OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).responsesWebSocket(
            "gpt-4.1-mini",
          ),
          prompt: "Say hello.",
          generation: { maxTokens: 20 },
        }),
      ).pipe(Effect.provide(LLMClient.layer.pipe(Layer.provide(deps))))

      expect(response.text).toBe("Hi")
      expect(opened).toEqual([
        {
          url: "wss://api.openai.test/v1/responses",
          authorization: "Bearer test",
          protocol: "responses_websockets=2026-02-06",
        },
      ])
      expect(closed).toBe(true)
      expect(sent).toHaveLength(1)
      expect(JSON.parse(sent[0])).toEqual({
        type: "response.create",
        model: "gpt-4.1-mini",
        input: [{ role: "user", content: [{ type: "input_text", text: "Say hello." }] }],
        store: false,
      })
      expect(JSON.parse(sent[0])).not.toHaveProperty("max_output_tokens")
    }),
  )

  it.effect("fails immediately when WebSocket is already closed", () =>
    Effect.gen(function* () {
      const error = yield* WebSocketExecutor.fromWebSocket(
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- fromWebSocket reads readyState before touching WebSocket methods on this branch.
        { readyState: globalThis.WebSocket.CLOSED } as globalThis.WebSocket,
        { url: "wss://api.openai.test/v1/responses", headers: Headers.empty },
      ).pipe(Effect.flip)

      expect(error.message).toContain("closed before opening")
      expect(error.retryable).toBe(true)
    }),
  )

  it.effect("bounds WebSocket connection waits", () =>
    Effect.gen(function* () {
      let closed = false
      const socket = Object.assign(new EventTarget(), {
        readyState: globalThis.WebSocket.CONNECTING,
        close: () => {
          closed = true
        },
      })
      const error = yield* WebSocketExecutor.fromWebSocket(
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal EventTarget-backed socket exercises the connect timer.
        socket as unknown as globalThis.WebSocket,
        {
          url: "wss://api.openai.test/v1/responses",
          headers: Headers.empty,
          connectTimeoutMs: 10,
        },
      ).pipe(Effect.flip)

      expect(error.message).toContain("connection timed out")
      expect(error.retryable).toBe(true)
      expect(closed).toBe(true)
    }),
  )

  it.effect("does not retry payload-limit closes while the WebSocket is connecting", () =>
    Effect.gen(function* () {
      const socket = Object.assign(new EventTarget(), {
        readyState: globalThis.WebSocket.CONNECTING,
        close: () => {},
      })
      const result = yield* WebSocketExecutor.fromWebSocket(
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal EventTarget-backed socket exercises pre-open close classification.
        socket as unknown as globalThis.WebSocket,
        { url: "wss://api.openai.test/v1/responses", headers: Headers.empty },
      ).pipe(Effect.flip, Effect.forkChild)
      yield* Effect.yieldNow
      socket.dispatchEvent(Object.assign(new Event("close"), { code: 1009 }))
      const error = yield* Fiber.join(result)

      expect(error.message).toContain("closed before opening with code 1009")
      expect(error.retryable).toBe(false)
    }),
  )

  it.effect("bounds idle WebSocket response waits", () =>
    Effect.gen(function* () {
      let closed = false
      const socket = Object.assign(new EventTarget(), {
        readyState: globalThis.WebSocket.OPEN,
        close: () => {
          closed = true
        },
      })
      const connection = yield* WebSocketExecutor.fromWebSocket(
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal EventTarget-backed socket exercises the idle timer.
        socket as unknown as globalThis.WebSocket,
        {
          url: "wss://api.openai.test/v1/responses",
          headers: Headers.empty,
          idleTimeoutMs: 10,
        },
      )
      const error = yield* connection.messages.pipe(Stream.runDrain, Effect.flip)

      expect(error.message).toContain("timed out without an event")
      expect(error.retryable).toBe(true)
      expect(closed).toBe(true)
    }),
  )

  it.effect("does not retry WebSocket payload limit failures", () =>
    Effect.gen(function* () {
      const socket = Object.assign(new EventTarget(), {
        readyState: globalThis.WebSocket.OPEN,
        close: () => {},
      })
      const connection = yield* WebSocketExecutor.fromWebSocket(
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal EventTarget-backed socket exercises close classification.
        socket as unknown as globalThis.WebSocket,
        { url: "wss://api.openai.test/v1/responses", headers: Headers.empty },
      )
      const result = connection.messages.pipe(Stream.runDrain, Effect.flip)
      socket.dispatchEvent(Object.assign(new Event("close"), { code: 1009, reason: "payload too large" }))
      const error = yield* result

      expect(error.message).toContain("code 1009: payload too large")
      expect(error.retryable).toBe(false)
    }),
  )

  it.effect("adds native query params to the Responses URL", () =>
    Effect.gen(function* () {
      yield* LLMClient.generate(
        LLM.updateRequest(request, {
          model: Model.update(model, { route: model.route.with({ endpoint: { query: { "api-version": "v1" } } }) }),
        }),
      ).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
              expect(web.url).toBe("https://api.openai.test/v1/responses?api-version=v1")
              return input.respond(sseEvents({ type: "response.completed", response: {} }), {
                headers: { "content-type": "text/event-stream" },
              })
            }),
          ),
        ),
      )
    }),
  )

  it.effect("uses Azure api-key header for static OpenAI Responses keys", () =>
    Effect.gen(function* () {
      yield* LLMClient.generate(
        LLM.updateRequest(request, {
          model: Azure.configure({
            baseURL: "https://opencode-test.openai.azure.com/openai/v1/",
            apiKey: "azure-key",
            headers: { authorization: "Bearer stale" },
          }).responses("gpt-4.1-mini"),
        }),
      ).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
              expect(web.url).toBe("https://opencode-test.openai.azure.com/openai/v1/responses?api-version=v1")
              expect(web.headers.get("api-key")).toBe("azure-key")
              expect(web.headers.get("authorization")).toBeNull()
              return input.respond(sseEvents({ type: "response.completed", response: {} }), {
                headers: { "content-type": "text/event-stream" },
              })
            }),
          ),
        ),
      )
    }),
  )

  it.effect("loads OpenAI default auth from Effect Config", () =>
    LLMClient.generate(
      LLM.updateRequest(request, {
        model: OpenAI.configure({ baseURL: "https://api.openai.test/v1/" }).responses("gpt-4.1-mini"),
      }),
    ).pipe(
      configEnv({ OPENAI_API_KEY: "env-key" }),
      Effect.provide(
        dynamicResponse((input) =>
          Effect.gen(function* () {
            const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
            expect(web.headers.get("authorization")).toBe("Bearer env-key")
            return input.respond(sseEvents({ type: "response.completed", response: {} }), {
              headers: { "content-type": "text/event-stream" },
            })
          }),
        ),
      ),
    ),
  )

  it.effect("lets explicit auth override OpenAI default API key auth", () =>
    LLMClient.generate(
      LLM.updateRequest(request, {
        model: OpenAI.configure({
          baseURL: "https://api.openai.test/v1/",
          auth: Auth.bearer("oauth-token"),
        }).responses("gpt-4.1-mini"),
      }),
    ).pipe(
      Effect.provide(
        dynamicResponse((input) =>
          Effect.gen(function* () {
            const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
            expect(web.headers.get("authorization")).toBe("Bearer oauth-token")
            return input.respond(sseEvents({ type: "response.completed", response: {} }), {
              headers: { "content-type": "text/event-stream" },
            })
          }),
        ),
      ),
    ),
  )

  it.effect("prepares function call and function output input items", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          id: "req_tool_result",
          model,
          messages: [
            Message.user("What is the weather?"),
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "lookup", input: { query: "weather" } })]),
            Message.tool({ id: "call_1", name: "lookup", result: { forecast: "sunny" } }),
          ],
        }),
      )

      expect(prepared.body).toEqual({
        model: "gpt-4.1-mini",
        input: [
          { role: "user", content: [{ type: "input_text", text: "What is the weather?" }] },
          { type: "function_call", call_id: "call_1", name: "lookup", arguments: '{"query":"weather"}' },
          { type: "function_call_output", call_id: "call_1", output: '{"forecast":"sunny"}' },
        ],
        stream: true,
        prompt_cache_key: "req_tool_result",
      })
    }),
  )

  // Regression: screenshot/read tool results must stay structured so base64
  // image data is not JSON-stringified into `function_call_output.output`.
  it.effect("lowers image tool-result content as structured input_image items", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          id: "req_tool_result_image",
          model,
          messages: [
            Message.user("Show me the screenshot."),
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "read", input: { filePath: "shot.png" } })]),
            Message.tool({
              id: "call_1",
              name: "read",
              resultType: "content",
              result: [
                { type: "text", text: "Image read successfully" },
                { type: "file", uri: "data:image/png;base64,AAECAw==", mime: "image/png" },
              ],
            }),
          ],
        }),
      )

      expect(expectToolOutput(prepared.body).output).toEqual([
        { type: "input_text", text: "Image read successfully" },
        { type: "input_image", image_url: "data:image/png;base64,AAECAw==" },
      ])
    }),
  )

  it.effect("lowers single-image tool-result content as structured input_image array", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          id: "req_tool_result_image_only",
          model,
          messages: [
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "screenshot", input: {} })]),
            Message.tool({
              id: "call_1",
              name: "screenshot",
              resultType: "content",
              result: [{ type: "file", uri: "data:image/png;base64,AAECAw==", mime: "image/png" }],
            }),
          ],
        }),
      )

      expect(expectToolOutput(prepared.body).output).toEqual([
        { type: "input_image", image_url: "data:image/png;base64,AAECAw==" },
      ])
    }),
  )

  it.effect("rejects non-image media in tool-result content with a clear error", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.prepare(
        LLM.request({
          id: "req_tool_result_unsupported_media",
          model,
          messages: [
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "fetch", input: {} })]),
            Message.tool({
              id: "call_1",
              name: "fetch",
              resultType: "content",
              result: [{ type: "file", uri: "data:audio/mpeg;base64,AAECAw==", mime: "audio/mpeg" }],
            }),
          ],
        }),
      ).pipe(Effect.flip)

      expect(error.message).toContain("OpenAI Responses")
      expect(error.message).toContain("audio/mpeg")
    }),
  )

  it.effect("prepares the composed native continuation request", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        continuationRequest({
          id: "req_native_continuation_openai",
          model,
          features: nativeOpenAIResponsesContinuation,
        }),
      )

      expect(prepared.body).toMatchObject({
        input: [
          { role: "system", content: "You are concise. Continue from the provided history." },
          {
            role: "user",
            content: [
              { type: "input_text", text: "What is shown here?" },
              { type: "input_image", image_url: "data:image/png;base64,AAECAw==" },
            ],
          },
          {
            type: "reasoning",
            id: "rs_continuation_1",
            encrypted_content: "encrypted-continuation-state",
            summary: [{ type: "summary_text", text: "I inspected the previous turn." }],
          },
          { role: "assistant", content: [{ type: "output_text", text: "It shows a small test image." }] },
          { role: "user", content: [{ type: "input_text", text: "Check the weather in Paris before continuing." }] },
          { type: "function_call", call_id: "call_weather_1", name: "get_weather", arguments: '{"city":"Paris"}' },
          { type: "function_call_output", call_id: "call_weather_1", output: '{"temperature":22}' },
          { role: "assistant", content: [{ type: "output_text", text: "Paris is 22 degrees." }] },
          {
            role: "user",
            content: [{ type: "input_text", text: "Continue from this conversation in one short sentence." }],
          },
        ],
        include: ["reasoning.encrypted_content"],
        store: false,
      })
      expect(prepared.body.tools).toEqual([expect.objectContaining({ type: "function", name: "get_weather" })])
    }),
  )

  it.effect("maps OpenAI provider options to Responses options", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model: OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).model("gpt-5.6"),
          prompt: "think",
          providerOptions: {
            openai: {
              promptCacheKey: "session_123",
              reasoningEffort: "max",
              reasoningSummary: "auto",
              reasoning: { mode: "pro" },
              include: ["reasoning.encrypted_content"],
            },
          },
        }),
      )

      expect(prepared.body.store).toBe(false)
      expect(prepared.body.prompt_cache_key).toBe("session_123")
      expect(prepared.body.include).toEqual(["reasoning.encrypted_content"])
      expect(prepared.body.reasoning).toEqual({ effort: "max", summary: "auto", mode: "pro" })
      expect(prepared.body.text).toEqual({ verbosity: "low" })
    }),
  )

  it.effect("maps GPT-6 Luna MAX variant options to the Responses request body", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model: OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).model("gpt-6-luna"),
          prompt: "think",
          providerOptions: {
            openai: {
              reasoningEffort: "max",
              reasoningSummary: "auto",
              include: ["reasoning.encrypted_content"],
            },
          },
        }),
      )

      expect(prepared.body.store).toBe(false)
      expect(prepared.body.include).toEqual(["reasoning.encrypted_content"])
      expect(prepared.body.reasoning).toEqual({ effort: "max", summary: "auto" })
    }),
  )

  it.effect("accepts the full ResponseIncludable union", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model,
          prompt: "hi",
          providerOptions: {
            openai: {
              include: ["reasoning.encrypted_content", "code_interpreter_call.outputs", "web_search_call.results"],
            },
          },
        }),
      )

      expect(prepared.body.include).toEqual([
        "reasoning.encrypted_content",
        "code_interpreter_call.outputs",
        "web_search_call.results",
      ])
    }),
  )

  it.effect("filters unknown includable values out of the include array", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model,
          prompt: "hi",
          // The user passed one invalid entry alongside a valid one. Keep the
          // valid one so the request still succeeds rather than failing on a
          // typo from upstream config.
          providerOptions: { openai: { include: ["reasoning.encrypted_content", "bogus.thing"] } },
        }),
      )

      expect(prepared.body.include).toEqual(["reasoning.encrypted_content"])
    }),
  )

  it.effect("treats an explicit empty include as no include at all", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({ model, prompt: "hi", providerOptions: { openai: { include: [] } } }),
      )

      expect(prepared.body.include).toBeUndefined()
    }),
  )

  it.effect("treats an all-invalid include as no include at all", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({ model, prompt: "hi", providerOptions: { openai: { include: ["bogus.thing"] } } }),
      )

      expect(prepared.body.include).toBeUndefined()
    }),
  )

  it.effect("omits include when no include is set", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({ model, prompt: "hi", providerOptions: { openai: { store: false } } }),
      )

      expect(prepared.body.include).toBeUndefined()
    }),
  )

  it.effect("requests encrypted reasoning by default for GPT-5 reasoning models", () =>
    Effect.gen(function* () {
      // The native OpenAI facade configures GPT-5 stateless (store: false) with
      // reasoningSummary: "auto" by default. Without `include`, a follow-up
      // turn cannot replay reasoning state, so the facade also opts into
      // `reasoning.encrypted_content` automatically.
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model: OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).responses("gpt-5.2"),
          prompt: "hi",
        }),
      )

      expect(prepared.body.store).toBe(false)
      expect(prepared.body.include).toEqual(["reasoning.encrypted_content"])
      expect(prepared.body.reasoning).toEqual({ effort: "medium", summary: "auto" })
    }),
  )

  it.effect("lets callers opt out of the GPT-5 default include", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model: OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).responses("gpt-5.2"),
          prompt: "hi",
          providerOptions: { openai: { include: [] } },
        }),
      )

      expect(prepared.body.include).toBeUndefined()
    }),
  )

  it.effect("request OpenAI provider options override route defaults", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model: OpenAI.configure({
            baseURL: "https://api.openai.test/v1/",
            apiKey: "test",
            providerOptions: { openai: { promptCacheKey: "model_cache" } },
          }).model("gpt-4.1-mini"),
          prompt: "no cache",
          providerOptions: { openai: { promptCacheKey: "request_cache" } },
        }),
      )

      expect(prepared.body.prompt_cache_key).toBe("request_cache")
    }),
  )

  it.effect("parses text, cache reads, and cache writes from usage stream", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        { type: "response.output_text.delta", item_id: "msg_1", delta: "Hello" },
        { type: "response.output_text.delta", item_id: "msg_1", delta: "!" },
        {
          type: "response.completed",
          response: {
            id: "resp_1",
            service_tier: "default",
            usage: {
              input_tokens: 5,
              output_tokens: 2,
              total_tokens: 7,
              input_tokens_details: { cached_tokens: 1, cache_write_tokens: 2 },
              output_tokens_details: { reasoning_tokens: 0 },
            },
          },
        },
      )
      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)))
      const usage = new Usage({
        inputTokens: 5,
        outputTokens: 2,
        nonCachedInputTokens: 2,
        cacheReadInputTokens: 1,
        cacheWriteInputTokens: 2,
        reasoningTokens: 0,
        totalTokens: 7,
        providerMetadata: {
          openai: {
            input_tokens: 5,
            output_tokens: 2,
            total_tokens: 7,
            input_tokens_details: { cached_tokens: 1, cache_write_tokens: 2 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
      })

      expect(response.text).toBe("Hello!")
      expect(response.events).toEqual([
        { type: "step-start", index: 0 },
        { type: "text-start", id: "msg_1" },
        { type: "text-delta", id: "msg_1", text: "Hello" },
        { type: "text-delta", id: "msg_1", text: "!" },
        { type: "text-end", id: "msg_1" },
        {
          type: "step-finish",
          index: 0,
          reason: "stop",
          providerMetadata: { openai: { responseId: "resp_1", serviceTier: "default" } },
          usage,
        },
        {
          type: "finish",
          reason: "stop",
          providerMetadata: { openai: { responseId: "resp_1", serviceTier: "default" } },
          usage,
        },
      ])
    }),
  )

  it.effect("parses reasoning summary stream fixtures", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        { type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "thinking" },
        { type: "response.output_text.delta", item_id: "msg_1", delta: "Hello" },
        { type: "response.reasoning_summary_text.done", item_id: "rs_1" },
        { type: "response.completed", response: { id: "resp_1" } },
      )

      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)))

      expect(response.reasoning).toBe("thinking")
      expect(response.text).toBe("Hello")
      expect(response.events).toMatchObject([
        { type: "step-start", index: 0 },
        { type: "reasoning-start", id: "rs_1" },
        { type: "reasoning-delta", id: "rs_1", text: "thinking" },
        { type: "text-start", id: "msg_1" },
        { type: "text-delta", id: "msg_1", text: "Hello" },
        { type: "reasoning-end", id: "rs_1" },
        { type: "text-end", id: "msg_1" },
        { type: "step-finish", index: 0, reason: "stop" },
        { type: "finish", reason: "stop" },
      ])
    }),
  )

  it.effect("preserves encrypted reasoning metadata for continuation", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              { type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "thinking" },
              {
                type: "response.output_item.done",
                item: {
                  type: "reasoning",
                  id: "rs_1",
                  encrypted_content: "encrypted-state",
                  summary: [{ type: "summary_text", text: "thinking" }],
                },
              },
              { type: "response.completed", response: { id: "resp_1" } },
            ),
          ),
        ),
      )

      expect(response.events).toContainEqual(
        expect.objectContaining({
          type: "reasoning-end",
          id: "rs_1",
          providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
        }),
      )
    }),
  )

  it.effect("streams each reasoning summary part as a separate block", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(
        LLM.updateRequest(request, { providerOptions: { openai: { store: false } } }),
      ).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              {
                type: "response.output_item.added",
                item: { type: "reasoning", id: "rs_1", encrypted_content: null },
              },
              { type: "response.reasoning_summary_part.added", item_id: "rs_1", summary_index: 0 },
              { type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 0, delta: "First" },
              { type: "response.reasoning_summary_part.done", item_id: "rs_1", summary_index: 0 },
              { type: "response.reasoning_summary_part.added", item_id: "rs_1", summary_index: 1 },
              { type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 1, delta: "Second" },
              { type: "response.reasoning_summary_part.done", item_id: "rs_1", summary_index: 1 },
              {
                type: "response.output_item.done",
                item: { type: "reasoning", id: "rs_1", encrypted_content: "encrypted-state" },
              },
              { type: "response.completed", response: { id: "resp_1" } },
            ),
          ),
        ),
      )

      expect(response.reasoning).toBe("FirstSecond")
      expect(response.events).toMatchObject([
        { type: "step-start", index: 0 },
        {
          type: "reasoning-start",
          id: "rs_1:0",
          providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: null } },
        },
        { type: "reasoning-delta", id: "rs_1:0", text: "First" },
        { type: "reasoning-end", id: "rs_1:0", providerMetadata: { openai: { itemId: "rs_1" } } },
        {
          type: "reasoning-start",
          id: "rs_1:1",
          providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: null } },
        },
        { type: "reasoning-delta", id: "rs_1:1", text: "Second" },
        {
          type: "reasoning-end",
          id: "rs_1:1",
          providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
        },
        { type: "step-finish", index: 0, reason: "stop" },
        { type: "finish", reason: "stop" },
      ])
    }),
  )

  it.effect("closes reasoning summary parts when storage is not disabled", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              {
                type: "response.output_item.added",
                item: { type: "reasoning", id: "rs_1", encrypted_content: null },
              },
              { type: "response.reasoning_summary_part.added", item_id: "rs_1", summary_index: 0 },
              { type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 0, delta: "First" },
              { type: "response.reasoning_summary_part.done", item_id: "rs_1", summary_index: 0 },
              { type: "response.reasoning_summary_part.added", item_id: "rs_1", summary_index: 1 },
              { type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 1, delta: "Second" },
              { type: "response.reasoning_summary_part.done", item_id: "rs_1", summary_index: 1 },
              {
                type: "response.output_item.done",
                item: { type: "reasoning", id: "rs_1", encrypted_content: null },
              },
              { type: "response.completed", response: { id: "resp_1" } },
            ),
          ),
        ),
      )

      expect(response.events.filter((event) => event.type === "reasoning-end")).toEqual([
        { type: "reasoning-end", id: "rs_1:0", providerMetadata: { openai: { itemId: "rs_1" } } },
        { type: "reasoning-end", id: "rs_1:1", providerMetadata: { openai: { itemId: "rs_1" } } },
      ])
    }),
  )

  it.effect("continues a stateless reasoning conversation", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(
        LLM.request({
          id: "req_reasoning_continue",
          model,
          messages: [
            Message.user("What changed?"),
            Message.assistant([
              {
                type: "reasoning",
                text: "Checked the previous diff.",
                providerMetadata: {
                  openai: {
                    itemId: "rs_1",
                    reasoningEncryptedContent: "encrypted-state",
                  },
                },
              },
              { type: "text", text: "The parser changed." },
            ]),
            Message.user("Summarize it."),
          ],
          providerOptions: { openai: { store: false } },
        }),
      ).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
              expect(yield* Effect.promise(() => web.json())).toMatchObject({
                input: [
                  { role: "user", content: [{ type: "input_text", text: "What changed?" }] },
                  {
                    type: "reasoning",
                    id: "rs_1",
                    encrypted_content: "encrypted-state",
                    summary: [{ type: "summary_text", text: "Checked the previous diff." }],
                  },
                  { role: "assistant", content: [{ type: "output_text", text: "The parser changed." }] },
                  { role: "user", content: [{ type: "input_text", text: "Summarize it." }] },
                ],
              })
              return input.respond(
                sseEvents(
                  { type: "response.output_text.delta", item_id: "msg_1", delta: "Parser now round-trips reasoning." },
                  { type: "response.completed", response: { id: "resp_1" } },
                ),
                { headers: { "content-type": "text/event-stream" } },
              )
            }),
          ),
        ),
      )

      expect(response.text).toBe("Parser now round-trips reasoning.")
    }),
  )

  it.effect("preserves assistant content order around reasoning items", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          id: "req_reasoning_order",
          model,
          messages: [
            Message.assistant([
              { type: "text", text: "Before." },
              {
                type: "reasoning",
                text: "Checked order.",
                providerMetadata: {
                  openai: {
                    itemId: "rs_1",
                    reasoningEncryptedContent: "encrypted-state",
                  },
                },
              },
              { type: "text", text: "After." },
            ]),
          ],
          providerOptions: { openai: { store: false } },
        }),
      )

      expect(prepared.body.input).toEqual([
        { role: "assistant", content: [{ type: "output_text", text: "Before." }] },
        {
          type: "reasoning",
          id: "rs_1",
          encrypted_content: "encrypted-state",
          summary: [{ type: "summary_text", text: "Checked order." }],
        },
        { role: "assistant", content: [{ type: "output_text", text: "After." }] },
      ])
    }),
  )

  it.effect("references stored reasoning items by id", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model,
          messages: [
            Message.assistant([
              {
                type: "reasoning",
                text: "Checked the previous diff.",
                providerMetadata: { openai: { itemId: "rs_1" } },
              },
            ]),
          ],
          providerOptions: { openai: { store: true } },
        }),
      )

      expect(prepared.body.input).toEqual([{ type: "item_reference", id: "rs_1" }])
    }),
  )

  it.effect("references stored provider-executed hosted tool results by id", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model,
          messages: [
            Message.assistant([
              ToolCallPart.make({
                id: "ws_1",
                name: "web_search",
                input: { query: "effect 4" },
                providerExecuted: true,
                providerMetadata: { openai: { itemId: "ws_1" } },
              }),
              {
                type: "tool-result",
                id: "ws_1",
                name: "web_search",
                result: { type: "json", value: { type: "web_search_call", id: "ws_1", status: "completed" } },
                providerExecuted: true,
                providerMetadata: { openai: { itemId: "ws_1" } },
              },
            ]),
            Message.user("Continue."),
          ],
          providerOptions: { openai: { store: true } },
        }),
      )

      expect(prepared.body.input).toEqual([
        { type: "item_reference", id: "ws_1" },
        { role: "user", content: [{ type: "input_text", text: "Continue." }] },
      ])
    }),
  )

  it.effect("joins streamed summary blocks into one continuation reasoning item", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          id: "req_multi_summary_continuation",
          model,
          messages: [
            Message.assistant([
              {
                type: "reasoning",
                text: "First",
                providerMetadata: { openai: { itemId: "rs_1" } },
              },
              {
                type: "reasoning",
                text: "Second",
                providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
              },
            ]),
          ],
          providerOptions: { openai: { store: false } },
        }),
      )

      expect(prepared.body.input).toEqual([
        {
          type: "reasoning",
          id: "rs_1",
          encrypted_content: "encrypted-state",
          summary: [
            { type: "summary_text", text: "First" },
            { type: "summary_text", text: "Second" },
          ],
        },
      ])
    }),
  )

  it.effect("skips non-persisted reasoning ids without encrypted state", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          id: "req_reasoning_without_encrypted_state",
          model,
          messages: [
            Message.user("What changed?"),
            Message.assistant([
              {
                type: "reasoning",
                text: "Checked the previous diff.",
                providerMetadata: {
                  openai: {
                    itemId: "rs_1",
                    reasoningEncryptedContent: null,
                  },
                },
              },
              { type: "text", text: "The parser changed." },
            ]),
            Message.user("Summarize it."),
          ],
          providerOptions: { openai: { store: false } },
        }),
      )

      expect(prepared.body).toMatchObject({
        input: [
          { role: "user", content: [{ type: "input_text", text: "What changed?" }] },
          { role: "assistant", content: [{ type: "output_text", text: "The parser changed." }] },
          { role: "user", content: [{ type: "input_text", text: "Summarize it." }] },
        ],
        store: false,
      })
    }),
  )

  it.effect("assembles streamed function call input", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        {
          type: "response.output_item.added",
          item: { type: "function_call", id: "item_1", call_id: "call_1", name: "lookup", arguments: "" },
        },
        { type: "response.function_call_arguments.delta", item_id: "item_1", delta: '{"query"' },
        { type: "response.function_call_arguments.delta", item_id: "item_1", delta: ':"weather"}' },
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            id: "item_1",
            call_id: "call_1",
            name: "lookup",
            arguments: '{"query":"weather"}',
          },
        },
        { type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 1 } } },
      )
      const response = yield* LLMClient.generate(
        LLM.updateRequest(request, {
          tools: [{ name: "lookup", description: "Lookup data", inputSchema: { type: "object" } }],
        }),
      ).pipe(Effect.provide(fixedResponse(body)))
      const usage = new Usage({
        inputTokens: 5,
        outputTokens: 1,
        nonCachedInputTokens: 5,
        cacheReadInputTokens: undefined,
        reasoningTokens: undefined,
        totalTokens: 6,
        providerMetadata: { openai: { input_tokens: 5, output_tokens: 1 } },
      })

      expect(response.events).toEqual([
        { type: "step-start", index: 0 },
        {
          type: "tool-input-start",
          id: "call_1",
          name: "lookup",
          providerMetadata: { openai: { itemId: "item_1" } },
        },
        {
          type: "tool-input-delta",
          id: "call_1",
          name: "lookup",
          text: '{"query"',
        },
        {
          type: "tool-input-delta",
          id: "call_1",
          name: "lookup",
          text: ':"weather"}',
        },
        {
          type: "tool-input-end",
          id: "call_1",
          name: "lookup",
          providerMetadata: { openai: { itemId: "item_1" } },
        },
        {
          type: "tool-call",
          id: "call_1",
          name: "lookup",
          input: { query: "weather" },
          providerExecuted: undefined,
          providerMetadata: { openai: { itemId: "item_1" } },
        },
        { type: "step-finish", index: 0, reason: "tool-calls", usage, providerMetadata: undefined },
        {
          type: "finish",
          reason: "tool-calls",
          providerMetadata: undefined,
          usage,
        },
      ])
    }),
  )

  it.effect("decodes web_search_call as provider-executed tool-call + tool-result", () =>
    Effect.gen(function* () {
      const item = {
        type: "web_search_call",
        id: "ws_1",
        status: "completed",
        action: { type: "search", query: "effect 4" },
      }
      const body = sseEvents(
        { type: "response.output_item.added", item },
        { type: "response.output_item.done", item },
        { type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 1 } } },
      )
      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)))

      const callsAndResults = response.events.filter(
        (event) => event.type === "tool-call" || event.type === "tool-result",
      )
      expect(callsAndResults).toEqual([
        {
          type: "tool-call",
          id: "ws_1",
          name: "web_search",
          input: { type: "search", query: "effect 4" },
          providerExecuted: true,
          providerMetadata: { openai: { itemId: "ws_1" } },
        },
        {
          type: "tool-result",
          id: "ws_1",
          name: "web_search",
          result: { type: "json", value: item },
          providerExecuted: true,
          providerMetadata: { openai: { itemId: "ws_1" } },
        },
      ])
    }),
  )

  it.effect("decodes code_interpreter_call as provider-executed events with code input", () =>
    Effect.gen(function* () {
      const item = {
        type: "code_interpreter_call",
        id: "ci_1",
        status: "completed",
        code: "print(1+1)",
        container_id: "cnt_xyz",
        outputs: [{ type: "logs", logs: "2\n" }],
      }
      const body = sseEvents(
        { type: "response.output_item.done", item },
        { type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 1 } } },
      )
      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)))

      const toolCall = response.events.find((event) => event.type === "tool-call")
      expect(toolCall).toEqual({
        type: "tool-call",
        id: "ci_1",
        name: "code_interpreter",
        input: { code: "print(1+1)", container_id: "cnt_xyz" },
        providerExecuted: true,
        providerMetadata: { openai: { itemId: "ci_1" } },
      })
      const toolResult = response.events.find((event) => event.type === "tool-result")
      expect(toolResult).toEqual({
        type: "tool-result",
        id: "ci_1",
        name: "code_interpreter",
        result: { type: "json", value: item },
        providerExecuted: true,
        providerMetadata: { openai: { itemId: "ci_1" } },
      })
    }),
  )

  it.effect("lowers user image content", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          id: "req_media",
          model,
          messages: [Message.user({ type: "media", mediaType: "image/png", data: "AAECAw==" })],
        }),
      )

      expect(prepared.body.input).toEqual([
        {
          role: "user",
          content: [{ type: "input_image", image_url: "data:image/png;base64,AAECAw==" }],
        },
      ])
    }),
  )

  it.effect("rejects unsupported user media content", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.prepare(
        LLM.request({
          id: "req_media",
          model,
          messages: [Message.user({ type: "media", mediaType: "application/pdf", data: "AAECAw==" })],
        }),
      ).pipe(Effect.flip)

      expect(error.message).toContain("OpenAI Responses does not support media type application/pdf")
    }),
  )

  it.effect("emits provider-error events for mid-stream provider errors", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(fixedResponse(sseEvents({ type: "error", code: "rate_limit_exceeded", message: "Slow down" }))),
      )

      // Prefix the code so consumers see the failure mode, not just the
      // sometimes-generic provider message. The bare message alone meant
      // production errors like rate limits were indistinguishable from
      // unrelated stream failures.
      expect(response.events).toEqual([{ type: "provider-error", message: "rate_limit_exceeded: Slow down" }])
    }),
  )

  it.effect("falls back to error code when no message is present", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(fixedResponse(sseEvents({ type: "error", code: "internal_error" }))),
      )

      expect(response.events).toEqual([{ type: "provider-error", message: "internal_error" }])
    }),
  )

  it.effect("falls back to error code when message is empty", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(fixedResponse(sseEvents({ type: "error", code: "internal_error", message: "" }))),
      )

      expect(response.events).toEqual([{ type: "provider-error", message: "internal_error" }])
    }),
  )

  it.effect("surfaces WebSocket error details from the top-level error object", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents({
              type: "error",
              error: {
                code: "context_length_exceeded",
                message: "Input exceeds the model context window",
                param: "input",
              },
            }),
          ),
        ),
      )

      expect(response.events).toEqual([
        {
          type: "provider-error",
          message: "context_length_exceeded: Input exceeds the model context window",
          classification: "context-overflow",
        },
      ])
    }),
  )

  // Regression: `response.failed` carries the failure details under
  // `response.error`, not at the top level. The previous handler only
  // checked top-level `message`/`code` and so always emitted the bare
  // "OpenAI Responses response failed" string, hiding the real cause.
  it.effect("surfaces response.failed details from response.error", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents({
              type: "response.failed",
              response: {
                id: "resp_failed_1",
                error: { code: "server_error", message: "Upstream model unavailable" },
              },
            }),
          ),
        ),
      )

      expect(response.events).toEqual([
        { type: "provider-error", message: "server_error: Upstream model unavailable", retryable: true },
      ])
    }),
  )

  it.effect("marks server_is_overloaded error events as retryable", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents({
              type: "error",
              code: "server_is_overloaded",
              message: "The service is temporarily overloaded",
            }),
          ),
        ),
      )

      expect(response.events).toEqual([
        {
          type: "provider-error",
          message: "server_is_overloaded: The service is temporarily overloaded",
          retryable: true,
        },
      ])
    }),
  )

  it.effect("surfaces response.failed code when no nested message is present", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents({
              type: "response.failed",
              response: { id: "resp_failed_2", error: { code: "invalid_prompt" } },
            }),
          ),
        ),
      )

      expect(response.events).toEqual([{ type: "provider-error", message: "invalid_prompt" }])
    }),
  )

  it.effect("surfaces error event details even when they arrive nested under response.error", () =>
    Effect.gen(function* () {
      // Some OpenAI-compatible proxies and older SDK versions wrap the
      // top-level error fields into a nested `response.error` payload
      // when they bubble up an HTTP error as an SSE `error` event. Honour
      // both shapes so the user still sees the underlying cause instead
      // of the catch-all string.
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents({
              type: "error",
              response: { error: { code: "context_length_exceeded", message: "prompt too long" } },
            }),
          ),
        ),
      )

      expect(response.events).toEqual([
        {
          type: "provider-error",
          message: "context_length_exceeded: prompt too long",
          classification: "context-overflow",
        },
      ])
    }),
  )

  it.effect("falls back to a stable default when both error and response are absent", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(fixedResponse(sseEvents({ type: "error" }))),
      )

      expect(response.events).toEqual([{ type: "provider-error", message: "OpenAI Responses stream error" }])
    }),
  )

  it.effect("falls back to a stable default when response.failed has no error payload", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(fixedResponse(sseEvents({ type: "response.failed", response: { id: "resp_failed_3" } }))),
      )

      expect(response.events).toEqual([{ type: "provider-error", message: "OpenAI Responses response failed" }])
    }),
  )

  it.effect("fails HTTP provider errors before stream parsing", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse('{"error":{"type":"invalid_request_error","message":"Bad request"}}', {
            status: 400,
            headers: { "content-type": "application/json" },
          }),
        ),
        Effect.flip,
      )

      expect(error).toBeInstanceOf(LLMError)
      expect(error.reason).toMatchObject({ _tag: "InvalidRequest" })
      expect(error.message).toContain("HTTP 400")
    }),
  )
})

describe("opencode-go tool_choice policy", () => {
  const goModel = OpenAIResponses.route
    .with({ endpoint: { baseURL: "https://go.test/v1/" }, auth: Auth.bearer("test"), provider: "opencode-go" })
    .model({ id: "muse-spark-1.3-contributor" })
  const tools = [{ name: "read", description: "Read a file", inputSchema: { type: "object" } }]

  it.effect("required lowers to auto with tools kept on the wire", () =>
    Effect.gen(function* () {
      const input = LLM.updateRequest(request, { model: goModel, tools, toolChoice: "required" })
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(input)
      expect(prepared.body.tool_choice).toBe("auto")
      expect(prepared.body.tools).toHaveLength(1)
    }),
  )

  it.effect("none removes tools and omits tool_choice entirely", () =>
    Effect.gen(function* () {
      const input = LLM.updateRequest(request, { model: goModel, tools, toolChoice: "none" })
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(input)
      expect("tools" in prepared.body).toBe(false)
      expect("tool_choice" in prepared.body).toBe(false)
    }),
  )

  it.effect("named function choices fail with an honest invalid_request", () =>
    Effect.gen(function* () {
      const input = LLM.updateRequest(request, {
        model: goModel,
        tools,
        toolChoice: { type: "tool", name: "extract_findings" },
      })
      const error = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(input).pipe(Effect.flip)
      expect(error.reason).toMatchObject({ _tag: "InvalidRequest" })
      expect(error.message).toContain("named tool_choice")
      expect(error.message).toContain("extract_findings")
    }),
  )

  it.effect("provider-boundary models (runtime catalog shape) hit the same policy", () =>
    Effect.gen(function* () {
      // Runtime catalogs register structural model inputs (normalizeModelInput
      // requires a non-empty provider); build the go model through that exact
      // boundary instead of route.with to prove the policy keys on it.
      const boundaryModel = normalizeModelInput({
        id: "muse-spark-1.3-contributor",
        provider: "opencode-go",
        route: OpenAIResponses.route.with({
          endpoint: { baseURL: "https://go.test/v1/" },
          auth: Auth.bearer("test"),
          provider: "opencode-go",
        }),
      })
      const input = LLM.updateRequest(request, { model: boundaryModel, tools, toolChoice: "required" })
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(input)
      expect(prepared.body.tool_choice).toBe("auto")
      expect(prepared.body.tools).toHaveLength(1)
      expect(String(boundaryModel.provider)).toBe("opencode-go")
    }),
  )

  it.effect("non-Go providers keep the exact tool_choice lowering", () =>
    Effect.gen(function* () {
      const input = LLM.updateRequest(request, { tools, toolChoice: "required" })
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(input)
      expect(prepared.body.tool_choice).toBe("required")
      expect(prepared.body.tools).toHaveLength(1)
    }),
  )
})

describe("OpenAI Responses premature EOF", () => {
  const fixtures = [
    { name: "empty body", events: [], preserved: undefined },
    {
      name: "partial text",
      events: [{ type: "response.output_text.delta", item_id: "msg_partial", delta: "Partial answer" }],
      preserved: { type: "text-delta", text: "Partial answer" },
    },
    {
      name: "partial reasoning",
      events: [{ type: "response.reasoning_summary_text.delta", item_id: "reasoning_partial", delta: "Still thinking" }],
      preserved: { type: "reasoning-delta", text: "Still thinking" },
    },
    {
      name: "incomplete tool arguments",
      events: [
        { type: "response.output_item.added", item: { type: "function_call", id: "fc_partial", call_id: "call_partial", name: "read" } },
        { type: "response.function_call_arguments.delta", item_id: "fc_partial", delta: '{"path":' },
      ],
      preserved: { type: "tool-input-delta", text: '{"path":' },
    },
    {
      name: "completed tool call",
      events: [
        { type: "response.output_item.added", item: { type: "function_call", id: "fc_done", call_id: "call_done", name: "read" } },
        { type: "response.output_item.done", item: { type: "function_call", id: "fc_done", call_id: "call_done", name: "read", arguments: '{"path":"source.ts"}' } },
      ],
      preserved: { type: "tool-call", id: "call_done", name: "read", input: { path: "source.ts" } },
    },
  ]
  for (const codex of [false, true]) {
    for (const fixture of fixtures) {
      it.effect(`reports retryable EOF after ${fixture.name} for ${codex ? "Codex" : "API-key"}`, () =>
        Effect.gen(function* () {
          const response = yield* LLMClient.generate(LLM.updateRequest(request, {
            model: (codex ? OpenAIResponses.codexRoute : OpenAIResponses.route)
              .with({ auth: Auth.bearer("test-token") })
              .model({ id: "gpt-6-astra" }),
          })).pipe(Effect.provide(fixedResponse(sseEvents(...fixture.events))))

          expect(response.events.filter((event) => event.type === "provider-error")).toEqual([
            { type: "provider-error", message: "OpenAI Responses stream ended without a terminal response event", retryable: true },
          ])
          expect(response.events.some((event) => event.type === "finish" || event.type === "step-finish")).toBe(false)
          if (fixture.preserved) expect(response.events).toContainEqual(expect.objectContaining(fixture.preserved))
        }),
      )
    }
  }
})

describe("OpenAI Responses incomplete terminal events", () => {
  for (const response of [{}, { incomplete_details: null }]) {
    it.effect(`preserves incomplete status when details are ${"incomplete_details" in response ? "null" : "absent"}`, () =>
      Effect.gen(function* () {
        const result = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(sseEvents(
          { type: "response.output_text.delta", item_id: "msg_incomplete", delta: "Incomplete answer" },
          { type: "response.incomplete", response },
        ))))
        expect(result.events.filter((event) => event.type === "finish" || event.type === "step-finish")).toEqual([
          { type: "step-finish", index: 0, reason: "unknown" },
          { type: "finish", reason: "unknown" },
        ])
        expect(result.events.some((event) => event.type === "provider-error")).toBe(false)
      }),
    )
  }
})
