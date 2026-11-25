import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261106173347_session_file_mutation_modes",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_file_mutation\` ADD \`before_mode\` integer;`)
      yield* tx.run(`ALTER TABLE \`session_file_mutation\` ADD \`after_mode\` integer;`)
    })
  },
} satisfies DatabaseMigration.Migration
