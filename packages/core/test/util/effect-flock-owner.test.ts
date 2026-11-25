import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Hash } from "@opencode-ai/core/util/hash"
import { testEffect } from "../lib/effect"
import { tmpdir } from "../fixture/tmpdir"

const it = testEffect(
  EffectFlock.layer.pipe(Layer.provide(Global.layerWith({ state: os.tmpdir() })), Layer.provide(FSUtil.defaultLayer)),
)

describe("EffectFlock stale owner protection", () => {
  it.live("reclaims stale metadata only after confirming that its local PID is absent", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.gen(function* () {
        const flock = yield* EffectFlock.Service
        const pid = 2_147_483_647
        const observed = yield* Effect.try({ try: () => process.kill(pid, 0), catch: (cause) => cause }).pipe(Effect.flip)
        // Refuse to exercise takeover if the fixture PID is not confirmed dead.
        expect(observed).toMatchObject({ code: "ESRCH" })
        const key = "dead-owner"
        const directory = path.join(tmp.path, Hash.fast(key) + ".lock")
        yield* Effect.promise(async () => {
          await fs.mkdir(directory)
          await fs.writeFile(path.join(directory, "meta.json"), JSON.stringify({
            token: "dead-owner",
            pid,
            hostname: os.hostname(),
            createdAt: new Date(0).toISOString(),
          }))
          const stale = new Date(Date.now() - 120_000)
          await fs.utimes(path.join(directory, "meta.json"), stale, stale)
          await fs.utimes(directory, stale, stale)
        })
        let entered = false
        yield* flock.withLock(Effect.sync(() => { entered = true }), key, tmp.path)
        expect(entered).toBe(true)
        expect(yield* Effect.promise(() => fs.readdir(tmp.path))).not.toContain(path.basename(directory))
      }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
  for (const owner of ["live", "foreign", "invalid-pid", "malformed"]) {
    it.live(`preserves a stale ${owner} owner's generation until it is removed`, () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          Effect.gen(function* () {
            const flock = yield* EffectFlock.Service
            const key = "stale-owner"
            const directory = path.join(tmp.path, Hash.fast(key) + ".lock")
            const metadata = path.join(directory, "meta.json")
            const original = owner === "malformed" ? "not-json" : JSON.stringify({
              token: "original-owner",
              pid: owner === "invalid-pid" ? 0 : process.pid,
              hostname: owner === "foreign" ? `${os.hostname()}-foreign` : os.hostname(),
              createdAt: new Date(0).toISOString(),
            })
            yield* Effect.promise(async () => {
              await fs.mkdir(directory)
              await fs.writeFile(metadata, original)
              await fs.writeFile(path.join(directory, "heartbeat"), "")
              const stale = new Date(Date.now() - 120_000)
              await fs.utimes(path.join(directory, "heartbeat"), stale, stale)
              await fs.utimes(metadata, stale, stale)
              await fs.utimes(directory, stale, stale)
            })
            let entered = false
            const observations = yield* Effect.all([
              flock.withLock(Effect.sync(() => { entered = true }), key, tmp.path),
              Effect.sleep(250).pipe(Effect.andThen(Effect.promise(async () => {
                const before = { entered, metadata: await fs.readFile(metadata, "utf8").catch(() => undefined) }
                // This is a simulated owner in an isolated fixture, not a live
                // application lock. Remove it so the waiting acquisition ends.
                await fs.rm(directory, { recursive: true, force: true })
                return before
              }))),
            ], { concurrency: "unbounded" })
            expect(observations[1]).toEqual({ entered: false, metadata: original })
            expect(entered).toBe(true)
          }),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    )
  }
})
