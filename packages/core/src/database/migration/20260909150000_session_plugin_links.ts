import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"
import { migrateLegacySessionLinks, sessionLinksSchema } from "../session-links-migration"

export default {
  id: "20260909150000_session_plugin_links",
  up(tx) {
    return Effect.gen(function* () {
      yield* sessionLinksSchema.up(tx)
      yield* migrateLegacySessionLinks(tx)
    })
  },
} satisfies DatabaseMigration.Migration
