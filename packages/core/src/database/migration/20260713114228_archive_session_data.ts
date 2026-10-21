import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260713114228_archive_session_data",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_archive_catalog\` ADD \`session_data\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
