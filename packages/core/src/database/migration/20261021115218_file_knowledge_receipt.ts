import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261021115218_file_knowledge_receipt",
  up(tx) {
    return Effect.gen(function* () {
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
      yield* tx.run(`CREATE INDEX \`file_knowledge_session_target_idx\` ON \`file_knowledge_receipt\` (\`session_id\`,\`target\`,\`origin\`,\`id\`);`)
      yield* tx.run(`CREATE INDEX \`file_knowledge_message_idx\` ON \`file_knowledge_receipt\` (\`session_id\`,\`assistant_message_id\`);`)
      yield* tx.run(`CREATE INDEX \`file_knowledge_call_idx\` ON \`file_knowledge_receipt\` (\`session_id\`,\`call_id\`,\`origin\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
