import { expect, test } from "@playwright/test"
import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/BootstrapRecoveryQA"
const server = "http://127.0.0.1:4096"
const projectID = "proj_bootstrap_recovery_qa"
const staleID = "ses_bootstrap_unavailable"
const healthyID = "ses_bootstrap_healthy"
const evidence = resolve(import.meta.dirname, "../../../../docs/workitems/screenshots/bootstrap-recovery")

for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
  test(`isolates a 503 session and recovers without restarting the app at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport)
    const docked = viewport.width >= 768
    const sessionURL = (id: string) => `/${base64Encode(directory)}/session/${id}`
    const errors: string[] = []
    const consoleErrors: string[] = []
    const failedRequests: string[] = []
    const unavailableResponses: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()) })
    page.on("requestfailed", (request) => failedRequests.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`))
    page.on("response", (response) => { if (response.status() === 503) unavailableResponses.push(response.url()) })
    let unavailable = false
    await mockOpenCodeServer(page, {
      directory,
      project: { id: projectID, worktree: directory, vcs: "git", name: "bootstrap-recovery-qa", time: { created: 1700000000000, updated: 1700000000000 }, sandboxes: [] },
      provider: {
        all: [{ id: "opencode", name: "OpenCode", models: { "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } } } }],
        connected: ["opencode"],
        default: { providerID: "opencode", modelID: "claude-opus-4-6" },
      },
      sessions: [staleID, healthyID].map((id) => ({
        id, slug: id, projectID, directory, title: id === staleID ? "Recoverable session" : "Healthy session", version: "dev", time: { created: 1700000000000, updated: 1700000000000 },
      })),
      pageMessages: (sessionID) => ({ items: [{
        info: { id: `${sessionID}_user`, sessionID, role: "user", time: { created: 1700000000000 }, summary: { diffs: [] }, agent: "build", model: { providerID: "opencode", modelID: "claude-opus-4-6", variant: "max" } },
        parts: [{ id: `${sessionID}_text`, sessionID, messageID: `${sessionID}_user`, type: "text", text: sessionID === staleID ? "Recovered session content." : "Healthy session content." }],
      }] }),
    })
    await page.route("**/api/session/*/message*", (route) => {
      if (!unavailable || !route.request().url().includes(`/api/session/${staleID}/message`)) return route.fallback()
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*", "retry-after": "1" },
        body: JSON.stringify({ error: "instance_unavailable", directory, reason: "instance bootstrap did not settle within 120000ms", retryAfterMs: 1000 }),
      })
    })
    await page.addInitScript(({ directory, dirBase64, server, staleID, healthyID }) => {
      localStorage.setItem("opencode.global.dat:server", JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] }, lastProject: { local: directory } }))
      localStorage.setItem("opencode.global.dat:tabs", JSON.stringify([staleID, healthyID].map((sessionId) => ({ type: "session", server, dirBase64, sessionId }))))
      localStorage.setItem("opencode.global.dat:tabs.recent", JSON.stringify({ key: `${server}\n${dirBase64}\n${staleID}` }))
    }, { directory, dirBase64: base64Encode(directory), server, staleID, healthyID })

    await page.goto(docked ? "/" : sessionURL(staleID))
    await expectAppVisible(page.getByText("Recovered session content."))
    unavailable = true
    await page.reload()
    await expectAppVisible(page.getByTestId("session-load-error"))
    await expect(page.getByText("Something went wrong")).toHaveCount(0)
    await mkdir(evidence, { recursive: true })
    await page.screenshot({ path: resolve(evidence, `unavailable-${viewport.width}.png`) })

    if (docked) await page.locator(`[data-dock-tab][data-session-id="${healthyID}"]`).getByRole("tab").click()
    else await page.goto(sessionURL(healthyID))
    await expectAppVisible(page.getByText("Healthy session content."))
    if (docked) await page.locator(`[data-dock-tab][data-session-id="${staleID}"]`).getByRole("tab").click()
    else await page.goto(sessionURL(staleID))
    await expectAppVisible(page.getByTestId("session-load-error"))
    unavailable = false
    await page.getByRole("button", { name: "Retry", exact: true }).click()
    await expectAppVisible(page.getByText("Recovered session content."))
    await expect(page.getByTestId("session-load-error")).toHaveCount(0)
    await expect(page.locator('[data-component="prompt-input"][contenteditable="true"]')).toBeVisible()
    await page.screenshot({ path: resolve(evidence, `recovered-${viewport.width}.png`) })
    // Only this test's injected 503s and navigation-cancelled telemetry are
    // expected. Keep all other console/network failures as hard QA gates.
    const unexpectedConsoleErrors = consoleErrors.filter((message) => message !== "Failed to load resource: the server responded with a status of 503 (Service Unavailable)")
    const unexpectedFailedRequests = failedRequests.filter((request) => request !== `POST ${server}/perf/record: net::ERR_ABORTED`)
    const diagnostics = JSON.stringify({ viewport, url: page.url(), pageErrors: errors, consoleErrors, failedRequests, unexpectedConsoleErrors, unexpectedFailedRequests, expected503Responses: unavailableResponses }, null, 2)
    await writeFile(resolve(evidence, `diagnostics-${viewport.width}.json`), diagnostics + "\n")
    await testInfo.attach("console-and-network", {
      body: diagnostics,
      contentType: "application/json",
    })
    expect(errors).toEqual([])
    expect(unexpectedConsoleErrors).toEqual([])
    expect(unexpectedFailedRequests).toEqual([])
    expect(unavailableResponses.length).toBeGreaterThan(0)
    expect(unavailableResponses.every((url) => url.includes(`/api/session/${staleID}/message`))).toBe(true)
  })
}
