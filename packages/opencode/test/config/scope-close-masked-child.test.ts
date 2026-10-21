import { describe, expect } from "bun:test"
import { Effect, Exit, Fiber, Scope } from "effect"
import { it } from "../lib/effect"

// Durable boundary repro for the Effect fiber-observer re-entrancy defect.
// Core RED (no scopes, no joins, no timers in the assertion path):
// a fiber with one self-removing observer plus one sibling observer must
// deliver BOTH notifications. Pre-fix, the forward mutable loop plus
// splice-based removal skips the sibling.
// Extended shape: the same defect wedges Scope.close when the close's own
// await observer is the skipped slot while a waiter-joined masked child
// settles on its own timer.
function joinBounded<A, E>(fiber: Fiber.Fiber<A, E>, message: string, timeoutMs: number) {
  return Fiber.join(fiber).pipe(
    Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.fail(new Error(message)) }),
    Effect.exit,
  )
}

describe("fiber observer notification under concurrent close", () => {
  it.live(
    "a self-removing observer does not skip a sibling observer",
    Effect.gen(function* () {
      const events: string[] = []
      const removals: Array<() => void> = []
      const outcome = yield* Effect.promise(() =>
        Effect.runPromiseExit(
          Effect.gen(function* () {
            const child = Effect.runFork(Effect.sleep("20 millis"))
            const removeSelf = child.addObserver(() => {
              events.push("self")
              for (const remove of removals.splice(0)) remove()
            })
            removals.push(removeSelf)
            child.addObserver(() => events.push("sibling"))
            yield* Fiber.join(child).pipe(
              Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.fail(new Error("child pending")) }),
            )
            return true
          }).pipe(Effect.scoped),
        ),
      )
      expect(Exit.isSuccess(outcome)).toBe(true)
      expect(events).toContain("self")
      expect(events).toContain("sibling")
    }),
    20_000,
  )

  it.live(
    "close returns after a waiter-joined masked child settles on its own timer",
    Effect.gen(function* () {
      const events: string[] = []
      const outcome = yield* Effect.promise(() =>
        Effect.runPromiseExit(
          Effect.gen(function* () {
            const scope = yield* Scope.make()
            const child = yield* Effect.forkIn(
              Effect.sleep("100 millis").pipe(Effect.uninterruptible),
              scope,
            )
            const waiter = yield* Effect.forkDetach(
              Fiber.join(child).pipe(
                Effect.exit,
                Effect.tap(() => Effect.sync(() => events.push("join-ended"))),
                Effect.asVoid,
              ),
            )
            yield* Effect.sleep("10 millis")
            const close = yield* Effect.forkDetach(
              Scope.close(scope, Exit.void).pipe(
                Effect.tap(() => Effect.sync(() => events.push("close-ended"))),
              ),
            )
            const waiterExit = yield* joinBounded(waiter, "waiter pending", 2_000)
            const closeExit = yield* joinBounded(close, "close pending", 2_000)
            const polled = yield* Effect.sync(() => child.pollUnsafe())
            return { waiterExit, closeExit, polled }
          }).pipe(Effect.scoped),
        ),
      )
      expect(Exit.isSuccess(outcome), `run failed; events=${events.join(",")}`).toBe(true)
      expect(events).toContain("join-ended")
      if (Exit.isSuccess(outcome)) {
        expect(Exit.isSuccess(outcome.value.waiterExit)).toBe(true)
        expect(Exit.isSuccess(outcome.value.closeExit)).toBe(true)
        expect(outcome.value.polled !== undefined).toBe(true)
      }
      expect(events).toContain("close-ended")
    }),
    20_000,
  )

  it.live(
    "inserting a middle observer does not lose any original observer",
    Effect.gen(function* () {
      const events: string[] = []
      const removal: { current: (() => void) | undefined } = { current: undefined }
      const outcome = yield* Effect.promise(() =>
        Effect.runPromiseExit(
          Effect.gen(function* () {
            const scope = yield* Scope.make()
            const child = yield* Effect.forkIn(
              Effect.sleep("100 millis").pipe(Effect.uninterruptible),
              scope,
            )
            const waiter = yield* Effect.forkDetach(
              Fiber.join(child).pipe(
                Effect.exit,
                Effect.tap(() => Effect.sync(() => events.push("join-ended"))),
                Effect.asVoid,
              ),
            )
            yield* Effect.sleep("10 millis")
            removal.current = child.addObserver(() => events.push("middle-observer"))
            const close = yield* Effect.forkDetach(
              Scope.close(scope, Exit.void).pipe(
                Effect.tap(() => Effect.sync(() => events.push("close-ended"))),
              ),
            )
            const waiterExit = yield* joinBounded(waiter, "waiter pending", 2_000)
            const closeExit = yield* joinBounded(close, "close pending", 2_000)
            return { waiterExit, closeExit }
          }).pipe(Effect.scoped),
        ),
      )
      if (removal.current) removal.current()
      expect(Exit.isSuccess(outcome), `run failed; events=${events.join(",")}`).toBe(true)
      expect(events).toContain("join-ended")
      expect(events).toContain("close-ended")
      expect(events).toContain("middle-observer")
      if (Exit.isSuccess(outcome)) {
        expect(Exit.isSuccess(outcome.value.closeExit)).toBe(true)
      }
    }),
    20_000,
  )

  it.live(
    "an observer added at terminal time fires exactly once",
    Effect.gen(function* () {
      const events: string[] = []
      const outcome = yield* Effect.promise(() =>
        Effect.runPromiseExit(
          Effect.gen(function* () {
            const scope = yield* Scope.make()
            const child = yield* Effect.forkIn(
              Effect.sleep("50 millis").pipe(Effect.uninterruptible),
              scope,
            )
            const waiter = yield* Effect.forkDetach(Fiber.join(child).pipe(Effect.asVoid))
            yield* Fiber.join(waiter).pipe(
              Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.fail(new Error("waiter pending")) }),
            )
            const polled = yield* Effect.sync(() => child.pollUnsafe())
            expect(polled !== undefined).toBe(true)
            const removeLate = child.addObserver(() => events.push("late"))
            removeLate()
            return true
          }).pipe(Effect.scoped),
        ),
      )
      expect(Exit.isSuccess(outcome)).toBe(true)
      expect(events).toEqual(["late"])
    }),
    20_000,
  )
})
