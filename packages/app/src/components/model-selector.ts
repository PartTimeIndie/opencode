import type { ModelChain } from "@/context/model-chain"
import { createMemo, type JSX } from "solid-js"

export function modelSelectorChains(chains: ModelChain[]) {
  // The manager's persisted order is authoritative, including Planning Chain.
  return chains
}

export function createModelSelectorSearch(placeholder: () => string, action: () => JSX.Element) {
  // List also reads search props from keyboard handlers, which have no Solid
  // owner. Materialize action JSX in this owned memo instead of on those reads.
  return createMemo(() => ({ placeholder: placeholder(), autofocus: true, action: action() }))
}

// No initial active item: otherwise List's keyboard-follow effect can override
// the top-of-list position and hide the chains before the user navigates.
export const modelSelectorListOptions = {
  initialScroll: "top" as const,
  noInitialSelection: true,
}
