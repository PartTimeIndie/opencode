import { expect, test, type Page } from "@playwright/test"
import { base64Encode, checksum } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/NewTabAgentDefault"
const projectID = "proj_new_tab_agent_default"
const server = "http://127.0.0.1:4096"

const provider = {
  all: [
    {
      id: "openai",
      name: "OpenAI",
      models: {
        "gpt-5.6-sol": {
          id: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          family: "gpt",
          release_date: "2026-07-09",
          limit: { context: 400_000, output: 128_000 },
          cost: { input: 1, output: 8 },
          capabilities: { reasoning: true, tool_call: true, attachment: true },
          variants: { medium: {}, high: {}, max: {} },
        },
        "gpt-6-astra": {
          id: "gpt-6-astra",
          name: "GPT-6 Astra",
          family: "gpt",
          release_date: "2026-08-01",
          limit: { context: 400_000, output: 128_000 },
          cost: { input: 2, output: 10 },
          capabilities: { reasoning: true, tool_call: true, attachment: true },
          variants: { high: {}, max: {} },
        },
      },
    },
  ],
  connected: ["openai"],
  default: { providerID: "openai", modelID: "gpt-5.6-sol" },
}

const project = {
  id: projectID,
  worktree: directory,
  vcs: "git",
  name: "new-tab-agent-default",
  time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
  sandboxes: [],
}

const agents = [
  {
    name: "build",
    mode: "primary",
    model: { providerID: "openai", modelID: "gpt-5.6-sol" },
    variant: "medium",
  },
  {
    name: "plan",
    mode: "primary",
    model: { providerID: "openai", modelID: "gpt-6-astra" },
    variant: "high",
  },
]

// Simulates the previous tab having ended on plan with its configured model, so
// only a fresh-tab default to build can explain the composer showing build.
async function seedPreviousPlanSelection(page: Page) {
  await page.addInitScript(
    ({ dir, selectionKey }) => {
      localStorage.clear()
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { local: [{ worktree: dir, expanded: true }] }, lastProject: { local: dir } }),
      )
      localStorage.setItem(
        selectionKey,
        JSON.stringify({
          workspace: {
            agent: "plan",
            model: { providerID: "openai", modelID: "gpt-6-astra" },
            variant: "high",
          },
        }),
      )
    },
    { dir: directory, selectionKey: `${workspaceStorage(directory)}:workspace:model-selection` },
  )
}

function workspaceStorage(dir: string) {
  const head = (dir.slice(0, 12) || "workspace").replace(/[^a-zA-Z0-9._-]/g, "-")
  return `opencode.workspace.${head}.${checksum(dir) ?? "0"}.dat`
}

test("a new tab opens the default agent with its configured model after another agent was last used", async ({
  page,
}) => {
  await mockOpenCodeServer(page, {
    directory,
    project,
    provider,
    agents,
    sessions: [],
    pageMessages: () => ({ items: [] }),
  })
  await seedPreviousPlanSelection(page)

  await page.goto("/")
  const composer = page.locator('[data-component="session-new-composer"]')
  await expectAppVisible(composer)
  await expect(composer.locator('[data-action="prompt-agent"]')).toContainText("build")
  await expect(composer.locator('[data-action="prompt-model"]')).toContainText("GPT-5.6 Sol")
  await expect(composer.locator('[data-action="prompt-model-variant"]')).toContainText("medium")
  if (process.env.VISUAL_QA_SCREENSHOT_DIR) {
    await page.screenshot({ path: `${process.env.VISUAL_QA_SCREENSHOT_DIR}/new-tab-build-default.png` })
  }

  // Switching agents adopts each agent's configured default model and variant.
  await composer.locator('[data-action="prompt-agent"]').click()
  await page.locator('[aria-label="Agents"] [role="option"]', { hasText: "plan" }).click()
  await expect(composer.locator('[data-action="prompt-agent"]')).toContainText("plan")
  await expect(composer.locator('[data-action="prompt-model"]')).toContainText("GPT-6 Astra")
  await expect(composer.locator('[data-action="prompt-model-variant"]')).toContainText("high")
  if (process.env.VISUAL_QA_SCREENSHOT_DIR) {
    await page.screenshot({ path: `${process.env.VISUAL_QA_SCREENSHOT_DIR}/new-tab-plan-switch.png` })
  }

  await composer.locator('[data-action="prompt-agent"]').click()
  await page.locator('[aria-label="Agents"] [role="option"]', { hasText: "build" }).click()
  await expect(composer.locator('[data-action="prompt-model"]')).toContainText("GPT-5.6 Sol")
  await expect(composer.locator('[data-action="prompt-model-variant"]')).toContainText("medium")
})

test("a new tab with an unconfigured agent falls back to the configured default chain", async ({ page }) => {
  await mockOpenCodeServer(page, {
    directory,
    project,
    provider,
    agents: [{ name: "build", mode: "primary" }],
    globalConfig: () => ({
      model_chains: [
        {
          id: "work-chain",
          name: "Work Chain",
          steps: [
            { providerID: "openai", modelID: "gpt-5.6-sol", variant: "high" },
            { providerID: "openai", modelID: "gpt-6-astra" },
          ],
        },
      ],
      default_model_chain: "work-chain",
    }),
    sessions: [],
    pageMessages: () => ({ items: [] }),
  })
  await seedPreviousPlanSelection(page)

  await page.goto("/")
  const composer = page.locator('[data-component="session-new-composer"]')
  await expectAppVisible(composer)
  await expect(composer.locator('[data-action="prompt-agent"]')).toContainText("build")
  await expect(composer.locator('[data-action="prompt-model"]')).toContainText("Work Chain")
  if (process.env.VISUAL_QA_SCREENSHOT_DIR) {
    await page.screenshot({ path: `${process.env.VISUAL_QA_SCREENSHOT_DIR}/new-tab-default-chain.png` })
  }
})
