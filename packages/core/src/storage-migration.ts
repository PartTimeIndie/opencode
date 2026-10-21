export * as StorageMigration from "./storage-migration"

import { Database as Sqlite } from "#maintenance-sqlite"
import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { createReadStream, existsSync } from "node:fs"
import { copyFile, lstat, mkdir, opendir, readFile, readdir, realpath, rename, rm, stat, statfs, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout } from "node:timers/promises"
import { isDeepStrictEqual } from "node:util"
import { and, eq, sql } from "drizzle-orm"
import { Cause, DateTime, Effect, Layer, Schema } from "effect"
import {
  CONTENT_MIGRATION_VERSION,
  assertContentMigrationSource,
  migrateLegacyContent,
  migrateLegacySessionContent,
  type Manifest as ContentManifest,
  type Progress as ContentProgress,
} from "./content-migration"
import { Database } from "./database/database"
import { EventV2 } from "./event"
import { ProjectV2 } from "./project"
import { SessionArchive } from "./session-archive"
import { SessionEvent } from "./session/event"
import { SessionMessage } from "./session/message"
import { SessionProjector } from "./session/projector"
import { SessionSchema } from "./session/schema"
import { SessionMessageTable } from "./session/sql"
import { StorageActivation } from "./storage-activation"
import { IsolatedWorker } from "./isolated-worker"

export const STORAGE_MIGRATION_VERSION = 4
const DEFAULT_INACTIVE_MS = 7 * 24 * 60 * 60 * 1_000
const DEFAULT_SHARD_BYTES = 2_000_000_000
const DEFAULT_DEVIATION = 0.1
const CHECKPOINT_BATCH_SIZE = 64
const PHASES = [
  "initialized",
  "content-migrated",
  "sessions-migrated",
  "paths-rewritten",
  "finalizing",
  "validated",
  "prepared",
  "complete",
] as const

export type Mode = "dry-run" | "prepare"
export type Phase = (typeof PHASES)[number]

export type QuarantineApproval = {
  readonly reportSha256: string
  readonly approvedBy: string
  readonly reason: string
  readonly reviewedAt: number
}

export type SavingsExpectation = {
  readonly savedBytes: number
  readonly maxDeviationRatio?: number
}

export type Options = {
  readonly mode: Mode
  readonly databaseKind: StorageActivation.DatabaseKind
  readonly sourceDatabase: string
  readonly stagingDirectory: string
  readonly dryRunSnapshotDirectory?: string
  readonly liveBlobDirectory: string
  readonly liveArchiveDirectory: string
  readonly inactiveMs?: number
  readonly maxShardBytes?: number
  readonly batchSize?: number
  readonly maxBatchBytes?: number
  readonly maxRows?: number
  readonly structuredThresholdBytes?: number
  readonly maxContentBytes?: number
  readonly sessionWorker?: (inputPath: string) => Promise<void>
  readonly quarantineApproval?: QuarantineApproval
  readonly expectedDryRun?: SavingsExpectation
  readonly minimumSavingsBytes?: number
  readonly onProgress?: (progress: Progress) => void | Promise<void>
  readonly testHooks?: {
    readonly afterArchiveContentState?: (
      state: Exclude<ArchiveContentJournal["state"], "initialized">,
    ) => void | Promise<void>
    readonly candidateCompactionAvailableBytes?: number
    readonly afterCandidateCompactionBackup?: () => void | Promise<void>
    readonly initialMigrationAvailableBytes?: number
  }
}

export type Progress = {
  readonly phase: Phase
  readonly checkpointedSessions: number
  readonly archivedSessions: number
  readonly message: string
  readonly content?: ContentProgress
}

export type Report = {
  readonly sourceBytes: number
  readonly activeDatabaseBytes: number
  readonly archiveBytes: number
  readonly blobBytes: number
  readonly candidateBytes: number
  readonly savedBytes: number
  readonly savedRatio: number
  readonly checkpointedSessions: number
  readonly archivedSessions: number
  readonly activeSessions: number
  readonly quarantineCount: number
  readonly content: ContentManifest["report"]
}

export type Manifest = {
  readonly version: typeof STORAGE_MIGRATION_VERSION
  readonly kind: "opencode-storage-migration"
  readonly mode: Mode
  readonly databaseKind: StorageActivation.DatabaseKind
  readonly status: "running" | "quarantine-required" | "complete"
  readonly phase: Phase
  readonly paths: Paths
  readonly config: Config
  readonly events: ReadonlyArray<{
    readonly phase: Phase
    readonly time: number
    readonly checkpointedSessions: number
    readonly archivedSessions: number
  }>
  readonly checkpointedSessions: number
  readonly archivedSessions: number
  readonly contentManifest?: ContentManifest
  readonly quarantineApproval?: QuarantineApproval
  readonly report?: Report
  readonly activationManifest?: StorageActivation.Manifest
  readonly createdAt: number
  readonly updatedAt: number
}

type Paths = {
  readonly sourceDatabase: string
  readonly migrationSourceDatabase: string
  readonly sourceSnapshotDirectory?: string
  readonly stagingDirectory: string
  readonly candidateDatabase: string
  readonly candidateBlobDirectory: string
  readonly candidateArchiveDirectory: string
  readonly liveBlobDirectory: string
  readonly liveArchiveDirectory: string
  readonly journalPath: string
  readonly activationManifestPath: string
  readonly quarantineRequirementPath: string
}

type Config = {
  readonly inactiveMs: number
  readonly maxShardBytes: number
  readonly contentEngineVersion: typeof CONTENT_MIGRATION_VERSION
  readonly structuredThresholdBytes?: number
  readonly maxContentBytes?: number
}

type QuarantineRequirement = {
  readonly version: 1
  readonly kind: "opencode-storage-quarantine-approval"
  readonly reportSha256: string
  readonly count: number
  readonly report: ReadonlyArray<ContentManifest["quarantine"][number]>
  readonly createdAt: number
}

export class Error extends globalThis.Error {
  readonly code: "configuration" | "journal" | "content" | "quarantine" | "checkpoint" | "archive" | "integrity" | "savings"

  constructor(code: Error["code"], message: string, options?: { readonly cause?: unknown }) {
    super(message, options)
    this.name = "StorageMigration.Error"
    this.code = code
  }
}

/**
 * Builds and validates an isolated candidate. `dry-run` intentionally performs
 * the complete transformation so its physical-size result can be compared to
 * a later `prepare` run. Neither mode activates or replaces the source DB.
 */
export async function run(options: Options): Promise<Manifest> {
  const input = await validateOptions(options)
  const existing = await readJournal(input.paths.journalPath)
  if (!existing) await requireFreeSpace(input, options.testHooks?.initialMigrationAvailableBytes)
  const initial = existing ?? {
    version: STORAGE_MIGRATION_VERSION,
    kind: "opencode-storage-migration",
    mode: input.mode,
    databaseKind: input.databaseKind,
    status: "running",
    phase: "initialized",
    paths: input.paths,
    config: input.config,
    events: [{ phase: "initialized", time: Date.now(), checkpointedSessions: 0, archivedSessions: 0 }],
    checkpointedSessions: 0,
    archivedSessions: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } satisfies Manifest
  assertResume(initial, input)
  await saveJournal(input.paths.journalPath, initial)
  await notify(options, initial, "Storage migration staging initialized")
  if (input.mode === "dry-run" && !phaseAtLeast(initial.phase, "content-migrated"))
    await ensureDryRunSnapshot(input)

  const archiveContentStarted = existsSync(path.join(input.paths.stagingDirectory, "archive-content-migration.json"))
  const migratedContent = phaseAtLeast(initial.phase, "content-migrated") || archiveContentStarted
    ? initial.contentManifest ?? (await readContentManifest(input.paths.stagingDirectory))
    : await migrateLegacyContent({
        mode: "stage",
        sourceDatabase: input.paths.migrationSourceDatabase,
        stagingDirectory: input.paths.stagingDirectory,
        ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
        ...(options.maxBatchBytes === undefined ? {} : { maxBatchBytes: options.maxBatchBytes }),
        ...(options.maxRows === undefined ? {} : { maxRows: options.maxRows }),
        ...(options.structuredThresholdBytes === undefined
          ? {}
          : { structuredThresholdBytes: options.structuredThresholdBytes }),
        ...(options.maxContentBytes === undefined ? {} : { maxContentBytes: options.maxContentBytes }),
        onProgress: async (progress) =>
          options.onProgress?.({
            phase: initial.phase,
            checkpointedSessions: initial.checkpointedSessions,
            archivedSessions: initial.archivedSessions,
            message:
              progress.state === "checkpointed"
                ? `Content migration checkpointed ${progress.rowsScanned} rows in ${progress.checkpointTransactions} transactions`
                : progress.state === "finalizing"
                  ? "Content migration finalizing the standalone candidate database"
                  : "Content migration is waiting for staging database readers before handoff",
            content: progress,
          }),
      }).catch((cause) => {
        throw new Error("content", "Content migration failed", { cause })
      })
  assertContentManifest(migratedContent)
  if (
    initial.phase !== "complete" &&
    (input.mode === "prepare" || !phaseAtLeast(initial.phase, "content-migrated"))
  ) await assertContentMigrationSource(migratedContent)
  if (migratedContent.status === "incomplete")
    throw new Error("content", "Content migration is incomplete; rerun the same staging journal to continue")
  const content = phaseAtLeast(initial.phase, "sessions-migrated")
    ? migratedContent
    : await stageExistingStorage(input, options)
  const approved = await requireQuarantineApproval(input, content, options.quarantineApproval)
  const afterContent = phaseAtLeast(initial.phase, "content-migrated")
    ? { ...initial, contentManifest: content, quarantineApproval: approved }
    : await advance(input, { ...initial, contentManifest: content, quarantineApproval: approved }, "content-migrated")
  await releaseDryRunSnapshot(input, afterContent)

  const afterSessions = phaseAtLeast(afterContent.phase, "sessions-migrated")
    ? afterContent
    : await migrateSessions(input, afterContent, options)
  const afterPaths = phaseAtLeast(afterSessions.phase, "paths-rewritten")
    ? afterSessions
    : await rewriteArchivePaths(input, afterSessions)
  const finalizing = phaseAtLeast(afterPaths.phase, "finalizing")
    ? afterPaths
    : await advance(input, afterPaths, "finalizing")
  if (!phaseAtLeast(finalizing.phase, "validated"))
    await finalizeCandidate(
      input.paths.candidateDatabase,
      input.paths.candidateArchiveDirectory,
      options.testHooks,
    )
  const report = phaseAtLeast(finalizing.phase, "validated") && finalizing.report
    ? finalizing.report
    : await validateCandidate(input, finalizing, content)
  assertSavings(input, report, options)
  const validated = phaseAtLeast(finalizing.phase, "validated")
    ? { ...finalizing, report }
    : await advance(input, { ...finalizing, report }, "validated")

  const prepared =
    phaseAtLeast(validated.phase, "prepared")
      ? validated
      : options.mode === "prepare"
        ? await prepareActivation(input, validated)
        : await advance(input, validated, "prepared")
  const complete = phaseAtLeast(prepared.phase, "complete")
    ? prepared
    : await advance(input, { ...prepared, status: "complete", report }, "complete")
  await notify(options, complete, "Candidate complete; source database was not activated")
  await releaseDryRunSnapshot(input, complete)
  return complete
}

async function releaseDryRunSnapshot(input: Input, manifest: Manifest) {
  if (input.mode !== "dry-run" || !input.paths.sourceSnapshotDirectory || !phaseAtLeast(manifest.phase, "content-migrated"))
    return
  await retryTransientFileOperation(() =>
    rm(input.paths.sourceSnapshotDirectory!, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  )
}

const SHA256 = /^[0-9a-f]{64}$/

type ArchiveContentJournal = {
  readonly version: 1
  readonly engineVersion: typeof CONTENT_MIGRATION_VERSION
  readonly sessionIDs: ReadonlyArray<string>
  readonly state: "initialized" | "reactivated" | "content-migrated" | "rearchived"
}

async function stageExistingStorage(input: Input, options: Options) {
  await Promise.all([
    mkdir(input.paths.candidateBlobDirectory, { recursive: true }),
    mkdir(input.paths.candidateArchiveDirectory, { recursive: true }),
  ])
  const database = new Sqlite(input.paths.candidateDatabase, { strict: true })
  try {
    await stageExistingBlobs(database, input)
    await stageExistingArchives(database, input)
  } finally {
    database.close()
  }
  const journalPath = path.join(input.paths.stagingDirectory, "archive-content-migration.json")
  const existing = existsSync(journalPath)
    ? JSON.parse(await readFile(journalPath, "utf8")) as ArchiveContentJournal
    : undefined
  const sessionIDs = existing?.sessionIDs ?? archivedSessionIDs(input.paths.candidateDatabase)
  if (
    existing &&
    (existing.version !== 1 ||
      existing.engineVersion !== CONTENT_MIGRATION_VERSION ||
      !Array.isArray(existing.sessionIDs) ||
      existing.sessionIDs.some((sessionID) => typeof sessionID !== "string") ||
      JSON.stringify(existing.sessionIDs) !== JSON.stringify([...new Set(existing.sessionIDs)].sort()) ||
      !["initialized", "reactivated", "content-migrated", "rearchived"].includes(existing.state))
  ) throw new Error("journal", "Archive content migration journal is incompatible")
  const journal = existing ?? {
    version: 1,
    engineVersion: CONTENT_MIGRATION_VERSION,
    sessionIDs,
    state: "initialized",
  } satisfies ArchiveContentJournal
  if (!existing) await writeDurable(journalPath, journal)
  if (sessionIDs.length === 0) return readContentManifest(input.paths.stagingDirectory)
  if (journal.state === "initialized") {
    await reactivateArchivedSessions(input, sessionIDs)
    await writeDurable(journalPath, { ...journal, state: "reactivated" } satisfies ArchiveContentJournal)
    await options.testHooks?.afterArchiveContentState?.("reactivated")
  }
  if (["initialized", "reactivated"].includes(journal.state)) {
    await migrateLegacySessionContent({
      stagingDirectory: input.paths.stagingDirectory,
      sessionIDs,
      ...(input.config.structuredThresholdBytes === undefined
        ? {}
        : { structuredThresholdBytes: input.config.structuredThresholdBytes }),
      ...(input.config.maxContentBytes === undefined ? {} : { maxContentBytes: input.config.maxContentBytes }),
    })
    await writeDurable(journalPath, { ...journal, state: "content-migrated" } satisfies ArchiveContentJournal)
    await options.testHooks?.afterArchiveContentState?.("content-migrated")
  }
  if (journal.state !== "rearchived") {
    await rearchiveMigratedSessions(input, sessionIDs)
    await pruneSupersededArchiveRevisions(input, sessionIDs)
    await writeDurable(journalPath, { ...journal, state: "rearchived" } satisfies ArchiveContentJournal)
    await options.testHooks?.afterArchiveContentState?.("rearchived")
  }
  return readContentManifest(input.paths.stagingDirectory)
}

function archivedSessionIDs(filename: string) {
  const database = new Sqlite(filename, { readonly: true, strict: true })
  try {
    if (!tableExists(database, "session_archive_catalog")) return []
    return database
      .query<{ readonly session_id: string }, []>(
        "SELECT session_id FROM session_archive_catalog WHERE location = 'archived' ORDER BY session_id",
      )
      .all()
      .map((row) => row.session_id)
  } finally {
    database.close()
  }
}

async function reactivateArchivedSessions(input: Input, sessionIDs: ReadonlyArray<string>) {
  const database = Database.layerFromPath(input.paths.candidateDatabase, { deferStartupRepairs: false })
  const archive = SessionArchive.layer({
    directory: input.paths.candidateArchiveDirectory,
    inactiveMs: input.config.inactiveMs,
    maxShardBytes: input.config.maxShardBytes,
    isIdle: () => Effect.succeed(true),
  }).pipe(Layer.provide(database))
  await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* SessionArchive.Service
      yield* service.initialize
      yield* Effect.forEach(
        sessionIDs,
        (sessionID) => service.ensureActive(SessionSchema.ID.make(sessionID)),
        { concurrency: 1, discard: true },
      )
    }).pipe(Effect.provide(Layer.mergeAll(database, archive)), Effect.scoped),
  )
  if (typeof Bun !== "undefined") Bun.gc(true)
}

async function rearchiveMigratedSessions(input: Input, sessionIDs: ReadonlyArray<string>) {
  const database = Database.layerFromPath(input.paths.candidateDatabase, { deferStartupRepairs: false })
  const archive = SessionArchive.layer({
    directory: input.paths.candidateArchiveDirectory,
    // These sessions were archived before this offline migration. Newly
    // externalized attachment metadata has a fresh creation timestamp, but it
    // must not postpone restoring their original archived state.
    inactiveMs: 0,
    maxShardBytes: input.config.maxShardBytes,
    isIdle: () => Effect.succeed(true),
  }).pipe(Layer.provide(database))
  await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* SessionArchive.Service
      yield* service.initialize
      yield* Effect.forEach(
        sessionIDs,
        (sessionID) =>
          Effect.gen(function* () {
            const catalog = yield* service.getCatalog(SessionSchema.ID.make(sessionID))
            if (catalog.location === "archived") return
            const result = yield* service.archiveOne(SessionSchema.ID.make(sessionID))
            if (!result) return yield* Effect.die(`Restored archive session ${sessionID} was not rearchived`)
          }),
        { concurrency: 1, discard: true },
      )
    }).pipe(Effect.provide(Layer.mergeAll(database, archive)), Effect.scoped),
  )
  if (typeof Bun !== "undefined") Bun.gc(true)
}

async function pruneSupersededArchiveRevisions(input: Input, sessionIDs: ReadonlyArray<string>) {
  const central = new Sqlite(input.paths.candidateDatabase, { readonly: true, strict: true })
  const revisions = new Map<string, number>()
  const archives: Array<{ readonly id: string; readonly path: string }> = []
  try {
    if (!tableExists(central, "session_archive_catalog")) return
    const select = central.prepare(
      "SELECT revision FROM session_archive_catalog WHERE session_id = ? AND location = 'archived'",
    )
    sessionIDs.forEach((sessionID) => {
      const row = select.get(sessionID) as { readonly revision: number } | null
      if (row) revisions.set(sessionID, row.revision)
    })
    central
      .query<{ readonly id: string; readonly path: string }, []>("SELECT id, path FROM session_archive_shard ORDER BY id")
      .all()
      .forEach((row) => {
        const filename = path.resolve(row.path)
        if (!contains(input.paths.candidateArchiveDirectory, filename))
          throw new Error("integrity", `Archive shard escapes candidate directory: ${filename}`)
        archives.push({ id: row.id, path: filename })
      })
  } finally {
    central.close()
  }
  const retired: Array<{ readonly id: string; readonly path: string }> = []
  for (const archive of archives) {
    const shard = new Sqlite(archive.path, { readonly: true, strict: true })
    try {
      const rows = shard
        .query<{ readonly session_id: string; readonly revision: number }, []>(
          "SELECT session_id, revision FROM archive_session",
        )
        .all()
      if (
        rows.every((row) => {
          const revision = revisions.get(row.session_id)
          return revision !== undefined && row.revision < revision
        })
      ) retired.push(archive)
    } catch (cause) {
      throw new Error("archive", `Unable to inspect superseded archive revisions in ${archive.path}`, { cause })
    } finally {
      shard.close()
    }
  }
  if (retired.length > 0) {
    const catalog = new Sqlite(input.paths.candidateDatabase, { strict: true })
    try {
      catalog.transaction(() => {
        const removeJournal = catalog.prepare("DELETE FROM session_archive_journal WHERE shard_id = ?")
        const removeShard = catalog.prepare("DELETE FROM session_archive_shard WHERE id = ?")
        retired.forEach((archive) => {
          removeJournal.run(archive.id)
          removeShard.run(archive.id)
        })
      })()
    } finally {
      catalog.close()
    }
  }
  if (typeof Bun !== "undefined") Bun.gc(true)
  globalThis.gc?.()
  await Promise.all(
    retired.flatMap((archive) =>
      [archive.path, `${archive.path}-wal`, `${archive.path}-shm`, `${archive.path}-journal`].map((filename) =>
        removeArchiveFile(filename),
      ),
    ),
  )
  await removeUnreferencedCandidateArchives(input)
}

async function removeArchiveFile(filename: string, attempt = 0): Promise<void> {
  return rm(filename, { force: true }).catch(async (cause) => {
    if (
      !(cause instanceof globalThis.Error) ||
      !("code" in cause) ||
      !["EBUSY", "EPERM"].includes(String(cause.code)) ||
      attempt >= 50
    ) throw cause
    if (typeof Bun !== "undefined") Bun.gc(true)
    globalThis.gc?.()
    await setTimeout(100)
    return removeArchiveFile(filename, attempt + 1)
  })
}

async function removeUnreferencedCandidateArchives(input: Input) {
  const database = new Sqlite(input.paths.candidateDatabase, { readonly: true, strict: true })
  const referenced = new Set<string>()
  try {
    if (tableExists(database, "session_archive_shard"))
      database
        .query<{ readonly path: string }, []>("SELECT path FROM session_archive_shard")
        .all()
        .forEach((row) => referenced.add(path.resolve(row.path)))
  } finally {
    database.close()
  }
  const entries = await readdir(input.paths.candidateArchiveDirectory, { withFileTypes: true })
  const unreferenced = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        [".db", ".sqlite"].includes(path.extname(entry.name).toLowerCase()) &&
        !referenced.has(path.resolve(input.paths.candidateArchiveDirectory, entry.name)),
    )
    .map((entry) => path.join(input.paths.candidateArchiveDirectory, entry.name))
  await Promise.all(
    unreferenced.flatMap((filename) =>
      [filename, `${filename}-wal`, `${filename}-shm`, `${filename}-journal`].map((target) =>
        removeArchiveFile(target),
      ),
    ),
  )
}

async function stageExistingBlobs(database: Sqlite, input: Input) {
  if (!tableExists(database, "content_blob")) return
  const rows = database
    .query<
      { readonly sha256: string; readonly size_bytes: number; readonly storage_path: string },
      []
    >("SELECT sha256, size_bytes, storage_path FROM content_blob ORDER BY sha256")
    .all()
  for (const row of rows) {
    const target = candidateBlobPath(input, row)
    if (existsSync(target)) {
      await verifyBlobFile(target, row.sha256, row.size_bytes)
      continue
    }
    const source = liveBlobPath(input, row)
    await requireContainedFile(input.paths.liveBlobDirectory, source, `Live blob ${row.sha256}`)
    await verifyBlobFile(source, row.sha256, row.size_bytes)
    await mkdir(path.dirname(target), { recursive: true })
    const temporary = `${target}.stage.tmp`
    await rm(temporary, { force: true })
    try {
      await copyFile(source, temporary)
      await verifyBlobFile(temporary, row.sha256, row.size_bytes)
      await rename(temporary, target)
    } finally {
      await rm(temporary, { force: true })
    }
  }
}

async function stageExistingArchives(database: Sqlite, input: Input) {
  if (!tableExists(database, "session_archive_shard")) return
  const rows = database
    .query<{ readonly id: string; readonly path: string }, []>("SELECT id, path FROM session_archive_shard ORDER BY id")
    .all()
  const updates: Array<{ readonly id: string; readonly path: string }> = []
  for (const row of rows) {
    if (!path.isAbsolute(row.path)) throw new Error("integrity", `Archive shard path is not absolute: ${row.path}`)
    const resolved = path.resolve(row.path)
    const candidateRelative = path.relative(input.paths.candidateArchiveDirectory, resolved)
    if (
      contains(input.paths.candidateArchiveDirectory, resolved) &&
      path.dirname(candidateRelative) === "." &&
      [".db", ".sqlite"].includes(path.extname(candidateRelative).toLowerCase())
    ) {
      await verifyArchiveFile(resolved)
      updates.push({ id: row.id, path: resolved })
      continue
    }
    const relative = path.relative(input.paths.liveArchiveDirectory, resolved)
    if (
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      path.dirname(relative) !== "." ||
      ![".db", ".sqlite"].includes(path.extname(relative).toLowerCase())
    )
      throw new Error("integrity", `Archive shard escapes the live archive directory: ${row.path}`)
    await requireContainedFile(input.paths.liveArchiveDirectory, resolved, `Archive shard ${row.id}`)
    const target = path.join(input.paths.candidateArchiveDirectory, relative)
    await snapshotArchive(resolved, target)
    updates.push({ id: row.id, path: target })
  }
  const update = database.prepare("UPDATE session_archive_shard SET path = ?, state = 'sealed' WHERE id = ?")
  database.transaction(() => updates.forEach((row) => update.run(row.path, row.id)))()
}

async function snapshotArchive(source: string, target: string) {
  if (existsSync(target)) {
    await verifyArchiveFile(target)
    return
  }
  const temporary = `${target}.stage.tmp`
  await rm(temporary, { force: true })
  if (
    (await stat(`${source}-wal`)
      .then((info) => info.size)
      .catch(() => 0)) > 0
  )
    throw new Error("archive", `Existing archive shard has uncheckpointed WAL state: ${source}`)
  await verifyArchiveFile(source)
  const before = await fingerprintFile(source)
  try {
    await copyFile(source, temporary)
    await verifyArchiveFile(temporary)
    const [after, copied] = await Promise.all([fingerprintFile(source), fingerprintFile(temporary)])
    if (after.sha256 !== before.sha256 || after.sizeBytes !== before.sizeBytes)
      throw new Error("archive", `Existing archive shard changed while it was staged: ${source}`)
    if (copied.sha256 !== before.sha256 || copied.sizeBytes !== before.sizeBytes)
      throw new Error("archive", `Existing archive shard copy does not match its source: ${source}`)
    await rename(temporary, target)
  } finally {
    await Promise.all(
      [temporary, `${temporary}-wal`, `${temporary}-shm`, `${temporary}-journal`].map((filename) =>
        rm(filename, { force: true }),
      ),
    )
  }
}

async function verifyArchiveFile(filename: string) {
  const database = new Sqlite(filename, { readonly: true, strict: true })
  try {
    assertSqlite(database, filename)
  } finally {
    database.close()
  }
}

function candidateBlobPath(
  input: Input,
  row: { readonly sha256: string; readonly size_bytes: number; readonly storage_path: string },
) {
  assertBlobRow(row)
  return path.join(input.paths.candidateBlobDirectory, row.sha256.slice(0, 2), row.sha256)
}

function liveBlobPath(
  input: Input,
  row: { readonly sha256: string; readonly size_bytes: number; readonly storage_path: string },
) {
  assertBlobRow(row)
  return path.join(input.paths.liveBlobDirectory, row.sha256.slice(0, 2), row.sha256)
}

function assertBlobRow(row: { readonly sha256: string; readonly size_bytes: number; readonly storage_path: string }) {
  const expected = path.join("content", row.sha256.slice(0, 2), row.sha256)
  if (
    !SHA256.test(row.sha256) ||
    !Number.isSafeInteger(row.size_bytes) ||
    row.size_bytes < 0 ||
    path.isAbsolute(row.storage_path) ||
    path.normalize(row.storage_path) !== expected
  )
    throw new Error("integrity", `Content blob metadata is invalid: ${row.sha256}`)
}

async function verifyBlobFile(filename: string, sha256: string, sizeBytes: number) {
  const info = await lstat(filename).catch((cause) => {
    throw new Error("integrity", `Content blob is missing: ${sha256}`, { cause })
  })
  if (!info.isFile() || info.isSymbolicLink() || info.size !== sizeBytes)
    throw new Error("integrity", `Content blob size or file type is invalid: ${sha256}`)
  const digest = createHash("sha256")
  await new Promise<void>((resolve, reject) => {
    createReadStream(filename)
      .on("data", (chunk) => digest.update(chunk))
      .on("error", reject)
      .on("end", resolve)
  })
  if (digest.digest("hex") !== sha256)
    throw new Error("integrity", `Content blob bytes do not match their address: ${sha256}`)
}

async function fingerprintFile(filename: string) {
  const info = await stat(filename)
  const digest = createHash("sha256")
  await new Promise<void>((resolve, reject) => {
    createReadStream(filename)
      .on("data", (chunk) => digest.update(chunk))
      .on("error", reject)
      .on("end", resolve)
  })
  return { sizeBytes: info.size, sha256: digest.digest("hex") }
}

async function requireContainedFile(root: string, filename: string, label: string) {
  const [canonicalRoot, canonicalFile, info] = await Promise.all([
    realpath(root),
    realpath(filename),
    lstat(filename),
  ]).catch((cause) => {
    throw new Error("integrity", `${label} is missing or inaccessible`, { cause })
  })
  if (!contains(canonicalRoot, canonicalFile) || !info.isFile() || info.isSymbolicLink())
    throw new Error("integrity", `${label} is not a regular file inside its explicit root`)
}

async function migrateSessions(input: Input, manifest: Manifest, options: Options) {
  const workerInput = path.join(input.paths.stagingDirectory, "storage-migration-worker.json")
  const workerProgress = path.join(input.paths.stagingDirectory, "storage-migration-worker-progress.json")
  await writeDurable(workerInput, {
    input,
    checkpointedSessions: manifest.checkpointedSessions,
    archivedSessions: manifest.archivedSessions,
    progressPath: workerProgress,
  } satisfies WorkerInput)
  if (options.sessionWorker) await options.sessionWorker(workerInput)
  if (!options.sessionWorker) {
    const child = typeof Bun === "undefined"
      ? IsolatedWorker.launch(["storage", "session-worker", workerInput])
      : spawn(process.execPath, [import.meta.filename, "session-worker", workerInput], {
          cwd: process.cwd(),
          stdio: ["ignore", "ignore", "pipe"],
          windowsHide: true,
        })
    child.stdin?.end()
    const stderr: Buffer[] = []
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk))
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject)
      child.once("close", (code) => resolve(code ?? 1))
    })
    if (exitCode !== 0)
      throw new Error(
        "archive",
        Buffer.concat(stderr).toString("utf8").trim() || `Storage migration worker exited ${exitCode}`,
      )
  }
  const progress = JSON.parse(await readFile(workerProgress, "utf8")) as WorkerProgress
  const next = await advance(
    input,
    {
      ...manifest,
      checkpointedSessions: progress.checkpointedSessions,
      archivedSessions: progress.archivedSessions,
    },
    "sessions-migrated",
  )
  await notify(options, next, "Checkpoint projections verified and inactive sessions archived")
  return next
}

type WorkerInput = {
  readonly input: Input
  readonly checkpointedSessions: number
  readonly archivedSessions: number
  readonly progressPath: string
}

type WorkerProgress = {
  readonly checkpointedSessions: number
  readonly archivedSessions: number
}

function checkpointNeedsUpgrade(row: {
  readonly current_seq: number
  readonly checkpoint_seq: number | null
  readonly checkpoint_version: number | null
  readonly checkpoint_data: unknown
  readonly covered_events: number
}) {
  if (
    row.checkpoint_version !== EventV2.CheckpointVersion ||
    row.checkpoint_seq !== row.current_seq ||
    row.covered_events !== 0
  ) return true
  try {
    const data = typeof row.checkpoint_data === "string" ? JSON.parse(row.checkpoint_data) : row.checkpoint_data
    if (typeof data !== "object" || data === null || Array.isArray(data)) return true
    const baseline = EventV2.readStoredCheckpointBaseline(data as Record<string, unknown>)
    if (
      baseline.adapter !== SessionProjector.CheckpointAdapterID ||
      baseline.version !== SessionProjector.CheckpointAdapterVersion ||
      !Array.isArray(baseline.data.legacyMessages) ||
      !Array.isArray(baseline.data.legacyParts) ||
      !Array.isArray(baseline.data.messages)
    ) return true
    const reference = baseline.data.legacyProjectionReference
    if (reference !== undefined && !isRecord(reference)) return true
    return baseline.data.legacyMessages.length > 0 ||
      baseline.data.legacyParts.length > 0 ||
      baseline.data.messages.length > 0
  } catch {
    return true
  }
}

async function migrateSessionsInProcess(worker: WorkerInput) {
  const input = worker.input
  // Desktop-sidecar workers inherit deferred startup repairs from the live
  // server. This candidate is isolated and worker-owned, so its schema must be
  // ready before checkpoint and archive queries run.
  const database = Database.layerFromPath(input.paths.candidateDatabase, { deferStartupRepairs: false })
  const events = EventV2.layer.pipe(Layer.provide(database))
  const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  const archive = SessionArchive.layer({
    directory: input.paths.candidateArchiveDirectory,
    inactiveMs: input.config.inactiveMs,
    maxShardBytes: input.config.maxShardBytes,
    isIdle: () => Effect.succeed(true),
  }).pipe(Layer.provide(database))
  const runtime = Layer.mergeAll(database, events, projector, archive)
  const progress = { checkpointed: worker.checkpointedSessions, archived: worker.archivedSessions }

  await Effect.runPromise(
    Effect.gen(function* () {
      const eventService = yield* EventV2.Service
      const archiveService = yield* SessionArchive.Service
      const { db } = yield* Database.Service
      yield* archiveService.initialize
      yield* repairUnrecordedSessionProjects(db, eventService)
      yield* upgradeLegacyProjectedActivityFailures(db)
      yield* repairUnprojectedCustomParts(db)

      let checkpointCursor = ""
      while (true) {
        const checkpointRows = yield* db
          .all<{
            id: string
            current_seq: number
            checkpoint_seq: number | null
            checkpoint_version: number | null
            checkpoint_data: unknown
            covered_events: number
          }>(sql`
            SELECT s.id, es.seq AS current_seq, ec.seq AS checkpoint_seq, ec.version AS checkpoint_version,
              ec.data AS checkpoint_data,
              EXISTS (SELECT 1 FROM event e WHERE e.aggregate_id = s.id AND e.seq <= ec.seq) AS covered_events
            FROM session s
            JOIN event_sequence es ON es.aggregate_id = s.id
            LEFT JOIN event_checkpoint ec ON ec.aggregate_id = s.id
            WHERE s.id > ${checkpointCursor}
            ORDER BY s.id
            LIMIT ${CHECKPOINT_BATCH_SIZE}
          `)
          .pipe(Effect.orDie)
        if (checkpointRows.length === 0) break
        checkpointCursor = checkpointRows.at(-1)!.id
        yield* Effect.forEach(
          checkpointRows.filter(checkpointNeedsUpgrade),
          (row) =>
            Effect.gen(function* () {
              const result = yield* eventService.compactCheckpoint(row.id).pipe(
                Effect.catchCause((cause) =>
                  Effect.die(
                    new Error(
                      "checkpoint",
                      `Session ${row.id} checkpoint verification failed:\n${boundedCause(cause)}`,
                    ),
                  ),
                ),
              )
              if (!result)
                return yield* Effect.die(
                  new Error("checkpoint", `Session ${row.id} has no trusted checkpoint projection`),
                )
              progress.checkpointed += 1
              yield* Effect.tryPromise(() =>
                saveWorkerProgress(worker.progressPath, progress),
              ).pipe(Effect.orDie)
            }),
          { concurrency: 1, discard: true },
        )
      }

      const drain = Effect.gen(function* () {
        let candidates = yield* archiveService.candidates(100)
        while (candidates.length > 0) {
          for (const sessionID of candidates) {
            const checkpoint = yield* db.get<{
              seq: number | null
              version: number | null
              current_seq: number
            }>(sql`
              SELECT ec.seq, ec.version, es.seq AS current_seq
              FROM event_sequence es LEFT JOIN event_checkpoint ec ON ec.aggregate_id = es.aggregate_id
              WHERE es.aggregate_id = ${sessionID}
            `)
            if (
              checkpoint &&
              (checkpoint.version !== EventV2.CheckpointVersion || checkpoint.seq !== checkpoint.current_seq)
            )
              return yield* Effect.die(
                new Error("checkpoint", `Archive candidate ${sessionID} has no complete versioned checkpoint`),
              )
            const result = yield* archiveService.archiveOne(sessionID)
            if (!result) return yield* Effect.die(new Error("archive", `Session ${sessionID} was not archived`))
            progress.archived += 1
            yield* Effect.tryPromise(() =>
              saveWorkerProgress(worker.progressPath, progress),
            ).pipe(Effect.orDie)
          }
          candidates = yield* archiveService.candidates(100)
        }
      })

      yield* drain
    }).pipe(Effect.provide(runtime), Effect.scoped),
  ).catch((cause) => {
    if (cause instanceof Error) throw cause
    throw new Error("archive", `Checkpoint or archive migration failed: ${String(cause)}`, { cause })
  })
  if (typeof Bun !== "undefined") Bun.gc(true)
  const counts = new Sqlite(input.paths.candidateDatabase, { readonly: true, strict: true })
  try {
    progress.checkpointed = Number(
      counts.query<{ readonly count: number }, []>(`
        SELECT count(*) AS count FROM event_checkpoint ec
        JOIN event_sequence es ON es.aggregate_id = ec.aggregate_id
        JOIN session s ON s.id = es.aggregate_id
        WHERE ec.version = ${EventV2.CheckpointVersion} AND ec.seq = es.seq
      `).get()?.count ?? 0,
    )
    progress.archived = tableExists(counts, "session_archive_catalog")
      ? Number(counts.query<{ readonly count: number }, []>(
          "SELECT count(*) AS count FROM session_archive_catalog WHERE location='archived'",
        ).get()?.count ?? 0)
      : 0
  } finally {
    counts.close()
  }
  progress.checkpointed += await countArchivedCheckpoints(input.paths.candidateArchiveDirectory)
  await saveWorkerProgress(worker.progressPath, progress)
}

function boundedCause(cause: Cause.Cause<unknown>) {
  const value = Cause.pretty(cause)
  if (value.length <= 4_000) return value
  return `${value.slice(0, 3_500)}\n...[${value.length - 4_000} characters omitted]...\n${value.slice(-500)}`
}

function repairUnrecordedSessionProjects(db: Database.Interface["db"], events: EventV2.Interface) {
  return Effect.gen(function* () {
    const createdType = EventV2.versionedType("session.created", 1)
    const updatedType = EventV2.versionedType("session.updated", 1)
    const movedType = EventV2.versionedType(SessionEvent.Moved.type, 1)
    const assignedType = EventV2.versionedType(SessionEvent.ProjectAssigned.type, 1)
    const durable = yield* db
      .all<{ aggregate_id: string; type: string; data: unknown }>(sql`
        SELECT aggregate_id, type, data FROM event
        WHERE type IN (${createdType}, ${updatedType}, ${movedType}, ${assignedType})
        ORDER BY aggregate_id, seq
      `)
      .pipe(Effect.orDie)
    const projected = new Map<string, string>()
    durable.forEach((row) => {
      const stored = typeof row.data === "string" ? JSON.parse(row.data) : row.data
      const data = EventV2.decodeStoredEventData(stored as Record<string, unknown>)
      if (row.type === movedType || row.type === assignedType) {
        if (typeof data.projectID === "string") projected.set(row.aggregate_id, data.projectID)
        return
      }
      const info = data.info
      if (typeof info !== "object" || info === null || Array.isArray(info)) return
      const value = info as Record<string, unknown>
      if (typeof value.projectID === "string") projected.set(row.aggregate_id, value.projectID)
    })
    const sessions = yield* db
      .all<{ id: SessionSchema.ID; project_id: ProjectV2.ID; time_updated: number }>(sql`
        SELECT id, project_id, time_updated FROM session ORDER BY id
      `)
      .pipe(Effect.orDie)
    yield* Effect.forEach(
      sessions.filter((row) => projected.has(row.id) && projected.get(row.id) !== row.project_id),
      (row) =>
        events.publish(
          SessionEvent.ProjectAssigned,
          {
            sessionID: row.id,
            timestamp: DateTime.makeUnsafe(row.time_updated),
            projectID: row.project_id,
          },
          {
            id: EventV2.ID.make(
              `evt_${createHash("sha256").update(`storage-project-assigned-v1\0${row.id}\0${row.project_id}`).digest("hex")}`,
            ),
          },
        ),
      { concurrency: 1, discard: true },
    )
  })
}

function upgradeLegacyProjectedActivityFailures(db: Database.Interface["db"]) {
  return Effect.gen(function* () {
    const legacyType = EventV2.versionedType(SessionEvent.Activity.Failed.type, 1)
    const currentType = EventV2.versionedType(SessionEvent.Activity.Failed.type, 2)
    const rows = yield* db
      .all<{ id: string; aggregate_id: string; seq: number; data: unknown }>(
        sql`SELECT id, aggregate_id, seq, data FROM event WHERE type = ${legacyType} ORDER BY aggregate_id, seq`,
      )
      .pipe(Effect.orDie)
    yield* Effect.forEach(
      rows,
      (row) =>
        Effect.gen(function* () {
          const stored = typeof row.data === "string" ? JSON.parse(row.data) : row.data
          const data = EventV2.decodeStoredEventData(stored as Record<string, unknown>)
          if (typeof data.activityID !== "string" || typeof data.timestamp !== "number") return
          const projected = yield* db
            .get<{ type: string; seq: number; time_created: number; data: unknown }>(sql`
              SELECT type, seq, time_created, data FROM session_message
              WHERE session_id = ${row.aggregate_id} AND id = ${`msg_activity_failure_${data.activityID}`}
            `)
            .pipe(Effect.orDie)
          if (!projected || projected.type !== "assistant" || projected.seq !== row.seq || projected.time_created !== data.timestamp)
            return
          const message = typeof projected.data === "string" ? JSON.parse(projected.data) : projected.data
          if (
            typeof message !== "object" ||
            message === null ||
            Array.isArray(message) ||
            message.finish !== "error" ||
            !Array.isArray(message.content) ||
            message.content.length !== 0 ||
            !isDeepStrictEqual(message.error, data.error)
          )
            return
          yield* db
            .run(sql`UPDATE event SET type = ${currentType} WHERE id = ${row.id} AND type = ${legacyType}`)
            .pipe(Effect.orDie)
        }),
      { concurrency: 1, discard: true },
    )
  })
}

function repairUnprojectedCustomParts(db: Database.Interface["db"]) {
  return Effect.gen(function* () {
    const customType = EventV2.versionedType(SessionEvent.Custom.Added.type, 1)
    const contentTypes = [
      EventV2.versionedType(SessionEvent.Reasoning.Started.type, 1),
      EventV2.versionedType(SessionEvent.Text.Started.type, 1),
      EventV2.versionedType(SessionEvent.Tool.Input.Started.type, 1),
      customType,
    ]
    const rows = yield* db
      .all<{ id: string; aggregate_id: string; seq: number; data: unknown }>(sql`
        SELECT id, aggregate_id, seq, data FROM event WHERE type = ${customType} ORDER BY aggregate_id, seq
      `)
      .pipe(Effect.orDie)
    yield* Effect.forEach(
      rows,
      (row) =>
        Effect.gen(function* () {
          const stored = typeof row.data === "string" ? JSON.parse(row.data) : row.data
          const event = Schema.decodeUnknownSync(SessionEvent.Custom.Added.data)(
            EventV2.decodeStoredEventData(stored as Record<string, unknown>),
          )
          if (event.sessionID !== row.aggregate_id)
            return yield* Effect.die(new Error("checkpoint", `Custom event ${row.id} has mismatched Session ownership`))
          const projected = yield* db
            .select({
              id: SessionMessageTable.id,
              session_id: SessionMessageTable.session_id,
              type: SessionMessageTable.type,
              data: SessionMessageTable.data,
            })
            .from(SessionMessageTable)
            .where(
              and(
                eq(SessionMessageTable.session_id, SessionSchema.ID.make(row.aggregate_id)),
                eq(SessionMessageTable.id, event.assistantMessageID),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (!projected) return
          const message = Schema.decodeUnknownSync(SessionMessage.Message)({
            ...(typeof projected.data === "string" ? JSON.parse(projected.data) : projected.data),
            id: projected.id,
            type: projected.type,
          })
          if (message.type !== "assistant")
            return yield* Effect.die(
              new Error("checkpoint", `Custom event ${row.id} targets non-assistant message ${projected.id}`),
            )
          const custom = new SessionMessage.AssistantCustom({
            type: "custom",
            id: event.partID,
            kind: event.kind,
            data: event.data,
            title: event.title,
            fallback: event.fallback,
            metadata: event.metadata,
            time: event.time,
          })
          const encodedCustom = Schema.encodeSync(SessionMessage.AssistantContent)(custom)
          const existing = message.content.find((item) => item.id === event.partID)
          if (existing) {
            // Effect schemas retain optional class fields as `undefined` while stored JSON omits them.
            // Compare the actual persisted representation so a lossless historical projection is not
            // rejected only because one side was decoded through a class constructor.
            if (
              isDeepStrictEqual(
                JSON.parse(JSON.stringify(Schema.encodeSync(SessionMessage.AssistantContent)(existing))),
                JSON.parse(JSON.stringify(encodedCustom)),
              )
            )
              return
            return yield* Effect.die(
              new Error("checkpoint", `Custom event ${row.id} conflicts with projected part ${event.partID}`),
            )
          }
          const later = yield* db
            .all<{ seq: number; data: unknown }>(sql`
              SELECT seq, data FROM event
              WHERE aggregate_id = ${row.aggregate_id} AND seq > ${row.seq}
                AND type IN (${contentTypes[0]}, ${contentTypes[1]}, ${contentTypes[2]}, ${contentTypes[3]})
              ORDER BY seq
            `)
            .pipe(Effect.orDie)
          const laterOwned = later.find((candidate) => {
            const candidateStored = typeof candidate.data === "string" ? JSON.parse(candidate.data) : candidate.data
            const data = EventV2.decodeStoredEventData(candidateStored as Record<string, unknown>)
            return data.assistantMessageID === event.assistantMessageID
          })
          if (laterOwned)
            return yield* Effect.die(
              new Error(
                "checkpoint",
                `Missing custom part ${event.partID} is not the final content event for ${projected.id}`,
              ),
            )
          const encoded = Schema.encodeSync(SessionMessage.Message)(
            new SessionMessage.Assistant({ ...message, content: [...message.content, custom] }),
          )
          const { id: _, type: __, ...data } = encoded
          yield* db
            .update(SessionMessageTable)
            .set({ data })
            .where(
              and(
                eq(SessionMessageTable.session_id, projected.session_id),
                eq(SessionMessageTable.id, projected.id),
              ),
            )
            .run()
            .pipe(Effect.orDie)
        }),
      { concurrency: 1, discard: true },
    )
  })
}

async function countArchivedCheckpoints(directory: string) {
  const counts = await Promise.all(
    (await archiveFiles(directory)).map((filename) => {
      const database = new Sqlite(filename, { readonly: true, strict: true })
      try {
        return Number(
          database.query<{ readonly count: number }, []>(`
            SELECT count(*) AS count FROM archive_session_section WHERE section_name='event_checkpoint'
          `).get()?.count ?? 0,
        )
      } finally {
        database.close()
      }
    }),
  )
  return counts.reduce((total, count) => total + count, 0)
}

async function rewriteArchivePaths(input: Input, manifest: Manifest) {
  const database = new Sqlite(input.paths.candidateDatabase, { strict: true })
  try {
    if (!tableExists(database, "session_archive_shard"))
      return advance(input, manifest, "paths-rewritten")
    database.transaction(() => {
      const rows = database.query<{ readonly id: string; readonly path: string }, []>(
        "SELECT id, path FROM session_archive_shard ORDER BY id",
      ).all()
      const update = database.prepare("UPDATE session_archive_shard SET path = ? WHERE id = ?")
      for (const row of rows) {
        const relative = path.relative(input.paths.candidateArchiveDirectory, path.resolve(row.path))
        if (relative.startsWith("..") || path.isAbsolute(relative) || ![".db", ".sqlite"].includes(path.extname(relative)))
          throw new Error("integrity", `Archive shard escapes candidate directory: ${row.path}`)
        update.run(path.resolve(input.paths.liveArchiveDirectory, relative), row.id)
      }
    })()
  } finally {
    database.close()
  }
  return advance(input, manifest, "paths-rewritten")
}

const FINALIZATION_HEADROOM_BYTES = 64 * 1024 * 1024
const COMPACTION_HEADROOM_BYTES = 512 * 1024 * 1024

async function finalizeCandidate(candidate: string, archives: string, testHooks?: NonNullable<Options["testHooks"]>) {
  const compacted = `${candidate}.compacting`
  const previous = `${candidate}.precompact`
  try {
    await recoverCandidatePublication(candidate, compacted, previous)
    await requireAvailableFinalizationSpace(
      candidate,
      FINALIZATION_HEADROOM_BYTES,
      testHooks?.candidateCompactionAvailableBytes,
    )
    await closeSqliteFile(candidate)
    const database = new Sqlite(candidate, { strict: true })
    try {
      database.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; BEGIN IMMEDIATE")
      const tables = database
        .query<{ readonly name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '_content_migration_%' ORDER BY name",
        )
        .all()
      for (const table of tables) database.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(table.name)}`)
      database.exec("COMMIT")
    } catch (cause) {
      try {
        database.exec("ROLLBACK")
      } catch {}
      throw cause
    } finally {
      database.close()
    }
    await closeSqliteFile(candidate)
    const source = new Sqlite(candidate, { readonly: true, strict: true })
    try {
      assertSqlite(source, candidate)
      const pageSize = pragmaNumber(source, "page_size")
      const pageCount = pragmaNumber(source, "page_count")
      const freelistCount = pragmaNumber(source, "freelist_count")
      if (freelistCount > pageCount)
        throw new Error("integrity", "Candidate SQLite freelist exceeds its page count")
      const livePages = pageCount - freelistCount
      const compactedBytes = Math.max(pageSize, pageSize * livePages)
      await requireAvailableFinalizationSpace(
        candidate,
        compactedBytes + Math.max(COMPACTION_HEADROOM_BYTES, Math.ceil(compactedBytes * 0.1)),
        testHooks?.candidateCompactionAvailableBytes,
      )
      source.exec(`VACUUM INTO ${sqlString(compacted)}`)
    } finally {
      source.close()
    }
    const compactedDatabase = new Sqlite(compacted, { readonly: true, strict: true })
    try {
      assertSqlite(compactedDatabase, compacted)
      if (
        compactedDatabase
          .query<{ readonly count: number }, []>(
            "SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name LIKE '_content_migration_%'",
          )
          .get()?.count !== 0
      ) throw new Error("integrity", "Compacted candidate retains content migration tables")
    } finally {
      compactedDatabase.close()
    }
    await closeSqliteFile(compacted)
    await retryTransientFileOperation(() => rename(candidate, previous))
    await testHooks?.afterCandidateCompactionBackup?.()
    await retryTransientFileOperation(() => rename(compacted, candidate))
    await removeSqliteFile(previous)
    await closeSqliteFiles(candidate, archives)
  } catch (cause) {
    await recoverCandidatePublication(candidate, compacted, previous).catch((recovery) => {
      throw new Error("integrity", "Candidate finalization and recovery failed", { cause: recovery })
    })
    if (cause instanceof Error) throw cause
    throw new Error("integrity", "Candidate finalization failed", { cause })
  }
}

async function recoverCandidatePublication(candidate: string, compacted: string, previous: string) {
  if (!existsSync(candidate) && existsSync(previous)) {
    await retryTransientFileOperation(() => rename(previous, candidate))
    await removeSqliteFile(compacted)
    return
  }
  if (!existsSync(candidate))
    throw new Error("integrity", `Candidate database is missing and has no recoverable predecessor: ${candidate}`)
  if (existsSync(previous)) {
    const valid = await sqliteFileValid(candidate)
    if (!valid) {
      await removeSqliteFile(candidate)
      await retryTransientFileOperation(() => rename(previous, candidate))
      await removeSqliteFile(compacted)
      return
    }
    await removeSqliteFile(previous)
  }
  await removeSqliteFile(compacted)
}

async function sqliteFileValid(filename: string) {
  try {
    const database = new Sqlite(filename, { readonly: true, strict: true })
    try {
      assertSqlite(database, filename)
      return true
    } finally {
      database.close()
    }
  } catch {
    return false
  }
}

function pragmaNumber(database: Sqlite, name: "page_size" | "page_count" | "freelist_count") {
  const row = database.query<Record<string, number>, []>(`PRAGMA ${name}`).get()
  const value = Number(Object.values(row ?? {})[0])
  if (!Number.isInteger(value) || value < 0)
    throw new Error("integrity", `Candidate returned an invalid SQLite ${name}`)
  return value
}

async function requireAvailableFinalizationSpace(candidate: string, required: number, override?: number) {
  const filesystem = override === undefined ? await statfs(path.dirname(candidate)) : undefined
  const available = override ?? Number(filesystem!.bavail) * Number(filesystem!.bsize)
  if (available >= required) return
  throw new Error(
    "integrity",
    `Candidate finalization needs ${required} free bytes beside ${candidate}, but only ${available} are available`,
  )
}

async function removeSqliteFile(filename: string) {
  await Promise.all([filename, `${filename}-wal`, `${filename}-shm`, `${filename}-journal`].map((target) =>
    retryTransientFileOperation(() => rm(target, { force: true })),
  ))
}

async function validateCandidate(input: Input, manifest: Manifest, content: ContentManifest): Promise<Report> {
  const archives = await archiveFiles(input.paths.candidateArchiveDirectory)
  const database = new Sqlite(input.paths.candidateDatabase, { readonly: true, strict: true })
  try {
    assertSqlite(database, input.paths.candidateDatabase)
    assertActiveReplays(database)
    assertArchiveCatalog(
      database,
      archives,
      input.paths.candidateArchiveDirectory,
      input.paths.liveArchiveDirectory,
    )
  } finally {
    database.close()
  }
  for (const filename of archives) {
    const shard = new Sqlite(filename, { readonly: true, strict: true })
    try {
      assertSqlite(shard, filename)
      assertArchivedReplays(shard)
    } finally {
      shard.close()
    }
  }
  const sourceStorage = await inspectExistingStorage(input)
  const sourceBytes =
    (await stat(input.paths.sourceDatabase)).size +
    (await stat(`${input.paths.sourceDatabase}-wal`).then((info) => info.size).catch(() => 0)) +
    sourceStorage.blobBytes +
    sourceStorage.archiveBytes
  const activeDatabaseBytes = (await stat(input.paths.candidateDatabase)).size
  const archiveBytes = await directoryBytes(input.paths.candidateArchiveDirectory)
  const blobBytes = await directoryBytes(input.paths.candidateBlobDirectory)
  const candidateBytes = activeDatabaseBytes + archiveBytes + blobBytes
  const savedBytes = sourceBytes - candidateBytes
  const counts = new Sqlite(input.paths.candidateDatabase, { readonly: true, strict: true })
  try {
    return {
      sourceBytes,
      activeDatabaseBytes,
      archiveBytes,
      blobBytes,
      candidateBytes,
      savedBytes,
      savedRatio: sourceBytes === 0 ? 0 : savedBytes / sourceBytes,
      checkpointedSessions: manifest.checkpointedSessions,
      archivedSessions: tableExists(counts, "session_archive_catalog")
        ? Number(counts.query<{ readonly count: number }, []>(
            "SELECT count(*) AS count FROM session_archive_catalog WHERE location='archived'",
          ).get()?.count ?? 0)
        : 0,
      activeSessions: tableExists(counts, "session")
        ? Number(counts.query<{ readonly count: number }, []>("SELECT count(*) AS count FROM session").get()?.count ?? 0)
        : 0,
      quarantineCount: content.quarantine.length,
      content: content.report,
    }
  } finally {
    counts.close()
  }
}

async function prepareActivation(input: Input, manifest: Manifest) {
  const activation = await StorageActivation.prepare({
    databaseKind: input.databaseKind,
    sourceDatabase: input.paths.sourceDatabase,
    candidateDatabase: input.paths.candidateDatabase,
    candidateBlobDirectory: input.paths.candidateBlobDirectory,
    liveBlobDirectory: input.paths.liveBlobDirectory,
    candidateArchiveDirectory: input.paths.candidateArchiveDirectory,
    liveArchiveDirectory: input.paths.liveArchiveDirectory,
    stagingDirectory: input.paths.stagingDirectory,
    manifestPath: input.paths.activationManifestPath,
  })
  return advance(input, { ...manifest, activationManifest: activation }, "prepared")
}

async function requireQuarantineApproval(
  input: Input,
  content: ContentManifest,
  approval: QuarantineApproval | undefined,
) {
  if (content.status !== "quarantined") return undefined
  const reportSha256 = hash(content.quarantine)
  const requirement: QuarantineRequirement = {
    version: 1,
    kind: "opencode-storage-quarantine-approval",
    reportSha256,
    count: content.quarantine.length,
    report: content.quarantine,
    createdAt: Date.now(),
  }
  await writeDurable(input.paths.quarantineRequirementPath, requirement)
  if (input.mode === "dry-run") return undefined
  if (
    !approval ||
    approval.reportSha256 !== reportSha256 ||
    approval.approvedBy.trim().length === 0 ||
    approval.reason.trim().length < 8 ||
    !Number.isFinite(approval.reviewedAt) ||
    approval.reviewedAt <= 0
  ) {
    const journal = await readJournal(input.paths.journalPath)
    if (journal) await saveJournal(input.paths.journalPath, { ...journal, status: "quarantine-required" })
    throw new Error(
      "quarantine",
      `Migration found ${content.quarantine.length} unresolved items; review ${input.paths.quarantineRequirementPath} and provide a matching explicit approval`,
    )
  }
  await writeDurable(path.join(input.paths.stagingDirectory, "quarantine-approval.json"), {
    ...approval,
    requirement: input.paths.quarantineRequirementPath,
  })
  return approval
}

function assertSavings(input: Input, report: Report, options: Options) {
  if (options.minimumSavingsBytes !== undefined && report.savedBytes < options.minimumSavingsBytes)
    throw new Error(
      "savings",
      `Candidate saves ${report.savedBytes} bytes, below the required ${options.minimumSavingsBytes} bytes`,
    )
  if (!options.expectedDryRun) return
  const expected = options.expectedDryRun.savedBytes
  const deviation = expected === 0 ? Math.abs(report.savedBytes) : Math.abs(report.savedBytes - expected) / Math.abs(expected)
  const maximum = options.expectedDryRun.maxDeviationRatio ?? DEFAULT_DEVIATION
  if (deviation > maximum)
    throw new Error(
      "savings",
      `Candidate savings deviate ${(deviation * 100).toFixed(2)}% from dry-run; maximum is ${(maximum * 100).toFixed(2)}%`,
    )
}

function assertActiveReplays(database: Sqlite) {
  if (!tableExists(database, "event_sequence")) return
  const rows = database.query<{ readonly aggregate_id: string; readonly seq: number }, []>(`
    SELECT es.aggregate_id, es.seq FROM event_sequence es JOIN session s ON s.id = es.aggregate_id ORDER BY es.aggregate_id
  `).all()
  for (const row of rows) {
    const checkpoint = database
      .query<{ readonly seq: number; readonly version: number; readonly data: unknown }, [string]>(
        "SELECT seq, version, data FROM event_checkpoint WHERE aggregate_id = ?",
      )
      .get(row.aggregate_id)
    if (!checkpoint || checkpoint.version !== EventV2.CheckpointVersion || checkpoint.seq > row.seq)
      throw new Error("integrity", `Active event stream ${row.aggregate_id} has no valid checkpoint`)
    const baseline = requireCheckpointBaseline(checkpoint.data, row.aggregate_id)
    if (
      baseline.adapter !== SessionProjector.CheckpointAdapterID ||
      baseline.version !== SessionProjector.CheckpointAdapterVersion
    ) throw new Error("integrity", `Active event stream ${row.aggregate_id} has an outdated checkpoint adapter`)
    const reference = baseline.data.legacyProjectionReference
    if (reference !== undefined) {
      if (
        !isRecord(reference) ||
        reference.version !== 1 ||
        reference.checkpointSeq !== checkpoint.seq ||
        reference.checkpointSeq !== row.seq ||
        !Number.isSafeInteger(reference.legacyMessageCount) ||
        !Number.isSafeInteger(reference.legacyPartCount) ||
        !Number.isSafeInteger(reference.messageCount) ||
        typeof reference.projectionHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(reference.projectionHash) ||
        !Array.isArray(baseline.data.legacyMessages) ||
        !Array.isArray(baseline.data.legacyParts) ||
        !Array.isArray(baseline.data.messages) ||
        baseline.data.legacyMessages.length !== 0 ||
        baseline.data.legacyParts.length !== 0 ||
        baseline.data.messages.length !== 0
      ) throw new Error("integrity", `Active event stream ${row.aggregate_id} has an invalid projection reference`)
      const messages = database
        .query<Record<string, unknown>, [string]>(
          "SELECT * FROM message WHERE session_id = ? ORDER BY time_created, id",
        )
        .all(row.aggregate_id)
        .map(checkpointProjectionRow)
      const parts = database
        .query<Record<string, unknown>, [string]>(
          "SELECT * FROM part WHERE session_id = ? ORDER BY message_id, id",
        )
        .all(row.aggregate_id)
        .map(checkpointProjectionRow)
      const messagesV2 = database
        .query<Record<string, unknown>, [string]>(
          "SELECT * FROM session_message WHERE session_id = ? ORDER BY seq",
        )
        .all(row.aggregate_id)
        .map(checkpointProjectionRow)
      if (
        messages.length !== reference.legacyMessageCount ||
        parts.length !== reference.legacyPartCount ||
        messagesV2.length !== reference.messageCount ||
        checkpointProjectionHash({ legacyMessages: messages, legacyParts: parts, messages: messagesV2 }) !==
          reference.projectionHash
      ) throw new Error("integrity", `Active event stream ${row.aggregate_id} projection reference differs`)
    }
    const tail = database
      .query<{ readonly seq: number }, [string, number]>(
        "SELECT seq FROM event WHERE aggregate_id = ? AND seq > ? ORDER BY seq",
      )
      .all(row.aggregate_id, checkpoint.seq)
      .map((event) => event.seq)
    assertContiguous(row.aggregate_id, checkpoint.seq, row.seq, tail)
  }
}

function assertArchiveCatalog(
  database: Sqlite,
  archives: ReadonlyArray<string>,
  candidateArchiveDirectory: string,
  liveArchiveDirectory: string,
) {
  if (!tableExists(database, "session_archive_catalog")) return
  const targets = new Set(archives.map((filename) => path.resolve(filename)))
  const shards = new Map(
    database
      .query<{ readonly id: string; readonly path: string }, []>("SELECT id, path FROM session_archive_shard")
      .all()
      .map((row) => [row.id, row.path]),
  )
  const opened = new Map<string, Sqlite>()
  try {
    for (const row of database.query<
      {
        readonly session_id: string
        readonly revision: number
        readonly shard_id: string
        readonly content_hash: string
        readonly message_count: number
        readonly input_count: number
      },
      []
    >(
      "SELECT session_id, revision, shard_id, content_hash, message_count, input_count FROM session_archive_catalog WHERE location='archived'",
    ).all()) {
      const live = shards.get(row.shard_id)
      if (!live) throw new Error("integrity", `Archived session ${row.session_id} has no shard catalog entry`)
      const relative = path.relative(liveArchiveDirectory, path.resolve(live))
      if (relative.startsWith("..") || path.isAbsolute(relative))
        throw new Error("integrity", `Archived session ${row.session_id} points outside the live archive root`)
      const candidate = path.resolve(candidateArchiveDirectory, relative)
      if (!candidate || !targets.has(path.resolve(candidate)))
        throw new Error(
          "integrity",
          `Archived session ${row.session_id} points to an unknown live shard target: ${live} -> ${candidate}; available: ${[...targets].join(", ")}`,
        )
      const shard = opened.get(candidate) ?? new Sqlite(candidate, { readonly: true, strict: true })
      opened.set(candidate, shard)
      const stored = shard.query<
        { readonly content_hash: string; readonly message_count: number; readonly input_count: number },
        [string, number]
      >(
        "SELECT content_hash, message_count, input_count FROM archive_session WHERE session_id = ? AND revision = ?",
      ).get(row.session_id, row.revision)
      if (
        !stored ||
        stored.content_hash !== row.content_hash ||
        stored.message_count !== row.message_count ||
        stored.input_count !== row.input_count
      )
        throw new Error("integrity", `Archived session ${row.session_id} does not match its catalog signature`)
    }
  } finally {
    for (const shard of opened.values()) shard.close()
  }
}

function assertArchivedReplays(database: Sqlite) {
  if (!tableExists(database, "archive_session_section")) return
  const sessions = database
    .query<{ readonly session_id: string; readonly revision: number }, []>(
      "SELECT session_id, revision FROM archive_session ORDER BY session_id, revision",
    )
    .all()
  for (const session of sessions) {
    const sections = database
      .query<{ readonly section_name: string; readonly data_json: string; readonly row_hash: string }, [string, number]>(`
        SELECT section_name, data_json, row_hash FROM archive_session_section
        WHERE session_id = ? AND revision = ?
          AND section_name IN ('event_sequence', 'event_checkpoint', 'event', 'legacy_projection_checkpoint')
        ORDER BY section_name, ordinal
      `)
      .all(session.session_id, session.revision)
    if (sections.some((row) => createHash("sha256").update(row.data_json).digest("hex") !== row.row_hash))
      throw new Error("integrity", `Archived event stream ${session.session_id} contains a corrupt section row`)
    const sequence = sections.find((row) => row.section_name === "event_sequence")
    const checkpoint = sections.find((row) => row.section_name === "event_checkpoint")
    if (!sequence && !checkpoint) continue
    const sequenceData = parseRow(sequence?.data_json, session.session_id)
    const checkpointData = parseRow(checkpoint?.data_json, session.session_id)
    if (!sequenceData || !checkpointData || checkpointData.version !== EventV2.CheckpointVersion)
      throw new Error("integrity", `Archived event stream ${session.session_id} has no valid checkpoint`)
    const baseline = requireCheckpointBaseline(checkpointData.data, session.session_id)
    const markerRow = sections.find((row) => row.section_name === "legacy_projection_checkpoint")
    if (markerRow) {
      const marker = parseRow(markerRow.data_json, session.session_id)
      const messageRows = database.query<{ readonly data_json: string; readonly row_hash: string }, [string, number]>(`
        SELECT data_json, row_hash FROM archive_legacy_message
        WHERE session_id = ? AND revision = ? ORDER BY time_created, id
      `).all(session.session_id, session.revision)
      const partRows = database.query<{ readonly data_json: string; readonly row_hash: string }, [string, number]>(`
        SELECT data_json, row_hash FROM archive_legacy_part
        WHERE session_id = ? AND revision = ? ORDER BY message_id, id
      `).all(session.session_id, session.revision)
      if (
        [...messageRows, ...partRows].some((row) =>
          createHash("sha256").update(row.data_json).digest("hex") !== row.row_hash)
      ) throw new Error("integrity", `Archived session ${session.session_id} contains corrupt legacy rows`)
      const messages = messageRows.map((row) => parseRow(row.data_json, session.session_id))
      const parts = partRows.map((row) => parseRow(row.data_json, session.session_id))
      if (
        baseline.adapter !== SessionProjector.CheckpointAdapterID ||
        baseline.version !== SessionProjector.CheckpointAdapterVersion ||
        !Array.isArray(baseline.data.legacyMessages) ||
        !Array.isArray(baseline.data.legacyParts) ||
        baseline.data.legacyMessages.length !== 0 ||
        baseline.data.legacyParts.length !== 0 ||
        marker?.version !== 2 ||
        marker.checkpointSeq !== checkpointData.seq ||
        marker.messageCount !== messages.length ||
        marker.partCount !== parts.length ||
        marker.projectionHash !== hash({ messages, parts })
      ) throw new Error("integrity", `Archived session ${session.session_id} has an invalid legacy checkpoint marker`)
    }
    const tail = sections
      .filter((row) => row.section_name === "event")
      .map((row) => Number(parseRow(row.data_json, session.session_id)?.seq))
    assertContiguous(session.session_id, Number(checkpointData.seq), Number(sequenceData.seq), tail)
  }
}

function requireCheckpointBaseline(value: unknown, sessionID: string) {
  try {
    const data = typeof value === "string" ? JSON.parse(value) : value
    if (typeof data !== "object" || data === null || Array.isArray(data)) throw new globalThis.Error()
    return EventV2.readStoredCheckpointBaseline(data as Record<string, unknown>)
  } catch (cause) {
    throw new Error("integrity", `Event stream ${sessionID} contains an invalid checkpoint baseline`, { cause })
  }
}

function assertContiguous(aggregateID: string, checkpoint: number, sequence: number, tail: ReadonlyArray<number>) {
  if (!Number.isInteger(checkpoint) || !Number.isInteger(sequence) || checkpoint > sequence)
    throw new Error("integrity", `Event stream ${aggregateID} has invalid sequence bounds`)
  if (tail.some((seq, index) => seq !== checkpoint + index + 1) || (tail.at(-1) ?? checkpoint) !== sequence)
    throw new Error("integrity", `Event stream ${aggregateID} checkpoint tail is not contiguous`)
}

function parseRow(value: string | undefined, sessionID: string) {
  if (value === undefined) return undefined
  try {
    const parsed = JSON.parse(value)
    if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>
  } catch {}
  throw new Error("integrity", `Archived session ${sessionID} contains invalid row JSON`)
}

async function ensureDryRunSnapshot(input: Input) {
  const directory = input.paths.sourceSnapshotDirectory
  if (!directory) throw new Error("configuration", "Dry-run snapshot directory is missing")
  await mkdir(directory, { recursive: true })
  if (existsSync(input.paths.migrationSourceDatabase)) {
    const existing = new Sqlite(input.paths.migrationSourceDatabase, { readonly: true, strict: true })
    try {
      assertSqlite(existing, input.paths.migrationSourceDatabase)
    } finally {
      existing.close()
    }
    return
  }
  const source = new Sqlite(input.paths.sourceDatabase, { readonly: true, strict: true })
  try {
    source.exec("PRAGMA busy_timeout=5000")
    source.exec(`VACUUM INTO ${sqlString(input.paths.migrationSourceDatabase)}`)
  } catch (cause) {
    throw new Error("content", "Unable to create a consistent read-only dry-run snapshot", { cause })
  } finally {
    source.close()
  }
  const snapshot = new Sqlite(input.paths.migrationSourceDatabase, { readonly: true, strict: true })
  try {
    assertSqlite(snapshot, input.paths.migrationSourceDatabase)
  } finally {
    snapshot.close()
  }
}

async function closeSqliteFiles(candidate: string, archives: string) {
  for (const filename of [candidate, ...(await archiveFiles(archives))]) await closeSqliteFile(filename)
}

async function closeSqliteFile(filename: string, attempt = 0): Promise<void> {
  const database = new Sqlite(filename, { strict: true })
  let retry = false
  try {
    database.exec("PRAGMA busy_timeout=100")
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    database.exec("PRAGMA journal_mode=DELETE")
  } catch (cause) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      cause.code === "SQLITE_BUSY" &&
      attempt < 50
    ) retry = true
    else throw cause
  } finally {
    database.close()
  }
  if (!retry) {
    await Promise.all(["-wal", "-shm", "-journal"].map((suffix) => rm(`${filename}${suffix}`, { force: true })))
    return
  }
  if (typeof Bun !== "undefined") Bun.gc(true)
  globalThis.gc?.()
  await setTimeout(100)
  return closeSqliteFile(filename, attempt + 1)
}

function assertSqlite(database: Sqlite, filename: string) {
  const quick = database.query<Record<string, string>, []>("PRAGMA quick_check").all()
  if (quick.length !== 1 || Object.values(quick[0] ?? {})[0] !== "ok")
    throw new Error("integrity", `SQLite quick_check failed: ${filename}`)
  if (database.query("PRAGMA foreign_key_check").all().length > 0)
    throw new Error("integrity", `SQLite foreign_key_check failed: ${filename}`)
}

async function validateOptions(options: Options) {
  const sourceDatabase = requireAbsolute(options.sourceDatabase, "sourceDatabase")
  const stagingDirectory = requireAbsolute(options.stagingDirectory, "stagingDirectory")
  const liveBlobDirectory = requireAbsolute(options.liveBlobDirectory, "liveBlobDirectory")
  const liveArchiveDirectory = requireAbsolute(options.liveArchiveDirectory, "liveArchiveDirectory")
  if (contains(stagingDirectory, sourceDatabase) || overlaps(stagingDirectory, liveBlobDirectory) || overlaps(stagingDirectory, liveArchiveDirectory))
    throw new Error("configuration", "Source, staging, and live storage roots must be explicitly disjoint")
  if (overlaps(liveBlobDirectory, liveArchiveDirectory))
    throw new Error("configuration", "Live blob and archive roots must be disjoint")
  const inactiveMs = options.inactiveMs ?? DEFAULT_INACTIVE_MS
  const maxShardBytes = options.maxShardBytes ?? DEFAULT_SHARD_BYTES
  if (!Number.isFinite(inactiveMs) || inactiveMs < 0 || !Number.isInteger(maxShardBytes) || maxShardBytes < 1)
    throw new Error("configuration", "Archive inactivity and shard limits are invalid")
  if (options.minimumSavingsBytes !== undefined && !Number.isFinite(options.minimumSavingsBytes))
    throw new Error("configuration", "minimumSavingsBytes must be finite")
  if (
    options.expectedDryRun &&
    (!Number.isFinite(options.expectedDryRun.savedBytes) ||
      !Number.isFinite(options.expectedDryRun.maxDeviationRatio ?? DEFAULT_DEVIATION) ||
      (options.expectedDryRun.maxDeviationRatio ?? DEFAULT_DEVIATION) < 0)
  )
    throw new Error("configuration", "Dry-run savings expectation is invalid")
  const sourceSnapshotDirectory = options.dryRunSnapshotDirectory
    ? requireAbsolute(options.dryRunSnapshotDirectory, "dryRunSnapshotDirectory")
    : path.join(path.dirname(stagingDirectory), `${path.basename(stagingDirectory)}-source-snapshot`)
  if (
    options.mode === "dry-run" &&
    [sourceDatabase, stagingDirectory, liveBlobDirectory, liveArchiveDirectory].some((target) =>
      overlaps(sourceSnapshotDirectory, target),
    )
  )
    throw new Error("configuration", "Dry-run snapshot must be disjoint from source, staging, and live storage")
  await mkdir(stagingDirectory, { recursive: true })
  const paths: Paths = {
    sourceDatabase,
    migrationSourceDatabase:
      options.mode === "dry-run" ? path.join(sourceSnapshotDirectory, "source-snapshot.db") : sourceDatabase,
    ...(options.mode === "dry-run" ? { sourceSnapshotDirectory } : {}),
    stagingDirectory,
    candidateDatabase: path.join(stagingDirectory, "candidate.db"),
    candidateBlobDirectory: path.join(stagingDirectory, "content"),
    candidateArchiveDirectory: path.join(stagingDirectory, "archives"),
    liveBlobDirectory,
    liveArchiveDirectory,
    journalPath: path.join(stagingDirectory, "storage-migration-journal.json"),
    activationManifestPath: path.join(stagingDirectory, "storage-activation-manifest.json"),
    quarantineRequirementPath: path.join(stagingDirectory, "quarantine-required.json"),
  }
  return {
    mode: options.mode,
    databaseKind: options.databaseKind,
    paths,
    config: {
      inactiveMs,
      maxShardBytes,
      contentEngineVersion: CONTENT_MIGRATION_VERSION,
      ...(options.structuredThresholdBytes === undefined
        ? {}
        : { structuredThresholdBytes: options.structuredThresholdBytes }),
      ...(options.maxContentBytes === undefined ? {} : { maxContentBytes: options.maxContentBytes }),
    },
  } satisfies Input
}

async function requireFreeSpace(input: Input, availableBytesOverride?: number) {
  const sourceStorage = await inspectExistingStorage(input)
  const sourceBytes =
    (await stat(input.paths.sourceDatabase)).size +
    (await stat(`${input.paths.sourceDatabase}-wal`).then((info) => info.size).catch(() => 0))
  const headroom = 512 * 1024 * 1024
  const requirements = new Map<string, number>()
  const reserve = (target: string, bytes: number) => {
    const volume = path.parse(path.resolve(target)).root.toLowerCase()
    requirements.set(volume, Math.max(requirements.get(volume) ?? 0, bytes))
  }
  const stagingVolume = path.parse(path.resolve(input.paths.stagingDirectory)).root.toLowerCase()
  // The source snapshot is released after content-migrated becomes durable, before
  // final compaction. Reserve the greater of the two peaks instead of summing
  // mutually exclusive snapshot and compact-output allocations on one volume.
  reserve(
    input.paths.stagingDirectory,
    2 * sourceBytes + sourceStorage.blobBytes + sourceStorage.archiveBytes,
  )
  if (
    input.paths.sourceSnapshotDirectory &&
    path.parse(path.resolve(input.paths.sourceSnapshotDirectory)).root.toLowerCase() !== stagingVolume
  ) reserve(input.paths.sourceSnapshotDirectory, sourceBytes)
  for (const [volume, bytes] of requirements) {
    const filesystem = availableBytesOverride === undefined ? await statfs(volume) : undefined
    const available = availableBytesOverride ?? Number(filesystem!.bavail) * Number(filesystem!.bsize)
    const required = bytes + headroom
    if (available >= required) continue
    throw new Error(
      "configuration",
      `Storage migration needs ${required} free bytes on ${volume}, but only ${available} are available`,
    )
  }
}

async function inspectExistingStorage(input: Input) {
  const database = new Sqlite(input.paths.sourceDatabase, { readonly: true, strict: true })
  try {
    const blobs = tableExists(database, "content_blob")
      ? database
          .query<
            { readonly sha256: string; readonly size_bytes: number; readonly storage_path: string },
            []
          >("SELECT sha256, size_bytes, storage_path FROM content_blob ORDER BY sha256")
          .all()
      : []
    const blobBytes = (
      await Promise.all(
        blobs.map(async (row) => {
          const filename = liveBlobPath(input, row)
          await requireContainedFile(input.paths.liveBlobDirectory, filename, `Live blob ${row.sha256}`)
          const info = await stat(filename)
          if (info.size !== row.size_bytes)
            throw new Error("integrity", `Live blob size does not match database metadata: ${row.sha256}`)
          return info.size
        }),
      )
    ).reduce((total, bytes) => total + bytes, 0)
    const archiveRows = tableExists(database, "session_archive_shard")
      ? database.query<{ readonly path: string }, []>("SELECT path FROM session_archive_shard ORDER BY path").all()
      : []
    archiveRows.forEach((row) => {
      if (!path.isAbsolute(row.path)) throw new Error("integrity", `Archive shard path is not absolute: ${row.path}`)
    })
    const archives = [...new Set(archiveRows.map((row) => path.resolve(row.path)))]
    const archiveBytes = (
      await Promise.all(
        archives.map(async (filename) => {
          const relative = path.relative(input.paths.liveArchiveDirectory, filename)
          if (
            relative.startsWith("..") ||
            path.isAbsolute(relative) ||
            path.dirname(relative) !== "." ||
            ![".db", ".sqlite"].includes(path.extname(relative).toLowerCase())
          )
            throw new Error("integrity", `Archive shard escapes the live archive directory: ${filename}`)
          await requireContainedFile(input.paths.liveArchiveDirectory, filename, `Archive shard ${filename}`)
          return (
            (await stat(filename)).size +
            (await stat(`${filename}-wal`)
              .then((info) => info.size)
              .catch(() => 0))
          )
        }),
      )
    ).reduce((total, bytes) => total + bytes, 0)
    return { blobBytes, archiveBytes }
  } finally {
    database.close()
  }
}

type Input = {
  readonly mode: Mode
  readonly databaseKind: StorageActivation.DatabaseKind
  readonly paths: Paths
  readonly config: Config
}

function assertResume(manifest: Manifest, input: Input) {
  if (
    manifest.version !== STORAGE_MIGRATION_VERSION ||
    manifest.kind !== "opencode-storage-migration" ||
    manifest.mode !== input.mode ||
    manifest.databaseKind !== input.databaseKind ||
    JSON.stringify(manifest.paths) !== JSON.stringify(input.paths) ||
    JSON.stringify(manifest.config) !== JSON.stringify(input.config) ||
    !PHASES.includes(manifest.phase)
  )
    throw new Error("journal", "Existing migration journal does not match this immutable migration request")
}

function assertContentManifest(manifest: ContentManifest) {
  if (manifest.engineVersion !== CONTENT_MIGRATION_VERSION)
    throw new Error("journal", "Content migration manifest was produced by an incompatible content engine")
}

async function saveWorkerProgress(
  filename: string,
  progress: { readonly checkpointed: number; readonly archived: number },
) {
  await writeDurable(filename, {
    checkpointedSessions: progress.checkpointed,
    archivedSessions: progress.archived,
  } satisfies WorkerProgress)
}

async function advance(input: Input, manifest: Manifest, phase: Phase) {
  const expected = PHASES.indexOf(manifest.phase) + 1
  if (PHASES.indexOf(phase) !== expected)
    throw new Error("journal", `Migration journal expected ${PHASES[expected] ?? "no further phase"}, not ${phase}`)
  const next: Manifest = {
    ...manifest,
    status: phase === "complete" ? "complete" : "running",
    phase,
    events: [
      ...manifest.events,
      {
        phase,
        time: Date.now(),
        checkpointedSessions: manifest.checkpointedSessions,
        archivedSessions: manifest.archivedSessions,
      },
    ],
    updatedAt: Date.now(),
  }
  await saveJournal(input.paths.journalPath, next)
  return next
}

async function notify(options: Options, manifest: Manifest, message: string) {
  await options.onProgress?.({
    phase: manifest.phase,
    checkpointedSessions: manifest.checkpointedSessions,
    archivedSessions: manifest.archivedSessions,
    message,
  })
}

async function readJournal(filename: string): Promise<Manifest | undefined> {
  if (!existsSync(filename)) return undefined
  try {
    return JSON.parse(await readFile(filename, "utf8")) as Manifest
  } catch (cause) {
    throw new Error("journal", `Migration journal is invalid: ${filename}`, { cause })
  }
}

async function readContentManifest(directory: string) {
  try {
    return JSON.parse(await readFile(path.join(directory, "content-migration-manifest.json"), "utf8")) as ContentManifest
  } catch (cause) {
    throw new Error("journal", "Content migration manifest is missing or invalid", { cause })
  }
}

async function saveJournal(filename: string, manifest: Manifest) {
  await writeDurable(filename, manifest)
}

async function writeDurable(filename: string, value: unknown) {
  const temporary = `${filename}.tmp-${randomUUID()}`
  await writeFile(temporary, JSON.stringify(value, null, 2))
  await rename(temporary, filename).catch(async (original) => {
    if (!existsSync(filename)) throw new Error("journal", `Unable to publish ${filename}`)
    const current = `${filename}.replace-${randomUUID()}`
    await retryTransientFileOperation(() => rename(filename, current))
    try {
      await retryTransientFileOperation(() => rename(temporary, filename))
      await retryTransientFileOperation(() => rm(current, { force: true })).catch(() => undefined)
    } catch (cause) {
      await retryTransientFileOperation(() => rename(current, filename)).catch(() => undefined)
      throw cause
    }
    if (!existsSync(filename)) throw original
  })
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
    cause instanceof globalThis.Error &&
    "code" in cause &&
    ["EACCES", "EBUSY", "EPERM"].includes(String(cause.code))
  )
}

async function archiveFiles(directory: string) {
  if (!(await directoryExists(directory))) return []
  const entries = await readdir(directory, { withFileTypes: true })
  const databases = entries.filter(
    (entry) => entry.isFile() && [".db", ".sqlite"].includes(path.extname(entry.name).toLowerCase()),
  )
  const names = new Set(databases.map((entry) => entry.name))
  if (
    entries.some((entry) => {
      if (!entry.isFile()) return true
      if (names.has(entry.name)) return false
      return !["-wal", "-shm", "-journal"].some(
        (suffix) => entry.name.endsWith(suffix) && names.has(entry.name.slice(0, -suffix.length)),
      )
    })
  )
    throw new Error(
      "integrity",
      `Archive candidate contains an unsupported entry: ${directory} (${entries.map((entry) => entry.name).join(", ")})`,
    )
  return databases.map((entry) => path.join(directory, entry.name)).sort()
}

async function directoryBytes(directory: string) {
  if (!(await directoryExists(directory))) return 0
  let bytes = 0
  const entries = await opendir(directory)
  for await (const entry of entries) {
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      bytes += await directoryBytes(filename)
      continue
    }
    if (entry.isFile()) {
      bytes += (await stat(filename)).size
      continue
    }
    throw new Error("integrity", `Storage candidate contains a non-regular entry: ${filename}`)
  }
  return bytes
}

async function directoryExists(directory: string) {
  return stat(directory).then((info) => info.isDirectory()).catch(() => false)
}

function phaseAtLeast(current: Phase, target: Phase) {
  return PHASES.indexOf(current) >= PHASES.indexOf(target)
}

function requireAbsolute(value: string, label: string) {
  if (!path.isAbsolute(value)) throw new Error("configuration", `${label} must be an explicit absolute path`)
  return path.resolve(value)
}

function contains(parent: string, child: string) {
  const relative = path.relative(parent, child)
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)
}

function overlaps(left: string, right: string) {
  return left === right || contains(left, right) || contains(right, left)
}

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`
}

function sqlString(value: string) {
  return `'${value.replaceAll("'", "''")}'`
}

function tableExists(database: Sqlite, table: string) {
  return Boolean(database.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
}

function checkpointProjectionRow(row: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, key === "data" && typeof value === "string" ? JSON.parse(value) : value]),
  )
}

function checkpointProjectionCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(checkpointProjectionCanonical)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, checkpointProjectionCanonical(value[key])]),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function checkpointProjectionHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(checkpointProjectionCanonical(value)) ?? "undefined").digest("hex")
}

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

export async function runSessionWorker(inputPath: string) {
  if (!inputPath) throw new globalThis.Error("Storage migration worker requires an input manifest")
  await migrateSessionsInProcess(JSON.parse(await readFile(inputPath, "utf8")) as WorkerInput)
}

if (import.meta.main && process.argv[2] === "session-worker") {
  runSessionWorker(process.argv[3] ?? "").catch((cause) => {
    process.stderr.write(cause instanceof globalThis.Error ? cause.stack ?? cause.message : String(cause))
    process.exitCode = 1
  })
}
