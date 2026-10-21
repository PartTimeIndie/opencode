import { expect, test, type Page } from "@playwright/test"
import { base64Encode, checksum } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"
import { trackPageErrors, trackNetworkFailures, expectNoSmokeErrors } from "../utils/errors"

const directory = "C:/OpenCode/RunningTabModelFollow"
const projectID = "proj_running_tab_model_follow"
const busySessionID = "ses_running_tab_model_busy"
const idleSessionID = "ses_running_tab_model_idle"

// The composer shows the selection that the next turn will use. Provider/chain steps
// must not make the visible picker jump while a run is in progress.
test("busy tab switch keeps the admitted model and thinking level", async ({ page }) => {
  const errors = trackPageErrors(page)
  const networkFailures = trackNetworkFailures(page)

  await mockOpenCodeServer(page, {
    directory,
    project: project(),
    provider: provider(),
    agents: [{ name: "build", mode: "primary" }],
    sessions: [session(busySessionID, "Busy run"), session(idleSessionID, "Idle neighbor")],
    pageMessages: (sessionID) => {
      if (sessionID === busySessionID)
        return {
          items: [
            userMessage(busySessionID, { variant: "medium" }),
            assistantMessage({ parentID: "msg_busy_user", variant: "max" }),
          ],
        }
      return { items: [userMessage(idleSessionID, {})] }
    },
    // The busy session keeps an active lifecycle, but that must not override the picker.
    sessionStatus: () => ({ [busySessionID]: { type: "busy" } }),
  })

  await configurePage(page)

  const composer = page.locator('[data-dock-area="middle"] [data-component="session-composer"]')
  const model = composer.locator('[data-action="prompt-model"]')
  const variant = composer.locator('[data-action="prompt-model-variant"]')

  await page.goto(`/${base64Encode(directory)}/session/${idleSessionID}`)
  await expectAppVisible(composer)
  await expect(model).toContainText("GPT-5.6 Sol")
  await expect(variant).toContainText("Default")

  // Switching to the busy tab must surface its admitted selection, not the executing step.
  await openTab(page, busySessionID)
  await expectAppVisible(page.getByRole("heading", { name: "Busy run" }))
  await expect(variant).toContainText("medium")
  await expect(page.locator('[data-slot="project-avatar-slot"] [data-slot="project-avatar-loader"]')).toBeVisible()
  // The navigation panel is collapsed in this fixture; verify its row owns the spinner even while hidden.
  await expect(page.locator(`a[href$="/session/${busySessionID}"]`).locator('[data-component="spinner"]')).toHaveCount(1)
  if (process.env.VISUAL_QA_SCREENSHOT_DIR) {
    await page.screenshot({
      path: `${process.env.VISUAL_QA_SCREENSHOT_DIR}/desktop-busy-tab-shows-executing-model.png`,
      fullPage: true,
    })
  }

  // Switching back keeps the idle tab's own remembered selection.
  await openTab(page, idleSessionID)
  await expectAppVisible(page.getByRole("heading", { name: "Idle neighbor" }))
  await expect(variant).toContainText("Default")
  if (process.env.VISUAL_QA_SCREENSHOT_DIR) {
    await page.screenshot({
      path: `${process.env.VISUAL_QA_SCREENSHOT_DIR}/desktop-idle-tab-keeps-own-selection.png`,
      fullPage: true,
    })
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('[data-action="mobile-sidebar-toggle"]').click()
  await expect(page.locator('[data-component="sidebar-nav-mobile"]')).toHaveClass(/translate-x-0/)
  await expect(page.locator('[data-component="sidebar-nav-mobile"]')).toHaveCSS("transform", "none")
  await expect(page.locator('[data-component="sidebar-nav-mobile"]')
    .locator(`a[href$="/session/${busySessionID}"] [data-component="spinner"]`)).toBeVisible()
  if (process.env.VISUAL_QA_SCREENSHOT_DIR) {
    await page.locator('[data-component="sidebar-nav-mobile"]').screenshot({
      path: `${process.env.VISUAL_QA_SCREENSHOT_DIR}/mobile-busy-session-navigation.png`,
    })
  }
  expectNoSmokeErrors(errors, [], [])
  expect(networkFailures).toEqual([])
})

test("completed sessions keep their own selection instead of following the finished step", async ({ page }) => {  await mockOpenCodeServer(page, {
    directory,
    project: project(),
    provider: provider(),
    agents: [{ name: "build", mode: "primary" }],
    sessions: [session(busySessionID, "Finished run"), session(idleSessionID, "Idle neighbor")],
    pageMessages: (sessionID) => {
      if (sessionID === busySessionID)
        return {
          items: [
            // The prompt was admitted with medium; the finished step ran with high.
            userMessage(busySessionID, { variant: "medium" }),
            assistantMessage({ parentID: "msg_busy_user", variant: "high", done: true }),
          ],
        }
      return { items: [] }
    },
    sessionStatus: () => ({}),
  })

  await configurePage(page)

  const composer = page.locator('[data-dock-area="middle"] [data-component="session-composer"]')
  const model = composer.locator('[data-action="prompt-model"]')
  const variant = composer.locator('[data-action="prompt-model-variant"]')

  await page.goto(`/${base64Encode(directory)}/session/${busySessionID}`)
  await expectAppVisible(composer)
  await expect(model).toContainText("GPT-5.6 Sol")
  await expect(variant).toContainText("medium")

  await openTab(page, idleSessionID)
  await openTab(page, busySessionID)
  await expectAppVisible(page.getByRole("heading", { name: "Finished run" }))
  await expect(variant).toContainText("medium")
})

test("settling a run keeps the same tab on its admitted selection", async ({ page }) => {
  let busy = true
  await mockOpenCodeServer(page, {
    directory,
    project: project(),
    provider: provider(),
    agents: [{ name: "build", mode: "primary" }],
    sessions: [session(busySessionID, "Settling run")],
    pageMessages: () => ({
      items: [
        userMessage(busySessionID, { variant: "medium" }),
        assistantMessage({ parentID: "msg_busy_user", variant: "max" }),
      ],
    }),
    sessionStatus: () => (busy ? { [busySessionID]: { type: "busy" } } : {}),
    eventDelay: 250,
    events: () => {
      if (!busy) return []
      busy = false
      return [
        {
          directory,
          payload: {
            id: "evt_settle",
            type: "session.next.activity.completed",
            properties: { sessionID: busySessionID, activityID: "activity_settle" },
          },
        },
      ]
    },
  })

  await configurePage(page)

  const composer = page.locator('[data-dock-area="middle"] [data-component="session-composer"]')
  const variant = composer.locator('[data-action="prompt-model-variant"]')

  await page.goto(`/${base64Encode(directory)}/session/${busySessionID}`)
  await expectAppVisible(composer)
  await expect(variant).toContainText("medium")

  // The activity completes without leaving the tab: the override must fall back to the
  // admitted selection instead of sticking to the finished step.
  await expect(variant).toContainText("medium", { timeout: 15_000 })
})

test("paged long session restores its canonical model when the user turn is outside the loaded window", async ({ page }) => {
  await mockOpenCodeServer(page, {
    directory,
    project: project(),
    provider: provider(),
    agents: [{ name: "build", mode: "primary" }],
    sessions: [
      session(busySessionID, "Paged Luna run", {
        providerID: "openai",
        id: "gpt-5.6-luna",
        variant: "high",
      }),
      session(idleSessionID, "Idle neighbor"),
    ],
    pageMessages: (sessionID) => ({
      items: sessionID === busySessionID ? [assistantMessage({ parentID: "msg_evicted_user", variant: "high" })] : [],
    }),
    sessionStatus: () => ({ [busySessionID]: { type: "busy" } }),
  })

  await configurePage(page)
  await page.goto(`/${base64Encode(directory)}/session/${busySessionID}`)

  const composer = page.locator('[data-dock-area="middle"] [data-component="session-composer"]')
  await expectAppVisible(composer)
  await expect(composer.locator('[data-action="prompt-model"]')).toContainText("GPT-5.6 Luna")
  await expect(composer.locator('[data-action="prompt-model-variant"]')).toContainText("high")
})

function provider() {
  return {
    all: [
      {
        id: "openai",
        name: "OpenAI",
        models: {
          "gpt-5.6-sol": {
            id: "gpt-5.6-sol",
            name: "GPT-5.6 Sol",
            limit: { context: 200_000 },
            variants: { medium: {}, high: {}, max: {} },
          },
          "gpt-5.6-luna": {
            id: "gpt-5.6-luna",
            name: "GPT-5.6 Luna",
            limit: { context: 200_000 },
            variants: { high: {} },
          },
        },
      },
    ],
    connected: ["openai"],
    default: { providerID: "openai", modelID: "gpt-5.6-sol" },
  }
}

function project() {
  return {
    id: projectID,
    worktree: directory,
    vcs: "git",
    name: "running-tab-model-follow",
    time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
    sandboxes: [],
  }
}

function session(id: string, title: string, model?: { providerID: string; id: string; variant?: string }) {
  return {
    id,
    slug: id,
    projectID,
    directory,
    title,
    agent: "build",
    model,
    version: "dev",
    time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
  }
}

function userMessage(sessionID: string, input?: { variant?: string }) {
  const id = sessionID === busySessionID ? "msg_busy_user" : "msg_idle_user"
  return {
    info: {
      id,
      sessionID,
      role: "user",
      time: { created: 1_700_000_000_100 },
      agent: "build",
      model: {
        providerID: "openai",
        modelID: "gpt-5.6-sol",
        ...(input?.variant ? { variant: input.variant } : {}),
      },
    },
    parts: [{ id: `prt_${id}`, sessionID, messageID: id, type: "text", text: "Running tab model follow regression" }],
  }
}

function assistantMessage(input: { parentID: string; variant?: string; done?: boolean }) {
  return {
    info: {
      id: input.done ? "msg_done_assistant" : "msg_busy_assistant",
      sessionID: busySessionID,
      role: "assistant",
      parentID: input.parentID,
      time: { created: 1_700_000_000_200, ...(input.done ? { completed: 1_700_000_000_300 } : {}) },
      agent: "build",
      mode: "build",
      providerID: "openai",
      modelID: "gpt-5.6-sol",
      ...(input.variant ? { variant: input.variant } : {}),
      path: { cwd: directory, root: directory },
      cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      ...(input.done ? { finish: "stop" } : {}),
    },
    parts: [],
  }
}

async function configurePage(page: Page) {
  await page.addInitScript(
    ({ dir, dirBase64, first, second, selectionKey }) => {
      localStorage.clear()
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { local: [{ worktree: dir, expanded: true }] }, lastProject: { local: dir } }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([
          { type: "session", server: "http://127.0.0.1:4096", dirBase64, sessionId: first },
          { type: "session", server: "http://127.0.0.1:4096", dirBase64, sessionId: second },
        ]),
      )
      // Both tabs share one deliberate workspace pick (no explicit per-session override
      // for the busy session), so only the running-state logic can explain a difference.
      localStorage.setItem(
        selectionKey,
        JSON.stringify({
          workspace: {
            agent: "build",
            model: { providerID: "openai", modelID: "gpt-5.6-sol" },
            variant: null,
          },
          session: {
            [second]: {
              agent: "build",
              model: { providerID: "openai", modelID: "gpt-5.6-sol" },
              variant: null,
            },
          },
        }),
      )
    },
    {
      dir: directory,
      dirBase64: base64Encode(directory),
      first: busySessionID,
      second: idleSessionID,
      selectionKey: `${workspaceStorage(directory)}:workspace:model-selection`,
    },
  )
}

async function openTab(page: Page, sessionID: string) {
  await page
    .locator(`[data-dock-area="middle"] [data-dock-tab][data-session-id="${sessionID}"]`)
    .getByRole("tab")
    .click()
}

function workspaceStorage(dir: string) {
  const head = (dir.slice(0, 12) || "workspace").replace(/[^a-zA-Z0-9._-]/g, "-")
  return `opencode.workspace.${head}.${checksum(dir) ?? "0"}.dat`
}
