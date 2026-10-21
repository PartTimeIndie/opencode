import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { collectStorageGC, createStorageGCInventory, planStorageGC } from "../../src/cli/cmd/storage"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => remove(root)))
}, 20_000)

describe("storage gc CLI", () => {
  test("uses only repeated explicit sources and emits a JSON-safe plan", async () => {
    const fixture = await createFixture()
    const plan = await planStorageGC({
      store: fixture.store,
      journal: fixture.journal,
      inventory: fixture.inventory,
      database: [`active:${fixture.database}`],
      archive: [fixture.archive],
      rollbackManifest: [fixture.manifest],
    })

    expect(plan.sources).toEqual({ databases: 1, archiveShards: 1, rollbackManifests: 1 })
    expect(plan.candidates).toEqual([
      { sha256: fixture.sha256, path: fixture.blob, sizeBytes: fixture.bytes.byteLength },
    ])
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan)
  })

  test("collects only the exact plan after explicit offline confirmation", async () => {
    const fixture = await createFixture()
    const input = {
      store: fixture.store,
      journal: fixture.journal,
      inventory: fixture.inventory,
      database: [`active:${fixture.database}`],
      archive: [fixture.archive],
      rollbackManifest: [fixture.manifest],
    }
    const plan = await planStorageGC(input)
    const progress: string[] = []
    const result = await collectStorageGC({ ...input, digest: plan.digest, offline: true }, (event) => {
      progress.push(event.state)
    })

    expect(result).toMatchObject({ digest: plan.digest, deleted: [fixture.sha256], completed: true })
    expect(progress).toEqual(["requested", "deleted", "completed"])
    expect(await Bun.file(fixture.blob).exists()).toBe(false)
  })

  test("rejects missing sources, malformed database kinds, digest changes, and absent offline confirmation", async () => {
    const fixture = await createFixture()
    expect(
      await rejection(planStorageGC({ store: fixture.store, journal: fixture.journal, inventory: fixture.inventory })),
    ).toMatchObject({
      message: expect.stringContaining("at least one explicit --database, --archive, or --rollback-manifest"),
    })
    expect(
      await rejection(
        planStorageGC({
          store: fixture.store,
          journal: fixture.journal,
          inventory: fixture.inventory,
          database: [`production:${fixture.database}`],
        }),
      ),
    ).toMatchObject({ message: expect.stringContaining("expected active, local, or backup") })

    const input = {
      store: fixture.store,
      journal: fixture.journal,
      inventory: fixture.inventory,
      database: [`active:${fixture.database}`],
      archive: [fixture.archive],
      rollbackManifest: [fixture.manifest],
    }
    const plan = await planStorageGC(input)
    expect(await rejection(collectStorageGC({ ...input, digest: plan.digest, offline: false }))).toMatchObject({
      message: expect.stringContaining("requires --offline"),
    })
    expect(await rejection(collectStorageGC({ ...input, digest: "A".repeat(64), offline: true }))).toMatchObject({
      message: expect.stringContaining("exact 64-character lowercase SHA-256 digest"),
    })
    expect(
      await rejection(
        createStorageGCInventory({
          store: fixture.store,
          journal: fixture.journal,
          output: path.join(fixture.root, "rejected.json"),
          database: [`active:${fixture.database}`],
          complete: false,
          noBackups: true,
          noArchives: true,
          noRollbackManifests: true,
          noLocalDatabase: true,
        }),
      ),
    ).toMatchObject({ message: expect.stringContaining("requires --complete") })
    expect(
      await rejection(
        createStorageGCInventory({
          store: fixture.store,
          journal: fixture.journal,
          output: path.join(fixture.root, "only-active.json"),
          database: [`active:${fixture.database}`],
          complete: true,
          noBackups: true,
          noArchives: true,
          noRollbackManifests: true,
        }),
      ),
    ).toMatchObject({ message: expect.stringContaining("--no-local-database") })
    expect(
      await rejection(
        createStorageGCInventory({
          store: fixture.store,
          journal: fixture.journal,
          output: path.join(fixture.root, "only-local.json"),
          database: [`local:${fixture.database}`],
          complete: true,
          noBackups: true,
          noArchives: true,
          noRollbackManifests: true,
        }),
      ),
    ).toMatchObject({ message: expect.stringContaining("--no-active-database") })

    const partial = await createStorageGCInventory({
      store: fixture.store,
      journal: fixture.journal,
      output: path.join(fixture.root, "partial.json"),
      database: [`active:${fixture.database}`],
      complete: true,
      noBackups: true,
      noArchives: true,
      noRollbackManifests: true,
      noLocalDatabase: true,
    })
    const partialPath = path.join(fixture.root, "partial.json")
    await Bun.write(partialPath, JSON.stringify(partial))
    expect(await rejection(planStorageGC({ ...input, inventory: partialPath }))).toMatchObject({
      message: expect.stringContaining("do not exactly match"),
    })
  })
})

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-storage-gc-cli-"))
  roots.push(root)
  const store = path.join(root, "content")
  const journal = path.join(root, "journal")
  const database = path.join(root, "active.db")
  const archiveRoot = path.join(root, "archives")
  const rollbackRoot = path.join(root, "rollback")
  const archive = path.join(archiveRoot, "archive.db")
  const manifest = path.join(rollbackRoot, "rollback-retention-000000000000000000000000.json")
  const inventory = path.join(root, "inventory.json")
  await Promise.all([mkdir(store), mkdir(journal), mkdir(archiveRoot), mkdir(rollbackRoot)])
  new Database(database).close(false)
  const archiveDatabase = new Database(archive)
  archiveDatabase.run("CREATE TABLE archive_blob_ref (blob_sha256 TEXT NOT NULL)")
  archiveDatabase.close(false)
  await Bun.write(manifest, JSON.stringify({ version: 1, kind: "opencode-rollback-retention", retainedBlobs: [] }))
  await Bun.write(
    inventory,
    JSON.stringify(
      await createStorageGCInventory({
        store,
        journal,
        output: inventory,
        database: [`active:${database}`],
        archive: [archive],
        rollbackManifest: [manifest],
        complete: true,
        noBackups: true,
        archiveRoot: [archiveRoot],
        rollbackManifestRoot: [rollbackRoot],
        noArchives: false,
        noRollbackManifests: false,
        noLocalDatabase: true,
      }),
    ),
  )
  const bytes = new TextEncoder().encode("explicit CLI fixture")
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  await mkdir(path.join(store, sha256.slice(0, 2)))
  const blob = path.join(store, sha256.slice(0, 2), sha256)
  await Bun.write(blob, bytes)
  return { root, store, journal, database, archive, manifest, inventory, bytes, sha256, blob }
}

async function remove(root: string, retries = 30): Promise<void> {
  try {
    await rm(root, { recursive: true, force: true })
  } catch (error) {
    if (retries === 0 || !error || typeof error !== "object" || !("code" in error) || error.code !== "EBUSY")
      throw error
    Bun.gc(true)
    await Bun.sleep(100)
    return remove(root, retries - 1)
  }
}

async function rejection(input: Promise<unknown>) {
  return input.then(
    () => {
      throw new Error("Expected promise to reject")
    },
    (error: unknown) => error,
  )
}
