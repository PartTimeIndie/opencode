import { mkdirSync, writeFileSync } from "node:fs"
import { expect, test, type CDPSession, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"
import { fixture } from "../smoke/session-timeline.fixture"

const directory = "C:/OpenCode/session-tab-startup-prefetch"
const server = "http://127.0.0.1:4096"
const activeID = sessionID(7)
const titleRestoreScreenshotDir = "test-results/session-tab-title-restore"
const loadingIndicatorScreenshotDir = "test-results/session-refresh-indicator"
const refreshDelayScreenshotDir = "../../.agent-tmp/visual-qa/session-refresh-indicator"
const screenshotDir = "e2e/test-results/session-tab-startup-prefetch"
const runningScreenshotDir = "e2e/test-results/session-tab-running-prefetch"
const performanceDir = "e2e/test-results/session-tab-performance"
const interactionPerformanceDir = "e2e/test-results/session-interaction-performance"
const prefetchOffDir = "e2e/test-results/session-tab-prefetch-off"
const interactionDirectory = "C:/OpenCode/session-interaction-performance"
const interactionWorkspaceDirectory = "C:/OpenCode/session-interaction-performance-workspace"
const interactionOtherDirectory = "C:/OpenCode/session-interaction-performance-other"

type MessageRequest = {
  sessionID: string
  before?: string
  phase: "start" | "end"
  at: number
}

type SessionPerfMetrics = {
  longTasks: { duration: number; name: string; startTime: number }[]
  maxHeartbeatDelay: number
}

test("hydrates every restored session tab title without selecting inactive tabs", async ({ page }) => {
  const sessions = restoredSessions().slice(0, 3)
  const activeSessionID = sessions[1]!.id
  const pageErrors: string[] = []
  const failedResponses: string[] = []
  page.on("pageerror", (error) => pageErrors.push(error.message))
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`)
  })

  await mockOpenCodeServer(page, {
    sessions,
    sessionList: [sessions[1]!],
    provider: fixture.provider,
    directory,
    project: { id: "project-session-tab-title-restore", name: "Title Restore", worktree: directory, vcs: "git" },
    pageMessages: () => ({ items: [] }),
  })
  await configureRestoredTabs(page, sessions, activeSessionID, {
    optimizationProfile: "off",
    sessionTabPrefetch: false,
  })

  await page.goto(`/${base64Encode(directory)}/session/${activeSessionID}`)

  for (const session of sessions) {
    await expect(
      page.locator(`[data-dock-tab][data-session-id="${session.id}"]`).getByRole("tab"),
    ).toContainText(session.title)
  }
  await expect(
    page.locator(`[data-dock-tab][data-session-id="${sessions[0]!.id}"]`).getByRole("tab"),
  ).toHaveAttribute("aria-selected", "false")
  await expect(
    page.locator(`[data-dock-tab][data-session-id="${sessions[2]!.id}"]`).getByRole("tab"),
  ).toHaveAttribute("aria-selected", "false")
  expect(pageErrors).toEqual([])
  expect(failedResponses).toEqual([])
  mkdirSync(titleRestoreScreenshotDir, { recursive: true })
  await page.screenshot({ path: `${titleRestoreScreenshotDir}/desktop.png`, fullPage: true })
})

test("does not let inactive restored session tabs block active session startup", async ({ page }) => {
  const requests: MessageRequest[] = []
  const pageErrors: string[] = []
  let releaseMessages = () => {}
  const messagesReady = new Promise<void>((resolve) => {
    releaseMessages = resolve
  })
  page.on("pageerror", (error) => pageErrors.push(error.message))
  const sessions = restoredSessions()

  await mockOpenCodeServer(page, {
    sessions,
    provider: fixture.provider,
    directory,
    project: { id: "project-session-tab-startup-prefetch", name: "Startup Prefetch", worktree: directory, vcs: "git" },
    pageMessages: async (sessionID, limit, before) => {
      await messagesReady
      return pageMessages(sessionID, limit, before)
    },
    onMessages: (input) => requests.push({ ...input, at: Date.now() }),
  })

  await page.addInitScript(
    ({ dir, dirBase64, sessionIDs, serverKey, activeSessionID }) => {
      localStorage.setItem(
        "settings.v3",
        JSON.stringify({ general: { sidebarSessionLimit: 14 } }),
      )
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { [serverKey]: [{ worktree: dir, expanded: true }] }, lastProject: { [serverKey]: dir } }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify(sessionIDs.map((sessionId) => ({ type: "session", server: serverKey, dirBase64, sessionId }))),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs.recent",
        JSON.stringify({ key: `${serverKey}\n${dirBase64}\n${activeSessionID}` }),
      )
    },
    {
      dir: directory,
      dirBase64: base64Encode(directory),
      sessionIDs: sessions.map((session) => session.id),
      serverKey: server,
      activeSessionID: activeID,
    },
  )

  await page.goto(`/${base64Encode(directory)}/session/${activeID}`)

  await expect.poll(() => requests.some((request) => request.sessionID === activeID && request.phase === "start")).toBe(true)
  await expect(page.getByTestId("session-refresh-indicator")).toBeVisible()
  await expect(page.getByTestId("session-refresh-indicator")).toContainText("Loading messages")
  await expectAppVisible(page.getByRole("textbox", { name: /Ask anything/i }))
  mkdirSync(loadingIndicatorScreenshotDir, { recursive: true })
  await page.screenshot({ path: `${loadingIndicatorScreenshotDir}/desktop.png`, fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByTestId("session-refresh-indicator")).toBeVisible()
  await page.screenshot({ path: `${loadingIndicatorScreenshotDir}/mobile.png`, fullPage: true })
  await page.setViewportSize({ width: 1280, height: 720 })

  expect(requests.filter((request) => request.sessionID !== activeID && request.phase === "start")).toEqual([])

  releaseMessages()
  await expect.poll(() => requests.some((request) => request.sessionID === activeID && request.phase === "end")).toBe(true)
  await expect(page.getByTestId("session-refresh-indicator")).toHaveCount(0)
  await expectAppVisible(page.getByRole("textbox", { name: /Ask anything/i }))
  await expect(page.getByRole("heading", { name: "Active restored heavy tab" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Something went wrong" })).toHaveCount(0)

  await expect.poll(() => requests.filter((request) => request.sessionID !== activeID && request.phase === "start").length).toBeGreaterThan(0)

  const activeEnd = requests.find((request) => request.sessionID === activeID && request.phase === "end")?.at ?? 0
  expect(requests.filter((request) => request.sessionID !== activeID && request.phase === "start" && request.at < activeEnd)).toEqual([])
  expect(pageErrors).toEqual([])

  mkdirSync(screenshotDir, { recursive: true })
  writeFileSync(`${screenshotDir}/network.json`, JSON.stringify({ activeID, requests }, null, 2))
  await page.screenshot({ path: `${screenshotDir}/desktop.png`, fullPage: true })
})

test("keeps a same-directory message load visible across a tab round trip", async ({ page }) => {
  const sessions = restoredSessions().slice(0, 2)
  const current = sessions[0]!
  const other = sessions[1]!
  const requests: MessageRequest[] = []
  const pageErrors: string[] = []
  const networkFailures: string[] = []
  page.on("pageerror", (error) => pageErrors.push(error.message))
  page.on("requestfailed", (request) => {
    networkFailures.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`)
  })
  page.on("response", (response) => {
    if (response.status() >= 400) networkFailures.push(`${response.status()} ${response.url()}`)
  })

  await mockOpenCodeServer(page, {
    sessions,
    provider: fixture.provider,
    directory,
    project: { id: "project-session-tab-load-handoff", name: "Tab Load Handoff", worktree: directory, vcs: "git" },
    pageMessages: (sessionID, limit, before) => pageMessages(sessionID, limit, before),
    messageDelay: 3_000,
    onMessages: (input) => requests.push({ ...input, at: Date.now() }),
  })
  await configureRestoredTabs(page, sessions, current.id, {
    optimizationProfile: "off",
    sessionTabPrefetch: false,
  })

  await page.goto(`/${base64Encode(directory)}/session/${current.id}`, { waitUntil: "domcontentloaded" })
  await expect.poll(() => requests.filter((request) => request.sessionID === current.id && request.phase === "start" && !request.before).length).toBe(1)
  await expect(page.getByTestId("session-refresh-indicator")).toBeVisible()

  await page.locator(`[data-dock-area="middle"] [data-dock-tab][data-session-id="${other.id}"]`).click()
  await expect.poll(() => requests.filter((request) => request.sessionID === other.id && request.phase === "start").length).toBe(1)
  await page.locator(`[data-dock-area="middle"] [data-dock-tab][data-session-id="${current.id}"]`).click()

  await expect(page.getByTestId("session-refresh-indicator")).toBeVisible()
  expect(requests.filter((request) => request.sessionID === current.id && request.phase === "start" && !request.before)).toHaveLength(1)
  mkdirSync(loadingIndicatorScreenshotDir, { recursive: true })
  await page.screenshot({ path: `${loadingIndicatorScreenshotDir}/tab-return-desktop.png`, fullPage: true })

  await expect(page.getByRole("heading", { name: current.title })).toBeVisible()
  await expect(page.getByText(`Message 59 for ${current.id}.`, { exact: false })).toBeVisible()
  await expect(page.getByTestId("session-refresh-indicator")).toHaveCount(0)
  await page.screenshot({ path: `${loadingIndicatorScreenshotDir}/tab-return-loaded-desktop.png`, fullPage: true })
  await expect.poll(() => requests.some((request) => request.sessionID === other.id && request.phase === "end")).toBe(true)
  expect(requests.filter((request) => request.sessionID === current.id && request.phase === "start" && !request.before)).toHaveLength(1)
  expect(pageErrors).toEqual([])
  expect(networkFailures).toEqual([])
})

test("delays the message loading overlay for cached sessions", async ({ page }) => {
  const sessions = restoredSessions().slice(0, 2)
  const current = sessions[0]!
  const other = sessions[1]!
  const requests: MessageRequest[] = []
  const pageErrors: string[] = []
  const networkFailures: string[] = []
  let currentLoads = 0
  let releaseSlowRefresh = () => {}
  const slowRefresh = new Promise<void>((resolve) => {
    releaseSlowRefresh = resolve
  })
  page.on("pageerror", (error) => pageErrors.push(error.message))
  page.on("requestfailed", (request) => {
    networkFailures.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`)
  })
  page.on("response", (response) => {
    if (response.status() >= 400) networkFailures.push(`${response.status()} ${response.url()}`)
  })

  await mockOpenCodeServer(page, {
    sessions,
    provider: fixture.provider,
    directory,
    project: { id: "project-session-refresh-delay", name: "Refresh Delay", worktree: directory, vcs: "git" },
    pageMessages: async (sessionID, limit, before) => {
      if (sessionID !== current.id || before) return pageMessages(sessionID, limit, before)
      currentLoads += 1
      if (currentLoads === 2) await new Promise((resolve) => setTimeout(resolve, 100))
      if (currentLoads === 3) await slowRefresh
      return pageMessages(sessionID, limit, before)
    },
    onMessages: (input) => requests.push({ ...input, at: Date.now() }),
  })
  await configureRestoredTabs(page, sessions, current.id, {
    optimizationProfile: "off",
    sessionTabPrefetch: false,
  })
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${current.id}`)
  await expect(page.getByText(`Message 59 for ${current.id}.`, { exact: false })).toBeVisible()

  await page.locator(`[data-dock-area="middle"] [data-dock-tab][data-session-id="${other.id}"]`).click()
  await expect(page.getByText(`Message 59 for ${other.id}.`, { exact: false })).toBeVisible()
  await advanceSessionRefreshClock(page)
  await page.locator(`[data-dock-area="middle"] [data-dock-tab][data-session-id="${current.id}"]`).click()
  await expect.poll(() => currentLoads).toBe(2)
  await expect(page.getByTestId("session-refresh-indicator")).toHaveCount(0)
  await expect.poll(() => requests.filter((request) => request.sessionID === current.id && request.phase === "end" && !request.before).length).toBe(2)
  await expect(page.getByTestId("session-refresh-indicator")).toHaveCount(0)

  mkdirSync(refreshDelayScreenshotDir, { recursive: true })
  await page.screenshot({ path: `${refreshDelayScreenshotDir}/quick-refresh-desktop.png`, fullPage: true })

  await page.locator(`[data-dock-area="middle"] [data-dock-tab][data-session-id="${other.id}"]`).click()
  await expect(page.getByText(`Message 59 for ${other.id}.`, { exact: false })).toBeVisible()
  await advanceSessionRefreshClock(page)
  await page.locator(`[data-dock-area="middle"] [data-dock-tab][data-session-id="${current.id}"]`).click()
  await expect.poll(() => currentLoads).toBe(3)
  await page.waitForTimeout(300)
  await expect(page.getByTestId("session-refresh-indicator")).toHaveCount(0)
  await expect(page.getByTestId("session-refresh-indicator")).toBeVisible()
  await expect(page.getByTestId("session-refresh-indicator")).toContainText("Loading messages")
  await page.screenshot({ path: `${refreshDelayScreenshotDir}/slow-refresh-desktop.png`, fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByTestId("session-refresh-indicator")).toBeVisible()
  await page.screenshot({ path: `${refreshDelayScreenshotDir}/slow-refresh-mobile.png`, fullPage: true })

  releaseSlowRefresh()
  await expect.poll(() => requests.filter((request) => request.sessionID === current.id && request.phase === "end" && !request.before).length).toBe(3)
  await expect(page.getByTestId("session-refresh-indicator")).toHaveCount(0)
  expect(pageErrors).toEqual([])
  expect(networkFailures).toEqual([])
})

test("keeps restored session prefetch paused while a visible session is running", async ({ page }) => {
  const requests: MessageRequest[] = []
  const pageErrors: string[] = []
  page.on("pageerror", (error) => pageErrors.push(error.message))
  const sessions = restoredSessions()

  await mockOpenCodeServer(page, {
    sessions,
    provider: fixture.provider,
    directory,
    project: { id: "project-session-tab-startup-prefetch", name: "Startup Prefetch", worktree: directory, vcs: "git" },
    pageMessages: (sessionID, limit, before) => pageMessages(sessionID, limit, before),
    messageDelay: 600,
    sessionStatus: { [activeID]: { type: "busy" } },
    onMessages: (input) => requests.push({ ...input, at: Date.now() }),
  })

  await page.addInitScript(
    ({ dir, dirBase64, sessionIDs, serverKey, activeSessionID }) => {
      localStorage.setItem(
        "settings.v3",
        JSON.stringify({ general: { sidebarSessionLimit: 14 } }),
      )
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { [serverKey]: [{ worktree: dir, expanded: true }] }, lastProject: { [serverKey]: dir } }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify(sessionIDs.map((sessionId) => ({ type: "session", server: serverKey, dirBase64, sessionId }))),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs.recent",
        JSON.stringify({ key: `${serverKey}\n${dirBase64}\n${activeSessionID}` }),
      )
    },
    {
      dir: directory,
      dirBase64: base64Encode(directory),
      sessionIDs: sessions.map((session) => session.id),
      serverKey: server,
      activeSessionID: activeID,
    },
  )

  await page.goto(`/${base64Encode(directory)}/session/${activeID}`)

  await expect.poll(() => requests.some((request) => request.sessionID === activeID && request.phase === "start")).toBe(true)
  await expect.poll(() => requests.some((request) => request.sessionID === activeID && request.phase === "end")).toBe(true)
  await page.waitForTimeout(1_000)

  expect(requests.filter((request) => request.sessionID !== activeID && request.phase === "start")).toEqual([])
  await expectAppVisible(page.getByRole("textbox", { name: /Ask anything/i }))
  await expect(page.getByRole("heading", { name: "Something went wrong" })).toHaveCount(0)
  expect(pageErrors).toEqual([])

  mkdirSync(runningScreenshotDir, { recursive: true })
  writeFileSync(`${runningScreenshotDir}/network.json`, JSON.stringify({ activeID, requests }, null, 2))
  await page.screenshot({ path: `${runningScreenshotDir}/desktop.png`, fullPage: true })
})

test("session tab prefetch switch disables restored background message prefetch", async ({ page }) => {
  const requests: MessageRequest[] = []
  const sessions = restoredSessions()

  await mockOpenCodeServer(page, {
    sessions,
    provider: fixture.provider,
    directory,
    project: { id: "project-session-tab-startup-prefetch", name: "Startup Prefetch", worktree: directory, vcs: "git" },
    pageMessages: (sessionID, limit, before) => pageMessages(sessionID, limit, before),
    messageDelay: 100,
    onMessages: (input) => requests.push({ ...input, at: Date.now() }),
  })

  await configureRestoredTabs(page, sessions, activeID, {
    optimizationProfile: "speed",
    sessionTabPrefetch: false,
  })
  await page.goto(`/${base64Encode(directory)}/session/${activeID}`)

  await expect.poll(() => requests.some((request) => request.sessionID === activeID && request.phase === "end")).toBe(true)
  await expectAppVisible(page.getByRole("textbox", { name: /Ask anything/i }))
  await page.waitForTimeout(1_000)

  expect(requests.filter((request) => request.sessionID !== activeID && request.phase === "start")).toEqual([])

  mkdirSync(prefetchOffDir, { recursive: true })
  writeFileSync(`${prefetchOffDir}/network.json`, JSON.stringify({ activeID, requests }, null, 2))
  await page.screenshot({ path: `${prefetchOffDir}/desktop.png`, fullPage: true })
})

test("keeps five running session tab switches responsive", async ({ page }) => {
  const requests: MessageRequest[] = []
  const pageErrors: string[] = []
  const networkFailures: string[] = []
  const expectedRequestAborts: string[] = []
  const latencies: { sessionID: string; heading: number; composer: number }[] = []
  const sessions = restoredSessions().slice(0, 5).map((session, index) => ({
    ...session,
    title: `Running session ${index + 1}`,
  }))
  const activeID = sessions[0]!.id
  const status = Object.fromEntries(sessions.map((session) => [session.id, { type: "busy" }]))

  page.on("pageerror", (error) => pageErrors.push(error.message))
  page.on("requestfailed", (request) => {
    const failure = `${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`
    if (isExpectedMessageAbort(request.method(), request.url(), request.failure()?.errorText)) {
      expectedRequestAborts.push(failure)
      return
    }
    networkFailures.push(failure)
  })
  page.on("response", (response) => {
    if (response.status() >= 400) networkFailures.push(`${response.status()} ${response.url()}`)
  })

  await installPerformanceProbe(page)

  await mockOpenCodeServer(page, {
    sessions,
    provider: fixture.provider,
    directory,
    project: { id: "project-session-tab-startup-prefetch", name: "Startup Prefetch", worktree: directory, vcs: "git" },
    pageMessages: (sessionID, limit, before) => pageMessages(sessionID, limit, before),
    messageDelay: 50,
    sessionStatus: status,
    onMessages: (input) => requests.push({ ...input, at: Date.now() }),
  })

  await configureRestoredTabs(page, sessions, activeID, {
    optimizationProfile: "speed",
    sessionTabPrefetch: true,
  })
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${activeID}`)
  await expect(page.getByRole("heading", { name: "Running session 1" })).toBeVisible()
  await expect.poll(() => requests.some((request) => request.sessionID === activeID && request.phase === "end")).toBe(true)
  await page.waitForTimeout(900)
  expect(requests.filter((request) => request.sessionID !== activeID && request.phase === "start")).toEqual([])

  const client = await startPerformanceCapture(page)

  const clicked = new Set<string>([activeID])
  for (const session of sessions.slice(1)) {
    latencies.push({ sessionID: session.id, ...(await measureSessionTabSwitch(page, session.id, session.title)) })
    clicked.add(session.id)
    expect(requests.filter((request) => request.phase === "start" && !clicked.has(request.sessionID))).toEqual([])
  }

  const { profile, performanceMetrics, metrics } = await stopPerformanceCapture(page, client)

  mkdirSync(performanceDir, { recursive: true })
  writeFileSync(`${performanceDir}/cpu-profile.json`, JSON.stringify(profile, null, 2))
  writeFileSync(
    `${performanceDir}/metrics.json`,
    JSON.stringify({ latencies, metrics, requests, expectedRequestAborts, performanceMetrics }, null, 2),
  )
  await page.screenshot({ path: `${performanceDir}/desktop.png`, fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole("heading", { name: sessions.at(-1)!.title })).toBeVisible()
  await page.screenshot({ path: `${performanceDir}/mobile.png`, fullPage: true })

  expect(Math.max(...latencies.map((item) => item.heading))).toBeLessThan(200)
  expect(Math.max(...latencies.map((item) => item.composer))).toBeLessThan(200)
  expect(metrics.longTasks.filter((entry) => entry.duration > 200)).toEqual([])
  expect(metrics.maxHeartbeatDelay).toBeLessThan(200)
  expect(pageErrors).toEqual([])
  expect(networkFailures).toEqual([])
})

test("profiles session open project switching and review open responsiveness", async ({ page }) => {
  const requests: MessageRequest[] = []
  const pageErrors: string[] = []
  const networkFailures: string[] = []
  const expectedRequestAborts: string[] = []
  const latencies: { interaction: string; duration: number }[] = []
  const sessions = interactionSessions()

  page.on("pageerror", (error) => pageErrors.push(error.message))
  page.on("requestfailed", (request) => {
    const failure = `${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`
    if (isExpectedMessageAbort(request.method(), request.url(), request.failure()?.errorText)) {
      expectedRequestAborts.push(failure)
      return
    }
    networkFailures.push(failure)
  })
  page.on("response", (response) => {
    if (response.status() >= 400) networkFailures.push(`${response.status()} ${response.url()}`)
  })

  await installPerformanceProbe(page)
  await mockOpenCodeServer(page, {
    sessions,
    provider: fixture.provider,
    directory: interactionDirectory,
    project: interactionProjects(),
    pageMessages: (sessionID, limit, before) => pageMessages(sessionID, limit, before),
    messageDelay: 50,
    onMessages: (input) => requests.push({ ...input, at: Date.now() }),
  })

  await configureInteractionTabs(page, sessions)
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(interactionDirectory)}/session/${interactionID("warm")}`)
  await expect(page.getByRole("heading", { name: "Performance warmup session" })).toBeVisible()
  await expectAppVisible(page.getByRole("textbox", { name: /Ask anything/i }))
  await page.waitForTimeout(300)
  const client = await startPerformanceCapture(page)

  await measureInteraction(page, latencies, "session-open", async () => {
    await page.locator(`[data-dock-area="middle"] [data-dock-tab][data-session-id="${interactionID("open")}"]`).first().click()
    await expect(page.getByRole("heading", { name: "Performance session open" })).toBeVisible()
    await expectAppVisible(page.getByRole("textbox", { name: /Ask anything/i }))
  })

  await measureInteraction(page, latencies, "session-switch", async () => {
    await page.locator(`[data-dock-area="middle"] [data-dock-tab][data-session-id="${interactionID("switch")}"]`).click()
    await expect(page.getByRole("heading", { name: "Performance same project switch" })).toBeVisible()
    await expectAppVisible(page.getByRole("textbox", { name: /Ask anything/i }))
  })

  await measureInteraction(page, latencies, "workspace-switch", async () => {
    await page.locator(`[data-dock-area="middle"] [data-dock-tab][data-session-id="${interactionID("workspace")}"]`).click()
    await expect(page.getByRole("heading", { name: "Performance workspace switch" })).toBeVisible()
    await expectAppVisible(page.getByRole("textbox", { name: /Ask anything/i }))
  })

  await measureInteraction(page, latencies, "project-switch", async () => {
    await page.locator(`[data-dock-area="middle"] [data-dock-tab][data-session-id="${interactionID("project")}"]`).click()
    await expect(page.getByRole("heading", { name: "Performance other project switch" })).toBeVisible()
    await expectAppVisible(page.getByRole("textbox", { name: /Ask anything/i }))
  })

  await measureInteraction(page, latencies, "review-open", async () => {
    await page.getByRole("button", { name: "Toggle right dock" }).click()
    await expectAppVisible(page.locator('[data-dock-area="right"] [data-dock-tab="review"]'))
    await expectAppVisible(page.locator('[data-dock-area="right"] [data-component="session-review"]'))
  })

  const { profile, performanceMetrics, metrics } = await stopPerformanceCapture(page, client)

  mkdirSync(interactionPerformanceDir, { recursive: true })
  writeFileSync(`${interactionPerformanceDir}/cpu-profile.json`, JSON.stringify(profile, null, 2))
  writeFileSync(
    `${interactionPerformanceDir}/metrics.json`,
    JSON.stringify({ latencies, metrics, requests, expectedRequestAborts, performanceMetrics }, null, 2),
  )
  await page.screenshot({ path: `${interactionPerformanceDir}/desktop.png`, fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole("heading", { name: "Performance other project switch" })).toBeVisible()
  await page.screenshot({ path: `${interactionPerformanceDir}/mobile.png`, fullPage: true })

  expect(Math.max(...latencies.map((item) => item.duration))).toBeLessThan(300)
  expect(metrics.longTasks.filter((entry) => entry.duration > 200)).toEqual([])
  expect(metrics.maxHeartbeatDelay).toBeLessThan(250)
  expect(pageErrors).toEqual([])
  expect(networkFailures).toEqual([])
})

function sessionID(index: number) {
  return `ses_startup_prefetch_${index.toString().padStart(2, "0")}`
}

function isExpectedMessageAbort(method: string, input: string, error?: string) {
  if (method !== "GET" || error !== "net::ERR_ABORTED" || !URL.canParse(input)) return false
  const url = new URL(input)
  return (
    url.origin === server &&
    /^\/api\/session\/[^/]+\/message$/.test(url.pathname) &&
    url.searchParams.has("directory") &&
    url.searchParams.has("location[directory]")
  )
}

async function advanceSessionRefreshClock(page: Page) {
  await page.evaluate(() => {
    const now = Date.now()
    Date.now = () => now + 16_000
  })
}

async function installPerformanceProbe(page: Page) {
  await page.addInitScript(() => {
    const metrics: SessionPerfMetrics = { longTasks: [], maxHeartbeatDelay: 0 }
    let last = performance.now()
    const win = window as typeof window & {
      __sessionPerf?: SessionPerfMetrics
      __sessionPerfReset?: () => void
    }
    win.__sessionPerf = metrics
    win.__sessionPerfReset = () => {
      metrics.longTasks.length = 0
      metrics.maxHeartbeatDelay = 0
      last = performance.now()
    }
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          metrics.longTasks.push({ duration: entry.duration, name: entry.name, startTime: entry.startTime })
        }
      }).observe({ entryTypes: ["longtask"] })
    } catch {}
    window.setInterval(() => {
      const now = performance.now()
      metrics.maxHeartbeatDelay = Math.max(metrics.maxHeartbeatDelay, Math.max(0, now - last - 50))
      last = now
    }, 50)
  })
}

async function startPerformanceCapture(page: Page) {
  const client = await page.context().newCDPSession(page)
  await client.send("Performance.enable")
  await client.send("Profiler.enable")
  await client.send("Profiler.start")
  await page.evaluate(() => {
    const win = window as typeof window & { __sessionPerfReset?: () => void }
    win.__sessionPerfReset?.()
  })
  return client
}

async function measureSessionTabSwitch(page: Page, sessionID: string, title: string) {
  return page.evaluate(
    ({ sessionID, title }) =>
      new Promise<{ heading: number; composer: number }>((resolve, reject) => {
        const trigger = document.querySelector(
          `[data-dock-area="middle"] [data-dock-tab][data-session-id="${CSS.escape(sessionID)}"] [role="tab"]`,
        )
        if (!(trigger instanceof HTMLElement)) {
          reject(new Error(`Session tab trigger not found: ${sessionID}`))
          return
        }

        const started = performance.now()
        let heading: number | undefined
        let composer: number | undefined
        const visible = (element: Element) => {
          if (!(element instanceof HTMLElement)) return false
          const rect = element.getBoundingClientRect()
          const style = getComputedStyle(element)
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
        }
        const done = () => {
          if (heading === undefined || composer === undefined) return
          observer.disconnect()
          clearTimeout(timeout)
          requestAnimationFrame(() => resolve({ heading: heading!, composer: composer! }))
        }
        const check = () => {
          if (heading === undefined) {
            const current = [...document.querySelectorAll("h1")].find(
              (element) => element.textContent?.trim() === title && visible(element),
            )
            if (current) heading = performance.now() - started
          }
          if (composer === undefined) {
            const current = document.querySelector('[data-component="prompt-input"]')
            if (current && visible(current)) composer = performance.now() - started
          }
          done()
        }
        const observer = new MutationObserver(check)
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["class", "style", "hidden"],
        })
        const timeout = window.setTimeout(() => {
          observer.disconnect()
          reject(new Error(`Session tab did not become visible: ${sessionID}`))
        }, 5_000)
        trigger.click()
        check()
      }),
    { sessionID, title },
  )
}

async function stopPerformanceCapture(page: Page, client: CDPSession) {
  const metrics = await page.evaluate(() => {
    const win = window as typeof window & { __sessionPerf?: SessionPerfMetrics }
    return win.__sessionPerf ?? { longTasks: [], maxHeartbeatDelay: 0 }
  })
  const profile = await client.send("Profiler.stop")
  const performanceMetrics = await client.send("Performance.getMetrics")
  return { profile, performanceMetrics, metrics }
}

async function measureInteraction(
  page: Page,
  latencies: { interaction: string; duration: number }[],
  interaction: string,
  run: () => Promise<void>,
) {
  const start = await page.evaluate(() => performance.now())
  await run()
  latencies.push({ interaction, duration: await page.evaluate((started) => performance.now() - started, start) })
}

async function configureRestoredTabs(
  page: Parameters<typeof mockOpenCodeServer>[0],
  sessions: { id: string }[],
  activeSessionID: string,
  optimizations?: { optimizationProfile: "off" | "safe" | "speed"; sessionTabPrefetch: boolean },
) {
  await page.addInitScript(
    ({ dir, dirBase64, sessionIDs, serverKey, activeSessionID, optimizations }) => {
      localStorage.setItem(
        "settings.v3",
        JSON.stringify({
          general: { sidebarSessionLimit: 14 },
          optimizations: optimizations
            ? {
                optimizationProfile: optimizations.optimizationProfile,
                sessionTabPrefetch: optimizations.sessionTabPrefetch,
              }
            : undefined,
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { [serverKey]: [{ worktree: dir, expanded: true }] }, lastProject: { [serverKey]: dir } }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify(sessionIDs.map((sessionId) => ({ type: "session", server: serverKey, dirBase64, sessionId }))),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs.recent",
        JSON.stringify({ key: `${serverKey}\n${dirBase64}\n${activeSessionID}` }),
      )
    },
    {
      dir: directory,
      dirBase64: base64Encode(directory),
      sessionIDs: sessions.map((session) => session.id),
      serverKey: server,
      activeSessionID,
      optimizations,
    },
  )
}

async function configureInteractionTabs(page: Page, sessions: { id: string; directory: string }[]) {
  await page.addInitScript(
    ({ main, other, serverKey, tabs }) => {
      localStorage.setItem(
        "settings.v3",
        JSON.stringify({
          general: { sidebarSessionLimit: 14 },
          optimizations: { optimizationProfile: "speed", sessionTabPrefetch: false },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: {
            [serverKey]: [
              { worktree: main, expanded: true, name: "Interaction Performance" },
              { worktree: other, expanded: true, name: "Other Interaction Performance" },
            ],
          },
          lastProject: { [serverKey]: main },
        }),
      )
      localStorage.setItem("opencode.global.dat:tabs", JSON.stringify(tabs))
      localStorage.setItem(
        "opencode.global.dat:layout",
        JSON.stringify({
          sidebar: { opened: false, width: 260, workspaces: { [main]: true }, workspacesDefault: false },
          terminal: { height: 280, opened: false },
          review: { diffStyle: "split", panelOpened: false },
          fileTree: { opened: false, width: 200, tab: "changes" },
          session: { width: 600 },
          dock: {
            schema: 2,
            top: { visible: false, size: 160, tabs: [] },
            left: { visible: false, size: 280, tabs: [] },
            middle: { visible: true, size: 600, tabs: ["session"], active: "session" },
            right: { visible: false, size: 280, tabs: ["review", "fileTree", "gitChanges"], active: "review" },
            bottom: { visible: false, size: 280, tabs: ["terminal"], active: "terminal" },
            items: {
              session: { area: "middle", visible: true },
              terminal: { area: "bottom", visible: false },
              review: { area: "right", visible: false },
              fileTree: { area: "right", visible: false },
              gitChanges: { area: "right", visible: false },
            },
          },
        }),
      )
    },
    {
      main: interactionDirectory,
      other: interactionOtherDirectory,
      serverKey: server,
      tabs: sessions.map((session) => ({
        type: "session" as const,
        server,
        dirBase64: base64Encode(session.directory),
        sessionId: session.id,
      })),
    },
  )
}

function interactionID(name: "warm" | "open" | "switch" | "workspace" | "project") {
  return `ses_interaction_performance_${name}`
}

function interactionProjects() {
  return [
    {
      id: "project-session-interaction-performance",
      worktree: interactionDirectory,
      vcs: "git",
      name: "Interaction Performance",
      sandboxes: [interactionWorkspaceDirectory],
      time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
    },
    {
      id: "project-session-interaction-performance-other",
      worktree: interactionOtherDirectory,
      vcs: "git",
      name: "Other Interaction Performance",
      sandboxes: [],
      time: { created: 1_700_000_000_001, updated: 1_700_000_000_001 },
    },
  ]
}

function interactionSessions() {
  return [
    {
      id: interactionID("warm"),
      slug: "session-warmup",
      projectID: "project-session-interaction-performance",
      directory: interactionDirectory,
      title: "Performance warmup session",
      version: "dev",
      time: { created: 1_700_000_000_009, updated: 1_700_000_000_009 },
    },
    {
      id: interactionID("open"),
      slug: "session-open",
      projectID: "project-session-interaction-performance",
      directory: interactionDirectory,
      title: "Performance session open",
      version: "dev",
      time: { created: 1_700_000_000_010, updated: 1_700_000_000_010 },
    },
    {
      id: interactionID("switch"),
      slug: "session-switch",
      projectID: "project-session-interaction-performance",
      directory: interactionDirectory,
      title: "Performance same project switch",
      version: "dev",
      time: { created: 1_700_000_000_011, updated: 1_700_000_000_011 },
    },
    {
      id: interactionID("workspace"),
      slug: "workspace-switch",
      projectID: "project-session-interaction-performance",
      directory: interactionWorkspaceDirectory,
      title: "Performance workspace switch",
      version: "dev",
      time: { created: 1_700_000_000_012, updated: 1_700_000_000_012 },
    },
    {
      id: interactionID("project"),
      slug: "project-switch",
      projectID: "project-session-interaction-performance-other",
      directory: interactionOtherDirectory,
      title: "Performance other project switch",
      version: "dev",
      time: { created: 1_700_000_000_013, updated: 1_700_000_000_013 },
    },
  ]
}

function restoredSessions() {
  return Array.from({ length: 14 }, (_, index) => ({
    id: sessionID(index),
    slug: `startup-prefetch-${index}`,
    projectID: "project-session-tab-startup-prefetch",
    directory,
    title: index === 7 ? "Active restored heavy tab" : `Restored background tab ${index}`,
    version: "dev",
    time: { created: 1_700_000_000_000 + index, updated: 1_700_000_000_000 + index },
  }))
}

function pageMessages(sessionID: string, limit: number, before?: string) {
  const messages = Array.from({ length: 60 }, (_, index) => message(sessionID, index))
  const end = before
    ? Math.max(
        0,
        messages.findIndex((item) => item.info.id === before),
      )
    : messages.length
  const start = Math.max(0, end - limit)
  return {
    items: messages.slice(start, end),
    cursor: start > 0 ? messages[start]?.info.id : undefined,
  }
}

function message(sessionID: string, index: number) {
  const id = `msg_${sessionID}_${index.toString().padStart(3, "0")}`
  const assistant = index % 2 === 1
  return {
    info: {
      id,
      sessionID,
      role: assistant ? "assistant" : "user",
      time: { created: 1_700_000_000_000 + index },
      agent: "build",
      ...(assistant
        ? {
            providerID: "opencode",
            modelID: "claude-opus-4-6",
            mode: "build",
            cost: 0.01,
            tokens: { input: 100, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
            finish: "stop",
          }
        : {
            summary: { diffs: [] },
            model: { providerID: "opencode", modelID: "claude-opus-4-6" },
          }),
    },
    parts: [
      {
        id: `prt_${id}`,
        sessionID,
        messageID: id,
        type: "text",
        text: `Message ${index} for ${sessionID}. ${"Heavy restored tab content. ".repeat(20)}`,
      },
    ],
  }
}
