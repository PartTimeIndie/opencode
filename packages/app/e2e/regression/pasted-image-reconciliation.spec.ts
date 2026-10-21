import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { fixture } from "../smoke/session-timeline.fixture"
import { expectNoSmokeErrors, trackPageErrors } from "../utils/errors"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/PastedImageReconciliation"
const sessionID = "ses_pasted_image_reconciliation"
const projectID = "proj_pasted_image_reconciliation"
const messageID = "msg_pasted_image_reconciliation"

test.use({ video: "on", screenshot: "on" })

test("keeps two pasted images single after a delayed legacy echo and V2 refresh", async ({
  page,
  context,
}, testInfo) => {
  const errors = trackPageErrors(page)
  const networkFailures: string[] = []
  const navigationAborts: string[] = []
  const events: unknown[] = []
  const files: { name?: string; mime: string; uri: string }[] = []
  let admittedID = messageID
  let reads = 0
  let delivered = 0
  let reloading = false
  page.on("requestfailed", (request) => {
    const failure = `${request.method()} ${request.url()} ${request.failure()?.errorText}`
    // Only explained reload cancellations are informational: local Vite assets
    // and fire-and-forget perf telemetry. Session/API/media failures still fail.
    const url = new URL(request.url())
    // Vite can also cancel these exact resources during concurrent workspace HMR.
    // The final rendered images are checked below; other asset failures stay fatal.
    const canceledAsset =
      url.origin === new URL(testInfo.project.use.baseURL!).origin &&
      (url.pathname === "/src/index.css" ||
        url.pathname.endsWith("/packages/ui/src/components/provider-icons/sprite.svg"))
    const canceledTelemetry =
      request.method() === "POST" && url.origin === "http://127.0.0.1:4096" && url.pathname === "/perf/record"
    if (request.failure()?.errorText === "net::ERR_ABORTED" && (canceledAsset || (reloading && canceledTelemetry))) {
      navigationAborts.push(failure)
      return
    }
    networkFailures.push(failure)
  })
  page.on("response", (response) => {
    if (response.status() >= 400) networkFailures.push(`${response.status()} ${response.url()}`)
  })
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "Pasted image reconciliation",
      time: { created: 1, updated: 1 },
      sandboxes: [],
    },
    provider: fixture.provider,
    agents: [{ name: "build", mode: "primary" }],
    sessions: [
      {
        id: sessionID,
        slug: sessionID,
        projectID,
        directory,
        title: "Pasted image reconciliation",
        version: "dev",
        time: { created: 1, updated: 1 },
      },
    ],
    eventRetry: 25,
    events: () => {
      const next = events.splice(0)
      delivered += next.length
      return next
    },
    pageMessages: () => {
      reads += 1
      return {
        items:
          files.length === 0
            ? []
            : [
                {
                  info: {
                    id: admittedID,
                    sessionID,
                    role: "user",
                    time: { created: 10 },
                    agent: "build",
                    model: fixture.provider.default,
                  },
                  parts: [
                    {
                      id: "prt_text",
                      sessionID,
                      messageID: admittedID,
                      type: "text",
                      text: "Inspect these two images",
                    },
                    ...files.map((file, index) => ({
                      id: `prt_image_${index}`,
                      sessionID,
                      messageID: admittedID,
                      type: "file",
                      mime: file.mime,
                      filename: file.name,
                      url: file.uri,
                    })),
                  ],
                },
              ],
      }
    },
    onSessionPrompt: (input) => {
      const body = input.body as { id: string; prompt: { files: typeof files } }
      admittedID = body.id
      files.push(...(body.prompt.files ?? []))
      events.push({
        directory,
        payload: {
          type: "session.next.message.created",
          properties: { sessionID, messageID: admittedID, timestamp: 10 },
        },
      })
      return { data: { sessionID, messageID: admittedID, admittedSeq: 1 } }
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
  for (const byte of [0, 1]) {
    await page.evaluate(async (byte) => {
      const canvas = document.createElement("canvas")
      canvas.width = 80
      canvas.height = 48
      const drawing = canvas.getContext("2d")!
      drawing.fillStyle = byte === 0 ? "#ef4444" : "#3b82f6"
      drawing.fillRect(0, 0, canvas.width, canvas.height)
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), "image/png"))
      await navigator.clipboard.write([
        new ClipboardItem({
          "image/png": blob,
        }),
      ])
    }, byte)
    await input.click()
    await input.press("Control+V")
    await expect(composer.locator("img")).toHaveCount(byte + 1)
  }
  await input.fill("Inspect these two images")
  const beforeSubmit = reads
  await composer.locator('[data-action="prompt-submit"]').last().click()
  await expect.poll(() => files.length).toBe(2)
  await expect.poll(() => reads).toBeGreaterThan(beforeSubmit)
  const images = page.locator('[data-slot="user-message-attachments"] img')
  await expect(images).toHaveCount(2)
  // The optimistic overlay has already been confirmed. A late compatibility
  // event must not reintroduce its random part IDs next to the V2 file slots.
  const beforeEcho = delivered
  events.push(
    ...files.map((file, index) => ({
      directory,
      payload: {
        type: "message.part.updated",
        properties: {
          part: {
            id: `prt_late_image_${index}`,
            sessionID,
            messageID: admittedID,
            type: "file",
            mime: file.mime,
            filename: file.name,
            url: file.uri,
          },
        },
      },
    })),
  )
  await expect.poll(() => delivered).toBeGreaterThanOrEqual(beforeEcho + files.length)
  // SSE delivery is queued by the app; retain the original red check's settling
  // interval so count assertions do not pass before the echo was processed.
  await page.waitForTimeout(300)
  await page.screenshot({ path: testInfo.outputPath("delayed-echo-desktop.png") })
  await expect(images).toHaveCount(2)
  const beforeRefresh = reads
  events.push({
    directory,
    payload: {
      type: "session.next.message.updated",
      properties: { sessionID, messageID: admittedID, timestamp: 20 },
    },
  })
  await expect.poll(() => reads).toBeGreaterThan(beforeRefresh)
  await expect(images).toHaveCount(2)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: testInfo.outputPath("delayed-echo-mobile.png") })
  await expect(images).toHaveCount(2)
  await expect
    .poll(() => images.evaluateAll((items) => items.every((item) => (item as HTMLImageElement).naturalWidth > 0)))
    .toBe(true)
  reloading = true
  await page.reload()
  await expectAppVisible(page.locator('[data-component="session-composer"]'))
  await expect(images).toHaveCount(2)
  await expect
    .poll(() => images.evaluateAll((items) => items.every((item) => (item as HTMLImageElement).naturalWidth > 0)))
    .toBe(true)
  reloading = false
  await testInfo.attach("console-errors", { body: JSON.stringify(errors), contentType: "application/json" })
  await testInfo.attach("network-failures", { body: JSON.stringify(networkFailures), contentType: "application/json" })
  await testInfo.attach("navigation-aborts", {
    body: JSON.stringify(navigationAborts),
    contentType: "application/json",
  })
  expect(networkFailures).toEqual([])
  expectNoSmokeErrors(errors, [], [])
})
