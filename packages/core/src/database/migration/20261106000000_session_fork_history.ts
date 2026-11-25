import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261106000000_session_fork_history",
  up: (tx) => Effect.gen(function* () {
    yield* tx.run("ALTER TABLE `session` ADD `fork_history_seq` integer;")
  }),
} satisfies DatabaseMigration.Migration
