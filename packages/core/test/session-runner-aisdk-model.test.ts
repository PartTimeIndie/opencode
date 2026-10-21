import { expect } from "bun:test"
import { APICallError, type LanguageModelV3, type LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { LLM, LLMEvent, Message, ToolCallPart, ToolResultPart, Usage } from "@opencode-ai/llm"
import { LLMClient, RequestExecutor } from "@opencode-ai/llm/route"
import { DateTime, Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { AIChain } from "@opencode-ai/core/ai-chain"
import { testEffect } from "./lib/effect"

const catalogModel = new ModelV2.Info({
  id: ModelV2.ID.make("grok-4.6"),
  providerID: ProviderV2.ID.make("cursor"),
  name: "Grok 4.6",
  api: { id: ModelV2.ID.make("grok-4.6"), type: "aisdk", package: "cursor" },
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  request: { headers: {}, body: {} },
  variants: [],
  time: { released: DateTime.makeUnsafe(0) },
  cost: [],
  status: "active",
  enabled: true,
  limit: { context: 100, input: 80, output: 20 },
})

const client = LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer), Layer.provide(FetchHttpClient.layer))
const { effect: it } = testEffect(client)

for (const lane of ["request", "read", "event"]) {
  for (const status of [429, 401, 403, 422, 503]) {
    it(`preserves SDK ${lane} HTTP ${status} and the complete retry deadline`, () =>
      Effect.gen(function* () {
        const error = new APICallError({
          message: "Tokens per minute limit exceeded - too many tokens processed.",
          url: "https://provider.invalid/chat?api_key=do-not-copy",
          requestBodyValues: { secret: "do-not-copy" },
          statusCode: status,
          responseHeaders: { "Retry-After": "61", "x-request-id": "req-fixture", "set-cookie": "do-not-copy" },
          responseBody:
            '{"message":"Tokens per minute limit exceeded - too many tokens processed.","type":"too_many_tokens_error","param":"quota","code":"token_quota_exceeded","api_key":"do-not-copy","echo":"do-not-copy"}',
          isRetryable: true,
        })
        const language: LanguageModelV3 = {
          specificationVersion: "v3",
          provider: "fixture",
          modelId: "fixture",
          supportedUrls: {},
          doGenerate: () => Promise.reject(new Error("unexpected generate call")),
          doStream: () =>
            lane === "request"
              ? Promise.reject(error)
              : Promise.resolve({
                  stream: new ReadableStream({
                    start(controller) {
                      if (lane === "read") return controller.error(error)
                      controller.enqueue({ type: "error", error })
                      controller.close()
                    },
                  }),
                }),
        }
        const request = LLM.request({
          model: SessionRunnerModel.fromAISDKModel(catalogModel, language),
          prompt: "test",
        })
        const events = Array.from(yield* LLMClient.stream(request).pipe(Stream.runCollect))
        const failure = events.find(LLMEvent.is.providerError)
        expect(failure).toMatchObject({
          statusCode: status,
          retryAfterMs: 61_000,
          retryable: status === 429 || status === 503,
        })
        expect(failure).toMatchObject({ responseHeaders: { "retry-after": "61", "x-request-id": "req-fixture" } })
        expect(JSON.stringify(failure)).not.toContain("do-not-copy")
        expect(AIChain.providerFailureCode(failure)).not.toBe("provider.context-overflow")
      }))
  }
}

for (const error of [
  new Error("Tokens per minute limit exceeded - too many tokens processed."),
  { message: "Tokens per minute limit exceeded - too many tokens processed." },
  new APICallError({
    message: "request rejected",
    url: "https://provider.invalid",
    requestBodyValues: {},
    statusCode: 429,
    responseBody: '{"error":{"code":"insufficient_quota"}}',
    responseHeaders: { "retry-after": "1" },
    isRetryable: true,
  }),
  new APICallError({
    message: "request rejected",
    url: "https://provider.invalid",
    requestBodyValues: {},
    statusCode: 429,
    responseBody: '{"error":{"code":"quota_exceeded"}}',
    responseHeaders: { "retry-after": "1" },
    isRetryable: true,
  }),
]) {
  it(`keeps SDK text-only TPM and permanent quota decisions: ${error instanceof Error ? error.message : error.message}`, () =>
    Effect.gen(function* () {
      const language: LanguageModelV3 = {
        specificationVersion: "v3",
        provider: "fixture",
        modelId: "fixture",
        supportedUrls: {},
        doGenerate: () => Promise.reject(new Error("unexpected generate call")),
        doStream: () => Promise.reject(error),
      }
      const events = Array.from(
        yield* LLMClient.stream(
          LLM.request({ model: SessionRunnerModel.fromAISDKModel(catalogModel, language), prompt: "test" }),
        ).pipe(Stream.runCollect),
      )
      expect(events.find(LLMEvent.is.providerError)).toMatchObject({ retryable: !(error instanceof APICallError) })
      expect(AIChain.providerFailure(events.find(LLMEvent.is.providerError))).toMatchObject({
        code: "provider.rate-limit",
        retryability: error instanceof APICallError ? "none" : "auto-retry",
      })
    }))
}

const retryHeaderCases: Record<string, string>[] = [
  { "Retry-After-Ms": "61000" },
  { "retry-after-ms": "bad", "retry-after": "61" },
  { "retry-after-ms": "", "Retry-After": "61" },
  { "Retry-After": "http-date" },
]
for (const headers of retryHeaderCases) {
  it(`preserves SDK Retry-After header forms: ${JSON.stringify(headers)}`, () =>
    Effect.gen(function* () {
      const responseHeaders =
        headers["Retry-After"] === "http-date"
          ? { "Retry-After": new Date(Math.ceil(Date.now() / 1000) * 1000 + 61_000).toUTCString() }
          : headers
      const language: LanguageModelV3 = {
        specificationVersion: "v3",
        provider: "fixture",
        modelId: "fixture",
        supportedUrls: {},
        doGenerate: () => Promise.reject(new Error("unexpected generate call")),
        doStream: () =>
          Promise.reject(
            new APICallError({
              message: "Too many requests",
              url: "https://provider.invalid",
              requestBodyValues: {},
              statusCode: 429,
              responseHeaders,
            }),
          ),
      }
      const events = Array.from(
        yield* LLMClient.stream(
          LLM.request({ model: SessionRunnerModel.fromAISDKModel(catalogModel, language), prompt: "test" }),
        ).pipe(Stream.runCollect),
      )
      const failure = events.find(LLMEvent.is.providerError)
      expect(failure?.retryAfterMs).toBeGreaterThan(59_000)
      expect(failure?.retryAfterMs).toBeLessThan(62_000)
      expect(failure?.retryable).toBe(true)
    }))
}

it("adapts a LanguageModelV3 stream into LLM events", () =>
  Effect.gen(function* () {
    const calls: LanguageModelV3CallOptions[] = []
    const language: LanguageModelV3 = {
      specificationVersion: "v3",
      provider: "cursor",
      modelId: "grok-4.6",
      supportedUrls: {},
      doGenerate: () => Promise.reject(new Error("unexpected generate call")),
      doStream: (options) => {
        calls.push(options)
        return Promise.resolve({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] })
              controller.enqueue({ type: "reasoning-start", id: "reasoning" })
              controller.enqueue({ type: "reasoning-delta", id: "reasoning", delta: "thought" })
              controller.enqueue({ type: "reasoning-end", id: "reasoning" })
              controller.enqueue({ type: "tool-input-start", id: "call-1", toolName: "echo" })
              controller.enqueue({ type: "tool-input-delta", id: "call-1", delta: '{"value":"ok"}' })
              controller.enqueue({ type: "tool-input-end", id: "call-1" })
              controller.enqueue({
                type: "tool-call",
                toolCallId: "call-1",
                toolName: "echo",
                input: '{"value":"ok"}',
              })
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "tool-calls", raw: "tool_calls" },
                usage: {
                  inputTokens: { total: 10, noCache: 7, cacheRead: 3, cacheWrite: 0 },
                  outputTokens: { total: 4, text: 1, reasoning: 3 },
                },
                providerMetadata: { cursor: { requestId: "cursor-request" } },
              })
              controller.close()
            },
          }),
        })
      },
    }

    expect(SessionRunnerModel.supported(catalogModel)).toBe(true)
    const resolved = SessionRunnerModel.fromAISDKModel(catalogModel, language)
    expect(String(resolved.provider)).toBe("cursor")
    expect(String(resolved.id)).toBe("grok-4.6")
    const request = LLM.request({
      model: resolved,
      system: "system",
      messages: [
        Message.user("use echo"),
        Message.assistant([ToolCallPart.make({ id: "call-prior", name: "echo", input: { value: "prior" } })]),
        Message.tool(
          ToolResultPart.make({
            id: "call-prior",
            name: "echo",
            result: { ok: true, nested: [1, "two", null], omitted: undefined },
          }),
        ),
      ],
      tools: [{ name: "echo", description: "Echo input", inputSchema: { type: "object" } }],
    })
    const events = Array.from(yield* LLMClient.stream(request).pipe(Stream.runCollect))

    expect(calls).toHaveLength(1)
    expect(calls[0]?.prompt).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: [{ type: "text", text: "use echo" }] },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call-prior", toolName: "echo", input: { value: "prior" } }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-prior",
            toolName: "echo",
            output: { type: "json", value: { ok: true, nested: [1, "two", null] } },
          },
        ],
      },
    ])
    expect(calls[0]?.tools).toEqual([
      { type: "function", name: "echo", description: "Echo input", inputSchema: { type: "object" } },
    ])
    expect(events.filter(LLMEvent.is.reasoningDelta).map((event) => event.text)).toEqual(["thought"])
    expect(events.filter(LLMEvent.is.toolCall).map((event) => event.input)).toEqual([{ value: "ok" }])
    expect(events.slice(-2).map((event) => event.type)).toEqual(["step-finish", "finish"])
    const usage = events.filter(LLMEvent.is.finish)[0]?.usage
    expect(usage).toBeInstanceOf(Usage)
    expect(usage?.visibleOutputTokens).toBe(1)
    expect(events.at(-2)).toEqual(
      expect.objectContaining({
        index: 0,
        reason: "tool-calls",
        usage: expect.objectContaining({ inputTokens: 10, outputTokens: 4 }),
        providerMetadata: { cursor: { requestId: "cursor-request" } },
      }),
    )
    expect(events.filter(LLMEvent.is.finish)).toEqual([
      expect.objectContaining({
        reason: "tool-calls",
        usage: expect.objectContaining({
          inputTokens: 10,
          outputTokens: 4,
          cacheReadInputTokens: 3,
          reasoningTokens: 3,
          totalTokens: 14,
        }),
      }),
    ])
  }))

it("aborts a hanging Cursor AISDK stream as soon as the consumer is interrupted", () =>
  Effect.gen(function* () {
    const abortSeen = yield* Deferred.make<void>()
    const releaseCancel = yield* Deferred.make<void>()
    const language: LanguageModelV3 = {
      specificationVersion: "v3",
      provider: "cursor",
      modelId: "grok-4.6",
      supportedUrls: {},
      doGenerate: () => Promise.reject(new Error("unexpected generate call")),
      doStream: (options) => {
        options.abortSignal?.addEventListener("abort", () => {
          Deferred.doneUnsafe(abortSeen, Effect.void)
        })
        return Promise.resolve({
          stream: new ReadableStream({
            pull() {},
            cancel() {
              return Effect.runPromise(Deferred.await(releaseCancel))
            },
          }),
        })
      },
    }

    const resolved = SessionRunnerModel.fromAISDKModel(catalogModel, language)
    const request = LLM.request({
      model: resolved,
      system: "system",
      messages: [Message.user("hang")],
      tools: [],
    })
    const fiber = yield* LLMClient.stream(request).pipe(Stream.runDrain, Effect.forkChild)
    const interrupting = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild)
    yield* Deferred.await(abortSeen)
    expect(yield* Deferred.isDone(releaseCancel)).toBeFalse()
    yield* Deferred.succeed(releaseCancel, undefined)
    yield* Fiber.join(interrupting)
  }))
