import { expect, test } from "bun:test"
import { AuthenticationReason, InvalidRequestReason, LLM, LLMError, LLMEvent, LLMRequest, Model } from "@opencode-ai/llm"
import { Database } from "@opencode-ai/core/database/database"
import { route } from "@opencode-ai/llm/protocols/openai-chat"
import { OpenAIResponses } from "@opencode-ai/llm/protocols"
import { LLMClient, RequestExecutor } from "@opencode-ai/llm/route"
import { Cause, DateTime, Effect, Exit, Fiber, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import { testEffect } from "./lib/effect"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { Token } from "@opencode-ai/core/util/token"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { toLLMMessages } from "@opencode-ai/core/session/runner/to-llm-message"

test("compaction describes tool media without embedding base64", () => {
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
  const serialized = SessionCompaction.serializeToolContent([
    { type: "text", text: "Image read successfully" },
    {
      type: "file",
      uri: `data:image/png;base64,${base64}`,
      mime: "image/png",
      name: "pixel.png",
    },
  ])

  expect(serialized).toBe("Image read successfully\n[Attached image/png: pixel.png]")
  expect(serialized).not.toContain(base64)
})

test("runner history follows the provider input window without a host cap", () => {
  const largeModel = Model.make({
    id: "large-context-model",
    provider: "openrouter",
    route: route.with({ limits: { context: 2_000_000, input: 1_500_000 } }),
  })
  const smallModel = Model.make({
    id: "small-context-model",
    provider: "openrouter",
    route: route.with({ limits: { context: 120_000, input: 90_000 } }),
  })

  expect(SessionCompaction.runnerHistoryTokenLimit(largeModel)).toBe(1_500_000)
  expect(SessionCompaction.runnerHistoryTokenLimit(smallModel)).toBe(90_000)

  const entries = [1, 2, 3].map((index) => ({
    seq: index,
    message: new SessionMessage.User({
      id: SessionMessage.ID.make(`msg_runner_history_${index}`),
      type: "user" as const,
      text: `Message ${index}`,
      time: { created: DateTime.makeUnsafe(index) },
    }),
  }))
  const maxTokens = Token.estimateFootprint(toLLMMessages([entries[2].message], largeModel)) + 1
  const bounded = SessionCompaction.boundRunnerHistory(entries, maxTokens, largeModel)

  expect(bounded.omittedEntries).toBe(2)
  expect(bounded.entries.map((entry) => entry.seq)).toEqual([3])
})

test("runner history does not compact 170 turns because of storage-only tool copies", () => {
  const model = Model.make({ id: "history-budget", provider: "openai", route })
  const entries = Array.from({ length: 170 }, (_, index) => [
    {
      seq: index * 2,
      message: new SessionMessage.User({
        id: SessionMessage.ID.make(`msg_history_user_${index}`),
        type: "user",
        text: `Continue step ${index}`,
        time: { created: DateTime.makeUnsafe(index) },
      }),
    },
    {
      seq: index * 2 + 1,
      message: new SessionMessage.Assistant({
        id: SessionMessage.ID.make(`msg_history_tool_${index}`),
        type: "assistant",
        agent: "build",
        model: { id: ModelV2.ID.make(model.id), providerID: ProviderV2.ID.make(model.provider) },
        time: { created: DateTime.makeUnsafe(index) },
        content: [
          new SessionMessage.AssistantTool({
            type: "tool",
            id: `call_${index}`,
            name: "read",
            time: { created: DateTime.makeUnsafe(index) },
            state: new SessionMessage.ToolStateCompleted({
              status: "completed",
              input: { path: "source.ts" },
              content: [{ type: "text", text: "source line\n".repeat(300) }],
              structured: { content: "source line\n".repeat(300), diagnostics: "storage only".repeat(500) },
              outputPaths: [],
            }),
          }),
        ],
      }),
    },
  ]).flat()
  expect(Token.estimateFootprint(entries)).toBeGreaterThan(300_000)
  expect(
    Token.estimateFootprint(
      toLLMMessages(
        entries.map((entry) => entry.message),
        model,
      ),
    ),
  ).toBeLessThan(300_000)
  const original = JSON.stringify(entries)
  const bounded = SessionCompaction.boundRunnerHistory(entries, 300_000, model)
  expect(bounded.omittedEntries).toBe(0)
  expect(bounded.entries).toBe(entries)
  expect(JSON.stringify(entries)).toBe(original)
})

test.each(["content", "structured", "provider-result", "reasoning"])(
  "runner history still budgets large replayed %s",
  (source) => {
    const model = Model.make({ id: "history-budget", provider: "openai", route })
    const text = "x".repeat(1_240_000)
    const entries = [
      {
        seq: 0,
        message: new SessionMessage.User({
          id: SessionMessage.ID.make("msg_history_before_large"),
          type: "user",
          text: "Earlier task",
          time: { created: DateTime.makeUnsafe(0) },
        }),
      },
      {
        seq: 1,
        message: new SessionMessage.Assistant({
          id: SessionMessage.ID.make("msg_history_large"),
          type: "assistant",
          agent: "build",
          model: { id: ModelV2.ID.make(model.id), providerID: ProviderV2.ID.make(model.provider) },
          time: { created: DateTime.makeUnsafe(1) },
          content:
            source === "reasoning"
              ? [
                  new SessionMessage.AssistantReasoning({
                    type: "reasoning",
                    id: "reasoning",
                    text: "Thinking",
                    providerMetadata: { openai: { reasoningEncryptedContent: text } },
                  }),
                ]
              : [
                  new SessionMessage.AssistantTool({
                    type: "tool",
                    id: "call",
                    name: "read",
                    time: { created: DateTime.makeUnsafe(1) },
                    provider: { executed: source === "provider-result" },
                    state: new SessionMessage.ToolStateCompleted({
                      status: "completed",
                      input: {},
                      outputPaths: [],
                      content: source === "content" ? [{ type: "text", text }] : [],
                      structured: source === "structured" ? { text } : {},
                      ...(source === "provider-result" ? { result: { type: "text", value: text } } : {}),
                    }),
                  }),
                ],
        }),
      },
    ]
    const bounded = SessionCompaction.boundRunnerHistory(entries, 300_000, model)
    expect(bounded.estimatedTokens).toBeGreaterThan(300_000)
    expect(bounded.omittedEntries).toBe(1)
    expect(bounded.entries).toEqual([entries[1]])
  },
)

test("openai responses reserves its hidden request envelope", () => {
  const model = Model.make({
    id: "gpt-5.6-terra",
    provider: "openai",
    route: OpenAIResponses.route.with({ limits: { context: 1_000_000, output: 32_000 } }),
  })
  const request = LLM.request({ model, messages: [], tools: [] })

  expect(SessionCompaction.inputTokenLimit({ model, request })).toBe(400_000)
  expect(
    SessionCompaction.exceedsInputTokenLimit({
      sessionID: SessionSchema.ID.make("ses_openai_responses_limit"),
      model,
      request,
      entries: [],
      contextEstimateTokens: 491_188,
    }),
  ).toBe(true)

  const uncatalogued = Model.make({ id: "gpt-5.6-terra", provider: "openai", route: OpenAIResponses.route })
  const uncataloguedRequest = LLM.request({ model: uncatalogued, messages: [], tools: [] })
  expect(SessionCompaction.inputTokenLimit({ model: uncatalogued, request: uncataloguedRequest })).toBe(400_000)
})

test("dynamic router output capacity does not consume its entire input budget", () => {
  const model = Model.make({
    id: "openrouter/auto",
    provider: "openrouter",
    route: route.with({ limits: { context: 2_000_000, output: 2_000_000 } }),
  })
  const request = LLM.request({ model, messages: [], tools: [] })

  expect(SessionCompaction.outputTokenReserve({ model, request })).toBe(0)
  expect(SessionCompaction.inputTokenLimit({ model, request })).toBe(2_000_000)
  const capped = LLM.request({ model, messages: [], tools: [], generation: { maxTokens: 32_000 } })
  expect(SessionCompaction.outputTokenReserve({ model, request: capped })).toBe(32_000)
  expect(SessionCompaction.inputTokenLimit({ model, request: capped })).toBe(1_968_000)
  expect(
    SessionCompaction.exceedsInputTokenLimit({
      sessionID: SessionSchema.ID.make("ses_openrouter_auto_budget"),
      model,
      request,
      entries: [],
      contextEstimateTokens: 35_747,
    }),
  ).toBe(false)
  expect(
    SessionCompaction.exceedsInputTokenLimit({
      sessionID: SessionSchema.ID.make("ses_openrouter_auto_overflow"),
      model,
      request,
      entries: [],
      contextEstimateTokens: 2_000_001,
    }),
  ).toBe(true)
})

test("catalogued openai responses limits retain the safe provider ceiling", () => {
  const model = Model.make({
    id: "gpt-5.6-sol",
    provider: "openai",
    route: OpenAIResponses.route.with({ limits: { context: 1_050_000, input: 922_000, output: 128_000 } }),
  })
  const request = LLM.request({ model, messages: [], tools: [] })

  expect(SessionCompaction.outputTokenReserve({ model, request })).toBe(0)
  expect(SessionCompaction.inputTokenLimit({ model, request })).toBe(400_000)
  expect(
    SessionCompaction.exceedsInputTokenLimit({
      sessionID: SessionSchema.ID.make("ses_gpt56_sol_budget"),
      model,
      request,
      entries: [],
      contextEstimateTokens: 400_001,
    }),
  ).toBe(true)
  expect(
    SessionCompaction.exceedsInputTokenLimit({
      sessionID: SessionSchema.ID.make("ses_gpt56_sol_overflow"),
      model,
      request,
      entries: [],
      contextEstimateTokens: 399_999,
    }),
  ).toBe(false)
})

test("openai chat keeps its catalogued input limit", () => {
  const model = Model.make({
    id: "gpt-5.6-sol",
    provider: "openai",
    route: route.with({ limits: { context: 1_050_000, input: 922_000, output: 128_000 } }),
  })

  expect(SessionCompaction.inputTokenLimit({ model, request: LLM.request({ model, messages: [], tools: [] }) })).toBe(
    922_000,
  )
})

test("other providers using openai responses keep their catalogued input limit", () => {
  const model = Model.make({
    id: "grok-4.3",
    provider: "xai",
    route: OpenAIResponses.route.with({ limits: { context: 1_000_000, input: 900_000, output: 100_000 } }),
  })

  expect(SessionCompaction.inputTokenLimit({ model, request: LLM.request({ model, messages: [], tools: [] }) })).toBe(
    900_000,
  )
})

test("catalog output capacity does not cause premature deepseek compaction", () => {
  const model = Model.make({
    id: "deepseek-v4-flash-free",
    provider: "opencode",
    route: route.with({ limits: { context: 200_000, output: 128_000 } }),
  })
  const request = LLM.request({ model, messages: [], tools: [] })

  expect(SessionCompaction.outputTokenReserve({ model, request })).toBe(0)
  expect(SessionCompaction.inputTokenLimit({ model, request })).toBe(200_000)
  expect(
    SessionCompaction.exceedsInputTokenLimit({
      sessionID: SessionSchema.ID.make("ses_deepseek_catalog_output_capacity"),
      model,
      request,
      entries: [],
      contextEstimateTokens: 180_001,
    }),
  ).toBe(false)

  const capped = LLM.request({ model, messages: [], tools: [], generation: { maxTokens: 128_000 } })
  expect(SessionCompaction.outputTokenReserve({ model, request: capped })).toBe(128_000)
  expect(SessionCompaction.inputTokenLimit({ model, request: capped })).toBe(72_000)
})

test("compaction summary respects the effective provider input budget", async () => {
  let prompt = ""
  const compaction = SessionCompaction.make({
    config: [],
    events: { publish: () => Effect.succeed({ seq: 1 }) } as never,
    llm: {
      stream: (request) => {
        prompt = JSON.stringify(request.messages)
        return Stream.make(
          LLMEvent.textStart({ id: "text" }),
          LLMEvent.textDelta({ id: "text", text: "summary" }),
          LLMEvent.textEnd({ id: "text" }),
          LLMEvent.finish({ reason: "stop" }),
        )
      },
    },
  })
  const model = Model.make({
    id: "gpt-5.6-sol",
    provider: "openai",
    route: OpenAIResponses.route.with({ limits: { context: 1_050_000, input: 922_000, output: 128_000 } }),
  })

  expect(
    await Effect.runPromise(
      compaction.compactAfterOverflow({
        sessionID: SessionSchema.ID.make("ses_compaction_provider_budget"),
        model,
        request: LLM.request({ model, messages: [], tools: [] }),
        entries: [
          {
            seq: 1,
            message: new SessionMessage.User({
              id: SessionMessage.ID.make("msg_compaction_provider_budget_history"),
              type: "user",
              text: "Earlier context ".repeat(120_000),
              time: { created: DateTime.makeUnsafe(1) },
            }),
          },
          {
            seq: 2,
            message: new SessionMessage.User({
              id: SessionMessage.ID.make("msg_compaction_provider_budget_replay"),
              type: "user",
              text: "Continue",
              time: { created: DateTime.makeUnsafe(2) },
            }),
          },
        ],
      }),
    ),
  ).toBe(true)
  expect(Token.estimate(prompt)).toBeLessThanOrEqual(380_100)
  expect(prompt).toContain("Earlier context omitted")
})

test("compaction summary retries transient provider stream failures", async () => {
  let calls = 0
  const compaction = SessionCompaction.make({
    config: [],
    events: { publish: () => Effect.succeed({ seq: 1 }) } as never,
    llm: {
      stream: () => {
        calls++
        // Mirrors the GLM symptom: the SSE connection drops after partial text
        // without a finish reason. The protocol marks it retryable, so the
        // summary request must be re-issued instead of failing compaction.
        if (calls === 1)
          return Stream.make(
            LLMEvent.textDelta({ id: "text", text: "partial summary before the drop" }),
            LLMEvent.providerError({
              message: "OpenAI Chat stream ended without a finish reason",
              retryable: true,
              retryAfterMs: 0,
            }),
          )
        return Stream.make(
          LLMEvent.textStart({ id: "text" }),
          LLMEvent.textDelta({ id: "text", text: "recovered summary" }),
          LLMEvent.textEnd({ id: "text" }),
          LLMEvent.finish({ reason: "stop" }),
        )
      },
    },
  })
  const model = Model.make({
    id: "glm-5.3",
    provider: "zhipuai-coding-plan",
    route: route.with({ limits: { context: 1_050_000, input: 922_000, output: 128_000 } }),
  })

  expect(
    await Effect.runPromise(
      compaction.compactAfterOverflow({
        sessionID: SessionSchema.ID.make("ses_compaction_retry_transient"),
        model,
        request: LLM.request({ model, messages: [], tools: [] }),
        entries: [
          {
            seq: 1,
            message: new SessionMessage.User({
              id: SessionMessage.ID.make("msg_compaction_retry_transient_history"),
              type: "user",
              text: "Earlier context ".repeat(120_000),
              time: { created: DateTime.makeUnsafe(1) },
            }),
          },
          {
            seq: 2,
            message: new SessionMessage.User({
              id: SessionMessage.ID.make("msg_compaction_retry_transient_replay"),
              type: "user",
              text: "Continue",
              time: { created: DateTime.makeUnsafe(2) },
            }),
          },
        ],
      }),
    ),
  ).toBe(true)
  expect(calls).toBe(2)
})

for (const retryAfterMs of [20_000, 600_000]) {
  testEffect(EventV2.layer.pipe(Layer.provide(Database.layerFromPath(":memory:")))).effect(
    `summary Retry-After: ${retryAfterMs > 300_000 ? "defers excessive automatic wait" : "never retries before the full deadline"}`,
    () => Effect.gen(function* () {
      let calls = 0
      const events = yield* EventV2.Service
      const compaction = SessionCompaction.make({
        config: [], events,
        llm: { stream: () => {
          calls++
          return calls === 1
            ? Stream.succeed(LLMEvent.providerError({ message: "rate limit fixture", retryable: true, retryAfterMs }))
            : Stream.make(LLMEvent.textDelta({ id: "summary", text: "Recovered summary" }), LLMEvent.finish({ reason: "stop" }))
        } },
      })
      const model = Model.make({ id: "summary-fixture", provider: "fixture", route: route.with({ limits: { context: 1_000_000 } }) })
      const fiber = yield* compaction.compactAfterOverflow({
        sessionID: SessionSchema.ID.make("ses_summary_deadline"), model,
        request: LLM.request({ model, messages: [], tools: [] }),
        entries: [{ seq: 1, message: new SessionMessage.User({
          id: SessionMessage.ID.make("msg_summary_deadline"), type: "user",
          text: "Earlier context ".repeat(4_000), time: { created: DateTime.makeUnsafe(1) },
        }) }],
      }).pipe(Effect.exit, Effect.forkChild)
      yield* TestClock.adjust(10_000)
      expect(calls).toBe(1)
      if (retryAfterMs > 300_000) {
        const exit = yield* Fiber.join(fiber)
        expect(exit).toMatchObject({ _tag: "Failure" })
        if (exit._tag === "Failure") expect(Cause.pretty(exit.cause)).toContain("retry-deferred")
        return
      }
      yield* TestClock.adjust(10_000)
      expect(yield* Fiber.join(fiber)).toMatchObject({ _tag: "Success", value: true })
      expect(calls).toBe(2)
    }),
  )
}

test("compaction accounts for hidden provider metadata when selecting retained history", async () => {
  let prompt = ""
  const compaction = SessionCompaction.make({
    config: [],
    events: { publish: () => Effect.succeed({ seq: 1 }) } as never,
    llm: {
      stream: (request) => {
        prompt = JSON.stringify(request.messages)
        return Stream.make(LLMEvent.textDelta({ id: "text", text: "summary" }), LLMEvent.finish({ reason: "stop" }))
      },
    },
  })
  const model = Model.make({
    id: "gpt-5.6-sol",
    provider: "openai",
    route: OpenAIResponses.route.with({ limits: { context: 1_050_000, input: 922_000, output: 128_000 } }),
  })

  expect(
    await Effect.runPromise(
      compaction.compactAfterOverflow({
        sessionID: SessionSchema.ID.make("ses_compaction_hidden_metadata"),
        model,
        request: LLM.request({ model, messages: [], tools: [] }),
        entries: [
          {
            seq: 1,
            message: new SessionMessage.User({
              id: SessionMessage.ID.make("msg_compaction_hidden_metadata_history"),
              type: "user",
              text: "Important earlier request",
              time: { created: DateTime.makeUnsafe(1) },
            }),
          },
          {
            seq: 2,
            message: new SessionMessage.Assistant({
              id: SessionMessage.ID.make("msg_compaction_hidden_metadata_assistant"),
              type: "assistant",
              agent: "build",
              model: { id: ModelV2.ID.make("gpt-5.6-sol"), providerID: ProviderV2.ID.make("openai") },
              content: [
                new SessionMessage.AssistantReasoning({
                  type: "reasoning",
                  id: "reasoning-hidden-metadata",
                  text: "Visible conclusion",
                  providerMetadata: { openai: { reasoningEncryptedContent: "x".repeat(80_000) } },
                }),
              ],
              time: { created: DateTime.makeUnsafe(2), completed: DateTime.makeUnsafe(3) },
            }),
          },
          {
            seq: 3,
            message: new SessionMessage.User({
              id: SessionMessage.ID.make("msg_compaction_hidden_metadata_replay"),
              type: "user",
              text: "Continue",
              time: { created: DateTime.makeUnsafe(4) },
            }),
          },
        ],
      }),
    ),
  ).toBe(true)
  expect(prompt).toContain("Important earlier request")
  expect(prompt).toContain("Visible conclusion")
  expect(prompt).not.toContain("x".repeat(100))
})

test("compaction retries a rejected summary with a smaller context", async () => {
  const promptSizes: number[] = []
  let ended = 0
  const compaction = SessionCompaction.make({
    config: [],
    events: {
      publish: (event: { readonly type: string }) => {
        if (event.type === SessionEvent.Compaction.Ended.type) ended++
        return Effect.succeed({ seq: 1 })
      },
    } as never,
    llm: {
      stream: (request) => {
        promptSizes.push(Token.estimate(JSON.stringify(request.messages)))
        if (promptSizes.length === 1)
          return Stream.make(
            LLMEvent.providerError({ message: "too large", classification: "context-overflow" }),
            LLMEvent.finish({ reason: "stop" }),
          )
        return Stream.make(LLMEvent.textDelta({ id: "text", text: "summary" }), LLMEvent.finish({ reason: "stop" }))
      },
    },
  })
  const model = Model.make({
    id: "gpt-5.6-sol",
    provider: "openai",
    route: OpenAIResponses.route.with({ limits: { context: 1_050_000, input: 922_000, output: 128_000 } }),
  })

  expect(
    await Effect.runPromise(
      compaction.compactAfterOverflow({
        sessionID: SessionSchema.ID.make("ses_compaction_summary_retry"),
        model,
        request: LLM.request({ model, messages: [], tools: [] }),
        entries: [
          {
            seq: 1,
            message: new SessionMessage.User({
              id: SessionMessage.ID.make("msg_compaction_summary_retry_history"),
              type: "user",
              text: "Earlier context ".repeat(120_000),
              time: { created: DateTime.makeUnsafe(1) },
            }),
          },
          {
            seq: 2,
            message: new SessionMessage.User({
              id: SessionMessage.ID.make("msg_compaction_summary_retry_replay"),
              type: "user",
              text: "Continue",
              time: { created: DateTime.makeUnsafe(2) },
            }),
          },
        ],
      }),
    ),
  ).toBe(true)
  expect(promptSizes).toHaveLength(2)
  expect(promptSizes[1]).toBeLessThan(promptSizes[0])
  expect(ended).toBe(1)
})

test("compaction retries without max output tokens when the provider rejects the parameter", async () => {
  const outputLimits: Array<number | undefined> = []
  const compaction = SessionCompaction.make({
    config: [],
    events: { publish: () => Effect.succeed({ seq: 1 }) } as never,
    llm: {
      stream: (request) => {
        outputLimits.push(request.generation?.maxTokens)
        if (outputLimits.length === 1)
          return Stream.fail(
            new LLMError({
              module: "RequestExecutor",
              method: "execute",
              reason: new InvalidRequestReason({
                message: 'Provider request failed with HTTP 400: {"detail":"Unsupported parameter: max_output_tokens"}',
              }),
            }),
          )
        return Stream.make(LLMEvent.textDelta({ id: "text", text: "summary" }), LLMEvent.finish({ reason: "stop" }))
      },
    },
  })
  const model = Model.make({
    id: "gpt-5.6-sol",
    provider: "openai",
    route: OpenAIResponses.route.with({ limits: { context: 1_050_000, input: 922_000, output: 128_000 } }),
  })

  expect(
    await Effect.runPromise(
      compaction.compactAfterOverflow({
        sessionID: SessionSchema.ID.make("ses_compaction_output_limit_retry"),
        model,
        request: LLM.request({ model, messages: [], tools: [] }),
        entries: [
          {
            seq: 1,
            message: new SessionMessage.User({
              id: SessionMessage.ID.make("msg_compaction_output_limit_retry_history"),
              type: "user",
              text: "Earlier context ".repeat(3_000),
              time: { created: DateTime.makeUnsafe(1) },
            }),
          },
          {
            seq: 2,
            message: new SessionMessage.User({
              id: SessionMessage.ID.make("msg_compaction_output_limit_retry_replay"),
              type: "user",
              text: "Continue",
              time: { created: DateTime.makeUnsafe(2) },
            }),
          },
        ],
      }),
    ),
  ).toBe(true)
  expect(outputLimits).toEqual([128_000, undefined])
})

test("automatic compaction uses the runner-provided footprint estimate", async () => {
  let streams = 0
  const compaction = SessionCompaction.make({
    config: [{ type: "document", path: "test", info: { compaction: { buffer: 10, keep: { tokens: 1 } } } }],
    events: {
      publish: () => Effect.succeed({ seq: 1 }),
    } as never,
    llm: {
      stream: () => {
        streams++
        return Stream.make(
          LLMEvent.textStart({ id: "text" }),
          LLMEvent.textDelta({ id: "text", text: "summary" }),
          LLMEvent.textEnd({ id: "text" }),
          LLMEvent.finish({ reason: "stop" }),
        )
      },
    },
  })
  const model = Model.make({
    id: "model",
    provider: "provider",
    route: route.with({ limits: { context: 100_000, output: 100 } }),
  })
  const input = {
    sessionID: SessionSchema.ID.make("ses_compaction_precomputed_estimate"),
    model,
    request: LLM.request({ model, messages: [], tools: [] }),
    entries: [
      {
        seq: 1,
        message: new SessionMessage.User({
          id: SessionMessage.ID.make("msg_compaction_precomputed_estimate"),
          type: "user" as const,
          text: "Older context that must be summarized",
          time: { created: DateTime.makeUnsafe(1) },
        }),
      },
    ],
  }

  expect(await Effect.runPromise(compaction.compactIfNeeded({ ...input, contextEstimateTokens: 0 }))).toBe(false)
  expect(streams).toBe(0)
  expect(await Effect.runPromise(compaction.compactIfNeeded({ ...input, contextEstimateTokens: 100_000 }))).toBe(true)
  expect(streams).toBe(1)
})

test("compaction retries a structurally invalid summary before publishing it", async () => {
  let streams = 0
  let ended = 0
  const valid = `## Goal
- Keep context

## Constraints & Preferences
- (none)

## Progress
### Done
- (none)

### In Progress
- Compacting

### Blocked
- (none)

## Key Decisions
- Preserve structure

## Next Steps
- Continue

## Critical Context
- Exact facts

## Relevant Files
- packages/core/src/session/compaction.ts`
  const compaction = SessionCompaction.make({
    config: [{ type: "document", path: "test", info: { compaction: { quality: true, keep: { tokens: 1 } } } }],
    events: {
      publish: (definition: { readonly type: string }) =>
        Effect.sync(() => {
          if (definition.type === SessionEvent.Compaction.Ended.type) ended++
          return { seq: 1 }
        }),
    } as never,
    llm: {
      stream: () => {
        streams++
        return Stream.make(
          LLMEvent.textStart({ id: "text" }),
          LLMEvent.textDelta({ id: "text", text: streams === 1 ? "invalid summary" : valid }),
          LLMEvent.textEnd({ id: "text" }),
          LLMEvent.finish({ reason: "stop" }),
        )
      },
    },
  })
  const model = Model.make({
    id: "model",
    provider: "provider",
    route: route.with({ limits: { context: 100_000, output: 1_000 } }),
  })

  expect(
    await Effect.runPromise(
      compaction.compactAfterOverflow({
        sessionID: SessionSchema.ID.make("ses_compaction_quality"),
        model,
        request: LLM.request({ model, messages: [], tools: [] }),
        entries: [
          {
            seq: 1,
            message: new SessionMessage.User({
              id: SessionMessage.ID.make("msg_compaction_quality"),
              type: "user",
              text: "older context ".repeat(100),
              time: { created: DateTime.makeUnsafe(1) },
            }),
          },
        ],
      }),
    ),
  ).toBe(true)
  expect(streams).toBe(2)
  expect(ended).toBe(1)
  expect(SessionCompaction.validSummary(valid)).toBe(true)
})

test("only accepts an AbortError after the compaction stream completed", async () => {
  let ended = 0
  let completed = true
  const compaction = SessionCompaction.make({
    config: [{ type: "document", path: "test", info: { compaction: { keep: { tokens: 1 } } } }],
    streamIdleTimeouts: { initialMs: 10, afterProgressMs: 10 },
    events: {
      publish: (definition: { readonly type: string }) =>
        Effect.sync(() => {
          if (definition.type === SessionEvent.Compaction.Ended.type) ended++
          return { seq: 1 }
        }),
    } as never,
    llm: {
      stream: () => {
        const aborted = Stream.die(new DOMException("This operation was aborted", "AbortError"))
        if (!completed) return aborted
        return Stream.make(
          LLMEvent.textStart({ id: "text" }),
          LLMEvent.textDelta({ id: "text", text: "completed summary" }),
          LLMEvent.textEnd({ id: "text" }),
          LLMEvent.finish({ reason: "stop" }),
        ).pipe(Stream.concat(aborted))
      },
    },
  })
  const model = Model.make({
    id: "model",
    provider: "provider",
    route: route.with({ limits: { context: 100_000, output: 1_000 } }),
  })

  const input = {
    sessionID: SessionSchema.ID.make("ses_compaction_cleanup_abort"),
    model,
    request: LLM.request({ model, messages: [], tools: [] }),
    entries: [
      {
        seq: 1,
        message: new SessionMessage.User({
          id: SessionMessage.ID.make("msg_compaction_cleanup_abort"),
          type: "user" as const,
          text: "older context ".repeat(100),
          time: { created: DateTime.makeUnsafe(1) },
        }),
      },
    ],
  }

  expect(await Effect.runPromise(compaction.compactAfterOverflow(input))).toBe(true)
  expect(ended).toBe(1)

  completed = false
  await expect(Effect.runPromise(compaction.compactAfterOverflow(input))).rejects.toMatchObject({ name: "AbortError" })
  expect(ended).toBe(1)
})

test("configured turn retention keeps a complete recent user turn", async () => {
  let captured = ""
  let recent = ""
  const compaction = SessionCompaction.make({
    config: [{ type: "document", path: "test", info: { compaction: { keep: { tokens: 1, turns: 1 } } } }],
    events: {
      publish: (definition: { readonly type: string }, data: unknown) =>
        Effect.sync(() => {
          if (definition.type === SessionEvent.Compaction.Ended.type)
            recent = (data as { readonly recent?: string }).recent ?? ""
          return { seq: 1 }
        }),
    } as never,
    llm: {
      stream: (request) => {
        captured = JSON.stringify(request.messages)
        return Stream.make(
          LLMEvent.textStart({ id: "text" }),
          LLMEvent.textDelta({ id: "text", text: "summary" }),
          LLMEvent.textEnd({ id: "text" }),
          LLMEvent.finish({ reason: "stop" }),
        )
      },
    },
  })
  const model = Model.make({
    id: "model",
    provider: "provider",
    route: route.with({ limits: { context: 100_000, output: 1_000 } }),
  })
  const boundary = "complete boundary turn"

  await Effect.runPromise(
    compaction.compactAfterOverflow({
      sessionID: SessionSchema.ID.make("ses_compaction_turns"),
      model,
      request: LLM.request({ model, messages: [], tools: [] }),
      entries: [
        {
          seq: 1,
          message: new SessionMessage.User({
            id: SessionMessage.ID.make("msg_compaction_turns_old"),
            type: "user",
            text: "older context ".repeat(100),
            time: { created: DateTime.makeUnsafe(1) },
          }),
        },
        {
          seq: 2,
          message: new SessionMessage.User({
            id: SessionMessage.ID.make("msg_compaction_turns_boundary"),
            type: "user",
            text: boundary,
            time: { created: DateTime.makeUnsafe(2) },
          }),
        },
        {
          seq: 3,
          message: new SessionMessage.User({
            id: SessionMessage.ID.make("msg_compaction_turns_replay"),
            type: "user",
            text: "replay",
            time: { created: DateTime.makeUnsafe(3) },
          }),
        },
      ],
    }),
  )

  expect(captured).toContain(boundary)
  expect(recent).not.toContain(boundary)
  expect(recent).toContain("replay")
})

test("compaction split does not duplicate the boundary message", async () => {
  const older = "older context ".repeat(2000)
  const boundary = "boundary context ".repeat(2000)
  const recent = "recent context ".repeat(200)
  let captured = ""
  let recentContext = ""
  const compaction = SessionCompaction.make({
    config: [{ type: "document", path: "test", info: { compaction: { keep: { tokens: 1_000 } } } }],
    events: {
      publish: (definition: { readonly type: string }, data: unknown) =>
        Effect.sync(() => {
          if (definition.type === SessionEvent.Compaction.Ended.type)
            recentContext = (data as { readonly recent?: string }).recent ?? ""
          return { seq: 1 }
        }),
    } as never,
    llm: {
      stream: (request) => {
        captured = JSON.stringify(request.messages)
        return Stream.make(
          LLMEvent.textStart({ id: "text" }),
          LLMEvent.textDelta({ id: "text", text: "summary" }),
          LLMEvent.textEnd({ id: "text" }),
          LLMEvent.finish({ reason: "stop" }),
        )
      },
    },
  })

  const model = Model.make({
    id: "model",
    provider: "provider",
    route: route.with({ limits: { context: 100_000, output: 100 } }),
  })
  const sessionID = SessionSchema.ID.make("ses_compaction_split")

  await Effect.runPromise(
    compaction.compactAfterOverflow({
      sessionID,
      model,
      request: LLM.request({ model, messages: [], tools: [] }),
      entries: [
        {
          seq: 1,
          message: new SessionMessage.User({
            id: SessionMessage.ID.make("msg_older"),
            type: "user",
            text: older,
            time: { created: DateTime.makeUnsafe(1) },
          }),
        },
        {
          seq: 2,
          message: new SessionMessage.User({
            id: SessionMessage.ID.make("msg_boundary"),
            type: "user",
            text: boundary,
            time: { created: DateTime.makeUnsafe(2) },
          }),
        },
        {
          seq: 3,
          message: new SessionMessage.User({
            id: SessionMessage.ID.make("msg_recent"),
            type: "user",
            text: recent,
            time: { created: DateTime.makeUnsafe(3) },
          }),
        },
      ],
    }),
  )

  expect(captured).toContain(older.trim())
  expect(captured).not.toContain(boundary.trim())
  expect(captured).not.toContain(recent.trim())
  expect(captured).toContain(boundary.slice(0, 100))
  expect(recentContext).not.toContain(boundary.trim())
  expect(recentContext).toContain(boundary.slice(-100))
  expect(recentContext).toContain(recent.trim())
})

test("compaction retains the final verification evidence from long tool and shell output", async () => {
  const output = `Running regression tests\n${"passing test details\n".repeat(400)}FINAL RESULT: 42 pass, 0 fail; exit code 0`
  let captured = ""
  const compaction = SessionCompaction.make({
    config: [{ type: "document", path: "test", info: { compaction: { keep: { tokens: 0 } } } }],
    events: { publish: () => Effect.succeed({ seq: 1 }) } as never,
    llm: {
      stream: (request) => {
        captured = JSON.stringify(request.messages)
        return Stream.make(
          LLMEvent.textDelta({ id: "summary", text: "Verified work" }),
          LLMEvent.finish({ reason: "stop" }),
        )
      },
    },
  })
  const model = Model.make({ id: "model", provider: "provider", route: route.with({ limits: { context: 100_000 } }) })
  const time = { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) }
  const entries = [
    new SessionMessage.Shell({
      id: SessionMessage.ID.make("msg_verification_shell"),
      type: "shell",
      callID: "shell",
      command: "bun test shell",
      output,
      time,
    }),
    new SessionMessage.Assistant({
      id: SessionMessage.ID.make("msg_verification_tool"),
      type: "assistant",
      agent: "build",
      model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
      time,
      content: [
        new SessionMessage.AssistantTool({
          type: "tool",
          id: "verification",
          name: "bash",
          time,
          state: new SessionMessage.ToolStateCompleted({
            status: "completed",
            input: { command: "bun test tool" },
            structured: {},
            outputPaths: [],
            content: [{ type: "text", text: output }],
          }),
        }),
      ],
    }),
  ].map((message, seq) => ({ message, seq }))

  expect(
    await Effect.runPromise(
      compaction.compactAfterOverflow({
        sessionID: SessionSchema.ID.make("ses_verification_tail"),
        entries,
        model,
        request: LLM.request({ model, messages: [], tools: [] }),
      }),
    ),
  ).toBe(true)
  expect(captured.match(/FINAL RESULT: 42 pass, 0 fail; exit code 0/g)).toHaveLength(2)
  expect(captured.match(/Running regression tests/g)).toHaveLength(2)
  // JSON serialization escapes newlines, but the complete local output must remain present.
  expect(captured).toContain(output.replaceAll("\n", "\\n"))
  expect(captured.length).toBeGreaterThan(output.length)
})

test("automatic compaction continues from complete current history and durable open work", async () => {
  const sessionID = SessionSchema.ID.make("ses_compaction_continuity")
  const currentWork = "Implement the lease-safe continuation and commit it"
  const entries = [
    {
      seq: 9,
      message: new SessionMessage.User({
        id: SessionMessage.ID.make("msg_compaction_continuity_old"),
        type: "user" as const,
        text: "Older completed context ".repeat(100),
        time: { created: DateTime.makeUnsafe(9) },
      }),
    },
    {
      seq: 10,
      message: new SessionMessage.User({
        id: SessionMessage.ID.make("msg_compaction_continuity_user"),
        type: "user" as const,
        text: "Fix session continuity end to end",
        time: { created: DateTime.makeUnsafe(10) },
      }),
    },
    {
      seq: 11,
      message: new SessionMessage.Assistant({
        id: SessionMessage.ID.make("msg_compaction_continuity_assistant"),
        type: "assistant" as const,
        agent: "build",
        model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
        content: [
          new SessionMessage.AssistantReasoning({
            type: "reasoning",
            id: "reasoning-compaction-continuity",
            text: "Root cause confirmed; regression tests are in progress",
          }),
        ],
        time: { created: DateTime.makeUnsafe(11), completed: DateTime.makeUnsafe(12) },
      }),
    },
  ]
  const published: string[] = []
  let recent = ""
  const compaction = SessionCompaction.make({
    config: [{ type: "document", path: "test", info: { compaction: { keep: { tokens: 1, turns: 1 } } } }],
    loadCurrent: () =>
      Effect.succeed({
        entries,
        todos: [{ content: currentWork, status: "in_progress", priority: "high" }],
      }),
    events: {
      publish: (definition: { readonly type: string }, data: unknown) =>
        Effect.sync(() => {
          published.push(definition.type)
          if (definition.type === SessionEvent.Compaction.Ended.type)
            recent = (data as { readonly recent?: string }).recent ?? ""
          return { seq: 12 }
        }),
    } as never,
    llm: {
      stream: () =>
        Stream.make(
          LLMEvent.textStart({ id: "text" }),
          LLMEvent.textDelta({ id: "text", text: "summary" }),
          LLMEvent.textEnd({ id: "text" }),
          LLMEvent.finish({ reason: "stop" }),
        ),
    },
  })
  const model = Model.make({
    id: "model",
    provider: "provider",
    route: route.with({ limits: { context: 100_000, output: 1_000 } }),
  })

  expect(
    await Effect.runPromise(
      compaction.compactAfterOverflow({
        sessionID,
        model,
        request: LLM.request({ model, messages: [], tools: [] }),
        entries: [],
      }),
    ),
  ).toBe(true)
  expect(recent).toContain("Fix session continuity end to end")
  expect(recent).toContain("Root cause confirmed; regression tests are in progress")
  expect(recent).toContain(currentWork)
  expect(published).not.toContain(SessionEvent.Prompted.type)
})

test("unlimited history still attempts a real provider compaction when the model budget overflows", async () => {
  let providerCalls = 0
  const compaction = SessionCompaction.make({
    config: [{ type: "document", path: "test", info: { compaction: { unlimited: true, buffer: 0 } } }],
    events: {
      publish: () => Effect.succeed({ seq: 1 }),
    } as never,
    llm: {
      stream: () => {
        providerCalls++
        return Stream.make(
          LLMEvent.textStart({ id: "text" }),
          LLMEvent.textDelta({ id: "text", text: "## Goal\n\n- carry the task forward" }),
          LLMEvent.textEnd({ id: "text" }),
          LLMEvent.finish({ reason: "stop" }),
        )
      },
    },
  })
  const model = Model.make({
    id: "probe-context-1000",
    provider: "zhipuai-coding-plan",
    route: route.with({ limits: { context: 1_000, output: 100 } }),
  })
  const input = {
    sessionID: SessionSchema.ID.make("ses_compaction_unlimited_wedge"),
    model,
    request: LLM.request({ model, messages: [], tools: [], generation: { maxTokens: 100 } }),
    entries: [
      {
        seq: 1,
        message: new SessionMessage.Assistant({
          id: SessionMessage.ID.make("msg_compaction_unlimited_wedge_custom"),
          type: "assistant" as const,
          agent: "build",
          model: { id: ModelV2.ID.make(model.id), providerID: ProviderV2.ID.make(model.provider) },
          time: { created: DateTime.makeUnsafe(1) },
          content: [
            new SessionMessage.AssistantCustom({
              type: "custom" as const,
              id: "custom_1",
              kind: "ui-status",
              data: { pending: true },
            }),
          ],
        }),
      },
    ],
    contextEstimateTokens: 2_000,
  }
  expect(compaction.requiresAutomaticCompaction(input)).toBe(true)
  expect(SessionCompaction.exceedsInputTokenLimit(input)).toBe(true)
  expect(await Effect.runPromise(compaction.compactIfNeeded(input))).toBe(true)
  expect(providerCalls).toBeGreaterThan(0)
})

test("unlimited selection keeps a finite provider-compatible budget with a recent tail", async () => {
  let summaryPrompt = ""
  let recent = ""
  const compaction = SessionCompaction.make({
    config: [{ type: "document", path: "test", info: { compaction: { unlimited: true } } }],
    events: {
      publish: (definition: { readonly type: string }, data: unknown) =>
        Effect.sync(() => {
          if (definition.type === SessionEvent.Compaction.Ended.type)
            recent = (data as { readonly recent?: string }).recent ?? ""
          return { seq: 1 }
        }),
    } as never,
    llm: {
      stream: (request) => {
        summaryPrompt = JSON.stringify(request.messages)
        return Stream.make(
          LLMEvent.textStart({ id: "text" }),
          LLMEvent.textDelta({ id: "text", text: "## Goal\n\n- summarized" }),
          LLMEvent.textEnd({ id: "text" }),
          LLMEvent.finish({ reason: "stop" }),
        )
      },
    },
  })
  const model = Model.make({
    id: "probe-large-history",
    provider: "zhipuai-coding-plan",
    route: route.with({ limits: { context: 100_000, input: 90_000, output: 32_000 } }),
  })
  const history = "Old durable context ".repeat(30_000)
  const tail = "Recent tail must survive"
  const compacted = await Effect.runPromise(
    compaction.compactAfterOverflow({
      sessionID: SessionSchema.ID.make("ses_compaction_unlimited_tail"),
      model,
      request: LLM.request({ model, messages: [], tools: [] }),
      entries: [
        {
          seq: 1,
          message: new SessionMessage.User({
            id: SessionMessage.ID.make("msg_unlimited_history"),
            type: "user" as const,
            text: history,
            time: { created: DateTime.makeUnsafe(1) },
          }),
        },
        {
          seq: 2,
          message: new SessionMessage.User({
            id: SessionMessage.ID.make("msg_unlimited_tail"),
            type: "user" as const,
            text: tail,
            time: { created: DateTime.makeUnsafe(2) },
          }),
        },
      ],
    }),
  )
  expect(compacted).toBe(true)
  expect(Token.estimate(summaryPrompt)).toBeLessThanOrEqual(90_100)
  expect(recent).toContain(tail)
})

test("manual compaction summarizes through the provider instead of flattening", async () => {
  let providerCalls = 0
  const compaction = SessionCompaction.make({
    config: [],
    events: {
      publish: () => Effect.succeed({ seq: 1 }),
    } as never,
    llm: {
      stream: () => {
        providerCalls++
        return Stream.make(
          LLMEvent.textStart({ id: "text" }),
          LLMEvent.textDelta({ id: "text", text: "## Goal\n\n- manual summary" }),
          LLMEvent.textEnd({ id: "text" }),
          LLMEvent.finish({ reason: "stop" }),
        )
      },
    },
  })
  const model = Model.make({
    id: "probe-manual-summary",
    provider: "zhipuai-coding-plan",
    route: route.with({ limits: { context: 200_000, output: 32_000 } }),
  })
  const history = "Durable manual history ".repeat(4_000)
  const summary = await Effect.runPromise(
    compaction.compactManual({
      sessionID: SessionSchema.ID.make("ses_compaction_manual_summary"),
      model,
      request: LLM.request({ model, messages: [], tools: [] }),
      entries: [
        {
          seq: 1,
          message: new SessionMessage.User({
            id: SessionMessage.ID.make("msg_manual_history"),
            type: "user" as const,
            text: history,
            time: { created: DateTime.makeUnsafe(1) },
          }),
        },
      ],
    }),
  )
  expect(providerCalls).toBeGreaterThan(0)
  expect(summary).toContain("## Goal")
  expect(summary.length).toBeLessThan(history.length)
})

test("manual compaction fails structured when the provider returns no summary", async () => {
  const compaction = SessionCompaction.make({
    config: [],
    events: {
      publish: () => Effect.succeed({ seq: 1 }),
    } as never,
    llm: {
      stream: () =>
        Stream.make(
          LLMEvent.textStart({ id: "text" }),
          LLMEvent.textEnd({ id: "text" }),
          LLMEvent.finish({ reason: "stop" }),
        ),
    },
  })
  const model = Model.make({
    id: "probe-manual-empty",
    provider: "zhipuai-coding-plan",
    route: route.with({ limits: { context: 200_000, output: 32_000 } }),
  })
  const exit = await Effect.runPromise(
    Effect.exit(
      compaction.compactManual({
        sessionID: SessionSchema.ID.make("ses_compaction_manual_failure"),
        model,
        request: LLM.request({ model, messages: [], tools: [] }),
        entries: [
          {
            seq: 1,
            message: new SessionMessage.User({
              id: SessionMessage.ID.make("msg_manual_failure"),
              type: "user" as const,
              text: "Condensable",
              time: { created: DateTime.makeUnsafe(1) },
            }),
          },
        ],
      }),
    ),
  )
  expect(Exit.isFailure(exit)).toBeTrue()
  if (Exit.isFailure(exit)) {
    const error = Cause.squash(exit.cause)
    expect(error).toBeInstanceOf(SessionCompaction.SummaryFailed)
    if (error instanceof SessionCompaction.SummaryFailed) {
      expect(error.reason).toBe("the provider returned an empty summary without usable text")
      expect(error.sessionID).toBe(SessionSchema.ID.make("ses_compaction_manual_failure"))
    }
  }
})

test("raw authentication failure overrides synthetic retryable summary cleanup", async () => {
  let calls = 0
  const compaction = SessionCompaction.make({
    config: [],
    events: { publish: () => Effect.succeed({ seq: 1 }) } as never,
    llm: {
      stream: () => {
        calls++
        if (calls > 1) return Stream.make(LLMEvent.textDelta({ id: "text", text: "must not mask authentication failure" }))
        return Stream.make(LLMEvent.providerError({
          message: "stream ended without finish", retryable: true, retryAfterMs: 0,
        })).pipe(Stream.concat(Stream.fail(new LLMError({
          module: "RequestExecutor", method: "execute",
          reason: new AuthenticationReason({ message: "HTTP 401 summarizer access denied", kind: "invalid" }),
        }))))
      },
    },
  })
  const model = Model.make({ id: "summary-auth", provider: "fake", route: route.with({ limits: { context: 100_000, output: 1000 } }) })
  const exit = await Effect.runPromise(Effect.exit(compaction.compactManual({
    sessionID: SessionSchema.ID.make("ses_summary_auth"), model,
    request: LLM.request({ model, messages: [], tools: [] }), entries: [],
  })))
  expect(calls).toBe(1)
  expect(Exit.isFailure(exit)).toBeTrue()
  if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(SessionCompaction.SummaryFailed)
})

test("raw authentication failure overrides synthetic summary adaptation hints", async () => {
  for (const [index, event] of [
    LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
    LLMEvent.providerError({ message: "Unsupported parameter: max_output_tokens" }),
  ].entries()) {
    let calls = 0
    const published: string[] = []
    const compaction = SessionCompaction.make({
      config: [],
      events: {
        publish: (definition: { readonly type: string }) => {
          published.push(definition.type)
          return Effect.succeed({ seq: 1 })
        },
      } as never,
      llm: {
        stream: () => {
          calls++
          if (calls > 1) return Stream.succeed(LLMEvent.textDelta({ id: "text", text: "masked authentication failure" }))
          return Stream.concat(
            Stream.succeed(event),
            Stream.fail(
              new LLMError({
                module: "RequestExecutor",
                method: "execute",
                reason: new AuthenticationReason({ message: "HTTP 401 summarizer access denied", kind: "invalid" }),
              }),
            ),
          )
        },
      },
    })
    const model = Model.make({
      id: `summary-auth-adaptation-${index}`,
      provider: "fake",
      route: route.with({ limits: { context: 100_000, output: 1_000 } }),
    })
    const exit = await Effect.runPromise(
      Effect.exit(
        compaction.compactManual({
          sessionID: SessionSchema.ID.make(`ses_summary_auth_adaptation_${index}`),
          model,
          request: LLM.request({ model, messages: [], tools: [] }),
          entries: [],
        }),
      ),
    )

    expect(calls).toBe(1)
    expect(Exit.isFailure(exit)).toBeTrue()
    expect(published).not.toContain(SessionEvent.Compaction.Ended.type)
  }
})

test("raw context overflow can retry summary with a smaller context", async () => {
  const promptSizes: number[] = []
  const compaction = SessionCompaction.make({
    config: [{ type: "document", path: "test", info: { compaction: { keep: { tokens: 80_000 }, buffer: 1_000 } } }],
    events: { publish: () => Effect.succeed({ seq: 1 }) } as never,
    llm: {
      stream: (request) => {
        promptSizes.push(Token.estimate(JSON.stringify(request.messages)))
        if (promptSizes.length === 1)
          return Stream.fail(
            new LLMError({
              module: "RequestExecutor",
              method: "execute",
              reason: new InvalidRequestReason({ message: "prompt too long", classification: "context-overflow" }),
            }),
          )
        return Stream.make(LLMEvent.textDelta({ id: "text", text: "recovered summary" }), LLMEvent.finish({ reason: "stop" }))
      },
    },
  })
  const model = Model.make({
    id: "summary-raw-overflow",
    provider: "fake",
    route: route.with({ limits: { context: 100_000, output: 1_000 } }),
  })

  expect(
    await Effect.runPromise(
      compaction.compactManual({
        sessionID: SessionSchema.ID.make("ses_summary_raw_overflow"),
        model,
        request: LLM.request({ model, messages: [], tools: [] }),
        entries: [
          {
            seq: 1,
            message: new SessionMessage.User({
              id: SessionMessage.ID.make("msg_summary_raw_overflow"),
              type: "user",
              text: "Earlier context ".repeat(60_000),
              time: { created: DateTime.makeUnsafe(1) },
            }),
          },
        ],
      }),
    ),
  ).toBe("recovered summary")
  expect(promptSizes).toHaveLength(2)
  expect(promptSizes[1]).toBeLessThan(promptSizes[0])
})

test("summarizeContext captures real request via compactAfterOverflow empty-stream contract", async () => {
  const model = Model.make({ id: "test-empty", provider: "fake", route: route.with({ limits: { context: 6000, output: 256 } }) })
  const request = LLM.request({ model, messages: [], tools: [] })
  let requestCount = 0
  let lastRequest: LLMRequest | undefined
  const compactedExit = await Effect.runPromise(
    Effect.gen(function* () {
      const dbLayer = Database.defaultLayer
      const eventsLayer = EventV2.layer.pipe(Layer.provide(dbLayer))
      const eventsService = yield* EventV2.Service.pipe(Effect.provide(eventsLayer))
      const compaction = SessionCompaction.make({
        config: [{ type: "document", path: "test", info: { compaction: { quality: true, keep: { tokens: 1 }, buffer: 10 } } }],
        events: eventsService,
        llm: {
          stream: (req: LLMRequest) => {
            requestCount++
            lastRequest = req
            return Stream.fromIterable([LLMEvent.stepStart({ index: 0 }), LLMEvent.finish({ reason: "stop" })])
          },
        },
        loadCurrent: () => Effect.succeed({ entries: [], todos: [] }),
      })
      return yield* Effect.exit(compaction.compactAfterOverflow({
        sessionID: SessionSchema.ID.make("ses_capture_contract"),
        model,
        request,
        entries: [],
        contextEstimateTokens: 120_000,
      }))
    }).pipe(Effect.provide(EventV2.layer.pipe(Layer.provide(Database.defaultLayer))), Effect.scoped),
  )
  // Mandatory: contextEstimate 120k > limit 5990 => Providerattempt mit leerem Stream = SummaryFailed
  expect(Exit.isFailure(compactedExit)).toBe(true)
  if (Exit.isFailure(compactedExit)) {
    const error = Cause.squash(compactedExit.cause)
    expect(error).toBeInstanceOf(SessionCompaction.SummaryFailed)
    if (error instanceof SessionCompaction.SummaryFailed) {
      expect(error.sessionID).toBe(SessionSchema.ID.make("ses_capture_contract"))
      expect(error.reason).toBe("the provider returned an empty summary without usable text")
    }
  }
  // Request-Contract: stream() wurde mit echtem LLMRequest aufgerufen
  expect(requestCount).toBe(1)
  expect(lastRequest?.generation?.maxTokens).toBe(256)
  // Realer Input-Limit-Vertrag für diesen fake-Provider
  expect(SessionCompaction.inputTokenLimit({ model, request })).toBe(6000)
  expect(
    SessionCompaction.exceedsInputTokenLimit({
      sessionID: SessionSchema.ID.make("ses_openai_responses_limit"),
      model,
      request,
      entries: [],
      contextEstimateTokens: 491_188,
    }),
  ).toBe(true)
  // OpenAI Responses (uncatalogued) behält 400k ceiling
  const uncatalogued = Model.make({ id: "gpt-5.6-terra", provider: "openai", route: OpenAIResponses.route })
  const uncataloguedRequest = LLM.request({ model: uncatalogued, messages: [], tools: [] })
  expect(SessionCompaction.inputTokenLimit({ model: uncatalogued, request: uncataloguedRequest })).toBe(400_000)
})

test("compactIfNeeded returns false with zero llm.stream calls when below input budget", async () => {
  const model = Model.make({ id: "test-below-budget", provider: "fake", route: route.with({ limits: { context: 6000, output: 256 } }) })
  const request = LLM.request({ model, messages: [{ role: "user", content: "small" as const }], tools: [] })
  let streamCalls = 0
  const dbLayer = Database.defaultLayer
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const eventsService = yield* EventV2.Service.pipe(Effect.provide(EventV2.layer.pipe(Layer.provide(dbLayer))))
      const compaction = SessionCompaction.make({
        config: [{ type: "document", path: "test", info: { compaction: { quality: true, keep: { tokens: 1 }, buffer: 10, auto: true } } }],
        events: eventsService,
        llm: { stream: () => { streamCalls++; return Stream.fromIterable([LLMEvent.finish({ reason: "stop" })]) } },
        loadCurrent: () => Effect.succeed({ entries: [{ seq: 1, message: new SessionMessage.User({ id: SessionMessage.ID.make("msg_h"), type: "user" as const, text: "h", time: { created: DateTime.makeUnsafe(1) } }) }], todos: [] }),
      })
      return yield* compaction.compactIfNeeded({
        sessionID: SessionSchema.ID.make("ses_compactifneeded_opportunistic"),
        model,
        request,
        entries: [{ seq: 1, message: new SessionMessage.User({ id: SessionMessage.ID.make("msg_h"), type: "user" as const, text: "h", time: { created: DateTime.makeUnsafe(1) } }) }],
        contextEstimateTokens: 500,
      })
    }).pipe(Effect.provide(EventV2.defaultLayer), Effect.scoped),
  )
  expect(streamCalls).toBe(0)
  expect(result).toBe(false)
  // History/head-tail Vertrag: kein Eintrag verkürzt, Kontext unter Budget
  expect(SessionCompaction.inputTokenLimit({ model, request })).toBe(6000)
  expect(SessionCompaction.exceedsInputTokenLimit({ sessionID: SessionSchema.ID.make("ses_exceeds"), model, request, entries: [], contextEstimateTokens: 500 })).toBe(false)
})

test("stalled summary streams fail typed without retrying or ending compaction", async () => {
  const stalledStreams: ReadonlyArray<Stream.Stream<LLMEvent, LLMError>> = [
    Stream.never,
    Stream.concat(Stream.succeed(LLMEvent.finish({ reason: "stop" })), Stream.never),
  ]
  const model = Model.make({ id: "test-summary-stall", provider: "fake", route: route.with({ limits: { context: 6000, output: 256 } }) })
  const request = LLM.request({ model, messages: [], tools: [] })

  for (const [index, stalledStream] of stalledStreams.entries()) {
    let calls = 0
    const published: string[] = []
    const compaction = SessionCompaction.make({
      config: [{ type: "document", path: "test", info: { compaction: { keep: { tokens: 1 }, buffer: 10 } } }],
      streamIdleTimeouts: { initialMs: 10, afterProgressMs: 10 },
      events: {
        publish: (event: { readonly type: string }) => {
          published.push(event.type)
          return Effect.succeed({ seq: 1 })
        },
      } as never,
      llm: {
        stream: () => {
          calls++
          return stalledStream
        },
      },
    })
    const sessionID = SessionSchema.ID.make(`ses_summary_stall_${index}`)
    const exit = await Effect.runPromise(
      Effect.exit(compaction.compactAfterOverflow({
        sessionID,
        model,
        request,
        contextEstimateTokens: 120_000,
        entries: [
          {
            seq: 1,
            message: new SessionMessage.User({
              id: SessionMessage.ID.make(`msg_summary_stall_history_${index}`),
              type: "user",
              text: "Retain this earlier context ".repeat(100),
              time: { created: DateTime.makeUnsafe(1) },
            }),
          },
          {
            seq: 2,
            message: new SessionMessage.User({
              id: SessionMessage.ID.make(`msg_summary_stall_replay_${index}`),
              type: "user",
              text: "Continue",
              time: { created: DateTime.makeUnsafe(2) },
            }),
          },
        ],
      })),
    )

    expect(calls).toBe(1)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "SessionCompactionSummaryFailed" })
    expect(published).toContain(SessionEvent.Compaction.Started.type)
    expect(published).not.toContain(SessionEvent.Compaction.Ended.type)
  }
})

test("empty-summary contract fails structured when provider returns no summary", async () => {
  const model = Model.make({ id: "test-empty", provider: "fake", route: route.with({ limits: { context: 6000, output: 256 } }) })
  const request = LLM.request({ model, messages: [], tools: [] })
  const exit = await Effect.runPromise(
    Effect.exit(
      Effect.gen(function* () {
        const eventsService = yield* EventV2.Service
        const compaction = SessionCompaction.make({
          config: [{ type: "document", path: "test", info: { compaction: { quality: true, keep: { tokens: 1 }, buffer: 10 } } }],
          events: eventsService,
          llm: { stream: () => Stream.fromIterable([LLMEvent.stepStart({ index: 0 }), LLMEvent.finish({ reason: "stop" })]) },
          loadCurrent: () => Effect.succeed({ entries: [{ seq: 1, message: new SessionMessage.User({ id: SessionMessage.ID.make("msg_condensable"), type: "user" as const, text: "Real head for condensation", time: { created: DateTime.makeUnsafe(1) } }) }], todos: [] }),
        })
        return yield* compaction.compactAfterOverflow({
          sessionID: SessionSchema.ID.make("ses_empty_stream_contract"),
          model,
          request,
          entries: [],
          contextEstimateTokens: 120_000,
        })
      }).pipe(Effect.provide(EventV2.defaultLayer), Effect.scoped),
    ),
  )
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) {
    const error = Cause.squash(exit.cause)
    expect(error).toBeInstanceOf(SessionCompaction.SummaryFailed)
    if (error instanceof SessionCompaction.SummaryFailed) {
      expect(error.sessionID).toBe(SessionSchema.ID.make("ses_empty_stream_contract"))
      expect(error.reason).toBe("the provider returned an empty summary without usable text")
    }
  }
})

test("empty summary stream without finish fails typed on automatic compaction", async () => {
  const published: string[] = []
  let calls = 0
  const model = Model.make({ id: "test-empty-no-finish", provider: "fake", route: route.with({ limits: { context: 6000, output: 256 } }) })
  const request = LLM.request({ model, messages: [], tools: [] })
  const compaction = SessionCompaction.make({
    config: [{ type: "document", path: "test", info: { compaction: { keep: { tokens: 1 }, buffer: 10 } } }],
    events: {
      publish: (event: { readonly type: string }) => {
        published.push(event.type)
        return Effect.succeed({ seq: 1 })
      },
    } as never,
    llm: {
      stream: () => {
        calls++
        return Stream.fromIterable([])
      },
    },
  })
  const exit = await Effect.runPromise(
    Effect.exit(
      compaction.compactAfterOverflow({
        sessionID: SessionSchema.ID.make("ses_empty_no_finish"),
        model,
        request,
        contextEstimateTokens: 120_000,
        entries: [
          {
            seq: 1,
            message: new SessionMessage.User({
              id: SessionMessage.ID.make("msg_empty_no_finish"),
              type: "user",
              text: "Earlier context for summary",
              time: { created: DateTime.makeUnsafe(1) },
            }),
          },
        ],
      }),
    ),
  )

  expect(calls).toBe(1)
  expect(Exit.isFailure(exit)).toBeTrue()
  if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(SessionCompaction.SummaryFailed)
  expect(published).toContain(SessionEvent.Compaction.Started.type)
  expect(published).not.toContain(SessionEvent.Compaction.Ended.type)
})

for (const interrupted of [false, true]) {
  test(`summary completion boundary: ${interrupted ? "preserves interruption bundled with cleanup abort" : "rejects nonempty text followed by EOF without finish"}`, async () => {
    const published: string[] = []
    let calls = 0
    const model = Model.make({ id: "summary-completion-boundary", provider: "fake", route: route.with({ limits: { context: 6000, output: 256 } }) })
    const request = LLM.request({ model, messages: [], tools: [] })
    const compaction = SessionCompaction.make({
      config: [{ type: "document", path: "test", info: { compaction: { keep: { tokens: 1 }, buffer: 10 } } }],
      events: {
        publish: (event: { readonly type: string }) => {
          published.push(event.type)
          return Effect.succeed({ seq: 1 })
        },
      } as never,
      llm: {
        stream: () => {
          calls++
          const text = Stream.succeed(LLMEvent.textDelta({ id: "summary", text: "Unfinished summary" }))
          if (!interrupted) return text
          return text.pipe(
            Stream.concat(Stream.succeed(LLMEvent.finish({ reason: "stop" }))),
            Stream.concat(Stream.failCause(Cause.combine(Cause.interrupt(), Cause.die(new DOMException("cleanup aborted", "AbortError"))))),
          )
        },
      },
    })
    const exit = await Effect.runPromise(Effect.exit(compaction.compactAfterOverflow({
      sessionID: SessionSchema.ID.make(`ses_summary_completion_${interrupted}`), model, request,
      contextEstimateTokens: 120_000,
      entries: [{ seq: 1, message: new SessionMessage.User({
        id: SessionMessage.ID.make(`msg_summary_completion_${interrupted}`), type: "user",
        text: "Earlier context to preserve", time: { created: DateTime.makeUnsafe(1) },
      }) }],
    })))

    expect(calls).toBe(1)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      if (interrupted) expect(Cause.hasInterrupts(exit.cause)).toBe(true)
      if (!interrupted) expect(Cause.squash(exit.cause)).toMatchObject({
        _tag: "SessionCompactionSummaryFailed", reason: "the summary provider stream ended before completion",
      })
    }
    expect(published).toContain(SessionEvent.Compaction.Started.type)
    expect(published).not.toContain(SessionEvent.Compaction.Ended.type)
  })
}

test("summary Responses HTTP EOF retries without persisting the partial summary", async () => {
  let calls = 0
  const summaries: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: () => {
      calls++
      const events = calls === 1
        ? [{ type: "response.output_text.delta", item_id: "summary_partial", delta: "Partial summary" }]
        : [
            { type: "response.output_text.delta", item_id: "summary_complete", delta: "Verified complete summary" },
            { type: "response.completed", response: {} },
          ]
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  try {
    const model = Model.make({
      id: "gpt-summary-eof", provider: "openai",
      route: OpenAIResponses.route.with({ endpoint: { baseURL: `http://127.0.0.1:${server.port}` }, limits: { context: 6000, output: 256 } }),
    })
    const compacted = await Effect.runPromise(Effect.gen(function* () {
      const compaction = SessionCompaction.make({
        config: [{ type: "document", path: "test", info: { compaction: { keep: { tokens: 1 }, buffer: 10 } } }],
        events: {
          publish: (event: { readonly type: string }, data: { readonly text?: string }) => {
            if (event.type === SessionEvent.Compaction.Ended.type && data.text) summaries.push(data.text)
            return Effect.succeed({ seq: 1 })
          },
        } as never,
        llm: yield* LLMClient.Service,
      })
      return yield* compaction.compactAfterOverflow({
        sessionID: SessionSchema.ID.make("ses_summary_responses_http_eof"), model,
        request: LLM.request({ model, messages: [], tools: [] }), contextEstimateTokens: 120_000,
        entries: [{ seq: 1, message: new SessionMessage.User({
          id: SessionMessage.ID.make("msg_summary_responses_http_eof"), type: "user",
          text: "Earlier context that must remain intact", time: { created: DateTime.makeUnsafe(1) },
        }) }],
      })
    }).pipe(Effect.provide(LLMClient.layer.pipe(Layer.provide(RequestExecutor.defaultLayer)))))

    expect(compacted).toBe(true)
    expect(calls).toBe(2)
    expect(summaries).toEqual(["Verified complete summary"])
  } finally {
    await server.stop(true)
  }
})

for (const reason of ["length", "content-filter", "tool-calls", "unknown"] as const) {
  test(`summary terminal reason: rejects ${reason} instead of persisting incomplete text`, async () => {
    let calls = 0
    const published: string[] = []
    const model = Model.make({ id: "summary-terminal-reason", provider: "fake", route: route.with({ limits: { context: 6000, output: 256 } }) })
    const compaction = SessionCompaction.make({
      config: [{ type: "document", path: "test", info: { compaction: { keep: { tokens: 1 }, buffer: 10 } } }],
      events: {
        publish: (event: { readonly type: string }) => {
          published.push(event.type)
          return Effect.succeed({ seq: 1 })
        },
      } as never,
      llm: {
        stream: () => {
          calls++
          return Stream.make(LLMEvent.textDelta({ id: "summary", text: "Incomplete summary" }), LLMEvent.finish({ reason }))
        },
      },
    })
    const exit = await Effect.runPromise(Effect.exit(compaction.compactAfterOverflow({
      sessionID: SessionSchema.ID.make(`ses_summary_reason_${reason}`), model,
      request: LLM.request({ model, messages: [], tools: [] }), contextEstimateTokens: 120_000,
      entries: [{ seq: 1, message: new SessionMessage.User({
        id: SessionMessage.ID.make(`msg_summary_reason_${reason}`), type: "user",
        text: "Keep this earlier context intact", time: { created: DateTime.makeUnsafe(1) },
      }) }],
    })))

    expect(calls).toBe(1)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toMatchObject({
      _tag: "SessionCompactionSummaryFailed", reason: `the summary provider did not complete successfully (finish reason: ${reason})`,
    })
    expect(published).not.toContain(SessionEvent.Compaction.Ended.type)
  })
}
