import { mkdirSync, writeFileSync } from "node:fs"
import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/ModelPopoverSize"
const server = "http://127.0.0.1:4096"
const projectID = "proj_model_popover_size"
const sessionID = "ses_model_popover_size"
const screenshotDir = "../../docs/workitems/screenshots/model-popover-size"

test("model selector opens at the top in saved chain order and remains viewport-safe", async ({ page }) => {
  const consoleMessages: string[] = []
  const warningStacks: string[] = []
  const pageErrors: string[] = []
  const networkFailures: string[] = []
  const measurements: Record<string, unknown> = {}

  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") consoleMessages.push(`${message.type()}: ${message.text()}`)
    if (message.type() === "debug" && message.text().startsWith("QA warning stack:")) warningStacks.push(message.text())
  })
  await page.addInitScript(() => {
    const warn = console.warn.bind(console)
    console.warn = (...args: unknown[]) => {
      if (args.some((arg) => typeof arg === "string" && arg.includes("computations created outside")))
        console.debug("QA warning stack:", new Error().stack)
      warn(...args)
    }
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
      name: "model-popover-size",
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
        {
          id: "glm",
          name: "GLM",
          models: {
            "glm-5.3": model("glm-5.3", "GLM-5.3", "glm"),
          },
        },
      ],
      connected: ["openai", "glm"],
      default: { providerID: "openai", modelID: "gpt-5.6" },
    },
    agents: [{ name: "build", mode: "primary" }],
    sessions: [session()],
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript(
    ({ dir, dirBase64, serverKey }) => {
      localStorage.clear()
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:model",
        JSON.stringify({
          user: [],
          recent: [
            { providerID: "openai", modelID: "gpt-5.6" },
            { providerID: "openai", modelID: "gpt-5.6-luna" },
          ],
          chains: [
            ...Array.from({ length: 6 }, (_, index) => ({
              id: `chain-extra-${index}`,
              name: `Extra Chain ${index}`,
              steps: [{ providerID: "glm", modelID: "glm-5.3" }],
            })),
            {
              id: "chain-ox-alpha",
              name: "Ox Alpha",
              steps: [
                { providerID: "glm", modelID: "glm-5.3" },
                { providerID: "openai", modelID: "gpt-5.6-luna", variant: "max" },
              ],
            },
            {
              id: "chain-glm-codex",
              name: "GLM - Codex",
              steps: [
                { providerID: "glm", modelID: "glm-5.3" },
                { providerID: "openai", modelID: "gpt-5.6-sol", variant: "medium" },
              ],
            },
            {
              id: "chain-planning",
              name: "Planning Chain",
              steps: [{ providerID: "glm", modelID: "glm-5.3" }],
            },
          ],
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { [serverKey]: [{ worktree: dir, expanded: true }] }, lastProject: { [serverKey]: dir } }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", server: serverKey, dirBase64, sessionId: "ses_model_popover_size" }]),
      )
    },
    { dir: directory, dirBase64: base64Encode(directory), serverKey: server },
  )

  mkdirSync(screenshotDir, { recursive: true })
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)

  const composer = page.locator('[data-component="session-composer"]')
  const modelButton = composer.locator('[data-action="prompt-model"]')
  await expectAppVisible(modelButton)

  await openModelPicker(page, composer)
  await expect(page.getByRole("listbox", { name: "Model chains" })).toBeVisible()
  await expect(page.getByRole("option", { name: /Ox Alpha/ })).toBeVisible()
  await expect(page.getByRole("option", { name: /GLM - Codex/ })).toBeVisible()

  const desktop = await measure(page)
  measurements.desktop = desktop
  // Contract: the popover is clearly taller than the previous 320px and a bit wider than 288px,
  // so model chains and recent models stay visible together without scrolling the whole page.
  expect(desktop.rect.width).toBeGreaterThanOrEqual(320)
  expect(desktop.rect.height).toBeGreaterThanOrEqual(480)
  expectViewportFit(desktop)
  // Contract: overflowing model lists scroll inside the list instead of clipping the popover.
  expect(desktop.listScroll.scrollHeight).toBeGreaterThan(desktop.listScroll.clientHeight)
  expect(desktop.listScroll.scrollTopProbe).toBeGreaterThan(0)
  await page.screenshot({ path: `${screenshotDir}/desktop-model-popover.png`, fullPage: true })

  const search = page.locator('[data-component="model-selector-popover"] input')
  await search.press("ArrowDown")
  await expect.poll(() => page.locator('[data-component="model-selector-popover"] [data-slot="list-scroll"]')
    .evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  await page.keyboard.press("Escape")
  await openModelPicker(page, composer)

  await page.keyboard.press("Escape")
  await expect(page.locator('[data-component="model-selector-popover"]')).toBeHidden()
  await page.setViewportSize({ width: 1280, height: 520 })
  await openModelPicker(page, composer)

  const shortViewport = await measure(page)
  measurements.shortViewport = shortViewport
  // Contract: on short viewports the popover caps at 70vh and never leaves the viewport.
  expect(shortViewport.rect.height).toBeLessThanOrEqual(Math.floor(520 * 0.7) + 1)
  expectViewportFit(shortViewport)
  expect(shortViewport.listScroll.scrollHeight).toBeGreaterThan(shortViewport.listScroll.clientHeight)
  expect(shortViewport.listScroll.scrollTopProbe).toBeGreaterThan(0)
  await page.screenshot({ path: `${screenshotDir}/short-viewport-model-popover.png`, fullPage: true })

  await page.keyboard.press("Escape")
  await expect(page.locator('[data-component="model-selector-popover"]')).toBeHidden()
  await page.setViewportSize({ width: 320, height: 720 })
  await openModelPicker(page, composer)

  const narrowViewport = await measure(page)
  measurements.narrowViewport = narrowViewport
  // Contract: narrow viewports shrink the popover width instead of overflowing horizontally.
  expect(narrowViewport.rect.width).toBeLessThanOrEqual(320 - 16 + 1)
  expectViewportFit(narrowViewport)
  expect(narrowViewport.listScroll.scrollTopProbe).toBeGreaterThan(0)
  await page.screenshot({ path: `${screenshotDir}/narrow-model-popover.png`, fullPage: true })

  writeFileSync(
    `${screenshotDir}/visual-qa-summary.json`,
    JSON.stringify(
      {
        url: page.url(),
        viewports: {
          desktop: { width: 1280, height: 720 },
          shortViewport: { width: 1280, height: 520 },
          narrowViewport: { width: 320, height: 720 },
        },
        measurements,
        consoleMessages,
        warningStacks,
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
  await expect(page.locator('[data-component="model-selector-popover"]')).toBeVisible()
  const popover = page.locator('[data-component="model-selector-popover"]')
  // Wait through animation frames so a delayed current-model scroll cannot pass.
  await popover.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))
  expect(await popover.locator('[data-slot="list-scroll"]').evaluate((element) => element.scrollTop)).toBe(0)
  await expect(popover.getByRole("listbox", { name: "Model chains" }).getByRole("option")).toHaveText([
    ...Array.from({ length: 6 }, (_, index) => new RegExp(`^Extra Chain ${index}`)),
    /^Ox Alpha/,
    /^GLM - Codex/,
    /^Planning Chain/,
  ])
}

type PopoverMeasurement = {
  movement: { chain: number; search: number; scroll: number }
  rect: { x: number; y: number; width: number; height: number; top: number; right: number; bottom: number; left: number }
  viewport: { width: number; height: number }
  listScroll: { clientHeight: number; scrollHeight: number; scrollTopProbe: number }
}

async function measure(page: Page): Promise<PopoverMeasurement> {
  await expect(page.locator('[data-component="model-selector-popover"]')).toBeVisible()
  return page.evaluate(() => {
    const popover = document.querySelector('[data-component="model-selector-popover"]')
    if (!popover) throw new Error("model selector popover is not rendered")
    const rect = popover.getBoundingClientRect()
    const scrollNodes = popover.querySelectorAll('[data-slot="list-scroll"]')
    if (scrollNodes.length !== 1) {
      throw new Error(`expected exactly one model list scroll slot, found ${scrollNodes.length}`)
    }
    const scroll = scrollNodes[0]
    const chain = popover.querySelector('[role="option"]')!
    const search = popover.querySelector('[data-slot="list-search"]')!
    scroll.scrollTop = 0
    const before = { chain: chain.getBoundingClientRect().top, search: search.getBoundingClientRect().top }
    scroll.scrollTop = 40
    const movement = {
      chain: before.chain - chain.getBoundingClientRect().top,
      search: before.search - search.getBoundingClientRect().top,
      scroll: scroll.scrollTop,
    }
    const result = {
      movement,
      rect: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
      },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      listScroll: (() => {
        const element = scroll as HTMLElement
        // A scrollTop assignment only persists on a genuinely scrollable element; a clipped
        // or non-scrolling container snaps back to 0.
        element.scrollTop = 40
        return {
          clientHeight: element.clientHeight,
          scrollHeight: element.scrollHeight,
          scrollTopProbe: element.scrollTop,
        }
      })(),
    }
    scroll.scrollTop = 0
    return result
  })
}

function expectViewportFit(measurement: PopoverMeasurement) {
  expect.soft(measurement.movement.chain, "chains move with the model list").toBeCloseTo(measurement.movement.scroll, 0)
  expect.soft(measurement.movement.search, "search stays fixed").toBe(0)
  const tolerance = 1
  expect(measurement.rect.top).toBeGreaterThanOrEqual(-tolerance)
  expect(measurement.rect.left).toBeGreaterThanOrEqual(-tolerance)
  expect(measurement.rect.right).toBeLessThanOrEqual(measurement.viewport.width + tolerance)
  expect(measurement.rect.bottom).toBeLessThanOrEqual(measurement.viewport.height + tolerance)
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
    slug: "model-popover-size",
    projectID,
    directory,
    title: "Model popover size",
    version: "dev",
    time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
  }
}
