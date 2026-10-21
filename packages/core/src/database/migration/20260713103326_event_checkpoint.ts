import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260713103326_event_checkpoint",
  up(tx) {
    return Effect.gen(function* () {
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
    })
  },
} satisfies DatabaseMigration.Migration
