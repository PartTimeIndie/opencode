import { expect, test, type Route } from "@playwright/test"
import fs from "node:fs/promises"
import path from "node:path"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectNoSmokeErrors, trackPageErrors } from "../utils/errors"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/PluginToolbarSettings"
const server = "http://127.0.0.1:4096"
const sessionID = "plugin-toolbar-settings-session"
const screenshots = path.resolve("../../docs/plugin-toolbar-settings")

const modules = {
  "codex-image-composer-app": toolbarPlugin("codex-image-composer-app", "codexImage", "Generate Image", 10),
  "interleaved-toolbar-app": toolbarPlugin(
    "interleaved-toolbar-app",
    "interleaved",
    "Interleaved Toolbar",
    20,
    "composer",
    "left",
  ),
  "multi-agent-problem-solver-app": toolbarPlugin(
    "multi-agent-problem-solver-app",
    "multiAgentProblemSolver",
    "Multi Agent Problem Solver",
    30,
  ),
}

test("controls plugin toolbar icons globally and per project", async ({ page }) => {
  await fs.mkdir(screenshots, { recursive: true })
  const errors = trackPageErrors(page)
  const networkFailures: string[] = []
  page.on("response", (response) => {
    if (response.status() >= 400) networkFailures.push(`${response.status()} ${response.url()}`)
  })
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: "proj-plugin-toolbar-settings",
      worktree: directory,
      vcs: "git",
      name: "Plugin Toolbar Settings",
      time: { created: 1_700_000_000_000 },
      sandboxes: [],
    },
    provider: {
      all: [{ id: "opencode", name: "OpenCode", models: { audit: { id: "audit", name: "Audit", limit: { context: 200_000 } } } }],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "audit" },
    },
    sessions: [
      {
        id: sessionID,
        slug: sessionID,
        projectID: "proj-plugin-toolbar-settings",
        directory,
        title: "Plugin Toolbar Settings",
        version: "dev",
        time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await page.route("**/app/plugins**", (route) =>
    json(route, {
      plugins: Object.keys(modules).map((id) => ({
        id,
        spec: id,
        version: "1",
        module: `/app/plugin/${id}/1/index.js`,
        hash: `${id}-toolbar-settings`,
      })),
    }),
  )
  await page.route("**/app/plugin/*/1/index.js**", (route) => {
    const id = new URL(route.request().url()).pathname.split("/")[3] as keyof typeof modules
    return route.fulfill({
      status: 200,
      contentType: "text/javascript",
      headers: { "access-control-allow-origin": "*" },
      body: modules[id],
    })
  })
  await page.addInitScript(
    ({ directory, dirBase64, sessionID }) => {
      if (!sessionStorage.getItem("plugin-toolbar-settings-initialized")) {
        localStorage.removeItem("opencode.global.dat:plugin-toolbar-visibility")
        localStorage.removeItem("opencode.global.dat:plugin-toolbar-order")
        sessionStorage.setItem("plugin-toolbar-settings-initialized", "true")
      }
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true, name: "Plugin Toolbar Settings" }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", server: "http://127.0.0.1:4096", dirBase64, sessionId: sessionID }]),
      )
    },
    { directory, dirBase64: btoa(directory), sessionID },
  )

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${btoa(directory)}/session/${sessionID}`)
  await expectAppVisible(page.getByRole("heading", { name: "Plugin Toolbar Settings" }))
  await expect(page.locator('[data-plugin-toolbar-item="codex-image-composer-app/codexImage"]')).toHaveCount(0)
  await expect(page.locator('[data-plugin-toolbar-item="multi-agent-problem-solver-app/multiAgentProblemSolver"]')).toHaveCount(0)

  await page.getByRole("button", { name: "Open settings" }).click()
  const settingsSearch = page.getByRole("searchbox", { name: "Search settings" })
  await settingsSearch.fill("Generate Image")
  await expect(settingsSearch).toHaveValue("Generate Image")
  const searchResults = page.getByRole("region", { name: "Search results" })
  await expectAppVisible(searchResults)
  const pluginResult = searchResults.getByRole("button", { name: /Generate Image/ })
  await expectAppVisible(pluginResult)
  await pluginResult.click()
  await expect(settingsSearch).toHaveValue("")
  await expect(page.getByRole("tab", { name: /Plugins/ })).toHaveAttribute("data-selected", "")
  const panel = page.locator("[data-plugin-toolbar-settings]")
  await expectAppVisible(panel)
  const generate = panel.locator('[data-component="settings-v2-row"]').filter({ hasText: "Generate Image" })
  const interleaved = panel.locator('[data-component="settings-v2-row"]').filter({ hasText: "Interleaved Toolbar" })
  const solver = panel.locator('[data-component="settings-v2-row"]').filter({ hasText: "Multi Agent Problem Solver" })
  await expectAppVisible(generate)
  await expectAppVisible(interleaved)
  await expectAppVisible(solver)
  await expect(generate.getByRole("switch")).not.toBeChecked()
  await expect(solver.getByRole("switch")).not.toBeChecked()
  await expect(generate.getByRole("button", { name: "Move Generate Image up" })).toBeDisabled()
  await expect(interleaved.getByRole("button", { name: "Move Interleaved Toolbar up" })).toBeDisabled()
  await expect(interleaved.getByRole("button", { name: "Move Interleaved Toolbar down" })).toBeDisabled()
  await expect(solver.getByRole("button", { name: "Move Multi Agent Problem Solver down" })).toBeDisabled()
  await page.screenshot({ path: path.join(screenshots, "global-defaults-desktop.png") })

  await solver.getByRole("button", { name: "Move Multi Agent Problem Solver up" }).click()
  await expect(panel.locator('[data-slot="settings-v2-row-title"]')).toHaveText([
    "Multi Agent Problem Solver",
    "Interleaved Toolbar",
    "Generate Image",
  ])
  await expect(solver.getByRole("button", { name: "Move Multi Agent Problem Solver up" })).toBeDisabled()
  await expect(generate.getByRole("button", { name: "Move Generate Image down" })).toBeDisabled()

  await generate.locator('[data-slot="switch-control"]').click()
  await solver.locator('[data-slot="switch-control"]').click()
  await expect(page.locator('[data-plugin-toolbar-item="codex-image-composer-app/codexImage"]')).toBeVisible()
  await expect(page.locator('[data-plugin-toolbar-item="multi-agent-problem-solver-app/multiAgentProblemSolver"]')).toBeVisible()
  await expect(
    page
      .locator(
        '[data-component="plugin-toolbar-outlet"][data-plugin-toolbar-placement="composer"][data-plugin-toolbar-align="right"]',
      )
      .locator("[data-plugin-toolbar-item]")
      .first(),
  ).toHaveAttribute("data-plugin-toolbar-item", "multi-agent-problem-solver-app/multiAgentProblemSolver")
  await page.screenshot({ path: path.join(screenshots, "global-reordered-desktop.png") })
  await page.keyboard.press("Escape")
  const composer = page.locator('[data-component="session-composer"]')
  await composer.evaluate((element) => (element.style.width = "420px"))
  const moreTools = page.getByRole("button", { name: "More tools", exact: true })
  await expect(moreTools).toBeVisible()
  await expect(moreTools).toHaveCSS("width", "28px")
  await moreTools.click()
  const pluginMenu = page.locator('[data-component="plugin-toolbar-mobile-menu"]')
  await expect(pluginMenu).toBeVisible()
  await expect(pluginMenu.getByText("Generate Image", { exact: true })).toBeVisible()
  await expect(pluginMenu.getByText("Multi Agent Problem Solver", { exact: true })).toBeVisible()
  await page.screenshot({ path: path.join(screenshots, "narrow-desktop-overflow.png") })
  await page.keyboard.press("Escape")
  await composer.evaluate((element) => element.style.removeProperty("width"))
  await expect(moreTools).toHaveCount(0)
  await page.getByRole("button", { name: "Open settings" }).click()
  await page.getByRole("tab", { name: "Plugins" }).click()
  await expectAppVisible(panel)
  await panel.getByText("All projects (global)").click()
  await page.getByText("Plugin Toolbar Settings", { exact: true }).last().click()
  await generate.getByRole("button", { name: "Move Generate Image up" }).click()
  await expect(panel.locator('[data-slot="settings-v2-row-title"]')).toHaveText([
    "Generate Image",
    "Interleaved Toolbar",
    "Multi Agent Problem Solver",
  ])
  await expect(
    page
      .locator(
        '[data-component="plugin-toolbar-outlet"][data-plugin-toolbar-placement="composer"][data-plugin-toolbar-align="right"]',
      )
      .locator("[data-plugin-toolbar-item]")
      .first(),
  ).toHaveAttribute("data-plugin-toolbar-item", "codex-image-composer-app/codexImage")
  await panel.getByRole("button", { name: "Reset overrides" }).click()
  await expect(panel.locator('[data-slot="settings-v2-row-title"]')).toHaveText([
    "Multi Agent Problem Solver",
    "Interleaved Toolbar",
    "Generate Image",
  ])
  await generate.getByText("Global").click()
  await page.getByText("Off", { exact: true }).last().click()
  await expect(page.locator('[data-plugin-toolbar-item="codex-image-composer-app/codexImage"]')).toHaveCount(0)
  await page.screenshot({ path: path.join(screenshots, "project-override-desktop.png") })

  await page.setViewportSize({ width: 390, height: 844 })
  await expectAppVisible(panel)
  await generate.scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(screenshots, "project-override-mobile.png") })

  await page.reload()
  await expectAppVisible(page.getByRole("heading", { name: "Plugin Toolbar Settings" }))
  await expect(page.locator('[data-plugin-toolbar-item="codex-image-composer-app/codexImage"]')).toHaveCount(0)
  await page.getByRole("button", { name: "Open settings" }).click()
  await page.getByRole("tab", { name: "Plugins" }).click()
  const reloadedGenerate = page
    .locator("[data-plugin-toolbar-settings]")
    .locator('[data-component="settings-v2-row"]')
    .filter({ hasText: "Generate Image" })
  await expect(reloadedGenerate.getByRole("switch")).toBeChecked()
  await expect(
    page.locator("[data-plugin-toolbar-settings]").locator('[data-slot="settings-v2-row-title"]'),
  ).toHaveText(["Multi Agent Problem Solver", "Interleaved Toolbar", "Generate Image"])
  expectNoSmokeErrors(errors, [], [])
  expect(networkFailures).toEqual([])
})

function toolbarPlugin(
  pluginID: string,
  id: string,
  title: string,
  order: number,
  placement: "top" | "composer" = "composer",
  align: "left" | "right" = "right",
) {
  return `export default { id: ${JSON.stringify(pluginID)}, app(api) { api.toolbar.register({ id: ${JSON.stringify(id)}, title: ${JSON.stringify(title)}, tooltip: ${JSON.stringify(title)}, placement: ${JSON.stringify(placement)}, align: ${JSON.stringify(align)}, order: ${order}, icon: { name: "code" }, visible: (ctx) => Boolean(ctx.sessionID && ctx.directory), enabled: () => true, run() {} }) } }`
}

function json(route: Route, body: unknown) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify(body),
  })
}
