import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260713230853_turn_completion_activity_marker",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_activity\` ADD \`turn_completion_state\` text;`)
      yield* tx.run(`ALTER TABLE \`session_activity\` ADD \`turn_completion_result\` text;`)
      yield* tx.run(`ALTER TABLE \`session_activity\` ADD \`turn_completion_owner_id\` text;`)
      yield* tx.run(`ALTER TABLE \`session_activity\` ADD \`turn_completion_lease_until\` integer;`)
      yield* tx.run(`ALTER TABLE \`session_activity\` ADD \`turn_completion_attempts\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session_activity\` ADD \`turn_completion_error\` text;`)
      yield* tx.run(`ALTER TABLE \`session_activity\` ADD \`turn_completion_completed_at\` integer;`)
      yield* tx.run(`
        UPDATE \`session_activity\`
        SET
          \`turn_completion_state\` = 'done',
          \`turn_completion_result\` = 'skipped',
          \`turn_completion_completed_at\` = COALESCE(\`turn_completion_completed_at\`, \`time_updated\`)
        WHERE \`status\` IN ('completed', 'failed', 'interrupted')
          AND \`turn_completion_state\` IS NULL
          AND \`turn_completion_result\` IS NULL;
      `)
      yield* tx.run(`CREATE INDEX \`session_activity_turn_completion_idx\` ON \`session_activity\` (\`turn_completion_state\`,\`turn_completion_lease_until\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
