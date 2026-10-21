import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectNoSmokeErrors, trackPageErrors } from "../utils/errors"
import { expectAppVisible } from "../utils/waits"

test.use({ video: "on", screenshot: "on" })

const directory = "C:/OpenCode/QuestionToolStatus"
const projectID = "proj_question_tool_status"
const pendingSessionID = "ses_question_status_pending"
const runningSessionID = "ses_question_status_running"
const dismissedSessionID = "ses_question_status_dismissed"
const requestID = "que_question_status_running"
const question = {
  type: "show_options",
  question: "Continue with the verified implementation?",
  header: "Implementation",
  options: [{ label: "Continue", description: "Resume the implementation" }],
}

test("keeps compact question status visible across tabs and settles it after reply", async ({ page }) => {
  const errors = trackPageErrors(page)
  const events: unknown[] = []
  let waiting = true

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "question-tool-status",
      time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "test-model": { id: "test-model", name: "Test Model", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "test-model" },
    },
    sessions: [
      session(pendingSessionID, "Preparing question"),
      session(runningSessionID, "Waiting question"),
      session(dismissedSessionID, "Dismissed question"),
    ],
    pageMessages: (sessionID) => ({ items: messages(sessionID) }),
    sessionStatus: () => ({
      [pendingSessionID]: { type: "busy" },
      ...(waiting ? { [runningSessionID]: { type: "busy" } } : {}),
    }),
    questions: () =>
      waiting
        ? [{ id: requestID, sessionID: runningSessionID, questions: [question] }]
        : [],
    eventRetry: 10,
    events: () => events.splice(0),
    onQuestionReply: (input) => {
      waiting = false
      events.push(
        {
          directory,
          payload: {
            type: "surface.replied",
            properties: { sessionID: runningSessionID, requestID, answers: [["Continue"]] },
          },
        },
        {
          directory,
          payload: {
            type: "message.part.updated",
            properties: { part: questionPart(runningSessionID, "completed") },
          },
        },
      )
      return input.requestID === requestID
    },
  })

  await configureTabs(page)
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${runningSessionID}`)
  await page.locator(`[data-dock-tab][data-session-id="${runningSessionID}"]`).click()

  const running = page.locator('[data-component="question-tool-status"][data-status="running"]')
  await expectAppVisible(running)
  await expectAppVisible(running.getByText("Waiting for your answer..."))
  await expect(running.locator('[data-component="spinner"]')).toHaveCount(1)
  expect(
    await running
      .locator('[data-component="spinner"]')
      .evaluate((element) => element.getAnimations({ subtree: true }).length),
  ).toBe(0)
  await expect(page.locator('[data-component="dock-prompt"][data-kind="question"]')).toHaveCount(1)
  await expect(page.locator('[data-component="question-tool-status"]')).toHaveCount(1)
  await page.screenshot({ path: "test-results/question-tool-status-running-desktop.png", fullPage: true })

  await page.locator(`[data-dock-tab][data-session-id="${pendingSessionID}"]`).click()
  const pending = page.locator('[data-component="question-tool-status"][data-status="pending"]')
  await expectAppVisible(pending)
  await expectAppVisible(pending.getByText("Preparing question..."))

  await page.setViewportSize({ width: 390, height: 844 })
  await expectAppVisible(pending)
  await page.screenshot({ path: "test-results/question-tool-status-pending-mobile.png", fullPage: true })

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.locator(`[data-dock-tab][data-session-id="${runningSessionID}"]`).click()
  await expectAppVisible(running)
  const dock = page.locator('[data-component="dock-prompt"][data-kind="question"]')
  await dock.locator('[data-slot="question-option"]').filter({ hasText: "Continue" }).click()
  await dock.getByRole("button", { name: "Submit" }).click()

  await expect(dock).toHaveCount(0)
  await expect(page.locator('[data-component="question-tool-status"]')).toHaveCount(0)
  await expectAppVisible(page.locator('[data-slot="basic-tool-tool-title"]').filter({ hasText: "Questions" }))

  await page.locator(`[data-dock-tab][data-session-id="${dismissedSessionID}"]`).click()
  events.push({
    directory,
    payload: {
      type: "message.part.updated",
      properties: { part: questionPart(dismissedSessionID, "dismissed") },
    },
  })
  await expectAppVisible(page.getByText("Questions dismissed"))
  await expect(page.getByText("Tool execution interrupted")).toHaveCount(0)
  await expect(page.getByText("Failed", { exact: true })).toHaveCount(0)
  await page.screenshot({ path: "test-results/question-tool-dismissed-desktop.png" })
  await page.setViewportSize({ width: 390, height: 844 })
  await expectAppVisible(page.getByText("Questions dismissed"))
  await page.screenshot({ path: "test-results/question-tool-dismissed-mobile.png" })
  expectNoSmokeErrors(errors, [], [])
})

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

function messages(sessionID: string) {
  const userID = `${sessionID}_user`
  const assistantID = `${sessionID}_assistant`
  return [
    {
      info: {
        id: userID,
        sessionID,
        role: "user",
        time: { created: 1_700_000_000_100 },
        agent: "build",
        model: { providerID: "opencode", modelID: "test-model" },
      },
      parts: [{ id: `${userID}_text`, sessionID, messageID: userID, type: "text", text: "Ask one question." }],
    },
    {
      info: {
        id: assistantID,
        sessionID,
        role: "assistant",
        parentID: userID,
        time: { created: 1_700_000_000_200 },
        agent: "build",
        mode: "build",
        modelID: "test-model",
        providerID: "opencode",
        path: { cwd: directory, root: directory },
        cost: 0,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [questionPart(sessionID, questionStatus(sessionID))],
    },
  ]
}

function questionStatus(sessionID: string) {
  if (sessionID === pendingSessionID) return "pending"
  if (sessionID === dismissedSessionID) return "dismissed"
  return "running"
}

function questionPart(sessionID: string, status: "pending" | "running" | "completed" | "dismissed") {
  const messageID = `${sessionID}_assistant`
  const input = { questions: [question] }
  const base = {
    id: `${sessionID}_question`,
    sessionID,
    messageID,
    type: "tool",
    tool: "question",
  }
  if (status === "dismissed") {
    return {
      ...base,
      state: {
        status: "error",
        input,
        error: "The user dismissed this question",
        time: { start: 1_700_000_000_300, end: 1_700_000_000_400 },
      },
    }
  }
  if (status === "pending") return { ...base, state: { status, input, raw: JSON.stringify(input) } }
  if (status === "running") return { ...base, state: { status, input, time: { start: 1_700_000_000_300 } } }
  return {
    ...base,
    state: {
      status,
      input,
      output: "Answered 1 question",
      metadata: { answers: [["Continue"]] },
      time: { start: 1_700_000_000_300, end: 1_700_000_000_400 },
    },
  }
}

async function configureTabs(page: Page) {
  await page.addInitScript(
    ({ directory, dirBase64, pendingSessionID, runningSessionID, dismissedSessionID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
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
            { type: "session", dirBase64, sessionId: pendingSessionID },
            { type: "session", dirBase64, sessionId: runningSessionID },
            { type: "session", dirBase64, sessionId: dismissedSessionID },
          ]),
      )
    },
    { directory, dirBase64: base64Encode(directory), pendingSessionID, runningSessionID, dismissedSessionID },
  )
}
