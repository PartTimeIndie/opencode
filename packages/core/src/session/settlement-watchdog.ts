export * as SettlementWatchdog from "./settlement-watchdog"

import { Cause, Clock, Effect } from "effect"
import { ConfigMaintenance } from "../config/maintenance"
import { Database } from "../database/database"
import { TaskJob } from "../tool/task-job"
import { SessionActivity } from "./activity"
import { SessionInput } from "./input"

/**
 * Uptime settlement enforcement. Startup recovery only runs once per process;
 * work that goes stale afterwards (a crashed child, an interrupted stream, a
 * dead scheduler run) previously stayed `running` until the next restart. The
 * watchdog repeats the same terminalization contract on an interval so every
 * activity and background job reaches a terminal state within a bounded
 * window. Terminalization itself never touches this process's live work:
 * `SessionActivity.interruptStale` refuses rows that are locally active or
 * hold a live blocking question, and the grace window below adds a second
 * guard on top of lease expiry.
 */

export type Settings = ConfigMaintenance.ResolvedWatchdog

export type Deps = {
  readonly activity: SessionActivity.Interface
  readonly db: Database.Interface["db"]
}

const DEFAULTS = ConfigMaintenance.defaultWatchdog

export function settingsFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): Settings {
  const override = (name: string, fallback: number) => {
    const value = Number(env[name])
    return Number.isInteger(value) && value > 0 ? value : fallback
  }
  return {
    enabled: env["OPENCODE_SETTLEMENT_WATCHDOG"] !== "0",
    intervalMs: override("OPENCODE_SETTLEMENT_INTERVAL_MS", DEFAULTS.intervalMs),
    leaseGraceMs: override("OPENCODE_SETTLEMENT_LEASE_GRACE_MS", DEFAULTS.leaseGraceMs),
    bootstrapTimeoutMs: override("OPENCODE_SETTLEMENT_BOOTSTRAP_TIMEOUT_MS", DEFAULTS.bootstrapTimeoutMs),
    maxInstanceReloadsPerHour: DEFAULTS.maxInstanceReloadsPerHour,
  }
}

/**
 * Runtime settings with the documented priority: env override > configured
 * maintenance block (published by Config.layer on location open) > defaults.
 * `env "0"` still forces the watchdog off as an operator escape hatch, and
 * unset numeric env keys fall through to the configured values instead of the
 * built-in defaults.
 */
export function settings(env: Readonly<Record<string, string | undefined>> = process.env): Settings {
  const fromConfig = ConfigMaintenance.runtime().watchdog
  const override = (name: string, fallback: number) => {
    const value = Number(env[name])
    return Number.isInteger(value) && value > 0 ? value : fallback
  }
  return {
    enabled: env["OPENCODE_SETTLEMENT_WATCHDOG"] === "0" ? false : fromConfig.enabled,
    intervalMs: override("OPENCODE_SETTLEMENT_INTERVAL_MS", fromConfig.intervalMs),
    leaseGraceMs: override("OPENCODE_SETTLEMENT_LEASE_GRACE_MS", fromConfig.leaseGraceMs),
    bootstrapTimeoutMs: override("OPENCODE_SETTLEMENT_BOOTSTRAP_TIMEOUT_MS", fromConfig.bootstrapTimeoutMs),
    maxInstanceReloadsPerHour: fromConfig.maxInstanceReloadsPerHour,
  }
}

/**
 * Earliest timestamp at which an already lease-expired row may be terminalized.
 * Rows without a durable lease (legacy rows) fall back to their last update.
 */
export function settleDueAt(
  info: { readonly leaseUntil?: number; readonly timeUpdated: number },
  graceMs: number,
): number {
  return (info.leaseUntil ?? info.timeUpdated) + graceMs
}

export function isSettleDue(
  info: { readonly leaseUntil?: number; readonly timeUpdated: number },
  now: number,
  graceMs: number,
): boolean {
  return now >= settleDueAt(info, graceMs)
}

export type CycleResult = {
  readonly activities: number
  readonly jobs: number
}

export const settleOnce = (deps: Deps, settings: Settings) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const stale = yield* deps.activity.listStale(50)
    const due = stale.filter((info) => isSettleDue(info, now, settings.leaseGraceMs))
    let activities = 0
    for (const info of due) {
      const closedSeq = yield* SessionInput.latestSeq(deps.db, info.sessionID)
      const settled = yield* deps.activity
        .interruptStale(info.id, closedSeq)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logError("SettlementWatchdog: failed to terminalize stale activity", {
              activityID: info.id,
              sessionID: info.sessionID,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(undefined)),
          ),
        )
      if (settled) activities++
    }
    const jobs = yield* TaskJob.recoverStale(deps.db).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("SettlementWatchdog: stale background job recovery failed", {
          cause: Cause.pretty(cause),
        }).pipe(Effect.as([])),
      ),
      Effect.map((rows) => rows.length),
    )
    if (activities > 0 || jobs > 0)
      yield* Effect.logInfo("SettlementWatchdog: settled stale work", { activities, jobs })
    return { activities, jobs } satisfies CycleResult
  })

export const run = (deps: Deps) =>
  Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(`${settings().intervalMs} millis`)
      const current = settings()
      if (!current.enabled) continue
      yield* settleOnce(deps, current).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("SettlementWatchdog: cycle failed", { cause: Cause.pretty(cause) }),
        ),
      )
    }
  }).pipe(Effect.asVoid)
