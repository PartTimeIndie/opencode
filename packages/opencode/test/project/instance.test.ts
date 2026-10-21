import { describe, expect, spyOn } from "bun:test"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Layer } from "effect"
import { InstanceRef } from "../../src/effect/instance-ref"
import { registerDisposer } from "../../src/effect/instance-registry"
import { InstanceState } from "../../src/effect/instance-state"
import { instanceDisposeTimeoutMs } from "../../src/project/instance-store"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { SessionID } from "../../src/session/schema"
import { SessionRunState } from "../../src/session/run-state"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

let bootstrapRun: Effect.Effect<void> = Effect.void
const noopBootstrap = Layer.succeed(
  InstanceBootstrap.Service,
  InstanceBootstrap.Service.of({ run: Effect.suspend(() => bootstrapRun) }),
)

const it = testEffect(
  Layer.mergeAll(InstanceStore.defaultLayer, SessionRunState.defaultLayer, CrossSpawnSpawner.defaultLayer).pipe(
    Layer.provide(noopBootstrap),
  ),
)

const setBootstrap = (run: Effect.Effect<void>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      bootstrapRun = run
    }),
    () =>
      Effect.sync(() => {
        bootstrapRun = Effect.void
      }),
  )

const registerDisposerScoped = (disposer: (directory: string) => Promise<void>) =>
  Effect.acquireRelease(
    Effect.sync(() => registerDisposer(disposer)),
    (off) => Effect.sync(off),
  )

const fastDisposeTimeout = Effect.acquireRelease(
  Effect.sync(() => {
    process.env.OPENCODE_INSTANCE_DISPOSE_TIMEOUT_MS = "25"
  }),
  () =>
    Effect.sync(() => {
      delete process.env.OPENCODE_INSTANCE_DISPOSE_TIMEOUT_MS
    }),
)

const deadlineBootstrapTimeout = Effect.acquireRelease(
  Effect.sync(() => {
    process.env.OPENCODE_SETTLEMENT_BOOTSTRAP_TIMEOUT_MS = "700"
  }),
  () =>
    Effect.sync(() => {
      delete process.env.OPENCODE_SETTLEMENT_BOOTSTRAP_TIMEOUT_MS
    }),
)

const longDisposeTimeout = Effect.acquireRelease(
  Effect.sync(() => {
    process.env.OPENCODE_INSTANCE_DISPOSE_TIMEOUT_MS = "1000"
  }),
  () =>
    Effect.sync(() => {
      delete process.env.OPENCODE_INSTANCE_DISPOSE_TIMEOUT_MS
    }),
)

// Gate awaits fail with the exact stage name so a RED run names the precise
// lifecycle boundary instead of a generic TimeoutError.
const awaitStage = (stage: string, deferred: Deferred.Deferred<void>, duration: Duration.Input) =>
  Deferred.await(deferred).pipe(
    Effect.timeout(duration),
    Effect.mapError(() => new Error(`gate ${stage} not observed within ${duration}`)),
  )

// The store canonicalizes directory keys per platform; compare identities the
// same way instead of byte equality.
const sameDirectory = (a: string, b: string) =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b

const message = (sessionID: SessionID): SessionV1.WithParts => ({
  info: {
    id: SessionV1.MessageID.ascending(),
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
  },
  parts: [],
})

describe("InstanceStore", () => {
  it.live("times out a stalled path lookup without blocking other work", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const previous = process.env.OPENCODE_INSTANCE_PATH_RESOLVE_TIMEOUT_MS
      process.env.OPENCODE_INSTANCE_PATH_RESOLVE_TIMEOUT_MS = "30"
      const resolve = spyOn(FSUtil, "resolveAsync").mockImplementation(() => new Promise<string>(() => {}))
      yield* Effect.addFinalizer(() => Effect.sync(() => {
        resolve.mockRestore()
        if (previous === undefined) delete process.env.OPENCODE_INSTANCE_PATH_RESOLVE_TIMEOUT_MS
        else process.env.OPENCODE_INSTANCE_PATH_RESOLVE_TIMEOUT_MS = previous
      }))
      const start = Date.now()
      const [exit, repeated] = yield* Effect.all([
        store.load({ directory: dir }).pipe(Effect.exit),
        store.load({ directory: dir }).pipe(Effect.exit),
      ], { concurrency: 2 })
      expect(Date.now() - start).toBeLessThan(1000)
      expect(resolve).toHaveBeenCalledTimes(1)
      expect(Exit.isFailure(exit)).toBeTrue()
      expect(Exit.isFailure(repeated)).toBeTrue()
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toMatchObject({
        _tag: "InstanceUnavailableError",
        reason: "project directory resolution timed out",
      })
    }),
  )

  it.live("loads instance context", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const ctx = yield* store.load({ directory: dir })

      expect(ctx.directory).toBe(dir)
      expect(ctx.worktree).toBe(dir)
    }),
  )

  it.live("runs bootstrap with InstanceRef provided", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      let initializedDirectory: string | undefined

      yield* setBootstrap(
        Effect.gen(function* () {
          initializedDirectory = (yield* InstanceRef)?.directory
        }),
      )
      yield* store.load({ directory: dir })

      expect(initializedDirectory).toBe(dir)
    }),
  )

  it.live("caches loaded instance context by directory", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      let initialized = 0

      yield* setBootstrap(
        Effect.sync(() => {
          initialized++
        }),
      )
      const first = yield* store.load({ directory: dir })
      const second = yield* store.load({ directory: dir })

      expect(second).toBe(first)
      expect(initialized).toBe(1)
    }),
  )

  ;(process.platform === "win32" ? it.live : it.live.skip)(
    "dedupes case and separator variants without changing the display directory",
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      let initialized = 0

      yield* setBootstrap(
        Effect.sync(() => {
          initialized++
        }),
      )
      const first = yield* store.load({ directory: dir })
      const second = yield* store.load({ directory: dir.replaceAll("\\", "/").toUpperCase() })

      expect(second).toBe(first)
      expect(first.directory).toBe(dir)
      expect(initialized).toBe(1)
    }),
  )

  it.live("dedupes concurrent loads while init is in flight", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let initialized = 0

      yield* setBootstrap(
        Effect.gen(function* () {
          initialized++
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(release)
        }),
      )
      const first = yield* store.load({ directory: dir }).pipe(Effect.forkScoped)

      yield* Deferred.await(started)

      yield* setBootstrap(
        Effect.sync(() => {
          initialized++
        }),
      )
      const second = yield* store.load({ directory: dir }).pipe(Effect.forkScoped)

      expect(initialized).toBe(1)
      yield* Deferred.succeed(release, undefined)

      const [firstCtx, secondCtx] = yield* Effect.all([Fiber.join(first), Fiber.join(second)])
      expect(secondCtx).toBe(firstCtx)
      expect(initialized).toBe(1)
    }),
  )

  it.live("keeps bootstrap alive when its first waiting request is cancelled", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let initialized = 0

      yield* setBootstrap(
        Effect.gen(function* () {
          initialized++
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(release)
        }),
      )
      const first = yield* store.load({ directory: dir }).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(first)

      const second = yield* store.load({ directory: dir }).pipe(Effect.forkChild)
      yield* Deferred.succeed(release, undefined)
      expect((yield* Fiber.join(second)).directory).toBe(dir)
      expect(initialized).toBe(1)
    }),
  )

  it.live("disposes a pending bootstrap without waiting for it to finish", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      let initialized = 0

      yield* setBootstrap(
        Effect.gen(function* () {
          initialized++
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(release)
        }).pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))),
      )
      const first = yield* store.load({ directory: dir }).pipe(Effect.exit, Effect.forkScoped)
      yield* Deferred.await(started)
      yield* setBootstrap(Effect.sync(() => initialized++))

      const disposal = yield* store.disposeAll().pipe(Effect.timeout("1 second"), Effect.exit)
      const stopped = yield* Deferred.await(interrupted).pipe(Effect.timeout("1 second"), Effect.exit)
      yield* Deferred.succeed(release, undefined)
      expect(Exit.isSuccess(disposal)).toBeTrue()
      expect(Exit.isSuccess(stopped)).toBeTrue()
      const aborted = yield* Fiber.join(first)
      const abortError = Exit.isFailure(aborted)
        ? aborted.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error as unknown)[0]
        : undefined
      expect(InstanceStore.InstanceUnavailableError.isInstance(abortError)).toBeTrue()
      if (InstanceStore.InstanceUnavailableError.isInstance(abortError)) {
        expect(abortError.directory).toBe(dir)
        expect(abortError.retryAfterMs).toBeGreaterThan(0)
      }
      expect((yield* store.load({ directory: dir })).directory).toBe(dir)
      expect(initialized).toBe(2)
    }),
  )

  it.live("reload replaces a pending bootstrap", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const started = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      let initialized = 0

      yield* setBootstrap(
        Effect.gen(function* () {
          initialized++
          yield* Deferred.succeed(started, undefined)
          yield* Effect.never
        }).pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))),
      )
      const first = yield* store.load({ directory: dir }).pipe(Effect.exit, Effect.forkScoped)
      yield* Deferred.await(started)
      yield* setBootstrap(Effect.sync(() => initialized++))

      const replacement = yield* store.reload({ directory: dir }).pipe(Effect.timeout("1 second"))
      yield* Deferred.await(interrupted).pipe(Effect.timeout("1 second"))
      const replaced = yield* Fiber.join(first)
      const replacedError = Exit.isFailure(replaced)
        ? replaced.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error as unknown)[0]
        : undefined
      expect(InstanceStore.InstanceUnavailableError.isInstance(replacedError)).toBeTrue()
      expect((yield* store.load({ directory: dir }))).toBe(replacement)
      expect(initialized).toBe(2)
    }),
  )

  it.live("pending dispose race: a fresh boot racing the aborted generation stays independent", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const started1 = yield* Deferred.make<void>()
      const gate1 = yield* Deferred.make<void>()
      const started2 = yield* Deferred.make<void>()
      const gate2 = yield* Deferred.make<void>()
      const generations: number[] = []

      // The same gated generation function serves every boot; gates are
      // released unconditionally so teardown can never hang on a parked boot.
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* Deferred.succeed(gate1, undefined).pipe(Effect.ignore)
          yield* Deferred.succeed(gate2, undefined).pipe(Effect.ignore)
        }),
      )
      yield* setBootstrap(
        Effect.gen(function* () {
          const generation = generations.length + 1
          generations.push(generation)
          if (generation === 1) {
            yield* Deferred.succeed(started1, undefined)
            yield* Deferred.await(gate1)
            return
          }
          yield* Deferred.succeed(started2, undefined)
          yield* Deferred.await(gate2)
        }),
      )

      const first = yield* store.load({ directory: dir }).pipe(Effect.exit, Effect.forkScoped)
      yield* Deferred.await(started1)

      // Pending dispose removes the entry and interrupts the old boot while
      // its cancellation is still unwinding; the fresh reader starts in that
      // exact window and must get its own independent generation.
      const disposal = yield* store.disposeAll().pipe(Effect.timeout("1 second"), Effect.exit)
      expect(Exit.isSuccess(disposal)).toBeTrue()

      const second = yield* store.load({ directory: dir }).pipe(Effect.exit, Effect.forkScoped)
      yield* Deferred.await(started2)

      // The aborted generation unwinds only now, while the fresh boot is parked.
      yield* Deferred.succeed(gate1, undefined)
      const aborted = yield* Fiber.join(first)
      const abortError = Exit.isFailure(aborted)
        ? aborted.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error as unknown)[0]
        : undefined
      expect(InstanceStore.InstanceUnavailableError.isInstance(abortError)).toBeTrue()
      if (InstanceStore.InstanceUnavailableError.isInstance(abortError)) {
        expect(abortError.directory).toBe(dir)
        expect(abortError.retryAfterMs).toBeGreaterThan(0)
      }

      yield* Deferred.succeed(gate2, undefined)
      const fresh = yield* Fiber.join(second)
      expect(Exit.isSuccess(fresh)).toBeTrue()
      if (Exit.isSuccess(fresh)) expect(fresh.value.directory).toBe(dir)
      expect(generations).toEqual([1, 2])
    }),
  )

  // Real boundary race: every boot reads through the same InstanceState
  // ScopedCache. Pending disposal and reload must run disposeState for the
  // aborted generation exactly like the deadline path: the state-cache entry
  // has to be invalidated BEFORE any later reader can either join the dying
  // lookup (a fresh boot inherits the interrupt — the observed follow-up 503)
  // or close the old entry scope itself and park behind its teardown.
  // Interrupt ownership: interruptPending settles the old entry's deferred,
  // then detaches Fiber.interrupt on the boot fiber; the aborted generation
  // observes that interrupt and holds its unwind open below, so the fresh
  // reader provably starts while the old lookup is still dying.
  it.live("pending dispose invalidates the state cache before a fresh boot reads it", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      yield* fastDisposeTimeout
      const started1 = yield* Deferred.make<void>()
      const started2 = yield* Deferred.make<void>()
      const park1 = yield* Deferred.make<void>()
      const park2 = yield* Deferred.make<void>()
      const unwindStarted = yield* Deferred.make<void>()
      const unwindGate = yield* Deferred.make<void>()
      const teardownStarted = yield* Deferred.make<void>()
      const teardownGate = yield* Deferred.make<void>()
      const teardownFinished = yield* Deferred.make<void>()
      const generations: number[] = []

      // Released by Effect.ensuring BEFORE the test scope closes: scoped fork
      // finalizers run first (LIFO) and their fibers park on these gates, so a
      // scope-close finalizer would deadlock behind them.
      const releaseGates = Effect.gen(function* () {
        yield* Deferred.succeed(park1, undefined).pipe(Effect.ignore)
        yield* Deferred.succeed(park2, undefined).pipe(Effect.ignore)
        yield* Deferred.succeed(unwindGate, undefined).pipe(Effect.ignore)
        yield* Deferred.succeed(teardownGate, undefined).pipe(Effect.ignore)
        yield* Deferred.succeed(teardownFinished, undefined).pipe(Effect.ignore)
      })

      const state = yield* InstanceState.make<{ generation: number }>(() =>
        Effect.gen(function* () {
          const generation = generations.length + 1
          generations.push(generation)
          if (generation === 1) {
            // Gated cancel finalizer: the aborted generation's entry scope
            // close stays parked until explicitly released.
            yield* Effect.addFinalizer(() =>
              Effect.gen(function* () {
                yield* Deferred.succeed(teardownStarted, undefined)
                yield* Deferred.await(teardownGate)
                yield* Deferred.succeed(teardownFinished, undefined)
              }),
            )
          }
          yield* Deferred.succeed(generation === 1 ? started1 : started2, undefined)
          if (generation === 1) {
            // Hold the abort unwind open so the fresh reader provably starts
            // while the old lookup is still dying, not after it finished.
            yield* Deferred.await(park1).pipe(
              Effect.onInterrupt(() =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(unwindStarted, undefined)
                  yield* Deferred.await(unwindGate)
                }),
              ),
            )
            return { generation }
          }
          yield* Deferred.await(park2)
          return { generation }
        }),
      )
      yield* setBootstrap(InstanceState.useEffect(state, () => Effect.void))

      return yield* Effect.gen(function* () {
        const first = yield* store.load({ directory: dir }).pipe(Effect.exit, Effect.forkScoped)
      yield* awaitStage("started1", started1, "2 seconds")

        const disposal = yield* store.disposeAll().pipe(Effect.timeout("2 seconds"), Effect.exit)
        expect(Exit.isSuccess(disposal)).toBeTrue()
        const aborted = yield* Fiber.join(first)
        const abortError = Exit.isFailure(aborted)
          ? aborted.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error as unknown)[0]
          : undefined
        expect(InstanceStore.InstanceUnavailableError.isInstance(abortError)).toBeTrue()
        if (InstanceStore.InstanceUnavailableError.isInstance(abortError)) {
          expect(abortError.directory).toBe(dir)
          expect(abortError.reason).toBe("instance bootstrap was interrupted by reload or dispose")
          expect(abortError.retryAfterMs).toBeGreaterThan(0)
        }

        // The aborted generation observed the detached interrupt and is holding
        // its unwind open: the fresh reader below cannot be ordered after a
        // completed old unwind.
      yield* awaitStage("unwindStarted", unwindStarted, "2 seconds")

        const second = yield* store.load({ directory: dir }).pipe(Effect.exit, Effect.forkScoped)
        // The fresh boot must start its own generation even though the old
        // unwind is still held and the old teardown is still parked.
      yield* awaitStage("started2", started2, "2 seconds")

        // The pending path ran the state disposer itself: it entered the old
        // gated scope close, which means the cache entry was already removed.
        yield* awaitStage("teardownStarted", teardownStarted, "2 seconds")

        yield* Deferred.succeed(unwindGate, undefined)
        yield* Deferred.succeed(park2, undefined)
        const fresh = yield* Fiber.join(second)
        expect(Exit.isSuccess(fresh)).toBeTrue()

        // Late teardown: release the old disposer only after the fresh boot
        // finished, await PROOF that its captured close completed, then
        // re-read the REAL InstanceState cache — it must still hold the
        // identical generation-2 value.
        if (Exit.isSuccess(fresh)) {
          expect(fresh.value.directory).toBe(dir)
          const stateBefore = yield* InstanceState.get(state).pipe(
            Effect.provideService(InstanceRef, fresh.value),
            Effect.timeout("2 seconds"),
          )
          expect(stateBefore.generation).toBe(2)
          yield* Deferred.succeed(teardownGate, undefined)
          yield* awaitStage("teardownFinished", teardownFinished, "2 seconds")
          const stateAfter = yield* InstanceState.get(state).pipe(
            Effect.provideService(InstanceRef, fresh.value),
            Effect.timeout("2 seconds"),
          )
          expect(stateAfter).toBe(stateBefore)
          expect(stateAfter.generation).toBe(2)
        }
        expect(generations).toEqual([1, 2])
      }).pipe(Effect.ensuring(releaseGates))
    }),
  )

  // Contrast through the real deadline path: armBootstrapDeadline keeps the
  // generation pinned while disposeState runs the registered InstanceState
  // disposer. ScopedCache.invalidate removes the map entry BEFORE closing the
  // old scope, so the disposer parks alone on the gated teardown and a fresh
  // boot starts and completes independently.
  it.live("deadline path keeps a fresh boot independent of gated old teardown", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      yield* fastDisposeTimeout
      yield* deadlineBootstrapTimeout
      const started1 = yield* Deferred.make<void>()
      const started2 = yield* Deferred.make<void>()
      const park1 = yield* Deferred.make<void>()
      const park2 = yield* Deferred.make<void>()
      const teardownStarted = yield* Deferred.make<void>()
      const teardownGate = yield* Deferred.make<void>()
      const generations: number[] = []

      // Released by Effect.ensuring BEFORE the test scope closes (see the
      // pending-dispose test above for the fork-finalizer ordering rationale).
      const releaseGates = Effect.gen(function* () {
        yield* Deferred.succeed(park1, undefined).pipe(Effect.ignore)
        yield* Deferred.succeed(park2, undefined).pipe(Effect.ignore)
        yield* Deferred.succeed(teardownGate, undefined).pipe(Effect.ignore)
      })

      const state = yield* InstanceState.make<{ generation: number }>(() =>
        Effect.gen(function* () {
          const generation = generations.length + 1
          generations.push(generation)
          if (generation === 1) {
            yield* Effect.addFinalizer(() =>
              Effect.gen(function* () {
                yield* Deferred.succeed(teardownStarted, undefined)
                yield* Deferred.await(teardownGate)
              }),
            )
          }
          yield* Deferred.succeed(generation === 1 ? started1 : started2, undefined)
          yield* Deferred.await(generation === 1 ? park1 : park2)
          return { generation }
        }),
      )
      yield* setBootstrap(InstanceState.useEffect(state, () => Effect.void))

      return yield* Effect.gen(function* () {
        const first = yield* store.load({ directory: dir }).pipe(Effect.exit, Effect.forkScoped)
        yield* awaitStage("started1", started1, "2 seconds")

        const deadline = yield* Fiber.join(first).pipe(Effect.timeout("3 seconds"))
        const deadlineError = Exit.isFailure(deadline)
          ? deadline.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error as unknown)[0]
          : undefined
        expect(InstanceStore.InstanceUnavailableError.isInstance(deadlineError)).toBeTrue()
        if (InstanceStore.InstanceUnavailableError.isInstance(deadlineError)) {
        expect(sameDirectory(deadlineError.directory, dir)).toBeTrue()
          expect(deadlineError.reason).toBe("instance bootstrap did not settle within 700ms")
          expect(deadlineError.retryAfterMs).toBeGreaterThan(0)
        }

        // The deadline's disposeState entered the old generation's gated scope
        // close, so the state-cache entry is already invalidated here.
        yield* awaitStage("teardownStarted", teardownStarted, "2 seconds")

        // The fresh boot starts and completes while the old teardown is still
        // parked: the deadline path shields it from the aborted generation.
        const second = yield* store.load({ directory: dir }).pipe(Effect.exit, Effect.forkScoped)
        yield* awaitStage("started2", started2, "2 seconds")
        yield* Deferred.succeed(park2, undefined)
        const fresh = yield* Fiber.join(second)
        expect(Exit.isSuccess(fresh)).toBeTrue()
        if (Exit.isSuccess(fresh)) expect(fresh.value.directory).toBe(dir)
        expect(generations).toEqual([1, 2])
      }).pipe(Effect.ensuring(releaseGates))
    }),
  )

  // Retirement barrier: a load racing an in-flight pending retirement must
  // wait for the disposal barrier and only then boot its own fresh generation
  // — never boot mid-retirement against the dying generation's state cache.
  it.live("concurrent load during pending retirement waits for the barrier and boots fresh", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      yield* longDisposeTimeout
      let signalRetirement: () => void = () => {}
      let releaseRetirement: () => void = () => {}
      const retirementStarted = new Promise<void>((resolve) => {
        signalRetirement = resolve
      })
      const retirementRelease = new Promise<void>((resolve) => {
        releaseRetirement = resolve
      })
      yield* registerDisposerScoped(async () => {
        signalRetirement()
        await retirementRelease
      })
      const started1 = yield* Deferred.make<void>()
      const started2 = yield* Deferred.make<void>()
      const park1 = yield* Deferred.make<void>()
      const park2 = yield* Deferred.make<void>()
      const teardownStarted = yield* Deferred.make<void>()
      const teardownGate = yield* Deferred.make<void>()
      const generations: number[] = []

      // Released by Effect.ensuring BEFORE the test scope closes (fork
      // finalizers run first — see the pending-dispose test above).
      const releaseGates = Effect.gen(function* () {
        yield* Deferred.succeed(park1, undefined).pipe(Effect.ignore)
        yield* Deferred.succeed(park2, undefined).pipe(Effect.ignore)
        yield* Deferred.succeed(teardownGate, undefined).pipe(Effect.ignore)
        yield* Effect.sync(() => releaseRetirement()).pipe(Effect.ignore)
      })

      const state = yield* InstanceState.make<{ generation: number }>(() =>
        Effect.gen(function* () {
          const generation = generations.length + 1
          generations.push(generation)
          if (generation === 1) {
            yield* Effect.addFinalizer(() =>
              Effect.gen(function* () {
                yield* Deferred.succeed(teardownStarted, undefined)
                yield* Deferred.await(teardownGate)
              }),
            )
          }
          yield* Deferred.succeed(generation === 1 ? started1 : started2, undefined)
          yield* Deferred.await(generation === 1 ? park1 : park2)
          return { generation }
        }),
      )
      yield* setBootstrap(InstanceState.useEffect(state, () => Effect.void))

      return yield* Effect.gen(function* () {
        const first = yield* store.load({ directory: dir }).pipe(Effect.exit, Effect.forkScoped)
        yield* awaitStage("started1", started1, "2 seconds")

        const sweeper = yield* store.disposeAll().pipe(Effect.forkScoped)
        yield* Effect.promise(() => retirementStarted).pipe(
          Effect.timeout("2 seconds"),
          Effect.mapError(() => new Error("gate retirementStarted not observed within 2 seconds")),
        )

        // The racing load starts while retirement is still in flight.
        const second = yield* store.load({ directory: dir }).pipe(Effect.exit, Effect.forkScoped)
        yield* Effect.sync(() => releaseRetirement())

        // Retirement must establish BEFORE the racing boot starts; the fixed
        // order is retired-then-booted, a barrier-less sweep boots mid-flight.
        const order: string[] = []
        yield* Effect.all(
          [
            Fiber.join(sweeper).pipe(
              Effect.timeout("3 seconds"),
              Effect.tap(() => Effect.sync(() => order.push("retired"))),
              Effect.exit,
            ),
            awaitStage("started2", started2, "3 seconds").pipe(
              Effect.tap(() => Effect.sync(() => order.push("booted"))),
              Effect.exit,
            ),
          ],
          { concurrency: 2, discard: true },
        )
        expect(order).toEqual(["retired", "booted"])

        yield* Deferred.succeed(park2, undefined)
        const fresh = yield* Fiber.join(second)
        expect(Exit.isSuccess(fresh)).toBeTrue()
        if (Exit.isSuccess(fresh)) expect(sameDirectory(fresh.value.directory, dir)).toBeTrue()
        expect(generations).toEqual([1, 2])
      }).pipe(Effect.ensuring(releaseGates))
    }),
  )

  // Concurrent dispose during a pending reload's retirement: the sweep waits
  // on the reload's disposal barrier, and the replacement generation is booted
  // and read exactly once — a real state re-read still returns generation 2.
  it.live("concurrent dispose during pending reload waits on the barrier without re-invalidating", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      yield* longDisposeTimeout
      let signalRetirement: () => void = () => {}
      let releaseRetirement: () => void = () => {}
      const retirementStarted = new Promise<void>((resolve) => {
        signalRetirement = resolve
      })
      const retirementRelease = new Promise<void>((resolve) => {
        releaseRetirement = resolve
      })
      yield* registerDisposerScoped(async () => {
        signalRetirement()
        await retirementRelease
      })
      const started1 = yield* Deferred.make<void>()
      const started2 = yield* Deferred.make<void>()
      const park1 = yield* Deferred.make<void>()
      const park2 = yield* Deferred.make<void>()
      const teardownStarted = yield* Deferred.make<void>()
      const teardownGate = yield* Deferred.make<void>()
      const generations: number[] = []

      // Released by Effect.ensuring BEFORE the test scope closes (fork
      // finalizers run first — see the pending-dispose test above).
      const releaseGates = Effect.gen(function* () {
        yield* Deferred.succeed(park1, undefined).pipe(Effect.ignore)
        yield* Deferred.succeed(park2, undefined).pipe(Effect.ignore)
        yield* Deferred.succeed(teardownGate, undefined).pipe(Effect.ignore)
        yield* Effect.sync(() => releaseRetirement()).pipe(Effect.ignore)
      })

      const state = yield* InstanceState.make<{ generation: number }>(() =>
        Effect.gen(function* () {
          const generation = generations.length + 1
          generations.push(generation)
          if (generation === 1) {
            yield* Effect.addFinalizer(() =>
              Effect.gen(function* () {
                yield* Deferred.succeed(teardownStarted, undefined)
                yield* Deferred.await(teardownGate)
              }),
            )
          }
          yield* Deferred.succeed(generation === 1 ? started1 : started2, undefined)
          yield* Deferred.await(generation === 1 ? park1 : park2)
          return { generation }
        }),
      )
      yield* setBootstrap(InstanceState.useEffect(state, () => Effect.void))

      return yield* Effect.gen(function* () {
        const first = yield* store.load({ directory: dir }).pipe(Effect.exit, Effect.forkScoped)
        yield* awaitStage("started1", started1, "2 seconds")

        // The reload owns the pending retirement; the sweep must wait on its
        // disposal barrier instead of retiring the entry a second time.
        const reloader = yield* store.reload({ directory: dir }).pipe(Effect.forkScoped)
        yield* Effect.promise(() => retirementStarted).pipe(
          Effect.timeout("2 seconds"),
          Effect.mapError(() => new Error("gate retirementStarted not observed within 2 seconds")),
        )
        const sweeper = yield* store.disposeAll().pipe(Effect.forkScoped)
        yield* Effect.sync(() => releaseRetirement())

        yield* awaitStage("started2", started2, "3 seconds")
        yield* Deferred.succeed(park2, undefined)
        const reloaded = yield* Fiber.join(reloader).pipe(Effect.timeout("3 seconds"), Effect.exit)
        const swept = yield* Fiber.join(sweeper).pipe(Effect.timeout("3 seconds"), Effect.exit)
        expect(Exit.isSuccess(reloaded)).toBeTrue()
        expect(Exit.isSuccess(swept)).toBeTrue()

        // The replacement generation is still the one and only cached state:
        // a real InstanceState re-read must return generation 2, not trigger
        // a third init.
        yield* Deferred.succeed(teardownGate, undefined)
        if (Exit.isSuccess(reloaded)) {
          const again = yield* InstanceState.get(state).pipe(
            Effect.provideService(InstanceRef, reloaded.value),
            Effect.timeout("2 seconds"),
          )
          expect(again.generation).toBe(2)
        }
        expect(generations).toEqual([1, 2])
      }).pipe(Effect.ensuring(releaseGates))
    }),
  )

  it.live("removes failed loads from the cache", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      let attempts = 0

      yield* setBootstrap(
        Effect.sync(() => {
          attempts++
          throw new Error("init failed")
        }),
      )
      const failed = yield* store.load({ directory: dir }).pipe(
        Effect.as(false),
        Effect.catchCause(() => Effect.succeed(true)),
      )

      expect(failed).toBe(true)

      yield* setBootstrap(
        Effect.sync(() => {
          attempts++
        }),
      )
      const ctx = yield* store.load({ directory: dir })

      expect(ctx.directory).toBe(dir)
      expect(attempts).toBe(2)
    }),
  )

  it.live("reload replaces the cached context", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service

      const first = yield* store.load({ directory: dir })
      const second = yield* store.reload({ directory: dir })
      const cached = yield* store.load({ directory: dir })

      expect(second).not.toBe(first)
      expect(cached).toBe(second)
    }),
  )

  it.live("stale dispose does not delete an in-flight reload", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const reloading = yield* Deferred.make<void>()
      const releaseReload = yield* Deferred.make<void>()
      const disposed: Array<string> = []
      yield* registerDisposerScoped(async (directory) => {
        disposed.push(directory)
      })

      const first = yield* store.load({ directory: dir })
      yield* setBootstrap(
        Effect.gen(function* () {
          yield* Deferred.succeed(reloading, undefined)
          yield* Deferred.await(releaseReload)
        }),
      )
      const reload = yield* store.reload({ directory: dir }).pipe(Effect.forkScoped)

      yield* Deferred.await(reloading)
      const staleDispose = yield* store.dispose(first).pipe(Effect.forkScoped)
      yield* Deferred.succeed(releaseReload, undefined)

      const second = yield* Fiber.join(reload)
      yield* Fiber.join(staleDispose)

      expect(disposed).toEqual([dir])
      expect(yield* store.load({ directory: dir })).toBe(second)
    }),
  )

  it.live("replaces an instance when its disposer hangs", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const disposing = yield* Deferred.make<void>()
      yield* fastDisposeTimeout
      yield* registerDisposerScoped(() => {
        Deferred.doneUnsafe(disposing, Effect.void)
        return new Promise<void>(() => {})
      })

      const first = yield* store.load({ directory: dir })
      const dispose = yield* store.disposeAll().pipe(Effect.forkScoped)
      yield* Deferred.await(disposing)
      const second = yield* store.load({ directory: dir })
      yield* Fiber.join(dispose)

      expect(second).not.toBe(first)
      expect(yield* store.load({ directory: dir })).toBe(second)
    }),
  )

  it.live("reload completes when the previous instance disposer hangs", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const disposing = yield* Deferred.make<void>()
      yield* fastDisposeTimeout
      yield* registerDisposerScoped(() => {
        Deferred.doneUnsafe(disposing, Effect.void)
        return new Promise<void>(() => {})
      })

      const first = yield* store.load({ directory: dir })
      const reload = yield* store.reload({ directory: dir }).pipe(Effect.forkScoped)
      yield* Deferred.await(disposing)
      const second = yield* Fiber.join(reload)

      expect(second).not.toBe(first)
    }),
  )

  it.effect("parses the instance dispose timeout override", () =>
    Effect.sync(() => {
      expect(instanceDisposeTimeoutMs({ OPENCODE_INSTANCE_DISPOSE_TIMEOUT_MS: "250" })).toBe(250)
      expect(instanceDisposeTimeoutMs({ OPENCODE_INSTANCE_DISPOSE_TIMEOUT_MS: "-1" })).toBe(5000)
      expect(instanceDisposeTimeoutMs({ OPENCODE_INSTANCE_DISPOSE_TIMEOUT_MS: "nope" })).toBe(5000)
      expect(instanceDisposeTimeoutMs({})).toBe(5000)
    }),
  )

  it.live("dedupes concurrent disposeAll calls", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const disposing = yield* Deferred.make<void>()
      const releaseDispose = yield* Deferred.make<() => void>()
      const disposed: Array<string> = []
      yield* registerDisposerScoped((directory) => {
        disposed.push(directory)
        Deferred.doneUnsafe(disposing, Effect.void)
        return new Promise<void>((resolve) => {
          Deferred.doneUnsafe(releaseDispose, Effect.succeed(resolve))
        })
      })

      yield* store.load({ directory: dir })
      const first = yield* store.disposeAll().pipe(Effect.forkScoped)
      yield* Deferred.await(disposing)
      const release = yield* Deferred.await(releaseDispose)
      const second = yield* store.disposeAll().pipe(Effect.forkScoped)

      expect(disposed).toEqual([dir])
      yield* Effect.sync(release)
      yield* Effect.all([Fiber.join(first), Fiber.join(second)])
      expect(disposed).toEqual([dir])
    }),
  )

  it.live("re-arms disposeAll after completion", () =>
    Effect.gen(function* () {
      const dir1 = yield* tmpdirScoped({ git: true })
      const dir2 = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const disposed: Array<string> = []
      yield* registerDisposerScoped(async (directory) => {
        disposed.push(directory)
      })

      yield* store.load({ directory: dir1 })
      yield* store.disposeAll()
      expect(disposed).toEqual([dir1])

      yield* store.load({ directory: dir2 })
      yield* store.disposeAll()
      expect(disposed).toEqual([dir1, dir2])
    }),
  )

  it.live("does not cancel active session runs during global instance disposal", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const run = yield* SessionRunState.Service
      const ctx = yield* store.load({ directory: dir })
      const sessionID = SessionID.make("ses_global_dispose_keeps_run")
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      const output = message(sessionID)
      const running = yield* run
        .ensureRunning(
          sessionID,
          Effect.succeed(output),
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(output),
            Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
          ),
        )
        .pipe(Effect.provideService(InstanceRef, ctx), Effect.forkScoped)

      yield* Deferred.await(started)
      yield* store.disposeAll()
      yield* Effect.yieldNow

      expect(yield* Deferred.isDone(interrupted)).toBeFalse()
      const busy = yield* run.assertNotBusy(sessionID).pipe(Effect.provideService(InstanceRef, ctx), Effect.exit)
      expect(Exit.isFailure(busy)).toBeTrue()

      yield* Deferred.succeed(release, undefined)
      expect(yield* Fiber.join(running)).toBe(output)
    }),
  )

  it.live("does not cancel active session runs during instance reload", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const run = yield* SessionRunState.Service
      const ctx = yield* store.load({ directory: dir })
      const sessionID = SessionID.make("ses_reload_keeps_run")
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      const output = message(sessionID)
      const running = yield* run
        .ensureRunning(
          sessionID,
          Effect.succeed(output),
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(output),
            Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
          ),
        )
        .pipe(Effect.provideService(InstanceRef, ctx), Effect.forkScoped)

      yield* Deferred.await(started)
      yield* store.reload({ directory: dir })
      yield* Effect.yieldNow

      expect(yield* Deferred.isDone(interrupted)).toBeFalse()
      const busy = yield* run.assertNotBusy(sessionID).pipe(Effect.provideService(InstanceRef, ctx), Effect.exit)
      expect(Exit.isFailure(busy)).toBeTrue()

      yield* Deferred.succeed(release, undefined)
      expect(yield* Fiber.join(running)).toBe(output)
    }),
  )

  it.live("cancels active session runs during targeted instance disposal", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const run = yield* SessionRunState.Service
      const ctx = yield* store.load({ directory: dir })
      const sessionID = SessionID.make("ses_target_dispose_cancels_run")
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      const output = message(sessionID)
      const running = yield* run
        .ensureRunning(
          sessionID,
          Effect.succeed(output),
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(output),
            Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
          ),
        )
        .pipe(Effect.provideService(InstanceRef, ctx), Effect.forkScoped)

      yield* Deferred.await(started)
      yield* store.dispose(ctx)

      expect(yield* Deferred.isDone(interrupted)).toBeTrue()
      expect(yield* Fiber.join(running)).toBe(output)
    }),
  )

  it.live("dedupes concurrent first session run state creation", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const run = yield* SessionRunState.Service
      const ctx = yield* store.load({ directory: dir })
      const sessionID = SessionID.make("ses_concurrent_first_state")
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const output = message(sessionID)
      let startedCount = 0
      const work = Effect.sync(() => {
        startedCount++
      }).pipe(Effect.andThen(Deferred.succeed(started, undefined)), Effect.andThen(Deferred.await(release)), Effect.as(output))

      const exits = yield* Effect.forEach(
        Array.from({ length: 20 }),
        () =>
          run
            .startShell(sessionID, Effect.succeed(output), work)
            .pipe(Effect.provideService(InstanceRef, ctx), Effect.exit, Effect.forkScoped),
        { concurrency: "unbounded" },
      )

      yield* Deferred.await(started)
      yield* Deferred.succeed(release, undefined)
      const results = yield* Effect.forEach(exits, Fiber.join, { concurrency: "unbounded" })

      expect(startedCount).toBe(1)
      expect(results.filter(Exit.isSuccess)).toHaveLength(1)
      expect(results.filter(Exit.isFailure)).toHaveLength(19)
    }),
  )
})
