import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260726212005_session_agent_policy",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`agent_policy\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
