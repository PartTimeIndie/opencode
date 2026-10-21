import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Switch as Toggle } from "@opencode-ai/ui/v2/switch-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServerSDK } from "@/context/server-sdk"
import { authTokenFromCredentials } from "@/utils/server"
import { SettingsServerPicker } from "../settings-server-picker"
import {
  backupRetirementConfirmation,
  createStorageSettingsApi,
  createStorageSettingsModel,
  migrationAction,
  storagePresentation,
  type StorageArea,
  type StorageBackup,
  type StorageFetch,
  type StorageSettingsApi,
  type StorageStatus,
} from "./storage-model"
import "./storage.css"

export function SettingsStorageV2(props: { api?: StorageSettingsApi; fetch?: StorageFetch; endpoint?: string }) {
  const language = useLanguage()
  const needsServer = !props.api && !props.endpoint
  const serverSDK = needsServer ? useServerSDK() : undefined
  const platform = !props.api && !props.fetch ? usePlatform() : undefined
  const fetcher = props.fetch ?? platform?.fetch ?? globalThis.fetch.bind(globalThis)
  const requestApi = () => {
    const sdk = serverSDK?.()
    const connection = sdk?.server.http
    const password = connection?.password
    return createStorageSettingsApi(
      password
        ? (input, init) => {
            const headers = new Headers(init?.headers)
            headers.set(
              "authorization",
              `Basic ${authTokenFromCredentials({ username: connection.username, password })}`,
            )
            return fetcher(input, { ...init, headers })
          }
        : fetcher,
      props.endpoint ?? `${sdk?.url}/app/storage`,
    )
  }
  const model = createStorageSettingsModel(
    props.api ?? {
      status: () => requestApi().status(),
      previewCleanup: () => requestApi().previewCleanup(),
      updateCleanup: (input) => requestApi().updateCleanup(input),
      runCleanup: (previewToken) => requestApi().runCleanup(previewToken),
      migrationStatus: (databaseKind) => requestApi().migrationStatus(databaseKind),
      runMigrationDryRun: (input) => requestApi().runMigrationDryRun(input),
      runIntegrity: (input) => requestApi().runIntegrity(input),
      updateRetention: (input) => requestApi().updateRetention(input),
      retireBackup: (input) => requestApi().retireBackup(input),
    },
  )
  const [state, setState] = createSignal(model.snapshot())
  const [width, setWidth] = createSignal(typeof window === "undefined" ? 1024 : window.innerWidth)
  const [retentionDays, setRetentionDays] = createSignal("")
  const [retentionEditing, setRetentionEditing] = createSignal(false)
  const [cleanupDraft, setCleanupDraft] = createStore({
    enabled: true,
    snapshotRetentionDays: "",
    compactionBackupRetentionDays: "",
    snapshotMaxGiB: "",
    checkIntervalHours: "",
    dirty: false,
  })
  const view = createMemo(() =>
    storagePresentation(state(), width(), { cleanupDraftDirty: cleanupDraft.dirty }),
  )
  const selectedBackup = createMemo(() =>
    state().status?.backups.find((backup) => backup.id === state().selectedBackupID),
  )
  let lastUrl = ""

  createEffect(() => {
    const url = serverSDK?.().url
    if (!url || url === lastUrl) return
    lastUrl = url
    void model.load()
  })

  createEffect(() => {
    if (state().migration?.state !== "running" || typeof window === "undefined") return
    const interval = window.setInterval(() => void model.refreshMigration(), 5_000)
    onCleanup(() => window.clearInterval(interval))
  })

  createEffect(() => {
    if (retentionEditing() || state().retentionBusy) return
    const days = state().status?.retention?.inactivityDays
    if (days !== undefined) setRetentionDays(String(days))
  })

  createEffect(() => {
    const settings = state().status?.cleanup.settings
    if (!settings || cleanupDraft.dirty || state().cleanupBusy === "config") return
    setCleanupDraft({
      enabled: settings.enabled,
      snapshotRetentionDays: String(settings.snapshotRetentionDays),
      compactionBackupRetentionDays: String(settings.compactionBackupRetentionDays),
      snapshotMaxGiB: String(settings.snapshotMaxBytes / 1024 ** 3),
      checkIntervalHours: String(settings.checkIntervalHours),
    })
  })

  const saveCleanup = async () => {
    await model.updateCleanup({
      enabled: cleanupDraft.enabled,
      snapshotRetentionDays: Number(cleanupDraft.snapshotRetentionDays),
      compactionBackupRetentionDays: Number(cleanupDraft.compactionBackupRetentionDays),
      snapshotMaxBytes: Math.round(Number(cleanupDraft.snapshotMaxGiB) * 1024 ** 3),
      checkIntervalHours: Number(cleanupDraft.checkIntervalHours),
    })
    if (!model.snapshot().cleanupError) setCleanupDraft("dirty", false)
  }

  onMount(() => {
    const unsubscribe = model.subscribe(setState)
    setState(model.snapshot())
    const resize = () => setWidth(window.innerWidth)
    window.addEventListener("resize", resize)
    if (!serverSDK) void model.load()
    onCleanup(() => {
      unsubscribe()
      window.removeEventListener("resize", resize)
    })
  })

  return (
    <>
      <div class="settings-v2-tab-header storage-v2-header">
        <div class="settings-v2-tab-header-row">
          <div>
            <h2 class="settings-v2-tab-title">{language.t("settings.storage.title")}</h2>
            <p>{language.t("settings.storage.description")}</p>
          </div>
          <div class="storage-v2-header-actions">
            <Show when={serverSDK}>
              <SettingsServerPicker />
            </Show>
            <ButtonV2
              size="normal"
              variant="neutral"
              disabled={view().refreshDisabled}
              onClick={() => void model.refresh()}
            >
              {language.t(
                state().refreshing ? "settings.storage.action.refreshing" : "settings.storage.action.refresh",
              )}
            </ButtonV2>
          </div>
        </div>
      </div>

      <div
        class="settings-v2-tab-body storage-v2-body"
        data-component="storage-settings"
        data-layout={view().layout}
        aria-busy={state().loading || state().refreshing}
      >
        <div class="storage-v2-announcer" role="status" aria-live="polite">
          <Show when={state().loading}>{language.t("settings.storage.loading")}</Show>
          <Show when={state().refreshing}>{language.t("settings.storage.action.refreshing")}</Show>
          <Show when={state().error}>{language.t("settings.storage.error", { error: state().error ?? "" })}</Show>
        </div>

        <Switch>
          <Match when={view().content === "loading"}>
            <div class="storage-v2-state" data-state="loading">
              {language.t("settings.storage.loading")}
            </div>
          </Match>
          <Match when={view().content === "error"}>
            <div class="storage-v2-state storage-v2-state--error" data-state="error">
              <span>{state().error}</span>
              <ButtonV2 variant="neutral" onClick={() => void model.refresh()}>
                {language.t("settings.storage.action.retry")}
              </ButtonV2>
            </div>
          </Match>
          <Match when={view().content === "status" && state().status}>
            {(status) => (
              <>
                <Show when={state().error}>
                  <p class="storage-v2-error storage-v2-error--banner" role="alert">
                    {state().error}
                  </p>
                </Show>
                <section
                  class="storage-v2-section"
                  data-action="settings-storage-footprint"
                  aria-labelledby="storage-footprint-title"
                >
                  <h3 id="storage-footprint-title">{language.t("settings.storage.section.footprint")}</h3>
                  <div class="storage-v2-grid">
                    <StorageMetric
                      label={language.t("settings.storage.row.activeDatabase")}
                      area={status().activeDatabase}
                    />
                    <StorageMetric
                      label={language.t("settings.storage.row.archives")}
                      area={status().archives}
                      detail={language.t("settings.storage.detail.shards", { count: status().archives.shards })}
                    />
                    <StorageMetric
                      label={language.t("settings.storage.row.blobStore")}
                      area={status().blobStore}
                      detail={language.t("settings.storage.detail.blobs", { count: status().blobStore.blobs })}
                    />
                    <StorageMetric
                      label={language.t("settings.storage.row.localDatabase")}
                      area={status().localDatabase}
                    />
                    <StorageMetric
                      label={language.t("settings.storage.row.snapshots")}
                      area={status().snapshots}
                      detail={language.t("settings.storage.detail.files", { count: status().snapshots.files })}
                    />
                    <StorageMetric
                      label={language.t("settings.storage.row.compactionBackups")}
                      area={status().compactionBackups}
                      detail={language.t("settings.storage.detail.files", {
                        count: status().compactionBackups.files,
                      })}
                    />
                    <StorageMetric
                      label={language.t("settings.storage.row.backups")}
                      area={{ bytes: status().backups.reduce((sum, backup) => sum + backup.bytes, 0) }}
                      detail={language.t("settings.storage.detail.retained", { count: status().backups.length })}
                    />
                  </div>
                </section>

                <section
                  class="storage-v2-section"
                  data-action="settings-storage-cleanup"
                  aria-labelledby="storage-cleanup-title"
                  aria-busy={!!state().cleanupBusy}
                >
                  <h3 id="storage-cleanup-title">{language.t("settings.storage.cleanup.title")}</h3>
                  <p class="storage-v2-help">{language.t("settings.storage.cleanup.description")}</p>
                  <p class="storage-v2-safety">{language.t("settings.storage.cleanup.safety")}</p>

                  <div class="storage-v2-cleanup-enable">
                    <div>
                      <strong>{language.t("settings.storage.cleanup.enabled")}</strong>
                      <small>{language.t("settings.storage.cleanup.enabledHelp")}</small>
                    </div>
                    <Toggle
                      checked={cleanupDraft.enabled}
                      disabled={view().cleanupDisabled}
                      onChange={(enabled) => {
                        setCleanupDraft("enabled", enabled)
                        setCleanupDraft("dirty", true)
                      }}
                    />
                  </div>

                  <form
                    class="storage-v2-cleanup-config"
                    onSubmit={(event) => {
                      event.preventDefault()
                      void saveCleanup()
                    }}
                  >
                    <label class="storage-v2-cleanup-field" for="storage-cleanup-snapshot-days">
                      <span>{language.t("settings.storage.cleanup.snapshotDays")}</span>
                      <TextInputV2
                        id="storage-cleanup-snapshot-days"
                        type="number"
                        appearance="base"
                        min={1}
                        step={1}
                        value={cleanupDraft.snapshotRetentionDays}
                        disabled={view().cleanupDisabled}
                        onInput={(event) => {
                          setCleanupDraft("snapshotRetentionDays", event.currentTarget.value)
                          setCleanupDraft("dirty", true)
                        }}
                      />
                      <small>{language.t("settings.storage.cleanup.snapshotDaysHelp")}</small>
                    </label>
                    <label class="storage-v2-cleanup-field" for="storage-cleanup-backup-days">
                      <span>{language.t("settings.storage.cleanup.backupDays")}</span>
                      <TextInputV2
                        id="storage-cleanup-backup-days"
                        type="number"
                        appearance="base"
                        min={1}
                        step={1}
                        value={cleanupDraft.compactionBackupRetentionDays}
                        disabled={view().cleanupDisabled}
                        onInput={(event) => {
                          setCleanupDraft("compactionBackupRetentionDays", event.currentTarget.value)
                          setCleanupDraft("dirty", true)
                        }}
                      />
                      <small>{language.t("settings.storage.cleanup.backupDaysHelp")}</small>
                    </label>
                    <label class="storage-v2-cleanup-field" for="storage-cleanup-snapshot-gib">
                      <span>{language.t("settings.storage.cleanup.snapshotGiB")}</span>
                      <TextInputV2
                        id="storage-cleanup-snapshot-gib"
                        type="number"
                        appearance="base"
                        min={0.1}
                        step={0.1}
                        value={cleanupDraft.snapshotMaxGiB}
                        disabled={view().cleanupDisabled}
                        onInput={(event) => {
                          setCleanupDraft("snapshotMaxGiB", event.currentTarget.value)
                          setCleanupDraft("dirty", true)
                        }}
                      />
                      <small>{language.t("settings.storage.cleanup.snapshotGiBHelp")}</small>
                    </label>
                    <label class="storage-v2-cleanup-field" for="storage-cleanup-interval-hours">
                      <span>{language.t("settings.storage.cleanup.intervalHours")}</span>
                      <TextInputV2
                        id="storage-cleanup-interval-hours"
                        type="number"
                        appearance="base"
                        min={24}
                        step={1}
                        value={cleanupDraft.checkIntervalHours}
                        disabled={view().cleanupDisabled}
                        onInput={(event) => {
                          setCleanupDraft("checkIntervalHours", event.currentTarget.value)
                          setCleanupDraft("dirty", true)
                        }}
                      />
                      <small>{language.t("settings.storage.cleanup.intervalHoursHelp")}</small>
                    </label>
                    <div class="storage-v2-actions storage-v2-cleanup-save">
                      <ButtonV2
                        type="submit"
                        variant="neutral"
                        disabled={view().cleanupDisabled || !cleanupDraft.dirty}
                      >
                        {language.t(
                          state().cleanupBusy === "config"
                            ? "settings.storage.cleanup.action.saving"
                            : "settings.storage.cleanup.action.save",
                        )}
                      </ButtonV2>
                    </div>
                  </form>

                  <div class="storage-v2-grid">
                    <StorageValue
                      label={language.t("settings.storage.cleanup.row.status")}
                      value={language.t(
                        `settings.storage.state.${status().cleanup.settings.enabled ? status().cleanup.status.state : "disabled"}`,
                      )}
                      detail={status().cleanup.status.lastFailure}
                      state={status().cleanup.status.state === "failed" ? "error" : "ok"}
                    />
                    <StorageValue
                      label={language.t("settings.storage.cleanup.row.nextRun")}
                      value={
                        formatTime(status().cleanup.status.nextRunAt) ??
                        language.t("settings.storage.cleanup.value.notScheduled")
                      }
                      detail={
                        status().cleanup.status.due ? language.t("settings.storage.cleanup.value.due") : undefined
                      }
                    />
                    <StorageValue
                      label={language.t("settings.storage.cleanup.row.lastRun")}
                      value={
                        formatTime(status().cleanup.status.lastSucceededAt) ??
                        language.t("settings.storage.cleanup.value.never")
                      }
                      detail={
                        (() => {
                          const result = status().cleanup.status.lastResult
                          return result
                            ? language.t("settings.storage.cleanup.lastResult", {
                                count: result.deletedArtifacts,
                                bytes: formatBytes(result.deletedBytes),
                              })
                            : undefined
                        })()
                      }
                      wrapDetail
                    />
                  </div>

                  <div class="storage-v2-actions">
                    <ButtonV2
                      variant="neutral"
                      disabled={view().cleanupPreviewDisabled}
                      onClick={() => void model.previewCleanup()}
                    >
                      {language.t(
                        state().cleanupBusy === "preview"
                          ? "settings.storage.cleanup.action.previewing"
                          : "settings.storage.cleanup.action.preview",
                      )}
                    </ButtonV2>
                    <ButtonV2
                      variant="contrast"
                      disabled={view().cleanupRunDisabled}
                      onClick={() => void model.runCleanup()}
                    >
                      {language.t(
                        state().cleanupBusy === "run"
                          ? "settings.storage.cleanup.action.running"
                          : "settings.storage.cleanup.action.run",
                      )}
                    </ButtonV2>
                  </div>
                  <Show when={cleanupDraft.dirty || !state().cleanupPreview}>
                    <p class="storage-v2-help">
                      {language.t(
                        cleanupDraft.dirty
                          ? "settings.storage.cleanup.previewStale"
                          : "settings.storage.cleanup.previewRequired",
                      )}
                    </p>
                  </Show>
                  <Show when={!cleanupDraft.dirty && state().cleanupPreview}>
                    {(preview) => (
                      <p class="storage-v2-result" role="status">
                        {language.t("settings.storage.cleanup.previewResult", {
                          count: preview().candidates.length,
                          bytes: formatBytes(preview().reclaimableBytes),
                          unknown: preview().unknown.length,
                          locked: preview().locked.length,
                        })}
                      </p>
                    )}
                  </Show>
                  <Show when={state().cleanupResult}>
                    {(result) => (
                      <p class="storage-v2-result" role="status">
                        {language.t("settings.storage.cleanup.runResult", {
                          count: result().deleted.length,
                          bytes: formatBytes(result().deletedBytes),
                          skipped: result().skipped.length,
                        })}
                      </p>
                    )}
                  </Show>
                  <Show when={state().cleanupError}>
                    <p class="storage-v2-error" role="alert">
                      {state().cleanupError}
                    </p>
                  </Show>
                </section>

                <section
                  class="storage-v2-section"
                  data-action="settings-storage-migration-dry-run"
                  aria-labelledby="storage-migration-title"
                  aria-busy={state().migrationLoading || state().migrationBusy}
                >
                  <h3 id="storage-migration-title">{language.t("settings.storage.migration.title")}</h3>
                  <p class="storage-v2-help">{language.t("settings.storage.migration.description")}</p>
                  <p class="storage-v2-safety">{language.t("settings.storage.migration.safety")}</p>

                  <div class="storage-v2-migration-database">
                    <label for="storage-migration-database">
                      {language.t("settings.storage.migration.database.label")}
                    </label>
                    <select
                      id="storage-migration-database"
                      value={state().selectedMigrationDatabase}
                      disabled={state().migrationBusy || state().migration?.state === "running"}
                      onChange={(event) =>
                        void model.setMigrationDatabase(event.currentTarget.value as "production" | "local")
                      }
                    >
                      <option value="production">{language.t("settings.storage.migration.database.production")}</option>
                      <option value="local">{language.t("settings.storage.migration.database.local")}</option>
                    </select>
                    <small>{language.t("settings.storage.migration.database.help")}</small>
                  </div>

                  <Show
                    when={!state().migrationLoading || state().migration}
                    fallback={<p class="storage-v2-help">{language.t("settings.storage.migration.loading")}</p>}
                  >
                    <div class="storage-v2-grid">
                      <StorageValue
                        label={language.t("settings.storage.migration.row.database")}
                        value={language.t(
                          `settings.storage.migration.database.${state().migration?.databaseKind ?? state().selectedMigrationDatabase}`,
                        )}
                        detail={state().migration?.sourceDatabase}
                      />
                      <StorageValue
                        label={language.t("settings.storage.migration.row.status")}
                        value={language.t(`settings.storage.state.${state().migration?.state ?? "idle"}`)}
                        detail={state().migration?.message ?? formatTime(state().migration?.updatedAt)}
                        wrapDetail
                        state={state().migration?.state === "failed" ? "error" : "ok"}
                      />
                      <Show when={state().migration?.report}>
                        {(report) => (
                          <>
                            <StorageValue
                              label={language.t("settings.storage.migration.row.source")}
                              value={formatBytes(report().sourceBytes)}
                            />
                            <StorageValue
                              label={language.t("settings.storage.migration.row.candidate")}
                              value={formatBytes(report().candidateBytes)}
                            />
                            <StorageValue
                              label={language.t("settings.storage.migration.row.saved")}
                              value={formatBytes(report().savedBytes)}
                            />
                            <StorageValue
                              label={language.t("settings.storage.migration.row.archived")}
                              value={report().archivedSessions.toLocaleString()}
                            />
                            <StorageValue
                              label={language.t("settings.storage.migration.row.checkpointed")}
                              value={report().checkpointedSessions.toLocaleString()}
                            />
                            <StorageValue
                              label={language.t("settings.storage.migration.row.quarantine")}
                              value={report().quarantineCount.toLocaleString()}
                              state={report().quarantineCount > 0 ? "attention" : "ok"}
                            />
                          </>
                        )}
                      </Show>
                    </div>

                    <Show when={state().migration?.stagingDirectory || state().migration?.snapshotDirectory}>
                      <dl class="storage-v2-paths">
                        <Show when={state().migration?.stagingDirectory}>
                          {(directory) => (
                            <div>
                              <dt>{language.t("settings.storage.migration.row.stagingDirectory")}</dt>
                              <dd>{directory()}</dd>
                            </div>
                          )}
                        </Show>
                        <Show when={state().migration?.snapshotDirectory}>
                          {(directory) => (
                            <div>
                              <dt>{language.t("settings.storage.migration.row.snapshotDirectory")}</dt>
                              <dd>{directory()}</dd>
                            </div>
                          )}
                        </Show>
                      </dl>
                    </Show>
                  </Show>

                  <div class="storage-v2-migration-controls">
                    <label for="storage-migration-snapshot">
                      {language.t("settings.storage.migration.snapshot.label")}
                    </label>
                    <TextInputV2
                      id="storage-migration-snapshot"
                      value={state().snapshotDirectory}
                      disabled={state().migrationBusy || state().migration?.state === "running"}
                      aria-invalid={state().snapshotDirectoryInvalid}
                      aria-describedby="storage-migration-snapshot-help storage-migration-error"
                      placeholder={language.t("settings.storage.migration.snapshot.placeholder")}
                      onInput={(event) => model.setSnapshotDirectory(event.currentTarget.value)}
                    />
                    <small id="storage-migration-snapshot-help">
                      {language.t("settings.storage.migration.snapshot.help")}
                    </small>
                    <Show when={state().snapshotDirectoryInvalid}>
                      <p id="storage-migration-error" class="storage-v2-error" role="alert">
                        {language.t("settings.storage.migration.snapshot.invalid")}
                      </p>
                    </Show>
                    <Show when={!state().snapshotDirectoryInvalid && state().migrationError}>
                      <p id="storage-migration-error" class="storage-v2-error" role="alert">
                        {state().migrationError}
                      </p>
                    </Show>
                    <ButtonV2
                      variant="neutral"
                      disabled={view().migrationDisabled}
                      onClick={() => void model.runMigrationDryRun()}
                    >
                      {language.t(`settings.storage.migration.action.${migrationAction(state().migration)}`)}
                    </ButtonV2>
                  </div>
                </section>

                <section
                  class="storage-v2-section"
                  data-action="settings-storage-content"
                  aria-labelledby="storage-content-title"
                >
                  <h3 id="storage-content-title">{language.t("settings.storage.section.content")}</h3>
                  <div class="storage-v2-grid">
                    <StorageValue
                      label={language.t("settings.storage.row.activeSessions")}
                      value={status().sessions.active.toLocaleString()}
                    />
                    <StorageValue
                      label={language.t("settings.storage.row.archivedSessions")}
                      value={status().sessions.archived.toLocaleString()}
                    />
                    <StorageValue
                      label={language.t("settings.storage.row.attachmentLinks")}
                      value={status().deduplication.attachments.toLocaleString()}
                    />
                    <StorageValue
                      label={language.t("settings.storage.row.uniqueBlobs")}
                      value={status().deduplication.uniqueBlobs.toLocaleString()}
                    />
                    <StorageValue
                      label={language.t("settings.storage.row.bytesSaved")}
                      value={formatBytes(status().deduplication.savedBytes)}
                    />
                  </div>
                </section>

                <section
                  class="storage-v2-section"
                  data-action="settings-storage-health"
                  aria-labelledby="storage-health-title"
                >
                  <h3 id="storage-health-title">{language.t("settings.storage.section.health")}</h3>
                  <div class="storage-v2-grid">
                    <StorageValue
                      label={language.t("settings.storage.row.manifest")}
                      value={language.t(`settings.storage.state.${status().manifest.state}`)}
                      detail={status().manifest.message ?? formatTime(status().manifest.updatedAt)}
                      state={status().manifest.state === "ready" ? "ok" : "attention"}
                    />
                    <StorageValue
                      label={language.t("settings.storage.row.maintenance")}
                      value={language.t(`settings.storage.state.${status().maintenance.state}`)}
                      detail={maintenanceDetail(status().maintenance, {
                        lastSuccess: language.t("settings.storage.maintenance.lastSuccess"),
                        lastFailure: language.t("settings.storage.maintenance.lastFailure"),
                        nextRun: language.t("settings.storage.maintenance.nextRun"),
                        backlog: language.t("settings.storage.maintenance.backlog"),
                        purged: language.t("settings.storage.maintenance.purged"),
                        oldestEligible: language.t("settings.storage.maintenance.oldestEligible"),
                        deferredReasons: {
                          "candidate-busy": language.t("settings.storage.maintenance.deferred.candidateBusy"),
                          "candidate-failed": language.t("settings.storage.maintenance.deferred.candidateFailed"),
                          "batch-limit": language.t("settings.storage.maintenance.deferred.batchLimit"),
                          "time-budget": language.t("settings.storage.maintenance.deferred.timeBudget"),
                        },
                      })}
                      wrapDetail
                      state={status().maintenance.state === "failed" ? "error" : "ok"}
                    />
                  </div>
                  <div class="storage-v2-actions">
                    <ButtonV2
                      variant="neutral"
                      disabled={view().integrityDisabled}
                      onClick={() => void model.runIntegrity("quick")}
                    >
                      {language.t("settings.storage.action.quickIntegrity")}
                    </ButtonV2>
                    <ButtonV2
                      variant="neutral"
                      disabled={view().integrityDisabled}
                      onClick={() => void model.runIntegrity("full")}
                    >
                      {language.t("settings.storage.action.fullIntegrity")}
                    </ButtonV2>
                  </div>
                  <Show when={state().integrity}>
                    {(integrity) => (
                      <p class="storage-v2-result" role="status">
                        {language.t("settings.storage.integrity.result", {
                          mode: language.t(`settings.storage.mode.${integrity().mode}`),
                          state: language.t(`settings.storage.state.${integrity().state}`),
                          message: integrity().message ?? integrity().id,
                        })}
                      </p>
                    )}
                  </Show>
                </section>

                <section
                  class="storage-v2-section"
                  data-action="settings-storage-session-retention"
                  aria-labelledby="storage-retention-title"
                >
                  <h3 id="storage-retention-title">{language.t("settings.storage.retention.title")}</h3>
                  <p class="storage-v2-help">{language.t("settings.storage.retention.description")}</p>
                  <div class="storage-v2-retention-control">
                    <div>
                      <strong>{language.t("settings.storage.retention.enabled")}</strong>
                      <small>{language.t("settings.storage.retention.help")}</small>
                    </div>
                    <Toggle
                      checked={state().status?.retention?.enabled ?? false}
                      disabled={state().retentionBusy || !state().status}
                      onChange={(enabled) =>
                        void model.updateRetention({
                          enabled,
                          inactivityDays: state().status?.retention?.inactivityDays ?? 21,
                        })
                      }
                    />
                  </div>
                  <div class="storage-v2-retention-days">
                    <label for="storage-retention-days">{language.t("settings.storage.retention.days")}</label>
                    <TextInputV2
                      id="storage-retention-days"
                      type="number"
                      appearance="base"
                      min={1}
                      max={3650}
                      step={1}
                      value={retentionDays()}
                      disabled={state().retentionBusy || !(state().status?.retention?.enabled ?? false)}
                      onFocus={() => setRetentionEditing(true)}
                      onInput={(event) => setRetentionDays(event.currentTarget.value)}
                      onBlur={() => {
                        void model.updateRetention({
                          enabled: state().status?.retention?.enabled ?? false,
                          inactivityDays: Number(retentionDays()),
                        })
                        setRetentionEditing(false)
                      }}
                      aria-label={language.t("settings.storage.retention.days")}
                    />
                    <small>
                      {language.t("settings.storage.retention.default", {
                        days: state().status?.retention?.defaultInactivityDays ?? 21,
                      })}
                    </small>
                  </div>
                  <Show when={state().retentionError}>
                    <p class="storage-v2-error" role="alert">
                      {state().retentionError}
                    </p>
                  </Show>
                </section>

                <section
                  class="storage-v2-section"
                  data-action="settings-storage-backups"
                  aria-labelledby="storage-backup-title"
                >
                  <h3 id="storage-backup-title">{language.t("settings.storage.section.backups")}</h3>
                  <p class="storage-v2-help">{language.t("settings.storage.backups.description")}</p>
                  <Show
                    when={status().backups.length > 0}
                    fallback={<p class="storage-v2-help">{language.t("settings.storage.backups.none")}</p>}
                  >
                    <div
                      class="storage-v2-backups"
                      role="radiogroup"
                      aria-label={language.t("settings.storage.backups.retained")}
                    >
                      <For each={status().backups}>
                        {(backup) => (
                          <BackupOption
                            backup={backup}
                            selected={state().selectedBackupID === backup.id}
                            select={() => model.setSelectedBackup(backup.id)}
                          />
                        )}
                      </For>
                    </div>
                    <Show when={selectedBackup()}>
                      {(backup) => (
                        <div class="storage-v2-retirement">
                          <label for="storage-retirement-confirmation">
                            {language.t("settings.storage.backups.type")}{" "}
                            <code>{backupRetirementConfirmation(backup())}</code>
                          </label>
                          <div class="storage-v2-retirement-controls">
                            <TextInputV2
                              id="storage-retirement-confirmation"
                              value={state().confirmation}
                              disabled={state().retirementBusy}
                              aria-describedby="storage-retirement-error"
                              onInput={(event) => model.setConfirmation(event.currentTarget.value)}
                            />
                            <ButtonV2
                              variant="contrast"
                              disabled={
                                view().retirementDisabled ||
                                state().confirmation !== backupRetirementConfirmation(backup())
                              }
                              onClick={() => void model.retireBackup()}
                            >
                              {language.t(
                                state().retirementBusy
                                  ? "settings.storage.action.retiring"
                                  : "settings.storage.action.retire",
                              )}
                            </ButtonV2>
                          </div>
                          <Show when={state().retirementError}>
                            <p id="storage-retirement-error" class="storage-v2-error" role="alert">
                              {state().retirementError}
                            </p>
                          </Show>
                        </div>
                      )}
                    </Show>
                  </Show>
                </section>
              </>
            )}
          </Match>
        </Switch>
      </div>
    </>
  )
}

function StorageMetric(props: { label: string; area: StorageArea; detail?: string }) {
  return (
    <StorageValue label={props.label} value={formatBytes(props.area.bytes)} detail={props.detail ?? props.area.path} />
  )
}

function StorageValue(props: {
  label: string
  value: string
  detail?: string
  wrapDetail?: boolean
  state?: "ok" | "attention" | "error"
}) {
  return (
    <article class="storage-v2-card" data-state={props.state}>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
      <Show when={props.detail}>
        <small data-wrap={props.wrapDetail ? "true" : undefined}>{props.detail}</small>
      </Show>
    </article>
  )
}

function BackupOption(props: { backup: StorageBackup; selected: boolean; select: () => void }) {
  const language = useLanguage()
  return (
    <button
      type="button"
      class="storage-v2-backup"
      role="radio"
      aria-checked={props.selected}
      data-selected={props.selected ? "" : undefined}
      onClick={props.select}
    >
      <strong>{props.backup.id}</strong>
      <span>
        {formatBytes(props.backup.bytes)} - {formatTime(props.backup.modifiedAt)}
      </span>
      <small>
        {props.backup.retirementEligible
          ? language.t("settings.storage.backups.eligible")
          : language.t("settings.storage.backups.retainedUntil", { time: formatTime(props.backup.retireAfter) ?? "" })}
      </small>
      <small>{props.backup.path}</small>
    </button>
  )
}

function formatBytes(value: number) {
  const magnitude = Math.abs(value)
  if (magnitude < 1024) return `${value} B`
  const units = ["KiB", "MiB", "GiB", "TiB"]
  const power = Math.min(Math.floor(Math.log(magnitude) / Math.log(1024)), units.length)
  return `${(value / 1024 ** power).toFixed(power > 2 ? 2 : 1)} ${units[power - 1]}`
}

function formatTime(value?: string | number) {
  if (!value) return undefined
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString()
}

function maintenanceDetail(
  maintenance: StorageStatus["maintenance"],
  labels: {
    lastSuccess: string
    lastFailure: string
    nextRun: string
    backlog: string
    purged: string
    oldestEligible: string
    deferredReasons: Record<NonNullable<StorageStatus["maintenance"]["deferredReason"]>, string>
  },
) {
  const progress =
    maintenance.completed !== undefined && maintenance.total !== undefined
      ? `${maintenance.completed.toLocaleString()} / ${maintenance.total.toLocaleString()}`
      : undefined
  const lastSuccess = maintenance.lastSucceededAt
    ? `${labels.lastSuccess}: ${formatTime(maintenance.lastSucceededAt)}`
    : undefined
  const lastFailure = maintenance.lastFailedAt
    ? `${labels.lastFailure}: ${formatTime(maintenance.lastFailedAt)}${maintenance.lastFailure ? ` (${maintenance.lastFailure})` : ""}`
    : undefined
  const nextRun = maintenance.nextRunAt ? `${labels.nextRun}: ${formatTime(maintenance.nextRunAt)}` : undefined
  const backlog =
    maintenance.backlog === undefined ? undefined : `${labels.backlog}: ${maintenance.backlog.toLocaleString()}`
  const purged =
    maintenance.purged === undefined ? undefined : `${labels.purged}: ${maintenance.purged.toLocaleString()}`
  const oldestEligible = maintenance.oldestEligibleAt
    ? `${labels.oldestEligible}: ${formatTime(maintenance.oldestEligibleAt)}`
    : undefined
  const deferredReason = maintenance.deferredReason ? labels.deferredReasons[maintenance.deferredReason] : undefined
  return (
    [
      maintenance.operation,
      progress,
      backlog,
      purged,
      oldestEligible,
      maintenance.message,
      deferredReason,
      lastSuccess,
      lastFailure,
      nextRun,
    ]
      .filter(Boolean)
      .join(" - ") || undefined
  )
}
