import { mkdirSync } from "node:fs"
import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/ModelChainScroll"
const sessionID = "ses_model_chain_scroll"
const screenshots = "../../docs/workitems/screenshots/model-chain-scroll"

for (const viewport of [
  { width: 1280, height: 720 },
  { width: 390, height: 844 },
]) {
  test(`long model chains scroll without clipping actions at ${viewport.width}px`, async ({ page }) => {
    const errors: string[] = []
    const failures: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text())
    })
    page.on("requestfailed", (request) => failures.push(`${request.url()}: ${request.failure()?.errorText}`))
    page.on("response", (response) => {
      if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`)
    })
    await mockOpenCodeServer(page, {
      directory,
      project: {
        id: "proj_chain_scroll",
        worktree: directory,
        vcs: "git",
        name: "chain-scroll",
        time: { created: 1, updated: 1 },
        sandboxes: [],
      },
      provider: {
        all: [
          {
            id: "openai",
            name: "OpenAI",
            models: {
              test: {
                id: "test",
                name: "Test model",
                family: "gpt",
                release_date: "2026-01-01",
                limit: { context: 128000, output: 8000 },
                cost: { input: 1, output: 1 },
                capabilities: { reasoning: true, tool_call: true, attachment: false },
                variants: { high: {} },
              },
            },
          },
        ],
        connected: ["openai"],
        default: { providerID: "openai", modelID: "test" },
      },
      agents: [{ name: "build", mode: "primary" }],
      sessions: [
        {
          id: sessionID,
          slug: "chain-scroll",
          projectID: "proj_chain_scroll",
          directory,
          title: "Chain scroll",
          version: "dev",
          time: { created: 1, updated: 1 },
        },
      ],
      pageMessages: () => ({ items: [] }),
    })
    await page.addInitScript(
      ({ directory, dirBase64, sessionID }) => {
        localStorage.clear()
        localStorage.setItem("settings.v3", JSON.stringify({}))
        localStorage.setItem(
          "opencode.global.dat:model",
          JSON.stringify({
            user: [],
            recent: [{ providerID: "openai", modelID: "test" }],
            chains: Array.from({ length: 12 }, (_, index) => ({
              id: `chain-${index}`,
              name: index === 0 ? "Planning Chain" : `Chain ${index}`,
              steps: Array.from({ length: 8 }, () => ({ providerID: "openai", modelID: "test", variant: "high" })),
            })),
          }),
        )
        const server = "http://127.0.0.1:4096"
        localStorage.setItem(
          "opencode.global.dat:server",
          JSON.stringify({
            projects: { [server]: [{ worktree: directory, expanded: true }] },
            lastProject: { [server]: directory },
          }),
        )
        localStorage.setItem(
          "opencode.global.dat:tabs",
          JSON.stringify([{ type: "session", server, dirBase64, sessionId: sessionID }]),
        )
      },
      { directory, dirBase64: base64Encode(directory), sessionID },
    )
    await page.setViewportSize(viewport)
    await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
    const composer = page.locator('[data-component="session-composer"]')
    const model = composer.locator('[data-action="prompt-model"]')
    await expectAppVisible(model)
    await composer.hover()
    await model.click()
    await page.getByRole("button", { name: "Chains", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "Model chains", exact: true })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByLabel("Fallback step 8 model")).toBeAttached()
    mkdirSync(screenshots, { recursive: true })
    await page.screenshot({ path: `${screenshots}/${viewport.width}-top.png` })
    const thumb = dialog.locator(".scroll-view__thumb")
    await page.mouse.move(0, 0)
    await expect(thumb).toBeVisible()
    await expect(thumb).toHaveCSS("opacity", "1")
    expect(await thumb.evaluate((element) => getComputedStyle(element, "::after").backgroundColor)).not.toBe(
      "rgba(0, 0, 0, 0)",
    )
    await page.screenshot({ path: `${screenshots}/${viewport.width}-top.png` })

    const scroll = dialog.locator(".scroll-view__viewport")
    const handle = await thumb.boundingBox()
    if (!handle) throw new Error("scrollbar handle has no visible bounds")
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
    await page.mouse.down()
    await expect(thumb).toHaveAttribute("data-dragging", "true")
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2 + 80, { steps: 8 })
    await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    await page.mouse.up()
    await expect(thumb).toHaveAttribute("data-dragging", "false")
    const geometry = await scroll.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      element.scrollTop = element.scrollHeight
      return {
        top: element.scrollTop,
        height: element.clientHeight,
        total: element.scrollHeight,
        left: rect.left,
        right: rect.right,
        bottom: rect.bottom,
        width: window.innerWidth,
        viewportHeight: window.innerHeight,
      }
    })
    expect(geometry.total).toBeGreaterThan(geometry.height)
    expect(geometry.top, "overflowing chain editor must actually scroll").toBeGreaterThan(0)
    expect(geometry.left).toBeGreaterThanOrEqual(0)
    expect(geometry.right).toBeLessThanOrEqual(geometry.width)
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight)
    await expect(dialog.getByRole("heading", { name: "Model chains", exact: true })).toBeInViewport()
    await expect(dialog.getByRole("button", { name: "Save and select" })).toBeInViewport()
    await dialog.getByRole("button", { name: "Add fallback step" }).click()
    await expect(dialog.getByLabel("Fallback step 9 model")).toBeAttached()
    await scroll.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    await page.screenshot({ path: `${screenshots}/${viewport.width}-bottom.png` })
    await dialog.getByRole("button", { name: "Save and select" }).click()
    await expect(dialog).toBeHidden()
    await expect
      .poll(() =>
        page.evaluate(() => {
          const state = JSON.parse(localStorage.getItem("opencode.global.dat:model") ?? "{}")
          return state.chains?.find((chain: { id: string; steps: unknown[] }) => chain.id === "chain-0")?.steps.length
        }),
      )
      .toBe(9)
    expect(errors).toEqual([])
    expect(failures).toEqual([])
  })
}
