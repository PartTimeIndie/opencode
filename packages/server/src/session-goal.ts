import { randomUUID } from "node:crypto"

export const SessionGoalMetadataKey = "opencode.session.goal"
const SessionGoalRunMetadataKey = "opencode.session.goal_run"
const SessionGoalStatusMetadataKey = "opencode.session.goal_status"

export type SessionGoalControl =
  | { readonly type: "set"; readonly value: string }
  | { readonly type: "clear" }
  | { readonly type: "status" }
  | { readonly type: "focus" }
  | { readonly type: "plugin" }

export type SessionGoalMetadataPatch =
  { readonly set: Readonly<Record<string, unknown>>; readonly unset?: readonly string[] } | { readonly unset: readonly string[] }

const clearCommands = new Set(["clear", "stop", "off", "reset", "none", "cancel"])
const statusCommands = new Set(["status", "history", "list", "pause", "resume"])

export function parseSessionGoalControl(argumentsText: string): SessionGoalControl | undefined {
  const args = argumentsText.trim()
  if (!args) return

  const match = args.match(/^(\S+)(?:\s+([\s\S]*))?$/)
  if (!match) return
  const command = match[1].toLowerCase()
  const value = match[2]?.trim() ?? ""

  if (clearCommands.has(command)) return value ? undefined : { type: "clear" }
  if (statusCommands.has(command)) return value ? undefined : { type: "status" }
  if (command === "focus") return { type: "focus" }
  // Stateful controls must reach the plugin with its previous focused goal
  // intact: replacing metadata first would discard budgets and goal ordering.
  if (command === "edit" || command === "add" || command === "sisyphus") {
    return value ? { type: "plugin" } : undefined
  }
  if (command === "set") {
    return value ? { type: "set", value } : undefined
  }

  // Keep the existing free-form `/goal <text>` behavior while explicit,
  // malformed controls remain available to the model for clarification.
  return { type: "set", value: args }
}

export function sessionGoalMetadataPatch(control: SessionGoalControl): SessionGoalMetadataPatch | undefined {
  // A same-text replacement is still a new run. Publish identity with the text
  // in one metadata patch so an older run's CAS clear cannot erase it.
  if (control.type === "set") return {
    set: { [SessionGoalMetadataKey]: control.value, [SessionGoalRunMetadataKey]: randomUUID() },
    unset: [SessionGoalStatusMetadataKey],
  }
  if (control.type === "clear") return { unset: [SessionGoalMetadataKey, SessionGoalRunMetadataKey, SessionGoalStatusMetadataKey] }
  return undefined
}
