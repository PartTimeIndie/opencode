import { expect, test, type Locator, type Page, type Route } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectNoSmokeErrors, trackPageErrors } from "../utils/errors"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/UsageDashboardQA"
const projectID = "proj_usage_dashboard_qa"
const sessionID = "ses_usage_dashboard_qa"
const now = 1_800_000_000_000

test("opens usage dashboard from slash command on desktop and mobile", async ({ page }) => {
  const errors = trackPageErrors(page)
  const networkFailures = trackNetworkFailures(page)
  await page.setViewportSize({ width: 1280, height: 720 })
  await mockOpenCodeServer(page, {
    directory,
    project: project(),
    provider: provider(),
    sessions: [session({ id: sessionID, title: "Usage Dashboard QA", agent: "build" })],
    sessionStatus: { [sessionID]: { type: "busy" } },
    pageMessages: () => ({ items: [] }),
  })
  await mockUsageSessions(page)
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({}))
  })

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await openUsage(page)
  const desktopDashboard = page.locator('[data-dock-area="right"] [data-component="usage-dashboard"]')
  await expectAppVisible(desktopDashboard)
  await expectTokenTotal(desktopDashboard)
  await expectAppVisible(page.getByText("Daily Tokens"))
  await expectAppVisible(page.getByText("Agent Breakdown"))
  await expectAppVisible(page.locator("section", { hasText: "Agent Breakdown" }).locator("tbody tr").filter({ hasText: "build" }))
  await page.screenshot({ path: "e2e/test-results/usage-dashboard-desktop.png", fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  await expectAppVisible(page.locator('[data-component="session-dock-shell"][data-layout="mobile-stack"]'))
  await openUsage(page)
  const mobileDashboard = page.locator('[data-dock-area="mobile"] [data-component="usage-dashboard"]')
  await expectAppVisible(mobileDashboard)
  await expectAppVisible(mobileDashboard.getByRole("heading", { name: "Usage Dashboard", exact: true }))
  await expectTokenTotal(mobileDashboard)
  await page.screenshot({ path: "e2e/test-results/usage-dashboard-mobile.png", fullPage: true })

  expect(networkFailures.filter((failure) => !failure.includes("/favicon"))).toEqual([])
  expectNoSmokeErrors(errors, [], [])
})

async function openUsage(page: Page) {
  const composer = page.locator('[data-component="session-composer"]')
  await expectAppVisible(composer)
  await composer.locator('[data-component="prompt-input"]').click()
  await page.keyboard.type("/usage")
  await expectAppVisible(page.locator('[data-slash-id="usage.open"]'))
  await page.keyboard.press("Enter")
}

test("shows more than eight models, keeps selection and scroll across refresh, and renders the footer token counter", async ({ page }) => {
  const errors = trackPageErrors(page)
  const networkFailures = trackNetworkFailures(page)
  await page.setViewportSize({ width: 1280, height: 720 })
  await mockOpenCodeServer(page, {
    directory,
    project: project(),
    provider: provider(),
    sessions: [session({ id: sessionID, title: "Usage Dashboard QA", agent: "build" })],
    sessionStatus: { [sessionID]: { type: "busy" } },
    pageMessages: () => ({ items: [] }),
  })
  const sessions = Array.from({ length: 12 }, (_, index) =>
    session({
      id: `ses_model_${index}`,
      title: `Model QA ${index}`,
      agent: "build",
      updated: now - index * 1000,
      // Astra lands outside the default top 8; "All" must make it reachable.
      input: index === 9 ? 10 : 200 - index * 5,
      providerID: "openai",
      modelID: index === 9 ? "gpt-6-astra" : `gpt-model-${index}`,
    }),
  )
  await mockUsageSessions(page, sessions)
  const totals = (input: number, output = 0) => ({
    input,
    output,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    total: input + output,
  })
  await page.route("**/experimental/session/*/usage*", (route) => {
    const url = new URL(route.request().url())
    if (!url.pathname.endsWith("/usage")) return route.fallback()
    return json(route, {
      sessionID,
      asOf: now,
      session: {
        own: totals(1200, 340),
        descendants: totals(400),
        total: totals(1600, 340),
        descendantSessions: 1,
        complete: true,
      },
      run: {
        activityID: "act_qa",
        kind: "prompt",
        status: "running",
        running: true,
        timeStart: now - 60_000,
        own: totals(120, 30),
        descendants: totals(40),
        total: totals(160, 30),
        complete: true,
      },
    })
  })

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await openUsage(page)
  const dashboard = page.locator('[data-dock-area="right"] [data-component="usage-dashboard"]')
  await expectAppVisible(dashboard)
  const modelCount = dashboard.locator('[data-slot="usage-model-count"]')
  await expectAppVisible(modelCount.filter({ hasText: "8 of 12 models" }))
  // data-slot="usage-table" sits on the <table>; scope the section by its heading.
  const modelTable = dashboard.locator("section").filter({ hasText: "Model Breakdown" })
  await expect(modelTable.locator("tbody tr").filter({ hasText: "gpt-6-astra" })).toHaveCount(0)

  // All models become reachable through the limit selector; astra sits outside the default top 8.
  await dashboard.locator('[data-slot="usage-model-limit"]').selectOption("all")
  await expectAppVisible(modelCount.filter({ hasText: "12 of 12 models" }))
  await expectAppVisible(modelTable.locator("tbody tr").filter({ hasText: "openai/gpt-6-astra" }))

  // Refresh and range changes must not remount the board, lose selection, or jump scroll.
  await dashboard.evaluate((element) => {
    element.scrollTop = 400
  })
  const marker = await dashboard.evaluate((element) => {
    ;(element as HTMLElement & { __qaMountMarker?: string }).__qaMountMarker = "kept"
    return (element as HTMLElement & { __qaMountMarker?: string }).__qaMountMarker
  })
  expect(marker).toBe("kept")
  // A layout store write re-evaluates the dock pane registry; the stable pane
  // identity must keep the dashboard mounted with scroll and selection intact.
  await page.getByRole("button", { name: "Toggle left dock" }).click()
  await page.getByRole("button", { name: "Toggle left dock" }).click()
  await expectAppVisible(modelCount.filter({ hasText: "12 of 12 models" }))
  expect(
    await dashboard.evaluate((element) => (element as HTMLElement & { __qaMountMarker?: string }).__qaMountMarker),
  ).toBe("kept")
  expect(await dashboard.evaluate((element) => element.scrollTop)).toBe(400)

  // Manual refresh keeps the previously loaded data visible while loading.
  await dashboard.getByRole("button", { name: "Refresh" }).click()
  await expectAppVisible(modelCount.filter({ hasText: "12 of 12 models" }))

  // Footer token counter next to the running status, including subagents.
  const tokenCounter = page.locator('[data-slot="session-usage-token"]')
  await expectAppVisible(tokenCounter.filter({ hasText: "Run 190" }))
  await expectAppVisible(tokenCounter.filter({ hasText: "Session 1.9K" }))
  await page.screenshot({ path: "e2e/test-results/usage-dashboard-models-footer-desktop.png", fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  await expectAppVisible(tokenCounter)
  const counterBox = await tokenCounter.boundingBox()
  expect(counterBox).not.toBeNull()
  expect(counterBox!.x).toBeGreaterThanOrEqual(0)
  expect(counterBox!.x + counterBox!.width).toBeLessThanOrEqual(390.5)

  await page.screenshot({ path: "e2e/test-results/usage-dashboard-models-footer-mobile.png", fullPage: true })
  expect(networkFailures.filter((failure) => !failure.includes("/favicon"))).toEqual([])
  expectNoSmokeErrors(errors, [], [])
})

async function expectTokenTotal(dashboard: Locator) {
  await expectAppVisible(
    dashboard.locator('[data-slot="usage-metric-card"]').filter({ hasText: "TOKENS" }).getByText("3,910", { exact: true }),
  )
}

async function mockUsageSessions(page: Page, list?: ReturnType<typeof session>[]) {
  await page.route("**/experimental/session**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname !== "/experimental/session") return route.fallback()
    return json(route, list ?? [
      session({ id: sessionID, title: "Usage Dashboard QA", agent: "build", updated: now, input: 1200, output: 340, cost: 0.42 }),
      session({ id: "ses_usage_plan", title: "Planning", agent: "plan", updated: now - 86_400_000, input: 800, output: 220, cost: 0.21, providerID: "anthropic" }),
      session({ id: "ses_usage_review", title: "Review", agent: "review", updated: now - 172_800_000, input: 600, output: 180, reasoning: 90, cost: 0.18 }),
    ])
  })
}

function trackNetworkFailures(page: Page) {
  const failures: string[] = []
  page.on("requestfailed", (request) => {
    if (request.failure()?.errorText === "net::ERR_ABORTED") return
    failures.push(`request failed ${request.url()} ${request.failure()?.errorText ?? ""}`)
  })
  page.on("response", (response) => {
    if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`)
  })
  return failures
}

function project() {
  return {
    id: projectID,
    worktree: directory,
    vcs: "git",
    name: "usage-dashboard-qa",
    time: { created: now, updated: now },
    sandboxes: [],
  }
}

function provider() {
  return {
    all: [
      {
        id: "openai",
        name: "OpenAI",
        models: { "gpt-5.5": { id: "gpt-5.5", name: "GPT-5.5", limit: { context: 200_000 } } },
      },
      {
        id: "anthropic",
        name: "Anthropic",
        models: { "claude-sonnet": { id: "claude-sonnet", name: "Claude Sonnet", limit: { context: 200_000 } } },
      },
    ],
    connected: ["openai", "anthropic"],
    default: { providerID: "openai", modelID: "gpt-5.5" },
  }
}

function session(input: {
  id: string
  title: string
  agent: string
  updated?: number
  input?: number
  output?: number
  reasoning?: number
  cost?: number
  providerID?: string
  modelID?: string
}) {
  return {
    id: input.id,
    slug: input.id,
    projectID,
    directory,
    title: input.title,
    agent: input.agent,
    model: {
      providerID: input.providerID ?? "openai",
      id: input.modelID ?? (input.providerID === "anthropic" ? "claude-sonnet" : "gpt-5.5"),
    },
    cost: input.cost ?? 0,
    tokens: {
      input: input.input ?? 0,
      output: input.output ?? 0,
      reasoning: input.reasoning ?? 0,
      cache: { read: 120, write: 40 },
    },
    version: "dev",
    time: { created: input.updated ?? now, updated: input.updated ?? now },
    project: { id: projectID, name: "usage-dashboard-qa", worktree: directory },
  }
}

function json(route: Route, body: unknown) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*", "access-control-expose-headers": "x-next-cursor" },
    body: JSON.stringify(body),
  })
}
