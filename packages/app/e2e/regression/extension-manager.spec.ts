import { expect, test, type Route } from "@playwright/test"
import fs from "node:fs/promises"
import path from "node:path"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/ExtensionManager"
const server = "http://127.0.0.1:4096"
const sessionID = "extension-manager-session"

test.describe("extension manager", () => {
  test("lists all sources and safely uninstalls only project-local items", async ({ page }) => {
    const errors: string[] = []
    const failedExtensionRequests: string[] = []
    const state = {
      plugins: [
        {
          id: "plugin:app:local",
          kind: "plugin",
          name: "Session Navigator",
          target: "app",
          targets: ["app"],
          source: "project",
          scope: "project",
          spec: "./plugins/session-navigator-app",
          path: `${directory}/.opencode/plugins/session-navigator-app`,
          file: `${directory}/.opencode/app.jsonc`,
          configFile: `${directory}/.opencode/app.jsonc`,
          removable: true,
        },
        {
          id: "plugin:app:global",
          kind: "plugin",
          name: "Cursor Provider",
          target: "app",
          targets: ["app"],
          source: "global",
          scope: "global",
          spec: "cursor-opencode-provider",
          removable: false,
          reason: "Nicht projektlokal",
        },
      ],
      skills: [
        {
          id: "skill:local",
          kind: "skill",
          name: "local-skill",
          target: "unknown",
          source: "project",
          scope: "project",
          path: `${directory}/.opencode/skills/local-skill`,
          file: `${directory}/.opencode/skills/local-skill/SKILL.md`,
          removable: true,
        },
        {
          id: "skill:global",
          kind: "skill",
          name: "global-skill",
          target: "unknown",
          source: "global",
          scope: "global",
          path: "C:/Users/Test/.config/opencode/skills/global-skill",
          removable: false,
          reason: "Nicht projektlokal",
        },
      ],
    }
    const removed = new Set<string>()
    const scopeUpdates: Array<{ skill_scopes?: Record<string, { mode: string; projects?: string[] }> }> = []

    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text())
    })
    page.on("pageerror", (error) => errors.push(error.message))
    page.on("requestfailed", (request) => {
      if (new URL(request.url()).pathname.startsWith("/app/extensions")) failedExtensionRequests.push(request.url())
    })
    page.on("response", (response) => {
      if (new URL(response.url()).pathname.startsWith("/app/extensions") && !response.ok()) {
        failedExtensionRequests.push(`${response.status()} ${response.url()}`)
      }
    })

    await mockOpenCodeServer(page, {
      directory,
      project: project(),
      provider: provider(),
      sessions: [session()],
      pageMessages: () => ({ items: [] }),
      onGlobalConfigUpdate: (body) => {
        const update = body as { skill_scopes?: Record<string, { mode: string; projects?: string[] }> }
        scopeUpdates.push(update)
        return update
      },
    })
    await page.route("**/app/extensions**", async (route) => {
      const url = new URL(route.request().url())
      if (route.request().method() === "GET") return json(route, state)
      if (url.pathname.endsWith("/plugin/uninstall")) {
        const body = JSON.parse(route.request().postData() ?? "{}") as { spec?: string }
        removed.add(body.spec ?? "")
        state.plugins = state.plugins.filter((item) => item.spec !== body.spec)
        return json(route, { ok: true })
      }
      if (url.pathname.endsWith("/skill/uninstall")) {
        const body = JSON.parse(route.request().postData() ?? "{}") as { name?: string }
        removed.add(body.name ?? "")
        state.skills = state.skills.filter((item) => item.name !== body.name)
        return json(route, { ok: true })
      }
      return json(route, {})
    })
    await page.route("**/app/plugins**", (route) => json(route, { plugins: [] }))
    await page.route("**/api/session/*/held-inputs**", (route) => json(route, { data: [] }))
    await configurePage(page)
    page.on("dialog", (dialog) => void dialog.accept())

    await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
    await expectAppVisible(page.getByRole("heading", { name: "Extension Manager Session" }))
    await page.keyboard.press("Control+Shift+P")
    await expectAppVisible(page.getByPlaceholder("Search files, commands, and sessions"))
    await page.getByPlaceholder("Search files, commands, and sessions").fill("Plugin Manager")
    await page.getByText("Plugin Manager...").click()

    await expectAppVisible(page.locator('[data-extension-id="plugin:app:local"]'))
    await expectAppVisible(page.locator('[data-extension-id="plugin:app:global"]'))
    await expect(page.locator('[data-extension-id="plugin:app:local"]')).toContainText("Session Navigator")
    await expect(page.locator('[data-extension-id="plugin:app:global"]')).toContainText("Cursor Provider")
    await expect(page.locator('[data-extension-id="plugin:app:global"]').getByRole("button", { name: "Entfernen" })).toBeDisabled()

    const pluginFilter = page.getByRole("searchbox", { name: "Filter Plugins" })
    await pluginFilter.fill("CURSOR")
    await expect(page.locator('[data-extension-id="plugin:app:global"]')).toHaveCount(1)
    await expect(page.locator('[data-extension-id="plugin:app:local"]')).toHaveCount(0)
    await pluginFilter.fill("")
    await page.getByLabel("Quelle filtern").selectOption("global")
    await expect(page.locator('[data-extension-id^="plugin:"]')).toHaveCount(1)
    await page.getByLabel("Quelle filtern").selectOption("")
    await page.getByLabel("Status filtern").selectOption("false")
    await expect(page.locator('[data-extension-id^="plugin:"]')).toHaveCount(1)
    await page.getByLabel("Status filtern").selectOption("")
    await expect(page.locator('[data-extension-id^="plugin:"]').first()).toContainText("Cursor Provider")
    await page.getByRole("button", { name: "Absteigend sortieren" }).click()
    await expect(page.locator('[data-extension-id^="plugin:"]').first()).toContainText("Session Navigator")
    await page.getByLabel("Sortieren nach").selectOption("source")
    await page.getByRole("button", { name: "Aufsteigend sortieren" }).click()
    await expect(page.locator('[data-extension-id^="plugin:"]').first()).toContainText("Cursor Provider")

    for (const viewport of [{ width: 1207, height: 724 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport)
      const row = page.locator('[data-extension-id="plugin:app:local"]')
      const list = row.locator("xpath=..")
      const remove = row.getByRole("button", { name: "Entfernen" })
      await expect.poll(async () => list.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
      const bounds = await remove.boundingBox()
      const listBounds = await list.boundingBox()
      expect(bounds).not.toBeNull()
      expect(listBounds).not.toBeNull()
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(listBounds!.x + listBounds!.width)
      if (process.env.VISUAL_QA_SCREENSHOT) {
        await page.screenshot({ path: process.env.VISUAL_QA_SCREENSHOT.replace(/\.png$/, `-${viewport.width}.png`), fullPage: true })
      }
    }
    await page.locator('[data-extension-id="plugin:app:local"]').getByRole("button", { name: "Entfernen" }).click()
    await expect(page.getByText("Session Navigator")).toHaveCount(0)
    expect(removed.has("./plugins/session-navigator-app")).toBe(true)

    await page.getByRole("tab", { name: "Skills" }).click()
    await expectAppVisible(page.locator('[data-extension-id="skill:local"]'))
    await expectAppVisible(page.locator('[data-extension-id="skill:global"]'))
    await expect(page.locator('[data-extension-id="skill:global"]').getByRole("button", { name: "Entfernen" })).toBeDisabled()
    await expect(page.locator('[data-skill-scope="local-skill"] summary')).toContainText("Projekt")
    await expect(page.locator('[data-skill-scope="global-skill"] summary')).toContainText("Global")

    const skillFilter = page.getByRole("searchbox", { name: "Filter Skills" })
    await skillFilter.fill("LOCAL")
    await expect(page.locator('[data-extension-id="skill:local"]')).toHaveCount(1)
    await expect(page.locator('[data-extension-id="skill:global"]')).toHaveCount(0)
    await skillFilter.fill("")
    await page.getByLabel("Sortieren nach").selectOption("availability")
    await expect(page.locator('[data-extension-id^="skill:"]').first()).toContainText("global-skill")
    await page.getByRole("button", { name: "Absteigend sortieren" }).click()
    await expect(page.locator('[data-extension-id^="skill:"]').first()).toContainText("local-skill")
    await page.getByRole("button", { name: "Aufsteigend sortieren" }).click()
    await skillFilter.fill("kein passender eintrag")
    await expect(page.getByText("Keine Skills entsprechen den Filtern.")).toHaveCount(1)
    await page.getByRole("button", { name: "Filter zurücksetzen" }).click()
    await expect(page.locator('[data-extension-id="skill:local"]')).toHaveCount(1)
    await expect(page.locator('[data-extension-id="skill:global"]')).toHaveCount(1)
    for (const viewport of [{ width: 1207, height: 724 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport)
      await page.locator('[data-skill-scope="local-skill"] summary').click()
      await expect(page.locator('[data-skill-scope="local-skill"] input[type="checkbox"]')).toHaveCount(1)
      if (process.env.VISUAL_QA_SCREENSHOT) {
        await page.screenshot({ path: process.env.VISUAL_QA_SCREENSHOT.replace(/\.png$/, `-skill-${viewport.width}.png`), fullPage: true })
      }
      await page.locator('[data-skill-scope="local-skill"] summary').click()
    }
    await page.locator('[data-skill-scope="local-skill"] summary').click()
    await page.locator('[data-skill-scope="local-skill"] input[type="radio"]').first().check()
    await expect.poll(() => scopeUpdates.at(-1)?.skill_scopes?.[`${directory}/.opencode/skills/local-skill`]?.mode).toBe("global")
    await page.locator('[data-skill-scope="local-skill"] input[type="radio"]').last().check()
    await expect.poll(() => scopeUpdates.at(-1)?.skill_scopes?.[`${directory}/.opencode/skills/local-skill`]?.projects).toEqual([directory])
    await page.locator('[data-extension-id="skill:local"]').getByRole("button", { name: "Entfernen" }).click()
    await expect(page.getByText("local-skill")).toHaveCount(0)
    expect(removed.has("local-skill")).toBe(true)
    expect(errors).toEqual([])
    expect(failedExtensionRequests).toEqual([])
  })

  test("installs the session navigator plugin folder and exposes it as a dock item", async ({ page }) => {
    const pluginSource = "C:/GitRepros/opencode/.opencode/plugin-sources/session-navigator-app"
    const pluginItem = {
      id: "plugin:app:session-navigator-app",
      kind: "plugin",
      name: "Session Navigator",
      target: "app",
      targets: ["app"],
      source: "project",
      scope: "project",
      spec: "./plugins/session-navigator-app",
      path: `${directory}/.opencode/plugins/session-navigator-app`,
      file: `${directory}/.opencode/app.jsonc`,
      configFile: `${directory}/.opencode/app.jsonc`,
      removable: true,
    } satisfies ExtensionItem
    const state = {
      plugins: [] as ExtensionItem[],
      skills: [] as ExtensionItem[],
    }
    let installed = false

    await mockOpenCodeServer(page, {
      directory,
      project: project(),
      provider: provider(),
      sessions: [session()],
      pageMessages: () => ({ items: [] }),
    })
    await mockNavigatorPlugin(page, () => installed)
    await mockExtensionRoutes(page, state, pluginItem, () => {
      installed = true
    })
    await configurePage(page, { desktopPickerPath: pluginSource })

    await page.setViewportSize({ width: 1360, height: 820 })
    await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
    await expect(dockTab(page, "left", "Session Navigator")).toHaveCount(0)

    await addDockPane(page, "right", "Plugin Manager")
    const manager = dockTab(page, "right", "Plugin Manager")
    await expectAppVisible(manager)
    await page.locator('[data-dock-area="right"]').getByRole("button", { name: "Ordner installieren..." }).click()
    await expectAppVisible(page.locator('[data-extension-id="plugin:app:session-navigator-app"]'))
    await manager.getByRole("button", { name: "Close Plugin Manager" }).click()

    await expectAppVisible(dockTab(page, "left", "Session Navigator"))
  })
})

type ExtensionItem = {
  id: string
  kind: "plugin" | "skill"
  name: string
  target?: string
  targets?: string[]
  source: string
  scope: string
  spec?: string
  path?: string
  file?: string
  configFile?: string
  description?: string
  removable: boolean
  reason?: string
}

async function configurePage(page: import("@playwright/test").Page, options?: { desktopPickerPath?: string }) {
  await page.addInitScript(
    ({ dirBase64, directory, server, sessionID, desktopPickerPath }) => {
      if (desktopPickerPath) {
        window.__OPENCODE_TEST_PLATFORM__ = {
          platform: "desktop",
          os: "windows",
          version: "e2e",
          openLink: () => undefined,
          back: () => window.history.back(),
          forward: () => window.history.forward(),
          restart: async () => window.location.reload(),
          notify: async () => undefined,
          openDirectoryPickerDialog: async () => desktopPickerPath,
        }
      }
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: {
            local: [{ worktree: directory, expanded: true, name: "ExtensionManager" }],
          },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", server, dirBase64, sessionId: sessionID }]),
      )
    },
    { dirBase64: base64Encode(directory), directory, server, sessionID, desktopPickerPath: options?.desktopPickerPath },
  )
}

async function addDockPane(page: import("@playwright/test").Page, area: "top" | "left" | "middle" | "right" | "bottom", query: string) {
  await page.locator(`[data-dock-area="${area}"]`).getByRole("button", { name: `Add dock item to ${area}` }).click()
  await page.getByLabel("Search dock items").fill(query)
  await page.keyboard.press("Enter")
}

function dockTab(page: import("@playwright/test").Page, area: "top" | "left" | "middle" | "right" | "bottom", name: string) {
  return page.locator(`[data-dock-area="${area}"] [data-dock-tab]`).filter({ hasText: name }).first()
}

async function mockExtensionRoutes(
  page: import("@playwright/test").Page,
  state: { plugins: ExtensionItem[]; skills: ExtensionItem[] },
  pluginItem: ExtensionItem,
  install: () => void,
) {
  await page.route("**/app/extensions**", async (route) => {
    const url = new URL(route.request().url())
    if (route.request().method() === "GET") return json(route, state)
    if (url.pathname.endsWith("/plugin/install")) {
      install()
      state.plugins = [pluginItem]
      return json(route, { ok: true, item: pluginItem })
    }
    return json(route, { ok: true })
  })
}

async function mockNavigatorPlugin(page: import("@playwright/test").Page, enabled: () => boolean) {
  const body = await fs.readFile(path.resolve("../../.opencode/plugins/session-navigator-app/index.js"), "utf8")
  await page.route("**/experimental/session**", (route) => json(route, []))
  await page.route("**/app/plugins**", (route) =>
    json(route, {
      plugins: enabled()
        ? [
            {
              id: "session-navigator-app",
              spec: "session-navigator-app",
              version: "1",
              module: "/app/plugin/session-navigator-app/1/app.js",
              hash: "navigator",
            },
          ]
        : [],
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

function session() {
  return {
    id: sessionID,
    slug: "extension-manager-session",
    projectID: "proj-extension-manager",
    directory,
    title: "Extension Manager Session",
    version: "dev",
    time: { created: 1700000000000, updated: 1700000000000 },
  }
}

function project() {
  return {
    id: "proj-extension-manager",
    worktree: directory,
    vcs: "git",
    name: "ExtensionManager",
    time: { created: 1700000000000, updated: 1700000000000 },
    sandboxes: [],
  }
}

function provider() {
  return {
    all: [{ id: "opencode", name: "OpenCode", models: { "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude" } } }],
    connected: ["opencode"],
    default: { providerID: "opencode", modelID: "claude-opus-4-6" },
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

function base64Encode(value: string) {
  return Buffer.from(value, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}
