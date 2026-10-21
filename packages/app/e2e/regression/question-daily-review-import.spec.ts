import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { createRequire } from "node:module"
import fs from "node:fs/promises"
import path from "node:path"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectNoSmokeErrors, trackPageErrors } from "../utils/errors"
import { expectAppVisible } from "../utils/waits"

// Rendering uses the real popup with a mock HTTP transport; persistence/import uses
// the real Coordinator in a freshly allocated OS-temp state, never the live host.
// Run explicitly with DAILY_REVIEW_QA_COORDINATOR_ROOT pointing to its checkout.
type Fixture = {
  root: string
  start: { runId: string; runDate: string; pendingQuestions: { reviewOrigin: { kind: string } }[] }
  payload(): { questions: { question: string }[] }
  revise(): { questions: { question: string }[] }
  state(): { morningWorkflowV1: { cases: Record<string, { status: string }> } }
  importAnswers(answers: unknown[], assessments?: unknown[]): {
    feedbackAssessmentRequest?: { responseSha256: string; items: { questionId: string; commentSha256: string }[] }
    scopeRevisionRequired?: boolean
    pendingQuestionIDs: string[]
    acceptedImplementations: unknown[]
    implementationRequired: boolean
    resumeRequired: boolean
  }
  dispose(): void
}

const directory = "C:/OpenCode/DailyReviewRealImportQA"
const sessionID = "ses_daily_review_real_import_qa"
const currentID = "ses_daily_review_real_import_current"
const projectID = "proj_daily_review_real_import_qa"
const require = createRequire(import.meta.url)

test.use({ video: "on" })
for (const scopeRevision of [false, true]) for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`native latest-first ${scopeRevision ? "scope revision" : "answers"} persist through real isolated import at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    const root = process.env.DAILY_REVIEW_QA_COORDINATOR_ROOT
    if (!root || !path.isAbsolute(root)) throw new Error("Set DAILY_REVIEW_QA_COORDINATOR_ROOT to the Coordinator checkout; this integration test never substitutes mocked persistence.")
    const bridge = require(path.join(root, "scripts/daily-review-qa.js")) as { createFixture(): Fixture }
    const fixture = bridge.createFixture()
    try {
      const payload = fixture.payload()
      expect(fixture.start.pendingQuestions.map(q => q.reviewOrigin.kind)).toEqual(["current", "current", "nightly_repair", "carryover_unanswered", "carryover_unanswered"])
      await page.setViewportSize(viewport)
      const errors = trackPageErrors(page)
      const failedResponses: string[] = []
      page.on("response", response => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${new URL(response.url()).pathname}`) })
      const replies: { answers: unknown[] }[] = []
      let request = { id: "que_daily_review_real_import", sessionID, questions: payload.questions }
      let active = true
      let dismissals = 0
      await mockOpenCodeServer(page, {
        directory,
        project: { id: projectID, worktree: directory, vcs: "git", name: "Daily Review real import QA", time: { created: 1, updated: 1 }, sandboxes: [] },
        provider: { all: [], connected: [], default: {} },
        sessions: [sessionID, currentID].map(id => ({ id, projectID, directory, title: "Daily Review QA (isolated import)", version: "1", time: { created: 1700000000000, updated: 1700000000000 } })),
        pageMessages: () => ({ items: [] }),
        questions: () => active ? [request] : [],
        events: () => active ? [{ directory, payload: { id: "evt_daily_review_real_import", type: "surface.asked", properties: request } }] : [],
        onQuestionReply: reply => { active = false; replies.push(reply.body as { answers: unknown[] }); return true },
        onQuestionReject: () => { active = false; dismissals++; return true },
      })
      await page.addInitScript(({ directory, dirBase64, sessionID }) => {
        localStorage.setItem("settings.v3", JSON.stringify({}))
        localStorage.setItem("opencode.global.dat:server", JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] }, lastProject: { local: directory } }))
        localStorage.setItem("opencode.global.dat:tabs", JSON.stringify([{ type: "session", dirBase64, sessionId: sessionID }]))
      }, { directory, dirBase64: base64Encode(directory), sessionID: currentID })
      await page.goto(`/${base64Encode(directory)}/session/${currentID}`)
      const popup = page.locator('[data-component="question-popup"]')
      await expectAppVisible(popup)
      const unchangedState = JSON.stringify(fixture.state())
      await popup.locator('[data-slot="question-footer"]').getByRole("button", { name: "Dismiss", exact: true }).click()
      await expect.poll(() => dismissals).toBe(1)
      await expect(popup).not.toBeVisible()
      expect(replies).toHaveLength(0)
      expect(JSON.stringify(fixture.state())).toBe(unchangedState)
      // A dismissed UI request has no response receipt. Re-display the same
      // immutable source under a new host request, not a new Coordinator round.
      request = { ...request, id: "que_daily_review_after_dismissal" }
      active = true
      await page.reload()
      await expectAppVisible(popup)
      expect(fixture.payload()).toEqual(payload)
      await page.screenshot({ path: test.info().outputPath(`latest-first-before-${viewport.width}.png`), fullPage: true })
      const choices = [/^Ja$/, /^Mehr Details$/, /^Später$|^Spaeter$/, /Abbrechen/, /Abbrechen/]
      for (const [index, question] of payload.questions.entries()) {
        await expect(popup.getByText(question.question, { exact: true })).toBeVisible()
        expect(await popup.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
        expect(await popup.evaluate(element => Array.from(element.querySelectorAll<HTMLElement>("*"))
          .filter(child => ["auto", "scroll"].includes(getComputedStyle(child).overflowY) && child.scrollHeight > child.clientHeight + 1).length)).toBeLessThanOrEqual(1)
        expect(await popup.locator('[data-slot="option-label"]').evaluateAll(labels => labels.every(label => label.scrollWidth <= label.clientWidth + 1))).toBe(true)
        if (index === 0 || index === 1) await popup.locator('[data-slot="question-free-input"]').fill(index === 0
          ? scopeRevision ? "Bitte stattdessen nur lesend untersuchen und berichten, keine automatische Korrektur." : "Nur den isolierten Testzustand pruefen."
          : "Bitte die Grenze genauer erklaeren.")
        const option = popup.locator('[data-slot="question-option"]').filter({ hasText: choices[index] })
        await expect(option).toHaveCount(1)
        await option.scrollIntoViewIfNeeded()
        await option.click()
        await expect(option).toHaveAttribute("aria-checked", "true")
        await page.screenshot({ path: test.info().outputPath(`latest-first-answer-${index + 1}-${viewport.width}.png`), fullPage: true })
        await popup.locator('[data-slot="question-footer"]').getByRole("button", { name: index + 1 === payload.questions.length ? "Submit" : "Next", exact: true }).click()
      }
      await expect.poll(() => replies.length).toBe(1)
      expect(JSON.stringify(replies[0])).toContain(scopeRevision ? "nur lesend untersuchen" : "Nur den isolierten Testzustand pruefen.")
      const pending = fixture.importAnswers(replies[0].answers)
      expect(pending.implementationRequired).toBe(false)
      expect(pending.feedbackAssessmentRequest).toBeDefined()
      const assessment = pending.feedbackAssessmentRequest!
      const imported = fixture.importAnswers(replies[0].answers, assessment.items.map(item => ({
        questionId: item.questionId, responseSha256: assessment.responseSha256, commentSha256: item.commentSha256,
        disposition: scopeRevision ? "requires_revision" : "compatible",
        reason: scopeRevision ? "The comment changes correction to read-only diagnosis." : "The comment only repeats the proposal's isolated-test boundary.",
      })))
      expect(imported.acceptedImplementations).toHaveLength(scopeRevision ? 0 : 1)
      expect(imported.pendingQuestionIDs).toHaveLength(scopeRevision ? 2 : 1)
      expect(imported.resumeRequired).toBe(true)
      expect(imported.implementationRequired).toBe(false)
      const states = Object.values(fixture.state().morningWorkflowV1.cases).map(item => item.status)
      expect(states.sort()).toEqual(scopeRevision ? ["deferred", "discarded", "discarded"] : ["deferred", "discarded", "discarded", "planned"])
      if (scopeRevision) {
        expect(imported.scopeRevisionRequired).toBe(true)
        const revised = fixture.revise()
        expect(revised.questions).toHaveLength(2)
        request = { id: "que_daily_review_revised_import", sessionID, questions: revised.questions }
        active = true
        await page.reload()
        await expectAppVisible(popup)
        for (const [index, question] of revised.questions.entries()) {
          await expect(popup.getByText(question.question, { exact: true })).toBeVisible()
          if (index === 0) {
            await expect(popup).toContainText("Angepasster Vorschlag")
            await expect(popup).toContainText("nur lesend untersuchen")
          } else await expect(popup).toContainText("Antwort auf deine Rückfrage")
          const option = popup.locator('[data-slot="question-option"]').filter({ hasText: index === 0 ? /^Ja$/ : /^Nein$/ })
          await option.scrollIntoViewIfNeeded()
          await option.click()
          await expect(option).toHaveAttribute("aria-checked", "true")
          expect(await popup.locator('[data-slot="option-label"]').evaluateAll(labels => labels.every(label => label.scrollWidth <= label.clientWidth + 1))).toBe(true)
          await page.screenshot({ path: test.info().outputPath(`latest-first-revision-${index + 1}-${viewport.width}.png`), fullPage: true })
          await popup.locator('[data-slot="question-footer"]').getByRole("button", { name: index === 0 ? "Next" : "Submit", exact: true }).click()
        }
        await expect.poll(() => replies.length).toBe(2)
        const final = fixture.importAnswers(replies[1].answers)
        expect(final.pendingQuestionIDs).toHaveLength(0)
        expect(final.acceptedImplementations).toHaveLength(1)
        expect(final.implementationRequired).toBe(true)
      }
      await expect(fs.stat(path.join(fixture.root, "apply-admissions"))).rejects.toThrow()
      expectNoSmokeErrors(errors, [], [])
      expect(failedResponses).toEqual([])
      await page.screenshot({ path: test.info().outputPath(`latest-first-after-${viewport.width}.png`), fullPage: true })
      await fs.writeFile(test.info().outputPath("qa-observations.json"), JSON.stringify({ viewport, realCoordinatorImport: true, mockedHTTPTransport: true, sourceQuestionCount: payload.questions.length, consoleErrors: errors, failedResponses, dismissals, states, pendingQuestions: imported.pendingQuestionIDs.length }, null, 2))
    } finally {
      fixture.dispose()
    }
  })
}
