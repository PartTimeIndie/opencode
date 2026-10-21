import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260708070557_session_file_mutation",
  up(tx) {
    return Effect.gen(function* () {
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
          \`after_exists\` integer NOT NULL,
          \`after_bytes\` integer,
          \`after_sha256\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_file_mutation_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`session_file_mutation_session_idx\` ON \`session_file_mutation\` (\`session_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_file_mutation_assistant_idx\` ON \`session_file_mutation\` (\`session_id\`,\`assistant_message_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_file_mutation_target_idx\` ON \`session_file_mutation\` (\`session_id\`,\`target\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
