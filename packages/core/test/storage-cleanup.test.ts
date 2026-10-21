import { afterEach, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { ConfigStorageCleanup } from "../src/config/storage-cleanup"
import { eventCompactionLockKey } from "../src/event-compaction"
import { SnapshotActivity } from "../src/snapshot-activity"
import { StorageCleanup } from "../src/storage-cleanup"

const DAY_MS = 24 * 60 * 60 * 1_000
const roots: string[] = []

const unlocked: StorageCleanup.LockManager = {
  held: async () => false,
  withLock: async (_key, body) => body(),
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("StorageCleanup", () => {
  test("inventories both snapshot layouts and only expires validated old repositories", async () => {
    const fixture = await temporaryFixture()
    const old = fixture.now - 40 * DAY_MS
    const recent = fixture.now - 2 * DAY_MS
    const legacy = path.join(fixture.snapshot, "a".repeat(40))
    const project = path.join(fixture.snapshot, "b".repeat(40))
    const nested = path.join(project, "c".repeat(40))
    const active = path.join(fixture.snapshot, "d".repeat(40), "e".repeat(40))
    await snapshotRepository(legacy, 11, old)
    await snapshotRepository(nested, 13, old, false)
    await snapshotRepository(active, 17, recent)
    await mkdir(path.join(fixture.snapshot, "f".repeat(40)), { recursive: true })
    await mkdir(path.join(project, `corrupt-${"1".repeat(40)}`), { recursive: true })
    await writeFile(path.join(fixture.snapshot, "manual-note.txt"), "keep")

    const preview = await fixture.cleanup.preview(settings({ snapshotMaxBytes: 1_000_000 }))

    expect(preview.snapshots.repositories).toBe(3)
    expect(preview.snapshots.emptyContainers).toBe(1)
    expect(preview.candidates.map((candidate) => candidate.path).sort()).toEqual([legacy, nested].sort())
    expect(preview.candidates.every((candidate) => candidate.reason === "expired")).toBe(true)
    expect(preview.unknown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: path.join(fixture.snapshot, "manual-note.txt") }),
        expect.objectContaining({ path: path.join(project, `corrupt-${"1".repeat(40)}`) }),
      ]),
    )
    expect(await Bun.file(path.join(fixture.snapshot, "manual-note.txt")).exists()).toBe(true)
  })

  test("enforces the snapshot byte limit by selecting the oldest retained repositories", async () => {
    const fixture = await temporaryFixture()
    const first = path.join(fixture.snapshot, "1".repeat(40))
    const second = path.join(fixture.snapshot, "2".repeat(40))
    const third = path.join(fixture.snapshot, "3".repeat(40))
    await snapshotRepository(first, 40, fixture.now - 3 * DAY_MS)
    await snapshotRepository(second, 50, fixture.now - 2 * DAY_MS)
    await snapshotRepository(third, 60, fixture.now - DAY_MS)
    const baseline = await fixture.cleanup.preview(settings({ snapshotMaxBytes: Number.MAX_SAFE_INTEGER }))
    const sizes = new Map(baseline.candidates.map((candidate) => [candidate.path, candidate.bytes]))
    const repositories = await repositorySizes(fixture.snapshot)
    const max = repositories.get(third)!

    const preview = await fixture.cleanup.preview(settings({ snapshotMaxBytes: max }))

    expect(preview.candidates.map((candidate) => candidate.path)).toEqual([first, second])
    expect(preview.candidates.every((candidate) => candidate.reason === "size-limit")).toBe(true)
    expect(preview.snapshots.bytes - preview.reclaimableBytes).toBeLessThanOrEqual(max)
    expect(sizes.size).toBe(0)
  })

  test("deletes reviewed old snapshots while preserving recent, locked, corrupt, and manual entries", async () => {
    const fixture = await temporaryFixture()
    const old = fixture.now - 40 * DAY_MS
    const recent = fixture.now - DAY_MS
    const project = path.join(fixture.snapshot, "4".repeat(40))
    const expired = path.join(project, "5".repeat(40))
    const active = path.join(fixture.snapshot, "6".repeat(40))
    const locked = path.join(fixture.snapshot, "7".repeat(40))
    const manual = path.join(fixture.snapshot, "keep-me")
    await snapshotRepository(expired, 20, old)
    await snapshotRepository(active, 20, recent)
    await snapshotRepository(locked, 20, old)
    await writeFile(manual, "manual")
    const locks: StorageCleanup.LockManager = {
      held: async (key) => key === locked,
      withLock: async (_key, body) => body(),
    }
    const cleanup = StorageCleanup.make({
      data: fixture.data,
      state: fixture.state,
      snapshotDirectory: fixture.snapshot,
      locks,
      now: () => fixture.now,
    })

    const reviewed = await cleanup.preview(settings())
    const result = await cleanup.runNow(settings(), reviewed.previewToken)

    expect(result.outcome).toBe("completed")
    expect(result.deleted.map((candidate) => candidate.path)).toEqual([expired])
    expect(result.removedEmptyContainers).toBe(1)
    expect(await pathExists(expired)).toBe(false)
    expect(await pathExists(project)).toBe(false)
    expect(await pathExists(active)).toBe(true)
    expect(await pathExists(locked)).toBe(true)
    expect(await pathExists(manual)).toBe(true)
    expect(result.inventory?.locked).toContainEqual({ path: locked, reason: "repository-lock" })
  })

  test("revalidates snapshot activity after acquiring the repository lock", async () => {
    const fixture = await temporaryFixture()
    const repository = path.join(fixture.snapshot, "8".repeat(40))
    await snapshotRepository(repository, 30, fixture.now - 40 * DAY_MS)
    const locks: StorageCleanup.LockManager = {
      held: async () => false,
      withLock: async (key, body) => {
        if (key === repository) await SnapshotActivity.record(repository, fixture.now)
        return body()
      },
    }
    const cleanup = StorageCleanup.make({
      data: fixture.data,
      state: fixture.state,
      snapshotDirectory: fixture.snapshot,
      locks,
      now: () => fixture.now,
    })

    const reviewed = await cleanup.preview(settings())
    const result = await cleanup.runNow(settings(), reviewed.previewToken)

    expect(result.deleted).toHaveLength(0)
    expect(result.skipped).toEqual([{ path: repository, reason: "snapshot changed after review" }])
    expect(await pathExists(repository)).toBe(true)
  })

  test("revalidates the total snapshot budget before deleting a size-limit candidate", async () => {
    const fixture = await temporaryFixture()
    const first = path.join(fixture.snapshot, "1".repeat(40))
    const second = path.join(fixture.snapshot, "2".repeat(40))
    const third = path.join(fixture.snapshot, "3".repeat(40))
    const fourth = path.join(fixture.snapshot, "4".repeat(40))
    await snapshotRepository(first, 30, fixture.now - 4 * DAY_MS)
    await snapshotRepository(second, 30, fixture.now - 3 * DAY_MS)
    await snapshotRepository(third, 30, fixture.now - 2 * DAY_MS)
    await snapshotRepository(fourth, 30, fixture.now - DAY_MS)
    const sizes = await repositorySizes(fixture.snapshot)
    const snapshotMaxBytes = sizes.get(second)! + sizes.get(fourth)!
    const locks: StorageCleanup.LockManager = {
      held: async () => false,
      withLock: async (key, body) => {
        if (key === second) await rm(third, { recursive: true })
        return body()
      },
    }
    const cleanup = StorageCleanup.make({
      data: fixture.data,
      state: fixture.state,
      snapshotDirectory: fixture.snapshot,
      locks,
      now: () => fixture.now,
    })

    const configured = settings({ snapshotMaxBytes })
    const reviewed = await cleanup.preview(configured)
    const result = await cleanup.runNow(configured, reviewed.previewToken)

    expect(result.deleted.map((candidate) => candidate.path)).toEqual([first])
    expect(result.skipped).toContainEqual({ path: second, reason: "snapshot changed after review" })
    expect(await pathExists(second)).toBe(true)
    expect(await pathExists(fourth)).toBe(true)
    expect((await repositorySizes(fixture.snapshot)).values().reduce((total, bytes) => total + bytes, 0)).toBe(
      snapshotMaxBytes,
    )
  })

  test("deletes only exact expired compaction backups and protects checkpoint references", async () => {
    const fixture = await temporaryFixture()
    const old = fixture.now - 70 * DAY_MS
    const expired = path.join(fixture.data, "opencode.db.bak-event-compaction-2026-01-01T00-00-00-000Z")
    const protectedBackup = path.join(fixture.data, "opencode.db.bak-event-compaction-2026-01-02T00-00-00-000Z")
    const source = path.join(fixture.data, "opencode.db")
    const candidate = `${source}.event-compaction-candidate`
    const output = `${source}.event-compaction-output`
    const checkpoint = `${source}.event-compaction.json`
    const manual = path.join(fixture.data, "opencode.db.bak-manual")
    const malformed = path.join(fixture.data, "opencode.db.bak-event-compaction-handwritten")
    const unknownSidecar = `${expired}-journal`
    const orphanSidecar = path.join(
      fixture.data,
      "opencode.db.bak-event-compaction-2026-01-03T00-00-00-000Z-shm",
    )
    await writeFile(source, "active")
    await writeFile(candidate, "candidate")
    await writeFile(output, "output")
    await writeFile(expired, "expired")
    await writeFile(`${expired}-wal`, "wal")
    await writeFile(protectedBackup, "protected")
    await writeFile(manual, "manual")
    await writeFile(malformed, "unknown")
    await writeFile(unknownSidecar, "unknown sidecar")
    await writeFile(orphanSidecar, "orphan sidecar")
    await writeFile(
      checkpoint,
      JSON.stringify({ version: 1, source, candidate, output, backup: protectedBackup, phase: "switch" }),
    )
    await setFileTime(expired, old)
    await setFileTime(`${expired}-wal`, old)
    await setFileTime(protectedBackup, old)
    await setFileTime(unknownSidecar, old)

    const preview = await fixture.cleanup.preview(settings())
    expect(preview.compactionBackups).toMatchObject({ files: 2, protected: 1 })
    expect(preview.candidates).toContainEqual(expect.objectContaining({ path: expired, kind: "compaction-backup" }))
    expect(preview.candidates.some((item) => item.path === protectedBackup)).toBe(false)
    expect(preview.unknown).toContainEqual(expect.objectContaining({ path: malformed }))
    expect(preview.unknown).toContainEqual(expect.objectContaining({ path: unknownSidecar }))
    expect(preview.unknown).toContainEqual(expect.objectContaining({ path: orphanSidecar }))

    const result = await fixture.cleanup.runNow(settings(), preview.previewToken)

    expect(result.deleted).toContainEqual(expect.objectContaining({ path: expired, kind: "compaction-backup" }))
    expect(await Bun.file(expired).exists()).toBe(false)
    expect(await Bun.file(`${expired}-wal`).exists()).toBe(false)
    for (const filename of [
      protectedBackup,
      source,
      candidate,
      output,
      checkpoint,
      manual,
      malformed,
      unknownSidecar,
      orphanSidecar,
    ])
      expect(await Bun.file(filename).exists()).toBe(true)
  })

  test("shares the compaction lock and revalidates checkpoints immediately before backup deletion", async () => {
    const fixture = await temporaryFixture()
    const old = fixture.now - 70 * DAY_MS
    const source = path.join(fixture.data, "opencode.db")
    const backup = path.join(fixture.data, "opencode.db.bak-event-compaction-2026-01-03T00-00-00-000Z")
    const checkpoint = path.join(fixture.data, "opencode.db.event-compaction.json")
    await writeFile(backup, "backup")
    await setFileTime(backup, old)
    const acquired: string[] = []
    const locks: StorageCleanup.LockManager = {
      held: async () => false,
      withLock: async (key, body) => {
        acquired.push(key)
        if (key === eventCompactionLockKey(source)) {
          await writeFile(
            checkpoint,
            JSON.stringify({
              version: 1,
              source,
              candidate: `${source}.event-compaction-candidate.db`,
              output: `${source}.event-compaction-output.db`,
              backup,
              phase: "switch",
            }),
          )
        }
        return body()
      },
    }
    const cleanup = StorageCleanup.make({
      data: fixture.data,
      state: fixture.state,
      snapshotDirectory: fixture.snapshot,
      locks,
      now: () => fixture.now,
    })

    const reviewed = await cleanup.preview(settings())
    const result = await cleanup.runNow(settings(), reviewed.previewToken)

    expect(result.deleted.some((item) => item.path === backup)).toBe(false)
    expect(result.skipped).toContainEqual({
      path: backup,
      reason: "compaction backup changed or became protected",
    })
    expect(acquired).toContain(eventCompactionLockKey(source))
    expect(await Bun.file(backup).exists()).toBe(true)
    expect(await Bun.file(checkpoint).exists()).toBe(true)
  })

  test("preserves completed backups when their source has an unreadable compaction checkpoint", async () => {
    const fixture = await temporaryFixture()
    const source = path.join(fixture.data, "opencode.db")
    const backup = path.join(fixture.data, "opencode.db.bak-event-compaction-2026-01-03T00-00-00-000Z")
    const checkpoint = `${source}.event-compaction.json`
    await writeFile(backup, "backup")
    await writeFile(checkpoint, "{")
    await setFileTime(backup, fixture.now - 70 * DAY_MS)

    const reviewed = await fixture.cleanup.preview(settings())

    expect(reviewed.compactionBackups).toMatchObject({ files: 1, protected: 1 })
    expect(reviewed.candidates.some((candidate) => candidate.path === backup)).toBe(false)
    expect(reviewed.unknown).toContainEqual({ path: checkpoint, reason: "event-compaction checkpoint is invalid" })
    const result = await fixture.cleanup.runNow(settings(), reviewed.previewToken)
    expect(result.deleted).toHaveLength(0)
    expect(await Bun.file(backup).exists()).toBe(true)
  })

  test("treats non-file and source-mismatched compaction checkpoints as invalid and protects their sources", async () => {
    const fixture = await temporaryFixture()
    const directorySource = path.join(fixture.data, "directory.db")
    const directoryBackup = path.join(
      fixture.data,
      "directory.db.bak-event-compaction-2026-01-03T00-00-00-000Z",
    )
    const directoryCheckpoint = `${directorySource}.event-compaction.json`
    const mismatchedSource = path.join(fixture.data, "mismatched.db")
    const referencedBackup = path.join(
      fixture.data,
      "mismatched.db.bak-event-compaction-2026-01-04T00-00-00-000Z",
    )
    const siblingBackup = path.join(
      fixture.data,
      "mismatched.db.bak-event-compaction-2026-01-05T00-00-00-000Z",
    )
    const mismatchedCheckpoint = `${mismatchedSource}.event-compaction.json`
    await writeFile(directoryBackup, "directory backup")
    await mkdir(directoryCheckpoint)
    await writeFile(referencedBackup, "referenced backup")
    await writeFile(siblingBackup, "sibling backup")
    await writeFile(
      mismatchedCheckpoint,
      JSON.stringify({
        version: 1,
        source: path.join(fixture.data, "other.db"),
        candidate: path.join(fixture.data, "other-candidate.db"),
        output: path.join(fixture.data, "other-output.db"),
        backup: referencedBackup,
        phase: "switch",
      }),
    )
    await Promise.all(
      [directoryBackup, referencedBackup, siblingBackup].map((filename) =>
        setFileTime(filename, fixture.now - 70 * DAY_MS),
      ),
    )

    const reviewed = await fixture.cleanup.preview(settings())

    expect(reviewed.compactionBackups).toMatchObject({ files: 3, protected: 3 })
    expect(reviewed.candidates).toHaveLength(0)
    expect(reviewed.unknown).toEqual(
      expect.arrayContaining([
        { path: directoryCheckpoint, reason: "event-compaction checkpoint is invalid" },
        { path: mismatchedCheckpoint, reason: "event-compaction checkpoint is invalid" },
      ]),
    )
    const result = await fixture.cleanup.runNow(settings(), reviewed.previewToken)
    expect(result.deleted).toHaveLength(0)
    for (const backup of [directoryBackup, referencedBackup, siblingBackup]) expect(await pathExists(backup)).toBe(true)
  })

  test("manual cleanup requires one current preview and never expands beyond its reviewed candidates", async () => {
    const fixture = await temporaryFixture()
    const configured = settings()
    const first = path.join(fixture.snapshot, "a".repeat(40))
    const addedAfterPreview = path.join(fixture.snapshot, "b".repeat(40))
    await snapshotRepository(first, 30, fixture.now - 40 * DAY_MS)

    await expect(fixture.cleanup.runNow(configured, "not-a-preview")).rejects.toThrow("current storage cleanup preview")
    const stale = await fixture.cleanup.preview(configured)
    await expect(
      fixture.cleanup.runNow(settings({ snapshotRetentionDays: 31 }), stale.previewToken),
    ).rejects.toThrow("current storage cleanup preview")
    expect(await pathExists(first)).toBe(true)

    const reviewed = await fixture.cleanup.preview(configured)
    await snapshotRepository(addedAfterPreview, 30, fixture.now - 40 * DAY_MS)
    const result = await fixture.cleanup.runNow(configured, reviewed.previewToken)

    expect(result.deleted.map((candidate) => candidate.path)).toEqual([first])
    expect(await pathExists(first)).toBe(false)
    expect(await pathExists(addedAfterPreview)).toBe(true)
    await expect(fixture.cleanup.runNow(configured, reviewed.previewToken)).rejects.toThrow(
      "current storage cleanup preview",
    )
  })

  test("invalidates an existing preview as soon as a replacement preview begins", async () => {
    const fixture = await temporaryFixture()
    const repository = path.join(fixture.snapshot, "7".repeat(40))
    await snapshotRepository(repository, 30, fixture.now - 40 * DAY_MS)
    let blockReplacement = false
    let notifyEntered!: () => void
    let releaseReplacement!: () => void
    const entered = new Promise<void>((resolve) => {
      notifyEntered = resolve
    })
    const released = new Promise<void>((resolve) => {
      releaseReplacement = resolve
    })
    const cleanup = StorageCleanup.make({
      data: fixture.data,
      state: fixture.state,
      snapshotDirectory: fixture.snapshot,
      locks: {
        held: async (key) => {
          if (blockReplacement && key === repository) {
            blockReplacement = false
            notifyEntered()
            await released
          }
          return false
        },
        withLock: async (_key, body) => body(),
      },
      now: () => fixture.now,
    })
    const first = await cleanup.preview(settings())
    blockReplacement = true
    const replacement = cleanup.preview(settings())
    await entered
    const oldAttempt = cleanup.runNow(settings(), first.previewToken).then(
      () => undefined,
      (error: unknown) => error,
    )
    releaseReplacement()
    await replacement

    expect(await oldAttempt).toBeInstanceOf(StorageCleanup.PreviewRequiredError)
    expect(await pathExists(repository)).toBe(true)
  })

  test("reports nested Git operation locks and preserves the repository", async () => {
    const fixture = await temporaryFixture()
    const repository = path.join(fixture.snapshot, "c".repeat(40))
    await snapshotRepository(repository, 30, fixture.now - 40 * DAY_MS)
    const refLock = path.join(repository, "refs", "heads", "main.lock")
    await mkdir(path.dirname(refLock), { recursive: true })
    await writeFile(refLock, "locked")
    await setTreeTime(repository, fixture.now - 40 * DAY_MS)

    const preview = await fixture.cleanup.preview(settings())

    expect(preview.candidates).toHaveLength(0)
    expect(preview.locked).toContainEqual({ path: repository, reason: "git-lock" })
    expect(await pathExists(repository)).toBe(true)
  })

  test("disabled automatic cleanup remains inspectable and manual cleanup still works", async () => {
    const fixture = await temporaryFixture()
    const repository = path.join(fixture.snapshot, "9".repeat(40))
    await snapshotRepository(repository, 30, fixture.now - 40 * DAY_MS)
    const disabled = settings({ enabled: false })

    const preview = await fixture.cleanup.preview(disabled)
    expect(preview.candidates).toHaveLength(1)
    expect((await fixture.cleanup.status(disabled)).due).toBe(false)
    expect((await fixture.cleanup.runIfDue(disabled)).outcome).toBe("disabled")
    expect(await pathExists(repository)).toBe(true)

    expect((await fixture.cleanup.runNow(disabled, preview.previewToken)).deleted).toHaveLength(1)
    expect(await pathExists(repository)).toBe(false)
  })

  test("serializes concurrent automatic checks and records a successful run only once per interval", async () => {
    const fixture = await temporaryFixture(serialLock())
    const repository = path.join(fixture.snapshot, "0".repeat(40))
    await snapshotRepository(repository, 30, fixture.now - 40 * DAY_MS)

    const results = await Promise.all([fixture.cleanup.runIfDue(settings()), fixture.cleanup.runIfDue(settings())])

    expect(results.map((result) => result.outcome).sort()).toEqual(["completed", "not-due"])
    expect(results.reduce((count, result) => count + result.deleted.length, 0)).toBe(1)
    const status = await fixture.cleanup.status(settings())
    expect(status.state).toBe("idle")
    expect(status.due).toBe(false)
    expect(status.lastSucceededAt).toBe(fixture.now)
    expect(JSON.parse(await readFile(status.statusPath, "utf8"))).toMatchObject({ version: 1, state: "idle" })
  })

  test("normalizes the global cleanup lock key for case-insensitive Windows paths", async () => {
    const fixture = await temporaryFixture()
    const keys: string[] = []
    const locks: StorageCleanup.LockManager = {
      held: async () => false,
      withLock: async (key, body) => {
        keys.push(key)
        return body()
      },
    }
    const aliases = process.platform === "win32" ? [fixture.data, fixture.data.toUpperCase()] : [fixture.data]

    for (const data of aliases) {
      const cleanup = StorageCleanup.make({
        data,
        state: fixture.state,
        snapshotDirectory: fixture.snapshot,
        locks,
        now: () => fixture.now,
      })
      expect((await cleanup.runIfDue(settings({ enabled: false }))).outcome).toBe("disabled")
    }

    expect(new Set(keys)).toEqual(new Set([`storage-cleanup:${normalizeExpectedPath(fixture.data)}`]))
  })

  test("runs automatic cleanup no more than once per configured 24-hour interval", async () => {
    const fixture = await temporaryFixture()
    let now = fixture.now
    const cleanup = StorageCleanup.make({
      data: fixture.data,
      state: fixture.state,
      snapshotDirectory: fixture.snapshot,
      locks: unlocked,
      now: () => now,
    })

    const unsafeShortInterval = settings({ checkIntervalHours: 1 })
    expect((await cleanup.runIfDue(unsafeShortInterval)).outcome).toBe("completed")
    now += DAY_MS - 1
    expect((await cleanup.runIfDue(unsafeShortInterval)).outcome).toBe("not-due")
    now += 1
    expect((await cleanup.runIfDue(unsafeShortInterval)).outcome).toBe("completed")
    expect((await cleanup.status(unsafeShortInterval)).lastSucceededAt).toBe(now)
  })

  test.each([
    ["not-due", true],
    ["disabled", false],
  ] as const)("normalizes an interrupted run before returning %s", async (outcome, enabled) => {
    const fixture = await temporaryFixture()
    const configured = settings({ enabled })
    const statusPath = (await fixture.cleanup.status(configured)).statusPath
    await mkdir(path.dirname(statusPath), { recursive: true })
    await writeFile(
      statusPath,
      JSON.stringify({
        version: 1,
        state: "running",
        lastAttemptAt: fixture.now - DAY_MS,
        lastSucceededAt: fixture.now,
      }),
    )

    expect((await fixture.cleanup.runIfDue(configured)).outcome).toBe(outcome)
    expect(await fixture.cleanup.status(configured)).toMatchObject({
      state: "failed",
      due: false,
      lastAttemptAt: fixture.now - DAY_MS,
      lastSucceededAt: fixture.now,
      lastFailedAt: fixture.now,
      lastFailure: "Previous storage cleanup was interrupted before completion.",
    })
  })

  test("records failed runs without delaying the next automatic attempt", async () => {
    const fixture = await temporaryFixture()
    let calls = 0
    const cleanup = StorageCleanup.make({
      data: fixture.data,
      state: fixture.state,
      snapshotDirectory: fixture.snapshot,
      locks: unlocked,
      now: () => {
        calls++
        if (calls === 2) throw new Error("clock failed")
        return fixture.now
      },
    })

    await expect(cleanup.runIfDue(settings())).rejects.toThrow("clock failed")

    const status = await cleanup.status(settings())
    expect(status).toMatchObject({
      state: "failed",
      due: true,
      lastAttemptAt: fixture.now,
      lastFailedAt: fixture.now,
      lastFailure: "clock failed",
    })
    expect(status.lastSucceededAt).toBeUndefined()
  })

  test("serializes automatic cleanup across processes with EffectFlock", async () => {
    const fixture = await temporaryFixture()
    const repository = path.join(fixture.snapshot, "b".repeat(40))
    await snapshotRepository(repository, 30, fixture.now - 40 * DAY_MS)
    const go = path.join(fixture.root, "go")
    const messages = [0, 1].map((index) => ({
      root: fixture.root,
      data: fixture.data,
      state: fixture.state,
      snapshot: fixture.snapshot,
      locks: path.join(fixture.root, "locks"),
      now: fixture.now,
      settings: settings(),
      ready: path.join(fixture.root, `ready-${index}`),
      go,
      result: path.join(fixture.root, `result-${index}.json`),
    }))
    const workers = messages.map(startCleanupWorker)

    try {
      await Promise.all(messages.map((message) => waitForPath(message.ready)))
      await writeFile(go, "go")
      const exits = await Promise.all(workers.map((worker) => worker.completed))
      expect(exits.map((exit) => exit.code)).toEqual([0, 0])
      expect(exits.map((exit) => exit.stderr).filter(Boolean)).toEqual([])
      const results = await Promise.all(
        messages.map(async (message) => JSON.parse(await readFile(message.result, "utf8")) as StorageCleanup.RunResult),
      )
      expect(results.map((result) => result.outcome).sort()).toEqual(["completed", "not-due"])
      expect(results.reduce((total, result) => total + result.deleted.length, 0)).toBe(1)
      expect(await pathExists(repository)).toBe(false)
    } finally {
      workers.forEach((worker) => {
        if (worker.process.exitCode === null) worker.process.kill()
      })
    }
  }, 30_000)
})

function settings(overrides: Partial<StorageCleanup.Settings> = {}): StorageCleanup.Settings {
  return { ...ConfigStorageCleanup.resolve(), ...overrides }
}

async function temporaryFixture(locks: StorageCleanup.LockManager = unlocked) {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-storage-cleanup-"))
  roots.push(root)
  const data = path.join(root, "data")
  const state = path.join(root, "state")
  const snapshot = path.join(data, "snapshot")
  await mkdir(snapshot, { recursive: true })
  const now = Date.UTC(2026, 8, 7, 12)
  return {
    root,
    data,
    state,
    snapshot,
    now,
    cleanup: StorageCleanup.make({ data, state, snapshotDirectory: snapshot, locks, now: () => now }),
  }
}

async function snapshotRepository(directory: string, payloadBytes: number, modifiedAt: number, bare = true) {
  await mkdir(path.join(directory, "objects"), { recursive: true })
  await mkdir(path.join(directory, "refs"), { recursive: true })
  await writeFile(path.join(directory, "HEAD"), "ref: refs/heads/master\n")
  await writeFile(
    path.join(directory, "config"),
    `[core]\n\tbare = ${bare}\n${bare ? "" : `\tworktree = ${path.dirname(directory).replaceAll("\\", "/")}\n`}`,
  )
  await writeFile(path.join(directory, "objects", "payload"), "x".repeat(payloadBytes))
  await SnapshotActivity.record(directory, modifiedAt)
  await setTreeTime(directory, modifiedAt)
}

async function setTreeTime(directory: string, modifiedAt: number) {
  const date = new Date(modifiedAt)
  const entries = await readdir(directory, { withFileTypes: true })
  await Promise.all(
    entries.map(async (entry) => {
      const filename = path.join(directory, entry.name)
      if (entry.isDirectory()) await setTreeTime(filename, modifiedAt)
      await utimes(filename, date, date)
    }),
  )
  await utimes(directory, date, date)
}

async function setFileTime(filename: string, modifiedAt: number) {
  const date = new Date(modifiedAt)
  await utimes(filename, date, date)
}

async function repositorySizes(root: string) {
  const result = new Map<string, number>()
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const repository = path.join(root, entry.name)
    const total = await directoryBytes(repository)
    result.set(repository, total)
  }
  return result
}

async function directoryBytes(directory: string): Promise<number> {
  return (
    await Promise.all(
      (await readdir(directory, { withFileTypes: true })).map(async (entry) => {
        const filename = path.join(directory, entry.name)
        return entry.isDirectory() ? directoryBytes(filename) : (await stat(filename)).size
      }),
    )
  ).reduce((total, bytes) => total + bytes, 0)
}

function pathExists(filename: string) {
  return stat(filename)
    .then(() => true)
    .catch(() => false)
}

function normalizeExpectedPath(filename: string) {
  const resolved = path.resolve(filename)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

function serialLock(): StorageCleanup.LockManager {
  const tails = new Map<string, Promise<void>>()
  return {
    held: async () => false,
    withLock: async (key, body) => {
      const previous = tails.get(key) ?? Promise.resolve()
      let release: () => void = () => undefined
      const current = new Promise<void>((resolve) => {
        release = resolve
      })
      const tail = previous.then(() => current)
      tails.set(key, tail)
      await previous
      try {
        return await body()
      } finally {
        release()
        if (tails.get(key) === tail) tails.delete(key)
      }
    },
  }
}

type CleanupWorkerMessage = {
  readonly root: string
  readonly data: string
  readonly state: string
  readonly snapshot: string
  readonly locks: string
  readonly now: number
  readonly settings: StorageCleanup.Settings
  readonly ready: string
  readonly go: string
  readonly result: string
}

function startCleanupWorker(message: CleanupWorkerMessage) {
  const worker = path.join(import.meta.dir, "fixture", "storage-cleanup-worker.ts")
  const child = spawn(process.execPath, [worker, JSON.stringify(message)], {
    cwd: path.join(import.meta.dir, ".."),
    stdio: ["ignore", "pipe", "pipe"],
  })
  const completed = new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout?.on("data", (chunk) => stdout.push(Buffer.from(chunk)))
    child.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)))
    child.on("error", reject)
    child.on("close", (code) =>
      resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }),
    )
  })
  return { process: child, completed }
}

async function waitForPath(filename: string, timeout = 5_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await pathExists(filename)) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for ${filename}`)
}
