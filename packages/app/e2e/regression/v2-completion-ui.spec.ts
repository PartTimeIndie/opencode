import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectNoSmokeErrors, trackPageErrors } from "../utils/errors"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/V2CompletionUI"
const projectID = "proj_v2_completion_ui"
const sourceSessionID = "ses_v2_completion_source"
const newSessionID = "ses_v2_completion_new"
const assistantIntermediateText = "GPT-5.6 completion rendered"
const assistantText = "GPT-5.6 completion rendered after durable activity settlement."
const shellOutput = "Rendered first PDF page with PyMuPDF"
const toolCallID = "call_v2_completion_read"
const server = "http://127.0.0.1:4096"

test.use({ video: "on", screenshot: "on" })

test("renders a persisted v2 assistant and returns a new session to idle", async ({ page }) => {
  const mobile = process.env.VISUAL_QA_VIEWPORT === "mobile"
  const restored = process.env.VISUAL_QA_RESTORED_SESSION === "1"
  const targetSessionID = mobile || restored ? sourceSessionID : newSessionID
  const errors = trackPageErrors(page)
  const networkFailures: string[] = []
  page.on("requestfailed", (request) =>
    networkFailures.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`),
  )
  page.on("response", (response) => {
    if (response.status() >= 400) networkFailures.push(`${response.status()} ${response.request().method()} ${response.url()}`)
  })
  const sessions: Array<{ id: string } & Record<string, unknown>> = [session(sourceSessionID, "Completion source")]
  const messages = new Map<string, unknown[]>()
  const events: unknown[] = []
  const prompts: Array<{ sessionID: string; body: Record<string, unknown> }> = []
  const messageReads: string[] = []
  let blockMessages = false
  let intermediateDelivered = false
  let continueEvents = false
  let releaseMessages = () => {}
  const messageGate = new Promise<void>((resolve) => (releaseMessages = resolve))

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "V2 completion UI",
      time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "openai",
          name: "OpenAI",
          models: { "gpt-5.6-sol": { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", limit: { context: 200_000 } } },
        },
      ],
      connected: ["openai"],
      default: { providerID: "openai", modelID: "gpt-5.6-sol" },
    },
    agents: [{ name: "build", mode: "primary" }],
    sessions,
    pageMessages: async (sessionID) => {
      if (blockMessages && sessionID === targetSessionID) await messageGate
      return { items: messages.get(sessionID) ?? [] }
    },
    onMessages: (input) => {
      messageReads.push(`${input.phase}:${input.sessionID}`)
    },
    eventRetry: 25,
    events: () => {
      if (intermediateDelivered && !continueEvents) return []
      const next = events.splice(0, 1)
      const payload = (next[0] as { payload?: { type?: string; properties?: { delta?: string } } } | undefined)?.payload
      if (payload?.type === "session.next.text.delta" && payload.properties?.delta === assistantIntermediateText) {
        intermediateDelivered = true
      }
      return next
    },
    onSessionCreate: () => {
      const created = session(newSessionID, "New session")
      sessions.push(created)
      return created
    },
    onSessionPrompt: (input) => {
      const body = input.body as Record<string, unknown>
      const prompt = body.prompt as { text?: string }
      const messageID = typeof body.id === "string" ? body.id : "msg_v2_completion_user"
      const now = Date.now()
      prompts.push({ sessionID: input.sessionID, body })
      messages.set(input.sessionID, [
        {
          info: {
            id: messageID,
            sessionID: input.sessionID,
            role: "user",
            agent: "build",
            model: { providerID: "openai", modelID: "gpt-5.6-sol", variant: "max" },
            time: { created: now },
          },
          parts: [{ id: `${messageID}:text`, sessionID: input.sessionID, messageID, type: "text", text: prompt.text }],
        },
      ])
      blockMessages = true
      events.push(
        event(input.sessionID, "session.next.activity.started", { activityID: "activity_v2_completion", kind: "prompt" }),
        syncEvent(input.sessionID, "session.next.activity.started", 1, {
          activityID: "activity_v2_completion",
          kind: "prompt",
        }),
        event(input.sessionID, "session.next.shell.started", {
          messageID: "msg_v2_completion_shell",
          callID: "call_v2_completion_shell",
          command: "python render.py",
        }),
        event(input.sessionID, "session.next.shell.ended", {
          callID: "call_v2_completion_shell",
          output: shellOutput,
        }),
        event(input.sessionID, "session.next.step.started", {
          assistantMessageID: "msg_v2_completion_assistant",
          agent: "build",
          model: { providerID: "openai", id: "gpt-5.6-sol", variant: "max" },
        }),
        event(input.sessionID, "session.next.tool.input.started", {
          assistantMessageID: "msg_v2_completion_assistant",
          callID: toolCallID,
          name: "read",
        }),
        event(input.sessionID, "session.next.tool.input.ended", {
          assistantMessageID: "msg_v2_completion_assistant",
          callID: toolCallID,
          text: '{"path":"README.md"}',
        }),
        event(input.sessionID, "session.next.tool.called", {
          assistantMessageID: "msg_v2_completion_assistant",
          callID: toolCallID,
          tool: "read",
          input: { path: "README.md" },
          provider: { executed: false },
        }),
        event(input.sessionID, "session.next.text.started", {
          assistantMessageID: "msg_v2_completion_assistant",
          textID: "text",
        }),
        event(input.sessionID, "session.next.text.delta", {
          assistantMessageID: "msg_v2_completion_assistant",
          textID: "text",
          delta: assistantIntermediateText,
        }),
        event(input.sessionID, "session.next.tool.success", {
          assistantMessageID: "msg_v2_completion_assistant",
          callID: toolCallID,
          structured: {},
          content: [{ type: "text", text: "README loaded" }],
          provider: { executed: false },
        }),
        event(input.sessionID, "session.next.text.delta", {
          assistantMessageID: "msg_v2_completion_assistant",
          textID: "text",
          delta: assistantText.slice(assistantIntermediateText.length),
        }),
        event(input.sessionID, "session.next.text.ended", {
          assistantMessageID: "msg_v2_completion_assistant",
          textID: "text",
          text: assistantText,
        }),
        syncEvent(input.sessionID, "session.next.text.ended", 2, {
          assistantMessageID: "msg_v2_completion_assistant",
          textID: "text",
          text: assistantText,
        }),
        event(input.sessionID, "session.next.activity.completed", { activityID: "activity_v2_completion" }),
        syncEvent(input.sessionID, "session.next.activity.completed", 3, {
          activityID: "activity_v2_completion",
        }),
      )
      return { data: { sessionID: input.sessionID, messageID, admittedSeq: 1 } }
    },
  })

  await page.addInitScript(
    ({ directory, dirBase64, server, sessionID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] }, lastProject: { local: directory } }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", server, dirBase64, sessionId: sessionID }]),
      )
    },
    { directory, dirBase64: base64Encode(directory), server, sessionID: sourceSessionID },
  )

  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1280, height: 720 })
  await page.goto("/")
  if (!mobile && !restored) {
    await expectAppVisible(page.locator(`[data-dock-tab][data-session-id="${sourceSessionID}"]`))
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "t", ctrlKey: true, bubbles: true, cancelable: true }))
    })
    // New tabs are drafts; the durable Session is created only on first submit.
    await expect(page.getByRole("tab", { name: "New session", exact: true })).toHaveAttribute("aria-selected", "true")
    expect(sessions.map((item) => item.id)).toEqual([sourceSessionID])
  }
  const composer = page.locator('[data-component="session-prompt-dock"]:visible')
  const input = composer.locator('[data-component="prompt-input"]')
  await expectAppVisible(input)
  await input.fill("Complete the GPT-5.6 UI sentinel.")
  await composer.locator('[data-action="prompt-submit"]').click()

  await expect.poll(() => prompts.at(-1)?.sessionID).toBe(targetSessionID)
  if (!mobile && !restored) {
    await expectAppVisible(page.locator(`[data-dock-tab][data-session-id="${newSessionID}"]`))
    expect(sessions.map((item) => item.id)).toEqual([sourceSessionID, newSessionID])
  }
  await expectAppVisible(page.getByText(shellOutput, { exact: false }))
  await expectAppVisible(page.locator('[data-component="context-tool-group-trigger"]'))
  await expectAppVisible(page.getByText(assistantIntermediateText, { exact: true }))
  if (process.env.VISUAL_QA_SCREENSHOT_INTERMEDIATE) {
    await page.waitForTimeout(500)
    await page.screenshot({ path: process.env.VISUAL_QA_SCREENSHOT_INTERMEDIATE, fullPage: true })
  }
  continueEvents = true
  await expectAppVisible(page.getByText(assistantText))
  releaseMessages()
  await expect.poll(() => messageReads.filter((item) => item === `end:${targetSessionID}`).length).toBeGreaterThan(1)
  await expectAppVisible(page.getByText(assistantText))
  // The turn settled back to idle and the empty composer offers one-click restart of
  // the last run instead of a disabled send button.
  await expect(composer.getByRole("button", { name: "Send" })).toBeEnabled()
  await expect(page.locator('[data-component="prompt-submit-loading-overlay"]')).toHaveCount(0)
  expectNoSmokeErrors(errors, [], [])
  expect(networkFailures).toEqual([])

  if (process.env.VISUAL_QA_SCREENSHOT) {
    await page.waitForTimeout(500)
    await page.screenshot({ path: process.env.VISUAL_QA_SCREENSHOT, fullPage: true })
  }
})

let eventSequence = 0

function event(sessionID: string, type: string, properties: Record<string, unknown>) {
  return {
    directory,
    payload: {
      id: `evt_${type.replaceAll(".", "_")}_${eventSequence++}`,
      type,
      properties: { sessionID, timestamp: Date.now(), ...properties },
    },
  }
}

function syncEvent(sessionID: string, type: string, seq: number, data: Record<string, unknown>) {
  return {
    directory,
    payload: {
      type: "sync",
      syncEvent: {
        id: `evt_${type.replaceAll(".", "_")}`,
        type: `${type}.1`,
        seq,
        aggregateID: sessionID,
        data: { sessionID, timestamp: Date.now(), ...data },
      },
    },
  }
}

function session(id: string, title: string) {
  return {
    id,
    slug: id,
    projectID,
    directory,
    title,
    version: "dev",
    time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
  }
}
