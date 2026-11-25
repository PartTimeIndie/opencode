import { readFileSync } from "node:fs"
import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"

const directory = "C:/OpenCode/speech-tab-continuity"
const server = "http://127.0.0.1:4096"
const first = "ses_speech_first"
const second = "ses_speech_second"

;([
  { name: "desktop", width: 1280, height: 720 },
  { name: "mobile", width: 390, height: 844 },
  { name: "new-draft", width: 1280, height: 720 },
]).forEach((viewport) => test(`recording survives a session tab switch and inserts only into its original draft (${viewport.name})`, async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await mockOpenCodeServer(page, {
    directory,
    project: { id: "project-speech", worktree: directory, name: "Speech QA", vcs: "git" },
    provider: { all: [], connected: [], default: {} },
    sessions: [first, second].map((id, index) => ({
      id, slug: id, projectID: "project-speech", directory,
      title: index ? "Speech second" : "Speech first", version: "dev",
      time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
    })),
    pageMessages: () => ({ items: [] }),
  })
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
  const requests: Array<{ mimeType: string; audio: string }> = []
  await page.route("**/app/host/stt/transcribe**", async (route) => {
    requests.push(route.request().postDataJSON())
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, text: "Pinned browser transcript" }) })
  })
  await page.addInitScript(({ directory, encoded, server, first, second, draft }) => {
    localStorage.setItem("settings.v3", JSON.stringify({}))
    localStorage.setItem("opencode.app-plugin.speech-to-text-app.settings.transcriptionChain", JSON.stringify("model:test/stt"))
    localStorage.setItem("opencode.global.dat:server", JSON.stringify({ projects: { [server]: [{ worktree: directory, expanded: true }] }, lastProject: { [server]: directory } }))
    localStorage.setItem("opencode.global.dat:tabs", JSON.stringify([
      ...(draft ? [{ type: "draft", draftID: "speech-draft", server, directory }] : [{ type: "session", server, dirBase64: encoded, sessionId: first }]),
      { type: "session", server, dirBase64: encoded, sessionId: second },
    ]))
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
  }, { directory, encoded: base64Encode(directory), server, first, second, draft: viewport.name === "new-draft" })

  await page.setViewportSize(viewport)
  await page.goto(viewport.name === "new-draft" ? "/new-session?draftId=speech-draft" : `/${base64Encode(directory)}/session/${first}`)
  const mic = page.locator('[data-action="speech-to-text"]:visible').first()
  if (viewport.name === "new-draft") {
    await page.getByRole("tab", { name: "New session", exact: true }).click()
    await expect(page.getByRole("tab", { name: "New session", exact: true })).toHaveAttribute("aria-selected", "true")
  }
  await expect(mic).toBeVisible()
  await mic.click()
  await expect(mic).toHaveAttribute("aria-pressed", "true")
  if (viewport.name === "mobile") {
    await page.getByRole("button", { name: "Projects and sessions" }).click()
    await page.getByRole("link", { name: "Speech second" }).click()
  } else await page.getByRole("tab", { name: "Speech second", exact: true }).click()
  const other = page.locator('[data-action="speech-to-text"]:visible').first()
  await expect(other).toHaveAttribute("aria-pressed", "true")
  await page.screenshot({ path: testInfo.outputPath("recording-in-second-tab.png") })
  await other.click()
  await expect.poll(() => requests.length).toBe(1)
  expect(requests[0]?.mimeType).toBe("audio/wav")
  expect(Buffer.from(requests[0]!.audio, "base64").subarray(0, 4).toString()).toBe("RIFF")
  await expect(page.locator('[data-component="prompt-input"]:visible')).not.toContainText("Pinned browser transcript")
  if (viewport.name === "mobile") {
    await page.getByRole("button", { name: "Projects and sessions" }).click()
    await page.getByRole("link", { name: "Speech first" }).click()
  } else if (viewport.name === "new-draft") await page.getByRole("tab", { name: "New session", exact: true }).click()
  else await page.getByRole("tab", { name: "Speech first", exact: true }).click()
  await expect(page.locator('[data-component="prompt-input"]:visible')).toContainText("Pinned browser transcript")
  await page.screenshot({ path: testInfo.outputPath("original-draft-updated.png") })
  expect(errors).toEqual([])
}))
