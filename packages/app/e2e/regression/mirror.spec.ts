import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { expect, test, type Page, type Route } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { trackPageErrors, trackNetworkFailures } from "../utils/errors"
import { fixture } from "../smoke/session-timeline.fixture"

const directory = "C:/Projects/GeneralMirror"
const sessionID = "ses_general_mirror"
const source = new URL("../../../../.opencode/plugin-sources/mirror-app/", import.meta.url)
const screenshots = "test-results/mirror"

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) })
}

async function setup(page: Page, fresh = false, mobile = false) {
  const errors = trackPageErrors(page)
  const failures = trackNetworkFailures(page)
  const prompts: { sessionID: string; body: unknown }[] = []
  const creates: unknown[] = []
  const hostCommands: string[] = []
  const session = { id: sessionID, slug: sessionID, projectID: "mirror-project", directory, title: "Mirror task", version: "dev",
    time: { created: 1700000000000, updated: 1700000000000 } }
  const sessions = fresh ? [] : [session]
  await mockOpenCodeServer(page, {
    directory, provider: fixture.provider,
    project: { id: "mirror-project", name: "General Mirror", worktree: directory, vcs: "git" },
    sessions,
    pageMessages: () => ({ items: [] }),
    commands: [{ name: "mirror", source: "skill" }, { name: "native-orchestrator", source: "skill" }],
    onSessionCreate: (body) => {
      creates.push(body)
      sessions.push(session)
      return session
    },
    onSessionPrompt: (input) => {
      prompts.push(input)
      return { data: { sessionID: input.sessionID, messageID: "msg_mirror", admittedSeq: prompts.length } }
    },
  })
  await page.route("**/app/plugins**", (route) => json(route, { plugins: [{
    id: "mirror-app", spec: "mirror-app", version: "1", hash: "mirror-qa", module: "/app/plugin/mirror-app/1/index.js",
    capabilities: JSON.parse(readFileSync(new URL("package.json", source), "utf8")).opencode.app.capabilities,
  }] }))
  await page.route("**/app/plugin/mirror-app/1/**", (route) => {
    const name = new URL(route.request().url()).pathname.split("/1/")[1]
    if (!["index.js", "assets/mirror.svg"].includes(name)) throw new Error(`Unexpected plugin asset: ${name}`)
    return route.fulfill({ status: 200, contentType: name.endsWith(".svg") ? "image/svg+xml" : "text/javascript",
      headers: { "access-control-allow-origin": "*" }, body: readFileSync(new URL(name, source)) })
  })
  await page.route("**/app/host/command", (route) => {
    hostCommands.push(route.request().url())
    return json(route, { ok: false, error: "Mirror must not run host commands on click" })
  })
  await page.addInitScript(({ directory, encoded, sessionID, fresh }) => {
    localStorage.setItem("opencode.global.dat:server", JSON.stringify({
      projects: { "http://127.0.0.1:4096": [{ worktree: directory, expanded: true }] },
      lastProject: { "http://127.0.0.1:4096": directory },
    }))
    if (!fresh) localStorage.setItem("opencode.global.dat:tabs", JSON.stringify([
      { type: "session", server: "http://127.0.0.1:4096", dirBase64: encoded, sessionId: sessionID },
    ]))
  }, { directory, encoded: base64Encode(directory), sessionID, fresh })
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session${fresh ? "" : `/${sessionID}`}`)
  const editor = page.getByRole("textbox", { name: /Ask anything/i })
  const button = page.locator('[data-plugin-toolbar-item="mirror-app/mirror"]')
  await expect(editor).toBeVisible()
  await expect(button).toBeVisible()
  await expect(button).toBeEnabled()
  if (fresh) await expect(editor).not.toHaveAttribute("data-session-id", /.+/)
  return { editor, button, prompts, creates, hostCommands, errors, failures }
}

for (const fresh of [false, true]) for (const submit of ["enter", "send"] as const) {
  test(`${fresh ? "new chat before Session creation" : "existing Session"}: Mirror via ${submit}`, async ({ page }) => {
    const f = await setup(page, fresh, submit === "send")
    await f.button.click()
    await expect(f.button).toHaveAttribute("aria-pressed", "true")
    expect(f.creates).toEqual([])
    expect(f.prompts).toEqual([])
    expect(f.hostCommands).toEqual([])
    await expect(f.editor).toHaveText("")
    await f.editor.fill("Implement this task with /native-orchestrator enabled")
    mkdirSync(screenshots, { recursive: true })
    await page.screenshot({ path: `${screenshots}/${fresh ? "new" : "existing"}-${submit}-armed.png` })
    if (submit === "enter") await f.editor.press("Enter")
    else await page.locator('[data-action="prompt-submit"]').click()
    await expect.poll(() => f.prompts.length).toBe(1)
    expect(f.prompts[0]).toMatchObject({ sessionID, body: { prompt: { text: "Implement this task with /native-orchestrator enabled\n\n/mirror" } } })
    expect(f.creates).toHaveLength(fresh ? 1 : 0)
    expect(f.hostCommands).toEqual([])
    await expect(f.button).toHaveAttribute("aria-pressed", "false")
    expect(f.errors).toEqual([])
    expect(f.failures).toEqual([])
    writeFileSync(`${screenshots}/${fresh ? "new" : "existing"}-${submit}.json`, JSON.stringify({ prompts: f.prompts, errors: f.errors, failures: f.failures }, null, 2))
  })
}

test("Mirror disarms without touching the draft and does not duplicate a typed /mirror", async ({ page }) => {
  const f = await setup(page)
  await f.editor.fill("Implement this task /mirror please")
  await f.button.click()
  await f.button.click()
  await expect(f.button).toHaveAttribute("aria-pressed", "false")
  await expect(f.editor).toHaveText("Implement this task /mirror please")
  await f.button.click()
  await f.editor.press("Enter")
  await expect.poll(() => f.prompts.length).toBe(1)
  expect(f.prompts[0]).toMatchObject({ body: { prompt: { text: "Implement this task /mirror please" } } })
  expect(f.errors).toEqual([])
  expect(f.failures).toEqual([])
})
