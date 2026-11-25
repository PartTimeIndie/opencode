import { expect, test } from "bun:test"
import type { AppHostAIRunInput, AppHostComposerSendPreparation, AppHostComposerTarget } from "@opencode-ai/plugin/app"
import { createAudioCaptureBroker } from "./audio-capture"

const exhausted = "Error: Incomplete model response: output token budget exhausted (8192 tokens; 8192 reasoning tokens). Increase the output budget or select a lower reasoning variant."
const direct = "model:cerebras/qwen-3.8-27b"
const rawStatus = "Improvement failed - raw transcript inserted, not sent"

test.each([
  { name: "successful retry", target: direct, error: exhausted, retry: true, success: true },
  { name: "failed retry", target: direct, error: exhausted, retry: true, success: false },
  { name: "configured chain", target: "chain:rewrite", error: exhausted, retry: false, success: false },
  { name: "other model", target: "model:test/polish", error: exhausted, retry: false, success: false },
  { name: "unrelated error", target: direct, error: "Provider unavailable", retry: false, success: false },
  { name: "partially spent on reasoning", target: direct, error: exhausted.replace("8192 reasoning", "8000 reasoning"), retry: false, success: false },
])("Speech send improvement: $name", async ({ target, error, retry, success }) => {
  const speech = await import(new URL("../../../../.opencode/plugin-sources/speech-to-text-app/index.js", import.meta.url).href)
  const recorderDescriptor = Object.getOwnPropertyDescriptor(globalThis, "MediaRecorder")
  const mediaDescriptor = Object.getOwnPropertyDescriptor(navigator, "mediaDevices")
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard")
  const transcript = Promise.withResolvers<{ ok: boolean; text: string }>()
  const stream = { getTracks: () => [Object.assign(new EventTarget(), { stop() {} })] } as unknown as MediaStream
  const audio = createAudioCaptureBroker(() => Promise.resolve(stream))
  const context = { directory: "C:/Voice", sessionID: "ses_first", composerID: "ses_first" }
  const surface = new AbortController()
  const approval = new AbortController()
  const element = document.createElement("div")
  document.body.append(element)
  const inserted: string[] = []
  const requests: AppHostAIRunInput[] = []
  let preparation: AppHostComposerSendPreparation | undefined
  let mount = (_input: { element: HTMLElement; context: AppHostComposerTarget; signal: AbortSignal }) => {}
  let dispose = async () => {}
  class Recorder extends EventTarget {
    mimeType = "audio/webm"
    static isTypeSupported() { return true }
    start() {}
    stop() {
      this.dispatchEvent(Object.assign(new Event("dataavailable"), { data: new Blob(["audio"], { type: this.mimeType }) }))
      this.dispatchEvent(new Event("stop"))
    }
  }
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: Recorder })
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
    getUserMedia() {}, enumerateDevices: async () => [], addEventListener() {}, removeEventListener() {},
  } })
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { async writeText() {} } })
  try {
    speech.default.app({
      settings: {
        get: (key: string, fallback: unknown) => key === "automaticImprovement" ? true
          : key === "transcriptionChain" ? "model:test/stt"
          : key === "includeSlashCommandsOpenCode" ? false : key === "improvementChain" ? target : fallback,
        register: () => () => {}, subscribe: () => () => {}, set() {},
      },
      toolbar: { register(item: { mount: typeof mount }) { mount = item.mount } },
      commands: { register() {} }, lifecycle: { onDispose(handler: typeof dispose) { dispose = handler } },
      host: {
        audio, navigation: { current: () => context },
        stt: { transcribe: () => transcript.promise },
        ai: { async run(input: AppHostAIRunInput) {
          requests.push(input)
          return input.variant === "none" && success ? { ok: true, text: "Improved text" } : { ok: false, error }
        } },
        skills: { list: async () => [], resolve: async () => [] },
        composer: {
          registerSendPreparation(target: AppHostComposerTarget, value: AppHostComposerSendPreparation) {
            expect(target).toMatchObject(context)
            preparation = value
            return () => {}
          },
          async insertText(input: { text: string }) { inserted.push(input.text); return { ok: true } },
        },
      },
    })
    mount({ element, context, signal: surface.signal })
    const mic = element.querySelector<HTMLButtonElement>("button")!
    mic.click()
    await Bun.sleep(20)
    expect(preparation?.isActive()).toBe(true)
    const result = preparation!.prepare({ intentID: "intent-fallback", signal: approval.signal })
    transcript.resolve({ ok: true, text: "Raw result" })
    const statusText = retry ? `${rawStatus} (retry without reasoning failed)` : rawStatus
    // On terminal failure only the host can insert the unsent draft, after rollback.
    expect(await result).toEqual(success
      ? { ok: true, text: "Improved text" }
      : { ok: false, error: statusText, insertDraft: "Raw result" })
    expect(requests).toHaveLength(retry ? 2 : 1)
    expect(requests[0]?.variant).toBeUndefined()
    if (retry) {
      expect(requests[0]?.model).toBe("cerebras/qwen-3.8-27b")
      expect(requests[1]).toEqual({ ...requests[0], variant: "none" })
      expect(requests[1]?.signal).toBe(requests[0]?.signal)
    }
    await Bun.sleep(20)
    expect(inserted).toEqual([])
    const status = element.querySelector<HTMLElement>(".oc-speech-to-text__status")!
    expect(status.textContent).toBe(success ? "" : statusText)
    // Nothing is left for a manual "Retry insertion": the host keeps the draft.
    const recovery = [...element.querySelectorAll<HTMLButtonElement>(".oc-speech-to-text__recovery")]
    expect(recovery.map((button) => button.hidden)).toEqual([true, true, true])
    expect(recovery[0]?.textContent).toBe("Retry transcription")
    expect(preparation?.isActive()).toBe(false)
  } finally {
    surface.abort()
    approval.abort()
    await dispose()
    audio.dispose()
    element.remove()
    if (recorderDescriptor) Object.defineProperty(globalThis, "MediaRecorder", recorderDescriptor)
    else Reflect.deleteProperty(globalThis, "MediaRecorder")
    if (mediaDescriptor) Object.defineProperty(navigator, "mediaDevices", mediaDescriptor)
    else Reflect.deleteProperty(navigator, "mediaDevices")
    if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor)
    else Reflect.deleteProperty(navigator, "clipboard")
  }
})
