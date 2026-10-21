import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { trackPageErrors, expectNoSmokeErrors } from "../utils/errors"
import { expectAppVisible } from "../utils/waits"

test.use({ video: "on", screenshot: "on" })

const directory = "C:/OpenCode/AccessModeSwitch"
const projectID = "proj_access_mode_switch"
const sessionID = "ses_access_mode_switch"

test("switches access mode during a busy session without aborting it", async ({ page }) => {
  const errors = trackPageErrors(page)
  const aborts: string[] = []

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "access-mode-switch",
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
    sessions: [
      {
        id: sessionID,
        slug: "access-mode-switch",
        projectID,
        directory,
        title: "Access mode switch",
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    sessionStatus: { [sessionID]: { type: "busy" } },
    pageMessages: () => ({ items: [] }),
  })
  await page.route(/\/session\/[^/]+\/abort(?:\?|$)/, (route) => {
    aborts.push(route.request().url())
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(true),
    })
  })
  await page.addInitScript(
    ({ directory, dirBase64, sessionID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] }, lastProject: { local: directory } }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", server: "http://127.0.0.1:4096", dirBase64, sessionId: sessionID }]),
      )
    },
    { directory, dirBase64: base64Encode(directory), sessionID },
  )

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)

  const composer = page.locator('[data-component="session-composer"]')
  const submit = page.locator('[data-action="prompt-submit"]')
  await expectAppVisible(composer)
  await expect(submit).toHaveAttribute("aria-label", /Stop|Stopp/)

  await page.getByRole("button", { name: "Access control" }).click()
  await page.getByRole("menuitemradio", { name: /Full access/ }).click()

  await expect(page.getByRole("button", { name: "Access control" })).toContainText("Full access")
  await expect(submit).toHaveAttribute("aria-label", /Stop|Stopp/)
  expect(aborts).toEqual([])
  await page.screenshot({ path: "e2e/test-results/access-mode-switch-busy.png", fullPage: true })
  expectNoSmokeErrors(errors, [], [])
})
