import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { SessionSchema } from "./session/schema"

export type SessionArchiveLocation = "active" | "archived"
export type SessionArchiveShardState = "open" | "sealed"
export type SessionArchiveOperation = "archive" | "reactivate" | "purge"
export type SessionArchiveJournalState = "prepared" | "copied" | "completed" | "failed"

export const SessionArchiveShardTable = sqliteTable(
  "session_archive_shard",
  {
    id: text().primaryKey(),
    path: text().notNull(),
    state: text().$type<SessionArchiveShardState>().notNull(),
    size_bytes: integer().notNull().default(0),
    max_bytes: integer().notNull(),
    session_count: integer().notNull().default(0),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
    time_sealed: integer(),
  },
  (table) => [index("session_archive_shard_state_idx").on(table.state, table.time_created)],
)

export const SessionArchiveCatalogTable = sqliteTable(
  "session_archive_catalog",
  {
    session_id: text().$type<SessionSchema.ID>().primaryKey(),
    project_id: text().notNull(),
    title: text().notNull(),
    directory: text().notNull(),
    session_data: text({ mode: "json" }).$type<Record<string, unknown>>(),
    location: text().$type<SessionArchiveLocation>().notNull(),
    shard_id: text().references(() => SessionArchiveShardTable.id),
    revision: integer().notNull().default(0),
    content_hash: text(),
    message_count: integer().notNull().default(0),
    input_count: integer().notNull().default(0),
    logical_bytes: integer().notNull().default(0),
    time_last_modified: integer().notNull(),
    time_archived: integer(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [
    index("session_archive_catalog_location_time_idx").on(table.location, table.time_last_modified),
    index("session_archive_catalog_project_idx").on(table.project_id, table.time_last_modified),
    index("session_archive_catalog_shard_idx").on(table.shard_id),
  ],
)

export const SessionArchiveJournalTable = sqliteTable(
  "session_archive_journal",
  {
    id: text().primaryKey(),
    operation_key: text().notNull(),
    session_id: text().$type<SessionSchema.ID>().notNull(),
    operation: text().$type<SessionArchiveOperation>().notNull(),
    state: text().$type<SessionArchiveJournalState>().notNull(),
    revision: integer().notNull(),
    shard_id: text().references(() => SessionArchiveShardTable.id),
    content_hash: text(),
    message_count: integer(),
    input_count: integer(),
    error: text(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
    time_completed: integer(),
  },
  (table) => [
    uniqueIndex("session_archive_journal_operation_idx").on(table.operation_key),
    index("session_archive_journal_state_idx").on(table.state, table.time_updated),
    index("session_archive_journal_session_idx").on(table.session_id, table.revision),
  ],
)
