import { afterEach, expect, test } from "bun:test"
import { createAudioCaptureBroker } from "./audio-capture"
import { createSessionSubscription } from "./session-events"

const plugin = await import(new URL("../../../../.opencode/plugin-sources/voice-conversation-app/index.js", import.meta.url).href)
const VoicePlugin = plugin.default
const { createConversationOpener, mountConversation } = plugin
const { VOICE_TIMING } = await import(new URL("../../../../.opencode/plugin-sources/voice-conversation-app/core.js", import.meta.url).href)

const originalAudio = window.AudioContext
const originalMedia = Object.getOwnPropertyDescriptor(navigator, "mediaDevices")
afterEach(() => {
  window.AudioContext = originalAudio
  if (originalMedia) Object.defineProperty(navigator, "mediaDevices", originalMedia)
  else delete navigator.mediaDevices
  document.body.replaceChildren()
})

function mount(getUserMedia, settings = {}, values = new Map()) {
  const audio = { stopped: 0, processor: undefined, requests: [], speech: [], permissionReplies: [], interrupted: 0, ended: [], navigation: [], played: 0, stoppedSources: 0, buffers: [], decoded: 0, resumed: 0 }
  window.AudioContext = class {
    state = "running"
    sampleRate = 24000
    currentTime = 0
    destination = {}
    constructor() { audio.context = this }
    async resume() { audio.resumed++; this.state = "running" }
    async close() { this.state = "closed" }
    createMediaStreamSource() { return { connect() {}, disconnect() {} } }
    createScriptProcessor() {
      audio.processor = { connect() {}, disconnect() {}, onaudioprocess: undefined }
      return audio.processor
    }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} } }
    createBuffer(channels, length, sampleRate) {
      const buffer = { channels, length, sampleRate, samples: [], duration: length / sampleRate, copyToChannel(samples, channel) { this.samples[channel] = [...samples] } }
      audio.buffers.push(buffer)
      return buffer
    }
    async decodeAudioData() { audio.decoded++; return { duration: 1 } }
    createBufferSource() { return { connect() {}, stop() { audio.stoppedSources++ }, start() { audio.played++ } } }
  }
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } })
  const element = document.createElement("div")
  document.body.append(element)
  const controller = new AbortController()
  const transcription = Promise.withResolvers()
  const broker = createAudioCaptureBroker(async () => {
    const stream = await getUserMedia()
    const tracks = stream.getTracks().map((track) => Object.assign(new EventTarget(), track))
    return { getTracks: () => tracks }
  })
  const api = {
    kv: { get: (key, fallback) => values.get(key) ?? fallback, set: (key, value) => values.set(key, value), delete: (key) => values.delete(key) },
    settings: { get(key, fallback) {
      return ({ transcriptionTarget: "model:openrouter/test/stt", speechTarget: "model:openrouter/test/tts", previewTranscription: false, ...settings })[key] ?? fallback
    } },
    services: { async call(request) {
      if (request.input.operation === "end") audio.ended.push({ directory: request.directory, sessionID: request.input.sessionID })
      return { ok: true, data: { link: { sourceSessionID: "ses_voice", targetSessionID: "ses_worker" } } }
    } },
    host: {
      audio: broker,
      navigation: { openSession(input) { audio.navigation.push(input) } },
      sessions: {
        async messages() { return [] },
        subscribeEvents(input, handler) {
          audio.emit = handler
          const subscription = createSessionSubscription({ sessionID: input.sessionID, pending: async () => [], session: async () => undefined, emit: handler })
          audio.serverEvent = subscription.receive
          return () => { subscription.dispose(); audio.emit = () => {} }
        },
        async interrupt() { audio.interrupted++; return { ok: true } },
        async prompt(input) { audio.requests.push(input); return { ok: true } },
        async replyPermission(input) { audio.permissionReplies.push(input); return { ok: true } },
      },
      stt: { transcribe() { return transcription.promise } },
      tts: { async speak(input) {
        audio.speech.push(input.text)
        if (audio.respond) return audio.respond(input)
        return { ok: true, format: "pcm", sampleRate: 24000, channels: 1, mimeType: "audio/pcm", stream: new Blob([new Uint8Array([0, 32, 0, 16])]).stream() }
      } },
    },
  }
  mountConversation(api, { element, signal: controller.signal, close: () => controller.abort() }, "C:/Voice", {
    pair: { sourceSessionID: "ses_voice", targetSessionID: "ses_worker" }, model: { id: "test", providerID: "test" },
  })
  return { audio, element, controller, transcription, broker }
}

test("a durable V2 answer without live deltas plays exactly once and completion restores listening", async () => {
  const view = await listening()
  try {
    const event = { type: "sync", id: "transport", syncEvent: {
      id: "answer-event", type: "session.next.text.ended.1", aggregateID: "ses_voice", seq: 1,
      data: { sessionID: "ses_voice", assistantMessageID: "answer", textID: "text", text: "Die Sprachausgabe funktioniert.", timestamp: Date.now() },
    } }
    await view.audio.serverEvent(event)
    await view.audio.serverEvent({ id: "answer-event", type: "session.next.text.ended", properties: event.syncEvent.data })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(view.audio.speech).toEqual(["Die Sprachausgabe funktioniert."])
    expect(view.audio.played).toBe(1)
    await view.audio.serverEvent({ ...event, syncEvent: { ...event.syncEvent, id: "completion-event", type: "session.next.activity.completed.1" } })
    expect(view.element.textContent).toContain("Listening — speak naturally")
  } finally { view.controller.abort() }
})

test("resuming a mounted conversation uses the newly selected speech model and its German voice", async () => {
  const settings = { speechTarget: "chain:previous-speech-chain" }
  const view = await listening(settings)
  const requests = []
  try {
    view.element.querySelector('[data-action="pause"]').click()
    settings.speechTarget = "model:openrouter/microsoft/mai-voice-2"
    settings.voiceOverrides = [{ model: "openrouter/microsoft/mai-voice-2", voice: "de-DE-Klaus:MAI-Voice-2" }]
    view.audio.respond = input => {
      requests.push(input)
      return { ok: true, format: "mp3", mimeType: "audio/mpeg", stream: new Blob([new Uint8Array([73, 68, 51])]).stream() }
    }
    view.element.querySelector('[data-action="start"]').click()
    await new Promise(resolve => setTimeout(resolve, 0))
    view.audio.emit({ type: "text.ended", messageID: "german-selection", textID: "text", text: "Guten Tag." })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ model: "openrouter/microsoft/mai-voice-2", voices: { "openrouter/microsoft/mai-voice-2": "de-DE-Klaus:MAI-Voice-2" } })
    expect(requests[0]).not.toHaveProperty("chain")
    expect(view.audio.played).toBe(1)
  } finally { view.controller.abort() }
})

test("view switching preserves the voice target and end only unlinks without interrupting sessions", async () => {
  const view = await listening()
  try {
    expect(view.element.querySelector(".oc-voice__transcript")).toBeNull()
    view.element.querySelector('[data-action="open-worker"]').click()
    view.element.querySelector('[data-action="open-session"]').click()
    expect(view.audio.navigation).toEqual([
      { directory: "C:/Voice", sessionID: "ses_worker" },
      { directory: "C:/Voice", sessionID: "ses_voice" },
    ])
    expect(view.audio.stopped).toBe(0)
    const feed = (samples) => view.audio.processor.onaudioprocess({ inputBuffer: { getChannelData: () => samples } })
    feed(new Float32Array(4096).fill(0.1))
    for (let i = 0; i < 4; i++) feed(new Float32Array(4096))
    view.transcription.resolve({ ok: true, text: "Keep working" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(view.audio.requests.map((request) => request.sessionID)).toEqual(["ses_voice"])
    view.element.querySelector('[data-action="end"]').click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(view.audio.ended).toEqual([{ directory: "C:/Voice", sessionID: "ses_voice" }])
    expect(view.audio.interrupted).toBe(0)
    expect(view.controller.signal.aborted).toBe(true)
  } finally { view.controller.abort() }
})

test("voice controls update the live response contract without sending a control-only turn", async () => {
  const values = new Map()
  const view = await listening({}, values)
  try {
    const feed = (samples) => view.audio.processor.onaudioprocess({ inputBuffer: { getChannelData: () => samples } })
    feed(new Float32Array(4096).fill(0.1)); for (let i = 0; i < 4; i++) feed(new Float32Array(4096))
    view.transcription.resolve({ ok: true, text: "Antworte kürzer und sprich schneller" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(view.audio.requests).toEqual([])
    expect(view.audio.speech).toEqual(["Ich antworte kürzer.", "Ich spreche schneller."])
    expect(view.element.textContent).toContain("Kurz · 1.25×")
  } finally { view.controller.abort() }
})

test("the exact user release phrase approves one worker permission without dispatching a turn", async () => {
  const values = new Map()
  const view = await listening({ releasePhrase: "OpenCode Freigabe Jetzt" }, values)
  try {
    view.audio.emit({ type: "permission.asked", sessionID: "ses_worker", requestID: "per_worker", action: "write", resources: ["notes.md"] })
    const feed = (samples) => view.audio.processor.onaudioprocess({ inputBuffer: { getChannelData: () => samples } })
    feed(new Float32Array(4096).fill(0.1)); for (let i = 0; i < 4; i++) feed(new Float32Array(4096))
    view.transcription.resolve({ ok: true, text: "Open Code, Freigabe jetzt!" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(view.audio.permissionReplies).toEqual([{ directory: "C:/Voice", sessionID: "ses_worker", requestID: "per_worker", reply: "once" }])
    expect(view.audio.requests).toEqual([])
    expect(view.audio.speech).toContain("Freigabe erteilt.")
    expect([...values.keys()].some((key) => key.startsWith("permission-audit:"))).toBe(true)
  } finally { view.controller.abort() }
})

test("closing during microphone acquisition stops the late stream", async () => {
  const microphone = Promise.withResolvers()
  const requested = Promise.withResolvers()
  const view = mount(() => { requested.resolve(); return microphone.promise })
  view.element.querySelector('[data-action="start"]').click()
  await requested.promise
  view.controller.abort()
  microphone.resolve({ getTracks: () => [{ stop() { view.audio.stopped++ } }] })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(view.audio.stopped).toBe(1)
  expect(view.audio.processor).toBeUndefined()
})

test("ending a conversation discards an in-flight final transcription", async () => {
  const view = mount(async () => ({ getTracks: () => [{ stop() { view.audio.stopped++ } }] }))
  view.element.querySelector('[data-action="start"]').click()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const feed = (samples) => view.audio.processor.onaudioprocess({ inputBuffer: { getChannelData: () => samples } })
  feed(new Float32Array(4096).fill(0.1))
  for (let i = 0; i < 4; i++) feed(new Float32Array(4096))
  await Promise.resolve()
  view.element.querySelector('[data-action="end"]').click()
  view.transcription.resolve({ ok: true, text: "Do not send this stale turn" })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(view.audio.requests).toEqual([])
  expect(view.audio.stopped).toBe(1)
  view.controller.abort()
})

async function listening(settings, values) {
  const view = mount(async () => ({ getTracks: () => [{ stop() { view.audio.stopped++ } }] }), settings, values)
  view.element.querySelector('[data-action="start"]').click()
  await new Promise((resolve) => setTimeout(resolve, 0))
  view.audio.emit({ type: "activity.started" })
  return view
}

test("a final-only assistant answer reaches TTS and playback", async () => {
  const view = await listening()
  try {
    view.audio.emit({ type: "text.ended", messageID: "answer", textID: "text", text: "Die Sprachausgabe funktioniert." })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(view.audio.speech).toEqual(["Die Sprachausgabe funktioniert."])
    expect(view.audio.played).toBeGreaterThan(0)
  } finally { view.controller.abort() }
})

test.each(["text.ended", "text.delta"])("remount does not replay previously observed answers but speaks new messages: %s", async (type) => {
  const values = new Map()
  const first = await listening({}, values)
  first.audio.emit({ type, messageID: "old", textID: "text", text: "Bereits gelesen.", delta: "Noch unvollständig" })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(first.audio.speech).toEqual(type === "text.ended" ? ["Bereits gelesen."] : [])
  first.controller.abort()
  const second = await listening({}, values)
  try {
    second.audio.emit({ type: "text.ended", messageID: "old", textID: "text", text: "Bereits gelesen." })
    second.audio.emit({ type: "text.ended", messageID: "new", textID: "text", text: "Neue Antwort." })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(second.audio.speech).toEqual(["Neue Antwort."])
  } finally { second.controller.abort() }
})

test("voice settings migrate once into editable generic rows and retain the global preference", () => {
  const settings = { voice: "legacy-preference", voices: { "openrouter/test/tts": "model-voice" } }
  const api = {
    settings: { get: (key, fallback) => settings[key] ?? fallback, set: (key, value) => { settings[key] = value }, register() {} },
    toolbar: { register() {} }, commands: { register() {} },
  }
  VoicePlugin.app(api)
  expect(settings.voiceOverrides).toEqual([{ model: "openrouter/test/tts", voice: "model-voice" }])
  expect(settings.voice).toBe("legacy-preference")
  settings.voiceOverrides = []
  VoicePlugin.app(api)
  expect(settings.voiceOverrides).toEqual([])
})

test.each([
  { voiceOverrides: [{ model: " openrouter/test/tts ", voice: " selected " }, { model: "", voice: "ignored" }], expected: { "openrouter/test/tts": "selected" } },
  { voiceOverrides: [], expected: {} },
])("per-model settings reach TTS and removed overrides stay removed: %j", async ({ voiceOverrides, expected }) => {
  const view = await listening({ voice: "global-preference", voices: { "openrouter/test/tts": "legacy" }, voiceOverrides })
  const request = Promise.withResolvers()
  try {
    view.audio.respond = (input) => {
      request.resolve(input)
      return { ok: true, format: "mp3", stream: new Blob([new Uint8Array([1])]).stream() }
    }
    view.audio.emit({ type: "text.ended", messageID: "overrides", textID: "text", text: "Test." })
    expect(await request.promise).toMatchObject({ voice: "global-preference", voices: expected })
  } finally { view.controller.abort() }
})

test("playback uses the returned stereo PCM metadata across split frames", async () => {
  const view = await listening()
  try {
    view.audio.respond = (input) => {
      expect(input.format).toBeUndefined()
      expect(input.voice).toBe("")
      return { ok: true, format: "pcm", sampleRate: 48000, channels: 2, stream: new ReadableStream({ start(controller) {
        controller.enqueue(new Uint8Array([0, 32, 0]))
        controller.enqueue(new Uint8Array([16, 0, 64, 0, 8]))
        controller.close()
      } }) }
    }
    view.audio.emit({ type: "text.ended", messageID: "stereo", textID: "text", text: "Stereo." })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(view.audio.buffers).toHaveLength(1)
    expect(view.audio.buffers[0]).toMatchObject({ channels: 2, length: 2, sampleRate: 48000, samples: [[0.25, 0.5], [0.125, 0.0625]] })
  } finally { view.controller.abort() }
})

test("MP3 resumes a suspended audio context and clears a persistent playback error", async () => {
  const view = await listening()
  try {
    view.audio.respond = () => ({ ok: false, error: "Unavailable model" })
    view.audio.emit({ type: "text.ended", messageID: "failed", textID: "text", text: "Failed." })
    await new Promise((resolve) => setTimeout(resolve, 0))
    view.audio.emit({ type: "activity.completed" })
    view.audio.emit({ type: "activity.started" })
    expect(view.element.querySelector('.oc-voice__playback-error').hidden).toBe(false)
    expect(view.element.querySelector('[data-playback-error]').textContent).toContain("Unavailable model")
    view.audio.context.state = "suspended"
    view.audio.respond = () => ({ ok: true, format: "mp3", stream: new Blob([new Uint8Array([1, 2, 3])]).stream() })
    view.audio.emit({ type: "text.ended", messageID: "next", textID: "text", text: "Deutsch." })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(view.audio.context.state).toBe("running")
    expect(view.audio.resumed).toBeGreaterThan(1)
    expect(view.audio.decoded).toBe(1)
    expect(view.audio.played).toBe(1)
    expect(view.element.querySelector('.oc-voice__playback-error').hidden).toBe(true)
  } finally { view.controller.abort() }
})

test("invalid PCM metadata remains visible until explicitly dismissed", async () => {
  const view = await listening()
  try {
    view.audio.respond = () => ({ ok: true, format: "pcm", stream: new Blob([new Uint8Array([0, 1])]).stream() })
    view.audio.emit({ type: "text.ended", messageID: "invalid", textID: "text", text: "Invalid." })
    await new Promise((resolve) => setTimeout(resolve, 0))
    view.audio.emit({ type: "activity.completed" })
    expect(view.element.querySelector('[data-playback-error]').textContent).toContain("sample rate")
    expect(view.audio.played).toBe(0)
    view.element.querySelector('[data-action="dismiss-playback-error"]').click()
    expect(view.element.querySelector('.oc-voice__playback-error').hidden).toBe(true)
  } finally { view.controller.abort() }
})

test("final text repairs a missing delta suffix without repeating spoken sentences", async () => {
  const view = await listening()
  try {
    view.audio.emit({ type: "text.delta", messageID: "answer", textID: "text", delta: "Hallo. Der Rest" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    view.audio.emit({ type: "text.ended", messageID: "answer", textID: "text", text: "Hallo. Der Rest ist angekommen." })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(view.audio.speech).toEqual(["Hallo.", "Der Rest ist angekommen."])
  } finally { view.controller.abort() }
})

test("text parts keep independent speech remainders without a duplicate transcript view", async () => {
  const view = await listening()
  try {
    view.audio.emit({ type: "text.delta", messageID: "answer", textID: "one", delta: "Erster Teil" })
    view.audio.emit({ type: "text.ended", messageID: "answer", textID: "two", text: "Zweiter Teil." })
    view.audio.emit({ type: "text.ended", messageID: "answer", textID: "one", text: "Erster Teil." })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(view.audio.speech).toEqual(["Zweiter Teil.", "Erster Teil."])
    expect(view.element.querySelector('.oc-voice__transcript')).toBeNull()
  } finally { view.controller.abort() }
})

test("a completed text part is not spoken twice on replay", async () => {
  const view = await listening()
  try {
    const event = { type: "text.ended", messageID: "answer", textID: "text", text: "Einmal." }
    view.audio.emit(event)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(view.audio.speech).toEqual(["Einmal."])
    view.audio.emit({ type: "activity.started" })
    view.audio.emit({ type: "text.delta", messageID: "answer", textID: "text", delta: "Einmal." })
    view.audio.emit(event)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(view.audio.speech).toEqual(["Einmal."])
  } finally { view.controller.abort() }
})

test("speaking before the first answer does not permanently suppress its playback or interrupt the session", async () => {
  const view = await listening()
  try {
    const feed = (samples) => view.audio.processor.onaudioprocess({ inputBuffer: { getChannelData: () => samples } })
    feed(new Float32Array(4096).fill(0.1))
    for (let i = 0; i < 4; i++) feed(new Float32Array(4096))
    view.audio.emit({ type: "text.delta", messageID: "answer", textID: "text", delta: "Hallo." })
    view.audio.emit({ type: "text.ended", messageID: "answer", textID: "text", text: "Hallo." })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(view.audio.speech).toEqual(["Hallo."])
    expect(view.audio.interrupted).toBe(0)
  } finally { view.controller.abort() }
})

test("paused answers are not replayed on resume", async () => {
  const view = await listening()
  try {
    view.element.querySelector('[data-action="pause"]').click()
    const event = { type: "text.ended", messageID: "answer", textID: "text", text: "Nicht nachholen." }
    view.audio.emit(event)
    await new Promise((resolve) => setTimeout(resolve, 0))
    view.element.querySelector('[data-action="start"]').click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    view.audio.emit(event)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(view.audio.speech).toEqual([])
  } finally { view.controller.abort() }
})

test("dictation revokes live voice, discards pending transcription, and requires explicit resume", async () => {
  const view = await listening()
  try {
    const feed = (samples) => view.audio.processor.onaudioprocess({ inputBuffer: { getChannelData: () => samples } })
    feed(new Float32Array(4096).fill(0.1))
    for (let i = 0; i < 4; i++) feed(new Float32Array(4096))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const dictation = await view.broker.acquire({ priority: 100, interruptible: false })
    expect(dictation.ok).toBe(true)
    expect(view.element.querySelector('.oc-voice').dataset.phase).toBe("paused")
    view.transcription.resolve({ ok: true, text: "Do not send this late transcription" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(view.audio.requests).toEqual([])
    view.audio.emit({ type: "text.ended", messageID: "paused", textID: "text", text: "Do not replay" })
    if (dictation.ok) dictation.release()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(view.element.querySelector('.oc-voice').dataset.phase).toBe("paused")
    expect(view.audio.speech).toEqual([])
    view.element.querySelector('[data-action="start"]').click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    view.audio.emit({ type: "text.ended", messageID: "resumed", textID: "text", text: "New answer." })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(view.audio.speech).toEqual(["New answer."])
  } finally { view.controller.abort(); view.broker.dispose() }
})

test("pausing cancels a stalled PCM reader and a new generation can speak", async () => {
  const view = await listening()
  let cancelled = false
  const stream = new ReadableStream({ cancel() { cancelled = true } })
  try {
    view.audio.respond = () => ({ ok: true, format: "pcm", sampleRate: 24000, channels: 1, mimeType: "audio/pcm", stream })
    view.audio.emit({ type: "text.ended", messageID: "stalled", textID: "text", text: "Stalled." })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(stream.locked).toBe(true)
    view.element.querySelector('[data-action="pause"]').click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(cancelled).toBe(true)
    expect(stream.locked).toBe(false)
    view.audio.respond = undefined
    view.element.querySelector('[data-action="start"]').click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    view.audio.emit({ type: "text.ended", messageID: "new", textID: "text", text: "Recovered." })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(view.audio.speech).toEqual(["Stalled.", "Recovered."])
    expect(view.audio.played).toBeGreaterThan(0)
  } finally { view.controller.abort() }
})

test("a TTS request that ignores abort cannot hold a resumed generation hostage", async () => {
  const view = await listening()
  const stalled = Promise.withResolvers()
  let cancelled = false
  try {
    view.audio.respond = () => stalled.promise
    view.audio.emit({ type: "text.ended", messageID: "stalled", textID: "text", text: "Old." })
    await new Promise((resolve) => setTimeout(resolve, 0))
    view.element.querySelector('[data-action="pause"]').click()
    view.audio.respond = undefined
    view.element.querySelector('[data-action="start"]').click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    view.audio.emit({ type: "text.ended", messageID: "new", textID: "text", text: "New." })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(view.audio.speech).toEqual(["Old.", "New."])
    const played = view.audio.played
    stalled.resolve({ ok: true, mimeType: "audio/pcm", stream: new ReadableStream({ cancel() { cancelled = true } }) })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(cancelled).toBe(true)
    expect(view.audio.played).toBe(played)
  } finally { view.controller.abort(); stalled.resolve({ ok: false, error: "Cancelled" }) }
})

test("empty PCM is a visible playback failure rather than silent success", async () => {
  const view = await listening()
  try {
    view.audio.respond = () => ({ ok: true, format: "pcm", sampleRate: 24000, channels: 1, mimeType: "audio/pcm", stream: new Blob([]).stream() })
    view.audio.emit({ type: "text.ended", messageID: "empty", textID: "text", text: "Empty." })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(view.element.querySelector('[data-playback-error]').textContent).toContain("Playback stopped:")
    expect(view.audio.played).toBe(0)
  } finally { view.controller.abort() }
})

test("a short microphone peak does not cut playback; sustained speech stops audio, not session work", async () => {
  const view = await listening()
  try {
    view.audio.emit({ type: "text.delta", messageID: "answer", textID: "text", delta: "First sentence. " })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const feed = (samples) => view.audio.processor.onaudioprocess({ inputBuffer: { getChannelData: () => samples } })
    feed(new Float32Array(4096).fill(0.1))
    expect(view.audio.stoppedSources).toBe(0)
    feed(new Float32Array(4096))
    feed(new Float32Array(4096).fill(0.1))
    feed(new Float32Array(4096).fill(0.1))
    expect(view.audio.stoppedSources).toBeGreaterThan(0)
    expect(view.audio.interrupted).toBe(0)
    view.audio.emit({ type: "text.ended", messageID: "answer", textID: "another-part", text: "Do not resume old audio." })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(view.audio.speech).toEqual(["First sentence."])
  } finally { view.controller.abort() }
})

test("stalled playback has a visible deadline and permits a later answer", async () => {
  const view = await listening()
  const timeout = VOICE_TIMING.playbackTimeoutMs
  const pending = Promise.withResolvers()
  try {
    VOICE_TIMING.playbackTimeoutMs = 20
    view.audio.respond = () => pending.promise
    view.audio.emit({ type: "text.ended", messageID: "timeout", textID: "text", text: "Timeout." })
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(view.element.querySelector('[data-playback-error]').textContent).toContain("timed out")
    view.audio.respond = undefined
    view.audio.emit({ type: "text.ended", messageID: "next", textID: "text", text: "Next." })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(view.audio.speech).toEqual(["Timeout.", "Next."])
  } finally {
    VOICE_TIMING.playbackTimeoutMs = timeout
    view.controller.abort()
    pending.resolve({ ok: false, error: "Cancelled" })
  }
})

function openerFixture() {
  const pair = { sourceSessionID: "ses_voice", targetSessionID: "ses_worker" }
  const model = { id: "pinned", providerID: "test" }
  const calls = { starts: [], creates: [], opened: [], navigation: [], get: [], current: { directory: "C:/Voice", sessionID: "ses_worker" } }
  const saved = new Map([["active-conversation.v1", { sessionID: "ses_foreign", model: { id: "wrong" } }]])
  const api = {
    kv: { get: (key) => saved.get(key), set: (key, value) => saved.set(key, value), delete: (key) => saved.delete(key) },
    settings: { get: (_, fallback) => fallback },
    ui: { models: { resolve: () => model }, floating: { open(options) { calls.opened.push(options); return { close() {} } } } },
    host: {
      navigation: { current: () => calls.current, openSession(input) { calls.navigation.push(input); calls.current = input } },
      sessions: { async create(input) { calls.creates.push(input); return { ok: true, sessionID: "ses_worker", model } }, links: {
        async get(input) { calls.get.push(input); return { ok: true, pair, model } },
        async start(input) { calls.starts.push(input); return { ok: true, pair, model } },
      } },
    },
  }
  api.services = { async call(request) {
    const { operation, ...input } = request.input
    const result = await api.host.sessions.links[operation]({ directory: request.directory, ...input })
    return result.ok ? { ok: true, data: { link: result.pair, model: result.model } } : result
  } }
  return { api, calls, pair, model, saved }
}

test("opening from either normal tab uses the server pair, not the legacy global snapshot, without audio or prompts", async () => {
  const f = openerFixture()
  const open = createConversationOpener(f.api)
  await open()
  await open()
  expect(f.calls.starts).toEqual([])
  expect(f.calls.get).toEqual([
    { directory: "C:/Voice", sessionID: "ses_worker" },
    { directory: "C:/Voice", sessionID: "ses_voice" },
  ])
  expect(f.calls.opened.map((item) => item.sessions)).toEqual([
    { directory: "C:/Voice", ids: ["ses_worker", "ses_voice"] },
    { directory: "C:/Voice", ids: ["ses_worker", "ses_voice"] },
  ])
})

test("opening from an empty project creates the worker and marks the voice mount for its first question", async () => {
  const f = openerFixture()
  f.calls.current = { directory: "C:/Voice" }
  f.api.host.sessions.links.get = async (input) => { f.calls.get.push(input); return { ok: true, pair: null } }
  await createConversationOpener(f.api)()
  expect(f.calls.creates).toEqual([{ directory: "C:/Voice", modelTarget: "default", agent: "build" }])
  expect(f.calls.starts[0]).toMatchObject({ directory: "C:/Voice", targetSessionID: "ses_worker" })
  expect(f.calls.navigation).toEqual([{ directory: "C:/Voice", sessionID: "ses_voice" }])
  expect(f.calls.opened[0].sessions).toEqual({ directory: "C:/Voice", ids: ["ses_worker", "ses_voice"] })
  expect(f.calls.opened[0].mount.toString()).toContain("firstQuestion")
})

test("concurrent opens coalesce and lost acknowledgements retry the same reserved voice ID", async () => {
  const f = openerFixture()
  f.api.host.sessions.links.get = async () => ({ ok: true, pair: null })
  const pending = Promise.withResolvers()
  f.api.host.sessions.links.start = (input) => { f.calls.starts.push(input); return pending.promise }
  const open = createConversationOpener(f.api)
  const first = open()
  expect(open()).toBe(first)
  pending.resolve({ ok: false, error: "Acknowledgement lost" })
  await first
  expect(f.calls.opened[0].id).toBe("conversation-error")
  f.api.host.sessions.links.start = async (input) => { f.calls.starts.push(input); return { ok: true, pair: f.pair, model: f.model } }
  await createConversationOpener(f.api)()
  expect(f.calls.starts).toHaveLength(2)
  expect(f.calls.starts[1]).toEqual(f.calls.starts[0])
  expect(f.calls.starts[0].targetSessionID).toBe("ses_worker")
  expect(f.calls.starts[0].sourceSessionID).toMatch(/^ses_/)
})

test("a pair response after leaving the worker does not navigate, open controls or start audio", async () => {
  const f = openerFixture()
  const pending = Promise.withResolvers()
  f.api.host.sessions.links.get = () => pending.promise
  const request = createConversationOpener(f.api)()
  f.calls.current = { directory: "C:/Other", sessionID: "ses_other" }
  pending.resolve({ ok: true, pair: f.pair, model: f.model })
  await request
  expect(f.calls.opened).toEqual([])
  expect(f.calls.navigation).toEqual([])
  expect(f.calls.starts).toEqual([])
})

test("a text part first seen during pause stays silent when its final suffix arrives after resume", async () => {
  const view = await listening()
  try {
    view.element.querySelector('[data-action="pause"]').click()
    view.audio.emit({ type: "text.delta", messageID: "paused-part", textID: "text", delta: "Hello" })
    view.element.querySelector('[data-action="start"]').click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    view.audio.emit({ type: "text.ended", messageID: "paused-part", textID: "text", text: "Hello world." })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(view.audio.speech).toEqual([])
  } finally { view.controller.abort() }
})
