import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260714022745_session_question",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_question\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`state\` text NOT NULL,
          \`request\` text NOT NULL,
          \`answers\` text,
          \`receipt\` text,
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
      yield* tx.run(`CREATE UNIQUE INDEX \`session_question_session_seq_idx\` ON \`session_question\` (\`session_id\`,\`seq\`);`)
      yield* tx.run(`CREATE INDEX \`session_question_pending_fifo_idx\` ON \`session_question\` (\`session_id\`,\`state\`,\`seq\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`session_question_active_idx\` ON \`session_question\` (\`session_id\`) WHERE "session_question"."state" = 'active' AND "session_question"."allow_concurrent" = 0;`)
      yield* tx.run(`CREATE UNIQUE INDEX \`session_question_tool_retry_idx\` ON \`session_question\` (\`session_id\`,\`assistant_message_id\`,\`tool_call_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_question_activity_idx\` ON \`session_question\` (\`activity_id\`,\`state\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
