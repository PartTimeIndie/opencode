import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"
import { expectNoSmokeErrors, trackPageErrors } from "../utils/errors"

const directory = "C:/OpenCode/AgentConfigurator"
const projectID = "proj_agent_configurator"
const sessionID = "ses_agent_configurator"
const server = "http://127.0.0.1:4096"

test("composer agent picker opens the selected agent in the configurator and saves tool permissions", async ({ page }) => {
  const errors = trackPageErrors(page)
  const updates: Array<Record<string, unknown>> = []
  const toolDirectories: string[] = []
  const configState = {
    value: {
      default_agent: "build",
      agent: {
        build: { model: "openai/gpt-5.6-sol", mode: "primary" },
        "local-gpt-oss": {
          description: "Local GPT-OSS",
          model: "crng-local/gpt-oss-20b-MXFP4",
          mode: "primary",
          permission: { "*": "deny" },
        },
      },
    } as Record<string, unknown>,
  }

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "agent-configurator",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "crng-local",
          name: "CRNG Local Model",
          models: {
            "gpt-oss-20b-MXFP4": {
              id: "gpt-oss-20b-MXFP4",
              name: "GPT-OSS 20B (CRNG Docker)",
              limit: { context: 12_288, output: 1_500 },
              variants: {
                low: {},
                medium: {},
                high: {},
              },
            },
          },
        },
      ],
      connected: ["crng-local"],
      default: { providerID: "crng-local", modelID: "gpt-oss-20b-MXFP4" },
    },
    agents: [
      { name: "build", mode: "primary", model: { providerID: "openai", modelID: "gpt-5.6-sol" } },
      {
        name: "local-gpt-oss",
        mode: "primary",
        description: "Local GPT-OSS",
        model: { providerID: "crng-local", modelID: "gpt-oss-20b-MXFP4" },
      },
    ],
    sessions: [
      {
        id: sessionID,
        slug: sessionID,
        projectID,
        directory,
        title: "Agent configurator",
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
    globalConfig: () => configState.value,
    onGlobalConfigUpdate: (body) => {
      const update = body as Record<string, unknown>
      configState.value = {
        ...configState.value,
        ...update,
        agent: {
          ...(configState.value.agent as Record<string, unknown>),
          ...(update.agent as Record<string, unknown>),
        },
      }
      updates.push(update)
      return configState.value
    },
  })

  await page.route("**/experimental/tool?*", (route) => {
    toolDirectories.push(new URL(route.request().url()).searchParams.get("directory") ?? "")
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([
      { id: "read", description: "Read files", scope: "application", visible: true },
      { id: "grep", description: "Search text", scope: "application", visible: true },
      { id: "glob", description: "Find files", scope: "application", visible: true },
      { id: "bash", description: "Run commands", scope: "application", visible: true },
      { id: "edit", description: "Edit files", scope: "location", project: "AgentConfigurator", visible: true },
      { id: "switch_agent", description: "Request a user-confirmed agent switch", scope: "location", project: "AgentConfigurator", visible: true },
    ]) })
  })
  await page.addInitScript(
    ({ directory, encoded, server }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { showCustomAgents: false } }))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] }, lastProject: { local: directory } }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", server, dirBase64: encoded, sessionId: "ses_agent_configurator" }]),
      )
    },
    { directory, encoded: base64Encode(directory), server },
  )

  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  const composer = page.locator('[data-dock-area="middle"] [data-component="session-composer"]')
  await expectAppVisible(composer)

  const controls = await composer
    .locator('[data-action="prompt-model"], [data-action="prompt-agent"], [data-action="prompt-access-control"]')
    .evaluateAll((elements) => elements.map((element) => element.getAttribute("data-action")))
  expect(controls).toEqual(["prompt-agent", "prompt-model", "prompt-access-control"])

  await composer.locator('[data-action="prompt-agent"]').click()
  await expectAppVisible(page.getByRole("option", { name: "local-gpt-oss", exact: true }))
  await page.locator('[data-action="prompt-agent-configure-local-gpt-oss"]').click()

  const dialog = page.getByRole("dialog")
  await expectAppVisible(dialog.getByRole("heading", { name: "Agents" }))
  await expect(dialog.getByLabel("Agent ID")).toHaveValue("local-gpt-oss")
  await expect(dialog.getByLabel("Agent ID")).toBeDisabled()
  await expect(dialog.getByLabel("Select agent")).toHaveValue("local-gpt-oss")
  await expect(dialog.getByLabel("Thinking effort")).toHaveValue("default")
  await expect(dialog.getByLabel("Thinking effort").getByRole("option")).toHaveText([
    "Default",
    "Low",
    "Medium",
    "High",
  ])
  await expect(dialog.getByText("Project tool scope:")).toBeVisible()
  await expect(dialog.getByText(directory, { exact: true })).toBeVisible()
  await expect.poll(() => toolDirectories).toContain(directory)
  await dialog.getByLabel("Thinking effort").selectOption("medium")
  await dialog.getByRole("button", { name: "Agent model" }).click()
  const modelPopover = page.getByRole("dialog").last()
  await expect(modelPopover.getByText("GPT-OSS 20B (CRNG Docker)", { exact: true })).toBeVisible()
  await page.screenshot({ path: "test-results/agent-configurator-model-popover.png", fullPage: true })
  await modelPopover.getByText("GPT-OSS 20B (CRNG Docker)", { exact: true }).click()
  await expect(dialog.locator('[data-tool="read"]')).toBeVisible()
  await expect(dialog.locator('[data-tool="edit"]')).toContainText("AgentConfigurator")
  await dialog.getByLabel("System prompt mode").selectOption("append")
  await dialog.getByRole("textbox", { name: "System prompt", exact: true }).fill("Use concise verified answers.")
  await dialog.getByLabel("System prompt files").fill("prompts/live-bot.md\nC:/Shared/guardrails.prompt")
  await dialog.getByLabel("Instruction file mode").selectOption("manual")
  await dialog.getByLabel("Instruction files").fill("AGENTS.md\ndocs/PU.md\nC:/Shared/runtime.txt")
  await dialog.getByLabel("Completion mode").selectOption("custom")
  await dialog.getByRole("textbox", { name: "Completion prompt", exact: true }).fill("Return done only after verification.")
  await dialog.getByLabel("Completion prompt files").fill("prompts/completion.prompt")
  await expect(dialog.getByText("0 of 6 resolved tools are visible.")).toBeVisible()
  await dialog.locator('[data-tool="read"]').getByText("Visible", { exact: true }).click()
  await dialog.locator('[data-tool="read"]').getByLabel("read permission").selectOption("allow")
  await expect(dialog.locator('[data-tool="read"] [data-slot="switch-input"]')).toBeChecked()
  await dialog.locator('[data-tool="switch_agent"]').getByText("Visible", { exact: true }).click()
  await dialog.locator('[data-tool="switch_agent"]').getByLabel("switch_agent permission").selectOption("allow")
  await expect(dialog.locator('[data-tool="read"] [data-slot="switch-input"]')).toBeChecked()
  await expect(dialog.locator('[data-tool="switch_agent"] [data-slot="switch-input"]')).toBeChecked()
  await expect(dialog.getByText("2 of 6 resolved tools are visible.")).toBeVisible()
  await dialog.locator('[data-tool="read"] summary').click()
  await dialog.locator('[data-tool="read"] label').filter({ hasText: "Projektspezifisch" }).getByRole("radio").check()
  await expect(dialog.locator('[data-tool="read"] details input[type="checkbox"]')).toBeChecked()
  await dialog.getByLabel("read permission in agent-configurator").selectOption("ask")
  await dialog.getByLabel("Agent description").fill("Local read-only project assistant")
  for (const viewport of [
    { width: 1440, height: 900, name: "desktop" },
    { width: 900, height: 700, name: "compact" },
    { width: 390, height: 844, name: "narrow" },
  ]) {
    await page.setViewportSize(viewport)
    await expect(dialog).toBeVisible()
    const box = await dialog.boundingBox()
    expect(box).toBeTruthy()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width)
    await page.screenshot({ path: `test-results/agent-configurator-${viewport.name}.png`, fullPage: true })
    await dialog.locator('[data-tool="read"] summary').scrollIntoViewIfNeeded()
    await dialog.getByLabel("read permission in agent-configurator").scrollIntoViewIfNeeded()
    await page.screenshot({ path: `test-results/agent-scope-${viewport.name}.png`, fullPage: true })
  }
  await dialog.getByRole("button", { name: "Save agent" }).click()

  await expect.poll(() => updates.length).toBeGreaterThan(0)
  const latest = updates.at(-1) as { agent?: Record<string, { description?: string; variant?: string; permission?: Record<string, string>; system?: unknown; instructions?: unknown; completion?: unknown; tools?: { mode?: string; entries?: Record<string, unknown> } }> }
  expect(latest.agent?.["local-gpt-oss"]?.description).toBe("Local read-only project assistant")
  expect(latest.agent?.["local-gpt-oss"]?.variant).toBe("medium")
  expect(latest.agent?.["local-gpt-oss"]?.permission).toEqual({ "*": "deny" })
  expect(latest.agent?.["local-gpt-oss"]?.tools).toEqual({
    mode: "explicit",
    entries: {
       read: { visible: true, permission: "allow", scope: { mode: "projects", projects: [directory] }, projectPermissions: { [directory]: "ask" } },
      switch_agent: { visible: true, permission: "allow" },
    },
  })
  expect(latest.agent?.["local-gpt-oss"]?.system).toEqual({
    mode: "append",
    prompt: "Use concise verified answers.",
    files: ["prompts/live-bot.md", "C:/Shared/guardrails.prompt"],
  })
  expect(latest.agent?.["local-gpt-oss"]?.instructions).toEqual({
    mode: "manual",
    files: ["AGENTS.md", "docs/PU.md", "C:/Shared/runtime.txt"],
  })
  expect(latest.agent?.["local-gpt-oss"]?.completion).toEqual({
    mode: "custom",
    prompt: "Return done only after verification.",
    files: ["prompts/completion.prompt"],
  })
  expect(latest.agent?.build).toBeUndefined()
  expect((configState.value.agent as Record<string, unknown>).build).toBeDefined()
  await dialog.getByRole("button", { name: "Duplicate" }).click()
  await expect(dialog.getByLabel("Agent ID")).toHaveValue("local-gpt-oss-copy")
  await expect(dialog.getByLabel("Agent ID")).toBeEnabled()
  await expect(dialog.getByLabel("Agent description")).toHaveValue("Local read-only project assistant")
  await expect(dialog.getByLabel("System prompt mode")).toHaveValue("append")
  await expect(dialog.locator('[data-tool="read"]')).toContainText("Visible")
  expectNoSmokeErrors(errors, [], [])
})

test("agent dropdown can open a blank create-agent editor", async ({ page }) => {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "agent-configurator",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [],
      connected: [],
      default: { providerID: "", modelID: "" },
    },
    agents: [{ name: "build", mode: "primary" }],
    sessions: [
      {
        id: sessionID,
        slug: sessionID,
        projectID,
        directory,
        title: "Agent configurator",
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
    globalConfig: () => ({ agent: { build: { mode: "primary" } } }),
  })
  await page.route("**/experimental/tool/ids*", (route) => route.fulfill({ status: 200, json: ["read"] }))
  await page.addInitScript(
    ({ directory, encoded, server }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] }, lastProject: { local: directory } }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", server, dirBase64: encoded, sessionId: "ses_agent_configurator" }]),
      )
    },
    { directory, encoded: base64Encode(directory), server },
  )

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  const composer = page.locator('[data-dock-area="middle"] [data-component="session-composer"]')
  await expectAppVisible(composer)
  await composer.locator('[data-action="prompt-agent"]').click()
  await page.locator('[data-action="prompt-agent-create"]').click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByLabel("Agent ID")).toHaveValue("new-agent")
  await expect(dialog.getByLabel("Agent ID")).toBeEnabled()
})

test("explicit PU bot tool toggles stay isolated across agents", async ({ page }) => {
  const updates: Array<Record<string, unknown>> = []
  const configState = {
    value: {
      default_agent: "build",
      agent: {
        build: {
          mode: "primary",
          tools: {
            mode: "explicit",
            entries: {
              read: { visible: true, permission: "allow" },
              bash: { visible: true, permission: "ask" },
            },
          },
        },
        "pu-bot-user": {
          mode: "primary",
          model: "lmstudio/qwen/qwen3.6-35b-a3b",
          system: {
            mode: "replace",
            prompt: "Shared live CRNG bot prompt.",
            files: ["C:/Shared/crng/assistant/prompt.md"],
          },
          tools: {
            mode: "explicit",
            entries: {
              pu_read_query: { visible: true, permission: "allow" },
              crng_game_query: { visible: true, permission: "allow" },
              crng_project_query: { visible: true, permission: "allow" },
              crng_trello_query: { visible: true, permission: "allow" },
              crng_recording_query: { visible: true, permission: "allow" },
            },
          },
        },
      },
    } as Record<string, unknown>,
  }

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "agent-configurator",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [],
      connected: [],
      default: { providerID: "", modelID: "" },
    },
    agents: [
      { name: "build", mode: "primary" },
      { name: "pu-bot-user", mode: "primary", model: { providerID: "lmstudio", modelID: "qwen/qwen3.6-35b-a3b" } },
    ],
    sessions: [{
      id: sessionID,
      slug: sessionID,
      projectID,
      directory,
      title: "Agent configurator",
      version: "dev",
      time: { created: 1700000000000, updated: 1700000000000 },
    }],
    pageMessages: () => ({ items: [] }),
    globalConfig: () => configState.value,
    onGlobalConfigUpdate: (body) => {
      const update = body as Record<string, unknown>
      configState.value = {
        ...configState.value,
        ...update,
        agent: {
          ...(configState.value.agent as Record<string, unknown>),
          ...(update.agent as Record<string, unknown>),
        },
      }
      updates.push(update)
      return configState.value
    },
  })
  await page.route("**/experimental/tool?*", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify([
      { id: "read", scope: "application", visible: true },
      { id: "bash", scope: "application", visible: true },
      { id: "pu_read_query", scope: "location", project: "PU", visible: true },
      { id: "crng_game_query", scope: "location", project: "PU", visible: true },
      { id: "crng_project_query", scope: "location", project: "PU", visible: true },
      { id: "crng_trello_query", scope: "location", project: "PU", visible: true },
      { id: "crng_recording_query", scope: "location", project: "PU", visible: true },
    ]),
  }))
  await page.addInitScript(
    ({ directory, encoded, server }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] }, lastProject: { local: directory } }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", server, dirBase64: encoded, sessionId: "ses_agent_configurator" }]),
      )
    },
    { directory, encoded: base64Encode(directory), server },
  )

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  const composer = page.locator('[data-dock-area="middle"] [data-component="session-composer"]')
  await expectAppVisible(composer)
  await composer.locator('[data-action="prompt-agent"]').click()
  await page.locator('[data-action="prompt-agent-configure-pu-bot-user"]').click()

  const dialog = page.getByRole("dialog")
  await expect(dialog.getByLabel("System prompt mode")).toHaveValue("replace")
  await expect(dialog.getByRole("textbox", { name: "System prompt", exact: true })).toHaveValue("Shared live CRNG bot prompt.")
  await expect(dialog.getByLabel("System prompt files")).toHaveValue("C:/Shared/crng/assistant/prompt.md")
  await expect(dialog.getByText("5 of 7 resolved tools are visible.")).toBeVisible()
  await expect(dialog.locator('[data-tool="crng_recording_query"] [data-slot="switch-input"]')).toBeChecked()
  await expect(dialog.locator('[data-tool="read"] [data-slot="switch-input"]')).not.toBeChecked()
  await dialog.locator('[data-tool="crng_trello_query"]').getByText("Visible", { exact: true }).click()
  await expect(dialog.locator('[data-tool="crng_trello_query"] [data-slot="switch-input"]')).not.toBeChecked()
  await expect(dialog.locator('[data-tool="crng_recording_query"] [data-slot="switch-input"]')).toBeChecked()
  await expect(dialog.getByText("4 of 7 resolved tools are visible.")).toBeVisible()
  await dialog.getByRole("textbox", { name: "System prompt", exact: true }).fill("Customized live CRNG bot prompt.")
  await dialog.getByRole("button", { name: "Save agent" }).click()

  await expect.poll(() => updates.length).toBeGreaterThan(0)
  const saved = updates.at(-1) as {
    agent?: Record<string, {
      system?: { mode?: string; prompt?: string; files?: string[] }
      tools?: { entries?: Record<string, { visible?: boolean; permission?: string }> }
    }>
  }
  expect(saved.agent?.["pu-bot-user"]?.system).toEqual({
    mode: "replace",
    prompt: "Customized live CRNG bot prompt.",
    files: ["C:/Shared/crng/assistant/prompt.md"],
  })
  expect(saved.agent?.["pu-bot-user"]?.tools?.entries?.crng_trello_query).toEqual({
    visible: false,
    permission: "deny",
  })
  expect(saved.agent?.["pu-bot-user"]?.tools?.entries?.crng_recording_query).toEqual({
    visible: true,
    permission: "allow",
  })
  expect(saved.agent?.build).toBeUndefined()
  await expect(dialog.getByText("Saved pu-bot-user", { exact: true })).toBeVisible()

  await dialog.getByLabel("Select agent").selectOption("build")
  await expect(dialog.getByLabel("Select agent")).toHaveValue("build")
  await expect(dialog.locator('[data-tool="read"] [data-slot="switch-input"]')).toBeChecked()
  await expect(dialog.locator('[data-tool="bash"] [data-slot="switch-input"]')).toBeChecked()
  await expect(dialog.locator('[data-tool="crng_recording_query"] [data-slot="switch-input"]')).not.toBeChecked()
  await dialog.getByLabel("Select agent").selectOption("pu-bot-user")
  await expect(dialog.getByRole("textbox", { name: "System prompt", exact: true })).toHaveValue("Customized live CRNG bot prompt.")
  await expect(dialog.getByLabel("System prompt files")).toHaveValue("C:/Shared/crng/assistant/prompt.md")
  await expect(dialog.locator('[data-tool="crng_trello_query"] [data-slot="switch-input"]')).not.toBeChecked()
  await expect(dialog.locator('[data-tool="crng_recording_query"] [data-slot="switch-input"]')).toBeChecked()
})

test("agent settings keep the composer active label in sync", async ({ page }, testInfo) => {
  const errors = trackPageErrors(page)
  const networkFailures: string[] = []
  page.on("requestfailed", (request) =>
    networkFailures.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`),
  )
  page.on("response", (response) => {
    if (response.status() >= 400) networkFailures.push(`${response.status()} ${response.url()}`)
  })
  const agentState = {
    value: [{ name: "build", mode: "primary" }],
    requests: 0,
  }

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "agent-configurator",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [],
      connected: [],
      default: { providerID: "", modelID: "" },
    },
    agents: agentState.value,
    sessions: [
      {
        id: sessionID,
        slug: sessionID,
        projectID,
        directory,
        title: "Agent configurator",
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await page.route(/\/agent(?:\?|$)/, (route) => {
    agentState.requests++
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(agentState.value) })
  })
  await page.addInitScript(
    ({ directory, encoded, server }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] }, lastProject: { local: directory } }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", server, dirBase64: encoded, sessionId: "ses_agent_configurator" }]),
      )
    },
    { directory, encoded: base64Encode(directory), server },
  )

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  const composer = page.locator('[data-dock-area="middle"] [data-component="session-composer"]')
  await expectAppVisible(composer)
  await expect.poll(() => agentState.requests).toBeGreaterThan(0)
  const requestsBeforeOpen = agentState.requests
  agentState.value = [
    { name: "build", mode: "primary" },
    { name: "plan", mode: "primary" },
  ]

  const agentControl = composer.locator('[data-action="prompt-agent"]')
  await expect(agentControl).toContainText("build")
  await agentControl.click()

  await expect.poll(() => agentState.requests).toBeGreaterThan(requestsBeforeOpen)
  await page.locator('[data-action="prompt-agent-configure-build"]').click()

  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("Select agent").selectOption("plan")
  await testInfo.attach("agent-settings-plan-selection", {
    body: await page.screenshot(),
    contentType: "image/png",
  })
  await expect(agentControl).toContainText("plan")

  await dialog.getByLabel("Select agent").selectOption("build")
  await expect(agentControl).toContainText("build")
  await testInfo.attach("agent-settings-build-selection", {
    body: await page.screenshot(),
    contentType: "image/png",
  })
  expectNoSmokeErrors(errors, [], [])
  expect(networkFailures).toEqual([])
})
