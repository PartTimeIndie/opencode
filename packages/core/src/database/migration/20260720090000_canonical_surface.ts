import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260720090000_canonical_surface",
  up(tx) {
    return Effect.gen(function* () {
      const table = yield* tx.get<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_question'`,
      )
      // A journal-drift install is repaired from schema.gen after migrations.
      if (!table) return
      const columns = new Set(
        (yield* tx.all<{ name: string }>(`PRAGMA table_info(\`session_question\`)`)).map((column) => column.name),
      )
      if (!columns.has("mode"))
        yield* tx.run(`ALTER TABLE \`session_question\` ADD \`mode\` text DEFAULT 'blocking' NOT NULL;`)
      if (!columns.has("revision"))
        yield* tx.run(`ALTER TABLE \`session_question\` ADD \`revision\` integer DEFAULT 1 NOT NULL;`)
      if (!columns.has("action_metadata"))
        yield* tx.run(`ALTER TABLE \`session_question\` ADD \`action_metadata\` text DEFAULT '[]' NOT NULL;`)
      yield* tx.run(
        `CREATE INDEX IF NOT EXISTS \`session_question_mode_state_idx\` ON \`session_question\` (\`mode\`,\`state\`);`,
      )
      yield* canonicalizeRequests(tx)
    })
  },
} satisfies DatabaseMigration.Migration

function canonicalizeRequests(tx: Parameters<DatabaseMigration.Migration["up"]>[0]) {
  return tx.run(`
    UPDATE \`session_question\`
    SET
      \`mode\` = CASE WHEN \`mode\` IN ('blocking', 'interactive', 'passive') THEN \`mode\` ELSE 'blocking' END,
      \`revision\` = CASE WHEN \`revision\` > 0 THEN \`revision\` ELSE 1 END,
      \`action_metadata\` = CASE WHEN json_valid(\`action_metadata\`) THEN \`action_metadata\` ELSE '[]' END,
      \`request\` = CASE
        WHEN json_valid(\`request\`) THEN json_set(
          \`request\`,
          '$.mode', CASE WHEN \`mode\` IN ('blocking', 'interactive', 'passive') THEN \`mode\` ELSE 'blocking' END,
          '$.revision', CASE WHEN \`revision\` > 0 THEN \`revision\` ELSE 1 END,
          '$.actions', json(CASE WHEN json_valid(\`action_metadata\`) THEN \`action_metadata\` ELSE '[]' END)
        )
        ELSE \`request\`
      END;
  `)
}
