import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { testEffect } from "../lib/effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Global } from "@opencode-ai/core/global"
import { Hash } from "@opencode-ai/core/util/hash"

const testGlobal = Global.layerWith({
  home: os.homedir(),
  data: os.tmpdir(),
  cache: os.tmpdir(),
  config: os.tmpdir(),
  state: os.tmpdir(),
  bin: os.tmpdir(),
  log: os.tmpdir(),
})

const testLayer = EffectFlock.layer.pipe(Layer.provide(testGlobal), Layer.provide(FSUtil.defaultLayer))

function lock(dir: string, key: string) {
  return path.join(dir, Hash.fast(key) + ".lock")
}

// Pins the productive flock cancellation contract against the current
// production acquisition path (not a rootfix claim for the cold-start 503).
// beta74 acquireRelease runs acquire inside uninterruptibleMask, so an
// interrupt aimed at a contender parked in the retry backoff is deferred until
// the acquire settles. The test issues the interrupt in parallel and bounds
// delivery by the holder's controlled release; in production the worst-case
// bound is the flock TIMEOUT_MS window. Delivery must be a pure cancellation,
// the contender's own scoped finalizer must remove its lock dir, and the
// holder's release must leave the key reusable. Cancellation is documented,
// never masked away.
describe("util.effect-flock-cancellation", () => {
  const it = testEffect(testLayer)

  it.live(
    "contender cancellation defers on the uninterruptible acquire and releases via finalizer",
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-cancel-")))
      const dir = path.join(tmp, "locks")
      const lockDir = lock(dir, "eflock:cancel")
      const holderReady = Deferred.makeUnsafe<void>()
      const releaseGate = Deferred.makeUnsafe<void>()
      yield* Effect.gen(function* () {
        const holder = yield* Effect.forkScoped(
          flock.withLock(
            Effect.gen(function* () {
              yield* Deferred.done(holderReady, Exit.succeed(undefined)).pipe(Effect.asVoid)
              yield* Deferred.await(releaseGate)
            }),
            "eflock:cancel",
            dir,
          ),
        )
        yield* Deferred.await(holderReady)

        const contender = yield* Effect.forkScoped(flock.withLock(Effect.void, "eflock:cancel", dir))
        yield* Effect.sleep("150 millis")

        const started = Date.now()
        yield* Effect.forkDetach(Fiber.interrupt(contender))
        yield* Deferred.done(releaseGate, Exit.succeed(undefined)).pipe(Effect.asVoid)
        const exit = yield* Effect.exit(Fiber.join(contender))
        const deliveredMs = Date.now() - started

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(exit.cause.reasons.every((reason) => Cause.isInterruptReason(reason))).toBe(true)
        }
        expect(deliveredMs).toBeLessThan(5000)

        yield* Fiber.join(holder)
        expect(yield* Effect.promise(() => fs.stat(lockDir).then(() => false, () => true))).toBe(true)
        yield* flock.withLock(Effect.void, "eflock:cancel", dir)
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            Deferred.doneUnsafe(releaseGate, Effect.void)
            void fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
          }),
        ),
      )
    }),
  )
})
