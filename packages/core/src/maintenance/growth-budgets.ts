export * as GrowthBudgets from "./growth-budgets"

import { ConfigMaintenance } from "../config/maintenance"

/**
 * Central growth budgets for long-lived artifacts. Several bounds were added
 * as independent one-off fixes (runtime log rotation, scheduler journal
 * trimming, snapshot patch and tool replay ceilings, event retention); this
 * module is the single source of truth they resolve their limits from, so a
 * budget change does not require hunting down five constants. SQLite-side
 * trims keep using the existing compaction paths.
 */

const DEFAULTS = ConfigMaintenance.defaultBudgets

const positiveInteger = (value: number | undefined, fallback: number) =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback

const envOverride = (env: Readonly<Record<string, string | undefined>>, name: string, fallback: number) => {
  const value = Number(env[name])
  return positiveInteger(Number.isFinite(value) ? value : undefined, fallback)
}

export function runtimeLogMaxBytes(env: Readonly<Record<string, string | undefined>> = process.env) {
  return envOverride(
    env,
    "OPENCODE_GROWTH_RUNTIME_LOG_MAX_BYTES",
    ConfigMaintenance.runtime().growthBudgets.runtimeLogMaxBytes,
  )
}

export function eventRetentionDays(env: Readonly<Record<string, string | undefined>> = process.env) {
  return envOverride(env, "OPENCODE_GROWTH_EVENT_RETENTION_DAYS", DEFAULTS.eventRetentionDays)
}

export function schedulerJournalMaxEntries(env: Readonly<Record<string, string | undefined>> = process.env) {
  return envOverride(env, "OPENCODE_GROWTH_SCHEDULER_JOURNAL_MAX", DEFAULTS.schedulerJournalMaxEntries)
}

export function snapshotPatchMaxBytes(env: Readonly<Record<string, string | undefined>> = process.env) {
  return envOverride(env, "OPENCODE_GROWTH_SNAPSHOT_PATCH_MAX_BYTES", DEFAULTS.snapshotPatchMaxBytes)
}

export function toolReplayMaxBytes(env: Readonly<Record<string, string | undefined>> = process.env) {
  return envOverride(env, "OPENCODE_GROWTH_TOOL_REPLAY_MAX_BYTES", DEFAULTS.toolReplayMaxBytes)
}

/** Structured snapshot for the settlement diagnostics and the soak report. */
export function describe(env: Readonly<Record<string, string | undefined>> = process.env) {
  return {
    runtimeLogMaxBytes: runtimeLogMaxBytes(env),
    eventRetentionDays: eventRetentionDays(env),
    schedulerJournalMaxEntries: schedulerJournalMaxEntries(env),
    snapshotPatchMaxBytes: snapshotPatchMaxBytes(env),
    toolReplayMaxBytes: toolReplayMaxBytes(env),
  }
}
