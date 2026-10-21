import { expect, test, type Page, type Request } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectNoSmokeErrors, trackPageErrors } from "../utils/errors"
import { expectAppVisible } from "../utils/waits"

test.use({ video: "on", screenshot: "on" })

const directory = "C:/OpenCode/MultiServerCollision"
const sessionID = "ses_shared_collision"
const serverA = "http://127.0.0.1:4096"
const serverB = "http://127.0.0.1:4097"
const titleA = "Server A collision title"
const titleB = "Server B collision title"
const provider = {
  all: [
    {
      id: "opencode",
      name: "OpenCode",
      models: {
        "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
      },
    },
  ],
  connected: ["opencode"],
  default: { providerID: "opencode", modelID: "claude-opus-4-6" },
}

type SessionRequest = {
  server: "A" | "B"
  method: string
  path: string
  body?: unknown
}

test("inactive dock title, avatar state, and prefetch come from the tab server", async ({ page }) => {
  const errors = trackPageErrors(page)
  const requests = await setup(page)

  const tabA = page.getByRole("tab", { name: new RegExp(titleA) })
  const tabB = page.getByRole("tab", { name: new RegExp(titleB) })
  await expectAppVisible(tabA)
  await expectAppVisible(tabB)
  await expect(tabA.locator('[data-component="project-avatar-v2"]')).toHaveAttribute("data-unread", "")
  await expect(tabB.locator('[data-component="project-avatar-v2"]')).not.toHaveAttribute("data-unread", "")
  await expect(tabA.locator('[data-slot="project-avatar-loader"]')).toHaveCount(0)
  await expect
    .poll(() => requests.some((request) => request.server === "B" && request.method === "GET" && request.path === "/session/status"))
    .toBe(true)
  const runningIndicator = tabB.locator('[data-slot="project-avatar-loader"]')
  await expectAppVisible(runningIndicator)
  expect(await runningIndicator.evaluate((element) => element.getAnimations({ subtree: true }).length)).toBe(0)
  expect(
    requests.some(
      (request) => request.server === "B" && request.method === "GET" && request.path === `/session/${sessionID}`,
    ),
  ).toBe(true)
  expectNoSmokeErrors(errors, [], [])
})

test("copies the selected dock Session ID", async ({ page, context }) => {
  const errors = trackPageErrors(page)
  await context.grantPermissions(["clipboard-read", "clipboard-write"])
  await setup(page)
  await openServerBActions(page)
  await page.screenshot({ path: "test-results/session-id-copy-menu-desktop.png" })
  await page.getByRole("menuitem", { name: "Copy session ID" }).click()

  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(sessionID)
  await expectAppVisible(page.getByText("Copied", { exact: true }))
  await page.setViewportSize({ width: 800, height: 844 })
  await page.locator(`[data-action="session-tab-menu"][data-session-id="${sessionID}"]:visible`).last().click()
  await expectAppVisible(page.getByRole("menuitem", { name: "Copy session ID" }))
  await page.screenshot({ path: "test-results/session-id-copy-menu-narrow.png" })
  expectNoSmokeErrors(errors, [], [])
})

test("dock overflow and context menus share bulk close actions", async ({ page }) => {
  const errors = trackPageErrors(page)
  await page.setViewportSize({ width: 1600, height: 900 })
  await setup(page)
  const middle = page.locator('[data-dock-area="middle"]')
  const dockTab = middle.locator("[data-dock-tab]").filter({
    has: page.getByRole("tab", { name: new RegExp(titleA) }),
  })
  await dockTab.locator('[data-action="session-tab-menu"]').click()
  const overflowItems = await page.locator('[role="menu"]:visible').getByRole("menuitem").allTextContents()
  await expect(page.getByRole("menuitem", { name: "Close All to Left" })).toBeDisabled()
  await expect(page.getByRole("menuitem", { name: "Close All to Right" })).toBeEnabled()
  await expect(page.getByRole("menuitem", { name: "Close All but This" })).toBeEnabled()
  await page.keyboard.press("Escape")

  const contextTab = middle.locator("[data-dock-tab]").filter({
    has: page.getByRole("tab", { name: new RegExp(titleB) }),
  })
  await contextTab.getByRole("tab").click()
  await contextTab.click({ button: "right" })
  const contextItems = await page.locator('[role="menu"]:visible').getByRole("menuitem").allTextContents()
  expect(contextItems).toEqual(overflowItems)
  expect(contextItems).toEqual([
    "Rename",
    "Add to favorites",
    "Copy session ID",
    "Close All Tabs",
    "Close All to Left",
    "Close All to Right",
    "Close All but This",
    "Archive",
    "Delete",
  ])
  await page.screenshot({ path: "test-results/session-dock-context-menu.png" })
  await page.keyboard.press("Escape")
  await page.setViewportSize({ width: 800, height: 844 })
  await contextTab.locator('[data-action="session-tab-menu"]').click()
  await expectAppVisible(page.getByRole("menuitem", { name: "Close All Tabs" }))
  await page.screenshot({ path: "test-results/session-dock-menu-narrow.png" })
  expectNoSmokeErrors(errors, [], [])
})

for (const scenario of [
  { action: "Close All to Left", target: titleB, remaining: [titleB] },
  { action: "Close All to Right", target: titleA, remaining: [titleA] },
  { action: "Close All but This", target: titleB, remaining: [titleB] },
  { action: "Close All Tabs", target: titleB, remaining: [] },
]) {
  test(`${scenario.action} only closes tabs in the middle dock area`, async ({ page }) => {
    const errors = trackPageErrors(page)
    await setup(page)
    const middle = page.locator('[data-dock-area="middle"]')
    const otherTabsBefore = await page
      .locator('[data-dock-area]:not([data-dock-area="middle"]) [data-dock-tab]')
      .evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute("data-dock-tab")))
    await middle
      .locator("[data-dock-tab]")
      .filter({ has: page.getByRole("tab", { name: new RegExp(scenario.target) }) })
      .click({ button: "right" })
    await page.getByRole("menuitem", { name: scenario.action }).click()

    for (const title of [titleA, titleB]) {
      const tab = middle.getByRole("tab", { name: new RegExp(title) })
      if (scenario.remaining.includes(title)) await expectAppVisible(tab)
      if (!scenario.remaining.includes(title)) await expect(tab).toHaveCount(0)
    }
    expect(
      await page
        .locator('[data-dock-area]:not([data-dock-area="middle"]) [data-dock-tab]')
        .evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute("data-dock-tab"))),
    ).toEqual(otherTabsBefore)
    expectNoSmokeErrors(errors, [], [])
  })
}

test("falls back when the Clipboard API is unavailable", async ({ page }) => {
  const errors = trackPageErrors(page)
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "clipboard", { configurable: true, get: () => undefined })
    document.execCommand = () => {
      ;(globalThis as unknown as { copiedSessionID?: string }).copiedSessionID = (
        document.activeElement as HTMLTextAreaElement
      ).value
      return true
    }
  })
  await setup(page)
  await openServerBActions(page)
  await page.getByRole("menuitem", { name: "Copy session ID" }).click()

  await expect.poll(() => page.evaluate(() => (globalThis as { copiedSessionID?: string }).copiedSessionID)).toBe(sessionID)
  await expectAppVisible(page.getByText("Copied", { exact: true }))
  expectNoSmokeErrors(errors, [], [])
})

test("renaming the inactive server B tab never patches server A", async ({ page }) => {
  const errors = trackPageErrors(page)
  const requests = await setup(page)
  await openServerBActions(page)
  await page.getByRole("menuitem", { name: "Rename" }).click()
  const dialog = page.getByRole("dialog", { name: "Rename session" })
  await dialog.getByRole("textbox", { name: "Session title" }).fill("Renamed on B")
  await dialog.getByRole("button", { name: "Save" }).click()

  await expect.poll(() => mutations(requests, "B", "PATCH").length).toBe(1)
  expect(mutations(requests, "A", "PATCH")).toEqual([])
  expect(mutations(requests, "B", "PATCH")[0]?.body).toEqual({ title: "Renamed on B" })
  await expect(dialog).toHaveCount(0)
  await expectAppVisible(page.getByRole("tab", { name: /Renamed on B/ }))
  expectNoSmokeErrors(errors, [], [])
})

test("archiving the inactive server B tab never patches or closes server A", async ({ page }) => {
  const errors = trackPageErrors(page)
  const requests = await setup(page)
  await openServerBActions(page)
  await page.getByRole("menuitem", { name: "Archive" }).click()

  await expect.poll(() => mutations(requests, "B", "PATCH").length).toBe(1)
  expect(mutations(requests, "A", "PATCH")).toEqual([])
  expect(mutations(requests, "B", "PATCH")[0]?.body).toMatchObject({ time: { archived: expect.any(Number) } })
  await expectAppVisible(page.getByRole("tab", { name: new RegExp(titleA) }))
  await expect(page.getByRole("tab", { name: new RegExp(titleB) })).toHaveCount(0)
  expectNoSmokeErrors(errors, [], [])
})

test("deleting the inactive server B tab never deletes or closes server A", async ({ page }) => {
  const errors = trackPageErrors(page)
  const requests = await setup(page)
  await openServerBActions(page)
  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("menuitem", { name: "Delete" }).click()

  await expect.poll(() => mutations(requests, "B", "DELETE").length).toBe(1)
  expect(mutations(requests, "A", "DELETE")).toEqual([])
  await expectAppVisible(page.getByRole("tab", { name: new RegExp(titleA) }))
  await expect(page.getByRole("tab", { name: new RegExp(titleB) })).toHaveCount(0)
  expectNoSmokeErrors(errors, [], [])
})

async function setup(page: Page) {
  const requests: SessionRequest[] = []
  page.on("request", (request) => recordSessionRequest(request, requests))

  await mockOpenCodeServer(page, {
    port: "4096",
    directory,
    project: project("project-a", "Project A"),
    provider,
    sessions: [session(titleA, "project-a")],
    onSessionCreate: () => session("New session A", "project-a", "ses_new_server_a"),
    onSessionUpdate: ({ body }) => updatedSession(body, titleA, "project-a"),
    pageMessages: () => ({ items: [] }),
    questions: () => [question()],
    sessionStatus: { [sessionID]: { type: "idle" } },
  })
  await mockOpenCodeServer(page, {
    port: "4097",
    directory,
    project: project("project-b", "Project B"),
    provider,
    sessions: [session(titleB, "project-b")],
    onSessionCreate: () => session("New session B", "project-b", "ses_new_server_b"),
    onSessionUpdate: ({ body }) => updatedSession(body, titleB, "project-b"),
    pageMessages: () => ({ items: [] }),
    sessionStatus: { [sessionID]: { type: "busy" } },
  })

  await page.addInitScript(
    ({ directory, dirBase64, serverA, serverB, sessionID }) => {
      localStorage.setItem(
        "settings.v3",
        JSON.stringify({ optimizations: { optimizationProfile: "speed", sessionTabPrefetch: true } }),
      )
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          list: [{ type: "http", http: { url: serverB }, displayName: "Server B" }],
          projects: {
            local: [{ worktree: directory, expanded: true }],
            [serverB]: [{ worktree: directory, expanded: true }],
          },
          lastProject: { local: directory, [serverB]: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([
          { type: "session", server: serverA, dirBase64, sessionId: sessionID },
          { type: "session", server: serverB, dirBase64, sessionId: sessionID },
        ]),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs.recent",
        JSON.stringify({ key: `${serverA}\n${dirBase64}\n${sessionID}` }),
      )
    },
    { directory, dirBase64: base64Encode(directory), serverA, serverB, sessionID },
  )

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectAppVisible(page.locator('[data-component="session-composer"]'))
  await expectAppVisible(page.getByRole("tab", { name: new RegExp(titleB) }))
  return requests
}

async function openServerBActions(page: Page) {
  const tab = page.getByRole("tab", { name: new RegExp(titleB) })
  await page.locator("[data-dock-tab]").filter({ has: tab }).locator('[data-action="session-tab-menu"]').click()
}

function mutations(requests: SessionRequest[], server: "A" | "B", method: "PATCH" | "DELETE") {
  return requests.filter((request) => request.server === server && request.method === method)
}

function recordSessionRequest(request: Request, requests: SessionRequest[]) {
  const url = new URL(request.url())
  if (url.pathname !== `/session/${sessionID}` && url.pathname !== "/session/status") return
  if (url.port !== "4096" && url.port !== "4097") return
  const text = request.postData()
  requests.push({
    server: url.port === "4096" ? "A" : "B",
    method: request.method(),
    path: url.pathname,
    ...(text ? { body: JSON.parse(text) as unknown } : {}),
  })
}

function project(id: string, name: string) {
  return {
    id,
    worktree: directory,
    vcs: "git",
    name,
    time: { created: 1700000000000, updated: 1700000000000 },
    sandboxes: [],
  }
}

function session(title: string, projectID: string, id = sessionID) {
  return {
    id,
    slug: id,
    projectID,
    directory,
    title,
    version: "dev",
    time: { created: 1700000000000, updated: 1700000000000 },
  }
}

function updatedSession(body: unknown, fallbackTitle: string, projectID: string) {
  const title =
    typeof body === "object" && body !== null && "title" in body && typeof body.title === "string"
      ? body.title
      : fallbackTitle
  return session(title, projectID)
}

function question() {
  return {
    id: "que_server_a_collision",
    sessionID,
    questions: [
      {
        header: "Server A",
        question: "Keep this question scoped to server A?",
        options: [{ label: "Yes", description: "The server A tab remains unread" }],
      },
    ],
  }
}
