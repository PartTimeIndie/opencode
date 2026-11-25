import { expect, test } from "bun:test"
import type { AppHostComposerSendPreparation, AppHostComposerTarget } from "@opencode-ai/plugin/app"
import { createAudioCaptureBroker } from "./audio-capture"

for (const scenario of ["send", "improvement-failure", "mic-stop", "stop-send", "insertion-race", "permission", "cancel", "unload", "polish-send", "clipboard-off", "clipboard-fail", "clipboard-host"]) {
  test(`Speech preparation: ${scenario}`, async () => {
    const speech = await import(new URL("../../../../.opencode/plugin-sources/speech-to-text-app/index.js", import.meta.url).href)
    const recorderDescriptor = Object.getOwnPropertyDescriptor(globalThis, "MediaRecorder")
    const mediaDescriptor = Object.getOwnPropertyDescriptor(navigator, "mediaDevices")
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard")
    const copied: string[] = []
    const hostCopied: string[] = []
    const polish = Promise.withResolvers<{ ok: boolean; text: string }>()
    const transcript = Promise.withResolvers<{ ok: boolean; text: string }>()
    const media = Promise.withResolvers<MediaStream>()
    const insertion = Promise.withResolvers<{ ok: boolean; insertionReceiptID: string }>()
    const stream = { getTracks: () => [Object.assign(new EventTarget(), { stop() {} })] } as unknown as MediaStream
    const audio = createAudioCaptureBroker(() => scenario === "permission" ? media.promise : Promise.resolve(stream))
    const context = { directory: "C:/Voice", sessionID: "ses_first", composerID: "ses_first" }
    const surface = new AbortController()
    const approval = new AbortController()
    const element = document.createElement("div")
    document.body.append(element)
    const inserted: string[] = []
    let preparation: AppHostComposerSendPreparation | undefined
    let mount = (_input: { element: HTMLElement; context: AppHostComposerTarget; signal: AbortSignal }) => {}
    let dispose = async () => {}
    let stops = 0
    let improvements = 0
    let enabled = ["send", "improvement-failure"].includes(scenario)
    class Recorder extends EventTarget {
      mimeType = "audio/webm"
      static isTypeSupported() { return true }
      start() {}
      stop() {
        stops++
        this.dispatchEvent(Object.assign(new Event("dataavailable"), { data: new Blob(["audio"], { type: this.mimeType }) }))
        this.dispatchEvent(new Event("stop"))
      }
    }
    Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: Recorder })
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      getUserMedia() {}, enumerateDevices: async () => [], addEventListener() {}, removeEventListener() {},
    } })
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { async writeText(text: string) {
      if (scenario === "clipboard-fail") throw new Error("clipboard denied")
      // Chromium rejects the web Clipboard API while the document is not focused.
      if (scenario === "clipboard-host") throw Object.assign(new Error("Document is not focused."), { name: "NotAllowedError" })
      copied.push(text)
    } } })
    try {
      speech.default.app({
        settings: {
          get: (key: string, fallback: unknown) => key === "automaticImprovement" ? enabled
            : key === "transcriptionChain" ? "model:test/stt"
            : key === "copyTranscriptsToClipboard" && scenario === "clipboard-off" ? false
            : key === "includeSlashCommandsOpenCode" ? false : key === "improvementChain" ? "model:test/polish" : fallback,
          register: () => () => {}, subscribe: () => () => {}, set() {},
        },
        toolbar: { register(item: { mount: typeof mount }) { mount = item.mount } },
        commands: { register() {} }, lifecycle: { onDispose(handler: typeof dispose) { dispose = handler } },
        host: {
          audio, navigation: { current: () => context },
          stt: { transcribe: () => transcript.promise },
          ai: { async run() { improvements++; return scenario === "polish-send" ? polish.promise : scenario === "improvement-failure" ? { ok: false, error: "polish unavailable" } : { ok: true, text: "Polished result" } } },
          skills: { list: async () => [], resolve: async () => [] },
          desktopServices: scenario === "clipboard-host" ? {
            async writeClipboardText(text: string) { hostCopied.push(text); return { ok: true } },
          } : undefined,
          composer: {
            registerSendPreparation(target: AppHostComposerTarget, value: AppHostComposerSendPreparation) {
              expect(target).toMatchObject(context)
              preparation = value
              return () => {}
            },
            async insertText(input: { text: string; operationID: string }) {
              inserted.push(input.text)
              expect(input.operationID).toBe(preparation!.operationID)
              if (scenario === "insertion-race") return insertion.promise
              if (scenario === "polish-send" && inserted.length === 2) return { ok: true, insertionReceiptID: "host-receipt" }
              return { ok: true }
            },
          },
        },
      })
      mount({ element, context, signal: surface.signal })
      const mic = element.querySelector<HTMLButtonElement>("button")!
      mic.click()
      await Bun.sleep(20)
      expect(preparation?.isActive()).toBe(true)
      if (["mic-stop", "stop-send", "insertion-race", "polish-send"].includes(scenario)) {
        mic.click()
        await Bun.sleep(20)
      }
      if (scenario === "insertion-race") {
        transcript.resolve({ ok: true, text: "Raw result" })
        await Bun.sleep(20)
        expect(inserted).toEqual(["Raw result"])
      }
      if (scenario === "polish-send") {
        transcript.resolve({ ok: true, text: "Raw result" })
        await Bun.sleep(30)
        expect(inserted).toEqual(["Raw result"])
        mic.click()
        await Bun.sleep(20)
        expect(preparation?.isActive()).toBe(true)
      }
      const result = scenario === "mic-stop" ? undefined : preparation!.prepare({ intentID: "intent-1", signal: approval.signal })
      // Settings edits and toolbar disposal must not alter the approved operation.
      enabled = false
      surface.abort()
      if (scenario === "cancel") approval.abort()
      if (scenario === "unload") await dispose()
      media.resolve(stream)
      transcript.resolve({ ok: true, text: "Raw result" })
      insertion.resolve({ ok: true, insertionReceiptID: "host-receipt" })
      polish.resolve({ ok: true, text: "Polished result" })
      if (scenario === "mic-stop") {
        await Bun.sleep(30)
        expect(inserted).toEqual(["Raw result"])
      } else if (scenario === "improvement-failure") {
        // The dictation is kept: the host blocks the send and inserts the raw
        // transcript as an unsent draft after the send transaction unwound.
        expect(await result).toEqual({ ok: false, error: "Improvement failed - raw transcript inserted, not sent", insertDraft: "Raw result" })
        expect(inserted).toEqual([])
        expect(copied).toEqual(["Raw result"])
      } else if (["permission", "cancel", "unload"].includes(scenario)) {
        expect(await result).toMatchObject({ ok: false })
        expect(inserted).toEqual([])
      } else {
        expect(await result).toEqual(["insertion-race", "polish-send"].includes(scenario) ? { ok: true, insertionReceiptID: "host-receipt" } : { ok: true, text: scenario === "send" ? "Polished result" : "Raw result" })
        expect(inserted).toEqual(scenario === "insertion-race" ? ["Raw result"] : scenario === "polish-send" ? ["Raw result", "Polished result"] : [])
      }
      if (["clipboard-off", "clipboard-fail"].includes(scenario)) expect(copied).toEqual([])
      if (scenario === "clipboard-host") {
        expect(hostCopied).toEqual(["Raw result"])
        expect(copied).toEqual([])
      }
      if (scenario === "polish-send") expect(copied).toEqual(["Raw result", "Polished result"])
      if (scenario === "send") expect(copied).toEqual(["Polished result"])
      expect(stops).toBe(scenario === "permission" ? 0 : 1)
      expect(improvements).toBe(["send", "improvement-failure", "polish-send"].includes(scenario) ? 1 : 0)
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
}
