import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261020082748_orchestrator_checkout",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_orchestrator\` ADD \`checkout_id\` text DEFAULT '' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session_orchestrator_task\` ADD \`checkout_id\` text DEFAULT '' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session_orchestrator_task\` ADD \`min_cache_read_ratio\` real DEFAULT 0.8 NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
