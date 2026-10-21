export * as OrchestratorPolicy from "./policy"

import { Schema } from "effect"
import path from "path"
import { OrchestratorCheckout } from "./checkout"

export const WorkspaceMode = Schema.Literals(["mirror", "shared"])
export type WorkspaceMode = typeof WorkspaceMode.Type
export const Control = Schema.Literals(["active", "draining", "paused"])
export type Control = typeof Control.Type
export const TaskState = Schema.Literals([
  "planned",
  "waiting",
  "reserved",
  "snapshotting",
  "starting",
  "checking_cache",
  "running",
  "reviewing",
  "integrating",
  "done",
  "blocked_cache",
  "blocked_decision",
  "paused",
  "failed",
  "cancelled",
])
export type TaskState = typeof TaskState.Type

export const defaults = {
  interaction: true,
  workspaceMode: "mirror" as const,
  maxWorkers: 4,
  minCacheReadRatio: 0.8,
}

export type Settings = {
  readonly interaction: boolean
  readonly workspaceMode: WorkspaceMode
  readonly maxWorkers: number
  readonly minCacheReadRatio: number
}

export function validSettings(input: Settings) {
  return (
    typeof input.interaction === "boolean" &&
    (input.workspaceMode === "mirror" || input.workspaceMode === "shared") &&
    Number.isSafeInteger(input.maxWorkers) &&
    input.maxWorkers >= 1 &&
    Number.isFinite(input.minCacheReadRatio) &&
    input.minCacheReadRatio >= 0 &&
    input.minCacheReadRatio <= 1
  )
}

export type CacheUsage = {
  readonly inputTokens?: number
  readonly cacheReadInputTokens?: number
}
export type CacheEvidence =
  { readonly status: "unknown" } | { readonly status: "accepted" | "low"; readonly ratio: number }

/** Missing or contradictory provider usage is not evidence of a hit or a miss. */
export function cacheEvidence(usage: CacheUsage, threshold = defaults.minCacheReadRatio): CacheEvidence {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new RangeError("Invalid cache threshold")
  const input = usage.inputTokens
  const cached = usage.cacheReadInputTokens
  if (
    input === undefined ||
    cached === undefined ||
    !Number.isSafeInteger(input) ||
    !Number.isSafeInteger(cached) ||
    input <= 0 ||
    cached < 0 ||
    cached > input
  )
    return { status: "unknown" }
  const ratio = cached / input
  return { status: ratio >= threshold ? "accepted" : "low", ratio }
}

export function cacheFallback(evidence: CacheEvidence, interaction: boolean) {
  return evidence.status === "accepted" ? "continue" : interaction ? "ask-main" : "main-only"
}

export function terminal(state: TaskState) {
  return state === "done" || state === "failed" || state === "cancelled"
}

// A blocked child may still own an activity. Slot ownership is released explicitly
// after SessionExecution has settled; a status string alone must never free it.
const transitions: Record<TaskState, readonly TaskState[]> = {
  planned: ["waiting", "reserved", "cancelled"],
  waiting: ["reserved", "cancelled"],
  reserved: ["snapshotting", "paused", "failed", "cancelled"],
  snapshotting: ["starting", "paused", "failed", "cancelled"],
  starting: ["checking_cache", "paused", "failed", "cancelled"],
  checking_cache: ["running", "blocked_cache", "paused", "failed", "cancelled"],
  running: ["reviewing", "blocked_decision", "paused", "failed", "cancelled"],
  reviewing: ["integrating", "running", "blocked_decision", "paused", "failed", "cancelled"],
  integrating: ["done", "blocked_decision", "paused", "failed", "cancelled"],
  blocked_cache: ["paused", "cancelled", "failed"],
  blocked_decision: ["running", "reviewing", "integrating", "paused", "failed", "cancelled"],
  paused: ["waiting", "cancelled"],
  done: [],
  failed: [],
  cancelled: [],
}

export function canTransition(from: TaskState, to: TaskState) {
  return Schema.is(TaskState)(from) && Schema.is(TaskState)(to) && transitions[from].includes(to)
}

export function resourceKey(value: string) {
  if (value !== value.trim()) return undefined
  if (value === "project:*") return value
  if (/^(interface|build):[^\s]+$/.test(value)) return value
  if (!value.startsWith("path:")) return undefined
  const file = value.slice(5).replaceAll("\\", "/")
  if ((!path.posix.isAbsolute(file) && !/^[a-zA-Z]:\//.test(file)) || file.includes("\0")) return undefined
  if (file.split("/").some((part) => part === "." || part === "..")) return undefined
  // POSIX normalization collapses the UNC prefix into a different local path.
  const normalized = file.startsWith("//") ? `//${path.posix.normalize(file.slice(2))}` : path.posix.normalize(file)
  return `path:${OrchestratorCheckout.pathKey(normalized)}`
}

/** Resources are canonical host-resolved keys, never model-provided path guesses. */
export function overlaps(left: string, right: string) {
  if (left === "project:*" || right === "project:*") return true
  if (left === right) return true
  if (!left.startsWith("path:") || !right.startsWith("path:")) return false
  if (left.startsWith("path://") !== right.startsWith("path://")) return false
  return (
    left.startsWith(right.endsWith("/") ? right : `${right}/`) ||
    right.startsWith(left.endsWith("/") ? left : `${left}/`)
  )
}
