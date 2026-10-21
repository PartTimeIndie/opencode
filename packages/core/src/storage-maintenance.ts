export * as StorageMaintenance from "./storage-maintenance"

import { Database } from "#maintenance-sqlite"
import { createHash, randomUUID } from "node:crypto"
import { createReadStream, statSync } from "node:fs"
import { mkdir, open, readdir, readFile, rm, stat } from "node:fs/promises"
import path from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import { Global } from "./global"

const DATABASE_EXTENSIONS = new Set([".db", ".sqlite", ".sqlite3"])
const BACKUP_PATTERN = /(?:\.bak(?:-|$)|\.backup(?:-|$)|\.(?:opencode|opencode-local)-rollback-[0-9a-f]{24}$)/i
const COMPACTION_BACKUP_PATTERN = /^.+\.db\.bak-event-compaction-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/
const ROLLBACK_RETENTION_MS = 14 * 24 * 60 * 60 * 1_000
const MANIFEST_PATTERN = /(?:manifest|migration|maintenance|archive).*\.json$/i

export interface Config {
  readonly data: string
  readonly activeDatabase: string
  readonly localDatabase: string
  readonly archiveDirectory: string
  readonly blobDirectory: string
  readonly backupDirectory: string
  readonly snapshotDirectory: string
  readonly retirementJournal: string
  readonly manifests?: ReadonlyArray<string>
}

export interface SizedPath {
  readonly path: string
  readonly exists: boolean
  readonly bytes: number
}

export interface DatabaseSummary extends SizedPath {
  readonly sessions?: number
}

export interface FileGroup {
  readonly path: string
  readonly files: number
  readonly bytes: number
}

export interface BackupSummary {
  readonly id: string
  readonly path: string
  readonly bytes: number
  readonly modifiedAt: number
  readonly retireAfter: number
  readonly retirementEligible: boolean
}

export interface ManifestStatus {
  readonly path: string
  readonly kind: "migration" | "maintenance" | "archive" | "content" | "unknown"
  readonly valid: boolean
  readonly status?: string
  readonly phase?: string
  readonly message?: string
  readonly updatedAt?: string | number
  readonly resumable?: boolean
  readonly error?: string
}

export interface Snapshot {
  readonly activeDatabase: DatabaseSummary
  readonly localDatabase: DatabaseSummary
  readonly archives: FileGroup & { readonly sessions: number }
  readonly blobs: FileGroup & { readonly indexed: number }
  readonly backups: FileGroup & { readonly items: ReadonlyArray<BackupSummary> }
  readonly snapshots: FileGroup
  readonly compactionBackups: FileGroup
  readonly attachments: {
    readonly references: number
    readonly uniqueBlobs: number
    readonly deduplicated: number
    readonly referencedBytes: number
    readonly storedBytes: number
    readonly savedBytes: number
  }
  readonly manifests: ReadonlyArray<ManifestStatus>
  readonly retirementJournal: SizedPath
}

export interface DatabaseIntegrity {
  readonly path: string
  readonly kind: "active" | "local" | "archive" | "backup"
  readonly ok: boolean
  readonly result?: string
  readonly foreignKeyViolations?: number
  readonly error?: string
}

export interface BlobIntegrity {
  readonly checked: number
  readonly missing: number
  readonly sizeMismatch: number
  readonly hashMismatch: number
  readonly unsafePath: number
}

export interface IntegrityDryRun {
  readonly level: "quick" | "full"
  readonly startedAt: number
  readonly completedAt: number
  readonly healthy: boolean
  readonly databases: ReadonlyArray<DatabaseIntegrity>
  readonly blobs: BlobIntegrity
}

type AttachmentStatistics = Snapshot["attachments"] & { readonly indexedBlobs: number }

export class MaintenanceError extends Schema.TaggedErrorClass<MaintenanceError>()("StorageMaintenance.Error", {
  operation: Schema.Literals(["snapshot", "integrity", "retire"]),
  resource: Schema.String,
  cause: Schema.Defect,
}) {}

export interface Interface {
  readonly snapshot: () => Effect.Effect<Snapshot, MaintenanceError>
  readonly runIntegrityDryRun: (input?: {
    readonly level?: "quick" | "full"
    readonly includeBackups?: boolean
  }) => Effect.Effect<IntegrityDryRun, MaintenanceError>
  readonly retireBackup: (input: {
    readonly path: string
    readonly confirmation: string
    readonly expectedBytes: number
    readonly expectedModifiedAt: number
  }) => Effect.Effect<{ readonly id: string; readonly path: string; readonly bytes: number }, MaintenanceError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/StorageMaintenance") {}

export function retirementConfirmation(filename: string) {
  return `RETIRE BACKUP ${path.basename(filename)}`
}

export function make(input: Partial<Omit<Config, "data">> & Pick<Config, "data">): Interface {
  const config: Config = {
    data: input.data,
    activeDatabase: input.activeDatabase ?? path.join(input.data, "opencode.db"),
    localDatabase: input.localDatabase ?? path.join(input.data, "opencode-local.db"),
    archiveDirectory: input.archiveDirectory ?? path.join(input.data, "archives"),
    blobDirectory: input.blobDirectory ?? path.join(input.data, "content"),
    backupDirectory: input.backupDirectory ?? path.join(input.data, "backups"),
    snapshotDirectory: input.snapshotDirectory ?? path.join(input.data, "snapshot"),
    retirementJournal: input.retirementJournal ?? path.join(input.data, "storage-retirement.journal.jsonl"),
    manifests: input.manifests,
  }

  return {
    snapshot: () =>
      Effect.tryPromise({
        try: () => inspect(config),
        catch: (cause) => new MaintenanceError({ operation: "snapshot", resource: config.data, cause }),
      }),
    runIntegrityDryRun: (options = {}) =>
      Effect.tryPromise({
        try: () => integrityDryRun(config, options),
        catch: (cause) => new MaintenanceError({ operation: "integrity", resource: config.data, cause }),
      }),
    retireBackup: (request) =>
      Effect.tryPromise({
        try: () => retire(config, request),
        catch: (cause) => new MaintenanceError({ operation: "retire", resource: request.path, cause }),
      }),
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const global = yield* Global.Service
    return Service.of(make({ data: global.data }))
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Global.defaultLayer))

async function inspect(config: Config): Promise<Snapshot> {
  const archiveDatabases = await databaseFiles(config.archiveDirectory)
  const backups = await backupFiles(config)
  const compactionBackups = await compactionBackupFiles(config)
  const databases = [...new Set([config.activeDatabase, config.localDatabase, ...archiveDatabases])]
  const [
    activeDatabase,
    localDatabase,
    archiveFiles,
    backupSizes,
    snapshotFiles,
    compactionBackupSizes,
    manifests,
    retirementJournal,
    attachment,
  ] = await Promise.all([
    databaseSummary(config.activeDatabase),
    databaseSummary(config.localDatabase),
    Promise.all(archiveDatabases.map(databaseSummary)),
    Promise.all(backups.map(backupSummary)),
    files(config.snapshotDirectory),
    Promise.all(compactionBackups.map(databaseBytes)),
    manifestStatus(config),
    sizedPath(config.retirementJournal),
    attachmentStatistics(databases),
  ])
  return {
    activeDatabase,
    localDatabase,
    archives: {
      path: config.archiveDirectory,
      files: archiveFiles.length,
      bytes: archiveFiles.reduce((total, file) => total + file.bytes, 0),
      sessions: archiveFiles.reduce((total, file) => total + (file.sessions ?? 0), 0),
    },
    blobs: {
      path: config.blobDirectory,
      files: attachment.uniqueBlobs,
      bytes: attachment.storedBytes,
      indexed: attachment.indexedBlobs,
    },
    backups: {
      path: config.backupDirectory,
      files: backups.length,
      bytes: backupSizes.reduce((total, backup) => total + backup.bytes, 0),
      items: backupSizes,
    },
    snapshots: {
      path: config.snapshotDirectory,
      files: snapshotFiles.length,
      bytes: snapshotFiles.reduce((total, file) => total + file.bytes, 0),
    },
    compactionBackups: {
      path: config.data,
      files: compactionBackups.length,
      bytes: compactionBackupSizes.reduce((total, bytes) => total + bytes, 0),
    },
    attachments: {
      references: attachment.references,
      uniqueBlobs: attachment.uniqueBlobs,
      deduplicated: attachment.deduplicated,
      referencedBytes: attachment.referencedBytes,
      storedBytes: attachment.storedBytes,
      savedBytes: attachment.savedBytes,
    },
    manifests,
    retirementJournal,
  }
}

async function integrityDryRun(
  config: Config,
  options: { readonly level?: "quick" | "full"; readonly includeBackups?: boolean },
): Promise<IntegrityDryRun> {
  const startedAt = Date.now()
  const archives = await databaseFiles(config.archiveDirectory)
  const targets = [
    { path: config.activeDatabase, kind: "active" as const },
    { path: config.localDatabase, kind: "local" as const },
    ...archives.map((filename) => ({ path: filename, kind: "archive" as const })),
    ...((options.includeBackups ? await backupFiles(config) : []).map((filename) => ({
      path: filename,
      kind: "backup" as const,
    })) ?? []),
  ]
  const existing = (
    await Promise.all(targets.map(async (target) => ({ target, exists: await fileExists(target.path) })))
  ).filter((item) => item.exists)
  const databases = await Promise.all(
    existing.map((item) => checkDatabase(item.target.path, item.target.kind, options.level ?? "quick")),
  )
  const blobs = await checkBlobs(
    config,
    [...new Set([config.activeDatabase, config.localDatabase, ...archives])].filter((filename) =>
      existing.some((item) => item.target.path === filename),
    ),
    options.level ?? "quick",
  )
  return {
    level: options.level ?? "quick",
    startedAt,
    completedAt: Date.now(),
    healthy:
      databases.every((database) => database.ok) &&
      blobs.missing === 0 &&
      blobs.sizeMismatch === 0 &&
      blobs.hashMismatch === 0 &&
      blobs.unsafePath === 0,
    databases,
    blobs,
  }
}

async function retire(
  config: Config,
  request: {
    readonly path: string
    readonly confirmation: string
    readonly expectedBytes: number
    readonly expectedModifiedAt: number
  },
) {
  if (request.confirmation !== retirementConfirmation(request.path))
    throw new Error("Backup retirement was not explicitly confirmed")
  const candidates = await backupFiles(config)
  const candidate = candidates.find((filename) => samePath(filename, request.path))
  if (!candidate) throw new Error("Backup is not an eligible managed backup")
  const info = await stat(candidate)
  const bytes = await databaseBytes(candidate)
  if (bytes !== request.expectedBytes || info.mtimeMs !== request.expectedModifiedAt)
    throw new Error("Backup changed after it was reviewed")
  const retireAfter = await backupRetireAfter(candidate, info.mtimeMs)
  if (Date.now() < retireAfter) throw new Error(`Backup is retained until ${new Date(retireAfter).toISOString()}`)

  const id = randomUUID()
  await appendJournal(config.retirementJournal, {
    version: 1,
    id,
    action: "backup-retirement",
    state: "requested",
    path: candidate,
    bytes,
    confirmedAt: Date.now(),
  })
  await Promise.all(
    [candidate, `${candidate}-wal`, `${candidate}-shm`, `${candidate}.retention.json`].map((filename) =>
      rm(filename, { force: true }),
    ),
  )
  await appendJournal(config.retirementJournal, {
    version: 1,
    id,
    action: "backup-retirement",
    state: "completed",
    path: candidate,
    bytes,
    completedAt: Date.now(),
  })
  return { id, path: candidate, bytes }
}

async function appendJournal(filename: string, entry: Record<string, unknown>) {
  await mkdir(path.dirname(filename), { recursive: true })
  const file = await open(filename, "a")
  try {
    await file.write(`${JSON.stringify(entry)}\n`)
    await file.sync()
  } finally {
    await file.close()
  }
}

async function databaseSummary(filename: string): Promise<DatabaseSummary> {
  if (!(await fileExists(filename))) return { path: filename, exists: false, bytes: 0 }
  const bytes = await databaseBytes(filename)
  const database = openReadonlyDatabase(filename)
  if (!database) return { path: filename, exists: true, bytes }
  try {
    return {
      path: filename,
      exists: true,
      bytes,
      sessions: hasTable(database, "session")
        ? database.query<{ readonly count: number }, []>("SELECT COUNT(*) AS count FROM session").get()?.count
        : hasTable(database, "archive_session")
          ? database.query<{ readonly count: number }, []>("SELECT COUNT(*) AS count FROM archive_session").get()?.count
          : 0,
    }
  } catch {
    return { path: filename, exists: true, bytes }
  } finally {
    database.close()
  }
}

async function databaseBytes(filename: string) {
  return (
    await Promise.all([filename, `${filename}-wal`, `${filename}-shm`].map((candidate) => fileBytes(candidate)))
  ).reduce((total, bytes) => total + bytes, 0)
}

async function backupSummary(filename: string): Promise<BackupSummary> {
  const info = await stat(filename)
  const retireAfter = await backupRetireAfter(filename, info.mtimeMs)
  return {
    id: path.basename(filename),
    path: filename,
    bytes: await databaseBytes(filename),
    modifiedAt: info.mtimeMs,
    retireAfter,
    retirementEligible: Date.now() >= retireAfter,
  }
}

async function backupRetireAfter(filename: string, fallback: number) {
  const retention = parseManifest(await readFile(`${filename}.retention.json`, "utf8").catch(() => ""))
  if (
    retention?.kind === "opencode-rollback-retention" &&
    retention.backupDatabase === filename &&
    typeof retention.retainUntil === "number" &&
    Number.isSafeInteger(retention.retainUntil)
  )
    return retention.retainUntil
  return fallback + ROLLBACK_RETENTION_MS
}

async function sizedPath(filename: string): Promise<SizedPath> {
  if (!(await fileExists(filename))) return { path: filename, exists: false, bytes: 0 }
  return { path: filename, exists: true, bytes: await fileBytes(filename) }
}

async function fileBytes(filename: string) {
  return (await stat(filename).catch(() => undefined))?.size ?? 0
}

async function fileExists(filename: string) {
  return stat(filename)
    .then((info) => info.isFile())
    .catch(() => false)
}

async function files(directory: string): Promise<ReadonlyArray<{ readonly path: string; readonly bytes: number }>> {
  if (!(await directoryExists(directory))) return []
  return (
    await Promise.all(
      (await readdir(directory, { withFileTypes: true })).map(async (entry) => {
        const filename = path.join(directory, entry.name)
        if (entry.isDirectory()) return files(filename)
        if (!entry.isFile()) return []
        return [{ path: filename, bytes: (await stat(filename)).size }]
      }),
    )
  ).flat()
}

async function databaseFiles(directory: string) {
  return (await files(directory))
    .map((file) => file.path)
    .filter((filename) => DATABASE_EXTENSIONS.has(path.extname(filename).toLowerCase()))
    .filter((filename) => !filename.endsWith("-wal") && !filename.endsWith("-shm"))
}

async function backupFiles(config: Config) {
  const direct = (await directoryExists(config.data))
    ? (await readdir(config.data, { withFileTypes: true }))
        .filter(
          (entry) =>
            entry.isFile() &&
            BACKUP_PATTERN.test(entry.name) &&
            !COMPACTION_BACKUP_PATTERN.test(entry.name) &&
            !entry.name.endsWith("-wal") &&
            !entry.name.endsWith("-shm"),
        )
        .map((entry) => path.join(config.data, entry.name))
    : []
  const managed = (await files(config.backupDirectory))
    .map((file) => file.path)
    .filter((filename) => !filename.endsWith("-wal") && !filename.endsWith("-shm"))
  return [...new Set([...direct, ...managed])]
}

async function compactionBackupFiles(config: Config) {
  if (!(await directoryExists(config.data))) return []
  return (await readdir(config.data, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && COMPACTION_BACKUP_PATTERN.test(entry.name))
    .map((entry) => path.join(config.data, entry.name))
}

async function manifestStatus(config: Config): Promise<ReadonlyArray<ManifestStatus>> {
  const discovered = config.manifests ?? (await discoverManifests(config))
  return Promise.all(
    [...new Set(discovered)].map(async (filename) => {
      const kind = manifestKind(filename)
      const content = await readFile(filename, "utf8").catch((cause) => cause)
      if (content instanceof Error) return { path: filename, kind, valid: false, error: content.message }
      const parsed = parseManifest(content)
      if (!parsed) return { path: filename, kind, valid: false, error: "Manifest is not a JSON object" }
      return {
        path: filename,
        kind,
        valid: true,
        status: stringValue(parsed.status) ?? stringValue(parsed.state),
        phase: stringValue(parsed.phase),
        message: stringValue(parsed.message),
        updatedAt:
          typeof parsed.updatedAt === "string" || typeof parsed.updatedAt === "number" ? parsed.updatedAt : undefined,
        resumable: typeof parsed.resumable === "boolean" ? parsed.resumable : undefined,
      }
    }),
  )
}

async function discoverManifests(config: Config) {
  const groups = await Promise.all(
    [config.data, config.archiveDirectory].map(async (directory) => {
      if (!(await directoryExists(directory))) return []
      return (await files(directory)).map((entry) => entry.path).filter((filename) => MANIFEST_PATTERN.test(filename))
    }),
  )
  return groups.flat()
}

function parseManifest(content: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(content)
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
    return value as Record<string, unknown>
  } catch {
    return undefined
  }
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function manifestKind(filename: string): ManifestStatus["kind"] {
  const name = path.basename(filename).toLowerCase()
  if (name.includes("migration")) return "migration"
  if (name.includes("maintenance")) return "maintenance"
  if (name.includes("archive")) return "archive"
  if (name.includes("content") || name.includes("blob")) return "content"
  return "unknown"
}

async function attachmentStatistics(databases: ReadonlyArray<string>): Promise<AttachmentStatistics> {
  const results = await Promise.all(
    databases.map(async (filename) => {
      const database = openReadonlyDatabase(filename)
      if (!database) return { references: [] as AttachmentReferenceGroup[], blobs: [] as AttachmentReferenceGroup[] }
      try {
        return {
          references: hasTable(database, "attachment")
            ? database
                .query<AttachmentReferenceGroup, []>(
                  "SELECT blob_sha256 AS sha256, MAX(COALESCE(size_bytes, 0)) AS sizeBytes, COUNT(*) AS n FROM attachment WHERE blob_sha256 IS NOT NULL GROUP BY blob_sha256",
                )
                .all()
            : hasTable(database, "archive_attachment_ref")
              ? database
                  .query<AttachmentReferenceGroup, []>(
                    "SELECT blob_sha256 AS sha256, 0 AS sizeBytes, COUNT(*) AS n FROM archive_attachment_ref GROUP BY blob_sha256",
                  )
                  .all()
              : [],
          blobs: hasTable(database, "content_blob")
            ? database
                .query<AttachmentReferenceGroup, []>("SELECT sha256, size_bytes AS sizeBytes, 1 AS n FROM content_blob")
                .all()
            : [],
        }
      } finally {
        database.close()
      }
    }),
  )
  const blobs = new Map<string, number>()
  const referenced = new Map<string, { sizeBytes: number; n: number }>()
  for (const result of results) {
    for (const blob of result.blobs) blobs.set(blob.sha256, blob.sizeBytes)
    for (const reference of result.references) {
      const current = referenced.get(reference.sha256)
      if (!current) {
        referenced.set(reference.sha256, { sizeBytes: reference.sizeBytes, n: reference.n })
        continue
      }
      current.n += reference.n
      if (reference.sizeBytes > current.sizeBytes) current.sizeBytes = reference.sizeBytes
    }
  }
  for (const [sha256, group] of referenced) {
    if (!blobs.has(sha256)) blobs.set(sha256, group.sizeBytes)
  }
  let references = 0
  let referencedBytes = 0
  let storedBytes = 0
  for (const [sha256, group] of referenced) {
    references += group.n
    const size = group.sizeBytes || blobs.get(sha256) || 0
    referencedBytes += group.n * size
    storedBytes += blobs.get(sha256) ?? 0
  }
  return {
    references,
    uniqueBlobs: referenced.size,
    deduplicated: Math.max(0, references - referenced.size),
    referencedBytes,
    storedBytes,
    savedBytes: Math.max(0, referencedBytes - storedBytes),
    indexedBlobs: blobs.size,
  }
}

type AttachmentReferenceGroup = {
  readonly sha256: string
  readonly sizeBytes: number
  readonly n: number
}

async function checkDatabase(
  filename: string,
  kind: DatabaseIntegrity["kind"],
  level: "quick" | "full",
): Promise<DatabaseIntegrity> {
  const database = openReadonlyDatabase(filename)
  if (!database) return { path: filename, kind, ok: false, error: "Database could not be opened read-only" }
  try {
    const result = database
      .query<Record<string, string>, []>(`PRAGMA ${level === "full" ? "integrity_check" : "quick_check"}`)
      .all()
      .flatMap((row) => Object.values(row))
      .join(", ")
    const foreignKeyViolations = database.query<Record<string, unknown>, []>("PRAGMA foreign_key_check").all().length
    return { path: filename, kind, ok: result === "ok" && foreignKeyViolations === 0, result, foreignKeyViolations }
  } catch (cause) {
    return { path: filename, kind, ok: false, error: cause instanceof Error ? cause.message : String(cause) }
  } finally {
    database.close()
  }
}

async function checkBlobs(
  config: Config,
  databases: ReadonlyArray<string>,
  level: "quick" | "full",
): Promise<BlobIntegrity> {
  const metadata = new Map<string, { readonly size: number; readonly storagePath: string }>()
  databases.forEach((filename) => {
    const database = openReadonlyDatabase(filename)
    if (!database) return
    try {
      if (!hasTable(database, "content_blob")) return
      database
        .query<{ readonly sha256: string; readonly size: number; readonly storagePath: string }, []>(
          "SELECT sha256, size_bytes AS size, storage_path AS storagePath FROM content_blob",
        )
        .all()
        .forEach((row) => metadata.set(row.sha256, { size: row.size, storagePath: row.storagePath }))
    } finally {
      database.close()
    }
  })
  const checks: Array<"ok" | "missing" | "size" | "hash" | "unsafe"> = []
  for (const [sha256, blob] of metadata) {
    checks.push(await checkBlob(config, level, sha256, blob))
  }
  return {
    checked: checks.length,
    missing: checks.filter((result) => result === "missing").length,
    sizeMismatch: checks.filter((result) => result === "size").length,
    hashMismatch: checks.filter((result) => result === "hash").length,
    unsafePath: checks.filter((result) => result === "unsafe").length,
  }
}

async function checkBlob(
  config: Config,
  level: "quick" | "full",
  sha256: string,
  blob: { readonly size: number; readonly storagePath: string },
) {
  const expected = path.join("content", sha256.slice(0, 2), sha256)
  if (
    !/^[0-9a-f]{64}$/.test(sha256) ||
    path.isAbsolute(blob.storagePath) ||
    path.normalize(blob.storagePath) !== expected
  )
    return "unsafe" as const
  const filename = path.resolve(config.data, blob.storagePath)
  if (!sameOrChildPath(config.data, filename)) return "unsafe" as const
  if (!(await fileExists(filename))) return "missing" as const
  if ((await stat(filename)).size !== blob.size) return "size" as const
  if (level === "quick") return "ok" as const
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(filename)) hash.update(chunk)
  return hash.digest("hex") === sha256 ? ("ok" as const) : ("hash" as const)
}

function openReadonlyDatabase(filename: string) {
  try {
    if (!statSync(filename).size) return undefined
    const database = new Database(filename, { readonly: true, strict: true })
    database.exec("PRAGMA busy_timeout = 3000")
    return database
  } catch {
    return undefined
  }
}

function hasTable(database: Database, table: string) {
  return (
    database
      .query<{ readonly count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(table)?.count === 1
  )
}

function samePath(left: string, right: string) {
  const resolved = [left, right].map((filename) => path.resolve(filename))
  if (process.platform === "win32") return resolved[0]?.toLowerCase() === resolved[1]?.toLowerCase()
  return resolved[0] === resolved[1]
}

function sameOrChildPath(parent: string, candidate: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

async function directoryExists(directory: string) {
  return (await stat(directory).catch(() => undefined))?.isDirectory() ?? false
}
