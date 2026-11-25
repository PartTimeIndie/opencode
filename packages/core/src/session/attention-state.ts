export * as SessionAttentionState from "./attention-state"

import { and, desc, eq, gt, inArray, sql } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "../database/database"
import { SessionActivityTable, SessionTable } from "./sql"
import { SessionSchema } from "./schema"

/** Only durable terminal rows count. Idle and an expired runner lease are not outcomes. */
export const read = Effect.fn("SessionAttentionState.read")(function* (input: {
  db: Database.Interface["db"]
  sessionID: SessionSchema.ID
  afterSeq: number
}) {
  const session = yield* input.db.select({ id: SessionTable.id, title: SessionTable.title, directory: SessionTable.directory,
    archived: SessionTable.time_archived }).from(SessionTable).where(eq(SessionTable.id, input.sessionID)).get().pipe(Effect.orDie)
  if (!session) return undefined
  const valid = and(eq(SessionActivityTable.session_id, input.sessionID), sql`${SessionActivityTable.closed_seq} IS NOT NULL`)
  const [cursor, latest, summary, working] = yield* Effect.all([
    input.db.select({ seq: SessionActivityTable.closed_seq }).from(SessionActivityTable).where(valid)
      .orderBy(desc(SessionActivityTable.closed_seq)).limit(1).get().pipe(Effect.orDie),
    input.db.select({ id: SessionActivityTable.id, status: SessionActivityTable.status,
      closedSeq: SessionActivityTable.closed_seq }).from(SessionActivityTable)
      .where(and(valid, gt(SessionActivityTable.closed_seq, input.afterSeq),
        inArray(SessionActivityTable.status, ["completed", "failed"])))
      .orderBy(desc(SessionActivityTable.closed_seq)).limit(1).get().pipe(Effect.orDie),
    input.db.select({ count: sql<number>`count(*)`, lastFailureSeq: sql<number | null>`max(case when ${SessionActivityTable.status} = 'failed' then ${SessionActivityTable.closed_seq} end)` })
      .from(SessionActivityTable).where(and(valid, gt(SessionActivityTable.closed_seq, input.afterSeq),
        inArray(SessionActivityTable.status, ["completed", "failed"]))).get().pipe(Effect.orDie),
    input.db.select({ id: SessionActivityTable.id }).from(SessionActivityTable)
      .where(and(eq(SessionActivityTable.session_id, input.sessionID), inArray(SessionActivityTable.status, ["running", "recovering"]),
        gt(SessionActivityTable.lease_until, Date.now())))
      .limit(1).get().pipe(Effect.orDie),
  ])
  return {
    sessionID: session.id, title: session.title, directory: session.directory, archived: session.archived != null,
    cursor: cursor?.seq ?? 0, count: summary?.count ?? 0, lastFailureSeq: summary?.lastFailureSeq ?? undefined,
    last: latest ? { id: latest.id, status: latest.status, closedSeq: latest.closedSeq! } : undefined,
    working: !!working,
  }
})
