export * as StorageMigrationRuntime from "./storage-migration-runtime"

import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises"
import path from "node:path"
import { Readable } from "node:stream"
import { IsolatedWorker } from "@opencode-ai/core/isolated-worker"
import type { StorageMigration } from "@opencode-ai/core/storage-migration"

export type DatabaseKind = "production" | "local"

export type Status = {
  readonly state: "idle" | "running" | "completed" | "failed"
  readonly databaseKind: DatabaseKind
  readonly sourceDatabase?: string
  readonly id?: string
  readonly stagingDirectory?: string
  readonly snapshotDirectory?: string
  readonly startedAt?: number
  readonly updatedAt?: number
  readonly message?: string
  readonly report?: StorageMigration.Report
  readonly resumable?: boolean
}

export type Interface = {
  readonly status: (databaseKind?: DatabaseKind) => Promise<Status>
  readonly startDryRun: (input?: {
    readonly databaseKind?: DatabaseKind
    readonly snapshotDirectory?: string
  }) => Promise<Status>
  readonly waitForDryRun: (databaseKind?: DatabaseKind) => Promise<Status>
  readonly recordActivation: (databaseKind: DatabaseKind, stagingDirectory: string) => Promise<Status>
  readonly recordRollback: (databaseKind: DatabaseKind, stagingDirectory: string) => Promise<Status>
}

type StoredStatus = Omit<Status, "databaseKind"> & {
  readonly databaseKind?: DatabaseKind
  readonly pid?: number
}
type Worker = {
  readonly pid: number
  readonly exited: Promise<number>
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
}

const active = new Map<string, Promise<void>>()
const starts = new Map<string, Promise<Status>>()
const writes = new Map<string, Promise<void>>()
const ACTIVATION_MESSAGE = "Storage migration activated successfully"
const ROLLBACK_MESSAGE = "Storage migration rollback completed successfully"

export function make(input: {
  readonly data: string
  readonly spawn?: (args: ReadonlyArray<string>) => Worker
  readonly runtime?: IsolatedWorker.Runtime
}): Interface {
  const status = async (databaseKind: DatabaseKind = "production"): Promise<Status> => {
    const statePath = runtimeStatePath(input.data, databaseKind)
    const current = await reconcileCompletedActivation(
      input.data,
      databaseKind,
      statePath,
      await normalizeInterruptedStatus(statePath, await readStatus(statePath)),
    )
    if (!current || current.state === "idle") return { state: "idle", databaseKind }
    return publicStatus(current, databaseKind)
  }

  const executeStart = async (request: {
    readonly databaseKind?: DatabaseKind
    readonly snapshotDirectory?: string
    } = {}) => {
    const databaseKind = request.databaseKind ?? "production"
    const statePath = runtimeStatePath(input.data, databaseKind)
    const current = await reconcileCompletedActivation(
      input.data,
      databaseKind,
      statePath,
      await normalizeInterruptedStatus(statePath, await readStatus(statePath)),
    )
    if (current?.state === "running" && (active.has(statePath) || processExists(current.pid)))
      return publicStatus(current, databaseKind)
    const resume =
      current?.state === "failed" &&
      current.resumable === true &&
      current.stagingDirectory !== undefined &&
      (await migrationEngineMatches(current.stagingDirectory))
    const id = resume ? current.id ?? randomUUID() : randomUUID()
    const sourceDatabase = path.join(input.data, databaseKind === "production" ? "opencode.db" : "opencode-local.db")
    if (!existsSync(sourceDatabase))
      throw new Error(`${databaseKind === "production" ? "Production" : "Local"} database does not exist at ${sourceDatabase}`)
    const stagingDirectory = resume
      ? current.stagingDirectory!
      : path.join(
          input.data,
          "storage-migrations",
          `dry-run-${databaseKind}-${new Date().toISOString().replaceAll(":", "-")}`,
        )
    const snapshotDirectory = request.snapshotDirectory
      ? requireAbsolute(request.snapshotDirectory)
      : resume && current.snapshotDirectory
        ? current.snapshotDirectory
        : path.join(path.dirname(stagingDirectory), `${path.basename(stagingDirectory)}-source-snapshot`)
    const running = {
      state: "running",
      databaseKind,
      sourceDatabase,
      id,
      stagingDirectory,
      snapshotDirectory,
      startedAt: resume ? current.startedAt ?? Date.now() : Date.now(),
      updatedAt: Date.now(),
      message: resume
        ? `Resuming the ${databaseKind} storage migration dry-run`
        : `Starting the ${databaseKind} storage migration dry-run`,
      resumable: true,
    } satisfies StoredStatus
    await writeStatus(statePath, running)
    const args = [
      "storage",
      "migrate",
      "--mode",
      "dry-run",
      "--database",
      databaseKind,
      "--source",
      sourceDatabase,
      "--staging",
      stagingDirectory,
      "--snapshot",
      snapshotDirectory,
      "--blob-store",
      path.join(input.data, "content"),
      "--archives",
      path.join(input.data, "archives"),
    ]
    const child = input.spawn?.(args) ?? spawnWorker(args, input.runtime)
    const started = { ...running, pid: child.pid }
    await writeStatus(statePath, started)
    const completion = finish(statePath, child, started).finally(() => active.delete(statePath))
    active.set(statePath, completion)
    return publicStatus(started)
  }

  const startDryRun: Interface["startDryRun"] = (request) => {
    const statePath = runtimeStatePath(input.data, request?.databaseKind ?? "production")
    const pending = starts.get(statePath)
    if (pending) return pending
    const next = executeStart(request).finally(() => starts.delete(statePath))
    starts.set(statePath, next)
    return next
  }

  const waitForDryRun: Interface["waitForDryRun"] = async (databaseKind = "production") => {
    const statePath = runtimeStatePath(input.data, databaseKind)
    await starts.get(statePath)
    await active.get(statePath)
    return status(databaseKind)
  }

  const recordActivation: Interface["recordActivation"] = async (databaseKind, stagingDirectory) => {
    const completed = await readCompletedActivation(input.data, databaseKind, stagingDirectory)
    if (!completed) throw new Error(`Completed ${databaseKind} storage activation receipt is missing or invalid`)
    await writeStatus(runtimeStatePath(input.data, databaseKind), completed)
    return publicStatus(completed, databaseKind)
  }

  const recordRollback: Interface["recordRollback"] = async (databaseKind, stagingDirectory) => {
    const completed = await readCompletedRollback(input.data, databaseKind, stagingDirectory)
    if (!completed) throw new Error(`Completed ${databaseKind} storage rollback receipt is missing or invalid`)
    await writeStatus(runtimeStatePath(input.data, databaseKind), completed)
    return publicStatus(completed, databaseKind)
  }

  return { status, startDryRun, waitForDryRun, recordActivation, recordRollback }
}

async function reconcileCompletedActivation(
  data: string,
  databaseKind: DatabaseKind,
  statePath: string,
  current?: StoredStatus,
) {
  if (
    current?.state === "running" ||
    (current?.state === "completed" && [ACTIVATION_MESSAGE, ROLLBACK_MESSAGE].includes(current.message ?? ""))
  )
    return current
  const root = path.join(data, "storage-migrations")
  const directories = await readdir(root, { withFileTypes: true }).catch(() => [])
  const candidates = await Promise.all(
    directories
      .filter((entry) => entry.isDirectory())
      .map((entry) => readCompletedActivation(data, databaseKind, path.join(root, entry.name))),
  )
  const completed = candidates
    .filter((candidate) => candidate !== undefined)
    .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))[0]
  if (!completed || (current?.updatedAt ?? 0) >= (completed.updatedAt ?? 0)) return current
  await writeStatus(statePath, completed)
  return completed
}

async function readCompletedRollback(data: string, databaseKind: DatabaseKind, stagingDirectory: string) {
  const manifest = await readJson<{
    readonly id?: unknown
    readonly kind?: unknown
    readonly status?: unknown
    readonly databaseKind?: unknown
    readonly paths?: { readonly sourceDatabase?: unknown }
  }>(path.join(stagingDirectory, "storage-activation-manifest.json"))
  if (
    manifest?.kind !== "opencode-storage-candidate" ||
    manifest.status !== "complete" ||
    manifest.databaseKind !== databaseKind ||
    typeof manifest.id !== "string" ||
    typeof manifest.paths?.sourceDatabase !== "string" ||
    !samePath(
      manifest.paths.sourceDatabase,
      path.join(data, databaseKind === "production" ? "opencode.db" : "opencode-local.db"),
    )
  )
    return
  const receipt = await readJson<{
    readonly kind?: unknown
    readonly manifestID?: unknown
    readonly events?: ReadonlyArray<{ readonly state?: unknown; readonly time?: unknown }>
  }>(path.join(stagingDirectory, `storage-rollback-${manifest.id}.json`))
  const last = receipt?.events?.at(-1)
  if (
    receipt?.kind !== "opencode-storage-rollback" ||
    receipt.manifestID !== manifest.id ||
    last?.state !== "completed" ||
    typeof last.time !== "number"
  )
    return
  return {
    state: "completed",
    databaseKind,
    sourceDatabase: manifest.paths.sourceDatabase,
    id: manifest.id,
    stagingDirectory,
    updatedAt: last.time,
    message: ROLLBACK_MESSAGE,
    resumable: false,
  } satisfies StoredStatus
}

async function readCompletedActivation(data: string, databaseKind: DatabaseKind, stagingDirectory: string) {
  const manifest = await readJson<{
    readonly id?: unknown
    readonly kind?: unknown
    readonly status?: unknown
    readonly databaseKind?: unknown
    readonly paths?: { readonly sourceDatabase?: unknown }
  }>(path.join(stagingDirectory, "storage-activation-manifest.json"))
  if (
    manifest?.kind !== "opencode-storage-candidate" ||
    manifest.status !== "complete" ||
    manifest.databaseKind !== databaseKind ||
    typeof manifest.id !== "string" ||
    typeof manifest.paths?.sourceDatabase !== "string" ||
    !samePath(
      manifest.paths.sourceDatabase,
      path.join(data, databaseKind === "production" ? "opencode.db" : "opencode-local.db"),
    )
  )
    return
  const receipt = await readJson<{
    readonly kind?: unknown
    readonly manifestID?: unknown
    readonly events?: ReadonlyArray<{ readonly state?: unknown; readonly time?: unknown }>
  }>(path.join(stagingDirectory, `storage-activation-${manifest.id}.json`))
  const last = receipt?.events?.at(-1)
  if (
    receipt?.kind !== "opencode-storage-activation" ||
    receipt.manifestID !== manifest.id ||
    last?.state !== "completed" ||
    typeof last.time !== "number"
  )
    return
  const journal = await readJson<{
    readonly kind?: unknown
    readonly status?: unknown
    readonly phase?: unknown
    readonly createdAt?: unknown
    readonly report?: StorageMigration.Report
  }>(path.join(stagingDirectory, "storage-migration-journal.json"))
  if (
    journal?.kind !== "opencode-storage-migration" ||
    journal.status !== "complete" ||
    journal.phase !== "complete" ||
    !journal.report
  )
    return
  return {
    state: "completed",
    databaseKind,
    sourceDatabase: manifest.paths.sourceDatabase,
    id: manifest.id,
    stagingDirectory,
    ...(typeof journal.createdAt === "number" ? { startedAt: journal.createdAt } : {}),
    updatedAt: last.time,
    message: ACTIVATION_MESSAGE,
    report: journal.report,
    resumable: false,
  } satisfies StoredStatus
}

function readJson<T>(filename: string) {
  return readFile(filename, "utf8")
    .then((value) => JSON.parse(value) as T)
    .catch(() => undefined)
}

function samePath(left: string, right: string) {
  const normalizedLeft = path.resolve(left)
  const normalizedRight = path.resolve(right)
  if (process.platform !== "win32") return normalizedLeft === normalizedRight
  return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
}

function runtimeStatePath(data: string, databaseKind: DatabaseKind) {
  if (databaseKind === "production") return path.join(data, "storage-migration-runtime.json")
  return path.join(data, "storage-migration-runtime-local.json")
}

async function finish(statePath: string, child: Worker, started: StoredStatus) {
  const output = new Response(child.stdout).text()
  const progress = consumeProgress(statePath, child.stderr, started)
  const exitCode = await child.exited
  const [stdout, message] = await Promise.all([output, progress])
  if (exitCode !== 0) {
    await writeStatus(statePath, {
      ...started,
      state: "failed",
      updatedAt: Date.now(),
      message: message || `Storage migration dry-run exited ${exitCode}`,
      resumable: true,
    })
    return
  }
  const manifest = JSON.parse(stdout) as StorageMigration.Manifest
  await writeStatus(statePath, {
    ...started,
    state: "completed",
    updatedAt: Date.now(),
    message: "Storage migration dry-run completed without activating the candidate",
    report: manifest.report,
    resumable: false,
  })
}

async function consumeProgress(
  statePath: string,
  stream: ReadableStream<Uint8Array>,
  started: StoredStatus,
) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let pending = ""
  let diagnosticLine = false
  let message = ""
  let diagnostic = { value: "", head: "", tail: "", length: 0 }
  while (true) {
    const result = await reader.read()
    pending += decoder.decode(result.value, { stream: !result.done })
    const lines = pending.split(/\r?\n/)
    pending = result.done ? "" : lines.pop() ?? ""
    if (pending.length > 8_192) {
      diagnostic = appendDiagnostic(diagnostic, pending.slice(0, -4_096).trimStart(), !diagnosticLine)
      pending = pending.slice(-4_096)
      diagnosticLine = true
      message = diagnosticMessage(diagnostic)
      await writeStatus(statePath, { ...started, updatedAt: Date.now(), message })
    }
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue
      const continuation = diagnosticLine && index === 0
      const progress = continuation ? undefined : progressMessage(line)
      if (progress !== undefined) {
        message = progress
        diagnostic = { value: "", head: "", tail: "", length: 0 }
      } else {
        diagnostic = appendDiagnostic(diagnostic, continuation ? line.trimEnd() : line.trim(), !continuation)
        message = diagnosticMessage(diagnostic)
      }
      if (continuation) diagnosticLine = false
      await writeStatus(statePath, { ...started, updatedAt: Date.now(), message })
    }
    if (result.done) return message || pending.trim()
  }
}

function progressMessage(line: string) {
  try {
    const value = JSON.parse(line) as { readonly message?: unknown }
    if (typeof value.message === "string") return value.message
  } catch {}
}

function appendDiagnostic(
  state: { readonly value: string; readonly head: string; readonly tail: string; readonly length: number },
  line: string,
  separate = true,
) {
  const chunk = `${separate && state.length > 0 ? "\n" : ""}${line}`
  const length = state.length + chunk.length
  if (length <= 4_000) return { value: state.value + chunk, head: "", tail: "", length }
  const combined = state.length <= 4_000 ? state.value + chunk : state.tail + chunk
  return {
    value: "",
    head: state.head || combined.slice(0, 3_500),
    tail: combined.slice(-500),
    length,
  }
}

function diagnosticMessage(state: { readonly value: string; readonly head: string; readonly tail: string; readonly length: number }) {
  if (state.length <= 4_000) return state.value
  return `${state.head}\n...[${state.length - 4_000} characters omitted]...\n${state.tail}`
}

async function readStatus(filename: string, attempt = 0): Promise<StoredStatus | undefined> {
  const pending = writes.get(filename)
  if (pending) await pending.catch(() => undefined)
  if (!existsSync(filename)) return
  try {
    return JSON.parse(await readFile(filename, "utf8")) as StoredStatus
  } catch {
    if (attempt < 3) {
      await sleep(5)
      return readStatus(filename, attempt + 1)
    }
    return {
      state: "failed",
      updatedAt: Date.now(),
      message: "The storage migration status file is invalid",
      resumable: false,
    } satisfies StoredStatus
  }
}

async function writeStatus(filename: string, status: StoredStatus) {
  const previous = writes.get(filename) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(async () => {
    await mkdir(path.dirname(filename), { recursive: true })
    const temporary = `${filename}.tmp-${process.pid}-${randomUUID()}`
    try {
      const handle = await open(temporary, "wx")
      try {
        await handle.writeFile(`${JSON.stringify(status, null, 2)}\n`)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await replaceFile(temporary, filename)
    } finally {
      await rm(temporary, { force: true })
    }
  })
  writes.set(filename, next)
  await next.finally(() => {
    if (writes.get(filename) === next) writes.delete(filename)
  })
}

async function replaceFile(source: string, destination: string, attempt = 0): Promise<void> {
  try {
    await rename(source, destination)
  } catch (cause) {
    if (
      process.platform !== "win32" ||
      !(cause instanceof Error) ||
      !("code" in cause) ||
      (cause.code !== "EPERM" && cause.code !== "EEXIST") ||
      attempt >= 5
    )
      throw cause
    await sleep(5)
    return replaceFile(source, destination, attempt + 1)
  }
}

function sleep(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}

async function migrationEngineMatches(stagingDirectory: string) {
  const contentFilename = path.join(stagingDirectory, "content-migration-manifest.json")
  const storageFilename = path.join(stagingDirectory, "storage-migration-journal.json")
  if (!existsSync(stagingDirectory) || !existsSync(storageFilename)) return false
  try {
    const content = existsSync(contentFilename)
      ? JSON.parse(await readFile(contentFilename, "utf8")) as { readonly engineVersion?: unknown }
      : undefined
    const storage = JSON.parse(await readFile(storageFilename, "utf8")) as { readonly version?: unknown }
    const { CONTENT_MIGRATION_VERSION } = await import("@opencode-ai/core/content-migration")
    const { STORAGE_MIGRATION_VERSION } = await import("@opencode-ai/core/storage-migration")
    return (
      (content === undefined || content.engineVersion === CONTENT_MIGRATION_VERSION) &&
      storage.version === STORAGE_MIGRATION_VERSION
    )
  } catch {
    return false
  }
}

function spawnWorker(args: ReadonlyArray<string>, runtime?: IsolatedWorker.Runtime): Worker {
  const child = IsolatedWorker.launch(args, runtime)
  child.stdin.end()
  if (child.pid === undefined) throw new Error("The storage migration worker did not start")
  return {
    pid: child.pid,
    exited: new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("close", (code) => resolve(code ?? 1))
    }),
    stdout: Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
    stderr: Readable.toWeb(child.stderr) as unknown as ReadableStream<Uint8Array>,
  }
}

function publicStatus(status: StoredStatus, databaseKind: DatabaseKind = status.databaseKind ?? "production"): Status {
  const { pid: _, ...result } = status
  return { ...result, databaseKind }
}

function processExists(pid?: number) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function normalizeInterruptedStatus(statePath: string, current?: StoredStatus) {
  if (!current || current.state !== "running" || active.has(statePath) || processExists(current.pid)) return current
  const interrupted = {
    ...current,
    state: "failed",
    updatedAt: Date.now(),
    message: "The dry-run worker stopped before completion. The staging journal can be resumed.",
    resumable: true,
  } satisfies StoredStatus
  await writeStatus(statePath, interrupted)
  return interrupted
}

function requireAbsolute(directory: string) {
  if (!path.isAbsolute(directory)) throw new Error("Snapshot directory must be an absolute path")
  return path.resolve(directory)
}
