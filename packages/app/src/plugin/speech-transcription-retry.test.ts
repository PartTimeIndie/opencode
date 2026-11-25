import { expect, test } from "bun:test"
import { createAudioCaptureBroker } from "./audio-capture"

test("retains one failed OpenCode recording and then the finished text for explicit recovery", async () => {
  const speech = await import(
    `${new URL("../../../../.opencode/plugin-sources/speech-to-text-app/index.js", import.meta.url).href}?retry=${Date.now()}`
  )
  const originalRecorder = Object.getOwnPropertyDescriptor(globalThis, "MediaRecorder")
  const originalMedia = Object.getOwnPropertyDescriptor(navigator, "mediaDevices")
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard")
  const broker = createAudioCaptureBroker(
    async () => ({ getTracks: () => [Object.assign(new EventTarget(), { stop() {} })] }) as unknown as MediaStream,
  )
  const context = { directory: "C:/Voice", sessionID: "ses_retry", composerID: "ses_retry" }
  const controller = new AbortController()
  const element = document.createElement("div")
  document.body.append(element)
  const copied: string[] = []
  const targets: Array<{ model?: string; chain?: string; mimeType: string }> = []
  let transcriptionTarget = "model:openrouter/mistralai/voxtral-small-24b-2507-stt"
  let transcriptions = 0
  let insertions = 0
  let mount: (input: { element: HTMLElement; context: typeof context; signal: AbortSignal }) => void = () => {}
  let dispose = async () => {}
  class Recorder extends EventTarget {
    mimeType = "audio/webm"
    static isTypeSupported() {
      return true
    }
    constructor() {
      super()
      ;(Recorder.prototype as unknown as { lastInstance?: unknown }).lastInstance = this
    }
    start() {}
    stop() {
      this.dispatchEvent(
        Object.assign(new Event("dataavailable"), { data: new Blob(["audio"], { type: this.mimeType }) }),
      )
      this.dispatchEvent(new Event("stop"))
    }
  }
  ;(Recorder.prototype as unknown as { lastInstance?: unknown }).lastInstance = undefined
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: Recorder })
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia() {},
      enumerateDevices: async () => [],
      addEventListener() {},
      removeEventListener() {},
    },
  })
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => copied.push(text) },
  })
  try {
    speech.default.app({
      settings: {
        get: (key: string, fallback: unknown) =>
          key === "transcriptionChain" ? transcriptionTarget : key === "desktopServiceEnabled" ? false : fallback,
        register: () => () => {},
        subscribe: () => () => {},
      },
      toolbar: {
        register: (item: { mount: typeof mount }) => {
          mount = item.mount
        },
      },
      commands: { register() {} },
      lifecycle: {
        onDispose: (handler: typeof dispose) => {
          dispose = handler
        },
      },
      host: {
        audio: broker,
        navigation: { current: () => context },
        stt: {
          transcribe: async (input: { model?: string; chain?: string; mimeType: string }) => {
            targets.push(input)
            transcriptions += 1
            if (transcriptions % 2 === 1)
              return {
                ok: false,
                error:
                  'OpenRouter transcription failed for mistralai/voxtral-small-24b-2507-stt with status 400: {"error":{"message":"Provider could not process the audio input (unsupported or malformed audio)"}}',
              }
            return { ok: true, text: "Recovered transcript" }
          },
        },
        composer: {
          insertText: async () => {
            insertions += 1
            return insertions === 1
              ? { ok: false, error: "The pinned composer is no longer available" }
              : { ok: true }
          },
        },
      },
    })
    mount({ element, context, signal: controller.signal })
    const record = element.querySelector<HTMLButtonElement>('[data-action="speech-to-text"]')!
    record.click()
    await Bun.sleep(20)
    record.click()
    await Bun.sleep(30)

    const status = element.querySelector<HTMLElement>('[role="status"]')!
    const retry = [...element.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.startsWith("Retry"),
    )!
    const copy = [...element.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent === "Copy transcript",
    )!
    const discard = [...element.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent === "Discard recording",
    )!
    expect(status.textContent).toBe(
      "The transcription provider could not read this recording. Retry the saved recording or choose another configured transcription chain.",
    )
    expect(retry.hidden).toBe(false)
    expect(retry.textContent).toBe("Retry transcription")
    expect(copy.hidden).toBe(true)
    expect(discard.hidden).toBe(false)
    expect(record.disabled).toBe(true)

    transcriptionTarget = "model:openrouter/qwen/qwen3-asr-0.6b"
    retry.click()
    await Bun.sleep(30)
    expect(transcriptions).toBe(2)
    expect(insertions).toBe(1)
    expect(retry.textContent).toBe("Retry insertion")
    expect(copy.hidden).toBe(false)
    expect(record.disabled).toBe(true)

    copy.click()
    await Bun.sleep(10)
    expect(copied).toEqual(["Recovered transcript", "Recovered transcript"])
    retry.click()
    await Bun.sleep(20)
    expect(transcriptions).toBe(2)
    expect(insertions).toBe(2)
    expect(retry.hidden).toBe(true)
    expect(record.disabled).toBe(false)
    expect(targets.map((target) => ({ model: target.model, chain: target.chain }))).toEqual([
      { model: "openrouter/mistralai/voxtral-small-24b-2507-stt", chain: undefined },
      { model: "openrouter/qwen/qwen3-asr-0.6b", chain: undefined },
    ])

    await Bun.sleep(speech.STT_DOUBLE_PRESS_WINDOW_MS + 20)
    record.click()
    await Bun.sleep(20)
    record.click()
    await Bun.sleep(30)
    expect(retry.hidden).toBe(false)
    discard.click()
    expect(retry.hidden).toBe(true)
    expect(discard.hidden).toBe(true)
    expect(record.disabled).toBe(false)
  } finally {
    controller.abort()
    await dispose()
    broker.dispose()
    element.remove()
    if (originalRecorder) Object.defineProperty(globalThis, "MediaRecorder", originalRecorder)
    else Reflect.deleteProperty(globalThis, "MediaRecorder")
    if (originalMedia) Object.defineProperty(navigator, "mediaDevices", originalMedia)
    else Reflect.deleteProperty(navigator, "mediaDevices")
    if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard)
    else Reflect.deleteProperty(navigator, "clipboard")
  }
})

test("keeps an automatic-improvement fallback eligible for manual polishing", async () => {
  const speech = await import(
    `${new URL("../../../../.opencode/plugin-sources/speech-to-text-app/index.js", import.meta.url).href}?automatic-fallback=${Date.now()}`
  )
  const originalRecorder = Object.getOwnPropertyDescriptor(globalThis, "MediaRecorder")
  const originalMedia = Object.getOwnPropertyDescriptor(navigator, "mediaDevices")
  let captures = 0
  const broker = createAudioCaptureBroker(async () => {
    captures++
    return { getTracks: () => [Object.assign(new EventTarget(), { stop() {} })] } as unknown as MediaStream
  })
  const context = { directory: "C:/Voice", sessionID: "ses_auto_fallback", composerID: "ses_auto_fallback" }
  const rawTranscript = "Please start Visual QA Testing"
  const fallbackTranscript = `${rawTranscript}\n\n/visual-qa-testing`
  const controller = new AbortController()
  const element = document.createElement("div")
  document.body.append(element)
  const insertions: Array<{ text: string; replace?: string }> = []
  const prompts: string[] = []
  let transcriptions = 0
  let improvements = 0
  let mount: (input: { element: HTMLElement; context: typeof context; signal: AbortSignal }) => void = () => {}
  let dispose = async () => {}
  class Recorder extends EventTarget {
    mimeType = "audio/webm"
    static isTypeSupported() {
      return true
    }
    start() {}
    stop() {
      this.dispatchEvent(
        Object.assign(new Event("dataavailable"), { data: new Blob(["audio"], { type: this.mimeType }) }),
      )
      this.dispatchEvent(new Event("stop"))
    }
  }
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: Recorder })
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia() {},
      enumerateDevices: async () => [],
      addEventListener() {},
      removeEventListener() {},
    },
  })
  try {
    speech.default.app({
      settings: {
        get: (key: string, fallback: unknown) => {
          if (key === "transcriptionChain") return "model:test/stt"
          if (key === "improvementChain") return "model:test/polish"
          if (key === "automaticImprovement") return true
          if (key === "includeSlashCommandsOpenCode") return true
          if (key === "desktopServiceEnabled") return false
          return fallback
        },
        register: () => () => {},
        subscribe: () => () => {},
      },
      toolbar: {
        register: (item: { mount: typeof mount }) => {
          mount = item.mount
        },
      },
      commands: { register() {} },
      lifecycle: {
        onDispose: (handler: typeof dispose) => {
          dispose = handler
        },
      },
      host: {
        audio: broker,
        navigation: { current: () => context },
        stt: {
          transcribe: async () => {
            transcriptions++
            return { ok: true, text: rawTranscript }
          },
        },
        skills: {
          list: async () => [{ name: "visual-qa-testing", title: "Visual QA Testing", reference: "/visual-qa-testing" }],
          resolve: async () => ({ skills: [], issues: [] }),
        },
        ai: {
          run: async (input: { prompt: string }) => {
            improvements++
            prompts.push(input.prompt)
            return improvements === 1
              ? { ok: false, error: "The automatic improvement provider is unavailable" }
              : {
                  ok: true,
                  text: JSON.stringify({
                    text: "Manually improved transcript",
                    skills: [],
                    expandSkillSearch: false,
                    skillQuery: "",
                  }),
                }
          },
        },
        composer: {
          insertText: async (input: { text: string; replace?: string }) => {
            insertions.push({ text: input.text, replace: input.replace })
            return insertions.length === 1 ? { ok: false, error: "The composer was temporarily unavailable" } : { ok: true }
          },
        },
      },
    })
    mount({ element, context, signal: controller.signal })
    const record = element.querySelector<HTMLButtonElement>('[data-action="speech-to-text"]')!
    record.click()
    for (let waited = 0; waited < 2000 && element.querySelector('[role="status"]')?.textContent !== "Recording 0:00"; waited += 5)
      await Bun.sleep(5)
    record.click()
    for (let waited = 0; waited < 2000 && insertions.length < 1; waited += 5) await Bun.sleep(5)
    expect(insertions[0]).toEqual({ text: fallbackTranscript, replace: undefined })
    const retry = [...element.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.startsWith("Retry"),
    )!
    expect(retry.hidden).toBe(false)
    retry.click()
    for (let waited = 0; waited < 2000 && !retry.hidden; waited += 5) await Bun.sleep(5)
    expect(insertions[1]).toEqual({ text: fallbackTranscript, replace: undefined })
    expect(record.disabled).toBe(false)

    record.click()
    for (let waited = 0; waited < 2000 && insertions.length < 3; waited += 5) await Bun.sleep(5)
    expect(prompts[1]).toContain(JSON.stringify(rawTranscript))
    expect(prompts[1]).not.toContain(JSON.stringify(fallbackTranscript))
    expect(insertions[2]).toEqual({
      text: "Manually improved transcript\n\n/visual-qa-testing",
      replace: fallbackTranscript,
    })
    expect(captures).toBe(1)
    expect(transcriptions).toBe(1)
    expect(improvements).toBe(2)
  } finally {
    controller.abort()
    await dispose()
    broker.dispose()
    element.remove()
    if (originalRecorder) Object.defineProperty(globalThis, "MediaRecorder", originalRecorder)
    else Reflect.deleteProperty(globalThis, "MediaRecorder")
    if (originalMedia) Object.defineProperty(navigator, "mediaDevices", originalMedia)
    else Reflect.deleteProperty(navigator, "mediaDevices")
  }
})

test("recovers a failed manual polish insertion and blocks competing work until recovery completes", async () => {
  const speech = await import(
    `${new URL("../../../../.opencode/plugin-sources/speech-to-text-app/index.js", import.meta.url).href}?manual-recovery=${Date.now()}`
  )
  const originalRecorder = Object.getOwnPropertyDescriptor(globalThis, "MediaRecorder")
  const originalMedia = Object.getOwnPropertyDescriptor(navigator, "mediaDevices")
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard")
  const copied: string[] = []
  const copyWrite = Promise.withResolvers<void>()
  let blockClipboardWrite = false
  const broker = createAudioCaptureBroker(
    async () => ({ getTracks: () => [Object.assign(new EventTarget(), { stop() {} })] }) as unknown as MediaStream,
  )
  const context = { directory: "C:/Voice", sessionID: "ses_manual_recovery", composerID: "ses_manual_recovery" }
  const controller = new AbortController()
  const element = document.createElement("div")
  document.body.append(element)
  const pendingImprovement = Promise.withResolvers<{ ok: boolean; text?: string; error?: string }>()
  const insertions: Array<{ text: string; replace?: string }> = []
  const retryInsertion = Promise.withResolvers<{ ok: boolean }>()
  let transcriptions = 0
  let improvements = 0
  let runRecord: (() => void) | undefined
  let invokeClipboard: ((input: { id: string; action: string; target: { kind: string; application: string } }) => Promise<void>) | undefined
  let invokeDictation: ((input: { id: string; action: string; target: { kind: string; application: string } }) => Promise<void>) | undefined
  const desktopUpdates: Array<{ id: string; phase: string; label?: string }> = []
  let clipboardReads = 0
  let mount: (input: { element: HTMLElement; context: typeof context; signal: AbortSignal }) => void = () => {}
  let dispose = async () => {}
  class Recorder extends EventTarget {
    mimeType = "audio/webm"
    static isTypeSupported() {
      return true
    }
    start() {}
    stop() {
      this.dispatchEvent(
        Object.assign(new Event("dataavailable"), { data: new Blob(["audio"], { type: this.mimeType }) }),
      )
      this.dispatchEvent(new Event("stop"))
    }
  }
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: Recorder })
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia() {},
      enumerateDevices: async () => [],
      addEventListener() {},
      removeEventListener() {},
    },
  })
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        copied.push(text)
        if (blockClipboardWrite) await copyWrite.promise
      },
    },
  })
  try {
    speech.default.app({
      settings: {
        get: (key: string, fallback: unknown) => {
          if (key === "transcriptionChain") return "model:test/stt"
          if (key === "improvementChain") return "model:test/polish"
          if (key === "automaticImprovement") return false
          if (key === "desktopServiceEnabled") return true
          return fallback
        },
        register: () => () => {},
        subscribe: () => () => {},
      },
      toolbar: {
        register: (item: { mount: typeof mount }) => {
          mount = item.mount
        },
      },
      commands: {
        register: (item: { id: string; run?: () => void }) => {
          if (item.id === "record") runRecord = item.run
        },
      },
      lifecycle: {
        onDispose: (handler: typeof dispose) => {
          dispose = handler
        },
      },
      host: {
        audio: broker,
        navigation: { current: () => context },
        textInput: { capture: () => undefined },
        stt: {
          transcribe: async () => {
            transcriptions += 1
            return { ok: true, text: `Raw transcript ${transcriptions}` }
          },
        },
        skills: {
          list: async () => [],
          resolve: async () => ({ skills: [], issues: [] }),
        },
        ai: {
          run: async () => {
            improvements += 1
            if (improvements === 2) return { ok: false, error: "The improvement provider is unavailable" }
            if (improvements === 4) return pendingImprovement.promise
            return { ok: true, text: "Improved manual transcript" }
          },
        },
        composer: {
          insertText: async (input: { text: string; replace?: string }) => {
            insertions.push({ text: input.text, replace: input.replace })
            if (insertions.length === 2) return { ok: false, error: "The pinned composer is no longer available" }
            if (insertions.length === 3) return retryInsertion.promise
            return { ok: true }
          },
        },
        desktopServices: {
          register: async (input: {
            id: string
            accelerator: string
            onInvoke: (input: { id: string; action: string; target: { kind: string; application: string } }) => Promise<void>
          }) => {
            if (input.id === "global-clipboard-improvement") invokeClipboard = input.onInvoke
            if (input.id === "global-dictation") invokeDictation = input.onInvoke
            return {
              ok: true,
              accelerator: input.accelerator,
              dispose: async () => {},
              update: async (id: string, state: { phase: string; label?: string }) => {
                desktopUpdates.push({ id, phase: state.phase, label: state.label })
              },
              insertText: async () => ({ ok: true }),
              readClipboard: async () => {
                clipboardReads++
                return "Clipboard transcript"
              },
              writeClipboard: async () => {},
            }
          },
        },
      },
    })
    await Bun.sleep(450)
    mount({ element, context, signal: controller.signal })
    const record = element.querySelector<HTMLButtonElement>('[data-action="speech-to-text"]')!
    Object.defineProperty(record, "getClientRects", { value: () => [{ length: 1 }] })
    const status = element.querySelector<HTMLElement>('[role="status"]')!
    record.click()
    await Bun.sleep(20)
    record.click()
    await Bun.sleep(35)
    expect(transcriptions).toBe(1)
    expect(insertions[0]).toEqual({ text: "Raw transcript 1", replace: undefined })

    runRecord?.()
    await Bun.sleep(35)
    expect(improvements).toBe(1)
    expect(insertions[1]).toEqual({ text: "Improved manual transcript", replace: "Raw transcript 1" })
    const retry = [...element.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.startsWith("Retry"),
    )!
    expect(retry.textContent).toBe("Retry insertion")
    expect(retry.hidden).toBe(false)

    const recoveryError = status.textContent
    expect(recoveryError).toContain("pinned composer is no longer available")
    runRecord?.()
    await Bun.sleep(15)
    expect(improvements).toBe(1)
    expect(transcriptions).toBe(1)
    expect(retry.hidden).toBe(false)
    expect(status.textContent).toBe(recoveryError)

    const copy = [...element.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Copy transcript",
    )!
    const discard = [...element.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Discard recording",
    )!
    blockClipboardWrite = true
    copy.click()
    await Bun.sleep(10)
    expect(copy.disabled).toBe(true)
    expect(retry.disabled).toBe(true)
    expect(discard.disabled).toBe(true)
    copy.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    retry.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    discard.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    expect(copied).toEqual(["Raw transcript 1", "Improved manual transcript", "Improved manual transcript"])
    expect(status.textContent).toBe(recoveryError)
    copyWrite.resolve()
    for (let waited = 0; waited < 2000 && copy.disabled; waited += 5) await Bun.sleep(5)
    blockClipboardWrite = false
    expect(status.textContent).toBe("Transcript copied to clipboard")
    expect(retry.hidden).toBe(false)
    expect(discard.hidden).toBe(false)

    expect(invokeDictation).toBeDefined()
    await invokeDictation!({ id: "blocked-by-recovery", action: "start", target: { kind: "opencode", application: "OpenCode" } })
    expect(desktopUpdates.at(-1)).toEqual({
      id: "blocked-by-recovery",
      phase: "error",
      label: "Speech to Text recovery is pending. Retry or discard it before starting another recording.",
    })

    const audioInput = element.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(audioInput, "files", {
      configurable: true,
      value: [new File(["audio"], "retry.wav", { type: "audio/wav" })],
    })
    audioInput.dispatchEvent(new Event("change"))
    await Bun.sleep(10)
    expect(transcriptions).toBe(1)

    expect(invokeClipboard).toBeDefined()
    await invokeClipboard!({ id: "clipboard-while-recovering", action: "start", target: { kind: "external", application: "Notepad" } })
    expect(clipboardReads).toBe(0)
    expect(improvements).toBe(1)
    expect(insertions).toHaveLength(2)

    retry.click()
    await Bun.sleep(10)
    expect(retry.disabled).toBe(true)
    expect(discard.disabled).toBe(true)
    copy.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await Bun.sleep(10)
    expect(copied).toEqual(["Raw transcript 1", "Improved manual transcript", "Improved manual transcript"])
    discard.click()
    retryInsertion.resolve({ ok: true })
    await Bun.sleep(25)
    expect(insertions[2]).toEqual({ text: "Improved manual transcript", replace: "Raw transcript 1" })
    expect(retry.hidden).toBe(true)

    runRecord?.()
    await Bun.sleep(25)
    expect(status.textContent).toBe("Recording 0:00")
    expect(improvements).toBe(1)
    record.click()
    await Bun.sleep(35)
    expect(transcriptions).toBe(2)
    expect(improvements).toBe(1)
    expect(insertions[3]).toEqual({ text: "Raw transcript 2", replace: undefined })

    runRecord?.()
    await Bun.sleep(35)
    expect(improvements).toBe(2)
    expect(insertions[4]).toEqual({ text: "Raw transcript 2", replace: "Raw transcript 2" })

    runRecord?.()
    await Bun.sleep(35)
    expect(improvements).toBe(3)
    expect(transcriptions).toBe(2)
    expect(insertions[5]).toEqual({ text: "Improved manual transcript", replace: "Raw transcript 2" })

    runRecord?.()
    await Bun.sleep(25)
    expect(status.textContent).toBe("Recording 0:00")
    expect(improvements).toBe(3)
    expect(transcriptions).toBe(2)

    runRecord?.()
    await Bun.sleep(35)
    expect(transcriptions).toBe(3)
    expect(insertions[6]).toEqual({ text: "Raw transcript 3", replace: undefined })

    runRecord?.()
    await Bun.sleep(10)
    expect(improvements).toBe(4)
    expect(status.textContent).toBe("Improving transcript")
    await dispose()
    pendingImprovement.reject(new Error("Late improvement result"))
    await Bun.sleep(10)
    expect(insertions).toHaveLength(7)
    expect(status.textContent).toBe("Improving transcript")
    dispose = async () => {}
  } finally {
    controller.abort()
    await dispose()
    broker.dispose()
    element.remove()
    if (originalRecorder) Object.defineProperty(globalThis, "MediaRecorder", originalRecorder)
    else Reflect.deleteProperty(globalThis, "MediaRecorder")
    if (originalMedia) Object.defineProperty(navigator, "mediaDevices", originalMedia)
    else Reflect.deleteProperty(navigator, "mediaDevices")
    if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard)
    else Reflect.deleteProperty(navigator, "clipboard")
  }
})

test("starts a new recording instead of polishing into a newly focused text input", async () => {
  const speech = await import(
    `${new URL("../../../../.opencode/plugin-sources/speech-to-text-app/index.js", import.meta.url).href}?text-input-destination=${Date.now()}`
  )
  const originalRecorder = Object.getOwnPropertyDescriptor(globalThis, "MediaRecorder")
  const originalMedia = Object.getOwnPropertyDescriptor(navigator, "mediaDevices")
  const broker = createAudioCaptureBroker(
    async () => ({ getTracks: () => [Object.assign(new EventTarget(), { stop() {} })] }) as unknown as MediaStream,
  )
  const context = { directory: "C:/Voice", sessionID: "ses_text_input_destination", composerID: "ses_text_input_destination" }
  const controller = new AbortController()
  const element = document.createElement("div")
  document.body.append(element)
  const composerInsertions: Array<{ text: string; replace?: string }> = []
  const inputInsertions: string[] = []
  let textInput: { insertText(text: string): { ok: boolean } } | undefined
  let transcriptions = 0
  let improvements = 0
  let mount: (input: { element: HTMLElement; context: typeof context; signal: AbortSignal }) => void = () => {}
  let runRecord: (() => void) | undefined
  let dispose = async () => {}
  class Recorder extends EventTarget {
    mimeType = "audio/webm"
    static isTypeSupported() {
      return true
    }
    start() {}
    stop() {
      this.dispatchEvent(Object.assign(new Event("dataavailable"), { data: new Blob(["audio"], { type: this.mimeType }) }))
      this.dispatchEvent(new Event("stop"))
    }
  }
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: Recorder })
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia() {}, enumerateDevices: async () => [], addEventListener() {}, removeEventListener() {} },
  })
  try {
    speech.default.app({
      settings: {
        get: (key: string, fallback: unknown) => {
          if (key === "desktopServiceEnabled") return false
          if (key === "transcriptionChain") return "model:test/stt"
          if (key === "automaticImprovement") return false
          return fallback
        },
        register: () => () => {},
        subscribe: () => () => {},
      },
      toolbar: { register: (item: { mount: typeof mount }) => { mount = item.mount } },
      commands: {
        register: (item: { id: string; run?: () => void }) => {
          if (item.id === "record") runRecord = item.run
        },
      },
      lifecycle: { onDispose: (handler: typeof dispose) => { dispose = handler } },
      host: {
        audio: broker,
        navigation: { current: () => context },
        textInput: { capture: () => textInput },
        stt: {
          transcribe: async () => ({ ok: true, text: `Raw transcript ${++transcriptions}` }),
        },
        skills: { list: async () => [], resolve: async () => ({ skills: [], issues: [] }) },
        ai: { run: async () => { improvements++; return { ok: true, text: "Improved transcript" } } },
        composer: {
          insertText: async (input: { text: string; replace?: string }) => {
            composerInsertions.push({ text: input.text, replace: input.replace })
            return { ok: true }
          },
        },
      },
    })
    mount({ element, context, signal: controller.signal })
    const record = element.querySelector<HTMLButtonElement>('[data-action="speech-to-text"]')!
    Object.defineProperty(record, "getClientRects", { value: () => [{ length: 1 }] })
    const status = element.querySelector<HTMLElement>('[role="status"]')!
    record.click()
    await Bun.sleep(20)
    record.click()
    for (let waited = 0; waited < 2000 && transcriptions < 1; waited += 5) await Bun.sleep(5)
    expect(composerInsertions).toEqual([{ text: "Raw transcript 1", replace: undefined }])

    textInput = { insertText: (text) => { inputInsertions.push(text); return { ok: true } } }
    runRecord?.()
    await Bun.sleep(20)
    expect(status.textContent).toBe("Recording 0:00")
    expect(improvements).toBe(0)
    expect(transcriptions).toBe(1)
    expect(inputInsertions).toEqual([])

    runRecord?.()
    for (let waited = 0; waited < 2000 && transcriptions < 2; waited += 5) await Bun.sleep(5)
    expect(transcriptions).toBe(2)
    expect(improvements).toBe(0)
    expect(composerInsertions).toHaveLength(1)
    expect(inputInsertions).toEqual(["Raw transcript 2"])
  } finally {
    controller.abort()
    await dispose()
    broker.dispose()
    element.remove()
    if (originalRecorder) Object.defineProperty(globalThis, "MediaRecorder", originalRecorder)
    else Reflect.deleteProperty(globalThis, "MediaRecorder")
    if (originalMedia) Object.defineProperty(navigator, "mediaDevices", originalMedia)
    else Reflect.deleteProperty(navigator, "mediaDevices")
  }
})

test("never retains an oversized recording chunk for recovery", async () => {
  const speech = await import(
    `${new URL("../../../../.opencode/plugin-sources/speech-to-text-app/index.js", import.meta.url).href}?oversized=${Date.now()}`
  )
  const originalRecorder = Object.getOwnPropertyDescriptor(globalThis, "MediaRecorder")
  const originalMedia = Object.getOwnPropertyDescriptor(navigator, "mediaDevices")
  const broker = createAudioCaptureBroker(
    async () => ({ getTracks: () => [Object.assign(new EventTarget(), { stop() {} })] }) as unknown as MediaStream,
  )
  const context = { directory: "C:/Voice", sessionID: "ses_oversized", composerID: "ses_oversized" }
  const controller = new AbortController()
  const element = document.createElement("div")
  document.body.append(element)
  const originalMax = speech.SPEECH_TO_TEXT_LIMITS.maxAudioBytes
  let mount: (input: { element: HTMLElement; context: typeof context; signal: AbortSignal }) => void = () => {}
  let dispose = async () => {}
  class Recorder extends EventTarget {
    mimeType = "audio/webm"
    static isTypeSupported() {
      return true
    }
    constructor() {
      super()
      ;(Recorder as unknown as { lastInstance?: unknown }).lastInstance = this
    }
    start() {}
    stop() {
      this.dispatchEvent(
        Object.assign(new Event("dataavailable"), { data: new Blob(["audio"], { type: this.mimeType }) }),
      )
      this.dispatchEvent(new Event("stop"))
    }
  }
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: Recorder })
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia() {},
      enumerateDevices: async () => [],
      addEventListener() {},
      removeEventListener() {},
    },
  })
  try {
    speech.SPEECH_TO_TEXT_LIMITS.maxAudioBytes = 8
    speech.default.app({
      settings: {
        get: (key: string, fallback: unknown) =>
          key === "transcriptionChain" ? "model:test/stt" : key === "desktopServiceEnabled" ? false : fallback,
        register: () => () => {},
        subscribe: () => () => {},
      },
      toolbar: {
        register: (item: { mount: typeof mount }) => {
          mount = item.mount
        },
      },
      commands: { register() {} },
      lifecycle: {
        onDispose: (handler: typeof dispose) => {
          dispose = handler
        },
      },
      host: {
        audio: broker,
        navigation: { current: () => context },
        stt: { transcribe: () => ({ ok: true, text: "unused" }) },
        composer: { insertText: async () => ({ ok: true }) },
      },
    })
    mount({ element, context, signal: controller.signal })
    const record = element.querySelector<HTMLButtonElement>('[data-action="speech-to-text"]')!
    record.click()
    await Bun.sleep(20)
    const oversized = new Blob([new Uint8Array(64)], { type: "audio/webm" })
    // The recorder instance is private; the first chunk exceeding the byte cap
    // is delivered through the same event path a real MediaRecorder uses.
    ;((Recorder as unknown as { lastInstance?: InstanceType<typeof Recorder> }).lastInstance)?.dispatchEvent(
      Object.assign(new Event("dataavailable"), { data: oversized }),
    )
    await Bun.sleep(20)
    const retry = [...element.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.startsWith("Retry"),
    )!
    expect(retry.hidden).toBe(true)
    record.click()
    await Bun.sleep(20)
    expect(record.disabled).toBe(false)
  } finally {
    speech.SPEECH_TO_TEXT_LIMITS.maxAudioBytes = originalMax
    controller.abort()
    await dispose()
    broker.dispose()
    element.remove()
    if (originalRecorder) Object.defineProperty(globalThis, "MediaRecorder", originalRecorder)
    else Reflect.deleteProperty(globalThis, "MediaRecorder")
    if (originalMedia) Object.defineProperty(navigator, "mediaDevices", originalMedia)
    else Reflect.deleteProperty(navigator, "mediaDevices")
  }
})
