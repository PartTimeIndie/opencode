import { expect, test, type CDPSession, type Locator, type Page, type Route } from "@playwright/test"
import fs from "node:fs/promises"
import path from "node:path"
import { mockOpenCodeServer } from "../utils/mock-server"
import { trackPageErrors, expectNoSmokeErrors } from "../utils/errors"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/GitWorkbench"
const secondaryDirectory = "C:/OpenCode/GitWorkbenchSecondary"
const nestedDirectory = `${directory}/packages/NestedWorkbench`
const deepNestedDirectory = `${directory}/tools/deep/DeepWorkbench`
const projectID = "proj_git_workbench"
const secondaryProjectID = "proj_git_workbench_secondary"
const sessionID = "ses_git_workbench"
const secondarySessionID = "ses_git_workbench_secondary"
const server = "http://127.0.0.1:4096"
const performanceDir = "e2e/test-results/git-workbench-performance"

test.use({ video: "on", screenshot: "on" })

type GitWorkbenchPerfMetrics = {
  longTasks: { duration: number; name: string; startTime: number }[]
  maxHeartbeatDelay: number
}

test.describe("git workbench app plugin", () => {
  test("docks the plugin, runs composer commit, and exposes git history actions", async ({ page }) => {
    await page.addInitScript(() => {
      window.prompt = () => {
        throw new Error("browser prompt must not be used")
      }
    })
    const errors = trackPageErrors(page)
    const networkFailures: string[] = []
    const actions: string[] = []
    const actionPayloads: Record<string, unknown>[] = []
    const snapshot = gitSnapshot()
    const snapshotDelays: Record<string, number> = {}
    page.on("requestfailed", (request) =>
      networkFailures.push(`${request.failure()?.errorText ?? "failed"} ${request.url()}`),
    )
    page.on("response", (response) => {
      if (response.status() >= 400)
        networkFailures.push(`${response.status()} ${response.request().method()} ${response.url()}`)
    })

    await mockOpenCodeServer(page, {
      directory,
      project: [project(), secondaryProject()],
      provider: provider(),
      sessions: [session(), secondarySession()],
      pageMessages: () => ({ items: [] }),
    })
    await mockGitWorkbenchPlugin(page)
    await mockGitApi(
      page,
      {
        [directory]: snapshot,
        [secondaryDirectory]: gitSnapshot({
          worktree: secondaryDirectory,
          branch: "secondary-workbench",
          status: [gitFile("packages/app/src/plugin/secondary-workbench.ts")],
        }),
        [nestedDirectory]: gitSnapshot({ worktree: nestedDirectory, branch: "nested-workbench", status: [] }),
        [deepNestedDirectory]: gitSnapshot({ worktree: deepNestedDirectory, branch: "deep-workbench", status: [] }),
      },
      actions,
      actionPayloads,
      {
        snapshotDelays,
        discoveredRepositories: [
          { worktree: directory.toLowerCase(), name: "Duplicate current repository" },
          { worktree: nestedDirectory, name: "Nested Workbench" },
          { worktree: deepNestedDirectory, name: "Deep Workbench" },
        ],
      },
    )
    await configurePage(page)
    await installPerformanceProbe(page)

    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
    await hideDebugBar(page)
    await prepareDockPaneSelection(page, "left", "gitWorkbench")

    const client = await startPerformanceCapture(page)
    const openStart = await page.evaluate(() => performance.now())
    await page.keyboard.press("Enter")

    const workbench = page.locator(".oc-git-workbench")
    const topToolbarCommit = page
      .locator('[data-component="plugin-toolbar-outlet"][data-plugin-toolbar-placement="top"]')
      .getByRole("button", { name: "Commit All Open Changes", exact: true })
    const composerCommit = page
      .locator(
        '[data-component="plugin-toolbar-outlet"][data-plugin-toolbar-placement="composer"][data-plugin-toolbar-align="right"]',
      )
      .getByRole("button", { name: "Commit All Open Changes", exact: true })
    await expectAppVisible(workbench)
    const openLatency = await page.evaluate((started) => performance.now() - started, openStart)
    const { profile, performanceMetrics, metrics } = await stopPerformanceCapture(page, client)
    await fs.mkdir(performanceDir, { recursive: true })
    await fs.writeFile(
      `${performanceDir}/metrics.json`,
      JSON.stringify(
        { latencies: [{ interaction: "git-workbench-open", duration: openLatency }], metrics, performanceMetrics },
        null,
        2,
      ),
    )
    await fs.writeFile(`${performanceDir}/cpu-profile.json`, JSON.stringify(profile, null, 2))
    await page.screenshot({ path: `${performanceDir}/desktop.png`, fullPage: true })
    expect(openLatency).toBeLessThan(300)
    expect(metrics.longTasks.filter((entry) => entry.duration > 200)).toEqual([])
    expect(metrics.maxHeartbeatDelay).toBeLessThan(500)
    await expect(topToolbarCommit).toHaveCount(0)
    await expectAppVisible(composerCommit)
    await expect(composerCommit).toBeEnabled()
    await expectComposerCommitBesideSend(page)
    await expectAppVisible(
      workbench.locator(".oc-git-workbench__title").getByText("git-workbench-test", { exact: true }),
    )
    const projectSelect = workbench.getByLabel("Git Workbench project")
    await expect(projectSelect).toHaveValue(directory)
    await expect(projectSelect.locator("optgroup")).toHaveCount(2)
    await expect(projectSelect.locator('optgroup[label="Open projects"] option')).toHaveText([
      "Git Workbench",
      "Git Workbench Secondary",
    ])
    await expect(projectSelect.locator('optgroup[label="Discovered repositories"] option')).toHaveText([
      "Deep Workbench",
      "Nested Workbench",
    ])
    await projectSelect.evaluate((select) => {
      const target = select as HTMLSelectElement
      target.size = 6
      target.style.height = "128px"
      target.style.minWidth = "190px"
    })
    await page.screenshot({ path: "e2e/test-results/git-workbench-repository-picker-desktop.png", fullPage: true })
    await projectSelect.evaluate((select) => {
      select.removeAttribute("size")
      select.removeAttribute("style")
    })
    const projectTheme = await projectSelectTheme(projectSelect)
    expect(projectTheme.rootColorScheme).toBe("dark")
    expect(projectTheme.selectColorScheme).toBe(projectTheme.rootColorScheme)
    expect(projectTheme.selectBackground).toBe(projectTheme.surfacePanel)
    expect(projectTheme.selectColor).toBe(projectTheme.textBase)
    expect(projectTheme.unselectedOptionBackground).toBe(projectTheme.surfacePanel)
    expect(projectTheme.unselectedOptionColor).toBe(projectTheme.textBase)
    expect(projectTheme.unselectedOptionBackground).not.toBe("rgb(255, 255, 255)")
    const consoleErrorsBeforeConfigError = errors.length
    const networkFailuresBeforeConfigError = networkFailures.length
    const configErrorRoute = (route: Route) => {
      const pathname = new URL(route.request().url()).pathname
      if (pathname.endsWith("/action") || pathname.endsWith("/discover")) return route.fallback()
      return route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          name: "ConfigInvalidError",
          data: {
            path: "C:\\OpenCode\\GitWorkbench\\.opencode\\agents\\git-agent.md",
            issues: [{ path: ["tools", "mode"], message: 'Expected boolean, got "explicit"' }],
          },
        }),
      })
    }
    await page.route("**/vcs/git**", configErrorRoute)
    await workbench.getByRole("button", { name: "Refresh" }).click()
    await expect(workbench.locator(".oc-git-workbench__callout--error")).toHaveText(
      'Config file at C:\\OpenCode\\GitWorkbench\\.opencode\\agents\\git-agent.md is invalid: tools.mode: Expected boolean, got "explicit"',
    )
    expect(errors.splice(consoleErrorsBeforeConfigError)).toEqual([
      "Failed to load resource: the server responded with a status of 400 (Bad Request)",
    ])
    expect(networkFailures.splice(networkFailuresBeforeConfigError)).toEqual([
      expect.stringMatching(/^400 GET .*\/vcs\/git\?/),
    ])
    await page.unroute("**/vcs/git**", configErrorRoute)
    await workbench.getByRole("button", { name: "Refresh" }).click()
    await expect(workbench.locator(".oc-git-workbench__callout--error")).toHaveCount(0)
    await projectSelect.selectOption(nestedDirectory)
    await expect(projectSelect).toHaveValue(nestedDirectory)
    await expectAppVisible(workbench.locator(".oc-git-workbench__title").getByText("nested-workbench", { exact: true }))
    await projectSelect.selectOption(secondaryDirectory)
    await expect(projectSelect).toHaveValue(secondaryDirectory)
    await expectAppVisible(
      workbench.locator(".oc-git-workbench__title").getByText("secondary-workbench", { exact: true }),
    )
    await workbench.getByRole("button", { name: "Stage all", exact: true }).click()
    await expect.poll(() => lastAction(actionPayloads, "stage")?.directory).toBe(secondaryDirectory)
    snapshotDelays[secondaryDirectory] = 250
    await workbench.getByRole("button", { name: "Refresh" }).click()
    await page.getByRole("tab", { name: /Git Workbench QA/ }).click()
    await expect(projectSelect).toHaveValue(directory)
    await expectAppVisible(
      workbench.locator(".oc-git-workbench__title").getByText("git-workbench-test", { exact: true }),
    )
    await page.waitForTimeout(300)
    await expect(projectSelect).toHaveValue(directory)
    await expectAppVisible(
      workbench.locator(".oc-git-workbench__title").getByText("git-workbench-test", { exact: true }),
    )
    snapshotDelays[secondaryDirectory] = 0
    await expectGitWorkbenchTreeVisuals(workbench)
    const contextFile = workbench.locator(".oc-git-workbench__file-row").filter({ hasText: "app-runtime.tsx" })
    await contextFile.evaluate((element) => {
      Object.assign((element as HTMLElement).style, {
        position: "fixed",
        left: "24px",
        top: "0",
        width: "320px",
        zIndex: "1000",
      })
    })
    const pointer = await contextFile.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return { x: Math.round(rect.left + Math.min(24, rect.width / 2)), y: Math.round(rect.top + rect.height / 2) }
    })
    await page.mouse.click(pointer.x, pointer.y, { button: "right" })
    const menu = page.locator(".oc-git-workbench__context-menu")
    await expectAppVisible(menu.getByText("packages/app/src/plugin/app-runtime.tsx"))
    await expectAppVisible(menu.getByRole("menuitem", { name: /Open diff/ }))
    await expect.poll(() => contextMenuRect(menu)).toMatchObject({ left: pointer.x, top: pointer.y })
    await expect(menu.getByRole("menuitem", { name: "Add exact file to .gitignore" })).toHaveAttribute(
      "title",
      /already tracked file tracked.*only affects untracked files/,
    )
    await menu.getByRole("menuitem", { name: "Add exact file to .gitignore" }).click()
    await expect
      .poll(() => lastAction(actionPayloads, "ignore")?.pattern)
      .toBe("packages/app/src/plugin/app-runtime.tsx")
    await contextFile.evaluate((element) => element.removeAttribute("style"))
    await expectAppVisible(contextFile)

    await contextFile.evaluate((element) => {
      const target = element as HTMLElement
      target.dataset.edgeFixture = "desktop"
      document.body.append(target)
      Object.assign(target.style, { position: "fixed", right: "0", bottom: "0", zIndex: "1000" })
      const rect = target.getBoundingClientRect()
      target.style.transform = `translate(${1280 - rect.right}px, ${720 - rect.bottom}px)`
    })
    const desktopFixture = page.locator('[data-edge-fixture="desktop"]')
    const desktopEdge = await desktopFixture.boundingBox()
    expect(desktopEdge).toBeTruthy()
    const desktopClickX = Math.floor((desktopEdge?.x ?? 0) + (desktopEdge?.width ?? 0) - 2)
    const desktopClickY = Math.floor((desktopEdge?.y ?? 0) + (desktopEdge?.height ?? 0) - 2)
    expect(1280 - desktopClickX).toBeLessThanOrEqual(4)
    await page.mouse.click(desktopClickX, desktopClickY, { button: "right" })
    await expect.poll(() => contextMenuRect(menu)).toMatchObject({ insideViewport: true })
    await expect(menu.getByRole("menuitem", { name: "Add *.tsx extension to .gitignore" })).toBeEnabled()
    await menu.getByRole("menuitem", { name: "Add *.tsx extension to .gitignore" }).click()
    await expect.poll(() => lastAction(actionPayloads, "ignore")?.pattern).toBe("*.tsx")
    await page.locator('[data-edge-fixture="desktop"]').evaluate((element) => {
      element.removeAttribute("style")
      element.remove()
    })

    const contextFolder = workbench.locator(".oc-git-workbench__tree-directory").filter({ hasText: "packages" }).first()
    await contextFolder.click({ button: "right" })
    await menu.getByRole("menuitem", { name: "Add exact folder to .gitignore" }).click()
    await expect.poll(() => lastAction(actionPayloads, "ignore")?.pattern).toBe("packages/")
    await expectAppVisible(contextFile)

    const keyboardFile = page.locator(
      '.oc-git-workbench__file-row[data-path="packages/app/src/plugin/app-runtime.tsx"]:visible',
    )
    await expectAppVisible(keyboardFile)
    const keyboardAnchor = await keyboardFile.evaluate((element) => {
      ;(element as HTMLElement).dataset.keyboardContextFixture = "true"
      document.body.append(element)
      Object.assign((element as HTMLElement).style, {
        position: "fixed",
        left: "140px",
        top: "20px",
        width: "200px",
        height: "30px",
        display: "grid",
        zIndex: "1000",
      })
      const rect = element.getBoundingClientRect()
      const anchor = { x: rect.x, y: rect.y, height: rect.height }
      element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 0, clientY: 0, button: 0 }))
      return anchor
    })
    await expect
      .poll(() => contextMenuRect(menu))
      .toMatchObject({
        left: Math.round(keyboardAnchor.x + 12),
        top: Math.round(keyboardAnchor.y + keyboardAnchor.height + 2),
      })
    await page.keyboard.press("Escape")
    await page.locator('[data-keyboard-context-fixture="true"]').evaluate((element) => element.remove())

    await contextFile.evaluate((element) => {
      const target = element as HTMLElement
      target.dataset.edgeFixture = "mobile"
      document.body.append(target)
      Object.assign(target.style, { position: "fixed", right: "0", bottom: "0", zIndex: "1000" })
    })
    await page.setViewportSize({ width: 1280, height: 300 })
    await page.locator('[data-edge-fixture="mobile"]').evaluate((element) => {
      const target = element as HTMLElement
      const rect = target.getBoundingClientRect()
      target.style.transform = `translate(${1280 - rect.right}px, ${300 - rect.bottom}px)`
    })
    const mobileFixture = page.locator('[data-edge-fixture="mobile"]')
    const mobileEdge = await mobileFixture.boundingBox()
    expect(mobileEdge).toBeTruthy()
    const mobileClickX = Math.floor((mobileEdge?.x ?? 0) + (mobileEdge?.width ?? 0) - 2)
    const mobileClickY = Math.floor((mobileEdge?.y ?? 0) + (mobileEdge?.height ?? 0) - 2)
    expect(1280 - mobileClickX).toBeLessThanOrEqual(4)
    expect(300 - mobileClickY).toBeLessThanOrEqual(4)
    await mobileFixture.click({
      button: "right",
      force: true,
      position: { x: Math.max(1, (mobileEdge?.width ?? 2) - 2), y: Math.max(1, (mobileEdge?.height ?? 2) - 2) },
    })
    await expect.poll(() => contextMenuRect(menu)).toMatchObject({ insideViewport: true, scrollable: true })
    await page.keyboard.press("Escape")
    await page.locator('[data-edge-fixture="mobile"]').evaluate((element) => {
      element.removeAttribute("style")
      element.remove()
    })
    await page.setViewportSize({ width: 1280, height: 720 })
    await workbench.getByRole("button", { name: "Refresh" }).click()
    await expectAppVisible(contextFile)
    await contextFile.click({ button: "right" })
    await menu.getByRole("menuitem", { name: /^Stage/ }).click()
    await expect
      .poll(() => lastAction(actionPayloads, "stage")?.files)
      .toEqual(["packages/app/src/plugin/app-runtime.tsx"])
    await expectAppVisible(workbench.getByRole("button", { name: "Refresh" }))
    await expectAppVisible(workbench.getByRole("button", { name: "Fetch" }))
    await expectAppVisible(workbench.getByRole("button", { name: "Pull" }))
    await expectAppVisible(workbench.getByRole("button", { name: "Push" }))
    await expectAppVisible(workbench.getByRole("button", { name: "Sync" }))

    await composerCommit.click()
    await expect.poll(() => actions).toContain("commitAuto")
    await expect
      .poll(() => actionPayloads.filter((item) => item.action === "commitAuto").map((item) => item.directory))
      .toContain(directory)
    await expect(workbench.locator(".oc-git-workbench__callout--notice")).toHaveText(
      /chore: update git workbench fixture.*Committed all staged changes with an LLM-generated message\./,
    )

    snapshot.status = [gitFile("packages/app/src/plugin/app-runtime.tsx")]
    await workbench.getByRole("button", { name: "Refresh" }).click()
    await expectAppVisible(workbench.locator(".oc-git-workbench__file-row").filter({ hasText: "app-runtime.tsx" }))
    await workbench.getByRole("button", { name: "Commit All Open Changes" }).click()
    await expect.poll(() => actions.filter((action) => action === "commitAuto").length).toBe(2)
    expect(
      actionPayloads.filter((item) => item.action === "commitAuto" && item.directory === directory).length,
    ).toBeGreaterThanOrEqual(2)

    await page.locator('[data-dock-area="left"]').getByRole("button", { name: "Close Git Workbench" }).click()
    await expect(page.locator('[data-dock-area="left"]').getByRole("tab", { name: "Git Workbench" })).toHaveCount(0)
    await addDockPane(page, "right", "gitWorkbench")
    const rightWorkbench = page.locator('[data-dock-area="right"] .oc-git-workbench')
    await expectAppVisible(rightWorkbench)

    await rightWorkbench.getByRole("button", { name: "History" }).click()
    await expectAppVisible(rightWorkbench.getByRole("heading", { name: "feat: add git workbench plugin" }))
    await acceptDialogs(page, [true], async () => {
      await rightWorkbench.getByRole("button", { name: "Cherry-pick" }).click()
    })
    await expect.poll(() => actions).toContain("cherryPick")

    snapshot.operation = { inProgress: false }
    snapshot.conflicts = []
    await rightWorkbench.getByRole("button", { name: "Refresh" }).click()
    await rightWorkbench.locator(".oc-git-workbench__tabs").getByRole("button", { name: "Working tree" }).click()
    await expect(
      rightWorkbench.locator(".oc-git-workbench__tabs").getByRole("button", { name: "Working tree" }),
    ).toHaveAttribute("aria-selected", "true")
    await expect(rightWorkbench.getByRole("button", { name: "Refresh" })).toHaveText("")
    await expect(rightWorkbench.getByRole("button", { name: "Stage all", exact: true })).toHaveText("")
    await expectAppVisible(
      rightWorkbench.getByRole("button", { name: "Stage all", exact: true }).locator(".oc-git-workbench__action-icon"),
    )
    await rightWorkbench.getByRole("button", { name: "Stage all", exact: true }).click()
    await expect.poll(() => actions).toContain("stage")

    snapshot.status = [
      stagedGitFile("packages/app/src/plugin/app-runtime.tsx"),
      gitFile(".opencode/plugins/git-workbench-app/index.js"),
    ]
    await rightWorkbench.getByRole("button", { name: "Refresh" }).click()
    const appRuntimeRow = rightWorkbench.locator(".oc-git-workbench__file-row").filter({ hasText: "app-runtime.tsx" })
    const unstageButton = appRuntimeRow.getByRole("button", { name: "Unstage" })
    await expectAppVisible(appRuntimeRow.locator(".oc-git-workbench__file-glyph"))
    await expectAppVisible(unstageButton)
    await expect(unstageButton).toHaveText("")
    await expectAppVisible(unstageButton.locator(".oc-git-workbench__action-icon"))
    await unstageButton.click()
    await expect
      .poll(() => lastAction(actionPayloads, "unstage")?.files)
      .toEqual(["packages/app/src/plugin/app-runtime.tsx"])

    await acceptDialogs(page, [true], async () => {
      await appRuntimeRow.getByRole("button", { name: "Discard" }).click()
    })
    await expect
      .poll(() => lastAction(actionPayloads, "discard")?.files)
      .toEqual(["packages/app/src/plugin/app-runtime.tsx"])

    const pluginRow = rightWorkbench
      .locator(".oc-git-workbench__file-row")
      .filter({ hasText: ".opencode/plugins/git-workbench-app" })
    const stageButton = pluginRow.getByRole("button", { name: "Stage" })
    await expectAppVisible(pluginRow.locator(".oc-git-workbench__file-glyph"))
    await expectAppVisible(stageButton)
    await expect(stageButton).toHaveText("")
    await expectAppVisible(stageButton.locator(".oc-git-workbench__action-icon"))
    await stageButton.click()
    await expect
      .poll(() => lastAction(actionPayloads, "stage")?.files)
      .toEqual([".opencode/plugins/git-workbench-app/index.js"])

    await rightWorkbench.getByRole("button", { name: "Commit..." }).click()
    await submitWorkbenchTextDialog(
      rightWorkbench,
      "Commit message",
      "test: commit local git workbench action",
      "Commit",
    )
    await expect
      .poll(() => lastAction(actionPayloads, "commit")?.message)
      .toBe("test: commit local git workbench action")

    await rightWorkbench.locator(".oc-git-workbench__section").getByRole("button", { name: "Stash" }).click()
    await submitWorkbenchTextDialog(rightWorkbench, "Stash message", "Workbench smoke stash", "Save stash")
    await expect.poll(() => lastAction(actionPayloads, "stashSave")?.message).toBe("Workbench smoke stash")

    await expect(pluginRow.getByRole("button", { name: "Diff" })).toHaveText("")
    await pluginRow.getByRole("button", { name: "Diff" }).click()
    await expectWorkbenchDiffLayout(page, rightWorkbench)
    const middleDiff = page.locator('[data-dock-area="middle"] .oc-git-workbench--diff-dock')
    const cachedPatch = middleDiff.locator(".oc-git-workbench__diff")
    const cachedPatchText = await cachedPatch.textContent()
    snapshotDelays[directory] = 250
    const quietRefresh = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return (
        response.request().method() === "GET" &&
        url.pathname.endsWith("/vcs/git") &&
        url.searchParams.get("directory") === directory
      )
    })
    await page.locator('[data-dock-area="right"]').getByRole("button", { name: "Close Git Workbench" }).click()
    await addDockPane(page, "right", "gitWorkbench")
    await quietRefresh
    snapshotDelays[directory] = 0
    await expect.poll(() => cachedPatch.textContent()).toBe(cachedPatchText)
    await expect(middleDiff.getByText("Diff not loaded", { exact: true })).toHaveCount(0)
    await expect(middleDiff.getByText("Loading diff", { exact: true })).toHaveCount(0)
    await expect(middleDiff.locator(".oc-git-workbench__diff-error")).toHaveCount(0)
    await expect(middleDiff.getByRole("button", { name: "Refresh diff" })).toBeEnabled()

    await acceptDialogs(page, [true], async () => {
      await rightWorkbench.getByRole("button", { name: "Discard all" }).click()
    })
    await expect.poll(() => lastAction(actionPayloads, "discard")?.force).toBe(true)

    await rightWorkbench.locator(".oc-git-workbench__tabs").getByRole("button", { name: "Stash" }).click()
    await expectAppVisible(rightWorkbench.getByText("WIP test stash"))
    await rightWorkbench.getByRole("button", { name: "Apply" }).click()
    await rightWorkbench.getByRole("button", { name: "Pop" }).click()
    await acceptDialogs(page, [true], async () => {
      await rightWorkbench.getByRole("button", { name: "Drop" }).click()
    })
    await expect.poll(() => actions).toEqual(expect.arrayContaining(["stashApply", "stashPop", "stashDrop"]))

    await rightWorkbench.getByRole("button", { name: "Branches" }).click()
    const branchRows = rightWorkbench.locator(".oc-git-workbench__branch-row")
    const localMainBranch = branchRows.filter({ has: page.getByRole("button", { name: "Checkout" }) })
    await expectAppVisible(branchRows.filter({ hasText: "git-workbench-test" }))
    await expectAppVisible(localMainBranch)
    await localMainBranch.getByRole("button", { name: "Checkout" }).click()
    await expect.poll(() => lastAction(actionPayloads, "checkoutBranch")?.name).toBe("main")
    await rightWorkbench.getByRole("button", { name: "Create branch" }).click()
    await submitWorkbenchFieldsDialog(
      rightWorkbench,
      { "New branch name": "local-smoke", "Start point (optional)": "main" },
      "Create branch",
    )
    await expect
      .poll(() => lastAction(actionPayloads, "createBranch"))
      .toMatchObject({ name: "local-smoke", start: "main" })

    snapshot.operation = { inProgress: true, type: "merge" }
    snapshot.conflicts = [{ file: "packages/app/src/conflicted.ts" }]
    await rightWorkbench.getByRole("button", { name: "Refresh" }).click()
    await rightWorkbench.getByRole("button", { name: "Conflicts" }).click()
    await expectAppVisible(rightWorkbench.getByText("packages/app/src/conflicted.ts"))
    await expectAppVisible(rightWorkbench.getByRole("button", { name: "Resolve", exact: true }))
    await expectAppVisible(rightWorkbench.getByRole("button", { name: "Resolve all conflicts", exact: true }))
    await rightWorkbench.getByRole("button", { name: "Resolve", exact: true }).click()
    await expect
      .poll(() => lastAction(actionPayloads, "stage")?.files)
      .toEqual(["packages/app/src/conflicted.ts"])
    await rightWorkbench.getByRole("button", { name: "Resolve all conflicts", exact: true }).click()
    await expect
      .poll(() => lastAction(actionPayloads, "stage")?.files)
      .toEqual(["packages/app/src/conflicted.ts"])
    await rightWorkbench.locator(".oc-git-workbench__section").getByRole("button", { name: "Continue" }).click()
    await acceptDialogs(page, [true], async () => {
      await rightWorkbench.locator(".oc-git-workbench__section").getByRole("button", { name: "Abort" }).click()
    })
    await expect.poll(() => actions).toEqual(expect.arrayContaining(["continueOperation", "abortOperation"]))

    snapshot.operation = { inProgress: false }
    snapshot.conflicts = []
    await rightWorkbench.getByRole("button", { name: "Refresh" }).click()
    await rightWorkbench.locator(".oc-git-workbench__tabs").getByRole("button", { name: "Working tree" }).click()
    await expect(
      rightWorkbench.locator(".oc-git-workbench__tabs").getByRole("button", { name: "Working tree" }),
    ).toHaveAttribute("aria-selected", "true")
    await pluginRow.getByRole("button", { name: "Diff" }).click()
    await expectWorkbenchDiffLayout(page, rightWorkbench)
    await page.screenshot({ path: "e2e/test-results/git-workbench-diff-desktop.png", fullPage: true })
    await page.screenshot({ path: "e2e/test-results/git-workbench-local-actions.png", fullPage: true })
    await page.screenshot({ path: "e2e/test-results/git-workbench-app-desktop.png", fullPage: true })

    await page.setViewportSize({ width: 390, height: 844 })
    await expectAppVisible(page.getByRole("heading", { name: "Git Workbench QA" }))
    await page.getByRole("button", { name: "More tools", exact: true }).click()
    await expectAppVisible(
      page
        .locator('[data-component="plugin-toolbar-mobile-menu"]')
        .getByRole("button", { name: "Commit All Open Changes", exact: true }),
    )
    await page.screenshot({ path: "e2e/test-results/git-workbench-mobile-shell.png", fullPage: true })
    expectNoSmokeErrors(errors, [], networkFailures)
  })

  test("recovers repository discovery after a temporary 503", async ({ page }) => {
    const errors = trackPageErrors(page)
    const networkFailures: string[] = []
    const discoveryRequests: string[] = []
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.endsWith("/vcs/git/discover")) discoveryRequests.push(request.url())
    })
    page.on("response", (response) => {
      if (response.status() >= 400)
        networkFailures.push(`${response.status()} ${response.request().method()} ${response.url()}`)
    })

    await mockOpenCodeServer(page, {
      directory,
      project: [project()],
      provider: provider(),
      sessions: [session()],
      pageMessages: () => ({ items: [] }),
    })
    await mockGitWorkbenchPlugin(page)
    await mockGitApi(
      page,
      {
        [directory]: gitSnapshot(),
        [nestedDirectory]: gitSnapshot({ worktree: nestedDirectory, branch: "nested-workbench", status: [] }),
      },
      [],
      [],
      {
        firstDiscoveryUnavailable: true,
        discoveredRepositories: [{ worktree: nestedDirectory, name: "Nested Workbench" }],
      },
    )
    await configurePage(page)
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
    await hideDebugBar(page)
    await addDockPane(page, "left", "gitWorkbench")

    const workbench = page.locator(".oc-git-workbench")
    const discoveryError = workbench.locator(".oc-git-workbench__callout--error")
    await expectAppVisible(workbench)
    await expect(discoveryError).toHaveText("Repository discovery failed: Service Unavailable")
    await expect.poll(() => discoveryRequests).toHaveLength(1)
    expect(networkFailures).toHaveLength(1)
    expect(networkFailures[0]).toMatch(/^503 GET .*\/vcs\/git\/discover\?/)

    const errorsAfterUnavailable = [...errors]
    const networkFailuresAfterUnavailable = [...networkFailures]
    await workbench.getByRole("button", { name: "Refresh" }).click()

    await expect(discoveryError).toHaveCount(0)
    await expect.poll(() => discoveryRequests).toHaveLength(2)
    const projectSelect = workbench.getByLabel("Git Workbench project")
    await expect(projectSelect.locator('optgroup[label="Discovered repositories"] option')).toHaveText([
      "Nested Workbench",
    ])
    await projectSelect.selectOption(nestedDirectory)
    await expectAppVisible(
      workbench.locator(".oc-git-workbench__title").getByText("nested-workbench", { exact: true }),
    )
    expect(errors).toEqual(errorsAfterUnavailable)
    expect(networkFailures).toEqual(networkFailuresAfterUnavailable)
  })

  test("resolves one child repository and requires a choice for multiple dirty children", async ({ page }) => {
    const actions: string[] = []
    const actionPayloads: Record<string, unknown>[] = []
    const errors = trackPageErrors(page)
    const networkFailures: string[] = []
    const container = gitSnapshot({ worktree: undefined, status: [] })
    container.info = {}
    const nested = gitSnapshot({
      worktree: nestedDirectory,
      branch: "nested-workbench",
      status: [gitFile("src/nested.ts")],
    })
    const deep = gitSnapshot({
      worktree: deepNestedDirectory,
      branch: "deep-workbench",
      status: [gitFile("src/deep.ts")],
    })
    page.on("requestfailed", (request) => {
      const pathname = new URL(request.url()).pathname
      const navigationAbort =
        request.failure()?.errorText === "net::ERR_ABORTED" &&
        (pathname === "/perf/record" ||
          pathname === "/global/event" ||
          pathname === "/app/plugins" ||
          pathname.startsWith("/app/plugin/git-workbench-app/"))
      if (navigationAbort) return
      networkFailures.push(`${request.failure()?.errorText ?? "failed"} ${request.url()}`)
    })
    page.on("response", (response) => {
      if (response.status() >= 400)
        networkFailures.push(`${response.status()} ${response.request().method()} ${response.url()}`)
    })

    await mockOpenCodeServer(page, {
      directory,
      project: [project()],
      provider: provider(),
      sessions: [session(), sameContainerSession()],
      pageMessages: () => ({ items: [] }),
    })
    await mockGitWorkbenchPlugin(page)
    await mockGitApi(
      page,
      { [directory]: container, [nestedDirectory]: nested, [deepNestedDirectory]: deep },
      actions,
      actionPayloads,
      {
        discoveredRepositories: [
          { worktree: nestedDirectory, name: "Nested Workbench" },
          { worktree: deepNestedDirectory, name: "Deep Workbench" },
        ],
      },
    )
    await configurePage(page)
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
    await hideDebugBar(page)

    const commit = page
      .locator(
        '[data-component="plugin-toolbar-outlet"][data-plugin-toolbar-placement="composer"][data-plugin-toolbar-align="right"]',
      )
      .getByRole("button", { name: "Commit All Open Changes", exact: true })
    await expectAppVisible(commit)
    await expect(commit).toBeEnabled()
    await commit.click()

    const workbench = page.locator(".oc-git-workbench")
    const dialog = page.getByRole("dialog", { name: "Choose repository to commit" })
    await expectAppVisible(dialog)
    await expect(commit).toBeDisabled()
    expect(actions).not.toContain("commitAuto")
    await expectAppVisible(dialog.getByText(nestedDirectory, { exact: true }))
    await expectAppVisible(dialog.getByText(deepNestedDirectory, { exact: true }))
    await dialog.getByRole("combobox").selectOption(deepNestedDirectory)
    await page.screenshot({ path: "e2e/test-results/git-workbench-commit-target-desktop.png", fullPage: true })
    await dialog.getByRole("button", { name: "Commit selected repository" }).click()
    await expect.poll(() => lastAction(actionPayloads, "commitAuto")?.directory).toBe(deepNestedDirectory)
    expect(actionPayloads.filter((item) => item.action === "commitAuto")).toHaveLength(1)
    expect(nested.status).toHaveLength(1)
    await expectAppVisible(workbench.getByText("Working tree clean"))
    await expect(commit).toBeEnabled()
    await expect
      .poll(() =>
        workbench.locator("img").evaluateAll((images) => images.every((image) => (image as HTMLImageElement).complete)),
      )
      .toBe(true)

    await page.reload()
    await expectAppVisible(commit)
    await commit.click()
    await expect
      .poll(() => actionPayloads.filter((item) => item.action === "commitAuto").map((item) => item.directory))
      .toEqual([deepNestedDirectory, deepNestedDirectory])
    await expect(commit).toBeEnabled()

    deep.status = [gitFile("src/deep-again.ts")]
    await page.goto(`/${base64Encode(directory)}/session/${secondarySessionID}`)
    await page.getByRole("tab", { name: "Git Workbench Alternate QA", exact: true }).click()
    await expectAppVisible(page.getByRole("heading", { name: "Git Workbench Alternate QA" }))
    await commit.click()
    await expectAppVisible(dialog)
    await dialog.getByRole("combobox").selectOption(nestedDirectory)
    await dialog.getByRole("button", { name: "Commit selected repository" }).click()
    await expect.poll(() => lastAction(actionPayloads, "commitAuto")?.directory).toBe(nestedDirectory)
    await expect(commit).toBeEnabled()

    await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
    await page.getByRole("tab", { name: "Git Workbench QA", exact: true }).click()
    await expectAppVisible(page.getByRole("heading", { name: "Git Workbench QA" }))
    await commit.click()
    await expect
      .poll(() => actionPayloads.filter((item) => item.action === "commitAuto").map((item) => item.directory))
      .toEqual([deepNestedDirectory, deepNestedDirectory, nestedDirectory, deepNestedDirectory])
    await expect(commit).toBeEnabled()

    deep.info = {}
    nested.status = [gitFile("src/nested-stale-recovery.ts")]
    await commit.click()
    await expectAppVisible(dialog)
    await expect(dialog.getByRole("combobox").locator("option")).toHaveCount(1)
    await page.setViewportSize({ width: 390, height: 844 })
    await expectAppVisible(dialog)
    const mobileDialog = await dialog.boundingBox()
    expect(mobileDialog).not.toBeNull()
    expect(mobileDialog!.x).toBeGreaterThanOrEqual(0)
    expect(mobileDialog!.y).toBeGreaterThanOrEqual(0)
    expect(mobileDialog!.x + mobileDialog!.width).toBeLessThanOrEqual(390)
    expect(mobileDialog!.y + mobileDialog!.height).toBeLessThanOrEqual(844)
    await page.screenshot({ path: "e2e/test-results/git-workbench-commit-target-mobile-dialog.png", fullPage: true })
    const staleRecoveryCommit = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return url.pathname.endsWith("/vcs/git/action") && url.searchParams.get("directory") === nestedDirectory
    })
    const staleRecoveryRefresh = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return url.pathname.endsWith("/vcs/git") && url.searchParams.get("directory") === nestedDirectory
    })
    await dialog.getByRole("button", { name: "Commit selected repository" }).click()
    await staleRecoveryCommit
    await staleRecoveryRefresh
    await expect.poll(() => lastAction(actionPayloads, "commitAuto")?.directory).toBe(nestedDirectory)
    expect(actionPayloads.filter((item) => item.action === "commitAuto")).toHaveLength(5)

    await page.getByRole("button", { name: "More tools", exact: true }).click()
    const mobileCommit = page
      .locator('[data-component="plugin-toolbar-mobile-menu"]')
      .getByRole("button", { name: "Commit All Open Changes", exact: true })
    await expectAppVisible(mobileCommit)
    await expect(mobileCommit).toBeEnabled()
    await page.screenshot({ path: "e2e/test-results/git-workbench-commit-target-mobile.png", fullPage: true })
    expectNoSmokeErrors(errors, [], networkFailures)
  })

  test("auto-selects the only dirty child without persisting an implicit choice", async ({ page }) => {
    const actions: string[] = []
    const actionPayloads: Record<string, unknown>[] = []
    const errors = trackPageErrors(page)
    const networkFailures: string[] = []
    const container = gitSnapshot({ status: [] })
    container.info = {}
    const nested = gitSnapshot({
      worktree: nestedDirectory,
      branch: "nested-workbench",
      status: [gitFile("src/only-dirty.ts")],
    })
    const deep = gitSnapshot({ worktree: deepNestedDirectory, branch: "deep-workbench", status: [] })
    page.on("requestfailed", (request) => {
      const pathname = new URL(request.url()).pathname
      const navigationAbort =
        request.failure()?.errorText === "net::ERR_ABORTED" &&
        (pathname === "/perf/record" ||
          pathname === "/global/event" ||
          pathname === "/app/plugins" ||
          pathname.startsWith("/app/plugin/git-workbench-app/"))
      if (navigationAbort) return
      networkFailures.push(`${request.failure()?.errorText ?? "failed"} ${request.url()}`)
    })
    page.on("response", (response) => {
      if (response.status() >= 400)
        networkFailures.push(`${response.status()} ${response.request().method()} ${response.url()}`)
    })

    await mockOpenCodeServer(page, {
      directory,
      project: [project()],
      provider: provider(),
      sessions: [session()],
      pageMessages: () => ({ items: [] }),
    })
    await mockGitWorkbenchPlugin(page)
    await mockGitApi(
      page,
      { [directory]: container, [nestedDirectory]: nested, [deepNestedDirectory]: deep },
      actions,
      actionPayloads,
      {
        discoveredRepositories: [
          { worktree: nestedDirectory, name: "Nested Workbench" },
          { worktree: deepNestedDirectory, name: "Deep Workbench" },
        ],
      },
    )
    await configurePage(page)
    await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
    await hideDebugBar(page)

    const commit = page
      .locator(
        '[data-component="plugin-toolbar-outlet"][data-plugin-toolbar-placement="composer"][data-plugin-toolbar-align="right"]',
      )
      .getByRole("button", { name: "Commit All Open Changes", exact: true })
    await expectAppVisible(commit)
    await commit.click()
    await expect.poll(() => lastAction(actionPayloads, "commitAuto")?.directory).toBe(nestedDirectory)
    expect(actionPayloads.filter((item) => item.action === "commitAuto")).toHaveLength(1)
    await expect(page.getByRole("dialog", { name: "Choose repository to commit" })).toHaveCount(0)

    deep.status = [gitFile("src/next-only-dirty.ts")]
    await commit.click()
    await expect
      .poll(() => actionPayloads.filter((item) => item.action === "commitAuto").map((item) => item.directory))
      .toEqual([nestedDirectory, deepNestedDirectory])
    await expect(page.getByRole("dialog", { name: "Choose repository to commit" })).toHaveCount(0)
    expect(actions).toEqual(["commitAuto", "commitAuto"])
    expectNoSmokeErrors(errors, [], networkFailures)
  })

  test("commits visible changes when a legacy snapshot omits worktree metadata", async ({ page }) => {
    const actions: string[] = []
    const actionPayloads: Record<string, unknown>[] = []
    const errors = trackPageErrors(page)
    const networkFailures: string[] = []
    const snapshot = gitSnapshot({ status: [gitFile("packages/app/src/legacy-snapshot.ts")] })
    snapshot.info = { branch: "dev", default_branch: "dev" }
    page.on("requestfailed", (request) =>
      networkFailures.push(`${request.failure()?.errorText ?? "failed"} ${request.url()}`),
    )
    page.on("response", (response) => {
      if (response.status() >= 400)
        networkFailures.push(`${response.status()} ${response.request().method()} ${response.url()}`)
    })

    await mockOpenCodeServer(page, {
      directory,
      project: [project()],
      provider: provider(),
      sessions: [session()],
      pageMessages: () => ({ items: [] }),
    })
    await mockGitWorkbenchPlugin(page)
    await mockGitApi(page, { [directory]: snapshot }, actions, actionPayloads)
    await configurePage(page)
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
    await hideDebugBar(page)

    const commit = page
      .locator(
        '[data-component="plugin-toolbar-outlet"][data-plugin-toolbar-placement="composer"][data-plugin-toolbar-align="right"]',
      )
      .getByRole("button", { name: "Commit All Open Changes", exact: true })
    await expectAppVisible(commit)
    await commit.click()

    await expect.poll(() => lastAction(actionPayloads, "commitAuto")?.directory).toBe(directory)
    const workbench = page.locator(".oc-git-workbench")
    await expect(workbench.locator(".oc-git-workbench__callout--notice")).toContainText(
      "Committed all staged changes with an LLM-generated message.",
    )
    await expect(workbench.getByText("No open changes were found", { exact: false })).toHaveCount(0)
    await page.screenshot({ path: "e2e/test-results/git-workbench-legacy-snapshot-commit.png", fullPage: true })
    expect(actions).toEqual(["commitAuto"])
    expectNoSmokeErrors(errors, [], networkFailures)
  })

  test("commits the switched workbench project while another project's tab stays open", async ({ page }) => {
    const errors = trackPageErrors(page)
    const networkFailures: string[] = []
    const actions: string[] = []
    const actionPayloads: Record<string, unknown>[] = []
    page.on("requestfailed", (request) =>
      networkFailures.push(`${request.failure()?.errorText ?? "failed"} ${request.url()}`),
    )
    page.on("response", (response) => {
      if (response.status() >= 400)
        networkFailures.push(`${response.status()} ${response.request().method()} ${response.url()}`)
    })

    await mockOpenCodeServer(page, {
      directory,
      project: [project(), secondaryProject()],
      provider: provider(),
      sessions: [session(), secondarySession()],
      pageMessages: () => ({ items: [] }),
    })
    await mockGitWorkbenchPlugin(page)
    await mockGitApi(
      page,
      {
        [directory]: gitSnapshot(),
        [secondaryDirectory]: gitSnapshot({
          worktree: secondaryDirectory,
          branch: "secondary-workbench",
          status: [gitFile("packages/app/src/plugin/secondary-workbench.ts")],
        }),
      },
      actions,
      actionPayloads,
    )
    await configurePage(page)
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
    await hideDebugBar(page)
    await addDockPane(page, "left", "gitWorkbench")

    const workbench = page.locator(".oc-git-workbench")
    const projectSelect = workbench.getByLabel("Git Workbench project")
    await expectAppVisible(workbench)
    await expect(projectSelect).toHaveValue(directory)

    // Switch the workbench to the secondary project while the active tab still belongs to the
    // primary project: the secondary project's tab remains open in the tab bar.
    await projectSelect.selectOption(secondaryDirectory)
    await expect(projectSelect).toHaveValue(secondaryDirectory)
    await expectAppVisible(
      workbench.locator(".oc-git-workbench__title").getByText("secondary-workbench", { exact: true }),
    )

    const workbenchCommit = workbench.getByRole("button", { name: "Commit All Open Changes", exact: true })
    await expect(workbenchCommit).toBeEnabled()
    await workbenchCommit.click()

    await expect
      .poll(() => lastAction(actionPayloads, "commitAuto")?.directory)
      .toBe(secondaryDirectory)
    expect(actionPayloads.filter((item) => item.action === "commitAuto")).toHaveLength(1)
    await expect(workbench.locator(".oc-git-workbench__callout--notice")).toContainText(
      "Committed all staged changes with an LLM-generated message.",
    )
    await expect
      .poll(() => lastAction(actionPayloads, "commitAuto")?.directory)
      .toBe(secondaryDirectory)

    // The workbench must stay on the switched project instead of jumping back to the active tab's project.
    await expect(projectSelect).toHaveValue(secondaryDirectory)
    await expectAppVisible(
      workbench.locator(".oc-git-workbench__title").getByText("secondary-workbench", { exact: true }),
    )
    await expect(workbench.getByText("Working tree clean")).toBeVisible()
    await page.screenshot({ path: "e2e/test-results/git-workbench-switched-project-commit-desktop.png", fullPage: true })
    expectNoSmokeErrors(errors, [], networkFailures)
  })
})

async function projectSelectTheme(projectSelect: Locator) {
  return projectSelect.evaluate((select) => {
    const option = select.querySelector("option:not(:checked)")
    const rootStyle = getComputedStyle(document.documentElement)
    const selectStyle = getComputedStyle(select)
    const optionStyle = option ? getComputedStyle(option) : undefined
    const color = (value: string) => {
      const probe = document.createElement("span")
      probe.style.color = value
      document.body.append(probe)
      const result = getComputedStyle(probe).color
      probe.remove()
      return result
    }
    const background = (value: string) => {
      const probe = document.createElement("span")
      probe.style.backgroundColor = value
      document.body.append(probe)
      const result = getComputedStyle(probe).backgroundColor
      probe.remove()
      return result
    }
    const surfacePanel =
      rootStyle.getPropertyValue("--surface-panel").trim() || rootStyle.getPropertyValue("--background-stronger").trim()
    const textBase = rootStyle.getPropertyValue("--text-base").trim()
    return {
      rootColorScheme: rootStyle.colorScheme,
      selectColorScheme: selectStyle.colorScheme,
      surfacePanel: background(surfacePanel),
      textBase: color(textBase),
      selectBackground: selectStyle.backgroundColor,
      selectColor: selectStyle.color,
      unselectedOptionBackground: optionStyle?.backgroundColor,
      unselectedOptionColor: optionStyle?.color,
    }
  })
}

async function configurePage(page: Page) {
  await page.addInitScript(
    ({ directory, secondaryDirectory, dirBase64, secondaryDirBase64, sessionID, secondarySessionID, server }) => {
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: {
            local: [
              { worktree: directory, expanded: true, name: "Git Workbench" },
              { worktree: secondaryDirectory, expanded: true, name: "Git Workbench Secondary" },
            ],
          },
          lastProject: {
            local: directory,
          },
        }),
      )
      localStorage.setItem("opencode-color-scheme", "dark")
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([
          {
            type: "session",
            server,
            dirBase64,
            sessionId: sessionID,
          },
          {
            type: "session",
            server,
            dirBase64: secondaryDirBase64,
            sessionId: secondarySessionID,
          },
        ]),
      )
    },
    {
      directory,
      secondaryDirectory,
      dirBase64: base64Encode(directory),
      secondaryDirBase64: base64Encode(secondaryDirectory),
      sessionID,
      secondarySessionID,
      server,
    },
  )
}

async function addDockPane(page: Page, area: "top" | "left" | "middle" | "right" | "bottom", query: string) {
  await prepareDockPaneSelection(page, area, query)
  await page.keyboard.press("Enter")
}

async function prepareDockPaneSelection(
  page: Page,
  area: "top" | "left" | "middle" | "right" | "bottom",
  query: string,
) {
  const zone = page.locator(`[data-dock-area="${area}"]`)
  if (area !== "middle" && ((await zone.count()) === 0 || !(await zone.first().isVisible()))) {
    await page.getByRole("button", { name: `Toggle ${area} dock` }).click()
    await expectAppVisible(zone)
  }
  await page
    .locator(`[data-dock-area="${area}"]`)
    .getByRole("button", { name: `Add dock item to ${area}` })
    .click()
  await expectAppVisible(page.locator('[data-component="dock-add-menu"]'))
  await expectDockAddMenuInViewport(page)
  await page.getByLabel("Search dock items").fill(query)
  await expectAppVisible(
    page.locator(`[data-component="dock-add-menu"] [data-dock-add-item="git-workbench-app/gitWorkbench"]`),
  )
}

async function installPerformanceProbe(page: Page) {
  await page.addInitScript(() => {
    const metrics: GitWorkbenchPerfMetrics = { longTasks: [], maxHeartbeatDelay: 0 }
    let last = performance.now()
    const win = window as typeof window & {
      __gitWorkbenchPerf?: GitWorkbenchPerfMetrics
      __gitWorkbenchPerfReset?: () => void
    }
    win.__gitWorkbenchPerf = metrics
    win.__gitWorkbenchPerfReset = () => {
      metrics.longTasks.length = 0
      metrics.maxHeartbeatDelay = 0
      last = performance.now()
    }
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          metrics.longTasks.push({ duration: entry.duration, name: entry.name, startTime: entry.startTime })
        }
      }).observe({ entryTypes: ["longtask"] })
    } catch {}
    window.setInterval(() => {
      const now = performance.now()
      metrics.maxHeartbeatDelay = Math.max(metrics.maxHeartbeatDelay, Math.max(0, now - last - 50))
      last = now
    }, 50)
  })
}

async function startPerformanceCapture(page: Page) {
  await page.evaluate(() => {
    const win = window as typeof window & { __gitWorkbenchPerfReset?: () => void }
    win.__gitWorkbenchPerfReset?.()
  })
  const client = await page.context().newCDPSession(page)
  await client.send("Performance.enable")
  await client.send("Profiler.enable")
  await client.send("Profiler.start")
  return client
}

async function stopPerformanceCapture(page: Page, client: CDPSession) {
  const profile = await client.send("Profiler.stop")
  const performanceMetrics = await client.send("Performance.getMetrics")
  const metrics = await page.evaluate(() => {
    const win = window as typeof window & { __gitWorkbenchPerf?: GitWorkbenchPerfMetrics }
    return win.__gitWorkbenchPerf ?? { longTasks: [], maxHeartbeatDelay: 0 }
  })
  return { profile, performanceMetrics, metrics }
}

async function expectDockAddMenuInViewport(page: Page) {
  const result = await page.evaluate(() => {
    const menu = document.querySelector<HTMLElement>('[data-component="dock-add-menu"]')
    if (!menu) return { visible: false, inViewport: false, topmost: false, rect: undefined }
    const rect = menu.getBoundingClientRect()
    const point = document.elementFromPoint(rect.left + rect.width / 2, Math.min(rect.bottom - 8, rect.top + 20))
    return {
      visible: rect.width > 0 && rect.height > 0,
      inViewport: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
      topmost: point ? menu.contains(point) : false,
      rect: rect.toJSON(),
    }
  })
  expect(result.visible).toBe(true)
  expect(result.inViewport).toBe(true)
  expect(result.topmost).toBe(true)
}

async function hideDebugBar(page: Page) {
  await page.addStyleTag({
    content:
      '[aria-label="Development performance diagnostics"], [aria-label="Help"] { display: none !important; pointer-events: none !important; }',
  })
}

async function mockGitWorkbenchPlugin(page: Page) {
  const root = path.resolve("../../.opencode/plugins/git-workbench-app")
  const body = await fs.readFile(path.join(root, "index.js"), "utf8")
  const targetBody = await fs.readFile(path.join(root, "commit-target.js"), "utf8")
  await page.route("**/app/plugins**", (route) =>
    json(route, {
      plugins: [
        {
          id: "git-workbench-app",
          spec: "git-workbench-app",
          version: "1",
          module: "/app/plugin/git-workbench-app/1/index.js",
          hash: "git-workbench",
        },
      ],
    }),
  )
  await page.route("**/app/plugin/git-workbench-app/1/index.js**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/javascript",
      headers: { "access-control-allow-origin": "*" },
      body,
    }),
  )
  await page.route("**/app/plugin/git-workbench-app/1/commit-target.js**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/javascript",
      headers: { "access-control-allow-origin": "*" },
      body: targetBody,
    }),
  )
  await page.route("**/app/plugin/git-workbench-app/1/assets/*", async (route) => {
    const file = path.basename(new URL(route.request().url()).pathname)
    return route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      headers: { "access-control-allow-origin": "*" },
      body: await fs.readFile(path.join(root, "assets", file), "utf8"),
    })
  })
}

async function mockGitApi(
  page: Page,
  snapshots: Record<string, ReturnType<typeof gitSnapshot>>,
  actions: string[],
  actionPayloads: Record<string, unknown>[],
  options: {
    snapshotDelays?: Record<string, number>
    discoveredRepositories?: { worktree: string; name: string }[]
    firstDiscoveryUnavailable?: boolean
  } = {},
) {
  const snapshotDirectory = (route: Route) => new URL(route.request().url()).searchParams.get("directory") ?? directory
  const snapshotFor = (route: Route) => snapshots[snapshotDirectory(route)] ?? snapshots[directory]
  let discoveryAttempts = 0
  await page.route("**/vcs/diff**", (route) => {
    return json(
      route,
      snapshotFor(route).status.map((file) => gitDiff(file)),
    )
  })
  await page.route("**/vcs/git**", async (route) => {
    const pathname = new URL(route.request().url()).pathname
    if (pathname.endsWith("/action")) return route.fallback()
    if (pathname.endsWith("/discover")) {
      discoveryAttempts++
      if (options.firstDiscoveryUnavailable && discoveryAttempts === 1)
        return route.fulfill({ status: 503, body: "" })
      return json(route, { repositories: options.discoveredRepositories ?? [], truncated: false })
    }
    await delay(options.snapshotDelays?.[snapshotDirectory(route)] ?? 0)
    return json(route, snapshotFor(route))
  })
  await page.route("**/vcs/git/action**", async (route) => {
    const body = await route.request().postDataJSON()
    const payload = { ...body, directory: new URL(route.request().url()).searchParams.get("directory") }
    actions.push(String(payload.action))
    actionPayloads.push(payload)
    if (body.action === "commitAuto") {
      snapshotFor(route).status = []
      return json(route, {
        ok: true,
        message: "Committed all staged changes with an LLM-generated message.",
        commit: "chore: update git workbench fixture",
      })
    }
    return json(route, { ok: true, message: `${body.action} completed` })
  })
}

async function expectComposerCommitBesideSend(page: Page) {
  const result = await page.evaluate(() => {
    const commit = document.querySelector<HTMLElement>(
      '[data-component="plugin-toolbar-outlet"][data-plugin-toolbar-placement="composer"][data-plugin-toolbar-align="right"] [aria-label="Commit All Open Changes"]',
    )
    const send = document.querySelector<HTMLElement>('[data-action="prompt-submit"]')
    if (!commit || !send) {
      return { visible: false, gap: -1, iconWidth: 0, iconHeight: 0, verticalDelta: -1, commitRight: 0, sendLeft: 0 }
    }
    const commitRect = commit.getBoundingClientRect()
    const sendRect = send.getBoundingClientRect()
    return {
      visible: commitRect.width > 0 && commitRect.height > 0 && sendRect.width > 0 && sendRect.height > 0,
      gap: sendRect.left - commitRect.right,
      verticalDelta: Math.abs(sendRect.top + sendRect.height / 2 - (commitRect.top + commitRect.height / 2)),
      commitWidth: commitRect.width,
      commitHeight: commitRect.height,
      commitRight: commitRect.right,
      sendLeft: sendRect.left,
    }
  })
  expect(result.visible).toBe(true)
  expect(result.commitRight).toBeLessThanOrEqual(result.sendLeft)
  expect(result.gap).toBeGreaterThanOrEqual(0)
  expect(result.gap).toBeLessThanOrEqual(16)
  expect(result.commitWidth).toBeGreaterThanOrEqual(24)
  expect(result.commitHeight).toBeGreaterThanOrEqual(24)
  expect(result.verticalDelta).toBeLessThanOrEqual(4)
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function expectGitWorkbenchTreeVisuals(workbench: Locator) {
  await expectAppVisible(workbench.getByText("Changes (2)"))
  const row = workbench.locator(".oc-git-workbench__file-row").filter({ hasText: "app-runtime.tsx" })
  await expectAppVisible(row.locator(".oc-git-workbench__status-mark--modified"))
  await expectAppVisible(row.locator(".oc-git-workbench__file-glyph"))
  await expectAppVisible(workbench.locator(".oc-git-workbench__tree-folder").first())
  const layout = await row.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const actions = element.querySelector(".oc-git-workbench__row-actions")?.getBoundingClientRect()
    return {
      visible: rect.width > 0 && rect.height > 0,
      actionsInside: actions ? actions.right <= rect.right + 1 && actions.left >= rect.left - 1 : false,
    }
  })
  expect(layout.visible).toBe(true)
  expect(layout.actionsInside).toBe(true)
}

function gitSnapshot(input: { branch?: string; status?: ReturnType<typeof gitFile>[]; worktree?: string } = {}): {
  info: { branch?: string; default_branch?: string; worktree?: string }
  status: ReturnType<typeof gitFile>[]
  conflicts: Array<{ file: string }>
  operation: { inProgress: boolean; type?: string }
  [key: string]: unknown
} {
  const branch = input.branch ?? "git-workbench-test"
  return {
    info: { branch, default_branch: "main", worktree: input.worktree ?? directory },
    status: input.status ?? [
      gitFile("packages/app/src/plugin/app-runtime.tsx"),
      {
        file: ".opencode/plugin-sources/git-workbench-app/index.js",
        code: "??",
        additions: 250,
        deletions: 0,
        status: "added",
        staged: false,
        unstaged: true,
        untracked: true,
        conflicted: false,
      },
    ],
    history: [
      {
        hash: "1111111111111111111111111111111111111111",
        short: "1111111",
        parents: ["0000000000000000000000000000000000000000"],
        author: "Codex",
        email: "codex@example.test",
        date: new Date().toISOString(),
        refs: [`HEAD -> ${branch}`],
        subject: "feat: add git workbench plugin",
        body: "Adds dockable Git history and working tree actions.",
      },
      {
        hash: "0000000000000000000000000000000000000000",
        short: "0000000",
        parents: [],
        author: "Codex",
        email: "codex@example.test",
        date: new Date(Date.now() - 86_400_000).toISOString(),
        refs: ["main"],
        subject: "chore: baseline",
        body: "",
      },
    ],
    branches: [
      {
        name: branch,
        current: true,
        remote: false,
        upstream: `origin/${branch}`,
        tracking: "[ahead 1]",
        hash: "1111111",
      },
      { name: "main", current: false, remote: false, hash: "0000000" },
      { name: "origin/main", current: false, remote: true, hash: "0000000" },
    ],
    remotes: [
      { name: "origin", fetch: "https://example.test/opencode.git", push: "https://example.test/opencode.git" },
    ],
    tags: [],
    stashes: [{ selector: "stash@{0}", hash: "2222222", message: "WIP test stash" }],
    conflicts: [],
    operation: { inProgress: false },
  }
}

function gitFile(file: string) {
  return {
    file,
    code: " M",
    additions: 12,
    deletions: 2,
    status: "modified",
    staged: false,
    unstaged: true,
    untracked: false,
    conflicted: false,
  }
}

function stagedGitFile(file: string) {
  return {
    ...gitFile(file),
    code: "M ",
    staged: true,
    unstaged: false,
    status: "staged",
  }
}

function gitDiff(file: ReturnType<typeof gitFile>) {
  return {
    file: file.file,
    patch: [
      `diff --git a/${file.file} b/${file.file}`,
      "index 1111111..2222222 100644",
      `--- a/${file.file}`,
      `+++ b/${file.file}`,
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n"),
    additions: file.additions,
    deletions: file.deletions,
    status: file.status,
  }
}

function lastAction(payloads: Record<string, unknown>[], action: string) {
  return payloads.toReversed().find((payload) => payload.action === action)
}

async function contextMenuRect(menu: Locator) {
  return menu.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      insideViewport:
        rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight,
      scrollable: style.overflowY === "auto" && element.scrollHeight > element.clientHeight,
    }
  })
}

async function acceptDialogs(page: Page, answers: Array<string | true>, run: () => Promise<void>) {
  const pending = [...answers]
  const handler = async (dialog: import("@playwright/test").Dialog) => {
    const answer = pending.shift()
    await dialog.accept(answer === true ? undefined : answer)
  }
  page.on("dialog", handler)
  try {
    await run()
  } finally {
    page.off("dialog", handler)
  }
  expect(pending).toEqual([])
}

async function submitWorkbenchTextDialog(workbench: Locator, label: string, value: string, action: string) {
  const dialog = workbench.page().getByRole("dialog")
  await expectAppVisible(dialog)
  await dialog.getByLabel(label).fill(value)
  await dialog.getByRole("button", { name: action, exact: true }).click()
}

async function submitWorkbenchFieldsDialog(workbench: Locator, values: Record<string, string>, action: string) {
  const dialog = workbench.page().getByRole("dialog")
  await expectAppVisible(dialog)
  for (const [label, value] of Object.entries(values)) await dialog.getByLabel(label).fill(value)
  await dialog.getByRole("button", { name: action, exact: true }).click()
}

async function expectWorkbenchDiffLayout(page: Page, workbench: Locator) {
  const middleDock = page.locator('[data-dock-area="middle"]')
  const middleDiff = middleDock.locator(".oc-git-workbench--diff-dock")
  await expectAppVisible(workbench.locator(".oc-git-workbench__tree"))
  await expect(workbench.locator(".oc-git-workbench__diff-panel")).toHaveCount(0)
  await expectAppVisible(middleDock.getByRole("tab", { name: "Git Diff" }))
  await expectAppVisible(
    middleDiff.locator(".oc-git-workbench__diff-header strong", {
      hasText: ".opencode/plugins/git-workbench-app/index.js",
    }),
  )
  await expectAppVisible(
    middleDiff.getByText(
      "diff --git a/.opencode/plugins/git-workbench-app/index.js b/.opencode/plugins/git-workbench-app/index.js",
    ),
  )
  const layout = await page.evaluate(() => {
    const tree = document.querySelector(
      '[data-dock-area="right"] .oc-git-workbench:not(.oc-git-workbench--diff-dock) .oc-git-workbench__tree',
    )
    const rightDiff = document.querySelector(
      '[data-dock-area="right"] .oc-git-workbench:not(.oc-git-workbench--diff-dock) .oc-git-workbench__diff-panel',
    )
    const diff = document.querySelector(
      '[data-dock-area="middle"] .oc-git-workbench--diff-dock .oc-git-workbench__diff-panel',
    )
    const treeRect = tree?.getBoundingClientRect()
    const diffRect = diff?.getBoundingClientRect()
    return {
      rightInlineDiffCount: rightDiff ? 1 : 0,
      tree: treeRect
        ? {
            x: treeRect.x,
            y: treeRect.y,
            width: treeRect.width,
            height: treeRect.height,
            right: treeRect.right,
            bottom: treeRect.bottom,
          }
        : undefined,
      diff: diffRect
        ? {
            x: diffRect.x,
            y: diffRect.y,
            width: diffRect.width,
            height: diffRect.height,
            right: diffRect.right,
            bottom: diffRect.bottom,
          }
        : undefined,
      inMiddleDock: Boolean(diff?.closest('[data-dock-area="middle"]')),
    }
  })
  expect(layout.rightInlineDiffCount).toBe(0)
  expect(layout.tree?.width).toBeGreaterThan(120)
  expect(layout.diff?.width).toBeGreaterThan(120)
  expect(layout.inMiddleDock).toBe(true)
}

function project() {
  return {
    id: projectID,
    worktree: directory,
    vcs: "git",
    name: "git-workbench",
    time: { created: 1700000000000, updated: 1700000000000 },
    sandboxes: [],
  }
}

function secondaryProject() {
  return {
    id: secondaryProjectID,
    worktree: secondaryDirectory,
    vcs: "git",
    name: "git-workbench-secondary",
    time: { created: 1700000000000, updated: 1700000000000 },
    sandboxes: [],
  }
}

function session() {
  return {
    id: sessionID,
    slug: "git-workbench",
    projectID,
    directory,
    title: "Git Workbench QA",
    version: "dev",
    time: { created: 1700000000000, updated: 1700000000000 },
  }
}

function sameContainerSession() {
  return {
    id: secondarySessionID,
    slug: "git-workbench-alternate",
    projectID,
    directory,
    title: "Git Workbench Alternate QA",
    version: "dev",
    time: { created: 1700000000000, updated: 1700000000000 },
  }
}

function secondarySession() {
  return {
    id: secondarySessionID,
    slug: "git-workbench-secondary",
    projectID: secondaryProjectID,
    directory: secondaryDirectory,
    title: "Git Workbench Secondary QA",
    version: "dev",
    time: { created: 1700000000000, updated: 1700000000000 },
  }
}

function provider() {
  return {
    all: [
      {
        id: "opencode",
        name: "OpenCode",
        models: { "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } } },
      },
    ],
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
