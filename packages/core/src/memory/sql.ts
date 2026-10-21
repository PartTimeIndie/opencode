import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"

export type MemoryScope = "global" | "project" | "workspace" | "session"
export type MemoryState = "pending" | "approved" | "rejected" | "deleted"
export type MemoryProvenance = {
  readonly origin: string
  readonly captured_at: number
  readonly session_id?: string
  readonly message_id?: string
  readonly artifact?: string
}

export const MemoryTable = sqliteTable(
  "memory",
  {
    id: text().primaryKey(),
    scope: text().$type<MemoryScope>().notNull(),
    scope_key: text().notNull(),
    content: text().notNull(),
    source: text().notNull(),
    provenance: text({ mode: "json" }).$type<MemoryProvenance>().notNull(),
    state: text().$type<MemoryState>().notNull().default("pending"),
    reviewed_by: text(),
    time_reviewed: integer(),
    ...Timestamps,
  },
  (table) => [
    index("memory_scope_state_time_idx").on(table.scope, table.scope_key, table.state, table.time_updated),
    index("memory_state_time_idx").on(table.state, table.time_updated),
  ],
)

export const MemoryEmbeddingTable = sqliteTable(
  "memory_embedding",
  {
    memory_id: text()
      .notNull()
      .references(() => MemoryTable.id, { onDelete: "cascade" }),
    model: text().notNull(),
    dimensions: integer().notNull(),
    vector: text({ mode: "json" }).$type<number[]>().notNull(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    uniqueIndex("memory_embedding_memory_model_idx").on(table.memory_id, table.model),
    index("memory_embedding_model_idx").on(table.model),
  ],
)
