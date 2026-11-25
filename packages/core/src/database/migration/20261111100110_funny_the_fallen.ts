import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261111100110_funny_the_fallen",
  up(tx) {
    return Effect.gen(function* () {
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
      yield* tx.run(`CREATE INDEX \`session_skill_selection_session_idx\` ON \`session_skill_selection\` (\`session_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_skill_selection_receipt_input_idx\` ON \`session_skill_selection\` (\`session_id\`,\`receipt_input_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
