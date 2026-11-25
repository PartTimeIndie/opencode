import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261028122425_orchestrator_basis_digest",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_orchestrator_task\` ADD \`basis_digest\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
