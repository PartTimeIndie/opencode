import { expect, test, type Locator, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectNoSmokeErrors, trackPageErrors } from "../utils/errors"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/MobileCore"
const puDirectory = "C:/GitRepros/PU"
const sessionID = "ses_mobile_core"
const server = "http://127.0.0.1:4096"
const secondaryServer = "http://127.0.0.1:4097"
const remoteDirectory = "C:/OpenCode/RemoteTablet"

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
})

test("mobile portrait can select a model, agent, and PU project through 44px touch targets", async ({ page }) => {
  const errors = trackPageErrors(page)
  const sessions = [session(directory, "proj-mobile-core")]
  const prompts: Array<{ body: unknown; directory: string }> = []
  let moveBody: unknown

  page.on("request", (request) => {
    const url = new URL(request.url())
    if (request.method() !== "POST" || url.pathname !== `/api/session/${sessionID}/prompt`) return
    prompts.push({
      body: request.postDataJSON(),
      directory: decodeURIComponent(
        url.searchParams.get("directory") ?? request.headers()["x-opencode-directory"] ?? "",
      ),
    })
  })

  await mockOpenCodeServer(page, {
    directory,
    project: [
      project("proj-mobile-core", directory, "Mobile Core", "purple"),
      project("proj-pu", puDirectory, "PU", "green"),
    ],
    provider: provider(),
    agents: [
      { name: "build", mode: "primary" },
      { name: "review", mode: "primary" },
    ],
    sessions,
    sessionStatus: {},
    pageMessages: () => ({ items: [] }),
    onMoveSession: (body) => {
      moveBody = body
      sessions[0] = session(puDirectory, "proj-pu")
      return {
        sessionIDs: [sessionID],
        directory: puDirectory,
        projectID: "proj-pu",
        subdirectory: "",
      }
    },
    onSessionPrompt: () => ({
      data: { sessionID, messageID: "msg_mobile_core_prompt", admittedSeq: 1 },
    }),
  })
  await configurePage(page)
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)

  const composer = page.locator('[data-component="session-composer"]')
  await expectAppVisible(composer)

  const modelTrigger = composer.locator('[data-action="prompt-model"]')
  await expectTouchTarget(modelTrigger)
  await modelTrigger.tap()
  const modelPicker = page.locator(".mobile-model-list")
  const modelSearch = modelPicker.getByRole("textbox")
  await expectTouchTarget(modelPicker.locator('[data-slot="list-search"]'))
  await expectTouchTarget(modelSearch)
  await modelSearch.fill("Mobile")
  await expectTouchTarget(modelPicker.locator('[data-slot="list-search"] > [data-component="icon-button"]'))
  const mobileModel = modelPicker.locator('[data-slot="list-item"][data-key="openai:mobile-model"]')
  await expectTouchTarget(mobileModel)
  await expectTouchTarget(page.locator('[data-action="model-provider-connect"]'))
  await expectTouchTarget(page.locator('[data-action="model-manage"]'))
  await mobileModel.tap()
  await expect(modelTrigger).toContainText("Mobile Model")

  const agentTrigger = composer.locator('[data-action="prompt-agent"]')
  await expectTouchTarget(agentTrigger)
  await agentTrigger.tap()
  const reviewAgent = page.getByRole("option", { name: "review", exact: true })
  await expectTouchTarget(reviewAgent)
  await expectTouchTarget(page.locator('[data-action="prompt-agent-configure-review"]'))
  await expectTouchTarget(page.locator('[data-action="prompt-agent-create"]'))
  await reviewAgent.tap()
  await expect(agentTrigger).toContainText("review")

  const projectTrigger = page.locator('[data-action="prompt-project"]')
  await expectTouchTarget(projectTrigger)
  await projectTrigger.tap()
  const projectPicker = page.locator('[data-component="composer-project-picker"]')
  const projectSearch = projectPicker.getByPlaceholder("Search projects")
  await expectTouchTarget(projectSearch)
  await projectSearch.fill("PU")
  await expectTouchTarget(projectPicker.getByRole("button", { name: "Clear" }))
  const puProject = projectPicker.locator('[data-component="composer-picker-item"][data-label="PU"]')
  await expectTouchTarget(puProject)
  await puProject.tap()

  await expect.poll(() => moveBody).toEqual({
    sessionID,
    destination: { directory: puDirectory },
    moveChanges: false,
  })
  await expect(page.locator('[data-action="prompt-project"]')).toContainText("PU")
  const puComposer = page.locator('[data-component="session-composer"]')
  await expect(puComposer.locator('[data-action="prompt-model"]')).toContainText("Mobile Model")
  await expect(puComposer.locator('[data-action="prompt-agent"]')).toContainText("review")
  await puComposer.locator('[data-component="prompt-input"]').fill("Reply with MOBILE_OK")
  await puComposer.locator('[data-action="prompt-submit"]').tap()
  await expect.poll(() => prompts.length).toBe(1)
  expect(prompts[0]).toMatchObject({
    body: {
      agent: "review",
      model: { providerID: "openai", id: "mobile-model" },
      prompt: { text: "Reply with MOBILE_OK" },
    },
    directory: puDirectory,
  })

  await openHome(page)
  const homePU = page.locator('[data-component="home-project-row"]').filter({ hasText: "PU" })
  await expectTouchTarget(homePU)
  const homeProject = homePU.locator("..")
  const homeActions = homeProject.locator('[data-component="home-project-actions"]')
  await expect(homeActions).toHaveCSS("opacity", "1")
  await expectTouchTarget(homeActions.locator('[data-action="home-project-new-session"]'))
  await expectTouchTarget(homeActions.locator('[data-action="home-project-menu"]'))
  await homePU.tap()
  await expect(homePU).toHaveAttribute("aria-current", "page")
  await runAppCommand(page, "home.toggle")
  await expectAppVisible(page.locator('[data-component="session-composer"]'))
  await expect(page.locator('[data-action="prompt-project"]')).toContainText("PU")
  await expect(page.locator('[data-action="prompt-model"]')).toContainText("Mobile Model")
  await expect(page.locator('[data-action="prompt-agent"]')).toContainText("review")

  expectNoSmokeErrors(errors, [], [])
})

test("reselecting the active agent preserves an explicit draft model through prompt admission", async ({ page }) => {
  const errors = trackPageErrors(page)
  const sessions = [session(directory, "proj-mobile-core")]
  const creates: unknown[] = []
  const prompts: unknown[] = []

  await mockOpenCodeServer(page, {
    directory,
    project: project("proj-mobile-core", directory, "Mobile Core", "purple"),
    provider: {
      all: [
        {
          id: "openai",
          name: "OpenAI",
          models: {
            "gpt-5.6-sol": {
              id: "gpt-5.6-sol",
              name: "GPT-5.6 Sol",
              limit: { context: 200_000 },
              variants: { medium: {} },
            },
          },
        },
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "big-pickle": {
              id: "big-pickle",
              name: "Big Pickle",
              limit: { context: 200_000 },
            },
          },
        },
      ],
      connected: ["openai", "opencode"],
      default: { providerID: "openai", modelID: "gpt-5.6-sol" },
    },
    agents: [
      {
        name: "build",
        mode: "primary",
        model: { providerID: "openai", modelID: "gpt-5.6-sol" },
        variant: "medium",
      },
    ],
    sessions,
    sessionStatus: {},
    pageMessages: () => ({ items: [] }),
    onSessionCreate: (body) => {
      creates.push(body)
      const id = (body as { id: string }).id
      const created = {
        ...session(directory, "proj-mobile-core"),
        id,
        slug: id,
        title: "New session",
      }
      sessions.push(created)
      return created
    },
    onSessionPrompt: ({ body, sessionID }) => {
      prompts.push(body)
      return { data: { sessionID, messageID: "msg_mobile_model_admitted", admittedSeq: 1 } }
    },
  })
  await configurePage(page)
  await page.goto("/")

  await openHome(page)
  const projectRow = page.locator('[data-component="home-project-row"]').filter({ hasText: "Mobile Core" })
  await projectRow.tap()
  await projectRow
    .locator("..")
    .locator('[data-action="home-project-new-session"]')
    .tap()

  const composer = page.locator('[data-component="session-new-composer"]')
  await expectAppVisible(composer)
  const model = composer.locator('[data-action="prompt-model"]')
  await model.tap()
  await page.locator('.mobile-model-list [data-key="opencode:big-pickle"]').tap()
  await expect(model).toContainText("Big Pickle")

  const agent = composer.locator('[data-action="prompt-agent"]')
  await agent.tap()
  await page.getByRole("option", { name: "build", exact: true }).tap()
  await expect(agent).toContainText("build")
  await expect(model).toContainText("Big Pickle")

  await composer.locator('[data-component="prompt-input"]').fill("Reply exactly MOBILE_BIG_PICKLE_OK")
  await composer.locator('[data-action="prompt-submit"]').tap()
  await expect.poll(() => creates.length).toBe(1)
  await expect.poll(() => prompts.length).toBe(1)
  expect(creates[0]).toMatchObject({
    agent: "build",
    model: { providerID: "opencode", id: "big-pickle" },
    location: { directory },
  })
  expect(prompts[0]).toMatchObject({
    agent: "build",
    model: { providerID: "opencode", id: "big-pickle" },
    prompt: { text: "Reply exactly MOBILE_BIG_PICKLE_OK" },
  })

  expectNoSmokeErrors(errors, [], [])
})

test("mobile cold session load restores the session sidebar and closes it after selecting the active session", async ({
  page,
}) => {
  const errors = trackPageErrors(page)
  await mockOpenCodeServer(page, {
    directory,
    project: project("proj-mobile-core", directory, "Mobile Core", "purple"),
    provider: provider(),
    agents: [{ name: "build", mode: "primary" }],
    sessions: [session(directory, "proj-mobile-core")],
    pageMessages: () => ({ items: [userMessage()] }),
  })
  await configurePage(page)

  const sessionURL = `/${base64Encode(directory)}/session/${sessionID}`
  await page.goto(sessionURL)
  await expectAppVisible(page.getByText("Mobile Core", { exact: true }).first())

  const mobileNav = page.locator('[data-component="sidebar-nav-mobile"]')
  await expect(mobileNav).toHaveCount(1)
  await page.locator('[data-action="mobile-sidebar-toggle"]').click()
  await expect(mobileNav).toBeInViewport()

  const activeSession = mobileNav.locator(`a[href="${sessionURL}"]`)
  await expect(activeSession).toBeVisible()
  await activeSession.click()
  await expect(mobileNav).not.toBeInViewport()
  await expectAppVisible(page.locator('[data-component="session-composer"]'))
  await expectAppVisible(page.getByText("Mobile Core", { exact: true }).first())
  await expect(page).toHaveURL("/")

  expectNoSmokeErrors(errors, [], [])
})

const reloadViewports = [
  { width: 375, height: 812 },
  { width: 428, height: 926 },
  { width: 768, height: 1024 },
]

for (const viewport of reloadViewports) {
  test.describe(`mobile direct load and reload render a valid session title and timeline at ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } })

    test("mobile direct load and reload render a valid session title and timeline", async ({ page }) => {
      const errors = trackPageErrors(page)
      await mockOpenCodeServer(page, {
        directory,
        project: project("proj-mobile-core", directory, "Mobile Core", "purple"),
        provider: provider(),
        agents: [{ name: "build", mode: "primary" }],
        sessions: [{ ...session(directory, "proj-mobile-core"), title: "Reply MOBILE_OX_OK" }],
        pageMessages: () => ({ items: mobileReloadMessages() }),
      })
      await configurePage(page)

      await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
      await expectMobileReloadSession(page)
      await page.reload()
      await expectMobileReloadSession(page)
      if (process.env.VISUAL_QA_SCREENSHOT_DIR) {
        await page.screenshot({
          path: `${process.env.VISUAL_QA_SCREENSHOT_DIR}/mobile-valid-session-reload-${viewport.width}x${viewport.height}.png`,
          fullPage: true,
        })
      }

      expectNoSmokeErrors(errors, [], [])
    })
  })
}

test("mobile portrait exposes status and every timeline header action as a 44px touch target", async ({ page }) => {
  const errors = trackPageErrors(page)
  await mockOpenCodeServer(page, {
    directory,
    project: project("proj-mobile-core", directory, "Mobile Core", "purple"),
    provider: provider(),
    agents: [{ name: "build", mode: "primary" }],
    sessions: [session(directory, "proj-mobile-core")],
    pageMessages: () => ({ items: [userMessage()] }),
  })
  await configurePage(page)
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)

  await expectTouchTarget(page.locator('[data-action="status-popover"]').first())
  await expectTouchTarget(page.locator('[data-action="session-checkpoint-navigator"]'))
  await expectTouchTarget(page.locator('[data-action="prompt-context-view"]'))
  await expectTouchTarget(page.locator('[data-action="session-more-options"]'))

  expectNoSmokeErrors(errors, [], [])
})

test("mobile Home primary actions stay tappable and every session entry exits Home through tabs", async ({ page }) => {
  const errors = trackPageErrors(page)
  await mockOpenCodeServer(page, {
    directory,
    project: project("proj-mobile-core", directory, "Mobile Core", "purple"),
    provider: provider(),
    agents: [{ name: "build", mode: "primary" }],
    sessions: [session(directory, "proj-mobile-core")],
    pageMessages: () => ({ items: [] }),
  })
  await configurePage(page)
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)

  await expectAppVisible(page.locator('[data-component="session-composer"]'))
  await openHome(page)

  const projectRow = page.locator('[data-component="home-project-row"]').filter({ hasText: "Mobile Core" })
  const projectItem = projectRow.locator("..")
  const projectActions = projectItem.locator('[data-component="home-project-actions"]')
  await expectTouchTarget(page.locator('[data-action="home-add-project"]').first())
  await expectTouchTarget(projectRow)
  await expect(projectActions).toHaveCSS("opacity", "1")
  await expectTouchTarget(projectActions.locator('[data-action="home-project-new-session"]'))
  await expectTouchTarget(projectActions.locator('[data-action="home-project-menu"]'))
  await expectTouchTarget(page.locator('[data-action="home-settings"]'))
  await expectTouchTarget(page.locator('[data-action="home-docs"]'))
  await expectTouchTarget(page.locator('[data-action="home-help"]'))

  const searchControl = page.locator('[data-component="home-session-search-control"]')
  const searchInput = page.locator('[data-component="home-session-search"] input')
  await expectTouchTarget(searchControl)
  await expectTouchTarget(searchInput)
  await expectTouchTarget(page.locator('[data-action="home-search-open-project"]'))
  await expectTouchTarget(page.locator('[data-action="home-search-new-session"]'))
  await expectTouchTarget(page.locator('[data-action="home-new-session"]').first())
  await expectTouchTarget(page.locator('[data-component="home-session-row"]').first())

  await searchInput.fill("Mobile")
  await expectTouchTarget(page.locator('[data-action="home-search-clear"]'))
  await expectTouchTarget(page.locator('[data-component="home-session-search-row"]').first())
  await page.locator('[data-action="home-search-clear"]').tap()

  await projectActions.locator('[data-action="home-project-new-session"]').tap()
  await expectAppVisible(page.locator('[data-component="session-new-composer"]'))
  await expect(page.locator('[data-action="prompt-project"]')).toContainText("Mobile Core")

  await openHome(page)
  await page.locator('[data-component="home-session-row"]').filter({ hasText: "Mobile Core" }).first().tap()
  await expectAppVisible(page.locator('[data-component="session-composer"]'))

  await openHome(page)
  const titlebarProject = page.locator('[data-component="home-project-row"]').filter({ hasText: "Mobile Core" })
  await titlebarProject.tap()
  await expect(titlebarProject).toHaveAttribute("aria-current", "page")
  const titlebarNewSessionPrevented = await page.evaluate(() => {
    const event = new KeyboardEvent("keydown", { key: "t", ctrlKey: true, bubbles: true, cancelable: true })
    document.dispatchEvent(event)
    return event.defaultPrevented
  })
  expect(titlebarNewSessionPrevented).toBe(true)
  await expectAppVisible(page.locator('[data-component="session-new-composer"]'))

  expectNoSmokeErrors(errors, [], [])
})

test("mobile project picker keeps the bottom PU project reachable above a simulated IME", async ({ page }) => {
  const errors = trackPageErrors(page)
  const extraProjects = Array.from({ length: 24 }, (_, index) => {
    const suffix = String(index + 1).padStart(2, "0")
    const worktree = `C:/OpenCode/Project${suffix}`
    return project(`proj-${suffix}`, worktree, `Project ${suffix}`, "blue")
  })
  const projects = [
    project("proj-mobile-core", directory, "Mobile Core", "purple"),
    ...extraProjects,
    project("proj-pu", puDirectory, "PU", "green"),
  ]
  const sessions = [session(directory, "proj-mobile-core")]

  await mockOpenCodeServer(page, {
    directory,
    project: projects,
    provider: provider(),
    agents: [{ name: "build", mode: "primary" }],
    sessions,
    pageMessages: () => ({ items: [] }),
    onMoveSession: () => {
      sessions[0] = session(puDirectory, "proj-pu")
      return {
        sessionIDs: [sessionID],
        directory: puDirectory,
        projectID: "proj-pu",
        subdirectory: "",
      }
    },
  })
  await installVisualViewport(page, { width: 390, height: 300, offsetLeft: 0, offsetTop: 0 })
  await configurePage(page, {
    projects: projects.map((item) => ({
      worktree: item.worktree,
      expanded: true,
      name: item.name,
      icon: item.icon,
    })),
  })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)

  await page.locator('[data-action="prompt-project"]').tap()
  const picker = page.locator('[data-component="composer-project-picker"]')
  const items = picker.locator('[data-component="composer-project-items"]')
  const puProject = picker.locator('[data-component="composer-picker-item"][data-label="PU"]')
  await expectAppVisible(picker)
  await expect.poll(() => items.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
  const initial = await Promise.all([
    picker.evaluate((element) => element.getBoundingClientRect().height),
    items.evaluate((element) => element.getBoundingClientRect().bottom),
    puProject.evaluate((element) => element.getBoundingClientRect().top),
  ])
  expect(initial[0]).toBeLessThanOrEqual(285)
  expect(initial[2]).toBeGreaterThanOrEqual(initial[1])

  await items.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await expectTouchTarget(puProject)
  await puProject.tap()
  await expect(page.locator('[data-action="prompt-project"]')).toContainText("PU")

  expectNoSmokeErrors(errors, [], [])
})

test.describe("coarse tablet touch contract", () => {
  test.use({
    viewport: { width: 768, height: 1024 },
    hasTouch: true,
    isMobile: true,
  })

  test("keeps Home and multi-server actions at 44px without enabling the mobile dock layout", async ({ page }) => {
    const errors = trackPageErrors(page)
    await mockOpenCodeServer(page, {
      port: "4096",
      directory,
      project: project("proj-mobile-core", directory, "Mobile Core", "purple"),
      provider: provider(),
      agents: [{ name: "build", mode: "primary" }],
      sessions: [session(directory, "proj-mobile-core")],
      pageMessages: () => ({ items: [] }),
    })
    await mockOpenCodeServer(page, {
      port: "4097",
      directory: remoteDirectory,
      project: project("proj-remote", remoteDirectory, "Remote Tablet", "blue"),
      provider: provider(),
      agents: [{ name: "build", mode: "primary" }],
      sessions: [session(remoteDirectory, "proj-remote")],
      pageMessages: () => ({ items: [] }),
    })
    await configurePage(page, {
      servers: [
        {
          type: "http",
          http: { url: secondaryServer },
          displayName: "Secondary",
        },
      ],
      projectsByServer: {
        [secondaryServer]: [
          { worktree: remoteDirectory, expanded: true, name: "Remote Tablet", icon: { color: "blue" } },
        ],
      },
      lastProjectByServer: { [secondaryServer]: remoteDirectory },
    })
    await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)

    expect(
      await page.evaluate(() => ({
        coarse: matchMedia("(pointer: coarse)").matches,
        mobileDock: matchMedia("(max-width: 767px), (pointer: coarse) and (max-height: 600px)").matches,
      })),
    ).toEqual({ coarse: true, mobileDock: false })

    const composer = page.locator('[data-component="session-composer"]')
    await expectAppVisible(composer)
    for (const action of [
      "prompt-attach",
      "prompt-agent",
      "prompt-model",
      "prompt-model-variant",
      "prompt-access-control",
      "prompt-context-compact",
      "prompt-submit",
    ]) {
      await expectTouchTarget(composer.locator(`[data-action="${action}"]`))
    }

    const homeButton = page.getByRole("button", { name: "Home", exact: true })
    await expectTouchTarget(homeButton)
    await openHome(page)

    const serverItems = page.locator('[data-component="home-server-item"]')
    await expect(serverItems).toHaveCount(2)
    for (const item of await serverItems.all()) {
      const row = item.locator('[data-component="home-server-row"]')
      const actions = item.locator('[data-component="home-server-actions"]')
      await expect(row).toBeEnabled()
      await expectTouchTarget(row)
      await expect(actions).toHaveCSS("opacity", "1")
      const buttons = actions.locator("button")
      await expect(buttons).toHaveCount(2)
      for (const button of await buttons.all()) await expectTouchTarget(button)
    }

    await expectTouchTarget(page.locator('[data-action="home-settings"]'))
    await expectTouchTarget(page.locator('[data-action="home-docs"]'))
    await expectTouchTarget(page.locator('[data-action="home-help"]'))
    await expectTouchTarget(page.locator('[data-component="home-session-search-control"]'))
    await expectTouchTarget(page.locator('[data-action="home-search-open-project"]'))
    await expectTouchTarget(page.locator('[data-action="home-search-new-session"]'))

    const remoteProject = page.locator('[data-component="home-project-row"]').filter({ hasText: "Remote Tablet" })
    const remoteNewSession = remoteProject
      .locator("..")
      .locator('[data-component="home-project-actions"] [data-action="home-project-new-session"]')
    await expectTouchTarget(remoteProject)
    await expectTouchTarget(remoteNewSession)
    await remoteNewSession.tap()
    await expectAppVisible(page.locator('[data-component="session-new-composer"]'))
    await expect(page.locator('[data-action="prompt-project"]')).toContainText("Remote Tablet")

    expectNoSmokeErrors(errors, [], [])
  })
})

async function expectTouchTarget(locator: Locator) {
  await expectAppVisible(locator)
  await expect
    .poll(() =>
      locator.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        return Math.min(rect.width, rect.height)
      }),
    )
    .toBeGreaterThanOrEqual(44)
  const geometry = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const x = Math.min(window.innerWidth - 1, Math.max(0, rect.left + rect.width / 2))
    const y = Math.min(window.innerHeight - 1, Math.max(0, rect.top + rect.height / 2))
    const top = document.elementFromPoint(x, y)
    return {
      width: rect.width,
      height: rect.height,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      topmost: !!top && (top === element || element.contains(top)),
    }
  })
  expect(geometry.width).toBeGreaterThanOrEqual(44)
  expect(geometry.height).toBeGreaterThanOrEqual(44)
  expect(geometry.left).toBeGreaterThanOrEqual(-1)
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth + 1)
  expect(geometry.top).toBeGreaterThanOrEqual(-1)
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight + 1)
  expect(geometry.topmost).toBe(true)
}

async function runAppCommand(page: Page, command: string) {
  await page.evaluate(async (id) => {
    const bridge = (
      window as Window & {
        __OPENCODE__?: {
          desktopTesting?: {
            action(value: { type: "app.command"; command: string }): Promise<unknown>
          }
        }
      }
    ).__OPENCODE__?.desktopTesting
    if (!bridge) throw new Error("Desktop testing bridge is unavailable")
    await bridge.action({ type: "app.command", command: id })
  }, command)
}

async function openHome(page: Page) {
  const projectRow = page.locator('[data-component="home-project-row"]').first()
  await expect
    .poll(
      async () => {
        await runAppCommand(page, "home.open")
        return {
          visible: await projectRow.isVisible(),
          status: await page.evaluate(async () => {
            const bridge = (
              window as Window & {
                __OPENCODE__?: {
                  desktopTesting?: {
                    action(value: { type: "app.status" }): Promise<unknown>
                  }
                }
              }
            ).__OPENCODE__?.desktopTesting
            if (!bridge) return undefined
            return bridge.action({ type: "app.status" })
          }),
        }
      },
      { timeout: 30_000 },
    )
    .toMatchObject({ visible: true })
  await expectAppVisible(projectRow)
  await expect(page).toHaveURL(/\/$/)
}

async function installVisualViewport(
  page: Page,
  bounds: { width: number; height: number; offsetLeft: number; offsetTop: number },
) {
  await page.addInitScript((next) => {
    const viewport = window.visualViewport
    if (!viewport) return
    for (const [key, value] of Object.entries(next)) {
      Object.defineProperty(viewport, key, { configurable: true, get: () => value })
    }
  }, bounds)
}

async function configurePage(
  page: Page,
  options: {
    projects?: Array<{
      worktree: string
      expanded: boolean
      name?: string
      icon?: { color: string }
    }>
    servers?: Array<{
      type: "http"
      http: { url: string }
      displayName?: string
    }>
    projectsByServer?: Record<
      string,
      Array<{
        worktree: string
        expanded: boolean
        name?: string
        icon?: { color: string }
      }>
    >
    lastProjectByServer?: Record<string, string>
  } = {},
) {
  const projects = options.projects ?? [
    { worktree: directory, expanded: true, name: "Mobile Core", icon: { color: "purple" } },
    { worktree: puDirectory, expanded: true, name: "PU", icon: { color: "green" } },
  ]
  await page.addInitScript(
    ({ directory, encoded, lastProjectByServer, projects, projectsByServer, server, servers }) => {
      localStorage.clear()
      localStorage.setItem(
        "settings.v3",
        JSON.stringify({ general: { showCustomAgents: true, showStatus: true } }),
      )
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: {
            local: projects,
            ...projectsByServer,
          },
          lastProject: { local: directory, ...lastProjectByServer },
          list: servers,
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([
          {
            type: "session",
            server,
            dirBase64: encoded,
            sessionId: "ses_mobile_core",
            createdEmpty: true,
          },
        ]),
      )
    },
    {
      directory,
      encoded: base64Encode(directory),
      lastProjectByServer: options.lastProjectByServer ?? {},
      projects,
      projectsByServer: options.projectsByServer ?? {},
      server,
      servers: options.servers ?? [],
    },
  )
}

function session(worktree: string, projectID: string) {
  return {
    id: sessionID,
    slug: "mobile-core",
    projectID,
    directory: worktree,
    title: "Mobile Core",
    version: "dev",
    time: { created: 1_700_000_000_000, updated: 1_700_000_000_100 },
  }
}

function project(id: string, worktree: string, name: string, color: string) {
  return {
    id,
    worktree,
    vcs: "git",
    name,
    icon: { color },
    time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
    sandboxes: [],
  }
}

function provider() {
  return {
    all: [
      {
        id: "openai",
        name: "OpenAI",
        models: {
          "base-model": {
            id: "base-model",
            name: "Base Model",
            limit: { context: 200_000 },
            variants: { high: {} },
          },
          "mobile-model": {
            id: "mobile-model",
            name: "Mobile Model",
            limit: { context: 200_000 },
          },
        },
      },
    ],
    connected: ["openai"],
    default: { providerID: "openai", modelID: "base-model" },
  }
}

function userMessage() {
  const messageID = "msg_mobile_core_user"
  return {
    info: {
      id: messageID,
      sessionID,
      role: "user",
      time: { created: 1_700_000_000_050 },
      summary: { diffs: [] },
      agent: "build",
      model: { providerID: "openai", modelID: "base-model" },
    },
    parts: [{ id: "prt_mobile_core_user", sessionID, messageID, type: "text", text: "Mobile checkpoint" }],
  }
}

async function expectMobileReloadSession(page: Page) {
  await expectAppVisible(page.getByRole("heading", { name: "Reply MOBILE_OX_OK" }))
  for (const text of ["Reply with the mobile smoke token", "MOBILE_OX_OK", "Mobile reload confirmation"]) {
    await expectAppVisible(page.getByText(text, { exact: true }).first())
  }
}

function mobileReloadMessages() {
  return [
    {
      info: {
        id: "msg_mobile_reload_user_1",
        sessionID,
        role: "user",
        time: { created: 1_700_000_000_010 },
        summary: { diffs: [] },
        agent: "build",
        model: { providerID: "openai", modelID: "base-model" },
      },
      parts: [
        {
          id: "prt_mobile_reload_user_1",
          sessionID,
          messageID: "msg_mobile_reload_user_1",
          type: "text",
          text: "Reply with the mobile smoke token",
        },
      ],
    },
    {
      info: {
        id: "msg_mobile_reload_assistant",
        sessionID,
        role: "assistant",
        time: { created: 1_700_000_000_020, completed: 1_700_000_000_030 },
        parentID: "msg_mobile_reload_user_1",
        modelID: "base-model",
        providerID: "openai",
        mode: "build",
        agent: "build",
        path: { cwd: directory, root: directory },
        cost: 0,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
      },
      parts: [
        {
          id: "prt_mobile_reload_assistant",
          sessionID,
          messageID: "msg_mobile_reload_assistant",
          type: "text",
          text: "MOBILE_OX_OK",
        },
      ],
    },
    {
      info: {
        id: "msg_mobile_reload_user_2",
        sessionID,
        role: "user",
        time: { created: 1_700_000_000_040 },
        summary: { diffs: [] },
        agent: "build",
        model: { providerID: "openai", modelID: "base-model" },
      },
      parts: [
        {
          id: "prt_mobile_reload_user_2",
          sessionID,
          messageID: "msg_mobile_reload_user_2",
          type: "text",
          text: "Mobile reload confirmation",
        },
      ],
    },
  ]
}
