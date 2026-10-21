import { expect, test, type Locator, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mkdirSync, readFileSync } from "node:fs"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectNoSmokeErrors, trackPageErrors } from "../utils/errors"
import { expectAppVisible } from "../utils/waits"

test.use({ video: "on", screenshot: "on" })

const directory = "C:/OpenCode/ComposerBeforeSubmit"
const projectID = "proj_composer_before_submit"
const sessionID = "ses_composer_before_submit"
const server = "http://127.0.0.1:4096"
const visualQaReference = "/visual-qa-testing"
const progressivePlanBuilderReference = "/progressive-plan-builder"
const multiAgentReviewReference = "/multi-agent-review"
const multiAgentProblemSolverReference = "/multi-agent-problem-solver"
const promptImproveOriginalPrompt =
  "ich haette gerne das du mir einrichtest ein plugin das ich in den settings an und auschalten kann das mir am ende von jedem agent turn einen commit mach (lokal nicht pushen) mit den aenderungen die gemacht wurden und einer passenden naricht dazu. Ich will dadurch dann auch die spezischen aenderungen im chat fenster wieder zurueckrollen koennen (wichtig ist es koennten mehrere agents auf dem selben abereitsbereich arbeiten also muesste das dann richtig gemacht werden selbst wenn aenderungen danach waeren. Und ich will einen skill der wenn ich meine arbeit als beendet ansehe im chat schmeissen kann und er aus allen aenderungen einen commit macht damit wir keinen commit spam haben oder gibt es einen besseren weg dafuer dann mach mir mal alternativ vorshclaegge das ich das selbe verhalten bekome wir in cursor oder codex wo ich immer auch meine aendeurngen wieder pro chat naricht zurueck rollen kann."
const promptImproveImprovedPrompt = [
  "Bitte richte ein OpenCode-Plugin ein, das ich in den Settings aktivieren und deaktivieren kann.",
  "Wenn es aktiv ist, soll es am Ende jedes Agent-Turns automatisch einen lokalen Git-Commit erstellen, ohne zu pushen. Die Commit-Nachricht soll die konkreten Aenderungen dieses Turns knapp und passend beschreiben.",
  "Wichtig: Mehrere Agents koennen gleichzeitig im selben Arbeitsbereich arbeiten. Das Rollback pro Chat-Nachricht muss deshalb auch dann korrekt bleiben, wenn nach dem jeweiligen Turn weitere Aenderungen durch andere Agents oder durch mich passiert sind.",
  "Ich moechte die Aenderungen einer bestimmten Chat-Nachricht im Chat-Fenster wieder zurueckrollen koennen, aehnlich wie in Cursor oder Codex.",
  "Zusaetzlich moechte ich einen Skill, den ich am Ende einer Arbeit im Chat ausloesen kann. Dieser Skill soll alle fertigen Aenderungen in einen einzigen lokalen Abschluss-Commit packen, damit kein Commit-Spam entsteht.",
  "Pruefe bitte auch, ob es fuer dieses Verhalten einen besseren technischen Ansatz gibt als Auto-Commits nach jedem Agent-Turn. Wenn ja, schlage konkrete Alternativen vor und erklaere kurz die Vor- und Nachteile.",
].join("\n\n")

test("composer toolbar before-submit hooks run when submitting with Enter from the editor", async ({ page }) => {
  const errors = trackPageErrors(page)
  const requests: Record<string, unknown>[] = []
  const failedResponses: string[] = []
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`)
  })

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "composer-before-submit",
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
        slug: "composer-before-submit",
        projectID,
        directory,
        title: "Composer before-submit regression",
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await mockComposerToolbarPlugins(page, ["visual-qa-app", "progressive-plan-builder-app"])
  await page.route(/\/api\/session\/[^/]+\/prompt(?:\?|$)/, (route) => {
    requests.push(JSON.parse(route.request().postData() ?? "{}"))
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ data: { sessionID, messageID: "msg_prompt", admittedSeq: 1 } }),
    })
  })
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({}))
    localStorage.setItem(
      "opencode.global.dat:plugin-toolbar-visibility",
      JSON.stringify({
        version: 1,
        global: {
          "multi-agent-problem-solver-app/multiAgentProblemSolver": true,
        },
        projects: {},
      }),
    )
  })

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)

  const composer = await openSessionComposer(page)
  const input = composer.locator('[data-component="prompt-input"]')
  const toggle = page.getByRole("button", { name: "Visual QA fuer die naechste Nachricht aktivieren" })
  await expectAppVisible(toggle)

  await toggle.click()
  await expect(toggle).toHaveAttribute("aria-pressed", "true")
  await input.click()
  await page.keyboard.type("Bitte fixen")
  if (process.env.VISUAL_QA_SCREENSHOT) {
    await page.screenshot({ path: process.env.VISUAL_QA_SCREENSHOT, fullPage: true })
  }
  await page.keyboard.press("Enter")

  await expect.poll(() => requests.length).toBe(1)
  expect(requests[0]?.prompt).toMatchObject({ text: `Bitte fixen\n\n${visualQaReference}` })

  await page.reload()
  const blockedComposer = await openSessionComposer(page)
  const blockedInput = blockedComposer.locator('[data-component="prompt-input"]')
  const plan = page.getByRole("button", { name: "Progressive Plan Builder fuer die naechste Nachricht aktivieren" })
  await expectAppVisible(plan)
  await blockedInput.fill("Bitte erst planen")
  await plan.click()
  await blockedInput.click()
  await page.keyboard.press("Enter")
  await expect.poll(() => requests.length).toBe(2)
  expect(requests[1]?.prompt).toMatchObject({ text: `Bitte erst planen\n\n${progressivePlanBuilderReference}` })
  await expect(plan).toHaveAttribute("aria-pressed", "false")
  await page.waitForTimeout(300)
  expect(failedResponses).toEqual([])
  expectNoSmokeErrors(errors, [], [])
})

test("multi-select runs prompt improve and browser undo restores the original draft", async ({ page }) => {
  const errors = trackPageErrors(page)
  const requests: Record<string, unknown>[] = []
  const aiRuns: Record<string, unknown>[] = []
  const failedResponses: string[] = []
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`)
  })

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "composer-before-submit",
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
    agents: [
      { name: "build", mode: "primary" },
      { name: "plan", mode: "primary" },
    ],
    sessions: [
      {
        id: sessionID,
        slug: "composer-before-submit",
        projectID,
        directory,
        title: "Composer before-submit regression",
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
    onAppHostAIRun: ({ body }) => {
      aiRuns.push(body as Record<string, unknown>)
      return {
        ok: true,
        text: ["```json", JSON.stringify({ prompt: promptImproveImprovedPrompt }), "```"].join("\n"),
        model: "openai/gpt-5.5",
        timing: { totalMs: 1, parseMs: 0, policyMs: 0, instanceMs: 0, generationMs: 1 },
      }
    },
  })
  await mockComposerToolbarPlugins(page, [
    "visual-qa-app",
    "progressive-plan-builder-app",
    "multi-agent-review-app",
    "multi-agent-problem-solver-app",
    "prompt-improve-app",
  ])
  await page.route(/\/api\/session\/[^/]+\/prompt(?:\?|$)/, (route) => {
    requests.push(JSON.parse(route.request().postData() ?? "{}"))
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ data: { sessionID, messageID: "msg_prompt", admittedSeq: 1 } }),
    })
  })
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({}))
    localStorage.setItem(
      "opencode.global.dat:plugin-toolbar-visibility",
      JSON.stringify({
        version: 1,
        global: {
          "multi-agent-problem-solver-app/multiAgentProblemSolver": true,
        },
        projects: {},
      }),
    )
  })

  const viewportName = process.env.VISUAL_QA_VIEWPORT === "mobile" ? "mobile" : "desktop"
  await page.setViewportSize(viewportName === "mobile" ? { width: 390, height: 844 } : { width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)

  const composer = await openSessionComposer(page)
  const input = composer.locator('[data-component="prompt-input"]')
  const improve = page.getByRole("button", { name: "Improve current prompt" })
  const visualQa = page.getByRole("button", { name: "Visual QA fuer die naechste Nachricht aktivieren" })
  const progressivePlanBuilder = page.getByRole("button", { name: "Progressive Plan Builder fuer die naechste Nachricht aktivieren" })
  const multiAgentReview = page.getByRole("button", { name: "Multi-Agent Review fuer die naechste Nachricht aktivieren" })
  const multiAgentProblemSolver = page.getByRole("button", { name: "Multi-Agent Problem Solver fuer die naechste Nachricht aktivieren" })
  await expectAppVisible(improve)
  await expectAppVisible(visualQa)
  await expectAppVisible(progressivePlanBuilder)
  await expectAppVisible(multiAgentReview)
  await expectAppVisible(multiAgentProblemSolver)
  const rightToolbarItems = await page
    .locator(
      '[data-component="plugin-toolbar-outlet"][data-plugin-toolbar-placement="composer"][data-plugin-toolbar-align="right"] > [data-plugin-toolbar-item]',
    )
    .evaluateAll((items) => items.map((item) => item.getAttribute("data-plugin-toolbar-item")))
  const improveIndex = rightToolbarItems.indexOf("prompt-improve-app/promptImprove")
  expect(improveIndex).toBeGreaterThanOrEqual(0)
  expect(rightToolbarItems[improveIndex + 1]).toBe("progressive-plan-builder-app/progressivePlanBuilder")
  await input.fill(promptImproveOriginalPrompt)
  await expect.poll(() => editorText(input)).toBe(promptImproveOriginalPrompt)
  await multiAgentReview.click()
  await expect(multiAgentReview).toHaveAttribute("aria-pressed", "true")

  await input.focus()
  await page.keyboard.down("Control")
  await page.keyboard.down("Shift")
  await page.keyboard.press("Space")
  await page.keyboard.press("Space")
  await page.keyboard.press("Space")
  await page.keyboard.press("Space")
  await page.keyboard.press("Space")
  await expect(improve).toHaveAttribute("data-composer-toolbar-cycle-active", "true")
  await expect(improve).toHaveAttribute("data-composer-toolbar-cycle-selected", "true")
  await expect(visualQa).toHaveAttribute("aria-pressed", "true")
  await expect(multiAgentReview).toHaveAttribute("aria-pressed", "true")
  await expect(multiAgentProblemSolver).toHaveAttribute("aria-pressed", "true")
  await maybeVisualScreenshot(page, `prompt-improve-${viewportName}-multi-selected`)
  await page.waitForTimeout(3200)
  await expect(improve).toHaveAttribute("data-composer-toolbar-cycle-active", "true")
  await expect(improve).toHaveAttribute("data-composer-toolbar-cycle-selected", "true")
  await expect(visualQa).toHaveAttribute("aria-pressed", "true")
  await expect(multiAgentReview).toHaveAttribute("aria-pressed", "true")
  await expect(multiAgentProblemSolver).toHaveAttribute("aria-pressed", "true")
  await maybeVisualScreenshot(page, `prompt-improve-${viewportName}-multi-selected-after-wait`)
  await page.keyboard.up("Shift")
  await page.keyboard.up("Control")

  await expect.poll(() => aiRuns.length).toBe(1)
  expect(aiRuns[0]?.prompt).toContain(promptImproveOriginalPrompt)
  expect(aiRuns[0]?.model).toBe("opencode/claude-opus-4-6")
  expect(aiRuns[0]).not.toHaveProperty("returnAfter")
  expect((aiRuns[0]?.generation as { maxTokens?: number } | undefined)?.maxTokens).toBeGreaterThanOrEqual(1024)
  await expect.poll(() => editorText(input)).toBe(promptImproveImprovedPrompt)
  await expect(improve).toBeEnabled()
  await expect(visualQa).toBeEnabled()
  await expect(progressivePlanBuilder).toBeEnabled()
  await expect(multiAgentReview).toBeEnabled()
  await expect(multiAgentProblemSolver).toBeEnabled()
  await expect(multiAgentReview).toHaveAttribute("aria-pressed", "true")
  await expect(visualQa).toHaveAttribute("aria-pressed", "true")
  await expect(multiAgentProblemSolver).toHaveAttribute("aria-pressed", "true")
  await maybeVisualScreenshot(page, `prompt-improve-${viewportName}-improved`)

  await input.click()
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Z" : "Control+Z")
  await expect.poll(() => editorText(input)).toBe(promptImproveOriginalPrompt)
  await maybeVisualScreenshot(page, `prompt-improve-${viewportName}-undo`)

  await progressivePlanBuilder.click()
  await expect(progressivePlanBuilder).toHaveAttribute("aria-pressed", "true")
  await maybeVisualScreenshot(page, `prompt-improve-${viewportName}-plan-selected`)
  await input.click()
  await page.keyboard.press("Enter")
  await expect.poll(() => requests.length).toBe(1)
  const submitted = ((requests[0]?.prompt as { text?: string } | undefined)?.text ?? "").split("\n\n")
  expect(submitted).toEqual(
    expect.arrayContaining([
      promptImproveOriginalPrompt,
      visualQaReference,
      progressivePlanBuilderReference,
      multiAgentReviewReference,
      multiAgentProblemSolverReference,
    ]),
  )
  expect(submitted).toHaveLength(5)
  expect(requests[0]?.agent).toBe("build")
  await expect(composer.getByRole("button", { name: "build", exact: true })).toBeVisible()
  await maybeVisualScreenshot(page, `prompt-improve-${viewportName}-plan-submitted`)
  await expect(progressivePlanBuilder).toHaveAttribute("aria-pressed", "false")
  await expect(visualQa).toHaveAttribute("aria-pressed", "false")
  await expect(multiAgentReview).toHaveAttribute("aria-pressed", "false")
  await expect(multiAgentProblemSolver).toHaveAttribute("aria-pressed", "false")
  expect(failedResponses).toEqual([])
  expectNoSmokeErrors(errors, [], [])
})

test("composer toolbar before-submit hooks run when submitting a new session draft", async ({ page }) => {
  const errors = trackPageErrors(page)
  const requests: Record<string, unknown>[] = []
  const sessions = [
    {
      id: sessionID,
      slug: "composer-before-submit",
      projectID,
      directory,
      title: "Composer before-submit regression",
      version: "dev",
      time: { created: 1700000000000, updated: 1700000000000 },
    },
  ]

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "composer-before-submit",
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
    sessions,
    pageMessages: () => ({ items: [] }),
    onSessionCreate: async (body) => {
      await new Promise((resolve) => setTimeout(resolve, 4500))
      const metadata = body && typeof body === "object" && "metadata" in body ? { metadata: body.metadata } : {}
      const next = {
        id: "ses_new_composer_before_submit",
        slug: "new-composer-before-submit",
        projectID,
        directory,
        title: "New composer before-submit",
        version: "dev",
        time: { created: 1700000000001, updated: 1700000000001 },
        ...metadata,
      }
      sessions.push(next)
      return next
    },
    onSessionPrompt: (input) => {
      requests.push(input.body as Record<string, unknown>)
      return {}
    },
  })
  await mockComposerToolbarPlugins(page, ["visual-qa-app"])
  await page.addInitScript(
    ({ directory, dirBase64, server }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] }, lastProject: { local: directory } }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "draft", draftID: "draft-new-session", server, dirBase64, directory }]),
      )
    },
    { directory, dirBase64: base64Encode(directory), server },
  )

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/new-session?draftId=draft-new-session`)

  const input = page.locator('[data-dock-area="middle"]').getByRole("textbox", { name: /Ask anything/ })
  await expectAppVisible(input)
  const toggle = page.getByRole("button", { name: "Visual QA fuer die naechste Nachricht aktivieren" })
  await expectAppVisible(toggle)

  await toggle.click()
  await expect(toggle).toHaveAttribute("aria-pressed", "true")
  await input.click()
  await page.keyboard.type("Bitte fixen")
  await page.keyboard.press("Enter")

  await expect.poll(() => requests.length).toBe(1)
  expect(requests[0]?.prompt).toMatchObject({ text: `Bitte fixen\n\n${visualQaReference}` })
  expectNoSmokeErrors(errors, [], [])
})

test("multi-agent review toolbar production plugin appends its skill reference", async ({ page }) => {
  const errors = trackPageErrors(page)
  const requests: Record<string, unknown>[] = []

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "composer-before-submit",
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
        slug: "composer-before-submit",
        projectID,
        directory,
        title: "Composer before-submit regression",
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await mockComposerToolbarPlugins(page, ["multi-agent-review-app"])
  await page.route(/\/api\/session\/[^/]+\/prompt(?:\?|$)/, (route) => {
    requests.push(JSON.parse(route.request().postData() ?? "{}"))
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ data: { sessionID, messageID: "msg_prompt", admittedSeq: 1 } }),
    })
  })
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({}))
  })

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)

  const composer = await openSessionComposer(page)
  const input = composer.locator('[data-component="prompt-input"]')
  const toggle = page.getByRole("button", { name: "Multi-Agent Review fuer die naechste Nachricht aktivieren" })
  await expectAppVisible(toggle)

  await toggle.click()
  await expect(toggle).toHaveAttribute("aria-pressed", "true")
  await input.click()
  await page.keyboard.type("Bitte reviewen")
  await page.keyboard.press("Enter")

  await expect.poll(() => requests.length).toBe(1)
  expect(requests[0]?.prompt).toMatchObject({ text: `Bitte reviewen\n\n${multiAgentReviewReference}` })
  expectNoSmokeErrors(errors, [], [])
})

test("multi-agent problem solver toolbar production plugin appends its skill reference", async ({ page }) => {
  const errors = trackPageErrors(page)
  const requests: Record<string, unknown>[] = []

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "composer-before-submit",
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
        slug: "composer-before-submit",
        projectID,
        directory,
        title: "Composer before-submit regression",
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await mockComposerToolbarPlugins(page, ["multi-agent-problem-solver-app"])
  await page.route(/\/api\/session\/[^/]+\/prompt(?:\?|$)/, (route) => {
    requests.push(JSON.parse(route.request().postData() ?? "{}"))
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ data: { sessionID, messageID: "msg_prompt", admittedSeq: 1 } }),
    })
  })
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({}))
    localStorage.setItem(
      "opencode.global.dat:plugin-toolbar-visibility",
      JSON.stringify({
        version: 1,
        global: { "multi-agent-problem-solver-app/multiAgentProblemSolver": true },
        projects: {},
      }),
    )
  })

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)

  const composer = await openSessionComposer(page)
  const input = composer.locator('[data-component="prompt-input"]')
  const toggle = page.getByRole("button", { name: "Multi-Agent Problem Solver fuer die naechste Nachricht aktivieren" })
  await expectAppVisible(toggle)

  await toggle.click()
  await expect(toggle).toHaveAttribute("aria-pressed", "true")
  await input.click()
  await page.keyboard.type("Bitte loesen")
  await page.keyboard.press("Enter")

  await expect.poll(() => requests.length).toBe(1)
  expect(requests[0]?.prompt).toMatchObject({ text: `Bitte loesen\n\n${multiAgentProblemSolverReference}` })
  expectNoSmokeErrors(errors, [], [])
})

async function openSessionComposer(page: Page) {
  const composer = page.locator('[data-component="session-composer"]')
  const sessionRow = page
    .locator('[data-component="home-session-row"]')
    .filter({ hasText: "Composer before-submit regression" })
    .first()
  await expectAppVisible(composer.or(sessionRow).first())
  if (!(await composer.isVisible())) {
    await expectAppVisible(sessionRow)
    await sessionRow.click()
  }
  await expectAppVisible(composer)
  return composer
}

async function mockComposerToolbarPlugins(page: Page, pluginIDs: string[]) {
  await page.route("**/app/plugins**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({
        plugins: pluginIDs.map((id) => ({
          id,
          spec: id,
          version: "1",
          module: `/app/plugin/${id}/1/index.js`,
          hash: id,
          ...(id === "prompt-improve-app"
            ? { capabilities: ["ui:toolbar", "ui:settings", "host:ai"] }
            : id === "speech-to-text-app"
              ? { capabilities: ["ui:toolbar", "ui:settings", "commands", "host:composer"] }
              : {}),
        })),
      }),
    }),
  )
  for (const id of pluginIDs) {
    await page.route(`**/app/plugin/${id}/1/index.js**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/javascript",
        headers: { "access-control-allow-origin": "*" },
        body: readFileSync(new URL(`../../../../.opencode/plugins/${id}/index.js`, import.meta.url), "utf8"),
      }),
    )
    await page.route(`**/app/plugin/${id}/1/assets/**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "image/svg+xml",
        headers: { "access-control-allow-origin": "*" },
        body: readFileSync(
          new URL(`../../../../.opencode/plugins/${id}/assets/${route.request().url().split("/").pop()}`, import.meta.url),
          "utf8",
        ),
      }),
    )
  }
}

async function editorText(input: Locator) {
  return input.evaluate((element) => {
    const read = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").replace(/\u200B/g, "")
      if (node.nodeType !== Node.ELEMENT_NODE) return ""
      const el = node as HTMLElement
      if (el.tagName === "BR") return "\n"
      const text = Array.from(el.childNodes).map(read).join("")
      if (!["DIV", "P"].includes(el.tagName)) return text
      const next = el.nextSibling ? "\n" : ""
      return `${text}${next}`
    }
    return Array.from(element.childNodes).map(read).join("")
  })
}

async function maybeVisualScreenshot(page: Page, name: string) {
  const dir = process.env.VISUAL_QA_SCREENSHOT_DIR
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true })
}
