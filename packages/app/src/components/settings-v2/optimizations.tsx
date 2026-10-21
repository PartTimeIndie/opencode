import { createEffect, createSignal, type Component } from "solid-js"
import type { Config } from "@opencode-ai/sdk/v2/client"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { useLanguage } from "@/context/language"
import { type OptimizationProfile, useSettings } from "@/context/settings"
import { type ServerSync, useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import { SettingsServerPicker } from "../settings-server-picker"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import {
  createServerOptimizationSync,
  featureChange,
  profilePresetChange,
  type ServerFeatureKey,
  type ServerOptimization,
} from "./optimizations-model"
import "./settings-v2.css"

const profileOptions: Array<{ value: OptimizationProfile }> = [{ value: "off" }, { value: "safe" }, { value: "speed" }]

const profileLabelKey = (profile: OptimizationProfile) => {
  if (profile === "off") return "settings.optimizations.profile.off"
  if (profile === "speed") return "settings.optimizations.profile.speed"
  return "settings.optimizations.profile.safe"
}

export const SettingsOptimizationsV2: Component = () => {
  const language = useLanguage()
  const settings = useSettings()
  const serverSync = useServerSync()
  const [hydratedTarget, setHydratedTarget] = createSignal<ServerSync>()
  const hydrated = () => hydratedTarget() === serverSync() && optimizationSync.hydrated(serverSync())
  const profile = () =>
    hydrated()
      ? (profileOptions.find((option) => option.value === settings.optimizations.optimizationProfile()) ?? profileOptions[1]!)
      : undefined
  const profileEnabled = () => settings.optimizations.optimizationProfile() !== "off"
  const effective = (enabled: boolean) => profileEnabled() && enabled
  const serverEffective = (enabled: boolean) => (hydrated() ? effective(enabled) : undefined)
  const OptimizationSwitch: Component<{
    checked: () => boolean
    onChange: (checked: boolean) => void
    requiresHydration?: boolean
  }> = (props) => (
    <Switch
      checked={props.requiresHydration && !hydrated() ? false : effective(props.checked())}
      disabled={!profileEnabled() || (props.requiresHydration && !hydrated())}
      onChange={props.onChange}
    />
  )
  const reportFailure = (error: unknown) =>
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: error instanceof Error ? error.message : String(error),
    })
  const applyServerOptimization = (optimization: ServerOptimization) => {
    settings.optimizations.setOptimizationProfile(optimization.profile)
    settings.optimizations.setCoreSearchLimits(optimization.features.core_search_limits)
    settings.optimizations.setToolMaterializationCache(optimization.features.tool_materialization_cache)
    settings.optimizations.setRunnerRequestMetrics(optimization.features.runner_request_metrics)
    settings.optimizations.setToolContextCompression(optimization.features.tool_context_compression)
  }
  const optimizationSync = createServerOptimizationSync<ServerSync>({
    active: serverSync,
    set: applyServerOptimization,
    write: (target, optimization) => target.updateConfig({ optimization } as Config),
    report: reportFailure,
  })
  const loading = new Set<ServerSync>()
  createEffect(() => {
    const target = serverSync()
    setHydratedTarget(optimizationSync.activate(target) ? target : undefined)
    const optimization = target.data.config.optimization
    if (optimization) {
      optimizationSync.hydrate(target, optimization)
      setHydratedTarget(target)
    }
    if (optimizationSync.hydrated(target) || loading.has(target)) return
    loading.add(target)
    void target
      .loadConfig()
      .then((config) => {
        optimizationSync.hydrate(target, config.optimization)
        if (serverSync() === target && optimizationSync.hydrated(target)) setHydratedTarget(target)
      })
      .catch(() => undefined)
      .finally(() => loading.delete(target))
  })
  const setProfile = (value: OptimizationProfile) => {
    if (!hydrated()) return
    const target = serverSync()
    void optimizationSync.commit(target, profilePresetChange(value))
  }
  const setFeature = (key: ServerFeatureKey, value: boolean) => {
    if (!hydrated()) return
    const target = serverSync()
    void optimizationSync.commit(target, featureChange(key, value))
  }
  const featureDescription = (key: Parameters<typeof language.t>[0], enabled: boolean | undefined) => (
    <div class="settings-v2-optimization-detail">
      <span>{language.t(key)}</span>
      <span>
        {enabled === undefined ? (
          "…"
        ) : (
          <>
            {language.t(enabled ? "settings.optimizations.status.enabled" : "settings.optimizations.status.disabled")}
            {" - "}
            {language.t("settings.optimizations.status.reportHint")}
          </>
        )}
      </span>
    </div>
  )

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-tab-header--stacked">
        <div class="settings-v2-tab-header-row">
          <h2 class="settings-v2-tab-title">{language.t("settings.optimizations.title")}</h2>
          <SettingsServerPicker />
        </div>
        <p>{language.t("settings.optimizations.description")}</p>
      </div>

      <div class="settings-v2-tab-body">
        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.optimizations.section.profile")}</h3>
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("settings.optimizations.row.optimizationProfile.title")}
              description={language.t("settings.optimizations.row.optimizationProfile.description")}
            >
              <div data-action="settings-optimization-profile" aria-busy={!hydrated()}>
                <SelectV2
                  appearance="inline"
                  options={profileOptions}
                  current={profile()}
                  value={(option) => option.value}
                  label={(option) => language.t(profileLabelKey(option.value))}
                  placeholder="…"
                  disabled={!hydrated()}
                  placement="bottom-end"
                  gutter={6}
                  onSelect={(option) => option && setProfile(option.value)}
                />
              </div>
            </SettingsRowV2>

            <SettingsRowV2
              title={language.t("settings.optimizations.row.toolContextCompression.title")}
              description={featureDescription(
                "settings.optimizations.row.toolContextCompression.description",
                serverEffective(settings.optimizations.toolContextCompression()),
              )}
            >
              <div data-action="settings-optimization-tool-context-compression">
                <OptimizationSwitch
                  checked={settings.optimizations.toolContextCompression}
                  requiresHydration
                  onChange={(checked) => setFeature("tool_context_compression", checked)}
                />
              </div>
            </SettingsRowV2>
            <SettingsRowV2
              title={language.t("settings.optimizations.row.externalContextReduction.title")}
              description={featureDescription(
                "settings.optimizations.row.externalContextReduction.description",
                effective(settings.optimizations.externalContextReduction()),
              )}
            >
              <div data-action="settings-optimization-external-context-reduction">
                <OptimizationSwitch
                  checked={settings.optimizations.externalContextReduction}
                  onChange={settings.optimizations.setExternalContextReduction}
                />
              </div>
            </SettingsRowV2>

            <SettingsRowV2
              title={language.t("settings.optimizations.row.sourceTestContextPack.title")}
              description={featureDescription(
                "settings.optimizations.row.sourceTestContextPack.description",
                effective(settings.optimizations.sourceTestContextPack()),
              )}
            >
              <div data-action="settings-optimization-source-test-context-pack">
                <OptimizationSwitch
                  checked={settings.optimizations.sourceTestContextPack}
                  onChange={settings.optimizations.setSourceTestContextPack}
                />
              </div>
            </SettingsRowV2>

            <SettingsRowV2
              title={language.t("settings.optimizations.row.compactVerifierContext.title")}
              description={featureDescription(
                "settings.optimizations.row.compactVerifierContext.description",
                effective(settings.optimizations.compactVerifierContext()),
              )}
            >
              <div data-action="settings-optimization-compact-verifier-context">
                <OptimizationSwitch
                  checked={settings.optimizations.compactVerifierContext}
                  onChange={settings.optimizations.setCompactVerifierContext}
                />
              </div>
            </SettingsRowV2>

            <SettingsRowV2
              title={language.t("settings.optimizations.row.selfTestPolicy.title")}
              description={featureDescription(
                "settings.optimizations.row.selfTestPolicy.description",
                effective(settings.optimizations.selfTestPolicy()),
              )}
            >
              <div data-action="settings-optimization-self-test-policy">
                <OptimizationSwitch
                  checked={settings.optimizations.selfTestPolicy}
                  onChange={settings.optimizations.setSelfTestPolicy}
                />
              </div>
            </SettingsRowV2>
          </SettingsListV2>
        </div>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.optimizations.section.core")}</h3>
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("settings.optimizations.row.coreSearchLimits.title")}
              description={featureDescription(
                "settings.optimizations.row.coreSearchLimits.description",
                serverEffective(settings.optimizations.coreSearchLimits()),
              )}
            >
              <div data-action="settings-optimization-core-search-limits">
                <OptimizationSwitch
                  checked={settings.optimizations.coreSearchLimits}
                  requiresHydration
                  onChange={(checked) => setFeature("core_search_limits", checked)}
                />
              </div>
            </SettingsRowV2>

            <SettingsRowV2
              title={language.t("settings.optimizations.row.toolMaterializationCache.title")}
              description={featureDescription(
                "settings.optimizations.row.toolMaterializationCache.description",
                serverEffective(settings.optimizations.toolMaterializationCache()),
              )}
            >
              <div data-action="settings-optimization-tool-materialization-cache">
                <OptimizationSwitch
                  checked={settings.optimizations.toolMaterializationCache}
                  requiresHydration
                  onChange={(checked) => setFeature("tool_materialization_cache", checked)}
                />
              </div>
            </SettingsRowV2>

            <SettingsRowV2
              title={language.t("settings.optimizations.row.sessionTabPrefetch.title")}
              description={featureDescription(
                "settings.optimizations.row.sessionTabPrefetch.description",
                effective(settings.optimizations.sessionTabPrefetch()),
              )}
            >
              <div data-action="settings-optimization-session-tab-prefetch">
                <OptimizationSwitch
                  checked={settings.optimizations.sessionTabPrefetch}
                  onChange={settings.optimizations.setSessionTabPrefetch}
                />
              </div>
            </SettingsRowV2>

            <SettingsRowV2
              title={language.t("settings.optimizations.row.runnerRequestMetrics.title")}
              description={featureDescription(
                "settings.optimizations.row.runnerRequestMetrics.description",
                serverEffective(settings.optimizations.runnerRequestMetrics()),
              )}
            >
              <div data-action="settings-optimization-runner-request-metrics">
                <OptimizationSwitch
                  checked={settings.optimizations.runnerRequestMetrics}
                  requiresHydration
                  onChange={(checked) => setFeature("runner_request_metrics", checked)}
                />
              </div>
            </SettingsRowV2>
          </SettingsListV2>
        </div>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.optimizations.section.diagnostics")}</h3>
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("settings.optimizations.row.status.title")}
              description={language.t("settings.optimizations.row.status.description")}
            >
              <div
                class="settings-v2-optimization-status"
                data-action="settings-optimization-status"
                aria-busy={!hydrated()}
              >
                {hydrated() ? language.t(profileLabelKey(settings.optimizations.optimizationProfile())) : "…"}
              </div>
            </SettingsRowV2>
          </SettingsListV2>
        </div>
      </div>
    </>
  )
}
