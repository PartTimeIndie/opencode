import { afterEach, describe, expect } from "bun:test"
import { createHash } from "crypto"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect } from "effect"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"
import { Global } from "@opencode-ai/core/global"

function app() {
  return Server.Default().app
}

const tmpdirEffect = (options: Parameters<typeof tmpdir>[0]) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir(options)),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const exists = (file: string) => fs.stat(file).then(() => true, () => false)

async function waitForFile(file: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await exists(file)) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return false
}

// Bounded await with a cleared timer so no leftover timeout outlives the race.
function bound<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

const holderPath = path.join(import.meta.dir, "..", "fixture", "npm-lock-holder.ts")

type HolderMarkers = { ready: string; active: string; release: string; done: string }

async function spawnHolder(input: { key: string; locksRoot: string; markers: string; holdMs: number }) {
  const markers: HolderMarkers = {
    ready: path.join(input.markers, "ready"),
    active: path.join(input.markers, "active"),
    release: path.join(input.markers, "release"),
    done: path.join(input.markers, "done"),
  }
  const proc = Bun.spawn([
    process.execPath,
    holderPath,
    JSON.stringify({ key: input.key, dir: input.locksRoot, holdMs: input.holdMs, ...markers }),
  ])
  return { proc, markers }
}

// Primary path: write the release marker and give the holder a bounded window
// to exit through the real EffectFlock release finalizer. On timeout the kill
// fallback runs; either way the exit is awaited before returning.
async function awaitGracefulExit(proc: Bun.Subprocess, releaseFile: string, timeoutMs: number) {
  await fs.writeFile(releaseFile, "now").catch(() => undefined)
  let timer: ReturnType<typeof setTimeout> | undefined
  const outcome = await Promise.race([
    proc.exited.then(() => "exit" as const),
    new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs)
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
  if (outcome === "timeout") proc.kill()
  await proc.exited
  return outcome === "exit"
}

const metaPid = (meta: string) => /"pid":(\d+)/.exec(meta)?.[1] ?? "?"

// Real acquisition provenance: the flock lock dir lifecycle IS the acquire/
// release boundary, so a 50ms poll records every appear (with the owning
// meta.json pid) and disappear (release finalizer) as an observation.
async function pollLockDir(input: {
  lockDir: string
  start: number
  transitions: string[]
  state: { present: boolean }
  shouldStop: () => boolean
}) {
  while (!input.shouldStop()) {
    const present = await exists(input.lockDir)
    if (present !== input.state.present) {
      input.state.present = present
      let detail = ""
      if (present) {
        const meta = await fs.readFile(path.join(input.lockDir, "meta.json"), "utf8").catch(() => "")
        detail = ` pid=${metaPid(meta)} (test=${process.pid})`
      }
      input.transitions.push(`+${Date.now() - input.start}ms lockDir ${present ? `acquired${detail}` : "released (dir removed)"}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function lockTable(locksRoot: string, keys: Record<string, string>) {
  const names = (await fs.readdir(locksRoot).catch(() => [] as string[])).filter((n) => n.endsWith(".lock"))
  const rows: string[] = []
  for (const name of names.slice(0, 10)) {
    const meta = await fs.readFile(path.join(locksRoot, name, "meta.json"), "utf8").catch(() => "unreadable")
    const label = Object.entries(keys).find(([key]) => createHash("sha1").update(key).digest("hex") === name.replace(".lock", ""))?.[0]
    const heartbeat = await fs.stat(path.join(locksRoot, name, "heartbeat")).catch(() => undefined)
    const hbAge = heartbeat ? `${Math.round((Date.now() - heartbeat.mtimeMs) / 1000)}s` : "?"
    rows.push(`${label ?? name} pid=${metaPid(meta)} heartbeatAge=${hbAge}`)
  }
  return rows
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("config HttpApi against a real flock dependency", () => {
  // Expected end state: the runtime-safe global config PATCH completes
  // finitely and the blocked first request recovers with a typed, finite
  // response. This test records real provenance (flock lock dir lifecycle
  // with owning pids, arborist artifacts, PATCH write commit, per-layer
  // probes) without promoting file presence to causal claims and without
  // asserting npm artifact shapes.
  it.live(
    "global config PATCH completes finitely after a proven graceful release",
    Effect.gen(function* () {
      yield* Effect.logWarning("flock-repro log visibility probe")
      const global = yield* tmpdirEffect({})
      const first = yield* tmpdirEffect({
        config: { formatter: false, lsp: false },
        init: async (dir) => {
          await fs.mkdir(path.join(dir, ".opencode", "plugin"), { recursive: true })
          await Bun.write(
            path.join(dir, ".opencode", "plugin", "repro-local.ts"),
            'export default {\n  id: "test.lock-repro-local",\n  server: async () => ({}),\n}\n',
          )
        },
      })
      const second = yield* tmpdirEffect({ config: { formatter: false, lsp: false } })
      const third = yield* tmpdirEffect({ config: { formatter: false, lsp: false } })
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const previous = Global.Path.config
          ;(Global.Path as { config: string }).config = global.path
          return previous
        }),
        (previous) =>
          Effect.sync(() => {
            ;(Global.Path as { config: string }).config = previous
          }),
      ).pipe(Effect.asVoid)
      yield* Effect.promise(() =>
        Bun.write(
          path.join(global.path, "opencode.json"),
          JSON.stringify({ $schema: "https://opencode.ai/config.json" }),
        ),
      )

      // ConfigPaths.directories (config.ts loop) installs per discovered
      // .opencode dir; FSUtil.up joins path-style, so this is the exact key
      // string the server acquires and the exact dir arborist reifies into.
      const locksRoot = path.join(Global.Path.state, "locks")
      const installDir = path.join(first.path, ".opencode")
      const key = `npm-install:${installDir}`
      const globalKey = `npm-install:${global.path}`
      const lockDir = path.join(locksRoot, createHash("sha1").update(key).digest("hex") + ".lock")
      const markersDir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "opencode-lock-repro-")))
      const released = { value: false }

      yield* Effect.acquireRelease(
        Effect.promise(() => spawnHolder({ key, locksRoot, markers: markersDir, holdMs: 90_000 })),
        // Single owner of the holder lifecycle: if the test already released
        // gracefully this only cleans the owned markers; otherwise it tries
        // the graceful release first and kills only as the bounded fallback.
        (spawned) =>
          Effect.promise(async () => {
            if (!released.value) await awaitGracefulExit(spawned.proc, spawned.markers.release, 8_000)
            await fs.rm(markersDir, { recursive: true, force: true })
          }),
      ).pipe(Effect.flatMap((holder) =>
        Effect.gen(function* () {
          const acquired = yield* Effect.promise(() => waitForFile(holder.markers.ready, 20_000))
          expect(acquired).toBe(true)
          expect(yield* Effect.promise(() => exists(lockDir))).toBe(true)

          const firstOutcome = { settled: false, status: 0, error: "" }
          const firstRequest = Promise.resolve(
            app().request("/config", { headers: { "x-opencode-directory": first.path } }),
          ).then(
            (response) => {
              firstOutcome.settled = true
              firstOutcome.status = response.status
              return response
            },
            (error) => {
              firstOutcome.settled = true
              firstOutcome.error = String(error)
              return undefined
            },
          )

          // Fork anchor only: ensureGitignore precedes the install fork in the
          // same config loop iteration. Iteration ran; fiber state inside the
          // acquire is proven by the lock dir lifecycle below, not by files.
          expect(yield* Effect.promise(() => waitForFile(path.join(installDir, ".gitignore"), 15_000))).toBe(true)

          const secondWarm = yield* Effect.promise(() =>
            Promise.resolve(app().request("/config", { headers: { "x-opencode-directory": second.path } })),
          )
          expect(secondWarm.status).toBe(200)

          const patchOutcome = { settled: false, status: 0, error: "" }
          const patchRequest = Promise.resolve(
            app().request("/global/config", {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ optimization: { profile: "off" } }),
            }),
          ).then(
            (response) => {
              patchOutcome.settled = true
              patchOutcome.status = response.status
              return response
            },
            (error) => {
              patchOutcome.settled = true
              patchOutcome.error = String(error)
              return undefined
            },
          )

          yield* Effect.sleep("4 seconds")
          const heldMs = Date.now()

          const healthDuringHold = yield* Effect.promise(() => Promise.resolve(app().request("/global/health")))
          expect(healthDuringHold.status).toBe(200)
          const secondDuringHold = yield* Effect.promise(() =>
            Promise.resolve(app().request("/config", { headers: { "x-opencode-directory": second.path } })),
          )
          expect(secondDuringHold.status).toBe(200)

          const timeline: string[] = []
          const watchStart = Date.now()
          const mark = (event: string) => timeline.push(`+${Date.now() - watchStart}ms ${event}`)
          const lockState = { present: true }
          let stopPolling = false
          const poller = pollLockDir({
            lockDir,
            start: watchStart,
            transitions: timeline,
            state: lockState,
            shouldStop: () => stopPolling,
          }).catch(() => undefined)

          const graceful = yield* Effect.promise(() =>
            awaitGracefulExit(holder.proc, holder.markers.release, 10_000),
          )
          released.value = true
          mark(`holder exited gracefully=${graceful} exitCode=${holder.proc.exitCode}`)
          expect(graceful).toBe(true)
          expect(holder.proc.exitCode).toBe(0)

          const globalConfigFile = path.join(global.path, "opencode.json")
          let patchWriteCommitted = false
          let firstMarked = false
          let patchMarked = false
          const watched = [
            { file: path.join(installDir, "package-lock.json"), note: "installDir/package-lock.json (arborist wrote)", seen: false },
          ]

          for (let i = 0; i < 50 && !(firstOutcome.settled && patchOutcome.settled); i++) {
            yield* Effect.sleep("600 millis")
            for (const w of watched) {
              if (w.seen || !(yield* Effect.promise(() => exists(w.file)))) continue
              w.seen = true
              mark(w.note)
            }
            if (!patchWriteCommitted) {
              const content = yield* Effect.promise(() => fs.readFile(globalConfigFile, "utf8").catch(() => ""))
              if (content.includes('"profile": "off"')) {
                patchWriteCommitted = true
                mark("global opencode.json contains patched profile (PATCH write committed)")
              }
            }
            if (firstOutcome.settled && !firstMarked) {
              firstMarked = true
              mark(`firstRequest settled status=${firstOutcome.status} error=${firstOutcome.error.slice(0, 200)}`)
            }
            if (patchOutcome.settled && !patchMarked) {
              patchMarked = true
              mark(`PATCH settled status=${patchOutcome.status} error=${patchOutcome.error.slice(0, 200)}`)
            }
          }
          stopPolling = true
          yield* Effect.promise(() => poller)

          // Layered probes while the PATCH is (still) unsettled: each is
          // bounded and recorded, none fails the run by itself.
          const healthAfter = yield* Effect.promise(() =>
            Promise.resolve(app().request("/global/health")).then(
              (r) => `status=${r.status}`,
              (e) => `rejected: ${String(e).slice(0, 150)}`,
            ),
          )
          mark(`probe /global/health: ${healthAfter}`)

          const secondPatch = Promise.resolve(
            app().request("/global/config", {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ optimization: { profile: "off" } }),
            }),
          )
          let timer: ReturnType<typeof setTimeout> | undefined
          const secondPatchOutcome = yield* Effect.promise(() =>
            Promise.race([
              secondPatch.then((r) => `status=${r.status}`, (e) => `rejected: ${String(e).slice(0, 150)}`),
              new Promise<string>((resolve) => {
                timer = setTimeout(() => resolve(`UNSETTLED after 8s (configWriteLock likely held)`), 8_000)
              }),
            ]).finally(() => {
              if (timer !== undefined) clearTimeout(timer)
            }),
          )
          mark(`probe second PATCH: ${secondPatchOutcome}`)

          for (const target of [third, first]) {
            const freshGet = Promise.resolve(
              app().request("/config", { headers: { "x-opencode-directory": target.path } }),
            )
            let getTimer: ReturnType<typeof setTimeout> | undefined
            const outcome = yield* Effect.promise(() =>
              Promise.race([
                freshGet.then((r) => `status=${r.status}`, (e) => `rejected: ${String(e).slice(0, 150)}`),
                new Promise<string>((resolve) => {
                  getTimer = setTimeout(() => resolve(`UNSETTLED after 8s`), 8_000)
                }),
              ]).finally(() => {
                if (getTimer !== undefined) clearTimeout(getTimer)
              }),
            )
            mark(`probe fresh GET ${target === third ? "third(dir)" : "first(dir)"}: ${outcome}`)
          }

          // Diagnosis-only extended observation (the regression assertions
          // above stay bounded at 30s): records whether the PATCH settles in
          // the flock stale-breaker window alongside the request outcomes.
          for (let i = 0; i < 45 && !(firstOutcome.settled && patchOutcome.settled); i++) {
            yield* Effect.sleep("1 second")
            if (patchOutcome.settled && !patchMarked) {
              patchMarked = true
              mark(`PATCH settled (late) status=${patchOutcome.status}`)
            }
            if (firstOutcome.settled && !firstMarked) {
              firstMarked = true
              mark(`firstRequest settled (late) status=${firstOutcome.status}`)
            }
          }

          const table = yield* Effect.promise(() =>
            lockTable(locksRoot, { [key]: "installDir-key", [globalKey]: "globalDir-key" }),
          )
          mark(`lock table: ${table.length ? table.join("; ") : "(no held lock dirs)"}`)

          const summary =
            `holder exit=${holder.proc.exitCode}; watch=${Date.now() - watchStart}ms (held window ended at ${heldMs}); ` +
            `patchWriteCommitted=${patchWriteCommitted}`
          console.log(`post-release provenance:\n${timeline.join("\n")}\n${summary}`)
          expect(
            patchOutcome.settled,
            `global config PATCH still unsettled 30s after proven graceful release. ${summary}`,
          ).toBe(true)
          expect(patchOutcome.status, summary).toBe(200)
          expect(firstOutcome.settled, summary).toBe(true)
          expect(firstOutcome.status, summary).toBe(200)
        }),
      ))
    }),
    90_000,
  )

  // Control: the same parked-dependency setup, but the holder is released
  // BEFORE the runtime-safe PATCH fires. This separates harness health from
  // the during-hold ordering and must show a finite PATCH and a finite,
  // typed first-directory response. It must run in a fresh process (for
  // example via --test-name-pattern "control: released"), because the
  // diagnoses test poisons the shared app graph when it fails.
  it.live(
    "control: released dependency lock before the global config PATCH keeps every request finite",
    Effect.gen(function* () {
      const global = yield* tmpdirEffect({})
      const first = yield* tmpdirEffect({
        config: { formatter: false, lsp: false },
        init: async (dir) => {
          await fs.mkdir(path.join(dir, ".opencode", "plugin"), { recursive: true })
          await Bun.write(
            path.join(dir, ".opencode", "plugin", "repro-local.ts"),
            'export default {\n  id: "test.lock-repro-local",\n  server: async () => ({}),\n}\n',
          )
        },
      })
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const previous = Global.Path.config
          ;(Global.Path as { config: string }).config = global.path
          return previous
        }),
        (previous) =>
          Effect.sync(() => {
            ;(Global.Path as { config: string }).config = previous
          }),
      ).pipe(Effect.asVoid)
      yield* Effect.promise(() =>
        Bun.write(
          path.join(global.path, "opencode.json"),
          JSON.stringify({ $schema: "https://opencode.ai/config.json" }),
        ),
      )

      const locksRoot = path.join(Global.Path.state, "locks")
      const installDir = path.join(first.path, ".opencode")
      const key = `npm-install:${installDir}`
      const lockDir = path.join(locksRoot, createHash("sha1").update(key).digest("hex") + ".lock")
      const markersDir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "opencode-lock-control-")))
      const released = { value: false }

      yield* Effect.acquireRelease(
        Effect.promise(() => spawnHolder({ key, locksRoot, markers: markersDir, holdMs: 60_000 })),
        (spawned) =>
          Effect.promise(async () => {
            if (!released.value) await awaitGracefulExit(spawned.proc, spawned.markers.release, 8_000)
            await fs.rm(markersDir, { recursive: true, force: true })
          }),
      ).pipe(Effect.flatMap((holder) =>
        Effect.gen(function* () {
          const acquired = yield* Effect.promise(() => waitForFile(holder.markers.ready, 20_000))
          expect(acquired).toBe(true)
          expect(yield* Effect.promise(() => exists(lockDir))).toBe(true)

          const firstOutcome = { settled: false, status: 0, error: "" }
          const firstRequest = Promise.resolve(
            app().request("/config", { headers: { "x-opencode-directory": first.path } }),
          ).then(
            (response) => {
              firstOutcome.settled = true
              firstOutcome.status = response.status
              return response
            },
            (error) => {
              firstOutcome.settled = true
              firstOutcome.error = String(error)
              return undefined
            },
          )
          expect(yield* Effect.promise(() => waitForFile(path.join(installDir, ".gitignore"), 15_000))).toBe(true)

          const graceful = yield* Effect.promise(() =>
            awaitGracefulExit(holder.proc, holder.markers.release, 10_000),
          )
          released.value = true
          expect(graceful).toBe(true)
          expect(holder.proc.exitCode).toBe(0)

          const firstResponse = yield* Effect.promise(() =>
            bound(firstRequest, 20_000, "first-directory request did not settle after pre-PATCH release"),
          )
          expect(firstOutcome.settled).toBe(true)
          expect(firstOutcome.status).toBe(200)
          const body = (yield* Effect.promise(() => firstResponse!.json())) as Record<string, unknown>
          console.log(`control first body keys: ${Object.keys(body).join(",")}`)

          const patchStartedAt = Date.now()
          const patchResponse = yield* Effect.promise(() =>
            bound(
              Promise.resolve(
                app().request("/global/config", {
                  method: "PATCH",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ optimization: { profile: "off" } }),
                }),
              ),
              20_000,
              "control PATCH did not complete with the lock already free",
            ),
          )
          expect(patchResponse.status).toBe(200)
          yield* Effect.logInfo("control measurements", {
            firstStatus: firstOutcome.status,
            patchMs: Date.now() - patchStartedAt,
          })
        }),
      ))
    }),
    60_000,
  )

  // Boundary narrowing: same parked-dependency setup but WITHOUT a local
  // plugin, so the bootstrap never joins waitForDependencies. If the PATCH
  // completes after release here, the hang in the first test needs the
  // waiter/retry interleave; if it still hangs, the entry close alone is
  // broken. No join, no retry claims — pure close observation.
  it.live(
    "nojoin: global config PATCH completes after release when no bootstrap joins the dependency",
    Effect.gen(function* () {
      const global = yield* tmpdirEffect({})
      const first = yield* tmpdirEffect({ config: { formatter: false, lsp: false } })
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const previous = Global.Path.config
          ;(Global.Path as { config: string }).config = global.path
          return previous
        }),
        (previous) =>
          Effect.sync(() => {
            ;(Global.Path as { config: string }).config = previous
          }),
      ).pipe(Effect.asVoid)
      yield* Effect.promise(() =>
        Bun.write(
          path.join(global.path, "opencode.json"),
          JSON.stringify({ $schema: "https://opencode.ai/config.json" }),
        ),
      )

      const locksRoot = path.join(Global.Path.state, "locks")
      const installDir = global.path
      const key = `npm-install:${installDir}`
      const lockDir = path.join(locksRoot, createHash("sha1").update(key).digest("hex") + ".lock")
      const markersDir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "opencode-lock-nojoin-")))
      const released = { value: false }

      yield* Effect.acquireRelease(
        Effect.promise(() => spawnHolder({ key, locksRoot, markers: markersDir, holdMs: 60_000 })),
        (spawned) =>
          Effect.promise(async () => {
            if (!released.value) await awaitGracefulExit(spawned.proc, spawned.markers.release, 8_000)
            await fs.rm(markersDir, { recursive: true, force: true })
          }),
      ).pipe(Effect.flatMap((holder) =>
        Effect.gen(function* () {
          const acquired = yield* Effect.promise(() => waitForFile(holder.markers.ready, 20_000))
          expect(acquired).toBe(true)

          // Without a local plugin the bootstrap never joins the dependency
          // fiber, so this must succeed while the install is still parked.
          const early = yield* Effect.promise(() =>
            Promise.resolve(app().request("/config", { headers: { "x-opencode-directory": first.path } })),
          )
          expect(early.status).toBe(200)
          expect(yield* Effect.promise(() => waitForFile(path.join(global.path, ".gitignore"), 15_000))).toBe(true)

          const patchStartedAt = Date.now()
          const patchOutcome = { settled: false, status: 0, error: "" }
          const patchRequest = Promise.resolve(
            app().request("/global/config", {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ optimization: { profile: "off" } }),
            }),
          ).then(
            (response) => {
              patchOutcome.settled = true
              patchOutcome.status = response.status
              return response
            },
            (error) => {
              patchOutcome.settled = true
              patchOutcome.error = String(error)
              return undefined
            },
          )
          yield* Effect.sleep("4 seconds")

          const graceful = yield* Effect.promise(() =>
            awaitGracefulExit(holder.proc, holder.markers.release, 10_000),
          )
          released.value = true
          expect(graceful).toBe(true)
          expect(holder.proc.exitCode).toBe(0)

          const patchResponse = yield* Effect.promise(() =>
            bound(patchRequest, 20_000, "nojoin PATCH did not complete after release"),
          )
          expect(patchOutcome.settled).toBe(true)
          if (patchResponse === undefined) throw new Error("diagnostic: nojoin PATCH settled flag set but response missing")
          expect(patchResponse.status).toBe(200)
          yield* Effect.logInfo("nojoin measurements", { patchMs: Date.now() - patchStartedAt })
        }),
      ))
    }),
    60_000,
  )

  // Same-local-dir control WITHOUT any plugin file: the first project owns an
  // empty .opencode directory, so ConfigPaths yields the same two dependency
  // installs (global config dir + local .opencode dir) and the holder parks
  // exactly first.path/.opencode like the diagnoses test — but no configured
  // plugin exists, so the bootstrap never joins waitForDependencies. If this
  // stays green while the diagnoses test hangs, the missing piece is the
  // join/retry interleave rather than local lock ownership or dep count.
  it.live(
    "nolocal: global config PATCH completes after release with the same local lock but no plugin join",
    Effect.gen(function* () {
      const global = yield* tmpdirEffect({})
      const first = yield* tmpdirEffect({
        config: { formatter: false, lsp: false },
        init: async (dir) => {
          await fs.mkdir(path.join(dir, ".opencode", "plugin"), { recursive: true })
        },
      })
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const previous = Global.Path.config
          ;(Global.Path as { config: string }).config = global.path
          return previous
        }),
        (previous) =>
          Effect.sync(() => {
            ;(Global.Path as { config: string }).config = previous
          }),
      ).pipe(Effect.asVoid)
      yield* Effect.promise(() =>
        Bun.write(
          path.join(global.path, "opencode.json"),
          JSON.stringify({ $schema: "https://opencode.ai/config.json" }),
        ),
      )

      const locksRoot = path.join(Global.Path.state, "locks")
      const installDir = path.join(first.path, ".opencode")
      const key = `npm-install:${installDir}`
      const lockDir = path.join(locksRoot, createHash("sha1").update(key).digest("hex") + ".lock")
      const markersDir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "opencode-lock-nolocal-")))
      const released = { value: false }

      yield* Effect.acquireRelease(
        Effect.promise(() => spawnHolder({ key, locksRoot, markers: markersDir, holdMs: 60_000 })),
        (spawned) =>
          Effect.promise(async () => {
            if (!released.value) await awaitGracefulExit(spawned.proc, spawned.markers.release, 8_000)
            await fs.rm(markersDir, { recursive: true, force: true })
          }),
      ).pipe(Effect.flatMap((holder) =>
        Effect.gen(function* () {
          const acquired = yield* Effect.promise(() => waitForFile(holder.markers.ready, 20_000))
          expect(acquired).toBe(true)
          expect(yield* Effect.promise(() => exists(lockDir))).toBe(true)

          // No plugin file exists, so the bootstrap never joins the parked
          // dependency fiber; this must succeed while the install is parked.
          const early = yield* Effect.promise(() =>
            Promise.resolve(app().request("/config", { headers: { "x-opencode-directory": first.path } })),
          )
          expect(early.status).toBe(200)
          // Same ordering anchor as the diagnoses test: the generate loop
          // reached the local install dir before its install fiber forked.
          expect(yield* Effect.promise(() => waitForFile(path.join(installDir, ".gitignore"), 15_000))).toBe(true)
          yield* Effect.sleep("400 millis")

          const patchStartedAt = Date.now()
          const patchOutcome = { settled: false, status: 0, error: "" }
          const patchRequest = Promise.resolve(
            app().request("/global/config", {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ optimization: { profile: "off" } }),
            }),
          ).then(
            (response) => {
              patchOutcome.settled = true
              patchOutcome.status = response.status
              return response
            },
            (error) => {
              patchOutcome.settled = true
              patchOutcome.error = String(error)
              return undefined
            },
          )
          yield* Effect.sleep("4 seconds")

          const graceful = yield* Effect.promise(() =>
            awaitGracefulExit(holder.proc, holder.markers.release, 10_000),
          )
          released.value = true
          expect(graceful).toBe(true)
          expect(holder.proc.exitCode).toBe(0)

          const patchResponse = yield* Effect.promise(() =>
            bound(patchRequest, 20_000, "nolocal PATCH did not complete after release"),
          )
          expect(patchOutcome.settled).toBe(true)
          if (patchResponse === undefined) throw new Error("diagnostic: nolocal PATCH settled flag set but response missing")
          expect(patchResponse.status).toBe(200)
          yield* Effect.logInfo("nolocal measurements", { patchMs: Date.now() - patchStartedAt })
        }),
      ))
    }),
    60_000,
  )

  // Reload-required PATCH variant with the identical parked-dependency setup
  // WITH the local plugin (join active). Because the update handler runs
  // config.updateGlobal (and therefore the entry close) BEFORE the reload
  // sweep, this is NOT a retry-disabled discriminator: the same close runs
  // while the same waiter is parked. The sweep then deliberately aborts the
  // parked boot: the waiter must settle finitely with 503 (typed abort, never
  // revived by retry — pinned at store level in
  // instance-bootstrap-interrupt.test.ts) and a follow-up request must boot a
  // fresh instance instead of hanging on the old one.
  it.live(
    "reloadpatch: reload-required PATCH aborts the parked waiter with finite 503 and the follow-up boots fresh",
    Effect.gen(function* () {
      const global = yield* tmpdirEffect({})
      const first = yield* tmpdirEffect({
        config: { formatter: false, lsp: false },
        init: async (dir) => {
          await fs.mkdir(path.join(dir, ".opencode", "plugin"), { recursive: true })
          await Bun.write(
            path.join(dir, ".opencode", "plugin", "repro-local.ts"),
            'export default {\n  id: "test.lock-repro-local",\n  server: async () => ({}),\n}\n',
          )
        },
      })
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const previous = Global.Path.config
          ;(Global.Path as { config: string }).config = global.path
          return previous
        }),
        (previous) =>
          Effect.sync(() => {
            ;(Global.Path as { config: string }).config = previous
          }),
      ).pipe(Effect.asVoid)
      yield* Effect.promise(() =>
        Bun.write(
          path.join(global.path, "opencode.json"),
          JSON.stringify({ $schema: "https://opencode.ai/config.json" }),
        ),
      )

      const locksRoot = path.join(Global.Path.state, "locks")
      const installDir = path.join(first.path, ".opencode")
      const key = `npm-install:${installDir}`
      const lockDir = path.join(locksRoot, createHash("sha1").update(key).digest("hex") + ".lock")
      const markersDir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "opencode-lock-reloadpatch-")))
      const released = { value: false }

      yield* Effect.acquireRelease(
        Effect.promise(() => spawnHolder({ key, locksRoot, markers: markersDir, holdMs: 60_000 })),
        (spawned) =>
          Effect.promise(async () => {
            if (!released.value) await awaitGracefulExit(spawned.proc, spawned.markers.release, 8_000)
            await fs.rm(markersDir, { recursive: true, force: true })
          }),
      ).pipe(Effect.flatMap((holder) =>
        Effect.gen(function* () {
          const acquired = yield* Effect.promise(() => waitForFile(holder.markers.ready, 20_000))
          expect(acquired).toBe(true)
          expect(yield* Effect.promise(() => exists(lockDir))).toBe(true)

          const firstOutcome = { settled: false, status: 0, error: "" }
          const firstRequest = Promise.resolve(
            app().request("/config", { headers: { "x-opencode-directory": first.path } }),
          ).then(
            (response) => {
              firstOutcome.settled = true
              firstOutcome.status = response.status
              return response
            },
            (error) => {
              firstOutcome.settled = true
              firstOutcome.error = String(error)
              return undefined
            },
          )
          expect(yield* Effect.promise(() => waitForFile(path.join(installDir, ".gitignore"), 15_000))).toBe(true)
          yield* Effect.sleep("400 millis")

          const patchOutcome = { settled: false, status: 0, error: "" }
          const patchRequest = Promise.resolve(
            app().request("/global/config", {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ agent: { build: { description: "reload-patch-join" } } }),
            }),
          ).then(
            (response) => {
              patchOutcome.settled = true
              patchOutcome.status = response.status
              return response
            },
            (error) => {
              patchOutcome.settled = true
              patchOutcome.error = String(error)
              return undefined
            },
          )
          yield* Effect.sleep("4 seconds")
          // The entry close runs before any reload sweep can parent-cancel
          // the waiter, so the waiter must still be unsettled here.
          expect(firstOutcome.settled).toBe(false)
          expect(patchOutcome.settled, "reload-required PATCH settled during the held window").toBe(false)

          const graceful = yield* Effect.promise(() =>
            awaitGracefulExit(holder.proc, holder.markers.release, 10_000),
          )
          released.value = true
          expect(graceful).toBe(true)
          expect(holder.proc.exitCode).toBe(0)

          const patchResponse = yield* Effect.promise(() =>
            bound(patchRequest, 20_000, "reloadpatch PATCH did not complete after release"),
          )
          expect(patchOutcome.settled).toBe(true)
          if (patchResponse === undefined) throw new Error("diagnostic: reloadpatch PATCH settled flag set but response missing")
          expect(patchResponse.status).toBe(200)
          const firstResponse = yield* Effect.promise(() =>
            bound(firstRequest, 20_000, "reloadpatch first request did not settle after release"),
          )
          expect(firstOutcome.settled).toBe(true)
          if (firstResponse === undefined) throw new Error("diagnostic: reloadpatch first request settled flag set but response missing")
          // Deliberate parent abort through the reload sweep: the parked waiter
          // must settle finitely with the structured 503 contract
          // (instance_unavailable + directory + reason + retryAfterMs, never a
          // blank body), never be revived by retry, and the follow-up request
          // must boot a fresh instance instead of hanging.
          expect(firstOutcome.status).toBe(503)
          expect(firstResponse.status).toBe(503)
          const abortText = yield* Effect.promise(() => firstResponse.text())
          const abortJson = ((): Record<string, unknown> | undefined => {
            try {
              return JSON.parse(abortText) as Record<string, unknown>
            } catch {
              return undefined
            }
          })()
          console.log(`reloadpatch abort body: status=${firstResponse.status} bytes=${abortText.length} body=${abortText.slice(0, 300)}`)
          if (abortJson === undefined) throw new Error(`reloadpatch abort body is not JSON (blank-body 503): bytes=${abortText.length}`)
          expect(abortJson).toMatchObject({ error: "instance_unavailable", directory: first.path })
          expect(typeof abortJson.reason).toBe("string")
          expect(typeof abortJson.retryAfterMs).toBe("number")
          expect(firstResponse.headers.get("retry-after")).toBe(String(Math.max(1, Math.ceil(Number(abortJson.retryAfterMs) / 1000))))
          const followUp = yield* Effect.promise(() =>
            bound(
              Promise.resolve(app().request("/config", { headers: { "x-opencode-directory": first.path } })),
              20_000,
              "reloadpatch follow-up request did not settle after the aborted waiter",
            ),
          )
          if (followUp === undefined) throw new Error("diagnostic: reloadpatch follow-up settled flag set but response missing")
          const followUpText = yield* Effect.promise(() => followUp.text())
          console.log(`reloadpatch follow-up: status=${followUp.status} bytes=${followUpText.length} body=${followUpText.slice(0, 300)} retryAfter=${followUp.headers.get("retry-after")}`)
          expect(followUp.status).toBe(200)
        }),
      ))
    }),
    60_000,
  )
})
