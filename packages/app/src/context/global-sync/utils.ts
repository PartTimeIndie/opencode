import type { Agent, Command, CommandV2Info, Project, ProviderListResponse } from "@opencode-ai/sdk/v2/client"
import { NormalizedProviderListResponse } from "@opencode-ai/ui/context"
export { directoryKey, type PathKey as DirectoryKey } from "@/utils/path-key"

export const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export type NormalizedCommand = Command & Pick<CommandV2Info, "requiredTools" | "aliases">

function isAgent(input: unknown): input is Agent {
  if (!input || typeof input !== "object") return false
  const item = input as { name?: unknown; mode?: unknown }
  if (typeof item.name !== "string") return false
  return item.mode === "subagent" || item.mode === "primary" || item.mode === "all"
}

export function normalizeAgentList(input: unknown): Agent[] {
  if (Array.isArray(input)) return input.filter(isAgent)
  if (isAgent(input)) return [input]
  if (!input || typeof input !== "object") return []
  return Object.values(input).filter(isAgent)
}

export function normalizeCommandList(input: CommandV2Info[]): NormalizedCommand[] {
  return input.map((command) => ({
    name: command.name,
    template: command.template,
    description: command.description,
    agent: command.agent,
    model: command.model ? `${command.model.providerID}/${command.model.id}` : undefined,
    variant: command.model?.variant,
    source: command.source,
    requiredTools: command.requiredTools,
    aliases: command.aliases,
    subtask: command.subtask,
    hints: command.hints ?? [],
  }))
}

export function normalizeProviderList(input: ProviderListResponse): NormalizedProviderListResponse {
  return {
    ...input,
    all: new Map(
      input.all.map(
        (provider) =>
          [
            provider.id,
            {
              ...provider,
              models: Object.fromEntries(
                Object.entries(provider.models).filter(([, info]) => info.status !== "deprecated"),
              ),
            },
          ] as const,
      ),
    ),
  }
}

export function sanitizeProject(project: Project) {
  if (!project.icon?.url && !project.icon?.override) return project
  return {
    ...project,
    icon: {
      ...project.icon,
      url: undefined,
      override: undefined,
    },
  }
}
