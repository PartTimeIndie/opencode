import { and, asc, desc, eq, gt, gte, lt, lte, ne, or, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Database } from "../database/database"
import { MessageDecodeError } from "./error"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionContextEpochTable, SessionMessageTable } from "./sql"

type DatabaseService = Database.Interface["db"]

const decode = Schema.decodeUnknownEffect(SessionMessage.Message)

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
              baselineSeq === undefined
                ? undefined
                : and(eq(SessionMessageTable.type, "system"), gt(SessionMessageTable.seq, baselineSeq)),
            )
          : undefined,
        baselineSeq === undefined
          ? undefined
          : or(ne(SessionMessageTable.type, "system"), gt(SessionMessageTable.seq, baselineSeq)),
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
  const [epoch, compaction] = yield* Effect.all(
    [
      db
        .select({ baselineSeq: SessionContextEpochTable.baseline_seq })
        .from(SessionContextEpochTable)
        .where(eq(SessionContextEpochTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie),
      latestCompaction(db, sessionID),
    ],
    { concurrency: "unbounded" },
  )
  return yield* Effect.forEach(yield* messageRows(db, sessionID, compaction, epoch?.baselineSeq), decodeMessageRow)
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
  const rows = yield* messageRows(db, sessionID, yield* latestCompaction(db, sessionID), baselineSeq)
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
