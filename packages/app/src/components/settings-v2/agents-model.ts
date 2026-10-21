import type { AgentConfig, Config, PermissionConfig } from "@opencode-ai/sdk/v2/client"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { projectDirectoryKey } from "@/utils/path-key"

const switchTool = "switch_agent"
const legacySwitchPrefix = "switch_to_"

export type ToolPermissionAction = "inherit" | "allow" | "ask" | "deny" | "custom"
export type PermissionMap = Exclude<PermissionConfig, string>
export type AgentSystemPolicy = { mode: "inherit" | "append" | "replace"; prompt?: string; files?: string[] }
export type AgentInstructionPolicy = { mode: "inherit" | "manual"; files?: string[] }
export type AgentToolEntry = {
  visible?: boolean
  delegable?: boolean
  permission?: "allow" | "ask" | "deny"
  scope?: { mode: "global" | "projects"; projects?: string[] }
  projectPermissions?: Record<string, "allow" | "ask" | "deny">
}
export type AgentToolPolicy = { mode: "inherit" | "explicit"; entries?: Record<string, AgentToolEntry> }
export type AgentCompletionPolicy = { mode: "inherit" | "custom"; prompt?: string; files?: string[] }

export type ConfigurableAgent = {
  model?: string
  variant?: string
  temperature?: number
  top_p?: number
  prompt?: string
  disable?: boolean
  description?: string
  mode?: "subagent" | "primary" | "all"
  hidden?: boolean
  options?: Record<string, unknown>
  color?: string
  steps?: number
  maxSteps?: number
  permission?: PermissionConfig
  system?: string | AgentSystemPolicy
  instructions?: AgentInstructionPolicy
  tools?: AgentConfig["tools"] | AgentToolPolicy
  completion?: AgentCompletionPolicy
  [key: string]: unknown
}

export type RuntimeAgent = {
  name: string
  description?: string
  mode?: "subagent" | "primary" | "all"
  hidden?: boolean
  model?: { providerID: string; modelID: string; chain?: { id: string } | null }
  modelTarget?: string
  variant?: string
}

export type AgentChoice = {
  id: string
  config: ConfigurableAgent
  builtIn: boolean
  hidden: boolean
}

export type ToolCatalogEntry = {
  id: string
  description?: string
  scope: "application" | "location"
  project?: string
  visible: boolean
}

export function permissionMap(permission: PermissionConfig | undefined): PermissionMap {
  if (!permission) return {}
  if (typeof permission === "string") return { "*": permission }
  const entries = Object.entries(permission)
  const clean = Object.fromEntries(entries.filter(([tool]) => !tool.startsWith(legacySwitchPrefix)))
  if (permission[switchTool] !== undefined) return clean
  const targets = Object.fromEntries(
    entries.flatMap(([tool, rule]) => {
      const target = legacySwitchTarget(tool)
      if (!target) return []
      if (!rule) return []
      if (typeof rule === "string") return [[target, rule]]
      const action = Object.entries(rule).findLast(([pattern]) => Wildcard.match(target, pattern))?.[1]
      return action ? [[target, action]] : []
    }),
  )
  if (Object.keys(targets).length === 0) return clean
  return { ...clean, [switchTool]: { "*": "deny", ...targets } }
}

export function normalizeAgentID(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

export function configuredAgents(config: Config, runtime: RuntimeAgent[] = []): AgentChoice[] {
  const configured = (config.agent ?? {}) as Record<string, ConfigurableAgent | undefined>
  const resolved = new Map<string, AgentChoice>()
  for (const item of runtime) {
    const saved = configured[item.name]
    resolved.set(item.name, {
      id: item.name,
      builtIn: !saved,
      hidden: saved?.hidden ?? item.hidden ?? false,
      config: {
        description: item.description,
        mode: item.mode,
        model: item.modelTarget ?? (item.model?.chain?.id ? `chain:${item.model.chain.id}` : item.model ? `${item.model.providerID}/${item.model.modelID}` : undefined),
        variant: item.variant,
        ...saved,
      },
    })
  }
  for (const [id, item] of Object.entries(configured)) {
    if (!item || resolved.has(id)) continue
    resolved.set(id, { id, config: item, builtIn: false, hidden: item.hidden === true })
  }
  return [...resolved.values()].sort((a, b) => a.id.localeCompare(b.id))
}

export function systemPolicy(agent: ConfigurableAgent): AgentSystemPolicy {
  if (typeof agent.system === "string") return { mode: "replace", prompt: agent.system }
  return agent.system ?? { mode: "inherit" }
}

export function instructionPolicy(agent: ConfigurableAgent): AgentInstructionPolicy {
  return agent.instructions ?? { mode: "inherit" }
}

export function toolPolicy(agent: ConfigurableAgent): AgentToolPolicy {
  const value = agent.tools
  const direct = structuredToolPolicy(value)
  if (direct) return direct
  const migrated = structuredToolPolicy(agent.options?.__agentTools)
  if (migrated) return migrated
  if (!value) return agent.permission ? { mode: "explicit" } : { mode: "inherit" }
  return {
    mode: "explicit",
    entries: Object.fromEntries(Object.entries(value as Record<string, boolean>).map(([id, visible]) => [id, { visible }])),
  }
}

export function completionPolicy(agent: ConfigurableAgent): AgentCompletionPolicy {
  return agent.completion ?? { mode: "inherit" }
}

export function toolEntry(agent: ConfigurableAgent, tool: string): AgentToolEntry {
  const policy = toolPolicy(agent)
  const entry = policy.entries?.[tool]
  if (entry) return entry
  if (tool === switchTool) return { visible: false, permission: "deny" }
  if (agent.tools && "mode" in agent.tools && agent.tools.mode === "explicit") {
    return { visible: false, permission: "deny" }
  }
  const action = effectiveToolPermissionAction(agent.permission, tool)
  return {
    visible: action !== "deny",
    permission: action === "allow" || action === "ask" || action === "deny" ? action : undefined,
  }
}

export function setAgentToolEntry(agent: ConfigurableAgent, tool: string, entry: AgentToolEntry): ConfigurableAgent {
  const policy = toolPolicy(agent)
  return {
    ...agent,
    tools: {
      mode: "explicit",
      entries: { ...(policy.entries ?? {}), [tool]: { ...toolEntry(agent, tool), ...entry } },
    },
  }
}

export function setAgentToolProjectScope(agent: ConfigurableAgent, tool: string, scope: NonNullable<AgentToolEntry["scope"]>) {
  return setAgentToolEntry(agent, tool, { ...toolEntry(agent, tool), scope })
}

export function setAgentToolProjectPermission(agent: ConfigurableAgent, tool: string, project: string, permission: "inherit" | "allow" | "ask" | "deny") {
  const current = toolEntry(agent, tool)
  const entries = Object.fromEntries(Object.entries(current.projectPermissions ?? {}).filter(([directory]) => projectDirectoryKey(directory) !== projectDirectoryKey(project)))
  if (permission !== "inherit") entries[project] = permission
  return setAgentToolEntry(agent, tool, { ...current, projectPermissions: Object.keys(entries).length ? entries : undefined })
}

export function projectPermission(entry: AgentToolEntry, project: string) {
  return Object.entries(entry.projectPermissions ?? {}).find(([directory]) => projectDirectoryKey(directory) === projectDirectoryKey(project))?.[1] ?? "inherit"
}

// Snapshot every catalog tool's effective state when entering explicit mode. Without
// this, switching a single tool (or the mode dropdown) to "explicit" leaves every
// other tool without an entry, and the explicit-mode fallback in toolEntry hides
// them all at once. Materializing preserves the inherited visible/permission state
// so toggling one tool only changes that tool.
export function materializeToolEntries(
  agent: ConfigurableAgent,
  catalog: ReadonlyArray<string | ToolCatalogEntry>,
): ConfigurableAgent {
  const entries: Record<string, AgentToolEntry> = { ...(toolPolicy(agent).entries ?? {}) }
  for (const item of catalog) {
    const id = typeof item === "string" ? item : item.id
    const current = toolEntry(agent, id)
    const visible = current.visible !== false && (typeof item === "string" || item.visible)
    entries[id] = { ...current, visible, permission: visible ? current.permission : "deny" }
  }
  return { ...agent, tools: { mode: "explicit", entries } }
}

export function toolPermissionAction(permission: PermissionConfig | undefined, tool: string): ToolPermissionAction {
  const value = permissionMap(permission)[tool]
  if (value === "allow" || value === "ask" || value === "deny") return value
  if (value === undefined) return "inherit"
  return "custom"
}

export function effectiveToolPermissionAction(
  permission: PermissionConfig | undefined,
  tool: string,
): ToolPermissionAction {
  const map = permissionMap(permission)
  const direct = toolPermissionAction(map, tool)
  if (direct !== "inherit") return direct
  return toolPermissionAction(map, "*")
}

export function isToolAvailable(permission: PermissionConfig | undefined, tool: string) {
  return effectiveToolPermissionAction(permission, tool) !== "deny"
}

export function setToolAvailability(permission: PermissionConfig | undefined, tool: string, available: boolean) {
  if (!available) return setToolPermission(permission, tool, "deny")
  if (isToolAvailable(permission, tool)) return permissionMap(permission)
  return setToolPermission(permission, tool, "ask")
}

export function setToolPermission(
  permission: PermissionConfig | undefined,
  tool: string,
  action: Exclude<ToolPermissionAction, "custom">,
) {
  const next = permissionMap(permission)
  if (action === "inherit") delete next[tool]
  else next[tool] = action
  return next
}

export function saveAgent(id: string, agent: ConfigurableAgent): Config {
  if (hasLegacySwitchConfig(agent)) {
    const permission = permissionMap(agent.permission)
    const legacy = legacySwitchPermission(agent.tools) ?? legacySwitchPermission(agent.options?.__agentTools)
    const tools = hasLegacySwitchTools(agent) ? toolPolicy(agent) : agent.tools
    const options = { ...agent.options }
    delete options.__agentTools
    return {
      agent: {
        [id]: {
          ...agent,
          tools,
          permission:
            permission[switchTool] === undefined && legacy
              ? { ...permission, [switchTool]: legacy }
              : permission,
          options: Object.keys(options).length > 0 ? options : undefined,
        } as unknown as AgentConfig,
      },
    }
  }
  return {
    agent: {
      [id]: agent as unknown as AgentConfig,
    },
  }
}

function structuredToolPolicy(value: unknown): AgentToolPolicy | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const policy = value as Record<string, unknown>
  if (policy.mode !== "inherit" && policy.mode !== "explicit") return
  if (!policy.entries || typeof policy.entries !== "object" || Array.isArray(policy.entries)) {
    return { mode: policy.mode }
  }
  const parsed = Object.fromEntries(
    Object.entries(policy.entries).flatMap(([id, candidate]) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return []
      const entry = candidate as Record<string, unknown>
      const visible = typeof entry.visible === "boolean" ? entry.visible : undefined
      const permission =
        entry.permission === "allow" || entry.permission === "ask" || entry.permission === "deny"
          ? entry.permission
          : undefined
      const scope = entry.scope && typeof entry.scope === "object" && !Array.isArray(entry.scope) ? entry.scope as Record<string, unknown> : undefined
      const projectPermissions = entry.projectPermissions && typeof entry.projectPermissions === "object" && !Array.isArray(entry.projectPermissions) ? entry.projectPermissions as Record<string, unknown> : undefined
      return [[id, {
        visible,
        permission,
        ...(typeof entry.delegable === "boolean" ? { delegable: entry.delegable } : {}),
        ...(scope && (scope.mode === "global" || scope.mode === "projects") ? {
          scope: { mode: scope.mode, ...(Array.isArray(scope.projects) ? { projects: scope.projects.filter((item): item is string => typeof item === "string") } : {}) },
        } : {}),
        ...(projectPermissions ? { projectPermissions: Object.fromEntries(Object.entries(projectPermissions).filter(([, action]) => action === "allow" || action === "ask" || action === "deny")) as Record<string, "allow" | "ask" | "deny"> } : {}),
      } satisfies AgentToolEntry]]
    }),
  )
  const canonical = parsed[switchTool]
  const clean = Object.fromEntries(Object.entries(parsed).filter(([tool]) => !tool.startsWith(legacySwitchPrefix)))
  const legacy = Object.entries(parsed).filter(([tool]) => legacySwitchTarget(tool))
  const entries = canonical || legacy.length === 0
    ? clean
    : {
        ...clean,
        [switchTool]: {
          visible: legacy.some(([, entry]) => entry.visible !== false && entry.permission !== "deny"),
          permission: legacy.some(([, entry]) => entry.visible !== false && entry.permission !== "deny")
            ? ("allow" as const)
            : ("deny" as const),
        },
      }
  return { mode: policy.mode, entries }
}

function legacySwitchTarget(tool: string) {
  if (!tool.startsWith(legacySwitchPrefix)) return
  const target = tool.slice(legacySwitchPrefix.length)
  return /^[A-Za-z0-9_-]+$/.test(target) ? target : undefined
}

function hasLegacySwitchConfig(agent: ConfigurableAgent) {
  const permissions = typeof agent.permission === "object" && agent.permission !== null
    ? Object.keys(agent.permission)
    : []
  const tools = [agent.tools, agent.options?.__agentTools].flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return []
    const policy = value as Record<string, unknown>
    const entries = policy.entries && typeof policy.entries === "object" && !Array.isArray(policy.entries)
      ? policy.entries as Record<string, unknown>
      : policy
    return Object.keys(entries)
  })
  return [...permissions, ...tools].some((key) => key.startsWith(legacySwitchPrefix))
}

function hasLegacySwitchTools(agent: ConfigurableAgent) {
  return [agent.tools, agent.options?.__agentTools].some((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    const policy = value as Record<string, unknown>
    const entries = policy.entries && typeof policy.entries === "object" && !Array.isArray(policy.entries)
      ? policy.entries as Record<string, unknown>
      : policy
    return Object.keys(entries).some((key) => key.startsWith(legacySwitchPrefix))
  })
}

function legacySwitchPermission(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const policy = value as Record<string, unknown>
  const entries = policy.entries && typeof policy.entries === "object" && !Array.isArray(policy.entries)
    ? policy.entries as Record<string, unknown>
    : policy
  const targets = Object.fromEntries(
    Object.entries(entries).flatMap(([tool, candidate]) => {
      const target = legacySwitchTarget(tool)
      if (!target || !candidate || typeof candidate !== "object" || Array.isArray(candidate)) return []
      const entry = candidate as Record<string, unknown>
      const effect = entry.visible === false || entry.permission === "deny"
        ? "deny"
        : entry.permission === "ask"
          ? "ask"
          : "allow"
      return [[target, effect]]
    }),
  )
  return Object.keys(targets).length > 0 ? { "*": "deny" as const, ...targets } : undefined
}

export function newAgentID(config: Config, base = "new-agent") {
  const ids = new Set(Object.keys(config.agent ?? {}))
  if (!ids.has(base)) return base
  let index = 2
  while (ids.has(`${base}-${index}`)) index++
  return `${base}-${index}`
}

export function normalizeToolCatalog(value: unknown): ToolCatalogEntry[] {
  if (!Array.isArray(value)) return []
  return value
    .flatMap((item): ToolCatalogEntry[] => {
      if (typeof item === "string") return [{ id: item, scope: "application", visible: true }]
      if (!item || typeof item !== "object") return []
      const data = item as Record<string, unknown>
      if (typeof data.id !== "string") return []
      return [{
        id: data.id,
        description: typeof data.description === "string" ? data.description : undefined,
        scope: data.scope === "location" ? "location" : "application",
        project: typeof data.project === "string" ? data.project : undefined,
        visible: data.visible !== false,
      }]
    })
    .sort((a, b) => a.id.localeCompare(b.id))
}

export function filterToolCatalog(catalog: ToolCatalogEntry[], query: string) {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return catalog
  return catalog.filter((item) =>
    `${item.id} ${item.description ?? ""} ${item.project ?? ""}`.toLowerCase().includes(normalized),
  )
}

export function isCatalogToolVisible(agent: ConfigurableAgent, item: ToolCatalogEntry) {
  if (toolPolicy(agent).mode === "explicit") return toolEntry(agent, item.id).visible !== false
  return item.visible && toolEntry(agent, item.id).visible !== false
}
