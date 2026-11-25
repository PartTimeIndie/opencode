import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261027072948_commission_repair_guard",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`PRAGMA foreign_keys=OFF;`)
      yield* tx.run(`
        CREATE TABLE \`__new_session_orchestrator_commission\` (
          \`id\` text PRIMARY KEY,
          \`main_session_id\` text NOT NULL,
          \`origin_input_id\` text NOT NULL,
          \`origin_digest\` text NOT NULL,
          \`scope\` text NOT NULL,
          \`source_assistant_id\` text NOT NULL,
          \`source_call_id\` text NOT NULL,
          \`agent\` text NOT NULL,
          \`model\` text NOT NULL,
          \`policy_digest\` text NOT NULL,
          \`settings\` text NOT NULL,
          \`cache_family\` text NOT NULL,
          \`revoked\` integer DEFAULT true NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_orchestrator_commission_main_session_id_session_orchestrator_main_session_id_fk\` FOREIGN KEY (\`main_session_id\`) REFERENCES \`session_orchestrator\`(\`main_session_id\`),
          CONSTRAINT \`fk_session_orchestrator_commission_origin_input_id_session_input_id_fk\` FOREIGN KEY (\`origin_input_id\`) REFERENCES \`session_input\`(\`id\`)
        );
      `)
      yield* tx.run(`INSERT INTO \`__new_session_orchestrator_commission\`(\`id\`, \`main_session_id\`, \`origin_input_id\`, \`origin_digest\`, \`scope\`, \`source_assistant_id\`, \`source_call_id\`, \`agent\`, \`model\`, \`policy_digest\`, \`settings\`, \`cache_family\`, \`revoked\`, \`time_created\`) SELECT \`id\`, \`main_session_id\`, \`origin_input_id\`, \`origin_digest\`, \`scope\`, \`source_assistant_id\`, \`source_call_id\`, \`agent\`, \`model\`, \`policy_digest\`, \`settings\`, \`cache_family\`, \`revoked\`, \`time_created\` FROM \`session_orchestrator_commission\`;`)
      yield* tx.run(`DROP TABLE \`session_orchestrator_commission\`;`)
      yield* tx.run(`ALTER TABLE \`__new_session_orchestrator_commission\` RENAME TO \`session_orchestrator_commission\`;`)
      yield* tx.run(`PRAGMA foreign_keys=ON;`)
      yield* tx.run(`CREATE UNIQUE INDEX \`session_orchestrator_commission_origin_idx\` ON \`session_orchestrator_commission\` (\`main_session_id\`,\`origin_input_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`session_orchestrator_commission_family_idx\` ON \`session_orchestrator_commission\` (\`cache_family\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
