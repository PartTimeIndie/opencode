import type { OptimizationProfile } from "@/context/settings"

export type ServerFeatureKey =
  "core_search_limits" | "tool_materialization_cache" | "runner_request_metrics" | "tool_context_compression"

export type ServerOptimization = {
  profile: OptimizationProfile
  features: Record<ServerFeatureKey, boolean>
}

export type ServerOptimizationInput = {
  profile?: OptimizationProfile
  features?: Partial<Record<ServerFeatureKey, boolean>>
}

/**
 * Canonical feature values for a profile, independent of any locally stored toggles.
 * Off disables every server feature; speed is safe plus tool_materialization_cache.
 */
export function serverOptimizationPreset(profile: OptimizationProfile): ServerOptimization["features"] {
  const enabled = profile !== "off"
  return {
    core_search_limits: enabled,
    tool_materialization_cache: profile === "speed",
    runner_request_metrics: enabled,
    tool_context_compression: enabled,
  }
}

export function resolvedServerOptimization(input?: ServerOptimizationInput): ServerOptimization {
  const profile = input?.profile ?? "safe"
  return serverOptimizationConfig({
    profile,
    features: { ...serverOptimizationPreset(profile), ...input?.features },
  })
}

export function serverOptimizationConfig(input: ServerOptimization): ServerOptimization {
  if (input.profile !== "off") return input
  return {
    profile: input.profile,
    features: Object.fromEntries(
      Object.keys(input.features).map((key) => [key, false]),
    ) as ServerOptimization["features"],
  }
}

/**
 * Every user change resolves to the full composite server state. Because each write
 * replaces the whole optimization config, a successful write confirms profile and
 * features together and no older, partially applied change can survive on the server.
 */
export type OptimizationChange<T> = {
  value: T
  apply: (current: ServerOptimization) => ServerOptimization
}

/**
 * An explicit profile selection is a true preset: the canonical feature values are the
 * change value, so the server payload and the optimistic local apply both come from the
 * preset instead of serializing the previous toggles as overrides. The composite value
 * makes profile and features roll back together on a failed server write.
 */
export function profilePresetChange(value: OptimizationProfile): OptimizationChange<OptimizationProfile> {
  return {
    value,
    apply: () => ({ profile: value, features: serverOptimizationPreset(value) }),
  }
}

export function featureChange(key: ServerFeatureKey, value: boolean): OptimizationChange<boolean> {
  return {
    value,
    apply: (current) => ({ ...current, features: { ...current.features, [key]: value } }),
  }
}

/**
 * The single serialized write lane for optimization settings. Profile presets and
 * feature toggles both commit through this lane: each change is applied optimistically
 * immediately, then written strictly in user order with the composite state captured at
 * enqueue time, so competing writes can never leave the server in a stale state.
 *
 * Every successful write becomes the last server-confirmed base. The newest failing
 * write rolls the local state back to the last server-confirmed state at failure time —
 * earlier writes of the same chain may have confirmed while it was queued — or to the
 * original pre-change state when nothing has confirmed yet. An older failure is ignored
 * because the newer queued write already carries the full newer state. That keeps a
 * stale failure from overwriting a newer confirmed or optimistic user choice.
 */
export function createOptimizationSync(input: {
  get: () => ServerOptimization
  set: (value: ServerOptimization) => void
  write: (value: ServerOptimization) => Promise<unknown>
  report: (error: unknown) => void
}) {
  // Null until the first write succeeds; before that the live local state is the base.
  let confirmed: ServerOptimization | null = null
  let optimistic: ServerOptimization | null = null
  let base = serverOptimizationConfig(input.get())
  let pending = 0
  let latestTicket = 0
  let lane: Promise<void> = Promise.resolve()

  return function commit<T>(change: OptimizationChange<T>) {
    const ticket = ++latestTicket
    // Refresh the rollback base only while the lane is idle: live state equals the last
    // confirmed state then, while mid-chain it still contains optimistic changes.
    if (pending === 0) base = confirmed ?? serverOptimizationConfig(input.get())
    const rollbackBase = base
    const payload = serverOptimizationConfig(change.apply(optimistic ?? rollbackBase))
    optimistic = payload
    input.set(payload)
    pending++
    const settled = lane.then(async () => {
      try {
        await input.write(payload)
        confirmed = payload
        base = payload
      } catch (error) {
        if (ticket !== latestTicket) return
        // The enqueue-time snapshot of this change is stale here: earlier writes of the
        // chain may have confirmed while this write was queued, so the newest failure
        // restores the last confirmed state (or the original base when none confirmed).
        const rollbackTarget = confirmed ?? base
        optimistic = rollbackTarget
        input.set(rollbackTarget)
        input.report(error)
      } finally {
        pending--
      }
    })
    lane = settled
    return settled
  }
}

/**
 * Keeps hydration, user-change guards, confirmed state, and the serialized write
 * lane isolated per server. Each lane closes over the target passed when its server
 * state is created, so a later selection change cannot redirect an already queued
 * write or expose its optimistic/rollback state on another server.
 */
export function createServerOptimizationSync<T extends object>(input: {
  active: () => T
  set: (value: ServerOptimization) => void
  write: (target: T, value: ServerOptimization) => Promise<unknown>
  report: (error: unknown) => void
}) {
  const states = new Map<
    T,
    {
      data: {
        current: ServerOptimization
        hydrated: boolean
        changedByUser: boolean
      }
      commit: ReturnType<typeof createOptimizationSync>
    }
  >()

  const stateFor = (target: T) => {
    const existing = states.get(target)
    if (existing) return existing
    const data = {
      current: resolvedServerOptimization(),
      hydrated: false,
      changedByUser: false,
    }
    const state = {
      data,
      commit: createOptimizationSync({
        get: () => data.current,
        set: (value) => {
          data.current = value
          if (input.active() === target) input.set(value)
        },
        write: (value) => input.write(target, value),
        report: input.report,
      }),
    }
    states.set(target, state)
    return state
  }

  return {
    activate(target: T) {
      const state = states.get(target)
      if (!state?.data.hydrated) return false
      input.set(state.data.current)
      return true
    },
    hydrate(target: T, optimization?: ServerOptimizationInput) {
      if (!optimization) return false
      const state = stateFor(target)
      if (state.data.changedByUser) return true
      state.data.current = resolvedServerOptimization(optimization)
      state.data.hydrated = true
      if (input.active() === target) input.set(state.data.current)
      return true
    },
    commit<TValue>(target: T, change: OptimizationChange<TValue>) {
      const state = states.get(target)
      if (!state?.data.hydrated) return
      state.data.changedByUser = true
      return state.commit(change)
    },
    hydrated(target: T) {
      return states.get(target)?.data.hydrated ?? false
    },
  }
}
