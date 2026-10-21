import { mkdirSync, writeFileSync } from "node:fs"
import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"
import { fixture } from "../smoke/session-timeline.fixture"

const directory = "C:/OpenCode/optimization-settings-toggle"
const server = "http://127.0.0.1:4096"
const sessionID = "ses_optimization_settings_toggle"
const screenshotDir = "e2e/test-results/optimization-settings-toggle"

test("optimization settings master off disables effective toggles", async ({ page }) => {
  const configUpdates: unknown[] = []
  let globalConfig: Record<string, unknown> = { optimization: { profile: "speed" } }
  const pageErrors: string[] = []
  const networkFailures: string[] = []
  page.on("pageerror", (error) => pageErrors.push(error.message))
  page.on("requestfailed", (request) =>
    networkFailures.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`),
  )
  page.on("response", (response) => {
    if (response.status() >= 400) networkFailures.push(`${response.status()} ${response.url()}`)
  })

  await mockOpenCodeServer(page, {
    directory,
    provider: fixture.provider,
    project: { id: "project-optimization-settings-toggle", name: "Optimization Settings", worktree: directory, vcs: "git" },
    sessions: [session()],
    pageMessages: () => ({ items: [] }),
    globalConfig: () => globalConfig,
    onGlobalConfigUpdate: (body) => {
      configUpdates.push(body)
      globalConfig = { ...globalConfig, ...(body as Record<string, unknown>) }
      return globalConfig
    },
  })

  await page.addInitScript(
    ({ dir, dirBase64, serverKey }) => {
      localStorage.setItem(
        "settings.v3",
        JSON.stringify({
          optimizations: { optimizationProfile: "safe", sessionTabPrefetch: true },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { [serverKey]: [{ worktree: dir, expanded: true }] }, lastProject: { [serverKey]: dir } }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", server: serverKey, dirBase64, sessionId: "ses_optimization_settings_toggle" }]),
      )
    },
    { dir: directory, dirBase64: base64Encode(directory), serverKey: server },
  )

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectAppVisible(page.getByRole("textbox", { name: /Ask anything/i }))

  await page.evaluate(() => {
    const event = new KeyboardEvent("keydown", { key: ",", ctrlKey: true, bubbles: true, cancelable: true })
    document.dispatchEvent(event)
  })
  await expectAppVisible(page.getByRole("tab", { name: "Optimizations" }))
  await page.getByRole("tab", { name: "Optimizations" }).click()

  const profile = page.locator('[data-action="settings-optimization-profile"] [data-component="select-v2"]')
  expect(await page.evaluate(async (url) => (await fetch(`${url}/global/config`)).json(), server)).toMatchObject({
    optimization: { profile: "speed" },
  })
  await expect(profile).toContainText("Speed")
  await profile.click()
  await page.locator('[data-slot="select-v2-listbox"] [role="option"]').filter({ hasText: "Off" }).click()
  await expect(profile).toContainText("Off")

  await expect
    .poll(() =>
      page.evaluate(() => {
        const settings = JSON.parse(localStorage.getItem("settings.v3") ?? "{}") as {
          optimizations?: { optimizationProfile?: string }
        }
        return settings.optimizations?.optimizationProfile
      }),
    )
    .toBe("off")
  await expect.poll(() => configUpdates.length).toBeGreaterThan(0)

  const lastConfigUpdate = configUpdates.at(-1) as { optimization?: { profile?: string; features?: Record<string, boolean> } }
  expect(lastConfigUpdate.optimization?.profile).toBe("off")
  expect(Object.values(lastConfigUpdate.optimization?.features ?? {}).every((value) => value === false)).toBe(true)

  const sessionPrefetchInput = page.locator(
    '[data-action="settings-optimization-session-tab-prefetch"] [data-slot="switch-input"]',
  )
  await expect(sessionPrefetchInput).not.toBeChecked()
  await expect(sessionPrefetchInput).toBeDisabled()

  await profile.click()
  await page.locator('[data-slot="select-v2-listbox"] [role="option"]').filter({ hasText: "Safe" }).click()
  await expect(profile).toContainText("Safe")
  await expect(sessionPrefetchInput).toBeChecked()
  await expect(sessionPrefetchInput).not.toBeDisabled()

  await page.locator('[data-action="settings-optimization-session-tab-prefetch"] [data-component="switch"]').click()
  await expect(sessionPrefetchInput).not.toBeChecked()
  await expect
    .poll(() =>
      page.evaluate(() => {
        const settings = JSON.parse(localStorage.getItem("settings.v3") ?? "{}") as {
          optimizations?: { sessionTabPrefetch?: boolean }
        }
        return settings.optimizations?.sessionTabPrefetch
      }),
    )
    .toBe(false)

  // A profile selection is a true preset: switching to Speed must write the canonical
  // speed features instead of serializing the current local toggles as overrides.
  const materializationInput = page.locator(
    '[data-action="settings-optimization-tool-materialization-cache"] [data-slot="switch-input"]',
  )
  const updatesBeforeSpeed = configUpdates.length
  await profile.click()
  await page.locator('[data-slot="select-v2-listbox"] [role="option"]').filter({ hasText: "Speed" }).click()
  await expect(profile).toContainText("Speed")
  await expect(materializationInput).toBeChecked()
  await expect.poll(() => configUpdates.length).toBeGreaterThan(updatesBeforeSpeed)
  const speedUpdate = configUpdates.at(-1) as { optimization?: { profile?: string; features?: Record<string, boolean> } }
  expect(speedUpdate.optimization?.profile).toBe("speed")
  expect(speedUpdate.optimization?.features).toEqual({
    core_search_limits: true,
    tool_materialization_cache: true,
    runner_request_metrics: true,
    tool_context_compression: true,
  })

  // Reload: the persisted server payload hydrates the same preset.
  await page.reload()
  await expectAppVisible(page.getByRole("textbox", { name: /Ask anything/i }))
  await page.evaluate(() => {
    const event = new KeyboardEvent("keydown", { key: ",", ctrlKey: true, bubbles: true, cancelable: true })
    document.dispatchEvent(event)
  })
  await expectAppVisible(page.getByRole("tab", { name: "Optimizations" }))
  await page.getByRole("tab", { name: "Optimizations" }).click()
  const profileAfterReload = page.locator('[data-action="settings-optimization-profile"] [data-component="select-v2"]')
  await expect(profileAfterReload).toContainText("Speed")
  await expect(materializationInput).toBeChecked()

  // From the reloaded speed state, Safe writes the canonical safe preset.
  const updatesBeforeSafe = configUpdates.length
  await profileAfterReload.click()
  await page.locator('[data-slot="select-v2-listbox"] [role="option"]').filter({ hasText: "Safe" }).click()
  await expect(profileAfterReload).toContainText("Safe")
  await expect(materializationInput).not.toBeChecked()
  await expect.poll(() => configUpdates.length).toBeGreaterThan(updatesBeforeSafe)
  const safeUpdate = configUpdates.at(-1) as { optimization?: { profile?: string; features?: Record<string, boolean> } }
  expect(safeUpdate.optimization?.profile).toBe("safe")
  expect(safeUpdate.optimization?.features).toEqual({
    core_search_limits: true,
    tool_materialization_cache: false,
    runner_request_metrics: true,
    tool_context_compression: true,
  })
  expect(await page.evaluate(async (url) => (await fetch(`${url}/global/config`)).json(), server)).toMatchObject({
    optimization: { profile: "safe", features: safeUpdate.optimization?.features },
  })

  mkdirSync(screenshotDir, { recursive: true })
  writeFileSync(`${screenshotDir}/config-updates.json`, JSON.stringify(configUpdates, null, 2))
  await page.screenshot({ path: `${screenshotDir}/desktop.png`, fullPage: true })
  expect(pageErrors).toEqual([])
  // Requests still in flight are aborted when the page closes after the reload.
  expect(networkFailures.filter((failure) => !failure.endsWith(" net::ERR_ABORTED"))).toEqual([])
})

test("tool context compression switch is default on, server-synced and retired rows are gone", async ({ page }) => {
  const configUpdates: unknown[] = []
  const optimizationUpdates = () =>
    configUpdates.filter((update) => update && typeof update === "object" && "optimization" in update)
  let globalConfig: Record<string, unknown> = {}
  const pageErrors: string[] = []
  const networkFailures: string[] = []
  page.on("pageerror", (error) => pageErrors.push(error.message))
  page.on("requestfailed", (request) =>
    networkFailures.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`),
  )
  page.on("response", (response) => {
    if (response.status() >= 400) networkFailures.push(`${response.status()} ${response.url()}`)
  })

  await mockOpenCodeServer(page, {
    directory,
    provider: fixture.provider,
    project: { id: "project-optimization-settings-toggle", name: "Optimization Settings", worktree: directory, vcs: "git" },
    sessions: [session()],
    pageMessages: () => ({ items: [] }),
    globalConfig: () => globalConfig,
    onGlobalConfigUpdate: (body) => {
      configUpdates.push(body)
      globalConfig = { ...globalConfig, ...(body as Record<string, unknown>) }
      return globalConfig
    },
  })

  await page.addInitScript(
    ({ dir, dirBase64, serverKey }) => {
      localStorage.setItem(
        "settings.v3",
        JSON.stringify({
          optimizations: {
            optimizationProfile: "safe",
            readDeduplication: false,
            deferredToolDiscovery: true,
            batchCoreTools: false,
          },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { [serverKey]: [{ worktree: dir, expanded: true }] }, lastProject: { [serverKey]: dir } }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", server: serverKey, dirBase64, sessionId: "ses_optimization_settings_toggle" }]),
      )
    },
    { dir: directory, dirBase64: base64Encode(directory), serverKey: server },
  )

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectAppVisible(page.getByRole("textbox", { name: /Ask anything/i }))

  await page.evaluate(() => {
    const event = new KeyboardEvent("keydown", { key: ",", ctrlKey: true, bubbles: true, cancelable: true })
    document.dispatchEvent(event)
  })
  await expectAppVisible(page.getByRole("tab", { name: "Optimizations" }))
  await page.getByRole("tab", { name: "Optimizations" }).click()

  // Without an authoritative optimization payload, local defaults must not appear as
  // editable server state or accept writes.
  const compression = page.locator('[data-action="settings-optimization-tool-context-compression"] [data-slot="switch-input"]')
  const compressionSwitch = page.locator(
    '[data-action="settings-optimization-tool-context-compression"] [data-component="switch"]',
  )
  const profile = page.locator('[data-action="settings-optimization-profile"] [data-component="select-v2"]')
  await expect(compression).toBeVisible()
  await expect(profile).toHaveAttribute("data-disabled", "")
  await expect(compression).toBeDisabled()
  await expect(compression).not.toBeChecked()
  const storedCompression = () =>
    page.evaluate(() => {
      const settings = JSON.parse(localStorage.getItem("settings.v3") ?? "{}") as {
        optimizations?: { toolContextCompression?: boolean }
      }
      return settings.optimizations?.toolContextCompression
    })
  const storedCompressionBeforeClick = await storedCompression()
  await compressionSwitch.click({ force: true })
  await expect(compression).not.toBeChecked()
  expect(optimizationUpdates()).toEqual([])
  expect(await storedCompression()).toBe(storedCompressionBeforeClick)

  globalConfig = { optimization: { profile: "safe" } }
  await page.reload()
  await expectAppVisible(page.getByRole("textbox", { name: /Ask anything/i }))
  await page.evaluate(() => {
    const event = new KeyboardEvent("keydown", { key: ",", ctrlKey: true, bubbles: true, cancelable: true })
    document.dispatchEvent(event)
  })
  await expectAppVisible(page.getByRole("tab", { name: "Optimizations" }))
  await page.getByRole("tab", { name: "Optimizations" }).click()
  await expect(profile).toContainText("Safe")
  await expect(profile).not.toHaveAttribute("data-disabled", "")
  await expect(compression).toBeChecked()
  await expect(compression).not.toBeDisabled()

  await compressionSwitch.click()
  await expect(compression).not.toBeChecked()
  await expect
    .poll(() =>
      page.evaluate(() => {
        const settings = JSON.parse(localStorage.getItem("settings.v3") ?? "{}") as {
          optimizations?: { toolContextCompression?: boolean }
        }
        return settings.optimizations?.toolContextCompression
      }),
    )
    .toBe(false)
  await expect.poll(() => optimizationUpdates().length).toBeGreaterThan(0)
  const lastConfigUpdate = optimizationUpdates().at(-1) as { optimization?: { features?: Record<string, boolean> } }
  expect(lastConfigUpdate.optimization?.features?.tool_context_compression).toBe(false)

  // retired controls must not resurface
  for (const retired of [
    "settings-optimization-deferred-tool-discovery",
    "settings-optimization-compact-tool-schemas",
    "settings-optimization-patch-verify-tool",
    "settings-optimization-batch-core-tools",
    "settings-optimization-read-deduplication",
    "settings-optimization-stable-tool-output-preview",
  ]) {
    await expect(page.locator(`[data-action="${retired}"]`)).toHaveCount(0)
  }

  expect(pageErrors).toEqual([])
  // Reloading the document can abort telemetry that is still in flight.
  expect(networkFailures.filter((failure) => failure !== `POST ${server}/perf/record net::ERR_ABORTED`)).toEqual([])
})

function session() {
  return {
    id: sessionID,
    slug: sessionID,
    projectID: "project-optimization-settings-toggle",
    directory,
    title: "Optimization Settings Session",
    version: "dev",
    time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
  }
}
