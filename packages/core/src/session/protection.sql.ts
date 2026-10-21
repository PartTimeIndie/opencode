import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { SessionSchema } from "./schema"

/**
 * Retention protection is deliberately kept outside the session projection.
 * Archived sessions no longer have an active `session` row, so a foreign key
 * would make the protection disappear exactly when it is most important.
 */
export const SessionProtectionTable = sqliteTable("session_protection", {
  session_id: text().$type<SessionSchema.ID>().primaryKey(),
  protected_at: integer().notNull(),
  updated_at: integer().notNull(),
})
