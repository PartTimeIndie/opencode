import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260622135843_add_session_activity_and_background_job",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_activity\` (
          \`id\` text PRIMARY KEY NOT NULL,
          \`session_id\` text NOT NULL,
          \`status\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`reason\` text,
          \`owner_id\` text,
          \`lease_until\` integer,
          \`heartbeat_at\` integer,
          \`recovery_attempts\` integer NOT NULL DEFAULT 0,
          \`last_error\` text,
          \`opened_seq\` integer,
          \`closed_seq\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`session_activity_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`session_activity_session_idx\` ON \`session_activity\` (\`session_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_activity_status_lease_idx\` ON \`session_activity\` (\`status\`, \`lease_until\`);`,
      )
      yield* tx.run(`
        CREATE TABLE \`background_job\` (
          \`id\` text PRIMARY KEY NOT NULL,
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
          \`output\` text,
          \`error\` text,
          \`delivery_status\` text NOT NULL DEFAULT 'pending',
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_completed\` integer
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`background_job_status_lease_idx\` ON \`background_job\` (\`status\`, \`lease_until\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`background_job_parent_session_idx\` ON \`background_job\` (\`parent_session_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`background_job_child_session_idx\` ON \`background_job\` (\`child_session_id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
