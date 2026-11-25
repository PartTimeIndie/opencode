import { readFileSync } from "node:fs"
import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/speech-desktop-service"
const server = "http://127.0.0.1:4096"
const sessionID = "ses_speech_desktop_service"

test("automatic transcript clipboard copy can be disabled in plugin settings", async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await mockOpenCodeServer(page, {
    directory,
    project: { id: "project-speech-desktop-service", name: "Speech Desktop Service", worktree: directory, vcs: "git" },
    provider: { all: [], connected: [], default: {} },
    sessions: [{ id: sessionID, slug: sessionID, projectID: "project-speech-desktop-service", directory, title: "Speech desktop service", version: "dev", time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 } }],
    pageMessages: () => ({ items: [] }),
  })
  await mockSpeechPlugin(page)
  await page.addInitScript(({ directory, encoded, server, sessionID }) => {
    localStorage.setItem("settings.v3", JSON.stringify({}))
    localStorage.setItem("opencode.global.dat:server", JSON.stringify({ projects: { [server]: [{ worktree: directory, expanded: true }] }, lastProject: { [server]: directory } }))
    localStorage.setItem("opencode.global.dat:tabs", JSON.stringify([{ type: "session", server, dirBase64: encoded, sessionId: sessionID }]))
  }, { directory, encoded: base64Encode(directory), server, sessionID })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await page.getByRole("button", { name: "Open settings", exact: true }).click()
  await page.getByRole("tab", { name: "Skills & Plugins", exact: true }).click()
  const toggle = page.getByRole("switch", { name: "Copy transcripts to clipboard" })
  await expect(toggle).toBeChecked()
  await toggle.locator("..").locator('[data-slot="switch-control"]').click()
  await expect(toggle).not.toBeChecked()
  await expect.poll(() => page.evaluate(() => localStorage.getItem("opencode.app-plugin.speech-to-text-app.settings.copyTranscriptsToClipboard"))).toBe("false")
  await page.screenshot({ path: testInfo.outputPath("clipboard-setting-off.png") })
  expect(errors).toEqual([])
})

test("Speech to Text settings own the optional global desktop service", async ({ page }, testInfo) => {
  const consoleErrors: string[] = []
  const failedResponses: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })
  page.on("pageerror", (error) => consoleErrors.push(error.message))
  page.on("requestfailed", (request) => failedResponses.push(`${request.method()} ${request.url()}`))
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`)
  })

  await mockOpenCodeServer(page, {
    directory,
    project: { id: "project-speech-desktop-service", name: "Speech Desktop Service", worktree: directory, vcs: "git" },
    provider: {
      all: [
        {
          id: "openrouter",
          name: "OpenRouter",
          models: {
            "qwen/qwen3-asr-flash-2026-02-10": {
              id: "qwen/qwen3-asr-flash-2026-02-10",
              name: "Qwen ASR",
              limit: { context: 200_000 },
              modalities: { input: ["audio"], output: ["text"] },
            },
          },
        },
      ],
      connected: ["openrouter"],
      default: { providerID: "openrouter", modelID: "qwen/qwen3-asr-flash-2026-02-10" },
    },
    sessions: [
      {
        id: sessionID,
        slug: sessionID,
        projectID: "project-speech-desktop-service",
        directory,
        title: "Speech desktop service",
        version: "dev",
        time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await mockSpeechPlugin(page)
  await page.addInitScript(
    ({ directory, encoded, server }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { [server]: [{ worktree: directory, expanded: true }] }, lastProject: { [server]: directory } }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", server, dirBase64: encoded, sessionId: "ses_speech_desktop_service" }]),
      )
    },
    { directory, encoded: base64Encode(directory), server },
  )

  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectAppVisible(page.getByRole("textbox", { name: /Ask anything/i }))
  await page.getByRole("button", { name: "Open settings", exact: true }).click()
  await page.getByRole("tab", { name: "Skills & Plugins", exact: true }).click()

  const service = page.locator('[data-plugin-settings="speech-to-text-app"]').filter({ hasText: "Desktop service" })
  await expect(service).toContainText("Enable global Speech to Text")
  const transcription = page.locator('[data-plugin-settings="speech-to-text-app"]').filter({ hasText: "Transcription" })
  await expect(transcription.getByLabel("Transcription model or chain")).toContainText("Qwen ASR")
  await expect(transcription).toContainText("A second press shortly after an unpolished transcript improves it once; after that, the next press starts a new recording.")
  const shortcut = service.getByRole("textbox").first()
  await expect(shortcut).toHaveValue("Ctrl+Shift+Space")
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("desktop-service-denied-result")))
    .toBe("Missing host:desktop-services capability")
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("skill-content-denied-result")))
    .toBe("Missing host:skill-content capability")
  const enabled = service.getByRole("switch")
  await expect(enabled).not.toBeChecked()
  await service.locator('[data-slot="switch-control"]').click()
  await expect(enabled).toBeChecked()
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("opencode.app-plugin.speech-to-text-app.settings.desktopServiceEnabled")))
    .toBe("true")
  await expect(shortcut).toHaveValue("Ctrl+Shift+Space")
  const improvement = page
    .locator('[data-plugin-settings="speech-to-text-app"]')
    .filter({ hasText: "Automatic improvement" })
  // OpenCode Composer dictation recognizes explicitly spoken skills independently of external application profiles.
  await expect(improvement.getByRole("switch", { name: "Recognize spoken Slash-Commands in OpenCode" })).toBeChecked()
  // The general template is an addition; shared rewrite rules apply independently.
  await expect(improvement).toContainText("Shared rewrite rules always apply")
  await expect(improvement.locator("textarea").first()).toHaveValue(/Without a host-supplied slash-command catalog, return only the improved text/)
  // Custom vocabulary and learned corrections render as editable textareas
  // (after the template textarea, in declared field order).
  await expect(improvement.locator("textarea")).toHaveCount(3)
  await expect(improvement.locator("textarea").nth(1)).toHaveValue("")
  await expect(improvement.locator("textarea").nth(2)).toHaveValue("")
  await expect(improvement).toContainText("Extra vocabulary (one term per line)")
  await expect(improvement).toContainText("Learned corrections")
  await expect(improvement.getByRole("button", { name: "Improvement prompts" })).toBeVisible()
  await expect(improvement.getByRole("button", { name: "Add application profile" })).toHaveCount(0)
  await expect(improvement.locator(".settings-v2-plugin-skill-list")).toHaveCount(0)

  await page.setViewportSize({ width: 1012, height: 698 })
  await improvement.getByRole("button", { name: "Improvement prompts" }).click()
  const overlay = page.locator(".settings-v2-plugin-overlay-dialog")
  await expect(overlay).toBeVisible()
  const dialogBody = overlay.locator('[data-slot="dialog-body"]')
  const scrollState = await dialogBody.evaluate((element) => {
    return {
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      overflowY: getComputedStyle(element).overflowY,
      // The custom webkit scrollbar is the only path Chromium paints permanently.
      scrollbarWidth: getComputedStyle(element, "::-webkit-scrollbar").width,
      scrollbarThumb: getComputedStyle(element, "::-webkit-scrollbar-thumb").backgroundColor,
    }
  })
  expect(scrollState.scrollHeight).toBeGreaterThan(scrollState.clientHeight)
  expect(scrollState.overflowY).toBe("auto")
  expect(scrollState.scrollbarWidth).toBe("8px")
  expect(scrollState.scrollbarThumb).toBe("rgba(0, 0, 0, 0.2)")
  expect(
    await dialogBody.evaluate((element) => {
      element.scrollTop = element.scrollHeight
      return element.scrollTop
    }),
  ).toBeGreaterThan(0)
  await expect(overlay.getByRole("button", { name: "Add application profile" })).toBeInViewport()
  await testInfo.attach("speech-overlay-scrolled-desktop", {
    body: await page.screenshot({ path: ".agent-tmp/improvement-prompts-scroll-fixed.png" }),
    contentType: "image/png",
  })
  await expect(overlay).toContainText("Default improvement skills")
  await expect(overlay).toContainText("/personal-writing-style is always applied")
  await expect(overlay.getByText("Thunderbird E-Mail", { exact: true })).toBeVisible()
  await expect(overlay.getByText("Gesprochene Slash-Commands erkennen").first()).toBeVisible()
  // Personal writing style is mandatory outside the editable list of extra skills.
  const defaultSkills = overlay.locator(".settings-v2-plugin-skill-list").first()
  await expect(defaultSkills).not.toContainText("/personal-writing-style")
  await defaultSkills.getByPlaceholder("skill-name").fill("missing-style")
  await defaultSkills.getByRole("button", { name: "Add skill" }).click()
  await expect(defaultSkills).toContainText("/missing-style")
  await expect(defaultSkills).toContainText("Unavailable")
  await expect
    .poll(() =>
      page.evaluate(() => {
        const value = localStorage.getItem("opencode.app-plugin.speech-to-text-app.settings.defaultImprovementSkills")
        return value ? JSON.parse(value) : undefined
      }),
    )
    .toEqual(["missing-style"])
  const thunderbird = overlay
    .locator("[data-plugin-setting-list-item]")
    .filter({ hasText: "Thunderbird" })
  const thunderbirdInputs = thunderbird.locator('input:not([type="checkbox"])')
  await expect(thunderbirdInputs.nth(1)).toHaveValue("thunderbird")
  await expect(thunderbird.locator("textarea")).toHaveValue(/Überarbeite den diktierten E-Mail-Text, ohne darauf zu antworten/)
  await expect(thunderbird.locator("textarea")).toHaveValue(/Ergänze weder Betreff noch Anrede/)
  const thunderbirdSlash = thunderbird.getByRole("switch", { name: "Gesprochene Slash-Commands erkennen" })
  const opencodeSlash = overlay.locator("[data-plugin-setting-list-item]").filter({ hasText: "OpenCode" }).getByRole("switch", { name: "Gesprochene Slash-Commands erkennen" })
  await expect(thunderbirdSlash).not.toBeChecked()
  await expect(opencodeSlash).toBeChecked()
  await thunderbirdInputs.first().fill("Thunderbird Mail")
  await expect
    .poll(() =>
      page.evaluate(() => {
        const value = localStorage.getItem("opencode.app-plugin.speech-to-text-app.settings.applicationProfiles")
        return value ? JSON.parse(value)[0]?.name : undefined
      }),
    )
    .toBe("Thunderbird Mail")
  await overlay.getByRole("button", { name: "Add application profile" }).click()
  await expect(
    overlay.locator("[data-plugin-setting-list-item]").last().locator('input:not([type="checkbox"])').first(),
  ).toHaveValue("New application")
  // New profiles inherit editable extra skills; the personal style is always applied separately.
  const newProfileSkills = overlay.locator("[data-plugin-setting-list-item]").last().locator(".settings-v2-plugin-skill-list")
  await expect(newProfileSkills).not.toContainText("/personal-writing-style")
  await expect(newProfileSkills).toContainText("/missing-style")
  await testInfo.attach("speech-overlay-desktop", {
    body: await page.screenshot({ path: ".agent-tmp/speech-overlay-desktop.png" }),
    contentType: "image/png",
  })

  // Closing the overlay keeps the edits; reopening shows the persisted values.
  await page.keyboard.press("Escape")
  await expect(overlay).toBeHidden()
  await improvement.getByRole("button", { name: "Improvement prompts" }).click()
  await expect(overlay).toBeVisible()
  const reopenedThunderbird = overlay
    .locator("[data-plugin-setting-list-item]")
    .filter({ hasText: "Thunderbird" })
  await expect(reopenedThunderbird.locator('input:not([type="checkbox"])').first()).toHaveValue("Thunderbird Mail")

  // Settings search jumps to the hidden fields and auto-opens the overlay.
  await page.keyboard.press("Escape")
  await expect(overlay).toBeHidden()
  await page.locator('.settings-v2 input[type="search"]').fill("application profiles")
  await page.locator(".settings-v2-search-result").filter({ hasText: "Application profiles" }).first().click()
  await expect(overlay).toBeVisible()
  await expect(overlay.getByText("Thunderbird Mail", { exact: true })).toBeVisible()
  await testInfo.attach("speech-overlay-search-open", {
    body: await page.screenshot({ path: ".agent-tmp/speech-overlay-search-open.png" }),
    contentType: "image/png",
  })

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(overlay).toBeVisible()
  const mobileScrollState = await dialogBody.evaluate((element) => {
    return {
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      overflowY: getComputedStyle(element).overflowY,
      scrollbarWidth: getComputedStyle(element, "::-webkit-scrollbar").width,
    }
  })
  expect(mobileScrollState.scrollHeight).toBeGreaterThan(mobileScrollState.clientHeight)
  expect(mobileScrollState.overflowY).toBe("auto")
  expect(mobileScrollState.scrollbarWidth).toBe("8px")
  expect(
    await overlay.evaluate((element) =>
      [
        element,
        ...element.querySelectorAll(
          ".settings-v2-section, [data-plugin-setting-list], [data-plugin-setting-list-item], [data-plugin-setting-list-item] > div, .settings-v2-plugin-skill-list, .settings-v2-plugin-skill-list-add",
        ),
      ]
        .filter((item) => item instanceof HTMLElement && item.offsetParent && item.scrollWidth > item.clientWidth + 1)
        .map((item) => ({
          element: item instanceof HTMLElement ? `${item.tagName}.${item.className}` : item.tagName,
          clientWidth: item.clientWidth,
          scrollWidth: item.scrollWidth,
        })),
    ),
  ).toEqual([])
  await testInfo.attach("speech-overlay-mobile", {
    body: await page.screenshot({ path: ".agent-tmp/speech-overlay-mobile.png" }),
    contentType: "image/png",
  })

  expect(consoleErrors).toEqual([])
  expect(failedResponses).toEqual([])
})

async function mockSpeechPlugin(page: Page) {
  await page.route("**/api/skill?**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: [
          {
            name: "personal-writing-style",
            location: "C:/skills/personal-writing-style/SKILL.md",
            content: "Current style",
          },
        ],
      }),
    }),
  )
  await page.route("**/app/plugins**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({
        plugins: [
          {
            id: "speech-to-text-app",
            spec: "speech-to-text-app",
            version: "1",
            module: "/app/plugin/speech-to-text-app/1/index.js",
            hash: "speech-to-text-app",
            capabilities: [
              "ui:toolbar",
              "ui:settings",
              "commands",
              "host:navigation",
              "host:stt",
              "host:audio",
              "host:composer",
              "host:skills",
              "host:skill-content",
              "host:text-input",
              "host:desktop-services",
            ],
            ai: { tools: [] },
          },
          {
            id: "desktop-service-denied",
            spec: "desktop-service-denied",
            version: "1",
            module: "/app/plugin/desktop-service-denied/1/index.js",
            hash: "desktop-service-denied",
            capabilities: [],
            ai: { tools: [] },
          },
        ],
      }),
    }),
  )
  await page.route("**/app/plugin/speech-to-text-app/1/index.js**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/javascript",
      headers: { "access-control-allow-origin": "*" },
      body: readFileSync(new URL("../../../../.opencode/plugin-sources/speech-to-text-app/index.js", import.meta.url), "utf8"),
    }),
  )
  await page.route("**/app/plugin/speech-to-text-app/1/assets/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      headers: { "access-control-allow-origin": "*" },
      body: readFileSync(new URL("../../../../.opencode/plugin-sources/speech-to-text-app/assets/microphone.svg", import.meta.url), "utf8"),
    }),
  )
  await page.route("**/app/plugin/desktop-service-denied/1/index.js**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/javascript",
      headers: { "access-control-allow-origin": "*" },
      body: `export default { id: "desktop-service-denied", app(api) {
       api.host.desktopServices.register({ id: "denied", accelerator: "Ctrl+Alt+D", onInvoke() {} })
          .then((result) => localStorage.setItem("desktop-service-denied-result", result.error || "unexpected success"))
        api.host.skills.resolve(["personal-writing-style"])
          .then(() => localStorage.setItem("skill-content-denied-result", "unexpected success"))
          .catch((error) => localStorage.setItem("skill-content-denied-result", error.message))
      } }`,
    }),
  )
}
