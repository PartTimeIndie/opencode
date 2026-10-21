import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260914074423_session_protection",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_protection\` (
          \`session_id\` text PRIMARY KEY,
          \`protected_at\` integer NOT NULL,
          \`updated_at\` integer NOT NULL
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
