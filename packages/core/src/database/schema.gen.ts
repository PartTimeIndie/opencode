import { Effect } from "effect"
import type { DatabaseMigration } from "./migration"

export default {
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_archive_catalog\` (
          \`session_id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`title\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`session_data\` text,
          \`location\` text NOT NULL,
          \`shard_id\` text,
          \`revision\` integer DEFAULT 0 NOT NULL,
          \`content_hash\` text,
          \`message_count\` integer DEFAULT 0 NOT NULL,
          \`input_count\` integer DEFAULT 0 NOT NULL,
          \`logical_bytes\` integer DEFAULT 0 NOT NULL,
          \`time_last_modified\` integer NOT NULL,
          \`time_archived\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_archive_catalog_shard_id_session_archive_shard_id_fk\` FOREIGN KEY (\`shard_id\`) REFERENCES \`session_archive_shard\`(\`id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_archive_journal\` (
          \`id\` text PRIMARY KEY,
          \`operation_key\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`operation\` text NOT NULL,
          \`state\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`shard_id\` text,
          \`content_hash\` text,
          \`message_count\` integer,
          \`input_count\` integer,
          \`error\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_completed\` integer,
          CONSTRAINT \`fk_session_archive_journal_shard_id_session_archive_shard_id_fk\` FOREIGN KEY (\`shard_id\`) REFERENCES \`session_archive_shard\`(\`id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_archive_shard\` (
          \`id\` text PRIMARY KEY,
          \`path\` text NOT NULL,
          \`state\` text NOT NULL,
          \`size_bytes\` integer DEFAULT 0 NOT NULL,
          \`max_bytes\` integer NOT NULL,
          \`session_count\` integer DEFAULT 0 NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_sealed\` integer
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`attachment\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`message_id\` text,
          \`mime\` text NOT NULL,
          \`filename\` text,
          \`size_bytes\` integer,
          \`source_path\` text,
          \`storage_path\` text NOT NULL,
          \`blob_sha256\` text,
          \`created_at\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`content_blob\` (
          \`sha256\` text PRIMARY KEY,
          \`size_bytes\` integer NOT NULL,
          \`mime\` text NOT NULL,
          \`storage_path\` text NOT NULL,
          \`created_at\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`automation_run\` (
          \`id\` text PRIMARY KEY,
          \`automation_id\` text NOT NULL,
          \`status\` text NOT NULL,
          \`exit_code\` integer,
          \`output\` text,
          \`duration_ms\` integer,
          \`started_at\` integer NOT NULL,
          \`finished_at\` integer,
          \`next_retry_at\` integer
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`automation\` (
          \`id\` text PRIMARY KEY,
          \`name\` text NOT NULL,
          \`enabled\` integer DEFAULT 1 NOT NULL,
          \`trigger\` text NOT NULL,
          \`action\` text NOT NULL,
          \`last_run_at\` integer,
          \`next_run_at\` integer,
          \`created_at\` integer NOT NULL,
          \`updated_at\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`background_job\` (
          \`id\` text PRIMARY KEY,
          \`type\` text NOT NULL,
          \`status\` text NOT NULL,
          \`parent_session_id\` text,
          \`child_session_id\` text,
          \`parent_message_id\` text,
          \`parent_call_id\` text,
          \`title\` text,
          \`metadata\` text,
          \`owner_id\` text,
          \`lease_until\` integer,
          \`heartbeat_at\` integer,
          \`cleanup_token\` text,
          \`time_owner_settled\` integer,
          \`output\` text,
          \`error\` text,
          \`delivery_status\` text DEFAULT 'pending' NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_completed\` integer
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`workspace\` (
          \`id\` text PRIMARY KEY,
          \`type\` text NOT NULL,
          \`name\` text DEFAULT '' NOT NULL,
          \`branch\` text,
          \`directory\` text,
          \`extra\` text,
          \`project_id\` text NOT NULL,
          \`time_used\` integer NOT NULL,
          CONSTRAINT \`fk_workspace_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`data_migration\` (
          \`name\` text PRIMARY KEY,
          \`time_completed\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`file_knowledge_receipt\` (
          \`id\` integer PRIMARY KEY AUTOINCREMENT,
          \`session_id\` text NOT NULL,
          \`assistant_message_id\` text NOT NULL,
          \`message_seq\` integer NOT NULL,
          \`call_id\` text NOT NULL,
          \`target\` text NOT NULL,
          \`sha256\` text NOT NULL,
          \`coverage\` text NOT NULL,
          \`origin\` text NOT NULL,
          \`output_sha256\` text,
          \`source_receipt_id\` integer,
          CONSTRAINT \`fk_file_knowledge_receipt_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`file_mutation_pending\` (
          \`target\` text PRIMARY KEY,
          \`operation_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`receipt_id\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_protection\` (
          \`session_id\` text PRIMARY KEY,
          \`protected_at\` integer NOT NULL,
          \`updated_at\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`surface_action_invocation\` (
          \`id\` text PRIMARY KEY,
          \`target_kind\` text NOT NULL,
          \`target_id\` text NOT NULL,
          \`target_revision\` integer NOT NULL,
          \`action_id\` text NOT NULL,
          \`source\` text,
          \`payload_hash\` text NOT NULL,
          \`execution_key\` text,
          \`effect_started_at\` integer,
          \`error_class\` text,
          \`state\` text NOT NULL,
          \`result\` text,
          \`error\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`surface_tool\` (
          \`id\` text PRIMARY KEY,
          \`scope\` text NOT NULL,
          \`scope_key\` text NOT NULL,
          \`project_id\` text,
          \`directory\` text NOT NULL,
          \`origin_request_id\` text,
          \`origin_session_id\` text,
          \`origin_revision\` integer,
          \`mode\` text NOT NULL,
          \`definition_revision\` integer DEFAULT 1 NOT NULL,
          \`action_metadata\` text DEFAULT '[]' NOT NULL,
          \`surface\` text NOT NULL,
          \`state_version\` integer DEFAULT 1 NOT NULL,
          \`state_revision\` integer DEFAULT 1 NOT NULL,
          \`state_values\` text DEFAULT '{}' NOT NULL,
          \`hidden\` integer DEFAULT false NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_surface_tool_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`account_state\` (
          \`id\` integer PRIMARY KEY,
          \`active_account_id\` text,
          \`active_org_id\` text,
          CONSTRAINT \`fk_account_state_active_account_id_account_id_fk\` FOREIGN KEY (\`active_account_id\`) REFERENCES \`account\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`account\` (
          \`id\` text PRIMARY KEY,
          \`email\` text NOT NULL,
          \`url\` text NOT NULL,
          \`access_token\` text NOT NULL,
          \`refresh_token\` text NOT NULL,
          \`token_expiry\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`control_account\` (
          \`email\` text NOT NULL,
          \`url\` text NOT NULL,
          \`access_token\` text NOT NULL,
          \`refresh_token\` text NOT NULL,
          \`token_expiry\` integer,
          \`active\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`control_account_pk\` PRIMARY KEY(\`email\`, \`url\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`credential\` (
          \`id\` text PRIMARY KEY,
          \`integration_id\` text,
          \`label\` text NOT NULL,
          \`value\` text NOT NULL,
          \`connector_id\` text,
          \`method_id\` text,
          \`active\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`event_checkpoint\` (
          \`aggregate_id\` text PRIMARY KEY,
          \`seq\` integer NOT NULL,
          \`version\` integer NOT NULL,
          \`data\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_event_checkpoint_aggregate_id_event_sequence_aggregate_id_fk\` FOREIGN KEY (\`aggregate_id\`) REFERENCES \`event_sequence\`(\`aggregate_id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`event_sequence\` (
          \`aggregate_id\` text PRIMARY KEY,
          \`seq\` integer NOT NULL,
          \`owner_id\` text
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`event\` (
          \`id\` text PRIMARY KEY,
          \`aggregate_id\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`type\` text NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_event_aggregate_id_event_sequence_aggregate_id_fk\` FOREIGN KEY (\`aggregate_id\`) REFERENCES \`event_sequence\`(\`aggregate_id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`memory_embedding\` (
          \`memory_id\` text NOT NULL,
          \`model\` text NOT NULL,
          \`dimensions\` integer NOT NULL,
          \`vector\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_memory_embedding_memory_id_memory_id_fk\` FOREIGN KEY (\`memory_id\`) REFERENCES \`memory\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`memory\` (
          \`id\` text PRIMARY KEY,
          \`scope\` text NOT NULL,
          \`scope_key\` text NOT NULL,
          \`content\` text NOT NULL,
          \`source\` text NOT NULL,
          \`provenance\` text NOT NULL,
          \`state\` text DEFAULT 'pending' NOT NULL,
          \`reviewed_by\` text,
          \`time_reviewed\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`permission\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`action\` text NOT NULL,
          \`resource\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_permission_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`project_directory_icon\` (
          \`directory\` text PRIMARY KEY,
          \`url\` text NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`project_directory\` (
          \`project_id\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`type\` text,
          \`strategy\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`project_directory_pk\` PRIMARY KEY(\`project_id\`, \`directory\`),
          CONSTRAINT \`fk_project_directory_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`project\` (
          \`id\` text PRIMARY KEY,
          \`worktree\` text NOT NULL,
          \`vcs\` text,
          \`name\` text,
          \`icon_url\` text,
          \`icon_url_override\` text,
          \`icon_color\` text,
          \`icon_generated_url\` text,
          \`icon_generation_mode\` text,
          \`icon_generation_status\` text,
          \`icon_generation_error\` text,
          \`icon_generation_attempt\` integer DEFAULT 0 NOT NULL,
          \`icon_generation_attempted_at\` integer,
          \`icon_generation_completed_at\` integer,
          \`icon_generation_style\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_initialized\` integer,
          \`sandboxes\` text NOT NULL,
          \`commands\` text
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_question\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`state\` text NOT NULL,
          \`request\` text NOT NULL,
          \`mode\` text DEFAULT 'blocking' NOT NULL,
          \`revision\` integer DEFAULT 1 NOT NULL,
          \`action_metadata\` text DEFAULT '[]' NOT NULL,
          \`answers\` text,
          \`receipt\` text,
          \`answer_source\` text,
          \`detached\` integer DEFAULT false NOT NULL,
          \`allow_concurrent\` integer DEFAULT false NOT NULL,
          \`activity_id\` text,
          \`assistant_message_id\` text,
          \`tool_call_id\` text,
          \`time_settled\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_question_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_orchestrator_commission\` (
          \`id\` text PRIMARY KEY,
          \`main_session_id\` text NOT NULL,
          \`origin_input_id\` text NOT NULL,
          \`origin_digest\` text NOT NULL,
          \`scope\` text NOT NULL,
          \`source_assistant_id\` text NOT NULL,
          \`source_call_id\` text NOT NULL,
          \`agent\` text NOT NULL,
          \`model\` text NOT NULL,
          \`policy_digest\` text NOT NULL,
          \`settings\` text NOT NULL,
          \`cache_family\` text NOT NULL,
          \`revoked\` integer DEFAULT true NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_orchestrator_commission_main_session_id_session_orchestrator_main_session_id_fk\` FOREIGN KEY (\`main_session_id\`) REFERENCES \`session_orchestrator\`(\`main_session_id\`),
          CONSTRAINT \`fk_session_orchestrator_commission_origin_input_id_session_input_id_fk\` FOREIGN KEY (\`origin_input_id\`) REFERENCES \`session_input\`(\`id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_orchestrator_reservation\` (
          \`directory\` text NOT NULL,
          \`resource\` text NOT NULL,
          \`task_id\` text NOT NULL,
          \`revision\` integer DEFAULT 1 NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`session_orchestrator_reservation_pk\` PRIMARY KEY(\`directory\`, \`resource\`),
          CONSTRAINT \`fk_session_orchestrator_reservation_task_id_session_orchestrator_task_id_fk\` FOREIGN KEY (\`task_id\`) REFERENCES \`session_orchestrator_task\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_orchestrator\` (
          \`main_session_id\` text PRIMARY KEY,
          \`revision\` integer DEFAULT 1 NOT NULL,
          \`checkout_id\` text DEFAULT '' NOT NULL,
          \`interaction\` integer DEFAULT true NOT NULL,
          \`workspace_mode\` text DEFAULT 'mirror' NOT NULL,
          \`max_workers\` integer DEFAULT 4 NOT NULL,
          \`min_cache_read_ratio\` real DEFAULT 0.8 NOT NULL,
          \`control\` text DEFAULT 'active' NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_orchestrator_main_session_id_session_id_fk\` FOREIGN KEY (\`main_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_orchestrator_task\` (
          \`id\` text PRIMARY KEY,
          \`main_session_id\` text NOT NULL,
          \`request_id\` text NOT NULL,
          \`checkout_id\` text DEFAULT '' NOT NULL,
          \`min_cache_read_ratio\` real DEFAULT 0.8 NOT NULL,
          \`origin_input_id\` text NOT NULL,
          \`origin_user_message_id\` text NOT NULL,
          \`goal\` text NOT NULL,
          \`acceptance\` text NOT NULL,
          \`resources\` text NOT NULL,
          \`dependencies\` text NOT NULL,
          \`state\` text DEFAULT 'planned' NOT NULL,
          \`revision\` integer DEFAULT 1 NOT NULL,
          \`slot_claimed\` integer DEFAULT false NOT NULL,
          \`workspace_mode\` text NOT NULL,
          \`child_session_id\` text,
          \`basis_id\` text,
          \`basis_digest\` text,
          \`cache_profile\` text,
          \`cache_status\` text,
          \`cache_ratio\` real,
          \`result\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_orchestrator_task_main_session_id_session_orchestrator_main_session_id_fk\` FOREIGN KEY (\`main_session_id\`) REFERENCES \`session_orchestrator\`(\`main_session_id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_orchestrator_task_origin_input_id_session_input_id_fk\` FOREIGN KEY (\`origin_input_id\`) REFERENCES \`session_input\`(\`id\`),
          CONSTRAINT \`fk_session_orchestrator_task_child_session_id_session_id_fk\` FOREIGN KEY (\`child_session_id\`) REFERENCES \`session\`(\`id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`message\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_message_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`part\` (
          \`id\` text PRIMARY KEY,
          \`message_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_part_message_id_message_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`message\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_activity\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`status\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`reason\` text,
          \`owner_id\` text,
          \`lease_until\` integer,
          \`heartbeat_at\` integer,
          \`recovery_attempts\` integer DEFAULT 0 NOT NULL,
          \`last_error\` text,
          \`opened_seq\` integer,
          \`closed_seq\` integer,
          \`turn_completion_state\` text,
          \`turn_completion_result\` text,
          \`turn_completion_owner_id\` text,
          \`turn_completion_lease_until\` integer,
          \`turn_completion_attempts\` integer DEFAULT 0 NOT NULL,
          \`turn_completion_error\` text,
          \`turn_completion_completed_at\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_activity_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_context_epoch\` (
          \`session_id\` text PRIMARY KEY,
          \`baseline\` text NOT NULL,
          \`agent\` text DEFAULT 'build' NOT NULL,
          \`snapshot\` text NOT NULL,
          \`baseline_seq\` integer NOT NULL,
          \`replacement_seq\` integer,
          \`revision\` integer DEFAULT 0 NOT NULL,
          CONSTRAINT \`fk_session_context_epoch_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_dispatch\` (
          \`target_input_id\` text PRIMARY KEY,
          \`plugin_id\` text NOT NULL,
          \`source_session_id\` text NOT NULL,
          \`target_session_id\` text NOT NULL,
          \`source_message_id\` text NOT NULL,
          \`source_call_id\` text NOT NULL,
          \`text\` text NOT NULL,
          \`delivery\` text NOT NULL,
          \`result_input_id\` text NOT NULL,
          \`result_text\` text,
          \`time_result_delivered\` integer,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_dispatch_plugin_id_source_session_id_session_link_plugin_id_source_session_id_fk\` FOREIGN KEY (\`plugin_id\`,\`source_session_id\`) REFERENCES \`session_link\`(\`plugin_id\`,\`source_session_id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_file_blob\` (
          \`sha256\` text PRIMARY KEY,
          \`bytes\` integer NOT NULL,
          \`content\` blob NOT NULL,
          \`time_created\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_file_mutation\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`assistant_message_id\` text NOT NULL,
          \`call_id\` text NOT NULL,
          \`target\` text NOT NULL,
          \`resource\` text NOT NULL,
          \`before_exists\` integer NOT NULL,
          \`before_bytes\` integer,
          \`before_sha256\` text,
          \`before_mode\` integer,
          \`after_exists\` integer NOT NULL,
          \`after_bytes\` integer,
          \`after_sha256\` text,
          \`after_mode\` integer,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_file_mutation_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_input\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`prompt\` text NOT NULL,
          \`execution_prompt\` text,
          \`delivery\` text NOT NULL,
          \`origin\` text,
          \`admitted_seq\` integer NOT NULL,
          \`promoted_seq\` integer,
          \`held_at\` integer,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_input_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_link\` (
          \`plugin_id\` text NOT NULL,
          \`source_session_id\` text NOT NULL,
          \`target_session_id\` text NOT NULL,
          \`permission_policy\` text DEFAULT 'single-use' NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_ended\` integer,
          CONSTRAINT \`session_link_pk\` PRIMARY KEY(\`plugin_id\`, \`source_session_id\`),
          CONSTRAINT \`fk_session_link_source_session_id_session_id_fk\` FOREIGN KEY (\`source_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_link_target_session_id_session_id_fk\` FOREIGN KEY (\`target_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_message\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`type\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_session_message_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_skill_selection_barrier\` (
          \`session_id\` text PRIMARY KEY,
          \`forgotten_seq\` integer NOT NULL,
          \`operation_id\` text,
          \`operation_name\` text,
          \`operation_payload\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_skill_selection_barrier_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_skill_selection\` (
          \`session_id\` text NOT NULL,
          \`name\` text NOT NULL,
          \`generation\` integer NOT NULL,
          \`origin_kind\` text NOT NULL,
          \`origin_id\` text NOT NULL,
          \`origin_seq\` integer NOT NULL,
          \`selected_at\` integer NOT NULL,
          \`limit_minutes\` integer NOT NULL,
          \`limit_messages\` integer NOT NULL,
          \`forgotten_at\` integer,
          \`forgotten_seq\` integer,
          \`operation_id\` text,
          \`renewal_declined_at\` integer,
          \`renewal_declined_generation\` integer,
          \`bound_message_id\` text,
          \`receipt_input_id\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`session_skill_selection_pk\` PRIMARY KEY(\`session_id\`, \`name\`),
          CONSTRAINT \`fk_session_skill_selection_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`workspace_id\` text,
          \`parent_id\` text,
          \`fork_history_seq\` integer,
          \`fork_dispatch_digest\` text,
          \`slug\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`path\` text,
          \`title\` text NOT NULL,
          \`version\` text NOT NULL,
          \`share_url\` text,
          \`summary_additions\` integer,
          \`summary_deletions\` integer,
          \`summary_files\` integer,
          \`summary_diffs\` text,
          \`metadata\` text,
          \`cost\` real DEFAULT 0 NOT NULL,
          \`tokens_input\` integer DEFAULT 0 NOT NULL,
          \`tokens_output\` integer DEFAULT 0 NOT NULL,
          \`tokens_reasoning\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_read\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_write\` integer DEFAULT 0 NOT NULL,
          \`generation_ms\` integer DEFAULT 0 NOT NULL,
          \`revert\` text,
          \`permission\` text,
          \`agent_policy\` text,
          \`agent\` text,
          \`model\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_compacting\` integer,
          \`time_archived\` integer,
          CONSTRAINT \`fk_session_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_voice_dispatch\` (
          \`worker_input_id\` text PRIMARY KEY,
          \`voice_session_id\` text NOT NULL,
          \`source_message_id\` text NOT NULL,
          \`source_call_id\` text NOT NULL,
          \`text\` text NOT NULL,
          \`delivery\` text NOT NULL,
          \`result_input_id\` text NOT NULL,
          \`result_text\` text,
          \`time_result_delivered\` integer,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_voice_dispatch_voice_session_id_session_voice_link_voice_session_id_fk\` FOREIGN KEY (\`voice_session_id\`) REFERENCES \`session_voice_link\`(\`voice_session_id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_voice_link\` (
          \`voice_session_id\` text PRIMARY KEY,
          \`worker_session_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_ended\` integer,
          CONSTRAINT \`fk_session_voice_link_voice_session_id_session_id_fk\` FOREIGN KEY (\`voice_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_voice_link_worker_session_id_session_id_fk\` FOREIGN KEY (\`worker_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`todo\` (
          \`session_id\` text NOT NULL,
          \`content\` text NOT NULL,
          \`status\` text NOT NULL,
          \`priority\` text NOT NULL,
          \`position\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`todo_pk\` PRIMARY KEY(\`session_id\`, \`position\`),
          CONSTRAINT \`fk_todo_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_share\` (
          \`session_id\` text PRIMARY KEY,
          \`id\` text NOT NULL,
          \`secret\` text NOT NULL,
          \`url\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_share_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`session_archive_catalog_location_time_idx\` ON \`session_archive_catalog\` (\`location\`,\`time_last_modified\`);`)
      yield* tx.run(`CREATE INDEX \`session_archive_catalog_project_idx\` ON \`session_archive_catalog\` (\`project_id\`,\`time_last_modified\`);`)
      yield* tx.run(`CREATE INDEX \`session_archive_catalog_shard_idx\` ON \`session_archive_catalog\` (\`shard_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`session_archive_journal_operation_idx\` ON \`session_archive_journal\` (\`operation_key\`);`)
      yield* tx.run(`CREATE INDEX \`session_archive_journal_state_idx\` ON \`session_archive_journal\` (\`state\`,\`time_updated\`);`)
      yield* tx.run(`CREATE INDEX \`session_archive_journal_session_idx\` ON \`session_archive_journal\` (\`session_id\`,\`revision\`);`)
      yield* tx.run(`CREATE INDEX \`session_archive_shard_state_idx\` ON \`session_archive_shard\` (\`state\`,\`time_created\`);`)
      yield* tx.run(`CREATE INDEX \`attachment_session_idx\` ON \`attachment\` (\`session_id\`);`)
      yield* tx.run(`CREATE INDEX \`attachment_message_idx\` ON \`attachment\` (\`message_id\`);`)
      yield* tx.run(`CREATE INDEX \`attachment_blob_idx\` ON \`attachment\` (\`blob_sha256\`);`)
      yield* tx.run(`CREATE INDEX \`content_blob_created_idx\` ON \`content_blob\` (\`created_at\`);`)
      yield* tx.run(`CREATE INDEX \`background_job_status_lease_idx\` ON \`background_job\` (\`status\`,\`lease_until\`);`)
      yield* tx.run(`CREATE INDEX \`background_job_parent_session_idx\` ON \`background_job\` (\`parent_session_id\`);`)
      yield* tx.run(`CREATE INDEX \`background_job_child_session_idx\` ON \`background_job\` (\`child_session_id\`);`)
      yield* tx.run(`CREATE INDEX \`file_knowledge_session_target_idx\` ON \`file_knowledge_receipt\` (\`session_id\`,\`target\`,\`origin\`,\`id\`);`)
      yield* tx.run(`CREATE INDEX \`file_knowledge_message_idx\` ON \`file_knowledge_receipt\` (\`session_id\`,\`assistant_message_id\`);`)
      yield* tx.run(`CREATE INDEX \`file_knowledge_call_idx\` ON \`file_knowledge_receipt\` (\`session_id\`,\`call_id\`,\`origin\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`file_knowledge_source_idx\` ON \`file_knowledge_receipt\` (\`source_receipt_id\`);`)
      yield* tx.run(`CREATE INDEX \`surface_action_invocation_target_idx\` ON \`surface_action_invocation\` (\`target_kind\`,\`target_id\`,\`target_revision\`,\`action_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`surface_action_execution_key_idx\` ON \`surface_action_invocation\` (\`execution_key\`) WHERE "surface_action_invocation"."execution_key" IS NOT NULL;`)
      yield* tx.run(`CREATE UNIQUE INDEX \`surface_tool_origin_scope_idx\` ON \`surface_tool\` (\`origin_request_id\`,\`scope_key\`);`)
      yield* tx.run(`CREATE INDEX \`surface_tool_scope_idx\` ON \`surface_tool\` (\`scope\`,\`scope_key\`,\`hidden\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`event_aggregate_seq_idx\` ON \`event\` (\`aggregate_id\`,\`seq\`);`)
      yield* tx.run(`CREATE INDEX \`event_aggregate_type_seq_idx\` ON \`event\` (\`aggregate_id\`,\`type\`,\`seq\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`memory_embedding_memory_model_idx\` ON \`memory_embedding\` (\`memory_id\`,\`model\`);`)
      yield* tx.run(`CREATE INDEX \`memory_embedding_model_idx\` ON \`memory_embedding\` (\`model\`);`)
      yield* tx.run(`CREATE INDEX \`memory_scope_state_time_idx\` ON \`memory\` (\`scope\`,\`scope_key\`,\`state\`,\`time_updated\`);`)
      yield* tx.run(`CREATE INDEX \`memory_state_time_idx\` ON \`memory\` (\`state\`,\`time_updated\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`permission_project_action_resource_idx\` ON \`permission\` (\`project_id\`,\`action\`,\`resource\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`session_question_session_seq_idx\` ON \`session_question\` (\`session_id\`,\`seq\`);`)
      yield* tx.run(`CREATE INDEX \`session_question_pending_fifo_idx\` ON \`session_question\` (\`session_id\`,\`state\`,\`seq\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`session_question_active_idx\` ON \`session_question\` (\`session_id\`) WHERE "session_question"."state" = 'active' AND "session_question"."allow_concurrent" = 0;`)
      yield* tx.run(`CREATE UNIQUE INDEX \`session_question_tool_retry_idx\` ON \`session_question\` (\`session_id\`,\`assistant_message_id\`,\`tool_call_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_question_activity_idx\` ON \`session_question\` (\`activity_id\`,\`state\`);`)
      yield* tx.run(`CREATE INDEX \`session_question_mode_state_idx\` ON \`session_question\` (\`mode\`,\`state\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`session_orchestrator_commission_origin_idx\` ON \`session_orchestrator_commission\` (\`main_session_id\`,\`origin_input_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`session_orchestrator_commission_family_idx\` ON \`session_orchestrator_commission\` (\`cache_family\`);`)
      yield* tx.run(`CREATE INDEX \`session_orchestrator_reservation_task_idx\` ON \`session_orchestrator_reservation\` (\`task_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`session_orchestrator_task_request_idx\` ON \`session_orchestrator_task\` (\`main_session_id\`,\`request_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`session_orchestrator_task_child_idx\` ON \`session_orchestrator_task\` (\`child_session_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_orchestrator_task_main_state_idx\` ON \`session_orchestrator_task\` (\`main_session_id\`,\`state\`);`)
      yield* tx.run(`CREATE INDEX \`message_session_time_created_id_idx\` ON \`message\` (\`session_id\`,\`time_created\`,\`id\`);`)
      yield* tx.run(`CREATE INDEX \`part_message_id_id_idx\` ON \`part\` (\`message_id\`,\`id\`);`)
      yield* tx.run(`CREATE INDEX \`part_session_idx\` ON \`part\` (\`session_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_activity_session_idx\` ON \`session_activity\` (\`session_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_activity_status_lease_idx\` ON \`session_activity\` (\`status\`,\`lease_until\`);`)
      yield* tx.run(`CREATE INDEX \`session_activity_turn_completion_idx\` ON \`session_activity\` (\`turn_completion_state\`,\`turn_completion_lease_until\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`session_dispatch_origin_idx\` ON \`session_dispatch\` (\`plugin_id\`,\`source_session_id\`,\`source_message_id\`,\`source_call_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`session_dispatch_result_idx\` ON \`session_dispatch\` (\`result_input_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_file_mutation_session_idx\` ON \`session_file_mutation\` (\`session_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_file_mutation_assistant_idx\` ON \`session_file_mutation\` (\`session_id\`,\`assistant_message_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_file_mutation_target_idx\` ON \`session_file_mutation\` (\`session_id\`,\`target\`);`)
      yield* tx.run(`CREATE INDEX \`session_input_session_pending_delivery_seq_idx\` ON \`session_input\` (\`session_id\`,\`promoted_seq\`,\`delivery\`,\`admitted_seq\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`session_input_session_admitted_seq_idx\` ON \`session_input\` (\`session_id\`,\`admitted_seq\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`session_input_session_promoted_seq_idx\` ON \`session_input\` (\`session_id\`,\`promoted_seq\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`session_link_active_target_idx\` ON \`session_link\` (\`plugin_id\`,\`target_session_id\`) WHERE "session_link"."time_ended" IS NULL;`)
      yield* tx.run(`CREATE UNIQUE INDEX \`session_message_session_seq_idx\` ON \`session_message\` (\`session_id\`,\`seq\`);`)
      yield* tx.run(`CREATE INDEX \`session_message_session_type_seq_idx\` ON \`session_message\` (\`session_id\`,\`type\`,\`seq\`);`)
      yield* tx.run(`CREATE INDEX \`session_message_session_time_created_id_idx\` ON \`session_message\` (\`session_id\`,\`time_created\`,\`id\`);`)
      yield* tx.run(`CREATE INDEX \`session_message_time_created_idx\` ON \`session_message\` (\`time_created\`);`)
      yield* tx.run(`CREATE INDEX \`session_skill_selection_session_idx\` ON \`session_skill_selection\` (\`session_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_skill_selection_receipt_input_idx\` ON \`session_skill_selection\` (\`session_id\`,\`receipt_input_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_project_idx\` ON \`session\` (\`project_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_workspace_idx\` ON \`session\` (\`workspace_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_parent_idx\` ON \`session\` (\`parent_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`session_voice_dispatch_origin_idx\` ON \`session_voice_dispatch\` (\`voice_session_id\`,\`source_message_id\`,\`source_call_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`session_voice_dispatch_result_idx\` ON \`session_voice_dispatch\` (\`result_input_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`session_voice_link_active_worker_idx\` ON \`session_voice_link\` (\`worker_session_id\`) WHERE "session_voice_link"."time_ended" IS NULL;`)
      yield* tx.run(`CREATE INDEX \`todo_session_idx\` ON \`todo\` (\`session_id\`);`)
    })
  },
} satisfies Omit<DatabaseMigration.Migration, "id">
