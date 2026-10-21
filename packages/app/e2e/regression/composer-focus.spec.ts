import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer, type MockServerConfig } from "../utils/mock-server"
import { expectNoSmokeErrors, trackPageErrors } from "../utils/errors"
import { expectAppVisible } from "../utils/waits"

test.use({ video: "on", screenshot: "on" })

const directory = "C:/OpenCode/ComposerFocus"
const projectID = "proj_composer_focus"
const sessionID = "ses_composer_focus"
const secondSessionID = "ses_composer_focus_second"
const server = "http://127.0.0.1:4096"

async function setup(
  page: Page,
  options: Pick<
    MockServerConfig,
    "questions" | "events" | "eventRetry" | "onQuestionReject" | "onQuestionReply"
  > = {},
) {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "composer-focus",
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
    sessions: [
      {
        id: sessionID,
        slug: "composer-focus",
        projectID,
        directory,
        title: "Composer focus regression",
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
      {
        id: secondSessionID,
        slug: "composer-focus-second",
        projectID,
        directory,
        title: "Composer focus second session",
        version: "dev",
        time: { created: 1700000000001, updated: 1700000000001 },
      },
    ],
    pageMessages: () => ({ items: [] }),
    sessionStatus: { [sessionID]: { type: "idle" }, [secondSessionID]: { type: "idle" } },
    questions: options.questions,
    events: options.events,
    eventRetry: options.eventRetry,
    onQuestionReject: options.onQuestionReject,
    onQuestionReply: options.onQuestionReply,
  })

  await page.addInitScript(
    ({ directory, dirBase64, server, sessionID, secondSessionID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] }, lastProject: { local: directory } }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([
          { type: "session", server, dirBase64, sessionId: sessionID, createdEmpty: true },
          { type: "session", server, dirBase64, sessionId: secondSessionID },
        ]),
      )
    },
    { directory, dirBase64: base64Encode(directory), server, sessionID, secondSessionID },
  )

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  const composer = page.locator('[data-component="session-composer"]')
  await expectAppVisible(composer)
  return composer.locator('[data-component="prompt-input"]')
}

test("keeps an unsent empty-session draft and the stored caret through real tab remounts", async ({ page }, testInfo) => {
  const errors = trackPageErrors(page)
  const input = await setup(page)

  await input.click()
  await page.keyboard.type("alpha omega")
  await setCaret(page, 5)

  await openDockSession(page, secondSessionID)
  await expect.poll(() => editorText(page)).toBe("")
  await input.click()
  await page.keyboard.type("second draft")

  await openDockSession(page, sessionID)
  await expect.poll(() => editorText(page)).toBe("alpha omega")
  await expect.poll(() => caretOffset(page)).toBe(5)
  await page.keyboard.type(" brave")
  await expect.poll(() => editorText(page)).toBe("alpha brave omega")
  await expect.poll(() => caretOffset(page)).toBe(11)

  await openDockSession(page, secondSessionID)
  await expect.poll(() => editorText(page)).toBe("second draft")
  await waitForPaint(page)
  await page.screenshot({ path: testInfo.outputPath("drafts-and-caret-restored.png"), fullPage: true })
  expectNoSmokeErrors(errors, [], [])
})

test("a live question does not steal composer focus and dismiss restores the draft caret", async ({ page }, testInfo) => {
  const errors = trackPageErrors(page)
  const request = {
    id: "que_composer_focus",
    sessionID,
    questions: [
      {
        header: "Focus check",
        question: "Keep typing in the composer?",
        options: [
          { label: "Yes", description: "Keep the current draft and caret" },
          { label: "Later", description: "Dismiss this question for now" },
        ],
      },
    ],
  }
  let armed = false
  let delivered = false
  let dismissed = false
  const input = await setup(page, {
    questions: () => (delivered && !dismissed ? [request] : []),
    eventRetry: 50,
    events: () => {
      if (!armed || delivered) return []
      delivered = true
      return [
        {
          directory,
          payload: {
            id: "evt_composer_focus_question",
            type: "surface.asked",
            properties: request,
          },
        },
      ]
    },
    onQuestionReject: () => {
      dismissed = true
      return true
    },
  })

  await input.click()
  await page.keyboard.type("alpha omega")
  await setCaret(page, 5)
  armed = true

  await expect(page.getByText("Keep typing in the composer?")).toBeVisible()
  await expect.poll(() => input.evaluate((el) => el.contains(document.activeElement))).toBe(true)
  await expect.poll(() => caretOffset(page)).toBe(5)
  await waitForPaint(page)
  await page.screenshot({ path: testInfo.outputPath("question-keeps-composer-focused.png"), fullPage: true })

  await page.getByRole("button", { name: "Dismiss" }).click()
  await expect(page.getByText("Keep typing in the composer?")).toHaveCount(0)
  await expect.poll(() => input.evaluate((el) => el.contains(document.activeElement))).toBe(true)
  await expect.poll(() => caretOffset(page)).toBe(5)
  await page.keyboard.type(" brave")
  await expect.poll(() => editorText(page)).toBe("alpha brave omega")
  await waitForPaint(page)
  await page.screenshot({ path: testInfo.outputPath("dismiss-restores-caret.png"), fullPage: true })
  expectNoSmokeErrors(errors, [], [])
})

async function openDockSession(page: Page, id: string) {
  const tab = page.locator(`[data-dock-tab][data-session-id="${id}"]`).getByRole("tab")
  await tab.click()
  await expect(tab).toHaveAttribute("aria-selected", "true")
  await expect(page).toHaveURL(/\/(?:$|[?#])/)
}

function editorText(page: Page) {
  return page.locator('[data-component="prompt-input"]').evaluate((el) => el.textContent ?? "")
}

function caretOffset(page: Page) {
  return page.locator('[data-component="prompt-input"]').evaluate((el) => {
    const selection = window.getSelection()
    if (!selection?.anchorNode || !el.contains(selection.anchorNode)) return null
    return selection.anchorOffset
  })
}

async function setCaret(page: Page, offset: number) {
  await page.locator('[data-component="prompt-input"]').evaluate((el, nextOffset) => {
    const node = el.firstChild
    if (!node) throw new Error("prompt text node missing")
    const range = document.createRange()
    const selection = window.getSelection()
    range.setStart(node, nextOffset)
    range.collapse(true)
    selection?.removeAllRanges()
    selection?.addRange(range)
  }, offset)
}

async function waitForPaint(page: Page) {
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  )
  await page.screenshot()
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
}
