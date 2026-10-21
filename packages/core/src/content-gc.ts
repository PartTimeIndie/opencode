export * as ContentGC from "./content-gc"

import { Database } from "bun:sqlite"
import { createHash, randomUUID } from "crypto"
import { createReadStream } from "fs"
import { lstat, mkdir, open, readdir, realpath, rename, stat, unlink } from "fs/promises"
import path from "path"
import { Hash } from "./util/hash"

const SHA256 = /^[0-9a-f]{64}$/
const PREFIX = /^[0-9a-f]{2}$/
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024
const COLLECTION_LOCK = "content-gc.lock"
const STALE_LOCK_MS = 5 * 60 * 1_000
const BACKUP_FILE = /(?:\.bak(?:-|$)|\.backup(?:-|$)|\.(?:opencode|opencode-local)-rollback-[0-9a-f]{24}$)/i
const ARCHIVE_FILE = /\.(?:db|sqlite)$/i
const RETENTION_FILE = /(?:^rollback-retention-[0-9a-f]+\.json$|\.retention\.json$)/i

export type DatabaseKind = "active" | "local" | "backup"

export type DatabaseSource = {
  readonly kind: DatabaseKind
  readonly path: string
}

export type Input = {
  readonly storeDirectory: string
  readonly journalDirectory: string
  readonly databases: ReadonlyArray<DatabaseSource>
  readonly archiveShards: ReadonlyArray<string>
  readonly rollbackManifests: ReadonlyArray<string>
}

export type SourceInventory = {
  readonly version: 1
  readonly kind: "opencode-content-gc-source-inventory"
  readonly status: "complete"
  readonly storeDirectory: string
  readonly databases: ReadonlyArray<DatabaseSource>
  readonly databaseFiles: ReadonlyArray<InventoryFile>
  readonly archiveShards: ReadonlyArray<string>
  readonly rollbackManifests: ReadonlyArray<string>
  readonly roots: {
    readonly backups: InventoryRoot
    readonly archives: InventoryRoot
    readonly rollbackManifests: InventoryRoot
  }
  readonly completeness: {
    readonly activeDatabases: true
    readonly localDatabases: true
    readonly backupDatabases: true
    readonly archiveShards: true
    readonly rollbackManifests: true
  }
  readonly confirmedAbsent: {
    readonly activeDatabase: boolean
    readonly localDatabase: boolean
  }
  readonly digest: string
}

export type InventoryRoot = {
  readonly directories: ReadonlyArray<string>
  readonly confirmedEmpty: boolean
  readonly files: ReadonlyArray<InventoryFile>
}

export type InventoryFile = {
  readonly path: string
  readonly sizeBytes: number
  readonly modifiedAt: number
  readonly device: string
  readonly inode: string
  readonly sha256: string
}

type InventoryIdentity = Omit<InventoryFile, "sha256">

export type InventoryScope = {
  readonly backupDirectories: ReadonlyArray<string>
  readonly archiveDirectories: ReadonlyArray<string>
  readonly rollbackManifestDirectories: ReadonlyArray<string>
  readonly confirmNoBackups: boolean
  readonly confirmNoArchives: boolean
  readonly confirmNoRollbackManifests: boolean
  readonly confirmNoActiveDatabase: boolean
  readonly confirmNoLocalDatabase: boolean
}

export type PlanOptions = {
  readonly inventory?: string
}

export type Candidate = {
  readonly sha256: string
  readonly path: string
  readonly sizeBytes: number
}

export type Plan = {
  readonly version: 1
  readonly digest: string
  readonly reachabilityDigest: string
  readonly storeDirectory: string
  readonly candidates: ReadonlyArray<Candidate>
  readonly storedBlobs: number
  readonly reachableBlobs: number
  readonly candidateBytes: number
  readonly sources: {
    readonly databases: number
    readonly archiveShards: number
    readonly rollbackManifests: number
  }
  readonly safety: {
    readonly completeSourceInventory: boolean
    readonly offlineRequired: true
    readonly sqliteWriterLocks: true
    readonly reachabilityRecheckedBeforeEachDelete: true
  }
}

export type Progress =
  | { readonly state: "requested"; readonly digest: string }
  | { readonly state: "deleted"; readonly digest: string; readonly sha256: string }
  | { readonly state: "completed"; readonly digest: string }

export type CollectOptions = {
  /**
   * Collection is destructive and may only run after every OpenCode process and
   * external writer of the listed databases, shards, and manifests is stopped.
   * SQLite writer locks and per-candidate rescans enforce that boundary for the
   * listed mutable SQLite sources; the caller owns complete source enumeration.
   */
  readonly offline: true
  /** Immutable explicit inventory attesting that every source category is complete. */
  readonly inventory: string
  readonly onProgress?: (progress: Progress) => void | Promise<void>
  /** Operational instrumentation; strong validation is allowed exactly once under locks. */
  readonly onInventoryValidation?: (mode: "strong" | "light") => void | Promise<void>
}

export type CollectResult = {
  readonly digest: string
  readonly deleted: ReadonlyArray<string>
  readonly resumed: boolean
  readonly completed: boolean
  readonly journal: string
}

export class Error extends globalThis.Error {
  readonly code: "configuration" | "database" | "manifest" | "integrity" | "digest" | "journal" | "filesystem"

  constructor(code: Error["code"], message: string, options?: { readonly cause?: unknown }) {
    super(message, options)
    this.name = "ContentGC.Error"
    this.code = code
  }
}

type StoredBlob = Candidate

type SourceFingerprint = {
  readonly type: "database" | "archive" | "manifest" | "inventory"
  readonly kind?: DatabaseKind
  readonly path: string
  readonly refs: ReadonlyArray<string>
  readonly digest?: string
}

type Scan = {
  readonly plan: Plan
  readonly stored: ReadonlyArray<StoredBlob>
  readonly reachable: ReadonlyArray<string>
  readonly sourceFingerprints: ReadonlyArray<SourceFingerprint>
}

type JournalEvent =
  | { readonly state: "requested"; readonly time: number }
  | { readonly state: "deleted"; readonly sha256: string; readonly time: number; readonly recovered?: true }
  | { readonly state: "completed"; readonly time: number }

type Journal = {
  readonly version: 1
  readonly digest: string
  readonly reachabilityDigest: string
  readonly storeDirectory: string
  readonly stored: ReadonlyArray<StoredBlob>
  readonly candidates: ReadonlyArray<Candidate>
  readonly sourceFingerprints: ReadonlyArray<SourceFingerprint>
  readonly events: ReadonlyArray<JournalEvent>
}

export async function createSourceInventory(input: Input, scope: InventoryScope): Promise<SourceInventory> {
  return buildSourceInventory(input, scope, "configuration")
}

async function buildSourceInventory(
  input: Input,
  scope: InventoryScope,
  sourceChangeCode: "configuration" | "digest",
): Promise<SourceInventory> {
  const config = await validateInput(input)
  validatePrimaryDatabases(config, scope)
  const roots = await scanInventoryRoots(config, scope, sourceChangeCode)
  const databaseFiles = await Promise.all(
    config.databases.toSorted(compareDatabaseSource).map((source) => fingerprintInventoryFile(source.path)),
  )
  const value = {
    version: 1 as const,
    kind: "opencode-content-gc-source-inventory" as const,
    status: "complete" as const,
    storeDirectory: config.storeDirectory,
    databases: config.databases.toSorted(compareDatabaseSource),
    databaseFiles,
    archiveShards: config.archiveShards.toSorted(comparePath),
    rollbackManifests: config.rollbackManifests.toSorted(comparePath),
    roots,
    completeness: {
      activeDatabases: true as const,
      localDatabases: true as const,
      backupDatabases: true as const,
      archiveShards: true as const,
      rollbackManifests: true as const,
    },
    confirmedAbsent: {
      activeDatabase: scope.confirmNoActiveDatabase,
      localDatabase: scope.confirmNoLocalDatabase,
    },
  }
  return { ...value, digest: Hash.sha256(JSON.stringify(value)) }
}

export async function plan(input: Input, options?: PlanOptions): Promise<Plan> {
  return (await scan(input, options?.inventory)).plan
}

export async function collect(input: Input, digest: string, options: CollectOptions): Promise<CollectResult> {
  if (!options?.offline)
    throw new Error(
      "configuration",
      "Content collection requires an explicit offline confirmation after all OpenCode and external source writers are stopped",
    )
  if (!SHA256.test(digest)) throw new Error("digest", "Collection requires a valid exact plan digest")
  const config = await validateInput(input)
  const inventory = await readValidatedSourceInventory(options.inventory, config)
  const release = await acquireCollectionLocks(config)
  try {
    return await collectLocked(config, inventory, digest, options)
  } finally {
    await release()
  }
}

async function collectLocked(
  config: ValidatedInput,
  inventory: ValidatedInventory,
  digest: string,
  options: CollectOptions,
): Promise<CollectResult> {
  const journalPath = path.join(config.journalDirectory, `content-gc-${digest}.json`)
  const existing = await readJournal(journalPath)
  if (existing && existing.digest !== digest)
    throw new Error("journal", "GC journal digest does not match the requested collection")
  if (existing?.events.some((event) => event.state === "completed"))
    return {
      digest,
      deleted: existing.events.flatMap((event) => (event.state === "deleted" ? [event.sha256] : [])),
      resumed: true,
      completed: true,
      journal: journalPath,
    }

  const current = await scanValidated(config, inventory, "strong", options.onInventoryValidation)
  if (!existing && current.plan.digest !== digest)
    throw new Error("digest", "GC plan changed before collection; create and confirm a new dry-run")
  const journal = existing ?? {
    version: 1 as const,
    digest,
    reachabilityDigest: current.plan.reachabilityDigest,
    storeDirectory: current.plan.storeDirectory,
    stored: current.stored,
    candidates: current.plan.candidates,
    sourceFingerprints: current.sourceFingerprints,
    events: [{ state: "requested" as const, time: Date.now() }],
  }
  validateResume(journal, current)
  if (!existing) {
    await writeJournal(journalPath, journal)
    await options.onProgress?.({ state: "requested", digest })
  }

  const deleted = new Set(journal.events.flatMap((event) => (event.state === "deleted" ? [event.sha256] : [])))
  let next = journal

  for (const candidate of journal.candidates) {
    if (deleted.has(candidate.sha256)) continue
    // The offline contract plus held SQLite writer transactions closes the
    // scan-to-unlink boundary for listed mutable sources. Re-scan immediately
    // before every candidate as a second fail-closed guard for manifests,
    // resumed journals, and any writer that violates the offline contract.
    const boundary = await scanValidated(config, inventory, "light", options.onInventoryValidation)
    validateResume(next, boundary)
    const currentByHash = new Map(boundary.stored.map((blob) => [blob.sha256, blob]))
    const stored = currentByHash.get(candidate.sha256)
    if (!stored) {
      next = {
        ...next,
        events: [...next.events, { state: "deleted", sha256: candidate.sha256, time: Date.now(), recovered: true }],
      }
      deleted.add(candidate.sha256)
      await writeJournal(journalPath, next)
      await options.onProgress?.({ state: "deleted", digest, sha256: candidate.sha256 })
      continue
    }
    await verifyCandidate(config.storeDirectory, candidate, stored)
    await unlink(stored.path).catch((cause) => {
      throw new Error("filesystem", `Failed to delete managed blob ${stored.sha256}`, { cause })
    })
    next = {
      ...next,
      events: [...next.events, { state: "deleted", sha256: candidate.sha256, time: Date.now() }],
    }
    deleted.add(candidate.sha256)
    await writeJournal(journalPath, next)
    await options.onProgress?.({ state: "deleted", digest, sha256: candidate.sha256 })
  }

  const final = await scanValidated(config, inventory, "light", options.onInventoryValidation)
  validateCompletion(next, final)
  next = { ...next, events: [...next.events, { state: "completed", time: Date.now() }] }
  await writeJournal(journalPath, next)
  await options.onProgress?.({ state: "completed", digest })
  return {
    digest,
    deleted: [...deleted].sort(),
    resumed: existing !== undefined,
    completed: true,
    journal: journalPath,
  }
}

async function scan(input: Input, inventoryPath?: string) {
  const config = await validateInput(input)
  return scanValidated(
    config,
    inventoryPath ? await readValidatedSourceInventory(inventoryPath, config) : undefined,
    "light",
  )
}

type ValidatedInput = {
  readonly storeDirectory: string
  readonly journalDirectory: string
  readonly databases: ReadonlyArray<DatabaseSource>
  readonly archiveShards: ReadonlyArray<string>
  readonly rollbackManifests: ReadonlyArray<string>
}

type ValidatedInventory = {
  readonly path: string
  readonly digest: string
  readonly value: SourceInventory
}

async function validateInput(input: Input): Promise<ValidatedInput> {
  if (input.databases.length + input.archiveShards.length + input.rollbackManifests.length === 0)
    throw new Error("configuration", "At least one explicit reachability source is required")
  const storeDirectory = await requireDirectory(input.storeDirectory, "store")
  await mkdir(input.journalDirectory, { recursive: true }).catch((cause) => {
    throw new Error("filesystem", "Failed to create the explicit GC journal directory", { cause })
  })
  const journalDirectory = await requireDirectory(input.journalDirectory, "journal")
  if (contains(storeDirectory, journalDirectory) || contains(journalDirectory, storeDirectory))
    throw new Error("configuration", "GC journal and content store directories must not contain each other")

  const databases = await Promise.all(
    input.databases.map(async (source) => {
      if (!(["active", "local", "backup"] as const).includes(source.kind))
        throw new Error("configuration", `Unsupported explicit database kind: ${source.kind}`)
      return { ...source, path: await requireFile(source.path, "database") }
    }),
  )
  const archiveShards = await Promise.all(input.archiveShards.map((filename) => requireFile(filename, "archive")))
  const rollbackManifests = await Promise.all(
    input.rollbackManifests.map((filename) => requireFile(filename, "manifest")),
  )
  const allSources = [...databases.map((source) => source.path), ...archiveShards, ...rollbackManifests]
  if (new Set(allSources.map(normalizeCase)).size !== allSources.length)
    throw new Error("configuration", "Reachability source paths must be unique")
  if (allSources.some((filename) => contains(storeDirectory, filename)))
    throw new Error("configuration", "Reachability sources must be outside the managed content store")
  return { storeDirectory, journalDirectory, databases, archiveShards, rollbackManifests }
}

async function readValidatedSourceInventory(
  filename: string | undefined,
  input: ValidatedInput,
): Promise<ValidatedInventory> {
  if (!filename)
    throw new Error(
      "configuration",
      "Content collection requires an explicit complete source inventory; create one from every active, local, backup, archive, and rollback source",
    )
  const inventoryPath = await requireFile(filename, "source inventory")
  if (contains(input.storeDirectory, inventoryPath))
    throw new Error("configuration", "Content GC source inventory must be outside the managed content store")
  const value = await readSourceInventory(inventoryPath)
  assertInventorySourcePaths(value, input)
  return { path: inventoryPath, digest: value.digest, value }
}

async function validateSourceInventoryState(
  inventory: ValidatedInventory,
  input: ValidatedInput,
  mode: "strong" | "light",
) {
  const value = await readSourceInventory(inventory.path)
  if (value.digest !== inventory.digest || JSON.stringify(value) !== JSON.stringify(inventory.value))
    throw new Error("digest", "Content GC source inventory changed after validation")
  assertInventorySourcePaths(value, input)
  if (mode === "light") {
    await validateLightInventoryState(value)
    return
  }
  const expected = await buildSourceInventory(
    {
      storeDirectory: input.storeDirectory,
      journalDirectory: input.journalDirectory,
      databases: input.databases,
      archiveShards: input.archiveShards,
      rollbackManifests: input.rollbackManifests,
    },
    {
      backupDirectories: value.roots.backups.directories,
      archiveDirectories: value.roots.archives.directories,
      rollbackManifestDirectories: value.roots.rollbackManifests.directories,
      confirmNoBackups: value.roots.backups.confirmedEmpty,
      confirmNoArchives: value.roots.archives.confirmedEmpty,
      confirmNoRollbackManifests: value.roots.rollbackManifests.confirmedEmpty,
      confirmNoActiveDatabase: value.confirmedAbsent.activeDatabase,
      confirmNoLocalDatabase: value.confirmedAbsent.localDatabase,
    },
    "digest",
  )
  if (JSON.stringify(value) !== JSON.stringify(expected))
    throw new Error("digest", "Authoritative GC source inventory changed; create and confirm a new inventory")
}

async function readSourceInventory(filename: string): Promise<SourceInventory> {
  const info = await stat(filename).catch((cause) => {
    throw new Error("manifest", `Cannot stat content GC source inventory: ${filename}`, { cause })
  })
  if (info.size > MAX_MANIFEST_BYTES)
    throw new Error("manifest", `Content GC source inventory exceeds ${MAX_MANIFEST_BYTES} bytes: ${filename}`)
  const value = await Bun.file(filename)
    .json()
    .catch((cause) => {
      throw new Error("manifest", `Content GC source inventory is not valid JSON: ${filename}`, { cause })
    })
  if (
    !record(value) ||
    value.version !== 1 ||
    value.kind !== "opencode-content-gc-source-inventory" ||
    value.status !== "complete" ||
    typeof value.storeDirectory !== "string" ||
    !Array.isArray(value.databases) ||
    !Array.isArray(value.databaseFiles) ||
    !value.databaseFiles.every(validInventoryFile) ||
    !Array.isArray(value.archiveShards) ||
    !Array.isArray(value.rollbackManifests) ||
    !record(value.roots) ||
    !validInventoryRoot(value.roots.backups) ||
    !validInventoryRoot(value.roots.archives) ||
    !validInventoryRoot(value.roots.rollbackManifests) ||
    !record(value.confirmedAbsent) ||
    typeof value.confirmedAbsent.activeDatabase !== "boolean" ||
    typeof value.confirmedAbsent.localDatabase !== "boolean" ||
    typeof value.digest !== "string" ||
    !SHA256.test(value.digest) ||
    !validInventoryCompleteness(value.completeness)
  )
    throw new Error("manifest", `Unsupported or incomplete content GC source inventory: ${filename}`)
  if (
    !value.databases.every(
      (source) =>
        record(source) &&
        ["active", "local", "backup"].includes(String(source.kind)) &&
        typeof source.path === "string",
    ) ||
    !value.archiveShards.every((source) => typeof source === "string") ||
    !value.rollbackManifests.every((source) => typeof source === "string")
  )
    throw new Error("manifest", `Content GC source inventory has invalid explicit sources: ${filename}`)
  const body = { ...value }
  delete (body as { digest?: unknown }).digest
  if (Hash.sha256(JSON.stringify(body)) !== value.digest)
    throw new Error("manifest", `Content GC source inventory digest is invalid: ${filename}`)
  return value as SourceInventory
}

function assertInventorySourcePaths(value: SourceInventory, input: ValidatedInput) {
  const databases = input.databases.toSorted(compareDatabaseSource)
  const archives = input.archiveShards.toSorted(comparePath)
  const manifests = input.rollbackManifests.toSorted(comparePath)
  if (
    JSON.stringify(value.databases) !== JSON.stringify(databases) ||
    JSON.stringify(value.archiveShards) !== JSON.stringify(archives) ||
    JSON.stringify(value.rollbackManifests) !== JSON.stringify(manifests) ||
    normalizeCase(value.storeDirectory) !== normalizeCase(input.storeDirectory)
  )
    throw new Error(
      "configuration",
      "Explicit GC sources do not exactly match the complete source inventory; create and confirm a new inventory",
    )
}

function validatePrimaryDatabases(input: ValidatedInput, scope: InventoryScope) {
  const active = input.databases.filter((source) => source.kind === "active").length
  const local = input.databases.filter((source) => source.kind === "local").length
  if ((active === 0) !== scope.confirmNoActiveDatabase)
    throw new Error(
      "configuration",
      "Active database inventory requires at least one explicit database or --no-active-database",
    )
  if ((local === 0) !== scope.confirmNoLocalDatabase)
    throw new Error(
      "configuration",
      "Local database inventory requires at least one explicit database or --no-local-database",
    )
}

async function scanInventoryRoots(
  input: ValidatedInput,
  scope: InventoryScope,
  sourceChangeCode: "configuration" | "digest",
): Promise<SourceInventory["roots"]> {
  const backups = await scanInventoryRoot(
    scope.backupDirectories,
    scope.confirmNoBackups,
    BACKUP_FILE,
    input.databases.filter((source) => source.kind === "backup").map((source) => source.path),
    "backup database",
    sourceChangeCode,
  )
  const archives = await scanInventoryRoot(
    scope.archiveDirectories,
    scope.confirmNoArchives,
    ARCHIVE_FILE,
    input.archiveShards,
    "archive shard",
    sourceChangeCode,
  )
  const rollbackManifests = await scanInventoryRoot(
    scope.rollbackManifestDirectories,
    scope.confirmNoRollbackManifests,
    RETENTION_FILE,
    input.rollbackManifests,
    "rollback manifest",
    sourceChangeCode,
  )
  return { backups, archives, rollbackManifests }
}

async function scanInventoryRoot(
  directories: ReadonlyArray<string>,
  confirmedEmpty: boolean,
  match: RegExp,
  expected: ReadonlyArray<string>,
  label: string,
  sourceChangeCode: "configuration" | "digest",
): Promise<InventoryRoot> {
  if ((directories.length === 0) === !confirmedEmpty)
    throw new Error(
      "configuration",
      `${label} inventory requires either authoritative roots or an explicit confirmed-empty declaration`,
    )
  const roots = await Promise.all(directories.map((directory) => requireDirectory(directory, `${label} root`)))
  if (new Set(roots.map(normalizeCase)).size !== roots.length)
    throw new Error("configuration", `${label} inventory roots must be unique`)
  const files = (await Promise.all(roots.map((directory) => inventoryFiles(directory, match))))
    .flat()
    .toSorted((a, b) => comparePath(a.path, b.path))
  if (new Set(files.map((file) => normalizeCase(file.path))).size !== files.length)
    throw new Error("configuration", `${label} inventory roots overlap`)
  if (
    JSON.stringify(files.map((file) => normalizeCase(file.path))) !==
    JSON.stringify(expected.map(normalizeCase).toSorted())
  )
    throw new Error(sourceChangeCode, `Explicit ${label} sources do not match the current authoritative root inventory`)
  return {
    directories: roots.toSorted(comparePath),
    confirmedEmpty,
    files,
  }
}

async function inventoryFiles(root: string, match: RegExp): Promise<InventoryFile[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch((cause) => {
    throw new Error("filesystem", `Cannot scan authoritative source root: ${root}`, { cause })
  })
  return (
    await Promise.all(
      entries.map(async (entry): Promise<InventoryFile[]> => {
        const filename = path.join(root, entry.name)
        if (entry.isDirectory() && !entry.isSymbolicLink()) return inventoryFiles(filename, match)
        if (!entry.isFile() || entry.isSymbolicLink() || !match.test(entry.name)) return []
        const actual = await realpath(filename).catch((cause) => {
          throw new Error("integrity", `Cannot resolve authoritative source file: ${filename}`, { cause })
        })
        if (!contains(root, actual))
          throw new Error("integrity", `Authoritative source file escapes its root: ${filename}`)
        return [await fingerprintInventoryFile(actual)]
      }),
    )
  ).flat()
}

async function fingerprintInventoryFile(filename: string): Promise<InventoryFile> {
  return { ...(await inventoryFileIdentity(filename)), sha256: await hashFile(filename) }
}

async function inventoryFileIdentity(filename: string): Promise<InventoryIdentity> {
  const info = await lstat(filename).catch((cause) => {
    throw new Error("integrity", `Cannot stat authoritative source file: ${filename}`, { cause })
  })
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("integrity", `Authoritative source is not a regular file: ${filename}`)
  return {
    path: filename,
    sizeBytes: info.size,
    modifiedAt: info.mtimeMs,
    device: String(info.dev),
    inode: String(info.ino),
  }
}

async function validateLightInventoryState(value: SourceInventory) {
  await Promise.all(value.databaseFiles.map(validateInventoryFileIdentity))
  const roots: ReadonlyArray<readonly [InventoryRoot, RegExp]> = [
    [value.roots.backups, BACKUP_FILE],
    [value.roots.archives, ARCHIVE_FILE],
    [value.roots.rollbackManifests, RETENTION_FILE],
  ]
  await Promise.all(
    roots.map(async ([expected, pattern]) => {
      if (expected.confirmedEmpty) return
      const current = (
        await Promise.all(expected.directories.map((directory) => inventoryIdentities(directory, pattern)))
      )
        .flat()
        .toSorted((a, b) => comparePath(a.path, b.path))
      if (JSON.stringify(current) !== JSON.stringify(expected.files.map(inventoryIdentity)))
        throw new Error("digest", "Authoritative GC source root changed after inventory confirmation")
    }),
  )
}

async function inventoryIdentities(root: string, match: RegExp): Promise<InventoryIdentity[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch((cause) => {
    throw new Error("filesystem", `Cannot scan authoritative source root: ${root}`, { cause })
  })
  return (
    await Promise.all(
      entries.map(async (entry): Promise<InventoryIdentity[]> => {
        const filename = path.join(root, entry.name)
        if (entry.isDirectory() && !entry.isSymbolicLink()) return inventoryIdentities(filename, match)
        if (!entry.isFile() || entry.isSymbolicLink() || !match.test(entry.name)) return []
        const actual = await realpath(filename)
        if (!contains(root, actual))
          throw new Error("integrity", `Authoritative source file escapes its root: ${filename}`)
        return [await inventoryFileIdentity(actual)]
      }),
    )
  ).flat()
}

async function validateInventoryFileIdentity(expected: InventoryFile) {
  const current = await inventoryFileIdentity(expected.path)
  if (JSON.stringify(current) !== JSON.stringify(inventoryIdentity(expected)))
    throw new Error("digest", `Authoritative GC source changed after inventory confirmation: ${expected.path}`)
}

function inventoryIdentity(file: InventoryFile): InventoryIdentity {
  return {
    path: file.path,
    sizeBytes: file.sizeBytes,
    modifiedAt: file.modifiedAt,
    device: file.device,
    inode: file.inode,
  }
}

async function acquireCollectionLocks(input: ValidatedInput) {
  const lock = await acquireProcessLock(path.join(input.journalDirectory, COLLECTION_LOCK))
  const databases: Database[] = []
  try {
    const targets = [
      ...input.databases.filter((source) => source.kind !== "backup").map((source) => source.path),
      ...input.archiveShards,
    ].toSorted((a, b) => normalizeCase(a).localeCompare(normalizeCase(b)))
    for (const filename of targets) {
      const database = (() => {
        try {
          return new Database(filename, { strict: true })
        } catch (cause) {
          throw new Error("database", `Cannot open mutable GC source for an offline writer lock: ${filename}`, {
            cause,
          })
        }
      })()
      try {
        database.run("PRAGMA busy_timeout = 0")
        database.run("BEGIN IMMEDIATE")
        databases.push(database)
      } catch (cause) {
        database.close(false)
        throw new Error(
          "database",
          `Cannot acquire the offline writer lock for ${filename}; stop every OpenCode and external source writer`,
          { cause },
        )
      }
    }
  } catch (cause) {
    for (const database of databases.toReversed()) {
      try {
        database.run("ROLLBACK")
      } catch {}
      database.close(false)
    }
    await releaseProcessLock(lock)
    throw cause
  }
  return async () => {
    for (const database of databases.toReversed()) {
      try {
        database.run("ROLLBACK")
      } catch {}
      database.close(false)
    }
    await releaseProcessLock(lock)
  }
}

async function acquireProcessLock(filename: string) {
  for (const attempt of [0, 1]) {
    const id = randomUUID()
    try {
      const handle = await open(filename, "wx")
      try {
        await handle.writeFile(JSON.stringify({ version: 1, id, pid: process.pid, createdAt: Date.now() }) + "\n")
        await handle.sync()
        return { filename, handle, id }
      } catch (cause) {
        await handle.close()
        await unlink(filename).catch(() => undefined)
        throw new Error("filesystem", `Cannot publish the content GC lock: ${filename}`, { cause })
      }
    } catch (cause) {
      if (!record(cause) || cause.code !== "EEXIST")
        throw new Error("filesystem", `Cannot acquire the content GC lock: ${filename}`, { cause })
      if (attempt > 0 || !(await staleProcessLock(filename)))
        throw new Error("configuration", `Another content collection owns ${filename}`)
      const stale = `${filename}.stale-${randomUUID()}`
      await rename(filename, stale).catch((error) => {
        if (record(error) && error.code === "ENOENT") return
        throw new Error("filesystem", `Cannot quarantine stale content GC lock: ${filename}`, { cause: error })
      })
      await unlink(stale).catch((error) => {
        if (record(error) && error.code === "ENOENT") return
        throw new Error("filesystem", `Cannot remove stale content GC lock: ${stale}`, { cause: error })
      })
    }
  }
  throw new Error("configuration", `Another content collection owns ${filename}`)
}

async function staleProcessLock(filename: string) {
  const info = await stat(filename).catch((cause) => {
    if (record(cause) && cause.code === "ENOENT") return
    throw new Error("filesystem", `Cannot inspect the content GC lock: ${filename}`, { cause })
  })
  if (!info) return true
  const value = await Bun.file(filename)
    .json()
    .catch(() => undefined)
  if (record(value) && typeof value.pid === "number") return !processExists(value.pid)
  return Date.now() - info.mtimeMs > STALE_LOCK_MS
}

async function releaseProcessLock(lock: Awaited<ReturnType<typeof acquireProcessLock>>) {
  await lock.handle.close()
  const value = await Bun.file(lock.filename)
    .json()
    .catch((cause) => {
      throw new Error("filesystem", `Cannot verify the content GC lock before release: ${lock.filename}`, { cause })
    })
  if (!record(value) || value.id !== lock.id)
    throw new Error("integrity", `Content GC lock ownership changed before release: ${lock.filename}`)
  await unlink(lock.filename).catch((cause) => {
    throw new Error("filesystem", `Cannot release the content GC lock: ${lock.filename}`, { cause })
  })
}

function processExists(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function scanValidated(
  input: ValidatedInput,
  inventory?: ValidatedInventory,
  inventoryMode: "strong" | "light" = "light",
  onInventoryValidation?: (mode: "strong" | "light") => void | Promise<void>,
): Promise<Scan> {
  const sourceFingerprints = [
    ...(inventory ? [await scanSourceInventory(inventory, input, inventoryMode, onInventoryValidation)] : []),
    ...(await Promise.all(input.databases.map(scanDatabase))),
    ...(await Promise.all(input.archiveShards.map(scanArchive))),
    ...(await Promise.all(input.rollbackManifests.map(scanManifest))),
  ].toSorted(compareFingerprint)
  const reachable = [...new Set(sourceFingerprints.flatMap((source) => source.refs))].sort()
  const stored = await scanStore(input.storeDirectory)
  const reachableSet = new Set(reachable)
  const candidates = stored.filter((blob) => !reachableSet.has(blob.sha256))
  const reachabilityDigest = Hash.sha256(JSON.stringify(sourceFingerprints))
  const digest = Hash.sha256(
    JSON.stringify({
      version: 1,
      storeDirectory: input.storeDirectory,
      stored,
      candidates,
      reachable,
      sourceFingerprints,
    }),
  )
  return {
    stored,
    reachable,
    sourceFingerprints,
    plan: {
      version: 1,
      digest,
      reachabilityDigest,
      storeDirectory: input.storeDirectory,
      candidates,
      storedBlobs: stored.length,
      reachableBlobs: reachable.length,
      candidateBytes: candidates.reduce((total, candidate) => total + candidate.sizeBytes, 0),
      sources: {
        databases: input.databases.length,
        archiveShards: input.archiveShards.length,
        rollbackManifests: input.rollbackManifests.length,
      },
      safety: {
        completeSourceInventory: inventory !== undefined,
        offlineRequired: true,
        sqliteWriterLocks: true,
        reachabilityRecheckedBeforeEachDelete: true,
      },
    },
  }
}

async function scanSourceInventory(
  input: ValidatedInventory,
  sources: ValidatedInput,
  mode: "strong" | "light",
  onValidation?: (mode: "strong" | "light") => void | Promise<void>,
): Promise<SourceFingerprint> {
  await onValidation?.(mode)
  await validateSourceInventoryState(input, sources, mode)
  return { type: "inventory", path: input.path, refs: [], digest: input.digest }
}

async function scanDatabase(source: DatabaseSource): Promise<SourceFingerprint> {
  const refs = await readDatabase(source.path, (database) => {
    const attachment = readOptionalHashes(database, "attachment", ["blob_sha256"])
    const mutations = readOptionalHashes(database, "session_file_mutation", ["before_sha256", "after_sha256"])
    return [...attachment, ...mutations]
  })
  return { type: "database", kind: source.kind, path: source.path, refs: [...new Set(refs)].sort() }
}

async function scanArchive(filename: string): Promise<SourceFingerprint> {
  const refs = await readDatabase(filename, (database) => {
    const tables = new Set(
      database
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name),
    )
    const sources = [
      ...(tables.has("archive_attachment_ref")
        ? readRequiredHashes(database, "archive_attachment_ref", ["blob_sha256"])
        : []),
      ...readArchiveMutationHashes(database, tables),
      ...(tables.has("archive_blob_ref") ? readRequiredHashes(database, "archive_blob_ref", ["blob_sha256"]) : []),
      ...(tables.has("blob_ref") ? readRequiredHashes(database, "blob_ref", ["sha256"]) : []),
    ]
    if (
      !tables.has("archive_attachment_ref") &&
      !tables.has("archive_file_mutation_ref") &&
      !tables.has("archive_blob_ref") &&
      !tables.has("blob_ref")
    )
      throw new Error("database", `Archive shard has no recognized blob-reference table: ${filename}`)
    return sources
  })
  return { type: "archive", path: filename, refs: [...new Set(refs)].sort() }
}

async function scanManifest(filename: string): Promise<SourceFingerprint> {
  const info = await stat(filename).catch((cause) => {
    throw new Error("manifest", `Cannot stat rollback retention manifest: ${filename}`, { cause })
  })
  if (info.size > MAX_MANIFEST_BYTES)
    throw new Error("manifest", `Rollback retention manifest exceeds ${MAX_MANIFEST_BYTES} bytes: ${filename}`)
  const value = await Bun.file(filename)
    .json()
    .catch((cause) => {
      throw new Error("manifest", `Rollback retention manifest is not valid JSON: ${filename}`, { cause })
    })
  if (!record(value) || value.version !== 1 || value.kind !== "opencode-rollback-retention")
    throw new Error("manifest", `Unsupported rollback retention manifest: ${filename}`)
  if (!Array.isArray(value.retainedBlobs) || value.retainedBlobs.some((item) => typeof item !== "string"))
    throw new Error("manifest", `Rollback retention manifest has invalid retainedBlobs: ${filename}`)
  const refs = [...new Set(value.retainedBlobs.map((item) => requireHash(item, filename)))].sort()
  return { type: "manifest", path: filename, refs }
}

async function readDatabase<A>(filename: string, read: (database: Database) => A): Promise<A> {
  const database = await Promise.resolve().then(() => {
    try {
      return new Database(filename, { readonly: true, strict: true })
    } catch (cause) {
      throw new Error("database", `Cannot open SQLite reachability source: ${filename}`, { cause })
    }
  })
  try {
    database.run("PRAGMA query_only = ON")
    const check = database.query<Record<string, string>, []>("PRAGMA quick_check").get()
    if (!check || Object.values(check)[0] !== "ok")
      throw new Error("database", `SQLite reachability source failed quick_check: ${filename}`)
    return read(database)
  } catch (cause) {
    if (cause instanceof Error) throw cause
    throw new Error("database", `Failed to scan SQLite reachability source: ${filename}`, { cause })
  } finally {
    database.close(false)
  }
}

function readOptionalHashes(database: Database, table: string, columns: ReadonlyArray<string>) {
  const exists = database
    .query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table)
  if (!exists?.count) return []
  return readRequiredHashes(database, table, columns)
}

function readRequiredHashes(database: Database, table: string, columns: ReadonlyArray<string>) {
  const existing = new Set(
    database
      .query<{ name: string }, []>(`PRAGMA table_info('${table}')`)
      .all()
      .map((column) => column.name),
  )
  if (!columns.every((column) => existing.has(column)))
    throw new Error("database", `Blob-reference table ${table} is missing required columns`)
  return columns.flatMap((column) =>
    database
      .query<Record<string, unknown>, []>(`SELECT ${column} AS hash FROM ${table} WHERE ${column} IS NOT NULL`)
      .all()
      .map((row) => requireHash(row.hash, `${table}.${column}`)),
  )
}

function readArchiveMutationHashes(database: Database, tables: ReadonlySet<string>) {
  if (!tables.has("archive_session_section")) {
    if (tables.has("archive_file_mutation_ref"))
      throw new Error("database", "Archive file-mutation references have no snapshot section table")
    return []
  }
  const sections = database
    .query<{ session_id: string; revision: number; data_json: string; row_hash: string }, []>(
      `SELECT session_id, revision, data_json, row_hash FROM archive_session_section
       WHERE section_name = 'session_file_mutation' ORDER BY session_id, revision, ordinal`,
    )
    .all()
    .map((row) => {
      if (Hash.sha256(row.data_json) !== row.row_hash)
        throw new Error("integrity", "Archived file-mutation snapshot row hash is invalid")
      const value = (() => {
        try {
          return JSON.parse(row.data_json) as unknown
        } catch (cause) {
          throw new Error("database", "Archived file-mutation snapshot is not valid JSON", { cause })
        }
      })()
      if (!record(value) || typeof value.id !== "string" || value.session_id !== row.session_id)
        throw new Error("integrity", "Archived file-mutation snapshot identity is invalid")
      return {
        sessionID: row.session_id,
        revision: row.revision,
        mutationID: value.id,
        beforeSha256: nullableReachabilityHash(value.before_sha256, "session_file_mutation.before_sha256"),
        afterSha256: nullableReachabilityHash(value.after_sha256, "session_file_mutation.after_sha256"),
        rowHash: row.row_hash,
      }
    })
  if (!tables.has("archive_file_mutation_ref"))
    return sections.flatMap((row) => [row.beforeSha256, row.afterSha256].filter((hash): hash is string => !!hash))

  const columns = new Set(
    database
      .query<{ name: string }, []>("PRAGMA table_info('archive_file_mutation_ref')")
      .all()
      .map((column) => column.name),
  )
  if (
    !["session_id", "revision", "mutation_id", "before_sha256", "after_sha256", "row_hash"].every((column) =>
      columns.has(column),
    )
  )
    throw new Error("database", "Blob-reference table archive_file_mutation_ref is missing required columns")
  const references = new Map(
    database
      .query<
        {
          session_id: string
          revision: number
          mutation_id: string
          before_sha256: string | null
          after_sha256: string | null
          row_hash: string
        },
        []
      >(
        `SELECT session_id, revision, mutation_id, before_sha256, after_sha256, row_hash
         FROM archive_file_mutation_ref`,
      )
      .all()
      .map((row) => {
        const key = `${row.session_id}\0${row.revision}\0${row.mutation_id}`
        return [key, row] as const
      }),
  )
  const hashes = sections.flatMap((section) => {
    const key = `${section.sessionID}\0${section.revision}\0${section.mutationID}`
    const reference = references.get(key)
    if (
      !reference ||
      nullableReachabilityHash(reference.before_sha256, "archive_file_mutation_ref.before_sha256") !==
        section.beforeSha256 ||
      nullableReachabilityHash(reference.after_sha256, "archive_file_mutation_ref.after_sha256") !==
        section.afterSha256 ||
      requireHash(reference.row_hash, "archive_file_mutation_ref.row_hash") !== section.rowHash
    )
      throw new Error("integrity", `Archived file-mutation reference does not match ${section.mutationID}`)
    references.delete(key)
    return [section.beforeSha256, section.afterSha256].filter((hash): hash is string => !!hash)
  })
  if (references.size > 0)
    throw new Error("integrity", "Archive contains file-mutation references without snapshot rows")
  return hashes
}

function nullableReachabilityHash(input: unknown, source: string) {
  if (input === null || input === undefined) return null
  return requireHash(input, source)
}

async function scanStore(directory: string): Promise<StoredBlob[]> {
  const blobs: StoredBlob[] = []
  const prefixes = await readdir(directory, { withFileTypes: true }).catch((cause) => {
    throw new Error("filesystem", `Cannot scan managed content store: ${directory}`, { cause })
  })
  for (const prefix of prefixes) {
    if (!prefix.isDirectory() || prefix.isSymbolicLink() || !PREFIX.test(prefix.name))
      throw new Error("integrity", `Unexpected entry in managed content store: ${prefix.name}`)
    const prefixPath = path.join(directory, prefix.name)
    const actualPrefix = await realpath(prefixPath).catch((cause) => {
      throw new Error("integrity", `Cannot resolve managed blob prefix: ${prefixPath}`, { cause })
    })
    if (!contains(directory, actualPrefix))
      throw new Error("integrity", `Managed blob prefix escapes store: ${prefixPath}`)
    for (const entry of await readdir(actualPrefix, { withFileTypes: true })) {
      if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        !SHA256.test(entry.name) ||
        entry.name.slice(0, 2) !== prefix.name
      )
        throw new Error("integrity", `Invalid managed blob path: ${path.join(actualPrefix, entry.name)}`)
      const filename = path.join(actualPrefix, entry.name)
      const actual = await realpath(filename).catch((cause) => {
        throw new Error("integrity", `Cannot resolve managed blob: ${filename}`, { cause })
      })
      if (!contains(directory, actual)) throw new Error("integrity", `Managed blob escapes store: ${filename}`)
      const info = await lstat(actual).catch((cause) => {
        throw new Error("integrity", `Cannot stat managed blob: ${filename}`, { cause })
      })
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error("integrity", `Managed blob is not a regular file: ${filename}`)
      if ((await hashFile(actual)) !== entry.name)
        throw new Error("integrity", `Managed blob bytes do not match content address: ${filename}`)
      blobs.push({ sha256: entry.name, path: actual, sizeBytes: info.size })
    }
  }
  return blobs.toSorted((a, b) => a.sha256.localeCompare(b.sha256))
}

async function verifyCandidate(storeDirectory: string, planned: Candidate, current: Candidate) {
  if (planned.sha256 !== current.sha256 || planned.sizeBytes !== current.sizeBytes || planned.path !== current.path)
    throw new Error("integrity", `Managed blob changed after planning: ${planned.sha256}`)
  const expected = path.join(storeDirectory, planned.sha256.slice(0, 2), planned.sha256)
  if (normalizeCase(expected) !== normalizeCase(current.path) || !contains(storeDirectory, current.path))
    throw new Error("integrity", `Managed blob path does not match its content address: ${planned.sha256}`)
  if ((await hashFile(current.path)) !== planned.sha256)
    throw new Error("integrity", `Managed blob hash changed after reachability scan: ${planned.sha256}`)
}

function validateResume(journal: Journal, current: Scan) {
  validateJournal(journal)
  if (journal.reachabilityDigest !== current.plan.reachabilityDigest)
    throw new Error("digest", "Reachability changed after the confirmed dry-run; collection is blocked")
  if (normalizeCase(journal.storeDirectory) !== normalizeCase(current.plan.storeDirectory))
    throw new Error("integrity", "GC journal targets a different managed content store")
  const deleted = new Set(journal.events.flatMap((event) => (event.state === "deleted" ? [event.sha256] : [])))
  const original = new Map(journal.stored.map((blob) => [blob.sha256, blob]))
  const currentHashes = new Set(current.stored.map((blob) => blob.sha256))
  for (const blob of current.stored) {
    const expected = original.get(blob.sha256)
    if (!expected || deleted.has(blob.sha256))
      throw new Error("integrity", `Managed content store changed during resumable collection: ${blob.sha256}`)
    if (expected.path !== blob.path || expected.sizeBytes !== blob.sizeBytes)
      throw new Error("integrity", `Managed blob changed during resumable collection: ${blob.sha256}`)
  }
  for (const blob of journal.stored) {
    if (deleted.has(blob.sha256) || currentHashes.has(blob.sha256)) continue
    if (!journal.candidates.some((candidate) => candidate.sha256 === blob.sha256))
      throw new Error("integrity", `Reachable managed blob disappeared during collection: ${blob.sha256}`)
  }
}

function validateCompletion(journal: Journal, final: Scan) {
  if (journal.reachabilityDigest !== final.plan.reachabilityDigest)
    throw new Error("digest", "Reachability changed while managed blobs were being deleted")
  const candidates = new Set(journal.candidates.map((candidate) => candidate.sha256))
  const remaining = final.stored.find((blob) => candidates.has(blob.sha256))
  if (remaining) throw new Error("integrity", `GC candidate remains after collection: ${remaining.sha256}`)
  const expected = journal.stored.filter((blob) => !candidates.has(blob.sha256)).map((blob) => blob.sha256)
  if (JSON.stringify(final.stored.map((blob) => blob.sha256)) !== JSON.stringify(expected))
    throw new Error("integrity", "Managed content store changed while collection was running")
}

async function readJournal(filename: string): Promise<Journal | undefined> {
  const exists = await Bun.file(filename).exists()
  if (!exists) return undefined
  const info = await lstat(filename).catch((cause) => {
    throw new Error("journal", `GC journal cannot be inspected: ${filename}`, { cause })
  })
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("journal", `GC journal is not a regular file: ${filename}`)
  if (!contains(path.dirname(filename), await realpath(filename)))
    throw new Error("journal", `GC journal escapes its explicit directory: ${filename}`)
  const value = await Bun.file(filename)
    .json()
    .catch((cause) => {
      throw new Error("journal", `GC journal is not valid JSON: ${filename}`, { cause })
    })
  validateJournal(value)
  return value
}

function validateJournal(input: unknown): asserts input is Journal {
  if (!record(input) || input.version !== 1 || !SHA256.test(String(input.digest)))
    throw new Error("journal", "GC journal has an unsupported header")
  if (!SHA256.test(String(input.reachabilityDigest)) || typeof input.storeDirectory !== "string")
    throw new Error("journal", "GC journal has invalid reachability metadata")
  if (!Array.isArray(input.stored) || !Array.isArray(input.candidates) || !Array.isArray(input.sourceFingerprints))
    throw new Error("journal", "GC journal has invalid plan data")
  const stored = input.stored.every(validCandidate)
  const candidates = input.candidates.every(validCandidate)
  if (!stored || !candidates || !Array.isArray(input.events) || input.events.length === 0)
    throw new Error("journal", "GC journal has invalid candidates or events")
  const fingerprints = input.sourceFingerprints
  if (!fingerprints.every(validFingerprint)) throw new Error("journal", "GC journal has invalid source fingerprints")
  const storedHashes = input.stored.map((blob) => blob.sha256)
  const candidateHashes = input.candidates.map((candidate) => candidate.sha256)
  if (new Set(storedHashes).size !== storedHashes.length || new Set(candidateHashes).size !== candidateHashes.length)
    throw new Error("journal", "GC journal contains duplicate blob entries")
  if (input.candidates.some((candidate) => !storedHashes.includes(candidate.sha256)))
    throw new Error("journal", "GC journal candidate is not part of the planned content store")
  const reachable = [...new Set(fingerprints.flatMap((source) => source.refs))].sort()
  const expectedCandidates = input.stored.filter((blob) => !reachable.includes(blob.sha256))
  if (JSON.stringify(input.candidates) !== JSON.stringify(expectedCandidates))
    throw new Error("journal", "GC journal candidates do not match reachability")
  if (input.reachabilityDigest !== Hash.sha256(JSON.stringify(fingerprints)))
    throw new Error("journal", "GC journal reachability digest is invalid")
  if (
    input.digest !==
    Hash.sha256(
      JSON.stringify({
        version: 1,
        storeDirectory: input.storeDirectory,
        stored: input.stored,
        candidates: input.candidates,
        reachable,
        sourceFingerprints: fingerprints,
      }),
    )
  )
    throw new Error("journal", "GC journal plan digest is invalid")
  if (!record(input.events[0]) || input.events[0].state !== "requested")
    throw new Error("journal", "GC journal does not begin with requested")
  const candidatesSet = new Set(candidateHashes)
  const seen = new Set<string>()
  for (const [index, event] of input.events.entries()) {
    if (!record(event) || typeof event.time !== "number") throw new Error("journal", "GC journal event is invalid")
    if (event.state === "requested") {
      if (index !== 0) throw new Error("journal", "GC journal repeats requested")
      continue
    }
    if (event.state === "completed") {
      if (index !== input.events.length - 1 || seen.size !== candidatesSet.size)
        throw new Error("journal", "GC journal completed before every candidate was deleted")
      continue
    }
    if (event.state !== "deleted" || typeof event.sha256 !== "string" || !candidatesSet.has(event.sha256))
      throw new Error("journal", "GC journal deletion event is invalid")
    if (seen.has(event.sha256)) throw new Error("journal", "GC journal contains a duplicate deletion event")
    seen.add(event.sha256)
  }
}

async function writeJournal(filename: string, journal: Journal) {
  const temporary = `${filename}.tmp-${randomUUID()}`
  const handle = await open(temporary, "wx").catch((cause) => {
    throw new Error("journal", `Cannot create GC journal transaction: ${filename}`, { cause })
  })
  try {
    await handle.writeFile(JSON.stringify(journal, null, 2) + "\n")
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, filename).catch(async (cause) => {
    await unlink(temporary).catch(() => undefined)
    throw new Error("journal", `Cannot publish GC journal transaction: ${filename}`, { cause })
  })
}

async function requireDirectory(input: string, label: string) {
  const resolved = path.resolve(input)
  const info = await lstat(resolved).catch((cause) => {
    throw new Error("configuration", `Explicit ${label} directory is not readable: ${resolved}`, { cause })
  })
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("configuration", `Explicit ${label} path is not a regular directory: ${resolved}`)
  return realpath(resolved)
}

async function requireFile(input: string, label: string) {
  const resolved = path.resolve(input)
  const info = await lstat(resolved).catch((cause) => {
    throw new Error("configuration", `Explicit ${label} file is not readable: ${resolved}`, { cause })
  })
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("configuration", `Explicit ${label} path is not a regular file: ${resolved}`)
  return realpath(resolved)
}

async function hashFile(filename: string) {
  const hash = createHash("sha256")
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filename)
    stream.on("data", (chunk) => hash.update(chunk))
    stream.on("error", reject)
    stream.on("end", resolve)
  }).catch((cause) => {
    throw new Error("filesystem", `Cannot hash managed blob: ${filename}`, { cause })
  })
  return hash.digest("hex")
}

function requireHash(input: unknown, source: string) {
  if (typeof input !== "string" || !SHA256.test(input))
    throw new Error("integrity", `Invalid blob hash in reachability source ${source}`)
  return input
}

function contains(parent: string, child: string) {
  const relative = path.relative(parent, child)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function normalizeCase(input: string) {
  return process.platform === "win32" ? input.toLowerCase() : input
}

function comparePath(a: string, b: string) {
  return normalizeCase(a).localeCompare(normalizeCase(b))
}

function compareDatabaseSource(a: DatabaseSource, b: DatabaseSource) {
  return `${a.kind}:${normalizeCase(a.path)}`.localeCompare(`${b.kind}:${normalizeCase(b.path)}`)
}

function compareFingerprint(a: SourceFingerprint, b: SourceFingerprint) {
  return `${a.type}:${a.kind ?? ""}:${a.path}`.localeCompare(`${b.type}:${b.kind ?? ""}:${b.path}`)
}

function record(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function validCandidate(input: unknown): input is Candidate {
  return (
    record(input) &&
    typeof input.sha256 === "string" &&
    SHA256.test(input.sha256) &&
    typeof input.path === "string" &&
    typeof input.sizeBytes === "number" &&
    Number.isSafeInteger(input.sizeBytes) &&
    input.sizeBytes >= 0
  )
}

function validFingerprint(input: unknown): input is SourceFingerprint {
  if (!record(input) || !["database", "archive", "manifest", "inventory"].includes(String(input.type))) return false
  if (typeof input.path !== "string" || !Array.isArray(input.refs)) return false
  if (!input.refs.every((hash) => typeof hash === "string" && SHA256.test(hash))) return false
  if (input.type === "inventory" && (typeof input.digest !== "string" || !SHA256.test(input.digest))) return false
  return input.type !== "database" || ["active", "local", "backup"].includes(String(input.kind))
}

function validInventoryRoot(input: unknown): input is InventoryRoot {
  return (
    record(input) &&
    Array.isArray(input.directories) &&
    input.directories.every((directory) => typeof directory === "string") &&
    typeof input.confirmedEmpty === "boolean" &&
    Array.isArray(input.files) &&
    input.files.every(validInventoryFile)
  )
}

function validInventoryCompleteness(input: unknown) {
  return (
    record(input) &&
    ["activeDatabases", "localDatabases", "backupDatabases", "archiveShards", "rollbackManifests"].every(
      (key) => input[key] === true,
    )
  )
}

function validInventoryFile(file: unknown): file is InventoryFile {
  return (
    record(file) &&
    typeof file.path === "string" &&
    typeof file.sizeBytes === "number" &&
    Number.isSafeInteger(file.sizeBytes) &&
    file.sizeBytes >= 0 &&
    typeof file.modifiedAt === "number" &&
    Number.isFinite(file.modifiedAt) &&
    typeof file.device === "string" &&
    /^\d+$/.test(file.device) &&
    typeof file.inode === "string" &&
    /^\d+$/.test(file.inode) &&
    typeof file.sha256 === "string" &&
    SHA256.test(file.sha256)
  )
}
