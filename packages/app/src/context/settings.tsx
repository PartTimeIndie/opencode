import { createStore, reconcile, type SetStoreFunction, type Store } from "solid-js/store"
import { createEffect, createMemo, type Accessor } from "solid-js"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { persisted } from "@/utils/persist"

export interface NotificationSettings {
  agent: boolean
  permissions: boolean
  errors: boolean
}

export interface SoundSettings {
  agentEnabled: boolean
  agent: string
  permissionsEnabled: boolean
  permissions: string
  errorsEnabled: boolean
  errors: string
}

export type OptimizationProfile = "off" | "safe" | "speed"
export type LoggingProfile = "off" | "safe" | "verbose"

export interface OptimizationSettings {
  optimizationProfile: OptimizationProfile
  toolContextCompression: boolean
  externalContextReduction: boolean
  sourceTestContextPack: boolean
  compactVerifierContext: boolean
  selfTestPolicy: boolean
  coreSearchLimits: boolean
  toolMaterializationCache: boolean
  runnerRequestMetrics: boolean
  sessionTabPrefetch: boolean
}

export interface LoggingSettings {
  loggingProfile: LoggingProfile
  trace: boolean
  performance: boolean
  interrupts: boolean
  optimization: boolean
  ui: boolean
}

export interface Settings {
  general: {
    autoSave: boolean
    releaseNotes: boolean
    followup: "queue" | "steer"
    showFileTree: boolean
    showNavigation: boolean
    showSearch: boolean
    showStatus: boolean
    showTerminal: boolean
    showReasoningSummaries: boolean
    shellToolPartsExpanded: boolean
    editToolPartsExpanded: boolean
    showSessionProgressBar: boolean
    sidebarSessionLimit: number
    showCustomAgents: boolean
    followupQueueMigrated?: boolean
  }
  appearance: {
    fontSize: number
    mono: string
    sans: string
    terminal: string
    slashCommandColors: Record<string, Partial<Record<"light" | "dark", string>>>
  }
  keybinds: Record<string, string>
  permissions: {
    autoApprove: boolean
  }
  notifications: NotificationSettings
  sounds: SoundSettings
  models: {
    recentLimit: number
  }
  optimizations: OptimizationSettings
  logging: LoggingSettings
}

export const monoDefault = "System Mono"
export const sansDefault = "System Sans"
export const terminalDefault = "JetBrainsMono Nerd Font Mono"
export const sidebarSessionLimitDefault = 4
export const modelPickerRecentLimitDefault = 3
export const modelPickerRecentLimitMax = 20
export const slashCommandColorDefaults = {
  light: "#7e22ce",
  dark: "#c4b5fd",
}

const sidebarSessionLimitStorageKey = "opencode.settings.sidebarSessionLimit"
const sidebarSessionLimitEvent = "opencode:sidebar-session-limit"

const monoFallback =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'
const sansFallback = 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
const terminalFallback =
  '"JetBrainsMono Nerd Font Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'

const monoBase = monoFallback
const sansBase = sansFallback
const terminalBase = terminalFallback

function input(font: string | undefined) {
  return font ?? ""
}

function family(font: string) {
  if (/^[\w-]+$/.test(font)) return font
  return `"${font.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

function sidebarSessionLimit(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return sidebarSessionLimitDefault
  return Math.min(50, Math.max(1, Math.round(value)))
}

function modelPickerRecentLimit(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return modelPickerRecentLimitDefault
  return Math.min(modelPickerRecentLimitMax, Math.max(0, Math.round(value)))
}

export function followupSetting(value: unknown): Settings["general"]["followup"] {
  return value === "steer" ? "steer" : "queue"
}

function publishSidebarSessionLimit(value: number) {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(sidebarSessionLimitStorageKey, JSON.stringify(value))
  } catch {}
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(sidebarSessionLimitEvent, { detail: { value } }))
}

function stack(font: string | undefined, base: string) {
  const value = font?.trim() ?? ""
  if (!value) return base
  return `${family(value)}, ${base}`
}

export function monoInput(font: string | undefined) {
  return input(font)
}

export function sansInput(font: string | undefined) {
  return input(font)
}

export function monoFontFamily(font: string | undefined) {
  return stack(font, monoBase)
}

export function sansFontFamily(font: string | undefined) {
  return stack(font, sansBase)
}

export function terminalInput(font: string | undefined) {
  return input(font)
}

export function terminalFontFamily(font: string | undefined) {
  return stack(font, terminalBase)
}

export const defaultSettings: Settings = {
  general: {
    autoSave: true,
    releaseNotes: true,
    followup: "queue",
    showFileTree: false,
    showNavigation: false,
    showSearch: false,
    showStatus: false,
    showTerminal: false,
    showReasoningSummaries: false,
    shellToolPartsExpanded: false,
    editToolPartsExpanded: false,
    showSessionProgressBar: true,
    sidebarSessionLimit: sidebarSessionLimitDefault,
    showCustomAgents: false,
    followupQueueMigrated: true,
  },
  appearance: {
    fontSize: 14,
    mono: "",
    sans: "",
    terminal: "",
    slashCommandColors: {},
  },
  keybinds: {},
  permissions: {
    autoApprove: false,
  },
  notifications: {
    agent: true,
    permissions: true,
    errors: false,
  },
  sounds: {
    agentEnabled: true,
    agent: "staplebops-01",
    permissionsEnabled: true,
    permissions: "staplebops-02",
    errorsEnabled: true,
    errors: "nope-03",
  },
  models: {
    recentLimit: modelPickerRecentLimitDefault,
  },
  optimizations: {
    optimizationProfile: "safe",
    toolContextCompression: true,
    externalContextReduction: true,
    sourceTestContextPack: true,
    compactVerifierContext: true,
    selfTestPolicy: true,
    coreSearchLimits: true,
    toolMaterializationCache: false,
    runnerRequestMetrics: true,
    sessionTabPrefetch: true,
  },
  logging: {
    loggingProfile: "verbose",
    trace: true,
    performance: true,
    interrupts: true,
    optimization: true,
    ui: true,
  },
}

function withFallback<T>(read: () => T | undefined, fallback: T) {
  return createMemo(() => read() ?? fallback)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Pure migration contract for persisted settings.v3 blobs; exported for regression tests. */
export function migrateSettings(value: unknown) {
  if (!isRecord(value)) return value
  const general = isRecord(value.general) ? value.general : undefined
  const appearance = isRecord(value.appearance) ? value.appearance : undefined
  const migrated = {
    ...value,
    appearance: {
      ...defaultSettings.appearance,
      ...appearance,
      slashCommandColors: isRecord(appearance?.slashCommandColors) ? appearance.slashCommandColors : {},
    },
    optimizations: {
      ...defaultSettings.optimizations,
      ...(isRecord(value.optimizations) ? value.optimizations : {}),
    },
    logging: {
      ...defaultSettings.logging,
      ...(isRecord(value.logging) ? value.logging : {}),
    },
  }
  if (!general || general.followup !== "steer" || general.followupQueueMigrated === true) return migrated
  return {
    ...migrated,
    general: {
      ...general,
      followup: "queue",
      followupQueueMigrated: true,
    },
  }
}

/** Build the settings API surface from a hydrated store; exported seam for surface regression tests. */
export function createSettingsApi(
  store: Store<Settings>,
  setStore: SetStoreFunction<Settings>,
  ready: Accessor<boolean>,
) {
  const showFileTree = withFallback(() => store.general?.showFileTree, defaultSettings.general.showFileTree)
    const showSearch = withFallback(() => store.general?.showSearch, defaultSettings.general.showSearch)
    const showStatus = withFallback(() => store.general?.showStatus, defaultSettings.general.showStatus)
    const showCustomAgents = withFallback(
      () => store.general?.showCustomAgents,
      defaultSettings.general.showCustomAgents,
    )
    createEffect(() => {
      if (typeof document === "undefined") return
      const root = document.documentElement
      root.style.setProperty("--font-family-mono", monoFontFamily(store.appearance?.mono))
      root.style.setProperty("--font-family-sans", sansFontFamily(store.appearance?.sans))
    })

    createEffect(() => {
      publishSidebarSessionLimit(sidebarSessionLimit(store.general?.sidebarSessionLimit))
    })

    return {
      ready,
      get current() {
        return store
      },
      models: {
        recentLimit: createMemo(() => modelPickerRecentLimit(store.models?.recentLimit)),
        setRecentLimit(value: number) {
          setStore("models", "recentLimit", modelPickerRecentLimit(value))
        },
      },
      general: {
        autoSave: withFallback(() => store.general?.autoSave, defaultSettings.general.autoSave),
        setAutoSave(value: boolean) {
          setStore("general", "autoSave", value)
        },
        releaseNotes: withFallback(() => store.general?.releaseNotes, defaultSettings.general.releaseNotes),
        setReleaseNotes(value: boolean) {
          setStore("general", "releaseNotes", value)
        },
        followup: createMemo(() => followupSetting(store.general?.followup)),
        setFollowup(value: "queue" | "steer") {
          setStore("general", "followup", value)
          setStore("general", "followupQueueMigrated", true)
        },
        showFileTree,
        setShowFileTree(value: boolean) {
          setStore("general", "showFileTree", value)
        },
        showNavigation: withFallback(() => store.general?.showNavigation, defaultSettings.general.showNavigation),
        setShowNavigation(value: boolean) {
          setStore("general", "showNavigation", value)
        },
        showSearch,
        setShowSearch(value: boolean) {
          setStore("general", "showSearch", value)
        },
        showStatus,
        setShowStatus(value: boolean) {
          setStore("general", "showStatus", value)
        },
        showTerminal: withFallback(() => store.general?.showTerminal, defaultSettings.general.showTerminal),
        setShowTerminal(value: boolean) {
          setStore("general", "showTerminal", value)
        },
        showReasoningSummaries: withFallback(
          () => store.general?.showReasoningSummaries,
          defaultSettings.general.showReasoningSummaries,
        ),
        setShowReasoningSummaries(value: boolean) {
          setStore("general", "showReasoningSummaries", value)
        },
        shellToolPartsExpanded: withFallback(
          () => store.general?.shellToolPartsExpanded,
          defaultSettings.general.shellToolPartsExpanded,
        ),
        setShellToolPartsExpanded(value: boolean) {
          setStore("general", "shellToolPartsExpanded", value)
        },
        editToolPartsExpanded: withFallback(
          () => store.general?.editToolPartsExpanded,
          defaultSettings.general.editToolPartsExpanded,
        ),
        setEditToolPartsExpanded(value: boolean) {
          setStore("general", "editToolPartsExpanded", value)
        },
        showSessionProgressBar: withFallback(
          () => store.general?.showSessionProgressBar,
          defaultSettings.general.showSessionProgressBar,
        ),
        setShowSessionProgressBar(value: boolean) {
          setStore("general", "showSessionProgressBar", value)
        },
        sidebarSessionLimit: createMemo(() => sidebarSessionLimit(store.general?.sidebarSessionLimit)),
        setSidebarSessionLimit(value: number) {
          setStore("general", "sidebarSessionLimit", sidebarSessionLimit(value))
        },
        showCustomAgents,
        setShowCustomAgents(value: boolean) {
          setStore("general", "showCustomAgents", value)
        },
      },
      visibility: {
        fileTree: showFileTree,
        search: showSearch,
        status: showStatus,
        customAgents: showCustomAgents,
      },
      appearance: {
        fontSize: withFallback(() => store.appearance?.fontSize, defaultSettings.appearance.fontSize),
        setFontSize(value: number) {
          setStore("appearance", "fontSize", value)
        },
        font: withFallback(() => store.appearance?.mono, defaultSettings.appearance.mono),
        setFont(value: string) {
          setStore("appearance", "mono", value.trim() ? value : "")
        },
        uiFont: withFallback(() => store.appearance?.sans, defaultSettings.appearance.sans),
        setUIFont(value: string) {
          setStore("appearance", "sans", value.trim() ? value : "")
        },
        terminalFont: withFallback(() => store.appearance?.terminal, defaultSettings.appearance.terminal),
        setTerminalFont(value: string) {
          setStore("appearance", "terminal", value.trim() ? value : "")
        },
        slashCommandColor(themeID: string, mode: "light" | "dark") {
          const value = store.appearance?.slashCommandColors?.[themeID]?.[mode]
          return value && /^#[\da-f]{6}$/i.test(value) ? value.toLowerCase() : undefined
        },
        setSlashCommandColor(themeID: string, mode: "light" | "dark", value: string | undefined) {
          if (value && !/^#[\da-f]{6}$/i.test(value)) return
          setStore("appearance", "slashCommandColors", (colors) => ({
            ...colors ?? {},
            [themeID]: {
              ...colors?.[themeID] ?? {},
              [mode]: value?.toLowerCase(),
            },
          }))
        },
      },
      keybinds: {
        get: (action: string) => store.keybinds?.[action],
        set(action: string, keybind: string) {
          setStore("keybinds", action, keybind)
        },
        reset(action: string) {
          setStore("keybinds", (current) => {
            if (!Object.prototype.hasOwnProperty.call(current, action)) return current
            const next = { ...current }
            delete next[action]
            return next
          })
        },
        resetAll() {
          setStore("keybinds", reconcile({}))
        },
      },
      permissions: {
        autoApprove: withFallback(() => store.permissions?.autoApprove, defaultSettings.permissions.autoApprove),
        setAutoApprove(value: boolean) {
          setStore("permissions", "autoApprove", value)
        },
      },
      notifications: {
        agent: withFallback(() => store.notifications?.agent, defaultSettings.notifications.agent),
        setAgent(value: boolean) {
          setStore("notifications", "agent", value)
        },
        permissions: withFallback(() => store.notifications?.permissions, defaultSettings.notifications.permissions),
        setPermissions(value: boolean) {
          setStore("notifications", "permissions", value)
        },
        errors: withFallback(() => store.notifications?.errors, defaultSettings.notifications.errors),
        setErrors(value: boolean) {
          setStore("notifications", "errors", value)
        },
      },
      sounds: {
        agentEnabled: withFallback(() => store.sounds?.agentEnabled, defaultSettings.sounds.agentEnabled),
        setAgentEnabled(value: boolean) {
          setStore("sounds", "agentEnabled", value)
        },
        agent: withFallback(() => store.sounds?.agent, defaultSettings.sounds.agent),
        setAgent(value: string) {
          setStore("sounds", "agent", value)
        },
        permissionsEnabled: withFallback(
          () => store.sounds?.permissionsEnabled,
          defaultSettings.sounds.permissionsEnabled,
        ),
        setPermissionsEnabled(value: boolean) {
          setStore("sounds", "permissionsEnabled", value)
        },
        permissions: withFallback(() => store.sounds?.permissions, defaultSettings.sounds.permissions),
        setPermissions(value: string) {
          setStore("sounds", "permissions", value)
        },
        errorsEnabled: withFallback(() => store.sounds?.errorsEnabled, defaultSettings.sounds.errorsEnabled),
        setErrorsEnabled(value: boolean) {
          setStore("sounds", "errorsEnabled", value)
        },
        errors: withFallback(() => store.sounds?.errors, defaultSettings.sounds.errors),
        setErrors(value: string) {
          setStore("sounds", "errors", value)
        },
      },
      optimizations: {
        optimizationProfile: withFallback(
          () => store.optimizations?.optimizationProfile,
          defaultSettings.optimizations.optimizationProfile,
        ),
        toolContextCompression: withFallback(
          () => store.optimizations?.toolContextCompression,
          defaultSettings.optimizations.toolContextCompression,
        ),
        setOptimizationProfile(value: OptimizationProfile) {
          setStore("optimizations", "optimizationProfile", value)
        },
        setToolContextCompression(value: boolean) {
          setStore("optimizations", "toolContextCompression", value)
        },
        externalContextReduction: withFallback(
          () => store.optimizations?.externalContextReduction,
          defaultSettings.optimizations.externalContextReduction,
        ),
        setExternalContextReduction(value: boolean) {
          setStore("optimizations", "externalContextReduction", value)
        },
        sourceTestContextPack: withFallback(
          () => store.optimizations?.sourceTestContextPack,
          defaultSettings.optimizations.sourceTestContextPack,
        ),
        setSourceTestContextPack(value: boolean) {
          setStore("optimizations", "sourceTestContextPack", value)
        },
        compactVerifierContext: withFallback(
          () => store.optimizations?.compactVerifierContext,
          defaultSettings.optimizations.compactVerifierContext,
        ),
        setCompactVerifierContext(value: boolean) {
          setStore("optimizations", "compactVerifierContext", value)
        },
        selfTestPolicy: withFallback(
          () => store.optimizations?.selfTestPolicy,
          defaultSettings.optimizations.selfTestPolicy,
        ),
        setSelfTestPolicy(value: boolean) {
          setStore("optimizations", "selfTestPolicy", value)
        },
        coreSearchLimits: withFallback(
          () => store.optimizations?.coreSearchLimits,
          defaultSettings.optimizations.coreSearchLimits,
        ),
        setCoreSearchLimits(value: boolean) {
          setStore("optimizations", "coreSearchLimits", value)
        },
        toolMaterializationCache: withFallback(
          () => store.optimizations?.toolMaterializationCache,
          defaultSettings.optimizations.toolMaterializationCache,
        ),
        setToolMaterializationCache(value: boolean) {
          setStore("optimizations", "toolMaterializationCache", value)
        },
        runnerRequestMetrics: withFallback(
          () => store.optimizations?.runnerRequestMetrics,
          defaultSettings.optimizations.runnerRequestMetrics,
        ),
        setRunnerRequestMetrics(value: boolean) {
          setStore("optimizations", "runnerRequestMetrics", value)
        },
        sessionTabPrefetch: withFallback(
          () => store.optimizations?.sessionTabPrefetch,
          defaultSettings.optimizations.sessionTabPrefetch,
        ),
        setSessionTabPrefetch(value: boolean) {
          setStore("optimizations", "sessionTabPrefetch", value)
        },
      },
      logging: {
        loggingProfile: withFallback(() => store.logging?.loggingProfile, defaultSettings.logging.loggingProfile),
        setLoggingProfile(value: LoggingProfile) {
          setStore("logging", "loggingProfile", value)
        },
        trace: withFallback(() => store.logging?.trace, defaultSettings.logging.trace),
        setTrace(value: boolean) {
          setStore("logging", "trace", value)
        },
        performance: withFallback(() => store.logging?.performance, defaultSettings.logging.performance),
        setPerformance(value: boolean) {
          setStore("logging", "performance", value)
        },
        interrupts: withFallback(() => store.logging?.interrupts, defaultSettings.logging.interrupts),
        setInterrupts(value: boolean) {
          setStore("logging", "interrupts", value)
        },
        optimization: withFallback(() => store.logging?.optimization, defaultSettings.logging.optimization),
        setOptimization(value: boolean) {
          setStore("logging", "optimization", value)
        },
        ui: withFallback(() => store.logging?.ui, defaultSettings.logging.ui),
        setUi(value: boolean) {
          setStore("logging", "ui", value)
        },
      },
    }
  }

export const { use: useSettings, provider: SettingsProvider } = createSimpleContext({
  name: "Settings",
  gate: false,
  init: () => {
    const [store, setStore, , ready] = persisted(
      { key: "settings.v3", migrate: migrateSettings },
      createStore<Settings>(defaultSettings),
    )
    return createSettingsApi(store, setStore, ready)
  },
})
