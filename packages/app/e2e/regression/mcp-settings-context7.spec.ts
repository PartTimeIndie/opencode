import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { fixture } from "../smoke/session-timeline.fixture"

test.describe("settings MCP starter", () => {
  test.setTimeout(120_000)

  test("configures Context7 from the website URL through the agent-backed flow", async ({ page }) => {
    const requests: { type: string; body?: unknown; name?: string }[] = []
    const errors: string[] = []
    let globalConfig: Record<string, unknown> = { mcp: {} }
    let mcpStatus: Record<string, unknown> = {}
    page.on("pageerror", (error) => errors.push(error.message))
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text())
    })

    await mockOpenCodeServer(page, {
      sessions: fixture.sessions,
      provider: fixture.provider,
      directory: fixture.directory,
      project: fixture.project,
      pageMessages: () => ({ items: [] }),
      globalConfig: () => globalConfig,
      mcpStatus: () => mcpStatus,
      onGlobalConfigUpdate: (body) => {
        const next = body as { mcp?: Record<string, unknown>; config?: Record<string, unknown> }
        globalConfig = mergeGlobalConfig(globalConfig, next.config ?? next)
        return globalConfig
      },
      onSessionCreate: (body) => {
        requests.push({ type: "session.create", body })
        return {
          id: "ses_mcp_setup",
          slug: "mcp-setup",
          projectID: fixture.project.id,
          directory: fixture.directory,
          title: "Configure MCP: https://context7.com/",
          version: "dev",
          time: { created: Date.now(), updated: Date.now() },
        }
      },
      onSessionPrompt: (input) => {
        requests.push({ type: "v2.session.prompt", body: input.body })
        return {}
      },
      onMcpStarter: (body) => {
        requests.push({ type: "mcp.starter", body })
        return { name: "context7", config: { type: "remote", url: "https://mcp.context7.com/mcp" }, source: "agent" }
      },
      onMcpAdd: (body) => {
        requests.push({ type: "mcp.add", body })
        mcpStatus = { context7: { status: "connected", tools: [] } }
        return { context7: { status: "connected", tools: [] } }
      },
      onMcpConnect: (input) => {
        requests.push({ type: "mcp.connect", name: input.name })
        return true
      },
    })

    await page.goto("/")
    await expect(page.getByText("Settings").last()).toBeVisible()
    await page.getByText("Settings").last().click()
    await page.getByRole("tab", { name: "MCP" }).click()
    await page.getByPlaceholder(/https:\/\/example.com\/mcp/).fill("https://context7.com/")
    await page.getByRole("button", { name: "Add server" }).click()

    await expect(page.getByText("MCP server ready")).toBeVisible()
    await expect(page.getByText("Connected and tested context7.")).toBeVisible()
    await expect(page.getByText("Added MCP server: context7")).toBeVisible()
    await expect(page.getByText("https://mcp.context7.com/mcp")).toBeVisible()
    await page.screenshot({ path: "test-results/mcp-settings-context7.png", fullPage: true })

    expect(requests.map((request) => request.type)).toEqual([
      "session.create",
      "v2.session.prompt",
      "mcp.starter",
      "mcp.add",
      "mcp.connect",
    ])
    expect(requests.find((request) => request.type === "session.create")?.body).toMatchObject({
      agent: "build",
      model: { providerID: "opencode", id: "deepseek-v4-flash-free" },
    })
    expect(requests.find((request) => request.type === "v2.session.prompt")?.body).toMatchObject({
      agent: "build",
      model: { providerID: "opencode", id: "deepseek-v4-flash-free" },
    })
    expect(requests.find((request) => request.type === "mcp.add")?.body).toEqual({
      name: "context7",
      config: { type: "remote", url: "https://mcp.context7.com/mcp" },
    })
    expect(errors).toEqual([])
  })

  test("shows per-project MCP availability choices with All selected by default", async ({ page }) => {
    const otherProject = { id: "proj_unity_other", name: "Unity Tools", worktree: "C:/OpenCode/UnityTools", vcs: "git" }
    const thirdProject = { id: "proj_docs_portal", name: "Docs Portal", worktree: "C:/OpenCode/DocsPortal", vcs: "git" }
    const projects = [fixture.project, otherProject, thirdProject]
    const requests: { type: string; directory?: string; body?: unknown }[] = []
    const runtimeRequests: { type: string; directory: string; name: string }[] = []
    const completedConfigUpdates: string[] = []
    const errors: string[] = []
    const networkFailures: string[] = []
    let holdProjectConfigUpdate = false
    let releaseProjectConfigUpdate: (() => void) | undefined
    let globalConfig: Record<string, unknown> = {
      mcp: {
        unityMCP: { type: "local", command: ["uvx", "mcp-for-unity"], enabled: true },
      },
    }
    const projectConfig = new Map<string, Record<string, unknown>>(projects.map((project) => [project.worktree, globalConfig]))
    const projectMcpEnabled = (directory: string) =>
      (projectConfig.get(directory)?.mcp as Record<string, { enabled?: boolean }> | undefined)?.unityMCP?.enabled
    page.on("pageerror", (error) => errors.push(error.message))
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text())
    })
    page.on("requestfailed", (request) => {
      const url = new URL(request.url())
      if (request.failure()?.errorText === "net::ERR_ABORTED") return
      if (url.port === (process.env.PLAYWRIGHT_SERVER_PORT ?? "4096")) networkFailures.push(`${request.method()} ${url.pathname} ${request.failure()?.errorText ?? "failed"}`)
    })
    page.on("response", (response) => {
      const url = new URL(response.url())
      if (url.port === (process.env.PLAYWRIGHT_SERVER_PORT ?? "4096") && response.status() >= 400) networkFailures.push(`${response.status()} ${url.pathname}`)
    })

    await mockOpenCodeServer(page, {
      sessions: fixture.sessions,
      provider: fixture.provider,
      directory: fixture.directory,
      project: projects,
      pageMessages: () => ({ items: [] }),
      globalConfig: () => globalConfig,
      config: (directory) => projectConfig.get(directory) ?? globalConfig,
      mcpStatus: () => ({ unityMCP: { status: "connected" } }),
      onGlobalConfigUpdate: (body) => {
        requests.push({ type: "global.config.update", body })
        const next = body as { mcp?: Record<string, unknown>; config?: Record<string, unknown> }
        globalConfig = mergeGlobalConfig(globalConfig, next.config ?? next)
        return globalConfig
      },
      onConfigUpdate: async (input) => {
        requests.push({ type: "config.update", directory: input.directory, body: input.body })
        if (holdProjectConfigUpdate) await new Promise<void>((resolve) => (releaseProjectConfigUpdate = resolve))
        const next = input.body as { mcp?: Record<string, unknown>; config?: Record<string, unknown> }
        projectConfig.set(input.directory, next.config ?? next)
        completedConfigUpdates.push(input.directory)
        return projectConfig.get(input.directory)
      },
      onMcpConnect: (input) => {
        runtimeRequests.push({ type: "mcp.connect", directory: input.directory, name: input.name })
        return true
      },
      onMcpDisconnect: (input) => {
        runtimeRequests.push({ type: "mcp.disconnect", directory: input.directory, name: input.name })
        return true
      },
    })

    await page.goto("/")
    await expect(page.getByText("Settings").last()).toBeVisible()
    await page.getByText("Settings").last().click()
    await page.getByRole("tab", { name: "MCP" }).click()

    const row = page.locator(".settings-v2-mcp-row").filter({ hasText: "unityMCP" })
    const trigger = row.getByRole("button", { name: "unityMCP project availability" })
    await expect(row).toBeVisible()
    await expect(row.getByText("uvx mcp-for-unity")).toBeVisible()
    await expect(trigger).toContainText("All projects")

    await trigger.click()
    const content = page.locator(".settings-v2-mcp-select-content")
    const allProjects = page.getByRole("menuitemcheckbox", { name: "All projects" })
    const activeProject = page.getByRole("menuitemcheckbox", { name: fixture.project.name })
    const inactiveProject = page.getByRole("menuitemcheckbox", { name: otherProject.name })
    const thirdProjectItem = page.getByRole("menuitemcheckbox", { name: thirdProject.name })
    await expect(content).toBeVisible()
    const initialTriggerBox = await trigger.boundingBox()
    const initialContentBox = await content.boundingBox()
    expect(initialTriggerBox?.width ?? 0).toBeGreaterThan(120)
    expect(initialContentBox?.width ?? 0).toBeGreaterThanOrEqual(220)
    expect(initialContentBox?.height ?? 0).toBeGreaterThan(80)
    expect((initialContentBox?.y ?? 0) + (initialContentBox?.height ?? 0)).toBeLessThanOrEqual(initialTriggerBox?.y ?? 0)
    await expect(allProjects).toBeChecked()
    await expect(activeProject).toBeChecked()
    await expect(activeProject).toContainText("current")
    await expect(allProjects).toContainText("Selected")
    await expect(activeProject).toContainText("Selected")
    await expect(inactiveProject).toBeChecked()
    await expect(thirdProjectItem).toBeChecked()
    await expect(activeProject.locator('[data-slot="icon-svg"]')).toHaveCSS("opacity", "1")
    await page.screenshot({ path: "test-results/mcp-settings-project-availability-all.png", fullPage: true })

    await allProjects.click()
    await expect(allProjects).not.toBeChecked()
    await expect(activeProject).not.toBeChecked()
    await expect(activeProject).toBeEnabled()
    await expect(activeProject).not.toHaveAttribute("data-checked", "true")
    await expect(inactiveProject).not.toBeChecked()
    await expect(thirdProjectItem).not.toBeChecked()
    await expect(allProjects).toContainText("Off")
    await expect(activeProject).toContainText("Off")
    await expect(inactiveProject).toContainText("Off")
    await expect(activeProject.locator('[data-slot="icon-svg"]')).toHaveCSS("opacity", "0")
    await expect(trigger).toContainText("No projects")
    await expect.poll(() => completedConfigUpdates.length).toBe(3)
    expect(projects.map((project) => projectMcpEnabled(project.worktree))).toEqual([false, false, false])
    await page.screenshot({ path: "test-results/mcp-settings-project-availability-none.png", fullPage: true })

    holdProjectConfigUpdate = true
    await activeProject.click()
    await expect(activeProject).toHaveAttribute("aria-checked", "true", { timeout: 200 })
    await expect(activeProject).toHaveAttribute("data-checked", "true", { timeout: 200 })
    await expect(trigger).toContainText(fixture.project.name, { timeout: 200 })
    await expect(inactiveProject).not.toBeChecked()
    await expect(allProjects).toContainText("Off")
    await expect(activeProject).toContainText("Selected")
    await expect(inactiveProject).toContainText("Off")
    await expect(activeProject.locator('[data-slot="icon-svg"]')).toHaveCSS("opacity", "1")
    await expect(inactiveProject.locator('[data-slot="icon-svg"]')).toHaveCSS("opacity", "0")
    await page.screenshot({ path: "test-results/mcp-settings-project-availability-one.png", fullPage: true })
    await expect.poll(() => (releaseProjectConfigUpdate ? "held" : "waiting")).toBe("held")
    holdProjectConfigUpdate = false
    releaseProjectConfigUpdate?.()
    await expect.poll(() => completedConfigUpdates.filter((directory) => directory === fixture.directory).length).toBe(2)
    expect(projects.map((project) => projectMcpEnabled(project.worktree))).toEqual([true, false, false])

    await inactiveProject.click()
    await expect(inactiveProject).toBeChecked()
    await expect(thirdProjectItem).not.toBeChecked()
    await expect(allProjects).not.toBeChecked()
    await expect(trigger).toContainText("2/3 projects")
    await expect(allProjects).toContainText("Off")
    await expect(activeProject).toContainText("Selected")
    await expect(inactiveProject).toContainText("Selected")
    await expect(thirdProjectItem).toContainText("Off")
    await expect(inactiveProject.locator('[data-slot="icon-svg"]')).toHaveCSS("opacity", "1")
    await expect(thirdProjectItem.locator('[data-slot="icon-svg"]')).toHaveCSS("opacity", "0")
    await expect.poll(() => completedConfigUpdates.filter((directory) => directory === otherProject.worktree).length).toBe(2)
    expect(projects.map((project) => projectMcpEnabled(project.worktree))).toEqual([true, true, false])
    await page.screenshot({ path: "test-results/mcp-settings-project-availability-multiple.png", fullPage: true })

    await allProjects.click()
    await expect(allProjects).toBeChecked()
    await expect(activeProject).toBeChecked()
    await expect(inactiveProject).toBeChecked()
    await expect(thirdProjectItem).toBeChecked()
    await expect(trigger).toContainText("All projects")
    await expect(allProjects).toContainText("Selected")
    await expect(thirdProjectItem).toContainText("Selected")
    await expect.poll(() => completedConfigUpdates.length).toBe(8)
    expect(projects.map((project) => projectMcpEnabled(project.worktree))).toEqual([true, true, true])
    await page.screenshot({ path: "test-results/mcp-settings-project-availability-all-again.png", fullPage: true })

    await allProjects.click()
    await expect(allProjects).not.toBeChecked()
    await expect(activeProject).not.toBeChecked()
    await expect(inactiveProject).not.toBeChecked()
    await expect(thirdProjectItem).not.toBeChecked()
    await expect(activeProject).toBeEnabled()
    await expect(trigger).toContainText("No projects")
    await expect(allProjects).toContainText("Off")
    await expect(activeProject).toContainText("Off")
    await expect(thirdProjectItem).toContainText("Off")
    await expect.poll(() => completedConfigUpdates.length).toBe(11)
    expect(projects.map((project) => projectMcpEnabled(project.worktree))).toEqual([false, false, false])
    await page.screenshot({ path: "test-results/mcp-settings-project-availability.png", fullPage: true })

    await page.getByRole("tab", { name: "General" }).click()
    await page.getByRole("tab", { name: "MCP" }).click()
    await expect(trigger).toContainText("No projects")
    await trigger.click()
    await expect(allProjects).not.toBeChecked()
    await expect(activeProject).not.toBeChecked()
    await expect(inactiveProject).not.toBeChecked()
    await expect(thirdProjectItem).not.toBeChecked()
    await expect(allProjects).toContainText("Off")
    await expect(activeProject).toContainText("Off")
    await page.screenshot({ path: "test-results/mcp-settings-project-availability-reopen-none.png", fullPage: true })

    expect(requests.map((request) => request.type)).toContain("global.config.update")
    expect(requests.map((request) => request.type)).toContain("config.update")
    const mcpConfigUpdate = requests.find(
      (request) =>
        request.type === "global.config.update" &&
        typeof request.body === "object" &&
        request.body !== null &&
        "mcp" in request.body,
    )
    expect(mcpConfigUpdate?.body).toMatchObject({
      mcp: { unityMCP: { type: "local", command: ["uvx", "mcp-for-unity"], enabled: false } },
    })
    const activeProjectUpdates = requests.filter((request) => request.type === "config.update" && request.directory === fixture.directory)
    expect(activeProjectUpdates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          body: expect.objectContaining({
            mcp: expect.objectContaining({
              unityMCP: expect.objectContaining({ type: "local", command: ["uvx", "mcp-for-unity"], enabled: true }),
            }),
          }),
        }),
      ]),
    )
    expect(activeProjectUpdates.at(-1)?.body).toMatchObject({
      mcp: { unityMCP: { enabled: false } },
    })
    expect(requests.toReversed().find((request) => request.type === "config.update" && request.directory === otherProject.worktree)?.body).toMatchObject({
      mcp: { unityMCP: { enabled: false } },
    })
    expect(requests.toReversed().find((request) => request.type === "config.update" && request.directory === thirdProject.worktree)?.body).toMatchObject({
      mcp: { unityMCP: { enabled: false } },
    })
    expect(runtimeRequests).toEqual(
      expect.arrayContaining([
        { type: "mcp.disconnect", directory: fixture.directory, name: "unityMCP" },
        { type: "mcp.disconnect", directory: otherProject.worktree, name: "unityMCP" },
        { type: "mcp.disconnect", directory: thirdProject.worktree, name: "unityMCP" },
        { type: "mcp.connect", directory: fixture.directory, name: "unityMCP" },
        { type: "mcp.connect", directory: otherProject.worktree, name: "unityMCP" },
        { type: "mcp.connect", directory: thirdProject.worktree, name: "unityMCP" },
      ]),
    )
    expect(runtimeRequests.filter((request) => request.type === "mcp.connect" && request.directory === fixture.directory)).toHaveLength(2)
    expect(runtimeRequests.filter((request) => request.type === "mcp.disconnect" && request.directory === fixture.directory)).toHaveLength(2)
    expect(errors).toEqual([])
    expect(networkFailures).toEqual([])
  })

  test("deduplicates long MCP project paths and keeps them readable", async ({ page }) => {
    const longProject = { id: "proj_long_alpha", name: "", worktree: "C:/GitRepros/opencode-git-worktree-alpha", vcs: "git" }
    const duplicateLongProject = { id: "proj_long_alpha_duplicate", name: "", worktree: "C:\\GitRepros\\opencode-git-worktree-alpha", vcs: "git" }
    const siblingProject = { id: "proj_long_beta", name: "", worktree: "C:/GitRepros/opencode-git-worktree-beta", vcs: "git" }
    const posixUpperProject = { id: "proj_posix_upper", name: "", worktree: "/tmp/App", vcs: "git" }
    const posixLowerProject = { id: "proj_posix_lower", name: "", worktree: "/tmp/app", vcs: "git" }
    const projects = [fixture.project, longProject, duplicateLongProject, siblingProject, posixUpperProject, posixLowerProject]
    const errors: string[] = []
    const networkFailures: string[] = []
    const globalConfig = {
      mcp: {
        unityMCP: { type: "local", command: ["uvx", "mcp-for-unity"], enabled: true },
      },
    }
    const projectConfig = new Map(projects.map((project) => [project.worktree, globalConfig]))

    page.on("pageerror", (error) => errors.push(error.message))
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text())
    })
    page.on("requestfailed", (request) => {
      const url = new URL(request.url())
      if (request.failure()?.errorText === "net::ERR_ABORTED") return
      if (url.port === (process.env.PLAYWRIGHT_SERVER_PORT ?? "4096")) networkFailures.push(`${request.method()} ${url.pathname} ${request.failure()?.errorText ?? "failed"}`)
    })
    page.on("response", (response) => {
      const url = new URL(response.url())
      if (url.port === (process.env.PLAYWRIGHT_SERVER_PORT ?? "4096") && response.status() >= 400) networkFailures.push(`${response.status()} ${url.pathname}`)
    })

    await mockOpenCodeServer(page, {
      sessions: fixture.sessions,
      provider: fixture.provider,
      directory: fixture.directory,
      project: projects,
      pageMessages: () => ({ items: [] }),
      globalConfig: () => globalConfig,
      config: (directory) => projectConfig.get(directory) ?? globalConfig,
      mcpStatus: () => ({ unityMCP: { status: "connected" } }),
    })

    await page.goto("/")
    await expect(page.getByText("Settings").last()).toBeVisible()
    await page.getByText("Settings").last().click()
    await page.getByRole("tab", { name: "MCP" }).click()

    const row = page.locator(".settings-v2-mcp-row").filter({ hasText: "unityMCP" })
    const trigger = row.getByRole("button", { name: "unityMCP project availability" })
    await expect(row).toBeVisible()
    await trigger.click()

    const content = page.locator(".settings-v2-mcp-select-content")
    await expect(content).toBeVisible()
    const contentBox = await content.boundingBox()
    expect(contentBox?.width ?? 0).toBeLessThanOrEqual(300)
    await expect(page.locator('.settings-v2-mcp-select-item[title="C:/GitRepros/opencode-git-worktree-alpha"]')).toHaveCount(1)
    await expect(page.locator('.settings-v2-mcp-select-item[title="C:/GitRepros/opencode-git-worktree-beta"]')).toHaveCount(1)
    await expect(page.locator('.settings-v2-mcp-select-item[title="/tmp/App"]')).toHaveCount(1)
    await expect(page.locator('.settings-v2-mcp-select-item[title="/tmp/app"]')).toHaveCount(1)
    await expect(page.locator(".settings-v2-mcp-select-item")).toHaveCount(6)
    await page.screenshot({ path: "test-results/mcp-settings-project-availability-long-paths.png", fullPage: true })

    await page.setViewportSize({ width: 390, height: 844 })
    await expect(content).toBeVisible()
    const mobileContentBox = await content.boundingBox()
    expect(mobileContentBox?.x ?? -1).toBeGreaterThanOrEqual(0)
    expect((mobileContentBox?.x ?? 0) + (mobileContentBox?.width ?? 0)).toBeLessThanOrEqual(390)
    await page.screenshot({ path: "test-results/mcp-settings-project-availability-long-paths-mobile.png", fullPage: true })

    expect(errors).toEqual([])
    expect(networkFailures).toEqual([])
  })

  test("refreshes per-project MCP availability from project configs when cached state is stale", async ({ page }) => {
    const activeProject = { id: "proj_refresh_alpha", name: "Refresh Alpha", worktree: "C:/Refresh/Alpha", vcs: "git" }
    const otherProject = { id: "proj_refresh_beta", name: "Refresh Beta", worktree: "C:/Refresh/Beta", vcs: "git" }
    const thirdProject = { id: "proj_refresh_gamma", name: "Refresh Gamma", worktree: "C:/Refresh/Gamma", vcs: "git" }
    const projects = [activeProject, otherProject, thirdProject]
    const configReads: string[] = []
    const errors: string[] = []
    const networkFailures: string[] = []
    const globalConfig = {
      mcp: {
        unityMCP: { type: "local", command: ["uvx", "mcp-for-unity"], enabled: true },
      },
    }
    const projectConfig = new Map(
      projects.map((project) => [
        project.worktree,
        {
          mcp: {
            unityMCP: { enabled: false },
          },
        },
      ]),
    )

    page.on("pageerror", (error) => errors.push(error.message))
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text())
    })
    page.on("requestfailed", (request) => {
      const url = new URL(request.url())
      if (request.failure()?.errorText === "net::ERR_ABORTED") return
      if (url.port === (process.env.PLAYWRIGHT_SERVER_PORT ?? "4096")) networkFailures.push(`${request.method()} ${url.pathname} ${request.failure()?.errorText ?? "failed"}`)
    })
    page.on("response", (response) => {
      const url = new URL(response.url())
      if (url.port === (process.env.PLAYWRIGHT_SERVER_PORT ?? "4096") && response.status() >= 400) networkFailures.push(`${response.status()} ${url.pathname}`)
    })

    await mockOpenCodeServer(page, {
      sessions: fixture.sessions,
      provider: fixture.provider,
      directory: activeProject.worktree,
      project: projects,
      pageMessages: () => ({ items: [] }),
      globalConfig: () => globalConfig,
      config: (directory) => {
        configReads.push(directory)
        return projectConfig.get(directory) ?? { mcp: {} }
      },
      mcpStatus: () => ({ unityMCP: { status: "connected" } }),
    })

    await page.goto("/")
    await expect(page.getByText("Settings").last()).toBeVisible()
    await page.getByText("Settings").last().click()
    await page.getByRole("tab", { name: "MCP" }).click()

    const row = page.locator(".settings-v2-mcp-row").filter({ hasText: "unityMCP" })
    const trigger = row.getByRole("button", { name: "unityMCP project availability" })
    await expect(row).toBeVisible()
    await expect(trigger).toContainText("No projects")
    await expect.poll(() => projects.every((project) => configReads.includes(project.worktree))).toBe(true)

    await trigger.click()
    await expect(page.getByRole("menuitemcheckbox", { name: "All projects" })).not.toBeChecked()
    await expect(page.getByRole("menuitemcheckbox", { name: activeProject.name })).not.toBeChecked()
    await expect(page.getByRole("menuitemcheckbox", { name: otherProject.name })).not.toBeChecked()
    await expect(page.getByRole("menuitemcheckbox", { name: thirdProject.name })).not.toBeChecked()
    await expect(page.getByRole("menuitemcheckbox", { name: "All projects" })).toContainText("Off")
    await expect(page.getByRole("menuitemcheckbox", { name: activeProject.name })).toContainText("Off")
    await page.screenshot({ path: "test-results/mcp-settings-project-availability-refresh-none.png", fullPage: true })

    expect(errors).toEqual([])
    expect(networkFailures).toEqual([])
  })

  test("prefers local project MCP files over inherited config when reopening availability", async ({ page }) => {
    const activeProject = { id: "proj_local_alpha", name: "Local Alpha", worktree: "C:/Local/Alpha", vcs: "git" }
    const otherProject = { id: "proj_local_beta", name: "Local Beta", worktree: "C:/Local/Beta", vcs: "git" }
    const projects = [activeProject, otherProject]
    const requests: { type: string; directory?: string; body?: unknown }[] = []
    const fileReads: string[] = []
    const errors: string[] = []
    const networkFailures: string[] = []
    let globalConfig: Record<string, unknown> = {
      mcp: {
        unityMCP: { type: "local", command: ["uvx", "mcp-for-unity"], enabled: true },
      },
    }
    const inheritedConfig = {
      mcp: {
        unityMCP: { type: "local", command: ["uvx", "mcp-for-unity"], enabled: true },
      },
    }
    const localProjectConfig = new Map<string, Record<string, unknown>>(projects.map((project) => [project.worktree, inheritedConfig]))

    page.on("pageerror", (error) => errors.push(error.message))
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text())
    })
    page.on("requestfailed", (request) => {
      const url = new URL(request.url())
      if (request.failure()?.errorText === "net::ERR_ABORTED") return
      if (url.port === (process.env.PLAYWRIGHT_SERVER_PORT ?? "4096")) networkFailures.push(`${request.method()} ${url.pathname} ${request.failure()?.errorText ?? "failed"}`)
    })
    page.on("response", (response) => {
      const url = new URL(response.url())
      if (url.port === (process.env.PLAYWRIGHT_SERVER_PORT ?? "4096") && response.status() >= 400) networkFailures.push(`${response.status()} ${url.pathname}`)
    })

    await mockOpenCodeServer(page, {
      sessions: fixture.sessions,
      provider: fixture.provider,
      directory: activeProject.worktree,
      project: projects,
      pageMessages: () => ({ items: [] }),
      globalConfig: () => globalConfig,
      config: () => inheritedConfig,
      mcpStatus: () => ({ unityMCP: { status: "connected" } }),
      onFileRead: ({ directory, path }) => {
        if (path !== ".opencode/opencode.json") return { type: "text", content: "" }
        fileReads.push(directory)
        return { type: "text", content: JSON.stringify(localProjectConfig.get(directory) ?? { mcp: {} }) }
      },
      onGlobalConfigUpdate: (body) => {
        requests.push({ type: "global.config.update", body })
        const next = body as { mcp?: Record<string, unknown>; config?: Record<string, unknown> }
        globalConfig = mergeGlobalConfig(globalConfig, next.config ?? next)
        return globalConfig
      },
      onConfigUpdate: (input) => {
        requests.push({ type: "config.update", directory: input.directory, body: input.body })
        const next = input.body as { mcp?: Record<string, unknown>; config?: Record<string, unknown> }
        localProjectConfig.set(input.directory, next.config ?? next)
        return localProjectConfig.get(input.directory)
      },
    })

    await page.goto("/")
    await expect(page.getByText("Settings").last()).toBeVisible()
    await page.getByText("Settings").last().click()
    await page.getByRole("tab", { name: "MCP" }).click()
    await expect.poll(() => fileReads.length).toBe(2)

    const row = page.locator(".settings-v2-mcp-row").filter({ hasText: "unityMCP" })
    const trigger = row.getByRole("button", { name: "unityMCP project availability" })
    await expect(trigger).toContainText("All projects")
    await trigger.click()
    await page.getByRole("menuitemcheckbox", { name: "All projects" }).click()
    await expect(trigger).toContainText("No projects")
    await expect.poll(() => requests.filter((request) => request.type === "config.update").length).toBe(2)
    await page.waitForTimeout(700)
    await expect(trigger).toContainText("No projects")

    await page.getByRole("tab", { name: "General" }).click()
    await page.getByRole("tab", { name: "MCP" }).click()
    await expect(trigger).toContainText("No projects")
    await trigger.click()
    await expect(page.getByRole("menuitemcheckbox", { name: "All projects" })).not.toBeChecked()
    await expect(page.getByRole("menuitemcheckbox", { name: activeProject.name })).toContainText("Off")
    await expect(page.getByRole("menuitemcheckbox", { name: otherProject.name })).toContainText("Off")
    await page.screenshot({ path: "test-results/mcp-settings-project-availability-local-over-inherited.png", fullPage: true })

    expect(errors).toEqual([])
    expect(networkFailures).toEqual([])
  })

  test("keeps recent project availability edits when stale project reads finish later", async ({ page }) => {
    const activeProject = { id: "proj_race_alpha", name: "Race Alpha", worktree: "C:/Race/Alpha", vcs: "git" }
    const otherProject = { id: "proj_race_beta", name: "Race Beta", worktree: "C:/Race/Beta", vcs: "git" }
    const thirdProject = { id: "proj_race_gamma", name: "Race Gamma", worktree: "C:/Race/Gamma", vcs: "git" }
    const projects = [activeProject, otherProject, thirdProject]
    const requests: { type: string; directory?: string; body?: unknown }[] = []
    const staleReads: string[] = []
    const errors: string[] = []
    const networkFailures: string[] = []
    let releaseStaleReads: (() => void) | undefined
    const staleReadGate = new Promise<void>((resolve) => (releaseStaleReads = resolve))
    const server = { type: "local" as const, command: ["uvx", "mcp-for-unity"], enabled: true }
    let globalConfig: Record<string, unknown> = {
      mcp: {
        unityMCP: server,
      },
    }
    const projectConfig = new Map<string, Record<string, unknown>>(projects.map((project) => [project.worktree, globalConfig]))

    page.on("pageerror", (error) => errors.push(error.message))
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text())
    })
    page.on("requestfailed", (request) => {
      const url = new URL(request.url())
      if (request.failure()?.errorText === "net::ERR_ABORTED") return
      if (url.port === (process.env.PLAYWRIGHT_SERVER_PORT ?? "4096")) networkFailures.push(`${request.method()} ${url.pathname} ${request.failure()?.errorText ?? "failed"}`)
    })
    page.on("response", (response) => {
      const url = new URL(response.url())
      if (url.port === (process.env.PLAYWRIGHT_SERVER_PORT ?? "4096") && response.status() >= 400) networkFailures.push(`${response.status()} ${url.pathname}`)
    })

    await mockOpenCodeServer(page, {
      sessions: fixture.sessions,
      provider: fixture.provider,
      directory: activeProject.worktree,
      project: projects,
      pageMessages: () => ({ items: [] }),
      globalConfig: () => globalConfig,
      config: (directory) => projectConfig.get(directory) ?? globalConfig,
      mcpStatus: () => ({ unityMCP: { status: "connected" } }),
      onFileRead: async ({ directory, path }) => {
        if (path !== ".opencode/opencode.json") return { type: "text", content: "" }
        staleReads.push(directory)
        await staleReadGate
        return { type: "text", content: JSON.stringify({ mcp: { unityMCP: server } }) }
      },
      onGlobalConfigUpdate: (body) => {
        requests.push({ type: "global.config.update", body })
        const next = body as { mcp?: Record<string, unknown>; config?: Record<string, unknown> }
        globalConfig = mergeGlobalConfig(globalConfig, next.config ?? next)
        return globalConfig
      },
      onConfigUpdate: (input) => {
        requests.push({ type: "config.update", directory: input.directory, body: input.body })
        const next = input.body as { mcp?: Record<string, unknown>; config?: Record<string, unknown> }
        projectConfig.set(input.directory, next.config ?? next)
        return projectConfig.get(input.directory)
      },
    })

    await page.goto("/")
    await expect(page.getByText("Settings").last()).toBeVisible()
    await page.getByText("Settings").last().click()
    await page.getByRole("tab", { name: "MCP" }).click()
    await expect.poll(() => staleReads.length).toBe(3)

    const row = page.locator(".settings-v2-mcp-row").filter({ hasText: "unityMCP" })
    const trigger = row.getByRole("button", { name: "unityMCP project availability" })
    await expect(trigger).toContainText("All projects")
    await trigger.click()
    const allProjects = page.getByRole("menuitemcheckbox", { name: "All projects" })
    const activeProjectItem = page.getByRole("menuitemcheckbox", { name: activeProject.name })
    await expect(allProjects).toContainText("Selected")

    await allProjects.click()
    await expect(trigger).toContainText("No projects")
    await expect(activeProjectItem).toContainText("Off")
    expect(projects.map((project) => (projectConfig.get(project.worktree)?.mcp as Record<string, { enabled?: boolean }> | undefined)?.unityMCP?.enabled)).toEqual([
      false,
      false,
      false,
    ])

    releaseStaleReads?.()
    await page.waitForTimeout(500)

    await expect(trigger).toContainText("No projects")
    await expect(allProjects).toContainText("Off")
    await expect(activeProjectItem).toContainText("Off")
    expect(errors).toEqual([])
    expect(networkFailures).toEqual([])
  })
})

function mergeGlobalConfig(current: Record<string, unknown>, patch: Record<string, unknown>) {
  return { ...current, ...patch }
}
