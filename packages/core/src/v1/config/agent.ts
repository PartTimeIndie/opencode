export * as ConfigAgentV1 from "./agent"

import { Option, Schema, SchemaGetter } from "effect"
import { PositiveInt } from "../../schema"
import { ConfigPermissionV1 } from "./permission"
import { ConfigAgent } from "../../config/agent"
import { PermissionSchema } from "../../permission/schema"

const Color = Schema.Union([
  Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/)),
  Schema.Literals(["primary", "secondary", "accent", "success", "warning", "error", "info"]),
])

const StructuredSystem = Schema.Struct({
  mode: Schema.Literals(["inherit", "append", "replace"]),
  prompt: Schema.optional(Schema.String),
  files: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
})

const StructuredInstructions = Schema.Struct({
  mode: Schema.Literals(["inherit", "manual"]),
  files: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
})

const StructuredTools = Schema.Struct({
  mode: Schema.Literals(["inherit", "explicit"]),
  entries: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        visible: Schema.optional(Schema.Boolean),
        delegable: Schema.optional(Schema.Boolean),
        permission: Schema.optional(Schema.Literals(["allow", "ask", "deny"])),
        scope: Schema.optional(Schema.Struct({ mode: Schema.Literals(["global", "projects"]), projects: Schema.optional(Schema.Array(Schema.String)) })),
        projectPermissions: Schema.optional(Schema.Record(Schema.String, Schema.Literals(["allow", "ask", "deny"]))),
      }),
    ),
  ),
})
const decodeStructuredTools = Schema.decodeUnknownOption(StructuredTools)

const AgentSchema = Schema.StructWithRest(
  Schema.Struct({
    model: Schema.optional(Schema.String),
    variant: Schema.optional(Schema.String).annotate({
      description: "Default model variant for this agent (applies only when using the agent's configured model).",
    }),
    temperature: Schema.optional(Schema.Finite),
    top_p: Schema.optional(Schema.Finite),
    prompt: Schema.optional(Schema.String),
    system: Schema.optional(Schema.Union([Schema.String, StructuredSystem])),
    instructions: Schema.optional(StructuredInstructions),
    completion: Schema.optional(
      Schema.Struct({
        mode: Schema.Literals(["inherit", "custom"]),
        prompt: Schema.optional(Schema.String),
        files: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
      }),
    ),
    tools: Schema.optional(Schema.Union([Schema.Record(Schema.String, Schema.Boolean), StructuredTools])),
    disable: Schema.optional(Schema.Boolean),
    disabled: Schema.optional(Schema.Boolean),
    description: Schema.optional(Schema.String).annotate({ description: "Description of when to use the agent" }),
    mode: Schema.optional(Schema.Literals(["subagent", "primary", "all"])),
    hidden: Schema.optional(Schema.Boolean).annotate({
      description: "Hide this subagent from the @ autocomplete menu (default: false, only applies to mode: subagent)",
    }),
    options: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
    color: Schema.optional(Color).annotate({
      description: "Hex color code (e.g., #FF5733) or theme color (e.g., primary)",
    }),
    steps: Schema.optional(PositiveInt).annotate({
      description: "Maximum number of agentic iterations before forcing text-only response",
    }),
    tool_budget: Schema.optional(
      Schema.Struct({
        read: Schema.optional(PositiveInt),
        grep: Schema.optional(PositiveInt),
        glob: Schema.optional(PositiveInt),
      }),
    ),
    maxSteps: Schema.optional(PositiveInt).annotate({ description: "@deprecated Use 'steps' field instead." }),
    permission: Schema.optional(ConfigPermissionV1.Info),
    permissions: Schema.optional(Schema.Union([ConfigPermissionV1.Info, PermissionSchema.Ruleset])),
  }),
  [Schema.Record(Schema.String, Schema.Any)],
)

const KNOWN_KEYS = new Set([
  "name",
  "model",
  "variant",
  "prompt",
  "system",
  "instructions",
  "completion",
  "description",
  "temperature",
  "top_p",
  "mode",
  "hidden",
  "color",
  "steps",
  "tool_budget",
  "maxSteps",
  "options",
  "permission",
  "disable",
  "disabled",
  "tools",
  "permissions",
])

const normalize = (agent: Schema.Schema.Type<typeof AgentSchema>): Schema.Schema.Type<typeof AgentSchema> => {
  const options: Record<string, unknown> = { ...agent.options }
  for (const [key, value] of Object.entries(agent)) {
    if (!KNOWN_KEYS.has(key)) options[key] = value
  }

  const structuredTools = agent.tools && "mode" in agent.tools ? agent.tools : undefined
  const structuredPermissions = Array.isArray(agent.permissions) ? agent.permissions : undefined
  const permission: ConfigPermissionV1.Info = {}
  globalThis.Object.assign(permission, agent.permission, structuredPermissions ? undefined : agent.permissions)
  if (structuredTools?.mode === "explicit") {
    for (const [tool, entry] of Object.entries(structuredTools.entries ?? {})) {
      if (entry.visible === false || entry.permission === "deny") continue
      permission[ConfigAgent.toolPermissionAction(tool)] = entry.permission ?? "ask"
    }
    options.__agentTools = structuredTools
  } else if (structuredTools) {
    options.__agentTools = structuredTools
  } else {
    for (const [tool, enabled] of Object.entries(agent.tools ?? {})) {
      const action = enabled ? "allow" : "deny"
      if (tool === "write" || tool === "edit" || tool === "patch") {
        permission.edit = action
        continue
      }
      permission[tool] = action
    }
  }
  if (structuredPermissions) options.__agentPermissions = structuredPermissions

  const system = agent.system
  const systemMode = typeof system === "string" ? "replace" : system?.mode
  const systemPrompt = typeof system === "string" ? system : system?.prompt
  if (systemMode) options.__agentSystemMode = systemMode
  if (typeof system !== "string" && system?.files) options.__agentSystemFiles = system.files
  if (agent.instructions) options.__agentInstructions = agent.instructions

  const steps = agent.steps ?? agent.maxSteps
  const prompt = [systemPrompt, agent.prompt].filter((value): value is string => !!value).join("\n\n") || undefined
  return {
    ...agent,
    options,
    permission,
    permissions: structuredPermissions ? undefined : agent.permissions,
    disable: agent.disabled ?? agent.disable,
    prompt,
    ...(steps !== undefined ? { steps } : {}),
  }
}

export const Info = AgentSchema.pipe(
  Schema.decodeTo(AgentSchema, {
    decode: SchemaGetter.transform(normalize),
    encode: SchemaGetter.passthrough({ strict: false }),
  }),
).annotate({ identifier: "AgentConfig" })
export type Info = Schema.Schema.Type<typeof Info>

export function persisted(agent: Info): Info {
  const tools =
    agent.tools && "mode" in agent.tools
      ? agent.tools
      : (Option.getOrUndefined(decodeStructuredTools(agent.options?.__agentTools)) ?? agent.tools)
  const options = { ...(agent.options ?? {}) }
  delete options.__agentTools
  const permission = { ...(agent.permission ?? {}) }
  if (tools && "mode" in tools && tools.mode === "explicit") {
    for (const tool of Object.keys(tools.entries ?? {})) {
      const action = ConfigAgent.toolPermissionAction(tool)
      if (typeof permission[action] === "string") delete permission[action]
    }
  }
  return {
    ...agent,
    // Structured system policies are the durable source of truth. Keeping the
    // normalized legacy prompt beside them causes every settings save/reload
    // cycle to append the same system text again.
    prompt: agent.system === undefined ? agent.prompt : undefined,
    tools,
    options: Object.keys(options).length > 0 ? options : undefined,
    permission: Object.keys(permission).length > 0 ? permission : undefined,
  }
}
