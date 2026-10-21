export * as SessionAgentPolicy from "./agent-policy"

import { Schema } from "effect"
import { AgentV2 } from "../agent"
import { PermissionSchema } from "../permission/schema"

export const Source = Schema.Struct({
  type: Schema.Literals(["spawn_agent", "task"]),
  sessionID: Schema.String,
  agent: AgentV2.ID,
})

export const Info = Schema.Struct({
  tools: AgentV2.ToolPolicy,
  permissionLayers: Schema.Array(PermissionSchema.Ruleset),
  source: Source,
})
export type Info = typeof Info.Type

export function derive(input: {
  parent: Info | undefined
  parentSessionID: string
  parentAgent: AgentV2.Info
  parentDelegableTools: ReadonlyArray<string>
  childTools: ReadonlyArray<string>
  type: (typeof Source.Type)["type"]
}): Info {
  const allowed = new Set(input.parentDelegableTools)
  return {
    tools: {
      mode: "explicit",
      entries: Object.fromEntries(
        input.childTools
          .filter((tool) => allowed.has(tool))
          .map((tool) => [tool, { visible: true, permission: "allow" as const }]),
      ),
    },
    permissionLayers: [...(input.parent?.permissionLayers ?? []), input.parentAgent.permissions].map((layer) =>
      layer.map((rule) => ({ ...rule })),
    ),
    source: {
      type: input.type,
      sessionID: input.parentSessionID,
      agent: input.parentAgent.id,
    },
  }
}

export function delegable(policy: AgentV2.Info["tools"]): AgentV2.Info["tools"] {
  if (!policy) return
  return {
    mode: policy.mode,
    entries: Object.fromEntries(
      Object.entries(policy.entries).map(([name, entry]) => [
        name,
        { ...entry, visible: entry.delegable ?? entry.visible },
      ]),
    ),
  }
}
