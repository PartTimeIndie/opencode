import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test"
import { createComponent, createContext, createRoot, createSignal, useContext, type Accessor, type JSX } from "solid-js"

const agents = [
  { name: "plan", mode: "primary", hidden: false, model: { providerID: "provider", modelID: "plan-model" } },
  { name: "build", mode: "primary", hidden: false, model: { providerID: "provider", modelID: "build-model" } },
  { name: "review", mode: "primary", hidden: false, model: { providerID: "provider", modelID: "review-model" } },
] as const
const provider = {
  id: "provider",
  models: Object.fromEntries(agents.map((agent) => [agent.model.modelID, { id: agent.model.modelID, name: agent.model.modelID }])),
}
const modelList = agents.map((agent) => ({ ...provider.models[agent.model.modelID], provider, variants: {} }))

type SwitchAgentInput = { sessionID: string; agent: string; model?: unknown }

function sessionInfo(agent: string, modelID: string, updated: number, chainID?: string) {
  return {
    id: "ses_local_selection",
    agent,
    model: { providerID: provider.id, id: modelID, ...(chainID ? { chain: { id: chainID } } : {}) },
    time: { created: 1, updated },
  }
}

type SessionInfo = ReturnType<typeof sessionInfo>

function createModels() {
  const allModels = new Map(modelList.map((item) => [`${item.provider.id}:${item.id}`, item]))
  const chains = [
    {
      id: "chain-build",
      name: "Build Chain",
      steps: [
        { providerID: provider.id, modelID: "build-model" },
        { providerID: provider.id, modelID: "review-model" },
      ],
    },
    { id: "chain-plan", name: "Plan Chain", steps: [{ providerID: provider.id, modelID: "plan-model" }] },
  ]
  let selectedChainID: string | undefined
  return {
    ready: () => true,
    list: () => modelList,
    find: (key: { providerID: string; modelID: string }) => allModels.get(`${key.providerID}:${key.modelID}`),
    visible: () => true,
    setVisibility() {},
    recent: { list: () => [], push() {} },
    variant: { get: () => undefined, set() {} },
    selection: { model: () => undefined, setModel() {}, setVariant() {} },
    chain: {
      list: () => chains,
      find: (id?: string) => chains.find((chain) => chain.id === id),
      default: () => undefined,
      select(chainID?: string) {
        selectedChainID = chainID
      },
      setDefault() {},
      save() {},
      remove() {},
      move() {},
    },
    selectedChain: () => selectedChainID,
  }
}

type ActiveFixture = {
  params: Accessor<{ id?: string }>
  sessions: Map<string, SessionInfo>
  models: ReturnType<typeof createModels>
  sync: {
    data: { agent: typeof agents; config: Record<string, unknown> }
    session: { get: (id: string) => SessionInfo | undefined }
  }
  tabs: { store: unknown[] }
  sdk: {
    directory: string
    scope: string
    client: { v2: { session: { switchAgent: (input: SwitchAgentInput) => Promise<void>; switchModel: (input: unknown) => Promise<void> } } }
  }
} 

let active: ActiveFixture | undefined
let localModule: typeof import("../src/context/local")
const mounted: Array<() => void> = []

beforeAll(async () => {
  mock.module("@opencode-ai/ui/context", () => ({
    createSimpleContext: (input: { name: string; init: () => unknown }) => {
      const context = createContext<unknown>()
      return {
        use: () => useContext(context),
        provider: (props: { children?: JSX.Element }) =>
          createComponent(context.Provider, { value: input.init(), get children() { return props.children } }),
      }
    },
  }))
  mock.module("@/context/session-route", () => ({
    useSessionRoute: () => {
      const fixture = active!
      return { get id() { return fixture.params().id } }
    },
  }))
  mock.module("@/context/sdk", () => ({ useSDK: () => { const sdk = active!.sdk; return () => sdk } }))
  mock.module("@/context/server-sdk", () => ({ useServerSDK: () => () => ({ scope: "server-scope" }) }))
  mock.module("@/context/sync", () => ({ useSync: () => { const sync = active!.sync; return () => sync } }))
  mock.module("@/context/models", () => ({ useModels: () => active!.models }))
  mock.module("@/hooks/use-providers", () => ({
    useProviders: () => ({
      all: () => new Map([[provider.id, provider]]),
      connected: () => [provider],
      default: () => ({ provider: "plan-model" }),
    }),
  }))
  mock.module("@/context/tabs", () => ({ useTabs: () => active!.tabs }))
  mock.module("@/utils/persist", () => ({
    Persist: { serverWorkspace: () => ({ key: "model-selection" }) },
    persisted: (_options: unknown, state: unknown) => state,
  }))
  mock.module("@/utils/server-scope", () => ({
    ScopedKey: { from: (...parts: string[]) => parts.join("\u0000") },
  }))
  localModule = await import("../src/context/local")
})

afterEach(() => {
  mounted.splice(0).forEach((dispose) => dispose())
  active = undefined
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function source(agent: string, modelID: string, updatedAt: number) {
  return {
    sessionID: "ses_local_selection",
    agent,
    model: { providerID: provider.id, modelID },
    updatedAt,
  }
}

let fixtureID = 0

function setup(
  switchAgent: (input: SwitchAgentInput) => Promise<void>,
  switchModel: (input: unknown) => Promise<void> = async () => undefined,
  directory = `/project-${++fixtureID}`,
  sessionID = "ses_local_selection",
) {
  const [params] = createSignal({ id: sessionID })
  const sessions = new Map([["ses_local_selection", sessionInfo("plan", "plan-model", 100)]])
  const [sessionVersion, setSessionVersion] = createSignal(0)
  const models = createModels()
  active = {
    params,
    sessions,
    models,
    sync: {
      data: { agent: agents, config: {} },
      session: {
        get: (id) => {
          sessionVersion()
          return sessions.get(id)
        },
      },
    },
    tabs: { store: [] },
    sdk: {
      directory,
      scope: "server-scope",
      client: { v2: { session: { switchAgent, switchModel } } },
    },
  }

  let local!: ReturnType<typeof localModule.useLocal>
  createRoot((cleanup) => {
    mounted.push(cleanup)
    createComponent(localModule.LocalProvider, {
      get children() {
        return createComponent(() => {
          local = localModule.useLocal()
          return null
        }, {})
      },
    })
  })
  return {
    local: () => local,
    models,
    setSession(info: SessionInfo) {
      sessions.set(info.id, info)
      setSessionVersion((version) => version + 1)
    },
  }
}

describe("LocalProvider model selection ACK reconciliation", () => {
  test("a rejected write does not block a sibling session or permanently poison the submit gate", async () => {
    const ack = deferred<void>()
    const directory = `/sibling-${++fixtureID}`
    const first = setup(async () => undefined, () => ack.promise, directory).local()
    first.session.restore(source("plan", "plan-model", 100), { force: true })
    first.model.set({ providerID: provider.id, modelID: "build-model" })
    await Promise.resolve()
    ack.reject(new Error("rejected model"))
    const sibling = setup(async () => undefined, undefined, directory, "ses_sibling").local()
    await expect(sibling.session.settled()).resolves.toBeUndefined()
    await expect(first.session.settled()).rejects.toThrow("rejected model")
    await expect(first.session.settled()).resolves.toBeUndefined()
  })

  test("two rejected rapid picks restore the last successful selection", async () => {
    const first = deferred<void>()
    const second = deferred<void>()
    let calls = 0
    const selection = setup(async () => undefined, () => ++calls === 1 ? first.promise : second.promise).local()
    selection.session.restore(source("plan", "plan-model", 100), { force: true })
    selection.model.set({ providerID: provider.id, modelID: "build-model" })
    await Promise.resolve()
    selection.model.set({ providerID: provider.id, modelID: "review-model" })
    first.reject(new Error("first rejected"))
    await new Promise((resolve) => setTimeout(resolve, 0))
    second.reject(new Error("second rejected"))
    await expect(selection.session.settled()).rejects.toThrow("second rejected")
    expect(selection.model.selected()?.modelID).toBe("plan-model")
  })

  test("keeps a manual model through forced stale tab readback before and after ACK", async () => {
    const ack = deferred<void>()
    const { local, setSession } = setup(async () => undefined, () => ack.promise)
    const selection = local()
    selection.session.restore(source("plan", "plan-model", 100), { force: true })
    selection.model.set({ providerID: provider.id, modelID: "build-model" })
    await Promise.resolve()

    selection.session.restore(source("plan", "plan-model", 100), { force: true })
    expect(selection.model.selected()?.modelID).toBe("build-model")
    ack.resolve()
    await selection.session.settled()
    selection.session.restore(source("plan", "plan-model", 100), { force: true })
    expect(selection.model.selected()?.modelID).toBe("build-model")

    setSession(sessionInfo("plan", "build-model", 101))
    selection.session.restore(source("plan", "build-model", 101))
    selection.session.restore(source("plan", "plan-model", 100), { force: true })
    expect(selection.model.selected()?.modelID).toBe("build-model")
  })

  test("does not mistake the first queued picker write for an external switch", async () => {
    const first = deferred<void>()
    const second = deferred<void>()
    let calls = 0
    const selection = setup(async () => undefined, () => ++calls === 1 ? first.promise : second.promise).local()
    selection.session.restore(source("plan", "plan-model", 100), { force: true })
    selection.model.set({ providerID: provider.id, modelID: "build-model" })
    await Promise.resolve()
    selection.model.set({ providerID: provider.id, modelID: "review-model" })
    first.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    selection.session.restore(source("plan", "build-model", 101), { force: true })
    second.resolve()
    await selection.session.settled()
    expect(selection.model.selected()?.modelID).toBe("review-model")
    selection.session.restore(source("plan", "review-model", 102))
    expect(selection.model.selected()?.modelID).toBe("review-model")
  })

  test("keeps pending model selection and serialized writes across provider remounts", async () => {
    const ack = deferred<void>()
    const directory = `/remount-${++fixtureID}`
    const first = setup(async () => undefined, () => ack.promise, directory).local()
    first.session.restore(source("plan", "plan-model", 100), { force: true })
    first.model.set({ providerID: provider.id, modelID: "build-model" })
    await Promise.resolve()
    mounted.pop()!()

    const second = setup(async () => undefined, () => ack.promise, directory).local()
    second.session.restore(source("plan", "plan-model", 100), { force: true })
    expect(second.model.selected()?.modelID).toBe("build-model")
    let settled = false
    const wait = second.session.settled().then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    second.session.restore(source("plan", "review-model", 102), { force: true })
    ack.resolve()
    await wait
    expect(second.model.selected()?.modelID).toBe("review-model")
  })

  test("rolls back a rejected model selection in the remounted receiver", async () => {
    const ack = deferred<void>()
    const directory = `/rejected-remount-${++fixtureID}`
    const first = setup(async () => undefined, () => ack.promise, directory).local()
    first.session.restore(source("plan", "plan-model", 100), { force: true })
    first.model.set({ providerID: provider.id, modelID: "build-model" })
    await Promise.resolve()
    mounted.pop()!()
    const second = setup(async () => undefined, () => ack.promise, directory).local()
    second.session.restore(source("plan", "plan-model", 100), { force: true })
    ack.reject(new Error("model unavailable"))
    await expect(second.session.settled()).rejects.toThrow("model unavailable")
    await Promise.resolve()
    expect(second.model.selected()?.modelID).toBe("plan-model")
  })

  test("does not retain earlier acknowledged picks as permanently intermediate", async () => {
    const selection = setup(async () => undefined).local()
    selection.session.restore(source("plan", "plan-model", 100), { force: true })
    selection.model.set({ providerID: provider.id, modelID: "build-model" })
    await selection.session.settled()
    selection.model.set({ providerID: provider.id, modelID: "review-model" })
    await selection.session.settled()
    selection.session.restore(source("plan", "build-model", 103))
    expect(selection.model.selected()?.modelID).toBe("build-model")
  })

  test("adopts newer canonical session selection without waiting for a tab switch", () => {
    const { local, setSession } = setup(async () => undefined)
    const selection = local()
    selection.session.restore(source("plan", "plan-model", 100), { force: true })
    setSession(sessionInfo("plan", "build-model", 101))
    selection.session.restore(source("plan", "build-model", 101))
    expect(selection.model.selected()?.modelID).toBe("build-model")
  })
})

describe("LocalProvider agent selection ACK reconciliation", () => {
  test("keeps the acknowledged selection through stale readback and accepts a newer external handoff", async () => {
    const ack = deferred<void>()
    let switchCalls = 0
    const { local, setSession } = setup(() => {
      switchCalls += 1
      return ack.promise
    })
    const selection = local()

    selection.session.restore(source("plan", "plan-model", 100), { force: true })
    selection.agent.set("build")
    await Promise.resolve()
    expect(switchCalls).toBe(1)
    expect(selection.agent.current()?.name).toBe("build")

    selection.session.restore(source("build", "plan-model", 101), { force: true })
    expect(selection.agent.current()?.name).toBe("build")

    ack.resolve()
    await selection.session.settled()
    selection.session.restore(source("plan", "plan-model", 100), { force: true })
    expect(selection.agent.current()?.name).toBe("build")

    setSession(sessionInfo("review", "review-model", 102))
    selection.session.restore(source("review", "review-model", 102), { force: true })
    expect(selection.agent.current()?.name).toBe("review")
    expect(selection.model.selected()).toEqual({ providerID: "provider", modelID: "review-model" })
  })

  test("ignores an older session source after a confirming readback", async () => {
    const ack = deferred<void>()
    const { local, setSession } = setup(() => ack.promise)
    const selection = local()

    selection.session.restore(source("plan", "plan-model", 100), { force: true })
    selection.agent.set("build")
    await Promise.resolve()
    ack.resolve()
    await selection.session.settled()

    setSession(sessionInfo("build", "build-model", 101))
    selection.session.restore(source("build", "build-model", 101), { force: true })
    setSession(sessionInfo("plan", "plan-model", 100))
    expect(selection.agent.current()?.name).toBe("build")
    selection.session.restore(source("plan", "plan-model", 100), { force: true })

    expect(selection.agent.current()?.name).toBe("build")
    expect(selection.model.selected()).toEqual({ providerID: "provider", modelID: "build-model" })
  })

  test("keeps the newest pending readback when an older snapshot arrives before ACK", async () => {
    const ack = deferred<void>()
    const { local } = setup(() => ack.promise)
    const selection = local()

    selection.session.restore(source("plan", "plan-model", 100), { force: true })
    selection.agent.set("build")
    await Promise.resolve()

    selection.session.restore(source("review", "review-model", 102), { force: true })
    selection.session.restore(source("build", "plan-model", 101), { force: true })
    ack.resolve()
    await selection.session.settled()

    expect(selection.agent.current()?.name).toBe("review")
    expect(selection.model.selected()).toEqual({ providerID: "provider", modelID: "review-model" })
  })

  test("releases the next queued agent switch after ACK without waiting for readback", async () => {
    const first = deferred<void>()
    const second = deferred<void>()
    const calls: string[] = []
    const { local } = setup(({ agent }) => {
      calls.push(agent)
      return agent === "build" ? first.promise : second.promise
    })
    const selection = local()

    selection.session.restore(source("plan", "plan-model", 100), { force: true })
    selection.agent.set("build")
    await Promise.resolve()
    selection.agent.set("review")
    expect(calls).toEqual(["build"])

    first.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toEqual(["build", "review"])
    expect(selection.agent.current()?.name).toBe("review")

    second.resolve()
    await selection.session.settled()
    expect(selection.agent.current()?.name).toBe("review")
  })

  test("does not let an older failed selection roll back the latest generation", async () => {
    const first = deferred<void>()
    const second = deferred<void>()
    const calls: string[] = []
    const { local } = setup(({ agent }) => {
      calls.push(agent)
      return agent === "build" ? first.promise : second.promise
    })
    const selection = local()

    selection.session.restore(source("plan", "plan-model", 100), { force: true })
    selection.agent.set("build")
    await Promise.resolve()
    expect(calls).toEqual(["build"])

    selection.agent.set("review")
    expect(selection.agent.current()?.name).toBe("review")
    first.reject(new Error("switch acknowledgment was lost"))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(calls).toEqual(["build", "review"])
    expect(selection.agent.current()?.name).toBe("review")
    second.resolve()
    await selection.session.settled()
    expect(selection.agent.current()?.name).toBe("review")
  })
})

const handoffSnapshot = { agent: "build", chainID: "chain-build" }

const chainSource = (agent: string, modelID: string, chainID: string, updatedAt: number) => ({
  sessionID: "ses_local_selection",
  agent,
  model: { providerID: provider.id, modelID, chain: { id: chainID } },
  updatedAt,
})

describe("LocalProvider confirmed agent-handoff selection", () => {
  test("propagates a confirmed handoff selection to a second provider of the same session", async () => {
    const directory = `/handoff-propagate-${++fixtureID}`
    const popup = setup(async () => undefined, undefined, directory).local()
    const composer = setup(async () => undefined, undefined, directory).local()

    popup.session.restore(chainSource("plan", "plan-model", "chain-plan", 100), { force: true })
    composer.session.restore(chainSource("plan", "plan-model", "chain-plan", 100), { force: true })
    expect(composer.agent.current()?.name).toBe("plan")
    expect(composer.model.chain.selected()).toBe("chain-plan")

    expect(popup.session.handoff.begin("ses_local_selection", handoffSnapshot)).toBe(true)
    popup.session.handoff.commit("ses_local_selection", handoffSnapshot)
    await Promise.resolve()

    expect(composer.agent.current()?.name).toBe("build")
    expect(composer.model.chain.selected()).toBe("chain-build")
    expect(composer.model.chain.current()?.name).toBe("Build Chain")
    expect(popup.agent.current()?.name).toBe("build")
    expect(popup.model.chain.selected()).toBe("chain-build")
  })

  test("locks the session pickers while pending and releases them after the transition settles", async () => {
    const { local, models, setSession } = setup(async () => undefined)
    const selection = local()
    selection.session.restore(source("plan", "plan-model", 100), { force: true })

    expect(selection.session.handoff.begin("ses_local_selection", handoffSnapshot)).toBe(true)
    expect(selection.session.handoff.busy()).toBe(true)

    selection.agent.set("review")
    selection.model.set({ providerID: provider.id, modelID: "review-model" })
    selection.model.chain.set("chain-plan")
    selection.model.variant.set("high")
    await Promise.resolve()

    expect(selection.agent.current()?.name).toBe("plan")
    expect(selection.model.selected()?.modelID).toBe("plan-model")
    expect(models.selectedChain()).toBeUndefined()
    expect(selection.session.handoff.begin("ses_local_selection", handoffSnapshot)).toBe(false)

    selection.session.handoff.commit("ses_local_selection", handoffSnapshot)
    expect(selection.session.handoff.busy()).toBe(false)
    await Promise.resolve()
    expect(selection.agent.current()?.name).toBe("build")
    expect(selection.model.chain.selected()).toBe("chain-build")

    // A later manual pick is a new generation and must be accepted.
    selection.model.set({ providerID: provider.id, modelID: "review-model" })
    await Promise.resolve()
    expect(selection.model.selected()?.modelID).toBe("review-model")
    expect(selection.model.chain.selected()).toBeUndefined()

    // The consumed snapshot must not clobber the manual pick on later store touches.
    setSession(sessionInfo("build", "review-model", 103))
    await Promise.resolve()
    expect(selection.model.selected()?.modelID).toBe("review-model")
    expect(selection.model.chain.selected()).toBeUndefined()
  })

  test("does not lock sibling sessions of another route", async () => {
    const directory = `/handoff-sibling-${++fixtureID}`
    const locked = setup(async () => undefined, undefined, directory, "ses_locked").local()
    const sibling = setup(async () => undefined, undefined, directory, "ses_sibling").local()

    locked.session.restore(source("plan", "plan-model", 100), { force: true })
    locked.session.handoff.begin("ses_locked", handoffSnapshot)
    expect(locked.session.handoff.busy()).toBe(true)
    expect(sibling.session.handoff.busy()).toBe(false)

    sibling.agent.set("review")
    await Promise.resolve()
    expect(sibling.agent.current()?.name).toBe("review")
    expect(locked.agent.current()?.name).toBe("plan")
  })

  test("applies an uncertain handoff only after canonical session data confirms it", async () => {
    const { local, setSession } = setup(async () => undefined)
    const selection = local()
    selection.session.restore(chainSource("plan", "plan-model", "chain-plan", 100), { force: true })

    selection.session.handoff.begin("ses_local_selection", handoffSnapshot)
    selection.session.handoff.uncertain("ses_local_selection")
    await Promise.resolve()
    expect(selection.agent.current()?.name).toBe("plan")
    expect(selection.model.chain.selected()).toBe("chain-plan")

    setSession(sessionInfo("plan", "plan-model", 101, "chain-plan"))
    await Promise.resolve()
    expect(selection.agent.current()?.name).toBe("plan")

    setSession(sessionInfo("build", "build-model", 102, "chain-build"))
    await Promise.resolve()
    expect(selection.agent.current()?.name).toBe("build")
    expect(selection.model.chain.selected()).toBe("chain-build")
  })

  test("a remounted provider adopts the committed handoff snapshot", async () => {
    const directory = `/handoff-remount-${++fixtureID}`
    const first = setup(async () => undefined, undefined, directory).local()
    first.session.restore(chainSource("plan", "plan-model", "chain-plan", 100), { force: true })
    first.session.handoff.begin("ses_local_selection", handoffSnapshot)
    first.session.handoff.commit("ses_local_selection", handoffSnapshot)
    await Promise.resolve()
    mounted.pop()!()

    const second = setup(async () => undefined, undefined, directory).local()
    await Promise.resolve()
    expect(second.agent.current()?.name).toBe("build")
    expect(second.model.chain.selected()).toBe("chain-build")
  })
})
