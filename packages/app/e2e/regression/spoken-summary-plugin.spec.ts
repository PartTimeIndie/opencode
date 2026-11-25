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
      const requests: { model?: string; chain?: { steps: { providerID: string; modelID: string }[] }; voice: string; voices: Record<string, string> }[] = []
      const contexts: string[] = []
      const target = viewport.width === 390 ? "chain:speech-chain" : "model:test/speech"
      const german = "de-DE-Klaus:MAI-Voice-2"
      const english = "en-US-Harper:MAI-Voice-2"
      const settingsKey = "opencode.app-plugin.spoken-summary-app.settings."
      const overrides = [{ model: "test/speech", voice: english }]
      const events: unknown[] = []
      let catalogueExpanded = false
      page.on("pageerror", (error) => errors.push(error.message))
      page.on("response", (response) => { if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`) })
      const session = (id: string, title: string) => ({ id, slug: id, projectID, directory, title, version: "dev", time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 } })
      await mockOpenCodeServer(page, {
        directory, project: { id: projectID, worktree: directory, vcs: "git", name: "Summary QA", time: { created: 1, updated: 1 }, sandboxes: [] },
        sessions: [session(a, "Summary A"), session(b, "Summary B")], pageMessages: () => ({ items: [] }),
        provider: { all: [{ id: "test", name: "Test", models: {
          summary: { id: "summary", name: "Summary model", capabilities: { input: { text: true }, output: { text: true } }, limit: { context: 32_000, output: 8192 } },
          speech: { id: "speech", name: "Speech model", get supported_voices() { return [german, english, "alloy", ...(catalogueExpanded ? ["it_IT_Lucia"] : [])] }, capabilities: { input: { text: true }, output: { speech: true } }, limit: { context: 4000 } },
          second: { id: "second", name: "Second speech", supported_voices: [german, "fr_FR_Marie"], capabilities: { input: { text: true }, output: { speech: true } }, limit: { context: 4000 } },
        } }], connected: ["test"], default: { test: "summary" } },
        globalConfig: () => ({ model_chains: [{ id: "speech-chain", name: "Speech TTS", steps: [{ providerID: "test", modelID: "speech" }, { providerID: "test", modelID: "second" }] }] }),
        onAppHostAIRun: () => ({ ok: true, text: summary }),
        globalEvents: () => events.splice(0),
        eventRetry: 50,
        eventDelay: 50,
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
        requests.push(route.request().postDataJSON())
        return route.fulfill({ status: 200, contentType: "audio/pcm", body: Buffer.alloc(24_000 * 2 * 12), headers: {
          "access-control-allow-origin": "*", "x-opencode-tts-format": "pcm", "x-opencode-tts-sample-rate": "24000", "x-opencode-tts-channels": "1", "x-opencode-tts-voice": "fixture",
          "access-control-expose-headers": "x-opencode-tts-format,x-opencode-tts-sample-rate,x-opencode-tts-channels,x-opencode-tts-voice",
        } })
      })
      await page.addInitScript(({ directory, ids, base, target, overrides, settingsKey }) => {
        localStorage.setItem("settings.v3", "{}")
        localStorage.setItem("opencode.app-plugin.spoken-summary-app.settings.summaryTarget", JSON.stringify("model:test/summary"))
        if (!localStorage.getItem(`${settingsKey}speechTarget`)) localStorage.setItem(`${settingsKey}speechTarget`, JSON.stringify(target))
        if (!localStorage.getItem(`${settingsKey}voice`)) localStorage.setItem(`${settingsKey}voice`, JSON.stringify("retired-voice"))
        if (!localStorage.getItem(`${settingsKey}voiceOverrides`)) localStorage.setItem(`${settingsKey}voiceOverrides`, JSON.stringify(overrides))
        const server = "http://127.0.0.1:4096"
        localStorage.setItem("opencode.global.dat:server", JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] }, lastProject: { local: directory } }))
        localStorage.setItem("opencode.global.dat:tabs", JSON.stringify(ids.map((sessionId) => ({ type: "session", server, dirBase64: base, sessionId }))))
        localStorage.setItem("opencode.global.dat:tabs.recent", JSON.stringify({ key: `${server}\n${base}\n${ids[0]}` }))
      }, { directory, ids: [a, b], base: base64Encode(directory), target, overrides, settingsKey })
      await page.goto(`/${base64Encode(directory)}/session/${a}`)
      const listen = page.locator('[data-action="spoken-summary-listen"]').first()
      const stop = page.locator('[data-action="spoken-summary-stop"]').first()
      await expect(listen).toBeVisible()
      expect(spoken).toEqual([])
      await page.getByRole("button", { name: "Open settings", exact: true }).click()
      await page.getByRole("tab", { name: "Skills & Plugins", exact: true }).click()
      const speechSettings = page.locator('[data-plugin-settings="spoken-summary-app"]').filter({ has: page.getByRole("heading", { name: "Kurz anhören · Sprachausgabe", exact: true }) })
      const picker = speechSettings.getByRole("group", { name: "Stimme", exact: true }).getByRole("button")
      await expect(picker).toBeVisible()
      await expect(picker).toContainText("retired-voice")
      await expect(speechSettings).toContainText("Anbieterstandard")
      const saved = (key: string) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), `${settingsKey}${key}`)
      expect(await saved("voice")).toBe("retired-voice")
      expect(spoken).toEqual([])
      const externalSetting = (key: string, value: string) => page.evaluate(({ key, value, settingsKey }) => {
        localStorage.setItem(`${settingsKey}${key}`, JSON.stringify(value))
        window.dispatchEvent(new CustomEvent("opencode:app-plugin-settings", { detail: { pluginID: "spoken-summary-app", key } }))
      }, { key, value, settingsKey })
      await externalSetting("speechTarget", "model:test/second")
      await externalSetting("language", "fr")
      await expect(speechSettings.locator("[data-voice-picker]")).toContainText("Zusammenfassung: fr")
      await picker.click()
      await expect(page.getByRole("option").filter({ hasText: "fr_FR_Marie" })).toBeVisible()
      await expect(page.getByRole("option").filter({ hasText: "alloy" })).toHaveCount(0)
      // The settings dialog owns Escape globally; reopening must preserve the voice.
      await page.keyboard.press("Escape")
      await expect(page.getByRole("dialog")).toBeHidden()
      expect(await saved("voice")).toBe("retired-voice")
      await page.getByRole("button", { name: "Open settings", exact: true }).click()
      await page.getByRole("tab", { name: "Skills & Plugins", exact: true }).click()
      await externalSetting("speechTarget", target)
      await externalSetting("language", "de")
      await picker.focus()
      await page.keyboard.press("ArrowDown")
      await expect(page.getByRole("option").filter({ hasText: english })).toBeVisible()
      expect(await page.getByRole("option").evaluateAll((nodes) => nodes.every((node) => !node.closest('[aria-hidden="true"]')))).toBe(true)
      await expect(page.getByRole("option").filter({ hasText: english })).toBeVisible()
      await expect(page.getByRole("option").filter({ hasText: /alloy.*unbekannt/ })).toBeVisible()
      const menu = page.locator(".settings-voice-menu")
      await expect.poll(() => menu.evaluate((node) => getComputedStyle(node).opacity)).toBe("1")
      expect(await menu.evaluate((node) => getComputedStyle(node).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)")
      const menuBox = await menu.boundingBox()
      expect(menuBox!.x).toBeGreaterThanOrEqual(0)
      expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(viewport.width)
      await page.screenshot({ path: info.outputPath("voice-dropdown-open.png"), fullPage: true, animations: "disabled" })
      await page.getByRole("option").filter({ hasText: german }).click()
      await expect.poll(() => saved("voice")).toBe(german)
      await picker.click()
      await page.getByRole("option").filter({ hasText: "Eigene Stimmen-ID …" }).click()
      await speechSettings.getByRole("textbox", { name: "Eigene Stimmen-ID", exact: true }).fill("do-not-save")
      await speechSettings.getByRole("button", { name: "Abbrechen", exact: true }).click()
      expect(await saved("voice")).toBe(german)
      await picker.click()
      await page.getByRole("option").filter({ hasText: "Eigene Stimmen-ID …" }).click()
      const customVoice = speechSettings.getByRole("textbox", { name: "Eigene Stimmen-ID", exact: true })
      await customVoice.fill("my-custom-voice")
      await externalSetting("language", "fr")
      await expect(customVoice).toHaveValue("my-custom-voice")
      await externalSetting("speechTarget", "model:test/second")
      await expect(customVoice).toHaveValue("my-custom-voice")
      expect(await saved("voice")).toBe(german)
      await externalSetting("speechTarget", target)
      await externalSetting("language", "de")
      await expect(customVoice).toHaveValue("my-custom-voice")
      catalogueExpanded = true
      const catalogueRefresh = page.waitForResponse((response) => new URL(response.url()).pathname === "/provider")
      events.push({ directory, payload: { type: "server.instance.disposed", properties: {} } })
      await catalogueRefresh
      await picker.click()
      await expect(page.getByRole("option").filter({ hasText: "it_IT_Lucia" })).toBeVisible()
      await page.getByRole("option").filter({ hasText: german }).click()
      await expect(customVoice).toHaveValue("my-custom-voice")
      expect(await saved("voice")).toBe(german)
      await speechSettings.getByRole("button", { name: "Übernehmen", exact: true }).click()
      await expect.poll(() => saved("voice")).toBe("my-custom-voice")
      await picker.click()
      await page.getByRole("option").filter({ hasText: german }).click()
      await expect.poll(() => saved("voice")).toBe(german)
      await page.reload()
      await expect(listen).toBeVisible()
      await page.getByRole("button", { name: "Open settings", exact: true }).click()
      await page.getByRole("tab", { name: "Skills & Plugins", exact: true }).click()
      await expect(picker).toContainText(german)
      expect(await saved("speechTarget")).toBe(target)
      expect(await saved("voiceOverrides")).toEqual(overrides)
      expect(spoken).toEqual([])
      await picker.scrollIntoViewIfNeeded()
      await page.screenshot({ path: info.outputPath("voice-settings-selected.png"), fullPage: true, animations: "disabled" })
      const pickerBox = await picker.boundingBox()
      expect(pickerBox).not.toBeNull()
      expect(pickerBox!.x + pickerBox!.width).toBeLessThanOrEqual(viewport.width)
      await page.keyboard.press("Escape")
      await listen.click()
      await expect(page.locator('.oc-spoken-summary[data-phase="speaking"]').first()).toBeVisible()
      expect(spoken).toEqual([summary])
      expect(requests[0].voice).toBe(german)
      expect(requests[0].voices).toEqual({ "test/speech": english })
      if (target.startsWith("chain:")) expect(requests[0].chain?.steps).toEqual([{ providerID: "test", modelID: "speech" }, { providerID: "test", modelID: "second" }])
      else expect(requests[0].model).toBe("test/speech")
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
