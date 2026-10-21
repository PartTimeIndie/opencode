import { describe, expect, test } from "bun:test"
import {
  backupRetirementConfirmation,
  createStorageSettingsApi,
  createStorageSettingsModel,
  isAbsoluteSnapshotDirectory,
  migrationAction,
  storageRequestTimeout,
  storagePresentation,
  type StorageFetch,
  type StorageSettingsApi,
  type StorageStatus,
} from "./storage-model"

const status: StorageStatus = {
  activeDatabase: { bytes: 1_000, path: "active.db" },
  archives: { bytes: 2_000, path: "archives", shards: 2 },
  blobStore: { bytes: 3_000, path: "content", blobs: 12 },
  localDatabase: { bytes: 4_000, path: "local.db" },
  snapshots: { bytes: 5_000, path: "snapshot", files: 14 },
  compactionBackups: { bytes: 6_000, path: "data", files: 2 },
  backups: [
    {
      id: "prod-20260713",
      bytes: 6_570_000_000,
      modifiedAt: 1_783_938_600_000,
      retireAfter: 1_785_148_200_000,
      retirementEligible: true,
      path: "old.db",
    },
  ],
  sessions: { active: 9, archived: 21 },
  retention: { enabled: false, inactivityDays: 21, defaultInactivityDays: 21 },
  cleanup: {
    settings: {
      enabled: true,
      snapshotRetentionDays: 30,
      compactionBackupRetentionDays: 60,
      snapshotMaxBytes: 10 * 1024 * 1024 * 1024,
      checkIntervalHours: 24,
    },
    status: {
      version: 1,
      state: "idle",
      enabled: true,
      due: false,
      nextRunAt: 1_786_000_000_000,
      statusPath: "storage-cleanup-status.json",
    },
  },
  deduplication: { attachments: 31, uniqueBlobs: 12, savedBytes: 5_000 },
  manifest: { state: "ready", updatedAt: "2026-07-13T10:00:00.000Z" },
  maintenance: {
    state: "idle",
    backlog: 4,
    oldestEligibleAt: 1_783_900_000_000,
    deferredReason: "batch-limit",
  },
}

function deferred<T>() {
  const result = {} as { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
  result.promise = new Promise<T>((resolve, reject) => {
    result.resolve = resolve
    result.reject = reject
  })
  return result
}

function api(overrides: Partial<StorageSettingsApi> = {}): StorageSettingsApi {
  return {
    status: async () => status,
    previewCleanup: async () => ({
      previewToken: "preview-default",
      generatedAt: 1_783_938_600_000,
      snapshots: { path: "snapshot", repositories: 2, bytes: 5_000, emptyContainers: 0 },
      compactionBackups: { files: 2, bytes: 6_000, protected: 1 },
      candidates: [],
      reclaimableBytes: 0,
      unknown: [],
      locked: [],
    }),
    updateCleanup: async (settings) => ({ ...status.cleanup, settings }),
    runCleanup: async () => ({
      outcome: "completed",
      automatic: false,
      startedAt: 1_783_938_600_000,
      completedAt: 1_783_938_601_000,
      deleted: [],
      deletedBytes: 0,
      removedEmptyContainers: 0,
      skipped: [],
    }),
    migrationStatus: async (databaseKind) => ({ state: "idle", databaseKind }),
    runMigrationDryRun: async (input) => ({ state: "running", databaseKind: input.databaseKind, id: "migration-run" }),
    runIntegrity: async ({ mode }) => ({ id: `run-${mode}`, mode, state: "queued" }),
    updateRetention: async (input) => ({ ...input, defaultInactivityDays: 21 }),
    retireBackup: async () => undefined,
    ...overrides,
  }
}

describe("storage settings model", () => {
  test("exposes a first-load state and resolves to status", async () => {
    const request = deferred<StorageStatus>()
    const model = createStorageSettingsModel(api({ status: () => request.promise }))
    const load = model.load()

    expect(model.snapshot().loading).toBe(true)
    expect(storagePresentation(model.snapshot(), 900).content).toBe("loading")
    request.resolve(status)
    await load

    expect(model.snapshot().loading).toBe(false)
    expect(model.snapshot().status).toBe(status)
    expect(model.snapshot().status?.maintenance).toMatchObject({
      backlog: 4,
      oldestEligibleAt: 1_783_900_000_000,
      deferredReason: "batch-limit",
    })
    expect(storagePresentation(model.snapshot(), 900).content).toBe("status")
  })

  test("reports an initial error and allows a successful retry", async () => {
    let calls = 0
    const model = createStorageSettingsModel(
      api({
        status: async () => {
          if (calls++ === 0) throw new Error("database unavailable")
          return status
        },
      }),
    )

    await model.load()
    expect(model.snapshot().error).toBe("database unavailable")
    expect(storagePresentation(model.snapshot(), 900).content).toBe("error")
    await model.refresh()
    expect(model.snapshot().status).toBe(status)
    expect(model.snapshot().error).toBeUndefined()
  })

  test("keeps existing status visible while refreshing", async () => {
    const request = deferred<StorageStatus>()
    let calls = 0
    const model = createStorageSettingsModel(
      api({ status: () => (calls++ === 0 ? Promise.resolve(status) : request.promise) }),
    )
    await model.load()
    const refresh = model.refresh()

    expect(model.snapshot().refreshing).toBe(true)
    expect(model.snapshot().status).toBe(status)
    expect(storagePresentation(model.snapshot(), 900).content).toBe("status")
    request.resolve({ ...status, sessions: { active: 10, archived: 22 } })
    await refresh
    expect(model.snapshot().status?.sessions).toEqual({ active: 10, archived: 22 })
  })

  test("runs quick and full integrity checks as dry-runs", async () => {
    const inputs: unknown[] = []
    const model = createStorageSettingsModel(
      api({
        runIntegrity: async (input) => {
          inputs.push(input)
          return { id: `run-${input.mode}`, mode: input.mode, state: "completed" }
        },
      }),
    )
    await model.load()
    await model.runIntegrity("quick")
    await model.runIntegrity("full")

    expect(inputs).toEqual([
      { mode: "quick", dryRun: true },
      { mode: "full", dryRun: true },
    ])
    expect(model.snapshot().integrity).toEqual({ id: "run-full", mode: "full", state: "completed" })
  })

  test("loads and presents a completed offline migration dry-run report", async () => {
    const migration = {
      state: "completed",
      databaseKind: "production",
      id: "migration-1",
      stagingDirectory: "C:\\OpenCode\\staging",
      snapshotDirectory: "D:\\OpenCode\\snapshot",
      updatedAt: 1_783_938_600_000,
      report: {
        sourceBytes: 6_570_000_000,
        candidateBytes: 1_570_000_000,
        savedBytes: 5_000_000_000,
        archivedSessions: 82,
        checkpointedSessions: 90,
        quarantineCount: 0,
      },
    } as const
    const model = createStorageSettingsModel(api({ migrationStatus: async () => migration }))

    await model.load()

    expect(model.snapshot().migration).toEqual(migration)
    expect(model.snapshot().migrationLoading).toBe(false)
    expect(migrationAction(model.snapshot().migration)).toBe("start")
  })

  test("only starts or resumes a dry-run with an optional absolute snapshot directory", async () => {
    const inputs: Array<{ databaseKind: "production" | "local"; snapshotDirectory?: string }> = []
    const model = createStorageSettingsModel(
      api({
        migrationStatus: async (databaseKind) => ({ state: "failed", databaseKind, message: "worker interrupted" }),
        runMigrationDryRun: async (input) => {
          inputs.push(input)
          return {
            state: "running",
            databaseKind: input.databaseKind,
            id: "migration-resumed",
            snapshotDirectory: input.snapshotDirectory,
          }
        },
      }),
    )
    await model.load()
    expect(migrationAction(model.snapshot().migration)).toBe("resume")

    model.setSnapshotDirectory("snapshots\\migration")
    await model.runMigrationDryRun()
    expect(inputs).toEqual([])
    expect(model.snapshot().snapshotDirectoryInvalid).toBe(true)
    expect(storagePresentation(model.snapshot(), 900).migrationDisabled).toBe(true)

    model.setSnapshotDirectory("  D:\\OpenCode-Snapshots  ")
    await model.runMigrationDryRun()
    expect(inputs).toEqual([{ databaseKind: "production", snapshotDirectory: "D:\\OpenCode-Snapshots" }])
    expect(model.snapshot().migration?.state).toBe("running")
    expect(migrationAction(model.snapshot().migration)).toBe("running")
  })

  test("loads and starts production and local database dry-runs independently", async () => {
    const statusKinds: string[] = []
    const starts: unknown[] = []
    const model = createStorageSettingsModel(
      api({
        migrationStatus: async (databaseKind) => {
          statusKinds.push(databaseKind)
          return { state: "idle", databaseKind }
        },
        runMigrationDryRun: async (input) => {
          starts.push(input)
          return { state: "running", databaseKind: input.databaseKind }
        },
      }),
    )

    await model.load()
    await model.setMigrationDatabase("local")
    await model.runMigrationDryRun()

    expect(statusKinds).toEqual(["production", "local"])
    expect(model.snapshot().selectedMigrationDatabase).toBe("local")
    expect(starts).toEqual([{ databaseKind: "local" }])
    expect(model.snapshot().migration).toMatchObject({ state: "running", databaseKind: "local" })
  })

  test("accepts managed, Windows, UNC, and POSIX snapshot locations but rejects relative paths", () => {
    expect(isAbsoluteSnapshotDirectory(" ")).toBe(true)
    expect(isAbsoluteSnapshotDirectory("C:\\snapshots")).toBe(true)
    expect(isAbsoluteSnapshotDirectory("\\\\server\\share\\snapshots")).toBe(true)
    expect(isAbsoluteSnapshotDirectory("/var/lib/opencode-snapshots")).toBe(true)
    expect(isAbsoluteSnapshotDirectory("C:snapshots")).toBe(false)
    expect(isAbsoluteSnapshotDirectory("snapshots/migration")).toBe(false)
  })

  test("validates and persists automatic session retention", async () => {
    const updates: unknown[] = []
    const model = createStorageSettingsModel(
      api({
        updateRetention: async (input) => {
          updates.push(input)
          return { ...input, defaultInactivityDays: 21 }
        },
      }),
    )
    await model.load()

    await model.updateRetention({ enabled: true, inactivityDays: 0 })
    expect(updates).toEqual([])
    expect(model.snapshot().retentionError).toContain("between 1 and 3650")

    await model.updateRetention({ enabled: false, inactivityDays: 30 })
    expect(updates).toEqual([{ enabled: false, inactivityDays: 30 }])
    expect(model.snapshot().status?.retention).toEqual({
      enabled: false,
      inactivityDays: 30,
      defaultInactivityDays: 21,
    })
  })

  test("requires a fresh preview before manual cleanup and clears it after configuration changes", async () => {
    const updates: unknown[] = []
    const runs: string[] = []
    const preview = {
      previewToken: "preview-current-settings",
      generatedAt: 1_783_938_600_000,
      snapshots: { path: "snapshot", repositories: 2, bytes: 5_000, emptyContainers: 0 },
      compactionBackups: { files: 2, bytes: 6_000, protected: 1 },
      candidates: [
        {
          kind: "snapshot" as const,
          path: "snapshot/repository",
          bytes: 4_000,
          modifiedAt: 1_780_000_000_000,
          reason: "expired" as const,
        },
      ],
      reclaimableBytes: 4_000,
      unknown: [],
      locked: [],
    }
    const model = createStorageSettingsModel(
      api({
        previewCleanup: async () => preview,
        updateCleanup: async (settings) => {
          updates.push(settings)
          return { ...status.cleanup, settings }
        },
        runCleanup: async (previewToken) => {
          runs.push(previewToken)
          return {
            outcome: "completed",
            automatic: false,
            startedAt: preview.generatedAt,
            completedAt: preview.generatedAt + 1,
            inventory: preview,
            deleted: preview.candidates,
            deletedBytes: preview.reclaimableBytes,
            removedEmptyContainers: 0,
            skipped: [],
          }
        },
      }),
    )
    await model.load()

    await model.runCleanup()
    expect(runs).toEqual([])
    expect(model.snapshot().cleanupError).toContain("Preview")

    await model.previewCleanup()
    expect(model.snapshot().cleanupPreview).toEqual(preview)
    expect(storagePresentation(model.snapshot(), 900).cleanupRunDisabled).toBe(false)
    expect(storagePresentation(model.snapshot(), 900, { cleanupDraftDirty: true })).toMatchObject({
      cleanupPreviewDisabled: true,
      cleanupRunDisabled: true,
    })

    await model.runCleanup()
    expect(runs).toEqual([preview.previewToken])
    expect(model.snapshot().cleanupResult?.deletedBytes).toBe(4_000)
    expect(model.snapshot().cleanupPreview).toBeUndefined()

    const changed = { ...status.cleanup.settings, enabled: false, snapshotRetentionDays: 45 }
    await model.updateCleanup(changed)
    expect(updates).toEqual([changed])
    expect(model.snapshot().status?.cleanup.settings).toEqual(changed)
    expect(model.snapshot().cleanupPreview).toBeUndefined()

    await model.updateCleanup({ ...changed, snapshotMaxBytes: 0 })
    expect(updates).toEqual([changed])
    expect(model.snapshot().cleanupError).toContain("positive whole numbers")

    await model.updateCleanup({ ...changed, checkIntervalHours: 23 })
    expect(updates).toEqual([changed])
    expect(model.snapshot().cleanupError).toContain("at least 24 hours")
  })

  test("invalidates a consumed preview after a failed cleanup run", async () => {
    const model = createStorageSettingsModel(
      api({
        runCleanup: async () => {
          throw new Error("preview expired")
        },
      }),
    )
    await model.load()
    await model.previewCleanup()

    await model.runCleanup()

    expect(model.snapshot().cleanupError).toContain("preview expired")
    expect(model.snapshot().cleanupPreview).toBeUndefined()
    expect(storagePresentation(model.snapshot(), 900).cleanupRunDisabled).toBe(true)
  })

  test("invalidates the previous preview before replacement preview and configuration requests", async () => {
    let previewCalls = 0
    const pendingPreview = deferred<never>()
    const pendingConfig = deferred<never>()
    const model = createStorageSettingsModel(
      api({
        previewCleanup: async () => {
          const call = previewCalls++
          if (call === 1) return pendingPreview.promise
          return api().previewCleanup()
        },
        updateCleanup: async () => pendingConfig.promise,
      }),
    )
    await model.load()
    await model.previewCleanup()
    expect(model.snapshot().cleanupPreview).toBeDefined()

    const preview = model.previewCleanup()
    expect(model.snapshot().cleanupPreview).toBeUndefined()
    pendingPreview.reject(new Error("replacement preview failed"))
    await preview
    expect(model.snapshot().cleanupPreview).toBeUndefined()

    await model.previewCleanup()
    expect(model.snapshot().cleanupPreview).toBeDefined()
    const config = model.updateCleanup(status.cleanup.settings)
    expect(model.snapshot().cleanupPreview).toBeUndefined()
    pendingConfig.reject(new Error("configuration response failed"))
    await config
    expect(model.snapshot().cleanupPreview).toBeUndefined()
  })

  test("requires and forwards the exact backup bytes and modifiedAt before retirement", async () => {
    const retired: unknown[] = []
    let loads = 0
    const model = createStorageSettingsModel(
      api({
        status: async () => {
          loads++
          return status
        },
        retireBackup: async (input) => {
          retired.push(input)
        },
      }),
    )
    await model.load()
    model.setSelectedBackup(status.backups[0]!.id)
    model.setConfirmation("RETIRE prod-20260713")
    await model.retireBackup()
    expect(retired).toHaveLength(0)
    expect(model.snapshot().retirementError).toContain("exactly match")

    model.setConfirmation(backupRetirementConfirmation(status.backups[0]!))
    await model.retireBackup()
    expect(retired).toEqual([
      {
        id: "prod-20260713",
        confirmation: "RETIRE prod-20260713 6570000000 1783938600000",
        reviewed: { bytes: 6_570_000_000, modifiedAt: 1_783_938_600_000 },
      },
    ])
    expect(loads).toBe(2)
  })

  test("blocks retirement while the rollback retention window is active", async () => {
    const retired: unknown[] = []
    const retained = { ...status.backups[0]!, retirementEligible: false }
    const model = createStorageSettingsModel(
      api({
        status: async () => ({ ...status, backups: [retained] }),
        retireBackup: async (input) => {
          retired.push(input)
        },
      }),
    )
    await model.load()
    model.setSelectedBackup(retained.id)
    model.setConfirmation(backupRetirementConfirmation(retained))
    await model.retireBackup()

    expect(retired).toEqual([])
    expect(model.snapshot().retirementError).toContain(new Date(retained.retireAfter).toISOString())
    expect(storagePresentation(model.snapshot(), 900).retirementDisabled).toBe(true)
  })

  test("switches responsive semantics at the settings breakpoint", () => {
    const state = createStorageSettingsModel(api()).snapshot()
    expect(storagePresentation(state, 639).layout).toBe("stacked")
    expect(storagePresentation(state, 640).layout).toBe("grid")
  })
})

describe("storage settings fetch adapter", () => {
  test("keeps routine requests short while allowing cleanup inventory and deletion to finish", () => {
    expect(storageRequestTimeout("/status")).toBe(15_000)
    expect(storageRequestTimeout("/cleanup/config")).toBe(15_000)
    expect(storageRequestTimeout("/cleanup/preview")).toBe(10 * 60_000)
    expect(storageRequestTimeout("/cleanup/run")).toBe(10 * 60_000)
  })

  test("exposes cleanup preview/config/run alongside dry-run migration, integrity, and validated retirement", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({ id: "run", mode: "quick", state: "queued" }))
    }) as StorageFetch
    const client = createStorageSettingsApi(fetcher, "/test/storage/")

    await client.previewCleanup()
    await client.updateCleanup(status.cleanup.settings)
    await client.runCleanup("reviewed-preview-token")
    await client.migrationStatus("local")
    await client.runMigrationDryRun({ databaseKind: "local", snapshotDirectory: "D:\\OpenCode-Snapshots" })
    await client.runIntegrity({ mode: "quick", dryRun: true })
    await client.updateRetention({ enabled: true, inactivityDays: 21 })
    await client.retireBackup({
      id: "backup",
      confirmation: "RETIRE backup 42 1783900800000",
      reviewed: { bytes: 42, modifiedAt: 1_783_900_800_000 },
    })

    expect(calls.map((call) => call.url)).toEqual([
      "/test/storage/cleanup/preview",
      "/test/storage/cleanup/config",
      "/test/storage/cleanup/run",
      "/test/storage/migration/status?database=local",
      "/test/storage/migration/dry-run",
      "/test/storage/integrity",
      "/test/storage/retention",
      "/test/storage/backups/retire",
    ])
    expect(calls.map((call) => call.init?.method)).toEqual([
      undefined,
      "PATCH",
      "POST",
      undefined,
      "POST",
      "POST",
      "PATCH",
      "POST",
    ])
    expect(calls.map((call) => call.init?.body)).toEqual([
      undefined,
      JSON.stringify(status.cleanup.settings),
      JSON.stringify({ previewToken: "reviewed-preview-token" }),
      undefined,
      JSON.stringify({ databaseKind: "local", snapshotDirectory: "D:\\OpenCode-Snapshots" }),
      JSON.stringify({ mode: "quick", dryRun: true }),
      JSON.stringify({ enabled: true, inactivityDays: 21 }),
      JSON.stringify({
        id: "backup",
        confirmation: "RETIRE backup 42 1783900800000",
        reviewed: { bytes: 42, modifiedAt: 1_783_900_800_000 },
      }),
    ])
    expect(calls.some((call) => /prepare|activate/.test(call.url))).toBe(false)
  })
})
