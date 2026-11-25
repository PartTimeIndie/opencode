import { mkdirSync, writeFileSync } from "node:fs"
import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { fixture } from "../smoke/session-timeline.fixture"
import { trackPageErrors, expectNoSmokeErrors } from "../utils/errors"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

test.use({ video: "on", screenshot: "on" })

const directory = "C:/OpenCode/AppV2PromptCutover"
const projectID = "proj_app_v2_prompt_cutover"
const sessionID = "ses_app_v2_prompt_cutover"
const screenshotDir = "test-results/app-v2-prompt-cutover"

test("submits app prompts through the v2 route", async ({ page }) => {
  const errors = trackPageErrors(page)
  const warnings: string[] = []
  const prompts: unknown[] = []
  const legacyPrompts: unknown[] = []
  const networkFailures: string[] = []
  const eventRequests: string[] = []

  page.on("console", (message) => {
    if (message.type() === "warning") warnings.push(message.text())
  })

  page.on("request", (request) => {
    const url = new URL(request.url())
    if (url.port === (process.env.PLAYWRIGHT_SERVER_PORT ?? "4096") && url.pathname === "/global/event") {
      eventRequests.push(url.pathname)
    }
  })
  page.on("requestfailed", (request) => {
    const url = new URL(request.url())
    if (url.port === (process.env.PLAYWRIGHT_SERVER_PORT ?? "4096")) {
      networkFailures.push(`${request.method()} ${url.pathname} ${request.failure()?.errorText ?? "failed"}`)
    }
  })
  page.on("response", (response) => {
    const url = new URL(response.url())
    if (url.port === (process.env.PLAYWRIGHT_SERVER_PORT ?? "4096") && response.status() >= 400) {
      networkFailures.push(`${response.status()} ${url.pathname}`)
    }
  })

  await setupPromptCutover(page, {
    onSessionPrompt: (input) => {
      prompts.push(input)
      return { data: { sessionID: input.sessionID, messageID: "msg_prompt_admitted", admittedSeq: prompts.length } }
    },
  })

  await openSession(page)
  const composer = page.locator('[data-component="session-composer"]')
  const input = composer.locator('[data-component="prompt-input"]')
  await expectAppVisible(input)
  await expectDebugOverlayClickThrough(page)

  await input.fill("Normal V2 prompt from the app")
  await composer.locator('[data-action="prompt-submit"]').last().click()
  await expect.poll(() => prompts.length).toBe(1)
  expect(prompts[0]).toMatchObject({
    sessionID,
    body: {
      agent: "build",
      model: { providerID: "opencode", id: "claude-opus-4-6" },
      prompt: { text: "Normal V2 prompt from the app" },
    },
  })

  mkdirSync(screenshotDir, { recursive: true })
  writeFileSync(
    `${screenshotDir}/prompt-network.json`,
    JSON.stringify({ prompts, legacyPrompts, eventRequests, networkFailures }, null, 2),
  )
  await page.screenshot({ path: `${screenshotDir}/prompt-desktop.png`, fullPage: true })

  expect(legacyPrompts).toEqual([])
  expect(eventRequests.length).toBeGreaterThan(0)
  expectNoSmokeErrors(errors, [], [])
  expect(networkFailures).toEqual([])
  expect(
    warnings.filter((warning) => warning.includes("computations created outside a `createRoot` or `render`")),
  ).toEqual([])
})

test("interrupts a busy app session through the v2 route", async ({ page }) => {
  const errors = trackPageErrors(page)
  const interrupts: unknown[] = []
  let stopped = false

  await setupPromptCutover(page, {
    sessionStatus: () => (stopped ? {} : { [sessionID]: { type: "busy" } }),
    onSessionInterrupt: (input) => {
      interrupts.push(input)
      stopped = true
      return { data: true }
    },
  })

  await openSession(page)
  await expectDebugOverlayClickThrough(page)
  const submit = page.locator('[data-component="session-composer"] [data-action="prompt-submit"]').last()
  await expect(submit).toHaveAttribute("aria-label", /Stop|Stopp/)
  await submit.click()
  await expect.poll(() => interrupts.length).toBe(1)
  expect(interrupts[0]).toMatchObject({ sessionID, directory })
  await expect(page.locator('[data-component="session-composer"] [data-action="prompt-submit"]').last()).toHaveAttribute(
    "aria-label",
    /Send|Senden/,
  )

  mkdirSync(screenshotDir, { recursive: true })
  writeFileSync(`${screenshotDir}/interrupt.json`, JSON.stringify({ interrupts }, null, 2))
  await page.screenshot({ path: `${screenshotDir}/interrupt-desktop.png`, fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator('[data-component="session-composer"] [data-action="prompt-submit"]').last()).toHaveAttribute(
    "aria-label",
    /Send|Senden/,
  )
  await page.screenshot({ path: `${screenshotDir}/interrupt-mobile.png`, fullPage: true })

  expectNoSmokeErrors(errors, [], [])
})

test("keeps an explicit stop control while a busy composer has a draft", async ({ page }) => {
  const errors = trackPageErrors(page)
  const interrupts: unknown[] = []

  await setupPromptCutover(page, {
    sessionStatus: { [sessionID]: { type: "busy" } },
    onSessionInterrupt: (input) => {
      interrupts.push(input)
      return { data: true }
    },
  })

  await openSession(page)
  const composer = page.locator('[data-component="session-composer"]')
  const input = composer.locator('[data-component="prompt-input"]')
  await input.fill("Keep this follow-up draft")
  await expectDebugOverlayClickThrough(page)

  const stop = composer.locator('[data-action="prompt-interrupt"]')
  await expect(stop).toBeVisible()
  await expect(stop).toHaveAttribute("aria-label", /Stop|Stopp/)
  await stop.click()
  await expect.poll(() => interrupts.length).toBe(1)
  expect(interrupts[0]).toMatchObject({ sessionID, directory })
  await expect(input).toContainText("Keep this follow-up draft")

  mkdirSync(screenshotDir, { recursive: true })
  await page.screenshot({ path: `${screenshotDir}/interrupt-with-draft-desktop.png`, fullPage: true })
  expectNoSmokeErrors(errors, [], [])
})

test("interrupts a busy app session from the keyboard", async ({ page }) => {
  const interrupts: unknown[] = []

  await setupPromptCutover(page, {
    sessionStatus: { [sessionID]: { type: "busy" } },
    onSessionInterrupt: (input) => {
      interrupts.push(input)
      return { data: true }
    },
  })

  await openSession(page)
  const stop = page.locator('[data-component="session-composer"] [data-action="prompt-submit"]').last()
  await expect(stop).toHaveAttribute("aria-label", /Stop|Stopp/)
  await stop.focus()
  await stop.press("Enter")
  await expect.poll(() => interrupts.length).toBe(1)
  expect(interrupts[0]).toMatchObject({ sessionID, directory })
})

test("stop returns the composer to send without waiting for session status", async ({ page }) => {
  const errors = trackPageErrors(page)
  const interrupts: unknown[] = []
  let statusReads = 0

  await setupPromptCutover(page, {
    sessionStatus: async () => {
      statusReads += 1
      if (interrupts.length > 0) await new Promise(() => {})
      return { [sessionID]: { type: "busy" } }
    },
    onSessionInterrupt: (input) => {
      interrupts.push(input)
      return { data: true }
    },
  })

  await openSession(page)
  await expectDebugOverlayClickThrough(page)
  const submit = page.locator('[data-component="session-composer"] [data-action="prompt-submit"]').last()
  await expect(submit).toHaveAttribute("aria-label", /Stop|Stopp/)
  const started = Date.now()
  await submit.click()
  await expect.poll(() => interrupts.length).toBe(1)
  await expect(submit).toHaveAttribute("aria-label", /Send|Senden/, { timeout: 2_000 })
  expect(Date.now() - started).toBeLessThan(2_000)

  mkdirSync(screenshotDir, { recursive: true })
  writeFileSync(
    `${screenshotDir}/interrupt-without-status.json`,
    JSON.stringify({ interrupts, statusReads }, null, 2),
  )
  await page.screenshot({ path: `${screenshotDir}/interrupt-without-status-desktop.png`, fullPage: true })
  expectNoSmokeErrors(errors, [], [])
})

test("an empty submit on a busy session does not interrupt the run", async ({ page }) => {
  const errors = trackPageErrors(page)
  const interrupts: unknown[] = []
  const prompts: unknown[] = []

  await setupPromptCutover(page, {
    sessionStatus: { [sessionID]: { type: "busy" } },
    onSessionPrompt: (input) => {
      prompts.push(input)
      return { data: { sessionID: input.sessionID, messageID: "msg_prompt_admitted", admittedSeq: prompts.length } }
    },
    onSessionInterrupt: (input) => {
      interrupts.push(input)
      return { data: true }
    },
  })

  await openSession(page)
  const composer = page.locator('[data-component="session-composer"]')
  const input = composer.locator('[data-component="prompt-input"]')

  // The session is busy and the composer stays empty. The submit button shows the
  // Stop affordance; Enter inside the empty editor must stay a no-op for the run.
  await expect(input).toBeVisible()
  await expectDebugOverlayClickThrough(page)
  const submit = composer.locator('[data-action="prompt-submit"]').last()
  await expect(submit).toHaveAttribute("aria-label", /Stop|Stopp/)

  await input.press("Enter")
  await page.waitForTimeout(600)
  expect(interrupts).toEqual([])

  // A programmatic form submit (the stray-empty-Enter path) also stays a no-op.
  await composer.evaluate((element) => {
    if (!(element instanceof HTMLFormElement)) return
    element.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  })
  await page.waitForTimeout(600)
  expect(interrupts).toEqual([])
  expect(prompts).toEqual([])

  mkdirSync(screenshotDir, { recursive: true })
  writeFileSync(`${screenshotDir}/empty-submit.json`, JSON.stringify({ interrupts, prompts }, null, 2))
  await page.screenshot({ path: `${screenshotDir}/empty-submit-busy-desktop.png`, fullPage: true })

  expectNoSmokeErrors(errors, [], [])
})

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test(`resumes an idle session without document navigation at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport)
    const errors = trackPageErrors(page)
    const prompts: unknown[] = []
    const navigations: string[] = []
    const failures: string[] = []
    await setupPromptCutover(page, {
      onSessionPrompt: (input) => {
        prompts.push(input)
        return { data: { sessionID, messageID: "msg_resume_admitted", admittedSeq: 1 } }
      },
    })
    await page.addInitScript(() => {
      localStorage.setItem("opencode.global.dat:prompt-history", JSON.stringify({
        entries: [{ prompt: [{ type: "text", content: "Original task must not be repeated", start: 0, end: 34 }], context: [] }],
      }))
      document.addEventListener("submit", (event) => {
        sessionStorage.setItem("resume-default-prevented", String(event.defaultPrevented))
      })
    })
    await openSession(page)
    const composer = page.locator('[data-component="session-composer"]')
    const submit = composer.locator('[data-action="prompt-submit"]').last()
    await expect(submit).toBeEnabled()
    await expect(submit).toHaveAttribute("aria-label", /Send|Senden/)
    const timeOrigin = await page.evaluate(() => performance.timeOrigin)
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url())
    })
    page.on("response", (response) => {
      if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`)
    })
    await submit.click()
    await expect.poll(() => prompts.length).toBe(1)
    await page.screenshot({ path: testInfo.outputPath("resume.png"), fullPage: true })
    expect(await page.evaluate(() => sessionStorage.getItem("resume-default-prevented"))).toBe("true")
    expect(navigations).toEqual([])
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin)
    expect(prompts[0]).toMatchObject({ sessionID, body: { prompt: { text: "Continue" }, delivery: "steer" } })
    await expectAppVisible(composer)
    expectNoSmokeErrors(errors, [], [])
    expect(failures).toEqual([])
  })
}

test("reconciles a completed v2 activity when the idle event was missed", async ({ page }) => {
  const errors = trackPageErrors(page)
  let completed = false
  let emitted = false
  const messages = [
    {
      info: {
        id: "msg_v2_user",
        sessionID,
        role: "user",
        time: { created: 1_700_000_000_100 },
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-5.6-sol", variant: "max" },
      },
      parts: [
        {
          id: "prt_v2_user",
          sessionID,
          messageID: "msg_v2_user",
          type: "text",
          text: "Reply with the completion sentinel",
        },
      ],
    },
    {
      info: {
        id: "msg_v2_assistant",
        sessionID,
        role: "assistant",
        parentID: "msg_v2_user",
        time: { created: 1_700_000_000_200, completed: 1_700_000_000_300 },
        agent: "build",
        mode: "build",
        modelID: "gpt-5.6-sol",
        providerID: "openai",
        variant: "max",
        path: { cwd: directory, root: directory },
        cost: 0,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
      },
      parts: [
        {
          id: "prt_v2_assistant",
          sessionID,
          messageID: "msg_v2_assistant",
          type: "text",
          text: "GPT56_SOL_MAX_OK",
        },
      ],
    },
  ]

  await setupPromptCutover(page, {
    eventDelay: 500,
    pageMessages: () => ({ items: completed ? messages : messages.slice(0, 1) }),
    sessionStatus: () => (completed ? {} : { [sessionID]: { type: "busy" } }),
    events: () => {
      if (emitted) return []
      emitted = true
      completed = true
      return [
        {
          directory,
          payload: {
            id: "evt_v2_activity_completed",
            type: "session.next.activity.completed",
            properties: { sessionID, activityID: "activity_v2" },
          },
        },
        {
          directory,
          payload: {
            id: "evt_v2_activity_completed_sync",
            type: "sync",
            syncEvent: {
              id: "evt_v2_activity_completed",
              type: "session.next.activity.completed.1",
              seq: 1,
              aggregateID: sessionID,
              data: { sessionID, activityID: "activity_v2" },
            },
          },
        },
      ]
    },
  })

  await openSession(page)
  await expect(page.getByText("GPT56_SOL_MAX_OK", { exact: true })).toBeVisible()
  await expect(page.locator('[data-slot="session-turn-thinking"]')).toHaveCount(0)
  await expect(page.locator('[data-component="session-composer"] [data-action="prompt-submit"]').last()).toHaveAttribute(
    "aria-label",
    /Send|Senden/,
  )
  expectNoSmokeErrors(errors, [], [])
})

test("keeps the stop control when a cross-stream terminal precedes its own start", async ({ page }) => {
  const errors = trackPageErrors(page)
  // Server-side ordering across the two SSE streams can deliver the terminal event of an
  // activity before its own start. The close clears busy, but must not blacklist the ID:
  // the replayed start has to restore the running state, otherwise the composer shows
  // Send while the provider work continues and the run cannot be stopped.
  let phase: "busy" | "reordered" | "delivered" | "settled" = "busy"

  await setupPromptCutover(page, {
    eventDelay: 300,
    sessionStatus: () => (phase === "settled" ? {} : { [sessionID]: { type: "busy" } }),
    events: () => {
      if (phase !== "reordered") return []
      phase = "delivered"
      return [
        {
          directory,
          payload: {
            id: "evt_reorder_terminal",
            type: "session.next.activity.completed",
            properties: { sessionID, activityID: "activity_reorder" },
          },
        },
        {
          directory,
          payload: {
            id: "evt_reorder_start",
            type: "session.next.activity.started",
            properties: { sessionID, activityID: "activity_reorder" },
          },
        },
      ]
    },
  })

  await openSession(page)
  const submit = page.locator('[data-component="session-composer"] [data-action="prompt-submit"]').last()
  await expect(submit).toHaveAttribute("aria-label", /Stop|Stopp/)

  phase = "reordered"
  await expect.poll(() => phase === "delivered").toBe(true)
  await expect(submit).toHaveAttribute("aria-label", /Stop|Stopp/, { timeout: 10_000 })

  phase = "settled"
  await expect
    .poll(
      () =>
        page
          .locator('[data-component="session-composer"] [data-action="prompt-submit"]')
          .last()
          .getAttribute("aria-label"),
      { timeout: 10_000 },
    )
    .toMatch(/Send|Senden/)
  expectNoSmokeErrors(errors, [], [])
})

test("keeps the timeline working after a late idle event during recovery", async ({ page }, testInfo) => {
  const errors = trackPageErrors(page)
  const events: { directory: string; payload: Record<string, unknown> }[] = []
  const timestamp = Date.now()
  const previous = fixture.messages[fixture.targetID].slice(-2).map((message) => ({
    info: { ...message.info, sessionID },
    parts: message.parts.map((part) => ({ ...part, sessionID })),
  }))
  const userID = "msg_zz_recovery_user"
  const activityID = "activity_recovery"
  const emit = (type: string, properties: Record<string, unknown>) =>
    events.push({ directory, payload: { id: `evt_${type}`, type, properties: { sessionID, ...properties } } })
  let busy = false
  await setupPromptCutover(page, {
    pageMessages: () => ({ items: previous }),
    sessionStatus: () => (busy ? { [sessionID]: { type: "busy" } } : {}),
    events: () => events.splice(0),
    eventRetry: 100,
  })
  await openSession(page)
  await expect(page.locator('[data-timeline-row="UserMessage"]').last()).toBeVisible()
  busy = true
  emit("session.next.activity.recovered", { activityID, timestamp })
  emit("session.next.prompt.promoted", {
    messageID: userID,
    timestamp,
    timeCreated: timestamp,
    prompt: { text: "Resume the interrupted work." },
  })
  const thinking = page.locator(`[data-timeline-row="Thinking"][data-message-id="${userID}"]`)
  const headerSpinner = page.locator('div:has(> h1[data-slot="session-title-child"]) [data-component="spinner"]')
  const spinnerFrame = headerSpinner.locator("../..")
  await expect(thinking).toBeVisible()

  emit("session.status", { status: { type: "idle" } })
  emit("session.updated", {
    info: {
      id: sessionID,
      slug: "app-v2-prompt-cutover",
      projectID,
      directory,
      title: "Recovered session",
      version: "dev",
      time: { created: timestamp - 1_000, updated: timestamp },
    },
  })
  await expect(page.getByRole("heading", { name: "Recovered session" })).toBeVisible()
  await expect(thinking).toBeVisible({ timeout: 1_000 })
  await expect(spinnerFrame).toHaveCSS("width", "16px")
  await page.screenshot({ path: testInfo.outputPath("recovered-activity-busy.png") })

  busy = false
  emit("session.next.activity.completed", { activityID, timestamp: Date.now() })
  await expect(thinking).toBeHidden()
  await expect.poll(async () => (await spinnerFrame.boundingBox())?.width ?? 0).toBe(0)
  expectNoSmokeErrors(errors, [], [])
})

async function setupPromptCutover(
  page: Parameters<typeof mockOpenCodeServer>[0],
  overrides: Partial<Parameters<typeof mockOpenCodeServer>[1]> = {},
) {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "app-v2-prompt-cutover",
      time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
      sandboxes: [],
    },
    provider: fixture.provider,
    agents: [{ name: "build", mode: "primary" }],
    commands: [{ name: "diagnose", template: "Diagnose $ARGUMENTS", description: "Diagnose the current session" }],
    sessions: [
      {
        id: sessionID,
        slug: "app-v2-prompt-cutover",
        projectID,
        directory,
        title: "App V2 Prompt Cutover",
        version: "dev",
        time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
    ...overrides,
  })

  await page.addInitScript(
    ({ dir, dirBase64 }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { local: [{ worktree: dir, expanded: true }] }, lastProject: { local: dir } }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", server: "http://127.0.0.1:4096", dirBase64, sessionId: "ses_app_v2_prompt_cutover" }]),
      )
    },
    { dir: directory, dirBase64: base64Encode(directory) },
  )
}

async function openSession(page: Parameters<typeof mockOpenCodeServer>[0]) {
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectAppVisible(page.getByRole("heading", { name: "App V2 Prompt Cutover" }))
}

async function expectDebugOverlayClickThrough(page: Parameters<typeof mockOpenCodeServer>[0]) {
  const diagnostics = page.getByLabel("Development performance diagnostics")
  if ((await diagnostics.count()) === 0) return
  await expect(diagnostics).toHaveCSS("pointer-events", "none")
}
