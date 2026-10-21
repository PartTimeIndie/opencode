/** @jsxImportSource @opentui/solid */
import { TextareaRenderable } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup, onMount, Show } from "solid-js"
import { ArgsProvider } from "../../../src/context/args"
import { ClipboardProvider } from "../../../src/context/clipboard"
import { DataProvider } from "../../../src/context/data"
import { EditorContextProvider } from "../../../src/context/editor"
import { ExitProvider } from "../../../src/context/exit"
import { KVProvider } from "../../../src/context/kv"
import { LocalProvider, useLocal } from "../../../src/context/local"
import { ProjectProvider } from "../../../src/context/project"
import { RouteProvider, useRoute } from "../../../src/context/route"
import { SDKProvider } from "../../../src/context/sdk"
import { SyncProvider, useSync } from "../../../src/context/sync"
import { ThemeProvider } from "../../../src/context/theme"
import { TuiConfigProvider } from "../../../src/config"
import { FrecencyProvider } from "../../../src/prompt/frecency"
import { PromptHistoryProvider } from "../../../src/prompt/history"
import { PromptStashProvider } from "../../../src/prompt/stash"
import { Prompt, type PromptRef } from "../../../src/component/prompt"
import { HomeSessionDestinationProvider, useHomeSessionDestination } from "../../../src/routes/home/session-destination"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { ToastProvider, useToast } from "../../../src/ui/toast"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json, worktree } from "../../fixture/tui-sdk"

type QueuedResponse = Response | Promise<Response>

type MountOptions = {
  root: string
  commands?: { name: string; template: string; description?: string }[]
  sessionResponses?: QueuedResponse[]
  promptResponses?: QueuedResponse[]
  commandResponses?: QueuedResponse[]
  shellResponses?: QueuedResponse[]
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

async function wait(check: () => boolean | Promise<boolean>, timeout = 5000) {
  const start = Date.now()
  while (!(await check())) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

function failure(message: string) {
  return json({ name: "InvalidRequestError", data: { message } }, { status: 400 })
}

function admissionSuccess(body: Record<string, unknown>) {
  return json({ data: { sessionID: body.sessionID, messageID: body.id, admittedSeq: 1 } })
}

async function mountPrompt(options: MountOptions) {
  const state = path.join(options.root, "state")
  const copyDirectory = path.join(options.root, "copy")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  const model = {
    id: "gpt-test",
    providerID: "openai",
    api: { id: "openai", url: "https://openai.test", npm: "@ai-sdk/openai" },
    name: "GPT Test",
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 128000, output: 8192 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
  }
  const provider = { id: "openai", name: "OpenAI", source: "api", env: [], options: {}, models: { "gpt-test": model } }
  const agent = { name: "build", mode: "primary", permission: [], options: {} }
  const sessionResponses = [...(options.sessionResponses ?? [])]
  const promptResponses = [...(options.promptResponses ?? [])]
  const commandResponses = [...(options.commandResponses ?? [])]
  const shellResponses = [...(options.shellResponses ?? [])]
  const requests = {
    commands: [] as Record<string, unknown>[],
    copies: 0,
    creates: [] as Record<string, unknown>[],
    promptSessionIDs: [] as string[],
    prompts: [] as Record<string, unknown>[],
    shells: [] as Record<string, unknown>[],
  }
  const calls = createFetch((url) => {
    if (url.pathname === "/config") return json({ model: "openai/gpt-test" })
    if (url.pathname === "/config/providers") return json({ providers: [provider], default: { openai: "gpt-test" } })
    if (url.pathname === "/agent") return json([agent])
    if (url.pathname === "/provider")
      return json({ all: [provider], default: { openai: "gpt-test" }, connected: ["openai"] })
    if (url.pathname === "/project/current") return json({ id: "proj_test", worktree })
    if (url.pathname === "/project/proj_test/directories") return json([{ directory: worktree }])
    if (url.pathname === "/api/command")
      return json({
        location: { directory, project: { id: "proj_test", directory: worktree } },
        data: options.commands ?? [],
      })
    return undefined
  })
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url)
    if (url.pathname === "/path") {
      const currentDirectory = url.searchParams.get("directory") ?? directory
      return json({ home: options.root, state, config: options.root, worktree, directory: currentDirectory })
    }
    if (url.pathname === "/experimental/project/proj_test/copy/generate-name") return json({ name: "copy" })
    if (url.pathname === "/experimental/project/proj_test/copy" && request.method === "POST") {
      requests.copies += 1
      return json({ directory: copyDirectory })
    }
    const body = request.body ? ((await request.clone().json()) as Record<string, unknown>) : {}
    if (url.pathname === "/api/session" && request.method === "POST") {
      requests.creates.push(body)
      return (await sessionResponses.shift()) ?? json({ data: { id: body.id } })
    }
    const promptMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/prompt$/)
    if (promptMatch && request.method === "POST") {
      requests.promptSessionIDs.push(promptMatch[1])
      requests.prompts.push(body)
      return (await promptResponses.shift()) ?? admissionSuccess({ ...body, sessionID: promptMatch[1] })
    }
    if (/^\/api\/session\/[^/]+\/command$/.test(url.pathname) && request.method === "POST") {
      requests.commands.push(body)
      return (await commandResponses.shift()) ?? admissionSuccess(body)
    }
    const shellMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/shell$/)
    if (shellMatch && request.method === "POST") {
      requests.shells.push({ ...body, sessionID: shellMatch[1] })
      return (await shellResponses.shift()) ?? new Response(null, { status: 204 })
    }
    return calls.fetch(request)
  }) as typeof globalThis.fetch
  const events = createEventSource()

  let prompt: PromptRef | undefined
  let route!: ReturnType<typeof useRoute>
  let sync!: ReturnType<typeof useSync>
  let local!: ReturnType<typeof useLocal>
  let dialog!: ReturnType<typeof useDialog>
  let toast!: ReturnType<typeof useToast>
  let destination!: NonNullable<ReturnType<typeof useHomeSessionDestination>>
  let keymap!: ReturnType<typeof createDefaultOpenTuiKeymap>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  function HomePrompt() {
    let current: PromptRef | undefined
    destination = useHomeSessionDestination()!
    return (
      <Prompt
        ref={(value) => {
          if (value) {
            current = value
            prompt = value
            return
          }
          if (prompt === current) prompt = undefined
          current = undefined
        }}
      />
    )
  }

  function SessionPrompt(props: { sessionID: string }) {
    let current: PromptRef | undefined
    return (
      <Prompt
        sessionID={props.sessionID}
        ref={(value) => {
          if (value) {
            current = value
            prompt = value
            return
          }
          if (prompt === current) prompt = undefined
          current = undefined
        }}
      />
    )
  }

  function Probe() {
    route = useRoute()
    sync = useSync()
    local = useLocal()
    dialog = useDialog()
    toast = useToast()
    onMount(ready)
    return (
      <>
        <Show when={route.data.type === "home"}>
          <HomeSessionDestinationProvider>
            <HomePrompt />
          </HomeSessionDestinationProvider>
        </Show>
        <Show when={route.data.type === "session" ? route.data.sessionID : undefined}>
          {(sessionID) => <SessionPrompt sessionID={sessionID()} />}
        </Show>
      </>
    )
  }

  function Harness() {
    const renderer = useRenderer()
    keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts directory={directory} paths={{ home: options.root, state, worktree }}>
        <ExitProvider exit={() => {}}>
          <ClipboardProvider value={{}}>
            <OpencodeKeymapProvider keymap={keymap}>
              <ArgsProvider>
                <KVProvider>
                  <ToastProvider>
                    <RouteProvider>
                      <TuiConfigProvider config={config}>
                        <SDKProvider url="http://test" directory={directory} fetch={fetch} events={events.source}>
                          <ProjectProvider>
                            <SyncProvider>
                              <DataProvider>
                                <ThemeProvider mode="dark">
                                  <LocalProvider>
                                    <PromptStashProvider>
                                      <DialogProvider>
                                        <FrecencyProvider>
                                          <PromptHistoryProvider>
                                            <EditorContextProvider integration={{}}>
                                              <Probe />
                                            </EditorContextProvider>
                                          </PromptHistoryProvider>
                                        </FrecencyProvider>
                                      </DialogProvider>
                                    </PromptStashProvider>
                                  </LocalProvider>
                                </ThemeProvider>
                              </DataProvider>
                            </SyncProvider>
                          </ProjectProvider>
                        </SDKProvider>
                      </TuiConfigProvider>
                    </RouteProvider>
                  </ToastProvider>
                </KVProvider>
              </ArgsProvider>
            </OpencodeKeymapProvider>
          </ClipboardProvider>
        </ExitProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width: 100, height: 30, kittyKeyboard: true })
  await mounted
  await wait(() => sync.status === "complete" && local.model.ready && prompt !== undefined)
  await app.renderOnce()
  prompt!.focus()
  await wait(() => app.renderer.currentFocusedEditor instanceof TextareaRenderable)
  return {
    app,
    copyDirectory,
    get destination() {
      return destination
    },
    dialog,
    dispose() {
      prompt?.reset()
      app.renderer.destroy()
    },
    get hasPrompt() {
      return prompt !== undefined
    },
    keymap,
    get ref() {
      if (!prompt) throw new Error("prompt is not mounted")
      return prompt
    },
    requests,
    route,
    state,
    toast,
  }
}

test("transfers edits through the production Home-to-Session prompt teardown", async () => {
  await using tmp = await tmpdir()
  const admission = deferred<Response>()
  const harness = await mountPrompt({ root: tmp.path, promptResponses: [admission.promise] })

  try {
    harness.ref.set({ input: "original prompt", parts: [] })
    harness.ref.submit()
    await wait(() => harness.requests.prompts.length === 1)

    harness.ref.set({ input: "newer draft", parts: [] })
    admission.resolve(admissionSuccess(harness.requests.prompts[0]))
    await wait(() => harness.route.data.type === "session")
    await wait(() => harness.hasPrompt && harness.ref.current.input === "newer draft")

    expect(harness.requests.prompts[0]).toMatchObject({ prompt: { text: "original prompt" } })
    expect(harness.ref.current.input).toBe("newer draft")
    const historyPath = path.join(harness.state, "prompt-history.jsonl")
    await wait(async () =>
      (
        await Bun.file(historyPath)
          .text()
          .catch(() => "")
      ).includes("original prompt"),
    )
    const history = (await Bun.file(historyPath).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(history.at(-1)).toMatchObject({ input: "original prompt", mode: "normal" })
  } finally {
    harness.dispose()
  }
})

test("admits one real prompt for concurrent submits and ignores a later empty submit", async () => {
  await using tmp = await tmpdir()
  const created = deferred<Response>()
  const harness = await mountPrompt({ root: tmp.path, sessionResponses: [created.promise] })

  try {
    harness.ref.set({ input: "send once", parts: [] })
    harness.ref.submit()
    harness.ref.submit()
    await wait(() => harness.requests.creates.length === 1)

    created.resolve(json({ data: { id: harness.requests.creates[0].id } }))
    await wait(() => harness.route.data.type === "session")
    expect(harness.requests.creates).toHaveLength(1)
    expect(harness.requests.prompts).toHaveLength(1)
    expect(harness.requests.prompts[0]).toMatchObject({ prompt: { text: "send once" } })

    harness.ref.submit()
    await Bun.sleep(20)
    expect(harness.requests.creates).toHaveLength(1)
    expect(harness.requests.prompts).toHaveLength(1)
  } finally {
    harness.dispose()
  }
})

test("coalesces a remounted submit while session creation is still pending", async () => {
  await using tmp = await tmpdir()
  const created = deferred<Response>()
  const harness = await mountPrompt({ root: tmp.path, sessionResponses: [created.promise] })

  try {
    harness.ref.set({ input: "wait for session creation", parts: [] })
    harness.ref.submit()
    await wait(() => harness.requests.creates.length === 1)
    const sessionID = String(harness.requests.creates[0].id)

    harness.route.navigate({ type: "session", sessionID })
    await wait(
      () =>
        harness.route.data.type === "session" &&
        harness.hasPrompt &&
        harness.ref.current.input === "wait for session creation",
    )
    harness.ref.submit()
    await Bun.sleep(20)

    expect(harness.requests.creates).toHaveLength(1)
    expect(harness.requests.prompts).toHaveLength(0)

    created.resolve(json({ data: { id: sessionID } }))
    await wait(() => harness.requests.prompts.length === 1)
    await Bun.sleep(20)

    expect(harness.requests.prompts).toHaveLength(1)
    expect(harness.requests.promptSessionIDs).toEqual([sessionID])
    expect(typeof harness.requests.prompts[0].id).toBe("string")
    expect(new Set(harness.requests.prompts.map((item) => item.id)).size).toBe(1)
  } finally {
    harness.dispose()
  }
})

test("preserves copied destination and stable retry ids across Home and Session prompt remounts", async () => {
  await using tmp = await tmpdir()
  const admission = deferred<Response>()
  const harness = await mountPrompt({
    root: tmp.path,
    sessionResponses: [failure("create rejected")],
    promptResponses: [admission.promise],
  })

  try {
    harness.destination.setDestination({ type: "new" })
    harness.ref.set({ input: "retry me", parts: [] })
    harness.ref.submit()
    await wait(() => harness.toast.currentToast?.title === "Creating a session failed")
    const sessionID = String(harness.requests.creates[0].id)

    harness.route.navigate({ type: "session", sessionID })
    await wait(
      () => harness.route.data.type === "session" && harness.hasPrompt && harness.ref.current.input === "retry me",
    )
    harness.route.navigate({ type: "home" })
    await wait(() => {
      const destination = harness.destination.destination()
      return (
        harness.route.data.type === "home" &&
        harness.hasPrompt &&
        harness.ref.current.input === "retry me" &&
        destination?.type === "directory" &&
        destination.directory === harness.copyDirectory
      )
    })

    harness.ref.submit()
    await wait(() => harness.requests.prompts.length === 1)
    expect(harness.requests.creates).toHaveLength(2)

    harness.route.navigate({ type: "session", sessionID })
    await wait(
      () => harness.route.data.type === "session" && harness.hasPrompt && harness.ref.current.input === "retry me",
    )
    admission.resolve(failure("prompt rejected"))
    await wait(() => harness.toast.currentToast?.title === "Failed to send prompt")
    expect(harness.ref.current.input).toBe("retry me")

    harness.ref.submit()
    await wait(() => harness.requests.prompts.length === 2 && harness.hasPrompt && harness.ref.current.input === "")

    expect(harness.requests.copies).toBe(1)
    expect(harness.requests.creates).toHaveLength(2)
    expect(new Set(harness.requests.creates.map((item) => item.id)).size).toBe(1)
    expect(
      harness.requests.creates.every(
        (item) => (item.location as { directory: string }).directory === harness.copyDirectory,
      ),
    ).toBe(true)
    expect(harness.requests.prompts).toHaveLength(2)
    expect(harness.requests.prompts[0].id).toBe(harness.requests.prompts[1].id)
    expect(harness.requests.promptSessionIDs).toEqual([sessionID, sessionID])
    expect(harness.ref.current.input).toBe("")
  } finally {
    harness.dispose()
  }
})

test("reuses the stable message id when a slash command admission is retried", async () => {
  await using tmp = await tmpdir()
  const harness = await mountPrompt({
    root: tmp.path,
    commands: [{ name: "review", template: "Review $ARGUMENTS" }],
    commandResponses: [failure("command rejected")],
  })

  try {
    harness.ref.set({ input: "/review now", parts: [] })
    harness.ref.submit()
    await wait(() => harness.toast.currentToast?.title === "Failed to send command")
    await Bun.sleep(10)

    harness.ref.submit()
    await wait(() => harness.route.data.type === "session")

    expect(harness.requests.commands).toHaveLength(2)
    expect(harness.requests.commands[0].id).toBe(harness.requests.commands[1].id)
    expect(harness.requests.commands[0]).toMatchObject({ command: "review", arguments: "now" })
    expect(new Set(harness.requests.creates.map((item) => item.id)).size).toBe(1)
  } finally {
    harness.dispose()
  }
})

test("does not retry an unchanged shell command when the first result is ambiguous", async () => {
  await using tmp = await tmpdir()
  const shellResponse = deferred<Response>()
  const harness = await mountPrompt({ root: tmp.path, shellResponses: [shellResponse.promise] })

  try {
    harness.app.mockInput.pressKey("!")
    await harness.app.renderOnce()
    harness.ref.set({ input: "echo once", parts: [] })
    harness.ref.submit()
    await wait(() => harness.requests.shells.length === 1)
    const sessionID = String(harness.requests.creates[0].id)
    harness.route.navigate({ type: "session", sessionID })
    await wait(
      () => harness.route.data.type === "session" && harness.hasPrompt && harness.ref.current.input === "echo once",
    )
    shellResponse.resolve(failure("connection lost"))
    await wait(() => harness.toast.currentToast?.title === "Shell command status unknown")

    harness.ref.submit()
    await wait(() => harness.toast.currentToast?.title === "Shell command not retried")
    expect(harness.requests.shells).toHaveLength(1)

    harness.ref.set({ input: "echo changed", parts: [] })
    harness.ref.submit()
    await wait(() => harness.requests.shells.length === 2 && harness.ref.current.input === "")

    expect(harness.requests.shells).toHaveLength(2)
    expect(harness.requests.shells.map((item) => item.command)).toEqual(["echo once", "echo changed"])
    expect(harness.requests.creates).toHaveLength(1)
  } finally {
    harness.dispose()
  }
})

test("does not clear a foreign dialog opened while mounted prompt admission is pending", async () => {
  await using tmp = await tmpdir()
  const admission = deferred<Response>()
  const harness = await mountPrompt({ root: tmp.path, promptResponses: [admission.promise] })

  try {
    harness.ref.set({ input: "leave this route", parts: [] })
    harness.ref.focus()
    harness.keymap.dispatchCommand("prompt.submit")
    await wait(() => harness.requests.prompts.length === 1)

    harness.dialog.replace(() => <text>foreign dialog</text>)
    await harness.app.renderOnce()
    admission.resolve(admissionSuccess(harness.requests.prompts[0]))
    await wait(() => harness.route.data.type === "session")
    await Bun.sleep(20)

    expect(harness.dialog.stack).toHaveLength(1)
    expect(harness.app.captureCharFrame()).toContain("foreign dialog")
  } finally {
    harness.dispose()
  }
})
