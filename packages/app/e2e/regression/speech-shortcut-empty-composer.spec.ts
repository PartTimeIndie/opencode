import { readFileSync } from "node:fs"
import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"

// Regression for the reported bug: Ctrl+R (Record speech) must start recording
// in the normal agent tab even when nothing has been typed yet. Two defects
// made the shortcut silently do nothing:
// 1. While a brand-new empty session (draft tab) was active, the plugin host
//    reported no navigation at all, so the shortcut could not resolve a
//    destination even though the microphone button worked.
// 2. The plugin's idle double-press polish consumed a shortcut press that
//    targeted a different composer than the one that received the last
//    transcript.

const directory = "C:/OpenCode/speech-shortcut-empty-composer"
const server = "http://127.0.0.1:4096"
const first = "ses_speech_shortcut_first"
const second = "ses_speech_shortcut_second"

// The plugin's double-press polish window; keep every deliberate wait above it.
const polishWindowMs = 2_000

const mic = (page: Page) => page.locator('[data-action="speech-to-text"]:visible').first()
const status = (page: Page) => page.locator(".oc-speech-to-text__status:visible").first()
const composer = (page: Page) => page.locator('[data-component="prompt-input"]:visible').first()

declare global {
  interface Window {
    __keyEvents: Array<{ phase: string; target: string; defaultPrevented: boolean }>
  }
}

async function mockSpeechApp(page: Page, transcripts: string[]) {
  await page.route("**/app/plugins**", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ plugins: [{
      id: "speech-to-text-app", spec: "speech-to-text-app", version: "1",
      module: "/app/plugin/speech-to-text-app/1/index.js", hash: "speech-to-text-app",
      capabilities: ["ui:toolbar", "ui:settings", "commands", "host:navigation", "host:stt", "host:audio", "host:composer", "host:skills", "host:skill-content", "host:text-input", "host:desktop-services"],
      ai: { tools: [] },
    }] }),
  }))
  await page.route("**/app/plugin/speech-to-text-app/1/index.js**", (route) => route.fulfill({
    status: 200, contentType: "text/javascript",
    body: readFileSync(new URL("../../../../.opencode/plugin-sources/speech-to-text-app/index.js", import.meta.url), "utf8"),
  }))
  await page.route("**/app/plugin/speech-to-text-app/1/assets/**", (route) => route.fulfill({
    status: 200, contentType: "image/svg+xml",
    body: readFileSync(new URL("../../../../.opencode/plugin-sources/speech-to-text-app/assets/microphone.svg", import.meta.url), "utf8"),
  }))
  // Distinct transcripts make every insertion assertion prove its own delivery.
  await page.route("**/app/host/stt/transcribe**", (route) => {
    transcripts.push(`Transcript #${transcripts.length + 1}`)
    return route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ ok: true, text: transcripts.at(-1) }),
    })
  })
}

async function installSpeechEnvironment(page: Page, tabs: Array<{ type: "session"; sessionId: string } | { type: "draft" }>) {
  await page.addInitScript(({ directory, encoded, server, sessionID, tabs }) => {
    localStorage.setItem("settings.v3", JSON.stringify({}))
    localStorage.setItem("opencode.app-plugin.speech-to-text-app.settings.transcriptionChain", JSON.stringify("model:test/stt"))
    localStorage.setItem("opencode.app-plugin.speech-to-text-app.settings.automaticImprovement", "false")
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({ projects: { [server]: [{ worktree: directory, expanded: true }] }, lastProject: { [server]: directory } }),
    )
    localStorage.setItem(
      "opencode.global.dat:tabs",
      JSON.stringify(tabs.map((tab) => ({ ...tab, server, dirBase64: encoded }))),
    )
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      async getUserMedia() { return { getTracks: () => [Object.assign(new EventTarget(), { stop() {} })] } },
      async enumerateDevices() { return [] }, addEventListener() {}, removeEventListener() {},
    } })
    class Recorder extends EventTarget {
      static isTypeSupported() { return true }
      mimeType = "audio/webm;codecs=opus"
      start() {}
      stop() {
        this.dispatchEvent(new MessageEvent("dataavailable", { data: new Blob([new Uint8Array([1, 2, 3])], { type: this.mimeType }) }))
        this.dispatchEvent(new Event("stop"))
      }
    }
    Object.defineProperty(window, "MediaRecorder", { configurable: true, value: Recorder })
    class AudioContext {
      async decodeAudioData() { return { sampleRate: 16_000, length: 4, numberOfChannels: 1, getChannelData: () => new Float32Array([0, 0.5, -0.5, 0]) } }
      async close() {}
    }
    Object.defineProperty(window, "AudioContext", { configurable: true, value: AudioContext })
  }, { directory, encoded: base64Encode(directory), server, sessionID: first, tabs })
}

async function mockServer(page: Page) {
  await mockOpenCodeServer(page, {
    directory,
    project: { id: "project-speech-shortcut", worktree: directory, name: "Speech Shortcut QA", vcs: "git" },
    provider: { all: [], connected: [], default: {} },
    sessions: [first, second].map((id, index) => ({
      id, slug: id, projectID: "project-speech-shortcut", directory,
      title: index ? "Speech shortcut second" : "Speech shortcut first", version: "dev",
      time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
    })),
    pageMessages: () => ({ items: [] }),
  })
}

function trackAppFailures(page: Page) {
  const consoleErrors: string[] = []
  const networkFailures: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })
  page.on("pageerror", (error) => consoleErrors.push(error.stack ?? error.message))
  page.on("requestfailed", (request) =>
    networkFailures.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`))
  page.on("response", (response) => {
    const url = new URL(response.url())
    if (url.port === (process.env.PLAYWRIGHT_SERVER_PORT ?? "4096") && response.status() >= 400) {
      networkFailures.push(`${response.status()} ${response.request().method()} ${url.pathname}`)
    }
  })
  return {
    expectClean() {
      expect(consoleErrors).toEqual([])
      expect(networkFailures).toEqual([])
    },
  }
}

async function recordOnce(page: Page) {
  await page.keyboard.press("Control+r")
  await expect.poll(() => mic(page).getAttribute("aria-pressed"), { timeout: 5_000 }).toBe("true")
  await expect(status(page)).toContainText(/Recording/i)
  await page.keyboard.press("Control+r")
  await expect.poll(() => mic(page).getAttribute("aria-pressed"), { timeout: 5_000 }).toBe("false")
}

test("Ctrl+R records into a brand-new empty session draft tab", async ({ page }, testInfo) => {
  const failures = trackAppFailures(page)
  const transcripts: string[] = []
  await mockServer(page)
  await mockSpeechApp(page, transcripts)
  await installSpeechEnvironment(page, [{ type: "session", sessionId: first }])

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${first}`)
  await expect(mic(page)).toBeVisible()

  // Open a brand-new empty session tab like the user does (Ctrl+T). The draft
  // composer shows only the placeholder, and the draft tab is active.
  await page.keyboard.press("Control+t")
  const draftTab = page.locator('[data-dock-area="middle"]').getByRole("tab", { name: "New session" })
  await expect(draftTab).toBeVisible()
  await expect(draftTab).toHaveAttribute("aria-selected", "true")
  await expect(composer(page)).toBeVisible()

  // Clicking the microphone works in this state; the shortcut must work too.
  await page.keyboard.press("Control+r")
  await expect.poll(() => mic(page).getAttribute("aria-pressed"), { timeout: 5_000 }).toBe("true")
  await expect(status(page)).toContainText(/Recording/i)
  await page.screenshot({ path: testInfo.outputPath("draft-recording.png") })

  await page.keyboard.press("Control+r")
  await expect.poll(() => mic(page).getAttribute("aria-pressed"), { timeout: 5_000 }).toBe("false")
  await expect(composer(page)).toContainText("Transcript #1")
  await page.screenshot({ path: testInfo.outputPath("draft-inserted.png") })
  failures.expectClean()
})

test("Ctrl+R records into untouched session composers with and without focus", async ({ page }, testInfo) => {
  test.setTimeout(90_000)
  const failures = trackAppFailures(page)
  const transcripts: string[] = []
  await mockServer(page)
  await mockSpeechApp(page, transcripts)
  await installSpeechEnvironment(page, [
    { type: "session", sessionId: first },
    { type: "session", sessionId: second },
  ])

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${first}`)
  await expect(mic(page)).toBeVisible()

  // Unfocused composer (focus rests on the page background).
  await page.keyboard.press("Control+r")
  await expect.poll(() => mic(page).getAttribute("aria-pressed"), { timeout: 5_000 }).toBe("true")
  await expect(status(page)).toContainText(/Recording/i)
  await page.keyboard.press("Control+r")
  await expect.poll(() => mic(page).getAttribute("aria-pressed"), { timeout: 5_000 }).toBe("false")
  await expect(composer(page)).toContainText("Transcript #1")
  await page.screenshot({ path: testInfo.outputPath("session-unfocused-inserted.png") })

  // Wait out the double-press polish window before the next dictation.
  await page.waitForTimeout(polishWindowMs + 500)

  // Focused, still untouched composer in the second tab.
  await page.getByRole("tab", { name: /Speech shortcut second/ }).click()
  await expect(composer(page)).toBeVisible()
  await expect(composer(page)).not.toContainText("Transcript #")
  await composer(page).click()
  await page.keyboard.press("Control+r")
  await expect.poll(() => mic(page).getAttribute("aria-pressed"), { timeout: 5_000 }).toBe("true")
  await expect(status(page)).toContainText(/Recording/i)
  await page.screenshot({ path: testInfo.outputPath("session-focused-recording.png") })
  await page.keyboard.press("Control+r")
  await expect.poll(() => mic(page).getAttribute("aria-pressed"), { timeout: 5_000 }).toBe("false")
  await expect(composer(page)).toContainText("Transcript #2")
  failures.expectClean()
})

test("Ctrl+R right after another tab's dictation starts a new recording", async ({ page }, testInfo) => {
  const failures = trackAppFailures(page)
  const transcripts: string[] = []
  await mockServer(page)
  await mockSpeechApp(page, transcripts)
  await installSpeechEnvironment(page, [
    { type: "session", sessionId: first },
    { type: "session", sessionId: second },
  ])

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${first}`)
  await expect(mic(page)).toBeVisible()

  // Dictate into the first tab's composer.
  await recordOnce(page)
  await expect(composer(page)).toContainText("Transcript #1")
  const insertedAt = Date.now()

  // While the double-press polish window is still open, switch to the
  // untouched second tab and press Ctrl+R. The press must start a new
  // recording here instead of re-polishing the first tab's transcript.
  await page.getByRole("tab", { name: /Speech shortcut second/ }).click()
  await expect(composer(page)).toBeVisible()
  const beforePress = await page.evaluate(() => Date.now())
  const elapsed = beforePress - insertedAt
  if (elapsed >= polishWindowMs) {
    throw new Error(`Tab switch took ${elapsed}ms and left the polish window; the regression would not exercise the defect`)
  }
  await expect(composer(page)).not.toContainText("Transcript #")
  await page.keyboard.press("Control+r")
  await expect.poll(() => mic(page).getAttribute("aria-pressed"), { timeout: 5_000 }).toBe("true")
  await expect(status(page)).toContainText(/Recording/i)
  await page.screenshot({ path: testInfo.outputPath("second-tab-recording.png") })
  await page.keyboard.press("Control+r")
  await expect.poll(() => mic(page).getAttribute("aria-pressed"), { timeout: 5_000 }).toBe("false")
  await expect(composer(page)).toContainText("Transcript #2")
  await page.screenshot({ path: testInfo.outputPath("second-tab-inserted.png") })
  failures.expectClean()
})
