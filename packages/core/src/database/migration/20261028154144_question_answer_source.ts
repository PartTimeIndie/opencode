import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261028154144_question_answer_source",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_question\` ADD \`answer_source\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
