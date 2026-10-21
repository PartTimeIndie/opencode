import { expect, test, type Page, type TestInfo } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { trackPageErrors, expectNoSmokeErrors } from "../utils/errors"
import { expectAppVisible } from "../utils/waits"

test.use({ video: "on", screenshot: "on" })
test.setTimeout(180_000)

const directory = "C:/OpenCode/CommandRollback"
const projectID = "proj_command_rollback"
const sessionID = "ses_command_rollback"
const otherSessionID = "ses_command_rollback_other"
const commandBody = "Long generated command prompt body that was never visible in chat."

test("restores only visible command text and focuses the composer when rolling back a session message", async ({ page }, testInfo) => {
  await runRollbackScenario(page, testInfo, "restore", { delay: true })
})

test("restores only visible command text when undo rolls back a session message", async ({ page }, testInfo) => {
  await runRollbackScenario(page, testInfo, "undo")
})

test("does not expose the undo draft until a busy rollback has completed", async ({ page }, testInfo) => {
  await runRollbackScenario(page, testInfo, "undo-palette", { active: true })
})

test("rolls back a busy turn before restoring and resubmits the unchanged message exactly once", async ({ page }, testInfo) => {
  await runRollbackScenario(page, testInfo, "restore", { active: true })
})

test("keeps a busy restore scoped to its original composer across a tab switch", async ({ page }, testInfo) => {
  await runRollbackScenario(page, testInfo, "restore", { active: true, switchTab: true })
})

test("keeps a busy undo scoped to its original composer across a tab switch", async ({ page }, testInfo) => {
  await runRollbackScenario(page, testInfo, "undo-palette", { active: true, switchTab: true })
})

async function runRollbackScenario(
  page: Page,
  testInfo: TestInfo,
  trigger: "restore" | "undo" | "undo-palette",
  options: { active?: boolean; switchTab?: boolean; delay?: boolean } = {},
) {
  const errors = trackPageErrors(page)
  const reverts: unknown[] = []
  const interrupts: string[] = []
  const requestOrder: Array<"interrupt" | "rollback"> = []
  const prompts: unknown[] = []
  const events: unknown[] = []
  let currentMessages = messages()
  let releaseRollback = () => {}
  const rollbackGate =
    options.active || options.delay ? new Promise<void>((resolve) => (releaseRollback = resolve)) : Promise.resolve()

  page.on("request", (request) => {
    if (/\/api\/session\/[^/]+\/interrupt(?:\?|$)/.test(request.url())) {
      interrupts.push(request.url())
      requestOrder.push("interrupt")
    }
  })

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "command-rollback",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: options.switchTab ? [session(), otherSession()] : [session()],
    pageMessages: (id) => ({ items: id === otherSessionID ? [] : currentMessages }),
    sessionStatus: () => (options.active ? { [sessionID]: { type: "busy" } } : {}),
    events: () => events.splice(0, events.length),
    eventRetry: 16,
    onSessionInterrupt: () => ({ data: true }),
    onSessionPrompt: (input) => {
      prompts.push(input)
      const body = input.body as {
        id?: string
        prompt?: { text?: string }
        agent?: string
        model?: { providerID?: string; id?: string }
      }
      const id = body.id ?? "msg_replayed_init"
      currentMessages = [...messages().slice(0, 2), userMessage(id, body.prompt?.text ?? "/init")]
      // Mirror real replacement admission: clean the marked range and clear its metadata.
      events.push(
        ...["msg_user_2", "msg_assistant_2"].map((messageID) => ({
          directory, payload: { type: "message.removed", properties: { sessionID, messageID } },
        })),
        { directory, payload: { type: "session.updated", properties: { info: session() } } },
      )
      return {
        data: {
          id,
          sessionID,
          admittedSeq: 1,
          delivery: "steer",
          prompt: body.prompt ?? { text: "/init" },
        },
      }
    },
  })

  await page.route(/\/api\/session\/[^/]+\/rollback(?:\?|$)/, async (route) => {
    reverts.push(JSON.parse(route.request().postData() ?? "{}"))
    requestOrder.push("rollback")
    await rollbackGate
    events.push({
      directory,
      payload: {
        type: "session.updated",
        properties: {
          info: { ...session(), revert: { messageID: "msg_user_2", status: "reverted", fileAction: "journal" } },
        },
      },
    })
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ data: { ...session(), revert: { messageID: "msg_user_2", status: "reverted", fileAction: "journal" } } }),
    })
  })

  await page.addInitScript(
    ({ directory, dirBase64, sessionID, otherSessionID, switchTab, serverUrl }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem("opencode.global.dat:language", JSON.stringify({ locale: "en" }))
      localStorage.setItem("opencode.settings.dat:defaultServerUrl", serverUrl)
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          list: [serverUrl],
          projects: { local: [{ worktree: directory, expanded: true }], [serverUrl]: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory, [serverUrl]: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([
          { type: "session", server: serverUrl, dirBase64, sessionId: sessionID },
          ...(switchTab
            ? [{ type: "session", server: serverUrl, dirBase64, sessionId: otherSessionID }]
            : []),
        ]),
      )
    },
    {
      directory, dirBase64: base64Encode(directory), sessionID, otherSessionID, switchTab: options.switchTab,
      serverUrl: `http://127.0.0.1:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`,
    },
  )

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`, { waitUntil: "commit" })

  const composer = page.locator('[data-component="session-composer"]')
  const input = composer.locator('[data-component="prompt-input"]')
  await expect(composer).toBeVisible({ timeout: 120_000 })
  await expect(page.getByText("/init")).toBeVisible({ timeout: 120_000 })
  if (options.active) await expect(composer.getByRole("button", { name: "Stop" })).toBeVisible()

  if (trigger === "restore") {
    const message = page.locator('[data-message-id="msg_user_2"]')
    await message.locator('[data-component="user-message"]').hover()
    await message.getByRole("button", { name: "Restore message", exact: true }).click()
  }
  if (trigger === "undo") {
    await input.click()
    await page.keyboard.type("/undo")
    await page.keyboard.press("Enter")
  }
  if (trigger === "undo-palette") {
    await page.keyboard.press("Control+Shift+P")
    const search = page.getByRole("textbox", { name: "Search files, commands, and sessions" })
    await expect(search).toBeVisible()
    await search.fill("Undo")
    await page.getByText("Undo", { exact: true }).click()
  }

  if (options.active) {
    await expect.poll(() => interrupts).toEqual([])
    await expect.poll(() => reverts).toEqual([{ messageID: "msg_user_2" }])
    expect(requestOrder).toEqual(["rollback"])
    if (trigger === "restore") {
      await expect(input).toHaveText("/init")
      await page.keyboard.press("Enter")
      expect(prompts).toHaveLength(0)
      await expect(input).toHaveText("/init")
    } else {
      await expect(input).not.toContainText("/init")
    }
    if (options.switchTab) {
      await page.getByRole("tab", { name: "Other session", exact: true }).click()
      await expect(page.getByRole("heading", { name: "Other session", exact: true })).toBeVisible()
      await expect(input).toHaveText("")
      const otherInput = composer.getByRole("textbox")
      await otherInput.fill("unrelated session stays usable")
      await expect(composer.getByRole("button", { name: "Send" })).toBeEnabled()
      await otherInput.fill("")
    }
    releaseRollback()
  }

  if (options.delay && !options.active) {
    await expect.poll(() => reverts).toEqual([{ messageID: "msg_user_2" }])
    await expect(input).toHaveText("/init")
    await expect(composer.getByRole("button", { name: "Send" })).toBeDisabled()
    await page.keyboard.press("Enter")
    expect(prompts).toHaveLength(0)
    await expect(input).toHaveText("/init")
    releaseRollback()
  }

  await expect.poll(() => reverts).toEqual([{ messageID: "msg_user_2" }])
  expect(interrupts).toHaveLength(0)
  if (options.switchTab) {
    await expect(input).toHaveText("")
    await page.getByRole("tab", { name: "Command Rollback QA", exact: true }).click()
    await expect(page.getByRole("heading", { name: "Command Rollback QA", exact: true })).toBeVisible()
  }
  await expect(page.locator('[data-message-id="msg_user_2"]')).toHaveCount(0)
  await expect(input).toContainText("/init")
  await expect(input).not.toContainText(commandBody)
  // Completing rollback must not steal focus from another tab. Focus the
  // recovered composer explicitly when returning to submit its draft.
  if (options.switchTab) await input.click()
  if (trigger === "restore" || trigger === "undo-palette") await expect(input).toBeFocused()
  if (options.active) await expect(composer.getByRole("button", { name: "Send" })).toBeVisible()

  await page.keyboard.press("Enter")
  await expect.poll(() => prompts.length).toBe(1)
  expect(prompts[0]).toMatchObject({
    sessionID,
    body: {
      ...(options.active && !options.switchTab ? { delivery: "steer" } : {}),
      prompt: { text: "/init" },
    },
  })
  await expect(page.locator('[data-message-id="msg_user_2"]')).toHaveCount(0)
  await expect(page.locator("[data-message-id]").filter({ hasText: "/init" })).toHaveCount(1)
  await expect(input).toHaveText("")
  await expect(page.locator('[data-component="session-followup-dock"]')).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Send now" })).toHaveCount(0)

  await page.reload({ waitUntil: "commit" })
  await expect(composer).toBeVisible({ timeout: 120_000 })
  await expect(page.locator("[data-message-id]").filter({ hasText: "/init" })).toHaveCount(1)
  expect(prompts).toHaveLength(1)
  await page.screenshot({
    path: testInfo.outputPath(
      options.active
        ? options.switchTab
          ? "session-command-rollback-active-tab-switch.png"
          : "session-command-rollback-active.png"
        : trigger === "restore"
          ? "session-command-rollback-restore.png"
          : "session-command-rollback.png",
    ),
    fullPage: true,
  })
  expectNoSmokeErrors(errors, [], [])
}

function session() {
  return {
    id: sessionID,
    slug: "command-rollback",
    projectID,
    directory,
    title: "Command Rollback QA",
    version: "dev",
    time: { created: 1700000000000, updated: 1700000000000 },
  }
}

function otherSession() {
  return {
    ...session(),
    id: otherSessionID,
    slug: "command-rollback-other",
    title: "Other session",
  }
}

function messages() {
  return [
    userMessage("msg_user_1", "Remember this setup"),
    assistantMessage("msg_assistant_1", "Setup noted."),
    {
      info: {
        id: "msg_user_2",
        sessionID,
        role: "user",
        time: { created: 1700000002000 },
        summary: { diffs: [] },
        agent: "build",
        model: { providerID: "opencode", modelID: "claude-opus-4-6", variant: "max" },
      },
      parts: [
        { id: "part_user_2_visible", sessionID, messageID: "msg_user_2", type: "text", text: "/init" },
        {
          id: "part_user_2_command_body",
          sessionID,
          messageID: "msg_user_2",
          type: "text",
          text: `\n\n/init:\n${commandBody}`,
        },
      ],
    },
    assistantMessage("msg_assistant_2", "Initialized."),
  ]
}

function userMessage(id: string, text: string) {
  return {
    info: {
      id,
      sessionID,
      role: "user",
      time: { created: id === "msg_user_1" ? 1700000000000 : 1700000004000 },
      summary: { diffs: [] },
      agent: "build",
      model: { providerID: "opencode", modelID: "claude-opus-4-6", variant: "max" },
    },
    parts: [{ id: `${id}_part`, sessionID, messageID: id, type: "text", text }],
  }
}

function assistantMessage(id: string, text: string) {
  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      time: { created: id === "msg_assistant_1" ? 1700000001000 : 1700000003000, completed: 1700000003000 },
      parentID: id === "msg_assistant_1" ? "msg_user_1" : "msg_user_2",
      modelID: "claude-opus-4-6",
      providerID: "opencode",
      mode: "build",
      agent: "build",
      path: { cwd: directory, root: directory },
      cost: 0.01,
      tokens: { input: 100, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
      variant: "max",
      finish: "stop",
    },
    parts: [{ id: `${id}_part`, sessionID, messageID: id, type: "text", text }],
  }
}
