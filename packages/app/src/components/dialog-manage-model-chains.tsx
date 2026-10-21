import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { createMemo, For, Show, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { unavailableModelChainStep, type ModelChain } from "@/context/model-chain"
import type { ModelChainManagerState } from "./dialog-select-model"
import "./dialog-manage-model-chains.css"

const createChain = (): ModelChain => ({
  id: crypto.randomUUID(),
  name: "New model chain",
  steps: [],
})

export const DialogManageModelChains: Component<{ model: ModelChainManagerState }> = (props) => {
  const dialog = useDialog()
  const [draft, setDraft] = createStore<ModelChain>(
    structuredClone(props.model.chain.current() ?? props.model.chain.list()[0] ?? createChain()),
  )
  const models = createMemo(() => props.model.list().toSorted((a, b) => a.name.localeCompare(b.name)))
  const replace = (chain: ModelChain) => setDraft(structuredClone(chain))
  const selectedModel = (index: number) =>
    models().find(
      (model) => model.provider.id === draft.steps[index]?.providerID && model.id === draft.steps[index]?.modelID,
    )
  const unavailable = createMemo(() =>
    unavailableModelChainStep(draft, (step) =>
      models().find((model) => model.provider.id === step.providerID && model.id === step.modelID),
    ),
  )
  const writable = () => props.model.chain.ready?.() === true
  const save = () => {
    if (!writable()) return
    if (!draft.name.trim() || draft.steps.length === 0) return
    if (
      !props.model.chain.save({
        id: draft.id,
        name: draft.name.trim(),
        steps: draft.steps.map((step) => ({ ...step })),
      })
    )
      return
    props.model.chain.set(draft.id)
    dialog.close()
  }
  const move = (id: string, direction: "up" | "down", button: HTMLButtonElement) => {
    if (!writable()) return
    const chains = props.model.chain.list()
    const target = chains[chains.findIndex((chain) => chain.id === id) + (direction === "up" ? -1 : 1)]
    if (!target) return
    const list = button.closest('[data-slot="model-chain-list"]')
    props.model.chain.move(id, target.id)
    // Normalization recreates row objects; restore focus after Solid replaces the
    // buttons so repeated keyboard activation keeps moving this same chain.
    queueMicrotask(() => {
      const row = Array.from(list?.querySelectorAll('[data-slot="model-chain-row"]') ?? [])
        .find((element) => element.getAttribute("data-chain-id") === id)
      const next = row?.querySelector<HTMLButtonElement>(`[data-chain-move="${direction}"]:not(:disabled)`) ??
        row?.querySelector<HTMLButtonElement>('[data-slot="model-chain-select"]')
      next?.focus()
    })
  }

  return (
    <Dialog title="Model chains" description="Define an ordered fallback path and reasoning effort for every model.">
      <ScrollView class="model-chain-editor min-h-0 flex-1">
        <div class="flex flex-col gap-4 px-3 pb-6 sm:flex-row sm:items-start">
          <div data-slot="model-chain-list" class="flex w-full shrink-0 flex-col gap-1 sm:w-56">
            <Show when={writable()}>
              <p class="px-2 pb-1 text-12-regular text-text-weak">Arrows set the dropdown order. Changes save immediately.</p>
            </Show>
            <For each={props.model.chain.list()}>
              {(chain, index) => (
                <div
                  data-slot="model-chain-row"
                  data-chain-id={chain.id}
                  class="flex items-center gap-1 rounded-md"
                  classList={{ "bg-surface-raised-base": chain.id === draft.id }}
                >
                  <button
                    type="button"
                    data-slot="model-chain-select"
                    aria-label={chain.name}
                    aria-description={props.model.chain.default() === chain.id ? "Default chain" : undefined}
                    aria-pressed={chain.id === draft.id}
                    class="min-w-0 flex-1 break-words rounded-md px-2 py-2 text-left text-13-regular hover:bg-surface-raised-base"
                    onClick={() => replace(chain)}
                  >
                    {chain.name}
                    <Show when={props.model.chain.default() === chain.id}>
                      <span class="ml-1 text-text-weak">Default</span>
                    </Show>
                  </button>
                  <div class="flex shrink-0 gap-1 pr-1">
                    <IconButton
                      icon="arrow-up"
                      data-chain-move="up"
                      data-mobile-touch-target
                      size="small"
                      variant="ghost"
                      aria-label={`Move ${chain.name} up`}
                      title="Move chain up"
                      disabled={!writable() || index() === 0}
                      onClick={(event) => move(chain.id, "up", event.currentTarget)}
                    />
                    <IconButton
                      icon="arrow-up"
                      data-chain-move="down"
                      data-mobile-touch-target
                      size="small"
                      variant="ghost"
                      class="rotate-180"
                      aria-label={`Move ${chain.name} down`}
                      title="Move chain down"
                      disabled={!writable() || index() === props.model.chain.list().length - 1}
                      onClick={(event) => move(chain.id, "down", event.currentTarget)}
                    />
                  </div>
                </div>
              )}
            </For>
            <Button size="small" variant="ghost" disabled={!writable()} onClick={() => replace(createChain())}>
              New chain
            </Button>
          </div>

          <div class="flex min-w-0 flex-1 flex-col gap-3">
            <Show when={!writable()}>
              <p role="status" class="text-12-regular text-text-weak">
                Global configuration is unavailable. Model chains are read-only until it recovers.
              </p>
            </Show>
            <label class="flex flex-col gap-1 text-12-regular text-text-weak">
              Name
              <input
                class="rounded-md border border-border-weak-base bg-surface-base px-2 py-1.5 text-13-regular text-text-base"
                value={draft.name}
                disabled={!writable()}
                onInput={(event) => setDraft("name", event.currentTarget.value)}
              />
            </label>

            <div class="flex flex-col gap-2">
              <For each={draft.steps}>
                {(step, index) => (
                  <div class="rounded-md border border-border-weak-base p-2">
                    <div class="flex flex-col gap-2 sm:flex-row">
                      <select
                        aria-label={`Fallback step ${index() + 1} model`}
                        class="min-w-0 flex-1 rounded-md border border-border-weak-base bg-surface-base px-2 py-1.5 text-13-regular"
                        value={`${step.providerID}/${step.modelID}`}
                        disabled={!writable()}
                        onChange={(event) => {
                          const model = models().find(
                            (item) => `${item.provider.id}/${item.id}` === event.currentTarget.value,
                          )
                          if (!model) return
                          setDraft("steps", index(), { providerID: model.provider.id, modelID: model.id })
                        }}
                      >
                        <Show when={!selectedModel(index())}>
                          <option value={`${step.providerID}/${step.modelID}`}>
                            {step.providerID}/{step.modelID} — unavailable
                          </option>
                        </Show>
                        <For each={models()}>
                          {(model) => (
                            <option value={`${model.provider.id}/${model.id}`}>
                              {model.provider.name} · {model.name}
                            </option>
                          )}
                        </For>
                      </select>
                      <select
                        aria-label={`Fallback step ${index() + 1} reasoning effort`}
                        class="rounded-md border border-border-weak-base bg-surface-base px-2 py-1.5 text-13-regular"
                        value={step.variant ?? ""}
                        disabled={!writable()}
                        onChange={(event) =>
                          setDraft("steps", index(), "variant", event.currentTarget.value || undefined)
                        }
                      >
                        <option value="">Default reasoning</option>
                        <For each={Object.keys(selectedModel(index())?.variants ?? {})}>
                          {(variant) => <option value={variant}>{variant}</option>}
                        </For>
                        <Show
                          when={step.variant && !Object.hasOwn(selectedModel(index())?.variants ?? {}, step.variant)}
                        >
                          <option value={step.variant}>{step.variant} — unavailable</option>
                        </Show>
                      </select>
                    </div>
                    <div class="mt-2 flex gap-1">
                      <Button
                        size="small"
                        variant="ghost"
                        disabled={!writable() || index() === 0}
                        onClick={() => {
                          const steps = draft.steps.map((item) => ({ ...item }))
                          ;[steps[index() - 1], steps[index()]] = [steps[index()]!, steps[index() - 1]!]
                          setDraft("steps", steps)
                        }}
                      >
                        Up
                      </Button>
                      <Button
                        size="small"
                        variant="ghost"
                        disabled={!writable() || index() === draft.steps.length - 1}
                        onClick={() => {
                          const steps = draft.steps.map((item) => ({ ...item }))
                          ;[steps[index()], steps[index() + 1]] = [steps[index() + 1]!, steps[index()]!]
                          setDraft("steps", steps)
                        }}
                      >
                        Down
                      </Button>
                      <Button
                        size="small"
                        variant="ghost"
                        disabled={!writable()}
                        onClick={() =>
                          setDraft(
                            "steps",
                            draft.steps.filter((_, item) => item !== index()),
                          )
                        }
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                )}
              </For>
            </div>

            <Button
              size="small"
              variant="ghost"
              disabled={!writable() || models().length === 0}
              onClick={() => {
                const model = models()[0]
                if (!model) return
                setDraft("steps", draft.steps.length, { providerID: model.provider.id, modelID: model.id })
              }}
            >
              Add fallback step
            </Button>

            <div class="flex flex-wrap justify-end gap-2">
              <Show when={unavailable()}>
                {(step) => (
                  <span class="mr-auto self-center text-12-regular text-danger">
                    Select an available model and exact variant for {step().providerID}/{step().modelID}.
                  </span>
                )}
              </Show>
              <Show when={props.model.chain.list().some((chain) => chain.id === draft.id)}>
                <Button
                  size="small"
                  variant="ghost"
                  disabled={!writable()}
                  onClick={() => {
                    props.model.chain.remove(draft.id)
                    props.model.chain.set(undefined)
                    replace(props.model.chain.list()[0] ?? createChain())
                  }}
                >
                  Delete
                </Button>
                <Button
                  size="small"
                  variant="ghost"
                  disabled={!writable()}
                  onClick={() =>
                    props.model.chain.setDefault(props.model.chain.default() === draft.id ? undefined : draft.id)
                  }
                >
                  {props.model.chain.default() === draft.id ? "Clear default" : "Make default"}
                </Button>
              </Show>
              <Button size="small" variant="ghost" onClick={() => dialog.close()}>
                Cancel
              </Button>
              <Button
                size="small"
                variant="primary"
                disabled={!writable() || !draft.name.trim() || draft.steps.length === 0 || !!unavailable()}
                onClick={save}
              >
                Save and select
              </Button>
            </div>
          </div>
        </div>
      </ScrollView>
    </Dialog>
  )
}
