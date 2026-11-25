import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261028121736_background_job_owner_settlement",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`background_job\` ADD \`cleanup_token\` text;`)
      yield* tx.run(`ALTER TABLE \`background_job\` ADD \`time_owner_settled\` integer;`)
    })
  },
} satisfies DatabaseMigration.Migration
