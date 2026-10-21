import { expect, test } from "bun:test"
import { LLM, LLMEvent, Model } from "@opencode-ai/llm"
import { route } from "@opencode-ai/llm/protocols/openai-chat"
import { DateTime, Effect, Stream } from "effect"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Token } from "@opencode-ai/core/util/token"

test.each([
  { context: 32_000, threshold: 28_800 },
  { context: 64_000, threshold: 57_600 },
  { context: 128_000, threshold: 115_200 },
  { context: 200_000, threshold: 180_000 },
  { context: 1_000_000, threshold: 980_000 },
  { context: 64_000, input: 40_000, threshold: 36_000 },
  { context: 64_000, maxTokens: 8_000, threshold: 50_400 },
  { context: 64_000, buffer: 20_000, threshold: 44_000 },
  { context: 64_000, buffer: 0, threshold: 64_000 },
])("automatic compaction uses a proportional bounded buffer: %j", ({ context, threshold, ...options }) => {
  const model = Model.make({
    id: "local-model",
    provider: "lmstudio",
    route: route.with({ limits: { context, input: options.input } }),
  })
  const compaction = SessionCompaction.make({
    config:
      options.buffer === undefined
        ? []
        : [
            {
              type: "document",
              path: "test",
              info: { compaction: { buffer: options.buffer } },
            },
          ],
    events: {} as never,
    llm: { stream: () => Stream.die("unexpected summary") },
  })
  const input = {
    sessionID: SessionSchema.ID.make("ses_compaction_buffer"),
    entries: [],
    model,
    request: LLM.request({ model, messages: [], tools: [], generation: { maxTokens: options.maxTokens } }),
  }
  expect(compaction.requiresAutomaticCompaction({ ...input, contextEstimateTokens: threshold })).toBe(false)
  expect(compaction.requiresAutomaticCompaction({ ...input, contextEstimateTokens: threshold + 1 })).toBe(true)
})

test.each(["manual", "automatic"] as const)("%s summaries use proportional headroom on small models", async (mode) => {
  const promptTokens: number[] = []
  const model = Model.make({
    id: "small-summary-model",
    provider: "lmstudio",
    route: route.with({ limits: { context: 32_000, output: 4_096 } }),
  })
  const compaction = SessionCompaction.make({
    config: [{ type: "document", path: "test", info: { compaction: { keep: { tokens: 1 } } } }],
    events: { publish: () => Effect.succeed({ seq: 1 }) } as never,
    llm: {
      stream(request) {
        promptTokens.push(
          Token.estimateFootprint({ system: request.system, messages: request.messages, tools: request.tools }),
        )
        return Stream.make(
          LLMEvent.textStart({ id: "summary" }),
          LLMEvent.textDelta({ id: "summary", text: "The task and its progress are preserved." }),
          LLMEvent.textEnd({ id: "summary" }),
          LLMEvent.finish({ reason: "stop" }),
        )
      },
    },
  })
  const input = {
    sessionID: SessionSchema.ID.make("ses_small_summary_buffer"),
    model,
    request: LLM.request({ model, messages: [], tools: [] }),
    entries: [
      {
        seq: 1,
        message: new SessionMessage.User({
          id: SessionMessage.ID.make("msg_small_summary_buffer"),
          type: "user",
          text: "Earlier context. ".repeat(4_000),
          time: { created: DateTime.makeUnsafe(1) },
        }),
      },
    ],
  }
  await (mode === "manual"
    ? Effect.runPromise(compaction.compactManual(input))
    : Effect.runPromise(compaction.compactIfNeeded({ ...input, contextEstimateTokens: 28_801 })))
  expect(promptTokens).toHaveLength(1)
  expect(promptTokens[0]).toBeGreaterThan(8_000)
  expect(promptTokens[0]).toBeLessThan(25_114)
})
