import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const ContentBlobTable = sqliteTable(
  "content_blob",
  {
    sha256: text().primaryKey(),
    size_bytes: integer().notNull(),
    mime: text().notNull(),
    storage_path: text().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [index("content_blob_created_idx").on(table.created_at)],
)

// Feature 2 — Attachment blob store metadata. Blobs live on disk under the
// opencode data dir; this table is the queryable index (session link, mime,
// size, retention). Additive: a migration is generated from this definition.
export const AttachmentTable = sqliteTable(
  "attachment",
  {
    id: text().primaryKey(),
    session_id: text().notNull(),
    message_id: text(),
    mime: text().notNull(),
    filename: text(),
    size_bytes: integer(),
    source_path: text(),
    storage_path: text().notNull(),
    blob_sha256: text(),
    created_at: integer().notNull(),
  },
  (table) => [
    index("attachment_session_idx").on(table.session_id),
    index("attachment_message_idx").on(table.message_id),
    index("attachment_blob_idx").on(table.blob_sha256),
  ],
)
