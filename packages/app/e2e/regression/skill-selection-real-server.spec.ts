import { expect, test } from "@playwright/test"
import { spawn, execFileSync } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { trackPageErrors, trackNetworkFailures } from "../utils/errors"

const plugin = `export default { id: "skill-qa", app(api) {
  api.toolbar.register({ id: "manual", title: "QA manual skill", placement: "composer", align: "right", defaultVisible: true,
    icon: { name: "code" }, skill: { name: "manual-flow" }, appendOnSubmit: true })
} }`

test.setTimeout(240000)
test.use({ viewport: { width: 1280, height: 720 }, screenshot: "on" })

test("real skill gate accepts slash and toolbar submissions, preserves Ask consent and Deny after reload", async ({ page }, testInfo) => {
  const bun = process.platform === "win32"
    ? execFileSync("where.exe", ["bun"], { encoding: "utf8" }).split(/\r?\n/)[0]!.trim() : "bun"
  const child = spawn(bun, [path.resolve(import.meta.dirname, "../utils/skill-selection.worker.ts")], {
    cwd: path.resolve(import.meta.dirname, "../.."), windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  })
  let diagnostics = ""
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk: string) => { diagnostics = `${diagnostics}${chunk}`.slice(-8000) })
  let ready: { root: string; worktree: string; serverUrl: string; sessionID: string } | undefined
  try {
    ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`QA worker not ready: ${diagnostics}`)), 125000)
      let output = ""
      child.stdout.setEncoding("utf8")
      child.stdout.on("data", (chunk: string) => {
        output += chunk
        const match = /__SKILL_READY__(.+)/.exec(output)
        if (match) { clearTimeout(timer); resolve(JSON.parse(match[1]!)) }
      })
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`QA worker exited ${code}: ${diagnostics}`)) })
    })
    const errors = trackPageErrors(page)
    const network = trackNetworkFailures(page)
    // The dev app also probes its configured default connection. Redirect that
    // transport to the same real isolated backend, never an installed user's server.
    const defaultOrigin = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
    const isolatedOrigin = ready.serverUrl
    await page.route(`${defaultOrigin}/**`, (route) => route.continue({
      url: route.request().url().replace(defaultOrigin, isolatedOrigin),
    }))
    // Only provide a synthetic toolbar registration. All session/permission/tool HTTP is real.
    await page.route("**/app/plugins**", (route) => route.fulfill({ json: { plugins: [{
      id: "skill-qa", spec: "skill-qa", version: "1", hash: "skill-qa-1", module: "/app/plugin/skill-qa/1/index.js",
      capabilities: ["ui:toolbar", "host:composer"],
    }] }, headers: { "access-control-allow-origin": "*" } }))
    await page.route("**/app/plugin/skill-qa/1/index.js**", (route) => route.fulfill({
      contentType: "text/javascript", body: plugin, headers: { "access-control-allow-origin": "*" },
    }))
    const dirBase64 = base64Encode(ready.worktree)
    await page.addInitScript(({ worktree, serverUrl, sessionID, dirBase64 }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem("opencode.global.dat:language", JSON.stringify({ locale: "en" }))
      localStorage.setItem("opencode.settings.dat:defaultServerUrl", serverUrl)
      localStorage.setItem("opencode.global.dat:server", JSON.stringify({
        list: [serverUrl], projects: { local: [{ worktree, expanded: true }], [serverUrl]: [{ worktree, expanded: true }] },
        lastProject: { local: worktree, [serverUrl]: worktree },
      }))
      localStorage.setItem("opencode.global.dat:tabs", JSON.stringify([{ type: "session", server: serverUrl, dirBase64, sessionId: sessionID }]))
    }, { ...ready, dirBase64 })
    // Finish the finite command-catalog bootstrap before deliberately reloading.
    // A visible composer alone does not mean its catalog request has settled.
    const commandDirectory = ready.worktree
    const commandBootstrap = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return url.pathname === "/api/command" && url.searchParams.get("directory") === commandDirectory
    }, { timeout: 60000 })
    await page.goto(`/${dirBase64}/session/${ready.sessionID}`, { waitUntil: "commit" })
    const composer = page.locator('[data-component="session-composer"]')
    await expect(composer).toBeVisible({ timeout: 90000 })
    const editor = composer.getByRole("textbox")
    const toggle = page.locator('[data-plugin-toolbar-item="skill-qa/manual"]')
    await expect(toggle).toBeVisible()
    await editor.fill("Please check these skills\n\n/manual-flow\n\n/ask-flow")
    await editor.press("Escape")
    await editor.press("Enter")
    await expect(page.getByText("QA_DONE_manual-flow", { exact: true })).toBeVisible({ timeout: 60000 })
    // Tool content is collapsed in the timeline; inspect the real provider's tool result.
    expect(await readFile(path.join(ready.root, "requests.json"), "utf8")).toContain("LOADED_manual-flow")
    const lifecycleAborts: string[] = []
    const collectPollCancellations = () => {
      for (let i = network.length - 1; i >= 0; i--) {
        const failure = network[i]!
        const request = failure.split(" ")
        if (request[0] !== "GET" || request[2] !== "net::ERR_ABORTED") continue
        const url = new URL(request[1]!)
        if (url.origin !== isolatedOrigin && url.origin !== defaultOrigin) continue
        if (url.pathname !== `/api/session/${ready!.sessionID}/held-inputs`) continue
        lifecycleAborts.push(...network.splice(i, 1))
      }
    }
    const commands = await commandBootstrap
    expect(commands.ok()).toBe(true)
    expect(await commands.finished()).toBeNull()
    collectPollCancellations()
    expect(network).toEqual([])
    await page.reload({ waitUntil: "commit" })
    await expect(composer).toBeVisible()
    // Reload intentionally cancels the old SSE and any in-flight project-state sync.
    // Keep these exact navigation cancellations separate; never ignore HTTP errors or prompt failures.
    collectPollCancellations()
    const reloadAborts = network.splice(0)
    for (const failure of reloadAborts) expect([isolatedOrigin, defaultOrigin].flatMap((origin) => [
      `GET ${origin}/global/event net::ERR_ABORTED`,
      `PUT ${origin}/app/state/server-projects.v1 net::ERR_ABORTED`,
      `POST ${origin}/perf/record net::ERR_ABORTED`,
    ])).toContain(failure)
    for (const submit of ["enter", "send"]) {
      await editor.pressSequentially(`Toolbar ${submit} selection`, { delay: 20 })
      await toggle.click()
      await expect(toggle).toHaveAttribute("aria-pressed", "true")
      await expect(editor).toHaveText(`Toolbar ${submit} selection`)
      const admitted = page.waitForRequest((request) => request.method() === "POST" && /\/api\/session\/[^/]+\/prompt/.test(request.url()), { timeout: 15000 })
      if (submit === "enter") await editor.press("Enter")
      else await composer.getByRole("button", { name: /Send/i }).click()
      expect((await admitted).postData()).toContain("/manual-flow")
      await expect(toggle).toHaveAttribute("aria-pressed", "false")
      await expect(page.getByText("QA_DONE_manual-flow", { exact: true })).toHaveCount(submit === "enter" ? 2 : 3, { timeout: 60000 })
    }
    await editor.fill("Please use /ask-flow explicitly")
    await editor.press("Enter")
    await expect(page.getByText("QA_DONE_ask-flow", { exact: true })).toBeVisible({ timeout: 60000 })
    await editor.fill("Please use /denied-flow explicitly")
    await editor.press("Enter")
    await expect(page.getByText("QA_DONE_denied-flow", { exact: true })).toBeVisible({ timeout: 60000 })
    const requests = await readFile(path.join(ready.root, "requests.json"), "utf8")
    expect(requests).toContain("LOADED_manual-flow")
    expect(requests).toContain("LOADED_ask-flow")
    expect(requests).toContain("blocked by configuration")
    expect(requests).not.toContain("LOADED_denied-flow")
    expect(requests).not.toContain("requires an explicit /manual-flow invocation")
    await page.screenshot({ path: testInfo.outputPath("skill-selection.png"), fullPage: true })
    collectPollCancellations()
    expect(errors).toEqual([])
    expect(network).toEqual([])
    await writeFile(testInfo.outputPath("acceptance.json"), JSON.stringify({ sourceOnly: true, scriptedLocalProvider: true,
      syntheticToolbarRegistration: true, slash: true, toolbarEnter: true, toolbarSend: true, askConsent: true, deny: true, reload: true, reloadAborts, lifecycleAborts, errors, network }))
  } finally {
    await mkdir(testInfo.outputDir, { recursive: true })
    if (ready) for (const file of ["server.log", "requests.json"]) {
      await writeFile(testInfo.outputPath(file), await readFile(path.join(ready.root, file), "utf8").catch(() => "unavailable"))
    }
    await writeFile(testInfo.outputPath("worker-stderr.log"), diagnostics)
    child.stdin.end()
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve()
      const timer = setTimeout(() => { child.kill(); resolve() }, 10000)
      child.once("exit", () => { clearTimeout(timer); resolve() })
    })
  }
})
