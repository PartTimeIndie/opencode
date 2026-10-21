import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import { spawn } from "child_process"
import { Worker } from "worker_threads"
import path from "path"
import os from "os"
import { Flock } from "@opencode-ai/core/util/flock"
import { Hash } from "@opencode-ai/core/util/hash"

type Msg = {
  key: string
  dir: string
  staleMs?: number
  timeoutMs?: number
  baseDelayMs?: number
  maxDelayMs?: number
  holdMs?: number
  blockEventLoopMs?: number
  processScoped?: boolean
  ready?: string
  active?: string
  done?: string
}

const root = path.join(import.meta.dir, "../..")
const worker = path.join(import.meta.dir, "../fixture/flock-worker.ts")
const isolateWorker = path.join(import.meta.dir, "../fixture/flock-isolate-worker.ts")

async function tmpdir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flock-test-"))
  return {
    path: dir,
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
}

function lock(dir: string, key: string) {
  return path.join(dir, Hash.fast(key) + ".lock")
}

function transition(dir: string, key: string, epoch: number) {
  return path.join(`${lock(dir, key)}.transitions`, `epoch-${String(epoch).padStart(20, "0")}`)
}

function transitionClaim(dir: string, key: string, epoch: number) {
  return transition(dir, key, epoch) + ".claim"
}

function transitionEpochs(entries: string[]) {
  return entries.flatMap((entry) => {
    const match = /^epoch-(\d{20})\.claim$/.exec(entry)
    return match ? [BigInt(match[1])] : []
  })
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function exists(file: string) {
  return fs
    .stat(file)
    .then(() => true)
    .catch(() => false)
}

async function wait(file: string, timeout = 3_000) {
  const stop = Date.now() + timeout
  while (Date.now() < stop) {
    if (await exists(file)) return
    await sleep(20)
  }

  throw new Error(`Timed out waiting for file: ${file}`)
}

function run(msg: Msg) {
  return new Promise<{ code: number; stdout: Buffer; stderr: Buffer }>((resolve) => {
    const proc = spawn(process.execPath, [worker, JSON.stringify(msg)], {
      cwd: root,
    })

    const stdout: Buffer[] = []
    const stderr: Buffer[] = []

    proc.stdout?.on("data", (data) => stdout.push(Buffer.from(data)))
    proc.stderr?.on("data", (data) => stderr.push(Buffer.from(data)))

    proc.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      })
    })
  })
}

function spawnWorker(msg: Msg) {
  return spawn(process.execPath, [worker, JSON.stringify(msg)], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  })
}

async function stopWorker(proc: ReturnType<typeof spawn>) {
  if (proc.exitCode !== null || proc.signalCode !== null) return

  const closed = new Promise<void>((resolve) => proc.once("close", () => resolve()))

  if (process.platform !== "win32" || !proc.pid) {
    proc.kill()
    await closed
    return
  }

  await new Promise<void>((resolve) => {
    const killProc = spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"])
    killProc.on("close", () => {
      proc.kill()
      resolve()
    })
  })
  await closed
}

async function readJson<T>(p: string): Promise<T> {
  return JSON.parse(await fs.readFile(p, "utf8"))
}

describe("util.flock", () => {
  test("does not expose ownership assertions on the generic lease API", () => {
    expect("withLease" in Flock).toBe(false)
    const invalid = () =>
      Flock.acquire("unused", {
        // @ts-expect-error Process-scoped ownership is only available through withProcessLock.
        processScoped: true,
      })
    expect(typeof invalid).toBe("function")
  })

  test("enforces mutual exclusion under process contention", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const done = path.join(tmp.path, "done.log")
    const active = path.join(tmp.path, "active")
    const key = "flock:stress"
    const n = 16

    const out = await Promise.all(
      Array.from({ length: n }, () =>
        run({
          key,
          dir,
          done,
          active,
          holdMs: 30,
          staleMs: 1_000,
          timeoutMs: 15_000,
        }),
      ),
    )

    expect(out.map((x) => x.code)).toEqual(Array.from({ length: n }, () => 0))
    expect(out.map((x) => x.stderr.toString()).filter(Boolean)).toEqual([])

    const lines = (await fs.readFile(done, "utf8"))
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean)
    expect(lines.length).toBe(n)
    const claims = (await fs.readdir(`${lock(dir, key)}.transitions`)).filter((entry) => entry.endsWith(".claim"))
    const owners = await Promise.all(
      claims.map((entry) => readJson<{ token?: string }>(path.join(`${lock(dir, key)}.transitions`, entry))),
    )
    expect(owners.every((owner) => typeof owner.token === "string" && owner.token.length > 0)).toBe(true)
  }, 20_000)

  test("times out while waiting when lock is still healthy", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:timeout"
    const ready = path.join(tmp.path, "ready")
    const proc = spawnWorker({
      key,
      dir,
      ready,
      holdMs: 20_000,
      staleMs: 10_000,
      timeoutMs: 30_000,
    })

    try {
      await wait(ready, 5_000)
      const seen: string[] = []
      const started = performance.now()
      const err = await Flock.withLock(key, async () => {}, {
        dir,
        staleMs: 10_000,
        timeoutMs: 1_000,
        onWait: async (tick) => {
          seen.push(tick.key)
          await sleep(5_000)
        },
      }).catch((err) => err)

      expect(err).toBeInstanceOf(Error)
      if (!(err instanceof Error)) throw err
      expect(err.message).toContain("Timed out waiting for lock")
      expect(seen.length).toBeGreaterThan(0)
      expect(seen.every((x) => x === key)).toBe(true)
      expect(performance.now() - started).toBeLessThan(1_500)
    } finally {
      await stopWorker(proc).catch(() => undefined)
    }
  }, 15_000)

  test("reclamps backoff after onWait consumes most of the deadline", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:partial-deadline"
    const ready = path.join(tmp.path, "ready")
    const proc = spawnWorker({ key, dir, ready, holdMs: 20_000, staleMs: 10_000, timeoutMs: 30_000 })

    try {
      await wait(ready, 5_000)
      const started = performance.now()
      const err = await Flock.withLock(key, async () => {}, {
        dir,
        staleMs: 10_000,
        timeoutMs: 800,
        baseDelayMs: 1_000,
        maxDelayMs: 1_000,
        onWait: () => sleep(500),
      }).catch((error: unknown) => error)
      expect(err).toBeInstanceOf(Error)
      expect(performance.now() - started).toBeLessThan(1_100)
    } finally {
      await stopWorker(proc).catch(() => undefined)
    }
  }, 15_000)

  test("propagates onWait rejection and aborts a timed-out callback", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:on-wait-cancel"
    const ready = path.join(tmp.path, "ready")
    const proc = spawnWorker({ key, dir, ready, holdMs: 20_000, staleMs: 10_000, timeoutMs: 30_000 })

    try {
      await wait(ready, 5_000)
      const rejected = new Error("onWait rejected")
      expect(
        await Flock.withLock(key, async () => {}, {
          dir,
          staleMs: 10_000,
          timeoutMs: 1_000,
          onWait: () => Promise.reject(rejected),
        }).catch((error: unknown) => error),
      ).toBe(rejected)

      let aborted = false
      const timedOut = await Flock.withLock(key, async () => {}, {
        dir,
        staleMs: 10_000,
        timeoutMs: 200,
        onWait: ({ signal }) =>
          new Promise<void>((_, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                aborted = true
                reject(signal.reason)
              },
              { once: true },
            )
          }),
      }).catch((error: unknown) => error)
      expect(timedOut).toBeInstanceOf(Error)
      expect(aborted).toBe(true)
    } finally {
      await stopWorker(proc).catch(() => undefined)
    }
  }, 15_000)

  test("recovers after a crashed lock owner", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:crash"
    const ready = path.join(tmp.path, "ready")
    const proc = spawnWorker({
      key,
      dir,
      ready,
      holdMs: 20_000,
      staleMs: 500,
      timeoutMs: 30_000,
    })

    await wait(ready, 5_000)
    await stopWorker(proc)

    let hit = false
    await Flock.withLock(
      key,
      async () => {
        hit = true
      },
      {
        dir,
        staleMs: 500,
        timeoutMs: 8_000,
      },
    )

    expect(hit).toBe(true)
  }, 20_000)

  test("recovers a crashed process-scoped owner before its heartbeat becomes stale", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:process-crash"
    const ready = path.join(tmp.path, "ready")
    const proc = spawnWorker({
      key,
      dir,
      ready,
      holdMs: 20_000,
      processScoped: true,
      staleMs: 30_000,
      timeoutMs: 40_000,
    })

    await wait(ready, 5_000)
    await stopWorker(proc)

    let hit = false
    await Flock.withProcessLock(
      key,
      async (lease) => {
        await lease.assertOwned()
        hit = true
      },
      {
        dir,
        staleMs: 30_000,
        timeoutMs: 2_000,
        baseDelayMs: 10,
        maxDelayMs: 50,
      },
    )
    expect(hit).toBe(true)
  }, 15_000)

  test("does not confuse a reused live PID with the recorded process instance", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:pid-reuse"
    const lockDir = lock(dir, key)
    const proc = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20_000)"], { stdio: "ignore" })
    if (!proc.pid) throw new Error("PID reuse fixture did not start")

    try {
      await fs.mkdir(lockDir, { recursive: true })
      await fs.writeFile(path.join(lockDir, "heartbeat"), "")
      await fs.writeFile(
        path.join(lockDir, "meta.json"),
        JSON.stringify({
          token: "crashed-process-instance",
          pid: proc.pid,
          hostname: os.hostname(),
          processStart: "different-process-start",
        }),
      )
      const expired = new Date(Date.now() - 60_000)
      await fs.utimes(path.join(lockDir, "heartbeat"), expired, expired)

      let hit = false
      await Flock.withProcessLock(
        key,
        async (lease) => {
          await lease.assertOwned()
          hit = true
        },
        {
          dir,
          staleMs: 30_000,
          timeoutMs: 2_000,
          baseDelayMs: 10,
          maxDelayMs: 50,
        },
      )
      expect(hit).toBe(true)
    } finally {
      await stopWorker(proc)
    }
  }, 15_000)

  test("keeps a live process-scoped owner through a stopped heartbeat", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:process-suspend"
    const ready = path.join(tmp.path, "ready")
    const owner = run({
      key,
      dir,
      ready,
      blockEventLoopMs: 1_500,
      processScoped: true,
      staleMs: 200,
      timeoutMs: 5_000,
    })

    await wait(ready, 5_000)
    await sleep(300)
    const contender = await Flock.withProcessLock(key, async () => {}, {
      dir,
      staleMs: 200,
      timeoutMs: 500,
      baseDelayMs: 10,
      maxDelayMs: 25,
    }).catch((err) => err)
    expect(contender).toBeInstanceOf(Error)
    if (!(contender instanceof Error)) throw contender
    expect(contender.message).toContain("Timed out waiting for lock")
    expect((await owner).code).toBe(0)
  }, 15_000)

  test("keeps a process-scoped owner across same-PID module isolates", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:same-pid-isolate"
    const result = await Flock.withProcessLock(
      key,
      async () => {
        const expired = new Date(Date.now() - 10 * 60_000)
        await fs.utimes(path.join(lock(dir, key), "heartbeat"), expired, expired)
        const child = new Worker(isolateWorker, {
          workerData: { key, dir, staleMs: 200, timeoutMs: 500 },
        })
        try {
          return await new Promise<string>((resolve, reject) => {
            child.once("message", (value) => resolve(String(value)))
            child.once("error", reject)
          })
        } finally {
          await child.terminate()
        }
      },
      { dir, staleMs: 10_000, timeoutMs: 2_000 },
    )
    expect(result).toContain("Timed out waiting for lock")
  }, 15_000)

  test("keeps live process-scoped owners fail-closed when process identity metadata is missing or malformed", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    for (const [name, processStart] of [
      ["missing", undefined],
      ["malformed", 42],
    ] as const) {
      const key = `flock:legacy-process-owner-${name}`
      const lockDir = lock(dir, key)
      await fs.mkdir(lockDir, { recursive: true })
      await fs.writeFile(path.join(lockDir, "heartbeat"), "")
      await fs.writeFile(
        path.join(lockDir, "meta.json"),
        JSON.stringify({ token: "legacy", pid: process.pid, hostname: os.hostname(), processStart }),
      )
      const old = new Date(Date.now() - 10 * 60_000)
      await fs.utimes(path.join(lockDir, "heartbeat"), old, old)

      const result = await Flock.withProcessLock(key, async () => "acquired", {
        dir,
        staleMs: 200,
        timeoutMs: 300,
        baseDelayMs: 10,
        maxDelayMs: 25,
      }).catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
      expect(result).toContain("Timed out waiting for lock")
      expect((await readJson<{ token: string }>(path.join(lockDir, "meta.json"))).token).toBe("legacy")
    }
  })

  test("detects ownership loss before rename and never retires the replacement", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:replacement-window"
    const lockDir = lock(dir, key)
    const displaced = lockDir + ".displaced"
    const err = await Flock.withProcessLock(
      key,
      async (lease) => {
        await lease.assertOwned()
        await fs.rename(lockDir, displaced)
        await fs.mkdir(lockDir)
        await fs.writeFile(path.join(lockDir, "heartbeat"), "")
        await fs.writeFile(
          path.join(lockDir, "meta.json"),
          JSON.stringify({ token: "replacement", pid: process.pid, hostname: os.hostname() }),
        )
      },
      { dir, staleMs: 30_000, timeoutMs: 2_000 },
    ).catch((err) => err)

    expect(err).toBeInstanceOf(Error)
    expect((await readJson<{ token: string }>(path.join(lockDir, "meta.json"))).token).toBe("replacement")
    expect(await exists(displaced)).toBe(true)
  })

  test("breaks stale lock dirs when heartbeat is missing", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:missing-heartbeat"
    const lockDir = lock(dir, key)

    await fs.mkdir(lockDir, { recursive: true })
    const old = new Date(Date.now() - 2_000)
    await fs.utimes(lockDir, old, old)

    let hit = false
    await Flock.withLock(
      key,
      async () => {
        hit = true
      },
      {
        dir,
        staleMs: 200,
        timeoutMs: 3_000,
      },
    )

    expect(hit).toBe(true)
  })

  test("supersedes a stale transition epoch without reusing its path", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:stale-transition"
    const lockDir = lock(dir, key)
    const previous = transition(dir, key, 1)

    await fs.mkdir(lockDir, { recursive: true })
    await fs.mkdir(previous, { recursive: true })

    const old = new Date(Date.now() - 2_000)
    await fs.utimes(lockDir, old, old)
    await fs.utimes(previous, old, old)

    let hit = false
    await Flock.withLock(
      key,
      async () => {
        hit = true
      },
      {
        dir,
        staleMs: 200,
        timeoutMs: 3_000,
      },
    )

    expect(hit).toBe(true)
    expect(await exists(previous)).toBe(true)
    expect(await fs.readdir(`${lockDir}.transitions`)).toEqual([
      "epoch-00000000000000000001",
      "epoch-00000000000000000002",
      "epoch-00000000000000000002.claim",
      "epoch-00000000000000000002.released",
      "epoch-00000000000000000003",
      "epoch-00000000000000000003.claim",
      "epoch-00000000000000000003.released",
    ])
  })

  test("a new transition barrier wins against legacy epoch directories", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:new-transition-barrier"
    const lease = await Flock.acquire(key, { dir, staleMs: 1_000, timeoutMs: 2_000 })
    try {
      expect((await fs.stat(transition(dir, key, 1))).isFile()).toBe(true)
      const legacy = await fs
        .mkdir(transition(dir, key, 1))
        .then(() => "created")
        .catch((error: NodeJS.ErrnoException) => error.code)
      expect(legacy).toBe("EEXIST")
    } finally {
      await lease.release()
    }
  })

  test("a legacy directory that wins the publish race makes the new claimant retry", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:legacy-transition-race"
    let raced = false
    let entered = false

    await Flock.withLock(
      key,
      async () => {
        entered = true
      },
      {
        dir,
        staleMs: 100,
        timeoutMs: 2_000,
        baseDelayMs: 5,
        maxDelayMs: 20,
        onTransition: async (event) => {
          if (raced || event.phase !== "beforePublish" || event.epoch !== 1n) return
          raced = true
          await fs.mkdir(transition(dir, key, 1))
          await fs.writeFile(path.join(transition(dir, key, 1), "released"), "")
        },
      },
    )

    expect(entered).toBe(true)
    expect((await fs.stat(transition(dir, key, 1))).isDirectory()).toBe(true)
    expect(await exists(transitionClaim(dir, key, 1))).toBe(false)
    expect((await fs.stat(transition(dir, key, 2))).isFile()).toBe(true)
  })

  test("a permanent barrier blocks a restarted legacy client", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:legacy-restart-barrier"

    await Flock.withLock(key, async () => {}, { dir, staleMs: 100, timeoutMs: 2_000 })
    for (const _ of [0, 1]) {
      const legacy = await fs
        .mkdir(transition(dir, key, 1))
        .then(() => "created")
        .catch((error: NodeJS.ErrnoException) => error.code)
      expect(legacy).toBe("EEXIST")
    }
    expect((await fs.stat(transition(dir, key, 1))).isFile()).toBe(true)
  })

  test("backfills a permanent barrier for claims from an older client", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:legacy-claim-upgrade"
    const root = `${lock(dir, key)}.transitions`
    const owner = JSON.stringify({ token: "legacy-claim", pid: 2_147_483_647, hostname: os.hostname() })
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(transitionClaim(dir, key, 1), owner)
    await fs.writeFile(`${transition(dir, key, 1)}.released`, JSON.stringify({ token: "legacy-claim", outcome: "released" }))

    await Flock.transitionJournalStatus(key, { dir })
    expect((await fs.stat(transition(dir, key, 1))).isFile()).toBe(true)
    expect(await fs.readFile(transition(dir, key, 1), "utf8")).toBe(owner)
    const legacy = await fs
      .mkdir(transition(dir, key, 1))
      .then(() => "created")
      .catch((error: NodeJS.ErrnoException) => error.code)
    expect(legacy).toBe("EEXIST")
  })

  test("fails closed when an epoch has legacy and claim representations", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:duplicate-transition-representation"
    const root = `${lock(dir, key)}.transitions`
    await fs.mkdir(transition(dir, key, 1), { recursive: true })
    await fs.writeFile(
      transitionClaim(dir, key, 1),
      JSON.stringify({ token: "duplicate", pid: process.pid, hostname: os.hostname() }),
    )

    const error = await Flock.transitionJournalStatus(key, { dir }).catch((value: unknown) => value)
    expect(error).toBeInstanceOf(Error)
    if (!(error instanceof Error)) throw error
    expect(error.message).toContain("both legacy and claim representations")
    expect(await fs.readdir(root)).toEqual([
      "epoch-00000000000000000001",
      "epoch-00000000000000000001.claim",
    ])
  })

  test("keeps an old legacy transition when its live PID identity is unavailable", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:legacy-transition-pid-reuse"
    const lockDir = lock(dir, key)
    const previous = transition(dir, key, 1)
    const reused = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20_000)"], { stdio: "ignore" })
    if (!reused.pid) throw new Error("PID reuse fixture did not start")

    try {
      await fs.mkdir(lockDir, { recursive: true })
      await fs.mkdir(previous, { recursive: true })
      await fs.writeFile(
        path.join(previous, "meta.json"),
        JSON.stringify({ token: "legacy-transition", pid: reused.pid, hostname: os.hostname() }),
      )
      const old = new Date(Date.now() - 10 * 60_000)
      await fs.utimes(lockDir, old, old)
      await fs.utimes(path.join(previous, "meta.json"), old, old)
      await fs.utimes(previous, old, old)

      const contender = await Flock.withLock(key, async () => {}, {
        dir,
        staleMs: 200,
        timeoutMs: 400,
        baseDelayMs: 10,
        maxDelayMs: 25,
      }).catch((error: unknown) => error)
      expect(contender).toBeInstanceOf(Error)
      expect(await exists(previous)).toBe(true)
      expect(await fs.readdir(`${lockDir}.transitions`)).toEqual(["epoch-00000000000000000001"])
    } finally {
      await stopWorker(reused)
    }
  }, 15_000)

  test("a delayed selector cannot recreate epoch B or displace live epoch C", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const ownerKey = "flock:delayed-selector-owner"
    const key = "flock:delayed-selector"
    const lockDir = lock(dir, key)
    const delayed = transition(dir, key, 2)

    await Flock.withProcessLock(
      ownerKey,
      async () => {
        const owner = await fs.readFile(path.join(lock(dir, ownerKey), "meta.json"), "utf8")
        await fs.mkdir(lockDir, { recursive: true })
        await fs.mkdir(transition(dir, key, 1), { recursive: true })
        await fs.writeFile(path.join(transition(dir, key, 1), "released"), "")
        await fs.mkdir(delayed)
        await fs.writeFile(path.join(delayed, "released"), "")
        await fs.mkdir(transition(dir, key, 3))
        await fs.writeFile(path.join(transition(dir, key, 3), "meta.json"), owner)
        const old = new Date(Date.now() - 10 * 60_000)
        await fs.utimes(lockDir, old, old)
        await fs.utimes(path.join(transition(dir, key, 3), "meta.json"), old, old)
        await fs.utimes(transition(dir, key, 3), old, old)

        const delayedResult = await fs
          .mkdir(delayed)
          .then(() => "created")
          .catch((error: NodeJS.ErrnoException) => error.code)
        expect(delayedResult).toBe("EEXIST")
        const contender = await Flock.withLock(key, async () => {}, {
          dir,
          staleMs: 200,
          timeoutMs: 400,
          baseDelayMs: 10,
          maxDelayMs: 25,
        }).catch((error: unknown) => error)
        expect(contender).toBeInstanceOf(Error)
        expect(await fs.readdir(`${lockDir}.transitions`)).toEqual([
          "epoch-00000000000000000001",
          "epoch-00000000000000000002",
          "epoch-00000000000000000003",
        ])
      },
      { dir, staleMs: 30_000, timeoutMs: 2_000 },
    )
  })

  test("a contender paused before atomic publish loses to B and cannot enter live C", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:pause-before-publish"
    const selected = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const cReady = Promise.withResolvers<void>()
    const releaseC = Promise.withResolvers<void>()
    let aEntered = false
    let paused = false

    const a = Flock.withLock(
      key,
      async () => {
        aEntered = true
      },
      {
        dir,
        staleMs: 1_000,
        timeoutMs: 2_000,
        baseDelayMs: 5,
        maxDelayMs: 20,
        onTransition: async (event) => {
          if (paused || event.phase !== "beforePublish" || event.epoch !== 1n) return
          paused = true
          selected.resolve()
          await resume.promise
        },
      },
    ).catch((error: unknown) => error)

    await selected.promise
    await Flock.withLock(key, async () => {}, { dir, staleMs: 100, timeoutMs: 2_000 })
    const c = Flock.withLock(
      key,
      async () => {
        cReady.resolve()
        await releaseC.promise
      },
      { dir, staleMs: 100, timeoutMs: 2_000 },
    )
    await cReady.promise
    resume.resolve()
    const aResult = await a
    expect(aResult).toBeInstanceOf(Error)
    expect(aEntered).toBe(false)
    expect(await readJson<{ token: string }>(transitionClaim(dir, key, 1))).toHaveProperty("token")
    expect(await readJson<{ token: string }>(transitionClaim(dir, key, 3))).toHaveProperty("token")
    releaseC.resolve()
    await c
  })

  test("a fully published generic transition stays fenced while its live owner is paused", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:pause-after-publish"
    const published = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    let entered = false

    const owner = Flock.withLock(
      key,
      async () => {
        entered = true
      },
      {
        dir,
        staleMs: 20,
        timeoutMs: 2_000,
        baseDelayMs: 5,
        maxDelayMs: 20,
        onTransition: async (event) => {
          if (event.phase !== "afterPublish" || event.epoch !== 1n) return
          published.resolve()
          await resume.promise
        },
      },
    )

    await published.promise
    const claim = await readJson<{ processStart?: string }>(transitionClaim(dir, key, 1))
    expect(typeof claim.processStart).toBe("string")
    const contender = await Flock.withLock(key, async () => {}, {
      dir,
      staleMs: 20,
      timeoutMs: 300,
      baseDelayMs: 5,
      maxDelayMs: 20,
    }).catch((error: unknown) => error)
    expect(contender).toBeInstanceOf(Error)
    expect(entered).toBe(false)
    resume.resolve()
    await owner
    expect(entered).toBe(true)
  })

  test("post-publish validation rejects a claim when a higher epoch appears", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:post-publish-higher-epoch"
    let entered = false
    let injected = false

    const result = await Flock.withLock(
      key,
      async () => {
        entered = true
      },
      {
        dir,
        staleMs: 100,
        timeoutMs: 300,
        baseDelayMs: 5,
        maxDelayMs: 20,
        onTransition: async (event) => {
          if (injected || event.phase !== "afterPublish" || event.epoch !== 1n) return
          injected = true
          const current = await fs.readFile(transitionClaim(dir, key, 1), "utf8")
          await fs.writeFile(transitionClaim(dir, key, 2), current, { flag: "wx" })
        },
      },
    ).catch((error: unknown) => error)

    expect(result).toBeInstanceOf(Error)
    expect(entered).toBe(false)
    expect(await exists(`${transition(dir, key, 1)}.released`)).toBe(true)
    expect(await exists(transitionClaim(dir, key, 2))).toBe(true)
  })

  test("an offline floor rejects a delayed old publish without runtime cleanup", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:floor-delayed-publish"
    const ownerKey = "flock:floor-live-owner"
    const selected = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const republished = Promise.withResolvers<void>()
    const cancel = new AbortController()
    let delayedEntered = false
    let paused = false

    const delayed = Flock.withLock(
      key,
      async () => {
        delayedEntered = true
      },
      {
        dir,
        staleMs: 1_000,
        timeoutMs: 15_000,
        baseDelayMs: 5,
        maxDelayMs: 20,
        signal: cancel.signal,
        onTransition: async (event) => {
          if (event.phase === "afterPublish" && event.epoch === 1n) republished.resolve()
          if (paused || event.phase !== "beforePublish" || event.epoch !== 1n) return
          paused = true
          selected.resolve()
          await resume.promise
        },
      },
    ).catch((error: unknown) => error)

    await selected.promise
    const root = `${lock(dir, key)}.transitions`
    await Flock.withProcessLock(
      ownerKey,
      async () => {
        await fs.writeFile(
          path.join(root, "floor-00000000000000000256"),
          JSON.stringify({ floor: "256", createdAt: new Date().toISOString() }),
        )
        await fs.writeFile(
          transitionClaim(dir, key, 257),
          await fs.readFile(path.join(lock(dir, ownerKey), "meta.json")),
        )

        resume.resolve()
        await republished.promise
        await sleep(50)
        cancel.abort(new Error("Delayed floor claimant test completed"))
        const delayedResult = await delayed
        expect(delayedResult).toBeInstanceOf(Error)
        expect(delayedEntered).toBe(false)
        expect(await exists(transitionClaim(dir, key, 1))).toBe(true)
        expect(await exists(transitionClaim(dir, key, 257))).toBe(true)
        expect((await fs.readdir(root)).sort()).toEqual([
          "epoch-00000000000000000001",
          "epoch-00000000000000000001.claim",
          "epoch-00000000000000000001.released",
          "epoch-00000000000000000257",
          "epoch-00000000000000000257.claim",
          "floor-00000000000000000256",
        ])
      },
      { dir, staleMs: 30_000, timeoutMs: 2_000 },
    )
  })

  test("keeps historical journal payload reads off the transition hot path", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:bounded-journal-read"
    const root = `${lock(dir, key)}.transitions`
    await fs.mkdir(root, { recursive: true })
    for (const epoch of Array.from({ length: 256 }, (_, index) => index + 1)) {
      const token = `transition-${epoch}`
      await fs.writeFile(transitionClaim(dir, key, epoch), JSON.stringify({ token }))
      await fs.link(transitionClaim(dir, key, epoch), transition(dir, key, epoch))
      await fs.writeFile(`${transition(dir, key, epoch)}.released`, JSON.stringify({ token, outcome: "released" }))
    }

    expect(await Flock.transitionJournalStatus(key, { dir })).toEqual({
      directory: root,
      entries: 768,
      claims: 256,
      completions: 256,
      legacy: 0,
      floors: 0,
      temporary: 0,
      floor: "0",
      latestEpoch: "256",
    })

    // A higher valid epoch proves these retired barriers were crossed. Their permanent directory entries still
    // fence old clients, but current clients must not reopen every historical payload during each transition.
    await fs.writeFile(transitionClaim(dir, key, 128), "{}")
    await Flock.withLock(key, async () => {}, { dir, staleMs: 100, timeoutMs: 2_000 })
    expect(await exists(transitionClaim(dir, key, 257))).toBe(true)
    expect(await exists(transitionClaim(dir, key, 258))).toBe(true)

    const audit = await Flock.transitionJournalStatus(key, { dir }).catch((error: unknown) => error)
    expect(audit).toBeInstanceOf(Error)
    if (!(audit instanceof Error)) throw audit
    expect(audit.message).toContain("claim and barrier owners do not match")
  })

  test("ignores corrupt journal names and reports explicit epoch exhaustion", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:corrupt-journal-names"
    const root = `${lock(dir, key)}.transitions`
    await fs.mkdir(root, { recursive: true })
    await Promise.all(
      ["epoch-nope.claim", "epoch-00000000000000000001.claim.extra", "floor-bad", ".claim-orphan.tmp"].map((entry) =>
        fs.writeFile(path.join(root, entry), "corrupt"),
      ),
    )
    await Flock.withLock(key, async () => {}, { dir, staleMs: 100, timeoutMs: 2_000 })
    expect(await exists(transitionClaim(dir, key, 1))).toBe(true)

    const exhaustedKey = "flock:epoch-exhausted"
    const exhaustedRoot = `${lock(dir, exhaustedKey)}.transitions`
    await fs.mkdir(exhaustedRoot, { recursive: true })
    await fs.writeFile(
      path.join(exhaustedRoot, "epoch-99999999999999999999.claim"),
      JSON.stringify({ token: "max", pid: 2_147_483_647, hostname: os.hostname(), processStart: "gone" }),
    )
    await fs.writeFile(
      path.join(exhaustedRoot, "epoch-99999999999999999999.released"),
      JSON.stringify({ token: "max", outcome: "released" }),
    )
    const error = await Flock.withLock(exhaustedKey, async () => {}, {
      dir,
      staleMs: 100,
      timeoutMs: 300,
    }).catch((value: unknown) => value)
    expect(error).toBeInstanceOf(Error)
    if (!(error instanceof Error)) throw error
    expect(error.message).toContain("journal exhausted")
    expect(error.message).toContain("offline maintenance")

    const malformedKey = "flock:malformed-highest-claim"
    const malformedRoot = `${lock(dir, malformedKey)}.transitions`
    await fs.mkdir(malformedRoot, { recursive: true })
    await fs.writeFile(path.join(malformedRoot, "epoch-00000000000000000001.claim"), "{}")
    const malformed = await Flock.withLock(malformedKey, async () => {}, {
      dir,
      staleMs: 10,
      timeoutMs: 100,
      baseDelayMs: 5,
      maxDelayMs: 20,
    }).catch((value: unknown) => value)
    expect(malformed).toBeInstanceOf(Error)

    const corruptFloorKey = "flock:corrupt-floor"
    const corruptFloorRoot = `${lock(dir, corruptFloorKey)}.transitions`
    await fs.mkdir(corruptFloorRoot, { recursive: true })
    await fs.writeFile(path.join(corruptFloorRoot, "floor-00000000000000000001"), "{}")
    const corruptFloor = await Flock.withLock(corruptFloorKey, async () => {}, {
      dir,
      staleMs: 10,
      timeoutMs: 100,
    }).catch((value: unknown) => value)
    expect(corruptFloor).toBeInstanceOf(Error)
    if (!(corruptFloor instanceof Error)) throw corruptFloor
    expect(corruptFloor.message).toContain("corrupt floor marker")
  })

  test("serializes two reapers across monotonic A-to-B-to-C transition epochs", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:reap-release-race"
    let previousEpoch = 0n
    for (const _ of Array.from({ length: 6 })) {
      const owner = await Flock.acquire(key, {
        dir,
        staleMs: 30_000,
        timeoutMs: 2_000,
        baseDelayMs: 5,
        maxDelayMs: 20,
      })
      const old = new Date(Date.now() - 60_000)
      await fs.utimes(path.join(lock(dir, key), "heartbeat"), old, old)
      let entered = 0
      const contender = () =>
        Flock.withProcessLock(
          key,
          async () => {
            entered += 1
            await sleep(5)
          },
          { dir, staleMs: 10, timeoutMs: 5_000, baseDelayMs: 5, maxDelayMs: 20 },
        )
      const [first, second, releaseResult] = await Promise.all([
        contender().catch((error: unknown) => error),
        contender().catch((error: unknown) => error),
        owner.release().catch((error: unknown) => error),
      ])
      const unexpected = [first, second].filter((result): result is Error => result instanceof Error)
      if (unexpected.length > 0) {
        throw new Error(
          JSON.stringify({
            first: first instanceof Error ? first.message : "completed",
            second: second instanceof Error ? second.message : "completed",
            release: releaseResult instanceof Error ? releaseResult.message : "released",
            entries: await fs.readdir(dir),
          }),
        )
      }
      expect(entered).toBe(2)
      expect((await fs.readdir(dir)).filter((entry) => entry.includes(".retired-")).length).toBe(0)
      const values = transitionEpochs(await fs.readdir(`${lock(dir, key)}.transitions`)).sort((a, b) =>
        a < b ? -1 : a > b ? 1 : 0,
      )
      expect(new Set(values).size).toBe(values.length)
      expect(values).toEqual(Array.from({ length: values.length }, (_, index) => BigInt(index + 1)))
      const epoch = values.at(-1) ?? 0n
      expect(epoch).toBeGreaterThan(previousEpoch)
      previousEpoch = epoch
    }
  }, 20_000)

  test("does not supersede an old transition owned by the same live process instance", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const ownerKey = "flock:transition-owner"
    const key = "flock:live-transition"
    const ready = path.join(tmp.path, "ready")
    const lockDir = lock(dir, key)
    const current = transition(dir, key, 1)
    const owner = run({
      key: ownerKey,
      dir,
      ready,
      holdMs: 1_500,
      processScoped: true,
      staleMs: 200,
      timeoutMs: 5_000,
    })

    await wait(ready, 5_000)
    const ownerMeta = await fs.readFile(path.join(lock(dir, ownerKey), "meta.json"), "utf8")
    await fs.mkdir(lockDir, { recursive: true })
    await fs.mkdir(current, { recursive: true })
    await fs.writeFile(path.join(current, "meta.json"), ownerMeta)
    const expired = new Date(Date.now() - 10 * 60_000)
    await fs.utimes(lockDir, expired, expired)
    await fs.utimes(path.join(current, "meta.json"), expired, expired)
    await fs.utimes(current, expired, expired)

    const contender = await Flock.withLock(key, async () => {}, {
      dir,
      staleMs: 200,
      timeoutMs: 500,
      baseDelayMs: 10,
      maxDelayMs: 25,
    }).catch((err) => err)
    expect(contender).toBeInstanceOf(Error)
    if (!(contender instanceof Error)) throw contender
    expect(contender.message).toContain("Timed out waiting for lock")
    expect(await exists(current)).toBe(true)
    expect((await owner).code).toBe(0)

    let hit = false
    await Flock.withLock(
      key,
      async () => {
        hit = true
      },
      { dir, staleMs: 200, timeoutMs: 2_000, baseDelayMs: 10, maxDelayMs: 25 },
    )
    expect(hit).toBe(true)
  }, 15_000)

  test("fails clearly if lock dir is removed while held", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:compromised"
    const lockDir = lock(dir, key)

    const err = await Flock.withLock(
      key,
      async () => {
        await fs.rm(lockDir, {
          recursive: true,
          force: true,
        })
      },
      {
        dir,
        staleMs: 1_000,
        timeoutMs: 3_000,
      },
    ).catch((err) => err)

    expect(err).toBeInstanceOf(Error)
    if (!(err instanceof Error)) throw err
    expect(err.message).toContain("compromised")

    let hit = false
    await Flock.withLock(
      key,
      async () => {
        hit = true
      },
      {
        dir,
        staleMs: 200,
        timeoutMs: 3_000,
      },
    )
    expect(hit).toBe(true)
  })

  test("writes owner metadata while lock is held", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:meta"
    const file = path.join(lock(dir, key), "meta.json")

    await Flock.withLock(
      key,
      async () => {
        const json = await readJson<{
          token?: unknown
          pid?: unknown
          hostname?: unknown
          createdAt?: unknown
        }>(file)

        expect(typeof json.token).toBe("string")
        expect(typeof json.pid).toBe("number")
        expect(typeof json.hostname).toBe("string")
        expect(typeof json.createdAt).toBe("string")
      },
      {
        dir,
        staleMs: 1_000,
        timeoutMs: 3_000,
      },
    )
  })

  test("supports acquire with await using", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:acquire"
    const lockDir = lock(dir, key)

    {
      await using _ = await Flock.acquire(key, {
        dir,
        staleMs: 1_000,
        timeoutMs: 3_000,
      })
      expect(await exists(lockDir)).toBe(true)
    }

    expect(await exists(lockDir)).toBe(false)
  })

  test("releasing the same lease twice is idempotent", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const lease = await Flock.acquire("flock:idempotent-release", {
      dir,
      staleMs: 1_000,
      timeoutMs: 3_000,
    })
    await lease.release()
    await lease.release()
  })

  test("refuses token mismatch release and recovers from stale", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:token"
    const lockDir = lock(dir, key)
    const meta = path.join(lockDir, "meta.json")

    const err = await Flock.withLock(
      key,
      async () => {
        const json = await readJson<{ token?: string }>(meta)
        json.token = "tampered"
        await fs.writeFile(meta, JSON.stringify(json, null, 2))
      },
      {
        dir,
        staleMs: 500,
        timeoutMs: 3_000,
      },
    ).catch((err) => err)

    expect(err).toBeInstanceOf(Error)
    if (!(err instanceof Error)) throw err
    expect(err.message).toContain("token mismatch")
    expect(await exists(lockDir)).toBe(true)

    let hit = false
    await Flock.withLock(
      key,
      async () => {
        hit = true
      },
      {
        dir,
        staleMs: 500,
        timeoutMs: 6_000,
      },
    )
    expect(hit).toBe(true)
  })

  test("fails clearly on unwritable lock roots", async () => {
    if (process.platform === "win32") return

    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "locks")
    const key = "flock:perm"

    await fs.mkdir(dir, { recursive: true })
    await fs.chmod(dir, 0o500)

    try {
      const err = await Flock.withLock(key, async () => {}, {
        dir,
        staleMs: 100,
        timeoutMs: 500,
      }).catch((err) => err)

      expect(err).toBeInstanceOf(Error)
      if (!(err instanceof Error)) throw err
      const text = err.message
      expect(text.includes("EACCES") || text.includes("EPERM")).toBe(true)
    } finally {
      await fs.chmod(dir, 0o700)
    }
  })
})
