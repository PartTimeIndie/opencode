export type StorageArea = {
  bytes: number
  path?: string
}

export type StorageBackup = {
  id: string
  path: string
  bytes: number
  modifiedAt: number
  retireAfter: number
  retirementEligible: boolean
}

export type StorageCleanupSettings = {
  enabled: boolean
  snapshotRetentionDays: number
  compactionBackupRetentionDays: number
  snapshotMaxBytes: number
  checkIntervalHours: number
}

export type StorageCleanupCandidate = {
  kind: "snapshot" | "compaction-backup"
  path: string
  bytes: number
  modifiedAt: number
  reason: "expired" | "size-limit"
  layout?: "legacy" | "project"
  projectPath?: string
}

export type StorageCleanupInventory = {
  generatedAt: number
  snapshots: { path: string; repositories: number; bytes: number; emptyContainers: number }
  compactionBackups: { files: number; bytes: number; protected: number }
  candidates: StorageCleanupCandidate[]
  reclaimableBytes: number
  unknown: Array<{ path: string; reason: string }>
  locked: Array<{ path: string; reason: "repository-lock" | "git-lock" }>
}

export type StorageCleanupPreview = StorageCleanupInventory & {
  previewToken: string
}

export type StorageCleanupStatus = {
  version: 1
  state: "idle" | "running" | "failed"
  enabled: boolean
  due: boolean
  nextRunAt?: number
  statusPath: string
  lastAttemptAt?: number
  lastSucceededAt?: number
  lastFailedAt?: number
  lastFailure?: string
  lastResult?: {
    deletedArtifacts: number
    deletedBytes: number
    removedEmptyContainers: number
    skipped: number
    unknown: number
    snapshotBytesBefore: number
  }
}

export type StorageCleanupRunResult = {
  outcome: "completed" | "not-due" | "disabled"
  automatic: boolean
  startedAt: number
  completedAt: number
  inventory?: StorageCleanupInventory
  deleted: StorageCleanupCandidate[]
  deletedBytes: number
  removedEmptyContainers: number
  skipped: Array<{ path: string; reason: string }>
}

export type StorageStatus = {
  activeDatabase: StorageArea
  archives: StorageArea & { shards: number }
  blobStore: StorageArea & { blobs: number }
  localDatabase: StorageArea
  snapshots: StorageArea & { files: number }
  compactionBackups: StorageArea & { files: number }
  backups: StorageBackup[]
  sessions: {
    active: number
    archived: number
  }
  retention: {
    enabled: boolean
    inactivityDays: number
    defaultInactivityDays: number
  }
  cleanup: {
    settings: StorageCleanupSettings
    status: StorageCleanupStatus
  }
  deduplication: {
    attachments: number
    uniqueBlobs: number
    savedBytes: number
  }
  manifest: {
    state: "missing" | "ready" | "migrating" | "invalid"
    updatedAt?: string
    message?: string
  }
  maintenance: {
    state: "idle" | "running" | "paused" | "failed"
    operation?: string
    completed?: number
    total?: number
    message?: string
    schedulerActive?: boolean
    runs?: number
    archived?: number
    purged?: number
    idle?: number
    deferred?: number
    failed?: number
    candidateFailures?: Array<{
      sessionID: string
      error: string
      failedAt: number
      retryAt: number
    }>
    backlog?: number
    oldestEligibleAt?: number
    deferredReason?: "candidate-busy" | "candidate-failed" | "batch-limit" | "time-budget"
    lastStartedAt?: number
    lastFinishedAt?: number
    lastSucceededAt?: number
    lastFailedAt?: number
    nextRunAt?: number
    lastFailure?: string
  }
}

export type IntegrityMode = "quick" | "full"

export type IntegrityResult = {
  id: string
  mode: IntegrityMode
  state: "queued" | "running" | "completed" | "failed"
  message?: string
}

export type StorageMigrationReport = {
  sourceBytes: number
  candidateBytes: number
  savedBytes: number
  archivedSessions: number
  checkpointedSessions: number
  quarantineCount: number
}

export type StorageMigrationStatus = {
  state: "idle" | "running" | "completed" | "failed"
  databaseKind: StorageDatabaseKind
  sourceDatabase?: string
  id?: string
  stagingDirectory?: string
  snapshotDirectory?: string
  startedAt?: string | number
  updatedAt?: string | number
  message?: string
  report?: StorageMigrationReport
}

export type StorageDatabaseKind = "production" | "local"

export interface StorageSettingsApi {
  status(): Promise<StorageStatus>
  previewCleanup(): Promise<StorageCleanupPreview>
  updateCleanup(input: StorageCleanupSettings): Promise<StorageStatus["cleanup"]>
  runCleanup(previewToken: string): Promise<StorageCleanupRunResult>
  migrationStatus(databaseKind: StorageDatabaseKind): Promise<StorageMigrationStatus>
  runMigrationDryRun(input: {
    databaseKind: StorageDatabaseKind
    snapshotDirectory?: string
  }): Promise<StorageMigrationStatus>
  runIntegrity(input: { mode: IntegrityMode; dryRun: true }): Promise<IntegrityResult>
  updateRetention(input: { enabled: boolean; inactivityDays: number }): Promise<StorageStatus["retention"]>
  retireBackup(input: {
    id: string
    confirmation: string
    reviewed: { bytes: number; modifiedAt: number }
  }): Promise<void>
}

export type StorageFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export const STORAGE_REQUEST_TIMEOUT_MS = 15_000
export const STORAGE_CLEANUP_REQUEST_TIMEOUT_MS = 10 * 60_000

export function storageRequestTimeout(path: string) {
  return path === "/cleanup/preview" || path === "/cleanup/run"
    ? STORAGE_CLEANUP_REQUEST_TIMEOUT_MS
    : STORAGE_REQUEST_TIMEOUT_MS
}

export type StorageSettingsState = {
  status?: StorageStatus
  loading: boolean
  refreshing: boolean
  error?: string
  integrity?: IntegrityResult
  integrityBusy: boolean
  retentionBusy: boolean
  retentionError?: string
  cleanupPreview?: StorageCleanupPreview
  cleanupResult?: StorageCleanupRunResult
  cleanupBusy?: "preview" | "config" | "run"
  cleanupError?: string
  migration?: StorageMigrationStatus
  migrationLoading: boolean
  migrationBusy: boolean
  migrationError?: string
  selectedMigrationDatabase: StorageDatabaseKind
  snapshotDirectory: string
  snapshotDirectoryInvalid: boolean
  selectedBackupID?: string
  confirmation: string
  retirementBusy: boolean
  retirementError?: string
}

export function createStorageSettingsApi(fetcher: StorageFetch, endpoint = "/app/storage"): StorageSettingsApi {
  const root = endpoint.replace(/\/+$/, "")
  const request = async <T>(path: string, init?: RequestInit) => {
    const response = await fetcher(`${root}${path}`, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(storageRequestTimeout(path)),
    })
    if (response.status === 204) return undefined as T
    if (response.ok) return (await response.json()) as T
    throw new Error((await response.text()) || `Storage request failed (${response.status})`)
  }

  return {
    status: () => request<StorageStatus>("/status"),
    previewCleanup: () => request<StorageCleanupPreview>("/cleanup/preview"),
    updateCleanup: (input) =>
      request<StorageStatus["cleanup"]>("/cleanup/config", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    runCleanup: (previewToken) =>
      request<StorageCleanupRunResult>("/cleanup/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ previewToken }),
      }),
    migrationStatus: (databaseKind) =>
      request<StorageMigrationStatus>(`/migration/status?database=${encodeURIComponent(databaseKind)}`),
    runMigrationDryRun: (input) =>
      request<StorageMigrationStatus>("/migration/dry-run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    runIntegrity: (input) =>
      request<IntegrityResult>("/integrity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    updateRetention: (input) =>
      request<StorageStatus["retention"]>("/retention", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    retireBackup: (input) =>
      request<void>("/backups/retire", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
  }
}

export function backupRetirementConfirmation(backup: StorageBackup) {
  return `RETIRE ${backup.id} ${backup.bytes} ${backup.modifiedAt}`
}

export function isAbsoluteSnapshotDirectory(value: string) {
  const directory = value.trim()
  if (!directory) return true
  if (/^[A-Za-z]:[\\/]/.test(directory)) return true
  if (/^\\\\[^\\/]+[\\/][^\\/]+/.test(directory)) return true
  return directory.startsWith("/")
}

export function migrationAction(status?: StorageMigrationStatus) {
  if (status?.state === "running") return "running"
  if (status?.state === "failed") return "resume"
  return "start"
}

export function storagePresentation(
  state: StorageSettingsState,
  width: number,
  options: { cleanupDraftDirty?: boolean } = {},
) {
  const backup = state.status?.backups.find((item) => item.id === state.selectedBackupID)
  const cleanupUnavailable = !!state.cleanupBusy || state.loading || !state.status
  return {
    content: state.loading && !state.status ? "loading" : state.error && !state.status ? "error" : "status",
    layout: width < 640 ? "stacked" : "grid",
    refreshDisabled: state.loading || state.refreshing,
    integrityDisabled: state.integrityBusy || state.loading || !state.status,
    cleanupDisabled: cleanupUnavailable,
    cleanupPreviewDisabled: cleanupUnavailable || !!options.cleanupDraftDirty,
    cleanupRunDisabled: cleanupUnavailable || !!options.cleanupDraftDirty || !state.cleanupPreview,
    migrationDisabled:
      state.migrationBusy ||
      state.migrationLoading ||
      state.migration?.state === "running" ||
      state.snapshotDirectoryInvalid,
    retirementDisabled: state.retirementBusy || !backup?.retirementEligible,
  } as const
}

export function createStorageSettingsModel(api: StorageSettingsApi) {
  const listeners = new Set<(state: StorageSettingsState) => void>()
  let statusRevision = 0
  let migrationRevision = 0
  let state: StorageSettingsState = {
    loading: true,
    refreshing: false,
    integrityBusy: false,
    retentionBusy: false,
    migrationLoading: true,
    migrationBusy: false,
    selectedMigrationDatabase: "production",
    snapshotDirectory: "",
    snapshotDirectoryInvalid: false,
    confirmation: "",
    retirementBusy: false,
  }
  const update = (patch: Partial<StorageSettingsState>) => {
    state = { ...state, ...patch }
    listeners.forEach((listener) => listener(state))
  }
  const loadStatus = async () => {
    const request = ++statusRevision
    update({
      loading: !state.status,
      refreshing: !!state.status,
      error: undefined,
    })
    try {
      const status = await api.status()
      if (request !== statusRevision) return
      update({ status, loading: false, refreshing: false, cleanupPreview: undefined })
    } catch (error) {
      if (request !== statusRevision) return
      update({
        loading: false,
        refreshing: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  const loadMigration = async () => {
    const request = ++migrationRevision
    const databaseKind = state.selectedMigrationDatabase
    update({ migrationLoading: true, migrationError: undefined })
    try {
      const migration = await api.migrationStatus(databaseKind)
      if (request !== migrationRevision || databaseKind !== state.selectedMigrationDatabase) return
      update({ migration, migrationLoading: false })
    } catch (error) {
      if (request !== migrationRevision) return
      update({
        migrationLoading: false,
        migrationError: error instanceof Error ? error.message : String(error),
      })
    }
  }
  const load = async () => {
    await Promise.all([loadStatus(), loadMigration()])
  }

  return {
    snapshot: () => state,
    subscribe(listener: (state: StorageSettingsState) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    load,
    refresh: load,
    refreshMigration: loadMigration,
    async setMigrationDatabase(databaseKind: StorageDatabaseKind) {
      if (databaseKind === state.selectedMigrationDatabase) return
      update({
        selectedMigrationDatabase: databaseKind,
        migration: undefined,
        migrationError: undefined,
        snapshotDirectory: "",
        snapshotDirectoryInvalid: false,
      })
      await loadMigration()
    },
    setSnapshotDirectory(value: string) {
      update({
        snapshotDirectory: value,
        snapshotDirectoryInvalid: !isAbsoluteSnapshotDirectory(value),
        migrationError: undefined,
      })
    },
    async runMigrationDryRun() {
      if (state.migrationBusy || state.migration?.state === "running") return
      if (!isAbsoluteSnapshotDirectory(state.snapshotDirectory)) {
        update({ snapshotDirectoryInvalid: true })
        return
      }
      const snapshotDirectory = state.snapshotDirectory.trim()
      update({ migrationBusy: true, migrationError: undefined })
      try {
        update({
          migration: await api.runMigrationDryRun({
            databaseKind: state.selectedMigrationDatabase,
            ...(snapshotDirectory ? { snapshotDirectory } : {}),
          }),
          migrationBusy: false,
        })
      } catch (error) {
        update({
          migrationBusy: false,
          migrationError: error instanceof Error ? error.message : String(error),
        })
      }
    },
    setSelectedBackup(id?: string) {
      update({ selectedBackupID: id, confirmation: "", retirementError: undefined })
    },
    setConfirmation(value: string) {
      update({ confirmation: value, retirementError: undefined })
    },
    async runIntegrity(mode: IntegrityMode) {
      if (state.integrityBusy) return
      update({ integrityBusy: true, integrity: undefined, error: undefined })
      try {
        update({ integrity: await api.runIntegrity({ mode, dryRun: true }), integrityBusy: false })
      } catch (error) {
        update({
          integrityBusy: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
    async previewCleanup() {
      if (state.cleanupBusy || !state.status) return
      update({
        cleanupBusy: "preview",
        cleanupError: undefined,
        cleanupPreview: undefined,
        cleanupResult: undefined,
      })
      try {
        update({ cleanupPreview: await api.previewCleanup(), cleanupBusy: undefined })
      } catch (error) {
        update({
          cleanupBusy: undefined,
          cleanupError: error instanceof Error ? error.message : String(error),
        })
      }
    },
    async updateCleanup(input: StorageCleanupSettings) {
      if (state.cleanupBusy || !state.status) return
      if (
        !Number.isSafeInteger(input.snapshotRetentionDays) ||
        input.snapshotRetentionDays < 1 ||
        !Number.isSafeInteger(input.compactionBackupRetentionDays) ||
        input.compactionBackupRetentionDays < 1 ||
        !Number.isSafeInteger(input.snapshotMaxBytes) ||
        input.snapshotMaxBytes < 1 ||
        !Number.isSafeInteger(input.checkIntervalHours) ||
        input.checkIntervalHours < 24
      ) {
        update({ cleanupError: "Cleanup limits must be positive whole numbers and use an interval of at least 24 hours." })
        return
      }
      update({
        cleanupBusy: "config",
        cleanupError: undefined,
        cleanupPreview: undefined,
        cleanupResult: undefined,
      })
      try {
        const cleanup = await api.updateCleanup(input)
        update({
          status: { ...state.status, cleanup },
          cleanupPreview: undefined,
          cleanupResult: undefined,
          cleanupBusy: undefined,
        })
      } catch (error) {
        update({
          cleanupBusy: undefined,
          cleanupError: error instanceof Error ? error.message : String(error),
        })
      }
    },
    async runCleanup() {
      if (state.cleanupBusy || !state.status) return
      if (!state.cleanupPreview) {
        update({ cleanupError: "Preview cleanup before permanently deleting artifacts." })
        return
      }
      update({ cleanupBusy: "run", cleanupError: undefined, cleanupResult: undefined })
      try {
        const cleanupResult = await api.runCleanup(state.cleanupPreview.previewToken)
        update({ cleanupResult, cleanupBusy: undefined })
        await loadStatus()
      } catch (error) {
        update({
          cleanupBusy: undefined,
          cleanupPreview: undefined,
          cleanupError: error instanceof Error ? error.message : String(error),
        })
      }
    },
    async updateRetention(input: { enabled: boolean; inactivityDays: number }) {
      if (state.retentionBusy || !state.status) return
      if (!Number.isInteger(input.inactivityDays) || input.inactivityDays < 1 || input.inactivityDays > 3_650) {
        update({ retentionError: "Enter a whole number between 1 and 3650 days." })
        return
      }
      update({ retentionBusy: true, retentionError: undefined })
      try {
        const retention = await api.updateRetention(input)
        update({
          status: { ...state.status, retention },
          retentionBusy: false,
        })
      } catch (error) {
        update({
          retentionBusy: false,
          retentionError: error instanceof Error ? error.message : String(error),
        })
      }
    },
    async retireBackup() {
      if (state.retirementBusy) return
      const backup = state.status?.backups.find((item) => item.id === state.selectedBackupID)
      if (!backup) {
        update({ retirementError: "Select a backup before retirement." })
        return
      }
      if (!backup.retirementEligible) {
        update({ retirementError: `The backup is retained until ${new Date(backup.retireAfter).toISOString()}.` })
        return
      }
      if (state.confirmation !== backupRetirementConfirmation(backup)) {
        update({ retirementError: "The confirmation must exactly match the backup bytes and modification time." })
        return
      }
      update({ retirementBusy: true, retirementError: undefined })
      try {
        await api.retireBackup({
          id: backup.id,
          confirmation: state.confirmation,
          reviewed: { bytes: backup.bytes, modifiedAt: backup.modifiedAt },
        })
        update({ retirementBusy: false, selectedBackupID: undefined, confirmation: "" })
        await load()
      } catch (error) {
        update({
          retirementBusy: false,
          retirementError: error instanceof Error ? error.message : String(error),
        })
      }
    },
  }
}
