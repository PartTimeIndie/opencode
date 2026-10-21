import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260713113813_session_archive",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_archive_catalog\` (
          \`session_id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`title\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`location\` text NOT NULL,
          \`shard_id\` text,
          \`revision\` integer DEFAULT 0 NOT NULL,
          \`content_hash\` text,
          \`message_count\` integer DEFAULT 0 NOT NULL,
          \`input_count\` integer DEFAULT 0 NOT NULL,
          \`logical_bytes\` integer DEFAULT 0 NOT NULL,
          \`time_last_modified\` integer NOT NULL,
          \`time_archived\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_archive_catalog_shard_id_session_archive_shard_id_fk\` FOREIGN KEY (\`shard_id\`) REFERENCES \`session_archive_shard\`(\`id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_archive_journal\` (
          \`id\` text PRIMARY KEY,
          \`operation_key\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`operation\` text NOT NULL,
          \`state\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`shard_id\` text,
          \`content_hash\` text,
          \`message_count\` integer,
          \`input_count\` integer,
          \`error\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_completed\` integer,
          CONSTRAINT \`fk_session_archive_journal_shard_id_session_archive_shard_id_fk\` FOREIGN KEY (\`shard_id\`) REFERENCES \`session_archive_shard\`(\`id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_archive_shard\` (
          \`id\` text PRIMARY KEY,
          \`path\` text NOT NULL,
          \`state\` text NOT NULL,
          \`size_bytes\` integer DEFAULT 0 NOT NULL,
          \`max_bytes\` integer NOT NULL,
          \`session_count\` integer DEFAULT 0 NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_sealed\` integer
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`session_archive_catalog_location_time_idx\` ON \`session_archive_catalog\` (\`location\`,\`time_last_modified\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_archive_catalog_project_idx\` ON \`session_archive_catalog\` (\`project_id\`,\`time_last_modified\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_archive_catalog_shard_idx\` ON \`session_archive_catalog\` (\`shard_id\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_archive_journal_operation_idx\` ON \`session_archive_journal\` (\`operation_key\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_archive_journal_state_idx\` ON \`session_archive_journal\` (\`state\`,\`time_updated\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_archive_journal_session_idx\` ON \`session_archive_journal\` (\`session_id\`,\`revision\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_archive_shard_state_idx\` ON \`session_archive_shard\` (\`state\`,\`time_created\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
