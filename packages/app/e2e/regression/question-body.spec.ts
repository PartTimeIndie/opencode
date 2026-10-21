import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectNoSmokeErrors, trackPageErrors } from "../utils/errors"
import { expectAppVisible } from "../utils/waits"

test.use({ screenshot: "on", video: "on" })

const directory = "C:/OpenCode/QuestionBody"
const projectID = "proj_question_body"
const targetID = "ses_question_body_target"
const currentID = "ses_question_body_current"
const image =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 640 360'%3E%3Crect width='640' height='360' fill='%2322394f'/%3E%3Ccircle cx='190' cy='180' r='100' fill='%23efb366'/%3E%3Cpath d='M340 110h220v140H340z' fill='%236e9f8d'/%3E%3C/svg%3E"
const secondImage =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 640 360'%3E%3Crect width='640' height='360' fill='%23422f55'/%3E%3Cpath d='M60 300L220 80l120 160 90-110 150 170z' fill='%23c69bd8'/%3E%3C/svg%3E"
const audio = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA="
const video = "data:video/mp4;base64,"

type RequestFixture = {
  id: string
  sessionID: string
  questions: unknown[]
}

function session(id: string, title: string) {
  return {
    id,
    projectID,
    directory,
    title,
    version: "1",
    time: { created: 1700000000000, updated: 1700000000000 },
  }
}

async function setup(page: Page, request: RequestFixture) {
  const errors = trackPageErrors(page)
  const replies: unknown[] = []
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "question-body",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: { "gpt-5.5": { id: "gpt-5.5", name: "GPT-5.5", limit: { context: 200_000 } } },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "gpt-5.5" },
    },
    sessions: [session(currentID, "Current session"), session(targetID, "Review target")],
    pageMessages: () => ({ items: [] }),
    questions: () => (replies.length ? [] : [request]),
    events: () => [
      {
        directory,
        payload: { id: `evt_${request.id}`, type: "surface.asked", properties: request },
      },
    ],
    onQuestionReply: (reply) => {
      replies.push(reply)
      return true
    },
  })

  await page.addInitScript(
    ({ directory, dirBase64, currentID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] }, lastProject: { local: directory } }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", dirBase64, sessionId: currentID }]),
      )
      Object.defineProperty(window, "__questionBodyOpenedLinks", { value: [], writable: false })
      window.open = ((url?: string | URL) => {
        ;(window as typeof window & { __questionBodyOpenedLinks: string[] }).__questionBodyOpenedLinks.push(String(url))
        return null
      }) as typeof window.open
    },
    { directory, dirBase64: base64Encode(directory), currentID },
  )
  await page.goto(`/${base64Encode(directory)}/session/${currentID}`)
  const popup = page.locator('[data-component="question-popup"]')
  await expectAppVisible(popup)
  return { popup, replies, errors }
}

async function noHorizontalOverflow(page: Page) {
  return page.locator('[data-component="question-popup"]').evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
}

async function verticalScrollSlots(page: Page) {
  return page.locator('[data-component="question-popup"]').evaluate((popup) =>
    Array.from(popup.querySelectorAll<HTMLElement>("*"))
      .filter((element) => {
        const overflow = getComputedStyle(element).overflowY
        return (overflow === "auto" || overflow === "scroll") && element.scrollHeight > element.clientHeight + 1
      })
      .map((element) => element.dataset.slot ?? element.dataset.component ?? element.tagName.toLowerCase()),
  )
}

test("renders a structured page review and opens the vault only after a visible click", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const request = {
    id: "que_summary_decision",
    sessionID: targetID,
    questions: [
      {
        type: "show_options",
        question: "Soll diese Markdown-Seite behalten werden?",
        header: "Seitenreview",
        body: [
          {
            id: "page-summary",
            type: "markdown",
            content:
              "## Daily Review\n\nDie Seite enthält **formatierte Absätze**, eine Liste und einen [sichtbaren Link](https://example.com/review).\n\n- Eintrag A\n- Eintrag B",
          },
          {
            id: "open-vault",
            type: "action_link",
            label: "Vault öffnen",
            href: "obsidian://open?vault=AgentReview&file=Daily",
            description: "Öffnet die Quellseite nach einem bewussten Klick.",
          },
        ],
        options: [
          { id: "keep", label: "Behalten", description: "Seite weiter prüfen" },
          { id: "discard", label: "Verwerfen", description: "Seite aus dem Review entfernen" },
        ],
        allowFeedback: true,
        custom: false,
      },
    ],
  }
  const { popup, replies, errors } = await setup(page, request)

  await expect(popup.getByRole("heading", { name: "Daily Review" })).toBeVisible()
  await expect(popup.getByText("formatierte Absätze")).toBeVisible()
  await expect(popup.getByText(/^## Daily Review/)).toHaveCount(0)
  await expect(popup.getByText(/^Erwartet:/)).toHaveCount(1)
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __questionBodyOpenedLinks: string[] }).__questionBodyOpenedLinks)).toEqual([])
  await popup.getByRole("button", { name: "Vault öffnen" }).click()
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __questionBodyOpenedLinks: string[] }).__questionBodyOpenedLinks)).toEqual([
    "obsidian://open?vault=AgentReview&file=Daily",
  ])
  await popup.locator('[data-slot="question-option"]').filter({ hasText: "Behalten" }).click()
  await popup.locator('[data-slot="question-free-input"]').fill("Die Zusammenfassung passt.")
  await expect
    .poll(() => popup.locator('[data-slot="question-content"]').evaluate((element) => element.scrollHeight <= element.clientHeight + 1))
    .toBe(true)
  expect(await verticalScrollSlots(page)).toEqual([])
  await expect.poll(() => noHorizontalOverflow(page)).toBe(true)
  await page.screenshot({ path: "test-results/question-body-summary-1440x900.png", fullPage: true })
  await popup.locator('[data-slot="question-footer"]').getByRole("button", { name: "Submit" }).click()
  await expect.poll(() => replies.length).toBe(1)
  expect(replies[0]).toMatchObject({ body: { answers: [["Behalten", "feedback: Die Zusammenfassung passt."]] } })
  expectNoSmokeErrors(errors, [], [])
})

test("uses one continuous middle scroll area for a long body, options, and feedback", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 })
  const request = {
    id: "que_question_single_scroll",
    sessionID: targetID,
    questions: [
      {
        type: "show_options",
        question: "Welche letzte Option soll nach dem vollständigen Review gewählt werden?",
        header: "Scroll-Regression",
        body: [
          {
            id: "long-summary",
            type: "markdown",
            content: [
              "## Langer zusammenhängender Review",
              ...Array.from(
                { length: 12 },
                (_, index) =>
                  `### Abschnitt ${index + 1}\n\nDieser Absatz hält Zusammenfassung und Entscheidung im selben mittleren Seitenfluss.`,
              ),
            ].join("\n\n"),
          },
          {
            id: "review-source",
            type: "action_link",
            label: "Quelle öffnen",
            href: "https://example.com/long-review",
            description: "Sekundäre Aktion innerhalb derselben Scrollfläche.",
          },
        ],
        options: Array.from({ length: 8 }, (_, index) => ({
          id: `option-${index + 1}`,
          label: `Option ${index + 1}`,
          description: index === 7 ? "Die letzte Option muss über den gemeinsamen Scrollbereich erreichbar sein." : "Review-Option",
        })),
        allowFeedback: true,
        custom: false,
      },
    ],
  }
  const { popup, errors } = await setup(page, request)
  const header = popup.locator('[data-slot="question-header"]')
  const expectation = popup.locator('[data-slot="question-expectation"]')
  const middle = popup.locator('[data-slot="question-content"]')
  const options = popup.locator('[data-slot="question-options"]')
  const footer = popup.locator('[data-slot="question-footer"]')
  const lastOption = popup.locator('[data-slot="question-option"]').filter({ hasText: "Option 8" })

  await expectAppVisible(header)
  await expectAppVisible(expectation)
  await expectAppVisible(footer)
  await expect.poll(() => middle.evaluate((element) => element.scrollHeight > element.clientHeight + 1)).toBe(true)
  expect(await verticalScrollSlots(page)).toEqual(["question-content"])
  await expect
    .poll(() => options.evaluate((element) => getComputedStyle(element).overflowY))
    .toBe("visible")

  const headerBefore = await header.boundingBox()
  const footerBefore = await footer.boundingBox()
  await lastOption.scrollIntoViewIfNeeded()
  await expectAppVisible(lastOption)
  await expect.poll(() => middle.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  const headerAfter = await header.boundingBox()
  const footerAfter = await footer.boundingBox()
  expect(headerBefore).not.toBeNull()
  expect(footerBefore).not.toBeNull()
  expect(headerAfter).not.toBeNull()
  expect(footerAfter).not.toBeNull()
  expect(Math.abs(headerAfter!.y - headerBefore!.y)).toBeLessThanOrEqual(1)
  expect(Math.abs(footerAfter!.y - footerBefore!.y)).toBeLessThanOrEqual(1)
  await expectAppVisible(expectation)
  await expectAppVisible(footer.getByRole("button", { name: "Submit" }))
  await expect.poll(() => noHorizontalOverflow(page)).toBe(true)
  await page.screenshot({ path: "test-results/question-body-single-scroll-900x700.png", fullPage: true })
  expectNoSmokeErrors(errors, [], [])
})

test("keeps every media preview visually attached to its stable checkbox and returns ids", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 })
  const request = {
    id: "que_media_checklist",
    sessionID: targetID,
    questions: [
      {
        type: "pick_one",
        question: "Welche Medien sollen beim Eintrag bleiben?",
        header: "Medienreview",
        body: [
          { id: "intro", type: "markdown", content: "### Medien des Eintrags\n\nJede Vorschau hat ihre eigene Auswahl." },
          {
            id: "entry-media",
            type: "media_checklist",
            label: "Medien behalten",
            description: "Aktiv bedeutet: Dieses Medium bleibt am Eintrag.",
            items: [
              { id: "hero", label: "Hero-Bild", mediaType: "image", src: image, defaultChecked: true },
              { id: "detail", label: "Detail-Bild", mediaType: "image", src: secondImage, defaultChecked: true },
              { id: "clip", label: "Gameplay-Video", mediaType: "video", src: video, defaultChecked: true },
              { id: "voice", label: "Audio-Notiz", mediaType: "audio", src: audio, defaultChecked: true },
              { id: "source", label: "Quelldatei", mediaType: "file", src: "C:/Notes/Daily/source.md" },
            ],
          },
        ],
        options: [
          { id: "keep-entry", label: "Eintrag behalten" },
          { id: "discard-entry", label: "Eintrag verwerfen" },
        ],
        allowFeedback: true,
        custom: false,
      },
    ],
  }
  const { popup, replies, errors } = await setup(page, request)

  const items = popup.locator('[data-slot="question-media-item"]')
  await expect(items).toHaveCount(5)
  await expect(items.filter({ hasText: "Hero-Bild" }).locator("img")).toBeVisible()
  await expect(items.filter({ hasText: "Gameplay-Video" }).locator("video")).toBeVisible()
  await items.filter({ hasText: "Audio-Notiz" }).scrollIntoViewIfNeeded()
  await expect(items.filter({ hasText: "Audio-Notiz" }).locator("audio")).toBeVisible()
  await expect(items.filter({ hasText: "Quelldatei" }).locator("code")).toContainText("source.md")
  await items.filter({ hasText: "Hero-Bild" }).scrollIntoViewIfNeeded()
  await items.filter({ hasText: "Hero-Bild" }).getByRole("button", { name: "Hero-Bild vergrößert öffnen" }).click()
  const imageOverlay = page.locator('[data-component="question-media-overlay"]')
  await expect(imageOverlay.locator("img")).toBeVisible()
  await page.screenshot({ path: "test-results/question-body-image-overlay-900x700.png", fullPage: true })
  await page.keyboard.press("Escape")
  await expect(imageOverlay).toHaveCount(0)
  await items.filter({ hasText: "Gameplay-Video" }).getByRole("button", { name: "Gameplay-Video vergrößert öffnen" }).click()
  const videoOverlay = page.locator('[data-component="question-media-overlay"]')
  await expect(videoOverlay.locator("video")).toBeVisible()
  await page.screenshot({ path: "test-results/question-body-video-overlay-900x700.png", fullPage: true })
  await page.keyboard.press("Escape")
  await expect(videoOverlay).toHaveCount(0)
  await items.filter({ hasText: "Detail-Bild" }).getByRole("checkbox").uncheck()
  await items.filter({ hasText: "Quelldatei" }).getByRole("checkbox").check()
  await popup.locator('[data-slot="question-option"]').filter({ hasText: "Eintrag behalten" }).click()
  await popup.locator('[data-slot="question-free-input"]').fill("Detail-Bild entfernen; Quelldatei behalten.")
  await expect.poll(() => noHorizontalOverflow(page)).toBe(true)
  await page.screenshot({ path: "test-results/question-body-media-900x700.png", fullPage: true })
  await popup.locator('[data-slot="question-footer"]').getByRole("button", { name: "Submit" }).click()
  await expect.poll(() => replies.length).toBe(1)
  const reply = replies[0] as { body: { answers: string[][] } }
  expect(JSON.parse(reply.body.answers[0]![0]!)).toEqual({
    version: 1,
    type: "opencode.question.answer",
    selectedOptionIDs: ["keep-entry"],
    values: { "entry-media": { selectedItemIDs: ["hero", "clip", "voice", "source"] } },
    feedback: "Detail-Bild entfernen; Quelldatei behalten.",
  })
  expectNoSmokeErrors(errors, [], [])
})

test("keeps a persisted legacy form readable without duplicating the host expectation", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 })
  const request = {
    id: "que_legacy_read",
    sessionID: targetID,
    questions: [
      {
        type: "form",
        question: "# Persistiertes Legacy-Review\n\nDieser Prompt wurde vor `body` gespeichert.",
        header: "Legacy",
        form: {
          version: 1,
          id: "legacy-read",
          submitLabel: "Legacy bestätigen",
          fields: [
            { id: "old-default", type: "display", label: "Alter defaultValue-Inhalt", defaultValue: "**Bleibt sichtbar.**" },
            { id: "old-value", type: "display", label: "Alter value-Inhalt", value: "Auch dieser Inhalt bleibt lesbar." },
          ],
          layout: {
            type: "vstack",
            children: [
              { type: "text", text: "Erwartet: Diese alte manuelle Zeile nicht duplizieren." },
              { type: "field", field: "old-default" },
              { type: "field", field: "old-value" },
            ],
          },
        },
      },
    ],
  }
  const { popup, errors } = await setup(page, request)

  await expect(popup.getByRole("heading", { name: "Persistiertes Legacy-Review" })).toBeVisible()
  await expect(popup.getByText("Bleibt sichtbar.")).toBeVisible()
  await expect(popup.getByText("Auch dieser Inhalt bleibt lesbar.")).toBeVisible()
  await expect(popup.getByText(/^Erwartet:/)).toHaveCount(1)
  await expect(popup.getByText("Diese alte manuelle Zeile nicht duplizieren.")).toHaveCount(0)
  await expect.poll(() => noHorizontalOverflow(page)).toBe(true)
  await page.screenshot({ path: "test-results/question-body-legacy-900x700.png", fullPage: true })
  expectNoSmokeErrors(errors, [], [])
})
