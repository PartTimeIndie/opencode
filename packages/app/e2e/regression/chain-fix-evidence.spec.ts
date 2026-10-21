import { readFileSync } from "node:fs"
import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/plugin-model-target"
const server = "http://127.0.0.1:4096"
const sessionID = "ses_plugin_model_target"

test("capture speech plugin settings evidence", async ({ page }) => {
  await mockOpenCodeServer(page, {
    directory,
    project: { id: "p1", name: "P", worktree: directory, vcs: "git" },
    provider: {
      all: [
        {
          id: "zhipuai-coding-plan",
          name: "ZhipuAI",
          models: {
            "glm-5.3": { id: "glm-5.3", name: "GLM 5.3", limit: { context: 200_000 }, modalities: { input: ["text"], output: ["text"] } },
          },
        },
      ],
      connected: ["zhipuai-coding-plan"],
      default: { providerID: "zhipuai-coding-plan", modelID: "glm-5.3" },
    },
    globalConfig: () => ({
      model_chains: [
        { id: "glm-codex", name: "GLM - Codex", steps: [{ providerID: "zhipuai-coding-plan", modelID: "glm-5.3" }] },
        { id: "fast-chain", name: "Fast Chain", steps: [{ providerID: "zhipuai-coding-plan", modelID: "glm-5.3" }] },
      ],
      default_model_chain: "glm-codex",
    }),
    sessions: [
      { id: sessionID, slug: sessionID, projectID: "p1", directory, title: "Evidence", version: "dev", time: { created: 1, updated: 1 } },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await mockSpeechPlugin(page)
  await page.addInitScript(
    ({ directory, encoded, server }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem("opencode.global.dat:server", JSON.stringify({ lastProject: { [server]: directory } }))
    },
    { directory, encoded: base64Encode(directory), server },
  )
  await page.setViewportSize({ width: 900, height: 800 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectAppVisible(page.getByRole("textbox", { name: /Ask anything/i }))
  await page.getByRole("button", { name: "Open settings", exact: true }).click()
  await page.getByRole("tab", { name: "Skills & Plugins", exact: true }).click()
  const speech = page.locator('[data-plugin-settings="speech-to-text-app"]').filter({ hasText: "Automatic improvement" })
  await speech.getByRole("button", { name: "Improvement prompts" }).click()
  const overlay = page.locator(".settings-v2-plugin-overlay-dialog")
  await expect(overlay.locator("[data-plugin-setting-list-item]").first()).toBeVisible()
  await page.screenshot({ path: ".agent-tmp/chain-fix-evidence-900.png" })
  await page.setViewportSize({ width: 760, height: 800 })
  await page.screenshot({ path: ".agent-tmp/chain-fix-evidence-760.png" })
  await overlay.locator("[data-plugin-setting-list-item]").first().scrollIntoViewIfNeeded()
  await page.screenshot({ path: ".agent-tmp/chain-fix-evidence-760-profile.png" })
})

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
