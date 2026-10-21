import { expect, test, type Locator, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mkdirSync, readFileSync } from "node:fs"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectNoSmokeErrors, trackPageErrors } from "../utils/errors"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/GoalToolbar"
const projectID = "proj_goal_toolbar"
const sessionID = "ses_goal_toolbar"
const server = "http://127.0.0.1:4096"

test.use({ video: "on", screenshot: "on" })

for (const viewport of ["desktop", "mobile"] as const) {
  test(`Goal toolbar prepares an editable slash command on ${viewport}`, async ({ page }) => {
    const errors = trackPageErrors(page)
    const requests: Record<string, unknown>[] = []
    const commandRequests: Record<string, unknown>[] = []
    const sessionUpdates: Record<string, unknown>[] = []
    const session = {
      id: sessionID,
      slug: "goal-toolbar",
      projectID,
      directory,
      title: "Goal toolbar regression",
      version: "dev",
      time: { created: 1700000000000, updated: 1700000000000 },
      metadata: {} as Record<string, unknown>,
    }
    const failedResponses: string[] = []
    let busy = false
    page.on("response", (response) => {
      if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`)
    })

    await mockOpenCodeServer(page, {
      directory,
      project: {
        id: projectID,
        worktree: directory,
        vcs: "git",
        name: "goal-toolbar",
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
      agents: [{
        name: "build",
        mode: "primary",
        model: { providerID: "opencode", modelID: "claude-opus-4-6" },
      }],
      commands: [{ name: "goal", template: "$ARGUMENTS", description: "Set a session goal" }],
      sessions: [session],
      sessionStatus: () => ({ [sessionID]: { type: busy ? "busy" : "idle" } }),
      pageMessages: () => ({ items: busy ? [
        {
          info: { id: "msg_goal_user", sessionID, role: "user", time: { created: 1700000000000 },
            agent: "build", model: { providerID: "opencode", modelID: "claude-opus-4-6" } },
          parts: [],
        },
        {
          info: { id: "msg_goal_assistant", sessionID, role: "assistant", parentID: "msg_goal_user",
            time: { created: 1700000001000 }, agent: "build", providerID: "opencode", modelID: "claude-opus-4-6" },
          parts: [],
        },
      ] : [] }),
      onSessionPrompt: async (input) => {
        requests.push(input.body as Record<string, unknown>)
        return { data: { sessionID, messageID: "unexpected", admittedSeq: 1 } }
      },
      onSessionCommand: async (input) => {
        commandRequests.push(input.body as Record<string, unknown>)
        return { data: { sessionID, messageID: "goal-command", admittedSeq: 1 } }
      },
      onSessionUpdate: async (input) => {
        const body = input.body as Record<string, unknown>
        sessionUpdates.push(body)
        if (input.sessionID !== sessionID) return {}
        const patch = body.metadataPatch as { set?: Record<string, unknown>; unset?: string[] } | undefined
        if (patch) {
          session.metadata = { ...session.metadata, ...(patch.set ?? {}) }
          for (const key of patch.unset ?? []) delete session.metadata[key]
        } else if (body.metadata !== undefined) {
          session.metadata = body.metadata as Record<string, unknown>
        }
        return session
      },
    })
    await page.route("**/api/session/*/held-inputs*", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [] }) }),
    )
    await mockGoalPlugin(page)
    await page.addInitScript(
      ({ directory, dirBase64, server, sessionID }) => {
        localStorage.setItem("settings.v3", JSON.stringify({}))
        localStorage.setItem(
          "opencode.global.dat:server",
          JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] }, lastProject: { local: directory } }),
        )
        localStorage.setItem(
          "opencode.global.dat:tabs",
          JSON.stringify([{ type: "session", server, dirBase64, sessionId: sessionID, createdEmpty: true }]),
        )
      },
      { directory, dirBase64: base64Encode(directory), server, sessionID },
    )
    await page.setViewportSize(viewport === "mobile" ? { width: 390, height: 844 } : { width: 1280, height: 720 })
    await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)

    const composer = page.locator('[data-component="session-composer"]')
    const sessionRow = page.locator('[data-component="home-session-row"]').filter({ hasText: "Goal toolbar regression" }).first()
    await expectAppVisible(composer.or(sessionRow).first())
    if (!(await composer.isVisible())) await sessionRow.click()
    await expectAppVisible(composer)

    const input = composer.locator('[data-component="prompt-input"]')
    const goal = composer.locator('[data-action="session-goal"]')
    await expectAppVisible(goal)
    await expect(goal).toHaveAttribute("aria-label", "Set the current draft as a session goal")
    await expect(goal).toHaveCSS("width", "28px")
    await expect(goal).toHaveCSS("height", "28px")
    await expect(goal).toBeEnabled()

    const submit = composer.locator('[data-action="prompt-submit"]')
    await expectAppVisible(submit)
    const goalBox = await goal.boundingBox()
    const submitBox = await submit.boundingBox()
    expect(goalBox).not.toBeNull()
    expect(submitBox).not.toBeNull()
    if (!goalBox || !submitBox) throw new Error("Goal or submit toolbar button has no layout box")
    expect(goalBox.x + goalBox.width).toBeLessThanOrEqual(submitBox.x + 1)
    expect(Math.abs(goalBox.y + goalBox.height / 2 - (submitBox.y + submitBox.height / 2))).toBeLessThanOrEqual(6)

    await input.fill("Ship the verified fix")
    await goal.click()
    await expect.poll(() => editorText(input)).toBe("/goal Ship the verified fix")
    await goal.click()
    await expect.poll(() => editorText(input)).toBe("/goal Ship the verified fix")
    expect(requests).toEqual([])
    await maybeVisualScreenshot(page, `goal-toolbar-${viewport}`)

    await input.fill("")
    await goal.click()
    await expect.poll(async () => (await editorText(input)).trim()).toBe("/goal")
    expect(requests).toEqual([])

    await input.fill("Ship the verified fix")
    await goal.click()
    await submit.click()
    await expect.poll(() => requests.length).toBe(1)
    expect(commandRequests).toEqual([])
    expect(requests[0]).toEqual(
      expect.objectContaining({
        prompt: expect.objectContaining({ text: "Ship the verified fix" }),
      }),
    )

    const goalDock = page.locator('[data-component="session-goal-dock"]')
    await expectAppVisible(goalDock)
    await expect(goalDock).toContainText("Ship the verified fix")
    await maybeVisualScreenshot(page, `goal-toolbar-active-${viewport}`)
    await expect
      .poll(() =>
        sessionUpdates.some(
          (update) =>
            (update.metadataPatch as { set?: Record<string, unknown> } | undefined)?.set?.["opencode.session.goal"] ===
            "Ship the verified fix",
        ),
      )
      .toBe(true)

    await page.reload()
    await expectAppVisible(composer)
    const reloadedGoalDock = page.locator('[data-component="session-goal-dock"]')
    await expectAppVisible(reloadedGoalDock)
    await expect(reloadedGoalDock).toContainText("Ship the verified fix")

    await input.fill("now implement it")
    await submit.click()
    await expect.poll(() => requests.length).toBe(2)
    expect(commandRequests).toEqual([])
    expect(requests[1]).toEqual(
      expect.objectContaining({
        prompt: expect.objectContaining({ text: "now implement it" }),
      }),
    )
    await expectAppVisible(goalDock)

    busy = true
    await page.reload()
    await expectAppVisible(goalDock)
    const running = page.locator('[data-component="session-running-status"]')
    await expectAppVisible(running)
    await expect(running.locator('[data-slot="running-model"]')).toContainText("opencode/claude-opus-4-6")
    await expect.poll(async () => {
      const goalBox = await goalDock.boundingBox()
      const runningBox = await running.boundingBox()
      return !!goalBox && !!runningBox && (
        goalBox.x + goalBox.width <= runningBox.x + 1 ||
        runningBox.x + runningBox.width <= goalBox.x + 1 ||
        goalBox.y + goalBox.height <= runningBox.y + 1 ||
        runningBox.y + runningBox.height <= goalBox.y + 1
      )
    }).toBe(true)
    await expect.poll(async () => {
      const inputBox = await input.boundingBox()
      const projectBox = await page.locator('[data-action="prompt-project"]').boundingBox()
      const runningBox = await running.boundingBox()
      return !!inputBox && !!projectBox && !!runningBox &&
        inputBox.y + inputBox.height <= runningBox.y + 1 &&
        projectBox.x + projectBox.width <= runningBox.x + 1 &&
        Math.abs(projectBox.y + projectBox.height / 2 - (runningBox.y + runningBox.height / 2)) <= 6
    }).toBe(true)
    await maybeVisualScreenshot(page, `goal-toolbar-running-${viewport}`)

    await goalDock.getByRole("button", { name: "Cancel" }).click()
    await expect(goalDock).toBeHidden()
    await expect
      .poll(() =>
        sessionUpdates.some((update) =>
          (update.metadataPatch as { unset?: string[] } | undefined)?.unset?.includes("opencode.session.goal"),
        ),
      )
      .toBe(true)

    expect(failedResponses).toEqual([])
    expectNoSmokeErrors(errors, [], [])
  })
}

async function mockGoalPlugin(page: Page) {
  await page.route("**/app/plugins**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({
        plugins: [
          {
            id: "goal-app",
            spec: "goal-app",
            version: "1",
            hash: "goal-app",
            capabilities: JSON.parse(
              readFileSync(new URL("../../../../.opencode/plugin-sources/goal-app/package.json", import.meta.url), "utf8"),
            ).opencode.app.capabilities,
            module: "/app/plugin/goal-app/1/index.js",
          },
        ],
      }),
    }),
  )
  await page.route("**/app/plugin/goal-app/1/index.js**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/javascript",
      headers: { "access-control-allow-origin": "*" },
      body: readFileSync(new URL("../../../../.opencode/plugin-sources/goal-app/index.js", import.meta.url), "utf8"),
    }),
  )
  await page.route("**/app/plugin/goal-app/1/assets/goal.svg**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      headers: { "access-control-allow-origin": "*" },
      body: readFileSync(new URL("../../../../.opencode/plugin-sources/goal-app/assets/goal.svg", import.meta.url), "utf8"),
    }),
  )
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
      return `${text}${el.nextSibling ? "\n" : ""}`
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
