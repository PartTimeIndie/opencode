import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260923075435_surface_action_execution_lock",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`surface_action_invocation\` ADD \`execution_key\` text;`)
      yield* tx.run(`ALTER TABLE \`surface_action_invocation\` ADD \`effect_started_at\` integer;`)
      yield* tx.run(`ALTER TABLE \`surface_action_invocation\` ADD \`error_class\` text;`)
      yield* tx.run(`CREATE UNIQUE INDEX \`surface_action_execution_key_idx\` ON \`surface_action_invocation\` (\`execution_key\`) WHERE "surface_action_invocation"."execution_key" IS NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
