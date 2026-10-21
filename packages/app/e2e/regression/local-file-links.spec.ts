import { expect, test, type Page } from "@playwright/test"
import { resolve } from "node:path"
import { mkdir } from "node:fs/promises"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { trackPageErrors } from "../utils/errors"

const sanitizerURL = `/@fs/${resolve(import.meta.dirname, "../../../ui/src/components/markdown-sanitize.ts").replace(/\\/g, "/")}`
const clickHandlerURL = `/@fs/${resolve(import.meta.dirname, "../../../desktop/src/renderer/external-links.ts").replace(/\\/g, "/")}`
const href = "file:///C:/Projects/example/docs/sample-report.pdf"

async function sanitize(page: Page, html: string) {
  return page.evaluate(
    async ({ moduleURL, html }) => {
      const { sanitizeMarkdown } = await import(moduleURL)
      const root = document.createElement("div")
      const sanitized = sanitizeMarkdown(html)
      root.innerHTML = sanitized
      const link = root.querySelector("a")
      return {
        sanitized,
        href: link?.getAttribute("href"),
        className: link?.className,
        rel: link?.rel,
        resolvedHref: link?.href,
      }
    },
    { moduleURL: sanitizerURL, html },
  )
}

test.describe("markdown sanitizer in real Chromium", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/local-file-sanitizer-qa", (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html><html><body></body></html>" }),
    )
    await page.goto("/local-file-sanitizer-qa")
  })

  test("preserves a local PDF destination", async ({ page }) => {
    expect(
      (await sanitize(page, `<a href="${href}" class="external-link" target="_blank">Beispielbericht öffnen</a>`))
        .href,
    ).toBe(href)
  })

  test("preserves encoded filenames and marks raw HTML file anchors for desktop handling", async ({ page }) => {
    const encoded = "file:///C:/Meine%20Dateien/Pr%C3%BCfung%23%25.pdf#page=2"
    const link = await sanitize(page, `<a href="${encoded}">PDF</a>`)
    expect(link.href).toBe(encoded)
    expect(link.className?.split(" ")).toContain("external-link")
    expect(link.rel).toContain("noopener")
    expect(link.rel).toContain("noreferrer")
    expect((await sanitize(page, '<a href="FILE:///C:/report.pdf">PDF</a>')).className).toContain("external-link")
  })

  test("keeps local file loading blocked outside explicit anchors", async ({ page }) => {
    expect(
      (await sanitize(page, '<img src="file:///C:/secret.png"><iframe src="file:///C:/secret.pdf"></iframe>'))
        .sanitized,
    ).not.toContain("file:")
  })

  test("does not allow scripts, data links, or remote file hosts", async ({ page }) => {
    for (const value of [
      "javascript:alert(1)",
      "data:text/html,unsafe",
      "file://server/share/file.pdf",
      "file:////server/share/file.pdf",
    ]) {
      expect((await sanitize(page, `<a href="${value}">Unsafe</a>`)).href).toBeNull()
    }
    expect(
      (
        await sanitize(
          page,
          '<script>alert(1)</script><a href="https://opencode.ai" onclick="alert(1)" target="_blank">Docs</a>',
        )
      ).sanitized,
    ).not.toContain("alert")
  })

  test("preserves normal external and internal navigation", async ({ page }) => {
    expect((await sanitize(page, '<a href="https://opencode.ai" target="_blank">Docs</a>')).resolvedHref).toBe(
      "https://opencode.ai/",
    )
    expect((await sanitize(page, '<a href="/session/example">Session</a>')).href).toBe("/session/example")
  })

  test("desktop click handler opens once, handles nested targets and respects handled clicks", async ({ page }) => {
    const opened = await page.evaluate(
      async ({ sanitizerURL, clickHandlerURL, href }) => {
        const { sanitizeMarkdown } = await import(sanitizerURL)
        const { handleExternalLinkClick } = await import(clickHandlerURL)
        const root = document.createElement("div")
        root.innerHTML = sanitizeMarkdown(`<a href="${href}"><span>PDF</span></a>`)
        document.body.append(root)
        const opened: string[] = []
        root.addEventListener("click", (event) => handleExternalLinkClick(event, (url: string) => opened.push(url)))
        root.querySelector("span")!.click()
        root.addEventListener("click", (event) => event.preventDefault(), { capture: true })
        root.querySelector("span")!.click()
        document.dispatchEvent(new MouseEvent("click", { bubbles: true }))
        return opened
      },
      { sanitizerURL, clickHandlerURL, href },
    )
    expect(opened).toEqual([href])
  })
})

test("session timeline retains the local PDF link on desktop and narrow viewports", async ({ page }, testInfo) => {
  const errors = trackPageErrors(page)
  const failedRequests: string[] = []
  page.on("requestfailed", (request) => {
    if (!request.failure()?.errorText.includes("ERR_ABORTED"))
      failedRequests.push(`${request.url()}: ${request.failure()?.errorText}`)
  })
  const directory = "C:/OpenCode/LocalFileLinksQA"
  const sessionID = "ses_local_file_links_qa"
  const userID = "msg_local_file_user"
  const assistantID = "msg_local_file_assistant"
  const now = 1_800_000_000_000
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: "proj_local_file_links",
      worktree: directory,
      vcs: "git",
      name: "Local file links",
      time: { created: now, updated: now },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "Test",
          models: { "gpt-test": { id: "gpt-test", name: "Test", limit: { context: 200_000 } } },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "gpt-test" },
    },
    sessions: [
      {
        id: sessionID,
        slug: "local-file-links",
        projectID: "proj_local_file_links",
        directory,
        title: "Local PDF links",
        version: "dev",
        time: { created: now, updated: now },
      },
    ],
    pageMessages: () => ({
      items: [
        {
          info: { id: userID, sessionID, role: "user", time: { created: now } },
          parts: [
            {
              id: "prt_local_file_user",
              sessionID,
              messageID: userID,
              type: "text",
              text: "Öffne bitte die lokale PDF.",
            },
          ],
        },
        {
          info: {
            id: assistantID,
            sessionID,
            role: "assistant",
            parentID: userID,
            time: { created: now + 1, completed: now + 2 },
            modelID: "gpt-test",
            providerID: "opencode",
            mode: "build",
            agent: "build",
            path: { cwd: directory, root: directory },
            cost: 0,
            tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
            finish: "stop",
          },
          parts: [
            {
              id: "prt_local_file_assistant",
              sessionID,
              messageID: assistantID,
              type: "text",
              text: `Die PDF ist bereit: [Prototype-Fund-Antrag öffnen](${href})\n\n[Lokale Notizen](file:///C:/notes.md)\n\n[Remote Notizen](https://example.com/notes.md)`,
            },
          ],
        },
      ],
    }),
  })
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`${base64Encode(directory)}/session/${sessionID}`)
  const link = page
    .locator('[data-component="markdown"] a.external-link')
    .filter({ hasText: "Prototype-Fund-Antrag öffnen" })
  await expect(link).toBeVisible()
  await expect(link).toHaveAttribute("href", href)
  const localNotes = page.getByRole("link", { name: "Lokale Notizen", exact: true })
  await expect(localNotes).toHaveAttribute("href", "file:///C:/notes.md")
  await expect(localNotes.locator("..").locator('[data-slot="markdown-preview-button"]')).toHaveCount(0)
  const remoteNotes = page.getByRole("link", { name: "Remote Notizen", exact: true })
  await expect(remoteNotes.locator("..").locator('[data-slot="markdown-preview-button"]')).toHaveCount(1)
  const screenshots = resolve(import.meta.dirname, "../../../../docs/workitems/screenshots/local-file-links")
  await mkdir(screenshots, { recursive: true })
  const desktopScreenshot = resolve(screenshots, "source-desktop.png")
  await page.screenshot({ path: desktopScreenshot })
  await testInfo.attach("local-pdf-link-desktop", { path: desktopScreenshot, contentType: "image/png" })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(link).toBeVisible()
  await expect(link).toHaveAttribute("href", href)
  const narrowScreenshot = resolve(screenshots, "source-narrow.png")
  await page.screenshot({ path: narrowScreenshot })
  await testInfo.attach("local-pdf-link-narrow", { path: narrowScreenshot, contentType: "image/png" })
  expect(errors).toEqual([])
  expect(failedRequests).toEqual([])
})
