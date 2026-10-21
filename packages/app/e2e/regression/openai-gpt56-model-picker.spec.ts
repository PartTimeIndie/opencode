import { mkdirSync, writeFileSync } from "node:fs"
import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/OpenAIGpt56ModelPicker"
const server = "http://127.0.0.1:4096"
const projectID = "proj_openai_gpt56_model_picker"
const sessionID = "ses_openai_gpt56_model_picker"
const screenshotDir = "../../docs/workitems/screenshots/openai-gpt56-model-picker"

test("selects OpenAI GPT-5.6 models and thinking levels", async ({ page }) => {
  const consoleMessages: string[] = []
  const pageErrors: string[] = []
  const networkFailures: string[] = []
  const prompts: unknown[] = []
  const layoutSnapshots: Record<string, unknown> = {}

  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") consoleMessages.push(`${message.type()}: ${message.text()}`)
  })
  page.on("pageerror", (error) => pageErrors.push(error.message))
  page.on("requestfailed", (request) => {
    const url = new URL(request.url())
    if (url.port === (process.env.PLAYWRIGHT_SERVER_PORT ?? "4096")) {
      networkFailures.push(`${request.method()} ${url.pathname} ${request.failure()?.errorText ?? "failed"}`)
    }
  })
  page.on("response", (response) => {
    const url = new URL(response.url())
    if (url.port === (process.env.PLAYWRIGHT_SERVER_PORT ?? "4096") && response.status() >= 400) {
      networkFailures.push(`${response.status()} ${url.pathname}`)
    }
  })

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "openai-gpt56-model-picker",
      time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "openai",
          name: "OpenAI",
          models: {
            "gpt-5.6": model("gpt-5.6", "GPT-5.6", "gpt"),
            "gpt-5.6-luna": model("gpt-5.6-luna", "GPT-5.6 Luna", "gpt-nano"),
            "gpt-5.6-terra": model("gpt-5.6-terra", "GPT-5.6 Terra", "gpt-mini"),
            "gpt-5.6-sol": model("gpt-5.6-sol", "GPT-5.6 Sol", "gpt"),
            "gpt-5.6-sol-pro": model("gpt-5.6-sol-pro", "GPT-5.6 Sol Pro", "gpt"),
          },
        },
      ],
      connected: ["openai"],
      default: { providerID: "openai", modelID: "gpt-5.6" },
    },
    agents: [{ name: "build", mode: "primary" }],
    sessions: [session()],
    pageMessages: () => ({ items: [] }),
    onSessionPrompt: (input) => {
      prompts.push(input)
      return { data: { sessionID: input.sessionID, messageID: `msg_prompt_${prompts.length}`, admittedSeq: prompts.length } }
    },
  })
  await page.addInitScript(
    ({ dir, dirBase64, serverKey }) => {
      localStorage.clear()
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { [serverKey]: [{ worktree: dir, expanded: true }] }, lastProject: { [serverKey]: dir } }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", server: serverKey, dirBase64, sessionId: "ses_openai_gpt56_model_picker" }]),
      )
    },
    { dir: directory, dirBase64: base64Encode(directory), serverKey: server },
  )

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)

  const composer = page.locator('[data-component="session-composer"]')
  const input = composer.locator('[data-component="prompt-input"]')
  const modelButton = composer.locator('[data-action="prompt-model"]')
  const variantControl = composer.locator('[data-component="prompt-variant-control"]')
  const variantButton = variantControl.locator('[data-action="prompt-model-variant"]')
  await expectAppVisible(input)
  await expect(modelButton).toContainText("GPT-5.6")

  mkdirSync(screenshotDir, { recursive: true })
  await openModelPicker(page, composer)
  await expectModelVisible(page, "openai:gpt-5.6")
  await expectModelVisible(page, "openai:gpt-5.6-luna")
  await expectModelVisible(page, "openai:gpt-5.6-terra")
  await expectModelVisible(page, "openai:gpt-5.6-sol")
  await expectModelVisible(page, "openai:gpt-5.6-sol-pro")
  layoutSnapshots.desktopModelPicker = await collectLayout(page)
  await page.screenshot({ path: `${screenshotDir}/desktop-model-picker.png`, fullPage: true })
  await selectModel(page, "openai:gpt-5.6-sol")

  await openVariantPicker(composer, variantButton)
  await expectOptionVisible(page, "default")
  await expectOptionVisible(page, "none")
  await expectOptionVisible(page, "low")
  await expectOptionVisible(page, "medium")
  await expectOptionVisible(page, "high")
  await expectOptionVisible(page, "xhigh")
  await expectOptionVisible(page, "max")
  layoutSnapshots.desktopGpt56SolThinkingLevels = await collectLayout(page)
  await page.screenshot({ path: `${screenshotDir}/desktop-gpt56-thinking-levels.png`, fullPage: true })
  await selectOption(page, "max")
  await expect(variantButton).toContainText("max")

  await openModelPicker(page, composer)
  await selectModel(page, "openai:gpt-5.6-luna")
  await expect(modelButton).toContainText("GPT-5.6 Luna")
  await openVariantPicker(composer, variantButton)
  await expectOptionVisible(page, "max")
  await selectOption(page, "max")
  await expect(variantButton).toContainText("max")

  await openModelPicker(page, composer)
  await selectModel(page, "openai:gpt-5.6-terra")
  await expect(modelButton).toContainText("GPT-5.6 Terra")
  await openVariantPicker(composer, variantButton)
  await expectOptionVisible(page, "max")
  await selectOption(page, "max")
  await expect(variantButton).toContainText("max")

  await openModelPicker(page, composer)
  await selectModel(page, "openai:gpt-5.6-sol")
  await openVariantPicker(composer, variantButton)
  await selectOption(page, "max")
  await expect(variantButton).toContainText("max")
  await input.fill("Visual QA prompt for GPT-5.6 Sol max")
  await composer.locator('[data-action="prompt-submit"]').click()
  await expect.poll(() => prompts.length).toBe(1)
  expect(prompts[0]).toMatchObject({
    sessionID,
    body: {
      agent: "build",
      model: { providerID: "openai", id: "gpt-5.6-sol", variant: "max" },
      prompt: { text: "Visual QA prompt for GPT-5.6 Sol max" },
    },
  })
  layoutSnapshots.desktopGpt56SolMaxSelected = await collectLayout(page)
  await page.screenshot({ path: `${screenshotDir}/desktop-gpt56-max-selected.png`, fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  await expectAppVisible(composer)
  await expect(modelButton).toContainText("GPT-5.6 Sol")
  await expect(variantButton).toContainText("max")
  layoutSnapshots.mobileGpt56SolMaxSelected = await collectLayout(page)
  await page.screenshot({ path: `${screenshotDir}/mobile-gpt56-max-selected.png`, fullPage: true })

  writeFileSync(
    `${screenshotDir}/visual-qa-summary.json`,
    JSON.stringify(
      {
        url: `http://127.0.0.1:3000/${base64Encode(directory)}/session/${sessionID}`,
        desktop: { width: 1280, height: 720 },
        mobile: { width: 390, height: 844 },
        assertions: {
          gpt56Visible: true,
          modelSwitching: ["gpt-5.6", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-sol-pro"],
          gpt56Thinking: ["default", "none", "low", "medium", "high", "xhigh", "max"],
          promptModel: "openai/gpt-5.6-sol",
          promptVariant: "max",
        },
        prompts,
        layoutSnapshots,
        consoleMessages,
        pageErrors,
        networkFailures,
      },
      null,
      2,
    ),
  )

  expect(consoleMessages).toEqual([])
  expect(pageErrors).toEqual([])
  expect(networkFailures).toEqual([])
})

async function openModelPicker(page: Page, composer: ReturnType<Page["locator"]>) {
  await composer.hover()
  await composer.locator('[data-action="prompt-model"]').click()
  await expectAppVisible(page.locator('[data-slot="list-item"]').first())
}

async function openVariantPicker(composer: ReturnType<Page["locator"]>, button: ReturnType<Page["locator"]>) {
  await composer.hover()
  await expectAppVisible(button)
  await button.click()
}

async function expectModelVisible(page: Page, key: string) {
  await expectAppVisible(page.locator(`[data-slot="list-item"][data-key="${key}"]`))
}

async function selectModel(page: Page, key: string) {
  const item = page.locator(`[data-slot="list-item"][data-key="${key}"]`)
  await expectAppVisible(item)
  await item.evaluate((node) => (node as HTMLElement).click())
}

async function expectOptionVisible(page: Page, name: string) {
  await expect(page.getByRole("option", { name: optionLabel(name), exact: true })).toBeVisible()
}

async function selectOption(page: Page, name: string) {
  const option = page.getByRole("option", { name: optionLabel(name), exact: true })
  await expect(option).toBeVisible()
  await option.evaluate((node) => (node as HTMLElement).click())
}

function optionLabel(name: string) {
  if (name === "default") return "Default"
  return name
}

async function collectLayout(page: Page) {
  return page.evaluate(() => {
    const rectFor = (node: Element) => {
      const rect = node.getBoundingClientRect()
      const style = window.getComputedStyle(node)
      return {
        text: node.textContent?.trim().replace(/\s+/g, " ").slice(0, 160) ?? "",
        role: node.getAttribute("role"),
        ariaLabel: node.getAttribute("aria-label"),
        dataAction: node.getAttribute("data-action"),
        dataComponent: node.getAttribute("data-component"),
        dataKey: node.getAttribute("data-key"),
        rect: {
          x: Math.round(rect.x * 10) / 10,
          y: Math.round(rect.y * 10) / 10,
          width: Math.round(rect.width * 10) / 10,
          height: Math.round(rect.height * 10) / 10,
          top: Math.round(rect.top * 10) / 10,
          right: Math.round(rect.right * 10) / 10,
          bottom: Math.round(rect.bottom * 10) / 10,
          left: Math.round(rect.left * 10) / 10,
        },
        style: {
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          position: style.position,
          zIndex: style.zIndex,
          overflow: style.overflow,
          transform: style.transform,
          gap: style.gap,
          padding: style.padding,
        },
      }
    }
    const entries = (selector: string) => Array.from(document.querySelectorAll(selector)).map(rectFor)
    const active = document.activeElement
    return {
      url: window.location.href,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scrollY: window.scrollY,
      activeElement: active
        ? {
            tag: active.tagName,
            text: active.textContent?.trim().replace(/\s+/g, " ").slice(0, 120) ?? "",
            role: active.getAttribute("role"),
            ariaLabel: active.getAttribute("aria-label"),
            dataAction: active.getAttribute("data-action"),
          }
        : undefined,
      composer: entries('[data-component="session-composer"]'),
      modelButton: entries('[data-action="prompt-model"]'),
      variantButton: entries('[data-action="prompt-model-variant"]'),
      modelItems: entries('[data-slot="list-item"]'),
      options: entries('[role="option"]'),
    }
  })
}

function model(id: string, name: string, family: string) {
  const variants = ["none", "low", "medium", "high", "xhigh", "max"]
  return {
    id,
    name,
    family,
    release_date: "2026-07-09",
    limit: { context: 400_000, output: 128_000 },
    cost: { input: 1, output: 8 },
    capabilities: { reasoning: true, tool_call: true, attachment: true },
    variants: Object.fromEntries(variants.map((variant) => [variant, {}])),
  }
}

function session() {
  return {
    id: sessionID,
    slug: "openai-gpt56-model-picker",
    projectID,
    directory,
    title: "OpenAI GPT-5.6 model picker",
    version: "dev",
    time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
  }
}
