import { describe, expect, test } from "bun:test"
import { collectAudio, createPlayer, pcmSamples } from "./playback.js"

function stream(...chunks) {
  return new ReadableStream({ start(controller) { chunks.forEach((chunk) => controller.enqueue(chunk)); controller.close() } })
}
describe("spoken summary audio", () => {
  test("deinterleaves PCM and rejects truncated or invalid channels", () => {
    const result = pcmSamples(new Uint8Array([0, 128, 255, 127]), 2)
    expect(result[0][0]).toBe(-1)
    expect(result[1][0]).toBeCloseTo(1, 3)
    expect(() => pcmSamples(new Uint8Array([1]), 1)).toThrow("Unvollständige")
    expect(() => pcmSamples(new Uint8Array([0, 0]), 0)).toThrow()
  })
  test("bounds streamed audio and rejects empty/aborted data", async () => {
    const signal = new AbortController().signal
    expect([...await collectAudio(stream(new Uint8Array([1]), new Uint8Array([2, 3])), signal)]).toEqual([1, 2, 3])
    await expect(collectAudio(stream(new Uint8Array([1, 2, 3])), signal, 2)).rejects.toThrow("Audiolimit")
    await expect(collectAudio(stream(), signal)).rejects.toThrow("leere")
    const controller = new AbortController()
    controller.abort()
    await expect(collectAudio(stream(new Uint8Array([1])), controller.signal)).rejects.toThrow("Abgebrochen")
  })
  test("activates audio before decoding and aborts scheduled playback", async () => {
    const state = { resumed: 0, starts: 0, stops: 0, closed: 0 }
    const context = {
      state: "suspended", destination: {},
      async resume() { this.state = "running"; state.resumed++ },
      async decodeAudioData() { return { duration: 1, length: 8000, numberOfChannels: 1 } },
      createBufferSource() { return { connect() {}, disconnect() {}, start() { state.starts++ }, stop() { state.stops++ } } },
      close() { state.closed++; this.state = "closed"; return Promise.resolve() },
    }
    const player = createPlayer(() => context)
    await player.unlock()
    expect(state.resumed).toBe(1)
    const abort = new AbortController()
    const buffer = await player.decode({ format: "mp3", stream: stream(new Uint8Array([1, 2])) }, abort.signal)
    const pending = player.playBuffer(buffer, abort.signal)
    expect(state.starts).toBe(1)
    abort.abort()
    await expect(pending).rejects.toThrow("Abgebrochen")
    expect(state.stops).toBe(1)
    await expect(player.decode({ format: "pcm", sampleRate: 10, channels: 1, stream: stream(new Uint8Array([0, 0])) }, new AbortController().signal)).rejects.toThrow("Samplerate")
    player.dispose()
    expect(state.closed).toBe(1)
  })
})
