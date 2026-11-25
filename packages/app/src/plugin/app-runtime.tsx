// @refresh reload
import type {
  AppCapability,
  AppDockBounds,
  AppDockMountContext,
  AppDockItemPlacement,
  AppDockItem,
  AppSlotItem,
  AppToolbarItem,
  AppLoadingOverlayOptions,
  AppSettingsField,
  AppSettingsItem,
  AppAutomationItem,
  AppRouteItem,
  AppPluginApi,
  AppPluginModule,
  AppHostProject,
  AppHostNavigationState,
  AppHostNavigationEvent,
  AppHostSessionFavorite,
  AppHostSessionStatus,
  AppHostGitSnapshot,
  AppHostGitDiscoverResult,
  AppHostGitActionResult,
  AppHostGitHistoryPage,
  AppHostGitCommitMessagePage,
  AppHostHttpRequest,
  AppHostHttpResponse,
  AppHostCommandInput,
  AppHostCommandResult,
  AppHostAIMessage,
  AppHostAIRunInput,
  AppHostAIRunResult,
  AppHostImageGenerateInput,
  AppHostImageGenerateResult,
  AppHostSTTInput,
  AppHostSTTResult,
  AppHostTTSInput,
  AppHostTTSResult,
  AppHostSessionEvent,
  AppHostSessionMessage,
  AppHostSessionContextInput,
  AppHostSessionContextResult,
  AppHostSessionModel,
  AppOverlayOptions,
  AppHostComposerInsertResult,
  AppHostSkillReference,
  AppHostSkillResolveResult,
  AppHostTextInputTarget,
  AppHostDesktopServiceInvocation,
  AppHostDesktopServiceRegistration,
  AppPluginStatus,
} from "@opencode-ai/plugin/app"
export type {
  AppHostProject,
  AppHostNavigationState,
  AppHostNavigationEvent,
  AppHostSessionFavorite,
  AppHostSessionStatus,
  AppHostHttpRequest,
  AppHostHttpResponse,
  AppHostCommandInput,
  AppHostCommandResult,
  AppHostAIMessage,
  AppHostAIRunInput,
  AppHostAIRunResult,
  AppHostSTTInput,
  AppHostSTTResult,
  AppHostTTSInput,
  AppHostTTSResult,
  AppOverlayOptions,
  AppHostComposerInsertResult,
  AppHostSkillReference,
  AppHostSkillResolveResult,
  AppHostTextInputTarget,
  AppHostDesktopServiceInvocation,
  AppHostDesktopServiceRegistration,
  AppPluginStatus,
} from "@opencode-ai/plugin/app"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { pluginServiceResponse } from "./service-response"
import { Spinner } from "@opencode-ai/ui/spinner"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/v2/dialog-v2"
import {
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  getOwner,
  onCleanup,
  onMount,
  runWithOwner,
  Show,
  untrack,
  type Accessor,
  type JSX,
} from "solid-js"
import { createStore, produce } from "solid-js/store"
import { render } from "solid-js/web"
import { useNavigate, useSearchParams } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { RetryBackoff } from "@/lib/retry-backoff"
import { abortPluginWork } from "./abort"
import { useCommand, type CommandOption } from "@/context/command"
import type { DockArea } from "@/context/layout-dock"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { ServerConnection, useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { useModels } from "@/context/models"
import { useSessionFavorites, type SessionFavorite } from "@/context/session-favorites"
import { useSessionAttention } from "@/context/session-attention"
import { tabKey, useTabs, type Tab } from "@/context/tabs"
import { useDirectoryPicker } from "@/components/directory-picker"
import { SettingsModelPickerV2 } from "@/components/settings-model-picker"
import {
  chainMatchesChainPickerFilter,
  modelMatchesChainPickerFilter,
  type SettingsModelChainPickerFilter,
} from "@/components/settings-model-chain-picker-model"
import { migrateModelTargetSetting, shouldAutoSelectModelTarget } from "@/components/settings-model-target-picker-model"
import { pluginSettingsLeafFields } from "@/components/settings-v2/plugin-setting-values"
import { parseModelTarget, stripModelTargetModelPrefix } from "./model-target"
import { authTokenFromCredentials, createSdkForServer } from "@/utils/server"
import { Persist, persisted } from "@/utils/persist"
import { formatServerError } from "@/utils/server-errors"
import { latestAssistantCompletedBefore, latestAssistantSettled, resolveLifecycleStatus, resolveSessionStatus, sessionIsWorking } from "@/utils/session-status"
import { sessionActivity, sessionActivitySettled, sessionActivityStartedAt } from "@/utils/session-activity"
import { createPluginCommandOption, scopePluginCommand, type PluginCommandInput } from "./commands"
import { resolveHostAIChain } from "./host-ai-chain"
import { resolveGitCommitTarget } from "./git-commit-chain"
import { readGitResponse } from "./git-response"
import { mountPluginElement } from "./mount-lifecycle"
import { pluginModuleUrl } from "./module-url"
import {
  globalToolbarItemVisible,
  toolbarItemOverride,
  toolbarItemVisible,
  toolbarProjectKey,
  type ToolbarVisibilityOverride,
  type ToolbarVisibilityState,
} from "./toolbar-visibility"
import { sanitizeCustomPart, CUSTOM_PART_TITLE_MAX, CUSTOM_PART_FALLBACK_MAX, type CustomPart } from "./custom-part"
import {
  moveToolbarItemIDs,
  orderToolbarItems,
  toolbarAlign,
  toolbarItemEnabled,
  toolbarPlacement,
  type ToolbarContext,
  type ToolbarOrderState,
} from "./toolbar"
import { isUISlotID, type UISlotID } from "./ui-slots"
import { pluginTabDirectory, resolveActivePluginDirectories } from "./app-directories"
import { isPluginServerActive } from "./server-ownership"
import { createPluginScopeDisposer, ownsPluginScope, trackPluginScope, type PluginScope } from "./scope-lifecycle"
import { navigationHandoffs } from "./navigation-handoff"
import { createPluginModuleLoader } from "./plugin-module-loader"
import { captureFocusedTextInput } from "./focused-text-input"
import { skillReferences, skillReferenceDiagnostics } from "./skill-references"
import { encodeAudioBase64 } from "./audio-base64"
import { createAudioCaptureBroker } from "./audio-capture"
import { createFloatingHost } from "./floating"
import { acquirePromptSession } from "@/context/prompt"
import { backgroundPromptScope, insertPromptDraft, promptInsertionIdentity } from "@/context/prompt-insert"
import { composerRegistry } from "./composer-registry"
import { composerSendIntents } from "./composer-send-intent"
import { createComposerApi } from "./composer-api"
import {
  appendOnSubmitKey,
  appendOnSubmitTarget,
  createAppendOnSubmitStore,
  createToolbarFinalAppend,
  resolveAppendOnSubmitTarget,
  type AppendOnSubmitTarget,
} from "./append-on-submit"
import { createSessionSubscription, sessionMessages } from "./session-events"
import { normalizeCommandList } from "@/context/global-sync/utils"
import { decode64 } from "@/utils/base64"
import { pluginDisplayName } from "@opencode-ai/core/util/plugin-name"
import {
  APP_PLUGIN_SETTINGS_CHANGED,
  dispatchAppPluginSettingsChanged,
  dispatchAppPluginSettingsItemChanged,
} from "./app-plugin-settings-events"

export { sanitizeCustomPart, CUSTOM_PART_TITLE_MAX, CUSTOM_PART_FALLBACK_MAX }
export type { CustomPart }
export type { PluginScope }
export type { AppHostSessionEvent, AppHostSessionMessage, AppHostSessionModel } from "@opencode-ai/plugin/app"

export type { DockArea }

export type AppPluginCapability = AppCapability
export type DockBounds = AppDockBounds
export type DockMountContext = AppDockMountContext
type DockItemPlacement = AppDockItemPlacement
export type DockItem = AppDockItem & { pluginID?: string }
export type SlotItem = Omit<AppSlotItem, "slot"> & { pluginID?: string; slot: UISlotID }
export type ToolbarItem = AppToolbarItem & { pluginID?: string }
export type LoadingOverlayOptions = AppLoadingOverlayOptions
type LoadingOverlay = LoadingOverlayOptions & { id: string; pluginID: string; createdAt: number }
export type SettingsField = AppSettingsField
export type SettingsItem = AppSettingsItem & { pluginID?: string }

export type ModelTargetSettingsField = {
  key: string
  label: string
  description?: string
  default: string
  filter?: SettingsModelChainPickerFilter
  required?: boolean
  autoSelectSingle?: boolean
  autoSelectDefault?: boolean
}

/**
 * Every model target setting Ã¢â‚¬â€ legacy `model`, legacy `model-chain`, and the
 * current `model-target` Ã¢â‚¬â€ renders through the same model-or-chain picker and
 * stores the same durable reference format.
 */
export function modelTargetSettingsField(field: SettingsField): ModelTargetSettingsField | undefined {
  if (field.type !== "model" && field.type !== "model-chain" && field.type !== "model-target") return
  return {
    key: field.key,
    label: field.label,
    description: field.description,
    default: field.default,
    filter: field.filter,
    ...(field.type === "model" ? {} : { required: field.required }),
    ...(field.type === "model" ? {} : { autoSelectSingle: field.autoSelectSingle }),
    ...(field.type === "model" ? {} : { autoSelectDefault: field.autoSelectDefault }),
  }
}

export type AutomationItem = AppAutomationItem & { pluginID?: string }
export type RouteItem = AppRouteItem & { pluginID?: string }

export type DockZone = {
  visible: boolean
  size: number
  tabs: string[]
  activeItem?: string
}

export type DockLayoutMode = "desktop-grid" | "mobile-stack"

export type CustomPartRenderer = (input: { part: CustomPart }) => JSX.Element | null | undefined

type PluginManifest = {
  id: string
  displayName: string
  spec: string
  version: string
  module: string
  hash: string
  capabilities: AppPluginCapability[]
  ai: { tools: string[] }
}

type State = {
  dockItems: Record<string, DockItem>
  slotItems: Record<string, SlotItem>
  toolbarItems: Record<string, ToolbarItem>
  loadingOverlays: Record<string, LoadingOverlay>
  settingsItems: Record<string, SettingsItem>
  automationItems: Record<string, AutomationItem>
  routeItems: Record<string, RouteItem>
  commands: Record<string, CommandOption>
  customPartRenderers: Record<string, CustomPartRenderer>
  zones: Record<DockArea, DockZone>
  layoutMode: DockLayoutMode
  scopes: Record<string, PluginScope>
  status: Record<string, AppPluginStatus>
}

const legacyCapabilities: AppPluginCapability[] = [
  "ui:dock",
  "ui:slots",
  "commands",
  "routes",
  "kv",
  "ui:toolbar",
  "ui:settings",
  "ui:loading",
  "ui:models",
  "client",
  "events",
  "chat:parts",
  "host:projects",
  "host:navigation",
  "host:sessions",
  "host:git",
  "host:http",
  "host:command",
  "automation",
]

const capabilities: AppPluginCapability[] = [
  ...legacyCapabilities,
  "ui:overlay",
  "ui:floating",
  "host:ai",
  "host:images",
  "host:stt",
  "host:tts",
  "host:audio",
  "host:composer",
  "host:toolbar",
  "host:session-policy",
  "host:session-context",
  "host:session-attention",
  "host:session-attention-read",
  "host:skills",
  "host:skill-content",
  "host:text-input",
  "host:desktop-services",
]
const knownCapabilities = new Set(capabilities)

const defaultZone = (size: number, visible = false): DockZone => ({
  visible,
  size,
  tabs: [],
})

type AppPluginRuntime = {
  dockItems: Accessor<DockItem[]>
  slotItems: (slot: UISlotID) => SlotItem[]
  toolbarItems: Accessor<ToolbarItem[]>
  toolbarItemsForDirectory: (directory?: string) => ToolbarItem[]
  toolbarVisibilityReady: Accessor<boolean>
  toolbarOrderReady: Accessor<boolean>
  toolbarItemOrder: (directory?: string) => string[]
  toolbarItemVisible: (id: string, directory?: string) => boolean
  toolbarItemArmed: (id: string, context: ToolbarContext) => boolean | undefined
  globalToolbarItemVisible: (id: string) => boolean
  toolbarItemOverride: (id: string, directory: string) => ToolbarVisibilityOverride
  setGlobalToolbarItemVisible: (id: string, visible: boolean) => void
  setToolbarItemOverride: (id: string, directory: string, value: ToolbarVisibilityOverride) => void
  toolbarItemCanMove: (id: string, direction: "up" | "down", directory?: string) => boolean
  moveToolbarItem: (id: string, direction: "up" | "down", directory?: string) => void
  resetToolbarItemOverrides: (directory: string) => void
  activeLoadingOverlay: Accessor<LoadingOverlay | undefined>
  settingsItems: Accessor<SettingsItem[]>
  automationItems: Accessor<AutomationItem[]>
  settingValue: <T>(pluginID: string, key: string, fallback: T) => T
  setSettingValue: (pluginID: string, key: string, value: unknown) => void
  routeItems: Accessor<RouteItem[]>
  status: Accessor<AppPluginStatus[]>
  openDockItem: (id: string, placement?: DockItemPlacement) => void
  closeDockItem: (id: string) => void
  invokeToolbarItem: (id: string, input?: Partial<ToolbarContext>) => Promise<void>
  runAutomationItem: (pluginID: string, actionID: string, input?: unknown) => Promise<unknown>
  refresh: () => void
  customPartRenderer: (part: CustomPart) => JSX.Element | null | undefined
  registerDockItem: (item: DockItem) => () => void
  registerSlotItem: (item: SlotItem) => () => void
  registerToolbarItem: (item: ToolbarItem) => () => void
  registerAutomationItem: (item: AutomationItem) => () => void
  showLoadingOverlay: (pluginID: string, scope: PluginScope, input: LoadingOverlayOptions) => { close(): void }
  registerSettingsItem: (item: SettingsItem) => () => void
  registerRouteItem: (item: RouteItem) => () => void
  registerCustomPartRenderer: (kind: string, renderer: CustomPartRenderer) => () => void
  createScope: (id: string) => PluginScope
  disposeScope: (id: string) => Promise<void>
}

const context = createSimpleContext<AppPluginRuntime, {}>({
  name: "AppPluginRuntime",
  init: createAppPluginRuntime,
  gate: false,
})

export const AppPluginRuntimeProvider = context.provider
export const useAppPluginRuntime = context.use

function normalizeItem(item: DockItem): DockItem {
  return {
    ...item,
    allowedAreas: item.allowedAreas?.length ? Array.from(new Set(item.allowedAreas)) : undefined,
  }
}

function allowedArea(item: DockItem, area: DockArea | undefined) {
  if (!area) return item.defaultArea
  if (!item.allowedAreas?.length) return area
  return item.allowedAreas.includes(area) ? area : item.defaultArea
}

function zoneWithItem(zone: DockZone, item: DockItem): DockZone {
  if (zone.tabs.includes(item.id)) return zone
  return {
    ...zone,
    tabs: [...zone.tabs, item.id],
    activeItem: zone.activeItem ?? item.id,
  }
}

function zoneWithoutItem(zone: DockZone, id: string): DockZone {
  const tabs = zone.tabs.filter((item) => item !== id)
  return {
    ...zone,
    tabs,
    activeItem: zone.activeItem === id ? tabs[0] : zone.activeItem,
  }
}

function scopedID(pluginID: string, id: string, separator = "/") {
  if (id.startsWith(`${pluginID}${separator}`)) return id
  return `${pluginID}${separator}${id}`
}

function requireLoadingTimeout(input: LoadingOverlayOptions) {
  if (Number.isFinite(input.timeoutMs) && input.timeoutMs > 0) return input.timeoutMs
  throw new Error("Plugin loading overlays require a positive timeoutMs")
}

function readManifest(value: unknown): PluginManifest[] {
  if (!value || typeof value !== "object") return []
  const list = "plugins" in value && Array.isArray(value.plugins) ? value.plugins : []
  return list.flatMap((item): PluginManifest[] => {
    if (!item || typeof item !== "object") return []
    if (
      "id" in item &&
      typeof item.id === "string" &&
      "spec" in item &&
      typeof item.spec === "string" &&
      "version" in item &&
      typeof item.version === "string" &&
      "module" in item &&
      typeof item.module === "string" &&
      "hash" in item &&
      typeof item.hash === "string"
    ) {
      const manifest = item as Record<string, unknown>
      return [
        {
          id: item.id,
          displayName: pluginDisplayName(item.id, manifest.displayName),
          spec: item.spec,
          version: item.version,
          module: item.module,
          hash: item.hash,
          capabilities: readCapabilityList(manifest.capabilities) ?? legacyCapabilities,
          ai: { tools: readStringList(isRecord(manifest.ai) ? manifest.ai.tools : undefined) ?? [] },
        },
      ]
    }
    return []
  })
}

function pluginManifestIdentity(plugin: PluginManifest) {
  return JSON.stringify([
    plugin.id,
    plugin.spec,
    plugin.version,
    plugin.module,
    plugin.hash,
    plugin.capabilities,
    plugin.ai.tools,
  ])
}

function readCapabilityList(value: unknown) {
  return readStringList(value)?.filter(
    (item): item is AppPluginCapability =>
      knownCapabilities.has(item as AppPluginCapability) || /^services:[^:]+:[a-zA-Z0-9._-]+$/.test(item),
  )
}

function readStringList(value: unknown) {
  if (!Array.isArray(value)) return
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim())
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function parseModelKey(value: string | undefined) {
  if (!value) return
  const separator = value.indexOf("/")
  if (separator <= 0 || separator === value.length - 1) return
  return { providerID: value.slice(0, separator), modelID: value.slice(separator + 1) }
}

function stalePluginModuleError(error: unknown) {
  return error instanceof TypeError && error.message.includes("Failed to fetch dynamically imported module")
}

function errorDetails(error: unknown) {
  if (!isRecord(error)) return { name: "UnknownError", message: String(error), stack: undefined }
  return {
    name: typeof error.name === "string" ? error.name : "UnknownError",
    message: typeof error.message === "string" ? error.message : String(error),
    stack: typeof error.stack === "string" ? error.stack : undefined,
  }
}

function authHeaders(server: ServerConnection.HttpBase) {
  if (!server.password) return undefined
  return {
    Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`,
  }
}

function createScopedKV(pluginID: string): AppPluginApi["kv"] {
  const key = (input: string) => `opencode.app-plugin.${pluginID}.${input}`
  return {
    get(input, fallback) {
      if (typeof localStorage === "undefined") return fallback
      const raw = localStorage.getItem(key(input))
      if (raw === null) return fallback
      try {
        return JSON.parse(raw) as typeof fallback
      } catch {
        return fallback
      }
    },
    set(input, value) {
      if (typeof localStorage === "undefined") return
      localStorage.setItem(key(input), JSON.stringify(value))
    },
    delete(input) {
      if (typeof localStorage === "undefined") return
      localStorage.removeItem(key(input))
    },
  }
}

function pluginSettingKey(key: string) {
  return `settings.${key}`
}

function CustomPartMount(props: {
  part: CustomPart
  mount(context: {
    element: HTMLElement
    part: CustomPart
    signal: AbortSignal
  }): void | (() => void) | Promise<void | (() => void)>
}) {
  let root: HTMLDivElement | undefined
  let cleanup: (() => void) | undefined
  const [failed, setFailed] = createSignal(false)

  // Plugins render untrusted `part.data`. We pass only the element and the
  // sanitized part in Ã¢â‚¬â€ renderers MUST treat `part.data` as untrusted and
  // avoid `element.innerHTML` with values derived from it. Prefer
  // `element.textContent` or constructed DOM nodes.
  const sanitized = createMemo(() => sanitizeCustomPart(props.part))

  const dispose = () => {
    cleanup?.()
    cleanup = undefined
  }

  createEffect(() => {
    const element = root
    if (!element) return
    dispose()
    setFailed(false)
    cleanup = mountPluginElement({
      element,
      mount: (signal) => props.mount({ element, part: sanitized(), signal }),
      onError: (error) => {
        console.error("[app-plugin] custom part mount failed", { kind: sanitized().kind, error })
        setFailed(true)
      },
    })
  })

  onCleanup(dispose)

  return (
    <Show
      when={!failed()}
      fallback={
        <div class="rounded-md border border-border-weak-base bg-surface-panel px-3 py-2 text-13-regular text-text-weak">
          {sanitized().fallback ?? sanitized().kind}
        </div>
      }
    >
      <div ref={root} data-component="plugin-custom-part" data-kind={sanitized().kind} />
    </Show>
  )
}

export function AppPluginLoadingOverlay() {
  const plugins = useAppPluginRuntime()

  return (
    <Show when={plugins.activeLoadingOverlay()}>
      {(overlay) => (
        <div
          data-component="app-plugin-loading-overlay"
          data-plugin-id={overlay().pluginID}
          role="alert"
          aria-busy="true"
          aria-live="assertive"
          class="fixed inset-0 z-[10000] flex items-center justify-center bg-black/55 px-6 backdrop-blur-[1px]"
        >
          <div class="flex max-w-md flex-col items-center gap-3 rounded-xl border border-border-weak-base bg-surface-raised-stronger-non-alpha px-6 py-5 text-center text-text-base shadow-[var(--v2-elevation-raised)]">
            <Spinner class="size-6 text-text-base" />
            <div class="flex flex-col gap-1">
              <div class="text-14-medium">{overlay().title ?? "Working"}</div>
              <Show when={overlay().message}>
                {(message) => <div class="text-13-regular text-text-muted">{message()}</div>}
              </Show>
            </div>
          </div>
        </div>
      )}
    </Show>
  )
}

function createAppPluginRuntime(): AppPluginRuntime {
  const owner = getOwner()
  const dialog = useDialog()
  const command = useCommand()
  const layout = useLayout()
  const navigate = useNavigate()
  const platform = usePlatform()
  const server = useServer()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const models = useModels()
  const sessionFavorites = useSessionFavorites()
  const attention = useSessionAttention()
  const pickDirectory = useDirectoryPicker()
  const tabs = useTabs()
  const [searchParams] = useSearchParams<{ dir?: string }>()
  const [manifestRevision, setManifestRevision] = createSignal(0)
  let manifestGeneration = 0
  let manifestRetry = RetryBackoff.fresh()
  // A terminal manifest backoff switches to a slow probe rather than staying offline forever.
  const MANIFEST_RECOVERY_PROBE_MS = 60_000
  let manifestRetryFingerprint: string | undefined
  const retriedPluginVersions = new Set<string>()
  const loadedPlugins = new Map<string, { scopeKey: string; scope: PluginScope }>()
  const pluginOverlays = new Map<string, () => void>()
  const audioCapture = createAudioCaptureBroker((constraints) => navigator.mediaDevices.getUserMedia(constraints))
  window.addEventListener("pagehide", audioCapture.dispose)
  onCleanup(() => {
    window.removeEventListener("pagehide", audioCapture.dispose)
    audioCapture.dispose()
  })
  // Remote serves plugin modules and project APIs over the same HTTP/1 origin.
  // Bound imports while allowing each loaded plugin to initialize independently.
  const moduleLoader = createPluginModuleLoader(2)
  const [store, setStore] = createStore<State>({
    dockItems: {},
    slotItems: {},
    toolbarItems: {},
    loadingOverlays: {},
    settingsItems: {},
    automationItems: {},
    routeItems: {},
    commands: {},
    customPartRenderers: {},
    zones: {
      top: defaultZone(180),
      left: defaultZone(280),
      middle: defaultZone(0, true),
      right: defaultZone(360),
      bottom: defaultZone(260),
    },
    layoutMode: "desktop-grid",
    scopes: {},
    status: {},
  })
  const [toolbarVisibility, setToolbarVisibility, , toolbarVisibilityReady] = persisted(
    Persist.global("plugin-toolbar-visibility"),
    createStore<ToolbarVisibilityState>({ version: 1, global: {}, projects: {} }),
  )
  const [toolbarOrder, setToolbarOrder, , toolbarOrderReady] = persisted(
    Persist.global("plugin-toolbar-order"),
    createStore<ToolbarOrderState>({ version: 1, global: [], projects: {} }),
  )

  const dockItems = createMemo(() => Object.values(store.dockItems))
  const projectKey = (directory: string) => toolbarProjectKey(server.key, directory)
  const toolbarItemOrder = (directory?: string) => {
    if (!toolbarOrderReady()) return []
    if (!directory) return toolbarOrder.global
    return toolbarOrder.projects[projectKey(directory)] ?? toolbarOrder.global
  }
  const toolbarItemsForDirectory = (directory?: string) =>
    orderToolbarItems(Object.values(store.toolbarItems), toolbarItemOrder(directory))
  const toolbarItems = createMemo(() => toolbarItemsForDirectory())
  const toolbarDefaultVisible = (id: string) => store.toolbarItems[id]?.defaultVisible ?? false
  const isToolbarItemVisible = (id: string, directory?: string) =>
    toolbarVisibilityReady() &&
    toolbarItemVisible(toolbarVisibility, id, directory ? projectKey(directory) : undefined, toolbarDefaultVisible(id))
  const setGlobalToolbarItemVisible = (id: string, visible: boolean) => {
    if (!toolbarVisibilityReady()) return
    setToolbarVisibility("global", id, visible)
  }
  const setToolbarItemOverride = (id: string, directory: string, value: ToolbarVisibilityOverride) => {
    if (!toolbarVisibilityReady()) return
    const project = projectKey(directory)
    if (value !== "inherit") {
      if (!toolbarVisibility.projects[project]) setToolbarVisibility("projects", project, {})
      setToolbarVisibility("projects", project, id, value === "show")
      return
    }
    setToolbarVisibility(
      "projects",
      project,
      produce((draft) => {
        delete draft[id]
      }),
    )
  }
  const moveToolbarItem = (id: string, direction: "up" | "down", directory?: string) => {
    if (!toolbarOrderReady()) return
    const order = moveToolbarItemIDs(toolbarItemsForDirectory(directory), id, direction)
    if (!directory) {
      setToolbarOrder("global", order)
      return
    }
    setToolbarOrder("projects", projectKey(directory), order)
  }
  const toolbarItemCanMove = (id: string, direction: "up" | "down", directory?: string) => {
    const items = toolbarItemsForDirectory(directory)
    return moveToolbarItemIDs(items, id, direction).some((value, index) => value !== items[index]?.id)
  }
  const resetToolbarItemOverrides = (directory: string) => {
    if (!toolbarVisibilityReady()) return
    setToolbarVisibility(
      "projects",
      produce((draft) => {
        delete draft[projectKey(directory)]
      }),
    )
    if (!toolbarOrderReady()) return
    setToolbarOrder(
      "projects",
      produce((draft) => {
        delete draft[projectKey(directory)]
      }),
    )
  }
  const activeLoadingOverlay = createMemo(() =>
    Object.values(store.loadingOverlays)
      .toSorted((a, b) => a.createdAt - b.createdAt)
      .at(-1),
  )
  const settingsItems = createMemo(() =>
    Object.values(store.settingsItems).toSorted((a, b) => a.title.localeCompare(b.title)),
  )
  const automationItems = createMemo(() =>
    Object.values(store.automationItems).toSorted((a, b) => a.title.localeCompare(b.title)),
  )
  const routeItems = createMemo(() => Object.values(store.routeItems))
  const status = createMemo(() => Object.values(store.status))
  const routeDirectory = () => {
    const route = layout.route()
    if (route.type === "session" || route.type === "dir-new-session") return route.dir
  }
  const activePluginDirectories = createMemo(() =>
    resolveActivePluginDirectories({ tabs: tabs.store, routeDirectory: routeDirectory(), server: server.key }),
  )
  const activePluginDirectory = createMemo(() => {
    const directory = routeDirectory()
    if (directory) return directory
    const pendingDirectory = searchParams.dir ? decode64(searchParams.dir) : undefined
    if (pendingDirectory) return pendingDirectory
    const tab = tabs.active()
    if (!tab || tab.server !== server.key) return
    return pluginTabDirectory(tab)
  })
  const activeServerFingerprint = createMemo(() => {
    const conn = server.current
    if (!conn) return ""
    return [
      ServerConnection.key(conn),
      conn.http.url,
      conn.http.username ?? "",
      conn.http.password ?? "",
      activePluginDirectory() ?? "",
    ].join("\n")
  })

  command.register("app-plugins", () => Object.values(store.commands))

  const registerDockItem = (input: DockItem) => {
    const item = normalizeItem(input)
    const currentArea = untrack(() => layout.dock.item(item.id).area())
    const area = allowedArea(item, currentArea)
    layout.dock.ensureItem(item.id, area, false)
    if (currentArea && currentArea !== area) layout.dock.setItemArea(item.id, area)
    setStore(
      produce((draft) => {
        draft.dockItems[item.id] = item
        draft.zones[area] = zoneWithItem(draft.zones[area], item)
      }),
    )
    return () => {
      setStore(
        produce((draft) => {
          delete draft.dockItems[item.id]
          for (const area of Object.keys(draft.zones) as DockArea[]) {
            draft.zones[area] = zoneWithoutItem(draft.zones[area], item.id)
          }
        }),
      )
    }
  }

  const openDockItem = (id: string, placement?: DockItemPlacement) => {
    const item = store.dockItems[id]
    if (!item) return
    const area = allowedArea(item, placement?.area ?? layout.dock.item(id).area())
    layout.dock.request(id, { area, reveal: placement?.reveal })
    if (placement?.reveal !== false)
      queueMicrotask(() => {
        if (!layout.dock.item(id).visible() || layout.dock.item(id).area() !== area) return
        layout.dock.setActive(area, id)
      })
    window.dispatchEvent(new CustomEvent("opencode:dock-resize", { detail: { area, active: id } }))
  }

  const closeDockItem = (id: string) => {
    const area = layout.dock.item(id).area()
    layout.dock.setItemVisible(id, false)
    if (area) window.dispatchEvent(new CustomEvent("opencode:dock-resize", { detail: { area, active: id } }))
  }

  const moveDockItem = (id: string, area: DockArea) => {
    const item = store.dockItems[id]
    if (!item) return
    const next = allowedArea(item, area)
    layout.dock.setItemArea(id, next)
    layout.dock.setItemVisible(id, true)
    layout.dock.setVisible(next, true)
    layout.dock.setActive(next, id)
    window.dispatchEvent(new CustomEvent("opencode:dock-resize", { detail: { area: next, active: id } }))
  }

  const registerSlotItem = (item: SlotItem) => {
    if (!isUISlotID(item.slot)) {
      console.warn("[app-plugin] ignored unknown UI slot", { id: item.id, slot: item.slot })
      return () => {}
    }
    setStore("slotItems", item.id, item)
    return () => {
      setStore(
        "slotItems",
        produce((draft) => {
          delete draft[item.id]
        }),
      )
    }
  }

  const toolbarItemOwners = new Map<string, PluginScope>()
  const appendOnSubmit = createAppendOnSubmitStore()
  const [appendRevision, setAppendRevision] = createSignal(0)
  const [composerRevision, setComposerRevision] = createSignal(0)
  onCleanup(composerRegistry.subscribe(() => setComposerRevision((value) => value + 1)))
  onCleanup(appendOnSubmit.subscribe(() => setAppendRevision((value) => value + 1)))
  onCleanup(composerRegistry.registerFinalAppend(createToolbarFinalAppend(appendOnSubmit)))
  const standardToolbarItems = new Set<string>()
  const standardToolbarAvailability = new Map<string, (context: ToolbarContext) => boolean>()
  createEffect(() => {
    appendRevision()
    appendOnSubmit.prune(
      (id, target) =>
        target.serverID !== server.key ||
        (standardToolbarAvailability.get(id)?.({ ...target, placement: "composer", align: "right" }) ?? false),
    )
  })
  const toolbarItemArmed = (id: string, context: ToolbarContext) => {
    appendRevision()
    if (!standardToolbarItems.has(id)) return undefined
    const resolved = resolveAppendOnSubmitTarget(server.key, context)
    return "error" in resolved ? false : appendOnSubmit.armed(id, resolved.target)
  }
  const registerToolbarItem = (
    item: ToolbarItem,
    owner?: PluginScope,
    policy?: { serverID: string; active(): boolean },
  ) => {
    if (item.appendOnSubmit === true && !item.run && !item.mount) {
      const target = appendOnSubmitTarget(item)
      if ("error" in target || !policy || toolbarPlacement(item) !== "composer") {
        console.warn("[app-plugin] invalid appendOnSubmit item (requires one target and composer placement)", {
          id: item.id,
          target,
        })
        return () => {}
      }
      const original = item
      standardToolbarAvailability.set(
        item.id,
        (context) =>
          policy.active() &&
          isToolbarItemVisible(original.id, context.directory) &&
          original.visible?.(context) !== false &&
          toolbarItemEnabled(original, context),
      )
      const available = (context: ToolbarContext) => {
        // Toolbar outlets may mount before the editor's registration effect.
        composerRevision()
        const resolved = resolveAppendOnSubmitTarget(policy.serverID, context)
        return (
          policy.active() &&
          server.key === policy.serverID &&
          !("error" in resolved) &&
          !!composerRegistry.read(resolved.target) &&
          toolbarItemEnabled(original, context)
        )
      }
      item = {
        ...original,
        kind: "icon",
        tooltip: original.command
          ? `${original.tooltip ?? original.title}\nCommand reference only; does not dispatch the command template.`
          : (original.tooltip ?? original.title),
        enabled: available,
        run(context) {
          if (
            !available(context) ||
            !isToolbarItemVisible(original.id, context.directory) ||
            original.visible?.(context) === false
          )
            throw new Error("Toolbar toggle is unavailable for this composer")
          const resolved = resolveAppendOnSubmitTarget(policy.serverID, context)
          if ("error" in resolved) throw new Error(resolved.error)
          appendOnSubmit.toggle(original.id, resolved.target, target.token)
        },
      }
      standardToolbarItems.add(item.id)
    }
    setStore("toolbarItems", item.id, item)
    if (owner) toolbarItemOwners.set(item.id, owner)
    return () => {
      if (owner && toolbarItemOwners.get(item.id) !== owner) return
      toolbarItemOwners.delete(item.id)
      standardToolbarItems.delete(item.id)
      standardToolbarAvailability.delete(item.id)
      appendOnSubmit.remove(item.id)
      setStore(
        "toolbarItems",
        produce((draft) => {
          delete draft[item.id]
        }),
      )
    }
  }

  const registerAutomationItem = (item: AutomationItem) => {
    setStore("automationItems", item.id, item)
    return () => {
      setStore(
        "automationItems",
        produce((draft) => {
          delete draft[item.id]
        }),
      )
    }
  }

  const invokeToolbarItem = async (id: string, input?: Partial<ToolbarContext>) => {
    const item = store.toolbarItems[id]
    if (!item?.run) throw new Error(`Toolbar item not found: ${id}`)
    const route = layout.route()
    const context = {
      placement: input?.placement ?? toolbarPlacement(item),
      align: input?.align ?? toolbarAlign(item),
      directory:
        input?.directory ?? (route.type === "session" || route.type === "dir-new-session" ? route.dir : undefined),
      sessionID: input?.sessionID ?? (route.type === "session" ? route.sessionId : undefined),
      composerID: input?.composerID,
    } satisfies ToolbarContext
    if (!isToolbarItemVisible(id, context.directory) || item.visible?.(context) === false)
      throw new Error(`Toolbar item is not visible: ${id}`)
    if (!toolbarItemEnabled(item, context)) throw new Error(`Toolbar item is disabled: ${id}`)
    await item.run(context)
  }

  const runAutomationItem = async (pluginID: string, actionID: string, input?: unknown) => {
    const id = scopedID(pluginID, actionID)
    const item = store.automationItems[id]
    if (!item) throw new Error(`Automation action not found: ${id}`)
    return item.run(input)
  }

  const showLoadingOverlay = (pluginID: string, scope: PluginScope, input: LoadingOverlayOptions) => {
    const timeoutMs = requireLoadingTimeout(input)
    const id = scopedID(pluginID, `loading.${Date.now()}.${Math.random().toString(36).slice(2)}`)
    setStore("loadingOverlays", id, {
      id,
      pluginID,
      title: input.title,
      message: input.message,
      timeoutMs,
      createdAt: Date.now(),
    })

    let closed = false
    let timeout: number | undefined
    const close = trackPluginScope(scope, () => {
      if (closed) return
      closed = true
      if (timeout) window.clearTimeout(timeout)
      setStore(
        "loadingOverlays",
        produce((draft) => {
          delete draft[id]
        }),
      )
    })
    timeout = window.setTimeout(close, timeoutMs)
    return { close }
  }

  const openPluginOverlay = (pluginID: string, scope: PluginScope, input: AppOverlayOptions) => {
    const id = scopedID(pluginID, input.id)
    pluginOverlays.get(id)?.()
    // Settings actions run inside the host modal. A body-level overlay would
    // sit behind its backdrop and outside its focus trap. Use the same dialog
    // stack for this handoff instead of competing z-indices or synthetic clicks.
    if (dialog.active) {
      const controller = new AbortController()
      const content = document.createElement("div")
      content.dataset.component = "app-plugin-overlay-content"
      const mounted: { dispose?: () => void; dialogID?: string } = {}
      const close = trackPluginScope(scope, () => {
        if (controller.signal.aborted) return
        abortPluginWork(controller)
        mounted.dispose?.()
        pluginOverlays.delete(id)
        if (mounted.dialogID && dialog.active?.id === mounted.dialogID) dialog.close()
      })
      pluginOverlays.set(id, close)
      void dialog.show(() => {
        onCleanup(close)
        onMount(() => queueMicrotask(() => {
          if (!content.isConnected) return
          mounted.dialogID = dialog.active?.id
          if (controller.signal.aborted) { dialog.close(); return }
          void Promise.resolve(input.mount({ element: content, signal: controller.signal, close }))
            .then((dispose) => {
              if (typeof dispose !== "function") return
              if (controller.signal.aborted) return void dispose()
              mounted.dispose = dispose
            })
            .catch((error) => {
              if (!controller.signal.aborted) content.textContent = error instanceof Error ? error.message : "Plugin overlay failed to render"
            })
        }))
        return <Dialog title={input.title} size="large"><div data-component="app-plugin-overlay" data-plugin-id={pluginID} data-overlay-id={input.id}
          style={{ width: "100%", "min-height": "0", flex: "1", overflow: "auto", "overscroll-behavior": "contain", "scrollbar-gutter": "stable" }}
        >{content}</div></Dialog>
      }, close)
      return { close }
    }
    const controller = new AbortController()
    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    const previousFocus =
      activeElement && activeElement !== document.body
        ? activeElement
        : Array.from(document.querySelectorAll<HTMLElement>("[data-plugin-toolbar-item]:disabled")).find((element) =>
            element.dataset.pluginToolbarItem?.startsWith(`${pluginID}/`),
          )
    const backdrop = document.createElement("div")
    const panel = document.createElement("section")
    const header = document.createElement("header")
    const title = document.createElement("h2")
    const closeButton = document.createElement("button")
    const content = document.createElement("div")
    const mounted: { dispose?: () => void } = {}
    backdrop.dataset.component = "app-plugin-overlay"
    backdrop.dataset.pluginId = pluginID
    backdrop.dataset.overlayId = input.id
    backdrop.style.cssText =
      "position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:16px;background:rgba(0,0,0,.58);backdrop-filter:blur(5px)"
    panel.setAttribute("role", "dialog")
    panel.setAttribute("aria-modal", "true")
    panel.setAttribute("aria-label", input.ariaLabel ?? input.title)
    panel.style.cssText =
      "display:flex;flex-direction:column;width:min(720px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:hidden;border:1px solid var(--border-base,#3a3a3a);border-radius:16px;background:var(--background-base,#171717);color:var(--text-strong,#f4f4f4);box-shadow:0 24px 80px rgba(0,0,0,.55)"
    header.style.cssText =
      "display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 18px;border-bottom:1px solid var(--border-base,#3a3a3a)"
    title.textContent = input.title
    title.style.cssText = "margin:0;font:600 16px/1.3 system-ui,sans-serif"
    closeButton.type = "button"
    closeButton.textContent = "Close"
    closeButton.setAttribute("aria-label", `Close ${input.title}`)
    closeButton.style.cssText =
      "border:1px solid var(--border-base,#555);border-radius:9px;padding:7px 11px;background:transparent;color:inherit;cursor:pointer"
    content.dataset.component = "app-plugin-overlay-content"
    content.style.cssText = "min-height:0;overflow:auto;padding:18px"
    header.append(title, closeButton)
    panel.append(header, content)
    backdrop.append(panel)
    document.body.append(backdrop)

    const close = trackPluginScope(scope, () => {
      if (controller.signal.aborted) return
      abortPluginWork(controller)
      mounted.dispose?.()
      pluginOverlays.delete(id)
      backdrop.remove()
      queueMicrotask(() => previousFocus?.focus())
    })
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      close()
    }
    controller.signal.addEventListener("abort", () => document.removeEventListener("keydown", onKeyDown), {
      once: true,
    })
    document.addEventListener("keydown", onKeyDown)
    closeButton.addEventListener("click", close)
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) close()
    })
    pluginOverlays.set(id, close)
    queueMicrotask(() => closeButton.focus())
    void Promise.resolve(input.mount({ element: content, signal: controller.signal, close }))
      .then((dispose) => {
        if (typeof dispose !== "function") return
        if (controller.signal.aborted) return void dispose()
        mounted.dispose = dispose
      })
      .catch((error) => {
        if (controller.signal.aborted) return
        content.textContent = error instanceof Error ? error.message : "Plugin overlay failed to render"
      })
    return { close }
  }

  const registerSettingsItem = (item: SettingsItem) => {
    setStore("settingsItems", item.id, item)
    const unsubscribe = item.storage?.subscribe(() => dispatchAppPluginSettingsItemChanged(item.pluginID ?? item.id))
    return () => {
      unsubscribe?.()
      setStore(
        "settingsItems",
        produce((draft) => {
          delete draft[item.id]
        }),
      )
    }
  }

  const registerRouteItem = (item: RouteItem) => {
    setStore("routeItems", item.id, item)
    return () => {
      setStore(
        "routeItems",
        produce((draft) => {
          delete draft[item.id]
        }),
      )
    }
  }

  const registerCustomPartRenderer = (kind: string, renderer: CustomPartRenderer) => {
    setStore("customPartRenderers", kind, () => renderer)
    return () => {
      setStore(
        "customPartRenderers",
        produce((draft) => {
          delete draft[kind]
        }),
      )
    }
  }

  const registerCommandOption = (input: PluginCommandInput) => {
    const dispose = () => {
      setStore(
        "commands",
        produce((draft) => {
          delete draft[input.id]
        }),
      )
    }
    setStore("commands", input.id, createPluginCommandOption(input))
    return dispose
  }

  const hostProjects = (): AppHostProject[] =>
    layout.projects.list().map((project) => ({
      id: project.id ?? project.worktree,
      projectID: project.id === "global" ? undefined : project.id,
      worktree: project.worktree,
      sessionDirectories: [...new Set([
        project.worktree,
        ...(project.aliases ?? []),
        ...(project.sessionDirectories ?? []),
      ])],
      name: project.name || project.worktree.split(/[\\/]/).filter(Boolean).at(-1) || project.worktree,
      icon: project.icon
        ? {
            url: project.icon.url,
            override: project.icon.override,
            color: project.icon.color,
            generated: safeGeneratedProjectIcon(project.icon.generated),
          }
        : undefined,
      iconGeneration: project.iconGeneration ? { status: project.iconGeneration.status } : undefined,
    }))

  const hostProjectsSnapshot = (projects: AppHostProject[]) =>
    projects
      .map((project) =>
        [
          project.id,
          project.projectID ?? "",
          project.worktree,
          JSON.stringify(project.sessionDirectories),
          project.name,
          project.icon?.url ?? "",
          project.icon?.override ?? "",
          project.icon?.color ?? "",
          project.icon?.generated ?? "",
          project.iconGeneration?.status ?? "",
        ].join("\x00"),
      )
      .join("\x01")

  const safeGeneratedProjectIcon = (value: string | undefined) => {
    if (!value || value.length > 512 * 1024) return undefined
    return /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(value) ? value : undefined
  }

  const sessionStatusDirectories = createMemo(() => {
    const directories = new Set(activePluginDirectories())
    for (const project of hostProjects()) directories.add(project.worktree)
    for (const favorite of sessionFavorites.byServer(server.key)) directories.add(favorite.directory)
    return [...directories].filter((directory) => serverSync().existing(directory))
  })

  const hostNavigationSnapshot = (navigation: AppHostNavigationState) =>
    [navigation.directory ?? "", navigation.sessionID ?? ""].join("\x00")

  const hostNavigationFromEvent = (event: Event) => {
    const detail = event instanceof CustomEvent && event.detail && typeof event.detail === "object" ? event.detail : {}
    return {
      directory: typeof detail.directory === "string" ? detail.directory : undefined,
      sessionID: typeof detail.sessionID === "string" ? detail.sessionID : undefined,
    } satisfies AppHostNavigationState
  }

  const normalizeDirectorySelection = (result: string | string[] | null) => {
    if (Array.isArray(result)) return result.filter(Boolean)
    return result ? [result] : []
  }

  const openHostProject = (directory?: string) => {
    if (directory) {
      void layout.projects.register(directory)
      return
    }
    const current = server.current
    if (!current) return
    pickDirectory({
      server: current,
      title: "Open project",
      multiple: true,
      onSelect: (result) => normalizeDirectorySelection(result).forEach((directory) => void layout.projects.register(directory)),
    })
  }

  const currentNavigation = (): AppHostNavigationState => {
    const route = layout.route()
    if (route.type === "home") {
      // Route params collapse to "home" while a draft tab (new empty session)
      // is active, but that tab still describes where plugin host APIs and
      // shortcuts should operate.
      return navigationFromTab(tabs.active())
    }
    if (route.type === "session") {
      return {
        directory: route.dir,
        sessionID: route.sessionId,
      }
    }
    if (route.type === "dir-new-session") {
      return {
        directory: route.dir,
      }
    }
    return navigationFromTab(tabs.active())
  }

  const navigationFromTab = (tab?: Tab): AppHostNavigationState => {
    if (!tab || tab.server !== server.key) return {}
    if (tab.type === "draft") return { directory: tab.directory }
    return { directory: atob(tab.dirBase64), sessionID: tab.sessionId }
  }

  const sessionLifecycleStatus = (
    input: { directory: string; sessionID: string },
    store: Parameters<typeof sessionIsWorking>[0] & {
      session_status: Record<string, { type: string } | undefined>
    },
  ) =>
    resolveLifecycleStatus({
      activity: sessionActivity(input.directory, input.sessionID)?.type,
      activityTracked: latestAssistantCompletedBefore(
        store, input.sessionID, sessionActivityStartedAt(input.directory, input.sessionID),
      ),
      activitySettled: sessionActivitySettled(input.directory, input.sessionID),
      store: store.session_status[input.sessionID]?.type,
      latestAssistantSettled: latestAssistantSettled(store, input.sessionID),
    })

  const sessionWorking = (input: { directory: string; sessionID: string }) => {
    const store = serverSync().existing(input.directory)?.[0]
    if (!store) return false
    return sessionIsWorking(
      store,
      input.sessionID,
      sessionLifecycleStatus(input, store),
      sessionActivitySettled(input.directory, input.sessionID),
    )
  }

  const sessionStatus = (input: { directory: string; sessionID: string }): AppHostSessionStatus | undefined => {
    const store = serverSync().existing(input.directory)?.[0]
    const lifecycleStatus = store ? sessionLifecycleStatus(input, store) : undefined
    return resolveSessionStatus({
      working: sessionWorking(input),
      question: !!store?.question[input.sessionID]?.length,
      status: lifecycleStatus,
      turnCompletion:
        store?.turnCompletion[input.sessionID] ?? serverSync().turnCompletion.get(input.directory, input.sessionID),
    })
  }

  const activeSessions = () =>
    sessionStatusDirectories().flatMap((directory) => {
      const store = serverSync().existing(directory)?.[0]
      if (!store) return []
      return [
        ...new Set([
          ...store.session.map((session) => session.id),
          ...Object.keys(store.session_status),
          ...Object.keys(store.message),
        ]),
      ]
        .filter((sessionID) => sessionWorking({ directory, sessionID }))
        .map((sessionID) => {
          const session = store.session.find((item) => item.id === sessionID)
          return {
            directory,
            id: sessionID,
            parentID: session?.parentID,
            title: session?.title,
            slug: session?.slug,
            time: session?.time,
          }
        })
    })

  const sessionStatusSnapshot = () =>
    sessionStatusDirectories()
      .map((directory) => {
        const store = serverSync().existing(directory)?.[0]
        if (!store) return ""
        const sessionIDs = new Set([
          ...store.session.map((session) => session.id),
          ...Object.keys(store.session_status),
          ...Object.keys(store.question),
          ...Object.keys(store.turnCompletion),
        ])
        return [...sessionIDs]
          .map(
            (id) =>
              `${directory}\n${id}\n${store.session_status[id]?.type ?? "idle"}\n${sessionStatus({ directory, sessionID: id }) ?? ""}`,
          )
          .join("\n")
      })
      .join("\n")

  const hostFavorite = (favorite: SessionFavorite): AppHostSessionFavorite => ({
    directory: favorite.directory,
    id: favorite.id,
    parentID: favorite.parentID,
    title: favorite.title,
    slug: favorite.slug,
    time: favorite.time,
  })

  const sessionFavorite = (key: ServerConnection.Key, favorite: AppHostSessionFavorite): SessionFavorite => ({
    server: key,
    directory: favorite.directory,
    id: favorite.id,
    parentID: favorite.parentID,
    title: favorite.title,
    slug: favorite.slug,
    time: favorite.time,
  })

  const hostFavorites = (key: ServerConnection.Key) => sessionFavorites.byServer(key).map(hostFavorite)

  const dockPaneIdForTab = (tab: Tab) => `tab:${base64Encode(tabKey(tab))}`

  const navigateToSession = (directory: string, sessionID: string, area?: DockArea) => {
    layout.projects.open(directory)
    const tab = {
      type: "session" as const,
      server: server.key,
      dirBase64: base64Encode(directory),
      sessionId: sessionID,
    }
    const opened = tabs.openSessionTab(tab, { activate: false })
    if (!opened) return
    if (area) {
      const paneID = dockPaneIdForTab(opened)
      layout.dock.moveItem(paneID, area)
      layout.dock.setItemVisible(paneID, true)
      layout.dock.setVisible(area, true)
      layout.dock.setActive(area, paneID)
      window.dispatchEvent(new CustomEvent("opencode:dock-resize", { detail: { area, active: paneID } }))
    }
    tabs.select(opened)
  }

  const navigateToNewSession = (directory: string, area?: DockArea) => {
    layout.projects.open(directory)
    const draftID = tabs.newDraft({ server: server.key, directory }, undefined, { navigate: false })
    const tab = tabs.draft(draftID)
    if (area) {
      const paneID = dockPaneIdForTab(tab)
      layout.dock.moveItem(paneID, area)
      layout.dock.setItemVisible(paneID, true)
      layout.dock.setVisible(area, true)
      layout.dock.setActive(area, paneID)
      window.dispatchEvent(new CustomEvent("opencode:dock-resize", { detail: { area, active: paneID } }))
    }
    tabs.select(tab)
  }

  const settingValue = <T,>(pluginID: string, key: string, fallback: T): T =>
    createScopedKV(pluginID).get(pluginSettingKey(key), fallback)

  const setSettingValue = (pluginID: string, key: string, value: unknown) => {
    createScopedKV(pluginID).set(pluginSettingKey(key), value)
    dispatchAppPluginSettingsChanged(pluginID, key)
  }

  createEffect(() => {
    if (!models.ready()) return
    const chains = models.chain.list()
    const chainIDs = chains.map((chain) => chain.id)
    const available = models.list().map((model) => ({
      providerID: model.provider.id,
      modelID: model.id,
      name: model.name,
      capabilities: model.capabilities,
    }))
    Object.values(store.settingsItems)
      .flatMap((item) =>
        item.sections.flatMap((section) =>
          pluginSettingsLeafFields(section.fields).flatMap((field) => {
            const target = modelTargetSettingsField(field)
            return target ? [{ pluginID: item.id, field: target }] : []
          }),
        ),
      )
      .forEach(({ pluginID, field }) => {
        const current = settingValue(pluginID, field.key, field.default)
        // Legacy persisted bare chain ids and bare provider/model values
        // migrate into the durable reference format without being dropped.
        const migrated = migrateModelTargetSetting({ value: current, chainIDs })
        if (migrated !== undefined) {
          setSettingValue(pluginID, field.key, migrated)
          return
        }
        const value = typeof current === "string" ? current : ""
        const next = shouldAutoSelectModelTarget({
          autoSelectSingle: field.autoSelectSingle,
          autoSelectDefault: field.autoSelectDefault,
          defaultChainID: models.chain.default(),
          value,
          chainIDs: chains
            .filter((chain) => chainMatchesChainPickerFilter(chain, available, field.filter))
            .map((chain) => chain.id),
          modelKeys: available
            .filter((model) => modelMatchesChainPickerFilter(model, field.filter))
            .map((model) => `${model.providerID}/${model.modelID}`),
        })
        if (next && next !== value) setSettingValue(pluginID, field.key, next)
      })
  })

  const settingsSnapshot = (pluginID: string) => {
    const item = store.settingsItems[pluginID]
    if (!item) return {}
    return Object.fromEntries(
      item.sections.flatMap((section) =>
        pluginSettingsLeafFields(section.fields).map((field) => [
          field.key,
          settingValue(pluginID, field.key, field.default),
        ]),
      ),
    )
  }

  const createScope = (id: string) => {
    const scope: PluginScope = {
      id,
      controller: new AbortController(),
      disposers: [],
    }
    setStore("scopes", id, scope)
    return scope
  }

  const scopeDisposer = createPluginScopeDisposer({
    current: (id) => store.scopes[id],
    snapshot: () => Object.entries(store.scopes),
    release: (id, scope) =>
      setStore(
        produce((draft) => {
          if (!ownsPluginScope(draft.scopes[id], scope)) return
          delete draft.scopes[id]
          delete draft.status[id]
        }),
      ),
    onError: (id, error) => console.error("[app-plugin] failed to dispose plugin", { id, error }),
  })
  const disposeScope = scopeDisposer.dispose
  const disposeAll = scopeDisposer.disposeAll

  const toggleToolbarItem = async (
    pluginID: string,
    pluginServer: string,
    input: { item: string; directory?: string; sessionID?: string; composerID?: string },
  ) => {
    if (server.key !== pluginServer) return { ok: false, error: "Plugin server is no longer active" }
    const navigation = currentNavigation()
    const directory = input.directory ?? navigation.directory
    const sessionID = input.sessionID ?? navigation.sessionID
    if (!directory || !sessionID) return { ok: false, error: "No composer target is active" }
    const composerID =
      input.composerID ?? composerRegistry.uniqueComposerID({ serverID: pluginServer, directory, sessionID })
    if (!composerID) return { ok: false, error: "No unique composer is available for the shared toggle" }
    const id = scopedID(pluginID, input.item)
    if (!standardToolbarItems.has(id)) return { ok: false, error: "Item has no standard appendOnSubmit action" }
    try {
      await invokeToolbarItem(id, { placement: "composer", align: "right", directory, sessionID, composerID })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  const apiForPlugin = (
    pluginID: string,
    manifest: PluginManifest,
    scope: PluginScope,
    conn: ServerConnection.HttpBase,
    pluginServer: ServerConnection.Key,
  ): AppPluginApi => {
    const allowed = new Set(manifest.capabilities)
    const active = () => !scope.controller.signal.aborted && ownsPluginScope(store.scopes[pluginID], scope)
    const can = (capability: AppPluginCapability) => active() && allowed.has(capability)
    const kv = createScopedKV(pluginID)
    const client = createSdkForServer({
      server: conn,
      fetch: platform.fetch,
      throwOnError: true,
    })
    const currentDirectory = () => currentNavigation().directory ?? activePluginDirectories()[0]
    const gitRequest = async (
      path: string,
      input?: { directory?: string; query?: Record<string, string | number | undefined>; body?: unknown },
      opts?: { typedError?: boolean },
    ) => {
      const directory = input?.directory ?? currentDirectory()
      if (!directory) throw new Error("No project directory is active")
      const url = new URL(`${conn.url.replace(/\/+$/, "")}${path}`)
      url.searchParams.set("directory", directory)
      for (const [key, value] of Object.entries(input?.query ?? {})) {
        if (value !== undefined) url.searchParams.set(key, String(value))
      }
      const response = await (platform.fetch ?? fetch)(url.toString(), {
        method: input?.body ? "POST" : "GET",
        headers: {
          ...authHeaders(conn),
          ...(input?.body ? { "content-type": "application/json" } : {}),
        },
        body: input?.body ? JSON.stringify(input.body) : undefined,
        signal: scope.controller.signal,
      })
      return readGitResponse(response, opts?.typedError)
    }
    const hostHttpRequest = async (input: AppHostHttpRequest): Promise<AppHostHttpResponse> => {
      if (!input.path.startsWith("/") || input.path.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(input.path)) {
        throw new Error("Plugin host HTTP paths must be relative server paths starting with /")
      }
      const method = input.method ?? (input.body === undefined ? "GET" : "POST")
      const url = new URL(`${conn.url.replace(/\/+$/, "")}${input.path}`)
      for (const [key, value] of Object.entries(input.query ?? {})) {
        if (value !== undefined) url.searchParams.set(key, String(value))
      }
      const response = await (platform.fetch ?? fetch)(url.toString(), {
        method,
        headers: {
          ...authHeaders(conn),
          ...(input.body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
        signal: input.signal,
      })
      const text = await response.text()
      const headers = Object.fromEntries(response.headers.entries())
      const contentType = response.headers.get("content-type") ?? ""
      const body = (() => {
        if (!text || !contentType.includes("json")) return undefined
        try {
          return JSON.parse(text) as unknown
        } catch {
          return undefined
        }
      })()
      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        headers,
        body,
        text,
      }
    }
    const requestSessionPolicy = async (input: {
      directory: string
      sessionID?: string
      action: "read" | "write"
      mode?: "ask" | "approve_for_me" | "full_access"
    }) => {
      if (!can("host:session-policy")) throw new Error("Missing host:session-policy capability")
      const response = await hostHttpRequest({
        path: "/app/host/session-policy",
        method: "POST",
        query: { directory: input.directory },
        signal: scope.controller.signal,
        body: {
          caller: { id: manifest.id, version: manifest.version, hash: manifest.hash },
          action: input.action,
          sessionID: input.sessionID,
          mode: input.mode,
        },
      })
      const body = response.body
      if (
        !response.ok ||
        !body ||
        typeof body !== "object" ||
        !("mode" in body) ||
        (body.mode !== "ask" && body.mode !== "approve_for_me" && body.mode !== "full_access")
      )
        throw new Error(formatServerError(body, undefined, response.statusText))
      return { mode: body.mode } as { mode: "ask" | "approve_for_me" | "full_access" }
    }
    const runHostCommand = async (input: AppHostCommandInput): Promise<AppHostCommandResult> => {
      // The server validates the frozen plugin manifest before executing, so
      // the caller identity must match the capability checked above.
      const response = await hostHttpRequest({
        path: "/app/host/command",
        method: "POST",
        body: { ...input, pluginID: manifest.id, pluginVersion: manifest.version, pluginHash: manifest.hash },
      })
      if (response.body && typeof response.body === "object") return response.body as AppHostCommandResult
      throw new Error(response.text || response.statusText || "Host command failed")
    }
    const runHostAI = async (input: AppHostAIRunInput): Promise<AppHostAIRunResult> => {
      const directory = input.directory ?? currentDirectory()
      if (!directory) return { ok: false, error: "No project directory is active" }
      // A resolvable chain reference wins over the model field so plugins can
      // send both. A present chain reference that cannot be resolved fails the
      // run: falling back to the single model would silently bypass the
      // user's configured fallback path.
      const chainResolution = resolveHostAIChain(input.chain, models.chain.list(), models.chain.default())
      if (chainResolution.status === "invalid")
        return { ok: false, error: `Model chain request failed: ${chainResolution.reason}` }
      const chainSteps = chainResolution.status === "chain" ? chainResolution.steps : undefined
      // Tolerate a durable `model:` reference forwarded from a Settings value.
      const model = chainSteps ? undefined : parseModelKey(stripModelTargetModelPrefix(input.model))
      const variant = model ? (input.variant ?? models.variant.get(model)) : undefined
      const { signal, chain, ...requestInput } = input
      const response = await hostHttpRequest({
        path: "/app/host/ai/run",
        method: "POST",
        signal,
        query: { directory },
        body: {
          ...requestInput,
          directory,
          model: model ? `${model.providerID}/${model.modelID}` : undefined,
          variant,
          ...(chainSteps ? { chain: { steps: chainSteps } } : {}),
          pluginID: manifest.id,
          pluginVersion: manifest.version,
          pluginHash: manifest.hash,
        },
      })
      if (response.body && typeof response.body === "object") return response.body as AppHostAIRunResult
      return { ok: false, error: response.text || response.statusText || "Plugin AI failed" }
    }
    const runHostImages = async (input: AppHostImageGenerateInput): Promise<AppHostImageGenerateResult> => {
      const { signal, ...requestInput } = input
      const response = await hostHttpRequest({
        path: "/app/host/images/generate",
        method: "POST",
        signal,
        body: {
          ...requestInput,
          pluginID: manifest.id,
          pluginVersion: manifest.version,
          pluginHash: manifest.hash,
        },
      })
      if (response.body && typeof response.body === "object") return response.body as AppHostImageGenerateResult
      return { ok: false, error: response.text || response.statusText || "Plugin image generation failed" }
    }
    const runHostSTT = async (input: AppHostSTTInput): Promise<AppHostSTTResult> => {
      const directory = input.directory ?? currentDirectory()
      if (!directory) return { ok: false, error: "No project directory is active" }
      // STT accepts an explicitly selected model or dedicated chain. In
      // particular, never resolve the text default chain implicitly for an
      // audio request.
      const chainRequested = input.chain?.trim().replace(/^chain:/, "")
      if (chainRequested === "default")
        return { ok: false, error: "Speech transcription requires an explicitly selected model or chain" }
      const chainResolution = chainRequested
        ? resolveHostAIChain(chainRequested, models.chain.list(), models.chain.default())
        : undefined
      if (chainResolution?.status === "invalid")
        return { ok: false, error: `Speech transcription model chain failed: ${chainResolution.reason}` }
      const chainSteps = chainResolution?.status === "chain" ? chainResolution.steps : undefined
      const audio = new Uint8Array(await input.audio.arrayBuffer())
      const response = await (platform.fetch ?? fetch)(
        `${conn.url.replace(/\/+$/, "")}/app/host/stt/transcribe?directory=${encodeURIComponent(directory)}`,
        {
          method: "POST",
          headers: { ...authHeaders(conn), "content-type": "application/json" },
          body: JSON.stringify({
            pluginID: manifest.id,
            pluginVersion: manifest.version,
            pluginHash: manifest.hash,
            // Direct selections send `model`; chain selections send `chain`.
            model: chainSteps ? undefined : stripModelTargetModelPrefix(input.model),
            ...(chainSteps ? { chain: { steps: chainSteps } } : {}),
            mimeType: input.mimeType,
            language: input.language,
            context: input.context,
            audio: encodeAudioBase64(audio),
          }),
          signal: input.signal,
        },
      )
      const body = await response.json().catch(() => undefined)
      if (body && typeof body === "object") return body as AppHostSTTResult
      return { ok: false, error: response.statusText || "Transcription failed" }
    }
    const runHostTTS = async (input: AppHostTTSInput): Promise<AppHostTTSResult> => {
      const directory = input.directory ?? currentDirectory()
      if (!directory) return { ok: false, error: "No project directory is active" }
      const chainRequested = input.chain?.trim().replace(/^chain:/, "")
      if (chainRequested === "default")
        return { ok: false, error: "Speech synthesis requires an explicitly selected model or chain" }
      const chainResolution = chainRequested
        ? resolveHostAIChain(chainRequested, models.chain.list(), models.chain.default())
        : undefined
      if (chainResolution?.status === "invalid")
        return { ok: false, error: `Speech synthesis model chain failed: ${chainResolution.reason}` }
      const chainSteps = chainResolution?.status === "chain" ? chainResolution.steps : undefined
      const response = await (platform.fetch ?? fetch)(
        `${conn.url.replace(/\/+$/, "")}/app/host/tts/speech?directory=${encodeURIComponent(directory)}`,
        {
          method: "POST",
          headers: { ...authHeaders(conn), "content-type": "application/json" },
          body: JSON.stringify({
            pluginID: manifest.id,
            pluginVersion: manifest.version,
            pluginHash: manifest.hash,
            model: chainSteps ? undefined : stripModelTargetModelPrefix(input.model),
            ...(chainSteps ? { chain: { steps: chainSteps } } : {}),
            text: input.text,
            voice: input.voice,
            voices: input.voices,
            format: input.format,
            speed: input.speed,
          }),
          signal: input.signal,
        },
      )
      if (!response.ok) {
        const body = await response.json().catch(() => undefined)
        return {
          ok: false,
          error:
            body && typeof body === "object" && "error" in body && typeof body.error === "string"
              ? body.error
              : response.statusText || "Speech synthesis failed",
        }
      }
      if (!response.body) return { ok: false, error: "Speech synthesis returned no audio stream" }
      const format = response.headers.get("x-opencode-tts-format")
      if (format !== "pcm" && format !== "mp3") {
        await response.body.cancel()
        return { ok: false, error: "Speech synthesis returned no supported audio format" }
      }
      return {
        ok: true,
        stream: response.body,
        mimeType: response.headers.get("content-type") ?? "application/octet-stream",
        format,
        sampleRate: Number(response.headers.get("x-opencode-tts-sample-rate")) || undefined,
        channels: Number(response.headers.get("x-opencode-tts-channels")) || undefined,
        voice: decodeURIComponent(response.headers.get("x-opencode-tts-voice") ?? ""),
        model: response.headers.get("x-opencode-tts-model") ?? "",
        step: Number(response.headers.get("x-opencode-tts-step") ?? 0),
        generationID: response.headers.get("x-generation-id") ?? undefined,
      }
    }
    const resolveSessionModel = (reference: string): AppHostSessionModel | undefined => {
      const chains = models.chain.list()
      const target = parseModelTarget(
        reference,
        chains.map((chain) => chain.id),
      )
      if (target.kind === "model") return { id: target.modelID, providerID: target.providerID }
      if (target.kind !== "chain") return
      const chain = models.chain.find(target.id === "default" ? models.chain.default() : target.id)
      const first = chain?.steps[0]
      if (!chain || !first) return
      return {
        id: first.modelID,
        providerID: first.providerID,
        variant: first.variant,
        chain: {
          id: chain.id,
          name: chain.name,
          steps: chain.steps.map((step) => ({ id: step.modelID, providerID: step.providerID, variant: step.variant })),
          active: 0,
        },
      }
    }
    const insertComposerText = async (input: {
      directory: string
      sessionID?: string
      composerID?: string
      text: string
      position?: "cursor" | "end"
      replace?: string
      operationID?: string
    }): Promise<AppHostComposerInsertResult> => {
      if (!active() || !isPluginServerActive(pluginServer, server.key))
        return { ok: false, error: "The composer server is no longer active" }
      const result = input.composerID
        ? composerRegistry.insertText({ ...input, composerID: input.composerID, serverID: pluginServer })
        : undefined
      if (result) return result
      // Restore only the original open draft or a stable session composer.
      const scope = () => backgroundPromptScope({ ...input, serverID: pluginServer }, tabs.store)
      const target = scope()
      if (!target || !input.composerID) return { ok: false, error: "The pinned composer is no longer available" }
      // runWithOwner returns undefined when the owner is gone; a disposed plugin surface has no composer to restore.
      const prompt = runWithOwner(owner, () => acquirePromptSession(serverSDK().scope, target, platform))
      if (!prompt) return { ok: false, error: "The pinned composer is no longer available" }
      try {
        await prompt.value.ready.promise
        if (!active() || !isPluginServerActive(pluginServer, server.key))
          return { ok: false, error: "The composer server is no longer active" }
        if (!scope()) return { ok: false, error: "The pinned composer is no longer available" }
        const before = prompt.value.current().map((part) => ({ ...part }))
        const cursor = prompt.value.cursor() ?? before.reduce((length, part) => length + ("content" in part ? part.content.length : 0), 0)
        const inserted = insertPromptDraft(
          prompt.value,
          input,
          promptInsertionIdentity({
            serverID: pluginServer,
            directory: input.directory,
            sessionID: input.sessionID,
            composerID: input.composerID,
          }),
        )
        return { ...inserted, insertionReceiptID: inserted.ok && input.operationID
          ? composerSendIntents.recordInsertion({ ...input, composerID: input.composerID, serverID: pluginServer }, input.operationID, before, prompt.value.current(), input.text, cursor,
              input.replace ? { replace: input.replace, cursor: prompt.value.cursor() ?? cursor } : undefined) : undefined }
      } finally {
        prompt.dispose()
      }
    }
    const submitComposerText = (input: {
      directory: string
      sessionID: string
      composerID: string
      text: string
    }): Promise<AppHostComposerInsertResult> => {
      const navigation = currentNavigation()
      if (navigation.directory !== input.directory || navigation.sessionID !== input.sessionID)
        return Promise.resolve({ ok: false, error: "Composer context changed before submission" })
      if (!input.text.trim()) return Promise.resolve({ ok: false, error: "Composer submission text is empty" })

      return composerRegistry.submitText({ ...input, serverID: pluginServer })
    }
    const listHostSkills = async (input?: {
      scope?: "visible" | "all"
      directory?: string
      sessionID?: string
      composerID?: string
      signal?: AbortSignal
    }) => {
      const directory = input?.directory ?? currentDirectory()
      if (!directory) return []
      const response = await serverSDK().client.v2.command.list({ location: { directory } }, { signal: input?.signal })
      const commands = response.data?.data ? normalizeCommandList(response.data.data) : []
      if (input?.scope === "all") return skillReferences({ commands })
      const toolbar = toolbarItemsForDirectory(directory).filter((item) => {
        if (!item.skill || toolbarPlacement(item) !== "composer") return false
        if (!isToolbarItemVisible(item.id, directory)) return false
        return (
          item.visible?.({
            placement: "composer",
            align: toolbarAlign(item),
            directory,
            sessionID: input?.sessionID,
            composerID: input?.composerID,
          }) ?? true
        )
      })
      return skillReferences({ commands, toolbar })
    }
    const resolveHostSkills = async (input: { names: string[]; directory?: string; signal?: AbortSignal }) => {
      const directory = input.directory ?? currentDirectory()
      if (!directory) return { skills: [], issues: input.names.map((name) => ({ name, code: "not_found" as const })) }
      const result = await serverSDK().client.v2.skill.resolve(
        { location: { directory }, skillV2ResolveInput: { names: input.names } },
        { signal: input.signal },
      )
      if (!result.data?.data) throw new Error("Skill content resolution returned no data")
      return result.data.data
    }
    const diagnoseHostToolbarSkills = async (input?: {
      agent?: string
      directory?: string
      sessionID?: string
      composerID?: string
      signal?: AbortSignal
    }) => {
      const directory = input?.directory ?? currentDirectory()
      if (!directory) return []
      const response = await serverSDK().client.v2.command.list({ location: { directory } }, { signal: input?.signal })
      const commands = response.data?.data ? normalizeCommandList(response.data.data) : []
      const toolbar = toolbarItemsForDirectory(directory).filter((item) => {
        if ((!item.skill && !item.command) || toolbarPlacement(item) !== "composer") return false
        if (!isToolbarItemVisible(item.id, directory)) return false
        return (
          item.visible?.({
            placement: "composer",
            align: toolbarAlign(item),
            directory,
            sessionID: input?.sessionID,
            composerID: input?.composerID,
          }) ?? true
        )
      })
      const sessionID = input?.sessionID ?? currentNavigation().sessionID
      const composerID =
        input?.composerID ?? composerRegistry.uniqueComposerID({ serverID: pluginServer, directory, sessionID })
      const snapshot = composerID
        ? composerRegistry.read({ serverID: pluginServer, directory, sessionID, composerID })
        : undefined
      const constraints = await serverSDK().client.v2.skill.diagnostics(
        { location: { directory }, agent: input?.agent ?? snapshot?.agent },
        { signal: input?.signal },
      )
      return skillReferenceDiagnostics({ commands, toolbar, constraints: constraints.data?.data })
    }
    const mountModelSelector = (input: {
      element: HTMLElement
      value?: string
      label?: string
      allowClear?: boolean
      onChange(value: string | undefined): void
    }) => {
      if (!owner) return { setValue() {}, dispose() {} }
      const [value, setValue] = createSignal(input.value)
      const dispose = runWithOwner(owner, () =>
        render(
          () => (
            <SettingsModelPickerV2
              value={value()}
              label={input.label ?? "Select model"}
              allowClear={input.allowClear}
              onChange={(next) => {
                setValue(next)
                input.onChange(next)
              }}
            />
          ),
          input.element,
        ),
      )
      return {
        setValue,
        dispose: dispose ?? (() => {}),
      }
    }

    // Capability gate: every public API method checks the plugin's capability
    // set before touching runtime state. A plugin with `chat:parts` disabled
    // gets a no-op `register` that returns an unsubscriber which does nothing,
    // so capability policy and plugin code can stay decoupled. Plugin authors
    // never need to call `api.capabilities` defensively.
    //
    // ID scoping: every identifier a plugin registers (dock item, slot, route,
    // command, chat-part renderer) is namespaced with the plugin id so that
    // cross-plugin collisions are impossible. Plugin-facing open/close/move
    // helpers re-apply the prefix before resolving, so plugins always see only
    // their own registrations.

    return {
      capabilities: allowed,
      signal: scope.controller.signal,
      client,
      services: {
        async call(input) {
          const capability = `services:${input.pluginID}:${input.serviceID}` as const
          if (!can(capability)) return { ok: false, error: `Missing ${capability} capability` }
          if (!isPluginServerActive(pluginServer, server.key))
            return { ok: false, error: "The plugin server is no longer active" }
          const directory = input.directory ?? currentDirectory()
          if (!directory) return { ok: false, error: "No project directory is active" }
          const response = await (platform.fetch ?? fetch)(
            `${conn.url.replace(/\/+$/, "")}/plugins/${encodeURIComponent(input.pluginID)}/services/${encodeURIComponent(input.serviceID)}?directory=${encodeURIComponent(directory)}`,
            {
              method: "POST",
              headers: { ...authHeaders(conn), "content-type": "application/json" },
              body: JSON.stringify({
                caller: { id: manifest.id, version: manifest.version, hash: manifest.hash },
                version: input.version,
                input: input.input,
              }),
              signal: input.signal ? AbortSignal.any([scope.controller.signal, input.signal]) : scope.controller.signal,
            },
          )
          return pluginServiceResponse(response)
        },
      },
      dock: {
        register(item) {
          if (!can("ui:dock")) return () => {}
          return trackPluginScope(
            scope,
            registerDockItem({
              ...item,
              id: scopedID(pluginID, item.id),
              pluginID,
            }),
          )
        },
        state: {
          item(id) {
            if (!can("ui:dock")) return { visible: false }
            const itemID = scopedID(pluginID, id)
            return { area: layout.dock.itemArea(itemID), visible: layout.dock.itemVisible(itemID) }
          },
        },
        open: {
          item(id, placement) {
            if (!can("ui:dock")) return
            openDockItem(scopedID(pluginID, id), placement)
          },
        },
        close: {
          item(id) {
            if (!can("ui:dock")) return
            closeDockItem(scopedID(pluginID, id))
          },
        },
        move: {
          item(id, area) {
            if (!can("ui:dock")) return
            moveDockItem(scopedID(pluginID, id), area)
          },
        },
      },
      slots: {
        register(item) {
          if (!can("ui:slots")) return () => {}
          if (!isUISlotID(item.slot)) throw new Error(`Unknown UI slot: ${item.slot}`)
          return trackPluginScope(
            scope,
            registerSlotItem({
              ...item,
              slot: item.slot,
              id: scopedID(pluginID, item.id),
              pluginID,
            }),
          )
        },
      },
      toolbar: {
        register(item) {
          if (!can("ui:toolbar")) return () => {}
          return trackPluginScope(
            scope,
            registerToolbarItem(
              {
                ...item,
                id: scopedID(pluginID, item.id),
                pluginID,
              },
              scope,
              { serverID: pluginServer, active: () => can("host:composer") },
            ),
          )
        },
      },
      ui: {
        floating: createFloatingHost({
          authorized: () => can("ui:floating"),
          track: (dispose) => trackPluginScope(scope, dispose),
          subscribe: (handler) =>
            createRoot((dispose) => {
              const listener = (event: Event) =>
                handler(isPluginServerActive(pluginServer, server.key) ? hostNavigationFromEvent(event) : {})
              window.addEventListener("opencode:navigation-activated", listener)
              createEffect(() => {
                handler(isPluginServerActive(pluginServer, server.key) ? currentNavigation() : {})
              })
              return () => {
                window.removeEventListener("opencode:navigation-activated", listener)
                dispose()
              }
            }),
        }),
        overlay: {
          open(input) {
            if (!can("ui:overlay")) return { close() {} }
            return openPluginOverlay(pluginID, scope, input)
          },
        },
        loading: {
          show(input) {
            if (!can("ui:loading")) return { close() {} }
            return showLoadingOverlay(pluginID, scope, input)
          },
          async with(input, run) {
            const overlay = can("ui:loading") ? showLoadingOverlay(pluginID, scope, input) : { close() {} }
            try {
              return await run()
            } finally {
              overlay.close()
            }
          },
        },
        models: {
          resolve: resolveSessionModel,
          chains() {
            if (!can("ui:models")) return []
            const defaultID = models.chain.default()
            return models.chain.list().map((chain) => ({
              id: chain.id,
              name: chain.name,
              isDefault: chain.id === defaultID,
            }))
          },
          selector(input) {
            if (!can("ui:models")) return { setValue() {}, dispose() {} }
            const control = mountModelSelector(input)
            return {
              setValue: control.setValue,
              dispose: trackPluginScope(scope, control.dispose),
            }
          },
        },
      },
      settings: {
        register(item) {
          if (!can("ui:settings")) return () => {}
          return trackPluginScope(
            scope,
            registerSettingsItem({
              ...item,
              id: pluginID,
              pluginID,
            }),
          )
        },
        get(key, fallback) {
          return active() ? settingValue(pluginID, key, fallback) : fallback
        },
        set(key, value) {
          if (active()) setSettingValue(pluginID, key, value)
        },
        subscribe(handler) {
          if (!can("ui:settings")) return () => {}
          const next = () => handler(settingsSnapshot(pluginID))
          const listener = (event: Event) => {
            if (!(event instanceof CustomEvent)) return
            if (event.detail?.pluginID !== pluginID) return
            next()
          }
          window.addEventListener(APP_PLUGIN_SETTINGS_CHANGED, listener)
          next()
          return trackPluginScope(scope, () => window.removeEventListener(APP_PLUGIN_SETTINGS_CHANGED, listener))
        },
      },
      automation: {
        register(item) {
          if (!can("automation")) return () => {}
          return trackPluginScope(
            scope,
            registerAutomationItem({
              ...item,
              id: scopedID(pluginID, item.id),
              pluginID,
            }),
          )
        },
      },
      routes: {
        register(item) {
          if (!can("routes")) return () => {}
          const id = scopedID(pluginID, item.id)
          const route = {
            ...item,
            id,
            pluginID,
          }
          const disposeRoute = registerRouteItem(route)
          const disposeDock = registerDockItem({
            id,
            pluginID,
            title: item.title,
            icon: item.icon,
            defaultArea: "middle",
            mount: item.mount,
          })
          const disposeCommand = registerCommandOption({
            id: scopedID(pluginID, `route.${item.id}`, "."),
            title: item.title,
            run() {
              openDockItem(id, { area: "middle" })
            },
          })
          return trackPluginScope(scope, () => {
            disposeCommand()
            disposeDock()
            disposeRoute()
          })
        },
      },
      chat: {
        parts: {
          register(renderer) {
            if (!can("chat:parts")) return () => {}
            return trackPluginScope(
              scope,
              registerCustomPartRenderer(scopedID(pluginID, renderer.kind), ({ part }) => (
                <CustomPartMount part={part} mount={renderer.mount} />
              )),
            )
          },
        },
      },
      commands: {
        register(input) {
          if (!can("commands")) return () => {}
          return trackPluginScope(
            scope,
            registerCommandOption(scopePluginCommand(input, scopedID(pluginID, input.id, "."))),
          )
        },
      },
      kv: {
        get(key, fallback) {
          return active() ? kv.get(key, fallback) : fallback
        },
        set(key, value) {
          if (active()) kv.set(key, value)
        },
        delete(key) {
          if (active()) kv.delete(key)
        },
      },
      event: {
        // Each subscription is tied to the plugin's scope via `track`, so
        // disposing the plugin (or its host connection) cancels every listener.
        // The underlying SSE stream itself is per-connection, so plugin
        // subscriptions share one transport rather than opening per-plugin
        // sockets. Plugins that need high-frequency event handling should
        // debounce in `handler` Ã¢â‚¬â€ the runtime does not throttle.
        on(type, handler) {
          if (!can("events")) return () => {}
          return trackPluginScope(
            scope,
            serverSDK().event.listen((event) => {
              if (event.details.type === type) handler(event.details, { directory: event.name })
            }),
          )
        },
      },
      host: {
        projects: {
          list() {
            if (!can("host:projects")) return []
            return hostProjects()
          },
          open(directory) {
            if (!can("host:projects")) return
            openHostProject(directory)
          },
          move(worktree, toIndex) {
            if (!can("host:projects")) return
            layout.projects.move(worktree, toIndex)
          },
          subscribe(handler) {
            if (!can("host:projects")) return () => {}
            return trackPluginScope(
              scope,
              createRoot((dispose) => {
                let previous: string | undefined
                createEffect(() => {
                  const projects = hostProjects()
                  const next = hostProjectsSnapshot(projects)
                  if (previous === next) return
                  previous = next
                  handler(projects)
                })
                return dispose
              }),
            )
          },
        },
        navigation: {
          current() {
            if (!can("host:navigation") || !isPluginServerActive(pluginServer, server.key)) return {}
            return currentNavigation()
          },
          subscribe(handler) {
            if (!can("host:navigation")) return () => {}
            return trackPluginScope(
              scope,
              createRoot((dispose) => {
                let previous: string | undefined
                const publish = (navigation: AppHostNavigationState, event?: AppHostNavigationEvent) => {
                  if (!isPluginServerActive(pluginServer, server.key)) return
                  const next = hostNavigationSnapshot(navigation)
                  if (!event?.activated && previous === next) return
                  previous = next
                  handler(navigation, event)
                }
                const listener = (event: Event) => {
                  if (!isPluginServerActive(pluginServer, server.key)) return
                  publish(hostNavigationFromEvent(event), { activated: true })
                }
                window.addEventListener("opencode:navigation-activated", listener)
                createEffect(() => {
                  if (!isPluginServerActive(pluginServer, server.key)) {
                    previous = undefined
                    return
                  }
                  publish(currentNavigation())
                })
                return () => {
                  window.removeEventListener("opencode:navigation-activated", listener)
                  dispose()
                }
              }),
            )
          },
          openSession(input) {
            if (!can("host:navigation") || !isPluginServerActive(pluginServer, server.key)) return
            navigateToSession(input.directory, input.sessionID, input.area)
          },
          newSession(input) {
            if (!can("host:navigation") || !isPluginServerActive(pluginServer, server.key)) return
            navigateToNewSession(input.directory, input.area)
          },
          handoff(input) {
            if (!can("host:navigation"))
              return Promise.resolve({ ok: false, error: "Missing host:navigation capability" })
            return navigationHandoffs.dispatch(input, {
              serverID: pluginServer,
              source: "plugin",
              signal: scope.controller.signal,
            })
          },
          registerHandoffHandler(input) {
            if (!can("host:navigation")) return () => {}
            return trackPluginScope(
              scope,
              navigationHandoffs.register(
                { serverID: pluginServer, pluginID, handlerID: input.id, signal: scope.controller.signal },
                input.handle,
              ),
            )
          },
        },
        sessions: {
          attention: {
            register(id) {
              if (!can("host:session-attention")) return () => {}
              return trackPluginScope(scope, attention.register(scopedID(pluginID, id)))
            },
            get(input) {
              if ((!can("host:session-attention") && !can("host:session-attention-read")) || !active() || server.key !== pluginServer) return
              const entry = attention.current(input)
              return entry ? { enabled: entry.enabled, available: attention.enabled(), pendingCount: attention.enabled() ? entry.count : 0,
                error: attention.enabled() && entry.error } : undefined
            },
            set(input, enabled) {
              if (!can("host:session-attention") || !active() || server.key !== pluginServer) return Promise.resolve(false)
              return attention.set(input, enabled)
            },
            subscribe(handler) {
              if ((!can("host:session-attention") && !can("host:session-attention-read")) || !active() || server.key !== pluginServer) return () => {}
              return trackPluginScope(scope, createRoot((dispose) => {
                createEffect(() => { attention.revision(); attention.enabled(); if (active() && server.key === pluginServer) handler() })
                return dispose
              }))
            },
          },
          accessControl: {
            async get(input) {
              return requestSessionPolicy({ ...input, action: "read" })
            },
            async set(input) {
              await requestSessionPolicy({ ...input, action: "write" })
            },
          },
          create(input) {
            if (!can("host:sessions"))
              return Promise.resolve({ ok: false as const, error: "Missing host:sessions capability" })
            const directory = input.directory ?? currentDirectory()
            if (!directory) return Promise.resolve({ ok: false as const, error: "No project directory is active" })
            const model = resolveSessionModel(input.modelTarget)
            if (!model) return Promise.resolve({ ok: false as const, error: "Session model target is unavailable" })
            return serverSDK()
              .createClient({ directory, throwOnError: true })
              .v2.session.create({ agent: input.agent, model, location: { directory } })
              .then(
                (response) =>
                  response.data?.data.id
                    ? { ok: true as const, sessionID: response.data.data.id, model }
                    : { ok: false as const, error: "Session was not created" },
                (error) => ({
                  ok: false as const,
                  error: error instanceof Error ? error.message : "Session creation failed",
                }),
              )
          },
          prompt(input) {
            if (!can("host:sessions")) return Promise.resolve({ ok: false, error: "Missing host:sessions capability" })
            const directory = input.directory ?? currentDirectory()
            if (!directory) return Promise.resolve({ ok: false, error: "No project directory is active" })
            return serverSDK()
              .createClient({ directory, throwOnError: true })
              .v2.session.prompt({
                sessionID: input.sessionID,
                agent: input.agent,
                model: input.model,
                prompt: { text: input.text },
                delivery: input.delivery ?? "steer",
              })
              .then(
                () => ({ ok: true }),
                (error) => ({ ok: false, error: error instanceof Error ? error.message : "Session prompt failed" }),
              )
          },
          interrupt(input) {
            if (!can("host:sessions")) return Promise.resolve({ ok: false, error: "Missing host:sessions capability" })
            const directory = input.directory ?? currentDirectory()
            if (!directory) return Promise.resolve({ ok: false, error: "No project directory is active" })
            return serverSDK()
              .createClient({ directory, throwOnError: true })
              .v2.session.interrupt({ sessionID: input.sessionID })
              .then(
                () => ({ ok: true }),
                (error) => ({ ok: false, error: error instanceof Error ? error.message : "Session interrupt failed" }),
              )
          },
          replyPermission(input) {
            if (!can("host:sessions")) return Promise.resolve({ ok: false, error: "Missing host:sessions capability" })
            const directory = input.directory ?? currentDirectory()
            if (!directory) return Promise.resolve({ ok: false, error: "No project directory is active" })
            return serverSDK()
              .createClient({ directory, throwOnError: true })
              .v2.session.permission.reply({
                sessionID: input.sessionID,
                requestID: input.requestID,
                reply: input.reply,
              })
              .then(
                () => ({ ok: true }),
                (error) => ({
                  ok: false,
                  error: error instanceof Error ? error.message : "Session permission reply failed",
                }),
              )
          },
          messages(input) {
            if (!can("host:sessions")) return Promise.resolve([])
            const directory = input.directory ?? currentDirectory()
            if (!directory) return Promise.resolve([])
            return serverSDK()
              .createClient({ directory, throwOnError: true })
              .v2.session.messages({
                sessionID: input.sessionID,
                limit: Math.min(Math.max(input.limit ?? 40, 1), 200),
                order: "desc",
              })
              .then(
                (response) => sessionMessages(response.data?.data ?? []),
                () => [],
              )
          },
          async context(input: AppHostSessionContextInput): Promise<AppHostSessionContextResult> {
            if (!can("host:session-context")) return { ok: false, error: { code: "forbidden", message: "Missing host:session-context capability" } }
            const directory = input.directory ?? currentDirectory()
            if (!directory) return { ok: false, error: { code: "unavailable", message: "No project directory is active" } }
            const signal = AbortSignal.any([scope.controller.signal, ...(input.signal ? [input.signal] : [])])
            if (signal.aborted) return { ok: false, error: { code: "aborted", message: "Session context read aborted" } }
            return serverSDK().createClient({ directory }).pluginServices.sessionContext({
              directory, sessionID: input.sessionID, limit: input.limit, maxTextChars: input.maxTextChars,
              caller: { id: manifest.id, version: manifest.version, hash: manifest.hash },
            }, { signal }).then((response): AppHostSessionContextResult => {
              if (signal.aborted) return { ok: false, error: { code: "aborted", message: "Session context read aborted" } }
              if (response.data?.ok) return response.data
              const body = response.error
              const code = response.response.status === 403 || response.response.status === 401 ? "forbidden"
                : isRecord(body) && "kind" in body && body.kind === "not_found" ? "not_found"
                : response.response.status === 400 ? "invalid_input" : "unavailable"
              return { ok: false, error: { code, message: formatServerError(body, undefined, response.response.statusText) } }
            }, (error): AppHostSessionContextResult => ({ ok: false, error: {
              code: signal.aborted ? "aborted" : "unavailable", message: signal.aborted ? "Session context read aborted" : error instanceof Error ? error.message : "Session context unavailable",
            } }))
          },
          subscribeEvents(input, handler) {
            if (!can("host:sessions")) return () => {}
            const client = serverSDK().createClient({ directory: input.directory, throwOnError: true })
            const subscription = createSessionSubscription({
              sessionID: input.sessionID,
              pending: () =>
                client.v2.permission.request
                  .list({ location: { directory: input.directory } })
                  .then((response) => response.data?.data ?? []),
              session: (sessionID) => client.v2.session.get({ sessionID }).then((response) => response.data?.data),
              relatedSession: input.relatedSession,
              emit: handler,
            })
            const report = (error: unknown) => console.warn("Session permission recovery failed", error)
            const recover = () => {
              void subscription.recover().catch(report)
            }
            const unsubscribe = serverSDK().event.on(input.directory, (event) => {
              void subscription.receive(event).catch(report)
            })
            const unsubscribeSync = serverSDK().sync.on(input.directory, (event) => {
              void subscription.receive(event).catch(report)
            })
            const reconnect = serverSDK().event.on("global", (event) => {
              if (event.type === "server.connected") recover()
            })
            const visible = () => {
              if (document.visibilityState === "visible") recover()
            }
            document.addEventListener("visibilitychange", visible)
            recover()
            return trackPluginScope(scope, () => {
              subscription.dispose()
              unsubscribe()
              unsubscribeSync()
              reconnect()
              document.removeEventListener("visibilitychange", visible)
            })
          },
          working(input) {
            if (!can("host:sessions")) return false
            return sessionWorking(input)
          },
          status(input) {
            if (!can("host:sessions")) return undefined
            return sessionStatus(input)
          },
          active() {
            if (!can("host:sessions")) return []
            return activeSessions()
          },
          subscribe(handler) {
            if (!can("host:sessions")) return () => {}
            return trackPluginScope(
              scope,
              createRoot((dispose) => {
                let previous: string | undefined
                createEffect(() => {
                  const next = sessionStatusSnapshot()
                  if (previous === next) return
                  previous = next
                  handler()
                })
                return dispose
              }),
            )
          },
          favorites: {
            list() {
              if (!can("host:sessions")) return []
              return hostFavorites(pluginServer)
            },
            is(input) {
              if (!can("host:sessions")) return false
              return sessionFavorites.is({ server: pluginServer, directory: input.directory, id: input.id })
            },
            set(input, favorite) {
              if (!can("host:sessions")) return
              sessionFavorites.set(sessionFavorite(pluginServer, input), favorite)
            },
            toggle(input) {
              if (!can("host:sessions")) return false
              return sessionFavorites.toggle(sessionFavorite(pluginServer, input))
            },
            subscribe(handler) {
              if (!can("host:sessions")) return () => {}
              return trackPluginScope(
                scope,
                createRoot((dispose) => {
                  createEffect(() => handler(hostFavorites(pluginServer)))
                  return dispose
                }),
              )
            },
          },
        },
        git: {
          snapshot(input) {
            if (!can("host:git")) return Promise.reject(new Error("Missing host:git capability"))
            return gitRequest("/vcs/git", {
              directory: input?.directory,
              query: { limit: input?.limit },
            }) as Promise<AppHostGitSnapshot>
          },
          history(input) {
            if (!can("host:git")) return Promise.reject(new Error("Missing host:git capability"))
            return gitRequest(
              "/vcs/git/history",
              {
                directory: input?.directory,
                body: {
                  selector: input?.selector,
                  ref: input?.ref,
                  firstParent: input?.firstParent,
                  limit: input?.limit,
                  cursor: input?.cursor,
                },
              },
              { typedError: true },
            ) as Promise<AppHostGitHistoryPage>
          },
          commitMessage(input) {
            if (!can("host:git")) return Promise.reject(new Error("Missing host:git capability"))
            return gitRequest(
              "/vcs/git/commit-message",
              {
                directory: input?.directory,
                body: { hash: input?.hash, cursor: input?.cursor },
              },
              { typedError: true },
            ) as Promise<AppHostGitCommitMessagePage>
          },
          discover(input) {
            if (!can("host:git")) return Promise.resolve({ repositories: [], truncated: false })
            return gitRequest("/vcs/git/discover", {
              directory: input?.directory,
              query: { maxDepth: input?.maxDepth },
            }) as Promise<AppHostGitDiscoverResult>
          },
          async diff(input) {
            if (!can("host:git")) return []
            const body = await gitRequest("/vcs/diff", {
              directory: input?.directory,
              query: { mode: input?.mode ?? "git", context: input?.context },
            })
            return Array.isArray(body)
              ? body.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
              : []
          },
          action(input) {
            if (!can("host:git")) return Promise.resolve({ ok: false, message: "Missing host:git capability" })
            const { directory, ...body } = input
            if (body.action === "commitAuto") {
              // Resolve the persisted plugin selection to a validated bounded
              // snapshot. Missing and stale ids fail closed before the request.
              const commitTarget = resolveGitCommitTarget(
                typeof body.commitTarget === "string"
                  ? body.commitTarget
                  : typeof body.modelChain === "string"
                    ? body.modelChain
                    : undefined,
                models.chain.list(),
                models.chain.default(),
                models.list().map((model) => ({ providerID: model.provider.id, modelID: model.id })),
              )
              if (commitTarget.status === "invalid")
                return Promise.resolve({
                  ok: false,
                  message: `AI commit model request failed: ${commitTarget.reason}`,
                })
              const {
                commitTarget: _commitTarget,
                modelChain: _modelChain,
                useChain: _useChain,
                commitModel: _commitModel,
                ...rest
              } = body
              if (commitTarget.status === "model")
                return gitRequest("/vcs/git/action", {
                  directory,
                  body: { ...rest, useChain: false, commitModel: commitTarget.model },
                }) as Promise<AppHostGitActionResult>
              return gitRequest("/vcs/git/action", {
                directory,
                body: { ...rest, useChain: true, commitChain: { steps: commitTarget.steps } },
              }) as Promise<AppHostGitActionResult>
            }
            return gitRequest("/vcs/git/action", { directory, body }) as Promise<AppHostGitActionResult>
          },
        },
        http: {
          request(input) {
            if (!can("host:http")) {
              return Promise.resolve({
                ok: false,
                status: 403,
                statusText: "Missing host:http capability",
                headers: {},
                text: "",
              })
            }
            return hostHttpRequest(input)
          },
        },
        command: {
          run(input) {
            if (!can("host:command")) {
              return Promise.resolve({
                ok: false,
                exitCode: -1,
                stdout: "",
                stderr: "Missing host:command capability",
                output: "Missing host:command capability",
              })
            }
            return runHostCommand(input)
          },
        },
        ai: {
          run(input) {
            if (!can("host:ai")) return Promise.resolve({ ok: false, error: "Missing host:ai capability" })
            return runHostAI(input)
          },
        },
        images: {
          generate(input) {
            if (!can("host:images")) return Promise.resolve({ ok: false, error: "Missing host:images capability" })
            return runHostImages(input)
          },
        },
        stt: {
          transcribe(input) {
            if (!can("host:stt")) return Promise.resolve({ ok: false, error: "Missing host:stt capability" })
            return runHostSTT(input)
          },
        },
        tts: {
          speak(input) {
            if (!can("host:tts")) return Promise.resolve({ ok: false, error: "Missing host:tts capability" })
            return runHostTTS(input)
          },
        },
        audio: {
          acquire(input) {
            if (!can("host:audio")) return Promise.resolve({ ok: false, error: "Missing host:audio capability" })
            return audioCapture.acquire({
              ...input,
              signal: AbortSignal.any([scope.controller.signal, ...(input.signal ? [input.signal] : [])]),
            })
          },
        },
        composer: createComposerApi({
          serverID: pluginServer,
          currentServer: () => server.key,
          active: () => can("host:composer"),
          signal: scope.controller.signal,
          track: (dispose) => trackPluginScope(scope, dispose),
          insertText: insertComposerText,
          submitText: submitComposerText,
        }),
        skills: {
          list(input) {
            if (!can("host:skills")) return Promise.resolve([])
            return listHostSkills(input)
          },
          resolve(input) {
            if (!can("host:skill-content")) return Promise.reject(new Error("Missing host:skill-content capability"))
            return resolveHostSkills(input)
          },
          diagnostics(input) {
            if (!can("host:skills")) return Promise.resolve([])
            return diagnoseHostToolbarSkills(input)
          },
        },
        toolbar: {
          async toggle(input) {
            if (!can("host:toolbar")) return { ok: false, error: "Missing host:toolbar capability" }
            return toggleToolbarItem(pluginID, pluginServer, input)
          },
        },
        textInput: {
          capture() {
            if (!can("host:text-input")) return
            const target = captureFocusedTextInput()
            if (!target) return
            return {
              insertText(text) {
                if (!can("host:text-input")) return { ok: false, error: "Missing host:text-input capability" }
                return target.insertText(text)
              },
            }
          },
        },
        desktopServices: {
          async register(input) {
            if (!can("host:desktop-services")) return { ok: false, error: "Missing host:desktop-services capability" }
            if (!platform.registerDesktopService)
              return { ok: false, error: "Desktop services are only available in OpenCode Desktop" }
            const registration = await platform.registerDesktopService(
              { pluginID, serviceID: input.id, accelerator: input.accelerator },
              (invocation) => {
                if (!active()) return
                return input.onInvoke(invocation)
              },
            )
            if (!registration.ok) return registration
            trackPluginScope(scope, registration.dispose)
            return registration
          },
          async writeClipboardText(text) {
            if (!can("host:desktop-services")) return { ok: false, error: "Missing host:desktop-services capability" }
            if (!platform.writeClipboardText) return { ok: false, error: "Clipboard writes are only available in OpenCode Desktop" }
            return platform.writeClipboardText(text)
          },
        },
      },
      plugins: {
        list: status,
      },
      lifecycle: {
        get signal() {
          return scope.controller.signal
        },
        onDispose(fn) {
          return trackPluginScope(scope, fn)
        },
      },
    }
  }

  const activate = async (
    plugin: PluginManifest,
    conn: ServerConnection.HttpBase,
    pluginServer: ServerConnection.Key,
    signal: AbortSignal,
  ): Promise<PluginScope | undefined> => {
    const module = await moduleLoader.load(
      signal,
      () =>
        import(
          /* @vite-ignore */ pluginModuleUrl(plugin, conn.url, {
            protocol: window.location.protocol,
            origin: window.location.origin,
            allowCrossOrigin: import.meta.env.DEV,
          })
        ) as Promise<{ default?: AppPluginModule }>,
    )
    if (!module) return
    if (signal.aborted) return
    const mod = module.default
    if (!mod || typeof mod.app !== "function") throw new Error(`App plugin ${plugin.id} has no app() export`)
    const moduleID = typeof mod.id === "string" && mod.id.trim() ? mod.id.trim() : plugin.id
    if (moduleID !== plugin.id) throw new Error(`App plugin ${plugin.id} exported mismatched id ${moduleID}`)
    const id = plugin.id
    const current = store.scopes[id]
    if (current) await disposeScope(id, current)
    if (signal.aborted) return
    const scope = createScope(id)
    setStore("status", id, {
      id,
      displayName: plugin.displayName,
      enabled: true,
      active: false,
      capabilities: plugin.capabilities,
    })
    try {
      await mod.app(apiForPlugin(id, plugin, scope, conn, pluginServer), undefined, {
        id,
        spec: plugin.spec,
        version: plugin.version,
        capabilities: plugin.capabilities,
      })
    } catch (error) {
      await disposeScope(id, scope)
      throw error
    }
    if (signal.aborted) {
      await disposeScope(id, scope)
      return
    }
    if (!ownsPluginScope(store.scopes[id], scope)) {
      await disposeScope(id, scope)
      return
    }
    setStore("status", id, "active", true)
    return scope
  }

  createEffect(() => {
    const effectGeneration = ++manifestGeneration
    const effectFingerprint = activeServerFingerprint()
    if (!effectFingerprint) return
    // A different server identity gets a fresh backoff: the terminal state was
    // earned by the previous server's failures and must not poison this one.
    if (manifestRetryFingerprint !== effectFingerprint) {
      manifestRetryFingerprint = effectFingerprint
      manifestRetry = RetryBackoff.reset()
    }
    const conn = untrack(() => server.current)
    if (!conn) return
    manifestRevision()
    const directory = activePluginDirectory()
    const controller = new AbortController()
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    void (async () => {
      await Promise.resolve()
      if (controller.signal.aborted) return
      const url = new URL(`${conn.http.url.replace(/\/+$/, "")}/app/plugins`)
      if (directory) url.searchParams.set("directory", directory)
      const response = await (platform.fetch ?? fetch)(url, {
        // Cold project manifests resolve and hash local plugin files while
        // directory services start. Keep the request bounded without aborting
        // healthy cold loads after only ten seconds.
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]),
        headers: authHeaders(conn.http),
      })
      if (!response.ok) throw new Error(`Failed to load app plugin manifest: ${response.status}`)
      const seen = new Set<string>()
      const plugins = readManifest(await response.json()).filter((plugin) => {
        if (seen.has(plugin.id)) return false
        seen.add(plugin.id)
        return true
      })
      if (
        controller.signal.aborted ||
        effectGeneration !== manifestGeneration ||
        activeServerFingerprint() !== effectFingerprint
      )
        return
      manifestRetry = RetryBackoff.reset()
      const incoming = new Map(plugins.map((plugin) => [plugin.id, plugin]))
      const serverKey = ServerConnection.key(conn)
      const connectionKey = [serverKey, conn.http.url, conn.http.username ?? "", conn.http.password ?? ""].join("\n")
      for (const [id, loaded] of loadedPlugins) {
        const plugin = incoming.get(id)
        const scopeKey = plugin ? `${connectionKey}\n${pluginManifestIdentity(plugin)}` : undefined
        if (scopeKey && loaded.scopeKey === scopeKey) continue
        await disposeScope(id, loaded.scope).catch((error) =>
          console.error("[app-plugin] failed to dispose stale app plugin", { id, ...errorDetails(error) }),
        )
        loadedPlugins.delete(id)
      }
      if (
        controller.signal.aborted ||
        effectGeneration !== manifestGeneration ||
        activeServerFingerprint() !== effectFingerprint
      )
        return
      const failures = (
        await Promise.all(
          plugins.map(async (plugin) => {
            const scopeKey = `${connectionKey}\n${pluginManifestIdentity(plugin)}`
            const loaded = loadedPlugins.get(plugin.id)
            if (loaded?.scopeKey === scopeKey) return
            try {
              const activated = await activate(plugin, conn.http, serverKey, controller.signal)
              if (activated && !controller.signal.aborted) {
                loadedPlugins.set(plugin.id, { scopeKey, scope: activated })
              }
              return
            } catch (error) {
              return { plugin, error }
            }
          }),
        )
      ).filter((item): item is { plugin: PluginManifest; error: unknown } => !!item)
      if (
        controller.signal.aborted ||
        effectGeneration !== manifestGeneration ||
        activeServerFingerprint() !== effectFingerprint
      )
        return
      const stale = failures.find((failure) => stalePluginModuleError(failure.error))
      if (stale) {
        const key = `${stale.plugin.id}:${stale.plugin.version}`
        if (!retriedPluginVersions.has(key)) {
          retriedPluginVersions.add(key)
          setManifestRevision((value) => value + 1)
          return
        }
      }
      for (const failure of failures) {
        console.error("[app-plugin] failed to activate app plugin", {
          id: failure.plugin.id,
          ...errorDetails(failure.error),
        })
      }
    })().catch((error) => {
      if (
        controller.signal.aborted ||
        effectGeneration !== manifestGeneration ||
        activeServerFingerprint() !== effectFingerprint
      ) return
      manifestRetry = RetryBackoff.recordFailure(manifestRetry)
      console.error(
        manifestRetry.terminal
          ? "[app-plugin] app plugin manifest stays offline after repeated failures"
          : "[app-plugin] failed to load app plugin manifest",
        errorDetails(error),
      )
      retryTimer = setTimeout(() => {
        retryTimer = undefined
        if (effectGeneration !== manifestGeneration) return
        setManifestRevision((value) => value + 1)
      }, RetryBackoff.probeDelay(manifestRetry, MANIFEST_RECOVERY_PROBE_MS))
    })
    onCleanup(() => {
      controller.abort()
      if (retryTimer !== undefined) clearTimeout(retryTimer)
    })
  })

  onCleanup(() => {
    void untrack(() => disposeAll())
  })

  return {
    dockItems,
    slotItems: (slot) => Object.values(store.slotItems).filter((item) => item.slot === slot),
    toolbarItems,
    toolbarItemsForDirectory,
    toolbarVisibilityReady,
    toolbarOrderReady,
    toolbarItemOrder,
    toolbarItemVisible: isToolbarItemVisible,
    toolbarItemArmed,
    globalToolbarItemVisible: (id) =>
      toolbarVisibilityReady() && globalToolbarItemVisible(toolbarVisibility, id, toolbarDefaultVisible(id)),
    toolbarItemOverride: (id, directory) => toolbarItemOverride(toolbarVisibility, projectKey(directory), id),
    setGlobalToolbarItemVisible,
    setToolbarItemOverride,
    toolbarItemCanMove,
    moveToolbarItem,
    resetToolbarItemOverrides,
    activeLoadingOverlay,
    settingsItems,
    automationItems,
    settingValue,
    setSettingValue,
    routeItems,
    status,
    openDockItem,
    closeDockItem,
    invokeToolbarItem,
    runAutomationItem,
    refresh: () => setManifestRevision((value) => value + 1),
    customPartRenderer: (part) => {
      if (part.kind === "opencode/control-panel") return null
      const renderer = store.customPartRenderers[part.kind]
      return renderer ? renderer({ part: sanitizeCustomPart(part) }) : undefined
    },
    registerDockItem,
    registerSlotItem,
    registerToolbarItem,
    registerAutomationItem,
    showLoadingOverlay,
    registerSettingsItem,
    registerRouteItem,
    registerCustomPartRenderer,
    createScope,
    disposeScope,
  }
}
