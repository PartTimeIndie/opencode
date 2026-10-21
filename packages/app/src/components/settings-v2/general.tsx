import { Component, Show, createEffect, createMemo, createResource, createSignal, onMount } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { useTheme, type ColorScheme } from "@opencode-ai/ui/theme/context"
import { contrastRatio } from "@opencode-ai/ui/theme/color"
import { resolveThemeVariant } from "@opencode-ai/ui/theme/resolve"
import { resolveThemeVariantV2 } from "@opencode-ai/ui/theme/v2/resolve"
import { ConfigAccessControl } from "@opencode-ai/core/config/access-control"
import { useLanguage } from "@/context/language"
import { usePermission } from "@/context/permission"
import { useModels } from "@/context/models"
import { usePlatform, type DisplayBackend } from "@/context/platform"
import { useServerSync } from "@/context/server-sync"
import { useServerSDK } from "@/context/server-sdk"
import { useSessionRoute } from "@/context/session-route"
import { useUpdaterAction } from "../updater-action"
import {
  monoDefault,
  monoFontFamily,
  monoInput,
  sansDefault,
  sansFontFamily,
  sansInput,
  slashCommandColorDefaults,
  terminalDefault,
  terminalFontFamily,
  terminalInput,
  useSettings,
} from "@/context/settings"
import { decode64 } from "@/utils/base64"
import { playSoundById, SOUND_OPTIONS } from "@/utils/sound"
import { Link } from "../link"
import { SettingsModelTargetPickerV2 } from "../settings-model-target-picker"
import { safetyReviewTargetReference, safetyReviewTargetWrite } from "@/context/model-chain-safety-review-snapshot"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

let demoSoundState = {
  cleanup: undefined as (() => void) | undefined,
  timeout: undefined as NodeJS.Timeout | undefined,
  run: 0,
}

type ThemeOption = {
  id: string
  name: string
}

type ShellOption = {
  path: string
  name: string
  acceptable: boolean
}

type ShellSelectOption = {
  id: string
  value: string
  label: string
}

type TurnCompletionConfig = {
  enabled?: boolean
  prompt?: string
  target?: string
  model?: string
  variant?: string
}

type ConfigWithTurnCompletion = {
  session?: {
    turn_completion?: TurnCompletionConfig
  }
  project_icon_generation?: { enabled?: boolean }
}

const isHexColor = (value: unknown): value is `#${string}` => typeof value === "string" && /^#[\da-f]{6}$/i.test(value)

// To prevent audio from overlapping/playing very quickly when navigating the settings menus,
// delay the playback by 100ms during quick selection changes and pause existing sounds.
const stopDemoSound = () => {
  demoSoundState.run += 1
  if (demoSoundState.cleanup) {
    demoSoundState.cleanup()
  }
  clearTimeout(demoSoundState.timeout)
  demoSoundState.cleanup = undefined
}

const playDemoSound = (id: string | undefined) => {
  stopDemoSound()
  if (!id) return

  const run = ++demoSoundState.run
  demoSoundState.timeout = setTimeout(() => {
    void playSoundById(id).then((cleanup) => {
      if (demoSoundState.run !== run) {
        cleanup?.()
        return
      }
      demoSoundState.cleanup = cleanup
    })
  }, 100)
}

export const SettingsGeneralV2: Component = () => {
  const theme = useTheme()
  const language = useLanguage()
  const permission = usePermission()
  const models = useModels()
  const platform = usePlatform()
  const params = useSessionRoute()
  const settings = useSettings()

  const updater = useUpdaterAction()

  const dir = createMemo(() => decode64(params.dir))
  const accepting = createMemo(() => {
    const value = dir()
    if (!value) return false
    if (!params.id) return permission.isAutoAcceptingDirectory(value)
    return permission.isAutoAccepting(params.id, value)
  })

  const toggleAccept = (checked: boolean) => {
    const value = dir()
    if (!value) return

    if (!params.id) {
      if (permission.isAutoAcceptingDirectory(value) === checked) return
      permission.toggleAutoAcceptDirectory(value)
      return
    }

    if (checked) {
      permission.enableAutoAccept(params.id, value)
      return
    }

    permission.disableAutoAccept(params.id, value)
  }
  const desktop = createMemo(() => platform.platform === "desktop")
  const linux = createMemo(() => desktop() && platform.os === "linux")

  const themeOptions = createMemo<ThemeOption[]>(() => theme.ids().map((id) => ({ id, name: theme.name(id) })))

  const serverSync = useServerSync()
  const serverSdk = useServerSDK()

  const [shells] = createResource(
    () =>
      serverSdk()
        .client.pty.shells()
        .then((res) => res.data ?? [])
        .catch(() => [] as ShellOption[]),
    { initialValue: [] as ShellOption[] },
  )

  const [pinchZoom, { mutate: setPinchZoom }] = createResource(
    () => (desktop() && platform.getPinchZoomEnabled ? true : false),
    () => Promise.resolve(platform.getPinchZoomEnabled?.() ?? false).catch(() => false),
    { initialValue: false },
  )
  const [browserAutomation, { mutate: setBrowserAutomation }] = createResource(
    () => (desktop() && platform.getBrowserAutomationEnabled ? true : false),
    () => Promise.resolve(platform.getBrowserAutomationEnabled?.() ?? true).catch(() => true),
    { initialValue: true },
  )
  const [displayBackend, { refetch: refetchDisplayBackend }] = createResource(
    () => (linux() && platform.getDisplayBackend ? true : false),
    () => Promise.resolve(platform.getDisplayBackend?.() ?? null).catch(() => null as DisplayBackend | null),
    { initialValue: null as DisplayBackend | null },
  )

  onMount(() => {
    void theme.loadThemes()
  })

  const autoOption = { id: "auto", value: "", label: language.t("settings.general.row.shell.autoDefault") }
  const currentShell = createMemo(() => serverSync().data.config.shell ?? "")

  const shellOptions = createMemo<ShellSelectOption[]>(() => {
    const list = shells.latest
    const current = serverSync().data.config.shell

    const nameCounts = new Map<string, number>()
    for (const s of list) {
      nameCounts.set(s.name, (nameCounts.get(s.name) || 0) + 1)
    }

    const options = [
      autoOption,
      ...list.map((s) => {
        const ambiguousName = (nameCounts.get(s.name) || 0) > 1
        const text = ambiguousName ? s.path : s.name
        const label = s.acceptable ? text : `${text} (${language.t("settings.general.row.shell.terminalOnly")})`
        return {
          id: s.path,
          // Prefer name over path - "bash" is much cleaner than the explicit full route even when it may change due to PATH.
          value: ambiguousName ? s.path : s.name,
          label,
        }
      }),
    ]

    if (current && !options.some((o) => o.value === current)) {
      options.push({ id: current, value: current, label: current })
    }

    return options
  })

  const onPinchZoomChange = (checked: boolean) => {
    setPinchZoom(checked)
    const update = platform.setPinchZoomEnabled?.(checked)
    if (!update) return
    void update.catch(() => setPinchZoom(!checked))
  }

  const onBrowserAutomationChange = (checked: boolean) => {
    setBrowserAutomation(checked)
    const update = platform.setBrowserAutomationEnabled?.(checked)
    if (!update) return
    void update.catch(() => setBrowserAutomation(!checked))
  }

  const onDisplayBackendChange = (checked: boolean) => {
    const update = platform.setDisplayBackend?.(checked ? "wayland" : "auto")
    if (!update) return
    void update.finally(() => {
      void refetchDisplayBackend()
    })
  }

  const colorSchemeOptions = createMemo((): { value: ColorScheme; label: string }[] => [
    { value: "system", label: language.t("theme.scheme.system") },
    { value: "light", label: language.t("theme.scheme.light") },
    { value: "dark", label: language.t("theme.scheme.dark") },
  ])

  const languageOptions = createMemo(() =>
    language.locales.map((locale) => ({
      value: locale,
      label: language.label(locale),
    })),
  )
  const followupOptions = createMemo(() => [
    { value: "queue" as const, label: language.t("settings.general.row.followup.option.queue") },
    { value: "steer" as const, label: language.t("settings.general.row.followup.option.steer") },
  ])

  const noneSound = { id: "none", label: "sound.option.none" } as const
  const soundOptions = [noneSound, ...SOUND_OPTIONS]
  const mono = () => monoInput(settings.appearance.font())
  const sans = () => sansInput(settings.appearance.uiFont())
  const terminal = () => terminalInput(settings.appearance.terminalFont())
  const lowContrastSlashCommandModes = createMemo(() =>
    (["light", "dark"] as const).filter((mode) => {
      const selected = settings.appearance.slashCommandColor(theme.themeId(), mode) ?? slashCommandColorDefaults[mode]
      const current = theme.themes()[theme.themeId()]
      if (!current || !isHexColor(selected)) return false
      return [
        resolveThemeVariant(current[mode], mode === "dark")["surface-raised-stronger-non-alpha"],
        resolveThemeVariantV2(current[mode], mode === "dark")["v2-background-bg-base"],
      ].some((background) => isHexColor(background) && contrastRatio(selected, background) < 4.5)
    }),
  )
  const fallbackSafetyReview = () => ConfigAccessControl.DEFAULT_INFO.safety_review ?? {}

  const safetyReview = createMemo(() => permission.globalSafetyReview() ?? fallbackSafetyReview())
  const safetyReviewTarget = createMemo(() =>
    safetyReviewTargetReference({
      current: safetyReview(),
      chains: models.chain.list(),
      defaultChainID: models.chain.default(),
    }),
  )

  const setSafetyReview = (patch: Partial<ReturnType<typeof safetyReview>>) => {
    void permission.setGlobalSafetyReview({ ...safetyReview(), ...patch }).catch(() => undefined)
  }

  const setSafetyOptions = (value: string) => {
    try {
      const options: unknown = value.trim() ? JSON.parse(value) : undefined
      if (options !== undefined && (!options || typeof options !== "object" || Array.isArray(options))) return
      setSafetyReview({ options: options as Record<string, unknown> | undefined })
    } catch {}
  }

  const configWithTurnCompletion = () => serverSync().data.config as ConfigWithTurnCompletion
  const [pendingTurnCompletion, setPendingTurnCompletion] = createSignal<TurnCompletionConfig>()
  const turnCompletion = createMemo(
    () => pendingTurnCompletion() ?? configWithTurnCompletion().session?.turn_completion ?? {},
  )
  const completionVariantOptions = createMemo(() => {
    const target = turnCompletion().target ?? turnCompletion().model
    if (!target || target.startsWith("chain:")) return ["default"]
    const ref = target.startsWith("model:") ? target.slice("model:".length) : target
    const [providerID, ...modelID] = ref.split("/")
    const model = providerID && modelID.length ? models.find({ providerID, modelID: modelID.join("/") }) : undefined
    return ["default", ...Object.keys(model?.variants ?? {})]
  })
  createEffect(() => {
    const pending = pendingTurnCompletion()
    if (!pending) return
    const current = configWithTurnCompletion().session?.turn_completion ?? {}
    if (
      current.enabled === pending.enabled &&
      current.target === pending.target &&
      current.model === pending.model &&
      current.variant === pending.variant &&
      current.prompt === pending.prompt
    ) {
      setPendingTurnCompletion(undefined)
    }
  })
  const setTurnCompletion = (patch: TurnCompletionConfig) => {
    const next = { ...turnCompletion(), ...patch }
    setPendingTurnCompletion(next)
    void serverSync()
      .updateConfig({
        session: {
          ...(configWithTurnCompletion().session ?? {}),
          turn_completion: next,
        },
      } as Parameters<ReturnType<typeof serverSync>["updateConfig"]>[0])
      .catch(() => {
        setPendingTurnCompletion((current) => (current === next ? undefined : current))
      })
  }
  const [pendingGeneratedProjectIcons, setPendingGeneratedProjectIcons] = createSignal<boolean>()
  const generatedProjectIcons = createMemo(
    () => pendingGeneratedProjectIcons() ?? configWithTurnCompletion().project_icon_generation?.enabled ?? false,
  )
  const setGeneratedProjectIcons = (enabled: boolean) => {
    setPendingGeneratedProjectIcons(enabled)
    void serverSync()
      .updateConfig({ project_icon_generation: { enabled } } as Parameters<
        ReturnType<typeof serverSync>["updateConfig"]
      >[0])
      .then(() => setPendingGeneratedProjectIcons(undefined))
      .catch(() => setPendingGeneratedProjectIcons(undefined))
  }

  const soundSelectProps = (
    enabled: () => boolean,
    current: () => string,
    setEnabled: (value: boolean) => void,
    set: (id: string) => void,
  ) => ({
    options: soundOptions,
    current: enabled() ? (soundOptions.find((o) => o.id === current()) ?? noneSound) : noneSound,
    value: (o: (typeof soundOptions)[number]) => o.id,
    label: (o: (typeof soundOptions)[number]) => language.t(o.label),
    onHighlight: (option: (typeof soundOptions)[number] | undefined) => {
      if (!option) return
      playDemoSound(option.id === "none" ? undefined : option.id)
    },
    onSelect: (option: (typeof soundOptions)[number] | null) => {
      if (!option) return
      if (option.id === "none") {
        setEnabled(false)
        stopDemoSound()
        return
      }
      setEnabled(true)
      set(option.id)
      playDemoSound(option.id)
    },
  })

  const GeneralSection = () => (
    <div class="settings-v2-section">
      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.general.row.language.title")}
          description={language.t("settings.general.row.language.description")}
        >
          <SelectV2
            appearance="inline"
            data-action="settings-language"
            options={languageOptions()}
            placement="bottom-end"
            gutter={6}
            current={languageOptions().find((o) => o.value === language.locale())}
            value={(o) => o.value}
            label={(o) => o.label}
            onSelect={(option) => option && language.setLocale(option.value)}
          />
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("command.permissions.autoaccept.enable")}
          description={language.t("toast.permissions.autoaccept.on.description")}
        >
          <div data-action="settings-auto-accept-permissions">
            <Switch checked={accepting()} disabled={!dir()} onChange={toggleAccept} />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          action="settings-safety-review-chain"
          title="Safety-review model or chain"
          description="Approve for me uses one model or a validated snapshot of the selected fallback chain."
        >
          <SettingsModelTargetPickerV2
            value={safetyReviewTarget()}
            label="Safety-review model or chain"
            required
            autoSelectDefault
            placeholder="No valid safety-review model or chain configured"
            onChange={(value) => {
              const next = safetyReviewTargetWrite({
                current: safetyReview(),
                value,
                chains: models.chain.list(),
                defaultChainID: models.chain.default(),
              })
              if (next) void permission.setGlobalSafetyReview(next).catch(() => undefined)
            }}
          />
        </SettingsRowV2>

        <SettingsRowV2 title="Safety max tokens" description="Optional max tokens for the safety-review generation.">
          <div class="w-24" data-action="settings-safety-review-max-tokens">
            <TextInputV2
              type="number"
              appearance="base"
              value={
                safetyReview()?.generation?.maxTokens === undefined ? "" : String(safetyReview()?.generation?.maxTokens)
              }
              onInput={(event) =>
                setSafetyReview({
                  generation: {
                    ...safetyReview()?.generation,
                    maxTokens: event.currentTarget.value.trim() ? Number(event.currentTarget.value) : undefined,
                  },
                })
              }
              aria-label="Safety max tokens"
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title="Safety reasoning options"
          description="Provider options JSON, for example reasoning or thinking settings."
        >
          <div class="w-80" data-action="settings-safety-review-options">
            <TextareaV2
              value={JSON.stringify(safetyReview()?.options ?? {}, null, 2)}
              rows={5}
              onInput={(event) => setSafetyOptions(event.currentTarget.value)}
              aria-label="Safety reasoning options"
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2 title="Safety prompt" description="System prompt used for the approve-for-me safety decision.">
          <div class="w-96" data-action="settings-safety-review-prompt">
            <TextareaV2
              value={safetyReview()?.prompt ?? ConfigAccessControl.DEFAULT_SAFETY_REVIEW_PROMPT}
              rows={6}
              onInput={(event) =>
                setSafetyReview({ prompt: event.currentTarget.value.trim() ? event.currentTarget.value : undefined })
              }
              aria-label="Safety prompt"
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.shell.title")}
          description={language.t("settings.general.row.shell.description")}
        >
          <SelectV2
            appearance="inline"
            data-action="settings-shell"
            options={shellOptions()}
            current={shellOptions().find((o) => o.value === currentShell()) ?? autoOption}
            placement="bottom-end"
            gutter={6}
            value={(o) => o.id}
            label={(o) => o.label}
            onSelect={(option) => {
              if (!option) return
              if (option.value === currentShell()) return
              serverSync().updateConfig({ shell: option.value })
            }}
          />
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.followup.title")}
          description={language.t("settings.general.row.followup.description")}
        >
          <SelectV2
            appearance="inline"
            data-action="settings-followup-behavior"
            options={followupOptions()}
            current={followupOptions().find((o) => o.value === settings.general.followup()) ?? followupOptions()[0]}
            placement="bottom-end"
            gutter={6}
            value={(o) => o.value}
            label={(o) => o.label}
            onSelect={(option) => option && settings.general.setFollowup(option.value)}
          />
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.reasoningSummaries.title")}
          description={language.t("settings.general.row.reasoningSummaries.description")}
        >
          <div data-action="settings-feed-reasoning-summaries">
            <Switch
              checked={settings.general.showReasoningSummaries()}
              onChange={(checked) => settings.general.setShowReasoningSummaries(checked)}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.shellToolPartsExpanded.title")}
          description={language.t("settings.general.row.shellToolPartsExpanded.description")}
        >
          <div data-action="settings-feed-shell-tool-parts-expanded">
            <Switch
              checked={settings.general.shellToolPartsExpanded()}
              onChange={(checked) => settings.general.setShellToolPartsExpanded(checked)}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.editToolPartsExpanded.title")}
          description={language.t("settings.general.row.editToolPartsExpanded.description")}
        >
          <div data-action="settings-feed-edit-tool-parts-expanded">
            <Switch
              checked={settings.general.editToolPartsExpanded()}
              onChange={(checked) => settings.general.setEditToolPartsExpanded(checked)}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.showSessionProgressBar.title")}
          description={language.t("settings.general.row.showSessionProgressBar.description")}
        >
          <div data-action="settings-show-session-progress-bar">
            <Switch
              checked={settings.general.showSessionProgressBar()}
              onChange={(checked) => settings.general.setShowSessionProgressBar(checked)}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.sidebarSessionLimit.title")}
          description={language.t("settings.general.row.sidebarSessionLimit.description")}
        >
          <div class="w-20" data-action="settings-sidebar-session-limit">
            <TextInputV2
              type="number"
              appearance="base"
              value={String(settings.general.sidebarSessionLimit())}
              onInput={(event) => settings.general.setSidebarSessionLimit(Number(event.currentTarget.value))}
              min={1}
              max={50}
              aria-label={language.t("settings.general.row.sidebarSessionLimit.title")}
            />
          </div>
        </SettingsRowV2>
      </SettingsListV2>
    </div>
  )

  const TurnCompletionSection = () => (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">Turn completion</h3>

      <SettingsListV2>
        <SettingsRowV2
          title="Completion status"
          description="Evaluate finished agent turns and color todo status plus the session tab dot green (done), orange (plan ready, needs attention), or red (incomplete)."
        >
          <div data-action="settings-turn-completion-enabled">
            <Switch
              checked={turnCompletion().enabled ?? false}
              onChange={(checked) => setTurnCompletion({ enabled: checked })}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title="Completion model or chain"
          description="Model or fallback chain for the turn completion check. An unavailable target marks turns as unknown instead of guessing."
        >
          <div class="w-64" data-action="settings-turn-completion-model">
            <SettingsModelTargetPickerV2
              value={turnCompletion().target ?? (turnCompletion().model ? `model:${turnCompletion().model}` : "")}
              label="Completion model or chain"
              placeholder="No completion model or chain"
              onChange={(value) =>
                setTurnCompletion(
                  value
                    ? { target: value, model: undefined, variant: undefined }
                    : { target: undefined, model: undefined, variant: undefined },
                )
              }
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title="Completion variant"
          description="Optional model variant for the completion check. Only applies to model targets, not chains."
        >
          <div class="w-64" data-action="settings-turn-completion-variant">
            <SelectV2
              appearance="inline"
              options={completionVariantOptions()}
              current={turnCompletion().variant ?? "default"}
              label={(value) => value}
              onSelect={(value) => {
                if (!value || value === (turnCompletion().variant ?? "default")) return
                setTurnCompletion({ variant: value === "default" ? undefined : value })
              }}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title="Completion prompt"
          description="Prompt used to ask whether the agent actually completed the work."
        >
          <div class="w-full max-w-xl" data-action="settings-turn-completion-prompt">
            <TextareaV2
              value={turnCompletion().prompt ?? ""}
              placeholder="Evaluate whether the agent completed all requested work. Respond with DONE or INCOMPLETE."
              rows={5}
              spellcheck={false}
              onInput={(event) =>
                setTurnCompletion({ prompt: event.currentTarget.value.trim() ? event.currentTarget.value : undefined })
              }
            />
          </div>
        </SettingsRowV2>
      </SettingsListV2>
    </div>
  )

  const AdvancedSection = () => (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">{language.t("settings.general.section.advanced")}</h3>

      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.general.row.showFileTree.title")}
          description={language.t("settings.general.row.showFileTree.description")}
        >
          <div data-action="settings-show-file-tree">
            <Switch
              checked={settings.general.showFileTree()}
              onChange={(checked) => settings.general.setShowFileTree(checked)}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.showSearch.title")}
          description={language.t("settings.general.row.showSearch.description")}
        >
          <div data-action="settings-show-search">
            <Switch
              checked={settings.general.showSearch()}
              onChange={(checked) => settings.general.setShowSearch(checked)}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.showStatus.title")}
          description={language.t("settings.general.row.showStatus.description")}
        >
          <div data-action="settings-show-status">
            <Switch
              checked={settings.general.showStatus()}
              onChange={(checked) => settings.general.setShowStatus(checked)}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.showCustomAgents.title")}
          description={language.t("settings.general.row.showCustomAgents.description")}
        >
          <div data-action="settings-show-custom-agents">
            <Switch
              checked={settings.general.showCustomAgents()}
              onChange={(checked) => settings.general.setShowCustomAgents(checked)}
            />
          </div>
        </SettingsRowV2>
      </SettingsListV2>
    </div>
  )

  const AppearanceSection = () => (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">{language.t("settings.general.section.appearance")}</h3>

      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.general.row.colorScheme.title")}
          description={language.t("settings.general.row.colorScheme.description")}
        >
          <SelectV2
            appearance="inline"
            data-action="settings-color-scheme"
            options={colorSchemeOptions()}
            current={colorSchemeOptions().find((o) => o.value === theme.colorScheme())}
            placement="bottom-end"
            gutter={6}
            value={(o) => o.value}
            label={(o) => o.label}
            onSelect={(option) => option && theme.setColorScheme(option.value)}
            onHighlight={(option) => {
              if (!option) return
              theme.previewColorScheme(option.value)
              return () => theme.cancelPreview()
            }}
          />
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.theme.title")}
          description={
            <>
              {language.t("settings.general.row.theme.description")}{" "}
              <Link class="settings-v2-link" href="https://opencode.ai/docs/themes/">
                {language.t("common.learnMore")}
              </Link>
            </>
          }
        >
          <SelectV2
            appearance="inline"
            data-action="settings-theme"
            options={themeOptions()}
            current={themeOptions().find((o) => o.id === theme.themeId())}
            placement="bottom-end"
            gutter={6}
            value={(o) => o.id}
            label={(o) => o.name}
            onSelect={(option) => {
              if (!option) return
              theme.setTheme(option.id)
            }}
            onHighlight={(option) => {
              if (!option) return
              theme.previewTheme(option.id)
              return () => theme.cancelPreview()
            }}
          />
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.generatedProjectIcons.title")}
          description={language.t("settings.general.row.generatedProjectIcons.description")}
        >
          <div data-action="settings-generated-project-icons">
            <Switch checked={generatedProjectIcons()} onChange={setGeneratedProjectIcons} />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.slashCommandColor.title")}
          description={language.t("settings.general.row.slashCommandColor.description", {
            theme: theme.name(theme.themeId()),
          })}
        >
          <div data-action="settings-slash-command-color" class="settings-v2-color-control">
            <label>
              <span>{language.t("settings.general.row.slashCommandColor.light")}</span>
              <input
                type="color"
                data-scheme="light"
                aria-label={language.t("settings.general.row.slashCommandColor.light")}
                value={
                  settings.appearance.slashCommandColor(theme.themeId(), "light") ?? slashCommandColorDefaults.light
                }
                onInput={(event) =>
                  settings.appearance.setSlashCommandColor(theme.themeId(), "light", event.currentTarget.value)
                }
              />
            </label>
            <label>
              <span>{language.t("settings.general.row.slashCommandColor.dark")}</span>
              <input
                type="color"
                data-scheme="dark"
                aria-label={language.t("settings.general.row.slashCommandColor.dark")}
                value={settings.appearance.slashCommandColor(theme.themeId(), "dark") ?? slashCommandColorDefaults.dark}
                onInput={(event) =>
                  settings.appearance.setSlashCommandColor(theme.themeId(), "dark", event.currentTarget.value)
                }
              />
            </label>
            <ButtonV2
              size="small"
              variant="ghost-muted"
              disabled={
                !settings.appearance.slashCommandColor(theme.themeId(), "light") &&
                !settings.appearance.slashCommandColor(theme.themeId(), "dark")
              }
              onClick={() => {
                settings.appearance.setSlashCommandColor(theme.themeId(), "light", undefined)
                settings.appearance.setSlashCommandColor(theme.themeId(), "dark", undefined)
              }}
            >
              {language.t("common.reset")}
            </ButtonV2>
            <Show when={lowContrastSlashCommandModes().length > 0}>
              <span class="settings-v2-color-warning" role="status" aria-live="polite">
                {language.t("settings.general.row.slashCommandColor.contrastWarning", {
                  schemes: lowContrastSlashCommandModes()
                    .map((mode) => language.t(`settings.general.row.slashCommandColor.${mode}`))
                    .join(", "),
                })}
              </span>
            </Show>
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.uiFont.title")}
          description={language.t("settings.general.row.uiFont.description")}
        >
          <div class="w-full sm:w-[220px]">
            <TextInputV2
              data-action="settings-ui-font"
              type="text"
              appearance="base"
              value={sans()}
              onInput={(event) => settings.appearance.setUIFont(event.currentTarget.value)}
              placeholder={sansDefault}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              aria-label={language.t("settings.general.row.uiFont.title")}
              style={{ "font-family": sansFontFamily(settings.appearance.uiFont()) }}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.font.title")}
          description={language.t("settings.general.row.font.description")}
        >
          <div class="w-full sm:w-[220px]">
            <TextInputV2
              data-action="settings-code-font"
              type="text"
              appearance="base"
              value={mono()}
              onInput={(event) => settings.appearance.setFont(event.currentTarget.value)}
              placeholder={monoDefault}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              aria-label={language.t("settings.general.row.font.title")}
              style={{ "font-family": monoFontFamily(settings.appearance.font()) }}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.row.terminalFont.title")}
          description={language.t("settings.general.row.terminalFont.description")}
        >
          <div class="w-full sm:w-[220px]">
            <TextInputV2
              data-action="settings-terminal-font"
              type="text"
              appearance="base"
              value={terminal()}
              onInput={(event) => settings.appearance.setTerminalFont(event.currentTarget.value)}
              placeholder={terminalDefault}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              aria-label={language.t("settings.general.row.terminalFont.title")}
              style={{ "font-family": terminalFontFamily(settings.appearance.terminalFont()) }}
            />
          </div>
        </SettingsRowV2>
      </SettingsListV2>
    </div>
  )

  const NotificationsSection = () => (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">{language.t("settings.general.section.notifications")}</h3>

      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.general.notifications.agent.title")}
          description={language.t("settings.general.notifications.agent.description")}
        >
          <div data-action="settings-notifications-agent">
            <Switch
              checked={settings.notifications.agent()}
              onChange={(checked) => settings.notifications.setAgent(checked)}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.notifications.permissions.title")}
          description={language.t("settings.general.notifications.permissions.description")}
        >
          <div data-action="settings-notifications-permissions">
            <Switch
              checked={settings.notifications.permissions()}
              onChange={(checked) => settings.notifications.setPermissions(checked)}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.notifications.errors.title")}
          description={language.t("settings.general.notifications.errors.description")}
        >
          <div data-action="settings-notifications-errors">
            <Switch
              checked={settings.notifications.errors()}
              onChange={(checked) => settings.notifications.setErrors(checked)}
            />
          </div>
        </SettingsRowV2>
      </SettingsListV2>
    </div>
  )

  const SoundsSection = () => (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">{language.t("settings.general.section.sounds")}</h3>

      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.general.sounds.agent.title")}
          description={language.t("settings.general.sounds.agent.description")}
        >
          <SelectV2
            appearance="inline"
            data-action="settings-sounds-agent"
            {...soundSelectProps(
              () => settings.sounds.agentEnabled(),
              () => settings.sounds.agent(),
              (value) => settings.sounds.setAgentEnabled(value),
              (id) => settings.sounds.setAgent(id),
            )}
            placement="bottom-end"
            gutter={6}
          />
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.sounds.permissions.title")}
          description={language.t("settings.general.sounds.permissions.description")}
        >
          <SelectV2
            appearance="inline"
            data-action="settings-sounds-permissions"
            {...soundSelectProps(
              () => settings.sounds.permissionsEnabled(),
              () => settings.sounds.permissions(),
              (value) => settings.sounds.setPermissionsEnabled(value),
              (id) => settings.sounds.setPermissions(id),
            )}
            placement="bottom-end"
            gutter={6}
          />
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.sounds.errors.title")}
          description={language.t("settings.general.sounds.errors.description")}
        >
          <SelectV2
            appearance="inline"
            data-action="settings-sounds-errors"
            {...soundSelectProps(
              () => settings.sounds.errorsEnabled(),
              () => settings.sounds.errors(),
              (value) => settings.sounds.setErrorsEnabled(value),
              (id) => settings.sounds.setErrors(id),
            )}
            placement="bottom-end"
            gutter={6}
          />
        </SettingsRowV2>
      </SettingsListV2>
    </div>
  )

  const UpdatesSection = () => (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">{language.t("settings.general.section.updates")}</h3>

      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.general.row.releaseNotes.title")}
          description={language.t("settings.general.row.releaseNotes.description")}
        >
          <div data-action="settings-release-notes">
            <Switch
              checked={settings.general.releaseNotes()}
              onChange={(checked) => settings.general.setReleaseNotes(checked)}
            />
          </div>
        </SettingsRowV2>

        <Show when={desktop()}>
          <SettingsRowV2
            title={language.t("settings.updates.row.check.title")}
            description={language.t("settings.updates.row.check.description")}
          >
            <ButtonV2 size="normal" variant="neutral" disabled={!updater.action().run} onClick={updater.run}>
              {language.t(updater.action().label)}
            </ButtonV2>
          </SettingsRowV2>
        </Show>
      </SettingsListV2>
    </div>
  )

  // We can probably remove this, right?
  const DisplaySection = () => (
    <Show when={desktop()}>
      <div class="settings-v2-section">
        <h3 class="settings-v2-section-title">{language.t("settings.general.section.display")}</h3>

        <SettingsListV2>
          <SettingsRowV2
            title={language.t("settings.general.row.pinchZoom.title")}
            description={language.t("settings.general.row.pinchZoom.description")}
          >
            <div data-action="settings-pinch-zoom">
              <Switch checked={pinchZoom.latest} onChange={onPinchZoomChange} />
            </div>
          </SettingsRowV2>

          <SettingsRowV2
            title={language.t("settings.general.row.browserAutomation.title")}
            description={language.t("settings.general.row.browserAutomation.description")}
          >
            <div data-action="settings-browser-automation">
              <Switch checked={browserAutomation.latest} onChange={onBrowserAutomationChange} />
            </div>
          </SettingsRowV2>

          <Show when={linux()}>
            <SettingsRowV2
              title={language.t("settings.general.row.wayland.title")}
              description={language.t("settings.general.row.wayland.description")}
            >
              <div data-action="settings-wayland">
                <Switch checked={displayBackend.latest === "wayland"} onChange={onDisplayBackendChange} />
              </div>
            </SettingsRowV2>
          </Show>
        </SettingsListV2>
      </div>
    </Show>
  )

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.tab.general")}</h2>
      </div>

      <div class="settings-v2-tab-body">
        <GeneralSection />

        <TurnCompletionSection />

        <AppearanceSection />

        <NotificationsSection />

        <SoundsSection />

        <UpdatesSection />

        <DisplaySection />

        <AdvancedSection />
      </div>
    </>
  )
}
