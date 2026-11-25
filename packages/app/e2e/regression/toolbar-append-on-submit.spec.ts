import { expect, test, type Page, type Route } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { fixture } from "../smoke/session-timeline.fixture"

const directory = "C:/OpenCode/ToolbarAppend"
const sessionID = "ses_toolbar_append"
const plugin = `export default { id: "append-fixture", app(api) {
  const base = { placement: "composer", align: "right", defaultVisible: true, icon: { name: "code" } }
  api.toolbar.register({ ...base, id: "image", title: "Image toggle", command: { name: "codex-image" }, appendOnSubmit: true })
  api.toolbar.register({ ...base, id: "skill", title: "Skill toggle", skill: { name: "manual-review" }, appendOnSubmit: true })
  api.toolbar.register({ ...base, id: "custom", title: "Custom override", command: { name: "custom" }, appendOnSubmit: true, run() {} })
  api.commands.register({ id: "toggle", title: "Palette image toggle", keybind: "ctrl+alt+i", async run() {
    const result = await api.host.toolbar.toggle({ item: "image" })
    if (!result.ok) throw new Error(result.error)
  } })
} }`

function json(route: Route, data: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify(data),
  })
}

async function setup(page: Page, composer = true) {
  const prompts: Record<string, unknown>[] = []
  const commands: string[] = []
  const dialogs: string[] = []
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message())
    void dialog.dismiss()
  })
  await mockOpenCodeServer(page, {
    directory,
    project: { id: "toolbar-project", worktree: directory, name: "Toolbar append", vcs: "git" },
    provider: fixture.provider,
    sessions: [
      {
        id: sessionID,
        slug: sessionID,
        directory,
        projectID: "toolbar-project",
        title: "Toolbar append",
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
    commands: [
      { name: "codex-image", source: "command" },
      { name: "manual-review", source: "skill" },
    ],
  })
  await page.route("**/app/plugins**", (route) =>
    json(route, {
      plugins: [
        {
          id: "append-fixture",
          spec: "append-fixture",
          version: "1",
          hash: "append-fixture-1",
          module: "/app/plugin/append-fixture/1/index.js",
          capabilities: ["ui:toolbar", "commands", "host:toolbar", ...(composer ? ["host:composer"] : [])],
        },
      ],
    }),
  )
  await page.route("**/app/plugin/append-fixture/1/index.js**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/javascript",
      headers: { "access-control-allow-origin": "*" },
      body: plugin,
    }),
  )
  await page.route(/\/api\/session\/[^/]+\/prompt(?:\?|$)/, (route) => {
    prompts.push(JSON.parse(route.request().postData() ?? "{}"))
    return json(route, { data: { sessionID, messageID: "msg_admitted", admittedSeq: prompts.length } })
  })
  await page.route(/\/session\/[^/]+\/command(?:\?|$)/, (route) => {
    commands.push(route.request().url())
    return json(route, {})
  })
  await page.addInitScript(
    ({ directory, dir, sessionID }) => {
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", server: "http://127.0.0.1:4096", dirBase64: dir, sessionId: sessionID }]),
      )
    },
    { directory, dir: base64Encode(directory), sessionID },
  )
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  const editor = page.getByRole("textbox", { name: /Ask anything/i })
  await expect(editor).toBeVisible()
  const image = page.locator('[data-plugin-toolbar-item="append-fixture/image"]')
  await expect(image).toBeVisible()
  return { editor, image, prompts, commands, dialogs }
}

test("real toolbar and palette toggle share one-shot state; only manual submit appends", async ({ page }) => {
  const f = await setup(page)
  await f.editor.fill("Draw a house")
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({
      name: "reference.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7S0AAAAASUVORK5CYII=",
        "base64",
      ),
    })
  await f.image.click()
  await expect(f.image).toHaveAttribute("aria-pressed", "true")
  await expect(f.editor).toHaveText("Draw a house")
  expect(f.prompts).toEqual([])
  expect(f.commands).toEqual([])
  expect(f.dialogs).toEqual([])
  await page.keyboard.press("Control+Alt+i")
  await expect(f.image).toHaveAttribute("aria-pressed", "false")
  await page.keyboard.press("Control+Alt+i")
  await expect(f.image).toHaveAttribute("aria-pressed", "true")
  await page.locator('[data-plugin-toolbar-item="append-fixture/skill"]').click()
  await page.locator('[data-plugin-toolbar-item="append-fixture/custom"]').click()
  await f.editor.press("Enter")
  await expect.poll(() => f.prompts.length).toBe(1)
  expect(JSON.stringify(f.prompts[0])).toContain("Draw a house\\n\\n/codex-image\\n\\n/manual-review")
  expect(JSON.stringify(f.prompts[0])).not.toContain("/custom")
  expect(JSON.stringify(f.prompts[0])).toContain("image/png")
  await expect(f.image).toHaveAttribute("aria-pressed", "false")
  expect(f.commands).toEqual([])
  expect(f.dialogs).toEqual([])
})

test("missing composer capability leaves standard buttons disabled", async ({ page }) => {
  const f = await setup(page, false)
  await expect(f.image).toBeDisabled()
  expect(f.prompts).toEqual([])
})

test("hiding and re-enabling a toolbar item clears its activation", async ({ page }) => {
  const f = await setup(page)
  await f.image.click()
  await expect(f.image).toHaveAttribute("aria-pressed", "true")
  await page.getByRole("button", { name: "Open settings" }).click()
  await page.getByRole("tab", { name: "Skills & Plugins", exact: true }).click()
  const row = page.locator('[data-plugin-toolbar-settings] [data-component="settings-v2-row"]').filter({ hasText: "Image toggle" })
  await row.locator('[data-slot="switch-control"]').click()
  await expect(f.image).toHaveCount(0)
  await row.locator('[data-slot="switch-control"]').click()
  await page.keyboard.press("Escape")
  await expect(f.image).toHaveAttribute("aria-pressed", "false")
})

test("reload clears pending activation", async ({ page }) => {
  const f = await setup(page)
  await f.image.click()
  await expect(f.image).toHaveAttribute("aria-pressed", "true")
  await page.reload()
  await expect(f.image).toHaveAttribute("aria-pressed", "false")
})
