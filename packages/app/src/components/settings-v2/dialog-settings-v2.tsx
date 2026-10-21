import { type Component, type ParentProps, Show, createMemo, ErrorBoundary } from "solid-js"
import { createStore } from "solid-js/store"
import { Dialog } from "@opencode-ai/ui/v2/dialog-v2"
import { TabsV2 } from "@opencode-ai/ui/v2/tabs-v2"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { useModels } from "@/context/models"
import { usePlatform } from "@/context/platform"
import { SettingsGeneralV2 } from "./general"
import { SettingsKeybinds } from "../settings-keybinds"
import { SettingsProvidersV2 } from "./providers"
import { SettingsModelsV2 } from "./models"
import { SettingsVisionV2 } from "./vision"
import { SettingsAgentsV2 } from "./agents"
import "./settings-v2.css"
import { SettingsServersV2 } from "./servers"
import { SettingsSkillsPluginsV2 } from "./plugins"
import { SettingsMcpV2 } from "./mcp"
import { SettingsLoggingV2 } from "./logging"
import { SettingsOptimizationsV2 } from "./optimizations"
import { SettingsStorageV2 } from "./storage"
import { SettingsSearchBox, SettingsSearchResults } from "./search"
import { canonicalSettingsTab, SETTINGS_ANCHOR_EVENT, type SettingsTabId } from "./search-index"
import { SettingsServerScope } from "../settings-server-picker"

export const DialogSettings: Component<{
  initialTab?: SettingsTabId
  initialAgent?: string
  createAgent?: boolean
  initialDirectory?: string
  onAgentSelect?: (agent: string) => void
}> = (props) => {
  const language = useLanguage()
  const platform = usePlatform()
  const appModels = useModels()

  const [state, setState] = createStore({
    tab: canonicalSettingsTab(props.initialTab),
    query: "",
  })

  const searching = createMemo(() => state.query.trim().length > 0)
  const pickResult = (tab: SettingsTabId, anchor?: string) => {
    setState({ query: "", tab: canonicalSettingsTab(tab) })
    if (!anchor) return
    setTimeout(() => {
      const element = Array.from(document.querySelectorAll<HTMLElement>("[data-action]"))
        .find((element) => element.dataset.action === anchor)
      element?.scrollIntoView({ block: "center", behavior: "smooth" })
      // Overlay rows listen for their anchor to reveal fields hidden behind an open button.
      if (element) window.dispatchEvent(new CustomEvent(SETTINGS_ANCHOR_EVENT, { detail: anchor }))
    }, 80)
  }

  return (
    <Dialog size="x-large" variant="settings" class="settings-v2-dialog">
      <TabsV2
        orientation="vertical"
        variant="settings"
        value={state.tab}
        onChange={(value) => {
          setState({ tab: canonicalSettingsTab(value as SettingsTabId), query: "" })
        }}
        class="settings-v2"
        data-searching={searching() ? "" : undefined}
      >
        <TabsV2.List>
          <div class="flex flex-col justify-between h-full w-full">
            <div class="flex flex-col gap-3 w-full">
              <div class="settings-v2-nav-search-wrap">
                <SettingsSearchBox query={state.query} onInput={(value) => setState("query", value)} />
              </div>

              <div class="flex flex-col gap-3">
                <div class="flex flex-col gap-1.5">
                  <TabsV2.SectionTitle>{language.t("settings.section.desktop")}</TabsV2.SectionTitle>
                  <div class="flex flex-col gap-1.5 w-full">
                    <TabsV2.Trigger value="general">
                      <Icon name="settings-gear" />
                      {language.t("settings.tab.general")}
                    </TabsV2.Trigger>
                    <TabsV2.Trigger value="shortcuts">
                      <Icon name="keyboard" />
                      {language.t("settings.tab.shortcuts")}
                    </TabsV2.Trigger>
                    <TabsV2.Trigger value="plugins">
                      <Icon name="plug" />
                      Skills &amp; Plugins
                    </TabsV2.Trigger>
                  </div>
                </div>

                <div class="flex flex-col gap-1.5">
                  <TabsV2.SectionTitle>{language.t("settings.section.server")}</TabsV2.SectionTitle>
                  <div class="flex flex-col gap-1.5 w-full">
                    <TabsV2.Trigger value="servers">
                      <Icon name="server" />
                      {language.t("status.popover.tab.servers")}
                    </TabsV2.Trigger>
                    <TabsV2.Trigger value="providers">
                      <Icon name="providers" />
                      {language.t("settings.providers.title")}
                    </TabsV2.Trigger>
                    <TabsV2.Trigger value="models">
                      <Icon name="models" />
                      {language.t("settings.models.title")}
                    </TabsV2.Trigger>
                    <TabsV2.Trigger value="vision">
                      <Icon name="eye" />
                      {language.t("settings.vision.title")}
                    </TabsV2.Trigger>
                    <TabsV2.Trigger value="agents">
                      <Icon name="brain" />
                      {language.t("settings.agents.title")}
                    </TabsV2.Trigger>
                    <TabsV2.Trigger value="optimizations">
                      <Icon name="speedometer" />
                      {language.t("settings.optimizations.title")}
                    </TabsV2.Trigger>
                    <TabsV2.Trigger value="logging">
                      <Icon name="logging" />
                      {language.t("settings.logging.title")}
                    </TabsV2.Trigger>
                    <TabsV2.Trigger value="storage">
                      <Icon name="archive" />
                      {language.t("settings.storage.title")}
                    </TabsV2.Trigger>
                    <TabsV2.Trigger value="mcp">
                      <Icon name="mcp" />
                      MCP
                    </TabsV2.Trigger>
                  </div>
                </div>
              </div>
            </div>
            <div class="settings-v2-nav-footer">
              <span>{language.t("app.name.desktop")}</span>
              <span>v{platform.version}</span>
            </div>
          </div>
        </TabsV2.List>
        <Show
          when={searching()}
          fallback={
            <>
              <TabsV2.Content value="general" class="settings-v2-panel">
                <SettingsTabBoundary>
                  <SettingsGeneralV2 />
                </SettingsTabBoundary>
              </TabsV2.Content>
              <TabsV2.Content value="shortcuts" class="settings-v2-panel">
                <SettingsTabBoundary>
                  <SettingsKeybinds />
                </SettingsTabBoundary>
              </TabsV2.Content>
              <TabsV2.Content value="plugins" class="settings-v2-panel">
                <SettingsTabBoundary>
                  <SettingsSkillsPluginsV2 />
                </SettingsTabBoundary>
              </TabsV2.Content>
              <TabsV2.Content value="servers" class="settings-v2-panel">
                <SettingsTabBoundary>
                  <SettingsServersV2 />
                </SettingsTabBoundary>
              </TabsV2.Content>
              <TabsV2.Content value="providers" class="settings-v2-panel">
                <SettingsTabBoundary>
                  <SettingsServerTab>
                    <SettingsProvidersV2 />
                  </SettingsServerTab>
                </SettingsTabBoundary>
              </TabsV2.Content>
              <TabsV2.Content value="models" class="settings-v2-panel">
                <SettingsTabBoundary>
                  <SettingsServerTab>
                    <SettingsModelsV2 appModels={appModels} />
                  </SettingsServerTab>
                </SettingsTabBoundary>
              </TabsV2.Content>
              <TabsV2.Content value="vision" class="settings-v2-panel">
                <SettingsTabBoundary>
                  <SettingsServerTab>
                    <SettingsVisionV2 />
                  </SettingsServerTab>
                </SettingsTabBoundary>
              </TabsV2.Content>
              <TabsV2.Content value="agents" class="settings-v2-panel">
                <SettingsTabBoundary>
                  <SettingsServerTab>
                    <SettingsAgentsV2
                      initialAgent={props.initialAgent}
                      createAgent={props.createAgent}
                      directory={props.initialDirectory}
                      onAgentSelect={props.onAgentSelect}
                    />
                  </SettingsServerTab>
                </SettingsTabBoundary>
              </TabsV2.Content>
              <TabsV2.Content value="optimizations" class="settings-v2-panel">
                <SettingsTabBoundary>
                  <SettingsServerTab>
                    <SettingsOptimizationsV2 />
                  </SettingsServerTab>
                </SettingsTabBoundary>
              </TabsV2.Content>
              <TabsV2.Content value="logging" class="settings-v2-panel">
                <SettingsTabBoundary>
                  <SettingsServerTab>
                    <SettingsLoggingV2 />
                  </SettingsServerTab>
                </SettingsTabBoundary>
              </TabsV2.Content>
              <TabsV2.Content value="storage" class="settings-v2-panel">
                <SettingsTabBoundary>
                  <SettingsServerTab>
                    <SettingsStorageV2 />
                  </SettingsServerTab>
                </SettingsTabBoundary>
              </TabsV2.Content>
              <TabsV2.Content value="mcp" class="settings-v2-panel">
                <SettingsTabBoundary>
                  <SettingsServerTab>
                    <SettingsMcpV2 />
                  </SettingsServerTab>
                </SettingsTabBoundary>
              </TabsV2.Content>
            </>
          }
        >
          <div
            role="region"
            aria-label={language.t("settings.search.results")}
            class="settings-v2-panel min-w-0 flex-1"
          >
            <SettingsSearchResults query={state.query} onPick={pickResult} />
          </div>
        </Show>
      </TabsV2>
    </Dialog>
  )
}

const SettingsServerTab: Component<ParentProps> = (props) => <SettingsServerScope>{props.children}</SettingsServerScope>

function SettingsTabBoundary(props: ParentProps) {
  return (
    <ErrorBoundary
      fallback={(error, reset) => (
        <div class="settings-v2-state settings-v2-state--error" data-state="error">
          <span>{error instanceof Error ? error.message : String(error)}</span>
          <button type="button" class="settings-v2-tab-retry" onClick={reset}>
            Retry
          </button>
        </div>
      )}
    >
      {props.children}
    </ErrorBoundary>
  )
}
