import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { StorageMaintenance } from "../src/storage-maintenance"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

describe("StorageMaintenance", () => {
  test("reports database, archive, blob, backup, deduplication, and manifest status", async () => {
    const root = await temporaryRoot()
    const active = path.join(root, "opencode.db")
    const local = path.join(root, "opencode-local.db")
    const archive = path.join(root, "archives", "2026-07.db")
    const first = "a".repeat(64)
    const second = "b".repeat(64)
    await mkdir(path.dirname(archive), { recursive: true })
    createStorageDatabase(active, 2, [
      { id: "att_1", sha256: first, size: 3 },
      { id: "att_2", sha256: first, size: 3 },
      { id: "att_3", sha256: second, size: 4 },
    ])
    createStorageDatabase(local, 1, [])
    createArchiveDatabase(archive, 3, [{ id: "att_4", sha256: first }])
    const database = new Database(active)
    database.run(
      "INSERT INTO content_blob (sha256, size_bytes, mime, storage_path, created_at) VALUES (?, 8, 'application/octet-stream', ?, 1)",
      ["c".repeat(64), path.join("content", "cc", "c".repeat(64))],
    )
    database.close()
    await writeBlob(root, first, "one")
    await writeBlob(root, second, "four")
    await writeFile(path.join(root, "opencode.db.bak-accepted"), "rollback")
    await writeFile(path.join(root, `opencode.db.opencode-rollback-${"c".repeat(24)}`), "activation rollback")
    const compactionBackup = path.join(root, "opencode.db.bak-event-compaction-2026-01-01T00-00-00-000Z")
    await writeFile(compactionBackup, "compacted rollback")
    await writeFile(`${compactionBackup}-wal`, "wal")
    const snapshotFile = path.join(root, "snapshot", "a".repeat(40), "objects", "payload")
    await mkdir(path.dirname(snapshotFile), { recursive: true })
    await writeFile(snapshotFile, "snapshot")
    await mkdir(path.join(root, "backups"), { recursive: true })
    await writeFile(path.join(root, "backups", "manual-copy.db"), "backup")
    await writeFile(
      path.join(root, "storage-migration.manifest.json"),
      JSON.stringify({
        status: "ready",
        phase: "validate",
        message: "Manifest verified",
        updatedAt: 123,
        resumable: true,
      }),
    )
    await writeFile(
      path.join(root, "storage-migration-runtime.json"),
      JSON.stringify({ state: "completed", message: "Storage migration activated successfully", updatedAt: 456 }),
    )
    await writeFile(path.join(root, "maintenance.manifest.json"), "not json")

    const snapshot = await Effect.runPromise(StorageMaintenance.make({ data: root }).snapshot())

    expect(snapshot.activeDatabase.sessions).toBe(2)
    expect(snapshot.localDatabase.sessions).toBe(1)
    expect(snapshot.archives).toMatchObject({ files: 1, sessions: 3 })
    expect(snapshot.blobs).toMatchObject({ files: 2, bytes: 7, indexed: 3 })
    expect(snapshot.backups.files).toBe(3)
    expect(snapshot.backups.items.map((backup) => backup.id).sort()).toEqual([
      "manual-copy.db",
      "opencode.db.bak-accepted",
      `opencode.db.opencode-rollback-${"c".repeat(24)}`,
    ])
    expect(snapshot.snapshots).toMatchObject({ files: 1, bytes: 8 })
    expect(snapshot.compactionBackups).toMatchObject({ files: 1, bytes: 21 })
    expect(snapshot.attachments).toEqual({
      references: 4,
      uniqueBlobs: 2,
      deduplicated: 2,
      referencedBytes: 13,
      storedBytes: 7,
      savedBytes: 6,
    })
    expect(snapshot.manifests).toContainEqual({
      path: path.join(root, "storage-migration.manifest.json"),
      kind: "migration",
      valid: true,
      status: "ready",
      phase: "validate",
      message: "Manifest verified",
      updatedAt: 123,
      resumable: true,
    })
    expect(snapshot.manifests).toContainEqual({
      path: path.join(root, "storage-migration-runtime.json"),
      kind: "migration",
      valid: true,
      status: "completed",
      phase: undefined,
      message: "Storage migration activated successfully",
      updatedAt: 456,
      resumable: undefined,
    })
    expect(snapshot.manifests.find((manifest) => manifest.path.endsWith("maintenance.manifest.json"))).toMatchObject({
      kind: "maintenance",
      valid: false,
    })
  })

  test("evaluates SQLite and managed blob integrity without changing data", async () => {
    const root = await temporaryRoot()
    const active = path.join(root, "opencode.db")
    const valid = new Bun.CryptoHasher("sha256").update("valid").digest("hex")
    const missing = new Bun.CryptoHasher("sha256").update("missing").digest("hex")
    createStorageDatabase(active, 1, [
      { id: "att_valid", sha256: valid, size: 5 },
      { id: "att_missing", sha256: missing, size: 7 },
    ])
    await writeBlob(root, valid, "valid")

    const result = await Effect.runPromise(
      StorageMaintenance.make({ data: root }).runIntegrityDryRun({ level: "full" }),
    )

    expect(result.level).toBe("full")
    expect(result.databases).toHaveLength(1)
    expect(result.databases[0]).toMatchObject({ kind: "active", ok: true, result: "ok", foreignKeyViolations: 0 })
    expect(result.blobs).toEqual({ checked: 2, missing: 1, sizeMismatch: 0, hashMismatch: 0, unsafePath: 0 })
    expect(result.healthy).toBe(false)
    expect(await readFile(path.join(root, "content", valid.slice(0, 2), valid), "utf8")).toBe("valid")
  })

  test("retires only an unchanged managed backup after exact confirmation and durable journaling", async () => {
    const root = await temporaryRoot()
    const backup = path.join(root, "opencode.db.bak-2026-07-13")
    await writeFile(backup, "rollback")
    const service = StorageMaintenance.make({ data: root })
    const review = await stat(backup)

    await expect(
      Effect.runPromise(
        service.retireBackup({
          path: backup,
          confirmation: "yes",
          expectedBytes: review.size,
          expectedModifiedAt: review.mtimeMs,
        }),
      ),
    ).rejects.toBeDefined()
    expect(await Bun.file(backup).exists()).toBe(true)
    expect(await Bun.file(path.join(root, "storage-retirement.journal.jsonl")).exists()).toBe(false)

    await expect(
      Effect.runPromise(
        service.retireBackup({
          path: backup,
          confirmation: StorageMaintenance.retirementConfirmation(backup),
          expectedBytes: review.size,
          expectedModifiedAt: review.mtimeMs,
        }),
      ),
    ).rejects.toBeDefined()
    expect(await Bun.file(backup).exists()).toBe(true)

    const old = new Date(Date.now() - 15 * 24 * 60 * 60 * 1_000)
    await utimes(backup, old, old)
    const retained = await stat(backup)

    const retired = await Effect.runPromise(
      service.retireBackup({
        path: backup,
        confirmation: StorageMaintenance.retirementConfirmation(backup),
        expectedBytes: review.size,
        expectedModifiedAt: retained.mtimeMs,
      }),
    )

    expect(retired.path).toBe(backup)
    expect(retired.bytes).toBe(review.size)
    expect(await Bun.file(backup).exists()).toBe(false)
    const journal = (await readFile(path.join(root, "storage-retirement.journal.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(journal).toHaveLength(2)
    expect(journal[0]).toMatchObject({ id: retired.id, state: "requested", path: backup, bytes: review.size })
    expect(journal[1]).toMatchObject({ id: retired.id, state: "completed", path: backup, bytes: review.size })
  })

  test("rejects retirement of files outside the managed backup inventory", async () => {
    const root = await temporaryRoot()
    const database = path.join(root, "opencode.db")
    await writeFile(database, "live")
    const review = await stat(database)

    await expect(
      Effect.runPromise(
        StorageMaintenance.make({ data: root }).retireBackup({
          path: database,
          confirmation: StorageMaintenance.retirementConfirmation(database),
          expectedBytes: review.size,
          expectedModifiedAt: review.mtimeMs,
        }),
      ),
    ).rejects.toBeDefined()
    expect(await Bun.file(database).exists()).toBe(true)
  })
})

async function temporaryRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-storage-maintenance-"))
  roots.push(root)
  return root
}

function createStorageDatabase(
  filename: string,
  sessions: number,
  attachments: ReadonlyArray<{ readonly id: string; readonly sha256: string; readonly size: number }>,
) {
  const database = new Database(filename)
  database.exec("CREATE TABLE session (id TEXT PRIMARY KEY)")
  database.exec(
    "CREATE TABLE content_blob (sha256 TEXT PRIMARY KEY, size_bytes INTEGER NOT NULL, mime TEXT NOT NULL, storage_path TEXT NOT NULL, created_at INTEGER NOT NULL)",
  )
  database.exec(
    "CREATE TABLE attachment (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, size_bytes INTEGER, storage_path TEXT NOT NULL, blob_sha256 TEXT)",
  )
  Array.from({ length: sessions }, (_, index) => `ses_${index}`).forEach((id) =>
    database.run("INSERT INTO session (id) VALUES (?)", [id]),
  )
  attachments.forEach((attachment) => {
    database.run(
      "INSERT OR IGNORE INTO content_blob (sha256, size_bytes, mime, storage_path, created_at) VALUES (?, ?, 'application/octet-stream', ?, 1)",
      [attachment.sha256, attachment.size, path.join("content", attachment.sha256.slice(0, 2), attachment.sha256)],
    )
    database.run(
      "INSERT INTO attachment (id, session_id, size_bytes, storage_path, blob_sha256) VALUES (?, 'ses_0', ?, ?, ?)",
      [
        attachment.id,
        attachment.size,
        path.join("content", attachment.sha256.slice(0, 2), attachment.sha256),
        attachment.sha256,
      ],
    )
  })
  database.close()
}

async function writeBlob(root: string, sha256: string, content: string) {
  const filename = path.join(root, "content", sha256.slice(0, 2), sha256)
  await mkdir(path.dirname(filename), { recursive: true })
  await writeFile(filename, content)
}

function createArchiveDatabase(
  filename: string,
  sessions: number,
  attachments: ReadonlyArray<{ readonly id: string; readonly sha256: string }>,
) {
  const database = new Database(filename)
  database.exec("CREATE TABLE archive_session (session_id TEXT NOT NULL, revision INTEGER NOT NULL)")
  database.exec(
    "CREATE TABLE archive_attachment_ref (session_id TEXT NOT NULL, revision INTEGER NOT NULL, attachment_id TEXT NOT NULL, blob_sha256 TEXT NOT NULL)",
  )
  Array.from({ length: sessions }, (_, index) => `ses_archive_${index}`).forEach((id) =>
    database.run("INSERT INTO archive_session (session_id, revision) VALUES (?, 1)", [id]),
  )
  attachments.forEach((attachment) =>
    database.run(
      "INSERT INTO archive_attachment_ref (session_id, revision, attachment_id, blob_sha256) VALUES ('ses_archive_0', 1, ?, ?)",
      [attachment.id, attachment.sha256],
    ),
  )
  database.close()
}
