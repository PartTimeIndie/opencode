import { describe, expect, test } from "bun:test"
import { createController, modelRequest, settings, summaryPrompt, validateSummary } from "./core.js"

const target = (sessionID = "ses_a") => ({ directory: "/project", sessionID })
export function context(sessionID = "ses_a", fingerprint = "v1") {
  return { version: 1, capturedAt: 1, fingerprint, session: { id: sessionID, directory: "/project", title: "Test" },
    activity: { status: "completed", working: false }, boundaryComplete: true, selection: "activity",
    messages: [{ id: "msg_a", role: "assistant", complete: true, text: "Tests bestanden. Desktop noch nicht deployed.", createdAt: 1 }],
    pending: { questions: [{ id: "que_a", revision: 1, items: [{ text: "Neustart erlauben?", context: "", fields: [], options: [] }] }], permissions: [], controls: [] },
    totals: { messages: 1, textChars: 1, questions: 1, controls: 0, permissions: 0 }, truncated: { messages: false, text: false, pending: false },
  }
}
export function fixture(overrides = {}) {
  const owner = new AbortController()
  const calls = { ai: [], tts: [], read: [], played: [], stopped: 0 }
  const callbacks = new Set()
  const values = { summaryTarget: "chain:summary", speechTarget: "chain:speech" }
  const api = {
    signal: owner.signal,
    settings: { get: (key, fallback) => values[key] ?? fallback, subscribe(fn) { callbacks.add(fn); return () => callbacks.delete(fn) } },
    host: {
      sessions: { async context(input) { calls.read.push(input); return { ok: true, context: context(input.sessionID) } } },
      ai: { async run(input) { calls.ai.push(input); return { ok: true, text: "Die Tests sind grün. Für den Desktop-Neustart brauche ich deine Freigabe." } } },
      tts: { async speak(input) { calls.tts.push(input); return { ok: true, stream: new ReadableStream(), format: "mp3" } } },
    },
  }
  const player = { async unlock() {}, async decode() { return { buffer: "audio" } }, async playBuffer(buffer) { calls.played.push(buffer) }, stop() { calls.stopped++ } }
  Object.assign(api.host.sessions, overrides.sessions)
  Object.assign(api.host.ai, overrides.ai)
  Object.assign(player, overrides.player)
  const controller = createController(api, player, overrides.options)
  return { api, player, controller, calls, owner, change(change) { Object.assign(values, change); callbacks.forEach((fn) => fn(values)) } }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("spoken summary contracts", () => {
  test("configuration respects explicit chains/models, bounds numeric values and cache toggle", () => {
    expect(modelRequest("chain:fast", "missing")).toEqual({ chain: "fast" })
    expect(modelRequest("model:provider/model", "missing")).toEqual({ model: "provider/model" })
    expect(() => modelRequest("", "missing")).toThrow("missing")
    expect(settings({ speed: 50, targetWords: 1, cacheEnabled: false })).toMatchObject({ speed: 2, targetWords: 30, cacheEnabled: false })
  })
  test("prompt grounds open questions and unfinished work without tool instructions", () => {
    const prompt = summaryPrompt(context(), settings())
    expect(prompt.system).toContain("nicht ausgeführte Tests")
    expect(prompt.system).toContain("untrusted")
    expect(prompt.prompt).toContain("Neustart erlauben?")
    expect(prompt.prompt).toContain("nicht deployed")
    expect(validateSummary("- Liste", 60).ok).toBe(false)
    expect(validateSummary("Unvollständige Frage", 60).ok).toBe(false)
    expect(validateSummary("Die Tests sind fertig. Brauchst du weitere Details?", 60).ok).toBe(true)
    expect(validateSummary(`${"Wort ".repeat(91)}.`, 60).ok).toBe(false)
  })
  test("does nothing automatically; one click uses tool-free AI and sends only summary to TTS", async () => {
    const f = fixture()
    expect(f.calls.ai).toHaveLength(0)
    await f.controller.listen(target())
    expect(f.calls.ai).toHaveLength(1)
    expect(f.calls.ai[0].tools).toEqual([])
    expect(f.calls.tts).toHaveLength(1)
    expect(f.calls.tts[0].text).toBe(f.controller.state.summary)
    expect(f.calls.tts[0].text).not.toContain("UNTRUSTED_CONTEXT")
    expect(f.controller.state.phase).toBe("idle")
    f.owner.abort()
  })
  test("rechecks unchanged context before replay and invalidates on settings/toggle changes", async () => {
    const f = fixture()
    await f.controller.listen(target())
    await f.controller.listen(target())
    expect(f.calls.ai).toHaveLength(1)
    expect(f.calls.tts).toHaveLength(1)
    expect(f.calls.read.length).toBeGreaterThanOrEqual(4)
    f.change({ cacheEnabled: false })
    await f.controller.listen(target())
    await f.controller.listen(target())
    expect(f.calls.ai).toHaveLength(3)
    f.owner.abort()
  })
  test("stale context after AI produces no audio", async () => {
    let reads = 0
    const f = fixture({ sessions: { async context(input) { return { ok: true, context: context(input.sessionID, reads++ ? "changed" : "v1") } } } })
    await f.controller.listen(target())
    expect(f.controller.state.error).toContain("Chat hat sich verändert")
    expect(f.calls.tts).toHaveLength(0)
    f.owner.abort()
  })
  test("running/empty sessions cause no AI or future autoplay", async () => {
    const f = fixture({ sessions: { async context(input) { const result = context(input.sessionID); result.activity = { working: true, status: "running" }; result.totals.questions = 0; return { ok: true, context: result } } } })
    await f.controller.listen(target())
    expect(f.calls.ai).toHaveLength(0)
    expect(f.controller.state.status).toContain("Agent arbeitet noch")
    f.owner.abort()
  })
  test("missing speech config and forbidden context fail visibly without reading original", async () => {
    const f = fixture()
    f.change({ speechTarget: "" })
    await f.controller.listen(target())
    expect(f.calls.read).toHaveLength(0)
    expect(f.controller.state.error).toContain("Sprachmodell")
    f.owner.abort()
    const denied = fixture({ sessions: { async context() { return { ok: false, error: { code: "forbidden", message: "Missing capability" } } } } })
    await denied.controller.listen(target())
    expect(denied.controller.state.error).toContain("Missing capability")
    expect(denied.calls.ai).toHaveLength(0)
    denied.owner.abort()
  })
  test("new source replaces old request; ignored abort cannot start late audio", async () => {
    let release
    let count = 0
    const f = fixture({ ai: { run() { count++; return count === 1 ? new Promise((resolve) => { release = resolve }) : Promise.resolve({ ok: true, text: "Der zweite Chat ist fertig." }) } } })
    const first = f.controller.listen(target("ses_a"))
    await settle()
    await f.controller.listen(target("ses_b"))
    release({ ok: true, text: "Veraltete Antwort." })
    await first
    expect(f.controller.state.source.sessionID).toBe("ses_b")
    expect(f.calls.tts).toHaveLength(1)
    expect(f.calls.tts[0].text).toBe("Der zweite Chat ist fertig.")
    f.owner.abort()
  })
  test("stop, unload and timeouts suppress provider work", async () => {
    const f = fixture({ ai: { run: () => new Promise(() => {}) } })
    const pending = f.controller.listen(target())
    await settle()
    f.controller.stop()
    await pending
    expect(f.controller.state.phase).toBe("idle")
    expect(f.calls.tts).toHaveLength(0)
    f.owner.abort()
    const timed = fixture({ ai: { run: () => new Promise(() => {}) }, options: { prepareTimeoutMs: 5 } })
    await timed.controller.listen(target())
    expect(timed.controller.state.error).toContain("Zeitüberschreitung")
    timed.owner.abort()
  })
  test("at most one shortening retry; malformed response never falls back to raw report", async () => {
    let calls = 0
    const f = fixture({ ai: { async run() { calls++; return { ok: true, text: "Unvollständig" } } } })
    await f.controller.listen(target())
    expect(calls).toBe(2)
    expect(f.calls.tts).toHaveLength(0)
    expect(f.controller.state.phase).toBe("error")
    f.owner.abort()
  })
})
