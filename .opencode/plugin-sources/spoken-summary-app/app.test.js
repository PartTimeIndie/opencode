import { describe, expect, test } from "bun:test"
import { context } from "./core.test.js"
import plugin from "./index.js"

// Mirrors the app runtime's settings semantics: subscribe fires immediately with a
// snapshot of registered fields only (packages/app/src/plugin/app-runtime.tsx), so
// stored values survive activation only when settings register before the
// controller subscribes.
function activation() {
  const owner = new AbortController()
  const storage = new Map([["summaryTarget", "model:test/summary"], ["speechTarget", "model:test/speech"]])
  const registered = { fields: [] }
  const listeners = new Set()
  const calls = { ai: [], tts: [] }
  const toolbars = []
  const snapshot = () => Object.fromEntries(registered.fields.map((field) => [field.key, storage.has(field.key) ? storage.get(field.key) : field.default]))
  const audio = {
    state: "running", resume: async () => {}, destination: {}, close: async () => {},
    createBuffer: (channels, length, sampleRate) => ({ numberOfChannels: channels, length, sampleRate, copyToChannel() {} }),
    createBufferSource: () => ({ connect() {}, start() {}, stop() {}, disconnect() {}, onended: null }),
  }
  const api = {
    signal: owner.signal,
    settings: {
      get: (key, fallback) => (storage.has(key) ? storage.get(key) : fallback),
      set(key, value) { storage.set(key, value); listeners.forEach((fn) => fn(snapshot())) },
      register(item) { registered.fields = item.sections.flatMap((section) => section.fields); return () => {} },
      subscribe(fn) { listeners.add(fn); fn(snapshot()); return () => listeners.delete(fn) },
    },
    commands: { register() {} },
    toolbar: { register(item) { toolbars.push(item) } },
    ui: { overlay: { open() {} } },
    host: {
      navigation: { current: () => ({ directory: "/project", sessionID: "ses_a" }) },
      sessions: { async context(input) { return { ok: true, context: context(input.sessionID) } } },
      ai: { async run(input) { calls.ai.push(input); return { ok: true, text: "Die Tests sind grün. Für den Neustart brauche ich deine Freigabe." } } },
      tts: { async speak(input) {
        calls.tts.push(input)
        return { ok: true, stream: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(48_000)); controller.close() } }), format: "pcm", sampleRate: 24_000, channels: 1 }
      } },
    },
  }
  plugin.app(api)
  return { owner, audio, calls, toolbars }
}

const until = async (check, budget = 2500) => {
  const deadline = Date.now() + budget
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return check()
}

describe("spoken summary activation", () => {
  test("stored model targets survive activation; one click reaches AI and TTS", async () => {
    const previous = globalThis.AudioContext
    const env = activation()
    globalThis.AudioContext = function () { return env.audio }
    try {
      const element = document.createElement("div")
      document.body.append(element)
      const dispose = env.toolbars[0].mount({ element, signal: env.owner.signal, context: { directory: "/project", sessionID: "ses_a" } })
      element.querySelector('[data-action="spoken-summary-listen"]').click()
      expect(await until(() => element.querySelector(".oc-spoken-summary")?.dataset.phase === "speaking")).toBe(true)
      expect(env.calls.ai).toHaveLength(1)
      expect(env.calls.ai[0].model).toBe("test/summary")
      expect(env.calls.tts).toHaveLength(1)
      expect(env.calls.tts[0].model).toBe("test/speech")
      expect(env.calls.tts[0].text).toContain("Freigabe")
      dispose()
      element.remove()
    } finally {
      globalThis.AudioContext = previous
      env.owner.abort()
    }
  })
})
