import { describe, expect, test } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { SessionArchive } from "@opencode-ai/core/session-archive"
import { SessionArchiveMaintenance } from "@opencode-ai/core/session-archive-maintenance"
import { EventV2 } from "@opencode-ai/core/event"
import { Effect, Layer } from "effect"
import { mkdtemp, rm, stat } from "fs/promises"
import path from "path"
import os from "os"
import { locationQuestionProbeLayer, makeSessionArchiveServerLayer } from "../src/handlers"

describe("session archive server layer", () => {
  test("archives idle candidates while unrelated Sessions are busy and reports candidate deferral", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "opencode-server-archive-"))
    try {
      const database = Database.layerFromPath(path.join(root, "active.sqlite"))
      const archiveDirectory = path.join(root, "archives")
      const events = EventV2.layer.pipe(Layer.provide(database))
      const layer = makeSessionArchiveServerLayer(
        {
          directory: archiveDirectory,
          maintenanceInitialDelayMs: 60 * 60 * 1_000,
          maintenanceIntervalMs: 60 * 60 * 1_000,
        },
        locationQuestionProbeLayer.pipe(Layer.provide(database)),
      ).pipe(Layer.provide(events), Layer.provideMerge(database))

      await Effect.gen(function* () {
        const databaseService = yield* Database.Service
        const archive = yield* SessionArchive.Service
        const maintenance = yield* SessionArchiveMaintenance.Service

        expect((yield* Effect.tryPromise(() => stat(archiveDirectory)).pipe(Effect.orDie)).isDirectory()).toBe(true)
        expect(
          yield* databaseService.db.get<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_archive_catalog'",
          ),
        ).toEqual({ name: "session_archive_catalog" })
        expect(yield* maintenance.status).toMatchObject({ schedulerActive: true, phase: "waiting" })
        expect(yield* archive.listCatalog()).toMatchObject({ rows: [], hasMore: false })
        expect(yield* maintenance.runOnce).toEqual({ outcome: "idle", backlog: 0 })

        yield* databaseService.db.run(`
          INSERT INTO project(id, worktree, sandboxes, time_created, time_updated)
          VALUES ('global', 'C:/archive-test', '[]', 1, 1)
        `)
        yield* databaseService.db.run(`
          INSERT INTO session(id, project_id, slug, directory, title, version, time_created, time_updated)
          VALUES ('ses_archive_busy', 'global', 'busy', 'C:/archive-test', 'Busy', 'test', 1, 1)
        `)
        yield* databaseService.db.run(`
          INSERT INTO session(id, project_id, slug, directory, title, version, time_created, time_updated)
          VALUES ('ses_archive_idle', 'global', 'idle', 'C:/archive-test', 'Idle', 'test', 2, 2)
        `)
        yield* databaseService.db.run(`
          INSERT INTO session_activity(
            id, session_id, status, kind, recovery_attempts, time_created, time_updated
          ) VALUES ('activity_busy', 'ses_archive_busy', 'recovering', 'recovery', 0, 1, 1)
        `)
        expect(yield* maintenance.runOnce).toMatchObject({
          outcome: "archived",
          archives: [{ sessionID: "ses_archive_idle" }],
          backlog: 0,
        })
        expect(yield* databaseService.db.get("SELECT id FROM session WHERE id = 'ses_archive_idle'")).toBeUndefined()
        expect(yield* databaseService.db.get("SELECT id FROM session WHERE id = 'ses_archive_busy'")).toEqual({
          id: "ses_archive_busy",
        })
        yield* databaseService.db.run("DELETE FROM session_activity WHERE id = 'activity_busy'")

        yield* databaseService.db.run(`
          INSERT INTO background_job(id, type, status, delivery_status, time_created, time_updated)
          VALUES ('job_busy', 'test', 'running', 'pending', 1, 1)
        `)
        yield* databaseService.db.run(`
          INSERT INTO session_question(
            id, session_id, seq, state, request, detached, allow_concurrent, time_created, time_updated
          ) VALUES (
            'que_archive_busy', 'ses_archive_busy', 1, 'active',
            '{"id":"que_archive_busy","sessionID":"ses_archive_busy","questions":[{"question":"Review?"}],"detached":true}',
            1, 0, 1, 1
          )
        `)
        expect(yield* archive.archiveOne()).toBeUndefined()
        expect(yield* databaseService.db.get("SELECT id FROM session WHERE id = 'ses_archive_busy'")).toEqual({
          id: "ses_archive_busy",
        })
        expect(yield* maintenance.runOnce).toEqual({
          outcome: "deferred",
          backlog: 1,
          oldestEligibleAt: 1,
          deferredReason: "candidate-busy",
        })
        expect(yield* maintenance.status).toMatchObject({
          schedulerActive: true,
          runs: 3,
          idle: 1,
          deferred: 1,
          archived: 1,
          backlog: 1,
          oldestEligibleAt: 1,
          deferredReason: "candidate-busy",
        })

        yield* databaseService.db.run("DELETE FROM session_question WHERE id = 'que_archive_busy'")
        expect(yield* maintenance.runOnce).toMatchObject({
          outcome: "archived",
          archives: [{ sessionID: "ses_archive_busy" }],
        })
        expect(yield* databaseService.db.get("SELECT id FROM session WHERE id = 'ses_archive_busy'")).toBeUndefined()
      }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise)
    } finally {
      await remove(root)
    }
  })
})

async function remove(root: string, retries = 30): Promise<void> {
  try {
    await rm(root, { recursive: true, force: true })
  } catch (error) {
    if (retries === 0 || !error || typeof error !== "object" || !("code" in error) || error.code !== "EBUSY")
      throw error
    Bun.gc(true)
    await Bun.sleep(100)
    return remove(root, retries - 1)
  }
}
