import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

const markerMigrationID = "20260713230853_turn_completion_activity_marker"
const requiredColumns = [
  "status",
  "time_updated",
  "turn_completion_state",
  "turn_completion_result",
  "turn_completion_completed_at",
]

export default {
  id: "20260714030000_migrate_historical_turn_completions",
  up(tx) {
    return Effect.gen(function* () {
      const columns = new Set(
        (yield* tx.all<{ name: string }>(`PRAGMA table_info(\`session_activity\`)`)).map((column) => column.name),
      )
      if (!requiredColumns.every((column) => columns.has(column))) return
      const marker = yield* tx.get<{ time_completed: number }>(
        `SELECT time_completed FROM \`migration\` WHERE id = '${markerMigrationID}'`,
      )
      if (!marker || !Number.isSafeInteger(marker.time_completed)) return
      yield* tx.run(`
        UPDATE \`session_activity\`
        SET
          \`turn_completion_state\` = 'done',
          \`turn_completion_result\` = 'skipped',
          \`turn_completion_completed_at\` = COALESCE(\`turn_completion_completed_at\`, \`time_updated\`)
        WHERE \`status\` IN ('completed', 'failed', 'interrupted')
          AND \`turn_completion_state\` IS NULL
          AND \`turn_completion_result\` IS NULL
          AND \`time_updated\` < ${marker.time_completed};
      `)
    })
  },
} satisfies DatabaseMigration.Migration
