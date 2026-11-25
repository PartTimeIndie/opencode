export * as ConfigAgent from "./agent"

import { Schema } from "effect"
import path from "path"
import { PermissionSchema } from "../permission/schema"
import { ConfigSkillInvocation } from "./skill-invocation"
import { ConfigProvider } from "./provider"
import { PositiveInt } from "../schema"
import { Wildcard } from "../util/wildcard"

export const SWITCH_TOOL = "switch_agent"
const LEGACY_SWITCH_PREFIX = "switch_to_"

export function legacySwitchTarget(tool: string) {
  if (!tool.startsWith(LEGACY_SWITCH_PREFIX)) return
  const target = tool.slice(LEGACY_SWITCH_PREFIX.length)
  return /^[A-Za-z0-9_-]+$/.test(target) ? target : undefined
}

export const Color = Schema.Union([
  Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/)),
  Schema.Literals(["primary", "secondary", "accent", "success", "warning", "error", "info"]),
])

export const System = Schema.Union([
  Schema.String,
  Schema.Struct({
    mode: Schema.Literals(["inherit", "append", "replace"]),
    prompt: Schema.String.pipe(Schema.optional),
    files: Schema.Array(Schema.String).pipe(Schema.optional),
  }),
])

export const Instructions = Schema.Struct({
  mode: Schema.Literals(["inherit", "manual"]),
  files: Schema.Array(Schema.String).pipe(Schema.optional),
})

export const ToolEntry = Schema.Struct({
  visible: Schema.Boolean.pipe(Schema.optional),
  delegable: Schema.Boolean.pipe(Schema.optional),
  permission: Schema.Literals(["allow", "ask", "deny"]).pipe(Schema.optional),
  scope: Schema.Struct({ mode: Schema.Literals(["global", "projects"]), projects: Schema.Array(Schema.String).pipe(Schema.optional) }).pipe(Schema.optional),
  projectPermissions: Schema.Record(Schema.String, Schema.Literals(["allow", "ask", "deny"])).pipe(Schema.optional),
})

export function projectPathKey(directory: string) {
  const value = directory.replaceAll("\\", "/")
  const normalized = path.posix.normalize(value).replace(/\/+$/, "") || "/"
  return /^[a-zA-Z]:\//.test(normalized) || value.startsWith("//") ? normalized.toLowerCase() : normalized
}

export function projectScopeAllows(scope: { mode: "global" | "projects"; projects?: readonly string[] } | undefined, directory: string) {
  if (!scope || scope.mode === "global") return true
  return scope.projects?.some((project) => projectPathKey(project) === projectPathKey(directory)) ?? false
}

export function projectPermissionForPath(permissions: Record<string, "allow" | "ask" | "deny"> | undefined, directory: string) {
  return Object.entries(permissions ?? {}).find(([project]) => projectPathKey(project) === projectPathKey(directory))?.[1]
}

export const Tools = Schema.Struct({
  mode: Schema.Literals(["inherit", "explicit"]),
  entries: Schema.Record(Schema.String, ToolEntry).pipe(Schema.optional),
})

/** Inheritance is a sparse field override; only explicit mode replaces the list. */
export function mergeTools(base: typeof Tools.Type | undefined, next: typeof Tools.Type): typeof Tools.Type {
  if (next.mode === "explicit" || !base) return next
  const entries = { ...base.entries }
  for (const [name, entry] of Object.entries(next.entries ?? {})) {
    entries[name] = { ...entries[name], ...entry }
  }
  return { mode: "inherit", ...(base.entries || next.entries ? { entries } : {}) }
}

export function toolPermissionAction(tool: string) {
  if (tool === "write" || tool === "patch" || tool === "apply_patch") return "edit"
  if (tool === "question" || tool === "control_panel") return "surface"
  return tool
}

export function normalizeSwitchPermissions(rules: PermissionSchema.Ruleset): PermissionSchema.Ruleset {
  const canonical = rules.filter((rule) => rule.action === SWITCH_TOOL)
  const migrated = rules
    .filter((rule) => rule.action !== SWITCH_TOOL)
    .flatMap((rule): PermissionSchema.Rule[] => {
      const target = legacySwitchTarget(rule.action)
      if (!target) return rule.action.startsWith(LEGACY_SWITCH_PREFIX) ? [] : [rule]
      if (!Wildcard.match(target, rule.resource)) return []
      return [{ ...rule, action: SWITCH_TOOL, resource: target }]
    })
  return [...migrated, ...canonical]
}

export function normalizeSwitchConfig(
  tools: typeof Tools.Type | undefined,
  permissions: PermissionSchema.Ruleset,
): { tools: typeof Tools.Type | undefined; permissions: PermissionSchema.Ruleset } {
  const entries = tools?.entries ?? {}
  const canonical = entries[SWITCH_TOOL]
  const legacy = Object.entries(entries).flatMap(([tool, entry]) => {
    const target = legacySwitchTarget(tool)
    return target ? [{ target, entry }] : []
  })
  const clean = Object.fromEntries(Object.entries(entries).filter(([tool]) => !tool.startsWith(LEGACY_SWITCH_PREFIX)))
  if (canonical || legacy.length === 0)
    return {
      tools: tools ? { ...tools, entries: clean } : undefined,
      permissions: normalizeSwitchPermissions(permissions),
    }

  const enabled = legacy.some((item) => item.entry.visible !== false && item.entry.permission !== "deny")
  return {
    tools: tools
      ? {
          ...tools,
          entries: {
            ...clean,
            [SWITCH_TOOL]: { visible: enabled, permission: enabled ? ("allow" as const) : ("deny" as const) },
          },
        }
      : undefined,
    permissions: [
      { action: SWITCH_TOOL, resource: "*", effect: "deny" },
      ...legacy.map((item): PermissionSchema.Rule => ({
        action: SWITCH_TOOL,
        resource: item.target,
        effect: item.entry.visible === false ? "deny" : (item.entry.permission ?? "allow"),
      })),
      ...normalizeSwitchPermissions(permissions),
    ],
  }
}

export const Completion = Schema.Struct({
  mode: Schema.Literals(["inherit", "custom"]),
  prompt: Schema.String.pipe(Schema.optional),
  files: Schema.Array(Schema.String).pipe(Schema.optional),
})

export const ToolBudget = Schema.Struct({
  read: PositiveInt.pipe(Schema.optional),
  grep: PositiveInt.pipe(Schema.optional),
  glob: PositiveInt.pipe(Schema.optional),
})

export class Info extends Schema.Class<Info>("ConfigV2.Agent")({
  model: Schema.String.pipe(Schema.optional),
  variant: Schema.String.pipe(Schema.optional),
  request: ConfigProvider.Request.pipe(Schema.optional),
  system: System.pipe(Schema.optional),
  instructions: Instructions.pipe(Schema.optional),
  tools: Tools.pipe(Schema.optional),
  completion: Completion.pipe(Schema.optional),
  description: Schema.String.pipe(Schema.optional),
  mode: Schema.Literals(["subagent", "primary", "all"]).pipe(Schema.optional),
  hidden: Schema.Boolean.pipe(Schema.optional),
  color: Color.pipe(Schema.optional),
  steps: PositiveInt.pipe(Schema.optional),
  tool_budget: ToolBudget.pipe(Schema.optional),
  disabled: Schema.Boolean.pipe(Schema.optional),
  permissions: PermissionSchema.Ruleset.pipe(Schema.optional),
  skills: Schema.Record(Schema.String, ConfigSkillInvocation.SkillEntry).pipe(Schema.optional),
}) {}
