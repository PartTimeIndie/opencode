import { sql } from "drizzle-orm"
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"
import type { SessionSchema } from "../session/schema"
import { SessionTable } from "../session/sql"
import type { ActionMetadata, Answer, ID, Mode, Request } from "../question"

export type State = "queued" | "active" | "replied" | "rejected" | "orphaned"

// The physical table name is retained so existing installations migrate in place.
// New APIs expose this durable store only through neutral Surface types.
export const QuestionTable = sqliteTable(
  "session_question",
  {
    id: text().$type<ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    seq: integer().notNull(),
    state: text().$type<State>().notNull(),
    request: text({ mode: "json" }).$type<Request>().notNull(),
    mode: text().$type<Mode>().notNull().default("blocking"),
    revision: integer().notNull().default(1),
    action_metadata: text({ mode: "json" }).$type<ReadonlyArray<ActionMetadata>>().notNull().default([]),
    answers: text({ mode: "json" }).$type<ReadonlyArray<Answer>>(),
    receipt: text(),
    detached: integer({ mode: "boolean" }).notNull().default(false),
    allow_concurrent: integer({ mode: "boolean" }).notNull().default(false),
    activity_id: text(),
    assistant_message_id: text(),
    tool_call_id: text(),
    time_settled: integer(),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("session_question_session_seq_idx").on(table.session_id, table.seq),
    index("session_question_pending_fifo_idx").on(table.session_id, table.state, table.seq),
    uniqueIndex("session_question_active_idx")
      .on(table.session_id)
      .where(sql`${table.state} = 'active' AND ${table.allow_concurrent} = 0`),
    uniqueIndex("session_question_tool_retry_idx").on(
      table.session_id,
      table.assistant_message_id,
      table.tool_call_id,
    ),
    index("session_question_activity_idx").on(table.activity_id, table.state),
    index("session_question_mode_state_idx").on(table.mode, table.state),
  ],
)
