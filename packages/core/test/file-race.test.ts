import { describe, expect, test } from "bun:test"
import { FileLockRecovery } from "@opencode-ai/core/file-lock-recovery"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Hash } from "@opencode-ai/core/util/hash"
import { testEffect } from "./lib/effect"

const global = Global.layerWith({
  home: os.homedir(),
  data: os.tmpdir(),
  cache: os.tmpdir(),
  config: os.tmpdir(),
  state: os.tmpdir(),
  bin: os.tmpdir(),
  log: os.tmpdir(),
})
const infrastructure = Layer.mergeAll(global, FSUtil.defaultLayer)
const layer = EffectFlock.layer.pipe(Layer.provide(infrastructure))
const it = testEffect(layer)

describe("native file locks", () => {
  test("separate processes serialize one target and a killed owner requires explicit recovery", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "file-process-race-"))
    const target = path.join(tmp, "target.txt")
    const key = `file-mutation:${target}`
    const worker = () =>
      Bun.spawn([process.execPath, path.join(import.meta.dir, "fixture", "file-lock-worker.ts"), tmp, key], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      })
    const first = worker()
    const children = [first]
    try {
      const firstOutput = first.stdout.getReader()
      expect(new TextDecoder().decode((await firstOutput.read()).value)).toContain("acquired")
      const second = worker()
      children.push(second)
      const secondOutput = second.stdout.getReader()
      let secondEntered = false
      const secondReady = secondOutput.read().then((result) => {
        secondEntered = true
        return result
      })
      await Bun.sleep(100)
      expect(secondEntered).toBe(false)
      first.stdin.end()
      expect(await first.exited).toBe(0)
      expect(new TextDecoder().decode((await secondReady).value)).toContain("acquired")
      // Kill only this disposable test worker, never the installed app.
      second.kill()
      await second.exited
      const observed = await FileLockRecovery.inspect({ lockRoot: tmp, target })
      expect(observed.pid).toBe(second.pid)
      await FileLockRecovery.recover({
        lockRoot: tmp,
        target,
        ownerToken: observed.token,
        ownerSha256: observed.ownerSha256,
      })
      expect(await fs.readdir(tmp)).toEqual([])
    } finally {
      for (const child of children) {
        child.kill()
        await child.exited
      }
      await fs.rm(tmp, { recursive: true, force: true })
    }
  }, 15000)

  it.effect("an abandoned old file lock times out without age-based takeover", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const flock = yield* EffectFlock.Service
        const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "file-orphan-")))
        const key = "file-mutation:abandoned"
        const lock = path.join(tmp, `${Hash.fast(key)}.lock`)
        yield* Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(lock)
            await fs.writeFile(path.join(lock, "owner-old.json"), "dead owner evidence")
            await fs.utimes(lock, new Date(0), new Date(0))
          })
          let settled = false
          const waiting = yield* Effect.forkScoped(
            flock.withLock(Effect.die("must not enter"), key, tmp).pipe(
              Effect.flip,
              Effect.tap(() =>
                Effect.sync(() => {
                  settled = true
                }),
              ),
            ),
          )
          // Filesystem promises use the real event loop, whereas retry waits use the
          // test clock. Advance both until the five-minute ceiling is observed.
          for (let attempt = 0; attempt < 20 && !settled; attempt++) {
            yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)))
            yield* TestClock.adjust("1 minute")
          }
          expect(settled).toBe(true)
          expect(yield* Fiber.join(waiting)).toMatchObject({ _tag: "LockTimeoutError", key })
          expect(yield* Effect.promise(() => fs.readFile(path.join(lock, "owner-old.json"), "utf8"))).toBe(
            "dead owner evidence",
          )
        }).pipe(Effect.ensuring(Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))))
      }),
    ),
  )

  it.live("strict file locks never destroy a foreign generation when releasing", () =>
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "file-race-")))
      const key = "file-mutation:fixture"
      const lock = path.join(tmp, `${Hash.fast(key)}.lock`)
      yield* Effect.gen(function* () {
        const failure = yield* Effect.exit(
          flock.withLock(
            Effect.gen(function* () {
              // A foreign marker must prevent complete release, not be recursively erased.
              yield* Effect.promise(() => fs.writeFile(path.join(lock, "foreign-generation"), "preserve"))
            }),
            key,
            tmp,
          ),
        )
        expect(failure._tag).toBe("Failure")
        expect(yield* Effect.promise(() => fs.readFile(path.join(lock, "foreign-generation"), "utf8"))).toBe("preserve")
      }).pipe(Effect.ensuring(Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))))
    }),
  )

  it.live("different targets remain independent and cancellation releases the owned file lock", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const flock = yield* EffectFlock.Service
        const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "file-independent-")))
        const ready = Deferred.makeUnsafe<void>()
        yield* Effect.gen(function* () {
          const holder = yield* Effect.forkScoped(
            flock.withLock(
              Effect.gen(function* () {
                yield* Deferred.succeed(ready, undefined)
                yield* Effect.never
              }),
              "file-mutation:a",
              tmp,
            ),
          )
          yield* Deferred.await(ready)
          expect(yield* flock.withLock(Effect.succeed("b"), "file-mutation:b", tmp)).toBe("b")
          yield* Fiber.interrupt(holder)
          expect(yield* flock.withLock(Effect.succeed("a"), "file-mutation:a", tmp)).toBe("a")
        }).pipe(Effect.ensuring(Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))))
      }),
    ),
  )
})
