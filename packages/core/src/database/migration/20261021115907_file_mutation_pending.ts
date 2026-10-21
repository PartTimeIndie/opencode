import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261021115907_file_mutation_pending",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`file_mutation_pending\` (
          \`target\` text PRIMARY KEY,
          \`operation_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`receipt_id\` integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`file_knowledge_source_idx\` ON \`file_knowledge_receipt\` (\`source_receipt_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
