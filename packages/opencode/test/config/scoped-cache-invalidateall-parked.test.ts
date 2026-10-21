import { describe, expect } from "bun:test"
import { Deferred, Duration, Effect, Exit, Fiber, Option, ScopedCache } from "effect"
import { it } from "../lib/effect"

// Minimal boundary probes (no HTTP): ScopedCache.invalidateAll forks
// Scope.close per entry and awaits the close fibers. These scenarios pin which
// ingredient combination reproduces the production hang (entry finalizers done
// while invalidateAll never settles). The HTTP repro remains the authoritative
// red; these probes narrow the boundary.
interface Barrier {
  readonly arrive: Deferred.Deferred<boolean>
  readonly release: Deferred.Deferred<boolean>
}

const makeBarrier = Effect.gen(function* () {
  return {
    arrive: yield* Deferred.make<boolean>(),
    release: yield* Deferred.make<boolean>(),
  }
})

const makeCache = <R,>(lookup: Effect.Effect<void, never, R>) =>
  ScopedCache.makeWith<string, void, never, R>({
    capacity: Number.POSITIVE_INFINITY,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
    lookup: () => lookup,
  })

const arriveAndPark = (barrier: Barrier) =>
  Effect.gen(function* () {
    yield* Deferred.done(barrier.arrive, Exit.succeed(true)).pipe(Effect.ignore)
    yield* Deferred.await(barrier.release)
  })

const park = (input: {
  barrier: Barrier
  uninterruptible: boolean
  childExit: { value: string | undefined }
  retireDone: { value: boolean }
}) =>
  Effect.gen(function* () {
    // Mirrors the production parking: the flock acquire runs inside
    // Effect.acquireRelease's uninterruptible mask, so an interrupt is
    // deferred until the parked acquire settles. The non-mask branch is the
    // plain interruptible control.
    const parked = Effect.acquireRelease(arriveAndPark(input.barrier), () => Effect.void)
    yield* Effect.forkScoped((input.uninterruptible ? parked : arriveAndPark(input.barrier)).pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          input.childExit.value = Exit.isSuccess(exit) ? "settled" : "interrupted"
        }),
      ),
    ))
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        input.retireDone.value = true
      }),
    )
    return void undefined
  })

const releaseBarrier = (barrier: Barrier) => Deferred.done(barrier.release, Exit.succeed(true)).pipe(Effect.ignore)

const joinBounded = <A, E>(fiber: Fiber.Fiber<A, E>, message: string, timeoutMs = 5_000) =>
  Fiber.join(fiber).pipe(
    Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.fail(new Error(message)) }),
    Effect.exit,
  )

describe("ScopedCache.invalidateAll over parked entry children", () => {
  it.live(
    "settles immediately when the parked child is interruptible (normal contract)",
    Effect.gen(function* () {
      const barrier = yield* makeBarrier
      const childExit = { value: undefined as string | undefined }
      const retireDone = { value: false }
      const cache = yield* makeCache(park({ barrier, uninterruptible: false, childExit, retireDone }))
      yield* ScopedCache.get(cache, "entry-a")
      yield* Effect.sleep("50 millis")
      const arrived = yield* Deferred.await(barrier.arrive).pipe(Effect.option)
      expect(Option.isSome(arrived) && arrived.value).toBe(true)

      const invalidateAll = yield* ScopedCache.invalidateAll(cache).pipe(Effect.forkScoped)
      const settled = yield* joinBounded(invalidateAll, "pending", 2_000)
      expect(Exit.isSuccess(settled), "close over an interruptible parked child must settle immediately").toBe(true)
      expect(childExit.value).toBe("interrupted")
      expect(retireDone.value).toBe(true)
    }),
    15_000,
  )

  it.live(
    "settles after one uninterruptibly parked child (acquireRelease mask mirror) resolves",
    Effect.gen(function* () {
      const barrier = yield* makeBarrier
      const childExit = { value: undefined as string | undefined }
      const retireDone = { value: false }
      return yield* Effect.gen(function* () {
        const cache = yield* makeCache(park({ barrier, uninterruptible: true, childExit, retireDone }))
        yield* ScopedCache.get(cache, "entry-a")
        yield* Effect.sleep("50 millis")
        const arrived = yield* Deferred.await(barrier.arrive).pipe(Effect.option)
        expect(Option.isSome(arrived) && arrived.value).toBe(true)

        const invalidateAll = yield* ScopedCache.invalidateAll(cache).pipe(Effect.forkScoped)
        yield* Effect.sleep("300 millis")
        const whileParked = yield* joinBounded(invalidateAll, "pending", 200)
        // While the mask holds the interrupt, the close may still be pending.
        expect(Exit.isSuccess(whileParked)).toBe(false)

        const settled = yield* Effect.gen(function* () {
          yield* releaseBarrier(barrier)
          return yield* joinBounded(
            invalidateAll,
            "invalidateAll did not settle within 5s after the parked acquire resolved",
          )
        })
        expect(Exit.isSuccess(settled)).toBe(true)
        expect(childExit.value).toBe("interrupted")
        expect(retireDone.value).toBe(true)
      }).pipe(
        // The parked child must never outlive the test.
        Effect.ensuring(releaseBarrier(barrier)),
      )
    }),
    20_000,
  )

  it.live(
    "settles per-key invalidates over mixed settled and uninterruptibly parked children (close-shape mirror)",
    Effect.gen(function* () {
      const barrier = yield* makeBarrier
      const parkedExit = { value: undefined as string | undefined }
      const parkedRetire = { value: false }
      const settledRetire = { value: false }
      return yield* Effect.gen(function* () {
        const cache = yield* ScopedCache.makeWith<string, void>({
          capacity: Number.POSITIVE_INFINITY,
          timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
          lookup: (key) => {
            if (key === "parked-entry")
              return park({ barrier, uninterruptible: true, childExit: parkedExit, retireDone: parkedRetire })
            return Effect.asVoid(
              Effect.addFinalizer(() =>
                Effect.sync(() => {
                  settledRetire.value = true
                }),
              ),
            )
          },
        })
        yield* ScopedCache.get(cache, "settled-entry")
        yield* ScopedCache.get(cache, "parked-entry")
        yield* Effect.sleep("50 millis")
        const arrived = yield* Deferred.await(barrier.arrive).pipe(Effect.option)
        expect(Option.isSome(arrived) && arrived.value).toBe(true)

        // Same shape as the production per-key diagnostic: sequential single
        // invalidates over the mixed cache.
        const loop = yield* Effect.forEach(
          ["settled-entry", "parked-entry"] as const,
          (key) => ScopedCache.invalidate(cache, key),
          { discard: true },
        ).pipe(Effect.forkScoped)
        yield* Effect.sleep("300 millis")
        const whileParked = yield* joinBounded(loop, "pending", 200)
        // The settled entry's close is already done; the parked one may
        // still be blocked on the mask.
        expect(Exit.isSuccess(whileParked)).toBe(false)

        const settled = yield* Effect.gen(function* () {
          yield* releaseBarrier(barrier)
          return yield* joinBounded(loop, "sequential per-key invalidates did not settle within 5s after release")
        })
        expect(Exit.isSuccess(settled)).toBe(true)
        expect(parkedExit.value).toBe("interrupted")
        expect(parkedRetire.value).toBe(true)
        expect(settledRetire.value).toBe(true)
      }).pipe(
        // The parked child must never outlive the test.
        Effect.ensuring(releaseBarrier(barrier)),
      )
    }),
    20_000,
  )

  it.live(
    "settles a single invalidate while a waiter retries get() during the close (production interleave mirror)",
    Effect.gen(function* () {
      const oldBarrier = yield* makeBarrier
      const newBarrier = yield* makeBarrier
      const oldExit = { value: undefined as string | undefined }
      const newExit = { value: undefined as string | undefined }
      const looks = { value: 0 }
      return yield* Effect.gen(function* () {
        const cache = yield* ScopedCache.makeWith<string, void>({
          capacity: Number.POSITIVE_INFINITY,
          timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
          lookup: () =>
            Effect.gen(function* () {
              // First lookup parks on oldBarrier; the retry's fresh lookup
              // parks on newBarrier.
              const barrier = looks.value === 0 ? oldBarrier : newBarrier
              const childExit = looks.value === 0 ? oldExit : newExit
              looks.value++
              yield* Effect.forkScoped(
                Effect.acquireRelease(arriveAndPark(barrier), () => Effect.void).pipe(
                  Effect.onExit((exit) =>
                    Effect.sync(() => {
                      childExit.value = Exit.isSuccess(exit) ? "settled" : "interrupted"
                    }),
                  ),
                ),
              )
              return void undefined
            }),
        })
        yield* ScopedCache.get(cache, "entry")
        yield* Effect.sleep("50 millis")
        const arrived = yield* Deferred.await(oldBarrier.arrive).pipe(Effect.option)
        expect(Option.isSome(arrived) && arrived.value).toBe(true)

        const close = yield* ScopedCache.invalidate(cache, "entry").pipe(Effect.forkScoped)
        yield* Effect.sleep("100 millis")

        // The production waiter retries get() while the old close is in
        // flight: the cleared map forces a fresh lookup with fresh children.
        const retryGet = yield* ScopedCache.get(cache, "entry").pipe(Effect.forkScoped)
        yield* Effect.sleep("100 millis")
        const retried = yield* Deferred.await(newBarrier.arrive).pipe(Effect.option)
        expect(Option.isSome(retried) && retried.value).toBe(true)

        const settled = yield* Effect.gen(function* () {
          yield* releaseBarrier(oldBarrier)
          yield* releaseBarrier(newBarrier)
          return yield* joinBounded(
            close,
            "single invalidate with a concurrent retry-get did not settle within 5s after both releases",
          )
        })
        expect(Exit.isSuccess(settled)).toBe(true)
        const retryResult = yield* joinBounded(retryGet, "retry get did not settle")
        expect(Exit.isSuccess(retryResult)).toBe(true)
        expect(oldExit.value).toBe("interrupted")
        // The new entry is never closed in this flow, so its child runs to
        // completion normally instead of being interrupted.
        expect(newExit.value).toBe("settled")
      }).pipe(
        // Neither parked child may outlive the test.
        Effect.ensuring(
          Effect.gen(function* () {
            yield* releaseBarrier(oldBarrier)
            yield* releaseBarrier(newBarrier)
          }),
        ),
      )
    }),
    20_000,
  )

  it.live(
    "settles a single invalidate over a child whose interrupt is captured as success (production deps-pipe mirror)",
    Effect.gen(function* () {
      const barrier = yield* makeBarrier
      const childSettled = { value: false }
      const retireDone = { value: false }
      return yield* Effect.gen(function* () {
        const cache = yield* makeCache(
          Effect.gen(function* () {
            // Exact production deps-pipe shape: npmSvc.install(...).pipe(
            // Effect.exit, tap-failure-log, Effect.asVoid, Effect.forkScoped).
            // The interrupt dies inside Effect.exit, so the child fiber exits
            // with SUCCESS instead of interrupt.
            yield* Effect.forkScoped(
              Effect.acquireRelease(arriveAndPark(barrier), () => Effect.void).pipe(
                Effect.exit,
                Effect.tap((exit) => (Exit.isFailure(exit) ? Effect.void : Effect.void)),
                Effect.asVoid,
                Effect.onExit(() =>
                  Effect.sync(() => {
                    childSettled.value = true
                  }),
                ),
              ),
            )
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                retireDone.value = true
              }),
            )
            return void undefined
          }),
        )
        yield* ScopedCache.get(cache, "entry")
        yield* Effect.sleep("50 millis")
        const arrived = yield* Deferred.await(barrier.arrive).pipe(Effect.option)
        expect(Option.isSome(arrived) && arrived.value).toBe(true)

        const close = yield* ScopedCache.invalidate(cache, "entry").pipe(Effect.forkScoped)
        yield* Effect.sleep("300 millis")
        const whileParked = yield* joinBounded(close, "pending", 200)
        // The entry scope has an uninterruptibly parked child; the close may
        // still be blocked on the mask.
        expect(Exit.isSuccess(whileParked)).toBe(false)

        const settled = yield* Effect.gen(function* () {
          yield* releaseBarrier(barrier)
          return yield* joinBounded(
            close,
            "single invalidate over an exit-captured parked child did not settle within 5s after release",
          )
        })
        expect(Exit.isSuccess(settled)).toBe(true)
        expect(childSettled.value).toBe(true)
        expect(retireDone.value).toBe(true)
      }).pipe(
        // The parked child must never outlive the test.
        Effect.ensuring(releaseBarrier(barrier)),
      )
    }),
    20_000,
  )
})
