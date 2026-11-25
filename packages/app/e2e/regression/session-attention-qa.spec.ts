import { expect, test } from "@playwright/test"
import { readFile } from "node:fs/promises"
import { mockOpenCodeServer } from "../utils/mock-server"

const directory = "C:/OpenCode/AttentionQA"
const server = "http://127.0.0.1:4096"
const current = "ses_attention_qa_current"
const important = "ses_attention_qa_important"
const encoded = Buffer.from(directory).toString("base64url")
const session = (id: string, title: string) => ({ id, slug: id, projectID: "proj_attention_qa", directory, title,
  version: "dev", time: { created: 1700000000000, updated: 1700000000000 } })

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`important-session nonmodal notice stays reachable at ${viewport.width}px`, async ({ page }) => {
    let questionPending = false
    let liveQuestionPending = false
    let emitLiveAsk = false
    const questionSession = viewport.width > 600 ? current : important
    await page.addInitScript(() => {
      Object.defineProperty(window, "Notification", { configurable: true, value: class {
        static permission = "granted"
        constructor(title: string) {
          if (title !== "Important session has a question") return
          sessionStorage.setItem("qa-priority-toasts", String(Number(sessionStorage.getItem("qa-priority-toasts") ?? 0) + 1))
        }
        close() {}
      } })
    })
    await mockOpenCodeServer(page, {
      directory,
      project: { id: "proj_attention_qa", worktree: directory, vcs: "git", name: "Attention QA",
        time: { created: 1700000000000, updated: 1700000000000 }, sandboxes: [] },
      provider: { all: [{ id: "opencode", name: "OpenCode", models: {
        "test-model": { id: "test-model", name: "Test", limit: { context: 200000 } },
      } }], connected: ["opencode"], default: { providerID: "opencode", modelID: "test-model" } },
      sessions: [session(current, "Current session"), session(important, "Important finished session")],
      pageMessages: () => ({ items: [] }),
      questions: () => [
        ...(questionPending ? [{ id: "que_attention_qa", sessionID: questionSession, mode: "blocking",
          questions: [{ question: "Can you choose an option?", options: [{ id: "yes", label: "Yes" }] }] }] : []),
        ...(liveQuestionPending ? [{ id: "que_attention_live", sessionID: important, mode: "blocking",
          questions: [{ question: "Live question?", options: [{ id: "yes", label: "Yes" }] }] }] : []),
      ],
      globalEvents: () => emitLiveAsk ? [{ directory, payload: { id: "evt_priority_live", type: "surface.asked",
        properties: { id: "que_attention_live", sessionID: important, mode: "blocking",
          questions: [{ question: "Live question?", options: [{ id: "yes", label: "Yes" }] }] } } }] : [],
      eventRetry: 150,
    })
    await page.route("**/session/*/attention-state*", (route) => route.fulfill({ status: 200,
      contentType: "application/json", headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ sessionID: important, title: "Important finished session", directory,
        archived: false, cursor: 4, count: 0, working: false }),
    }))
    const source = await readFile(new URL("../../../../.opencode/plugin-sources/session-priority-app/index.js", import.meta.url), "utf8")
    await page.route("**/app/plugins**", (route) => route.fulfill({ status: 200, contentType: "application/json",
      headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ plugins: [{
        id: "session-priority-app", spec: "session-priority-app", version: "1", hash: "qa",
        module: "/app/plugin/session-priority-app/1/app.js", capabilities: ["ui:slots", "host:session-attention"],
      }] }) }))
    await page.route("**/app/plugin/session-priority-app/1/app.js**", (route) => route.fulfill({ status: 200,
      contentType: "text/javascript", headers: { "access-control-allow-origin": "*" }, body: source }))
    await page.addInitScript(({ directory, server, current, important, encoded }) => {
      localStorage.setItem("opencode.global.dat:server", JSON.stringify({
        projects: { local: [{ worktree: directory, expanded: true }] }, lastProject: { local: directory },
      }))
      localStorage.setItem("opencode.global.dat:tabs", JSON.stringify([
        { type: "session", server, dirBase64: encoded, sessionId: current },
        { type: "session", server, dirBase64: encoded, sessionId: important },
      ]))
      localStorage.setItem("opencode.global.dat:tabs.recent", JSON.stringify({ key: `${server}\n${encoded}\n${current}` }))
      localStorage.setItem("opencode.global.dat:session-attention", JSON.stringify({ entries: {
        [`${server}\n${directory.toLowerCase()}\n${important}`]: { enabled: true, cursor: 4, seen: 2, count: 1,
          error: true, title: "Important finished session", directory },
      } }))
    }, { directory, server, current, important, encoded })
    await page.setViewportSize(viewport)
    await page.goto(`/${encoded}/session/${current}`)
    const notice = page.getByRole("complementary", { name: /Important sessions need attention|Wichtige Sessions brauchen Aufmerksamkeit/ })
    await expect(notice).toBeVisible()
    await expect(notice).toContainText("Important finished session")
    await expect(page.getByRole("heading", { name: "Current session" })).toBeVisible()
    if (viewport.width > 600) await expect(page.getByLabel("Important result unseen")).toBeVisible()
    const bounds = await notice.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1)
    await page.screenshot({ path: test.info().outputPath(`important-session-${viewport.width}.png`) })
    await notice.getByRole("button", { name: /Open session|Session öffnen/ }).click()
    await expect(notice).toBeHidden()
    if (viewport.width > 600) {
      await page.getByRole("tab", { name: "Current session" }).locator("..").getByRole("button", { name: "More options" }).click()
      await expect(page.getByRole("menuitemcheckbox", { name: "Wichtige Session markieren" })).toBeVisible()
      await page.getByRole("menuitemcheckbox", { name: "Wichtige Session markieren" }).click()
      await expect(page.getByRole("tab", { name: "Current session" }).getByLabel("Important session")).toBeVisible()
      await page.addInitScript(({ id, directory, server }) => {
        const storageKey = "opencode.global.dat:session-attention"
        const data = JSON.parse(localStorage.getItem(storageKey) ?? '{"entries":{}}') as { entries: Record<string, unknown> }
        data.entries[`${server}\n${directory.toLowerCase()}\n${id}`] = {
          enabled: true, cursor: 4, seen: 4, count: 0, error: false, title: "Current session", directory,
        }
        localStorage.setItem(storageKey, JSON.stringify(data))
      }, { id: current, directory, server })
    }
    questionPending = true
    await page.goto(`/${encoded}/session/${viewport.width > 600 ? important : current}`)
    await page.reload()
    if (viewport.width > 600) await page.getByRole("tab", { name: "Important finished session" }).click()
    await expect(notice).toBeVisible()
    await expect(notice).toContainText("Waiting for your answer")
    await expect(notice.locator("[data-session-attention]")).toHaveCount(1)
    await page.getByRole("button", { name: "Minimize" }).click()
    await expect(notice).toBeVisible()
    await page.screenshot({ path: test.info().outputPath(`important-question-${viewport.width}.png`) })
    await page.evaluate(() => {
      Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false })
      window.dispatchEvent(new Event("blur"))
    })
    await notice.getByRole("button", { name: /Open session|Session öffnen/ }).click()
    await expect(page.locator(`[data-session-attention="${questionSession}"]`)).toHaveCount(1)
    await page.evaluate(() => {
      Object.defineProperty(document, "hasFocus", { configurable: true, value: () => true })
      window.dispatchEvent(new Event("focus"))
    })
    await expect(page.locator(`[data-session-attention="${questionSession}"]`)).toHaveCount(0)
    questionPending = false
    await page.reload()
    if (viewport.width > 600) await expect(page.locator(`[data-session-attention="${questionSession}"]`)).toHaveCount(0)
    else await expect(page.locator(`[data-session-attention="${questionSession}"]`)).not.toContainText("Waiting for your answer")
    if (viewport.width <= 600) return
    liveQuestionPending = true
    emitLiveAsk = true
    await page.waitForFunction(() => Number(sessionStorage.getItem("qa-priority-toasts")) === 1)
    await expect(page.locator(`[data-session-attention="${important}"]`)).toContainText("Waiting for your answer")
    await page.waitForTimeout(500)
    expect(await page.evaluate(() => Number(sessionStorage.getItem("qa-priority-toasts")))).toBe(1)
  })
}
