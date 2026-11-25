import { expect, test, _electron } from "@playwright/test"
import { createRequire } from "node:module"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createServer } from "node:http"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"

test("isolated Electron webviews keep live state and URL behind the real main-process transfer boundary", async ({ baseURL }, info) => {
  test.setTimeout(120_000)
  const root = await mkdtemp(join(tmpdir(), "opencode-web-dock-"))
  const main = join(root, "main.cjs")
  const preload = join(root, "preload.cjs")
  const fixture = resolve("../desktop/scripts/fixtures/browser-web-dock")
  const executablePath: string = createRequire(resolve("../desktop/package.json"))("electron")
  const website = createServer((_, response) => {
    response.writeHead(200, { "content-type": "text/html" })
    response.end("<!doctype html><title>Live desktop fixture</title><h1>Desktop fixture</h1><input aria-label='Note'><script>window.loadID=crypto.randomUUID()</script>")
  })
  await new Promise<void>((done) => website.listen(0, "127.0.0.1", done))
  const address = website.address()
  if (!address || typeof address === "string") throw new Error("Fixture server did not bind")
  const url = `http://127.0.0.1:${address.port}`
  const directory = "C:/OpenCode/ElectronWebDockFixture"
  const sessionID = "ses_electron_web_dock"
  const encoded = base64Encode(directory)
  const env = { ...process.env, OPENCODE_WEB_DOCK_FIXTURE_ROOT: root, OPENCODE_WEB_DOCK_FIXTURE_PRELOAD: preload }
  Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE")
  try {
    for (const [source, target] of [["main.ts", main], ["preload.ts", preload]]) {
      execFileSync("bun", ["build", join(fixture, source!), "--target=node", "--format=cjs", "--external=electron", `--outfile=${target}`], { stdio: "pipe" })
    }
    const app = await _electron.launch({ executablePath, args: [main], env })
    try {
      const page = await app.firstWindow()
      await mockOpenCodeServer(page, {
        directory,
        project: { id: "proj_electron_dock", worktree: directory, vcs: "git", name: "electron", time: { created: 1, updated: 1 }, sandboxes: [] },
        provider: { all: [], default: {}, connected: [] },
        sessions: [{ id: sessionID, slug: sessionID, projectID: "proj_electron_dock", directory, title: "electron", version: "dev", time: { created: 1, updated: 1 } }],
        pageMessages: () => ({ items: [] }),
      })
      await page.addInitScript(({ directory, encoded, sessionID }) => {
        if (localStorage.getItem("electron-web-dock-initialized")) return
        localStorage.setItem("electron-web-dock-initialized", "true")
        localStorage.setItem("settings.v3", "{}")
        localStorage.setItem("opencode.global.dat:server", JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] }, lastProject: { local: directory } }))
        localStorage.setItem("opencode.global.dat:tabs", JSON.stringify([{ type: "session", server: "http://127.0.0.1:4096", dirBase64: encoded, sessionId: sessionID }]))
        localStorage.setItem("opencode.global.dat:layout", JSON.stringify({ dock: { schema: 2, right: { visible: true, size: 520, tabs: ["browser"], active: "browser" }, items: { session: { area: "middle", visible: true }, browser: { area: "right", visible: true } } } }))
      }, { directory, encoded, sessionID })
      await page.goto(`${baseURL}/${encoded}/session/${sessionID}`)
      await page.locator('[data-slot="browser-url"]').fill(url)
      await page.getByRole("button", { name: "Open", exact: true }).click()
      await expect.poll(() => app.evaluate(({ webContents }) => webContents.getAllWebContents().filter((guest) => guest.getType() === "webview").length)).toBe(1)
      const guestID = await app.evaluate(({ webContents }) => webContents.getAllWebContents().find((guest) => guest.getType() === "webview")!.id)
      await expect.poll(() => app.evaluate(({ webContents }, id) => webContents.fromId(id)?.getURL(), guestID)).toBe(`${url}/`)
      await app.evaluate(async ({ webContents }, { id, url }) => {
        const guest = webContents.fromId(id)!
        await guest.executeJavaScript(`location.href=${JSON.stringify(`${url}/next`)}`)
      }, { id: guestID, url })
      await expect.poll(() => app.evaluate(({ webContents }, id) => webContents.fromId(id)?.getURL(), guestID)).toBe(`${url}/next`)
      await app.evaluate(async ({ webContents }, id) => {
        await webContents.fromId(id)!.executeJavaScript("document.querySelector('input').value='kept'")
      }, guestID)
      const loadID = await app.evaluate(({ webContents }, id) => webContents.fromId(id)!.executeJavaScript("window.loadID"), guestID)
      await page.getByRole("button", { name: "Dock", exact: true }).click()
      await page.getByLabel("Name", { exact: true }).fill("Desktop live")
      await app.evaluate(() => {
        const guard = Reflect.get(globalThis, "webDockFixtureGuard") as { beginAction(): () => void }
        Reflect.set(globalThis, "releaseFixtureAction", guard.beginAction())
      })
      await page.getByRole("button", { name: "Save", exact: true }).click()
      await expect(page.getByText(/Browser is already being used or transferred/)).toBeVisible()
      await expect(page.locator('[data-component="session-web-dock"]')).toHaveCount(0)
      expect(await app.evaluate(({ webContents }, id) => webContents.fromId(id)!.executeJavaScript("document.querySelector('input').value"), guestID)).toBe("kept")
      await app.evaluate(() => {
        const release = Reflect.get(globalThis, "releaseFixtureAction") as () => void
        release()
      })
      await page.getByRole("button", { name: "Save", exact: true }).click()
      await expect(page.locator('[data-component="session-web-dock"]')).toBeVisible()
      const tab = page.locator('[data-dock-tab^="web-dock:"]').first()
      await expect.poll(() => app.evaluate(({ webContents }, id) => webContents.fromId(id)!.executeJavaScript("document.querySelector('input').value"), guestID)).toBe("kept")
      expect(await app.evaluate(({ webContents }, id) => webContents.fromId(id)!.executeJavaScript("window.loadID"), guestID)).toBe(loadID)
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem("opencode.global.dat:web-docks.v1") ?? "{}"))).toMatchObject({ version: 1, items: expect.any(Object) })
      expect(await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem("opencode.global.dat:web-docks.v1")!).items).map((item) => (item as { startURL: string }).startURL))).toEqual([`${url}/next`])
      expect(await app.evaluate((_, id) => {
        const guard = Reflect.get(globalThis, "webDockFixtureGuard") as { assertAccessible(id: number): void }
        try { guard.assertAccessible(id); return "accessible" } catch { return "blocked" }
      }, guestID)).toBe("blocked")
      await page.screenshot({ path: info.outputPath("web-dock-electron.png") })
      await tab.getByRole("button", { name: "More options", exact: true }).click()
      await page.getByRole("menuitem", { name: "Return to browser", exact: true }).click()
      await expect(page.locator('[data-dock-tab^="web-dock:"]')).toHaveCount(0)
      expect(await app.evaluate((_, id) => {
        const guard = Reflect.get(globalThis, "webDockFixtureGuard") as { assertAccessible(id: number): void }
        guard.assertAccessible(id)
        return true
      }, guestID)).toBe(true)
      expect(await app.evaluate(({ webContents }, id) => webContents.fromId(id)!.executeJavaScript("window.loadID"), guestID)).toBe(loadID)
      await page.getByRole("button", { name: "Dock", exact: true }).click()
      await page.getByLabel("Name", { exact: true }).fill("Restored desktop")
      await page.getByRole("button", { name: "Save", exact: true }).click()
      await expect(page.locator('[data-component="session-web-dock"]')).toBeVisible()
      await page.reload()
      await expect(page.locator('[data-component="session-web-dock"]')).toBeVisible()
      await expect.poll(() => app.evaluate(({ webContents }) => webContents.getAllWebContents().filter((guest) => guest.getType() === "webview").length)).toBe(1)
      const restoredID = await app.evaluate(({ webContents }) => webContents.getAllWebContents().find((guest) => guest.getType() === "webview")!.id)
      expect(restoredID).not.toBe(guestID)
      await expect.poll(() => app.evaluate((_, id) => {
        const guard = Reflect.get(globalThis, "webDockFixtureGuard") as { assertAccessible(id: number): void }
        try { guard.assertAccessible(id); return "accessible" } catch { return "blocked" }
      }, restoredID)).toBe("blocked")
      // Hold an automation action exactly when the next restored guest appears.
      await app.evaluate(({ app }) => {
        app.once("web-contents-created", (_event, contents) => {
          if (contents.getType() !== "webview") return
          const guard = Reflect.get(globalThis, "webDockFixtureGuard") as { beginAction(): () => void }
          Reflect.set(globalThis, "releaseFixtureAction", guard.beginAction())
        })
      })
      await page.reload()
      await expect(page.locator('[data-component="session-web-dock"] [role="alert"]')).toBeVisible()
      await expect(page.locator('[data-slot="browser-frame"]:visible')).toHaveCount(0)
      await expect.poll(() => app.evaluate(({ webContents }) => webContents.getAllWebContents().filter((guest) => guest.getType() === "webview").length)).toBe(0)
      await app.evaluate(() => (Reflect.get(globalThis, "releaseFixtureAction") as () => void)())
      await page.getByRole("button", { name: "Open start address", exact: true }).click()
      await expect(page.locator('[data-slot="browser-frame"]:visible')).toHaveCount(1)
    } finally {
      await app.close()
    }
  } finally {
    await new Promise<void>((done) => website.close(() => done()))
    await rm(root, { recursive: true, force: true })
  }
})
