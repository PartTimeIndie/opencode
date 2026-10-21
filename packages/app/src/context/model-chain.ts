export type ModelChainStep = {
  providerID: string
  modelID: string
  variant?: string
}

export type ModelChain = {
  id: string
  name: string
  steps: ModelChainStep[]
}

export function moveModelChain(chains: ModelChain[], id: string, targetID: string) {
  const from = chains.findIndex((chain) => chain.id === id)
  const to = chains.findIndex((chain) => chain.id === targetID)
  if (from === -1 || to === -1 || from === to) return chains
  const next = chains.slice()
  // Target IDs also support filtered pickers: moving up lands before the visible
  // neighbor, moving down after it, even when hidden chains lie between them.
  next.splice(from, 1)
  next.splice(to, 0, chains[from])
  return next
}

export type ModelChainSettings = {
  chains: ModelChain[]
  defaultChainID: string | undefined
  /**
   * True only when the user explicitly cleared the default. An unset default
   * from a not-yet-hydrated store must never send the wire's explicit-clear
   * signal or a write would erase the server-confirmed default.
   */
  clearDefault?: boolean
}

export function modelChainReadiness(input: { hydrated: boolean; configFailed: boolean }) {
  return {
    canManage: input.hydrated || input.configFailed,
    canWrite: input.hydrated && !input.configFailed,
  }
}

export function modelChainConfig(chains: ModelChain[], defaultChainID: string | undefined, clearDefault = false) {
  // Only the chain keys: the server merges this patch into its freshly read
  // global config, so a chain write can never revert unrelated config keys.
  // JSON drops undefined keys, so an unset default from a not-yet-hydrated
  // store omits the key entirely and the server merge keeps the stored
  // default. Only an explicit user clear serializes as null — the server's
  // only clear signal.
  return {
    model_chains: chains,
    ...(defaultChainID !== undefined || clearDefault ? { default_model_chain: defaultChainID ?? null } : {}),
  }
}

export function sameModelChainSettings(
  left: { chains: unknown; defaultChainID: string | undefined },
  right: { chains: unknown; defaultChainID: string | undefined },
) {
  const a = normalizeModelChains(left.chains)
  const b = normalizeModelChains(right.chains)
  if (left.defaultChainID !== right.defaultChainID || a.length !== b.length) return false
  return a.every((chain, index) => {
    const other = b[index]
    if (chain.id !== other.id || chain.name !== other.name || chain.steps.length !== other.steps.length) return false
    return chain.steps.every(
      (step, stepIndex) =>
        step.providerID === other.steps[stepIndex].providerID &&
        step.modelID === other.steps[stepIndex].modelID &&
        step.variant === other.steps[stepIndex].variant,
    )
  })
}

export function reconcileModelChainSettings(input: {
  persisted: { chains: unknown; defaultChainID: string | undefined }
  configured: { chains: unknown; defaultChainID: string | undefined }
}): ModelChainSettings {
  // Server-confirmed state always wins: a stale local cache must never rewrite a
  // chain or default the server already confirmed. Persisted chains may only add
  // ids the server has never confirmed and may only fill the default when the
  // server has no valid default.
  const configured = normalizeModelChains(input.configured.chains)
  const chains = [
    ...configured,
    ...normalizeModelChains(input.persisted.chains)
      // Keep the first local copy per id: duplicate ids would append twice and
      // only the first is reachable through find/save.
      .filter((chain, index, all) => all.findIndex((item) => item.id === chain.id) === index)
      .filter((chain) => !configured.some((item) => item.id === chain.id)),
  ]
  const hasChain = (id: string | undefined) => chains.some((chain) => chain.id === id)
  const serverDefault = input.configured.defaultChainID
  const candidate = hasChain(serverDefault) ? serverDefault : input.persisted.defaultChainID
  return { chains, defaultChainID: hasChain(candidate) ? candidate : undefined }
}

/**
 * Startup hydration seam: applies the reconciled settings to the local store and
 * writes back only what the server has never confirmed (appended persisted chains
 * or a migrated default). A local copy that diverges from a server-confirmed chain
 * id or default triggers no write at all; the store just adopts the server state.
 */
export function hydrateModelChainSettings(input: {
  persisted: { chains: unknown; defaultChainID: string | undefined }
  configured: { chains: unknown; defaultChainID: string | undefined }
  configuredLoaded: boolean
  set: (settings: ModelChainSettings) => void
  write: (next: ModelChainSettings, confirmedBase: ModelChainSettings) => Promise<unknown> | void
}): Promise<unknown> | undefined {
  // Server chain state is unknown until the global config query succeeds. A
  // failed or pending startup fetch must never classify every persisted chain
  // as "never confirmed" and write the local cache back over server state.
  if (!input.configuredLoaded) return undefined
  const merged = reconcileModelChainSettings(input)
  input.set(merged)
  if (sameModelChainSettings(merged, input.configured)) return undefined
  // The server state the merge started from is the confirmed rollback base for
  // the migration write: a failed hydration must never leave the never-written
  // merged state in the store.
  const configured = normalizeModelChains(input.configured.chains)
  const confirmedBase: ModelChainSettings = {
    chains: configured,
    defaultChainID: configured.some((chain) => chain.id === input.configured.defaultChainID)
      ? input.configured.defaultChainID
      : undefined,
  }
  return Promise.resolve(input.write(merged, confirmedBase))
}

/**
 * The single serialized write lane for chain settings. Every user change applies
 * optimistically, then writes strictly in user order with the full chain state
 * captured at enqueue time, so a queued write always carries the newest user
 * choice. Every successful write becomes the last server-confirmed base. The
 * newest failing write rolls the local state back to that base — or to the
 * pre-change state when nothing has confirmed yet — while an older failure is
 * ignored because a newer queued write already carries the full newer state.
 */
export function createModelChainSync(input: {
  get: () => ModelChainSettings
  set: (value: ModelChainSettings) => void
  write: (value: ModelChainSettings) => Promise<unknown>
  report: (error: unknown) => void
  canCommit?: () => boolean
}) {
  let confirmed: ModelChainSettings | null = null
  let base = input.get()
  let latestTicket = 0
  let pending = 0
  let lane: Promise<void> = Promise.resolve()

  function enqueue(payload: ModelChainSettings, rollbackTarget: () => ModelChainSettings) {
    const ticket = ++latestTicket
    input.set(payload)
    pending++
    const settled = lane.then(async () => {
      try {
        await input.write(payload)
        // Strip the one-shot clear signal: it applies to this write only and
        // must never leak into a later confirmed base, rollback, or write.
        confirmed = { chains: payload.chains, defaultChainID: payload.defaultChainID }
      } catch (error) {
        if (ticket !== latestTicket) return
        input.set(rollbackTarget())
        input.report(error)
      } finally {
        pending--
      }
    })
    // Advance the lane with a swallowed tail: a throwing rollback handler must
    // not poison every future commit on the lane.
    lane = settled.then(
      () => undefined,
      () => undefined,
    )
    return settled
  }

  return {
    commit(next: ModelChainSettings) {
      if (input.canCommit && !input.canCommit()) return
      // Refresh the rollback base only while the lane is idle: live state equals
      // the last confirmed state then, while mid-lane it holds optimistic changes.
      if (pending === 0) base = input.get()
      const rollbackBase = base
      // clearDefault rides along: an explicit user clear is the wire's only
      // default_model_chain: null signal and must survive the commit lane.
      return enqueue(
        { chains: next.chains, defaultChainID: next.defaultChainID, clearDefault: next.clearDefault },
        () => confirmed ?? rollbackBase,
      )
    },
    /**
     * Startup migration write. The store adopts `next` optimistically, but the
     * rollback target is the explicit server-confirmed base the merge started
     * from — never the never-confirmed merged state. With no divergence there is
     * nothing to write and the caller keeps the store on the server state.
     */
    hydrate(next: ModelChainSettings, confirmedBase: ModelChainSettings) {
      if (pending === 0) base = confirmedBase
      return enqueue(next, () => confirmed ?? confirmedBase)
    },
    /**
     * Sequence initial hydration behind writes that started first. If one of
     * those writes succeeds, its full payload is newer than the startup GET and
     * hydration must not apply the stale GET state afterward. If all earlier
     * writes fail, hydration may still reconcile the server-confirmed GET state.
     */
    async initialHydrate(hydrate: () => Promise<unknown> | void | undefined) {
      let observedTicket = latestTicket
      while (true) {
        const observedLane = lane
        await observedLane
        // A write may have been appended while the observed tail was settling.
        // Wait for the new current tail before deciding whether hydration may run.
        if (pending === 0 && latestTicket === observedTicket) break
        observedTicket = latestTicket
      }
      if (confirmed !== null) return false
      await hydrate()
      return true
    },
  }
}

/**
 * One-shot hydration trigger for the reactive startup effect. The effect re-runs
 * whenever readiness or config-load state changes; `run` consumes its single
 * hydration only when the config actually loaded, so a pending or failed startup
 * fetch keeps retrying instead of permanently skipping hydration.
 */
export function createModelChainHydrationRunner(input: {
  hydrate: () => Promise<unknown> | void | undefined
  onHydrated?: () => void
}) {
  let hydrated = false
  return function run(configLoaded: boolean) {
    if (hydrated || !configLoaded) return false
    hydrated = true
    const result = input.hydrate()
    if (result instanceof Promise) {
      void result.then(input.onHydrated, input.onHydrated)
      return true
    }
    input.onHydrated?.()
    return true
  }
}

export function normalizeModelChains(value: unknown): ModelChain[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const value = item as { id?: unknown; name?: unknown; steps?: unknown }
    if (typeof value.id !== "string" || typeof value.name !== "string" || !Array.isArray(value.steps)) return []
    const steps = value.steps.flatMap((step) => {
      if (!step || typeof step !== "object") return []
      const value = step as { providerID?: unknown; modelID?: unknown; variant?: unknown }
      if (typeof value.providerID !== "string" || typeof value.modelID !== "string") return []
      return [{
        providerID: value.providerID,
        modelID: value.modelID,
        ...(typeof value.variant === "string" && value.variant ? { variant: value.variant } : {}),
      }]
    })
    if (!value.id.trim() || !value.name.trim() || steps.length === 0) return []
    return [{ id: value.id, name: value.name.trim(), steps }]
  })
}

// New sessions resolve their chain from the explicit composer selection and
// fall back to the configured default. Ids that no longer match a stored chain
// are ignored so a retired chain can never be revived implicitly.
export function resolveSessionChainID(
  selectedID: string | undefined,
  defaultID: string | undefined,
  chains: ModelChain[],
) {
  const id = selectedID ?? defaultID
  if (!id) return undefined
  return chains.some((chain) => chain.id === id) ? id : undefined
}

export function modelChainAvailability(
  chain: ModelChain,
  available: (step: ModelChainStep) => boolean,
) {
  return chain.steps.map((step) => ({ ...step, available: available(step) }))
}

export function unavailableModelChainStep(
  chain: ModelChain,
  resolve: (step: ModelChainStep) => { variants?: Record<string, unknown> } | undefined,
) {
  return chain.steps.find((step) => {
    const model = resolve(step)
    if (!model) return true
    return step.variant !== undefined && !Object.hasOwn(model.variants ?? {}, step.variant)
  })
}

export function validatedModelChain(
  value: unknown,
  resolve: (step: ModelChainStep) => { variants?: Record<string, unknown> } | undefined,
) {
  const chain = normalizeModelChains([value])[0]
  if (!chain || unavailableModelChainStep(chain, resolve)) return
  return chain
}
