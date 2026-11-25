import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261028152954_orchestrator_task_result",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_orchestrator_task\` ADD \`result\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
