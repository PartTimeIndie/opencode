import { type Component, For, Show, createMemo, createSignal, onCleanup } from "solid-js"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useLanguage } from "@/context/language"
import { subscribeAppPluginSettingsChanges } from "@/plugin/app-plugin-settings-events"
import { useAppPluginRuntime } from "@/plugin/app-runtime"
import { pluginSettingsSearchEntries, searchSettings, type SettingsTabId } from "./search-index"
import "./settings-v2.css"

export const SettingsSearchBox: Component<{
  query: string
  onInput: (value: string) => void
}> = (props) => {
  const language = useLanguage()
  return (
    <div class="settings-v2-nav-search">
      <IconV2
        name="magnifying-glass"
        size="small"
        class="settings-v2-nav-search-icon"
        aria-hidden="true"
      />
      <TextInputV2
        type="search"
        appearance="base"
        value={props.query}
        onInput={(event) => props.onInput(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && props.query) {
            event.preventDefault()
            props.onInput("")
          }
        }}
        placeholder={language.t("settings.search.placeholder")}
        spellcheck={false}
        autocorrect="off"
        autocomplete="off"
        autocapitalize="off"
        aria-label={language.t("settings.search.placeholder")}
      />
      <Show when={props.query}>
        <IconButtonV2
          type="button"
          variant="ghost-muted"
          size="small"
          class="settings-v2-nav-search-clear"
          icon={<IconV2 name="close" size="large" class="text-v2-icon-icon-muted" />}
          onClick={() => props.onInput("")}
          aria-label={language.t("settings.search.clear")}
        />
      </Show>
    </div>
  )
}

export const SettingsSearchResults: Component<{
  query: string
  onPick: (tab: SettingsTabId, anchor?: string) => void
}> = (props) => {
  const language = useLanguage()
  const plugins = useAppPluginRuntime()
  const [revision, setRevision] = createSignal(0)
  const refresh = () => setRevision((value) => value + 1)
  onCleanup(subscribeAppPluginSettingsChanges(refresh))
  const entries = createMemo(() => {
    revision()
    return pluginSettingsSearchEntries(plugins.settingsItems(), plugins.toolbarItems())
  })
  const results = createMemo(() => searchSettings((key) => language.t(key as never), props.query, entries()))

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.search.results")}</h2>
      </div>

      <div class="settings-v2-tab-body">
        <Show
          when={results().length > 0}
          fallback={
            <div class="settings-v2-search-empty">
              <span>{language.t("settings.search.empty")}</span>
              <Show when={props.query.trim()}>
                <span class="settings-v2-search-empty-filter">&quot;{props.query.trim()}&quot;</span>
              </Show>
            </div>
          }
        >
          <div class="settings-v2-search-results">
            <For each={results()}>
              {(result) => (
                <button
                  type="button"
                  class="settings-v2-search-result"
                  onClick={() => props.onPick(result.tab, result.anchor)}
                >
                  <div class="settings-v2-search-result-copy">
                    <span class="settings-v2-search-result-title">{result.title}</span>
                    <Show when={result.description}>
                      <span class="settings-v2-search-result-description">{result.description}</span>
                    </Show>
                  </div>
                  <span class="settings-v2-search-result-meta">
                    <Show when={result.section}>
                      {(section) => <span class="settings-v2-search-result-section">{section()}</span>}
                    </Show>
                    <span class="settings-v2-search-result-tab">{result.tabLabel}</span>
                  </span>
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    </>
  )
}
