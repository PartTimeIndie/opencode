import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Database } from "../database/database"
import { MessageDecodeError } from "./error"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionActivityTable, SessionContextEpochTable, SessionInputTable, SessionMessageTable, SessionTable } from "./sql"

type DatabaseService = Pick<Database.Interface["db"], "select">

const decode = Schema.decodeUnknownEffect(SessionMessage.Message)

const inheritedBoundary = Effect.fnUntraced(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  const row = yield* db.select({ through: SessionTable.fork_history_seq }).from(SessionTable)
    .where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
  return row?.through ?? undefined
})

const latestCompaction = Effect.fnUntraced(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  return yield* db
    .select()
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "compaction")))
    .orderBy(desc(SessionMessageTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
})

const messageRows = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  compaction: { readonly seq: number } | undefined,
  baselineSeq?: number,
  inheritedThroughSeq?: number,
) {
  const rows = yield* db
    .select()
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        compaction
          ? or(
              gte(SessionMessageTable.seq, compaction.seq),
              inheritedThroughSeq === undefined
                ? undefined
                : and(eq(SessionMessageTable.type, "system"), lte(SessionMessageTable.seq, inheritedThroughSeq)),
              baselineSeq === undefined
                ? undefined
                : and(eq(SessionMessageTable.type, "system"), gt(SessionMessageTable.seq, baselineSeq)),
            )
          : undefined,
        baselineSeq === undefined
          ? undefined
          : or(
              ne(SessionMessageTable.type, "system"),
              gt(SessionMessageTable.seq, baselineSeq),
              inheritedThroughSeq === undefined ? undefined : lte(SessionMessageTable.seq, inheritedThroughSeq),
              // Operational notices are not replacement system-context baselines.
              // Keep them until normal compaction, even if an epoch is rebuilt after a crash.
              sql`json_extract(${SessionMessageTable.data}, '$.metadata.systemNotice') = 'server-recovery'`,
            ),
      ),
    )
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  return rows
})

const decodeMessageRow = (row: typeof SessionMessageTable.$inferSelect) =>
  decode({ ...row.data, id: row.id, type: row.type }).pipe(
    Effect.mapError(
      () =>
        new MessageDecodeError({
          sessionID: SessionSchema.ID.make(row.session_id),
          messageID: SessionMessage.ID.make(row.id),
        }),
    ),
  )

export const load = Effect.fn("SessionHistory.load")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  const [epoch, compaction, inherited] = yield* Effect.all(
    [
      db
        .select({ baselineSeq: SessionContextEpochTable.baseline_seq })
        .from(SessionContextEpochTable)
        .where(eq(SessionContextEpochTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie),
      latestCompaction(db, sessionID),
      inheritedBoundary(db, sessionID),
    ],
    { concurrency: "unbounded" },
  )
  return yield* Effect.forEach(yield* messageRows(db, sessionID, compaction, epoch?.baselineSeq, inherited), decodeMessageRow)
})

export const loadForRunner = Effect.fn("SessionHistory.loadForRunner")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  baselineSeq: number,
) {
  return (yield* entriesForRunner(db, sessionID, baselineSeq)).map((entry) => entry.message)
})

export const entriesForRunner = Effect.fn("SessionHistory.entriesForRunner")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  baselineSeq: number,
) {
  const inherited = yield* inheritedBoundary(db, sessionID)
  const rows = yield* messageRows(db, sessionID, yield* latestCompaction(db, sessionID), baselineSeq, inherited)
  return yield* Effect.forEach(rows, (row) =>
    decodeMessageRow(row).pipe(Effect.map((message) => ({ seq: row.seq, message }))),
  )
})

export const currentEntriesForRunner = Effect.fn("SessionHistory.currentEntriesForRunner")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  const epoch = yield* db
    .select({ baselineSeq: SessionContextEpochTable.baseline_seq })
    .from(SessionContextEpochTable)
    .where(eq(SessionContextEpochTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
  return yield* entriesForRunner(db, sessionID, epoch?.baselineSeq ?? -1)
})

export const entryForMessage = Effect.fn("SessionHistory.entryForMessage")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  messageID: SessionMessage.ID,
) {
  const row = yield* db
    .select()
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.id, messageID)))
    .get()
    .pipe(Effect.orDie)
  if (!row) return
  return yield* decodeMessageRow(row).pipe(Effect.map((message) => ({ seq: row.seq, message })))
})

// Task collection uses durable prompt boundaries, not the compacted provider
// working set. Preserve receipt-bound structured attempts as well as the final
// assistant: a later closure or correction must not erase original findings.
export const loadForTask = Effect.fn("SessionHistory.loadForTask")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  promptID: SessionMessage.ID,
) {
  const anchor = yield* entryForMessage(db, sessionID, promptID)
  if (anchor?.message.type !== "user") return []
  // A promoted steer refines the running assignment, not a later task. Only
  // durable input + closed activity evidence may extend the result window.
  // Legacy/unattested history retains the strict next-User boundary.
  const input = yield* db.select({ id: SessionInputTable.id }).from(SessionInputTable).where(and(
    eq(SessionInputTable.session_id, sessionID), eq(SessionInputTable.id, promptID),
    eq(SessionInputTable.promoted_seq, anchor.seq),
  )).get().pipe(Effect.orDie)
  const activity = input ? yield* db.select({ closedSeq: SessionActivityTable.closed_seq }).from(SessionActivityTable).where(and(
    eq(SessionActivityTable.session_id, sessionID), lt(SessionActivityTable.opened_seq, anchor.seq),
    gte(SessionActivityTable.closed_seq, anchor.seq),
    inArray(SessionActivityTable.status, ["completed", "failed", "interrupted"]),
  )).orderBy(asc(SessionActivityTable.closed_seq)).limit(1).get().pipe(Effect.orDie) : undefined
  const closedSeq = activity?.closedSeq ?? undefined
  const next = yield* db.select({ seq: SessionMessageTable.seq }).from(SessionMessageTable)
    .leftJoin(SessionInputTable, and(eq(SessionInputTable.session_id, sessionID),
      eq(SessionInputTable.id, SessionMessageTable.id), eq(SessionInputTable.promoted_seq, SessionMessageTable.seq)))
    .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "user"), gt(SessionMessageTable.seq, anchor.seq),
      closedSeq === undefined ? undefined : or(isNull(SessionInputTable.id), ne(SessionInputTable.delivery, "steer"),
        gt(SessionMessageTable.seq, closedSeq))))
    .orderBy(asc(SessionMessageTable.seq)).limit(1).get().pipe(Effect.orDie)
  const response = yield* db.select().from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "assistant"),
      gt(SessionMessageTable.seq, anchor.seq), next ? lt(SessionMessageTable.seq, next.seq) : undefined,
      closedSeq === undefined ? undefined : lte(SessionMessageTable.seq, closedSeq)))
    .orderBy(desc(SessionMessageTable.seq)).limit(1).get().pipe(Effect.orDie)
  const attempts = yield* db.select().from(SessionMessageTable).where(and(
    eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "assistant"),
    gt(SessionMessageTable.seq, anchor.seq), next ? lt(SessionMessageTable.seq, next.seq) : undefined,
    closedSeq === undefined ? undefined : lte(SessionMessageTable.seq, closedSeq),
    sql`json_extract(${SessionMessageTable.data}, '$.structuredOutputAttempt.inputID') = ${promptID}`,
  )).orderBy(asc(SessionMessageTable.seq)).all().pipe(Effect.orDie)
  const rows = response && !attempts.some((row) => row.id === response.id) ? [...attempts, response] : attempts
  return [anchor.message, ...yield* Effect.forEach(rows, decodeMessageRow)]
})

// Permission authority must survive model-context compaction without trusting
// its assistant-authored summary or a user instruction admitted after the call.
// The SQL text predicates are cheap supersets (SQLite trim only strips spaces);
// JavaScript trim semantics below decide which rows actually count, so
// whitespace-only dialogue never consumes the meaningful-message budget.
export const CANDIDATE_ROW_LIMIT = 300

const ANCHOR_CANDIDATES = 5

export const loadForPermission = Effect.fn("SessionHistory.loadForPermission")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  sourceMessageID: SessionMessage.ID | undefined,
  recentLimit: number,
) {
  const source = sourceMessageID ? yield* entryForMessage(db, sessionID, sourceMessageID) : undefined
  if (sourceMessageID && source?.message.type !== "assistant") return
  const anchorCandidates = yield* db
    .select()
    .from(SessionMessageTable)
    .where(and(
      eq(SessionMessageTable.session_id, sessionID),
      eq(SessionMessageTable.type, "user"),
      sql`length(trim(coalesce(json_extract(${SessionMessageTable.data}, '$.text'), ''))) > 0`,
      source ? lt(SessionMessageTable.seq, source.seq) : undefined,
    ))
    .orderBy(desc(SessionMessageTable.seq))
    .limit(ANCHOR_CANDIDATES)
    .all()
    .pipe(Effect.orDie)
  let anchor: { seq: number; message: SessionMessage.User } | undefined
  for (const row of anchorCandidates) {
    const message = yield* decodeMessageRow(row)
    if (message.type === "user" && message.text.trim().length > 0) {
      anchor = { seq: row.seq, message }
      break
    }
  }
  if (!anchor) return
  const rows = yield* db
    .select()
    .from(SessionMessageTable)
    .where(and(
      eq(SessionMessageTable.session_id, sessionID),
      lte(SessionMessageTable.seq, anchor.seq),
      or(
        and(eq(SessionMessageTable.type, "user"), sql`length(trim(coalesce(json_extract(${SessionMessageTable.data}, '$.text'), ''))) > 0`),
        and(eq(SessionMessageTable.type, "assistant"), sql`exists (
          select 1 from json_each(${SessionMessageTable.data}, '$.content')
          where json_extract(value, '$.type') = 'text' and length(trim(coalesce(json_extract(value, '$.text'), ''))) > 0
        )`),
      ),
    ))
    .orderBy(desc(SessionMessageTable.seq))
    .limit(CANDIDATE_ROW_LIMIT)
    .all()
    .pipe(Effect.orDie)
  const collected: SessionMessage.Message[] = []
  let recents = 0
  for (const message of yield* Effect.forEach(rows, decodeMessageRow)) {
    if (message.id === anchor.message.id) {
      collected.push(message)
      continue
    }
    // One meaningful message beyond recentLimit lets Intent.build report
    // history truncation through its existing candidate-count check.
    if (recents > recentLimit) break
    if (!hasMeaningfulText(message)) continue
    collected.push(message)
    recents++
  }
  const messages = collected.toReversed()
  return source ? [...messages, source.message] : messages
})

function hasMeaningfulText(message: SessionMessage.Message) {
  if (message.type === "user") return message.text.trim().length > 0
  if (message.type !== "assistant") return false
  // Mirrors intentMessage: reasoning, tool output, and custom parts never carry dialogue.
  return message.content.some((part) => part.type === "text" && part.text.trim().length > 0)
}

export * as SessionHistory from "./history"
