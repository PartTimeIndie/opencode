import { readFileSync } from "node:fs"
import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/plugin-model-target"
const server = "http://127.0.0.1:4096"
const sessionID = "ses_plugin_model_target"
const improvementChainKey = "opencode.app-plugin.speech-to-text-app.settings.improvementChain"

test("plugin model-target settings keep the selected chain and stay inside the panel", async ({ page }, testInfo) => {
  const consoleErrors: string[] = []
  const failedResponses: string[] = []
  let stage = "load"
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })
  page.on("pageerror", (error) => consoleErrors.push(`[${stage}] ${error.stack ?? error.message}`))
  page.on("requestfailed", (request) => {
    // Reload aborts in-flight requests; only real network failures matter.
    if (request.failure()?.errorText === "net::ERR_ABORTED") return
    failedResponses.push(`${request.method()} ${request.url()}`)
  })
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`)
  })

  await mockOpenCodeServer(page, {
    directory,
    project: { id: "project-plugin-model-target", name: "Plugin Model Target", worktree: directory, vcs: "git" },
    provider: {
      all: [
        {
          id: "zhipuai-coding-plan",
          name: "ZhipuAI",
          models: {
            "glm-5.3": { id: "glm-5.3", name: "GLM 5.3", limit: { context: 200_000 }, modalities: { input: ["text"], output: ["text"] } },
          },
        },
        {
          id: "openai-codex",
          name: "Codex",
          models: {
            "codex-mini": { id: "codex-mini", name: "Codex Mini", limit: { context: 200_000 }, modalities: { input: ["text"], output: ["text"] } },
          },
        },
        {
          id: "openrouter",
          name: "OpenRouter",
          models: {
            "qwen/qwen3-asr-flash-2026-02-10": {
              id: "qwen/qwen3-asr-flash-2026-02-10",
              name: "Qwen ASR",
              limit: { context: 200_000 },
              modalities: { input: ["audio"], output: ["text"] },
            },
          },
        },
      ],
      connected: ["zhipuai-coding-plan", "openai-codex", "openrouter"],
      default: { providerID: "zhipuai-coding-plan", modelID: "glm-5.3" },
    },
    globalConfig: () => ({
      model_chains: [
        {
          id: "glm-codex",
          name: "GLM - Codex",
          steps: [
            { providerID: "zhipuai-coding-plan", modelID: "glm-5.3" },
            { providerID: "openai-codex", modelID: "codex-mini" },
          ],
        },
        { id: "fast-chain", name: "Fast Chain", steps: [{ providerID: "zhipuai-coding-plan", modelID: "glm-5.3" }] },
        {
          id: "speech-stt",
          name: "Speech STT",
          steps: [{ providerID: "openrouter", modelID: "qwen/qwen3-asr-flash-2026-02-10" }],
        },
      ],
      default_model_chain: "glm-codex",
    }),
    sessions: [
      {
        id: sessionID,
        slug: sessionID,
        projectID: "project-plugin-model-target",
        directory,
        title: "Plugin model target",
        version: "dev",
        time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await mockSpeechPlugin(page)
  await page.addInitScript(
    ({ directory, encoded, server }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { [server]: [{ worktree: directory, expanded: true }] }, lastProject: { [server]: directory } }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", server, dirBase64: encoded, sessionId: "ses_plugin_model_target" }]),
      )
    },
    { directory, encoded: base64Encode(directory), server },
  )

  await page.setViewportSize({ width: 900, height: 800 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectAppVisible(page.getByRole("textbox", { name: /Ask anything/i }))
  stage = "open settings"
  await page.getByRole("button", { name: "Open settings", exact: true }).click()
  await page.getByRole("tab", { name: "Skills & Plugins", exact: true }).click()

  const speech = page.locator('[data-plugin-settings="speech-to-text-app"]').filter({ hasText: "Automatic improvement" })
  await expect(speech).toContainText("Automatic improvement")

  // The improvement picker adopts the configured default chain while nothing is selected.
  const improvementPicker = speech.getByRole("button", { name: "Improvement model or chain" })
  await expect(improvementPicker).toContainText("GLM - Codex")
  await expect.poll(() => readImprovementChain(page)).toBe("chain:glm-codex")

  // Selecting a different chain is adopted verbatim and survives a reload.
  stage = "select chain"
  await improvementPicker.click()
  await page.locator('[aria-label="Model chains"] [role="option"]', { hasText: "Fast Chain" }).click()
  await expect.poll(() => readImprovementChain(page)).toBe("chain:fast-chain")
  await expect(improvementPicker).toContainText("Fast Chain")

  stage = "reload"
  await page.reload()
  await expectAppVisible(page.getByRole("textbox", { name: /Ask anything/i }))
  await page.getByRole("button", { name: "Open settings", exact: true }).click()
  await page.getByRole("tab", { name: "Skills & Plugins", exact: true }).click()
  await expect(speech).toContainText("Automatic improvement")
  await expect
    .poll(() => readImprovementChain(page))
    .toBe("chain:fast-chain")

  // The application profile editor lives in the Improvement prompts overlay and
  // must stay inside the dialog instead of overflowing the right edge (reported
  // clipping on narrow settings windows).
  stage = "open improvement prompts"
  await speech.getByRole("button", { name: "Improvement prompts" }).click()
  const overlay = page.locator(".settings-v2-plugin-overlay-dialog")
  await expect(overlay.locator("[data-plugin-setting-list-item]").first()).toBeVisible()
  for (const width of [900, 760]) {
    stage = `resize ${width}`
    await page.setViewportSize({ width, height: 800 })
    await expect(overlay.locator("[data-plugin-setting-list-item]").first()).toBeVisible()
    const overflow = await page.evaluate(() => {
      const profile = document.querySelector(".settings-v2-plugin-overlay-dialog [data-plugin-setting-list-item]")
      const body = document.querySelector(".settings-v2-plugin-overlay-dialog [data-slot='dialog-body']")
      if (!profile || !body) return { missing: true as const }
      const profileRect = profile.getBoundingClientRect()
      const bodyRect = body.getBoundingClientRect()
      return {
        missing: false as const,
        profileRight: profileRect.right,
        bodyRight: bodyRect.right,
        viewportOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }
    })
    expect(overflow.missing, `application profile card missing at width ${width}`).toBe(false)
    if (overflow.missing) throw new Error(`application profile card missing at width ${width}`)
    expect(overflow.profileRight, `profile card overflows the settings body at width ${width}`).toBeLessThanOrEqual(
      overflow.bodyRight + 0.5,
    )
    expect(overflow.viewportOverflow, `document overflows horizontally at width ${width}`).toBeLessThanOrEqual(0)
    await testInfo.attach(`speech-plugin-settings-${width}`, { body: await page.screenshot(), contentType: "image/png" })
  }

  expect(consoleErrors).toEqual([])
  expect(failedResponses).toEqual([])
})

async function readImprovementChain(page: Page) {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key)
    return raw === null ? null : (JSON.parse(raw) as string)
  }, improvementChainKey)
}

async function mockSpeechPlugin(page: Page) {
  await page.route("**/app/plugins**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({
        plugins: [
          {
            id: "speech-to-text-app",
            spec: "speech-to-text-app",
            version: "1",
            module: "/app/plugin/speech-to-text-app/1/index.js",
            hash: "speech-to-text-app",
            capabilities: ["ui:toolbar", "ui:settings", "commands", "host:navigation", "host:stt", "host:composer", "host:skills", "host:text-input"],
            ai: { tools: [] },
          },
        ],
      }),
    }),
  )
  await page.route("**/app/plugin/speech-to-text-app/1/index.js**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/javascript",
      headers: { "access-control-allow-origin": "*" },
      body: readFileSync(new URL("../../../../.opencode/plugins/speech-to-text-app/index.js", import.meta.url), "utf8"),
    }),
  )
  await page.route("**/app/plugin/speech-to-text-app/1/assets/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      headers: { "access-control-allow-origin": "*" },
      body: readFileSync(new URL("../../../../.opencode/plugins/speech-to-text-app/assets/microphone.svg", import.meta.url), "utf8"),
    }),
  )
}
