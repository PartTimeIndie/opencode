export * as SessionTurnContinuation from "./turn-continuation"

import { and, eq, ne } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "../database/database"
import { SessionSchema } from "./schema"
import { SessionActivityTable, SessionTable } from "./sql"

export const MetadataKey = "opencode.turn_continuation"
export const MaxAttempts = 2
export const LineageTtlMs = 30 * 60_000

export type Info = {
  readonly reason: "incomplete"
  readonly activityID: string
  readonly attempts: number
  readonly timeCreated: number
  readonly progressFingerprint?: string
  readonly consumedAt?: number
}

export const read = (db: Database.Interface["db"], sessionID: SessionSchema.ID) =>
  db
    .select({ metadata: SessionTable.metadata })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID))
    .get()
    .pipe(Effect.map((row) => decode(row?.metadata?.[MetadataKey])), Effect.orDie)

export const pending = (db: Database.Interface["db"], sessionID: SessionSchema.ID) =>
  db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const row = yield* tx
          .select({ metadata: SessionTable.metadata })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get()
          .pipe(Effect.orDie)
        const current = decode(row?.metadata?.[MetadataKey])
        if (!row || !current) return
        if (Date.now() - current.timeCreated <= LineageTtlMs)
          return current.consumedAt === undefined ? current : undefined

        const metadata = { ...(row.metadata ?? {}) }
        delete metadata[MetadataKey]
        yield* tx
          .update(SessionTable)
          .set({ metadata })
          .where(eq(SessionTable.id, sessionID))
          .run()
          .pipe(Effect.orDie)
      }),
    { behavior: "immediate" },
  ).pipe(Effect.catchTag("SqlError", Effect.die))

export const arm = (
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
  activityID: string,
  progressFingerprint?: string,
) =>
  db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const row = yield* tx
            .select({ metadata: SessionTable.metadata })
            .from(SessionTable)
            .where(eq(SessionTable.id, sessionID))
            .get()
            .pipe(Effect.orDie)
          if (!row) return
          const now = Date.now()
          const current = decode(row.metadata?.[MetadataKey])
          const stale = current !== undefined && now - current.timeCreated > LineageTtlMs
          // A retry belongs to this activity, not to the successor's changing todos.
          // Return consumed markers too so callers distinguish a handoff from exhaustion.
          if (current?.activityID === activityID) return current
          const progressChanged =
            progressFingerprint !== undefined && current?.progressFingerprint !== progressFingerprint
          const attempts = !current || stale || progressChanged ? 1 : current.attempts + 1
          if (attempts > MaxAttempts) return
          const next: Info = {
            reason: "incomplete",
            activityID,
            attempts,
            timeCreated: now,
            ...(progressFingerprint === undefined ? {} : { progressFingerprint }),
          }
          yield* tx
            .update(SessionTable)
            .set({ metadata: { ...(row.metadata ?? {}), [MetadataKey]: next } })
            .where(eq(SessionTable.id, sessionID))
            .run()
            .pipe(Effect.orDie)
          return next
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.catchTag("SqlError", Effect.die))

export const consume = (db: Database.Interface["db"], sessionID: SessionSchema.ID, activityID: string) =>
  db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const row = yield* tx
            .select({ metadata: SessionTable.metadata })
            .from(SessionTable)
            .where(eq(SessionTable.id, sessionID))
            .get()
            .pipe(Effect.orDie)
          if (!row) return false
          const current = decode(row.metadata?.[MetadataKey])
          if (!current || current.activityID !== activityID || current.consumedAt !== undefined) return false
          const now = Date.now()
          // Consumption transfers completion ownership to the successor. Persist that
          // handoff atomically, before a later activity can replace or reset the lineage.
          yield* tx
            .update(SessionActivityTable)
            .set({
              turn_completion_state: "done",
              turn_completion_owner_id: null,
              turn_completion_lease_until: null,
              turn_completion_completed_at: now,
              turn_completion_error: null,
            })
            .where(
              and(
                eq(SessionActivityTable.id, activityID),
                eq(SessionActivityTable.session_id, sessionID),
                eq(SessionActivityTable.status, "completed"),
                eq(SessionActivityTable.turn_completion_result, "incomplete"),
                ne(SessionActivityTable.turn_completion_state, "done"),
              ),
            )
            .run()
            .pipe(Effect.orDie)
          yield* tx
            .update(SessionTable)
            .set({ metadata: { ...(row.metadata ?? {}), [MetadataKey]: { ...current, consumedAt: now } } })
            .where(eq(SessionTable.id, sessionID))
            .run()
            .pipe(Effect.orDie)
          return true
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.catchTag("SqlError", Effect.die))

export const reset = (db: Database.Interface["db"], sessionID: SessionSchema.ID) =>
  db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const row = yield* tx
          .select({ metadata: SessionTable.metadata })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get()
          .pipe(Effect.orDie)
        if (!row?.metadata?.[MetadataKey]) return false
        const metadata = { ...row.metadata }
        delete metadata[MetadataKey]
        yield* tx
          .update(SessionTable)
          .set({ metadata })
          .where(eq(SessionTable.id, sessionID))
          .run()
          .pipe(Effect.orDie)
        return true
      }),
    { behavior: "immediate" },
  ).pipe(Effect.catchTag("SqlError", Effect.die))

function decode(value: unknown): Info | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const marker = value as Record<string, unknown>
  if (
    marker.reason !== "incomplete" ||
    typeof marker.activityID !== "string" ||
    typeof marker.attempts !== "number" ||
    typeof marker.timeCreated !== "number" ||
    (marker.progressFingerprint !== undefined && typeof marker.progressFingerprint !== "string") ||
    (marker.consumedAt !== undefined && typeof marker.consumedAt !== "number")
  )
    return
  return {
    reason: marker.reason,
    activityID: marker.activityID,
    attempts: marker.attempts,
    timeCreated: marker.timeCreated,
    ...(marker.progressFingerprint === undefined ? {} : { progressFingerprint: marker.progressFingerprint }),
    ...(marker.consumedAt === undefined ? {} : { consumedAt: marker.consumedAt }),
  }
}
