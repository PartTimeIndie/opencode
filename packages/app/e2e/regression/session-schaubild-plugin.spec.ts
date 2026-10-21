import { expect, test } from "@playwright/test"
import { readFileSync } from "node:fs"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"

const directory = "C:/OpenCode/SessionSchaubildQA"
const projectID = "proj_session_schaubild"
const a = "ses_schaubild_a"
const root = new URL("../../../../.opencode/plugin-sources/session-schaubild-app/", import.meta.url)
const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8"))
const labels = '{"done":["Regel entfernt"],"state":["Plugin implementiert, Tests grün"],"open":["E2E-Bestätigung offen"],"user":[],"next":["App-QA (Nutzer)"]}'
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
const capturedAt = new Date(2026, 9, 3, 14, 5).getTime()
test.use({ viewport: { width: 1280, height: 720 }, video: "on" })

test("toolbar click generates and shows the inline session diagram", async ({ page }, info) => {
  const errors: string[] = []
  const failures: string[] = []
  const imagePrompts: string[] = []
  const pluginContexts: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("response", (response) => { if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`) })
  const session = (id: string, title: string) => ({ id, slug: id, projectID, directory, title, version: "dev", time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 } })
  await mockOpenCodeServer(page, {
    directory, project: { id: projectID, worktree: directory, vcs: "git", name: "Schaubild QA", time: { created: 1, updated: 1 }, sandboxes: [] },
    sessions: [session(a, "Schaubild A")], pageMessages: () => ({ items: [] }),
    provider: { all: [{ id: "test", name: "Test", models: {
      summary: { id: "summary", name: "Summary model", capabilities: { input: { text: true }, output: { text: true } }, limit: { context: 32_000, output: 8192 } },
    } }], connected: ["test"], default: { test: "summary" } },
    onAppHostAIRun: () => ({ ok: true, text: labels }),
  })
  await page.route("**/app/plugins**", (route) => route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ plugins: [{ id: manifest.name, spec: manifest.name, version: "1", hash: "session-schaubild", capabilities: manifest.opencode.app.capabilities, module: "/app/plugin/session-schaubild-app/1/index.js" }] }) }))
  for (const file of ["index.js", "core.js", "assets/session-schaubild.svg"]) await page.route(`**/app/plugin/session-schaubild-app/1/${file}**`, (route) => route.fulfill({ status: 200, contentType: file.endsWith(".svg") ? "image/svg+xml" : "text/javascript", headers: { "access-control-allow-origin": "*" }, body: readFileSync(new URL(file, root), "utf8") }))
  await page.route("**/app/host/session-context**", (route) => {
    const input = route.request().postDataJSON()
    if (input.caller?.id === "session-schaubild-app") pluginContexts.push(input.sessionID)
    expect(input.caller.id).toBe("session-schaubild-app")
    expect(input.limit).toBeLessThanOrEqual(200)
    return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*", "cache-control": "no-store" }, body: JSON.stringify({ ok: true, context: {
      version: 1, capturedAt: capturedAt, fingerprint: "stable-schaubild", session: { id: input.sessionID, directory, title: input.sessionID },
      activity: { status: "completed", working: false }, selection: "activity", boundaryComplete: true,
      messages: [{ id: "msg_a", role: "assistant", text: "Regel entfernt, Plugin implementiert, Tests grün. Offen: E2E-Bestätigung.", createdAt: 1, complete: true }],
      pending: { questions: [], permissions: [], controls: [] },
      totals: { messages: 1, textChars: 80, questions: 0, permissions: 0, controls: 0 }, truncated: { messages: false, text: false, pending: false },
      todos: { items: [
        { content: "Regel entfernen", status: "completed", priority: "high" },
        { content: "InstalledQA nach Deploy", status: "pending", priority: "medium" },
      ], total: 2, truncated: false },
    } }) })
  })
  await page.route("**/app/host/images/generate**", (route) => {
    const input = route.request().postDataJSON()
    imagePrompts.push(input.prompt)
    return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*", "cache-control": "no-store" }, body: JSON.stringify({ ok: true, mime: "image/png", data: png, filename: "image.png", bytes: 104 }) })
  })
  await page.addInitScript(({ directory, ids, base }) => {
    localStorage.setItem("settings.v3", "{}")
    localStorage.setItem("opencode.app-plugin.session-schaubild-app.settings.labelTarget", JSON.stringify("model:test/summary"))
    const server = "http://127.0.0.1:4096"
    localStorage.setItem("opencode.global.dat:server", JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] }, lastProject: { local: directory } }))
    localStorage.setItem("opencode.global.dat:tabs", JSON.stringify(ids.map((sessionId) => ({ type: "session", server, dirBase64: base, sessionId }))))
    localStorage.setItem("opencode.global.dat:tabs.recent", JSON.stringify({ key: `${server}\n${base}\n${ids[0]}` }))
  }, { directory, ids: [a], base: base64Encode(directory) })
  await page.goto(`/${base64Encode(directory)}/session/${a}`)
  const button = page.locator('[data-action="session-schaubild-generate"]').first()
  await expect(button).toBeVisible()
  await button.click()
  await expect(page.locator('.oc-session-schaubild[data-phase="done"]').first()).toBeVisible()
  const image = page.locator('img[alt="Schaubild des Sessionstands"]').first()
  await expect(image).toBeVisible()
  await expect(image).toHaveAttribute("src", new RegExp("^data:image/png;base64,"))
  await expect(page.getByText(/Erwartet: Keine Aktion nötig\. Snapshot eines Moments Stand: 14:05 Uhr\./)).toBeVisible()
  await page.screenshot({ path: info.outputPath("schaubild-overlay.png"), fullPage: true })
  expect(pluginContexts).toEqual([a])
  expect(imagePrompts).toHaveLength(1)
  expect(imagePrompts[0]).toContain("Session-Status")
  expect(imagePrompts[0]).toContain("Regel entfernt")
  expect(imagePrompts[0]).toContain("Session-Todos")
  expect(imagePrompts[0]).toContain("Erledigt (1): Regel entfernen")
  expect(imagePrompts[0]).toContain("Offen (1): InstalledQA nach Deploy")
  expect(imagePrompts[0]).toContain("Deine nächsten Schritte: keine")
  expect(errors).toEqual([])
  expect(failures).toEqual([])
  await info.attach("schaubild-evidence", { body: JSON.stringify({ pluginContexts, imagePrompts, errors, failures, note: "Image bytes are a deterministic 1x1 PNG fixture; the real Codex image backend is not part of this UI QA run" }, null, 2), contentType: "application/json" })
})
