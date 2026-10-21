import { mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/skills-settings-multi-agent"
const server = "http://127.0.0.1:4096"
const sessionID = "ses_skills_settings_multi_agent"
const screenshotDir = process.env.REVIEWER_SETTINGS_OUTPUT_DIR ?? "test-results/skills-settings-multi-agent"

type Reviewer = { model: string; variant?: string }

test.use({ video: "on" })

test("skills settings configure multi-agent reviewers", async ({ page }) => {
  const initialReviewers = [
    { model: "openai/gpt-5.5", variant: "high" },
    { model: "opencode/deepseek-v4-flash-free" },
    { model: "opencode/nemotron-3-ultra-free" },
  ]
  const configState = {
    value: {
      model: "openai/gpt-5.5",
      multi_agent: { review: { reviewers: initialReviewers }, problem_solver: { reviewers: initialReviewers } },
    } as Record<string, unknown>,
  }
  const configUpdates: unknown[] = []
  const consoleMessages: string[] = []
  const pageErrors: string[] = []
  const networkFailures: string[] = []
  const expectedTelemetryCancellations: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning")
      consoleMessages.push(`${message.type()}: ${message.text()}`)
  })
  page.on("pageerror", (error) => pageErrors.push(error.message))
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText ?? "failed"
    const message = `${request.method()} ${request.url()} ${failure}`
    if (new URL(request.url()).pathname === "/perf/record" && failure === "net::ERR_ABORTED")
      expectedTelemetryCancellations.push(message)
    else networkFailures.push(message)
  })
  page.on("response", (response) => {
    if (response.status() >= 400) networkFailures.push(`${response.status()} ${response.url()}`)
  })

  await mockOpenCodeServer(page, {
    directory,
    provider: {
      all: [
        { id: "zhipuai-coding-plan", name: "ZhipuAI", models: { "glm-5.3": { id: "glm-5.3", name: "GLM 5.3", limit: { context: 200_000 } } } },
        {
          id: "openai",
          name: "OpenAI",
          models: {
            "gpt-6.1-sol": { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", limit: { context: 200_000 }, variants: { high: {}, low: {} } },
            "gpt-5.5": {
              id: "gpt-5.5",
              name: "GPT 5.5",
              limit: { context: 200_000 },
              variants: { high: {}, low: {} },
            },
            ...Object.fromEntries(Array.from({ length: 209 }, (_, index) => {
              const id = `reviewer-catalog-${index}`
              return [id, { id, name: `Reviewer Catalog ${index}`, limit: { context: 200_000 } }]
            })),
          },
        },
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "deepseek-v4-flash-free": {
              id: "deepseek-v4-flash-free",
              name: "DeepSeek V4 Flash Free",
              limit: { context: 200_000 },
            },
            "nemotron-3-ultra-free": {
              id: "nemotron-3-ultra-free",
              name: "Nemotron 3 Ultra Free",
              limit: { context: 200_000 },
            },
            "alternate-thinking": {
              id: "alternate-thinking",
              name: "Alternate Thinking Model",
              limit: { context: 200_000 },
              variants: { high: {}, low: {} },
            },
          },
        },
      ],
      connected: ["openai", "opencode", "zhipuai-coding-plan"],
      default: { providerID: "openai", modelID: "gpt-5.5" },
    },
    project: { id: "project-skills-settings-multi-agent", name: "Skills Settings", worktree: directory, vcs: "git" },
    sessions: [session()],
    pageMessages: () => ({ items: [] }),
    globalConfig: () => configState.value,
    onGlobalConfigUpdate: (body) => {
      const patch = body as Record<string, unknown>
      configState.value = { ...configState.value, ...patch,
        multi_agent: { ...(configState.value.multi_agent as Record<string, unknown>), ...(patch.multi_agent as Record<string, unknown>) },
      }
      configUpdates.push(body)
      return configState.value
    },
  })

  await mockReviewerPlugins(page)

  await page.addInitScript(
    ({ dir, dirBase64, serverKey }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { [serverKey]: [{ worktree: dir, expanded: true }] },
          lastProject: { [serverKey]: dir },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([
          { type: "session", server: serverKey, dirBase64, sessionId: "ses_skills_settings_multi_agent" },
        ]),
      )
    },
    { dir: directory, dirBase64: base64Encode(directory), serverKey: server },
  )

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectAppVisible(page.getByRole("textbox", { name: /Ask anything/i }))

  await page.getByRole("button", { name: "Open settings", exact: true }).click()

  const skillsTab = page.getByRole("tab", { name: "Skills & Plugins", exact: true })
  await expectAppVisible(skillsTab)
  await expect(skillsTab.locator("use")).toHaveAttribute("href", "#opencode-icon-plug")
  await skillsTab.click()

  const review = page.locator('[data-plugin-settings="multi-agent-review-app"]')
  const problemSolver = page.locator('[data-plugin-settings="multi-agent-problem-solver-app"]')
  await expect(review).toContainText("Multi-Agent Review")
  await expect(problemSolver).toContainText("Multi-Agent Problem Solver")
  await expect(review.locator("[data-plugin-setting-list-item]")).toHaveCount(3)

  await expect(review.getByRole("button", { name: "Add agent" })).toHaveCount(0)
  await expect(review.getByRole("button", { name: "Add reviewer" })).toBeEnabled()
  const beforeAdd = configUpdates.length
  await expect(review).toHaveAttribute("data-settings-revision", /^\d+$/)
  await expect(problemSolver).toHaveAttribute("data-settings-revision", /^\d+$/)
  const reviewRevision = Number(await review.getAttribute("data-settings-revision"))
  const problemSolverRevision = await problemSolver.getAttribute("data-settings-revision")
  const reviewPanel = await review.elementHandle()
  const problemSolverPanel = await problemSolver.elementHandle()
  if (!reviewPanel || !problemSolverPanel) throw new Error("Plugin settings panels were not mounted")
  await review.getByRole("button", { name: "Add reviewer" }).click()
  await expect.poll(() => configUpdates.length).toBeGreaterThan(beforeAdd)
  await expect.poll(() => reviewers(configUpdates.at(-1)).length).toBe(4)
  expect(reviewers(configUpdates.at(-1)).every((reviewer) => reviewer.model && !("agent" in reviewer))).toBe(true)
  await expect(review.locator("[data-plugin-setting-list-item]")).toHaveCount(4)
  await expect(review).toHaveAttribute("data-settings-revision", String(reviewRevision + 1))
  await expect(problemSolver).toHaveAttribute("data-settings-revision", problemSolverRevision ?? "")
  const panelInvalidationMetrics = {
    pluginPanels: 2,
    panelsInvalidated: Number(await review.getAttribute("data-settings-revision")) - reviewRevision,
    siblingInvalidations: Number(await problemSolver.getAttribute("data-settings-revision")) - Number(problemSolverRevision),
    reviewPanelPreserved: await reviewPanel.evaluate((element) => element === document.querySelector('[data-plugin-settings="multi-agent-review-app"]')),
    problemSolverPanelPreserved: await problemSolverPanel.evaluate((element) => element === document.querySelector('[data-plugin-settings="multi-agent-problem-solver-app"]')),
  }
  expect(panelInvalidationMetrics).toEqual({
    pluginPanels: 2,
    panelsInvalidated: 1,
    siblingInvalidations: 0,
    reviewPanelPreserved: true,
    problemSolverPanelPreserved: true,
  })

  const beforeRemove = configUpdates.length
  const addedReviewerRow = review.locator("[data-plugin-setting-list-item]").nth(3)
  await expect(addedReviewerRow.getByRole("button", { name: "Remove" })).toBeEnabled()
  await addedReviewerRow.getByRole("button", { name: "Remove" }).click()
  await expect(review.locator("[data-plugin-setting-list-item]")).toHaveCount(3)
  await expect.poll(() => configUpdates.length).toBeGreaterThan(beforeRemove)
  expect(reviewers(configUpdates.at(-1))).toHaveLength(3)

  const firstReviewerRow = review.locator("[data-plugin-setting-list-item]").first()
  const beforeModel = configUpdates.length
  const pickerStartedAt = await page.evaluate(() => performance.now())
  await firstReviewerRow.getByRole("button", { name: "Reviewer model", exact: true }).click()
  const alternateModel = page.locator('[data-slot="list-item"]').filter({ hasText: "Alternate Thinking Model" })
  await expectAppVisible(alternateModel)
  const modelPickerMetrics = await page.evaluate((startedAt) => ({
    openMs: Math.round((performance.now() - startedAt) * 100) / 100,
    renderedRows: document.querySelectorAll('[data-component="model-selector-popover"] [data-slot="list-item"]').length,
  }), pickerStartedAt)
  await alternateModel.click()
  await expect.poll(() => configUpdates.length).toBeGreaterThan(beforeModel)
  await expect.poll(() => reviewers(configUpdates.at(-1))[0]?.model).toBe("opencode/alternate-thinking")
  expect(reviewers(configUpdates.at(-1))[0]?.variant).toBeUndefined()

  const beforeVariant = configUpdates.length
  await firstReviewerRow.locator('[data-component="select-v2"]').click()
  await page.locator('[data-slot="select-v2-listbox"] [role="option"]').filter({ hasText: "High" }).click()
  await expect(page.locator('[data-slot="select-v2-listbox"]')).toBeHidden()
  await expect.poll(() => configUpdates.length).toBeGreaterThan(beforeVariant)
  expect(reviewers(configUpdates.at(-1))[0]?.variant).toBe("high")
  await expect(firstReviewerRow.getByLabel("Reviewer model thinking amount")).toContainText("High")
  await page.reload()
  await page.getByRole("button", { name: "Open settings", exact: true }).click()
  await page.getByRole("tab", { name: "Skills & Plugins", exact: true }).click()
  await expect(firstReviewerRow.getByRole("button", { name: "Reviewer model", exact: true })).toContainText(
    "Alternate Thinking Model",
  )
  await expect(firstReviewerRow.getByLabel("Reviewer model thinking amount")).toContainText("High")
  while ((await review.locator("[data-plugin-setting-list-item]").count()) > 0) {
    const remaining = (await review.locator("[data-plugin-setting-list-item]").count()) - 1
    const lastReviewer = review
      .locator("[data-plugin-setting-list-item]")
      .last()
    const removeReviewer = lastReviewer.getByRole("button", { name: "Remove", exact: true })
    await expect(removeReviewer).toBeEnabled()
    await removeReviewer.click()
    await expect.poll(() => reviewers(configState.value).length).toBe(remaining)
    await expect(review.locator("[data-plugin-setting-list-item]")).toHaveCount(remaining)
  }
  expect(reviewers(configState.value)).toEqual([])
  await expect(problemSolver.locator("[data-plugin-setting-list-item]")).toHaveCount(3)
  await page.reload()
  await page.getByRole("button", { name: "Open settings", exact: true }).click()
  await page.getByRole("tab", { name: "Skills & Plugins", exact: true }).click()
  await expect(review.locator("[data-plugin-setting-list-item]")).toHaveCount(0)
  expect(reviewers(configState.value)).toEqual([])
  mkdirSync(screenshotDir, { recursive: true })
  await review.evaluate((element) => element.scrollIntoView({ block: "start" }))
  await page.screenshot({ path: `${screenshotDir}/empty-reviewers-desktop.png`, fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(review.getByRole("button", { name: "Add reviewer" })).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: `${screenshotDir}/empty-reviewers-mobile.png`, fullPage: true })
  await page.setViewportSize({ width: 1280, height: 720 })
  const beforeAddAfterClear = configUpdates.length
  await review.getByRole("button", { name: "Add reviewer" }).click()
  await expect.poll(() => configUpdates.length).toBeGreaterThan(beforeAddAfterClear)
  await expect(review.locator("[data-plugin-setting-list-item]")).toHaveCount(1)
  expect(reviewers(configState.value)).toEqual([{ model: "openai/gpt-5.5" }])
  const beforeReaddedModel = configUpdates.length
  await firstReviewerRow.getByRole("button", { name: "Reviewer model", exact: true }).click()
  await expectAppVisible(alternateModel)
  await alternateModel.click()
  await expect.poll(() => configUpdates.length).toBeGreaterThan(beforeReaddedModel)
  await expect.poll(() => reviewers(configState.value)[0]?.model).toBe("opencode/alternate-thinking")

  const search = page.locator(".settings-v2-nav-search input")
  await search.fill("alternate-thinking")
  await expect(
    page.locator(".settings-v2-search-result").filter({ hasText: "Reviewer 1: opencode/alternate-thinking" }),
  ).toBeVisible()
  await search.fill("")
  await review.getByRole("button", { name: "Reset defaults", exact: true }).click()
  await expect.poll(() => reviewers(configState.value)).toEqual([{ model: "zhipuai-coding-plan/glm-5.3" }, { model: "openai/gpt-6.1-sol", variant: "high" }])
  await expect(review.locator("[data-plugin-setting-list-item]")).toHaveCount(2)
  mkdirSync(screenshotDir, { recursive: true })
  writeFileSync(`${screenshotDir}/config-updates.json`, JSON.stringify(configUpdates, null, 2))
  writeFileSync(
    `${screenshotDir}/visual-qa-summary.json`,
    JSON.stringify(
      {
        url: page.url(),
        desktop: { width: 1280, height: 720 },
        mobile: { width: 390, height: 844 },
        consoleMessages,
        pageErrors,
        networkFailures,
        expectedTelemetryCancellations,
        modelPickerMetrics,
        panelInvalidationMetrics,
      },
      null,
      2,
    ),
  )
  await review.evaluate((element) => element.scrollIntoView({ block: "start" }))
  await page.screenshot({ path: `${screenshotDir}/desktop.png`, fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  const addReviewer = review.getByRole("button", { name: "Add reviewer" })
  await expect(addReviewer).toBeVisible()
  await addReviewer.scrollIntoViewIfNeeded()
  await expect(addReviewer).toBeInViewport({ ratio: 1 })
  await firstReviewerRow.evaluate((element) => element.scrollIntoView({ block: "start" }))
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: `${screenshotDir}/mobile.png`, fullPage: true })
  expect(consoleMessages).toEqual([])
  expect(pageErrors).toEqual([])
  expect(networkFailures).toEqual([])
})

function reviewers(input: unknown) {
  return (input as { multi_agent?: { review?: { reviewers?: Reviewer[] } } }).multi_agent?.review?.reviewers ?? []
}

async function mockReviewerPlugins(page: Page) {
  const ids = ["multi-agent-review-app", "multi-agent-problem-solver-app"]
  const plugins = ids.map((id) => {
    const manifest = JSON.parse(readFileSync(`../../.opencode/plugin-sources/${id}/package.json`, "utf8"))
    return {
      id,
      spec: id,
      version: "1",
      hash: id,
      module: `/app/plugin/${id}/1/index.js`,
      capabilities: manifest.opencode.app.capabilities,
    }
  })
  await page.route("**/app/plugins**", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ plugins }) }),
  )
  await page.route(/\/app\/plugin\/multi-agent-(review|problem-solver)-app\/1\//, (route) => {
    const match = new URL(route.request().url()).pathname.match(/\/app\/plugin\/([^/]+)\/1\/(.+)$/)!
    return route.fulfill({
      contentType: match[2].endsWith(".svg") ? "image/svg+xml" : "text/javascript",
      headers: { "access-control-allow-origin": "*" },
      body: readFileSync(`../../.opencode/plugin-sources/${match[1]}/${match[2]}`, "utf8"),
    })
  })
}

function session() {
  return {
    id: sessionID,
    slug: sessionID,
    projectID: "project-skills-settings-multi-agent",
    directory,
    title: "Skills Settings Session",
    version: "dev",
    time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
  }
}
