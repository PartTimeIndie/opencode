import { expect, test } from "bun:test"
import { LLMError, LLMEvent, TransportReason } from "@opencode-ai/llm"
import { Cause, Effect, Fiber, Option, Stream } from "effect"
import { SessionProviderStream } from "@opencode-ai/core/session/provider-stream"
import {
  retryDelayMs,
  providerStreamIdleTimeoutMs,
  providerStreamIdleTimeouts,
  withProviderStreamAbortNormalization,
  withProviderStreamIdleTimeout,
} from "@opencode-ai/core/session/runner/llm"

test("runner exports the shared stream policy instead of another implementation", () => {
  expect(providerStreamIdleTimeouts).toBe(SessionProviderStream.providerStreamIdleTimeouts)
  expect(withProviderStreamIdleTimeout).toBe(SessionProviderStream.withProviderStreamIdleTimeout)
  expect(withProviderStreamAbortNormalization).toBe(SessionProviderStream.withProviderStreamAbortNormalization)
})

test("disabling idle timeouts still normalizes remote aborts at the runner boundary", async () => {
  const aborted = Object.assign(new Error("This operation was aborted"), { name: "AbortError" })
  const failure = await Effect.runPromise(
    withProviderStreamAbortNormalization(
      withProviderStreamIdleTimeout(Stream.die(aborted), false).pipe(Stream.runDrain),
    ).pipe(Effect.flip),
  )
  expect(failure).toMatchObject({ reason: { kind: "stream-aborted", canRetry: true, message: aborted.message } })
})

test("provider stream initial inactivity defaults to ninety seconds and preserves explicit overrides", () => {
  expect(providerStreamIdleTimeoutMs(undefined)).toBe(90_000)
  expect(providerStreamIdleTimeoutMs("2500")).toBe(2_500)
  expect(providerStreamIdleTimeoutMs("0")).toBe(false)
  expect(providerStreamIdleTimeoutMs("invalid")).toBe(90_000)
  expect(providerStreamIdleTimeoutMs("")).toBe(90_000)
  expect(providerStreamIdleTimeoutMs("  ")).toBe(90_000)
})

test("provider error events do not grant a longer progress deadline", async () => {
  const stream = Stream.concat(
    Stream.succeed(LLMEvent.providerError({ message: "provider unavailable" })),
    Stream.fromEffect(Effect.sleep(40).pipe(Effect.as(LLMEvent.finish({ reason: "stop" })))),
  )
  const exit = await Effect.runPromise(
    withProviderStreamIdleTimeout(stream, 10, 100).pipe(Stream.runDrain, Effect.exit),
  )
  expect(exit._tag).toBe("Failure")
  if (exit._tag === "Success") return
  expect(Cause.squash(exit.cause)).toMatchObject({ reason: { kind: "stream-inactivity" } })
})

test.each([
  ["zhipuai-coding-plan", "glm-5.3-flash"],
  ["zhipuai-coding-plan", "glm-5.3"],
  ["zhipuai-coding-plan", "glm-4.6"],
  ["openrouter", "glm-4.5-air"],
])("GLM model %s/%s uses the common ninety-second initial and four-minute progress phases", (provider, id) => {
  expect(providerStreamIdleTimeouts({ provider, id })).toEqual({
    initialMs: 90_000,
    afterProgressMs: 240_000,
  })
})

test.each([
  ["openai", "gpt-6-luna"],
  ["openai", "gpt-6.1-sol"],
])("OpenAI GPT-6 model %s/%s uses the common ninety-second initial and four-minute progress phases", (provider, id) => {
  expect(providerStreamIdleTimeouts({ provider, id })).toEqual({
    initialMs: 90_000,
    afterProgressMs: 240_000,
  })
})

test.each([
  ["tensorfold", "bonsai-2-27b"],
  ["openai", "gpt-60"],
  ["openai", "gpt-6luna"],
  ["openai", "gpt-5.5"],
  ["anthropic", "claude-sonnet-4-5"],
])(
  "other model %s/%s uses the same ninety-second initial and four-minute progress phases",
  (provider, id) => {
    expect(providerStreamIdleTimeouts({ provider, id })).toEqual({
      initialMs: 90_000,
      afterProgressMs: 240_000,
    })
  },
)

test.each([
  ["zhipuai-coding-plan", "glm-5.3-flash"],
  ["openai", "gpt-6-luna"],
])("explicit overrides replace both phases for %s/%s", (provider, id) => {
  expect(providerStreamIdleTimeouts({ provider, id }, "2500")).toEqual({
    initialMs: 2_500,
    afterProgressMs: 2_500,
  })
  expect(providerStreamIdleTimeouts({ provider, id }, "120000")).toEqual({
    initialMs: 120_000,
    afterProgressMs: 120_000,
  })
  expect(providerStreamIdleTimeouts({ provider, id }, "0")).toEqual({
    initialMs: false,
    afterProgressMs: false,
  })
})

test("provider streams with no framed events fail as retryable stalls", async () => {
  const failure = await Effect.runPromise(
    withProviderStreamIdleTimeout(Stream.never, 10).pipe(Stream.runDrain, Effect.flip),
  )

  expect(failure).toBeInstanceOf(LLMError)
  expect(failure.reason).toMatchObject({
    kind: "stream-inactivity",
    canRetry: true,
  })
})

test("provider lifecycle chatter cannot keep a turn alive without meaningful progress", async () => {
  const failure = await Effect.runPromise(
    withProviderStreamIdleTimeout(
      Stream.fromEffectRepeat(
        Effect.sleep(2).pipe(Effect.as(LLMEvent.reasoningStart({ id: "reasoning-keepalive" }))),
      ),
      20,
    ).pipe(Stream.runDrain, Effect.flip),
  )

  expect(failure).toBeInstanceOf(LLMError)
  expect(failure.reason).toMatchObject({
    kind: "stream-inactivity",
    canRetry: true,
  })
})

test("provider stream failures pass through the idle guard immediately", async () => {
  const failure = new LLMError({
    module: "test",
    method: "stream",
    reason: new TransportReason({
      message: "connection reset",
      canRetry: true,
    }),
  })
  const observed = await Effect.runPromise(
    withProviderStreamIdleTimeout(Stream.fail(failure), 60_000).pipe(Stream.runDrain, Effect.flip),
  )

  expect(observed).toBe(failure)
})

test("completed opaque Codex reasoning grants the bounded progress phase without summary text", async () => {
  const reasoning = LLMEvent.reasoningEnd({
    id: "opaque-reasoning",
    providerMetadata: { openai: { reasoningEncryptedContent: "opaque-fixture" } },
  })
  const finish = LLMEvent.finish({ reason: "stop" })
  const stream = Stream.concat(
    Stream.succeed(reasoning),
    Stream.fromEffect(Effect.sleep(40).pipe(Effect.as(finish))),
  )
  expect(await Effect.runPromise(Stream.runCollect(withProviderStreamIdleTimeout(stream, 20, 150)))).toEqual([
    reasoning,
    finish,
  ])
})

test.each([undefined, null, "", "  "])("empty reasoning completion %j does not extend the initial deadline", async (encrypted) => {
  const reasoning = LLMEvent.reasoningEnd({
    id: "empty-reasoning",
    providerMetadata: { openai: { reasoningEncryptedContent: encrypted } },
  })
  const stream = Stream.concat(Stream.succeed(reasoning), Stream.never)
  const failure = await Effect.runPromise(
    withProviderStreamIdleTimeout(stream, 10, 1_000).pipe(Stream.runDrain, Effect.flip),
  )
  expect(failure.reason).toMatchObject({ kind: "stream-inactivity", message: expect.stringContaining("0 seconds") })
})

test("repeated opaque reasoning completion cannot keep a stalled provider alive", async () => {
  const reasoning = LLMEvent.reasoningEnd({
    id: "same-reasoning",
    providerMetadata: { openai: { reasoningEncryptedContent: "opaque-fixture" } },
  })
  const failure = await Effect.runPromise(
    withProviderStreamIdleTimeout(
      Stream.fromEffectRepeat(Effect.sleep(2).pipe(Effect.as(reasoning))),
      20,
      40,
    ).pipe(Stream.runDrain, Effect.flip),
  )
  expect(failure.reason).toMatchObject({ kind: "stream-inactivity", canRetry: true })
})

test("local event processing cannot stall a healthy provider or its normal completion", async () => {
  const events = [
    LLMEvent.textDelta({ id: "text", text: "Hello" }),
    LLMEvent.textDelta({ id: "text", text: " world" }),
  ]
  const observed: LLMEvent[] = []
  await Effect.runPromise(
    withProviderStreamIdleTimeout(Stream.fromIterable(events).pipe(Stream.rechunk(1)), 20).pipe(
      Stream.runForEach((event) =>
        Effect.sleep(40).pipe(Effect.tap(() => Effect.sync(() => observed.push(event)))),
      ),
    ),
  )
  expect(observed).toEqual(events)
})

test("meaningful progress gets a bounded longer idle phase while keepalives cannot extend it", async () => {
  const delta = LLMEvent.textDelta({ id: "text", text: "thinking" })
  const finish = LLMEvent.finish({ reason: "stop" })
  const delayedFinish = Stream.concat(
    Stream.succeed(delta),
    Stream.fromEffect(Effect.sleep(30).pipe(Effect.as(finish))),
  )
  expect(await Effect.runPromise(Stream.runCollect(withProviderStreamIdleTimeout(delayedFinish, 10, 60)))).toEqual([
    delta,
    finish,
  ])

  const keepalive: LLMEvent = { type: "keepalive" }
  const keepaliveOnly = Stream.concat(
    Stream.succeed(delta),
    Stream.fromEffectRepeat(Effect.sleep(2).pipe(Effect.as(keepalive))),
  )
  const failure = await Effect.runPromise(
    withProviderStreamIdleTimeout(keepaliveOnly, 10, 30).pipe(Stream.runDrain, Effect.flip),
  )
  expect(failure).toBeInstanceOf(LLMError)
  expect(failure.reason).toMatchObject({ kind: "stream-inactivity", canRetry: true })
})

test("the idle budget starts on consumption and is fresh for each stream run", async () => {
  const event = LLMEvent.textDelta({ id: "text", text: "Hello" })
  const guarded = withProviderStreamIdleTimeout(Stream.succeed(event), 20)
  await Effect.runPromise(Effect.sleep(40))
  expect(await Effect.runPromise(Stream.runCollect(guarded))).toEqual([event])
  await Effect.runPromise(Effect.sleep(40))
  expect(await Effect.runPromise(Stream.runCollect(guarded))).toEqual([event])
})

test("a stall after meaningful progress reports the after-progress phase budget", async () => {
  const delta = LLMEvent.textDelta({ id: "text", text: "thinking" })
  const keepalive: LLMEvent = { type: "keepalive" }
  const stalling = Stream.concat(
    Stream.succeed(delta),
    Stream.fromEffectRepeat(Effect.sleep(2).pipe(Effect.as(keepalive))),
  )
  const failure = await Effect.runPromise(
    withProviderStreamIdleTimeout(stalling, 10, 1_000).pipe(Stream.runDrain, Effect.flip),
  )

  expect(failure).toBeInstanceOf(LLMError)
  expect(failure.reason).toMatchObject({
    kind: "stream-inactivity",
    canRetry: true,
    message: expect.stringContaining("no meaningful events for 1 seconds"),
  })
})

test("provider-side aborts remain distinct from measured inactivity", async () => {
  const aborted = Object.assign(new Error("This operation was aborted"), { name: "AbortError" }) as LLMError
  const failure = await Effect.runPromise(
    withProviderStreamIdleTimeout(Stream.fail(aborted), 60_000).pipe(Stream.runDrain, Effect.flip),
  )

  expect(failure).toBe(aborted)
})

test.each(["Stream abgebrochen", "Cursor Run stream aborted by remote"])(
  "remote provider stream failure %s is normalized as retryable",
  async (message) => {
    const failure = await Effect.runPromise(
      withProviderStreamIdleTimeout(Stream.fail(new Error(message) as LLMError), 60_000).pipe(Stream.runDrain, Effect.flip),
    )

    expect(failure).toBeInstanceOf(LLMError)
    expect(failure.reason).toMatchObject({
      message,
      kind: "stream-aborted",
      canRetry: true,
    })
  },
)

test("automatic provider retries use capped exponential backoff unless the provider supplies a delay", () => {
  const failure = LLMEvent.providerError({ message: "temporary failure", retryable: true })
  expect([1, 2, 3, 4, 5, 6].map((attempt) => retryDelayMs(failure, attempt))).toEqual([
    2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
  ])
  expect(retryDelayMs(LLMEvent.providerError({ message: "busy", retryable: true, retryAfterMs: 1_234 }), 5)).toBe(
    1_234,
  )
})

test("provider-side abort defects are normalized as retryable stream aborts", async () => {
  const aborted = Object.assign(new Error("This operation was aborted"), { name: "AbortError" })
  const failure = await Effect.runPromise(
    withProviderStreamAbortNormalization(
      withProviderStreamIdleTimeout(Stream.die(aborted), 60_000).pipe(Stream.runDrain),
    ).pipe(Effect.flip),
  )

  expect(failure).toBeInstanceOf(LLMError)
  expect(failure).not.toBe(aborted)
  expect(failure.reason).toMatchObject({
    kind: "stream-aborted",
    canRetry: true,
  })
})

test("provider stream lifecycle normalizes resource finalizer abort defects as retryable stream aborts", async () => {
  const aborted = Object.assign(new Error("This operation was aborted"), { name: "AbortError" })
  const failure = await Effect.runPromise(
    withProviderStreamAbortNormalization(
      Stream.fromEffect(
        Effect.acquireRelease(Effect.void, () => Effect.die(aborted)),
      ).pipe(Stream.scoped, Stream.runDrain),
    ).pipe(Effect.flip),
  )

  expect(failure).toBeInstanceOf(LLMError)
  expect(failure).not.toBe(aborted)
  expect(failure.reason).toMatchObject({
    kind: "stream-aborted",
    canRetry: true,
  })
})

test("external interruption remains an interrupt instead of a retryable stall", async () => {
  const fiber = Effect.runFork(
    withProviderStreamAbortNormalization(
      withProviderStreamIdleTimeout(Stream.never, 60_000).pipe(Stream.runDrain),
    ),
  )
  await Effect.runPromise(Fiber.interrupt(fiber))
  const exit = await Effect.runPromise(Fiber.await(fiber))

  expect(exit._tag).toBe("Failure")
  if (exit._tag === "Success") return
  expect(Cause.hasInterrupts(exit.cause)).toBe(true)
  expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).not.toBeInstanceOf(LLMError)
})
