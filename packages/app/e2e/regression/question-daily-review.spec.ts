import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import fs from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectNoSmokeErrors, trackPageErrors } from "../utils/errors"
import { expectAppVisible } from "../utils/waits"

// Exercise the real popup with hand-authored synthetic review text, never copied
// coordinator output. Answers only reach the mock API, not a real review run.
const directory = "C:/OpenCode/DailyReviewVisualQA"
const sessionID = "ses_daily_review_visual_qa"
const currentID = "ses_daily_review_qa_current"
const projectID = "proj_daily_review_visual_qa"
const fixture = process.env.DAILY_REVIEW_QA_PAYLOAD ?? fileURLToPath(new URL("../fixtures/daily-review-questions.json", import.meta.url))
const scenarios = [{ fixture, options: false }, {
  fixture: fileURLToPath(new URL("../fixtures/daily-review-options.json", import.meta.url)), options: true,
}]

test.use({ video: "on" })
for (const scenario of scenarios) for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`${scenario.options ? "Morning option buttons remain individually selectable" : "LLM morning explanations remain meaningful and usable"} at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    const payload = JSON.parse(await fs.readFile(scenario.fixture, "utf8"))
    const errors = trackPageErrors(page)
    const failedResponses: string[] = []
    page.on("response", (response) => {
      if (response.status() >= 400) failedResponses.push(`${response.status()} ${new URL(response.url()).pathname}`)
    })
    const replies: unknown[] = []
    const request = { id: "que_daily_review_visual_qa", sessionID, questions: payload.questions }
    await mockOpenCodeServer(page, {
      directory,
      project: { id: projectID, worktree: directory, vcs: "git", name: "Daily Review QA", time: { created: 1, updated: 1 }, sandboxes: [] },
      provider: { all: [], connected: [], default: {} },
      sessions: [sessionID, currentID].map(id => ({ id, projectID, directory, title: "Daily Review QA (isolated)", version: "1", time: { created: 1700000000000, updated: 1700000000000 } })),
      pageMessages: () => ({ items: [] }),
      questions: () => replies.length ? [] : [request],
      events: () => [{ directory, payload: { id: "evt_daily_review_qa", type: "surface.asked", properties: request } }],
      onQuestionReply: (reply) => { replies.push(reply); return true },
    })
    await page.addInitScript(({ directory, dirBase64, sessionID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem("opencode.global.dat:server", JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] }, lastProject: { local: directory } }))
      localStorage.setItem("opencode.global.dat:tabs", JSON.stringify([{ type: "session", dirBase64, sessionId: sessionID }]))
    }, { directory, dirBase64: base64Encode(directory), sessionID: currentID })
    await page.goto(`/${base64Encode(directory)}/session/${currentID}`)
    const popup = page.locator('[data-component="question-popup"]')
    await expectAppVisible(popup)
    // Capture the unchanged reproduction before assertions, including a red baseline.
    await page.screenshot({ path: test.info().outputPath(`daily-review-first-${viewport.width}.png`), fullPage: true })
    for (const [index, question] of payload.questions.entries()) {
      const heading = popup.getByText(question.question, { exact: true })
      await expect(heading).toBeVisible()
      const visibleCopy = await popup.locator('[data-slot="question-content"]').innerText()
      expect(visibleCopy).not.toMatch(/geprüfte Fundstelle|Beschreibung steht im aufklappbaren|Korrektur steht im aufklappbaren/)
      expect(visibleCopy).toContain("Beispiel:")
      expect(visibleCopy).toContain("Das kann passieren:")
      expect(visibleCopy).toContain("Antwort auf deine Rückfrage:")
      if (index === 0) {
        expect(visibleCopy).toContain("Test-Spielstand")
        expect(visibleCopy).not.toContain("WaitForSave")
        await popup.locator("details").first().locator("summary").click()
        await expect(popup.getByText(/WaitForSave/)).toBeVisible()
        await popup.locator("details").first().locator("summary").click()
      }
      await heading.scrollIntoViewIfNeeded()
      expect(await popup.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
      expect(await popup.evaluate(element => Array.from(element.querySelectorAll<HTMLElement>("*"))
        .filter(child => ["auto", "scroll"].includes(getComputedStyle(child).overflowY) && child.scrollHeight > child.clientHeight + 1).length)).toBeLessThanOrEqual(1)
      await page.screenshot({ path: test.info().outputPath(`daily-review-${index + 1}-${viewport.width}.png`), fullPage: true })
      await expect(popup.locator('[data-slot="question-option"]').filter({ hasText: "Mehr Details" })).toHaveCount(1)
      if (scenario.options) {
        for (const label of ["Option 1", "Option 2", "Option 3"]) {
          const option = popup.locator('[data-slot="question-option"]').filter({ hasText: new RegExp(`^${label}$`) })
          await expect(option).toHaveCount(1)
          await option.scrollIntoViewIfNeeded()
          await expect(option).toBeVisible()
        }
        expect(visibleCopy).toContain("Optionen:")
      }
      await popup.locator('[data-slot="question-free-input"]').fill(index === 0 ? "Bitte erkläre mir den Unterschied zum nächsten Punkt." : "")
      const picked = popup.locator('[data-slot="question-option"]').filter({ hasText: scenario.options ? /^Option 2$/ : index === 0 ? "Mehr Details" : /^Ja/ })
      await picked.click()
      await expect(picked).toHaveAttribute("aria-checked", "true")
      await page.screenshot({ path: test.info().outputPath(`daily-review-answer-${index + 1}-${viewport.width}.png`), fullPage: true })
      await popup.locator('[data-slot="question-footer"]').getByRole("button", { name: index + 1 === payload.questions.length ? "Submit" : "Next", exact: true }).click()
    }
    await expect.poll(() => replies.length).toBe(1)
    expect(JSON.stringify(replies[0])).toContain("Bitte erkläre mir den Unterschied zum nächsten Punkt.")
    expect(JSON.stringify(replies[0])).toMatch(scenario.options ? /option:2|Option 2/ : /question|Mehr Details/)
    expectNoSmokeErrors(errors, [], [])
    expect(failedResponses).toEqual([])
    await fs.writeFile(test.info().outputPath("qa-observations.json"), JSON.stringify({ viewport, questionsReviewed: payload.questions.length, consoleErrors: errors, failedResponses, isolatedReplies: replies.length }, null, 2))
  })
}
