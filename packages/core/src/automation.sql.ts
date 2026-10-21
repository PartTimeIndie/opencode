import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

// Feature 3 — Automations. A background scheduler (Effect subsystem, started by
// the server runtime) evaluates `trigger` and dispatches `action`. The desktop
// tray keeps the process alive so schedules fire while the app is resident.
//
// `trigger` and `action` are JSON-encoded to keep the row shape stable while
// the vocabulary (cron/interval, session/cli/new-session) evolves.
export const AutomationTable = sqliteTable("automation", {
  id: text().primaryKey(),
  name: text().notNull(),
  // 0/1 boolean — avoids depending on a boolean mode driver config.
  enabled: integer().notNull().default(1),
  trigger: text().notNull(),
  action: text().notNull(),
  last_run_at: integer(),
  next_run_at: integer(),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
})

export const AutomationRunTable = sqliteTable("automation_run", {
  id: text().primaryKey(),
  automation_id: text().notNull(),
  status: text().notNull(),
  exit_code: integer(),
  output: text(),
  duration_ms: integer(),
  started_at: integer().notNull(),
  finished_at: integer(),
  next_retry_at: integer(),
})
