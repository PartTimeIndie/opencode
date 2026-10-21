import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { rename, rm, stat, statfs } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { Effect } from "effect"
import { decodeStoredEventData, encodeStoredEventData } from "./event"
import { Global } from "./global"
import { EffectFlock } from "./util/effect-flock"

const COMPACT_HEADROOM_BYTES = 64 * 1024 * 1024
const COMPRESS_BATCH_ROWS = 250
type Checkpoint = {
  readonly version: 1
  readonly source: string
  readonly candidate: string
  readonly output: string
  readonly backup: string
  readonly phase: "copy" | "compress" | "validate" | "switch"
  readonly expected?: Signature
}

export type Result = {
  readonly backup: string
  readonly before: Statistics
  readonly after: Statistics
  readonly changed: number
}

type Statistics = {
  readonly events: number
  readonly dataBytes: number
  readonly fileBytes: number
}

type Signature = {
  readonly events: number
  readonly sequences: number
  readonly hash: string
}

export interface LockManager {
  readonly withLock: <A>(key: string, body: () => Promise<A>) => Promise<A>
}

const defaultLockManager: LockManager = {
  withLock: (key, body) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const flock = yield* EffectFlock.Service
        return yield* flock.withLock(Effect.promise(body), key, join(Global.Path.state, "locks"))
      }).pipe(Effect.provide(EffectFlock.defaultLayer)),
    ),
}

export function eventCompactionLockKey(source: string) {
  const absolute = resolve(source)
  return `event-compaction:${process.platform === "win32" ? absolute.toLowerCase() : absolute}`
}

/**
 * Compacts the historical event database offline. The copy, compress, and
 * validate phases write staging files only; the validated output is then
 * activated with same-volume renames that keep the original as the rollback
 * backup. Every step is checkpointed, so an interrupted run resumes and a
 * failed swap restores the original.
 */
export function compactEventDatabase(source: string, locks: LockManager = defaultLockManager): Promise<Result> {
  return locks.withLock(eventCompactionLockKey(source), () => compactEventDatabaseUnlocked(source))
}

async function compactEventDatabaseUnlocked(source: string): Promise<Result> {
  const checkpointPath = `${source}.event-compaction.json`
  const checkpoint = await loadCheckpoint(checkpointPath, source)
  // Once a swap began, the original content lives at the backup path: between
  // the swap renames the source path is empty, and afterwards it is replaced.
  const original = (await Bun.file(checkpoint.backup).exists()) ? checkpoint.backup : source
  await assertOfflineSource((await Bun.file(source).exists()) ? source : original)
  await ensureCapacity(source, checkpoint)

  if (checkpoint.phase === "copy") {
    await copyDatabase(source, checkpoint.candidate)
    await saveCheckpoint(checkpointPath, { ...checkpoint, phase: "compress" })
  }

  const before = await statistics(original)
  const expected = checkpoint.expected ?? (await signature(original))
  const changed = checkpoint.phase === "copy" || checkpoint.phase === "compress" ? await compress(checkpoint.candidate) : 0
  if (checkpoint.phase === "copy" || checkpoint.phase === "compress")
    await saveCheckpoint(checkpointPath, { ...checkpoint, phase: "validate" })

  if (checkpoint.phase === "copy" || checkpoint.phase === "compress" || checkpoint.phase === "validate") {
    await validate(checkpoint.candidate, expected)
    await copyDatabase(checkpoint.candidate, checkpoint.output)
    await validate(checkpoint.output, expected)
    await saveCheckpoint(checkpointPath, { ...checkpoint, expected, phase: "switch" })
  }

  await assertOfflineSource((await Bun.file(source).exists()) ? source : original)
  assertSignature(expected, await signature(original), original)
  if (checkpoint.phase === "switch" && (await Bun.file(checkpoint.output).exists())) await validate(checkpoint.output, expected)
  await replaceSource(source, checkpoint)
  const after = await statistics(source)
  await rm(checkpoint.candidate, { force: true })
  await rm(checkpointPath, { force: true })
  return { backup: checkpoint.backup, before, after, changed }
}

/** Removes only generated staging files after a source change made a prior snapshot stale. */
export function resetEventCompaction(source: string, locks: LockManager = defaultLockManager): Promise<void> {
  return locks.withLock(eventCompactionLockKey(source), () => resetEventCompactionUnlocked(source))
}

async function resetEventCompactionUnlocked(source: string) {
  const checkpointPath = `${source}.event-compaction.json`
  if (!(await Bun.file(checkpointPath).exists())) return
  const checkpoint = await loadCheckpoint(checkpointPath, source)
  assertGeneratedPaths(source, checkpoint)
  // A swap interrupted between its renames parked the original at the backup
  // path; it must move back before any staging file is deleted.
  if (!(await Bun.file(source).exists()) && (await Bun.file(checkpoint.backup).exists()))
    await renameWithRetry(checkpoint.backup, source)
  await Promise.all([checkpoint.candidate, checkpoint.output, checkpoint.backup, checkpointPath].map((file) => rm(file, { force: true })))
}

async function loadCheckpoint(path: string, source: string): Promise<Checkpoint> {
  if (await Bun.file(path).exists()) {
    const checkpoint = await Bun.file(path).json()
    if (!isCheckpoint(checkpoint) || checkpoint.source !== source) throw new Error(`Invalid event compaction checkpoint: ${path}`)
    return checkpoint
  }
  const suffix = new Date().toISOString().replaceAll(/[:.]/g, "-")
  const checkpoint = {
    version: 1 as const,
    source,
    candidate: join(dirname(source), `opencode-event-compaction-${suffix}.db`),
    output: join(dirname(source), `opencode-event-compaction-${suffix}.final.db`),
    backup: `${source}.bak-event-compaction-${suffix}`,
    phase: "copy" as const,
  }
  await saveCheckpoint(path, checkpoint)
  return checkpoint
}

async function saveCheckpoint(path: string, checkpoint: Checkpoint) {
  const temporary = `${path}.tmp`
  await Bun.write(temporary, JSON.stringify(checkpoint, null, 2))
  await rename(temporary, path)
}

/**
 * Computes the bytes a compaction run must keep free, from the artifacts it
 * still has to write. A fresh run writes the candidate copy and the final
 * output; a resumed run writes only the missing one. Both are VACUUM INTO
 * results, so their size is bounded by the live (non-freelist) bytes of their
 * seed file. The swap itself only renames within the volume and needs no
 * space. Compress commits one batch of rows per transaction, so journal and
 * WAL spikes are bounded by a batch of the largest event rows.
 */
export function requiredCompactionBytes(input: {
  readonly phase: Checkpoint["phase"]
  readonly candidateExists: boolean
  readonly outputExists: boolean
  readonly liveBytes?: number
  readonly batchBytes?: number
  readonly batchRows?: number
  readonly pageSize?: number
}): number {
  if (input.outputExists) return COMPACT_HEADROOM_BYTES
  const artifacts = (input.liveBytes ?? 0) * (input.candidateExists ? 1 : 2)
  if (input.phase !== "copy" && input.phase !== "compress") return artifacts + COMPACT_HEADROOM_BYTES
  return artifacts + Math.max(COMPACT_HEADROOM_BYTES, (input.batchBytes ?? 0) + (input.batchRows ?? 0) * 2 * (input.pageSize ?? 0))
}

async function ensureCapacity(source: string, checkpoint: Checkpoint) {
  const outputExists = await Bun.file(checkpoint.output).exists()
  const candidateExists = await Bun.file(checkpoint.candidate).exists()
  const usage = outputExists ? {} : await databaseUsage(candidateExists ? checkpoint.candidate : source)
  const required = requiredCompactionBytes({ phase: checkpoint.phase, candidateExists, outputExists, ...usage })
  const volume = await statfs(dirname(source))
  const available = volume.bavail * volume.bsize
  if (available < required)
    throw new Error(
      `Insufficient free space for event compaction: ${available} bytes available, ${required} bytes required. ` +
        `Compaction writes at most two live-size copies beside ${source} and activates them with same-volume renames; ` +
        `free space and retry.`,
    )
}

async function databaseUsage(filename: string) {
  const database = new Database(filename, { readonly: true, strict: true })
  try {
    const pageSize = database.query<{ readonly page_size: number }, []>("PRAGMA page_size").get()
    const pageCount = database.query<{ readonly page_count: number }, []>("PRAGMA page_count").get()
    const freelistCount = database.query<{ readonly freelist_count: number }, []>("PRAGMA freelist_count").get()
    const row = database.query<{ readonly batchBytes: number | null; readonly batchRows: number }, []>(
      `SELECT COALESCE(SUM(rowBytes), 0) AS batchBytes, COUNT(*) AS batchRows
       FROM (
         SELECT length(CAST(data AS BLOB)) AS rowBytes
         FROM event
         ORDER BY length(CAST(data AS BLOB)) DESC
         LIMIT ${COMPRESS_BATCH_ROWS}
       )`,
    ).get()
    return {
      liveBytes: pageSize!.page_size * (pageCount!.page_count - freelistCount!.freelist_count) + (await walSize(filename)),
      batchBytes: row?.batchBytes ?? 0,
      batchRows: row?.batchRows ?? 0,
      pageSize: pageSize!.page_size,
    }
  } finally {
    database.close()
  }
}

async function copyDatabase(source: string, output: string) {
  if (await Bun.file(output).exists()) {
    const existing = new Database(output, { readonly: true, strict: true })
    try {
      assertIntegrity(existing, output)
      return
    } finally {
      existing.close()
    }
  }
  const database = new Database(source, { strict: true })
  try {
    assertIntegrity(database, source)
    database.exec(`VACUUM INTO ${sqlString(output)}`)
  } finally {
    database.close()
  }
}

async function compress(filename: string) {
  const database = new Database(filename, { strict: true })
  try {
    assertIntegrity(database, filename)
    const select = database.query<{ readonly rowid: number; readonly data: string }, [number]>(
      `SELECT rowid, data FROM event WHERE rowid > ? ORDER BY rowid LIMIT ${COMPRESS_BATCH_ROWS}`,
    )
    const update = database.query("UPDATE event SET data = ? WHERE rowid = ?")
    const writeBatch = database.transaction((rows: ReadonlyArray<{ readonly rowid: number; readonly data: string }>) => {
      return rows.reduce((count, row) => {
        const decoded = decodeStoredEventData(parseData(row.data, row.rowid))
        const encoded = JSON.stringify(encodeStoredEventData(decoded))
        if (encoded === row.data) return count
        update.run(encoded, row.rowid)
        return count + 1
      }, 0)
    })
    let lastRowID = 0
    let changed = 0
    while (true) {
      const rows = select.all(lastRowID)
      if (rows.length === 0) return changed
      changed += writeBatch(rows)
      lastRowID = rows.at(-1)!.rowid
    }
  } finally {
    database.close()
  }
}

async function validate(filename: string, expected: Signature) {
  const database = new Database(filename, { readonly: true, strict: true })
  try {
    assertIntegrity(database, filename)
    assertSignature(expected, signatureFromDatabase(database), filename)
    const select = database.query<{ readonly rowid: number; readonly data: string }, [number]>(
      `SELECT rowid, data FROM event WHERE rowid > ? ORDER BY rowid LIMIT ${COMPRESS_BATCH_ROWS}`,
    )
    let lastRowID = 0
    while (true) {
      const rows = select.all(lastRowID)
      if (rows.length === 0) return
      rows.forEach((row) => decodeStoredEventData(parseData(row.data, row.rowid)))
      lastRowID = rows.at(-1)!.rowid
    }
  } finally {
    database.close()
  }
}

/**
 * Activates the validated output with two same-volume renames. The original
 * database itself becomes the rollback backup first, so no second full copy of
 * the original is written; then the output takes the source path. A failure of
 * the second rename restores the original, and a crash between the renames
 * leaves a state the next run completes.
 */
async function replaceSource(source: string, checkpoint: Checkpoint) {
  if (!(await Bun.file(checkpoint.backup).exists())) {
    await renameWithRetry(source, checkpoint.backup)
    try {
      await renameWithRetry(checkpoint.output, source)
    } catch (error) {
      await restoreOriginal(checkpoint.backup, source, error)
    }
    return
  }
  if (await Bun.file(checkpoint.output).exists()) return renameWithRetry(checkpoint.output, source)
  if (!(await Bun.file(source).exists()))
    throw new Error(
      `Event compaction stopped between swap renames: the original database is preserved at ${checkpoint.backup} ` +
        `and the validated output at ${checkpoint.output}`,
    )
}

async function restoreOriginal(backup: string, source: string, cause: unknown): Promise<never> {
  try {
    await renameWithRetry(backup, source)
  } catch (error) {
    throw new Error(
      `Event compaction swap failed and the original database could not be restored automatically: ` +
        `original at ${backup}, validated output at ${source}. Rerun compaction to finish the swap.`,
      { cause: error },
    )
  }
  throw new Error(`Event compaction swap failed; the original database was restored from ${backup}`, { cause })
}

async function renameWithRetry(source: string, destination: string, attempt = 0): Promise<void> {
  try {
    await rename(source, destination)
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
    if (!code || !["EACCES", "EBUSY", "EPERM"].includes(code) || attempt === 19) throw error
    await new Promise((resolve) => setTimeout(resolve, 250))
    await renameWithRetry(source, destination, attempt + 1)
  }
}

async function assertOfflineSource(source: string) {
  const database = new Database(source, { strict: true })
  try {
    database.exec("PRAGMA busy_timeout = 0")
    const checkpoint = database.query<{ readonly busy: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)").get()
    if (!checkpoint || checkpoint.busy !== 0) throw new Error(`Database has an active writer: close OpenCode before compacting ${source}`)
    database.exec("BEGIN EXCLUSIVE")
    database.exec("COMMIT")
  } finally {
    database.close()
  }
  if ((await walSize(source)) > 0) throw new Error(`Database WAL remains active: close OpenCode before compacting ${source}`)
}

async function statistics(filename: string): Promise<Statistics> {
  const database = new Database(filename, { readonly: true, strict: true })
  try {
    return { ...statisticsFromDatabase(database), fileBytes: (await stat(filename)).size }
  } finally {
    database.close()
  }
}

function statisticsFromDatabase(database: Database): Omit<Statistics, "fileBytes"> {
  const row = database.query<{ readonly events: number; readonly dataBytes: number }, []>(
    "SELECT count(*) AS events, coalesce(sum(length(data)), 0) AS dataBytes FROM event",
  ).get()
  if (!row) throw new Error("Event table statistics are unavailable")
  return row
}

async function signature(filename: string): Promise<Signature> {
  const database = new Database(filename, { readonly: true, strict: true })
  try {
    return signatureFromDatabase(database)
  } finally {
    database.close()
  }
}

function signatureFromDatabase(database: Database): Signature {
  const hash = createHash("sha256")
  const events = database.query<
    { readonly id: string; readonly aggregate_id: string; readonly seq: number; readonly type: string; readonly data: string },
    []
  >("SELECT id, aggregate_id, seq, type, data FROM event ORDER BY aggregate_id, seq").iterate()
  let count = 0
  for (const event of events) {
    hash.update(JSON.stringify([event.id, event.aggregate_id, event.seq, event.type, decodeStoredEventData(parseData(event.data, count + 1))]))
    hash.update("\n")
    count += 1
  }
  const sequences = database.query<{ readonly aggregate_id: string; readonly seq: number }, []>(
    "SELECT aggregate_id, seq FROM event_sequence ORDER BY aggregate_id",
  ).iterate()
  let sequenceCount = 0
  for (const sequence of sequences) {
    hash.update(JSON.stringify([sequence.aggregate_id, sequence.seq]))
    hash.update("\n")
    sequenceCount += 1
  }
  const mismatches = database.query<{ readonly aggregate_id: string }, []>(
    "SELECT event.aggregate_id FROM event JOIN event_sequence ON event.aggregate_id = event_sequence.aggregate_id GROUP BY event.aggregate_id HAVING max(event.seq) <> event_sequence.seq",
  ).all()
  if (mismatches.length > 0) throw new Error(`Event sequence mismatch for ${mismatches[0].aggregate_id}`)
  return { events: count, sequences: sequenceCount, hash: hash.digest("hex") }
}

function assertSignature(expected: Signature, actual: Signature, filename: string) {
  if (expected.events !== actual.events || expected.sequences !== actual.sequences || expected.hash !== actual.hash)
    throw new Error(`Logical event validation failed for ${filename}`)
}

async function walSize(source: string) {
  const wal = Bun.file(`${source}-wal`)
  return (await wal.exists()) ? wal.size : 0
}

function assertIntegrity(database: Database, filename: string) {
  const integrity = database.query<{ readonly integrity_check: string }, []>("PRAGMA integrity_check").all()
  if (integrity.length !== 1 || integrity[0].integrity_check !== "ok")
    throw new Error(`SQLite integrity check failed for ${filename}: ${integrity.map((row) => row.integrity_check).join(", ")}`)
  const foreignKeys = database.query("PRAGMA foreign_key_check").all()
  if (foreignKeys.length > 0) throw new Error(`SQLite foreign key check failed for ${filename}`)
}

function parseData(source: string, rowid: number) {
  const parsed = JSON.parse(source)
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(`Event row ${rowid} does not contain an object payload`)
  return parsed as Record<string, unknown>
}

function sqlString(value: string) {
  return `'${value.replaceAll("'", "''")}'`
}

function isCheckpoint(value: unknown): value is Checkpoint {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const checkpoint = value as Record<string, unknown>
  return (
    checkpoint.version === 1 &&
    typeof checkpoint.source === "string" &&
    typeof checkpoint.candidate === "string" &&
    typeof checkpoint.output === "string" &&
    typeof checkpoint.backup === "string" &&
    (checkpoint.expected === undefined || isSignature(checkpoint.expected)) &&
    ["copy", "compress", "validate", "switch"].includes(String(checkpoint.phase))
  )
}

function isSignature(value: unknown): value is Signature {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const signature = value as Record<string, unknown>
  return typeof signature.events === "number" && typeof signature.sequences === "number" && typeof signature.hash === "string"
}

function assertGeneratedPaths(source: string, checkpoint: Checkpoint) {
  if (
    dirname(checkpoint.candidate) !== dirname(source) ||
    dirname(checkpoint.output) !== dirname(source) ||
    checkpoint.candidate === source ||
    checkpoint.output === source ||
    !checkpoint.backup.startsWith(`${source}.bak-event-compaction-`)
  )
    throw new Error("Compaction checkpoint references paths outside its generated staging area")
}
