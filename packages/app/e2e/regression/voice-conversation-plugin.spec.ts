import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { readFileSync } from "node:fs"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectNoSmokeErrors, trackPageErrors } from "../utils/errors"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/VoiceConversation"
const projectID = "proj_voice_conversation"
const sessionID = "ses_voice_page"
const voiceSessionID = "ses_voice_moderator"
const otherSessionID = "ses_voice_other"

test.use({ video: "on" })

test("voice floating preserves normal session navigation, audio and single-use worker approvals", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000)
  const errors = trackPageErrors(page)
  const requests: { sessionID: string; before?: string; limit: number; phase: "start" | "end" }[] = []
  const history = Array.from({ length: 170 }, (_, turn) =>
    ["user", "assistant"].map((role, offset) => ({
      info: {
        id: `msg_history_${String(turn * 2 + offset).padStart(4, "0")}`,
        role,
        sessionID: voiceSessionID,
        agent: "voice-moderator",
        providerID: "openai",
        modelID: "gpt-5.6-sol",
        time: {
          created: 1_700_000_000_000 + turn * 10_000 + offset * 1_000,
          completed: 1_700_000_000_000 + turn * 10_000 + 2_000,
        },
      },
      parts: [
        {
          id: `txt_history_${turn}_${role}`,
          type: "text",
          text: `Historical ${role} turn ${turn}. This text must remain available without being spoken again.`,
        },
      ],
    })),
  ).flat()
  expect(history.filter((message) => message.info.role === "user")).toHaveLength(170)
  const failedResponses: string[] = []
  const replies: unknown[] = []
  const spoken: string[] = []
  const transcript = Promise.withResolvers<string>()
  const transcriptionQueue: string[] = []
  let transcriptionRequests = 0
  const events: unknown[] = [
    event("permission.v2.asked", {
      id: "per_voice_once",
      sessionID,
      action: "write",
      resources: ["notes.md"],
      save: [],
      metadata: { "$opencode.permission.single_use": true },
    }),
  ]
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`)
  })

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "voice-conversation",
      time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "openrouter",
          name: "OpenRouter",
          models: {
            "openai/gpt-4o-mini-tts-2025-12-15": {
              id: "openai/gpt-4o-mini-tts-2025-12-15",
              name: "GPT-4o mini TTS",
              capabilities: { input: { text: true }, output: { speech: true } },
              limit: { context: 4_000 },
            },
          },
        },
      ],
      connected: ["openrouter"],
      default: { providerID: "openrouter", modelID: "openai/gpt-4o-mini-tts-2025-12-15" },
    },
    agents: [
      { name: "build", mode: "primary" },
      { name: "voice-moderator", mode: "primary", hidden: true },
    ],
    sessions: [session(), voiceSession(), otherSession()],
    pageMessages: (id, limit, before) => {
      if (id !== voiceSessionID) return { items: [] }
      const end = before ? history.findIndex((message) => message.info.id === before) : history.length
      expect(end).toBeGreaterThanOrEqual(0)
      const start = Math.max(0, end - limit)
      return { items: history.slice(start, end), cursor: start > 0 ? history[start].info.id : undefined }
    },
    onMessages: (input) => {
      requests.push(input)
    },
    eventDelay: 5_000,
    eventRetry: 75,
    globalEvents: () => events.splice(0),
    events: () => [],
    onPermissionReply: (input) => {
      replies.push(input)
      events.push(
        event("permission.v2.replied", { sessionID: input.sessionID, requestID: input.requestID, reply: "once" }),
      )
      return { ok: true }
    },
  })
  await mockVoicePlugin(page)
  await page.route("**/app/host/stt/transcribe**", async (route) => {
    transcriptionRequests += 1
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        text: transcriptionQueue.shift() ?? (transcriptionRequests <= 3 ? "Continuous quiet speech stays in one turn." : await transcript.promise),
      }),
    })
  })
  await page.route("**/plugins/voice-conversation-app/services/session-links**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { link: { sourceSessionID: voiceSessionID, targetSessionID: sessionID }, model: { id: "test", providerID: "test" } } }),
    }),
  )
  await page.route("**/app/host/tts/speech**", (route) => {
    spoken.push(route.request().postDataJSON().text)
    const pcm = Buffer.alloc(24_000)
    for (let sample = 0; sample < pcm.length / 2; sample++)
      pcm.writeInt16LE(Math.round(Math.sin((sample * 2 * Math.PI * 440) / 24_000) * 8_000), sample * 2)
    return route.fulfill({ status: 200, contentType: "audio/pcm", body: pcm, headers: {
      "x-opencode-tts-format": "pcm", "x-opencode-tts-sample-rate": "24000", "x-opencode-tts-channels": "1",
      "x-opencode-tts-voice": "test",
      "access-control-expose-headers": "x-opencode-tts-format, x-opencode-tts-sample-rate, x-opencode-tts-channels, x-opencode-tts-voice",
    } })
  })
  await page.addInitScript(() => {
    const create = AudioContext.prototype.createBufferSource
    AudioContext.prototype.createBufferSource = function () {
      const source = create.call(this)
      const analyser = this.createAnalyser()
      const silent = this.createGain()
      silent.gain.value = 0
      source.connect(analyser)
      analyser.connect(silent)
      silent.connect(this.destination)
      const samples = new Float32Array(analyser.fftSize)
      const timer = setInterval(() => {
        analyser.getFloatTimeDomainData(samples)
        const peak = Math.max(Number(document.documentElement.dataset.voiceAudioPeak || 0), ...samples.map(Math.abs))
        document.documentElement.dataset.voiceAudioPeak = String(peak)
      }, 10)
      source.addEventListener("ended", () => clearInterval(timer), { once: true })
      this.addEventListener("statechange", () => {
        if (this.state === "closed") clearInterval(timer)
      })
      return source
    }
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      value: async () => {
        const context = new AudioContext()
        const destination = context.createMediaStreamDestination()
        const oscillator = context.createOscillator()
        const gain = context.createGain()
        gain.gain.value = 0
        document.documentElement.addEventListener("voice-qa-mic-gain", (event) => {
          gain.gain.value = Number((event as CustomEvent<number>).detail) || 0
        })
        oscillator.connect(gain).connect(destination)
        oscillator.start()
        const stream = destination.stream
        stream.getTracks().forEach((track) => {
          const stop = track.stop.bind(track)
          track.stop = () => {
            stop()
            void context.close()
          }
        })
        await context.resume()
        return stream
      },
    })
  })
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({}))
    localStorage.setItem(
      "opencode.app-plugin.speech-to-text-app.settings.transcriptionChain",
      JSON.stringify("model:openrouter/openai/gpt-4o-mini-transcribe"),
    )
    localStorage.setItem("opencode.app-plugin.speech-to-text-app.settings.automaticImprovement", "false")
    localStorage.setItem(
      "opencode.app-plugin.voice-conversation-app.settings.transcriptionTarget",
      JSON.stringify("model:openrouter/openai/gpt-4o-mini-transcribe"),
    )
    localStorage.setItem(
      "opencode.app-plugin.voice-conversation-app.settings.speechTarget",
      JSON.stringify("model:openrouter/openai/gpt-4o-mini-tts-2025-12-15"),
    )
  })

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.addInitScript(
    ({ directory, dirBase64, sessionID, voiceSessionID, otherSessionID }) => {
      if (localStorage.getItem("voice-qa-tabs-seeded")) return
      localStorage.setItem("voice-qa-tabs-seeded", "true")
      const server = "http://127.0.0.1:4096"
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify(
          [sessionID, voiceSessionID, otherSessionID].map((sessionId) => ({ type: "session", server, dirBase64, sessionId })),
        ),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs.recent",
        JSON.stringify({ key: `${server}\n${dirBase64}\n${sessionID}` }),
      )
    },
    { directory, dirBase64: base64Encode(directory), sessionID, voiceSessionID, otherSessionID },
  )
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  const open = page.getByRole("button", { name: "Voice conversation", exact: true })
  await expectAppVisible(open)
  await expect(page.getByRole("tab", { name: "Voice conversation", exact: true })).toHaveAttribute(
    "aria-selected",
    "false",
  )
  await expect
    .poll(() => requests.some((request) => request.sessionID === voiceSessionID && request.phase === "end"), {
      timeout: 60_000,
    })
    .toBe(true)
  await open.focus()
  await expect(open).toBeFocused()
  await page.keyboard.press("Enter")
  const dialog = page.getByRole("dialog", { name: "Live voice conversation" })
  await expectAppVisible(dialog)
  await expect(dialog).toHaveAttribute("aria-modal", "false")
  await expect(dialog.locator(".oc-voice__transcript")).toHaveCount(0)
  await expect(page.getByRole("tab", { name: "Voice conversation", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  )
  await expect(dialog.getByRole("button", { name: "Close Voice conversation" })).not.toBeFocused()
  const beforeDrag = await dialog.boundingBox()
  const drag = await dialog.locator("header").boundingBox()
  if (!beforeDrag || !drag) throw new Error("Voice floating panel has no drag bounds")
  await page.mouse.move(drag.x + 40, drag.y + 20)
  await page.mouse.down()
  await page.mouse.move(drag.x - 160, drag.y + 80, { steps: 4 })
  await page.mouse.up()
  const afterDrag = await dialog.boundingBox()
  expect(afterDrag?.x).toBeLessThan(beforeDrag.x)
  expect(afterDrag?.x).toBeGreaterThanOrEqual(0)
  expect(afterDrag?.y).toBeGreaterThanOrEqual(0)

  const confirmation = dialog.getByRole("group", { name: "Permission confirmation" })
  await expectAppVisible(confirmation)
  await expect(confirmation).toContainText("write")
  await expect(confirmation).toContainText("notes.md")
  await expect(confirmation.getByRole("button", { name: "Allow once" })).toBeVisible()
  await expect(confirmation.getByRole("button", { name: /always/i })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Allow always", exact: true })).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath("voice-conversation-desktop.png"), fullPage: true })

  transcriptionQueue.push("Open Code, Freigabe jetzt!")
  await dialog.getByRole("button", { name: "Start listening" }).click()
  await expect(dialog.locator(".oc-voice")).toHaveAttribute("data-phase", "listening")
  await page.evaluate(() => document.documentElement.dispatchEvent(new CustomEvent("voice-qa-mic-gain", { detail: 0.03 })))
  await page.waitForTimeout(250)
  await page.evaluate(() => document.documentElement.dispatchEvent(new CustomEvent("voice-qa-mic-gain", { detail: 0 })))
  await expect.poll(() => replies).toEqual([{ sessionID, requestID: "per_voice_once", body: { reply: "once" } }])
  await expect(confirmation).toBeHidden()
  await expect.poll(() => spoken).toContain("Freigabe erteilt.")
  spoken.length = 0

  events.push(
    event("session.next.activity.started", { sessionID: voiceSessionID }),
    event("session.next.text.delta", { sessionID: voiceSessionID, assistantMessageID: "ast_tab_stream", textID: "txt_tab_stream", delta: "Streaming" }),
  )
  await expect(dialog.locator(".oc-voice")).toHaveAttribute("data-phase", "responding", { timeout: 20_000 })
  await page.getByRole("tab", { name: "Other voice work", exact: true }).click()
  await expect(dialog.locator(".oc-voice")).toHaveAttribute("data-phase", "responding")
  await page.getByRole("tab", { name: "Voice conversation", exact: true }).click()
  await expect(dialog.locator(".oc-voice")).toHaveAttribute("data-phase", "responding")
  events.push(
    event("session.next.text.ended", { sessionID: voiceSessionID, assistantMessageID: "ast_tab_stream", textID: "txt_tab_stream", text: "Streaming completed." }),
    event("session.next.activity.completed", { sessionID: voiceSessionID }),
  )
  await expect(dialog.locator(".oc-voice")).toHaveAttribute("data-phase", "listening", { timeout: 20_000 })
  spoken.length = 0
  await dialog.getByRole("button", { name: "Worker", exact: true }).click()
  await expect(page.getByRole("tab", { name: "Voice conversation QA", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  )
  await expect(dialog.locator(".oc-voice")).toHaveAttribute("data-phase", "listening")
  await dialog.getByRole("button", { name: "Conversation", exact: true }).click()
  await expect(page.getByRole("tab", { name: "Voice conversation", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  )
  await expect(dialog.locator(".oc-voice")).toHaveAttribute("data-phase", "listening")
  await page.evaluate(() => document.documentElement.dispatchEvent(new CustomEvent("voice-qa-mic-gain", { detail: 0.03 })))
  await expect(dialog.locator(".oc-voice")).toHaveAttribute("data-phase", "speaking")
  await page.evaluate(() => document.documentElement.dispatchEvent(new CustomEvent("voice-qa-mic-gain", { detail: 0.014 })))
  await page.waitForTimeout(1_200)
  await expect(dialog.locator(".oc-voice")).toHaveAttribute("data-phase", "speaking")
  await expect(dialog.locator(".oc-voice__status")).toHaveText("Listening to your turn")
  await page.screenshot({ path: testInfo.outputPath("voice-continuous-quiet-speech.png"), fullPage: true })
  await page.evaluate(() => document.documentElement.dispatchEvent(new CustomEvent("voice-qa-mic-gain", { detail: 0 })))
  await expect(dialog.locator(".oc-voice")).toHaveAttribute("data-phase", "listening")
  await expect.poll(() => transcriptionRequests).toBe(3)
  // Paging checklist: prefetched inactive tab -> open hydration -> loadOlder while listening.
  // Target a turn outside the first API/prefetch page (200 newest of 340) so tab
  // persistence cannot satisfy this by revealing already-cached messages.
  const oldest = page.locator('[data-message-id="msg_history_0000"]:visible').first()
  const oldestAssistant = page.locator('[data-timeline-part-id="msg_history_0001:txt_history_0_assistant"]')
  const boundary = page.locator('[data-message-id="msg_history_0240"]:visible').first()
  const assistant = page.locator('[data-timeline-part-id="msg_history_0241:txt_history_120_assistant"]')
  const scroller = page.locator(".scroll-view__viewport:visible", { has: page.locator("[data-timeline-row]") })
  await expect
    .poll(
      async () => {
        if ((await oldest.isVisible()) && (await oldestAssistant.count())) return true
        await scroller.evaluate((element) => {
          element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -1 }))
          element.scrollTop = Math.max(0, element.scrollTop - element.clientHeight * 0.65)
        })
        return false
      },
      { timeout: 60_000, intervals: [100] },
    )
    .toBe(true)
  expect(
    requests.some((request) => request.sessionID === voiceSessionID && request.before && request.phase === "end"),
  ).toBe(true)
  await expect(oldestAssistant).toContainText("Historical assistant turn 0")
  await expect(dialog.locator(".oc-voice")).toHaveAttribute("data-phase", "listening")
  expect(spoken).toEqual([])
  await page.screenshot({ path: testInfo.outputPath("voice-long-loaded-older.png"), fullPage: true })
  events.push(
    event("session.next.text.ended", {
      sessionID: voiceSessionID,
      assistantMessageID: "ast_audio_probe",
      textID: "txt_audio_probe",
      text: "Final-only audio probe.",
    }),
  )
  await expect.poll(() => spoken, { timeout: 20_000 }).toEqual(["Final-only audio probe."])
  // This verifies real browser Web Audio samples, not just HTTP success/source.start.
  // The deterministic tone is not a physical-speaker or intelligible-speech acceptance test.
  await expect
    .poll(() => page.evaluate(() => Number(document.documentElement.dataset.voiceAudioPeak || 0)))
    .toBeGreaterThan(0.05)
  const editor = page.getByRole("textbox", { name: /Ask anything/i })
  await editor.fill("Moderator draft")
  await expect(editor).toHaveText("Moderator draft")
  const dictation = page.locator('[data-action="speech-to-text"]:visible')
  await dictation.click()
  await expect(dictation).toHaveAttribute("data-state", "recording")
  await expect(page.locator(".oc-speech-to-text__status:visible")).toHaveText("Recording 0:00")
  await expect(dialog.locator(".oc-voice")).toHaveAttribute("data-phase", "paused")
  await expect(page.locator(".oc-speech-to-text__status:visible")).toHaveText("Recording 0:01")
  await dictation.click()
  await expect.poll(() => transcriptionRequests).toBe(4)
  await dialog.getByRole("button", { name: "Worker", exact: true }).click()
  await editor.fill("Worker stays untouched")
  transcript.resolve("Pinned dictation result")
  await expect(dictation).toBeEnabled()
  await expect(editor).toHaveText("Worker stays untouched")
  await expect(dialog.locator(".oc-voice")).toHaveAttribute("data-phase", "paused")
  await dialog.getByRole("button", { name: "Conversation", exact: true }).click()
  await expect(editor).toContainText("Moderator draft")
  await expect(editor).toContainText("Pinned dictation result")
  await page.screenshot({ path: testInfo.outputPath("voice-dictation-pinned-draft.png"), fullPage: true })
  events.push(
    event("session.next.text.ended", {
      sessionID: voiceSessionID,
      assistantMessageID: "ast_audio_probe",
      textID: "txt_audio_probe",
      text: "Final-only audio probe.",
    }),
  )

  await page.getByRole("textbox", { name: /Ask anything/i }).focus()
  await page.keyboard.press("Escape")
  await expect(dialog).toBeVisible()
  await dialog.getByRole("button", { name: "Close Voice conversation" }).focus()
  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
  await open.click()
  await expectAppVisible(dialog)
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(dialog.getByRole("button", { name: "Start listening" })).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Worker", exact: true })).toBeVisible()
  await expect(dialog.locator(".oc-voice")).toHaveAttribute("data-phase", "paused")
  await expectNoOverflow(dialog)
  await page.screenshot({ path: testInfo.outputPath("voice-conversation-mobile.png"), fullPage: true })

  await page.evaluate(
    ({ dirBase64, voiceSessionID }) => {
      localStorage.setItem(
        "opencode.global.dat:tabs.recent",
        JSON.stringify({ key: `http://127.0.0.1:4096\n${dirBase64}\n${voiceSessionID}` }),
      )
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}#message-msg_history_0240`,
      )
    },
    { dirBase64: base64Encode(directory), voiceSessionID },
  )
  await page.reload()
  await expectAppVisible(editor)
  await expect(dialog).toHaveCount(0)
  await expect(boundary).toBeVisible({ timeout: 60_000 })
  await expect(assistant).toContainText("Historical assistant turn 120")
  await expect(editor).toContainText("Moderator draft Pinned dictation result")
  await open.click()
  await expect(dialog.locator(".oc-voice")).toHaveAttribute("data-phase", "paused")
  await page.evaluate(() => {
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`)
    window.location.hash = "message-msg_history_0240"
  })
  await expect(boundary).toBeVisible()
  await expect(assistant).toContainText("Historical assistant turn 120")
  await page.screenshot({ path: testInfo.outputPath("voice-long-mobile-hash-restore.png"), fullPage: true })
  expect(spoken).toEqual(["Final-only audio probe."])
  await page.setViewportSize({ width: 1280, height: 720 })
  await expect(boundary).toBeVisible()
  await expect(assistant).toContainText("Historical assistant turn 120")
  await page.screenshot({ path: testInfo.outputPath("voice-long-desktop-hash-restore.png"), fullPage: true })
  await dialog.getByRole("button", { name: "Start listening" }).click()
  await expect(dialog.locator(".oc-voice")).toHaveAttribute("data-phase", "listening")
  events.push(
    event("session.next.text.ended", {
      sessionID: voiceSessionID,
      assistantMessageID: "ast_after_reload",
      textID: "txt_after_reload",
      text: "Only new audio after reload.",
    }),
  )
  await expect
    .poll(() => spoken, { timeout: 20_000 })
    .toEqual(["Final-only audio probe.", "Only new audio after reload."])
  await expect
    .poll(() => page.evaluate(() => Number(document.documentElement.dataset.voiceAudioPeak || 0)))
    .toBeGreaterThan(0.05)
  await expect(boundary).toBeVisible()
  await expect(assistant).toContainText("Historical assistant turn 120")
  await testInfo.attach("voice-long-paging-evidence", {
    body: JSON.stringify({ userTurns: 170, requests, spoken, failedResponses, errors }, null, 2),
    contentType: "application/json",
  })
  expect(requests.every((request) => request.limit <= 200)).toBe(true)
  await page.getByRole("button", { name: "Home", exact: true }).click()
  await expect(dialog).toHaveCount(0)

  expect(failedResponses).toEqual([])
  expectNoSmokeErrors(errors, [], [])
})

async function mockVoicePlugin(page: Page) {
  const root = new URL("../../../../.opencode/plugin-sources/voice-conversation-app/", import.meta.url)
  await page.route("**/app/plugins**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({
        plugins: [
          {
            id: "voice-conversation-app",
            spec: "voice-conversation-app",
            version: "1",
            hash: "voice-conversation",
            capabilities: [
              "ui:toolbar",
              "ui:settings",
              "ui:floating",
              "commands",
              "kv",
              "host:navigation",
              "host:sessions",
              "services:voice-conversation-app:session-links",
              "host:stt",
              "host:tts",
              "host:audio",
            ],
            module: "/app/plugin/voice-conversation-app/1/index.js",
          },
          {
            id: "speech-to-text-app",
            spec: "speech-to-text-app",
            version: "1",
            hash: "speech",
            capabilities: JSON.parse(readFileSync(new URL("../speech-to-text-app/package.json", root), "utf8")).opencode
              .app.capabilities,
            module: "/app/plugin/speech-to-text-app/1/index.js",
          },
        ],
      }),
    }),
  )
  for (const file of ["index.js", "core.js"]) {
    await page.route(`**/app/plugin/voice-conversation-app/1/${file}**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/javascript",
        headers: { "access-control-allow-origin": "*" },
        body: readFileSync(new URL(file, root), "utf8"),
      }),
    )
  }
  await page.route("**/app/plugin/voice-conversation-app/1/assets/voice-conversation.svg**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      headers: { "access-control-allow-origin": "*" },
      body: readFileSync(new URL("assets/voice-conversation.svg", root), "utf8"),
    }),
  )
  for (const file of ["index.js", "assets/microphone.svg"]) {
    await page.route(`**/app/plugin/speech-to-text-app/1/${file}**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: file.endsWith(".svg") ? "image/svg+xml" : "text/javascript",
        headers: { "access-control-allow-origin": "*" },
        body: readFileSync(new URL(`../speech-to-text-app/${file}`, root), "utf8"),
      }),
    )
  }
}

function event(type: string, properties: Record<string, unknown>) {
  return {
    directory,
    payload: { id: `evt_${type}_${Date.now()}_${Math.random()}`, type, properties },
  }
}

function session() {
  return {
    id: sessionID,
    slug: "voice-page",
    projectID,
    directory,
    title: "Voice conversation QA",
    version: "dev",
    time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
  }
}

function voiceSession() {
  return {
    ...session(),
    id: voiceSessionID,
    slug: "voice-moderator",
    title: "Voice conversation",
    agent: "voice-moderator",
    model: { id: "gpt-5.6-sol", providerID: "openai" },
  }
}

function otherSession() {
  return { ...session(), id: otherSessionID, slug: "voice-other", title: "Other voice work" }
}

async function expectNoOverflow(dialog: ReturnType<Page["getByRole"]>) {
  const result = await dialog.evaluate((element) => ({
    viewportWidth: window.innerWidth,
    left: element.getBoundingClientRect().left,
    right: element.getBoundingClientRect().right,
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
  }))
  expect(result.left).toBeGreaterThanOrEqual(0)
  expect(result.right).toBeLessThanOrEqual(result.viewportWidth)
  expect(result.scrollWidth).toBeLessThanOrEqual(result.clientWidth)
}
