import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { readFileSync } from "node:fs"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectNoSmokeErrors, trackPageErrors } from "../utils/errors"
import { expectAppVisible } from "../utils/waits"

// Regression: pressing the composer Send button while a dictation is still
// transcribing must not leave the composer stuck on "Preparing message…".
// The send preparation resolves with the transcript once transcription
// finishes, then the normal prepared submit path sends the message. This
// includes a session that is currently working with the default "queue"
// follow-up setting: once the transcript exists, the prepared send must
// enqueue it like a typed send instead of waiting for the running turn.

test.use({
  video: "on",
  screenshot: "on",
  permissions: ["microphone"],
  launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
})

const directory = "C:/OpenCode/SpeechSendDuringTranscription"
const projectID = "proj_speech_send"
const sessionID = "ses_speech_send"
const transcriptText = "Bitte prüfe den Composer Send-Flow."

for (const scenario of ["idle-session", "busy-session"] as const) {
  test(`Send during transcription submits: ${scenario}`, async ({ page }) => {
    const errors = trackPageErrors(page)
    const promptRequests: unknown[] = []

    await mockOpenCodeServer(page, {
      directory,
      project: {
        id: projectID,
        worktree: directory,
        vcs: "git",
        name: "speech-send-during-transcription",
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
          slug: "speech-send-during-transcription",
          projectID,
          directory,
          title: "Speech send during transcription regression",
          version: "dev",
          time: { created: 1700000000000, updated: 1700000000000 },
        },
      ],
      sessionStatus:
        scenario === "busy-session"
          ? { generations: {}, data: { [sessionID]: { type: "busy" } } }
          : { generations: {}, data: { [sessionID]: { type: "idle" } } },
      events:
        scenario === "busy-session"
          ? () => [{ directory, payload: { id: "evt_speech_busy", type: "session.status", properties: { sessionID, status: { type: "busy" } } } }]
          : undefined,
      pageMessages: () => ({ items: [] }),
    })
    await mockComposerToolbarPlugins(page, ["speech-to-text-app"])

    // The transcription request stays pending until the test releases it, so
    // the UI is provably inside the transcription phase when Send is pressed.
    let releaseTranscription: (() => void) | undefined
    const transcriptionReleased = new Promise<void>((resolve) => {
      releaseTranscription = resolve
    })
    const transcribeStarted = new Promise<void>((resolve) => {
      page.route(/\/app\/host\/stt\/transcribe/, async (route) => {
        resolve()
        await transcriptionReleased
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: { "access-control-allow-origin": "*" },
          body: JSON.stringify({ ok: true, text: transcriptText }),
        })
      })
    })
    await page.route(/\/api\/session\/[^/]+\/prompt(?:\?|$)/, (route) => {
      promptRequests.push(JSON.parse(route.request().postData() ?? "{}"))
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({ data: { sessionID, messageID: "msg_prompt", admittedSeq: 1 } }),
      })
    })
    await page.addInitScript((chain) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.app-plugin.speech-to-text-app.settings.transcriptionChain",
        JSON.stringify(chain),
      )
    }, "model:opencode/claude-opus-4-6")

    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)

    const composer = await openSessionComposer(page)
    const mic = page.locator('[data-action="speech-to-text"]')
    await expectAppVisible(mic)

    // Start recording with the fake microphone and stop it so transcription begins.
    await mic.click()
    await expect(mic).toHaveAttribute("data-state", /recording|requesting-permission/, { timeout: 10_000 })
    await expect(mic).toHaveAttribute("data-state", "recording", { timeout: 10_000 })
    await mic.click()

    // Wait until the transcription request is in flight: Send is pressed
    // mid-transcription, exactly like the reported reproduction.
    await transcribeStarted
    await expect(mic).toHaveAttribute("data-state", "transcribing")

    const send = composer.locator('[data-action="prompt-submit"]')
    await expect(send).toBeEnabled()
    await send.click()

    const preparing = composer.getByText("Preparing message…", { exact: true })
    await expectAppVisible(preparing)

    // The transcription result arrives while the prepared send is pending.
    // The prepared send must now finish: submit the transcript and clear the
    // pending indicator instead of waiting forever.
    releaseTranscription?.()
    await expect
      .poll(() => promptRequests.length, { timeout: 8_000 })
      .toBeGreaterThan(0)
    await expect(preparing).toBeHidden({ timeout: 8_000 })
    expect(promptRequests[0]).toBeTruthy()
    expectNoSmokeErrors(errors, [], [])
  })
}

async function openSessionComposer(page: Page) {
  const composer = page.locator('[data-component="session-composer"]')
  const sessionRow = page
    .locator('[data-component="home-session-row"]')
    .filter({ hasText: "Speech send during transcription regression" })
    .first()
  await expectAppVisible(composer.or(sessionRow).first())
  if (!(await composer.isVisible())) {
    await expectAppVisible(sessionRow)
    await sessionRow.click()
  }
  await expectAppVisible(composer)
  return composer
}

async function mockComposerToolbarPlugins(page: Page, pluginIDs: string[]) {
  await page.route("**/app/plugins**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({
        plugins: pluginIDs.map((id) => ({
          id,
          spec: id,
          version: "1",
          module: `/app/plugin/${id}/1/index.js`,
          hash: id,
          ...JSON.parse(
            readFileSync(new URL(`../../../../.opencode/plugins/${id}/package.json`, import.meta.url), "utf8"),
          ).opencode.app,
        })),
      }),
    }),
  )
  for (const id of pluginIDs) {
    await page.route(`**/app/plugin/${id}/1/*.js*`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/javascript",
        headers: { "access-control-allow-origin": "*" },
        body: readFileSync(
          new URL(
            `../../../../.opencode/plugins/${id}/${new URL(route.request().url()).pathname.split("/").pop()}`,
            import.meta.url,
          ),
          "utf8",
        ),
      }),
    )
    await page.route(`**/app/plugin/${id}/1/assets/**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "image/svg+xml",
        headers: { "access-control-allow-origin": "*" },
        body: readFileSync(
          new URL(`../../../../.opencode/plugins/${id}/assets/${route.request().url().split("/").pop()}`, import.meta.url),
          "utf8",
        ),
      }),
    )
  }
}
