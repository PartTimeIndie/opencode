import { afterEach, expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Fiber, Layer } from "effect"
import { InstanceStore } from "../../src/project/instance-store"
import { registerDisposer } from "../../src/effect/instance-registry"
import { disposeAllInstances, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { it } from "../lib/effect"

const storeLayer = Layer.mergeAll(testInstanceStoreLayer, CrossSpawnSpawner.defaultLayer)

afterEach(async () => {
  await disposeAllInstances()
})

it.live("overlapping disposals run a directory's disposers once", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped({ config: { formatter: false, lsp: false } })
    const gate = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    const reasons: string[] = []
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        registerDisposer((directory, reason) => {
          if (directory !== dir) return Promise.resolve()
          reasons.push(reason)
          started.resolve()
          return gate.promise
        }),
      ),
      (off) => Effect.sync(off),
    ).pipe(Effect.asVoid)

    const store = yield* InstanceStore.Service
    yield* store.provide({ directory: dir }, Effect.void)

    const sweep = yield* store.disposeAllFresh().pipe(Effect.forkScoped({ startImmediately: true }))
    yield* Effect.promise(() => started.promise)
    // The directory dispose overlaps the gated global sweep; only the sweep's
    // in-flight disposal may run the disposers for this context. It must run
    // concurrently because the gated sweep cannot finish until the gate opens.
    const directoryDispose = yield* store.disposeDirectory(dir).pipe(Effect.forkScoped({ startImmediately: true }))
    yield* Effect.yieldNow
    yield* Effect.yieldNow
    gate.resolve()
    yield* Fiber.join(directoryDispose)
    yield* Fiber.join(sweep)

    expect(reasons).toHaveLength(1)
  }).pipe(Effect.provide(storeLayer)),
)

it.live("a fresh sweep includes instances reloaded during an earlier sweep", () =>
  Effect.gen(function* () {
    const dirA = yield* tmpdirScoped({ config: { formatter: false, lsp: false } })
    const dirB = yield* tmpdirScoped({ config: { formatter: false, lsp: false } })
    const gate = Promise.withResolvers<void>()
    const startedA = Promise.withResolvers<void>()
    const disposedBAgain = Promise.withResolvers<void>()
    let bRuns = 0
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        registerDisposer((directory) => {
          if (directory === dirA) {
            startedA.resolve()
            return gate.promise
          }
          if (directory === dirB && ++bRuns === 2) disposedBAgain.resolve()
          return Promise.resolve()
        }),
      ),
      (off) => Effect.sync(off),
    ).pipe(Effect.asVoid)

    const store = yield* InstanceStore.Service
    yield* store.provide({ directory: dirA }, Effect.void)
    yield* store.provide({ directory: dirB }, Effect.void)

    const first = yield* store.disposeAllFresh().pipe(Effect.forkScoped({ startImmediately: true }))
    yield* Effect.promise(() => startedA.promise)
    // B was disposed by the first sweep and loads again while that sweep is
    // still gated on A. The next sweep must include this newer instance instead
    // of joining the first sweep's snapshot.
    yield* store.provide({ directory: dirB }, Effect.void)
    const second = yield* store.disposeAllFresh().pipe(Effect.forkScoped({ startImmediately: true }))
    yield* Effect.promise(() => disposedBAgain.promise)

    expect(bRuns).toBe(2)
    gate.resolve()
    yield* Fiber.join(first)
    yield* Fiber.join(second)
  }).pipe(Effect.provide(storeLayer)),
)
