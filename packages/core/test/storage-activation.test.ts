import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, open, readdir, rename, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { StorageActivation } from "../src/storage-activation"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

describe("storage activation", () => {
  if (process.platform === "win32")
    test("fingerprints databases larger than SQLite's pending-byte lock", async () => {
      const fixture = await setup("production")
      const source = await open(fixture.options.sourceDatabase, "r+")
      await source.truncate(0x40000000 + 4096)
      await source.close()

      const manifest = await StorageActivation.prepare(fixture.options)

      expect(manifest.source.sizeBytes).toBe(0x40000000 + 4096)
    })

  test("validates and atomically activates a complete candidate while retaining rollback data", async () => {
    const fixture = await setup("production")
    const manifest = await StorageActivation.prepare(fixture.options)
    const result = await StorageActivation.activate(fixture.options)

    expect(marker(fixture.options.sourceDatabase)).toBe("candidate")
    expect(marker(result.backupDatabase)).toBe("source")
    expect(
      await Bun.file(path.join(fixture.options.liveBlobDirectory, fixture.hash.slice(0, 2), fixture.hash)).exists(),
    ).toBeTrue()
    expect(await Bun.file(path.join(fixture.options.liveArchiveDirectory, "archive-0001.sqlite")).exists()).toBeTrue()
    const retention = await Bun.file(result.retentionManifest).json()
    expect(retention.retainedBlobs).toEqual([fixture.hash])
    expect(retention.retainUntil - retention.createdAt).toBe(StorageActivation.ROLLBACK_RETENTION_MS)
    expect(await Bun.file(manifest.backupRetentionManifest).json()).toEqual(retention)
    expect((await Bun.file(result.activationJournal).json()).events.at(-1)?.state).toBe("completed")
    expect(manifest.source.sha256).not.toBe(manifest.candidate.sha256)
  })

  test("restores a completed production activation only after exact confirmation", async () => {
    const fixture = await setup("production")
    const manifest = await StorageActivation.prepare(fixture.options)
    await StorageActivation.activate(fixture.options)

    await expect(StorageActivation.rollback({ ...fixture.options, confirm: "wrong-id" })).rejects.toMatchObject({
      code: "configuration",
    })
    expect(marker(fixture.options.sourceDatabase)).toBe("candidate")

    const result = await StorageActivation.rollback({ ...fixture.options, confirm: manifest.id })
    expect(result.resumed).toBeFalse()
    expect(marker(result.activeDatabase)).toBe("source")
    expect(marker(result.preservedCandidateDatabase)).toBe("candidate")
    expect(await Bun.file(manifest.backupDatabase).exists()).toBeFalse()
    expect((await Bun.file(result.rollbackJournal).json()).events.map((event: { state: string }) => event.state)).toEqual([
      "validated",
      "active-preserved",
      "backup-restored",
      "completed",
    ])
  })

  test("resumes rollback after preserving the candidate or restoring the backup", async () => {
    const preserved = await setup("production")
    const preservedManifest = await StorageActivation.prepare(preserved.options)
    await StorageActivation.activate(preserved.options)
    const preservedCandidate = path.join(
      preserved.options.stagingDirectory,
      `rolled-back-candidate-${preservedManifest.id}.db`,
    )
    await rename(preserved.options.sourceDatabase, preservedCandidate)

    const first = await StorageActivation.rollback({ ...preserved.options, confirm: preservedManifest.id })
    expect(first.resumed).toBeTrue()
    expect(marker(first.activeDatabase)).toBe("source")
    expect(marker(first.preservedCandidateDatabase)).toBe("candidate")

    const restored = await setup("production")
    const restoredManifest = await StorageActivation.prepare(restored.options)
    await StorageActivation.activate(restored.options)
    const restoredCandidate = path.join(
      restored.options.stagingDirectory,
      `rolled-back-candidate-${restoredManifest.id}.db`,
    )
    await rename(restored.options.sourceDatabase, restoredCandidate)
    await rename(restoredManifest.backupDatabase, restored.options.sourceDatabase)

    const second = await StorageActivation.rollback({ ...restored.options, confirm: restoredManifest.id })
    expect(second.resumed).toBeTrue()
    expect(marker(second.activeDatabase)).toBe("source")
    expect(marker(second.preservedCandidateDatabase)).toBe("candidate")
  })

  test("keeps production and local rollback entrypoints isolated", async () => {
    const local = await setup("local")
    const manifest = await StorageActivation.prepare(local.options)
    await StorageActivation.activateLocal(local.options)

    await expect(
      StorageActivation.rollback({ ...local.options, databaseKind: "production", confirm: manifest.id }),
    ).rejects.toMatchObject({ code: "configuration" })
    expect(marker(local.options.sourceDatabase)).toBe("candidate")
    await StorageActivation.rollbackLocal({ ...local.options, confirm: manifest.id })
    expect(marker(local.options.sourceDatabase)).toBe("source")
  })

  test("refuses a changed source and leaves it active", async () => {
    const fixture = await setup("production")
    await StorageActivation.prepare(fixture.options)
    writeMarker(fixture.options.sourceDatabase, "changed-after-manifest")

    await expect(StorageActivation.activate(fixture.options)).rejects.toMatchObject({ code: "integrity" })
    expect(marker(fixture.options.sourceDatabase)).toBe("changed-after-manifest")
  })

  test("restores the original automatically when activation fails after moving it", async () => {
    const fixture = await setup("production")
    await StorageActivation.prepare(fixture.options)

    await expect(
      StorageActivation.activate({
        ...fixture.options,
        onProgress: (progress) => {
          if (progress === "source-moved") throw new globalThis.Error("simulated interruption")
        },
      }),
    ).rejects.toMatchObject({ code: "recovery" })
    expect(marker(fixture.options.sourceDatabase)).toBe("source")
  })

  test("resumes the crash state after the original was renamed but before candidate activation", async () => {
    const fixture = await setup("production")
    const manifest = await StorageActivation.prepare(fixture.options)
    await rename(fixture.options.sourceDatabase, manifest.backupDatabase)

    const result = await StorageActivation.activate(fixture.options)

    expect(result.resumed).toBeTrue()
    expect(marker(fixture.options.sourceDatabase)).toBe("candidate")
    expect(marker(manifest.backupDatabase)).toBe("source")
  })

  test("resumes the crash state after candidate activation and keeps local activation explicit", async () => {
    const production = await setup("production")
    const manifest = await StorageActivation.prepare(production.options)
    await rename(production.options.sourceDatabase, manifest.backupDatabase)
    await rename(production.options.candidateDatabase, production.options.sourceDatabase)

    const result = await StorageActivation.activate(production.options)
    expect(result.resumed).toBeTrue()
    expect(marker(production.options.sourceDatabase)).toBe("candidate")

    const local = await setup("local")
    await StorageActivation.prepare(local.options)
    await expect(StorageActivation.activate({ ...local.options, databaseKind: "production" })).rejects.toMatchObject({
      code: "configuration",
    })
    await StorageActivation.activateLocal(local.options)
    expect(marker(local.options.sourceDatabase)).toBe("candidate")
  })

  test("rejects corrupt archive and blob candidates before writing a manifest", async () => {
    const fixture = await setup("production")
    await Bun.write(
      path.join(fixture.options.candidateBlobDirectory, fixture.hash.slice(0, 2), fixture.hash),
      "corrupt",
    )
    await expect(StorageActivation.prepare(fixture.options)).rejects.toMatchObject({ code: "integrity" })
    expect(await Bun.file(fixture.options.manifestPath).exists()).toBeFalse()
  })

  test("rejects foreign-key drift and unsafe manifest-controlled rollback paths", async () => {
    const corrupt = await setup("production")
    const database = new Database(corrupt.options.candidateDatabase, { create: false, strict: true })
    database.exec(`
      PRAGMA foreign_keys=OFF;
      CREATE TABLE activation_parent (id INTEGER PRIMARY KEY);
      CREATE TABLE activation_child (parent_id INTEGER REFERENCES activation_parent(id));
      INSERT INTO activation_child VALUES (42);
    `)
    database.close()
    await expect(StorageActivation.prepare(corrupt.options)).rejects.toMatchObject({ code: "integrity" })

    const unsafe = await setup("production")
    await StorageActivation.prepare(unsafe.options)
    const manifest = await Bun.file(unsafe.options.manifestPath).json()
    manifest.backupDatabase = path.join(unsafe.options.stagingDirectory, "attacker-selected.db")
    await Bun.write(unsafe.options.manifestPath, JSON.stringify(manifest))
    await expect(StorageActivation.activate(unsafe.options)).rejects.toMatchObject({ code: "manifest" })
    expect(marker(unsafe.options.sourceDatabase)).toBe("source")
  })

  test("restores the original when post-swap validation is interrupted", async () => {
    const fixture = await setup("production")
    await StorageActivation.prepare(fixture.options)
    await expect(
      StorageActivation.activate({
        ...fixture.options,
        onProgress: (progress) => {
          if (progress === "candidate-active") throw new globalThis.Error("simulated post-swap interruption")
        },
      }),
    ).rejects.toMatchObject({ code: "recovery" })
    expect(marker(fixture.options.sourceDatabase)).toBe("source")
  })

  test("rejects cryptographically stale and duplicate manifest inventories", async () => {
    const stale = await setup("production")
    await StorageActivation.prepare(stale.options)
    const staleManifest = await Bun.file(stale.options.manifestPath).json()
    staleManifest.source.modifiedAt += 1
    await Bun.write(stale.options.manifestPath, JSON.stringify(staleManifest))
    await expect(StorageActivation.activate(stale.options)).rejects.toMatchObject({ code: "manifest" })

    const duplicate = await setup("production")
    await StorageActivation.prepare(duplicate.options)
    const duplicateManifest = await Bun.file(duplicate.options.manifestPath).json()
    duplicateManifest.blobs.push(duplicateManifest.blobs[0])
    await Bun.write(duplicate.options.manifestPath, JSON.stringify(duplicateManifest))
    await expect(StorageActivation.activate(duplicate.options)).rejects.toMatchObject({ code: "manifest" })
  })

  test("rejects forged and post-completion activation journals", async () => {
    const forged = await setup("production")
    const manifest = await StorageActivation.prepare(forged.options)
    await Bun.write(
      manifest.activationJournal,
      JSON.stringify({ version: 1, kind: "opencode-storage-activation", manifestID: "0".repeat(24), events: [] }),
    )
    await expect(StorageActivation.activate(forged.options)).rejects.toMatchObject({ code: "manifest" })

    const extended = await setup("production")
    const complete = await StorageActivation.prepare(extended.options)
    await Bun.write(
      complete.activationJournal,
      JSON.stringify({
        version: 1,
        kind: "opencode-storage-activation",
        manifestID: complete.id,
        events: [
          ...[
            "validated",
            "retention-written",
            "assets-published",
            "source-moved",
            "candidate-active",
            "completed",
          ].map((state, index) => ({ state, time: index + 1 })),
          { state: "validated", time: 7 },
        ],
      }),
    )
    await expect(StorageActivation.activate(extended.options)).rejects.toMatchObject({ code: "manifest" })
  })

  test("rejects every staging/live and blob/archive root overlap", async () => {
    const stagingLive = await setup("production")
    await expect(
      StorageActivation.prepare({ ...stagingLive.options, liveBlobDirectory: stagingLive.options.stagingDirectory }),
    ).rejects.toMatchObject({ code: "configuration" })

    const nestedStaging = await setup("production")
    await expect(
      StorageActivation.prepare({
        ...nestedStaging.options,
        liveArchiveDirectory: path.dirname(nestedStaging.options.stagingDirectory),
      }),
    ).rejects.toMatchObject({ code: "configuration" })

    const liveOverlap = await setup("production")
    await expect(
      StorageActivation.prepare({
        ...liveOverlap.options,
        liveArchiveDirectory: liveOverlap.options.liveBlobDirectory,
      }),
    ).rejects.toMatchObject({ code: "configuration" })
  })

  test("leaves no activation temp files when targets already appeared", async () => {
    const fixture = await setup("production")
    const manifest = await StorageActivation.prepare(fixture.options)
    await mkdir(path.dirname(manifest.blobs[0]!.target), { recursive: true })
    await Bun.write(manifest.blobs[0]!.target, Bun.file(manifest.blobs[0]!.source))
    await StorageActivation.activate(fixture.options)
    expect(
      (await allFiles(path.dirname(fixture.options.liveBlobDirectory))).filter((file) => file.endsWith(".tmp")),
    ).toEqual([])
    expect((await allFiles(fixture.options.stagingDirectory)).filter((file) => file.endsWith(".tmp"))).toEqual([])
  })
})

async function setup<const Kind extends "production" | "local">(databaseKind: Kind) {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-storage-activation-"))
  roots.push(root)
  const data = path.join(root, "data")
  const staging = path.join(root, "staging")
  const candidateBlobDirectory = path.join(staging, "content")
  const candidateArchiveDirectory = path.join(staging, "archives")
  const liveBlobDirectory = path.join(data, "content")
  const liveArchiveDirectory = path.join(data, "archives")
  await Promise.all([
    mkdir(data, { recursive: true }),
    mkdir(candidateBlobDirectory, { recursive: true }),
    mkdir(candidateArchiveDirectory, { recursive: true }),
  ])
  const sourceDatabase = path.join(data, databaseKind === "production" ? "opencode.db" : "opencode-local.db")
  const candidateDatabase = path.join(staging, "candidate.db")
  writeMarker(sourceDatabase, "source")
  writeMarker(candidateDatabase, "candidate")
  const bytes = new TextEncoder().encode("one managed attachment")
  const hash = createHash("sha256").update(bytes).digest("hex")
  await mkdir(path.join(candidateBlobDirectory, hash.slice(0, 2)), { recursive: true })
  await Bun.write(path.join(candidateBlobDirectory, hash.slice(0, 2), hash), bytes)
  addContent(candidateDatabase, hash, bytes.byteLength)
  const archive = path.join(candidateArchiveDirectory, "archive-0001.sqlite")
  const shard = new Database(archive, { create: true, strict: true })
  shard.exec("CREATE TABLE archive_attachment_ref (blob_sha256 TEXT NOT NULL)")
  shard.query("INSERT INTO archive_attachment_ref VALUES (?)").run(hash)
  shard.close()
  return {
    hash,
    options: {
      databaseKind,
      sourceDatabase,
      candidateDatabase,
      candidateBlobDirectory,
      liveBlobDirectory,
      candidateArchiveDirectory,
      liveArchiveDirectory,
      stagingDirectory: staging,
      manifestPath: path.join(staging, "candidate-manifest.json"),
    },
  }
}

function writeMarker(filename: string, value: string) {
  const database = new Database(filename, { create: true, strict: true })
  database.exec("CREATE TABLE IF NOT EXISTS marker (value TEXT NOT NULL); DELETE FROM marker")
  database.query("INSERT INTO marker VALUES (?)").run(value)
  database.close()
}

function addContent(filename: string, hash: string, size: number) {
  const database = new Database(filename, { create: false, strict: true })
  database.exec(`
    CREATE TABLE content_blob (
      sha256 TEXT PRIMARY KEY,
      size_bytes INTEGER NOT NULL,
      storage_path TEXT NOT NULL
    );
    CREATE TABLE attachment (blob_sha256 TEXT);
  `)
  database.query("INSERT INTO content_blob VALUES (?, ?, ?)").run(hash, size, `content/${hash.slice(0, 2)}/${hash}`)
  database.query("INSERT INTO attachment VALUES (?)").run(hash)
  database.close()
}

function marker(filename: string) {
  const database = new Database(filename, { readonly: true, strict: true })
  const value = database.query<{ readonly value: string }, []>("SELECT value FROM marker").get()?.value
  database.close()
  return value
}

async function allFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  return (
    await Promise.all(
      entries.map((entry) => {
        const filename = path.join(directory, entry.name)
        return entry.isDirectory() ? allFiles(filename) : Promise.resolve([filename])
      }),
    )
  ).flat()
}
