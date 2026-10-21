export * as SessionDispatchOrigin from "./dispatch-origin"

import { and, desc, eq, gte, inArray, isNull, lte, or } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Database } from "../database/database"
import { SessionSchema } from "./schema"
import { SessionMessage } from "./message"
import {
  SessionActivityTable,
  SessionInputTable,
  SessionMessageTable,
  SessionDispatchTable,
  SessionLinkTable,
} from "./sql"

// Authority comes from a promoted plugin dispatch in the tool message's activity,
// never model-authored metadata, the currently selected tab, or a mutable parentID.
// Ended links still protect already admitted worker work until that activity ends.
export const contains = Effect.fn("SessionDispatchOrigin.contains")(function* (
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
  messageID: string,
) {
  if (!Schema.is(SessionMessage.ID)(messageID)) return false
  const message = yield* db
    .select({ seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        eq(SessionMessageTable.id, messageID),
        eq(SessionMessageTable.type, "assistant"),
      ),
    )
    .get()
    .pipe(Effect.orDie)
  if (!message) return false
  const queue = yield* db
    .select({ seq: SessionInputTable.promoted_seq })
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        eq(SessionInputTable.delivery, "queue"),
        lte(SessionInputTable.promoted_seq, message.seq),
      ),
    )
    .orderBy(desc(SessionInputTable.promoted_seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  const origin = yield* db
    .select({ id: SessionDispatchTable.target_input_id })
    .from(SessionDispatchTable)
    .innerJoin(
      SessionLinkTable,
      and(
        eq(SessionLinkTable.plugin_id, SessionDispatchTable.plugin_id),
        eq(SessionLinkTable.source_session_id, SessionDispatchTable.source_session_id),
      ),
    )
    .innerJoin(SessionInputTable, eq(SessionInputTable.id, SessionDispatchTable.target_input_id))
    .innerJoin(
      SessionActivityTable,
      and(
        eq(SessionActivityTable.session_id, sessionID),
        lte(SessionActivityTable.opened_seq, SessionInputTable.promoted_seq),
        or(
          gte(SessionActivityTable.closed_seq, message.seq),
          and(isNull(SessionActivityTable.closed_seq), inArray(SessionActivityTable.status, ["running", "recovering"])),
        ),
      ),
    )
    .where(
      and(
        eq(SessionLinkTable.permission_policy, "single-use"),
        eq(SessionLinkTable.target_session_id, sessionID),
        eq(SessionDispatchTable.target_session_id, sessionID),
        eq(SessionInputTable.session_id, sessionID),
        lte(SessionInputTable.promoted_seq, message.seq),
        queue?.seq == null ? undefined : gte(SessionInputTable.promoted_seq, queue.seq),
      ),
    )
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  return origin !== undefined
})

// The host-bound link, not the source agent name or user metadata, owns this restriction.
export const sourceRestricted = Effect.fn("SessionDispatchOrigin.sourceRestricted")(function* (
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
) {
  const row = yield* db
    .select({ id: SessionLinkTable.source_session_id })
    .from(SessionLinkTable)
    .where(and(eq(SessionLinkTable.source_session_id, sessionID), eq(SessionLinkTable.permission_policy, "single-use")))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  return row !== undefined
})
