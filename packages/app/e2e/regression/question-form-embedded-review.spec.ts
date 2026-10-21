import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { trackPageErrors, expectNoSmokeErrors } from "../utils/errors"
import { expectAppVisible } from "../utils/waits"

test.use({ screenshot: "on", video: "on" })

const directory = "C:/OpenCode/QuestionFormEmbeddedReview"
const projectID = "proj_question_form_embedded_review"
const sessionID = "ses_question_form_embedded_review"
const requestID = "que_question_form_embedded_review"

const embeddedReviewPrefix = "opencode.embeddedReview:v1:"
const roomPhoto =
  "data:image/svg+xml;base64," +
  "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMjAwIiBoZWlnaHQ9IjgwMCIgdmlld0JveD0iMCAwIDEyMDAgODAwIj48cmVjdCB3aWR0aD0iMTIwMCIgaGVpZ2h0PSI4MDAiIGZpbGw9IiNiMjdkNTMiLz48cmVjdCB4PSI5MCIgeT0iMTQwIiB3aWR0aD0iMTAyMCIgaGVpZ2h0PSI1MjAiIHJ4PSIzNiIgZmlsbD0iI2Y1ZTlkZiIvPjxjaXJjbGUgY3g9IjMwMCIgY3k9IjMxMCIgcj0iNzAiIGZpbGw9IiNmNmM0NTMiLz48cmVjdCB4PSI0MzAiIHk9IjI2MCIgd2lkdGg9IjUyMCIgaGVpZ2h0PSIyNjAiIHJ4PSIyNCIgZmlsbD0iIzU5NzQ4YyIvPjwvc3ZnPg=="

function embeddedReviewText() {
  return `${embeddedReviewPrefix}${JSON.stringify({
    variant: "object_tree",
    sections: [
      {
        id: "hecherhaus",
        title: "1. Hecherhaus, Schwaz - 120 EUR",
        content: "**Guenstigster brauchbarer Bergtreffer.** [Link](https://www.booking.com/hotel/at/hecherhaus.de.html)",
        meta: { preview: "Kurze Karten-Vorschau ohne lange Links." },
        children: [
            { id: "hecherhaus-price", title: "Preis & Bewertung", content: "120 EUR fuer 4 Personen.\n\n![Zimmerfoto](" + roomPhoto + ")" },
          { id: "hecherhaus-location", title: "Lage", content: "Schwaz/Jenbach im Inntal." },
          { id: "hecherhaus-family", title: "Familien-Tauglichkeit", content: "Buchbar fuer 4 Personen." },
          { id: "hecherhaus-link", title: "Link", content: "https://www.booking.com/hotel/at/hecherhaus.de.html" },
        ],
      },
      {
        id: "airbnb",
        title: "Airbnb unter 100 EUR - geprueft",
        content: "Unter 100 EUR nur Camping, Schlafsaal, geteiltes Zimmer oder Umweg.",
        children: [
          { id: "airbnb-good", title: "Brauchbare Treffer", content: "Nicht im passenden Bergkorridor." },
          { id: "airbnb-bad", title: "Unpassende Treffer", content: "Camping/Stellplatz oder KEINE KIDS." },
          { id: "airbnb-schwaz", title: "Direkte Schwaz-Airbnbs", content: "Teuer oder nicht verfuegbar." },
          { id: "airbnb-conclusion", title: "Fazit", content: "Hecherhaus bleibt guenstigster valider Treffer." },
        ],
      },
    ],
  })}`
}

function questionRequest() {
  return {
    id: requestID,
    sessionID,
    questions: [
      {
        type: "form",
        question: "Dropdown oben, echte Drilldown-Buttons darunter, Freitext unten.",
        header: "Berg-Stopp",
        form: {
          version: 1,
          id: "mountain-stopover-drilldown-selection.test",
          title: "Guenstigste Berg-Unterkuenfte 2.-3. Aug. 2026",
          description: "2 Erwachsene + 2 Kinder. Unter 100 EUR gab es keinen passenden Bergtreffer.",
          submitLabel: "Auswahl uebernehmen",
          fields: [
            {
              id: "choice",
              type: "select",
              label: "Finale Auswahl",
              required: true,
              defaultValue: "hecherhaus",
              options: [
                { id: "hecherhaus", label: "Hecherhaus, Schwaz - 120 EUR" },
                { id: "airbnb", label: "Airbnb unter 100 nur mit Kompromiss" },
              ],
            },
            {
              id: "feedback",
              type: "textarea",
              label: "Freitext / weitere Infos",
              rows: 4,
              placeholder: "Weitere Wuensche ...",
            },
          ],
          layout: {
            type: "vstack",
            gap: "14px",
            children: [
              {
                type: "text",
                id: "visible-expectation-details",
                text: "Erwartet: Finale Auswahl prüfen und Freitext ergänzen.",
                markdown: "Zusätzliche **Prüfhinweise** bleiben sichtbar.",
              },
              { type: "field", field: "choice" },
              { type: "text", id: "mountain-drilldown", title: "Drilldown-Details", text: embeddedReviewText() },
              { type: "field", field: "feedback" },
            ],
          },
        },
      },
    ],
  }
}

function session(id: string, title: string) {
  return {
    id,
    slug: id,
    parentID: undefined,
    projectID,
    directory,
    title,
    version: "dev",
    time: { created: 1700000000000, updated: 1700000000000 },
  }
}

function noHorizontalOverflow(selector: Element) {
  const elements = [selector, ...Array.from(selector.querySelectorAll("*"))] as HTMLElement[]
  return elements.every((element) => element.scrollWidth <= element.clientWidth + 2)
}

async function setup(page: import("@playwright/test").Page) {
  const request = questionRequest()
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "question-form-embedded-review",
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
    sessions: [session(sessionID, "Question form embedded review")],
    pageMessages: () => ({ items: [] }),
    questions: () => [request],
    events: () => [
      {
        directory,
        payload: {
          id: "evt_question_form_embedded_review_asked",
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

test("renders form dropdown plus embedded object-tree review", async ({ page }) => {
  const errors = trackPageErrors(page)
  await setup(page)

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await page.addStyleTag({
    content:
      '[aria-label="Development performance diagnostics"], [aria-label="Help"] { display: none !important; pointer-events: none !important; }',
  })

  const form = page.locator('[data-component="session-prompt-dock"] [data-slot="question-form"]')
  await expectAppVisible(form.getByText("Guenstigste Berg-Unterkuenfte"))
  await expect(page.getByText("Erwartet: Auswahl uebernehmen", { exact: true })).toHaveCount(1)
  await expectAppVisible(form.getByText("Zusätzliche Prüfhinweise bleiben sichtbar."))
  await expectAppVisible(form.locator('[data-slot="question-form-field"][data-field-type="select"]'))
  await expectAppVisible(form.locator('[data-slot="question-form-review"]').filter({ hasText: "Drilldown-Details" }))
  await expectAppVisible(form.locator('[data-slot="explorable-review"][data-variant="object_tree"]'))
  await expectAppVisible(form.getByRole("button", { name: /Hecherhaus/ }))
  await expectAppVisible(form.getByText("Kurze Karten-Vorschau ohne lange Links."))
  await expect(form.getByText("Guenstigster brauchbarer Bergtreffer.")).toHaveCount(0)
  await expectAppVisible(form.getByText("4 tiefer").first())
  await expectAppVisible(form.locator('[data-slot="question-form-field"][data-field-type="textarea"]'))
  await expect.poll(() => form.evaluate(noHorizontalOverflow)).toBe(true)

  await form.getByRole("button", { name: /Hecherhaus/ }).click()
  await expectAppVisible(form.getByText("Guenstigster brauchbarer Bergtreffer."))
  await expectAppVisible(form.getByRole("link", { name: "Link" }))
  await expectAppVisible(form.locator('[data-slot="explorable-leaf"]').filter({ hasText: "Preis & Bewertung" }))
  await expectAppVisible(form.getByText("Lage"))
  await expect(form.getByRole("button", { name: /Preis & Bewertung/ })).toHaveCount(0)
  const photo = form.locator('[data-slot="explorable-leaf"] img[alt="Zimmerfoto"]').first()
  await expectAppVisible(photo)
  await expect.poll(() => photo.evaluate((img) => img.getBoundingClientRect().width)).toBeLessThanOrEqual(320)
  await expect.poll(() => photo.evaluate((img) => img.getBoundingClientRect().height)).toBeLessThanOrEqual(190)
  await page.screenshot({ path: "test-results/question-form-embedded-review-desktop.png", fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  await expectAppVisible(form.locator('[data-slot="explorable-review"][data-variant="object_tree"]'))
  await expectAppVisible(form.locator('[data-slot="question-form-field"][data-field-type="select"]'))
  await expect.poll(() => form.evaluate(noHorizontalOverflow)).toBe(true)
  const footer = page.locator('[data-slot="question-footer"]')
  const submit = footer.getByRole("button", { name: "Auswahl uebernehmen", exact: true })
  await expectAppVisible(submit)
  await submit.click({ trial: true })
  await expect
    .poll(() =>
      footer.evaluate((element) => {
        const bounds = element.getBoundingClientRect()
        return bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight
      }),
    )
    .toBe(true)
  await page.screenshot({ path: "test-results/question-form-embedded-review-mobile.png", fullPage: true })

  expectNoSmokeErrors(errors, [], [])
})
