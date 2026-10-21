import type { Component } from "solid-js"
import type { Config } from "@opencode-ai/sdk/v2/client"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { type LoggingProfile, useSettings } from "@/context/settings"
import { useServerSync } from "@/context/server-sync"
import { recordPerfEvent } from "@/utils/perf-recorder"
import { SettingsServerPicker } from "../settings-server-picker"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import { serverLoggingConfig, type ServerLogging, type ServerLoggingFeatureKey } from "./logging-model"

const profileOptions: Array<{ value: LoggingProfile }> = [{ value: "off" }, { value: "safe" }, { value: "verbose" }]

const profileLabelKey = (profile: LoggingProfile) => {
  if (profile === "off") return "settings.logging.profile.off"
  if (profile === "verbose") return "settings.logging.profile.verbose"
  return "settings.logging.profile.safe"
}

export const SettingsLoggingV2: Component = () => {
  const language = useLanguage()
  const settings = useSettings()
  const server = useServer()
  const serverSync = useServerSync()
  const profile = () => profileOptions.find((option) => option.value === settings.logging.loggingProfile()) ?? profileOptions[2]!
  const profileEnabled = () => settings.logging.loggingProfile() !== "off"
  const effective = (enabled: boolean) => profileEnabled() && enabled
  const LoggingSwitch: Component<{ checked: () => boolean; onChange: (checked: boolean) => void }> = (props) => (
    <Switch checked={effective(props.checked())} disabled={!profileEnabled()} onChange={props.onChange} />
  )
  const featureConfig = (profile: LoggingProfile, overrides: Partial<Record<ServerLoggingFeatureKey, boolean>> = {}) => {
    const features: ServerLogging["features"] = {
      trace: settings.logging.trace(),
      performance: settings.logging.performance(),
      interrupts: settings.logging.interrupts(),
      optimization: settings.logging.optimization(),
      ui: settings.logging.ui(),
      ...overrides,
    }
    return serverLoggingConfig({ profile, features }).features
  }
  const syncLogging = (patch: { profile?: LoggingProfile; features?: Partial<Record<ServerLoggingFeatureKey, boolean>> }) => {
    const profile = patch.profile ?? settings.logging.loggingProfile()
    void serverSync()
      .updateConfig({ logging: { profile, features: featureConfig(profile, patch.features) } } as Config)
      .catch(() => undefined)
  }
  const setProfile = (value: LoggingProfile) => {
    const started = performance.now()
    settings.logging.setLoggingProfile(value)
    syncLogging({ profile: value })
    recordPerfEvent(server.current, {
      kind: "ui_control",
      control: "logging_profile",
      value,
      duration_ms: performance.now() - started,
    })
  }
  const setFeature = (key: ServerLoggingFeatureKey, value: boolean, apply: (value: boolean) => void) => {
    const started = performance.now()
    apply(value)
    syncLogging({ features: { [key]: value } })
    recordPerfEvent(server.current, {
      kind: "ui_control",
      control: `logging_${key}`,
      value,
      duration_ms: performance.now() - started,
    })
  }
  const featureDescription = (key: Parameters<typeof language.t>[0], enabled: boolean) => (
    <div class="settings-v2-optimization-detail">
      <span>{language.t(key)}</span>
      <span>{language.t(enabled ? "settings.logging.status.enabled" : "settings.logging.status.disabled")}</span>
    </div>
  )

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-tab-header--stacked">
        <div class="settings-v2-tab-header-row">
          <h2 class="settings-v2-tab-title">{language.t("settings.logging.title")}</h2>
          <SettingsServerPicker />
        </div>
        <p>{language.t("settings.logging.description")}</p>
      </div>

      <div class="settings-v2-tab-body">
        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.logging.section.profile")}</h3>
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("settings.logging.row.profile.title")}
              description={language.t("settings.logging.row.profile.description")}
            >
              <div data-action="settings-logging-profile">
                <SelectV2
                  appearance="inline"
                  options={profileOptions}
                  current={profile()}
                  value={(option) => option.value}
                  label={(option) => language.t(profileLabelKey(option.value))}
                  placement="bottom-end"
                  gutter={6}
                  onSelect={(option) => option && setProfile(option.value)}
                />
              </div>
            </SettingsRowV2>
          </SettingsListV2>
        </div>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.logging.section.features")}</h3>
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("settings.logging.row.trace.title")}
              description={featureDescription("settings.logging.row.trace.description", effective(settings.logging.trace()))}
            >
              <div data-action="settings-logging-trace">
                <LoggingSwitch checked={settings.logging.trace} onChange={(checked) => setFeature("trace", checked, settings.logging.setTrace)} />
              </div>
            </SettingsRowV2>
            <SettingsRowV2
              title={language.t("settings.logging.row.performance.title")}
              description={featureDescription(
                "settings.logging.row.performance.description",
                effective(settings.logging.performance()),
              )}
            >
              <div data-action="settings-logging-performance">
                <LoggingSwitch
                  checked={settings.logging.performance}
                  onChange={(checked) => setFeature("performance", checked, settings.logging.setPerformance)}
                />
              </div>
            </SettingsRowV2>
            <SettingsRowV2
              title={language.t("settings.logging.row.interrupts.title")}
              description={featureDescription(
                "settings.logging.row.interrupts.description",
                effective(settings.logging.interrupts()),
              )}
            >
              <div data-action="settings-logging-interrupts">
                <LoggingSwitch
                  checked={settings.logging.interrupts}
                  onChange={(checked) => setFeature("interrupts", checked, settings.logging.setInterrupts)}
                />
              </div>
            </SettingsRowV2>
            <SettingsRowV2
              title={language.t("settings.logging.row.optimization.title")}
              description={featureDescription(
                "settings.logging.row.optimization.description",
                effective(settings.logging.optimization()),
              )}
            >
              <div data-action="settings-logging-optimization">
                <LoggingSwitch
                  checked={settings.logging.optimization}
                  onChange={(checked) => setFeature("optimization", checked, settings.logging.setOptimization)}
                />
              </div>
            </SettingsRowV2>
            <SettingsRowV2
              title={language.t("settings.logging.row.ui.title")}
              description={featureDescription("settings.logging.row.ui.description", effective(settings.logging.ui()))}
            >
              <div data-action="settings-logging-ui">
                <LoggingSwitch checked={settings.logging.ui} onChange={(checked) => setFeature("ui", checked, settings.logging.setUi)} />
              </div>
            </SettingsRowV2>
          </SettingsListV2>
        </div>
      </div>
    </>
  )
}
