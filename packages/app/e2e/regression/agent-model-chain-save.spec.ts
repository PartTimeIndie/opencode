import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"
import { expectNoSmokeErrors, trackPageErrors } from "../utils/errors"

const directory = "C:/OpenCode/agent-chain-save"
const projectID = "proj_agent_chain_save"
const sessionID = "ses_agent_chain_save"
const server = "http://127.0.0.1:4096"

type AgentPatch = { model?: string; variant?: string }

test("agent editor saves a selected model chain and keeps it after reload", async ({ page }) => {
  const errors = trackPageErrors(page)
  const updates: Array<{ agent?: Record<string, AgentPatch> }> = []
  const configState = {
    value: {
      model_chains: [
        { id: "standard-coder", name: "Standard Coder", steps: [{ providerID: "zhipuai-coding-plan", modelID: "glm-5.3" }] },
        {
          id: "great-coder",
          name: "Great Coder",
          steps: [
            { providerID: "zhipuai-coding-plan", modelID: "glm-5.3" },
            { providerID: "openai-codex", modelID: "codex-mini" },
          ],
        },
      ],
      agent: {
        build: { description: "PU coding agent", mode: "primary" },
      },
    } as Record<string, unknown>,
  }

  await mockOpenCodeServer(page, {
    directory,
    project: { id: projectID, worktree: directory, vcs: "git", name: "agent-chain-save" },
    provider: {
      all: [
        {
          id: "zhipuai-coding-plan",
          name: "ZhipuAI",
          models: {
            "glm-5.3": { id: "glm-5.3", name: "GLM 5.3", limit: { context: 200_000 } },
          },
        },
        {
          id: "openai-codex",
          name: "Codex",
          models: {
            "codex-mini": { id: "codex-mini", name: "Codex Mini", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["zhipuai-coding-plan", "openai-codex"],
      default: { providerID: "zhipuai-coding-plan", modelID: "glm-5.3" },
    },
    agents: [{ name: "build", mode: "primary", description: "PU coding agent" }],
    sessions: [
      {
        id: sessionID,
        slug: sessionID,
        projectID,
        directory,
        title: "Agent chain save",
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
    globalConfig: () => configState.value,
    onGlobalConfigUpdate: (body) => {
      const update = body as { agent?: Record<string, unknown> }
      if (update.agent) {
        configState.value = {
          ...configState.value,
          agent: {
            ...(configState.value.agent as Record<string, unknown>),
            ...update.agent,
          },
        }
      }
      updates.push(body as { agent?: Record<string, AgentPatch> })
      return configState.value
    },
  })

  await page.addInitScript(
    ({ directory, encoded, server }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { [server]: [{ worktree: directory, expanded: true }] }, lastProject: { [server]: directory } }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", server, dirBase64: encoded, sessionId: "ses_agent_chain_save" }]),
      )
    },
    { directory, encoded: base64Encode(directory), server },
  )

  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectAppVisible(page.getByRole("textbox", { name: /Ask anything/i }))

  await page.getByRole("button", { name: "Open settings", exact: true }).click()
  await page.getByRole("tab", { name: "Agents", exact: true }).click()
  const panel = page.locator('[data-component="settings-agents"]')
  await expectAppVisible(panel)
  await expect(panel.getByLabel("Agent ID")).toHaveValue("build")

  const modelButton = panel.getByRole("button", { name: "Agent model" })
  await modelButton.click()
  const chainOption = (name: string) => page.locator('[aria-label="Model chains"] [role="option"]', { hasText: name })
  await expect(chainOption("Great Coder")).toBeVisible()
  await chainOption("Great Coder").click()
  await expect(modelButton).toContainText("Great Coder")

  await panel.getByRole("button", { name: "Save agent" }).click()
  await expect(panel.getByText("Saved build")).toBeVisible()

  await expect.poll(() => updates.length).toBeGreaterThan(0)
  const saved = updates.at(-1)?.agent?.build
  expect(saved?.model).toBe("chain:great-coder")

  // Switching to another chain must save the new chain, not the previous one.
  await modelButton.click()
  await expect(chainOption("Standard Coder")).toBeVisible()
  await chainOption("Standard Coder").click()
  await expect(modelButton).toContainText("Standard Coder")
  await panel.getByRole("button", { name: "Save agent" }).click()
  await expect.poll(() => updates.length).toBeGreaterThan(1)
  expect(updates.at(-1)?.agent?.build?.model).toBe("chain:standard-coder")
  // The editor only leaves the Saving state after the update resolved.
  await expect(panel.getByRole("button", { name: "Save agent" })).toBeEnabled()

  // The persisted chain survives a reload of the settings tab.
  await page.reload()
  await expectAppVisible(page.getByRole("textbox", { name: /Ask anything/i }))
  await page.getByRole("button", { name: "Open settings", exact: true }).click()
  await page.getByRole("tab", { name: "Agents", exact: true }).click()
  await expectAppVisible(panel)
  await expect(modelButton).toContainText("Standard Coder")

  expectNoSmokeErrors(errors, [], [])
})
