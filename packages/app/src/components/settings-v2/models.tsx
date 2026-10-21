import { useFilteredList } from "@opencode-ai/ui/hooks"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { For, Show, createSignal, type Component } from "solid-js"
import { useLanguage } from "@/context/language"
import { modelPickerRecentLimitMax, useSettings } from "@/context/settings"
import { useModels } from "@/context/models"
import { popularProviders } from "@/hooks/use-providers"
import { SettingsServerPicker } from "../settings-server-picker"
import { SettingsListV2 } from "./parts/list"
import { SettingsModelChainsV2 } from "./model-chains"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

type ModelItem = ReturnType<ReturnType<typeof useModels>["list"]>[number]

const PROVIDER_ICON_SIZE = 16

export const SettingsModelsV2: Component<{ appModels: ReturnType<typeof useModels> }> = (props) => {
  const language = useLanguage()
  const settings = useSettings()
  const models = useModels()
  const [expanded, setExpanded] = createSignal<Record<string, boolean>>({})

  const list = useFilteredList<ModelItem>({
    items: (_filter) => models.list(),
    key: (x) => `${x.provider.id}:${x.id}`,
    filterKeys: ["provider.name", "name", "id"],
    sortBy: (a, b) => a.name.localeCompare(b.name),
    groupBy: (x) => x.provider.id,
    sortGroupsBy: (a, b) => {
      const aIndex = popularProviders.indexOf(a.category)
      const bIndex = popularProviders.indexOf(b.category)
      const aPopular = aIndex >= 0
      const bPopular = bIndex >= 0

      if (aPopular && !bPopular) return -1
      if (!aPopular && bPopular) return 1
      if (aPopular && bPopular) return aIndex - bIndex

      const aName = a.items[0].provider.name
      const bName = b.items[0].provider.name
      return aName.localeCompare(bName)
    },
  })

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-tab-header--stacked">
        <div class="settings-v2-tab-header-row">
          <h2 class="settings-v2-tab-title">{language.t("settings.models.title")}</h2>
          <SettingsServerPicker />
        </div>
        <div class="settings-v2-tab-search">
          <TextInputV2
            type="search"
            appearance="base"
            value={list.filter()}
            onInput={(event) => list.onInput(event.currentTarget.value)}
            placeholder={language.t("dialog.model.search.placeholder")}
            spellcheck={false}
            autocorrect="off"
            autocomplete="off"
            autocapitalize="off"
            aria-label={language.t("dialog.model.search.placeholder")}
          />
          <Show when={list.filter()}>
            <IconButtonV2
              type="button"
              variant="ghost-muted"
              size="small"
              class="settings-v2-tab-search-clear"
              icon={<IconV2 name="close" size="large" class="text-v2-icon-icon-muted" />}
              onClick={() => list.clear()}
            />
          </Show>
        </div>
      </div>

      <div class="settings-v2-tab-body settings-v2-models">
        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.models.section.picker")}</h3>
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("settings.models.row.recentLimit.title")}
              description={language.t("settings.models.row.recentLimit.description")}
            >
              <div class="w-20" data-action="settings-model-picker-recent-limit">
                <TextInputV2
                  type="number"
                  appearance="base"
                  value={String(settings.models.recentLimit())}
                  onInput={(event) => settings.models.setRecentLimit(Number(event.currentTarget.value))}
                  min={0}
                  max={modelPickerRecentLimitMax}
                  aria-label={language.t("settings.models.row.recentLimit.title")}
                />
              </div>
            </SettingsRowV2>
          </SettingsListV2>
        </div>

        <SettingsModelChainsV2 models={props.appModels} />

        <Show
          when={!list.grouped.loading}
          fallback={
            <div class="settings-v2-models-status">
              {language.t("common.loading")}
              {language.t("common.loading.ellipsis")}
            </div>
          }
        >
          <Show
            when={list.flat().length > 0}
            fallback={
              <div class="settings-v2-models-status">
                <span>{language.t("dialog.model.empty")}</span>
                <Show when={list.filter()}>
                  <span class="settings-v2-models-status-filter">&quot;{list.filter()}&quot;</span>
                </Show>
              </div>
            }
          >
            <For each={list.grouped.latest}>
              {(group) => {
                const open = () => !!list.filter() || expanded()[group.category] === true
                return (
                <div class="settings-v2-section" data-component="settings-models-provider" data-expanded={open() ? "" : undefined}>
                  <button
                    type="button"
                    class="settings-v2-models-group-header"
                    aria-expanded={open()}
                    onClick={() =>
                      setExpanded((current) => ({ ...current, [group.category]: !open() }))
                    }
                  >
                    <ProviderIcon
                      id={group.category}
                      width={PROVIDER_ICON_SIZE}
                      height={PROVIDER_ICON_SIZE}
                      class="settings-v2-models-provider-icon shrink-0"
                    />
                    <h3 class="settings-v2-section-title">{group.items[0].provider.name}</h3>
                    <span class="settings-v2-models-group-count">{group.items.length}</span>
                    <IconV2 name={open() ? "chevron-down" : "chevron-right"} class="settings-v2-models-group-chevron" />
                  </button>
                  <Show when={open()}>
                  <SettingsListV2>
                    <For each={group.items}>
                      {(item) => {
                        const key = { providerID: item.provider.id, modelID: item.id }
                        return (
                          <SettingsRowV2 title={item.name} description="">
                            <div>
                              <Switch
                                checked={models.visible(key)}
                                onChange={(checked) => {
                                  models.setVisibility(key, checked)
                                }}
                                hideLabel
                              >
                                {item.name}
                              </Switch>
                            </div>
                          </SettingsRowV2>
                        )
                      }}
                    </For>
                  </SettingsListV2>
                  </Show>
                </div>
                )
              }}
            </For>
          </Show>
        </Show>
      </div>
    </>
  )
}
