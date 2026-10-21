import { expect, test } from "bun:test"
import { createAudioCaptureBroker } from "./audio-capture"
import { createComposerRegistry } from "./composer-registry"

test.each(["stop", "pending-unmount"])(
  "composer dictation pins its draft across %s without submitting",
  async (action) => {
    const speech = await import(
      new URL("../../../../.opencode/plugin-sources/speech-to-text-app/index.js", import.meta.url).href
    )
    const originalRecorder = Object.getOwnPropertyDescriptor(globalThis, "MediaRecorder")
    const originalMedia = Object.getOwnPropertyDescriptor(navigator, "mediaDevices")
    const transcript = Promise.withResolvers<{ ok: boolean; text: string }>()
    const inserted: unknown[] = []
    const broker = createAudioCaptureBroker(
      async () => ({ getTracks: () => [Object.assign(new EventTarget(), { stop() {} })] }) as unknown as MediaStream,
    )
    const composerID = action === "stop" ? "composer-pinned" : "ses_worker"
    const context = { directory: "C:/Voice", sessionID: "ses_worker", composerID }
    const controller = new AbortController()
    const element = document.createElement("div")
    document.body.append(element)
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
          navigation: { current: () => ({ directory: "C:/Other", sessionID: "ses_other" }) },
          stt: { transcribe: () => transcript.promise },
          composer: {
            insertText: async (input: unknown) => {
              inserted.push(input)
              return { ok: true }
            },
          },
        },
      })
      mount({ element, context, signal: controller.signal })
      const button = element.querySelector<HTMLButtonElement>("button")!
      const status = element.querySelector<HTMLElement>('[role="status"]')!
      expect(status.hidden).toBe(true)
      button.click()
      await Bun.sleep(10)
      expect(status.textContent).toBe("Recording 0:00")
      await Bun.sleep(1100)
      expect(status.textContent).toBe("Recording 0:01")
      context.sessionID = "ses_other"
      context.composerID = "composer-other"
      button.click()
      await Bun.sleep(50)
      expect(status.textContent).toBe("Transcribing speech")
      expect(button.disabled).toBe(true)
      if (action === "pending-unmount") {
        controller.abort()
        await Bun.sleep(50)
      }
      transcript.resolve({ ok: true, text: "Keep this as a draft" })
      await Bun.sleep(20)
      expect(inserted).toEqual([
        {
          directory: "C:/Voice",
          sessionID: "ses_worker",
          composerID,
          text: "Keep this as a draft",
          position: "cursor",
          replace: undefined,
        },
      ])
      if (action === "stop") {
        expect(status.hidden).toBe(true)
        expect(button.disabled).toBe(false)
      }
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
  },
)

test("composer dictation keeps recording across a tab switch and delivers only to its pinned draft", async () => {
  const speech = await import(
    `${new URL("../../../../.opencode/plugin-sources/speech-to-text-app/index.js", import.meta.url).href}?tab-switch=${Date.now()}`
  )
  const originalRecorder = Object.getOwnPropertyDescriptor(globalThis, "MediaRecorder")
  const originalMedia = Object.getOwnPropertyDescriptor(navigator, "mediaDevices")
  const transcript = Promise.withResolvers<{ ok: boolean; text: string }>()
  const inserted: unknown[] = []
  const broker = createAudioCaptureBroker(
    async () => ({ getTracks: () => [Object.assign(new EventTarget(), { stop() {} })] }) as unknown as MediaStream,
  )
  const first = { directory: "C:/Voice", sessionID: "ses_first", composerID: "ses_first" }
  const second = { directory: "C:/Voice", sessionID: "ses_second", composerID: "ses_second" }
  const firstController = new AbortController()
  const secondController = new AbortController()
  const firstElement = document.createElement("div")
  const secondElement = document.createElement("div")
  document.body.append(firstElement, secondElement)
  let mount: (input: { element: HTMLElement; context: typeof first; signal: AbortSignal }) => void = () => {}
  let dispose = async () => {}
  let stops = 0
  class Recorder extends EventTarget {
    mimeType = "audio/webm"
    static isTypeSupported() {
      return true
    }
    start() {}
    stop() {
      stops += 1
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
        navigation: { current: () => second },
        stt: { transcribe: () => transcript.promise },
        composer: {
          insertText: async (input: unknown) => {
            inserted.push(input)
            return { ok: true }
          },
        },
      },
    })
    mount({ element: firstElement, context: first, signal: firstController.signal })
    firstElement.querySelector<HTMLButtonElement>("button")!.click()
    await Bun.sleep(20)
    expect(firstElement.querySelector<HTMLElement>('[role="status"]')!.textContent).toBe("Recording 0:00")

    firstController.abort()
    mount({ element: secondElement, context: second, signal: secondController.signal })
    await Bun.sleep(20)

    const secondButton = secondElement.querySelector<HTMLButtonElement>("button")!
    expect(stops).toBe(0)
    expect(secondButton.disabled).toBe(false)
    expect(secondButton.getAttribute("aria-label")).toContain("Stop recording")
    expect(secondElement.querySelector<HTMLElement>('[role="status"]')!.textContent).toContain("Recording 0:00")

    secondButton.click()
    await Bun.sleep(20)
    expect(stops).toBe(1)
    transcript.resolve({ ok: true, text: "Pinned tab transcript" })
    await Bun.sleep(20)
    expect(inserted).toEqual([
      {
        directory: first.directory,
        sessionID: first.sessionID,
        composerID: first.composerID,
        text: "Pinned tab transcript",
        position: "cursor",
        replace: undefined,
      },
    ])
  } finally {
    firstController.abort()
    secondController.abort()
    await dispose()
    broker.dispose()
    firstElement.remove()
    secondElement.remove()
    if (originalRecorder) Object.defineProperty(globalThis, "MediaRecorder", originalRecorder)
    else Reflect.deleteProperty(globalThis, "MediaRecorder")
    if (originalMedia) Object.defineProperty(navigator, "mediaDevices", originalMedia)
    else Reflect.deleteProperty(navigator, "mediaDevices")
  }
})

test("submitting a corrected dictation must not fail on the learned-term callback", async () => {
  const speech = await import(
    new URL("../../../../.opencode/plugin-sources/speech-to-text-app/index.js", import.meta.url).href
  )
  const registry = createComposerRegistry()
  const composerTarget = { directory: "C:/Voice", sessionID: "ses_voice", composerID: "composer-voice" }
  const state = { text: "", mode: "normal" as "normal" | "shell" }
  const registryTarget = { ...composerTarget, serverID: "test" }
  registry.register(registryTarget, {
    read: () => ({ ...composerTarget, ...state }),
    change: (text: string) => {
      state.text = text
    },
    insertText: (input: { text: string }) => {
      state.text = input.text
      return { ok: true }
    },
    submitText: async () => ({ ok: true }),
  })
  const settings = new Map<string, unknown>()
  settings.set("transcriptionChain", "model:test/stt")
  const transcript = Promise.withResolvers<{ ok: boolean; text: string }>()
  const controller = new AbortController()
  let dispose = async () => {}
  let mount: (input: { element: HTMLElement; context: typeof composerTarget; signal: AbortSignal }) => void = () => {}
  const element = document.createElement("div")
  document.body.append(element)
  const originalRecorder = Object.getOwnPropertyDescriptor(globalThis, "MediaRecorder")
  const originalMedia = Object.getOwnPropertyDescriptor(navigator, "mediaDevices")
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
  const broker = createAudioCaptureBroker(
    async () => ({ getTracks: () => [Object.assign(new EventTarget(), { stop() {} })] }) as unknown as MediaStream,
  )
  try {
    speech.default.app({
      settings: {
        get: (key: string, fallback: unknown) => (settings.has(key) ? settings.get(key) : fallback),
        set: (key: string, value: unknown) => settings.set(key, value),
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
        navigation: { current: () => composerTarget },
        stt: { transcribe: () => transcript.promise },
        composer: {
          insertText: async (input: { text: string }) => {
            state.text = input.text
            return { ok: true }
          },
          // Mirrors the real host wiring through composer-api, including the
          // registry contract that a handler unsubscribing during its own
          // callback aborts this listener's controller inside the submit race.
          beforeSubmit: (input: { directory: string }, handler: Parameters<typeof registry.beforeSubmit>[1]) =>
            registry.beforeSubmit({ ...composerTarget, ...input, serverID: "test" }, handler),
        },
      },
    })
    mount({ element, context: composerTarget, signal: controller.signal })
    const button = element.querySelector<HTMLButtonElement>("button")!
    const status = element.querySelector<HTMLElement>('[role="status"]')!
    button.click()
    for (let waited = 0; waited < 2000 && status.textContent !== "Recording 0:00"; waited += 5) await Bun.sleep(5)
    expect(status.textContent).toBe("Recording 0:00")
    button.click()
    transcript.resolve({ ok: true, text: "Das OpenCode dictate" })
    for (let waited = 0; waited < 2000 && state.text !== "Das OpenCode dictate"; waited += 5) await Bun.sleep(5)
    expect(state.text).toBe("Das OpenCode dictate")
    registry.change({ ...registryTarget, text: "Das OpenCode Diktat" })
    const agent = { getAgent: () => "build", canSetAgent: () => false, setAgent: () => false }
    expect(await registry.runBeforeSubmit(registryTarget, agent)).toEqual({ ok: true })
    expect(String(settings.get("learnedTerms"))).toContain("Diktat")
    await Bun.sleep(1)
    const learnedAfterFirstSubmit = settings.get("learnedTerms")
    registry.change({ ...registryTarget, text: "Das OpenCode Diktat ist fertig" })
    expect((await registry.runBeforeSubmit(registryTarget, agent)).ok).toBe(true)
    expect(settings.get("learnedTerms")).toBe(learnedAfterFirstSubmit)
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

test("improved composer dictation sends shared rules and mandatory personal style to the host", async () => {
  const speech = await import(
    `${new URL("../../../../.opencode/plugin-sources/speech-to-text-app/index.js", import.meta.url).href}?rewrite-composer=${Date.now()}`
  )
  const originalRecorder = Object.getOwnPropertyDescriptor(globalThis, "MediaRecorder")
  const originalMedia = Object.getOwnPropertyDescriptor(navigator, "mediaDevices")
  const transcript = Promise.withResolvers<{ ok: boolean; text: string }>()
  const context = { directory: "C:/Voice", sessionID: "ses_rewrite", composerID: "composer_rewrite" }
  const inserted: unknown[] = []
  const prompts: string[] = []
  const controller = new AbortController()
  const broker = createAudioCaptureBroker(
    async () => ({ getTracks: () => [Object.assign(new EventTarget(), { stop() {} })] }) as unknown as MediaStream,
  )
  const values = new Map<string, unknown>([
    ["automaticImprovement", true],
    ["transcriptionChain", "model:test/stt"],
    ["improvementChain", "model:test/polish"],
    ["improvementPromptTemplate", "Custom style note: {transcript}"],
    ["applicationPromptVersion", 3],
    ["applicationProfiles", []],
    ["defaultImprovementSkills", []],
    ["includeSlashCommandsOpenCode", false],
  ])
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
  const element = document.createElement("div")
  document.body.append(element)
  try {
    speech.default.app({
      settings: {
        get: (key: string, fallback: unknown) => (values.has(key) ? values.get(key) : fallback),
        set: (key: string, value: unknown) => values.set(key, value),
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
        stt: { transcribe: () => transcript.promise },
        ai: {
          run: async (input: { prompt: string }) => {
            prompts.push(input.prompt)
            return { ok: true, text: "The cleaned-up request." }
          },
        },
        skills: {
          list: async () => [],
          resolve: async ({ names }: { names: string[] }) => ({
            skills: names.map((name) => ({ name, content: "Personal style fixture: concise and natural." })),
            issues: [],
          }),
        },
        composer: {
          insertText: async (input: unknown) => {
            inserted.push(input)
            return { ok: true }
          },
        },
      },
    })
    mount({ element, context, signal: controller.signal })
    const button = element.querySelector<HTMLButtonElement>("button")!
    const status = element.querySelector<HTMLElement>('[role="status"]')!
    button.click()
    for (let waited = 0; waited < 2000 && status.textContent !== "Recording 0:00"; waited += 5) await Bun.sleep(5)
    expect(status.textContent).toBe("Recording 0:00")
    button.click()
    transcript.resolve({ ok: true, text: "Mach den Button blau, ach nee lieber grün." })
    for (let waited = 0; waited < 2000 && inserted.length === 0; waited += 5) await Bun.sleep(5)

    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain("Rewrite the supplied speech transcript as concise, complete, naturally written text")
    expect(prompts[0]).toContain("These writing-style rules apply together with the base editing rules above")
    expect(prompts[0]).toContain('<skill-instructions name="personal-writing-style">')
    expect(prompts[0]).toContain("Personal style fixture: concise and natural.")
    expect(prompts[0]).toContain("Custom style note:")
    expect(prompts[0]).toContain(JSON.stringify("Mach den Button blau, ach nee lieber grün."))
    expect(prompts[0]).toContain("Return only the improved text")
    expect(inserted).toEqual([
      {
        directory: context.directory,
        sessionID: context.sessionID,
        composerID: context.composerID,
        text: "The cleaned-up request.",
        position: "cursor",
        replace: undefined,
      },
    ])
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
