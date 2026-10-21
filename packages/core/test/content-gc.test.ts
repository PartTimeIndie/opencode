import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdir, unlink } from "fs/promises"
import path from "path"
import { ContentGC } from "@opencode-ai/core/content-gc"
import { tmpdir } from "./fixture/tmpdir"

describe("ContentGC", () => {
  test("retains shared active, local, backup, archive, mutation, and rollback-manifest references", async () => {
    await using tmp = await tmpdir()
    const fixture = await makeFixture(tmp.path)
    const shared = await putBlob(fixture.store, "shared")
    const archive = await putBlob(fixture.store, "archive")
    const backup = await putBlob(fixture.store, "backup")
    const manifest = await putBlob(fixture.store, "manifest")
    const mutationBefore = await putBlob(fixture.store, "mutation before")
    const mutationAfter = await putBlob(fixture.store, "mutation after")
    const orphan = await putBlob(fixture.store, "orphan")
    insertAttachment(fixture.active, shared.sha256)
    insertAttachment(fixture.local, shared.sha256)
    insertAttachment(fixture.backup, backup.sha256)
    insertMutation(fixture.active, mutationBefore.sha256, mutationAfter.sha256)
    insertArchiveReference(fixture.archive, archive.sha256)
    await Bun.write(
      fixture.manifest,
      JSON.stringify({ version: 1, kind: "opencode-rollback-retention", retainedBlobs: [manifest.sha256] }),
    )

    const dryRun = await planFixture(fixture)
    expect(dryRun.candidates).toEqual([orphan])
    expect(dryRun.reachableBlobs).toBe(6)
    expect(dryRun.sources).toEqual({ databases: 3, archiveShards: 1, rollbackManifests: 1 })
    expect(dryRun.safety).toEqual({
      completeSourceInventory: true,
      offlineRequired: true,
      sqliteWriterLocks: true,
      reachabilityRecheckedBeforeEachDelete: true,
    })
    const validations: string[] = []
    const result = await ContentGC.collect(fixture.input, dryRun.digest, {
      offline: true,
      inventory: fixture.inventory,
      onInventoryValidation: (mode) => {
        validations.push(mode)
      },
    })

    expect(result).toMatchObject({ completed: true, resumed: false, deleted: [orphan.sha256] })
    expect(validations).toEqual(["strong", "light", "light"])
    expect(await Bun.file(orphan.path).exists()).toBe(false)
    for (const retained of [shared, archive, backup, manifest, mutationBefore, mutationAfter])
      expect(await Bun.file(retained.path).exists()).toBe(true)
    const journal = await Bun.file(result.journal).json()
    expect(journal.events.map((event: { state: string }) => event.state)).toEqual(["requested", "deleted", "completed"])
  })

  test("requires the exact digest and blocks a new reference added after planning", async () => {
    await using tmp = await tmpdir()
    const fixture = await makeFixture(tmp.path)
    const orphan = await putBlob(fixture.store, "toctou")
    const dryRun = await planFixture(fixture)

    expect(
      await rejection(
        ContentGC.collect(fixture.input, "0".repeat(64), { offline: true, inventory: fixture.inventory }),
      ),
    ).toMatchObject({
      code: "digest",
    })
    expect(await Bun.file(orphan.path).exists()).toBe(true)
    insertAttachment(fixture.active, orphan.sha256)
    expect(
      await rejection(ContentGC.collect(fixture.input, dryRun.digest, { offline: true, inventory: fixture.inventory })),
    ).toMatchObject({
      code: "digest",
    })
    expect(await Bun.file(orphan.path).exists()).toBe(true)
    expect(await Bun.file(path.join(fixture.journals, `content-gc-${dryRun.digest}.json`)).exists()).toBe(false)

    const callbackFixture = await makeFixture(path.join(tmp.path, "requested-rescan"))
    const callbackOrphan = await putBlob(callbackFixture.store, "requested callback")
    const callbackPlan = await planFixture(callbackFixture)
    expect(
      await rejection(
        ContentGC.collect(callbackFixture.input, callbackPlan.digest, {
          offline: true,
          inventory: callbackFixture.inventory,
          async onProgress(progress) {
            if (progress.state !== "requested") return
            await Bun.write(
              callbackFixture.manifest,
              JSON.stringify({
                version: 1,
                kind: "opencode-rollback-retention",
                retainedBlobs: [callbackOrphan.sha256],
              }),
            )
          },
        }),
      ),
    ).toMatchObject({ code: "digest" })
    expect(await Bun.file(callbackOrphan.path).exists()).toBe(true)
  })

  test("refuses collection from a partial or unconfirmed explicit source inventory", async () => {
    await using tmp = await tmpdir()
    const fixture = await makeFixture(tmp.path)
    const orphan = await putBlob(fixture.store, "inventory gate orphan")
    const partial = {
      ...fixture.input,
      databases: fixture.input.databases.filter((source) => source.kind === "active"),
      archiveShards: [],
      rollbackManifests: [],
    }
    await refreshInventory(fixture)
    const diagnostic = await ContentGC.plan(partial)

    expect(diagnostic.safety.completeSourceInventory).toBe(false)
    expect(
      await rejection(ContentGC.collect(partial, diagnostic.digest, { offline: true, inventory: fixture.inventory })),
    ).toMatchObject({ code: "configuration", message: expect.stringContaining("do not exactly match") })
    expect(
      await rejection(
        ContentGC.collect(fixture.input, diagnostic.digest, { offline: true } as ContentGC.CollectOptions),
      ),
    ).toMatchObject({ code: "configuration", message: expect.stringContaining("complete source inventory") })
    expect(await Bun.file(orphan.path).exists()).toBe(true)
  })

  test("fails closed when authoritative backup, archive, or rollback roots gain or lose a source", async () => {
    await using tmp = await tmpdir()
    for (const kind of ["backup", "archive", "manifest"] as const) {
      const added = await makeFixture(path.join(tmp.path, `added-${kind}`))
      const addedOrphan = await putBlob(added.store, `added ${kind} orphan`)
      const addedPlan = await planFixture(added)
      if (kind === "backup")
        createReferenceDatabase(path.join(added.backupRoot, `opencode.db.opencode-rollback-${"1".repeat(24)}`))
      if (kind === "archive") createArchiveDatabase(path.join(added.archiveRoot, "new.sqlite"))
      if (kind === "manifest")
        await Bun.write(
          path.join(added.rollbackRoot, `rollback-retention-${"1".repeat(24)}.json`),
          JSON.stringify({ version: 1, kind: "opencode-rollback-retention", retainedBlobs: [] }),
        )
      expect(
        await rejection(
          ContentGC.collect(added.input, addedPlan.digest, { offline: true, inventory: added.inventory }),
        ),
      ).toMatchObject({ code: "digest" })
      expect(await Bun.file(addedOrphan.path).exists()).toBe(true)

      const missing = await makeFixture(path.join(tmp.path, `missing-${kind}`))
      const missingOrphan = await putBlob(missing.store, `missing ${kind} orphan`)
      const missingPlan = await planFixture(missing)
      await unlink(kind === "backup" ? missing.backup : kind === "archive" ? missing.archive : missing.manifest)
      expect(
        await rejection(
          ContentGC.collect(missing.input, missingPlan.digest, { offline: true, inventory: missing.inventory }),
        ),
      ).toMatchObject({ code: "configuration" })
      expect(await Bun.file(missingOrphan.path).exists()).toBe(true)
    }
  })

  test("rechecks reachability before every delete and preserves a newly referenced later candidate", async () => {
    await using tmp = await tmpdir()
    const fixture = await makeFixture(tmp.path)
    const first = await putBlob(fixture.store, "per-candidate first")
    const second = await putBlob(fixture.store, "per-candidate second")
    const dryRun = await planFixture(fixture)
    let deleted: string | undefined
    let retained: typeof first | undefined

    expect(
      await rejection(
        ContentGC.collect(fixture.input, dryRun.digest, {
          offline: true,
          inventory: fixture.inventory,
          async onProgress(progress) {
            if (progress.state !== "deleted" || deleted) return
            deleted = progress.sha256
            retained = [first, second].find((blob) => blob.sha256 !== progress.sha256)
            await Bun.write(
              fixture.manifest,
              JSON.stringify({
                version: 1,
                kind: "opencode-rollback-retention",
                retainedBlobs: [retained!.sha256],
              }),
            )
          },
        }),
      ),
    ).toMatchObject({ code: "digest" })
    expect(deleted).toBeDefined()
    expect(await Bun.file([first, second].find((blob) => blob.sha256 === deleted)!.path).exists()).toBe(false)
    expect(await Bun.file(retained!.path).exists()).toBe(true)
    const journal = await Bun.file(path.join(fixture.journals, `content-gc-${dryRun.digest}.json`)).json()
    expect(journal.events.filter((event: { state: string }) => event.state === "deleted")).toHaveLength(1)
    expect(journal.events.some((event: { state: string }) => event.state === "completed")).toBe(false)
  })

  test("holds SQLite writer locks for the complete destructive pass", async () => {
    await using tmp = await tmpdir()
    const fixture = await makeFixture(tmp.path)
    const orphan = await putBlob(fixture.store, "writer lock candidate")
    const dryRun = await planFixture(fixture)
    let writerBlocked = false
    let competingCollector: unknown

    const result = await ContentGC.collect(fixture.input, dryRun.digest, {
      offline: true,
      inventory: fixture.inventory,
      async onProgress(progress) {
        if (progress.state !== "requested") return
        competingCollector = await rejection(
          ContentGC.collect(fixture.input, dryRun.digest, { offline: true, inventory: fixture.inventory }),
        )
        const database = new Database(fixture.active, { strict: true })
        try {
          database.query("INSERT INTO attachment(blob_sha256) VALUES (?)").run(orphan.sha256)
        } catch {
          writerBlocked = true
        } finally {
          database.close(false)
        }
      },
    })

    expect(writerBlocked).toBe(true)
    expect(competingCollector).toMatchObject({ code: "configuration" })
    expect(result.deleted).toEqual([orphan.sha256])
    expect(await Bun.file(orphan.path).exists()).toBe(false)
  })

  test("resumes after interruption without deleting a candidate twice", async () => {
    await using tmp = await tmpdir()
    const fixture = await makeFixture(tmp.path)
    const first = await putBlob(fixture.store, "first orphan")
    const second = await putBlob(fixture.store, "second orphan")
    const dryRun = await planFixture(fixture)
    let deleted = 0

    expect(
      await rejection(
        ContentGC.collect(fixture.input, dryRun.digest, {
          offline: true,
          inventory: fixture.inventory,
          onProgress(progress) {
            if (progress.state !== "deleted") return
            deleted++
            if (deleted === 1) throw new globalThis.Error("simulated crash")
          },
        }),
      ),
    ).toMatchObject({ message: "simulated crash" })
    const firstExists = await Bun.file(first.path).exists()
    const secondExists = await Bun.file(second.path).exists()
    const remainingPath = firstExists ? first.path : second.path
    expect([firstExists, secondExists].filter(Boolean)).toHaveLength(1)
    await unlink(remainingPath)

    const resumed = await ContentGC.collect(fixture.input, dryRun.digest, {
      offline: true,
      inventory: fixture.inventory,
    })
    expect(resumed).toMatchObject({ completed: true, resumed: true })
    expect(resumed.deleted).toEqual([first.sha256, second.sha256].sort())
    expect(await Bun.file(first.path).exists()).toBe(false)
    expect(await Bun.file(second.path).exists()).toBe(false)
    const journal = await Bun.file(resumed.journal).json()
    expect(journal.events.filter((event: { state: string }) => event.state === "deleted")).toHaveLength(2)
    expect(journal.events.some((event: { recovered?: boolean }) => event.recovered === true)).toBe(true)
    expect(journal.events.at(-1)).toMatchObject({ state: "completed" })
  })

  test("fails closed for corrupt databases, manifests, blob paths, hashes, and journals", async () => {
    await using tmp = await tmpdir()
    const corruptDatabaseFixture = await makeFixture(path.join(tmp.path, "corrupt-db"))
    await Bun.write(corruptDatabaseFixture.active, "not sqlite")
    expect(await rejection(ContentGC.plan(corruptDatabaseFixture.input))).toMatchObject({ code: "database" })

    const corruptManifestFixture = await makeFixture(path.join(tmp.path, "corrupt-manifest"))
    await Bun.write(corruptManifestFixture.manifest, "not json")
    expect(await rejection(ContentGC.plan(corruptManifestFixture.input))).toMatchObject({ code: "manifest" })

    const corruptPathFixture = await makeFixture(path.join(tmp.path, "corrupt-path"))
    await mkdir(path.join(corruptPathFixture.store, "zz"))
    expect(await rejection(ContentGC.plan(corruptPathFixture.input))).toMatchObject({ code: "integrity" })

    const corruptBlobFixture = await makeFixture(path.join(tmp.path, "corrupt-blob"))
    const falseHash = "a".repeat(64)
    const falsePath = path.join(corruptBlobFixture.store, falseHash.slice(0, 2), falseHash)
    await mkdir(path.dirname(falsePath), { recursive: true })
    await Bun.write(falsePath, "wrong bytes")
    expect(await rejection(ContentGC.plan(corruptBlobFixture.input))).toMatchObject({ code: "integrity" })

    const corruptHashFixture = await makeFixture(path.join(tmp.path, "corrupt-hash"))
    insertAttachment(corruptHashFixture.active, "invalid")
    expect(await rejection(ContentGC.plan(corruptHashFixture.input))).toMatchObject({ code: "integrity" })

    const corruptJournalFixture = await makeFixture(path.join(tmp.path, "corrupt-journal"))
    const orphan = await putBlob(corruptJournalFixture.store, "journal orphan")
    const dryRun = await planFixture(corruptJournalFixture)
    await Bun.write(path.join(corruptJournalFixture.journals, `content-gc-${dryRun.digest}.json`), "not json")
    expect(
      await rejection(
        ContentGC.collect(corruptJournalFixture.input, dryRun.digest, {
          offline: true,
          inventory: corruptJournalFixture.inventory,
        }),
      ),
    ).toMatchObject({ code: "journal" })
    expect(await Bun.file(orphan.path).exists()).toBe(true)
  })
})

async function makeFixture(root: string) {
  const store = path.join(root, "content")
  const journals = path.join(root, "journals")
  const backupRoot = path.join(root, "backups")
  const archiveRoot = path.join(root, "archives")
  const rollbackRoot = path.join(root, "rollback")
  await Promise.all(
    [store, journals, backupRoot, archiveRoot, rollbackRoot].map((directory) => mkdir(directory, { recursive: true })),
  )
  const active = path.join(root, "active.sqlite")
  const local = path.join(root, "local.sqlite")
  const backup = path.join(backupRoot, `opencode.db.opencode-rollback-${"0".repeat(24)}`)
  const archive = path.join(archiveRoot, "archive.sqlite")
  const manifest = path.join(rollbackRoot, `rollback-retention-${"0".repeat(24)}.json`)
  const inventory = path.join(root, "content-gc-inventory.json")
  for (const filename of [active, local, backup]) createReferenceDatabase(filename)
  createArchiveDatabase(archive)
  await Bun.write(manifest, JSON.stringify({ version: 1, kind: "opencode-rollback-retention", retainedBlobs: [] }))
  const input = {
    storeDirectory: store,
    journalDirectory: journals,
    databases: [
      { kind: "active" as const, path: active },
      { kind: "local" as const, path: local },
      { kind: "backup" as const, path: backup },
    ],
    archiveShards: [archive],
    rollbackManifests: [manifest],
  }
  await Bun.write(
    inventory,
    JSON.stringify(
      await ContentGC.createSourceInventory(input, {
        backupDirectories: [backupRoot],
        archiveDirectories: [archiveRoot],
        rollbackManifestDirectories: [rollbackRoot],
        confirmNoBackups: false,
        confirmNoArchives: false,
        confirmNoRollbackManifests: false,
        confirmNoActiveDatabase: false,
        confirmNoLocalDatabase: false,
      }),
    ),
  )
  return {
    store,
    journals,
    active,
    local,
    backup,
    archive,
    manifest,
    backupRoot,
    archiveRoot,
    rollbackRoot,
    inventory,
    input,
  }
}

async function planFixture(fixture: Awaited<ReturnType<typeof makeFixture>>) {
  await refreshInventory(fixture)
  return ContentGC.plan(fixture.input, { inventory: fixture.inventory })
}

async function refreshInventory(fixture: Awaited<ReturnType<typeof makeFixture>>) {
  await Bun.write(
    fixture.inventory,
    JSON.stringify(
      await ContentGC.createSourceInventory(fixture.input, {
        backupDirectories: [fixture.backupRoot],
        archiveDirectories: [fixture.archiveRoot],
        rollbackManifestDirectories: [fixture.rollbackRoot],
        confirmNoBackups: false,
        confirmNoArchives: false,
        confirmNoRollbackManifests: false,
        confirmNoActiveDatabase: false,
        confirmNoLocalDatabase: false,
      }),
    ),
  )
}

function createReferenceDatabase(filename: string) {
  const database = new Database(filename, { create: true, strict: true })
  database.run("CREATE TABLE attachment (blob_sha256 TEXT)")
  database.run("CREATE TABLE session_file_mutation (before_sha256 TEXT, after_sha256 TEXT)")
  database.close(false)
}

function createArchiveDatabase(filename: string) {
  const database = new Database(filename, { create: true, strict: true })
  database.run("CREATE TABLE archive_attachment_ref (blob_sha256 TEXT NOT NULL)")
  database.close(false)
}

function insertAttachment(filename: string, sha256: string) {
  const database = new Database(filename, { strict: true })
  database.query("INSERT INTO attachment(blob_sha256) VALUES (?)").run(sha256)
  database.close(false)
}

function insertMutation(filename: string, before: string, after: string) {
  const database = new Database(filename, { strict: true })
  database.query("INSERT INTO session_file_mutation(before_sha256, after_sha256) VALUES (?, ?)").run(before, after)
  database.close(false)
}

function insertArchiveReference(filename: string, sha256: string) {
  const database = new Database(filename, { strict: true })
  database.query("INSERT INTO archive_attachment_ref(blob_sha256) VALUES (?)").run(sha256)
  database.close(false)
}

async function putBlob(store: string, content: string) {
  const bytes = Buffer.from(content)
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
  const filename = path.join(store, sha256.slice(0, 2), sha256)
  await mkdir(path.dirname(filename), { recursive: true })
  await Bun.write(filename, bytes)
  return { sha256, path: await real(filename), sizeBytes: bytes.byteLength }
}

async function real(filename: string) {
  return Bun.file(filename)
    .exists()
    .then((exists) => {
      if (!exists) throw new globalThis.Error(`Missing fixture ${filename}`)
      return path.resolve(filename)
    })
}

async function rejection(input: Promise<unknown>) {
  try {
    await input
  } catch (error) {
    return error
  }
  throw new globalThis.Error("Expected promise to reject")
}
