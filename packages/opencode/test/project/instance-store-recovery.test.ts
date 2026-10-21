import { expect } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { registerDisposer } from "../../src/effect/instance-registry"
import { InstanceState } from "../../src/effect/instance-state"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceStore, InstanceUnavailableError } from "../../src/project/instance-store"
import { tmpdirScoped } from "../fixture/fixture"
import { it } from "../lib/effect"

function unavailableReason(exit: Exit.Exit<unknown, unknown>) {
  if (!Exit.isFailure(exit)) return
  const reason = exit.cause.reasons.find(Cause.isFailReason)
  return reason && InstanceUnavailableError.isInstance(reason.error) ? reason.error.reason : undefined
}

it.live("bootstrap deadline evicts poisoned scoped state and late cleanup cannot evict its replacement", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped({ config: { formatter: false, lsp: false } })
    const cleanup = Promise.withResolvers<void>()
    const interrupted = Promise.withResolvers<void>()
    const previous = {
      bootstrap: process.env.OPENCODE_SETTLEMENT_BOOTSTRAP_TIMEOUT_MS,
      disposal: process.env.OPENCODE_INSTANCE_DISPOSE_TIMEOUT_MS,
    }
    process.env.OPENCODE_SETTLEMENT_BOOTSTRAP_TIMEOUT_MS = "400"
    process.env.OPENCODE_INSTANCE_DISPOSE_TIMEOUT_MS = "40"
    let attempts = 0
    let released = false
    try {
      const state = yield* InstanceState.make(() => Effect.gen(function* () {
        attempts++
        if (attempts > 1) return { attempt: attempts }
        yield* Effect.acquireRelease(
          Effect.void,
          () => Effect.promise(() => cleanup.promise.then(() => { released = true })),
        )
        return yield* Effect.never.pipe(Effect.onExit(() => Effect.sync(() => interrupted.resolve())))
      }))
      const bootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({
        run: InstanceState.get(state).pipe(Effect.asVoid),
      }))
      yield* Effect.gen(function* () {
        const store = yield* InstanceStore.Service
        const first = yield* store.load({ directory }).pipe(Effect.exit)
        expect(Exit.isFailure(first)).toBe(true)
        expect(unavailableReason(first)).toContain("did not settle")
        expect(attempts).toBe(1)
        yield* Effect.promise(() => interrupted.promise)
        yield* Effect.yieldNow

        // Retrying an interrupted ScopedCache entry can wait forever while
        // closing its old resource scope. Recovery must invalidate that entry
        // before another bootstrap can publish a permanently pending lookup.
        const recovered = yield* store.load({ directory }).pipe(Effect.exit)
        expect(Exit.isSuccess(recovered)).toBe(true)
        expect(attempts).toBe(2)
        expect(released).toBe(false)

        cleanup.resolve()
        yield* Effect.sleep("10 millis")
        const again = yield* store.load({ directory }).pipe(Effect.exit)
        expect(Exit.isSuccess(again)).toBe(true)
        if (Exit.isSuccess(recovered) && Exit.isSuccess(again)) expect(again.value).toBe(recovered.value)
        expect(attempts).toBe(2)
        expect(released).toBe(true)
      }).pipe(
        Effect.ensuring(Effect.sync(() => cleanup.resolve())),
        Effect.provide(InstanceStore.defaultLayer.pipe(Layer.provide(bootstrap))),
      )
    } finally {
      cleanup.resolve()
      if (previous.bootstrap === undefined) delete process.env.OPENCODE_SETTLEMENT_BOOTSTRAP_TIMEOUT_MS
      else process.env.OPENCODE_SETTLEMENT_BOOTSTRAP_TIMEOUT_MS = previous.bootstrap
      if (previous.disposal === undefined) delete process.env.OPENCODE_INSTANCE_DISPOSE_TIMEOUT_MS
      else process.env.OPENCODE_INSTANCE_DISPOSE_TIMEOUT_MS = previous.disposal
    }
  }).pipe(Effect.provide(CrossSpawnSpawner.defaultLayer)),
)

it.live("a retired boot's late defect cannot poison fresh failure accounting", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped({ config: { formatter: false, lsp: false } })
    const release = Promise.withResolvers<void>()
    const oldFinished = Promise.withResolvers<void>()
    let boots = 0
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const overrides = {
          OPENCODE_SETTLEMENT_BOOTSTRAP_TIMEOUT_MS: "400",
          OPENCODE_INSTANCE_DISPOSE_TIMEOUT_MS: "40",
          OPENCODE_SETTLEMENT_MAX_INSTANCE_RELOADS_PER_HOUR: "2",
          OPENCODE_SETTLEMENT_CIRCUIT_COOLDOWN_MS: "2000",
        }
        const previous = Object.keys(overrides).map((key) => [key, process.env[key]] as const)
        Object.assign(process.env, overrides)
        return previous
      }),
      (previous) => Effect.sync(() => {
        previous.forEach(([key, value]) => {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        })
      }),
    )
    const bootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({
      run: Effect.suspend(() => {
        boots++
        if (boots === 3) return Effect.die("fresh failure")
        if (boots !== 1) return Effect.void
        return Effect.promise(() => release.promise).pipe(
          Effect.andThen(Effect.die("retired boot failure")),
          Effect.onExit(() => Effect.sync(() => oldFinished.resolve())),
          Effect.uninterruptible,
        )
      }),
    }))
    yield* Effect.gen(function* () {
      const store = yield* InstanceStore.Service
      expect(Exit.isFailure(yield* store.load({ directory }).pipe(Effect.exit))).toBe(true)
      expect(Exit.isSuccess(yield* store.load({ directory }).pipe(Effect.exit))).toBe(true)
      expect(boots).toBe(2)
      release.resolve()
      yield* Effect.promise(() => oldFinished.promise)
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      yield* store.disposeDirectory(directory)
      const failed = yield* store.load({ directory }).pipe(Effect.exit)
      expect(Exit.isFailure(failed)).toBe(true)
      expect(unavailableReason(failed)).toContain("instance bootstrap failed")
      expect(Exit.isSuccess(yield* store.load({ directory }).pipe(Effect.exit))).toBe(true)
      expect(boots).toBe(4)
    }).pipe(
      Effect.ensuring(Effect.sync(() => release.resolve())),
      Effect.provide(InstanceStore.defaultLayer.pipe(Layer.provide(bootstrap))),
    )
  }).pipe(Effect.provide(CrossSpawnSpawner.defaultLayer)),
)

it.live("reload, loads and global disposals wait for the same deadline cleanup barrier", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped({ config: { formatter: false, lsp: false } })
    const cleanup = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    const reasons: string[] = []
    const settled: string[] = []
    let boots = 0
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const previous = {
          bootstrap: process.env.OPENCODE_SETTLEMENT_BOOTSTRAP_TIMEOUT_MS,
          disposal: process.env.OPENCODE_INSTANCE_DISPOSE_TIMEOUT_MS,
        }
        process.env.OPENCODE_SETTLEMENT_BOOTSTRAP_TIMEOUT_MS = "400"
        process.env.OPENCODE_INSTANCE_DISPOSE_TIMEOUT_MS = "2000"
        return previous
      }),
      (previous) => Effect.sync(() => {
        if (previous.bootstrap === undefined) delete process.env.OPENCODE_SETTLEMENT_BOOTSTRAP_TIMEOUT_MS
        else process.env.OPENCODE_SETTLEMENT_BOOTSTRAP_TIMEOUT_MS = previous.bootstrap
        if (previous.disposal === undefined) delete process.env.OPENCODE_INSTANCE_DISPOSE_TIMEOUT_MS
        else process.env.OPENCODE_INSTANCE_DISPOSE_TIMEOUT_MS = previous.disposal
      }),
    )
    yield* Effect.acquireRelease(
      Effect.sync(() => registerDisposer((target, reason) => {
        if (target !== directory) return Promise.resolve()
        reasons.push(reason)
        started.resolve()
        return cleanup.promise
      })),
      (off) => Effect.sync(off),
    )
    const bootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({
      run: Effect.suspend(() => ++boots === 1 ? Effect.never : Effect.void),
    }))
    yield* Effect.gen(function* () {
      const store = yield* InstanceStore.Service
      expect(unavailableReason(yield* store.load({ directory }).pipe(Effect.exit))).toContain("did not settle")
      yield* Effect.promise(() => started.promise).pipe(Effect.timeout("1 second"))
      const operations = [
        ["reload", store.reload({ directory }).pipe(Effect.asVoid)],
        ["load", store.load({ directory }).pipe(Effect.asVoid)],
        ["directory", store.disposeDirectory(directory)],
        ["all", store.disposeAll()],
        ["fresh", store.disposeAllFresh()],
      ] as const
      const fibers = yield* Effect.forEach(operations, ([name, operation]) =>
        operation.pipe(
          Effect.tap(() => Effect.sync(() => { settled.push(name) })),
          Effect.forkScoped({ startImmediately: true }),
        ),
      )
      expect(boots).toBe(1)
      expect(settled).toEqual([])
      expect(reasons).toEqual(["reload"])
      cleanup.resolve()
      yield* Effect.forEach(fibers, Fiber.join)
      expect(settled.toSorted()).toEqual(operations.map(([name]) => name).toSorted())
      expect(boots).toBe(2)
      expect(reasons).toEqual(["reload"])
      yield* store.load({ directory })
      expect(boots).toBe(2)
    }).pipe(
      Effect.ensuring(Effect.sync(() => cleanup.resolve())),
      Effect.provide(InstanceStore.defaultLayer.pipe(Layer.provide(bootstrap))),
    )
  }).pipe(Effect.provide(CrossSpawnSpawner.defaultLayer)),
)

it.live("a retired boot's late success cannot reset fresh circuit accounting", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped({ config: { formatter: false, lsp: false } })
    const release = Promise.withResolvers<void>()
    const oldFinished = Promise.withResolvers<void>()
    let boots = 0
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const overrides = {
          OPENCODE_SETTLEMENT_BOOTSTRAP_TIMEOUT_MS: "400",
          OPENCODE_INSTANCE_DISPOSE_TIMEOUT_MS: "40",
          OPENCODE_SETTLEMENT_MAX_INSTANCE_RELOADS_PER_HOUR: "2",
          OPENCODE_SETTLEMENT_CIRCUIT_COOLDOWN_MS: "5000",
        }
        const previous = Object.keys(overrides).map((key) => [key, process.env[key]] as const)
        Object.assign(process.env, overrides)
        return previous
      }),
      (previous) => Effect.sync(() => {
        previous.forEach(([key, value]) => {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        })
      }),
    )
    const bootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({
      run: Effect.suspend(() => {
        boots++
        if (boots === 2) return Effect.die("fresh failure")
        if (boots !== 1) return Effect.void
        return Effect.promise(() => release.promise).pipe(
          Effect.asVoid,
          Effect.onExit(() => Effect.sync(() => oldFinished.resolve())),
          Effect.uninterruptible,
        )
      }),
    }))
    yield* Effect.gen(function* () {
      const store = yield* InstanceStore.Service
      expect(unavailableReason(yield* store.load({ directory }).pipe(Effect.exit))).toContain("did not settle")
      // The retired generation settles successfully after its deadline already
      // recorded a failure. That stale success belongs to a disposed generation
      // and must not erase the failure history a newer boot relies on.
      release.resolve()
      yield* Effect.promise(() => oldFinished.promise)
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      const failed = yield* store.load({ directory }).pipe(Effect.exit)
      expect(Exit.isFailure(failed)).toBe(true)
      expect(unavailableReason(failed)).toContain("instance bootstrap failed")
      const circuit = yield* store.load({ directory }).pipe(Effect.exit)
      expect(Exit.isFailure(circuit)).toBe(true)
      expect(unavailableReason(circuit)).toContain("failed repeatedly")
      expect(boots).toBe(2)
    }).pipe(
      Effect.ensuring(Effect.sync(() => release.resolve())),
      Effect.provide(InstanceStore.defaultLayer.pipe(Layer.provide(bootstrap))),
    )
  }).pipe(Effect.provide(CrossSpawnSpawner.defaultLayer)),
)
