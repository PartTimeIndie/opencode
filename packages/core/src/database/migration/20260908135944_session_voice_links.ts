import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260908135944_session_voice_links",
  up(tx) {
    return Effect.gen(function* () {
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
      yield* tx.run(`CREATE UNIQUE INDEX \`session_voice_dispatch_origin_idx\` ON \`session_voice_dispatch\` (\`voice_session_id\`,\`source_message_id\`,\`source_call_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`session_voice_dispatch_result_idx\` ON \`session_voice_dispatch\` (\`result_input_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`session_voice_link_active_worker_idx\` ON \`session_voice_link\` (\`worker_session_id\`) WHERE "session_voice_link"."time_ended" IS NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
