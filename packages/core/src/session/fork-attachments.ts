export * as SessionForkAttachments from "./fork-attachments"

import { and, eq, inArray, sql } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import { AttachmentTable } from "../attachment.sql"
import { Database } from "../database/database"
import { NonNegativeInt } from "../schema"
import { SessionForkEvent } from "./fork-event"

const Row = Schema.Struct({
  id: SessionForkEvent.AttachmentID,
  session_id: Schema.String,
  message_id: Schema.NullOr(Schema.String),
  mime: Schema.String,
  filename: Schema.NullOr(Schema.String),
  size_bytes: NonNegativeInt,
  source_path: Schema.Null,
  storage_path: Schema.String,
  blob_sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  created_at: NonNegativeInt,
})
export type Row = typeof Row.Type
const Rows = Schema.Array(Row)

const owned = (sessionID: string) =>
  and(
    eq(AttachmentTable.session_id, sessionID),
    sql`substr(${AttachmentTable.id}, 1, ${SessionForkEvent.AttachmentPrefix.length}) = ${SessionForkEvent.AttachmentPrefix}`,
  )

export function read(
  value: unknown,
  sessionID: string,
  messageIDs: ReadonlySet<string>,
): ReadonlyArray<Row> | undefined {
  const decoded = Schema.decodeUnknownOption(Rows, { onExcessProperty: "error" })(value)
  if (Option.isNone(decoded)) return undefined
  if (
    decoded.value.some(
      (row, index, rows) =>
        row.session_id !== sessionID ||
        (row.message_id !== null && !messageIDs.has(row.message_id)) ||
        (index > 0 && rows[index - 1].id >= row.id),
    )
  )
    return undefined
  return decoded.value
}

export function capture(db: Database.Interface["db"], sessionID: string) {
  return db.select().from(AttachmentTable).where(owned(sessionID)).orderBy(AttachmentTable.id).all().pipe(Effect.orDie)
}

/** Retained history may still refer to a removed message's attachment. Keep the
 * immutable bytes Session-owned instead of leaving a dangling message owner. */
export const detach = Effect.fn("SessionForkAttachments.detach")(function* (
  db: Database.Interface["db"],
  sessionID: string,
  messageIDs: ReadonlyArray<string>,
) {
  for (let offset = 0; offset < messageIDs.length; offset += 400)
    yield* db
      .update(AttachmentTable)
      .set({ message_id: null })
      .where(and(owned(sessionID), inArray(AttachmentTable.message_id, messageIDs.slice(offset, offset + 400))))
      .run()
      .pipe(Effect.orDie)
})

/** Blob bytes stay in the immutable content store; only independently owned
 * references are checkpointed. Never remove another Session's attachment or
 * overwrite a colliding global ID during recovery. */
export const restore = Effect.fn("SessionForkAttachments.restore")(function* (
  db: Database.Interface["db"],
  sessionID: string,
  rows: ReadonlyArray<Row>,
) {
  yield* db.delete(AttachmentTable).where(owned(sessionID)).run().pipe(Effect.orDie)
  for (let offset = 0; offset < rows.length; offset += 400)
    yield* db
      .insert(AttachmentTable)
      .values(rows.slice(offset, offset + 400))
      .run()
      .pipe(Effect.orDie)
})
