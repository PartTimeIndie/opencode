import { mkdirSync } from "node:fs"
import { expect, test, type Locator, type Page, type Route } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"
import { fixture } from "../smoke/session-timeline.fixture"

test.setTimeout(120_000)
test.use({ video: "on", screenshot: "on" })

const directory = "C:/OpenCode/storage-settings"
const server = `http://127.0.0.1:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
const sessionID = "ses_storage_settings"
const screenshotDir = "e2e/test-results/storage-settings"
const gib = 1024 ** 3
const mib = 1024 ** 2

test("storage settings cover cleanup controls and separate production and local migration dry-runs", async ({ page }) => {
  const consoleErrors: string[] = []
  const networkFailures: string[] = []
  const migrationInputs: unknown[] = []
  const cleanupInputs: unknown[] = []
  const storageRequests: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })
  page.on("pageerror", (error) => consoleErrors.push(error.stack ?? error.message))
  page.on("requestfailed", (request) =>
    networkFailures.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`),
  )
  page.on("response", (response) => {
    const url = new URL(response.url())
    if (url.port === (process.env.PLAYWRIGHT_SERVER_PORT ?? "4096") && response.status() >= 400)
      networkFailures.push(`${response.status()} ${response.request().method()} ${url.pathname}`)
  })

  await mockOpenCodeServer(page, {
    directory,
    provider: fixture.provider,
    project: {
      id: "project-storage-settings",
      name: "Storage Settings",
      worktree: directory,
      vcs: "git",
    },
    sessions: [session()],
    pageMessages: () => ({ items: [] }),
    globalConfig: () => ({}),
  })
  await mockStorageApi(page, migrationInputs, cleanupInputs, storageRequests)
  await configurePage(page)

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectAppVisible(page.getByRole("textbox", { name: /Ask anything/i }))
  await page.getByRole("button", { name: "Open settings" }).click()
  const storageTab = page.getByRole("tab", { name: "Storage", exact: true })
  await expectAppVisible(storageTab)
  await storageTab.click()

  const panel = page.locator('[data-component="storage-settings"]')
  await expectAppVisible(panel)
  await expect(panel).toHaveAttribute("data-layout", "grid")
  const footprint = panel.locator('[data-action="settings-storage-footprint"]')
  await expect(metric(footprint, "Active database")).toContainText("1.50 GiB")
  await expect(metric(footprint, "Archives")).toContainText("3.00 GiB")
  await expect(metric(footprint, "Blob store")).toContainText("640.0 MiB")
  await expect(metric(footprint, "Local database")).toContainText("96.0 MiB")
  await expect(metric(footprint, "Snapshots")).toContainText("12.50 GiB")
  await expect(metric(footprint, "Compaction backups")).toContainText("1.25 GiB")
  mkdirSync(screenshotDir, { recursive: true })
  await metric(footprint, "Active database").evaluate((element) => element.scrollIntoView({ block: "center" }))
  await page.screenshot({ path: `${screenshotDir}/desktop-footprint.png` })

  const content = panel.locator('[data-action="settings-storage-content"]')
  await expect(metric(content, "Archived sessions")).toContainText("8,412")
  await expect(metric(content, "Attachment links")).toContainText("14,250")
  await expect(metric(content, "Unique blobs")).toContainText("2,175")
  await expect(metric(content, "Bytes saved")).toContainText("4.50 GiB")

  const health = panel.locator('[data-action="settings-storage-health"]')
  const maintenance = metric(health, "Maintenance")
  await expect(maintenance).toContainText("Idle")
  await expect(maintenance).toContainText("waiting")
  await expect(maintenance).toContainText("127 / 140")
  await expect(maintenance).toContainText("Archived 25 sessions")
  await expect(maintenance).toContainText("Backlog: 13")
  await expect(maintenance).toContainText("Permanently deleted: 42")
  await expect(maintenance).toContainText("Oldest eligible")
  await expect(maintenance).toContainText("Remaining work deferred by the batch limit")
  await expect(maintenance).toContainText("Last success")
  await expect(maintenance).toContainText("Last failure")
  await expect(maintenance).toContainText("archive shard was temporarily busy")
  await expect(maintenance).toContainText("Next run")
  await expect(maintenance.locator("small")).toHaveCSS("white-space", "normal")
  await maintenance.scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${screenshotDir}/desktop-maintenance.png` })

  const retention = panel.locator('[data-action="settings-storage-session-retention"]')
  const retentionToggle = retention.getByRole("switch")
  const retentionDays = retention.getByLabel("Days since last activity")
  await expect(retentionToggle).toBeChecked()
  await expect(retentionDays).toHaveValue("21")
  await retentionDays.fill("30")
  await retentionDays.blur()
  await expect(retentionDays).toHaveValue("30")
  await retention.scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${screenshotDir}/desktop-retention.png` })

  const cleanup = panel.locator('[data-action="settings-storage-cleanup"]')
  const cleanupToggle = cleanup.getByRole("switch")
  const snapshotDays = cleanup.getByLabel("Snapshot retention (days)")
  const backupDays = cleanup.getByLabel("Compaction backup retention (days)")
  const snapshotGiB = cleanup.getByLabel("Snapshot size limit (GiB)")
  const intervalHours = cleanup.getByLabel("Minimum interval (hours)")
  const saveCleanup = cleanup.getByRole("button", { name: "Save cleanup settings" })
  const previewCleanup = cleanup.getByRole("button", { name: "Preview cleanup" })
  const runCleanup = cleanup.getByRole("button", { name: "Clean now" })
  await expect(cleanupToggle).toBeChecked()
  await expect(snapshotDays).toHaveValue("30")
  await expect(backupDays).toHaveValue("60")
  await expect(snapshotGiB).toHaveValue("10")
  await expect(intervalHours).toHaveValue("24")
  await expect(intervalHours).toHaveAttribute("min", "24")
  await expect(saveCleanup).toBeDisabled()
  await expect(runCleanup).toBeDisabled()
  await expect(cleanup).toContainText("Preview with the current settings")

  await cleanup.locator('[data-slot="switch-control"]').click()
  await snapshotDays.fill("45")
  await backupDays.fill("75")
  await snapshotGiB.fill("12.5")
  await intervalHours.fill("48")
  await expect(previewCleanup).toBeDisabled()
  await saveCleanup.click()
  await expect(saveCleanup).toBeDisabled()
  await expect(previewCleanup).toBeEnabled()
  await expect(metric(cleanup, "Automatic cleanup")).toContainText("Disabled")
  await expect(runCleanup).toBeDisabled()

  await previewCleanup.click()
  await expect(cleanup.getByRole("status").filter({ hasText: "Preview:" })).toContainText(
    "2 candidates, 3.75 GiB reclaimable, 1 unknown, 1 locked",
  )
  await expect(runCleanup).toBeEnabled()
  await cleanup.scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${screenshotDir}/desktop-cleanup-preview.png` })

  await intervalHours.fill("72")
  await expect(previewCleanup).toBeDisabled()
  await expect(runCleanup).toBeDisabled()
  await expect(cleanup).toContainText("Save changes and preview again before permanently deleting artifacts")
  await expect(cleanup.getByRole("status").filter({ hasText: "Preview:" })).toHaveCount(0)
  await saveCleanup.click()
  await expect(previewCleanup).toBeEnabled()
  await expect(runCleanup).toBeDisabled()
  await previewCleanup.click()
  await expect(runCleanup).toBeEnabled()

  await runCleanup.click()
  await expect(cleanup.getByRole("status").filter({ hasText: "Cleanup complete:" })).toContainText(
    "2 deleted, 3.75 GiB reclaimed, 0 skipped",
  )
  await expect(runCleanup).toBeDisabled()
  await page.screenshot({ path: `${screenshotDir}/desktop-cleanup-complete.png` })

  const backups = panel.locator('[data-action="settings-storage-backups"]')
  const backup = backups.locator('[role="radio"]').first()
  await backup.scrollIntoViewIfNeeded()
  expect(
    await backup.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    "desktop backup option must not overflow horizontally",
  ).toBe(true)
  await expect(backup.locator("small").first()).toHaveCSS("white-space", "normal")
  await expect(backup).toContainText("C:/OpenCode/backups/opencode.db.pre-storage-v2")
  await page.screenshot({ path: `${screenshotDir}/desktop-backup-retirement.png` })

  const migration = panel.locator('[data-action="settings-storage-migration-dry-run"]')
  const database = migration.getByLabel("Source database")
  await expect(database).toHaveValue("production")
  await expect(metric(migration, "Selected database")).toContainText("Production database")
  await expect(metric(migration, "Selected database")).toContainText("C:/OpenCode/opencode.db")
  await migration.getByRole("button", { name: "Start dry-run" }).click()
  await expect(metric(migration, "Dry-run status")).toContainText("Running")
  await expect(migration.getByRole("button", { name: "Dry-run running..." })).toBeDisabled()

  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(metric(migration, "Dry-run status")).toContainText("Completed")
  await expect(metric(migration, "Expected savings")).toContainText("5.00 GiB")
  await expect(metric(migration, "Archived sessions")).toContainText("8,110")
  await expect(metric(migration, "Checkpointed sessions")).toContainText("8,610")
  await metric(migration, "Dry-run status").evaluate((element) => element.scrollIntoView({ block: "center" }))
  await page.screenshot({ path: `${screenshotDir}/desktop-complete.png` })

  await database.selectOption("local")
  await expect(database).toHaveValue("local")
  await expect(metric(migration, "Selected database")).toContainText("Local-channel database")
  await expect(metric(migration, "Selected database")).toContainText("C:/OpenCode/opencode-local.db")
  await expect(metric(migration, "Dry-run status")).toContainText("Idle")
  await expect(metric(migration, "Dry-run status")).toContainText("No local migration dry-run has started")
  await page.screenshot({ path: `${screenshotDir}/desktop-local-idle.png` })

  await database.selectOption("production")
  await expect(metric(migration, "Dry-run status")).toContainText("Completed")
  await expect(metric(migration, "Selected database")).toContainText("Production database")
  await database.selectOption("local")
  await expect(metric(migration, "Dry-run status")).toContainText("Idle")

  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole("tab", { name: "General", exact: true }).click()
  await storageTab.click()
  await expectAppVisible(panel)
  await expect(panel).toHaveAttribute("data-layout", "stacked")
  await database.selectOption("local")
  await expect(metric(migration, "Selected database")).toContainText("Local-channel database")
  await content.scrollIntoViewIfNeeded()
  await expect(metric(content, "Archived sessions")).toContainText("8,412")
  await expect(metric(content, "Attachment links")).toContainText("14,250")
  expect(
    await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    "mobile storage panel must not overflow horizontally",
  ).toBe(true)
  await page.screenshot({ path: `${screenshotDir}/mobile-content.png` })

  await retention.scrollIntoViewIfNeeded()
  await expect(retentionDays).toHaveValue("30")
  expect(
    await retention.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    "mobile retention controls must not overflow horizontally",
  ).toBe(true)
  await page.screenshot({ path: `${screenshotDir}/mobile-retention.png` })

  await cleanup.scrollIntoViewIfNeeded()
  await expect(cleanupToggle).not.toBeChecked()
  await expect(snapshotDays).toHaveValue("45")
  await expect(backupDays).toHaveValue("75")
  await expect(snapshotGiB).toHaveValue("12.5")
  await expect(intervalHours).toHaveValue("72")
  expect(
    await cleanup.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    "mobile cleanup controls must not overflow horizontally",
  ).toBe(true)
  await page.screenshot({ path: `${screenshotDir}/mobile-cleanup.png` })

  await migration.scrollIntoViewIfNeeded()
  await migration.getByLabel("Snapshot directory (optional)").fill("D:\\OpenCode-Snapshots")
  await migration.getByRole("button", { name: "Start dry-run" }).click()
  await expect(metric(migration, "Dry-run status")).toContainText("Failed")
  await expect(metric(migration, "Dry-run status")).toContainText(
    "Disk preflight stopped safely: 9.0 GiB required, 3.0 GiB available. The live database was not changed.",
  )
  await expect(metric(migration, "Dry-run status").locator("small")).toHaveCSS("white-space", "normal")
  await expect(migration).toContainText("Dry-run only: OpenCode never prepares, activates, or replaces the live database")
  await metric(migration, "Dry-run status").evaluate((element) => element.scrollIntoView({ block: "center" }))
  await page.screenshot({ path: `${screenshotDir}/mobile-preflight-failed.png` })

  expect(migrationInputs).toEqual([
    { databaseKind: "production" },
    { databaseKind: "local", snapshotDirectory: "D:\\OpenCode-Snapshots" },
  ])
  expect(cleanupInputs).toEqual([
    {
      enabled: false,
      snapshotRetentionDays: 45,
      compactionBackupRetentionDays: 75,
      snapshotMaxBytes: 12.5 * gib,
      checkIntervalHours: 48,
    },
    {
      enabled: false,
      snapshotRetentionDays: 45,
      compactionBackupRetentionDays: 75,
      snapshotMaxBytes: 12.5 * gib,
      checkIntervalHours: 72,
    },
  ])
  expect(storageRequests).toContain("GET /app/storage/migration/status?database=production")
  expect(storageRequests).toContain("GET /app/storage/migration/status?database=local")
  expect(storageRequests).toContain("PATCH /app/storage/retention")
  expect(storageRequests).toContain("PATCH /app/storage/cleanup/config")
  expect(storageRequests).toContain("GET /app/storage/cleanup/preview")
  expect(storageRequests).toContain("POST /app/storage/cleanup/run")
  expect(storageRequests.some((request) => request.includes("activate") || request.includes("prepare"))).toBe(false)
  expect(consoleErrors).toEqual([])
  expect(networkFailures).toEqual([])
})

function metric(section: Locator, label: string) {
  return section.locator(".storage-v2-card").filter({ hasText: label })
}

async function configurePage(page: Page) {
  await page.addInitScript(
    ({ dir, dirBase64, serverKey, session }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem("opencode.global.dat:language", JSON.stringify({ locale: "en" }))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { [serverKey]: [{ worktree: dir, expanded: true }] },
          lastProject: { [serverKey]: dir },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", server: serverKey, dirBase64, sessionId: session }]),
      )
    },
    { dir: directory, dirBase64: base64Encode(directory), serverKey: server, session: sessionID },
  )
}

async function mockStorageApi(
  page: Page,
  migrationInputs: unknown[],
  cleanupInputs: unknown[],
  storageRequests: string[],
) {
  let retention = { enabled: true, inactivityDays: 21, defaultInactivityDays: 21 }
  let cleanupSettings = {
    enabled: true,
    snapshotRetentionDays: 30,
    compactionBackupRetentionDays: 60,
    snapshotMaxBytes: 10 * gib,
    checkIntervalHours: 24,
  }
  const migrationStatuses: Record<"production" | "local", Record<string, unknown>> = {
    production: {
      state: "idle",
      databaseKind: "production",
      sourceDatabase: "C:/OpenCode/opencode.db",
      message: "No production migration dry-run has started.",
    },
    local: {
      state: "idle",
      databaseKind: "local",
      sourceDatabase: "C:/OpenCode/opencode-local.db",
      message: "No local migration dry-run has started.",
    },
  }
  const completeOnRead = new Set<"production" | "local">()
  await page.route("**/app/storage/**", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    storageRequests.push(`${request.method()} ${url.pathname}${url.search}`)
    if (request.method() === "OPTIONS")
      return route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
          "access-control-allow-headers": "content-type, authorization",
        },
      })
    if (request.method() === "GET" && url.pathname === "/app/storage/status")
      return json(route, storageStatus(retention, cleanupSettings))
    if (request.method() === "PATCH" && url.pathname === "/app/storage/cleanup/config") {
      cleanupSettings = request.postDataJSON()
      cleanupInputs.push(cleanupSettings)
      return json(route, { settings: cleanupSettings, status: cleanupStatus(cleanupSettings) })
    }
    if (request.method() === "GET" && url.pathname === "/app/storage/cleanup/preview")
      return json(route, cleanupPreview())
    if (request.method() === "POST" && url.pathname === "/app/storage/cleanup/run") {
      const input = request.postDataJSON()
      if (input.previewToken !== cleanupPreview().previewToken)
        return json(route, { error: "Preview cleanup before permanent deletion" }, 409)
      return json(route, cleanupResult())
    }
    if (request.method() === "PATCH" && url.pathname === "/app/storage/retention") {
      retention = { ...request.postDataJSON(), defaultInactivityDays: 21 }
      return json(route, retention)
    }
    if (request.method() === "GET" && url.pathname === "/app/storage/migration/status") {
      const databaseKind = url.searchParams.get("database")
      if (databaseKind !== "production" && databaseKind !== "local")
        return json(route, { error: "Expected production or local database" }, 400)
      if (completeOnRead.delete(databaseKind)) {
        migrationStatuses[databaseKind] = completedMigration(databaseKind)
      }
      return json(route, migrationStatuses[databaseKind])
    }
    if (request.method() === "POST" && url.pathname === "/app/storage/migration/dry-run") {
      const input = request.postDataJSON()
      migrationInputs.push(input)
      if (input.databaseKind === "production") {
        migrationStatuses.production = {
          state: "running",
          databaseKind: "production",
          sourceDatabase: "C:/OpenCode/opencode.db",
          id: "migration-storage-qa",
          stagingDirectory: "C:/OpenCode/staging/storage-qa",
          message: "Externalizing attachments and checkpointing sessions.",
        }
        completeOnRead.add("production")
        return json(route, migrationStatuses.production)
      }
      if (input.databaseKind !== "local") return json(route, { error: "Unexpected database kind" }, 400)
      migrationStatuses.local = {
        state: "failed",
        databaseKind: "local",
        sourceDatabase: "C:/OpenCode/opencode-local.db",
        id: "migration-storage-preflight",
        snapshotDirectory: "D:/OpenCode-Snapshots",
        message: "Disk preflight stopped safely: 9.0 GiB required, 3.0 GiB available. The live database was not changed.",
      }
      return json(route, migrationStatuses.local)
    }
    return json(route, { error: `Unexpected storage request: ${request.method()} ${url.pathname}` }, 405)
  })
}

function storageStatus(
  retention = { enabled: true, inactivityDays: 21, defaultInactivityDays: 21 },
  cleanupSettings = {
    enabled: true,
    snapshotRetentionDays: 30,
    compactionBackupRetentionDays: 60,
    snapshotMaxBytes: 10 * gib,
    checkIntervalHours: 24,
  },
) {
  return {
    activeDatabase: { bytes: 1.5 * gib, path: "C:/OpenCode/opencode.db" },
    archives: { bytes: 3 * gib, path: "C:/OpenCode/archives", shards: 2 },
    blobStore: { bytes: 640 * mib, path: "C:/OpenCode/content", blobs: 2_175 },
    localDatabase: { bytes: 96 * mib, path: "C:/OpenCode/opencode-local.db" },
    snapshots: { bytes: 12.5 * gib, path: "C:/OpenCode/snapshot", files: 31 },
    compactionBackups: { bytes: 1.25 * gib, path: "C:/OpenCode", files: 4 },
    backups: [
      {
        id: "opencode.db.pre-storage-v2",
        path: "C:/OpenCode/backups/opencode.db.pre-storage-v2",
        bytes: 2 * gib,
        modifiedAt: 1_783_930_800_000,
        retireAfter: 1_785_140_400_000,
        retirementEligible: false,
      },
    ],
    sessions: { active: 198, archived: 8_412 },
    retention,
    cleanup: { settings: cleanupSettings, status: cleanupStatus(cleanupSettings) },
    deduplication: { attachments: 14_250, uniqueBlobs: 2_175, savedBytes: 4.5 * gib },
    manifest: { state: "ready", updatedAt: "2026-07-13T12:00:00.000Z", message: "Storage manifest verified." },
    maintenance: {
      state: "idle",
      operation: "waiting",
      completed: 127,
      total: 140,
      message: "Archived 25 sessions; remaining work was deferred by the batch limit",
      schedulerActive: true,
      runs: 140,
      archived: 127,
      purged: 42,
      idle: 10,
      deferred: 2,
      failed: 1,
      backlog: 13,
      oldestEligibleAt: 1_783_800_000_000,
      deferredReason: "batch-limit",
      lastStartedAt: 1_784_000_000_000,
      lastFinishedAt: 1_784_000_001_200,
      lastSucceededAt: 1_784_000_001_200,
      lastFailedAt: 1_783_913_600_000,
      nextRunAt: 1_784_086_400_000,
      lastFailure: "archive shard was temporarily busy",
    },
  }
}

function cleanupStatus(settings: { enabled: boolean }) {
  return {
    version: 1,
    state: "idle",
    enabled: settings.enabled,
    due: false,
    nextRunAt: 1_788_793_200_000,
    statusPath: "C:/OpenCode/state/opencode-storage-cleanup.json",
    lastSucceededAt: 1_788_706_800_000,
    lastResult: {
      deletedArtifacts: 3,
      deletedBytes: 2.5 * gib,
      removedEmptyContainers: 1,
      skipped: 0,
      unknown: 1,
      snapshotBytesBefore: 15 * gib,
    },
  }
}

function cleanupPreview() {
  return {
    previewToken: "storage-cleanup-preview-token",
    generatedAt: 1_788_793_200_000,
    snapshots: { path: "C:/OpenCode/snapshot", repositories: 31, bytes: 12.5 * gib, emptyContainers: 1 },
    compactionBackups: { files: 4, bytes: 1.25 * gib, protected: 1 },
    candidates: [
      {
        kind: "snapshot",
        path: "C:/OpenCode/snapshot/project-old/repository-old",
        bytes: 3.5 * gib,
        modifiedAt: 1_780_000_000_000,
        reason: "expired",
        layout: "project",
        projectPath: "C:/OpenCode/snapshot/project-old",
      },
      {
        kind: "compaction-backup",
        path: "C:/OpenCode/opencode.db.bak-event-compaction-2026-01-01T00-00-00-000Z",
        bytes: 0.25 * gib,
        modifiedAt: 1_767_225_600_000,
        reason: "expired",
      },
    ],
    reclaimableBytes: 3.75 * gib,
    unknown: [{ path: "C:/OpenCode/snapshot/manual", reason: "unrecognized snapshot entry" }],
    locked: [{ path: "C:/OpenCode/snapshot/project-live/repository-live", reason: "repository-lock" }],
  }
}

function cleanupResult() {
  const { previewToken: _, ...preview } = cleanupPreview()
  return {
    outcome: "completed",
    automatic: false,
    startedAt: preview.generatedAt,
    completedAt: preview.generatedAt + 1_000,
    inventory: preview,
    deleted: preview.candidates,
    deletedBytes: preview.reclaimableBytes,
    removedEmptyContainers: 1,
    skipped: [],
  }
}

function completedMigration(databaseKind: "production" | "local") {
  return {
    state: "completed",
    databaseKind,
    sourceDatabase:
      databaseKind === "production" ? "C:/OpenCode/opencode.db" : "C:/OpenCode/opencode-local.db",
    id: "migration-storage-qa",
    stagingDirectory: "C:/OpenCode/staging/storage-qa",
    updatedAt: "2026-07-13T12:10:00.000Z",
    message: "Dry-run candidate passed replay, paging, and attachment integrity checks.",
    report: {
      sourceBytes: 7 * gib,
      candidateBytes: 2 * gib,
      savedBytes: 5 * gib,
      archivedSessions: 8_110,
      checkpointedSessions: 8_610,
      quarantineCount: 0,
    },
  }
}

function session() {
  return {
    id: sessionID,
    slug: sessionID,
    projectID: "project-storage-settings",
    directory,
    title: "Storage Settings QA",
    version: "dev",
    time: { created: 1_783_930_800_000, updated: 1_783_930_800_000 },
  }
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type, authorization",
    },
    body: JSON.stringify(body),
  })
}
