import { describe, expect, test } from "bun:test"
import plugin from "./index.js"

const CAPTURED_AT = new Date(2026, 9, 3, 14, 5).getTime()

const context = (sessionID, overrides = {}) => ({
  version: 1,
  session: { id: sessionID, directory: "/project", title: "Session" },
  activity: { status: "completed", working: false },
  selection: "latest-user-turn",
  boundaryComplete: true,
  messages: [
    { id: "m1", role: "user", text: "Implementiere die Regel", createdAt: 1, complete: true },
    { id: "m2", role: "assistant", text: "Regel implementiert, Tests grün. Offen: Deploy-Freigabe.", createdAt: 2, complete: true },
  ],
  pending: { questions: [], controls: [], permissions: [] },
  totals: { messages: 2, textChars: 90, questions: 0, controls: 0, permissions: 0 },
  truncated: { messages: false, text: false, pending: false },
  capturedAt: CAPTURED_AT,
  fingerprint: "fp-1",
  todos: {
    items: [
      { content: "Regel entfernen", status: "completed", priority: "high" },
      { content: "Bridge bauen", status: "in_progress", priority: "medium" },
      { content: "Deploy vorbereiten", status: "pending", priority: "low" },
    ],
    total: 3,
    truncated: false,
  },
  ...overrides,
})

function activation(handlers = {}) {
  const owner = new AbortController()
  const calls = { ai: [], images: [], contextIDs: [] }
  const toolbars = []
  const commands = []
  const overlays = []
  let nextNavigation = 0
  const api = {
    signal: owner.signal,
    settings: {
      get: (key, fallback) => (key === "labelTarget" ? (handlers.labelTarget ?? "acme/writer") : fallback),
      register() {},
      subscribe() {
        return () => {}
      },
    },
    commands: { register(item) { commands.push(item) } },
    toolbar: { register(item) { toolbars.push(item) } },
    // Real HappyDOM overlay mount: the host invokes mount, owns the signal and
    // reports closes by aborting it, exactly like the app runtime.
    ui: { overlay: { open(input) {
      const controller = new AbortController()
      const element = document.createElement("div")
      document.body.append(element)
      const record = { id: input.id, element, controller, closed: false, dispose: undefined }
      record.close = () => {
        if (record.closed) return
        record.closed = true
        controller.abort()
        element.remove()
      }
      record.dispose = input.mount({ element, signal: controller.signal })
      overlays.push(record)
      return { close: () => record.close() }
    } } },
    // The host deliberately exposes only read-only plus generation calls; any
    // steering of the running session (interrupt/prompt) would throw instead.
    host: {
      navigation: { current: () => {
        const targets = handlers.navigation ?? [{ directory: "/project", sessionID: "ses_a" }]
        const target = targets[nextNavigation % targets.length]
        nextNavigation += 1
        return target
      } },
      sessions: { async context(input) {
        calls.contextIDs.push(input.sessionID)
        if (handlers.freshFails && calls.contextIDs.length >= 2)
          return { ok: false, error: { code: "unavailable", message: "Session read unavailable" } }
        if (handlers.context) return handlers.context(input, calls)
        const base = handlers.contextSequence ? handlers.contextSequence(calls.contextIDs.length) : undefined
        return { ok: true, context: context(input.sessionID, base ?? handlers.contextOverrides) }
      } },
      ai: { async run(input) {
        calls.ai.push(input)
        if (handlers.ai) return handlers.ai(input)
        return { ok: true, text: '{"done":["Regel implementiert"],"state":["Plugin implementiert"],"open":["Deploy-Freigabe offen"],"user":["Freigabe erteilen"],"next":["Deploy (Nutzer)"]}' }
      } },
      images: { async generate(input) {
        calls.images.push(input)
        if (handlers.images) return handlers.images(input)
        return { ok: true, mime: "image/png", data: "aGlsZQ==", filename: "image.png", bytes: 5 }
      } },
    },
  }
  plugin.app(api)
  return { owner, calls, toolbars, commands, overlays, api }
}

const until = async (check, budget = 2500) => {
  const deadline = Date.now() + budget
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return check()
}

const mount = (env) => {
  const element = document.createElement("div")
  document.body.append(element)
  const dispose = env.toolbars[0].mount({ element, signal: env.owner.signal, context: { directory: "/project", sessionID: "ses_a" } })
  return { element, dispose, button: () => element.querySelector('[data-action="session-schaubild-generate"]') }
}

describe("session schaubild activation", () => {
  test("one click reads context, condenses labels and renders the final image", async () => {
    const env = activation()
    const { element, dispose, button } = mount(env)
    button().click()
    expect(await until(() => element.querySelector(".oc-session-schaubild")?.dataset.phase === "done")).toBe(true)
    expect(env.calls.contextIDs).toEqual(["ses_a"])
    expect(env.calls.ai).toHaveLength(1)
    expect(env.calls.ai[0].model).toBe("acme/writer")
    expect(env.calls.ai[0].prompt).toContain("UNTRUSTED_CONTEXT")
    expect(env.calls.images).toHaveLength(1)
    expect(env.calls.images[0].size).toBe("1536x1024")
    expect(env.calls.images[0].prompt).toContain("Regel implementiert")
    expect(env.calls.images[0].prompt).toContain("Freigabe erteilen")
    expect(env.calls.images[0].prompt).toContain("Session-Todos")
    expect(env.calls.images[0].prompt).toContain("In Arbeit (1): Bridge bauen")
    expect(env.calls.images[0].prompt).toContain("Erledigt (1): Regel entfernen")
    expect(env.calls.images[0].prompt).not.toContain("Zwischenstand")
    dispose()
    element.remove()
  })

  test("a missing todo list is marked honestly instead of invented", async () => {
    const env = activation({ contextOverrides: { todos: undefined } })
    const { element, dispose, button } = mount(env)
    button().click()
    expect(await until(() => element.querySelector(".oc-session-schaubild")?.dataset.phase === "done")).toBe(true)
    expect(env.calls.images[0].prompt).toContain("Todos: keine Todo-Liste im Kontext verfügbar (nicht erfunden).")
    dispose()
    element.remove()
  })

  test("a running session yields an interim snapshot without steering the run", async () => {
    // Second context read drifts on purpose: interim snapshots must survive a
    // changing fingerprint because the agent keeps writing while we read.
    const env = activation({
      contextOverrides: { activity: { status: "running", working: true } },
      contextSequence: (read) => (read >= 2 ? { fingerprint: "fp-drifted" } : undefined),
    })
    const { element, dispose, button } = mount(env)
    button().click()
    expect(await until(() => element.querySelector(".oc-session-schaubild")?.dataset.phase === "done")).toBe(true)
    expect(env.calls.contextIDs).toEqual(["ses_a"])
    expect(env.calls.ai).toHaveLength(1)
    expect(env.calls.images).toHaveLength(1)
    expect(env.calls.images[0].prompt).toContain("Snapshot von 14:05 Uhr")
    expect(env.calls.images[0].prompt).toContain("Agent arbeitet noch")
    expect(env.calls.images[0].prompt).toContain("not a final result")
    expect(env.calls.images[0].prompt).toContain("Regel implementiert")
    dispose()
    element.remove()
  })

  test("double clicks are ignored while a generation is running", async () => {
    let releaseLabels
    const env = activation({ ai: () => new Promise((resolve) => {
      releaseLabels = () => resolve({ ok: true, text: '{"done":[],"state":["x"],"open":[],"user":[],"next":[]}' })
    }) })
    const { element, dispose, button } = mount(env)
    button().click()
    button().click()
    expect(await until(() => button().disabled)).toBe(true)
    expect(await until(() => env.calls.ai.length === 1)).toBe(true)
    releaseLabels()
    expect(await until(() => element.querySelector(".oc-session-schaubild")?.dataset.phase === "done")).toBe(true)
    expect(env.calls.ai).toHaveLength(1)
    expect(env.calls.images).toHaveLength(1)
    dispose()
    element.remove()
  })

  test("cancelling mid-run keeps the state dead even when the AI answers late", async () => {
    let releaseLabels
    const env = activation({ ai: () => new Promise((resolve) => {
      releaseLabels = () => resolve({ ok: true, text: '{"done":[],"state":["x"],"open":[],"user":[],"next":[]}' })
    }) })
    const { element, dispose, button } = mount(env)
    button().click()
    expect(await until(() => element.querySelector(".oc-session-schaubild")?.dataset.phase === "working")).toBe(true)
    expect(await until(() => env.calls.ai.length === 1)).toBe(true)
    env.owner.abort()
    releaseLabels()
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(env.calls.images).toHaveLength(0)
    expect(element.querySelector(".oc-session-schaubild")?.dataset.phase === "done").toBe(false)
    dispose()
    element.remove()
  })

  test("image backend failures surface the honest error message", async () => {
    const env = activation({ images: async () => ({ ok: false, error: "Codex did not create a valid image (exit 0)." }) })
    const { element, dispose, button } = mount(env)
    button().click()
    expect(await until(() => element.querySelector(".oc-session-schaubild")?.dataset.phase === "error")).toBe(true)
    expect(env.calls.ai).toHaveLength(1)
    expect(env.calls.images).toHaveLength(1)
    expect(button().title).toContain("Codex did not create a valid image")
    dispose()
    element.remove()
  })

  // Snapshot semantics (justified contract update): generation is attributed
  // to the frozen click-time context. A single atomic read feeds the whole
  // run; live chat advancing mid-generation must not fail or restart the run.
  test("live chat advance during generation keeps the labeled click-time snapshot", async () => {
    let releaseLabels
    let advanced = false
    const env = activation({
      // Read #1 is the click-time snapshot; any later read would see the
      // advanced host state, but the run must never perform one.
      context: async (input) => ({ ok: true, context: context(input.sessionID, advanced ? {
        todos: { items: [{ content: "ADVANCED_TODO", status: "completed", priority: "high" }], total: 1, truncated: false, digest: "a".repeat(64) },
        fingerprint: "fp-advanced",
        capturedAt: CAPTURED_AT + 60_000,
      } : undefined) }),
      ai: () => new Promise((resolve) => {
        releaseLabels = () => resolve({ ok: true, text: '{"done":["Klick-Stand"],"state":["x"],"open":[],"user":[],"next":[]}' })
      }),
    })
    const { element, dispose, button } = mount(env)
    button().click()
    expect(await until(() => env.calls.ai.length === 1)).toBe(true)
    // The host advances (new todos + messages) WHILE labels are pending.
    advanced = true
    releaseLabels()
    expect(await until(() => element.querySelector(".oc-session-schaubild")?.dataset.phase === "done")).toBe(true)
    expect(env.calls.contextIDs).toEqual(["ses_a"])
    // Frozen click-time attribution: the advanced state must not leak in.
    expect(env.calls.ai[0].prompt).toContain("Deploy vorbereiten")
    expect(env.calls.ai[0].prompt).not.toContain("ADVANCED_TODO")
    expect(env.calls.images[0].prompt).toContain("Snapshot von 14:05 Uhr")
    expect(env.calls.images[0].prompt).not.toContain("ADVANCED_TODO")
    expect(await until(() => (env.overlays[0]?.element.textContent ?? "").includes("Stand: 14:05 Uhr"))).toBe(true)
    expect(env.overlays[0].element.textContent).not.toContain("ADVANCED_TODO")
    dispose()
    element.remove()
    env.owner.abort()
  })

  test("a second click during a run is ignored (no orphan generation, no attribution switch)", async () => {
    let release
    const env = activation({
      ai: () => new Promise((resolve) => {
        release = () => resolve({ ok: true, text: '{"done":[],"state":["x"],"open":[],"user":[],"next":[]}' })
      }),
      navigation: [{ directory: "/project", sessionID: "ses_a" }, { directory: "/project", sessionID: "ses_b" }],
    })
    const generate = () => env.commands.find((item) => item.id === "session-schaubild.generate").run()
    const { element, dispose, button } = mount(env)
    generate()
    expect(await until(() => env.calls.ai.length === 1)).toBe(true)
    // Second click targets ses_b while ses_a is still generating: ignored.
    generate()
    release()
    expect(await until(() => element.querySelector(".oc-session-schaubild")?.dataset.phase === "done")).toBe(true)
    expect(env.calls.ai).toHaveLength(1)
    expect(env.calls.contextIDs).toEqual(["ses_a"])
    expect(env.overlays).toHaveLength(1)
    expect(await until(() => env.overlays[0].element.textContent.includes("ses_a"))).toBe(true)
    dispose()
    element.remove()
    env.owner.abort()
  })

  test("exactly one context read feeds the whole run (no staleness re-read)", async () => {
    const env = activation()
    const { element, dispose, button } = mount(env)
    button().click()
    expect(await until(() => element.querySelector(".oc-session-schaubild")?.dataset.phase === "done")).toBe(true)
    expect(env.calls.contextIDs).toEqual(["ses_a"])
    expect(env.calls.images).toHaveLength(1)
    dispose()
    element.remove()
  })

  test("popup attribution shows source title, session id and snapshot time", async () => {
    const env = activation()
    const { dispose, button } = mount(env)
    button().click()
    expect(await until(() => env.overlays.length === 1)).toBe(true)
    expect(await until(() => env.overlays[0].element.textContent.includes("Stand: 14:05 Uhr"))).toBe(true)
    expect(env.overlays[0].element.textContent).toContain("Session · ses_a")
    dispose()
    env.owner.abort()
  })
})

describe("session schaubild overlay lifecycle", () => {
  const command = (env, id) => env.commands.find((item) => item.id === id)

  test("initial show without any generation renders honestly without todos or image", () => {
    const env = activation()
    command(env, "session-schaubild.show").run()
    expect(env.overlays).toHaveLength(1)
    const text = env.overlays[0].element.textContent
    expect(text).toContain("Erwartet: Keine Aktion nötig.")
    expect(text).toContain("Todos: keine Todo-Liste im Kontext verfügbar (nicht erfunden).")
    expect(env.overlays[0].element.querySelector("img")?.style.display).toBe("none")
    env.owner.abort()
  })

  test("popup render during working state survives undefined todos (lifecycle repro)", async () => {
    let releaseContext
    const env = activation({ context: async (input, calls) => {
      // Hold only the first read in the working window; the fresh/fingerprint
      // read must flow freely so the run can complete.
      if (calls.contextIDs.length === 1) await new Promise((resolve) => { releaseContext = resolve })
      return { ok: true, context: context(input.sessionID) }
    } })
    const { element, dispose, button } = mount(env)
    button().click()
    expect(await until(() => button().disabled)).toBe(true)
    // The exact repro window: state reset to working with todos still undefined.
    command(env, "session-schaubild.show").run()
    expect(env.overlays).toHaveLength(1)
    expect(env.overlays[0].element.textContent).toContain("Todos: keine Todo-Liste im Kontext verfügbar (nicht erfunden).")
    releaseContext()
    expect(await until(() => element.querySelector(".oc-session-schaubild")?.dataset.phase === "done")).toBe(true)
    expect(await until(() => env.overlays[0].element.textContent.includes("- Bridge bauen"))).toBe(true)
    dispose()
    element.remove()
    env.owner.abort()
  })

  test("generate, close, generate for a new session reopens a fresh popup", async () => {
    let release
    const env = activation({
      ai: () => new Promise((resolve) => {
        release = () => resolve({ ok: true, text: '{"done":[],"state":["x"],"open":[],"user":[],"next":[]}' })
      }),
      navigation: [{ directory: "/project", sessionID: "ses_a" }, { directory: "/project", sessionID: "ses_b" }],
    })
    command(env, "session-schaubild.generate").run()
    expect(await until(() => env.calls.ai.length === 1)).toBe(true)
    release()
    expect(await until(() => env.overlays.length === 1)).toBe(true)
    expect(await until(() => env.overlays[0].element.textContent.includes("ses_a"))).toBe(true)
    env.overlays[0].close()
    expect(await until(() => env.overlays[0]?.closed)).toBe(true)
    command(env, "session-schaubild.generate").run()
    expect(await until(() => env.calls.ai.length === 2)).toBe(true)
    release()
    expect(await until(() => env.overlays.length === 2)).toBe(true)
    expect(await until(() => env.overlays[1].element.textContent.includes("ses_b"))).toBe(true)
    env.owner.abort()
  })

  test("host dismiss without our own close still frees the popup for the next run", async () => {
    const env = activation({ navigation: [{ directory: "/project", sessionID: "ses_a" }, { directory: "/project", sessionID: "ses_b" }] })
    command(env, "session-schaubild.generate").run()
    expect(await until(() => env.overlays.length === 1)).toBe(true)
    // Escape/host dismiss: abort the mount signal directly, never calling close().
    env.overlays[0].controller.abort()
    command(env, "session-schaubild.generate").run()
    expect(await until(() => env.overlays.length === 2)).toBe(true)
    expect(await until(() => env.overlays[1].element.textContent.includes("ses_b"))).toBe(true)
    env.owner.abort()
  })

  test("popup lists every transferred todo entry while the image only summarizes", async () => {
    const items = ["p1", "p2", "p3", "p4", "p5", "p6"].map((name) => ({ content: name, status: "pending", priority: "low" }))
    const env = activation({ contextOverrides: { todos: { items, total: 6, truncated: false } } })
    const { dispose, button } = mount(env)
    button().click()
    expect(await until(() => env.overlays.length === 1)).toBe(true)
    const prompt = env.calls.images[0].prompt
    expect(prompt).toContain("Offen (6): p1 | p2 | p3 | p4 (+2 weitere, Details im Popup)")
    expect(prompt).not.toContain("p5 |")
    const todoText = env.overlays[0].element.querySelector("div[style*='pre-line']")?.textContent ?? ""
    for (const name of ["p1", "p2", "p3", "p4", "p5", "p6"]) expect(todoText).toContain(`- ${name}`)
    dispose()
    env.owner.abort()
  })
})
