export * as SessionActivity from "./activity"

import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, notInArray, or, sql } from "drizzle-orm"
import { Clock, Context, DateTime, Effect, Layer, Schedule, Schema } from "effect"
import { createHash, randomUUID } from "node:crypto"
import { Database } from "../database/database"
import { SessionFailure } from "./failure"
import { EventV2 } from "../event"
import { Identifier } from "../util/identifier"
import { SessionEvent } from "./event"
import { SessionSchema } from "./schema"
import { SessionActivityTable } from "./sql"
import { QuestionTable } from "../question/sql"
import { QuestionV2 } from "../question"
import { QuestionTransaction } from "../question/transaction"
import { QuestionWakeup } from "../question/wakeup"
import { SessionMessage } from "./message"
import { LegacyDelegationGuard } from "./legacy-delegation/guard"
import { CrashGuard } from "./crash-guard"

export type Status = "running" | "recovering" | "completed" | "failed" | "interrupted"
export type Kind = "prompt" | "queue" | "resume" | "recovery"

export type Info = {
  readonly id: string
  readonly sessionID: SessionSchema.ID
  readonly status: Status
  readonly kind: Kind
  readonly reason?: string
  readonly ownerID?: string
  readonly leaseUntil?: number
  readonly heartbeatAt?: number
  readonly recoveryAttempts: number
  readonly lastError?: string
  readonly turnCompletionResult?: "done" | "incomplete" | "unknown" | "skipped"
  readonly openedSeq?: number
  readonly closedSeq?: number
  readonly timeCreated: number
  readonly timeUpdated: number
}

export interface Interface {
  readonly open: (input: {
    readonly sessionID: SessionSchema.ID
    readonly kind: Kind
    readonly reason?: string
    readonly ownerID: string
    readonly leaseDurationMs?: number
    readonly openedSeq: number
    readonly crash?: { readonly activityID: string; readonly previousOwner: string }
    readonly onClaim?: (info: Info) => void
  }) => Effect.Effect<Info, LegacyDelegationGuard.Blocked>
  readonly heartbeat: (id: string, ownerID: string, leaseDurationMs?: number) => Effect.Effect<boolean>
  readonly complete: (id: string, ownerID: string, closedSeq: number) => Effect.Effect<void>
  readonly fail: (
    id: string,
    ownerID: string,
    error: string,
    closedSeq: number,
    failure?: SessionFailure.Failure,
  ) => Effect.Effect<void>
  readonly interrupt: (id: string, ownerID: string, closedSeq: number, reason?: string) => Effect.Effect<void>
  readonly prepareOwnerShutdown: (ownerID: string, reason: string) => Effect.Effect<Info[]>
  readonly prepareActivityShutdown: (id: string, ownerID: string, reason: string) => Effect.Effect<Info | undefined>
  readonly listStale: (limit?: number, excludeIDs?: ReadonlySet<string>) => Effect.Effect<Info[]>
  readonly latestLeaseUntil: (excludeIDs?: ReadonlySet<string>) => Effect.Effect<number | undefined>
  readonly interruptStale: (id: string, closedSeq: number) => Effect.Effect<Info | undefined>
  readonly recoverStale: (ownerID: string, limit?: number, excludeIDs?: ReadonlySet<string>) => Effect.Effect<Info[]>
  readonly recoverStaleByID: (id: string, ownerID: string) => Effect.Effect<Info | undefined>
  readonly get: (id: string) => Effect.Effect<Info | undefined>
  readonly listForSession: (sessionID: SessionSchema.ID) => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionActivity") {}

const LEASE_DURATION_MS = 30_000
const HEARTBEAT_INTERVAL_MS = 10_000
const MAX_CONTROLLED_RECOVERY_ATTEMPTS = 3
const locallyActive = new Set<string>()
/** Four KiB keeps a useful route/schema prefix while bounding every durable/API error; the complete cause remains in server logs. */
export const MAX_PERSISTED_ERROR_BYTES = 4 * 1024
const errorReference = /^err_[A-Za-z0-9][A-Za-z0-9_-]*/
type Transaction = Parameters<Parameters<Database.Interface["db"]["transaction"]>[0]>[0]
// Activity writes are ownership-guarded and idempotent. Retrying only their database boundary cannot replay provider work.
const lockRetrySchedule = Schedule.exponential("25 millis").pipe(Schedule.jittered, Schedule.both(Schedule.recurs(3)))

export const normalizeError = (error: string) => {
  const originalBytes = Buffer.byteLength(error, "utf8")
  if (originalBytes <= MAX_PERSISTED_ERROR_BYTES) return error

  const hash = createHash("sha256").update(error).digest("hex")
  const marker = `[truncated; original-bytes=${originalBytes}; sha256=${hash}]`
  const candidate = errorReference.exec(error)?.[0]
  const reference =
    candidate && Buffer.byteLength(`${candidate} ${marker}`, "utf8") <= MAX_PERSISTED_ERROR_BYTES
      ? candidate
      : undefined
  const base = reference === undefined ? marker : `${reference} ${marker}`
  const preview = utf8Prefix(
    reference === undefined ? error : error.slice(reference.length).trimStart(),
    Math.max(0, MAX_PERSISTED_ERROR_BYTES - Buffer.byteLength(base, "utf8") - 1),
  )
  return preview.length === 0 ? base : `${base} ${preview}`
}

function utf8Prefix(value: string, maxBytes: number) {
  if (maxBytes <= 0) return ""
  let bytes = 0
  let end = 0
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8")
    if (bytes + characterBytes > maxBytes) break
    bytes += characterBytes
    end += character.length
  }
  return value.slice(0, end)
}

const isRetryableLock = (error: unknown) => {
  const seen = new Set<unknown>()
  const visit = (value: unknown): boolean => {
    if (value === null || value === undefined) return false
    if (typeof value === "string") return /database is locked|locktimeouterror/i.test(value)
    if (seen.has(value)) return false
    seen.add(value)
    if (value instanceof Error) {
      if (/database is locked|locktimeouterror/i.test(`${value.name} ${value.message}`)) return true
      return visit(value.cause)
    }
    return /database is locked|locktimeouterror/i.test(String(value))
  }
  return visit(error)
}

const fromRow = (row: typeof SessionActivityTable.$inferSelect): Info => ({
  id: row.id,
  sessionID: SessionSchema.ID.make(row.session_id),
  status: row.status as Status,
  kind: row.kind as Kind,
  ...(row.reason === null ? {} : { reason: row.reason }),
  ...(row.owner_id === null ? {} : { ownerID: row.owner_id }),
  ...(row.lease_until === null ? {} : { leaseUntil: row.lease_until }),
  ...(row.heartbeat_at === null ? {} : { heartbeatAt: row.heartbeat_at }),
  recoveryAttempts: row.recovery_attempts,
  ...(row.last_error === null ? {} : { lastError: row.last_error }),
  ...(row.turn_completion_result === null ? {} : { turnCompletionResult: row.turn_completion_result }),
  ...(row.opened_seq === null ? {} : { openedSeq: row.opened_seq }),
  ...(row.closed_seq === null ? {} : { closedSeq: row.closed_seq }),
  timeCreated: row.time_created,
  timeUpdated: row.time_updated,
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service

    const now = () => Clock.currentTimeMillis.pipe(Effect.flatMap((ms) => Effect.sync(() => ms)))

    const open: Interface["open"] = Effect.fn("SessionActivity.open")(function* (input) {
      const id = Identifier.ascending()
      const ts = yield* now()
      const leaseDuration = input.leaseDurationMs ?? LEASE_DURATION_MS
      const acquired = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              yield* LegacyDelegationGuard.assertAdmissible(tx, input.sessionID)
              const current = yield* tx
                .select()
                .from(SessionActivityTable)
                .where(
                  and(
                    eq(SessionActivityTable.session_id, input.sessionID),
                    inArray(SessionActivityTable.status, ["running", "recovering"]),
                  ),
                )
                .orderBy(asc(SessionActivityTable.time_created))
                .get()
              if (
                input.crash &&
                (!current || current.id !== input.crash.activityID || current.owner_id !== input.crash.previousOwner)
              )
                return { _tag: "Skip" as const }
              if (current && locallyActive.has(current.id)) return { _tag: "Wait" as const, delay: 250 }
              if (current && current.lease_until !== null && current.lease_until > ts)
                return { _tag: "Wait" as const, delay: Math.min(250, current.lease_until - ts) }
              if (current && input.crash) {
                const blocked = yield* CrashGuard.inspect(tx, current)
                if (blocked) {
                  yield* tx
                    .update(SessionActivityTable)
                    .set({
                      status: "interrupted",
                      reason: "desktop-crash-blocked",
                      last_error: blocked,
                      owner_id: null,
                      lease_until: null,
                      heartbeat_at: null,
                      time_updated: ts,
                    })
                    .where(eq(SessionActivityTable.id, current.id))
                    .run()
                  return { _tag: "Blocked" as const, row: current, blocked }
                }
              }
              if (current) {
                const row = yield* tx
                  .update(SessionActivityTable)
                  .set({
                    status: "recovering",
                    kind: "recovery",
                    ...(input.reason === undefined ? {} : { reason: input.reason }),
                    ...(input.crash ? { reason: `desktop-crash:${input.crash.previousOwner}` } : {}),
                    owner_id: input.ownerID,
                    recovery_attempts: current.recovery_attempts + 1,
                    lease_until: ts + leaseDuration,
                    heartbeat_at: ts,
                    opened_seq: input.openedSeq,
                    time_updated: ts,
                  })
                  .where(
                    and(
                      eq(SessionActivityTable.id, current.id),
                      inArray(SessionActivityTable.status, ["running", "recovering"]),
                      or(isNull(SessionActivityTable.lease_until), lte(SessionActivityTable.lease_until, ts)),
                    ),
                  )
                  .returning()
                  .get()
                if (!row) return { _tag: "Wait" as const, delay: 1 }
                return { _tag: "Recovered" as const, row, previousOwner: current.owner_id }
              }
              const row = yield* tx
                .insert(SessionActivityTable)
                .values({
                  id,
                  session_id: input.sessionID,
                  status: "running",
                  kind: input.kind,
                  ...(input.reason === undefined ? {} : { reason: input.reason }),
                  owner_id: input.ownerID,
                  lease_until: ts + leaseDuration,
                  heartbeat_at: ts,
                  opened_seq: input.openedSeq,
                  time_created: ts,
                  time_updated: ts,
                })
                .returning()
                .get()
              return { _tag: "Started" as const, row }
            }),
          { behavior: "immediate" },
        )
        .pipe(
          Effect.retry({ while: isRetryableLock, schedule: lockRetrySchedule }),
          Effect.catch((error) =>
            error instanceof LegacyDelegationGuard.Blocked ? Effect.fail(error) : Effect.die(error),
          ),
          Effect.flatMap((result) =>
            Effect.sync(() => {
              if (result._tag === "Wait" || result._tag === "Skip" || result._tag === "Blocked") return result
              const info = fromRow(result.row)
              input.onClaim?.(info)
              return result
            }),
          ),
          // The claim and its process-local registration are one interrupt-safe acquisition.
          // Lease waiting below stays interruptible because it is outside this region.
          Effect.uninterruptible,
        )
      if (acquired._tag === "Wait")
        return yield* Effect.sleep(`${Math.max(1, acquired.delay)} millis`).pipe(Effect.andThen(open(input)))
      if (acquired._tag === "Skip") return yield* Effect.interrupt
      if (input.crash) {
        yield* events.publish(SessionEvent.ContextUpdated, {
          sessionID: input.sessionID,
          messageID: SessionMessage.ID.make(`msg_crash_${input.crash.activityID}_${input.ownerID}`),
          timestamp: yield* DateTime.now,
          text:
            acquired._tag === "Blocked"
              ? `Der lokale Server wurde neu gestartet. Automatische Fortsetzung pausiert: ${acquired.blocked}. Bitte zuerst prüfen; keine ungeklärten Aktionen wiederholen.`
              : "Der lokale Server wurde unerwartet beendet und neu gestartet. Ich setze die unterbrochene Arbeit mit dem gespeicherten Stand fort. Bereits abgeschlossene Aktionen nicht wiederholen; dieser Systemhinweis erteilt keine neue Berechtigung.",
        })
      }
      if (acquired._tag === "Blocked") {
        yield* events.publish(SessionEvent.Activity.Interrupted, {
          sessionID: input.sessionID,
          activityID: acquired.row.id,
          timestamp: yield* DateTime.now,
          reason: "desktop-crash-blocked",
        })
        return yield* Effect.interrupt
      }
      if (acquired._tag === "Recovered") {
        yield* events.publish(SessionEvent.Activity.Recovered, {
          sessionID: input.sessionID,
          timestamp: yield* DateTime.now,
          activityID: acquired.row.id,
          ...(acquired.previousOwner === null ? {} : { previousOwner: acquired.previousOwner }),
        })
        return fromRow(acquired.row)
      }
      yield* events.publish(SessionEvent.Activity.Started, {
        sessionID: input.sessionID,
        timestamp: yield* DateTime.now,
        activityID: id,
        kind: input.kind,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      })
      return fromRow(acquired.row)
    })

    const heartbeat: Interface["heartbeat"] = Effect.fn("SessionActivity.heartbeat")(
      function* (id, ownerID, leaseDurationMs) {
        const ts = yield* now()
        const leaseDuration = leaseDurationMs ?? LEASE_DURATION_MS
        const row = yield* db
          .update(SessionActivityTable)
          .set({ heartbeat_at: ts, lease_until: ts + leaseDuration, time_updated: ts })
          .where(
            and(
              eq(SessionActivityTable.id, id),
              eq(SessionActivityTable.owner_id, ownerID),
              inArray(SessionActivityTable.status, ["running", "recovering"]),
            ),
          )
          .returning({ id: SessionActivityTable.id })
          .get()
          .pipe(Effect.retry({ while: isRetryableLock, schedule: lockRetrySchedule }), Effect.orDie)
        return row !== undefined
      },
    )

    const complete: Interface["complete"] = Effect.fn("SessionActivity.complete")(function* (id, ownerID, closedSeq) {
      const ts = yield* now()
      if (yield* preserveDurableToolWait(db, id, ownerID, ts)) return
      const row = yield* db
        .update(SessionActivityTable)
        .set({
          status: "completed",
          closed_seq: closedSeq,
          time_updated: ts,
          owner_id: null,
          lease_until: null,
          heartbeat_at: null,
        })
        .where(
          and(
            eq(SessionActivityTable.id, id),
            eq(SessionActivityTable.owner_id, ownerID),
            inArray(SessionActivityTable.status, ["running", "recovering"]),
          ),
        )
        .returning()
        .get()
        .pipe(Effect.retry({ while: isRetryableLock, schedule: lockRetrySchedule }), Effect.orDie)
      if (row) {
        yield* publishQuestionOutcome(events, yield* orphanBlockingQuestions(db, id, ts), "session")
        yield* events.publish(SessionEvent.Activity.Completed, {
          sessionID: SessionSchema.ID.make(row.session_id),
          timestamp: yield* DateTime.now,
          activityID: id,
        })
      }
    })

    const fail: Interface["fail"] = Effect.fn("SessionActivity.fail")(
      function* (id, ownerID, error, closedSeq, failure) {
        const ts = yield* now()
        if (yield* preserveDurableToolWait(db, id, ownerID, ts)) return
        // Keep the complete cause in the normal server log, but never let the durable/API boundary grow with it.
        const persistedError = normalizeError(error)
        const row = yield* db
          .update(SessionActivityTable)
          .set({
            status: "failed",
            last_error: persistedError,
            closed_seq: closedSeq,
            time_updated: ts,
            owner_id: null,
            lease_until: null,
            heartbeat_at: null,
          })
          .where(
            and(
              eq(SessionActivityTable.id, id),
              eq(SessionActivityTable.owner_id, ownerID),
              inArray(SessionActivityTable.status, ["running", "recovering"]),
            ),
          )
          .returning()
          .get()
          .pipe(Effect.retry({ while: isRetryableLock, schedule: lockRetrySchedule }), Effect.orDie)
        if (row) {
          yield* publishQuestionOutcome(events, yield* orphanBlockingQuestions(db, id, ts), "session")
          yield* events.publish(SessionEvent.Activity.Failed, {
            sessionID: SessionSchema.ID.make(row.session_id),
            timestamp: yield* DateTime.now,
            activityID: id,
            error: { type: "unknown", message: persistedError },
            ...(failure ? { failure } : {}),
          })
        }
      },
    )

    const interrupt: Interface["interrupt"] = Effect.fn("SessionActivity.interrupt")(
      function* (id, ownerID, closedSeq, reason) {
        const ts = yield* now()
        const row = yield* db
          .update(SessionActivityTable)
          .set({
            status: "interrupted",
            ...(reason === undefined ? {} : { reason }),
            closed_seq: closedSeq,
            time_updated: ts,
            owner_id: null,
            lease_until: null,
            heartbeat_at: null,
          })
          .where(
            and(
              eq(SessionActivityTable.id, id),
              eq(SessionActivityTable.owner_id, ownerID),
              inArray(SessionActivityTable.status, ["running", "recovering"]),
            ),
          )
          .returning()
          .get()
          .pipe(Effect.retry({ while: isRetryableLock, schedule: lockRetrySchedule }), Effect.orDie)
        if (row) {
          yield* publishQuestionOutcome(events, yield* orphanBlockingQuestions(db, id, ts), "session")
          yield* events.publish(SessionEvent.Activity.Interrupted, {
            sessionID: SessionSchema.ID.make(row.session_id),
            timestamp: yield* DateTime.now,
            activityID: id,
            ...(reason === undefined ? {} : { reason }),
          })
        }
      },
    )

    const prepareOwnerShutdown: Interface["prepareOwnerShutdown"] = Effect.fn("SessionActivity.prepareOwnerShutdown")(
      function* (ownerID, reason) {
        const ts = yield* now()
        const rows = yield* db
          .update(SessionActivityTable)
          .set({ reason, lease_until: ts, time_updated: ts })
          .where(
            and(
              eq(SessionActivityTable.owner_id, ownerID),
              inArray(SessionActivityTable.status, ["running", "recovering"]),
            ),
          )
          .returning()
          .all()
          .pipe(Effect.orDie)
        return rows.map(fromRow)
      },
    )

    const prepareActivityShutdown: Interface["prepareActivityShutdown"] = Effect.fn(
      "SessionActivity.prepareActivityShutdown",
    )(function* (id, ownerID, reason) {
      const ts = yield* now()
      const row = yield* db
        .update(SessionActivityTable)
        .set({ reason, lease_until: ts, time_updated: ts })
        .where(
          and(
            eq(SessionActivityTable.id, id),
            eq(SessionActivityTable.owner_id, ownerID),
            inArray(SessionActivityTable.status, ["running", "recovering"]),
          ),
        )
        .returning()
        .get()
        .pipe(Effect.retry({ while: isRetryableLock, schedule: lockRetrySchedule }), Effect.orDie)
      return row ? fromRow(row) : undefined
    })

    const listStale: Interface["listStale"] = Effect.fn("SessionActivity.listStale")(function* (
      limit = 50,
      excludeIDs = new Set(),
    ) {
      const ts = yield* now()
      const excluded = [...new Set([...excludeIDs, ...locallyActive])]
      const rows = yield* db
        .select()
        .from(SessionActivityTable)
        .where(
          and(
            inArray(SessionActivityTable.status, ["running", "recovering"]),
            or(isNull(SessionActivityTable.lease_until), lte(SessionActivityTable.lease_until, ts)),
            ...(excluded.length > 0 ? [notInArray(SessionActivityTable.id, excluded)] : []),
          ),
        )
        .limit(limit)
        .all()
        .pipe(Effect.orDie)
      return rows.map(fromRow)
    })

    const latestLeaseUntil: Interface["latestLeaseUntil"] = Effect.fn("SessionActivity.latestLeaseUntil")(function* (
      excludeIDs = new Set(),
    ) {
      const excluded = [...new Set([...excludeIDs, ...locallyActive])]
      const row = yield* db
        .select({ leaseUntil: SessionActivityTable.lease_until })
        .from(SessionActivityTable)
        .where(
          and(
            inArray(SessionActivityTable.status, ["running", "recovering"]),
            isNotNull(SessionActivityTable.lease_until),
            ...(excluded.length > 0 ? [notInArray(SessionActivityTable.id, excluded)] : []),
          ),
        )
        .orderBy(desc(SessionActivityTable.lease_until))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      return row?.leaseUntil ?? undefined
    })

    const interruptStale: Interface["interruptStale"] = Effect.fn("SessionActivity.interruptStale")(
      function* (id, closedSeq) {
        if (locallyActive.has(id)) return
        const ts = yield* now()
        const result = yield* db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                // Persisted blocking Surfaces are paused user work, not abandoned provider work.
                // Reserve the writer before checking so question admission cannot race stale terminalization.
                const blocking = yield* tx
                  .select({ id: QuestionTable.id })
                  .from(QuestionTable)
                  .where(
                    and(
                      eq(QuestionTable.activity_id, id),
                      eq(QuestionTable.detached, false),
                      eq(QuestionTable.mode, "blocking"),
                      inArray(QuestionTable.state, ["queued", "active"]),
                    ),
                  )
                  .get()
                if (blocking) return
                const row = yield* tx
                  .update(SessionActivityTable)
                  .set({
                    status: "interrupted",
                    // A graceful owner handoff is safe to continue after restart. Preserve that
                    // durable signal only within its retry budget; unknown, crashed, or exhausted
                    // owners remain ordinary stale leases and are never replayed.
                    reason: sql<string>`case when ${SessionActivityTable.reason} = 'owner-shutdown' and ${SessionActivityTable.recovery_attempts} < ${MAX_CONTROLLED_RECOVERY_ATTEMPTS} then 'owner-shutdown' else 'stale-lease' end`,
                    closed_seq: closedSeq,
                    time_updated: ts,
                    owner_id: null,
                    lease_until: null,
                    heartbeat_at: null,
                  })
                  .where(
                    and(
                      eq(SessionActivityTable.id, id),
                      inArray(SessionActivityTable.status, ["running", "recovering"]),
                      or(isNull(SessionActivityTable.lease_until), lte(SessionActivityTable.lease_until, ts)),
                    ),
                  )
                  .returning()
                  .get()
                if (!row) return
                return { row, questions: yield* orphanBlockingQuestionsInTransaction(tx, id, ts) }
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.retry({ while: isRetryableLock, schedule: lockRetrySchedule }), Effect.orDie)
        if (!result) return
        yield* publishQuestionOutcome(events, result.questions, "recovery")
        yield* events.publish(SessionEvent.Activity.Interrupted, {
          sessionID: SessionSchema.ID.make(result.row.session_id),
          timestamp: yield* DateTime.now,
          activityID: id,
          reason: result.row.reason ?? "stale-lease",
        })
        return fromRow(result.row)
      },
    )

    const recoverStale: Interface["recoverStale"] = Effect.fn("SessionActivity.recoverStale")(function* (
      ownerID,
      limit = 50,
      excludeIDs = new Set(),
    ) {
      const ts = yield* now()
      const excluded = [...new Set([...excludeIDs, ...locallyActive])]
      const stale = yield* db
        .select()
        .from(SessionActivityTable)
        .where(
          and(
            inArray(SessionActivityTable.status, ["running", "recovering"]),
            or(isNull(SessionActivityTable.lease_until), lte(SessionActivityTable.lease_until, ts)),
            ...(excluded.length > 0 ? [notInArray(SessionActivityTable.id, excluded)] : []),
          ),
        )
        .limit(limit)
        .all()
        .pipe(Effect.orDie)
      const claimed: Info[] = []
      for (const row of stale) {
        const updated = yield* db
          .update(SessionActivityTable)
          .set({
            status: "recovering",
            owner_id: ownerID,
            recovery_attempts: row.recovery_attempts + 1,
            lease_until: ts + LEASE_DURATION_MS,
            heartbeat_at: ts,
            time_updated: ts,
          })
          .where(
            and(
              eq(SessionActivityTable.id, row.id),
              inArray(SessionActivityTable.status, ["running", "recovering"]),
              or(isNull(SessionActivityTable.lease_until), lte(SessionActivityTable.lease_until, ts)),
            ),
          )
          .returning()
          .get()
          .pipe(Effect.orDie)
        if (updated) {
          const info = fromRow(updated)
          claimed.push(info)
          yield* events.publish(SessionEvent.Activity.Recovered, {
            sessionID: info.sessionID,
            timestamp: yield* DateTime.now,
            activityID: info.id,
            ...(row.owner_id === null ? {} : { previousOwner: row.owner_id }),
          })
        }
      }
      return claimed
    })

    const recoverStaleByID: Interface["recoverStaleByID"] = Effect.fn("SessionActivity.recoverStaleByID")(
      function* (id, ownerID) {
        if (locallyActive.has(id)) return
        const ts = yield* now()
        const row = yield* db
          .select()
          .from(SessionActivityTable)
          .where(eq(SessionActivityTable.id, id))
          .get()
          .pipe(Effect.orDie)
        if (!row) return
        const updated = yield* db
          .update(SessionActivityTable)
          .set({
            status: "recovering",
            owner_id: ownerID,
            recovery_attempts: row.recovery_attempts + 1,
            lease_until: ts + LEASE_DURATION_MS,
            heartbeat_at: ts,
            time_updated: ts,
          })
          .where(
            and(
              eq(SessionActivityTable.id, id),
              inArray(SessionActivityTable.status, ["running", "recovering"]),
              or(isNull(SessionActivityTable.lease_until), lte(SessionActivityTable.lease_until, ts)),
            ),
          )
          .returning()
          .get()
          .pipe(Effect.orDie)
        if (!updated) return
        const info = fromRow(updated)
        yield* events.publish(SessionEvent.Activity.Recovered, {
          sessionID: info.sessionID,
          timestamp: yield* DateTime.now,
          activityID: info.id,
          ...(row.owner_id === null ? {} : { previousOwner: row.owner_id }),
        })
        return info
      },
    )

    const get: Interface["get"] = Effect.fn("SessionActivity.get")(function* (id) {
      const row = yield* db
        .select()
        .from(SessionActivityTable)
        .where(eq(SessionActivityTable.id, id))
        .get()
        .pipe(Effect.orDie)
      return row ? fromRow(row) : undefined
    })

    const listForSession: Interface["listForSession"] = Effect.fn("SessionActivity.listForSession")(
      function* (sessionID) {
        const rows = yield* db
          .select()
          .from(SessionActivityTable)
          .where(eq(SessionActivityTable.session_id, sessionID))
          .all()
          .pipe(Effect.orDie)
        return rows.map(fromRow)
      },
    )

    return Service.of({
      open,
      heartbeat,
      complete,
      fail,
      interrupt,
      prepareOwnerShutdown,
      prepareActivityShutdown,
      listStale,
      latestLeaseUntil,
      interruptStale,
      recoverStale,
      recoverStaleByID,
      get,
      listForSession,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer), Layer.provide(EventV2.defaultLayer))

export { LEASE_DURATION_MS, HEARTBEAT_INTERVAL_MS, MAX_CONTROLLED_RECOVERY_ATTEMPTS }

/** Process-local ownership guard shared by every recovery service instance in this runtime. */
export const retainLocal = (id: string) => locallyActive.add(id)
export const releaseLocal = (id: string) => locallyActive.delete(id)

/**
 * Canonical reason labels recorded on interrupted activities. The reason survives in
 * `session_activity.reason` so operators can distinguish a user stop from an owner
 * shutdown or a stale-lease recovery without correlating log files.
 */
export const interruptReason = (
  reason: "user-stop" | "owner-interrupted" | "owner-shutdown" | "stale-lease" | "rollback",
) => reason

function orphanBlockingQuestions(db: Database.Interface["db"], activityID: string, now: number) {
  return QuestionTransaction.run(db, (tx) => orphanBlockingQuestionsInTransaction(tx, activityID, now)).pipe(
    Effect.orDie,
  )
}

function orphanBlockingQuestionsInTransaction(tx: Transaction, activityID: string, now: number) {
  return Effect.gen(function* () {
    const rows = yield* tx
      .select({
        id: QuestionTable.id,
        sessionID: QuestionTable.session_id,
        state: QuestionTable.state,
        allowConcurrent: QuestionTable.allow_concurrent,
      })
      .from(QuestionTable)
      .where(
        and(
          eq(QuestionTable.activity_id, activityID),
          eq(QuestionTable.detached, false),
          eq(QuestionTable.mode, "blocking"),
          inArray(QuestionTable.state, ["queued", "active"]),
        ),
      )
      .all()
    const rejected: QuestionV2.Request[] = []
    const sessions = new Set<SessionSchema.ID>()
    for (const row of rows) {
      const updated = yield* tx
        .update(QuestionTable)
        .set({
          state: "orphaned",
          receipt: `qrc_${randomUUID()}`,
          time_settled: now,
          time_updated: now,
        })
        .where(and(eq(QuestionTable.id, row.id), inArray(QuestionTable.state, ["queued", "active"])))
        .returning({ request: QuestionTable.request })
        .get()
      if (!updated) continue
      rejected.push(updated.request)
      if (row.state === "active" && !row.allowConcurrent) sessions.add(SessionSchema.ID.make(row.sessionID))
    }
    const promoted: QuestionV2.Request[] = []
    for (const sessionID of sessions) {
      const current = yield* tx
        .select({ id: QuestionTable.id })
        .from(QuestionTable)
        .where(
          and(
            eq(QuestionTable.session_id, sessionID),
            eq(QuestionTable.state, "active"),
            eq(QuestionTable.allow_concurrent, false),
          ),
        )
        .get()
      if (current) continue
      const next = yield* tx
        .select({ id: QuestionTable.id })
        .from(QuestionTable)
        .where(
          and(
            eq(QuestionTable.session_id, sessionID),
            eq(QuestionTable.state, "queued"),
            eq(QuestionTable.allow_concurrent, false),
          ),
        )
        .orderBy(asc(QuestionTable.seq))
        .get()
      if (!next) continue
      const updated = yield* tx
        .update(QuestionTable)
        .set({ state: "active", time_updated: now })
        .where(and(eq(QuestionTable.id, next.id), eq(QuestionTable.state, "queued")))
        .returning({ request: QuestionTable.request })
        .get()
      if (updated) promoted.push(updated.request)
    }
    return { rejected, promoted }
  })
}

function preserveDurableToolWait(db: Database.Interface["db"], activityID: string, ownerID: string, now: number) {
  return db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const questions = yield* tx
            .select({ request: QuestionTable.request })
            .from(QuestionTable)
            .where(
              and(
                eq(QuestionTable.activity_id, activityID),
                eq(QuestionTable.detached, false),
                eq(QuestionTable.mode, "blocking"),
                inArray(QuestionTable.state, ["queued", "active"]),
              ),
            )
            .all()
          if (!questions.some((question) => question.request.tool)) return false
          const activity = yield* tx
            .update(SessionActivityTable)
            .set({ reason: "owner-shutdown", lease_until: now, time_updated: now })
            .where(
              and(
                eq(SessionActivityTable.id, activityID),
                eq(SessionActivityTable.owner_id, ownerID),
                inArray(SessionActivityTable.status, ["running", "recovering"]),
              ),
            )
            .returning({ id: SessionActivityTable.id })
            .get()
          return activity !== undefined
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.retry({ while: isRetryableLock, schedule: lockRetrySchedule }), Effect.orDie)
}

function publishQuestionOutcome(
  events: EventV2.Interface,
  outcome: {
    readonly rejected: ReadonlyArray<QuestionV2.Request>
    readonly promoted: ReadonlyArray<QuestionV2.Request>
  },
  source: "session" | "recovery",
) {
  const publish = <D extends EventV2.Definition>(definition: D, data: EventV2.Data<D>) =>
    events.publish(definition, data, { isolateListeners: true }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("SessionActivity: question lifecycle event delivery failed after durable commit", {
          type: definition.type,
          cause,
        }),
      ),
    )
  return Effect.gen(function* () {
    yield* Effect.sync(() => outcome.rejected.forEach((request) => QuestionWakeup.wake(request.id)))
    yield* Effect.forEach(
      outcome.rejected,
      (request) =>
        Effect.gen(function* () {
          if (request.tool)
            yield* publish(SessionEvent.Tool.Failed, {
              sessionID: request.sessionID,
              timestamp: yield* DateTime.now,
              assistantMessageID: SessionMessage.ID.make(request.tool.messageID),
              callID: request.tool.callID,
              error: { type: "unknown", message: "Tool execution interrupted" },
              interruption: { source, ...(source === "recovery" ? { reason: "stale-lease" as const } : {}) },
              failure: SessionFailure.make(source === "recovery" ? "lease.stale" : "user.stop"),
              provider: { executed: false },
            })
          yield* publish(QuestionV2.Event.Dismissed, { sessionID: request.sessionID, requestID: request.id })
        }),
      { discard: true },
    )
    yield* Effect.forEach(outcome.promoted, (request) => publish(QuestionV2.Event.Requested, request), {
      discard: true,
    })
  })
}
