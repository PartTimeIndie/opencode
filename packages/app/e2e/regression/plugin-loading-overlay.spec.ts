import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { trackPageErrors, expectNoSmokeErrors } from "../utils/errors"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/PluginLoadingOverlay"
const projectID = "proj_plugin_loading_overlay"
const sessionID = "ses_plugin_loading_overlay"
const server = "http://127.0.0.1:4096"

test("plugin loading overlay blocks the app and times out", async ({ page }) => {
  const errors = trackPageErrors(page)
  const failedResponses: string[] = []
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`)
  })

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "plugin-loading-overlay",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "overlay-model": { id: "overlay-model", name: "Overlay Model", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "overlay-model" },
    },
    sessions: [
      {
        id: sessionID,
        slug: "plugin-loading-overlay",
        projectID,
        directory,
        title: "Plugin loading overlay regression",
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await mockLoadingOverlayPlugin(page)
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({}))
    localStorage.setItem(
      "opencode.global.dat:plugin-toolbar-visibility",
      JSON.stringify({
        version: 1,
        global: { "loading-overlay-test/showLoadingOverlay": true },
        projects: {},
      }),
    )
  })

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/?dir=${base64Encode(directory)}&session=${sessionID}`)
  await expectAppVisible(page.getByRole("button", { name: "Show Loading Overlay" }))

  await page.getByRole("button", { name: "Show Loading Overlay" }).click()
  const overlay = page.locator('[data-component="app-plugin-loading-overlay"]')
  await expectAppVisible(overlay)
  await expect(overlay).toContainText("Visual QA Loading")
  await expect(overlay).toContainText("Blocking plugin action")
  expect(
    await page.evaluate(() =>
      Boolean(document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.closest('[data-component="app-plugin-loading-overlay"]')),
    ),
  ).toBe(true)
  if (process.env.VISUAL_QA_SCREENSHOT_DIR) {
    await page.screenshot({ path: `${process.env.VISUAL_QA_SCREENSHOT_DIR}/plugin-loading-overlay-desktop.png`, fullPage: true })
  }

  await expect(overlay).toBeHidden({ timeout: 3_000 })
  expectNoSmokeErrors(errors, [], failedResponses)
})

test("slow cold plugin manifests load for the active project with one bounded query", async ({ page }) => {
  const manifestDirectories: string[] = []
  const manifestErrors: string[] = []
  const bootstrapDirectories: string[] = []
  page.on("request", (request) => {
    const url = new URL(request.url())
    if (url.pathname !== "/config") return
    bootstrapDirectories.push(url.searchParams.get("directory") ?? decodeURIComponent(request.headers()["x-opencode-directory"] ?? ""))
  })
  page.on("console", (message) => {
    if (message.type() === "error" && message.text().includes("app plugin manifest")) {
      manifestErrors.push(message.text())
    }
  })
  const projects = Array.from({ length: 10 }, (_, index) => ({
    id: `${projectID}_${index}`,
    worktree: `${directory}_${index}`,
    vcs: "git",
    name: `plugin-loading-overlay-${index}`,
    time: { created: 1700000000000 + index, updated: 1700000000000 + index },
    sandboxes: [],
  }))
  const activeDirectory = projects[0]!.worktree

  await mockOpenCodeServer(page, {
    directory: activeDirectory,
    project: projects,
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "overlay-model": { id: "overlay-model", name: "Overlay Model", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "overlay-model" },
    },
    sessions: [
      {
        id: sessionID,
        slug: "plugin-loading-overlay",
        projectID: projects[0]!.id,
        directory: activeDirectory,
        title: "Plugin manifest performance",
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await page.route("**/app/plugins**", async (route) => {
    manifestDirectories.push(new URL(route.request().url()).searchParams.get("directory") ?? "")
    await new Promise((resolve) => setTimeout(resolve, 11_000))
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ plugins: [] }),
    })
  })
  await page.addInitScript(
    ({ projects }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { local: projects.map((project) => ({ worktree: project.worktree, expanded: true })) } }),
      )
    },
    { projects },
  )

  await page.setViewportSize({ width: 1280, height: 720 })
  const manifestLoaded = page.waitForResponse((response) => new URL(response.url()).pathname === "/app/plugins")
  await page.goto(`/?dir=${base64Encode(activeDirectory)}&session=${sessionID}`)
  await expectAppVisible(page.getByRole("heading", { name: "Plugin manifest performance" }))

  expect((await manifestLoaded).status()).toBe(200)
  await expect.poll(() => manifestDirectories).toEqual([activeDirectory])
  expect(manifestErrors).toEqual([])
  const refreshed = page.waitForResponse((response) => new URL(response.url()).pathname === "/config")
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")))
  expect((await refreshed).status()).toBe(200)
  expect([...new Set(bootstrapDirectories)]).toEqual([activeDirectory])
})

test("retries a failed plugin manifest without blocking the session timeline", async ({ page }) => {
  const attempts: number[] = []
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "plugin-loading-overlay",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [{
        id: "opencode",
        name: "OpenCode",
        models: { "overlay-model": { id: "overlay-model", name: "Overlay Model", limit: { context: 200_000 } } },
      }],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "overlay-model" },
    },
    sessions: [{
      id: sessionID,
      slug: "plugin-loading-overlay",
      projectID,
      directory,
      title: "Plugin manifest retry",
      version: "dev",
      time: { created: 1700000000000, updated: 1700000000000 },
    }],
    pageMessages: () => ({ items: [] }),
  })
  await page.route("**/app/plugins**", (route) => {
    attempts.push(Date.now())
    if (attempts.length === 1) return route.abort("failed")
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ plugins: [] }) })
  })

  await page.goto(`/?dir=${base64Encode(directory)}&session=${sessionID}`)
  await expectAppVisible(page.getByRole("heading", { name: "Plugin manifest retry" }))
  await expect.poll(() => attempts.length, { timeout: 12_000 }).toBe(2)
  expect(attempts[1]! - attempts[0]!).toBeGreaterThanOrEqual(4_500)
})

test("switches project manifests and disposes stale local contributions", async ({ page }) => {
  const directoryA = `${directory}_switch_a`
  const directoryB = `${directory}_switch_b`
  const sessionA = `${sessionID}_switch_a`
  const sessionB = `${sessionID}_switch_b`
  const manifestDirectories: string[] = []
  const projects = [
    {
      id: `${projectID}_switch_a`,
      worktree: directoryA,
      vcs: "git",
      name: "Plugin project A",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    {
      id: `${projectID}_switch_b`,
      worktree: directoryB,
      vcs: "git",
      name: "Plugin project B",
      time: { created: 1700000000001, updated: 1700000000001 },
      sandboxes: [],
    },
  ]
  const sessions = [
    {
      id: sessionA,
      slug: "plugin-project-a",
      projectID: projects[0]!.id,
      directory: directoryA,
      title: "Plugin project A session",
      version: "dev",
      time: { created: 1700000000000, updated: 1700000000000 },
    },
    {
      id: sessionB,
      slug: "plugin-project-b",
      projectID: projects[1]!.id,
      directory: directoryB,
      title: "Plugin project B session",
      version: "dev",
      time: { created: 1700000000001, updated: 1700000000001 },
    },
  ]

  await mockOpenCodeServer(page, {
    directory: directoryA,
    project: projects,
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "overlay-model": { id: "overlay-model", name: "Overlay Model", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "overlay-model" },
    },
    sessions,
    pageMessages: () => ({ items: [] }),
  })
  await page.route("**/app/plugins**", (route) => {
    const activeDirectory = new URL(route.request().url()).searchParams.get("directory") ?? ""
    manifestDirectories.push(activeDirectory)
    const local = activeDirectory === directoryA ? "local-a" : activeDirectory === directoryB ? "local-b" : undefined
    const plugins = ["global-plugin", ...(local ? [local] : [])].map((id) => ({
      id,
      spec: id,
      version: "1",
      module: `/app/plugin/${id}/1/index.js`,
      hash: id,
    }))
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ plugins }),
    })
  })
  await page.route("**/app/plugin/*/1/index.js**", (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-3)!
    const title = id === "global-plugin" ? "Global plugin control" : id === "local-a" ? "Local A control" : "Local B control"
    return route.fulfill({
      status: 200,
      contentType: "text/javascript",
      body:
        id === "global-plugin"
          ? navigationToolbarPluginModule({ directoryA, directoryB, sessionA, sessionB })
          : toolbarPluginModule(
              id,
              title,
              `api.lifecycle.onDispose(() => {
                globalThis.__pluginDisposals ??= []
                globalThis.__pluginDisposals.push(${JSON.stringify(id)})
              })`,
            ),
    })
  })
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({}))
    localStorage.setItem(
      "opencode.global.dat:plugin-toolbar-visibility",
      JSON.stringify({
        version: 1,
        global: {
          "global-plugin/control": true,
          "global-plugin/openA": true,
          "global-plugin/openB": true,
          "local-a/control": true,
          "local-b/control": true,
        },
        projects: {},
      }),
    )
  })

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto("/")
  await expect.poll(() => manifestDirectories).toEqual([""])
  await page.getByRole("button", { name: /Plugin project A session/ }).click()
  await expectAppVisible(page.getByRole("heading", { name: "Plugin project A session" }))
  await expectAppVisible(page.getByRole("button", { name: "Global plugin control" }))
  await expectAppVisible(page.getByRole("button", { name: "Local A control" }))
  await expect(page.getByRole("button", { name: "Local B control" })).toHaveCount(0)
  await expect.poll(() => manifestDirectories).toEqual(["", directoryA])

  await page.getByRole("button", { name: "Open project B session" }).click()
  await expectAppVisible(page.getByRole("heading", { name: "Plugin project B session" }))
  await expectAppVisible(page.getByRole("button", { name: "Local B control" }))
  await expect(page.getByRole("button", { name: "Local A control" })).toHaveCount(0)
  await expect.poll(() => manifestDirectories).toEqual(["", directoryA, directoryB])
  await expect
    .poll(() => page.evaluate(() => (globalThis as typeof globalThis & { __pluginDisposals?: string[] }).__pluginDisposals ?? []))
    .toContain("local-a")

  await page.locator(`[data-dock-tab][data-session-id="${sessionA}"]`).getByRole("tab").click()
  await expectAppVisible(page.getByRole("button", { name: "Local A control" }))
  await expect(page.getByRole("button", { name: "Local B control" })).toHaveCount(0)
  await expect.poll(() => manifestDirectories).toEqual(["", directoryA, directoryB, directoryA])

  await page.locator(`[data-dock-tab][data-session-id="${sessionB}"]`).getByRole("tab").click()
  await expectAppVisible(page.getByRole("button", { name: "Local B control" }))
  await expect(page.getByRole("button", { name: "Local A control" })).toHaveCount(0)
  await expect.poll(() => manifestDirectories).toEqual(["", directoryA, directoryB, directoryA, directoryB])

  await page.getByRole("button", { name: "Home", exact: true }).click()
  await expect(page.getByRole("button", { name: "Local A control" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Local B control" })).toHaveCount(0)
  await expect.poll(() => manifestDirectories).toEqual([
    "",
    directoryA,
    directoryB,
    directoryA,
    directoryB,
    "",
  ])
  await expect
    .poll(() => page.evaluate(() => (globalThis as typeof globalThis & { __pluginDisposals?: string[] }).__pluginDisposals ?? []))
    .toContain("local-b")
})

test("does not let a stale async plugin activation win a project switch", async ({ page }) => {
  const directoryA = `${directory}_race_a`
  const directoryB = `${directory}_race_b`
  const sessionA = `${sessionID}_race_a`
  const sessionB = `${sessionID}_race_b`
  const manifestDirectories: string[] = []
  const errors = trackPageErrors(page)
  const projects = [
    {
      id: `${projectID}_race_a`,
      worktree: directoryA,
      vcs: "git",
      name: "Plugin race A",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    {
      id: `${projectID}_race_b`,
      worktree: directoryB,
      vcs: "git",
      name: "Plugin race B",
      time: { created: 1700000000001, updated: 1700000000001 },
      sandboxes: [],
    },
  ]
  const sessions = [
    {
      id: sessionA,
      slug: "plugin-race-a",
      projectID: projects[0]!.id,
      directory: directoryA,
      title: "Plugin race A session",
      version: "dev",
      time: { created: 1700000000000, updated: 1700000000000 },
    },
    {
      id: sessionB,
      slug: "plugin-race-b",
      projectID: projects[1]!.id,
      directory: directoryB,
      title: "Plugin race B session",
      version: "dev",
      time: { created: 1700000000001, updated: 1700000000001 },
    },
  ]

  await mockOpenCodeServer(page, {
    directory: directoryA,
    project: projects,
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: { "overlay-model": { id: "overlay-model", name: "Overlay Model", limit: { context: 200_000 } } },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "overlay-model" },
    },
    sessions,
    pageMessages: () => ({ items: [] }),
  })
  page.on("request", (request) => {
    const url = new URL(request.url())
    if (url.pathname === "/app/plugins") manifestDirectories.push(url.searchParams.get("directory") ?? "")
  })
  await page.route("**/app/plugins**", (route) => {
    const activeDirectory = new URL(route.request().url()).searchParams.get("directory")
    const variant = activeDirectory === directoryB ? "b" : "a"
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        plugins: [
          {
            id: "navigation-plugin",
            spec: "navigation-plugin",
            version: "1",
            module: "/app/plugin/navigation-plugin/1/index.js",
            hash: "navigation",
          },
          {
            id: "race-plugin",
            spec: "race-plugin",
            version: "1",
            module: `/app/plugin/race-plugin/1/index-${variant}.js`,
            hash: variant,
          },
        ],
      }),
    })
  })
  await page.route("**/app/plugin/navigation-plugin/1/index.js**", (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript", body: raceNavigationPluginModule({ directoryB, sessionB }) }),
  )
  await page.route("**/app/plugin/race-plugin/1/index-*.js**", (route) => {
    const variant = new URL(route.request().url()).pathname.endsWith("index-b.js") ? "b" : "a"
    return route.fulfill({
      status: 200,
      contentType: "text/javascript",
      body: racePluginModule({ variant }),
    })
  })
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({}))
    localStorage.setItem(
      "opencode.global.dat:plugin-toolbar-visibility",
      JSON.stringify({ version: 1, global: { "navigation-plugin/openB": true, "race-plugin/race": true }, projects: {} }),
    )
  })

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/?dir=${base64Encode(directoryA)}&session=${sessionA}`)
  await expectAppVisible(page.getByRole("heading", { name: "Plugin race A session" }))
  await expect.poll(() => manifestDirectories).toContain(directoryA)
  await expect
    .poll(() => page.evaluate(() => Boolean((globalThis as typeof globalThis & { __raceStarted?: boolean }).__raceStarted)))
    .toBe(true)

  await expectAppVisible(page.getByRole("button", { name: "Open plugin race B" }))
  await page.getByRole("button", { name: "Open plugin race B" }).click()
  await expectAppVisible(page.getByRole("heading", { name: "Plugin race B session" }))
  await expectAppVisible(page.getByRole("button", { name: "Race plugin B" }))
  await page.evaluate(() => (globalThis as typeof globalThis & { __releaseRaceA?: () => void }).__releaseRaceA?.())
  await expect(page.getByRole("button", { name: "Race plugin A" })).toHaveCount(0)
  await page.waitForTimeout(500)
  if (!(await page.getByRole("button", { name: "Race plugin B" }).isVisible())) {
    const disposals = await page.evaluate(
      () => (globalThis as typeof globalThis & { __pluginDisposals?: string[] }).__pluginDisposals ?? [],
    )
    throw new Error(`race B was disposed or removed: ${JSON.stringify({ disposals, errors, manifestDirectories })}`)
  }
  await expect
    .poll(() => page.evaluate(() => (globalThis as typeof globalThis & { __pluginDisposals?: string[] }).__pluginDisposals ?? []))
    .toContain("race-a")
  expectNoSmokeErrors(errors, [], [])
})

test("rejects mismatched plugin ids and removes partial activation state", async ({ page }) => {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "plugin-loading-overlay",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "overlay-model": { id: "overlay-model", name: "Overlay Model", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "overlay-model" },
    },
    sessions: [
      {
        id: sessionID,
        slug: "plugin-loading-overlay",
        projectID,
        directory,
        title: "Plugin activation cleanup",
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await page.route("**/app/plugins**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        plugins: ["good-plugin", "partial-plugin", "mismatch-plugin"].map((id) => ({
          id,
          spec: id,
          version: "1",
          module: `/app/plugin/${id}/1/index.js`,
          hash: id,
        })),
      }),
    }),
  )
  await page.route("**/app/plugin/*/1/index.js**", (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-3)
    const body =
      id === "good-plugin"
        ? toolbarPluginModule("good-plugin", "Good plugin control")
        : id === "partial-plugin"
          ? toolbarPluginModule("partial-plugin", "Leaked partial control", 'throw new Error("partial activation")')
          : toolbarPluginModule("forged-plugin", "Mismatched plugin control")
    return route.fulfill({ status: 200, contentType: "text/javascript", body })
  })
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({}))
    localStorage.setItem(
      "opencode.global.dat:plugin-toolbar-visibility",
      JSON.stringify({
        version: 1,
        global: {
          "good-plugin/control": true,
          "partial-plugin/control": true,
          "mismatch-plugin/control": true,
          "forged-plugin/control": true,
        },
        projects: {},
      }),
    )
  })

  await page.goto(`/?dir=${base64Encode(directory)}&session=${sessionID}`)
  await expectAppVisible(page.getByRole("button", { name: "Good plugin control" }))
  await expect(page.getByRole("button", { name: "Leaked partial control" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Mismatched plugin control" })).toHaveCount(0)
})

test("plugin manifests and directory sync stay bounded with many open session tabs", async ({ page }) => {
  const manifestDirectories: string[] = []
  const directorySyncRequests: Array<{ endpoint: string; directory: string }> = []
  const projects = Array.from({ length: 20 }, (_, index) => ({
    id: `${projectID}_fanout_${index}`,
    worktree: `${directory}_fanout_${index}`,
    vcs: "git",
    name: `plugin-loading-fanout-${index}`,
    time: { created: 1700000000000 + index, updated: 1700000000000 + index },
    sandboxes: [],
  }))
  const activeDirectory = projects[0]!.worktree
  const sessions = projects.map((project, index) => ({
    id: `${sessionID}_fanout_${index}`,
    slug: `plugin-loading-fanout-${index}`,
    projectID: project.id,
    directory: project.worktree,
    title: `Plugin manifest fanout ${index}`,
    version: "dev",
    time: { created: 1700000000000 + index, updated: 1700000000000 + index },
  }))

  page.on("request", (request) => {
    const url = new URL(request.url())
    if (url.port !== "4096") return
    if (!["/path", "/lsp", "/provider"].includes(url.pathname)) return
    const directory = url.searchParams.get("directory")
    if (directory) directorySyncRequests.push({ endpoint: url.pathname, directory })
  })

  await mockOpenCodeServer(page, {
    directory: activeDirectory,
    project: projects,
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "overlay-model": { id: "overlay-model", name: "Overlay Model", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "overlay-model" },
    },
    sessions,
    pageMessages: () => ({ items: [] }),
  })
  await page.route("**/app/plugins**", (route) => {
    manifestDirectories.push(new URL(route.request().url()).searchParams.get("directory") ?? "")
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ plugins: [] }),
    })
  })
  await page.addInitScript(
    ({ activeDirectory, projects, server, sessions }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { local: projects.map((project) => ({ worktree: project.worktree, expanded: true })) } }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify(
          sessions.map((session) => ({
            type: "session",
            server,
            dirBase64: btoa(session.directory).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, ""),
            sessionId: session.id,
          })),
        ),
      )
      localStorage.setItem("opencode.global.dat:tabs.recent", JSON.stringify({ key: `${server}\n/${btoa(activeDirectory).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")}/session/${sessions[0].id}` }))
    },
    { activeDirectory, projects, server, sessions },
  )

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/?dir=${base64Encode(activeDirectory)}&session=${sessions[0]!.id}`)
  await expectAppVisible(page.getByRole("heading", { name: "Plugin manifest fanout 0" }))

  await expect.poll(() => manifestDirectories, { timeout: 10_000 }).toEqual([activeDirectory])
  expect(new Set(directorySyncRequests.map((request) => request.directory))).toEqual(new Set([activeDirectory]))
})

test("plugin manifests load for the active draft project on new session", async ({ page }) => {
  const manifestDirectories: string[] = []
  const projects = Array.from({ length: 10 }, (_, index) => ({
    id: `${projectID}_draft_${index}`,
    worktree: `${directory}_draft_${index}`,
    vcs: "git",
    name: `plugin-loading-draft-${index}`,
    time: { created: 1700000000000 + index, updated: 1700000000000 + index },
    sandboxes: [],
  }))
  const activeDirectory = projects[4]!.worktree
  const draftID = "draft-plugin-loading-overlay"

  await mockOpenCodeServer(page, {
    directory: activeDirectory,
    project: projects,
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "overlay-model": { id: "overlay-model", name: "Overlay Model", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "overlay-model" },
    },
    sessions: [],
    pageMessages: () => ({ items: [] }),
  })
  await page.route("**/app/plugins**", (route) => {
    manifestDirectories.push(new URL(route.request().url()).searchParams.get("directory") ?? "")
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ plugins: [] }),
    })
  })
  await page.addInitScript(
    ({ activeDirectory, draftID, projects, server }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { local: projects.map((project) => ({ worktree: project.worktree, expanded: true })) } }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "draft", draftID, server, dirBase64: btoa(activeDirectory), directory: activeDirectory }]),
      )
    },
    { activeDirectory, draftID, projects, server },
  )

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto("/")
  const composer = page.locator('[data-component="session-new-composer"]')
  await expectAppVisible(composer)
  await composer.locator('[data-component="prompt-input"]').click()
  if (process.env.VISUAL_QA_SCREENSHOT_DIR) {
    await page.screenshot({ path: `${process.env.VISUAL_QA_SCREENSHOT_DIR}/new-session-draft-clickable.png`, fullPage: true })
  }

  await expect.poll(() => manifestDirectories).toEqual([activeDirectory])
  expect(
    await page.evaluate(() =>
      Boolean(document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.closest('[data-component="app-plugin-loading-overlay"]')),
    ),
  ).toBe(false)
})

async function mockLoadingOverlayPlugin(page: Page) {
  await page.route("**/app/plugins**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({
        plugins: [
          {
            id: "loading-overlay-test",
            spec: "loading-overlay-test",
            version: "1",
            module: "/app/plugin/loading-overlay-test/1/index.js",
            hash: "loading-overlay-test",
          },
        ],
      }),
    }),
  )
  await page.route("**/app/plugin/loading-overlay-test/1/index.js**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/javascript",
      headers: { "access-control-allow-origin": "*" },
      body: loadingOverlayPlugin(),
    }),
  )
}

function loadingOverlayPlugin() {
  return `
    export default {
      id: "loading-overlay-test",
      app(api) {
        api.toolbar.register({
          id: "showLoadingOverlay",
          title: "Show Loading Overlay",
          placement: "composer",
          align: "right",
          order: 1,
          icon: { name: "code" },
          run() {
            return api.ui.loading.with(
              {
                title: "Visual QA Loading",
                message: "Blocking plugin action",
                timeoutMs: 1000,
              },
              () => new Promise((resolve) => setTimeout(resolve, 1500)),
            )
          },
        })
      },
    }
  `
}

function toolbarPluginModule(id: string, title: string, afterRegister = "") {
  return `
    export default {
      id: ${JSON.stringify(id)},
      app(api) {
        api.toolbar.register({
          id: "control",
          title: ${JSON.stringify(title)},
          placement: "top",
          run() {},
        })
        ${afterRegister}
      },
    }
  `
}

function navigationToolbarPluginModule(input: {
  directoryA: string
  directoryB: string
  sessionA: string
  sessionB: string
}) {
  return `
    export default {
      id: "global-plugin",
      app(api) {
        api.toolbar.register({
          id: "control",
          title: "Global plugin control",
          placement: "top",
          run() {},
        })
        api.toolbar.register({
          id: "openA",
          title: "Open project A session",
          placement: "top",
          run() {
            api.host.navigation.openSession({
              directory: ${JSON.stringify(input.directoryA)},
              sessionID: ${JSON.stringify(input.sessionA)},
            })
          },
        })
        api.toolbar.register({
          id: "openB",
          title: "Open project B session",
          placement: "top",
          run() {
            api.host.navigation.openSession({
              directory: ${JSON.stringify(input.directoryB)},
              sessionID: ${JSON.stringify(input.sessionB)},
            })
          },
        })
        api.lifecycle.onDispose(() => {
          globalThis.__pluginDisposals ??= []
          globalThis.__pluginDisposals.push("global-plugin")
        })
      },
    }
  `
}

function raceNavigationPluginModule(input: { directoryB: string; sessionB: string }) {
  return `
    export default {
      id: "navigation-plugin",
      app(api) {
        api.toolbar.register({
          id: "openB",
          title: "Open plugin race B",
          placement: "top",
          run() {
            api.host.navigation.openSession({ directory: ${JSON.stringify(input.directoryB)}, sessionID: ${JSON.stringify(input.sessionB)} })
          },
        })
      },
    }
  `
}

function racePluginModule(input: { variant: "a" | "b" }) {
  if (input.variant === "b")
    return `
      export default {
        id: "race-plugin",
        app(api) {
          api.toolbar.register({ id: "race", title: "Race plugin B", placement: "top", run() {} })
          api.lifecycle.onDispose(() => {
            globalThis.__pluginDisposals ??= []
            globalThis.__pluginDisposals.push("race-b")
          })
        },
      }
    `
  return `
    export default {
      id: "race-plugin",
      app(api) {
        api.toolbar.register({ id: "race", title: "Race plugin A", placement: "top", run() {} })
        globalThis.__raceStarted = true
        globalThis.__releaseRaceA = () => undefined
        return new Promise((resolve) => {
          globalThis.__releaseRaceA = resolve
        })
          .then(() => {
            api.lifecycle.onDispose(() => {
              globalThis.__pluginDisposals ??= []
              globalThis.__pluginDisposals.push("race-a")
            })
          })
      },
    }
  `
}
