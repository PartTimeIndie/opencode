import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectNoSmokeErrors, trackNetworkFailures, trackPageErrors } from "../utils/errors"

const directory = "C:/OpenCode/ModelSwitchReadback"
const sessionID = "ses_model_switch_readback"
const fast = {
  id: "fast",
  name: "Fast Chain",
  steps: [{ providerID: "opencode-go", modelID: "muse-spark-1.3-contributor" }],
}
const planning = {
  id: "planning",
  name: "Planning Chain",
  steps: [{ providerID: "openai", modelID: "gpt-6.1-sol", variant: "high" }],
}

for (const kind of ["external", "pending picker"] as const) {
  test(`${kind} chain change survives readback, tab switch, reload and next prompt`, async ({ page }, testInfo) => {
    const errors = trackPageErrors(page)
    const failures = trackNetworkFailures(page)
    const activeRequests = new Set<import("@playwright/test").Request>()
    const navigationRequests = new Set<import("@playwright/test").Request>()
    let navigating = false
    page.on("request", (request) => {
      activeRequests.add(request)
      if (navigating) navigationRequests.add(request)
    })
    page.on("requestfinished", (request) => activeRequests.delete(request))
    page.on("requestfailed", (request) => activeRequests.delete(request))
    const reloadAborts = new Set<string>()
    page.on("requestfailed", (request) => {
      const url = new URL(request.url())
      if (!navigationRequests.has(request) || request.failure()?.errorText !== "net::ERR_ABORTED") return
      // Tab unmounts and reloads cancel background settings/telemetry and
      // resource fetches. Only exempt requests owned by that navigation;
      // never exempt the model write, prompt submission or HTTP errors.
      if (
        (request.method() === "GET" && (url.port === "3000" || url.pathname === "/global/event")) ||
        (request.method() === "PATCH" && url.pathname === "/global/config") ||
        (request.method() === "POST" && url.pathname === "/perf/record")
      )
        reloadAborts.add(`${request.method()} ${request.url()} net::ERR_ABORTED`)
    })
    let changed = false
    let emitted = false
    let release!: () => void
    const ack = new Promise<void>((resolve) => {
      release = resolve
    })
    const session = {
      id: sessionID,
      slug: sessionID,
      projectID: "proj_model_readback",
      directory,
      title: "Model switch readback",
      version: "dev",
      agent: "build",
      model: model(fast),
      time: { created: 100, updated: 100 },
    }
    const neighbor = { ...session, id: "ses_model_neighbor", slug: "ses_model_neighbor", title: "Neighbor" }
    const prompts: unknown[] = []
    const configWrites = new Set<import("@playwright/test").Request>()
    page.on("request", (request) => {
      if (request.method() === "PATCH" && new URL(request.url()).pathname === "/global/config")
        configWrites.add(request)
    })
    page.on("requestfinished", (request) => configWrites.delete(request))
    page.on("requestfailed", (request) => configWrites.delete(request))
    await mockOpenCodeServer(page, {
      directory,
      project: { id: session.projectID, worktree: directory, vcs: "git", name: "model-readback" },
      provider: {
        all: [
          {
            id: "opencode-go",
            name: "OpenCode Go",
            models: {
              "muse-spark-1.3-contributor": {
                id: "muse-spark-1.3-contributor",
                name: "MuSpark",
                limit: { context: 200000 },
              },
            },
          },
          {
            id: "openai",
            name: "OpenAI",
            models: {
              "gpt-6.1-sol": {
                id: "gpt-6.1-sol",
                name: "GPT-6.1 Sol",
                limit: { context: 400000 },
                variants: { high: {} },
              },
            },
          },
        ],
        connected: ["opencode-go", "openai"],
        default: { providerID: "opencode-go", modelID: "muse-spark-1.3-contributor" },
      },
      agents: [{ name: "build", mode: "primary" }],
      sessions: [session, neighbor],
      pageMessages: () => ({ items: [] }),
      globalConfig: () => ({ model_chains: [fast, planning], default_model_chain: fast.id }),
      eventDelay: 100,
      eventRetry: 100,
      events: () => {
        if (!changed || emitted) return []
        emitted = true
        session.model = model(planning)
        session.time.updated = 101
        return [{ directory, payload: { type: "session.updated", properties: { info: { ...session } } } }]
      },
      onSessionPrompt: ({ body }) => {
        prompts.push(body)
      },
    })
    await page.route(`**/api/session/${sessionID}/model`, async (route) => {
      expect(route.request().postDataJSON().model.chain.id).toBe(planning.id)
      await ack
      changed = true
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    })
    await page.addInitScript(
      ({ directory, encoded, sessionID }) => {
        if (localStorage.getItem("readback-initialized")) return
        localStorage.clear()
        localStorage.setItem("readback-initialized", "true")
        localStorage.setItem("settings.v3", "{}")
        localStorage.setItem(
          "opencode.global.dat:server",
          JSON.stringify({
            projects: { local: [{ worktree: directory, expanded: true }] },
            lastProject: { local: directory },
          }),
        )
        localStorage.setItem(
          "opencode.global.dat:tabs",
          JSON.stringify([
            { type: "session", server: "http://127.0.0.1:4096", dirBase64: encoded, sessionId: sessionID },
            { type: "session", server: "http://127.0.0.1:4096", dirBase64: encoded, sessionId: "ses_model_neighbor" },
          ]),
        )
      },
      { directory, encoded: base64Encode(directory), sessionID },
    )
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
    const picker = page.locator('[data-dock-area="middle"] [data-action="prompt-model"]')
    await expect(picker).toContainText("Fast Chain")
    if (kind === "external") changed = true
    if (kind === "pending picker") {
      await picker.click()
      await page.getByRole("option", { name: /Planning Chain/ }).click()
      await expect(picker).toContainText("Planning Chain")
      await openTab("ses_model_neighbor")
      await openTab(sessionID)
      await expect(picker).toContainText("Planning Chain")
      release()
    }
    await expect.poll(() => emitted).toBe(true)
    await expect(picker).toContainText("Planning Chain")
    await page.screenshot({ path: testInfo.outputPath("model-switch-desktop.png") })
    await openTab("ses_model_neighbor")
    await openTab(sessionID)
    await expect(picker).toContainText("Planning Chain")
    await expect.poll(() => configWrites.size).toBe(0)
    activeRequests.forEach((request) => navigationRequests.add(request))
    navigating = true
    await page.reload()
    await expect(picker).toContainText("Planning Chain")
    navigating = false
    const input = page.locator('[data-dock-area="middle"] [contenteditable="true"]').first()
    await input.fill("Continue with the selected model")
    await input.press("Enter")
    await expect.poll(() => prompts.length).toBe(1)
    expect(prompts[0]).toMatchObject({ model: { id: "gpt-6.1-sol", providerID: "openai", chain: { id: planning.id } } })
    expectNoSmokeErrors(errors, [], [])
    await testInfo.attach("network-evidence", {
      body: JSON.stringify({ failures, reloadAborts: [...reloadAborts] }),
      contentType: "application/json",
    })
    expect(failures.filter((failure) => !reloadAborts.has(failure))).toEqual([])

    async function openTab(id: string) {
      activeRequests.forEach((request) => navigationRequests.add(request))
      navigating = true
      await page.locator(`[data-dock-area="middle"] [data-dock-tab][data-session-id="${id}"]`).getByRole("tab").click()
      await expect(
        page.locator('[data-dock-area="middle"]').getByRole("heading", {
          name: id === sessionID ? "Model switch readback" : "Neighbor",
          exact: true,
        }),
      ).toBeVisible()
      navigating = false
    }
  })
}

function model(chain: typeof fast | typeof planning) {
  return {
    providerID: chain.steps[0].providerID,
    id: chain.steps[0].modelID,
    variant: "variant" in chain.steps[0] ? chain.steps[0].variant : undefined,
    chain: {
      id: chain.id,
      name: chain.name,
      active: 0,
      steps: chain.steps.map((step) => ({
        providerID: step.providerID,
        id: step.modelID,
        ...("variant" in step ? { variant: step.variant } : {}),
      })),
    },
  }
}
