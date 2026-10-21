import { expect, test } from "@playwright/test"
import { readFileSync } from "node:fs"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"

const directory = "C:/OpenCode/SpokenSummaryQA"
const projectID = "proj_spoken_summary"
const a = "ses_spoken_a"
const b = "ses_spoken_b"
const root = new URL("../../../../.opencode/plugin-sources/spoken-summary-app/", import.meta.url)
const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8"))
const summary = "Die Tests sind grün, aber die Desktop-App ist noch nicht aktualisiert. Für den Neustart brauche ich deine Freigabe."
test.use({ video: "on" })

for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
  test.describe(`${viewport.width}px`, () => {
    test.use({ viewport })
    test("manual summary, audio, tab-independent stop and replacement", async ({ page }, info) => {
      const errors: string[] = []
      const failures: string[] = []
      const spoken: string[] = []
      const contexts: string[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      page.on("response", (response) => { if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`) })
      const session = (id: string, title: string) => ({ id, slug: id, projectID, directory, title, version: "dev", time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 } })
      await mockOpenCodeServer(page, {
        directory, project: { id: projectID, worktree: directory, vcs: "git", name: "Summary QA", time: { created: 1, updated: 1 }, sandboxes: [] },
        sessions: [session(a, "Summary A"), session(b, "Summary B")], pageMessages: () => ({ items: [] }),
        provider: { all: [{ id: "test", name: "Test", models: {
          summary: { id: "summary", name: "Summary model", capabilities: { input: { text: true }, output: { text: true } }, limit: { context: 32_000, output: 8192 } },
          speech: { id: "speech", name: "Speech model", capabilities: { input: { text: true }, output: { speech: true } }, limit: { context: 4000 } },
        } }], connected: ["test"], default: { test: "summary" } },
        onAppHostAIRun: () => ({ ok: true, text: summary }),
      })
      await page.route("**/app/plugins**", (route) => route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ plugins: [{ id: manifest.name, spec: manifest.name, version: "1", hash: "spoken-summary", capabilities: manifest.opencode.app.capabilities, module: "/app/plugin/spoken-summary-app/1/index.js" }] }) }))
      for (const file of ["index.js", "core.js", "playback.js", "assets/spoken-summary.svg"]) await page.route(`**/app/plugin/spoken-summary-app/1/${file}**`, (route) => route.fulfill({ status: 200, contentType: file.endsWith(".svg") ? "image/svg+xml" : "text/javascript", headers: { "access-control-allow-origin": "*" }, body: readFileSync(new URL(file, root), "utf8") }))
      await page.route("**/app/host/session-context**", (route) => {
        const input = route.request().postDataJSON()
        contexts.push(input.sessionID)
        expect(input.caller.id).toBe("spoken-summary-app")
        expect(input.limit).toBeLessThanOrEqual(200)
        return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*", "cache-control": "no-store" }, body: JSON.stringify({ ok: true, context: {
          version: 1, capturedAt: 1, fingerprint: `stable-${input.sessionID}`, session: { id: input.sessionID, directory, title: input.sessionID },
          activity: { status: "completed", working: false }, selection: "activity", boundaryComplete: true,
          messages: [{ id: "msg_a", role: "assistant", text: "Tests bestanden. Noch kein Desktop-Deploy.", createdAt: 1, complete: true }],
          pending: { questions: [{ id: "que_a", revision: 1, items: [{ text: "Neustart freigeben?", context: "", options: [], fields: [] }] }], permissions: [], controls: [] },
          totals: { messages: 1, textChars: 50, questions: 1, permissions: 0, controls: 0 }, truncated: { messages: false, text: false, pending: false },
        } }) })
      })
      await page.route("**/app/host/tts/speech**", (route) => {
        spoken.push(route.request().postDataJSON().text)
        return route.fulfill({ status: 200, contentType: "audio/pcm", body: Buffer.alloc(24_000 * 2 * 12), headers: {
          "access-control-allow-origin": "*", "x-opencode-tts-format": "pcm", "x-opencode-tts-sample-rate": "24000", "x-opencode-tts-channels": "1", "x-opencode-tts-voice": "fixture",
          "access-control-expose-headers": "x-opencode-tts-format,x-opencode-tts-sample-rate,x-opencode-tts-channels,x-opencode-tts-voice",
        } })
      })
      await page.addInitScript(({ directory, ids, base }) => {
        localStorage.setItem("settings.v3", "{}")
        localStorage.setItem("opencode.app-plugin.spoken-summary-app.settings.summaryTarget", JSON.stringify("model:test/summary"))
        localStorage.setItem("opencode.app-plugin.spoken-summary-app.settings.speechTarget", JSON.stringify("model:test/speech"))
        const server = "http://127.0.0.1:4096"
        localStorage.setItem("opencode.global.dat:server", JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] }, lastProject: { local: directory } }))
        localStorage.setItem("opencode.global.dat:tabs", JSON.stringify(ids.map((sessionId) => ({ type: "session", server, dirBase64: base, sessionId }))))
        localStorage.setItem("opencode.global.dat:tabs.recent", JSON.stringify({ key: `${server}\n${base}\n${ids[0]}` }))
      }, { directory, ids: [a, b], base: base64Encode(directory) })
      await page.goto(`/${base64Encode(directory)}/session/${a}`)
      const listen = page.locator('[data-action="spoken-summary-listen"]').first()
      const stop = page.locator('[data-action="spoken-summary-stop"]').first()
      await expect(listen).toBeVisible()
      expect(spoken).toEqual([])
      await listen.click()
      await expect(page.locator('.oc-spoken-summary[data-phase="speaking"]').first()).toBeVisible()
      expect(spoken).toEqual([summary])
      await page.screenshot({ path: info.outputPath("summary-speaking.png"), fullPage: true })
      if (viewport.width >= 1280) {
        await page.getByRole("tab", { name: "Summary B", exact: true }).click()
      } else {
        // Mobile layout has no tab bar; sessions switch through the sidebar drawer.
        await page.getByRole("button", { name: "Projects and sessions" }).click()
        await page.getByRole("link", { name: "Summary B" }).click()
      }
      await expect(page.locator('.oc-spoken-summary[data-phase="speaking"]').first()).toBeVisible()
      await expect(stop).toBeVisible()
      await listen.click()
      await expect.poll(() => spoken.length).toBe(2)
      await expect(page.locator('.oc-spoken-summary[data-phase="speaking"]').first()).toBeVisible()
      expect(contexts).toContain(b)
      await stop.click()
      await expect(stop).toBeHidden()
      await expect(page.locator('.oc-spoken-summary[data-phase="idle"]').first()).toBeVisible()
      await page.screenshot({ path: info.outputPath("summary-stopped.png"), fullPage: true })
      const box = await listen.boundingBox()
      expect(box).not.toBeNull()
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport.width)
      expect(errors).toEqual([])
      expect(failures).toEqual([])
      await info.attach("summary-evidence", { body: JSON.stringify({ spoken, contexts, errors, failures, viewport, audio: "Real WebAudio scheduling of silent deterministic PCM fixture; NOT live TTS speech evidence" }, null, 2), contentType: "application/json" })
    })
  })
}
