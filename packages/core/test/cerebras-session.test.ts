import { expect } from "bun:test"
import { AISDK } from "@opencode-ai/core/aisdk"
import { EventV2 } from "@opencode-ai/core/event"
import { ModelV2 } from "@opencode-ai/core/model"
import { ModelRequest } from "@opencode-ai/core/model-request"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { LLM, LLMEvent, Message, ToolCallPart, ToolResultPart } from "@opencode-ai/llm"
import { LLMClient, RequestExecutor } from "@opencode-ai/llm/route"
import { Effect, Layer } from "effect"
import { transports } from "../../provider-plugins/cerebras/src/transports"
import { CerebrasPlugin } from "./plugin/provider-packages"
import { model } from "./plugin/provider-helper"
import { testEffect } from "./lib/effect"

const it = testEffect(
  Layer.mergeAll(
    AISDK.layer.pipe(Layer.provideMerge(PluginV2.locationLayer.pipe(Layer.provide(EventV2.defaultLayer)))),
    LLMClient.layer.pipe(Layer.provide(RequestExecutor.defaultLayer)),
  ),
)

function fixture(providerID = "cerebras") {
  const bodies: unknown[] = []
  const authorizations: (string | null)[] = []
  const selected = model(providerID, "qwen-3.8-27b", {
    api: { id: ModelV2.ID.make("qwen-3.8-27b"), type: "aisdk", package: "@ai-sdk/cerebras" },
    request: {
      headers: {},
      body: {
        apiKey: "fixture-key",
        fetch: async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const body = JSON.parse(String(init?.body))
          bodies.push(body)
          authorizations.push(new Headers(init?.headers).get("authorization"))
          // Model the API's strict field validation instead of accepting a malformed request.
          if (JSON.stringify(body.messages).includes('"reasoning_content"'))
            return Response.json(
              {
                message: "assistant.reasoning_content is unsupported",
                type: "invalid_request_error",
                param: "messages",
                code: "unsupported",
              },
              { status: 422 },
            )
          const deltas =
            bodies.length === 1
              ? [
                  { reasoning: "Let me " },
                  { reasoning: "inspect." },
                  {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call-echo",
                        type: "function",
                        function: { name: "echo", arguments: '{"text":"once"}' },
                      },
                    ],
                  },
                ]
              : [{ content: "Done." }]
          return new Response(
            [
              ...deltas.map((delta) => ({ choices: [{ index: 0, delta, finish_reason: null }] })),
              {
                choices: [{ index: 0, delta: {}, finish_reason: bodies.length === 1 ? "tool_calls" : "stop" }],
                usage: {
                  prompt_tokens: 10,
                  completion_tokens: 4,
                  total_tokens: 14,
                  completion_tokens_details: { reasoning_tokens: 3 },
                },
              },
            ]
              .map(
                (chunk) =>
                  `data: ${JSON.stringify({ id: "fixture", model: "qwen-3.8-27b", created: 0, ...chunk })}\n\n`,
              )
              .join("") + "data: [DONE]\n\n",
            { headers: { "content-type": "text/event-stream" } },
          )
        },
      },
    },
  })
  return { selected, bodies, authorizations }
}

for (const providerID of ["cerebras", "custom-cerebras"]) {
  it.effect(`V2 ${providerID} SDK continues reasoning and tool history without unsupported fields`, () =>
    Effect.gen(function* () {
      yield* (yield* PluginV2.Service).add(CerebrasPlugin)
      const input = fixture(providerID)
      const language = yield* (yield* AISDK.Service).language(input.selected)
      const selected = SessionRunnerModel.fromAISDKModel(input.selected, language)
      const first = yield* LLM.generate(
        LLM.request({
          model: selected,
          system: "Help the user",
          prompt: "Use echo",
          tools: [
            {
              name: "echo",
              description: "Echo text",
              inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
            },
          ],
        }),
      )
      expect(first.reasoning).toBe("Let me inspect.")
      expect(first.toolCalls).toMatchObject([{ id: "call-echo", name: "echo", input: { text: "once" } }])
      const next = yield* LLM.generate(
        LLM.request({
          model: selected,
          messages: [
            Message.user("Use echo"),
            Message.assistant([
              { type: "reasoning", text: first.reasoning },
              ToolCallPart.make({ id: "call-echo", name: "echo", input: { text: "once" } }),
            ]),
            Message.tool(
              ToolResultPart.make({ id: "call-echo", name: "echo", result: { type: "text", value: "once" } }),
            ),
          ],
        }),
      )
      expect(next.text).toBe("Done.")
      expect(input.bodies).toHaveLength(2)
      expect(input.bodies[1]).toMatchObject({
        messages: [
          { role: "user", content: "Use echo" },
          {
            role: "assistant",
            reasoning: "Let me inspect.",
            tool_calls: [{ id: "call-echo", function: { name: "echo", arguments: '{"text":"once"}' } }],
          },
          { role: "tool", tool_call_id: "call-echo", content: "once" },
        ],
      })
      for (const body of input.bodies) {
        expect(body).not.toHaveProperty("stream_options")
        expect(body).not.toHaveProperty("store")
        expect(JSON.stringify(body)).not.toContain('"reasoning_content"')
      }
      expect(input.authorizations).toEqual(["Bearer fixture-key", "Bearer fixture-key"])
    }),
  )
}

for (const effort of ["none", "low", "medium", "high"]) {
  it.effect(`V2 Cerebras forwards the configured ${effort} reasoning effort to the actual SDK request`, () =>
    Effect.gen(function* () {
      yield* (yield* PluginV2.Service).add(CerebrasPlugin)
      const input = fixture()
      const profiles = CerebrasPlugin.requestProfiles
      const normalized = ModelRequest.normalizeAiSdkOptions("@ai-sdk/cerebras", { reasoningEffort: effort }, profiles)
      expect(normalized.options).toEqual({ reasoningEffort: effort })
      expect(normalized.body).toEqual({})
      const selected = new ModelV2.Info({
        ...input.selected,
        request: { ...input.selected.request, options: normalized.options },
      })
      const language = yield* (yield* AISDK.Service).language(selected)
      yield* LLM.generate(
        LLM.request({ model: SessionRunnerModel.fromAISDKModel(selected, language, profiles), prompt: "Explain" }),
      )
      expect(input.bodies).toHaveLength(1)
      expect(input.bodies[0]).toMatchObject({ reasoning_effort: effort })
    }),
  )
}

it.live("V2 Cerebras sends corrected history over real HTTP with the default fetch", () =>
  Effect.gen(function* () {
    const requests: { path: string; authorization: string | null; body: unknown }[] = []
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            const body: unknown = await request.json()
            requests.push({
              path: new URL(request.url).pathname,
              authorization: request.headers.get("authorization"),
              body,
            })
            if (JSON.stringify(body).includes('"reasoning_content"'))
              return Response.json(
                {
                  message: "reasoning_content is unsupported",
                  type: "invalid_request_error",
                  param: "messages",
                  code: "unsupported",
                },
                { status: 422 },
              )
            return new Response(
              'data: {"id":"http-fixture","created":0,"model":"qwen-3.8-27b","choices":[{"index":0,"delta":{"reasoning":"Checked."},"finish_reason":null}]}\n\ndata: {"id":"http-fixture","created":0,"model":"qwen-3.8-27b","choices":[{"index":0,"delta":{"content":"Done."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
              { headers: { "content-type": "text/event-stream" } },
            )
          },
        }),
      ),
      (server) => Effect.promise(() => server.stop(true)),
    )
    yield* (yield* PluginV2.Service).add(CerebrasPlugin)
    const selected = model("cerebras", "qwen-3.8-27b", {
      api: {
        id: ModelV2.ID.make("qwen-3.8-27b"),
        type: "aisdk",
        package: "@ai-sdk/cerebras",
        url: `http://127.0.0.1:${server.port}/v1`,
      },
      request: { headers: {}, body: { apiKey: "http-fixture-key" } },
    })
    const language = yield* (yield* AISDK.Service).language(selected)
    const result = yield* LLM.generate(
      LLM.request({
        model: SessionRunnerModel.fromAISDKModel(selected, language),
        messages: [
          Message.user("Inspect"),
          Message.assistant([
            { type: "reasoning", text: "Prior reasoning" },
            ToolCallPart.make({ id: "call-prior", name: "echo", input: { text: "once" } }),
          ]),
          Message.tool(
            ToolResultPart.make({ id: "call-prior", name: "echo", result: { type: "text", value: "once" } }),
          ),
          Message.user("Continue"),
        ],
      }),
    )
    expect(result.text).toBe("Done.")
    expect(result.reasoning).toBe("Checked.")
    expect(result.events.filter(LLMEvent.is.providerError)).toEqual([])
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      path: "/v1/chat/completions",
      authorization: "Bearer http-fixture-key",
      body: {
        messages: [
          { role: "user", content: "Inspect" },
          { role: "assistant", reasoning: "Prior reasoning", tool_calls: [{ id: "call-prior" }] },
          { role: "tool", tool_call_id: "call-prior", content: "once" },
          { role: "user", content: "Continue" },
        ],
      },
    })
  }),
)

it.effect("legacy Cerebras transport serializes reasoning-only history and preserves custom fetch", () =>
  Effect.gen(function* () {
    const input = fixture()
    const transport = transports["@ai-sdk/cerebras"]
    if (!transport) throw new Error("Missing Cerebras transport")
    const sdk = yield* Effect.promise(() => transport({ name: "cerebras", ...input.selected.request.body }))
    const language = sdk.languageModel?.("qwen-3.8-27b")
    if (!language) throw new Error("Missing Cerebras language model")
    const selected = SessionRunnerModel.fromAISDKModel(input.selected, language)
    yield* LLM.generate(
      LLM.request({
        model: selected,
        messages: [Message.assistant([{ type: "reasoning", text: "Earlier reasoning" }]), Message.user("Continue")],
      }),
    )
    expect(input.bodies).toHaveLength(1)
    expect(input.bodies[0]).toMatchObject({
      messages: [
        { role: "assistant", reasoning: "Earlier reasoning" },
        { role: "user", content: "Continue" },
      ],
    })
    expect(input.authorizations).toEqual(["Bearer fixture-key"])
  }),
)
