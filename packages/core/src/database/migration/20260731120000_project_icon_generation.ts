import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260731120000_project_icon_generation",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`project\` ADD \`icon_generated_url\` text;`)
      yield* tx.run(`ALTER TABLE \`project\` ADD \`icon_generation_mode\` text;`)
      yield* tx.run(`ALTER TABLE \`project\` ADD \`icon_generation_status\` text;`)
      yield* tx.run(`ALTER TABLE \`project\` ADD \`icon_generation_error\` text;`)
      yield* tx.run(`ALTER TABLE \`project\` ADD \`icon_generation_attempt\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`project\` ADD \`icon_generation_attempted_at\` integer;`)
      yield* tx.run(`ALTER TABLE \`project\` ADD \`icon_generation_completed_at\` integer;`)
    })
  },
} satisfies DatabaseMigration.Migration
