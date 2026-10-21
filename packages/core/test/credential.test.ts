import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Credential } from "@opencode-ai/core/credential"
import { Database } from "@opencode-ai/core/database/database"
import { Integration } from "@opencode-ai/core/integration"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

function layer(directory: string) {
  return Credential.layer.pipe(
    Layer.provide(Database.layerFromPath(path.join(directory, "credential.db")).pipe(Layer.fresh)),
  )
}

describe("Credential", () => {
  it.live("concurrent startup imports reconcile legacy mirrors across processes", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const run = (phase: string) =>
            Bun.spawn(
              [process.execPath, path.join(import.meta.dir, "fixture", "credential-race.ts"), tmp.path, phase],
              {
                cwd: process.cwd(),
                stdout: "pipe",
                stderr: "pipe",
              },
            )
          const seed = run("seed")
          expect(yield* Effect.promise(() => seed.exited)).toBe(0)
          const children = yield* Effect.acquireRelease(
            Effect.sync(() => ["one", "two", "three"].map((phase) => ({ phase, process: run(phase) }))),
            (children) => Effect.sync(() => children.forEach((child) => child.process.kill())),
          )
          yield* Effect.promise(async () => {
            const deadline = Date.now() + 10_000
            while (
              !(
                await Promise.all(
                  children.map((child) => Bun.file(path.join(tmp.path, `${child.phase}.ready`)).exists()),
                )
              ).every(Boolean)
            ) {
              if (Date.now() >= deadline) throw new Error("credential import workers did not become ready")
              await Bun.sleep(10)
            }
            await Bun.write(path.join(tmp.path, "start"), "ready")
          })
          const results = yield* Effect.promise(() =>
            Promise.all(
              children.map(async (child) => ({
                exit: await child.process.exited,
                stderr: await new Response(child.process.stderr).text(),
              })),
            ),
          )
          expect(results).toEqual(children.map(() => ({ exit: 0, stderr: "" })))
          yield* Effect.gen(function* () {
            const credentials = yield* Credential.Service
            const native = yield* credentials.list(Integration.ID.make("native-fixture"))
            expect(native).toHaveLength(1)
            expect(native[0]?.value).toEqual(new Credential.Key({ type: "key", key: "native-fixture-key" }))
            const stored = yield* credentials.legacy()
            expect(stored).toHaveLength(50)
            expect(new Set(stored.map((item) => item.integrationID)).size).toBe(50)
            expect(stored.every((item) => item.label === Credential.LegacyLabel)).toBe(true)
            expect(
              stored.every((item) => item.value.type === "key" && /^fixture-(one|two|three)-2$/.test(item.value.key)),
            ).toBe(true)
          }).pipe(
            Effect.provide(
              Credential.layer.pipe(Layer.provide(Database.layerFromPath(path.join(tmp.path, "race.db")))),
            ),
          )
        }),
      ),
    ),
  )

  it.live("stores, updates, lists, and removes credentials", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const credentials = yield* Credential.Service
          const integrationID = Integration.ID.make("openai")
          const created = yield* credentials.create({
            integrationID,
            label: "Work",
            value: new Credential.Key({ type: "key", key: "secret" }),
          })

          expect(yield* credentials.list(integrationID)).toEqual([created])
          yield* credentials.update(created.id, { label: "Personal" })
          expect((yield* credentials.list(integrationID))[0]?.label).toBe("Personal")

          const replacement = yield* credentials.create({
            integrationID,
            label: "Replacement",
            value: new Credential.Key({ type: "key", key: "replacement" }),
          })
          expect(yield* credentials.list(integrationID)).toEqual([replacement])

          yield* credentials.remove(replacement.id)
          expect(yield* credentials.list(integrationID)).toEqual([])
        }).pipe(Effect.provide(layer(tmp.path))),
      ),
    ),
  )

  it.live("keeps a newer legacy OAuth credential during bootstrap", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const credentials = yield* Credential.Service
          const integrationID = Integration.ID.make("openai")
          const snapshot = new Credential.OAuth({
            type: "oauth",
            methodID: Integration.MethodID.make("chatgpt-browser"),
            access: "snapshot-access",
            refresh: "snapshot-refresh",
            expires: 1,
          })
          yield* credentials.syncLegacy({ mode: "bootstrap", integrationID, value: snapshot })

          const imported = (yield* credentials.list(integrationID))[0]!
          const refreshed = new Credential.OAuth({
            type: "oauth",
            methodID: snapshot.methodID,
            access: "rotated-access",
            refresh: "rotated-refresh",
            expires: 60_000,
          })
          yield* credentials.update(imported.id, { value: refreshed })

          expect(yield* credentials.syncLegacy({ mode: "bootstrap", integrationID, value: snapshot })).toBe(true)
          expect((yield* credentials.list(integrationID))[0]).toEqual(
            expect.objectContaining({ id: imported.id, value: refreshed }),
          )
        }).pipe(Effect.provide(layer(tmp.path))),
      ),
    ),
  )

  it.live("separates legacy bootstrap, explicit replacement, and removal", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const credentials = yield* Credential.Service
          const integrationID = Integration.ID.make("openai")
          expect(
            yield* credentials.syncLegacy({
              mode: "bootstrap",
              integrationID,
              value: new Credential.Key({ type: "key", key: "legacy-key" }),
            }),
          ).toBe(true)
          expect((yield* credentials.list(integrationID))[0]).toMatchObject({ label: Credential.LegacyLabel })

          expect(
            yield* credentials.syncLegacy({
              mode: "set",
              integrationID,
              value: new Credential.OAuth({
                type: "oauth",
                methodID: Integration.MethodID.make("chatgpt-browser"),
                access: "legacy-access",
                refresh: "legacy-refresh",
                expires: 1,
              }),
            }),
          ).toBe(true)
          const imported = (yield* credentials.list(integrationID))[0]!
          const refreshed = new Credential.OAuth({
            type: "oauth",
            methodID: Integration.MethodID.make("chatgpt-browser"),
            access: "refreshed-access",
            refresh: "refreshed-refresh",
            expires: 60_000,
          })
          yield* credentials.update(imported.id, { value: refreshed })
          const stale = new Credential.OAuth({
            type: "oauth",
            methodID: Integration.MethodID.make("chatgpt-browser"),
            access: "stale-access",
            refresh: "stale-refresh",
            expires: 1,
          })
          // Bootstrap must not roll back a legacy OAuth value that was refreshed
          // after the auth.json snapshot was loaded.
          expect(
            yield* credentials.syncLegacy({
              mode: "bootstrap",
              integrationID,
              value: stale,
            }),
          ).toBe(true)
          expect((yield* credentials.list(integrationID))[0]?.value).toEqual(refreshed)

          expect(
            yield* credentials.syncLegacy({
              mode: "set",
              integrationID,
              value: new Credential.Key({ type: "key", key: "explicit-set" }),
            }),
          ).toBe(true)
          expect((yield* credentials.list(integrationID))[0]?.value).toEqual(
            new Credential.Key({ type: "key", key: "explicit-set" }),
          )

          const current = yield* credentials.create({
            integrationID,
            label: Credential.LegacyLabel,
            value: new Credential.Key({ type: "key", key: "v2-key" }),
          })
          expect(
            yield* credentials.syncLegacy({
              mode: "set",
              integrationID,
              value: new Credential.Key({ type: "key", key: "stale-legacy-key" }),
            }),
          ).toBe(false)
          expect(yield* credentials.list(integrationID)).toEqual([current])
          expect(yield* credentials.syncLegacy({ mode: "remove", integrationID })).toBe(false)
          expect(yield* credentials.list(integrationID)).toEqual([current])

          const removable = Integration.ID.make("legacy-only")
          yield* credentials.syncLegacy({
            mode: "bootstrap",
            integrationID: removable,
            value: new Credential.Key({ type: "key", key: "remove-me" }),
          })
          expect(yield* credentials.syncLegacy({ mode: "remove", integrationID: removable })).toBe(true)
          expect(yield* credentials.list(removable)).toEqual([])
        }).pipe(Effect.provide(layer(tmp.path))),
      ),
    ),
  )

  it.live("bootstrap reconciles a stale legacy OAuth mirror without touching native V2 credentials", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const credentials = yield* Credential.Service
          const integrationID = Integration.ID.make("openai")
          expect(
            yield* credentials.syncLegacy({
              mode: "bootstrap",
              integrationID,
              value: new Credential.OAuth({
                type: "oauth",
                methodID: Integration.MethodID.make("chatgpt-browser"),
                access: "stale-access",
                refresh: "stale-refresh",
                expires: 1,
              }),
            }),
          ).toBe(true)

          // auth.json is authoritative: a newer future-expiring token replaces
          // the previously imported stale mirror.
          const future = new Credential.OAuth({
            type: "oauth",
            methodID: Integration.MethodID.make("chatgpt-browser"),
            access: "future-access",
            refresh: "future-refresh",
            expires: 60_000,
          })
          expect(
            yield* credentials.syncLegacy({
              mode: "bootstrap",
              integrationID,
              value: future,
            }),
          ).toBe(true)
          expect((yield* credentials.list(integrationID))[0]?.value).toEqual(future)

          // Bootstrap is idempotent: re-running with the same value is a no-op.
          expect(
            yield* credentials.syncLegacy({
              mode: "bootstrap",
              integrationID,
              value: future,
            }),
          ).toBe(true)
          expect((yield* credentials.list(integrationID))[0]?.value).toEqual(future)

          // A native V2 credential is never overwritten by bootstrap, and
          // remains untouched.
          const native = yield* credentials.create({
            integrationID,
            label: "V2 connection",
            value: new Credential.Key({ type: "key", key: "v2-native-key" }),
          })
          expect(
            yield* credentials.syncLegacy({
              mode: "bootstrap",
              integrationID,
              value: future,
            }),
          ).toBe(false)
          expect(yield* credentials.list(integrationID)).toEqual([native])
        }).pipe(Effect.provide(layer(tmp.path))),
      ),
    ),
  )

  it.live("keeps durable credential writes successful when a change listener fails", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const credentials = yield* Credential.Service
          const integrationID = Integration.ID.make("listener-failure")
          yield* credentials.onChange(() => Effect.die("listener failed"))

          const created = yield* credentials.create({
            integrationID,
            label: "native",
            value: new Credential.Key({ type: "key", key: "kept" }),
          })

          expect(yield* credentials.list(integrationID)).toEqual([created])
        }).pipe(Effect.provide(layer(tmp.path))),
      ),
    ),
  )
})
