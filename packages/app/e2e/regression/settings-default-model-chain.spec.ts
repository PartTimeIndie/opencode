import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectNoSmokeErrors, trackNetworkFailures, trackPageErrors } from "../utils/errors"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/DefaultModelChain"
const projectID = "proj_default_model_chain"
const sessionID = "ses_default_model_chain"
const server = "http://127.0.0.1:4096"

const provider = {
  all: [
    {
      id: "opencode",
      name: "OpenCode",
      models: {
        "ox-alpha": { id: "ox-alpha", name: "Ox Alpha", limit: { context: 200_000 } },
        "workhorse-primary": { id: "workhorse-primary", name: "Workhorse Primary", limit: { context: 200_000 } },
        "workhorse-secondary": { id: "workhorse-secondary", name: "Workhorse Secondary", limit: { context: 200_000 } },
      },
    },
  ],
  connected: ["opencode"],
  default: { providerID: "opencode", modelID: "ox-alpha" },
}

type GlobalConfig = {
  access_control?: {
    safety_review?: {
      chain_id?: string
      model?: string
      chain?: Array<{ providerID: string; modelID: string; variant?: string }>
    }
  }
}

const workChain = [
  { providerID: "opencode", modelID: "workhorse-primary", variant: "high" },
  { providerID: "opencode", modelID: "workhorse-secondary" },
]

const project = {
  id: projectID,
  worktree: directory,
  vcs: "git",
  name: "default-model-chain",
  time: { created: 1700000000000, updated: 1700000000000 },
  sandboxes: [],
}

const sessions = [
  {
    id: sessionID,
    slug: sessionID,
    projectID,
    directory,
    title: "Default model chain",
    version: "dev",
    time: { created: 1700000000000, updated: 1700000000000 },
  },
]

async function readModelStore(page: Page) {
  return page.evaluate(() =>
    JSON.parse(localStorage.getItem("opencode.global.dat:model") || "null") as {
      chains?: unknown[]
      defaultChainID?: string
      selection?: { chainID?: string }
    } | null,
  )
}

async function openSettings(page: Page) {
  const button = page.getByRole("button", { name: "Open settings" })
  await expectAppVisible(button)
  await button.click()
}

async function expectChainLayout(page: Page) {
  const row = page.locator('[data-action="settings-safety-review-chain"]')
  await expectAppVisible(row)
  const trigger = row.getByRole("button", { name: "Safety-review model or chain" })
  await expect(trigger).toContainText("Workhorse")
  await trigger.click()
  const picker = page.locator('[data-component="model-selector-popover"]')
  await expectAppVisible(picker)
  const option = picker.locator('[role="option"]').filter({ hasText: "Workhorse" })
  await expect(option).toContainText("Workhorse Primary (high) → Workhorse Secondary")
  await expect(option).toHaveAttribute("aria-selected", "true")
  await trigger.click()
  await expect(picker).toBeHidden()
  // Layout contract: the control sits on its own line below the copy, so the
  // title keeps the full row width instead of collapsing word by word.
  const geometry = await page.evaluate(() => {
    const title = document.querySelector<HTMLElement>(
      '[data-action="settings-safety-review-chain"] [data-slot="settings-v2-row-title"]',
    )
    if (!title) return null
    return { rects: title.getClientRects().length, width: title.getBoundingClientRect().width }
  })
  expect(geometry).not.toBeNull()
  expect(geometry!.rects).toBe(1)
  expect(geometry!.width).toBeGreaterThanOrEqual(120)
}

test("sets and persists the default model chain from Settings", async ({ page }) => {
  const errors = trackPageErrors(page)
  const networkFailures = trackNetworkFailures(page)
  const ptyCreates: string[] = []
  page.on("request", (request) => {
    if (request.method() !== "POST") return
    if (new URL(request.url()).pathname !== "/pty") return
    ptyCreates.push(request.url())
  })
  const configUpdates: Array<Record<string, unknown>> = []
  const globalConfig: GlobalConfig = {}

  await mockOpenCodeServer(page, {
    directory,
    project,
    provider,
    sessions,
    pageMessages: () => ({ items: [] }),
    globalConfig: () => globalConfig,
    onGlobalConfigUpdate: async (body) => {
      const patch = body as GlobalConfig
      configUpdates.push(patch)
      globalConfig.access_control = {
        ...globalConfig.access_control,
        ...patch.access_control,
        safety_review: patch.access_control?.safety_review ?? globalConfig.access_control?.safety_review,
      }
      return globalConfig
    },
  })

  await page.addInitScript(
    ({ directory, encoded, server, sessionID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { [server]: [{ worktree: directory, expanded: true }] }, lastProject: { [server]: directory } }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", server, dirBase64: encoded, sessionId: sessionID }]),
      )
      // Root-cause fixture: a retired chain is still the stored default while
      // the composer selection also points at it. addInitScript re-runs on
      // reload, so seed once and let the reload assertion observe the store
      // the app itself persisted.
      if (!localStorage.getItem("opencode.global.dat:model")) {
        localStorage.setItem(
          "opencode.global.dat:model",
          JSON.stringify({
            user: [],
            recent: [],
            variant: {},
            selection: { chainID: "chain-ox" },
            chains: [
              { id: "chain-ox", name: "Ox Alpha", steps: [{ providerID: "opencode", modelID: "ox-alpha" }] },
              {
                id: "chain-work",
                name: "Workhorse",
                steps: [
                  { providerID: "opencode", modelID: "workhorse-primary", variant: "high" },
                  { providerID: "opencode", modelID: "workhorse-secondary" },
                ],
              },
            ],
            defaultChainID: "chain-ox",
          }),
        )
      }
    },
    { directory, encoded: base64Encode(directory), server, sessionID },
  )

  await page.setViewportSize({ width: 1280, height: 800 })
  const messagesAfterInitialLoad = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === `/session/${sessionID}/message` &&
      response.ok(),
  )
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await messagesAfterInitialLoad

  await openSettings(page)
  await page.getByRole("tab", { name: "Models", exact: true }).click()
  const summary = page.locator('[data-action="settings-model-default-chain"]')
  await expectAppVisible(summary)
  await expect(summary).toContainText("Ox Alpha")

  const oxRow = page.locator('[data-action="settings-model-chain-chain-ox"]')
  await expect(oxRow).toContainText("Ox Alpha")
  await expect(oxRow.getByRole("button", { name: "Clear default" })).toBeVisible()
  const workRow = page.locator('[data-action="settings-model-chain-chain-work"]')
  await expect(workRow).toContainText("Workhorse")
  await expect(workRow.getByRole("button", { name: "Make default" })).toBeVisible()

  await workRow.getByRole("button", { name: "Make default" }).click()

  await expect(summary).toContainText("Workhorse")
  await expect.poll(async () => (await readModelStore(page))?.defaultChainID).toBe("chain-work")
  const persisted = await readModelStore(page)
  expect(persisted?.chains).toHaveLength(2)
  expect(persisted?.selection?.chainID).toBe("chain-ox")

  await expect
    .poll(() => JSON.stringify(globalConfig.access_control?.safety_review?.chain))
    .toBe(JSON.stringify(workChain))
  await expect
    .poll(() => globalConfig.access_control?.safety_review?.chain_id)
    .toBe("default")
  expect(
    configUpdates.some(
      (update) =>
        JSON.stringify((update as GlobalConfig).access_control?.safety_review?.chain) ===
        JSON.stringify(workChain),
    ),
  ).toBe(true)

  await page.getByRole("tab", { name: "General", exact: true }).click()
  await expectChainLayout(page)
  if (process.env.VISUAL_QA_SCREENSHOT_DIR) {
    await page.screenshot({
      path: `${process.env.VISUAL_QA_SCREENSHOT_DIR}/safety-review-default-desktop.png`,
      fullPage: true,
    })
  }

  await page.setViewportSize({ width: 390, height: 844 })
  await expectChainLayout(page)
  expect(await page.evaluate(() => document.body.scrollWidth <= window.innerWidth + 1)).toBe(true)
  if (process.env.VISUAL_QA_SCREENSHOT_DIR) {
    await page.screenshot({
      path: `${process.env.VISUAL_QA_SCREENSHOT_DIR}/safety-review-default-mobile.png`,
      fullPage: true,
    })
  }
  await page.setViewportSize({ width: 1280, height: 800 })

  // The reload re-issues the session message fetch; wait for its completion so
  // the test never tears the page down mid-request (observed as ERR_ABORTED).
  const messagesAfterReload = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === `/session/${sessionID}/message` &&
      response.ok(),
  )
  await page.reload()
  await messagesAfterReload
  await openSettings(page)
  await page.getByRole("tab", { name: "Models", exact: true }).click()
  await expect(summary).toContainText("Workhorse")
  await expect.poll(async () => (await readModelStore(page))?.defaultChainID).toBe("chain-work")
  await expect
    .poll(() => JSON.stringify(globalConfig.access_control?.safety_review?.chain))
    .toBe(JSON.stringify(workChain))
  await expect.poll(() => globalConfig.access_control?.safety_review?.chain_id).toBe("default")
  await page.getByRole("tab", { name: "General", exact: true }).click()
  await expectChainLayout(page)

  expectNoSmokeErrors(errors, [], [])
  expect(ptyCreates).toEqual([])
  expect(
    networkFailures.filter(
      (failure) =>
        !(
          failure.includes(" net::ERR_ABORTED") &&
          (failure.includes("/perf/record") ||
            failure.includes("/global/event") ||
            failure.includes("/@fs/") ||
            failure.includes("/assets/") ||
            failure.includes(".woff") ||
            // Reload-navigated shell probe; real pty errors stay failures.
            failure.includes("/pty/shells"))
        ),
    ),
  ).toEqual([])
})

test("treats a default chain pointing at a removed chain as unset", async ({ page }) => {
  const errors = trackPageErrors(page)
  const networkFailures = trackNetworkFailures(page)
  const globalConfig: GlobalConfig = {}

  await mockOpenCodeServer(page, {
    directory,
    project,
    provider,
    sessions,
    pageMessages: () => ({ items: [] }),
    globalConfig: () => globalConfig,
    onGlobalConfigUpdate: async (body) => {
      const patch = body as GlobalConfig
      globalConfig.access_control = {
        ...globalConfig.access_control,
        ...patch.access_control,
        safety_review: patch.access_control?.safety_review ?? globalConfig.access_control?.safety_review,
      }
      return globalConfig
    },
  })

  await page.addInitScript(
    ({ directory, encoded, server, sessionID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { [server]: [{ worktree: directory, expanded: true }] }, lastProject: { [server]: directory } }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", server, dirBase64: encoded, sessionId: sessionID }]),
      )
      if (!localStorage.getItem("opencode.global.dat:model")) {
        localStorage.setItem(
          "opencode.global.dat:model",
          JSON.stringify({
            user: [],
            recent: [],
            variant: {},
            selection: { chainID: "chain-ghost" },
            chains: [
              {
                id: "chain-work",
                name: "Workhorse",
                steps: [
                  { providerID: "opencode", modelID: "workhorse-primary", variant: "high" },
                  { providerID: "opencode", modelID: "workhorse-secondary" },
                ],
              },
            ],
            defaultChainID: "chain-ghost",
          }),
        )
      }
    },
    { directory, encoded: base64Encode(directory), server, sessionID },
  )

  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)

  await openSettings(page)
  await page.getByRole("tab", { name: "General", exact: true }).click()
  const safetyRow = page.locator('[data-action="settings-safety-review-chain"]')
  await expectAppVisible(safetyRow)
  await expect(safetyRow).toContainText("No valid safety-review model or chain configured")

  await page.getByRole("tab", { name: "Models", exact: true }).click()
  const summary = page.locator('[data-action="settings-model-default-chain"]')
  await expectAppVisible(summary)
  await expect(summary).toContainText("No default chain")
  const workRow = page.locator('[data-action="settings-model-chain-chain-work"]')
  await expect(workRow.getByRole("button", { name: "Make default" })).toBeVisible()

  await workRow.getByRole("button", { name: "Make default" }).click()
  await expect(summary).toContainText("Workhorse")
  await expect.poll(async () => (await readModelStore(page))?.defaultChainID).toBe("chain-work")
  expect((await readModelStore(page))?.chains).toHaveLength(1)

  await page.getByRole("tab", { name: "General", exact: true }).click()
  await expectChainLayout(page)

  expectNoSmokeErrors(errors, [], [])
  expect(
    networkFailures.filter(
      (failure) =>
        !(
          failure.includes(" net::ERR_ABORTED") &&
          (failure.includes("/perf/record") ||
            failure.includes("/global/event") ||
            failure.includes("/@fs/") ||
            failure.includes("/assets/") ||
            failure.includes(".woff") ||
            // Reload-navigated shell probe; real pty errors stay failures.
            failure.includes("/pty/shells"))
        ),
    ),
  ).toEqual([])
})
