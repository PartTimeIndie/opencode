export * as SessionSkillSelection from "./skill-selection"

import { and, count, desc, eq, gt, lt, ne } from "drizzle-orm"
import { DateTime, Effect, Option, Schema } from "effect"
import type { Database } from "../database/database"
import { EventV2 } from "../event"
import { SkillV2 } from "../skill"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { SessionInput } from "./input"
import type { SessionSchema } from "./schema"
import { SessionInputTable, SessionMessageTable, SessionSkillSelectionBarrierTable, SessionSkillSelectionTable } from "./sql"

type DB = Database.Interface["db"]
type Row = typeof SessionSkillSelectionTable.$inferSelect
type Limits = { readonly minutes: number; readonly messages: number }
type Selection = {
  readonly selected: boolean
  readonly reason?: "state_unavailable" | "not_selected" | "forgotten" | "expired_time" | "expired_messages" | "renewal_declined"
  readonly row?: Row
}

export const row = Effect.fn("SessionSkillSelection.row")(function* (db: DB, sessionID: SessionSchema.ID, name: string) {
  return yield* db.select().from(SessionSkillSelectionTable).where(and(
    eq(SessionSkillSelectionTable.session_id, sessionID), eq(SessionSkillSelectionTable.name, name),
  )).get().pipe(Effect.orDie)
})

/** Informational snapshot only. Listing must not adopt a slash or renew a gate. */
export const inspect = Effect.fn("SessionSkillSelection.inspect")(function* (db: DB, input: {
  readonly sessionID: SessionSchema.ID
  readonly limits: Limits
  readonly now: number
  readonly names: ReadonlyArray<string>
  readonly enabled?: boolean
}) {
  return yield* db.transaction(() => Effect.gen(function* () {
    const revision = yield* SessionInput.latestSeq(db, input.sessionID)
    const rows = yield* db.select().from(SessionSkillSelectionTable)
      .where(eq(SessionSkillSelectionTable.session_id, input.sessionID)).all().pipe(Effect.orDie)
    const barrier = yield* db.select().from(SessionSkillSelectionBarrierTable)
      .where(eq(SessionSkillSelectionBarrierTable.session_id, input.sessionID)).get().pipe(Effect.orDie)
    const selections = yield* Effect.forEach(rows, (current) => Effect.gen(function* () {
      const later = yield* messagesSince(db, input.sessionID, current, Number.MAX_SAFE_INTEGER)
      const minutes = Math.min(input.limits.minutes, current.limit_minutes)
      const messages = Math.min(input.limits.messages, current.limit_messages)
      const recognized = input.names.includes(current.name)
      return {
        name: current.name, status: input.enabled === false ? "state_unavailable" as const : recognized ? validity(current, input.limits, input.now,
          current.origin_seq <= (barrier?.forgotten_seq ?? -1), later) : "missing" as const,
        generation: current.generation, originKind: current.origin_kind, selectedAt: current.selected_at,
        expiresAt: current.selected_at + minutes * 60_000,
        remainingMs: Math.max(0, current.selected_at + minutes * 60_000 - input.now),
        remainingMessages: Math.max(0, messages - later), limitMinutes: minutes, limitMessages: messages, recognized,
      }
    }))
    return { sessionID: input.sessionID, revision, serverNow: input.now, selections }
  })).pipe(Effect.orDie)
})

/** Conservative Session revision CAS, serialized with the event projector.
 * Even unrelated intervening Session events require a fresh status snapshot. */
export const forget = Effect.fn("SessionSkillSelection.forget")(function* (db: DB, events: EventV2.Interface, input: {
  readonly sessionID: SessionSchema.ID
  readonly name?: string
  readonly expectedRevision: number
  readonly operationID: string
}) {
  return yield* EventV2.atomic(db, Effect.gen(function* () {
    const revision = yield* SessionInput.latestSeq(db, input.sessionID)
    const current = input.name === undefined
      ? yield* db.select().from(SessionSkillSelectionBarrierTable)
        .where(eq(SessionSkillSelectionBarrierTable.session_id, input.sessionID)).get().pipe(Effect.orDie)
      : yield* row(db, input.sessionID, input.name)
    if (current?.operation_id === input.operationID) return { _tag: "DuplicateOperation" as const, revision }
    if (!input.operationID.trim() || input.name?.trim() === "" || !Number.isSafeInteger(input.expectedRevision)
      || input.expectedRevision !== revision) return { _tag: "RevisionConflict" as const, revision }
    yield* events.publish(SessionEvent.SkillSelection.Mutation, {
      sessionID: input.sessionID, timestamp: DateTime.makeUnsafe(Date.now()), mutation: "forgotten",
      name: input.name, operationID: input.operationID,
    })
    return { _tag: "Forgotten" as const, revision: yield* SessionInput.latestSeq(db, input.sessionID) }
  }))
})

/** Only transport-attested, promoted user inputs can establish slash selection.
 * Read durable history rather than a compaction summary or model-provided text. */
export const resolveForGate = Effect.fn("SessionSkillSelection.resolveForGate")(function* (input: {
  readonly db: DB
  readonly events: EventV2.Interface
  readonly sessionID: SessionSchema.ID
  readonly skill: SkillV2.Info
  readonly fenceSeq: number
  readonly assistantMessageID: SessionMessage.ID
  readonly limits: Limits
  readonly now: number
}) {
  return yield* EventV2.atomic(input.db, Effect.gen(function* (): Effect.fn.Return<Selection> {
    const source = yield* input.db.select().from(SessionMessageTable).where(and(
      eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.id, input.assistantMessageID),
      eq(SessionMessageTable.type, "assistant"), eq(SessionMessageTable.seq, input.fenceSeq),
    )).get().pipe(Effect.orDie)
    if (!source || !validLimits(input.limits) || !Number.isFinite(input.now))
      return { selected: false, reason: "state_unavailable" }
    const stored = yield* row(input.db, input.sessionID, input.skill.name)
    const barrier = yield* input.db.select().from(SessionSkillSelectionBarrierTable)
      .where(eq(SessionSkillSelectionBarrierTable.session_id, input.sessionID)).get().pipe(Effect.orDie)
    const floor = Math.max(barrier?.forgotten_seq ?? -1, stored?.forgotten_seq ?? -1)
    // A bounded adoption scan fails closed when its relevant origin is absent.
    // A previously recorded selection does not depend on keeping its source in
    // the provider's working context.
    const candidates = yield* input.db.select({ message: SessionMessageTable, admitted: SessionInputTable })
      .from(SessionMessageTable).innerJoin(SessionInputTable, and(
        eq(SessionInputTable.session_id, SessionMessageTable.session_id),
        eq(SessionInputTable.id, SessionMessageTable.id),
        eq(SessionInputTable.promoted_seq, SessionMessageTable.seq),
        eq(SessionInputTable.origin, "interactive"),
      )).where(and(
        eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.type, "user"),
        lt(SessionMessageTable.seq, input.fenceSeq), gt(SessionMessageTable.seq, floor),
      )).orderBy(desc(SessionMessageTable.seq)).limit(1001).all().pipe(Effect.orDie)
    const candidate = candidates.find(({ message, admitted }) => {
      if (message.id === stored?.receipt_input_id) return false
      // The projector stores identity columns outside data, just like history readers expect.
      const user = Option.getOrUndefined(Schema.decodeUnknownOption(SessionMessage.User)({
        ...message.data, id: message.id, type: message.type,
      }))
      return user?.id === message.id && user.text === admitted.prompt.text && SkillV2.invokedBySlash(input.skill, user.text)
    })
    if (candidate && candidate.message.seq > (stored?.origin_seq ?? -1)) {
      yield* input.events.publish(SessionEvent.SkillSelection.Mutation, {
        sessionID: input.sessionID, timestamp: DateTime.makeUnsafe(input.now), mutation: "selected", name: input.skill.name,
        generation: (stored?.generation ?? 0) + 1,
        origin: { kind: "input", id: candidate.message.id, seq: candidate.message.seq },
        selectedAt: DateTime.makeUnsafe(candidate.admitted.time_created), limits: input.limits,
      })
    }
    const current = yield* row(input.db, input.sessionID, input.skill.name)
    if (!current) return { selected: false, reason: "not_selected" }
    if (current.forgotten_at !== null || current.origin_seq <= floor)
      return { selected: false, reason: "forgotten", row: current }
    if (current.origin_seq >= input.fenceSeq && current.bound_message_id !== input.assistantMessageID)
      return { selected: false, reason: "not_selected", row: current }
    const later = yield* messagesSince(input.db, input.sessionID, current, input.fenceSeq)
    const status = validity(current, input.limits, input.now, current.origin_seq <= floor, later)
    return status === "active" ? { selected: true, row: current } : { selected: false, reason: status, row: current }
  }))
})

/** Host-only receipt adapter. The permission owner must validate the human
 * receipt before calling this; a receipt string is never a model-facing API. */
export const recordReceipt = Effect.fn("SessionSkillSelection.recordReceipt")(function* (
  db: DB,
  events: EventV2.Interface,
  input: {
    readonly sessionID: SessionSchema.ID
    readonly name: string
    readonly kind: "renewal"
    readonly receiptID: string
    readonly limits: Limits
    readonly boundMessageID: SessionMessage.ID
    readonly expectedGeneration: number
  },
) {
  return yield* EventV2.atomic(db, Effect.gen(function* () {
    if (!input.receiptID.trim() || !validLimits(input.limits)) return false
    const current = yield* row(db, input.sessionID, input.name)
    if (!current || current.generation !== input.expectedGeneration || current.forgotten_at !== null) return false
    const source = yield* db.select().from(SessionMessageTable).where(and(
      eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.id, input.boundMessageID),
      eq(SessionMessageTable.type, "assistant"),
    )).get().pipe(Effect.orDie)
    if (!source) return false
    const now = DateTime.makeUnsafe(Date.now())
    yield* events.publish(SessionEvent.SkillSelection.Mutation, {
      sessionID: input.sessionID, timestamp: now, mutation: "selected", name: input.name,
      generation: current.generation + 1,
      origin: { kind: input.kind, id: input.receiptID, seq: source.seq },
      selectedAt: now, limits: input.limits, boundMessageID: input.boundMessageID,
    })
    return true
  }))
})

export const recordRenewalDeclined = Effect.fn("SessionSkillSelection.recordRenewalDeclined")(function* (
  db: DB,
  events: EventV2.Interface,
  input: { readonly sessionID: SessionSchema.ID; readonly name: string; readonly generation: number },
) {
  return yield* EventV2.atomic(db, Effect.gen(function* () {
    const current = yield* row(db, input.sessionID, input.name)
    if (!current || current.generation !== input.generation) return
    yield* events.publish(SessionEvent.SkillSelection.Mutation, {
      sessionID: input.sessionID, timestamp: DateTime.makeUnsafe(Date.now()), mutation: "renewal_declined",
      name: input.name, generation: input.generation,
    })
  }))
})

function validLimits(limits: Limits) {
  return Number.isSafeInteger(limits.minutes) && limits.minutes > 0
    && Number.isSafeInteger(limits.messages) && limits.messages > 0
}

const messagesSince = Effect.fn("SessionSkillSelection.messagesSince")(function* (db: DB, sessionID: SessionSchema.ID, current: Row, fenceSeq: number) {
  const later = yield* db.select({ count: count() }).from(SessionInputTable).where(and(
    eq(SessionInputTable.session_id, sessionID), eq(SessionInputTable.origin, "interactive"),
    gt(SessionInputTable.promoted_seq, current.origin_seq), lt(SessionInputTable.promoted_seq, fenceSeq),
    current.receipt_input_id === null ? undefined : ne(SessionInputTable.id, current.receipt_input_id),
  )).get().pipe(Effect.orDie)
  return later?.count ?? 0
})

function validity(current: Row, limits: Limits, now: number, forgotten: boolean, later: number) {
  if (forgotten || current.forgotten_at !== null) return "forgotten" as const
  if (current.renewal_declined_generation === current.generation) return "renewal_declined" as const
  if (!validLimits(limits) || !validLimits({ minutes: current.limit_minutes, messages: current.limit_messages })
    || !Number.isFinite(now) || now < current.selected_at) return "state_unavailable" as const
  if (now - current.selected_at >= Math.min(limits.minutes, current.limit_minutes) * 60_000) return "expired_time" as const
  if (later >= Math.min(limits.messages, current.limit_messages)) return "expired_messages" as const
  return "active" as const
}
