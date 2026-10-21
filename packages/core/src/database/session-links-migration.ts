import { Effect } from "effect"
import type { DatabaseMigration } from "./migration"

type Transaction = Parameters<DatabaseMigration.Migration["up"]>[0]

export const sessionLinksSchema = {
  up(tx: Transaction) {
    return Effect.gen(function* () {
      yield* tx.run(`CREATE TABLE \`session_link\` (
        \`plugin_id\` text NOT NULL,
        \`source_session_id\` text NOT NULL,
        \`target_session_id\` text NOT NULL,
        \`permission_policy\` text NOT NULL DEFAULT 'single-use',
        \`time_created\` integer NOT NULL,
        \`time_ended\` integer,
        PRIMARY KEY (\`plugin_id\`, \`source_session_id\`),
        FOREIGN KEY (\`source_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
        FOREIGN KEY (\`target_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
      );`)
      yield* tx.run(`CREATE TABLE \`session_dispatch\` (
        \`target_input_id\` text PRIMARY KEY,
        \`plugin_id\` text NOT NULL,
        \`source_session_id\` text NOT NULL,
        \`target_session_id\` text NOT NULL,
        \`source_message_id\` text NOT NULL,
        \`source_call_id\` text NOT NULL,
        \`text\` text NOT NULL,
        \`delivery\` text NOT NULL,
        \`result_input_id\` text NOT NULL,
        \`result_text\` text,
        \`time_result_delivered\` integer,
        \`time_created\` integer NOT NULL,
        FOREIGN KEY (\`plugin_id\`, \`source_session_id\`) REFERENCES \`session_link\`(\`plugin_id\`, \`source_session_id\`) ON DELETE CASCADE
      );`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_link_active_target_idx\` ON \`session_link\` (\`plugin_id\`,\`target_session_id\`) WHERE \`time_ended\` IS NULL;`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_dispatch_origin_idx\` ON \`session_dispatch\` (\`plugin_id\`,\`source_session_id\`,\`source_message_id\`,\`source_call_id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_dispatch_result_idx\` ON \`session_dispatch\` (\`result_input_id\`);`,
      )
    })
  },
}

// Copy only immutable historical rows. Existing generic rows always win, including
// ended links and delivered results, so repeating startup never reopens work.
export function migrateLegacySessionLinks(tx: Transaction) {
  return Effect.gen(function* () {
    if (!(yield* tx.get("SELECT name FROM sqlite_master WHERE type='table' AND name='session_voice_link'"))) return
    if (
      yield* tx.get(`SELECT 1 FROM session_voice_link v WHERE NOT EXISTS
      (SELECT 1 FROM session_link l WHERE l.plugin_id='voice-conversation-app' AND l.source_session_id=v.voice_session_id) LIMIT 1`)
    )
      yield* tx.run(`INSERT OR IGNORE INTO session_link
      (plugin_id,source_session_id,target_session_id,permission_policy,time_created,time_ended)
      SELECT 'voice-conversation-app',voice_session_id,worker_session_id,'single-use',time_created,time_ended FROM session_voice_link`)
    if (!(yield* tx.get("SELECT name FROM sqlite_master WHERE type='table' AND name='session_voice_dispatch'"))) return
    if (
      !(yield* tx.get(`SELECT 1 FROM session_voice_dispatch v WHERE NOT EXISTS
      (SELECT 1 FROM session_dispatch d WHERE d.target_input_id=v.worker_input_id) LIMIT 1`))
    )
      return
    const columns = new Set(
      (yield* tx.all<{ name: string }>("PRAGMA table_info(session_voice_dispatch)")).map((row) => row.name),
    )
    yield* tx.run(`INSERT OR IGNORE INTO session_dispatch
      (target_input_id,plugin_id,source_session_id,target_session_id,source_message_id,source_call_id,text,delivery,result_input_id,result_text,time_result_delivered,time_created)
      SELECT d.worker_input_id,'voice-conversation-app',d.voice_session_id,l.worker_session_id,d.source_message_id,d.source_call_id,d.text,d.delivery,d.result_input_id,
        ${columns.has("result_text") ? "d.result_text" : "NULL"},${columns.has("time_result_delivered") ? "d.time_result_delivered" : "NULL"},d.time_created
      FROM session_voice_dispatch d JOIN session_voice_link l ON l.voice_session_id=d.voice_session_id`)
  })
}
