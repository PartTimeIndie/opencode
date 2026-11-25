import { expect, test, type Page, type Route } from "@playwright/test"
import fs from "node:fs/promises"
import path from "node:path"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { trackPageErrors, expectNoSmokeErrors } from "../utils/errors"
import { expectAppVisible } from "../utils/waits"
const { scheduledJobPrompt } = await import(
  new URL("../../../../.opencode/plugin-sources/scheduled-jobs-app/app-runner-helpers.js", import.meta.url).href
)

test.use({ video: "on", screenshot: "on" })
test.setTimeout(120_000)

const directory = "C:/OpenCode/ScheduledJobs"
const docsDirectory = "C:/OpenCode/DocsPortal"
const scratchDirectory = "C:/OpenCode/SchedulerScratch"
const projectID = "proj_scheduled_jobs"
const sessionID = "ses_scheduled_jobs"
const schedulerScopeID = "scheduled-jobs-scope"
const server = `http://127.0.0.1:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`

type SchedulerRequest = { method: string; path: string; body?: Record<string, unknown>; query: Record<string, string> }
type SchedulerJob = Record<string, unknown> & {
  name: string
  slug: string
  schedule: string
  workdir: string
  run?: Record<string, unknown>
}
type SchedulerMockOptions = {
  run?: (input: {
    job: SchedulerJob | undefined
    request: SchedulerRequest
  }) =>
    | { status?: number; body: Record<string, unknown> }
    | Promise<{ status?: number; body: Record<string, unknown> } | undefined>
    | undefined
  outcome?: (input: {
    job: SchedulerJob | undefined
    request: SchedulerRequest
    count: number
  }) => Record<string, unknown>
  jobGet?: (input: {
    job: SchedulerJob | undefined
    request: SchedulerRequest
    count: number
  }) => { status: number; body?: Record<string, unknown> } | undefined
  listGet?: (input: {
    request: SchedulerRequest
    count: number
  }) => { status: number; body?: Record<string, unknown> } | undefined
  state?: (input: {
    job: SchedulerJob | undefined
    request: SchedulerRequest
    count: number
  }) => { status: number; body?: Record<string, unknown> } | undefined
  port?: string
}

type ConfiguredSessionTab = { server: string; sessionID: string; displayName: string }

test("creates, runs, and deletes scheduled LLM and shell jobs", async ({ page }) => {
  const errors = trackPageErrors(page)
  const requests: SchedulerRequest[] = []
  const commandRequests: Record<string, unknown>[] = []
  const jobs: SchedulerJob[] = []
  const modelPolicyReason = "This legacy visual QA fixture explicitly requires GPT Fast."

  await mockOpenCodeServer(page, {
    directory,
    project: [project(projectID, directory, "Scheduled Jobs"), project("proj_docs", docsDirectory, "Docs Portal")],
    provider: provider(),
    sessions: [session()],
    pageMessages: () => ({ items: [] }),
  })
  await mockScheduledJobsPlugin(page)
  await mockSchedulerApi(page, jobs, requests)
  await page.route("**/app/host/command", (route) => {
    commandRequests.push(JSON.parse(route.request().postData() ?? "{}"))
    return json(route, { output: "Write-Output 'scheduled smoke'" })
  })
  await configurePage(page)

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectAppVisible(page.locator(".oc-scheduled-jobs"))
  await expectAppVisible(page.getByText("No scheduled jobs yet."))

  await page.getByRole("button", { name: "New" }).click()
  await expectAppVisible(page.getByRole("heading", { name: "New scheduled job" }))
  await expect(page.locator('[data-focus-key="name"]')).toHaveAttribute("title", /Human-readable job name/)
  await expect(page.locator('button.oc-scheduled-jobs__select-trigger[data-focus-key="scheduleMode"]')).toHaveAttribute(
    "title",
    /recurrence pattern/,
  )
  await page.locator('[data-focus-key="name"]').fill("Visual QA LLM job")
  await page
    .locator('[data-focus-key="description"]')
    .fill("Runs the weekday visual smoke suite and summarizes failures.")

  await choose(page, "scheduleMode", "Weekdays")
  await page.locator('[data-focus-key="scheduleTime"]').fill("07:30")
  await expect(page.locator(".oc-scheduled-jobs__hint").filter({ hasText: "Cron: 30 7 * * 1-5" })).toBeVisible()
  await choose(page, "scheduleMode", "Weekly")
  await choose(page, "scheduleWeekday", "Wednesday")
  await expect(page.locator(".oc-scheduled-jobs__hint").filter({ hasText: "Cron: 30 7 * * 3" })).toBeVisible()
  await choose(page, "scheduleMode", "Monthly")
  await choose(page, "scheduleMonthDay", "15")
  await expect(page.locator(".oc-scheduled-jobs__hint").filter({ hasText: "Cron: 30 7 15 * *" })).toBeVisible()
  await choose(page, "scheduleMode", "Every N hours")
  await choose(page, "scheduleHourInterval", "3 hours")
  await expect(page.locator(".oc-scheduled-jobs__hint").filter({ hasText: "Cron: 0 */3 * * *" })).toBeVisible()
  await choose(page, "scheduleMode", "Every N minutes")
  await choose(page, "scheduleMinuteInterval", "10 minutes")
  await expect(page.locator(".oc-scheduled-jobs__hint").filter({ hasText: "Cron: */10 * * * *" })).toBeVisible()

  await page.getByRole("button", { name: "Generate from prompt" }).click()
  await page.locator('[data-focus-key="generatePrompt"]').fill("daily at 07:45")
  await page.getByRole("button", { name: "Generate", exact: true }).click()
  await expect(page.locator(".oc-scheduled-jobs__generated")).toContainText("Generated daily 07:45.")
  await choose(page, "scheduleMode", "Custom cron")
  await page.locator('[data-focus-key="schedule"]').fill("15 6 * * 1-5")
  await expect(page.locator(".oc-scheduled-jobs__hint").filter({ hasText: "Cron: 15 6 * * 1-5" })).toBeVisible()

  await page.locator('[data-focus-key="prompt"]').fill("Run the smoke test and summarize failures.")
  await expect(page.locator('button.oc-scheduled-jobs__select-trigger[data-focus-key="runTarget"]')).toContainText(
    "App",
  )
  await expect(page.locator('button.oc-scheduled-jobs__select-trigger[data-focus-key="runTarget"]')).toHaveAttribute(
    "title",
    /opens OpenCode via deep link/,
  )
  await expect(
    page.locator('button.oc-scheduled-jobs__select-trigger[data-focus-key="appSessionStrategy"]'),
  ).toContainText("New session each run")
  await expect(
    page.locator('button.oc-scheduled-jobs__select-trigger[data-focus-key="appSessionStrategy"]'),
  ).toHaveAttribute("title", /creates a new session, reuses.*current session/)
  await choose(page, "appSessionStrategy", "Reusable job session")
  await expect(page.locator('[data-focus-key="appResetHistory"]')).toHaveAttribute(
    "title",
    /replace the reusable job session with a fresh session/i,
  )
  await page.locator('[data-focus-key="appResetHistory"]').check()
  await page.screenshot({ path: "e2e/test-results/scheduled-jobs-editor-tooltips-desktop.png", fullPage: true })
  await chooseModel(page, "GPT Fast")
  await choose(page, "variant", "High")
  await choose(page, "accessControl", "Approve for me")
  await choose(page, "workdirProject", "Docs Portal")
  await page.locator('[data-focus-key="attachUrl"]').fill("opencode://session/ses_existing")
  await choose(page, "runFormat", "JSON")
  await choose(page, "share", "No")
  await choose(page, "continue", "Yes")
  await choose(page, "timeoutSeconds", "5 minutes")
  await expectAppVisible(
    page.locator(".oc-scheduled-jobs__model-policy-status.is-unresolved").filter({ hasText: "Unresolved deviation" }),
  )
  await page.getByRole("button", { name: "Create" }).click()
  await expectAppVisible(
    page
      .locator(".oc-scheduled-jobs__status .error")
      .filter({ hasText: "explicitly confirmed model-policy exception" }),
  )
  expect(requests.filter((request) => request.method === "POST" && request.path === "/scheduler/jobs")).toHaveLength(0)
  await page.locator('[data-focus-key="modelPolicyExceptionConfirmed"]').check()
  await page.locator('[data-focus-key="modelPolicyExceptionReason"]').fill(modelPolicyReason)
  await page.getByRole("button", { name: "Create" }).click()

  await expect
    .poll(() => requests.find((request) => request.method === "POST" && request.path === "/scheduler/jobs")?.body)
    .toMatchObject({
      name: "Visual QA LLM job",
      description: "Runs the weekday visual smoke suite and summarizes failures.",
      schedule: "15 6 * * 1-5",
      workdir: docsDirectory,
      prompt: "Run the smoke test and summarize failures.",
      model: "opencode/gpt-fast",
      variant: "high",
      modelPolicyException: { model: "opencode/gpt-fast", variant: "high", reason: modelPolicyReason },
      runTarget: "app",
      appSessionStrategy: "job",
      appResetHistory: true,
      accessControl: {
        mode: "approve_for_me",
      },
      runFormat: "json",
      share: false,
      continue: true,
      attachUrl: "opencode://session/ses_existing",
      timeoutSeconds: 300,
    })
  await expectAppVisible(
    page
      .locator(".oc-scheduled-jobs__row")
      .filter({ hasText: "Runs the weekday visual smoke suite and summarizes failures." }),
  )
  await expectAppVisible(page.locator(".oc-scheduled-jobs__row").filter({ hasText: "Explicit model exception" }))

  await page
    .locator(".oc-scheduled-jobs__row")
    .filter({ hasText: "Visual QA LLM job" })
    .getByRole("button")
    .first()
    .click()
  await expectAppVisible(
    page.locator(".oc-scheduled-jobs__summary").filter({ hasText: "Run the smoke test and summarize failures." }),
  )
  await expect(page.locator(".oc-scheduled-jobs__info")).toHaveCount(0)
  await page.getByRole("button", { name: "Logs" }).click()
  await expectAppVisible(page.getByRole("button", { name: "← Back" }))
  await expectAppVisible(page.locator(".oc-scheduled-jobs__info dd").filter({ hasText: /^App$/ }))
  await expectAppVisible(
    page
      .locator(".oc-scheduled-jobs__info dd")
      .filter({ hasText: "Runs the weekday visual smoke suite and summarizes failures." }),
  )
  await expectAppVisible(page.locator(".oc-scheduled-jobs__info dd").filter({ hasText: "Reusable job session" }))
  await expectAppVisible(page.locator(".oc-scheduled-jobs__info dd").filter({ hasText: /^Yes$/ }))
  await expectAppVisible(page.locator(".oc-scheduled-jobs__info dd").filter({ hasText: /^ses_scheduled_app_job$/ }))
  await expectAppVisible(page.getByRole("button", { name: "Open app session" }))
  await page.screenshot({ path: "e2e/test-results/scheduled-jobs-app-target-desktop.png", fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  await expectAppVisible(page.locator('[data-component="session-dock-shell"][data-layout="mobile-stack"]'))
  await page.locator('[data-action="mobile-dock-launcher"]').click()
  const mobileDock = page.locator('[data-dock-wrapper="mobile"]')
  await expectAppVisible(mobileDock)
  await mobileDock.getByRole("tab", { name: "Scheduled Jobs", exact: true }).click()
  await expectAppVisible(
    page.locator(".oc-scheduled-jobs__info").filter({ hasText: "Run target" }).filter({ hasText: "App" }),
  )
  await expectAppVisible(
    page.locator(".oc-scheduled-jobs__info").filter({ hasText: "Session" }).filter({ hasText: "Reusable job session" }),
  )
  await expectAppVisible(
    page.locator(".oc-scheduled-jobs__info").filter({ hasText: "Replace session" }).filter({ hasText: "Yes" }),
  )
  await page.locator(".oc-scheduled-jobs__detail").evaluate((node) => node.scrollTo(0, 240))
  await page.screenshot({ path: "e2e/test-results/scheduled-jobs-app-target-mobile.png", fullPage: true })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole("button", { name: "← Back" }).click()

  jobs.push(legacyLlmJob())
  await page.getByRole("button", { name: "Refresh" }).click()
  await expectAppVisible(page.locator(".oc-scheduled-jobs__row").filter({ hasText: "Legacy CLI LLM job" }))
  await expectAppVisible(
    page.locator(".oc-scheduled-jobs__row").filter({ hasText: "Unresolved model-policy exception" }),
  )
  await page
    .locator(".oc-scheduled-jobs__row")
    .filter({ hasText: "Legacy CLI LLM job" })
    .getByRole("button")
    .first()
    .click()
  await page.getByRole("button", { name: "Logs" }).click()
  await expectAppVisible(page.locator(".oc-scheduled-jobs__info dd").filter({ hasText: /^CLI$/ }))
  await page.getByRole("button", { name: "← Back" }).click()
  await page.locator(".oc-scheduled-jobs__row").filter({ hasText: "Legacy CLI LLM job" }).getByRole("button").dblclick()
  await expect(page.locator('button.oc-scheduled-jobs__select-trigger[data-focus-key="runTarget"]')).toContainText(
    "CLI",
  )
  await expect(
    page.locator('button.oc-scheduled-jobs__select-trigger[data-focus-key="appSessionStrategy"]'),
  ).toHaveCount(0)
  await expect(page.locator('.oc-scheduled-jobs__model-picker button[aria-label="Model"]')).toContainText("GPT Fast")
  await expect(page.locator('button.oc-scheduled-jobs__select-trigger[data-focus-key="variant"]')).toContainText(
    "Default",
  )
  await expectAppVisible(
    page.locator(".oc-scheduled-jobs__model-policy-status.is-unresolved").filter({ hasText: "Unresolved deviation" }),
  )
  await page.getByRole("button", { name: "← Back" }).click()

  await page.getByRole("button", { name: "New" }).click()
  await page.locator('[data-focus-key="name"]').fill("Visual QA PowerShell job")
  await choose(page, "jobType", "PowerShell command")
  await expect(page.locator(".oc-scheduled-jobs__model-policy")).toHaveCount(0)
  await choose(page, "scheduleMode", "Every N minutes")
  await choose(page, "scheduleMinuteInterval", "5 minutes")
  await expect(page.locator('[data-focus-key="shellCommand"]')).toHaveAttribute("title", /Windows executes/)
  await page.locator('[data-focus-key="shellCommand"]').fill("Print the scheduled smoke marker")
  await choose(page, "workdirProject", "Custom path...")
  await page.locator('[data-focus-key="workdir"]').fill(scratchDirectory)
  await page.getByRole("button", { name: "Generate PowerShell" }).click()
  await expect
    .poll(() => commandRequests[0])
    .toMatchObject({
      command: "opencode",
      arguments: [
        "run",
        "--model",
        "openai/gpt-5.6-sol",
        "--variant",
        "high",
        "--",
        expect.stringContaining("Print the scheduled smoke marker"),
      ],
      directory: scratchDirectory,
    })
  await expect(page.locator('[data-focus-key="shellCommand"]')).toHaveValue("Write-Output 'scheduled smoke'")
  await page.getByRole("button", { name: "Create" }).click()

  await expect
    .poll(
      () => requests.filter((request) => request.method === "POST" && request.path === "/scheduler/jobs").at(-1)?.body,
    )
    .toMatchObject({
      name: "Visual QA PowerShell job",
      schedule: "*/5 * * * *",
      workdir: scratchDirectory,
      prompt: "",
      invocation: {
        command: "powershell.exe",
        args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "Write-Output 'scheduled smoke'"],
      },
    })
  await expectAppVisible(page.locator(".oc-scheduled-jobs__row").filter({ hasText: "Visual QA PowerShell job" }))
  await page
    .locator(".oc-scheduled-jobs__row")
    .filter({ hasText: "Visual QA PowerShell job" })
    .getByRole("button")
    .click()
  await expectAppVisible(
    page.locator(".oc-scheduled-jobs__summary").filter({ hasText: "Write-Output 'scheduled smoke'" }),
  )
  await expect(page.locator(".oc-scheduled-jobs__summary")).not.toHaveText(/^powershell\.exe$/i)

  await page
    .locator(".oc-scheduled-jobs__row")
    .filter({ hasText: "Visual QA LLM job" })
    .getByRole("button")
    .first()
    .click()
  await expectAppVisible(
    page.locator(".oc-scheduled-jobs__summary").filter({ hasText: "Run the smoke test and summarize failures." }),
  )
  await page.getByRole("button", { name: "Edit", exact: true }).click()
  await page.locator('[data-focus-key="description"]').fill("Runs the edited visual smoke suite and reports blockers.")
  await page.locator('[data-focus-key="prompt"]').fill("Run the edited smoke test and report blockers.")
  await choose(page, "variant", "Xhigh")
  await choose(page, "accessControl", "Full access")
  await page.getByRole("button", { name: "Save" }).click()
  await expectAppVisible(
    page
      .locator(".oc-scheduled-jobs__status .error")
      .filter({ hasText: "explicitly confirmed model-policy exception" }),
  )
  expect(
    requests.filter((request) => request.method === "PATCH" && request.path === "/scheduler/jobs/visual-qa-llm-job"),
  ).toHaveLength(0)
  const updatedPolicyReason = "The edited fixture explicitly requires GPT Fast with xhigh thinking."
  await page.locator('[data-focus-key="modelPolicyExceptionConfirmed"]').check()
  await page.locator('[data-focus-key="modelPolicyExceptionReason"]').fill(updatedPolicyReason)
  await page.getByRole("button", { name: "Save" }).click()
  await expect
    .poll(
      () =>
        requests.find((request) => request.method === "PATCH" && request.path === "/scheduler/jobs/visual-qa-llm-job")
          ?.body,
    )
    .toMatchObject({
      description: "Runs the edited visual smoke suite and reports blockers.",
      prompt: "Run the edited smoke test and report blockers.",
      variant: "xhigh",
      modelPolicyException: { model: "opencode/gpt-fast", variant: "xhigh", reason: updatedPolicyReason },
      accessControl: { mode: "full_access" },
    })

  await page.locator(".oc-scheduled-jobs__row").filter({ hasText: "Visual QA LLM job" }).getByRole("button").dblclick()
  await chooseModel(page, "GPT-5.6 Sol")
  await choose(page, "variant", "High")
  await expect(page.locator(".oc-scheduled-jobs__model-policy")).toHaveCount(0)
  await page.getByRole("button", { name: "Save" }).click()
  await expect
    .poll(
      () =>
        requests
          .filter((request) => request.method === "PATCH" && request.path === "/scheduler/jobs/visual-qa-llm-job")
          .at(-1)?.body,
    )
    .toMatchObject({ model: "openai/gpt-5.6-sol", variant: "high" })
  const restoredPolicyRequest = requests
    .filter((request) => request.method === "PATCH" && request.path === "/scheduler/jobs/visual-qa-llm-job")
    .at(-1)?.body
  expect(restoredPolicyRequest).not.toHaveProperty("modelPolicyException")

  await page
    .locator(".oc-scheduled-jobs__row")
    .filter({ hasText: "Visual QA LLM job" })
    .getByRole("button")
    .first()
    .click()
  await page.getByRole("button", { name: "Logs" }).click()
  await expectAppVisible(page.locator(".oc-scheduled-jobs__info dd").filter({ hasText: "Full access" }))
  await page.getByRole("button", { name: "← Back" }).click()
  await page.locator(".oc-scheduled-jobs__config-actions").getByRole("button", { name: "Run" }).click()
  await expect
    .poll(
      () =>
        requests.find(
          (request) =>
            request.method === "POST" && request.path === "/scheduler/jobs/visual-qa-llm-job/run-current-client",
        )?.body,
    )
    .toMatchObject({
      lookupWorkdir: docsDirectory,
      scopeId: schedulerScopeID,
    })
  await expectAppVisible(page.locator("pre").filter({ hasText: "scheduler log for visual-qa-llm-job" }))
  await page.screenshot({ path: "e2e/test-results/scheduled-jobs-llm-run.png", fullPage: true })
  await page.getByRole("button", { name: "← Back" }).click()

  await deleteJob(page, requests, "Visual QA LLM job", "visual-qa-llm-job")
  await deleteJob(page, requests, "Visual QA PowerShell job", "visual-qa-powershell-job")
  await deleteJob(page, requests, "Legacy CLI LLM job", "legacy-cli-llm-job")
  await expectAppVisible(page.getByText("No scheduled jobs yet."))
  await page.screenshot({ path: "e2e/test-results/scheduled-jobs-cleaned-up.png", fullPage: true })
  expectNoSmokeErrors(errors, [], [])
})

test("separates an intentionally stopped job from real failures", async ({ page }) => {
  const errors = trackPageErrors(page)
  const requests: SchedulerRequest[] = []
  const jobs: SchedulerJob[] = [
    {
      name: "Stopped tagging job",
      slug: "stopped-tagging-job",
      schedule: "*/5 0-7,23 * * *",
      workdir: docsDirectory,
      run: { command: "powershell" },
      lastRunStatus: "failed",
      lastRunExitCode: 130,
      lastRunError: "stopped by user",
    },
    {
      name: "Broken cleanup job",
      slug: "broken-cleanup-job",
      schedule: "30 3 * * *",
      workdir: directory,
      run: { command: "powershell" },
      lastRunStatus: "failed",
      lastRunExitCode: 1,
      lastRunError: "exit code 1",
    },
  ]

  await mockOpenCodeServer(page, {
    directory,
    project: [project(projectID, directory, "Scheduled Jobs"), project("proj_docs", docsDirectory, "Docs Portal")],
    provider: provider(),
    sessions: [session()],
    pageMessages: () => ({ items: [] }),
  })
  await mockScheduledJobsPlugin(page)
  await mockSchedulerApi(page, jobs, requests)
  await configurePage(page)

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectAppVisible(page.locator(".oc-scheduled-jobs"))
  await expectAppVisible(page.locator(".oc-scheduled-jobs__group-title").filter({ hasText: /^Failed \(1\)$/ }))
  await expectAppVisible(page.locator(".oc-scheduled-jobs__group-title").filter({ hasText: /^Stopped \(1\)$/ }))
  await expectAppVisible(page.locator(".oc-scheduled-jobs__row").filter({ hasText: "Stopped tagging job" }))
  await page.locator(".oc-scheduled-jobs__row").filter({ hasText: "Stopped tagging job" }).getByRole("button").click()
  await expectAppVisible(page.locator(".oc-scheduled-jobs__summary").filter({ hasText: "stopped" }))
  expectNoSmokeErrors(errors, [], [])
})

test("runs an app job through the current renderer handoff", async ({ page }) => {
  const errors = trackPageErrors(page)
  const requests: SchedulerRequest[] = []
  const promptRequests: Array<{ sessionID: string; body: unknown }> = []
  const runId = "0123456789abcdef0123456789abcdef"
  const job: SchedulerJob = {
    name: "Current Renderer App Job",
    slug: "current-renderer-app-job",
    schedule: "0 7 * * *",
    workdir: directory,
    scopeId: schedulerScopeID,
    run: {
      prompt: "Run this in the current renderer.",
      runTarget: "app",
      appSessionStrategy: "current",
      appSessionID: sessionID,
    },
    lastRunStatus: "scheduled",
  }

  await mockOpenCodeServer(page, {
    directory,
    project: [project(projectID, directory, "Scheduled Jobs")],
    provider: provider(),
    sessions: [session()],
    pageMessages: () => ({ items: [] }),
    onSessionPrompt: (input) => {
      promptRequests.push(input)
      return {}
    },
  })
  await mockScheduledJobsPlugin(page)
  await mockSchedulerApi(page, [job], requests, {
    run: ({ job, request }) => {
      if (!job || request.body?.currentClient !== true) return undefined
      startMockScheduledRun(job, runId)
      const params = new URLSearchParams({ directory, scopeId: schedulerScopeID, slug: job.slug, runId })
      return {
        body: {
          success: true,
          output: "Scheduled app job dispatched to the current OpenCode client.",
          data: { handoff: handoffFromParams(params) },
        },
      }
    },
  })
  await configurePage(page)

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectAppVisible(page.locator(".oc-scheduled-jobs__row").filter({ hasText: job.name }))
  await page.locator(".oc-scheduled-jobs__config-actions").getByRole("button", { name: "Run" }).click()

  await expect
    .poll(() => requests.find((request) => request.path === `/scheduler/jobs/${job.slug}/run-current-client`)?.body)
    .toMatchObject({
      currentClient: true,
      lookupWorkdir: directory,
      scopeId: schedulerScopeID,
    })
  await expect.poll(() => promptRequests).toHaveLength(1)
  expect(promptRequests[0]).toMatchObject({
    sessionID,
    body: { prompt: { text: scheduledJobPrompt("Run this in the current renderer.") } },
  })
  expect(
    requests.some(
      (request) => request.path === `/scheduler/jobs/${job.slug}/state` && request.body?.status === "running",
    ),
  ).toBe(true)
  expectNoSmokeErrors(errors, [], [])
})

test("cancels a pending current-client handoff when its origin server unloads", async ({ page }) => {
  const errors = trackPageErrors(page)
  const originPort = process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"
  const secondaryPort = String(Number(originPort) + 1)
  const originServer = `http://192.168.178.59:${originPort}`
  const secondaryServer = `http://127.0.0.1:${secondaryPort}`
  const secondarySessionID = "ses_scheduler_secondary_server"
  const originSchedulerRequests: SchedulerRequest[] = []
  const secondarySchedulerRequests: SchedulerRequest[] = []
  const originPromptRequests: Array<{ sessionID: string; body: unknown }> = []
  const secondaryPromptRequests: Array<{ sessionID: string; body: unknown }> = []
  const secondaryCreatedSessionIDs: string[] = []
  const sessionRequests: Array<{ port: string; method: string; path: string }> = []
  const runId = "123456789abcdef0123456789abcdef0"
  const job: SchedulerJob = {
    name: "Immutable Origin App Job",
    slug: "immutable-origin-app-job",
    schedule: "0 7 * * *",
    workdir: directory,
    scopeId: schedulerScopeID,
    run: {
      prompt: "Stay on the scheduler origin server.",
      runTarget: "app",
      appSessionStrategy: "current",
      appSessionID: sessionID,
    },
    lastRunStatus: "scheduled",
  }
  let releaseRun = () => {}
  let runRequestPending = false
  let handoffReleased = false
  const pendingRun = new Promise<void>((resolve) => {
    releaseRun = resolve
  })

  page.on("request", (request) => {
    if (!handoffReleased) return
    const url = new URL(request.url())
    if (url.port !== originPort && url.port !== secondaryPort) return
    if (url.pathname !== `/session/${sessionID}` && !/^\/api\/session\/[^/]+\/prompt$/.test(url.pathname)) {
      return
    }
    sessionRequests.push({ port: url.port, method: request.method(), path: url.pathname })
  })

  await mockOpenCodeServer(page, {
    port: originPort,
    directory,
    project: [project(projectID, directory, "Origin Scheduled Jobs")],
    provider: provider(),
    sessions: [session()],
    pageMessages: () => ({ items: [] }),
    onSessionPrompt: (input) => {
      originPromptRequests.push(input)
      return {}
    },
  })
  await mockOpenCodeServer(page, {
    port: secondaryPort,
    directory,
    project: [project("proj_scheduler_secondary", directory, "Secondary Scheduled Jobs")],
    provider: provider(),
    sessions: [session(secondarySessionID, "Secondary scheduler server")],
    pageMessages: () => ({ items: [] }),
    onSessionCreate: (body) => {
      const value = body && typeof body === "object" ? (body as Record<string, unknown>) : undefined
      const id = typeof value?.id === "string" ? value.id : "ses_scheduler_secondary_created"
      secondaryCreatedSessionIDs.push(id)
      return session(id, "Unexpected secondary scheduled run")
    },
    onSessionPrompt: (input) => {
      secondaryPromptRequests.push(input)
      return {}
    },
  })
  await mockScheduledJobsPlugin(page)
  await mockSchedulerApi(page, [job], originSchedulerRequests, {
    port: originPort,
    run: async ({ job, request }) => {
      if (!job || request.body?.currentClient !== true) return undefined
      runRequestPending = true
      await pendingRun
      startMockScheduledRun(job, runId)
      const params = new URLSearchParams({ directory, scopeId: schedulerScopeID, slug: job.slug, runId })
      return {
        body: {
          success: true,
          output: "Scheduled app job dispatched to the current OpenCode client.",
          data: { handoff: handoffFromParams(params) },
        },
      }
    },
  })
  await mockSchedulerApi(page, [], secondarySchedulerRequests, { port: secondaryPort })
  await configurePage(page, [sessionID], originServer, [
    { server: secondaryServer, sessionID: secondarySessionID, displayName: "Secondary server" },
  ])

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectAppVisible(page.locator(".oc-scheduled-jobs__row").filter({ hasText: job.name }))
  await page.locator(".oc-scheduled-jobs__config-actions").getByRole("button", { name: "Run" }).click()
  await expect.poll(() => runRequestPending).toBe(true)

  await page.getByRole("tab", { name: /Secondary scheduler server/ }).click()
  await expect
    .poll(() =>
      page.evaluate((server) => {
        const recent = JSON.parse(localStorage.getItem("opencode.global.dat:tabs.recent") ?? "{}") as { key?: string }
        return recent.key?.startsWith(`${server}\n`) === true
      }, secondaryServer),
    )
    .toBe(true)
  handoffReleased = true
  releaseRun()

  // The server claim survives, but unloading its plugin cancels all renderer work.
  // Recovery is performed by the origin plugin after an explicit reconnect.
  await expect.poll(() => job.lastRunStatus).toBe("running")
  await expectAppVisible(page.getByRole("tab", { name: /Secondary scheduler server/ }))
  await page.waitForTimeout(250)
  expect(originPromptRequests).toHaveLength(0)
  expect(secondaryCreatedSessionIDs).toHaveLength(0)
  expect(secondaryPromptRequests).toHaveLength(0)
  expect(secondarySchedulerRequests.filter((request) => request.method !== "GET")).toHaveLength(0)
  expect(sessionRequests).toHaveLength(0)
  expect(originSchedulerRequests.filter((request) => request.path.endsWith("/state"))).toHaveLength(0)
  expectNoSmokeErrors(errors, [], [])
})

test("does not claim or fall back to an OS launch when an older backend lacks current-client runs", async ({
  page,
}) => {
  const errors = trackPageErrors(page)
  const requests: SchedulerRequest[] = []
  const promptRequests: Array<{ sessionID: string; body: unknown }> = []
  const job: SchedulerJob = {
    name: "Older Backend App Job",
    slug: "older-backend-app-job",
    schedule: "0 7 * * *",
    workdir: directory,
    scopeId: schedulerScopeID,
    run: {
      prompt: "This must not launch through the legacy endpoint.",
      runTarget: "app",
      appSessionStrategy: "current",
      appSessionID: sessionID,
    },
    lastRunStatus: "scheduled",
  }

  await mockOpenCodeServer(page, {
    directory,
    project: [project(projectID, directory, "Scheduled Jobs")],
    provider: provider(),
    sessions: [session()],
    pageMessages: () => ({ items: [] }),
    onSessionPrompt: (input) => {
      promptRequests.push(input)
      return {}
    },
  })
  await mockScheduledJobsPlugin(page)
  await mockSchedulerApi(page, [job], requests, {
    run: ({ request }) =>
      request.path.endsWith("/run-current-client")
        ? { status: 400, body: { success: false, output: "Expected /scheduler/jobs/:name/run" } }
        : undefined,
  })
  await configurePage(page)

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectAppVisible(page.locator(".oc-scheduled-jobs__row").filter({ hasText: job.name }))
  await page.locator(".oc-scheduled-jobs__config-actions").getByRole("button", { name: "Run" }).click()

  await expectAppVisible(
    page.locator(".oc-scheduled-jobs__status .error").filter({ hasText: "Expected /scheduler/jobs/:name/run" }),
  )
  expect(requests.some((request) => request.path === `/scheduler/jobs/${job.slug}/run-current-client`)).toBe(true)
  expect(requests.some((request) => request.path === `/scheduler/jobs/${job.slug}/run`)).toBe(false)
  expect(promptRequests).toHaveLength(0)
  expect(job.lastRunStatus).toBe("scheduled")
  expectNoSmokeErrors(
    errors.filter((error) => !error.includes("status of 400 (Bad Request)")),
    [],
    [],
  )
})

test("fails before prompt admission when the server cannot persist the result contract", async ({ page }) => {
  const requests: SchedulerRequest[] = []
  const promptRequests: Array<{ sessionID: string; body: unknown }> = []
  const runId = "0123456789abcdef0123456789abcdea"
  const job: SchedulerJob = {
    name: "Older Result Contract Server",
    slug: "older-result-contract-server",
    schedule: "0 7 * * *",
    workdir: directory,
    scopeId: schedulerScopeID,
    run: {
      prompt: "Do not admit this prompt without a reliable result contract.",
      runTarget: "app",
      appSessionStrategy: "current",
      appSessionID: sessionID,
    },
    lastRunStatus: "scheduled",
  }

  await mockOpenCodeServer(page, {
    directory,
    project: [project(projectID, directory, "Scheduled Jobs")],
    provider: provider(),
    sessions: [session()],
    pageMessages: () => ({ items: [] }),
    onSessionPrompt: (input) => {
      promptRequests.push(input)
      return {}
    },
  })
  await mockScheduledJobsPlugin(page)
  await mockSchedulerApi(page, [job], requests, {
    run: ({ job, request }) => {
      if (!job || request.body?.currentClient !== true) return undefined
      startMockScheduledRun(job, runId)
      const params = new URLSearchParams({ directory, scopeId: schedulerScopeID, slug: job.slug, runId })
      return {
        body: {
          success: true,
          data: { handoff: handoffFromParams(params) },
        },
      }
    },
    state: ({ job, request }) =>
      request.body?.resultContract ? { status: 200, body: { success: true, data: { job } } } : undefined,
  })
  await configurePage(page)

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectAppVisible(page.locator(".oc-scheduled-jobs__row").filter({ hasText: job.name }))
  await page.locator(".oc-scheduled-jobs__config-actions").getByRole("button", { name: "Run" }).click()

  await expect
    .poll(() =>
      requests
        .filter((request) => request.path === `/scheduler/jobs/${job.slug}/state`)
        .map((request) => request.body?.status),
    )
    .toContain("failed")
  await expect.poll(() => job.lastRunStatus).toBe("failed")
  expect(promptRequests).toHaveLength(0)
  expect(job.lastRunError).toContain("does not support reliable scheduled job results")
})

test("creates, reuses, and replaces a stale reusable app session in the connected LAN renderer", async ({ page }) => {
  const errors = trackPageErrors(page)
  const requests: SchedulerRequest[] = []
  const promptRequests: Array<{ sessionID: string; body: unknown }> = []
  const createdSessionIDs = ["ses_remote_first_job_run", "ses_remote_replacement_job_run"]
  const remoteServer = `http://192.168.178.59:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
  const runIDs = [
    "abcdef0123456789abcdef0123456789",
    "bcdef0123456789abcdef0123456789a",
    "cdef0123456789abcdef0123456789ab",
  ]
  const sessions = [session()]
  let createdCount = 0
  let runCount = 0
  const job: SchedulerJob = {
    name: "Remote First Reusable Job",
    slug: "remote-first-reusable-job",
    schedule: "0 7 * * *",
    workdir: directory,
    scopeId: schedulerScopeID,
    run: {
      prompt: "Run the first reusable job in this renderer.",
      runTarget: "app",
      appSessionStrategy: "job",
    },
    lastRunStatus: "scheduled",
  }

  await mockOpenCodeServer(page, {
    directory,
    project: [project(projectID, directory, "Scheduled Jobs")],
    provider: provider(),
    sessions,
    pageMessages: () => ({ items: [] }),
    onSessionCreate: () => {
      const created = session(createdSessionIDs[createdCount++]!, "Remote First Reusable Job")
      sessions.push(created)
      return created
    },
    onSessionPrompt: (input) => {
      promptRequests.push(input)
      return {}
    },
  })
  await mockScheduledJobsPlugin(page)
  await mockSchedulerApi(page, [job], requests, {
    run: ({ job, request }) => {
      if (!job || request.body?.currentClient !== true) return undefined
      const runId = runIDs[runCount++]!
      startMockScheduledRun(job, runId)
      const params = new URLSearchParams({ directory, scopeId: schedulerScopeID, slug: job.slug, runId })
      return {
        body: {
          success: true,
          output: "Scheduled app job dispatched to the current OpenCode client.",
          data: { handoff: handoffFromParams(params) },
        },
      }
    },
  })
  await configurePage(page, [sessionID], remoteServer)

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectAppVisible(page.locator(".oc-scheduled-jobs__row").filter({ hasText: job.name }))
  await page.locator(".oc-scheduled-jobs__config-actions").getByRole("button", { name: "Run" }).click()

  await expect.poll(() => promptRequests).toHaveLength(1)
  expect(promptRequests[0]).toMatchObject({
    sessionID: createdSessionIDs[0],
    body: { prompt: { text: scheduledJobPrompt("Run the first reusable job in this renderer.") } },
  })
  expect(job.run?.appSessionID).toBe(createdSessionIDs[0])
  expect(
    requests.find((request) => request.path === `/scheduler/jobs/${job.slug}/run-current-client`)?.body?.currentClient,
  ).toBe(true)

  await expect.poll(() => job.lastRunStatus).toBe("success")
  await page.locator(".oc-scheduled-jobs__config-actions").getByRole("button", { name: "Run" }).click()
  await expect.poll(() => promptRequests).toHaveLength(2)
  expect(promptRequests[1]?.sessionID).toBe(createdSessionIDs[0])
  expect(createdCount).toBe(1)

  await expect.poll(() => job.lastRunStatus).toBe("success")
  sessions.splice(
    sessions.findIndex((item) => item.id === createdSessionIDs[0]),
    1,
  )
  await page.locator(".oc-scheduled-jobs__config-actions").getByRole("button", { name: "Run" }).click()
  await expect.poll(() => promptRequests).toHaveLength(3)
  expect(promptRequests[2]?.sessionID).toBe(createdSessionIDs[1])
  expect(job.run?.appSessionID).toBe(createdSessionIDs[1])
  expect(createdCount).toBe(2)
  await expectAppVisible(page.getByText("Scheduled app session recreated"))
  await expectAppVisible(page.getByText(/lost its target session.*replacement session was created/i))
  expectNoSmokeErrors(errors, [], [])
})

test("recreates a reusable session that disappears after the run was claimed", async ({ page }) => {
  const errors = trackPageErrors(page)
  const requests: SchedulerRequest[] = []
  const missingSessionGets: string[] = []
  const sessionCreateRequests: unknown[] = []
  const promptRequests: Array<{ sessionID: string; body: unknown }> = []
  const targetSessionID = "ses_missing_claimed_job_session"
  const messageID = "msg_missing_claimed_job_session"
  const slug = "missing-claimed-job-session"
  const sessions = [session()]
  const jobs: SchedulerJob[] = [
    {
      name: "Missing Claimed Job Session",
      slug,
      schedule: "0 7 * * *",
      workdir: directory,
      scopeId: schedulerScopeID,
      run: {
        prompt: "Continue after recreating the missing session.",
        runTarget: "app",
        appSessionStrategy: "job",
        appSessionID: targetSessionID,
      },
      lastRunStatus: "running",
      lastRunRunId: "run-missing-claimed-session",
      lastRunSessionID: targetSessionID,
      lastRunMessageID: messageID,
      lastRunResultContract: "opencode.scheduled-job-result/v1",
    },
  ]

  await mockOpenCodeServer(page, {
    directory,
    project: [project(projectID, directory, "Scheduled Jobs")],
    provider: provider(),
    sessions,
    pageMessages: () => ({ items: [] }),
    onSessionCreate: (body) => {
      sessionCreateRequests.push(body)
      const created = session(targetSessionID, "Recreated scheduled session")
      sessions.push(created)
      return created
    },
    onSessionPrompt: (input) => {
      promptRequests.push(input)
      return {}
    },
  })
  await page.route(`**/session/${targetSessionID}**`, async (route) => {
    if (
      route.request().method() === "GET" &&
      new URL(route.request().url()).pathname === `/session/${targetSessionID}` &&
      missingSessionGets.length === 0
    ) {
      missingSessionGets.push(route.request().url())
      return json(route, { output: "Session not found." }, 404)
    }
    await route.fallback()
  })
  await mockScheduledJobsPlugin(page)
  await mockSchedulerApi(page, jobs, requests)
  await configurePage(page)

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expect.poll(() => promptRequests).toHaveLength(1)

  expect(promptRequests[0]).toMatchObject({
    sessionID: targetSessionID,
    body: { id: messageID, prompt: { text: scheduledJobPrompt("Continue after recreating the missing session.") } },
  })
  expect(sessionCreateRequests).toEqual([{ id: targetSessionID, location: { directory } }])
  expect(missingSessionGets).toHaveLength(1)
  await expectAppVisible(page.getByText("Scheduled app session recreated"))
  await expectAppVisible(page.getByText(/lost its target session.*replacement session was created/i))
  await page.screenshot({ path: "e2e/test-results/scheduled-jobs-session-recreated-desktop.png" })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('[data-action="mobile-dock-launcher"]').click()
  await page.locator('[data-dock-wrapper="mobile"]').getByRole("tab", { name: "Scheduled Jobs", exact: true }).click()
  await expectAppVisible(page.getByText("Scheduled app session recreated"))
  await page.screenshot({ path: "e2e/test-results/scheduled-jobs-session-recreated-mobile.png" })
  expectNoSmokeErrors(
    errors.filter((error) => !error.includes("status of 404")),
    [],
    [],
  )
})

test("shows command runTarget jobs as shell jobs", async ({ page }) => {
  const errors = trackPageErrors(page)
  const requests: SchedulerRequest[] = []
  const jobs: SchedulerJob[] = [
    {
      name: "Night Run Command Job",
      slug: "night-run-command-job",
      schedule: "0 1 * * *",
      workdir: docsDirectory,
      scopeId: schedulerScopeID,
      run: {
        runTarget: "command",
        command: "node",
        arguments: "scripts\\daily-agent-review.js analyze",
      },
      invocation: {
        command: "cmd.exe",
        args: ["/d", "/c", "C:\\Users\\crisc\\.config\\opencode\\scheduler\\tasks\\daily-agent-review-night-run.cmd"],
      },
      lastRunStatus: "scheduled",
    },
  ]

  await mockOpenCodeServer(page, {
    directory,
    project: [project(projectID, directory, "Scheduled Jobs"), project("proj_docs", docsDirectory, "Docs Portal")],
    provider: provider(),
    sessions: [session()],
    pageMessages: () => ({ items: [] }),
  })
  await mockScheduledJobsPlugin(page)
  await mockSchedulerApi(page, jobs, requests)
  await configurePage(page)

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectAppVisible(page.locator(".oc-scheduled-jobs__row").filter({ hasText: "Night Run Command Job" }))
  await expectAppVisible(
    page.locator(".oc-scheduled-jobs__summary").filter({ hasText: "node scripts\\daily-agent-review.js analyze" }),
  )
  await page.getByRole("button", { name: "Logs" }).click()
  await expectAppVisible(
    page.locator(".oc-scheduled-jobs__info").filter({ hasText: "Run target" }).filter({ hasText: "-" }),
  )
  await expectAppVisible(
    page
      .locator(".oc-scheduled-jobs__section")
      .filter({ hasText: "Command" })
      .filter({ hasText: "node scripts\\daily-agent-review.js analyze" }),
  )

  await page.getByRole("button", { name: "← Back" }).click()
  await page.locator(".oc-scheduled-jobs__config-actions").getByRole("button", { name: "Edit" }).click()
  await expect(page.locator('button.oc-scheduled-jobs__select-trigger[data-focus-key="jobType"]')).toContainText(
    "CMD command",
  )
  await expect(page.locator('[data-focus-key="shellCommand"]')).toHaveValue(/daily-agent-review-night-run\.cmd/)
  expectNoSmokeErrors(errors, [], [])
})

test("replaces a scheduled job session without reloading or duplicating run tabs", async ({ page }) => {
  const errors = trackPageErrors(page)
  const requests: SchedulerRequest[] = []
  const promptRequests: Array<{ sessionID: string; body: unknown }> = []
  const createdSessionIDs: string[] = []
  const scheduledRunSessionID = "ses_scheduled_deep_link_run"
  const prompt = "Run scheduled cold start smoke."
  const runId = "run-cold-start"
  const jobs: SchedulerJob[] = [
    {
      name: "Cold Start App Job",
      slug: "cold-start-app-job",
      schedule: "0 7 * * *",
      workdir: directory,
      prompt,
      run: {
        prompt,
        runTarget: "app",
        appSessionStrategy: "job",
        appSessionID: scheduledRunSessionID,
        appResetHistory: true,
        model: "opencode/gpt-fast",
        variant: "high",
      },
      lastRunStatus: "scheduled",
    },
  ]
  const sessions = [session(), session(scheduledRunSessionID, "Cold Start App Job")]
  const link = pluginHandoffURL(
    new URLSearchParams({
      directory,
      scopeId: schedulerScopeID,
      slug: "cold-start-app-job",
      runId,
    }),
  )

  await mockOpenCodeServer(page, {
    directory,
    project: [project(projectID, directory, "Scheduled Jobs")],
    provider: provider(),
    sessions,
    pageMessages: () => ({ items: [] }),
    onSessionPrompt: (input) => {
      promptRequests.push(input)
      return {}
    },
    onSessionCreate: (body) => {
      const id = typeof body === "object" && body !== null && "id" in body ? body.id : undefined
      if (typeof id !== "string") throw new Error("Scheduled reset session is missing its ID.")
      createdSessionIDs.push(id)
      const created = session(id, "Cold Start App Job")
      sessions.push(created)
      return created
    },
  })
  await mockScheduledJobsPlugin(page)
  await mockSchedulerApi(page, jobs, requests, {
    outcome: ({ count }) =>
      count === 1
        ? { status: "running", activityID: "activity_cold_start" }
        : { status: "success", activityID: "activity_cold_start" },
  })
  await configurePage(page)
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  const before = await page.evaluate(() => {
    const target = window as typeof window & {
      __scheduledRunSentinel?: { value: string }
    }
    target.__scheduledRunSentinel = { value: "existing-client-state" }
    return {
      timeOrigin: performance.timeOrigin,
      tabCount: JSON.parse(localStorage.getItem("opencode.global.dat:tabs") ?? "[]").length,
    }
  })
  startMockScheduledRun(jobs[0], runId)
  await page.evaluate((link) => {
    const target = window as typeof window & { __OPENCODE__?: { deepLinks?: string[] } }
    target.__OPENCODE__ = { ...target.__OPENCODE__, deepLinks: [link] }
    window.dispatchEvent(new CustomEvent("opencode:deep-link", { detail: { urls: [link] } }))
  }, link)

  await expect
    .poll(
      () =>
        requests.find((request) => request.method === "GET" && request.path === "/scheduler/jobs/cold-start-app-job")
          ?.query,
    )
    .toMatchObject({ scopeId: schedulerScopeID, workdir: directory })
  await expect.poll(() => createdSessionIDs).toHaveLength(1)
  const createdSessionID = createdSessionIDs[0]
  expect(createdSessionID).not.toBe(scheduledRunSessionID)
  await expect.poll(() => promptRequests[0]?.sessionID).toBe(createdSessionID)
  const body = promptRequests[0]?.body as Record<string, unknown> | undefined
  expect(body?.id).toBe("msg_300cafe59eda4d9c0b5d548dc6")
  expect(body?.model).toMatchObject({ providerID: "opencode", id: "gpt-fast", variant: "high" })
  expect(body?.prompt).toEqual({ text: scheduledJobPrompt(prompt) })
  await expect
    .poll(() =>
      requests.some(
        (request) => request.method === "GET" && request.path === "/scheduler/jobs/cold-start-app-job/outcome",
      ),
    )
    .toBe(true)
  expect(
    requests.some(
      (request) =>
        request.method === "POST" &&
        request.path === "/scheduler/jobs/cold-start-app-job/state" &&
        request.body?.status === "success",
    ),
  ).toBe(false)
  await expect
    .poll(
      () =>
        requests
          .filter((request) => request.method === "POST" && request.path === "/scheduler/jobs/cold-start-app-job/state")
          .at(-1)?.body,
    )
    .toMatchObject({ status: "success", appSessionID: createdSessionID, scopeId: schedulerScopeID, runId })
  await expect
    .poll(() =>
      page.evaluate((sessionID) => {
        const tabs = JSON.parse(localStorage.getItem("opencode.global.dat:tabs") ?? "[]") as Array<{
          sessionId?: string
        }>
        return tabs.some((tab) => tab.sessionId === sessionID)
      }, createdSessionID),
    )
    .toBe(true)
  await expect
    .poll(() =>
      page.evaluate((sessionID) => {
        const recent = JSON.parse(localStorage.getItem("opencode.global.dat:tabs.recent") ?? "{}") as { key?: string }
        return recent.key?.endsWith(`\n${sessionID}`) === true
      }, createdSessionID),
    )
    .toBe(true)
  await expectAppVisible(page.locator('[data-component="session-dock-shell"]'))
  await expect
    .poll(() =>
      page.evaluate(
        ({ scheduledRunSessionID, timeOrigin }) => {
          const target = window as typeof window & { __scheduledRunSentinel?: { value: string } }
          const tabs = JSON.parse(localStorage.getItem("opencode.global.dat:tabs") ?? "[]") as Array<{
            sessionId?: string
          }>
          return {
            sentinel: target.__scheduledRunSentinel?.value,
            timeOrigin: performance.timeOrigin === timeOrigin,
            scheduledTabs: tabs.filter((tab) => tab.sessionId === scheduledRunSessionID).length,
            tabCount: tabs.length,
          }
        },
        { scheduledRunSessionID: createdSessionID, timeOrigin: before.timeOrigin },
      ),
    )
    .toEqual({ sentinel: "existing-client-state", timeOrigin: true, scheduledTabs: 1, tabCount: before.tabCount + 1 })
  await page.evaluate((link) => {
    window.dispatchEvent(new CustomEvent("opencode:deep-link", { detail: { urls: [link] } }))
  }, link)
  await page.waitForTimeout(100)
  expect(
    requests.filter((request) => request.method === "GET" && request.path === "/scheduler/jobs/cold-start-app-job"),
  ).toHaveLength(2)
  expect(
    requests.filter(
      (request) => request.method === "POST" && request.path === "/scheduler/jobs/cold-start-app-job/state",
    ),
  ).toHaveLength(3)
  expect(promptRequests).toHaveLength(1)
  await page.screenshot({ path: "e2e/test-results/scheduled-jobs-deep-link-handoff-desktop.png", fullPage: true })
  expectNoSmokeErrors(errors, [], [])
})

test("reopens a persistently completed scheduled app run exactly once", async ({ page }) => {
  const errors = trackPageErrors(page)
  const requests: SchedulerRequest[] = []
  const promptRequests: Array<{ sessionID: string; body: unknown }> = []
  const scheduledRunSessionID = "ses_scheduled_completed_run"
  const runId = "run-already-completed"
  const slug = "completed-app-job"
  const link = pluginHandoffURL(
    new URLSearchParams({
      directory,
      scopeId: schedulerScopeID,
      slug,
      runId,
    }),
  )
  const jobs: SchedulerJob[] = [
    {
      name: "Completed App Job",
      slug,
      schedule: "0 7 * * *",
      workdir: directory,
      run: {
        prompt: "This prompt must not be submitted again.",
        runTarget: "app",
        appSessionStrategy: "job",
        appSessionID: scheduledRunSessionID,
      },
      lastRunStatus: "success",
      lastRunRunId: runId,
    },
  ]

  await mockOpenCodeServer(page, {
    directory,
    project: [project(projectID, directory, "Scheduled Jobs")],
    provider: provider(),
    sessions: [session(), session(scheduledRunSessionID, "Completed App Job")],
    pageMessages: () => ({ items: [] }),
    onSessionPrompt: (input) => {
      promptRequests.push(input)
      return {}
    },
  })
  await mockScheduledJobsPlugin(page)
  await mockSchedulerApi(page, jobs, requests)
  await configurePage(page, [sessionID, scheduledRunSessionID])
  await page.addInitScript((link) => {
    const target = window as typeof window & { __OPENCODE__?: { deepLinks?: string[] } }
    target.__OPENCODE__ = { ...target.__OPENCODE__, deepLinks: [link] }
  }, link)

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expect
    .poll(
      () => requests.filter((request) => request.method === "GET" && request.path === `/scheduler/jobs/${slug}`).length,
    )
    .toBe(1)
  await expect
    .poll(() =>
      page.evaluate((sessionID) => {
        const tabs = JSON.parse(localStorage.getItem("opencode.global.dat:tabs") ?? "[]") as Array<{
          sessionId?: string
        }>
        return tabs.filter((tab) => tab.sessionId === sessionID).length
      }, scheduledRunSessionID),
    )
    .toBe(1)

  await page.reload()
  await expect
    .poll(
      () => requests.filter((request) => request.method === "GET" && request.path === `/scheduler/jobs/${slug}`).length,
    )
    .toBe(2)
  await page.evaluate((link) => {
    window.dispatchEvent(new CustomEvent("opencode:deep-link", { detail: { urls: [link] } }))
  }, link)
  await page.waitForTimeout(100)

  expect(promptRequests).toHaveLength(0)
  expect(
    requests.filter((request) => request.method === "POST" && request.path === `/scheduler/jobs/${slug}/state`),
  ).toHaveLength(0)
  expect(
    requests.filter((request) => request.method === "GET" && request.path === `/scheduler/jobs/${slug}`),
  ).toHaveLength(3)
  expect(
    await page.evaluate((sessionID) => {
      const tabs = JSON.parse(localStorage.getItem("opencode.global.dat:tabs") ?? "[]") as Array<{
        sessionId?: string
      }>
      return tabs.filter((tab) => tab.sessionId === sessionID).length
    }, scheduledRunSessionID),
  ).toBe(1)
  expectNoSmokeErrors(errors, [], [])
})

test("keeps the active mobile session focused when a failed scheduled target no longer exists", async ({ page }) => {
  const errors = trackPageErrors(page)
  const requests: SchedulerRequest[] = []
  const promptRequests: Array<{ sessionID: string; body: unknown }> = []
  const staleSessionID = "ses_scheduled_missing_target"
  const runId = "run-missing-target"
  const slug = "missing-target-job"
  const link = pluginHandoffURL(
    new URLSearchParams({
      directory,
      scopeId: schedulerScopeID,
      slug,
      runId,
    }),
  )
  const jobs: SchedulerJob[] = [
    {
      name: "Missing Target Job",
      slug,
      schedule: "*/10 * * * *",
      workdir: directory,
      run: {
        prompt: "This failed run must not steal focus.",
        runTarget: "app",
        appSessionStrategy: "current",
        appSessionID: staleSessionID,
      },
      lastRunStatus: "failed",
      lastRunRunId: runId,
    },
  ]
  let staleLookups = 0

  await mockOpenCodeServer(page, {
    directory,
    project: [project(projectID, directory, "Scheduled Jobs")],
    provider: provider(),
    sessions: [session()],
    pageMessages: () => ({ items: [] }),
    onSessionPrompt: (input) => {
      promptRequests.push(input)
      return {}
    },
  })
  await mockScheduledJobsPlugin(page)
  await mockSchedulerApi(page, jobs, requests)
  await page.route(`**/session/${staleSessionID}?**`, (route) => {
    if (route.request().method() !== "GET") return route.fallback()
    staleLookups += 1
    return json(route, { name: "SessionNotFoundError", data: { sessionID: staleSessionID } }, 404)
  })
  await configurePage(page, [sessionID])

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  const modelPicker = page.locator(".mobile-model-list")
  await page.locator('[data-component="session-composer"] [data-action="prompt-model"]').click()
  await expectAppVisible(modelPicker)

  await page.evaluate((link) => {
    window.dispatchEvent(new CustomEvent("opencode:deep-link", { detail: { urls: [link] } }))
  }, link)

  await expect
    .poll(
      () => requests.filter((request) => request.method === "GET" && request.path === `/scheduler/jobs/${slug}`).length,
    )
    .toBe(1)
  await expect.poll(() => staleLookups).toBe(1)
  await expectAppVisible(modelPicker)
  expect(promptRequests).toHaveLength(0)
  expect(
    requests.filter((request) => request.method === "POST" && request.path === `/scheduler/jobs/${slug}/state`),
  ).toHaveLength(0)
  expect(
    await page.evaluate(
      ({ activeSessionID, staleSessionID }) => {
        const tabs = JSON.parse(localStorage.getItem("opencode.global.dat:tabs") ?? "[]") as Array<{
          sessionId?: string
        }>
        const recent = JSON.parse(localStorage.getItem("opencode.global.dat:tabs.recent") ?? "{}") as { key?: string }
        return {
          active: recent.key?.endsWith(`\n${activeSessionID}`) === true,
          staleTabs: tabs.filter((tab) => tab.sessionId === staleSessionID).length,
        }
      },
      { activeSessionID: sessionID, staleSessionID },
    ),
  ).toEqual({ active: true, staleTabs: 0 })
  expect(errors.filter((error) => !/Failed to load resource.*404/i.test(error))).toEqual([])
  expect(errors.filter((error) => /Failed to load resource.*404/i.test(error))).toHaveLength(1)
  expectNoSmokeErrors([], [], [])
})

test("resumes a pending new-session run with the persisted session and message after reload", async ({ page }) => {
  const requests: SchedulerRequest[] = []
  const promptRequests: Array<{ sessionID: string; body: unknown }> = []
  const sessionCreates: unknown[] = []
  const runId = "run-persisted-new-session"
  const persistedSessionID = "ses_persisted_scheduled_run"
  const persistedMessageID = "msg_persisted_scheduled_run"
  const jobs: SchedulerJob[] = [
    {
      name: "Persisted New Session Job",
      slug: "persisted-new-session-job",
      schedule: "0 7 * * *",
      workdir: directory,
      scopeId: schedulerScopeID,
      run: {
        prompt: "Continue the persisted scheduled run.",
        runTarget: "app",
        appSessionStrategy: "new",
        appSessionID: persistedSessionID,
      },
      lastRunStatus: "running",
      lastRunRunId: runId,
      lastRunSessionID: persistedSessionID,
      lastRunMessageID: persistedMessageID,
      lastRunSubmittedAt: Date.now(),
    },
  ]

  await mockOpenCodeServer(page, {
    directory,
    project: [project(projectID, directory, "Scheduled Jobs")],
    provider: provider(),
    sessions: [session(), session(persistedSessionID, "Persisted scheduled run")],
    pageMessages: () => ({ items: [] }),
    onSessionCreate: (body) => {
      sessionCreates.push(body)
      return session("ses_must_not_be_created", "Unexpected session")
    },
    onSessionPrompt: (input) => {
      promptRequests.push(input)
      return {}
    },
  })
  await mockScheduledJobsPlugin(page)
  await mockSchedulerApi(page, jobs, requests, {
    outcome: () => ({ status: "running", activityID: "activity_pending_question" }),
  })
  await configurePage(page, [sessionID, persistedSessionID])

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expect.poll(() => promptRequests.length).toBe(1)
  expect(promptRequests[0]).toMatchObject({
    sessionID: persistedSessionID,
    body: { id: persistedMessageID, prompt: { text: "Continue the persisted scheduled run." } },
  })
  const creationCount = sessionCreates.length
  expect(
    requests.some(
      (request) =>
        request.path === "/scheduler/jobs/persisted-new-session-job/state" && request.body?.status === "success",
    ),
  ).toBe(false)

  await page.reload()
  await expect.poll(() => promptRequests.length).toBe(2)
  expect(promptRequests[1]).toMatchObject({
    sessionID: persistedSessionID,
    body: { id: persistedMessageID, prompt: { text: "Continue the persisted scheduled run." } },
  })
  expect(sessionCreates).toHaveLength(creationCount)
})

test("retries a transient scheduled-job handoff without marking it failed or submitting twice", async ({ page }) => {
  const requests: SchedulerRequest[] = []
  const promptRequests: Array<{ sessionID: string; body: unknown }> = []
  const runId = "run-transient-job-load"
  const slug = "transient-job-load"
  const jobs: SchedulerJob[] = [
    {
      name: "Transient Job Load",
      slug,
      schedule: "0 7 * * *",
      workdir: directory,
      scopeId: schedulerScopeID,
      run: { prompt: "Recover this transient handoff.", runTarget: "app", appSessionStrategy: "new" },
      lastRunStatus: "running",
      lastRunRunId: runId,
    },
  ]

  await mockOpenCodeServer(page, {
    directory,
    project: [project(projectID, directory, "Scheduled Jobs")],
    provider: provider(),
    sessions: [session()],
    pageMessages: () => ({ items: [] }),
    onSessionPrompt: (input) => {
      promptRequests.push(input)
      return {}
    },
  })
  await mockScheduledJobsPlugin(page)
  await mockSchedulerApi(page, jobs, requests, {
    jobGet: ({ count }) => (count === 1 ? { status: 503, body: { output: "Temporary scheduler outage" } } : undefined),
  })
  await configurePage(page)

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expect.poll(() => promptRequests.length, { timeout: 10_000 }).toBe(1)
  await page.waitForTimeout(250)

  expect(promptRequests).toHaveLength(1)
  expect(
    requests.filter((request) => request.method === "GET" && request.path === `/scheduler/jobs/${slug}`).length,
  ).toBe(2)
  expect(
    requests.some(
      (request) =>
        request.method === "POST" &&
        request.path === `/scheduler/jobs/${slug}/state` &&
        request.body?.status === "failed",
    ),
  ).toBe(false)
})

test("reuses one provisional target when the first state claim returns 503", async ({ page }) => {
  const requests: SchedulerRequest[] = []
  const promptRequests: Array<{ sessionID: string; body: unknown }> = []
  const sessionCreates: unknown[] = []
  const runId = "run-state-claim-retry"
  const slug = "state-claim-retry"
  const targetSessionID = "ses_state_claim_retry"
  const sessions = [session()]
  const jobs: SchedulerJob[] = [
    {
      name: "State Claim Retry",
      slug,
      schedule: "0 7 * * *",
      workdir: directory,
      scopeId: schedulerScopeID,
      run: { prompt: "Submit once after the state retry.", runTarget: "app", appSessionStrategy: "new" },
      lastRunStatus: "running",
      lastRunRunId: runId,
    },
  ]

  await mockOpenCodeServer(page, {
    directory,
    project: [project(projectID, directory, "Scheduled Jobs")],
    provider: provider(),
    sessions,
    pageMessages: () => ({ items: [] }),
    onSessionCreate: (body) => {
      sessionCreates.push(body)
      const created = session(targetSessionID, "State claim retry")
      sessions.push(created)
      return created
    },
    onSessionPrompt: (input) => {
      promptRequests.push(input)
      return {}
    },
  })
  await mockScheduledJobsPlugin(page)
  await mockSchedulerApi(page, jobs, requests, {
    state: ({ count }) =>
      count === 1 ? { status: 503, body: { output: "State store temporarily unavailable" } } : undefined,
  })
  await configurePage(page)

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expect.poll(() => promptRequests.length, { timeout: 10_000 }).toBe(1)
  await page.waitForTimeout(250)

  expect(sessionCreates).toHaveLength(1)
  expect(promptRequests[0]?.sessionID).toBe(targetSessionID)
  expect(requests.filter((request) => request.path === `/scheduler/jobs/${slug}/state`).length).toBeGreaterThanOrEqual(
    2,
  )
})

test("retries the startup job list and resumes a persisted run exactly once", async ({ page }) => {
  const requests: SchedulerRequest[] = []
  const promptRequests: Array<{ sessionID: string; body: unknown }> = []
  const sessionCreates: unknown[] = []
  let sessionGets = 0
  const runId = "run-list-retry"
  const slug = "list-retry"
  const targetSessionID = "ses_list_retry"
  const messageID = "msg_list_retry"
  const jobs: SchedulerJob[] = [
    {
      name: "List Retry",
      slug,
      schedule: "0 7 * * *",
      workdir: directory,
      scopeId: schedulerScopeID,
      run: { prompt: "Resume after list recovery.", runTarget: "app", appSessionStrategy: "new" },
      lastRunStatus: "running",
      lastRunRunId: runId,
      lastRunSessionID: targetSessionID,
      lastRunMessageID: messageID,
    },
  ]

  await mockOpenCodeServer(page, {
    directory,
    project: [project(projectID, directory, "Scheduled Jobs")],
    provider: provider(),
    sessions: [session(), session(targetSessionID, "List retry")],
    pageMessages: () => ({ items: [] }),
    onSessionCreate: (body) => {
      sessionCreates.push(body)
      return session("ses_unexpected_replacement", "Unexpected replacement")
    },
    onSessionPrompt: (input) => {
      promptRequests.push(input)
      return {}
    },
  })
  await page.route(`**/session/${targetSessionID}**`, (route) => {
    if (route.request().method() !== "GET") return route.fallback()
    sessionGets += 1
    if (sessionGets === 1) return json(route, { output: "Session lookup temporarily unavailable." }, 503)
    return route.fallback()
  })
  await mockScheduledJobsPlugin(page)
  await mockSchedulerApi(page, jobs, requests, {
    listGet: ({ count }) => (count === 1 ? { status: 503, body: { output: "Sidecar warming" } } : undefined),
  })
  await configurePage(page)

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expect.poll(() => promptRequests.length, { timeout: 10_000 }).toBe(1)
  await page.waitForTimeout(250)

  expect(promptRequests).toHaveLength(1)
  expect(promptRequests[0]).toMatchObject({ sessionID: targetSessionID, body: { id: messageID } })
  expect(sessionCreates).toHaveLength(0)
  expect(sessionGets).toBeGreaterThanOrEqual(2)
  expect(
    requests.filter(
      (request) =>
        request.method === "GET" && request.path === "/scheduler/jobs" && request.query.includeLegacy === "false",
    ),
  ).toHaveLength(2)
})

test("recovers an interrupted scheduled run after an outer service outage without replay", async ({ page }) => {
  const errors = trackPageErrors(page)
  const requests: SchedulerRequest[] = []
  const prompts: unknown[] = []
  const creates: unknown[] = []
  const failures: string[] = []
  const targetSessionID = "ses_interrupted_saved"
  const job: SchedulerJob = {
    name: "Interrupted Morning", slug: "interrupted-morning", schedule: "0 9 * * *",
    workdir: directory, scopeId: schedulerScopeID,
    run: { prompt: "Never replay this prompt.", runTarget: "app", appSessionStrategy: "job" },
    lastRunStatus: "running", lastRunRunId: "interrupted-run",
    lastRunSessionID: targetSessionID, lastRunMessageID: "msg_interrupted_saved",
    lastRunResultContract: "opencode.scheduled-job-result/v1",
  }
  await mockOpenCodeServer(page, {
    directory, project: [project(projectID, directory, "Scheduled Jobs")], provider: provider(),
    sessions: [session(), session(targetSessionID, "Interrupted Morning")], pageMessages: () => ({ items: [] }),
    onSessionPrompt: (input) => { prompts.push(input); return {} },
    onSessionCreate: (input) => { creates.push(input); return session("ses_unexpected", "Unexpected") },
  })
  await mockScheduledJobsPlugin(page)
  await mockSchedulerApi(page, [job], requests, {
    outcome: () => ({ status: "failed", error: "Interrupted before settlement", activityID: "activity_interrupted" }),
  })
  let unavailable = false
  await page.route("**/plugins/opencode-scheduler/services/jobs**", async (route) => {
    const input = JSON.parse(route.request().postData() ?? "{}").input
    if (!unavailable && input?.path === "/scheduler/jobs" && input?.query?.includeLegacy === "false") {
      unavailable = true
      return route.fulfill({ status: 503, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ message: "Scheduler service warming up" }) })
    }
    return route.fallback()
  })
  page.on("response", (response) => { if (response.status() >= 400) failures.push(`${response.status()} ${new URL(response.url()).pathname}`) })
  await configurePage(page)
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expect.poll(() => job.lastRunStatus, { timeout: 10_000 }).toBe("failed")
  await expect(page.locator(".oc-scheduled-jobs")).toBeVisible()
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(page.locator(".oc-scheduled-jobs").getByText("daily at 09:00 · failed", { exact: true })).toBeVisible()
  expect(unavailable).toBe(true)
  expect(prompts).toEqual([])
  expect(creates).toEqual([])
  expect(requests.filter((request) => request.path.endsWith("/state")).at(-1)?.body).toMatchObject({ status: "failed", messageID: "msg_interrupted_saved" })
  expect(failures).toEqual(["503 /plugins/opencode-scheduler/services/jobs"])
  expect(errors.filter((error) => !/Failed to load resource.*503/i.test(error))).toEqual([])
  await page.screenshot({ path: "e2e/test-results/scheduled-jobs-interrupted-recovery-desktop.png", fullPage: true })
})

test("marks a missing-prompt invariant failed instead of retrying forever", async ({ page }) => {
  const requests: SchedulerRequest[] = []
  const slug = "missing-prompt"
  const jobs: SchedulerJob[] = [
    {
      name: "Missing Prompt",
      slug,
      schedule: "0 7 * * *",
      workdir: directory,
      scopeId: schedulerScopeID,
      run: { runTarget: "app", appSessionStrategy: "new" },
      lastRunStatus: "running",
      lastRunRunId: "run-missing-prompt",
    },
  ]

  await mockOpenCodeServer(page, {
    directory,
    project: [project(projectID, directory, "Scheduled Jobs")],
    provider: provider(),
    sessions: [session()],
    pageMessages: () => ({ items: [] }),
  })
  await mockScheduledJobsPlugin(page)
  await mockSchedulerApi(page, jobs, requests, {
    state: ({ count }) =>
      count === 1 ? { status: 503, body: { output: "Failed-state persistence unavailable" } } : undefined,
  })
  await configurePage(page)

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expect.poll(() => jobs[0]?.lastRunStatus).toBe("failed")
  await page.waitForTimeout(1_250)

  expect(
    requests.filter((request) => request.method === "GET" && request.path === `/scheduler/jobs/${slug}`),
  ).toHaveLength(2)
  expect(
    requests.filter((request) => request.path === `/scheduler/jobs/${slug}/state` && request.body?.status === "failed"),
  ).toHaveLength(2)
  expect(jobs[0]?.lastRunStatus).toBe("failed")
})

test("treats a 410 prompt admission response as terminal", async ({ page }) => {
  const requests: SchedulerRequest[] = []
  const slug = "gone-prompt-target"
  const targetSessionID = "ses_gone_prompt_target"
  const jobs: SchedulerJob[] = [
    {
      name: "Gone Prompt Target",
      slug,
      schedule: "0 7 * * *",
      workdir: directory,
      scopeId: schedulerScopeID,
      run: {
        prompt: "This admission returns gone.",
        runTarget: "app",
        appSessionStrategy: "job",
        appSessionID: targetSessionID,
      },
      lastRunStatus: "running",
      lastRunRunId: "run-gone-prompt-target",
    },
  ]

  await mockOpenCodeServer(page, {
    directory,
    project: [project(projectID, directory, "Scheduled Jobs")],
    provider: provider(),
    sessions: [session(), session(targetSessionID, "Gone prompt target")],
    pageMessages: () => ({ items: [] }),
  })
  await page.route(new RegExp(`/api/session/${targetSessionID}/prompt(?:\\?|$)`), (route) =>
    json(route, { output: "Prompt target is gone." }, 410),
  )
  await mockScheduledJobsPlugin(page)
  await mockSchedulerApi(page, jobs, requests)
  await configurePage(page, [sessionID, targetSessionID])

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expect
    .poll(
      () =>
        requests.filter(
          (request) => request.path === `/scheduler/jobs/${slug}/state` && request.body?.status === "failed",
        ).length,
    )
    .toBe(1)
  expect(jobs[0]?.lastRunStatus).toBe("failed")
})

test("retries an admission 503 with the exact message after outcome reports admission missing", async ({ page }) => {
  const requests: SchedulerRequest[] = []
  const admissionBodies: Record<string, unknown>[] = []
  const targetSessionID = "ses_admission_retry"
  const slug = "admission-retry"
  const jobs: SchedulerJob[] = [
    {
      name: "Admission Retry",
      slug,
      schedule: "0 7 * * *",
      workdir: directory,
      scopeId: schedulerScopeID,
      run: {
        prompt: "Retry this exact admission.",
        runTarget: "app",
        appSessionStrategy: "job",
        appSessionID: targetSessionID,
      },
      lastRunStatus: "running",
      lastRunRunId: "run-admission-retry",
    },
  ]

  await mockOpenCodeServer(page, {
    directory,
    project: [project(projectID, directory, "Scheduled Jobs")],
    provider: provider(),
    sessions: [session(), session(targetSessionID, "Admission retry")],
    pageMessages: () => ({ items: [] }),
  })
  await page.route(`**/api/session/${targetSessionID}/prompt**`, async (route) => {
    admissionBodies.push(JSON.parse(route.request().postData() ?? "{}"))
    if (admissionBodies.length === 1) return json(route, { output: "Provider temporarily unavailable." }, 503)
    return json(route, { data: { sessionID: targetSessionID, messageID: admissionBodies[1]?.id, admittedSeq: 1 } })
  })
  await mockScheduledJobsPlugin(page)
  await mockSchedulerApi(page, jobs, requests, {
    outcome: ({ count }) =>
      count === 1
        ? { status: "pending", phase: "admission_missing" }
        : { status: "success", activityID: "activity_retry" },
  })
  await configurePage(page)

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expect.poll(() => jobs[0]?.lastRunStatus, { timeout: 10_000 }).toBe("success")

  expect(admissionBodies).toHaveLength(2)
  expect(admissionBodies[0]?.id).toBe(admissionBodies[1]?.id)
  expect(admissionBodies[0]?.prompt).toEqual(admissionBodies[1]?.prompt)
  expect(
    requests.filter(
      (request) => request.path === `/scheduler/jobs/${slug}/state` && request.body?.status === "success",
    ),
  ).toHaveLength(1)
})

test("keeps a pending question run non-terminal across polls and then completes once", async ({ page }) => {
  const requests: SchedulerRequest[] = []
  const promptRequests: Array<{ sessionID: string; body: unknown }> = []
  let outcomeCount = 0
  const targetSessionID = "ses_pending_question_run"
  const slug = "pending-question-run"
  const jobs: SchedulerJob[] = [
    {
      name: "Pending Question Run",
      slug,
      schedule: "0 7 * * *",
      workdir: directory,
      scopeId: schedulerScopeID,
      run: {
        prompt: "Wait for the pending question before completing.",
        runTarget: "app",
        appSessionStrategy: "job",
        appSessionID: targetSessionID,
      },
      lastRunStatus: "running",
      lastRunRunId: "run-pending-question",
    },
  ]

  await mockOpenCodeServer(page, {
    directory,
    project: [project(projectID, directory, "Scheduled Jobs")],
    provider: provider(),
    sessions: [session(), session(targetSessionID, "Pending question run")],
    pageMessages: () => ({ items: [] }),
    onSessionPrompt: (input) => {
      promptRequests.push(input)
      return {}
    },
  })
  await mockScheduledJobsPlugin(page)
  await mockSchedulerApi(page, jobs, requests, {
    outcome: ({ count }) => {
      outcomeCount = count
      if (count <= 2) return { status: "running", phase: "question_pending", activityID: "activity_question" }
      return { status: "success", activityID: "activity_question" }
    },
  })
  await configurePage(page)

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  const runningHeartbeats = () =>
    requests.filter(
      (request) =>
        request.method === "POST" &&
        request.path === `/scheduler/jobs/${slug}/state` &&
        request.body?.status === "running",
    )
  const pollHeartbeats = () => runningHeartbeats().filter((request) => request.body?.activityID === "activity_question")
  await expect.poll(() => pollHeartbeats().length, { timeout: 10_000 }).toBeGreaterThanOrEqual(2)
  expect(outcomeCount).toBeGreaterThanOrEqual(2)
  expect(
    pollHeartbeats()
      .slice(0, 2)
      .map((request) => request.body?.activityID),
  ).toEqual(["activity_question", "activity_question"])
  expect(
    pollHeartbeats()
      .slice(0, 2)
      .every((request) => request.body?.appSessionID === targetSessionID),
  ).toBe(true)
  expect(runningHeartbeats().length).toBeGreaterThanOrEqual(3)
  expect(
    requests.some((request) => request.path === `/scheduler/jobs/${slug}/state` && request.body?.status === "success"),
  ).toBe(false)
  await expect.poll(() => jobs[0]?.lastRunStatus, { timeout: 10_000 }).toBe("success")

  expect(promptRequests).toHaveLength(1)
  expect(pollHeartbeats()).toHaveLength(2)
  expect(
    requests.filter(
      (request) => request.path === `/scheduler/jobs/${slug}/state` && request.body?.status === "success",
    ),
  ).toHaveLength(1)
})

test("completes an explicitly dismissed scheduled question without reporting a failure", async ({ page }) => {
  const errors = trackPageErrors(page)
  const requests: SchedulerRequest[] = []
  const targetSessionID = "ses_dismissed_question_run"
  const slug = "dismissed-question-run"
  const jobs: SchedulerJob[] = [
    {
      name: "Dismissed Question Run",
      slug,
      schedule: "0 7 * * *",
      workdir: directory,
      scopeId: schedulerScopeID,
      run: {
        prompt: "Ask one review question.",
        runTarget: "app",
        appSessionStrategy: "job",
        appSessionID: targetSessionID,
      },
      lastRunStatus: "running",
      lastRunRunId: "run-dismissed-question",
    },
  ]

  await mockOpenCodeServer(page, {
    directory,
    project: [project(projectID, directory, "Scheduled Jobs")],
    provider: provider(),
    sessions: [session(), session(targetSessionID, "Dismissed question run")],
    pageMessages: () => ({ items: [] }),
  })
  await mockScheduledJobsPlugin(page)
  await mockSchedulerApi(page, jobs, requests, {
    outcome: () => ({ status: "dismissed", activityID: "activity_dismissed_question" }),
  })
  await configurePage(page)

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expect.poll(() => jobs[0]?.lastRunStatus, { timeout: 10_000 }).toBe("success")

  const terminal = requests.filter(
    (request) => request.path === `/scheduler/jobs/${slug}/state` && request.body?.status === "success",
  )
  expect(terminal).toHaveLength(1)
  expect(terminal[0]?.body).toMatchObject({
    resolution: "dismissed",
    appSessionID: targetSessionID,
    activityID: "activity_dismissed_question",
  })
  expect(
    requests.some((request) => request.path === `/scheduler/jobs/${slug}/state` && request.body?.status === "failed"),
  ).toBe(false)
  expectNoSmokeErrors(errors, [], [])
})

test("ignores a scheduled deep link that does not own the current run id", async ({ page }) => {
  const requests: SchedulerRequest[] = []
  const promptRequests: unknown[] = []
  const jobs: SchedulerJob[] = [
    {
      name: "Superseded App Job",
      slug: "superseded-app-job",
      schedule: "0 7 * * *",
      workdir: directory,
      scopeId: schedulerScopeID,
      run: { prompt: "Do not run this stale handoff.", runTarget: "app", appSessionStrategy: "new" },
      lastRunStatus: "scheduled",
      lastRunRunId: "newer-run-id",
    },
  ]

  await mockOpenCodeServer(page, {
    directory,
    project: [project(projectID, directory, "Scheduled Jobs")],
    provider: provider(),
    sessions: [session()],
    pageMessages: () => ({ items: [] }),
    onSessionPrompt: (input) => {
      promptRequests.push(input)
      return {}
    },
  })
  await mockScheduledJobsPlugin(page)
  await mockSchedulerApi(page, jobs, requests)
  await configurePage(page)
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)

  await runScheduledJobDeepLink(page, "superseded-app-job", "stale-run-id", directory)
  await page.waitForTimeout(150)

  expect(promptRequests).toEqual([])
  expect(
    requests.filter(
      (request) => request.method === "POST" && request.path === "/scheduler/jobs/superseded-app-job/state",
    ),
  ).toHaveLength(0)
})

test("silently drops a scheduled deep link after its job was deleted", async ({ page }) => {
  const requests: SchedulerRequest[] = []
  const jobs: SchedulerJob[] = []

  await mockOpenCodeServer(page, {
    directory,
    project: [project(projectID, directory, "Scheduled Jobs")],
    provider: provider(),
    sessions: [session()],
    pageMessages: () => ({ items: [] }),
  })
  await mockScheduledJobsPlugin(page)
  await mockSchedulerApi(page, jobs, requests)
  await configurePage(page)
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)

  await runScheduledJobDeepLink(page, "deleted-app-job", "run-deleted-app-job", directory)
  await expect
    .poll(() => requests.filter((request) => request.path === "/scheduler/jobs/deleted-app-job/state").length)
    .toBe(1)

  await expect(page.getByText("Scheduled app job failed", { exact: true })).toHaveCount(0)
  expect(requests.filter((request) => request.path === "/scheduler/jobs/deleted-app-job")).toHaveLength(1)
})

test("schedules a one-shot app job into the current session", async ({ page }) => {
  const errors = trackPageErrors(page)
  const failedResponses: string[] = []
  const requests: SchedulerRequest[] = []
  const promptRequests: Array<{ sessionID: string; body: unknown }> = []
  const jobs: SchedulerJob[] = []
  const prompt = "Remind me to check the current chat later."
  const slug = "current-session-one-shot"
  const secondSessionID = `${sessionID}_other_active`

  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`)
  })

  await mockOpenCodeServer(page, {
    directory,
    project: [project(projectID, directory, "Scheduled Jobs")],
    provider: provider(),
    sessions: [session(), session(secondSessionID, "Other active scheduled chat")],
    pageMessages: () => ({ items: [] }),
    onSessionPrompt: (input) => {
      promptRequests.push(input)
      return {}
    },
  })
  await mockScheduledJobsPlugin(page)
  await mockSchedulerApi(page, jobs, requests)
  await configurePage(page, [sessionID, secondSessionID])
  await page.addInitScript(() =>
    localStorage.setItem("opencode.app-plugin.scheduled-jobs-app.settings.refreshSeconds", "1"),
  )

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await page.getByRole("button", { name: "New" }).click()
  await page.locator('[data-focus-key="name"]').fill("Current session one shot")
  await page.locator('[data-focus-key="runOnce"]').check()
  await page.locator('[data-focus-key="prompt"]').fill(prompt)
  await page.locator(`[data-dock-area="middle"] [data-dock-tab][data-session-id="${secondSessionID}"]`).click()
  await choose(page, "appSessionStrategy", "Current session")
  await expectAppVisible(page.locator(".oc-scheduled-jobs__section").filter({ hasText: sessionID }))
  await expect(page.locator(".oc-scheduled-jobs__model-policy")).toHaveCount(0)
  await page.getByRole("button", { name: "Create" }).click()

  await expect
    .poll(() => requests.find((request) => request.method === "POST" && request.path === "/scheduler/jobs")?.body)
    .toMatchObject({
      name: "Current session one shot",
      runOnce: true,
      runTarget: "app",
      appSessionStrategy: "current",
      appSessionID: sessionID,
      modelChain: "default",
      model: "",
      variant: "",
      prompt,
    })
  await page
    .locator(".oc-scheduled-jobs__row")
    .filter({ hasText: "Current session one shot" })
    .getByRole("button")
    .first()
    .click()
  await page.getByRole("button", { name: "Logs" }).click()
  await expectAppVisible(
    page.locator(".oc-scheduled-jobs__info").filter({ hasText: "Run once" }).filter({ hasText: "Yes" }),
  )
  await expectAppVisible(
    page.locator(".oc-scheduled-jobs__info").filter({ hasText: "App session" }).filter({ hasText: "Current session" }),
  )
  await expectAppVisible(
    page.locator(".oc-scheduled-jobs__info").filter({ hasText: "App session ID" }).filter({ hasText: sessionID }),
  )
  await page.locator(".oc-scheduled-jobs__detail").evaluate((node) => node.scrollTo(0, 0))
  await page.screenshot({ path: "e2e/test-results/scheduled-jobs-run-once-current-desktop.png", fullPage: true })
  await page.locator(".oc-scheduled-jobs__detail").evaluate((node) => node.scrollTo(0, 110))
  await page.screenshot({
    path: "e2e/test-results/scheduled-jobs-run-once-current-metadata-desktop.png",
    fullPage: true,
  })
  await page.locator(".oc-scheduled-jobs__detail").evaluate((node) => node.scrollTo(0, 170))
  await page.screenshot({
    path: "e2e/test-results/scheduled-jobs-run-once-current-session-desktop.png",
    fullPage: true,
  })
  await page.locator(".oc-scheduled-jobs__detail").evaluate((node) => node.scrollTo(0, 210))
  await page.screenshot({
    path: "e2e/test-results/scheduled-jobs-run-once-current-session-id-desktop.png",
    fullPage: true,
  })

  startMockScheduledRun(jobs[0], "run-once-current")
  await runScheduledJobDeepLink(page, slug, "run-once-current", directory)
  await expect.poll(() => promptRequests[0]?.sessionID).toBe(sessionID)
  await expect
    .poll(
      () =>
        requests
          .filter((request) => request.method === "POST" && request.path === `/scheduler/jobs/${slug}/state`)
          .at(-1)?.body,
    )
    .toMatchObject({ status: "success", appSessionID: sessionID, scopeId: schedulerScopeID, runId: "run-once-current" })

  await expect(page.locator(".oc-scheduled-jobs__row").filter({ hasText: "Current session one shot" })).toHaveCount(0)
  await expectAppVisible(page.getByText("No scheduled jobs yet."))
  await page.setViewportSize({ width: 390, height: 844 })
  await expectAppVisible(page.locator('[data-component="session-dock-shell"][data-layout="mobile-stack"]'))
  await page.screenshot({ path: "e2e/test-results/scheduled-jobs-run-once-current-mobile.png", fullPage: true })
  expect(failedResponses).toEqual([])
  expectNoSmokeErrors(errors, [], [])
})

test("passes scheduled app access control to the session before prompting", async ({ page }) => {
  const errors = trackPageErrors(page)
  const failedResponses: string[] = []
  const requests: SchedulerRequest[] = []
  const jobs: SchedulerJob[] = [scheduledAccessControlJob({ mode: "ask" })]
  const sessions = [session(), session("ses_scheduled_app_job", "Scheduled reusable app session", docsDirectory)]
  const sessionCreates: unknown[] = []
  const sessionUpdates: { sessionID: string; directory: string; body: unknown }[] = []
  const sessionPrompts: { sessionID: string; body: unknown }[] = []
  const handoffEvents: string[] = []
  const handoffEvidence: unknown[] = []

  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`)
  })

  await mockOpenCodeServer(page, {
    directory,
    project: [project(projectID, directory, "Scheduled Jobs"), project("proj_docs", docsDirectory, "Docs Portal")],
    provider: provider(),
    sessions,
    pageMessages: () => ({ items: [] }),
    onSessionCreate: (input) => {
      handoffEvents.push("create")
      sessionCreates.push(input)
      const body = input && typeof input === "object" && !Array.isArray(input) ? input : {}
      const created = session("ses_created_scheduled_app_job", "Created scheduled app session", docsDirectory)
      Object.assign(created, { metadata: (body as Record<string, unknown>).metadata })
      sessions.push(created)
      return created
    },
    onSessionUpdate: (input) => {
      handoffEvents.push("update")
      sessionUpdates.push(input)
      const body = input.body && typeof input.body === "object" && !Array.isArray(input.body) ? input.body : {}
      const target = sessions.find((item) => item.id === input.sessionID)
      if (target) Object.assign(target, { metadata: (body as Record<string, unknown>).metadata })
      return target ?? {}
    },
    onSessionPrompt: (input) => {
      handoffEvents.push("prompt")
      sessionPrompts.push(input)
      return {}
    },
  })
  await mockSchedulerApi(page, jobs, requests)
  await configurePage(page, [sessionID, "ses_scheduled_app_job"])

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)

  const accessControls = [
    { mode: "ask" },
    { mode: "approve_for_me", safety_review: { model: "opencode/deepseek-v4-flash-free" } },
    { mode: "full_access" },
  ] as const

  for (const accessControl of accessControls) {
    jobs[0].run = { ...jobs[0].run, accessControl }
    startMockScheduledRun(jobs[0], `run-${accessControl.mode}`)
    handoffEvents.length = 0
    sessionUpdates.length = 0
    sessionPrompts.length = 0

    await runScheduledJobDeepLink(page, jobs[0].slug, `run-${accessControl.mode}`)

    await expect
      .poll(() => sessionUpdates.at(-1)?.body)
      .toMatchObject({
        // The app persists the mode only. A reviewer copy embedded in a
        // legacy job payload must never be frozen into session metadata.
        metadata: { access_control: { mode: accessControl.mode } },
      })
    await expect
      .poll(() => sessionPrompts.at(-1))
      .toMatchObject({
        sessionID: "ses_scheduled_app_job",
        body: { prompt: { text: scheduledJobPrompt("Run the access control handoff smoke.") } },
      })
    expect(handoffEvents).toEqual(["update", "prompt"])
    handoffEvidence.push({
      accessControl,
      update: sessionUpdates.at(-1),
      prompt: sessionPrompts.at(-1),
      handoffEvents: [...handoffEvents],
    })
  }

  const newSessionAccessControl = { mode: "full_access" } as const
  jobs[0].run = {
    ...jobs[0].run,
    appSessionStrategy: "new",
    appSessionID: undefined,
    accessControl: newSessionAccessControl,
  }
  handoffEvents.length = 0
  sessionCreates.length = 0
  sessionUpdates.length = 0
  sessionPrompts.length = 0

  startMockScheduledRun(jobs[0], "run-new-session")
  await runScheduledJobDeepLink(page, jobs[0].slug, "run-new-session")

  await expect
    .poll(() => sessionCreates.at(-1))
    .toMatchObject({
      id: expect.stringMatching(/^ses_/),
      location: { directory: docsDirectory },
    })
  await expect
    .poll(() => sessionUpdates.at(-1)?.body)
    .toMatchObject({
      metadata: { access_control: newSessionAccessControl },
    })
  await expect
    .poll(() => sessionPrompts.at(-1))
    .toMatchObject({
      sessionID: "ses_created_scheduled_app_job",
      body: { prompt: { text: scheduledJobPrompt("Run the access control handoff smoke.") } },
    })
  expect(handoffEvents).toEqual(["create", "update", "prompt"])
  handoffEvidence.push({
    accessControl: newSessionAccessControl,
    create: sessionCreates.at(-1),
    update: sessionUpdates.at(-1),
    prompt: sessionPrompts.at(-1),
    handoffEvents: [...handoffEvents],
  })

  const screenshot = process.env.VISUAL_QA_SCREENSHOT_DIR
    ? path.join(process.env.VISUAL_QA_SCREENSHOT_DIR, "scheduled-jobs-access-control-handoff.png")
    : "test-results/scheduled-jobs-access-control-handoff.png"
  if (process.env.VISUAL_QA_SCREENSHOT_DIR) {
    await fs.mkdir(process.env.VISUAL_QA_SCREENSHOT_DIR, { recursive: true })
    await fs.writeFile(
      path.join(process.env.VISUAL_QA_SCREENSHOT_DIR, "scheduled-jobs-access-control-handoff.json"),
      JSON.stringify({ handoffs: handoffEvidence, failedResponses }, null, 2),
    )
  }
  await page.screenshot({ path: screenshot, fullPage: true })
  expect(failedResponses).toEqual([])
  expectNoSmokeErrors(errors, [], [])
})

test("does not rerender when active sessions emit unchanged project events", async ({ page }) => {
  const errors = trackPageErrors(page)
  const requests: SchedulerRequest[] = []
  const jobs: SchedulerJob[] = [scheduledJob(1)]
  const secondSessionID = `${sessionID}_tab_b`
  const events: unknown[] = []
  let servedEvents = 0
  const currentProject = project(projectID, directory, "Scheduled Jobs")

  await mockOpenCodeServer(page, {
    directory,
    project: [currentProject],
    provider: provider(),
    sessions: [session(), session(secondSessionID, "Scheduled Jobs QA Tab B")],
    pageMessages: () => ({ items: [] }),
    sessionStatus: { [sessionID]: { type: "idle" }, [secondSessionID]: { type: "idle" } },
    events: () => {
      const next = events.splice(0, events.length)
      servedEvents += next.length
      return next
    },
    eventRetry: 16,
  })
  await mockScheduledJobsPlugin(page)
  await mockSchedulerApi(page, jobs, requests)
  await configurePage(page, [sessionID, secondSessionID])

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectAppVisible(page.locator(".oc-scheduled-jobs"))
  await expectAppVisible(page.locator(".oc-scheduled-jobs__row").filter({ hasText: "Scroll QA Job 1" }))
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("opencode.global.dat:tabs") ?? "[]").length))
    .toBe(2)

  const schedulerJobRequests = () =>
    requests.filter((request) => request.method === "GET" && request.path === "/scheduler/jobs")
  await expect
    .poll(async () => {
      const before = schedulerJobRequests().length
      await page.waitForTimeout(150)
      return schedulerJobRequests().length === before ? before : -1
    })
    .not.toBe(-1)
  const getRequestsBefore = schedulerJobRequests().length
  await page.evaluate(() => {
    const state = window as typeof window & {
      __scheduledJobsMutations?: number
      __scheduledJobsObserver?: MutationObserver
    }
    state.__scheduledJobsObserver?.disconnect()
    state.__scheduledJobsMutations = 0
    const view = document.querySelector(".oc-scheduled-jobs__view")
    if (!view) throw new Error("Scheduled Jobs view not mounted")
    state.__scheduledJobsObserver = new MutationObserver((mutations) => {
      state.__scheduledJobsMutations =
        (state.__scheduledJobsMutations ?? 0) + mutations.filter((mutation) => mutation.type === "childList").length
    })
    state.__scheduledJobsObserver.observe(view, { childList: true })
  })

  events.push(
    {
      directory,
      payload: { type: "session.status", properties: { sessionID, status: { type: "busy" } } },
    },
    {
      directory: "global",
      payload: {
        type: "project.updated",
        properties: { ...currentProject, time: { created: 1700000000000, updated: 1700000001000 } },
      },
    },
  )

  await expect.poll(() => servedEvents).toBeGreaterThanOrEqual(2)
  await expect
    .poll(async () => {
      const before = await page.evaluate(
        () => (window as typeof window & { __scheduledJobsMutations?: number }).__scheduledJobsMutations ?? 0,
      )
      await page.waitForTimeout(50)
      const after = await page.evaluate(
        () => (window as typeof window & { __scheduledJobsMutations?: number }).__scheduledJobsMutations ?? 0,
      )
      return before === after ? after : -1
    })
    .toBe(0)
  expect(schedulerJobRequests()).toHaveLength(getRequestsBefore)

  await page.getByRole("button", { name: "Refresh" }).click()
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as typeof window & { __scheduledJobsMutations?: number }).__scheduledJobsMutations ?? 0,
      ),
    )
    .toBeGreaterThan(0)
  expect(schedulerJobRequests()).toHaveLength(getRequestsBefore + 1)
  expectNoSmokeErrors(errors, [], [])
})

test("keeps editor input while active session tabs trigger panel refresh", async ({ page }) => {
  const errors = trackPageErrors(page)
  const requests: SchedulerRequest[] = []
  const jobs: SchedulerJob[] = []
  const secondSessionID = `${sessionID}_tab_b`
  const livePrompt = "Keep this scheduled prompt while active tabs update."

  await mockOpenCodeServer(page, {
    directory,
    project: [project(projectID, directory, "Scheduled Jobs")],
    provider: provider(),
    sessions: [session(), session(secondSessionID, "Scheduled Jobs QA Tab B")],
    pageMessages: () => ({ items: [] }),
  })
  await mockScheduledJobsPlugin(page)
  await mockSchedulerApi(page, jobs, requests)
  await configurePage(page, [sessionID, secondSessionID])

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectAppVisible(page.locator(".oc-scheduled-jobs"))
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("opencode.global.dat:tabs") ?? "[]").length))
    .toBe(2)
  await page.getByRole("button", { name: "New" }).click()
  await expectAppVisible(page.getByRole("heading", { name: "New scheduled job" }))

  await page.locator('[data-focus-key="prompt"]').evaluate((node, value) => {
    ;(node as HTMLTextAreaElement).value = value
  }, livePrompt)
  await expect(page.locator('[data-focus-key="prompt"]')).toHaveValue(livePrompt)

  await page.locator(`[data-dock-area="middle"] [data-dock-tab][data-session-id="${secondSessionID}"]`).click()
  await expect(page.locator('[data-focus-key="prompt"]')).toHaveValue(livePrompt)
  await page.screenshot({ path: "e2e/test-results/scheduled-jobs-input-retained-tabs-desktop.png", fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('[data-action="mobile-dock-launcher"]').click()
  const mobileDock = page.locator('[data-dock-wrapper="mobile"]')
  await expectAppVisible(mobileDock)
  await mobileDock.getByRole("tab", { name: "Scheduled Jobs", exact: true }).click()
  await expect(page.locator('[data-focus-key="prompt"]')).toHaveValue(livePrompt)
  await page.screenshot({ path: "e2e/test-results/scheduled-jobs-input-retained-tabs-mobile.png", fullPage: true })
  expectNoSmokeErrors(errors, [], [])
})

test("keeps job tree scroll across refresh renders", async ({ page }) => {
  const errors = trackPageErrors(page)
  const requests: SchedulerRequest[] = []
  const jobs: SchedulerJob[] = Array.from({ length: 40 }, (_, index) => scheduledJob(index + 1))

  await mockOpenCodeServer(page, {
    directory,
    project: [project(projectID, directory, "Scheduled Jobs")],
    provider: provider(),
    sessions: [session()],
    pageMessages: () => ({ items: [] }),
  })
  await mockScheduledJobsPlugin(page)
  await mockSchedulerApi(page, jobs, requests)
  await configurePage(page)

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectAppVisible(page.locator(".oc-scheduled-jobs"))
  await expectAppVisible(page.locator(".oc-scheduled-jobs__row").filter({ hasText: "Scroll QA Job 40" }))
  await page
    .locator(".oc-scheduled-jobs__row")
    .filter({ hasText: "Scroll QA Job 40" })
    .getByRole("button")
    .first()
    .click()

  const tree = page.locator(".oc-scheduled-jobs__tree")
  await tree.evaluate((node) => {
    node.scrollTop = 260
  })
  const before = await tree.evaluate((node) => node.scrollTop)
  expect(before).toBeGreaterThan(0)

  await expectAppVisible(page.locator(".oc-scheduled-jobs__summary").filter({ hasText: "Scroll QA Job 40" }))

  await page.getByRole("button", { name: "Refresh" }).click()
  await expect.poll(() => tree.evaluate((node) => node.scrollTop)).toBe(before)
  await expectAppVisible(page.locator(".oc-scheduled-jobs__summary").filter({ hasText: "Scroll QA Job 40" }))
  expectNoSmokeErrors(errors, [], [])
})

async function configurePage(
  page: Page,
  openSessionIDs = [sessionID],
  activeServer = server,
  additionalTabs: ConfiguredSessionTab[] = [],
) {
  await mockScheduledJobsPlugin(page)
  await page.addInitScript(
    ({ directory, dirBase64, openSessionIDs, activeServer, additionalTabs, localServer }) => {
      const configuredServers = [activeServer, ...additionalTabs.map((tab) => tab.server)].filter(
        (item, index, list) => list.indexOf(item) === index,
      )
      const serverKey = (value: string) => (value === localServer ? "local" : value)
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          list: configuredServers
            .filter((item) => item !== localServer)
            .map((item) => ({
              type: "http",
              http: { url: item },
              displayName: additionalTabs.find((tab) => tab.server === item)?.displayName ?? "Scheduled Jobs",
            })),
          projects: Object.fromEntries(
            configuredServers.map((item) => [
              serverKey(item),
              [
                { worktree: directory, expanded: true, name: "Scheduled Jobs" },
                { worktree: "C:/OpenCode/DocsPortal", expanded: true, name: "Docs Portal" },
              ],
            ]),
          ),
          lastProject: Object.fromEntries(configuredServers.map((item) => [serverKey(item), directory])),
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([
          ...openSessionIDs.map((sessionId) => ({ type: "session", server: activeServer, dirBase64, sessionId })),
          ...additionalTabs.map((tab) => ({
            type: "session",
            server: tab.server,
            dirBase64,
            sessionId: tab.sessionID,
          })),
        ]),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs.recent",
        JSON.stringify({ key: `${activeServer}\n${dirBase64}\n${openSessionIDs[0]}` }),
      )
      localStorage.setItem(
        "opencode.global.dat:layout",
        JSON.stringify({
          dock: {
            schema: 2,
            bottom: {
              visible: true,
              size: 520,
              tabs: ["scheduled-jobs-app/scheduledJobs"],
              active: "scheduled-jobs-app/scheduledJobs",
            },
            items: {
              session: { area: "middle", visible: true },
              "scheduled-jobs-app/scheduledJobs": { area: "bottom", visible: true },
            },
          },
        }),
      )
    },
    {
      directory,
      dirBase64: base64Encode(directory),
      openSessionIDs,
      activeServer,
      additionalTabs,
      localServer: server,
    },
  )
}

async function mockScheduledJobsPlugin(page: Page) {
  const root = path.resolve("../../.opencode/plugin-sources/scheduled-jobs-app")
  const body = await fs.readFile(path.join(root, "index.js"), "utf8")
  const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"))
  await page.route("**/app/plugins**", (route) =>
    json(route, {
      plugins: [
        {
          id: "scheduled-jobs-app",
          spec: "scheduled-jobs-app",
          version: "1",
          module: "/app/plugin/scheduled-jobs-app/1/index.js",
          hash: "scheduled-jobs",
          capabilities: manifest.opencode.app.capabilities,
        },
      ],
    }),
  )
  await page.route("**/app/plugin/scheduled-jobs-app/1/index.js**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/javascript",
      headers: { "access-control-allow-origin": "*" },
      body,
    }),
  )
  await page.route("**/app/plugin/scheduled-jobs-app/1/*.js", async (route) => {
    const file = path.basename(new URL(route.request().url()).pathname)
    return route.fulfill({
      status: 200,
      contentType: "text/javascript",
      headers: { "access-control-allow-origin": "*" },
      body: await fs.readFile(path.join(root, file), "utf8"),
    })
  })
  await page.route("**/app/plugin/scheduled-jobs-app/1/assets/*", async (route) => {
    const file = path.basename(new URL(route.request().url()).pathname)
    return route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      headers: { "access-control-allow-origin": "*" },
      body: await fs.readFile(path.join(root, "assets", file), "utf8"),
    })
  })
}

async function mockSchedulerApi(
  page: Page,
  jobs: SchedulerJob[],
  requests: SchedulerRequest[],
  options: SchedulerMockOptions = {},
) {
  const outcomeCounts = new Map<string, number>()
  const jobGetCounts = new Map<string, number>()
  const stateCounts = new Map<string, number>()
  let listGetCount = 0
  await page.route(/\/plugins\/opencode-scheduler\/services\/jobs(?:\?|$)/, async (route) => {
    const url = new URL(route.request().url())
    if (options.port && url.port !== options.port) return route.fallback()
    const service = route.request().postDataJSON()
    expect(service.caller).toMatchObject({ id: "scheduled-jobs-app", hash: "scheduled-jobs" })
    expect(service.version).toBe(1)
    const request: SchedulerRequest = {
      method: service.input.method,
      path: service.input.path,
      body: service.input.body,
      query: service.input.query ?? {},
    }
    requests.push(request)

    if (request.method === "GET" && request.path === "/scheduler/jobs") {
      listGetCount += 1
      const response = options.listGet?.({ request, count: listGetCount })
      if (response) return json(route, response.body ?? { output: "Scheduled job list failed." }, response.status)
      return json(route, { success: true, data: { jobs } })
    }
    if (request.method === "POST" && request.path === "/scheduler/jobs") {
      const body = request.body ?? {}
      jobs.push({
        ...body,
        name: String(body.name),
        slug: slugify(String(body.name)),
        scopeId: schedulerScopeID,
        schedule: String(body.schedule),
        workdir: String(body.workdir ?? ""),
        runOnce: body.runOnce,
        run: {
          ...runFromBody(body),
          appSessionID: appSessionIDFromBody(body, "ses_scheduled_app_job"),
        },
        lastRunStatus: "scheduled",
      })
      return json(route, { success: true, data: { job: jobs.at(-1) } })
    }

    const run = request.path.match(/^\/scheduler\/jobs\/([^/]+)\/(?:run|run-current-client)$/)
    if (request.method === "POST" && run) {
      const job = jobs.find((item) => item.slug === decodeURIComponent(run[1]))
      const response = await options.run?.({ job, request })
      if (response) return json(route, response.body, response.status)
      if (job) {
        job.lastRunStatus = "succeeded"
        job.lastRunAt = new Date().toISOString()
        job.lastRunExitCode = 0
      }
      return json(route, { success: true, output: `scheduler log for ${decodeURIComponent(run[1])}` })
    }

    const state = request.path.match(/^\/scheduler\/jobs\/([^/]+)\/state$/)
    if (request.method === "POST" && state) {
      const slug = decodeURIComponent(state[1])
      const job = jobs.find((item) => item.slug === slug)
      const count = (stateCounts.get(slug) ?? 0) + 1
      stateCounts.set(slug, count)
      const response = options.state?.({ job, request, count })
      if (response) return json(route, response.body ?? { output: "Scheduled job state failed." }, response.status)
      if (!job) return json(route, { success: false, output: "Scheduled job no longer exists." }, 404)
      const body = request.body ?? {}
      const configuredSessionID = job?.run?.appSessionStrategy === "current" ? job.run.appSessionID : undefined
      const claimedSessionID = job?.lastRunSessionID ?? configuredSessionID
      const terminal = job?.lastRunStatus === "success" || job?.lastRunStatus === "failed"
      const conflictingTarget =
        (!!body.appSessionID && !!claimedSessionID && body.appSessionID !== claimedSessionID) ||
        (!!body.messageID && !!job?.lastRunMessageID && body.messageID !== job.lastRunMessageID)
      const ignored = !body.runId || job.lastRunRunId !== body.runId || terminal || conflictingTarget
      if (ignored) return json(route, { success: true, data: { job, ignored: true } })
      if (job) {
        job.lastRunStatus = request.body?.status
        job.lastRunAt = new Date().toISOString()
        if (request.body?.appSessionID && job.run) job.run.appSessionID = request.body.appSessionID
        if (request.body?.appSessionID) job.lastRunSessionID = request.body.appSessionID
        if (request.body?.messageID) job.lastRunMessageID = request.body.messageID
        if (request.body?.activityID) job.lastRunActivityID = request.body.activityID
        if (request.body?.submittedAt && !job.lastRunSubmittedAt) job.lastRunSubmittedAt = request.body.submittedAt
        if (request.body?.resultContract) job.lastRunResultContract = request.body.resultContract
        if (request.body?.error) job.lastRunError = request.body.error
        if (request.body?.resolution) job.lastRunResolution = request.body.resolution
        if (request.body?.status === "success" && job.runOnce === true) jobs.splice(jobs.indexOf(job), 1)
      }
      return json(route, {
        success: true,
        data: { job, deleted: job?.runOnce === true && request.body?.status === "success" },
      })
    }

    const outcome = request.path.match(/^\/scheduler\/jobs\/([^/]+)\/outcome$/)
    if (request.method === "GET" && outcome) {
      const slug = decodeURIComponent(outcome[1])
      const count = (outcomeCounts.get(slug) ?? 0) + 1
      outcomeCounts.set(slug, count)
      const job = jobs.find((item) => item.slug === slug)
      return json(route, {
        success: true,
        data:
          options.outcome?.({ job, request, count }) ??
          (job?.lastRunStatus === "failed"
            ? { status: "failed", activityID: "activity_mock", error: job.lastRunError }
            : { status: "success", activityID: "activity_mock" }),
      })
    }

    const logs = request.path.match(/^\/scheduler\/jobs\/([^/]+)\/logs$/)
    if (request.method === "GET" && logs) {
      return json(route, { success: true, data: { logs: `scheduler log for ${decodeURIComponent(logs[1])}` } })
    }

    const job = request.path.match(/^\/scheduler\/jobs\/([^/]+)$/)
    if (request.method === "GET" && job) {
      const slug = decodeURIComponent(job[1])
      const count = (jobGetCounts.get(slug) ?? 0) + 1
      jobGetCounts.set(slug, count)
      const item = jobs.find((entry) => entry.slug === slug)
      const response = options.jobGet?.({ job: item, request, count })
      if (response) return json(route, response.body ?? { output: "Scheduled job request failed." }, response.status)
      if (!item) return json(route, { success: false, output: "Scheduled job no longer exists." }, 404)
      return json(route, {
        success: true,
        data: { job: item },
      })
    }
    if (request.method === "PATCH" && job) {
      const body = request.body ?? {}
      const item = jobs.find((entry) => entry.slug === decodeURIComponent(job[1]))
      if (item) {
        Object.assign(item, {
          ...body,
          name: item.name,
          slug: item.slug,
          schedule: String(body.schedule ?? item.schedule),
          workdir: String(body.workdir ?? item.workdir),
          run: {
            ...runFromBody(body),
            appSessionID: appSessionIDFromBody(body, String(item.run?.appSessionID ?? "ses_scheduled_app_job")),
          },
        })
      }
      return json(route, { success: true, data: { job: item } })
    }
    if (request.method === "DELETE" && job) {
      const index = jobs.findIndex((item) => item.slug === decodeURIComponent(job[1]))
      if (index >= 0) jobs.splice(index, 1)
      return json(route, { success: true })
    }

    return json(route, { success: true })
  })
}

async function choose(page: Page, key: string, label: string) {
  await page.locator(`button.oc-scheduled-jobs__select-trigger[data-focus-key="${key}"]`).click()
  const exact = page.getByRole("option", { name: label, exact: true })
  if (await exact.count()) {
    await exact.click({ timeout: 5_000 }).catch(() => exact.evaluate((node) => (node as HTMLElement).click()))
    return
  }
  const fallback = page.getByRole("option", { name: new RegExp(`^${escapeRegex(label)}\\b`) })
  await fallback.click({ timeout: 5_000 }).catch(() => fallback.evaluate((node) => (node as HTMLElement).click()))
}

async function chooseModel(page: Page, label: string) {
  await choose(page, "modelChain", "Direct model")
  await page.locator('.oc-scheduled-jobs__model-picker button[aria-label="Model"]').click()
  await page.locator('[data-slot="list-item"]').filter({ hasText: label }).click()
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

async function deleteJob(page: Page, requests: SchedulerRequest[], label: string, slug: string) {
  await page.locator(".oc-scheduled-jobs__row").filter({ hasText: label }).getByRole("button").first().click()
  await page.locator(".oc-scheduled-jobs__config-actions").getByRole("button", { name: "Delete" }).click()
  await page.locator(".oc-scheduled-jobs__danger").getByRole("button", { name: "Delete" }).click()
  await expect
    .poll(() => requests.some((request) => request.method === "DELETE" && request.path === `/scheduler/jobs/${slug}`))
    .toBe(true)
}

async function runScheduledJobDeepLink(page: Page, slug: string, runId: string, targetDirectory = docsDirectory) {
  await page.evaluate(
    ({ directory, scopeId, slug, runId }) => {
      const params = new URLSearchParams({
        pluginID: "scheduled-jobs-app",
        handlerID: "run",
        directory,
        payload: JSON.stringify({ scopeId, slug, runId }),
      })
      window.dispatchEvent(
        new CustomEvent("opencode:deep-link", { detail: { urls: [`opencode://plugin-handoff?${params}`] } }),
      )
    },
    { directory: targetDirectory, scopeId: schedulerScopeID, slug, runId },
  )
}

function startMockScheduledRun(job: SchedulerJob, runId: string) {
  Object.assign(job, { lastRunStatus: "running", lastRunRunId: runId })
  delete job.lastRunSessionID
  delete job.lastRunMessageID
  delete job.lastRunActivityID
  delete job.lastRunSubmittedAt
  delete job.lastRunResultContract
  delete job.lastRunError
  delete job.lastRunResolution
}

function runFromBody(body: Record<string, unknown>) {
  return {
    prompt: body.prompt,
    agent: body.agent,
    model: body.model,
    variant: body.variant,
    modelPolicyException: body.modelPolicyException,
    runTarget: body.runTarget,
    appSessionStrategy: body.appSessionStrategy,
    appResetHistory: body.appResetHistory,
    accessControl: body.accessControl,
    runFormat: body.runFormat,
    share: body.share,
    continue: body.continue,
    attachUrl: body.attachUrl,
  }
}

function appSessionIDFromBody(body: Record<string, unknown>, fallback: string) {
  if (body.runTarget !== "app") return undefined
  if (body.appSessionStrategy === "current") return body.appSessionID
  if (body.appSessionStrategy === "job") return fallback
  return undefined
}

function legacyLlmJob(): SchedulerJob {
  return {
    name: "Legacy CLI LLM job",
    slug: "legacy-cli-llm-job",
    schedule: "0 8 * * *",
    workdir: docsDirectory,
    prompt: "Legacy prompt",
    run: {
      prompt: "Legacy prompt",
      model: "opencode/gpt-fast",
      accessControl: { mode: "ask" },
    },
    lastRunStatus: "scheduled",
  }
}

function scheduledJob(index: number): SchedulerJob {
  const prompt = Array.from({ length: 24 }, (_, line) => `Run scroll QA job ${index}, detail line ${line + 1}.`).join(
    "\n",
  )
  return {
    name: `Scroll QA Job ${index}`,
    slug: `scroll-qa-job-${index}`,
    schedule: "0 8 * * *",
    workdir: directory,
    prompt,
    run: { prompt, runTarget: "app" },
    lastRunStatus: "scheduled",
  }
}

function scheduledAccessControlJob(accessControl: Record<string, unknown>): SchedulerJob {
  return {
    name: "Access Control App Job",
    slug: "access-control-app-job",
    schedule: "0 8 * * *",
    workdir: docsDirectory,
    prompt: "Run the access control handoff smoke.",
    scopeId: schedulerScopeID,
    run: {
      prompt: "Run the access control handoff smoke.",
      runTarget: "app",
      appSessionStrategy: "job",
      appSessionID: "ses_scheduled_app_job",
      accessControl,
    },
    lastRunStatus: "scheduled",
  }
}

function json(route: Route, body: unknown, status = 200) {
  const service = new URL(route.request().url()).pathname === "/plugins/opencode-scheduler/services/jobs"
  return route.fulfill({
    status: service ? 200 : status,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify(service ? { ok: true, data: { status, body } } : (body ?? null)),
  })
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function project(id: string, worktree: string, name: string) {
  return {
    id,
    worktree,
    vcs: "git",
    name,
    time: { created: 1700000000000, updated: 1700000000000 },
    sandboxes: [],
  }
}

function session(id = sessionID, title = "Scheduled Jobs QA", worktree = directory) {
  return {
    id,
    slug: slugify(title),
    projectID,
    directory: worktree,
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
        models: {
          "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          "gpt-fast": { id: "gpt-fast", name: "GPT Fast", limit: { context: 128_000 } },
        },
      },
      {
        id: "openai",
        name: "OpenAI",
        models: {
          "gpt-5.6-sol": { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", limit: { context: 200_000 } },
        },
      },
    ],
    connected: ["opencode", "openai"],
    default: { providerID: "opencode", modelID: "claude-opus-4-6" },
  }
}

function handoffFromParams(params: URLSearchParams) {
  return {
    pluginID: "scheduled-jobs-app",
    handlerID: "run",
    directory: params.get("directory")!,
    payload: { scopeId: params.get("scopeId")!, slug: params.get("slug")!, runId: params.get("runId")! },
  }
}
function pluginHandoffURL(params: URLSearchParams) {
  const handoff = handoffFromParams(params)
  return `opencode://plugin-handoff?${new URLSearchParams({ pluginID: handoff.pluginID, handlerID: handoff.handlerID, directory: handoff.directory, payload: JSON.stringify(handoff.payload) })}`
}
