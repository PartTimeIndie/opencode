import { expect, test } from "bun:test"
import { AuthenticationReason, LLMError, LLMEvent } from "@opencode-ai/llm"
import { Cause, Deferred, Effect, Exit, Fiber, Stream } from "effect"
import {
  isProviderStreamInactivity,
  providerStreamIdleTimeoutMs,
  providerStreamIdleTimeouts,
  withProviderStreamAbortNormalization,
  withProviderStreamIdleTimeout,
} from "@opencode-ai/core/session/provider-stream"

test("provider stream idle timeout config treats empty values as unset", () => {
  expect(providerStreamIdleTimeoutMs("")).toBe(90_000)
  expect(providerStreamIdleTimeoutMs("   ")).toBe(90_000)
  expect(providerStreamIdleTimeoutMs("40")).toBe(40)
  expect(providerStreamIdleTimeoutMs("0")).toBe(false)
})

test.each([
  ["tensorfold", "bonsai-2-27b"],
  ["zhipuai-coding-plan", "glm-5.3-flash"],
  ["openai", "gpt-6-luna"],
  ["anthropic", "claude-sonnet-4-5"],
  ["custom-provider", "unlisted-model"],
])("provider %s/%s uses common phase defaults and preserves explicit overrides", (provider, id) => {
  for (const value of ["", "   ", "invalid", "NaN", "Infinity", "-Infinity"]) {
    expect(providerStreamIdleTimeouts({ provider, id }, value)).toEqual({ initialMs: 90_000, afterProgressMs: 240_000 })
  }
  expect(providerStreamIdleTimeouts({ provider, id }, " 40 ")).toEqual({ initialMs: 40, afterProgressMs: 40 })
  for (const value of ["0", "-1"]) {
    expect(providerStreamIdleTimeouts({ provider, id }, value)).toEqual({ initialMs: false, afterProgressMs: false })
  }
})

test("provider errors do not renew the post-progress idle window", async () => {
  const exit = await Effect.runPromise(
    Effect.exit(
      Stream.runDrain(
        withProviderStreamIdleTimeout(
          Stream.concat(
            Stream.succeed(LLMEvent.providerError({ message: "summary failed", retryable: true })),
            Stream.never,
          ),
          100,
          600,
        ),
      ),
    ),
  )
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) {
    const failure = Cause.squash(exit.cause)
    expect(failure).toBeInstanceOf(LLMError)
    if (failure instanceof LLMError) {
      expect(isProviderStreamInactivity(failure)).toBe(true)
      expect(failure.message).toContain("for 0 seconds")
    }
  }
}, 2_000)

test("raw aborts remain distinct from measured inactivity", async () => {
  const abort = new DOMException("operation aborted", "AbortError")
  const streamExit = await Effect.runPromise(
    Effect.exit(Stream.runDrain(withProviderStreamIdleTimeout(Stream.die(abort), 10, 10))),
  )
  expect(Exit.isFailure(streamExit)).toBe(true)
  if (Exit.isFailure(streamExit)) expect(Cause.squash(streamExit.cause)).toMatchObject({ name: "AbortError" })

  const effectExit = await Effect.runPromise(Effect.exit(withProviderStreamAbortNormalization(Effect.fail(abort))))
  expect(Exit.isFailure(effectExit)).toBe(true)
  if (Exit.isFailure(effectExit)) {
    const failure = Cause.squash(effectExit.cause)
    expect(failure).toBeInstanceOf(LLMError)
    if (failure instanceof LLMError) expect(failure.reason).toMatchObject({ kind: "stream-aborted" })
  }
})

for (const cleanup of ["pull", "scope"] as const) {
  test(`measured inactivity keeps precedence over ${cleanup} cleanup AbortError`, async () => {
    const abort = new DOMException("This operation was aborted", "AbortError")
    const stream =
      cleanup === "pull"
        ? Stream.fromEffect(Effect.never.pipe(Effect.ensuring(Effect.die(abort))))
        : Stream.fromEffect(Effect.acquireRelease(Effect.void, () => Effect.die(abort))).pipe(
            Stream.scoped,
            Stream.flatMap(() => Stream.never),
          )
    const exit = await Effect.runPromise(
      Effect.exit(withProviderStreamAbortNormalization(Stream.runDrain(withProviderStreamIdleTimeout(stream, 15, 15)))),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterrupts(exit.cause)).toBe(false)
      expect(Cause.squash(exit.cause)).toMatchObject({ reason: { kind: "stream-inactivity", canRetry: true } })
    }
  })
}

for (const timeout of [1_000, false] as const) {
  test(`cleanup abort preserves external interruption with inactivity ${timeout === false ? "disabled" : "enabled"}`, async () => {
    const acquired = Deferred.makeUnsafe<void>()
    const abort = new DOMException("This operation was aborted", "AbortError")
    const stream = Stream.fromEffect(Effect.acquireRelease(Effect.void, () => Effect.die(abort))).pipe(
      Stream.scoped,
      Stream.tap(() => Deferred.succeed(acquired, undefined)),
      Stream.flatMap(() => Stream.never),
    )
    const fiber = Effect.runFork(
      withProviderStreamAbortNormalization(Stream.runDrain(withProviderStreamIdleTimeout(stream, timeout, timeout))),
    )
    await Effect.runPromise(Deferred.await(acquired))
    await Effect.runPromise(Fiber.interrupt(fiber))
    const exit = await Effect.runPromise(Fiber.await(fiber))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true)
  })

  test(`cleanup abort preserves raw authentication failure with inactivity ${timeout === false ? "disabled" : "enabled"}`, async () => {
    const rejected = new LLMError({
      module: "test",
      method: "stream",
      reason: new AuthenticationReason({ kind: "invalid", message: "HTTP 401 rejected" }),
    })
    const stream = Stream.fromEffect(
      Effect.acquireRelease(Effect.void, () => Effect.die(new DOMException("cleanup aborted", "AbortError"))),
    ).pipe(
      Stream.scoped,
      Stream.flatMap(() => Stream.fail(rejected)),
    )
    const exit = await Effect.runPromise(
      Effect.exit(
        withProviderStreamAbortNormalization(Stream.runDrain(withProviderStreamIdleTimeout(stream, timeout, timeout))),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(rejected)
  })
}

test("user interruption during deadline cleanup remains primary", async () => {
  const cleanupStarted = Deferred.makeUnsafe<void>()
  const releaseCleanup = Deferred.makeUnsafe<void>()
  const stream = Stream.fromEffect(
    Effect.acquireRelease(Effect.void, () =>
      Deferred.succeed(cleanupStarted, undefined).pipe(
        Effect.andThen(Deferred.await(releaseCleanup)),
        Effect.andThen(Effect.die(new DOMException("cleanup aborted", "AbortError"))),
      ),
    ),
  ).pipe(
    Stream.scoped,
    Stream.flatMap(() => Stream.never),
  )
  const fiber = Effect.runFork(
    withProviderStreamAbortNormalization(Stream.runDrain(withProviderStreamIdleTimeout(stream, 15, 15))),
  )
  await Effect.runPromise(Deferred.await(cleanupStarted))
  // Request cancellation before releasing the uninterruptible finalizer.
  fiber.interruptUnsafe()
  await Effect.runPromise(Deferred.succeed(releaseCleanup, undefined))
  const exit = await Effect.runPromise(Fiber.await(fiber))

  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true)
})

test("successful provider completion retains cleanup abort classification", async () => {
  const stream = Stream.fromEffect(
    Effect.acquireRelease(Effect.void, () => Effect.die(new DOMException("cleanup aborted", "AbortError"))),
  ).pipe(Stream.scoped, Stream.drain)
  const exit = await Effect.runPromise(
    Effect.exit(withProviderStreamAbortNormalization(Stream.runDrain(withProviderStreamIdleTimeout(stream, 100, 100)))),
  )

  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toMatchObject({ reason: { kind: "stream-aborted" } })
})

test("mixed cleanup defects are not suppressed as provider aborts", async () => {
  const defect = new Error("provider cleanup failed")
  const stream = Stream.fromEffect(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(Effect.void, () => Effect.die(defect))
      yield* Effect.acquireRelease(Effect.void, () => Effect.die(new DOMException("cleanup aborted", "AbortError")))
    }),
  ).pipe(
    Stream.scoped,
    Stream.flatMap(() => Stream.never),
  )
  const exit = await Effect.runPromise(Effect.exit(Stream.runDrain(withProviderStreamIdleTimeout(stream, 15, 15))))

  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) expect(exit.cause.reasons).toContainEqual(expect.objectContaining({ defect }))
})
