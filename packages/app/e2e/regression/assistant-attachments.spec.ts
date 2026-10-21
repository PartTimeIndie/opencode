import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { Buffer } from "node:buffer"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

// Feature 2 (narrow) — assistant-side attachment rendering. Tool-result
// attachments (from `attach`/`read`) must render inline on the assistant side:
// image (clickable -> fullscreen), video (inline player), file (download card).
test.use({ video: "on", screenshot: "on" })

const directory = "C:/OpenCode/AssistantAttachments"
const projectID = "proj_assistant_attachments"
const sessionID = "ses_assistant_attachments"
const IMG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mP8z8BQz0AEYBxVSF+FAP5FAxd9kT2/AAAAAElFTkSuQmCC"
const IMG_BASE64 = IMG.slice("data:image/png;base64,".length)

test("renders assistant image, video and file attachments in the timeline", async ({ page }, testInfo) => {
  const fileReads: string[] = []
  const strayRelativeImageRequests: string[] = []
  const proofNetworkFailures: string[] = []
  const userMsg = { id: "msg_user_1", sessionID, role: "user", time: { created: 1700000000000 } }
  const asstMsg = {
    id: "msg_asst_1",
    sessionID,
    role: "assistant",
    parentID: userMsg.id,
    time: { created: 1700000001000, completed: 1700000002000 },
    modelID: "stealth/ox-alpha",
    providerID: "openrouter",
    mode: "build",
    agent: "build",
    path: { cwd: directory, root: directory },
    cost: 0.01,
    tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
    variant: "max",
    finish: "stop",
  }

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "assistant-attachments",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "openrouter",
          name: "OpenRouter",
          models: {
            "stealth/ox-alpha": { id: "stealth/ox-alpha", name: "Ox Alpha", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["openrouter"],
      default: { providerID: "openrouter", modelID: "stealth/ox-alpha" },
    },
    sessions: [
      {
        id: sessionID,
        slug: "assistant-attachments",
        projectID,
        directory,
        title: "Assistant attachments",
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({
      items: [
        {
          info: userMsg,
          parts: [{ id: "prt_u_1", sessionID, messageID: userMsg.id, type: "text", text: "show me the deliverables" }],
        },
        {
          info: asstMsg,
          parts: [
            { id: "prt_a_text", sessionID, messageID: asstMsg.id, type: "text", text: "Here are my deliverables:" },
            {
              id: "prt_a_attach",
              sessionID,
              messageID: asstMsg.id,
              type: "tool",
              callID: "call_attach_1",
              tool: "attach",
              state: {
                status: "completed",
                input: { filePath: `${directory}/cursor-provider.png`, description: "Cursor provider QA" },
                output: "Attached cursor-provider.png (image/png).",
                title: "cursor-provider.png",
                metadata: {
                  filename: "cursor-provider.png",
                  filepath: `${directory}/cursor-provider.png`,
                  description: "Cursor provider QA",
                },
                time: { start: 1700000001500, end: 1700000001600 },
                attachments: [
                  {
                    mime: "image/png",
                    url: IMG,
                    filename: "cursor-provider.png",
                  },
                ],
              },
            },
            {
              id: "prt_a_attach_video",
              sessionID,
              messageID: asstMsg.id,
              type: "tool",
              callID: "call_attach_2",
              tool: "attach",
              state: {
                status: "completed",
                input: { filename: "demo.mp4", mime: "video/mp4" },
                output: "Attached demo.mp4 (video/mp4).",
                title: "demo.mp4",
                metadata: { filename: "demo.mp4" },
                time: { start: 1700000001600, end: 1700000001700 },
                attachments: [{ mime: "video/mp4", url: "data:video/mp4;base64,AAAA", filename: "demo.mp4" }],
              },
            },
            {
              id: "prt_a_attach_pdf",
              sessionID,
              messageID: asstMsg.id,
              type: "tool",
              callID: "call_attach_3",
              tool: "attach",
              state: {
                status: "completed",
                input: { filename: "report.pdf", mime: "application/pdf" },
                output: "Attached report.pdf (application/pdf).",
                title: "report.pdf",
                metadata: { filename: "report.pdf" },
                time: { start: 1700000001700, end: 1700000001800 },
                attachments: [
                  { mime: "application/pdf", url: "data:application/pdf;base64,JVBERi0=", filename: "report.pdf" },
                ],
              },
            },
            {
              id: "prt_a_proof_image",
              sessionID,
              messageID: asstMsg.id,
              type: "tool",
              callID: "call_attach_proof_image",
              tool: "attach",
              state: {
                status: "completed",
                input: { filePath: `${directory}/proof-image.png`, description: "Proof image", purpose: "proof" },
                output: "Attached proof proof-image.png (image/png, 68 B).",
                title: "proof-image.png",
                metadata: { filename: "proof-image.png", purpose: "proof" },
                time: { start: 1700000001800, end: 1700000001900 },
                attachments: [
                  {
                    mime: "image/png",
                    url: "/app/attachment/proof/ses_assistant_attachments/proof-image.png",
                    filename: "proof-image.png",
                  },
                ],
              },
            },
            {
              id: "prt_a_proof_video",
              sessionID,
              messageID: asstMsg.id,
              type: "tool",
              callID: "call_attach_proof_video",
              tool: "attach",
              state: {
                status: "completed",
                input: { filePath: `${directory}/proof-video.mp4`, description: "Proof video", purpose: "proof" },
                output: "Attached proof proof-video.mp4 (video/mp4, 16 B).",
                title: "proof-video.mp4",
                metadata: { filename: "proof-video.mp4", purpose: "proof" },
                time: { start: 1700000001900, end: 1700000002000 },
                attachments: [
                  {
                    mime: "video/mp4",
                    url: "/app/attachment/proof/ses_assistant_attachments/proof-video.mp4",
                    filename: "proof-video.mp4",
                  },
                ],
              },
            },
            {
              id: "prt_a_rejected_proof",
              sessionID,
              messageID: asstMsg.id,
              type: "tool",
              callID: "call_attach_rejected_proof",
              tool: "attach",
              state: {
                status: "completed",
                input: {
                  data: "data:text/plain;base64,c2VjcmV0LXByb29m",
                  filePath: `${directory}/secret-proof.txt`,
                  url: "file:///secret-proof.txt",
                  filename: "rejected-proof.txt",
                  purpose: "proof",
                },
                output: "Proof attachment is too large (2.0 KB > 1.0 KB).",
                title: "rejected-proof.txt",
                metadata: { filename: "rejected-proof.txt", purpose: "proof" },
                time: { start: 1700000002000, end: 1700000002100 },
              },
            },
            {
              id: "prt_a_markdown",
              sessionID,
              messageID: asstMsg.id,
              type: "text",
              text: "Evidence\n\n![Cursor provider QA](file:///C:/OpenCode/AssistantAttachments/cursor-provider.png)",
            },
            {
              id: "prt_a_markdown_relative",
              sessionID,
              messageID: asstMsg.id,
              type: "text",
              text: "Relative evidence\n\n![MCP availability desktop](packages/app/test-results/mcp-settings-project-availability.png)",
            },
          ],
        },
      ],
    }),
    onFileRead: ({ path }) => {
      fileReads.push(path)
      return path === "packages/app/test-results/mcp-settings-project-availability.png"
        ? { type: "binary", content: IMG_BASE64, encoding: "base64", mimeType: "image/png" }
        : { type: "text", content: "" }
    },
  })

  await page.route("**/app/attachment/proof/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname
    const body = pathname.endsWith(".png") ? Buffer.from(IMG_BASE64, "base64") : Buffer.from("proof-video-bytes")
    const contentType = pathname.endsWith(".png") ? "image/png" : "video/mp4"
    const range = route.request().headers().range
    if (range?.startsWith("bytes=")) {
      const start = Number(range.slice("bytes=".length).split("-")[0] || 0)
      return route.fulfill({
        status: 206,
        contentType,
        headers: {
          "accept-ranges": "bytes",
          "content-range": `bytes ${start}-${body.byteLength - 1}/${body.byteLength}`,
        },
        body: body.subarray(start),
      })
    }
    return route.fulfill({ status: 200, contentType, headers: { "accept-ranges": "bytes" }, body })
  })

  await page.addInitScript(() => {
    localStorage.setItem("opencode.global.dat:language", JSON.stringify({ locale: "en" }))
    localStorage.setItem("settings.v3", JSON.stringify({}))
  })
  page.on("request", (request) => {
    const url = request.url()
    if (url.includes("/file/content")) return
    if (!url.endsWith("/packages/app/test-results/mcp-settings-project-availability.png")) return
    strayRelativeImageRequests.push(url)
  })
  page.on("requestfailed", (request) => {
    if (request.url().includes("/app/attachment/proof/")) proofNetworkFailures.push(request.url())
  })
  page.on("response", (response) => {
    if (response.url().includes("/app/attachment/proof/") && response.status() >= 400)
      proofNetworkFailures.push(`${response.status()} ${response.url()}`)
  })

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  const composer = page.locator('[data-component="session-composer"]')
  const sessionRow = page
    .locator('[data-component="home-session-row"]')
    .filter({ hasText: "Assistant attachments" })
    .first()
  await expectAppVisible(composer.or(sessionRow).first())
  if (!(await composer.isVisible())) await sessionRow.click()
  await expectAppVisible(composer)

  // Assistant message text renders, then its tool attachments render inline.
  const assistantImage = page.getByRole("button", { name: "cursor-provider.png" })
  const completedStamp = await page.evaluate(() =>
    new Intl.DateTimeFormat("en", { timeStyle: "short" }).format(1700000002000),
  )
  await expect(page.getByText("Here are my deliverables:")).toBeVisible()
  await expect(page.locator('[data-slot="text-part-meta"]')).toContainText(completedStamp)
  await expect(
    page.locator('[data-component="attach-tool-renderer"][data-attachment-kind="image"]').first(),
  ).toBeVisible()
  await expect(assistantImage).toBeVisible()
  await expect(page.locator('[data-attachment-inline="video"]').first()).toBeVisible()
  await expect(page.locator('[data-attachment-inline="file"]')).toContainText("report.pdf")
  const proofImage = page
    .locator('[data-component="attach-tool-renderer"][data-attachment-kind="image"]')
    .filter({ hasText: "proof-image.png" })
  const proofVideo = page
    .locator('[data-component="attach-tool-renderer"][data-attachment-kind="video"]')
    .filter({ hasText: "proof-video.mp4" })
  await expect(proofImage.getByText("Proof", { exact: true })).toBeVisible()
  await expect(proofImage.locator('[data-attachment-inline="image"]')).toBeVisible()
  await expect(proofImage.locator("img")).toHaveAttribute("src", /\/app\/attachment\/proof\/.*proof-image\.png/)
  await expect(proofVideo.getByText("Proof", { exact: true })).toBeVisible()
  await expect(proofVideo.locator('[data-attachment-inline="video"]')).toBeVisible()
  await expect(proofVideo.locator("video")).toHaveAttribute("src", /\/app\/attachment\/proof\/.*proof-video\.mp4/)
  await expect(page.getByText("data:text/plain")).toHaveCount(0)
  await expect(page.getByText("secret-proof.txt")).toHaveCount(0)
  await expect(page.locator('[data-component="markdown"] img[alt="Cursor provider QA"]')).toHaveAttribute("src", IMG)
  await expect.poll(() => fileReads).toContain("packages/app/test-results/mcp-settings-project-availability.png")
  await expect(page.locator('[data-component="markdown"] img[alt="MCP availability desktop"]')).toHaveAttribute(
    "src",
    IMG,
  )
  expect(strayRelativeImageRequests).toEqual([])
  await page.waitForTimeout(400)

  // Click the image -> fullscreen overlay.
  await assistantImage.click()
  await expect(page.locator('[data-component="attach-fullscreen-overlay"] img')).toBeVisible()
  await page.keyboard.press("Escape")
  await proofImage.scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath("proof-attachments-desktop.png"), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(proofImage.getByText("Proof", { exact: true })).toBeVisible()
  await expect(proofVideo.getByText("Proof", { exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath("proof-attachments-mobile.png"), fullPage: true })
  expect(proofNetworkFailures).toEqual([])
  await page.waitForTimeout(500)
})

test("renders managed user image, video, audio and generic attachments inline", async ({ page }, testInfo) => {
  const user = { id: "msg_user_image", sessionID, role: "user", time: { created: 1700000000000 } }
  const assistant = {
    id: "msg_asst_image",
    sessionID,
    role: "assistant",
    parentID: user.id,
    time: { created: 1700000001000, completed: 1700000002000 },
    modelID: "stealth/ox-alpha",
    providerID: "openrouter",
    mode: "build",
    agent: "build",
    path: { cwd: directory, root: directory },
    cost: 0,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
  }
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "assistant-attachments",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "openrouter",
          name: "OpenRouter",
          models: {
            "stealth/ox-alpha": { id: "stealth/ox-alpha", name: "Ox Alpha", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["openrouter"],
      default: { providerID: "openrouter", modelID: "stealth/ox-alpha" },
    },
    sessions: [
      {
        id: sessionID,
        slug: "assistant-attachments",
        projectID,
        directory,
        title: "User inline attachments",
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({
      items: [
        {
          info: user,
          parts: [
            { id: "prt_user_text", sessionID, messageID: user.id, type: "text", text: "attached screenshot" },
            {
              id: "prt_user_image",
              sessionID,
              messageID: user.id,
              type: "file",
              mime: "image/png",
              filename: "user-upload.png",
              url: "attachment://att_user_image",
            },
            {
              id: "prt_user_video",
              sessionID,
              messageID: user.id,
              type: "file",
              mime: "video/mp4",
              filename: "user-clip.mp4",
              url: "attachment://att_user_video",
            },
            {
              id: "prt_user_audio",
              sessionID,
              messageID: user.id,
              type: "file",
              mime: "audio/mpeg",
              filename: "user-voice.mp3",
              url: "attachment://att_user_audio",
            },
            {
              id: "prt_user_file",
              sessionID,
              messageID: user.id,
              type: "file",
              mime: "application/octet-stream",
              filename: "user-data.bin",
              url: "attachment://att_user_file",
            },
          ],
        },
        {
          info: assistant,
          parts: [
            {
              id: "prt_asst_text",
              sessionID,
              messageID: assistant.id,
              type: "text",
              text: "I can see the attached screenshot.",
            },
          ],
        },
      ],
    }),
  })
  await page.route(/\/app\/attachment\/(?:preview|content)\/att_user_image/, (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from(IMG_BASE64, "base64") }),
  )
  await page.route(/\/app\/attachment\/content\/att_user_video/, (route) =>
    route.fulfill({ status: 200, contentType: "video/mp4", body: Buffer.from("inline-video") }),
  )
  await page.route(/\/app\/attachment\/content\/att_user_audio/, (route) =>
    route.fulfill({ status: 200, contentType: "audio/mpeg", body: Buffer.from("inline-audio") }),
  )
  await page.route(/\/app\/attachment\/content\/att_user_file/, (route) =>
    route.fulfill({ status: 200, contentType: "application/octet-stream", body: Buffer.from("inline-file") }),
  )
  await page.addInitScript(
    ({ directory, dirBase64, sessionID }) => {
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
  const payload = await page.evaluate(async (sessionID) => {
    const response = await fetch(`http://127.0.0.1:4096/api/session/${sessionID}/message?limit=80`)
    return response.json()
  }, sessionID)
  expect(payload.data.find((message: { id?: string }) => message.id === user.id)?.files).toEqual([
    { uri: "attachment://att_user_image", mime: "image/png", name: "user-upload.png" },
    { uri: "attachment://att_user_video", mime: "video/mp4", name: "user-clip.mp4" },
    { uri: "attachment://att_user_audio", mime: "audio/mpeg", name: "user-voice.mp3" },
    { uri: "attachment://att_user_file", mime: "application/octet-stream", name: "user-data.bin" },
  ])
  const image = page.locator('[data-slot="user-message-attachment-image"]')
  await expect(image).toHaveCount(1)
  await expect(image).toHaveAttribute("src", /^blob:/)
  await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBeGreaterThan(0)
  await page.locator('[data-slot="user-message-attachment"][data-type="image"]').click()
  await expect(page.locator('[data-component="image-preview"] img')).toHaveAttribute("src", /^blob:/)
  await page.keyboard.press("Escape")
  await expect(page.locator('[data-component="image-preview"]')).toHaveCount(0)
  await expect(page.locator('[data-slot="user-message-attachment-video"]')).toHaveAttribute("src", /^blob:/)
  await expect(page.locator('[data-slot="user-message-attachment-audio"]')).toHaveAttribute("src", /^blob:/)
  await expect(page.locator('[data-slot="user-message-attachment-file"]')).toHaveAttribute("href", /^blob:/)
  await expect(page.locator('[data-slot="user-message-attachment-file"]')).toHaveAttribute("download", "user-data.bin")
  await page.screenshot({ path: testInfo.outputPath("user-inline-attachments-desktop.png"), fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  const attachments = page.locator('[data-slot="user-message-attachments"]')
  await expect(attachments.locator('[data-type="image"]')).toBeVisible()
  await expect(attachments.locator('[data-type="video"]')).toBeVisible()
  await expect(attachments.locator('[data-type="audio"]')).toBeVisible()
  await expect(attachments.locator('[data-type="file"]')).toBeVisible()
  await attachments.screenshot({ path: testInfo.outputPath("user-inline-attachments-mobile.png") })
})
