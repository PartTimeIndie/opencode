import { mkdirSync, writeFileSync } from "node:fs"
import { expect, test, type Page, type Route } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"
import { fixture } from "../smoke/session-timeline.fixture"

const directory = "C:/OpenCode/plugin-command-shortcuts"
const server = "http://127.0.0.1:4096"
const sessionID = "ses_plugin_command_shortcuts"
const screenshotDir = "test-results/plugin-command-shortcuts"

test("plugin command keybinds appear in Settings shortcuts", async ({ page }) => {
  const consoleErrors: string[] = []
  const networkFailures: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })
  page.on("pageerror", (error) => consoleErrors.push(error.stack ?? error.message))
  page.on("requestfailed", (request) =>
    networkFailures.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`),
  )
  page.on("response", (response) => {
    const url = new URL(response.url())
    if (url.port === (process.env.PLAYWRIGHT_SERVER_PORT ?? "4096") && response.status() >= 400) {
      networkFailures.push(`${response.status()} ${response.request().method()} ${url.pathname}`)
    }
  })

  await mockOpenCodeServer(page, {
    directory,
    provider: fixture.provider,
    project: { id: "project-plugin-command-shortcuts", name: "Plugin Command Shortcuts", worktree: directory, vcs: "git" },
    sessions: [session()],
    pageMessages: () => ({ items: [] }),
    globalConfig: () => ({}),
  })
  await mockShortcutPlugin(page)
  await configurePage(page)

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectAppVisible(page.getByRole("textbox", { name: /Ask anything/i }))

  const isMac = await page.evaluate(() => /(Mac|iPod|iPhone|iPad)/.test(navigator.platform))
  await page.evaluate((mac) => {
    window.dispatchEvent(new CustomEvent("shortcut-demo-reset"))
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "r", ctrlKey: !mac, metaKey: mac, bubbles: true, cancelable: true }),
    )
  }, isMac)
  await expect.poll(() => page.evaluate(() => window.__shortcutDemoRuns ?? 0)).toBe(1)

  await page.getByRole("button", { name: "Open settings" }).click()
  const shortcutsTab = page.getByRole("tab", { name: "Shortcuts", exact: true })
  await expectAppVisible(shortcutsTab)
  await shortcutsTab.click()

  const search = page.getByRole("searchbox", { name: "Search shortcuts" })
  await expectAppVisible(search)
  await search.fill("Ctrl R")
  const keybindButton = page.locator('[data-keybind-id="shortcut-demo.open"]')
  await expectAppVisible(page.getByText("Shortcut demo action"))
  await expect(keybindButton).toContainText(isMac ? /⌘R/ : /Ctrl\+R/i)
  await expect(page.getByText("Cycle composer toolbar (multi)")).toHaveCount(0)

  await search.fill("mod+r")
  await expectAppVisible(page.getByText("Shortcut demo action"))

  await search.fill("Shortcut demo action")
  await expectAppVisible(page.getByText("Shortcut demo action"))
  await expect(keybindButton).toContainText(isMac ? /⌘R/ : /Ctrl\+R/i)

  await search.fill("Ctrl R")

  mkdirSync(screenshotDir, { recursive: true })
  await page.screenshot({ path: `${screenshotDir}/desktop.png`, fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  await expectAppVisible(page.getByText("Shortcut demo action"))
  await expect(keybindButton).toBeVisible()
  await page.screenshot({ path: `${screenshotDir}/mobile.png`, fullPage: true })

  writeFileSync(`${screenshotDir}/console-errors.json`, JSON.stringify(consoleErrors, null, 2))
  writeFileSync(`${screenshotDir}/network-failures.json`, JSON.stringify(networkFailures, null, 2))
  expect(consoleErrors).toEqual([])
  expect(networkFailures).toEqual([])
})

test("shortcut search follows user overrides", async ({ page }) => {
  await mockOpenCodeServer(page, {
    directory,
    provider: fixture.provider,
    project: { id: "project-plugin-command-shortcuts", name: "Plugin Command Shortcuts", worktree: directory, vcs: "git" },
    sessions: [session()],
    pageMessages: () => ({ items: [] }),
    globalConfig: () => ({}),
  })
  await mockShortcutPlugin(page)
  await configurePage(page, { keybinds: { "shortcut-demo.open": "mod+k,ctrl+alt+x" } })

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectAppVisible(page.getByRole("textbox", { name: /Ask anything/i }))
  await page.getByRole("button", { name: "Open settings" }).click()
  const shortcutsTab = page.getByRole("tab", { name: "Shortcuts", exact: true })
  await expectAppVisible(shortcutsTab)
  await shortcutsTab.click()

  const search = page.getByRole("searchbox", { name: "Search shortcuts" })
  const keybindButton = page.locator('[data-keybind-id="shortcut-demo.open"]')
  await search.fill("mod+k")
  await expectAppVisible(keybindButton)
  await search.fill("Ctrl Alt X")
  await expectAppVisible(keybindButton)
  await search.fill("mod+r")
  await expect(keybindButton).toHaveCount(0)

  await page.setViewportSize({ width: 390, height: 844 })
  await search.fill("Ctrl Alt X")
  await expectAppVisible(keybindButton)
})

async function configurePage(page: Page, settings: Record<string, unknown> = {}) {
  await page.addInitScript(
    ({ dir, dirBase64, serverKey, initialSettings }) => {
      localStorage.setItem("settings.v3", JSON.stringify(initialSettings))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { [serverKey]: [{ worktree: dir, expanded: true }] }, lastProject: { [serverKey]: dir } }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", server: serverKey, dirBase64, sessionId: "ses_plugin_command_shortcuts" }]),
      )
    },
    { dir: directory, dirBase64: base64Encode(directory), serverKey: server, initialSettings: settings },
  )
}

async function mockShortcutPlugin(page: Page) {
  await page.route("**/app/plugins**", (route) =>
    json(route, {
      plugins: [
        {
          id: "shortcut-demo",
          spec: "shortcut-demo",
          version: "1",
          module: "/app/plugin/shortcut-demo/1/index.js",
          hash: "shortcut-demo",
          capabilities: ["commands"],
        },
      ],
    }),
  )
  await page.route("**/app/plugin/shortcut-demo/1/index.js**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/javascript",
      headers: { "access-control-allow-origin": "*" },
      body: `
        export default {
          id: "shortcut-demo",
          app(api) {
            window.__shortcutDemoRuns = 0
            window.addEventListener("shortcut-demo-reset", () => { window.__shortcutDemoRuns = 0 })
            api.commands.register({
              id: "open",
              title: "Shortcut demo action",
              description: "Runs a shortcut demo plugin command.",
              category: "Shortcut Demo",
              keybind: "mod+r",
              run() {
                window.__shortcutDemoRuns += 1
              },
            })
          },
        }
      `,
    }),
  )
}

function session() {
  return {
    id: sessionID,
    slug: sessionID,
    projectID: "project-plugin-command-shortcuts",
    directory,
    title: "Plugin Command Shortcuts Session",
    version: "dev",
    time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
  }
}

function json(route: Route, body: unknown) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify(body),
  })
}
