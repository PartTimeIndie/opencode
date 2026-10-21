import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/SessionRestoreErrorQA"
const projectID = "proj_session_restore_error_qa"
const staleID = "ses_session_restore_stale"
const healthyID = "ses_session_restore_healthy"
const server = "http://127.0.0.1:4096"

test("recovers a transient initial session load without showing an error", async ({ page }) => {
  let attempts = 0
  await mockOpenCodeServer(page, {
    directory,
    project: project(),
    provider: provider(),
    sessions: [session(staleID, "Temporarily unavailable session")],
    pageMessages: (sessionID) => ({ items: messages(sessionID) }),
  })
  await page.route("**/api/session/*/message*", (route) => {
    if (!route.request().url().includes(`/api/session/${staleID}/message`)) return route.fallback()
    attempts += 1
    if (attempts > 1) return route.fallback()
    return route.fulfill({
      status: 503,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ error: "Location sidecar temporarily unavailable" }),
    })
  })
  await configurePage(page, [staleID])

  await page.goto("/")
  await expectAppVisible(page.getByText("Recovered stale session content."))
  await expect(page.getByTestId("session-load-error")).toHaveCount(0)
  expect(attempts).toBeGreaterThanOrEqual(2)
})

test("isolates an unavailable restored session tab and keeps healthy tabs usable", async ({ page }) => {
  const pageErrors: string[] = []
  page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message))
  let staleAvailable = false

  await mockOpenCodeServer(page, {
    directory,
    project: project(),
    provider: provider(),
    sessions: [session(staleID, "Unavailable restored session"), session(healthyID, "Healthy restored session")],
    pageMessages: (sessionID) => ({ items: messages(sessionID) }),
  })
  await page.route("**/api/session/*/message*", (route) => {
    if (!route.request().url().includes(`/api/session/${staleID}/message`) || staleAvailable) return route.fallback()
    return route.fulfill({
      status: 503,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ error: "Location sidecar unavailable" }),
    })
  })
  await configurePage(page, [staleID, healthyID])

  await page.goto("/")
  await expectAppVisible(page.getByTestId("session-load-error"))
  await expect(page.getByText("Something went wrong")).toHaveCount(0)
  await expect(sessionTab(page, staleID)).toBeVisible()
  await expect(sessionTab(page, healthyID)).toBeVisible()

  await sessionTab(page, healthyID).click()
  await expectAppVisible(page.getByText("Healthy session content."))
  await expect(page.getByTestId("session-load-error")).toHaveCount(0)

  await sessionTab(page, staleID).click()
  await expectAppVisible(page.getByTestId("session-load-error"))
  staleAvailable = true
  await page.getByRole("button", { name: "Retry" }).click()
  await expectAppVisible(page.getByText("Recovered stale session content."))
  await expect(page.getByTestId("session-load-error")).toHaveCount(0)

  staleAvailable = false
  await page.reload()
  await expectAppVisible(page.getByTestId("session-load-error"))
  await page.getByRole("button", { name: "Close tab" }).click()
  await expect(sessionTab(page, staleID)).toHaveCount(0)
  await expectAppVisible(page.getByText("Healthy session content."))
  await expect(sessionTab(page, healthyID)).toHaveAttribute("aria-selected", "true")
  await expect(page.getByText("Something went wrong")).toHaveCount(0)
  expect(pageErrors).toEqual([])
})

async function configurePage(page: Page, sessionIDs: string[]) {
  await page.addInitScript(
    ({ directory, dirBase64, server, sessionIDs, staleID }) => {
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify(
          sessionIDs.map((sessionId) => ({
            type: "session",
            server,
            dirBase64,
            sessionId,
          })),
        ),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs.recent",
        JSON.stringify({ key: `${server}\n${dirBase64}\n${staleID}` }),
      )
    },
    { directory, dirBase64: base64Encode(directory), server, sessionIDs, staleID },
  )
}

function sessionTab(page: Page, sessionID: string) {
  return page.locator(`[data-dock-tab][data-session-id="${sessionID}"]`).getByRole("tab")
}

function project() {
  return {
    id: projectID,
    worktree: directory,
    vcs: "git",
    name: "session-restore-error-qa",
    time: { created: 1700000000000, updated: 1700000000000 },
    sandboxes: [],
  }
}

function session(id: string, title: string) {
  return {
    id,
    slug: id,
    projectID,
    directory,
    title,
    version: "dev",
    time: { created: 1700000000000, updated: 1700000000000 },
  }
}

function messages(sessionID: string) {
  const messageID = `${sessionID}_user`
  return [
    {
      info: {
        id: messageID,
        sessionID,
        role: "user",
        time: { created: 1700000000000 },
        summary: { diffs: [] },
        agent: "build",
        model: { providerID: "opencode", modelID: "claude-opus-4-6", variant: "max" },
      },
      parts: [
        {
          id: `${messageID}_text`,
          sessionID,
          messageID,
          type: "text",
          text: sessionID === staleID ? "Recovered stale session content." : "Healthy session content.",
        },
      ],
    },
  ]
}

function provider() {
  return {
    all: [
      {
        id: "opencode",
        name: "OpenCode",
        models: {
          "claude-opus-4-6": {
            id: "claude-opus-4-6",
            name: "Claude Opus 4.6",
            limit: { context: 200_000 },
          },
        },
      },
    ],
    connected: ["opencode"],
    default: { providerID: "opencode", modelID: "claude-opus-4-6" },
  }
}
