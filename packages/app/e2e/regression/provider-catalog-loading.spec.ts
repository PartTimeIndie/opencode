import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { trackNetworkFailures, trackPageErrors } from "../utils/errors"

const directory = "C:/OpenCode/ProviderCatalogLoading"
const projectID = "proj_provider_catalog_loading"
const sessionID = "ses_provider_catalog_loading"
const chain = {
  id: "standard-coder",
  name: "StandardCoder",
  steps: [
    { providerID: "luna", modelID: "max", variant: "xhigh" },
    { providerID: "free", modelID: "basic" },
  ],
}
const persistedChain = {
  id: "persisted-only",
  name: "Persisted only",
  steps: [{ providerID: "luna", modelID: "max", variant: "xhigh" }],
}
const providerCatalog = {
  all: [
    {
      id: "luna",
      name: "Luna",
      models: {
        max: {
          id: "max",
          name: "Luna Max",
          cost: { input: 1 },
          release_date: "2026-09-01",
          limit: { context: 128000, output: 8000 },
          capabilities: { reasoning: true, tool_call: true, attachment: false },
          variants: { xhigh: {} },
        },
      },
    },
    {
      id: "free",
      name: "Free",
      models: {
        basic: {
          id: "basic",
          name: "Free Basic",
          release_date: "2026-09-01",
          limit: { context: 64000, output: 4000 },
          capabilities: { reasoning: false, tool_call: true, attachment: false },
          variants: {},
        },
      },
    },
  ],
  connected: ["luna", "free"],
  default: { luna: "max", free: "basic" },
}

async function preparePage(page: Page, viewport = { width: 1280, height: 720 }) {
  const configWrites: unknown[] = []
  let globalConfig = {
    model_chains: [chain],
    default_model_chain: chain.id,
    access_control: {
      safety_review: {
        chain_id: chain.id,
        chain: chain.steps,
      },
    },
  }
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "provider-catalog-loading",
      sandboxes: [],
    },
    provider: providerCatalog,
    agents: [{ name: "build", mode: "primary" }],
    sessions: [{
      id: sessionID,
      slug: "provider-catalog-loading",
      projectID,
      directory,
      title: "Provider catalog loading",
      version: "dev",
      time: { created: 1, updated: 1 },
    }],
    pageMessages: () => ({ items: [] }),
    globalConfig: () => globalConfig,
    onGlobalConfigUpdate: (value) => {
      configWrites.push(value)
      const patch = value as Partial<typeof globalConfig>
      globalConfig = {
        ...globalConfig,
        ...patch,
        access_control: {
          ...globalConfig.access_control,
          ...patch.access_control,
        },
      }
      return globalConfig
    },
  })
  await page.context().addInitScript(({ directory, encoded, sessionID, persistedChain }) => {
    localStorage.setItem("settings.v3", JSON.stringify({}))
    localStorage.setItem("opencode.global.dat:model", JSON.stringify({
      user: [
        { providerID: "luna", modelID: "max", visibility: "show" },
        { providerID: "free", modelID: "basic", visibility: "show" },
      ],
      recent: [],
      variant: {},
      selection: {},
      chains: [persistedChain],
    }))
    const server = "http://127.0.0.1:4096"
    localStorage.setItem("opencode.global.dat:server", JSON.stringify({
      projects: { [server]: [{ worktree: directory, expanded: true }] },
      lastProject: { [server]: directory },
    }))
    localStorage.setItem("opencode.global.dat:tabs", JSON.stringify([
      { type: "session", server, dirBase64: encoded, sessionId: sessionID, createdEmpty: true },
    ]))
  }, { directory, encoded: base64Encode(directory), sessionID, persistedChain })
  await page.setViewportSize(viewport)
  return { configWrites }
}

function isDirectoryRequest(request: { url: () => string; headers: () => Record<string, string> }) {
  const url = new URL(request.url())
  const scopedDirectory = url.searchParams.get("directory") ?? request.headers()["x-opencode-directory"]
  if (!scopedDirectory) return false
  return scopedDirectory.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase() ===
    directory.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase()
}

function isProviderListRequest(request: { url: () => string }) {
  return new URL(request.url()).pathname.endsWith("/provider")
}

test("keeps the selected chain visible while directory discovery takes longer than 30 seconds", async ({ page }) => {
  test.setTimeout(90_000)
  const errors = trackPageErrors(page)
  const failures = trackNetworkFailures(page)
  let signalStarted: () => void = () => {}
  const started = new Promise<void>((resolve) => (signalStarted = resolve))
  let signalGlobalStarted: () => void = () => {}
  const globalStarted = new Promise<void>((resolve) => (signalGlobalStarted = resolve))
  let releaseRequest: () => void = () => {}
  const requestGate = new Promise<void>((resolve) => (releaseRequest = resolve))
  let releaseGlobal: () => void = () => {}
  const globalGate = new Promise<void>((resolve) => (releaseGlobal = resolve))
  let directoryReads = 0
  let globalReads = 0

  const { configWrites } = await preparePage(page)
  await page.route("**/provider**", async (route) => {
    if (!isProviderListRequest(route.request())) return route.fallback()
    if (!isDirectoryRequest(route.request())) {
      globalReads += 1
      signalGlobalStarted()
      await globalGate
      return route.fulfill({ status: 200, json: providerCatalog })
    }
    directoryReads += 1
    signalStarted()
    await requestGate
    return route.fulfill({ status: 200, json: providerCatalog })
  })

  try {
    await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
    await Promise.all([started, globalStarted])

    const model = page.locator('[data-action="prompt-model"]')
    const loading = page.locator('[data-component="provider-catalog-loading"]')
    await expect(model).toBeVisible({ timeout: 5_000 })
    await expect(model).toContainText("StandardCoder")
    await expect(loading).toBeVisible()
    releaseGlobal()
    await model.click()
    const picker = page.locator('[data-component="model-selector-popover"]')
    await expect(picker).toBeVisible()
    await expect(picker).toContainText("Luna Max")
    await expect(picker.getByText("Luna Max", { exact: true })).toBeVisible()
    if (process.env.VISUAL_QA_SCREENSHOT_DIR) {
      await page.screenshot({ path: `${process.env.VISUAL_QA_SCREENSHOT_DIR}/provider-global-fallback-pending.png`, fullPage: true })
    }
    await page.keyboard.press("Escape")
    if (process.env.VISUAL_QA_SCREENSHOT_DIR) {
      await page.screenshot({ path: `${process.env.VISUAL_QA_SCREENSHOT_DIR}/provider-loading-desktop.png`, fullPage: true })
    }

    await page.waitForTimeout(30_100)
    await expect(model).toBeVisible()
    await expect(model).toContainText("StandardCoder")
    await expect(loading).toBeVisible()
    releaseRequest()
    await expect(loading).toHaveCount(0)
    await expect(model).toContainText("StandardCoder")
    expect(directoryReads).toBe(1)
    expect(globalReads).toBe(1)
    expect(configWrites.filter((value) => typeof value === "object" && value !== null && "model_chains" in value))
      .toHaveLength(1)
    expect(configWrites.filter((value) => typeof value === "object" && value !== null && "access_control" in value))
      .toHaveLength(0)
    expect(errors).toEqual([])
    expect(failures).toEqual([])
  } finally {
    releaseRequest()
    releaseGlobal()
  }
})

async function verifyProviderDiscoveryErrorRetry(
  page: Page,
  viewport: { name: string; width: number; height: number },
) {
  const errors = trackPageErrors(page)
  const failures = trackNetworkFailures(page)
  const scopedProviderRequests = new Set<string>()
  page.on("request", (request) => {
    if (isProviderListRequest(request) && isDirectoryRequest(request)) scopedProviderRequests.add(request.url())
  })
  let recover = false
  let directoryReads = 0
  let globalReads = 0
  let releaseFailure = () => {}
  let releaseRecovery = () => {}
  let signalFailureStarted = () => {}
  const failureGate = new Promise<void>((resolve) => (releaseFailure = resolve))
  const recoveryGate = new Promise<void>((resolve) => (releaseRecovery = resolve))
  const failureStarted = new Promise<void>((resolve) => (signalFailureStarted = resolve))
  let recoveryStarted = false

  const { configWrites } = await preparePage(page, viewport)
  await page.route("**/provider**", async (route) => {
    if (!isProviderListRequest(route.request())) return route.fallback()
    if (!isDirectoryRequest(route.request())) {
      globalReads += 1
      return route.fallback()
    }
    directoryReads += 1
    if (!recover) {
      signalFailureStarted()
      await failureGate
      return route.fulfill({ status: 400, json: { error: "Provider catalog temporarily unavailable" } })
    }
    recoveryStarted = true
    await recoveryGate
    return route.fulfill({ status: 200, json: providerCatalog })
  })

  const model = page.locator('[data-action="prompt-model"]')
  const error = page.locator('[data-component="provider-catalog-error"]')
  const loading = page.locator('[data-component="provider-catalog-loading"]')
  try {
    await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
    await expect(model).toBeVisible()
    await expect(model).toContainText("StandardCoder")
    await failureStarted
    await expect(loading).toBeVisible()
    await page.waitForTimeout(300)
    expect(directoryReads, "a pending directory discovery should be shared by all observers").toBe(1)

    releaseFailure()
    await expect(error).toBeVisible({ timeout: 15_000 })
    await page.waitForTimeout(300)
    const failedReads = directoryReads
    expect(failedReads, "a failed directory query must not restart on observer updates").toBe(1)
    expect(globalReads, "the global catalog should load once before the user retries").toBe(1)
    await expect(page.getByText("Failed to reload ProviderCatalogLoading")).toHaveCount(0)
    await expect(model).toContainText("StandardCoder")
    expect(configWrites.filter((value) => typeof value === "object" && value !== null && "model_chains" in value))
      .toHaveLength(1)
    expect(configWrites.filter((value) => typeof value === "object" && value !== null && "access_control" in value))
      .toHaveLength(0)
    if (process.env.VISUAL_QA_SCREENSHOT_DIR) {
      await page.screenshot({ path: `${process.env.VISUAL_QA_SCREENSHOT_DIR}/provider-error-${viewport.name}.png`, fullPage: true })
    }

    await model.click()
    const picker = page.locator('[data-component="model-selector-popover"]')
    await expect(picker).toBeVisible()
    await expect(picker).toContainText("StandardCoder")
    await expect(picker).toContainText("Luna Max")
    await expect(picker.getByText("Luna Max", { exact: true })).toBeVisible()
    if (process.env.VISUAL_QA_SCREENSHOT_DIR) {
      await page.screenshot({ path: `${process.env.VISUAL_QA_SCREENSHOT_DIR}/provider-picker-${viewport.name}.png`, fullPage: true })
    }
    await page.keyboard.press("Escape")

    recover = true
    await error.getByRole("button", { name: "Retry provider catalog" }).click()
    await expect.poll(() => recoveryStarted).toBe(true)
    await expect(loading).toBeVisible()
    await expect(error).toHaveCount(0)
    await expect(model).toContainText("StandardCoder")
    await expect.poll(() => globalReads).toBe(1)
    expect(directoryReads).toBe(failedReads + 1)
    releaseRecovery()
    await expect(loading).toHaveCount(0)
    await model.click()
    await expect(picker).toContainText("Luna Max")
    await expect(picker.getByText("Luna Max", { exact: true })).toBeVisible()
    await page.waitForTimeout(300)
    expect(directoryReads).toBe(2)
    expect(globalReads).toBe(1)

    const unexpectedFailures = failures.filter((failure) => {
      const match = /^400 GET (\S+)$/.exec(failure)
      return !match || !scopedProviderRequests.has(match[1]!)
    })
    expect(unexpectedFailures).toEqual([])
    expect(failures).toHaveLength(failedReads)
    const isExpectedResourceError = (message: string) =>
      /^Failed to load resource: the server responded with a status of 400(?: \(Bad Request\))?$/.test(message)
    expect(errors.filter(isExpectedResourceError)).toHaveLength(failedReads)
    expect(errors.filter((message) => !isExpectedResourceError(message))).toEqual([])
  } finally {
    releaseFailure()
    releaseRecovery()
  }
}

for (const viewport of [
  { name: "desktop", width: 1280, height: 720 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`surfaces directory discovery errors and retries without replacing the selected chain (${viewport.name})`, async ({ page }) => {
    test.setTimeout(45_000)
    await verifyProviderDiscoveryErrorRetry(page, viewport)
  })
}

test("allows read-only chain management after global config fails", async ({ page }) => {
  test.setTimeout(45_000)
  const { configWrites } = await preparePage(page)
  await page.route("**/global/config", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ status: 503, json: { error: "Global config unavailable" } })
      : route.fallback(),
  )

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  const model = page.locator('[data-action="prompt-model"]')
  await expect(model).toBeVisible()
  await model.click()

  const picker = page.locator('[data-component="model-selector-popover"]')
  await expect(picker).toBeVisible()
  const chains = picker.getByRole("button", { name: "Chains" })
  await expect(chains).toBeEnabled({ timeout: 15_000 })
  await chains.click()

  await expect(page.getByRole("heading", { name: "Model chains" })).toBeVisible()
  await expect(page.getByRole("status")).toContainText("read-only until it recovers")
  const savedChain = page.getByRole("button", { name: persistedChain.name, exact: true })
  await expect(savedChain).toBeEnabled()
  await savedChain.click()
  await expect(page.getByLabel("Name")).toHaveValue(persistedChain.name)
  await expect(page.getByLabel("Fallback step 1 model")).toHaveValue("luna/max")
  await expect(page.getByRole("button", { name: "New chain" })).toBeDisabled()
  await expect(page.getByLabel("Name")).toBeDisabled()
  await expect(page.getByLabel("Fallback step 1 model")).toBeDisabled()
  await expect(page.getByRole("button", { name: "Add fallback step" })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Delete" })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Make default" })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Save and select" })).toBeDisabled()
  expect(configWrites).toEqual([])
  if (process.env.VISUAL_QA_SCREENSHOT_DIR) {
    await page.screenshot({
      path: `${process.env.VISUAL_QA_SCREENSHOT_DIR}/chain-management-readonly-desktop.png`,
      fullPage: true,
    })
  }

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole("heading", { name: "Model chains" })).toBeVisible()
  expect(await page.evaluate(() => document.body.scrollWidth <= window.innerWidth + 1)).toBe(true)
  if (process.env.VISUAL_QA_SCREENSHOT_DIR) {
    await page.screenshot({
      path: `${process.env.VISUAL_QA_SCREENSHOT_DIR}/chain-management-readonly-mobile.png`,
      fullPage: true,
    })
  }
})

test("forwards hydrated chain readiness through the Settings target picker", async ({ page }) => {
  const { configWrites } = await preparePage(page)
  const messagesLoaded = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === `/session/${sessionID}/message` &&
      response.ok(),
  )
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await messagesLoaded

  await page.getByRole("button", { name: "Open settings" }).click()
  await page.getByRole("tab", { name: "General", exact: true }).click()
  const trigger = page.getByRole("button", { name: "Completion model or chain" })
  await trigger.click()

  const picker = page.locator('[data-component="model-selector-popover"]')
  await expect(picker).toBeVisible()
  const chains = picker.locator("button").filter({ hasText: "Chains" })
  await expect(chains).toBeEnabled({ timeout: 15_000 })
  const writesBeforeManagement = configWrites.length
  await chains.click()

  await expect(page.getByRole("heading", { name: "Model chains" })).toBeVisible()
  await expect(page.getByRole("button", { name: "New chain" })).toBeEnabled()
  expect(configWrites).toHaveLength(writesBeforeManagement)
  if (process.env.VISUAL_QA_SCREENSHOT_DIR) {
    await page.screenshot({
      path: `${process.env.VISUAL_QA_SCREENSHOT_DIR}/settings-chain-management-ready.png`,
      fullPage: true,
    })
  }
})
