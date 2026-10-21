import { describe, expect, test } from "bun:test"
import {
  VOICE_TIMING,
  advanceVoiceTurn,
  createPermissionQueue,
  drainSpeechSentences,
  matchReleasePhrase,
  pcm16le,
  prepareVoiceTurn,
  resolveModelTargetRequest,
  rms,
  shouldFlushVoiceSegment,
  wavBlob,
  voicePrompt,
} from "./core.js"

describe("voice conversation core", () => {
  test("keeps concurrent approvals in FIFO order and retains failed replies", async () => {
    const queue = createPermissionQueue()
    const first = { requestID: "per_first", sessionID: "ses_child", action: "edit" }
    const second = { requestID: "per_second", sessionID: "ses_child2", action: "bash" }
    queue.ask(first)
    queue.ask(second)
    queue.ask(first)
    expect(queue.current).toEqual(first)
    await queue.reply("once", async () => ({ ok: false, error: "offline" }))
    expect(queue.current).toEqual(first)
    const replies = []
    await queue.reply("once", async (request) => { replies.push(request); return { ok: true } })
    expect(queue.current).toEqual(second)
    queue.replied(first.requestID)
    expect(queue.current).toEqual(second)
    await queue.reply("reject", async (request) => { replies.push(request); return { ok: true } })
    expect(queue.current).toBeUndefined()
    expect(replies).toEqual([
      { sessionID: "ses_child", requestID: "per_first", reply: "once" },
      { sessionID: "ses_child2", requestID: "per_second", reply: "reject" },
    ])
  })

  test("keeps the required overlapping preview cadence and bounds playback requests", () => {
    expect(VOICE_TIMING).toEqual({
      previewWindowMs: 1500,
      previewOverlapMs: 250,
      segmentTargetMs: 30_000,
      segmentPauseMs: 150,
      segmentMaxMs: 60_000,
      playbackTimeoutMs: 90_000,
    })
    expect(VOICE_TIMING.previewWindowMs - VOICE_TIMING.previewOverlapMs).toBe(1250)
  })

  test("keeps a quiet continuous speaker in one turn until real trailing silence", () => {
    const sampleRate = 48_000
    const frame = new Float32Array(4_096).fill(0.01)
    const silence = new Float32Array(4_096)
    const silenceLimit = Math.round(0.675 * sampleRate)
    const initial = { speaking: true, silenceSamples: 0 }
    const continued = Array.from({ length: Math.ceil((61 * sampleRate) / frame.length) }).reduce(
      (state) => advanceVoiceTurn(state, frame, 0.015, silenceLimit),
      initial,
    )

    expect(continued).toEqual({ speaking: true, silenceSamples: 0, shouldFinish: false })
    const paused = advanceVoiceTurn(continued, silence, 0.015, silenceLimit)
    expect(paused.shouldFinish).toBe(false)
    expect(advanceVoiceTurn(paused, frame, 0.015, silenceLimit).silenceSamples).toBe(0)
    const finished = Array.from({ length: Math.ceil(silenceLimit / silence.length) }).reduce(
      (state) => advanceVoiceTurn(state, silence, 0.015, silenceLimit),
      paused,
    )
    expect(finished.shouldFinish).toBe(true)
  })

  test("bounds buffered audio by segmenting without finishing the spoken turn", () => {
    const sampleRate = 48_000
    expect(shouldFlushVoiceSegment(29 * sampleRate, 0, sampleRate)).toBe(false)
    expect(shouldFlushVoiceSegment(31 * sampleRate, 0.16 * sampleRate, sampleRate)).toBe(true)
    expect(shouldFlushVoiceSegment(61 * sampleRate, 0, sampleRate)).toBe(true)
  })

  test("resolves direct models and chains without silently using a default", () => {
    expect(resolveModelTargetRequest("model:openrouter/whisper", "missing")).toEqual({ model: "openrouter/whisper" })
    expect(resolveModelTargetRequest("chain:speech", "missing")).toEqual({ chain: "speech" })
    expect(() => resolveModelTargetRequest("", "missing")).toThrow("missing")
  })

  test("drains only complete speech sentences until final flush", () => {
    expect(drainSpeechSentences("First sentence. Second one is")).toEqual({
      sentences: ["First sentence."],
      remainder: "Second one is",
    })
    expect(drainSpeechSentences("Second one is ready", true)).toEqual({
      sentences: ["Second one is ready"],
      remainder: "",
    })
  })

  test("parses leading conversation controls while preserving the remaining request", () => {
    expect(prepareVoiceTurn("Antworte kürzer und sprich schneller und zeig mir die Bugs.")).toEqual({ text: "zeig mir die Bugs.", verbosity: "concise", speedDelta: 0.25, confirmations: ["Ich antworte kürzer.", "Ich spreche schneller."] })
    expect(prepareVoiceTurn("More details and speak slower")).toEqual({ text: "", verbosity: "detailed", speedDelta: -0.25, confirmations: ["Ich antworte ausführlicher.", "Ich spreche langsamer."] })
    expect(prepareVoiceTurn("Zeig mir schneller ladende Komponenten.")).toEqual({ text: "Zeig mir schneller ladende Komponenten.", confirmations: [] })
    expect(voicePrompt("Prüfe den Fehler.", "concise")).toContain("höchstens 2–3 kurzen Sätzen")
    expect(voicePrompt("Prüfe den Fehler.", "detailed")).toContain("mehr Details")
  })

  test("matches only the complete configured release phrase in safe user audio", () => {
    const input = { phrase: "OpenCode Freigabe Jetzt", pending: true, userOnset: true, playbackActive: false }
    expect(matchReleasePhrase({ ...input, transcript: "Open Code, Freigabe jetzt!" })).toBe(true)
    expect(matchReleasePhrase({ ...input, transcript: "Freigabe jetzt" })).toBe(false)
    expect(matchReleasePhrase({ ...input, transcript: "OpenCode Freigabe gleich" })).toBe(false)
    expect(matchReleasePhrase({ ...input, transcript: "OpenCode Freigabe Jetzt und weiter" })).toBe(false)
    expect(matchReleasePhrase({ ...input, transcript: "OpenCode Freigabe Jetzt", pending: false })).toBe(false)
    expect(matchReleasePhrase({ ...input, transcript: "OpenCode Freigabe Jetzt", userOnset: false })).toBe(false)
    expect(matchReleasePhrase({ ...input, transcript: "OpenCode Freigabe Jetzt", playbackActive: true })).toBe(false)
  })

  test("encodes mono wav and decodes little-endian pcm", async () => {
    const samples = new Float32Array([-1, 0, 1])
    const wav = wavBlob(samples, 24_000)
    expect(wav.type).toBe("audio/wav")
    expect(wav.size).toBe(50)
    expect(Array.from(pcm16le(new Uint8Array([0, 128, 0, 0, 255, 127])))).toEqual([-1, 0, 32767 / 32768])
    expect(rms(new Float32Array([1, -1]))).toBe(1)
    expect(new Uint8Array(await wav.arrayBuffer()).slice(0, 4)).toEqual(new Uint8Array([82, 73, 70, 70]))
  })
})
