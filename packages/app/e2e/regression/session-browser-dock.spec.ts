import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/SessionBrowserDock"
const projectID = "proj_session_browser_dock"
const sessionID = "ses_session_browser_dock"
const server = "http://127.0.0.1:4096"

test("browser dock is prepared through the bridge and controlled by Playwright", async ({ page }) => {
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  const failedRequests: string[] = []
  const badResponses: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })
  page.on("pageerror", (error) => pageErrors.push(error.message))
  page.on("requestfailed", (request) => {
    if (request.url().startsWith("http://localhost:3000")) failedRequests.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "failed"}`)
  })
  page.on("response", (response) => {
    if (response.url().startsWith("http://localhost:3000") && response.status() >= 400) badResponses.push(`${response.status()} ${response.url()}`)
  })

  await page.route("http://localhost:3000/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: [
        "<!doctype html>",
        "<title>Browser target</title>",
        "<style>html,body{margin:0;min-height:100%;font-family:system-ui,sans-serif}main{min-height:1200px;padding:28px;background:linear-gradient(180deg,#ff5f6d 0%,#ffc371 32%,#47e5bc 66%,#6a7dff 100%);color:#111}.card{margin:24px 0;padding:18px;border:4px solid #111;background:rgba(255,255,255,.82);border-radius:16px}</style>",
        "<main><h1>Browser target</h1>",
        "<section class=\"card\"><label>Market note <input aria-label=\"Market note\" /></label>",
        "<button type=\"button\">Apply note</button>",
        "<output role=\"status\">Waiting</output></section>",
        "<section class=\"card\"><h2>Visible height marker</h2><p>This colorful page makes a too-short embedded browser obvious.</p></section>",
        "<section class=\"card\"><h2>More content</h2><p>The gradient continues below the fold so clipping is easy to spot.</p></section></main>",
        "<script>",
        "document.querySelector('button').addEventListener('click', () => {",
        "document.querySelector('output').textContent = document.querySelector('input').value",
        "})",
        "</script>",
      ].join(""),
    }),
  )
  await mockOpenCodeServer(page, {
    directory,
    project: project(),
    provider: provider(),
    sessions: [session()],
    pageMessages: () => ({ items: [] }),
  })
  await configurePage(page)

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)

  await expectAppVisible(page.locator('[data-dock-area="right"] [data-dock-tab="review"]'))
  await expectAppVisible(page.locator('[data-dock-area="right"] [data-dock-tab="browser"]'))
  // The Browser pane is keepAlive: it stays mounted (hidden) even while Review
  // is the active tab, so switching tabs must not reload it later.
  await expect(page.locator('[data-component="session-browser-dock"]')).toBeHidden()
  const tabId = await openBrowserDock(page, "localhost:3000")
  const frameSelector = `[data-slot="browser-frame"][data-tab-id="${tabId}"]`

  await expect(page.locator('[data-dock-area="right"] [data-dock-tab="browser"] [role="tab"]')).toHaveAttribute(
    "aria-selected",
    "true",
  )
  await expectAppVisible(page.locator('[data-component="session-browser-dock"]'))
  await expect(page.locator('[data-slot="browser-url"]')).toHaveValue("http://localhost:3000/")
  await expect(page.locator(frameSelector)).toHaveAttribute("src", "http://localhost:3000/")
  const frame = page.frameLocator(frameSelector)
  await expect(frame.getByRole("heading", { name: "Browser target" })).toBeVisible()
  const frameRect = await page.locator(frameSelector).boundingBox()
  const slotRect = await page.locator('[data-slot="browser-frame-slot"]').boundingBox()
  if (!frameRect || !slotRect) throw new Error("Browser frame or slot is not visible")
  expect(frameRect.height).toBeGreaterThan(400)
  expect(Math.abs(frameRect.height - slotRect.height)).toBeLessThanOrEqual(1)
  await frame.getByLabel("Market note").fill("festival qa")
  await frame.getByRole("button", { name: "Apply note" }).click()
  await expect(frame.getByRole("status")).toHaveText("festival qa")

  await desktopAction(page, { type: "dock.setActive", area: "right", tab: "review" })
  await expect(page.locator('[data-dock-area="right"] [data-dock-tab="review"] [role="tab"]')).toHaveAttribute(
    "aria-selected",
    "true",
  )
  // keepAlive: dock stays mounted but is hidden while Review is active.
  await expect(page.locator('[data-component="session-browser-dock"]')).toHaveCount(1)
  await expect(page.locator('[data-component="session-browser-dock"]')).toBeHidden()

  await desktopAction(page, { type: "dock.setActive", area: "right", tab: "browser" })
  await expect(page.locator('[data-dock-area="right"] [data-dock-tab="browser"] [role="tab"]')).toHaveAttribute(
    "aria-selected",
    "true",
  )
  await expectAppVisible(page.locator('[data-component="session-browser-dock"]'))
  await expect(page.locator('[data-slot="browser-url"]')).toHaveValue("http://localhost:3000/")
  await expect(page.locator(frameSelector)).toHaveAttribute("src", "http://localhost:3000/")
  // The frame was not reloaded by the tab round-trip: the in-page state from
  // before the switch must still be present.
  const frameAfterSwitch = page.frameLocator(frameSelector)
  await expect(frameAfterSwitch.getByRole("status")).toHaveText("festival qa")

  await desktopAction(page, { type: "dock.setActive", area: "right", tab: "missing" })
  await expect(page.locator('[data-dock-area="right"] [data-dock-tab="browser"] [role="tab"]')).toHaveAttribute(
    "aria-selected",
    "true",
  )
  await expect.poll(async () => ((await desktopAction<BrowserStatus>(page, { type: "browser.status" })).dock.active)).toBe(true)

  expect(consoleErrors).toEqual([])
  expect(pageErrors).toEqual([])
  expect(failedRequests).toEqual([])
  expect(badResponses).toEqual([])
  await page.screenshot({ path: "e2e/test-results/session-browser-dock-playwright.png", fullPage: true })
})

test("browser.open reveals the dock where it already lives instead of forcing it to the right", async ({ page }) => {
  const directory = "C:/OpenCode/SessionBrowserDockPlacement"
  const projectID = "proj_session_browser_dock_placement"
  const sessionID = "ses_session_browser_dock_placement"

  await page.route("http://localhost:3000/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>x</title><h1>ok</h1>" }))
  await mockOpenCodeServer(page, {
    directory,
    project: { id: projectID, worktree: directory, vcs: "git", name: "placement", time: { created: 1700000000000, updated: 1700000000000 }, sandboxes: [] },
    provider: provider(),
    sessions: [
      { id: sessionID, slug: sessionID, projectID, directory, title: "placement", version: "dev", time: { created: 1700000000000, updated: 1700000000000 } },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript(
    ({ directory, dirBase64, sessionID, server }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem("opencode.global.dat:server", JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] }, lastProject: { local: directory } }))
      localStorage.setItem("opencode.global.dat:tabs", JSON.stringify([{ type: "session", server, dirBase64, sessionId: sessionID }]))
      // Browser dock lives in the BOTTOM area, not the right.
      localStorage.setItem(
        "opencode.global.dat:layout",
        JSON.stringify({
          dock: {
            schema: 2,
            right: { visible: true, size: 520, tabs: ["review"], active: "review" },
            bottom: { visible: true, size: 280, tabs: ["terminal", "browser"], active: "terminal" },
            items: {
              session: { area: "middle", visible: true },
              review: { area: "right", visible: true },
              terminal: { area: "bottom", visible: true },
              browser: { area: "bottom", visible: true },
            },
          },
        }),
      )
    },
    { directory, dirBase64: base64Encode(directory), sessionID, server },
  )

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectAppVisible(page.locator('[data-dock-area="bottom"] [data-dock-tab="browser"]'))

  await desktopAction(page, { type: "browser.open", url: "localhost:3000" })

  // The Browser dock must stay in the bottom area and become active there; it
  // must NOT have been moved into the right dock.
  await expect(page.locator('[data-dock-area="bottom"] [data-dock-tab="browser"]')).toBeVisible()
  await expect(page.locator('[data-dock-area="bottom"] [data-dock-tab="browser"] [role="tab"]')).toHaveAttribute(
    "aria-selected",
    "true",
  )
  await expect(page.locator('[data-dock-area="right"] [data-dock-tab="browser"]')).toHaveCount(0)
  const status = await desktopAction<{ dock: { area: string; active: boolean } }>(page, { type: "browser.status" })
  expect(status.dock.area).toBe("bottom")
  expect(status.dock.active).toBe(true)
})

test("browser webview is not reloaded when switching between session tabs", async ({ page }) => {
  const directory = "C:/OpenCode/SessionBrowserDockSwitch"
  const projectID = "proj_session_browser_dock_switch"
  const sessionA = "ses_session_browser_dock_a"
  const sessionB = "ses_session_browser_dock_b"

  await page.route("http://localhost:3000/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: [
        "<!doctype html><title>x</title><h1>Browser target</h1>",
        "<label>N <input aria-label='Market note' /></label>",
        "<button type='button'>Apply note</button>",
        "<output role='status'>Waiting</output>",
        "<script>document.querySelector('button').addEventListener('click',()=>{document.querySelector('output').textContent=document.querySelector('input').value})</script>",
      ].join(""),
    }),
  )
  await mockOpenCodeServer(page, {
    directory,
    project: { id: projectID, worktree: directory, vcs: "git", name: "switch", time: { created: 1, updated: 1 }, sandboxes: [] },
    provider: provider(),
    sessions: [
      { id: sessionA, slug: sessionA, projectID, directory, title: "A", version: "dev", time: { created: 1, updated: 1 } },
      { id: sessionB, slug: sessionB, projectID, directory, title: "B", version: "dev", time: { created: 1, updated: 1 } },
    ],
    pageMessages: () => ({ items: [] }),
  })
  const dirBase64 = base64Encode(directory)
  await page.addInitScript(
    ({ directory, dirBase64, sessionA, sessionB, server }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem("opencode.global.dat:server", JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] }, lastProject: { local: directory } }))
      // Two open session tabs; first (A) is active initially.
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([
          { type: "session", server, dirBase64, sessionId: sessionA },
          { type: "session", server, dirBase64, sessionId: sessionB },
        ]),
      )
      localStorage.setItem(
        "opencode.global.dat:layout",
        JSON.stringify({
          dock: {
            schema: 2,
            right: { visible: true, size: 520, tabs: ["review", "browser"], active: "browser" },
            items: { session: { area: "middle", visible: true }, review: { area: "right", visible: true }, browser: { area: "right", visible: true } },
          },
        }),
      )
    },
    { directory, dirBase64, sessionA, sessionB, server },
  )
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${dirBase64}/session/${sessionA}`)
  await expectAppVisible(page.locator('[data-dock-area="right"] [data-dock-tab="browser"]'))

  const tabId = (
    await desktopAction<{ browser: { tabId: string } }>(page, { type: "browser.open", url: "localhost:3000" })
  ).browser.tabId
  const frameSelector = `[data-slot="browser-frame"][data-tab-id="${tabId}"]`
  const frame = page.frameLocator(frameSelector)
  await expect(frame.getByRole("heading", { name: "Browser target" })).toBeVisible()
  await frame.getByLabel("Market note").fill("festival qa")
  await frame.getByRole("button", { name: "Apply note" }).click()
  await expect(frame.getByRole("status")).toHaveText("festival qa")

  // Switch to session B and back to A through the desktop bridge (same path an
  // agent's browser.open takes). The Session subtree remounts on this switch;
  // the embedded page must NOT reload, so the in-page state must survive.
  await desktopAction(page, { type: "session.open", sessionID: sessionB, directory })
  await desktopAction(page, { type: "session.open", sessionID: sessionA, directory })

  const frameAfterSwitch = page.frameLocator(frameSelector)
  await expect(frameAfterSwitch.getByRole("status")).toHaveText("festival qa")

  // The persistent overlay must sit over the right-dock browser pane, not at the
  // top-left origin. Verify alignment between the overlay frame and the slot.
  const alignment = await page.evaluate((selector) => {
    const frame = document.querySelector(selector) as HTMLElement | null
    const slot = document.querySelector('[data-slot="browser-frame-slot"]') as HTMLElement | null
    const dock = document.querySelector('[data-dock-area="right"]') as HTMLElement | null
    if (!frame || !slot || !dock) return null
    const f = frame.getBoundingClientRect()
    const s = slot.getBoundingClientRect()
    const d = dock.getBoundingClientRect()
    return {
      frame: { x: Math.round(f.x), y: Math.round(f.y), w: Math.round(f.width), h: Math.round(f.height) },
      slot: { x: Math.round(s.x), y: Math.round(s.y), w: Math.round(s.width), h: Math.round(s.height) },
      withinDock: f.x >= d.x - 2 && f.y >= d.y - 2 && f.right <= d.right + 2 && f.bottom <= d.bottom + 2,
      matchesSlot: Math.abs(f.x - s.x) <= 2 && Math.abs(f.y - s.y) <= 2 && Math.abs(f.width - s.width) <= 2 && Math.abs(f.height - s.height) <= 2,
    }
  }, frameSelector)
  expect(alignment?.withinDock).toBe(true)
  expect(alignment?.matchesSlot).toBe(true)

  await page.screenshot({ path: "e2e/test-results/session-browser-dock-session-switch.png", fullPage: true })
})

test("browser dock supports multiple sub-tabs that each keep their page state", async ({ page }) => {
  const directory = "C:/OpenCode/SessionBrowserDockTabs"
  const projectID = "proj_session_browser_dock_tabs"
  const sessionID = "ses_session_browser_dock_tabs"

  await page.route("http://localhost:3000/**", (route) => {
    const path = new URL(route.request().url()).pathname
    const heading = path === "/b" ? "Browser target B" : "Browser target A"
    const body = [
      "<!doctype html><title>x</title>",
      `<h1>${heading}</h1>`,
      "<label>Note <input aria-label='Market note' /></label>",
      "<button type='button'>Apply note</button>",
      "<output role='status'>Waiting</output>",
      "<script>document.querySelector('button').addEventListener('click',()=>{document.querySelector('output').textContent=document.querySelector('input').value})</script>",
    ].join("")
    return route.fulfill({ status: 200, contentType: "text/html", body })
  })
  await mockOpenCodeServer(page, {
    directory,
    project: { id: projectID, worktree: directory, vcs: "git", name: "tabs", time: { created: 1, updated: 1 }, sandboxes: [] },
    provider: provider(),
    sessions: [{ id: sessionID, slug: sessionID, projectID, directory, title: "tabs", version: "dev", time: { created: 1, updated: 1 } }],
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript(
    ({ directory, dirBase64, sessionID, server }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem("opencode.global.dat:server", JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] }, lastProject: { local: directory } }))
      localStorage.setItem("opencode.global.dat:tabs", JSON.stringify([{ type: "session", server, dirBase64, sessionId: sessionID }]))
      localStorage.setItem(
        "opencode.global.dat:layout",
        JSON.stringify({ dock: { schema: 2, right: { visible: true, size: 520, tabs: ["review", "browser"], active: "browser" }, items: { session: { area: "middle", visible: true }, review: { area: "right", visible: true }, browser: { area: "right", visible: true } } } }),
      )
    },
    { directory, dirBase64: base64Encode(directory), sessionID, server },
  )
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectAppVisible(page.locator('[data-dock-area="right"] [data-dock-tab="browser"]'))

  // browser.open opens a NEW sub-tab each call and returns its tabId.
  const tabIdA = (
    await desktopAction<{ browser: { tabId: string } }>(page, { type: "browser.open", url: "localhost:3000/a" })
  ).browser.tabId
  const frameA = page.frameLocator(`[data-slot="browser-frame"][data-tab-id="${tabIdA}"]`)
  await expect(frameA.getByRole("heading", { name: "Browser target A" })).toBeVisible()
  await frameA.getByLabel("Market note").fill("alpha")
  await frameA.getByRole("button", { name: "Apply note" }).click()
  await expect(frameA.getByRole("status")).toHaveText("alpha")

  // Open a second sub-tab and load page B, set state "beta".
  const tabIdB = (
    await desktopAction<{ browser: { tabId: string } }>(page, { type: "browser.open", url: "localhost:3000/b" })
  ).browser.tabId
  const frameB = page.frameLocator(`[data-slot="browser-frame"][data-tab-id="${tabIdB}"]`)
  await expect(frameB.getByRole("heading", { name: "Browser target B" })).toBeVisible()
  await frameB.getByLabel("Market note").fill("beta")
  await frameB.getByRole("button", { name: "Apply note" }).click()
  await expect(frameB.getByRole("status")).toHaveText("beta")

  // Switch back to tab A: page A must still hold "alpha" (no reload).
  await page.locator(`[data-slot="browser-tab"][data-tab-id="${tabIdA}"]`).click()
  await expect(frameA.getByRole("heading", { name: "Browser target A" })).toBeVisible()
  await expect(frameA.getByRole("status")).toHaveText("alpha")

  // Switch to tab B again: page B must still hold "beta".
  await page.locator(`[data-slot="browser-tab"][data-tab-id="${tabIdB}"]`).click()
  await expect(frameB.getByRole("status")).toHaveText("beta")

  await page.screenshot({ path: "e2e/test-results/session-browser-dock-multi-tab.png", fullPage: true })
})

test("agent browser.open opens a new tab and browser.close removes it when done", async ({ page }) => {
  const directory = "C:/OpenCode/SessionBrowserDockAgentClose"
  const projectID = "proj_session_browser_dock_agent_close"
  const sessionID = "ses_session_browser_dock_agent_close"

  await page.route("http://localhost:3000/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>x</title><h1>Agent target</h1>" }),
  )
  await mockOpenCodeServer(page, {
    directory,
    project: { id: projectID, worktree: directory, vcs: "git", name: "agentclose", time: { created: 1, updated: 1 }, sandboxes: [] },
    provider: provider(),
    sessions: [{ id: sessionID, slug: sessionID, projectID, directory, title: "agentclose", version: "dev", time: { created: 1, updated: 1 } }],
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript(
    ({ directory, dirBase64, sessionID, server }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem("opencode.global.dat:server", JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] }, lastProject: { local: directory } }))
      localStorage.setItem("opencode.global.dat:tabs", JSON.stringify([{ type: "session", server, dirBase64, sessionId: sessionID }]))
      localStorage.setItem(
        "opencode.global.dat:layout",
        JSON.stringify({ dock: { schema: 2, right: { visible: true, size: 520, tabs: ["review", "browser"], active: "browser" }, items: { session: { area: "middle", visible: true }, review: { area: "right", visible: true }, browser: { area: "right", visible: true } } } }),
      )
    },
    { directory, dirBase64: base64Encode(directory), sessionID, server },
  )
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectAppVisible(page.locator('[data-dock-area="right"] [data-dock-tab="browser"]'))

  // Agent opens a new tab; browser.close without a tabId must close that tab.
  const opened = await desktopAction<{ browser: { tabId: string } }>(page, { type: "browser.open", url: "localhost:3000" })
  const tabId = opened.browser.tabId
  await expect(page.locator(`[data-slot="browser-tab"][data-tab-id="${tabId}"]`)).toBeVisible()

  const closed = await desktopAction<{ closed: boolean; tabId?: string }>(page, { type: "browser.close" })
  expect(closed.closed).toBe(true)
  expect(closed.tabId).toBe(tabId)
  await expect(page.locator(`[data-slot="browser-tab"][data-tab-id="${tabId}"]`)).toHaveCount(0)
})

test("browser frame fills the dock slot on a mobile viewport", async ({ page }) => {
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  const failedRequests: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })
  page.on("pageerror", (error) => pageErrors.push(error.message))
  page.on("requestfailed", (request) => {
    if (request.url().startsWith("http://localhost:3000")) failedRequests.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "failed"}`)
  })

  await page.route("http://localhost:3000/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>x</title><style>html,body{margin:0;min-height:100%;font-family:system-ui,sans-serif}main{min-height:1000px;padding:20px;background:linear-gradient(180deg,#fd1d1d 0%,#fcb045 35%,#20e3b2 70%,#2f80ed 100%);color:#111}.card{margin:18px 0;padding:16px;border:4px solid #111;background:rgba(255,255,255,.85);border-radius:14px}</style><main><h1>Mobile target</h1><section class='card'><h2>Visible height marker</h2><p>Color fills the whole embedded browser slot.</p></section><section class='card'><h2>More content</h2><p>If the frame shrinks, the colored area makes it obvious.</p></section></main>",
    }),
  )
  await mockOpenCodeServer(page, {
    directory,
    project: project(),
    provider: provider(),
    sessions: [session()],
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript(
    ({ directory, dirBase64, sessionID, server }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem("opencode.global.dat:server", JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] }, lastProject: { local: directory } }))
      localStorage.setItem("opencode.global.dat:tabs", JSON.stringify([{ type: "session", server, dirBase64, sessionId: sessionID }]))
      localStorage.setItem(
        "opencode.global.dat:layout",
        JSON.stringify({ dock: { schema: 2, bottom: { visible: true, size: 400, tabs: ["browser"], active: "browser" }, items: { session: { area: "middle", visible: true }, browser: { area: "bottom", visible: true } } } }),
      )
    },
    { directory, dirBase64: base64Encode(directory), sessionID, server },
  )

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  const tabId = await openBrowserDock(page, "localhost:3000")
  await expectAppVisible(page.locator('[data-component="session-browser-dock"]'))

  const frameSelector = `[data-slot="browser-frame"][data-tab-id="${tabId}"]`
  await expect(page.frameLocator(frameSelector).getByRole("heading", { name: "Mobile target" })).toBeVisible()
  const frameRect = await page.locator(frameSelector).boundingBox()
  const slotRect = await page.locator('[data-slot="browser-frame-slot"]').boundingBox()
  if (!frameRect || !slotRect) throw new Error("Browser frame or slot is not visible")
  expect(frameRect.height).toBeGreaterThan(200)
  expect(Math.abs(frameRect.height - slotRect.height)).toBeLessThanOrEqual(1)
  expect(consoleErrors).toEqual([])
  expect(pageErrors).toEqual([])
  expect(failedRequests).toEqual([])

  await page.screenshot({ path: "e2e/test-results/session-browser-dock-mobile.png", fullPage: true })
})

type DesktopTestingAction =
  | { type: "browser.open"; url: string }
  | { type: "browser.navigate"; url: string }
  | { type: "browser.close"; tabId?: string }
  | { type: "browser.status" }
  | { type: "dock.setActive"; area: "right"; tab?: string }
  | { type: "session.open"; sessionID: string; directory?: string }

type BrowserStatus = { dock: { active: boolean } }

async function openBrowserDock(page: Page, url: string): Promise<string> {
  const result = await desktopAction<{ browser: { tabId: string } }>(page, { type: "browser.open", url })
  return result.browser.tabId
}

async function desktopAction<T = unknown>(page: Page, action: DesktopTestingAction) {
  return page.evaluate(async (input) => {
    type DesktopTestingWindow = Window & {
      __OPENCODE__?: {
        desktopTesting?: {
          action(value: DesktopTestingAction): Promise<unknown>
        }
      }
    }
    const bridge = (window as DesktopTestingWindow).__OPENCODE__?.desktopTesting
    if (!bridge) throw new Error("Desktop testing bridge is not mounted")
    return bridge.action(input)
  }, action) as Promise<T>
}

async function configurePage(page: Page) {
  await page.addInitScript(
    ({ directory, dirBase64, sessionID, server }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] }, lastProject: { local: directory } }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", server, dirBase64, sessionId: sessionID }]),
      )
      localStorage.setItem(
        "opencode.global.dat:layout",
        JSON.stringify({
          dock: {
            schema: 2,
            right: {
              visible: true,
              size: 520,
              tabs: ["review", "browser"],
              active: "review",
            },
            items: {
              session: { area: "middle", visible: true },
              review: { area: "right", visible: true },
              browser: { area: "right", visible: true },
            },
          },
        }),
      )
    },
    { directory, dirBase64: base64Encode(directory), sessionID, server },
  )
}

function project() {
  return {
    id: projectID,
    worktree: directory,
    vcs: "git",
    name: "session-browser-dock",
    time: { created: 1700000000000, updated: 1700000000000 },
    sandboxes: [],
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
        },
      },
    ],
    connected: ["opencode"],
    default: { providerID: "opencode", modelID: "claude-opus-4-6" },
  }
}

function session() {
  return {
    id: sessionID,
    slug: sessionID,
    projectID,
    directory,
    title: "Browser dock",
    version: "dev",
    time: { created: 1700000000000, updated: 1700000000000 },
  }
}
