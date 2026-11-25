import { expect, test, type Page } from "@playwright/test"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { z } from "zod"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"
import { expectNoSmokeErrors, trackNetworkFailures, trackPageErrors } from "../utils/errors"

const directory = "C:/OpenCode/AgentHandoff"
const projectID = "proj_agent_handoff"
const sessionID = "ses_agent_handoff"
const otherSessionID = "ses_agent_handoff_other"
const serverHost = process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"
const serverPort = process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"
const server = `http://${serverHost}:${serverPort}`
const screenshotPath = (name: string) => test.info().outputPath(name)
test.use({ video: { mode: process.env.PLAYWRIGHT_VIDEO === "on" ? "on" : "retain-on-failure", size: { width: 1280, height: 900 } } })
type HandoffMockOptions = {
  questions: () => unknown[]
  sessionTabs?: string[]
  onQuestionReject?: (input: { sessionID: string; requestID: string }) => unknown | Promise<unknown>
}

function isExpectedAbortedBackgroundRequest(failure: string) {
  if (!failure.endsWith("net::ERR_ABORTED")) return false
  const [method, url] = failure.split(" ")
  if (!method || !url) return false
  let pathname: string
  try {
    pathname = new URL(url).pathname
  } catch {
    return false
  }
  // Konkreter Vertrag: nur PATCH /global/config und POST /perf/record
  // als erwartete Hintergrund-Abbrüche erlauben — keine Erweiterung.
  return (
    (method === "PATCH" && pathname === "/global/config") ||
    (method === "POST" && pathname === "/perf/record")
  )
}

test("a control surface handoff shows the exact target, prompt and model before one atomic request", async ({ page }) => {
  const errors = trackPageErrors(page)
  const networkFailures = trackNetworkFailures(page)
  const requests: unknown[] = []
  const dismissals: Array<{ sessionID: string; requestID: string }> = []
  let handoffDismissed = false
  let releaseDismissal = () => {}
  let dismissalAttempt = 0
  const dismissalGate = new Promise<void>((resolve) => {
    releaseDismissal = resolve
  })
  await setupHandoffPage(page, {
    questions: () => handoffDismissed ? [] : [handoffRequest()],
    onQuestionReject: ({ sessionID: dismissedSessionID, requestID }) => {
      dismissals.push({ sessionID: dismissedSessionID, requestID })
      expect(dismissedSessionID).toBe(sessionID)
      expect(requestID).toBe("que_agent_handoff")
      if (dismissals.length === 1) return { status: 500, body: { message: "Retry cleanup" } }
      handoffDismissed = true
    },
  })
  await page.route(`**/api/session/${sessionID}/switch-agent-and-prompt`, async (route) => {
    requests.push(route.request().postDataJSON())
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "msg_started" }) })
  })
  await page.route(`**/api/session/${sessionID}/surface/que_agent_handoff/dismiss`, async (route) => {
    dismissalAttempt++
    if (dismissalAttempt === 1) await dismissalGate
    await route.fallback()
  })
  await page.goto(`/${base64Encode(directory)}/session`)
  const globalHandoff = page.locator('[data-component="control-panel-popup"] [data-component="agent-handoff"]')
  await expect(globalHandoff).toBeVisible()
  await expect(page.locator('[data-component="agent-handoff"]')).toHaveCount(1)
  const request = globalHandoff
  await expect(request).toBeVisible()
  await expect(request).toContainText("AGENT SWITCH REQUEST")
  await expect(request).toContainText("Requested target agent")
  await expect(request).toContainText("build")
  await expect(request.locator('[data-component="on-demand-expectation"]')).toContainText("Expected: confirm the target agent, exact prompt, and model for the next turn.")
  await expect(request.locator('[data-component="agent-handoff-safety-warning"]')).toContainText("AGENT SWITCH")
  await expect(request.getByText("Implement the approved session plan.", { exact: true })).toBeVisible()
  await expect(request.getByRole("radio", { name: /Use implementation default/ })).toBeChecked()
  await expect(request.getByRole("button", { name: "Implementation model or chain" })).toContainText("GLM Chain")
  await expect(request.getByText("(opencode/gpt-test · high)", { exact: true })).toBeVisible()
  expect(requests).toHaveLength(0)

  for (const viewport of [
    { width: 1440, height: 900, name: "desktop" },
    { width: 900, height: 700, name: "compact" },
    { width: 390, height: 844, name: "narrow" },
  ]) {
    await page.setViewportSize(viewport)
    await expect(request).toBeVisible()
    await expect(request.locator('[data-component="agent-handoff-actions"]')).toBeVisible()
    await expect(request.getByRole("button", { name: "Switch to build and implement" })).toBeVisible()
    const box = await request.boundingBox()
    expect(box).toBeTruthy()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width)
    await page.screenshot({ path: screenshotPath(`agent-handoff-${viewport.name}.png`), fullPage: true })
  }

  const cleanupResponsePromise = page.waitForResponse((response) => {
    const request = response.request()
    const url = new URL(response.url())
    return (
      request.method() === "POST" &&
      url.origin === server &&
      url.pathname === `/api/session/${sessionID}/surface/que_agent_handoff/dismiss`
    )
  })
  await request.getByRole("button", { name: "Switch to build and implement" }).click()
  await expect.poll(() => requests.length).toBe(1)
  expect(requests[0]).toMatchObject({
    agent: "build",
    model: {
      providerID: "opencode",
      id: "glm-test",
      chain: {
        id: "glm-chain",
        name: "GLM Chain",
        active: 0,
        steps: [
          { providerID: "opencode", id: "glm-test" },
          { providerID: "opencode", id: "fallback-test" },
        ],
      },
    },
    prompt: { text: "Implement the approved session plan." },
    confirmation: {
      requestID: "que_agent_handoff",
      revision: 1,
      actionID: "handoff",
      invocationID: expect.any(String),
      token: "confirm-agent-handoff",
    },
  })
  await expect.poll(() => dismissalAttempt).toBe(1)
  try {
    await expect(page.locator('[data-component="control-panel-popup"]')).toHaveCount(0)
    await page.evaluate((path) => {
      window.history.pushState(window.history.state, "", path)
      window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }))
    }, `/${base64Encode(directory)}/session/${sessionID}`)
    await expectAppVisible(page.getByRole("heading", { name: "Agent handoff" }))
    await expect(page.locator('[data-component="control-panel-popup"]')).toHaveCount(0)
    await expect(page.locator('[data-component="agent-handoff"]')).toHaveCount(0)
  } finally {
    releaseDismissal()
  }
  await expect.poll(() => dismissals.length).toBe(1)
  const cleanupResponse = await cleanupResponsePromise
  const cleanupRequest = cleanupResponse.request()
  expect(cleanupRequest.method()).toBe("POST")
  expect(cleanupRequest.url()).toBe(`${server}/api/session/${sessionID}/surface/que_agent_handoff/dismiss`)
  expect(cleanupRequest.headers()["origin"]).toBe(new URL(page.url()).origin)
  expect(cleanupResponse.status()).toBe(500)
  expect(await cleanupResponse.text()).toBe(JSON.stringify({ message: "Retry cleanup" }))
  await expectAppVisible(page.getByText("Agent switch started; cleanup failed"))
  await expectAppVisible(page.getByRole("button", { name: "Retry cleanup" }))
  expect(requests).toHaveLength(1)
  await page.getByRole("button", { name: "Retry cleanup" }).click()
  await expect.poll(() => dismissals.length).toBe(2)
  await expect.poll(() => handoffDismissed).toBe(true)
  expect(dismissals).toEqual([
    { sessionID, requestID: "que_agent_handoff" },
    { sessionID, requestID: "que_agent_handoff" },
  ])
  await expectAppVisible(page.getByRole("heading", { name: "Agent handoff" }))
  await expect(page.locator('[data-component="control-panel-popup"]')).toHaveCount(0)
  await expect(page.locator('[data-component="agent-handoff"]')).toHaveCount(0)
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.screenshot({ path: screenshotPath("agent-handoff-closed-desktop.png"), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator('[data-component="control-panel-popup"]')).toHaveCount(0)
  await expect(page.locator('[data-component="agent-handoff"]')).toHaveCount(0)
  await page.screenshot({ path: screenshotPath("agent-handoff-closed-mobile.png"), fullPage: true })
  await page.reload()
  await expectAppVisible(page.getByRole("heading", { name: "Agent handoff" }))
  await expect(page.locator('[data-component="control-panel-popup"]')).toHaveCount(0)
  await expect(page.locator('[data-component="agent-handoff"]')).toHaveCount(0)
  expect(requests).toHaveLength(1)
  const expectedCleanupFailure = "Failed to load resource: the server responded with a status of 500 (Internal Server Error)"
  expect(errors.filter((error) => error === expectedCleanupFailure)).toHaveLength(1)
  expectNoSmokeErrors(errors.filter((error) => error !== expectedCleanupFailure), [], [])
  expect(networkFailures.filter((failure) => failure.startsWith("500 "))).toEqual([
    `500 POST ${server}/api/session/${sessionID}/surface/que_agent_handoff/dismiss`,
  ])
  expect(
    networkFailures
      .filter((failure) => !failure.startsWith("500 "))
      .every((failure) => isExpectedAbortedBackgroundRequest(failure)),
  ).toBe(true)
})

test("recovers persisted cleanup after reload without reopening or repeating the switch", async ({ page }) => {
  const errors = trackPageErrors(page)
  const networkFailures = trackNetworkFailures(page)
  const requests: unknown[] = []
  const dismissals: Array<{ sessionID: string; requestID: string }> = []
  let handoffDismissed = false
  let releaseRecovery = () => {}
  const recoveryGate = new Promise<void>((resolve) => {
    releaseRecovery = resolve
  })
  let dismissalRequests = 0
  await setupHandoffPage(page, {
    questions: () => handoffDismissed ? [] : [handoffRequest()],
    onQuestionReject: (request) => {
      dismissals.push(request)
      if (dismissals.length === 1) return { status: 500, body: { message: "Temporary cleanup failure" } }
      handoffDismissed = true
    },
  })
  await page.route(`**/api/session/${sessionID}/switch-agent-and-prompt`, async (route) => {
    requests.push(route.request().postDataJSON())
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "msg_started" }) })
  })
  await page.route(`**/api/session/${sessionID}/surface/que_agent_handoff/dismiss`, async (route) => {
    dismissalRequests++
    if (dismissalRequests === 1) return route.fallback()
    await recoveryGate
    await route.fallback()
  })

  await page.goto(`/${base64Encode(directory)}/session`)
  await page.locator('[data-component="control-panel-popup"] [data-component="agent-handoff"]')
    .getByRole("button", { name: "Switch to build and implement" })
    .click()
  await expect.poll(() => dismissals.length).toBe(1)
  await expectAppVisible(page.getByRole("button", { name: "Retry cleanup" }))
  await expect(page.locator('[data-component="control-panel-popup"]')).toHaveCount(0)
  expect(requests).toHaveLength(1)

  await page.reload()
  await expect.poll(() => dismissalRequests).toBe(2)
  try {
    await expect(page.locator('[data-component="control-panel-popup"]')).toHaveCount(0)
    await expect(page.locator('[data-component="agent-handoff"]')).toHaveCount(0)
    expect(requests).toHaveLength(1)
  } finally {
    releaseRecovery()
  }
  await expect.poll(() => dismissals.length).toBe(2)
  await expect.poll(() => handoffDismissed).toBe(true)
  expect(dismissals).toEqual([
    { sessionID, requestID: "que_agent_handoff" },
    { sessionID, requestID: "que_agent_handoff" },
  ])
  expect(requests).toHaveLength(1)
  const expectedCleanupFailure = "Failed to load resource: the server responded with a status of 500 (Internal Server Error)"
  expect(errors.filter((error) => error === expectedCleanupFailure)).toHaveLength(1)
  expectNoSmokeErrors(errors.filter((error) => error !== expectedCleanupFailure), [], [])
  expect(networkFailures.filter((failure) => failure.startsWith("500 "))).toEqual([
    `500 POST ${server}/api/session/${sessionID}/surface/que_agent_handoff/dismiss`,
  ])
  expect(
    networkFailures
      .filter((failure) => !failure.startsWith("500 "))
      .every((failure) => isExpectedAbortedBackgroundRequest(failure)),
  ).toBe(true)
})

test("dismisses the submitted request if its popup is minimized while the switch is pending", async ({ page }) => {
  const errors = trackPageErrors(page)
  const networkFailures = trackNetworkFailures(page)
  const requests: unknown[] = []
  const dismissals: Array<{ sessionID: string; requestID: string }> = []
  const switchResponses: number[] = []
  const cleanupListResponses: number[] = []
  let handoffDismissed = false
  let releaseSwitch = () => {}
  const switchGate = new Promise<void>((resolve) => {
    releaseSwitch = resolve
  })
  await setupHandoffPage(page, {
    questions: () => handoffDismissed ? [] : [handoffRequest()],
    onQuestionReject: (request) => {
      dismissals.push(request)
      handoffDismissed = true
    },
  })
  page.on("response", (response) => {
    if (response.url().includes(`/api/session/${sessionID}/switch-agent-and-prompt`)) switchResponses.push(response.status())
    if (new URL(response.url()).pathname === `/api/session/${sessionID}/surface`) cleanupListResponses.push(response.status())
  })
  await page.route(`**/api/session/${sessionID}/switch-agent-and-prompt`, async (route) => {
    requests.push(route.request().postDataJSON())
    await switchGate
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "msg_started" }) })
  })

  await page.goto(`/${base64Encode(directory)}/session`)
  const form = page.locator('[data-component="control-panel-popup"] [data-component="agent-handoff"]')
  await expect(form).toBeVisible()
  await form.getByRole("button", { name: "Switch to build and implement" }).click()
  await expect.poll(() => requests.length).toBe(1)
  try {
    await page.getByRole("button", { name: "Minimize" }).click()
    await expect(page.locator('[data-component="control-panel-popup"]')).toHaveCount(0)
  } finally {
    releaseSwitch()
  }

  await expect.poll(() => switchResponses.length).toBe(1)
  expect(switchResponses).toEqual([200])
  await expectAppVisible(page.getByText("Started build"))
  await expect.poll(() => cleanupListResponses.length).toBe(1)
  expect(cleanupListResponses).toEqual([200])
  await expect.poll(() => dismissals.length).toBe(1)
  expect(dismissals).toEqual([{ sessionID, requestID: "que_agent_handoff" }])
  expect(requests).toHaveLength(1)
  await page.evaluate((path) => {
    window.history.pushState(window.history.state, "", path)
    window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }))
  }, `/${base64Encode(directory)}/session/${sessionID}`)
  await expectAppVisible(page.getByRole("heading", { name: "Agent handoff" }))
  await expect(page.locator('[data-component="control-panel-popup"]')).toHaveCount(0)
  await expect(page.locator('[data-component="agent-handoff"]')).toHaveCount(0)
  await expect(page.getByText("Started build")).toHaveCount(0)
  await page.setViewportSize({ width: 1280, height: 720 })
  await test.info().attach("agent-handoff-minimized-closed-desktop", {
    body: await page.screenshot({ path: screenshotPath("agent-handoff-minimized-closed-desktop.png"), fullPage: true }),
    contentType: "image/png",
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator('[data-component="control-panel-popup"]')).toHaveCount(0)
  await expect(page.locator('[data-component="agent-handoff"]')).toHaveCount(0)
  await test.info().attach("agent-handoff-minimized-closed-mobile", {
    body: await page.screenshot({ path: screenshotPath("agent-handoff-minimized-closed-mobile.png"), fullPage: true }),
    contentType: "image/png",
  })
  expectNoSmokeErrors(errors, [], [])
  expect(networkFailures).toEqual([])
})

test("a pruned handoff orphan is not reactivated after closing Review", async ({ page }) => {
  const errors = trackPageErrors(page)
  const networkFailures = trackNetworkFailures(page)
  let handoffDismissed = false
  const requests: unknown[] = []
  await setupHandoffPage(page, {
    questions: () => (handoffDismissed ? [] : [handoffRequest()]),
    onQuestionReject: () => {
      handoffDismissed = true
    },
  })
  await page.route(`**/api/session/${sessionID}/switch-agent-and-prompt`, async (route) => {
    requests.push(route.request().postDataJSON())
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "msg_pruned_handoff" }) })
  })
  const readDock = () =>
    page.evaluate(() => {
      const stored = localStorage.getItem("opencode.global.dat:layout")
      if (!stored) return undefined
      return (
        JSON.parse(stored) as {
          dock?: {
            right?: { tabs?: string[]; active?: string }
            items?: Record<string, { area: string; visible: boolean }>
          }
        }
      ).dock
    })

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  const popup = page.locator('[data-component="control-panel-popup"]')
  await expect(popup.locator('[data-component="agent-handoff"]')).toBeVisible()
  await popup.getByRole("button", { name: "In Session-Dock" }).click()
  const dockPanel = page.locator('[data-component="control-panel-dock-pane"][data-control-id="handoff"]')
  await expect(dockPanel).toBeVisible()
  await dockPanel.locator('[data-slot="control-panel-dock-action"][data-area="right"]').click()

  const rightDock = page.locator('[data-dock-area="right"]')
  const handoffTab = rightDock.getByRole("tab", { name: "Implementation handoff" })
  await expect(handoffTab).toBeVisible()
  const orphanID = await rightDock
    .locator("[data-dock-tab]")
    .filter({ hasText: "Implementation handoff" })
    .getAttribute("data-dock-tab")
  expect(orphanID).toBeTruthy()
  await rightDock.getByRole("tab", { name: "Review" }).click()
  await expect(popup.locator('[data-component="agent-handoff"]')).toBeVisible()
  await popup.getByRole("button", { name: "Switch to build and implement" }).click()
  await expect.poll(() => requests.length).toBe(1)
  await expect.poll(() => handoffDismissed).toBe(true)
  await expect(page.locator('[data-component="agent-handoff"]')).toHaveCount(0)
  await expect(rightDock.getByRole("tab", { name: "Implementation handoff" })).toHaveCount(0)
  await expect.poll(async () => (await readDock())?.right?.tabs).toContain(orphanID)
  await expect.poll(async () => (await readDock())?.right?.active).toBe("review")
  expect((await readDock())?.items?.[orphanID!]).toMatchObject({ area: "right", visible: true })

  await rightDock.locator('[data-dock-tab="review"] [aria-label="Close Review"]').click()
  await expect(rightDock.getByRole("tab", { name: "Review" })).toHaveCount(0)
  await expect.poll(async () => (await readDock())?.right?.active).toBeUndefined()
  const persistedDock = await readDock()
  expect(persistedDock?.right?.tabs).toContain(orphanID)
  expect(persistedDock?.items?.[orphanID!]).toMatchObject({ area: "right", visible: true })
  await expect(rightDock.locator('[role="tab"][aria-selected="true"]')).toHaveCount(0)
  await expect(page.locator('[data-component="control-panel-popup"]')).toHaveCount(0)
  await expect(page.locator('[data-component="agent-handoff"]')).toHaveCount(0)
  await page.screenshot({ path: screenshotPath("agent-handoff-pruned-orphan-review-close.png"), fullPage: true })
  expectNoSmokeErrors(errors, [], [])
  expect(networkFailures.every((failure) => isExpectedAbortedBackgroundRequest(failure))).toBe(true)
})

test("a visible docked handoff stays rendered after closing active Review and owns its request off-route", async ({ page }) => {
  const errors = trackPageErrors(page)
  const networkFailures = trackNetworkFailures(page)
  await setupHandoffPage(page, { questions: () => [handoffRequest()], sessionTabs: [sessionID, otherSessionID] })

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  const popup = page.locator('[data-component="control-panel-popup"]')
  await expect(popup.locator('[data-component="agent-handoff"]')).toBeVisible()
  await popup.getByRole("button", { name: "In Session-Dock" }).click()

  const dockPanel = page.locator('[data-component="control-panel-dock-pane"][data-control-id="handoff"]')
  await expect(dockPanel).toBeVisible()
  await dockPanel.locator('[data-slot="control-panel-dock-action"][data-area="right"]').click()
  const rightDock = page.locator('[data-dock-area="right"]')
  await expect(rightDock.getByRole("tab", { name: "Implementation handoff" })).toBeVisible()
  await rightDock.getByRole("tab", { name: "Review" }).click()
  await expect(popup.locator('[data-component="agent-handoff"]')).toBeVisible()
  await expect(page.locator('[data-component="agent-handoff"]')).toHaveCount(1)
  await rightDock.getByRole("tab", { name: "Implementation handoff" }).click({ force: true })
  await expect(popup).toHaveCount(0)

  await page.locator(`[data-dock-tab][data-session-id="${otherSessionID}"]`).getByRole("tab").click()

  await expectAppVisible(page.getByRole("heading", { name: "Other session" }))
  await expect(popup).toHaveCount(0)
  await expect(dockPanel.locator('[data-component="agent-handoff"]')).toHaveCount(1)
  await page.screenshot({ path: screenshotPath("agent-handoff-docked-off-route-desktop.png"), fullPage: true })
  await rightDock.getByRole("tab", { name: "Review" }).click()
  await expect(popup.locator('[data-component="agent-handoff"]')).toBeVisible()
  await expect(page.locator('[data-component="agent-handoff"]')).toHaveCount(1)
  await rightDock.getByRole("tab", { name: "Implementation handoff" }).click({ force: true })
  await expect(popup).toHaveCount(0)
  await expect(dockPanel.locator('[data-component="agent-handoff"]')).toHaveCount(1)

  await rightDock.getByRole("tab", { name: "Review" }).click()
  await expect(popup.locator('[data-component="agent-handoff"]')).toBeVisible()
  await expect(page.locator('[data-component="agent-handoff"]')).toHaveCount(1)
  await rightDock.locator('[data-dock-tab="review"] [aria-label="Close Review"]').click()
  await expect(rightDock.getByRole("tab", { name: "Review" })).toHaveCount(0)
  await expect(popup).toHaveCount(0)
  await expect(page.locator('[data-component="agent-handoff"]')).toHaveCount(1)
  const handoffTab = rightDock.getByRole("tab", { name: "Implementation handoff" })
  await expect(handoffTab).toHaveAttribute("aria-selected", "true")
  await expect(dockPanel).toBeVisible()
  await expect(dockPanel.locator('[data-component="agent-handoff"]')).toBeVisible()
  await page.reload()
  await expectAppVisible(page.getByRole("heading", { name: "Other session" }))
  await expect(popup.locator('[data-component="agent-handoff"]')).toBeVisible()
  await expect(page.locator('[data-component="agent-handoff"]')).toHaveCount(1)
  await page.screenshot({ path: screenshotPath("agent-handoff-reloaded-off-route-desktop.png"), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(popup.locator('[data-component="agent-handoff"]')).toBeVisible()
  await expect(page.locator('[data-component="agent-handoff"]')).toHaveCount(1)
  await page.screenshot({ path: screenshotPath("agent-handoff-docked-off-route-mobile.png"), fullPage: true })
  expectNoSmokeErrors(errors, [], [])
  expect(
    networkFailures.every((failure) => isExpectedAbortedBackgroundRequest(failure)),
  ).toBe(true)
})

test("Daily Review exposes all 48 accepted items and confirms while build is already selected", async ({ page }) => {
  const errors = trackPageErrors(page)
  const failures = trackNetworkFailures(page)
  page.on("pageerror", (error) => console.log(`[daily-review QA pageerror] ${error.message}`))
  page.on("console", (message) => {
    if (message.type() === "error") console.log(`[daily-review QA console] ${message.text()}`)
  })
  const acceptedItems = Array.from({ length: 48 }, (_, index) => ({
    itemId: `qa-${index + 1}`,
    approvalId: createHash("sha256").update(`qa-approval-${index}`).digest("hex"),
  }))
  const markdown = [
    "# Daily Review QA fixture — synthetic approvals, never live authorization",
    "## Ergebnis und genaue Bindung",
    "- runId: `qa-morning`", "- morningRunId: `qa-morning`",
    "- runDate: `2026-10-08`", "- planId: `qa-plan`",
    "## Angenommen",
    ...acceptedItems.map((item, index) => [
      `### itemId \`${item.itemId}\``,
      `- approvalId: \`${item.approvalId}\``,
      `Accepted QA item ${index + 1}; autoApply=false.`,
    ].join("\n")),
    "## Abgelehnt", "Rejected QA work is excluded.",
    "## Zurückgestellt", "Deferred QA work is excluded.",
  ].join("\n\n")
  const plan = process.env.OPENCODE_DAILY_REVIEW_QA_SNAPSHOT
    ? z.object({ revision: z.number().int().positive(), updatedAt: z.number().finite(), sha256: z.string(), markdown: z.string(), acceptedItems: z.array(z.object({ itemId: z.string(), approvalId: z.string() })) }).parse(
        JSON.parse(readFileSync(process.env.OPENCODE_DAILY_REVIEW_QA_SNAPSHOT, "utf8")),
      )
    : { revision: 11, updatedAt: 100, sha256: createHash("sha256").update(markdown).digest("hex"), markdown, acceptedItems }
  expect(createHash("sha256").update(plan.markdown).digest("hex")).toBe(plan.sha256)
  expect(plan.acceptedItems).toHaveLength(48)
  // Use the host's pure presentation without importing the Effect service graph
  // or depending on a locally installed coordinator adapter.
  const { dailyReviewBuildPrompt, dailyReviewHandoffMarkdown } = await import(
    new URL("../../../core/src/tool/agent-handoff.ts", import.meta.url).href
  ) as {
    dailyReviewBuildPrompt: string
    dailyReviewHandoffMarkdown: (input: typeof plan) => string
  }
  const request = {
    ...handoffRequest(),
    tool: { ...handoffRequest().tool, authorizationScope: "accepted-items-in-plan-snapshot", planDocument: plan },
    surface: {
      version: 1, controlID: "agent-switch-build", title: "Daily Review: all accepted items",
      markdown: dailyReviewHandoffMarkdown(plan),
      controls: [{ id: "implement", type: "button", label: "Authorize all accepted items and switch to build" }],
      actions: [{ id: "handoff", trigger: { event: "click", source: "implement" }, steps: [
        { type: "switchAgentAndPrompt", agent: "build", prompt: dailyReviewBuildPrompt, model: { mode: "planning-model" } },
      ] }],
    },
  }
  const submissions: unknown[] = []
  let dismissed = false
  await setupHandoffPage(page, { questions: () => dismissed ? [] : [request], onQuestionReject: () => { dismissed = true } })
  await page.route(`**/api/session/${sessionID}/switch-agent-and-prompt`, async (route) => {
    submissions.push(route.request().postDataJSON())
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "msg_qa_started" }) })
  })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  const popup = page.locator('[data-component="control-panel-popup"]')
  await expect(popup).toBeVisible()
  await expect(popup).toContainText("all accepted Daily Review items")
  await expect(popup).toContainText("autoApply=false")
  await expect(popup).toContainText("Rejected (Nein), deferred (Später), alternatives")
  await expect(popup).toContainText(`revision ${plan.revision}; updatedAt ${plan.updatedAt}; SHA-256 ${plan.sha256}`)
  for (const item of plan.acceptedItems) {
    await expect(popup).toContainText(item.itemId)
    await expect(popup).toContainText(item.approvalId)
  }
  for (const viewport of [{ width: 1280, height: 900, name: "desktop" }, { width: 390, height: 844, name: "mobile" }]) {
    await page.setViewportSize(viewport)
    await popup.getByRole("heading", { name: "Authorization scope", exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: screenshotPath(`daily-review-48-scope-${viewport.name}.png`), fullPage: true })
    const button = popup.getByRole("button", { name: "Switch to build and implement", exact: true })
    await button.scrollIntoViewIfNeeded()
    await expect(button).toBeVisible()
    const box = await button.boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width)
    await page.screenshot({ path: screenshotPath(`daily-review-48-confirm-${viewport.name}.png`), fullPage: true })
  }
  expect(submissions).toHaveLength(0)
  const submitted = page.waitForResponse(response =>
    response.request().method() === "POST" && response.url() === `${server}/api/session/${sessionID}/switch-agent-and-prompt`,
  )
  await popup.getByRole("button", { name: "Switch to build and implement", exact: true }).click()
  const response = await submitted
  expect(response.status()).toBe(200)
  expect(await response.finished()).toBeNull()
  await expect.poll(() => submissions.length).toBe(1)
  expect(submissions[0]).toMatchObject({ agent: "build", prompt: { text: dailyReviewBuildPrompt } })
  await expect(popup).toHaveCount(0)
  // A live event stream never becomes network-idle. Wait for the lazy timeline.
  await expectAppVisible(page.getByText("Plan this", { exact: true }))
  await page.reload()
  await expectAppVisible(page.getByRole("heading", { name: "Agent handoff" }))
  await expectAppVisible(page.getByText("Plan this", { exact: true }))
  await expect(popup).toHaveCount(0)
  expect(submissions).toHaveLength(1)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.screenshot({ path: screenshotPath("daily-review-same-agent-confirmed.png"), fullPage: true })
  expectNoSmokeErrors(errors, [], [])
  expect(failures.filter((failure) => !isExpectedAbortedBackgroundRequest(failure))).toEqual([])
})

test("a confirmed same-route handoff switches the composer agent and chain exactly once", async ({ page }) => {
  const errors = trackPageErrors(page)
  const networkFailures = trackNetworkFailures(page)
  const requests: unknown[] = []
  const extraSwitchRequests: string[] = []
  let handoffDismissed = false
  let releaseSwitch = () => {}
  const switchGate = new Promise<void>((resolve) => {
    releaseSwitch = resolve
  })
  await setupHandoffPage(page, {
    questions: () => handoffDismissed ? [] : [handoffRequest()],
    onQuestionReject: () => {
      handoffDismissed = true
    },
  })
  await page.route(`**/api/session/${sessionID}/switch-agent-and-prompt`, async (route) => {
    requests.push(route.request().postDataJSON())
    await switchGate
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "msg_started" }) })
  })
  page.on("request", (request) => {
    if (request.method() !== "POST") return
    const url = new URL(request.url())
    if (url.pathname.endsWith("/switch-agent-and-prompt")) return
    if (url.pathname.includes("switch-agent") || url.pathname.includes("switch-model"))
      extraSwitchRequests.push(`${request.method()} ${url.pathname}`)
  })

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  const agentTrigger = page.locator('[data-action="prompt-agent"]')
  const modelControl = page.locator('[data-component="composer-model-control"]')
  const modelTrigger = modelControl.locator('[data-action="prompt-model"]')
  await expect(agentTrigger).toBeVisible()
  await expect(modelControl).toContainText("GPT Test")

  const popup = page.locator('[data-component="control-panel-popup"]')
  await expect(popup.locator('[data-component="agent-handoff"]')).toBeVisible()
  await popup.getByRole("button", { name: "Switch to build and implement" }).click()

  // While the atomic switch request is in flight, this session's pickers are locked.
  await expect(agentTrigger).toBeDisabled()
  await expect(modelTrigger).toHaveAttribute("aria-disabled", "true")

  releaseSwitch()
  await expect.poll(() => requests.length).toBe(1)
  await expect(popup).toHaveCount(0)

  // The composer now shows exactly the confirmed selection, not the agent default re-resolved.
  await expect(modelControl).toContainText("GLM Chain")
  await expect(agentTrigger).toContainText("build")
  await expect(agentTrigger).toBeEnabled()
  await expect(modelTrigger).not.toHaveAttribute("aria-disabled", "true")
  expect(extraSwitchRequests).toEqual([])

  await page.setViewportSize({ width: 1280, height: 720 })
  await test.info().attach("agent-handoff-composer-selection-desktop", {
    body: await page.screenshot({ path: screenshotPath("agent-handoff-composer-selection-desktop.png"), fullPage: true }),
    contentType: "image/png",
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await test.info().attach("agent-handoff-composer-selection-mobile", {
    body: await page.screenshot({ path: screenshotPath("agent-handoff-composer-selection-mobile.png"), fullPage: true }),
    contentType: "image/png",
  })
  expectNoSmokeErrors(errors, [], [])
  expect(
    networkFailures.every((failure) => isExpectedAbortedBackgroundRequest(failure)),
  ).toBe(true)
})

async function setupHandoffPage(page: Page, options: HandoffMockOptions) {
  await mockOpenCodeServer(page, {
    port: serverPort,
    directory,
    project: { id: projectID, worktree: directory, vcs: "git", name: "agent-handoff", time: { created: 1, updated: 1 }, sandboxes: [] },
    provider: {
      all: [{ id: "opencode", name: "OpenCode", models: {
        "composer-test": { id: "composer-test", name: "Composer Test", limit: { context: 32_000 } },
        "gpt-test": { id: "gpt-test", name: "GPT Test", limit: { context: 32_000 }, variants: { high: {} } },
        "glm-test": { id: "glm-test", name: "GLM Test", limit: { context: 32_000 } },
        "fallback-test": { id: "fallback-test", name: "Fallback Test", limit: { context: 32_000 } },
      } }],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "composer-test" },
    },
    agents: [{ name: "build", mode: "primary", model: { providerID: "opencode", modelID: "gpt-test" } }],
    sessions: [
      { id: sessionID, slug: sessionID, projectID, directory, title: "Agent handoff", agent: "build", version: "dev", time: { created: 1, updated: 1 } },
      { id: otherSessionID, slug: otherSessionID, projectID, directory, title: "Other session", version: "dev", time: { created: 1, updated: 1 } },
    ],
    pageMessages: (requestedSessionID) => ({ items: requestedSessionID === sessionID ? messages() : [] }),
    globalConfig: () => ({
      model_chains: [{
        id: "glm-chain",
        name: "GLM Chain",
        steps: [
          { providerID: "opencode", modelID: "glm-test" },
          { providerID: "opencode", modelID: "fallback-test" },
        ],
      }],
      default_model_chain: "glm-chain",
    }),
    questions: options.questions,
    onQuestionReject: options.onQuestionReject,
  })
  await page.addInitScript(({ directory, encoded, server, sessionTabs }) => {
    localStorage.setItem("settings.v3", JSON.stringify({}))
    localStorage.setItem("opencode.global.dat:server", JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] }, lastProject: { local: directory } }))
    localStorage.setItem(
      "opencode.global.dat:tabs",
      JSON.stringify(sessionTabs.map((sessionId) => ({ type: "session", server, dirBase64: encoded, sessionId }))),
    )
  }, { directory, encoded: base64Encode(directory), server, sessionTabs: options.sessionTabs ?? [sessionID] })
}

function handoffRequest() {
  return {
    id: "que_agent_handoff",
    sessionID,
    revision: 1,
    mode: "interactive",
    tool: {
      name: "switch_agent",
      confirmationToken: "confirm-agent-handoff",
      purpose: "daily_review_implementation",
      planDocument: {
        revision: 7,
        updatedAt: 100,
        sha256: createHash("sha256").update("Daily Review").digest("hex"),
        markdown: "Daily Review",
      },
      messageID: "msg_assistant_handoff",
      callID: "call_handoff",
    },
    actions: [{ id: "handoff", path: "actions[0]", permissions: [{ action: "session.switch_agent", resources: ["build"] }] }],
    surface: handoffSurface(),
  }
}

function messages() {
  const user = "msg_user_handoff"
  const assistant = "msg_assistant_handoff"
  return [
    { info: { id: user, sessionID, role: "user", time: { created: 1 }, summary: { diffs: [] }, agent: "build", model: { providerID: "opencode", modelID: "gpt-test" } }, parts: [{ id: "prt_user", sessionID, messageID: user, type: "text", text: "Plan this" }] },
    { info: { id: assistant, sessionID, role: "assistant", time: { created: 2, completed: 3 }, parentID: user, modelID: "gpt-test", providerID: "opencode", variant: "high", mode: "build", agent: "build", path: { cwd: directory, root: directory }, cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "stop" }, parts: [{ id: "prt_handoff", sessionID, messageID: assistant, type: "custom", kind: "opencode/control-panel", title: "Implementation handoff", fallback: "Implement approved plan", data: handoffSurface() }],
    },
  ]
}

function handoffSurface() {
  return { version: 1, controlID: "handoff", title: "Implementation handoff", controls: [
      { id: "implement", type: "button", label: "Save harmless preferences" },
      { id: "unsafe", type: "button", label: "Unsafe mixed handoff" },
    ], actions: [
      { id: "handoff", trigger: { event: "click", source: "implement" }, steps: [{ type: "switchAgentAndPrompt", agent: "build", prompt: "Implement the approved session plan.", model: { mode: "planning-model" } }] },
      { id: "unsafe", trigger: { event: "click", source: "unsafe" }, steps: [
        { type: "setValue", target: "values.started", value: "true" },
        { type: "switchAgentAndPrompt", agent: "build", prompt: "Must not run.", model: { mode: "planning-model" } },
      ] },
    ] }
}
