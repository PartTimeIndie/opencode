import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"
import type { Control } from "./control"
import { Timestamps } from "./database/schema.sql"
import type { ProjectSchema } from "./project/schema"
import { ProjectTable } from "./project/sql"

type SurfaceActionMetadata = {
  readonly id: string
  readonly path: string
  readonly permissions: ReadonlyArray<{ readonly action: string; readonly resources: ReadonlyArray<string> }>
}

export const SurfaceToolTable = sqliteTable(
  "surface_tool",
  {
    id: text().primaryKey(),
    scope: text().$type<"project" | "global">().notNull(),
    scope_key: text().notNull(),
    project_id: text()
      .$type<ProjectSchema.ID>()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    directory: text().notNull(),
    origin_request_id: text(),
    origin_session_id: text(),
    origin_revision: integer(),
    mode: text().$type<"interactive" | "passive">().notNull(),
    definition_revision: integer().notNull().default(1),
    action_metadata: text({ mode: "json" }).$type<ReadonlyArray<SurfaceActionMetadata>>().notNull().default([]),
    surface: text({ mode: "json" }).$type<Control.PartData>().notNull(),
    state_version: integer().notNull().default(1),
    state_revision: integer().notNull().default(1),
    state_values: text({ mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
    hidden: integer({ mode: "boolean" }).notNull().default(false),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("surface_tool_origin_scope_idx").on(table.origin_request_id, table.scope_key),
    index("surface_tool_scope_idx").on(table.scope, table.scope_key, table.hidden),
  ],
)

export const SurfaceActionInvocationTable = sqliteTable(
  "surface_action_invocation",
  {
    id: text().primaryKey(),
    target_kind: text().$type<"request" | "tool">().notNull(),
    target_id: text().notNull(),
    target_revision: integer().notNull(),
    action_id: text().notNull(),
    source: text(),
    payload_hash: text().notNull(),
    // Non-null only for once executions; the partial unique index on this
    // column is what makes concurrent once claims atomic.
    execution_key: text(),
    effect_started_at: integer(),
    error_class: text().$type<"preflight" | "unknown" | null>(),
    state: text().$type<"pending" | "completed" | "failed">().notNull(),
    result: text({ mode: "json" }).$type<unknown>(),
    error: text(),
    ...Timestamps,
  },
  (table) => [
    index("surface_action_invocation_target_idx").on(
      table.target_kind,
      table.target_id,
      table.target_revision,
      table.action_id,
    ),
    uniqueIndex("surface_action_execution_key_idx")
      .on(table.execution_key)
      .where(sql`${table.execution_key} IS NOT NULL`),
  ],
)
