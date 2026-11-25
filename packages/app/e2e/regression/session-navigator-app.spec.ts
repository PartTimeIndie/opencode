import { expect, test, type Page, type Route } from "@playwright/test"
import fs from "node:fs/promises"
import path from "node:path"
import { mockOpenCodeServer } from "../utils/mock-server"
import { createRealSessionArchive, type ArchiveCatalogEntry } from "../utils/real-session-archive"
import { expectNoSmokeErrors, trackNetworkFailures, trackPageErrors } from "../utils/errors"
import { expectAppVisible } from "../utils/waits"
import { longFixture } from "../smoke/session-timeline.fixture"

const dirA = "C:/OpenCode/NavA"
const dirB = "C:/OpenCode/NavB"
const sessionID = "nav-a-1"
const server = "http://127.0.0.1:4096"
const generatedIcon =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="

type EventPayload = {
  directory: string
  project?: string
  payload: Record<string, unknown>
}

type NavigatorMockSession = {
  id: string
  directory: string
  title: string
  parentID?: string
  time: { created: number | string; updated: number | string }
  [key: string]: unknown
}

test.describe("session navigator app plugin", () => {
  for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
    test(`favorite controls stay synchronized at ${viewport.width}px`, async ({ page }) => {
      const errors = trackPageErrors(page)
      const failures = trackNetworkFailures(page)
      const sessions = seedSessions()
      await mockOpenCodeServer(page, {
        directory: dirA,
        project: project("proj-a", dirA, "Project A"),
        provider: provider(), sessions, pageMessages: () => ({ items: [] }),
      })
      await mockNavigatorPlugin(page)
      await mockNavigatorData(page, { sessions, archived: new Set(), deleted: new Set() })
      await configurePage(page, { seedNavigatorDock: true })
      // Session tabs are desktop-only; mobile exposes favorites through the navigator dock.
      await page.setViewportSize({ width: 1280, height: 720 })
      await page.goto("/")
      await addDockPane(page, "left", "Session Navigator")
      const favorites = page.locator('.oc-session-nav [data-group-key="favorites"]')
      const tab = page.locator('[data-dock-area="middle"] [data-dock-tab][data-session-id="nav-a-1"]')
      const pin = tab.locator('[data-action="session-tab-favorite"]')
      await expectAppVisible(pin)
      await expect(pin).toHaveAttribute("aria-pressed", "false")
      await pin.click()
      await expect(pin).toHaveAttribute("aria-pressed", "true")
      await expectAppVisible(favorites.getByText("A Session 1"))
      await tab.getByRole("button", { name: "More options" }).click()
      await expect(page.getByRole("menuitem", { name: "Remove from favorites" })).toBeEnabled()
      if (viewport.width === 1280 && process.env.VISUAL_QA_SCREENSHOT_DIR) {
        await page.screenshot({ path: `${process.env.VISUAL_QA_SCREENSHOT_DIR}/favorites-tabs-${viewport.width}.png`, animations: "disabled" })
      }
      await page.getByRole("menuitem", { name: "Remove from favorites" }).click()
      await expect(pin).toHaveAttribute("aria-pressed", "false")
      await tab.getByRole("button", { name: "More options" }).click()
      await expect(page.getByRole("menuitem", { name: "Add to favorites" })).toBeEnabled()
      await page.getByRole("menuitem", { name: "Add to favorites" }).click()
      await expect(pin).toHaveAttribute("aria-pressed", "true")
      await expect(page.getByRole("menu")).toHaveCount(0)
      await pin.focus()
      await expect(pin).toBeFocused()
      await page.keyboard.press("Space")
      await expect(pin).toHaveAttribute("aria-pressed", "false")
      await expect(favorites.getByText("A Session 1")).toHaveCount(0)
      await pin.click()
      await expect(pin).toHaveAttribute("aria-pressed", "true")
      if (viewport.width === 390) {
        await page.setViewportSize(viewport)
        await page.getByRole("button", { name: "Open dock" }).click()
        await page.getByRole("tab", { name: "Session Navigator" }).click()
      }
      const star = favorites.getByRole("button", { name: "Remove A Session 1 from favorites" })
      await expectAppVisible(star)
      await star.scrollIntoViewIfNeeded()
      const hitArea = await star.boundingBox()
      expect(hitArea?.width).toBeGreaterThanOrEqual(32)
      expect(hitArea?.height).toBeGreaterThanOrEqual(32)
      if (process.env.VISUAL_QA_SCREENSHOT_DIR) {
        await page.screenshot({ path: `${process.env.VISUAL_QA_SCREENSHOT_DIR}/favorites-navigator-${viewport.width}.png`, animations: "disabled" })
      }
      if (viewport.width === 1280) {
        const pressed = await star.elementHandle()
        if (!hitArea || !pressed) throw new Error("Favorite control is missing")
        await page.mouse.move(hitArea.x + hitArea.width / 2, hitArea.y + hitArea.height / 2)
        await expect.poll(async () => (await star.boundingBox())?.x).toBe(hitArea.x)
        await expect.poll(() => page.evaluate(({ x, y }) =>
          !!document.elementFromPoint(x, y)?.closest(".oc-session-nav__favorite"),
          { x: hitArea.x + hitArea.width / 2, y: hitArea.y + hitArea.height / 2 },
        )).toBe(true)
        if (process.env.VISUAL_QA_SCREENSHOT_DIR) {
          await page.screenshot({ path: `${process.env.VISUAL_QA_SCREENSHOT_DIR}/favorites-hover-1280.png`, animations: "disabled" })
        }
        await page.mouse.down()
        // Exercise the real browser's interrupted click path, not just dispatched clicks.
        await page.evaluate(() => window.dispatchEvent(new Event("opencode:sidebar-session-limit")))
        await expect.poll(() => pressed.evaluate((node) => node.isConnected)).toBe(false)
        await page.mouse.up()
      }
      if (viewport.width === 390) await star.click()
      await expect(favorites.getByText("A Session 1")).toHaveCount(0)
      if (viewport.width === 1280) await expect(pin).toHaveAttribute("aria-pressed", "false")
      expectNoSmokeErrors(errors, [], [])
      expect(failures).toEqual([])
    })
  }

  test("lists, pages, reorders, archives, and deletes sessions", async ({ page }) => {
    const sessions: NavigatorMockSession[] = seedSessions()
    const events: EventPayload[] = []
    const archived = new Set<string>()
    const deleted = new Set<string>()
    const mutations: Array<{ method: string; sessionID: string; directory?: string }> = []
    const consoleErrors: string[] = []
    const networkFailures: string[] = []
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text())
    })
    page.on("pageerror", (error) => consoleErrors.push(error.message))
    page.on("requestfailed", (request) => {
      if (new URL(request.url()).pathname === "/perf/record" && request.failure()?.errorText === "net::ERR_ABORTED") return
      networkFailures.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`)
    })
    page.on("response", (response) => {
      if (response.status() >= 400) networkFailures.push(`${response.status()} ${response.url()}`)
    })

    await mockOpenCodeServer(page, {
      directory: dirA,
      project: project("proj-a", dirA, "Project A"),
      provider: provider(),
      sessions,
      sessionStatus: { "nav-a-3": { type: "busy" } },
      pageMessages: () => ({ items: [] }),
      events: () => events.splice(0, events.length),
      eventRetry: 16,
      onSessionCreate: () => {
        const next = {
          id: "nav-b-new",
          slug: "nav-b-new",
          projectID: "proj-b",
          directory: dirB,
          title: "New session",
          version: "dev",
          time: { created: 1_700_000_000_300, updated: 1_700_000_000_300 },
        }
        sessions.push(next)
        return next
      },
    })
    await mockNavigatorPlugin(page)
    await mockNavigatorData(page, { sessions, archived, deleted, mutations })
    await configurePage(page, { seedNavigatorDock: true })

    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto("/")
    await addDockPane(page, "left", "Session Navigator")
    const nav = page.locator(".oc-session-nav")
    await expectAppVisible(nav)
    const navigatorTab = page.locator(
      '[data-dock-area="left"] [data-dock-tab="session-navigator-app/sessionNavigator"] [data-slot="tabs-trigger-wrapper"]',
    )
    await expectAppVisible(navigatorTab)
    await expect
      .poll(() => navigatorTab.evaluate((node) => getComputedStyle(node).backgroundColor))
      .not.toBe("rgba(0, 0, 0, 0)")
    await expectAppVisible(nav.getByRole("button", { name: "Add project" }))
    const favorites = nav.locator(".oc-session-nav__section").filter({ hasText: "Favorites" })
    const recent = nav.locator(".oc-session-nav__section").filter({ hasText: "Recent sessions" })
    await expectAppVisible(favorites.locator(".oc-session-nav__avatar--icon"))
    await expectAppVisible(recent.locator(".oc-session-nav__avatar--icon"))

    await expectAppVisible(nav.getByText("A Session 1"))
    await expectAppVisible(nav.getByText("A Session 2"))
    await expectAppVisible(nav.getByText("A Session 3"))
    await expectAppVisible(nav.getByText("A Session 4"))
    await expect(nav.getByText("A Project Session 1")).toHaveCount(0)

    await expectAppVisible(
      recent
        .locator(".oc-session-nav__session")
        .filter({ hasText: "A Session 1" })
        .locator(".oc-session-nav__session-main--project .oc-session-nav__avatar[data-color='purple']"),
    )
    await expectAppVisible(
      recent
        .locator(".oc-session-nav__session")
        .filter({ hasText: "A Session 3" })
        .locator(".oc-session-nav__session-meta--loading .oc-session-nav__spinner"),
    )
    await expect(
      recent
        .locator(".oc-session-nav__session")
        .filter({ hasText: "A Session 3" })
        .locator(".oc-session-nav__spinner"),
    ).toHaveAttribute("class", "oc-session-nav__spinner")
    await expect
      .poll(() =>
        recent
          .locator(".oc-session-nav__session")
          .filter({ hasText: "A Session 3" })
          .locator(".oc-session-nav__spinner")
          .first()
          .evaluate((node) => getComputedStyle(node).animationName),
      )
      .toBe("oc-session-nav-spin")

    const sessionTab = page.locator('[data-dock-area="middle"] [data-dock-tab][data-session-id="nav-a-1"]')
    await sessionTab.hover()
    await sessionTab.getByRole("button", { name: "More options" }).click()
    await expect(page.getByRole("menuitem", { name: "Rename" })).toHaveCount(1)
    await expect(page.getByRole("menuitem", { name: "Add to favorites" })).toHaveCount(1)
    await expect(page.getByRole("menuitem", { name: "Remove from favorites" })).toHaveCount(0)
    await expect(page.getByRole("menuitem", { name: "Archive" })).toHaveCount(1)
    await expect(page.getByRole("menuitem", { name: "Delete" })).toHaveCount(1)
    await page.getByRole("menuitem", { name: "Add to favorites" }).click({ force: true })
    await expectAppVisible(favorites.getByText("A Session 1"))
    await expectAppVisible(
      favorites
        .locator(".oc-session-nav__session")
        .filter({ hasText: "A Session 1" })
        .locator(".oc-session-nav__session-main--project .oc-session-nav__avatar[data-color='purple']"),
    )
    await page.keyboard.press("Escape")

    const sessionTwoRow = nav.locator(".oc-session-nav__session").filter({ hasText: "A Session 2" }).first()
    await sessionTwoRow.getByRole("button", { name: "Add A Session 2 to favorites" }).click()
    await expectAppVisible(favorites.getByText("A Session 2"))
    await expectAppVisible(
      favorites
        .locator(".oc-session-nav__session")
        .filter({ hasText: "A Session 2" })
        .locator(".oc-session-nav__session-main--project .oc-session-nav__avatar[data-color='purple']"),
    )
    await favorites.getByRole("button", { name: "Remove A Session 2 from favorites" }).click()
    await expect(favorites.getByText("A Session 2")).toHaveCount(0)
    await sessionTwoRow.locator(".oc-session-nav__session-main").click()
    await expect(page).toHaveURL(new RegExp(`/($|\\?)`))
    await expectAppVisible(page.locator('[data-dock-area="middle"] [data-dock-tab][data-session-id="nav-a-2"]'))
    await expect(
      page.locator('[data-dock-area="middle"] [data-dock-tab][data-session-id="nav-a-2"]').getByRole("tab"),
    ).toHaveAttribute("aria-selected", "true")

    await sessionTwoRow.click({ button: "right" })
    await expectAppVisible(page.getByRole("button", { name: "Rename" }))
    await page.getByRole("button", { name: "Rename" }).click()
    const rename = page.getByRole("dialog", { name: "Rename session" })
    await rename.getByRole("textbox", { name: "Session title" }).fill("Renamed Session 2")
    await rename.getByRole("button", { name: "Save" }).click()
    await expectAppVisible(nav.getByText("Renamed Session 2"))

    await nav
      .locator(".oc-session-nav__section")
      .filter({ hasText: "Recent sessions" })
      .getByRole("button", { name: "More" })
      .click()
    await expectAppVisible(nav.getByText("A Project Session 1"))
    await expectAppVisible(
      nav
        .locator(".oc-session-nav__section")
        .filter({ hasText: "Recent sessions" })
        .getByRole("button", { name: "Less" }),
    )
    await nav
      .locator(".oc-session-nav__section")
      .filter({ hasText: "Recent sessions" })
      .getByRole("button", { name: "Less" })
      .click()
    await expect(nav.getByText("A Project Session 1")).toHaveCount(0)
    await expectAppVisible(
      nav
        .locator(".oc-session-nav__section")
        .filter({ hasText: "Recent sessions" })
        .getByRole("button", { name: "More" }),
    )

    const projectA = nav.locator(".oc-session-nav__project").filter({ hasText: "Project A" })
    const projectB = nav.locator(".oc-session-nav__project").filter({ hasText: "Project B" })
    await expect(projectA.locator(".oc-session-nav__avatar")).toHaveAttribute("data-color", "purple")
    await expect(projectA.locator(".oc-session-nav__avatar img")).toHaveCount(0)
    await expect(sessionTab.locator('[data-slot="project-avatar-image"]')).toHaveCount(0)
    await expect(projectB.locator(".oc-session-nav__avatar")).toHaveAttribute("data-color", "green")
    events.push({
      directory: "global",
      payload: {
        type: "project.updated",
        properties: {
          ...project("proj-a", dirA, "Project A"),
          icon: { color: "purple", generated: generatedIcon },
          iconGeneration: { mode: "inherit", status: "ready", attempt: 1 },
        },
      },
    })
    await expect.poll(() => events.length).toBe(0)
    await expect(projectA.locator(".oc-session-nav__avatar img")).toHaveAttribute("src", generatedIcon)
    await expect(sessionTab.locator('[data-slot="project-avatar-image"]')).toHaveAttribute("src", generatedIcon)
    expect(
      await Promise.all([
        projectA.locator(".oc-session-nav__avatar").evaluate((node) => {
          const rect = node.getBoundingClientRect()
          return { width: rect.width, height: rect.height, overflow: getComputedStyle(node).overflow }
        }),
        sessionTab.locator('[data-slot="project-avatar-surface"]').evaluate((node) => {
          const rect = node.getBoundingClientRect()
          return { width: rect.width, height: rect.height, overflow: getComputedStyle(node).overflow }
        }),
      ]),
    ).toEqual([
      { width: 18, height: 18, overflow: "hidden" },
      { width: 16, height: 16, overflow: "hidden" },
    ])
    await fs.mkdir(path.join(".agent-tmp", "project-icon-qa"), { recursive: true })
    await page.screenshot({ path: path.join(".agent-tmp", "project-icon-qa", "desktop-1440x900.png") })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole("button", { name: "Open dock" }).click()
    await page.getByRole("tab", { name: "Session Navigator" }).click()
    await expectAppVisible(nav)
    await expect(projectA.locator(".oc-session-nav__avatar img")).toHaveAttribute("src", generatedIcon)
    await projectA.scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(".agent-tmp", "project-icon-qa", "mobile-390x844.png") })
    await page.getByRole("button", { name: "Open settings" }).click()
    const generatedProjectIconsTitle = page.getByText("Automatically generate project icons")
    const generatedProjectIcons = page.locator('[data-action="settings-generated-project-icons"]')
    await generatedProjectIconsTitle.scrollIntoViewIfNeeded()
    await expectAppVisible(generatedProjectIconsTitle)
    await expect(generatedProjectIcons.locator('[role="switch"]')).not.toBeChecked()
    await page.screenshot({ path: path.join(".agent-tmp", "project-icon-qa", "mobile-settings-390x844.png") })
    await page.keyboard.press("Escape")
    await page.setViewportSize({ width: 1440, height: 900 })
    await expectAppVisible(nav)
    await projectA.locator(".oc-session-nav__project-toggle").click()
    await expectAppVisible(projectA.getByText("A Session 1"))
    await expect(projectA.locator(".oc-session-nav__session-main--project")).toHaveCount(0)
    await expect(projectA.getByText("A Project Session 1")).toHaveCount(0)
    await projectA.getByRole("button", { name: "More" }).click()
    await expectAppVisible(projectA.getByText("A Project Session 1"))
    await expectAppVisible(projectA.getByRole("button", { name: "Less" }))

    const archiveRow = nav.locator(".oc-session-nav__session").filter({ hasText: "A Project Session 2" }).first()
    await archiveRow.hover()
    await archiveRow.getByRole("button", { name: "Archive" }).click()
    await expect(nav.getByText("A Project Session 2")).toHaveCount(0)
    expect(archived.has("nav-a-project-2")).toBe(true)
    expect(mutations).toContainEqual({ method: "PATCH", sessionID: "nav-a-project-2", directory: dirA })

    const deleteRow = nav.locator(".oc-session-nav__session").filter({ hasText: "A Session 1" }).first()
    await deleteRow.hover()
    await deleteRow.getByRole("button", { name: "Delete" }).click()
    await deleteRow.getByRole("button", { name: "Yes" }).click()
    await expect(page).toHaveURL(new RegExp(`/($|\\?)`))
    await expectAppVisible(page.locator('[data-dock-area="middle"] [data-dock-tab][data-session-id="nav-a-2"]'))
    expect(deleted.has("nav-a-1")).toBe(true)
    expect(mutations).toContainEqual({ method: "DELETE", sessionID: "nav-a-1", directory: dirA })
    await expect(recent.getByText("A Session 1")).toHaveCount(0)
    await expectAppVisible(recent.getByText("A Project Session 1"))
    if (process.env.VISUAL_QA_SCREENSHOT_DIR) {
      await fs.mkdir(process.env.VISUAL_QA_SCREENSHOT_DIR, { recursive: true })
      await page.screenshot({
        path: `${process.env.VISUAL_QA_SCREENSHOT_DIR}/session-navigator-recent-refill.png`,
        fullPage: true,
      })
    }

    await expect(projectA.getByRole("button", { name: "Move Project A up" })).toBeDisabled()
    await expect(projectB.getByRole("button", { name: "Move Project B down" })).toBeDisabled()
    await projectB.getByRole("button", { name: "Move Project B up" }).click()
    await expect
      .poll(async () =>
        nav
          .locator(".oc-session-nav__project-name")
          .evaluateAll((nodes) => nodes.map((node) => node.textContent ?? "")),
      )
      .toEqual(["Project B", "Project A"])

    await nav.getByRole("button", { name: "New session for Project B" }).click()
    await expect(page).toHaveURL(new RegExp(`/($|\\?)`))
    await expectAppVisible(page.locator('[data-dock-area="middle"]').getByRole("tab", { name: "New session" }))
    await expectAppVisible(page.locator('[data-dock-area="middle"]').getByRole("textbox", { name: /Ask anything/ }))
    await expectAppVisible(
      page.locator('[data-dock-area="left"] .oc-session-nav__project-toggle').filter({ hasText: "Project B" }),
    )
    if (process.env.VISUAL_QA_SCREENSHOT_DIR) {
      await page.waitForTimeout(250)
      await page.screenshot({
        path: `${process.env.VISUAL_QA_SCREENSHOT_DIR}/session-navigator-contracts-final.png`,
        fullPage: true,
      })
      await fs.writeFile(
        path.join(process.env.VISUAL_QA_SCREENSHOT_DIR, "session-navigator-contracts.json"),
        JSON.stringify(
          {
            archived: [...archived],
            deleted: [...deleted],
            mutations,
            projectOrder: await nav
              .locator(".oc-session-nav__project-name")
              .evaluateAll((nodes) => nodes.map((node) => node.textContent ?? "")),
          },
          null,
          2,
        ),
      )
    }
    expect(consoleErrors).toEqual([])
    expect(networkFailures).toEqual([])
  })

  test("renders invalid session timestamps without NaN", async ({ page }) => {
    const sessions: NavigatorMockSession[] = [
      session("nav-a-1", "Valid Time", dirA, Date.now() - 60_000),
      {
        ...session("nav-a-invalid-time", "Invalid Time", dirA, Date.now() - 120_000),
        time: { created: "not-a-date", updated: "not-a-date" },
      },
    ]

    await mockOpenCodeServer(page, {
      directory: dirA,
      project: project("proj-a", dirA, "Project A"),
      provider: provider(),
      sessions,
      pageMessages: () => ({ items: [] }),
    })
    await mockNavigatorPlugin(page)
    await mockNavigatorData(page, { sessions, archived: new Set(), deleted: new Set() })
    await configurePage(page, { seedNavigatorDock: true })

    await page.setViewportSize({ width: 1280, height: 840 })
    await page.goto("/")
    await addDockPane(page, "left", "Session Navigator")
    const nav = page.locator(".oc-session-nav")
    await expectAppVisible(nav)
    const invalid = nav.locator(".oc-session-nav__session").filter({ hasText: "Invalid Time" }).first()
    await expectAppVisible(invalid)
    await expect(invalid.locator(".oc-session-nav__session-meta")).toHaveText("")
    await expect(nav).not.toContainText("NaN")

    if (process.env.VISUAL_QA_SCREENSHOT_DIR) {
      await fs.mkdir(process.env.VISUAL_QA_SCREENSHOT_DIR, { recursive: true })
      await nav.screenshot({ path: `${process.env.VISUAL_QA_SCREENSHOT_DIR}/session-navigator-invalid-time.png` })
    }
  })

  test("persists project order moved from the navigator across reloads", async ({ page }) => {
    const sessions = seedSessions()
    await mockOpenCodeServer(page, {
      directory: dirA,
      project: [project("proj-a", dirA, "Project A"), project("proj-b", dirB, "Project B")],
      provider: provider(),
      sessions,
      pageMessages: () => ({ items: [] }),
    })
    await mockNavigatorPlugin(page)
    await mockNavigatorData(page, { sessions, archived: new Set(), deleted: new Set() })
    await configurePage(page, { preserveServerOnReload: true, seedNavigatorDock: true })

    await page.setViewportSize({ width: 1280, height: 840 })
    await page.goto("/")
    await addDockPane(page, "left", "Session Navigator")
    const nav = page.locator(".oc-session-nav")
    const projectNames = () =>
      nav.locator(".oc-session-nav__project-name").evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ""))
    const storedProjectOrder = () =>
      page.evaluate(() => {
        const value = localStorage.getItem("opencode.global.dat:server")
        if (!value) return []
        const parsed = JSON.parse(value) as { projects?: { local?: Array<{ worktree?: string }> } }
        return parsed.projects?.local?.map((project) => project.worktree ?? "") ?? []
      })

    await expectAppVisible(nav)
    await expect.poll(projectNames).toEqual(["Project A", "Project B"])
    await nav.getByRole("button", { name: "Move Project B up" }).click()
    await expect.poll(projectNames).toEqual(["Project B", "Project A"])
    await expect.poll(storedProjectOrder).toEqual([dirB, dirA])

    await page.reload()
    await expectAppVisible(nav)
    await expect.poll(projectNames).toEqual(["Project B", "Project A"])
    await expect.poll(storedProjectOrder).toEqual([dirB, dirA])
  })

  test("decodes an existing ICO and persists exact Navigator-only project hiding", async ({ page }) => {
    const pixels = Buffer.from(generatedIcon.split(",")[1], "base64")
    const header = Buffer.from([0, 0, 1, 0, 1, 0, 1, 1, 0, 0, 1, 0, 32, 0, 0, 0, 0, 0, 22, 0, 0, 0])
    header.writeUInt32LE(pixels.length, 14)
    const ico = `data:image/vnd.microsoft.icon;base64,${Buffer.concat([header, pixels]).toString("base64")}`
    const sessions = seedSessions()
    const mutations: { method: string; sessionID: string; directory?: string }[] = []
    await mockOpenCodeServer(page, {
      directory: dirA,
      project: [
        { ...project("proj-a", dirA, "Project A"), icon: { url: ico, color: "purple" } },
        project("proj-b", dirB, "Project B"),
      ],
      provider: provider(), sessions, pageMessages: () => ({ items: [] }),
    })
    await mockNavigatorPlugin(page)
    await mockNavigatorData(page, { sessions, archived: new Set(), deleted: new Set(), mutations })
    await configurePage(page, { preserveServerOnReload: true, seedNavigatorDock: true, favoriteSessionID: sessionID })
    await page.setViewportSize({ width: 1280, height: 840 })
    await page.goto("/")
    await addDockPane(page, "left", "Session Navigator")

    const nav = page.locator(".oc-session-nav")
    const projectA = nav.locator(`.oc-session-nav__project-toggle[title="${dirA}"]`)
    const projectB = nav.locator(`.oc-session-nav__project-toggle[title="${dirB}"]`)
    const icon = projectA.locator("img")
    await expect(icon).toHaveAttribute("src", ico)
    await expect.poll(() => icon.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth)).toBe(1)
    const favorite = nav.locator('[data-group-key="favorites"]').getByText("A Session 1", { exact: true })
    await expectAppVisible(favorite)
    const manage = nav.getByRole("button", { name: "Manage hidden projects" })
    await manage.click()
    await nav.getByRole("button", { name: `Hide ${dirA} in Navigator`, exact: true }).click()
    const restore = nav.getByRole("button", { name: `Show ${dirA} in Navigator`, exact: true })
    await expect(restore).toBeFocused()
    await manage.click()
    await expect(projectA).toHaveCount(0)
    await expectAppVisible(projectB)
    await expect(nav.getByText("A Session 1", { exact: true })).toHaveCount(0)

    await page.reload()
    await expectAppVisible(projectB)
    await expect(projectA).toHaveCount(0)
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("opencode.global.dat:server") ?? "{}"))
    expect(stored.projects.local.map((row: { worktree: string }) => row.worktree)).toEqual([dirA, dirB])
    await manage.click()
    await restore.click()
    await manage.click()
    await expectAppVisible(projectA)
    await expect(icon).toHaveAttribute("src", ico)
    await expectAppVisible(favorite)
    expect(mutations).toEqual([])
  })

  test("shows remove action for favorited session tabs", async ({ page }) => {
    const sessions = seedSessions()
    await mockOpenCodeServer(page, {
      directory: dirA,
      project: project("proj-a", dirA, "Project A"),
      provider: provider(),
      sessions,
      pageMessages: () => ({ items: [] }),
    })
    await configurePage(page, { favoriteSessionID: sessionID })

    await page.setViewportSize({ width: 1280, height: 840 })
    await page.goto("/")
    const sessionTab = page.locator('[data-dock-area="middle"] [data-dock-tab][data-session-id="nav-a-1"]')
    await sessionTab.hover()
    await sessionTab.getByRole("button", { name: "More options" }).click()
    await expect(page.getByRole("menuitem", { name: "Remove from favorites" })).toHaveCount(1)
    await expect(page.getByRole("menuitem", { name: "Add to favorites" })).toHaveCount(0)
    await page.getByRole("menuitem", { name: "Remove from favorites" }).click({ force: true })
    await expect
      .poll(() =>
        page.evaluate(() => {
          const stored = localStorage.getItem("opencode.global.dat:session-favorites")
          const value = stored ? JSON.parse(stored) : { items: {} }
          return Object.keys(value.items ?? {}).length
        }),
      )
      .toBe(0)
  })

  test("uses the configured visible session limit", async ({ page }) => {
    await mockOpenCodeServer(page, {
      directory: dirA,
      project: project("proj-a", dirA, "Project A"),
      provider: provider(),
      sessions: seedSessions(),
      pageMessages: () => ({ items: [] }),
    })
    await mockNavigatorPlugin(page)
    await mockNavigatorData(page, { sessions: seedSessions(), archived: new Set(), deleted: new Set() })
    await configurePage(page, { seedNavigatorDock: true, sidebarSessionLimit: 2 })

    await page.setViewportSize({ width: 1280, height: 840 })
    await page.goto("/")
    await addDockPane(page, "left", "Session Navigator")
    const nav = page.locator(".oc-session-nav")
    await expectAppVisible(nav)

    await expectAppVisible(nav.getByText("A Session 1"))
    await expectAppVisible(nav.getByText("A Session 2"))
    await expect(nav.getByText("A Session 3")).toHaveCount(0)

    const recent = nav.locator(".oc-session-nav__section").filter({ hasText: "Recent sessions" })
    await recent.getByRole("button", { name: "More" }).click()
    await expectAppVisible(nav.getByText("A Session 3"))
    await recent.getByRole("button", { name: "Less" }).click()
    await expect(nav.getByText("A Session 3")).toHaveCount(0)
  })

  test("keeps loaded session groups expanded after opening a session", async ({ page }) => {
    const sessions = seedSessions()
    await mockOpenCodeServer(page, {
      directory: dirA,
      project: project("proj-a", dirA, "Project A"),
      provider: provider(),
      sessions,
      pageMessages: () => ({ items: [] }),
    })
    await mockNavigatorPlugin(page)
    await mockNavigatorData(page, { sessions, archived: new Set(), deleted: new Set() })
    await configurePage(page, { seedNavigatorDock: true })

    await page.setViewportSize({ width: 1280, height: 840 })
    await page.goto("/")
    await addDockPane(page, "left", "Session Navigator")
    const nav = page.locator(".oc-session-nav")
    await expectAppVisible(nav)

    const projectA = nav.locator(".oc-session-nav__project").filter({ hasText: "Project A" })
    await projectA.locator(".oc-session-nav__project-toggle").click()
    await projectA.getByRole("button", { name: "More" }).click()
    await expectAppVisible(projectA.getByText("A Project Session 4"))
    await expectAppVisible(projectA.getByRole("button", { name: "Less" }))

    await projectA
      .locator(".oc-session-nav__session")
      .filter({ hasText: "A Project Session 4" })
      .locator(".oc-session-nav__session-main")
      .click()
    await expect(page).toHaveURL(new RegExp(`/($|\\?)`))
    await expectAppVisible(page.locator('[data-dock-area="middle"] [data-dock-tab][data-session-id="nav-a-project-4"]'))
    await expectAppVisible(projectA.getByText("A Project Session 4"))
    await expectAppVisible(projectA.getByRole("button", { name: "Less" }))
  })

  test("opens the session tab before a delayed session validation completes", async ({ page }) => {
    const sessions = seedSessions()
    const validation = Promise.withResolvers<void>()
    let validations = 0
    await mockOpenCodeServer(page, {
      directory: dirA,
      project: project("proj-a", dirA, "Project A"),
      provider: provider(),
      sessions,
      pageMessages: () => ({ items: [] }),
    })
    await mockNavigatorPlugin(page)
    await mockNavigatorData(page, { sessions, archived: new Set(), deleted: new Set() })
    await page.route(`${server}/session/nav-a-2/exists?**`, (route) => {
      if (route.request().method() !== "GET") return route.fallback()
      validations++
      return validation.promise.then(() =>
        json(route, { exists: true, session: sessions.find((session) => session.id === "nav-a-2") }),
      )
    })
    await configurePage(page, { seedNavigatorDock: true })

    await page.setViewportSize({ width: 1280, height: 840 })
    await page.goto("/")
    await addDockPane(page, "left", "Session Navigator")
    const nav = page.locator(".oc-session-nav")
    const row = nav.locator(".oc-session-nav__session").filter({ hasText: "A Session 2" }).first()
    await expectAppVisible(row)

    await row.locator(".oc-session-nav__session-main").click()
    const tab = page.locator('[data-dock-area="middle"] [data-dock-tab][data-session-id="nav-a-2"]')
    await expectAppVisible(tab)
    await expect(tab.getByRole("tab")).toHaveAttribute("aria-selected", "true")
    await expect.poll(() => validations).toBeGreaterThan(0)
    validation.resolve()
  })

  test("keeps optimistic navigation after a session validation error", async ({ page }) => {
    const sessions = seedSessions()
    const errors: string[] = []
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text())
    })
    await mockOpenCodeServer(page, {
      directory: dirA,
      project: project("proj-a", dirA, "Project A"),
      provider: provider(),
      sessions,
      pageMessages: () => ({ items: [] }),
    })
    await mockNavigatorPlugin(page)
    await mockNavigatorData(page, { sessions, archived: new Set(), deleted: new Set() })
    await page.route(`${server}/session/nav-a-2/exists?**`, (route) => {
      if (route.request().method() !== "GET") return route.fallback()
      return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "Database busy" }) })
    })
    await configurePage(page, { seedNavigatorDock: true })

    await page.setViewportSize({ width: 1280, height: 840 })
    await page.goto("/")
    await addDockPane(page, "left", "Session Navigator")
    const nav = page.locator(".oc-session-nav")
    const row = nav.locator(".oc-session-nav__session").filter({ hasText: "A Session 2" }).first()
    await expectAppVisible(row)

    await row.locator(".oc-session-nav__session-main").click()
    const tab = page.locator('[data-dock-area="middle"] [data-dock-tab][data-session-id="nav-a-2"]')
    await expectAppVisible(tab)
    await expect(tab.getByRole("tab")).toHaveAttribute("aria-selected", "true")
    await expect.poll(() => errors.some((message) => message.includes("could not validate session nav-a-2"))).toBe(true)
    await expectAppVisible(row)
  })

  test("removes a stale row only after a confirmed not found response", async ({ page }) => {
    const sessions = seedSessions()
    const events: EventPayload[] = []
    await mockOpenCodeServer(page, {
      directory: dirA,
      project: project("proj-a", dirA, "Project A"),
      provider: provider(),
      sessions,
      pageMessages: () => ({ items: [] }),
      events: () => events.splice(0, events.length),
      eventRetry: 16,
    })
    await mockNavigatorPlugin(page)
    await mockNavigatorData(page, { sessions, archived: new Set(), deleted: new Set() })
    await page.route(`${server}/session/nav-a-2/exists?**`, (route) => {
      if (route.request().method() !== "GET") return route.fallback()
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ exists: false }) })
    })
    await configurePage(page, { seedNavigatorDock: true })

    await page.setViewportSize({ width: 1280, height: 840 })
    await page.goto("/")
    await addDockPane(page, "left", "Session Navigator")
    const nav = page.locator(".oc-session-nav")
    const row = nav.locator(".oc-session-nav__session").filter({ hasText: "A Session 2" }).first()
    await expectAppVisible(row)

    await row.locator(".oc-session-nav__session-main").click()
    const tab = page.locator('[data-dock-area="middle"] [data-dock-tab][data-session-id="nav-a-2"]')
    await expectAppVisible(tab)
    await expect(tab.getByRole("tab")).toHaveAttribute("aria-selected", "true")
    await expect(row).toHaveCount(0)

    const stale = sessions.find((session) => session.id === "nav-a-2")!
    stale.directory = dirA.replaceAll("\\", "/").toUpperCase()
    const showSubagents = nav.getByRole("checkbox", { name: "Show subagents" })
    await showSubagents.check()
    await showSubagents.uncheck()
    await expect(row).toHaveCount(0)

    stale.title = "A Session 2 restored"
    stale.time.updated = Date.now()
    events.push({
      directory: stale.directory,
      payload: { type: "session.updated", properties: { info: stale } },
    })
    await expectAppVisible(nav.getByText("A Session 2 restored", { exact: true }))
  })

  test("keeps a stale favorite listed without navigating so the current session stays visible", async ({ page }) => {
    const errors = trackPageErrors(page)
    const sessions = seedSessions()
    await mockOpenCodeServer(page, {
      directory: dirA,
      project: project("proj-a", dirA, "Project A"),
      provider: provider(),
      sessions,
      pageMessages: () => ({ items: [] }),
    })
    await mockNavigatorPlugin(page)
    await mockNavigatorData(page, { sessions, archived: new Set(), deleted: new Set() })
    await page.route(`${server}/session/nav-a-2/exists?**`, (route) => {
      if (route.request().method() !== "GET") return route.fallback()
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ exists: false }) })
    })
    await configurePage(page, {
      seedNavigatorDock: true,
      favoriteSession: {
        id: "nav-a-2",
        title: "A Session 2",
        slug: "a-session-2",
        time: { created: 1_700_000_000_080, updated: 1_700_000_000_090 },
      },
    })

    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto("/")
    const launcher = page.locator('[data-action="mobile-dock-launcher"]')
    await expectAppVisible(launcher)
    await launcher.click()
    const mobileDock = page.locator('[data-dock-area="mobile"]')
    await expectAppVisible(mobileDock)
    await mobileDock.getByRole("tab", { name: "Session Navigator" }).click()
    const nav = page.locator(".oc-session-nav")
    const favorites = nav.locator(".oc-session-nav__section").filter({ hasText: "Favorites" })
    const stale = favorites.locator(".oc-session-nav__session").filter({ hasText: "A Session 2" })
    await expectAppVisible(stale)

    await stale.locator(".oc-session-nav__session-main").click()

    await expect(stale).toHaveCount(1)
    await expect(stale).toHaveClass(/oc-session-nav__session--missing/)
    await expect
      .poll(() =>
        page.evaluate(() => {
          const tabs = JSON.parse(localStorage.getItem("opencode.global.dat:tabs") ?? "[]") as Array<{
            type?: string
            sessionId?: string
          }>
          return tabs.some((tab) => tab.type === "session" && tab.sessionId === "nav-a-2")
        }),
      )
      .toBe(false)
    await launcher.click()
    await expect(mobileDock).toHaveCount(0)
    await expectAppVisible(page.getByRole("heading", { name: "A Session 1" }))
    if (process.env.VISUAL_QA_SCREENSHOT_DIR) {
      await page.screenshot({
        path: `${process.env.VISUAL_QA_SCREENSHOT_DIR}/mobile-stale-favorite-keeps-session.png`,
        fullPage: true,
      })
    }
    expectNoSmokeErrors(errors, [], [])
  })

  test("keeps an offscreen session navigator reachable in a crowded 375px mobile dock", async ({ page }) => {
    const errors = trackPageErrors(page)
    const failures = trackNetworkFailures(page)
    const sessions = seedSessions()
    await mockOpenCodeServer(page, {
      directory: dirA,
      project: project("proj-a", dirA, "Project A"),
      provider: provider(),
      sessions,
      pageMessages: () => ({ items: [] }),
    })
    await mockNavigatorPlugin(page)
    await mockNavigatorData(page, { sessions, archived: new Set(), deleted: new Set() })
    await configurePage(page, { seedCrowdedMobileDock: true })

    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto("/")
    await page.locator('[data-action="mobile-dock-launcher"]').click()
    const mobileDock = page.locator('[data-dock-area="mobile"]')
    await expectAppVisible(mobileDock)
    await expect(mobileDock.getByRole("tab", { name: "Review" })).toHaveAttribute("aria-selected", "true")

    const navigatorTab = mobileDock.getByRole("tab", { name: "Session Navigator" })
    const navigatorVisibleRatio = () =>
      mobileDock.evaluate((root) => {
        const list = root.querySelector<HTMLElement>('[role="tablist"]')!.getBoundingClientRect()
        const tab = root
          .querySelector<HTMLElement>('[data-dock-tab="session-navigator-app/sessionNavigator"]')!
          .getBoundingClientRect()
        return Math.max(0, Math.min(tab.right, list.right) - Math.max(tab.left, list.left)) / tab.width
      })
    await expect.poll(navigatorVisibleRatio).toBeLessThan(0.5)
    const direction = await mobileDock.evaluate((root) => {
      const list = root.querySelector<HTMLElement>('[role="tablist"]')!.getBoundingClientRect()
      const tab = root
        .querySelector<HTMLElement>('[data-dock-tab="session-navigator-app/sessionNavigator"]')!
        .getBoundingClientRect()
      return tab.left < list.left ? "left" : "right"
    })
    const scrollToNavigator = mobileDock.getByRole("button", {
      name: direction === "left" ? "Scroll dock tabs left" : "Scroll dock tabs right",
    })
    await expectAppVisible(scrollToNavigator)
    await expect(scrollToNavigator).toBeEnabled()
    await scrollToNavigator.click()
    await expect.poll(navigatorVisibleRatio).toBeGreaterThan(0.75)
    await navigatorTab.click()

    const nav = page.locator(".oc-session-nav")
    await expectAppVisible(nav.getByText("A Session 1", { exact: true }))
    await nav
      .locator(".oc-session-nav__session")
      .filter({ hasText: "A Session 2" })
      .locator(".oc-session-nav__session-main")
      .click()
    await expectAppVisible(page.getByRole("heading", { name: "A Session 2" }))
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true)
    expectNoSmokeErrors(errors, [], [])
    expect(failures).toEqual([])
  })

  test("preserves a row activation while a status reorder happens between pointer down and up", async ({ page }) => {
    const sessions = seedSessions()
    const events: EventPayload[] = []
    const sessionStatus: Record<string, { type: "busy" }> = {}
    await mockOpenCodeServer(page, {
      directory: dirA,
      project: project("proj-a", dirA, "Project A"),
      provider: provider(),
      sessions,
      sessionStatus,
      pageMessages: () => ({ items: [] }),
      events: () => events.splice(0, events.length),
      eventRetry: 16,
    })
    await mockNavigatorPlugin(page)
    await mockNavigatorData(page, { sessions, archived: new Set(), deleted: new Set() })
    await configurePage(page, { seedNavigatorDock: true })

    await page.setViewportSize({ width: 1280, height: 840 })
    await page.goto("/")
    await addDockPane(page, "left", "Session Navigator")
    const nav = page.locator(".oc-session-nav")
    const recent = nav.locator(".oc-session-nav__section").filter({ hasText: "Recent sessions" })
    const titles = () =>
      recent
        .locator(".oc-session-nav__session-title")
        .evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ""))
    const row = recent.locator(".oc-session-nav__session").filter({ hasText: "A Session 2" }).first()
    const box = await row.locator(".oc-session-nav__session-main").boundingBox()
    expect(box).not.toBeNull()

    await page.mouse.move(box!.x + 12, box!.y + 12)
    await page.mouse.down()
    sessionStatus["nav-a-4"] = { type: "busy" }
    events.push({
      directory: dirA,
      payload: { type: "session.status", properties: { sessionID: "nav-a-4", status: { type: "busy" } } },
    })
    await expect.poll(titles).toEqual(["A Session 4", "A Session 1", "A Session 2", "A Session 3"])
    await page.mouse.up()

    const tab = page.locator('[data-dock-area="middle"] [data-dock-tab][data-session-id="nav-a-2"]')
    await expectAppVisible(tab)
    await expect(tab.getByRole("tab")).toHaveAttribute("aria-selected", "true")
  })

  test("keeps the navigator visible after selecting a session tab from another project", async ({ page }) => {
    const sessions = seedSessions()
    await mockOpenCodeServer(page, {
      directory: dirA,
      project: [project("proj-a", dirA, "Project A"), project("proj-b", dirB, "Project B")],
      provider: provider(),
      sessions,
      pageMessages: () => ({ items: [] }),
    })
    await mockNavigatorPlugin(page)
    await mockNavigatorData(page, { sessions, archived: new Set(), deleted: new Set() })
    await configurePage(page, {
      seedNavigatorDock: true,
      tabs: [
        { type: "session", server, dirBase64: base64Encode(dirA), sessionId: sessionID },
        { type: "session", server, dirBase64: base64Encode(dirB), sessionId: "nav-b-1" },
      ],
    })

    await page.setViewportSize({ width: 1280, height: 840 })
    await page.goto("/")
    await addDockPane(page, "left", "Session Navigator")
    await expectAppVisible(page.locator('[data-dock-area="left"] .oc-session-nav'))

    await page.locator('[data-dock-area="middle"] [data-dock-tab][data-session-id="nav-b-1"]').getByRole("tab").click()
    await expect(page).toHaveURL(new RegExp(`/($|\\?)`))
    await expectAppVisible(page.locator('[data-dock-area="middle"] [data-dock-tab][data-session-id="nav-b-1"]'))
    await expectAppVisible(
      page.locator('[data-dock-area="left"] [data-dock-tab="session-navigator-app/sessionNavigator"]'),
    )
    await expectAppVisible(page.locator('[data-dock-area="left"] .oc-session-nav'))
    if (process.env.VISUAL_QA_SCREENSHOT_DIR) {
      await page.screenshot({
        path: `${process.env.VISUAL_QA_SCREENSHOT_DIR}/session-navigator-cross-project-tab.png`,
        fullPage: true,
      })
    }
  })

  test("adds new sessions from events without collapsing loaded groups", async ({ page }) => {
    const sessions = seedSessions()
    const events: EventPayload[] = []
    await mockOpenCodeServer(page, {
      directory: dirA,
      project: project("proj-a", dirA, "Project A"),
      provider: provider(),
      sessions,
      pageMessages: () => ({ items: [] }),
      events: () => events.splice(0, events.length),
      eventRetry: 16,
    })
    await mockNavigatorPlugin(page)
    await mockNavigatorData(page, { sessions, archived: new Set(), deleted: new Set() })
    await configurePage(page, { seedNavigatorDock: true })

    await page.setViewportSize({ width: 1280, height: 840 })
    await page.goto("/")
    await addDockPane(page, "left", "Session Navigator")
    const nav = page.locator(".oc-session-nav")
    await expectAppVisible(nav)

    const projectA = nav.locator(".oc-session-nav__project").filter({ hasText: "Project A" })
    await projectA.locator(".oc-session-nav__project-toggle").click()
    await projectA.getByRole("button", { name: "More" }).click()
    await expectAppVisible(projectA.getByText("A Project Session 4"))
    await expectAppVisible(projectA.getByRole("button", { name: "Less" }))

    // Windows spelling variants of the same directory must be treated as the
    // same identity by the live upsert path (backslashes vs forward slashes).
    const variantDir = dirA.replaceAll("/", "\\")
    const next = session("nav-a-new", "A New Session", variantDir, 1_700_000_000_200)
    sessions.push({ ...next, directory: dirA })
    events.push({
      directory: dirA,
      payload: {
        type: "session.created",
        properties: { info: next },
      },
    })

    await expectAppVisible(projectA.getByText("A New Session"))
    await expectAppVisible(projectA.getByText("A Project Session 4"))
    await expectAppVisible(projectA.getByRole("button", { name: "Less" }))
  })

  test("keeps active recent sessions anchored until idle", async ({ page }) => {
    const sessions = seedSessions()
    const events: EventPayload[] = []
    const sessionStatus: Record<string, { type: "busy" | "idle" }> = {}
    const consoleErrors: string[] = []
    const networkFailures: string[] = []
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text())
    })
    page.on("pageerror", (error) => consoleErrors.push(error.message))
    page.on("requestfailed", (request) =>
      networkFailures.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`),
    )
    page.on("response", (response) => {
      if (response.status() >= 400) networkFailures.push(`${response.status()} ${response.url()}`)
    })
    await mockOpenCodeServer(page, {
      directory: dirA,
      project: project("proj-a", dirA, "Project A"),
      provider: provider(),
      sessions,
      sessionStatus,
      pageMessages: () => ({ items: [] }),
      events: () => events.splice(0, events.length),
      eventRetry: 16,
    })
    await mockNavigatorPlugin(page)
    await mockNavigatorData(page, { sessions, archived: new Set(), deleted: new Set() })
    await configurePage(page, { seedNavigatorDock: true })

    await page.setViewportSize({ width: 1280, height: 840 })
    await page.goto("/")
    await addDockPane(page, "left", "Session Navigator")
    const nav = page.locator(".oc-session-nav")
    await expectAppVisible(nav)
    const search = nav.getByPlaceholder("Search sessions")
    const showSubagents = nav.getByRole("checkbox", { name: "Show subagents" })
    const recent = nav.locator(".oc-session-nav__section").filter({ hasText: "Recent sessions" })
    const order = () =>
      recent
        .locator(".oc-session-nav__session-title")
        .evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ""))
    const focusedPlaceholder = () =>
      page.evaluate(() =>
        document.activeElement instanceof HTMLInputElement ? document.activeElement.placeholder : "",
      )

    await expect.poll(order).toEqual(["A Session 1", "A Session 2", "A Session 3", "A Session 4"])
    await expect(showSubagents).toBeChecked()

    await expect(
      page.evaluate(async (module) => {
        const { updateSessionMeta } = await import(module)
        const createElement = document.createElement.bind(document)
        Object.defineProperty(document, "createElement", {
          configurable: true,
          value: (tagName: string, options?: ElementCreationOptions) =>
            tagName === "span" ? document.createElementNS("http://www.w3.org/2000/svg", "svg") : createElement(tagName, options),
        })
        const meta = createElement("div")
        try {
          updateSessionMeta(
            { host: { sessions: { status: () => "running" } } },
            meta,
            { id: "nav-svg-spinner", time: { updated: Date.now() } },
            "C:/OpenCode/NavA",
          )
          return meta.firstElementChild instanceof SVGElement && meta.firstElementChild.getAttribute("class") === "oc-session-nav__spinner"
        } finally {
          document.createElement = createElement
        }
      }, "http://127.0.0.1:4096/app/plugin/session-navigator-app/1/app.js"),
    ).resolves.toBe(true)
    sessionStatus["nav-a-4"] = { type: "busy" }
    events.push({
      directory: dirA,
      payload: { type: "session.status", properties: { sessionID: "nav-a-4", status: { type: "busy" } } },
    })
    await expect.poll(order).toEqual(["A Session 4", "A Session 1", "A Session 2", "A Session 3"])

    sessionStatus["nav-a-1"] = { type: "busy" }
    events.push({
      directory: dirA,
      payload: { type: "session.status", properties: { sessionID: "nav-a-1", status: { type: "busy" } } },
    })
    await expect.poll(order).toEqual(["A Session 1", "A Session 4", "A Session 2", "A Session 3"])

    const subagent = { ...session("nav-a-subagent", "A Subagent", dirA, 1_700_000_000_095), parentID: "nav-a-4" }
    sessions.push(subagent)
    sessionStatus["nav-a-subagent"] = { type: "busy" }
    events.push(
      {
        directory: dirA,
        payload: { type: "session.status", properties: { sessionID: "nav-a-subagent", status: { type: "busy" } } },
      },
      {
        directory: dirA,
        payload: { type: "session.created", properties: { info: subagent } },
      },
    )
    await expect.poll(order).toEqual(["A Session 1", "A Session 4", "A Subagent", "A Session 2"])

    await showSubagents.uncheck()
    await expect.poll(() => showSubagentStorage(page)).toBe("false")
    await expect.poll(order).toEqual(["A Session 1", "A Session 4", "A Session 2", "A Session 3"])
    await search.fill("A Subagent")
    await expect(nav.getByText("A Subagent")).toHaveCount(0)
    await showSubagents.check()
    await expect.poll(() => showSubagentStorage(page)).toBe("true")
    await expectAppVisible(nav.getByText("A Subagent"))
    await search.fill("")
    await expect.poll(order).toEqual(["A Session 1", "A Session 4", "A Subagent", "A Session 2"])

    const running = sessions.find((session) => session.id === "nav-a-4")!
    running.time.updated = Date.now() + 10_000
    events.push({
      directory: dirA,
      payload: { type: "session.updated", properties: { info: running } },
    })
    await expect.poll(order).toEqual(["A Session 1", "A Session 4", "A Subagent", "A Session 2"])

    sessionStatus["nav-a-4"] = { type: "idle" }
    events.push({
      directory: dirA,
      payload: { type: "session.status", properties: { sessionID: "nav-a-4", status: { type: "idle" } } },
    })
    await expect.poll(order).toEqual(["A Session 1", "A Subagent", "A Session 4", "A Session 2"])
    await search.fill("A Session")
    await expect.poll(focusedPlaceholder).toBe("Search sessions")
    sessionStatus["nav-a-2"] = { type: "busy" }
    events.push({
      directory: dirA,
      payload: { type: "session.status", properties: { sessionID: "nav-a-2", status: { type: "busy" } } },
    })
    await expect(search).toHaveValue("A Session")
    await expect.poll(focusedPlaceholder).toBe("Search sessions")
    await search.pressSequentially(" 4")
    await expect(search).toHaveValue("A Session 4")
    await expect.poll(focusedPlaceholder).toBe("Search sessions")
    await nav
      .locator(".oc-session-nav__session")
      .filter({ hasText: "A Session 4" })
      .first()
      .locator(".oc-session-nav__session-main")
      .click()
    await expectAppVisible(page.locator('[data-dock-area="middle"] [data-dock-tab][data-session-id="nav-a-4"]'))
    await expect.poll(focusedPlaceholder).toBe("Search sessions")
    if (process.env.VISUAL_QA_SCREENSHOT_DIR) {
      await fs.mkdir(process.env.VISUAL_QA_SCREENSHOT_DIR, { recursive: true })
      await page.screenshot({
        path: `${process.env.VISUAL_QA_SCREENSHOT_DIR}/session-navigator-search-focus-active.png`,
        fullPage: true,
      })
    }
    expect(consoleErrors).toEqual([])
    expect(networkFailures).toEqual([])
  })

  test("keeps v2 activity state race-safe across real tab switches and terminal colors", async ({ page }) => {
    const sessions = seedSessions()
    const events: EventPayload[] = []
    const consoleErrors: string[] = []
    const networkFailures: string[] = []
    let reloading = false
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text())
    })
    page.on("pageerror", (error) => consoleErrors.push(error.message))
    page.on("requestfailed", (request) => {
      if (
        new URL(request.url()).pathname === "/perf/record" &&
        request.failure()?.errorText === "net::ERR_ABORTED"
      )
        return
      if (
        reloading &&
        new URL(request.url()).pathname === "/global/event" &&
        request.failure()?.errorText === "net::ERR_ABORTED"
      )
        return
      networkFailures.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`)
    })
    page.on("response", (response) => {
      if (response.status() >= 400) networkFailures.push(`${response.status()} ${response.url()}`)
    })
    const staleStatus = Promise.withResolvers<Record<string, { type: "busy" }>>()
    const waitGate = Promise.withResolvers<void>()
    let statusRequests = 0
    let statusResponses = 0
    let eventSeq = 0
    let statusCalls = 0
    let holdStaleStatus = true
    let heldStatusRequested = false
    let statusIncludesActivity = false
    const emitActivity = (status: "started" | "completed" | "interrupted") => {
      eventSeq++
      const activity = {
        sessionID,
        activityID: `activity_v2_tab_switch_${Math.ceil(eventSeq / 2)}`,
        timestamp: Date.now(),
        ...(status === "started" ? { kind: "prompt" } : {}),
      }
      events.push(
        {
          directory: dirA,
          payload: {
            id: `activity_${status}_${eventSeq}`,
            type: `session.next.activity.${status}`,
            properties: activity,
          },
        },
        {
          directory: dirA,
          payload: {
            id: `activity_${status}_${eventSeq}_sync`,
            type: "sync",
            syncEvent: {
              id: `activity_${status}_${eventSeq}`,
              type: `session.next.activity.${status}.1`,
              seq: eventSeq,
              aggregateID: sessionID,
              data: activity,
            },
          },
        },
      )
    }

    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/session/status") statusRequests++
    })
    page.on("response", (response) => {
      if (new URL(response.url()).pathname === "/session/status") statusResponses++
    })
    await mockOpenCodeServer(page, {
      directory: dirA,
      project: project("proj-a", dirA, "Project A"),
      provider: provider(),
      sessions,
      sessionStatus: () => {
        statusCalls++
        // Let directory bootstrap finish so the real plugin dock can mount, then
        // hold the session refresh that must not overwrite a later terminal event.
        if (statusCalls === 1) return {}
        if (!holdStaleStatus) return statusIncludesActivity ? { [sessionID]: { type: "busy" as const } } : {}
        holdStaleStatus = false
        heldStatusRequested = true
        return staleStatus.promise
      },
      // Keep a stale running tool in the inactive tab's cached message window. The terminal
      // lifecycle event must clear the spinner without relying on a tab switch/message refresh.
      pageMessages: (id) => ({ items: id === sessionID ? [runningToolMessage(id)] : [] }),
      globalEvents: () => events.splice(0, events.length),
      events: () => [],
      eventRetry: 16,
      onSessionPrompt: (input) => {
        statusIncludesActivity = true
        emitActivity("started")
        return { data: { sessionID: input.sessionID, messageID: "msg_v2_tab_switch", admittedSeq: 1 } }
      },
      onSessionWait: async () => {
        await waitGate.promise
        return {}
      },
    })
    await mockNavigatorPlugin(page)
    await mockNavigatorData(page, { sessions, archived: new Set(), deleted: new Set() })
    await configurePage(page, { seedNavigatorDock: true })

    await page.setViewportSize({ width: 1280, height: 840 })
    await page.goto(`/${base64Encode(dirA)}/session/${sessionID}`)
    await addDockPane(page, "left", "Session Navigator")
    const nav = page.locator(".oc-session-nav")
    const runningRow = nav.locator(".oc-session-nav__session").filter({ hasText: "A Session 1" }).first()
    const runningTab = page.locator(
      `[data-dock-area="middle"] [data-dock-tab][data-session-id="${sessionID}"]`,
    )
    const composer = page.locator('[data-component="session-composer"]')
    const input = composer.locator('[data-component="prompt-input"]')
    await expectAppVisible(input)
    await expect.poll(() => heldStatusRequested).toBe(true)
    await expect(runningTab.getByRole("tab")).toHaveAttribute("aria-selected", "true")
    await input.fill("Keep the V2 activity running")
    await composer.locator('[data-action="prompt-submit"]').last().click()

    await expect.poll(() => eventSeq).toBe(1)
    await expect.poll(() => events.length).toBe(0)
    await expectAppVisible(runningRow.locator(".oc-session-nav__spinner"))
    await expectAppVisible(runningTab.locator('[data-slot="project-avatar-loader"]'))
    await expect(composer.locator('[data-action="prompt-submit"]').last()).toHaveAttribute("aria-label", /Stop|Stopp/)
    await expect.poll(() => events.length).toBe(0)
    statusIncludesActivity = false

    await nav
      .locator(".oc-session-nav__session")
      .filter({ hasText: "A Session 2" })
      .first()
      .locator(".oc-session-nav__session-main")
      .click()
    const otherTab = page.locator('[data-dock-area="middle"] [data-dock-tab][data-session-id="nav-a-2"]')
    await expectAppVisible(otherTab)
    await expect(otherTab.getByRole("tab")).toHaveAttribute("aria-selected", "true")
    await expect(runningTab.getByRole("tab")).toHaveAttribute("aria-selected", "false")
    await expectAppVisible(runningRow.locator(".oc-session-nav__spinner"))
    await expectAppVisible(runningTab.locator('[data-slot="project-avatar-loader"]'))

    await runningTab.getByRole("tab").click()
    await expect(runningTab.getByRole("tab")).toHaveAttribute("aria-selected", "true")
    await expect(otherTab.getByRole("tab")).toHaveAttribute("aria-selected", "false")
    await expect(composer.locator('[data-action="prompt-submit"]').last()).toHaveAttribute("aria-label", /Stop|Stopp/)
    await otherTab.getByRole("tab").click()
    await expect(otherTab.getByRole("tab")).toHaveAttribute("aria-selected", "true")
    await expectAppVisible(runningTab.locator('[data-slot="project-avatar-loader"]'))
    await runningRow.locator(".oc-session-nav__session-main").click()
    await expect(runningTab.getByRole("tab")).toHaveAttribute("aria-selected", "true")
    await expect(otherTab.getByRole("tab")).toHaveAttribute("aria-selected", "false")
    await expect(composer.locator('[data-action="prompt-submit"]').last()).toHaveAttribute("aria-label", /Stop|Stopp/)
    await expect.poll(() => statusRequests).toBeGreaterThanOrEqual(2)

    await otherTab.getByRole("tab").click()
    await expect(otherTab.getByRole("tab")).toHaveAttribute("aria-selected", "true")
    await expect(runningTab.getByRole("tab")).toHaveAttribute("aria-selected", "false")

    emitActivity("completed")
    events.push({
      directory: dirA,
      payload: { type: "session.turn.completed", properties: { sessionID, status: "done" } },
    })
    waitGate.resolve()
    await expect(runningRow.locator(".oc-session-nav__spinner")).toHaveCount(0)
    await expect(runningTab.locator('[data-slot="project-avatar-loader"]')).toHaveCount(0)
    await expectAppVisible(runningRow.locator('[data-slot="session-status-dot"][data-status="done"]'))
    await expectAppVisible(runningTab.locator('[data-slot="project-avatar-unread-dot"][data-status="done"]'))
    await expect
      .poll(() =>
        runningRow
          .locator('[data-slot="session-status-dot"][data-status="done"]')
          .evaluate((node) => getComputedStyle(node).backgroundColor),
      )
      .toBe(await resolvedThemeColor(page, "--v2-state-fg-success"))
    await expect
      .poll(() =>
        runningTab
          .locator('[data-slot="project-avatar-unread-dot"][data-status="done"]')
          .evaluate((node) => getComputedStyle(node).backgroundColor),
      )
      .toBe(await resolvedThemeColor(page, "--v2-state-fg-success"))
    await expect(composer.locator('[data-action="prompt-submit"]').last()).toHaveAttribute("aria-label", /Send|Senden/)
    if (process.env.VISUAL_QA_SCREENSHOT_DIR) {
      await fs.mkdir(process.env.VISUAL_QA_SCREENSHOT_DIR, { recursive: true })
      await page.screenshot({
        path: `${process.env.VISUAL_QA_SCREENSHOT_DIR}/inactive-session-completed.png`,
        fullPage: true,
      })
      await page.setViewportSize({ width: 390, height: 844 })
      await page.screenshot({
        path: `${process.env.VISUAL_QA_SCREENSHOT_DIR}/inactive-session-completed-mobile.png`,
        fullPage: true,
      })
      await page.setViewportSize({ width: 1280, height: 840 })
    }
    const responsesBeforeStale = statusResponses
    staleStatus.resolve({ [sessionID]: { type: "busy" } })
    await expect.poll(() => statusResponses).toBeGreaterThan(responsesBeforeStale)
    await expect(runningRow.locator(".oc-session-nav__spinner")).toHaveCount(0)
    await expect(runningTab.locator('[data-slot="project-avatar-loader"]')).toHaveCount(0)
    await expectAppVisible(runningTab.locator('[data-slot="project-avatar-unread-dot"][data-status="done"]'))
    await expect(composer.locator('[data-action="prompt-submit"]').last()).toHaveAttribute("aria-label", /Send|Senden/)

    statusIncludesActivity = false
    reloading = true
    await page.reload()
    reloading = false
    await expect(runningTab.getByRole("tab")).toHaveAttribute("aria-selected", "true")
    await expect(runningTab.locator('[data-slot="project-avatar-unread-dot"][data-status="done"]')).toHaveCount(0)
    await nav
      .locator(".oc-session-nav__session")
      .filter({ hasText: "A Session 2" })
      .first()
      .locator(".oc-session-nav__session-main")
      .click()
    await expect(otherTab.getByRole("tab")).toHaveAttribute("aria-selected", "true")

    emitActivity("started")
    await expectAppVisible(runningRow.locator(".oc-session-nav__spinner"))
    await expectAppVisible(runningTab.locator('[data-slot="project-avatar-loader"]'))
    emitActivity("interrupted")
    events.push({
      directory: dirA,
      payload: { type: "session.turn.completed", properties: { sessionID, status: "incomplete" } },
    })
    await expectAppVisible(runningRow.locator('[data-slot="session-status-dot"][data-status="incomplete"]'))
    await expectAppVisible(runningTab.locator('[data-slot="project-avatar-unread-dot"][data-status="incomplete"]'))
    await expect
      .poll(() =>
        runningRow
          .locator('[data-slot="session-status-dot"][data-status="incomplete"]')
          .evaluate((node) => getComputedStyle(node).backgroundColor),
      )
      .toBe(await resolvedThemeColor(page, "--v2-state-fg-danger"))
    if (process.env.VISUAL_QA_SCREENSHOT_DIR) {
      await page.screenshot({
        path: `${process.env.VISUAL_QA_SCREENSHOT_DIR}/inactive-session-interrupted.png`,
        fullPage: true,
      })
    }
    await expect
      .poll(() =>
        runningTab
          .locator('[data-slot="project-avatar-unread-dot"][data-status="incomplete"]')
          .evaluate((node) => getComputedStyle(node).backgroundColor),
      )
      .toBe(await resolvedThemeColor(page, "--v2-state-fg-danger"))

    emitActivity("started")
    await expectAppVisible(runningRow.locator(".oc-session-nav__spinner"))
    await expectAppVisible(runningTab.locator('[data-slot="project-avatar-loader"]'))
    emitActivity("completed")
    events.push({
      directory: dirA,
      payload: { type: "session.turn.completed", properties: { sessionID, status: "done" } },
    })
    await expectAppVisible(runningRow.locator('[data-slot="session-status-dot"][data-status="done"]'))
    await expectAppVisible(runningTab.locator('[data-slot="project-avatar-unread-dot"][data-status="done"]'))
    await expect
      .poll(() =>
        runningRow
          .locator('[data-slot="session-status-dot"][data-status="done"]')
          .evaluate((node) => getComputedStyle(node).backgroundColor),
      )
      .toBe(await resolvedThemeColor(page, "--v2-state-fg-success"))
    await expect
      .poll(() =>
        runningTab
          .locator('[data-slot="project-avatar-unread-dot"][data-status="done"]')
          .evaluate((node) => getComputedStyle(node).backgroundColor),
      )
      .toBe(await resolvedThemeColor(page, "--v2-state-fg-success"))

    statusIncludesActivity = true
    emitActivity("started")
    await expectAppVisible(runningTab.locator('[data-slot="project-avatar-loader"]'))
    events.push({
      directory: dirA,
      payload: {
        type: "surface.asked.1",
        properties: {
          id: "que_inactive_tab",
          sessionID,
          questions: [
            {
              header: "Inactive tab question",
              question: "Continue the background session?",
              options: [{ label: "Continue", description: "Resume the session" }],
            },
          ],
        },
      },
    })
    await expect(runningTab.locator('[data-slot="project-avatar-loader"]')).toHaveCount(0)
    await expectAppVisible(runningTab.locator('[data-slot="project-avatar-unread-dot"][data-status="question"]'))
    await expect(otherTab.getByRole("tab")).toHaveAttribute("aria-selected", "true")
    if (process.env.VISUAL_QA_SCREENSHOT_DIR) {
      await page.screenshot({
        path: `${process.env.VISUAL_QA_SCREENSHOT_DIR}/inactive-session-question.png`,
        fullPage: true,
      })
      await page.setViewportSize({ width: 390, height: 844 })
      await page.screenshot({
        path: `${process.env.VISUAL_QA_SCREENSHOT_DIR}/inactive-session-question-mobile.png`,
        fullPage: true,
      })
      await page.setViewportSize({ width: 1280, height: 840 })
    }

    events.push({
      directory: dirA,
      payload: {
        type: "surface.dismissed.1",
        properties: { requestID: "que_inactive_tab", sessionID },
      },
    })
    await expect(runningTab.locator('[data-slot="project-avatar-unread-dot"][data-status="question"]')).toHaveCount(0)
    await expectAppVisible(runningRow.locator(".oc-session-nav__spinner"))
    await expectAppVisible(runningTab.locator('[data-slot="project-avatar-loader"]'))
    statusIncludesActivity = false
    const responsesBeforeRecovery = statusResponses
    await expect.poll(() => statusResponses).toBeGreaterThan(responsesBeforeRecovery)
    await expect(runningRow.locator(".oc-session-nav__spinner")).toHaveCount(0)
    await expect(runningTab.locator('[data-slot="project-avatar-loader"]')).toHaveCount(0)
    await expect(otherTab.getByRole("tab")).toHaveAttribute("aria-selected", "true")
    expect(consoleErrors).toEqual([])
    expect(networkFailures).toEqual([])
  })

  test("polls a running session to completion while another tab stays selected", async ({ page }) => {
    const sessions = seedSessions()
    const consoleErrors: string[] = []
    const networkFailures: string[] = []
    let running = true
    let statusResponses = 0

    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text())
    })
    page.on("pageerror", (error) => consoleErrors.push(error.message))
    page.on("requestfailed", (request) => {
      networkFailures.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`)
    })
    page.on("response", (response) => {
      if (new URL(response.url()).pathname === "/session/status") statusResponses++
      if (response.status() >= 400) networkFailures.push(`${response.status()} ${response.url()}`)
    })
    await mockOpenCodeServer(page, {
      directory: dirA,
      project: project("proj-a", dirA, "Project A"),
      provider: provider(),
      sessions,
      sessionStatus: () => (running ? { [sessionID]: { type: "busy" as const } } : {}),
      pageMessages: () => ({ items: [] }),
    })
    await mockNavigatorPlugin(page)
    await mockNavigatorData(page, { sessions, archived: new Set(), deleted: new Set() })
    await configurePage(page, { seedNavigatorDock: true })

    await page.setViewportSize({ width: 1280, height: 840 })
    await page.goto(`/${base64Encode(dirA)}/session/${sessionID}`)
    await addDockPane(page, "left", "Session Navigator")
    const nav = page.locator(".oc-session-nav")
    const runningRow = nav.locator(".oc-session-nav__session").filter({ hasText: "A Session 1" }).first()
    const runningTab = page.locator(
      `[data-dock-area="middle"] [data-dock-tab][data-session-id="${sessionID}"]`,
    )
    await expectAppVisible(runningRow.locator(".oc-session-nav__spinner"))
    await expectAppVisible(runningTab.locator('[data-slot="project-avatar-loader"]'))

    await nav
      .locator(".oc-session-nav__session")
      .filter({ hasText: "A Session 2" })
      .first()
      .locator(".oc-session-nav__session-main")
      .click()
    const otherTab = page.locator('[data-dock-area="middle"] [data-dock-tab][data-session-id="nav-a-2"]')
    await expect(otherTab.getByRole("tab")).toHaveAttribute("aria-selected", "true")
    const responsesBeforeCompletion = statusResponses
    running = false

    await expect.poll(() => statusResponses).toBeGreaterThan(responsesBeforeCompletion)
    await expect(runningRow.locator(".oc-session-nav__spinner")).toHaveCount(0)
    await expect(runningTab.locator('[data-slot="project-avatar-loader"]')).toHaveCount(0)
    await expect(otherTab.getByRole("tab")).toHaveAttribute("aria-selected", "true")
    if (process.env.VISUAL_QA_SCREENSHOT_DIR) {
      await page.screenshot({
        path: `${process.env.VISUAL_QA_SCREENSHOT_DIR}/inactive-session-polled-complete.png`,
        fullPage: true,
      })
      await page.setViewportSize({ width: 390, height: 844 })
      await page.screenshot({
        path: `${process.env.VISUAL_QA_SCREENSHOT_DIR}/inactive-session-polled-complete-mobile.png`,
        fullPage: true,
      })
    }
    expect(consoleErrors).toEqual([])
    expect(networkFailures).toEqual([])
  })

  test("keeps a fresh run spinning in the navigator and tab when the status poll reports no activity", async ({ page }) => {
    const sessions = seedSessions()
    const events: EventPayload[] = []
    const consoleErrors: string[] = []
    const networkFailures: string[] = []
    let statusResponses = 0
    let eventSeq = 0
    const emitActivity = (status: "started" | "completed") => {
      eventSeq++
      const activity = {
        sessionID,
        activityID: "activity_v2_fresh_run",
        timestamp: Date.now(),
        ...(status === "started" ? { kind: "prompt" } : {}),
      }
      events.push(
        {
          directory: dirA,
          payload: {
            id: `activity_fresh_run_${status}_${eventSeq}`,
            type: `session.next.activity.${status}`,
            properties: activity,
          },
        },
        {
          directory: dirA,
          payload: {
            id: `activity_fresh_run_${status}_${eventSeq}_sync`,
            type: "sync",
            syncEvent: {
              id: `activity_fresh_run_${status}_${eventSeq}`,
              type: `session.next.activity.${status}.1`,
              seq: eventSeq,
              aggregateID: sessionID,
              data: activity,
            },
          },
        },
      )
    }

    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text())
    })
    page.on("pageerror", (error) => consoleErrors.push(error.message))
    page.on("requestfailed", (request) => {
      // Project lookup can be cancelled when the optimistic prompt updates the route state.
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/project/resolve" &&
        request.failure()?.errorText === "net::ERR_ABORTED"
      ) return
      networkFailures.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`)
    })
    page.on("response", (response) => {
      if (new URL(response.url()).pathname === "/session/status") statusResponses++
      if (response.status() >= 400) networkFailures.push(`${response.status()} ${response.url()}`)
    })
    await mockOpenCodeServer(page, {
      directory: dirA,
      project: project("proj-a", dirA, "Project A"),
      provider: provider(),
      sessions,
      // The server never reports the fresh run as busy: every poll answers without the session.
      sessionStatus: () => ({}),
      // The newest assistant message is still the previous turn's finished answer when the run
      // starts, so the idle snapshot alone must not settle the activity that just began.
      pageMessages: (id) => ({ items: id === sessionID ? [settledAssistantMessage(id)] : [] }),
      globalEvents: () => events.splice(0, events.length),
      events: () => [],
      eventRetry: 16,
      onSessionPrompt: (input) => {
        emitActivity("started")
        return { data: { sessionID: input.sessionID, messageID: "msg_v2_fresh_run", admittedSeq: 1 } }
      },
    })
    await mockNavigatorPlugin(page)
    await mockNavigatorData(page, { sessions, archived: new Set(), deleted: new Set() })
    await configurePage(page, { seedNavigatorDock: true })

    await page.setViewportSize({ width: 1280, height: 840 })
    await page.goto(`/${base64Encode(dirA)}/session/${sessionID}`)
    await addDockPane(page, "left", "Session Navigator")
    const nav = page.locator(".oc-session-nav")
    const runningRow = nav.locator(".oc-session-nav__session").filter({ hasText: "A Session 1" }).first()
    const runningTab = page.locator(
      `[data-dock-area="middle"] [data-dock-tab][data-session-id="${sessionID}"]`,
    )
    const composer = page.locator('[data-component="session-composer"]')
    const input = composer.locator('[data-component="prompt-input"]')
    const submit = composer.locator('[data-action="prompt-submit"]').last()
    await expectAppVisible(input)
    await expectAppVisible(runningRow)
    await expect(runningTab.getByRole("tab")).toHaveAttribute("aria-selected", "true")
    // The bootstrap status read must be answered before the run starts, so the first poll
    // counted below belongs to the run and not to the initial page load.
    await expect.poll(() => statusResponses).toBeGreaterThan(0)

    await input.fill("Keep the fresh run spinning")
    await submit.click()

    await expect.poll(() => eventSeq).toBe(1)
    await expect.poll(() => events.length).toBe(0)
    await expectAppVisible(runningRow.locator(".oc-session-nav__spinner"))
    await expectAppVisible(runningTab.locator('[data-slot="project-avatar-loader"]'))

    const responsesBefore = statusResponses
    await expect.poll(() => statusResponses).toBeGreaterThan(responsesBefore + 1)
    await expectAppVisible(runningRow.locator(".oc-session-nav__spinner"))
    await expectAppVisible(runningTab.locator('[data-slot="project-avatar-loader"]'))
    await expect(submit).toHaveAttribute("aria-label", /Stop|Stopp/)

    emitActivity("completed")
    events.push({
      directory: dirA,
      payload: { type: "session.turn.completed", properties: { sessionID, status: "done" } },
    })
    await expect(runningRow.locator(".oc-session-nav__spinner")).toHaveCount(0)
    await expect(runningTab.locator('[data-slot="project-avatar-loader"]')).toHaveCount(0)
    await expect(submit).toHaveAttribute("aria-label", /Send|Senden/)
    expect(consoleErrors).toEqual([])
    expect(networkFailures).toEqual([])
  })

  test("hides favorited subagents saved without parent metadata", async ({ page }) => {
    const sessions = [
      ...seedSessions(),
      { ...session("nav-a-subagent", "A Subagent", dirA, 1_700_000_000_095), parentID: "nav-a-4" },
    ]
    await mockOpenCodeServer(page, {
      directory: dirA,
      project: project("proj-a", dirA, "Project A"),
      provider: provider(),
      sessions,
      pageMessages: () => ({ items: [] }),
    })
    await mockNavigatorPlugin(page)
    await mockNavigatorData(page, { sessions, archived: new Set(), deleted: new Set() })
    await configurePage(page, {
      seedNavigatorDock: true,
      showSubagents: false,
      favoriteSession: {
        id: "nav-a-subagent",
        title: "A Subagent",
        slug: "a-subagent",
        time: { created: 1_700_000_000_085, updated: 1_700_000_000_095 },
      },
    })

    await page.setViewportSize({ width: 1280, height: 840 })
    await page.goto("/")
    await addDockPane(page, "left", "Session Navigator")
    const nav = page.locator(".oc-session-nav")
    await expectAppVisible(nav)
    await expect(nav.getByRole("checkbox", { name: "Show subagents" })).not.toBeChecked()
    await expect(nav.getByText("A Subagent")).toHaveCount(0)

    await nav.getByRole("checkbox", { name: "Show subagents" }).check()
    await expectAppVisible(nav.locator(".oc-session-nav__section").filter({ hasText: "Favorites" }).getByText("A Subagent"))
    await nav.getByRole("checkbox", { name: "Show subagents" }).uncheck()
    await expect(nav.getByText("A Subagent")).toHaveCount(0)
  })

  test("searches titles first and then session content", async ({ page }) => {
    const base = 1_700_000_001_000
    const sessions = [
      session("search-title-full", "Alpha Beta title", dirA, base + 60),
      session("search-content-full", "Content phrase match", dirA, base + 50),
      session("search-title-two", "Alpha middle Beta", dirA, base + 40),
      session("search-title-one", "Alpha only", dirA, base + 30),
      session("search-content-two", "Content split match", dirA, base + 20),
      session("search-content-one", "Content single match", dirA, base + 10),
    ]
    const messages: Record<string, string> = {
      "search-content-full": "The important phrase is alpha beta in the transcript.",
      "search-content-two": "Alpha appears first, and then some unrelated words before beta.",
      "search-content-one": "Only beta appears in this conversation.",
    }

    await mockOpenCodeServer(page, {
      directory: dirA,
      project: project("proj-a", dirA, "Project A"),
      provider: provider(),
      sessions,
      messageDelay: 650,
      pageMessages: (id) => ({ items: messages[id] ? [textMessage(id, messages[id])] : [] }),
    })
    await mockNavigatorPlugin(page)
    await mockNavigatorData(page, { sessions, archived: new Set(), deleted: new Set() })
    await configurePage(page, {
      seedNavigatorDock: true,
      tabs: [{ type: "session", server, dirBase64: base64Encode(dirA), sessionId: "search-title-full" }],
    })

    await page.setViewportSize({ width: 1280, height: 840 })
    await page.goto("/")
    await addDockPane(page, "left", "Session Navigator")
    const nav = page.locator(".oc-session-nav")
    await expectAppVisible(nav)
    await nav.getByPlaceholder("Search sessions").fill("alpha beta")

    const searchSection = nav.locator(".oc-session-nav__section").filter({ hasText: "Search" })
    const titles = () =>
      searchSection
        .locator(".oc-session-nav__session-title")
        .evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ""))

    await expect.poll(titles).toContain("Alpha Beta title")
    await expectAppVisible(nav.locator(".oc-session-nav__search-status"))
    await expect
      .poll(titles, { timeout: 8_000 })
      .toEqual([
        "Alpha Beta title",
        "Content phrase match",
        "Alpha middle Beta",
        "Alpha only",
        "Content split match",
        "Content single match",
      ])
    await expect(nav.locator(".oc-session-nav__search-status")).toHaveCount(0)
  })

  test("loads sessions incrementally with More, Less, and All controls", async ({ page }) => {
    const sessions = manySessions()
    await mockOpenCodeServer(page, {
      directory: dirA,
      project: project("proj-a", dirA, "Project A"),
      provider: provider(),
      sessions,
      pageMessages: () => ({ items: [] }),
    })
    await mockNavigatorPlugin(page)
    await mockNavigatorData(page, { sessions, archived: new Set(), deleted: new Set() })
    await configurePage(page, {
      seedNavigatorDock: true,
      tabs: [{ type: "session", server, dirBase64: base64Encode(dirA), sessionId: "many-a-1" }],
    })

    await page.setViewportSize({ width: 1280, height: 840 })
    await page.goto("/")
    await addDockPane(page, "left", "Session Navigator")
    const nav = page.locator(".oc-session-nav")
    await expectAppVisible(nav)

    const projectA = nav.locator(".oc-session-nav__project").filter({ hasText: "Project A" })
    await projectA.locator(".oc-session-nav__project-toggle").click()
    const controls = projectA.locator(".oc-session-nav__controls")
    const more = controls.getByRole("button", { name: "More" })
    const less = controls.getByRole("button", { name: "Less" })
    const all = controls.getByRole("button", { name: "All" })
    const qaShot = async (name: string) => {
      const dir = process.env.VISUAL_QA_SCREENSHOT_DIR
      if (!dir) return
      await fs.mkdir(dir, { recursive: true })
      await projectA.screenshot({ path: `${dir}/${name}.png` })
    }

    await expectAppVisible(projectA.getByText("Session 1", { exact: true }))
    await expectAppVisible(projectA.getByText("Session 4", { exact: true }))
    await expect(projectA.getByText("Session 5", { exact: true })).toHaveCount(0)
    await expect(projectA.getByText("Session 14", { exact: true })).toHaveCount(0)

    await expectAppVisible(more)
    await expectAppVisible(all)
    await expect(less).toBeDisabled()

    const controlDisplay = await controls.evaluate((node) => getComputedStyle(node).display)
    const controlGap = await controls.evaluate((node) => getComputedStyle(node).gap)
    const rects = await Promise.all([more, less, all].map((button) => button.boundingBox()))
    const sameRow = rects.every((box) => Math.abs(box!.y - rects[0]!.y) < 2)
    const orderedLeftToRight = rects[0]!.x < rects[1]!.x && rects[1]!.x < rects[2]!.x
    expect(controlDisplay).toBe("flex")
    expect(await controls.locator(".oc-session-nav__more").count()).toBe(3)
    expect(sameRow).toBe(true)
    expect(orderedLeftToRight).toBe(true)
    console.log(
      `QA-LAYOUT controls=display:${controlDisplay} gap:${controlGap} ` +
        `more={x:${rects[0]!.x.toFixed(0)},y:${rects[0]!.y.toFixed(0)},w:${rects[0]!.width.toFixed(0)}} ` +
        `less={x:${rects[1]!.x.toFixed(0)},y:${rects[1]!.y.toFixed(0)},w:${rects[1]!.width.toFixed(0)}} ` +
        `all={x:${rects[2]!.x.toFixed(0)},y:${rects[2]!.y.toFixed(0)},w:${rects[2]!.width.toFixed(0)}} sameRow:${sameRow} ordered:${orderedLeftToRight}`,
    )
    await qaShot("01-collapsed")

    await more.click()
    await expectAppVisible(projectA.getByText("Session 9", { exact: true }))
    await expect(projectA.getByText("Session 10", { exact: true })).toHaveCount(0)
    await expect(projectA.getByText("Session 14", { exact: true })).toHaveCount(0)
    await expect(less).toBeEnabled()
    await qaShot("02-more-loads-five")

    await more.click()
    await expectAppVisible(projectA.getByText("Session 14", { exact: true }))
    await expect(more).toBeDisabled()
    await expect(all).toBeDisabled()
    await qaShot("03-more-reaches-all")

    await less.click()
    await expect(projectA.getByText("Session 5", { exact: true })).toHaveCount(0)
    await expectAppVisible(projectA.getByText("Session 4", { exact: true }))
    await expect(less).toBeDisabled()
    await qaShot("04-less-resets")

    await all.click()
    await expectAppVisible(projectA.getByText("Session 14", { exact: true }))
    await expect(all).toBeDisabled()
    await qaShot("05-all-loads-everything")
  })

  test("lists searches and opens a physically archived session without reactivating it", async ({ page }) => {
    const target = longFixture.sessions.find((session) => session.id === longFixture.targetID)!
    let archivedMessagesLoaded = false
    const archivedInput = {
      ...target,
      id: "ses_nav_real_archive",
      projectID: "proj-a",
      directory: dirA,
      title: "Physically Archived Session",
    }
    await using archive = await createRealSessionArchive({
      session: archivedInput,
      messages: longFixture.messages[longFixture.targetID],
    })
    const archivedBefore = await archive.inspect()
    const catalog = await archive.listCatalog()
    const sessions = [session(sessionID, "Active Session", dirA, Date.now()), ...catalog.rows.map(sessionFromArchiveCatalog)]
    expect(archivedBefore).toMatchObject({ location: "archived", activeSessionCount: 0, archivedMessageCount: 340 })
    expect(catalog.rows).toEqual([
      expect.objectContaining({
        sessionID: archivedInput.id,
        title: archivedInput.title,
        directory: dirA,
      }),
    ])

    await mockOpenCodeServer(page, {
      directory: dirA,
      project: project("proj-a", dirA, "Project A"),
      provider: provider(),
      sessions,
      pageMessages: (requestedSessionID, limit, before) =>
        requestedSessionID === archivedInput.id
          ? archive.pageMessages(requestedSessionID, limit, before)
          : Promise.resolve({ items: [] }),
      onMessages: ({ sessionID: requestedSessionID, phase }) => {
        if (requestedSessionID === archivedInput.id && phase === "end") archivedMessagesLoaded = true
      },
    })
    await mockNavigatorPlugin(page)
    await mockNavigatorData(page, { sessions, archived: new Set(), deleted: new Set() })
    await configurePage(page, {
      seedNavigatorDock: true,
      tabs: [{ type: "session", server, dirBase64: base64Encode(dirA), sessionId: sessionID }],
    })

    await page.setViewportSize({ width: 1280, height: 840 })
    await page.goto("/")
    await addDockPane(page, "left", "Session Navigator")
    const nav = page.locator(".oc-session-nav")
    await expectAppVisible(nav.getByText(archivedInput.title))
    const search = nav.getByPlaceholder("Search sessions")
    await search.fill("Physically Archived")
    await expectAppVisible(nav.getByText(archivedInput.title))
    await nav.locator(".oc-session-nav__session").filter({ hasText: archivedInput.title }).click()
    await expectAppVisible(
      page.locator(`[data-dock-area="middle"] [data-dock-tab][data-session-id="${archivedInput.id}"]`),
    )
    await expect.poll(() => archivedMessagesLoaded, { timeout: 30_000 }).toBe(true)
    await expect
      .poll(() => archive.inspect(), { timeout: 30_000 })
      .toEqual(archivedBefore)
    await page.close()
    await archive.waitForIdle()
  })

  test("keeps scroll position across navigator refreshes", async ({ page }) => {
    const sessions = manySessions()
    const events: EventPayload[] = []
    const sessionStatus: Record<string, { type: "busy" | "idle" }> = {}
    await mockOpenCodeServer(page, {
      directory: dirA,
      project: project("proj-a", dirA, "Project A"),
      provider: provider(),
      sessions,
      sessionStatus,
      pageMessages: () => ({ items: [] }),
      events: () => events.splice(0, events.length),
      eventRetry: 16,
    })
    await mockNavigatorPlugin(page)
    await mockNavigatorData(page, { sessions, archived: new Set(), deleted: new Set() })
    await configurePage(page, {
      seedNavigatorDock: true,
      tabs: [{ type: "session", server, dirBase64: base64Encode(dirA), sessionId: "many-a-1" }],
    })

    await page.setViewportSize({ width: 1280, height: 840 })
    await page.goto("/")
    await addDockPane(page, "left", "Session Navigator")
    await page.setViewportSize({ width: 1280, height: 360 })
    const nav = page.locator(".oc-session-nav")
    await expectAppVisible(nav)

    const projectA = nav.locator(".oc-session-nav__project").filter({ hasText: "Project A" })
    await projectA.locator(".oc-session-nav__project-toggle").click()
    await projectA.getByRole("button", { name: "All" }).click()
    await expectAppVisible(projectA.getByText("Session 14", { exact: true }))

    const body = nav.locator(".oc-session-nav__body")
    await body.evaluate((node) => {
      node.scrollTop = 180
    })
    const before = await body.evaluate((node) => node.scrollTop)
    expect(before).toBeGreaterThan(0)

    await page.evaluate(() => window.dispatchEvent(new Event("opencode:sidebar-session-limit")))
    await expect.poll(() => body.evaluate((node) => node.scrollTop)).toBe(before)

    const firstSession = projectA.locator('[data-session-id="many-a-1"]').first()
    await firstSession.evaluate((node) => node.setAttribute("data-status-node", "stable"))
    sessionStatus["many-a-1"] = { type: "busy" }
    events.push({
      directory: dirA,
      payload: { type: "session.status", properties: { sessionID: "many-a-1", status: { type: "busy" } } },
    })
    await expect(firstSession.locator(".oc-session-nav__session-meta--loading")).toHaveCount(1)
    await expect(firstSession).toHaveAttribute("data-status-node", "stable")
    await expect.poll(() => body.evaluate((node) => node.scrollTop)).toBe(before)

    sessionStatus["many-a-14"] = { type: "busy" }
    events.push({
      directory: dirA,
      payload: { type: "session.status", properties: { sessionID: "many-a-14", status: { type: "busy" } } },
    })
    await expect.poll(() => body.evaluate((node) => node.scrollTop)).toBe(before)
  })
})

async function addDockPane(page: Page, area: "top" | "left" | "middle" | "right" | "bottom", query: string) {
  if (query === "Session Navigator") {
    const navigator = page.locator(
      `[data-dock-area="${area}"] [data-dock-tab="session-navigator-app/sessionNavigator"]`,
    )
    if (
      await navigator.waitFor({ state: "visible", timeout: 1_000 }).then(
        () => true,
        () => false,
      )
    ) {
      return
    }
  }
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
  await page.getByLabel("Search dock items").fill(query)
  await expectAppVisible(
    page.locator('[data-component="dock-add-menu"] [data-dock-add-item="session-navigator-app/sessionNavigator"]'),
  )
  await page.keyboard.press("Enter")
}

async function mockNavigatorPlugin(page: Page) {
  const source = await fs.readFile(path.resolve("../../.opencode/plugin-sources/session-navigator-app/index.js"), "utf8")
  const body = await fs.readFile(path.resolve("../../.opencode/plugins/session-navigator-app/index.js"), "utf8")
  expect(body).toBe(source)
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

function showSubagentStorage(page: Page) {
  return page.evaluate(() => localStorage.getItem("opencode.app-plugin.session-navigator-app.show-subagents.v1"))
}

async function mockNavigatorData(
  page: Page,
  state: {
    sessions: NavigatorMockSession[]
    archived: Set<string>
    deleted: Set<string>
    mutations?: Array<{ method: string; sessionID: string; directory?: string }>
  },
) {
  await page.route("**/experimental/session**", (route) => {
    const url = new URL(route.request().url())
    const directory = url.searchParams.get("directory") ?? undefined
    const search = url.searchParams.get("search")?.toLowerCase()
    const roots = url.searchParams.get("roots") === "true"
    const cursor = Number(url.searchParams.get("cursor") ?? 0)
    const limit = Number(url.searchParams.get("limit") ?? 50)
    const list = state.sessions
      .filter((session) => !state.archived.has(session.id) && !state.deleted.has(session.id))
      .filter((session) => !directory || session.directory === directory)
      .filter((session) => !roots || !session.parentID)
      .filter((session) => !search || `${session.title} ${session.directory}`.toLowerCase().includes(search))
      .filter((session) => !cursor || Number(session.time.updated) < cursor)
      .sort((a, b) => Number(b.time.updated) - Number(a.time.updated))
      .slice(0, limit)
    return json(route, list)
  })
  await page.route(`${server}/session/*`, (route) => {
    const url = new URL(route.request().url())
    const sessionID = decodeURIComponent(url.pathname.split("/").filter(Boolean)[1] ?? "")
    if (sessionID === "status") return route.fallback()
    if (route.request().method() === "GET") {
      const directory = url.searchParams.get("directory") ?? undefined
      const session = state.sessions.find(
        (session) => session.id === sessionID && (!directory || session.directory === directory),
      )
      if (session) return json(route, session)
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({}) })
    }
    if (route.request().method() === "PATCH") {
      state.mutations?.push({ method: "PATCH", sessionID, directory: url.searchParams.get("directory") ?? undefined })
      const body = route.request().postDataJSON() as { title?: string; time?: { archived?: number } }
      const session = state.sessions.find((session) => session.id === sessionID)
      if (body.title && session) session.title = body.title
      if (body.time?.archived) state.archived.add(sessionID)
      return json(route, session ?? {})
    }
    if (route.request().method() === "DELETE") {
      state.mutations?.push({ method: "DELETE", sessionID, directory: url.searchParams.get("directory") ?? undefined })
      state.deleted.add(sessionID)
      return json(route, {})
    }
    return route.fallback()
  })
}

async function configurePage(
  page: Page,
  settings?: {
    favoriteSessionID?: string
    favoriteSession?: { id: string; title: string; slug: string; time: { created: number; updated: number } }
    preserveServerOnReload?: boolean
    seedCrowdedMobileDock?: boolean
    seedNavigatorDock?: boolean
    showSubagents?: boolean
    sidebarSessionLimit?: number
    tabs?: unknown[]
  },
) {
  const seedID = `${Date.now()}-${Math.random()}`
  await page.addInitScript(
    ({ dirA, dirB, dirABase64, seedID, sessionID, server, settings }) => {
      localStorage.removeItem("opencode.app-plugin.session-navigator-app.auto-opened.v1")
      localStorage.removeItem("opencode.app-plugin.session-navigator-app.show-subagents.v1")
      if (settings?.showSubagents !== undefined) {
        localStorage.setItem("opencode.app-plugin.session-navigator-app.show-subagents.v1", String(settings.showSubagents))
      }
      const seedStorage =
        !settings?.preserveServerOnReload || sessionStorage.getItem("opencode.session-navigator.seed") !== seedID
      sessionStorage.setItem("opencode.session-navigator.seed", seedID)
      if (settings?.sidebarSessionLimit !== undefined) {
        localStorage.setItem(
          "settings.v3",
          JSON.stringify({ general: { sidebarSessionLimit: settings.sidebarSessionLimit } }),
        )
      }
      if (settings?.favoriteSessionID || settings?.favoriteSession) {
        const favorite = settings.favoriteSession ?? {
          id: settings.favoriteSessionID ?? "",
          title: "A Session 1",
          slug: "a-session-1",
          time: { created: 1_700_000_000_090, updated: 1_700_000_000_100 },
        }
        localStorage.setItem(
          "opencode.global.dat:session-favorites",
          JSON.stringify({
            items: {
              [`${server}\n${dirA}\n${favorite.id}`]: {
                server,
                directory: dirA,
                id: favorite.id,
                title: favorite.title,
                slug: favorite.slug,
                time: favorite.time,
              },
            },
          }),
        )
      }
      if (seedStorage) {
        localStorage.setItem(
          "opencode.global.dat:server",
          JSON.stringify({
            projects: {
              local: [
                { worktree: dirA, expanded: true, name: "Project A", icon: { color: "purple" } },
                { worktree: dirB, expanded: true, name: "Project B", icon: { color: "lime" } },
              ],
            },
            lastProject: { local: dirA },
          }),
        )
      }
      if (seedStorage && (settings?.seedNavigatorDock || settings?.seedCrowdedMobileDock)) {
        const crowdedTabs = [
          "session-navigator-app/sessionNavigator",
          "fileTree",
          "gitChanges",
          "terminal",
          "pluginManager",
          "usage",
          "browser",
          "review",
        ]
        const layout = JSON.stringify({
          dock: {
            left: {
              visible: true,
              size: 300,
              tabs: settings.seedCrowdedMobileDock
                ? crowdedTabs
                : ["session-navigator-app/sessionNavigator", "fileTree"],
              active: "session-navigator-app/sessionNavigator",
            },
            mobile: settings.seedCrowdedMobileDock ? { size: 320, activeItem: "review" } : undefined,
            items: Object.fromEntries(
              (settings.seedCrowdedMobileDock ? crowdedTabs : ["session-navigator-app/sessionNavigator", "fileTree"]).map(
                (id) => [id, { area: "left", visible: true }],
              ),
            ),
          },
        })
        for (const key of ["opencode.global.dat:layout", `opencode.global.dat:${server}\u0000layout`]) {
          localStorage.setItem(key, layout)
        }
      }
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify(settings?.tabs ?? [{ type: "session", server, dirBase64: dirABase64, sessionId: sessionID }]),
      )
    },
    { dirA, dirB, dirABase64: base64Encode(dirA), seedID, sessionID, server, settings },
  )
}

function seedSessions() {
  const base = 1_700_000_000_000
  return [
    session("nav-a-1", "A Session 1", dirA, base + 100),
    session("nav-a-2", "A Session 2", dirA, base + 90),
    session("nav-a-3", "A Session 3", dirA, base + 80),
    session("nav-a-4", "A Session 4", dirA, base + 70),
    session("nav-a-project-1", "A Project Session 1", dirA, base + 60),
    session("nav-a-project-2", "A Project Session 2", dirA, base + 50),
    session("nav-a-project-3", "A Project Session 3", dirA, base + 40),
    session("nav-a-project-4", "A Project Session 4", dirA, base + 30),
    session("nav-b-1", "B Session 1", dirB, base + 20),
  ]
}

function manySessions() {
  const base = 1_700_000_000_000
  const dirASessions = Array.from({ length: 14 }, (_, index) => {
    const n = index + 1
    return session(`many-a-${n}`, `Session ${n}`, dirA, base + (15 - n) * 10)
  })
  return [...dirASessions, session("many-b-1", "B Session 1", dirB, base)]
}

function session(id: string, title: string, directory: string, updated: number) {
  return {
    id,
    slug: title.toLowerCase().replaceAll(" ", "-"),
    projectID: directory === dirA ? "proj-a" : "proj-b",
    directory,
    title,
    version: "dev",
    time: { created: updated - 10, updated },
  }
}

function sessionFromArchiveCatalog(entry: ArchiveCatalogEntry) {
  const data = entry.sessionData ?? {}
  return {
    id: entry.sessionID,
    slug: typeof data.slug === "string" ? data.slug : entry.title.toLowerCase().replaceAll(" ", "-"),
    projectID: entry.projectID,
    directory: entry.directory,
    title: entry.title,
    version: typeof data.version === "string" ? data.version : "dev",
    time: {
      created: typeof data.time_created === "number" ? data.time_created : entry.timeCreated,
      updated: typeof data.time_updated === "number" ? data.time_updated : entry.timeLastModified,
    },
  }
}

function textMessage(sessionID: string, text: string) {
  const messageID = `${sessionID}-message`
  return {
    info: { id: messageID, sessionID, role: "user", time: { created: 1_700_000_000_000 } },
    parts: [{ id: `${messageID}-part`, sessionID, messageID, type: "text", text }],
  }
}

function runningToolMessage(sessionID: string) {
  const messageID = `${sessionID}-assistant`
  return {
    info: {
      id: messageID,
      sessionID,
      role: "assistant",
      parentID: `${sessionID}-user`,
      time: { created: 1_700_000_000_000 },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "claude-opus-4-6",
      providerID: "opencode",
      mode: "build",
      agent: "build",
      path: { cwd: dirA, root: dirA },
    },
    parts: [
      {
        id: `${messageID}-tool`,
        sessionID,
        messageID,
        type: "tool",
        callID: "stale-tool",
        tool: "read",
        state: {
          status: "running",
          input: { path: "README.md" },
          title: "read",
          metadata: {},
          time: { start: 1_700_000_000_000 },
        },
      },
    ],
  }
}

// A finished assistant turn: `finish` plus `time.completed` mark it as settled. This is what the
// client store still holds right after a new run starts (the previous turn's answer).
function settledAssistantMessage(sessionID: string) {
  const messageID = `${sessionID}-assistant`
  return {
    info: {
      id: messageID,
      sessionID,
      role: "assistant",
      parentID: `${sessionID}-user`,
      time: { created: 1_700_000_000_000, completed: 1_700_000_005_000 },
      finish: "stop",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "claude-opus-4-6",
      providerID: "opencode",
      mode: "build",
      agent: "build",
      path: { cwd: dirA, root: dirA },
    },
    parts: [{ id: `${messageID}-text`, sessionID, messageID, type: "text", text: "Previous turn finished." }],
  }
}

function project(id: string, worktree: string, name: string) {
  return {
    id,
    worktree,
    vcs: "git",
    name,
    icon: { color: id === "proj-a" ? "purple" : "lime" },
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
        models: { "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude", limit: { context: 200_000 } } },
      },
    ],
    connected: ["opencode"],
    default: { providerID: "opencode", modelID: "claude-opus-4-6" },
  }
}

async function resolvedThemeColor(page: Page, variable: string) {
  return page.evaluate((name) => {
    const probe = document.createElement("span")
    probe.style.background = `var(${name})`
    document.body.append(probe)
    const color = getComputedStyle(probe).backgroundColor
    probe.remove()
    return color
  }, variable)
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
