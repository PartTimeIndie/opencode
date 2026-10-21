import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import { fileURLToPath } from "url"
import path from "path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { Effect, Layer, Schema } from "effect"
import { eq, inArray, sql } from "drizzle-orm"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { migrations } from "@opencode-ai/core/database/migration.gen"
import sessionUsageMigration from "@opencode-ai/core/database/migration/20260510033149_session_usage"
import normalizeStoragePathsMigration from "@opencode-ai/core/database/migration/20260601010001_normalize_storage_paths"
import sessionMessageProjectionOrderMigration from "@opencode-ai/core/database/migration/20260603040000_session_message_projection_order"
import eventSourcedSessionInputMigration from "@opencode-ai/core/database/migration/20260604172448_event_sourced_session_input"
import heldSessionInputMigration from "@opencode-ai/core/database/migration/20260923075033_open_zaladane"
import contextEpochAgentMigration from "@opencode-ai/core/database/migration/20260605042240_add_context_epoch_agent"
import simplifyIntegrationCredentialsMigration from "@opencode-ai/core/database/migration/20260611192811_lush_chimera"
import turnCompletionActivityMarkerMigration from "@opencode-ai/core/database/migration/20260713230853_turn_completion_activity_marker"
import migrateHistoricalTurnCompletions from "@opencode-ai/core/database/migration/20260714030000_migrate_historical_turn_completions"
import sessionQuestionMigration from "@opencode-ai/core/database/migration/20260714022745_session_question"
import canonicalSurfaceMigration from "@opencode-ai/core/database/migration/20260720090000_canonical_surface"
import sessionAgentPolicyMigration from "@opencode-ai/core/database/migration/20260726212005_session_agent_policy"
import projectIconGenerationMigration from "@opencode-ai/core/database/migration/20260731120000_project_icon_generation"
import boundSummaryDiffPatchesMigration from "@opencode-ai/core/database/migration/20260830090000_bound_summary_diff_patches"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import sessionMetadataMigration from "@opencode-ai/core/database/migration/20260511173437_session-metadata"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import { Database } from "@opencode-ai/core/database/database"
import { tmpdir } from "./fixture/tmpdir"
import { SessionMessage } from "@opencode-ai/core/session/message"
import * as SessionProtection from "@opencode-ai/core/session/protection"
import { SessionProtectionTable } from "@opencode-ai/core/session/protection.sql"

const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

const runOnFile = <A, E>(filename: string, effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(effect.pipe(Effect.provide(SqliteClient.layer({ filename, disableWAL: true })), Effect.scoped))

const makeDb = EffectDrizzleSqlite.makeWithDefaults()

describe("DatabaseMigration", () => {
  test("repairs missing file knowledge metadata without inventing historical receipts", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        expect(yield* db.all("SELECT * FROM file_knowledge_receipt")).toEqual([])
        expect(yield* db.get("SELECT id FROM migration WHERE id LIKE '%_file_knowledge_receipt'")).toBeDefined()
        yield* db.run("DROP TABLE file_knowledge_receipt")
        yield* db.run("DROP TABLE file_mutation_pending")
        yield* DatabaseMigration.apply(db)
        expect(yield* db.all("SELECT * FROM file_knowledge_receipt")).toEqual([])
        expect(yield* db.all("SELECT * FROM file_mutation_pending")).toEqual([])
        expect(
          yield* db.get("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'file_knowledge_source_idx'"),
        ).toBeDefined()
      }),
    )
  })

  test("creates and repairs orchestrator planning schema without granting execution authority", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        for (const name of ["session_orchestrator", "session_orchestrator_task", "session_orchestrator_reservation"]) {
          expect(yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${name}`)).toEqual({
            name,
          })
        }
        expect(yield* db.all("SELECT * FROM session_orchestrator")).toEqual([])
        yield* db.run("DROP TABLE session_orchestrator_reservation")
        yield* db.run("DROP INDEX session_orchestrator_task_request_idx")
        yield* db.run("ALTER TABLE session_orchestrator DROP COLUMN min_cache_read_ratio")
        expect(yield* db.get("SELECT id FROM migration WHERE id LIKE '%_session_orchestrator'")).toBeDefined()

        // The journal still says applied. The generic additive startup repair
        // must restore the table, defaulted column and idempotence index.
        yield* DatabaseMigration.apply(db)
        expect(
          yield* db.get(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_orchestrator_reservation'",
          ),
        ).toEqual({ name: "session_orchestrator_reservation" })
        expect(
          yield* db.get(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'session_orchestrator_task_request_idx'",
          ),
        ).toEqual({ name: "session_orchestrator_task_request_idx" })
        const columns = yield* db.all<{ name: string; dflt_value: string | null }>(
          "PRAGMA table_info(session_orchestrator)",
        )
        expect(columns.find((column) => column.name === "min_cache_read_ratio")?.dflt_value).toBe("0.8")
        expect(yield* db.all("SELECT * FROM session_orchestrator")).toEqual([])
      }),
    )
  })

  test("creates and repairs the journaled session protection table", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)

        yield* db
          .insert(ProjectTable)
          .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/protection"), sandboxes: [] })
          .run()
        const sessionID = SessionSchema.ID.make("ses_protection_migration")
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: ProjectV2.ID.global,
            slug: sessionID,
            directory: AbsolutePath.make("/protection"),
            title: "Protection migration",
            version: "test",
          })
          .run()

        yield* SessionProtection.setProtected(db, sessionID, true, 100)
        expect(yield* SessionProtection.isProtected(db, sessionID)).toBe(true)
        expect(
          yield* db.select().from(SessionProtectionTable).where(eq(SessionProtectionTable.session_id, sessionID)).get(),
        ).toMatchObject({
          session_id: sessionID,
          protected_at: 100,
          updated_at: 100,
        })

        // The migration journal remains intact. Startup repair must still recreate a table removed after migration.
        yield* db.run("DROP TABLE session_protection")
        expect(yield* db.get("SELECT id FROM migration WHERE id = '20260914074423_session_protection'")).toBeDefined()
        yield* DatabaseMigration.apply(db)
        expect(
          yield* db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_protection'"),
        ).toEqual({
          name: "session_protection",
        })
        expect(yield* SessionProtection.isProtected(db, sessionID)).toBe(false)

        yield* SessionProtection.setProtected(db, sessionID, true, 200)
        yield* SessionProtection.setProtected(db, sessionID, false, 300)
        expect(yield* SessionProtection.isProtected(db, sessionID)).toBe(false)
      }),
    )
  })

  test("preserves legacy dispatch IDs and delivery state and repairs journaled generic link schema", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        yield* db
          .insert(ProjectTable)
          .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/links"), sandboxes: [] })
          .run()
        yield* db
          .insert(SessionTable)
          .values(
            ["ses_link_source", "ses_link_target"].map((id) => ({
              id: SessionSchema.ID.make(id),
              project_id: ProjectV2.ID.global,
              slug: id,
              directory: "/links",
              title: id,
              version: "test",
            })),
          )
          .run()
        yield* db.run(`INSERT INTO session_voice_link (voice_session_id,worker_session_id,time_created,time_ended)
        VALUES ('ses_link_source','ses_link_target',100,200)`)
        yield* db.run(`INSERT INTO session_voice_dispatch
        (worker_input_id,voice_session_id,source_message_id,source_call_id,text,delivery,result_input_id,result_text,time_result_delivered,time_created)
        VALUES ('msg_old_target','ses_link_source','msg_old_source','call_old','Fix it','queue','msg_old_result','Already delivered',150,110)`)
        yield* db.run("DROP TABLE session_dispatch")
        yield* db.run("DROP TABLE session_link")
        yield* db.run("DELETE FROM migration WHERE id='20260909150000_session_plugin_links'")
        yield* DatabaseMigration.apply(db, { deferStartupRepairs: true, deferLegacyEventBackfill: true })
        expect(
          yield* db.get(
            "SELECT plugin_id,source_session_id,target_session_id,permission_policy,time_ended FROM session_link",
          ),
        ).toEqual({
          plugin_id: "voice-conversation-app",
          source_session_id: "ses_link_source",
          target_session_id: "ses_link_target",
          permission_policy: "single-use",
          time_ended: 200,
        })
        const dispatch = yield* db.get("SELECT * FROM session_dispatch")
        expect(dispatch).toMatchObject({
          target_input_id: "msg_old_target",
          source_message_id: "msg_old_source",
          source_call_id: "call_old",
          result_input_id: "msg_old_result",
          result_text: "Already delivered",
          time_result_delivered: 150,
        })
        yield* DatabaseMigration.apply(db)
        expect(yield* db.get("SELECT * FROM session_dispatch")).toEqual(dispatch)
        // A journal entry is not proof that its schema pieces still exist.
        yield* db.run("DROP TABLE session_dispatch")
        yield* db.run("DROP TABLE session_link")
        yield* DatabaseMigration.apply(db)
        expect(yield* db.get("SELECT * FROM session_dispatch")).toEqual(dispatch)
        yield* db.run("ALTER TABLE session_dispatch DROP COLUMN result_text")
        yield* db.run("ALTER TABLE session_dispatch DROP COLUMN time_result_delivered")
        yield* db.run("ALTER TABLE session_link DROP COLUMN permission_policy")
        yield* db.run("DROP INDEX session_dispatch_origin_idx")
        yield* db.run("DROP INDEX session_link_active_target_idx")
        yield* DatabaseMigration.apply(db)
        yield* DatabaseMigration.apply(db)
        expect(
          (yield* db.all<{ name: string }>("PRAGMA table_info(session_dispatch)")).map((row) => row.name),
        ).toContain("result_text")
        expect((yield* db.all<{ name: string }>("PRAGMA table_info(session_link)")).map((row) => row.name)).toContain(
          "permission_policy",
        )
        expect(yield* db.get("SELECT permission_policy FROM session_link")).toEqual({ permission_policy: "single-use" })
        expect(
          (yield* db.all<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('session_dispatch_origin_idx','session_link_active_target_idx')",
          ))
            .map((row) => row.name)
            .sort(),
        ).toEqual(["session_dispatch_origin_idx", "session_link_active_target_idx"])
        expect(yield* db.all("PRAGMA foreign_key_check")).toEqual([])
        expect(yield* db.get("SELECT COUNT(*) AS count FROM session_dispatch")).toEqual({ count: 1 })
      }),
    )
  })

  test("migrates and repairs journaled voice links, dispatch columns, and indexes", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        yield* db.run("DROP TABLE session_voice_dispatch")
        yield* db.run("DROP TABLE session_voice_link")
        yield* db.run("DELETE FROM migration WHERE id = '20260908135944_session_voice_links'")
        // Installed databases still run the registered migration when repairs are deferred.
        yield* DatabaseMigration.apply(db, { deferStartupRepairs: true, deferLegacyEventBackfill: true })
        expect(yield* db.get("SELECT id FROM migration WHERE id = '20260908135944_session_voice_links'")).toEqual({
          id: "20260908135944_session_voice_links",
        })
        yield* db.run("DROP TABLE session_voice_dispatch")
        yield* db.run("DROP TABLE session_voice_link")
        // The journal now says done: startup repair must recreate both tables.
        yield* DatabaseMigration.apply(db)
        yield* db.run("ALTER TABLE session_voice_dispatch DROP COLUMN result_text")
        yield* db.run("ALTER TABLE session_voice_dispatch DROP COLUMN time_result_delivered")
        yield* db.run("DROP INDEX session_voice_dispatch_origin_idx")
        yield* db.run("DROP INDEX session_voice_link_active_worker_idx")
        yield* DatabaseMigration.apply(db)
        yield* DatabaseMigration.apply(db)
        const columns = yield* db.all<{ name: string }>("PRAGMA table_info(session_voice_dispatch)")
        expect(columns.map((column) => column.name)).toContain("result_text")
        expect(columns.map((column) => column.name)).toContain("time_result_delivered")
        expect(
          yield* db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'index'
        AND name IN ('session_voice_dispatch_origin_idx', 'session_voice_dispatch_result_idx', 'session_voice_link_active_worker_idx')
        ORDER BY name`),
        ).toEqual([
          { name: "session_voice_dispatch_origin_idx" },
          { name: "session_voice_dispatch_result_idx" },
          { name: "session_voice_link_active_worker_idx" },
        ])
        expect(yield* db.all("PRAGMA foreign_key_check")).toEqual([])
      }),
    )
  })

  test("repairs a journaled session generation_ms column removed after migration", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        yield* db
          .insert(ProjectTable)
          .values({
            id: ProjectV2.ID.make("generation_repair_project"),
            worktree: AbsolutePath.make("/generation/repair"),
            sandboxes: [],
            time_created: 1,
            time_updated: 1,
          })
          .run()
        yield* db
          .insert(SessionTable)
          .values({
            id: SessionSchema.ID.make("ses_generation_repair"),
            project_id: ProjectV2.ID.make("generation_repair_project"),
            slug: "generation-repair",
            directory: AbsolutePath.make("/generation/repair"),
            title: "Generation Repair",
            version: "test",
            generation_ms: 4200,
            time_created: 1,
            time_updated: 1,
          })
          .run()
        // Journal entry without the schema piece: startup repair must restore it additively.
        yield* db.run("ALTER TABLE session DROP COLUMN generation_ms")
        yield* DatabaseMigration.applyOnly(db, migrations, { deferLegacyEventBackfill: true })
        const columns = yield* db.all<{ name: string }>("PRAGMA table_info(session)")
        expect(columns.map((column) => column.name)).toContain("generation_ms")
        // The drop discards prior values by definition; the repair must still restore
        // the column and leave existing rows at measured zero, never NULL.
        expect(
          yield* db.get<{ generation_ms: number }>(
            sql`SELECT generation_ms FROM session WHERE id = 'ses_generation_repair'`,
          ),
        ).toEqual({ generation_ms: 0 })
      }),
    )
  })

  test("serializes concurrent embedded initialization for one database path", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "embedded.sqlite")
    const layers = [Database.layerFromPath(filename), Database.layerFromPath(filename)]

    await Effect.runPromise(
      Effect.all(
        layers.map((layer) => Effect.scoped(Layer.build(layer))),
        { concurrency: "unbounded" },
      ),
    )
  })

  test("initializes a repaired database while another connection holds the writer lock", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "writer-lock.sqlite")
    await Effect.runPromise(Effect.scoped(Layer.build(Database.layerFromPath(filename))))

    const SqliteDatabase = (await import("bun:sqlite")).Database
    const writer = new SqliteDatabase(filename)
    writer.run("BEGIN IMMEDIATE")
    try {
      await Effect.runPromise(Effect.scoped(Layer.build(Database.layerFromPath(filename))))
    } finally {
      writer.run("ROLLBACK")
      writer.close()
    }
  })

  test("defers a missing memory search row while another connection holds the writer lock", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "memory-search-writer-lock.sqlite")
    await Effect.runPromise(Effect.scoped(Layer.build(Database.layerFromPath(filename))))

    const SqliteDatabase = (await import("bun:sqlite")).Database
    const writer = new SqliteDatabase(filename)
    writer.run(`
      INSERT INTO memory (id, scope, scope_key, content, source, provenance, state, time_created, time_updated)
      VALUES ('memory_locked', 'global', 'global', 'recoverable search content', 'test', '{}', 'approved', 1, 1)
    `)
    writer.run("DELETE FROM memory_fts WHERE id = 'memory_locked'")
    writer.run("BEGIN IMMEDIATE")
    try {
      await Effect.runPromise(Effect.scoped(Layer.build(Database.layerFromPath(filename))))
    } finally {
      writer.run("ROLLBACK")
      writer.close()
    }

    await Effect.runPromise(Effect.scoped(Layer.build(Database.layerFromPath(filename))))
    const reader = new SqliteDatabase(filename, { readonly: true })
    try {
      expect(reader.query("SELECT id, content FROM memory_fts WHERE id = 'memory_locked'").get()).toEqual({
        id: "memory_locked",
        content: "recoverable search content",
      })
    } finally {
      reader.close()
    }
  }, 15_000)

  test("restores busy_timeout after deferring memory search repair under writer lock", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "memory-search-busy-timeout.sqlite")
    await Effect.runPromise(Effect.scoped(Layer.build(Database.layerFromPath(filename))))

    const SqliteDatabase = (await import("bun:sqlite")).Database
    const writer = new SqliteDatabase(filename)
    writer.run(`
      INSERT INTO memory (id, scope, scope_key, content, source, provenance, state, time_created, time_updated)
      VALUES ('memory_busy_timeout', 'global', 'global', 'recoverable busy timeout content', 'test', '{}', 'approved', 1, 1)
    `)
    writer.run("DELETE FROM memory_fts WHERE id = 'memory_busy_timeout'")
    writer.run("BEGIN IMMEDIATE")
    try {
      await runOnFile(
        filename,
        Effect.gen(function* () {
          const db = yield* makeDb
          const previous = yield* db.all<{ timeout: number }>("PRAGMA busy_timeout")
          yield* DatabaseMigration.repairMemorySearch(db)
          expect(yield* db.all<{ timeout: number }>("PRAGMA busy_timeout")).toEqual(previous)
          expect(
            yield* db.get<{ count: number }>(
              sql`SELECT COUNT(*) AS count FROM memory_fts WHERE id = 'memory_busy_timeout'`,
            ),
          ).toEqual({ count: 0 })
        }),
      )
    } finally {
      writer.run("ROLLBACK")
      writer.close()
    }

    await runOnFile(
      filename,
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.repairMemorySearch(db)
        expect(
          yield* db.get<{ count: number }>(
            sql`SELECT COUNT(*) AS count FROM memory_fts WHERE id = 'memory_busy_timeout'`,
          ),
        ).toEqual({ count: 1 })
      }),
    )
  }, 15_000)

  test("opens a locked database without startup repairs when explicitly deferred", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "deferred-startup.sqlite")
    await Effect.runPromise(Effect.scoped(Layer.build(Database.layerFromPath(filename))))

    const SqliteDatabase = (await import("bun:sqlite")).Database
    const writer = new SqliteDatabase(filename)
    writer.run("BEGIN IMMEDIATE")
    try {
      await Effect.runPromise(
        Effect.scoped(Layer.build(Database.layerFromPath(filename, { deferStartupRepairs: true }))),
      )

      const reader = new SqliteDatabase(filename, { readonly: true })
      try {
        expect(reader.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" })
      } finally {
        reader.close()
      }
    } finally {
      writer.run("ROLLBACK")
      writer.close()
    }
  })

  test("applies a newly registered migration before deferred server database access and only once", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "deferred-server-migration.sqlite")
    await Effect.runPromise(Effect.scoped(Layer.build(Database.layerFromPath(filename))))
    const migration: DatabaseMigration.Migration = {
      id: "test_deferred_server_startup_migration",
      up: (tx) => tx.run("CREATE TABLE test_deferred_server_startup_migration (id INTEGER PRIMARY KEY)"),
    }
    migrations.push(migration as (typeof migrations)[number])

    try {
      const access = Effect.gen(function* () {
        const database = yield* Database.Service
        expect(
          yield* database.db.get<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_deferred_server_startup_migration'",
          ),
        ).toEqual({ name: migration.id })
        return yield* database.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM session")
      }).pipe(Effect.provide(Database.layerFromPath(filename, { deferStartupRepairs: true })))

      expect(await Effect.runPromise(access)).toEqual({ count: 0 })
      expect(await Effect.runPromise(access)).toEqual({ count: 0 })

      const SqliteDatabase = (await import("bun:sqlite")).Database
      const reader = new SqliteDatabase(filename, { readonly: true })
      try {
        expect(reader.query("SELECT COUNT(*) AS count FROM migration WHERE id = ?").get(migration.id)).toEqual({
          count: 1,
        })
      } finally {
        reader.close()
      }
    } finally {
      expect(migrations.pop()?.id).toBe(migration.id)
    }
  })

  test("runs a pending migration once across concurrent database connections", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "concurrent-server-migration.sqlite")
    await Effect.runPromise(Effect.scoped(Layer.build(Database.layerFromPath(filename))))
    const SqliteDatabase = (await import("bun:sqlite")).Database
    const setup = new SqliteDatabase(filename)
    setup.run("CREATE TABLE test_concurrent_server_migration (runs INTEGER NOT NULL)")
    setup.run("INSERT INTO test_concurrent_server_migration (runs) VALUES (0)")
    setup.close()

    const ready = Promise.withResolvers<void>()
    let arrivals = 0
    const migration: DatabaseMigration.Migration = {
      id: "test_concurrent_server_migration",
      up: (tx) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => {
            arrivals++
            if (arrivals === 2) ready.resolve()
            return ready.promise
          })
          yield* tx.run("UPDATE test_concurrent_server_migration SET runs = runs + 1")
        }),
    }
    const apply = () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* makeDb
          yield* DatabaseMigration.applyOnly(db, [migration], {
            deferLegacyEventBackfill: true,
            deferStartupRepairs: true,
          })
        }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped),
      )

    await Promise.all([apply(), apply()])
    const reader = new SqliteDatabase(filename, { readonly: true })
    try {
      expect(reader.query("SELECT runs FROM test_concurrent_server_migration").get()).toEqual({ runs: 1 })
      expect(reader.query("SELECT COUNT(*) AS count FROM migration WHERE id = ?").get(migration.id)).toEqual({
        count: 1,
      })
    } finally {
      reader.close()
    }
  })

  test("can defer the legacy event backfill until after database startup", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        yield* db
          .insert(ProjectTable)
          .values({
            id: ProjectV2.ID.make("deferred_project"),
            worktree: AbsolutePath.make("/deferred/project"),
            sandboxes: [],
            time_created: 1,
            time_updated: 1,
          })
          .run()
        yield* db
          .insert(SessionTable)
          .values({
            id: SessionSchema.ID.make("ses_deferred_backfill"),
            project_id: ProjectV2.ID.make("deferred_project"),
            slug: "deferred-backfill",
            directory: AbsolutePath.make("/deferred/project"),
            title: "Deferred Backfill",
            version: "test",
            time_created: 1,
            time_updated: 1,
          })
          .run()
        yield* db.run(sql`
          INSERT INTO message (id, session_id, time_created, time_updated, data)
          VALUES ('msg_deferred_user', 'ses_deferred_backfill', 10, 10, ${JSON.stringify({
            role: "user",
            time: { created: 10 },
            agent: "build",
            model: { providerID: "openai", modelID: "gpt-test" },
          })})
        `)

        yield* DatabaseMigration.applyOnly(db, migrations, { deferLegacyEventBackfill: true })
        expect(
          yield* db.get(sql`SELECT id FROM session_message WHERE session_id = 'ses_deferred_backfill'`),
        ).toBeUndefined()
        expect(
          yield* db.get(sql`SELECT id FROM migration WHERE id = 'repair_legacy_session_events_v1'`),
        ).toBeUndefined()

        yield* DatabaseMigration.repairLegacySessionEvents(db)
        expect(yield* db.get(sql`SELECT id FROM session_message WHERE session_id = 'ses_deferred_backfill'`)).toEqual({
          id: "msg_deferred_user",
        })
        expect(yield* db.get(sql`SELECT id FROM migration WHERE id = 'repair_legacy_session_events_v1'`)).toEqual({
          id: "repair_legacy_session_events_v1",
        })
      }),
    )
  })

  test("repairs oversized legacy summary diff patches once while preserving metadata", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        yield* db.run(sql`
          DELETE FROM migration WHERE id = '20260830090000_bound_summary_diff_patches'
        `)
        yield* db
          .insert(ProjectTable)
          .values({
            id: ProjectV2.ID.make("summary_diff_repair_project"),
            worktree: AbsolutePath.make("/summary/diff-repair"),
            sandboxes: [],
            time_created: 1,
            time_updated: 1,
          })
          .run()

        const metadata = [
          { file: "added.ts", patch: "ü".repeat(1024 * 1024), additions: 12, deletions: 0, status: "added" },
          { file: "removed.ts", patch: "legacy patch", additions: 0, deletions: 7, status: "deleted" },
          { file: "changed.ts", additions: 3, deletions: 2, status: "modified", custom: "preserved" },
        ]
        yield* db.run(sql`
          INSERT INTO session (
            id, project_id, slug, directory, title, version, summary_diffs, time_created, time_updated
          ) VALUES (
            'ses_summary_diff_repair',
            'summary_diff_repair_project',
            'summary-diff-repair',
            '/summary/diff-repair',
            'Summary diff repair',
            'test',
            ${JSON.stringify(metadata)},
            1,
            1
          )
        `)
        const largeMetadata = JSON.stringify([
          {
            file: `large-${"m".repeat(2 * 1024 * 1024)}.ts`,
            patch: "small patch",
            additions: 1,
            deletions: 0,
            status: "added",
          },
        ])
        const nonconforming = JSON.stringify([
          "legacy",
          { file: "large.ts", patch: "x".repeat(2 * 1024 * 1024 + 1), additions: 1, deletions: 1 },
        ])
        const malformed = "[{"
        yield* db.run(sql`
          INSERT INTO session (
            id, project_id, slug, directory, title, version, summary_diffs, time_created, time_updated
          ) VALUES
            (
              'ses_large_diff_metadata', 'summary_diff_repair_project', 'large-diff-metadata',
              '/summary/diff-repair', 'Large diff metadata', 'test', ${largeMetadata}, 1, 1
            ),
            (
              'ses_nonconforming_diffs', 'summary_diff_repair_project', 'nonconforming-diffs',
              '/summary/diff-repair', 'Nonconforming diffs', 'test', ${nonconforming}, 1, 1
            ),
            (
              'ses_malformed_diffs', 'summary_diff_repair_project', 'malformed-diffs',
              '/summary/diff-repair', 'Malformed diffs', 'test', ${malformed}, 1, 1
            )
        `)

        yield* DatabaseMigration.applyOnly(db, [boundSummaryDiffPatchesMigration])

        const repaired = yield* db.get<{ summary_diffs: string }>(sql`
          SELECT summary_diffs FROM session WHERE id = 'ses_summary_diff_repair'
        `)
        expect(JSON.parse(repaired!.summary_diffs)).toEqual([
          { file: "added.ts", additions: 12, deletions: 0, status: "added" },
          { file: "removed.ts", additions: 0, deletions: 7, status: "deleted" },
          { file: "changed.ts", additions: 3, deletions: 2, status: "modified", custom: "preserved" },
        ])
        expect(
          yield* db.all<{ id: string; summary_diffs: string }>(sql`
            SELECT id, summary_diffs
            FROM session
            WHERE id IN ('ses_large_diff_metadata', 'ses_malformed_diffs', 'ses_nonconforming_diffs')
            ORDER BY id
          `),
        ).toEqual([
          { id: "ses_large_diff_metadata", summary_diffs: largeMetadata },
          { id: "ses_malformed_diffs", summary_diffs: malformed },
          { id: "ses_nonconforming_diffs", summary_diffs: nonconforming },
        ])
        expect(
          yield* db.get(sql`SELECT id FROM migration WHERE id = '20260830090000_bound_summary_diff_patches'`),
        ).toEqual({ id: "20260830090000_bound_summary_diff_patches" })

        const second = JSON.stringify([
          { file: "later.ts", patch: "y".repeat(2 * 1024 * 1024), additions: 1, deletions: 1, status: "modified" },
        ])
        yield* db.run(sql`
          UPDATE session SET summary_diffs = ${second} WHERE id = 'ses_summary_diff_repair'
        `)
        yield* DatabaseMigration.applyOnly(db, [boundSummaryDiffPatchesMigration])

        expect(
          yield* db.get<{ summary_diffs: string }>(sql`
            SELECT summary_diffs FROM session WHERE id = 'ses_summary_diff_repair'
          `),
        ).toEqual({ summary_diffs: second })
        expect(
          yield* db.get(
            sql`SELECT count(*) AS count FROM migration WHERE id = '20260830090000_bound_summary_diff_patches'`,
          ),
        ).toEqual({ count: 1 })
      }),
    )
  })

  if (process.platform === "linux") {
    test("declared schema has no ungenerated migrations", async () => {
      const result = await $`bun ${fileURLToPath(new URL("../script/migration.ts", import.meta.url))} --check`
        .quiet()
        .nothrow()
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      expect(result.stdout.toString()).toContain("No schema changes, nothing to migrate")
    }, 30_000)
  }

  test("applies tracked migrations to an empty database", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)

        expect(yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session'`)).toEqual({
          name: "session",
        })
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_input'`),
        ).toEqual({ name: "session_input" })
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_context_epoch'`),
        ).toEqual({ name: "session_context_epoch" })
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_question'`),
        ).toEqual({ name: "session_question" })
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'event_checkpoint'`),
        ).toEqual({ name: "event_checkpoint" })
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'content_blob'`),
        ).toEqual({ name: "content_blob" })
        expect(
          yield* db.all(sql`
            SELECT name FROM sqlite_master
            WHERE type = 'table' AND name IN ('surface_action_invocation', 'surface_tool')
            ORDER BY name
          `),
        ).toEqual([{ name: "surface_action_invocation" }, { name: "surface_tool" }])
        expect(
          yield* db.all(sql`
            SELECT name FROM sqlite_master
            WHERE type = 'index'
              AND name IN (
                'surface_action_invocation_target_idx',
                'surface_tool_origin_scope_idx',
                'surface_tool_scope_idx'
              )
            ORDER BY name
          `),
        ).toEqual([
          { name: "surface_action_invocation_target_idx" },
          { name: "surface_tool_origin_scope_idx" },
          { name: "surface_tool_scope_idx" },
        ])
        expect(yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'attachment'`)).toEqual(
          { name: "attachment" },
        )
        expect(
          yield* db.all(sql`
            SELECT name FROM sqlite_master
            WHERE type = 'table'
              AND name IN ('session_archive_catalog', 'session_archive_journal', 'session_archive_shard')
            ORDER BY name
          `),
        ).toEqual([
          { name: "session_archive_catalog" },
          { name: "session_archive_journal" },
          { name: "session_archive_shard" },
        ])
        expect(
          yield* db.all(sql`
            SELECT name FROM sqlite_master
            WHERE type = 'index'
              AND name IN (
                'session_archive_catalog_location_time_idx',
                'session_archive_catalog_project_idx',
                'session_archive_catalog_shard_idx',
                'session_archive_journal_operation_idx',
                'session_archive_journal_session_idx',
                'session_archive_journal_state_idx',
                'session_archive_shard_state_idx'
              )
            ORDER BY name
          `),
        ).toEqual([
          { name: "session_archive_catalog_location_time_idx" },
          { name: "session_archive_catalog_project_idx" },
          { name: "session_archive_catalog_shard_idx" },
          { name: "session_archive_journal_operation_idx" },
          { name: "session_archive_journal_session_idx" },
          { name: "session_archive_journal_state_idx" },
          { name: "session_archive_shard_state_idx" },
        ])
        expect(
          (yield* db.all<{ name: string; unique: number }>(sql`PRAGMA index_list(session_archive_journal)`)).find(
            (index) => index.name === "session_archive_journal_operation_idx",
          ),
        ).toMatchObject({ unique: 1 })
        expect(
          yield* db.get(sql`SELECT name FROM pragma_table_info('session_archive_catalog') WHERE name = 'session_data'`),
        ).toEqual({ name: "session_data" })
        expect(
          yield* db.get(
            sql`SELECT name, dflt_value FROM pragma_table_info('session_context_epoch') WHERE name = 'agent'`,
          ),
        ).toEqual({ name: "agent", dflt_value: "'build'" })
        expect(yield* db.get(sql`SELECT count(*) as count FROM migration`)).toEqual({ count: migrations.length })
        expect(yield* db.get(sql`SELECT id FROM migration WHERE id = ${migrateHistoricalTurnCompletions.id}`)).toEqual({
          id: migrateHistoricalTurnCompletions.id,
        })
        expect(
          yield* db.all(
            sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('event_aggregate_seq_idx', 'event_aggregate_type_seq_idx', 'session_input_session_pending_seq_idx', 'session_input_session_pending_delivery_seq_idx', 'session_input_session_admitted_seq_idx', 'session_input_session_promoted_seq_idx', 'session_message_session_idx', 'session_message_session_type_idx', 'session_message_session_seq_idx', 'session_message_session_type_seq_idx', 'session_message_session_time_created_id_idx') ORDER BY name`,
          ),
        ).toEqual([
          { name: "event_aggregate_seq_idx" },
          { name: "event_aggregate_type_seq_idx" },
          { name: "session_input_session_admitted_seq_idx" },
          { name: "session_input_session_pending_delivery_seq_idx" },
          { name: "session_input_session_promoted_seq_idx" },
          { name: "session_message_session_seq_idx" },
          { name: "session_message_session_time_created_id_idx" },
          { name: "session_message_session_type_seq_idx" },
        ])
      }),
    )
  })

  test("rejects a non-empty database without a session table", async () => {
    await expect(
      run(
        Effect.gen(function* () {
          const db = yield* makeDb
          yield* db.run(sql`CREATE TABLE unrelated (id text PRIMARY KEY)`)
          yield* DatabaseMigration.apply(db)
        }),
      ),
    ).rejects.toThrow("Database is not empty and has no session table")
  })

  test("repairs a journaled session table missing the agent policy snapshot", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, time_updated integer NOT NULL)`)
        yield* db.run(sql`CREATE TABLE migration (id text PRIMARY KEY, time_completed integer NOT NULL)`)
        yield* db.run(
          sql`INSERT INTO migration (id, time_completed) VALUES (${sessionAgentPolicyMigration.id}, ${Date.now()})`,
        )

        yield* DatabaseMigration.applyOnly(db, [sessionAgentPolicyMigration])

        expect(yield* db.get(sql`SELECT name FROM pragma_table_info('session') WHERE name = 'agent_policy'`)).toEqual({
          name: "agent_policy",
        })
      }),
    )
  })

  test("repairs journaled project icon generation columns", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, time_updated integer NOT NULL)`)
        yield* db.run(sql`CREATE TABLE project (id text PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE migration (id text PRIMARY KEY, time_completed integer NOT NULL)`)
        yield* db.run(
          sql`INSERT INTO migration (id, time_completed) VALUES (${projectIconGenerationMigration.id}, ${Date.now()})`,
        )

        yield* DatabaseMigration.applyOnly(db, [projectIconGenerationMigration])

        expect(
          yield* db.all<{ name: string }>(sql`
            SELECT name FROM pragma_table_info('project')
            WHERE name LIKE 'icon_generation_%' OR name = 'icon_generated_url'
            ORDER BY name
          `),
        ).toEqual([
          { name: "icon_generated_url" },
          { name: "icon_generation_attempt" },
          { name: "icon_generation_attempted_at" },
          { name: "icon_generation_completed_at" },
          { name: "icon_generation_error" },
          { name: "icon_generation_mode" },
          { name: "icon_generation_status" },
        ])
      }),
    )
  })

  test("repairs journaled session input hold columns", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, time_updated integer NOT NULL)`)
        yield* db.run(sql`
          CREATE TABLE session_input (
            id text PRIMARY KEY,
            session_id text NOT NULL,
            prompt text NOT NULL,
            delivery text NOT NULL,
            admitted_seq integer NOT NULL,
            promoted_seq integer,
            time_created integer NOT NULL
          )
        `)
        yield* db.run(sql`CREATE TABLE migration (id text PRIMARY KEY, time_completed integer NOT NULL)`)
        yield* db.run(
          sql`INSERT INTO migration (id, time_completed) VALUES (${heldSessionInputMigration.id}, ${Date.now()})`,
        )

        yield* DatabaseMigration.applyOnly(db, [heldSessionInputMigration])

        expect(
          yield* db.all<{ name: string }>(sql`
            SELECT name FROM pragma_table_info('session_input')
            WHERE name IN ('execution_prompt', 'held_at')
            ORDER BY name
          `),
        ).toEqual([{ name: "execution_prompt" }, { name: "held_at" }])
      }),
    )
  })

  test("repairs a journaled session_question table and missing FIFO index", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, time_updated integer NOT NULL)`)
        yield* db.run(sql`CREATE TABLE migration (id text PRIMARY KEY, time_completed integer NOT NULL)`)
        yield* db.run(
          sql`INSERT INTO migration (id, time_completed) VALUES (${sessionQuestionMigration.id}, ${Date.now()})`,
        )

        yield* DatabaseMigration.applyOnly(db, [sessionQuestionMigration])

        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_question'`),
        ).toEqual({ name: "session_question" })
        expect(
          yield* db.all(sql`
            SELECT name FROM sqlite_master
            WHERE type = 'index'
              AND name IN (
                'session_question_session_seq_idx',
                'session_question_pending_fifo_idx',
                'session_question_active_idx',
                'session_question_tool_retry_idx',
                'session_question_activity_idx'
              )
            ORDER BY name
          `),
        ).toEqual([
          { name: "session_question_active_idx" },
          { name: "session_question_activity_idx" },
          { name: "session_question_pending_fifo_idx" },
          { name: "session_question_session_seq_idx" },
          { name: "session_question_tool_retry_idx" },
        ])

        yield* db.run(sql`DROP INDEX session_question_pending_fifo_idx`)
        yield* DatabaseMigration.applyOnly(db, [sessionQuestionMigration])

        expect(
          yield* db.get(
            sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'session_question_pending_fifo_idx'`,
          ),
        ).toEqual({ name: "session_question_pending_fifo_idx" })
      }),
    )
  })

  test("repairs journaled legacy surface columns, metadata, request JSON, and index", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, time_updated integer NOT NULL)`)
        yield* db.run(sql`CREATE TABLE migration (id text PRIMARY KEY, time_completed integer NOT NULL)`)
        yield* db.run(sql`
          CREATE TABLE session_question (
            id text PRIMARY KEY,
            session_id text NOT NULL,
            seq integer NOT NULL,
            state text NOT NULL,
            request text NOT NULL,
            answers text,
            receipt text,
            detached integer DEFAULT false NOT NULL,
            allow_concurrent integer DEFAULT false NOT NULL,
            activity_id text,
            assistant_message_id text,
            tool_call_id text,
            time_settled integer,
            time_created integer NOT NULL,
            time_updated integer NOT NULL
          )
        `)
        yield* db.run(sql`INSERT INTO session (id, time_updated) VALUES ('ses_surface_repair', 1)`)
        yield* db.run(sql`
          INSERT INTO session_question
            (id, session_id, seq, state, request, time_created, time_updated)
          VALUES
            ('que_surface_repair', 'ses_surface_repair', 1, 'active', ${JSON.stringify({
              id: "que_surface_repair",
              sessionID: "ses_surface_repair",
              questions: [{ question: "Legacy?" }],
            })}, 1, 1)
        `)
        yield* db.run(sql`
          INSERT INTO migration (id, time_completed) VALUES
            (${sessionQuestionMigration.id}, 1),
            (${canonicalSurfaceMigration.id}, 2)
        `)

        yield* DatabaseMigration.applyOnly(db, [sessionQuestionMigration, canonicalSurfaceMigration])
        yield* DatabaseMigration.applyOnly(db, [sessionQuestionMigration, canonicalSurfaceMigration])

        expect(
          (yield* db.all<{ name: string }>(sql`PRAGMA table_info(session_question)`)).map((column) => column.name),
        ).toEqual(expect.arrayContaining(["mode", "revision", "action_metadata"]))
        const row = yield* db.get<{
          mode: string
          revision: number
          action_metadata: string
          request: string
        }>(sql`SELECT mode, revision, action_metadata, request FROM session_question WHERE id = 'que_surface_repair'`)
        expect(row).toMatchObject({ mode: "blocking", revision: 1, action_metadata: "[]" })
        expect(JSON.parse(row!.request)).toMatchObject({ mode: "blocking", revision: 1, actions: [] })
        expect(
          yield* db.get(
            sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'session_question_mode_state_idx'`,
          ),
        ).toEqual({ name: "session_question_mode_state_idx" })
      }),
    )
  })

  test("backfills existing Context Epoch rows to the build agent", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(
          sql`CREATE TABLE session_context_epoch (session_id text PRIMARY KEY, baseline text NOT NULL, snapshot text NOT NULL, baseline_seq integer NOT NULL, replacement_seq integer, revision integer DEFAULT 0 NOT NULL)`,
        )
        yield* db.run(
          sql`INSERT INTO session_context_epoch (session_id, baseline, snapshot, baseline_seq) VALUES ('ses_existing', 'baseline', '{}', 0)`,
        )

        yield* DatabaseMigration.applyOnly(db, [contextEpochAgentMigration])

        expect(yield* db.get(sql`SELECT agent FROM session_context_epoch WHERE session_id = 'ses_existing'`)).toEqual({
          agent: "build",
        })
      }),
    )
  })

  test("marks only pre-migration terminal activities as skipped", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`
          CREATE TABLE session_activity (
            id text PRIMARY KEY NOT NULL,
            status text NOT NULL,
            time_updated integer NOT NULL
          )
        `)
        yield* db.run(sql`
          INSERT INTO session_activity (id, status, time_updated) VALUES
            ('activity_completed', 'completed', 11),
            ('activity_failed', 'failed', 12),
            ('activity_interrupted', 'interrupted', 13),
            ('activity_running', 'running', 14)
        `)

        yield* DatabaseMigration.applyOnly(db, [turnCompletionActivityMarkerMigration])

        expect(
          yield* db.all(sql`
            SELECT
              id,
              status,
              turn_completion_state AS completionState,
              turn_completion_result AS completionResult,
              turn_completion_completed_at AS completionTime
            FROM session_activity
            ORDER BY id
          `),
        ).toEqual([
          {
            id: "activity_completed",
            status: "completed",
            completionState: "done",
            completionResult: "skipped",
            completionTime: 11,
          },
          {
            id: "activity_failed",
            status: "failed",
            completionState: "done",
            completionResult: "skipped",
            completionTime: 12,
          },
          {
            id: "activity_interrupted",
            status: "interrupted",
            completionState: "done",
            completionResult: "skipped",
            completionTime: 13,
          },
          {
            id: "activity_running",
            status: "running",
            completionState: null,
            completionResult: null,
            completionTime: null,
          },
        ])

        yield* db.run(sql`
          INSERT INTO session_activity (
            id, status, time_updated, turn_completion_state, turn_completion_result
          ) VALUES
            ('activity_new_pending', 'completed', 21, NULL, NULL),
            ('activity_retry_pending', 'failed', 22, 'ready', 'incomplete')
        `)
        yield* DatabaseMigration.applyOnly(db, [turnCompletionActivityMarkerMigration])

        expect(
          yield* db.all(sql`
            SELECT
              id,
              turn_completion_state AS completionState,
              turn_completion_result AS completionResult
            FROM session_activity
            WHERE id IN ('activity_new_pending', 'activity_retry_pending')
            ORDER BY id
          `),
        ).toEqual([
          { id: "activity_new_pending", completionState: null, completionResult: null },
          { id: "activity_retry_pending", completionState: "ready", completionResult: "incomplete" },
        ])
      }),
    )
  })

  test("migrates historical completions after the marker migration was already journaled", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`
          CREATE TABLE migration (id text PRIMARY KEY, time_completed integer NOT NULL)
        `)
        yield* db.run(sql`
          INSERT INTO migration (id, time_completed)
          VALUES (${turnCompletionActivityMarkerMigration.id}, 100)
        `)
        yield* db.run(sql`
          CREATE TABLE session_activity (
            id text PRIMARY KEY NOT NULL,
            status text NOT NULL,
            time_updated integer NOT NULL,
            turn_completion_state text,
            turn_completion_result text,
            turn_completion_completed_at integer
          )
        `)
        yield* db.run(sql`
          INSERT INTO session_activity (
            id, status, time_updated, turn_completion_state, turn_completion_result
          ) VALUES
            ('activity_historical_completed', 'completed', 90, NULL, NULL),
            ('activity_historical_interrupted', 'interrupted', 99, NULL, NULL),
            ('activity_later_pending', 'failed', 101, NULL, NULL),
            ('activity_retry_pending', 'failed', 80, 'ready', 'incomplete'),
            ('activity_running', 'running', 70, NULL, NULL)
        `)

        yield* DatabaseMigration.applyOnly(db, [migrateHistoricalTurnCompletions])

        expect(
          yield* db.all(sql`
            SELECT
              id,
              turn_completion_state AS completionState,
              turn_completion_result AS completionResult
            FROM session_activity
            ORDER BY id
          `),
        ).toEqual([
          { id: "activity_historical_completed", completionState: "done", completionResult: "skipped" },
          { id: "activity_historical_interrupted", completionState: "done", completionResult: "skipped" },
          { id: "activity_later_pending", completionState: null, completionResult: null },
          { id: "activity_retry_pending", completionState: "ready", completionResult: "incomplete" },
          { id: "activity_running", completionState: null, completionResult: null },
        ])
      }),
    )
  })

  test("repairs additive schema drift after recorded migrations", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, time_updated integer NOT NULL)`)
        yield* db.run(
          sql`CREATE TABLE session_context_epoch (session_id text PRIMARY KEY, baseline text NOT NULL, snapshot text NOT NULL, baseline_seq integer NOT NULL, revision integer DEFAULT 0 NOT NULL)`,
        )
        yield* db.run(
          sql`CREATE TABLE session_input (id text PRIMARY KEY, session_id text NOT NULL, prompt text NOT NULL, delivery text NOT NULL, admitted_seq integer NOT NULL, promoted_seq integer, time_created integer NOT NULL)`,
        )
        yield* db.run(sql`
          CREATE TABLE session_activity (
            id text PRIMARY KEY NOT NULL,
            session_id text NOT NULL,
            status text NOT NULL,
            kind text NOT NULL,
            reason text,
            owner_id text,
            lease_until integer,
            heartbeat_at integer,
            recovery_attempts integer DEFAULT 0 NOT NULL,
            last_error text,
            opened_seq integer,
            closed_seq integer,
            turn_completion_state text,
            time_created integer NOT NULL,
            time_updated integer NOT NULL
          )
        `)
        yield* db.run(sql`
          INSERT INTO session_activity (id, session_id, status, kind, time_created, time_updated) VALUES
            ('activity_repair_completed', 'ses_history', 'completed', 'prompt', 31, 32),
            ('activity_repair_running', 'ses_active', 'running', 'prompt', 33, 34)
        `)
        yield* db.run(
          sql`CREATE TABLE attachment (id text PRIMARY KEY, session_id text NOT NULL, message_id text, mime text NOT NULL, filename text, size_bytes integer, source_path text, storage_path text NOT NULL, created_at integer NOT NULL)`,
        )
        yield* db.run(sql`
          CREATE TABLE session_archive_catalog (
            session_id text PRIMARY KEY,
            project_id text NOT NULL,
            title text NOT NULL,
            directory text NOT NULL,
            location text NOT NULL,
            shard_id text,
            revision integer DEFAULT 0 NOT NULL,
            content_hash text,
            message_count integer DEFAULT 0 NOT NULL,
            input_count integer DEFAULT 0 NOT NULL,
            logical_bytes integer DEFAULT 0 NOT NULL,
            time_last_modified integer NOT NULL,
            time_archived integer,
            time_created integer NOT NULL,
            time_updated integer NOT NULL
          )
        `)
        yield* db.run(sql`
          INSERT INTO session_archive_catalog (
            session_id, project_id, title, directory, location,
            time_last_modified, time_created, time_updated
          ) VALUES ('ses_archived', 'project', 'Archived', '/project', 'archived', 1, 1, 1)
        `)
        yield* db.run(
          sql`INSERT INTO session_context_epoch (session_id, baseline, snapshot, baseline_seq) VALUES ('ses_existing', 'baseline', '{}', 0)`,
        )
        yield* db.run(sql`CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`)
        for (const migration of migrations) {
          yield* db.run(
            sql`INSERT INTO migration (id, time_completed) VALUES (${migration.id}, ${migration.id === turnCompletionActivityMarkerMigration.id ? 40 : 1})`,
          )
        }

        yield* DatabaseMigration.applyOnly(db, migrations)

        expect(yield* db.get(sql`SELECT agent FROM session_context_epoch WHERE session_id = 'ses_existing'`)).toEqual({
          agent: "build",
        })
        expect(
          yield* db.get(
            sql`SELECT name FROM pragma_table_info('session_context_epoch') WHERE name = 'replacement_seq'`,
          ),
        ).toEqual({ name: "replacement_seq" })
        expect(
          yield* db.get(sql`SELECT replacement_seq FROM session_context_epoch WHERE session_id = 'ses_existing'`),
        ).toEqual({ replacement_seq: null })
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_activity'`),
        ).toEqual({ name: "session_activity" })
        expect(
          yield* db.all(sql`
            SELECT name FROM pragma_table_info('session_activity')
            WHERE name IN (
              'turn_completion_state',
              'turn_completion_result',
              'turn_completion_owner_id',
              'turn_completion_lease_until',
              'turn_completion_attempts',
              'turn_completion_error',
              'turn_completion_completed_at'
            )
            ORDER BY name
          `),
        ).toEqual([
          { name: "turn_completion_attempts" },
          { name: "turn_completion_completed_at" },
          { name: "turn_completion_error" },
          { name: "turn_completion_lease_until" },
          { name: "turn_completion_owner_id" },
          { name: "turn_completion_result" },
          { name: "turn_completion_state" },
        ])
        expect(
          yield* db.all(sql`
            SELECT
              id,
              turn_completion_state AS completionState,
              turn_completion_result AS completionResult
            FROM session_activity
            WHERE id IN ('activity_repair_completed', 'activity_repair_running')
            ORDER BY id
          `),
        ).toEqual([
          { id: "activity_repair_completed", completionState: "done", completionResult: "skipped" },
          { id: "activity_repair_running", completionState: null, completionResult: null },
        ])
        expect(
          yield* db.get(
            sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'session_activity_turn_completion_idx'`,
          ),
        ).toEqual({ name: "session_activity_turn_completion_idx" })
        yield* db.run(sql`
          INSERT INTO session_activity (
            id, session_id, status, kind,
            turn_completion_state, turn_completion_result,
            time_created, time_updated
          ) VALUES
            ('activity_repair_new_pending', 'ses_new', 'completed', 'prompt', NULL, NULL, 41, 42),
            ('activity_repair_retry_pending', 'ses_retry', 'failed', 'prompt', 'ready', 'incomplete', 43, 44)
        `)
        yield* DatabaseMigration.applyOnly(db, migrations)
        expect(
          yield* db.all(sql`
            SELECT
              id,
              turn_completion_state AS completionState,
              turn_completion_result AS completionResult
            FROM session_activity
            WHERE id IN ('activity_repair_new_pending', 'activity_repair_retry_pending')
            ORDER BY id
          `),
        ).toEqual([
          { id: "activity_repair_new_pending", completionState: null, completionResult: null },
          { id: "activity_repair_retry_pending", completionState: "ready", completionResult: "incomplete" },
        ])
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'background_job'`),
        ).toEqual({ name: "background_job" })
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_file_blob'`),
        ).toEqual({ name: "session_file_blob" })
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_file_mutation'`),
        ).toEqual({ name: "session_file_mutation" })
        expect(
          yield* db.all(sql`
            SELECT name FROM sqlite_master
            WHERE type = 'table' AND name IN ('memory', 'memory_embedding', 'memory_fts')
            ORDER BY name
          `),
        ).toEqual([{ name: "memory" }, { name: "memory_embedding" }, { name: "memory_fts" }])
        expect(
          yield* db.all(sql`
            SELECT name FROM sqlite_master
            WHERE type = 'trigger' AND name LIKE 'memory_fts_%'
            ORDER BY name
          `),
        ).toEqual([{ name: "memory_fts_delete" }, { name: "memory_fts_insert" }, { name: "memory_fts_update" }])
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'event_checkpoint'`),
        ).toEqual({ name: "event_checkpoint" })
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'content_blob'`),
        ).toEqual({ name: "content_blob" })
        expect(
          yield* db.all(sql`
            SELECT name FROM sqlite_master
            WHERE type = 'table'
              AND name IN ('session_archive_catalog', 'session_archive_journal', 'session_archive_shard')
            ORDER BY name
          `),
        ).toEqual([
          { name: "session_archive_catalog" },
          { name: "session_archive_journal" },
          { name: "session_archive_shard" },
        ])
        expect(
          yield* db.all(sql`
            SELECT name FROM sqlite_master
            WHERE type = 'index'
              AND name IN (
                'session_archive_catalog_location_time_idx',
                'session_archive_catalog_project_idx',
                'session_archive_catalog_shard_idx',
                'session_archive_journal_operation_idx',
                'session_archive_journal_session_idx',
                'session_archive_journal_state_idx',
                'session_archive_shard_state_idx'
              )
            ORDER BY name
          `),
        ).toEqual([
          { name: "session_archive_catalog_location_time_idx" },
          { name: "session_archive_catalog_project_idx" },
          { name: "session_archive_catalog_shard_idx" },
          { name: "session_archive_journal_operation_idx" },
          { name: "session_archive_journal_session_idx" },
          { name: "session_archive_journal_state_idx" },
          { name: "session_archive_shard_state_idx" },
        ])
        expect(
          (yield* db.all<{ name: string; unique: number }>(sql`PRAGMA index_list(session_archive_journal)`)).find(
            (index) => index.name === "session_archive_journal_operation_idx",
          ),
        ).toMatchObject({ unique: 1 })
        expect(
          yield* db.get(sql`SELECT name FROM pragma_table_info('session_archive_catalog') WHERE name = 'session_data'`),
        ).toEqual({ name: "session_data" })
        expect(
          yield* db.get(
            sql`SELECT session_id, session_data FROM session_archive_catalog WHERE session_id = 'ses_archived'`,
          ),
        ).toEqual({ session_id: "ses_archived", session_data: null })
        expect(yield* db.get(sql`SELECT name FROM pragma_table_info('attachment') WHERE name = 'blob_sha256'`)).toEqual(
          { name: "blob_sha256" },
        )
        expect(
          yield* db.get(
            sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'session_input_session_pending_delivery_seq_idx'`,
          ),
        ).toEqual({ name: "session_input_session_pending_delivery_seq_idx" })
        expect(
          yield* db.get(
            sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'session_file_mutation_target_idx'`,
          ),
        ).toEqual({ name: "session_file_mutation_target_idx" })
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'attachment_blob_idx'`),
        ).toEqual({ name: "attachment_blob_idx" })
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'content_blob_created_idx'`),
        ).toEqual({ name: "content_blob_created_idx" })
      }),
    )
  })

  test("keeps legacy credential fields nullable", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(
          sql`CREATE TABLE credential (id text PRIMARY KEY, connector_id text NOT NULL, method_id text NOT NULL, label text NOT NULL, value text NOT NULL, active integer DEFAULT false NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL)`,
        )
        yield* db.run(
          sql`CREATE UNIQUE INDEX credential_connector_active_idx ON credential (connector_id) WHERE active = 1`,
        )
        yield* DatabaseMigration.applyOnly(db, [simplifyIntegrationCredentialsMigration])

        yield* db.run(
          sql`INSERT INTO credential (id, connector_id, method_id, label, value, active, time_created, time_updated) VALUES ('legacy', 'openai', 'oauth', 'Legacy', '{}', 1, 1, 1)`,
        )
        yield* db.run(
          sql`INSERT INTO credential (id, integration_id, label, value, time_created, time_updated) VALUES ('current', 'anthropic', 'Current', '{}', 2, 2)`,
        )
        expect(yield* db.get(sql`SELECT connector_id, method_id, active FROM credential WHERE id = 'current'`)).toEqual(
          { connector_id: null, method_id: null, active: null },
        )
      }),
    )
  })

  test("resets beta history and rebuilds event-sourced Session input storage", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, workspace_id text)`)
        yield* db.run(sql`CREATE TABLE workspace (id text PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE message (id text PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE part (id text PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE event_sequence (aggregate_id text PRIMARY KEY, seq integer NOT NULL)`)
        yield* db.run(
          sql`CREATE TABLE event (id text PRIMARY KEY, aggregate_id text NOT NULL, seq integer NOT NULL, type text NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(sql`CREATE INDEX event_aggregate_seq_idx ON event (aggregate_id, seq)`)
        yield* db.run(sql`CREATE INDEX event_aggregate_type_seq_idx ON event (aggregate_id, type, seq)`)
        yield* db.run(
          sql`CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(sql`CREATE INDEX session_message_session_seq_idx ON session_message (session_id, seq)`)
        yield* db.run(
          sql`CREATE TABLE session_input (seq integer PRIMARY KEY AUTOINCREMENT, id text NOT NULL UNIQUE, session_id text NOT NULL, prompt text NOT NULL, delivery text NOT NULL, promoted_seq integer, time_created integer NOT NULL)`,
        )
        yield* db.run(
          sql`CREATE INDEX session_input_session_pending_delivery_seq_idx ON session_input (session_id, promoted_seq, delivery, seq)`,
        )
        yield* db.run(sql`INSERT INTO session (id, workspace_id) VALUES ('session', 'wrk_old')`)
        yield* db.run(sql`INSERT INTO workspace (id) VALUES ('wrk_old')`)
        yield* db.run(sql`INSERT INTO message (id) VALUES ('message')`)
        yield* db.run(sql`INSERT INTO part (id) VALUES ('part')`)
        yield* db.run(sql`INSERT INTO event_sequence (aggregate_id, seq) VALUES ('session', 0)`)
        yield* db.run(
          sql`INSERT INTO event (id, aggregate_id, seq, type, data) VALUES ('evt_old', 'session', 0, 'old.1', '{}')`,
        )
        yield* db.run(
          sql`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES ('msg_old', 'session', 'user', 0, 1, 1, '{}')`,
        )
        yield* db.run(
          sql`INSERT INTO session_input (id, session_id, prompt, delivery, time_created) VALUES ('msg_pending', 'session', '{}', 'steer', 1)`,
        )

        yield* DatabaseMigration.applyOnly(db, [eventSourcedSessionInputMigration])

        expect(yield* db.all(sql`SELECT id, workspace_id FROM session`)).toEqual([
          { id: "session", workspace_id: null },
        ])
        expect(yield* db.all(sql`SELECT id FROM workspace`)).toEqual([])
        expect(yield* db.all(sql`SELECT id FROM message`)).toEqual([{ id: "message" }])
        expect(yield* db.all(sql`SELECT id FROM part`)).toEqual([{ id: "part" }])
        expect(yield* db.all(sql`SELECT id FROM event`)).toEqual([])
        expect(yield* db.all(sql`SELECT aggregate_id FROM event_sequence`)).toEqual([])
        expect(yield* db.all(sql`SELECT id FROM session_message`)).toEqual([])
        expect(yield* db.all(sql`SELECT id FROM session_input`)).toEqual([])
        expect(
          (yield* db.all<{ name: string }>(sql`PRAGMA table_info(session_input)`)).map((column) => column.name),
        ).toEqual(["id", "session_id", "prompt", "delivery", "admitted_seq", "promoted_seq", "time_created"])
        expect(
          (yield* db.all<{ name: string; unique: number }>(sql`PRAGMA index_list(session_message)`)).find(
            (index) => index.name === "session_message_session_seq_idx",
          ),
        ).toMatchObject({ unique: 1 })
        expect(
          (yield* db.all<{ name: string; unique: number }>(sql`PRAGMA index_list(event)`)).find(
            (index) => index.name === "event_aggregate_seq_idx",
          ),
        ).toMatchObject({ unique: 1 })
        expect(
          (yield* db.all<{ name: string; unique: number }>(sql`PRAGMA index_list(session_input)`)).filter((index) =>
            ["session_input_session_admitted_seq_idx", "session_input_session_promoted_seq_idx"].includes(index.name),
          ),
        ).toEqual([
          expect.objectContaining({ name: "session_input_session_promoted_seq_idx", unique: 1 }),
          expect.objectContaining({ name: "session_input_session_admitted_seq_idx", unique: 1 }),
        ])
      }),
    )
  })

  test("resets incompatible projected Session messages before adding sequence order", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)
        yield* db.run(
          sql`CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(
          sql`CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(sql`CREATE TABLE event (id text PRIMARY KEY, seq integer NOT NULL)`)
        yield* db.run(
          sql`CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(
          sql`CREATE INDEX session_message_session_time_created_id_idx ON session_message (session_id, time_created, id)`,
        )
        yield* db.run(
          sql`CREATE INDEX session_message_session_type_time_created_id_idx ON session_message (session_id, type, time_created, id)`,
        )
        yield* db.run(sql`INSERT INTO session (id) VALUES ('session')`)
        yield* db.run(
          sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('legacy_message', 'session', 1, 1, '{"role":"user"}')`,
        )
        yield* db.run(
          sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('legacy_part', 'legacy_message', 'session', 1, 1, '{"type":"text","text":"hello"}')`,
        )
        yield* db.run(
          sql`INSERT INTO session_message (id, session_id, type, time_created, time_updated, data) VALUES ('stale_projection', 'session', 'user', 1, 1, '{}')`,
        )

        yield* DatabaseMigration.applyOnly(db, [sessionMessageProjectionOrderMigration])

        expect(yield* db.all(sql`SELECT id, session_id, data FROM message`)).toEqual([
          { id: "legacy_message", session_id: "session", data: '{"role":"user"}' },
        ])
        expect(yield* db.all(sql`SELECT id, message_id, session_id, data FROM part`)).toEqual([
          {
            id: "legacy_part",
            message_id: "legacy_message",
            session_id: "session",
            data: '{"type":"text","text":"hello"}',
          },
        ])
        expect(yield* db.all(sql`SELECT id FROM session_message`)).toEqual([])

        yield* db.run(
          sql`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES ('fresh_projection', 'session', 'user', 7, 2, 2, '{}')`,
        )
        expect(yield* db.get(sql`SELECT id, seq FROM session_message`)).toEqual({ id: "fresh_projection", seq: 7 })
      }),
    )
  })

  test("backfills legacy Session messages into V2 events and projections idempotently", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        yield* db
          .insert(ProjectTable)
          .values({
            id: ProjectV2.ID.make("legacy_project"),
            worktree: AbsolutePath.make("/legacy/project"),
            sandboxes: [],
            time_created: 1,
            time_updated: 1,
          })
          .run()
        yield* db
          .insert(SessionTable)
          .values({
            id: SessionSchema.ID.make("ses_legacy_backfill"),
            project_id: ProjectV2.ID.make("legacy_project"),
            slug: "legacy-backfill",
            directory: AbsolutePath.make("/legacy/project"),
            title: "Legacy Backfill",
            version: "test",
            time_created: 1,
            time_updated: 1,
          })
          .run()
        yield* db.run(sql`
          INSERT INTO message (id, session_id, time_created, time_updated, data)
          VALUES (
            'msg_legacy_user',
            'ses_legacy_backfill',
            10,
            10,
            ${JSON.stringify({
              role: "user",
              time: { created: 10 },
              agent: "build",
              model: { providerID: "openai", modelID: "gpt-test", variant: "fast" },
              system: "legacy system",
            })}
          )
        `)
        yield* db.run(sql`
          INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
          VALUES
            (
              'prt_legacy_user_text',
              'msg_legacy_user',
              'ses_legacy_backfill',
              10,
              10,
              ${JSON.stringify({ type: "text", text: "hello legacy" })}
            ),
            (
              'prt_legacy_user_file',
              'msg_legacy_user',
              'ses_legacy_backfill',
              10,
              10,
              ${JSON.stringify({
                type: "file",
                mime: "text/plain",
                filename: "note.txt",
                url: "file:///legacy/note.txt",
                source: { type: "file", path: "note.txt", text: { value: "@note", start: 6, end: 11 } },
              })}
            )
        `)
        yield* db.run(sql`
          INSERT INTO message (id, session_id, time_created, time_updated, data)
          VALUES (
            'msg_legacy_assistant',
            'ses_legacy_backfill',
            20,
            30,
            ${JSON.stringify({
              role: "assistant",
              time: { created: 20, completed: 30 },
              parentID: "msg_legacy_user",
              modelID: "gpt-test",
              providerID: "openai",
              mode: "build",
              agent: "build",
              path: { cwd: "/legacy/project", root: "/legacy/project" },
              cost: 0.5,
              tokens: { input: 2, output: 3, reasoning: 1, cache: { read: 4, write: 5 } },
              finish: "stop",
            })}
          )
        `)
        yield* db.run(sql`
          INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
          VALUES
            (
              'prt_legacy_step_start',
              'msg_legacy_assistant',
              'ses_legacy_backfill',
              20,
              20,
              ${JSON.stringify({ type: "step-start", snapshot: "snap-start" })}
            ),
            (
              'prt_legacy_reasoning',
              'msg_legacy_assistant',
              'ses_legacy_backfill',
              21,
              22,
              ${JSON.stringify({ type: "reasoning", text: "thinking", time: { start: 21, end: 22 } })}
            ),
            (
              'prt_legacy_answer',
              'msg_legacy_assistant',
              'ses_legacy_backfill',
              22,
              23,
              ${JSON.stringify({ type: "text", text: "answer", time: { start: 22, end: 23 } })}
            ),
            (
              'prt_legacy_tool',
              'msg_legacy_assistant',
              'ses_legacy_backfill',
              24,
              25,
              ${JSON.stringify({
                type: "tool",
                callID: "call_legacy_read",
                tool: "read",
                state: {
                  status: "completed",
                  input: { filePath: "note.txt" },
                  output: "tool output",
                  title: "Read",
                  metadata: { bytes: 11 },
                  time: { start: 24, end: 25 },
                  attachments: [
                    { type: "file", mime: "text/plain", filename: "tool.txt", url: "file:///legacy/tool.txt" },
                  ],
                },
              })}
            ),
            (
              'prt_legacy_step_finish',
              'msg_legacy_assistant',
              'ses_legacy_backfill',
              30,
              30,
              ${JSON.stringify({
                type: "step-finish",
                reason: "stop",
                snapshot: "snap-end",
                cost: 0.5,
                tokens: { input: 2, output: 3, reasoning: 1, cache: { read: 4, write: 5 } },
              })}
            )
        `)

        yield* DatabaseMigration.applyOnly(db, migrations)

        const projected = yield* db.all<{ id: string; type: string; seq: number; time_updated: number; data: string }>(
          sql`SELECT id, type, seq, time_updated, data FROM session_message WHERE session_id = 'ses_legacy_backfill' ORDER BY seq`,
        )
        expect(projected.map((row) => ({ ...row, data: JSON.parse(row.data) }))).toEqual([
          {
            id: "msg_legacy_user",
            type: "user",
            seq: 0,
            time_updated: 10,
            data: expect.objectContaining({
              text: "hello legacy",
              files: [
                expect.objectContaining({ uri: "file:///legacy/note.txt", mime: "text/plain", name: "note.txt" }),
              ],
            }),
          },
          {
            id: "msg_legacy_assistant",
            type: "assistant",
            seq: 1,
            time_updated: 30,
            data: expect.objectContaining({
              finish: "stop",
              cost: 0.5,
              snapshot: { start: "snap-start", end: "snap-end" },
              tokens: { input: 2, output: 3, reasoning: 1, cache: { read: 4, write: 5 } },
              content: [
                { type: "reasoning", id: "prt_legacy_reasoning", text: "thinking" },
                { type: "text", id: "prt_legacy_answer", text: "answer" },
                expect.objectContaining({
                  type: "tool",
                  id: "call_legacy_read",
                  name: "read",
                  state: expect.objectContaining({
                    status: "completed",
                    input: { filePath: "note.txt" },
                    content: [
                      { type: "text", text: "tool output" },
                      { type: "file", uri: "file:///legacy/tool.txt", mime: "text/plain", name: "tool.txt" },
                    ],
                  }),
                }),
              ],
            }),
          },
        ])
        const decodeMessage = Schema.decodeUnknownSync(SessionMessage.Message)
        expect(
          projected.map((row) => decodeMessage({ ...JSON.parse(row.data), id: row.id, type: row.type })),
        ).toHaveLength(2)
        expect(
          yield* db.all(sql`SELECT type, seq FROM event WHERE aggregate_id = 'ses_legacy_backfill' ORDER BY seq`),
        ).toEqual([
          { type: "session.next.prompted.1", seq: 0 },
          { type: "session.next.step.started.1", seq: 1 },
          { type: "session.next.reasoning.started.1", seq: 2 },
          { type: "session.next.reasoning.ended.1", seq: 3 },
          { type: "session.next.text.started.1", seq: 4 },
          { type: "session.next.text.ended.1", seq: 5 },
          { type: "session.next.tool.input.started.1", seq: 6 },
          { type: "session.next.tool.input.ended.1", seq: 7 },
          { type: "session.next.tool.called.1", seq: 8 },
          { type: "session.next.tool.success.1", seq: 9 },
          { type: "session.next.step.ended.2", seq: 10 },
        ])
        expect(yield* db.get(sql`SELECT seq FROM event_sequence WHERE aggregate_id = 'ses_legacy_backfill'`)).toEqual({
          seq: 10,
        })
        expect(
          yield* db.get(sql`SELECT id, admitted_seq, promoted_seq FROM session_input WHERE id = 'msg_legacy_user'`),
        ).toEqual({ id: "msg_legacy_user", admitted_seq: 0, promoted_seq: 0 })

        yield* DatabaseMigration.applyOnly(db, migrations)

        expect(
          yield* db.get(sql`SELECT count(*) AS count FROM event WHERE aggregate_id = 'ses_legacy_backfill'`),
        ).toEqual({
          count: 11,
        })
        expect(
          yield* db.get(sql`SELECT count(*) AS count FROM session_message WHERE session_id = 'ses_legacy_backfill'`),
        ).toEqual({ count: 2 })
      }),
    )
  })

  test("appends V2 backfill events after existing legacy V1 event rows", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        yield* db
          .insert(ProjectTable)
          .values({
            id: ProjectV2.ID.make("legacy_events_project"),
            worktree: AbsolutePath.make("/legacy/events"),
            sandboxes: [],
            time_created: 1,
            time_updated: 1,
          })
          .run()
        yield* db
          .insert(SessionTable)
          .values({
            id: SessionSchema.ID.make("ses_legacy_events"),
            project_id: ProjectV2.ID.make("legacy_events_project"),
            slug: "legacy-events",
            directory: AbsolutePath.make("/legacy/events"),
            title: "Legacy Events",
            version: "test",
            time_created: 1,
            time_updated: 1,
          })
          .run()
        yield* db.run(sql`
          INSERT INTO event_sequence (aggregate_id, seq) VALUES ('ses_legacy_events', 3)
        `)
        yield* db.run(sql`
          INSERT INTO event (id, aggregate_id, seq, type, data)
          VALUES
            ('evt_legacy_created', 'ses_legacy_events', 0, 'session.created.1', '{}'),
            ('evt_legacy_message', 'ses_legacy_events', 1, 'message.updated.1', '{}'),
            ('evt_legacy_part', 'ses_legacy_events', 2, 'message.part.updated.1', '{}')
        `)
        yield* db.run(sql`
          INSERT INTO message (id, session_id, time_created, time_updated, data)
          VALUES (
            'msg_legacy_events_user',
            'ses_legacy_events',
            100,
            100,
            ${JSON.stringify({
              role: "user",
              time: { created: 100 },
              agent: "build",
              model: { providerID: "openai", modelID: "gpt-test" },
            })}
          )
        `)
        yield* db.run(sql`
          INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
          VALUES (
            'prt_legacy_events_text',
            'msg_legacy_events_user',
            'ses_legacy_events',
            100,
            100,
            ${JSON.stringify({ type: "text", text: "existing legacy events" })}
          )
        `)

        yield* DatabaseMigration.applyOnly(db, migrations)

        expect(
          yield* db.all(sql`SELECT type, seq FROM event WHERE aggregate_id = 'ses_legacy_events' ORDER BY seq`),
        ).toEqual([
          { type: "session.created.1", seq: 0 },
          { type: "message.updated.1", seq: 1 },
          { type: "message.part.updated.1", seq: 2 },
          { type: "session.next.prompted.1", seq: 4 },
        ])
        expect(yield* db.get(sql`SELECT seq FROM event_sequence WHERE aggregate_id = 'ses_legacy_events'`)).toEqual({
          seq: 4,
        })
        expect(yield* db.get(sql`SELECT id FROM migration WHERE id = 'repair_legacy_session_events_v1'`)).toEqual({
          id: "repair_legacy_session_events_v1",
        })
        expect(yield* db.get(sql`SELECT id, seq FROM session_message WHERE session_id = 'ses_legacy_events'`)).toEqual({
          id: "msg_legacy_events_user",
          seq: 4,
        })

        yield* DatabaseMigration.applyOnly(db, migrations)

        expect(
          yield* db.get(sql`SELECT count(*) AS count FROM event WHERE aggregate_id = 'ses_legacy_events'`),
        ).toEqual({
          count: 4,
        })
      }),
    )
  })

  test("runs session usage backfill in order with schema changes", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, time_updated integer NOT NULL)`)
        yield* db.run(sql`CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, data text NOT NULL)`)
        yield* db.run(sql`INSERT INTO session (id, time_updated) VALUES ('session_1', 1)`)
        yield* db.run(
          sql`INSERT INTO message (id, session_id, data) VALUES ('message_1', 'session_1', '{"role":"assistant","cost":1.25,"tokens":{"input":2,"output":3,"reasoning":4,"cache":{"read":5,"write":6}}}')`,
        )

        yield* DatabaseMigration.applyOnly(db, [sessionUsageMigration])

        expect(
          yield* db.get(
            sql`SELECT cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write FROM session WHERE id = 'session_1'`,
          ),
        ).toEqual({
          cost: 1.25,
          tokens_input: 2,
          tokens_output: 3,
          tokens_reasoning: 4,
          tokens_cache_read: 5,
          tokens_cache_write: 6,
        })
      }),
    )
  })

  test("normalizes Windows storage paths and leaves POSIX paths untouched", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE project (id text PRIMARY KEY, worktree text NOT NULL, sandboxes text NOT NULL)`)
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, directory text NOT NULL, path text)`)
        // Windows-shaped rows (drive + backslash) must be normalized.
        yield* db.run(
          sql`INSERT INTO project (id, worktree, sandboxes) VALUES (${"win"}, ${"C:\\Repo\\Thing"}, ${JSON.stringify([
            "C:\\Repo\\Thing\\sandbox",
          ])})`,
        )
        yield* db.run(
          sql`INSERT INTO session (id, directory, path) VALUES (${"win"}, ${"C:\\Repo\\Thing\\packages\\api"}, ${"packages\\api"})`,
        )
        // UNC worktrees and their sandboxes must normalize too (not just drive paths).
        yield* db.run(
          sql`INSERT INTO project (id, worktree, sandboxes) VALUES (${"unc"}, ${"\\\\server\\share"}, ${JSON.stringify([
            "\\\\server\\share\\sandbox",
          ])})`,
        )
        // The "/" worktree sentinel and POSIX paths (including a pathological
        // backslash in a POSIX filename) must survive byte-for-byte.
        yield* db.run(sql`INSERT INTO project (id, worktree, sandboxes) VALUES (${"global"}, ${"/"}, ${"[]"})`)
        yield* db.run(
          sql`INSERT INTO session (id, directory, path) VALUES (${"posix"}, ${"/home/me/we\\ird"}, ${"src\\weird"})`,
        )

        yield* DatabaseMigration.applyOnly(db, [normalizeStoragePathsMigration])

        expect(yield* db.get(sql`SELECT worktree, sandboxes FROM project WHERE id = 'win'`)).toEqual({
          worktree: "C:/Repo/Thing",
          sandboxes: JSON.stringify(["C:/Repo/Thing/sandbox"]),
        })
        expect(yield* db.get(sql`SELECT directory, path FROM session WHERE id = 'win'`)).toEqual({
          directory: "C:/Repo/Thing/packages/api",
          path: "packages/api",
        })
        expect(yield* db.get(sql`SELECT worktree, sandboxes FROM project WHERE id = 'unc'`)).toEqual({
          worktree: "//server/share",
          sandboxes: JSON.stringify(["//server/share/sandbox"]),
        })
        expect(yield* db.get(sql`SELECT worktree FROM project WHERE id = 'global'`)).toEqual({ worktree: "/" })
        expect(yield* db.get(sql`SELECT directory, path FROM session WHERE id = 'posix'`)).toEqual({
          directory: "/home/me/we\\ird",
          path: "src\\weird",
        })
      }),
    )
  })

  test("maps native Windows paths through database columns", async () => {
    if (process.platform !== "win32") return
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        const projectID = ProjectV2.ID.make("codec_project")
        const worktree = AbsolutePath.make("C:\\Repo\\Thing")
        const sandbox = AbsolutePath.make("C:\\Repo\\Thing\\sandbox")
        const directory = "C:\\Repo\\Thing\\packages\\api"
        const sessionID = SessionSchema.ID.make("ses_codec")

        expect(() =>
          Effect.runSync(
            db
              .insert(ProjectTable)
              .values({
                id: ProjectV2.ID.make("invalid_path"),
                worktree: AbsolutePath.make("not-absolute"),
                sandboxes: [],
                time_created: 1,
                time_updated: 1,
              })
              .run(),
          ),
        ).toThrow()

        yield* db
          .insert(ProjectTable)
          .values({
            id: projectID,
            worktree,
            sandboxes: [sandbox],
            time_created: 1,
            time_updated: 1,
          })
          .run()
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: projectID,
            slug: "codec",
            directory,
            path: "packages\\api",
            title: "Codec",
            version: "test",
            time_created: 1,
            time_updated: 1,
          })
          .run()

        expect(
          yield* db.get<{ worktree: string; sandboxes: string }>(
            sql`SELECT worktree, sandboxes FROM project WHERE id = ${projectID}`,
          ),
        ).toEqual({
          worktree: "C:/Repo/Thing",
          sandboxes: JSON.stringify(["C:/Repo/Thing/sandbox"]),
        })
        expect(
          yield* db.get<{ directory: string; path: string }>(
            sql`SELECT directory, path FROM session WHERE id = ${sessionID}`,
          ),
        ).toEqual({
          directory: "C:/Repo/Thing/packages/api",
          path: "packages/api",
        })

        const project = yield* db.select().from(ProjectTable).where(eq(ProjectTable.worktree, worktree)).get()
        const session = yield* db.select().from(SessionTable).where(eq(SessionTable.directory, directory)).get()
        expect(project?.worktree).toBe(worktree)
        expect(project?.sandboxes).toEqual([sandbox])
        expect(session?.directory).toBe(directory)
        expect(session?.path).toBe("packages/api")

        expect((yield* db.select().from(SessionTable).where(eq(SessionTable.path, "packages\\api")).get())?.id).toBe(
          sessionID,
        )

        const moved = AbsolutePath.make("D:\\Moved\\Thing")
        const updated = yield* db
          .update(ProjectTable)
          .set({ worktree: moved, sandboxes: [moved] })
          .where(eq(ProjectTable.id, projectID))
          .returning()
          .get()
        expect(updated?.worktree).toBe(moved)
        expect(updated?.sandboxes).toEqual([moved])
        expect(
          yield* db.get<{ worktree: string; sandboxes: string }>(
            sql`SELECT worktree, sandboxes FROM project WHERE id = ${projectID}`,
          ),
        ).toEqual({ worktree: "D:/Moved/Thing", sandboxes: JSON.stringify(["D:/Moved/Thing"]) })
        expect(
          (yield* db
            .select()
            .from(ProjectTable)
            .where(inArray(ProjectTable.worktree, [moved]))
            .get())?.id,
        ).toBe(projectID)

        yield* db.run(sql`UPDATE project SET worktree = ${"not-absolute"} WHERE id = ${projectID}`)
        expect(() =>
          Effect.runSync(db.select().from(ProjectTable).where(eq(ProjectTable.id, projectID)).get()),
        ).toThrow()
      }),
    )
  })

  test("imports existing drizzle migration state", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(
          sql`CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric, name text, applied_at TEXT)`,
        )
        yield* db.run(sql`
          INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at)
          VALUES ('hash', 1, '20260127222353_familiar_lady_ursula', ${new Date().toISOString()})
        `)

        yield* DatabaseMigration.applyOnly(db, [])

        expect(yield* db.get(sql`SELECT id FROM migration`)).toEqual({ id: "20260127222353_familiar_lady_ursula" })
      }),
    )
  })

  test("does not replay a migrated session metadata column", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, metadata text)`)
        yield* db.run(
          sql`CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric, name text, applied_at TEXT)`,
        )
        yield* db.run(sql`
          INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at)
          VALUES ('hash', 1, '20260511173437_session-metadata', ${new Date().toISOString()})
        `)

        yield* DatabaseMigration.applyOnly(db, [sessionMetadataMigration])

        expect(yield* db.all(sql`SELECT id FROM migration`)).toEqual([{ id: "20260511173437_session-metadata" }])
      }),
    )
  })

  test("accepts the temporary replacement session metadata migration id", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, metadata text)`)
        yield* db.run(sql`CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`)
        yield* db.run(sql`INSERT INTO migration (id, time_completed) VALUES ('20260530232709_lovely_romulus', 1)`)

        yield* DatabaseMigration.applyOnly(db, [sessionMetadataMigration])

        expect(yield* db.all(sql`SELECT id FROM migration ORDER BY id`)).toEqual([
          { id: "20260511173437_session-metadata" },
          { id: "20260530232709_lovely_romulus" },
        ])
      }),
    )
  })

  test("skips drizzle import when migration table already has state", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`)
        yield* db.run(sql`INSERT INTO migration (id, time_completed) VALUES ('existing', 1)`)
        yield* db.run(
          sql`CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric, name text, applied_at TEXT)`,
        )
        yield* db.run(sql`
          INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at)
          VALUES ('hash', 1, '20260127222353_familiar_lady_ursula', ${new Date().toISOString()})
        `)

        yield* DatabaseMigration.applyOnly(db, [])

        expect(yield* db.all(sql`SELECT id FROM migration ORDER BY id`)).toEqual([{ id: "existing" }])
      }),
    )
  })
})
