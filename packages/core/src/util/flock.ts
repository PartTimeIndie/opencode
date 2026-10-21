import path from "path"
import os from "os"
import { randomBytes, randomUUID } from "crypto"
import { execFile } from "node:child_process"
import { link, mkdir, open, opendir, readFile, rename, rm, stat, utimes, writeFile } from "fs/promises"
import { Hash } from "./hash"
import { Effect } from "effect"

export type FlockGlobal = {
  state: string
}

export namespace Flock {
  let global: FlockGlobal | undefined

  export function setGlobal(g: FlockGlobal) {
    global = g
  }

  const root = () => {
    if (!global) throw new Error("Flock global not set")
    return path.join(global.state, "locks")
  }

  // Defaults for callers that do not provide timing options.
  const defaultOpts = {
    staleMs: 60_000,
    timeoutMs: 5 * 60_000,
    baseDelayMs: 100,
    maxDelayMs: 2_000,
  }

  export interface WaitEvent {
    key: string
    attempt: number
    delay: number
    waited: number
    signal: AbortSignal
  }

  export type Wait = (input: WaitEvent) => void | Promise<void>

  export type TransitionEvent = {
    phase: "beforePublish" | "afterPublish"
    epoch: bigint
  }

  export type TransitionObserver = (input: TransitionEvent) => void | Promise<void>

  export type TransitionJournalStatus = {
    directory: string
    entries: number
    claims: number
    completions: number
    legacy: number
    floors: number
    temporary: number
    floor: string
    latestEpoch: string
  }

  export interface Options {
    dir?: string
    signal?: AbortSignal
    staleMs?: number
    timeoutMs?: number
    baseDelayMs?: number
    maxDelayMs?: number
    onWait?: Wait
    onTransition?: TransitionObserver
  }

  type Opts = {
    processScoped: boolean
    staleMs: number
    timeoutMs: number
    baseDelayMs: number
    maxDelayMs: number
    onTransition?: TransitionObserver
  }

  type Owned = {
    acquired: true
    assertOwned: () => Promise<void>
    startHeartbeat: (intervalMs?: number) => void
    release: () => Promise<void>
  }

  type Generation = {
    token?: string
    dev?: number
    ino?: number
    birthtimeMs?: number
  }

  export interface Lease {
    release: () => Promise<void>
    [Symbol.asyncDispose]: () => Promise<void>
  }

  export interface ProcessLease extends Lease {
    // Process-scoped locks cannot be reaped while this exact OS process instance is alive.
    assertOwned: () => Promise<void>
  }

  let currentIdentity: Promise<string | undefined> | undefined

  function code(err: unknown) {
    if (typeof err !== "object" || err === null || !("code" in err)) return
    const value = err.code
    if (typeof value !== "string") return
    return value
  }

  function sleep(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error("Aborted"))
        return
      }

      let timer: NodeJS.Timeout | undefined

      const done = () => {
        signal?.removeEventListener("abort", abort)
        resolve()
      }

      const abort = () => {
        if (timer) {
          clearTimeout(timer)
        }
        signal?.removeEventListener("abort", abort)
        reject(signal?.reason ?? new Error("Aborted"))
      }

      signal?.addEventListener("abort", abort, { once: true })
      timer = setTimeout(done, ms)
    })
  }

  function jitter(ms: number) {
    const j = Math.floor(ms * 0.3)
    const d = Math.floor(Math.random() * (2 * j + 1)) - j
    return Math.max(0, ms + d)
  }

  function mono() {
    return performance.now()
  }

  function wall() {
    return Date.now()
  }

  async function stats(file: string) {
    try {
      return await stat(file)
    } catch (err) {
      const errCode = code(err)
      if (errCode === "ENOENT" || errCode === "ENOTDIR") return
      throw err
    }
  }

  async function stale(lockDir: string, heartbeatPath: string, metaPath: string, opts: Opts, stop: number) {
    // Stale detection allows automatic recovery after crashed owners.
    const age = await heartbeatAge(lockDir, heartbeatPath, metaPath)
    const expired = age > opts.staleMs
    if (opts.processScoped) {
      const owner = await readOwner(metaPath)
      if (owner?.hostname === os.hostname() && Number.isInteger(owner.pid) && owner.pid > 0) {
        if (!processRunning(owner.pid)) return true
        if (!expired) return false
        if (!owner.processStart) return false
        const identity = await processIdentity(owner.pid, stop)
        if (mono() >= stop) return false
        if (!identity) return false
        return identity !== owner.processStart
      }
    }
    return expired
  }

  async function heartbeatAge(lockDir: string, heartbeatPath: string, metaPath: string) {
    const now = wall()
    const heartbeat = await stats(heartbeatPath)
    if (heartbeat) {
      return now - heartbeat.mtimeMs
    }

    const meta = await stats(metaPath)
    if (meta) {
      return now - meta.mtimeMs
    }

    const dir = await stats(lockDir)
    if (!dir) {
      return 0
    }

    return now - dir.mtimeMs
  }

  async function readOwner(metaPath: string) {
    return readFile(metaPath, "utf8")
      .then(parseOwner)
      .catch(() => undefined)
  }

  function parseOwner(raw: string) {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return
    return {
      token: "token" in parsed && typeof parsed.token === "string" ? parsed.token : "",
      pid: "pid" in parsed && typeof parsed.pid === "number" ? parsed.pid : 0,
      hostname: "hostname" in parsed && typeof parsed.hostname === "string" ? parsed.hostname : "",
      processStart:
        "processStart" in parsed && typeof parsed.processStart === "string" ? parsed.processStart : undefined,
    }
  }

  async function generation(directory: string) {
    const metaPath = path.join(directory, "meta.json")
    for (const _ of [0, 1, 2]) {
      const before = await readFile(metaPath, "utf8").catch(() => undefined)
      const info = await stats(directory)
      if (!info) return
      const after = await readFile(metaPath, "utf8").catch(() => undefined)
      if (before !== after) continue
      if (after) {
        const owner = await Promise.resolve(after)
          .then(parseOwner)
          .catch(() => undefined)
        if (owner?.token) return { token: owner.token }
      }
      const confirmed = await stats(directory)
      if (!confirmed) return
      if (info.dev !== confirmed.dev || info.ino !== confirmed.ino || info.birthtimeMs !== confirmed.birthtimeMs)
        continue
      return { dev: info.dev, ino: info.ino, birthtimeMs: info.birthtimeMs }
    }
  }

  function sameGeneration(a: Generation, b: Generation | undefined) {
    if (!b) return false
    if (a.token || b.token) return a.token === b.token
    return (
      a.dev !== undefined &&
      a.ino !== undefined &&
      a.birthtimeMs !== undefined &&
      a.dev === b.dev &&
      a.ino === b.ino &&
      a.birthtimeMs === b.birthtimeMs
    )
  }

  async function retireDirectory(directory: string, expected: Generation) {
    const retired = `${directory}.retired-${expected.token ?? "legacy"}-${randomUUID()}`
    try {
      await renameForRetirement(directory, retired)
    } catch (err) {
      const errCode = code(err)
      if (errCode === "ENOENT" || errCode === "ENOTDIR") return false
      throw err
    }
    if (!sameGeneration(expected, await generation(retired))) {
      await rename(retired, directory).catch(() => undefined)
      throw new Error("Refusing to retire a lock generation that changed before rename.")
    }
    await rm(retired, { recursive: true, force: true })
    return true
  }

  async function renameForRetirement(source: string, destination: string, attempt = 0): Promise<void> {
    try {
      await rename(source, destination)
    } catch (err) {
      if ((code(err) === "EPERM" || code(err) === "EBUSY") && attempt < 5) {
        await sleep(10 * (attempt + 1))
        return renameForRetirement(source, destination, attempt + 1)
      }
      throw err
    }
  }

  function processRunning(pid: number) {
    try {
      process.kill(pid, 0)
      return true
    } catch (err) {
      return code(err) === "EPERM"
    }
  }

  async function processIdentity(pid: number, stop: number) {
    const timeoutMs = Math.min(1_000, Math.max(0, stop - mono()))
    if (timeoutMs <= 0) return
    if (pid === process.pid) {
      currentIdentity ??= readProcessIdentity(pid, 1_000).then((identity) => {
        if (!identity) currentIdentity = undefined
        return identity
      })
      return withTimeout(currentIdentity, timeoutMs)
    }
    return readProcessIdentity(pid, timeoutMs)
  }

  async function readProcessIdentity(pid: number, timeoutMs: number) {
    if (process.platform === "linux") {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      return readFile(`/proc/${pid}/stat`, { encoding: "utf8", signal: controller.signal })
        .then((raw) => raw.slice(raw.lastIndexOf(")") + 2).split(" ")[19])
        .catch(() => undefined)
        .finally(() => clearTimeout(timer))
    }
    const command =
      process.platform === "win32"
        ? [
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
          ]
        : ["ps", "-o", "lstart=", "-p", String(pid)]
    try {
      const result = Promise.withResolvers<string | undefined>()
      const child = execFile(command[0], command.slice(1), { windowsHide: true }, (error, stdout) => {
        result.resolve(error ? undefined : stdout.trim() || undefined)
      })
      return await withTimeout(result.promise, timeoutMs, () => child.kill())
    } catch {
      return
    }
  }

  function withTimeout<T>(promise: Promise<T>, timeoutMs: number, cancel?: () => void, signal?: AbortSignal) {
    return new Promise<T | undefined>((resolve, reject) => {
      let settled = false
      const finish = (fn: (value: T | undefined) => void, value: T | undefined) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener("abort", abort)
        fn(value)
      }
      const fail = (error: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener("abort", abort)
        reject(error)
      }
      const abort = () => {
        cancel?.()
        fail(signal?.reason ?? new Error("Aborted"))
      }
      const timer = setTimeout(() => {
        cancel?.()
        finish(resolve, undefined)
      }, timeoutMs)
      signal?.addEventListener("abort", abort, { once: true })
      if (signal?.aborted) abort()
      void promise.then(
        (value) => finish(resolve, value),
        (error) => fail(error),
      )
    })
  }

  type Transition = {
    epoch: bigint
    claim: string
    released: string
    legacy: boolean
  }

  type Journal = {
    floor: bigint
    latest?: Transition
    status: TransitionJournalStatus
  }

  const maxTransitionEpoch = 10n ** 20n - 1n

  function transitionStem(epoch: bigint) {
    if (epoch < 0n || epoch > maxTransitionEpoch) {
      throw new Error(
        `Flock transition epoch ${epoch} exceeds the 20-digit journal limit; stop all users of this lock and run explicit offline journal maintenance.`,
      )
    }
    return `epoch-${epoch.toString().padStart(20, "0")}`
  }

  function transitionPaths(root: string, epoch: bigint) {
    const stem = transitionStem(epoch)
    return {
      barrier: path.join(root, stem),
      claim: path.join(root, `${stem}.claim`),
      released: path.join(root, `${stem}.released`),
    }
  }

  async function readJournal(root: string, audit = false): Promise<Journal> {
    const scanned: {
      entries: number
      claims: number
      completions: number
      legacy: number
      floors: number
      temporary: number
      floor: bigint
      latestEpoch: bigint
      latest?: Transition
      floorMarkers: Map<bigint, string>
      claimFiles: Map<bigint, string>
      barrierFiles: Map<bigint, string>
      legacyEpochs: Set<bigint>
    } = {
      entries: 0,
      claims: 0,
      completions: 0,
      legacy: 0,
      floors: 0,
      temporary: 0,
      floor: 0n,
      latestEpoch: 0n,
      floorMarkers: new Map(),
      claimFiles: new Map(),
      barrierFiles: new Map(),
      legacyEpochs: new Set(),
    }
    for await (const entry of await opendir(root)) {
      scanned.entries += 1
      if (/^\.(?:claim|release|floor)-.*\.tmp$/.test(entry.name)) scanned.temporary += 1

      const floor = /^floor-(\d{20})$/.exec(entry.name)
      if (floor) {
        const epoch = BigInt(floor[1])
        if (epoch > scanned.latestEpoch) scanned.latestEpoch = epoch
        if (!entry.isFile()) continue
        scanned.floors += 1
        scanned.floorMarkers.set(epoch, path.join(root, entry.name))
        if (epoch > scanned.floor) scanned.floor = epoch
        continue
      }

      const transition = /^epoch-(\d{20})(?:\.(claim|released))?$/.exec(entry.name)
      if (!transition) continue
      const epoch = BigInt(transition[1])
      if (epoch > scanned.latestEpoch) scanned.latestEpoch = epoch
      if (transition[2] === "released") {
        if (entry.isFile()) scanned.completions += 1
        continue
      }

      const paths = transitionPaths(root, epoch)
      if (transition[2] === "claim") {
        if (!entry.isFile()) throw new Error(`Flock transition claim is not a regular file: ${entry.name}`)
        scanned.claims += 1
        scanned.claimFiles.set(epoch, paths.claim)
        if (!scanned.latest || epoch > scanned.latest.epoch) {
          scanned.latest = { epoch, claim: paths.claim, released: paths.released, legacy: false }
        }
        continue
      }

      if (entry.isDirectory()) {
        scanned.legacy += 1
        scanned.legacyEpochs.add(epoch)
        if (!scanned.latest || epoch > scanned.latest.epoch) {
          scanned.latest = {
            epoch,
            claim: path.join(paths.barrier, "meta.json"),
            released: path.join(paths.barrier, "released"),
            legacy: true,
          }
        }
        continue
      }

      if (!entry.isFile()) throw new Error(`Flock transition barrier is not a regular file: ${entry.name}`)
      scanned.barrierFiles.set(epoch, paths.barrier)
    }
    // A valid higher floor supersedes every lower marker. Likewise, publishing epoch N+1 proves N was once the
    // validated frontier with a permanent barrier. Runtime operations therefore reopen only the current frontier;
    // the explicit status audit below still validates every historical marker and representation.
    const floors = audit ? [...scanned.floorMarkers] : [...scanned.floorMarkers].filter(([epoch]) => epoch === scanned.floor)
    await Promise.all(floors.map(([epoch, file]) => readFloorMarker(file, epoch)))
    const epochs = audit
      ? new Set([...scanned.claimFiles.keys(), ...scanned.barrierFiles.keys(), ...scanned.legacyEpochs])
      : new Set(
          [scanned.latest?.epoch].filter(
            (epoch): epoch is bigint => epoch !== undefined && epoch > scanned.floor,
          ),
        )
    for (const epoch of epochs) {
      const claim = scanned.claimFiles.get(epoch)
      const barrier = scanned.barrierFiles.get(epoch)
      const legacy = scanned.legacyEpochs.has(epoch)
      if (legacy && claim) {
        throw new Error(`Flock transition epoch ${epoch} has both legacy and claim representations.`)
      }
      if (claim) {
        await validateTransitionBarrier(claim, transitionPaths(root, epoch).barrier, false)
        continue
      }
      if (barrier) await validateTransitionBarrier(transitionPaths(root, epoch).claim, barrier, true)
    }
    return {
      floor: scanned.floor,
      latest: scanned.latest && scanned.latest.epoch > scanned.floor ? scanned.latest : undefined,
      status: {
        directory: root,
        entries: scanned.entries,
        claims: scanned.claims,
        completions: scanned.completions,
        legacy: scanned.legacy,
        floors: scanned.floors,
        temporary: scanned.temporary,
        floor: scanned.floor.toString(),
        latestEpoch: scanned.latestEpoch.toString(),
      },
    }
  }

  async function validateTransitionBarrier(claim: string, barrier: string, required: boolean) {
    const barrierInfo = await stats(barrier)
    if (!barrierInfo) {
      if (required) throw new Error(`Flock transition barrier has no matching claim: ${path.basename(barrier)}`)
      try {
        await publishLink(claim, barrier)
      } catch (error) {
        if (code(error) !== "EEXIST") throw error
      }
      return validateTransitionBarrier(claim, barrier, true)
    }
    if (barrierInfo.isDirectory()) {
      throw new Error(`Flock transition epoch has both legacy and claim representations: ${path.basename(barrier)}`)
    }
    if (!barrierInfo.isFile()) {
      throw new Error(`Flock transition barrier is not a regular file: ${path.basename(barrier)}`)
    }
    const [claimOwner, barrierOwner] = await Promise.all([readOwner(claim), readOwner(barrier)])
    if (!claimOwner?.token || claimOwner.token !== barrierOwner?.token) {
      throw new Error(`Flock transition claim and barrier owners do not match: ${path.basename(barrier)}`)
    }
  }

  async function readFloorMarker(file: string, epoch: bigint) {
    const parsed = await readFile(file, "utf8")
      .then((value) => JSON.parse(value) as unknown)
      .catch(() => undefined)
    if (parsed && typeof parsed === "object" && "floor" in parsed && parsed.floor === epoch.toString()) return epoch
    throw new Error(`Flock transition journal contains a corrupt floor marker: ${path.basename(file)}`)
  }

  async function transitionAvailable(transition: Transition, staleMs: number, stop: number) {
    const info =
      (await stats(transition.claim)) ?? (transition.legacy ? await stats(path.dirname(transition.claim)) : undefined)
    const age = info ? wall() - info.mtimeMs : 0
    const owner = await readOwner(transition.claim)
    if (await stats(transition.released)) {
      if (transition.legacy) return true
      const terminal = await readFile(transition.released, "utf8")
        .then((value) => JSON.parse(value) as unknown)
        .catch(() => undefined)
      return Boolean(
        owner?.token &&
          terminal &&
          typeof terminal === "object" &&
          "token" in terminal &&
          terminal.token === owner.token &&
          "outcome" in terminal &&
          (terminal.outcome === "released" || terminal.outcome === "aborted"),
      )
    }
    if ((!owner?.token || !Number.isInteger(owner.pid) || owner.pid <= 0 || !owner.hostname) && !transition.legacy)
      return false
    if (owner?.hostname === os.hostname() && Number.isInteger(owner.pid) && owner.pid > 0) {
      if (!processRunning(owner.pid)) return true
      if (!owner.processStart) return false
      const identity = await processIdentity(owner.pid, stop)
      if (mono() >= stop) return false
      if (!identity) return false
      return identity !== owner.processStart
    }
    return age > staleMs
  }

  async function tryClaimTransition(lockDir: string, opts: Opts, stop: number, processStart: string | undefined) {
    if (mono() >= stop) return
    const root = lockDir + ".transitions"
    await mkdir(root, { recursive: true, mode: 0o700 })
    const journal = await readJournal(root)
    const latest = journal.latest
    if (latest && !(await transitionAvailable(latest, opts.staleMs, stop))) return
    const epoch = (latest?.epoch ?? journal.floor) + 1n
    if (epoch > maxTransitionEpoch) {
      throw new Error(
        `Flock transition journal exhausted at epoch ${maxTransitionEpoch}; stop all lock users and perform explicit offline maintenance.`,
      )
    }
    const target = transitionPaths(root, epoch)
    const token = randomUUID?.() ?? randomBytes(16).toString("hex")
    const temporary = path.join(root, `.claim-${token}.tmp`)
    await writeSynced(
      temporary,
      JSON.stringify({
        token,
        pid: process.pid,
        hostname: os.hostname(),
        processStart,
        createdAt: new Date().toISOString(),
      }),
    )

    try {
      await opts.onTransition?.({ phase: "beforePublish", epoch })
      await publishLink(temporary, target.claim)
    } catch (err) {
      await rm(temporary, { force: true }).catch(() => undefined)
      const errCode = code(err)
      if (errCode === "EEXIST") return
      if (errCode === "ENOENT" || errCode === "ENOTDIR") return
      throw err
    }

    try {
      try {
        await publishLink(temporary, target.barrier)
      } catch (error) {
        if (code(error) !== "EEXIST") throw error
        const barrier = await stats(target.barrier)
        if (barrier?.isDirectory()) {
          const owner = await readOwner(target.claim)
          if (owner?.token === token) await rm(target.claim, { force: true })
          return
        }
        const owner = await readOwner(target.barrier)
        if (!barrier?.isFile() || owner?.token !== token) {
          throw new Error(`Flock transition barrier is owned by another claim: ${path.basename(target.barrier)}`)
        }
      }
      await opts.onTransition?.({ phase: "afterPublish", epoch })
      const currentJournal = await readJournal(root)
      const current = currentJournal.latest
      const owner = await readOwner(target.claim)
      if (currentJournal.floor >= epoch || current?.epoch !== epoch || owner?.token !== token) {
        await publishTransitionEnd(root, target.released, token, "aborted").catch(() => undefined)
        return
      }
      // Published epochs are append-only. Runtime compaction is intentionally disabled because Node cannot
      // portably prove directory-entry durability before deletion on Windows. Explicit offline maintenance may
      // advance a durable floor only while every lock user is stopped; delayed claimants still revalidate it here.
    } catch (error) {
      await publishTransitionEnd(root, target.released, token, "aborted").catch(() => undefined)
      throw error
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }

    return {
      release: async () => {
        const current = await readOwner(target.claim)
        if (current?.token !== token) throw new Error("Refusing to release a transition owned by another epoch.")
        await publishTransitionEnd(root, target.released, token, "released")
      },
    }
  }

  async function writeSynced(file: string, content: string) {
    const handle = await open(file, "wx", 0o600)
    try {
      await handle.writeFile(content)
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  async function publishLink(source: string, target: string, attempt = 0): Promise<void> {
    try {
      await link(source, target)
    } catch (error) {
      if ((code(error) === "EPERM" || code(error) === "EBUSY") && attempt < 5) {
        await sleep(10 * (attempt + 1))
        return publishLink(source, target, attempt + 1)
      }
      if (code(error) === "EXDEV" || code(error) === "EOPNOTSUPP" || code(error) === "ENOTSUP") {
        throw new Error(`Flock transition journal requires atomic hard links on a local filesystem (${code(error)}).`, {
          cause: error,
        })
      }
      throw error
    }
  }

  async function publishTransitionEnd(root: string, target: string, token: string, outcome: "released" | "aborted") {
    const temporary = path.join(root, `.release-${token}-${randomUUID()}.tmp`)
    await writeSynced(temporary, JSON.stringify({ token, outcome, completedAt: new Date().toISOString() }))
    try {
      await publishLink(temporary, target)
    } catch (error) {
      if (code(error) !== "EEXIST") throw error
      const current = await readFile(target, "utf8")
        .then((value) => JSON.parse(value) as unknown)
        .catch(() => undefined)
      if (
        current &&
        typeof current === "object" &&
        "token" in current &&
        current.token === token &&
        "outcome" in current &&
        current.outcome === outcome
      )
        return
      throw new Error("Refusing to replace a transition completion marker owned by another claim.")
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  async function claimTransition(lockDir: string, opts: Opts, stop: number, processStart: string | undefined) {
    let delay = opts.baseDelayMs
    while (mono() < stop) {
      const transition = await tryClaimTransition(lockDir, opts, stop, processStart)
      if (transition) return transition
      const remaining = stop - mono()
      if (remaining <= 0) break
      const ms = Math.min(jitter(delay), remaining)
      await sleep(ms)
      delay = Math.min(opts.maxDelayMs, Math.floor(delay * 1.7))
    }
    throw new Error("Timed out waiting for lock transition epoch.")
  }

  async function initializeLockDir(
    lockDir: string,
    token: string,
    opts: Opts,
    stop: number,
    processStart: string | undefined,
  ) {
    const metaPath = path.join(lockDir, "meta.json")
    const heartbeatPath = path.join(lockDir, "heartbeat")
    if ((await stats(lockDir)) && !(await stale(lockDir, heartbeatPath, metaPath, opts, stop))) return false
    const transition = await tryClaimTransition(lockDir, opts, stop, processStart)
    if (!transition) return false
    try {
      if (await stats(lockDir)) {
        if (!(await stale(lockDir, heartbeatPath, metaPath, opts, stop))) return false
        const expired = await generation(lockDir)
        if (!expired || !(await retireDirectory(lockDir, expired))) return false
      }
      if (mono() >= stop) return false
      await mkdir(lockDir, { mode: 0o700 })
      const initializing = await generation(lockDir)
      if (!initializing) return false
      await writeFile(heartbeatPath, "", { flag: "wx" }).catch(async () => {
        await retireDirectory(lockDir, initializing).catch(() => undefined)
        throw new Error("Lock acquired but heartbeat already existed (possible compromise).")
      })
      await writeFile(
        metaPath,
        JSON.stringify(
          {
            token,
            pid: process.pid,
            hostname: os.hostname(),
            processStart,
            createdAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        { flag: "wx" },
      ).catch(async () => {
        await retireDirectory(lockDir, initializing).catch(() => undefined)
        throw new Error("Lock acquired but meta.json already existed (possible compromise).")
      })
      const owned = await generation(lockDir)
      if (!owned || owned.token !== token) throw new Error("Lock ownership changed during initialization.")
      return true
    } finally {
      await transition.release()
    }
  }

  async function tryAcquireLockDir(
    lockDir: string,
    opts: Opts,
    stop: number,
    processStart: string | undefined,
  ): Promise<Owned | { acquired: false }> {
    if (mono() >= stop) return { acquired: false }
    const token = randomUUID?.() ?? randomBytes(16).toString("hex")
    const metaPath = path.join(lockDir, "meta.json")
    const heartbeatPath = path.join(lockDir, "heartbeat")
    if (!(await initializeLockDir(lockDir, token, opts, stop, processStart))) return { acquired: false }
    let timer: NodeJS.Timeout | undefined
    let ownershipLost = false
    let releasePromise: Promise<void> | undefined

    const assertOwned = async () => {
      const current = await readOwner(metaPath)
      const owned = await generation(lockDir)
      if (current?.token === token && owned?.token === token) return
      ownershipLost = true
      throw new Error("Lock ownership was lost before the protected operation completed.")
    }

    const startHeartbeat = (intervalMs = Math.max(100, Math.floor(opts.staleMs / 3))) => {
      if (timer) return
      // Heartbeat prevents long critical sections from being evicted as stale.
      timer = setInterval(() => {
        const t = new Date()
        void utimes(heartbeatPath, t, t).catch(() => undefined)
      }, intervalMs)
      timer.unref?.()
    }

    const release = () =>
      (releasePromise ??= (async () => {
        if (timer) {
          clearInterval(timer)
          timer = undefined
        }
        if (ownershipLost) return

        const transition = await claimTransition(lockDir, opts, mono() + opts.timeoutMs, processStart)
        try {
          const current = await readOwner(metaPath)
          // The transition epoch prevents a new compliant owner from appearing between this check and retirement.
          if (!current) {
            throw new Error("Refusing to release: lock is compromised (metadata missing or invalid).")
          }
          if (current.token !== token) {
            throw new Error("Refusing to release: lock token mismatch (not the owner).")
          }

          const owned = await generation(lockDir)
          if (!owned || owned.token !== token || !(await retireDirectory(lockDir, owned))) {
            throw new Error("Refusing to release: lock generation changed (not the owner).")
          }
        } finally {
          await transition.release()
        }
      })())

    return {
      acquired: true,
      assertOwned,
      startHeartbeat,
      release,
    }
  }

  async function acquireLockDir(
    lockDir: string,
    input: { key: string; onWait?: Wait; signal?: AbortSignal },
    opts: Opts,
  ) {
    const stop = mono() + opts.timeoutMs
    // Transition fencing is process-aware for every lock mode, even when the protected lock itself is age-based.
    const processStart = await processIdentity(process.pid, stop)
    let attempt = 0
    let waited = 0
    let delay = opts.baseDelayMs

    while (true) {
      input.signal?.throwIfAborted()
      if (mono() >= stop) throw new Error(`Timed out waiting for lock: ${input.key}`)

      const res = await tryAcquireLockDir(lockDir, opts, stop, processStart)
      if (res.acquired) {
        if (mono() >= stop) {
          await res.release()
          throw new Error(`Timed out waiting for lock: ${input.key}`)
        }
        return res
      }

      if (mono() >= stop) {
        throw new Error(`Timed out waiting for lock: ${input.key}`)
      }

      attempt += 1
      const ms = jitter(delay)
      const wait = new AbortController()
      await withTimeout(
        Promise.resolve(
          input.onWait?.({
            key: input.key,
            attempt,
            delay: ms,
            waited,
            signal: wait.signal,
          }),
        ),
        Math.max(0, stop - mono()),
        () => wait.abort(new Error(`Timed out waiting for lock: ${input.key}`)),
        input.signal,
      )
      const remaining = stop - mono()
      if (remaining <= 0) throw new Error(`Timed out waiting for lock: ${input.key}`)
      const sleepMs = Math.min(ms, remaining)
      await sleep(sleepMs, input.signal)
      waited += sleepMs
      delay = Math.min(opts.maxDelayMs, Math.floor(delay * 1.7))
    }
  }

  async function acquireOwned(key: string, input: Options, processScoped: boolean) {
    input.signal?.throwIfAborted()
    const cfg: Opts = {
      processScoped,
      staleMs: input.staleMs ?? defaultOpts.staleMs,
      timeoutMs: input.timeoutMs ?? defaultOpts.timeoutMs,
      baseDelayMs: input.baseDelayMs ?? defaultOpts.baseDelayMs,
      maxDelayMs: input.maxDelayMs ?? defaultOpts.maxDelayMs,
      onTransition: input.onTransition,
    }
    const dir = input.dir ?? root()

    await mkdir(dir, { recursive: true })
    const lockfile = path.join(dir, Hash.fast(key) + ".lock")
    const lock = await acquireLockDir(
      lockfile,
      {
        key,
        onWait: input.onWait,
        signal: input.signal,
      },
      cfg,
    )
    lock.startHeartbeat()
    return lock
  }

  export async function transitionJournalStatus(
    key: string,
    input: Pick<Options, "dir"> = {},
  ): Promise<TransitionJournalStatus> {
    const directory = path.join(input.dir ?? root(), Hash.fast(key) + ".lock.transitions")
    if (!(await stats(directory)))
      return {
        directory,
        entries: 0,
        claims: 0,
        completions: 0,
        legacy: 0,
        floors: 0,
        temporary: 0,
        floor: "0",
        latestEpoch: "0",
      }
    return (await readJournal(directory, true)).status
  }

  export async function acquire(key: string, input: Options = {}): Promise<Lease> {
    const lock = await acquireOwned(key, input, false)
    const release = () => lock.release()
    return {
      release,
      [Symbol.asyncDispose]() {
        return release()
      },
    }
  }

  export async function withLock<T>(key: string, fn: () => Promise<T>, input: Options = {}) {
    await using _ = await acquire(key, input)
    input.signal?.throwIfAborted()
    return await fn()
  }

  export async function withProcessLock<T>(key: string, fn: (lease: ProcessLease) => Promise<T>, input: Options = {}) {
    const lock = await acquireOwned(key, input, true)
    await using lease: ProcessLease = {
      assertOwned: lock.assertOwned,
      release: lock.release,
      [Symbol.asyncDispose]: lock.release,
    }
    input.signal?.throwIfAborted()
    return await fn(lease)
  }

  export const effect = Effect.fn("Flock.effect")(function* (key: string, input: Options = {}) {
    return yield* Effect.acquireRelease(
      Effect.promise((signal) => Flock.acquire(key, { ...input, signal })).pipe(
        Effect.withSpan("Flock.acquire", {
          attributes: { key },
        }),
      ),
      (lock) => Effect.promise(() => lock.release()).pipe(Effect.withSpan("Flock.release")),
    ).pipe(Effect.asVoid)
  })
}
