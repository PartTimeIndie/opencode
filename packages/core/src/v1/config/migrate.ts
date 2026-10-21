export * as ConfigMigrateV1 from "./migrate"

import { ConfigV1 } from "./config"
import { ConfigAgentV1 } from "./agent"
import { ConfigMCPV1 } from "./mcp"
import { ConfigPermissionV1 } from "./permission"
import { ConfigProviderV1 } from "./provider"
import { ConfigProviderOptionsV1 } from "./provider-options"
import { ModelRequest } from "../../model-request"
import { legacyRequestProfiles } from "./request-profiles"
import { ConfigAgent } from "../../config/agent"
import { PermissionSchema } from "../../permission/schema"
import { Option, Schema } from "effect"

const keys = new Set([
  "logLevel",
  "server",
  "command",
  "reference",
  "snapshot",
  "plugin",
  "autoshare",
  "disabled_providers",
  "enabled_providers",
  "small_model",
  "access_control",
  "commit",
  "mode",
  "agent",
  "provider",
  "permission",
  "tools",
  "attachment",
  "layout",
])

export function isV1(input: unknown) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false
  if (Object.keys(input).some((key) => keys.has(key))) return true
  const mcp = "mcp" in input ? input.mcp : undefined
  if (typeof mcp !== "object" || mcp === null || Array.isArray(mcp) || "servers" in mcp) return false
  return Object.values(mcp).some(
    (server) =>
      typeof server === "object" && server !== null && !Array.isArray(server) && ("type" in server || "enabled" in server),
  )
}

export function migrate(info: typeof ConfigV1.Info.Type) {
  return {
    $schema: info.$schema,
    shell: info.shell,
    model: info.model,
    model_chains: info.model_chains,
    default_model_chain: info.default_model_chain,
    default_agent: info.default_agent,
    autoupdate: info.autoupdate,
    share: info.share ?? (info.autoshare ? "auto" : undefined),
    enterprise: info.enterprise,
    username: info.username,
    access_control: info.access_control,
    commit: info.commit,
    optimization: info.optimization,
    capabilities: info.capabilities,
    skill_capabilities: info.skill_capabilities,
    skill_scopes: info.skill_scopes,
    skill_invocation: info.skill_invocation,
    skill_groups: info.skill_groups,
    logging: info.logging,
    maintenance: info.maintenance,
    multi_agent: info.multi_agent,
    permissions: permissions(info.permission, info.tools),
    agents: agents(info),
    snapshots: info.snapshot,
    watcher: info.watcher,
    formatter: info.formatter,
    lsp: info.lsp,
    attachments: info.attachment,
    tool_output: info.tool_output,
    mcp: mcp(info),
    compaction: info.compaction && {
      auto: info.compaction.auto,
      prune: info.compaction.prune,
      keep: {
        tokens: info.compaction.preserve_recent_tokens,
      },
      buffer: info.compaction.reserved,
    },
    storage_cleanup: info.storage_cleanup,
    skills: info.skills && [...(info.skills.paths ?? []), ...(info.skills.urls ?? [])],
    commands: info.command,
    instructions: info.instructions,
    references: info.references ?? info.reference,
    plugins: info.plugin?.map((plugin) =>
      typeof plugin === "string" ? plugin : { package: plugin[0], options: plugin[1] },
    ),
    experimental: info.experimental && {
      policies: info.experimental.policies,
      session_orchestrator: info.experimental.session_orchestrator,
    },
    providers: providers(info.provider),
  }
}

function permissions(info?: ConfigPermissionV1.Info, tools?: Readonly<Record<string, boolean>>) {
  const rules: Array<{ action: string; resource: string; effect: ConfigPermissionV1.Action }> = Object.entries(
    tools ?? {},
  ).map(([action, enabled]) => ({
    action: ConfigAgent.toolPermissionAction(action),
    resource: "*",
    effect: enabled ? ("allow" as const) : ("deny" as const),
  }))
  for (const [action, rule] of Object.entries(info ?? {})) {
    if (!rule) continue
    if (typeof rule === "string") {
      rules.push({ action: ConfigAgent.toolPermissionAction(action), resource: "*", effect: rule })
      continue
    }
    rules.push(
      ...Object.entries(rule).map(([resource, effect]) => ({
        action: ConfigAgent.toolPermissionAction(action),
        resource,
        effect,
      })),
    )
  }
  return rules.length ? ConfigAgent.normalizeSwitchPermissions(rules) : undefined
}

function agents(info: typeof ConfigV1.Info.Type) {
  const entries = [
    ...Object.entries(info.agent ?? {}),
    ...Object.entries(info.mode ?? {}).map(([name, agent]) => [name, { ...agent, mode: "primary" as const }] as const),
  ]
  if (!entries.length) return undefined
  return Object.fromEntries(entries.flatMap(([name, agent]) => (agent ? [[name, migrateAgent(agent)]] : [])))
}

export function migrateAgent(info: ConfigAgentV1.Info) {
  const options = { ...info.options }
  const systemMode =
    options.__agentSystemMode === "inherit" ||
    options.__agentSystemMode === "append" ||
    options.__agentSystemMode === "replace"
      ? options.__agentSystemMode
      : undefined
  const instructions =
    options.__agentInstructions &&
    typeof options.__agentInstructions === "object" &&
    !Array.isArray(options.__agentInstructions)
      ? options.__agentInstructions
      : undefined
  const systemFiles = Array.isArray(options.__agentSystemFiles)
    ? options.__agentSystemFiles.filter((file): file is string => typeof file === "string")
    : undefined
  const tools =
    options.__agentTools && typeof options.__agentTools === "object" && !Array.isArray(options.__agentTools)
      ? options.__agentTools
      : undefined
  const configuredPermissions = Option.getOrUndefined(
    Schema.decodeUnknownOption(PermissionSchema.Ruleset)(options.__agentPermissions),
  )
  delete options.__agentSystemMode
  delete options.__agentSystemFiles
  delete options.__agentInstructions
  delete options.__agentTools
  delete options.__agentPermissions
  const body = {
    ...options,
    ...(info.temperature === undefined ? {} : { temperature: info.temperature }),
    ...(info.top_p === undefined ? {} : { top_p: info.top_p }),
  }
  const decodedTools = Option.getOrUndefined(Schema.decodeUnknownOption(ConfigAgent.Tools)(tools))
  const switches = ConfigAgent.normalizeSwitchConfig(
    decodedTools,
    configuredPermissions ?? permissions(info.permission) ?? [],
  )
  return {
    model: info.model,
    variant: info.variant,
    request: Object.keys(body).length ? { body } : undefined,
    system: systemMode
      ? {
          mode: systemMode,
          ...(info.prompt === undefined ? {} : { prompt: info.prompt }),
          ...(systemFiles?.length ? { files: systemFiles } : {}),
        }
      : info.prompt,
    instructions,
    tools: switches.tools,
    completion: info.completion,
    description: info.description,
    mode: info.mode,
    hidden: info.hidden,
    color: info.color,
    steps: info.steps,
    tool_budget: info.tool_budget,
    disabled: info.disable,
    permissions: switches.permissions.length > 0 ? switches.permissions : undefined,
  }
}

function mcp(info: typeof ConfigV1.Info.Type) {
  const servers = Object.fromEntries(
    Object.entries(info.mcp ?? {}).flatMap(([name, server]) =>
      "type" in server ? [[name, migrateMcp(server)] as const] : [],
    ),
  )
  const timeout = info.experimental?.mcp_timeout
  if (!timeout && !Object.keys(servers).length) return undefined
  return { timeout, servers }
}

function migrateMcp(info: ConfigMCPV1.Info) {
  const disabled = info.enabled === undefined ? undefined : !info.enabled
  if (info.type === "local")
    return {
      type: info.type,
      command: info.command,
      startup: info.startup,
      cwd: info.cwd,
      environment: info.environment,
      disabled,
      timeout: info.timeout,
    }
  return {
    type: info.type,
    url: info.url,
    startup: info.startup,
    headers: info.headers,
    oauth: info.oauth && {
      client_id: info.oauth.clientId,
      client_secret: info.oauth.clientSecret,
      scope: info.oauth.scope,
      callback_port: info.oauth.callbackPort,
      redirect_uri: info.oauth.redirectUri,
    },
    disabled,
    timeout: info.timeout,
  }
}

function providers(info?: Readonly<Record<string, ConfigProviderV1.Info>>) {
  if (!info) return undefined
  return Object.fromEntries(Object.entries(info).map(([name, provider]) => [name, migrateProvider(provider)]))
}

function migrateProvider(info: ConfigProviderV1.Info) {
  const lowerer = ConfigProviderOptionsV1.get(info.npm)
  const options = lowerer.provider(info.options ?? {})
  return {
    name: info.name,
    env: info.env,
    api: info.npm
      ? {
          type: "aisdk" as const,
          package: info.npm,
          url: info.api ?? options.url,
          settings: options.settings ?? {},
        }
      : undefined,
    request: info.options && { headers: options.headers, body: options.body },
    models:
      info.models &&
      Object.fromEntries(Object.entries(info.models).map(([name, model]) => [name, migrateModel(model, info.npm)])),
  }
}

function migrateModel(info: typeof ConfigProviderV1.Model.Type, packageName?: string) {
  const packageID = info.provider?.npm ?? packageName
  const lowerer = ConfigProviderOptionsV1.get(packageID)
  const ingest = (options: Readonly<Record<string, unknown>>) => {
    const request = ModelRequest.normalizeAiSdkOptions(packageID, options, legacyRequestProfiles)
    return { ...lowerer.request(request.body), ...request.generation, ...request.options }
  }
  const request = info.options && ingest(info.options)
  const costs = info.cost && [
    {
      input: info.cost.input,
      output: info.cost.output,
      cache: { read: info.cost.cache_read, write: info.cost.cache_write },
    },
    ...(info.cost.context_over_200k
      ? [
          {
            tier: { type: "context" as const, size: 200_000 },
            input: info.cost.context_over_200k.input,
            output: info.cost.context_over_200k.output,
            cache: { read: info.cost.context_over_200k.cache_read, write: info.cost.context_over_200k.cache_write },
          },
        ]
      : []),
  ]
  const capabilities =
    info.tool_call !== undefined || info.modalities?.input !== undefined || info.modalities?.output !== undefined
      ? { tools: info.tool_call ?? false, input: info.modalities?.input ?? [], output: info.modalities?.output ?? [] }
      : undefined
  return {
    family: info.family,
    name: info.name,
    api: info.provider?.npm
      ? {
          ...(info.id === undefined ? {} : { id: info.id }),
          type: "aisdk" as const,
          package: info.provider.npm,
          url: info.provider.api,
          settings: {},
        }
      : info.id === undefined
        ? undefined
        : { id: info.id },
    capabilities,
    request: (info.headers || request) && {
      headers: info.headers,
      body: request,
    },
    variants:
      info.variants &&
      Object.entries(info.variants).map(([id, options]) => ({
        id,
        body: ingest(options),
      })),
    cost: costs,
    disabled: info.status === "deprecated" ? true : undefined,
    limit: info.limit && {
      context: int(info.limit.context),
      input: info.limit.input === undefined ? undefined : int(info.limit.input),
      output: int(info.limit.output),
    },
  }
}

function int(value: number) {
  return Math.max(Number.MIN_SAFE_INTEGER, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value)))
}
