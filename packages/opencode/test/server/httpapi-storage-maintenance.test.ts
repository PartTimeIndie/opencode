import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { StorageCleanup } from "@opencode-ai/core/storage-cleanup"
import { Context, Effect } from "effect"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances } from "../fixture/fixture"

const context = Context.empty() as Context.Context<unknown>

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("storage maintenance HttpApi", () => {
  test("reports storage without mutating it", async () => {
    const response = await HttpApiApp.webHandler().handler(new Request("http://localhost/app/storage/status"), context)

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toEqual(
      expect.objectContaining({
        activeDatabase: expect.objectContaining({ bytes: expect.any(Number), path: expect.any(String) }),
        archives: expect.objectContaining({ bytes: expect.any(Number), shards: expect.any(Number) }),
        blobStore: expect.objectContaining({ bytes: expect.any(Number), blobs: expect.any(Number) }),
        snapshots: expect.objectContaining({
          bytes: expect.any(Number),
          files: expect.any(Number),
          path: expect.any(String),
        }),
        compactionBackups: expect.objectContaining({
          bytes: expect.any(Number),
          files: expect.any(Number),
          path: expect.any(String),
        }),
        sessions: expect.objectContaining({ active: expect.any(Number), archived: expect.any(Number) }),
        retention: { enabled: false, inactivityDays: 21, defaultInactivityDays: 21 },
        cleanup: {
          settings: {
            enabled: true,
            snapshotRetentionDays: 30,
            compactionBackupRetentionDays: 60,
            snapshotMaxBytes: 10 * 1024 * 1024 * 1024,
            checkIntervalHours: 24,
          },
          status: expect.objectContaining({
            enabled: true,
            due: expect.any(Boolean),
            state: expect.stringMatching(/idle|running|failed/),
          }),
        },
        maintenance: expect.objectContaining({
          state: expect.stringMatching(/idle|running|paused|failed/),
          schedulerActive: true,
          runs: expect.any(Number),
          archived: expect.any(Number),
          purged: expect.any(Number),
          failed: expect.any(Number),
          candidateFailures: expect.any(Array),
          backlog: expect.any(Number),
        }),
      }),
    )
  })

  test("enforces startup cleanup scheduling and isolates cleanup failures", async () => {
    const root = await mkdtemp(path.join(Global.Path.data, "storage-cleanup-startup-"))
    const data = path.join(root, "data")
    const state = path.join(root, "state")
    const snapshot = path.join(data, "snapshot")
    await mkdir(snapshot, { recursive: true })
    let now = Date.UTC(2026, 8, 7, 12)
    const cleanup = StorageCleanup.make({
      data,
      state,
      snapshotDirectory: snapshot,
      locks: { held: async () => false, withLock: async (_key, body) => body() },
      now: () => now,
    })
    const settings: StorageCleanup.Settings = {
      enabled: true,
      snapshotRetentionDays: 30,
      compactionBackupRetentionDays: 60,
      snapshotMaxBytes: 10 * 1024 * 1024 * 1024,
      checkIntervalHours: 24,
    }

    try {
      expect((await Effect.runPromise(HttpApiApp.runAutomaticStorageCleanup(cleanup, settings)))?.outcome).toBe(
        "completed",
      )
      now += 24 * 60 * 60 * 1_000 - 1
      expect((await Effect.runPromise(HttpApiApp.runAutomaticStorageCleanup(cleanup, settings)))?.outcome).toBe(
        "not-due",
      )
      now += 1
      expect((await Effect.runPromise(HttpApiApp.runAutomaticStorageCleanup(cleanup, settings)))?.outcome).toBe(
        "completed",
      )
      expect(
        (await Effect.runPromise(HttpApiApp.runAutomaticStorageCleanup(cleanup, { ...settings, enabled: false })))
          ?.outcome,
      ).toBe("disabled")

      const isolated = await Effect.runPromise(
        HttpApiApp.runAutomaticStorageCleanup(
          {
            runIfDue: async () => {
              throw new Error("simulated cleanup failure")
            },
          },
          settings,
        ),
      )
      expect(isolated).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("persists and applies automatic session retention", async () => {
    const before = await HttpApiApp.webHandler().handler(new Request("http://localhost/app/storage/status"), context)
    const original = (await before.json()).retention as { enabled: boolean; inactivityDays: number }

    try {
      const updated = await HttpApiApp.webHandler().handler(
        new Request("http://localhost/app/storage/retention", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: true, inactivityDays: 30 }),
        }),
        context,
      )
      expect(updated.status).toBe(200)
      expect(await updated.json()).toEqual({ enabled: true, inactivityDays: 30, defaultInactivityDays: 21 })

      const status = await HttpApiApp.webHandler().handler(new Request("http://localhost/app/storage/status"), context)
      expect((await status.json()).retention).toEqual({
        enabled: true,
        inactivityDays: 30,
        defaultInactivityDays: 21,
      })

      const invalid = await HttpApiApp.webHandler().handler(
        new Request("http://localhost/app/storage/retention", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: true, inactivityDays: 0 }),
        }),
        context,
      )
      expect(invalid.status).toBe(400)

    } finally {
      await HttpApiApp.webHandler().handler(
        new Request("http://localhost/app/storage/retention", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(original),
        }),
        context,
      )
    }
  })

  test("previews, configures, and explicitly runs cleanup even when automation is disabled", async () => {
    const before = await HttpApiApp.webHandler().handler(new Request("http://localhost/app/storage/status"), context)
    const original = (await before.json()).cleanup.settings as {
      enabled: boolean
      snapshotRetentionDays: number
      compactionBackupRetentionDays: number
      snapshotMaxBytes: number
      checkIntervalHours: number
    }
    const backup = path.join(Global.Path.data, "opencode.db.bak-event-compaction-2026-01-01T00-00-00-000Z")
    await writeFile(backup, "expired compaction backup")
    await utimes(backup, new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T00:00:00.000Z"))

    try {
      const settings = {
        enabled: false,
        snapshotRetentionDays: 30,
        compactionBackupRetentionDays: 1,
        snapshotMaxBytes: 10 * 1024 * 1024 * 1024,
        checkIntervalHours: 24,
      }
      const configured = await HttpApiApp.webHandler().handler(
        new Request("http://localhost/app/storage/cleanup/config", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(settings),
        }),
        context,
      )
      expect(configured.status).toBe(200)
      expect((await configured.json()).settings).toEqual(settings)

      const unreviewed = await HttpApiApp.webHandler().handler(
        new Request("http://localhost/app/storage/cleanup/run", { method: "POST" }),
        context,
      )
      expect(unreviewed.status).toBe(409)
      expect(await Bun.file(backup).exists()).toBe(true)

      const preview = await HttpApiApp.webHandler().handler(
        new Request("http://localhost/app/storage/cleanup/preview"),
        context,
      )
      expect(preview.status).toBe(200)
      const reviewed = (await preview.json()) as { previewToken: string; candidates: unknown[] }
      expect(reviewed.previewToken).toEqual(expect.any(String))
      expect(reviewed.candidates).toContainEqual(
        expect.objectContaining({ kind: "compaction-backup", path: backup, reason: "expired" }),
      )
      expect(await Bun.file(backup).exists()).toBe(true)

      const reconfigured = await HttpApiApp.webHandler().handler(
        new Request("http://localhost/app/storage/cleanup/config", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(settings),
        }),
        context,
      )
      expect(reconfigured.status).toBe(200)
      const stale = await HttpApiApp.webHandler().handler(
        new Request("http://localhost/app/storage/cleanup/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ previewToken: reviewed.previewToken }),
        }),
        context,
      )
      expect(stale.status).toBe(409)
      expect(await Bun.file(backup).exists()).toBe(true)

      const refreshed = await HttpApiApp.webHandler().handler(
        new Request("http://localhost/app/storage/cleanup/preview"),
        context,
      )
      const refreshedPreview = (await refreshed.json()) as { previewToken: string }
      const run = await HttpApiApp.webHandler().handler(
        new Request("http://localhost/app/storage/cleanup/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ previewToken: refreshedPreview.previewToken }),
        }),
        context,
      )
      expect(run.status).toBe(200)
      expect(await run.json()).toEqual(
        expect.objectContaining({
          outcome: "completed",
          automatic: false,
          deleted: expect.arrayContaining([expect.objectContaining({ path: backup })]),
          deletedBytes: Buffer.byteLength("expired compaction backup"),
        }),
      )
      expect(await Bun.file(backup).exists()).toBe(false)

      const reused = await HttpApiApp.webHandler().handler(
        new Request("http://localhost/app/storage/cleanup/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ previewToken: refreshedPreview.previewToken }),
        }),
        context,
      )
      expect(reused.status).toBe(409)

      const invalid = await HttpApiApp.webHandler().handler(
        new Request("http://localhost/app/storage/cleanup/config", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...settings, snapshotRetentionDays: 0 }),
        }),
        context,
      )
      expect(invalid.status).toBe(400)

      const shortInterval = await HttpApiApp.webHandler().handler(
        new Request("http://localhost/app/storage/cleanup/config", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...settings, checkIntervalHours: 23 }),
        }),
        context,
      )
      expect(shortInterval.status).toBe(400)
    } finally {
      await rm(backup, { force: true })
      await HttpApiApp.webHandler().handler(
        new Request("http://localhost/app/storage/cleanup/config", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(original),
        }),
        context,
      )
    }
  })

  test("reports an activated runtime migration as ready with its numeric timestamp intact", async () => {
    const filename = path.join(Global.Path.data, "storage-migration-runtime.json")
    const updatedAt = Date.now() + 1_000
    await writeFile(
      filename,
      JSON.stringify({
        state: "completed",
        updatedAt,
        message: "Storage migration activated successfully",
        resumable: false,
      }),
    )

    try {
      const response = await HttpApiApp.webHandler().handler(
        new Request("http://localhost/app/storage/status"),
        context,
      )

      expect(response.status).toBe(200)
      expect((await response.json()).manifest).toEqual({
        state: "ready",
        updatedAt,
        message: "Storage migration activated successfully",
      })
    } finally {
      await rm(filename, { force: true })
    }
  })

  test("rejects mutating or ambiguous maintenance requests", async () => {
    const integrity = await HttpApiApp.webHandler().handler(
      new Request("http://localhost/app/storage/integrity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "quick", dryRun: false }),
      }),
      context,
    )
    expect(integrity.status).toBe(400)

    const retirement = await HttpApiApp.webHandler().handler(
      new Request("http://localhost/app/storage/backups/retire", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "backup", confirmation: "RETIRE backup" }),
      }),
      context,
    )
    expect(retirement.status).toBe(400)

    const migrationStatus = await HttpApiApp.webHandler().handler(
      new Request("http://localhost/app/storage/migration/status"),
      context,
    )
    expect(migrationStatus.status).toBe(200)
    expect(await migrationStatus.json()).toEqual(
      expect.objectContaining({ state: expect.any(String), databaseKind: "production" }),
    )

    const localMigrationStatus = await HttpApiApp.webHandler().handler(
      new Request("http://localhost/app/storage/migration/status?database=local"),
      context,
    )
    expect(localMigrationStatus.status).toBe(200)
    expect(await localMigrationStatus.json()).toEqual(
      expect.objectContaining({ state: expect.any(String), databaseKind: "local" }),
    )

    const invalidMigrationStatus = await HttpApiApp.webHandler().handler(
      new Request("http://localhost/app/storage/migration/status?database=other"),
      context,
    )
    expect(invalidMigrationStatus.status).toBe(400)

    const migration = await HttpApiApp.webHandler().handler(
      new Request("http://localhost/app/storage/migration/dry-run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ snapshotDirectory: "relative-path" }),
      }),
      context,
    )
    expect(migration.status).toBe(409)
  })
})
