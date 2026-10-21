import { Database } from "#maintenance-sqlite"
import { createHash } from "node:crypto"
import { createReadStream, existsSync } from "node:fs"
import { mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { setTimeout } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import path from "path"
import {
  boundedContentPreview,
  boundedPersistedContentPreview,
  MAX_CONTENT_PREVIEW_BYTES,
  MAX_PERSISTED_CONTENT_PREVIEW_BYTES,
} from "./content-preview"
import { decodeStoredEventData, encodeStoredEventData } from "./event"

export const CONTENT_MIGRATION_VERSION = 9
const DEFAULT_BATCH_SIZE = 100
const DEFAULT_BATCH_BYTES = 16 * 1024 * 1024
const DEFAULT_STRUCTURED_BYTES = 256 * 1024
const DEFAULT_MAX_CONTENT_BYTES = 256 * 1024 * 1024
const STAGING_BUSY_TIMEOUT_MS = 5_000
const FINALIZE_ATTEMPTS = 10
const URL_TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/
const DATA_MEDIA_TYPE = /^(?:[A-Za-z0-9!#$%&'*+.^_`|~-]+)\/(?:[A-Za-z0-9!#$%&'*+.^_`|~-]+)$/

export type Mode = "dry-run" | "stage"

export type Options = {
  readonly mode: Mode
  readonly sourceDatabase: string
  readonly stagingDirectory: string
  readonly batchSize?: number
  readonly maxBatchBytes?: number
  readonly maxRows?: number
  readonly structuredThresholdBytes?: number
  readonly maxContentBytes?: number
  readonly onProgress?: (progress: Progress) => void | Promise<void>
  readonly testHooks?: {
    readonly afterBlobPublish?: () => void | Promise<void>
    readonly afterDatabaseCommit?: () => void | Promise<void>
  }
}

export type SessionOptions = {
  readonly stagingDirectory: string
  readonly sessionIDs: ReadonlyArray<string>
  readonly structuredThresholdBytes?: number
  readonly maxContentBytes?: number
}

export type Progress = {
  readonly state: "checkpointed" | "finalizing" | "waiting-for-readers"
  readonly table?: string
  readonly rowsScanned: number
  readonly checkpointTransactions: number
  readonly batchRows: number
  readonly batchBytes: number
}

export type Quarantine = {
  readonly table: string
  readonly rowid: number
  readonly path: string
  readonly kind: "data" | "file" | "structured" | "row"
  readonly reason: string
  readonly originalBytes: number
  readonly originalSha256: string
  readonly preview: string
}

export type Report = {
  readonly rowsScanned: number
  readonly rowsChanged: number
  readonly references: number
  readonly dataUrls: number
  readonly fileUrls: number
  readonly structuredOutputs: number
  readonly legacyMutationBlobs: number
  readonly legacyMutationBytes: number
  readonly quarantined: number
  readonly uniqueBlobs: number
  readonly duplicateReferences: number
  readonly sourceReferenceBytes: number
  readonly embeddedSourceBytes: number
  readonly embeddedReferenceBytes: number
  readonly uniqueBlobBytes: number
  readonly referenceBytes: number
  readonly estimatedDatabaseBytesSaved: number
  readonly estimatedNetBytesSaved: number
  readonly checkpointTransactions: number
  readonly peakBatchBytes: number
  /** The batch target may be exceeded only by one indivisible row. */
  readonly maxBatchBytes: number
  readonly largestRowBytes: number
  readonly oversizedRows: number
  readonly validationRows: number
  readonly validationWindowRows: number
  /** Streaming validation retains one row; this is that largest row's byte size. */
  readonly validationPeakRowBytes: number
  readonly sessionResolutionQueries: number
}

export type Manifest = {
  readonly version: 1
  readonly engineVersion: typeof CONTENT_MIGRATION_VERSION
  readonly mode: Mode
  readonly status: "incomplete" | "quarantined" | "complete"
  readonly sourceDatabase: string
  readonly stagingDatabase: string
  readonly blobDirectory: string
  readonly source: SourceFingerprint
  readonly report: Report
  readonly quarantine: ReadonlyArray<Quarantine>
  readonly completedTables: ReadonlyArray<string>
  readonly createdAt: number
  readonly updatedAt: number
}

export type SourceFingerprint = {
  readonly size: number
  readonly modified: number
  readonly walSize: number
  readonly walModified: number
  readonly pageCount: number
  readonly schemaVersion: number
}

type Target = {
  readonly table: "session_input" | "session_message" | "part" | "event" | "event_checkpoint"
  readonly column: "prompt" | "data"
  readonly query: string
}

type Row = {
  readonly rowid: number
  readonly value: string
  readonly sessionID: string | null
  readonly messageID: string | null
  readonly aggregateID: string | null
}

type LegacyBlobRow = {
  readonly rowid: number
  readonly sha256: string
  readonly bytes: number
  readonly content: Uint8Array
}

type SessionResolver = ReturnType<typeof createSessionResolver>

type Occurrence = {
  readonly key: string
  readonly table: string
  readonly rowid: number
  readonly path: string
  readonly sourceJSONPath: string
  readonly previewJSONPath?: string
  readonly kind: "data" | "file" | "structured"
  readonly attachmentID: string
  readonly sessionID: string
  readonly messageID?: string
  readonly sha256: string
  readonly mime: string
  readonly filename?: string
  readonly sourcePath?: string
  readonly storagePath: string
  readonly sourceBytes: number
  readonly storedBytes: number
  readonly referenceBytes: number
}

type RowResult = {
  readonly value: string
  readonly changed: boolean
  readonly occurrences: ReadonlyArray<Occurrence>
  readonly quarantine: ReadonlyArray<Quarantine>
}

type TransformContext = {
  readonly options: Required<Pick<Options, "structuredThresholdBytes" | "maxContentBytes">>
  readonly blobDirectory: string
  readonly table: string
  readonly rowid: number
  readonly sessionID?: string
  readonly messageID?: string
  readonly occurrences: Occurrence[]
  readonly quarantine: Quarantine[]
}

const targets: ReadonlyArray<Target> = [
  {
    table: "session_input",
    column: "prompt",
    query:
      "SELECT rowid, prompt AS value, session_id AS sessionID, id AS messageID, NULL AS aggregateID FROM session_input WHERE rowid > ? ORDER BY rowid LIMIT ?",
  },
  {
    table: "session_message",
    column: "data",
    query:
      "SELECT rowid, data AS value, session_id AS sessionID, id AS messageID, NULL AS aggregateID FROM session_message WHERE rowid > ? ORDER BY rowid LIMIT ?",
  },
  {
    table: "part",
    column: "data",
    query:
      "SELECT rowid, data AS value, session_id AS sessionID, message_id AS messageID, NULL AS aggregateID FROM part WHERE rowid > ? ORDER BY rowid LIMIT ?",
  },
  {
    table: "event",
    column: "data",
    query:
      "SELECT rowid, data AS value, NULL AS sessionID, NULL AS messageID, aggregate_id AS aggregateID FROM event WHERE rowid > ? ORDER BY rowid LIMIT ?",
  },
  {
    table: "event_checkpoint",
    column: "data",
    query:
      "SELECT rowid, data AS value, NULL AS sessionID, NULL AS messageID, aggregate_id AS aggregateID FROM event_checkpoint WHERE rowid > ? ORDER BY rowid LIMIT ?",
  },
]

/**
 * Builds only an inventory database (dry-run) or an isolated candidate database
 * (stage). It never renames, replaces, or writes to sourceDatabase.
 */
export async function migrateLegacyContent(options: Options): Promise<Manifest> {
  const input = validateOptions(options)
  if (input.mode === "stage") await assertOfflineSource(input.sourceDatabase)
  if (!existsSync(input.sourceDatabase))
    throw new Error(`Source database does not exist: ${input.sourceDatabase}`)
  const source = await fingerprint(input.sourceDatabase)
  const stagingDatabase = path.join(input.stagingDirectory, input.mode === "stage" ? "candidate.db" : "inventory.db")
  const blobDirectory = path.join(input.stagingDirectory, "content")
  const manifestPath = path.join(input.stagingDirectory, "content-migration-manifest.json")
  await mkdir(input.stagingDirectory, { recursive: true })
  const sourcePath = await realpath(input.sourceDatabase)
  const stagingPath = await realpath(input.stagingDirectory)
  if (contains(stagingPath, sourcePath) || path.dirname(sourcePath) === stagingPath)
    throw new Error("Resolved staging directory must not contain the source database")
  await prepareStaging({ ...input, source, stagingDatabase })

  const database = new Database(input.mode === "stage" ? stagingDatabase : input.sourceDatabase, {
    readonly: input.mode === "dry-run",
    strict: true,
  })
  const journal = input.mode === "stage" ? database : new Database(stagingDatabase, { strict: true })
  configureStagingDatabase(journal)
  const sourceDataVersion = input.mode === "dry-run" ? dataVersion(database) : undefined
  const createdAt = Number(readMetadata(journal, "created_at"))
  const resolver = createSessionResolver(database)
  let rowsScanned = migrationRowCount(journal)
  let checkpointTransactions = Number(readMetadata(journal, "row_checkpoint_transactions") ?? 0)
  let processed = 0
  try {
    assertIntegrity(database, input.mode === "stage" ? stagingDatabase : input.sourceDatabase)
    database.exec("PRAGMA query_only = " + (input.mode === "dry-run" ? "ON" : "OFF"))
    for (const target of targets) {
      if (readMetadata(journal, `complete:${target.table}`) === "true") continue
      if (!tableExists(database, target.table)) {
        writeMetadata(journal, `complete:${target.table}`, "true")
        continue
      }
      while (processed < input.maxRows) {
        const last = lastRow(journal, target.table)
        const results = []
        let batchBytes = 0
        let largestRowBytes = 0
        let oversizedRows = 0
        const select = database.query<Row, [number, number]>(target.query)
        try {
          for (const row of select.iterate(last, Math.min(input.batchSize, input.maxRows - processed))) {
            const originalBytes = Buffer.byteLength(row.value, "utf8")
            if (results.length > 0 && batchBytes + originalBytes > input.maxBatchBytes) break
            const result = await transformRow(row, target, resolver, {
              options: input,
              blobDirectory,
              table: target.table,
              rowid: row.rowid,
              sessionID: row.sessionID ?? resolver.resolve(row.aggregateID ?? undefined),
              messageID: row.messageID ?? undefined,
              occurrences: [],
              quarantine: [],
            })
            if (result.occurrences.length > 0) await input.testHooks?.afterBlobPublish?.()
            const workingBytes =
              originalBytes + (result.value === row.value ? 0 : Buffer.byteLength(result.value, "utf8"))
            if (results.length > 0 && batchBytes + workingBytes > input.maxBatchBytes) break
            batchBytes += workingBytes
            largestRowBytes = Math.max(largestRowBytes, workingBytes)
            if (workingBytes > input.maxBatchBytes) oversizedRows += 1
            results.push({ row, result })
            if (batchBytes >= input.maxBatchBytes) break
          }
        } finally {
          select.finalize()
        }
        if (results.length === 0) {
          writeMetadata(journal, `complete:${target.table}`, "true")
          break
        }
        // Blob writes are content-addressed and idempotent; the SQLite checkpoint advances atomically per batch.
        persistRows({
          database,
          journal,
          mode: input.mode,
          target,
          rows: results,
          batchBytes,
          largestRowBytes,
          oversizedRows,
        })
        await input.testHooks?.afterDatabaseCommit?.()
        processed += results.length
        rowsScanned += results.length
        checkpointTransactions += 1
        await input.onProgress?.({
          state: "checkpointed",
          table: target.table,
          rowsScanned,
          checkpointTransactions,
          batchRows: results.length,
          batchBytes,
        })
      }
      if (processed >= input.maxRows) break
    }
    if (processed < input.maxRows)
      await migrateLegacyMutationBlobs({
        database,
        journal,
        mode: input.mode,
        blobDirectory,
        batchSize: input.batchSize,
        maxBatchBytes: input.maxBatchBytes,
        maxRows: input.maxRows - processed,
        maxContentBytes: input.maxContentBytes,
        testHooks: input.testHooks,
        onCheckpoint: async (batchRows, batchBytes) => {
          processed += batchRows
          rowsScanned += batchRows
          checkpointTransactions += 1
          await input.onProgress?.({
            state: "checkpointed",
            table: "session_file_blob",
            rowsScanned,
            checkpointTransactions,
            batchRows,
            batchBytes,
          })
        },
      })
    writeMetadata(
      journal,
      "session_resolution_queries",
      String(Number(readMetadata(journal, "session_resolution_queries") ?? 0) + resolver.queryCount()),
    )
    const scanned =
      targets.every((target) => readMetadata(journal, `complete:${target.table}`) === "true") &&
      readMetadata(journal, "complete:session_file_blob") === "true"
    if (scanned) await validateBlobs(journal, blobDirectory, input.mode)
    const handoffReady = scanned
      ? await validateAndFinalize({
          database,
          journal,
          mode: input.mode,
          stagingDatabase,
          onProgress: input.onProgress,
        })
      : false
    const currentSource = await fingerprint(input.sourceDatabase)
    if (!sameFingerprint(source, currentSource))
      throw new Error("Source database changed during content migration; discard this staging candidate")
    if (sourceDataVersion !== undefined && sourceDataVersion !== dataVersion(database))
      throw new Error("Source database committed new data during content migration; discard this dry-run inventory")
    const manifest = createManifest({
      mode: input.mode,
      status: handoffReady ? "complete" : "incomplete",
      sourceDatabase: input.sourceDatabase,
      stagingDatabase,
      blobDirectory,
      source,
      journal,
      createdAt,
      maxBatchBytes: input.maxBatchBytes,
    })
    await writeManifest(manifestPath, manifest)
    return manifest
  } finally {
    if (journal !== database) journal.close()
    database.close()
  }
}

export async function assertContentMigrationSource(manifest: Manifest) {
  if (!sameFingerprint(manifest.source, await fingerprint(manifest.sourceDatabase)))
    throw new Error("Source database changed after the content migration candidate was created")
}

/**
 * Reuses the normal content transformer for sessions restored from archive
 * shards into an existing staging candidate. The candidate and its content
 * journal are updated in one SQLite transaction per row, so rerunning after a
 * crash skips committed rows and safely continues with the remainder.
 */
export async function migrateLegacySessionContent(options: SessionOptions): Promise<Manifest> {
  const stagingDirectory = path.resolve(options.stagingDirectory)
  if (!path.isAbsolute(options.stagingDirectory)) throw new Error("stagingDirectory must be an explicit absolute path")
  const manifestPath = path.join(stagingDirectory, "content-migration-manifest.json")
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest
  const stagingDatabase = path.join(stagingDirectory, "candidate.db")
  const blobDirectory = path.join(stagingDirectory, "content")
  if (
    manifest.engineVersion !== CONTENT_MIGRATION_VERSION ||
    manifest.mode !== "stage" ||
    manifest.status === "incomplete" ||
    path.resolve(manifest.stagingDatabase) !== stagingDatabase ||
    path.resolve(manifest.blobDirectory) !== blobDirectory
  ) throw new Error("Existing content migration candidate is not ready for archived session content")
  const structuredThresholdBytes = options.structuredThresholdBytes ?? DEFAULT_STRUCTURED_BYTES
  const maxContentBytes = options.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES
  if (!(structuredThresholdBytes > 0) || !(maxContentBytes >= structuredThresholdBytes))
    throw new Error("Content thresholds are invalid")
  const database = new Database(stagingDatabase, { strict: true })
  configureStagingDatabase(database)
  const resolver = createSessionResolver(database)
  try {
    for (const target of targets) {
      if (!tableExists(database, target.table)) continue
      const select = database.query<Row, [string]>(sessionTargetQuery(target))
      try {
        for (const sessionID of [...new Set(options.sessionIDs)].sort()) {
          for (const row of select.iterate(sessionID)) {
            if (
              database.query<{ readonly found: number }, [string, number]>(
                "SELECT 1 AS found FROM _content_migration_row WHERE table_name = ? AND rowid = ?",
              ).get(target.table, row.rowid)
            ) continue
            const result = await transformRow(row, target, resolver, {
              options: { structuredThresholdBytes, maxContentBytes },
              blobDirectory,
              table: target.table,
              rowid: row.rowid,
              sessionID,
              ...(row.messageID === null ? {} : { messageID: row.messageID }),
              occurrences: [],
              quarantine: [],
            })
            const bytes = Buffer.byteLength(row.value, "utf8")
            persistRows({
              database,
              journal: database,
              mode: "stage",
              target,
              rows: [{ row, result }],
              batchBytes: bytes,
              largestRowBytes: bytes,
              oversizedRows: bytes > manifest.report.maxBatchBytes ? 1 : 0,
            })
          }
        }
      } finally {
        select.finalize()
      }
    }
    writeMetadata(
      database,
      "session_resolution_queries",
      String(Number(readMetadata(database, "session_resolution_queries") ?? 0) + resolver.queryCount()),
    )
    await validateBlobs(database, blobDirectory, "stage")
    const validation = assertMigratedLinks(database)
    writeMetadata(database, "validation_rows", String(validation.rows))
    writeMetadata(database, "validation_window_rows", String(validation.windowRows))
    writeMetadata(database, "validation_peak_row_bytes", String(validation.peakRowBytes))
    assertIntegrity(database, stagingDatabase)
    const updated = createManifest({
      mode: "stage",
      status: "complete",
      sourceDatabase: manifest.sourceDatabase,
      stagingDatabase,
      blobDirectory,
      source: manifest.source,
      journal: database,
      createdAt: manifest.createdAt,
      maxBatchBytes: manifest.report.maxBatchBytes,
    })
    await writeManifest(manifestPath, updated)
    return updated
  } finally {
    database.close()
  }
}

function sessionTargetQuery(target: Target) {
  if (target.table === "session_input")
    return "SELECT rowid, prompt AS value, session_id AS sessionID, id AS messageID, NULL AS aggregateID FROM session_input WHERE session_id = ? ORDER BY rowid"
  if (target.table === "session_message")
    return "SELECT rowid, data AS value, session_id AS sessionID, id AS messageID, NULL AS aggregateID FROM session_message WHERE session_id = ? ORDER BY rowid"
  if (target.table === "part")
    return "SELECT rowid, data AS value, session_id AS sessionID, message_id AS messageID, NULL AS aggregateID FROM part WHERE session_id = ? ORDER BY rowid"
  return `SELECT rowid, data AS value, NULL AS sessionID, NULL AS messageID, aggregate_id AS aggregateID FROM ${target.table} WHERE aggregate_id = ? ORDER BY rowid`
}

function validateOptions(options: Options) {
  const sourceDatabase = path.resolve(options.sourceDatabase)
  const stagingDirectory = path.resolve(options.stagingDirectory)
  if (!path.isAbsolute(options.sourceDatabase) || !path.isAbsolute(options.stagingDirectory))
    throw new Error("sourceDatabase and stagingDirectory must be explicit absolute paths")
  if (sourceDatabase === stagingDirectory || path.dirname(sourceDatabase) === stagingDirectory)
    throw new Error("Staging directory must not contain or replace the source database")
  if (
    path.dirname(sourceDatabase) === stagingDirectory ||
    path.dirname(sourceDatabase) === path.dirname(stagingDirectory)
  )
    throw new Error("Use a dedicated staging directory outside the production database directory")
  if (contains(stagingDirectory, sourceDatabase))
    throw new Error("Source database must not be inside the staging directory")
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  const maxBatchBytes = options.maxBatchBytes ?? DEFAULT_BATCH_BYTES
  const maxRows = options.maxRows ?? Number.POSITIVE_INFINITY
  const structuredThresholdBytes = options.structuredThresholdBytes ?? DEFAULT_STRUCTURED_BYTES
  const maxContentBytes = options.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1_000)
    throw new Error("batchSize must be an integer between 1 and 1000")
  if (!Number.isSafeInteger(maxBatchBytes) || maxBatchBytes < 1)
    throw new Error("maxBatchBytes must be a positive safe integer")
  if (!(maxRows > 0) || (!Number.isInteger(maxRows) && maxRows !== Number.POSITIVE_INFINITY))
    throw new Error("maxRows must be a positive integer when provided")
  if (!(structuredThresholdBytes > 0) || !(maxContentBytes >= structuredThresholdBytes))
    throw new Error("Content thresholds are invalid")
  return {
    ...options,
    sourceDatabase,
    stagingDirectory,
    batchSize,
    maxBatchBytes,
    maxRows,
    structuredThresholdBytes,
    maxContentBytes,
  }
}

async function prepareStaging(
  input: ReturnType<typeof validateOptions> & {
    readonly source: SourceFingerprint
    readonly stagingDatabase: string
  },
) {
  const exists = existsSync(input.stagingDatabase)
  if (!exists && input.mode === "stage") {
    const source = new Database(input.sourceDatabase, { readonly: true, strict: true })
    try {
      source.exec(`VACUUM INTO ${sqlString(input.stagingDatabase)}`)
    } finally {
      source.close()
    }
  }
  if (!exists && input.mode === "dry-run") new Database(input.stagingDatabase, { create: true }).close()
  const database = new Database(input.stagingDatabase, { strict: true })
  try {
    configureStagingDatabase(database)
    const initialized = tableExists(database, "_content_migration_meta")
    if (exists && !initialized)
      throw new Error(`Existing staging database has no content migration journal: ${input.stagingDatabase}`)
    initializeJournal(database)
    if (input.mode === "stage") initializeContentSchema(database)
    if (!initialized) {
      writeMetadata(database, "version", String(CONTENT_MIGRATION_VERSION))
      writeMetadata(database, "mode", input.mode)
      writeMetadata(database, "source", input.sourceDatabase)
      writeMetadata(database, "source_fingerprint", JSON.stringify(input.source))
      writeMetadata(database, "created_at", String(Date.now()))
      return
    }
    if (
      readMetadata(database, "version") !== String(CONTENT_MIGRATION_VERSION) ||
      readMetadata(database, "mode") !== input.mode ||
      readMetadata(database, "source") !== input.sourceDatabase ||
      readMetadata(database, "source_fingerprint") !== JSON.stringify(input.source)
    )
      throw new Error("Staging journal does not match the requested source and migration mode")
  } finally {
    database.close()
  }
}

function initializeJournal(database: Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS _content_migration_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS _content_migration_row (
      table_name TEXT NOT NULL,
      rowid INTEGER NOT NULL,
      changed INTEGER NOT NULL,
      original_bytes INTEGER NOT NULL,
      candidate_bytes INTEGER NOT NULL,
      PRIMARY KEY (table_name, rowid)
    );
    CREATE TABLE IF NOT EXISTS _content_migration_occurrence (
      key TEXT PRIMARY KEY,
      table_name TEXT NOT NULL,
      rowid INTEGER NOT NULL,
      source_json_path TEXT NOT NULL,
      json_path TEXT NOT NULL,
      preview_json_path TEXT,
      kind TEXT NOT NULL,
      attachment_id TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      mime TEXT NOT NULL,
      source_bytes INTEGER NOT NULL,
      stored_bytes INTEGER NOT NULL,
      reference_bytes INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS _content_migration_occurrence_blob_idx
      ON _content_migration_occurrence(sha256);
    CREATE TABLE IF NOT EXISTS _content_migration_quarantine (
      key TEXT PRIMARY KEY,
      table_name TEXT NOT NULL,
      rowid INTEGER NOT NULL,
      json_path TEXT NOT NULL,
      kind TEXT NOT NULL,
      reason TEXT NOT NULL,
      original_bytes INTEGER NOT NULL,
      original_sha256 TEXT NOT NULL,
      preview TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS _content_migration_legacy_blob (
      rowid INTEGER PRIMARY KEY,
      sha256 TEXT NOT NULL,
      stored_bytes INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS content_blob (
      sha256 TEXT PRIMARY KEY,
      size_bytes INTEGER NOT NULL,
      mime TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `)
}

async function migrateLegacyMutationBlobs(input: {
  readonly database: Database
  readonly journal: Database
  readonly mode: Mode
  readonly blobDirectory: string
  readonly batchSize: number
  readonly maxBatchBytes: number
  readonly maxRows: number
  readonly maxContentBytes: number
  readonly testHooks?: Options["testHooks"]
  readonly onCheckpoint: (rows: number, bytes: number) => Promise<void>
}) {
  if (readMetadata(input.journal, "complete:session_file_blob") === "true") return 0
  if (!tableExists(input.database, "session_file_blob")) {
    writeMetadata(input.journal, "complete:session_file_blob", "true")
    return 0
  }
  let processed = 0
  while (processed < input.maxRows) {
    const last =
      input.journal
        .query<
          { readonly rowid: number },
          []
        >("SELECT coalesce(max(rowid), 0) AS rowid FROM _content_migration_legacy_blob")
        .get()?.rowid ?? 0
    const prepared: Array<{
      readonly row: LegacyBlobRow
      readonly bytes: Uint8Array
      readonly actual: string
      readonly problem: string | undefined
      readonly storagePath: string
    }> = []
    let batchBytes = 0
    let largestRowBytes = 0
    let oversizedRows = 0
    const select = input.database.query<LegacyBlobRow, [number, number]>(
      "SELECT rowid, sha256, bytes, content FROM session_file_blob WHERE rowid > ? ORDER BY rowid LIMIT ?",
    )
    try {
      for (const row of select.iterate(last, Math.min(input.batchSize, input.maxRows - processed))) {
        if (prepared.length > 0 && batchBytes + row.content.byteLength > input.maxBatchBytes) break
        const bytes = row.content
        const actual = createHash("sha256").update(bytes).digest("hex")
        const problem =
          bytes.byteLength > input.maxContentBytes
            ? `File mutation blob exceeds ${input.maxContentBytes} bytes`
            : row.bytes !== bytes.byteLength
              ? `File mutation blob size ${row.bytes} does not match ${bytes.byteLength}`
              : row.sha256 !== actual
                ? `File mutation blob hash ${row.sha256} does not match ${actual}`
                : undefined
        if (!problem) {
          await publishBlob(path.join(input.blobDirectory, actual.slice(0, 2), actual), actual, bytes)
          await input.testHooks?.afterBlobPublish?.()
        }
        prepared.push({ row, bytes, actual, problem, storagePath: `content/${actual.slice(0, 2)}/${actual}` })
        batchBytes += bytes.byteLength
        largestRowBytes = Math.max(largestRowBytes, bytes.byteLength)
        if (bytes.byteLength > input.maxBatchBytes) oversizedRows += 1
        if (batchBytes >= input.maxBatchBytes) break
      }
    } finally {
      select.finalize()
    }
    if (prepared.length === 0) {
      writeMetadata(input.journal, "complete:session_file_blob", "true")
      break
    }
    const createdAt = Date.now()
    const persist = input.journal.transaction(() => {
      prepared.forEach((entry) => {
        if (entry.problem) {
          persistLegacyBlobQuarantine(input.journal, entry.row.rowid, entry.problem, entry.bytes)
          input.journal.run("INSERT OR IGNORE INTO _content_migration_legacy_blob VALUES (?, ?, ?)", [
            entry.row.rowid,
            entry.row.sha256,
            entry.row.bytes,
          ])
          return
        }
        input.journal.run(
          "INSERT OR IGNORE INTO content_blob (sha256, size_bytes, mime, storage_path, created_at) VALUES (?, ?, 'application/octet-stream', ?, ?)",
          [entry.actual, entry.bytes.byteLength, entry.storagePath, createdAt],
        )
        input.journal.run("INSERT OR IGNORE INTO _content_migration_legacy_blob VALUES (?, ?, ?)", [
          entry.row.rowid,
          entry.actual,
          entry.bytes.byteLength,
        ])
        if (input.mode === "stage")
          input.database.run("DELETE FROM session_file_blob WHERE rowid = ?", [entry.row.rowid])
      })
      recordCheckpoint(input.journal, batchBytes, largestRowBytes, oversizedRows)
    })
    persist()
    await input.testHooks?.afterDatabaseCommit?.()
    processed += prepared.length
    await input.onCheckpoint(prepared.length, batchBytes)
  }
  return processed
}

function persistLegacyBlobQuarantine(journal: Database, rowid: number, reason: string, original: Uint8Array) {
  const previewBytes = original.subarray(0, Math.min(original.byteLength, Math.floor(MAX_CONTENT_PREVIEW_BYTES / 2)))
  journal.run("INSERT OR IGNORE INTO _content_migration_quarantine VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [
    createHash("sha256").update(`session_file_blob\0${rowid}`).digest("hex"),
    "session_file_blob",
    rowid,
    "$.content",
    "row",
    reason,
    original.byteLength,
    createHash("sha256").update(original).digest("hex"),
    `${Buffer.from(previewBytes).toString("base64")}${previewBytes.byteLength < original.byteLength ? "... truncated ..." : ""}`,
  ])
}

function initializeContentSchema(database: Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS attachment (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      message_id TEXT,
      mime TEXT NOT NULL,
      filename TEXT,
      size_bytes INTEGER,
      source_path TEXT,
      storage_path TEXT NOT NULL,
      blob_sha256 TEXT,
      created_at INTEGER NOT NULL
    );
  `)
  const required = [
    ["message_id", "TEXT"],
    ["filename", "TEXT"],
    ["size_bytes", "INTEGER"],
    ["source_path", "TEXT"],
    ["storage_path", "TEXT"],
    ["blob_sha256", "TEXT"],
    ["created_at", "INTEGER"],
  ] as const
  const columns = new Set(
    database
      .query<{ readonly name: string }, []>("PRAGMA table_info(attachment)")
      .all()
      .map((row) => row.name),
  )
  const missingRequired = ["id", "session_id", "mime"].filter((column) => !columns.has(column))
  if (missingRequired.length > 0)
    throw new Error(`Legacy attachment table is missing required columns: ${missingRequired.join(", ")}`)
  required
    .filter((column) => !columns.has(column[0]))
    .forEach((column) => database.exec(`ALTER TABLE attachment ADD COLUMN ${column[0]} ${column[1]}`))
  database.exec(`
    CREATE INDEX IF NOT EXISTS attachment_session_idx ON attachment(session_id);
    CREATE INDEX IF NOT EXISTS attachment_message_idx ON attachment(message_id);
    CREATE INDEX IF NOT EXISTS attachment_blob_idx ON attachment(blob_sha256);
  `)
}

async function transformRow(
  row: Row,
  target: Target,
  resolver: SessionResolver,
  context: TransformContext,
): Promise<RowResult> {
  try {
    const encoded = JSON.parse(row.value)
    const decoded =
      target.table === "event" || target.table === "event_checkpoint"
        ? decodeStoredEventData(requireObject(encoded))
        : encoded
    const session = context.sessionID ?? findSessionID(decoded, resolver)
    const transformed = await transform(
      decoded,
      { ...context, sessionID: session, messageID: context.messageID ?? findMessageID(decoded) },
      "$",
      undefined,
    )
    const changed = context.occurrences.length > 0
    const value = !changed
      ? row.value
      : JSON.stringify(
          target.table === "event" || target.table === "event_checkpoint"
            ? encodeStoredEventData(requireObject(transformed))
            : transformed,
        )
    return { value, changed, occurrences: context.occurrences, quarantine: context.quarantine }
  } catch (error) {
    const quarantine = rowQuarantine(target.table, row.rowid, error, row.value)
    return { value: row.value, changed: false, occurrences: [], quarantine: [...context.quarantine, quarantine] }
  }
}

async function transform(
  value: unknown,
  context: TransformContext,
  jsonPath: string,
  parent: Record<string, unknown> | undefined,
): Promise<unknown> {
  if (typeof value === "string") {
    const kind = referenceKind(value)
    if (!kind) return value
    return ingestReference(value, kind, context, jsonPath, parent)
  }
  if (Array.isArray(value)) {
    const output = [...value]
    for (let index = 0; index < output.length; index++)
      output[index] = await transform(output[index], context, pointer(jsonPath, String(index)), undefined)
    return output
  }
  if (!isObject(value)) return value
  if (isContentReference(value)) return value
  const messageID = findMessageID(value)
  const scoped = messageID ? { ...context, messageID } : context
  const output = await externalizeToolOutput({ ...value }, scoped, jsonPath)
  for (const [key, child] of Object.entries(output)) {
    const childPath = pointer(jsonPath, key)
    if (key === "structured" && child !== undefined) {
      const encoded = safeStringify(child)
      if (encoded && Buffer.byteLength(encoded, "utf8") > context.options.structuredThresholdBytes) {
        output[key] = await ingestStructured(encoded, scoped, childPath)
        continue
      }
    }
    output[key] = await transform(child, scoped, childPath, output)
  }
  return output
}

async function ingestReference(
  original: string,
  kind: "data" | "file",
  context: TransformContext,
  jsonPath: string,
  parent: Record<string, unknown> | undefined,
) {
  if (!context.sessionID) {
    context.quarantine.push(quarantine(context, jsonPath, kind, "Unable to resolve owning session", original))
    return original
  }
  try {
    const content =
      kind === "data"
        ? decodeDataURL(original, string(parent?.mime) ?? "application/octet-stream", context.options.maxContentBytes)
        : await readFileURL(original, string(parent?.mime), context.options.maxContentBytes)
    const replacement = await recordContent({
      context,
      jsonPath,
      kind,
      bytes: content.bytes,
      mime: content.mime,
      filename:
        string(parent?.name) ?? string(parent?.filename) ?? ("filename" in content ? content.filename : undefined),
      sourcePath: "sourcePath" in content ? content.sourcePath : undefined,
      sourceBytes: Buffer.byteLength(original, "utf8"),
      replacement: (attachmentID) => `attachment://${attachmentID}`,
    })
    return replacement
  } catch (error) {
    context.quarantine.push(quarantine(context, jsonPath, kind, message(error), original))
    return original
  }
}

async function ingestStructured(encoded: string, context: TransformContext, jsonPath: string) {
  if (!context.sessionID) {
    context.quarantine.push(quarantine(context, jsonPath, "structured", "Unable to resolve owning session", encoded))
    return JSON.parse(encoded)
  }
  try {
    const bytes = Buffer.from(encoded, "utf8")
    if (bytes.byteLength > context.options.maxContentBytes)
      throw new Error(`Structured output exceeds ${context.options.maxContentBytes} bytes`)
    return await recordContent({
      context,
      jsonPath,
      kind: "structured",
      bytes,
      mime: "application/json",
      filename: "migrated-structured-output.json",
      sourceBytes: bytes.byteLength,
      previewJSONPath: pointer(pointer(jsonPath, "$opencode"), "preview"),
      replacement: (attachmentID) => ({
        $opencode: {
          type: "content-reference",
          uri: `attachment://${attachmentID}`,
          mime: "application/json",
          sizeBytes: bytes.byteLength,
          preview: boundedPersistedContentPreview(encoded),
        },
      }),
    })
  } catch (error) {
    context.quarantine.push(quarantine(context, jsonPath, "structured", message(error), encoded))
    return JSON.parse(encoded)
  }
}

async function externalizeToolOutput(value: Record<string, unknown>, context: TransformContext, jsonPath: string) {
  if (value.type === "tool" && isObject(value.state)) {
    const statePath = pointer(jsonPath, "state")
    const state = await externalizeLegacyToolOutput({ ...value.state }, context, statePath)
    return {
      ...value,
      state: await externalizeV2ToolContent(state, context, statePath),
    }
  }
  if (typeof value.callID !== "string" || !Array.isArray(value.content) || !isObject(value.structured)) return value
  return externalizeV2ToolContent(value, context, jsonPath)
}

async function externalizeLegacyToolOutput(
  state: Record<string, unknown>,
  context: TransformContext,
  jsonPath: string,
) {
  if (context.table !== "part") return state
  const originalMetadata = isObject(state.metadata) ? { ...state.metadata } : {}
  const output = typeof state.output === "string" ? state.output : undefined
  const outputBytes = Buffer.from(output ?? "", "utf8")
  const preview = boundedPersistedContentPreview(output ?? "")
  const duplicateMetadataOutput =
    output !== undefined &&
    outputBytes.byteLength > MAX_PERSISTED_CONTENT_PREVIEW_BYTES &&
    originalMetadata.output === output
  const sourceMetadata = duplicateMetadataOutput ? { ...originalMetadata, output: preview } : originalMetadata
  const encodedMetadata = safeStringify(sourceMetadata)
  const migrateMetadata =
    encodedMetadata !== undefined && Buffer.byteLength(encodedMetadata, "utf8") > context.options.structuredThresholdBytes
  const metadata = migrateMetadata
    ? ((await ingestStructured(encodedMetadata, context, pointer(jsonPath, "metadata"))) as Record<string, unknown>)
    : sourceMetadata
  if (output === undefined) return migrateMetadata ? { ...state, metadata } : state
  if (outputBytes.byteLength <= MAX_CONTENT_PREVIEW_BYTES && !duplicateMetadataOutput)
    return migrateMetadata ? { ...state, metadata } : state
  const opencode = isObject(metadata.$opencode) ? { ...metadata.$opencode } : {}
  const referencePath = pointer(pointer(pointer(jsonPath, "metadata"), "$opencode"), "output")
  const reference = await recordContent({
    context,
    jsonPath: referencePath,
    sourceJSONPath: pointer(jsonPath, "output"),
    previewJSONPath: pointer(jsonPath, "output"),
    kind: "structured",
    bytes: outputBytes,
    mime: "text/plain",
    // Use the same identity as the V2 text projection so legacy and event rows for one output share an
    // attachment reference as well as the underlying blob.
    filename: "migrated-tool-output.txt",
    sourceBytes: outputBytes.byteLength,
    additionalSourceBytes: duplicateMetadataOutput ? outputBytes.byteLength : 0,
    additionalReferenceBytes:
      Buffer.byteLength(JSON.stringify(preview), "utf8") * (duplicateMetadataOutput && !migrateMetadata ? 2 : 1),
    replacement: (attachmentID) => contentReference(attachmentID, "text/plain", outputBytes.byteLength),
  })
  return {
    ...state,
    output: preview,
    metadata: { ...metadata, $opencode: { ...opencode, output: reference } },
  }
}

async function externalizeV2ToolContent(state: Record<string, unknown>, context: TransformContext, jsonPath: string) {
  const content = Array.isArray(state.content) ? state.content : []
  const text = content.filter(
    (item): item is Record<string, unknown> & { readonly text: string } =>
      isObject(item) && item.type === "text" && typeof item.text === "string",
  )
  const encoded = text.map((item) => item.text).join("")
  const bytes = Buffer.from(encoded, "utf8")
  const result = isObject(state.result) ? state.result : undefined
  const resultText =
    result && (result.type === "text" || result.type === "error") && typeof result.value === "string"
      ? result.value
      : undefined
  const resultBytes = Buffer.from(resultText ?? "", "utf8")
  const originalStructured = isObject(state.structured) ? { ...state.structured } : {}
  const duplicateStructuredOutput =
    text.length > 0 &&
    bytes.byteLength > MAX_PERSISTED_CONTENT_PREVIEW_BYTES &&
    originalStructured.output === encoded
  const duplicateTextResult =
    text.length > 0 &&
    resultText === encoded &&
    bytes.byteLength > MAX_PERSISTED_CONTENT_PREVIEW_BYTES
  const migrateContent =
    text.length > 0 &&
    (bytes.byteLength > MAX_CONTENT_PREVIEW_BYTES || duplicateTextResult || duplicateStructuredOutput)
  const migrateResult =
    result !== undefined &&
    resultText !== undefined &&
    (resultBytes.byteLength > MAX_CONTENT_PREVIEW_BYTES || duplicateTextResult)
  if (!migrateContent && !migrateResult) return state
  const sourceStructured = duplicateStructuredOutput
    ? { ...originalStructured, output: boundedPersistedContentPreview(encoded) }
    : originalStructured
  const structuredEncoded = safeStringify(sourceStructured)
  const structured =
    structuredEncoded && Buffer.byteLength(structuredEncoded, "utf8") > context.options.structuredThresholdBytes
      ? ((await ingestStructured(structuredEncoded, context, pointer(jsonPath, "structured"))) as Record<
          string,
          unknown
        >)
      : sourceStructured
  const opencode = isObject(structured.$opencode) ? { ...structured.$opencode } : {}
  const first = content.findIndex((item) => isObject(item) && item.type === "text" && typeof item.text === "string")
  const preview = boundedPersistedContentPreview(encoded)
  const reference = migrateContent
    ? await recordContent({
        context,
        jsonPath: pointer(pointer(pointer(jsonPath, "structured"), "$opencode"), "text"),
        sourceJSONPath: pointer(jsonPath, "content"),
        previewJSONPath: pointer(pointer(pointer(jsonPath, "content"), String(first)), "text"),
        kind: "structured",
        bytes,
        mime: "text/plain",
        filename: "migrated-tool-output.txt",
        sourceBytes: bytes.byteLength,
        additionalSourceBytes: duplicateStructuredOutput ? bytes.byteLength : 0,
        additionalReferenceBytes:
          Buffer.byteLength(JSON.stringify(preview), "utf8") *
          (duplicateStructuredOutput && structured === sourceStructured ? 2 : 1),
        replacement: (attachmentID) => contentReference(attachmentID, "text/plain", bytes.byteLength),
      })
    : undefined
  const resultPreview = boundedPersistedContentPreview(resultText ?? "")
  const resultReference = migrateResult
    ? await recordContent({
        context,
        jsonPath: pointer(pointer(pointer(jsonPath, "structured"), "$opencode"), "result"),
        sourceJSONPath: pointer(pointer(jsonPath, "result"), "value"),
        previewJSONPath: undefined,
        kind: "structured",
        bytes: resultBytes,
        mime: "text/plain",
        filename: duplicateTextResult ? "migrated-tool-output.txt" : "migrated-tool-result.txt",
        sourceBytes: resultBytes.byteLength,
        additionalReferenceBytes: Buffer.byteLength(
          JSON.stringify({
            $opencode: {
              text: contentReference(`att_${"0".repeat(32)}`, "text/plain", resultBytes.byteLength),
            },
          }),
          "utf8",
        ),
        replacement: (attachmentID) => contentReference(attachmentID, "text/plain", resultBytes.byteLength),
      })
    : undefined
  return {
    ...state,
    ...(migrateContent
      ? {
          content: content.flatMap((item, index) => {
            if (!isObject(item) || item.type !== "text" || typeof item.text !== "string") return [item]
            if (index !== first) return []
            return [{ ...item, text: preview }]
          }),
        }
      : {}),
    ...(migrateResult
      ? {
          result: {
            ...result,
            value: resultReference ? { $opencode: { text: resultReference } } : resultPreview,
          },
        }
      : {}),
    structured: {
      ...structured,
      $opencode: {
        ...opencode,
        ...(reference === undefined ? {} : { text: reference }),
        ...(resultReference === undefined ? {} : { result: resultReference }),
      },
    },
  }
}

function contentReference(attachmentID: string, mime: string, sizeBytes: number) {
  return { type: "content-reference", uri: `attachment://${attachmentID}`, mime, sizeBytes }
}

async function recordContent(input: {
  readonly context: TransformContext
  readonly jsonPath: string
  readonly sourceJSONPath?: string
  readonly previewJSONPath?: string
  readonly kind: Occurrence["kind"]
  readonly bytes: Uint8Array
  readonly mime: string
  readonly filename?: string
  readonly sourcePath?: string
  readonly sourceBytes: number
  readonly additionalSourceBytes?: number
  readonly additionalReferenceBytes?: number
  readonly replacement: (attachmentID: string) => unknown
}) {
  const sha256 = createHash("sha256").update(input.bytes).digest("hex")
  const occurrenceKey = createHash("sha256")
    .update(`${input.context.table}\0${input.context.rowid}\0${input.jsonPath}\0${input.kind}`)
    .digest("hex")
  const attachmentKey = input.context.messageID
    ? createHash("sha256")
        .update(
          `${input.context.sessionID}\0${input.context.messageID}\0${sha256}\0${input.kind}\0${input.filename ?? ""}\0${input.sourcePath ?? ""}`,
        )
        .digest("hex")
    : occurrenceKey
  const attachmentID = `att_${attachmentKey.slice(0, 32)}`
  const replacement = input.replacement(attachmentID)
  const storagePath = `content/${sha256.slice(0, 2)}/${sha256}`
  await publishBlob(path.join(input.context.blobDirectory, sha256.slice(0, 2), sha256), sha256, input.bytes)
  input.context.occurrences.push({
    key: occurrenceKey,
    table: input.context.table,
    rowid: input.context.rowid,
    path: input.jsonPath,
    sourceJSONPath: input.sourceJSONPath ?? input.jsonPath,
    previewJSONPath: input.previewJSONPath,
    kind: input.kind,
    attachmentID,
    sessionID: input.context.sessionID!,
    messageID: input.context.messageID,
    sha256,
    mime: input.mime,
    filename: input.filename,
    sourcePath: input.sourcePath,
    storagePath,
    sourceBytes: input.sourceBytes + (input.additionalSourceBytes ?? 0),
    storedBytes: input.bytes.byteLength,
    referenceBytes: Buffer.byteLength(JSON.stringify(replacement), "utf8") + (input.additionalReferenceBytes ?? 0),
  })
  return replacement
}

function persistRows(input: {
  readonly database: Database
  readonly journal: Database
  readonly mode: Mode
  readonly target: Target
  readonly rows: ReadonlyArray<{ readonly row: Row; readonly result: RowResult }>
  readonly batchBytes: number
  readonly largestRowBytes: number
  readonly oversizedRows: number
}) {
  const createdAt = Date.now()
  const persist = input.journal.transaction(() => {
    input.rows.forEach((entry) => {
      if (input.mode === "stage" && entry.result.changed)
        input.database.run(`UPDATE ${input.target.table} SET ${input.target.column} = ? WHERE rowid = ?`, [
          entry.result.value,
          entry.row.rowid,
        ])
      entry.result.occurrences.forEach((occurrence) => {
        input.journal.run(
          "INSERT OR IGNORE INTO content_blob (sha256, size_bytes, mime, storage_path, created_at) VALUES (?, ?, ?, ?, ?)",
          [occurrence.sha256, occurrence.storedBytes, occurrence.mime, occurrence.storagePath, createdAt],
        )
        if (input.mode === "stage")
          input.database.run(
            "INSERT OR IGNORE INTO attachment (id, session_id, message_id, mime, filename, size_bytes, source_path, storage_path, blob_sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
              occurrence.attachmentID,
              occurrence.sessionID,
              occurrence.messageID ?? null,
              occurrence.mime,
              occurrence.filename ?? null,
              occurrence.storedBytes,
              occurrence.sourcePath ?? null,
              occurrence.storagePath,
              occurrence.sha256,
              createdAt,
            ],
          )
        input.journal.run(
          "INSERT OR IGNORE INTO _content_migration_occurrence VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            occurrence.key,
            occurrence.table,
            occurrence.rowid,
            occurrence.sourceJSONPath,
            occurrence.path,
            occurrence.previewJSONPath ?? null,
            occurrence.kind,
            occurrence.attachmentID,
            occurrence.sha256,
            occurrence.mime,
            occurrence.sourceBytes,
            occurrence.storedBytes,
            occurrence.referenceBytes,
          ],
        )
      })
      entry.result.quarantine.forEach((quarantine) =>
        input.journal.run("INSERT OR IGNORE INTO _content_migration_quarantine VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [
          createHash("sha256")
            .update(`${quarantine.table}\0${quarantine.rowid}\0${quarantine.path}\0${quarantine.kind}`)
            .digest("hex"),
          quarantine.table,
          quarantine.rowid,
          quarantine.path,
          quarantine.kind,
          quarantine.reason,
          quarantine.originalBytes,
          quarantine.originalSha256,
          quarantine.preview,
        ]),
      )
      input.journal.run("INSERT OR IGNORE INTO _content_migration_row VALUES (?, ?, ?, ?, ?)", [
        input.target.table,
        entry.row.rowid,
        entry.result.changed ? 1 : 0,
        Buffer.byteLength(entry.row.value, "utf8"),
        Buffer.byteLength(entry.result.value, "utf8"),
      ])
    })
    recordCheckpoint(input.journal, input.batchBytes, input.largestRowBytes, input.oversizedRows)
  })
  persist()
}

function createManifest(input: {
  readonly mode: Mode
  readonly status: Manifest["status"]
  readonly sourceDatabase: string
  readonly stagingDatabase: string
  readonly blobDirectory: string
  readonly source: SourceFingerprint
  readonly journal: Database
  readonly createdAt: number
  readonly maxBatchBytes: number
}): Manifest {
  const counts = input.journal
    .query<
      {
        readonly references: number
        readonly dataUrls: number
        readonly fileUrls: number
        readonly structuredOutputs: number
        readonly sourceReferenceBytes: number
        readonly embeddedSourceBytes: number
        readonly embeddedReferenceBytes: number
        readonly referenceBytes: number
      },
      []
    >(
      `
    SELECT
      count(*) AS "references",
      coalesce(sum(kind = 'data'), 0) AS dataUrls,
      coalesce(sum(kind = 'file'), 0) AS fileUrls,
      coalesce(sum(kind = 'structured'), 0) AS structuredOutputs,
      coalesce(sum(source_bytes), 0) AS sourceReferenceBytes,
      coalesce(sum(CASE WHEN kind IN ('data', 'structured') THEN source_bytes ELSE 0 END), 0) AS embeddedSourceBytes,
      coalesce(sum(CASE WHEN kind IN ('data', 'structured') THEN reference_bytes ELSE 0 END), 0) AS embeddedReferenceBytes,
      coalesce(sum(reference_bytes), 0) AS referenceBytes
    FROM _content_migration_occurrence
  `,
    )
    .get()!
  const rows = input.journal
    .query<
      { readonly rowsScanned: number; readonly rowsChanged: number },
      []
    >("SELECT count(*) AS rowsScanned, coalesce(sum(changed), 0) AS rowsChanged FROM _content_migration_row")
    .get()!
  const legacy = input.journal
    .query<
      { readonly legacyMutationBlobs: number; readonly legacyMutationBytes: number },
      []
    >("SELECT count(*) AS legacyMutationBlobs, coalesce(sum(stored_bytes), 0) AS legacyMutationBytes FROM _content_migration_legacy_blob")
    .get()!
  const blobs = input.journal
    .query<{ readonly uniqueBlobs: number; readonly uniqueBlobBytes: number }, []>(
      `
    SELECT count(*) AS uniqueBlobs, coalesce(sum(size_bytes), 0) AS uniqueBlobBytes
    FROM content_blob
    WHERE sha256 IN (
      SELECT DISTINCT sha256 FROM _content_migration_occurrence
      UNION
      SELECT DISTINCT sha256 FROM _content_migration_legacy_blob
    )
  `,
    )
    .get()!
  const quarantine = input.journal
    .query<
      {
        readonly table_name: string
        readonly rowid: number
        readonly json_path: string
        readonly kind: Quarantine["kind"]
        readonly reason: string
        readonly original_bytes: number
        readonly original_sha256: string
        readonly preview: string
      },
      []
    >(
      "SELECT table_name, rowid, json_path, kind, reason, original_bytes, original_sha256, preview FROM _content_migration_quarantine ORDER BY table_name, rowid, json_path",
    )
    .all()
  const estimatedDatabaseBytesSaved = Math.max(
    0,
    counts.embeddedSourceBytes - counts.embeddedReferenceBytes + legacy.legacyMutationBytes,
  )
  return {
    version: 1,
    engineVersion: CONTENT_MIGRATION_VERSION,
    mode: input.mode,
    status: input.status === "complete" && quarantine.length > 0 ? "quarantined" : input.status,
    sourceDatabase: input.sourceDatabase,
    stagingDatabase: input.stagingDatabase,
    blobDirectory: input.blobDirectory,
    source: input.source,
    report: {
      ...rows,
      ...counts,
      ...legacy,
      quarantined: quarantine.length,
      ...blobs,
      duplicateReferences: Math.max(0, counts.references + legacy.legacyMutationBlobs - blobs.uniqueBlobs),
      estimatedDatabaseBytesSaved,
      estimatedNetBytesSaved: estimatedDatabaseBytesSaved - blobs.uniqueBlobBytes,
      checkpointTransactions: Number(readMetadata(input.journal, "row_checkpoint_transactions") ?? 0),
      peakBatchBytes: Number(readMetadata(input.journal, "peak_batch_bytes") ?? 0),
      maxBatchBytes: input.maxBatchBytes,
      largestRowBytes: Number(readMetadata(input.journal, "largest_row_bytes") ?? 0),
      oversizedRows: Number(readMetadata(input.journal, "oversized_rows") ?? 0),
      validationRows: Number(readMetadata(input.journal, "validation_rows") ?? 0),
      validationWindowRows: Number(readMetadata(input.journal, "validation_window_rows") ?? 0),
      validationPeakRowBytes: Number(readMetadata(input.journal, "validation_peak_row_bytes") ?? 0),
      sessionResolutionQueries: Number(readMetadata(input.journal, "session_resolution_queries") ?? 0),
    },
    quarantine: quarantine.map((entry) => ({
      table: entry.table_name,
      rowid: entry.rowid,
      path: entry.json_path,
      kind: entry.kind,
      reason: entry.reason,
      originalBytes: entry.original_bytes,
      originalSha256: entry.original_sha256,
      preview: entry.preview,
    })),
    completedTables: [...targets.map((target) => target.table), "session_file_blob"].filter(
      (table) => readMetadata(input.journal, `complete:${table}`) === "true",
    ),
    createdAt: input.createdAt,
    updatedAt: Date.now(),
  }
}

async function validateAndFinalize(input: {
  readonly database: Database
  readonly journal: Database
  readonly mode: Mode
  readonly stagingDatabase: string
  readonly onProgress?: (progress: Progress) => void | Promise<void>
}) {
  if (input.mode === "stage") {
    const validation = assertMigratedLinks(input.database)
    writeMetadata(input.journal, "validation_rows", String(validation.rows))
    writeMetadata(input.journal, "validation_window_rows", String(validation.windowRows))
    writeMetadata(input.journal, "validation_peak_row_bytes", String(validation.peakRowBytes))
    assertIntegrity(input.database, input.stagingDatabase)
  }
  const progress = {
    rowsScanned: migrationRowCount(input.journal),
    checkpointTransactions: Number(readMetadata(input.journal, "row_checkpoint_transactions") ?? 0),
    batchRows: 0,
    batchBytes: 0,
  }
  await input.onProgress?.({ state: "finalizing", ...progress })
  if (!(await checkpointForHandoff(input.journal))) {
    await input.onProgress?.({ state: "waiting-for-readers", ...progress })
    return false
  }
  // Physical compaction belongs to the storage migration publication gate. It
  // uses VACUUM INTO plus a validated, recoverable file swap after archived
  // sessions have been rewritten. An in-place VACUUM here duplicates that work
  // and can require the candidate, its rebuilt copy, and a rollback journal at
  // the same time.
  return true
}

async function checkpointForHandoff(database: Database) {
  database.exec("PRAGMA busy_timeout = 100")
  for (let attempt = 0; attempt < FINALIZE_ATTEMPTS; attempt++) {
    try {
      const checkpoint = database
        .query<
          { readonly busy: number; readonly log: number; readonly checkpointed: number },
          []
        >("PRAGMA wal_checkpoint(TRUNCATE)")
        .get()
      if (checkpoint?.busy === 0 && checkpoint.log === checkpoint.checkpointed) {
        const mode = database.query<{ readonly journal_mode: string }, []>("PRAGMA journal_mode = DELETE").get()
        if (mode?.journal_mode === "delete") return true
      }
    } catch (error) {
      if (!isSQLiteBusy(error)) throw error
    }
    await setTimeout(100)
  }
  return false
}

async function validateBlobs(database: Database, blobDirectory: string, mode: Mode) {
  const blobs = database
    .query<{ readonly sha256: string; readonly stored_bytes: number }, []>(
      `
      SELECT sha256, max(stored_bytes) AS stored_bytes
      FROM (
        SELECT sha256, stored_bytes FROM _content_migration_occurrence
        UNION ALL
        SELECT sha256, stored_bytes FROM _content_migration_legacy_blob
      )
      GROUP BY sha256
      ORDER BY sha256
    `,
    )
    .iterate()
  for (const blob of blobs) {
    const filename = path.join(blobDirectory, blob.sha256.slice(0, 2), blob.sha256)
    const info = await stat(filename)
    if (info.size !== blob.stored_bytes || (await hashFile(filename)) !== blob.sha256)
      throw new Error(`Staged blob failed integrity validation: ${filename}`)
  }
  if (mode === "dry-run") return
  const missing = database
    .query<{ readonly count: number }, []>(
      `
    SELECT count(*) AS count
    FROM _content_migration_occurrence occurrence
    LEFT JOIN attachment ON attachment.id = occurrence.attachment_id
    LEFT JOIN content_blob ON content_blob.sha256 = occurrence.sha256
    WHERE attachment.id IS NULL OR content_blob.sha256 IS NULL
  `,
    )
    .get()
  if (missing?.count) throw new Error(`${missing.count} staged attachment references have missing metadata`)
}

function assertMigratedLinks(database: Database) {
  const mismatched = database
    .query<{ readonly count: number }, []>(
      `
    SELECT count(*) AS count
    FROM _content_migration_occurrence occurrence
    JOIN attachment ON attachment.id = occurrence.attachment_id
    WHERE attachment.blob_sha256 <> occurrence.sha256
      OR attachment.size_bytes <> occurrence.stored_bytes
      OR attachment.mime <> occurrence.mime
  `,
    )
    .get()
  if (mismatched?.count) throw new Error(`${mismatched.count} staged attachment links failed metadata validation`)
  assertMigratedOccurrences(database)
  const validation = assertNoUnexpectedDataURLs(database)
  if (!tableExists(database, "session_file_mutation")) return validation
  const missingMutationBlobs = database
    .query<{ readonly count: number }, []>(
      `
      SELECT count(*) AS count
      FROM (
        SELECT before_sha256 AS sha256 FROM session_file_mutation WHERE before_sha256 IS NOT NULL
        UNION
        SELECT after_sha256 AS sha256 FROM session_file_mutation WHERE after_sha256 IS NOT NULL
      ) reference
      LEFT JOIN content_blob ON content_blob.sha256 = reference.sha256
      LEFT JOIN session_file_blob ON session_file_blob.sha256 = reference.sha256
      WHERE content_blob.sha256 IS NULL AND session_file_blob.sha256 IS NULL
    `,
    )
    .get()
  if (missingMutationBlobs?.count)
    throw new Error(`${missingMutationBlobs.count} file mutation blobs are missing from staged storage`)
  return validation
}

function assertMigratedOccurrences(database: Database) {
  const occurrences = database
    .query<
      {
        readonly table_name: string
        readonly rowid: number
        readonly json_path: string
        readonly preview_json_path: string | null
        readonly attachment_id: string
      },
      []
    >(
      "SELECT table_name, rowid, json_path, preview_json_path, attachment_id FROM _content_migration_occurrence ORDER BY table_name, rowid, json_path",
    )
    .all()
  for (const occurrence of occurrences) {
    const target = targets.find((item) => item.table === occurrence.table_name)
    if (!target) throw new Error(`Unknown migrated content table ${occurrence.table_name}`)
    const row = database
      .query<
        { readonly value: string },
        [number]
      >(`SELECT ${target.column} AS value FROM ${target.table} WHERE rowid = ?`)
      .get(occurrence.rowid)
    if (!row) throw new Error(`Migrated occurrence row is missing: ${target.table}:${occurrence.rowid}`)
    const decoded = decodeTargetValue(target, row.value)
    const reference = valueAtPointer(decoded, occurrence.json_path)
    if (!isExpectedReference(reference, occurrence.attachment_id))
      throw new Error(
        `Migrated occurrence has no expected attachment reference at ${target.table}:${occurrence.rowid}:${occurrence.json_path}`,
      )
    const resultSuffix = "/structured/$opencode/result"
    if (occurrence.json_path.endsWith(resultSuffix)) {
      const runtimeReference = valueAtPointer(
        decoded,
        `${occurrence.json_path.slice(0, -resultSuffix.length)}/result/value/$opencode/text`,
      )
      if (!isExpectedReference(runtimeReference, occurrence.attachment_id))
        throw new Error(
          `Migrated result has no runtime attachment pointer at ${target.table}:${occurrence.rowid}:${occurrence.json_path}`,
        )
    }
    if (!occurrence.preview_json_path) continue
    const preview = valueAtPointer(decoded, occurrence.preview_json_path)
    if (typeof preview !== "string")
      throw new Error(
        `Migrated occurrence has no text preview at ${target.table}:${occurrence.rowid}:${occurrence.preview_json_path}`,
      )
    if (Buffer.byteLength(preview, "utf8") > MAX_CONTENT_PREVIEW_BYTES)
      throw new Error(
        `Migrated occurrence preview exceeds ${MAX_CONTENT_PREVIEW_BYTES} bytes at ${target.table}:${occurrence.rowid}:${occurrence.preview_json_path}`,
      )
  }
}

function assertNoUnexpectedDataURLs(database: Database) {
  const quarantined = new Set(
    database
      .query<{ readonly table_name: string; readonly rowid: number; readonly json_path: string }, []>(
        "SELECT table_name, rowid, json_path FROM _content_migration_quarantine WHERE kind IN ('data', 'row')",
      )
      .all()
      .map((entry) => `${entry.table_name}\0${entry.rowid}\0${entry.json_path}`),
  )
  let rowsValidated = 0
  let peakRowBytes = 0
  for (const target of targets) {
    if (!tableExists(database, target.table)) continue
    const rows = database
      .query<
        { readonly rowid: number; readonly value: string },
        []
      >(`SELECT rowid, ${target.column} AS value FROM ${target.table} ORDER BY rowid`)
      .iterate()
    for (const row of rows) {
      rowsValidated += 1
      peakRowBytes = Math.max(peakRowBytes, Buffer.byteLength(row.value, "utf8"))
      let decoded: unknown
      try {
        decoded = decodeTargetValue(target, row.value)
      } catch (error) {
        if (quarantined.has(`${target.table}\0${row.rowid}\0$`)) continue
        throw new Error(`Unable to validate migrated row ${target.table}:${row.rowid}`, { cause: error })
      }
      for (const jsonPath of findDataURLs(decoded, "$")) {
        if (quarantined.has(`${target.table}\0${row.rowid}\0${jsonPath}`)) continue
        if (quarantined.has(`${target.table}\0${row.rowid}\0$`)) continue
        throw new Error(`Unquarantined data URL remains at ${target.table}:${row.rowid}:${jsonPath}`)
      }
    }
  }
  return { rows: rowsValidated, windowRows: rowsValidated > 0 ? 1 : 0, peakRowBytes }
}

function decodeTargetValue(target: Target, value: string) {
  const encoded = JSON.parse(value)
  if (target.table !== "event" && target.table !== "event_checkpoint") return encoded
  return decodeStoredEventData(requireObject(encoded))
}

function valueAtPointer(value: unknown, jsonPath: string) {
  if (jsonPath === "$") return value
  if (!jsonPath.startsWith("$/")) return undefined
  return jsonPath
    .slice(2)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce<unknown>((current, segment) => {
      if (Array.isArray(current)) {
        const index = Number(segment)
        return Number.isInteger(index) ? current[index] : undefined
      }
      return isObject(current) ? current[segment] : undefined
    }, value)
}

function isExpectedReference(value: unknown, attachmentID: string) {
  const uri = `attachment://${attachmentID}`
  if (value === uri) return true
  if (!isObject(value)) return false
  if (value.type === "content-reference" && value.uri === uri) return true
  return isObject(value.$opencode) && value.$opencode.type === "content-reference" && value.$opencode.uri === uri
}

function findDataURLs(value: unknown, jsonPath: string): string[] {
  if (typeof value === "string") return referenceKind(value) === "data" ? [jsonPath] : []
  if (Array.isArray(value)) return value.flatMap((item, index) => findDataURLs(item, pointer(jsonPath, String(index))))
  if (!isObject(value)) return []
  return Object.entries(value).flatMap(([key, child]) => findDataURLs(child, pointer(jsonPath, key)))
}

async function publishBlob(filename: string, sha256: string, bytes: Uint8Array) {
  if (existsSync(filename)) {
    if ((await stat(filename)).size === bytes.byteLength && (await hashFile(filename)) === sha256) return
    throw new Error(`Existing staged blob does not match its content address: ${filename}`)
  }
  await mkdir(path.dirname(filename), { recursive: true })
  const temporary = `${filename}.tmp-${crypto.randomUUID()}`
  const handle = await open(temporary, "wx")
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, filename)
  } catch (error) {
    await rm(temporary, { force: true })
    if (existsSync(filename)) {
      if ((await stat(filename)).size === bytes.byteLength && (await hashFile(filename)) === sha256) return
    }
    throw error
  }
}

async function hashFile(filename: string) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(filename)) hash.update(chunk)
  return hash.digest("hex")
}

function decodeDataURL(uri: string, fallbackMime: string, maxContentBytes: number) {
  const comma = uri.indexOf(",")
  if (comma < 5) throw new Error("Invalid data URL")
  const header = uri.slice(5, comma)
  const encoded = uri.slice(comma + 1)
  const metadata = header.split(";")
  const declaredMime = metadata.shift() ?? ""
  if (declaredMime && !DATA_MEDIA_TYPE.test(declaredMime)) throw new Error("Invalid data URL media type")
  const mime = declaredMime || fallbackMime
  const base64Index = metadata.findIndex((part) => part.toLowerCase() === "base64")
  if (base64Index >= 0 && base64Index !== metadata.length - 1) throw new Error("Invalid data URL metadata")
  metadata.forEach((part, index) => {
    if (index === base64Index) return
    const separator = part.indexOf("=")
    if (separator < 1 || separator === part.length - 1 || !URL_TOKEN.test(part.slice(0, separator)))
      throw new Error("Invalid data URL metadata")
    decodeURIComponent(part.slice(separator + 1))
  })
  if (base64Index < 0) {
    const bytes = Buffer.from(decodeURIComponent(encoded), "utf8")
    if (bytes.byteLength > maxContentBytes) throw new Error(`Attachment exceeds ${maxContentBytes} bytes`)
    return { bytes, mime }
  }
  const normalized = encoded.replaceAll(/\s/g, "").replace(/=+$/, "")
  if (!/^[A-Za-z0-9+/]*$/.test(normalized) || normalized.length % 4 === 1) throw new Error("Invalid base64 data URL")
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4)
  const estimated = Math.floor((padded.length * 3) / 4) - (padded.endsWith("==") ? 2 : padded.endsWith("=") ? 1 : 0)
  if (estimated > maxContentBytes) throw new Error(`Attachment exceeds ${maxContentBytes} bytes`)
  const bytes = Buffer.from(padded, "base64")
  if (bytes.toString("base64").replace(/=+$/, "") !== normalized) throw new Error("Invalid base64 data URL")
  return { bytes, mime }
}

function referenceKind(value: string): "data" | "file" | undefined {
  if (isDataURLCandidate(value)) return "data"
  if (!/^file:\/\//i.test(value) || /[\r\n\t]/.test(value)) return
  try {
    const url = new URL(value)
    if (url.protocol.toLowerCase() !== "file:" || !url.pathname) return
    fileURLToPath(url)
    return "file"
  } catch {}
}

function isDataURLCandidate(value: string) {
  if (!/^data:/i.test(value)) return false
  const comma = value.indexOf(",")
  if (comma < 5) return false
  const segments = value.slice(5, comma).split(";")
  const mediaType = segments.shift() ?? ""
  return !mediaType || DATA_MEDIA_TYPE.test(mediaType)
}

async function readFileURL(uri: string, mime: string | undefined, maxContentBytes: number) {
  const url = new URL(uri)
  url.search = ""
  url.hash = ""
  const sourcePath = fileURLToPath(url)
  const info = await stat(sourcePath)
  if (!info.isFile()) throw new Error("File URL is not a regular file")
  if (info.size > maxContentBytes) throw new Error(`Attachment exceeds ${maxContentBytes} bytes`)
  return {
    bytes: new Uint8Array(await readFile(sourcePath)),
    mime: mime ?? mimeFromPath(sourcePath),
    filename: path.basename(sourcePath),
    sourcePath,
  }
}

function createSessionResolver(database: Database) {
  const cache = new Map<string, string | undefined>()
  let sessionTable: boolean | undefined
  let queries = 0
  return {
    resolve(candidate: string | undefined, trustWithoutSessionTable = false) {
      if (!candidate) return
      if (sessionTable === undefined) {
        queries += 1
        sessionTable = tableExists(database, "session")
      }
      if (!sessionTable) return trustWithoutSessionTable ? candidate : undefined
      if (cache.has(candidate)) return cache.get(candidate)
      queries += 1
      const session = database
        .query<{ readonly id: string }, [string]>("SELECT id FROM session WHERE id = ? LIMIT 1")
        .get(candidate)?.id
      cache.set(candidate, session)
      return session
    },
    queryCount() {
      return queries
    },
  }
}

function findSessionID(value: unknown, resolver: SessionResolver) {
  const candidate = findString(value, new Set(["sessionID", "sessionId", "session_id"]))
  return resolver.resolve(candidate, true)
}

function findMessageID(value: unknown) {
  if (!isObject(value)) return
  const direct = ["assistantMessageID", "messageID", "messageId", "message_id"]
    .map((key) => value[key])
    .find((item): item is string => typeof item === "string")
  if (direct) return direct
  if (
    typeof value.id === "string" &&
    (["user", "assistant"].includes(string(value.type) ?? "") || ["user", "assistant"].includes(string(value.role) ?? ""))
  ) return value.id
  if (isObject(value.info) && typeof value.info.id === "string" && ["user", "assistant"].includes(string(value.info.role) ?? ""))
    return value.info.id
  if (isObject(value.part) && typeof value.part.messageID === "string") return value.part.messageID
}

function findString(value: unknown, keys: ReadonlySet<string>): string | undefined {
  if (Array.isArray(value)) return value.map((item) => findString(item, keys)).find((item) => item !== undefined)
  if (!isObject(value)) return undefined
  const direct = Object.entries(value).find((entry) => keys.has(entry[0]) && typeof entry[1] === "string")
  if (direct) return direct[1] as string
  return Object.values(value)
    .map((item) => findString(item, keys))
    .find((item) => item !== undefined)
}

function quarantine(
  context: TransformContext,
  jsonPath: string,
  kind: Quarantine["kind"],
  reason: string,
  original: string,
): Quarantine {
  return {
    table: context.table,
    rowid: context.rowid,
    path: jsonPath,
    kind,
    reason,
    originalBytes: Buffer.byteLength(original, "utf8"),
    originalSha256: createHash("sha256").update(original).digest("hex"),
    preview: boundedContentPreview(original),
  }
}

function rowQuarantine(table: string, rowid: number, error: unknown, original: string): Quarantine {
  return {
    table,
    rowid,
    path: "$",
    kind: "row",
    reason: message(error),
    originalBytes: Buffer.byteLength(original, "utf8"),
    originalSha256: createHash("sha256").update(original).digest("hex"),
    preview: boundedContentPreview(original),
  }
}

async function assertOfflineSource(filename: string) {
  if (!existsSync(filename)) throw new Error(`Source database does not exist: ${filename}`)
  const wal = await stat(`${filename}-wal`).catch(() => undefined)
  const journal = await stat(`${filename}-journal`).catch(() => undefined)
  if (wal && wal.size > 0)
    throw new Error(`Source database has a non-empty WAL; close OpenCode before staging: ${filename}`)
  if (journal && journal.size > 0)
    throw new Error(`Source database has an active rollback journal; close OpenCode before staging: ${filename}`)
  const database = new Database(filename, { strict: true })
  try {
    database.exec("PRAGMA busy_timeout = 0")
    database.exec("BEGIN EXCLUSIVE")
    database.exec("ROLLBACK")
  } catch (error) {
    throw new Error(`Source database is not offline: ${filename}`, { cause: error })
  } finally {
    database.close()
  }
}

async function fingerprint(filename: string): Promise<SourceFingerprint> {
  const info = await stat(filename)
  const wal = await stat(`${filename}-wal`).catch(() => undefined)
  const database = new Database(filename, { readonly: true, strict: true })
  try {
    const page = database.query<{ readonly page_count: number }, []>("PRAGMA page_count").get()
    const schema = database.query<{ readonly schema_version: number }, []>("PRAGMA schema_version").get()
    if (!page || !schema) throw new Error(`Unable to fingerprint SQLite database: ${filename}`)
    return {
      size: info.size,
      modified: info.mtimeMs,
      walSize: wal?.size ?? 0,
      walModified: wal?.mtimeMs ?? 0,
      pageCount: page.page_count,
      schemaVersion: schema.schema_version,
    }
  } finally {
    database.close()
  }
}

function assertIntegrity(database: Database, filename: string) {
  const integrity = database.query<{ readonly quick_check: string }, []>("PRAGMA quick_check").all()
  if (integrity.length !== 1 || integrity[0]?.quick_check !== "ok")
    throw new Error(`SQLite quick check failed for ${filename}`)
  const foreignKeys = database.query("PRAGMA foreign_key_check").all()
  if (foreignKeys.length > 0) throw new Error(`SQLite foreign key check failed for ${filename}`)
}

function tableExists(database: Database, table: string) {
  return Boolean(
    database
      .query<{ readonly name: string }, [string]>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table),
  )
}

function lastRow(database: Database, table: string) {
  return (
    database
      .query<
        { readonly rowid: number },
        [string]
      >("SELECT coalesce(max(rowid), 0) AS rowid FROM _content_migration_row WHERE table_name = ?")
      .get(table)?.rowid ?? 0
  )
}

function migrationRowCount(database: Database) {
  return (
    database.query<{ readonly count: number }, []>("SELECT count(*) AS count FROM _content_migration_row").get()
      ?.count ?? 0
  )
}

function readMetadata(database: Database, key: string) {
  return database
    .query<{ readonly value: string }, [string]>("SELECT value FROM _content_migration_meta WHERE key = ?")
    .get(key)?.value
}

function writeMetadata(database: Database, key: string, value: string) {
  database.run(
    "INSERT INTO _content_migration_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
  )
}

function recordCheckpoint(database: Database, batchBytes: number, largestRowBytes: number, oversizedRows: number) {
  database.run(
    "INSERT INTO _content_migration_meta (key, value) VALUES ('row_checkpoint_transactions', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(_content_migration_meta.value AS INTEGER) + 1",
  )
  database.run(
    "INSERT INTO _content_migration_meta (key, value) VALUES ('peak_batch_bytes', ?) ON CONFLICT(key) DO UPDATE SET value = max(CAST(_content_migration_meta.value AS INTEGER), CAST(excluded.value AS INTEGER))",
    [String(batchBytes)],
  )
  database.run(
    "INSERT INTO _content_migration_meta (key, value) VALUES ('largest_row_bytes', ?) ON CONFLICT(key) DO UPDATE SET value = max(CAST(_content_migration_meta.value AS INTEGER), CAST(excluded.value AS INTEGER))",
    [String(largestRowBytes)],
  )
  database.run(
    "INSERT INTO _content_migration_meta (key, value) VALUES ('oversized_rows', ?) ON CONFLICT(key) DO UPDATE SET value = CAST(_content_migration_meta.value AS INTEGER) + CAST(excluded.value AS INTEGER)",
    [String(oversizedRows)],
  )
}

function isSQLiteBusy(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "SQLITE_BUSY"
}

function configureStagingDatabase(database: Database) {
  // Never alter the source DB's journal mode: WAL is scoped to the isolated candidate so progress readers cannot block it.
  database.exec(`PRAGMA busy_timeout = ${STAGING_BUSY_TIMEOUT_MS}`)
  if (database.query<{ readonly journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode !== "wal")
    database.exec("PRAGMA journal_mode = WAL")
}

async function writeManifest(filename: string, manifest: Manifest) {
  const temporary = `${filename}.tmp-${crypto.randomUUID()}`
  await writeFile(temporary, JSON.stringify(manifest, null, 2))
  try {
    await rename(temporary, filename)
  } catch {
    await rm(filename, { force: true })
    await rename(temporary, filename)
  }
}

function sameFingerprint(a: SourceFingerprint, b: SourceFingerprint) {
  return (
    a.size === b.size &&
    a.modified === b.modified &&
    a.walSize === b.walSize &&
    a.walModified === b.walModified &&
    a.pageCount === b.pageCount &&
    a.schemaVersion === b.schemaVersion
  )
}

function dataVersion(database: Database) {
  return database.query<{ readonly data_version: number }, []>("PRAGMA data_version").get()?.data_version ?? -1
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requireObject(value: unknown) {
  if (!isObject(value)) throw new Error("Event payload is not an object")
  return value
}

function isContentReference(value: Record<string, unknown>) {
  return isObject(value.$opencode) && value.$opencode.type === "content-reference"
}

function safeStringify(value: unknown) {
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

function pointer(base: string, key: string) {
  return `${base}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`
}

function string(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function mimeFromPath(filename: string) {
  const extension = path.extname(filename).toLowerCase()
  if (extension === ".png") return "image/png"
  if ([".jpg", ".jpeg"].includes(extension)) return "image/jpeg"
  if (extension === ".webp") return "image/webp"
  if (extension === ".gif") return "image/gif"
  if (extension === ".pdf") return "application/pdf"
  if ([".txt", ".md", ".log"].includes(extension)) return "text/plain"
  if (extension === ".json") return "application/json"
  return "application/octet-stream"
}

function contains(directory: string, filename: string) {
  const relative = path.relative(directory, filename)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function sqlString(value: string) {
  return `'${value.replaceAll("'", "''")}'`
}
