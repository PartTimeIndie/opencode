import { describe, expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { completeHealthyInitialization, forwardInitializationFailure } from "./initialization"

describe("desktop initialization", () => {
  test("keeps renderer initialization pending through slow startup and recovery until verified healthy", () => {
    Effect.runSync(
      Effect.gen(function* () {
        const initialization = yield* Deferred.make<string, unknown>()
        for (const phase of ["starting", "restarting", "exhausted", "blocked", "stopped"] as const) {
          yield* completeHealthyInitialization(initialization, "endpoint", { phase, attempt: 1 })
          expect(yield* Deferred.isDone(initialization)).toBe(false)
        }
        yield* completeHealthyInitialization(initialization, "endpoint", { phase: "healthy", attempt: 2 })
        expect(yield* Deferred.await(initialization)).toBe("endpoint")
        // Later recovery must not replace credentials or unmount live drafts.
        yield* completeHealthyInitialization(initialization, "replacement", { phase: "healthy", attempt: 3 })
        expect(yield* Deferred.await(initialization)).toBe("endpoint")
      }),
    )
  })

  const failure = new Error("sidecar startup failed")
  const expectFailure = (exit: Exit.Exit<unknown, unknown>) => {
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isSuccess(exit)) return
    expect(Cause.squash(exit.cause)).toBe(failure)
  }

  test("forwards loading task failures before renderer initialization", () => {
    const exit = Effect.runSync(
      Effect.gen(function* () {
        const initialization = yield* Deferred.make<never, unknown>()
        yield* forwardInitializationFailure(initialization)(Effect.die(failure)).pipe(Effect.exit)
        return yield* Deferred.await(initialization).pipe(Effect.exit)
      }),
    )

    expectFailure(exit)
  })

  test("forwards loading task failures while renderer initialization waits", () => {
    const exit = Effect.runSync(
      Effect.gen(function* () {
        const initialization = yield* Deferred.make<never, unknown>()
        const waiting = yield* Deferred.await(initialization).pipe(Effect.exit, Effect.forkChild)
        yield* forwardInitializationFailure(initialization)(Effect.die(failure)).pipe(Effect.exit)
        return yield* Fiber.join(waiting)
      }),
    )

    expectFailure(exit)
  })
})
