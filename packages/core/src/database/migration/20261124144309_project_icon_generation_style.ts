import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261124144309_project_icon_generation_style",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`project\` ADD \`icon_generation_style\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
