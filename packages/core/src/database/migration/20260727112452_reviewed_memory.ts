import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260727112452_reviewed_memory",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`memory_embedding\` (
          \`memory_id\` text NOT NULL,
          \`model\` text NOT NULL,
          \`dimensions\` integer NOT NULL,
          \`vector\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_memory_embedding_memory_id_memory_id_fk\` FOREIGN KEY (\`memory_id\`) REFERENCES \`memory\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`memory\` (
          \`id\` text PRIMARY KEY,
          \`scope\` text NOT NULL,
          \`scope_key\` text NOT NULL,
          \`content\` text NOT NULL,
          \`source\` text NOT NULL,
          \`provenance\` text NOT NULL,
          \`state\` text DEFAULT 'pending' NOT NULL,
          \`reviewed_by\` text,
          \`time_reviewed\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`memory_embedding_memory_model_idx\` ON \`memory_embedding\` (\`memory_id\`,\`model\`);`)
      yield* tx.run(`CREATE INDEX \`memory_embedding_model_idx\` ON \`memory_embedding\` (\`model\`);`)
      yield* tx.run(`CREATE INDEX \`memory_scope_state_time_idx\` ON \`memory\` (\`scope\`,\`scope_key\`,\`state\`,\`time_updated\`);`)
      yield* tx.run(`CREATE INDEX \`memory_state_time_idx\` ON \`memory\` (\`state\`,\`time_updated\`);`)
      yield* tx.run(`CREATE VIRTUAL TABLE \`memory_fts\` USING fts5(\`id\` UNINDEXED, \`content\`, tokenize = 'unicode61')`)
      yield* tx.run(`
        CREATE TRIGGER \`memory_fts_insert\` AFTER INSERT ON \`memory\`
        WHEN NEW.\`state\` = 'approved'
        BEGIN
          INSERT INTO \`memory_fts\` (\`id\`, \`content\`) VALUES (NEW.\`id\`, NEW.\`content\`);
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER \`memory_fts_update\` AFTER UPDATE ON \`memory\`
        BEGIN
          DELETE FROM \`memory_fts\` WHERE \`id\` = OLD.\`id\`;
          INSERT INTO \`memory_fts\` (\`id\`, \`content\`)
          SELECT NEW.\`id\`, NEW.\`content\` WHERE NEW.\`state\` = 'approved';
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER \`memory_fts_delete\` AFTER DELETE ON \`memory\`
        BEGIN
          DELETE FROM \`memory_fts\` WHERE \`id\` = OLD.\`id\`;
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
