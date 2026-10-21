import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261020074615_session_orchestrator",
  up(tx) {
    return Effect.gen(function* () {
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
          \`cache_profile\` text,
          \`cache_status\` text,
          \`cache_ratio\` real,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_orchestrator_task_main_session_id_session_orchestrator_main_session_id_fk\` FOREIGN KEY (\`main_session_id\`) REFERENCES \`session_orchestrator\`(\`main_session_id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_orchestrator_task_origin_input_id_session_input_id_fk\` FOREIGN KEY (\`origin_input_id\`) REFERENCES \`session_input\`(\`id\`),
          CONSTRAINT \`fk_session_orchestrator_task_child_session_id_session_id_fk\` FOREIGN KEY (\`child_session_id\`) REFERENCES \`session\`(\`id\`)
        );
      `)
      yield* tx.run(`CREATE INDEX \`session_orchestrator_reservation_task_idx\` ON \`session_orchestrator_reservation\` (\`task_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`session_orchestrator_task_request_idx\` ON \`session_orchestrator_task\` (\`main_session_id\`,\`request_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`session_orchestrator_task_child_idx\` ON \`session_orchestrator_task\` (\`child_session_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_orchestrator_task_main_state_idx\` ON \`session_orchestrator_task\` (\`main_session_id\`,\`state\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
