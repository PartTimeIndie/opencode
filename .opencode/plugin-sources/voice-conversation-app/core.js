export const VOICE_TIMING = {
  previewWindowMs: 1500,
  previewOverlapMs: 250,
  segmentTargetMs: 30_000,
  segmentPauseMs: 150,
  segmentMaxMs: 60_000,
  playbackTimeoutMs: 90_000,
}

export function createPermissionQueue() {
  const pending = new Map()
  const state = { replying: false }
  return {
    get current() { return pending.values().next().value },
    ask(event) { pending.set(event.requestID, event) },
    replied(requestID) { pending.delete(requestID) },
    clear() { pending.clear() },
    async reply(reply, send) {
      const permission = pending.values().next().value
      if (!permission || state.replying) return { ok: true }
      state.replying = true
      try {
        const result = await send({ sessionID: permission.sessionID, requestID: permission.requestID, reply })
        if (result.ok) pending.delete(permission.requestID)
        return result
      } finally {
        state.replying = false
      }
    },
  }
}

export function resolveModelTargetRequest(value, message) {
  const reference = typeof value === "string" ? value.trim() : ""
  if (!reference) throw new Error(message)
  if (reference.startsWith("model:")) {
    const model = reference.slice("model:".length)
    if (!validModel(model)) throw new Error(message)
    return { model }
  }
  if (reference.startsWith("chain:")) {
    const chain = reference.slice("chain:".length).trim()
    if (!chain) throw new Error(message)
    return { chain }
  }
  if (!reference.includes("/")) return { chain: reference }
  if (!validModel(reference)) throw new Error(message)
  return { model: reference }
}

const VOICE_CONTROLS = [
  { pattern: /^(?:bitte\s+)?(?:antworte\s+)?(?:kürzer|knapper)\b[\s,.:;-]*/iu, value: { verbosity: "concise", confirmation: "Ich antworte kürzer." } },
  { pattern: /^(?:bitte\s+)?(?:antworte\s+)?(?:ausführlicher|länger|mit\s+mehr\s+details?|more\s+details?|answer\s+longer)\b[\s,.:;-]*/iu, value: { verbosity: "detailed", confirmation: "Ich antworte ausführlicher." } },
  { pattern: /^(?:bitte\s+)?(?:sprich\s+|speak\s+)?(?:schneller|faster)\b[\s,.:;-]*/iu, value: { speedDelta: 0.25, confirmation: "Ich spreche schneller." } },
  { pattern: /^(?:bitte\s+)?(?:sprich\s+|speak\s+)?(?:langsamer|slower)\b[\s,.:;-]*/iu, value: { speedDelta: -0.25, confirmation: "Ich spreche langsamer." } },
]

export function prepareVoiceTurn(value) {
  const result = { text: typeof value === "string" ? value.trim() : "", confirmations: [] }
  while (result.text) {
    const control = VOICE_CONTROLS.find((item) => item.pattern.test(result.text))
    if (!control) break
    result.text = result.text.replace(control.pattern, "").replace(/^(?:und|and)\b[\s,.:;-]*/iu, "").trim()
    if (control.value.verbosity) result.verbosity = control.value.verbosity
    if (control.value.speedDelta) result.speedDelta = (result.speedDelta ?? 0) + control.value.speedDelta
    result.confirmations.push(control.value.confirmation)
  }
  return result
}

export function voicePrompt(text, verbosity = "concise") {
  const instruction = verbosity === "detailed" ? "Antworte natürlich mit mehr Details, aber ohne unnötige Wiederholungen." : "Antworte natürlich und direkt in höchstens 2–3 kurzen Sätzen. Verwende nur auf ausdrücklichen Wunsch eine Liste."
  return `${instruction}\n\n${text}`
}

export function matchReleasePhrase({ transcript, phrase, pending, userOnset, playbackActive }) {
  if (!pending || !userOnset || playbackActive) return false
  const expected = normalizeVoicePhrase(phrase)
  return Boolean(expected && normalizeVoicePhrase(transcript) === expected)
}

function normalizeVoicePhrase(value) {
  return String(value ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\bopen\s+code\b/gu, "opencode").replace(/[^\p{L}\d]+/gu, " ").trim().replace(/\s+/gu, " ")
}

export function drainSpeechSentences(value, flush = false) {
  const text = typeof value === "string" ? value : ""
  const sentences = []
  let offset = 0
  for (const match of text.matchAll(/[^.!?\n]+(?:[.!?]+(?=\s|$)|\n+)/g)) {
    const sentence = match[0].trim()
    const end = (match.index ?? 0) + match[0].length
    if (sentence) sentences.push(sentence)
    offset = end
  }
  const remainder = text.slice(offset).trimStart()
  if (!flush || !remainder.trim()) return { sentences, remainder }
  return { sentences: [...sentences, remainder.trim()], remainder: "" }
}

export function rms(samples) {
  if (!samples.length) return 0
  return Math.sqrt(samples.reduce((total, sample) => total + sample * sample, 0) / samples.length)
}

export function advanceVoiceTurn(state, samples, threshold, silenceLimit) {
  // Speech naturally becomes quieter after its initial onset. Hysteresis keeps
  // those frames in the current turn without making idle noise start a turn.
  const active = rms(samples) >= threshold * 0.55
  const silenceSamples = active ? 0 : state.silenceSamples + samples.length
  return {
    speaking: state.speaking,
    silenceSamples,
    shouldFinish: !active && silenceSamples >= silenceLimit,
  }
}

export function shouldFlushVoiceSegment(utteranceSamples, silenceSamples, sampleRate) {
  const milliseconds = (samples) => Math.round((samples / 1000) * sampleRate)
  if (utteranceSamples >= milliseconds(VOICE_TIMING.segmentMaxMs)) return true
  return (
    utteranceSamples >= milliseconds(VOICE_TIMING.segmentTargetMs) &&
    silenceSamples >= milliseconds(VOICE_TIMING.segmentPauseMs)
  )
}

export function mergeSamples(chunks) {
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0)
  const result = new Float32Array(size)
  chunks.reduce((offset, chunk) => {
    result.set(chunk, offset)
    return offset + chunk.length
  }, 0)
  return result
}

export function wavBlob(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  writeText(view, 0, "RIFF")
  view.setUint32(4, 36 + samples.length * 2, true)
  writeText(view, 8, "WAVE")
  writeText(view, 12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeText(view, 36, "data")
  view.setUint32(40, samples.length * 2, true)
  samples.forEach((sample, index) =>
    view.setInt16(44 + index * 2, Math.round(Math.max(-1, Math.min(1, sample)) * 0x7fff), true),
  )
  return new Blob([buffer], { type: "audio/wav" })
}

export function pcm16le(bytes) {
  const samples = new Float32Array(Math.floor(bytes.byteLength / 2))
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  samples.forEach((_, index) => {
    samples[index] = view.getInt16(index * 2, true) / 0x8000
  })
  return samples
}

function validModel(value) {
  const separator = value.indexOf("/")
  return separator > 0 && separator < value.length - 1
}

function writeText(view, offset, text) {
  for (let index = 0; index < text.length; index++) view.setUint8(offset + index, text.charCodeAt(index))
}
