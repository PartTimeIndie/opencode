import { expect, test } from "bun:test"
import path from "node:path"
import { createAudioCaptureBroker } from "./audio-capture"

test.each(["missing-stop", "stop-throws", "recorder-error", "conversion-stalls"])(
  "recovers from %s and ignores late recorder events",
  async (failure) => {
    const speech = await import(
      `${path.resolve("../../.opencode/plugin-sources/speech-to-text-app/index.js")}?recovery=${failure}`
    )
    const originalRecorder = Object.getOwnPropertyDescriptor(globalThis, "MediaRecorder")
    const originalAudioContext = Object.getOwnPropertyDescriptor(window, "AudioContext")
    const originalMedia = Object.getOwnPropertyDescriptor(navigator, "mediaDevices")
    const recorders: Recorder[] = []
    const stopped: number[] = []
    const updates: Array<{ id: string; phase: string }> = []
    const inserted: string[] = []
    const transcriptionDirectories: string[] = []
    let transcriptions = 0
    let invoke = async (_input: { id: string; action: string; target: { kind: string; application: string } }) => {}
    let dispose = async () => {}
    class Recorder extends EventTarget {
      mimeType = failure === "conversion-stalls" && recorders.length === 0 ? "audio/aac" : "audio/webm"
      static isTypeSupported() {
        return true
      }
      constructor() {
        super()
        recorders.push(this)
      }
      start() {}
      stop() {
        if (this === recorders[0] && failure === "stop-throws") throw new Error("Recorder stop failed")
        if (this === recorders[0] && failure === "missing-stop") return
        if (this === recorders[0] && failure === "recorder-error") {
          this.dispatchEvent(new Event("error"))
          return
        }
        this.finish()
      }
      finish() {
        this.dispatchEvent(
          Object.assign(new Event("dataavailable"), { data: new Blob(["audio"], { type: this.mimeType }) }),
        )
        this.dispatchEvent(new Event("stop"))
      }
    }
    Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: Recorder })
    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: class {
        decodeAudioData() {
          if (failure === "conversion-stalls" && recorders.length === 1) return new Promise(() => {})
          return Promise.resolve({
            sampleRate: 16_000,
            length: 4,
            numberOfChannels: 1,
            getChannelData: () => new Float32Array(4),
          })
        }
        async close() {}
      },
    })
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        async getUserMedia() {
          const index = recorders.length
          const track = Object.assign(new EventTarget(), { stop: () => stopped.push(index) })
          return { getTracks: () => [track] }
        },
        enumerateDevices: async () => [],
        addEventListener() {},
        removeEventListener() {},
      },
    })
    const values = new Map<string, unknown>([
      ["desktopServiceEnabled", true],
      ["transcriptionChain", "model:openrouter/qwen/qwen3-asr-0.6b"],
    ])
    speech.SPEECH_TO_TEXT_TIMEOUTS.recordingStopMs = 20
    speech.SPEECH_TO_TEXT_TIMEOUTS.audioPreparationMs = 20
    try {
      speech.default.app({
        settings: {
          get: (key: string, fallback: unknown) => (values.has(key) ? values.get(key) : fallback),
          set: (key: string, value: unknown) => values.set(key, value),
          register: () => () => {},
          subscribe: () => () => {},
        },
        host: {
          audio: createAudioCaptureBroker((constraints) => navigator.mediaDevices.getUserMedia(constraints)),
          navigation: { current: () => ({ directory: "C:/speech-test" }) },
          desktopServices: {
            async register(input: { id: string; onInvoke: typeof invoke }) {
              if (input.id === "global-dictation") invoke = input.onInvoke
              return {
                ok: true,
                accelerator: "Ctrl+Shift+Space",
                async update(id: string, state: { phase: string }) {
                  updates.push({ id, ...state })
                  // Overlay IPC must not hold a completed operation busy.
                  if (state.phase === "success") await new Promise(() => {})
                },
                async insertText(_id: string, text: string) {
                  inserted.push(text)
                  return { ok: true }
                },
                async dispose() {},
              }
            },
          },
          stt: {
            async transcribe(input: { directory: string }) {
              transcriptionDirectories.push(input.directory)
              transcriptions += 1
              return { ok: true, text: "Recovered text" }
            },
          },
        },
        toolbar: { register: () => () => {} },
        commands: { register: () => () => {} },
        lifecycle: {
          onDispose(handler: typeof dispose) {
            dispose = handler
          },
        },
      })
      await Bun.sleep(450)
      const target = { kind: "external", application: "Notepad" }
      await invoke({ id: "first", action: "start", target })
      await Bun.sleep(10)
      await invoke({ id: "first", action: "toggle", target })
      await Bun.sleep(60)
      expect(updates.some((item) => item.id === "first" && item.phase === "error")).toBe(true)
      expect(transcriptions).toBe(0)
      expect(stopped).toEqual([0])
      await invoke({ id: "second", action: "start", target })
      await Bun.sleep(10)
      expect(recorders).toHaveLength(2)
      recorders[0]!.finish()
      await Bun.sleep(10)
      expect(stopped).toEqual([0])
      expect(transcriptions).toBe(0)
      await invoke({ id: "second", action: "toggle", target })
      await Bun.sleep(20)
      expect(inserted).toEqual(["Recovered text"])
      expect(transcriptionDirectories).toEqual(["global"])
      expect(stopped).toEqual([0, 1])
      // A fresh recording starts after the existing double-press polish window.
      await Bun.sleep(speech.STT_DOUBLE_PRESS_WINDOW_MS + 20)
      await invoke({ id: "third", action: "start", target })
      await Bun.sleep(10)
      expect(recorders).toHaveLength(3)
    } finally {
      await dispose()
      speech.SPEECH_TO_TEXT_TIMEOUTS.recordingStopMs = 10_000
      speech.SPEECH_TO_TEXT_TIMEOUTS.audioPreparationMs = 30_000
      if (originalRecorder) Object.defineProperty(globalThis, "MediaRecorder", originalRecorder)
      else Reflect.deleteProperty(globalThis, "MediaRecorder")
      if (originalAudioContext) Object.defineProperty(window, "AudioContext", originalAudioContext)
      else Reflect.deleteProperty(window, "AudioContext")
      if (originalMedia) Object.defineProperty(navigator, "mediaDevices", originalMedia)
      else Reflect.deleteProperty(navigator, "mediaDevices")
    }
  },
)
