export * as MirrorSession from "./mirror-session"

import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createHash, randomUUID } from "node:crypto"
import { AgentMirror } from "./agent-mirror"
import { Flock } from "../../util/flock"

type Input = {
  directory: string
  sessionID: string
  root: string
}
type Lease = {
  version: 1
  sessionID: string
  source: string
  directory: string
  basisID: string
  basisDigest: string
  /** Binds the content-addressed basis-blobs snapshot written at start. */
  basisSnapshotDigest?: string
}
type Integrated = {
  version: 1
  planDigest: string
  integratedAt: string
  changes: number
  mirrorDigest: string
}

/** Match Core's XDG fallback without importing Global's writing startup path. */
export function defaultRoot(dataHome?: string, home = os.homedir()) {
  if (dataHome && !path.isAbsolute(dataHome)) throw new Error("Mirror data home must be absolute")
  return path.join(dataHome || path.join(home, ".local", "share"), "opencode", "standalone-mirrors")
}

/** Standalone file workspace, not Session placement or native task admission.
 * Native tasks bind their own workspace through the guarded Core adapter. */
export async function start(request: Input & { untracked?: readonly string[] }) {
  const input = structuredClone(request)
  const target = await placement(input)
  await fs.mkdir(target.root, { recursive: true })
  const root = await fs.realpath(target.root)
  if (inside(target.source, root)) throw new Error("Mirror storage must be outside the source checkout")
  const slot = path.join(root, target.key)
  // Deterministic validation failures must not poison a fresh reservation.
  // Existing slots still go through the strict ownership checks below.
  if (!await fs.lstat(slot).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false
    throw error
  })) await AgentMirror.preflight(target.source, input.untracked ?? [])
  return withMirrorLock(target, async (lock) => {
  const reserved = await fs.mkdir(slot).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") return false
    throw error
  })
  if (!reserved) {
    const current = await reservation(input)
    if (!current) throw new Error("Mirror reservation is incomplete; preserve it for inspection")
    if (await integratedMarker(current.slot)) throw new Error("Mirror is already integrated; run discard before starting again")
    return active(current.lease)
  }
  // Retain an incomplete reservation after failure/crash. Never allocate a
  // replacement silently or delete files that may contain task work.
  try {
  const mirror = await AgentMirror.create({
    directory: target.source, mirrorRoot: slot, taskID: target.key,
    sourceSessionID: input.sessionID, throughSeq: 0, untracked: input.untracked ?? [],
  })
  const manifest = await fs.readFile(path.join(mirror.directory, ".git", "opencode-mirror.json"))
  const basisSnapshotDigest = await storeBasisBlobs(slot, mirror.directory, mirror.basis)
  const lease: Lease = { version: 1, sessionID: input.sessionID, source: target.source,
    directory: mirror.directory, basisID: mirror.basis.id, basisDigest: digest(manifest), basisSnapshotDigest }
  await lock.assertOwned()
  await fs.writeFile(path.join(slot, "lease.json"), JSON.stringify(lease), { flag: "wx" })
  return active(lease)
  } catch (error) {
    // Written only after all preparation I/O drained. This receipt can support
    // explicit retention recovery; a missing receipt (old/crashed writer) cannot.
    await fs.writeFile(path.join(slot, "failed.json"), JSON.stringify({ version: 1,
      sessionID: input.sessionID, source: target.source, generation: randomUUID(),
      error: error instanceof Error ? error.message : String(error) }), { flag: "wx" }).catch((receiptError: unknown) => {
        const detail = (receiptError instanceof Error ? receiptError.message : String(receiptError)).slice(0, 200)
        throw new Error(`${error instanceof Error ? error.message : String(error)}; failed-preparation receipt could not be recorded: ${detail}. Preserve the reservation for manual inspection`, { cause: error })
      })
    throw error
  }
  })
}

/** Explicit two-phase retention of ONE known-failed preparation. Never deletes
 * artifacts, repairs a lease, resumes work, or recovers an unknown/crashed writer.
 * The optional digest must be the exact reviewed read-only recovery plan. */
export async function recover(request: Input & { planDigest?: string }) {
  const input = structuredClone(request)
  const target = await placement(input)
  const slot = path.join(target.root, target.key)
  const stat = await fs.lstat(slot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error("No failed Mirror reservation exists for this Session and source", { cause: error })
    throw error
  })
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(slot) !== slot)
    throw new Error("Mirror reservation identity changed")
  const lease = await fs.lstat(path.join(slot, "lease.json")).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (lease) throw new Error("A leased Mirror cannot use failed-preparation recovery")
  const failure = path.join(slot, "failed.json")
  const failureStat = await fs.lstat(failure).catch(() => undefined)
  if (!failureStat?.isFile() || failureStat.isSymbolicLink())
    throw new Error("Unknown preparation owner; preserve this reservation for manual inspection")
  const bytes = await fs.readFile(failure).catch((error: unknown) => {
    throw new Error("Failed preparation receipt changed or is unreadable; preserve the reservation for inspection", { cause: error })
  })
  const record = JSON.parse(bytes.toString()) as { version?: unknown; sessionID?: unknown; source?: unknown; generation?: unknown; error?: unknown }
  if (record.version !== 1 || record.sessionID !== input.sessionID || record.source !== target.source ||
    typeof record.generation !== "string" || !/^[a-f0-9-]{36}$/.test(record.generation) || typeof record.error !== "string")
    throw new Error("Failed preparation receipt does not match this Session and source")
  const retained = path.join(target.root, `retained-${target.key}-${record.generation}`)
  const claim = path.join(slot, "recovery.json")
  for (const file of [claim, retained]) {
    if (await fs.lstat(file).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false
      throw error
    })) throw new Error("Mirror recovery was already claimed or its retention destination exists; preserve both for manual inspection")
  }
  const planDigest = digest(Buffer.from(JSON.stringify({ slot, retained, failure: digest(bytes) })))
  if (input.planDigest === undefined)
    return { status: "recovery-ready" as const, planDigest, reservation: slot, retained, error: record.error }
  if (input.planDigest !== planDigest) throw new Error("Failed preparation recovery plan changed")
  return withMirrorLock(target, async (lock) => {
  if (await fs.realpath(slot).catch(() => undefined) !== slot || digest(await fs.readFile(failure)) !== digest(bytes))
    throw new Error("Mirror reservation changed during recovery; preserve it for inspection")
  // Exclusive claim: a concurrent recovery cannot rename this generation twice.
  await fs.writeFile(claim, JSON.stringify({ planDigest }), { flag: "wx" }).catch((error: unknown) => {
    throw new Error("Mirror recovery claim could not be acquired; preserve the reservation for manual inspection", { cause: error })
  })
  if (await fs.realpath(slot).catch(() => undefined) !== slot || digest(await fs.readFile(failure).catch((error: unknown) => {
    throw new Error("Mirror reservation changed during recovery; preserve it for inspection", { cause: error })
  })) !== digest(bytes) ||
    await fs.lstat(path.join(slot, "lease.json")).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false
      throw error
    })) throw new Error("Mirror reservation changed during recovery; preserve it for inspection")
  await fs.mkdir(retained).catch((error: unknown) => {
    throw new Error("Mirror retention destination could not be reserved; preserve the recovery claim for manual inspection", { cause: error })
  }) // Never replace a pre-existing retention destination.
  await lock.assertOwned()
  await fs.rename(slot, path.join(retained, "reservation")).catch((error: unknown) => {
    throw new Error("Mirror retention move did not complete; preserve the reservation, claim and destination for manual inspection", { cause: error })
  })
  return { status: "retained" as const, retained, planDigest }
  })
}

/** Maintenance for a pre-receipt, physically empty reservation only. The
 * operator must prove relevant writers quiescent before and during apply. */
export async function recoverLegacyEmpty(request: Input & {
  planDigest?: string
  assertQuiescent?: () => Promise<void>
}) {
  const input = structuredClone({ directory: request.directory, sessionID: request.sessionID, root: request.root })
  const target = await placement(input)
  const slot = path.join(target.root, target.key)
  const inspect = async () => {
    const stat = await fs.lstat(slot)
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(slot) !== slot)
      throw new Error("Legacy Mirror reservation identity changed")
    if ((await fs.readdir(slot)).length) throw new Error("Legacy Mirror reservation is not empty; preserve it for inspection")
    return { birthtimeMs: stat.birthtimeMs, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs }
  }
  const stamp = await inspect()
  const retained = path.join(target.root, `retained-legacy-${target.key}-${Math.floor(stamp.birthtimeMs)}`)
  const planDigest = digest(Buffer.from(JSON.stringify({ source: target.source, sessionID: input.sessionID, slot, retained, stamp })))
  if (request.planDigest === undefined)
    return { status: "legacy-empty-ready" as const, planDigest, reservation: slot, retained }
  if (request.planDigest !== planDigest) throw new Error("Legacy Mirror recovery plan changed")
  if (!request.assertQuiescent) throw new Error("Legacy Mirror recovery requires a verified quiescent host")
  await request.assertQuiescent()
  return withMirrorLock(target, async (lock) => {
    await request.assertQuiescent!()
    if (JSON.stringify(await inspect()) !== JSON.stringify(stamp))
      throw new Error("Legacy Mirror reservation changed; preserve it for inspection")
    if (await fs.lstat(retained).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false
      throw error
    })) throw new Error("Legacy Mirror retention destination exists; preserve it for inspection")
    await fs.mkdir(retained)
    await lock.assertOwned()
    await request.assertQuiescent!()
    if (JSON.stringify(await inspect()) !== JSON.stringify(stamp))
      throw new Error("Legacy Mirror reservation changed; preserve it for inspection")
    await fs.rename(slot, path.join(retained, "reservation"))
    return { status: "retained" as const, retained, planDigest }
  })
}

/** Read-only, including first use. Missing/corrupt ownership never means free. */
export async function inspect(request: Input) {
  const input = structuredClone(request)
  const current = await reservation(input)
  if (!current) return { status: "available" as const }
  const integrated = await integratedMarker(current.slot)
  if (integrated) return { status: "integrated" as const, version: 1 as const, sessionID: current.lease.sessionID,
    source: current.lease.source, directory: current.lease.directory, basisID: current.lease.basisID,
    basisDigest: current.lease.basisDigest, planDigest: integrated.planDigest }
  return active(current.lease)
}

/** Exact lease validation shared by status, start reuse, close, integrate and
 * discard. Returns undefined only for a physically absent reservation. */
export async function locate(request: Input) {
  const input = structuredClone(request)
  const current = await reservation(input)
  if (!current) throw new Error("No active Mirror for this Session and source")
  return current
}

/** Raw basis bytes captured at start. Verified against the immutable manifest
 * on every read; a missing or manipulated snapshot fails closed. */
export async function readBasisBlob(slot: string, entry: AgentMirror.File) {
  const content = new Uint8Array(await fs.readFile(path.join(slot, "basis-blobs", entry.sha256)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error("Basis snapshot is missing; preserve the Mirror for inspection")
    throw error
  }))
  if (digest(content) !== entry.sha256 || content.byteLength !== entry.bytes)
    throw new Error("Basis snapshot is corrupt; preserve the Mirror for inspection")
  return content
}

export async function integratedMarker(slot: string): Promise<Integrated | undefined> {
  const text = await fs.readFile(path.join(slot, "integrated.json"), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (text === undefined) return undefined
  const marker = JSON.parse(text) as Integrated
  if (marker.version !== 1 || typeof marker.planDigest !== "string" || typeof marker.mirrorDigest !== "string" ||
    typeof marker.integratedAt !== "string" || !Number.isSafeInteger(marker.changes))
    throw new Error("Integrated marker is corrupt; preserve the Mirror for inspection")
  return marker
}

function active(lease: Lease) {
  return { status: "active" as const, version: 1 as const, sessionID: lease.sessionID,
    source: lease.source, directory: lease.directory, basisID: lease.basisID, basisDigest: lease.basisDigest }
}

async function reservation(input: Input) {
  const target = await placement(input)
  const slot = path.join(target.root, target.key)
  const stat = await fs.lstat(slot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!stat) return undefined
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Mirror reservation is not a private directory")
  if (await fs.realpath(slot) !== slot) throw new Error("Mirror storage identity changed")
  const text = await fs.readFile(path.join(slot, "lease.json"), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error("Mirror reservation is incomplete; preserve it for inspection")
    throw error
  })
  const lease = JSON.parse(text) as Lease
  if (lease.version !== 1 || lease.sessionID !== input.sessionID || lease.source !== target.source ||
    typeof lease.directory !== "string" || typeof lease.basisID !== "string" || typeof lease.basisDigest !== "string" ||
    (lease.basisSnapshotDigest !== undefined && typeof lease.basisSnapshotDigest !== "string"))
    throw new Error("Mirror lease does not match this Session and source")
  if (!inside(slot, lease.directory) || path.basename(lease.directory) !== "workspace" ||
    await fs.realpath(lease.directory) !== lease.directory)
    throw new Error("Mirror workspace identity changed")
  const manifest = await fs.readFile(path.join(lease.directory, ".git", "opencode-mirror.json"))
  const basis = JSON.parse(manifest.toString()) as AgentMirror.Basis
  const owner = JSON.parse(await fs.readFile(path.join(path.dirname(lease.directory), "owner.json"), "utf8"))
  if (digest(manifest) !== lease.basisDigest || basis.id !== lease.basisID || basis.taskID !== target.key ||
    basis.sourceSessionID !== input.sessionID || basis.directory !== target.source ||
    owner.id !== basis.id || owner.taskID !== target.key || owner.sourceSessionID !== input.sessionID ||
    owner.directory !== target.source)
    throw new Error("Mirror basis or owner changed; preserve it for inspection")
  if (lease.basisSnapshotDigest !== undefined && lease.basisSnapshotDigest !== snapshotDigest(basis))
    throw new Error("Mirror basis snapshot changed; preserve it for inspection")
  return { slot, lease, manifest, basis, source: target.source }
}

async function storeBasisBlobs(slot: string, directory: string, basis: AgentMirror.Basis) {
  const blobs = path.join(slot, "basis-blobs")
  await fs.mkdir(blobs, { recursive: true })
  const files = [...basis.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const stored = new Set<string>()
  for (const file of files) {
    // Raw byte copy straight from the freshly verified mirror working tree;
    // no Git plumbing, filters or attribute normalization participates.
    const content = new Uint8Array(await fs.readFile(path.join(directory, file.path)))
    if (digest(content) !== file.sha256 || content.byteLength !== file.bytes)
      throw new Error("Basis snapshot verification failed; preserve the Mirror for inspection")
    if (!stored.has(file.sha256)) {
      await fs.writeFile(path.join(blobs, file.sha256), content, { flag: "wx" })
      stored.add(file.sha256)
    }
  }
  return snapshotDigest(basis)
}

function snapshotDigest(basis: AgentMirror.Basis) {
  return digest(Buffer.from(JSON.stringify(basis.files.map((file) => ({ path: file.path,
    sha256: file.sha256, bytes: file.bytes, mode: file.mode }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0))))
}

async function placement(input: Input) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.sessionID)) throw new Error("Invalid host Session ID")
  const source = await fs.realpath(input.directory)
  // Resolve the nearest existing ancestor without creating state during Status.
  const root = await physical(path.resolve(input.root))
  if (inside(source, root)) throw new Error("Mirror storage must be outside the source checkout")
  const identity = process.platform === "win32" ? source.toLowerCase() : source
  return { source, root, key: digest(Buffer.from(`${identity}\0${input.sessionID}`)) }
}

function withMirrorLock<T>(target: { root: string; key: string }, body: (lock: Flock.ProcessLease) => Promise<T>) {
  return Flock.withProcessLock(`standalone-mirror:${target.root}:${target.key}`, body,
    { dir: path.join(path.dirname(target.root), "locks"), timeoutMs: 10_000 })
}

async function physical(directory: string): Promise<string> {
  return fs.realpath(directory).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT" || path.dirname(directory) === directory) throw error
    return path.join(await physical(path.dirname(directory)), path.basename(directory))
  })
}

function inside(root: string, file: string) {
  const relative = path.relative(root, file)
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
}

function digest(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex")
}
