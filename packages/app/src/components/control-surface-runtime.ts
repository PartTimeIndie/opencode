import { ControlSurface } from "@opencode-ai/core/control-surface"
export type SwitchAgentAndPromptStep = {
  type: "switchAgentAndPrompt"
  agent: string
  prompt: string
  model?:
    | { mode: "planning-model" }
    | { mode: "implementation-model"; ref?: string; variant?: string }
}

export type SurfaceEffect = {
  id: string
  target: string
  value: string
}

export type SurfaceTrigger = {
  event: "change" | "submit" | "click" | "markStart" | "markEnd"
  source?: string
  when?: { field: string; equals: string | number | boolean }
}

export type ConfigTarget = {
  path: string
  format: "json" | "jsonc" | "yaml" | "toml" | "ts" | "custom"
  pointer?: string
  exportName?: string
}

export type SurfaceActionStep =
  | { type: "setValue"; target: string; value: string }
  | { type: "configWrite"; target: ConfigTarget; value?: string; debounceMs?: number }
  | { type: "livePublish"; topic?: string; value?: string; debounceMs?: number }
  | { type: "command"; command: string; arguments?: string[]; directory?: string }
  | { type: "gmail"; mode: "send" | "draft" }
  | { type: "gmx"; account: string; mode: "send" | "draft" }
  | { type: "dismiss" }
  | SwitchAgentAndPromptStep

export type SurfaceAction = {
  id: string
  trigger: SurfaceTrigger
  steps: SurfaceActionStep[]
  execution?: {
    mode: "repeatable" | "once"
    group?: string
  }
}

export type SurfaceContext = {
  values: Record<string, unknown>
  state?: Record<string, Record<string, unknown>>
  result?: Record<string, unknown>
  fallback?: unknown
}

export const agentHandoffPresentation = {
  blockedBadge: "BLOCKED AGENT SWITCH",
  blockedTitle: "Unsafe agent switch blocked",
  blockedDescription: "This request was rejected because an agent switch must be one explicit click action.",
} as const

export function agentHandoffStep(action: SurfaceAction | undefined) {
  if (!action || action.trigger.event !== "click" || action.steps.length !== 1) return
  const step = action.steps[0]
  return step?.type === "switchAgentAndPrompt" ? step : undefined
}

export function containsAgentHandoff(action: SurfaceAction | undefined) {
  return action?.steps.some((step) => step.type === "switchAgentAndPrompt") === true
}

export function surfaceContainsAgentHandoff(surface: unknown) {
  if (!isRecord(surface) || !Array.isArray(surface.actions)) return false
  return surface.actions.some(
    (action) =>
      isRecord(action) &&
      Array.isArray(action.steps) &&
      action.steps.some((step) => isRecord(step) && step.type === "switchAgentAndPrompt"),
  )
}

export function isClientExecutableSurfaceAction(action: SurfaceAction) {
  if (containsAgentHandoff(action)) return agentHandoffStep(action) !== undefined
  return action.steps.length > 0 && action.steps.every((step) =>
    step.type === "setValue" || step.type === "configWrite" || step.type === "livePublish"
  )
}

export function evaluateSurfaceExpression(value: string | undefined, context: SurfaceContext, fallback?: unknown) {
  if (value === undefined) return fallback
  return ControlSurface.evaluateExpression(value, { ...context, fallback })
}

export function surfaceStyle(effects: readonly SurfaceEffect[] | undefined, id: string, context: SurfaceContext) {
  return Object.fromEntries(
    (effects ?? [])
      .map((effect) => {
        const match = effect.target.match(/^ui\.([A-Za-z0-9_-]+)\.style\.([A-Za-z0-9_-]+)$/)
        if (!match || match[1] !== id) return
        return [match[2]!, String(evaluateSurfaceExpression(effect.value, context, ""))]
      })
      .filter((entry): entry is [string, string] => !!entry),
  )
}

export function surfaceTargetValue(effects: readonly SurfaceEffect[] | undefined, target: string, context: SurfaceContext) {
  const effect = effects?.find((effect) => effect.target === target)
  return effect ? evaluateSurfaceExpression(effect.value, context) : undefined
}

export function matchingSurfaceActions(
  actions: readonly SurfaceAction[] | undefined,
  event: SurfaceTrigger["event"],
  source: string | undefined,
  values: Record<string, unknown>,
) {
  return (actions ?? []).filter((action) => {
    if (action.trigger.event !== event) return false
    if (action.trigger.source && action.trigger.source !== source) return false
    if (!action.trigger.when) return true
    return String(values[action.trigger.when.field] ?? "") === String(action.trigger.when.equals)
  })
}

export function actionStatusLabel(action: SurfaceAction | undefined) {
  if (!action) return undefined
  if (action.steps.some((step) => step.type === "configWrite")) return "Config"
  if (action.steps.some((step) => step.type === "livePublish")) return "Live"
  if (action.steps.some((step) => step.type === "switchAgentAndPrompt")) return "Agent handoff"
  return "Action"
}

export function actionHint(action: SurfaceAction | undefined) {
  const config = action?.steps.find((step) => step.type === "configWrite")
  if (config?.type === "configWrite") return `${config.target.path}${config.target.pointer ? `:${config.target.pointer}` : ""}`
  const live = action?.steps.find((step) => step.type === "livePublish")
  if (live?.type === "livePublish") return live.topic ?? "session"
  const handoff = action?.steps.find((step) => step.type === "switchAgentAndPrompt")
  if (handoff?.type === "switchAgentAndPrompt") return handoff.agent
  return undefined
}

export function submitActionTitle(action: SurfaceAction) {
  if (action.steps.some((step) => step.type === "dismiss")) return "Form dismissed"
  if (action.steps.some((step) => step.type === "command")) return "Action completed"
  if (action.steps.some((step) => step.type === "switchAgentAndPrompt")) return "Implementation started"
  const mail = action.steps.find((step) => step.type === "gmail" || step.type === "gmx")
  if (mail?.mode === "draft") return mail.type === "gmail" ? "Gmail draft created" : "GMX draft created"
  return mail ? "Email sent" : "Action completed"
}

export function setValuePath(values: Record<string, unknown>, target: string, value: unknown) {
  const match = target.match(/^values\.([A-Za-z0-9_-]+)(?:\.(start|end))?$/)
  if (!match) return values
  if (!match[2]) return { ...values, [match[1]!]: value }
  const existing = values[match[1]!]
  return { ...values, [match[1]!]: { ...(isRecord(existing) ? existing : {}), [match[2]!]: value } }
}

export function valuePathID(target: string) {
  return target.match(/^values\.([A-Za-z0-9_-]+)/)?.[1]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
