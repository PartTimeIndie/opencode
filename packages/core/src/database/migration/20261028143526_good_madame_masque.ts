import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261028143526_good_madame_masque",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_input\` ADD \`origin\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
