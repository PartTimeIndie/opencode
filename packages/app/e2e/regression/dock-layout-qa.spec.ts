import { expect, test, type Locator, type Page } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"
import { trackPageErrors, expectNoSmokeErrors } from "../utils/errors"

const directory = "C:/OpenCode/DockLayoutQA"
const projectID = "proj_dock_layout_qa"
const sessionID = "ses_dock_layout_qa"
const secondSessionID = "ses_dock_layout_qa_second"
const title = "Dock layout QA"
const secondTitle =
  "Dock layout QA follow-up with a deliberately long semantic session title that remains fully accessible"
const server = "http://127.0.0.1:4096"

test.describe("visual qa: dock layout", () => {
  test("compact composer remeasures crowded actions when a narrow pane widens", async ({ page }) => {
    await mockOpenCodeServer(page, {
      directory, project: project(), provider: provider(),
      sessions: [session()], pageMessages: () => ({ items: messages() }),
    })
    await mockAppPlugin(page)
    await configurePage(page)
    await page.setViewportSize({ width: 1024, height: 600 })
    await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
    const more = page.getByRole("button", { name: "More tools", exact: true })
    await expectAppVisible(more)
    await page.setViewportSize({ width: 1440, height: 720 })
    await expectAppVisible(more)
    await expect(page.locator('[data-plugin-toolbar-placement="composer"][data-plugin-toolbar-align="left"]')).toHaveCount(0)
    await more.click()
    await expectAppVisible(page.getByRole("button", { name: "QA Composer Mount" }))
  })

  test("crowded composer moves plugin actions into the overflow menu without hiding core controls", async ({ page }) => {
    await mockOpenCodeServer(page, {
      directory, project: project(), provider: provider(),
      sessions: [session()], pageMessages: () => ({ items: messages() }),
      sessionStatus: { [sessionID]: { type: "busy" } },
      eventRetry: 200,
      events: () => [
        { directory, payload: { id: "qa_busy", type: "session.status", properties: { sessionID, status: { type: "busy" } } } },
        {
          directory,
          payload: {
            id: "qa_todos", type: "todo.updated",
            properties: {
              sessionID,
              todos: Array.from({ length: 12 }, (_, index) => ({
                content: `Check toolbar and todo item ${index + 1}`, status: "pending", priority: "medium",
              })),
            },
          },
        },
      ],
    })
    await mockAppPlugin(page)
    await configurePage(page)
    await page.setViewportSize({ width: 1440, height: 720 })
    await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
    await expectAppVisible(page.locator('[data-component="session-composer"]'))
    const todos = page.locator('[data-component="session-todo-dock"]')
    await expectAppVisible(todos)
    await expectAppVisible(todos.locator('[data-action="session-todo-toggle"]'))

    const more = page.getByRole("button", { name: "More tools", exact: true })
    await expectAppVisible(more)
    await expectAppVisible(page.locator('[data-action="prompt-model"]'))
    await expectAppVisible(page.locator('[data-action="prompt-submit"]'))
    const running = page.locator('[data-component="session-running-status"]')
    await expect(running.locator('[data-slot="running-model"]')).toContainText("openrouter/stealth/ox-alpha")
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const toggle = document.querySelector<HTMLElement>('[data-action="session-todo-toggle"]')
          const composer = document.querySelector<HTMLElement>('[data-component="session-composer"]')
          if (!toggle || !composer) return false
          const rect = toggle.getBoundingClientRect()
          const top = composer.getBoundingClientRect().top
          const hit = document.elementFromPoint(rect.left + 20, rect.top + rect.height / 2)
          return rect.bottom <= top && hit?.closest('[data-action="session-todo-toggle"]') === toggle
        }),
      )
      .toBe(true)
    await todos.locator('[data-slot="session-todo-list"] > div > div').first().evaluate((list) => {
      list.scrollTop = list.scrollHeight
    })
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const last = [...document.querySelectorAll<HTMLElement>('[data-slot="session-todo-list"] [data-state="pending"]')].at(-1)
          const composer = document.querySelector<HTMLElement>('[data-component="session-composer"]')
          if (!last || !composer) return false
          return last.getBoundingClientRect().bottom <= composer.getBoundingClientRect().top
        }),
      )
      .toBe(true)
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const controls = document.querySelector<HTMLElement>('[data-slot="composer-toolbar-left"]')
          const send = document.querySelector<HTMLElement>('[data-action="prompt-submit"]')
          const more = document.querySelector<HTMLElement>('[data-action="plugin-toolbar-more"]')
          if (!controls || !send || !more) return false
          const a = controls.getBoundingClientRect()
          const b = send.getBoundingClientRect()
          const c = more.getBoundingClientRect()
          return a.bottom <= b.bottom + 1 && c.right <= b.left + 1 && b.bottom <= innerHeight
        }),
      )
      .toBe(true)
    await page.screenshot({ path: test.info().outputPath("crowded-composer-desktop.png") })
    await more.click()
    await expectAppVisible(page.getByRole("button", { name: "QA Composer Left 1", exact: true }))
    await expectAppVisible(page.getByRole("button", { name: "QA Composer Right 1", exact: true }))
    await expect(page.getByRole("button", { name: "QA Disabled Composer", exact: true })).toBeDisabled()
    await page.keyboard.press("Escape")
    await expect(more).toHaveAttribute("aria-expanded", "false")
    await page.setViewportSize({ width: 390, height: 844 })
    await expectAppVisible(more)
    await expectAppVisible(todos)
    await expect(running.locator('[data-slot="running-model"]')).toBeVisible()
    await expect.poll(async () => page.evaluate(() => {
      const todo = document.querySelector('[data-component="session-todo-dock"]')
      const status = document.querySelector('[data-component="session-running-status"]')
      return !!todo && !!status && todo.getBoundingClientRect().bottom <= status.getBoundingClientRect().top
    })).toBe(true)
    await page.screenshot({ path: test.info().outputPath("crowded-composer-mobile.png") })
  })

  test("global titlebar controls survive an unsent draft and plugin focus", async ({ page }) => {
    const errors = trackPageErrors(page)
    const failedRequests: string[] = []
    page.on("response", (response) => {
      if (response.status() >= 400) failedRequests.push(`${response.status()} ${response.url()}`)
    })
    await mockOpenCodeServer(page, {
      directory, project: project(), provider: provider(),
      sessions: [session(), secondSession()], pageMessages: () => ({ items: messages() }),
    })
    await mockAppPlugin(page)
    await configurePage(page)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
    await expectAppVisible(dockSessionTab(page, "middle", title))
    await addDockPane(page, "middle", "New session", "newSession")
    await expectAppVisible(page.locator('[data-dock-area="middle"]').getByRole("tab", { name: "New session" }))
    const actions = page.locator('[data-component="global-titlebar-actions"]')
    await expect(actions).toHaveCount(1)
    await expect(actions.getByRole("button")).toHaveCount(5)
    await actions.getByRole("button").first().click()
    await expect(page.getByRole("dialog")).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await page.screenshot({ path: test.info().outputPath("draft-desktop.png") })
    for (const area of ["top", "left", "right", "bottom"]) {
      const button = page.getByRole("button", { name: `Toggle ${area} dock`, exact: true })
      await expect(button).toHaveCount(1)
      await expect(button).toBeVisible()
      const previous = await button.getAttribute("aria-expanded")
      await button.click()
      await expect(button).toHaveAttribute("aria-expanded", previous === "true" ? "false" : "true")
      await button.click()
    }
    await page.getByRole("tab", { name: "QA Dock", exact: true }).click()
    await expect(page.getByRole("button", { name: "Toggle left dock", exact: true })).toHaveCount(1)
    for (let i = 0; i < 2; i++) {
      await dockSessionTab(page, "middle", title).click()
      await expect(actions.getByRole("button")).toHaveCount(5)
      await page.locator('[data-dock-area="middle"]').getByRole("tab", { name: "New session" }).click()
      await expect(actions.getByRole("button")).toHaveCount(5)
    }
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.locator('[data-action="mobile-dock-launcher"]')).toHaveCount(1)
    await expect(page.locator('[data-action="mobile-dock-launcher"]')).toBeVisible()
    await expect(page.getByRole("button", { name: "Toggle left dock", exact: true })).toHaveCount(0)
    await page.screenshot({ path: test.info().outputPath("draft-mobile.png") })
    await expect(actions.getByRole("button")).toHaveCount(2)
    await page.locator('[data-action="mobile-dock-launcher"]').click()
    await expect(page.locator('[data-action="mobile-dock-launcher"]')).toHaveAttribute("aria-expanded", "true")
    await page.locator('[data-action="mobile-dock-launcher"]').click()
    expect(failedRequests).toEqual([])
    expectNoSmokeErrors(errors, [], [])
  })

  test("renders app plugin docks, slots, routes, custom parts, and mobile stack", async ({ page }) => {
    const errors = trackPageErrors(page)
    await mockOpenCodeServer(page, {
      directory,
      project: project(),
      provider: provider(),
      sessions: [session(), secondSession()],
      pageMessages: () => ({ items: messages() }),
      onSessionCreate: () => newSession(),
    })
    await mockAppPlugin(page)
    await configurePage(page)

    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/?pluginRoute=qaDock%2Fqa-route`)
    await expect(page.locator('[data-component="bottom-session-tabs"]')).toHaveCount(0)
    await expect(page.locator('[data-slot="titlebar-tabs"]')).toHaveCount(0)
    await hideDebugBar(page)
    await expectAppVisible(page.locator('[data-component="session-dock-shell"][data-layout="desktop-grid"]'))
    await expectAppVisible(dockSessionTab(page, "middle", title))
    await expectAppVisible(page.locator('[data-testid="qa-top-panel"]'))
    await expectAppVisible(page.locator('[data-testid="qa-dock-panel"]'))
    await expectAppVisible(page.locator('[data-testid="qa-route-view"]'))
    await expect(page).not.toHaveURL(/pluginRoute=/)
    await dockSessionTab(page, "middle", title).click()
    await expectAppVisible(page.locator('[data-plugin-slot-item="qaDock/toolbar"]'))
    await expectResizable(page, "top", "height", 0, 36)
    await expectResizable(page, "left", "width", 40, 0)

    const longSessionTab = dockSessionTab(page, "middle", secondTitle)
    await expect(longSessionTab).toHaveAccessibleName(secondTitle)
    await expect(longSessionTab).toHaveAttribute("title", secondTitle)
    const truncation = await longSessionTab.locator("span.truncate").evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      textOverflow: getComputedStyle(element).textOverflow,
    }))
    expect(truncation.scrollWidth).toBeGreaterThan(truncation.clientWidth)
    expect(truncation.textOverflow).toBe("ellipsis")

    await dockSessionTab(page, "middle", title).click()
    await expectComposerToolbarLayout(page, "compact")
    await expectAppVisible(page.locator('[data-kind="qaDock/inline"]'))
    await expect(page.locator('[data-testid="qa-custom-part"]')).toContainText("QA Custom Part Rendered")
    await dragDockTab(page, "middle", secondTitle, "left")
    await expectAppVisible(dockSessionTab(page, "left", secondTitle))
    await expect(dockSessionTab(page, "middle", secondTitle)).toHaveCount(0)
    await dragDockTab(page, "left", secondTitle, "middle")
    await expectAppVisible(dockSessionTab(page, "middle", secondTitle))
    await expect(dockSessionTab(page, "left", secondTitle)).toHaveCount(0)
    await dockSessionTab(page, "middle", title).click()
    if ((await page.getByRole("tab", { name: "QA Right" }).count()) === 0) await addDockPane(page, "right", "QA Right")
    await page.getByRole("tab", { name: "QA Right" }).click()
    await expectAppVisible(page.locator('[data-testid="qa-right-panel"]'))
    await expectResizable(page, "right", "width", -40, 0)
    await page.getByRole("tab", { name: "QA Route" }).click()
    await expectAppVisible(page.locator('[data-testid="qa-route-view"]'))
    await page.getByRole("button", { name: "Toggle bottom dock" }).click()
    await expectAppVisible(page.locator('[data-dock-area="bottom"]'))
    await openDockAddMenu(page, "bottom")
    await expectDockAddMenuInViewport(page)
    await page.getByLabel("Search dock items").fill("QA Bottom")
    await expectAppVisible(page.locator('[data-component="dock-add-menu"] [data-dock-add-item="qaDock/bottom"]'))
    await page.keyboard.press("Escape")
    await page.locator('[data-dock-area="bottom"]').getByRole("tab", { name: "QA Bottom" }).click()
    await expectAppVisible(page.locator('[data-testid="qa-bottom-panel"]'))
    await expectResizable(page, "bottom", "height", 0, -40)
    await page.locator('[data-dock-area="left"]').getByRole("button", { name: "Close QA Dock" }).click()
    await expect(page.locator('[data-dock-area="left"]').getByRole("tab", { name: "QA Dock" })).toHaveCount(0)
    await addDockPane(page, "left", "QA Dock")
    await expectAppVisible(page.locator('[data-dock-area="left"]').getByRole("tab", { name: "QA Dock" }))
    await expectToolbarToggle(page, "bottom", "Toggle bottom dock")
    await dragDockTab(page, "left", "QA Dock", "right")
    await expectAppVisible(page.locator('[data-dock-area="right"]').getByRole("tab", { name: "QA Dock" }))
    await expect(page.locator('[data-dock-area="left"]').getByRole("tab", { name: "QA Dock" })).toHaveCount(0)
    await dragDockTab(page, "right", "QA Dock", "left")
    await expectAppVisible(page.locator('[data-dock-area="left"]').getByRole("tab", { name: "QA Dock" }))
    await expect(page.locator('[data-dock-area="right"]').getByRole("tab", { name: "QA Dock" })).toHaveCount(0)
    await addDockPane(page, "right", "QA Dock")
    await expectAppVisible(page.locator('[data-dock-area="right"]').getByRole("tab", { name: "QA Dock" }))
    await expect(page.locator('[data-dock-area="left"]').getByRole("tab", { name: "QA Dock" })).toHaveCount(0)
    await addDockPane(page, "left", "QA Dock")
    await expectAppVisible(page.locator('[data-dock-area="left"]').getByRole("tab", { name: "QA Dock" }))
    await expect(page.locator('[data-dock-area="right"]').getByRole("tab", { name: "QA Dock" })).toHaveCount(0)
    await dockSessionTab(page, "middle", secondTitle).click()
    await expectAppVisible(dockSessionTab(page, "middle", secondTitle))
    await expectAppVisible(page.locator('[data-dock-area="left"]').getByRole("tab", { name: "QA Dock" }))
    await dockSessionTab(page, "middle", title).click()
    await expectAppVisible(dockSessionTab(page, "middle", title))
    await expectAppVisible(page.locator('[data-dock-area="left"]').getByRole("tab", { name: "QA Dock" }))
    await addDockPane(page, "left", "QA Route")
    await expectAppVisible(page.locator('[data-dock-area="left"] [data-testid="qa-route-view"]'))
    await expect(page.locator('[data-dock-area="middle"]').getByRole("tab", { name: "QA Route" })).toHaveCount(0)
    await expect.poll(() => dockTabIDs(page, "left")).toEqual(["qaDock/panel", "qaDock/route"])
    await dragDockTab(page, "left", "QA Route", "left", "QA Dock")
    await expect.poll(() => dockTabIDs(page, "left")).toEqual(["qaDock/route", "qaDock/panel"])
    await addDockPane(page, "left", "New session", "newSession")
    await expect(page).toHaveURL(new RegExp(`/($|\\?)`))
    await expectAppVisible(page.locator('[data-dock-area="left"]').getByRole("tab", { name: "New session" }))
    await expectAppVisible(page.locator('[data-dock-area="left"]').getByRole("textbox", { name: /Ask anything/ }))
    await expect(page.locator('[data-dock-area="middle"]').getByRole("tab", { name: "New session" })).toHaveCount(0)
    await expect(dockSessionTab(page, "middle", title)).toBeVisible({ timeout: 5_000 })
    await dockSessionTab(page, "middle", title).click()
    await expect(page.getByRole("heading", { name: "Something went wrong" })).toHaveCount(0)
    await expectAppVisible(dockSessionTab(page, "middle", title))
    await hideDebugBar(page)
    await addDockPane(page, "middle", title)
    await expectAppVisible(dockSessionTab(page, "middle", title))
    await expectToolbarToggle(page, "top", "Toggle top dock")
    await expectToolbarToggle(page, "left", "Toggle left dock")
    await expectToolbarToggle(page, "right", "Toggle right dock")
    await expectNoOverlaps(page, "desktop")
    await page.screenshot({ path: "e2e/test-results/dock-layout-qa-desktop.png", fullPage: true })

    await page.setViewportSize({ width: 390, height: 844 })
    await hideDebugBar(page)
    await expect(page.locator('[data-component="bottom-session-tabs"]')).toHaveCount(0)
    await expectAppVisible(page.locator('[data-component="session-dock-shell"][data-layout="mobile-stack"]'))
    await expectComposerToolbarLayout(page, "mobile")
    await expectMobilePrimaryTouchTargets(page)
    await expectMobileToolbarBelowDialog(page)
    await expectNoOverlaps(page, "mobile")
    await expect(page.locator(".mobile-help-hidden").getByRole("button", { name: "Help" })).toBeHidden()

    const launcher = page.locator('[data-action="mobile-dock-launcher"]')
    await expectAppVisible(launcher)
    const launcherBox = await launcher.boundingBox()
    expect(launcherBox?.width).toBeGreaterThanOrEqual(44)
    expect(launcherBox?.height).toBeGreaterThanOrEqual(44)
    await expect(page.locator('[data-dock-area="mobile"]')).toHaveCount(0)

    await launcher.click()
    const mobileDock = page.locator('[data-dock-area="mobile"]')
    await expectAppVisible(mobileDock)
    await expectMobileDockAddBelowDialog(page, mobileDock)
    for (const pane of ["QA Top", "QA Dock", "QA Route", "QA Right", "QA Bottom"]) {
      await expectAppVisible(mobileDock.getByRole("tab", { name: pane }))
    }
    await mobileDock.getByRole("tab", { name: "QA Dock" }).click()
    await expectMobileDockMenuBelowDialog(page, mobileDock)
    await expectAppVisible(page.locator('[data-testid="qa-dock-panel"]'))
    for (const control of [
      mobileDock.locator('[data-dock-tab="qaDock/panel"] [data-action="session-tab-menu"]'),
      mobileDock.getByRole("button", { name: "Close QA Dock" }),
      mobileDock.getByRole("button", { name: "Add dock item to mobile" }),
      mobileDock.getByRole("button", { name: "QA dock small action" }),
      mobileDock.locator("label").filter({ hasText: "QA plugin option" }),
    ]) {
      await expectTouchTarget(control)
    }
    await mobileDock.getByRole("button", { name: "Add dock item to mobile" }).click()
    await expectTouchTarget(page.getByLabel("Search dock items"))
    await page.keyboard.press("Escape")
    await expect(
      page.locator('[data-dock-wrapper="mobile"]').getByRole("separator", { name: "Resize mobile dock" }),
    ).toBeVisible()
    await expect
      .poll(() =>
        page.evaluate(() => {
          const value = localStorage.getItem("opencode.global.dat:layout")
          if (!value) return
          const dock = (JSON.parse(value) as { dock?: { schema?: number; mobile?: { activeItem?: string } } }).dock
          return { schema: dock?.schema, active: dock?.mobile?.activeItem }
        }),
      )
      .toEqual({ schema: 3, active: "qaDock/panel" })

    await mobileDock.getByRole("button", { name: "Close QA Dock" }).click()
    await expect(mobileDock.getByRole("tab", { name: "QA Dock" })).toHaveCount(0)
    await expect(mobileDock.getByRole("tab", { name: "QA Top" })).toHaveAttribute("aria-selected", "true")
    await page.getByRole("button", { name: "QA plugin toolbar" }).click()
    await expectAppVisible(mobileDock.getByRole("tab", { name: "QA Dock" }))
    await expect(mobileDock.getByRole("tab", { name: "QA Top" })).toHaveAttribute("aria-selected", "true")
    await expect(mobileDock.getByRole("tab", { name: "QA Dock" })).toHaveAttribute("aria-selected", "false")
    await expectAppVisible(page.locator('[data-dock-attention="qaDock/panel"]'))
    await mobileDock.getByRole("tab", { name: "QA Dock" }).click()
    await expect(page.locator('[data-dock-attention="qaDock/panel"]')).toHaveCount(0)

    await page.getByRole("textbox", { name: "QA dock input" }).focus()
    await page.setViewportSize({ width: 390, height: 500 })
    await expectAppVisible(page.locator('[data-dock-wrapper="mobile"]'))
    await page.locator('[data-component="prompt-input"]').focus()
    await expect(page.locator('[data-dock-wrapper="mobile"]')).toHaveCount(0)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.locator('[data-action="mobile-dock-launcher"]').click()
    await expectAppVisible(page.locator('[data-dock-wrapper="mobile"]'))

    const beforeMobileResize = await page.locator('[data-dock-wrapper="mobile"]').boundingBox()
    expect(beforeMobileResize).not.toBeNull()
    await resizeMobileDockWithTouch(page, -48)
    await expect
      .poll(async () => {
        const after = await page.locator('[data-dock-wrapper="mobile"]').boundingBox()
        if (!after || !beforeMobileResize) return 0
        return after.height - beforeMobileResize.height
      })
      .toBeGreaterThanOrEqual(32)
    const resizedMobile = await page.locator('[data-dock-wrapper="mobile"]').boundingBox()
    expect(resizedMobile).not.toBeNull()

    const desktopAreas = await page.evaluate(() => {
      const value = localStorage.getItem("opencode.global.dat:layout")
      if (!value) return {}
      const items = (JSON.parse(value) as { dock?: { items?: Record<string, { area?: string }> } }).dock?.items ?? {}
      return Object.fromEntries(
        ["qaDock/top", "qaDock/panel", "qaDock/route", "qaDock/right", "qaDock/bottom"].map((id) => [
          id,
          items[id]?.area,
        ]),
      )
    })
    expect(desktopAreas).toEqual({
      "qaDock/top": "top",
      "qaDock/panel": "left",
      "qaDock/route": "left",
      "qaDock/right": "right",
      "qaDock/bottom": "bottom",
    })
    await page.screenshot({ path: "e2e/test-results/dock-layout-qa-mobile.png", fullPage: true })

    let activeDuringDelayedManifest: string | undefined
    await page.route(
      "**/app/plugins**",
      async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 250))
        activeDuringDelayedManifest = await page.evaluate(() => {
          const value = localStorage.getItem("opencode.global.dat:layout")
          if (!value) return
          return (JSON.parse(value) as { dock?: { mobile?: { activeItem?: string } } }).dock?.mobile?.activeItem
        })
        await route.fallback()
      },
      { times: 1 },
    )
    await page.reload()
    await expect.poll(() => activeDuringDelayedManifest).toBe("qaDock/panel")
    await hideDebugBar(page)
    await expectAppVisible(page.locator('[data-component="session-dock-shell"][data-layout="mobile-stack"]'))
    await expect(page.locator('[data-dock-area="mobile"]')).toHaveCount(0)
    await page.locator('[data-action="mobile-dock-launcher"]').click()
    await expectAppVisible(page.locator('[data-dock-area="mobile"]').getByRole("tab", { name: "QA Dock" }))
    await expect(page.locator('[data-dock-area="mobile"]').getByRole("tab", { name: "QA Dock" })).toHaveAttribute(
      "aria-selected",
      "true",
    )
    await expect
      .poll(async () => (await page.locator('[data-dock-wrapper="mobile"]').boundingBox())?.height)
      .toBe(resizedMobile?.height)

    await page.locator('[data-component="prompt-input"]').focus()
    await page.setViewportSize({ width: 700, height: 390 })
    await expectAppVisible(page.locator('[data-component="session-dock-shell"][data-layout="mobile-stack"]'))
    await expectAppVisible(page.locator('[data-dock-wrapper="mobile"]'))
    await expect(page.locator(".mobile-help-hidden").getByRole("button", { name: "Help" })).toBeHidden()
    await page.locator('[data-dock-area="mobile"]').getByRole("tab", { name: "QA Bottom" }).click()
    const landscapeDock = page.locator('[data-dock-wrapper="mobile"]')
    const landscapeHandle = landscapeDock.locator('[data-component="resize-handle"]').first()
    await expect.poll(async () => (await landscapeDock.boundingBox())?.height).toBe(150)
    await expect(landscapeHandle).toHaveAttribute("aria-valuemax", "150")
    await expect(landscapeHandle).toHaveAttribute("aria-valuenow", "150")

    await resizeMobileDockWithTouch(page, 16)
    await expect.poll(async () => (await landscapeDock.boundingBox())?.height).toBe(134)
    await expect(landscapeHandle).toHaveAttribute("aria-valuenow", "134")

    await page.setViewportSize({ width: 390, height: 844 })
    await expect.poll(async () => (await landscapeDock.boundingBox())?.height).toBe(134)
    const portraitActions = page.locator(
      '[data-dock-wrapper="mobile"] [data-dock-tab="qaDock/bottom"] [data-action="session-tab-actions"]',
    )
    await expectTouchTarget(portraitActions.getByRole("button", { name: "More options" }))
    await expectTouchTarget(portraitActions.getByRole("button", { name: "Close QA Bottom" }))

    expectNoSmokeErrors(errors, [], [])
  })

  test("keeps the mobile dock touchable in coarse-pointer landscape", async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 844, height: 390 },
      hasTouch: true,
      isMobile: true,
    })
    const page = await context.newPage()
    const errors = trackPageErrors(page)
    await mockOpenCodeServer(page, {
      directory,
      project: project(),
      provider: provider(),
      sessions: [session(), secondSession()],
      pageMessages: () => ({ items: messages() }),
      onSessionCreate: () => newSession(),
    })
    await mockAppPlugin(page)
    await configurePage(page)

    await page.goto(`/?pluginRoute=qaDock%2Fqa-route`)
    await hideDebugBar(page)
    await expect.poll(() => page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true)
    await expectAppVisible(page.locator('[data-component="session-dock-shell"][data-layout="mobile-stack"]'))
    await expect(page.locator(".mobile-help-hidden").getByRole("button", { name: "Help" })).toBeHidden()
    await expectComposerToolbarLayout(page, "mobile")
    await expectMobilePrimaryTouchTargets(page)
    await expectNoOverlaps(page, "mobile")

    await page.locator('[data-action="mobile-dock-launcher"]').tap()
    const dock = page.locator('[data-dock-wrapper="mobile"]')
    await expectAppVisible(dock)
    await expect.poll(async () => (await dock.boundingBox())?.height).toBe(150)
    const add = dock.getByRole("button", { name: "Add dock item to mobile" })

    const tabsBeforeKeyboardOpen = await dock.locator("[data-dock-tab]").evaluateAll((tabs) =>
      tabs.map((tab) => (tab as HTMLElement).dataset.dockTab),
    )
    await page.evaluate(() => {
      const state = window as Window & { qaDockKeyboardActivations?: number }
      state.qaDockKeyboardActivations = 0
      window.addEventListener("opencode:dock-resize", (event) => {
        if (!(event instanceof CustomEvent) || !event.detail?.active) return
        state.qaDockKeyboardActivations = (state.qaDockKeyboardActivations ?? 0) + 1
      })
    })
    await add.focus()
    await page.keyboard.press("Enter")
    await expectAppVisible(page.locator('[data-component="dock-add-menu"]'))
    await expect
      .poll(() =>
        dock.locator("[data-dock-tab]").evaluateAll((tabs) =>
          tabs.map((tab) => (tab as HTMLElement).dataset.dockTab),
        ),
      )
      .toEqual(tabsBeforeKeyboardOpen)
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as Window & { qaDockKeyboardActivations?: number }).qaDockKeyboardActivations,
        ),
      )
      .toBe(0)
    await page.keyboard.press("Escape")

    await dispatchPointerEvent(add, "pointerdown", {
      pointerId: 2,
      pointerType: "touch",
      isPrimary: false,
      button: 0,
    })
    await dispatchPointerEvent(add, "pointerup", {
      pointerId: 2,
      pointerType: "touch",
      isPrimary: false,
      button: 0,
    })
    await expect(add).toHaveAttribute("aria-expanded", "false")

    await dispatchPointerEvent(add, "pointerdown", {
      pointerId: 3,
      pointerType: "pen",
      isPrimary: true,
      button: 2,
    })
    await dispatchPointerEvent(add, "pointerup", {
      pointerId: 3,
      pointerType: "pen",
      isPrimary: true,
      button: 2,
    })
    await expect(add).toHaveAttribute("aria-expanded", "false")

    await dispatchPointerEvent(add, "pointerdown", {
      pointerId: 4,
      pointerType: "touch",
      isPrimary: true,
      button: 0,
    })
    await dispatchPointerEvent(add, "pointermove", {
      pointerId: 4,
      pointerType: "touch",
      isPrimary: true,
      button: 0,
      dx: 16,
    })
    await dispatchPointerEvent(add, "pointerup", {
      pointerId: 4,
      pointerType: "touch",
      isPrimary: true,
      button: 0,
      dx: 16,
    })
    await expect(add).toHaveAttribute("aria-expanded", "false")

    await dispatchPointerEvent(add, "pointerdown", {
      pointerId: 5,
      pointerType: "touch",
      isPrimary: true,
      button: 0,
    })
    await dispatchPointerEvent(add, "pointercancel", {
      pointerId: 5,
      pointerType: "touch",
      isPrimary: true,
      button: 0,
    })
    await dispatchPointerEvent(add, "pointerup", {
      pointerId: 5,
      pointerType: "touch",
      isPrimary: true,
      button: 0,
    })
    await expect(add).toHaveAttribute("aria-expanded", "false")

    await dispatchPointerEvent(add, "pointerdown", {
      pointerId: 6,
      pointerType: "pen",
      isPrimary: true,
      button: 0,
    })
    await dispatchPointerEvent(add, "pointerup", {
      pointerId: 6,
      pointerType: "pen",
      isPrimary: true,
      button: 0,
    })
    await expectAppVisible(page.locator('[data-component="dock-add-menu"]'))
    await page.keyboard.press("Escape")

    await add.tap()
    await expectAppVisible(page.locator('[data-component="dock-add-menu"]'))
    await page.getByLabel("Search dock items").fill("QA Right")
    await page.evaluate(() => {
      const state = window as Window & { qaDockRightActivations?: number }
      state.qaDockRightActivations = 0
      window.addEventListener("opencode:dock-resize", (event) => {
        if (!(event instanceof CustomEvent) || event.detail?.active !== "qaDock/right") return
        state.qaDockRightActivations = (state.qaDockRightActivations ?? 0) + 1
      })
    })
    await page.locator('[data-dock-add-item="qaDock/right"]').tap()
    await expectAppVisible(dock.getByRole("tab", { name: "QA Right" }))
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as Window & { qaDockRightActivations?: number }).qaDockRightActivations,
        ),
      )
      .toBe(1)
    await resizeMobileDockWithTouch(page, 16)
    await expect.poll(async () => (await dock.boundingBox())?.height).toBe(134)
    await add.tap()
    await expectAppVisible(page.locator('[data-component="dock-add-menu"]'))
    await expectTouchTarget(page.getByLabel("Search dock items"))
    await page.locator('[data-dock-add-item="qaDock/bottom"]').dispatchEvent("click", {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: 0,
      detail: 1,
    })
    await expectAppVisible(dock.getByRole("tab", { name: "QA Bottom" }))

    expectNoSmokeErrors(errors, [], [])
    await context.close()
  })

  test("keeps mobile dock menus inside an offset visual viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.addInitScript(() => {
      const viewport = new EventTarget()
      Object.defineProperties(viewport, {
        width: { value: 350 },
        height: { value: 700 },
        offsetLeft: { value: 20 },
        offsetTop: { value: 120 },
      })
      Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport })
    })
    await mockOpenCodeServer(page, {
      directory,
      project: project(),
      provider: provider(),
      sessions: [session(), secondSession()],
      pageMessages: () => ({ items: messages() }),
      onSessionCreate: () => newSession(),
    })
    await mockAppPlugin(page)
    await configurePage(page)

    await page.goto(`/?pluginRoute=qaDock%2Fqa-route`)
    await hideDebugBar(page)
    await page.locator('[data-action="mobile-dock-launcher"]').click()
    const mobileDock = page.locator('[data-dock-area="mobile"]')
    await expectAppVisible(mobileDock)
    await mobileDock.getByRole("button", { name: "Add dock item to mobile" }).click()
    await expectDockAddMenuInViewport(page)
    await page.keyboard.press("Escape")
  })
})

async function configurePage(page: Page) {
  await page.addInitScript(
    ({ directory, dirBase64, sessionID, secondSessionID }) => {
      localStorage.setItem(
        "opencode.global.dat:plugin-toolbar-visibility",
        JSON.stringify({
          version: 1,
          global: Object.fromEntries(
            [
              ...Array.from({ length: 18 }, (_, index) => `qaDock/composerLeft${index}`),
              ...Array.from({ length: 18 }, (_, index) => `qaDock/composerRight${index}`),
              "qaDock/composerMount",
              "qaDock/hiddenComposer",
              "qaDock/disabledComposer",
            ].map((id) => [id, true]),
          ),
          projects: {},
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: {
            local: [{ worktree: directory, expanded: true }],
          },
          lastProject: {
            local: directory,
          },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([
          {
            type: "session",
            server: "http://127.0.0.1:4096",
            dirBase64,
            sessionId: sessionID,
          },
          {
            type: "session",
            server: "http://127.0.0.1:4096",
            dirBase64,
            sessionId: secondSessionID,
          },
        ]),
      )
      if (!localStorage.getItem("opencode.global.dat:layout")) {
        localStorage.setItem(
          "opencode.global.dat:layout",
          JSON.stringify({
            dock: {
              schema: 2,
              top: {
                visible: true,
                size: 120,
                tabs: ["qaDock/top"],
                active: "qaDock/top",
              },
              left: {
                visible: true,
                size: 260,
                tabs: ["qaDock/panel"],
                active: "qaDock/panel",
              },
              bottom: {
                visible: false,
                size: 280,
                tabs: ["terminal", "qaDock/bottom"],
                active: "qaDock/bottom",
              },
              items: {
                session: { area: "middle", visible: true },
                terminal: { area: "bottom", visible: false },
                review: { area: "right", visible: true },
                fileTree: { area: "right", visible: false },
                gitChanges: { area: "right", visible: false },
                "qaDock/top": { area: "top", visible: true },
                "qaDock/panel": { area: "left", visible: true },
                "qaDock/bottom": { area: "bottom", visible: true },
              },
            },
          }),
        )
      }
    },
    { directory, dirBase64: base64Encode(directory), sessionID, secondSessionID },
  )
}

async function expectToolbarToggle(page: Page, area: "top" | "left" | "right" | "bottom", label: string) {
  await page.getByRole("button", { name: label }).click()
  await expect(page.locator(`[data-dock-area="${area}"]`)).not.toBeVisible()
  await page.getByRole("button", { name: label }).click()
  await expectAppVisible(page.locator(`[data-dock-area="${area}"]`))
}

function dockSessionTab(page: Page, area: "top" | "left" | "middle" | "right" | "bottom", name: string) {
  return page.locator(`[data-dock-area="${area}"]`).getByRole("tab", { name }).first()
}

async function addDockPane(
  page: Page,
  area: "top" | "left" | "middle" | "right" | "bottom",
  query: string,
  id?: string,
) {
  await openDockAddMenu(page, area)
  await page.getByLabel("Search dock items").fill(query)
  if (id) {
    const item = page.locator(`[data-component="dock-add-menu"] [data-dock-add-item="${id}"]`)
    await expectAppVisible(item)
    await item.click()
    return
  }
  await page.keyboard.press("Enter")
}

async function openDockAddMenu(page: Page, area: "top" | "left" | "middle" | "right" | "bottom") {
  await page
    .locator(`[data-dock-area="${area}"]`)
    .getByRole("button", { name: `Add dock item to ${area}` })
    .click()
  await expectAppVisible(page.locator('[data-component="dock-add-menu"]'))
  await expectDockAddMenuInViewport(page)
}

async function dragDockTab(
  page: Page,
  fromArea: "top" | "left" | "middle" | "right" | "bottom",
  name: string,
  toArea: "top" | "left" | "middle" | "right" | "bottom",
  targetName?: string,
) {
  const source = page.locator(`[data-dock-area="${fromArea}"] [data-dock-tab]`).filter({ hasText: name }).first()
  const target = targetName
    ? page.locator(`[data-dock-area="${toArea}"] [data-dock-tab]`).filter({ hasText: targetName }).first()
    : page.locator(`[data-dock-area="${toArea}"]`).first()
  await expectAppVisible(source)
  await expectAppVisible(target)
  await source.dragTo(target)
}

async function dockTabIDs(page: Page, area: "top" | "left" | "middle" | "right" | "bottom") {
  return page
    .locator(`[data-dock-area="${area}"] [data-dock-tab]`)
    .evaluateAll((elements) => elements.map((element) => (element as HTMLElement).dataset.dockTab))
}

async function hideDebugBar(page: Page) {
  await page.addStyleTag({
    content: '[aria-label="Development performance diagnostics"] { display: none !important; pointer-events: none !important; }',
  })
}

async function expectDockAddMenuInViewport(page: Page) {
  const last = page.locator('[data-component="dock-add-menu"] [data-dock-add-item]').last()
  if ((await last.count()) > 0) await last.scrollIntoViewIfNeeded()
  const result = await page.evaluate(() => {
    const menu = document.querySelector<HTMLElement>('[data-component="dock-add-menu"]')
    if (!menu) return { visible: false, inViewport: false, topmost: false, lastItem: undefined, rect: undefined }
    const rect = menu.getBoundingClientRect()
    const point = document.elementFromPoint(rect.left + rect.width / 2, Math.min(rect.bottom - 8, rect.top + 20))
    const viewport = {
      left: window.visualViewport?.offsetLeft ?? 0,
      top: window.visualViewport?.offsetTop ?? 0,
      right: (window.visualViewport?.offsetLeft ?? 0) + (window.visualViewport?.width ?? innerWidth),
      bottom: (window.visualViewport?.offsetTop ?? 0) + (window.visualViewport?.height ?? innerHeight),
    }
    const last = [...menu.querySelectorAll<HTMLElement>("[data-dock-add-item]")].at(-1)
    const lastRect = last?.getBoundingClientRect()
    const lastPoint = lastRect
      ? document.elementFromPoint(lastRect.left + lastRect.width / 2, lastRect.top + lastRect.height / 2)
      : undefined
    return {
      visible: rect.width > 0 && rect.height > 0,
      inViewport:
        rect.left >= viewport.left &&
        rect.top >= viewport.top &&
        rect.right <= viewport.right &&
        rect.bottom <= viewport.bottom,
      topmost: point ? menu.contains(point) : false,
      lastItem: last && lastRect
        ? {
            height: lastRect.height,
            inViewport:
              lastRect.left >= viewport.left &&
              lastRect.top >= viewport.top &&
              lastRect.right <= viewport.right &&
              lastRect.bottom <= viewport.bottom,
            topmost: lastPoint === last || (!!lastPoint && last.contains(lastPoint)),
          }
        : undefined,
      rect: rect.toJSON(),
    }
  })
  expect(result.visible).toBe(true)
  expect(result.inViewport).toBe(true)
  expect(result.topmost).toBe(true)
  if (result.lastItem) {
    expect(result.lastItem.height).toBeGreaterThanOrEqual(44)
    expect(result.lastItem.inViewport).toBe(true)
    expect(result.lastItem.topmost).toBe(true)
  }
}

async function expectTouchTarget(control: Locator) {
  await expectAppVisible(control)
  const result = await control.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const point = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    const list = element.closest<HTMLElement>('[role="tablist"]')
    const tab = element.closest<HTMLElement>("[data-dock-tab]")
    return {
      label: element.getAttribute("aria-label"),
      width: rect.width,
      height: rect.height,
      topmost: point === element || element.contains(point),
      hitLabel: point?.closest("[aria-label]")?.getAttribute("aria-label"),
      left: rect.left,
      right: rect.right,
      tab: tab?.getBoundingClientRect().toJSON(),
      list: list?.getBoundingClientRect().toJSON(),
      scrollLeft: list?.scrollLeft,
      scrollWidth: list?.scrollWidth,
      clientWidth: list?.clientWidth,
    }
  })
  expect(result.width, JSON.stringify(result)).toBeGreaterThanOrEqual(44)
  expect(result.height, JSON.stringify(result)).toBeGreaterThanOrEqual(44)
  await expect
    .poll(() =>
      control.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        const point = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
        return {
          topmost: point === element || element.contains(point),
          label: element.getAttribute("aria-label"),
          hitLabel: point?.closest("[aria-label]")?.getAttribute("aria-label") ?? null,
          left: rect.left,
          right: rect.right,
          viewport: innerWidth,
        }
      }),
    )
    .toMatchObject({ topmost: true, label: result.label, hitLabel: result.label })
}

async function expectMobilePrimaryTouchTargets(page: Page) {
  const result = await page.evaluate(() => {
    const selector = [
      "[data-mobile-touch-target]",
      '[data-action="mobile-dock-launcher"]',
      '[data-action="prompt-attach"]',
      '[data-action="prompt-agent"]',
      '[data-action="prompt-model"]',
      '[data-action="prompt-model-variant"]',
      '[data-action="prompt-access-control"]',
      '[data-action="prompt-context-compact"]',
      '[data-action="prompt-submit"]',
      '[data-action="prompt-interrupt"]',
      '[data-component="plugin-toolbar-outlet"][data-plugin-toolbar-placement="top"] :is(button, [role="button"], a[href])',
      '[data-component="plugin-slot-outlet"][data-plugin-slot="toolbar.actions"] :is(button, [role="button"], a[href])',
      '[data-component="plugin-slot-outlet"][data-plugin-slot="header.actions"] :is(button, [role="button"], a[href])',
    ].join(",")
    const targets = [...document.querySelectorAll<HTMLElement>(selector)]
      .filter((element, index, elements) => elements.indexOf(element) === index)
      .map((element) => {
        const rect = element.getBoundingClientRect()
        const point = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
        return {
          action: element.dataset.action ?? element.getAttribute("aria-label") ?? element.tagName,
          visible: rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden",
          width: rect.width,
          height: rect.height,
          topmost: point === element || element.contains(point),
        }
      })
      .filter((target) => target.visible)
    return {
      count: targets.length,
      failures: targets.filter((target) => target.width < 44 || target.height < 44 || !target.topmost),
    }
  })
  expect(result.count).toBeGreaterThanOrEqual(5)
  expect(result.failures).toEqual([])
}

async function expectMobileToolbarBelowDialog(page: Page) {
  const more = page.getByRole("button", { name: "More tools", exact: true })
  await more.click()
  const menu = page.locator('[data-component="plugin-toolbar-mobile-menu"]')
  await expectAppVisible(menu)
  await page.evaluate(() => document.querySelector<HTMLElement>('[aria-label="Open settings"]')?.click())
  const overlay = page.locator('[data-component="dialog-overlay"]').last()
  await expectAppVisible(overlay)
  const result = await page.evaluate(() => {
    const menu = document.querySelector<HTMLElement>('[data-component="plugin-toolbar-mobile-menu"]')
    const overlay = [...document.querySelectorAll<HTMLElement>('[data-component="dialog-overlay"]')].at(-1)
    if (!menu || !overlay) return
    const rect = menu.getBoundingClientRect()
    const point = document.elementFromPoint(rect.left + rect.width / 2, rect.top + Math.min(rect.height / 2, 24))
    return {
      menuZ: Number(getComputedStyle(menu).zIndex),
      overlayZ: Number(getComputedStyle(overlay).zIndex),
      menuIntercepts: point === menu || menu.contains(point),
    }
  })
  expect(result).toBeDefined()
  expect(result?.menuZ).toBeLessThan(result?.overlayZ ?? 0)
  expect(result?.menuIntercepts).toBe(false)
  await page.keyboard.press("Escape")
  await expect(overlay).toHaveCount(0)
  await expect(more).toHaveAttribute("aria-expanded", "false")
}

async function expectMobileDockAddBelowDialog(page: Page, mobileDock: Locator) {
  await mobileDock.getByRole("button", { name: "Add dock item to mobile" }).click()
  const menu = page.locator('[data-component="dock-add-menu"]')
  await expectAppVisible(menu)
  await expectDockAddMenuInViewport(page)
  const before = await menu.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + Math.min(rect.height / 2, 24),
      z: Number(getComputedStyle(element).zIndex),
    }
  })
  await page.evaluate(() => document.querySelector<HTMLElement>('[aria-label="Open settings"]')?.click())
  const overlay = page.locator('[data-component="dialog-overlay"]').last()
  await expectAppVisible(overlay)
  await expect(menu).toHaveCount(0)
  const after = await page.evaluate(
    ({ x, y }) => {
      const overlay = [...document.querySelectorAll<HTMLElement>('[data-component="dialog-overlay"]')].at(-1)
      const point = document.elementFromPoint(x, y)
      return {
        overlayZ: Number(getComputedStyle(overlay!).zIndex),
        dialogIntercepts: point === overlay || !!point?.closest("[data-dialog-layer]"),
        dockIntercepts: !!point?.closest('[data-component="dock-add-menu"], [data-dock-wrapper]'),
      }
    },
    before,
  )
  expect(before.z).toBeLessThan(after.overlayZ)
  expect(after.dialogIntercepts).toBe(true)
  expect(after.dockIntercepts).toBe(false)
  await page.keyboard.press("Escape")
  await expect(overlay).toHaveCount(0)
}

async function expectMobileDockMenuBelowDialog(page: Page, mobileDock: Locator) {
  const trigger = mobileDock.locator('[data-dock-tab="qaDock/panel"] [data-action="session-tab-menu"]')
  await trigger.click()
  const contentID = await trigger.getAttribute("aria-controls")
  expect(contentID).toBeTruthy()
  const content = page.locator(`#${contentID}`)
  await expectAppVisible(content)
  await page.evaluate(() => document.querySelector<HTMLElement>('[aria-label="Open settings"]')?.click())
  const overlay = page.locator('[data-component="dialog-overlay"]').last()
  await expectAppVisible(overlay)
  await expect(content).toHaveCount(0)
  await page.keyboard.press("Escape")
  await expect(overlay).toHaveCount(0)
}

async function expectResizable(
  page: Page,
  area: "top" | "left" | "right" | "bottom",
  dimension: "width" | "height",
  dx: number,
  dy: number,
) {
  const wrapper = page.locator(`[data-dock-wrapper="${area}"]`)
  const before = await wrapper.boundingBox()
  expect(before).not.toBeNull()

  const handle = wrapper.locator('[data-component="resize-handle"]').first()
  const box = await handle.boundingBox()
  expect(box).not.toBeNull()
  if (!before || !box) return

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 6 })
  await page.mouse.up()

  await expect
    .poll(async () => {
      const after = await wrapper.boundingBox()
      if (!after) return 0
      return dimension === "width" ? after.width - before.width : after.height - before.height
    })
    .toBeGreaterThanOrEqual(18)
}

async function resizeMobileDockWithTouch(page: Page, deltaY: number) {
  const handle = page.locator('[data-dock-wrapper="mobile"] [data-component="resize-handle"]').first()
  const box = await handle.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return
  const client = await page.context().newCDPSession(page)
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y, id: 1, radiusX: 8, radiusY: 8 }],
  })
  await client.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x, y: y + deltaY, id: 1, radiusX: 8, radiusY: 8 }],
  })
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
  await client.detach()
}

async function touchElement(page: Page, element: Locator) {
  const box = await element.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return
  const client = await page.context().newCDPSession(page)
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y, id: 1, radiusX: 8, radiusY: 8 }],
  })
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
  await client.detach()
}

async function dispatchPointerEvent(
  element: Locator,
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  input: {
    pointerId: number
    pointerType: "touch" | "pen"
    isPrimary: boolean
    button: number
    dx?: number
    dy?: number
  },
) {
  const box = await element.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return
  await element.dispatchEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    pointerId: input.pointerId,
    pointerType: input.pointerType,
    isPrimary: input.isPrimary,
    button: input.button,
    buttons: type === "pointerdown" || type === "pointermove" ? (input.button === 0 ? 1 : 2) : 0,
    clientX: box.x + box.width / 2 + (input.dx ?? 0),
    clientY: box.y + box.height / 2 + (input.dy ?? 0),
  })
}

async function mockAppPlugin(page: Page) {
  await page.route("**/app/plugins**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({
        plugins: [
          {
            id: "qaDock",
            spec: "qa-dock-plugin",
            version: "1",
            module: "/app/plugin/qaDock/1/app.js",
            hash: "qa",
            capabilities: ["ui:dock", "ui:slots", "routes", "chat:parts", "ui:toolbar", "host:composer"],
          },
        ],
      }),
    }),
  )
  await page.route("**/app/plugin/qaDock/1/app.js**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/javascript",
      headers: { "access-control-allow-origin": "*" },
      body: `
        export default {
          id: "qaDock",
          app(api) {
            api.dock.register({
              id: "panel",
              title: "QA Dock",
              defaultArea: "right",
              allowedAreas: ["right", "left"],
              mount({ element, area, signal }) {
                const section = document.createElement("section")
                section.dataset.testid = "qa-dock-panel"
                section.style.cssText = "padding:12px;min-width:0"
                section.append("QA Dock Panel in " + area)
                const label = document.createElement("label")
                label.style.cssText = "display:block;margin-top:8px"
                label.append("Dock input")
                const input = document.createElement("input")
                input.setAttribute("aria-label", "QA dock input")
                input.style.cssText = "display:block;min-height:44px;margin-top:4px"
                label.append(input)
                section.append(label)
                const action = document.createElement("button")
                action.type = "button"
                action.setAttribute("aria-label", "QA dock small action")
                action.style.cssText = "width:20px;height:20px;margin-top:4px"
                section.append(action)
                const option = document.createElement("label")
                option.style.cssText = "display:block;height:16px;margin-top:4px"
                const checkbox = document.createElement("input")
                checkbox.type = "checkbox"
                option.append(checkbox, "QA plugin option")
                section.append(option)
                element.append(section)
                signal.addEventListener("abort", () => element.replaceChildren())
              },
            })
            api.dock.open.item("panel", { area: "left", reveal: false })
            api.dock.register({
              id: "top",
              title: "QA Top",
              defaultArea: "top",
              allowedAreas: ["top"],
              mount({ element, signal }) {
                element.innerHTML = '<section data-testid="qa-top-panel" style="padding:12px">QA Top Dock</section>'
                signal.addEventListener("abort", () => element.replaceChildren())
              },
            })
            api.dock.open.item("top", { area: "top", reveal: false })
            api.dock.register({
              id: "right",
              title: "QA Right",
              defaultArea: "right",
              allowedAreas: ["right"],
              mount({ element, signal }) {
                element.innerHTML = '<section data-testid="qa-right-panel" style="padding:12px">QA Right Dock</section>'
                signal.addEventListener("abort", () => element.replaceChildren())
              },
            })
            api.dock.register({
              id: "bottom",
              title: "QA Bottom",
              defaultArea: "bottom",
              allowedAreas: ["bottom"],
              mount({ element, signal }) {
                element.innerHTML = '<section data-testid="qa-bottom-panel" style="padding:12px">QA Bottom Dock</section>'
                signal.addEventListener("abort", () => element.replaceChildren())
              },
            })
            api.routes.register({
              id: "route",
              path: "qa-route",
              title: "QA Route",
              mount({ element, signal }) {
                element.innerHTML = '<section data-testid="qa-route-view" style="padding:12px">QA Route Middle View</section>'
                signal.addEventListener("abort", () => element.replaceChildren())
              },
            })
            api.slots.register({
              id: "toolbar",
              slot: "toolbar.actions",
              mount({ element, signal }) {
                const button = document.createElement("button")
                button.type = "button"
                button.textContent = "QA"
                button.setAttribute("aria-label", "QA plugin toolbar")
                button.style.cssText = "height:24px;padding:0 8px;border:1px solid var(--border-weak-base);border-radius:6px"
                button.addEventListener("click", () => api.dock.open.item("panel", { area: "left", reveal: false }))
                element.append(button)
                signal.addEventListener("abort", () => element.replaceChildren())
              },
            })
            for (let index = 0; index < 18; index++) {
              api.toolbar.register({
                id: "composerLeft" + index,
                title: "QA Composer Left " + (index + 1),
                placement: "composer",
                align: "left",
                order: index,
                run() {
                  if (index === 0) document.documentElement.dataset.qaComposerTouchRuns = "1"
                },
              })
              api.toolbar.register({
                id: "composerRight" + index,
                title: "QA Composer Right " + (index + 1),
                placement: "composer",
                align: "right",
                order: index,
                run() {},
              })
            }
            api.toolbar.register({
              id: "composerMount",
              title: "QA Composer Mount",
              placement: "composer",
              align: "left",
              kind: "mount",
              order: 30,
              mount({ element, signal, context }) {
                const button = document.createElement("button")
                button.type = "button"
                button.textContent = "Mount"
                button.setAttribute("aria-label", "QA Composer Mount")
                button.style.cssText = "height:28px;padding:0 8px;border:1px solid var(--border-weak-base);border-radius:6px;white-space:nowrap"
                button.addEventListener("click", () => {
                  const composer = api.host.composer.read(context)
                  document.documentElement.dataset.qaComposerMountBound =
                    composer && typeof composer.text === "string" ? "true" : "false"
                })
                element.append(button)
                signal.addEventListener("abort", () => element.replaceChildren())
              },
            })
            api.toolbar.register({
              id: "hiddenComposer",
              title: "QA Hidden Composer",
              placement: "composer",
              align: "right",
              visible() {
                return false
              },
              run() {},
            })
            api.toolbar.register({
              id: "disabledComposer",
              title: "QA Disabled Composer",
              placement: "composer",
              align: "right",
              order: 40,
              enabled() {
                return false
              },
              run() {},
            })
            api.chat.parts.register({
              kind: "inline",
              mount({ element, part, signal }) {
                // part.data is untrusted â€” never interpolate it into innerHTML.
                // Build DOM nodes and assign data via textContent.
                const wrapper = document.createElement("div")
                wrapper.setAttribute("data-testid", "qa-custom-part")
                wrapper.style.cssText = "padding:8px;border:1px solid var(--border-weak-base);border-radius:6px"
                const label = document.createElement("span")
                label.textContent = typeof part.data === "object" && part.data && "label" in part.data ? String(part.data.label) : ""
                wrapper.append(label)
                element.append(wrapper)
                signal.addEventListener("abort", () => element.replaceChildren())
              },
            })
          },
        }
      `,
    }),
  )
}

async function expectComposerToolbarLayout(page: Page, mode: "desktop" | "mobile" | "compact") {
  const left = page.locator(
    '[data-component="plugin-toolbar-outlet"][data-plugin-toolbar-placement="composer"][data-plugin-toolbar-align="left"]',
  )
  const right = page.locator(
    '[data-component="plugin-toolbar-outlet"][data-plugin-toolbar-placement="composer"][data-plugin-toolbar-align="right"]',
  )
  if (mode !== "desktop") {
    await expect(left).toHaveCount(0)
    await expect(right).toHaveCount(0)
    const more = page.getByRole("button", { name: "More tools", exact: true })
    await expectAppVisible(more)
    const moreBox = await more.boundingBox()
    expect(moreBox?.width).toBeGreaterThanOrEqual(mode === "mobile" ? 44 : 28)
    expect(moreBox?.height).toBeGreaterThanOrEqual(mode === "mobile" ? 44 : 28)
    await touchElement(page, more)
    await expect(more).toHaveAttribute("aria-expanded", "true")
    const menu = page.locator('[data-component="plugin-toolbar-mobile-menu"]')
    await expectAppVisible(menu)
    const firstAction = page.getByRole("button", { name: "QA Composer Left 1", exact: true })
    await expectAppVisible(firstAction)
    await expectAppVisible(page.getByRole("button", { name: "QA Composer Right 1", exact: true }))
    await expectAppVisible(page.getByRole("button", { name: "QA Composer Mount" }))
    await expect(page.getByRole("button", { name: "QA Hidden Composer", exact: true })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "QA Disabled Composer", exact: true })).toBeDisabled()

    const result = await page.evaluate(() => {
      const menu = document.querySelector<HTMLElement>('[data-component="plugin-toolbar-mobile-menu"]')
      const more = document.querySelector<HTMLElement>('[data-action="plugin-toolbar-more"]')
      const send = document.querySelector<HTMLElement>('[data-action="prompt-submit"]')
      const controls = [...(menu?.querySelectorAll<HTMLElement>("button, [role=button], a[href]") ?? [])]
      const moreRect = more?.getBoundingClientRect()
      const sendRect = send?.getBoundingClientRect()
      const overlap =
        moreRect && sendRect
          ? Math.max(0, Math.min(moreRect.right, sendRect.right) - Math.max(moreRect.left, sendRect.left)) *
            Math.max(0, Math.min(moreRect.bottom, sendRect.bottom) - Math.max(moreRect.top, sendRect.top))
          : -1
      return {
        mountedActions: controls.filter((item) => item.getAttribute("aria-label") === "QA Composer Mount").length,
        minControlWidth: Math.min(...controls.map((item) => item.getBoundingClientRect().width)),
        minControlHeight: Math.min(...controls.map((item) => item.getBoundingClientRect().height)),
        overlapsSend: overlap !== 0,
        horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }
    })

    expect(result.mountedActions).toBe(1)
    expect(result.minControlWidth).toBeGreaterThanOrEqual(mode === "mobile" ? 44 : 28)
    expect(result.minControlHeight).toBeGreaterThanOrEqual(mode === "mobile" ? 44 : 28)
    expect(result.overlapsSend).toBe(false)
    expect(result.horizontalOverflow).toBeLessThanOrEqual(1)
    await expect
      .poll(async () => {
        const box = await firstAction.boundingBox()
        if (!box) return false
        return page.evaluate(
          ({ x, y }) =>
            document.elementFromPoint(x, y)?.closest('[data-plugin-toolbar-item="qaDock/composerLeft0"]') !== null,
          { x: box.x + box.width / 2, y: box.y + box.height / 2 },
        )
      })
      .toBe(true)
    await touchElement(page, firstAction)
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.qaComposerTouchRuns)).toBe("1")
    await page.getByRole("button", { name: "QA Composer Mount" }).click()
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.qaComposerMountBound)).toBe("true")
    await page.keyboard.press("Escape")
    await expect(more).toHaveAttribute("aria-expanded", "false")
    return
  }

  await expectAppVisible(left)
  await expectAppVisible(right)
  await expectAppVisible(page.getByRole("button", { name: "QA Composer Left 1", exact: true }))
  await expectAppVisible(page.getByRole("button", { name: "QA Composer Right 1", exact: true }))
  await expectAppVisible(page.getByRole("button", { name: "QA Composer Mount" }))
  await expect(page.getByRole("button", { name: "QA Hidden Composer", exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "QA Disabled Composer", exact: true })).toBeDisabled()

  const result = await page.evaluate(() => {
    const toolbarOutlet = (align: "left" | "right") =>
      [
        ...document.querySelectorAll<HTMLElement>(
          `[data-component="plugin-toolbar-outlet"][data-plugin-toolbar-placement="composer"][data-plugin-toolbar-align="${align}"]`,
        ),
      ].toSorted((a, b) => {
        const aRect = a.getBoundingClientRect()
        const bRect = b.getBoundingClientRect()
        return bRect.width * bRect.height - aRect.width * aRect.height
      })[0]
    const left = toolbarOutlet("left")
    const right = toolbarOutlet("right")
    const send = document.querySelector<HTMLElement>('[data-action="prompt-submit"]')
    const topComposerItems = document.querySelectorAll(
      '[data-component="plugin-toolbar-outlet"][data-plugin-toolbar-placement="top"] [aria-label^="QA Composer"]',
    )
    if (!left || !right || !send) {
      const controls = left?.closest<HTMLElement>(
        '[data-component="session-composer"], [data-component="session-new-composer"]',
      )
      const controlsRect = controls?.getBoundingClientRect()
      return {
        present: false,
        leftScrollable: false,
        rightScrollable: false,
        leftHeight: 0,
        rightHeight: 0,
        controlsHeight: controlsRect?.height ?? 0,
        leftRows: 0,
        rightRows: 0,
        gap: -1,
        overlapsSend: true,
        topComposerCount: topComposerItems.length,
      }
    }
    const leftRect = left.getBoundingClientRect()
    const rightRect = right.getBoundingClientRect()
    const sendRect = send.getBoundingClientRect()
    const overlap =
      Math.max(0, Math.min(rightRect.right, sendRect.right) - Math.max(rightRect.left, sendRect.left)) *
      Math.max(0, Math.min(rightRect.bottom, sendRect.bottom) - Math.max(rightRect.top, sendRect.top))
    const controls = left.closest<HTMLElement>(
      '[data-component="session-composer"], [data-component="session-new-composer"]',
    )
    const controlsRect = controls?.getBoundingClientRect()
    const leftRows = new Set(
      [...left.children]
        .map((element) => Math.round((element as HTMLElement).getBoundingClientRect().top))
        .filter((top) => top > 0),
    ).size
    const rightRows = new Set(
      [...right.children]
        .map((element) => Math.round((element as HTMLElement).getBoundingClientRect().top))
        .filter((top) => top > 0),
    ).size
    return {
      present: leftRect.width > 0 && leftRect.height > 0 && rightRect.width > 0 && rightRect.height > 0,
      leftScrollable: left.scrollWidth > left.clientWidth,
      rightScrollable: right.scrollWidth > right.clientWidth,
      leftHeight: leftRect.height,
      rightHeight: rightRect.height,
      controlsHeight: controlsRect?.height ?? 0,
      leftRows,
      rightRows,
      gap: sendRect.left - rightRect.right,
      overlapsSend: overlap > 0,
      topComposerCount: topComposerItems.length,
    }
  })

  expect(result.present, JSON.stringify(result)).toBe(true)
  expect(result.leftScrollable).toBe(false)
  expect(result.rightScrollable).toBe(false)
  expect(result.leftRows).toBeGreaterThanOrEqual(1)
  expect(result.rightRows).toBeGreaterThanOrEqual(1)
  expect(result.gap).toBeGreaterThanOrEqual(0)
  expect(result.overlapsSend).toBe(false)
  expect(result.topComposerCount).toBe(0)
}

async function expectNoOverlaps(page: Page, mode: "desktop" | "mobile") {
  const result = await page.evaluate((mode) => {
    const zones = [...document.querySelectorAll<HTMLElement>("[data-dock-area]")]
      .filter((element) => {
        const rect = element.getBoundingClientRect()
        return rect.width > 1 && rect.height > 1
      })
      .map((element) => ({
        area: element.dataset.dockArea,
        rect: element.getBoundingClientRect().toJSON() as DOMRect,
      }))
    const overlaps: string[] = []
    for (let i = 0; i < zones.length; i++) {
      for (let j = i + 1; j < zones.length; j++) {
        const a = zones[i]!
        const b = zones[j]!
        const overlap =
          Math.max(0, Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left)) *
          Math.max(0, Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top))
        if (overlap > 8) overlaps.push(`${a.area}/${b.area}:${overlap}`)
      }
    }
    const middle = zones.find((zone) => zone.area === "middle")
    return {
      layout: document.querySelector<HTMLElement>("[data-component='session-dock-shell']")?.dataset.layout,
      overlaps,
      middleWidth: middle?.rect.width ?? 0,
      viewport: { width: innerWidth, height: innerHeight },
      mode,
    }
  }, mode)
  expect(result.layout).toBe(mode === "desktop" ? "desktop-grid" : "mobile-stack")
  expect(result.overlaps).toEqual([])
  if (mode === "desktop") expect(result.middleWidth).toBeGreaterThanOrEqual(420)
}

function messages() {
  const userID = "msg_user_dock_qa"
  const assistantID = "msg_assistant_dock_qa"
  return [
    {
      info: {
        id: userID,
        sessionID,
        role: "user",
        time: { created: 1700000000000 },
        summary: { diffs: [] },
        agent: "build",
        model: { providerID: "openrouter", modelID: "stealth/ox-alpha" },
      },
      parts: [{ id: "prt_user_dock_qa", sessionID, messageID: userID, type: "text", text: "Check dock layout" }],
    },
    {
      info: {
        id: assistantID,
        sessionID,
        role: "assistant",
        time: { created: 1700000001000, completed: 1700000002000 },
        parentID: userID,
        modelID: "stealth/ox-alpha",
        providerID: "openrouter",
        mode: "build",
        agent: "build",
        path: { cwd: directory, root: directory },
        cost: 0.01,
        tokens: { input: 100, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
        variant: "max",
        finish: "stop",
      },
      parts: [
        {
          id: "prt_text_dock_qa",
          sessionID,
          messageID: assistantID,
          type: "text",
          text: "Dock QA response with an inline custom part below.",
        },
        {
          id: "prt_custom_dock_qa",
          sessionID,
          messageID: assistantID,
          type: "custom",
          kind: "qaDock/inline",
          title: "QA Custom Part",
          fallback: "QA custom fallback",
          data: { label: "QA Custom Part Rendered" },
        },
      ],
    },
  ]
}

function project() {
  return {
    id: projectID,
    worktree: directory,
    vcs: "git",
    name: "dock-layout-qa",
    time: { created: 1700000000000, updated: 1700000000000 },
    sandboxes: [],
  }
}

function session() {
  return {
    id: sessionID,
    slug: "dock-layout-qa",
    projectID,
    directory,
    title,
    version: "dev",
    time: { created: 1700000000000, updated: 1700000000000 },
  }
}

function secondSession() {
  return {
    id: secondSessionID,
    slug: "dock-layout-qa-follow-up",
    projectID,
    directory,
    title: secondTitle,
    version: "dev",
    time: { created: 1700000002000, updated: 1700000002000 },
  }
}

function newSession() {
  return {
    id: "ses_dock_layout_qa_new",
    slug: "dock-layout-qa-new",
    projectID,
    directory,
    version: "dev",
    time: { created: 1700000003000, updated: 1700000003000 },
  }
}

function provider() {
  return {
    all: [
      {
        id: "openrouter",
        name: "OpenRouter",
        models: { "stealth/ox-alpha": { id: "stealth/ox-alpha", name: "Ox Alpha", limit: { context: 200_000 } } },
      },
    ],
    connected: ["openrouter"],
    default: { providerID: "openrouter", modelID: "stealth/ox-alpha" },
  }
}

function base64Encode(value: string) {
  return Buffer.from(value, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}
