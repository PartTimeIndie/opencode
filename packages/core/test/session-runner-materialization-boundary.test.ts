import { expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit } from "effect"
import { ContentStore } from "@opencode-ai/core/content-store"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import {
  messageMaterializationTimeoutMs,
  visionDelegationTimeoutMs,
  visionModelResolveTimeoutMs,
  visionStreamTimeoutMs,
  withMessageMaterializationBoundary,
  withVisionBoundary,
} from "@opencode-ai/core/session/runner/llm"

const sessionID = SessionSchema.ID.make("ses_materialization_boundary_test")
const fallbackMessages: readonly unknown[] = [{ id: "original" }]

const readWithEnv = (key: string, value: string | undefined, read: () => number) => {
  const previous = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
  try {
    return read()
  } finally {
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
  }
}

test("hanging message materialization fails terminally with a storage error", async () => {
  const exit = await Effect.runPromise(
    Effect.exit(withMessageMaterializationBoundary(sessionID, Effect.never, 10)),
  )
  if (!Exit.isFailure(exit)) throw new Error("expected the boundary to fail")
  expect(Cause.squash(exit.cause) as unknown).toBeInstanceOf(ContentStore.StorageError)
})

test("materialized messages pass through the boundary untouched", async () => {
  const result = await Effect.runPromise(
    withMessageMaterializationBoundary(sessionID, Effect.succeed(fallbackMessages), 10_000),
  )
  expect(result).toBe(fallbackMessages)
})

test("the materialization timeout interrupts the hung store work", async () => {
  const interrupted = await Effect.runPromise(
    Effect.gen(function* () {
      const flag = yield* Deferred.make<boolean>()
      const exit = yield* Effect.exit(
        withMessageMaterializationBoundary(
          sessionID,
          Deferred.await(flag).pipe(Effect.onInterrupt(() => Deferred.succeed(flag, true))),
          10,
        ),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      return yield* Deferred.await(flag).pipe(
        Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.succeed(false) }),
      )
    }),
  )
  expect(interrupted).toBe(true)
})

test("materialization failures are not converted into a timeout", async () => {
  const failure = new ContentStore.StorageError({
    operation: "read",
    resource: "ses_materialization_boundary_test",
    cause: new Error("store blew up"),
  })
  const exit = await Effect.runPromise(
    Effect.exit(withMessageMaterializationBoundary(sessionID, Effect.fail(failure), 10_000)),
  )
  if (!Exit.isFailure(exit)) throw new Error("expected the boundary to fail")
  expect(Cause.squash(exit.cause) as unknown).toBe(failure)
})

test("a hanging vision delegation fails open to the original messages", async () => {
  const result = await Effect.runPromise(
    withVisionBoundary({
      sessionID,
      phase: "delegation",
      timeoutMs: 10,
      effect: Effect.never,
      fallback: fallbackMessages,
    }),
  )
  expect(result).toBe(fallbackMessages)
})

test("a failing vision phase fails open to the fallback", async () => {
  const result = await Effect.runPromise(
    withVisionBoundary({
      sessionID,
      phase: "model_resolve",
      timeoutMs: 10_000,
      effect: Effect.die(new Error("resolve blew up")),
      fallback: fallbackMessages,
    }),
  )
  expect(result).toBe(fallbackMessages)
})

test("vision boundaries re-raise interrupts instead of failing open", async () => {
  const exit = await Effect.runPromise(
    Effect.exit(
      withVisionBoundary({
        sessionID,
        phase: "stream",
        timeoutMs: 10_000,
        effect: Effect.interrupt,
        fallback: fallbackMessages,
      }),
    ),
  )
  if (!Exit.isFailure(exit)) throw new Error("expected the boundary to stay interrupted")
  expect(Cause.hasInterrupts(exit.cause)).toBe(true)
})

test("boundary timeouts are bounded by default and configurable within positive values", () => {
  expect(messageMaterializationTimeoutMs()).toBe(60_000)
  expect(visionModelResolveTimeoutMs()).toBe(15_000)
  expect(visionStreamTimeoutMs()).toBe(60_000)
  expect(visionDelegationTimeoutMs()).toBe(90_000)

  expect(
    readWithEnv("OPENCODE_SESSION_MESSAGE_MATERIALIZATION_TIMEOUT_MS", "5", messageMaterializationTimeoutMs),
  ).toBe(5)
  expect(
    readWithEnv("OPENCODE_SESSION_MESSAGE_MATERIALIZATION_TIMEOUT_MS", "0", messageMaterializationTimeoutMs),
  ).toBe(60_000)
  expect(
    readWithEnv("OPENCODE_SESSION_VISION_MODEL_RESOLVE_TIMEOUT_MS", "abc", visionModelResolveTimeoutMs),
  ).toBe(15_000)
  expect(readWithEnv("OPENCODE_SESSION_VISION_STREAM_TIMEOUT_MS", "250", visionStreamTimeoutMs)).toBe(250)
  expect(
    readWithEnv("OPENCODE_SESSION_VISION_DELEGATION_TIMEOUT_MS", "-3", visionDelegationTimeoutMs),
  ).toBe(90_000)
})
