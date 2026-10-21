import fuzzysort from "fuzzysort"

export type SettingsTabId =
  | "general"
  | "shortcuts"
  | "plugins"
  | "skills"
  | "servers"
  | "providers"
  | "models"
  | "vision"
  | "agents"
  | "optimizations"
  | "logging"
  | "storage"
  | "mcp"

export function canonicalSettingsTab(tab?: SettingsTabId) {
  if (tab === "skills") return "plugins" as const
  return tab ?? ("general" as const)
}

// string values are i18n keys resolved at search time; { literal } is plain text.
type Literal = { literal: string }
type Text = string | Literal

type TFunc = (key: string) => string

function resolve(t: TFunc, value: Text | undefined): string {
  if (!value) return ""
  if (typeof value === "string") return t(value) || value
  return value.literal
}

const L = (literal: string): Literal => ({ literal })

const k = (title: string, description?: string): { title: string; description?: string } => ({ title, description })

export type SettingsIndexEntry = {
  tab: SettingsTabId
  anchor?: string
  section?: Text
  title: Text
  description?: Text
  keywords?: string[]
}

export type SettingsSearchEntry = {
  tab: SettingsTabId
  anchor?: string
  section?: string
  title: string
  description?: string
  keywords?: string[]
}

export const SETTINGS_TAB_ORDER: SettingsTabId[] = [
  "general",
  "shortcuts",
  "plugins",
  "servers",
  "providers",
  "models",
  "vision",
  "agents",
  "optimizations",
  "logging",
  "storage",
  "mcp",
]

const TAB_LABEL: Record<SettingsTabId, Text> = {
  general: "settings.tab.general",
  shortcuts: "settings.shortcuts.title",
  plugins: L("Skills & Plugins"),
  skills: L("Skills"),
  servers: "status.popover.tab.servers",
  providers: "settings.providers.title",
  models: "settings.models.title",
  vision: "settings.vision.title",
  agents: "settings.agents.title",
  optimizations: "settings.optimizations.title",
  logging: "settings.logging.title",
  storage: "settings.storage.title",
  mcp: L("MCP"),
}

const INDEX: SettingsIndexEntry[] = [
  { tab: "agents", title: "settings.agents.title", description: "settings.agents.description", keywords: ["tools", "prompt", "model", "permissions", "subagent"] },
  // --- General tab -------------------------------------------------------
  // first block has no section heading
  { tab: "general", anchor: "settings-language", ...k("settings.general.row.language.title", "settings.general.row.language.description") },
  { tab: "general", anchor: "settings-auto-accept-permissions", ...k("command.permissions.autoaccept.enable", "toast.permissions.autoaccept.on.description") },
  { tab: "general", anchor: "settings-safety-review-chain", title: L("Safety-review model chain"), description: L("Approve for me uses a validated snapshot of this chain."), keywords: ["chain", "safety", "approve", "review"] },
  { tab: "general", anchor: "settings-safety-review-max-tokens", title: L("Safety max tokens"), description: L("Optional max tokens for the safety-review generation.") },
  { tab: "general", anchor: "settings-safety-review-options", title: L("Safety reasoning options"), description: L("Provider options JSON, for example reasoning or thinking settings.") },
  { tab: "general", anchor: "settings-safety-review-prompt", title: L("Safety prompt"), description: L("System prompt used for the approve-for-me safety decision.") },
  { tab: "general", anchor: "settings-shell", ...k("settings.general.row.shell.title", "settings.general.row.shell.description") },
  { tab: "general", anchor: "settings-followup-behavior", ...k("settings.general.row.followup.title", "settings.general.row.followup.description"), keywords: ["queue", "queued messages", "message queue", "followup", "follow-up", "steer"] },
  { tab: "general", anchor: "settings-feed-reasoning-summaries", ...k("settings.general.row.reasoningSummaries.title", "settings.general.row.reasoningSummaries.description") },
  { tab: "general", anchor: "settings-feed-shell-tool-parts-expanded", ...k("settings.general.row.shellToolPartsExpanded.title", "settings.general.row.shellToolPartsExpanded.description") },
  { tab: "general", anchor: "settings-feed-edit-tool-parts-expanded", ...k("settings.general.row.editToolPartsExpanded.title", "settings.general.row.editToolPartsExpanded.description") },
  { tab: "general", anchor: "settings-show-session-progress-bar", ...k("settings.general.row.showSessionProgressBar.title", "settings.general.row.showSessionProgressBar.description") },
  { tab: "general", anchor: "settings-sidebar-session-limit", ...k("settings.general.row.sidebarSessionLimit.title", "settings.general.row.sidebarSessionLimit.description") },

  // Turn completion
  { tab: "general", anchor: "settings-turn-completion-enabled", section: L("Turn completion"), title: L("Completion status"), description: L("Evaluate finished agent turns and color todo status plus the session tab dot green (done), orange (needs attention), or red (incomplete).") },
  { tab: "general", anchor: "settings-turn-completion-model", section: L("Turn completion"), title: L("Completion model or chain"), description: L("Model or fallback chain for the turn completion check.") },
  { tab: "general", anchor: "settings-turn-completion-variant", section: L("Turn completion"), title: L("Completion variant"), description: L("Optional model variant for the completion check; model targets only.") },
  { tab: "general", anchor: "settings-turn-completion-prompt", section: L("Turn completion"), title: L("Completion prompt"), description: L("Prompt used to ask whether the agent actually completed the work.") },

  // Appearance
  { tab: "general", anchor: "settings-color-scheme", section: "settings.general.section.appearance", ...k("settings.general.row.colorScheme.title", "settings.general.row.colorScheme.description"), keywords: ["dark", "light"] },
  { tab: "general", anchor: "settings-theme", section: "settings.general.section.appearance", ...k("settings.general.row.theme.title", "settings.general.row.theme.description") },
  { tab: "general", anchor: "settings-generated-project-icons", section: "settings.general.section.appearance", ...k("settings.general.row.generatedProjectIcons.title", "settings.general.row.generatedProjectIcons.description"), keywords: ["project", "icon", "image", "generate"] },
  { tab: "general", anchor: "settings-slash-command-color", section: "settings.general.section.appearance", ...k("settings.general.row.slashCommandColor.title", "settings.general.row.slashCommandColor.description"), keywords: ["composer", "slash", "command", "purple", "color"] },
  { tab: "general", anchor: "settings-ui-font", section: "settings.general.section.appearance", ...k("settings.general.row.uiFont.title", "settings.general.row.uiFont.description") },
  { tab: "general", anchor: "settings-code-font", section: "settings.general.section.appearance", ...k("settings.general.row.font.title", "settings.general.row.font.description") },
  { tab: "general", anchor: "settings-terminal-font", section: "settings.general.section.appearance", ...k("settings.general.row.terminalFont.title", "settings.general.row.terminalFont.description") },

  // Notifications
  { tab: "general", anchor: "settings-notifications-agent", section: "settings.general.section.notifications", ...k("settings.general.notifications.agent.title", "settings.general.notifications.agent.description") },
  { tab: "general", anchor: "settings-notifications-permissions", section: "settings.general.section.notifications", ...k("settings.general.notifications.permissions.title", "settings.general.notifications.permissions.description") },
  { tab: "general", anchor: "settings-notifications-errors", section: "settings.general.section.notifications", ...k("settings.general.notifications.errors.title", "settings.general.notifications.errors.description") },

  // Sounds
  { tab: "general", anchor: "settings-sounds-agent", section: "settings.general.section.sounds", ...k("settings.general.sounds.agent.title", "settings.general.sounds.agent.description") },
  { tab: "general", anchor: "settings-sounds-permissions", section: "settings.general.section.sounds", ...k("settings.general.sounds.permissions.title", "settings.general.sounds.permissions.description") },
  { tab: "general", anchor: "settings-sounds-errors", section: "settings.general.section.sounds", ...k("settings.general.sounds.errors.title", "settings.general.sounds.errors.description") },

  // Updates
  { tab: "general", anchor: "settings-release-notes", section: "settings.general.section.updates", ...k("settings.general.row.releaseNotes.title", "settings.general.row.releaseNotes.description") },
  { tab: "general", section: "settings.general.section.updates", ...k("settings.updates.row.check.title", "settings.updates.row.check.description") },

  // Display
  { tab: "general", anchor: "settings-pinch-zoom", section: "settings.general.section.display", ...k("settings.general.row.pinchZoom.title", "settings.general.row.pinchZoom.description") },
  { tab: "general", anchor: "settings-browser-automation", section: "settings.general.section.display", ...k("settings.general.row.browserAutomation.title", "settings.general.row.browserAutomation.description"), keywords: ["browser", "automation", "cdp", "playwright", "desktop testing"] },
  { tab: "general", anchor: "settings-wayland", section: "settings.general.section.display", ...k("settings.general.row.wayland.title", "settings.general.row.wayland.description"), keywords: ["linux", "x11"] },

  // Advanced
  { tab: "general", anchor: "settings-show-file-tree", section: "settings.general.section.advanced", ...k("settings.general.row.showFileTree.title", "settings.general.row.showFileTree.description") },
  { tab: "general", anchor: "settings-show-search", section: "settings.general.section.advanced", ...k("settings.general.row.showSearch.title", "settings.general.row.showSearch.description"), keywords: ["command palette"] },
  { tab: "general", anchor: "settings-show-status", section: "settings.general.section.advanced", ...k("settings.general.row.showStatus.title", "settings.general.row.showStatus.description") },
  { tab: "general", anchor: "settings-show-custom-agents", section: "settings.general.section.advanced", ...k("settings.general.row.showCustomAgents.title", "settings.general.row.showCustomAgents.description") },

  // --- Optimizations tab -------------------------------------------------
  { tab: "optimizations", anchor: "settings-optimization-profile", section: "settings.optimizations.section.profile", ...k("settings.optimizations.row.optimizationProfile.title", "settings.optimizations.row.optimizationProfile.description") },
  { tab: "optimizations", anchor: "settings-optimization-external-context-reduction", section: "settings.optimizations.section.profile", ...k("settings.optimizations.row.externalContextReduction.title", "settings.optimizations.row.externalContextReduction.description") },
  { tab: "optimizations", anchor: "settings-optimization-source-test-context-pack", section: "settings.optimizations.section.profile", ...k("settings.optimizations.row.sourceTestContextPack.title", "settings.optimizations.row.sourceTestContextPack.description") },
  { tab: "optimizations", anchor: "settings-optimization-compact-verifier-context", section: "settings.optimizations.section.profile", ...k("settings.optimizations.row.compactVerifierContext.title", "settings.optimizations.row.compactVerifierContext.description") },
  { tab: "optimizations", anchor: "settings-optimization-self-test-policy", section: "settings.optimizations.section.profile", ...k("settings.optimizations.row.selfTestPolicy.title", "settings.optimizations.row.selfTestPolicy.description") },
  { tab: "optimizations", anchor: "settings-optimization-read-deduplication", section: "settings.optimizations.section.profile", ...k("settings.optimizations.row.readDeduplication.title", "settings.optimizations.row.readDeduplication.description") },
  { tab: "optimizations", anchor: "settings-optimization-core-search-limits", section: "settings.optimizations.section.core", ...k("settings.optimizations.row.coreSearchLimits.title", "settings.optimizations.row.coreSearchLimits.description") },
  { tab: "optimizations", anchor: "settings-optimization-stable-tool-output-preview", section: "settings.optimizations.section.core", ...k("settings.optimizations.row.stableToolOutputPreview.title", "settings.optimizations.row.stableToolOutputPreview.description") },
  { tab: "optimizations", anchor: "settings-optimization-tool-materialization-cache", section: "settings.optimizations.section.core", ...k("settings.optimizations.row.toolMaterializationCache.title", "settings.optimizations.row.toolMaterializationCache.description") },
  { tab: "optimizations", anchor: "settings-optimization-deferred-tool-discovery", section: "settings.optimizations.section.core", ...k("settings.optimizations.row.deferredToolDiscovery.title", "settings.optimizations.row.deferredToolDiscovery.description") },
  { tab: "optimizations", anchor: "settings-optimization-compact-tool-schemas", section: "settings.optimizations.section.core", ...k("settings.optimizations.row.compactToolSchemas.title", "settings.optimizations.row.compactToolSchemas.description") },
  { tab: "optimizations", anchor: "settings-optimization-patch-verify-tool", section: "settings.optimizations.section.core", ...k("settings.optimizations.row.patchVerifyTool.title", "settings.optimizations.row.patchVerifyTool.description") },
  { tab: "optimizations", anchor: "settings-optimization-batch-core-tools", section: "settings.optimizations.section.core", ...k("settings.optimizations.row.batchCoreTools.title", "settings.optimizations.row.batchCoreTools.description") },
  { tab: "optimizations", anchor: "settings-optimization-session-tab-prefetch", section: "settings.optimizations.section.core", ...k("settings.optimizations.row.sessionTabPrefetch.title", "settings.optimizations.row.sessionTabPrefetch.description") },
  { tab: "optimizations", anchor: "settings-optimization-runner-request-metrics", section: "settings.optimizations.section.core", ...k("settings.optimizations.row.runnerRequestMetrics.title", "settings.optimizations.row.runnerRequestMetrics.description") },
  { tab: "optimizations", anchor: "settings-optimization-status", section: "settings.optimizations.section.diagnostics", ...k("settings.optimizations.row.status.title", "settings.optimizations.row.status.description") },

  // --- Logging tab -------------------------------------------------------
  { tab: "logging", anchor: "settings-logging-profile", section: "settings.logging.section.profile", ...k("settings.logging.row.profile.title", "settings.logging.row.profile.description") },
  { tab: "logging", anchor: "settings-logging-trace", section: "settings.logging.section.features", ...k("settings.logging.row.trace.title", "settings.logging.row.trace.description") },
  { tab: "logging", anchor: "settings-logging-performance", section: "settings.logging.section.features", ...k("settings.logging.row.performance.title", "settings.logging.row.performance.description") },
  { tab: "logging", anchor: "settings-logging-interrupts", section: "settings.logging.section.features", ...k("settings.logging.row.interrupts.title", "settings.logging.row.interrupts.description") },
  { tab: "logging", anchor: "settings-logging-optimization", section: "settings.logging.section.features", ...k("settings.logging.row.optimization.title", "settings.logging.row.optimization.description") },
  { tab: "logging", anchor: "settings-logging-ui", section: "settings.logging.section.features", ...k("settings.logging.row.ui.title", "settings.logging.row.ui.description") },

  // --- Storage tab -------------------------------------------------------
  { tab: "storage", anchor: "settings-storage-footprint", section: "settings.storage.section.footprint", title: "settings.storage.section.footprint", description: "settings.storage.description", keywords: ["database", "archive", "blob", "backup", "disk", "size"] },
  { tab: "storage", anchor: "settings-storage-cleanup", section: "settings.storage.cleanup.title", title: "settings.storage.cleanup.title", description: "settings.storage.cleanup.description", keywords: ["snapshot", "cleanup", "retention", "compaction", "backup", "disk", "limit"] },
  { tab: "storage", anchor: "settings-storage-content", section: "settings.storage.section.content", title: "settings.storage.section.content", keywords: ["sessions", "attachments", "deduplication", "blobs"] },
  { tab: "storage", anchor: "settings-storage-migration-dry-run", section: "settings.storage.section.content", title: L("Migration dry run"), keywords: ["migration", "preview", "dry run"] },
  { tab: "storage", anchor: "settings-storage-health", section: "settings.storage.section.health", title: "settings.storage.section.health", keywords: ["migration", "maintenance", "manifest", "integrity", "dry run"] },
  { tab: "storage", anchor: "settings-storage-session-retention", section: "settings.storage.section.retention", title: L("Session retention"), keywords: ["retention", "history", "cleanup", "sessions"] },
  { tab: "storage", anchor: "settings-storage-backups", section: "settings.storage.section.backups", title: "settings.storage.section.backups", description: "settings.storage.backups.description", keywords: ["rollback", "retire", "delete", "modifiedAt", "mtime"] },

  // --- Dynamic tabs (own lists / search) ---------------------------------
  { tab: "shortcuts", title: "settings.shortcuts.title", keywords: ["keyboard", "keybind", "hotkey"] },
  { tab: "plugins", title: L("Skills & Plugins"), keywords: ["skill", "skills", "plugin", "plugins", "extension", "addon"] },
  { tab: "plugins", anchor: "settings-plugin-manager", title: L("Plugin Manager"), keywords: ["plugin", "install", "extension", "addon"] },
  { tab: "plugins", anchor: "settings-plugin-toolbar", title: L("Plugin toolbar"), description: L("Choose which plugin toolbar actions are visible globally or per project."), keywords: ["plugin", "toolbar", "visibility"] },
  { tab: "servers", title: "status.popover.tab.servers", keywords: ["server"] },
  { tab: "providers", title: "settings.providers.title", keywords: ["api key", "openai", "anthropic", "credential"] },
  { tab: "models", anchor: "settings-model-picker-recent-limit", section: "settings.models.section.picker", ...k("settings.models.row.recentLimit.title", "settings.models.row.recentLimit.description"), keywords: ["recent", "model picker", "dropdown"] },
  { tab: "models", anchor: "settings-model-default-chain", section: L("Model chains"), title: L("Default model chain"), description: L("Chain used for new sessions and the Approve-for-me safety review when the composer has no chain selected."), keywords: ["chain", "default", "fallback", "safety review", "model"] },
  { tab: "models", title: "settings.models.title", keywords: ["llm", "model"] },

  // --- Vision tab --------------------------------------------------------
  { tab: "vision", anchor: "settings-vision-enabled", section: "settings.vision.title", title: "settings.vision.title", description: "settings.vision.description", keywords: ["image", "vision", "delegate", "fallback", "attachment", "picture"] },
  { tab: "vision", anchor: "settings-vision-primary", section: "settings.vision.title", title: L("Primary vision model"), description: L("Model that analyzes images the active model cannot see."), keywords: ["vision", "model", "primary"] },
  { tab: "vision", anchor: "settings-vision-add-fallback", section: "settings.vision.section.fallbacks", title: "settings.vision.row.addFallback.title", keywords: ["fallback", "vision", "rate limit"] },
  { tab: "vision", anchor: "settings-vision-prompt-template", section: "settings.vision.section.prompt", title: "settings.vision.row.template.title", description: "settings.vision.row.template.description", keywords: ["prompt", "template", "analysis"] },

  { tab: "mcp", title: L("MCP"), keywords: ["model context protocol"] },
]

export type SettingsSearchResult = {
  tab: SettingsTabId
  anchor?: string
  tabLabel: string
  section: string
  title: string
  description: string
}

type PluginSettingsSearchItem = {
  id: string
  pluginID?: string
  title: string
  searchTerms?: string[]
  searchEntries?(): Array<{ title: string; description?: string; keywords: string[] }>
  sections: Array<{
    title: string
    fields: PluginSettingsSearchField[]
  }>
}

type PluginSettingsSearchField = {
  key: string
  type: string
  label: string
  description?: string
  options?: Array<{ value: string; label: string }>
  fields?: PluginSettingsSearchField[]
}

type PluginToolbarSearchItem = {
  id: string
  pluginID?: string
  title: string
  tooltip?: string
}

export function pluginSettingsSectionAction(itemID: string, sectionIndex: number) {
  return `settings-plugin-${encodeURIComponent(itemID)}${sectionIndex === 0 ? "" : `-${sectionIndex}`}`
}

/** Dispatched after a settings search jump scrolled to an anchor; overlay rows auto-open on their own anchor. */
export const SETTINGS_ANCHOR_EVENT = "opencode:settings-anchor"

export function pluginSettingsFieldAction(itemID: string, sectionIndex: number, fieldKey: string) {
  return `${pluginSettingsSectionAction(itemID, sectionIndex)}-${encodeURIComponent(fieldKey)}`
}

export function pluginToolbarAction(itemID: string) {
  return `settings-plugin-toolbar-${encodeURIComponent(itemID)}`
}

export function pluginSettingsSearchEntries(
  items: PluginSettingsSearchItem[],
  toolbarItems: PluginToolbarSearchItem[],
): SettingsSearchEntry[] {
  return [
    ...items.flatMap((item) => (item.searchEntries?.() ?? []).map((entry) => ({
      ...entry,
      tab: "plugins" as const,
      anchor: pluginSettingsSectionAction(item.pluginID ?? item.id, 0),
      section: item.title,
    }))),
    ...toolbarItems.map((item) => ({
      tab: "plugins" as const,
      anchor: pluginToolbarAction(item.id),
      section: "Plugin toolbar",
      title: item.title,
      description: item.tooltip,
      keywords: [item.id, item.pluginID ?? "", "plugin", "toolbar"],
    })),
    ...items.flatMap((item) =>
      item.sections.flatMap((section, sectionIndex) => [
        {
          tab: "plugins" as const,
          anchor: pluginSettingsSectionAction(item.pluginID ?? item.id, sectionIndex),
          section: "Plugin settings",
          title: `${item.title} · ${section.title}`,
          keywords: [item.id, item.pluginID ?? "", "plugin", section.title, ...(item.searchTerms ?? [])],
        },
        ...section.fields.flatMap((field) => {
          const anchor = pluginSettingsFieldAction(item.pluginID ?? item.id, sectionIndex, field.key)
          const entryFor = (target: PluginSettingsSearchField) => ({
            tab: "plugins" as const,
            anchor,
            section: `${item.title} · ${section.title}`,
            title: target.label,
            description: target.description ?? target.key,
            keywords: [
              item.id,
              item.pluginID ?? "",
              target.key,
              ...(item.searchTerms ?? []),
              ...pluginFieldSearchTerms(target.fields ?? []),
              ...(target.options ?? []).flatMap((option) => [option.label, option.value]),
            ],
          })
          // Overlay fields hide nested fields behind an open button; nested entries
          // anchor to that button so the settings jump can auto-open the overlay.
          if (field.type !== "overlay") return [entryFor(field)]
          return [entryFor(field), ...(field.fields ?? []).map((child) => entryFor(child))]
        }),
      ]),
    ),
  ]
}

function pluginFieldSearchTerms(fields: PluginSettingsSearchField[]): string[] {
  return fields.flatMap((field) => [
    field.key,
    field.label,
    field.description ?? "",
    ...(field.options ?? []).flatMap((option) => [option.label, option.value]),
    ...pluginFieldSearchTerms(field.fields ?? []),
  ])
}

export function resolveTabLabel(t: TFunc, tab: SettingsTabId): string {
  return resolve(t, TAB_LABEL[tab])
}

export function searchSettings(t: TFunc, query: string, entries: SettingsSearchEntry[] = []): SettingsSearchResult[] {
  const q = query.trim().toLowerCase()
  if (!q) return []

  const items = [
    ...INDEX.map((entry) => ({
      entry,
      title: resolve(t, entry.title),
      description: resolve(t, entry.description),
      section: resolve(t, entry.section),
      keywords: (entry.keywords ?? []).join(" "),
    })),
    ...entries.map((entry) => ({
      entry,
      title: entry.title,
      description: entry.description ?? "",
      section: entry.section ?? "",
      keywords: (entry.keywords ?? []).join(" "),
    })),
  ]

  const matches =
    q.length < 5
      ? items.filter((item) =>
          [item.title, item.description, item.section, item.keywords].some((value) => value.toLowerCase().includes(q)),
        )
      : fuzzysort
          .go(q, items, {
            keys: ["title", "description", "section", "keywords"],
            threshold: -50,
          })
          .map((result) => result.obj)

  return matches.slice(0, 50).map((item) => ({
    tab: item.entry.tab,
    anchor: item.entry.anchor,
    tabLabel: resolveTabLabel(t, item.entry.tab),
    section: item.section,
    title: item.title,
    description: item.description,
  }))
}
