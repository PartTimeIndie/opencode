import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { trackPageErrors, expectNoSmokeErrors } from "../utils/errors"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/QuestionImagePaste"
const projectID = "proj_question_image_paste"
const sessionID = "ses_question_image_paste"
const requestID = "que_question_image_paste"

test.setTimeout(120_000)

test("pastes an image into a question text answer as a file reference", async ({ page }) => {
  const errors = trackPageErrors(page)
  const replies: { requestID: string; body: unknown }[] = []
  const uploads: unknown[] = []

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "question-image-paste",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: { model: { id: "model", name: "Model", limit: { context: 200_000 } } },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "model" },
    },
    sessions: [session(sessionID)],
    pageMessages: () => ({ items: [] }),
    questions: () => [questionRequest()],
    events: () => [
      {
        directory,
        payload: {
          id: "evt_question_image_paste",
          type: "surface.asked",
          properties: questionRequest(),
        },
      },
    ],
    onAppQuestionAttachment: (input) => {
      uploads.push(input)
      return {
        ok: true,
        file: { type: "file", mime: input.mime, url: "file:///mock-question-attachments/pasted.png", filename: "pasted.png" },
      }
    },
    onQuestionReply: (reply) => {
      replies.push(reply)
      return true
    },
  })

  await page.addInitScript(
    ({ directory, dirBase64, sessionID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] }, lastProject: { local: directory } }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", server: "http://127.0.0.1:4096", dirBase64, sessionId: sessionID }]),
      )
    },
    { directory, dirBase64: base64Encode(directory), sessionID },
  )

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`, { waitUntil: "domcontentloaded" })
  await expectAppVisible(page.getByText("Paste a screenshot for review."))

  const input = page.locator('[data-slot="question-free-input"]')
  await input.focus()
  await input.evaluate((element) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([new Uint8Array([137, 80, 78, 71])], "clipboard.png", { type: "image/png" }))
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }))
  })

  await expect(page.locator('[data-slot="question-attachment-name"]')).toHaveText("pasted.png")
  await page.screenshot({ path: "test-results/question-image-paste-desktop.png", fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator('[data-slot="question-attachment-name"]')).toBeVisible()
  await page.screenshot({ path: "test-results/question-image-paste-mobile.png", fullPage: true })
  await input.fill("Please inspect this image")
  await input.press("Enter")

  await expect.poll(() => replies.length).toBe(1)
  expect(uploads).toHaveLength(1)
  expect(replies[0]?.body).toEqual({
    answers: [["Please inspect this image", { type: "file", mime: "image/png", url: "file:///mock-question-attachments/pasted.png", filename: "pasted.png" }]],
  })
  expect(JSON.stringify(replies[0]?.body)).not.toContain("data:image")
  expectNoSmokeErrors(errors, [], [])
})

function questionRequest() {
  return {
    id: requestID,
    sessionID,
    questions: [
      {
        type: "ask_text",
        question: "Paste a screenshot for review.",
        header: "Screenshot",
        placeholder: "Paste image and describe it",
      },
    ],
  }
}

function session(id: string) {
  return {
    id,
    slug: id,
    projectID,
    directory,
    title: "Question image paste",
    version: "dev",
    time: { created: 1700000000000, updated: 1700000000000 },
  }
}
