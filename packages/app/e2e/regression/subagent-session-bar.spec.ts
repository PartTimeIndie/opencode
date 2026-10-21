import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectNoSmokeErrors, trackPageErrors } from "../utils/errors"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/SubagentSessionBar"
const projectID = "proj_subagent_session_bar"
const parentID = "ses_subagent_parent"
const childID = "ses_subagent_child"
const duplicateChildID = "ses_subagent_duplicate"

test("shows subagent model details and aborts only the child session", async ({ page }) => {
  const errors = trackPageErrors(page)
  const networkFailures = trackNetworkFailures(page)
  const aborts: Array<{ sessionID: string; directory: string }> = []
  await setup(page, aborts)
  await page.setViewportSize({ width: 1280, height: 720 })
  await openChild(page)

  const bar = page.locator('[data-component="subagent-session-bar"]')
  await expectAppVisible(bar)
  await expect(page.locator('[data-component="prompt-input"]')).toHaveCount(0)
  await expect(bar.locator('[data-slot="subagent-agent"]')).toHaveText("research")
  await expect(bar.locator('[data-slot="subagent-model"]')).toHaveText("opencode/gpt-5.5")
  await expect(bar.locator('[data-slot="subagent-thinking"]')).toHaveText("high")
  await expectAppVisible(bar.getByRole("button", { name: "Back to main session." }))
  await page.screenshot({ path: "test-results/subagent-session-bar-desktop.png", fullPage: true })

  await bar.getByRole("button", { name: "Stop subagent" }).click()
  await expect.poll(() => aborts.length).toBe(1)
  expect(aborts).toEqual([{ sessionID: childID, directory }])
  expectNoSmokeErrors(errors, [], networkFailures)
})

test("keeps the subagent bar usable on mobile", async ({ page }) => {
  const errors = trackPageErrors(page)
  const networkFailures = trackNetworkFailures(page)
  await setup(page, [])
  await page.setViewportSize({ width: 390, height: 844 })
  await openChild(page)

  const bar = page.locator('[data-component="subagent-session-bar"]')
  await expectAppVisible(bar)
  await expectAppVisible(bar.locator('[data-slot="subagent-model"]'))
  await expectAppVisible(bar.locator('[data-slot="subagent-thinking"]'))
  await expectAppVisible(bar.getByRole("button", { name: "Stop subagent" }))
  await page.screenshot({ path: "test-results/subagent-session-bar-mobile.png", fullPage: true })
  expectNoSmokeErrors(errors, [], networkFailures)
})

test("uses prompt metadata before the first assistant message exists", async ({ page }) => {
  const errors = trackPageErrors(page)
  const networkFailures = trackNetworkFailures(page)
  await setup(page, [], { sessionModel: false, withAssistant: false })
  await page.setViewportSize({ width: 1280, height: 720 })
  await openChild(page)

  const bar = page.locator('[data-component="subagent-session-bar"]')
  await expectAppVisible(bar)
  await expect(bar.locator('[data-slot="subagent-agent"]')).toHaveText("research")
  await expect(bar.locator('[data-slot="subagent-model"]')).toHaveText("opencode/gpt-5.5")
  await expect(bar.locator('[data-slot="subagent-thinking"]')).toHaveText("high")
  expectNoSmokeErrors(errors, [], networkFailures)
})

test("opens subagent sessions only when clicked", async ({ page }) => {
  const errors = trackPageErrors(page)
  const networkFailures = trackNetworkFailures(page)
  await setup(page, [], { initialTabID: parentID })
  await page.setViewportSize({ width: 1280, height: 720 })
  await openParent(page)

  const parentDockTab = page.locator(`[data-dock-area="middle"] [data-dock-tab][data-session-id="${parentID}"]`)
  const childDockTab = page.locator(`[data-dock-area="middle"] [data-dock-tab][data-session-id="${childID}"]`)
  const parentTab = parentDockTab.getByRole("tab")
  await expect(parentTab).toHaveAttribute("aria-selected", "true")
  await expect(childDockTab).toHaveCount(0)
  await page.screenshot({ path: "test-results/subagent-session-click-before.png", fullPage: true })

  await page.locator('[data-component="task-tool-title"]').click()

  const childTab = childDockTab.getByRole("tab")
  await expect(parentTab).toHaveAttribute("aria-selected", "false")
  await expectAppVisible(childDockTab)
  await expect(childTab).toHaveAttribute("aria-selected", "true")
  await page.screenshot({ path: "test-results/subagent-session-click-after.png", fullPage: true })

  await page.locator('[data-component="subagent-session-bar"]').getByRole("button", { name: "Back to main session." }).click()

  await expect(parentTab).toHaveAttribute("aria-selected", "true")
  await expect(parentDockTab).toHaveCount(1)
  await expect
    .poll(() =>
      page.evaluate(
        (parentID) => {
          const tabs = JSON.parse(localStorage.getItem("opencode.global.dat:tabs") ?? "[]") as Array<{
            sessionId?: string
          }>
          return tabs.filter((tab) => tab.sessionId === parentID).length
        },
        parentID,
      ),
    )
    .toBe(1)
  await page.screenshot({ path: "test-results/subagent-session-back-to-parent.png", fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await expectAppVisible(page.getByRole("heading", { name: "Parent session" }))
  await expect
    .poll(() =>
      page.evaluate((parentID) => {
        const tabs = JSON.parse(localStorage.getItem("opencode.global.dat:tabs") ?? "[]") as Array<{
          sessionId?: string
        }>
        return tabs.filter((tab) => tab.sessionId === parentID).length
      }, parentID),
    )
    .toBe(1)
  await page.screenshot({ path: "test-results/subagent-session-back-to-parent-mobile.png", fullPage: true })
  expectNoSmokeErrors(errors, [], networkFailures)
})

test("opens a running subagent from its text before result metadata exists", async ({ page }) => {
  const errors = trackPageErrors(page)
  const networkFailures = trackNetworkFailures(page)
  const aborts: Array<{ sessionID: string; directory: string }> = []
  await setup(page, aborts, {
    initialTabID: parentID,
    taskStatus: "running",
    taskMetadata: "none",
  })
  await page.setViewportSize({ width: 1280, height: 720 })
  await openParent(page)

  const title = page.locator('[data-component="task-tool-title"]')
  await expect(title).toHaveText("research")
  await expectAppVisible(page.getByRole("button", { name: "Cancel tool call", exact: true }))
  await title.click()

  const childDockTab = page.locator(`[data-dock-area="middle"] [data-dock-tab][data-session-id="${childID}"]`)
  await expectAppVisible(childDockTab)
  await expect(childDockTab.getByRole("tab")).toHaveAttribute("aria-selected", "true")
  const bar = page.locator('[data-component="subagent-session-bar"]')
  await expectAppVisible(bar)
  await bar.getByRole("button", { name: "Stop subagent" }).click()
  await expect.poll(() => aborts.length).toBe(1)
  expect(aborts).toEqual([{ sessionID: childID, directory }])
  expectNoSmokeErrors(errors, [], networkFailures)
})

test("opens a completed subagent from v2 sessionID metadata", async ({ page }) => {
  const errors = trackPageErrors(page)
  const networkFailures = trackNetworkFailures(page)
  const aborts: Array<{ sessionID: string; directory: string }> = []
  await setup(page, aborts, { initialTabID: parentID, taskMetadata: "v2", taskBackground: true })
  await page.setViewportSize({ width: 1280, height: 720 })
  await openParent(page)

  await expect(page.locator('[data-slot="basic-tool-tool-subtitle"]')).toHaveText("Map subagent (background)")
  await page.locator('[data-component="task-tool-title"]').click()

  const childDockTab = page.locator(`[data-dock-area="middle"] [data-dock-tab][data-session-id="${childID}"]`)
  await expectAppVisible(childDockTab)
  await expect(childDockTab.getByRole("tab")).toHaveAttribute("aria-selected", "true")
  await page.locator('[data-component="subagent-session-bar"]').getByRole("button", { name: "Stop subagent" }).click()
  await expect.poll(() => aborts.length).toBe(1)
  expect(aborts).toEqual([{ sessionID: childID, directory }])
  expectNoSmokeErrors(errors, [], networkFailures)
})

test("opens the exact V2 task child when descriptions repeat", async ({ page }) => {
  const errors = trackPageErrors(page)
  const networkFailures = trackNetworkFailures(page)
  await setup(page, [], {
    initialTabID: parentID,
    taskMetadata: "structured",
    duplicateTaskDescription: true,
  })
  await page.setViewportSize({ width: 1280, height: 720 })
  await openParent(page)

  await page.locator('[data-component="task-tool-title"]').click()

  const exact = page.locator(`[data-dock-area="middle"] [data-dock-tab][data-session-id="${childID}"]`)
  await expectAppVisible(exact)
  await expect(exact.getByRole("tab")).toHaveAttribute("aria-selected", "true")
  await expect(page.locator(`[data-dock-area="middle"] [data-dock-tab][data-session-id="${duplicateChildID}"]`)).toHaveCount(0)
  expectNoSmokeErrors(errors, [], networkFailures)
})

test("keeps stop visible but disabled for an idle completed subagent", async ({ page }) => {
  const errors = trackPageErrors(page)
  const networkFailures = trackNetworkFailures(page)
  await setup(page, [], { childStatus: "idle" })
  await page.setViewportSize({ width: 1280, height: 720 })
  await openChild(page)

  const stop = page.locator('[data-component="subagent-session-bar"]').getByRole("button", { name: "Stop subagent" })
  await expectAppVisible(stop)
  await expect(stop).toBeDisabled()
  expectNoSmokeErrors(errors, [], networkFailures)
})

function trackNetworkFailures(page: Page) {
  const failures: string[] = []
  page.on("requestfailed", (request) => failures.push(`${request.failure()?.errorText ?? "failed"} ${request.url()}`))
  return failures
}

async function setup(
  page: Page,
  aborts: Array<{ sessionID: string; directory: string }>,
  options: {
    sessionModel?: boolean
    withAssistant?: boolean
    initialTabID?: string
    taskStatus?: "running" | "completed"
    taskMetadata?: "legacy" | "v2" | "structured" | "none"
    taskBackground?: boolean
    childStatus?: "busy" | "idle"
    duplicateTaskDescription?: boolean
  } = {},
) {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "subagent-session-bar",
      time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "gpt-5.5": {
              id: "gpt-5.5",
              name: "GPT-5.5",
              limit: { context: 200_000 },
              variants: { high: {} },
            },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "gpt-5.5" },
    },
    agents: [
      { name: "build", mode: "primary" },
      { name: "research", mode: "subagent", model: { providerID: "opencode", modelID: "gpt-5.5" }, variant: "high" },
    ],
    sessions: [
      {
        id: parentID,
        slug: "subagent-parent",
        projectID,
        directory,
        title: "Parent session",
        version: "dev",
        time: { created: 1_700_000_000_000, updated: 1_700_000_001_000 },
      },
      {
        id: childID,
        slug: "subagent-child",
        projectID,
        directory,
        parentID,
        title: "Map subagent (@research subagent)",
        agent: "research",
        ...(options.sessionModel === false ? {} : { model: { providerID: "opencode", id: "gpt-5.5", variant: "high" } }),
        version: "dev",
        time: { created: 1_700_000_000_500, updated: 1_700_000_001_500 },
      },
      ...(options.duplicateTaskDescription
        ? [
            {
              id: duplicateChildID,
              slug: "subagent-duplicate",
              projectID,
              directory,
              parentID,
              title: "Map subagent (@research subagent)",
              agent: "research",
              model: { providerID: "opencode", id: "gpt-5.5", variant: "high" },
              version: "dev",
              time: { created: 1_700_000_000_700, updated: 1_700_000_001_700 },
            },
          ]
        : []),
    ],
    sessionStatus: { [childID]: { type: options.childStatus ?? "busy" } },
    pageMessages: (sessionID) => ({
      items:
        sessionID === childID
          ? childMessages(options.withAssistant !== false)
          : parentMessages(options.taskStatus ?? "completed", options.taskMetadata ?? "legacy", options.taskBackground ?? false),
    }),
    onSessionInterrupt: (input) => {
      aborts.push(input)
      return { data: true }
    },
  })
  await page.addInitScript(
    ({ dirBase64, directory, initialTabID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] }, lastProject: { local: directory } }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", server: "http://127.0.0.1:4096", dirBase64, sessionId: initialTabID }]),
      )
    },
    { dirBase64: base64Encode(directory), directory, initialTabID: options.initialTabID ?? childID },
  )
}

async function openChild(page: Page) {
  await page.goto(`/${base64Encode(directory)}/session/${childID}`)
}

async function openParent(page: Page) {
  await page.goto(`/${base64Encode(directory)}/session/${parentID}`)
}

function parentMessages(
  status: "running" | "completed",
  metadata: "legacy" | "v2" | "structured" | "none",
  background: boolean,
) {
  const taskMetadata = {
    ...(metadata === "legacy" ? { sessionId: childID } : metadata === "v2" ? { task_id: childID } : {}),
    ...(background ? { background: true } : {}),
  }
  return [
    {
      info: {
        id: "msg_parent_user",
        role: "user",
        time: { created: 1_700_000_000_300 },
        agent: "build",
        model: { providerID: "opencode", modelID: "gpt-5.5" },
      },
      parts: [{ id: "prt_parent_user", type: "text", text: "Run the map subagent." }],
    },
    {
      info: {
        id: "msg_parent_assistant",
        role: "assistant",
        time: { created: 1_700_000_000_400, completed: 1_700_000_000_500 },
        parentID: "msg_parent_user",
        agent: "build",
        providerID: "opencode",
        modelID: "gpt-5.5",
        cost: 0,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [
        {
          id: "prt_parent_task",
          type: "tool",
          tool: "task",
          state: {
            status,
            input: { description: "Map subagent", subagent_type: "research" },
            ...(status === "completed" ? { output: "Done." } : {}),
            ...(Object.keys(taskMetadata).length > 0 ? { metadata: taskMetadata } : {}),
            ...(metadata === "structured"
              ? {
                  structured: {
                    task_id: childID,
                    sessionID: childID,
                    state: status,
                    background,
                  },
                }
              : {}),
          },
        },
      ],
    },
  ]
}

function childMessages(withAssistant: boolean) {
  const user = {
    info: {
      id: "msg_child_user",
      role: "user",
      time: { created: 1_700_000_000_600 },
      agent: "research",
      model: { providerID: "opencode", modelID: "gpt-5.5", variant: "high" },
    },
    parts: [{ id: "prt_child_user", type: "text", text: "Research this." }],
  }
  if (!withAssistant) return [user]
  return [
    user,
    {
      info: {
        id: "msg_child_assistant",
        role: "assistant",
        time: { created: 1_700_000_000_700 },
        agent: "research",
        providerID: "opencode",
        modelID: "gpt-5.5",
        variant: "high",
        cost: 0,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [{ id: "prt_child_assistant", type: "text", text: "Working." }],
    },
  ]
}
