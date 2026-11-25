import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core"
import * as DatabasePath from "../database/path"
import { Timestamps } from "../database/schema.sql"
import { ProjectSchema } from "./schema"

export const ProjectTable = sqliteTable("project", {
  id: text().$type<ProjectSchema.ID>().primaryKey(),
  worktree: DatabasePath.absoluteColumn().notNull(),
  vcs: text(),
  name: text(),
  icon_url: text(),
  icon_url_override: text(),
  icon_color: text(),
  icon_generated_url: text(),
  icon_generation_mode: text().$type<"inherit" | "enabled" | "disabled">(),
  icon_generation_status: text().$type<"idle" | "queued" | "generating" | "ready" | "failed">(),
  icon_generation_error: text(),
  icon_generation_attempt: integer().notNull().default(0),
  icon_generation_attempted_at: integer(),
  icon_generation_completed_at: integer(),
  icon_generation_style: text(),
  ...Timestamps,
  time_initialized: integer(),
  sandboxes: DatabasePath.absoluteArrayColumn().notNull(),
  commands: text({ mode: "json" }).$type<{ start?: string }>(),
})

export const ProjectDirectoryTable = sqliteTable(
  "project_directory",
  {
    project_id: text()
      .$type<ProjectSchema.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    directory: DatabasePath.absoluteColumn().notNull(),
    type: text().$type<"main" | "root" | "git_worktree">(),
    strategy: text(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [primaryKey({ columns: [table.project_id, table.directory] })],
)

// Folders without a project row (non-git directories resolve to `global`)
// keep their icon here, addressed by one lexically canonical directory key.
export const ProjectDirectoryIconTable = sqliteTable("project_directory_icon", {
  directory: text().primaryKey(),
  url: text().notNull(),
  time_updated: integer().notNull(),
})
