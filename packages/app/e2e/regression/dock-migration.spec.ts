import { expect, test, type Page } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"
import { trackPageErrors, expectNoSmokeErrors } from "../utils/errors"

const directory = "C:/OpenCode/DockMigrationQA"
const projectID = "proj_dock_migration_qa"
const sessionID = "ses_dock_migration_qa"
const title = "Dock migration QA"
const server = "http://127.0.0.1:4096"

test.describe("migration: legacy layout state", () => {
  test("migrates legacy terminal/review/fileTree state into the dock once", async ({ page }) => {
    const errors = trackPageErrors(page)
    await mockOpenCodeServer(page, {
      directory,
      project: project(),
      provider: provider(),
      sessions: [session()],
      pageMessages: () => ({ items: messages() }),
    })
    await configureLegacyState(page)

    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto("/")
    await expectAppVisible(dockSessionTab(page))

    // Legacy terminal.opened: true → bottom dock visible.
    await expectAppVisible(page.locator('[data-dock-area="bottom"]'))

    // Legacy review.panelOpened: true → right dock visible.
    await expectAppVisible(page.locator('[data-dock-area="right"]'))

    // Closing the terminal dock must persist; legacy flags must not resurrect
    // the closed pane on the next load.
    await page.getByRole("button", { name: "Toggle bottom dock" }).click()
    await expect(page.locator('[data-dock-area="bottom"]')).not.toBeVisible()

    // Reload with the now-persisted versioned dock; legacy terminal.opened
    // must NOT resurrect the bottom dock anymore.
    await page.reload()
    await expectAppVisible(dockSessionTab(page))
    await expect(page.locator('[data-dock-area="bottom"]')).not.toBeVisible()

    expectNoSmokeErrors(errors, [], [])
  })
})

function dockSessionTab(page: Page) {
  return page.locator('[data-dock-area="middle"]').getByRole("tab", { name: title }).first()
}

async function configureLegacyState(page: Page) {
  await page.addInitScript(
    ({ directory, dirBase64, sessionID }) => {
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([
          {
            type: "session",
            server: "http://127.0.0.1:4096",
            dirBase64,
            sessionId: sessionID,
          },
        ]),
      )
      // Legacy layout state with NO versioned dock. The migrator should derive
      // a fresh DockState from these flags and stamp it with the current schema, so
      // future loads keep the persisted dock even when the legacy flags drift.
      if (!localStorage.getItem("opencode.global.dat:layout")) {
        localStorage.setItem(
          "opencode.global.dat:layout",
          JSON.stringify({
            terminal: { opened: true, height: 320 },
            review: { panelOpened: true, diffStyle: "split" },
            fileTree: { opened: false, width: 220, tab: "changes" },
            session: { width: 720 },
          }),
        )
      }
    },
    { directory, dirBase64: base64Encode(directory), sessionID },
  )
}

function messages() {
  const userID = "msg_user_migration_qa"
  return [
    {
      info: {
        id: userID,
        sessionID,
        role: "user",
        time: { created: 1700000000000 },
        summary: { diffs: [] },
        agent: "build",
        model: { providerID: "opencode", modelID: "claude-opus-4-6", variant: "max" },
      },
      parts: [{ id: "prt_user_migration_qa", sessionID, messageID: userID, type: "text", text: "Migrate layout" }],
    },
  ]
}

function project() {
  return {
    id: projectID,
    worktree: directory,
    vcs: "git",
    name: "dock-migration-qa",
    time: { created: 1700000000000, updated: 1700000000000 },
    sandboxes: [],
  }
}

function session() {
  return {
    id: sessionID,
    slug: "dock-migration-qa",
    projectID,
    directory,
    title,
    version: "dev",
    time: { created: 1700000000000, updated: 1700000000000 },
  }
}

function provider() {
  return {
    all: [
      {
        id: "opencode",
        name: "OpenCode",
        models: { "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } } },
      },
    ],
    connected: ["opencode"],
    default: { providerID: "opencode", modelID: "claude-opus-4-6" },
  }
}

function base64Encode(value: string) {
  return Buffer.from(value, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}
