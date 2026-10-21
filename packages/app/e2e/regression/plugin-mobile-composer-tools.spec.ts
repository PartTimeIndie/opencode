import { readFileSync } from "node:fs"
import { expect, test, type Locator, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/plugin-mobile-composer-tools"
const server = "http://127.0.0.1:4096"
const sessionID = "ses_plugin_mobile_composer_tools"

test("speech capture fallbacks and prompt improve work from the mobile composer", async ({ page }) => {
  const consoleErrors: string[] = []
  const failedResponses: string[] = []
  const globalConfig: Record<string, unknown> = {}
  const uploads: Array<{
    contentType: string
    body: Buffer
    request: { mimeType?: string; audio?: string; chain?: { steps?: Array<{ providerID: string; modelID: string }> } }
  }> = []
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })
  page.on("pageerror", (error) => consoleErrors.push(error.message))
  page.on("requestfailed", (request) => {
    const url = new URL(request.url())
    if (url.pathname === "/app/plugins" && request.failure()?.errorText === "net::ERR_ABORTED") return
    failedResponses.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`)
  })
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`)
  })

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: "project-mobile-composer-tools",
      name: "Mobile composer tools",
      worktree: directory,
      vcs: "git",
      time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "openrouter",
          name: "OpenRouter",
          models: {
            "qwen/qwen3-asr-flash-2026-02-10": {
              id: "qwen/qwen3-asr-flash-2026-02-10",
              name: "Qwen3 ASR Flash",
              limit: { context: 200_000 },
              capabilities: {
                input: { text: true, audio: true },
                output: { transcription: true },
              },
            },
          },
        },
        {
          id: "zhipuai-coding-plan",
          name: "Zhipu AI",
          models: { "glm-5.3": { id: "glm-5.3", name: "GLM 5.3", limit: { context: 200_000 } } },
        },
      ],
      connected: ["openrouter", "zhipuai-coding-plan"],
      default: { providerID: "zhipuai-coding-plan", modelID: "glm-5.3" },
    },
    sessions: [
      {
        id: sessionID,
        slug: sessionID,
        projectID: "project-mobile-composer-tools",
        directory,
        title: "Mobile composer tools",
        version: "dev",
        time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
    globalConfig: () => globalConfig,
    onGlobalConfigUpdate: (body) => {
      Object.assign(globalConfig, body)
      return globalConfig
    },
    onAppHostAIRun: () => ({
      ok: true,
      text: "Improved mobile prompt.",
      model: "zhipuai-coding-plan/glm-5.3",
      timing: { totalMs: 1, parseMs: 0, policyMs: 0, instanceMs: 0, generationMs: 1 },
    }),
  })
  await mockPlugins(page)
  await page.route("**/app/host/stt/transcribe**", async (route) => {
    const request = JSON.parse(route.request().postData() ?? "{}") as {
      mimeType?: string
      audio?: string
      chain?: { steps?: Array<{ providerID: string; modelID: string }> }
    }
    const upload = {
      contentType: (await route.request().headerValue("content-type")) ?? "",
      body: Buffer.from(request.audio ?? "", "base64"),
      request,
    }
    uploads.push(upload)
    const audioType = request.mimeType
    if (!audioType?.startsWith("audio/") || (uploads.length === 1 && audioType !== "audio/wav")) {
      await route.fulfill({
        status: 415,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: `Unsupported audio type ${audioType ?? "unknown"}` }),
      })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, text: "Recorded on mobile." }),
    })
  })
  await page.addInitScript(
    ({ directory, encoded, server }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem("opencode.app-plugin.speech-to-text-app.settings.transcriptionChain", JSON.stringify("speech-stt"))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { [server]: [{ worktree: directory, expanded: true }] }, lastProject: { [server]: directory } }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", server, dirBase64: encoded, sessionId: "ses_plugin_mobile_composer_tools" }]),
      )
      localStorage.setItem(
        "opencode.global.dat:model",
        JSON.stringify({
          user: [],
          recent: [],
          variant: {},
          selection: {},
          chains: [
            {
              id: "speech-stt",
              name: "Speech STT",
              steps: [{ providerID: "openrouter", modelID: "qwen/qwen3-asr-flash-2026-02-10" }],
            },
            {
              id: "glm-codex",
              name: "GLM Codex",
              steps: [{ providerID: "zhipuai-coding-plan", modelID: "glm-5.3" }],
            },
          ],
          defaultChainID: "glm-codex",
        }),
      )
      Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined })
      class AudioContext {
        async decodeAudioData() {
          if ((window as Window & { __oversizeMobileAudio?: boolean }).__oversizeMobileAudio) {
            return {
              sampleRate: 16_000,
              length: 13_107_179,
              numberOfChannels: 1,
              getChannelData() {
                throw new Error("Oversize audio must be rejected before channel allocation")
              },
            }
          }
          return {
            sampleRate: 8_000,
            length: 4,
            numberOfChannels: 1,
            getChannelData() {
              return new Float32Array([0, 0.5, -0.5, 0])
            },
          }
        }
        async close() {}
      }
      Object.defineProperty(window, "AudioContext", { configurable: true, value: AudioContext })
    },
    { directory, encoded: base64Encode(directory), server },
  )

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  const composer = page.locator('[data-component="session-composer"]')
  await expectAppVisible(composer)
  const input = composer.locator('[data-component="prompt-input"]')
  const microphone = composer.locator('[data-action="speech-to-text"]')
  const improve = composer.getByRole("button", { name: "Improve current prompt" })
  await expectAppVisible(microphone)
  await expect
    .poll(() =>
      page.evaluate(() =>
        JSON.parse(
          localStorage.getItem("opencode.app-plugin.speech-to-text-app.settings.transcriptionChain") ?? '""',
        ),
      ),
    )
    .toBe("chain:speech-stt")
  await expectAppVisible(microphone)

  for (const [index, bytes] of [[1, 2, 3, 4], [5, 6, 7, 8]].entries()) {
    if (index === 1) {
      // A second press within two seconds intentionally polishes the previous transcript.
      await page.waitForTimeout(2100)
      await page.evaluate(() => {
        Object.defineProperty(navigator, "mediaDevices", {
          configurable: true,
          value: {
            getUserMedia() {
              throw new Error("getUserMedia must not run without MediaRecorder")
            },
            async enumerateDevices() {
              return []
            },
            addEventListener() {},
            removeEventListener() {},
          },
        })
        Object.defineProperty(window, "MediaRecorder", { configurable: true, value: undefined })
      })
      await input.fill("")
    }
    const chooser = page.waitForEvent("filechooser", { timeout: 5_000 })
    await microphone.click()
    await (await chooser).setFiles({
      name: index === 0 ? "mobile-recording.3gp" : "mobile-recording.m4a",
      mimeType: index === 0 ? "audio/3gpp" : "audio/mp4",
      buffer: Buffer.from(bytes),
    })
    await expect.poll(() => editorText(input)).toBe("Recorded on mobile.")
    expect(uploads).toHaveLength(index + 1)
    expect(uploads[index]!.contentType).toContain("application/json")
    if (index === 0) {
      expect(uploads[index]!.request.mimeType).toBe("audio/wav")
      expect(uploads[index]!.body.toString("latin1")).toContain("RIFF")
      expect(uploads[index]!.body.toString("latin1")).toContain("WAVEfmt ")
      const wav = new DataView(uploads[index]!.body.buffer, uploads[index]!.body.byteOffset, 44)
      expect(wav.getUint16(20, true)).toBe(1)
      expect(wav.getUint16(22, true)).toBe(1)
      expect(wav.getUint32(24, true)).toBe(16_000)
      expect(wav.getUint32(28, true)).toBe(32_000)
      expect(wav.getUint16(32, true)).toBe(2)
      expect(wav.getUint16(34, true)).toBe(16)
      expect(wav.getUint32(40, true)).toBe(16)
    } else {
      expect(uploads[index]!.body.indexOf(Buffer.from(bytes))).toBeGreaterThanOrEqual(0)
      expect(uploads[index]!.request.mimeType).toBe("audio/mp4")
    }
    expect(uploads[index]!.request.chain?.steps).toEqual([
      { providerID: "openrouter", modelID: "qwen/qwen3-asr-flash-2026-02-10" },
    ])
  }

  await page.evaluate(() => ((window as Window & { __oversizeMobileAudio?: boolean }).__oversizeMobileAudio = true))
  await input.fill("")
  const oversizeChooser = page.waitForEvent("filechooser", { timeout: 5_000 })
  await page.waitForTimeout(2100)
  await microphone.click()
  await (await oversizeChooser).setFiles({
    name: "oversize-mobile-recording.3gp",
    mimeType: "audio/3gpp",
    buffer: Buffer.from([9, 9, 9, 9]),
  })
  await expect(microphone).toHaveAttribute("aria-label", "Converted recording exceeds 25 MiB")
  expect(uploads).toHaveLength(2)
  await page.evaluate(() => ((window as Window & { __oversizeMobileAudio?: boolean }).__oversizeMobileAudio = false))

  await page.evaluate(() => {
    const execCommand = document.execCommand.bind(document)
    document.execCommand = (command, showUI, value) => {
      if (command === "insertText") return true
      return execCommand(command, showUI, value)
    }
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        async getUserMedia() {
          return { getTracks: () => [Object.assign(new EventTarget(), { stop() {} })] }
        },
        async enumerateDevices() {
          return []
        },
        addEventListener() {},
        removeEventListener() {},
      },
    })
    class Recorder extends EventTarget {
      static isTypeSupported() {
        return true
      }
      mimeType = "audio/webm;codecs=opus"
      state = "inactive"
      start() {
        this.state = "recording"
      }
      stop() {
        this.state = "inactive"
        this.dispatchEvent(new MessageEvent("dataavailable", { data: new Blob([new Uint8Array([9, 10, 11, 12])]) }))
        this.dispatchEvent(new Event("stop"))
      }
    }
    Object.defineProperty(window, "MediaRecorder", { configurable: true, value: Recorder })
  })
  await input.fill("Before after")
  await input.evaluate((element) => {
    const range = document.createRange()
    const selection = window.getSelection()
    range.setStart(element.firstChild!, 7)
    range.collapse(true)
    selection?.removeAllRanges()
    selection?.addRange(range)
  })
  if (process.env.PLAYWRIGHT_VIDEO === "on") await page.waitForTimeout(750)
  await microphone.click()
  await expect(microphone).toHaveAttribute("aria-pressed", "true")
  if (process.env.PLAYWRIGHT_VIDEO === "on") await page.waitForTimeout(750)
  await microphone.click()
  await expect.poll(() => editorText(input)).toBe("Before Recorded on mobile. after")
  if (process.env.PLAYWRIGHT_VIDEO === "on") await page.waitForTimeout(1_000)
  await expect.poll(() => input.evaluate((element) => {
    const selection = window.getSelection()
    if (!selection?.rangeCount) return -1
    const range = selection.getRangeAt(0).cloneRange()
    range.selectNodeContents(element)
    range.setEnd(selection.anchorNode!, selection.anchorOffset)
    return range.toString().length
  })).toBe(27)
  expect(uploads).toHaveLength(3)
  expect(uploads[2]!.body.indexOf(Buffer.from([9, 10, 11, 12]))).toBeGreaterThanOrEqual(0)

  await page.evaluate(() => {
    const execCommand = document.execCommand.bind(document)
    document.execCommand = (command, showUI, value) => {
      if (command !== "insertText") return execCommand(command, showUI, value)
      const selection = window.getSelection()
      if (!selection?.rangeCount) return false
      const range = selection.getRangeAt(0)
      const node = document.createTextNode(String(value ?? ""))
      range.deleteContents()
      range.insertNode(node)
      range.setStartAfter(node)
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
      return false
    }
  })
  await input.fill("")
  await page.waitForTimeout(2100)
  if (process.env.PLAYWRIGHT_VIDEO === "on") await page.waitForTimeout(500)
  await microphone.click()
  await expect(microphone).toHaveAttribute("aria-pressed", "true")
  if (process.env.PLAYWRIGHT_VIDEO === "on") await page.waitForTimeout(500)
  await microphone.click()
  await expect.poll(() => editorText(input)).toBe("Recorded on mobile.")
  if (process.env.PLAYWRIGHT_VIDEO === "on") await page.waitForTimeout(1_000)
  if (process.env.VISUAL_QA_SCREENSHOT_DIR) {
    await page.screenshot({
      path: `${process.env.VISUAL_QA_SCREENSHOT_DIR}/mobile-speech-transcript.png`,
      fullPage: true,
    })
  }
  expect(uploads).toHaveLength(4)

  await expectAppVisible(improve)
  await improve.click()
  await expect.poll(() => editorText(input)).toBe("Improved mobile prompt.")
  await page.screenshot({ path: "test-results/plugin-mobile-composer-tools.png", fullPage: true })

  expect(consoleErrors).toEqual([])
  expect(failedResponses).toEqual([])
})

async function mockPlugins(page: Page) {
  const plugins = ["speech-to-text-app", "prompt-improve-app"]
  await page.route("**/app/plugins**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        plugins: plugins.map((id) => ({
          id,
          spec: id,
          version: "1",
          module: `/app/plugin/${id}/1/index.js`,
          hash: id,
          capabilities: JSON.parse(readFileSync(new URL(`../../../../.opencode/plugin-sources/${id}/package.json`, import.meta.url), "utf8")).opencode.app.capabilities,
          ai: { tools: [] },
        })),
      }),
    }),
  )
  for (const id of plugins) {
    await page.route(`**/app/plugin/${id}/1/index.js**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/javascript",
        body: readFileSync(new URL(`../../../../.opencode/plugin-sources/${id}/index.js`, import.meta.url), "utf8"),
      }),
    )
    await page.route(`**/app/plugin/${id}/1/assets/**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "image/svg+xml",
        body: readFileSync(
          new URL(
            `../../../../.opencode/plugin-sources/${id}/assets/${route.request().url().split("/").pop()}`,
            import.meta.url,
          ),
          "utf8",
        ),
      }),
    )
  }
}

async function editorText(input: Locator) {
  return input.evaluate((element) => (element.textContent ?? "").replace(/\u200B/g, ""))
}
