import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"

// Feature 3 — Automations UI proof. The panel lists automations with trigger
// summary, enable badge, and run history; the editor compiles a weekly schedule
// (per-weekday, multiple times) into cron expressions live.
test.use({ video: "on", screenshot: "on" })

const directory = "C:/OpenCode/PreviewAutomations"

test("lists automations and compiles a weekly schedule to cron", async ({ page }) => {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: "proj_preview",
      worktree: directory,
      vcs: "git",
      name: "preview",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [],
    pageMessages: () => ({ items: [] }),
  })

  await page.goto("/preview/automations")

  const panel = page.locator('[data-component="automations-panel"]')
  await expect(panel).toBeVisible()
  await expect(page.locator('[data-component="automation-card"]')).toHaveCount(2)
  await expect(page.locator('[data-automation-id="auto_sample_1"]')).toContainText("Nightly typecheck")
  // Run history is rendered for the sample automation.
  await expect(page.locator('[data-run-id="run_1"]')).toContainText("succeeded")
  await page.waitForTimeout(400)

  // Editor default schedule: Mon-Fri at 09:00 -> one cron expression.
  const compiled = page.locator('[data-slot="compiled-cron"]')
  await expect(compiled).toContainText("0 9 * * 1")
  await expect(compiled).toContainText("0 9 * * 5")

  // Toggle Sunday on -> a Sunday expression appears.
  await page.locator('[data-weekday="0"]').click()
  await expect(compiled).toContainText("0 9 * * 0")

  // Add a second time -> a second batch of expressions appears.
  await page.locator('[data-action="time-add"]').click()
  await expect(compiled).toContainText("0 12 * * 1")
  await page.waitForTimeout(400)

  // Name the automation and save.
  await page.locator('[data-field="automation-name"]').fill("Daily build")
  await page.locator('[data-action="automation-submit"]').click()
  await page.waitForTimeout(300)
})
