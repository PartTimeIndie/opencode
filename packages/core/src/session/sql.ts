import { sqliteTable, text, integer, index, primaryKey, real, uniqueIndex, blob, foreignKey } from "drizzle-orm/sqlite-core"
import * as DatabasePath from "../database/path"
import { ProjectTable } from "../project/sql"
import type { SessionMessage } from "./message"
import type { Prompt } from "./prompt"
import type { Snapshot } from "../snapshot"
import { PermissionV1 } from "../v1/permission"
import { ProjectV2 } from "../project"
import type { SessionSchema } from "./schema"
import type { MessageID, PartID, SessionV1 } from "../v1/session"
import { WorkspaceV2 } from "../workspace"
import { Timestamps } from "../database/schema.sql"
import type { SystemContext } from "../system-context/index"
import { AgentV2 } from "../agent"
import type { SessionAgentPolicy } from "./agent-policy"
import { sql } from "drizzle-orm"

type SessionMessageData = Omit<(typeof SessionMessage.Message)["Encoded"], "type" | "id">
type PromptData = typeof Prompt.Encoded
type V1MessageData = Omit<SessionV1.Info, "id" | "sessionID">
type V1PartData = Omit<SessionV1.Part, "id" | "sessionID" | "messageID">

export const SessionTable = sqliteTable(
  "session",
  {
    id: text().$type<SessionSchema.ID>().primaryKey(),
    project_id: text()
      .$type<ProjectV2.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    workspace_id: text().$type<WorkspaceV2.ID>(),
    parent_id: text().$type<SessionSchema.ID>(),
    fork_history_seq: integer(),
    fork_dispatch_digest: text(),
    slug: text().notNull(),
    directory: DatabasePath.directoryColumn().notNull(),
    path: DatabasePath.pathColumn(),
    title: text().notNull(),
    version: text().notNull(),
    share_url: text(),
    summary_additions: integer(),
    summary_deletions: integer(),
    summary_files: integer(),
    summary_diffs: text({ mode: "json" }).$type<Snapshot.FileDiff[]>(),
    metadata: text({ mode: "json" }).$type<Record<string, unknown>>(),
    cost: real().notNull().default(0),
    tokens_input: integer().notNull().default(0),
    tokens_output: integer().notNull().default(0),
    tokens_reasoning: integer().notNull().default(0),
    tokens_cache_read: integer().notNull().default(0),
    tokens_cache_write: integer().notNull().default(0),
    // Cumulative wall-clock time in which assistant token deltas streamed from
    // providers for this session's own messages. Maintained additively by the
    // projector alongside the token columns; see session_usage generationMs.
    generation_ms: integer().notNull().default(0),
    revert: text({ mode: "json" }).$type<SessionSchema.Revert>(),
    permission: text({ mode: "json" }).$type<PermissionV1.Ruleset>(),
    agent_policy: text({ mode: "json" }).$type<SessionAgentPolicy.Info>(),
    agent: text(),
    model: text({ mode: "json" }).$type<{
      id: string
      providerID: string
      variant?: string
      chain?: {
        id: string
        name: string
        active?: number
        steps: { id: string; providerID: string; variant?: string }[]
      } | null
    }>(),
    ...Timestamps,
    time_compacting: integer(),
    time_archived: integer(),
  },
  (table) => [
    index("session_project_idx").on(table.project_id),
    index("session_workspace_idx").on(table.workspace_id),
    index("session_parent_idx").on(table.parent_id),
  ],
)

export const SessionLinkTable = sqliteTable(
  "session_link",
  {
    plugin_id: text().notNull(),
    source_session_id: text().$type<SessionSchema.ID>().notNull().references(() => SessionTable.id, { onDelete: "cascade" }),
    target_session_id: text().$type<SessionSchema.ID>().notNull().references(() => SessionTable.id, { onDelete: "cascade" }),
    permission_policy: text().$type<"single-use" | "inherit">().notNull().default("single-use"),
    time_created: integer().notNull().$default(() => Date.now()),
    time_ended: integer(),
  },
  (table) => [
    primaryKey({ columns: [table.plugin_id, table.source_session_id] }),
    uniqueIndex("session_link_active_target_idx").on(table.plugin_id, table.target_session_id).where(sql`${table.time_ended} IS NULL`),
  ],
)

export const SessionDispatchTable = sqliteTable(
  "session_dispatch",
  {
    target_input_id: text().$type<SessionMessage.ID>().primaryKey(),
    plugin_id: text().notNull(),
    source_session_id: text().$type<SessionSchema.ID>().notNull(),
    target_session_id: text().$type<SessionSchema.ID>().notNull(),
    source_message_id: text().$type<SessionMessage.ID>().notNull(),
    source_call_id: text().notNull(),
    text: text().notNull(),
    delivery: text().$type<"steer" | "queue">().notNull(),
    result_input_id: text().$type<SessionMessage.ID>().notNull(),
    result_text: text(),
    time_result_delivered: integer(),
    time_created: integer().notNull().$default(() => Date.now()),
  },
  (table) => [
    foreignKey({ columns: [table.plugin_id, table.source_session_id], foreignColumns: [SessionLinkTable.plugin_id, SessionLinkTable.source_session_id] }).onDelete("cascade"),
    uniqueIndex("session_dispatch_origin_idx").on(table.plugin_id, table.source_session_id, table.source_message_id, table.source_call_id),
    uniqueIndex("session_dispatch_result_idx").on(table.result_input_id),
  ],
)

// Legacy tables are retained for migration and rollback only.
export const SessionVoiceLinkTable = sqliteTable(
  "session_voice_link",
  {
    voice_session_id: text()
      .$type<SessionSchema.ID>()
      .primaryKey()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    worker_session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
    time_ended: integer(),
  },
  (table) => [
    uniqueIndex("session_voice_link_active_worker_idx")
      .on(table.worker_session_id)
      .where(sql`${table.time_ended} IS NULL`),
  ],
)

export const SessionVoiceDispatchTable = sqliteTable(
  "session_voice_dispatch",
  {
    worker_input_id: text().$type<SessionMessage.ID>().primaryKey(),
    voice_session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionVoiceLinkTable.voice_session_id, { onDelete: "cascade" }),
    source_message_id: text().$type<SessionMessage.ID>().notNull(),
    source_call_id: text().notNull(),
    text: text().notNull(),
    delivery: text().$type<"steer" | "queue">().notNull(),
    result_input_id: text().$type<SessionMessage.ID>().notNull(),
    result_text: text(),
    time_result_delivered: integer(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    uniqueIndex("session_voice_dispatch_origin_idx").on(
      table.voice_session_id,
      table.source_message_id,
      table.source_call_id,
    ),
    uniqueIndex("session_voice_dispatch_result_idx").on(table.result_input_id),
  ],
)

export const MessageTable = sqliteTable(
  "message",
  {
    id: text().$type<MessageID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    ...Timestamps,
    data: text({ mode: "json" }).notNull().$type<V1MessageData>(),
  },
  (table) => [index("message_session_time_created_id_idx").on(table.session_id, table.time_created, table.id)],
)

export const PartTable = sqliteTable(
  "part",
  {
    id: text().$type<PartID>().primaryKey(),
    message_id: text()
      .$type<MessageID>()
      .notNull()
      .references(() => MessageTable.id, { onDelete: "cascade" }),
    session_id: text().$type<SessionSchema.ID>().notNull(),
    ...Timestamps,
    data: text({ mode: "json" }).notNull().$type<V1PartData>(),
  },
  (table) => [
    index("part_message_id_id_idx").on(table.message_id, table.id),
    index("part_session_idx").on(table.session_id),
  ],
)

export const TodoTable = sqliteTable(
  "todo",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    content: text().notNull(),
    status: text().notNull(),
    priority: text().notNull(),
    position: integer().notNull(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.position] }),
    index("todo_session_idx").on(table.session_id),
  ],
)

export const SessionMessageTable = sqliteTable(
  "session_message",
  {
    id: text().$type<SessionMessage.ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    type: text().$type<SessionMessage.Type>().notNull(),
    seq: integer().notNull(),
    ...Timestamps,
    data: text({ mode: "json" }).notNull().$type<SessionMessageData>(),
  },
  (table) => [
    uniqueIndex("session_message_session_seq_idx").on(table.session_id, table.seq),
    index("session_message_session_type_seq_idx").on(table.session_id, table.type, table.seq),
    index("session_message_session_time_created_id_idx").on(table.session_id, table.time_created, table.id),
    index("session_message_time_created_idx").on(table.time_created),
  ],
)

export const SessionInputTable = sqliteTable(
  "session_input",
  {
    id: text().$type<SessionMessage.ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    prompt: text({ mode: "json" }).notNull().$type<PromptData>(),
    execution_prompt: text({ mode: "json" }).$type<PromptData>(),
    delivery: text().$type<"steer" | "queue">().notNull(),
    origin: text().$type<"interactive" | "plugin">(),
    admitted_seq: integer().notNull(),
    promoted_seq: integer(),
    held_at: integer(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    index("session_input_session_pending_delivery_seq_idx").on(
      table.session_id,
      table.promoted_seq,
      table.delivery,
      table.admitted_seq,
    ),
    uniqueIndex("session_input_session_admitted_seq_idx").on(table.session_id, table.admitted_seq),
    uniqueIndex("session_input_session_promoted_seq_idx").on(table.session_id, table.promoted_seq),
  ],
)

export const SessionActivityTable = sqliteTable(
  "session_activity",
  {
    id: text().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    status: text().notNull(),
    kind: text().notNull(),
    reason: text(),
    owner_id: text(),
    lease_until: integer(),
    heartbeat_at: integer(),
    recovery_attempts: integer().notNull().default(0),
    last_error: text(),
    opened_seq: integer(),
    closed_seq: integer(),
    turn_completion_state: text().$type<"running" | "ready" | "done">(),
    turn_completion_result: text().$type<"done" | "incomplete" | "unknown" | "skipped">(),
    turn_completion_owner_id: text(),
    turn_completion_lease_until: integer(),
    turn_completion_attempts: integer().notNull().default(0),
    turn_completion_error: text(),
    turn_completion_completed_at: integer(),
    ...Timestamps,
  },
  (table) => [
    index("session_activity_session_idx").on(table.session_id),
    index("session_activity_status_lease_idx").on(table.status, table.lease_until),
    index("session_activity_turn_completion_idx").on(table.turn_completion_state, table.turn_completion_lease_until),
  ],
)

export const SessionContextEpochTable = sqliteTable("session_context_epoch", {
  session_id: text()
    .$type<SessionSchema.ID>()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  baseline: text().notNull(),
  agent: text().$type<AgentV2.ID>().notNull().default(AgentV2.defaultID),
  snapshot: text({ mode: "json" }).notNull().$type<SystemContext.Snapshot>(),
  baseline_seq: integer().notNull(),
  replacement_seq: integer(),
  revision: integer().notNull().default(0),
})

export const SessionFileBlobTable = sqliteTable("session_file_blob", {
  sha256: text().primaryKey(),
  bytes: integer().notNull(),
  content: blob({ mode: "buffer" }).notNull().$type<Buffer>(),
  time_created: integer()
    .notNull()
    .$default(() => Date.now()),
})

export const SessionFileMutationTable = sqliteTable(
  "session_file_mutation",
  {
    id: text().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    assistant_message_id: text().$type<SessionMessage.ID>().notNull(),
    call_id: text().notNull(),
    target: text().notNull(),
    resource: text().notNull(),
    before_exists: integer({ mode: "boolean" }).notNull(),
    before_bytes: integer(),
    before_sha256: text(),
    before_mode: integer(),
    after_exists: integer({ mode: "boolean" }).notNull(),
    after_bytes: integer(),
    after_sha256: text(),
    after_mode: integer(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    index("session_file_mutation_session_idx").on(table.session_id),
    index("session_file_mutation_assistant_idx").on(table.session_id, table.assistant_message_id),
    index("session_file_mutation_target_idx").on(table.session_id, table.target),
  ],
)

// One row per (Session, canonical skill name): the latest selection generation
// plus its tombstones. Selections are event-sourced; this projection is the
// read model the skill gate and the Settings overview consume.
export const SessionSkillSelectionTable = sqliteTable(
  "session_skill_selection",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    name: text().notNull(),
    generation: integer().notNull(),
    origin_kind: text().$type<SkillSelectionOriginKind>().notNull(),
    origin_id: text().notNull(),
    origin_seq: integer().notNull(),
    selected_at: integer().notNull(),
    limit_minutes: integer().notNull(),
    limit_messages: integer().notNull(),
    forgotten_at: integer(),
    // Durable adoption fence in the Session aggregate sequence space: lazy
    // backfill may never adopt an origin at or before this sequence.
    forgotten_seq: integer(),
    // Last named-forget operation observed for this selection; reconciliation
    // only (forget-all keeps its identity on the barrier row).
    operation_id: text(),
    renewal_declined_at: integer(),
    renewal_declined_generation: integer(),
    // Native receipts stay valid for the waiting call they were coordinated
    // with; input origins always need to precede the consuming tool call.
    bound_message_id: text().$type<SessionMessage.ID>(),
    // The chat message admitted together with a native receipt. It must never
    // create a second selection or a second counter booking later.
    receipt_input_id: text().$type<SessionMessage.ID>(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.name] }),
    index("session_skill_selection_session_idx").on(table.session_id),
    index("session_skill_selection_receipt_input_idx").on(table.session_id, table.receipt_input_id),
  ],
)

// Forget-all writes a durable fence so lazy backfill can never resurrect
// origins that predate the user's decision.
export const SessionSkillSelectionBarrierTable = sqliteTable(
  "session_skill_selection_barrier",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .primaryKey()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    forgotten_seq: integer().notNull(),
    operation_id: text(),
    operation_name: text(),
    operation_payload: text(),
    ...Timestamps,
  },
)

export type SkillSelectionOriginKind = "input" | "chat_send" | "command" | "renewal"
