import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { SessionTable } from "./session/sql"
import type { SessionSchema } from "./session/schema"
import type { SessionMessage } from "./session/message"
import type { FileKnowledge } from "./file-knowledge"

// Metadata only. Read bytes are not copied into a second content archive.
export const FileKnowledgeReceiptTable = sqliteTable(
  "file_knowledge_receipt",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    assistant_message_id: text().$type<SessionMessage.ID>().notNull(),
    message_seq: integer().notNull(),
    call_id: text().notNull(),
    target: text().notNull(),
    sha256: text().notNull(),
    coverage: text({ mode: "json" }).$type<FileKnowledge.Coverage>().notNull(),
    origin: text().$type<"pending_read" | "read" | "write">().notNull(),
    output_sha256: text(),
    source_receipt_id: integer(),
  },
  (table) => [
    index("file_knowledge_session_target_idx").on(table.session_id, table.target, table.origin, table.id),
    index("file_knowledge_message_idx").on(table.session_id, table.assistant_message_id),
    index("file_knowledge_call_idx").on(table.session_id, table.call_id, table.origin),
    uniqueIndex("file_knowledge_source_idx").on(table.source_receipt_id),
  ],
)

// Not session-cascaded: deleting dialogue cannot erase an unresolved file effect.
export const FileMutationPendingTable = sqliteTable("file_mutation_pending", {
  target: text().primaryKey(),
  operation_id: text().notNull(),
  session_id: text().notNull(),
  receipt_id: integer().notNull(),
})
