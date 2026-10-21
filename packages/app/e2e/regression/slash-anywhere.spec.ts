import { expect, test, type Locator, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectNoSmokeErrors, trackPageErrors } from "../utils/errors"
import { expectAppVisible } from "../utils/waits"

// Feature 1 (Slice 1A): slash commands must trigger from anywhere in the
// prompt, not only when "/" is the first character. Capture a video for every
// run so this spec doubles as visual proof.
test.use({ video: "on", screenshot: "on" })

const directory = "C:/OpenCode/SlashAnywhere"
const projectID = "proj_slash_anywhere"
const sessionID = "ses_slash_anywhere"

const commands = [
  { name: "review", description: "Review the current diff", source: "command", subtask: true },
  { name: "init", description: "Initialize a new project", source: "command" },
  { name: "visual-qa-testing", description: "Verify UI in browser", source: "skill" },
  { name: "browser-snapshot", description: "Capture browser screenshots", source: "skill" },
  { name: "pdf-form-generator", description: "Create fillable PDF forms", source: "skill" },
  {
    name: "on-demand-ui",
    description: "Build native OpenCode UIs",
    source: "skill",
    requiredTools: ["surface"],
  },
  { name: "summarize", description: "Summarize the session so far", source: "skill" },
  ...Array.from({ length: 5 }, (_, index) => ({
    name: `fixture-skill-${index}`,
    description: `Fixture skill ${index}`,
    source: "skill",
  })),
]

async function setup(
  page: Page,
  options: {
    sessionStatus?: unknown
    followup?: "queue" | "steer"
    questions?: () => unknown[]
    agents?: unknown[]
    appearance?: Record<string, unknown>
  } = {},
) {
  const requests: Array<{ type: "command" | "legacyCommand" | "prompt" | "durablePrompt"; body: Record<string, unknown> }> = []
  let sessionStatus = options.sessionStatus ?? {}

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "slash-anywhere",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
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
    },
    sessions: [
      {
        id: sessionID,
        slug: "slash-anywhere",
        projectID,
        directory,
        title: "Slash anywhere regression",
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
    sessionStatus: options.sessionStatus,
    questions: options.questions,
    agents: options.agents,
    commands,
  })

  await page.route(/\/session\/status(?:\?|$)/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(sessionStatus),
    }),
  )

  await page.route(/\/session\/[^/]+\/command(?:\?|$)/, (route) => {
    requests.push({ type: "legacyCommand", body: JSON.parse(route.request().postData() ?? "{}") })
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ info: { id: "msg_command" }, parts: [] }),
    })
  })
  await page.route(/\/api\/session\/[^/]+\/command(?:\?|$)/, (route) => {
    requests.push({ type: "command", body: JSON.parse(route.request().postData() ?? "{}") })
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ data: { sessionID, messageID: "msg_command", admittedSeq: 1 } }),
    })
  })
  await page.route(/\/api\/session\/[^/]+\/prompt(?:\?|$)/, (route) => {
    requests.push({ type: "durablePrompt", body: JSON.parse(route.request().postData() ?? "{}") })
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ data: { sessionID, messageID: "message_queued", admittedSeq: 1 } }),
    })
  })

  await page.addInitScript((input) => {
    if (sessionStorage.getItem("opencode.slash-anywhere.initialized") !== "1") {
      localStorage.removeItem("opencode.global.dat:tabs")
      localStorage.removeItem("opencode.global.dat:tabs.recent")
      sessionStorage.setItem("opencode.slash-anywhere.initialized", "1")
    }
    localStorage.setItem(
      "settings.v3",
      JSON.stringify({
        ...(input.appearance ? { appearance: input.appearance } : {}),
        general: {
          ...(input.followup ? { followup: input.followup, followupQueueMigrated: true } : {}),
        },
      }),
    )
  }, { appearance: options.appearance, followup: options.followup })
  const sessionURL = `/${base64Encode(directory)}/session/${sessionID}`
  await page.goto(sessionURL)
  const composer = page.locator('[data-component="session-composer"]')
  if ((await composer.count()) === 0) {
    const sessionRow = page.locator('[data-component="home-session-row"]').filter({ hasText: "Slash anywhere regression" })
    if ((await sessionRow.count()) > 0) await sessionRow.click()
    await page.waitForTimeout(100)
    if ((await composer.count()) === 0) await page.goto(sessionURL)
  }
  await expectAppVisible(composer)
  return {
    composer,
    input: composer.locator('[data-component="prompt-input"]'),
    requests,
    emitIdle: () => {
      sessionStatus = { [sessionID]: { type: "idle" } }
    },
  }
}

const editorText = (input: Locator) => input.evaluate((el) => el.textContent ?? "")

test("opens the slash popover when / is typed mid-sentence and inserts a reference at the cursor", async ({
  page,
}) => {
  const errors = trackPageErrors(page)
  const failedResponses: string[] = []
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`)
  })
  const { input } = await setup(page)

  await input.click()
  // Type a leading sentence first, so the next "/" is NOT at the start.
  await page.keyboard.type("please review this ")
  await expect(page.locator("[data-slash-id]")).toHaveCount(0)

  // Now type "/" mid-sentence: the popover must open (this is the core change).
  // Asserting a custom item here also gates on the mocked commands having loaded.
  await page.keyboard.type("/")
  await expect(page.locator('[data-slash-id="custom.review"]')).toBeVisible()
  await expect(page.locator('[data-slash-id="custom.on-demand-ui"]')).toBeVisible()
  const slashColor = await page.evaluate(() => {
    const probe = document.createElement("span")
    probe.style.color = "var(--composer-slash-command-color)"
    document.querySelector('[data-component="session-composer"]')?.parentElement?.parentElement?.append(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    return color
  })
  await expect(page.locator('[data-slash-id="custom.review"] span').first()).toHaveCSS("color", slashColor)
  await page.waitForTimeout(500)

  // Filtering narrows the list to the matching trigger.
  await page.keyboard.type("rev")
  await expect(page.locator('[data-slash-id="custom.review"]')).toBeVisible()
  await expect(page.locator('[data-slash-id="custom.init"]')).toHaveCount(0)
  await page.waitForTimeout(500)

  // Selecting mid-sentence keeps the surrounding text and drops the reference at the cursor.
  // Use keyboard Enter (handled by the slash popover's keydown) instead of a mouse
  // click: an SVG icon overlays the popover item and intercepts pointer events.
  await page.keyboard.press("Enter")
  await expect(input).toContainText("please review this /review")
  const highlighted = input.locator('[data-type="slash-command"]')
  await expect(highlighted).toHaveText("/review")
  const styles = await highlighted.evaluate((element) => {
    const command = getComputedStyle(element)
    const editor = getComputedStyle(element.parentElement!)
    return { color: command.color, editorColor: editor.color, weight: Number(command.fontWeight) }
  })
  expect(styles.color).not.toBe(styles.editorColor)
  expect(styles.weight).toBeGreaterThanOrEqual(500)
  await page.screenshot({ path: "test-results/slash-highlight-composer-desktop.png", fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(highlighted).toBeVisible()
  const bounds = await highlighted.evaluate((element) => {
    const direct = element.getBoundingClientRect()
    if (direct.width > 0 && direct.height > 0) return { x: direct.x, width: direct.width }
    const range = document.createRange()
    range.selectNodeContents(element)
    const text = range.getBoundingClientRect()
    return { x: text.x, width: text.width }
  })
  expect(bounds).not.toBeNull()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
  await page.screenshot({ path: "test-results/slash-highlight-composer-mobile.png", fullPage: true })
  await input.fill("/review_note")
  await expect(highlighted).toHaveCount(0)
  expectNoSmokeErrors(errors, [], [])
  expect(failedResponses).toEqual([])
})

test("uses a theme-specific purple slash command color configured in settings", async ({ page }) => {
  const errors = trackPageErrors(page)
  const networkFailures: string[] = []
  page.on("requestfailed", (request) =>
    networkFailures.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`),
  )
  page.on("response", (response) => {
    if (response.status() >= 400) networkFailures.push(`${response.status()} ${response.url()}`)
  })
  await page.addInitScript(() => localStorage.setItem("opencode-color-scheme", "dark"))
  const { input } = await setup(page, { appearance: { mono: "Legacy Mono" } })

  await input.fill("/review")
  const highlighted = input.locator('[data-type="slash-command"]')
  await expect(highlighted).toHaveCSS("color", "rgb(196, 181, 253)")

  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: ",", ctrlKey: true, bubbles: true, cancelable: true }))
  })
  const setting = page.locator('[data-action="settings-slash-command-color"]')
  await expect(setting).toBeVisible()
  await setting.locator('input[data-scheme="dark"]').fill("#d946ef")
  await expect(highlighted).toHaveCSS("color", "rgb(217, 70, 239)")
  await expect
    .poll(() =>
      page.evaluate(() => {
        const value = JSON.parse(localStorage.getItem("settings.v3") ?? "{}") as {
          appearance?: { slashCommandColors?: Record<string, { light?: string; dark?: string }> }
        }
        return value.appearance?.slashCommandColors?.["oc-2"]?.dark
      }),
    )
    .toBe("#d946ef")

  await page.evaluate(() => {
    localStorage.setItem("opencode-theme-id", "aura")
    window.dispatchEvent(new StorageEvent("storage", { key: "opencode-theme-id", newValue: "aura" }))
  })
  await expect(setting.locator('input[data-scheme="dark"]')).toHaveValue("#c4b5fd")
  await setting.locator('input[data-scheme="light"]').fill("#ffffff")
  await setting.locator('input[data-scheme="dark"]').fill("#000000")
  await expect(setting.getByRole("status")).toContainText("Light, Dark")
  await setting.locator('input[data-scheme="light"]').fill("#7e22ce")
  await setting.locator('input[data-scheme="dark"]').fill("#a855f7")
  await expect(setting.getByRole("status")).toHaveCount(0)
  await page.screenshot({ path: "test-results/slash-command-color-settings.png", fullPage: true })
  await page.keyboard.press("Escape")

  await expect(highlighted).toHaveCSS("color", "rgb(168, 85, 247)")
  await page.screenshot({ path: "test-results/slash-command-color-composer.png", fullPage: true })
  await expect
    .poll(() =>
      page.evaluate(() => {
        const value = JSON.parse(localStorage.getItem("settings.v3") ?? "{}") as {
          appearance?: { slashCommandColors?: Record<string, { light?: string; dark?: string }> }
        }
        return [
          value.appearance?.slashCommandColors?.["oc-2"]?.dark,
          value.appearance?.slashCommandColors?.aura?.light,
          value.appearance?.slashCommandColors?.aura?.dark,
          (value.appearance as { mono?: string } | undefined)?.mono,
        ]
      }),
    )
    .toEqual(["#d946ef", "#7e22ce", "#a855f7", "Legacy Mono"])
  expectNoSmokeErrors(errors, [], [])
  // The Review dock cancels its in-flight diff request when the theme re-render replaces it.
  expect(
    networkFailures.filter(
      (failure) =>
          !(failure.endsWith("net::ERR_ABORTED") &&
          (failure.includes("/vcs/diff?") ||
            failure.includes("/diff?") ||
            failure.includes("/app/plugins") ||
            failure.includes("/@fs/") ||
            failure.includes("/src/") ||
            failure.includes("/perf/record"))),
    ),
  ).toEqual([])
})

test("hides skills whose required tool is absent from the selected agent", async ({ page }) => {
  const errors = trackPageErrors(page)
  const failedResponses: string[] = []
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`)
  })
  const { input } = await setup(page, {
    agents: [
      {
        name: "build",
        mode: "primary",
        permission: [],
        options: {},
        tools: { mode: "explicit", entries: {} },
      },
    ],
  })

  await page.setViewportSize({ width: 1440, height: 900 })
  await input.click()
  await page.keyboard.type("/")
  await expect(page.locator('[data-slash-id="custom.review"]')).toBeVisible()
  await expect(page.locator('[data-slash-id="custom.on-demand-ui"]')).toHaveCount(0)
  await page.screenshot({ path: "test-results/slash-capability-desktop.png", fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  await input.click()
  await page.keyboard.press("Control+A")
  await page.keyboard.press("Backspace")
  await page.keyboard.type("/")
  await expect(page.locator('[data-slash-id="custom.review"]')).toBeVisible()
  await expect(page.locator('[data-slash-id="custom.on-demand-ui"]')).toHaveCount(0)
  await page.screenshot({ path: "test-results/slash-capability-mobile.png", fullPage: true })
  expect(errors).toEqual([])
  expect(failedResponses).toEqual([])
})

test("shows at most ten slash results before scrolling", async ({ page }) => {
  const errors = trackPageErrors(page)
  const failedResponses: string[] = []
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`)
  })
  const { input } = await setup(page)

  await input.click()
  await page.keyboard.type("/")

  const popover = page.locator('[data-component="prompt-popover"][data-popover="slash"]')
  const results = popover.locator("[data-slash-id]")
  await expect(results.nth(10)).toBeAttached()

  const layout = await popover.evaluate((element) => {
    const items = Array.from(element.querySelectorAll<HTMLElement>("[data-slash-id]"))
    const bounds = element.getBoundingClientRect()
    return {
      visible: items.filter((item) => item.getBoundingClientRect().bottom <= bounds.bottom).length,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }
  })

  expect(layout.visible).toBe(10)
  expect(layout.scrollHeight).toBeGreaterThan(layout.clientHeight)
  await page.screenshot({ path: "test-results/slash-popover-top-ten-desktop.png", fullPage: true })

  for (let index = 0; index < 10; index++) await page.keyboard.press("ArrowDown")
  await expect.poll(() => popover.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  await expect
    .poll(() =>
      popover.evaluate((element) => {
        const item = element.querySelectorAll<HTMLElement>("[data-slash-id]")[10]
        if (!item) return false
        const bounds = element.getBoundingClientRect()
        const itemBounds = item.getBoundingClientRect()
        return itemBounds.top >= bounds.top && itemBounds.bottom <= bounds.bottom
      }),
    )
    .toBe(true)
  expectNoSmokeErrors(errors, [], [])
  expect(failedResponses).toEqual([])
})

test("shows at most ten slash results before scrolling on mobile", async ({ page }) => {
  const errors = trackPageErrors(page)
  const failedResponses: string[] = []
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`)
  })
  await page.setViewportSize({ width: 390, height: 844 })
  const { input } = await setup(page)

  await input.click()
  await page.keyboard.type("/")

  const popover = page.locator('[data-component="prompt-popover"][data-popover="slash"]')
  const results = popover.locator("[data-slash-id]")
  await expect(results.nth(10)).toBeAttached()

  const layout = await popover.evaluate((element) => {
    const items = Array.from(element.querySelectorAll<HTMLElement>("[data-slash-id]"))
    const bounds = element.getBoundingClientRect()
    return {
      visible: items.filter((item) => item.getBoundingClientRect().bottom <= bounds.bottom).length,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }
  })

  expect(layout.visible).toBe(10)
  expect(layout.scrollHeight).toBeGreaterThan(layout.clientHeight)
  await page.screenshot({ path: "test-results/slash-popover-top-ten-mobile.png", fullPage: true })
  expectNoSmokeErrors(errors, [], [])
  expect(failedResponses).toEqual([])
})

test("lists V2 catalog skills including PDF forms when filtered by their slash trigger", async ({ page }) => {
  const { input } = await setup(page)

  await input.click()
  await page.keyboard.type("/pdf-form-generator")
  await expect(page.locator('[data-slash-id="custom.pdf-form-generator"]')).toBeVisible()
  await expect(page.locator('[data-slash-id="custom.on-demand-ui"]')).toHaveCount(0)
})

test("refreshes the skill catalog when the slash popover opens", async ({ page }) => {
  const { input } = await setup(page)
  let refreshes = 0
  await page.route(/\/api\/command(?:\?|$)/, (route) => {
    if (route.request().method() !== "GET") return route.fallback()
    refreshes++
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({
        location: { directory },
        data: [...commands, { name: "live-refresh-skill", description: "Added after bootstrap", source: "skill" }],
      }),
    })
  })

  await input.click()
  await page.keyboard.type("/live-refresh")

  // Bootstrap may still complete one in-flight catalog request after setup.
  // Opening the popover must trigger a refresh, but the assertion should not
  // confuse that harmless overlap with a missing on-demand refresh.
  await expect.poll(() => refreshes).toBeGreaterThanOrEqual(1)
  await expect(page.locator('[data-slash-id="custom.live-refresh-skill"]')).toBeVisible()
})

test("keeps slash suggestions closed after an argument until a new slash expression starts", async ({ page }) => {
  const { input } = await setup(page)

  await input.click()
  await page.keyboard.type("/visual")
  await expect(page.locator('[data-slash-id="custom.visual-qa-testing"]')).toBeVisible()
  await page.keyboard.type(" argument")
  await expect(page.locator("[data-slash-id]")).toHaveCount(0)

  await input.evaluate((el) => {
    const text = el.firstChild
    if (!text) throw new Error("prompt text node missing")
    const range = document.createRange()
    const selection = window.getSelection()
    range.setStart(text, "/visual".length)
    range.collapse(true)
    selection?.removeAllRanges()
    selection?.addRange(range)
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }))
  })
  await expect(page.locator("[data-slash-id]")).toHaveCount(0)

  await page.keyboard.press("End")
  await page.keyboard.type(" /pdf")
  await expect(page.locator('[data-slash-id="custom.pdf-form-generator"]')).toBeVisible()
})

test("submits standalone slash text without trapping Enter in the slash popover", async ({ page }) => {
  const { input, requests } = await setup(page)

  await input.click()
  await page.keyboard.type("1 / 2")

  await expect(page.locator("[data-slash-id]")).toHaveCount(0)
  await page.keyboard.press("Enter")

  await expect.poll(() => requests.length).toBe(1)
  expect(requests[0]).toMatchObject({ type: "durablePrompt", body: { prompt: { text: "1 / 2" } } })
})

test("restores stored cursor before type-anywhere inserts text", async ({ page }) => {
  const { input } = await setup(page)

  await input.click()
  await page.keyboard.type("hello world")
  await input.evaluate((el) => {
    const node = el.firstChild
    if (!node) throw new Error("prompt text node missing")
    const range = document.createRange()
    const selection = window.getSelection()
    range.setStart(node, 5)
    range.collapse(true)
    selection?.removeAllRanges()
    selection?.addRange(range)
  })

  await input.evaluate((el) => {
    const input = el as HTMLElement
    input.blur()
  })
  await expect.poll(() => input.evaluate((el) => el.contains(document.activeElement))).toBe(false)

  await page.keyboard.type(" brave")

  await expect.poll(() => editorText(input)).toBe("hello brave world")
  await expect
    .poll(() =>
      input.evaluate((el) => {
        const selection = window.getSelection()
        if (!selection?.anchorNode || !el.contains(selection.anchorNode)) return null
        return selection.anchorOffset
      }),
    )
    .toBe(11)
})

test("submits blank block wrappers without adding extra newlines", async ({ page }) => {
  const { composer, input, requests } = await setup(page)

  await input.click()
  await input.evaluate((el) => {
    el.innerHTML = "<div>foo</div><div><br></div><div>bar</div>"
    const last = el.lastChild?.firstChild
    if (!last) throw new Error("last prompt text node missing")
    const range = document.createRange()
    const selection = window.getSelection()
    range.setStart(last, 0)
    range.collapse(true)
    selection?.removeAllRanges()
    selection?.addRange(range)
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }))
  })

  await composer.locator('[data-action="prompt-submit"]').click()

  await expect.poll(() => requests.length).toBe(1)
  expect(requests[0]).toMatchObject({ type: "durablePrompt", body: { prompt: { text: "foo\n\nbar" } } })
})

test("submits selected skills as prompt references instead of command executions", async ({ page }) => {
  const { composer, input, requests } = await setup(page)

  await input.click()
  await page.keyboard.type("/")
  await expect(page.locator('[data-slash-id="custom.visual-qa-testing"]')).toBeVisible()
  await page.locator('[data-slash-id="custom.visual-qa-testing"]').click()
  await expect(input).toContainText("/visual-qa-testing")
  await page.keyboard.type("check the composer")
  await composer.locator('[data-action="prompt-submit"]').click()

  await expect.poll(() => requests.length).toBe(1)
  expect(requests[0]).toMatchObject({
    type: "durablePrompt",
    body: { prompt: { text: "/visual-qa-testing check the composer" } },
  })
})

test("submits keyboard-selected skills as prompt references with Enter", async ({ page }) => {
  const { input, requests } = await setup(page)

  await input.click()
  await page.keyboard.type("/visual")
  await expect(page.locator('[data-slash-id="custom.visual-qa-testing"]')).toBeVisible()
  await page.keyboard.press("Enter")
  await expect(input).toContainText("/visual-qa-testing")
  await page.keyboard.type("check after enter")
  await page.keyboard.press("Enter")

  await expect.poll(() => requests.length).toBe(1)
  expect(requests[0]).toMatchObject({
    type: "durablePrompt",
    body: { prompt: { text: "/visual-qa-testing check after enter" } },
  })
})

test("submits manually typed skills as prompt references", async ({ page }) => {
  const { input, requests } = await setup(page)

  await input.click()
  await page.keyboard.type("/visual-qa-testing typed manually")
  await page.keyboard.press("Enter")

  await expect.poll(() => requests.length).toBe(1)
  expect(requests[0]).toMatchObject({
    type: "durablePrompt",
    body: { prompt: { text: "/visual-qa-testing typed manually" } },
  })
})

test("drains manually typed skill slash followups as queued prompts", async ({ page }) => {
  const errors = trackPageErrors(page)
  const failedResponses: string[] = []
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`)
  })
  const { input, requests, emitIdle } = await setup(page, { sessionStatus: { [sessionID]: { type: "busy" } } })

  await input.click()
  await page.keyboard.type("/visual-qa-testing queued browser check")
  await page.keyboard.press("Enter")

  await expect(page.locator('[data-component="session-followup-dock"]')).toContainText(
    "/visual-qa-testing queued browser check",
  )
  const queuedMessageID = await page.locator("[data-followup-id]").getAttribute("data-followup-id")
  expect(queuedMessageID).toBeTruthy()
  expect(requests).toHaveLength(0)

  emitIdle()
  await page.reload()
  await expect.poll(() => requests.length).toBe(1)
  expect(requests[0]?.type).toBe("durablePrompt")
  expect(requests[0]?.body.id).not.toBe(queuedMessageID)
  expect(requests[0]?.body).toMatchObject({
    delivery: "queue",
    prompt: { text: "/visual-qa-testing queued browser check" },
  })
  await page.screenshot({ path: "test-results/queued-slash-followup.png", fullPage: true })
  expectNoSmokeErrors(errors, [], [])
  expect(failedResponses).toEqual([])
})

test("sends queued followups immediately from Send now while the session is active", async ({ page }) => {
  const errors = trackPageErrors(page)
  const failedResponses: string[] = []
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`)
  })
  const { input, requests } = await setup(page, { sessionStatus: { [sessionID]: { type: "busy" } } })

  await input.click()
  await page.keyboard.type("send this queued followup now")
  await page.keyboard.press("Enter")

  const dock = page.locator('[data-component="session-followup-dock"]')
  await expect(dock).toContainText("send this queued followup now")
  const queuedMessageID = await dock.locator("[data-followup-id]").getAttribute("data-followup-id")
  expect(queuedMessageID).toBeTruthy()
  const sendNow = dock.getByRole("button", { name: "Send now" })
  await expect(sendNow).toBeEnabled()
  await page.screenshot({ path: "test-results/send-now-followup-ready.png", fullPage: true })

  await sendNow.click()

  await expect.poll(() => requests.length).toBe(1)
  expect(requests[0]?.type).toBe("durablePrompt")
  expect(requests[0]?.body.id).not.toBe(queuedMessageID)
  expect(requests[0]?.body).toMatchObject({
    delivery: "steer",
    prompt: { text: "send this queued followup now" },
  })
  await expect(dock).toHaveCount(0)
  await page.screenshot({ path: "test-results/send-now-followup.png", fullPage: true })
  expectNoSmokeErrors(errors, [], [])
  expect(failedResponses).toEqual([])
})

test("keeps followups in the local queue while a blocking question is pending", async ({ page }) => {
  const errors = trackPageErrors(page)
  const failedResponses: string[] = []
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`)
  })
  const question = {
    id: "que_followup_blocking",
    sessionID,
    mode: "blocking",
    questions: [
      {
        question: "Choose how to continue",
        header: "Pending decision",
        options: [
          { label: "Continue", description: "Resume the active turn" },
          { label: "Stop", description: "Leave the turn paused" },
        ],
      },
    ],
  }
  const { input, requests } = await setup(page, {
    sessionStatus: { [sessionID]: { type: "idle" } },
    questions: () => [question],
  })

  await expect(page.getByText("Choose how to continue")).toBeVisible()
  await input.fill("queue this until I send it")
  await input.press("Enter")

  const dock = page.locator('[data-component="session-followup-dock"]')
  await expect(dock).toContainText("queue this until I send it")
  const sendNow = dock.getByRole("button", { name: "Send now" })
  await expect(sendNow).toBeEnabled()
  expect(requests).toHaveLength(0)

  await sendNow.click()

  await expect.poll(() => requests.length).toBe(1)
  expect(requests[0]).toMatchObject({
    type: "durablePrompt",
    body: { delivery: "steer", prompt: { text: "queue this until I send it" } },
  })
  expectNoSmokeErrors(errors, [], [])
  expect(failedResponses).toEqual([])
})

test("steers followups immediately while the session is active", async ({ page }) => {
  const errors = trackPageErrors(page)
  const failedResponses: string[] = []
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`)
  })
  const { input, requests } = await setup(page, {
    followup: "steer",
    sessionStatus: { [sessionID]: { type: "busy" } },
  })

  await input.click()
  await page.keyboard.type("continue while running")
  await page.keyboard.press("Enter")

  await expect.poll(() => requests.length).toBe(1)
  expect(requests[0]).toMatchObject({ type: "durablePrompt", body: { prompt: { text: "continue while running" } } })
  expect(requests[0]?.body.delivery).toBeUndefined()
  await expect(page.locator('[data-component="session-followup-dock"]')).toHaveCount(0)
  await page.screenshot({ path: "test-results/steered-active-followup.png", fullPage: true })
  expectNoSmokeErrors(errors, [], [])
  expect(failedResponses).toEqual([])
})

test("keeps subtask command-source slash submissions on the v2 command endpoint", async ({ page }) => {
  const { input, requests } = await setup(page)

  await input.click()
  await page.keyboard.type("/review now")
  await page.keyboard.press("Enter")

  await expect.poll(() => requests.length).toBe(1)
  expect(requests[0]).toMatchObject({
    type: "command",
    body: { command: "review", arguments: "now" },
  })
})
