import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { fixture } from "../smoke/session-timeline.fixture"
import { expectNoSmokeErrors, trackPageErrors } from "../utils/errors"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/ComposerAttachmentInputs"
const projectID = "proj_composer_attachment_inputs"
const sessionID = "ses_composer_attachment_inputs"

test.use({ video: "on", screenshot: "on" })

test("submits clipboard, dropped, picked, PDF, and large-text attachments through the normal composer", async ({
  page,
  context,
}, testInfo) => {
  const errors = trackPageErrors(page)
  const networkFailures: string[] = []
  const prompts: unknown[] = []
  page.on("requestfailed", (request) =>
    networkFailures.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`),
  )
  page.on("response", (response) => {
    if (response.status() >= 400) networkFailures.push(`${response.status()} ${response.request().method()} ${response.url()}`)
  })
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "composer-attachment-inputs",
      time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
      sandboxes: [],
    },
    provider: fixture.provider,
    agents: [{ name: "build", mode: "primary" }],
    sessions: [
      {
        id: sessionID,
        slug: "composer-attachment-inputs",
        projectID,
        directory,
        title: "Composer Attachment Inputs",
        version: "dev",
        time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
    onSessionPrompt: (input) => {
      prompts.push(input)
      return { data: { sessionID: input.sessionID, messageID: "msg_attachment_inputs", admittedSeq: 1 } }
    },
  })
  await page.addInitScript(
    ({ directory, dirBase64, sessionID }) => {
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
        JSON.stringify([{ type: "session", server: "http://127.0.0.1:4096", dirBase64, sessionId: sessionID }]),
      )
    },
    { directory, dirBase64: base64Encode(directory), sessionID },
  )

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  const composer = page.locator('[data-component="session-composer"]')
  const input = composer.locator('[data-component="prompt-input"]')
  await expectAppVisible(input)

  await context.grantPermissions(["clipboard-read", "clipboard-write"])
  await page.evaluate(async (png) => {
    const bytes = Uint8Array.from(atob(png), (character) => character.charCodeAt(0))
    await navigator.clipboard.write([new ClipboardItem({ "image/png": new Blob([bytes], { type: "image/png" }) })])
  }, "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
  await input.click()
  await input.press("Control+V")
  await expect(composer.locator("img")).toHaveCount(1)
  await page.screenshot({ path: testInfo.outputPath("ctrl-v-single-attachment.png") })
  await expect(composer.getByRole("button", { name: "Remove attachment" })).toHaveCount(1)
  await composer.getByRole("button", { name: "Remove attachment" }).click()
  await expect(composer.locator("img")).toHaveCount(0)

  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
  const pasteImage = (name: string, trailingByte?: number, duplicateDelay?: number) =>
    input.evaluate(
      (element, image) => {
        const paste = () => {
          const transfer = new DataTransfer()
          const bytes = Uint8Array.from(atob(image.png), (character) => character.charCodeAt(0))
          const file = new File(
            image.trailingByte === undefined ? [bytes] : [bytes, Uint8Array.of(image.trailingByte)],
            image.name,
            { type: "image/png" },
          )
          // Some clipboard providers expose the same image through multiple file items.
          transfer.items.add(file)
          transfer.items.add(file)
          element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }))
        }
        if (image.duplicateDelay !== undefined) {
          const observer = new MutationObserver(() => {
            const rendered = Array.from(element.closest("form")?.querySelectorAll("img") ?? []).some(
              (item) => item.getAttribute("alt") === image.name,
            )
            if (!rendered) return
            observer.disconnect()
            window.setTimeout(paste, image.duplicateDelay)
          })
          observer.observe(element.closest("form") ?? element, { childList: true, subtree: true })
        }
        paste()
      },
      { png, name, trailingByte, duplicateDelay },
    )

  // Electron can redeliver the same physical Ctrl+V after the first image has rendered and the short event guard expired.
  await pasteImage("clipboard.png", undefined, 250)
  await page.waitForTimeout(400)
  await page.screenshot({ path: testInfo.outputPath("delayed-duplicate-single-attachment.png") })
  await expect(composer.getByText("clipboard.png", { exact: true })).toHaveCount(1)
  await pasteImage("different.png", 0)
  await expect(composer.getByText("different.png", { exact: true })).toHaveCount(1)
  await expect(composer.getByRole("button", { name: "Remove attachment" })).toHaveCount(2)
  await expect
    .poll(() => composer.locator('img[alt="clipboard.png"]').evaluate((image) => (image as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0)

  await composer.getByRole("button", { name: "Remove attachment" }).last().click()
  await expect(composer.getByText("different.png", { exact: true })).toHaveCount(0)
  await page.waitForTimeout(125)
  await expect(composer.getByText("clipboard.png", { exact: true })).toHaveCount(1)
  await page.screenshot({ path: testInfo.outputPath("duplicate-delivery-single-attachment.png") })

  await composer.getByRole("button", { name: "Remove attachment" }).click()
  await expect(composer.getByText("clipboard.png", { exact: true })).toHaveCount(0)
  await page.waitForTimeout(125)
  await pasteImage("clipboard.png")
  await expect(composer.getByText("clipboard.png", { exact: true })).toHaveCount(1)

  await composer.getByRole("button", { name: "Remove attachment" }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await pasteImage("mobile.png", 1, 250)
  await page.waitForTimeout(400)
  await expect(composer.getByText("mobile.png", { exact: true })).toHaveCount(1)
  await page.screenshot({ path: testInfo.outputPath("delayed-duplicate-single-attachment-mobile.png") })
  await composer.getByRole("button", { name: "Remove attachment" }).click()
  await page.setViewportSize({ width: 1280, height: 720 })
  await pasteImage("clipboard.png")
  await expect(composer.getByText("clipboard.png", { exact: true })).toHaveCount(1)

  await page.evaluate(() => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(["%PDF-1.7\n1 0 obj\n"], "dropped.pdf", { type: "application/pdf" }))
    transfer.items.add(new File(["x".repeat(300 * 1024)], "large-dropped.txt", { type: "text/plain" }))
    document.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }))
  })
  await expect(composer.getByText("dropped.pdf", { exact: true })).toBeVisible()
  await expect(composer.getByText("large-dropped.txt", { exact: true })).toBeVisible()

  const chooser = page.waitForEvent("filechooser")
  await composer.locator('[data-action="prompt-attach"]').click()
  await (
    await chooser
  ).setFiles({
    name: "picked-local.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"source":"picker"}\n'),
  })
  await expect(composer.getByText("picked-local.json", { exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath("composer-attachments.png") })

  await input.fill("Inspect every attachment")
  await composer.locator('[data-action="prompt-submit"]').last().click()
  await expect.poll(() => prompts.length).toBe(1)

  const body = (prompts[0] as { body?: { prompt?: { files?: { name?: string; mime?: string; uri?: string }[] } } }).body
  expect(body?.prompt?.files?.map((file) => [file.name, file.mime])).toEqual([
    ["clipboard.png", "image/png"],
    ["dropped.pdf", "application/pdf"],
    ["large-dropped.txt", "text/plain"],
    ["picked-local.json", "text/plain"],
  ])
  expect(body?.prompt?.files?.every((file) => file.uri?.startsWith("data:"))).toBe(true)
  await testInfo.attach("console-errors", {
    body: Buffer.from(JSON.stringify(errors, null, 2)),
    contentType: "application/json",
  })
  await testInfo.attach("network-failures", {
    body: Buffer.from(JSON.stringify(networkFailures, null, 2)),
    contentType: "application/json",
  })
  expect(networkFailures).toEqual([])
  expectNoSmokeErrors(errors, [], [])
})
