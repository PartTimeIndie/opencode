// Test-owned EffectFlock lock holder for the Bootstrap-503 active-wait HTTP
// repro. Holds ONE real lock key (npm-install:<install-dir>) inside a child
// Bun process so the server under test blocks on the genuine flock boundary
// while the parent synchronizes on marker files.
//
// Input is ALWAYS JSON in argv[2]: { key, dir, holdMs?, ready?, active?,
// release?, done? }. `dir` is the locks ROOT — the caller passes its own
// test-owned <Global.Path.state>/locks so child and server resolve the exact
// same lock files. Under `bun test` the preload redirects XDG_STATE_HOME for
// the whole process tree, so this root is fresh and never live user state.
//
// Lifecycle contract (no wedged locks, no live state touched):
// - The parent owns every temp dir and marker file; this process only
//   creates and removes its own marker files. It never removes `dir`.
// - Ready file: written after the lock is HELD (not merely requested).
// - Active file: exclusive-created while held, removed in the hold job's
//   finally. That finally only runs on the NORMAL exit path.
// - Graceful release: the parent writes the `release` marker file; the hold
//   loop polls for it, then finishes, so withLock's scope closes and the
//   REAL EffectFlock release finalizer removes the lock dir before exit.
// - holdMs bounds the hold loop when no release marker ever arrives.
// - Hard kill does NOT run JS finalizers: a killed holder leaves the lock
//   dir behind and recovery is the flock's own stale-breaker path, never JS
//   cleanup. The parent must therefore treat kill strictly as a bounded
//   emergency fallback, await process exit either way, and clean up its own
//   scope afterwards.
import fs from "fs/promises"
import { Effect, Layer } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Global } from "@opencode-ai/core/global"
import os from "os"

type Msg = {
  key: string
  dir: string
  holdMs?: number
  ready?: string
  active?: string
  release?: string
  done?: string
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

function exists(file: string) {
  return fs.stat(file).then(
    () => true,
    () => false,
  )
}

const msg: Msg = JSON.parse(process.argv[2])

// Test-isolated Global: every root is either the real homedir (read-only
// lookups) or a parent-owned dir. The explicit `dir` argument to withLock
// below bypasses this state root entirely, so the only contract that
// matters is: parent's locks root === server's locks root.
const testGlobal = Global.layerWith({
  home: os.homedir(),
  data: os.tmpdir(),
  cache: os.tmpdir(),
  config: os.tmpdir(),
  state: msg.dir,
  bin: os.tmpdir(),
  log: os.tmpdir(),
})

const testLayer = EffectFlock.layer.pipe(Layer.provide(testGlobal), Layer.provide(FSUtil.defaultLayer))

async function job() {
  if (msg.ready) await fs.writeFile(msg.ready, String(process.pid))
  if (msg.active) await fs.writeFile(msg.active, String(process.pid), { flag: "wx" })

  try {
    const holdMs = msg.holdMs && msg.holdMs > 0 ? msg.holdMs : 120_000
    const deadline = Date.now() + holdMs
    while (msg.release && !(await exists(msg.release))) {
      if (Date.now() >= deadline) break
      await sleep(25)
    }
    if (msg.done) await fs.appendFile(msg.done, `${process.pid}\n`)
  } finally {
    if (msg.active) await fs.rm(msg.active, { force: true })
  }
}

await Effect.runPromise(
  Effect.gen(function* () {
    const flock = yield* EffectFlock.Service
    yield* flock.withLock(Effect.promise(() => job()), msg.key, msg.dir)
  }).pipe(Effect.provide(testLayer)),
).catch((err) => {
  const text = err instanceof Error ? (err.stack ?? err.message) : String(err)
  process.stderr.write(text)
  process.exit(1)
})
