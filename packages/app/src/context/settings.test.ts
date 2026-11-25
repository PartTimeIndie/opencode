import { beforeEach, describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { createSettingsApi, defaultSettings, followupSetting, migrateSettings, type Settings } from "./settings"

const SETTINGS_KEY = "settings.v3"

beforeEach(() => {
  localStorage.clear()
})

// Mirrors the provider wiring: hydration runs migrateSettings over the stored blob
// (persist.ts already merged it over defaults) before accessors are created.
function mountedApi(stored?: unknown) {
  if (stored !== undefined) localStorage.setItem(SETTINGS_KEY, JSON.stringify(stored))
  const [store, setStore] = createStore<Settings>(structuredClone(defaultSettings))
  if (stored !== undefined) {
    const hydrated = JSON.parse(localStorage.getItem(SETTINGS_KEY)!)
    const merged = deepMerge(structuredClone(defaultSettings), migrateSettings(hydrated))
    setStore(merged as Partial<Settings>)
  }
  return { api: createSettingsApi(store, setStore, () => true), store }
}

function deepMerge(base: Record<string, any>, override: unknown): Record<string, any> {
  if (typeof override !== "object" || override === null || Array.isArray(override)) return base
  const result: Record<string, any> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    result[key] =
      typeof value === "object" && value !== null && !Array.isArray(value) && typeof result[key] === "object" && result[key] !== null
        ? deepMerge(result[key], value)
        : value
  }
  return result
}

describe("settings context surface", () => {
  test("defaults followups to the next safe boundary rather than a future activity", () => {
    expect(defaultSettings.general.followup).toBe("steer")
    expect(mountedApi().api.general.followup()).toBe("steer")
    for (const value of [undefined, null, "invalid", 42]) expect(followupSetting(value)).toBe("steer")
    expect(followupSetting("queue")).toBe("queue")
  })

  test("preserves stored steer delivery across hydration without rewriting user choices", () => {
    for (const marker of [undefined, false, true]) {
      const general = { followup: "steer", followupQueueMigrated: marker, autoSave: false }
      expect(migrateSettings({ general })).toMatchObject({ general })
      expect(mountedApi({ general }).api.general.followup()).toBe("steer")
    }
  })

  test("keeps an explicit queue choice and persists later delivery changes", () => {
    const { api, store } = mountedApi({ general: { followup: "queue" } })
    expect(api.general.followup()).toBe("queue")
    api.general.setFollowup("steer")
    expect(store.general.followup).toBe("steer")
    expect(migrateSettings({ general: { ...store.general } })).toMatchObject({ general: { followup: "steer" } })
    api.general.setFollowup("queue")
    expect(store.general.followup).toBe("queue")
  })

  test("exposes the full accessor surface with defaults on empty storage", () => {
    const { api: settings } = mountedApi()
    // sounds block: this is the neighborhood that was damaged by line-index edits;
    // losing any of these accessors must fail loudly here.
    expect(settings.sounds.agentEnabled()).toBe(true)
    expect(settings.sounds.agent()).toBe("staplebops-01")
    expect(settings.sounds.permissionsEnabled()).toBe(true)
    expect(typeof settings.sounds.setPermissions).toBe("function")
    expect(settings.sounds.permissions()).toBe("staplebops-02")
    expect(settings.sounds.errorsEnabled()).toBe(true)
    expect(settings.sounds.errors()).toBe("nope-03")
    expect(settings.notifications.permissions()).toBe(true)
    expect(settings.notifications.errors()).toBe(false)
    expect(settings.notifications.agent()).toBe(true)
    expect(settings.permissions.autoApprove()).toBe(false)
    expect(settings.logging.loggingProfile()).toBe("verbose")
    expect(settings.logging.trace()).toBe(true)
    expect(settings.logging.optimization()).toBe(true)
    expect(settings.general.autoSave()).toBe(true)
    expect(settings.appearance.fontSize()).toBe(14)
    expect(settings.keybinds.get("missing.action")).toBeUndefined()
    expect(settings.ready()).toBe(true)
    // retained optimizations
    expect(settings.optimizations.toolContextCompression()).toBe(true)
    expect(settings.optimizations.optimizationProfile()).toBe("safe")
    expect(settings.optimizations.coreSearchLimits()).toBe(true)
    expect(settings.optimizations.sessionTabPrefetch()).toBe(true)
    // retired controls must not resurface on the context
    expect("readDeduplication" in settings.optimizations).toBe(false)
    expect("stableToolOutputPreview" in settings.optimizations).toBe(false)
    expect("deferredToolDiscovery" in settings.optimizations).toBe(false)
    expect("compactToolSchemas" in settings.optimizations).toBe(false)
    expect("patchVerifyTool" in settings.optimizations).toBe(false)
    expect("batchCoreTools" in settings.optimizations).toBe(false)
  })

  test("migrates stored v3 blobs with retired optimization keys without losing neighboring sections", () => {
    const { api: settings } = mountedApi({
      optimizations: {
        optimizationProfile: "speed",
        readDeduplication: false,
        stableToolOutputPreview: false,
        deferredToolDiscovery: true,
        compactToolSchemas: false,
        patchVerifyTool: false,
        batchCoreTools: true,
      },
      sounds: { agentEnabled: false, permissions: "user-permission-sound" },
      notifications: { permissions: false, errors: true },
      logging: { loggingProfile: "off", trace: false },
      general: { autoSave: false },
      unknownFutureSection: { whatever: true },
    })
    // new key defaults in when the stored blob predates it
    expect(settings.optimizations.toolContextCompression()).toBe(true)
    // stored profile survives migration
    expect(settings.optimizations.optimizationProfile()).toBe("speed")
    // adjacent sections survive untouched on the accessor surface
    expect(settings.sounds.agentEnabled()).toBe(false)
    expect(settings.sounds.permissions()).toBe("user-permission-sound")
    expect(settings.sounds.agent()).toBe("staplebops-01")
    expect(settings.sounds.errors()).toBe("nope-03")
    expect(settings.notifications.permissions()).toBe(false)
    expect(settings.notifications.errors()).toBe(true)
    expect(settings.logging.loggingProfile()).toBe("off")
    expect(settings.logging.trace()).toBe(false)
    expect(settings.general.autoSave()).toBe(false)
  })

  test("stores an explicit toolContextCompression override and routes the setter", () => {
    const { api: settings, store } = mountedApi({ optimizations: { toolContextCompression: false } })
    expect(settings.optimizations.toolContextCompression()).toBe(false)
    settings.optimizations.setToolContextCompression(true)
    // read through the store: the accessor must write the exact store key it reads
    expect(store.optimizations.toolContextCompression).toBe(true)
  })

  test("falls back to per-section defaults when sections are missing or malformed", () => {
    const { api: settings } = mountedApi({ optimizations: null, sounds: "corrupted", logging: 42 })
    expect(settings.optimizations.toolContextCompression()).toBe(true)
    expect(settings.optimizations.runnerRequestMetrics()).toBe(true)
    expect(settings.sounds.agentEnabled()).toBe(true)
    expect(settings.sounds.permissionsEnabled()).toBe(true)
    expect(settings.sounds.errors()).toBe("nope-03")
    expect(settings.logging.loggingProfile()).toBe("verbose")
    expect(settings.logging.ui()).toBe(true)
  })

  test("migrateSettings normalizes app/optimizations/logging, tolerates extras and non-records", () => {
    const migrated = migrateSettings({
      sounds: { permissions: "keep-me" },
      notifications: { errors: true },
      optimizations: { batch_core_tools: true },
    }) as Record<string, any>
    expect(migrated.sounds.permissions).toBe("keep-me")
    expect(migrated.notifications.errors).toBe(true)
    expect(migrated.optimizations.toolContextCompression).toBe(true)
    expect(migrated.optimizations.batch_core_tools).toBe(true)
    expect(migrated.appearance.slashCommandColors).toEqual({})
    // non-records pass through unchanged (tolerant parser contract)
    expect(migrateSettings("garbage")).toBe("garbage")
    expect(migrateSettings(undefined)).toBeUndefined()
  })

  test("hydrated defaults back every accessor even when migrateSettings leaves sections sparse", () => {
    // persist.ts merges migrated blobs over defaults; simulate that by seeding the
    // store with the sparse migrated result and checking withFallback accessors.
    const sparse = migrateSettings({ sounds: { permissions: "keep-me" } }) as Record<string, any>
    const [store, setStore] = createStore<Settings>(structuredClone(defaultSettings))
    setStore("sounds", sparse.sounds)
    const settings = createSettingsApi(store, setStore, () => true)
    expect(settings.sounds.permissions()).toBe("keep-me")
    expect(settings.sounds.agent()).toBe("staplebops-01")
    expect(settings.sounds.errorsEnabled()).toBe(true)
  })
})
