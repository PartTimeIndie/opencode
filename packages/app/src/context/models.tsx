import { createEffect, createMemo, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { DateTime } from "luxon"
import { filter, firstBy, flat, groupBy, mapValues, pipe, uniqueBy, values } from "remeda"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useProviders } from "@/hooks/use-providers"
import { Persist, persisted } from "@/utils/persist"
import { modelPickerRecentLimitMax } from "@/context/settings"
import {
  createModelChainHydrationRunner,
  createModelChainSync,
  hydrateModelChainSettings,
  modelChainConfig,
  modelChainReadiness,
  moveModelChain,
  normalizeModelChains,
  type ModelChain,
  validatedModelChain,
} from "./model-chain"
import { useServerSync } from "./server-sync"

export type ModelKey = { providerID: string; modelID: string }

type Visibility = "show" | "hide"
type User = ModelKey & { visibility: Visibility; favorite?: boolean }
type Store = {
  user: User[]
  recent: ModelKey[]
  variant?: Record<string, string | undefined>
  selection?: {
    model?: ModelKey
    variant?: string | null
    chainID?: string
  }
  chains?: ModelChain[]
  defaultChainID?: string
}

function modelKey(model: ModelKey) {
  return `${model.providerID}:${model.modelID}`
}

export const { use: useModels, provider: ModelsProvider } = createSimpleContext({
  name: "Models",
  gate: false,
  init: () => {
    const providers = useProviders()
    const serverSync = useServerSync()

    const [store, setStore, _, ready] = persisted(
      Persist.global("model", ["model.v1"]),
      createStore<Store>({
        user: [],
        recent: [],
        variant: {},
        selection: {},
        chains: [],
      }),
    )

    const available = createMemo(() =>
      providers.connected().flatMap((p) =>
        Object.values(p.models).map((m) => ({
          ...m,
          provider: p,
        })),
      ),
    )

    const release = createMemo(
      () =>
        new Map(
          available().map((model) => {
            const parsed = DateTime.fromISO(model.release_date)
            return [modelKey({ providerID: model.provider.id, modelID: model.id }), parsed] as const
          }),
        ),
    )

    const latest = createMemo(() =>
      pipe(
        available(),
        filter(
          (x) =>
            Math.abs(
              (release().get(modelKey({ providerID: x.provider.id, modelID: x.id })) ?? DateTime.invalid("invalid"))
                .diffNow()
                .as("months"),
            ) < 6,
        ),
        groupBy((x) => x.provider.id),
        mapValues((models) =>
          pipe(
            models,
            groupBy((x) => x.family),
            values(),
            (groups) =>
              groups.flatMap((g) => {
                const first = firstBy(g, [(x) => x.release_date, "desc"])
                if (!first) return []
                if (!first.release_date) return [{ modelID: first.id, providerID: first.provider.id }]
                return g
                  .filter((model) => model.release_date === first.release_date)
                  .map((model) => ({ modelID: model.id, providerID: model.provider.id }))
              }),
          ),
        ),
        values(),
        flat(),
      ),
    )

    const latestSet = createMemo(() => new Set(latest().map((x) => modelKey(x))))

    const visibility = createMemo(() => {
      const map = new Map<string, Visibility>()
      for (const item of store.user) map.set(`${item.providerID}:${item.modelID}`, item.visibility)
      return map
    })

    const list = createMemo(() =>
      available().map((m) => ({
        ...m,
        name: m.name.replace("(latest)", "").trim(),
        latest: m.name.includes("(latest)"),
      })),
    )

    const find = (key: ModelKey) => list().find((m) => m.id === key.modelID && m.provider.id === key.providerID)

    function update(model: ModelKey, state: Visibility) {
      const index = store.user.findIndex((x) => x.modelID === model.modelID && x.providerID === model.providerID)
      if (index >= 0) {
        setStore("user", index, (current) => ({ ...current, visibility: state }))
        return
      }
      setStore("user", store.user.length, { ...model, visibility: state })
    }

    const visible = (model: ModelKey) => {
      const key = modelKey(model)
      const state = visibility().get(key)
      if (state === "hide") return false
      if (state === "show") return true
      if (latestSet().has(key)) return true
      const date = release().get(key)
      if (!date?.isValid) return true
      return false
    }

    const setVisibility = (model: ModelKey, state: boolean) => {
      update(model, state ? "show" : "hide")
    }

    const push = (model: ModelKey) => {
      const uniq = uniqueBy([model, ...store.recent], (x) => `${x.providerID}:${x.modelID}`)
      setStore("recent", uniq.slice(0, modelPickerRecentLimitMax))
    }

    const variantKey = (model: ModelKey) => `${model.providerID}/${model.modelID}`
    const getVariant = (model: ModelKey) => store.variant?.[variantKey(model)]

    const setVariant = (model: ModelKey, value: string | undefined) => {
      const key = variantKey(model)
      if (!store.variant) {
        setStore("variant", { [key]: value })
        return
      }
      setStore("variant", key, value)
    }

    const setSelectedModel = (model: ModelKey | undefined) => {
      if (!store.selection) {
        setStore("selection", { model })
        return
      }
      setStore("selection", "model", model)
      setStore("selection", "chainID", undefined)
    }

    const setSelection = (model: ModelKey | undefined, variant: string | null | undefined) => {
      setStore("selection", { model, variant, chainID: undefined })
    }

    const chains = createMemo(() => normalizeModelChains(store.chains))
    const [chainsReady, setChainsReady] = createSignal(false)
    const chainReadiness = () => modelChainReadiness({
      hydrated: chainsReady(),
      configFailed: serverSync().configFailed,
    })

    const chainSync = createModelChainSync({
      get: () => ({ chains: chains(), defaultChainID: store.defaultChainID }),
      set: (value) => {
        setStore("chains", value.chains)
        setStore("defaultChainID", value.defaultChainID)
      },
      write: (value) => serverSync().updateConfig(modelChainConfig(value.chains, value.defaultChainID, value.clearDefault)),
      report: (error) => console.error("model chain update failed", error),
      canCommit: () => chainReadiness().canWrite,
    })

    const persistChains = (next: ModelChain[], defaultChainID: string | undefined, clearDefault = false) => {
      void chainSync.commit({ chains: next, defaultChainID, clearDefault })
    }

    // One-shot hydration: the runner consumes its attempt only once the global
    // config actually loaded, so a pending or failed startup fetch keeps the
    // effect retrying instead of permanently skipping hydration. Hydration
    // shares the write lane with user writes and rolls back to the explicit
    // server-confirmed base on failure.
    const runModelChainHydration = createModelChainHydrationRunner({
      hydrate: () =>
        chainSync
          .initialHydrate(() =>
            hydrateModelChainSettings({
              persisted: { chains: store.chains, defaultChainID: store.defaultChainID },
              configured: {
                chains: serverSync().data.config.model_chains,
                defaultChainID: serverSync().data.config.default_model_chain,
              },
              configuredLoaded: true,
              set: (settings) => {
                setStore("chains", settings.chains)
                setStore("defaultChainID", settings.defaultChainID)
              },
              write: (next, confirmedBase) => chainSync.hydrate(next, confirmedBase),
            }),
          )
          .catch((error) => console.error("model chain hydration failed", error)),
      onHydrated: () => setChainsReady(true),
    })

    createEffect(() => {
      if (!ready()) return
      runModelChainHydration(serverSync().configLoaded)
    })

    const saveChain = (chain: ModelChain) => {
      const normalized = validatedModelChain(chain, find)
      if (!normalized) return false
      const index = chains().findIndex((item) => item.id === normalized.id)
      if (index === -1) persistChains([...chains(), normalized], store.defaultChainID)
      else persistChains(chains().map((item) => item.id === normalized.id ? normalized : item), store.defaultChainID)
      return true
    }

    const removeChain = (id: string) => {
      // Removing the default chain is an explicit user clear: only this path
      // may send the wire's explicit-null signal for the stored default.
      const wasDefault = store.defaultChainID === id
      persistChains(
        chains().filter((chain) => chain.id !== id),
        wasDefault ? undefined : store.defaultChainID,
        wasDefault,
      )
      if (store.selection?.chainID === id) setStore("selection", "chainID", undefined)
    }

    return {
      ready,
      list,
      find,
      visible,
      setVisibility,
      recent: {
        list: createMemo(() => store.recent),
        push,
      },
      variant: {
        get: getVariant,
        set: setVariant,
      },
      selection: {
        model: () => store.selection?.model,
        variant: () => store.selection?.variant,
        setModel: setSelectedModel,
        setVariant: setSelection,
      },
      chain: {
        ready: () => chainReadiness().canWrite,
        managementReady: () => chainReadiness().canManage,
        list: chains,
        find: (id: string | undefined) => chains().find((chain) => chain.id === id),
        save: saveChain,
        remove: removeChain,
        move: (id: string, targetID: string) => {
          const current = chains()
          const next = moveModelChain(current, id, targetID)
          if (next === current) return
          persistChains(next, store.defaultChainID)
        },
        selected: () => store.selection?.chainID,
        select: (id: string | undefined) => setStore("selection", {
          model: undefined,
          variant: null,
          chainID: id,
        }),
        // A stored default pointing at a removed chain must read as unset so
        // no consumer resolves a retired chain.
        default: () => (chains().some((chain) => chain.id === store.defaultChainID) ? store.defaultChainID : undefined),
        setDefault: (id: string | undefined) => {
          const next = chains().some((chain) => chain.id === id) ? id : undefined
          // Clearing the default from the UI is an explicit user clear; only
          // that intent may send the wire's explicit-null signal.
          persistChains(chains(), next, next === undefined)
        },
      },
    }
  },
})
