import { readFileSync } from "node:fs"
import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"

const directory = "C:/OpenCode/speech-improvement-repeat"
const server = "http://127.0.0.1:4096"
const sessionID = "ses_speech_improvement_repeat"

test("a second press starts a new recording after automatic transcript improvement", async ({ page }, testInfo) => {
  const errors: string[] = []
  const failedResponses: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("requestfailed", (request) => failedResponses.push(`${request.method()} ${request.url()}`))
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`)
  })

  let transcriptions = 0
  let improvements = 0
  await mockOpenCodeServer(page, {
    directory,
    project: { id: "project-speech-improvement-repeat", name: "Speech Improvement Repeat", worktree: directory, vcs: "git" },
    provider: { all: [], connected: [], default: {} },
    commands: [],
    sessions: [{
      id: sessionID,
      slug: sessionID,
      projectID: "project-speech-improvement-repeat",
      directory,
      title: "Speech improvement repeat",
      version: "dev",
      time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
    }],
    pageMessages: () => ({ items: [] }),
    onAppHostAIRun: async () => {
      improvements += 1
      if (improvements > 1) await new Promise((resolve) => setTimeout(resolve, 3000))
      return { ok: true, text: `Improved transcript ${improvements}` }
    },
  })
  await page.route("**/app/plugins**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ plugins: [{
      id: "speech-to-text-app",
      spec: "speech-to-text-app",
      version: "1",
      module: "/app/plugin/speech-to-text-app/1/index.js",
      hash: "speech-to-text-app",
      capabilities: ["ui:toolbar", "ui:settings", "commands", "host:navigation", "host:stt", "host:audio", "host:composer", "host:skills", "host:skill-content", "host:text-input", "host:desktop-services", "host:ai"],
      ai: { tools: [] },
    }] }),
  }))
  await page.route("**/app/plugin/speech-to-text-app/1/index.js**", (route) => route.fulfill({
    status: 200,
    contentType: "text/javascript",
    body: readFileSync(new URL("../../../../.opencode/plugin-sources/speech-to-text-app/index.js", import.meta.url), "utf8"),
  }))
  await page.route("**/app/plugin/speech-to-text-app/1/assets/**", (route) => route.fulfill({
    status: 200,
    contentType: "image/svg+xml",
    body: readFileSync(new URL("../../../../.opencode/plugin-sources/speech-to-text-app/assets/microphone.svg", import.meta.url), "utf8"),
  }))
  await page.route("**/api/skill/resolve**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      location: { directory },
      data: { skills: [{ name: "personal-writing-style", content: "Write clearly and naturally." }], issues: [] },
    }),
  }))
  await page.route("**/app/host/stt/transcribe**", async (route) => {
    transcriptions += 1
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, text: `Raw transcript ${transcriptions}` }),
    })
  })
  await page.addInitScript(({ directory, encoded, server, sessionID }) => {
    localStorage.setItem("settings.v3", JSON.stringify({}))
    localStorage.setItem("opencode.app-plugin.speech-to-text-app.settings.transcriptionChain", JSON.stringify("model:test/stt"))
    localStorage.setItem("opencode.app-plugin.speech-to-text-app.settings.improvementChain", JSON.stringify("model:test/polish"))
    localStorage.setItem("opencode.app-plugin.speech-to-text-app.settings.automaticImprovement", JSON.stringify(true))
    localStorage.setItem("opencode.app-plugin.speech-to-text-app.settings.includeSlashCommandsOpenCode", JSON.stringify(false))
    localStorage.setItem("opencode.global.dat:server", JSON.stringify({ projects: { [server]: [{ worktree: directory, expanded: true }] }, lastProject: { [server]: directory } }))
    localStorage.setItem("opencode.global.dat:tabs", JSON.stringify([{ type: "session", server, dirBase64: encoded, sessionId: sessionID }]))
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
  }, { directory, encoded: base64Encode(directory), server, sessionID })

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.clock.setFixedTime(new Date("2025-01-15T12:00:00Z"))
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  const microphone = page.locator('[data-action="speech-to-text"]:visible').first()
  const status = microphone.locator("xpath=..").getByRole("status")
  const composer = page.locator('[data-component="prompt-input"]:visible')
  await expect(microphone).toBeVisible()

  await microphone.click()
  await expect(status).toHaveText("Recording 0:00")
  await microphone.click()
  await expect.poll(() => transcriptions).toBe(1)
  await expect(composer).toContainText("Improved transcript 1")
  expect(improvements).toBe(1)

  await microphone.click()
  await expect(status).toHaveText("Recording 0:00")
  expect(transcriptions).toBe(1)
  expect(improvements).toBe(1)
  const afterRepeatPress = testInfo.outputPath("after-repeat-press.png")
  await page.screenshot({ path: afterRepeatPress })
  await testInfo.attach("after-repeat-press", { path: afterRepeatPress, contentType: "image/png" })

  await microphone.click()
  await expect.poll(() => transcriptions).toBe(2)
  await expect(composer).toContainText("Improved transcript 2")
  expect(improvements).toBe(2)
  expect(errors).toEqual([])
  expect(failedResponses).toEqual([])
})
