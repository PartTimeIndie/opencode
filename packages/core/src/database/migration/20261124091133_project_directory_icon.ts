import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261124091133_project_directory_icon",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`project_directory_icon\` (
          \`directory\` text PRIMARY KEY,
          \`url\` text NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
