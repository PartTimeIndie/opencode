import { expect, test, type Page, type Request } from "@playwright/test"
import { writeFile } from "node:fs/promises"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { fixture } from "../smoke/session-timeline.fixture"
import { SESSION_MESSAGE_REQUEST_TIMEOUT_MS } from "../../src/context/session-message-request"

const server = "http://127.0.0.1:4096"
const root = "C:/OpenCode/workspace-bootstrap-root"
const inactive = "C:/OpenCode/workspace-bootstrap-inactive"
const PASSIVE_STATUS_TIMEOUT_MS = 10_000
const SESSION_STATUS_POLL_INTERVAL_MS = 3_000
// The timer probe runs in Chromium; request events are timestamped by Playwright's Node process.
const STATUS_TIMER_EVENT_SKEW_MS = 100
const passiveRequests = new Set(["/permission", "/api/permission/request", "/api/surface/request", "/session/status"])
const fullBootstrapRequests = new Set([
  "/agent",
  "/api/agent",
  "/api/command",
  "/config",
  "/path",
  "/project/current",
  "/provider",
  "/vcs",
  "/vcs/status",
])

function passiveRequestFailuresAfterBaseline(
  events: readonly { startedSequence?: number }[],
  baselineRequestSequence: number,
) {
  return events.filter(
    (event) => event.startedSequence === undefined || event.startedSequence > baselineRequestSequence,
  )
}

test("ignores historical passive aborts but keeps post-baseline and unsequenced failures", () => {
  const baselineAt = 1_000
  const baselineRequestSequence = 11
  const failures = [
    { path: "/session/status", startedSequence: 10, at: 1_020, error: "net::ERR_ABORTED" },
    { path: "/api/surface/request", startedSequence: 12, at: 1_030, error: "net::ERR_ABORTED" },
    { path: "/permission", startedSequence: undefined, at: 1_040, error: "net::ERR_ABORTED" },
  ]

  expect(failures[0]!.at).toBeGreaterThan(baselineAt)
  expect(passiveRequestFailuresAfterBaseline(failures, baselineRequestSequence)).toEqual(failures.slice(1))
})

async function setupWorkspace(input: {
  page: Page
  viewport: { width: number; height: number }
  startAtHome?: boolean
  delayInactiveSessionListUntilActiveMessage?: boolean
  holdActiveMessageUntilReleased?: boolean
  holdPassiveStatusUntilReleased?: boolean
  holdForegroundMessageUntilReleased?: boolean
}) {
  const activeSession = {
    id: "ses_active_workspace_root",
    projectID: "project-workspace-bootstrap",
    directory: root,
    title: "Active root session",
    version: "dev",
    time: { created: 1_700_000_000_005, updated: 1_700_000_000_005 },
  }
  const inactiveSessions = [
    {
      id: "ses_inactive_question",
      projectID: "project-workspace-bootstrap",
      directory: inactive,
      title: "Inactive question session",
      version: "dev",
      time: { created: 1_700_000_000_003, updated: 1_700_000_000_003 },
    },
    {
      id: "ses_inactive_permission",
      projectID: "project-workspace-bootstrap",
      directory: inactive,
      title: "Inactive permission session",
      version: "dev",
      time: { created: 1_700_000_000_002, updated: 1_700_000_000_002 },
    },
    {
      id: "ses_inactive_running",
      projectID: "project-workspace-bootstrap",
      directory: inactive,
      title: "Inactive running session",
      version: "dev",
      time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
    },
  ]
  const foregroundSession = {
    id: "ses_foreground_workspace_root_pending",
    projectID: "project-workspace-bootstrap",
    directory: root,
    title: "Root follow-up session",
    version: "dev",
    time: { created: 1_700_000_000_001, updated: 1_700_000_000_001 },
  }
  const requestTimeline: string[] = []
  const passiveReads: string[] = []
  const unrelatedReads: string[] = []
  const consoleErrors: string[] = []
  const requestFailures: string[] = []
  const passiveRequestFailures: string[] = []
  const passiveRequestFailureEvents: {
    path: string
    directory: string
    at: number
    startedSequence?: number
    error?: string
  }[] = []
  const inactiveReads: string[] = []
  const inactiveReadEvents: { directory: string; path: string; at: number; sequence: number }[] = []
  const passiveReadCompletions: string[] = []
  const backgroundReadEvents: { directory: string; path: string; at: number }[] = []
  const statusRequestEvents: { directory: string; at: number; sequence: number }[] = []
  const statusResponseEvents: { directory: string; at: number; data: Record<string, { type?: string }> }[] = []
  const messageRequestEvents: {
    requestID: string
    sessionID: string
    startedAt: number
    startedSequence: number
    finishedAt?: number
    finishedSequence?: number
    result?: "finished" | "failed"
  }[] = []
  const messageRequestByRequest = new Map<Request, (typeof messageRequestEvents)[number]>()
  const requestStartSequenceByRequest = new WeakMap<Request, number>()
  const sessionRoute = `/${base64Encode(root)}/session/${activeSession.id}`
  let markActiveMessageFinished = () => {}
  let markActiveMessageStarted = () => {}
  let releaseActiveMessage = () => {}
  let markPassiveStatusStarted = () => {}
  let releasePassiveStatus = () => {}
  let markForegroundMessageStarted = () => {}
  let releaseForegroundMessage = () => {}
  let activeMessageHoldArmed = input.holdActiveMessageUntilReleased ?? false
  let foregroundMessageHoldArmed = false
  let eventSequence = 0
  let latestRequestSequence = 0
  let foregroundMessageStartedAt: number | undefined
  let passiveStatusStartedAt: number | undefined
  const activeMessageFinished = new Promise<void>((resolve) => {
    markActiveMessageFinished = () => resolve()
  })
  const activeMessageStarted = new Promise<void>((resolve) => {
    markActiveMessageStarted = () => resolve()
  })
  const passiveStatusStarted = new Promise<void>((resolve) => {
    markPassiveStatusStarted = () => resolve()
  })
  const activeMessageGate = new Promise<void>((resolve) => {
    releaseActiveMessage = resolve
  })
  const passiveStatusGate = new Promise<void>((resolve) => {
    releasePassiveStatus = resolve
  })
  const foregroundMessageStarted = new Promise<void>((resolve) => {
    markForegroundMessageStarted = () => resolve()
  })
  const foregroundMessageGate = new Promise<void>((resolve) => {
    releaseForegroundMessage = resolve
  })
  let activeMessageHeld = false
  let passiveStatusHeld = false

  input.page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })
  input.page.on("pageerror", (error) => consoleErrors.push(error.message))
  input.page.on("request", (request) => {
    const sequence = ++eventSequence
    latestRequestSequence = sequence
    requestStartSequenceByRequest.set(request, sequence)
    const url = new URL(request.url())
    const messageRequest = url.pathname.match(/^\/api\/session\/([^/]+)\/message$/)
    if (messageRequest) {
      const sessionID = decodeURIComponent(messageRequest[1]!)
      const event = {
        requestID: `${sessionID}:${sequence}`,
        sessionID,
        startedAt: Date.now(),
        startedSequence: sequence,
      }
      messageRequestEvents.push(event)
      messageRequestByRequest.set(request, event)
    }
    const directory =
      url.searchParams.get("directory") ??
      url.searchParams.get("location[directory]") ??
      request.headers()["x-opencode-directory"]
    if (url.pathname === "/session/status") statusRequestEvents.push({ directory: directory ?? "", at: Date.now(), sequence })
    if (url.pathname === `/api/session/${foregroundSession.id}/message`) {
      requestTimeline.push("foreground-message-request-start")
    }
  })
  input.page.on("requestfailed", (request) => {
    const messageRequest = messageRequestByRequest.get(request)
    if (messageRequest) {
      messageRequest.finishedAt = Date.now()
      messageRequest.finishedSequence = ++eventSequence
      messageRequest.result = "failed"
    }
    const url = new URL(request.url())
    const directory =
      url.searchParams.get("directory") ??
      url.searchParams.get("location[directory]") ??
      request.headers()["x-opencode-directory"]
    const errorText = request.failure()?.errorText
    if (directory === inactive && passiveRequests.has(url.pathname)) {
      passiveRequestFailures.push(url.pathname)
      passiveRequestFailureEvents.push({
        path: url.pathname,
        directory,
        at: Date.now(),
        startedSequence: requestStartSequenceByRequest.get(request),
        error: errorText,
      })
      if (errorText === "net::ERR_ABORTED") return
    }
    requestFailures.push(`${request.url()}: ${errorText}`)
  })
  input.page.on("response", (response) => {
    if (response.status() >= 400) requestFailures.push(`${response.status()} ${response.url()}`)
  })
  input.page.on("request", (request) => {
    const url = new URL(request.url())
    const directory =
      url.searchParams.get("directory") ??
      url.searchParams.get("location[directory]") ??
      request.headers()["x-opencode-directory"]
    if (directory !== inactive) return
    inactiveReads.push(url.pathname)
    const at = Date.now()
    inactiveReadEvents.push({ directory, path: url.pathname, at, sequence: latestRequestSequence })
    if (passiveRequests.has(url.pathname)) {
      passiveReads.push(url.pathname)
      backgroundReadEvents.push({ directory, path: url.pathname, at })
    }
    if (fullBootstrapRequests.has(url.pathname)) unrelatedReads.push(url.pathname)
    if (passiveRequests.has(url.pathname)) requestTimeline.push(`passive:${url.pathname}`)
  })
  input.page.on("requestfinished", (request) => {
    const sequence = ++eventSequence
    const url = new URL(request.url())
    const messageRequest = messageRequestByRequest.get(request)
    if (messageRequest) {
      messageRequest.finishedAt = Date.now()
      messageRequest.finishedSequence = sequence
      messageRequest.result = "finished"
    }
    const directory =
      url.searchParams.get("directory") ??
      url.searchParams.get("location[directory]") ??
      request.headers()["x-opencode-directory"]
    if (url.pathname === `/api/session/${activeSession.id}/message`) {
      requestTimeline.push("active-message-finished")
      markActiveMessageFinished()
    }
    if (url.pathname === `/api/session/${foregroundSession.id}/message`) {
      requestTimeline.push("foreground-message-finished")
    }
    if (url.pathname === "/session" && directory === inactive) requestTimeline.push("inactive-session-list-finished")
    if (directory === inactive && passiveRequests.has(url.pathname)) passiveReadCompletions.push(url.pathname)
  })

  await mockOpenCodeServer(input.page, {
    sessions: [
      activeSession,
      foregroundSession,
      ...inactiveSessions,
    ],
    sessionList: [
      activeSession,
      foregroundSession,
      ...inactiveSessions,
    ],
    provider: fixture.provider,
    directory: root,
    project: {
      id: "project-workspace-bootstrap",
      name: "Workspace Bootstrap",
      worktree: root,
      vcs: "git",
      sandboxes: [inactive],
    },
    pageMessages: () => ({ items: [] }),
    sessionStatus: () => ({}),
    questions: () => [
      {
        id: "que_inactive_workspace",
        sessionID: inactiveSessions[0]!.id,
        mode: "blocking",
        revision: 1,
        actions: [],
        questions: [{ question: "Continue?" }],
      },
    ],
    onMessages: async ({ sessionID, phase }) => {
      if (!input.holdForegroundMessageUntilReleased || !foregroundMessageHoldArmed || sessionID !== foregroundSession.id)
        return
      if (phase === "start") {
        if (foregroundMessageStartedAt === undefined) {
          foregroundMessageStartedAt = Date.now()
          requestTimeline.push("foreground-message-start")
          markForegroundMessageStarted()
        }
        await foregroundMessageGate
        return
      }
    },
    permissions: () => [
      {
        id: "per_inactive_workspace",
        sessionID: inactiveSessions[1]!.id,
        action: "external_directory",
        resources: ["C:/OpenCode/external"],
        save: [],
      },
    ],
  })
  if (input.holdActiveMessageUntilReleased) {
    await input.page.route("**/api/session/*/message**", async (route) => {
      const url = new URL(route.request().url())
      if (
        url.pathname !== `/api/session/${activeSession.id}/message` ||
        !activeMessageHoldArmed ||
        activeMessageHeld
      )
        return route.fallback()
      activeMessageHeld = true
      requestTimeline.push("active-message-request-start")
      markActiveMessageStarted()
      await activeMessageGate
      try {
        await route.fallback()
      } catch {}
    })
  }
  await input.page.route("**/session/status**", async (route) => {
    const url = new URL(route.request().url())
    const directory =
      url.searchParams.get("directory") ??
      url.searchParams.get("location[directory]") ??
      route.request().headers()["x-opencode-directory"]
    if (url.pathname !== "/session/status") return route.fallback()
    const response = {
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(
        directory === inactive
          ? { [inactiveSessions[2]!.id]: { type: "busy" } }
          : directory === root && input.holdForegroundMessageUntilReleased
            ? { [foregroundSession.id]: { type: "busy" } }
            : {},
      ),
    }
    if (directory !== inactive || !input.holdPassiveStatusUntilReleased || passiveStatusHeld) {
      await route.fulfill(response)
      statusResponseEvents.push({
        directory: directory ?? "",
        at: Date.now(),
        data: JSON.parse(response.body) as Record<string, { type?: string }>,
      })
      return
    }
    passiveStatusHeld = true
    passiveStatusStartedAt = Date.now()
    requestTimeline.push("passive-status-started")
    markPassiveStatusStarted()
    try {
      await passiveStatusGate
      await route.fulfill(response)
      statusResponseEvents.push({
        directory: directory ?? "",
        at: Date.now(),
        data: JSON.parse(response.body) as Record<string, { type?: string }>,
      })
    } catch {}
  })
  if (input.delayInactiveSessionListUntilActiveMessage) {
    await input.page.route("**/session?*", async (route) => {
      const url = new URL(route.request().url())
      const directory =
        url.searchParams.get("directory") ??
        url.searchParams.get("location[directory]") ??
        route.request().headers()["x-opencode-directory"]
      if (url.pathname !== "/session" || directory !== inactive) return route.fallback()
      await activeMessageFinished
      await new Promise((resolve) => setTimeout(resolve, 300))
      return route.fallback()
    })
  }
  await input.page.addInitScript(({ serverKey, root, inactive }) => {
    const timerProbe = {
      registrations: 0,
      registeredAt: undefined as number | undefined,
      ticks: [] as number[],
      fastRegistrations: 0,
      fastRegisteredAt: undefined as number | undefined,
      fastTicks: [] as number[],
    }
    Object.defineProperty(window, "__opencodeSessionStatusTimerProbe", { value: timerProbe })
    const nativeSetInterval = window.setInterval.bind(window) as (...args: unknown[]) => number
    window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if ((timeout !== 3_000 && timeout !== 15_000) || typeof handler !== "function")
        return nativeSetInterval(handler, timeout, ...args)
      if (timeout === 15_000) {
        timerProbe.registrations++
        timerProbe.registeredAt ??= Date.now()
      }
      if (timeout === 3_000) {
        timerProbe.fastRegistrations++
        timerProbe.fastRegisteredAt ??= Date.now()
      }
      return nativeSetInterval(
        (...callbackArgs: unknown[]) => {
          if (timeout === 15_000) timerProbe.ticks.push(Date.now())
          if (timeout === 3_000) timerProbe.fastTicks.push(Date.now())
          handler.call(window, ...callbackArgs)
        },
        timeout,
        ...args,
      )
    }) as typeof window.setInterval

    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({
        projects: { [serverKey]: [{ worktree: root, expanded: true }] },
        lastProject: { [serverKey]: root },
      }),
    )
    localStorage.setItem(
      "opencode.global.dat:layout",
      JSON.stringify({
        sidebar: { opened: true, width: 260, workspaces: { [root]: true }, workspacesDefault: false },
      }),
    )
    localStorage.setItem(
      "opencode.global.dat:layout.page",
      JSON.stringify({
        workspaceExpanded: { [inactive]: true },
      }),
    )
  }, { serverKey: server, root, inactive })

  await input.page.setViewportSize(input.viewport)
  await input.page.goto(input.startAtHome ? "/" : sessionRoute)

  return {
    activeSession,
    foregroundSession,
    inactiveSessions,
    sessionRoute,
    requestTimeline,
    passiveReads,
    passiveReadCompletions,
    passiveRequestFailures,
    passiveRequestFailureEvents,
    inactiveReads,
    inactiveReadEvents,
    unrelatedReads,
    consoleErrors,
    requestFailures,
    activeMessageStarted,
    passiveStatusStarted,
    foregroundMessageStarted,
    releaseActiveMessage,
    releasePassiveStatus,
    releaseForegroundMessage,
    armForegroundMessageHold: () => {
      foregroundMessageHoldArmed = true
    },
    backgroundReadEvents,
    statusRequestEvents,
    statusResponseEvents,
    messageRequestEvents: () => messageRequestEvents,
    latestRequestSequence: () => latestRequestSequence,
    foregroundMessageStartedAt: () => foregroundMessageStartedAt,
    passiveStatusStartedAt: () => passiveStatusStartedAt,
    statusTimerProbe: () =>
      input.page.evaluate(() => {
        const probe = (window as Window & {
          __opencodeSessionStatusTimerProbe?: {
            registrations: number
            registeredAt?: number
            ticks: number[]
            fastRegistrations: number
            fastRegisteredAt?: number
            fastTicks: number[]
          }
        })
          .__opencodeSessionStatusTimerProbe
        return {
          registrations: probe?.registrations ?? 0,
          registeredAt: probe?.registeredAt,
          ticks: probe?.ticks ?? [],
          fastRegistrations: probe?.fastRegistrations ?? 0,
          fastRegisteredAt: probe?.fastRegisteredAt,
          fastTicks: probe?.fastTicks ?? [],
        }
      }),
  }
}

async function ensureMobileSidebarInViewport(page: Page) {
  const mobileSidebar = page.locator('[data-component="sidebar-nav-mobile"]')
  const isOpen = await mobileSidebar.evaluate((element) => element.classList.contains("translate-x-0"))
  if (!isOpen) await page.locator('[data-action="mobile-sidebar-toggle"]').click()
  await expect(mobileSidebar).toHaveClass(/translate-x-0/)
  await expect(mobileSidebar).toBeInViewport({ ratio: 0.5 })
}

async function expectPassiveRequestBoundary(input: {
  requestTimeline: string[]
  passiveReads: string[]
  passiveReadCompletions: string[]
  passiveRequestFailures: string[]
  inactiveReads: string[]
  unrelatedReads: string[]
  consoleErrors: string[]
  requestFailures: string[]
}) {
  await expect.poll(() => input.requestTimeline.includes("active-message-finished")).toBe(true)
  await expect.poll(() => new Set(input.passiveReadCompletions)).toEqual(passiveRequests)
  await expect.poll(() => input.passiveReadCompletions.length).toBe(input.passiveReads.length)
  expect(new Set(input.passiveReads)).toEqual(passiveRequests)
  expect(input.passiveReads.filter((path) => path !== "/session/status")).toHaveLength(passiveRequests.size - 1)
  expect(input.inactiveReads.every((path) => path === "/session" || passiveRequests.has(path))).toBe(true)
  expect(new Set(input.inactiveReads.filter((path) => path !== "/session"))).toEqual(passiveRequests)
  expect(input.unrelatedReads).toEqual([])
  expect(input.passiveRequestFailures).toEqual([])
  expect(input.requestTimeline.indexOf("active-message-finished")).toBeLessThan(
    input.requestTimeline.findIndex((event) => event.startsWith("passive:")),
  )
  expect(input.consoleErrors).toEqual([])
  expect(input.requestFailures).toEqual([])
}

async function expectInitialPassiveHydration(input: {
  requestTimeline: string[]
  passiveReads: string[]
  passiveReadCompletions: string[]
  passiveRequestFailures: string[]
  inactiveReads: string[]
  unrelatedReads: string[]
  consoleErrors: string[]
  requestFailures: string[]
}) {
  await expect.poll(() => new Set(input.passiveReadCompletions).size).toBe(passiveRequests.size)
  expect(new Set(input.passiveReads)).toEqual(passiveRequests)
  expect(new Set(input.passiveReadCompletions)).toEqual(passiveRequests)
  expect(input.inactiveReads.every((path) => path === "/session" || passiveRequests.has(path))).toBe(true)
  expect(input.unrelatedReads).toEqual([])
  expect(input.passiveRequestFailures).toEqual([])
  expect(input.requestTimeline.indexOf("active-message-finished")).toBeLessThan(
    input.requestTimeline.findIndex((event) => event.startsWith("passive:")),
  )
  expect(input.consoleErrors).toEqual([])
  expect(input.requestFailures).toEqual([])
}

async function captureHomePassiveBaseline(workspace: Awaited<ReturnType<typeof setupWorkspace>>) {
  const baselineRequestSequence = workspace.latestRequestSequence()
  await expect
    .poll(() =>
      workspace.statusResponseEvents.some(
        (response) =>
          response.directory === inactive &&
          response.data[workspace.inactiveSessions[2]!.id]?.type === "busy",
      ),
    )
    .toBe(true)
  await expect.poll(() => workspace.backgroundReadEvents.length).toBeGreaterThan(0)
  await expect.poll(() => new Set(workspace.passiveReadCompletions)).toEqual(passiveRequests)
  expect(workspace.unrelatedReads).toEqual([])
  const baselinePassiveRequestFailures = passiveRequestFailuresAfterBaseline(
    workspace.passiveRequestFailureEvents,
    baselineRequestSequence,
  )
  expect(baselinePassiveRequestFailures, JSON.stringify(baselinePassiveRequestFailures)).toEqual([])
  const capturedAt = Date.now()
  return {
    foreignReads: [...workspace.inactiveReadEvents],
    passiveReads: [...workspace.backgroundReadEvents],
    passiveRequestFailureEvents: [...workspace.passiveRequestFailureEvents],
    baselineRequestSequence,
    statusRequests: [...workspace.statusRequestEvents],
    statusResponses: [...workspace.statusResponseEvents],
    capturedAt,
    requestSequence: workspace.latestRequestSequence(),
  }
}

test("keeps expanded inactive workspace session rows from starting a full bootstrap", async ({ page }) => {
  const activeSession = {
    id: "ses_active_workspace_root",
    projectID: "project-workspace-bootstrap",
    directory: root,
    title: "Active root session",
    version: "dev",
    time: { created: 1_700_000_000_001, updated: 1_700_000_000_001 },
  }
  const session = {
    id: "ses_inactive_workspace_row",
    projectID: "project-workspace-bootstrap",
    directory: inactive,
    title: "Inactive workspace session",
    version: "dev",
    time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
  }
  const bootstrapRequests: string[] = []

  page.on("request", (request) => {
    const url = new URL(request.url())
    const directory =
      url.searchParams.get("directory") ??
      url.searchParams.get("location[directory]") ??
      request.headers()["x-opencode-directory"]
    if (directory !== inactive || !fullBootstrapRequests.has(url.pathname)) return
    bootstrapRequests.push(url.pathname)
  })

  await mockOpenCodeServer(page, {
    sessions: [activeSession, session],
    sessionList: [activeSession, session],
    provider: fixture.provider,
    directory: root,
    project: {
      id: "project-workspace-bootstrap",
      name: "Workspace Bootstrap",
      worktree: root,
      vcs: "git",
      sandboxes: [inactive],
    },
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript(({ serverKey, root, inactive }) => {
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({
        projects: { [serverKey]: [{ worktree: root, expanded: true }] },
        lastProject: { [serverKey]: root },
      }),
    )
    localStorage.setItem(
      "opencode.global.dat:layout",
      JSON.stringify({
        sidebar: { opened: true, width: 260, workspaces: { [root]: true }, workspacesDefault: false },
      }),
    )
    localStorage.setItem("opencode.global.dat:layout.page", JSON.stringify({ workspaceExpanded: { [inactive]: true } }))
  }, { serverKey: server, root, inactive })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/${base64Encode(root)}/session/${activeSession.id}`)
  await page.locator('[data-action="mobile-sidebar-toggle"]').click()
  await page.locator('[data-action="project-switch"]').click()
  await page.locator('[data-action="mobile-sidebar-toggle"]').click()
  await ensureMobileSidebarInViewport(page)

  await expect(page.locator('[data-component="sidebar-nav-mobile"]')).toBeInViewport()
  await expect(page.locator(`[data-component="workspace-item"][data-workspace="${base64Encode(inactive)}"]`)).toBeVisible()
  await expect(page.getByRole("link", { name: session.title })).toBeVisible()
  expect(bootstrapRequests).toEqual([])
})

test("keeps passive question, permission, and running indicators in the visible mobile workspace list", async ({ page }, testInfo) => {
  const workspace = await setupWorkspace({ page, viewport: { width: 390, height: 844 } })
  await page.locator('[data-action="mobile-sidebar-toggle"]').click()
  await page.locator('[data-action="project-switch"]').click()
  await page.locator('[data-action="mobile-sidebar-toggle"]').click()
  await ensureMobileSidebarInViewport(page)

  const questionRow = page.getByRole("link", { name: workspace.inactiveSessions[0]!.title })
  const permissionRow = page.getByRole("link", { name: workspace.inactiveSessions[1]!.title })
  const runningRow = page.getByRole("link", { name: workspace.inactiveSessions[2]!.title })
  await expect(questionRow).toBeVisible()
  await expect(questionRow.locator('[data-status="question"]')).toBeVisible()
  await expect(permissionRow.locator('[data-status="permission"]')).toBeVisible()
  const inactiveSessionList = page.locator("nav").filter({ has: questionRow }).last()
  const loadMoreInactiveSessions = inactiveSessionList.getByRole("button", { name: "Load more" })
  await loadMoreInactiveSessions.scrollIntoViewIfNeeded()
  await loadMoreInactiveSessions.click()
  await expect(runningRow.locator('[data-component="spinner"]')).toBeVisible()
  await expectPassiveRequestBoundary(workspace)
  await page.screenshot({ path: testInfo.outputPath("sidebar-indicators-mobile.png"), fullPage: true })
})

test("retries passive indicators when an expanded workspace session list arrives after active readiness", async ({ page }) => {
  const workspace = await setupWorkspace({
    page,
    viewport: { width: 390, height: 844 },
    delayInactiveSessionListUntilActiveMessage: true,
  })
  await page.locator('[data-action="mobile-sidebar-toggle"]').click()
  await page.locator('[data-action="project-switch"]').click()
  await page.locator('[data-action="mobile-sidebar-toggle"]').click()
  await ensureMobileSidebarInViewport(page)

  const questionRow = page.getByRole("link", { name: workspace.inactiveSessions[0]!.title })
  await expect(questionRow.locator('[data-status="question"]')).toBeVisible()
  await expect.poll(() => workspace.requestTimeline.includes("inactive-session-list-finished")).toBe(true)
  expect(workspace.requestTimeline.indexOf("active-message-finished")).toBeLessThan(
    workspace.requestTimeline.indexOf("inactive-session-list-finished"),
  )
  await expectPassiveRequestBoundary(workspace)
})

test("supplemental: a synthetic visibility event gates passive reads after a delayed active message", async ({ page }) => {
  const workspace = await setupWorkspace({
    page,
    viewport: { width: 390, height: 844 },
    holdActiveMessageUntilReleased: true,
  })
  await workspace.activeMessageStarted

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" })
    document.dispatchEvent(new Event("visibilitychange"))
  })
  await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe("hidden")
  workspace.releaseActiveMessage()
  await expect.poll(() => workspace.requestTimeline.includes("active-message-finished")).toBe(true)
  await page.waitForTimeout(200)
  expect(workspace.passiveReads).toEqual([])

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" })
    document.dispatchEvent(new Event("visibilitychange"))
  })
  await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe("visible")
  await ensureMobileSidebarInViewport(page)
  await page.getByRole("link", { name: workspace.inactiveSessions[0]!.title }).scrollIntoViewIfNeeded()
  await expect(page.getByRole("link", { name: workspace.inactiveSessions[0]!.title }).locator('[data-status="question"]')).toBeVisible()
  await expectPassiveRequestBoundary(workspace)
})

test("aborts passive reads when a workspace collapses and retries after it expands", async ({ page }, testInfo) => {
  const workspace = await setupWorkspace({
    page,
    viewport: { width: 390, height: 1400 },
    holdPassiveStatusUntilReleased: true,
  })
  await workspace.passiveStatusStarted
  const passiveStatusStartedAt = workspace.passiveStatusStartedAt()
  if (passiveStatusStartedAt === undefined) throw new Error("passive status request start was not recorded")
  await ensureMobileSidebarInViewport(page)
  const workspaceToggle = page.locator(
    `[data-action="workspace-toggle"][data-workspace="${base64Encode(inactive)}"]`,
  )
  await expect(workspaceToggle).toBeVisible()
  await workspaceToggle.scrollIntoViewIfNeeded()
  await expect(workspaceToggle).toBeInViewport()

  await workspaceToggle.click()
  await expect(workspaceToggle).toHaveAttribute("aria-expanded", "false")
  const workspaceCollapsedAt = Date.now()
  await expect.poll(() => workspace.passiveRequestFailures.length).toBe(1)
  const abortObservedAt = Date.now()
  expect(abortObservedAt - passiveStatusStartedAt).toBeLessThan(PASSIVE_STATUS_TIMEOUT_MS)
  workspace.releasePassiveStatus()
  await page.waitForTimeout(200)
  expect(workspace.passiveReads).toEqual(["/session/status"])

  await workspaceToggle.click()
  await expect(
    page.getByRole("link", { name: workspace.inactiveSessions[0]!.title }).locator('[data-status="question"]'),
  ).toBeVisible()
  await expect.poll(() => workspace.passiveReadCompletions.length).toBe(passiveRequests.size)
  expect(workspace.passiveRequestFailures).toEqual(["/session/status"])
  expect(workspace.passiveReads.filter((path) => path === "/session/status")).toHaveLength(2)
  expect(new Set(workspace.passiveReads)).toEqual(passiveRequests)
  expect(workspace.unrelatedReads).toEqual([])
  expect(workspace.consoleErrors).toEqual([])
  expect(workspace.requestFailures).toEqual([])
  const abortTimelinePath = testInfo.outputPath("collapse-abort-request-timeline.json")
  await writeFile(
    abortTimelinePath,
    JSON.stringify({
      passiveTimeoutMs: PASSIVE_STATUS_TIMEOUT_MS,
      passiveStatusStartedAt,
      workspaceCollapsedAt,
      abortObservedAt,
      requestTimeline: workspace.requestTimeline,
      messageRequests: workspace.messageRequestEvents(),
      statusRequests: workspace.statusRequestEvents,
      statusResponses: workspace.statusResponseEvents,
      passiveReads: workspace.passiveReads,
      passiveRequestFailures: workspace.passiveRequestFailures,
      passiveReadCompletions: workspace.passiveReadCompletions,
    }),
  )
  await testInfo.attach("collapse-abort-request-timeline.json", {
    path: abortTimelinePath,
    contentType: "application/json",
  })
})

test("keeps the real foreground switch isolated through native status reconciliation", async ({ page }, testInfo) => {
  test.setTimeout(90_000)
  const workspace = await setupWorkspace({
    page,
    viewport: { width: 1280, height: 720 },
    startAtHome: true,
    holdPassiveStatusUntilReleased: true,
    holdForegroundMessageUntilReleased: true,
  })

  await expect(page).toHaveURL(new URL("/", page.url()).href)
  await page.getByRole("button", { name: "Home", exact: true }).click()
  const activeSessionRow = page
    .locator('[data-component="home-session-row"]')
    .filter({ hasText: workspace.activeSession.title })
  await expect(activeSessionRow).toBeVisible()
  await expect
    .poll(async () => (await workspace.statusTimerProbe()).registeredAt !== undefined, { timeout: 3_000 })
    .toBe(true)
  const initialTimer = await workspace.statusTimerProbe()
  const registeredAt = initialTimer.registeredAt
  if (registeredAt === undefined) throw new Error("15-second session-status reconciliation timer was not registered")
  expect(initialTimer.registrations).toBe(1)
  await workspace.passiveStatusStarted
  await activeSessionRow.click()
  await expect(page.getByRole("heading", { name: workspace.activeSession.title })).toBeVisible()
  await expect
    .poll(() =>
      workspace.passiveRequestFailureEvents.some(
        (event) => event.path === "/session/status" && event.error === "net::ERR_ABORTED",
      ),
    )
    .toBe(true)
  const historicalPassiveAbort = workspace.passiveRequestFailureEvents.find(
    (event) => event.path === "/session/status" && event.error === "net::ERR_ABORTED",
  )
  if (!historicalPassiveAbort || historicalPassiveAbort.startedSequence === undefined)
    throw new Error("leaving the first Home view did not abort its held passive status request with a start sequence")
  const historicalPassiveAbortSequence = historicalPassiveAbort.startedSequence
  workspace.releasePassiveStatus()
  const activeTab = page.locator('[data-dock-area="middle"]').getByRole("tab", { name: workspace.activeSession.title })
  await expect(activeTab).toHaveAttribute("aria-selected", "true")
  await page.getByRole("button", { name: "Home", exact: true }).click()
  const foregroundSessionRow = page
    .locator('[data-component="home-session-row"]')
    .filter({ hasText: workspace.foregroundSession.title })
  await expect(foregroundSessionRow).toBeVisible()
  const firstPossibleSwitchAt = registeredAt + (initialTimer.ticks.length + 1) * 15_000 - 4_000
  if (firstPossibleSwitchAt - Date.now() < 0) {
    await expect
      .poll(async () => (await workspace.statusTimerProbe()).ticks.length, { timeout: 20_000 })
      .toBeGreaterThan(initialTimer.ticks.length)
  }
  const alignedTimer = await workspace.statusTimerProbe()
  const nextReconciliationAt = registeredAt + (alignedTimer.ticks.length + 1) * 15_000
  const foregroundSwitchAt = nextReconciliationAt - 4_000
  if (Date.now() < foregroundSwitchAt) await page.waitForTimeout(foregroundSwitchAt - Date.now())
  const homeBaseline = await captureHomePassiveBaseline(workspace)
  expect(historicalPassiveAbortSequence).toBeLessThan(homeBaseline.baselineRequestSequence)
  expect(homeBaseline.passiveRequestFailureEvents).toContainEqual(historicalPassiveAbort)
  const activeRootMessage = workspace.messageRequestEvents().find(
    (request) => request.sessionID === workspace.activeSession.id && request.result === "finished",
  )
  if (!activeRootMessage) throw new Error("Home/status baseline is missing the completed active-root message request")
  expect(activeRootMessage.finishedAt).toBeLessThanOrEqual(homeBaseline.capturedAt)
  expect(homeBaseline.statusResponses.some((response) => response.directory === root)).toBe(true)
  expect(homeBaseline.statusResponses.some((response) => response.directory === inactive)).toBe(true)
  const earlyTimelinePath = testInfo.outputPath("pre-selection-request-timeline.json")
  await writeFile(
    earlyTimelinePath,
    JSON.stringify({
      requestTimeline: workspace.requestTimeline,
      messageRequests: workspace.messageRequestEvents(),
      statusRequests: workspace.statusRequestEvents,
      statusResponses: workspace.statusResponseEvents,
      homeBaseline,
    }),
  )
  await testInfo.attach("pre-selection-request-timeline.json", { path: earlyTimelinePath, contentType: "application/json" })
  const timerTicksBeforeForeground = (await workspace.statusTimerProbe()).ticks.length

  const foregroundSelectionBaselineSequence = workspace.latestRequestSequence()
  workspace.armForegroundMessageHold()
  await foregroundSessionRow.click()
  await expect(page.getByRole("heading", { name: workspace.foregroundSession.title })).toBeVisible()
  await expect.poll(() => workspace.requestTimeline.includes("foreground-message-start"), { timeout: 3_000 }).toBe(true)
  const foregroundStartedAt = workspace.foregroundMessageStartedAt()
  const foregroundMessageRequest = workspace.messageRequestEvents().find(
    (request) =>
      request.sessionID === workspace.foregroundSession.id &&
      request.startedSequence > foregroundSelectionBaselineSequence &&
      request.finishedAt === undefined,
  )
  if (!foregroundMessageRequest) throw new Error("Home selection did not start a held foreground root-session message request")
  const requestStartedAt = foregroundMessageRequest.startedAt
  expect(foregroundStartedAt).toBeDefined()
  expect(foregroundStartedAt).toBeGreaterThanOrEqual(requestStartedAt)

  await test.step("observe the native 15-second reconciliation tick inside the real message deadline", async () => {
    const remaining = SESSION_MESSAGE_REQUEST_TIMEOUT_MS - (Date.now() - requestStartedAt!) - 500
    expect(remaining).toBeGreaterThan(0)
    await expect
      .poll(async () => (await workspace.statusTimerProbe()).ticks.length, {
        timeout: remaining,
        message: "waiting for the unmodified native reconciliation interval while the root message read is held",
      })
      .toBeGreaterThan(timerTicksBeforeForeground)
  })
  const reconciliationTick = (await workspace.statusTimerProbe()).ticks[timerTicksBeforeForeground]
  if (reconciliationTick === undefined) throw new Error("native reconciliation tick was not recorded")
  expect(reconciliationTick).toBeGreaterThanOrEqual(requestStartedAt)
  expect(reconciliationTick - requestStartedAt).toBeLessThan(SESSION_MESSAGE_REQUEST_TIMEOUT_MS)
  await expect
    .poll(
      () => {
        const statusRequest = workspace.statusRequestEvents.find(
          (request) =>
            request.directory === root &&
            request.at >= reconciliationTick - STATUS_TIMER_EVENT_SKEW_MS &&
            request.at <= reconciliationTick + 1_500,
        )
        return (
          statusRequest !== undefined &&
          workspace.statusResponseEvents.some(
            (response) =>
              response.directory === root &&
              response.at >= reconciliationTick &&
              response.at <= reconciliationTick + 1_500 &&
              response.at >= statusRequest.at &&
              response.data[workspace.foregroundSession.id]?.type === "busy",
          )
        )
      },
      {
        timeout: 1_500,
        message: "waiting for the root status request and busy response around the native reconciliation tick",
      },
    )
    .toBe(true)
  expect(workspace.requestTimeline).not.toContain("foreground-message-finished")
  expect(workspace.backgroundReadEvents.filter((request) => request.at >= requestStartedAt)).toEqual([])
  expect(
    workspace.statusRequestEvents.filter(
      (request) => request.directory !== root && request.at >= requestStartedAt && request.at <= reconciliationTick,
    ),
  ).toEqual([])
  workspace.releaseForegroundMessage()
  await test.step("settle the held foreground read before its unchanged 15-second deadline", async () => {
    const remaining = SESSION_MESSAGE_REQUEST_TIMEOUT_MS - (Date.now() - requestStartedAt) - 500
    expect(remaining).toBeGreaterThan(0)
    await expect.poll(() => workspace.requestTimeline.includes("foreground-message-finished"), { timeout: remaining }).toBe(true)
  })
  expect(foregroundMessageRequest.finishedAt).toBeGreaterThan(foregroundMessageRequest.startedAt)
  expect(foregroundMessageRequest.finishedSequence).toBeGreaterThan(foregroundMessageRequest.startedSequence)
  expect(foregroundMessageRequest.result).toBe("finished")
  expect(
    workspace.passiveRequestFailureEvents.filter(
      (event) =>
        event.startedSequence === undefined ||
        (event.startedSequence >= foregroundMessageRequest.startedSequence &&
          event.startedSequence <= foregroundMessageRequest.finishedSequence!),
    ),
  ).toEqual([])
  expect(
    workspace.inactiveReadEvents.filter(
      (request) =>
        request.sequence >= foregroundMessageRequest.startedSequence &&
        request.sequence <= foregroundMessageRequest.finishedSequence!,
    ),
  ).toEqual([])
  expect(
    workspace.statusRequestEvents.filter(
      (request) =>
        request.directory !== root &&
        request.sequence >= foregroundMessageRequest.startedSequence &&
        request.sequence <= foregroundMessageRequest.finishedSequence!,
    ),
  ).toEqual([])
  expect(workspace.unrelatedReads).toEqual([])
  expect(workspace.consoleErrors).toEqual([])
  expect(workspace.requestFailures).toEqual([])
  const statusTimelinePath = testInfo.outputPath("foreground-status-request-timeline.json")
  await writeFile(
    statusTimelinePath,
    JSON.stringify({
      requestTimeline: workspace.requestTimeline,
      statusRequests: workspace.statusRequestEvents,
      statusResponses: workspace.statusResponseEvents,
      rootMessageRequests: workspace.messageRequestEvents().filter(
        (request) => request.sessionID === workspace.foregroundSession.id,
      ),
      foregroundStartedAt,
      foregroundMessageRequest,
      reconciliationTick,
      foregroundFinishedAt: foregroundMessageRequest.finishedAt,
    }),
  )
  await testInfo.attach("foreground-status-request-timeline.json", {
    path: statusTimelinePath,
    contentType: "application/json",
  })
})

test("defers collapsed running-workspace recovery until the real foreground read finishes", async ({ page }, testInfo) => {
  test.setTimeout(90_000)
  const workspace = await setupWorkspace({
    page,
    viewport: { width: 390, height: 1400 },
    holdForegroundMessageUntilReleased: true,
  })

  await expect(page).toHaveURL(new URL("/", page.url()).href)
  await expect(page.getByRole("heading", { name: workspace.activeSession.title })).toBeVisible()
  const homeBaseline = await captureHomePassiveBaseline(workspace)
  const earlyTimelinePath = testInfo.outputPath("pre-selection-request-timeline.json")
  await writeFile(
    earlyTimelinePath,
    JSON.stringify({
        requestTimeline: workspace.requestTimeline,
        messageRequests: workspace.messageRequestEvents(),
        statusRequests: workspace.statusRequestEvents,
        statusResponses: workspace.statusResponseEvents,
        homeBaseline,
      }),
  )
  await testInfo.attach("pre-selection-request-timeline.json", { path: earlyTimelinePath, contentType: "application/json" })
  const activeRootMessage = workspace.messageRequestEvents().find(
    (request) => request.sessionID === workspace.activeSession.id && request.result === "finished",
  )
  if (!activeRootMessage) throw new Error("Home/status baseline is missing the completed active-root message request")
  expect(activeRootMessage.finishedAt).toBeLessThanOrEqual(homeBaseline.capturedAt)
  expect(homeBaseline.statusResponses.some((response) => response.directory === root)).toBe(true)
  expect(homeBaseline.statusResponses.some((response) => response.directory === inactive)).toBe(true)
  const mobileSidebar = page.locator('[data-component="sidebar-nav-mobile"]')
  const mobileSidebarToggle = page.locator('[data-action="mobile-sidebar-toggle"]')
  const sidebarInViewport = () =>
    mobileSidebar.evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      return bounds.left >= 0 && bounds.right <= innerWidth && bounds.top < innerHeight && bounds.bottom > 0
    })
  if (!(await sidebarInViewport())) await mobileSidebarToggle.click()
  await expect.poll(sidebarInViewport).toBe(true)
  await expect
    .poll(
      () =>
        workspace.statusResponseEvents.some(
          (response) => response.directory === inactive && response.data[workspace.inactiveSessions[2]!.id]?.type === "busy",
        ),
      { timeout: 5_000 },
    )
    .toBe(true)

  await expect(mobileSidebar.getByRole("button", { name: "Load more" })).toHaveCount(2)
  const loadMoreWorkspaces = mobileSidebar.getByRole("button", { name: "Load more" }).nth(1)
  await loadMoreWorkspaces.scrollIntoViewIfNeeded()
  await loadMoreWorkspaces.click()
  const runningRow = page.getByRole("link", { name: workspace.inactiveSessions[2]!.title })
  await expect(runningRow.locator('[data-component="spinner"]')).toBeVisible()

  const workspaceToggle = page.locator(`[data-action="workspace-toggle"][data-workspace="${base64Encode(inactive)}"]`)
  await expect(workspaceToggle).toBeVisible()
  await workspaceToggle.scrollIntoViewIfNeeded()
  await workspaceToggle.click()
  await expect(workspaceToggle).toHaveAttribute("aria-expanded", "false")
  const workspaceCollapsedAt = Date.now()

  await expect
    .poll(async () => (await workspace.statusTimerProbe()).fastRegistrations, { timeout: 3_000 })
    .toBeGreaterThan(0)
  const foregroundSessionLink = mobileSidebar.getByRole("link", { name: workspace.foregroundSession.title })
  await expect(foregroundSessionLink).toBeVisible()
  const foregroundSelectionBaselineSequence = workspace.latestRequestSequence()
  workspace.armForegroundMessageHold()
  await foregroundSessionLink.click()
  await expect(page.getByRole("heading", { name: workspace.foregroundSession.title })).toBeVisible()
  await expect.poll(() => workspace.requestTimeline.includes("foreground-message-start"), { timeout: 3_000 }).toBe(true)
  const foregroundStartedAt = workspace.foregroundMessageStartedAt()
  const foregroundMessageRequest = workspace.messageRequestEvents().find(
    (request) =>
      request.sessionID === workspace.foregroundSession.id &&
      request.startedSequence > foregroundSelectionBaselineSequence &&
      request.finishedAt === undefined,
  )
  if (!foregroundMessageRequest) throw new Error("Sidebar selection did not start a held foreground root-session message request")
  const requestStartedAt = foregroundMessageRequest.startedAt
  expect(foregroundStartedAt).toBeDefined()
  expect(foregroundStartedAt).toBeGreaterThanOrEqual(requestStartedAt)
  const timerTicksBeforePending = (await workspace.statusTimerProbe()).fastTicks.filter(
    (tick) => tick <= requestStartedAt,
  ).length

  await expect
    .poll(
      async () => (await workspace.statusTimerProbe()).fastTicks.some((tick) => tick > requestStartedAt),
      { timeout: SESSION_STATUS_POLL_INTERVAL_MS + 1_000 },
    )
    .toBe(true)
  const pendingTimer = await workspace.statusTimerProbe()
  const pendingPollTick = pendingTimer.fastTicks.find((tick) => tick > requestStartedAt)
  if (pendingPollTick === undefined) throw new Error("native three-second session-status poll did not tick while pending")
  expect(pendingTimer.fastTicks.length).toBeGreaterThan(timerTicksBeforePending)
  expect(pendingPollTick - requestStartedAt).toBeLessThanOrEqual(SESSION_STATUS_POLL_INTERVAL_MS + 500)
  expect(workspace.requestTimeline).not.toContain("foreground-message-finished")
  await expect
    .poll(
      () =>
        workspace.statusRequestEvents.some(
          (request) => request.directory === root && request.at >= pendingPollTick && request.at <= pendingPollTick + 1_500,
        ),
      { timeout: 1_500 },
    )
    .toBe(true)
  expect(
    workspace.statusRequestEvents.filter(
      (request) => request.directory === inactive && request.at >= requestStartedAt && request.at <= pendingPollTick,
    ),
  ).toEqual([])
  expect(
    workspace.backgroundReadEvents.filter(
      (request) => request.at >= requestStartedAt && request.at <= pendingPollTick,
    ),
  ).toEqual([])
  expect(
    workspace.statusResponseEvents.some(
      (response) => response.directory === root && response.data[workspace.foregroundSession.id]?.type === "busy",
    ),
  ).toBe(true)

  workspace.releaseForegroundMessage()
  await test.step("finish the actual foreground message within its unchanged request deadline", async () => {
    const remaining = SESSION_MESSAGE_REQUEST_TIMEOUT_MS - (Date.now() - requestStartedAt) - 500
    expect(remaining).toBeGreaterThan(0)
    await expect.poll(() => workspace.requestTimeline.includes("foreground-message-finished"), { timeout: remaining }).toBe(true)
  })
  const foregroundFinishedAt = foregroundMessageRequest.finishedAt
  expect(foregroundFinishedAt).toBeGreaterThan(foregroundMessageRequest.startedAt)
  expect(foregroundMessageRequest.finishedSequence).toBeGreaterThan(foregroundMessageRequest.startedSequence)
  expect(foregroundMessageRequest.result).toBe("finished")
  expect(
    workspace.inactiveReadEvents.filter(
      (request) =>
        request.sequence >= foregroundMessageRequest.startedSequence &&
        request.sequence <= foregroundMessageRequest.finishedSequence!,
    ),
  ).toEqual([])
  await expect
    .poll(
      () =>
        workspace.statusRequestEvents.some(
          (request) => request.directory === inactive && request.at > foregroundFinishedAt!,
        ),
      { timeout: SESSION_STATUS_POLL_INTERVAL_MS + 500 },
    )
    .toBe(true)
  const resumedStatusRequest = workspace.statusRequestEvents.find(
    (request) => request.directory === inactive && request.at > foregroundFinishedAt!,
  )
  if (!resumedStatusRequest) throw new Error("collapsed running workspace did not recover after foreground completion")
  const recoveryPollTick = (await workspace.statusTimerProbe()).fastTicks.find(
    (tick) => tick > foregroundFinishedAt! && tick <= resumedStatusRequest.at,
  )
  expect(recoveryPollTick).toBeDefined()
  expect(resumedStatusRequest.at - recoveryPollTick!).toBeLessThan(1_500)
  expect(resumedStatusRequest.at - foregroundFinishedAt!).toBeLessThanOrEqual(SESSION_STATUS_POLL_INTERVAL_MS + 500)
  expect(resumedStatusRequest.at).toBeGreaterThan(workspaceCollapsedAt)
  await expect(workspaceToggle).toHaveAttribute("aria-expanded", "false")
  expect(
    workspace.passiveRequestFailureEvents.filter(
      (event) =>
        event.startedSequence === undefined ||
        (event.startedSequence >= foregroundMessageRequest.startedSequence &&
          event.startedSequence <= foregroundMessageRequest.finishedSequence!),
    ),
  ).toEqual([])
  expect(new Set(workspace.passiveReadCompletions)).toEqual(passiveRequests)
  expect(workspace.passiveReads.every((path) => passiveRequests.has(path))).toBe(true)
  expect(workspace.inactiveReads.every((path) => path === "/session" || passiveRequests.has(path))).toBe(true)
  expect(workspace.unrelatedReads).toEqual([])
  expect(workspace.consoleErrors).toEqual([])
  expect(workspace.requestFailures).toEqual([])
  const recoveryTimelinePath = testInfo.outputPath("collapsed-recovery-request-timeline.json")
  await writeFile(
    recoveryTimelinePath,
    JSON.stringify({
      requestTimeline: workspace.requestTimeline,
      statusRequests: workspace.statusRequestEvents,
      statusResponses: workspace.statusResponseEvents,
      homeBaseline,
      rootMessageRequests: workspace.messageRequestEvents().filter(
        (request) =>
          request.sessionID === workspace.activeSession.id || request.sessionID === workspace.foregroundSession.id,
      ),
      foreignReadsWhileForegroundPending: workspace.inactiveReadEvents.filter(
        (request) =>
          request.sequence >= foregroundMessageRequest.startedSequence &&
          request.sequence <= foregroundMessageRequest.finishedSequence!,
      ),
      workspaceCollapsedAt,
      foregroundStartedAt,
      foregroundMessageRequest,
      pendingPollTick,
      foregroundFinishedAt,
      recoveryPollTick,
      resumedStatusRequest,
    }),
  )
  await testInfo.attach("collapsed-recovery-request-timeline.json", {
    path: recoveryTimelinePath,
    contentType: "application/json",
  })
})
test("keeps the desktop active session and rendered navigation while passive workspace reads stay scoped", async ({ page }, testInfo) => {
  const workspace = await setupWorkspace({ page, viewport: { width: 1280, height: 720 } })
  // Session deep links are admitted into the active dock tab on the canonical root route.
  await expect(page).toHaveURL(new URL("/", page.url()).href)
  await expect(page.getByRole("heading", { name: workspace.activeSession.title })).toBeVisible()

  const activeTab = page.locator('[data-dock-area="middle"]').getByRole("tab", { name: workspace.activeSession.title })
  const homeNavigation = page.locator('header [data-action="home-toggle"]')
  await expect(activeTab).toBeVisible()
  await expect(activeTab).toHaveAttribute("aria-selected", "true")
  await expect(homeNavigation).toBeVisible()
  await expect(homeNavigation).toHaveAttribute("aria-pressed", "false")
  await expect(page.locator('[data-component="sidebar-nav-mobile"]')).toBeHidden()

  await page.screenshot({ path: testInfo.outputPath("desktop-active-route-navigation.png"), fullPage: true })

  await homeNavigation.click()
  await expect(homeNavigation).toHaveAttribute("aria-pressed", "true")
  await homeNavigation.click()
  await expect(homeNavigation).toHaveAttribute("aria-pressed", "false")
  await expect(activeTab).toHaveAttribute("aria-selected", "true")
  await expect(page).toHaveURL(new URL("/", page.url()).href)
  await testInfo.attach("desktop-passive-request-timeline.json", {
    body: Buffer.from(
      JSON.stringify({
        requestTimeline: workspace.requestTimeline,
        messageRequests: workspace.messageRequestEvents(),
        inactiveReadEvents: workspace.inactiveReadEvents,
        statusRequests: workspace.statusRequestEvents,
        statusResponses: workspace.statusResponseEvents,
      }),
    ),
    contentType: "application/json",
  })
  await expectPassiveRequestBoundary(workspace)
})
