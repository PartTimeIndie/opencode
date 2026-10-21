import { expect, test, type Page } from "@playwright/test"
import { mkdirSync } from "node:fs"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { fixture } from "../smoke/session-timeline.fixture"

const screenshots = "../../docs/workitems/screenshots/markdown-preview"
const markdown =
  "---\ntitle: Hidden metadata\n---\n# Project history\n\nThe **preview works** through the project file API.\n\n- First entry\n- Second entry\n"

async function openPreview(
  page: Page,
  text: string,
  onFileRead?: (input: { directory: string; path: string }) => unknown,
  configure?: () => Promise<void>,
) {
  const messages = structuredClone(fixture.messages[fixture.sourceID].slice(-2))
  const assistant = messages.find((message) => message.info.role === "assistant")!
  assistant.parts = [
    { id: "prt_markdown_preview", type: "text", messageID: assistant.info.id, sessionID: fixture.sourceID, text },
  ]
  await mockOpenCodeServer(page, {
    sessions: fixture.sessions,
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages: () => ({ items: messages }),
    onFileRead: onFileRead ?? (() => ({ type: "text", content: markdown })),
  })
  await configure?.()
  await page.addInitScript(
    ({ dir, dirBase64, sessionID }) => {
      const server = "http://127.0.0.1:4096"
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { [server]: [{ worktree: dir, expanded: true }] }, lastProject: { [server]: dir } }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", server, dirBase64, sessionId: sessionID }]),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs.recent",
        JSON.stringify({ key: `${server}\n${dirBase64}\n${sessionID}` }),
      )
    },
    { dir: fixture.directory, dirBase64: base64Encode(fixture.directory), sessionID: fixture.sourceID },
  )
  await page.goto(`/${base64Encode(fixture.directory)}/session/${fixture.sourceID}`)
  const tab = page.locator(`[data-dock-tab][data-session-id="${fixture.sourceID}"]`).getByRole("tab")
  if (await tab.isVisible()) await tab.click()
  await page.getByRole("button", { name: /^(Preview markdown|Markdown-Vorschau)$/ }).click()
  const overlay = page.locator('[data-component="markdown-preview-overlay"]')
  await expect(overlay).toBeVisible()
  return overlay
}

for (const viewport of [
  { width: 1280, height: 720 },
  { width: 390, height: 844 },
]) {
  test(`previews project Markdown without fetching a UI route (${viewport.width})`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport)
    const errors: string[] = []
    const failures: string[] = []
    const reads: { directory: string; path: string }[] = []
    const wrongRoutes: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text())
    })
    page.on("response", (response) => {
      if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`)
    })
    page.on("requestfailed", (request) => {
      if (request.failure()?.errorText !== "net::ERR_ABORTED")
        failures.push(`${request.url()} ${request.failure()?.errorText}`)
    })
    await page.route("**/history.md*", (route) => {
      wrongRoutes.push(route.request().url())
      return route.fulfill({ status: 404, body: "Not found" })
    })
    const overlay = await openPreview(page, "[Project history](docs/history.md#entries)", (input) => {
      reads.push(input)
      return { type: "text", content: markdown }
    })
    await expect(overlay).not.toContainText("Loading preview...")
    mkdirSync(screenshots, { recursive: true })
    await page.screenshot({
      path: `${screenshots}/${testInfo.project.name}-${viewport.width}-${process.env.MARKDOWN_QA_PHASE ?? "after"}.png`,
      fullPage: true,
    })
    await expect(overlay.getByRole("heading", { name: "Project history" })).toBeVisible()
    await expect(overlay.locator("strong")).toHaveText("preview works")
    await expect(overlay).not.toContainText("Hidden metadata")
    expect(reads).toEqual([{ directory: fixture.directory, path: "docs/history.md" }])
    expect(wrongRoutes).toEqual([])
    const panel = await overlay.locator('[data-slot="markdown-preview-panel"]').boundingBox()
    expect(panel!.x).toBeGreaterThanOrEqual(0)
    expect(panel!.x + panel!.width).toBeLessThanOrEqual(viewport.width)
    await overlay.getByRole("button", { name: "Close", exact: true }).click()
    await expect(overlay).toHaveCount(0)
    expect(errors).toEqual([])
    expect(failures).toEqual([])
  })
}

test("blocks traversal links without a file read", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  const errors: string[] = []
  const failures: string[] = []
  const reads: { directory: string; path: string }[] = []
  const wrongRoutes: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  page.on("response", (response) => {
    if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`)
  })
  await page.route("**/*.md*", (route) => {
    wrongRoutes.push(route.request().url())
    return route.fulfill({ status: 404, body: "Not found" })
  })
  const overlay = await openPreview(page, "[Outside project](../../secret.md)", (input) => {
    reads.push(input)
    return { type: "text", content: markdown }
  })
  await expect(overlay).toContainText("Could not load markdown preview")
  expect(reads).toEqual([])
  await page.keyboard.press("Escape")
  await expect(overlay).toHaveCount(0)
  expect(wrongRoutes).toEqual([])
  expect(errors).toEqual([])
  expect(failures).toEqual([])
})

test("shows denied files without a UI request", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  const errors: string[] = []
  const failures: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() !== "error") return
    if (
      message.text() === "Failed to load resource: the server responded with a status of 403 (Forbidden)" &&
      message.location().url.includes("/file/content")
    )
      return
    errors.push(message.text())
  })
  page.on("response", (response) => {
    if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`)
  })
  await page.route("**/denied.md*", (route) => route.fulfill({ status: 404, body: "Not found" }))
  const denied = await openPreview(page, "[Denied](docs/denied.md)", undefined, async () => {
    await page.route(
      (url) => url.pathname === "/file/content" && url.searchParams.get("path") === "docs/denied.md",
      (route) =>
        route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({ error: "Access denied" }),
        }),
    )
  })
  await expect(denied).toContainText(
    "Could not load markdown preview: The file is unavailable or is not a text document.",
  )
  await denied.getByRole("button", { name: "Close", exact: true }).click()
  await expect(denied).toHaveCount(0)
  expect(errors).toEqual([])
  expect(failures).toHaveLength(1)
  expect(failures[0]).toMatch(/^403 .*\/file\/content\?/)
  await expect(page.getByRole("button", { name: "Preview markdown", exact: true })).toBeFocused()
})

test("keeps nested preview working inside the overlay", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  const errors: string[] = []
  const failures: string[] = []
  const reads: { directory: string; path: string }[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  page.on("response", (response) => {
    if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`)
  })
  page.on("requestfailed", (request) => {
    if (request.failure()?.errorText !== "net::ERR_ABORTED")
      failures.push(`${request.url()} ${request.failure()?.errorText}`)
  })
  const overlay = await openPreview(page, "[Nested history](docs/nested.md)", (input) => {
    reads.push(input)
    if (input.path === "docs/target.md") return { type: "text", content: "# Target\n" }
    return { type: "text", content: "# Nested\n\n```ts\nconst nested = 1\n```\n\n[Nested target](docs/target.md)\n" }
  })
  await expect(overlay.getByRole("heading", { name: "Nested" })).toBeVisible()
  const initialTrigger = page.locator('[data-component="text-part"] [data-slot="markdown-preview-button"]')
  const nestedTrigger = overlay.locator('[data-slot="markdown-preview-button"]')
  await expect(overlay.getByRole("button", { name: "Close", exact: true })).toBeFocused()
  await overlay.getByRole("button", { name: "Copy", exact: true }).first().focus()
  await page.keyboard.press("Shift+Tab")
  await expect(nestedTrigger).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(overlay.getByRole("button", { name: "Copy", exact: true }).first()).toBeFocused()
  const downloads = page.waitForEvent("download")
  await overlay.getByRole("button", { name: "Download", exact: true }).click()
  expect((await downloads).suggestedFilename()).toBe("nested.md")
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined })
  })
  const codeCopy = overlay.locator('[data-slot="markdown-copy-button"]')
  await codeCopy.click()
  await expect(codeCopy).toHaveAttribute("data-copied", "true")
  await expect(codeCopy).toBeFocused()
  expect(reads).toEqual([{ directory: fixture.directory, path: "docs/nested.md" }])
  await overlay.locator('[data-slot="markdown-preview-button"]').click()
  const overlays = page.locator('[data-component="markdown-preview-overlay"]')
  await expect(overlays).toHaveCount(2)
  const nested = overlays.nth(1)
  await expect(nested.getByRole("heading", { name: "Target" })).toBeVisible()
  await page.keyboard.press("Tab")
  await expect(nested.getByRole("button", { name: "Copy", exact: true })).toBeFocused()
  await page.keyboard.press("Shift+Tab")
  await expect(nested.getByRole("button", { name: "Close", exact: true })).toBeFocused()
  expect(reads.map((read) => read.path)).toEqual(["docs/nested.md", "docs/target.md"])
  await page.keyboard.press("Escape")
  await expect(overlays).toHaveCount(1)
  await expect(overlay.getByRole("heading", { name: "Nested" })).toBeVisible()
  await expect(nestedTrigger).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(overlays).toHaveCount(0)
  await expect(initialTrigger).toBeFocused()
  expect(errors).toEqual([])
  expect(failures).toEqual([])
})

test("keeps remote nested links on the remote document", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  const errors: string[] = []
  const failures: string[] = []
  const reads: { directory: string; path: string }[] = []
  const remote: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  page.on("response", (response) => {
    if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`)
  })
  await page.route("https://example.com/docs/*", (route) => {
    remote.push(route.request().url())
    return route.fulfill({
      status: 200,
      contentType: "text/markdown; charset=utf-8",
      body: route.request().url().endsWith("/next.md") ? "# Remote next\n" : "# Remote index\n\n[Next page](next.md)\n",
    })
  })
  const overlay = await openPreview(page, "[Remote index](https://example.com/docs/index.md)", (input) => {
    reads.push(input)
    return { type: "text", content: markdown }
  })
  await expect(overlay.getByRole("heading", { name: "Remote index" })).toBeVisible()
  await overlay.locator('[data-slot="markdown-preview-button"]').click()
  const overlays = page.locator('[data-component="markdown-preview-overlay"]')
  await expect(overlays).toHaveCount(2)
  await expect(overlays.nth(1).getByRole("heading", { name: "Remote next" })).toBeVisible()
  expect(remote).toEqual(["https://example.com/docs/index.md", "https://example.com/docs/next.md"])
  expect(reads).toEqual([])
  await page.keyboard.press("Escape")
  await page.keyboard.press("Escape")
  await expect(overlays).toHaveCount(0)
  expect(errors).toEqual([])
  expect(failures).toEqual([])
})

for (const scheme of ["light", "dark"] as const) {
  test(`loads a previously unseen local image on first preview (${scheme})`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.emulateMedia({ colorScheme: scheme })
    const errors: string[] = []
    const failures: string[] = []
    const reads: string[] = []
    const wrongRoutes: string[] = []
    const image = Promise.withResolvers<void>()
    page.on("pageerror", (error) => errors.push(error.message))
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text())
    })
    page.on("response", (response) => {
      if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`)
    })
    await page.route("**/proof.svg", (route) => {
      wrongRoutes.push(route.request().url())
      return route.fulfill({ status: 404 })
    })
    const overlay = await openPreview(page, "[Image document](docs/images.md)", async (input) => {
      reads.push(input.path)
      if (input.path === "images/proof.svg") {
        await image.promise
        return {
          type: "binary",
          encoding: "base64",
          mimeType: "image/svg+xml",
          content: Buffer.from(
            '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80"><rect width="160" height="80" fill="#197d54"/><text x="18" y="46" fill="white">Preview image</text></svg>',
          ).toString("base64"),
        }
      }
      return { type: "text", content: "# Image preview\n\n![Preview proof](images/proof.svg)\n" }
    })
    await expect.poll(() => reads).toEqual(["docs/images.md", "images/proof.svg"])
    await expect(overlay.getByRole("img", { name: "Preview proof" })).not.toHaveAttribute("src")
    image.resolve()
    await expect
      .poll(() =>
        overlay
          .getByRole("img", { name: "Preview proof" })
          .evaluate((element: HTMLImageElement) => element.naturalWidth),
      )
      .toBe(160)
    await expect(overlay.getByRole("img", { name: "Preview proof" })).toBeVisible()
    const trigger = page.locator('[data-component="text-part"] [data-slot="markdown-preview-button"]')
    const bounds = await trigger.boundingBox()
    expect(bounds!.width).toBeGreaterThanOrEqual(28)
    expect(bounds!.height).toBeGreaterThanOrEqual(28)
    const scrim = await overlay.evaluate((element) => getComputedStyle(element).backgroundColor)
    expect(scrim).not.toBe("rgba(0, 0, 0, 0)")
    mkdirSync(screenshots, { recursive: true })
    await page.screenshot({ path: `${screenshots}/image-${scheme}.png`, fullPage: true })
    await page.keyboard.press("Escape")
    await expect(overlay).toHaveCount(0)
    await expect(trigger).toBeFocused()
    expect(wrongRoutes).toEqual([])
    expect(errors).toEqual([])
    expect(failures).toEqual([])
  })
}

test("closing a slow preview aborts its request and restores the background", async ({ page }) => {
  const response = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  const aborted = Promise.withResolvers<string>()
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("requestfailed", (request) => {
    if (request.url() === "https://example.com/slow.md") aborted.resolve(request.failure()?.errorText ?? "")
  })
  await page.route("https://example.com/slow.md", async (route) => {
    started.resolve()
    await response.promise
    await route.fulfill({ status: 200, contentType: "text/markdown", body: "# Late" })
  })
  const overlay = await openPreview(page, "[Slow preview](https://example.com/slow.md)")
  await started.promise
  await expect(overlay).toContainText("Loading preview...")
  await page.keyboard.press("Escape")
  await expect(overlay).toHaveCount(0)
  response.resolve()
  expect(await aborted.promise).toBe("net::ERR_ABORTED")
  await expect(page.getByRole("button", { name: "Preview markdown", exact: true })).toBeFocused()
  expect(
    await page
      .locator("body")
      .evaluate((body) => Array.from(body.children).some((child) => child instanceof HTMLElement && child.inert)),
  ).toBe(false)
  expect(errors).toEqual([])
})

test("localizes preview controls and errors in German", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.addInitScript(() => localStorage.setItem("opencode.global.dat:language", JSON.stringify({ locale: "de" })))
  const overlay = await openPreview(page, "[Verlauf](../history.md)")
  await expect(overlay).toContainText(
    "Markdown-Vorschau konnte nicht geladen werden: Dieser Dateipfad ist für eine Projektvorschau nicht erlaubt.",
  )
  await expect(overlay.getByRole("button", { name: "Herunterladen", exact: true })).toBeVisible()
  await overlay.getByRole("button", { name: "Schließen", exact: true }).click()
  await expect(overlay).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Markdown-Vorschau", exact: true })).toBeFocused()
  expect(errors).toEqual([])
})
