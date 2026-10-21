import { mkdirSync } from "node:fs"
import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"
import { trackNetworkFailures, trackPageErrors } from "../utils/errors"

const directory = "C:/OpenCode/ModelChainOrder"
const sessionID = "ses_model_chain_order"
const screenshots = "../../docs/workitems/screenshots/model-chain-order"

for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
  test(`chain arrows persist dropdown order without changing the draft or selection at ${viewport.width}px`, async ({ page }) => {
    const errors = trackPageErrors(page)
    const failures = trackNetworkFailures(page)
    const chains = ["Planning Chain", "Standard Coder", "Fast Chain", "Speech polish · low latency"].map((name) => ({
      id: name,
      name,
      steps: [{ providerID: "openai", modelID: "test", variant: "high" }],
    }))
    const config = { model_chains: chains, default_model_chain: "Planning Chain" }
    const updates: unknown[] = []
    const fixture = {
      directory,
      project: { id: "proj_chain_order", worktree: directory, vcs: "git", name: "chain-order", sandboxes: [] },
      provider: {
        all: [{
          id: "openai",
          name: "OpenAI",
          models: {
            test: {
              id: "test",
              name: "Test model",
              release_date: "2026-01-01",
              limit: { context: 128000, output: 8000 },
              capabilities: { reasoning: true, tool_call: true, attachment: false },
              variants: { high: {} },
            },
          },
        }],
        connected: ["openai"],
        default: { providerID: "openai", modelID: "test" },
      },
      agents: [{ name: "build", mode: "primary" }],
      sessions: [{
        id: sessionID,
        slug: "chain-order",
        projectID: "proj_chain_order",
        directory,
        title: "Chain order",
        version: "dev",
        time: { created: 1, updated: 1 },
      }],
      pageMessages: () => ({ items: [] }),
      globalConfig: () => config,
      onGlobalConfigUpdate: (body: unknown) => {
        if (body && typeof body === "object" && "model_chains" in body) updates.push(body)
        Object.assign(config, body)
        return config
      },
    }
    await mockOpenCodeServer(page, fixture)
    await page.context().addInitScript(({ directory, encoded, sessionID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      const server = "http://127.0.0.1:4096"
      localStorage.setItem("opencode.global.dat:server", JSON.stringify({
        projects: { [server]: [{ worktree: directory, expanded: true }] },
        lastProject: { [server]: directory },
      }))
      localStorage.setItem("opencode.global.dat:tabs", JSON.stringify([
        { type: "session", server, dirBase64: encoded, sessionId: sessionID, createdEmpty: true },
      ]))
    }, { directory, encoded: base64Encode(directory), sessionID })
    await page.setViewportSize(viewport)
    await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
    const composer = page.locator('[data-component="session-composer"]')
    const model = composer.locator('[data-action="prompt-model"]')
    await expectAppVisible(model)
    await expect(model).toContainText("Planning Chain")
    await composer.hover()
    await model.click()
    const options = page.getByRole("listbox", { name: "Model chains", exact: true }).getByRole("option")
    await expect(options).toHaveText(chains.map((chain) => new RegExp(`^${chain.name}`)))
    await page.getByRole("button", { name: "Chains", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "Model chains", exact: true })
    const rows = dialog.locator('[data-slot="model-chain-select"]')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole("button", { name: "Move Planning Chain up", exact: true })).toBeDisabled()
    await expect(dialog.getByRole("button", { name: "Move Speech polish · low latency down", exact: true })).toBeDisabled()
    if (viewport.width === 390) {
      const sizes = await dialog.locator("[data-chain-move]").evaluateAll((elements) => elements.map((element) => {
        const rect = element.getBoundingClientRect()
        return { width: rect.width, height: rect.height }
      }))
      expect(sizes.every((size) => size.width >= 44 && size.height >= 44)).toBe(true)
    }

    const name = dialog.getByRole("textbox", { name: "Name", exact: true })
    await name.fill("Unsaved planning draft")
    const fastUp = dialog.getByRole("button", { name: "Move Fast Chain up", exact: true })
    await fastUp.focus()
    await page.keyboard.press("Enter")
    await expect(fastUp).toBeFocused()
    await page.keyboard.press("Space")
    await expect(dialog.getByRole("button", { name: "Fast Chain", exact: true })).toBeFocused()
    await dialog.getByRole("button", { name: "Move Planning Chain down", exact: true }).click()
    await dialog.getByRole("button", { name: "Move Planning Chain up", exact: true }).click()
    const order = ["Fast Chain", "Planning Chain", "Standard Coder", "Speech polish · low latency"]
    await expect.poll(() => rows.evaluateAll((elements) => elements.map((element) => element.getAttribute("aria-label")))).toEqual(order)
    await expect(name).toHaveValue("Unsaved planning draft")
    await expect(dialog.getByRole("button", { name: "Planning Chain", exact: true })).toHaveAttribute("aria-pressed", "true")
    await expect(dialog.getByRole("button", { name: "Move Fast Chain up", exact: true })).toBeDisabled()
    await expect.poll(() => updates.length).toBe(4)
    expect(config.model_chains.map((chain) => chain.id)).toEqual(order)
    expect(config.default_model_chain).toBe("Planning Chain")
    expect(config.model_chains.find((chain) => chain.id === "Planning Chain")).toEqual(chains[0])
    expect(updates).toEqual([
      { model_chains: [chains[0], chains[2], chains[1], chains[3]], default_model_chain: "Planning Chain" },
      { model_chains: [chains[2], chains[0], chains[1], chains[3]], default_model_chain: "Planning Chain" },
      { model_chains: [chains[2], chains[1], chains[0], chains[3]], default_model_chain: "Planning Chain" },
      { model_chains: [chains[2], chains[0], chains[1], chains[3]], default_model_chain: "Planning Chain" },
    ])
    const geometry = await dialog.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
    })
    expect(geometry.left).toBeGreaterThanOrEqual(0)
    expect(geometry.right).toBeLessThanOrEqual(viewport.width)
    expect(geometry.top).toBeGreaterThanOrEqual(0)
    expect(geometry.bottom).toBeLessThanOrEqual(viewport.height)
    mkdirSync(screenshots, { recursive: true })
    await page.screenshot({ path: `${screenshots}/${viewport.width}-editor.png` })
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
    await expect(model).toContainText("Planning Chain")
    await composer.hover()
    await model.click()
    await expect(options).toHaveText(order.map((name) => new RegExp(`^${name}`)))
    await expect.poll(() => page.locator('[data-component="model-selector-popover"] [data-slot="list-scroll"]')
      .evaluate((element) => element.scrollTop)).toBe(0)
    await page.screenshot({ path: `${screenshots}/${viewport.width}-dropdown.png` })
    await page.keyboard.press("Escape")

    // A fresh reader proves server persistence without unloading the original
    // live event stream and cancelling unrelated keepalive telemetry requests.
    await page.evaluate(() => localStorage.removeItem("opencode.global.dat:model"))
    const fresh = await page.context().newPage()
    const freshErrors = trackPageErrors(fresh)
    const freshFailures = trackNetworkFailures(fresh)
    await mockOpenCodeServer(fresh, fixture)
    await fresh.setViewportSize(viewport)
    await fresh.goto(`/${base64Encode(directory)}/session/${sessionID}`)
    const freshModel = fresh.locator('[data-component="session-composer"] [data-action="prompt-model"]')
    await expectAppVisible(freshModel)
    await freshModel.click()
    await expect(fresh.getByRole("listbox", { name: "Model chains", exact: true }).getByRole("option"))
      .toHaveText(order.map((name) => new RegExp(`^${name}`)))
    await fresh.getByRole("button", { name: "Chains", exact: true }).click()
    const freshDialog = fresh.getByRole("dialog", { name: "Model chains", exact: true })
    await expect.poll(() => freshDialog.locator('[data-slot="model-chain-select"]')
      .evaluateAll((elements) => elements.map((element) => element.getAttribute("aria-label")))).toEqual(order)
    await expect(freshDialog.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Planning Chain")
    await expect(freshDialog.getByRole("button", { name: "Move Fast Chain up", exact: true })).toBeDisabled()
    expect(updates.length).toBe(4)
    expect(errors).toEqual([])
    expect(failures).toEqual([])
    expect(freshErrors).toEqual([])
    expect(freshFailures).toEqual([])
  })
}
