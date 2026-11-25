import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { isNull, notInArray, or } from "drizzle-orm"
import { Timestamps } from "./database/schema.sql"
import type { SessionSchema } from "./session/schema"

export const BackgroundJobTable = sqliteTable(
  "background_job",
  {
    id: text().primaryKey(),
    type: text().notNull(),
    status: text().notNull(),
    parent_session_id: text().$type<SessionSchema.ID>(),
    child_session_id: text().$type<SessionSchema.ID>(),
    parent_message_id: text(),
    parent_call_id: text(),
    title: text(),
    metadata: text({ mode: "json" }).$type<Record<string, unknown>>(),
    owner_id: text(),
    lease_until: integer(),
    heartbeat_at: integer(),
    cleanup_token: text(),
    time_owner_settled: integer(),
    output: text(),
    error: text(),
    delivery_status: text().notNull().default("pending"),
    ...Timestamps,
    time_completed: integer(),
  },
  (table) => [
    index("background_job_status_lease_idx").on(table.status, table.lease_until),
    index("background_job_parent_session_idx").on(table.parent_session_id),
    index("background_job_child_session_idx").on(table.child_session_id),
  ],
)

/** Terminal status and lease expiry do not attest independent owner cleanup.
 * Old/repaired rows intentionally remain unknown until explicitly reconciled. */
export function unsettled() {
  return or(
    notInArray(BackgroundJobTable.status, ["completed", "error", "cancelled"]),
    isNull(BackgroundJobTable.owner_id),
    isNull(BackgroundJobTable.cleanup_token),
    isNull(BackgroundJobTable.time_owner_settled),
  )
}
