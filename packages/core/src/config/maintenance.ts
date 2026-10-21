export * as ConfigMaintenance from "./maintenance"

import { Schema } from "effect"

const positiveInt = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))

export class SettlementWatchdog extends Schema.Class<SettlementWatchdog>(
  "ConfigV2.Maintenance.SettlementWatchdog",
)({
  enabled: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Master toggle for the periodic settlement watchdog",
  }),
  interval_ms: positiveInt.pipe(Schema.optional).annotate({
    description: "Watchdog cycle interval in milliseconds",
  }),
  lease_grace_ms: positiveInt.pipe(Schema.optional).annotate({
    description: "Grace period after lease expiry before a stale activity is terminalized",
  }),
  bootstrap_timeout_ms: positiveInt.pipe(Schema.optional).annotate({
    description: "Instance bootstrap deadline before the wedged entry is disposed",
  }),
  max_instance_reloads_per_hour: positiveInt.pipe(Schema.optional).annotate({
    description: "Circuit breaker for automatic instance reloads per directory per hour",
  }),
}) {}

export class GrowthBudgets extends Schema.Class<GrowthBudgets>("ConfigV2.Maintenance.GrowthBudgets")({
  runtime_log_max_bytes: positiveInt.pipe(Schema.optional).annotate({
    description: "Trim threshold for the runtime log",
  }),
}) {}

export class Info extends Schema.Class<Info>("ConfigV2.Maintenance")({
  settlement_watchdog: SettlementWatchdog.pipe(Schema.optional).annotate({
    description: "Activity settlement and instance bootstrap deadlines",
  }),
  growth_budgets: GrowthBudgets.pipe(Schema.optional).annotate({
    description: "Runtime log rotation threshold",
  }),
}) {}

export type Entry = {
  readonly type: string
  readonly info?: {
    readonly maintenance?: Info
  }
}

export type ResolvedWatchdog = Readonly<{
  enabled: boolean
  intervalMs: number
  leaseGraceMs: number
  bootstrapTimeoutMs: number
  maxInstanceReloadsPerHour: number
}>

export type ResolvedBudgets = Readonly<{
  enabled: boolean
  runtimeLogMaxBytes: number
  eventRetentionDays: number
  schedulerJournalMaxEntries: number
  snapshotPatchMaxBytes: number
  toolReplayMaxBytes: number
}>

export type Resolved = Readonly<{
  watchdog: ResolvedWatchdog
  growthBudgets: ResolvedBudgets
}>

export const defaultWatchdog: ResolvedWatchdog = {
  enabled: true,
  intervalMs: 30_000,
  leaseGraceMs: 60_000,
  bootstrapTimeoutMs: 120_000,
  maxInstanceReloadsPerHour: 3,
}

export const defaultBudgets: ResolvedBudgets = {
  enabled: true,
  runtimeLogMaxBytes: 64 * 1024 * 1024,
  eventRetentionDays: 30,
  schedulerJournalMaxEntries: 50_000,
  snapshotPatchMaxBytes: 16 * 1024 * 1024,
  toolReplayMaxBytes: 32 * 1024 * 1024,
}

const positiveIntOverride = (value: number | undefined, fallback: number) =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback

const boolOverride = (value: boolean | undefined, fallback: boolean) =>
  typeof value === "boolean" ? value : fallback

export function resolve(entries: readonly Entry[]): Resolved {
  const documents = entries.filter((entry) => entry.type === "document")
  const configured = documents.findLast((entry) => entry.info?.maintenance !== undefined)?.info?.maintenance
  const watchdog = configured?.settlement_watchdog
  const budgets = configured?.growth_budgets
  return {
    watchdog: {
      enabled: boolOverride(watchdog?.enabled, defaultWatchdog.enabled),
      intervalMs: positiveIntOverride(watchdog?.interval_ms, defaultWatchdog.intervalMs),
      leaseGraceMs: positiveIntOverride(watchdog?.lease_grace_ms, defaultWatchdog.leaseGraceMs),
      bootstrapTimeoutMs: positiveIntOverride(watchdog?.bootstrap_timeout_ms, defaultWatchdog.bootstrapTimeoutMs),
      maxInstanceReloadsPerHour: positiveIntOverride(
        watchdog?.max_instance_reloads_per_hour,
        defaultWatchdog.maxInstanceReloadsPerHour,
      ),
    },
    growthBudgets: {
      ...defaultBudgets,
      runtimeLogMaxBytes: positiveIntOverride(budgets?.runtime_log_max_bytes, defaultBudgets.runtimeLogMaxBytes),
    },
  }
}

// Latest-wins runtime view of the loaded project config's maintenance block.
// Config.layer publishes on every location open; process-global consumers that
// cannot depend on a per-location Config service (the settlement watchdog
// loop) read this instead of silently ignoring the configured values.
let runtimeInfo: Info | undefined

export function publishRuntime(info: Info | undefined) {
  runtimeInfo = info
}

export function runtimeConfigured(): Info | undefined {
  return runtimeInfo
}

export function runtime(): Resolved {
  return resolve(runtimeInfo ? [{ type: "document", info: { maintenance: runtimeInfo } }] : [])
}
