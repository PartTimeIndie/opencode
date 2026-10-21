import { mkdirSync, writeFileSync } from "node:fs"
import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"
import { fixture } from "../smoke/session-timeline.fixture"

const directory = "C:/OpenCode/logging-settings-toggle"
const server = "http://127.0.0.1:4096"
const sessionID = "ses_logging_settings_toggle"
const screenshotDir = "e2e/test-results/logging-settings-toggle"

test("logging settings toggle profile and emit perf events", async ({ page }) => {
  const configUpdates: unknown[] = []
  const perfRecords: unknown[] = []
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
    project: { id: "project-logging-settings-toggle", name: "Logging Settings", worktree: directory, vcs: "git" },
    sessions: [session()],
    pageMessages: () => ({ items: [] }),
    globalConfig: () => ({}),
    onGlobalConfigUpdate: (body) => {
      configUpdates.push(body)
      return body
    },
    onPerfRecord: (body) => {
      perfRecords.push(body)
      return { accepted: Array.isArray((body as { events?: unknown[] })?.events) ? (body as { events: unknown[] }).events.length : 0 }
    },
  })

  await page.addInitScript(
    ({ dir, dirBase64, serverKey }) => {
      localStorage.setItem(
        "settings.v3",
        JSON.stringify({
          logging: { loggingProfile: "verbose", trace: true, performance: true, interrupts: true, optimization: true, ui: true },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { [serverKey]: [{ worktree: dir, expanded: true }] }, lastProject: { [serverKey]: dir } }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", server: serverKey, dirBase64, sessionId: "ses_logging_settings_toggle" }]),
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
  const loggingTab = page.getByRole("tab", { name: "Logging", exact: true })
  await expectAppVisible(loggingTab)
  await expect(loggingTab.locator("use")).toHaveAttribute("href", "#opencode-icon-logging")
  await loggingTab.click()

  const profile = page.locator('[data-action="settings-logging-profile"] [data-component="select-v2"]')
  await expect(profile).toContainText("Verbose")
  await profile.click()
  await page.locator('[data-slot="select-v2-listbox"] [role="option"]').filter({ hasText: "Off" }).click()
  await expect(profile).toContainText("Off")

  await expect
    .poll(() =>
      page.evaluate(() => {
        const settings = JSON.parse(localStorage.getItem("settings.v3") ?? "{}") as { logging?: { loggingProfile?: string } }
        return settings.logging?.loggingProfile
      }),
    )
    .toBe("off")
  await expect.poll(() => configUpdates.length).toBeGreaterThan(0)

  const lastConfigUpdate = configUpdates.at(-1) as { logging?: { profile?: string; features?: Record<string, boolean> } }
  expect(lastConfigUpdate.logging?.profile).toBe("off")
  expect(Object.values(lastConfigUpdate.logging?.features ?? {}).every((value) => value === false)).toBe(true)

  const uiInput = page.locator('[data-action="settings-logging-ui"] [data-slot="switch-input"]')
  await expect(uiInput).not.toBeChecked()
  await expect(uiInput).toBeDisabled()

  await profile.click()
  await page.locator('[data-slot="select-v2-listbox"] [role="option"]').filter({ hasText: "Verbose" }).click()
  await expect(profile).toContainText("Verbose")
  await expect(uiInput).toBeChecked()
  await expect(uiInput).not.toBeDisabled()

  await page.locator('[data-action="settings-logging-ui"] [data-component="switch"]').click()
  await expect(uiInput).not.toBeChecked()
  await expect
    .poll(() =>
      page.evaluate(() => {
        const settings = JSON.parse(localStorage.getItem("settings.v3") ?? "{}") as { logging?: { ui?: boolean } }
        return settings.logging?.ui
      }),
    )
    .toBe(false)
  await expect.poll(() => perfRecords.length).toBeGreaterThan(0)

  mkdirSync(screenshotDir, { recursive: true })
  writeFileSync(`${screenshotDir}/config-updates.json`, JSON.stringify(configUpdates, null, 2))
  writeFileSync(`${screenshotDir}/perf-records.json`, JSON.stringify(perfRecords, null, 2))
  await page.screenshot({ path: `${screenshotDir}/desktop.png`, fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(loggingTab).toBeVisible()
  await page.screenshot({ path: `${screenshotDir}/mobile.png`, fullPage: true })
  expect(pageErrors).toEqual([])
  expect(networkFailures).toEqual([])
})

function session() {
  return {
    id: sessionID,
    slug: sessionID,
    projectID: "project-logging-settings-toggle",
    directory,
    title: "Logging Settings Session",
    version: "dev",
    time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
  }
}
