import { Database as Sqlite } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { EventV2 } from "../src/event"
import { Database as CoreDatabase } from "../src/database/database"
import { DateTime, Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { ModelV2 } from "../src/model"
import { ProviderV2 } from "../src/provider"
import { SessionArchive } from "../src/session-archive"
import { SessionEvent } from "../src/session/event"
import { SessionMessage } from "../src/session/message"
import { SessionProjector } from "../src/session/projector"
import { SessionSchema } from "../src/session/schema"
import { StorageActivation } from "../src/storage-activation"
import { StorageMigration } from "../src/storage-migration"

const roots: string[] = []

afterEach(async () => {
  Bun.gc(true)
  await Promise.all(roots.splice(0).map((root) => remove(root)))
})

describe("offline storage migration", () => {
  test("records projection-only project assignments before checkpoint replay", async () => {
    const fixture = await createFixture(false, false, true)
    const manifest = await StorageMigration.run(migrationOptions(fixture, fixture.staging))
    const candidate = new Sqlite(manifest.paths.candidateDatabase, { readonly: true, strict: true })
    try {
      expect(
        candidate
          .query<{ readonly current_seq: number; readonly checkpoint_seq: number }, []>(`
            SELECT es.seq AS current_seq, ec.seq AS checkpoint_seq
            FROM event_sequence es JOIN event_checkpoint ec ON ec.aggregate_id = es.aggregate_id
            WHERE es.aggregate_id = 'ses_storage_recent'
          `)
          .get(),
      ).toEqual({ current_seq: 1, checkpoint_seq: 1 })
      const checkpoint = candidate
        .query<{ readonly data: string }, []>(
          "SELECT data FROM event_checkpoint WHERE aggregate_id = 'ses_storage_recent'",
        )
        .get()
      const baseline = EventV2.readStoredCheckpointBaseline(JSON.parse(checkpoint!.data) as Record<string, unknown>)
      expect((baseline.data.session as { readonly project_id: string }).project_id).toBe("storage-reassigned-project")
      expect(baseline.data).toMatchObject({
        legacyMessages: [],
        legacyParts: [],
        messages: [],
      })
    } finally {
      candidate.close()
    }
  }, 60_000)

  test("upgrades legacy activity failures only when their synthetic assistant projection exists", async () => {
    const fixture = await createFixture(false, true)
    const manifest = await StorageMigration.run(migrationOptions(fixture, fixture.staging))
    const candidate = new Sqlite(manifest.paths.candidateDatabase, { readonly: true, strict: true })
    try {
      expect(
        candidate
          .query<{ readonly version: number }, []>(
            "SELECT version FROM event_checkpoint WHERE aggregate_id = 'ses_storage_recent'",
          )
          .get()?.version,
      ).toBe(EventV2.CheckpointVersion)
      expect(
        candidate
          .query<{ readonly type: string }, []>(`
            SELECT type FROM session_message
            WHERE session_id = 'ses_storage_recent' AND id = 'msg_activity_failure_activity-storage-legacy-failure'
          `)
          .get()?.type,
      ).toBe("assistant")
    } finally {
      candidate.close()
    }
  }, 60_000)

  test("materializes a historically unprojected custom event exactly once before checkpointing", async () => {
    const fixture = await createFixture(false, true)
    const source = new Sqlite(fixture.source, { strict: true })
    const partID = "prt_storage_missing_custom"
    let messageID = ""
    try {
      messageID = source
        .query<{ readonly id: string }, []>(`
          SELECT id FROM session_message
          WHERE session_id = 'ses_storage_recent' AND type = 'assistant'
          ORDER BY seq DESC LIMIT 1
        `)
        .get()!.id
      const next = Number(
        source.query<{ readonly seq: number }, []>(
          "SELECT seq FROM event_sequence WHERE aggregate_id = 'ses_storage_recent'",
        ).get()!.seq,
      ) + 1
      source.run("UPDATE event_sequence SET seq = ? WHERE aggregate_id = 'ses_storage_recent'", [next])
      source.run("INSERT INTO event(id, aggregate_id, seq, type, data) VALUES (?, ?, ?, ?, ?)", [
        "evt_storage_missing_custom",
        "ses_storage_recent",
        next,
        EventV2.versionedType(SessionEvent.Custom.Added.type, 1),
        JSON.stringify({
          sessionID: "ses_storage_recent",
          timestamp: 9_001,
          assistantMessageID: messageID,
          partID,
          kind: "opencode/control-panel",
          data: { version: 1, controlID: "storage-repair" },
          title: "Storage repair",
          fallback: "Storage repair fallback",
          metadata: { source: "test" },
          time: { start: 9_001, end: 9_002 },
        }),
      ])
      source.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE")
    } finally {
      source.close()
    }
    const sourceBefore = await Bun.file(fixture.source).arrayBuffer()
    const manifest = await StorageMigration.run({
      ...migrationOptions(fixture, fixture.staging),
      sessionWorker: async (filename) => {
        await StorageMigration.runSessionWorker(filename)
        await StorageMigration.runSessionWorker(filename)
      },
    })

    expect(await Bun.file(fixture.source).arrayBuffer()).toEqual(sourceBefore)
    const candidate = new Sqlite(manifest.paths.candidateDatabase, { readonly: true, strict: true })
    try {
      const message = candidate
        .query<{ readonly data: string }, [string]>(
          "SELECT data FROM session_message WHERE session_id='ses_storage_recent' AND id=?",
        )
        .get(messageID)
      const content = (JSON.parse(message!.data) as { readonly content: ReadonlyArray<Record<string, unknown>> }).content
      expect(content.filter((item) => item.id === partID)).toEqual([
        {
          type: "custom",
          id: partID,
          kind: "opencode/control-panel",
          data: { version: 1, controlID: "storage-repair" },
          title: "Storage repair",
          fallback: "Storage repair fallback",
          metadata: { source: "test" },
          time: { start: 9_001, end: 9_002 },
        },
      ])
      const checkpoint = candidate
        .query<{ readonly data: string }, []>(
          "SELECT data FROM event_checkpoint WHERE aggregate_id='ses_storage_recent'",
        )
        .get()
      const baseline = EventV2.readStoredCheckpointBaseline(JSON.parse(checkpoint!.data) as Record<string, unknown>)
      expect(baseline.data).toMatchObject({
        legacyMessages: [],
        legacyParts: [],
        messages: [],
        legacyProjectionReference: {
          checkpointSeq: expect.any(Number),
          legacyMessageCount: expect.any(Number),
          legacyPartCount: expect.any(Number),
          messageCount: expect.any(Number),
          projectionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      })
    } finally {
      candidate.close()
    }
  }, 120_000)

  test("accepts projected custom content with omitted optional JSON fields", async () => {
    const fixture = await createFixture(false, false)
    const partID = "prt_storage_existing_custom"
    const messageID = SessionMessage.ID.make("msg_storage_existing_custom")
    const sessionID = SessionSchema.ID.make("ses_storage_recent")
    const database = CoreDatabase.layerFromPath(fixture.source)
    const events = EventV2.layer.pipe(Layer.provide(database))
    const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* EventV2.Service
        yield* service.publish(SessionEvent.Step.Started, {
          sessionID,
          timestamp: DateTime.makeUnsafe(9_003),
          assistantMessageID: messageID,
          agent: "build",
          model: { id: ModelV2.ID.make("storage-model"), providerID: ProviderV2.ID.make("storage-provider") },
        })
        yield* service.publish(SessionEvent.Custom.Added, {
          sessionID,
          timestamp: DateTime.makeUnsafe(9_004),
          assistantMessageID: messageID,
          partID,
          kind: "octto/question",
          data: { question: "Proceed?" },
          title: "Storage question",
          fallback: "Proceed?",
        })
      }).pipe(Effect.provide(Layer.mergeAll(database, events, projector)), Effect.scoped),
    )
    Bun.gc(true)
    await Bun.sleep(100)
    const source = new Sqlite(fixture.source, { strict: true })
    try {
      source.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE")
    } finally {
      source.close()
    }

    const manifest = await StorageMigration.run(migrationOptions(fixture, fixture.staging))
    const candidate = new Sqlite(manifest.paths.candidateDatabase, { readonly: true, strict: true })
    try {
      const message = candidate
        .query<{ readonly data: string }, [string]>(
          "SELECT data FROM session_message WHERE session_id='ses_storage_recent' AND id=?",
        )
        .get(messageID)
      const content = (JSON.parse(message!.data) as { readonly content: ReadonlyArray<Record<string, unknown>> }).content
      expect(content.filter((item) => item.id === partID)).toHaveLength(1)
      expect(
        candidate
          .query<{ readonly version: number }, []>(
            "SELECT version FROM event_checkpoint WHERE aggregate_id='ses_storage_recent'",
          )
          .get()?.version,
      ).toBe(EventV2.CheckpointVersion)
    } finally {
      candidate.close()
    }
  }, 60_000)

  test("checkpoints session baselines across bounded keyset batches", async () => {
    const fixture = await createFixture()
    const source = new Sqlite(fixture.source, { strict: true })
    try {
      const session = source.query<Record<string, string | number | bigint | Uint8Array | null>, []>(
        "SELECT * FROM session WHERE id = 'ses_storage_recent'",
      ).get()
      const event = source.query<
        { readonly seq: number; readonly type: string; readonly data: string },
        []
      >("SELECT seq, type, data FROM event WHERE aggregate_id = 'ses_storage_recent' ORDER BY seq LIMIT 1").get()
      if (!session || !event) throw new Error("Expected recent session seed")
      const columns = Object.keys(session)
      const insertSession = source.prepare(
        `INSERT INTO session (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      )
      const insertEvent = source.prepare(
        "INSERT INTO event(id, aggregate_id, seq, type, data) VALUES (?, ?, ?, ?, ?)",
      )
      source.transaction(() => {
        Array.from({ length: 70 }, (_, index) => `ses_storage_batch_${String(index).padStart(3, "0")}`).forEach(
          (sessionID, index) => {
            insertSession.run(
              ...columns.map((column) => {
                const value = session[column]
                return typeof value === "string" ? value.replaceAll("ses_storage_recent", sessionID) : value
              }),
            )
            source.run("INSERT INTO event_sequence(aggregate_id, seq) VALUES (?, ?)", [sessionID, event.seq])
            insertEvent.run(
              `evt_storage_batch_${index}`,
              sessionID,
              event.seq,
              event.type,
              event.data.replaceAll("ses_storage_recent", sessionID),
            )
          },
        )
      })()
      source.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE")
    } finally {
      source.close()
    }

    const manifest = await StorageMigration.run(migrationOptions(fixture, fixture.staging))
    const candidate = new Sqlite(manifest.paths.candidateDatabase, { readonly: true, strict: true })
    try {
      expect(
        candidate.query<{ readonly count: number }, []>(`
          SELECT count(*) AS count FROM event_checkpoint
          WHERE aggregate_id LIKE 'ses_storage_batch_%' AND version = ${EventV2.CheckpointVersion}
        `).get()?.count,
      ).toBe(70)
    } finally {
      candidate.close()
    }
  }, 120_000)

  test("compacts checkpoints, archives only inactive sessions, prepares without activation, and resumes", async () => {
    const fixture = await createFixture()
    const sourceBefore = await Bun.file(fixture.source).arrayBuffer()
    const progress: StorageMigration.Progress[] = []
    let workerCalls = 0
    const options = {
      mode: "prepare" as const,
      databaseKind: "production" as const,
      sourceDatabase: fixture.source,
      stagingDirectory: fixture.staging,
      liveBlobDirectory: fixture.liveContent,
      liveArchiveDirectory: fixture.liveArchives,
      inactiveMs: 7 * 24 * 60 * 60 * 1_000,
      maxShardBytes: 256 * 1024,
      onProgress: (event: StorageMigration.Progress) => {
        progress.push(event)
      },
      sessionWorker: async (filename: string) => {
        workerCalls += 1
        await StorageMigration.runSessionWorker(filename)
      },
    }

    const manifest = await StorageMigration.run(options)

    expect(manifest.status).toBe("complete")
    expect(manifest.activationManifest?.databaseKind).toBe("production")
    expect(manifest.report?.archivedSessions).toBe(2)
    expect(manifest.report?.activeSessions).toBe(1)
    expect(manifest.report?.checkpointedSessions).toBe(2)
    expect(progress.some((entry) => entry.message.includes("not activated"))).toBeTrue()
    expect(workerCalls).toBe(1)
    expect(await Bun.file(fixture.source).arrayBuffer()).toEqual(sourceBefore)

    const candidate = new Sqlite(manifest.paths.candidateDatabase, { readonly: true, strict: true })
    try {
      expect(candidate.query<{ readonly count: number }, []>("SELECT count(*) AS count FROM session").get()?.count).toBe(1)
      expect(
        candidate
          .query<{ readonly count: number }, []>(
            "SELECT count(*) AS count FROM session_archive_catalog WHERE location='archived'",
          )
          .get()?.count,
      ).toBe(2)
      const shard = candidate.query<{ readonly path: string }, []>("SELECT path FROM session_archive_shard").get()
      expect(shard?.path.startsWith(fixture.liveArchives)).toBeTrue()
      expect(
        candidate.query<{ readonly count: number }, []>(
          "SELECT count(*) AS count FROM sqlite_master WHERE name LIKE '_content_migration_%'",
        ).get()?.count,
      ).toBe(0)
    } finally {
      candidate.close()
    }
    const archivedLegacy = (await archiveNames(manifest.paths.candidateArchiveDirectory)).reduce(
      (total, name) => {
        const shard = new Sqlite(path.join(manifest.paths.candidateArchiveDirectory, name), { readonly: true, strict: true })
        try {
          return {
            messages: total.messages + Number(shard.query<{ count: number }, []>(
              "SELECT count(*) AS count FROM archive_legacy_message",
            ).get()?.count ?? 0),
            parts: total.parts + Number(shard.query<{ count: number }, []>(
              "SELECT count(*) AS count FROM archive_legacy_part",
            ).get()?.count ?? 0),
            markers: total.markers + Number(shard.query<{ count: number }, []>(
              "SELECT count(*) AS count FROM archive_session_section WHERE section_name='legacy_projection_checkpoint'",
            ).get()?.count ?? 0),
            embeddedMessages: total.embeddedMessages + shard
              .query<{ data_json: string }, []>(`
                SELECT checkpoint.data_json FROM archive_session_section checkpoint
                JOIN archive_session_section marker
                  ON marker.session_id = checkpoint.session_id AND marker.revision = checkpoint.revision
                WHERE checkpoint.section_name='event_checkpoint'
                  AND marker.section_name='legacy_projection_checkpoint'
              `)
              .all()
              .reduce((count, row) => {
                const checkpoint = JSON.parse(row.data_json) as { data: string }
                const baseline = EventV2.readStoredCheckpointBaseline(
                  JSON.parse(checkpoint.data) as Record<string, unknown>,
                )
                return count + (Array.isArray(baseline.data.legacyMessages) ? baseline.data.legacyMessages.length : -1)
              }, 0),
          }
        } finally {
          shard.close()
        }
      },
      { messages: 0, parts: 0, markers: 0, embeddedMessages: 0 },
    )
    expect(archivedLegacy).toEqual({ messages: 1, parts: 1, markers: 1, embeddedMessages: 0 })

    const resumed = await StorageMigration.run(options)
    expect(resumed.updatedAt).toBe(manifest.updatedAt)
    expect(resumed.activationManifest?.id).toBe(manifest.activationManifest?.id)
    expect(await Bun.file(fixture.source).arrayBuffer()).toEqual(sourceBefore)
  }, 60_000)

  test("preserves event identities and removes only checkpoint-covered prefixes", async () => {
    const fixture = await createFixture()
    const retainedEvent = {
      id: "evt_storage_identity",
      aggregate_id: "aggregate_storage_identity",
      seq: 17,
    }
    const original = (() => {
      const source = new Sqlite(fixture.source, { strict: true })
      try {
        source.run("INSERT INTO event_sequence(aggregate_id, seq) VALUES (?, ?)", [
          retainedEvent.aggregate_id,
          retainedEvent.seq,
        ])
        source.run("INSERT INTO event(id, aggregate_id, seq, type, data) VALUES (?, ?, ?, ?, ?)", [
          retainedEvent.id,
          retainedEvent.aggregate_id,
          retainedEvent.seq,
          "storage.identity.1",
          JSON.stringify({ value: "unchanged" }),
        ])
        source.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE")
        return source
          .query<{ readonly id: string; readonly aggregate_id: string; readonly seq: number }, []>(
            "SELECT id, aggregate_id, seq FROM event ORDER BY aggregate_id, seq",
          )
          .all()
      } finally {
        source.close()
      }
    })()

    const manifest = await StorageMigration.run(migrationOptions(fixture, fixture.staging))
    const retained = new Map<string, { readonly id: string; readonly aggregate_id: string; readonly seq: number }>()
    const coverage = new Map<string, number>()
    const candidate = new Sqlite(manifest.paths.candidateDatabase, { readonly: true, strict: true })
    try {
      candidate
        .query<{ readonly id: string; readonly aggregate_id: string; readonly seq: number }, []>(
          "SELECT id, aggregate_id, seq FROM event ORDER BY aggregate_id, seq",
        )
        .all()
        .forEach((event) => retained.set(event.id, event))
      candidate
        .query<{ readonly aggregate_id: string; readonly seq: number }, []>(
          "SELECT aggregate_id, seq FROM event_checkpoint",
        )
        .all()
        .forEach((checkpoint) => coverage.set(checkpoint.aggregate_id, checkpoint.seq))
    } finally {
      candidate.close()
    }

    for (const name of await archiveNames(manifest.paths.candidateArchiveDirectory)) {
      const shard = new Sqlite(path.join(manifest.paths.candidateArchiveDirectory, name), {
        readonly: true,
        strict: true,
      })
      try {
        shard
          .query<{ readonly section_name: string; readonly data_json: string }, []>(`
            SELECT section_name, data_json FROM archive_session_section
            WHERE section_name IN ('event', 'event_checkpoint')
            ORDER BY session_id, revision, section_name, ordinal
          `)
          .all()
          .forEach((section) => {
            const row = JSON.parse(section.data_json) as Record<string, unknown>
            if (section.section_name === "event") {
              const event = {
                id: String(row.id),
                aggregate_id: String(row.aggregate_id),
                seq: Number(row.seq),
              }
              expect(retained.has(event.id)).toBeFalse()
              retained.set(event.id, event)
              return
            }
            coverage.set(String(row.aggregate_id), Number(row.seq))
          })
      } finally {
        shard.close()
      }
    }

    for (const event of original) {
      const migrated = retained.get(event.id)
      if (migrated) {
        expect(migrated).toEqual(event)
        continue
      }
      expect(coverage.get(event.aggregate_id)).toBeGreaterThanOrEqual(event.seq)
    }
    expect(retained.get(retainedEvent.id)).toEqual(retainedEvent)
    expect(coverage.has("ses_storage_recent")).toBeTrue()
    expect(coverage.has("ses_storage_old")).toBeTrue()
  }, 60_000)

  test("finalizes quarantined dry runs while prepare requires report-bound approval", async () => {
    const fixture = await createFixture(true)
    const options = {
      mode: "dry-run" as const,
      databaseKind: "production" as const,
      sourceDatabase: fixture.source,
      stagingDirectory: fixture.staging,
      liveBlobDirectory: fixture.liveContent,
      liveArchiveDirectory: fixture.liveArchives,
      inactiveMs: 7 * 24 * 60 * 60 * 1_000,
    }

    const dryRun = await StorageMigration.run(options)
    const requirement = await Bun.file(path.join(fixture.staging, "quarantine-required.json")).json()
    expect(dryRun.status).toBe("complete")
    expect(dryRun.report?.quarantineCount).toBe(1)
    expect(requirement.count).toBe(1)
    expect(await Bun.file(path.join(fixture.staging, "storage-activation-manifest.json")).exists()).toBeFalse()
    const candidate = new Sqlite(dryRun.paths.candidateDatabase, { readonly: true, strict: true })
    try {
      expect(
        candidate.query<{ readonly count: number }, []>(
          "SELECT count(*) AS count FROM sqlite_master WHERE name LIKE '_content_migration_%'",
        ).get()?.count,
      ).toBe(0)
    } finally {
      candidate.close()
    }
    if (!dryRun.report) throw new Error("Expected a completed dry-run report")
    expect(dryRun.report.activeDatabaseBytes).toBe(Bun.file(dryRun.paths.candidateDatabase).size)
    expect(dryRun.report.candidateBytes).toBe(
      dryRun.report.activeDatabaseBytes + dryRun.report.archiveBytes + dryRun.report.blobBytes,
    )

    const prepareOptions = {
      ...options,
      mode: "prepare" as const,
      stagingDirectory: path.join(fixture.root, "prepare-staging"),
      expectedDryRun: { savedBytes: dryRun.report.savedBytes },
    }
    await expect(StorageMigration.run(prepareOptions)).rejects.toMatchObject({ code: "quarantine" })
    const prepareRequirement = await Bun.file(
      path.join(prepareOptions.stagingDirectory, "quarantine-required.json"),
    ).json()
    await expect(
      StorageMigration.run({
        ...prepareOptions,
        quarantineApproval: {
          reportSha256: "0".repeat(64),
          approvedBy: "migration-test",
          reason: "Reviewed invalid fixture",
          reviewedAt: Date.now(),
        },
      }),
    ).rejects.toMatchObject({ code: "quarantine" })

    const prepared = await StorageMigration.run({
      ...prepareOptions,
      quarantineApproval: {
        reportSha256: prepareRequirement.reportSha256,
        approvedBy: "migration-test",
        reason: "Reviewed invalid fixture",
        reviewedAt: Date.now(),
      },
    })
    if (!prepared.report) throw new Error("Expected a completed prepare report")
    expect(prepared.status).toBe("complete")
    expect(prepared.report.quarantineCount).toBe(1)
    expect(prepared.activationManifest).toBeDefined()
    expect(
      dryRun.report.savedBytes === 0
        ? Math.abs(prepared.report.savedBytes)
        : Math.abs(prepared.report.savedBytes - dryRun.report.savedBytes) / Math.abs(dryRun.report.savedBytes),
    ).toBeLessThanOrEqual(0.1)
  }, 120_000)

  test("dry-runs from a consistent live-WAL snapshot while prepare remains offline-only", async () => {
    const fixture = await createFixture()
    const live = new Sqlite(fixture.source, { strict: true })
    try {
      live.exec(`
        PRAGMA journal_mode=WAL;
        CREATE TABLE live_marker (value TEXT NOT NULL);
        INSERT INTO live_marker VALUES ('unchanged-source');
      `)
      expect((await Bun.file(`${fixture.source}-wal`).exists()) && Bun.file(`${fixture.source}-wal`).size > 0).toBeTrue()

      const dryRun = await StorageMigration.run({
        mode: "dry-run",
        databaseKind: "production",
        sourceDatabase: fixture.source,
        stagingDirectory: fixture.staging,
        dryRunSnapshotDirectory: path.join(fixture.root, "isolated-snapshot"),
        liveBlobDirectory: fixture.liveContent,
        liveArchiveDirectory: fixture.liveArchives,
        inactiveMs: 7 * 24 * 60 * 60 * 1_000,
      })
      expect(dryRun.status).toBe("complete")
      expect(dryRun.paths.sourceSnapshotDirectory).toBe(path.join(fixture.root, "isolated-snapshot"))
      expect(dryRun.activationManifest).toBeUndefined()
      expect(await Bun.file(path.join(fixture.staging, "storage-activation-manifest.json")).exists()).toBeFalse()
      expect(live.query<{ readonly value: string }, []>("SELECT value FROM live_marker").get()?.value).toBe(
        "unchanged-source",
      )

      await expect(
        StorageMigration.run({
          mode: "prepare",
          databaseKind: "production",
          sourceDatabase: fixture.source,
          stagingDirectory: path.join(fixture.root, "prepare-staging"),
          liveBlobDirectory: path.join(fixture.root, "prepare-live", "content"),
          liveArchiveDirectory: path.join(fixture.root, "prepare-live", "archives"),
          inactiveMs: 7 * 24 * 60 * 60 * 1_000,
        }),
      ).rejects.toMatchObject({ code: "content" })
    } finally {
      live.close()
    }
  }, 60_000)

  test("enforces the ten percent dry-run savings gate before activation preparation", async () => {
    const fixture = await createFixture()
    await expect(
      StorageMigration.run({
        mode: "prepare",
        databaseKind: "production",
        sourceDatabase: fixture.source,
        stagingDirectory: fixture.staging,
        liveBlobDirectory: fixture.liveContent,
        liveArchiveDirectory: fixture.liveArchives,
        inactiveMs: 7 * 24 * 60 * 60 * 1_000,
        expectedDryRun: { savedBytes: Number.MAX_SAFE_INTEGER },
      }),
    ).rejects.toMatchObject({ code: "savings" })
    expect(await Bun.file(path.join(fixture.staging, "storage-activation-manifest.json")).exists()).toBeFalse()
  }, 60_000)

  test("rejects old outer journals and incompatible content engine manifests before resume", async () => {
    const fixture = await createFixture()
    const options = {
      ...migrationOptions(fixture, fixture.staging),
      mode: "dry-run" as const,
      dryRunSnapshotDirectory: path.join(fixture.root, "resume-version-snapshot"),
      maxRows: 1,
    }
    await expect(StorageMigration.run(options)).rejects.toMatchObject({ code: "content" })
    const journalPath = path.join(fixture.staging, "storage-migration-journal.json")
    const journal = await Bun.file(journalPath).json()
    const content = await Bun.file(path.join(fixture.staging, "content-migration-manifest.json")).json()
    await Bun.write(journalPath, JSON.stringify({ ...journal, version: 2, phase: "content-migrated" }))

    await expect(StorageMigration.run({ ...options, maxRows: undefined })).rejects.toMatchObject({ code: "journal" })
    await Bun.write(
      journalPath,
      JSON.stringify({
        ...journal,
        version: 3,
        phase: "content-migrated",
        contentManifest: { ...content, engineVersion: 3 },
      }),
    )
    await expect(StorageMigration.run({ ...options, maxRows: undefined })).rejects.toMatchObject({ code: "journal" })
  }, 60_000)

  test("forwards repeated content checkpoints through storage migration progress", async () => {
    const fixture = await createFixture()
    const progress: StorageMigration.Progress[] = []
    await StorageMigration.run({
      ...migrationOptions(fixture, fixture.staging),
      batchSize: 1,
      onProgress: (event) => {
        progress.push(event)
      },
    })

    const content = progress.filter((event) => event.content?.state === "checkpointed")
    expect(content.length).toBeGreaterThan(1)
    expect(content.every((event) => event.message.includes("Content migration"))).toBeTrue()
    expect(content.map((event) => event.content!.rowsScanned)).toEqual(
      [...content].map((event) => event.content!.rowsScanned).sort((a, b) => a - b),
    )
  }, 60_000)

  test("preflights candidate compaction and resumes after an incomplete compact file", async () => {
    const fixture = await createFixture()
    const options = {
      ...migrationOptions(fixture, fixture.staging),
      mode: "dry-run" as const,
      dryRunSnapshotDirectory: path.join(fixture.root, "compaction-source-snapshot"),
    }
    const sourceHash = createHash("sha256").update(await Bun.file(fixture.source).bytes()).digest("hex")
    await expect(
      StorageMigration.run({
        ...options,
        testHooks: { candidateCompactionAvailableBytes: 64 * 1024 * 1024 },
      }),
    ).rejects.toMatchObject({ code: "integrity" })
    expect((await Bun.file(path.join(fixture.staging, "storage-migration-journal.json")).json()).phase).toBe(
      "finalizing",
    )
    expect(
      await Bun.file(path.join(fixture.root, "compaction-source-snapshot", "source-snapshot.db")).exists(),
    ).toBeFalse()
    expect(createHash("sha256").update(await Bun.file(fixture.source).bytes()).digest("hex")).toBe(sourceHash)

    const candidate = path.join(fixture.staging, "candidate.db")
    const database = new Sqlite(candidate, { strict: true })
    try {
      database.exec("CREATE TABLE _content_migration_compaction_test(payload BLOB)")
      database.run("INSERT INTO _content_migration_compaction_test(payload) VALUES (zeroblob(?))", [
        4 * 1024 * 1024,
      ])
      database.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE")
    } finally {
      database.close()
    }
    const bloatedBytes = Bun.file(candidate).size
    await Bun.write(`${candidate}.compacting`, "incomplete compact output")

    let interrupted = false
    await expect(
      StorageMigration.run({
        ...options,
        testHooks: {
          afterCandidateCompactionBackup: () => {
            if (interrupted) return
            interrupted = true
            throw new Error("interrupt candidate publication")
          },
        },
      }),
    ).rejects.toThrow("Candidate finalization failed")
    expect(await Bun.file(candidate).exists()).toBeTrue()
    expect(await Bun.file(`${candidate}.precompact`).exists()).toBeFalse()
    expect(await Bun.file(`${candidate}.compacting`).exists()).toBeFalse()

    const resumed = await StorageMigration.run(options)
    expect(resumed.status).toBe("complete")
    expect(Bun.file(candidate).size).toBeLessThan(bloatedBytes)
    expect(await Bun.file(`${candidate}.compacting`).exists()).toBeFalse()
    const compacted = new Sqlite(candidate, { readonly: true, strict: true })
    try {
      expect(
        compacted
          .query<{ readonly count: number }, []>(
            "SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name LIKE '_content_migration_%'",
          )
          .get()?.count,
      ).toBe(0)
      expect(compacted.query<Record<string, string>, []>("PRAGMA quick_check").get()).toEqual({
        quick_check: "ok",
      })
    } finally {
      compacted.close()
    }
  }, 60_000)

  test("reserves prepare space for both the candidate and compact output before staging", async () => {
    const fixture = await createFixture()
    const sourceBytes = Bun.file(fixture.source).size
    await expect(
      StorageMigration.run({
        ...migrationOptions(fixture, fixture.staging),
        testHooks: { initialMigrationAvailableBytes: sourceBytes + 512 * 1024 * 1024 },
      }),
    ).rejects.toMatchObject({ code: "configuration" })
    expect(await Bun.file(path.join(fixture.staging, "storage-migration-journal.json")).exists()).toBeFalse()
    expect(await Bun.file(path.join(fixture.staging, "candidate.db")).exists()).toBeFalse()
  }, 60_000)

  test("resumes archived content migration after every durable journal stage", async () => {
    for (const state of ["reactivated", "content-migrated", "rearchived"] as const) {
      const fixture = await createFixture()
      const initial = await StorageMigration.run(migrationOptions(fixture, fixture.staging))
      Bun.gc(true)
      await Bun.sleep(100)
      await StorageActivation.activate(activationOptions(initial))
      await seedArchivedEmbeddedContent(fixture, "resume-archive-output-".repeat(20_000))
      const stagingDirectory = path.join(fixture.root, `resume-${state}`)
      let interrupted = false
      const options = {
        ...migrationOptions(fixture, stagingDirectory),
        mode: "dry-run" as const,
        dryRunSnapshotDirectory: path.join(fixture.root, `resume-${state}-snapshot`),
        testHooks: {
          afterArchiveContentState: (current: typeof state) => {
            if (current !== state || interrupted) return
            interrupted = true
            throw new Error(`interrupt after ${state}`)
          },
        },
      }
      await expect(StorageMigration.run(options)).rejects.toThrow(`interrupt after ${state}`)
      expect(
        (await Bun.file(path.join(stagingDirectory, "archive-content-migration.json")).json()).state,
      ).toBe(state)
      const resumed = await StorageMigration.run({ ...options, testHooks: undefined })
      expect(resumed.status).toBe("complete")
      expect(resumed.report?.content.dataUrls).toBeGreaterThanOrEqual(1)
      expect(resumed.report?.content.structuredOutputs).toBeGreaterThanOrEqual(1)
      expect(
        (await Bun.file(path.join(stagingDirectory, "archive-content-migration.json")).json()).state,
      ).toBe("rearchived")
    }
  }, 120_000)

  test("includes archived attachment failures in the approval-bound quarantine report", async () => {
    const fixture = await createFixture()
    const initial = await StorageMigration.run(migrationOptions(fixture, fixture.staging))
    Bun.gc(true)
    await Bun.sleep(100)
    await StorageActivation.activate(activationOptions(initial))
    await seedArchivedEmbeddedContent(
      fixture,
      "small output",
      "data:image/png;base64,%%%%",
    )
    const stagingDirectory = path.join(fixture.root, "archive-quarantine")
    const dryRun = await StorageMigration.run({
      ...migrationOptions(fixture, stagingDirectory),
      mode: "dry-run",
      dryRunSnapshotDirectory: path.join(fixture.root, "archive-quarantine-snapshot"),
    })
    expect(dryRun.report?.quarantineCount).toBe(1)
    expect(dryRun.contentManifest?.quarantine).toEqual([
      expect.objectContaining({ table: "part", kind: "data", path: "$/image" }),
    ])
    const offline = new Sqlite(fixture.source, { strict: true })
    offline.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE")
    offline.close()
    Bun.gc(true)
    await Bun.sleep(200)
    await expect(
      StorageMigration.run({
        ...migrationOptions(fixture, path.join(fixture.root, "archive-quarantine-prepare")),
        expectedDryRun: { savedBytes: dryRun.report!.savedBytes },
      }),
    ).rejects.toMatchObject({ code: "quarantine" })
  }, 120_000)

  test("stages existing blobs and archive shards for dry-run reporting and candidate activation", async () => {
    const fixture = await createFixture()
    const initial = await StorageMigration.run(migrationOptions(fixture, fixture.staging))
    Bun.gc(true)
    await Bun.sleep(200)
    await StorageActivation.activate(activationOptions(initial))
    const archivedOutput = "archived-tool-output-".repeat(20_000)
    await seedArchivedEmbeddedContent(fixture, archivedOutput)

    const bytes = new TextEncoder().encode("existing-content-addressed-blob")
    const sha256 = createHash("sha256").update(bytes).digest("hex")
    const liveBlob = path.join(fixture.liveContent, sha256.slice(0, 2), sha256)
    await mkdir(path.dirname(liveBlob), { recursive: true })
    await Bun.write(liveBlob, bytes)
    const source = new Sqlite(fixture.source, { strict: true })
    try {
      source.run(
        "INSERT INTO content_blob(sha256, size_bytes, mime, storage_path, created_at) VALUES (?, ?, ?, ?, ?)",
        [sha256, bytes.byteLength, "text/plain", path.join("content", sha256.slice(0, 2), sha256), Date.now()],
      )
      source.run(
        "INSERT INTO attachment(id, session_id, mime, size_bytes, storage_path, blob_sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          "att_existing_storage",
          "ses_storage_recent",
          "text/plain",
          bytes.byteLength,
          path.join("content", sha256.slice(0, 2), sha256),
          sha256,
          Date.now(),
        ],
      )
      source.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE")
    } finally {
      source.close()
    }

    const liveArchiveBytes = (
      await Promise.all(
        (await readdir(fixture.liveArchives, { withFileTypes: true }))
          .filter((entry) => entry.isFile() && [".db", ".sqlite"].includes(path.extname(entry.name)))
          .map((entry) => Bun.file(path.join(fixture.liveArchives, entry.name)).size),
      )
    ).reduce((total, size) => total + size, 0)
    const originalArchiveHashes = await archiveHashes(fixture.liveArchives)
    const expectedSourceBytes = Bun.file(fixture.source).size + bytes.byteLength + liveArchiveBytes
    const dryRun = await StorageMigration.run({
      ...migrationOptions(fixture, path.join(fixture.root, "existing-dry-run")),
      mode: "dry-run",
      dryRunSnapshotDirectory: path.join(fixture.root, "existing-dry-run-snapshot"),
    })

    expect(dryRun.report?.sourceBytes).toBe(expectedSourceBytes)
    expect(dryRun.report?.blobBytes).toBeGreaterThan(bytes.byteLength + archivedOutput.length)
    expect(dryRun.report?.archiveBytes).toBeGreaterThan(0)
    expect(dryRun.report?.content.dataUrls).toBeGreaterThanOrEqual(1)
    expect(dryRun.report?.content.structuredOutputs).toBeGreaterThanOrEqual(1)
    expect(await archiveHashes(fixture.liveArchives)).toEqual(originalArchiveHashes)
    expect(await Bun.file(path.join(dryRun.paths.candidateBlobDirectory, sha256.slice(0, 2), sha256)).bytes()).toEqual(
      bytes,
    )
    const existingArchives = await archiveNames(fixture.liveArchives)
    expect(existingArchives).not.toEqual([])
    const archivedParts: Array<Record<string, unknown>> = []
    for (const filename of await archiveNames(dryRun.paths.candidateArchiveDirectory)) {
      const shard = new Sqlite(path.join(dryRun.paths.candidateArchiveDirectory, filename), {
        readonly: true,
        strict: true,
      })
      try {
        const rows = shard.query<{ readonly data_json: string }, []>("SELECT data_json FROM archive_legacy_part").all()
        archivedParts.push(
          ...rows.map((row) => {
            const outer = JSON.parse(row.data_json) as { readonly data: string }
            return JSON.parse(outer.data) as Record<string, unknown>
          }),
        )
      } finally {
        shard.close()
      }
    }
    expect(JSON.stringify(archivedParts)).not.toContain("data:image/png;base64")
    expect(JSON.stringify(archivedParts)).toContain('"type":"content-reference"')
    const archivedTool = archivedParts.find((part) => part.callID === "call_archived_content") as {
      readonly state: { readonly output: string }
    }
    expect(Buffer.byteLength(archivedTool.state.output, "utf8")).toBeLessThanOrEqual(50 * 1024)

    const prepared = await StorageMigration.run({
      ...migrationOptions(fixture, path.join(fixture.root, "existing-prepare")),
      expectedDryRun: { savedBytes: dryRun.report!.savedBytes },
    })
    if (!prepared.activationManifest) throw new Error("Expected a prepared activation manifest")
    expect(await archiveHashes(fixture.liveArchives)).toEqual(originalArchiveHashes)
    expect(prepared.activationManifest.referencedBlobs).toContain(sha256)
    expect(prepared.activationManifest.archives.length).toBeGreaterThan(0)
    expect((await StorageActivation.prepare(activationOptions(prepared))).id).toBe(prepared.activationManifest.id)
    await StorageActivation.activate(activationOptions(prepared))
    const page = await readArchivedLegacyPage(fixture, "ses_storage_old")
    expect(page.items).toHaveLength(1)
    const migrated = JSON.parse(String(page.items[0]!.parts[0]!.data)) as {
      readonly image: string
      readonly state: {
        readonly output: string
        readonly metadata: { readonly $opencode: { readonly output: { readonly uri: string } } }
      }
    }
    expect(migrated.image).toMatch(/^attachment:\/\/att_/)
    expect(Buffer.byteLength(migrated.state.output, "utf8")).toBeLessThanOrEqual(50 * 1024)
    expect(migrated.state.metadata.$opencode.output.uri).toMatch(/^attachment:\/\/att_/)
    const attachment = await readArchivedAttachment(
      fixture,
      "ses_storage_old",
      migrated.state.metadata.$opencode.output.uri.slice("attachment://".length),
    )
    expect(
      await Bun.file(path.join(fixture.liveContent, attachment.blobSha256.slice(0, 2), attachment.blobSha256)).text(),
    ).toBe(archivedOutput)
    await reactivateArchivedSession(fixture, "ses_storage_old")
    const reactivated = new Sqlite(fixture.source, { readonly: true, strict: true })
    try {
      const part = JSON.parse(
        reactivated.query<{ readonly data: string }, []>(
          "SELECT data FROM part WHERE session_id = 'ses_storage_old' AND id = 'prt_storage_legacy'",
        ).get()!.data,
      ) as typeof migrated
      expect(part.image).toBe(migrated.image)
      expect(part.state.metadata.$opencode.output.uri).toBe(migrated.state.metadata.$opencode.output.uri)
      expect(
        reactivated.query<{ readonly count: number }, [string]>(
          "SELECT count(*) AS count FROM attachment WHERE session_id = 'ses_storage_old' AND id = ?",
        ).get(migrated.state.metadata.$opencode.output.uri.slice("attachment://".length))?.count,
      ).toBe(1)
    } finally {
      reactivated.close()
    }
    expect(Object.entries(await archiveHashes(fixture.liveArchives))).toEqual(
      expect.arrayContaining(Object.entries(originalArchiveHashes)),
    )

    const active = new Sqlite(fixture.source, { readonly: true, strict: true })
    try {
      expect(
        active
          .query<{ readonly storage_path: string }, [string]>("SELECT storage_path FROM content_blob WHERE sha256 = ?")
          .get(sha256)?.storage_path,
      ).toBe(path.join("content", sha256.slice(0, 2), sha256))
      expect(
        active
          .query<{ readonly path: string }, []>("SELECT path FROM session_archive_shard ORDER BY id")
          .all()
          .every((row) => row.path.startsWith(fixture.liveArchives)),
      ).toBeTrue()
    } finally {
      active.close()
    }
    expect(await Bun.file(liveBlob).bytes()).toEqual(bytes)
  }, 120_000)

  test("migrates a worker-owned candidate when the parent defers startup repairs", async () => {
    const fixture = await createFixture()
    const previous = process.env.OPENCODE_DEFER_DB_STARTUP_REPAIRS
    process.env.OPENCODE_DEFER_DB_STARTUP_REPAIRS = "1"
    try {
      const manifest = await StorageMigration.run(migrationOptions(fixture, fixture.staging))
      expect(manifest.status).toBe("complete")
      const candidate = new Sqlite(manifest.paths.candidateDatabase, { readonly: true, strict: true })
      try {
        expect(
          candidate.query<{ readonly count: number }, []>("SELECT count(*) AS count FROM event").get()?.count,
        ).toBe(0)
      } finally {
        candidate.close()
      }
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_DEFER_DB_STARTUP_REPAIRS
      else process.env.OPENCODE_DEFER_DB_STARTUP_REPAIRS = previous
    }
  }, 60_000)
})

function migrationOptions(fixture: Awaited<ReturnType<typeof createFixture>>, stagingDirectory: string) {
  return {
    mode: "prepare" as const,
    databaseKind: "production" as const,
    sourceDatabase: fixture.source,
    stagingDirectory,
    liveBlobDirectory: fixture.liveContent,
    liveArchiveDirectory: fixture.liveArchives,
    inactiveMs: 7 * 24 * 60 * 60 * 1_000,
    maxShardBytes: 256 * 1024,
    sessionWorker: StorageMigration.runSessionWorker,
  }
}

function activationOptions(manifest: StorageMigration.Manifest) {
  return {
    databaseKind: "production" as const,
    sourceDatabase: manifest.paths.sourceDatabase,
    candidateDatabase: manifest.paths.candidateDatabase,
    candidateBlobDirectory: manifest.paths.candidateBlobDirectory,
    liveBlobDirectory: manifest.paths.liveBlobDirectory,
    candidateArchiveDirectory: manifest.paths.candidateArchiveDirectory,
    liveArchiveDirectory: manifest.paths.liveArchiveDirectory,
    stagingDirectory: manifest.paths.stagingDirectory,
    manifestPath: manifest.paths.activationManifestPath,
  }
}

async function archiveNames(directory: string) {
  return (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && [".db", ".sqlite"].includes(path.extname(entry.name)))
    .map((entry) => entry.name)
    .sort()
}

async function archiveHashes(directory: string) {
  return Object.fromEntries(
    await Promise.all(
      (await archiveNames(directory)).map(async (name) => [
        name,
        createHash("sha256").update(await Bun.file(path.join(directory, name)).bytes()).digest("hex"),
      ]),
    ),
  )
}

async function seedArchivedEmbeddedContent(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  output: string,
  image = "data:image/png;base64,aGVsbG8=",
) {
  const database = CoreDatabase.layerFromPath(fixture.source)
  const archive = SessionArchive.layer({
    directory: fixture.liveArchives,
    inactiveMs: 7 * 24 * 60 * 60 * 1_000,
    maxShardBytes: 256 * 1024,
    isIdle: () => Effect.succeed(true),
  }).pipe(Layer.provide(database))
  await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* SessionArchive.Service
      const { db } = yield* CoreDatabase.Service
      const sessionID = SessionSchema.ID.make("ses_storage_old")
      yield* service.initialize
      yield* service.ensureActive(sessionID)
      yield* db.run(sql`
        UPDATE part SET data = ${JSON.stringify({
          type: "tool",
          callID: "call_archived_content",
          tool: "read",
          image,
          state: {
            status: "completed",
            input: {},
            output,
            title: "Archived output",
            metadata: {},
            time: { start: 1, end: 2 },
          },
        })}
        WHERE session_id = 'ses_storage_old' AND id = 'prt_storage_legacy'
      `)
      const result = yield* service.archiveOne(sessionID)
      if (!result) return yield* Effect.die("Embedded archive fixture was not archived")
    }).pipe(Effect.provide(Layer.mergeAll(database, archive)), Effect.scoped),
  )
  Bun.gc(true)
  await Bun.sleep(200)
}

async function readArchivedLegacyPage(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  sessionID: string,
) {
  const database = CoreDatabase.layerFromPath(fixture.source)
  const archive = SessionArchive.layer({
    directory: fixture.liveArchives,
    inactiveMs: 7 * 24 * 60 * 60 * 1_000,
    maxShardBytes: 256 * 1024,
    isIdle: () => Effect.succeed(true),
  }).pipe(Layer.provide(database))
  return Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* SessionArchive.Service
      yield* service.initialize
      return yield* service.readLegacyMessages(SessionSchema.ID.make(sessionID), { limit: 1 })
    }).pipe(Effect.provide(Layer.mergeAll(database, archive)), Effect.scoped),
  )
}

async function readArchivedAttachment(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  sessionID: string,
  attachmentID: string,
) {
  const database = CoreDatabase.layerFromPath(fixture.source)
  const archive = SessionArchive.layer({
    directory: fixture.liveArchives,
    isIdle: () => Effect.succeed(true),
  }).pipe(Layer.provide(database))
  return Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* SessionArchive.Service
      yield* service.initialize
      return yield* service.readAttachment(SessionSchema.ID.make(sessionID), attachmentID)
    }).pipe(Effect.provide(Layer.mergeAll(database, archive)), Effect.scoped),
  )
}

async function reactivateArchivedSession(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  sessionID: string,
) {
  const database = CoreDatabase.layerFromPath(fixture.source)
  const archive = SessionArchive.layer({
    directory: fixture.liveArchives,
    isIdle: () => Effect.succeed(true),
  }).pipe(Layer.provide(database))
  await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* SessionArchive.Service
      yield* service.initialize
      const result = yield* service.ensureActive(SessionSchema.ID.make(sessionID))
      if (!result.reactivated) return yield* Effect.die("Expected archived session reactivation")
    }).pipe(Effect.provide(Layer.mergeAll(database, archive)), Effect.scoped),
  )
  Bun.gc(true)
  await Bun.sleep(100)
}

async function createFixture(quarantined = false, legacyActivityFailure = false, legacyProjectAssignment = false) {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-storage-migration-"))
  roots.push(root)
  const data = path.join(root, "data")
  const staging = path.join(root, "staging")
  const liveContent = path.join(root, "live", "content")
  const liveArchives = path.join(root, "live", "archives")
  await Promise.all([mkdir(data, { recursive: true }), mkdir(path.dirname(staging), { recursive: true })])
  const source = path.join(data, "opencode.db")
  const worker = Bun.spawn(
    [process.execPath, path.join(import.meta.dir, "fixture", "storage-migration-seed.ts"), source, root],
    {
      cwd: path.join(import.meta.dir, ".."),
      env: {
        ...process.env,
        OPENCODE_TEST_STORAGE_QUARANTINED: quarantined ? "1" : "0",
        OPENCODE_TEST_STORAGE_LEGACY_ACTIVITY_FAILURE: legacyActivityFailure ? "1" : "0",
        OPENCODE_TEST_STORAGE_LEGACY_PROJECT_ASSIGNMENT: legacyProjectAssignment ? "1" : "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const code = await worker.exited
  if (code !== 0)
    throw new Error(
      `Fixture seed failed (${code}): ${await new Response(worker.stderr).text()}${await new Response(worker.stdout).text()}`,
    )
  const sqlite = new Sqlite(source, { strict: true })
  try {
    if (quarantined) {
      const row = sqlite
        .query<{ readonly data: string }, []>(
          "SELECT data FROM event_checkpoint WHERE aggregate_id='quarantine_fixture'",
        )
        .get()
      if (!row?.data.includes("%%%%")) throw new Error("Quarantine fixture was not seeded")
    }
    sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE")
  } finally {
    sqlite.close()
  }
  return { root, source, staging, liveContent, liveArchives }
}

async function remove(directory: string, attempt = 0): Promise<void> {
  return rm(directory, { recursive: true, force: true }).catch(async (cause) => {
    if (!(cause instanceof globalThis.Error) || !("code" in cause) || cause.code !== "EBUSY" || attempt >= 20) throw cause
    await Bun.sleep(100)
    return remove(directory, attempt + 1)
  })
}
