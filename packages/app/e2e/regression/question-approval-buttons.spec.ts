import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { trackPageErrors, expectNoSmokeErrors } from "../utils/errors"
import { expectAppVisible } from "../utils/waits"

test.use({ video: "on", screenshot: "on" })

const directory = "C:/OpenCode/QuestionApproval"
const projectID = "proj_question_approval"
const sourceID = "ses_approval_source"
const targetID = "ses_approval_target"

function screenshotPath(name: string) {
  return test.info().outputPath(name)
}

function session(id: string, title: string) {
  return {
    id,
    slug: id,
    projectID,
    directory,
    title,
    version: "dev",
    time: { created: 1700000000000, updated: 1700000000000 },
  }
}

const baseConfig = {
  directory,
  project: {
    id: projectID,
    worktree: directory,
    vcs: "git",
    name: "question-approval",
    time: { created: 1700000000000, updated: 1700000000000 },
    sandboxes: [],
  },
  provider: {
    all: [
      {
        id: "opencode",
        name: "OpenCode",
        models: { "test-model": { id: "test-model", name: "Test model", limit: { context: 200_000 } } },
      },
    ],
    connected: ["opencode"],
    default: { providerID: "opencode", modelID: "test-model" },
  },
  sessions: [session(sourceID, "Approval source"), session(targetID, "Approval target")],
  pageMessages: () => ({ items: [] }),
}

async function openApprovalApp(page: import("@playwright/test").Page, config: Parameters<typeof mockOpenCodeServer>[1]) {
  await mockOpenCodeServer(page, config)
  await page.addInitScript(({ directory, sourceID }) => {
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
      JSON.stringify([{ type: "session", dirBase64: btoa(directory), sessionId: sourceID }]),
    )
  }, { directory, sourceID })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/${base64Encode(directory)}/session/${sourceID}`)
  await expectAppVisible(page.locator('[data-component="question-popup"]'))
}

test("one-click chat approval sends the recorded text into the session and answers the question", async ({ page }) => {
  const errors = trackPageErrors(page)
  const prompts: { sessionID: string; body: Record<string, unknown> }[] = []
  const replies: { requestID: string; body: unknown }[] = []
  const request = {
    id: "que_approval_chat_send",
    sessionID: targetID,
    questions: [
      {
        question: "Sende /visual-qa-testing im Chat, um den Skill zu starten?",
        header: "Skill-Freigabe",
        chatSend: { text: "/visual-qa-testing", description: "Startet den visuellen QA-Test" },
        options: [{ label: "Manuell", description: "Text selbst senden" }],
      },
    ],
  }
  await openApprovalApp(page, {
    ...baseConfig,
    questions: () => (prompts.length ? [] : [request]),
    events: () => [{ directory, payload: { id: "evt_approval_chat_send", type: "surface.asked", properties: request } }],
    onSessionPrompt: (input) => {
      prompts.push({ sessionID: input.sessionID, body: input.body as Record<string, unknown> })
      return { data: { sessionID: input.sessionID, messageID: "msg_mock_approval", admittedSeq: 1 } }
    },
    onQuestionReply: (reply) => {
      replies.push(reply)
      return true
    },
  })

  const popup = page.locator('[data-component="question-popup"]')
  await expectAppVisible(popup.getByText("Sende /visual-qa-testing im Chat, um den Skill zu starten?"))
  await expectAppVisible(
    popup.getByText("Erwartet: Freigabe-Klick sendet den hinterlegten Text in den Chat und bestätigt die Frage."),
  )
  const sendButton = popup.locator('[data-slot="question-chat-send"]')
  await expectAppVisible(sendButton)
  await expect(sendButton).toHaveText("Send approval")
  await expect(sendButton).toHaveAttribute("title", "Startet den visuellen QA-Test")
  await page.screenshot({ path: screenshotPath("question-chat-approval.png"), fullPage: true })

  await sendButton.click()

  await expect.poll(() => prompts).toHaveLength(1)
  expect(prompts[0]!.sessionID).toBe(targetID)
  expect(prompts[0]!.body).toMatchObject({ prompt: { text: "/visual-qa-testing" }, delivery: "queue" })
  await expect.poll(() => replies).toHaveLength(1)
  expect(replies[0]!.requestID).toBe(request.id)
  expect(replies[0]!.body).toMatchObject({ answers: [["/visual-qa-testing"]] })
  await expect(popup).toHaveCount(0)
  await page.screenshot({ path: screenshotPath("question-chat-approval-submitted.png"), fullPage: true })
  expectNoSmokeErrors(errors, [], [])
})

test("one-click recommendation approval submits the recommended answers without touching the chat", async ({ page }) => {
  const errors = trackPageErrors(page)
  const prompts: { sessionID: string; body: Record<string, unknown> }[] = []
  const replies: { requestID: string; body: unknown }[] = []
  const request = {
    id: "que_approval_recommended",
    sessionID: targetID,
    questions: [
      {
        question: "Continue with the recommended plan?",
        header: "Plan approval",
        recommended: "yes",
        options: [
          { id: "yes", label: "Yes", description: "Continue" },
          { id: "no", label: "No", description: "Keep discussing" },
        ],
      },
    ],
  }
  await openApprovalApp(page, {
    ...baseConfig,
    questions: () => (prompts.length || replies.length ? [] : [request]),
    events: () => [{ directory, payload: { id: "evt_approval_recommended", type: "surface.asked", properties: request } }],
    onSessionPrompt: (input) => {
      prompts.push({ sessionID: input.sessionID, body: input.body as Record<string, unknown> })
      return { data: { sessionID: input.sessionID, messageID: "msg_mock_approval", admittedSeq: 1 } }
    },
    onQuestionReply: (reply) => {
      replies.push(reply)
      return true
    },
  })

  const popup = page.locator('[data-component="question-popup"]')
  await expectAppVisible(popup.getByText("Continue with the recommended plan?"))
  const approveButton = popup.locator('[data-slot="question-quick-approve"]')
  await expectAppVisible(approveButton)
  await expect(approveButton).toHaveText("Use recommendation")
  await expect(approveButton).toHaveAttribute("title", "Yes")
  await expect(popup.locator('[data-slot="question-chat-send"]')).toHaveCount(0)
  await page.screenshot({ path: screenshotPath("question-quick-approve.png"), fullPage: true })

  await approveButton.click()

  await expect.poll(() => replies).toHaveLength(1)
  expect(replies[0]!.requestID).toBe(request.id)
  expect(replies[0]!.body).toMatchObject({ answers: [["Yes"]] })
  expect(prompts).toHaveLength(0)
  await expect(popup).toHaveCount(0)
  await page.screenshot({ path: screenshotPath("question-quick-approve-submitted.png"), fullPage: true })
  expectNoSmokeErrors(errors, [], [])
})

test("chat approval waits for earlier answers and suppresses the recommendation shortcut request-wide", async ({ page }) => {
  const errors = trackPageErrors(page)
  const prompts: { sessionID: string; body: Record<string, unknown> }[] = []
  const replies: { requestID: string; body: unknown }[] = []
  const request = {
    id: "que_approval_multi",
    sessionID: targetID,
    questions: [
      {
        question: "Pick the review mode first?",
        header: "Review mode",
        options: [
          { label: "Fast", description: "Quick pass" },
          { label: "Deep", description: "Thorough pass" },
        ],
      },
      {
        question: "Sende /multi-agent-review im Chat, um das Review zu starten?",
        header: "Skill-Freigabe",
        chatSend: { text: "/multi-agent-review", label: "Review starten" },
        options: [{ label: "Manuell", description: "Text selbst senden" }],
      },
    ],
  }
  await openApprovalApp(page, {
    ...baseConfig,
    questions: () => (prompts.length ? [] : [request]),
    events: () => [{ directory, payload: { id: "evt_approval_multi", type: "surface.asked", properties: request } }],
    onSessionPrompt: (input) => {
      prompts.push({ sessionID: input.sessionID, body: input.body as Record<string, unknown> })
      return { data: { sessionID: input.sessionID, messageID: "msg_mock_approval", admittedSeq: 1 } }
    },
    onQuestionReply: (reply) => {
      replies.push(reply)
      return true
    },
  })

  const popup = page.locator('[data-component="question-popup"]')
  await expectAppVisible(popup.getByText("Pick the review mode first?"))
  // The recommendation shortcut must stay hidden for the whole request, and the chat
  // approval must wait until the earlier question is answered.
  await expect(popup.locator('[data-slot="question-quick-approve"]')).toHaveCount(0)
  await expect(popup.locator('[data-slot="question-chat-send"]')).toHaveCount(0)

  await popup.locator('[data-slot="question-option"]').filter({ hasText: "Deep" }).click()
  await popup.getByRole("button", { name: "Next", exact: true }).click()

  const sendButton = popup.locator('[data-slot="question-chat-send"]')
  await expectAppVisible(sendButton)
  await expect(sendButton).toHaveText("Review starten")
  await page.screenshot({ path: screenshotPath("question-chat-approval-multi-tab.png"), fullPage: true })

  await sendButton.click()

  await expect.poll(() => prompts).toHaveLength(1)
  expect(prompts[0]!.sessionID).toBe(targetID)
  expect(prompts[0]!.body).toMatchObject({ prompt: { text: "/multi-agent-review" }, delivery: "queue" })
  await expect.poll(() => replies).toHaveLength(1)
  expect(replies[0]!.body).toMatchObject({ answers: [["Deep"], ["/multi-agent-review"]] })
  await expect(popup).toHaveCount(0)
  await page.screenshot({ path: screenshotPath("question-chat-approval-multi-submitted.png"), fullPage: true })
  expectNoSmokeErrors(errors, [], [])
})
