import type { Config, McpLocalConfig, McpRemoteConfig } from "@opencode-ai/sdk/v2/client"

export type McpServer = McpLocalConfig | McpRemoteConfig
export type McpInfo = NonNullable<Config["mcp"]>

export function configuredMcpServers(mcp: McpInfo | undefined) {
  return Object.entries(mcp ?? {})
    .filter((entry): entry is [string, McpServer] => isMcpServer(entry[1]))
    .sort(([a], [b]) => a.localeCompare(b))
}

export function addMcpServerConfig(mcp: McpInfo | undefined, input: McpServer & { name: string }) {
  return {
    mcp: {
      ...(mcp ?? {}),
      [input.name]: input.type === "remote" ? { type: "remote" as const, url: input.url } : { type: "local" as const, command: input.command },
    },
  } satisfies Pick<Config, "mcp">
}

export function removeMcpServerConfig(mcp: McpInfo | undefined, name: string) {
  return {
    mcp: Object.fromEntries(Object.entries(mcp ?? {}).filter(([serverName]) => serverName !== name)),
  } satisfies Pick<Config, "mcp">
}

export function toggleMcpServerConfig(mcp: McpInfo | undefined, name: string, server: McpServer) {
  return setMcpServerEnabled(mcp, name, server, server.enabled === false)
}

export function setMcpServerEnabled(mcp: McpInfo | undefined, name: string, server: McpServer, enabled: boolean) {
  return {
    mcp: {
      ...(mcp ?? {}),
      [name]: { ...server, enabled },
    },
  } satisfies Pick<Config, "mcp">
}

export function setProjectMcpServerAvailability(
  mcp: McpInfo | undefined,
  name: string,
  server: McpServer,
  enabled: boolean,
) {
  return {
    mcp: {
      ...(mcp ?? {}),
      [name]: enabled ? { ...server, enabled: true } : { enabled: false },
    },
  } as Pick<Config, "mcp">
}

export function mcpServerAvailableForProject(input: {
  server: McpServer
  local: unknown
  fresh: boolean
  override: boolean | undefined
  remembered: boolean | undefined
}) {
  if (typeof input.override === "boolean") return input.override
  if (input.fresh) {
    if (isDisabledMcpServer(input.local)) return false
    if (input.server.enabled !== false) return true
    return isMcpServer(input.local) && input.local.enabled !== false
  }
  if (typeof input.remembered === "boolean") return input.remembered
  return input.server.enabled !== false
}

function isDisabledMcpServer(value: unknown) {
  return typeof value === "object" && value !== null && "enabled" in value && value.enabled === false
}

function isMcpServer(value: unknown): value is McpServer {
  return typeof value === "object" && value !== null && "type" in value
}
