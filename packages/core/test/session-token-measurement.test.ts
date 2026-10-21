import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Schema, Stream } from "effect"
import { LLMEvent } from "@opencode-ai/llm"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionMessageUpdater } from "@opencode-ai/core/session/message-updater"
import { createLLMEventPublisher } from "@opencode-ai/core/session/runner/publish-llm-event"

const sessionID = SessionV2.ID.make("ses_token_measurement")
const assistantMessageID = SessionMessage.ID.make("msg_token_measurement")
const created = DateTime.makeUnsafe(0)
const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }

const publisherCapture = () => {
  const published: Array<{ readonly type: string; readonly data: unknown }> = []
  const events = EventV2.Service.of({
    publish: (definition, data) =>
      Effect.sync(() => {
        const event = { id: EventV2.ID.create(), type: definition.type, data } as EventV2.Payload<typeof definition>
        published.push({
          type: definition.sync ? EventV2.versionedType(definition.type, definition.sync.version) : definition.type,
          data,
        })
        return event
      }),
    subscribe: () => Stream.empty,
    all: () => Stream.empty,
    aggregateEvents: () => Stream.empty,
    sync: () => Effect.succeed(Effect.void),
    listen: () => Effect.succeed(Effect.void),
    beforeCommit: () => Effect.void,
    project: () => Effect.void,
    registerCheckpointAdapter: () => Effect.void,
    replay: () => Effect.void,
    replayAll: () => Effect.succeed(undefined),
    createCheckpoint: () => Effect.succeed(undefined),
    checkpoint: () => Effect.succeed(undefined),
    compactCheckpoint: () => Effect.succeed(undefined),
    replayCheckpoint: () => Effect.succeed(undefined),
    remove: () => Effect.void,
    claim: () => Effect.void,
  })

  return {
    published,
    publisher: createLLMEventPublisher(events, {
      sessionID,
      agent: "build",
      model,
      cost: [],
    }),
  }
}

describe("Session token measurement", () => {
  test("publishes provider-reported token measurements, including measured zero", async () => {
    const { published, publisher } = publisherCapture()
    await Effect.runPromise(
      publisher.publish(
        LLMEvent.stepFinish({
          index: 0,
          reason: "stop",
          usage: {
            inputTokens: 42,
            outputTokens: 13,
            nonCachedInputTokens: 0,
            cacheReadInputTokens: 40,
            cacheWriteInputTokens: 2,
            reasoningTokens: 4,
            totalTokens: 55,
          },
        }),
      ),
    )
    await Effect.runPromise(publisher.finishStep())

    expect(published.find((event) => event.type === "session.next.step.ended.2")?.data).toMatchObject({
      tokenMeasurement: {
        version: 1,
        inputTokens: 42,
        outputTokens: 13,
        nonCachedInputTokens: 0,
        cacheReadInputTokens: 40,
        cacheWriteInputTokens: 2,
        reasoningTokens: 4,
        totalTokens: 55,
      },
    })
  })

  test("keeps partial provider measurements partial instead of filling missing categories", async () => {
    const { published, publisher } = publisherCapture()
    await Effect.runPromise(
      publisher.publish(
        LLMEvent.stepFinish({
          index: 0,
          reason: "stop",
          usage: {
            inputTokens: 0,
            outputTokens: 3,
            nonCachedInputTokens: 1.5,
            cacheReadInputTokens: -2,
            cacheWriteInputTokens: 0,
            reasoningTokens: 1.5,
            totalTokens: -2,
          },
        }),
      ),
    )
    await Effect.runPromise(publisher.finishStep())

    const ended = published.find((event) => event.type === "session.next.step.ended.2")
    expect(ended?.data).toMatchObject({
      tokenMeasurement: { version: 1, inputTokens: 0, outputTokens: 3, cacheWriteInputTokens: 0 },
    })
    expect(ended?.data).not.toHaveProperty("tokenMeasurement.nonCachedInputTokens")
    expect(ended?.data).not.toHaveProperty("tokenMeasurement.cacheReadInputTokens")
    expect(ended?.data).not.toHaveProperty("tokenMeasurement.reasoningTokens")
    expect(ended?.data).not.toHaveProperty("tokenMeasurement.totalTokens")
  })

  test("accepts safe integer boundaries and omits unsafe or non-finite provider values", async () => {
    const { published, publisher } = publisherCapture()
    await Effect.runPromise(
      publisher.publish(
        LLMEvent.stepFinish({
          index: 0,
          reason: "stop",
          usage: {
            inputTokens: Number.MAX_SAFE_INTEGER,
            outputTokens: 0,
            nonCachedInputTokens: Number.MAX_SAFE_INTEGER + 1,
            cacheReadInputTokens: Number.NaN,
            cacheWriteInputTokens: Number.POSITIVE_INFINITY,
            reasoningTokens: 0,
            totalTokens: Number.NEGATIVE_INFINITY,
          },
        }),
      ),
    )
    await Effect.runPromise(publisher.finishStep())

    const ended = published.find((event) => event.type === "session.next.step.ended.2")
    const measurement = {
      version: 1 as const,
      inputTokens: Number.MAX_SAFE_INTEGER,
      outputTokens: 0,
      reasoningTokens: 0,
    }
    expect(ended?.data).toMatchObject({ tokenMeasurement: measurement })
    expect(Schema.decodeUnknownSync(SessionEvent.TokenMeasurement)(measurement)).toEqual(measurement)
    expect(ended?.data).not.toHaveProperty("tokenMeasurement.nonCachedInputTokens")
    expect(ended?.data).not.toHaveProperty("tokenMeasurement.cacheReadInputTokens")
    expect(ended?.data).not.toHaveProperty("tokenMeasurement.cacheWriteInputTokens")
    expect(ended?.data).not.toHaveProperty("tokenMeasurement.totalTokens")
  })

  test("persists measured generation streaming time with and without provider usage", async () => {
    const withUsage = publisherCapture()
    await Effect.runPromise(
      withUsage.publisher.publish(
        LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } }),
      ),
    )
    await Effect.runPromise(withUsage.publisher.finishStep(undefined, undefined, undefined, 1250.6))
    expect(withUsage.published.find((event) => event.type === "session.next.step.ended.2")?.data).toMatchObject({
      tokenMeasurement: { version: 1, inputTokens: 4, generationMilliseconds: 1251 },
    })

    const withoutUsage = publisherCapture()
    await Effect.runPromise(withoutUsage.publisher.publish(LLMEvent.textStart({ id: "gen-only-step" })))
    await Effect.runPromise(withoutUsage.publisher.publish(LLMEvent.stepFinish({ index: 0, reason: "stop" })))
    await Effect.runPromise(withoutUsage.publisher.finishStep(undefined, undefined, undefined, 900))
    expect(withoutUsage.published.find((event) => event.type === "session.next.step.ended.2")?.data).toMatchObject({
      tokenMeasurement: { version: 1, generationMilliseconds: 900 },
    })

    // No measured streaming time must stay absent instead of becoming zero.
    const noMeasurement = publisherCapture()
    await Effect.runPromise(
      noMeasurement.publisher.publish(LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { inputTokens: 1 } })),
    )
    await Effect.runPromise(noMeasurement.publisher.finishStep())
    expect(
      noMeasurement.published.find((event) => event.type === "session.next.step.ended.2")?.data,
    ).not.toHaveProperty("tokenMeasurement.generationMilliseconds")

    // Non-finite caller values degrade to absent; finite negatives clamp to zero.
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const guarded = publisherCapture()
      await Effect.runPromise(
        guarded.publisher.publish(LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { inputTokens: 1 } })),
      )
      await Effect.runPromise(guarded.publisher.finishStep(undefined, undefined, undefined, invalid))
      const ended = guarded.published.find((event) => event.type === "session.next.step.ended.2")?.data
      expect(ended).toMatchObject({ tokenMeasurement: { version: 1, inputTokens: 1 } })
      expect(
        (ended as { tokenMeasurement?: { generationMilliseconds?: unknown } }).tokenMeasurement
          ?.generationMilliseconds,
      ).toBeUndefined()
    }
    const negative = publisherCapture()
    await Effect.runPromise(
      negative.publisher.publish(LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { inputTokens: 1 } })),
    )
    await Effect.runPromise(negative.publisher.finishStep(undefined, undefined, undefined, -5))
    expect(
      negative.published.find((event) => event.type === "session.next.step.ended.2")?.data,
    ).toMatchObject({ tokenMeasurement: { version: 1, inputTokens: 1, generationMilliseconds: 0 } })
  })

  test("keeps the first measurement when duplicate finishes and finishStep calls arrive", async () => {
    const { published, publisher } = publisherCapture()
    await Effect.runPromise(
      publisher.publish(
        LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } }),
      ),
    )
    await Effect.runPromise(
      publisher.publish(
        LLMEvent.stepFinish({ index: 1, reason: "length", usage: { inputTokens: 90, outputTokens: 80, totalTokens: 170 } }),
      ),
    )
    await Effect.runPromise(publisher.finishStep())
    await Effect.runPromise(publisher.finishStep())

    const ended = published.filter((event) => event.type === "session.next.step.ended.2")
    expect(ended).toHaveLength(1)
    expect(ended[0]?.data).toMatchObject({
      finish: "stop",
      tokenMeasurement: { version: 1, inputTokens: 4, outputTokens: 2, totalTokens: 6 },
    })
  })

  test("does not publish buffered measurements after interruption or a later finishStep", async () => {
    const { published, publisher } = publisherCapture()
    await Effect.runPromise(publisher.publish(LLMEvent.textStart({ id: "interrupted-usage-step" })))
    await Effect.runPromise(
      publisher.publish(
        LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } }),
      ),
    )
    await Effect.runPromise(publisher.interruptStep())
    await Effect.runPromise(publisher.finishStep())

    const ended = published.filter((event) => event.type === "session.next.step.ended.2")
    expect(ended).toHaveLength(1)
    expect(ended[0]?.data).toMatchObject({ finish: "interrupted" })
    expect(ended[0]?.data).not.toHaveProperty("tokenMeasurement")
  })

  test("does not invent measurements when usage is absent or a step is interrupted", async () => {
    const missingUsage = publisherCapture()
    await Effect.runPromise(missingUsage.publisher.publish(LLMEvent.stepFinish({ index: 0, reason: "stop" })))
    await Effect.runPromise(missingUsage.publisher.finishStep())
    expect(
      missingUsage.published.find((event) => event.type === "session.next.step.ended.2")?.data,
    ).not.toHaveProperty("tokenMeasurement")

    const interrupted = publisherCapture()
    await Effect.runPromise(interrupted.publisher.publish(LLMEvent.textStart({ id: "interrupted-step" })))
    await Effect.runPromise(interrupted.publisher.interruptStep())
    expect(
      interrupted.published.find((event) => event.type === "session.next.step.ended.2")?.data,
    ).not.toHaveProperty("tokenMeasurement")
  })

  test("preserves measured zero separately from an omitted category", () => {
    const measurement = {
      version: 1 as const,
      inputTokens: 0,
      outputTokens: 12,
      nonCachedInputTokens: 0,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
    }
    const encoded = Schema.encodeSync(SessionEvent.TokenMeasurement)(measurement)
    const decoded = Schema.decodeUnknownSync(SessionEvent.TokenMeasurement)(encoded)

    expect(decoded).toEqual(measurement)
    expect(decoded.reasoningTokens).toBeUndefined()
    expect(() =>
      Schema.decodeUnknownSync(SessionEvent.TokenMeasurement)({ version: 1, inputTokens: -1 }),
    ).toThrow()
  })

  test("projects additive measurement metadata without replacing existing usage", async () => {
    const state: SessionMessageUpdater.MemoryState = {
      messages: [
        new SessionMessage.Assistant({
          id: assistantMessageID,
          type: "assistant",
          agent: "build",
          model,
          content: [],
          time: { created },
        }),
      ],
    }

    await Effect.runPromise(
      SessionMessageUpdater.update(SessionMessageUpdater.memory(state), {
        id: EventV2.ID.make("evt_token_measurement"),
        type: "session.next.step.ended",
        data: {
          sessionID,
          assistantMessageID,
          timestamp: DateTime.makeUnsafe(1),
          finish: "stop",
          cost: 0,
          tokens: { input: 0, output: 7, reasoning: 5, cache: { read: 0, write: 0 } },
          tokenMeasurement: {
            version: 1,
            inputTokens: 0,
            outputTokens: 12,
            nonCachedInputTokens: 0,
            cacheReadInputTokens: 0,
            cacheWriteInputTokens: 0,
          },
        },
      } satisfies SessionEvent.Event),
    )

    expect(state.messages[0]).toMatchObject({
      type: "assistant",
      cost: 0,
      tokens: { input: 0, output: 7, reasoning: 5 },
      tokenMeasurement: { version: 1, inputTokens: 0, outputTokens: 12 },
    })
    if (state.messages[0]?.type === "assistant") expect(state.messages[0].tokenMeasurement?.reasoningTokens).toBeUndefined()
  })

  test("continues projecting historical Step.Ended payloads without measurement metadata", async () => {
    const state: SessionMessageUpdater.MemoryState = {
      messages: [
        new SessionMessage.Assistant({
          id: assistantMessageID,
          type: "assistant",
          agent: "build",
          model,
          content: [],
          time: { created },
        }),
      ],
    }
    await Effect.runPromise(
      SessionMessageUpdater.update(SessionMessageUpdater.memory(state), {
        id: EventV2.ID.make("evt_legacy_step_ended"),
        type: "session.next.step.ended",
        data: {
          sessionID,
          assistantMessageID,
          timestamp: DateTime.makeUnsafe(1),
          finish: "stop",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      } satisfies SessionEvent.Event),
    )
    if (state.messages[0]?.type === "assistant") expect(state.messages[0].tokenMeasurement).toBeUndefined()
  })
})
