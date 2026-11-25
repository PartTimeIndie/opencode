import { mkdirSync, readFileSync } from "node:fs"
import { expect, test, type Page, type Route } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { trackPageErrors, trackNetworkFailures } from "../utils/errors"
import { fixture } from "../smoke/session-timeline.fixture"

const directory = "C:/Projects/NativeOrchestrator"
const sessionID = "ses_native_orchestrator"
const source = new URL("../../../../.opencode/plugin-sources/", import.meta.url)
const screenshots = "test-results/native-orchestrator"

function json(route: Route, body: unknown) {
  return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) })
}

async function setup(page: Page, fresh = false, mobile = false) {
  const errors = trackPageErrors(page)
  const failures = trackNetworkFailures(page)
  const prompts: { sessionID: string; body: unknown }[] = []
  const creates: unknown[] = []
  const hostCommands: string[] = []
  const session = { id: sessionID, slug: sessionID, projectID: "native-project", directory, title: "Plan before forks", version: "dev",
    time: { created: 1700000000000, updated: 1700000000000 } }
  const sessions = fresh ? [] : [session]
  await mockOpenCodeServer(page, {
    directory, provider: fixture.provider,
    project: { id: "native-project", name: "Native Orchestrator", worktree: directory, vcs: "git" },
    sessions,
    pageMessages: () => ({ items: [] }),
    commands: [{ name: "native-orchestrator", source: "skill" }, { name: "mirror", source: "skill" }],
    onSessionCreate: (body) => {
      creates.push(body)
      sessions.push(session)
      return session
    },
    onSessionPrompt: (input) => {
      prompts.push(input)
      return { data: { sessionID: input.sessionID, messageID: "msg_native", admittedSeq: prompts.length } }
    },
  })
  const plugins = ["native-orchestrator-app", "mirror-app"]
  await page.route("**/app/plugins**", (route) => json(route, { plugins: plugins.map((id) => ({
    id, spec: id, version: "1", hash: `${id}-qa`, module: `/app/plugin/${id}/1/index.js`,
    capabilities: JSON.parse(readFileSync(new URL(`${id}/package.json`, source), "utf8")).opencode.app.capabilities,
  })) }))
  await page.route("**/app/plugin/*/1/**", (route) => {
    const match = new URL(route.request().url()).pathname.match(/\/app\/plugin\/([^/]+)\/1\/(.+)$/)
    if (!match || !plugins.includes(match[1]) || !["index.js", "assets/native-orchestrator.svg", "assets/mirror.svg"].includes(match[2]))
      throw new Error("Unexpected native orchestrator fixture asset")
    return route.fulfill({ status: 200, contentType: match[2].endsWith(".svg") ? "image/svg+xml" : "text/javascript",
      headers: { "access-control-allow-origin": "*" }, body: readFileSync(new URL(`${match[1]}/${match[2]}`, source)) })
  })
  await page.route("**/app/host/command", (route) => {
    hostCommands.push(route.request().url())
    return json(route, { ok: false, error: "Toolbar clicks must not execute host commands" })
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
  const button = page.locator('[data-plugin-toolbar-item="native-orchestrator-app/native-orchestrator"]')
  await expect(editor).toBeVisible()
  await expect(button).toBeVisible()
  await expect(button).toBeEnabled()
  if (fresh) await expect(editor).not.toHaveAttribute("data-session-id", /.+/)
  return { editor, button, prompts, creates, hostCommands, errors, failures }
}

for (const fresh of [false, true]) for (const submit of ["enter", "send"] as const) {
  test(`${fresh ? "new" : "existing"} conversation: native orchestration via ${submit}`, async ({ page }) => {
    const f = await setup(page, fresh, submit === "send")
    await f.button.click()
    await expect(f.button).toHaveAttribute("aria-pressed", "true")
    await expect(f.editor).toHaveText("")
    expect(f.prompts).toEqual([])
    expect(f.creates).toEqual([])
    expect(f.hostCommands).toEqual([])
    await f.editor.fill("Plan the change with me before creating implementation forks.")
    mkdirSync(screenshots, { recursive: true })
    await page.screenshot({ path: `${screenshots}/${fresh ? "new" : "existing"}-${submit}.png` })
    if (submit === "enter") await f.editor.press("Enter")
    else await page.locator('[data-action="prompt-submit"]').click()
    await expect.poll(() => f.prompts.length).toBe(1)
    expect(f.prompts[0]).toMatchObject({ sessionID, body: { prompt: {
      text: "Plan the change with me before creating implementation forks.\n\n/native-orchestrator",
    } } })
    expect(f.creates).toHaveLength(fresh ? 1 : 0)
    expect(f.hostCommands).toEqual([])
    await expect(f.button).toHaveAttribute("aria-pressed", "false")
    expect(f.errors).toEqual([])
    expect(f.failures).toEqual([])
  })
}

test("native toggle disarms, deduplicates a typed skill and composes with Mirror", async ({ page }) => {
  const f = await setup(page)
  await f.editor.fill("Plan this /native-orchestrator")
  await f.button.click()
  await f.button.click()
  await expect(f.button).toHaveAttribute("aria-pressed", "false")
  await expect(f.editor).toHaveText("Plan this /native-orchestrator")
  await f.button.click()
  const mirror = page.locator('[data-plugin-toolbar-item="mirror-app/mirror"]')
  await mirror.click()
  expect(f.prompts).toEqual([])
  await f.editor.press("Enter")
  await expect.poll(() => f.prompts.length).toBe(1)
  expect(f.prompts[0]).toMatchObject({ body: { prompt: { text: "Plan this /native-orchestrator\n\n/mirror" } } })
  await expect(f.button).toHaveAttribute("aria-pressed", "false")
  await expect(mirror).toHaveAttribute("aria-pressed", "false")
  expect(f.hostCommands).toEqual([])
  expect(f.errors).toEqual([])
  expect(f.failures).toEqual([])
})
