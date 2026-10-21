import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261012153223_session_generation_ms",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`generation_ms\` integer DEFAULT 0 NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
