export * as StorageCleanup from "./storage-cleanup"

import { randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, readdir, realpath, rename, rmdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { ConfigStorageCleanup } from "./config/storage-cleanup"
import { eventCompactionLockKey } from "./event-compaction"
import { SnapshotActivity } from "./snapshot-activity"
import type { EffectFlock } from "./util/effect-flock"
import { Hash } from "./util/hash"

const DAY_MS = 24 * 60 * 60 * 1_000
const HOUR_MS = 60 * 60 * 1_000
const HASH_NAME = /^[0-9a-f]{40}$/
const COMPACTION_BACKUP_NAME = /^.+\.db\.bak-event-compaction-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/
const COMPACTION_MARKER = ".bak-event-compaction-"
const CHECKPOINT_SUFFIX = ".event-compaction.json"

export type Settings = ConfigStorageCleanup.Resolved
export type CandidateReason = "expired" | "size-limit"
export type SnapshotLayout = "legacy" | "project"

export interface UnknownArtifact {
  readonly path: string
  readonly reason: string
}

export interface LockedArtifact {
  readonly path: string
  readonly reason: "repository-lock" | "git-lock"
}

export interface CleanupCandidate {
  readonly kind: "snapshot" | "compaction-backup"
  readonly path: string
  readonly bytes: number
  readonly modifiedAt: number
  readonly reason: CandidateReason
  readonly layout?: SnapshotLayout
  readonly projectPath?: string
}

export interface Inventory {
  readonly generatedAt: number
  readonly snapshots: {
    readonly path: string
    readonly repositories: number
    readonly bytes: number
    readonly emptyContainers: number
  }
  readonly compactionBackups: {
    readonly files: number
    readonly bytes: number
    readonly protected: number
  }
  readonly candidates: ReadonlyArray<CleanupCandidate>
  readonly reclaimableBytes: number
  readonly unknown: ReadonlyArray<UnknownArtifact>
  readonly locked: ReadonlyArray<LockedArtifact>
}

export interface Preview extends Inventory {
  readonly previewToken: string
}

export class PreviewRequiredError extends Error {
  override readonly name = "StorageCleanupPreviewRequiredError"

  constructor() {
    super("A current storage cleanup preview is required before permanent deletion.")
  }
}

export interface CleanupSkip {
  readonly path: string
  readonly reason: string
}

export interface RunResult {
  readonly outcome: "completed" | "not-due" | "disabled"
  readonly automatic: boolean
  readonly startedAt: number
  readonly completedAt: number
  readonly inventory?: Inventory
  readonly deleted: ReadonlyArray<CleanupCandidate>
  readonly deletedBytes: number
  readonly removedEmptyContainers: number
  readonly skipped: ReadonlyArray<CleanupSkip>
}

export interface PersistedStatus {
  readonly version: 1
  readonly state: "idle" | "running" | "failed"
  readonly lastAttemptAt?: number
  readonly lastSucceededAt?: number
  readonly lastFailedAt?: number
  readonly lastFailure?: string
  readonly lastResult?: {
    readonly deletedArtifacts: number
    readonly deletedBytes: number
    readonly removedEmptyContainers: number
    readonly skipped: number
    readonly unknown: number
    readonly snapshotBytesBefore: number
  }
}

export interface Status extends PersistedStatus {
  readonly enabled: boolean
  readonly due: boolean
  readonly nextRunAt?: number
  readonly statusPath: string
}

export interface LockManager {
  readonly held: (key: string) => Promise<boolean>
  readonly withLock: <A>(key: string, body: () => Promise<A>) => Promise<A>
}

export interface Config {
  readonly data: string
  readonly state: string
  readonly locks: LockManager
  readonly snapshotDirectory?: string
  readonly statusFile?: string
  readonly now?: () => number
}

export interface Interface {
  readonly status: (settings: Settings) => Promise<Status>
  readonly preview: (settings: Settings) => Promise<Preview>
  readonly runNow: (settings: Settings, previewToken: string) => Promise<RunResult>
  readonly runIfDue: (settings: Settings) => Promise<RunResult>
  readonly invalidatePreview: () => void
}

type SnapshotRepository = {
  readonly path: string
  readonly realPath: string
  readonly bytes: number
  readonly lastUsedAt: number
  readonly layout: SnapshotLayout
  readonly projectPath?: string
  readonly locked?: LockedArtifact["reason"]
}

type CompactionBackup = {
  readonly path: string
  readonly realPath: string
  readonly bytes: number
  readonly modifiedAt: number
  readonly protected: boolean
}

type InternalInventory = Inventory & {
  readonly repositories: ReadonlyArray<SnapshotRepository>
  readonly backups: ReadonlyArray<CompactionBackup>
  readonly emptyContainers: ReadonlyArray<string>
}

export function lockManager(flock: EffectFlock.Interface, directory: string): LockManager {
  return {
    held: async (key) =>
      lstat(path.join(directory, `${Hash.fast(key)}.lock`))
        .then((info) => info.isDirectory())
        .catch(() => false),
    withLock: (key, body) => Effect.runPromise(flock.withLock(Effect.promise(body), key, directory)),
  }
}

export function make(input: Config): Interface {
  const snapshotDirectory = input.snapshotDirectory ?? path.join(input.data, "snapshot")
  const statusFile = input.statusFile ?? path.join(input.state, "storage-cleanup-status.json")
  const now = input.now ?? Date.now
  const globalLockKey = `storage-cleanup:${normalizePath(input.data)}`
  let manualPreview:
    | {
        readonly token: string
        readonly settings: string
        readonly candidates: ReadonlyArray<CleanupCandidate>
      }
    | undefined

  const status = async (settings: Settings) => {
    const persisted = await readStatus(statusFile)
    const nextRunAt = persisted.lastSucceededAt
      ? persisted.lastSucceededAt +
        Math.max(settings.checkIntervalHours, ConfigStorageCleanup.MIN_CHECK_INTERVAL_HOURS) * HOUR_MS
      : undefined
    return {
      ...persisted,
      enabled: settings.enabled,
      due: settings.enabled && (!nextRunAt || now() >= nextRunAt),
      nextRunAt,
      statusPath: statusFile,
    } satisfies Status
  }

  const preview = async (settings: Settings) => {
    manualPreview = undefined
    const inventory = await inspect(input, snapshotDirectory, settings, now())
    const token = randomUUID()
    manualPreview = {
      token,
      settings: settingsFingerprint(settings),
      candidates: inventory.candidates,
    }
    return { ...publicInventory(inventory), previewToken: token } satisfies Preview
  }

  const execute = (settings: Settings, automatic: boolean, previewToken?: string) =>
    input.locks.withLock(globalLockKey, async () => {
      const startedAt = now()
      let reviewedCandidates: ReadonlyArray<CleanupCandidate> | undefined
      if (!automatic) {
        const reviewed = manualPreview
        if (!reviewed || reviewed.token !== previewToken) throw new PreviewRequiredError()
        if (reviewed.settings !== settingsFingerprint(settings)) {
          manualPreview = undefined
          throw new PreviewRequiredError()
        }
        manualPreview = undefined
        reviewedCandidates = reviewed.candidates
      }
      const persisted = await readStatus(statusFile)
      const interrupted = persisted.state === "running"
      const previous = interrupted
        ? ({
            ...persisted,
            state: "failed",
            lastFailedAt: startedAt,
            lastFailure: "Previous storage cleanup was interrupted before completion.",
          } satisfies PersistedStatus)
        : persisted
      const nextRunAt = previous.lastSucceededAt
        ? previous.lastSucceededAt +
          Math.max(settings.checkIntervalHours, ConfigStorageCleanup.MIN_CHECK_INTERVAL_HOURS) * HOUR_MS
        : undefined
      if (automatic && !settings.enabled) {
        if (interrupted) await writeStatus(statusFile, previous)
        return {
          outcome: "disabled",
          automatic,
          startedAt,
          completedAt: now(),
          deleted: [],
          deletedBytes: 0,
          removedEmptyContainers: 0,
          skipped: [],
        } satisfies RunResult
      }
      if (automatic && nextRunAt && startedAt < nextRunAt) {
        if (interrupted) await writeStatus(statusFile, previous)
        return {
          outcome: "not-due",
          automatic,
          startedAt,
          completedAt: now(),
          deleted: [],
          deletedBytes: 0,
          removedEmptyContainers: 0,
          skipped: [],
        } satisfies RunResult
      }
      if (automatic) manualPreview = undefined

      await writeStatus(statusFile, {
        ...previous,
        version: 1,
        state: "running",
        lastAttemptAt: startedAt,
      })

      try {
        const inventory = await inspect(input, snapshotDirectory, settings, startedAt)
        const deleted: CleanupCandidate[] = []
        const skipped: CleanupSkip[] = []

        for (const candidate of reviewedCandidates ?? inventory.candidates) {
          if (candidate.kind === "snapshot") {
            if (await input.locks.held(candidate.path)) {
              skipped.push({ path: candidate.path, reason: "repository lock is held" })
              continue
            }
            try {
              const removed = await input.locks.withLock(candidate.path, () =>
                removeSnapshotCandidate(input, snapshotDirectory, candidate, startedAt, settings),
              )
              if (removed) deleted.push(candidate)
              else skipped.push({ path: candidate.path, reason: "snapshot changed after review" })
            } catch (cause) {
              skipped.push({ path: candidate.path, reason: errorMessage(cause) })
            }
            continue
          }

          const source = compactionSource(candidate.path)
          if (!source) {
            skipped.push({ path: candidate.path, reason: "compaction backup source could not be identified" })
            continue
          }
          try {
            const removed = await input.locks.withLock(eventCompactionLockKey(source), () =>
              removeCompactionBackup(input, candidate, startedAt, settings),
            )
            if (removed) deleted.push(candidate)
            else skipped.push({ path: candidate.path, reason: "compaction backup changed or became protected" })
          } catch (cause) {
            skipped.push({ path: candidate.path, reason: errorMessage(cause) })
          }
        }

        const containers = [
          ...inventory.emptyContainers,
          ...deleted.flatMap((candidate) =>
            candidate.kind === "snapshot" && candidate.layout === "project" && candidate.projectPath
              ? [candidate.projectPath]
              : [],
          ),
        ]
        const removedEmptyContainers = (
          await Promise.all(
            [...new Set(containers)].map((directory) => removeEmptyContainer(snapshotDirectory, directory)),
          )
        ).filter(Boolean).length
        const completedAt = now()
        const deletedBytes = deleted.reduce((total, candidate) => total + candidate.bytes, 0)
        const result = {
          outcome: "completed",
          automatic,
          startedAt,
          completedAt,
          inventory: publicInventory(inventory),
          deleted,
          deletedBytes,
          removedEmptyContainers,
          skipped,
        } satisfies RunResult
        await writeStatus(statusFile, {
          version: 1,
          state: "idle",
          lastAttemptAt: startedAt,
          lastSucceededAt: completedAt,
          lastFailedAt: previous.lastFailedAt,
          lastFailure: previous.lastFailure,
          lastResult: {
            deletedArtifacts: deleted.length,
            deletedBytes,
            removedEmptyContainers,
            skipped: skipped.length,
            unknown: inventory.unknown.length,
            snapshotBytesBefore: inventory.snapshots.bytes,
          },
        })
        return result
      } catch (cause) {
        const failedAt = now()
        await writeStatus(statusFile, {
          ...previous,
          version: 1,
          state: "failed",
          lastAttemptAt: startedAt,
          lastFailedAt: failedAt,
          lastFailure: errorMessage(cause),
        })
        throw cause
      }
    })

  return {
    status,
    preview,
    runNow: (settings, previewToken) => execute(settings, false, previewToken),
    runIfDue: (settings) => execute(settings, true),
    invalidatePreview: () => {
      manualPreview = undefined
    },
  }
}

async function inspect(input: Config, snapshotDirectory: string, settings: Settings, generatedAt: number) {
  const [snapshots, compaction] = await Promise.all([
    inspectSnapshots(input, snapshotDirectory),
    inspectCompactionBackups(input.data),
  ])
  const snapshotCandidates = selectSnapshotCandidates(snapshots.repositories, settings, generatedAt)
  const backupCutoff = generatedAt - settings.compactionBackupRetentionDays * DAY_MS
  const backupCandidates = compaction.backups
    .filter((backup) => !backup.protected && backup.modifiedAt <= backupCutoff)
    .sort((left, right) => left.modifiedAt - right.modifiedAt || left.path.localeCompare(right.path))
    .map(
      (backup) =>
        ({
          kind: "compaction-backup",
          path: backup.path,
          bytes: backup.bytes,
          modifiedAt: backup.modifiedAt,
          reason: "expired",
        }) satisfies CleanupCandidate,
    )
  const candidates = [...snapshotCandidates, ...backupCandidates]
  return {
    generatedAt,
    snapshots: {
      path: snapshotDirectory,
      repositories: snapshots.repositories.length,
      bytes: snapshots.repositories.reduce((total, repository) => total + repository.bytes, 0),
      emptyContainers: snapshots.emptyContainers.length,
    },
    compactionBackups: {
      files: compaction.backups.length,
      bytes: compaction.backups.reduce((total, backup) => total + backup.bytes, 0),
      protected: compaction.backups.filter((backup) => backup.protected).length,
    },
    candidates,
    reclaimableBytes: candidates.reduce((total, candidate) => total + candidate.bytes, 0),
    unknown: [...snapshots.unknown, ...compaction.unknown],
    locked: snapshots.repositories.flatMap((repository) =>
      repository.locked ? [{ path: repository.path, reason: repository.locked }] : [],
    ),
    repositories: snapshots.repositories,
    backups: compaction.backups,
    emptyContainers: snapshots.emptyContainers,
  } satisfies InternalInventory
}

async function inspectSnapshots(input: Config, root: string) {
  const repositories: SnapshotRepository[] = []
  const unknown: UnknownArtifact[] = []
  const emptyContainers: string[] = []
  const rootInfo = await lstat(root).catch(() => undefined)
  if (!rootInfo) return { repositories, unknown, emptyContainers }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    unknown.push({ path: root, reason: "snapshot root is not a real directory" })
    return { repositories, unknown, emptyContainers }
  }
  const rootRealPath = await realpath(root)
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const first = path.join(root, entry.name)
    if (!entry.isDirectory() || entry.isSymbolicLink() || !HASH_NAME.test(entry.name)) {
      unknown.push({ path: first, reason: "unrecognized snapshot root entry" })
      continue
    }
    if (await isSnapshotRepository(first)) {
      const inspected = await inspectRepository(input, rootRealPath, first, "legacy")
      if (inspected.repository) repositories.push(inspected.repository)
      else unknown.push({ path: first, reason: inspected.reason })
      continue
    }
    const children = await readdir(first, { withFileTypes: true }).catch(() => undefined)
    if (!children) {
      unknown.push({ path: first, reason: "snapshot project container could not be read" })
      continue
    }
    if (!children.length) {
      emptyContainers.push(first)
      continue
    }
    for (const child of children) {
      const repositoryPath = path.join(first, child.name)
      if (!child.isDirectory() || child.isSymbolicLink() || !HASH_NAME.test(child.name)) {
        unknown.push({ path: repositoryPath, reason: "unrecognized nested snapshot entry" })
        continue
      }
      const inspected = await inspectRepository(input, rootRealPath, repositoryPath, "project", first)
      if (inspected.repository) repositories.push(inspected.repository)
      else unknown.push({ path: repositoryPath, reason: inspected.reason })
    }
  }
  return { repositories, unknown, emptyContainers }
}

async function inspectRepository(
  input: Config,
  rootRealPath: string,
  repositoryPath: string,
  layout: SnapshotLayout,
  projectPath?: string,
  ignoreRepositoryLock = false,
): Promise<{ readonly repository?: SnapshotRepository; readonly reason: string }> {
  if (!(await isSnapshotRepository(repositoryPath)))
    return { reason: "snapshot path is not a validated Git repository" }
  const repositoryRealPath = await realpath(repositoryPath).catch(() => undefined)
  if (!repositoryRealPath || !sameOrChildPath(rootRealPath, repositoryRealPath))
    return { reason: "snapshot repository resolves outside the snapshot root" }
  const measured = await measureTree(repositoryPath).catch(() => undefined)
  if (!measured) return { reason: "snapshot repository contains an unsupported or unreadable entry" }
  const activity = await SnapshotActivity.read(repositoryPath)
  const repositoryLock = !ignoreRepositoryLock && (await input.locks.held(repositoryPath))
  const gitLock = measured.gitLocked
  return {
    reason: "",
    repository: {
      path: repositoryPath,
      realPath: repositoryRealPath,
      bytes: measured.bytes,
      lastUsedAt: Math.max(activity?.lastUsedAt ?? 0, measured.newestAt),
      layout,
      projectPath,
      locked: repositoryLock ? "repository-lock" : gitLock ? "git-lock" : undefined,
    },
  }
}

async function inspectCompactionBackups(data: string) {
  const backups: CompactionBackup[] = []
  const unknown: UnknownArtifact[] = []
  const dataInfo = await lstat(data).catch(() => undefined)
  if (!dataInfo?.isDirectory() || dataInfo.isSymbolicLink()) return { backups, unknown }
  const dataRealPath = await realpath(data)
  const entries = await readdir(data, { withFileTypes: true })
  const protectedPaths = new Set<string>()
  const protectedSources = new Set<string>()
  for (const entry of entries.filter((item) => item.name.endsWith(CHECKPOINT_SUFFIX))) {
    const filename = path.join(data, entry.name)
    const source = filename.slice(0, -CHECKPOINT_SUFFIX.length)
    const invalid = () => {
      unknown.push({ path: filename, reason: "event-compaction checkpoint is invalid" })
      if (source.toLowerCase().endsWith(".db")) protectedSources.add(normalizePath(source))
    }
    if (!entry.isFile() || entry.isSymbolicLink()) {
      invalid()
      continue
    }
    const checkpoint = parseRecord(await readFile(filename, "utf8").catch(() => ""))
    const references = checkpointReferences(checkpoint, source)
    if (!references) {
      invalid()
      continue
    }
    references.forEach((reference) => protectedPaths.add(normalizePath(reference)))
  }
  const backupNames = new Set(
    entries.filter((entry) => entry.isFile() && COMPACTION_BACKUP_NAME.test(entry.name)).map((entry) => entry.name),
  )
  for (const entry of entries) {
    const filename = path.join(data, entry.name)
    if (entry.name.includes(COMPACTION_MARKER) && !entry.isFile() && !entry.isSymbolicLink()) {
      unknown.push({ path: filename, reason: "event-compaction artifact is not a regular file" })
      continue
    }
    if (entry.isSymbolicLink() && entry.name.includes(COMPACTION_MARKER)) {
      unknown.push({ path: filename, reason: "event-compaction artifact is a symbolic link" })
      continue
    }
    if (entry.isFile() && entry.name.includes(COMPACTION_MARKER)) {
      const base = entry.name.endsWith("-wal") || entry.name.endsWith("-shm") ? entry.name.slice(0, -4) : entry.name
      if (!COMPACTION_BACKUP_NAME.test(base)) {
        unknown.push({ path: filename, reason: "unrecognized event-compaction backup name" })
        continue
      }
      if (entry.name !== base) {
        if (!backupNames.has(base))
          unknown.push({ path: filename, reason: "event-compaction sidecar has no matching backup" })
        continue
      }
      if (!backupNames.has(base)) continue
      const info = await backupInfo(path.join(data, base), dataRealPath)
      if (!info) {
        unknown.push({ path: filename, reason: "event-compaction backup is unsafe or unreadable" })
        continue
      }
      const source = compactionSource(info.path)
      backups.push({
        ...info,
        protected:
          protectedPaths.has(normalizePath(info.path)) ||
          (!!source && protectedSources.has(normalizePath(source))),
      })
    }
  }
  return { backups, unknown }
}

async function removeSnapshotCandidate(
  input: Config,
  root: string,
  candidate: CleanupCandidate,
  now: number,
  settings: Settings,
) {
  const rootRealPath = await realpath(root).catch(() => undefined)
  if (!rootRealPath || !candidate.layout) return false
  const inspected = await inspectRepository(
    { data: "", state: "", locks: { held: async () => false, withLock: async (_key, body) => body() } },
    rootRealPath,
    candidate.path,
    candidate.layout,
    candidate.projectPath,
    true,
  )
  const current = inspected.repository
  if (
    !current ||
    current.locked ||
    !samePath(current.realPath, candidate.path) ||
    current.bytes !== candidate.bytes ||
    current.lastUsedAt !== candidate.modifiedAt
  )
    return false
  if (candidate.reason === "expired" && current.lastUsedAt > now - settings.snapshotRetentionDays * DAY_MS) return false
  if (candidate.reason === "size-limit") {
    const snapshots = await inspectSnapshots(
      {
        ...input,
        locks: {
          ...input.locks,
          held: (key) => (samePath(key, candidate.path) ? Promise.resolve(false) : input.locks.held(key)),
        },
      },
      root,
    )
    const selected = selectSnapshotCandidates(snapshots.repositories, settings, now).some(
      (item) => item.reason === "size-limit" && samePath(item.path, candidate.path),
    )
    if (!selected) return false
  }
  await rm(current.path, { recursive: true, force: false })
  return true
}

async function removeCompactionBackup(input: Config, candidate: CleanupCandidate, now: number, settings: Settings) {
  const dataRealPath = await realpath(input.data).catch(() => undefined)
  if (!dataRealPath) return false
  const current = await backupInfo(candidate.path, dataRealPath)
  if (
    !current ||
    !samePath(current.realPath, candidate.path) ||
    current.bytes !== candidate.bytes ||
    current.modifiedAt !== candidate.modifiedAt ||
    current.modifiedAt > now - settings.compactionBackupRetentionDays * DAY_MS
  )
    return false
  const compaction = await inspectCompactionBackups(input.data)
  const reviewed = compaction.backups.find((backup) => samePath(backup.path, candidate.path))
  if (!reviewed || reviewed.protected) return false
  await rm(`${candidate.path}-wal`, { force: true })
  await rm(`${candidate.path}-shm`, { force: true })
  await rm(candidate.path, { force: false })
  return true
}

async function removeEmptyContainer(root: string, directory: string) {
  const [rootRealPath, info] = await Promise.all([
    realpath(root).catch(() => undefined),
    lstat(directory).catch(() => undefined),
  ])
  if (!rootRealPath || !info?.isDirectory() || info.isSymbolicLink() || !HASH_NAME.test(path.basename(directory)))
    return false
  const parentRealPath = await realpath(path.dirname(directory)).catch(() => undefined)
  if (!parentRealPath || !samePath(parentRealPath, rootRealPath)) return false
  return rmdir(directory)
    .then(() => true)
    .catch(() => false)
}

async function backupInfo(filename: string, dataRealPath: string) {
  const name = path.basename(filename)
  if (!COMPACTION_BACKUP_NAME.test(name) || !samePath(path.dirname(filename), dataRealPath)) return undefined
  const info = await lstat(filename).catch(() => undefined)
  if (!info?.isFile() || info.isSymbolicLink()) return undefined
  const resolved = await realpath(filename).catch(() => undefined)
  if (!resolved || !sameOrChildPath(dataRealPath, resolved)) return undefined
  const sidecars = await Promise.all(
    [`${filename}-wal`, `${filename}-shm`].map((sidecar) => lstat(sidecar).catch(() => undefined)),
  )
  if (sidecars.some((sidecar) => sidecar?.isSymbolicLink() || (sidecar && !sidecar.isFile()))) return undefined
  return {
    path: filename,
    realPath: resolved,
    bytes: info.size + sidecars.reduce((total, sidecar) => total + (sidecar?.size ?? 0), 0),
    modifiedAt: Math.max(info.mtimeMs, ...sidecars.map((sidecar) => sidecar?.mtimeMs ?? 0)),
  }
}

async function isSnapshotRepository(directory: string) {
  const info = await lstat(directory).catch(() => undefined)
  if (!info?.isDirectory() || info.isSymbolicLink()) return false
  const required = await Promise.all([
    lstat(path.join(directory, "HEAD")).catch(() => undefined),
    lstat(path.join(directory, "config")).catch(() => undefined),
    lstat(path.join(directory, "objects")).catch(() => undefined),
    lstat(path.join(directory, "refs")).catch(() => undefined),
  ])
  return required[0]?.isFile() && required[1]?.isFile() && required[2]?.isDirectory() && required[3]?.isDirectory()
}

async function measureTree(directory: string) {
  const root = await lstat(directory)
  let bytes = 0
  let newestAt = root.mtimeMs
  let gitLocked = false
  const pending = [directory]
  while (pending.length) {
    const current = pending.pop()!
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const filename = path.join(current, entry.name)
      const info = await lstat(filename)
      if (info.isSymbolicLink()) throw new Error(`Symbolic link in snapshot repository: ${filename}`)
      newestAt = Math.max(newestAt, info.mtimeMs)
      if (info.isDirectory()) pending.push(filename)
      else if (info.isFile()) {
        bytes += info.size
        if (entry.name.endsWith(".lock") || entry.name === "gc.pid") gitLocked = true
      }
      else throw new Error(`Unsupported snapshot entry: ${filename}`)
    }
  }
  return { bytes, newestAt, gitLocked }
}

function snapshotCandidate(repository: SnapshotRepository, reason: CandidateReason): CleanupCandidate {
  return {
    kind: "snapshot",
    path: repository.path,
    bytes: repository.bytes,
    modifiedAt: repository.lastUsedAt,
    reason,
    layout: repository.layout,
    projectPath: repository.projectPath,
  }
}

function selectSnapshotCandidates(
  repositories: ReadonlyArray<SnapshotRepository>,
  settings: Settings,
  generatedAt: number,
) {
  const cutoff = generatedAt - settings.snapshotRetentionDays * DAY_MS
  const old = repositories
    .filter((repository) => !repository.locked && repository.lastUsedAt <= cutoff)
    .sort(compareSnapshotAge)
  const oldPaths = new Set(old.map((repository) => repository.path))
  const retained = repositories.filter((repository) => !oldPaths.has(repository.path))
  let excess = Math.max(
    0,
    repositories.reduce((total, repository) => total + repository.bytes, 0) -
      old.reduce((total, repository) => total + repository.bytes, 0) -
      settings.snapshotMaxBytes,
  )
  const budget: SnapshotRepository[] = []
  retained
    .filter((repository) => !repository.locked)
    .sort(compareSnapshotAge)
    .forEach((repository) => {
      if (excess <= 0) return
      budget.push(repository)
      excess -= repository.bytes
    })
  return [
    ...old.map((repository) => snapshotCandidate(repository, "expired")),
    ...budget.map((repository) => snapshotCandidate(repository, "size-limit")),
  ]
}

function compareSnapshotAge(left: SnapshotRepository, right: SnapshotRepository) {
  return left.lastUsedAt - right.lastUsedAt || left.path.localeCompare(right.path)
}

function checkpointReferences(checkpoint: Record<string, unknown> | undefined, source: string) {
  if (
    !checkpoint ||
    checkpoint.version !== 1 ||
    !["copy", "compress", "validate", "switch"].includes(String(checkpoint.phase))
  )
    return undefined
  const names = ["source", "candidate", "output", "backup"] as const
  const references = names.map((name) => checkpoint[name])
  if (references.some((reference) => typeof reference !== "string" || !path.isAbsolute(reference))) return undefined
  if (!samePath(references[0] as string, source)) return undefined
  const expected = checkpoint.expected
  if (
    expected !== undefined &&
    (!expected ||
      typeof expected !== "object" ||
      Array.isArray(expected) ||
      typeof (expected as Record<string, unknown>).events !== "number" ||
      typeof (expected as Record<string, unknown>).sequences !== "number" ||
      typeof (expected as Record<string, unknown>).hash !== "string")
  )
    return undefined
  return references as string[]
}

function compactionSource(backup: string) {
  const marker = backup.lastIndexOf(COMPACTION_MARKER)
  if (marker === -1) return undefined
  const source = backup.slice(0, marker)
  return source.toLowerCase().endsWith(".db") ? source : undefined
}

function settingsFingerprint(settings: Settings) {
  return JSON.stringify([
    settings.enabled,
    settings.snapshotRetentionDays,
    settings.compactionBackupRetentionDays,
    settings.snapshotMaxBytes,
    settings.checkIntervalHours,
  ])
}

function parseRecord(content: string) {
  try {
    const value: unknown = JSON.parse(content)
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function publicInventory(inventory: InternalInventory): Inventory {
  return {
    generatedAt: inventory.generatedAt,
    snapshots: inventory.snapshots,
    compactionBackups: inventory.compactionBackups,
    candidates: inventory.candidates,
    reclaimableBytes: inventory.reclaimableBytes,
    unknown: inventory.unknown,
    locked: inventory.locked,
  }
}

async function readStatus(filename: string): Promise<PersistedStatus> {
  const value = parseRecord(await readFile(filename, "utf8").catch(() => ""))
  if (value?.version !== 1 || !new Set(["idle", "running", "failed"]).has(String(value.state)))
    return { version: 1, state: "idle" }
  const number = (key: string) =>
    typeof value[key] === "number" && Number.isSafeInteger(value[key]) && value[key] >= 0
      ? (value[key] as number)
      : undefined
  const lastResult = parseStatusResult(value.lastResult)
  return {
    version: 1,
    state: value.state as PersistedStatus["state"],
    lastAttemptAt: number("lastAttemptAt"),
    lastSucceededAt: number("lastSucceededAt"),
    lastFailedAt: number("lastFailedAt"),
    lastFailure: typeof value.lastFailure === "string" ? value.lastFailure : undefined,
    lastResult,
  }
}

function parseStatusResult(value: unknown): PersistedStatus["lastResult"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const keys = [
    "deletedArtifacts",
    "deletedBytes",
    "removedEmptyContainers",
    "skipped",
    "unknown",
    "snapshotBytesBefore",
  ] as const
  if (keys.some((key) => typeof record[key] !== "number" || !Number.isSafeInteger(record[key]) || record[key] < 0))
    return undefined
  return Object.fromEntries(keys.map((key) => [key, record[key]])) as unknown as PersistedStatus["lastResult"]
}

async function writeStatus(filename: string, value: PersistedStatus) {
  await mkdir(path.dirname(filename), { recursive: true })
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx" })
    await rename(temporary, filename)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

function normalizePath(filename: string) {
  const resolved = path.resolve(filename)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

function samePath(left: string, right: string) {
  return normalizePath(left) === normalizePath(right)
}

function sameOrChildPath(root: string, filename: string) {
  const relative = path.relative(root, filename)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause)
}
