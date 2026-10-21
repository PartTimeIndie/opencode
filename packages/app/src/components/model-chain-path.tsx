import { For, Show, splitProps, type Component, type ComponentProps } from "solid-js"

type ChainStep = { providerID: string; modelID: string; variant?: string }

// Every step renders as its own nowrap span so narrow layouts can only wrap
// between steps, never inside a provider/model token.
export const ModelChainPath: Component<ComponentProps<"span"> & { steps: readonly ChainStep[] | undefined; empty?: string }> = (props) => {
  const [local, rest] = splitProps(props, ["steps", "empty", "children"])
  return (
    <span data-component="model-chain-path" {...rest}>
      <Show when={(local.steps?.length ?? 0) > 0} fallback={local.empty ?? "No chain configured"}>
        <For each={local.steps}>
          {(step, index) => (
            <>
              <Show when={index() > 0}>
                <span data-slot="model-chain-path-sep" class="whitespace-nowrap">→</span>
              </Show>
              <span data-slot="model-chain-path-step" class="whitespace-nowrap">
                {step.providerID}/{step.modelID}{step.variant ? ` (${step.variant})` : ""}
              </span>
            </>
          )}
        </For>
      </Show>
    </span>
  )
}
