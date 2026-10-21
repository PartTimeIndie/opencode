import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { EventV2 } from "../event"

export const EventSequenceTable = sqliteTable("event_sequence", {
  aggregate_id: text().notNull().primaryKey(),
  seq: integer().notNull(),
  owner_id: text(),
})

export const EventCheckpointTable = sqliteTable("event_checkpoint", {
  aggregate_id: text()
    .notNull()
    .primaryKey()
    .references(() => EventSequenceTable.aggregate_id, { onDelete: "cascade" }),
  seq: integer().notNull(),
  version: integer().notNull(),
  data: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
  time_created: integer().notNull(),
})

export const EventTable = sqliteTable(
  "event",
  {
    id: text().$type<EventV2.ID>().primaryKey(),
    aggregate_id: text()
      .notNull()
      .references(() => EventSequenceTable.aggregate_id, { onDelete: "cascade" }),
    seq: integer().notNull(),
    type: text().notNull(),
    data: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
  },
  (table) => [
    uniqueIndex("event_aggregate_seq_idx").on(table.aggregate_id, table.seq),
    index("event_aggregate_type_seq_idx").on(table.aggregate_id, table.type, table.seq),
  ],
)
