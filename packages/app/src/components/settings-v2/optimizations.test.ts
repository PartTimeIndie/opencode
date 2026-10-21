import { describe, expect, test } from "bun:test"
import type { OptimizationProfile } from "@/context/settings"
import {
  createOptimizationSync,
  createServerOptimizationSync,
  featureChange,
  profilePresetChange,
  resolvedServerOptimization,
  serverOptimizationConfig,
  serverOptimizationPreset,
  type ServerOptimization,
} from "./optimizations-model"

const enabled = {
  core_search_limits: true,
  tool_materialization_cache: true,
  runner_request_metrics: true,
  tool_context_compression: true,
}

const disabled = {
  core_search_limits: false,
  tool_materialization_cache: false,
  runner_request_metrics: false,
  tool_context_compression: false,
}

describe("serverOptimizationConfig", () => {
  test("serializes profile off as all server features disabled", () => {
    expect(serverOptimizationConfig({ profile: "off", features: enabled })).toEqual({
      profile: "off",
      features: disabled,
    })
  })

  test("keeps feature overrides for active profiles", () => {
    expect(serverOptimizationConfig({ profile: "safe", features: enabled })).toEqual({
      profile: "safe",
      features: enabled,
    })
    expect(
      serverOptimizationConfig({ profile: "speed", features: { ...enabled, tool_context_compression: false } }),
    ).toEqual({
      profile: "speed",
      features: { ...enabled, tool_context_compression: false },
    })
  })
})

describe("serverOptimizationPreset", () => {
  test("off disables every server feature", () => {
    expect(serverOptimizationPreset("off")).toEqual(disabled)
  })

  test("safe enables every server feature except tool_materialization_cache", () => {
    expect(serverOptimizationPreset("safe")).toEqual({ ...enabled, tool_materialization_cache: false })
  })

  test("speed is the safe preset plus tool_materialization_cache", () => {
    expect(serverOptimizationPreset("speed")).toEqual(enabled)
  })
})

describe("resolvedServerOptimization", () => {
  test("uses profile defaults and overlays explicit server features", () => {
    expect(resolvedServerOptimization()).toEqual({
      profile: "safe",
      features: { ...enabled, tool_materialization_cache: false },
    })
    expect(resolvedServerOptimization({ profile: "speed" })).toEqual({
      profile: "speed",
      features: enabled,
    })
    expect(
      resolvedServerOptimization({
        profile: "safe",
        features: { core_search_limits: false, tool_materialization_cache: true },
      }),
    ).toEqual({
      profile: "safe",
      features: { ...enabled, core_search_limits: false },
    })
  })

  test("keeps off authoritative over stale explicit server features", () => {
    expect(resolvedServerOptimization({ profile: "off", features: enabled })).toEqual({
      profile: "off",
      features: disabled,
    })
  })
})

const safeState: ServerOptimization = { profile: "safe", features: { ...enabled, tool_materialization_cache: false } }

// Mirrors the SettingsOptimizationsV2 wiring: profile presets and feature toggles both
// commit the whole server optimization state through the production sync engine.
const harness = (initial: ServerOptimization) => {
  const state = { profile: initial.profile, features: { ...initial.features }, reported: [] as unknown[] }
  const payloads: ServerOptimization[] = []
  let activeWrites = 0
  let maxConcurrentWrites = 0
  let write: (next: ServerOptimization) => Promise<unknown> = async (next) => {
    payloads.push(next)
  }
  const commit = createOptimizationSync({
    get: () => ({ profile: state.profile, features: { ...state.features } }),
    set: (next) => {
      state.profile = next.profile
      state.features = { ...next.features }
    },
    write: async (next) => {
      activeWrites++
      maxConcurrentWrites = Math.max(maxConcurrentWrites, activeWrites)
      try {
        await write(next)
      } finally {
        activeWrites--
      }
    },
    report: (error) => {
      state.reported.push(error)
    },
  })
  return {
    state,
    payloads,
    commit,
    select: (value: OptimizationProfile) => commit(profilePresetChange(value)),
    toggle: (value: boolean) => commit(featureChange("tool_context_compression", value)),
    setWrite: (next: typeof write) => {
      write = next
    },
    stats: () => ({ maxConcurrentWrites }),
  }
}

describe("profilePresetChange", () => {
  test("safe to speed applies the speed preset locally and writes it without local overrides", async () => {
    const h = harness(safeState)
    await h.select("speed")
    expect(h.state.profile).toBe("speed")
    expect(h.state.features).toEqual(enabled)
    expect(h.state.reported).toEqual([])
    expect(h.payloads).toEqual([{ profile: "speed", features: enabled }])
  })

  test("off hydration with all features disabled still writes the canonical preset", async () => {
    const hydrated = resolvedServerOptimization({ profile: "off", features: {} })
    expect(hydrated.features).toEqual(disabled)
    const h = harness(hydrated)
    await h.select("safe")
    expect(h.state.features).toEqual({ ...enabled, tool_materialization_cache: false })
    expect(h.payloads).toEqual([{ profile: "safe", features: { ...enabled, tool_materialization_cache: false } }])
    await h.select("speed")
    expect(h.state.features).toEqual(enabled)
    expect(h.payloads.at(-1)).toEqual({ profile: "speed", features: enabled })
  })

  test("a failed profile write rolls profile and features back atomically", async () => {
    const h = harness(safeState)
    const failure = new Error("server write failed")
    h.setWrite(async () => {
      throw failure
    })
    await h.select("speed")
    expect(h.state.profile).toBe("safe")
    expect(h.state.features).toEqual(safeState.features)
    expect(h.state.reported).toEqual([failure])
  })

  test("a stale failed profile write does not roll back a newer selection", async () => {
    const h = harness(safeState)
    let releaseStale: () => void = () => {}
    const staleGate = new Promise<void>((resolve) => {
      releaseStale = resolve
    })
    h.setWrite(async (next) => {
      h.payloads.push(next)
      if (next.profile !== "speed") return
      await staleGate
      throw new Error("stale failure")
    })
    const stale = h.select("speed")
    expect(h.state.profile).toBe("speed")
    const newer = h.select("safe")
    expect(h.state.profile).toBe("safe")
    releaseStale()
    await Promise.all([stale, newer])
    expect(h.state.profile).toBe("safe")
    expect(h.state.features).toEqual({ ...enabled, tool_materialization_cache: false })
    expect(h.state.reported).toEqual([])
    // Writes still go out in user order even though the older one failed.
    expect(h.payloads.map((payload) => payload.profile)).toEqual(["speed", "safe"])
  })
})

describe("createOptimizationSync", () => {
  test("applies a feature change optimistically and keeps it when the write succeeds", async () => {
    const h = harness(safeState)
    await h.toggle(false)
    expect(h.state.features).toEqual({ ...safeState.features, tool_context_compression: false })
    expect(h.state.reported).toEqual([])
    expect(h.payloads).toEqual([{ profile: "safe", features: { ...safeState.features, tool_context_compression: false } }])
  })

  test("cross-key overlap: an older failed profile write never clobbers a newer toggle", async () => {
    const h = harness(safeState)
    let releaseProfile: () => void = () => {}
    const profileGate = new Promise<void>((resolve) => {
      releaseProfile = resolve
    })
    const failure = new Error("profile write failed")
    h.setWrite(async (next) => {
      h.payloads.push(next)
      if (next.features.tool_context_compression) {
        await profileGate
        throw failure
      }
    })
    const profileWrite = h.select("speed")
    const toggleWrite = h.toggle(false)
    // Both changes are applied optimistically while the profile write is still pending.
    expect(h.state.profile).toBe("speed")
    expect(h.state.features).toEqual({ ...enabled, tool_context_compression: false })
    releaseProfile()
    await Promise.all([profileWrite, toggleWrite])
    // The newer toggle choice survives the older profile failure because the newer write
    // already carried and confirmed the full composite state.
    expect(h.state.profile).toBe("speed")
    expect(h.state.features).toEqual({ ...enabled, tool_context_compression: false })
    expect(h.state.reported).toEqual([])
    expect(h.payloads).toEqual([
      { profile: "speed", features: enabled },
      { profile: "speed", features: { ...enabled, tool_context_compression: false } },
    ])
    expect(h.stats().maxConcurrentWrites).toBe(1)
  })

  test("out-of-order failure: a newer failing write rolls back to the confirmed base", async () => {
    const h = harness(safeState)
    const failure = new Error("feature write failed")
    h.setWrite(async (next) => {
      h.payloads.push(next)
      if (!next.features.tool_context_compression) throw failure
    })
    await h.select("speed")
    await h.toggle(false)
    // Rollback restores the confirmed speed preset: the profile stays, only the toggle
    // reverts. It does not fall back to the pre-chain safe state.
    expect(h.state.profile).toBe("speed")
    expect(h.state.features).toEqual(enabled)
    expect(h.state.reported).toEqual([failure])
  })

  test("overlapping enqueues: a failing newest write rolls back to the meanwhile confirmed state", async () => {
    const h = harness(safeState)
    const failure = new Error("feature write failed")
    h.setWrite(async (next) => {
      h.payloads.push(next)
      if (!next.features.tool_context_compression) throw failure
    })
    const profileWrite = h.select("speed")
    // Enqueued while the speed write is still in flight, so the base snapshot taken for
    // this change is still the pre-chain safe state.
    const toggleWrite = h.toggle(false)
    expect(h.state.profile).toBe("speed")
    expect(h.state.features).toEqual({ ...enabled, tool_context_compression: false })
    await profileWrite
    await toggleWrite
    // The speed preset confirmed on the server before the toggle failed, so the rollback
    // must restore that confirmed speed preset instead of the stale safe base that was
    // captured when the toggle was enqueued.
    expect(h.state.profile).toBe("speed")
    expect(h.state.features).toEqual(enabled)
    expect(h.state.reported).toEqual([failure])
    expect(h.payloads).toEqual([
      { profile: "speed", features: enabled },
      { profile: "speed", features: { ...enabled, tool_context_compression: false } },
    ])
    expect(h.stats().maxConcurrentWrites).toBe(1)
  })

  test("two overlapping failures without any confirmation roll back to the original base and report once", async () => {
    const h = harness(safeState)
    const failure = new Error("server write failed")
    h.setWrite(async (next) => {
      h.payloads.push(next)
      throw failure
    })
    const profileWrite = h.select("speed")
    const toggleWrite = h.toggle(false)
    await Promise.all([profileWrite, toggleWrite])
    // Nothing ever confirmed, so the newest failure restores the original pre-chain
    // composite; the superseded older failure stays unreported.
    expect(h.state.profile).toBe("safe")
    expect(h.state.features).toEqual(safeState.features)
    expect(h.state.reported).toEqual([failure])
    expect(h.stats().maxConcurrentWrites).toBe(1)
  })

  test("a change committed after a mixed overlapping chain writes from the restored confirmed base", async () => {
    const h = harness(safeState)
    const failure = new Error("feature write failed")
    let failing = true
    h.setWrite(async (next) => {
      h.payloads.push(next)
      if (failing && !next.features.tool_context_compression) throw failure
    })
    const profileWrite = h.select("speed")
    const toggleWrite = h.toggle(false)
    await Promise.all([profileWrite, toggleWrite])
    expect(h.state.profile).toBe("speed")
    expect(h.state.features).toEqual(enabled)
    expect(h.state.reported).toEqual([failure])
    failing = false
    await h.toggle(false)
    expect(h.state.features).toEqual({ ...enabled, tool_context_compression: false })
    expect(h.state.reported).toEqual([failure])
    expect(h.payloads.at(-1)).toEqual({ profile: "speed", features: { ...enabled, tool_context_compression: false } })
  })

  test("a subsequent successful change after a rollback writes from the restored base", async () => {
    const h = harness(safeState)
    const failure = new Error("feature write failed")
    let failing = true
    h.setWrite(async (next) => {
      h.payloads.push(next)
      if (failing && !next.features.tool_context_compression) throw failure
    })
    await h.select("speed")
    await h.toggle(false)
    await h.toggle(false)
    expect(h.state.features).toEqual(enabled)
    expect(h.state.reported).toEqual([failure, failure])
    failing = false
    await h.toggle(false)
    expect(h.state.features).toEqual({ ...enabled, tool_context_compression: false })
    expect(h.state.reported).toEqual([failure, failure])
    expect(h.payloads.at(-1)).toEqual({ profile: "speed", features: { ...enabled, tool_context_compression: false } })
  })

  test("a first failing write rolls back to the pre-change composite and reports once", async () => {
    const h = harness(safeState)
    const failure = new Error("server write failed")
    h.setWrite(async () => {
      throw failure
    })
    await h.toggle(false)
    expect(h.state.profile).toBe("safe")
    expect(h.state.features).toEqual(safeState.features)
    expect(h.state.reported).toEqual([failure])
  })

  test("a feature change under the off profile keeps the off normalization", async () => {
    const h = harness({ profile: "off", features: disabled })
    await h.toggle(true)
    expect(h.state.features).toEqual(disabled)
    expect(h.payloads).toEqual([{ profile: "off", features: disabled }])
  })
})

describe("createServerOptimizationSync", () => {
  test("keeps a newly selected server disabled until its authoritative config resolves", async () => {
    const serverA = { id: "A" }
    const serverB = { id: "B" }
    let active = serverA
    let visible = resolvedServerOptimization({ profile: "speed" })
    let resolveConfig: (value: { profile: OptimizationProfile }) => void = () => {}
    const config = new Promise<{ profile: OptimizationProfile }>((resolve) => {
      resolveConfig = resolve
    })
    const writes: Array<{ server: string; value: ServerOptimization }> = []
    const sync = createServerOptimizationSync({
      active: () => active,
      set: (value) => {
        visible = value
      },
      write: async (target, value) => {
        writes.push({ server: target.id, value })
      },
      report: () => undefined,
    })

    sync.hydrate(serverA, { profile: "speed" })
    active = serverB
    expect(sync.activate(serverB)).toBe(false)
    expect(sync.hydrate(serverB, undefined)).toBe(false)
    expect(sync.commit(serverB, profilePresetChange("safe"))).toBeUndefined()
    expect(visible.profile).toBe("speed")
    expect(writes).toEqual([])

    const hydration = config.then((optimization) => sync.hydrate(serverB, optimization))
    resolveConfig({ profile: "off" })
    await hydration
    expect(sync.hydrated(serverB)).toBe(true)
    expect(visible).toEqual({ profile: "off", features: disabled })
    expect(writes).toEqual([])
  })

  test("does not let an older config response roll back a change started after hydration", async () => {
    const server = { id: "B" }
    let visible = resolvedServerOptimization({ profile: "off" })
    let resolveOlderConfig: (value: { profile: OptimizationProfile }) => void = () => {}
    const olderConfig = new Promise<{ profile: OptimizationProfile }>((resolve) => {
      resolveOlderConfig = resolve
    })
    const writes: ServerOptimization[] = []
    const sync = createServerOptimizationSync({
      active: () => server,
      set: (value) => {
        visible = value
      },
      write: async (_target, value) => {
        writes.push(value)
      },
      report: () => undefined,
    })

    const staleHydration = olderConfig.then((optimization) => sync.hydrate(server, optimization))
    sync.hydrate(server, { profile: "off" })
    await sync.commit(server, profilePresetChange("speed"))
    resolveOlderConfig({ profile: "off" })
    await staleHydration

    expect(visible).toEqual({ profile: "speed", features: enabled })
    expect(writes).toEqual([{ profile: "speed", features: enabled }])
  })

  test("accepts a later authoritative response while hydrated state is still unchanged by the user", async () => {
    const server = { id: "B" }
    let visible = safeState
    let resolveConfig: (value: { profile: OptimizationProfile }) => void = () => {}
    const config = new Promise<{ profile: OptimizationProfile }>((resolve) => {
      resolveConfig = resolve
    })
    const sync = createServerOptimizationSync({
      active: () => server,
      set: (value) => {
        visible = value
      },
      write: async () => undefined,
      report: () => undefined,
    })

    const laterHydration = config.then((optimization) => sync.hydrate(server, optimization))
    sync.hydrate(server, { profile: "safe" })
    resolveConfig({ profile: "off" })
    await laterHydration

    expect(visible).toEqual({ profile: "off", features: disabled })
  })

  test("keeps hydration, user state, and queued writes bound to their enqueue-time server", async () => {
    const serverA = { id: "A" }
    const serverB = { id: "B" }
    let active = serverA
    let visible = safeState
    let releaseWrite: () => void = () => {}
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    const failure = new Error("A write failed")
    const writes: Array<{ server: string; value: ServerOptimization }> = []
    const reported: unknown[] = []
    const sync = createServerOptimizationSync({
      active: () => active,
      set: (value) => {
        visible = value
      },
      write: async (target, value) => {
        writes.push({ server: target.id, value })
        if (target !== serverA) return
        await writeGate
        throw failure
      },
      report: (error) => reported.push(error),
    })

    sync.hydrate(serverA, { profile: "safe" })
    const writeA = sync.commit(serverA, profilePresetChange("speed"))
    expect(visible.profile).toBe("speed")

    active = serverB
    sync.activate(serverB)
    sync.hydrate(serverB, { profile: "off", features: enabled })
    expect(visible).toEqual({ profile: "off", features: disabled })

    releaseWrite()
    await writeA
    expect(visible).toEqual({ profile: "off", features: disabled })
    expect(writes).toEqual([{ server: "A", value: { profile: "speed", features: enabled } }])
    expect(reported).toEqual([failure])
  })
})
