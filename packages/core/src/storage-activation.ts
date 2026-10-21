export * as StorageActivation from "./storage-activation"

import { Database } from "#maintenance-sqlite"
import { createHash, randomUUID } from "node:crypto"
import { createReadStream } from "node:fs"
import {
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import path from "path"
import { setTimeout } from "node:timers/promises"

const SHA256 = /^[0-9a-f]{64}$/
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024
export const ROLLBACK_RETENTION_MS = 14 * 24 * 60 * 60 * 1_000
const PROGRESS = [
  "validated",
  "retention-written",
  "assets-published",
  "source-moved",
  "candidate-active",
  "completed",
] as const
const ROLLBACK_PROGRESS = ["validated", "active-preserved", "backup-restored", "completed"] as const

export type DatabaseKind = "production" | "local"

export type Paths = {
  readonly sourceDatabase: string
  readonly candidateDatabase: string
  readonly candidateBlobDirectory: string
  readonly liveBlobDirectory: string
  readonly candidateArchiveDirectory: string
  readonly liveArchiveDirectory: string
  readonly stagingDirectory: string
  readonly manifestPath: string
}

export type Fingerprint = {
  readonly sizeBytes: number
  readonly modifiedAt: number
  readonly sha256: string
  readonly pageCount: number
  readonly schemaVersion: number
  readonly userVersion: number
}

export type FileEntry = {
  readonly source: string
  readonly target: string
  readonly sizeBytes: number
  readonly sha256: string
}

export type Manifest = {
  readonly version: 1
  readonly kind: "opencode-storage-candidate"
  readonly id: string
  readonly databaseKind: DatabaseKind
  readonly status: "complete"
  readonly paths: Paths
  readonly source: Fingerprint
  readonly candidate: Fingerprint
  readonly blobs: ReadonlyArray<FileEntry>
  readonly archives: ReadonlyArray<FileEntry>
  readonly referencedBlobs: ReadonlyArray<string>
  readonly backupDatabase: string
  readonly backupRetentionManifest: string
  readonly retentionManifest: string
  readonly activationJournal: string
  readonly createdAt: number
}

export type PrepareOptions = Paths & {
  readonly databaseKind: DatabaseKind
}

export type Progress =
  | "validated"
  | "retention-written"
  | "assets-published"
  | "source-moved"
  | "candidate-active"
  | "completed"
  | "restored"

export type ActivateOptions = Paths & {
  readonly databaseKind: "production"
  readonly onProgress?: (progress: Progress) => void | Promise<void>
}

export type LocalActivateOptions = Paths & {
  readonly databaseKind: "local"
  readonly onProgress?: (progress: Progress) => void | Promise<void>
}

export type RollbackOptions = Paths & {
  readonly databaseKind: "production"
  readonly confirm: string
  readonly onProgress?: (progress: RollbackProgress) => void | Promise<void>
}

export type LocalRollbackOptions = Paths & {
  readonly databaseKind: "local"
  readonly confirm: string
  readonly onProgress?: (progress: RollbackProgress) => void | Promise<void>
}

export type RollbackProgress = (typeof ROLLBACK_PROGRESS)[number]

export type Result = {
  readonly activeDatabase: string
  readonly backupDatabase: string
  readonly retentionManifest: string
  readonly activationJournal: string
  readonly resumed: boolean
}

export type RollbackResult = {
  readonly activeDatabase: string
  readonly preservedCandidateDatabase: string
  readonly rollbackJournal: string
  readonly resumed: boolean
}

type Journal = {
  readonly version: 1
  readonly kind: "opencode-storage-activation"
  readonly manifestID: string
  readonly events: ReadonlyArray<{ readonly state: Progress; readonly time: number }>
}

type RollbackJournal = {
  readonly version: 1
  readonly kind: "opencode-storage-rollback"
  readonly manifestID: string
  readonly preservedCandidateDatabase: string
  readonly events: ReadonlyArray<{ readonly state: RollbackProgress; readonly time: number }>
}

export class Error extends globalThis.Error {
  readonly code: "configuration" | "offline" | "manifest" | "integrity" | "filesystem" | "recovery"

  constructor(code: Error["code"], message: string, options?: { readonly cause?: unknown }) {
    super(message, options)
    this.name = "StorageActivation.Error"
    this.code = code
  }
}

/** Produces the complete, immutable inventory required by activation. */
export async function prepare(options: PrepareOptions): Promise<Manifest> {
  const input = await validatePaths(options)
  const source = await inspectExclusive(input.sourceDatabase)
  const candidate = await inspectDatabase(input.candidateDatabase)
  const blobs = await scanBlobs(input.candidateBlobDirectory, input.liveBlobDirectory)
  const archives = await scanArchives(input.candidateArchiveDirectory, input.liveArchiveDirectory)
  const referencedBlobs = await validateReferences(
    input.candidateDatabase,
    archives,
    blobs,
    input.liveBlobDirectory,
    input.liveArchiveDirectory,
  )
  const id = manifestID(options.databaseKind, input, source, candidate, blobs, archives)
  const label = options.databaseKind === "production" ? "opencode" : "opencode-local"
  const manifest: Manifest = {
    version: 1,
    kind: "opencode-storage-candidate",
    id,
    databaseKind: options.databaseKind,
    status: "complete",
    paths: input,
    source,
    candidate,
    blobs,
    archives,
    referencedBlobs,
    backupDatabase: path.join(
      path.dirname(input.sourceDatabase),
      `${path.basename(input.sourceDatabase)}.${label}-rollback-${id}`,
    ),
    backupRetentionManifest: path.join(
      path.dirname(input.sourceDatabase),
      `${path.basename(input.sourceDatabase)}.${label}-rollback-${id}.retention.json`,
    ),
    retentionManifest: path.join(input.stagingDirectory, `rollback-retention-${id}.json`),
    activationJournal: path.join(input.stagingDirectory, `storage-activation-${id}.json`),
    createdAt: Date.now(),
  }
  if (await exists(input.manifestPath)) {
    const existing = await readManifest(input.manifestPath)
    if (
      existing.id === manifest.id &&
      JSON.stringify({ ...existing, createdAt: 0 }) === JSON.stringify({ ...manifest, createdAt: 0 })
    )
      return existing
    throw new Error("manifest", "Candidate manifest path already contains a different immutable manifest")
  }
  await writeDurable(input.manifestPath, manifest)
  return manifest
}

/** Activates only a production candidate. Local databases require activateLocal. */
export async function activate(options: ActivateOptions): Promise<Result> {
  return activateManifest(options, "production")
}

/** A deliberately separate operation; it never discovers or touches a local DB implicitly. */
export async function activateLocal(options: LocalActivateOptions): Promise<Result> {
  return activateManifest(options, "local")
}

/** Restores the retained production database after an explicit offline confirmation. */
export async function rollback(options: RollbackOptions): Promise<RollbackResult> {
  return rollbackManifest(options, "production")
}

/** Local rollback is deliberately separate and cannot touch the production database. */
export async function rollbackLocal(options: LocalRollbackOptions): Promise<RollbackResult> {
  return rollbackManifest(options, "local")
}

async function activateManifest(options: ActivateOptions | LocalActivateOptions, expectedKind: DatabaseKind) {
  const input = await validatePaths(options)
  const manifest = await readManifest(input.manifestPath)
  assertManifestPaths(manifest, input, expectedKind)
  const previous = await readJournal(manifest.activationJournal, manifest.id)
  const resumed = previous !== undefined || (await exists(manifest.backupDatabase))
  const events = [...(previous?.events ?? [])]
  const progress = async (state: Progress) => {
    const attempt = events.slice(events.findLastIndex((event) => event.state === "restored") + 1)
    const existing = attempt.findIndex((event) => event.state === state)
    if (existing >= 0) return
    if (events.at(-1)?.state === "completed")
      throw new Error("manifest", "Completed activation journal cannot be extended")
    if (state === "restored") {
      if (!attempt.some((event) => event.state === "source-moved"))
        throw new Error("manifest", "Activation journal cannot restore before the source was moved")
    } else if (PROGRESS[attempt.length] !== state) {
      throw new Error(
        "manifest",
        `Activation journal expected ${PROGRESS[attempt.length] ?? "no further state"}, not ${state}`,
      )
    }
    events.push({ state, time: Date.now() })
    await writeDurable(manifest.activationJournal, {
      version: 1,
      kind: "opencode-storage-activation",
      manifestID: manifest.id,
      events,
    } satisfies Journal)
    await options.onProgress?.(state)
  }

  return runActivation({ manifest, progress, resumed }).catch(async (cause) => {
    const restored = await restoreOriginal(manifest)
    if (restored) await progress("restored").catch(() => undefined)
    if (cause instanceof Error) throw cause
    throw new Error("recovery", "Storage activation failed; the original database was restored", { cause })
  })
}

async function rollbackManifest(options: RollbackOptions | LocalRollbackOptions, expectedKind: DatabaseKind) {
  const input = await validatePaths(options)
  const manifest = await readManifest(input.manifestPath)
  assertManifestPaths(manifest, input, expectedKind)
  if (options.confirm !== manifest.id)
    throw new Error("configuration", `Rollback requires the exact activation ID ${manifest.id}`)
  const activation = await readJournal(manifest.activationJournal, manifest.id)
  if (activation?.events.at(-1)?.state !== "completed")
    throw new Error("manifest", "Rollback requires a completed storage activation journal")
  const preservedCandidateDatabase = path.join(input.stagingDirectory, `rolled-back-candidate-${manifest.id}.db`)
  const rollbackJournal = path.join(input.stagingDirectory, `storage-rollback-${manifest.id}.json`)
  const previous = await readRollbackJournal(rollbackJournal, manifest.id, preservedCandidateDatabase)
  const resumed = previous !== undefined || (await exists(preservedCandidateDatabase))
  const events = [...(previous?.events ?? [])]
  const progress = async (state: RollbackProgress) => {
    if (events.some((event) => event.state === state)) return
    if (events.at(-1)?.state === "completed")
      throw new Error("manifest", "Completed rollback journal cannot be extended")
    if (ROLLBACK_PROGRESS[events.length] !== state)
      throw new Error(
        "manifest",
        `Rollback journal expected ${ROLLBACK_PROGRESS[events.length] ?? "no further state"}, not ${state}`,
      )
    events.push({ state, time: Date.now() })
    await writeDurable(rollbackJournal, {
      version: 1,
      kind: "opencode-storage-rollback",
      manifestID: manifest.id,
      preservedCandidateDatabase,
      events,
    } satisfies RollbackJournal)
    await options.onProgress?.(state)
  }
  await runRollback({ manifest, preservedCandidateDatabase, progress })
  return {
    activeDatabase: manifest.paths.sourceDatabase,
    preservedCandidateDatabase,
    rollbackJournal,
    resumed,
  }
}

async function runRollback(input: {
  readonly manifest: Manifest
  readonly preservedCandidateDatabase: string
  readonly progress: (state: RollbackProgress) => Promise<void>
}) {
  await reconcileRollbackState(input.manifest, input.preservedCandidateDatabase)
  const sourceState = await identifyDatabase(input.manifest.paths.sourceDatabase, input.manifest)
  const backupState = await identifyDatabase(input.manifest.backupDatabase, input.manifest)
  const preservedState = await identifyDatabase(input.preservedCandidateDatabase, input.manifest)
  const source =
    sourceState === "candidate" || sourceState === "source"
      ? await inspectExclusive(input.manifest.paths.sourceDatabase)
      : undefined
  const backup = backupState === "source" ? await inspectExclusive(input.manifest.backupDatabase) : undefined
  const preserved = preservedState === "candidate" ? await inspectDatabase(input.preservedCandidateDatabase) : undefined
  if (
    (sourceState === "candidate" && !sameFingerprintIgnoringTime(source!, input.manifest.candidate)) ||
    (sourceState === "source" && !sameFingerprintIgnoringTime(source!, input.manifest.source)) ||
    (backupState === "source" && !sameFingerprintIgnoringTime(backup!, input.manifest.source)) ||
    (preservedState === "candidate" && !sameFingerprintIgnoringTime(preserved!, input.manifest.candidate))
  )
    throw new Error("integrity", "Rollback databases no longer match the activation manifest")
  await input.progress("validated")
  if (sourceState === "candidate" && backupState === "source" && preservedState === "missing") {
    await assertSameVolume(input.manifest.paths.sourceDatabase, path.dirname(input.preservedCandidateDatabase))
    await rename(input.manifest.paths.sourceDatabase, input.preservedCandidateDatabase).catch((cause) => {
      throw new Error("filesystem", "Unable to preserve the active migrated database before rollback", { cause })
    })
    await syncDirectory(path.dirname(input.manifest.paths.sourceDatabase))
  }
  await input.progress("active-preserved")
  if ((await identifyDatabase(input.manifest.paths.sourceDatabase, input.manifest)) === "missing") {
    await rename(input.manifest.backupDatabase, input.manifest.paths.sourceDatabase).catch((cause) => {
      throw new Error("filesystem", "Unable to restore the retained pre-migration database", { cause })
    })
    await syncDirectory(path.dirname(input.manifest.paths.sourceDatabase))
  }
  await input.progress("backup-restored")
  const restored = await inspectExclusive(input.manifest.paths.sourceDatabase)
  const finalPreserved = await inspectDatabase(input.preservedCandidateDatabase)
  if (
    !sameFingerprintIgnoringTime(restored, input.manifest.source) ||
    !sameFingerprintIgnoringTime(finalPreserved, input.manifest.candidate)
  )
    throw new Error("integrity", "Completed rollback databases do not match the activation manifest")
  await input.progress("completed")
}

async function reconcileRollbackState(manifest: Manifest, preservedCandidateDatabase: string) {
  const source = await identifyDatabase(manifest.paths.sourceDatabase, manifest)
  const backup = await identifyDatabase(manifest.backupDatabase, manifest)
  const preserved = await identifyDatabase(preservedCandidateDatabase, manifest)
  if (source === "candidate" && backup === "source" && preserved === "missing") return
  if (source === "missing" && backup === "source" && preserved === "candidate") return
  if (source === "source" && backup === "missing" && preserved === "candidate") return
  throw new Error(
    "recovery",
    `Ambiguous rollback state (source=${source}, backup=${backup}, preserved=${preserved})`,
  )
}

async function runActivation(input: {
  readonly manifest: Manifest
  readonly progress: (state: Progress) => Promise<void>
  readonly resumed: boolean
}): Promise<Result> {
  await reconcileCrashState(input.manifest)
  const sourceState = await identifyDatabase(input.manifest.paths.sourceDatabase, input.manifest)
  if (sourceState === "source") {
    const source = await inspectExclusive(input.manifest.paths.sourceDatabase)
    if (!sameFingerprint(source, input.manifest.source))
      throw new Error("integrity", "Source database no longer matches the candidate manifest")
    await validateCandidate(input.manifest)
    await input.progress("validated")
    await writeRetention(input.manifest)
    await input.progress("retention-written")
    await publishAssets(input.manifest)
    await input.progress("assets-published")
    const finalSource = await inspectExclusive(input.manifest.paths.sourceDatabase)
    if (!sameFingerprint(finalSource, input.manifest.source))
      throw new Error("integrity", "Source database changed immediately before activation")
    await assertSameVolume(input.manifest.paths.sourceDatabase, input.manifest.paths.candidateDatabase)
    await rename(input.manifest.paths.sourceDatabase, input.manifest.backupDatabase).catch((cause) => {
      throw new Error("filesystem", "Unable to preserve the source database as rollback backup", { cause })
    })
    await syncDirectory(path.dirname(input.manifest.paths.sourceDatabase))
    await input.progress("source-moved")
  }

  if (sourceState === "missing") {
    await validateCandidate(input.manifest)
    await input.progress("validated")
    await writeRetention(input.manifest)
    await input.progress("retention-written")
    await publishAssets(input.manifest)
    await input.progress("assets-published")
    await input.progress("source-moved")
  }

  if (sourceState === "candidate") {
    await validateActivatedCandidate(input.manifest)
    await input.progress("validated")
    await writeRetention(input.manifest)
    await input.progress("retention-written")
    await publishAssets(input.manifest)
    await input.progress("assets-published")
    await input.progress("source-moved")
  }

  if ((await identifyDatabase(input.manifest.paths.sourceDatabase, input.manifest)) !== "candidate") {
    await rename(input.manifest.paths.candidateDatabase, input.manifest.paths.sourceDatabase).catch((cause) => {
      throw new Error("filesystem", "Unable to atomically activate candidate database", { cause })
    })
    await syncDirectory(path.dirname(input.manifest.paths.sourceDatabase))
  }
  await input.progress("candidate-active")
  const active = await inspectDatabase(input.manifest.paths.sourceDatabase)
  if (!sameFingerprintIgnoringTime(active, input.manifest.candidate))
    throw new Error("integrity", "Activated database does not match the validated candidate")
  if (!(await exists(input.manifest.backupDatabase)))
    throw new Error("recovery", "Rollback backup is missing after activation")
  await input.progress("completed")
  return {
    activeDatabase: input.manifest.paths.sourceDatabase,
    backupDatabase: input.manifest.backupDatabase,
    retentionManifest: input.manifest.retentionManifest,
    activationJournal: input.manifest.activationJournal,
    resumed: input.resumed,
  }
}

async function validateActivatedCandidate(manifest: Manifest) {
  const blobs = await scanBlobs(manifest.paths.candidateBlobDirectory, manifest.paths.liveBlobDirectory)
  const archives = await scanArchives(manifest.paths.candidateArchiveDirectory, manifest.paths.liveArchiveDirectory)
  if (
    JSON.stringify(blobs) !== JSON.stringify(manifest.blobs) ||
    JSON.stringify(archives) !== JSON.stringify(manifest.archives)
  )
    throw new Error("integrity", "Candidate blob or archive inventory changed after database activation")
  const referenced = await validateReferences(
    manifest.paths.sourceDatabase,
    archives,
    blobs,
    manifest.paths.liveBlobDirectory,
    manifest.paths.liveArchiveDirectory,
  )
  if (JSON.stringify(referenced) !== JSON.stringify(manifest.referencedBlobs))
    throw new Error("integrity", "Activated database blob reachability does not match the candidate manifest")
}

async function validateCandidate(manifest: Manifest) {
  const candidate = await inspectDatabase(manifest.paths.candidateDatabase)
  if (!sameFingerprint(candidate, manifest.candidate))
    throw new Error("integrity", "Candidate database no longer matches its manifest")
  const blobs = await scanBlobs(manifest.paths.candidateBlobDirectory, manifest.paths.liveBlobDirectory)
  const archives = await scanArchives(manifest.paths.candidateArchiveDirectory, manifest.paths.liveArchiveDirectory)
  if (
    JSON.stringify(blobs) !== JSON.stringify(manifest.blobs) ||
    JSON.stringify(archives) !== JSON.stringify(manifest.archives)
  )
    throw new Error("integrity", "Candidate blob or archive inventory changed after manifest creation")
  const referenced = await validateReferences(
    manifest.paths.candidateDatabase,
    archives,
    blobs,
    manifest.paths.liveBlobDirectory,
    manifest.paths.liveArchiveDirectory,
  )
  if (JSON.stringify(referenced) !== JSON.stringify(manifest.referencedBlobs))
    throw new Error("integrity", "Candidate blob reachability changed after manifest creation")
}

async function publishAssets(manifest: Manifest) {
  await mkdir(manifest.paths.liveBlobDirectory, { recursive: true })
  await mkdir(manifest.paths.liveArchiveDirectory, { recursive: true })
  for (const entry of manifest.blobs) await publishFile(entry, manifest.paths.liveBlobDirectory)
  for (const entry of manifest.archives) await publishFile(entry, manifest.paths.liveArchiveDirectory)
  await syncDirectory(manifest.paths.liveBlobDirectory)
  await syncDirectory(manifest.paths.liveArchiveDirectory)
}

async function publishFile(entry: FileEntry, root: string) {
  if (await exists(entry.target)) {
    if ((await lstat(entry.target)).isSymbolicLink())
      throw new Error("integrity", `Activation target cannot be a symlink: ${entry.target}`)
    const target = await fingerprintFile(entry.target)
    if (target.sizeBytes === entry.sizeBytes && target.sha256 === entry.sha256) return
    throw new Error("integrity", `Activation target already exists with different content: ${entry.target}`)
  }
  await mkdir(path.dirname(entry.target), { recursive: true })
  const canonicalRoot = await realpath(root)
  const canonicalParent = await realpath(path.dirname(entry.target))
  if (canonicalRoot !== canonicalParent && !contains(canonicalRoot, canonicalParent))
    throw new Error("integrity", `Activation target escapes its explicit live root: ${entry.target}`)
  const temporary = `${entry.target}.activation-${randomUUID()}.tmp`
  await Promise.resolve()
    .then(() => copyFile(entry.source, temporary))
    .catch((cause) => {
      throw new Error("filesystem", `Unable to stage activation asset: ${entry.source}`, { cause })
    })
    .then(async () => {
      const copied = await fingerprintFile(temporary)
      if (copied.sizeBytes !== entry.sizeBytes || copied.sha256 !== entry.sha256)
        throw new Error("integrity", `Copied activation asset failed hash validation: ${entry.source}`)
      await syncFile(temporary)
      await link(temporary, entry.target).catch(async (cause) => {
        if (await exists(entry.target)) {
          const target = await fingerprintFile(entry.target)
          if (target.sizeBytes === entry.sizeBytes && target.sha256 === entry.sha256) return
        }
        throw new Error("filesystem", `Unable to publish activation asset: ${entry.target}`, { cause })
      })
      await syncDirectory(path.dirname(entry.target))
    })
    .finally(() => rm(temporary, { force: true }))
}

async function writeRetention(manifest: Manifest) {
  const retention = {
    version: 1,
    kind: "opencode-rollback-retention",
    activationID: manifest.id,
    databaseKind: manifest.databaseKind,
    sourceDatabase: manifest.paths.sourceDatabase,
    backupDatabase: manifest.backupDatabase,
    retainedBlobs: manifest.referencedBlobs,
    createdAt: manifest.createdAt,
    retainUntil: manifest.createdAt + ROLLBACK_RETENTION_MS,
    retirementRequiresExplicitConfirmation: true,
  }
  for (const filename of [manifest.retentionManifest, manifest.backupRetentionManifest]) {
    if (!(await exists(filename))) {
      await writeDurable(filename, retention)
      continue
    }
    if (JSON.stringify(await readJson(filename)) === JSON.stringify(retention)) continue
    throw new Error("manifest", "Rollback retention manifest already exists with different content")
  }
}

async function reconcileCrashState(manifest: Manifest) {
  const source = await identifyDatabase(manifest.paths.sourceDatabase, manifest)
  const backup = await identifyDatabase(manifest.backupDatabase, manifest)
  const candidate = await identifyDatabase(manifest.paths.candidateDatabase, manifest)
  if (source === "candidate" && backup === "source") return
  if (source === "missing" && backup === "source" && candidate === "candidate") return
  if (source === "source" && backup === "missing" && candidate === "candidate") return
  if (source === "unknown" && backup === "missing" && candidate === "candidate")
    throw new Error("integrity", "Source database no longer matches the candidate manifest")
  throw new Error("recovery", `Ambiguous activation state (source=${source}, backup=${backup}, candidate=${candidate})`)
}

async function restoreOriginal(manifest: Manifest) {
  const source = await identifyDatabase(manifest.paths.sourceDatabase, manifest).catch(() => "unknown" as const)
  const backup = await identifyDatabase(manifest.backupDatabase, manifest).catch(() => "unknown" as const)
  if (source === "source") return false
  if (backup !== "source") return false
  if (source === "candidate") {
    const recoveredCandidate = path.join(
      manifest.paths.stagingDirectory,
      `recovered-candidate-${manifest.id}-${randomUUID()}.db`,
    )
    await rename(manifest.paths.sourceDatabase, recoveredCandidate)
  }
  await rename(manifest.backupDatabase, manifest.paths.sourceDatabase)
  await syncDirectory(path.dirname(manifest.paths.sourceDatabase))
  return true
}

async function identifyDatabase(
  filename: string,
  manifest: Manifest,
): Promise<"source" | "candidate" | "missing" | "unknown"> {
  if (!(await exists(filename))) return "missing"
  const fingerprint = await inspectDatabase(filename)
  if (sameFingerprintIgnoringTime(fingerprint, manifest.source)) return "source"
  if (sameFingerprintIgnoringTime(fingerprint, manifest.candidate)) return "candidate"
  return "unknown"
}

async function validatePaths(options: Paths): Promise<Paths> {
  const values = [
    options.sourceDatabase,
    options.candidateDatabase,
    options.candidateBlobDirectory,
    options.liveBlobDirectory,
    options.candidateArchiveDirectory,
    options.liveArchiveDirectory,
    options.stagingDirectory,
    options.manifestPath,
  ]
  if (values.some((value) => !path.isAbsolute(value)))
    throw new Error(
      "configuration",
      "Every source, candidate, blob, archive, staging, and manifest path must be absolute",
    )
  const input: Paths = {
    sourceDatabase: path.resolve(options.sourceDatabase),
    candidateDatabase: path.resolve(options.candidateDatabase),
    candidateBlobDirectory: path.resolve(options.candidateBlobDirectory),
    liveBlobDirectory: path.resolve(options.liveBlobDirectory),
    candidateArchiveDirectory: path.resolve(options.candidateArchiveDirectory),
    liveArchiveDirectory: path.resolve(options.liveArchiveDirectory),
    stagingDirectory: path.resolve(options.stagingDirectory),
    manifestPath: path.resolve(options.manifestPath),
  }
  if (input.sourceDatabase === input.candidateDatabase)
    throw new Error("configuration", "Source and candidate database must be different explicit files")
  if (
    !contains(input.stagingDirectory, input.candidateDatabase) ||
    !contains(input.stagingDirectory, input.manifestPath)
  )
    throw new Error(
      "configuration",
      "Candidate database and manifest must be contained by the explicit staging directory",
    )
  if (
    !contains(input.stagingDirectory, input.candidateBlobDirectory) ||
    !contains(input.stagingDirectory, input.candidateArchiveDirectory)
  )
    throw new Error("configuration", "Candidate blob and archive directories must be contained by staging")
  if (contains(input.stagingDirectory, input.sourceDatabase))
    throw new Error("configuration", "Source database must be outside staging")
  if (
    overlaps(input.stagingDirectory, input.liveBlobDirectory) ||
    overlaps(input.stagingDirectory, input.liveArchiveDirectory) ||
    overlaps(input.liveBlobDirectory, input.liveArchiveDirectory) ||
    overlaps(input.candidateBlobDirectory, input.candidateArchiveDirectory)
  )
    throw new Error("configuration", "Staging, blob, and archive roots must be fully disjoint")
  await mkdir(input.stagingDirectory, { recursive: true })
  await mkdir(input.candidateBlobDirectory, { recursive: true })
  await mkdir(input.candidateArchiveDirectory, { recursive: true })
  const canonicalStaging = await canonicalFuturePath(input.stagingDirectory)
  const canonicalCandidateBlob = await canonicalFuturePath(input.candidateBlobDirectory)
  const canonicalCandidateArchive = await canonicalFuturePath(input.candidateArchiveDirectory)
  const canonicalLiveBlob = await canonicalFuturePath(input.liveBlobDirectory)
  const canonicalLiveArchive = await canonicalFuturePath(input.liveArchiveDirectory)
  if (
    overlaps(canonicalStaging, canonicalLiveBlob) ||
    overlaps(canonicalStaging, canonicalLiveArchive) ||
    overlaps(canonicalLiveBlob, canonicalLiveArchive) ||
    overlaps(canonicalCandidateBlob, canonicalCandidateArchive)
  )
    throw new Error("configuration", "Resolved staging, blob, and archive roots must be fully disjoint")
  for (const target of [
    input.sourceDatabase,
    input.candidateDatabase,
    input.stagingDirectory,
    input.candidateBlobDirectory,
    input.candidateArchiveDirectory,
    input.liveBlobDirectory,
    input.liveArchiveDirectory,
  ])
    await assertNotSymlink(target)
  return input
}

function assertManifestPaths(manifest: Manifest, paths: Paths, databaseKind: DatabaseKind) {
  if (manifest.version !== 1 || manifest.kind !== "opencode-storage-candidate" || manifest.status !== "complete")
    throw new Error("manifest", "Activation requires a complete version-1 candidate manifest")
  if (manifest.databaseKind !== databaseKind)
    throw new Error("configuration", `Candidate is for ${manifest.databaseKind}, not ${databaseKind}`)
  if (JSON.stringify(manifest.paths) !== JSON.stringify(paths))
    throw new Error("configuration", "Explicit activation paths do not exactly match the candidate manifest")
  if (
    !/^[0-9a-f]{24}$/.test(manifest.id) ||
    !validFingerprint(manifest.source) ||
    !validFingerprint(manifest.candidate)
  )
    throw new Error("manifest", "Candidate manifest has invalid identifiers or database fingerprints")
  const label = databaseKind === "production" ? "opencode" : "opencode-local"
  const backup = path.join(
    path.dirname(paths.sourceDatabase),
    `${path.basename(paths.sourceDatabase)}.${label}-rollback-${manifest.id}`,
  )
  if (
    manifest.backupDatabase !== backup ||
    manifest.backupRetentionManifest !== `${backup}.retention.json` ||
    manifest.retentionManifest !== path.join(paths.stagingDirectory, `rollback-retention-${manifest.id}.json`) ||
    manifest.activationJournal !== path.join(paths.stagingDirectory, `storage-activation-${manifest.id}.json`)
  )
    throw new Error("manifest", "Candidate manifest contains unsafe derived activation paths")
  if (!Array.isArray(manifest.blobs) || !Array.isArray(manifest.archives) || !Array.isArray(manifest.referencedBlobs))
    throw new Error("manifest", "Candidate manifest inventories are invalid")
  for (const entry of manifest.blobs) assertEntry(entry, paths.candidateBlobDirectory, paths.liveBlobDirectory, true)
  for (const entry of manifest.archives)
    assertEntry(entry, paths.candidateArchiveDirectory, paths.liveArchiveDirectory, false)
  if (!manifest.referencedBlobs.every((sha256) => typeof sha256 === "string" && SHA256.test(sha256)))
    throw new Error("manifest", "Candidate manifest has invalid referenced blob hashes")
  assertInventory(manifest.blobs, (entry) => entry.sha256)
  assertInventory(manifest.archives, (entry) => entry.target)
  if (!sortedUnique(manifest.referencedBlobs, (value) => value))
    throw new Error("manifest", "Candidate manifest referenced blob hashes must be sorted and unique")
  if (
    manifest.id !==
    manifestID(databaseKind, paths, manifest.source, manifest.candidate, manifest.blobs, manifest.archives)
  )
    throw new Error("manifest", "Candidate manifest ID does not match its complete cryptographic inventory")
}

async function inspectExclusive(filename: string): Promise<Fingerprint> {
  if (!(await exists(filename))) throw new Error("offline", `Database does not exist: ${filename}`)
  if ((await fileSize(`${filename}-wal`)) > 0 || (await exists(`${filename}-shm`)))
    throw new Error("offline", "Database has WAL/SHM state; stop every writer and checkpoint it before activation")
  // SQLite's Windows EXCLUSIVE lock covers the pending-byte range at 1 GiB.
  // Hashing a larger database through a second file handle while that lock is
  // held fails with EBUSY, even though both handles belong to this process.
  // Hash first, then prove the file stayed stable before validating it under
  // the exclusive transaction. Activation fingerprints the source again.
  const before = await stat(filename)
  const file = await fingerprintFile(filename)
  const hashed = await stat(filename)
  if (
    before.size !== hashed.size ||
    before.mtimeMs !== hashed.mtimeMs ||
    before.ctimeMs !== hashed.ctimeMs ||
    file.sizeBytes !== hashed.size
  )
    throw new Error("offline", "Database changed while its activation fingerprint was computed")
  const database = new Database(filename, { create: false, readwrite: true, strict: true })
  return Promise.resolve()
    .then(async () => {
      database.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE")
      assertSqlite(database, filename)
      const locked = await stat(filename)
      if (locked.size !== hashed.size || locked.mtimeMs !== hashed.mtimeMs || locked.ctimeMs !== hashed.ctimeMs)
        throw new Error("offline", "Database changed before exclusive activation validation")
      return {
        ...file,
        modifiedAt: locked.mtimeMs,
        pageCount: Number(database.query<Record<string, number>, []>("PRAGMA page_count").values()[0]?.[0] ?? 0),
        schemaVersion: Number(
          database.query<Record<string, number>, []>("PRAGMA schema_version").values()[0]?.[0] ?? 0,
        ),
        userVersion: Number(database.query<Record<string, number>, []>("PRAGMA user_version").values()[0]?.[0] ?? 0),
      }
    })
    .catch((cause) => {
      if (cause instanceof Error) throw cause
      throw new Error(
        "offline",
        "Could not acquire exclusive SQLite ownership; another process may still be using the database",
        {
          cause,
        },
      )
    })
    .finally(() =>
      Promise.resolve()
        .then(() => database.exec("ROLLBACK"))
        .catch(() => undefined)
        .finally(() => database.close()),
    )
}

async function inspectDatabase(filename: string): Promise<Fingerprint> {
  if (!(await exists(filename))) throw new Error("integrity", `Candidate database does not exist: ${filename}`)
  if ((await fileSize(`${filename}-wal`)) > 0 || (await exists(`${filename}-shm`)))
    throw new Error("integrity", `Candidate SQLite database is not self-contained: ${filename}`)
  const database = new Database(filename, { readonly: true, create: false, strict: true })
  return Promise.resolve()
    .then(() => {
      assertSqlite(database, filename)
      return fingerprintDatabase(database, filename)
    })
    .finally(() => database.close())
}

function assertSqlite(database: Database, filename: string) {
  const quick = database.query<Record<string, string>, []>("PRAGMA quick_check").all()
  if (quick.length !== 1 || Object.values(quick[0] ?? {})[0] !== "ok")
    throw new Error("integrity", `SQLite quick_check failed: ${filename}`)
  if (database.query<Record<string, unknown>, []>("PRAGMA foreign_key_check").all().length !== 0)
    throw new Error("integrity", `SQLite foreign_key_check failed: ${filename}`)
}

async function fingerprintDatabase(database: Database, filename: string): Promise<Fingerprint> {
  const file = await fingerprintFile(filename)
  return {
    ...file,
    modifiedAt: (await stat(filename)).mtimeMs,
    pageCount: Number(database.query<Record<string, number>, []>("PRAGMA page_count").values()[0]?.[0] ?? 0),
    schemaVersion: Number(database.query<Record<string, number>, []>("PRAGMA schema_version").values()[0]?.[0] ?? 0),
    userVersion: Number(database.query<Record<string, number>, []>("PRAGMA user_version").values()[0]?.[0] ?? 0),
  }
}

async function scanBlobs(sourceRoot: string, targetRoot: string) {
  const files = await regularFiles(sourceRoot)
  return mapConcurrent(files, 16, async (source) => {
    const relative = path.relative(sourceRoot, source)
    const sha256 = path.basename(source)
    if (!SHA256.test(sha256) || path.basename(path.dirname(source)) !== sha256.slice(0, 2))
      throw new Error("integrity", `Blob path is not content-addressed: ${source}`)
    const file = await fingerprintFile(source)
    if (file.sha256 !== sha256) throw new Error("integrity", `Blob content does not match its address: ${source}`)
    return { source, target: path.join(targetRoot, relative), ...file }
  }).then((entries) => entries.sort((a, b) => a.sha256.localeCompare(b.sha256)))
}

async function scanArchives(sourceRoot: string, targetRoot: string) {
  const files = await regularFiles(sourceRoot)
  if (files.some((filename) => ![".db", ".sqlite"].includes(path.extname(filename).toLowerCase())))
    throw new Error("integrity", "Candidate archive directory contains a non-SQLite file")
  return mapConcurrent(files, 4, async (source) => {
    await inspectDatabase(source)
    const relative = path.relative(sourceRoot, source)
    return { source, target: path.join(targetRoot, relative), ...(await fingerprintFile(source)) }
  }).then((entries) => entries.sort((a, b) => a.target.localeCompare(b.target)))
}

async function mapConcurrent<Input, Output>(
  items: ReadonlyArray<Input>,
  concurrency: number,
  run: (item: Input) => Promise<Output>,
) {
  const output = new Array<Output>(items.length)
  const queue = items.entries()
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      for (const [index, item] of queue) output[index] = await run(item)
    }),
  )
  return output
}

async function validateReferences(
  databasePath: string,
  archives: ReadonlyArray<FileEntry>,
  blobs: ReadonlyArray<FileEntry>,
  liveRoot: string,
  liveArchiveRoot: string,
) {
  const available = new Map(blobs.map((entry) => [entry.sha256, entry]))
  const refs = new Set<string>()
  for (const filename of [databasePath, ...archives.map((entry) => entry.source)]) {
    const database = new Database(filename, { readonly: true, create: false, strict: true })
    try {
      for (const table of ["attachment", "session_file_mutation", "archive_attachment_ref", "content_blob"])
        if (tableExists(database, table)) collectReferences(database, table, refs)
      if (tableExists(database, "content_blob")) {
        const rows = database
          .query<
            { readonly sha256: string; readonly size_bytes: number; readonly storage_path: string },
            []
          >("SELECT sha256, size_bytes, storage_path FROM content_blob")
          .all()
        for (const row of rows) {
          const blob = available.get(row.sha256)
          const relative = row.storage_path.replace(/^content[\\/]/, "")
          const expected = path.resolve(liveRoot, relative)
          if (!blob || blob.sizeBytes !== row.size_bytes || blob.target !== expected || !contains(liveRoot, expected))
            throw new Error(
              "integrity",
              `Content blob metadata does not resolve to the explicit live store: ${row.sha256}`,
            )
        }
      }
      if (filename === databasePath && tableExists(database, "session_archive_shard")) {
        const targets = new Set(archives.map((entry) => entry.target))
        for (const row of database
          .query<{ readonly path: string }, []>("SELECT path FROM session_archive_shard")
          .all()) {
          const target = path.resolve(row.path)
          if (!path.isAbsolute(row.path) || !contains(liveArchiveRoot, target) || !targets.has(target))
            throw new Error(
              "integrity",
              `Archive catalog points outside the explicit candidate archive set: ${row.path}`,
            )
        }
      }
    } finally {
      database.close()
    }
  }
  for (const sha256 of refs)
    if (!available.has(sha256)) throw new Error("integrity", `Referenced blob is missing: ${sha256}`)
  return [...refs].sort()
}

function collectReferences(database: Database, table: string, refs: Set<string>) {
  const queries = {
    attachment: "SELECT blob_sha256 AS sha256 FROM attachment WHERE blob_sha256 IS NOT NULL",
    session_file_mutation:
      "SELECT before_sha256 AS sha256 FROM session_file_mutation WHERE before_sha256 IS NOT NULL UNION SELECT after_sha256 FROM session_file_mutation WHERE after_sha256 IS NOT NULL",
    archive_attachment_ref: "SELECT blob_sha256 AS sha256 FROM archive_attachment_ref",
    content_blob: "SELECT sha256 FROM content_blob",
  } as const
  for (const row of database.query<{ readonly sha256: string }, []>(queries[table as keyof typeof queries]).all()) {
    if (!SHA256.test(row.sha256)) throw new Error("integrity", `Database contains an invalid blob hash: ${row.sha256}`)
    refs.add(row.sha256)
  }
}

function tableExists(database: Database, table: string) {
  return Boolean(database.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table))
}

async function regularFiles(root: string): Promise<string[]> {
  const canonicalRoot = await realpath(root)
  const walk = async (directory: string): Promise<string[]> => {
    const entries = await readdir(directory, { withFileTypes: true })
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const filename = path.join(directory, entry.name)
        const info = await lstat(filename)
        if (info.isSymbolicLink()) throw new Error("integrity", `Activation roots cannot contain symlinks: ${filename}`)
        if (info.isDirectory()) return walk(filename)
        if (!info.isFile())
          throw new Error("integrity", `Activation roots may contain only files and directories: ${filename}`)
        const canonical = await realpath(filename)
        if (!contains(canonicalRoot, canonical))
          throw new Error("integrity", `Activation file escapes its root: ${filename}`)
        return [canonical]
      }),
    )
    return nested.flat()
  }
  return walk(canonicalRoot)
}

async function fingerprintFile(filename: string) {
  const info = await stat(filename)
  const hash = createHash("sha256")
  await new Promise<void>((resolve, reject) => {
    createReadStream(filename)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", resolve)
  })
  return { sizeBytes: info.size, sha256: hash.digest("hex") }
}

async function readManifest(filename: string): Promise<Manifest> {
  const value = await readJson(filename)
  if (!isRecord(value) || value.version !== 1 || value.kind !== "opencode-storage-candidate")
    throw new Error("manifest", "Unsupported storage candidate manifest")
  return value as Manifest
}

async function readJournal(filename: string, manifestID: string): Promise<Journal | undefined> {
  if (!(await exists(filename))) return undefined
  if ((await lstat(filename)).isSymbolicLink())
    throw new Error("manifest", "Storage activation journal cannot be a symlink")
  const value = await readJson(filename)
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.kind !== "opencode-storage-activation" ||
    value.manifestID !== manifestID ||
    !Array.isArray(value.events)
  )
    throw new Error("manifest", "Unsupported storage activation journal")
  let expected = 0
  let completed = false
  for (const event of value.events) {
    if (
      completed ||
      !isRecord(event) ||
      typeof event.state !== "string" ||
      ![...PROGRESS, "restored"].includes(event.state as Progress) ||
      !Number.isSafeInteger(event.time) ||
      Number(event.time) < 0
    )
      throw new Error("manifest", "Storage activation journal contains an invalid or post-completion event")
    if (event.state === "restored") {
      if (expected < PROGRESS.indexOf("candidate-active"))
        throw new Error("manifest", "Storage activation journal restores before the source move")
      expected = 0
      continue
    }
    if (PROGRESS[expected] !== event.state)
      throw new Error("manifest", `Storage activation journal has an invalid transition to ${event.state}`)
    expected += 1
    if (event.state === "completed") completed = true
  }
  return value as Journal
}

async function readRollbackJournal(
  filename: string,
  manifestID: string,
  preservedCandidateDatabase: string,
): Promise<RollbackJournal | undefined> {
  if (!(await exists(filename))) return undefined
  if ((await lstat(filename)).isSymbolicLink())
    throw new Error("manifest", "Storage rollback journal cannot be a symlink")
  const value = await readJson(filename)
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.kind !== "opencode-storage-rollback" ||
    value.manifestID !== manifestID ||
    value.preservedCandidateDatabase !== preservedCandidateDatabase ||
    !Array.isArray(value.events)
  )
    throw new Error("manifest", "Unsupported storage rollback journal")
  for (const [index, event] of value.events.entries())
    if (
      !isRecord(event) ||
      event.state !== ROLLBACK_PROGRESS[index] ||
      !Number.isSafeInteger(event.time) ||
      Number(event.time) < 0
    )
      throw new Error("manifest", "Storage rollback journal contains an invalid transition")
  if (value.events.length > ROLLBACK_PROGRESS.length)
    throw new Error("manifest", "Storage rollback journal contains post-completion events")
  return value as RollbackJournal
}

async function readJson(filename: string): Promise<unknown> {
  const info = await stat(filename).catch((cause) => {
    throw new Error("manifest", `Cannot read manifest: ${filename}`, { cause })
  })
  if (info.size > MAX_MANIFEST_BYTES) throw new Error("manifest", `Manifest is too large: ${filename}`)
  return readFile(filename, "utf8")
    .then((value) => JSON.parse(value) as unknown)
    .catch((cause) => {
      throw new Error("manifest", `Manifest is not valid JSON: ${filename}`, { cause })
    })
}

async function writeDurable(filename: string, value: unknown) {
  await mkdir(path.dirname(filename), { recursive: true })
  if ((await exists(filename)) && (await lstat(filename)).isSymbolicLink())
    throw new Error("filesystem", `Durable activation file cannot replace a symlink: ${filename}`)
  const temporary = `${filename}.${randomUUID()}.tmp`
  await Promise.resolve()
    .then(() => writeFile(temporary, JSON.stringify(value, null, 2) + "\n"))
    .then(() => syncFile(temporary))
    .then(() => replaceDurable(temporary, filename))
    .then(() => syncDirectory(path.dirname(filename)))
    .finally(() => rm(temporary, { force: true }))
}

async function replaceDurable(temporary: string, filename: string) {
  try {
    await rename(temporary, filename)
    return
  } catch (cause) {
    if (!(await exists(filename))) {
      await retryTransientFileOperation(() => rename(temporary, filename))
      return
    }
    const current = `${filename}.${randomUUID()}.replace`
    await retryTransientFileOperation(() => rename(filename, current))
    try {
      await retryTransientFileOperation(() => rename(temporary, filename))
      await retryTransientFileOperation(() => rm(current, { force: true })).catch(() => undefined)
    } catch (replacementCause) {
      await retryTransientFileOperation(() => rename(current, filename)).catch(() => undefined)
      throw replacementCause
    }
    if (!(await exists(filename))) throw cause
  }
}

async function retryTransientFileOperation(operation: () => Promise<void>, attempt = 0): Promise<void> {
  try {
    await operation()
  } catch (cause) {
    if (!transientFileError(cause) || attempt >= 20) throw cause
    await setTimeout(Math.min(100, 5 * 2 ** attempt))
    await retryTransientFileOperation(operation, attempt + 1)
  }
}

function transientFileError(cause: unknown) {
  return (
    cause instanceof globalThis.Error && "code" in cause && ["EACCES", "EBUSY", "EPERM"].includes(String(cause.code))
  )
}

async function syncFile(filename: string) {
  const handle = await open(filename, "r")
  await handle
    .sync()
    .catch((cause) => {
      if (isUnsupportedSync(cause)) return
      throw cause
    })
    .finally(() => handle.close())
}

async function syncDirectory(directory: string) {
  const handle = await open(directory, "r").catch(() => undefined)
  if (!handle) return
  await handle
    .sync()
    .catch((cause) => {
      if (isUnsupportedSync(cause)) return
      throw cause
    })
    .finally(() => handle.close())
}

async function assertSameVolume(source: string, candidate: string) {
  if ((await stat(path.dirname(source))).dev !== (await stat(candidate)).dev)
    throw new Error("configuration", "Atomic activation requires source and candidate on the same filesystem volume")
}

function sameFingerprint(left: Fingerprint, right: Fingerprint) {
  return left.modifiedAt === right.modifiedAt && sameFingerprintIgnoringTime(left, right)
}

function sameFingerprintIgnoringTime(left: Fingerprint, right: Fingerprint) {
  return (
    left.sizeBytes === right.sizeBytes &&
    left.sha256 === right.sha256 &&
    left.pageCount === right.pageCount &&
    left.schemaVersion === right.schemaVersion &&
    left.userVersion === right.userVersion
  )
}

function contains(root: string, child: string) {
  const relative = path.relative(path.resolve(root), path.resolve(child))
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function overlaps(left: string, right: string) {
  return path.resolve(left) === path.resolve(right) || contains(left, right) || contains(right, left)
}

async function exists(filename: string) {
  return lstat(filename)
    .then(() => true)
    .catch(() => false)
}

async function fileSize(filename: string) {
  return stat(filename)
    .then((info) => info.size)
    .catch(() => 0)
}

async function assertNotSymlink(filename: string) {
  if (!(await exists(filename))) return
  const info = await lstat(filename)
  if (info.isSymbolicLink()) throw new Error("configuration", `Activation path cannot be a symlink: ${filename}`)
}

async function canonicalFuturePath(filename: string): Promise<string> {
  if (await exists(filename)) return realpath(filename)
  const parent = path.dirname(filename)
  if (parent === filename) return path.resolve(filename)
  return path.join(await canonicalFuturePath(parent), path.basename(filename))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validFingerprint(value: unknown): value is Fingerprint {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.sizeBytes) &&
    Number(value.sizeBytes) >= 0 &&
    typeof value.modifiedAt === "number" &&
    typeof value.sha256 === "string" &&
    SHA256.test(value.sha256) &&
    Number.isSafeInteger(value.pageCount) &&
    Number.isSafeInteger(value.schemaVersion) &&
    Number.isSafeInteger(value.userVersion)
  )
}

function assertEntry(entry: FileEntry, sourceRoot: string, targetRoot: string, contentAddressed: boolean) {
  if (
    !isRecord(entry) ||
    typeof entry.source !== "string" ||
    typeof entry.target !== "string" ||
    typeof entry.sha256 !== "string" ||
    !SHA256.test(entry.sha256) ||
    !Number.isSafeInteger(entry.sizeBytes) ||
    Number(entry.sizeBytes) < 0 ||
    !path.isAbsolute(entry.source) ||
    !path.isAbsolute(entry.target) ||
    !contains(sourceRoot, entry.source) ||
    !contains(targetRoot, entry.target) ||
    (contentAddressed && path.basename(entry.source) !== entry.sha256)
  )
    throw new Error("manifest", "Candidate manifest contains an unsafe file inventory entry")
}

function assertInventory(entries: ReadonlyArray<FileEntry>, sortKey: (entry: FileEntry) => string) {
  if (
    !sortedUnique(entries, sortKey) ||
    new Set(entries.map((entry) => entry.source)).size !== entries.length ||
    new Set(entries.map((entry) => entry.target)).size !== entries.length ||
    new Set(entries.map((entry) => entry.sha256)).size !== entries.length
  )
    throw new Error(
      "manifest",
      "Candidate manifest inventories must be sorted with unique sources, targets, and hashes",
    )
}

function sortedUnique<Value>(values: ReadonlyArray<Value>, key: (value: Value) => string) {
  const keys = values.map(key)
  return keys.every((value, index) => index === 0 || keys[index - 1]! < value)
}

function manifestID(
  databaseKind: DatabaseKind,
  paths: Paths,
  source: Fingerprint,
  candidate: Fingerprint,
  blobs: ReadonlyArray<FileEntry>,
  archives: ReadonlyArray<FileEntry>,
) {
  return createHash("sha256")
    .update(JSON.stringify({ databaseKind, paths, source, candidate, blobs, archives }))
    .digest("hex")
    .slice(0, 24)
}

function isUnsupportedSync(value: unknown) {
  return isRecord(value) && ["EPERM", "EINVAL", "ENOTSUP", "EISDIR"].includes(String(value.code))
}
