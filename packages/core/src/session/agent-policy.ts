export * as SessionAgentPolicy from "./agent-policy"

import { Schema } from "effect"
import { ToolDefinition } from "@opencode-ai/llm"
import { AgentV2 } from "../agent"
import { PermissionSchema } from "../permission/schema"
import { isDeepStrictEqual } from "node:util"
import { WorkspaceBasis } from "./workspace/basis"
import { TaskContext } from "./task-context"

export const Source = Schema.Struct({
  // `orchestrator` is a stored-history discriminant, never a new admission type.
  type: Schema.Literals(["spawn_agent", "task", "orchestrator"]),
  sessionID: Schema.String,
  agent: AgentV2.ID,
})

/** Host-owned physical execution ceiling, never inherited by derive(). */
export const ExecutionPlacement = Schema.Struct({
  version: Schema.Literal(1),
  directory: Schema.String,
  checkout: Schema.String,
  identity: Schema.String,
})
export type ExecutionPlacement = typeof ExecutionPlacement.Type

/** Native PermissionV2 single-use receipt, bound to one admitted task and the
 * exact physical Main checkout. Context and derived children never inherit it. */
export const MainWriteConsent = Schema.Struct({
  version: Schema.Literal(1),
  permissionID: Schema.String.check(Schema.isStartsWith("per")),
  inputID: Schema.String,
  dispatchDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  placementIdentity: Schema.String,
})

/** Replayable host-owned private workspace and immutable source basis. This
 * binding is not a permission grant or approval to integrate into Main. */
export const MirrorWorkspace = Schema.Struct({
  version: Schema.Literal(1),
  directory: Schema.String,
  taskID: Schema.String,
  inputID: Schema.String,
  dispatchDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  sourcePlacement: ExecutionPlacement,
  basis: WorkspaceBasis.Manifest,
  basisDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
})

export const Info = Schema.Struct({
  tools: AgentV2.ToolPolicy,
  permissionLayers: Schema.Array(PermissionSchema.Ruleset),
  source: Source,
  executionPlacement: ExecutionPlacement.pipe(Schema.optional),
  mainWriteConsent: MainWriteConsent.pipe(Schema.optional),
  readOnly: Schema.Boolean.pipe(Schema.optional),
  readOnlyInputID: Schema.String.pipe(Schema.optional),
  mirrorWorkspace: MirrorWorkspace.pipe(Schema.optional),
  // Host-selected initial history mode. derive() never passes it to grandchildren.
  taskContext: TaskContext.Mode.pipe(Schema.optional),
  // Historical provider schemas only. Execution still uses `tools` and live
  // permission/capability checks; this field is not delegated by derive().
  cacheTools: Schema.Array(Schema.Struct(ToolDefinition.fields)).pipe(Schema.optional),
})
export type Info = typeof Info.Type

const READ_ONLY_TOOLS = ["read", "grep", "glob"]
const readOnlyRules: PermissionSchema.Ruleset = [{ action: "*", resource: "*", effect: "deny" },
  ...READ_ONLY_TOOLS.map((action) => ({ action, resource: "*", effect: "allow" as const }))]

/** Restrict both schema materialization and direct permission-checked entry
 * points (including Shell). The flag alone is never the restriction. */
export function restrictReadOnly(policy: Info, inputID: string): Info {
  const copied = structuredClone(policy)
  return { ...copied, readOnly: true, readOnlyInputID: inputID, tools: { mode: "explicit", entries: Object.fromEntries(
    Object.entries(copied.tools.entries).filter(([name]) => READ_ONLY_TOOLS.includes(name)),
  ) }, permissionLayers: [...copied.permissionLayers, structuredClone(readOnlyRules)] }
}

export function isReadOnly(policy: Info | undefined) {
  return policy?.readOnly === true && Boolean(policy.readOnlyInputID) && policy.tools.mode === "explicit" &&
    Object.keys(policy.tools.entries).every((name) => READ_ONLY_TOOLS.includes(name)) &&
    policy.permissionLayers.some((layer) => isDeepStrictEqual(layer, readOnlyRules))
}

export function derive(input: {
  parent: Info | undefined
  parentSessionID: string
  parentAgent: AgentV2.Info
  parentDelegableTools: ReadonlyArray<string>
  childTools: ReadonlyArray<string>
  type: "spawn_agent" | "task"
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
