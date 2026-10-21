import { expect, test } from "@playwright/test"
import { mkdirSync } from "node:fs"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { fixture } from "../smoke/session-timeline.fixture"

const screenshotDir = "../../docs/workitems/screenshots/turn-completion-status"

test.describe("turn completion status", () => {
  test("shows incomplete status in todo dock, tab dot, and settings", async ({ page }) => {
    const errors: string[] = []
    const networkFailures: string[] = []
    const updates: unknown[] = []
    let eventCalls = 0
    const eventModes: string[] = []
    let eventMode: "idle" | "incomplete" | "busy" = "idle"
    let globalConfig: Record<string, unknown> = { session: { turn_completion: {} } }

    page.on("pageerror", (error) => errors.push(error.message))
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text())
    })
    page.on("requestfailed", (request) => {
      if (request.failure()?.errorText === "net::ERR_ABORTED" && request.url().includes("/provider-icons/sprite.svg")) return
      if (request.failure()?.errorText === "net::ERR_ABORTED" && request.url().includes("/perf/record")) return
      if (
        request.method() === "GET" &&
        request.failure()?.errorText === "net::ERR_ABORTED" &&
        ["/vcs/diff", `/session/${fixture.sourceID}/diff`].includes(new URL(request.url()).pathname)
      )
        return
      networkFailures.push(`${request.method()} ${request.url()} ${request.failure()?.errorText}`)
    })
    page.on("response", (response) => {
      if (response.status() >= 400) networkFailures.push(`${response.status()} ${response.request().method()} ${response.url()}`)
    })

    await mockOpenCodeServer(page, {
      sessions: fixture.sessions,
      provider: fixture.provider,
      directory: fixture.directory,
      project: fixture.project,
      pageMessages: (sessionID) => ({ items: fixture.messages[sessionID] ?? [] }),
      globalConfig: () => globalConfig,
      onGlobalConfigUpdate: (body) => {
        updates.push(body)
        globalConfig = body as Record<string, unknown>
        return globalConfig
      },
      eventRetry: 100,
      events: () => {
        eventCalls += 1
        eventModes.push(eventMode)
        if (eventMode === "incomplete") {
          return [
            {
              directory: fixture.directory,
              payload: {
                id: "evt_todo",
                type: "todo.updated",
                properties: {
                  sessionID: fixture.sourceID,
                  todos: [
                    { content: "Finish implementation", priority: "high", status: "pending" },
                    { content: "Run Visual QA", priority: "medium", status: "pending" },
                  ],
                },
              },
            },
            {
              directory: fixture.directory,
              payload: {
                id: "evt_turn_complete",
                type: "session.turn.completed",
                properties: { sessionID: fixture.sourceID, status: "incomplete" },
              },
            },
          ]
        }
        return [
          {
            directory: fixture.directory,
            payload: {
              id: eventMode === "busy" ? "evt_busy" : "evt_ready",
              type: "session.status",
              properties: { sessionID: fixture.sourceID, status: { type: eventMode === "busy" ? "busy" : "idle" } },
            },
          },
        ]
      },
    })

    await page.addInitScript(
      ({ dir, dirBase64, server, sessionID }) => {
        localStorage.setItem("settings.v3", JSON.stringify({}))
        localStorage.setItem(
          "opencode.global.dat:server",
          JSON.stringify({ projects: { [server]: [{ worktree: dir, expanded: true }] }, lastProject: { [server]: dir } }),
        )
        localStorage.setItem(
          "opencode.global.dat:tabs",
          JSON.stringify([{ type: "session", server, dirBase64, sessionId: sessionID }]),
        )
        localStorage.setItem(
          "opencode.global.dat:tabs.recent",
          JSON.stringify({ key: `${server}\n${dirBase64}\n${sessionID}` }),
        )
      },
      {
        dir: fixture.directory,
        dirBase64: base64Encode(fixture.directory),
        server: "http://127.0.0.1:4096",
        sessionID: fixture.sourceID,
      },
    )

    await page.goto(`/${base64Encode(fixture.directory)}/session/${fixture.sourceID}`)
    const sessionTab = page.locator(`[data-dock-tab][data-session-id="${fixture.sourceID}"]`).getByRole("tab")
    await expect(sessionTab).toBeVisible()
    await sessionTab.click()
    await expect(sessionTab).toHaveAttribute("aria-selected", "true")
    await expect(page.getByRole("heading", { name: fixture.expected.sourceTitle })).toBeVisible()
    eventMode = "incomplete"

    await expect.poll(() => eventCalls, { timeout: 10_000 }).toBeGreaterThan(1)
    await expect.poll(() => eventModes.includes("incomplete"), { timeout: 10_000 }).toBe(true)
    await expect(page.locator('[data-slot="todo-status-badge"][data-status="incomplete"]')).toBeVisible()
    const incompleteDot = page.locator('[data-slot="project-avatar-unread-dot"][data-status="incomplete"]').first()
    await expect(incompleteDot).toBeVisible()
    const incompleteDotMetrics = await incompleteDot.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return { width: rect.width, height: rect.height, background: style.backgroundColor, boxShadow: style.boxShadow }
    })
    expect(incompleteDotMetrics.width).toBeGreaterThanOrEqual(8)
    expect(incompleteDotMetrics.height).toBeGreaterThanOrEqual(8)
    expect(incompleteDotMetrics.background).not.toBe("rgba(0, 0, 0, 0)")
    expect(incompleteDotMetrics.boxShadow).not.toBe("none")

    mkdirSync(screenshotDir, { recursive: true })
    await page.screenshot({ path: `${screenshotDir}/incomplete-status.png`, fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: `${screenshotDir}/incomplete-status-mobile.png`, fullPage: true })
    await page.setViewportSize({ width: 1280, height: 720 })

    eventMode = "busy"
    await expect(page.locator('[data-slot="project-avatar-unread-dot"][data-status="incomplete"]')).toHaveCount(0)
    await page.screenshot({ path: `${screenshotDir}/cleared-on-busy.png`, fullPage: true })

    await page.getByRole("button", { name: "Open settings" }).click()
    await expect(page.getByRole("heading", { name: "Turn completion" })).toBeVisible()
    await page.locator('[data-action="settings-turn-completion-enabled"] [data-component="switch"]').click()
    await page.locator('[data-action="settings-turn-completion-model"] button').click()
    await page.locator('[data-slot="list-item"][data-key="opencode:claude-opus-4-6"]').click()
    await page.locator('[data-action="settings-turn-completion-prompt"] textarea').fill("Return DONE or INCOMPLETE only.")
    await page.screenshot({ path: `${screenshotDir}/settings.png`, fullPage: true })

    await expect.poll(() => updates.at(-1), { timeout: 10_000 }).toMatchObject({
      session: {
        turn_completion: {
          enabled: true,
          target: "model:opencode/claude-opus-4-6",
          prompt: "Return DONE or INCOMPLETE only.",
        },
      },
    })
    expect(errors).toEqual([])
    expect(networkFailures).toEqual([])
  })
})
