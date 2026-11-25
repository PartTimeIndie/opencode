import { readFileSync } from "node:fs"
import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { fixture } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"

const directory = "C:/OpenCode/speech-send-ready"
const server = "http://127.0.0.1:4096"
const first = "ses_speech_send_first"
const second = "ses_speech_send_second"

for (const viewport of [{ name: "desktop", width: 1280, height: 720 }, { name: "mobile", width: 390, height: 844 }, { name: "manual-polish", width: 1280, height: 720 }]) {
  test(`Send finishes recording and delivers only to the original chat after switching (${viewport.name})`, async ({ page }, testInfo) => {
    const errors: string[] = []
    const network: string[] = []
    const prompts: Array<{ sessionID: string; body: unknown }> = []
    const transcript = Promise.withResolvers<void>()
    const polish = Promise.withResolvers<void>()
    let improvements = 0
    let transcriptions = 0
    page.on("pageerror", (error) => errors.push(error.message))
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()) })
    page.on("requestfailed", (request) => network.push(`${request.method()} ${request.url()} ${request.failure()?.errorText}`))
    await mockOpenCodeServer(page, {
      directory,
      provider: fixture.provider,
      project: { id: "project-speech-send", worktree: directory, name: "Speech Send QA", vcs: "git" },
      sessions: [first, second].map((id, index) => ({
        id, slug: id, projectID: "project-speech-send", directory,
        title: index ? "Speech second" : "Speech first", version: "dev",
        time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
      })),
      pageMessages: () => ({ items: [] }),
      onAppHostAIRun: async () => { improvements++; await polish.promise; return { ok: true, text: "Polished completed speech" } },
      onSessionPrompt: (input) => {
        prompts.push(input)
        return { data: { sessionID: input.sessionID, messageID: "msg_speech_send", admittedSeq: prompts.length } }
      },
    })
    await page.route("**/app/plugins**", (route) => route.fulfill({ json: { plugins: [{
      id: "speech-to-text-app", spec: "speech-to-text-app", version: "1",
      module: "/app/plugin/speech-to-text-app/1/index.js", hash: "speech-to-text-app",
      capabilities: ["ui:toolbar", "ui:settings", "commands", "host:navigation", "host:ai", "host:stt", "host:audio", "host:composer", "host:skills", "host:skill-content", "host:text-input", "host:desktop-services"],
      ai: { tools: [] },
    }] } }))
    await page.route("**/app/plugin/speech-to-text-app/1/index.js**", (route) => route.fulfill({
      contentType: "text/javascript", body: readFileSync(new URL("../../../../.opencode/plugin-sources/speech-to-text-app/index.js", import.meta.url), "utf8"),
    }))
    await page.route("**/app/plugin/speech-to-text-app/1/assets/**", (route) => route.fulfill({
      contentType: "image/svg+xml", body: readFileSync(new URL("../../../../.opencode/plugin-sources/speech-to-text-app/assets/microphone.svg", import.meta.url), "utf8"),
    }))
    await page.route("**/app/host/stt/transcribe**", async (route) => {
      transcriptions++
      await transcript.promise
      await route.fulfill({ json: { ok: true, text: "Pinned completed speech" } })
    })
    await page.addInitScript(({ directory, encoded, server, first, second }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem("opencode.app-plugin.speech-to-text-app.settings.transcriptionChain", JSON.stringify("model:test/stt"))
      localStorage.setItem("opencode.app-plugin.speech-to-text-app.settings.automaticImprovement", "false")
      localStorage.setItem("opencode.app-plugin.speech-to-text-app.settings.improvementChain", JSON.stringify("model:test/polish"))
      localStorage.setItem("opencode.app-plugin.speech-to-text-app.settings.includeSlashCommandsOpenCode", "false")
      localStorage.setItem("opencode.global.dat:server", JSON.stringify({ projects: { [server]: [{ worktree: directory, expanded: true }] }, lastProject: { [server]: directory } }))
      localStorage.setItem("opencode.global.dat:tabs", JSON.stringify([first, second].map((sessionId) => ({ type: "session", server, dirBase64: encoded, sessionId }))))
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
    }, { directory, encoded: base64Encode(directory), server, first, second })
    await page.setViewportSize(viewport)
    await page.goto(`/${base64Encode(directory)}/session/${first}`)
    const mic = page.locator('[data-action="speech-to-text"]:visible').first()
    await expect(mic).toBeVisible()
    await page.locator('[data-component="prompt-input"]:visible').fill("Existing approved draft. ")
    await mic.click()
    await expect(mic).toHaveAttribute("aria-pressed", "true")
    if (viewport.name === "manual-polish") {
      await mic.click()
      transcript.resolve()
      await expect(page.locator('[data-component="prompt-input"]:visible')).toContainText("Pinned completed speech")
      await mic.click()
      await expect.poll(() => improvements).toBe(1)
      await page.locator('[data-action="prompt-submit"]:visible').last().click()
      expect(prompts).toEqual([])
      polish.resolve()
      await expect.poll(() => prompts.length).toBe(1)
      expect(JSON.stringify(prompts[0])).toContain("Polished completed speech")
      expect(JSON.stringify(prompts[0])).not.toContain("Pinned completed speech")
      await page.screenshot({ path: testInfo.outputPath("manual-polish-sent.png") })
      expect(errors).toEqual([])
      expect(network).toEqual([])
      return
    }
    await page.screenshot({ path: testInfo.outputPath("recording-before-send.png") })
    await page.locator('[data-action="prompt-submit"]:visible').last().click()
    try {
      await expect.poll(() => transcriptions).toBe(1)
      expect(prompts).toEqual([])
      if (viewport.name === "mobile") {
        await page.getByRole("button", { name: "Projects and sessions" }).click()
        await page.getByRole("link", { name: "Speech second" }).click()
      } else await page.getByRole("tab", { name: "Speech second", exact: true }).click()
      await page.screenshot({ path: testInfo.outputPath("processing-in-background.png") })
      transcript.resolve()
      await expect.poll(() => prompts.length).toBe(1)
      expect(prompts[0]).toMatchObject({ sessionID: first, body: { prompt: { text: expect.stringContaining("Pinned completed speech") } } })
      expect(JSON.stringify(prompts[0])).toContain("Existing approved draft.")
      await expect(page.locator('[data-component="prompt-input"]:visible')).not.toContainText("Pinned completed speech")
      await page.screenshot({ path: testInfo.outputPath("original-delivered-other-tab-unchanged.png") })
      expect(errors).toEqual([])
      expect(network).toEqual([])
    } finally {
      transcript.resolve()
      await testInfo.attach("observations", { body: JSON.stringify({ transcriptions, prompts, errors, network }), contentType: "application/json" })
    }
  })
}
