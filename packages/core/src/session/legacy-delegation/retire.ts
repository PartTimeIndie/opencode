export * as LegacyDelegationRetire from "./retire"

// The legacy Main-Orchestrator runtime has been removed. Its pre-run task rows
// can never advance again, yet fail-closed guards keep their slots and resource
// reservations locked forever. This module is the explicit, audited retirement
// path for those rows: it is never invoked implicitly, skips every task whose
// child still shows a live activity, and never touches human-gated states
// (paused, blocked_decision) or terminal evidence. The schema comment on
// slot_claimed warns that retirement must not *implicitly* release ownership —
// this is the deliberate, receipt-bearing release.

import { and, eq, gt, inArray } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../../database/database"
import type { LegacyDelegationRecord } from "./record"
import { SessionOrchestratorReservationTable, SessionOrchestratorTaskTable } from "./sql"
import { SessionActivityTable } from "../sql"

type Db = Database.Interface["db"]

/** Pre-run states the removed runtime alone could have advanced. */
const STUCK_STATES: readonly LegacyDelegationRecord.TaskState[] = [
  "planned",
  "waiting",
  "reserved",
  "snapshotting",
  "starting",
  "checking_cache",
  "blocked_cache",
]

export type RetiredTask = {
  readonly id: string
  readonly previousState: LegacyDelegationRecord.TaskState
  readonly freedSlot: boolean
  readonly releasedReservations: ReadonlyArray<{ readonly directory: string; readonly resource: string }>
}

export type SkippedTask = {
  readonly id: string
  readonly reason: "active" | "recent" | "changed"
}

export type RetireOutcome = {
  readonly retired: ReadonlyArray<RetiredTask>
  readonly skipped: ReadonlyArray<SkippedTask>
}

export const retireStale = Effect.fn("LegacyDelegationRetire.retireStale")(function* (
  db: Db,
  input: { readonly now: number; readonly minAgeMs?: number; readonly dryRun?: boolean },
) {
  const minAgeMs = input.minAgeMs ?? 24 * 60 * 60 * 1000
  const candidates = yield* db
    .select()
    .from(SessionOrchestratorTaskTable)
    .where(inArray(SessionOrchestratorTaskTable.state, [...STUCK_STATES]))
    .all()
    .pipe(Effect.orDie)
  const retired: RetiredTask[] = []
  const skipped: SkippedTask[] = []
  for (const task of candidates) {
    if (input.now - task.time_updated < minAgeMs) {
      skipped.push({ id: task.id, reason: "recent" })
      continue
    }
    const activeChild = task.child_session_id
      ? yield* db
          .select({ id: SessionActivityTable.id })
          .from(SessionActivityTable)
          .where(
            and(
              eq(SessionActivityTable.session_id, task.child_session_id),
              inArray(SessionActivityTable.status, ["running", "recovering"]),
              gt(SessionActivityTable.lease_until, input.now),
            ),
          )
          .limit(1)
          .get()
          .pipe(Effect.orDie)
      : undefined
    if (activeChild) {
      skipped.push({ id: task.id, reason: "active" })
      continue
    }
    if (input.dryRun) {
      const pending = yield* db
        .select({ directory: SessionOrchestratorReservationTable.directory, resource: SessionOrchestratorReservationTable.resource })
        .from(SessionOrchestratorReservationTable)
        .where(eq(SessionOrchestratorReservationTable.task_id, task.id))
        .all()
        .pipe(Effect.orDie)
      retired.push({
        id: task.id,
        previousState: task.state,
        freedSlot: task.slot_claimed,
        releasedReservations: pending,
      })
      continue
    }
    const releasedReservations = yield* db
      .delete(SessionOrchestratorReservationTable)
      .where(eq(SessionOrchestratorReservationTable.task_id, task.id))
      .returning({ directory: SessionOrchestratorReservationTable.directory, resource: SessionOrchestratorReservationTable.resource })
      .all()
      .pipe(Effect.orDie)
    const updated = yield* db
      .update(SessionOrchestratorTaskTable)
      .set({ state: "cancelled", slot_claimed: false, time_updated: input.now })
      .where(
        and(eq(SessionOrchestratorTaskTable.id, task.id), inArray(SessionOrchestratorTaskTable.state, [...STUCK_STATES])),
      )
      .returning({ id: SessionOrchestratorTaskTable.id })
      .get()
      .pipe(Effect.orDie)
    if (!updated) {
      skipped.push({ id: task.id, reason: "changed" })
      continue
    }
    retired.push({
      id: task.id,
      previousState: task.state,
      freedSlot: task.slot_claimed,
      releasedReservations,
    })
  }
  return { retired, skipped }
})
