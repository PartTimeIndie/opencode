import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261106145123_session_task_dispatch_binding",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`fork_dispatch_digest\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
