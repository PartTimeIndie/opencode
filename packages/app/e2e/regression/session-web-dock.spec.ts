import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"

const directory = "C:/OpenCode/WebDockFixture"
const projectID = "proj_web_dock_fixture"
const sessionID = "ses_web_dock_fixture"
const server = "http://127.0.0.1:4096"

async function setup(page: Page) {
  await page.route("http://localhost:3000/**", (route) => route.fulfill({
    status: 200, contentType: "text/html",
    body: "<!doctype html><title>Web fixture</title><style>body{margin:0;padding:16px;background:#f3f4f6;color:#18202c;font:16px sans-serif}input{padding:8px}section{height:1200px}</style><h1>Web fixture</h1><label>Note <input aria-label='Note'></label><a href='/next'>Next page</a><section></section><p>Scroll marker</p><script>window.loadID=crypto.randomUUID()</script>",
  }))
  await mockOpenCodeServer(page, {
    directory,
    project: { id: projectID, worktree: directory, vcs: "git", name: "web", time: { created: 1, updated: 1 }, sandboxes: [] },
    provider: { all: [], default: {}, connected: [] },
    sessions: [{ id: sessionID, slug: sessionID, projectID, directory, title: "web", version: "dev", time: { created: 1, updated: 1 } }],
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript(({ directory, encoded, sessionID, server }) => {
    if (localStorage.getItem("web-dock-fixture-initialized")) return
    localStorage.setItem("web-dock-fixture-initialized", "true")
    localStorage.setItem("settings.v3", JSON.stringify({}))
    localStorage.setItem("opencode.global.dat:server", JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] }, lastProject: { local: directory } }))
    localStorage.setItem("opencode.global.dat:tabs", JSON.stringify([{ type: "session", server, dirBase64: encoded, sessionId: sessionID }]))
    localStorage.setItem("opencode.global.dat:layout", JSON.stringify({ dock: { schema: 2, right: { visible: true, size: 520, tabs: ["review", "browser"], active: "browser" }, items: { session: { area: "middle", visible: true }, review: { area: "right", visible: true }, browser: { area: "right", visible: true } } } }))
  }, { directory, encoded: base64Encode(directory), sessionID, server })
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expect(page.locator('[data-slot="browser-url"]')).toBeVisible()
  await page.locator('[data-slot="browser-url"]').fill("http://localhost:3000/")
  await page.getByRole("button", { name: "Open", exact: true }).click()
  const original = page.locator('[data-slot="browser-frame"]').first()
  const tabID = await original.getAttribute("data-tab-id")
  const frame = page.frameLocator(`[data-slot="browser-frame"][data-tab-id="${tabID}"]`)
  await frame.getByLabel("Note").fill("kept")
  return { tabID, frame, original }
}

async function dock(page: Page, name = "Fixture") {
  await page.getByRole("button", { name: "Dock", exact: true }).click()
  await page.getByLabel("Name", { exact: true }).fill(name)
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.locator('[data-component="session-web-dock"]')).toBeVisible()
  return page.locator('[data-dock-tab^="web-dock:"]').first()
}

test("a live page moves, hides and returns without reloading; the same URL stays independent", async ({ page }, info) => {
  const errors: string[] = []
  const failed: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("response", (response) => { if (response.status() >= 400) failed.push(`${response.status()} ${response.url()}`) })
  const { tabID, frame, original } = await setup(page)
  const loadID = await frame.locator("body").evaluate(() => Reflect.get(window, "loadID"))
  const tab = await dock(page)
  await expect(frame.getByLabel("Note")).toHaveValue("kept")
  await expect(page.locator(`[data-slot="browser-tab"][data-tab-id="${tabID}"]`)).toHaveCount(0)
  const slot = page.locator('[data-component="session-web-dock"]')
  const slotBox = await slot.boundingBox()
  expect(await original.boundingBox()).toEqual(slotBox)
  await page.screenshot({ path: info.outputPath("web-dock-desktop.png") })

  await page.locator('[data-dock-tab="browser"] [role="tab"]').click()
  await expect(original).not.toBeVisible()
  await page.locator('[data-slot="browser-url"]').fill("http://localhost:3000/")
  await page.getByRole("button", { name: "Open", exact: true }).click()
  await expect(page.locator('[data-slot="browser-frame"]')).toHaveCount(2)
  await expect(frame.getByLabel("Note")).toHaveValue("kept")
  await tab.getByRole("tab").click()
  await tab.getByRole("button", { name: "More options", exact: true }).click()
  await expect(page.getByRole("menuitem", { name: "Rename", exact: true }).first()).toBeVisible()
  await expect(original).not.toBeVisible()
  await page.getByRole("menuitem", { name: "Rename", exact: true }).first().click()
  await expect(original).not.toBeVisible()
  await page.getByLabel("Name", { exact: true }).fill("Renamed")
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(tab.getByRole("tab")).toHaveAttribute("aria-label", "Renamed")
  await expect(frame.getByLabel("Note")).toHaveValue("kept")
  expect(await frame.locator("body").evaluate(() => Reflect.get(window, "loadID"))).toBe(loadID)

  await tab.getByRole("button", { name: "Close Renamed", exact: true }).click()
  await expect(original).not.toBeVisible()
  await page.locator('[data-dock-tab="browser"] [role="tab"]').click()
  await expect(page.locator('[data-slot="browser-frame"]:visible')).toHaveCount(1)
  await page.getByRole("button", { name: "Add dock item to right", exact: true }).click()
  await expect(page.locator('[data-slot="browser-frame"]:visible')).toHaveCount(0)
  await page.locator('[data-component="dock-add-menu"]').getByRole("button", { name: /Renamed/ }).click()
  await expect(original).toBeVisible()
  await expect(frame.getByLabel("Note")).toHaveValue("kept")
  await expect(page.locator('[data-slot="browser-frame"]')).toHaveCount(2)
  await tab.getByRole("button", { name: "More options", exact: true }).click()
  await page.getByRole("menuitem", { name: "Return to browser", exact: true }).click()
  await expect(page.locator('[data-dock-tab^="web-dock:"]')).toHaveCount(0)
  await expect(page.locator(`[data-slot="browser-tab"][data-tab-id="${tabID}"]`)).toBeVisible()
  await expect(frame.getByLabel("Note")).toHaveValue("kept")
  await expect(page.locator('[data-slot="browser-frame"]')).toHaveCount(2)
  expect(await frame.locator("body").evaluate(() => Reflect.get(window, "loadID"))).toBe(loadID)
  expect(errors).toEqual([])
  expect(failed).toEqual([])
})

test("return places Browser even when this layout has no Browser item", async ({ page }) => {
  await setup(page)
  await dock(page)
  await page.evaluate(() => {
    const key = "opencode.global.dat:layout"
    const data = JSON.parse(localStorage.getItem(key)!)
    delete data.dock.items.browser
    for (const area of ["left", "middle", "right", "bottom"]) {
      const zone = data.dock[area]
      if (zone?.tabs) zone.tabs = zone.tabs.filter((id: string) => id !== "browser")
    }
    localStorage.setItem(key, JSON.stringify(data))
  })
  await page.reload()
  const tab = page.locator('[data-dock-tab^="web-dock:"]').first()
  await expect(page.locator('[data-slot="browser-frame"]:visible')).toHaveCount(1)
  await tab.getByRole("button", { name: "More options", exact: true }).click()
  await page.getByRole("menuitem", { name: "Return to browser", exact: true }).click()
  await expect(page.locator('[data-slot="browser-url"]')).toBeVisible()
  await expect(page.locator('[data-dock-tab^="web-dock:"]')).toHaveCount(0)
})

test("restores a fixed start address after reload and fits the mobile dock", async ({ page }, info) => {
  const { frame } = await setup(page)
  await frame.getByRole("link", { name: "Next page" }).click()
  await expect(frame.getByLabel("Note")).toHaveValue("")
  await dock(page)
  await page.reload()
  const restored = page.locator('[data-slot="browser-frame"][src]')
  await expect(page.locator('[data-component="session-web-dock"]')).toBeVisible()
  await expect(restored).toHaveAttribute("src", "http://localhost:3000/")
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('[data-action="mobile-dock-launcher"]').click()
  const tab = page.locator('[data-dock-tab^="web-dock:"]:visible').first()
  await tab.getByRole("tab").click()
  await expect(restored).toBeVisible()
  await expect.poll(async () => restored.boundingBox()).toEqual(await page.locator('[data-component="session-web-dock"]:visible').boundingBox())
  await page.screenshot({ path: info.outputPath("web-dock-mobile.png") })
})
