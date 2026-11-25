import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { SessionTable, SessionInputTable } from "../sql"
import type { SessionSchema } from "../schema"
import type { SessionMessage } from "../message"
import type { LegacyDelegationRecord } from "./record"
import type { ModelV2 } from "../../model"
import type { AgentV2 } from "../../agent"

// Historical storage only. Preserve installed table names, defaults, foreign
// keys and indexes. No declaration below grants execution or commissioning.
export const SessionOrchestratorTable = sqliteTable("session_orchestrator", {
  main_session_id: text()
    .$type<SessionSchema.ID>()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  revision: integer().notNull().default(1),
  checkout_id: text().notNull().default(""),
  interaction: integer({ mode: "boolean" }).notNull().default(true),
  workspace_mode: text().$type<LegacyDelegationRecord.WorkspaceMode>().notNull().default("mirror"),
  max_workers: integer().notNull().default(4),
  min_cache_read_ratio: real().notNull().default(0.8),
  control: text().$type<LegacyDelegationRecord.Control>().notNull().default("active"),
  time_created: integer()
    .notNull()
    .$default(() => Date.now()),
  time_updated: integer()
    .notNull()
    .$default(() => Date.now()),
})

export const SessionOrchestratorCommissionTable = sqliteTable(
  "session_orchestrator_commission",
  {
    id: text().primaryKey(),
    main_session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionOrchestratorTable.main_session_id),
    origin_input_id: text()
      .$type<SessionMessage.ID>()
      .notNull()
      .references(() => SessionInputTable.id),
    origin_digest: text().notNull(),
    scope: text().notNull(),
    source_assistant_id: text().$type<SessionMessage.ID>().notNull(),
    source_call_id: text().notNull(),
    agent: text().$type<AgentV2.ID>().notNull(),
    model: text({ mode: "json" }).$type<ModelV2.Ref>().notNull(),
    policy_digest: text().notNull(),
    settings: text({ mode: "json" }).$type<LegacyDelegationRecord.Settings>().notNull(),
    cache_family: text().notNull(),
    // Additive repair must revoke unknown old rows, never resurrect approval.
    revoked: integer({ mode: "boolean" }).notNull().default(true),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    uniqueIndex("session_orchestrator_commission_origin_idx").on(table.main_session_id, table.origin_input_id),
    uniqueIndex("session_orchestrator_commission_family_idx").on(table.cache_family),
  ],
)

export const SessionOrchestratorTaskTable = sqliteTable(
  "session_orchestrator_task",
  {
    id: text().primaryKey(),
    main_session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionOrchestratorTable.main_session_id, { onDelete: "cascade" }),
    request_id: text().notNull(),
    checkout_id: text().notNull().default(""),
    min_cache_read_ratio: real().notNull().default(0.8),
    origin_input_id: text()
      .$type<SessionMessage.ID>()
      .notNull()
      .references(() => SessionInputTable.id),
    origin_user_message_id: text().$type<SessionMessage.ID>().notNull(),
    goal: text().notNull(),
    acceptance: text().notNull(),
    resources: text({ mode: "json" }).$type<readonly string[]>().notNull(),
    dependencies: text({ mode: "json" }).$type<readonly string[]>().notNull(),
    state: text().$type<LegacyDelegationRecord.TaskState>().notNull().default("planned"),
    revision: integer().notNull().default(1),
    // Retirement must not implicitly release unresolved ownership.
    slot_claimed: integer({ mode: "boolean" }).notNull().default(false),
    workspace_mode: text().$type<LegacyDelegationRecord.WorkspaceMode>().notNull(),
    child_session_id: text()
      .$type<SessionSchema.ID>()
      .references(() => SessionTable.id),
    basis_id: text(),
    basis_digest: text(),
    cache_profile: text(),
    cache_status: text().$type<"unknown" | "accepted" | "low">(),
    cache_ratio: real(),
    result: text({ mode: "json" }).$type<LegacyDelegationRecord.Result>(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
    time_updated: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    uniqueIndex("session_orchestrator_task_request_idx").on(table.main_session_id, table.request_id),
    uniqueIndex("session_orchestrator_task_child_idx").on(table.child_session_id),
    index("session_orchestrator_task_main_state_idx").on(table.main_session_id, table.state),
  ],
)

export const SessionOrchestratorReservationTable = sqliteTable(
  "session_orchestrator_reservation",
  {
    directory: text().notNull(),
    resource: text().notNull(),
    task_id: text()
      .notNull()
      .references(() => SessionOrchestratorTaskTable.id, { onDelete: "cascade" }),
    revision: integer().notNull().default(1),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    primaryKey({ columns: [table.directory, table.resource] }),
    index("session_orchestrator_reservation_task_idx").on(table.task_id),
  ],
)
