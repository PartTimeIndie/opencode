import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260720144455_surface_tools",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`surface_action_invocation\` (
          \`id\` text PRIMARY KEY,
          \`target_kind\` text NOT NULL,
          \`target_id\` text NOT NULL,
          \`target_revision\` integer NOT NULL,
          \`action_id\` text NOT NULL,
          \`source\` text,
          \`payload_hash\` text NOT NULL,
          \`state\` text NOT NULL,
          \`result\` text,
          \`error\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`surface_tool\` (
          \`id\` text PRIMARY KEY,
          \`scope\` text NOT NULL,
          \`scope_key\` text NOT NULL,
          \`project_id\` text,
          \`directory\` text NOT NULL,
          \`origin_request_id\` text,
          \`origin_session_id\` text,
          \`origin_revision\` integer,
          \`mode\` text NOT NULL,
          \`definition_revision\` integer DEFAULT 1 NOT NULL,
          \`action_metadata\` text DEFAULT '[]' NOT NULL,
          \`surface\` text NOT NULL,
          \`state_version\` integer DEFAULT 1 NOT NULL,
          \`state_revision\` integer DEFAULT 1 NOT NULL,
          \`state_values\` text DEFAULT '{}' NOT NULL,
          \`hidden\` integer DEFAULT false NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_surface_tool_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`surface_action_invocation_target_idx\` ON \`surface_action_invocation\` (\`target_kind\`,\`target_id\`,\`target_revision\`,\`action_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`surface_tool_origin_scope_idx\` ON \`surface_tool\` (\`origin_request_id\`,\`scope_key\`);`)
      yield* tx.run(`CREATE INDEX \`surface_tool_scope_idx\` ON \`surface_tool\` (\`scope\`,\`scope_key\`,\`hidden\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
