import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { trackPageErrors, expectNoSmokeErrors } from "../utils/errors"
import { expectAppVisible } from "../utils/waits"

test.use({ video: "on", screenshot: "on" })

const directory = "C:/OpenCode/ExplorablePlan"
const projectID = "proj_explorable_plan"
const sourceID = "ses_explorable_source"
const targetID = "ses_explorable_target"
const requestID = "que_explorable_target"
const serverURL = `http://127.0.0.1:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
const liveDevServer = () => (process.env.PLAYWRIGHT_BASE_URL ?? "").includes(":4444")

const planQuestionRequest = () => ({
  id: requestID,
  sessionID: targetID,
  questions: [
    {
      type: "object_tree",
      question: "Erkunde den finalen Plan und entscheide, wie es weitergeht.",
      header: "Plan-Review",
      context: "Diese Frage entscheidet, ob der erklaerte Plan direkt umgesetzt oder gestoppt wird.",
      content: "Diese Frage entscheidet, ob der erklaerte Plan direkt umgesetzt oder gestoppt wird.",
      sections: [
        {
          id: "overview",
          title: "Quick Overview",
          content: "Eine erkundbare Plan-Uebersicht mit Drill-Down und Back.",
          children: [
            {
              id: "overview-goal",
              title: "Zielbild",
              content: "Der Explorer zeigt zuerst Orientierung und fuehrt dann in konkrete, umsetzbare Planbereiche.",
            },
            {
              id: "overview-quality",
              title: "Qualitaetsbar",
              content:
                "Jeder wichtige Klickpfad endet in einem Leaf mit Datei, Aenderung, Risiko, Verifikation und Akzeptanzkriterium.",
            },
          ],
        },
        {
          id: "decisions",
          title: "Key Decisions",
          content: "Die wichtigsten Architekturentscheidungen.",
          children: [
            {
              id: "dec-renderer",
              title: "Shared-Capability Renderer",
              content: "ExplorableReview in packages/app, nutzbar fuer alle Plugins.",
            },
            {
              id: "dec-nav",
              title: "Hybrid-Navigation",
              content: "Aufklappen vor Ort plus Drill-Down mit Breadcrumb und Back.",
            },
            {
              id: "dec-duplicate-wrapper",
              title: "Key Decisions",
              content: "Die wichtigsten Architekturentscheidungen.",
              children: [
                {
                  id: "dec-duplicate-leaf",
                  title: "Key Decisions",
                  content: "Die wichtigsten Architekturentscheidungen.",
                },
              ],
            },
            {
              id: "dec-partial-duplicate-leaf",
              title: "Key Decisions",
              content: "",
            },
          ],
        },
        {
          id: "impl",
          title: "Implementation Details",
          content: "Konkrete Datei-Aenderungen mit mehreren Drill-Down-Ebenen.",
          children: [
            {
              id: "impl-skill",
              title: "progressive-plan-builder SKILL.md",
              content: "Der Skill bekommt einen harten Deep-Explorer-Contract fuer Review-Plaene.",
              children: [
                {
                  id: "impl-skill-contract",
                  title: "Deep Explorer Contract",
                  content:
                    "Root bleibt skimmable; Kinder muessen konkrete Entscheidungen, Datei-Ziele und Tests tragen.",
                  children: [
                    {
                      id: "impl-skill-leaf-check",
                      title: "Leaf-Check",
                      content:
                        "Vor dem Senden prueft der Agent jeden wichtigen Klickpfad: kein Leaf darf nur Titel oder generische Platzhalter enthalten.",
                    },
                    {
                      id: "impl-skill-visual-qa-check",
                      title: "Visual-QA-Check",
                      content:
                        "Tests & Visual QA muss Surface, Erfolgskriterium, Viewports, Console/Network und Evidence als eigene Detailpunkte nennen.",
                    },
                  ],
                },
              ],
            },
            {
              id: "impl-e2e",
              title: "explorable-plan-review.spec.ts",
              content: "Der Regressionstest nutzt eine realistische tiefe Planstruktur statt nur flacher Beispiele.",
              children: [
                {
                  id: "impl-e2e-fixture",
                  title: "Tiefe Fixture",
                  content:
                    "Die Mock-Frage enthaelt Root-, Modul-, Contract- und Leaf-Knoten, damit der Explorer echte Tiefe rendern muss.",
                  children: [
                    {
                      id: "impl-e2e-assertions",
                      title: "Mehrstufige Assertions",
                      content:
                        "Der Test klickt Root -> Implementation Details -> E2E-Datei -> Tiefe Fixture und erwartet verwertbaren Leaf-Text sowie Breadcrumb/Back.",
                    },
                  ],
                },
              ],
            },
            {
              id: "impl-review",
              title: "Multi-Agent Review",
              content: "Read-only Reviewer pruefen nach dem Patch Korrektheit, Simplification und Testluecken.",
            },
          ],
        },
        {
          id: "tests",
          title: "Tests & Visual QA",
          content: "Contract-Test plus E2E plus Visual QA.",
          children: [
            {
              id: "tests-e2e",
              title: "E2E",
              content: "Controlled Playwright prueft Root, zweite Ebene, tiefe Leaf-Seite, Breadcrumb und Back.",
            },
            {
              id: "tests-visual-qa",
              title: "Visual QA",
              content:
                "Desktop 1280x720 und Mobile 390x844 pruefen Explorer-Lesbarkeit, Console Errors und Network Failures.",
            },
          ],
        },
        {
          id: "assumptions",
          title: "Assumptions",
          content:
            "Der Renderer kann rekursiv navigieren; die Hauptkorrektur liegt im Plan-Output-Contract und seiner Regressionstest-Abdeckung.",
        },
      ],
      options: [
        {
          label: "Implementieren",
          description: "Startet die Umsetzung direkt.",
          details: {
            Changes: "Der Skill wuerde venv/requirements, PyTorch/CUDA-Varianten und Modell-Download behandeln.",
            Risk: "PyTorch/BasicSR/Model-Weights vergroessern die Angriffsflaeche und koennen mit Python 3.13 schwierig werden.",
            Security: "Mehr Pakete, mehr native Wheels, mehr Version-Pinning noetig.",
          },
        },
        {
          label: "Abbrechen",
          description: "Keine Aenderungen.",
          details: ["Keine Aenderungen.", "Keine Aenderungen."],
        },
        {
          label: "Spaeter",
          description: "Noch nicht entscheiden.",
          details: ["Spaeter Noch nicht entscheiden."],
        },
        {
          label: "Info",
          description: "Schon sichtbar.",
          details: {
            Summary: "Info Schon sichtbar.",
          },
        },
      ],
      allowFeedback: true,
    },
  ],
})

const accordionPlanQuestionRequest = () => ({
  ...planQuestionRequest(),
  id: `${requestID}_accordion`,
  questions: [
    {
      type: "accordion",
      question: "Pruefe den Plan und entscheide, wie es weitergeht.",
      header: "Plan-Review",
      markdown:
        "## Quick Overview\n\n- **Ziel:** Die sichtbare Weggabelung kommt zurueck.\n- **Absicherung:** Tests und Visual QA.",
      sections: [
        {
          id: "changes",
          title: "Konkrete Aenderungen",
          content: "",
          children: [
            {
              id: "config",
              title: "FteTutorialRun.json",
              content: `Healing-Step wieder als \`HealingFork\` modellieren.\n\n${"Konkreter Planinhalt fuer den Scrolltest.\n\n".repeat(24)}`,
            },
          ],
        },
      ],
      options: [
        { id: "implement", label: "Implementieren", description: "Plan umsetzen." },
      ],
      allowFeedback: true,
    },
  ],
})

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

async function setupPlanReview(
  page: import("@playwright/test").Page,
  request: ReturnType<typeof planQuestionRequest> | ReturnType<typeof accordionPlanQuestionRequest> = planQuestionRequest(),
) {
  const errors = trackPageErrors(page)
  const networkErrors: string[] = []
  page.on("response", (response) => {
    if (response.status() >= 400) networkErrors.push(`${response.status()} ${response.url()}`)
  })
  page.on("requestfailed", (request) =>
    networkErrors.push(`${request.failure()?.errorText ?? "failed"} ${request.url()}`),
  )
  let eventSent = false
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "explorable-plan",
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
    sessions: [session(sourceID, "Plan source"), session(targetID, "Plan target")],
    pageMessages: () => ({ items: [] }),
    questions: () => [request],
    eventRetry: 60_000,
    events: () => {
      if (eventSent) return []
      eventSent = true
      return [
        {
          directory,
          payload: {
            id: "evt_plan_asked",
            type: "surface.asked",
            properties: request,
          },
        },
      ]
    },
  })

  await page.addInitScript(
    ({ directory, dirBase64, sourceID, serverURL }) => {
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
        JSON.stringify([{ type: "session", server: serverURL, dirBase64, sessionId: sourceID }]),
      )
    },
    { directory, dirBase64: base64Encode(directory), sourceID, serverURL },
  )
  return { errors, networkErrors }
}

test("renders persistent markdown before native plan accordions", async ({ page }) => {
  let replyBody: { answers?: string[][] } | undefined
  page.on("request", (request) => {
    if (!new URL(request.url()).pathname.endsWith(`/api/session/${targetID}/surface/${requestID}_accordion/reply`)) return
    replyBody = request.postDataJSON() as { answers?: string[][] }
  })
  const { errors, networkErrors } = await setupPlanReview(page, accordionPlanQuestionRequest())
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sourceID}`)

  const popup = page.locator('[data-component="question-popup"]')
  await expectAppVisible(popup)
  const review = popup.locator('[data-slot="explorable-review"][data-variant="accordion"]')
  await expect(popup.locator('[data-slot="question-review"]')).toHaveAttribute("data-final-plan", "true")
  const intro = review.locator('[data-slot="explorable-review-intro"]')
  await expectAppVisible(intro.filter({ hasText: "Quick Overview" }).filter({ hasText: "sichtbare Weggabelung" }))

  const changes = review.locator('[data-slot="explorable-accordion"]').filter({ hasText: "Konkrete Aenderungen" })
  await expectAppVisible(changes)
  await expect(changes).toHaveAttribute("data-open", "false")
  const changesHeader = changes.locator(':scope > [data-slot="explorable-accordion-header"]')
  await expect(changesHeader).toHaveAttribute("aria-expanded", "false")
  await changesHeader.click()
  await expect(changes).toHaveAttribute("data-open", "true")
  await expect(changesHeader).toHaveAttribute("aria-expanded", "true")
  await expectAppVisible(
    changes.locator('[data-slot="explorable-accordion"]').filter({ hasText: "FteTutorialRun.json" }),
  )
  await changes
    .locator('[data-slot="explorable-accordion"]').filter({ hasText: "FteTutorialRun.json" })
    .locator('[data-slot="explorable-accordion-header"]')
    .click()
  await expectAppVisible(intro)
  await page.screenshot({ path: "test-results/plan-accordion-intro-desktop.png", fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  await expectAppVisible(intro)
  await expectAppVisible(changes)
  await expect(review.locator('[data-slot="explorable-count"]')).toHaveCount(0)
  const questionText = popup.locator('[data-slot="question-text"]')
  const actions = popup.locator('[data-slot="question-options"]')
  const beforeScroll = {
    question: await questionText.boundingBox(),
    actions: await actions.boundingBox(),
  }
  await popup.locator('[data-slot="question-review"]').evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  const afterScroll = {
    question: await questionText.boundingBox(),
    actions: await actions.boundingBox(),
    review: await popup.locator('[data-slot="question-review"]').boundingBox(),
  }
  expect(afterScroll.question?.y).toBe(beforeScroll.question?.y)
  expect(afterScroll.actions?.y).toBe(beforeScroll.actions?.y)
  expect(afterScroll.question!.y + afterScroll.question!.height).toBeLessThanOrEqual(afterScroll.review!.y)
  await expectAppVisible(questionText)
  await expectAppVisible(actions)
  const introBox = await intro.boundingBox()
  const popupBox = await popup.boundingBox()
  expect(introBox).not.toBeNull()
  expect(popupBox).not.toBeNull()
  expect(introBox!.x).toBeGreaterThanOrEqual(popupBox!.x)
  expect(introBox!.x + introBox!.width).toBeLessThanOrEqual(popupBox!.x + popupBox!.width)
  await expect(popup.locator('[data-slot="question-option-wrap"]')).toHaveCount(0)
  await expectAppVisible(popup.locator('[data-slot="question-free-input"]'))
  const implement = popup.locator('[data-slot="question-footer-actions"] button').filter({ hasText: "Implementieren" })
  await expectAppVisible(implement)
  await page.screenshot({ path: "test-results/plan-accordion-intro-mobile.png", fullPage: true })

  await popup.locator('[data-slot="question-free-input"]').fill("Bitte Tests ergaenzen")
  await implement.click()
  await expect.poll(() => replyBody?.answers).toEqual([["Implementieren", "feedback: Bitte Tests ergaenzen"]])

  expectNoSmokeErrors(errors, [], [])
  expect(networkErrors).toEqual([])
})

test("dismisses a promoted final plan action without replying", async ({ page }) => {
  let rejected = false
  let replied = false
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname
    if (path.endsWith(`/api/session/${targetID}/surface/${requestID}_accordion/dismiss`)) rejected = true
    if (path.endsWith(`/api/session/${targetID}/surface/${requestID}_accordion/reply`)) replied = true
  })
  await setupPlanReview(page, accordionPlanQuestionRequest())
  await page.goto(`/${base64Encode(directory)}/session/${sourceID}`)

  const popup = page.locator('[data-component="question-popup"]')
  await expectAppVisible(popup)
  await popup.getByRole("button", { name: "Dismiss" }).click()
  await expect.poll(() => rejected).toBe(true)
  expect(replied).toBe(false)
})

test("submits a promoted final plan action without optional feedback", async ({ page }) => {
  let replyBody: { answers?: string[][] } | undefined
  page.on("request", (request) => {
    if (!new URL(request.url()).pathname.endsWith(`/api/session/${targetID}/surface/${requestID}_accordion/reply`)) return
    replyBody = request.postDataJSON() as { answers?: string[][] }
  })
  await setupPlanReview(page, accordionPlanQuestionRequest())
  await page.goto(`/${base64Encode(directory)}/session/${sourceID}`)

  const popup = page.locator('[data-component="question-popup"]')
  await expectAppVisible(popup)
  await popup.getByRole("button", { name: "Implementieren" }).click()
  await expect.poll(() => replyBody?.answers).toEqual([["Implementieren"]])
})

test("renders the explorable object_tree plan with drill-down and back navigation", async ({ page }) => {
  const { errors, networkErrors } = await setupPlanReview(page)
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sourceID}`)

  const popup = page.locator('[data-component="question-popup"]')
  await expectAppVisible(popup)
  const review = popup.locator('[data-slot="explorable-review"]')
  await expectAppVisible(review)
  await expect(review).toHaveAttribute("data-variant", "object_tree")

  // Root level shows one clickable node per top-level section.
  const nodes = review.locator('[data-slot="explorable-node"]')
  await expect(nodes).toHaveCount(4)
  await expect(nodes.filter({ hasText: "2 tiefer" })).toHaveCount(3)
  await expectAppVisible(
    review.locator('[data-slot="explorable-leaf"]').filter({ hasText: "Assumptions" }).filter({ hasText: "Der Renderer" }),
  )
  await expect(nodes.filter({ hasText: "Assumptions" })).toHaveCount(0)
  await expect(review.locator('[data-slot="explorable-node-hint"]').filter({ hasText: "Details" })).toHaveCount(0)
  await expectAppVisible(
    review.locator('[data-slot="explorable-node"]').filter({ hasText: "Eine erkundbare Plan-Uebersicht" }),
  )
  await expect(review.locator('[data-slot="explorable-breadcrumb"]')).toHaveCount(0)
  const actions = popup.locator('[data-slot="question-options"][data-compact-actions="true"]')
  await expectAppVisible(actions)
  await expect(actions.locator('[data-slot="question-option"]')).toHaveCount(4)
  await expectAppVisible(actions.locator('[data-slot="question-option"]').filter({ hasText: "Implementieren" }))
  await expect(
    actions.locator('[data-slot="question-option"]').filter({ hasText: "Startet die Umsetzung direkt." }),
  ).toHaveCount(0)
  await popup.getByRole("button", { name: "Surface menu" }).click()
  await page.getByRole("menuitem", { name: "Mehr Details" }).click()
  const questionDetailPanel = popup.locator('[data-slot="question-detail-panel"][data-level="question"][data-mode="drilldown"]')
  await expectAppVisible(questionDetailPanel.filter({ hasText: "direkt umgesetzt" }))
  await expect.poll(async () => (await questionDetailPanel.boundingBox())?.height ?? 0).toBeGreaterThan(90)
  await page.screenshot({ path: "test-results/explorable-question-detail-desktop.png", fullPage: true })
  await popup.locator('[data-slot="question-detail-back"]').click()
  const implementOption = actions.locator('[data-slot="question-option"]').filter({ hasText: "Implementieren" })
  const implementDetails = actions
    .locator('[data-slot="question-option-wrap"]')
    .filter({ hasText: "Implementieren" })
    .locator('[data-slot="question-detail-toggle"][data-level="option"]')
  await expectAppVisible(implementDetails)
  await implementDetails.click()
  await expectAppVisible(
    popup.locator('[data-slot="question-detail-panel"][data-level="option"][data-mode="drilldown"]'),
  )
  await expect(popup.locator('[data-slot="question-detail-panel"] [data-slot="explorable-node"]')).toHaveCount(0)
  const optionDetail = popup
    .locator('[data-slot="question-detail-panel"] [data-slot="explorable-leaf"]')
    .filter({ hasText: "Security" })
    .filter({ hasText: "Mehr Pakete" })
  await expectAppVisible(optionDetail)
  await expect(optionDetail).toHaveCSS("opacity", "1")
  await page.screenshot({ path: "test-results/explorable-option-detail-desktop.png", fullPage: true })
  await popup.locator('[data-slot="question-detail-back"]').click()
  await expect(implementOption).toHaveAttribute("data-picked", "false")
  await expect(
    actions
      .locator('[data-slot="question-option-wrap"]')
      .filter({ hasText: "Abbrechen" })
      .locator('[data-slot="question-detail-toggle"][data-level="option"]'),
  ).toHaveCount(0)
  await expect(
    actions
      .locator('[data-slot="question-option-wrap"]')
      .filter({ hasText: "Spaeter" })
      .locator('[data-slot="question-detail-toggle"][data-level="option"]'),
  ).toHaveCount(0)
  await expect(
    actions
      .locator('[data-slot="question-option-wrap"]')
      .filter({ hasText: "Info" })
      .locator('[data-slot="question-detail-toggle"][data-level="option"]'),
  ).toHaveCount(0)
  await expectAppVisible(actions.locator('[data-slot="question-free-input"]'))
  const cancelOption = actions.locator('[data-slot="question-option"]').filter({ hasText: "Abbrechen" })
  await expectAppVisible(cancelOption)
  await cancelOption.click()
  const cancelMark = cancelOption.locator('[data-slot="question-option-box"]')
  await expect(cancelMark).toHaveAttribute("data-tone", "danger")
  const criticalColor = await page.locator("html").evaluate((html) => {
    const probe = document.createElement("span")
    probe.style.color = getComputedStyle(html).getPropertyValue("--icon-critical-base")
    document.body.append(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    return color
  })
  await expect(cancelMark).toHaveCSS("background-color", criticalColor)
  await expect(popup.locator('[data-slot="question-progress-segment"]')).toHaveAttribute("data-rejected", "true")

  await popup.getByRole("button", { name: "Surface menu" }).click()
  await page.getByRole("menuitem", { name: "Im Vollbild öffnen" }).click()
  await expect(popup.locator('[data-component="dock-prompt"][data-fullscreen="true"]')).toHaveCount(1)
  await popup.getByRole("button", { name: "Surface menu" }).click()
  await page.getByRole("menuitem", { name: "Vollbild verlassen" }).click()
  await expect(popup.locator('[data-component="dock-prompt"][data-fullscreen="true"]')).toHaveCount(0)

  if (liveDevServer()) {
    // The always-running dev server can replay question events while dock state is active.
    // Keep the live-server desktop QA focused on render/actions; the default controlled
    // runner below still verifies drill-down + back navigation on desktop.
    await page.screenshot({ path: "test-results/explorable-plan-root-desktop.png", fullPage: true })
    expectNoSmokeErrors(errors, [], [])
    expect(networkErrors).toEqual([])
    return
  }

  // Drill into "Key Decisions".
  await review.locator('[data-slot="explorable-node"]').filter({ hasText: "Key Decisions" }).click()
  await expectAppVisible(review.locator('[data-slot="explorable-detail"]'))
  await expectAppVisible(review.locator('[data-slot="explorable-breadcrumb"]'))
  await expectAppVisible(review.locator('[data-slot="explorable-back"]'))
  await expect(review.locator('[data-slot="explorable-crumb"]').last()).toHaveText("Key Decisions")
  // Two child nodes now visible inside the detail view.
  await expect(review.locator('[data-slot="explorable-subnodes"] [data-slot="explorable-node"]')).toHaveCount(0)
  await expect(review.locator('[data-slot="explorable-subnodes"] [data-slot="explorable-leaf"]')).toHaveCount(2)
  await expectAppVisible(
    review.locator('[data-slot="explorable-subnodes"] [data-slot="explorable-leaf"]').filter({ hasText: "Hybrid-Navigation" }),
  )

  await page.screenshot({ path: "test-results/explorable-plan-drilldown-desktop.png", fullPage: true })

  // Back returns to the root node list.
  await review.locator('[data-slot="explorable-back"]').click()
  await expect(review.locator('[data-slot="explorable-detail"]')).toHaveCount(0)
  await expect(review.locator('[data-slot="explorable-node"]')).toHaveCount(4)
  await expectAppVisible(review.locator('[data-slot="explorable-node"]').filter({ hasText: "3 tiefer" }))

  // Drill down multiple levels so shallow plan trees cannot satisfy the regression.
  await review.locator('[data-slot="explorable-node"]').filter({ hasText: "Implementation Details" }).click()
  await expectAppVisible(
    review
      .locator('[data-slot="explorable-subnodes"] [data-slot="explorable-node"]')
      .filter({ hasText: "explorable-plan-review.spec.ts" }),
  )
  await review
    .locator('[data-slot="explorable-subnodes"] [data-slot="explorable-node"]')
    .filter({ hasText: "explorable-plan-review.spec.ts" })
    .click()
  await expect(review.locator('[data-slot="explorable-crumb"]').last()).toHaveText("explorable-plan-review.spec.ts")
  await expectAppVisible(
    review
      .locator('[data-slot="explorable-subnodes"] [data-slot="explorable-node"]')
      .filter({ hasText: "Tiefe Fixture" }),
  )
  await review
    .locator('[data-slot="explorable-subnodes"] [data-slot="explorable-node"]')
    .filter({ hasText: "Tiefe Fixture" })
    .click()
  await expect(review.locator('[data-slot="explorable-crumb"]').last()).toHaveText("Tiefe Fixture")
  await expectAppVisible(
    review
      .locator('[data-slot="explorable-subnodes"] [data-slot="explorable-leaf"]')
      .filter({ hasText: "Mehrstufige Assertions" })
      .filter({ hasText: "Root -> Implementation Details -> E2E-Datei" }),
  )
  await review.locator('[data-slot="explorable-back"]').click()
  await expect(review.locator('[data-slot="explorable-crumb"]').last()).toHaveText("explorable-plan-review.spec.ts")
  await page.screenshot({ path: "test-results/explorable-plan-deep-desktop.png", fullPage: true })
  await review.locator('[data-slot="explorable-crumb"][data-root="true"]').click()
  await expect(review.locator('[data-slot="explorable-detail"]')).toHaveCount(0)
  await expect(review.locator('[data-slot="explorable-node"]')).toHaveCount(4)
  await expectAppVisible(
    review.locator('[data-slot="explorable-leaf"]').filter({ hasText: "Assumptions" }).filter({ hasText: "Der Renderer" }),
  )

  await page.screenshot({ path: "test-results/explorable-plan-root-desktop.png", fullPage: true })
  expectNoSmokeErrors(errors, [], [])
  expect(networkErrors).toEqual([])
})

test("renders the explorable plan at a mobile viewport", async ({ page }) => {
  const { errors, networkErrors } = await setupPlanReview(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/${base64Encode(directory)}/session/${sourceID}`)

  const popup = page.locator('[data-component="question-popup"]')
  await expectAppVisible(popup)
  const review = popup.locator('[data-slot="explorable-review"]')
  await expectAppVisible(review)
  await expect(review.locator('[data-slot="explorable-node"]')).toHaveCount(4)
  await expectAppVisible(review.locator('[data-slot="explorable-leaf"]').filter({ hasText: "Assumptions" }))
  await expectAppVisible(review.locator('[data-slot="explorable-node"]').filter({ hasText: "3 tiefer" }))
  await expectAppVisible(review.locator('[data-slot="explorable-node-preview"]').first())
  await expectAppVisible(popup.locator('[data-slot="question-options"][data-compact-actions="true"]'))
  await popup.getByRole("button", { name: "Surface menu" }).click()
  await page.getByRole("menuitem", { name: "Mehr Details" }).click()
  await expectAppVisible(
    popup.locator('[data-slot="question-detail-panel"][data-level="question"][data-mode="drilldown"]'),
  )
  await page.screenshot({ path: "test-results/explorable-question-detail-mobile.png", fullPage: true })
  await popup.locator('[data-slot="question-detail-back"]').click()

  // Mobile covers the same deep tree shape, but stops before the final leaf to keep the run compact.
  await review.locator('[data-slot="explorable-node"]').filter({ hasText: "Implementation Details" }).click()
  await expectAppVisible(review.locator('[data-slot="explorable-detail"]'))
  await expect(review.locator('[data-slot="explorable-crumb"]')).toHaveCount(2)
  await expect(review.locator('[data-slot="explorable-subnodes"] [data-slot="explorable-node"]')).toHaveCount(2)
  await expectAppVisible(review.locator('[data-slot="explorable-subnodes"] [data-slot="explorable-leaf"]').filter({ hasText: "Multi-Agent Review" }))
  await expectAppVisible(
    review
      .locator('[data-slot="explorable-subnodes"] [data-slot="explorable-node"]')
      .filter({ hasText: "progressive-plan-builder SKILL.md" }),
  )
  await review
    .locator('[data-slot="explorable-subnodes"] [data-slot="explorable-node"]')
    .filter({ hasText: "explorable-plan-review.spec.ts" })
    .click()
  await expect(review.locator('[data-slot="explorable-crumb"]').last()).toHaveText("explorable-plan-review.spec.ts")
  await expectAppVisible(
    review
      .locator('[data-slot="explorable-subnodes"] [data-slot="explorable-node"]')
      .filter({ hasText: "Tiefe Fixture" }),
  )
  await review.locator('[data-slot="explorable-back"]').click()
  await expect(review.locator('[data-slot="explorable-crumb"]').last()).toHaveText("Implementation Details")

  await page.screenshot({ path: "test-results/explorable-plan-mobile.png", fullPage: true })
  expectNoSmokeErrors(errors, [], [])
  expect(networkErrors).toEqual([])
})
