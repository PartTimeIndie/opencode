import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/ComposerToolbarCycle"
const projectID = "proj_composer_toolbar_cycle"
const sessionID = "ses_composer_toolbar_cycle"
const server = "http://127.0.0.1:4096"

test("arms then cycles composer plugin toolbar icons with Shift+Space and activates on Shift release", async ({ page }) => {
  const consoleErrors: string[] = []
  const failedResponses: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })
  page.on("pageerror", (error) => consoleErrors.push(error.stack ?? error.message))
  page.on("requestfailed", (request) =>
    failedResponses.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`),
  )
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`)
  })

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "composer-toolbar-cycle",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "cycle-model": { id: "cycle-model", name: "Cycle Model", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "cycle-model" },
    },
    sessions: [
      {
        id: sessionID,
        slug: "composer-toolbar-cycle",
        projectID,
        directory,
        title: "Composer toolbar cycle regression",
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await mockToolbarCyclePlugin(page)
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({}))
    localStorage.setItem(
      "opencode.global.dat:plugin-toolbar-visibility",
      JSON.stringify({
        version: 1,
        global: Object.fromEntries(["one", "two", "three", "improve", "mount"].map((id) => [`composer-toolbar-cycle/${id}`, true])),
        projects: {},
      }),
    )
  })

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  const composer = await openSessionComposer(page)
  const input = composer.locator('[data-component="prompt-input"]')
  await expectAppVisible(page.getByRole("button", { name: "Cycle One" }))
  await expectAppVisible(page.getByRole("button", { name: "Cycle Two" }))
  await expectAppVisible(page.getByRole("button", { name: "Cycle Three" }))
  await expectAppVisible(page.getByRole("button", { name: "Improve current prompt" }))
  await expectAppVisible(page.getByRole("button", { name: "Cycle Mount" }))
  await maybeScreenshot(page, "normal")
  const mountButton = page.getByRole("button", { name: "Cycle Mount" })
  await mountButton.evaluate((button) => button.setAttribute("aria-pressed", "true"))
  await expect(mountButton).toHaveCSS("outline-style", "none")
  await expect(mountButton).not.toHaveCSS("box-shadow", "none")
  await maybeScreenshot(page, "active-toggle")
  await mountButton.evaluate((button) => button.setAttribute("aria-pressed", "false"))

  await input.focus()
  await page.keyboard.down("Shift")
  await page.keyboard.press("Space")
  await expect(activeToolbarButton(page)).toHaveCount(0)
  await page.waitForTimeout(800)
  await page.keyboard.press("Space")
  await expect(activeToolbarButton(page)).toHaveCount(0)
  await page.keyboard.press("Space")
  await expect(activeToolbarButton(page)).toHaveAttribute("aria-label", "Cycle One")
  await page.waitForTimeout(3200)
  await expect(activeToolbarButton(page)).toHaveCount(0)
  await page.keyboard.up("Shift")
  await expect
    .poll(() => page.evaluate(() => (window as Window & { __toolbarCycleClicks?: string[] }).__toolbarCycleClicks ?? []))
    .toEqual([])

  await page.keyboard.down("Shift")
  await page.keyboard.press("Space")
  await expect(activeToolbarButton(page)).toHaveCount(0)
  await page.keyboard.press("Space")
  await expect(activeToolbarButton(page)).toHaveAttribute("aria-label", "Cycle One")
  await page.keyboard.press("Space")
  await expect(activeToolbarButton(page)).toHaveAttribute("aria-label", "Cycle Two")
  await page.keyboard.press("Space")
  await expect(activeToolbarButton(page)).toHaveAttribute("aria-label", "Cycle Three")
  await page.keyboard.press("Space")
  await expect(activeToolbarButton(page)).toHaveAttribute("aria-label", "Improve current prompt")
  await page.keyboard.press("Space")
  await expect(activeToolbarButton(page)).toHaveAttribute("aria-label", "Cycle Mount")
  await expect(activeToolbarButton(page)).toHaveCSS("outline-style", "none")
  await expect(activeToolbarButton(page)).not.toHaveCSS("box-shadow", "none")
  await maybeScreenshot(page, "shift-space-mount")
  await page.keyboard.press("Space")
  await expect(activeToolbarButton(page)).toHaveAttribute("aria-label", "Cycle One")
  await page.keyboard.up("Shift")

  await expect(activeToolbarButton(page)).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(() => (window as Window & { __toolbarCycleClicks?: string[] }).__toolbarCycleClicks ?? []))
    .toEqual(["one"])
  expect(consoleErrors).toEqual([])
  expect(unexpectedNetworkFailures(failedResponses)).toEqual([])
})

test("multi-select keeps actions selected and runs one-shot actions in toolbar order on modifier release", async ({
  page,
}) => {
  const consoleErrors: string[] = []
  const failedResponses: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })
  page.on("pageerror", (error) => consoleErrors.push(error.stack ?? error.message))
  page.on("requestfailed", (request) =>
    failedResponses.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`),
  )
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`)
  })

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "composer-toolbar-cycle",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "cycle-model": { id: "cycle-model", name: "Cycle Model", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "cycle-model" },
    },
    sessions: [
      {
        id: sessionID,
        slug: "composer-toolbar-cycle",
        projectID,
        directory,
        title: "Composer toolbar cycle regression",
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await mockToolbarCyclePlugin(page)
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({}))
    localStorage.setItem(
      "opencode.global.dat:plugin-toolbar-visibility",
      JSON.stringify({
        version: 1,
        global: Object.fromEntries(["one", "two", "three", "improve", "mount"].map((id) => [`composer-toolbar-cycle/${id}`, true])),
        projects: {},
      }),
    )
  })

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  const composer = await openSessionComposer(page)
  const input = composer.locator('[data-component="prompt-input"]')
  const mountButton = page.getByRole("button", { name: "Cycle Mount" })
  const improveButton = page.getByRole("button", { name: "Improve current prompt" })
  await expectAppVisible(page.getByRole("button", { name: "Cycle One" }))
  await expectAppVisible(page.getByRole("button", { name: "Cycle Two" }))
  await expectAppVisible(page.getByRole("button", { name: "Cycle Three" }))
  await expectAppVisible(improveButton)
  await expectAppVisible(mountButton)
  await mountButton.evaluate((button) => button.setAttribute("aria-pressed", "true"))

  await input.focus()
  await page.keyboard.down("Shift")
  await page.keyboard.press("Space")
  await page.keyboard.press("Space")
  await expect(activeToolbarButton(page)).toHaveAttribute("aria-label", "Cycle One")
  await page.keyboard.down("Control")
  await page.keyboard.press("Space")
  await expect(activeToolbarButton(page)).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(() => (window as Window & { __toolbarCycleClicks?: string[] }).__toolbarCycleClicks ?? []))
    .toEqual([])
  await page.keyboard.press("Space")
  await expect(activeToolbarButton(page)).toHaveAttribute("aria-label", "Cycle One")
  await expect
    .poll(() => page.evaluate(() => (window as Window & { __toolbarCycleClicks?: string[] }).__toolbarCycleClicks ?? []))
    .toEqual([])
  await page.keyboard.press("Space")
  await expect(activeToolbarButton(page)).toHaveAttribute("aria-label", "Cycle Two")
  await expect
    .poll(() => page.evaluate(() => (window as Window & { __toolbarCycleClicks?: string[] }).__toolbarCycleClicks ?? []))
    .toEqual([])
  await page.keyboard.press("Space")
  await expect(activeToolbarButton(page)).toHaveAttribute("aria-label", "Cycle Three")
  await expect
    .poll(() => page.evaluate(() => (window as Window & { __toolbarCycleClicks?: string[] }).__toolbarCycleClicks ?? []))
    .toEqual([])
  await page.keyboard.press("Space")
  await expect(activeToolbarButton(page)).toHaveAttribute("aria-label", "Improve current prompt")
  await expect(selectedToolbarButtons(page)).toHaveCount(4)
  await expect(page.getByRole("button", { name: "Cycle One" })).toHaveAttribute(
    "data-composer-toolbar-cycle-selected",
    "true",
  )
  await expect
    .poll(() => page.evaluate(() => (window as Window & { __toolbarCycleClicks?: string[] }).__toolbarCycleClicks ?? []))
    .toEqual([])
  await maybeScreenshot(page, "ctrl-shift-space-multi")
  await page.waitForTimeout(3200)
  await expect(activeToolbarButton(page)).toHaveAttribute("aria-label", "Improve current prompt")
  await expect(selectedToolbarButtons(page)).toHaveCount(4)
  await page.keyboard.up("Shift")
  await expect(activeToolbarButton(page)).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(() => (window as Window & { __toolbarCycleClicks?: string[] }).__toolbarCycleClicks ?? []))
    .toEqual(["one", "two", "three", "improve"])
  await page.keyboard.up("Control")
  await expect(improveButton).toBeEnabled()

  await page.evaluate(() => {
    const clicks = (window as Window & { __toolbarCycleClicks?: string[] }).__toolbarCycleClicks
    if (clicks) clicks.length = 0
  })
  await input.focus()
  await page.keyboard.down("Control")
  await page.keyboard.down("Shift")
  await page.keyboard.press("Space")
  await page.keyboard.press("Space")
  await expect(activeToolbarButton(page)).toHaveAttribute("aria-label", "Cycle One")
  await page.keyboard.press("Space")
  await expect(activeToolbarButton(page)).toHaveAttribute("aria-label", "Cycle Two")
  await page.keyboard.press("Space")
  await expect(activeToolbarButton(page)).toHaveAttribute("aria-label", "Cycle Three")
  await page.keyboard.press("Space")
  await expect(activeToolbarButton(page)).toHaveAttribute("aria-label", "Improve current prompt")
  await page.keyboard.press("Space")
  await expect(activeToolbarButton(page)).toHaveAttribute("aria-label", "Cycle Mount")
  await expect(improveButton).toHaveAttribute("data-composer-toolbar-cycle-selected", "true")
  await expect(selectedToolbarButtons(page)).toHaveCount(5)
  await page.keyboard.press("Space")
  await expect(activeToolbarButton(page)).toHaveAttribute("aria-label", "Cycle Mount")
  await expect(selectedToolbarButtons(page)).toHaveCount(5)
  await expect
    .poll(() => page.evaluate(() => (window as Window & { __toolbarCycleClicks?: string[] }).__toolbarCycleClicks ?? []))
    .toEqual([])
  await page.keyboard.up("Shift")
  await expect(activeToolbarButton(page)).toHaveCount(0)
  await expect(selectedToolbarButtons(page)).toHaveCount(0)
  await expect(mountButton).toHaveAttribute("aria-pressed", "true")
  await expect
    .poll(() => page.evaluate(() => (window as Window & { __toolbarCycleClicks?: string[] }).__toolbarCycleClicks ?? []))
    .toEqual(["one", "two", "three", "improve"])
  await page.keyboard.up("Control")

  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => {
    const clicks = (window as Window & { __toolbarCycleClicks?: string[] }).__toolbarCycleClicks
    if (clicks) clicks.length = 0
  })
  await input.focus()
  await page.keyboard.down("Control")
  await page.keyboard.down("Shift")
  await page.keyboard.press("Space")
  await expect(activeToolbarButton(page)).toHaveCount(0)
  await page.keyboard.press("Space")
  await expect(activeToolbarButton(page)).toHaveAttribute("aria-label", "Cycle One")
  await page.keyboard.press("Space")
  await expect(activeToolbarButton(page)).toHaveAttribute("aria-label", "Cycle Two")
  await page.keyboard.press("Space")
  await expect(activeToolbarButton(page)).toHaveAttribute("aria-label", "Cycle Three")
  await page.keyboard.press("Space")
  await expect(activeToolbarButton(page)).toHaveAttribute("aria-label", "Improve current prompt")
  await expect
    .poll(() => page.evaluate(() => (window as Window & { __toolbarCycleClicks?: string[] }).__toolbarCycleClicks ?? []))
    .toEqual([])
  await maybeScreenshot(page, "ctrl-shift-space-multi-mobile")
  await page.keyboard.up("Shift")
  await expect(activeToolbarButton(page)).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(() => (window as Window & { __toolbarCycleClicks?: string[] }).__toolbarCycleClicks ?? []))
    .toEqual(["one", "two", "three", "improve"])
  await page.keyboard.up("Control")

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.getByRole("button", { name: "Open settings" }).click()
  const shortcutsTab = page.getByRole("tab", { name: "Shortcuts", exact: true })
  await expectAppVisible(shortcutsTab)
  await shortcutsTab.click()
  const search = page.getByRole("searchbox", { name: "Search shortcuts" })
  await expectAppVisible(search)
  await search.fill("Cycle composer toolbar multi")
  await expectAppVisible(page.getByText("Cycle composer toolbar (multi)"))
  const multiKeybindButton = page.locator('[data-keybind-id="prompt.toolbar.multiActivate"]')
  await expect(multiKeybindButton).toContainText(/Ctrl\+Shift\+Space|⌃⇧Space/i)
  await maybeScreenshot(page, "settings-shortcut-multi")
  await multiKeybindButton.click()
  await page.keyboard.down("Control")
  await page.keyboard.down("Alt")
  await page.keyboard.press("Space")
  await page.keyboard.up("Alt")
  await page.keyboard.up("Control")
  await expect(multiKeybindButton).toContainText(/Ctrl\+Alt\+Space|⌃⌥Space/i)
  await page.keyboard.press("Escape")
  await expect(search).toBeHidden()

  await page.evaluate(() => {
    const clicks = (window as Window & { __toolbarCycleClicks?: string[] }).__toolbarCycleClicks
    if (clicks) clicks.length = 0
  })
  await input.focus()
  await page.keyboard.down("Control")
  await page.keyboard.down("Alt")
  await page.keyboard.press("Space")
  await expect(activeToolbarButton(page)).toHaveCount(0)
  await page.keyboard.press("Space")
  await expect(activeToolbarButton(page)).toHaveAttribute("aria-label", "Cycle One")
  await expect
    .poll(() => page.evaluate(() => (window as Window & { __toolbarCycleClicks?: string[] }).__toolbarCycleClicks ?? []))
    .toEqual([])
  await page.keyboard.press("Space")
  await expect(activeToolbarButton(page)).toHaveAttribute("aria-label", "Cycle Two")
  await expect
    .poll(() => page.evaluate(() => (window as Window & { __toolbarCycleClicks?: string[] }).__toolbarCycleClicks ?? []))
    .toEqual([])
  await page.keyboard.up("Alt")
  await expect(activeToolbarButton(page)).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(() => (window as Window & { __toolbarCycleClicks?: string[] }).__toolbarCycleClicks ?? []))
    .toEqual(["one", "two"])
  await page.keyboard.up("Control")

  expect(consoleErrors).toEqual([])
  expect(unexpectedNetworkFailures(failedResponses)).toEqual([])
})

test("late Space restarts the selection timeout so the cancel is measured from the last press", async ({ page }) => {
  const consoleErrors: string[] = []
  const failedResponses: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })
  page.on("pageerror", (error) => consoleErrors.push(error.stack ?? error.message))
  page.on("requestfailed", (request) =>
    failedResponses.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`),
  )
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`)
  })

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "composer-toolbar-cycle",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "cycle-model": { id: "cycle-model", name: "Cycle Model", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "cycle-model" },
    },
    sessions: [
      {
        id: sessionID,
        slug: "composer-toolbar-cycle",
        projectID,
        directory,
        title: "Composer toolbar cycle regression",
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await mockToolbarCyclePlugin(page)
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({}))
    localStorage.setItem(
      "opencode.global.dat:plugin-toolbar-visibility",
      JSON.stringify({
        version: 1,
        global: Object.fromEntries(["one", "two", "three", "improve", "mount"].map((id) => [`composer-toolbar-cycle/${id}`, true])),
        projects: {},
      }),
    )
  })

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  const composer = await openSessionComposer(page)
  const input = composer.locator('[data-component="prompt-input"]')
  await expectAppVisible(page.getByRole("button", { name: "Cycle One" }))

  await input.focus()
  await page.keyboard.down("Shift")
  await page.keyboard.press("Space")
  await page.keyboard.press("Space")
  await expect(activeToolbarButton(page)).toHaveAttribute("aria-label", "Cycle One")

  // Wait well into the 3s window, then press Space again. A non-restarting timer
  // would still be anchored to activation and expire at +3000ms; the restart must
  // defer the cancel to last-press + 3000ms.
  await page.waitForTimeout(2500)
  await page.keyboard.press("Space")
  await expect(activeToolbarButton(page)).toHaveAttribute("aria-label", "Cycle Two")

  // ~4250ms after activation (1750ms after the restart press): a fixed-window timer
  // (3000ms from activation) would have cancelled ~1250ms ago, while the restarted
  // timer still has ~1250ms left. Symmetric margins around the 3000ms boundary keep
  // the assertion stable on slow CI. Screenshot is taken after asserting so it
  // cannot push the timing-critical check toward the restart deadline.
  await page.waitForTimeout(1750)
  await expect(activeToolbarButton(page)).toHaveAttribute("aria-label", "Cycle Two")
  await maybeScreenshot(page, "restart-still-active")

  // ~3650ms after the last Space: the restarted 3000ms timer has now elapsed.
  await page.waitForTimeout(1900)
  await expect(activeToolbarButton(page)).toHaveCount(0)
  await page.keyboard.up("Shift")
  await expect
    .poll(() => page.evaluate(() => (window as Window & { __toolbarCycleClicks?: string[] }).__toolbarCycleClicks ?? []))
    .toEqual([])
  expect(consoleErrors).toEqual([])
  expect(unexpectedNetworkFailures(failedResponses)).toEqual([])
})

function activeToolbarButton(page: Page) {
  return page.locator('[data-composer-toolbar-cycle-active="true"]')
}

function selectedToolbarButtons(page: Page) {
  return page.locator('[data-composer-toolbar-cycle-selected="true"]')
}

function unexpectedNetworkFailures(failures: string[]) {
  return failures.filter((failure) => !failure.endsWith(" net::ERR_ABORTED"))
}

async function openSessionComposer(page: Page) {
  const composer = page.locator('[data-component="session-composer"]')
  const sessionRow = page.locator('[data-component="home-session-row"]').filter({ hasText: "Composer toolbar cycle regression" }).first()
  await expectAppVisible(composer.or(sessionRow).first())
  if (!(await composer.isVisible())) await sessionRow.click()
  await expectAppVisible(composer)
  return composer
}

async function maybeScreenshot(page: Page, name: string) {
  if (!process.env.VISUAL_QA_SCREENSHOT_DIR) return
  await page.screenshot({ path: `${process.env.VISUAL_QA_SCREENSHOT_DIR}/${name}.png`, fullPage: true })
}

async function mockToolbarCyclePlugin(page: Page) {
  await page.route("**/app/plugins**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({
        plugins: [
          {
            id: "composer-toolbar-cycle",
            spec: "composer-toolbar-cycle",
            version: "1",
            module: "/app/plugin/composer-toolbar-cycle/1/index.js",
            hash: "composer-toolbar-cycle",
            capabilities: ["ui:toolbar"],
          },
        ],
      }),
    }),
  )
  await page.route("**/app/plugin/composer-toolbar-cycle/1/index.js**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/javascript",
      headers: { "access-control-allow-origin": "*" },
      body: toolbarCyclePlugin(),
    }),
  )
}

function toolbarCyclePlugin() {
  return `
    const clicks = []
    window.__toolbarCycleClicks = clicks

    export default {
      id: "composer-toolbar-cycle",
      app(api) {
        for (const item of [
          { id: "one", title: "Cycle One", order: 1 },
          { id: "two", title: "Cycle Two", order: 2 },
          { id: "three", title: "Cycle Three", order: 3 },
        ]) {
          api.toolbar.register({
            id: item.id,
            title: item.title,
            placement: "composer",
            align: "right",
            order: item.order,
            icon: { name: "code" },
            run() {
              clicks.push(item.id)
            },
          })
        }
        api.toolbar.register({
          id: "improve",
          title: "Improve current prompt",
          placement: "composer",
          align: "right",
          kind: "mount",
          order: 4,
          mount(context) {
            const button = document.createElement("button")
            button.type = "button"
            button.setAttribute("aria-label", "Improve current prompt")
            button.style.cssText = "width:28px;height:28px;outline:none"
            button.addEventListener("click", () => {
              clicks.push("improve")
              button.disabled = true
              window.setTimeout(() => {
                button.disabled = false
              }, 100)
            })
            context.element.replaceChildren(button)
          },
        })
        api.toolbar.register({
          id: "mount",
          title: "Cycle Mount",
          placement: "composer",
          align: "right",
          kind: "mount",
          order: 5,
          mount(context) {
            const button = document.createElement("button")
            button.type = "button"
            button.setAttribute("aria-label", "Cycle Mount")
            button.setAttribute("aria-pressed", "false")
            button.style.cssText = "width:28px;height:28px;outline:none"
            button.addEventListener("click", () => {
              clicks.push("mount")
              button.setAttribute("aria-pressed", button.getAttribute("aria-pressed") === "true" ? "false" : "true")
            })
            context.element.replaceChildren(button)
          },
        })
      },
    }
  `
}
