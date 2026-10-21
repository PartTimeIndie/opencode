import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260713104000_content_store",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`content_blob\` (
          \`sha256\` text PRIMARY KEY,
          \`size_bytes\` integer NOT NULL,
          \`mime\` text NOT NULL,
          \`storage_path\` text NOT NULL,
          \`created_at\` integer NOT NULL
        );
      `)
      yield* tx.run(`ALTER TABLE \`attachment\` ADD \`blob_sha256\` text;`)
      yield* tx.run(`CREATE INDEX \`attachment_session_idx\` ON \`attachment\` (\`session_id\`);`)
      yield* tx.run(`CREATE INDEX \`attachment_message_idx\` ON \`attachment\` (\`message_id\`);`)
      yield* tx.run(`CREATE INDEX \`attachment_blob_idx\` ON \`attachment\` (\`blob_sha256\`);`)
      yield* tx.run(`CREATE INDEX \`content_blob_created_idx\` ON \`content_blob\` (\`created_at\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
