import { ScopedKey } from "@/utils/server-scope"
import type { ModelChain } from "@/context/model-chain"

export type StoredImplementationModel = { ref: string; variant?: string }

const storageKey = "agent-handoff.implementation-model.v1"

export function implementationModelPreferenceKey(scope: string, directory: string, agent: string) {
  return ScopedKey.from(scope as never, directory, agent)
}

export function readImplementationModelPreference(storage: Pick<Storage, "getItem">, key: string) {
  try {
    const data = JSON.parse(storage.getItem(storageKey) ?? "{}") as Record<string, unknown>
    const item = data[key]
    if (!item || typeof item !== "object") return
    const value = item as Record<string, unknown>
    if (typeof value.ref !== "string") return
    return { ref: value.ref, variant: typeof value.variant === "string" ? value.variant : undefined } satisfies StoredImplementationModel
  } catch {
    return
  }
}

export function writeImplementationModelPreference(
  storage: Pick<Storage, "getItem" | "setItem">,
  key: string,
  value: StoredImplementationModel,
) {
  let data: Record<string, unknown> = {}
  try {
    data = JSON.parse(storage.getItem(storageKey) ?? "{}") as Record<string, unknown>
  } catch {}
  storage.setItem(storageKey, JSON.stringify({ ...data, [key]: value }))
}

export function parseModelRef(ref: string | undefined) {
  if (!ref) return
  const separator = ref.indexOf("/")
  if (separator <= 0 || separator === ref.length - 1) return
  return { providerID: ref.slice(0, separator), id: ref.slice(separator + 1) }
}

export function initialHandoffModelMode(
  requested: "planning-model" | "implementation-model" | undefined,
  implementation: StoredImplementationModel | undefined,
) {
  if (requested === "implementation-model") return "implementation-model"
  return implementation ? "implementation-model" : "planning-model"
}

export function initialImplementationModel(
  supplied: StoredImplementationModel | undefined,
  remembered: StoredImplementationModel | undefined,
  defaultChainID?: string,
  agentDefault?: StoredImplementationModel,
) {
  return supplied ?? agentDefault ?? (defaultChainID ? { ref: `chain:${defaultChainID}` } : undefined) ?? remembered
}

export function resolveHandoffModelTarget(ref: string, variant: string | undefined, chains: ModelChain[]) {
  if (ref.startsWith("chain:")) {
    const chain = chains.find((item) => item.id === ref.slice("chain:".length))
    const first = chain?.steps[0]
    if (!chain || !first) return
    return {
      providerID: first.providerID,
      id: first.modelID,
      ...(first.variant ? { variant: first.variant } : {}),
      chain: {
        id: chain.id,
        name: chain.name,
        active: 0,
        steps: chain.steps.map((step) => ({
          providerID: step.providerID,
          id: step.modelID,
          ...(step.variant ? { variant: step.variant } : {}),
        })),
      },
    }
  }

  const parsed = parseModelRef(ref.startsWith("model:") ? ref.slice("model:".length) : ref)
  if (!parsed) return
  return { ...parsed, ...(variant ? { variant } : {}) }
}
