import { afterEach, expect, test } from "bun:test"

const originalAudioContext = Object.getOwnPropertyDescriptor(window, "AudioContext")

afterEach(() => {
  if (originalAudioContext) Object.defineProperty(window, "AudioContext", originalAudioContext)
  else Reflect.deleteProperty(window, "AudioContext")
})

test("normalizes a browser MediaRecorder container to PCM16 mono WAV before transcription", async () => {
  const speech = await import(
    `${new URL("../../../../.opencode/plugin-sources/speech-to-text-app/index.js", import.meta.url).href}?audio=${Date.now()}`
  )
  let closed = false
  Object.defineProperty(window, "AudioContext", {
    configurable: true,
    value: class {
      async decodeAudioData() {
        return {
          sampleRate: 48_000,
          length: 4_800,
          numberOfChannels: 2,
          getChannelData: (channel: number) =>
            Float32Array.from({ length: 4_800 }, (_, index) => Math.sin((index / 48_000) * 440 * Math.PI * 2) * (channel ? 0.25 : 0.5)),
        }
      }
      async close() {
        closed = true
      }
    },
  })

  const result = await speech.prepareAudio(
    new Blob(["valid browser container"], { type: "audio/webm;codecs=opus" }),
    new AbortController().signal,
    true,
  )
  const bytes = new Uint8Array(await result.audio.arrayBuffer())
  const view = new DataView(bytes.buffer)

  expect(result.mimeType).toBe("audio/wav")
  expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("RIFF")
  expect(new TextDecoder().decode(bytes.slice(8, 12))).toBe("WAVE")
  expect(view.getUint16(20, true)).toBe(1)
  expect(view.getUint16(22, true)).toBe(1)
  expect(view.getUint32(24, true)).toBe(16_000)
  expect(view.getUint16(34, true)).toBe(16)
  expect(bytes.byteLength).toBe(44 + 1_600 * 2)
  expect(closed).toBe(true)
})

test("keeps an explicitly uploaded supported audio file in its original container", async () => {
  const speech = await import(
    `${new URL("../../../../.opencode/plugin-sources/speech-to-text-app/index.js", import.meta.url).href}?upload=${Date.now()}`
  )
  const audio = new Blob(["uploaded wav"], { type: "audio/wav" })
  const result = await speech.prepareAudio(audio, new AbortController().signal)

  expect(result).toEqual({ audio, mimeType: "audio/wav" })
})
