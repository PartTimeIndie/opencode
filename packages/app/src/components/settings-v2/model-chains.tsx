import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { For, Show, createMemo, type Component } from "solid-js"
import type { useModels } from "@/context/models"
import { ModelChainPath } from "../model-chain-path"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

// The models tab renders inside a server-scoped ModelsProvider, but chains and
// the default chain are global user state shared with the composer and the
// safety bridge. The app-level models instance is injected so setting the
// default here updates the running app, not just the persisted copy.
export const SettingsModelChainsV2: Component<{ models: ReturnType<typeof useModels> }> = (props) => {
  const models = props.models
  const chains = createMemo(() => models.chain.list())
  const defaultID = createMemo(() => models.chain.default())
  const defaultName = () => chains().find((chain) => chain.id === defaultID())?.name

  return (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">Model chains</h3>
      <Show
        when={chains().length > 0}
        fallback={
          <div class="settings-v2-models-status">
            No model chains yet. Create one from the model picker in the composer (Chains), then set it as the default here.
          </div>
        }
      >
        <SettingsListV2>
          <SettingsRowV2
            action="settings-model-default-chain"
            title="Default model chain"
            description="Used for new sessions, host features, and the Approve-for-me safety review when the composer has no chain selected."
          >
            <div class="text-13-regular text-text-weak" data-slot="settings-model-default-chain-value">
              {defaultName() ?? "No default chain"}
            </div>
          </SettingsRowV2>

          <For each={chains()}>
            {(chain) => (
              <SettingsRowV2
                action={`settings-model-chain-${chain.id}`}
                title={chain.name}
                description={<ModelChainPath steps={chain.steps} class="settings-v2-chain-path" />}
              >
                <Show
                  when={defaultID() === chain.id}
                  fallback={
                    <ButtonV2
                      size="normal"
                      variant="neutral"
                      data-action="settings-model-chain-make-default"
                      data-chain-id={chain.id}
                      onClick={() => models.chain.setDefault(chain.id)}
                    >
                      Make default
                    </ButtonV2>
                  }
                >
                  <ButtonV2
                    size="normal"
                    variant="neutral"
                    data-action="settings-model-chain-clear-default"
                    data-chain-id={chain.id}
                    onClick={() => models.chain.setDefault(undefined)}
                  >
                    Clear default
                  </ButtonV2>
                </Show>
              </SettingsRowV2>
            )}
          </For>
        </SettingsListV2>
      </Show>
    </div>
  )
}
