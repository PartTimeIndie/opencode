import { describe, expect, test } from "bun:test"
import { desktopTestingDefaultModel, desktopTestingPromptModel } from "@/desktop-testing/default-model"
import {
  createModelChainHydrationRunner,
  createModelChainSync,
  hydrateModelChainSettings,
  modelChainAvailability,
  modelChainConfig,
  modelChainReadiness,
  moveModelChain,
  normalizeModelChains,
  reconcileModelChainSettings,
  resolveSessionChainID,
  sameModelChainSettings,
  unavailableModelChainStep,
  validatedModelChain,
  type ModelChain,
  type ModelChainSettings,
} from "./model-chain"

describe("model chain readiness", () => {
  test("keeps saved chains readable while blocking writes after config failure", () => {
    expect(modelChainReadiness({ hydrated: false, configFailed: true })).toEqual({ canManage: true, canWrite: false })
    expect(modelChainReadiness({ hydrated: false, configFailed: false })).toEqual({ canManage: false, canWrite: false })
    expect(modelChainReadiness({ hydrated: true, configFailed: false })).toEqual({ canManage: true, canWrite: true })
    expect(modelChainReadiness({ hydrated: true, configFailed: true })).toEqual({ canManage: true, canWrite: false })
  })

  test("revokes and restores chain writes as config fetches fail and recover", async () => {
    const chain: ModelChain = { id: "saved", name: "Saved", steps: [{ providerID: "p", modelID: "one" }] }
    const edited = { ...chain, name: "Edited" }
    let configFailed = false
    let current: ModelChainSettings = { chains: [chain], defaultChainID: chain.id }
    const writes: ModelChainSettings[] = []
    const sync = createModelChainSync({
      get: () => current,
      set: (value) => {
        current = value
      },
      write: async (value) => {
        writes.push(value)
      },
      report: () => {},
      canCommit: () => modelChainReadiness({ hydrated: true, configFailed }).canWrite,
    })

    await sync.commit({ chains: [edited], defaultChainID: chain.id })
    expect(writes).toEqual([{ chains: [edited], defaultChainID: chain.id }])

    configFailed = true
    await sync.commit({ chains: [chain], defaultChainID: chain.id })
    expect(current).toEqual({ chains: [edited], defaultChainID: chain.id })
    expect(writes).toHaveLength(1)

    configFailed = false
    await sync.commit({ chains: [chain], defaultChainID: chain.id })
    expect(current).toEqual({ chains: [chain], defaultChainID: chain.id })
    expect(writes).toEqual([
      { chains: [edited], defaultChainID: chain.id },
      { chains: [chain], defaultChainID: chain.id },
    ])
  })
})

describe("model chain order", () => {
  const chains: ModelChain[] = ["Planning Chain", "Standard Coder", "Fast Chain"].map((name) => ({
    id: name,
    name,
    steps: [{ providerID: "openai", modelID: "test", variant: "high" }],
  }))

  test("moves a chain before an earlier target without mutating chains or fallback steps", () => {
    const next = moveModelChain(chains, "Fast Chain", "Planning Chain")
    expect(next.map((chain) => chain.id)).toEqual(["Fast Chain", "Planning Chain", "Standard Coder"])
    expect(chains.map((chain) => chain.id)).toEqual(["Planning Chain", "Standard Coder", "Fast Chain"])
    expect(next[0]).toBe(chains[2])
    expect(next[0].steps).toBe(chains[2].steps)
  })

  test("moves a chain after a later target, including across hidden chains", () => {
    expect(moveModelChain(chains, "Planning Chain", "Fast Chain").map((chain) => chain.id)).toEqual([
      "Standard Coder", "Fast Chain", "Planning Chain",
    ])
    expect(moveModelChain(chains, "Planning Chain", "Standard Coder").map((chain) => chain.id)).toEqual([
      "Standard Coder", "Planning Chain", "Fast Chain",
    ])
  })

  test("unknown, identical and empty move targets are no-ops", () => {
    expect(moveModelChain(chains, "missing", "Fast Chain")).toBe(chains)
    expect(moveModelChain(chains, "Fast Chain", "missing")).toBe(chains)
    expect(moveModelChain(chains, "Fast Chain", "Fast Chain")).toBe(chains)
    const empty: ModelChain[] = []
    expect(moveModelChain(empty, "Fast Chain", "Planning Chain")).toBe(empty)
  })

  test("moves to visible neighbors while preserving intervening hidden-chain order", () => {
    const all = ["A", "B", "C", "D", "E"].map((id) => ({ ...chains[0], id, name: id }))
    // Only A, C and E are visible in the picker; B and D must not be swapped.
    expect(moveModelChain(all, "C", "E").map((chain) => chain.id)).toEqual(["A", "B", "D", "E", "C"])
    expect(moveModelChain(all, "E", "C").map((chain) => chain.id)).toEqual(["A", "B", "E", "C", "D"])
  })

  test("uses IDs rather than names to reorder identically named chains", () => {
    const duplicate = chains.map((chain) => ({ ...chain, name: "Same name" }))
    expect(moveModelChain(duplicate, "Fast Chain", "Standard Coder").map((chain) => chain.id)).toEqual([
      "Planning Chain", "Fast Chain", "Standard Coder",
    ])
  })

  test("serializes rapid moves, preserves the default and hydrates the server order", async () => {
    let current: ModelChainSettings = { chains, defaultChainID: "Standard Coder" }
    const writes: ReturnType<typeof modelChainConfig>[] = []
    const sync = createModelChainSync({
      get: () => current,
      set: (value) => { current = value },
      write: async (value) => { writes.push(modelChainConfig(value.chains, value.defaultChainID)) },
      report: (error) => { throw error },
    })
    const first = sync.commit({ ...current, chains: moveModelChain(current.chains, "Fast Chain", "Standard Coder") })
    const second = sync.commit({ ...current, chains: moveModelChain(current.chains, "Fast Chain", "Planning Chain") })
    await Promise.all([first, second])
    expect(writes.map((write) => write.model_chains.map((chain) => chain.id))).toEqual([
      ["Planning Chain", "Fast Chain", "Standard Coder"],
      ["Fast Chain", "Planning Chain", "Standard Coder"],
    ])
    expect(writes.every((write) => write.default_model_chain === "Standard Coder")).toBe(true)
    expect(reconcileModelChainSettings({
      persisted: { chains, defaultChainID: "Standard Coder" },
      configured: current,
    })).toEqual(current)
  })

  test("a failed reorder restores the confirmed order and default", async () => {
    const initial = { chains, defaultChainID: "Standard Coder" }
    let current: ModelChainSettings = initial
    const errors: unknown[] = []
    const sync = createModelChainSync({
      get: () => current,
      set: (value) => { current = value },
      write: async () => { throw new Error("reorder failed") },
      report: (error) => { errors.push(error) },
    })
    await sync.commit({ ...current, chains: moveModelChain(chains, "Fast Chain", "Planning Chain") })
    expect(current).toEqual(initial)
    expect(errors).toEqual([new Error("reorder failed")])
  })
})

describe("model chains", () => {
  const serverCoderChain = {
    id: "06276054-f34d-4420-894d-73707ee82200",
    name: "GLM - Codex",
    steps: [
      { providerID: "zhipuai-coding-plan", modelID: "glm-5.3-flash" },
      { providerID: "cursor", modelID: "grok-4.6", variant: "medium" },
      { providerID: "openai", modelID: "gpt-6-astra", variant: "medium" },
    ],
  }
  const staleLocalCoderChain = {
    id: "06276054-f34d-4420-894d-73707ee82200",
    name: "Standard Coder",
    steps: [
      { providerID: "openai", modelID: "gpt-5.6-terra", variant: "max" },
      { providerID: "zhipuai-coding-plan", modelID: "glm-5.3-flash" },
      { providerID: "openrouter", modelID: "openrouter/free" },
    ],
  }

  test("appends unknown persisted chains but keeps the server-confirmed default", () => {
    const settings = reconcileModelChainSettings({
      persisted: {
        chains: [{ id: "desktop", name: "Desktop", steps: [{ providerID: "one", modelID: "primary" }] }],
        defaultChainID: "desktop",
      },
      configured: {
        chains: [{ id: "cli", name: "CLI", steps: [{ providerID: "two", modelID: "fallback" }] }],
        defaultChainID: "cli",
      },
    })
    expect(settings).toEqual({
      chains: [
        { id: "cli", name: "CLI", steps: [{ providerID: "two", modelID: "fallback" }] },
        { id: "desktop", name: "Desktop", steps: [{ providerID: "one", modelID: "primary" }] },
      ],
      defaultChainID: "cli",
    })
    expect(modelChainConfig(settings.chains, settings.defaultChainID)).toMatchObject({
      model_chains: settings.chains,
      default_model_chain: "cli",
    })
  })

  test("migrates a persisted default only when the server has no valid default", () => {
    const persisted = {
      chains: [{ id: "desktop", name: "Desktop", steps: [{ providerID: "one", modelID: "primary" }] }],
      defaultChainID: "desktop",
    }
    const cli = { chains: [{ id: "cli", name: "CLI", steps: [{ providerID: "two", modelID: "fallback" }] }] }
    expect(reconcileModelChainSettings({ persisted, configured: { ...cli, defaultChainID: undefined } }).defaultChainID)
      .toBe("desktop")
    // A server default pointing at a retired id is not valid, so the persisted one migrates.
    expect(reconcileModelChainSettings({ persisted, configured: { ...cli, defaultChainID: "retired" } }).defaultChainID)
      .toBe("desktop")
    // A local default that matches no merged chain stays unset instead of becoming a silent default.
    expect(reconcileModelChainSettings({
      persisted: { ...persisted, defaultChainID: "retired" },
      configured: { chains: [], defaultChainID: undefined },
    }).defaultChainID).toBeUndefined()
  })

  test("keeps the server-confirmed name and steps when a local chain reuses the same id", () => {
    const settings = reconcileModelChainSettings({
      persisted: { chains: [staleLocalCoderChain], defaultChainID: serverCoderChain.id },
      configured: { chains: [serverCoderChain], defaultChainID: serverCoderChain.id },
    })
    expect(settings).toEqual({ chains: [serverCoderChain], defaultChainID: serverCoderChain.id })
  })

  test("startup with a same-id different-name chain hydrates from the server and never writes back", () => {
    const sets: ModelChainSettings[] = []
    let writes = 0
    hydrateModelChainSettings({
      persisted: { chains: [staleLocalCoderChain], defaultChainID: serverCoderChain.id },
      configured: { chains: [serverCoderChain], defaultChainID: serverCoderChain.id },
      configuredLoaded: true,
      set: (settings) => {
        sets.push(settings)
      },
      write: () => {
        writes++
      },
    })
    expect(sets).toEqual([{ chains: [serverCoderChain], defaultChainID: serverCoderChain.id }])
    expect(writes).toBe(0)
  })

  test("startup writes back only persisted chains the server has never confirmed", () => {
    const cliChain = { id: "cli", name: "CLI", steps: [{ providerID: "two", modelID: "fallback" }] }
    const desktopChain = { id: "desktop", name: "Desktop", steps: [{ providerID: "one", modelID: "primary" }] }
    const writes: ModelChainSettings[] = []
    let stored: ModelChainSettings | undefined
    hydrateModelChainSettings({
      persisted: { chains: [desktopChain], defaultChainID: "desktop" },
      configured: { chains: [cliChain], defaultChainID: "cli" },
      configuredLoaded: true,
      set: (settings) => {
        stored = settings
      },
      write: (settings) => {
        writes.push(settings)
      },
    })
    expect(stored).toEqual({ chains: [cliChain, desktopChain], defaultChainID: "cli" })
    expect(writes).toEqual([{ chains: [cliChain, desktopChain], defaultChainID: "cli" }])
  })

  test("startup without divergence writes nothing", () => {
    let writes = 0
    hydrateModelChainSettings({
      persisted: { chains: [], defaultChainID: undefined },
      configured: { chains: [serverCoderChain], defaultChainID: serverCoderChain.id },
      configuredLoaded: true,
      set: () => {},
      write: () => {
        writes++
      },
    })
    expect(writes).toBe(0)
  })

  test("a pending or failed config fetch hydrates nothing", () => {
    let sets = 0
    let writes = 0
    hydrateModelChainSettings({
      persisted: { chains: [staleLocalCoderChain], defaultChainID: serverCoderChain.id },
      configured: { chains: undefined, defaultChainID: undefined },
      configuredLoaded: false,
      set: () => {
        sets++
      },
      write: () => {
        writes++
      },
    })
    expect(sets).toBe(0)
    expect(writes).toBe(0)
  })

  test("the hydration trigger consumes its one shot only on a loaded config", () => {
    let hydrations = 0
    const run = createModelChainHydrationRunner({
      hydrate: () => {
        hydrations++
      },
    })
    // Pending or failed fetch: the trigger must not consume its single attempt.
    expect(run(false)).toBe(false)
    expect(run(false)).toBe(false)
    expect(hydrations).toBe(0)
    expect(run(true)).toBe(true)
    expect(hydrations).toBe(1)
    // The one shot is consumed: later state flips hydrate exactly never again.
    expect(run(true)).toBe(false)
    expect(run(false)).toBe(false)
    expect(hydrations).toBe(1)
  })

  test("reports hydration ready only after the async chain reconciliation settles", async () => {
    let finishHydration = () => {}
    let ready = false
    const hydration = new Promise<void>((resolve) => (finishHydration = resolve))
    const run = createModelChainHydrationRunner({
      hydrate: () => hydration,
      onHydrated: () => {
        ready = true
      },
    })

    expect(run(true)).toBe(true)
    expect(ready).toBe(false)
    finishHydration()
    await hydration
    expect(ready).toBe(true)
  })

  test("unsetting the default serializes as an explicit null only with an explicit clear", () => {
    // A pre-hydration store with no default must omit the key so the server
    // merge keeps the stored default instead of erasing it.
    expect(modelChainConfig([], undefined)).toEqual({ model_chains: [] })
    // An explicit user clear serializes as the wire's only clear signal.
    expect(JSON.parse(JSON.stringify(modelChainConfig([], undefined, true)))).toEqual({
      model_chains: [],
      default_model_chain: null,
    })
    expect(JSON.parse(JSON.stringify(modelChainConfig([], "cli")))).toEqual({
      model_chains: [],
      default_model_chain: "cli",
    })
  })

  test("appends a duplicated persisted id only once", () => {
    const chain = { id: "desktop", name: "Desktop", steps: [{ providerID: "one", modelID: "primary" }] }
    const settings = reconcileModelChainSettings({
      persisted: { chains: [chain, { ...chain, name: "Desktop copy" }], defaultChainID: undefined },
      configured: { chains: [], defaultChainID: undefined },
    })
    expect(settings.chains).toEqual([chain])
  })

  test("chain write payloads carry only the chain keys", () => {
    expect(Object.keys(modelChainConfig([], undefined)).sort()).toEqual(["model_chains"])
    expect(Object.keys(modelChainConfig([], undefined, true)).sort()).toEqual(["default_model_chain", "model_chains"])
  })

  test("ignores chain edits until server chains have hydrated", async () => {
    const serverChain: ModelChain = { id: "server", name: "Server", steps: [{ providerID: "p", modelID: "server" }] }
    const persistedChain: ModelChain = { id: "local", name: "Local", steps: [{ providerID: "p", modelID: "local" }] }
    const writes: ModelChainSettings[] = []
    let ready = false
    let current: ModelChainSettings = { chains: [persistedChain], defaultChainID: undefined }
    const sync = createModelChainSync({
      get: () => current,
      set: (value) => {
        current = value
      },
      write: async (value) => {
        writes.push(value)
      },
      report: () => {},
      canCommit: () => ready,
    })

    await sync.commit({ chains: [], defaultChainID: undefined })
    expect(current).toEqual({ chains: [persistedChain], defaultChainID: undefined })
    expect(writes).toEqual([])

    ready = true
    await sync.hydrate(
      { chains: [serverChain, persistedChain], defaultChainID: "server" },
      { chains: [serverChain], defaultChainID: "server" },
    )
    expect(current).toEqual({ chains: [serverChain, persistedChain], defaultChainID: "server" })
    expect(writes).toEqual([{ chains: [serverChain, persistedChain], defaultChainID: "server" }])
  })

  test("a chain edit before hydration never erases the server-confirmed default", async () => {
    // Reproduces the lost-default bug: the persisted store has no default yet,
    // the server still confirms one, and a chain edit lands before hydration.
    const chain: ModelChain = { id: "a", name: "A", steps: [{ providerID: "p", modelID: "m" }] }
    const writes: ModelChainSettings[] = []
    let current: ModelChainSettings = { chains: [], defaultChainID: undefined }
    const sync = createModelChainSync({
      get: () => current,
      set: (value) => {
        current = value
      },
      write: async (value) => {
        writes.push(value)
      },
      report: () => {},
    })
    await sync.commit({ chains: [chain], defaultChainID: undefined })
    const wire = JSON.parse(JSON.stringify(modelChainConfig(writes[0]!.chains, writes[0]!.defaultChainID, writes[0]!.clearDefault)))
    // The stored server default survives this write: the key is omitted, and
    // the server merge keeps everything it already confirmed.
    expect(wire).toEqual({ model_chains: [chain] })
  })

  test("an explicit clear reaches the wire and never leaks into later writes", async () => {
    const chain: ModelChain = { id: "a", name: "A", steps: [{ providerID: "p", modelID: "m" }] }
    const writes: ModelChainSettings[] = []
    let current: ModelChainSettings = { chains: [chain], defaultChainID: "a" }
    const sync = createModelChainSync({
      get: () => current,
      set: (value) => {
        current = value
      },
      write: async (value) => {
        writes.push(value)
      },
      report: () => {},
    })
    await sync.commit({ chains: [chain], defaultChainID: undefined, clearDefault: true })
    // The explicit user clear serializes as the wire's only clear signal.
    expect(modelChainConfig(writes[0]!.chains, writes[0]!.defaultChainID, writes[0]!.clearDefault)).toEqual({
      model_chains: [chain],
      default_model_chain: null,
    })

    // A later unrelated edit must not inherit the one-shot clear flag.
    await sync.commit({ chains: [chain], defaultChainID: undefined })
    expect(modelChainConfig(writes[1]!.chains, writes[1]!.defaultChainID, writes[1]!.clearDefault)).toEqual({
      model_chains: [chain],
    })
  })

  test("serializes chain writes in user order with the full newer state", async () => {
    const chainA: ModelChain = { id: "a", name: "A", steps: [{ providerID: "p", modelID: "m" }] }
    const chainB: ModelChain = { id: "b", name: "B", steps: [{ providerID: "p", modelID: "n" }] }
    const writes: ModelChainSettings[] = []
    let current: ModelChainSettings = { chains: [], defaultChainID: undefined }
    const sync = createModelChainSync({
      get: () => current,
      set: (value) => {
        current = value
      },
      write: async (value) => {
        writes.push(value)
      },
      report: () => {},
    })
    const first = sync.commit({ chains: [chainA], defaultChainID: undefined })
    const second = sync.commit({ chains: [chainA, chainB], defaultChainID: "b" })
    await Promise.all([first, second])
    expect(writes).toEqual([
      { chains: [chainA], defaultChainID: undefined },
      { chains: [chainA, chainB], defaultChainID: "b" },
    ])
    expect(current).toEqual({ chains: [chainA, chainB], defaultChainID: "b" })
  })

  test("cross-key overlap: an older failed chains write never rolls back a newer default choice", async () => {
    const chainA: ModelChain = { id: "a", name: "A", steps: [{ providerID: "p", modelID: "m" }] }
    const chainB: ModelChain = { id: "b", name: "B", steps: [{ providerID: "p", modelID: "n" }] }
    const gates: Array<{ resolve: () => void; reject: (error: unknown) => void }> = []
    let current: ModelChainSettings = { chains: [], defaultChainID: undefined }
    const reported: unknown[] = []
    const sync = createModelChainSync({
      get: () => current,
      set: (value) => {
        current = value
      },
      write: (value) =>
        new Promise<ModelChainSettings>((resolve, reject) => {
          gates.push({ resolve: () => resolve(value), reject })
        }),
      report: (error) => {
        reported.push(error)
      },
    })
    const first = sync.commit({ chains: [chainA], defaultChainID: undefined })
    const second = sync.commit({ chains: [chainA, chainB], defaultChainID: "b" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    gates[0]!.reject(new Error("older chains write failed"))
    await first
    await new Promise((resolve) => setTimeout(resolve, 0))
    // The older chains-only failure is ignored: the newer default choice stays.
    expect(current).toEqual({ chains: [chainA, chainB], defaultChainID: "b" })
    expect(reported).toEqual([])
    gates[1]!.resolve()
    await second
    expect(current).toEqual({ chains: [chainA, chainB], defaultChainID: "b" })
  })

  test("the newest failing write rolls back to the last confirmed state", async () => {
    const chainA: ModelChain = { id: "a", name: "A", steps: [{ providerID: "p", modelID: "m" }] }
    const chainB: ModelChain = { id: "b", name: "B", steps: [{ providerID: "p", modelID: "n" }] }
    const gates: Array<{ resolve: () => void; reject: (error: unknown) => void }> = []
    let current: ModelChainSettings = { chains: [], defaultChainID: undefined }
    const reported: unknown[] = []
    const sync = createModelChainSync({
      get: () => current,
      set: (value) => {
        current = value
      },
      write: (value) =>
        new Promise<ModelChainSettings>((resolve, reject) => {
          gates.push({ resolve: () => resolve(value), reject })
        }),
      report: (error) => {
        reported.push(error)
      },
    })
    const first = sync.commit({ chains: [chainA], defaultChainID: undefined })
    await new Promise((resolve) => setTimeout(resolve, 0))
    gates[0]!.resolve()
    await first
    const second = sync.commit({ chains: [chainA, chainB], defaultChainID: "b" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    gates[1]!.reject(new Error("newest write failed"))
    await second
    expect(current).toEqual({ chains: [chainA], defaultChainID: undefined })
    expect(reported).toEqual([new Error("newest write failed")])
  })

  test("a failing first write rolls back to the pre-change state", async () => {
    const initial: ModelChainSettings = {
      chains: [{ id: "c", name: "C", steps: [{ providerID: "p", modelID: "o" }] }],
      defaultChainID: "c",
    }
    const gates: Array<{ resolve: () => void; reject: (error: unknown) => void }> = []
    let current: ModelChainSettings = initial
    const reported: unknown[] = []
    const sync = createModelChainSync({
      get: () => current,
      set: (value) => {
        current = value
      },
      write: (value) =>
        new Promise<ModelChainSettings>((resolve, reject) => {
          gates.push({ resolve: () => resolve(value), reject })
        }),
      report: (error) => {
        reported.push(error)
      },
    })
    const first = sync.commit({ chains: [], defaultChainID: undefined })
    await new Promise((resolve) => setTimeout(resolve, 0))
    gates[0]!.reject(new Error("server write failed"))
    await first
    expect(current).toEqual(initial)
    expect(reported).toEqual([new Error("server write failed")])
  })

  test("initial hydration after an earlier successful user write preserves the user choice", async () => {
    const cliChain = { id: "cli", name: "CLI", steps: [{ providerID: "two", modelID: "fallback" }] }
    const userChain = { id: "user", name: "User", steps: [{ providerID: "three", modelID: "u" }] }
    const gates: Array<{ resolve: () => void; reject: (error: unknown) => void }> = []
    let current: ModelChainSettings = { chains: [cliChain, userChain], defaultChainID: "cli" }
    const sync = createModelChainSync({
      get: () => current,
      set: (value) => {
        current = value
      },
      write: (value) =>
        new Promise<ModelChainSettings>((resolve, reject) => {
          gates.push({ resolve: () => resolve(value), reject })
        }),
      report: () => {},
    })
    const userWrite = sync.commit({ chains: [cliChain, userChain], defaultChainID: "user" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    let hydrationCalls = 0
    const hydration = sync.initialHydrate(async () => {
      hydrationCalls++
      return hydrateModelChainSettings({
        persisted: current,
        configured: { chains: [cliChain, userChain], defaultChainID: "cli" },
        configuredLoaded: true,
        set: (settings) => {
          current = settings
        },
        write: () => {},
      })
    })
    const trigger = createModelChainHydrationRunner({ hydrate: () => hydration })
    expect(trigger(true)).toBe(true)
    // The stale GET must not overwrite the optimistic user default while the
    // earlier PATCH is pending.
    expect(current.defaultChainID).toBe("user")
    gates[0]!.resolve()
    await userWrite
    await hydration
    expect(hydrationCalls).toBe(0)
    expect(current.defaultChainID).toBe("user")
    expect(trigger(true)).toBe(false)
  })

  test("initial hydration proceeds after an earlier user write fails", async () => {
    const cliChain = { id: "cli", name: "CLI", steps: [{ providerID: "two", modelID: "fallback" }] }
    const userChain = { id: "user", name: "User", steps: [{ providerID: "three", modelID: "u" }] }
    const gates: Array<{ resolve: () => void; reject: (error: unknown) => void }> = []
    let current: ModelChainSettings = { chains: [cliChain, userChain], defaultChainID: "cli" }
    const sync = createModelChainSync({
      get: () => current,
      set: (value) => {
        current = value
      },
      write: (value) =>
        new Promise<ModelChainSettings>((resolve, reject) => {
          gates.push({ resolve: () => resolve(value), reject })
        }),
      report: () => {},
    })
    const userWrite = sync.commit({ chains: [cliChain, userChain], defaultChainID: "user" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    let hydrationCalls = 0
    const hydration = sync.initialHydrate(() => {
      hydrationCalls++
    })
    gates[0]!.reject(new Error("user write failed"))
    await userWrite
    await hydration
    expect(hydrationCalls).toBe(1)
    expect(current.defaultChainID).toBe("cli")
  })

  test("initial hydration waits for every write appended while the first write settles", async () => {
    const baseChain = { id: "base", name: "Base", steps: [{ providerID: "one", modelID: "base" }] }
    const firstChain = { id: "first", name: "First", steps: [{ providerID: "one", modelID: "first" }] }
    const secondChain = { id: "second", name: "Second", steps: [{ providerID: "one", modelID: "second" }] }
    const gates: Array<{ resolve: () => void; reject: (error: unknown) => void }> = []
    let current: ModelChainSettings = { chains: [baseChain], defaultChainID: undefined }
    const sync = createModelChainSync({
      get: () => current,
      set: (value) => {
        current = value
      },
      write: (value) =>
        new Promise<ModelChainSettings>((resolve, reject) => {
          gates.push({ resolve: () => resolve(value), reject })
        }),
      report: () => {},
    })
    const first = sync.commit({ chains: [baseChain, firstChain], defaultChainID: "first" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    let hydrationCalls = 0
    const hydration = sync.initialHydrate(() => {
      hydrationCalls++
    })
    const second = sync.commit({ chains: [baseChain, secondChain], defaultChainID: "second" })
    gates[0]!.reject(new Error("first write failed"))
    await first
    await new Promise((resolve) => setTimeout(resolve, 0))
    // The first failure must not let hydration run while the appended second
    // write is still pending.
    expect(hydrationCalls).toBe(0)
    gates[1]!.resolve()
    await second
    await hydration
    expect(hydrationCalls).toBe(0)
    expect(current).toEqual({ chains: [baseChain, secondChain], defaultChainID: "second" })
  })

  test("initial hydration proceeds only after all appended user writes fail", async () => {
    const baseChain = { id: "base", name: "Base", steps: [{ providerID: "one", modelID: "base" }] }
    const firstChain = { id: "first", name: "First", steps: [{ providerID: "one", modelID: "first" }] }
    const secondChain = { id: "second", name: "Second", steps: [{ providerID: "one", modelID: "second" }] }
    const gates: Array<{ resolve: () => void; reject: (error: unknown) => void }> = []
    let current: ModelChainSettings = { chains: [baseChain], defaultChainID: undefined }
    const sync = createModelChainSync({
      get: () => current,
      set: (value) => {
        current = value
      },
      write: (value) =>
        new Promise<ModelChainSettings>((resolve, reject) => {
          gates.push({ resolve: () => resolve(value), reject })
        }),
      report: () => {},
    })
    const first = sync.commit({ chains: [baseChain, firstChain], defaultChainID: "first" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    let hydrationCalls = 0
    const hydration = sync.initialHydrate(() => {
      hydrationCalls++
    })
    const second = sync.commit({ chains: [baseChain, secondChain], defaultChainID: "second" })
    gates[0]!.reject(new Error("first write failed"))
    await first
    await new Promise((resolve) => setTimeout(resolve, 0))
    gates[1]!.reject(new Error("second write failed"))
    await second
    await hydration
    expect(hydrationCalls).toBe(1)
    expect(current).toEqual({ chains: [baseChain], defaultChainID: undefined })
  })

  test("a failed hydration write rolls back to the server-confirmed state", async () => {
    const cliChain = { id: "cli", name: "CLI", steps: [{ providerID: "two", modelID: "fallback" }] }
    const desktopChain = { id: "desktop", name: "Desktop", steps: [{ providerID: "one", modelID: "primary" }] }
    const gates: Array<{ resolve: () => void; reject: (error: unknown) => void }> = []
    let current: ModelChainSettings = { chains: [cliChain], defaultChainID: "cli" }
    const reported: unknown[] = []
    const sync = createModelChainSync({
      get: () => current,
      set: (value) => {
        current = value
      },
      write: (value) =>
        new Promise<ModelChainSettings>((resolve, reject) => {
          gates.push({ resolve: () => resolve(value), reject })
        }),
      report: (error) => {
        reported.push(error)
      },
    })
    const hydration = hydrateModelChainSettings({
      persisted: { chains: [desktopChain], defaultChainID: undefined },
      configured: { chains: [cliChain], defaultChainID: "cli" },
      configuredLoaded: true,
      set: (settings) => {
        current = settings
      },
      write: (next, confirmedBase) => sync.hydrate(next, confirmedBase),
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    // While the migration write is in flight the merged state is visible.
    expect(current).toEqual({ chains: [cliChain, desktopChain], defaultChainID: "cli" })
    gates[0]!.reject(new Error("hydration write failed"))
    await hydration
    // The rollback lands on the server-confirmed base, never the merged state.
    expect(current).toEqual({ chains: [cliChain], defaultChainID: "cli" })
    expect(reported).toEqual([new Error("hydration write failed")])
  })

  test("overlap: an older failed hydration write never rolls back a newer user write", async () => {
    const cliChain = { id: "cli", name: "CLI", steps: [{ providerID: "two", modelID: "fallback" }] }
    const desktopChain = { id: "desktop", name: "Desktop", steps: [{ providerID: "one", modelID: "primary" }] }
    const userChain = { id: "user", name: "User", steps: [{ providerID: "three", modelID: "u" }] }
    const gates: Array<{ resolve: () => void; reject: (error: unknown) => void }> = []
    let current: ModelChainSettings = { chains: [cliChain], defaultChainID: "cli" }
    const reported: unknown[] = []
    const writes: ModelChainSettings[] = []
    const sync = createModelChainSync({
      get: () => current,
      set: (value) => {
        current = value
      },
      write: (value) =>
        new Promise<ModelChainSettings>((resolve, reject) => {
          writes.push(value)
          gates.push({ resolve: () => resolve(value), reject })
        }),
      report: (error) => {
        reported.push(error)
      },
    })
    const hydration = hydrateModelChainSettings({
      persisted: { chains: [desktopChain], defaultChainID: undefined },
      configured: { chains: [cliChain], defaultChainID: "cli" },
      configuredLoaded: true,
      set: (settings) => {
        current = settings
      },
      write: (next, confirmedBase) => sync.hydrate(next, confirmedBase),
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const userWrite = sync.commit({ chains: [cliChain, userChain], defaultChainID: "cli" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    gates[0]!.reject(new Error("hydration write failed"))
    await hydration
    await new Promise((resolve) => setTimeout(resolve, 0))
    // The older hydration failure is ignored: the newer user choice stands.
    expect(current).toEqual({ chains: [cliChain, userChain], defaultChainID: "cli" })
    expect(reported).toEqual([])
    gates[1]!.resolve()
    await userWrite
    expect(writes.map((w) => w.chains.map((chain) => chain.id))).toEqual([["cli", "desktop"], ["cli", "user"]])
    expect(current).toEqual({ chains: [cliChain, userChain], defaultChainID: "cli" })
  })

  test("a user write failing after a confirmed hydration rolls back to the hydration state", async () => {
    const cliChain = { id: "cli", name: "CLI", steps: [{ providerID: "two", modelID: "fallback" }] }
    const desktopChain = { id: "desktop", name: "Desktop", steps: [{ providerID: "one", modelID: "primary" }] }
    const userChain = { id: "user", name: "User", steps: [{ providerID: "three", modelID: "u" }] }
    const gates: Array<{ resolve: () => void; reject: (error: unknown) => void }> = []
    let current: ModelChainSettings = { chains: [cliChain], defaultChainID: "cli" }
    const reported: unknown[] = []
    const sync = createModelChainSync({
      get: () => current,
      set: (value) => {
        current = value
      },
      write: (value) =>
        new Promise<ModelChainSettings>((resolve, reject) => {
          gates.push({ resolve: () => resolve(value), reject })
        }),
      report: (error) => {
        reported.push(error)
      },
    })
    const hydration = hydrateModelChainSettings({
      persisted: { chains: [desktopChain], defaultChainID: undefined },
      configured: { chains: [cliChain], defaultChainID: "cli" },
      configuredLoaded: true,
      set: (settings) => {
        current = settings
      },
      write: (next, confirmedBase) => sync.hydrate(next, confirmedBase),
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    gates[0]!.resolve()
    await hydration
    const userWrite = sync.commit({ chains: [cliChain, desktopChain, userChain], defaultChainID: "cli" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    gates[1]!.reject(new Error("user write failed"))
    await userWrite
    expect(current).toEqual({ chains: [cliChain, desktopChain], defaultChainID: "cli" })
    expect(reported).toEqual([new Error("user write failed")])
  })

  test("does not rewrite semantically identical chain settings", () => {
    expect(sameModelChainSettings(
      {
        chains: [{ id: "review", name: "Review", steps: [{ providerID: "zhipu", modelID: "glm", variant: "high" }] }],
        defaultChainID: "review",
      },
      {
        chains: [{ name: "Review", id: "review", steps: [{ modelID: "glm", providerID: "zhipu", variant: "high" }] }],
        defaultChainID: "review",
      },
    )).toBe(true)
  })

  test("detects chain order, step, and default changes", () => {
    const current = {
      chains: [{ id: "review", name: "Review", steps: [{ providerID: "zhipu", modelID: "glm" }] }],
      defaultChainID: "review",
    }
    expect(sameModelChainSettings(current, { ...current, defaultChainID: undefined })).toBe(false)
    expect(sameModelChainSettings(current, {
      ...current,
      chains: [{ id: "review", name: "Review", steps: [{ providerID: "openai", modelID: "sol" }] }],
    })).toBe(false)
  })

  test("keeps the server default over a removed local default id", () => {
    expect(reconcileModelChainSettings({
      persisted: { chains: [], defaultChainID: "removed" },
      configured: {
        chains: [{ id: "cli", name: "CLI", steps: [{ providerID: "two", modelID: "fallback" }] }],
        defaultChainID: "cli",
      },
    })).toEqual({
      chains: [{ id: "cli", name: "CLI", steps: [{ providerID: "two", modelID: "fallback" }] }],
      defaultChainID: "cli",
    })
    // With no valid default on either side the id stays unset.
    expect(reconcileModelChainSettings({
      persisted: { chains: [], defaultChainID: "removed" },
      configured: {
        chains: [{ id: "cli", name: "CLI", steps: [{ providerID: "two", modelID: "fallback" }] }],
        defaultChainID: "removed",
      },
    }).defaultChainID).toBeUndefined()
  })

  test("restores valid persisted chains without changing their order or variants", () => {
    expect(normalizeModelChains([{ id: "primary", name: " Standard ", steps: [
      { providerID: "zhipu", modelID: "glm", variant: "high" },
      { providerID: "openai", modelID: "gpt", variant: "medium" },
    ] }])).toEqual([{ id: "primary", name: "Standard", steps: [
      { providerID: "zhipu", modelID: "glm", variant: "high" },
      { providerID: "openai", modelID: "gpt", variant: "medium" },
    ] }])
  })

  test("keeps unavailable steps explicit", () => {
    const [chain] = normalizeModelChains([{ id: "primary", name: "Standard", steps: [
      { providerID: "missing", modelID: "gone" },
      { providerID: "openai", modelID: "gpt" },
    ] }])
    expect(modelChainAvailability(chain!, (step) => step.providerID === "openai").map((step) => step.available))
      .toEqual([false, true])
  })

  test("marks a removed reasoning variant unavailable", () => {
    const [chain] = normalizeModelChains([{ id: "primary", name: "Standard", steps: [
      { providerID: "cursor", modelID: "luna", variant: "GPT-5.6 Luna Extra High" },
    ] }])
    expect(unavailableModelChainStep(chain!, (step) => step.modelID === "luna" ? { variants: { medium: {} } } : undefined))
      .toEqual(chain!.steps[0])
    expect(unavailableModelChainStep(chain!, () => ({ variants: { "GPT-5.6 Luna Extra High": {} } }))).toBeUndefined()
  })

  test("rejects a chain save when a model or exact provider variant is unavailable", () => {
    const chain = { id: "primary", name: "Standard", steps: [
      { providerID: "cursor", modelID: "grok-4.6", variant: "medium" },
    ] }
    expect(validatedModelChain(chain, () => ({ variants: { "Cursor Grok 4.6 Medium": {} } }))).toBeUndefined()
    expect(validatedModelChain(chain, () => undefined)).toBeUndefined()
    expect(validatedModelChain(
      { ...chain, steps: [{ ...chain.steps[0], variant: "Cursor Grok 4.6 Medium" }] },
      () => ({ variants: { "Cursor Grok 4.6 Medium": {} } }),
    )).toEqual({
      id: "primary",
      name: "Standard",
      steps: [{ providerID: "cursor", modelID: "grok-4.6", variant: "Cursor Grok 4.6 Medium" }],
    })
  })

  test("accepts GPT-6 Luna MAX when the provider catalog advertises the exact variant", () => {
    const chain = {
      id: "06276054-f34d-4420-894d-73707ee82200",
      name: "Standard Coder",
      steps: [{ providerID: "openai", modelID: "gpt-6-luna", variant: "max" }],
    }
    const resolve = () => ({ variants: { low: {}, medium: {}, high: {}, xhigh: {}, max: {} } })

    expect(unavailableModelChainStep(chain, resolve)).toBeUndefined()
    expect(validatedModelChain(chain, resolve)).toEqual(chain)
  })

  test("reopen keeps the server-confirmed Standard Coder chain and its GPT-6 Luna MAX step", () => {
    // The exact persisted shape this must survive: both the server config and
    // the renderer's local store confirm the same chain id whose second step
    // carries the MAX variant.
    const lunaCoderChain: ModelChain = {
      id: "06276054-f34d-4420-894d-73707ee82200",
      name: "Standard Coder",
      steps: [
        { providerID: "zhipuai-coding-plan", modelID: "glm-5.3-flash" },
        { providerID: "openai", modelID: "gpt-6-luna", variant: "max" },
        { providerID: "opencode-go", modelID: "muse-spark-1.3-contributor", variant: "high" },
        { providerID: "openrouter", modelID: "openrouter/free" },
      ],
    }
    const configured = { chains: [lunaCoderChain], defaultChainID: lunaCoderChain.id }
    const sets: ModelChainSettings[] = []
    let writes = 0
    hydrateModelChainSettings({
      persisted: { chains: [lunaCoderChain], defaultChainID: lunaCoderChain.id },
      configured,
      configuredLoaded: true,
      set: (settings) => sets.push(settings),
      write: () => {
        writes++
      },
    })

    // Reopen adopts the server-confirmed chain and default without a write-back.
    expect(sets).toEqual([configured])
    expect(writes).toBe(0)

    // The status default and the fallback prompt request serialize the MAX step.
    const reported = desktopTestingDefaultModel(sets[0]!.chains[0])
    expect(reported).toMatchObject({
      providerID: "zhipuai-coding-plan",
      id: "glm-5.3-flash",
      chain: {
        name: "Standard Coder",
        active: 0,
        steps: [
          { providerID: "zhipuai-coding-plan", id: "glm-5.3-flash" },
          { providerID: "openai", id: "gpt-6-luna", variant: "max" },
          { providerID: "opencode-go", id: "muse-spark-1.3-contributor", variant: "high" },
          { providerID: "openrouter", id: "openrouter/free" },
        ],
      },
    })
    expect(desktopTestingPromptModel({ chain: sets[0]!.chains[0] })).toMatchObject({
      providerID: "zhipuai-coding-plan",
      id: "glm-5.3-flash",
      chain: expect.objectContaining({ name: "Standard Coder" }),
    })
  })

  test("reopen keeps the server-confirmed saved choice over a stale local copy of the same id", () => {
    // The stale-sync hazard this pins: the explicit Standard Coder choice is
    // server-confirmed with the Luna MAX step; a diverging local copy holding
    // the retired Sol step must never overwrite it on reopen.
    const lunaCoderChain: ModelChain = {
      id: "06276054-f34d-4420-894d-73707ee82200",
      name: "Standard Coder",
      steps: [
        { providerID: "zhipuai-coding-plan", modelID: "glm-5.3-flash" },
        { providerID: "openai", modelID: "gpt-6-luna", variant: "max" },
        { providerID: "opencode-go", modelID: "muse-spark-1.3-contributor", variant: "high" },
        { providerID: "openrouter", modelID: "openrouter/free" },
      ],
    }
    const staleSolChain: ModelChain = {
      ...lunaCoderChain,
      steps: [
        { providerID: "zhipuai-coding-plan", modelID: "glm-5.3-flash" },
        { providerID: "openai", modelID: "gpt-6.1-sol", variant: "medium" },
        { providerID: "opencode-go", modelID: "muse-spark-1.3-contributor", variant: "high" },
        { providerID: "openrouter", modelID: "openrouter/free" },
      ],
    }
    const sets: ModelChainSettings[] = []
    let writes = 0
    hydrateModelChainSettings({
      persisted: { chains: [staleSolChain], defaultChainID: lunaCoderChain.id },
      configured: { chains: [lunaCoderChain], defaultChainID: lunaCoderChain.id },
      configuredLoaded: true,
      set: (settings) => sets.push(settings),
      write: () => {
        writes++
      },
    })

    expect(sets).toEqual([{ chains: [lunaCoderChain], defaultChainID: lunaCoderChain.id }])
    expect(writes).toBe(0)
  })

  test("resolves the session chain from the selection first, then the default", () => {
    const chains = normalizeModelChains([
      { id: "ox", name: "Ox Alpha", steps: [{ providerID: "opencode", modelID: "ox-alpha" }] },
      { id: "work", name: "Workhorse", steps: [{ providerID: "opencode", modelID: "workhorse-primary" }] },
    ])
    expect(resolveSessionChainID("work", "ox", chains)).toBe("work")
    expect(resolveSessionChainID(undefined, "ox", chains)).toBe("ox")
    expect(resolveSessionChainID(undefined, undefined, chains)).toBeUndefined()
  })

  test("never resolves a session chain id that no longer exists", () => {
    const chains = normalizeModelChains([
      { id: "work", name: "Workhorse", steps: [{ providerID: "opencode", modelID: "workhorse-primary" }] },
    ])
    // An invalid selection falls through to the model path, matching the
    // remembered() behavior it replaces.
    expect(resolveSessionChainID("retired", "work", chains)).toBeUndefined()
    expect(resolveSessionChainID(undefined, "retired", chains)).toBeUndefined()
    expect(resolveSessionChainID("retired", undefined, chains)).toBeUndefined()
  })
})
