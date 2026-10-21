import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"
import { expectNoSmokeErrors, trackPageErrors } from "../utils/errors"

const directory = "C:/OpenCode/NewSessionShortcut"
const projectID = "proj_new_session_shortcut"
const sessionID = "ses_new_session_shortcut"
const secondSessionID = "ses_new_session_shortcut_second"
const newSessionID = "ses_new_session_shortcut_new"
const server = "http://127.0.0.1:4096"

test("cold direct session route does not create a fallback project session", async ({ page }) => {
  const created: unknown[] = []
  await mockOpenCodeServer(page, {
    directory,
    project: project(),
    provider: provider(),
    sessions: [session()],
    pageMessages: () => ({ items: [] }),
    onSessionCreate: (body) => {
      created.push(body)
      return newSession(newSessionID)
    },
  })
  await configurePage(page, [])

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)

  await expectAppVisible(page.getByText("Shortcut source", { exact: true }).first())
  await expect(page).toHaveURL(new RegExp(`/($|\\?)`))
  if (process.env.VISUAL_QA_SCREENSHOT_DIR) {
    await page.screenshot({
      path: `${process.env.VISUAL_QA_SCREENSHOT_DIR}/mobile-cold-direct-session.png`,
      fullPage: true,
    })
  }
  expect(created).toEqual([])
})

test("cold mobile root opens and reloads a draft without persisting an empty session", async ({ page }) => {
  const errors = trackPageErrors(page)
  const created: unknown[] = []
  await mockOpenCodeServer(page, {
    directory,
    project: project(),
    provider: provider(),
    sessions: [session()],
    pageMessages: () => ({ items: [] }),
    onSessionCreate: (body) => {
      created.push(body)
      return newSession(newSessionID)
    },
  })
  await configurePage(page, [])

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")
  await expectAppVisible(page.getByRole("button", { name: "New session" }).first())
  await expectAppVisible(page.locator('[data-component="session-new-composer"]'))
  await expect.poll(() => storedDraftCount(page)).toBe(1)

  await page.reload()
  await expectAppVisible(page.getByRole("button", { name: "New session" }).first())
  await expectAppVisible(page.locator('[data-component="session-new-composer"]'))
  await expect.poll(() => storedDraftCount(page)).toBe(1)
  if (process.env.VISUAL_QA_SCREENSHOT_DIR) {
    await page.screenshot({
      path: `${process.env.VISUAL_QA_SCREENSHOT_DIR}/mobile-root-draft-reload.png`,
      fullPage: true,
    })
  }
  expect(created).toEqual([])
  expectNoSmokeErrors(errors, [], [])
})

test("truly cold mobile root creates no server session before the first prompt and reload keeps the draft local", async ({
  page,
}) => {
  const errors = trackPageErrors(page)
  const { creates, prompts } = trackSessionMaterialization(page)
  const sessions: ({ id: string } & Record<string, unknown>)[] = [session()]
  await mockOpenCodeServer(page, {
    directory,
    project: project(),
    provider: provider(),
    sessions,
    pageMessages: () => ({ items: [] }),
    // Truly cold browser: no seeded localStorage projects/tabs/recent state.
    // The only project signal is the server-side shared app state, exactly like
    // a fresh profile against a long-lived server.
    appState: (key) =>
      key === "server-projects.v1"
        ? { projects: [{ worktree: directory, expanded: true }], lastProject: directory }
        : {},
    onSessionCreate: () => {
      const next = newSession("ses_cold_mobile_submit")
      sessions.push(next)
      return next
    },
  })
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({}))
  })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")

  await expectAppVisible(page.getByRole("button", { name: "New session" }).first())
  await expectAppVisible(page.locator('[data-component="session-new-composer"]'))
  await expect.poll(() => storedDraftCount(page)).toBe(1)
  expect(creates).toEqual([])

  await page.reload()
  await expectAppVisible(page.getByRole("button", { name: "New session" }).first())
  await expectAppVisible(page.locator('[data-component="session-new-composer"]'))
  await expect.poll(() => storedDraftCount(page)).toBe(1)
  expect(creates).toEqual([])

  const input = page.locator('[data-component="session-new-composer"] [data-component="prompt-input"]')
  await input.click()
  await page.keyboard.type("First truly cold prompt")
  await page.keyboard.press("Enter")

  await expect.poll(() => creates.length).toBe(1)
  await expect.poll(() => prompts.length).toBe(1)
  expect(creates[0]?.path).toBe("/api/session")
  expect(prompts[0]).toMatchObject({ prompt: { text: "First truly cold prompt" } })

  expectNoSmokeErrors(errors, [], [])
})

test("truly cold desktop root creates no server session before the first prompt", async ({ page }) => {
  const errors = trackPageErrors(page)
  const { creates, prompts } = trackSessionMaterialization(page)
  const sessions: ({ id: string } & Record<string, unknown>)[] = [session()]
  await mockOpenCodeServer(page, {
    directory,
    project: project(),
    provider: provider(),
    sessions,
    pageMessages: () => ({ items: [] }),
    appState: (key) =>
      key === "server-projects.v1"
        ? { projects: [{ worktree: directory, expanded: true }], lastProject: directory }
        : {},
    onSessionCreate: () => {
      const next = newSession("ses_cold_desktop_submit")
      sessions.push(next)
      return next
    },
  })
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({}))
  })

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto("/")

  await expectAppVisible(page.locator('[data-dock-area="middle"]').getByRole("tab", { name: "New session" }))
  await expectAppVisible(page.locator('[data-dock-area="middle"]').getByRole("textbox", { name: /Ask anything/ }))
  await expect(page.locator('[data-action="prompt-project"]').first()).toContainText("new-session-shortcut")
  await expect.poll(() => storedDraftCount(page)).toBe(1)
  expect(creates).toEqual([])

  const input = page.locator('[data-dock-area="middle"]').getByRole("textbox", { name: /Ask anything/ })
  await input.click()
  await page.keyboard.type("Desktop cold start prompt")
  await page.keyboard.press("Enter")

  await expect.poll(() => creates.length).toBe(1)
  await expect.poll(() => prompts.length).toBe(1)
  expect(creates[0]?.path).toBe("/api/session")
  expect(prompts[0]).toMatchObject({ prompt: { text: "Desktop cold start prompt" } })

  expectNoSmokeErrors(errors, [], [])
})

test("ctrl+t opens a lazy draft in the middle dock", async ({ page }) => {
  const created: unknown[] = []
  await mockOpenCodeServer(page, {
    directory,
    project: project(),
    provider: provider(),
    sessions: [session()],
    pageMessages: () => ({ items: [] }),
    onSessionCreate: (body) => {
      created.push(body)
      return newSession(newSessionID)
    },
  })
  await configurePage(page)

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto("/")
  await expectAppVisible(page.locator('[data-dock-area="middle"]').getByRole("tab", { name: "Shortcut source" }))
  const home = page.locator('header [data-action="home-toggle"]')
  await expectAppVisible(home)
  await expect(home.locator("use")).toHaveAttribute("href", "#opencode-v2-icon-grid-plus")
  if (process.env.PLAYWRIGHT_VIDEO === "on") await page.waitForTimeout(750)

  const prevented = await page.evaluate(() => {
    const event = new KeyboardEvent("keydown", { key: "t", ctrlKey: true, bubbles: true, cancelable: true })
    document.dispatchEvent(event)
    return event.defaultPrevented
  })

  expect(prevented).toBe(true)
  await expect(page).toHaveURL(new RegExp(`/($|\\?)`))
  await expectAppVisible(page.locator('[data-dock-area="middle"]').getByRole("tab", { name: "New session" }))
  await expectAppVisible(page.locator('[data-dock-area="middle"]').getByRole("textbox", { name: /Ask anything/ }))
  await expect.poll(() => storedDraftCount(page)).toBe(1)
  expect(created).toEqual([])
  if (process.env.PLAYWRIGHT_VIDEO === "on") await page.waitForTimeout(1_000)
  if (process.env.VISUAL_QA_SCREENSHOT_DIR) {
    await page.screenshot({
      path: `${process.env.VISUAL_QA_SCREENSHOT_DIR}/desktop-ctrl-t-new-session.png`,
      fullPage: true,
    })
  }
})

test("mobile titlebar plus opens the same lazy draft as ctrl+t", async ({ page }) => {
  const errors = trackPageErrors(page)
  const failedResponses: string[] = []
  page.on("requestfailed", (request) => failedResponses.push(`${request.method()} ${request.url()}`))
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`)
  })
  const created: unknown[] = []
  await mockOpenCodeServer(page, {
    directory,
    project: project(),
    provider: provider(),
    sessions: [session()],
    pageMessages: () => ({ items: [] }),
    onSessionCreate: (body) => {
      created.push(body)
      return newSession(newSessionID)
    },
  })
  await configurePage(page)

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)

  const button = page.locator('header [data-action="session-new"]')
  await expectAppVisible(button)
  await expect(button).toHaveAttribute("aria-label", "New session")
  await expect(button.locator("use")).toHaveAttribute("href", "#opencode-v2-icon-plus")
  if (process.env.PLAYWRIGHT_VIDEO === "on") await page.waitForTimeout(750)
  await button.click()

  await expectAppVisible(page.locator('[data-component="prompt-input"]'))
  await expect.poll(() => storedDraftCount(page)).toBe(1)
  expect(created).toEqual([])
  if (process.env.PLAYWRIGHT_VIDEO === "on") await page.waitForTimeout(1_000)
  if (process.env.VISUAL_QA_SCREENSHOT_DIR) {
    await page.screenshot({
      path: `${process.env.VISUAL_QA_SCREENSHOT_DIR}/mobile-new-session-plus.png`,
      fullPage: true,
    })
  }
  expect(failedResponses).toEqual([])
  expectNoSmokeErrors(errors, [], [])
})

test("project picker remains available when its persisted project entry is missing", async ({ page }) => {
  const errors = trackPageErrors(page)
  const sessions: ({ id: string } & Record<string, unknown>)[] = [session()]
  await mockOpenCodeServer(page, {
    directory,
    project: project(),
    provider: provider(),
    sessions,
    pageMessages: () => ({ items: [] }),
    onSessionCreate: () => {
      const next = newSession(newSessionID)
      sessions.push(next)
      return next
    },
  })
  await page.route("**/*", async (route) => {
    if (new URL(route.request().url()).pathname !== "/project") return route.fallback()
    await new Promise((resolve) => setTimeout(resolve, 10_000))
    await route.fallback()
  })
  await configurePage(page, [sessionID], false)

  await page.goto("/")

  const projectPicker = page.locator('[data-dock-area="middle"] [data-action="prompt-project"]')
  await expect(projectPicker).toBeVisible({ timeout: 3_000 })
  await expect(projectPicker).toContainText("NewSessionShortcut")
  await projectPicker.click()
  await expectAppVisible(page.getByPlaceholder("Search projects"))
  await expect(page.locator('[data-component="composer-picker-item"][data-selected]')).toHaveCount(1)
  await page.keyboard.press("Escape")

  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "t", ctrlKey: true, bubbles: true, cancelable: true }))
  })

  await expectAppVisible(page.locator('[data-dock-area="middle"]').getByRole("tab", { name: "New session" }))
  await expectAppVisible(projectPicker)
  await expect(projectPicker).toContainText("NewSessionShortcut")
  await projectPicker.click()
  await expectAppVisible(page.getByPlaceholder("Search projects"))
  await expect(page.locator('[data-component="composer-picker-item"][data-selected]')).toHaveCount(1)

  if (process.env.VISUAL_QA_SCREENSHOT_DIR) {
    await page.screenshot({
      path: `${process.env.VISUAL_QA_SCREENSHOT_DIR}/project-picker-new-session-desktop.png`,
      fullPage: true,
    })
    await page.keyboard.press("Escape")
    await page.setViewportSize({ width: 390, height: 844 })
    await expectAppVisible(page.locator('[data-action="prompt-project"]').last())
    await page.screenshot({
      path: `${process.env.VISUAL_QA_SCREENSHOT_DIR}/project-picker-new-session-mobile.png`,
      fullPage: true,
    })
  }

  expectNoSmokeErrors(errors, [], [])
})

test("new session tabs restart on build while agent switches use configured defaults", async ({ page }) => {
  const sessions: ({ id: string } & Record<string, unknown>)[] = [session()]
  await mockOpenCodeServer(page, {
    directory,
    project: project(),
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "thinking-model": {
              id: "thinking-model",
              name: "Thinking Model",
              limit: { context: 200_000 },
              variants: { high: {}, max: {} },
            },
            "agent-model": {
              id: "agent-model",
              name: "Agent Model",
              limit: { context: 200_000 },
              variants: { high: {}, max: {} },
            },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "agent-model" },
    },
    agents: [
      { name: "build", mode: "primary" },
      {
        name: "plan",
        mode: "primary",
        model: { providerID: "opencode", modelID: "agent-model" },
        variant: "high",
      },
    ],
    sessions,
    pageMessages: () => ({ items: [] }),
    onSessionCreate: () => {
      const next = newSession(newSessionID)
      sessions.push(next)
      return next
    },
  })
  await configurePage(page)
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { showCustomAgents: true } }))
  })

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)

  const composer = page.locator('[data-dock-area="middle"] [data-component="session-composer"]')
  const agent = composer.locator('[data-action="prompt-agent"]')
  const model = composer.locator('[data-action="prompt-model"]')
  const variant = composer.locator('[data-action="prompt-model-variant"]')
  await expectAppVisible(composer)

  await model.click()
  await page
    .getByRole("dialog", { name: "Select model" })
    .getByRole("button", { name: /^Thinking Model/ })
    .click()
  // The variant control is hover-revealed inside the composer group.
  await composer.hover()
  await variant.click()
  await page.getByRole("option", { name: "max", exact: true }).click()
  await agent.click()
  await page.getByRole("option", { name: "plan", exact: true }).click()
  await expect(agent).toContainText("plan")
  await expect(model).toContainText("Agent Model")
  await expect(variant).toContainText("high")

  await expect
    .poll(() =>
      page.evaluate(() => {
        return JSON.parse(localStorage.getItem("opencode.global.dat:model") ?? "{}").selection
      }),
    )
    .toEqual({ model: { providerID: "opencode", modelID: "thinking-model" }, variant: "max" })

  await page.reload()
  await expectAppVisible(page.locator('[data-dock-area="middle"] [data-component="session-composer"]'))

  await page.evaluate(() => {
    const event = new KeyboardEvent("keydown", { key: "t", ctrlKey: true, bubbles: true, cancelable: true })
    document.dispatchEvent(event)
  })

  await expectAppVisible(page.locator('[data-dock-area="middle"]').getByRole("tab", { name: "New session" }))
  const nextComposer = page.locator('[data-dock-area="middle"] [data-component="session-new-composer"]')
  await expectAppVisible(nextComposer)
  // A new tab restarts on the default agent. Build has no configured model here,
  // so the last visible selection carries over instead of a plan default.
  await expect(nextComposer.locator('[data-action="prompt-agent"]')).toContainText("build")
  await expect(nextComposer.locator('[data-action="prompt-model"]')).toContainText("Thinking Model")
  await expect(nextComposer.locator('[data-action="prompt-model-variant"]')).toContainText("max")
  await nextComposer.locator('[data-action="prompt-model"]').click()
  const picker = page.getByRole("dialog", { name: "Select model" })
  await expectAppVisible(picker.getByRole("button", { name: /^Thinking Model/ }))
  await expectAppVisible(picker.getByRole("button", { name: /^Agent Model/ }))
})

test("built-in plan and build agents use the configured default chain across chats", async ({ page }) => {
  const errors = trackPageErrors(page)
  await mockOpenCodeServer(page, {
    directory,
    project: project(),
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "manual-model": { id: "manual-model", name: "Manual Model", limit: { context: 200_000 } },
            "chain-primary": { id: "chain-primary", name: "Chain Primary", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "manual-model" },
    },
    agents: [
      { name: "build", mode: "primary" },
      { name: "plan", mode: "primary" },
    ],
    sessions: [session()],
    pageMessages: () => ({ items: [] }),
    globalConfig: () => ({
      model_chains: [
        {
          id: "built-in-default",
          name: "Built-in Default",
          steps: [{ providerID: "opencode", modelID: "chain-primary" }],
        },
      ],
      default_model_chain: "built-in-default",
    }),
  })
  await configurePage(page)
  await page.addInitScript(() => {
    localStorage.setItem(
      "opencode.global.dat:model",
      JSON.stringify({
        user: [],
        recent: [],
        variant: {},
        selection: { model: { providerID: "opencode", modelID: "manual-model" }, variant: null },
        chains: [
          {
            id: "built-in-default",
            name: "Built-in Default",
            steps: [{ providerID: "opencode", modelID: "chain-primary" }],
          },
        ],
        defaultChainID: "built-in-default",
      }),
    )
  })

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectAppVisible(page.locator('[data-component="session-composer"]'))
  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "t", ctrlKey: true, bubbles: true, cancelable: true }))
  })
  await expectAppVisible(page.locator('[data-dock-area="middle"]').getByRole("tab", { name: "New session" }))
  const composer = page.locator('[data-component="session-new-composer"]')
  await expectAppVisible(composer)
  const model = composer.locator('[data-action="prompt-model"]')
  const agent = composer.locator('[data-action="prompt-agent"]')
  await expect(model).toContainText("Built-in Default")

  await agent.click()
  await page.getByRole("option", { name: "plan", exact: true }).click()
  await expect(model).toContainText("Built-in Default")

  await agent.click()
  await page.getByRole("option", { name: "build", exact: true }).click()
  await expect(model).toContainText("Built-in Default")

  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "t", ctrlKey: true, bubbles: true, cancelable: true }))
  })
  const nextComposer = page.locator('[data-component="session-new-composer"]').last()
  await expectAppVisible(nextComposer)
  await expect(nextComposer.locator('[data-action="prompt-agent"]')).toContainText("build")
  await expect(nextComposer.locator('[data-action="prompt-model"]')).toContainText("Built-in Default")

  expectNoSmokeErrors(errors, [], [])
})

test("spawn-new-agent skill prompt reaches the current session", async ({ page }) => {
  const errors = trackPageErrors(page)
  const sessions: ({ id: string } & Record<string, unknown>)[] = [session()]
  const promptRequests: Array<{ sessionID: string; body: Record<string, unknown> }> = []
  await mockOpenCodeServer(page, {
    directory,
    project: project(),
    provider: provider(),
    sessions,
    commands: [{ name: "spawn-new-agent", description: "Spawn a new agent session", source: "skill" }],
    pageMessages: () => ({ items: [] }),
    onSessionCreate: () => {
      const next = newSession(newSessionID)
      sessions.push(next)
      return next
    },
    onSessionPrompt: (input) => {
      promptRequests.push({ sessionID: input.sessionID, body: input.body as Record<string, unknown> })
      return {}
    },
  })
  await configurePage(page)

  await page.setViewportSize({ width: 1280, height: 720 })
  const commandResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/command")
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expect(commandResponse.then((response) => response.json())).resolves.toMatchObject({
    data: [{ name: "spawn-new-agent", source: "skill" }],
  })
  const composer = page.locator('[data-dock-area="middle"] [data-component="session-composer"]')
  await expectAppVisible(composer)
  const input = composer.locator('[data-component="prompt-input"]')

  await input.click()
  await page.keyboard.type("/spawn-new-age")
  await expectAppVisible(page.locator('[data-slash-id="custom.spawn-new-agent"]'))
  await page.keyboard.press("Enter")
  await expect(input).toContainText("/spawn-new-agent")
  await input.click()
  await page.keyboard.press("Control+A")
  await page.keyboard.type("/spawn-new-agent run the spawned-agent smoke test")
  await composer.locator('[data-action="prompt-submit"]').click()

  await expect.poll(() => promptRequests.length).toBe(1)
  expect(promptRequests[0]?.sessionID).toBe(sessionID)
  expect(promptRequests[0]?.body).toMatchObject({
    prompt: { text: "/spawn-new-agent run the spawned-agent smoke test" },
  })
  const currentTab = page
    .locator(`[data-dock-area="middle"] [data-dock-tab][data-session-id="${sessionID}"]`)
    .getByRole("tab")
  await expect(currentTab).toHaveAttribute("aria-selected", "true")
  await expect
    .poll(() =>
      page.evaluate((id) => {
        const tabs = JSON.parse(localStorage.getItem("opencode.global.dat:tabs") ?? "[]") as Array<{
          type?: string
          sessionId?: string
          createdEmpty?: boolean
        }>
        return tabs.some((tab) => tab.type === "session" && tab.sessionId === id && tab.createdEmpty === false)
      }, newSessionID),
    )
    .toBe(false)
  expectNoSmokeErrors(errors, [], [])
})

test("legacy session routes stay in the canonical root shell", async ({ page }) => {
  await mockOpenCodeServer(page, {
    directory,
    project: project(),
    provider: provider(),
    sessions: [session()],
    pageMessages: () => ({ items: [] }),
  })
  await configurePage(page)

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(
    `/${base64Encode(directory)}/session/${sessionID}?server=${encodeURIComponent(server)}&focus=composer&prompt=kept#active-message`,
  )

  await expect(page).toHaveURL(new RegExp(`/($|\\?)`))
  await expect
    .poll(() => {
      const url = new URL(page.url())
      return {
        dir: url.searchParams.get("dir"),
        focus: url.searchParams.get("focus"),
        hash: url.hash,
        prompt: url.searchParams.get("prompt"),
        server: url.searchParams.get("server"),
        session: url.searchParams.get("session"),
      }
    })
    .toEqual({ dir: null, focus: "composer", hash: "#active-message", prompt: "kept", server: null, session: null })
  await expectAppVisible(page.locator('[data-component="session-dock-shell"][data-layout="desktop-grid"]'))
  await expectAppVisible(page.locator('[data-dock-area="middle"]').getByRole("tab", { name: "Shortcut source" }))

  await page.evaluate(
    (href) => {
      history.pushState({}, "", href)
      window.dispatchEvent(new PopStateEvent("popstate"))
    },
    `/${base64Encode(directory)}/session/${sessionID}`,
  )

  await expect(page).toHaveURL(new RegExp(`/($|\\?)`))
  await expectAppVisible(page.locator('[data-dock-area="middle"]').getByRole("tab", { name: "Shortcut source" }))
  await expect
    .poll(() =>
      page.evaluate((id) => {
        const tabs = JSON.parse(localStorage.getItem("opencode.global.dat:tabs") ?? "[]") as Array<{
          type?: string
          sessionId?: string
        }>
        return tabs.filter((tab) => tab.type === "session" && tab.sessionId === id).length
      }, sessionID),
    )
    .toBe(1)

  await page.goto("/new-session?draftId=missing-draft")

  await expect(page).not.toHaveURL(/draftId=missing-draft/)
  await expectAppVisible(page.locator('[data-component="session-dock-shell"][data-layout="desktop-grid"]'))
  await expectAppVisible(page.locator('[data-dock-area="middle"]').getByRole("tab", { name: "Shortcut source" }))
  await expect
    .poll(() =>
      page.evaluate(() => {
        const tabs = JSON.parse(localStorage.getItem("opencode.global.dat:tabs") ?? "[]") as Array<{ type?: string }>
        return tabs.some((tab) => tab.type === "draft")
      }),
    )
    .toBe(false)
})

test("legacy directory session route creates a draft for that project", async ({ page }) => {
  await mockOpenCodeServer(page, {
    directory,
    project: project(),
    provider: provider(),
    sessions: [session()],
    pageMessages: () => ({ items: [] }),
  })
  await configurePage(page)

  await page.goto(`/${base64Encode(directory)}/session?prompt=legacy%20draft`)

  const composer = page.getByRole("textbox", { name: /Ask anything/ })
  await expectAppVisible(composer)
  await expect(composer).toContainText("legacy draft")
  await expect(page.getByRole("heading", { name: "Shortcut source" })).toHaveCount(0)
  await expect.poll(() => storedDraftCount(page)).toBe(1)

  await page.goto(`/${base64Encode(directory)}/session?prompt=legacy%20draft`)
  await expectAppVisible(composer)
  await expect(composer).toContainText("legacy draft")
  await expect.poll(() => storedDraftCount(page)).toBe(1)
})

test("closing the last draft tab recovers without persisting an empty session", async ({ page }) => {
  const sessions: ({ id: string } & Record<string, unknown>)[] = []
  let count = 0
  await mockOpenCodeServer(page, {
    directory,
    project: project(),
    provider: provider(),
    sessions,
    pageMessages: () => ({ items: [] }),
    onSessionCreate: () => {
      count += 1
      const next = newSession(`ses_close_empty_${count}`)
      sessions.push(next)
      return next
    },
  })
  await page.addInitScript(
    ({ directory }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
    },
    { directory },
  )

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto("/")
  await expectAppVisible(page.locator('[data-dock-area="middle"]').getByRole("textbox", { name: /Ask anything/ }))

  await page.locator('[data-dock-area="middle"] [data-dock-tab]').getByLabel("Close New session").click()

  await expectAppVisible(page.locator('[data-component="session-dock-shell"][data-layout="desktop-grid"]'))
  await expectAppVisible(page.locator('[data-dock-area="middle"]').getByRole("tab", { name: "New session" }))
  await expectAppVisible(page.locator('[data-dock-area="middle"]').getByRole("textbox", { name: /Ask anything/ }))
  await expect.poll(() => storedDraftCount(page)).toBe(1)
  expect(count).toBe(0)
})

test("enter in a new empty session does not focus the leftmost session tab", async ({ page }) => {
  const errors = trackPageErrors(page)
  const requests: Record<string, unknown>[] = []
  const failedResponses: string[] = []
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`)
  })
  const sessions: ({ id: string } & Record<string, unknown>)[] = [session(), secondSession()]
  await mockOpenCodeServer(page, {
    directory,
    project: project(),
    provider: provider(),
    sessions,
    pageMessages: () => ({ items: [] }),
    onSessionCreate: async () => {
      const next = newSession("ses_new_session_enter_focus")
      sessions.push(next)
      return next
    },
    onSessionPrompt: (input) => {
      requests.push(input.body as Record<string, unknown>)
      return {}
    },
  })
  await page.addInitScript(
    ({ directory, dirBase64, sessionID, server }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", server, dirBase64, sessionId: sessionID }]),
      )
    },
    { directory, dirBase64: base64Encode(directory), sessionID, server },
  )

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto("/")
  await page.evaluate(() => {
    const event = new KeyboardEvent("keydown", { key: "t", ctrlKey: true, bubbles: true, cancelable: true })
    document.dispatchEvent(event)
  })
  await expectAppVisible(page.locator('[data-dock-area="middle"]').getByRole("tab", { name: "New session" }))
  const composer = page.locator(
    '[data-dock-area="middle"] [data-component="session-composer"], [data-dock-area="middle"] [data-component="session-new-composer"]',
  )
  await expectAppVisible(composer)
  const input = composer.locator('[data-component="prompt-input"]')
  await input.click()
  await page.keyboard.type("keep the draft tab active")
  await page.keyboard.press("Enter")

  await expect.poll(() => requests.length).toBe(1)
  await expect(
    page.locator('[data-dock-area="middle"]').getByRole("tab", { name: "Shortcut source" }),
  ).not.toBeFocused()
  await expectAppVisible(page.locator('[data-dock-area="middle"] [data-component="session-composer"]'))
  if (process.env.VISUAL_QA_SCREENSHOT)
    await page.screenshot({ path: process.env.VISUAL_QA_SCREENSHOT, fullPage: true })
  expect(failedResponses).toEqual([])
  expectNoSmokeErrors(errors, [], [])
})

test("dock session tabs can be reordered with drag and drop", async ({ page }) => {
  const errors = trackPageErrors(page)
  await mockOpenCodeServer(page, {
    directory,
    project: project(),
    provider: provider(),
    sessions: [session(), secondSession()],
    pageMessages: () => ({ items: [] }),
  })
  await configurePage(page, [sessionID, secondSessionID])

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)

  const first = page.locator(`[data-dock-area="middle"] [data-dock-tab][data-session-id="${sessionID}"]`)
  const second = page.locator(`[data-dock-area="middle"] [data-dock-tab][data-session-id="${secondSessionID}"]`)
  await expectAppVisible(first)
  await expectAppVisible(second)
  await expect(first).toHaveAttribute("draggable", "true")
  const firstBox = await first.boundingBox()
  const secondBox = await second.boundingBox()
  expect(firstBox).not.toBeNull()
  expect(secondBox).not.toBeNull()
  await page.mouse.move(firstBox!.x + firstBox!.width / 2, firstBox!.y + firstBox!.height / 2)
  await page.mouse.down()
  await page.mouse.move(secondBox!.x + secondBox!.width / 2, secondBox!.y + secondBox!.height / 2, { steps: 5 })
  await page.mouse.up()

  await expect
    .poll(() =>
      page
        .locator('[data-dock-area="middle"] [data-dock-tab][data-session-id]')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-session-id"))),
    )
    .toEqual([secondSessionID, sessionID])
  if (process.env.VISUAL_QA_SCREENSHOT) await page.screenshot({ path: process.env.VISUAL_QA_SCREENSHOT })
  expectNoSmokeErrors(errors, [], [])
})

test("dock session tab menu opens repeatedly without immediate close", async ({ page }) => {
  const errors = trackPageErrors(page)
  await mockOpenCodeServer(page, {
    directory,
    project: project(),
    provider: provider(),
    sessions: [session(), secondSession()],
    pageMessages: () => ({ items: [] }),
  })
  await configurePage(page, [sessionID, secondSessionID])

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)

  const tab = page.locator(`[data-dock-area="middle"] [data-dock-tab][data-session-id="${sessionID}"]`)
  await expectAppVisible(tab)
  const menu = tab.getByRole("button", { name: "More options" })
  const rename = page.getByRole("menuitem", { name: "Rename" })

  for (const attempt of [0, 1, 2]) {
    await test.step(`open attempt ${attempt + 1}`, async () => {
      await tab.hover()
      await menu.click()
      await expectAppVisible(rename)
      await expect(page.getByRole("menuitem", { name: "Add to favorites" })).toHaveCount(1)
      if (process.env.VISUAL_QA_SCREENSHOT && attempt === 2) {
        await page.screenshot({ path: process.env.VISUAL_QA_SCREENSHOT, fullPage: true })
      }
      await page.keyboard.press("Escape")
      await expect(rename).toHaveCount(0)
    })
  }

  expectNoSmokeErrors(errors, [], [])
})

// Tracks every request that would durably materialize a session on the server:
// the legacy V1 POST /session and the V2 POST /api/session, plus durable prompt
// admissions. A cold start must record no creates until the first submit.
function trackSessionMaterialization(page: Page) {
  const creates: Array<{ path: string; body: unknown }> = []
  const prompts: unknown[] = []
  page.on("request", (request) => {
    const url = new URL(request.url())
    if (request.method() !== "POST") return
    if (url.pathname === "/session" || url.pathname === "/api/session") {
      creates.push({ path: url.pathname, body: request.postDataJSON() })
      return
    }
    if (/^\/api\/session\/[^/]+\/prompt$/.test(url.pathname)) prompts.push(request.postDataJSON())
  })
  return { creates, prompts }
}

async function configurePage(page: Page, sessionIDs = [sessionID], includeProject = true) {
  await page.addInitScript(
    ({ directory, dirBase64, sessionIDs, server, includeProject }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: includeProject ? [{ worktree: directory, expanded: true }] : [] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify(sessionIDs.map((sessionId) => ({ type: "session", server, dirBase64, sessionId }))),
      )
    },
    { directory, dirBase64: base64Encode(directory), sessionIDs, server, includeProject },
  )
}

function storedDraftCount(page: Page) {
  return page.evaluate((directory) => {
    const tabs = JSON.parse(localStorage.getItem("opencode.global.dat:tabs") ?? "[]") as Array<{
      type?: string
      directory?: string
    }>
    return tabs.filter((tab) => tab.type === "draft" && tab.directory === directory).length
  }, directory)
}

function project() {
  return {
    id: projectID,
    worktree: directory,
    vcs: "git",
    name: "new-session-shortcut",
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
        models: {
          "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
        },
      },
    ],
    connected: ["opencode"],
    default: { providerID: "opencode", modelID: "claude-opus-4-6" },
  }
}

function session() {
  return {
    id: sessionID,
    slug: sessionID,
    projectID,
    directory,
    title: "Shortcut source",
    version: "dev",
    time: { created: 1700000000000, updated: 1700000000000 },
  }
}

function secondSession() {
  return {
    id: secondSessionID,
    slug: secondSessionID,
    projectID,
    directory,
    title: "Shortcut target",
    version: "dev",
    time: { created: 1700000000001, updated: 1700000000001 },
  }
}

function newSession(id: string) {
  return {
    id,
    slug: id,
    projectID,
    directory,
    version: "dev",
    time: { created: 1700000000002, updated: 1700000000002 },
  }
}
