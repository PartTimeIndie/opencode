import { createSimpleContext } from "@opencode-ai/ui/context"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { batch, createEffect, createMemo, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useModels } from "@/context/models"
import { useProviders } from "@/hooks/use-providers"
import { Persist, persisted } from "@/utils/persist"
import { cycleModelVariant, getConfiguredAgentVariant, resolveModelVariant } from "./model-variant"
import { useSDK } from "./sdk"
import { useSync } from "./sync"
import { useServerSDK } from "./server-sdk"
import { ScopedKey, type ServerScope } from "@/utils/server-scope"
import { useSessionRoute } from "@/context/session-route"
import { useTabs } from "@/context/tabs"
import {
  reconcileRestoredSelection,
  resolveNewTabSelection,
  resolveRestoredSessionSelection,
  resolveSessionModelSelection,
  type AgentSelection,
  type RestoredModel,
} from "@/pages/session/session-model-selection"
import {
  isExplicitVariantSelection,
  migrateLocalSelectionStore,
  resolveLocalModel,
  toSessionModelRef,
} from "./local-model"
import { classifyAgentSelectionReadback, type SelectionModelSnapshot } from "./local-selection-ack"
import { sessionSelectionHandoff, type SessionSelectionHandoffSnapshot } from "./session-selection-handoff"

export type ModelKey = { providerID: string; modelID: string; variant?: string }

type State = {
  agent?: string
  model?: ModelKey
  variant?: string | null
  chainID?: string
}

type SelectionReadback = {
  sessionID: string
  agent: string
  model: RestoredModel
  updatedAt?: number
}

type Saved = {
  session: Record<string, State | undefined>
}

const handoff = new Map<string, State>()

// Dock tab switches remount LocalProvider. Keep pending writes and their
// readback watermark alive, isolated by server, directory and session.
const selectionPersistence = new Map<string, { pending: Promise<unknown>; result?: Promise<unknown> }>()
const selectionGeneration = new Map<string, number>()
const selectionReadbackUpdatedAt = new Map<string, number>()
type SelectionGuard = {
  previousGuard?: SelectionGuard
  failed?: boolean
  generation: number
  expected: { agent: string; model?: SelectionModelSnapshot }
  pendingSelections: { agent: string; model?: SelectionModelSnapshot }[]
  previousModel?: SelectionModelSnapshot
  previous?: State
  previousAgent?: string
  selection: State
  receiver?: symbol
  rollback?: () => void
  baselineUpdatedAt: number
  acknowledged: boolean
  latest?: {
    readback: { agent: string; updatedAt?: number; model: SelectionModelSnapshot }
    apply?: () => void
  }
}
const selectionReadback = new Map<string, SelectionGuard>()

function selectionRollback(guard: SelectionGuard) {
  let current = guard
  while (current.previousGuard?.failed) current = current.previousGuard
  return { previous: current.previous, previousAgent: current.previousAgent }
}

const handoffKey = (scope: ServerScope, dir: string, id: string) => ScopedKey.from(scope, dir, id)

const clone = (value: State | undefined) => {
  if (!value) return
  return {
    ...value,
    model: value.model ? { ...value.model } : undefined,
  } satisfies State
}

// Legacy storage kept a per-directory "last used" workspace selection; new tabs
// now always start from the default agent, so those keys are dropped on load.
const migrate = (value: unknown): Saved => migrateLocalSelectionStore<State>(value)

export const { use: useLocal, provider: LocalProvider } = createSimpleContext({
  name: "Local",
  init: () => {
    const params = useSessionRoute()
    const sdk = useSDK()
    const sync = useSync()
    const serverSDK = useServerSDK()
    const providers = useProviders()
    const models = useModels()
    const tabs = useTabs()

    const id = createMemo(() => params.id || undefined)
    const list = createMemo(() => sync().data.agent.filter((item) => item.mode !== "subagent" && !item.hidden))
    const connected = createMemo(() => new Set(providers.connected().map((item) => item.id)))

    const [saved, setSaved] = persisted(
      {
        ...Persist.serverWorkspace(serverSDK().scope, sdk().directory, "model-selection", ["model-selection.v1"]),
        migrate,
      },
      createStore<Saved>({
        session: {},
      }),
    )

    const [store, setStore] = createStore<{
      current?: string
      draft?: State
      temporary?: State
      last?: {
        type: "agent" | "model" | "variant"
        agent?: string
        model?: ModelKey | null
        variant?: string | null
      }
    }>({
      current: list()[0]?.name,
      draft: undefined,
      temporary: undefined,
      last: undefined,
    })

    const sessionKey = (sessionID: string) => handoffKey(serverSDK().scope, sdk().directory, sessionID)
    const receiver = Symbol("selection receiver")
    onCleanup(() => {
      // Preserve pending data across remounts, but do not retain disposed UI
      // stores through callbacks when the confirming event never arrives.
      selectionReadback.forEach((guard) => {
        let current: SelectionGuard | undefined = guard
        while (current) {
          if (current.receiver === receiver) {
            current.rollback = undefined
            if (current.latest) current.latest.apply = undefined
          }
          current = current.previousGuard
        }
      })
    })

    const queueSelectionWrite = (sessionID: string, task: () => Promise<unknown>) => {
      const key = sessionKey(sessionID)
      const writes = selectionPersistence.get(key) ?? {
        pending: Promise.resolve() as Promise<unknown>,
        result: undefined as Promise<unknown> | undefined,
      }
      const result = writes.pending.then(task)
      // A failed write must remain observable by this Session's submit gate,
      // but must not poison serialization or block any sibling Session.
      writes.pending = result.then(
        () => undefined,
        () => undefined,
      )
      writes.result = result
      selectionPersistence.set(key, writes)
      void result.then(
        () => {
          if (writes.result === result && selectionPersistence.get(key) === writes) selectionPersistence.delete(key)
        },
        () => undefined,
      )
      return result
    }

    // Protect every explicit picker change, not only agent changes. A tab can
    // read the old server snapshot while the serialized write is still pending.
    const protectSelection = (session: string, next: State, previous: State | undefined, previousAgent?: string) => {
      const key = sessionKey(session)
      const generation = (selectionGeneration.get(key) ?? 0) + 1
      selectionGeneration.set(key, generation)
      const current = sync().session.get(session)
      const pending = selectionReadback.get(key)
      const guard = {
        previousGuard: pending && !pending.acknowledged ? pending : undefined,
        pendingSelections: pending && !pending.acknowledged ? [...pending.pendingSelections, pending.expected] : [],
        generation,
        previous: clone(previous),
        previousAgent: previousAgent ?? previous?.agent,
        selection: clone(next)!,
        expected: {
          agent: next.agent ?? current?.agent ?? store.current ?? "",
          ...(next.chainID
            ? { model: { chainID: next.chainID } }
            : next.model
              ? { model: { providerID: next.model.providerID, modelID: next.model.modelID, variant: next.variant } }
              : {}),
        },
        previousModel: current?.model
          ? {
              providerID: current.model.providerID,
              modelID: current.model.id,
              variant: current.model.variant,
              chainID: current.model.chain?.id,
            }
          : undefined,
        baselineUpdatedAt: Math.max(current?.time.updated ?? 0, selectionReadbackUpdatedAt.get(key) ?? 0),
        acknowledged: false,
      }
      selectionReadback.set(key, guard)
      return { key, guard }
    }

    // The server's ModelV2.Ref accepts an explicit `chain: null` for a firm direct
    // selection; the generated SDK type still types `chain` as an object only.
    type SessionModelWire = Parameters<
      ReturnType<typeof sdk>["client"]["v2"]["session"]["switchModel"]
    >[0]["model"]
    const persistModel = (sessionID: string, selection: State, previous: State | undefined) => {
      const model = toSessionModelRef(selection, models.chain.list())
      if (!model) return
      const protectedSelection = protectSelection(sessionID, selection, previous)
      const client = sdk().client
      const task = () =>
        client.v2.session.switchModel({ sessionID, model: model as SessionModelWire }, { throwOnError: true }).then(
          (response) => {
            acknowledgeSelection(protectedSelection.key, protectedSelection.guard)
            return response
          },
          (error) => {
            rejectSelection(protectedSelection.key, protectedSelection.guard, sessionID)
            throw error
          },
        )
      // Picker handlers are fire-and-forget; settled() still exposes rejection
      // to callers that must wait before submitting the next prompt.
      void queueSelectionWrite(sessionID, task).catch(() => undefined)
    }

    const persistAgent = (sessionID: string, name: string, selection: State) => {
      const model = toSessionModelRef(selection, models.chain.list())
      const client = sdk().client
      const task = async () => {
        await client.v2.session.switchAgent({ sessionID, agent: name, model: model as SessionModelWire })
      }
      return queueSelectionWrite(sessionID, task)
    }

    const validModel = (model: ModelKey) => {
      const provider = providers.all().get(model.providerID)
      return !!provider?.models[model.modelID] && connected().has(model.providerID)
    }

    const firstModel = (...items: Array<() => ModelKey | undefined>) => {
      for (const item of items) {
        const model = item()
        if (!model) continue
        if (validModel(model)) return model
      }
    }

    const pickAgent = (name: string | undefined) => {
      const items = list()
      if (items.length === 0) return
      return items.find((item) => item.name === name) ?? items[0]
    }

    // Promotion keeps the actual submitted snapshot, including a manual choice.
    const remembered = (state: State | undefined) => {
      if (state?.model || state?.chainID) return state
      const agent = pickAgent(state?.agent ?? store.current)
      return {
        ...state,
        ...resolveSessionModelSelection({
          agent: agent?.model ? { model: agent.model as AgentSelection["model"], variant: agent.variant } : undefined,
          fresh: true,
          defaultChainID: models.chain.default(),
          fallback: globalDefaultSelection(),
        }),
      }
    }

    function globalDefaultSelection(): State | undefined {
      const configured = sync().data.config.model
      if (configured) {
        const separator = configured.indexOf("/")
        if (separator > 0) {
          const model = { providerID: configured.slice(0, separator), modelID: configured.slice(separator + 1) }
          if (validModel(model)) return { model, variant: null }
        }
      }
      const defaults = providers.default()
      const model = providers
        .connected()
        .flatMap((provider) => {
          const id = defaults[provider.id] ?? Object.values(provider.models)[0]?.id
          if (!id) return []
          return [{ providerID: provider.id, modelID: id }]
        })
        .find(validModel)
      return model ? { model, variant: null } : undefined
    }

    // A new tab always starts on the default agent (build unless configured
    // otherwise, so list order from the server applies) with that agent's
    // configured chain/model. The previous tab's last-used agent and selection
    // must not leak into it.
    const freshTabState = (): State | undefined => {
      const agent = list()[0]
      if (!agent) return
      return resolveNewTabSelection({
        agent: {
          name: agent.name,
          model: agent.model as AgentSelection["model"] | undefined,
          variant: agent.variant,
        },
        defaultChainID: models.chain.default(),
        fallback: globalDefaultSelection(),
      })
    }

    createEffect(() => {
      const items = list()
      if (items.length === 0) {
        if (store.current !== undefined) setStore("current", undefined)
        return
      }
      if (items.some((item) => item.name === store.current)) return
      setStore("current", items[0]?.name)
    })

    const persistedScope = createMemo<State | undefined>(() => {
      const session = id()
      if (!session) return store.draft ?? freshTabState()
      const current = saved.session[session] ?? handoff.get(handoffKey(serverSDK().scope, sdk().directory, session))
      const protectedSelection = selectionReadback.has(sessionKey(session))
      // A committed handoff keeps its confirmed agent name until the canonical
      // record advances past the handoff baseline; a canonically newer external
      // switch always wins over the optimistic snapshot. The canonical read stays
      // conditional so selection timing behavior without a handoff is unchanged.
      let sessionAgent: string | undefined
      const handoffEntry = sessionSelectionHandoff.entry(serverSDK().scope, sdk().directory, session)
      if (protectedSelection) {
        sessionAgent = undefined
      } else if (handoffEntry?.phase === "committed") {
        const info = sync().session.get(session)
        sessionAgent =
          (info?.time.updated ?? 0) <= (handoffEntry.baselineUpdatedAt ?? 0) ? handoffEntry.snapshot.agent : info?.agent
      } else {
        sessionAgent = sync().session.get(session)?.agent
      }
      const restored = reconcileRestoredSelection({
        persisted: current,
        sessionAgent,
      })
      if (restored) return restored
      const createdEmpty = tabs.store.some(
        (tab) =>
          tab.type === "session" &&
          tab.sessionId === session &&
          tab.dirBase64 === base64Encode(sdk().directory) &&
          tab.createdEmpty === true,
      )
      if (!createdEmpty) return
      return freshTabState()
    })

    const scope = createMemo<State | undefined>(() => store.temporary ?? persistedScope())

    createEffect(
      on(id, () => {
        if (store.temporary) setStore("temporary", undefined)
      }),
    )

    createEffect(() => {
      const session = id()
      if (!session) return

      const key = handoffKey(serverSDK().scope, sdk().directory, session)
      const next = handoff.get(key)
      if (!next) return
      if (saved.session[session] !== undefined) {
        handoff.delete(key)
        return
      }

      setSaved("session", session, clone(next))
      handoff.delete(key)
    })

    const configuredModel = () => {
      const configured = sync().data.config.model
      if (!configured) return
      const [providerID, modelID] = configured.split("/")
      const model = { providerID, modelID }
      if (validModel(model)) return model
    }

    const recentModel = () => {
      for (const item of models.recent.list()) {
        if (validModel(item)) return item
      }
    }

    const defaultModel = () => {
      const defaults = providers.default()
      for (const provider of providers.connected()) {
        const configured = defaults[provider.id]
        if (configured) {
          const model = { providerID: provider.id, modelID: configured }
          if (validModel(model)) return model
        }

        const first = Object.values(provider.models)[0]
        if (!first) continue
        const model = { providerID: provider.id, modelID: first.id }
        if (validModel(model)) return model
      }
    }

    const fallback = createMemo<ModelKey | undefined>(() =>
      firstModel(models.selection.model, configuredModel, recentModel, defaultModel),
    )

    const restoreSessionModel = (msg: SelectionReadback, opts?: { force?: boolean }) => {
      const session = id()
      if (!session || msg.sessionID !== session) return
      const key = sessionKey(session)
      const guard = selectionReadback.get(key)
      if (guard) {
        guard.receiver = receiver
        // The newest mounted receiver owns reconciliation after the write ACK.
        guard.rollback = () => {
          if (id() !== session || sessionKey(session) !== key) return
          const rollback = selectionRollback(guard)
          batch(() => {
            setStore("current", rollback.previousAgent)
            setSaved("session", session, clone(rollback.previous))
          })
        }
        if (saved.session[session] === undefined) setSaved("session", session, clone(guard.selection))
      }
      const readback = {
        agent: msg.agent,
        updatedAt: msg.updatedAt,
        model: {
          providerID: msg.model.providerID,
          modelID: msg.model.modelID,
          variant: msg.model.variant,
          chainID: msg.model.chain?.id,
        },
      }
      const latestUpdatedAt = selectionReadbackUpdatedAt.get(key)
      const canonicalChanged =
        latestUpdatedAt !== undefined && readback.updatedAt !== undefined && readback.updatedAt > latestUpdatedAt
      if (readback.updatedAt !== undefined && Number.isFinite(readback.updatedAt)) {
        if (latestUpdatedAt !== undefined && readback.updatedAt < latestUpdatedAt) return
        selectionReadbackUpdatedAt.set(key, readback.updatedAt)
      }
      const outcome = guard
        ? classifyAgentSelectionReadback({
            expected: guard.expected,
            previousModel: guard.previousModel,
            pendingSelections: guard.pendingSelections,
            baselineUpdatedAt: guard.baselineUpdatedAt,
            readback,
          })
        : undefined
      if (guard && outcome) {
        if (!guard.acknowledged) {
          if (
            outcome !== "stale" &&
            (!guard.latest ||
              (readback.updatedAt ?? Number.NEGATIVE_INFINITY) >=
                (guard.latest.readback.updatedAt ?? Number.NEGATIVE_INFINITY))
          )
            guard.latest = { readback, apply: () => restoreSessionModel(msg, { force: true }) }
          return
        }
        if (outcome === "stale" || outcome === "intermediate") return
        selectionReadback.delete(key)
        if (outcome === "external") selectionGeneration.set(key, guard.generation + 1)
      }

      if (handoff.has(key) && !opts?.force && outcome !== "external") return

      const restored = resolveRestoredSessionSelection({
        previous: saved.session[session],
        model: msg.model,
        force: opts?.force || outcome === "external" || canonicalChanged,
        hasChain: (chainID) => !!models.chain.find(chainID),
        isValidModel: validModel,
      })
      if (!restored || restored.action === "skip") return

      const next = { agent: msg.agent, ...restored.selection } satisfies State
      setSaved("session", session, next)
      if (restored.selection.chainID) {
        models.chain.select(restored.selection.chainID)
        return
      }

      models.chain.select(undefined)
      models.selection.setModel(restored.selection.model)
      models.selection.setVariant(restored.selection.model!, restored.selection.variant ?? null)
    }

    // A confirmed handoff committed by any provider of this session (handoff
    // popup, dock, another route) reaches every mounted LocalProvider here, so
    // the composer shows the confirmed agent/chain without a second mutation.
    const appliedHandoffGeneration = new Map<string, number>()
    const handoffSnapshotConfirmed = (session: string, snapshot: SessionSelectionHandoffSnapshot) => {
      const info = sync().session.get(session)
      if (!info || info.agent !== snapshot.agent) return false
      if (snapshot.chainID) return info.model?.chain?.id === snapshot.chainID
      if (!snapshot.model) return false
      return info.model?.providerID === snapshot.model.providerID && info.model?.id === snapshot.model.modelID
    }
    const applyHandoffSelection = (session: string, snapshot: SessionSelectionHandoffSnapshot) => {
      const restored = resolveRestoredSessionSelection({
        previous: saved.session[session],
        model: {
          providerID: snapshot.model?.providerID ?? "",
          modelID: snapshot.model?.modelID ?? "",
          variant: snapshot.variant ?? null,
          chain: snapshot.chainID ? { id: snapshot.chainID } : null,
        },
        force: true,
        hasChain: (chainID) => !!models.chain.find(chainID),
        isValidModel: validModel,
      })
      if (!restored || restored.action === "skip") return
      setSaved("session", session, { agent: snapshot.agent, ...restored.selection })
      if (restored.selection.chainID) {
        models.chain.select(restored.selection.chainID)
        return
      }
      models.chain.select(undefined)
      models.selection.setModel(restored.selection.model)
      models.selection.setVariant(restored.selection.model!, restored.selection.variant ?? null)
    }
    createEffect(() => {
      const session = id()
      if (!session) return
      const entry = sessionSelectionHandoff.entry(serverSDK().scope, sdk().directory, session)
      if (!entry) return
      if (appliedHandoffGeneration.get(session) === entry.generation) return
      if (entry.phase === "pending" || entry.phase === "failed") return
      if (entry.phase === "uncertain" && !handoffSnapshotConfirmed(session, entry.snapshot)) return
      appliedHandoffGeneration.set(session, entry.generation)
      applyHandoffSelection(session, entry.snapshot)
    })

    // Picker mutations are rejected centrally while this route's session has a
    // handoff in flight; the composer additionally disables the controls.
    const selectionLocked = () => {
      const session = id()
      return !!session && sessionSelectionHandoff.busy(serverSDK().scope, sdk().directory, session)
    }

    const acknowledgeSelection = (key: string, guard: NonNullable<ReturnType<typeof selectionReadback.get>>) => {
      if (selectionReadback.get(key) !== guard) return
      guard.acknowledged = true
      const latest = guard.latest
      if (!latest) return
      const outcome = classifyAgentSelectionReadback({
        expected: guard.expected,
        previousModel: guard.previousModel,
        pendingSelections: guard.pendingSelections,
        baselineUpdatedAt: guard.baselineUpdatedAt,
        readback: latest.readback,
      })
      if (outcome === "stale" || outcome === "intermediate") return
      selectionReadback.delete(key)
      if (outcome !== "external") return
      selectionGeneration.set(key, guard.generation + 1)
      latest.apply?.()
    }

    const rejectSelection = (
      key: string,
      guard: NonNullable<ReturnType<typeof selectionReadback.get>>,
      session: string,
    ) => {
      guard.failed = true
      if (selectionReadback.get(key) !== guard || selectionGeneration.get(key) !== guard.generation) return
      selectionReadback.delete(key)
      const latest = guard.latest
      if (
        latest &&
        classifyAgentSelectionReadback({
          expected: guard.expected,
          previousModel: guard.previousModel,
          pendingSelections: guard.pendingSelections,
          baselineUpdatedAt: guard.baselineUpdatedAt,
          readback: latest.readback,
        }) === "external"
      ) {
        selectionGeneration.set(key, guard.generation + 1)
        latest.apply?.()
        return
      }
      if (guard.rollback) return guard.rollback()
      if (id() !== session || sessionKey(session) !== key) return
      const rollback = selectionRollback(guard)
      batch(() => {
        setStore("current", rollback.previousAgent)
        setSaved("session", session, clone(rollback.previous))
      })
    }

    const agent = {
      list,
      current() {
        return pickAgent(scope()?.agent ?? store.current)
      },
      set(name: string | undefined) {
        if (selectionLocked()) return
        const item = pickAgent(name)
        if (!item) {
          setStore("current", undefined)
          return
        }
        if (agent.current()?.name === item.name) return
        const previous = clone(persistedScope())
        const previousAgent = agent.current()?.name
        batch(() => {
          setStore("temporary", undefined)
          setStore("current", item.name)
          setStore("last", {
            type: "agent",
            agent: item.name,
            model: item.model,
            variant: item.variant ?? null,
          })
          const next = {
            agent: item.name,
            ...resolveSessionModelSelection({
              agent: item.model ? { model: item.model as AgentSelection["model"], variant: item.variant } : undefined,
              fresh: true,
              defaultChainID: models.chain.default(),
              fallback: globalDefaultSelection(),
            }),
          } satisfies State
          const session = id()
          if (session) {
            const { key, guard } = protectSelection(session, next, previous, previousAgent)
            setSaved("session", session, next)
            void persistAgent(session, item.name, next)
              .then(() => acknowledgeSelection(key, guard))
              .catch(() => rejectSelection(key, guard, session))
            return
          }
          setStore("draft", next)
        })
      },
      move(direction: 1 | -1) {
        const items = list()
        if (items.length === 0) {
          setStore("current", undefined)
          return
        }

        let next = items.findIndex((item) => item.name === agent.current()?.name) + direction
        if (next < 0) next = items.length - 1
        if (next >= items.length) next = 0
        const item = items[next]
        if (!item) return
        agent.set(item.name)
      },
    }

    const current = () => {
      const selection = scope()
      const chainID = selection?.chainID
      const chain = models.chain.find(chainID)
      if (chainID) {
        if (!chain) return
        const first = chain.steps[0]
        if (!first || !validModel(first)) return
        return models.find(first)
      }
      const explicit = selection?.model
      // An explicit selection that is no longer resolvable (provider disconnected or model
      // removed) must not silently fall through to the agent default: the composer would show
      // and submit a model the user never picked. Return nothing so callers surface the stale
      // selection instead of substituting one.
      const item = resolveLocalModel({
        explicit,
        agent: agent.current()?.model,
        fallback: fallback(),
        isValid: validModel,
      })
      if (!item) return
      return models.find(item)
    }

    const selectedModel = () => scope()?.model
    const selectedChain = () => models.chain.find(scope()?.chainID)

    const configured = () => {
      const item = agent.current()
      const model = current()
      if (!item || !model) return
      return getConfiguredAgentVariant({
        agent: { model: item.model, variant: item.variant },
        model: { providerID: model.provider.id, modelID: model.id, variants: model.variants },
      })
    }

    const selected = () => scope()?.variant

    const snapshot = () => {
      const model = current()
      return {
        agent: agent.current()?.name,
        model: model ? { providerID: model.provider.id, modelID: model.id } : undefined,
        variant: selected(),
        chainID: selectedChain()?.id,
      } satisfies State
    }

    const write = (next: Partial<State>) => {
      const state = {
        ...(persistedScope() ?? { agent: agent.current()?.name }),
        ...next,
      } satisfies State

      setStore("temporary", undefined)
      const session = id()
      if (session) {
        setSaved("session", session, state)
        return
      }
      setStore("draft", state)
    }

    const recent = createMemo(() => models.recent.list().map(models.find).filter(Boolean))

    const model = {
      ready: models.ready,
      current,
      selected: selectedModel,
      recent,
      list: models.list,
      cycle(direction: 1 | -1) {
        const items = recent()
        const item = current()
        if (!item) return

        const index = items.findIndex((entry) => entry?.provider.id === item.provider.id && entry?.id === item.id)
        if (index === -1) return

        let next = index + direction
        if (next < 0) next = items.length - 1
        if (next >= items.length) next = 0

        const entry = items[next]
        if (!entry) return
        model.set({ providerID: entry.provider.id, modelID: entry.id })
      },
      set(item: ModelKey | undefined, options?: { recent?: boolean }) {
        if (selectionLocked()) return
        const previous = clone(persistedScope())
        const next = {
          ...(persistedScope() ?? { agent: agent.current()?.name }),
          model: item,
          chainID: undefined,
        } satisfies State
        batch(() => {
          setStore("last", {
            type: "model",
            agent: agent.current()?.name,
            model: item ?? null,
            variant: selected(),
          })
          write({ model: item, chainID: undefined })
          models.selection.setModel(item)
          if (!item) return
          models.setVisibility(item, true)
          if (!options?.recent) return
          models.recent.push(item)
        })
        const session = id()
        if (session) persistModel(session, next, previous)
      },
      chain: {
        ready: models.chain.ready,
        managementReady: models.chain.managementReady,
        list: models.chain.list,
        current: selectedChain,
        selected: () => scope()?.chainID,
        set(chainID: string | undefined) {
          if (selectionLocked()) return
          const chain = models.chain.find(chainID)
          const previous = clone(persistedScope())
          const next = {
            ...(persistedScope() ?? { agent: agent.current()?.name }),
            chainID: chain?.id,
            model: undefined,
            variant: null,
          } satisfies State
          write(next)
          models.chain.select(chain?.id)
          const session = id()
          if (session) persistModel(session, next, previous)
        },
        default: models.chain.default,
        setDefault: models.chain.setDefault,
        save: models.chain.save,
        remove: models.chain.remove,
        move: models.chain.move,
      },
      visible(item: ModelKey) {
        return models.visible(item)
      },
      setVisibility(item: ModelKey, visible: boolean) {
        models.setVisibility(item, visible)
      },
      variant: {
        configured,
        selected,
        current() {
          const chain = selectedChain()
          if (chain) return chain.steps[0]?.variant
          const resolved = resolveModelVariant({
            variants: this.list(),
            selected: this.selected(),
            configured: this.configured(),
          })
          if (resolved) return resolved
          const model = current()
          if (!model) return
          const saved = models.variant.get({ providerID: model.provider.id, modelID: model.id })
          if (saved && this.list().includes(saved)) return saved
        },
        list() {
          const item = current()
          if (!item?.variants) return []
          return Object.keys(item.variants)
        },
        set(value: string | undefined, options?: { remember?: boolean }) {
          if (selectionLocked()) return
          const previous = clone(persistedScope())
          const next = {
            ...(persistedScope() ?? { agent: agent.current()?.name }),
            variant: value ?? null,
          } satisfies State
          batch(() => {
            const model = current()
            const remember = options?.remember !== false
            setStore("temporary", undefined)
            if (remember) {
              setStore("last", {
                type: "variant",
                agent: agent.current()?.name,
                model: model ? { providerID: model.provider.id, modelID: model.id } : null,
                variant: value ?? null,
              })
            }
            write({ variant: value ?? null })
            if (model && remember) {
              models.selection.setVariant({ providerID: model.provider.id, modelID: model.id }, value ?? null)
              models.variant.set({ providerID: model.provider.id, modelID: model.id }, value ?? undefined)
            }
          })
          const session = id()
          if (session && isExplicitVariantSelection(options)) persistModel(session, next, previous)
        },
        cycle() {
          const items = this.list()
          if (items.length === 0) return
          this.set(
            cycleModelVariant({
              variants: items,
              selected: this.selected(),
              configured: this.configured(),
            }),
          )
        },
      },
    }

    const result = {
      slug: createMemo(() => base64Encode(sdk().directory)),
      selection: {
        snapshot,
        applyTemporary(next: Partial<State>) {
          if (selectionLocked()) return
          setStore("temporary", {
            ...(persistedScope() ?? { agent: agent.current()?.name }),
            ...next,
          })
        },
        clearTemporary() {
          setStore("temporary", undefined)
        },
      },
      model,
      agent,
      session: {
        settled() {
          const session = id()
          const key = session ? sessionKey(session) : undefined
          const writes = key ? selectionPersistence.get(key) : undefined
          const result = writes?.result
          if (!writes || !result) return Promise.resolve()
          return result
            .then(() => undefined)
            .finally(() => {
              // Report a rejected selection once, then allow the restored choice
              // to submit. Do not consume a newer write queued while waiting.
              if (key && writes.result === result && selectionPersistence.get(key) === writes)
                selectionPersistence.delete(key)
            })
        },
        reset() {
          setStore("draft", undefined)
          setStore("temporary", undefined)
        },
        handoff: {
          busy() {
            const session = id()
            if (!session) return false
            return sessionSelectionHandoff.busy(serverSDK().scope, sdk().directory, session)
          },
          begin(sessionID: string, snapshot: SessionSelectionHandoffSnapshot) {
            return sessionSelectionHandoff.begin(
              serverSDK().scope,
              sdk().directory,
              sessionID,
              snapshot,
              sync().session.get(sessionID)?.time.updated,
            )
          },
          commit(sessionID: string, snapshot: SessionSelectionHandoffSnapshot) {
            sessionSelectionHandoff.commit(serverSDK().scope, sdk().directory, sessionID, snapshot)
          },
          fail(sessionID: string) {
            sessionSelectionHandoff.fail(serverSDK().scope, sdk().directory, sessionID)
          },
          uncertain(sessionID: string) {
            sessionSelectionHandoff.uncertain(serverSDK().scope, sdk().directory, sessionID)
          },
        },
        promote(dir: string, session: string) {
          const next = clone(store.temporary ? persistedScope() : remembered(snapshot()))
          if (!next) return

          if (dir === sdk().directory) {
            setSaved("session", session, next)
            setStore("draft", undefined)
            return
          }

          handoff.set(handoffKey(serverSDK().scope, dir, session), next)
          setStore("draft", undefined)
        },
        restore(msg: SelectionReadback, opts?: { force?: boolean }) {
          restoreSessionModel(msg, opts)
        },
      },
    }
    return result
  },
})
