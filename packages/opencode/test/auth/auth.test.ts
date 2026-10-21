import { describe, expect } from "bun:test"
import path from "path"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option } from "effect"
import * as TestConsole from "effect/testing/TestConsole"
import { Auth } from "../../src/auth"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Credential } from "@opencode-ai/core/credential"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Integration } from "@opencode-ai/core/integration"
import { Flock } from "@opencode-ai/core/util/flock"
import { TestInstance } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"

const node = CrossSpawnSpawner.defaultLayer

const it = testEffect(Layer.mergeAll(Auth.defaultLayer, node))

describe("Auth", () => {
  it.instance("set normalizes trailing slashes in keys", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com/", {
        type: "wellknown",
        key: "TOKEN",
        token: "abc",
      })
      const data = yield* auth.all()
      expect(data["https://example.com"]).toBeDefined()
      expect(data["https://example.com/"]).toBeUndefined()
    }),
  )

  it.instance("set cleans up pre-existing trailing-slash entry", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com/", {
        type: "wellknown",
        key: "TOKEN",
        token: "old",
      })
      yield* auth.set("https://example.com", {
        type: "wellknown",
        key: "TOKEN",
        token: "new",
      })
      const data = yield* auth.all()
      const keys = Object.keys(data).filter((key) => key.includes("example.com"))
      expect(keys).toEqual(["https://example.com"])
      const entry = data["https://example.com"]!
      expect(entry.type).toBe("wellknown")
      if (entry.type === "wellknown") expect(entry.token).toBe("new")
    }),
  )

  it.instance("remove deletes both trailing-slash and normalized keys", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com", {
        type: "wellknown",
        key: "TOKEN",
        token: "abc",
      })
      yield* auth.remove("https://example.com/")
      const data = yield* auth.all()
      expect(data["https://example.com"]).toBeUndefined()
      expect(data["https://example.com/"]).toBeUndefined()
    }),
  )

  it.instance("set and remove are no-ops on keys without trailing slashes", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("anthropic", {
        type: "api",
        key: "sk-test",
      })
      const data = yield* auth.all()
      expect(data["anthropic"]).toBeDefined()
      yield* auth.remove("anthropic")
      const after = yield* auth.all()
      expect(after["anthropic"]).toBeUndefined()
    }),
  )

  it.instance("does not hold the auth.json lock during a slow credential mirror", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const authFile = path.join(instance.directory, "auth-slow-mirror.json")
      yield* Effect.promise(() => Bun.write(authFile, "{}"))
      const mirrorStarted = yield* Deferred.make<void>()
      const releaseMirror = yield* Deferred.make<void>()
      yield* Effect.addFinalizer(() => Deferred.succeed(releaseMirror, undefined).pipe(Effect.asVoid))

      const credentials = Layer.mock(Credential.Service)({
        legacy: () => Effect.succeed([]),
        syncLegacy: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(mirrorStarted, undefined)
            yield* Deferred.await(releaseMirror)
            return true
          }),
        onChange: () => Effect.void,
      })
      const authLayer = Auth.layerFromPath(authFile).pipe(
        Layer.provide(FSUtil.defaultLayer),
        Layer.provide(credentials),
      )

      yield* Effect.gen(function* () {
        const auth = yield* Auth.Service
        const update = yield* auth.set("anthropic", { type: "api", key: "slow-mirror-key" }).pipe(Effect.forkChild)
        yield* Deferred.await(mirrorStarted)

        const data = yield* awaitWithTimeout(auth.all(), "auth read was blocked by credential mirroring")
        expect(data.anthropic).toEqual({ type: "api", key: "slow-mirror-key" })

        yield* Deferred.succeed(releaseMirror, undefined)
        yield* Fiber.join(update)
      }).pipe(Effect.provide(authLayer))
    }),
  )

  it.instance("coalesces concurrent auth reads without retaining a completed cache", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const authFile = path.join(instance.directory, "auth-single-flight.json")
      let reads = 0
      let counting = false
      const readStarted = yield* Deferred.make<void>()
      const releaseRead = yield* Deferred.make<void>()
      yield* Effect.addFinalizer(() => Deferred.succeed(releaseRead, undefined).pipe(Effect.asVoid))

      const actualFs = yield* Effect.gen(function* () {
        return yield* FSUtil.Service
      }).pipe(Effect.provide(FSUtil.defaultLayer))
      const fs = Layer.succeed(FSUtil.Service, {
        ...actualFs,
        readJson: () =>
          Effect.gen(function* () {
            reads++
            // Once counting starts, every read parks, so the test observes
            // exactly when reads happen. The layer build performs its own
            // snapshot, per-key revalidation, and cleanup reads uncounted.
            if (counting) {
              yield* Deferred.succeed(readStarted, undefined)
              yield* Deferred.await(releaseRead)
            }
            return { "remote.example": { type: "wellknown", key: "TOKEN", token: "value" } }
          }),
        writeJsonSafe: () => Effect.void,
      })
      const credentials = Layer.mock(Credential.Service)({
        legacy: () => Effect.succeed([]),
        onChange: () => Effect.void,
      })
      const authLayer = Auth.layerFromPath(authFile).pipe(Layer.provide(fs), Layer.provide(credentials))

      yield* Effect.gen(function* () {
        const auth = yield* Auth.Service
        counting = true
        reads = 0
        const readsInFlight = yield* Effect.all([auth.all(), auth.all()], { concurrency: 2 }).pipe(Effect.forkChild)
        yield* Deferred.await(readStarted)
        yield* Effect.yieldNow
        expect(reads).toBe(1)

        yield* Deferred.succeed(releaseRead, undefined)
        const data = yield* awaitWithTimeout(Fiber.join(readsInFlight), "concurrent auth reads did not finish")
        expect(data[0]["remote.example"]).toBeDefined()
        expect(data[1]["remote.example"]).toBeDefined()
        expect(reads).toBe(1)

        expect(yield* auth.all()).toEqual({
          "remote.example": { type: "wellknown", key: "TOKEN", token: "value" },
        })
        expect(reads).toBe(2)
      }).pipe(Effect.provide(authLayer))
    }),
  )

  it.instance("recovers an auth read after its first caller is interrupted", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const authFile = path.join(instance.directory, "auth-interrupted-read.json")
      const started = yield* Deferred.make<void>()
      let blockNext = false
      let reads = 0
      const actualFs = yield* Effect.gen(function* () {
        return yield* FSUtil.Service
      }).pipe(Effect.provide(FSUtil.defaultLayer))
      const fs = Layer.succeed(FSUtil.Service, {
        ...actualFs,
        readJson: () =>
          Effect.gen(function* () {
            reads++
            if (blockNext) {
              blockNext = false
              yield* Deferred.succeed(started, undefined)
              yield* Effect.never
            }
            return { "remote.example": { type: "wellknown", key: "TOKEN", token: "value" } }
          }),
        writeJsonSafe: () => Effect.void,
      })
      const credentials = Layer.mock(Credential.Service)({
        legacy: () => Effect.succeed([]),
        onChange: () => Effect.void,
      })
      const authLayer = Auth.layerFromPath(authFile).pipe(Layer.provide(fs), Layer.provide(credentials))

      yield* Effect.gen(function* () {
        const auth = yield* Auth.Service
        blockNext = true
        const first = yield* auth.all().pipe(Effect.forkChild)
        yield* Deferred.await(started)
        yield* Fiber.interrupt(first)

        const recovered = yield* awaitWithTimeout(auth.all(), "interrupted auth read poisoned later calls")
        expect(recovered["remote.example"]).toBeDefined()
        expect(reads).toBeGreaterThanOrEqual(2)
      }).pipe(Effect.provide(authLayer))
    }),
  )

  it.instance("reports auth file lock timeouts as typed AuthErrors", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const authFile = path.join(instance.directory, "auth-timeout.json")
      yield* Effect.promise(() => Bun.write(authFile, "{}"))
      const credentials = Layer.mock(Credential.Service)({
        legacy: () => Effect.succeed([]),
        onChange: () => Effect.void,
      })
      const authLayer = Auth.layerFromPath(authFile, { timeoutMs: 20 }).pipe(
        Layer.provide(FSUtil.defaultLayer),
        Layer.provide(credentials),
      )

      yield* Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* Effect.acquireRelease(
          Effect.promise(() => Flock.acquire(`auth-json:${path.resolve(authFile)}`)),
          (lease) => Effect.promise(() => lease.release()).pipe(Effect.ignore),
        )
        const exit = yield* Effect.exit(auth.all())
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasFails(exit.cause)).toBe(true)
          expect(Cause.hasDies(exit.cause)).toBe(false)
          const error = Cause.findErrorOption(exit.cause)
          expect(Option.isSome(error)).toBe(true)
          if (Option.isSome(error)) expect(error.value).toBeInstanceOf(Auth.AuthError)
        }
      }).pipe(Effect.provide(authLayer))
    }),
  )

  it.instance("bootstrap mirrors the current file state when a parallel set lands behind the per-key lock", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const authFile = path.join(instance.directory, "auth-bootstrap-race-set.json")
      const raceKey = "race-key"
      const sentinelKey = "race-sentinel"
      const integrationID = Integration.ID.make(raceKey)
      const sentinelID = Integration.ID.make(sentinelKey)
      yield* Effect.promise(() =>
        Bun.write(
          authFile,
          JSON.stringify({
            // First snapshot entry: parking its bootstrap mirror freezes the
            // stale snapshot while the bootstrap holds only the sentinel
            // per-key lock, keeping the auth.json file lock free for the
            // parallel writer.
            [sentinelKey]: { type: "api", key: "sentinel-value" },
            [raceKey]: { type: "api", key: "stale-key" },
          }),
        ),
      )
      const credentialLayer = Credential.layer.pipe(
        Layer.provide(
          Database.layerFromPath(path.join(instance.directory, "auth-bootstrap-race-set.sqlite")).pipe(Layer.fresh),
        ),
      )

      yield* Effect.gen(function* () {
        const credentials = yield* Credential.Service

        // Second layer instance: park its set() inside the credential mirror so
        // it keeps holding the per-key mutation lock while a newer auth.json
        // value is already published on disk.
        const setMirrorReached = yield* Deferred.make<void>()
        const releaseSetMirror = yield* Deferred.make<void>()
        yield* Effect.addFinalizer(() => Deferred.succeed(releaseSetMirror, undefined).pipe(Effect.asVoid))
        const authBLayer = Auth.layerFromPath(authFile).pipe(
          Layer.provide(FSUtil.defaultLayer),
          Layer.provide(
            Layer.succeed(Credential.Service, {
              ...credentials,
              syncLegacy: (input) =>
                input.mode === "set" && input.integrationID === integrationID
                  ? Effect.gen(function* () {
                      yield* Deferred.succeed(setMirrorReached, undefined)
                      yield* Deferred.await(releaseSetMirror)
                      return yield* credentials.syncLegacy(input)
                    })
                  : credentials.syncLegacy(input),
            }),
          ),
        )

        yield* Effect.gen(function* () {
          const authB = yield* Auth.Service
          expect((yield* credentials.list(integrationID))[0]?.value).toEqual(
            new Credential.Key({ type: "key", key: "stale-key" }),
          )

          // First layer instance: its bootstrap mirrors the sentinel first and
          // parks that mirror under the sentinel per-key lock. The file lock is
          // released by then, so the parked bootstrap holds the frozen stale
          // snapshot without blocking the parallel writer below.
          const sentinelReached = yield* Deferred.make<void>()
          const releaseSentinel = yield* Deferred.make<void>()
          yield* Effect.addFinalizer(() => Deferred.succeed(releaseSentinel, undefined).pipe(Effect.asVoid))
          const builtA = yield* Deferred.make<void>()
          const releaseA = yield* Deferred.make<void>()
          yield* Effect.addFinalizer(() => Deferred.succeed(releaseA, undefined).pipe(Effect.asVoid))
          const builder = yield* Effect.gen(function* () {
            yield* Auth.Service
            yield* Deferred.succeed(builtA, undefined)
            yield* Deferred.await(releaseA)
          }).pipe(
            Effect.provide(
              Auth.layerFromPath(authFile).pipe(
                Layer.provide(FSUtil.defaultLayer),
                Layer.provide(
                  Layer.succeed(Credential.Service, {
                    ...credentials,
                    syncLegacy: (input) =>
                      input.mode === "bootstrap" && input.integrationID === sentinelID
                        ? Effect.gen(function* () {
                            yield* Deferred.succeed(sentinelReached, undefined)
                            yield* Deferred.await(releaseSentinel)
                            return yield* credentials.syncLegacy(input)
                          })
                        : credentials.syncLegacy(input),
                  }),
                ),
              ),
            ),
            Effect.forkChild,
          )
          yield* awaitWithTimeout(
            Deferred.await(sentinelReached),
            "bootstrap snapshot was never frozen on the sentinel mirror",
            "5 seconds",
          )

          // The writer takes the per-key lock while the snapshot is frozen and
          // publishes the newer value to auth.json from behind the lock.
          const update = yield* authB.set(raceKey, { type: "api", key: "new-key" }).pipe(Effect.forkChild)
          yield* awaitWithTimeout(
            Deferred.await(setMirrorReached),
            "parallel set never reached its credential mirror",
            "5 seconds",
          )

          // Only now release the sentinel: the bootstrap processes its stale
          // race-key entry behind the writer's per-key lock and must mirror the
          // revalidated file state instead of the outdated snapshot.
          yield* Deferred.succeed(releaseSentinel, undefined)
          yield* Deferred.succeed(releaseSetMirror, undefined)
          yield* Fiber.join(update)

          yield* awaitWithTimeout(
            Deferred.await(builtA),
            "bootstrap did not finish behind the parallel set",
            "5 seconds",
          )
          // The outdated bootstrap snapshot must not downgrade the mirror that
          // the parallel writer already produced for the current file state.
          expect((yield* credentials.list(integrationID))[0]?.value).toEqual(
            new Credential.Key({ type: "key", key: "new-key" }),
          )
          expect(yield* Effect.promise(() => Bun.file(authFile).json())).toEqual({
            [sentinelKey]: { type: "api", key: "sentinel-value" },
            [raceKey]: { type: "api", key: "new-key" },
          })

          yield* Deferred.succeed(releaseA, undefined)
          yield* Fiber.join(builder)
        }).pipe(Effect.provide(authBLayer))
      }).pipe(Effect.provide(credentialLayer))
    }),
  )

  it.instance("bootstrap does not resurrect a key removed behind the per-key lock", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const authFile = path.join(instance.directory, "auth-bootstrap-race-remove.json")
      const raceKey = "race-key"
      const sentinelKey = "race-sentinel"
      const integrationID = Integration.ID.make(raceKey)
      const sentinelID = Integration.ID.make(sentinelKey)
      yield* Effect.promise(() =>
        Bun.write(
          authFile,
          JSON.stringify({
            // First snapshot entry: parking its bootstrap mirror freezes the
            // stale snapshot while the bootstrap holds only the sentinel
            // per-key lock, keeping the auth.json file lock free for the
            // parallel remove.
            [sentinelKey]: { type: "api", key: "sentinel-value" },
            [raceKey]: { type: "api", key: "stale-key" },
          }),
        ),
      )
      const credentialLayer = Credential.layer.pipe(
        Layer.provide(
          Database.layerFromPath(path.join(instance.directory, "auth-bootstrap-race-remove.sqlite")).pipe(Layer.fresh),
        ),
      )

      yield* Effect.gen(function* () {
        const credentials = yield* Credential.Service

        // Second layer instance: park its remove() inside the credential mirror
        // so the key is already gone from auth.json while the mirror still
        // holds the per-key mutation lock.
        const removeMirrorReached = yield* Deferred.make<void>()
        const releaseRemoveMirror = yield* Deferred.make<void>()
        yield* Effect.addFinalizer(() => Deferred.succeed(releaseRemoveMirror, undefined).pipe(Effect.asVoid))
        const authBLayer = Auth.layerFromPath(authFile).pipe(
          Layer.provide(FSUtil.defaultLayer),
          Layer.provide(
            Layer.succeed(Credential.Service, {
              ...credentials,
              syncLegacy: (input) =>
                input.mode === "remove" && input.integrationID === integrationID
                  ? Effect.gen(function* () {
                      yield* Deferred.succeed(removeMirrorReached, undefined)
                      yield* Deferred.await(releaseRemoveMirror)
                      return yield* credentials.syncLegacy(input)
                    })
                  : credentials.syncLegacy(input),
            }),
          ),
        )

        yield* Effect.gen(function* () {
          const authB = yield* Auth.Service
          expect((yield* credentials.list(integrationID))[0]?.value).toEqual(
            new Credential.Key({ type: "key", key: "stale-key" }),
          )

          // First layer instance: park the sentinel bootstrap mirror (first
          // snapshot entry, holding only the sentinel per-key lock) and record
          // any attempt to mirror the removed key from the outdated snapshot.
          const sentinelReached = yield* Deferred.make<void>()
          const releaseSentinel = yield* Deferred.make<void>()
          yield* Effect.addFinalizer(() => Deferred.succeed(releaseSentinel, undefined).pipe(Effect.asVoid))
          const staleMirrorAttempted = yield* Deferred.make<void>()
          const releaseStaleMirror = yield* Deferred.make<void>()
          yield* Effect.addFinalizer(() => Deferred.succeed(releaseStaleMirror, undefined).pipe(Effect.asVoid))
          let staleMirrorRan = false
          const builtA = yield* Deferred.make<void>()
          const releaseA = yield* Deferred.make<void>()
          yield* Effect.addFinalizer(() => Deferred.succeed(releaseA, undefined).pipe(Effect.asVoid))
          const builder = yield* Effect.gen(function* () {
            yield* Auth.Service
            yield* Deferred.succeed(builtA, undefined)
            yield* Deferred.await(releaseA)
          }).pipe(
            Effect.provide(
              Auth.layerFromPath(authFile).pipe(
                Layer.provide(FSUtil.defaultLayer),
                Layer.provide(
                  Layer.succeed(Credential.Service, {
                    ...credentials,
                    syncLegacy: (input) => {
                      if (input.mode === "bootstrap" && input.integrationID === sentinelID)
                        return Effect.gen(function* () {
                          yield* Deferred.succeed(sentinelReached, undefined)
                          yield* Deferred.await(releaseSentinel)
                          return yield* credentials.syncLegacy(input)
                        })
                      if (input.mode === "bootstrap" && input.integrationID === integrationID)
                        return Effect.gen(function* () {
                          staleMirrorRan = true
                          yield* Deferred.succeed(staleMirrorAttempted, undefined)
                          yield* Deferred.await(releaseStaleMirror)
                          return yield* credentials.syncLegacy(input)
                        })
                      return credentials.syncLegacy(input)
                    },
                  }),
                ),
              ),
            ),
            Effect.forkChild,
          )
          yield* awaitWithTimeout(
            Deferred.await(sentinelReached),
            "bootstrap snapshot was never frozen on the sentinel mirror",
            "5 seconds",
          )

          const update = yield* authB.remove(raceKey).pipe(Effect.forkChild)
          yield* awaitWithTimeout(
            Deferred.await(removeMirrorReached),
            "parallel remove never reached its credential mirror",
            "5 seconds",
          )

          // Only now release the sentinel: the bootstrap processes its stale
          // race-key entry behind the writer's per-key lock. Mirroring the stale
          // snapshot would park the bootstrap forever before it can finish; only
          // the revalidated file state lets it complete.
          yield* Deferred.succeed(releaseSentinel, undefined)
          yield* Deferred.succeed(releaseRemoveMirror, undefined)
          yield* Fiber.join(update)

          yield* awaitWithTimeout(Deferred.await(builtA), "bootstrap blocked behind the removed key", "5 seconds")
          expect(staleMirrorRan).toBe(false)
          expect(yield* Effect.promise(() => Bun.file(authFile).json())).toEqual({
            [sentinelKey]: { type: "api", key: "sentinel-value" },
          })
          expect(yield* credentials.list(integrationID)).toEqual([])

          yield* Deferred.succeed(releaseStaleMirror, undefined)
          yield* Deferred.succeed(releaseA, undefined)
          yield* Fiber.join(builder)
        }).pipe(Effect.provide(authBLayer))
      }).pipe(Effect.provide(credentialLayer))
    }),
  )

  it.instance("bootstrap aborts as skipped when the revalidation read fails transiently", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const authFile = path.join(instance.directory, "auth-revalidate-transient.json")
      const snapshot: Record<string, Auth.Info> = { "flaky-key": { type: "api", key: "snapshot-value" } }
      yield* Effect.promise(() => Bun.write(authFile, JSON.stringify(snapshot)))
      let reads = 0
      const actualFs = yield* Effect.gen(function* () {
        return yield* FSUtil.Service
      }).pipe(Effect.provide(FSUtil.defaultLayer))
      const fs = Layer.succeed(FSUtil.Service, {
        ...actualFs,
        readJson: () =>
          Effect.gen(function* () {
            reads++
            // First read: the bootstrap snapshot succeeds. The second read is
            // the per-key revalidation and hits a transient non-NotFound
            // failure. Later reads recover, so the service itself keeps
            // working.
            if (reads === 2)
              return yield* Effect.fail(
                new FSUtil.FileSystemError({ method: "readJson", cause: new Error("transient read failure") }),
              )
            return snapshot
          }),
        writeJsonSafe: () => Effect.void,
      })
      const mirrored: string[] = []
      const credentials = Layer.mock(Credential.Service)({
        legacy: () => Effect.succeed([]),
        syncLegacy: (input) => {
          mirrored.push(`${input.mode}:${input.integrationID}`)
          return Effect.succeed(true)
        },
        onChange: () => Effect.void,
      })
      const authLayer = Auth.layerFromPath(authFile).pipe(Layer.provide(fs), Layer.provide(credentials))

      yield* Effect.gen(function* () {
        // Reaching the service proves the layer build survived the aborted
        // bootstrap pass.
        const auth = yield* Auth.Service
        expect(mirrored).toEqual([])
        expect(yield* Effect.promise(() => Bun.file(authFile).json())).toEqual(snapshot)
        expect(yield* auth.all()).toEqual(snapshot)
        expect(yield* TestConsole.logLines).toContain("failed to read auth data")
        // Only the typed AuthError path logs this; a defect would have failed
        // the layer build instead.
        expect(yield* TestConsole.logLines).toContain("auth bootstrap skipped")
      }).pipe(Effect.provide(authLayer))
    }),
  )

  it.instance("bootstrap skips a key that an authoritative revalidation no longer finds", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const authFile = path.join(instance.directory, "auth-revalidate-removed.json")
      yield* Effect.promise(() =>
        Bun.write(authFile, JSON.stringify({ "removed-key": { type: "api", key: "snapshot-value" } })),
      )
      let reads = 0
      const actualFs = yield* Effect.gen(function* () {
        return yield* FSUtil.Service
      }).pipe(Effect.provide(FSUtil.defaultLayer))
      const fs = Layer.succeed(FSUtil.Service, {
        ...actualFs,
        readJson: () =>
          Effect.gen(function* () {
            reads++
            // The bootstrap snapshot still contains the key; every later read
            // is authoritative and shows it deleted, as a parallel remove from
            // another process would leave the file.
            return reads === 1 ? { "removed-key": { type: "api", key: "snapshot-value" } } : {}
          }),
        writeJsonSafe: () => Effect.void,
      })
      const mirrored: string[] = []
      const credentials = Layer.mock(Credential.Service)({
        legacy: () => Effect.succeed([]),
        syncLegacy: (input) => {
          mirrored.push(`${input.mode}:${input.integrationID}`)
          return Effect.succeed(true)
        },
        onChange: () => Effect.void,
      })
      const authLayer = Auth.layerFromPath(authFile).pipe(Layer.provide(fs), Layer.provide(credentials))

      yield* Effect.gen(function* () {
        const auth = yield* Auth.Service
        expect(mirrored).toEqual([])
        expect(yield* auth.all()).toEqual({})
        expect(yield* TestConsole.logLines).not.toContain("auth bootstrap skipped")
      }).pipe(Effect.provide(authLayer))
    }),
  )

  it.instance("bootstrap keeps mirroring known keys in a mixed auth.json with unknown-format entries", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const authFile = path.join(instance.directory, "auth-revalidate-mixed.json")
      const mixed = {
        "known-key": { type: "api", key: "known-value" },
        "future-provider": { type: "future-auth-format", token: "opaque" },
      }
      yield* Effect.promise(() => Bun.write(authFile, JSON.stringify(mixed)))
      const mirrored: string[] = []
      const credentials = Layer.mock(Credential.Service)({
        legacy: () => Effect.succeed([]),
        syncLegacy: (input) => {
          mirrored.push(`${input.mode}:${input.integrationID}`)
          return Effect.succeed(true)
        },
        onChange: () => Effect.void,
      })
      const authLayer = Auth.layerFromPath(authFile).pipe(
        Layer.provide(FSUtil.defaultLayer),
        Layer.provide(credentials),
      )

      yield* Effect.gen(function* () {
        const auth = yield* Auth.Service
        // The unknown-format entry only degrades `authoritative`, not the read
        // itself: the known key stays mirrorable and no skip warning appears.
        expect(mirrored).toEqual(["bootstrap:known-key"])
        expect(yield* auth.all()).toEqual({ "known-key": { type: "api", key: "known-value" } })
        expect(yield* TestConsole.logLines).not.toContain("auth bootstrap skipped")
      }).pipe(Effect.provide(authLayer))
    }),
  )

  it.instance("set aborts without write or mirror when the auth read fails transiently", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const authFile = path.join(instance.directory, "auth-update-set.json")
      const snapshot: Record<string, Auth.Info> = { "keep-key": { type: "api", key: "existing" } }
      yield* Effect.promise(() => Bun.write(authFile, JSON.stringify(snapshot)))
      let failReads = false
      const writes: string[] = []
      const actualFs = yield* Effect.gen(function* () {
        return yield* FSUtil.Service
      }).pipe(Effect.provide(FSUtil.defaultLayer))
      const fs = Layer.succeed(FSUtil.Service, {
        ...actualFs,
        readJson: () =>
          Effect.gen(function* () {
            // A transient failure during the update's re-read must not publish
            // a rewrite built from the empty degraded view.
            if (failReads)
              return yield* Effect.fail(
                new FSUtil.FileSystemError({ method: "readJson", cause: new Error("transient read failure") }),
              )
            return snapshot
          }),
        writeJsonSafe: (writePath) =>
          Effect.sync(() => {
            writes.push(writePath)
          }),
      })
      const mirrored: string[] = []
      const credentials = Layer.mock(Credential.Service)({
        legacy: () => Effect.succeed([]),
        syncLegacy: (input) => {
          mirrored.push(`${input.mode}:${input.integrationID}`)
          return Effect.succeed(true)
        },
        onChange: () => Effect.void,
      })
      const authLayer = Auth.layerFromPath(authFile).pipe(Layer.provide(fs), Layer.provide(credentials))

      yield* Effect.gen(function* () {
        const auth = yield* Auth.Service
        failReads = true
        const exit = yield* Effect.exit(auth.set("fresh-key", { type: "api", key: "fresh" }))
        failReads = false
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasDies(exit.cause)).toBe(false)
          const error = Cause.findErrorOption(exit.cause)
          expect(Option.isSome(error)).toBe(true)
          if (Option.isSome(error)) expect(error.value).toBeInstanceOf(Auth.AuthError)
        }
        expect(writes).toEqual([])
        // The bootstrap itself mirrored the pre-existing snapshot key; only
        // the aborted set() must have produced no mirror of its own.
        expect(mirrored.filter((entry) => !entry.startsWith("bootstrap:"))).toEqual([])
        expect(yield* Effect.promise(() => Bun.file(authFile).json())).toEqual(snapshot)
        expect(yield* auth.all()).toEqual(snapshot)
      }).pipe(Effect.provide(authLayer))
    }),
  )

  it.instance("remove aborts without write or mirror when the auth read fails transiently", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const authFile = path.join(instance.directory, "auth-update-remove.json")
      const snapshot: Record<string, Auth.Info> = { "keep-key": { type: "api", key: "existing" } }
      yield* Effect.promise(() => Bun.write(authFile, JSON.stringify(snapshot)))
      let failReads = false
      const writes: string[] = []
      const actualFs = yield* Effect.gen(function* () {
        return yield* FSUtil.Service
      }).pipe(Effect.provide(FSUtil.defaultLayer))
      const fs = Layer.succeed(FSUtil.Service, {
        ...actualFs,
        readJson: () =>
          Effect.gen(function* () {
            if (failReads)
              return yield* Effect.fail(
                new FSUtil.FileSystemError({ method: "readJson", cause: new Error("transient read failure") }),
              )
            return snapshot
          }),
        writeJsonSafe: (writePath) =>
          Effect.sync(() => {
            writes.push(writePath)
          }),
      })
      const mirrored: string[] = []
      const credentials = Layer.mock(Credential.Service)({
        legacy: () => Effect.succeed([]),
        syncLegacy: (input) => {
          mirrored.push(`${input.mode}:${input.integrationID}`)
          return Effect.succeed(true)
        },
        onChange: () => Effect.void,
      })
      const authLayer = Auth.layerFromPath(authFile).pipe(Layer.provide(fs), Layer.provide(credentials))

      yield* Effect.gen(function* () {
        const auth = yield* Auth.Service
        failReads = true
        const exit = yield* Effect.exit(auth.remove("keep-key"))
        failReads = false
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasDies(exit.cause)).toBe(false)
          const error = Cause.findErrorOption(exit.cause)
          expect(Option.isSome(error)).toBe(true)
          if (Option.isSome(error)) expect(error.value).toBeInstanceOf(Auth.AuthError)
        }
        expect(writes).toEqual([])
        // The bootstrap itself mirrored the pre-existing snapshot key; only
        // the aborted remove() must have produced no mirror of its own.
        expect(mirrored.filter((entry) => !entry.startsWith("bootstrap:"))).toEqual([])
        expect(yield* Effect.promise(() => Bun.file(authFile).json())).toEqual(snapshot)
        expect(yield* auth.all()).toEqual(snapshot)
      }).pipe(Effect.provide(authLayer))
    }),
  )

  it.instance("onChange mirror skips the auth.json write when the auth read fails transiently", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const authFile = path.join(instance.directory, "auth-update-onchange.json")
      const snapshot: Record<string, Auth.Info> = {
        openai: { type: "oauth", access: "stale-access", refresh: "stale-refresh", expires: 60_000 },
      }
      yield* Effect.promise(() => Bun.write(authFile, JSON.stringify(snapshot)))
      let failReads = false
      const writes: string[] = []
      const actualFs = yield* Effect.gen(function* () {
        return yield* FSUtil.Service
      }).pipe(Effect.provide(FSUtil.defaultLayer))
      const fs = Layer.succeed(FSUtil.Service, {
        ...actualFs,
        readJson: () =>
          Effect.gen(function* () {
            if (failReads)
              return yield* Effect.fail(
                new FSUtil.FileSystemError({ method: "readJson", cause: new Error("transient read failure") }),
              )
            return snapshot
          }),
        writeJsonSafe: (writePath) =>
          Effect.sync(() => {
            writes.push(writePath)
          }),
      })
      const mirrored: string[] = []
      let changeHandler: ((change: Credential.CredentialChange) => Effect.Effect<void>) | undefined
      const credentials = Layer.mock(Credential.Service)({
        legacy: () => Effect.succeed([]),
        // The bootstrap probes its OAuth newer-check through list(); an empty
        // result sends it through the ordinary bootstrap mirror instead.
        list: () => Effect.succeed([]),
        syncLegacy: (input) => {
          mirrored.push(`${input.mode}:${input.integrationID}`)
          return Effect.succeed(true)
        },
        onChange: (listener) =>
          Effect.sync(() => {
            changeHandler = listener
          }),
      })
      const authLayer = Auth.layerFromPath(authFile).pipe(Layer.provide(fs), Layer.provide(credentials))

      yield* Effect.gen(function* () {
        const auth = yield* Auth.Service
        const handler = changeHandler
        expect(handler).toBeDefined()
        if (handler) {
          failReads = true
          yield* handler({
            before: undefined,
            after: new Credential.Stored({
              id: Credential.ID.make("stored-1"),
              integrationID: Integration.ID.make("openai"),
              label: "default",
              connectorID: "default",
              value: new Credential.OAuth({
                type: "oauth",
                methodID: Integration.MethodID.make("chatgpt-browser"),
                access: "native-access",
                refresh: "native-refresh",
                expires: 60_000,
              }),
            }),
          })
          failReads = false
        }
        expect(writes).toEqual([])
        expect(mirrored.filter((entry) => !entry.startsWith("bootstrap:"))).toEqual([])
        expect(yield* Effect.promise(() => Bun.file(authFile).json())).toEqual(snapshot)
        expect(yield* TestConsole.logLines).toContain("failed to mirror credential update")
        expect(yield* auth.all()).toEqual(snapshot)
      }).pipe(Effect.provide(authLayer))
    }),
  )

  it.instance("onChange resolves auth.json aliases so native updates neither downgrade nor duplicate", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const authFile = path.join(instance.directory, "auth-onchange-alias.json")
      yield* Effect.promise(() =>
        Bun.write(
          authFile,
          JSON.stringify({
            "openai/": {
              type: "oauth",
              access: "alias-access",
              refresh: "alias-refresh",
              expires: 100,
              opaqueMetadata: "keep-me",
            },
          }),
        ),
      )
      const mirrored: string[] = []
      let changeHandler: ((change: Credential.CredentialChange) => Effect.Effect<void>) | undefined
      const credentials = Layer.mock(Credential.Service)({
        legacy: () => Effect.succeed([]),
        list: () => Effect.succeed([]),
        syncLegacy: (input) => {
          mirrored.push(`${input.mode}:${input.integrationID}`)
          return Effect.succeed(true)
        },
        onChange: (listener) =>
          Effect.sync(() => {
            changeHandler = listener
          }),
      })
      const authLayer = Auth.layerFromPath(authFile).pipe(
        Layer.provide(FSUtil.defaultLayer),
        Layer.provide(credentials),
      )

      yield* Effect.gen(function* () {
        yield* Auth.Service
        const handler = changeHandler
        expect(handler).toBeDefined()
        if (handler) {
          // Older native update: the guard must see the newer alias-only entry
          // through its alias, so nothing downgrades and no canonical
          // duplicate appears.
          yield* handler({
            before: undefined,
            after: new Credential.Stored({
              id: Credential.ID.make("stored-native-older"),
              integrationID: Integration.ID.make("openai"),
              label: "default",
              connectorID: "default",
              value: new Credential.OAuth({
                type: "oauth",
                methodID: Integration.MethodID.make("chatgpt-browser"),
                access: "older-native-access",
                refresh: "older-native-refresh",
                expires: 50,
              }),
            }),
          })
          expect(yield* Effect.promise(() => Bun.file(authFile).json())).toEqual({
            "openai/": {
              type: "oauth",
              access: "alias-access",
              refresh: "alias-refresh",
              expires: 100,
              opaqueMetadata: "keep-me",
            },
          })
          expect(mirrored.filter((entry) => !entry.startsWith("bootstrap:"))).toEqual([])

          // Newer native update: exactly the canonical key is written, merged
          // from the matching alias raw value with metadata preserved, and the
          // alias is removed like set() does.
          yield* handler({
            before: undefined,
            after: new Credential.Stored({
              id: Credential.ID.make("stored-native-newer"),
              integrationID: Integration.ID.make("openai"),
              label: "default",
              connectorID: "default",
              value: new Credential.OAuth({
                type: "oauth",
                methodID: Integration.MethodID.make("chatgpt-browser"),
                access: "newer-native-access",
                refresh: "newer-native-refresh",
                expires: 200,
              }),
            }),
          })
          expect(yield* Effect.promise(() => Bun.file(authFile).json())).toEqual({
            openai: {
              type: "oauth",
              access: "newer-native-access",
              refresh: "newer-native-refresh",
              expires: 200,
              opaqueMetadata: "keep-me",
            },
          })
          expect(mirrored.filter((entry) => !entry.startsWith("bootstrap:"))).toEqual([])
        }
      }).pipe(Effect.provide(authLayer))
    }),
  )

  it.instance("logs invalid OPENCODE_AUTH_CONTENT before falling back", () =>
    Effect.gen(function* () {
      const previous = process.env.OPENCODE_AUTH_CONTENT
      process.env.OPENCODE_AUTH_CONTENT = "{invalid-json"
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.OPENCODE_AUTH_CONTENT
          else process.env.OPENCODE_AUTH_CONTENT = previous
        }),
      )

      const auth = yield* Auth.Service
      yield* auth.all()

      expect(yield* TestConsole.logLines).toContain("invalid OPENCODE_AUTH_CONTENT")
    }),
  )

  it.instance("normalizes raw aliases and cleans only durable legacy mirrors", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const authFile = path.join(instance.directory, "auth-provenance.json")
      yield* Effect.promise(() =>
        Bun.write(
          authFile,
          JSON.stringify({
            openai: {
              type: "oauth",
              access: "canonical-access",
              refresh: "canonical-refresh",
              expires: 60_000,
            },
            "openai/": {
              type: "oauth",
              access: "stale-alias-access",
              refresh: "stale-alias-refresh",
              expires: 1,
            },
          }),
        ),
      )
      const credentialLayer = Credential.layer.pipe(
        Layer.provide(
          Database.layerFromPath(path.join(instance.directory, "auth-provenance.sqlite")).pipe(Layer.fresh),
        ),
      )
      const bridgeLayer = Auth.layerFromPath(authFile).pipe(
        Layer.provide(FSUtil.defaultLayer),
        Layer.provideMerge(credentialLayer),
      )

      yield* Effect.gen(function* () {
        const auth = yield* Auth.Service
        const credentials = yield* Credential.Service
        const openai = Integration.ID.make("openai")
        const data = yield* auth.all()
        expect(Object.keys(data)).toEqual(["openai"])
        expect(data.openai).toMatchObject({ type: "oauth", access: "canonical-access" })
        expect(yield* auth.get("openai/")).toMatchObject({ type: "oauth", access: "canonical-access" })
        expect((yield* credentials.list(openai))[0]?.value).toMatchObject({
          type: "oauth",
          access: "canonical-access",
        })

        const credentialService = Layer.succeed(Credential.Service, credentials)
        yield* Effect.gen(function* () {
          const restartedAuth = yield* Auth.Service
          expect(Object.keys(yield* restartedAuth.all())).toEqual(["openai"])
          expect((yield* credentials.list(openai))[0]?.value).toMatchObject({
            type: "oauth",
            access: "canonical-access",
          })
        }).pipe(
          Effect.provide(
            Auth.layerFromPath(authFile).pipe(Layer.provide(FSUtil.defaultLayer), Layer.provide(credentialService)),
          ),
        )

        const imported = (yield* credentials.list(openai))[0]!
        yield* credentials.update(imported.id, { label: "Renamed imported credential" })
        yield* Effect.promise(() => Bun.write(authFile, "{}"))
        yield* Effect.gen(function* () {
          yield* Auth.Service
        }).pipe(
          Effect.provide(
            Auth.layerFromPath(authFile).pipe(Layer.provide(FSUtil.defaultLayer), Layer.provide(credentialService)),
          ),
        )
        expect(yield* credentials.list(openai)).toEqual([])

        const native = yield* credentials.create({
          integrationID: openai,
          label: Credential.LegacyLabel,
          value: new Credential.Key({ type: "key", key: "native-key" }),
        })
        yield* Effect.promise(() =>
          Bun.write(authFile, JSON.stringify({ "openai/": { type: "api", key: "legacy-key" } })),
        )
        yield* Effect.gen(function* () {
          const restartedAuth = yield* Auth.Service
          expect(yield* credentials.list(openai)).toEqual([native])
          yield* restartedAuth.remove("openai")
          expect(yield* credentials.list(openai)).toEqual([native])
          expect(yield* Effect.promise(() => Bun.file(authFile).json())).toEqual({})
        }).pipe(
          Effect.provide(
            Auth.layerFromPath(authFile).pipe(Layer.provide(FSUtil.defaultLayer), Layer.provide(credentialService)),
          ),
        )

        const url = Integration.ID.make("https://example.com")
        yield* Effect.promise(() =>
          Bun.write(authFile, JSON.stringify({ "https://example.com/": { type: "api", key: "alias-key" } })),
        )
        yield* Effect.gen(function* () {
          const restartedAuth = yield* Auth.Service
          expect((yield* credentials.list(url))[0]?.value).toEqual(
            new Credential.Key({ type: "key", key: "alias-key" }),
          )
          yield* restartedAuth.remove("https://example.com")
          expect(yield* credentials.list(url)).toEqual([])
          expect(yield* Effect.promise(() => Bun.file(authFile).json())).toEqual({})

          yield* restartedAuth.set("https://example.com", { type: "api", key: "canonical-key" })
          yield* restartedAuth.remove("https://example.com/")
          expect(yield* credentials.list(url)).toEqual([])
          expect(yield* Effect.promise(() => Bun.file(authFile).json())).toEqual({})
        }).pipe(
          Effect.provide(
            Auth.layerFromPath(authFile).pipe(Layer.provide(FSUtil.defaultLayer), Layer.provide(credentialService)),
          ),
        )
      }).pipe(Effect.provide(bridgeLayer))
    }),
  )

  it.instance("mirrors cursor oauth from auth.json", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const authFile = path.join(instance.directory, "auth-cursor.json")
      yield* Effect.promise(() =>
        Bun.write(
          authFile,
          JSON.stringify({
            cursor: {
              type: "oauth",
              access: "cursor-access",
              refresh: "cursor-refresh",
              expires: 1,
            },
            "other-oauth": {
              type: "oauth",
              access: "other-access",
              refresh: "other-refresh",
              expires: 1,
            },
          }),
        ),
      )
      const credentialLayer = Credential.layer.pipe(
        Layer.provide(Database.layerFromPath(path.join(instance.directory, "auth-cursor.sqlite")).pipe(Layer.fresh)),
      )
      const bridgeLayer = Auth.layerFromPath(authFile).pipe(
        Layer.provide(FSUtil.defaultLayer),
        Layer.provideMerge(credentialLayer),
      )

      yield* Effect.gen(function* () {
        const credentials = yield* Credential.Service
        expect((yield* credentials.list(Integration.ID.make("cursor")))[0]).toMatchObject({
          label: Credential.LegacyLabel,
          value: {
            type: "oauth",
            methodID: "cursor-oauth",
            access: "cursor-access",
            refresh: "cursor-refresh",
          },
        })
        expect(yield* credentials.list(Integration.ID.make("other-oauth"))).toEqual([])
      }).pipe(Effect.provide(bridgeLayer))
    }),
  )

  it.instance("reconciles refreshed legacy mirrors from auth.json while preserving the future V2 mirror", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const authFile = path.join(instance.directory, "auth-bridge.json")
      yield* Effect.promise(() =>
        Bun.write(
          authFile,
          JSON.stringify({
            openai: {
              type: "oauth",
              access: "legacy-access",
              refresh: "legacy-refresh",
              expires: 1,
              accountId: "account-1",
            },
            "other-oauth": {
              type: "oauth",
              access: "other-access",
              refresh: "other-refresh",
              expires: 1,
            },
          }),
        ),
      )
      const credentialLayer = Credential.layer.pipe(
        Layer.provide(Database.layerFromPath(path.join(instance.directory, "auth-bridge.sqlite")).pipe(Layer.fresh)),
      )
      const bridgeLayer = Auth.layerFromPath(authFile).pipe(
        Layer.provide(FSUtil.defaultLayer),
        Layer.provideMerge(credentialLayer),
      )

      yield* Effect.gen(function* () {
        const auth = yield* Auth.Service
        const credentials = yield* Credential.Service
        const openai = Integration.ID.make("openai")
        expect((yield* credentials.list(openai))[0]).toMatchObject({
          label: Credential.LegacyLabel,
          value: {
            type: "oauth",
            methodID: "chatgpt-browser",
            access: "legacy-access",
            metadata: { accountID: "account-1" },
          },
        })
        expect(yield* credentials.list(Integration.ID.make("other-oauth"))).toEqual([])

        const imported = (yield* credentials.list(openai))[0]!
        const refreshed = new Credential.OAuth({
          type: "oauth",
          methodID: Integration.MethodID.make("chatgpt-browser"),
          access: "refreshed-access",
          refresh: "refreshed-refresh",
          expires: 60_000,
          metadata: { accountID: "account-refreshed" },
        })
        yield* credentials.update(imported.id, { value: refreshed })
        expect((yield* Effect.promise(() => Bun.file(authFile).json())).openai).toMatchObject({
          type: "oauth",
          access: "refreshed-access",
          refresh: "refreshed-refresh",
          expires: 60_000,
          accountId: "account-refreshed",
        })
        const future = Integration.ID.make("future-provider")
        yield* credentials.syncLegacy({
          mode: "bootstrap",
          integrationID: future,
          value: new Credential.Key({ type: "key", key: "future-key" }),
        })
        yield* Effect.promise(() =>
          Bun.write(
            authFile,
            JSON.stringify({
              openai: {
                type: "oauth",
                access: "stale-access",
                refresh: "stale-refresh",
                expires: 1,
              },
              "future-provider": { type: "future-auth-format", token: "opaque" },
            }),
          ),
        )
        const credentialService = Layer.succeed(Credential.Service, credentials)
        const restarted = Auth.layerFromPath(authFile).pipe(
          Layer.provide(FSUtil.defaultLayer),
          Layer.provide(credentialService),
        )
        yield* Effect.gen(function* () {
          const restartedAuth = yield* Auth.Service
          // A refreshed legacy OAuth credential is mirrored back to auth.json, so
          // restart reconciliation keeps the newer DB value instead of downgrading it.
          expect((yield* credentials.list(openai))[0]?.value).toMatchObject({
            type: "oauth",
            methodID: "chatgpt-browser",
            refresh: "refreshed-refresh",
            access: "refreshed-access",
            expires: 60_000,
          })
          expect((yield* Effect.promise(() => Bun.file(authFile).json()))["future-provider"]).toEqual({
            type: "future-auth-format",
            token: "opaque",
          })
          expect((yield* credentials.list(future))[0]?.value).toEqual(
            new Credential.Key({ type: "key", key: "future-key" }),
          )
          yield* restartedAuth.set("openai", { type: "api", key: "explicit-set" })
          expect((yield* credentials.list(openai))[0]?.value).toEqual(
            new Credential.Key({ type: "key", key: "explicit-set" }),
          )
        }).pipe(Effect.provide(restarted))

        const io = Integration.ID.make("io-provider")
        yield* credentials.syncLegacy({
          mode: "bootstrap",
          integrationID: io,
          value: new Credential.Key({ type: "key", key: "io-key" }),
        })
        yield* Effect.gen(function* () {
          yield* Auth.Service
        }).pipe(
          Effect.provide(
            Auth.layerFromPath(instance.directory).pipe(
              Layer.provide(FSUtil.defaultLayer),
              Layer.provide(credentialService),
            ),
          ),
        )
        expect((yield* credentials.list(io))[0]?.value).toEqual(new Credential.Key({ type: "key", key: "io-key" }))

        yield* auth.set("anthropic", { type: "api", key: "legacy-key" })
        expect((yield* credentials.list(Integration.ID.make("anthropic")))[0]).toMatchObject({
          label: Credential.LegacyLabel,
          value: { type: "key", key: "legacy-key" },
        })
        yield* auth.remove("anthropic")
        expect(yield* credentials.list(Integration.ID.make("anthropic"))).toEqual([])

        const current = yield* credentials.create({
          integrationID: openai,
          label: "V2 connection",
          value: new Credential.Key({ type: "key", key: "v2-key" }),
        })
        yield* auth.set("openai", { type: "api", key: "stale-legacy-key" })
        expect(yield* credentials.list(openai)).toEqual([current])
        yield* auth.remove("openai")
        expect(yield* credentials.list(openai)).toEqual([current])
      }).pipe(Effect.provide(bridgeLayer))
    }),
  )

  it.instance("bootstrap reconciles a stale legacy OAuth mirror from a newer auth.json", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const authFile = path.join(instance.directory, "auth-reconcile.json")
      yield* Effect.promise(() =>
        Bun.write(
          authFile,
          JSON.stringify({
            openai: { type: "oauth", access: "stale-access", refresh: "stale-refresh", expires: 1 },
          }),
        ),
      )
      const credentialLayer = Credential.layer.pipe(
        Layer.provide(Database.layerFromPath(path.join(instance.directory, "auth-reconcile.sqlite")).pipe(Layer.fresh)),
      )
      const bridgeLayer = Auth.layerFromPath(authFile).pipe(
        Layer.provide(FSUtil.defaultLayer),
        Layer.provideMerge(credentialLayer),
      )
      yield* Effect.gen(function* () {
        const credentials = yield* Credential.Service
        const openai = Integration.ID.make("openai")
        yield* Effect.forEach(yield* credentials.list(openai), (item) => credentials.remove(item.id), { discard: true })
        yield* credentials.syncLegacy({
          mode: "bootstrap",
          integrationID: openai,
          value: new Credential.OAuth({
            type: "oauth",
            methodID: Integration.MethodID.make("chatgpt-browser"),
            access: "stale-access",
            refresh: "stale-refresh",
            expires: 1,
          }),
        })
        expect((yield* credentials.list(openai))[0]?.value).toMatchObject({
          type: "oauth",
          access: "stale-access",
          refresh: "stale-refresh",
        })
        // auth.json is authoritative: a newer future-expiring token must replace
        // the stale DB mirror instead of being skipped.
        yield* Effect.promise(() =>
          Bun.write(
            authFile,
            JSON.stringify({
              openai: { type: "oauth", access: "future-access", refresh: "future-refresh", expires: 60_000 },
            }),
          ),
        )
        const restarted = Auth.layerFromPath(authFile).pipe(
          Layer.provide(FSUtil.defaultLayer),
          Layer.provide(Layer.succeed(Credential.Service, credentials)),
        )
        yield* Effect.gen(function* () {
          yield* Auth.Service
          expect((yield* credentials.list(openai))[0]?.value).toMatchObject({
            type: "oauth",
            methodID: "chatgpt-browser",
            access: "future-access",
            refresh: "future-refresh",
            expires: 60_000,
          })
        }).pipe(Effect.provide(restarted))
      }).pipe(Effect.provide(bridgeLayer))
    }),
  )

  it.instance("bootstrap stays idempotent for unchanged legacy values", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const authFile = path.join(instance.directory, "auth-idempotent.json")
      yield* Effect.promise(() =>
        Bun.write(
          authFile,
          JSON.stringify({
            openai: { type: "oauth", access: "same-access", refresh: "same-refresh", expires: 123 },
          }),
        ),
      )
      const credentialLayer = Credential.layer.pipe(
        Layer.provide(
          Database.layerFromPath(path.join(instance.directory, "auth-idempotent.sqlite")).pipe(Layer.fresh),
        ),
      )
      const bridgeLayer = Auth.layerFromPath(authFile).pipe(
        Layer.provide(FSUtil.defaultLayer),
        Layer.provideMerge(credentialLayer),
      )
      yield* Effect.gen(function* () {
        const credentials = yield* Credential.Service
        const openai = Integration.ID.make("openai")
        const original = (yield* credentials.list(openai))[0]!
        // Restart with the identical auth.json: reconciliation is a no-op for
        // unchanged values and must not error or rewrite the stored value.
        const restarted = Auth.layerFromPath(authFile).pipe(
          Layer.provide(FSUtil.defaultLayer),
          Layer.provide(Layer.succeed(Credential.Service, credentials)),
        )
        yield* Effect.gen(function* () {
          yield* Auth.Service
          expect((yield* credentials.list(openai))[0]?.value).toEqual(original.value)
        }).pipe(Effect.provide(restarted))
      }).pipe(Effect.provide(bridgeLayer))
    }),
  )

  it.instance("bootstrap preserves native V2 credentials", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const authFile = path.join(instance.directory, "auth-native.json")
      yield* Effect.promise(() =>
        Bun.write(
          authFile,
          JSON.stringify({
            openai: { type: "oauth", access: "stale-access", refresh: "stale-refresh", expires: 1 },
          }),
        ),
      )
      const credentialLayer = Credential.layer.pipe(
        Layer.provide(Database.layerFromPath(path.join(instance.directory, "auth-native.sqlite")).pipe(Layer.fresh)),
      )
      const bridgeLayer = Auth.layerFromPath(authFile).pipe(
        Layer.provide(FSUtil.defaultLayer),
        Layer.provideMerge(credentialLayer),
      )
      yield* Effect.gen(function* () {
        const credentials = yield* Credential.Service
        const openai = Integration.ID.make("openai")
        const current = yield* credentials.create({
          integrationID: openai,
          label: "V2 connection",
          value: new Credential.Key({ type: "key", key: "v2-native-key" }),
        })
        // Rewrite auth.json with a newer value; bootstrap must never clobber a
        // native (non-legacy) V2 credential.
        yield* Effect.promise(() =>
          Bun.write(
            authFile,
            JSON.stringify({
              openai: { type: "oauth", access: "newer-access", refresh: "newer-refresh", expires: 60_000 },
            }),
          ),
        )
        const restarted = Auth.layerFromPath(authFile).pipe(
          Layer.provide(FSUtil.defaultLayer),
          Layer.provide(Layer.succeed(Credential.Service, credentials)),
        )
        yield* Effect.gen(function* () {
          yield* Auth.Service
          expect(yield* credentials.list(openai)).toEqual([current])
        }).pipe(Effect.provide(restarted))
      }).pipe(Effect.provide(bridgeLayer))
    }),
  )

  it.instance("startup mirrors a newer native default OAuth credential into auth.json", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const authFile = path.join(instance.directory, "auth-native-oauth.json")
      yield* Effect.promise(() =>
        Bun.write(
          authFile,
          JSON.stringify({
            openai: {
              type: "oauth",
              access: "stale-access",
              refresh: "stale-refresh",
              expires: 1_789_724_819_630,
              accountId: "stale-account",
              opaqueMetadata: "preserve-me",
            },
            "foreign-provider": { type: "future-auth-format", token: "keep-me" },
          }),
        ),
      )
      const credentialLayer = Credential.layer.pipe(
        Layer.provide(
          Database.layerFromPath(path.join(instance.directory, "auth-native-oauth.sqlite")).pipe(Layer.fresh),
        ),
      )

      yield* Effect.gen(function* () {
        const credentials = yield* Credential.Service
        const openai = Integration.ID.make("openai")
        const native = yield* credentials.create({
          integrationID: openai,
          label: "default",
          value: new Credential.OAuth({
            type: "oauth",
            methodID: Integration.MethodID.make("chatgpt-browser"),
            access: "native-access",
            refresh: "native-refresh",
            expires: 1_790_742_125_036,
            metadata: { accountID: "native-account" },
          }),
        })
        const authLayer = Auth.layerFromPath(authFile).pipe(
          Layer.provide(FSUtil.defaultLayer),
          Layer.provide(Layer.succeed(Credential.Service, credentials)),
        )

        yield* Effect.gen(function* () {
          yield* Auth.Service
          expect((yield* Effect.promise(() => Bun.file(authFile).json())).openai).toMatchObject({
            type: "oauth",
            access: "native-access",
            refresh: "native-refresh",
            expires: 1_790_742_125_036,
            accountId: "native-account",
            opaqueMetadata: "preserve-me",
          })
          expect((yield* Effect.promise(() => Bun.file(authFile).json()))["foreign-provider"]).toEqual({
            type: "future-auth-format",
            token: "keep-me",
          })
          expect(yield* credentials.list(openai)).toEqual([native])
        }).pipe(Effect.provide(authLayer))
      }).pipe(Effect.provide(credentialLayer))
    }),
  )

  it.instance("parallel native OAuth updates publish the newest compatible token without downgrading auth.json", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const authFile = path.join(instance.directory, "auth-native-oauth-race.json")
      yield* Effect.promise(() =>
        Bun.write(
          authFile,
          JSON.stringify({
            openai: { type: "oauth", access: "stale-access", refresh: "stale-refresh", expires: 1 },
            "foreign-provider": { type: "future-auth-format", token: "keep-me" },
          }),
        ),
      )
      const credentialLayer = Credential.layer.pipe(
        Layer.provide(
          Database.layerFromPath(path.join(instance.directory, "auth-native-oauth-race.sqlite")).pipe(Layer.fresh),
        ),
      )

      yield* Effect.gen(function* () {
        const credentials = yield* Credential.Service
        const openai = Integration.ID.make("openai")
        const native = yield* credentials.create({
          integrationID: openai,
          label: "default",
          value: new Credential.OAuth({
            type: "oauth",
            methodID: Integration.MethodID.make("chatgpt-browser"),
            access: "initial-access",
            refresh: "initial-refresh",
            expires: 2,
          }),
        })
        const authLayer = Auth.layerFromPath(authFile).pipe(
          Layer.provide(FSUtil.defaultLayer),
          Layer.provide(Layer.succeed(Credential.Service, credentials)),
        )

        yield* Effect.gen(function* () {
          yield* Auth.Service
          yield* Effect.all(
            [
              credentials.update(native.id, {
                value: new Credential.OAuth({
                  type: "oauth",
                  methodID: Integration.MethodID.make("chatgpt-browser"),
                  access: "parallel-access-200",
                  refresh: "parallel-refresh-200",
                  expires: 200,
                }),
              }),
              credentials.update(native.id, {
                value: new Credential.OAuth({
                  type: "oauth",
                  methodID: Integration.MethodID.make("chatgpt-browser"),
                  access: "parallel-access-300",
                  refresh: "parallel-refresh-300",
                  expires: 300,
                }),
              }),
            ],
            { concurrency: 2, discard: true },
          )
          expect((yield* Effect.promise(() => Bun.file(authFile).json())).openai).toMatchObject({
            access: "parallel-access-300",
            refresh: "parallel-refresh-300",
            expires: 300,
          })
          expect((yield* Effect.promise(() => Bun.file(authFile).json()))["foreign-provider"]).toEqual({
            type: "future-auth-format",
            token: "keep-me",
          })
        }).pipe(Effect.provide(authLayer))
      }).pipe(Effect.provide(credentialLayer))
    }),
  )

  it.instance("migrates self-hosted GitLab key and OAuth origins into credential metadata", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const authFile = path.join(instance.directory, "auth-gitlab.json")
      yield* Effect.promise(() =>
        Bun.write(
          authFile,
          JSON.stringify({
            gitlab: {
              type: "api",
              key: "gitlab-pat",
              enterpriseUrl: "https://gitlab.company.test",
            },
          }),
        ),
      )
      const credentialLayer = Credential.layer.pipe(
        Layer.provide(Database.layerFromPath(path.join(instance.directory, "auth-gitlab.sqlite")).pipe(Layer.fresh)),
      )

      yield* Effect.gen(function* () {
        const auth = yield* Auth.Service
        const credentials = yield* Credential.Service
        const integrationID = Integration.ID.make("gitlab")
        expect((yield* credentials.list(integrationID))[0]?.value).toEqual(
          new Credential.Key({
            type: "key",
            key: "gitlab-pat",
            metadata: { instanceUrl: "https://gitlab.company.test" },
          }),
        )

        yield* auth.set("gitlab", {
          type: "oauth",
          access: "gitlab-access",
          refresh: "gitlab-refresh",
          expires: 60_000,
          enterpriseUrl: "https://oauth.gitlab.company.test",
        })
        expect((yield* credentials.list(integrationID))[0]?.value).toEqual(
          new Credential.OAuth({
            type: "oauth",
            methodID: Integration.MethodID.make("gitlab-oauth"),
            access: "gitlab-access",
            refresh: "gitlab-refresh",
            expires: 60_000,
            metadata: { instanceUrl: "https://oauth.gitlab.company.test" },
          }),
        )
      }).pipe(
        Effect.provide(
          Auth.layerFromPath(authFile).pipe(Layer.provide(FSUtil.defaultLayer), Layer.provideMerge(credentialLayer)),
        ),
      )
    }),
  )
})
