import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"
import { fixture } from "../smoke/session-timeline.fixture"

const directory = "C:/OpenCode/dock-pane-stability"
const otherDirectory = "C:/OpenCode/dock-pane-stability-other"
const server = "http://127.0.0.1:4096"

type MockSession = {
  id: string
  slug: string
  projectID: string
  directory: string
  title: string
  version: string
  time: { created: number; updated: number }
}

let seq = 0
function session(directory: string, title: string): MockSession {
  seq += 1
  return {
    id: `ses_dock_stability_${seq}`,
    slug: `ses_dock_stability_${seq}`,
    projectID: `project-${title.toLowerCase().replace(/\s+/g, "-")}`,
    directory,
    title,
    version: "dev",
    time: { created: 1700000000000 + seq, updated: 1700000000000 + seq },
  }
}

const first = session(directory, "First Session")
const second = session(directory, "Second Session")
const otherProject = session(otherDirectory, "Other Project Session")

async function mockNavigatorPlugin(page: Page, sessions: MockSession[]) {
  const body = readFileSync(resolve("../../.opencode/plugins/session-navigator-app/index.js"), "utf8")
  await page.route("**/experimental/session**", (route) => {
    const url = new URL(route.request().url())
    const selectedDirectory = url.searchParams.get("directory")
    const cursor = Number(url.searchParams.get("cursor") ?? 0)
    const limit = Number(url.searchParams.get("limit") ?? 50)
    const rows = sessions
      .filter((item) => !selectedDirectory || item.directory === selectedDirectory)
      .filter((item) => !cursor || item.time.updated < cursor)
      .toSorted((a, b) => b.time.updated - a.time.updated)
      .slice(0, limit)
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(rows),
    })
  })
  await page.route("**/app/plugins**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({
        plugins: [
          {
            id: "session-navigator-app",
            spec: "session-navigator-app",
            version: "1",
            module: "/app/plugin/session-navigator-app/1/app.js",
            hash: "navigator",
          },
        ],
      }),
    }),
  )
  await page.route("**/app/plugin/session-navigator-app/1/app.js**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/javascript",
      headers: { "access-control-allow-origin": "*" },
      body,
    }),
  )
}

// Tags stable DOM roots with an expando marker; Solid-managed roots also get
// a marker child node. If a pane remounts, its DOM element is recreated and
// the expando disappears. Plugin-rendered roots only use the expando because
// the plugin itself re-renders its children via replaceChildren.
async function tagStableRoots(page: Page) {
  await page.evaluate(() => {
    const targets: Array<[HTMLElement, boolean]> = [
      [document.querySelector('[data-component="session-dock-shell"]'), true],
      [document.querySelector('[data-component="plugin-dock-mount"]'), false],
      [document.querySelector(".oc-session-nav"), false],
      [document.querySelector('[data-component="session-browser-dock"]'), true],
    ].flatMap(([node, child]) => (node instanceof HTMLElement ? [[node, child] as [HTMLElement, boolean]] : []))
    for (const [node, withChild] of targets) {
      ;(node as HTMLElement & { __dockStabilityMarker?: number }).__dockStabilityMarker = 1
      if (!withChild) continue
      const marker = document.createElement("span")
      marker.dataset.dockStabilityMarker = "true"
      node.appendChild(marker)
    }
  })
}

async function stableRootsIntact(page: Page) {
  return page.evaluate(() => {
    const targets: Array<[string, HTMLElement | null, boolean]> = [
      ["shell", document.querySelector('[data-component="session-dock-shell"]'), true],
      ["plugin-dock-mount", document.querySelector('[data-component="plugin-dock-mount"]'), false],
      ["navigator", document.querySelector(".oc-session-nav"), false],
      ["browser-dock", document.querySelector('[data-component="session-browser-dock"]'), true],
    ]
    const broken: string[] = []
    for (const [name, node, child] of targets) {
      if (!node) {
        broken.push(`${name}:missing`)
        continue
      }
      if ((node as HTMLElement & { __dockStabilityMarker?: number }).__dockStabilityMarker !== 1) broken.push(`${name}:remounted`)
      else if (child && !node.querySelector(":scope > [data-dock-stability-marker]")) broken.push(`${name}:children-replaced`)
    }
    return { ok: broken.length === 0, detail: broken.join(",") }
  })
}

test("switching session tabs in the same directory never remounts dock panes", async ({ page }) => {
  const pageErrors: string[] = []
  const failedResponses: string[] = []
  page.on("pageerror", (error) => pageErrors.push(error.message))
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`)
  })

  await mockOpenCodeServer(page, {
    sessions: [first, second],
    sessionList: [first, second],
    provider: fixture.provider,
    directory,
    project: [
      { id: "project-dock-stability", name: "Dock Stability", worktree: directory, vcs: "git" },
      { id: "project-dock-stability-other", name: "Dock Stability Other", worktree: otherDirectory, vcs: "git" },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await mockNavigatorPlugin(page, [first, second])
  // Keep the browser pane stateful without depending on the public network or
  // example.com's current subresources, which can introduce unrelated 4xx
  // responses into this dock-remount regression test.
  await page.route("https://example.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Example</title>" }),
  )

  await page.addInitScript(
    ({ dir, dirBase64, firstID, secondID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: dir, expanded: true }] },
          lastProject: { local: dir },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([
          { type: "session", dirBase64, sessionId: firstID },
          { type: "session", dirBase64, sessionId: secondID },
        ]),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs.recent",
        JSON.stringify({ key: `local\n${dirBase64}\n${firstID}` }),
      )
      localStorage.setItem(
        "opencode.global.dat:layout",
        JSON.stringify({
          dock: {
            left: {
              visible: true,
              size: 300,
              tabs: ["session-navigator-app/sessionNavigator"],
              active: "session-navigator-app/sessionNavigator",
            },
            right: {
              visible: true,
              size: 320,
              tabs: ["review", "fileTree", "gitChanges", "browser"],
              active: "browser",
            },
            items: {
              "session-navigator-app/sessionNavigator": { area: "left", visible: true },
              browser: { area: "right", visible: true },
            },
          },
        }),
      )
    },
    { dir: directory, dirBase64: base64Encode(directory), firstID: first.id, secondID: second.id },
  )

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/${base64Encode(directory)}/session/${first.id}`, { waitUntil: "commit" })
  await page.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0)

  const navigator = page.locator(".oc-session-nav")
  await expectAppVisible(navigator)
  await expectAppVisible(page.locator('[data-component="session-browser-dock"]'))
  await expectAppVisible(page.locator('[data-component="session-dock-shell"]'))
  await expectAppVisible(page.locator(`[data-dock-tab][data-session-id="${second.id}"]`))

  // Scroll the navigator and load a page in the browser dock so both carry
  // observable non-reloaded state.
  await navigator.locator(".oc-session-nav__session").first().waitFor()
  await page.evaluate(() => {
    const nav = document.querySelector(".oc-session-nav")
    if (nav instanceof HTMLElement) nav.scrollTop = 120
  })
  await page.locator('[data-slot="browser-url"]').first().fill("https://example.com/")
  await page.locator('[data-slot="browser-url"]').first().press("Enter")
  await expect(page.locator('[data-slot="browser-frame"]')).toHaveCount(1, { timeout: 10_000 })

  await tagStableRoots(page)
  const before = await page.evaluate(() => {
    const nav = document.querySelector(".oc-session-nav")
    return { navScroll: nav instanceof HTMLElement ? nav.scrollTop : 0 }
  })

  // Switch to the second session in the same directory via the dock tab.
  await page.locator(`[data-dock-tab][data-session-id="${second.id}"]`).click()
  await expect(page.locator(`[data-dock-tab][data-session-id="${second.id}"] [aria-selected="true"], [data-dock-tab][data-session-id="${second.id}"][aria-selected="true"]`)).toBeVisible({ timeout: 10_000 })
  await expect(page.getByRole("heading", { name: second.title })).toBeVisible({ timeout: 15_000 })

  const intact = await stableRootsIntact(page)
  expect(intact.ok, `dock pane roots remounted: ${intact.detail}`).toBe(true)
  const after = await page.evaluate(() => {
    const nav = document.querySelector(".oc-session-nav")
    return { navScroll: nav instanceof HTMLElement ? nav.scrollTop : 0 }
  })
  expect(after.navScroll).toBe(before.navScroll)
  await expect(page.locator('[data-slot="browser-frame"]')).toHaveCount(1)

  // Re-activating the already active tab must also stay a no-op.
  await tagStableRoots(page)
  await page.locator(`[data-dock-tab][data-session-id="${second.id}"]`).click()
  await page.waitForTimeout(300)
  const reactivated = await stableRootsIntact(page)
  expect(reactivated.ok, `dock pane roots remounted on re-activation: ${reactivated.detail}`).toBe(true)

  expect(pageErrors).toEqual([])
  expect(failedResponses).toEqual([])
})

test("switching projects on the same server keeps the dock shell and passive panes mounted", async ({ page }) => {
  const pageErrors: string[] = []
  page.on("pageerror", (error) => pageErrors.push(error.message))

  await mockOpenCodeServer(page, {
    sessions: [first, otherProject],
    sessionList: [first, otherProject],
    provider: fixture.provider,
    directory,
    project: [
      { id: "project-dock-stability", name: "Dock Stability", worktree: directory, vcs: "git" },
      { id: "project-dock-stability-other", name: "Dock Stability Other", worktree: otherDirectory, vcs: "git" },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await mockNavigatorPlugin(page, [first, otherProject])

  await page.addInitScript(
    ({ dir, dirBase64, firstID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: dir, expanded: true }] },
          lastProject: { local: dir },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", server: "local", dirBase64, sessionId: firstID }]),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs.recent",
        JSON.stringify({ key: `local\n${dirBase64}\n${firstID}` }),
      )
      localStorage.setItem(
        "opencode.global.dat:layout",
        JSON.stringify({
          dock: {
            left: {
              visible: true,
              size: 300,
              tabs: ["session-navigator-app/sessionNavigator"],
              active: "session-navigator-app/sessionNavigator",
            },
            right: {
              visible: true,
              size: 320,
              tabs: ["review", "fileTree", "gitChanges", "browser"],
              active: "browser",
            },
            items: {
              "session-navigator-app/sessionNavigator": { area: "left", visible: true },
              browser: { area: "right", visible: true },
            },
          },
        }),
      )
    },
    { dir: directory, dirBase64: base64Encode(directory), firstID: first.id },
  )

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/${base64Encode(directory)}/session/${first.id}`, { waitUntil: "commit" })
  await page.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0)
  await expectAppVisible(page.locator(".oc-session-nav"))
  await expectAppVisible(page.locator('[data-component="session-dock-shell"]'))

  await tagStableRoots(page)

  // Cross-directory switch: open the other project's session through the
  // navigator (same server).
  await page.locator(`.oc-session-nav__session[data-session-id="${otherProject.id}"]`).first().click()
  await expect(page.getByRole("heading", { name: otherProject.title })).toBeVisible({ timeout: 15_000 })

  const intact = await stableRootsIntact(page)
  expect(intact.ok, `shell or plugin pane remounted on project switch: ${intact.detail}`).toBe(true)
  expect(pageErrors).toEqual([])
})
