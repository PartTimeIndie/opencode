import { expect, test, type Locator } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { trackPageErrors, expectNoSmokeErrors } from "../utils/errors"
import { expectAppVisible } from "../utils/waits"

test.use({ screenshot: "on", video: "on" })

const directory = "C:/OpenCode/QuestionShowDiff"
const projectID = "proj_question_show_diff"
const sessionID = "ses_question_show_diff"
const requestID = "que_question_show_diff"

function questionRequest() {
  return {
    id: requestID,
    sessionID,
    questions: [
      {
        type: "show_diff",
        question: "Pruefe den scrollbaren On-Demand Diff.",
        header: "Diff Demo",
        content: "Langer Beispiel-Diff fuer Visual QA: Highlighting, Split-Ansicht und internes Scrollen muessen sofort erkennbar sein.",
        filePath: "StudentTransfer/Controllers/RequestController.cs",
        before: requestControllerText("before"),
        after: requestControllerText("after"),
        options: [
          { id: "approve", label: "Passt", description: "Der Diff ist schnell erfassbar." },
          { id: "revise", label: "Ueberarbeiten", description: "Die Darstellung braucht noch Aenderungen." },
        ],
        allowFeedback: true,
      },
    ],
  }
}

function requestControllerText(mode: "before" | "after") {
  const lines = Array.from({ length: 92 }, (_, index) => {
    const line = index + 1
    return `        audit.Log("RequestController", "Synthetic trace line ${String(line).padStart(2, "0")}");`
  })

  lines[0] = "using StudentTransfer.Domain;"
  lines[1] = "using StudentTransfer.Services;"
  lines[2] = ""
  lines[3] = "namespace StudentTransfer.Controllers"
  lines[4] = "{"
  lines[5] = "    public sealed class RequestController"
  lines[6] = "    {"
  lines[7] = "        public void Complete(Request request)"
  lines[8] = "        {"
  lines[18] = "            if (request.StatusID == (int) RequestStatuses.Completed)"
  lines[19] = "            {"
  lines[20] =
    mode === "before"
      ? "                throw new Exception(\"TransferController: Application has already been completed\");"
      : "                throw new Exception(\"TransferController: Change to test out diff\");"
  lines[21] = "            }"
  lines[38] =
    mode === "before"
      ? "            if (request.StatusID < 12)"
      : "            if (request.StatusID <= (int) RequestStatuses.ReadyForReview)"
  lines[39] = "            {"
  lines[40] =
    mode === "before"
      ? "                validator.RequireLegacyCompletionGate(request);"
      : "                validator.RequireReviewGate(request, includeDrafts: false);"
  lines[41] = "            }"
  lines[63] =
    mode === "before"
      ? "            notifications.SendLegacyCompletionMail(request.StudentID);"
      : "            notifications.SendCompletionDigest(request.StudentID, request.RequestID);"
  lines[82] = "            repository.Save(request);"
  lines[90] = "        }"
  lines[91] = "    }"

  return `${lines.join("\n")}\n`
}

function session() {
  return {
    id: sessionID,
    slug: sessionID,
    parentID: undefined,
    projectID,
    directory,
    title: "Question show diff",
    version: "dev",
    time: { created: 1700000000000, updated: 1700000000000 },
  }
}

async function setup(page: import("@playwright/test").Page) {
  const request = questionRequest()
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "question-show-diff",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: { "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } } },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [session()],
    pageMessages: () => ({ items: [] }),
    questions: () => [request],
    events: () => [
      {
        directory,
        payload: {
          id: "evt_question_show_diff_asked",
          type: "surface.asked",
          properties: request,
        },
      },
    ],
  })

  await page.addInitScript(
    ({ dir, dirBase64, sid }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { local: [{ worktree: dir, expanded: true }] }, lastProject: { local: dir } }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", server: "http://127.0.0.1:4096", dirBase64, sessionId: sid }]),
      )
    },
    { dir: directory, dirBase64: base64Encode(directory), sid: sessionID },
  )
}

test("renders show_diff as a scrollable highlighted diff", async ({ page }) => {
  const errors = trackPageErrors(page)
  await setup(page)

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)

  const question = page.locator('[data-component="session-prompt-dock"] [data-component="dock-prompt"][data-kind="question"]')
  const review = question.locator('[data-slot="question-review"]')
  const diff = question.locator('[data-slot="on-demand-diff"]')
  const diffView = diff.locator('[data-slot="on-demand-diff-view"]')
  await expectAppVisible(question.getByText("Pruefe den scrollbaren On-Demand Diff."))
  await expectAppVisible(diff.getByText("StudentTransfer/Controllers/RequestController.cs"))
  await expectAppVisible(diff.locator("diffs-container"))
  await expectAppVisible(diff.getByText("Change to test out diff"))
  await expect.poll(() => scrollable(diffView)).toBe(true)
  await expect.poll(() => noPageHorizontalOverflow(page)).toBe(true)

  await expectInnerScrollOnly(page, review, diffView)
  await page.screenshot({ path: "test-results/question-show-diff-desktop.png", fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  await expectAppVisible(diff.locator("diffs-container"))
  await expect.poll(() => scrollable(diffView)).toBe(true)
  await expect.poll(() => noPageHorizontalOverflow(page)).toBe(true)
  await expectInnerScrollOnly(page, review, diffView)
  await page.screenshot({ path: "test-results/question-show-diff-mobile.png", fullPage: true })

  expectNoSmokeErrors(errors, [], [])
})

async function expectInnerScrollOnly(page: import("@playwright/test").Page, review: Locator, diffView: Locator) {
  await review.evaluate((element) => {
    element.scrollTop = 0
  })
  await diffView.evaluate((element) => {
    element.scrollTop = 0
  })
  await scrollInside(page, diffView)
  await expect.poll(() => diffView.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  await expect.poll(() => review.evaluate((element) => element.scrollTop)).toBe(0)
}

async function scrollInside(page: import("@playwright/test").Page, locator: Locator) {
  const box = await locator.boundingBox()
  if (!box) throw new Error("Expected diff view to have a bounding box")
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(72, box.height / 2))
  await page.mouse.wheel(0, 620)
}

async function scrollable(locator: Locator) {
  return locator.evaluate((element) => element.scrollHeight > element.clientHeight + 2)
}

async function noPageHorizontalOverflow(page: import("@playwright/test").Page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 2)
}
