import { describe, expect, test } from "bun:test"
import { and, eq, sql } from "drizzle-orm"
import { DateTime, Effect, Layer } from "effect"
import { mkdir, stat } from "fs/promises"
import path from "path"
import {
  SessionArchiveCatalogTable,
  SessionArchiveJournalTable,
  SessionArchiveShardTable,
} from "@opencode-ai/core/archive.sql"
import { BackgroundJobTable } from "@opencode-ai/core/background-job.sql"
import { ContentStore } from "@opencode-ai/core/content-store"
import { ContentGC } from "@opencode-ai/core/content-gc"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventCheckpointTable } from "@opencode-ai/core/event/sql"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { ModelV2 } from "@opencode-ai/core/model"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionArchive } from "@opencode-ai/core/session-archive"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import * as SessionProtection from "@opencode-ai/core/session/protection"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionActivityTable, SessionInputTable, SessionTable } from "@opencode-ai/core/session/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { tmpdir } from "./fixture/tmpdir"

const day = 24 * 60 * 60 * 1_000
const now = Date.UTC(2026, 6, 13, 12)

describe("SessionArchive", () => {
  test("refuses cold archival while orchestrator planning and ownership are not in the archive format", async () => {
    await using tmp = await tmpdir()
    const mainID = SessionSchema.ID.make("ses_archive_orchestrator")
    const childID = SessionSchema.ID.make("ses_archive_orchestrator_child")
    await run(path.join(tmp.path, "active.sqlite"), Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seedSession(db, mainID, now - 10 * day, 2)
      yield* seedSession(db, childID, now - 10 * day, 2)
      yield* db.run(sql`INSERT INTO session_orchestrator(main_session_id,time_created,time_updated) VALUES (${mainID},1,1)`)
      yield* db.run(sql`INSERT INTO session_orchestrator_task
        (id,main_session_id,request_id,origin_input_id,origin_user_message_id,goal,acceptance,resources,dependencies,workspace_mode,slot_claimed,child_session_id,time_created,time_updated)
        VALUES ('archive-held',${mainID},'retry-key',${`input_${mainID}_0`},${`msg_${mainID}_0`},'work','verified','["project:*"]','[]','mirror',1,${childID},1,1)`)
      yield* db.run("INSERT INTO session_orchestrator_reservation(directory,resource,task_id,time_created) VALUES ('/project','project:*','archive-held',1)")
      const archive = yield* SessionArchive.make({ directory: path.join(tmp.path, "archives"), now: () => now, isIdle: () => Effect.succeed(true) })
      yield* archive.initialize
      expect(yield* archive.archiveOne(mainID)).toBeUndefined()
      expect(yield* archive.archiveOne(childID)).toBeUndefined()
      expect(yield* db.get("SELECT request_id,slot_claimed FROM session_orchestrator_task WHERE id='archive-held'")).toEqual({ request_id: "retry-key", slot_claimed: 1 })
      expect(yield* db.get("SELECT task_id FROM session_orchestrator_reservation")).toEqual({ task_id: "archive-held" })
    }))
  })

  test("archives and pages more than 160 turns without reactivating on read", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "active.sqlite")
    const sessionID = SessionSchema.ID.make("ses_archive_long")

    await run(
      filename,
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* seedSession(db, sessionID, now - 10 * day, 170)
        const blobHash = "a".repeat(64)
        yield* db.run(sql`
          INSERT INTO content_blob(sha256, size_bytes, mime, storage_path, created_at)
          VALUES (${blobHash}, 4, 'image/png', 'content/aa/blob', ${now - 10 * day})
        `)
        yield* db.run(sql`
          INSERT INTO attachment(id, session_id, message_id, mime, filename, size_bytes, storage_path, blob_sha256, created_at)
          VALUES ('att_archive', ${sessionID}, 'msg_ses_archive_long_0', 'image/png', 'image.png', 4, 'content/aa/blob', ${blobHash}, ${now - 10 * day})
        `)
        yield* db.run(sql`INSERT INTO event_sequence(aggregate_id, seq) VALUES (${sessionID}, 2)`)
        yield* db.run(sql`
          INSERT INTO event_checkpoint(aggregate_id, seq, version, data, time_created)
          VALUES (${sessionID}, 1, 1, ${JSON.stringify({ sessionID, through: 1 })}, ${now - 10 * day})
        `)
        yield* Effect.forEach(
          range(0, 3),
          (seq) =>
            db.run(sql`
              INSERT INTO event(id, aggregate_id, seq, type, data)
              VALUES (${`evt_archive_${seq}`}, ${sessionID}, ${seq}, 'session.test', ${JSON.stringify({ sessionID, seq })})
            `),
          { discard: true },
        )
        yield* db.run(sql`
          INSERT INTO message(id, session_id, time_created, time_updated, data)
          VALUES ('legacy_message', ${sessionID}, ${now - 10 * day}, ${now - 10 * day}, '{}')
        `)
        yield* db.run(sql`
          INSERT INTO part(id, message_id, session_id, time_created, time_updated, data)
          VALUES ('legacy_part', 'legacy_message', ${sessionID}, ${now - 10 * day}, ${now - 10 * day}, '{}')
        `)
        const archive = yield* SessionArchive.make({
          directory: path.join(tmp.path, "archives"),
          maxShardBytes: 1_000,
          leaseMs: 100,
          now: () => now,
          isIdle: () => Effect.succeed(true),
        })
        yield* archive.initialize
        yield* archive.refreshCatalog()
        expect((yield* archive.readMessages(sessionID)).rows.map((row) => Number(row.seq))).toEqual(
          range(120, 170).toReversed(),
        )
        expect(yield* archive.readMessage(sessionID, `msg_${sessionID}_119`)).toMatchObject({ seq: 119 })
        expect(yield* archive.readAttachment(sessionID, "att_archive")).toMatchObject({ blobSha256: blobHash })
        expect(yield* archive.readEventReplay(sessionID)).toMatchObject({
          checkpoint: expect.objectContaining({ seq: 1 }),
          tail: [expect.objectContaining({ seq: 2 })],
        })
        expect((yield* archive.readInputs(sessionID)).rows.map((row) => Number(row.admitted_seq))).toEqual(
          range(120, 170).toReversed(),
        )

        const result = yield* archive.archiveOne(sessionID)
        expect(result?.revision).toBe(1)
        expect(result?.logicalBytes).toBeGreaterThan(1_000)
        expect(yield* db.get(sql`SELECT id FROM session WHERE id = ${sessionID}`)).toBeUndefined()
        expect(yield* db.get(sql`SELECT id FROM attachment WHERE session_id = ${sessionID}`)).toBeUndefined()
        expect(yield* db.get(sql`SELECT id FROM event WHERE aggregate_id = ${sessionID}`)).toBeUndefined()
        expect(yield* db.get(sql`SELECT sha256 FROM content_blob WHERE sha256 = ${blobHash}`)).toEqual({
          sha256: blobHash,
        })
        expect((yield* archive.listCatalog()).rows[0]).toMatchObject({
          sessionID,
          location: "archived",
          messageCount: 170,
          inputCount: 170,
          sessionData: expect.objectContaining({ id: sessionID, title: `Archive ${sessionID}` }),
        })
        expect(
          yield* db
            .select({
              path: SessionArchiveShardTable.path,
              size: SessionArchiveShardTable.size_bytes,
              state: SessionArchiveShardTable.state,
            })
            .from(SessionArchiveShardTable)
            .where(eq(SessionArchiveShardTable.id, result!.shardID))
            .get(),
        ).toMatchObject({ state: "sealed" })
        const storedShard = yield* db
          .select({ path: SessionArchiveShardTable.path, size: SessionArchiveShardTable.size_bytes })
          .from(SessionArchiveShardTable)
          .where(eq(SessionArchiveShardTable.id, result!.shardID))
          .get()
        const actualShardBytes = yield* Effect.tryPromise(async () => {
          const main = await stat(storedShard!.path)
          const wal = Bun.file(`${storedShard!.path}-wal`)
          return main.size + ((await wal.exists()) ? wal.size : 0)
        }).pipe(Effect.orDie)
        expect(storedShard!.size).toBe(actualShardBytes)
        expect(
          yield* Effect.tryPromise(async () => {
            const sqlite = await import("bun:sqlite")
            const database = new sqlite.Database(storedShard!.path, { readonly: true })
            const refs = database
              .query<{ blob_sha256: string }, []>("SELECT blob_sha256 FROM archive_attachment_ref")
              .all()
            database.close()
            return refs
          }).pipe(Effect.orDie),
        ).toEqual([{ blob_sha256: blobHash }])

        const catalogBeforeRead = yield* db
          .select({
            timeUpdated: SessionArchiveCatalogTable.time_updated,
            timeArchived: SessionArchiveCatalogTable.time_archived,
          })
          .from(SessionArchiveCatalogTable)
          .where(eq(SessionArchiveCatalogTable.session_id, sessionID))
          .get()
        expect(yield* archive.readLegacyMessages(sessionID)).toMatchObject({
          items: [
            {
              message: expect.objectContaining({ id: "legacy_message" }),
              parts: [expect.objectContaining({ id: "legacy_part", message_id: "legacy_message" })],
            },
          ],
          more: false,
        })
        expect(yield* archive.readLegacyMessage(sessionID, "legacy_message")).toMatchObject({
          message: expect.objectContaining({ id: "legacy_message" }),
          parts: [expect.objectContaining({ id: "legacy_part" })],
        })
        const newest = yield* archive.readMessages(sessionID)
        expect(newest.rows.map((row) => Number(row.seq))).toEqual(range(120, 170).toReversed())
        expect(newest.hasOlder).toBe(true)
        expect(newest.hasNewer).toBe(false)
        expect(newest).toMatchObject({ hasPrevious: false, hasNext: true })
        const older = yield* archive.readMessages(sessionID, {
          cursor: { messageID: String(newest.rows.at(-1)!.id), direction: "next" },
        })
        expect(older.rows.map((row) => Number(row.seq))).toEqual(range(70, 120).toReversed())
        expect(older.hasOlder).toBe(true)
        expect(older.hasNewer).toBe(true)
        const oldest = yield* archive.readMessages(sessionID, {
          cursor: { messageID: String(older.rows.at(-1)!.id), direction: "next" },
          limit: 100,
        })
        expect(oldest.rows.map((row) => Number(row.seq))).toEqual(range(0, 70).toReversed())
        expect(oldest.hasOlder).toBe(false)
        expect(oldest.hasNewer).toBe(true)
        expect(
          (yield* archive.readMessages(sessionID, {
            cursor: { messageID: String(newest.rows.at(-1)!.id), direction: "next" },
          })).rows,
        ).toEqual(older.rows)
        expect(
          (yield* archive.readMessages(sessionID, {
            cursor: { messageID: String(older.rows[0]!.id), direction: "previous" },
          })).rows.map((row) => Number(row.seq)),
        ).toEqual(range(120, 170).toReversed())
        expect((yield* archive.readMessages(sessionID, { order: "asc" })).rows.map((row) => Number(row.seq))).toEqual(
          range(0, 50),
        )
        expect(
          (yield* archive.readMessages(sessionID, {
            order: "asc",
            cursor: { messageID: `msg_${sessionID}_100`, direction: "previous" },
            limit: 3,
          })).rows.map((row) => Number(row.seq)),
        ).toEqual([97, 98, 99])
        expect(
          (yield* archive.readMessages(sessionID, {
            order: "asc",
            cursor: { messageID: `msg_${sessionID}_100`, direction: "next" },
            limit: 3,
          })).rows.map((row) => Number(row.seq)),
        ).toEqual([101, 102, 103])
        expect(
          (yield* archive.readMessages(sessionID, {
            order: "desc",
            cursor: { messageID: `msg_${sessionID}_100`, direction: "previous" },
            limit: 3,
          })).rows.map((row) => Number(row.seq)),
        ).toEqual([103, 102, 101])
        expect(
          (yield* archive.readMessages(sessionID, {
            order: "desc",
            cursor: { messageID: `msg_${sessionID}_100`, direction: "next" },
            limit: 3,
          })).rows.map((row) => Number(row.seq)),
        ).toEqual([99, 98, 97])
        expect(yield* archive.readMessage(sessionID, `msg_${sessionID}_119`)).toMatchObject({
          seq: 119,
          type: "assistant",
        })
        const target = yield* archive.resolveMessageTarget(sessionID, {
          messageID: `msg_${sessionID}_119`,
          before: 2,
          after: 2,
          order: "asc",
        })
        expect(target.rows.map((row) => Number(row.seq))).toEqual(range(117, 122))
        expect(target.targetIndex).toBe(2)
        expect(target).toMatchObject({ hasPrevious: true, hasNext: true })
        expect(target.rows[target.targetIndex]).toMatchObject({ id: `msg_${sessionID}_119`, type: "assistant" })
        const inputs = yield* archive.readInputs(sessionID)
        expect(inputs.rows.map((row) => Number(row.admitted_seq))).toEqual(range(120, 170).toReversed())
        expect(inputs).toMatchObject({ hasOlder: true, hasNewer: false })
        for (const [order, direction, expected] of [
          ["asc", "previous", [97, 98, 99]],
          ["asc", "next", [101, 102, 103]],
          ["desc", "previous", [103, 102, 101]],
          ["desc", "next", [99, 98, 97]],
        ] as const)
          expect(
            (yield* archive.readInputs(sessionID, {
              order,
              cursor: { inputID: `input_${sessionID}_100`, direction },
              limit: 3,
            })).rows.map((row) => Number(row.admitted_seq)),
          ).toEqual([...expected])
        expect(yield* archive.readAttachment(sessionID, "att_archive")).toMatchObject({
          attachmentID: "att_archive",
          blobSha256: blobHash,
          metadata: expect.objectContaining({ filename: "image.png" }),
        })
        expect(yield* archive.readEventReplay(sessionID)).toMatchObject({
          sequence: expect.objectContaining({ seq: 2 }),
          checkpoint: expect.objectContaining({ seq: 1, version: 1 }),
          tail: [expect.objectContaining({ id: "evt_archive_2", seq: 2 })],
          hasMore: false,
          nextSeq: 2,
        })
        expect(yield* archive.getCatalog(sessionID)).toMatchObject({ sessionID, location: "archived" })
        const catalogAfterRead = yield* db
          .select({
            timeUpdated: SessionArchiveCatalogTable.time_updated,
            timeArchived: SessionArchiveCatalogTable.time_archived,
          })
          .from(SessionArchiveCatalogTable)
          .where(eq(SessionArchiveCatalogTable.session_id, sessionID))
          .get()
        expect(catalogAfterRead).toEqual(catalogBeforeRead)
        expect(yield* db.get(sql`SELECT id FROM session WHERE id = ${sessionID}`)).toBeUndefined()

        yield* db
          .insert(SessionArchiveJournalTable)
          .values({
            id: "journal_resume_reactivation",
            operation_key: `reactivate:${sessionID}:1`,
            session_id: sessionID,
            operation: "reactivate",
            state: "copied",
            revision: 1,
            shard_id: result!.shardID,
            content_hash: result!.contentHash,
            message_count: 170,
            input_count: 170,
            time_created: now - 101,
            time_updated: now - 101,
          })
          .run()
        expect(yield* archive.ensureActive(sessionID)).toEqual({ sessionID, revision: 1, reactivated: true })
        expect(yield* archive.ensureActive(sessionID)).toEqual({ sessionID, revision: 1, reactivated: false })
        expect(
          yield* db.get<{ count: number }>(
            sql`SELECT COUNT(*) AS count FROM session_message WHERE session_id = ${sessionID}`,
          ),
        ).toEqual({ count: 170 })
        expect(yield* db.get(sql`SELECT id FROM attachment WHERE session_id = ${sessionID}`)).toEqual({
          id: "att_archive",
        })
        expect(yield* db.get(sql`SELECT id FROM event WHERE aggregate_id = ${sessionID}`)).toEqual({
          id: "evt_archive_2",
        })
        expect(yield* db.get(sql`SELECT aggregate_id FROM event_checkpoint WHERE aggregate_id = ${sessionID}`)).toEqual(
          {
            aggregate_id: sessionID,
          },
        )
        expect(
          yield* db.get<{ count: number }>(sql`SELECT COUNT(*) AS count FROM event WHERE aggregate_id = ${sessionID}`),
        ).toEqual({ count: 1 })
        expect(yield* db.get(sql`SELECT id FROM message WHERE session_id = ${sessionID}`)).toEqual({
          id: "legacy_message",
        })
        expect(yield* db.get(sql`SELECT id FROM part WHERE session_id = ${sessionID}`)).toEqual({ id: "legacy_part" })
        expect(
          yield* db.get<{ count: number }>(
            sql`SELECT COUNT(*) AS count FROM session_input WHERE session_id = ${sessionID}`,
          ),
        ).toEqual({ count: 170 })
        expect(
          yield* db
            .select({ location: SessionArchiveCatalogTable.location })
            .from(SessionArchiveCatalogTable)
            .where(eq(SessionArchiveCatalogTable.session_id, sessionID))
            .get(),
        ).toEqual({ location: "active" })
        expect(
          yield* db
            .select({ operation: SessionArchiveJournalTable.operation, state: SessionArchiveJournalTable.state })
            .from(SessionArchiveJournalTable)
            .where(
              and(
                eq(SessionArchiveJournalTable.session_id, sessionID),
                eq(SessionArchiveJournalTable.state, "completed"),
              ),
            )
            .all(),
        ).toEqual([
          { operation: "archive", state: "completed" },
          { operation: "reactivate", state: "completed" },
        ])
      }),
    )
  }, 30_000)

  test("elides checkpoint-covered legacy duplicates while preserving paging and reactivation", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "active.sqlite")
    const sessionID = SessionSchema.ID.make("ses_archive_checkpoint_legacy")

    await run(
      filename,
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const events = yield* EventV2.Service
        yield* db
          .insert(ProjectTable)
          .values({
            id: Project.ID.global,
            worktree: AbsolutePath.make("/project"),
            sandboxes: [],
            time_created: 1,
            time_updated: 1,
          })
          .onConflictDoNothing()
          .run()
        yield* events.publish(SessionV1.Event.Created, {
          sessionID,
          info: SessionV1.SessionInfo.make({
            id: sessionID,
            slug: "checkpoint-legacy",
            version: "test",
            projectID: Project.ID.global,
            directory: AbsolutePath.make("/project"),
            title: "Checkpoint legacy archive",
            agent: "build",
            time: { created: 1, updated: 1 },
          }),
        })
        yield* Effect.forEach(
          range(0, 161),
          (index) => {
            const messageID = SessionV1.MessageID.make(`msg_checkpoint_legacy_${index}`)
            return Effect.gen(function* () {
              yield* events.publish(SessionV1.Event.MessageUpdated, {
                sessionID,
                info: {
                  id: messageID,
                  sessionID,
                  role: "user",
                  time: { created: index + 2 },
                  agent: "build",
                  model: { providerID: ProviderV2.ID.anthropic, modelID: ModelV2.ID.make("sonnet") },
                },
              })
              yield* events.publish(SessionV1.Event.PartUpdated, {
                sessionID,
                part: {
                  id: SessionV1.PartID.make(`prt_checkpoint_legacy_${index}`),
                  sessionID,
                  messageID,
                  type: "text",
                  text: `legacy turn ${index}`,
                },
                time: index + 2,
              })
            })
          },
          { discard: true },
        )
        yield* events.publish(SessionEvent.Prompted, {
          sessionID,
          timestamp: DateTime.makeUnsafe(500),
          messageID: SessionMessage.ID.make("msg_checkpoint_v2"),
          prompt: new Prompt({ text: "compressed-v2-checkpoint".repeat(50_000) }),
          delivery: "steer",
        })
        expect((yield* events.compactCheckpoint(sessionID))?.deleted).toBeGreaterThan(300)
        const archive = yield* SessionArchive.make({
          directory: path.join(tmp.path, "archives"),
          now: () => now,
          isIdle: () => Effect.succeed(true),
        })
        yield* archive.initialize
        yield* archive.refreshCatalog()
        const normalizedBeforeRead = yield* db
          .select({ data: EventCheckpointTable.data })
          .from(EventCheckpointTable)
          .where(eq(EventCheckpointTable.aggregate_id, sessionID))
          .get()
          .pipe(Effect.orDie)
        const normalizedBaseline = EventV2.readStoredCheckpointBaseline(normalizedBeforeRead!.data)
        expect(normalizedBaseline.data).toMatchObject({
          legacyMessages: [],
          legacyParts: [],
          messages: [],
          legacyProjectionReference: expect.objectContaining({
            legacyMessageCount: 161,
            legacyPartCount: 161,
            messageCount: 1,
          }),
        })
        const activeReplay = yield* archive.readEventReplay(sessionID)
        const activeBaseline = EventV2.readStoredCheckpointBaseline(
          JSON.parse(String(activeReplay.checkpoint!.data)) as Record<string, unknown>,
        )
        expect(activeBaseline.data).toMatchObject({
          legacyMessages: expect.arrayContaining([expect.objectContaining({ id: "msg_checkpoint_legacy_0" })]),
          legacyParts: expect.arrayContaining([expect.objectContaining({ id: "prt_checkpoint_legacy_0" })]),
          messages: [expect.objectContaining({ id: "msg_checkpoint_v2" })],
        })
        expect(
          yield* db
            .select({ data: EventCheckpointTable.data })
            .from(EventCheckpointTable)
            .where(eq(EventCheckpointTable.aggregate_id, sessionID))
            .get()
            .pipe(Effect.orDie),
        ).toEqual(normalizedBeforeRead)

        yield* setCheckpointAdapterVersion(db, sessionID, 2)
        const result = yield* archive.archiveOne(sessionID)
        expect((yield* archive.readMessages(sessionID)).rows).toHaveLength(1)
        const first = yield* archive.readLegacyMessages(sessionID, { limit: 100 })
        expect(first.items).toHaveLength(100)
        expect(first.more).toBe(true)
        expect(first.items[0]?.message.id).toBe("msg_checkpoint_legacy_160")
        const second = yield* archive.readLegacyMessages(sessionID, { before: first.cursor, limit: 100 })
        expect(second.items).toHaveLength(61)
        expect(second.more).toBe(false)
        expect((yield* archive.readLegacyMessage(sessionID, "msg_checkpoint_legacy_80")).parts).toHaveLength(1)

        const shardPath = (yield* db
          .select({ path: SessionArchiveShardTable.path })
          .from(SessionArchiveShardTable)
          .where(eq(SessionArchiveShardTable.id, result!.shardID))
          .get())!.path
        const stored = yield* Effect.tryPromise(async () => {
          const sqlite = await import("bun:sqlite")
          const shard = new sqlite.Database(shardPath, { readonly: true })
          const counts = {
            messages: shard.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM archive_legacy_message").get()!
              .count,
            parts: shard.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM archive_legacy_part").get()!.count,
            pageIndex: shard
              .query<{ detail: string }, [string, number, number]>(
                `
              EXPLAIN QUERY PLAN
              SELECT data_json, row_hash FROM archive_legacy_message
              WHERE session_id = ? AND revision = ?
              ORDER BY time_created DESC, id DESC LIMIT ?
            `,
              )
              .all(sessionID, result!.revision, 101)
              .some((row) => row.detail.includes("archive_legacy_message_page_idx")),
            markers: shard
              .query<{ count: number }, []>(
                "SELECT COUNT(*) AS count FROM archive_session_section WHERE section_name = 'legacy_projection_checkpoint'",
              )
              .get()!.count,
            normalized: (() => {
              const section = shard
                .query<{ data_json: string }, []>(
                  "SELECT data_json FROM archive_session_section WHERE section_name = 'event_checkpoint'",
                )
                .get()!
              const row = JSON.parse(section.data_json) as { data: string }
              const baseline = EventV2.readStoredCheckpointBaseline(JSON.parse(row.data) as Record<string, unknown>)
              return {
                version: baseline.version,
                messages: Array.isArray(baseline.data.legacyMessages) ? baseline.data.legacyMessages.length : -1,
                parts: Array.isArray(baseline.data.legacyParts) ? baseline.data.legacyParts.length : -1,
              }
            })(),
          }
          shard.close()
          return counts
        }).pipe(Effect.orDie)
        expect(stored).toEqual({
          messages: 161,
          parts: 161,
          pageIndex: true,
          markers: 1,
          normalized: { version: 2, messages: 0, parts: 0 },
        })

        const oldestMessage = yield* Effect.tryPromise(async () => {
          const sqlite = await import("bun:sqlite")
          const shard = new sqlite.Database(shardPath)
          const row = shard
            .query<{ data_json: string }, [string, number, string]>(
              `
            SELECT data_json FROM archive_legacy_message
            WHERE session_id = ? AND revision = ? AND id = ?
          `,
            )
            .get(sessionID, result!.revision, "msg_checkpoint_legacy_0")!
          shard.run(
            "UPDATE archive_legacy_message SET data_json = '{}' WHERE session_id = ? AND revision = ? AND id = ?",
            [sessionID, result!.revision, "msg_checkpoint_legacy_0"],
          )
          shard.close()
          return row.data_json
        }).pipe(Effect.orDie)
        expect((yield* archive.readLegacyMessages(sessionID, { limit: 1 })).items[0]?.message.id).toBe(
          "msg_checkpoint_legacy_160",
        )
        expect((yield* Effect.exit(archive.readLegacyMessage(sessionID, "msg_checkpoint_legacy_0")))._tag).toBe(
          "Failure",
        )
        yield* Effect.tryPromise(async () => {
          const sqlite = await import("bun:sqlite")
          const shard = new sqlite.Database(shardPath)
          shard.run(
            "UPDATE archive_legacy_message SET data_json = ? WHERE session_id = ? AND revision = ? AND id = ?",
            [oldestMessage, sessionID, result!.revision, "msg_checkpoint_legacy_0"],
          )
          shard.close()
        }).pipe(Effect.orDie)

        expect((yield* archive.ensureActive(sessionID)).reactivated).toBe(true)
        expect(
          yield* db.get<{ count: number }>(sql`
          SELECT COUNT(*) AS count FROM message WHERE session_id = ${sessionID}
        `),
        ).toEqual({ count: 161 })
        expect(
          yield* db.get<{ count: number }>(sql`
          SELECT COUNT(*) AS count FROM part WHERE session_id = ${sessionID}
        `),
        ).toEqual({ count: 161 })

        const secondArchive = yield* archive.archiveOne(sessionID)
        const secondShard = (yield* db
          .select({ path: SessionArchiveShardTable.path })
          .from(SessionArchiveShardTable)
          .where(eq(SessionArchiveShardTable.id, secondArchive!.shardID))
          .get())!.path
        yield* Effect.tryPromise(async () => {
          const sqlite = await import("bun:sqlite")
          const shard = new sqlite.Database(secondShard)
          shard.run(
            "UPDATE archive_session_section SET data_json = '{}' WHERE session_id = ? AND revision = ? AND section_name = 'event_checkpoint'",
            [sessionID, secondArchive!.revision],
          )
          shard.close()
        }).pipe(Effect.orDie)
        expect((yield* archive.readLegacyMessages(sessionID, { limit: 1 })).items).toHaveLength(1)
        expect((yield* Effect.exit(archive.ensureActive(sessionID)))._tag).toBe("Failure")
      }),
    )
  }, 30_000)

  test("archives, reactivates, and upgrades a version 1 projection checkpoint", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "active.sqlite")
    const sessionID = SessionSchema.ID.make("ses_archive_checkpoint_v1")

    await run(
      filename,
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const events = yield* EventV2.Service
        yield* db
          .insert(ProjectTable)
          .values({
            id: Project.ID.global,
            worktree: AbsolutePath.make("/project"),
            sandboxes: [],
            time_created: 1,
            time_updated: 1,
          })
          .onConflictDoNothing()
          .run()
        yield* events.publish(SessionV1.Event.Created, {
          sessionID,
          info: SessionV1.SessionInfo.make({
            id: sessionID,
            slug: "checkpoint-v1",
            version: "test",
            projectID: Project.ID.global,
            directory: AbsolutePath.make("/project"),
            title: "Version 1 checkpoint archive",
            time: { created: 1, updated: 1 },
          }),
        })
        expect((yield* events.compactCheckpoint(sessionID))?.checkpoint.baseline.version).toBe(
          SessionProjector.CheckpointAdapterVersion,
        )
        yield* setCheckpointAdapterVersion(db, sessionID, 1)

        const archive = yield* SessionArchive.make({
          directory: path.join(tmp.path, "archives"),
          now: () => now,
          isIdle: () => Effect.succeed(true),
        })
        yield* archive.initialize
        expect((yield* archive.archiveOne(sessionID))?.sessionID).toBe(sessionID)
        expect((yield* archive.readEventReplay(sessionID)).checkpoint).toBeDefined()
        expect((yield* archive.ensureActive(sessionID)).reactivated).toBe(true)

        const restored = yield* db
          .select({ data: EventCheckpointTable.data })
          .from(EventCheckpointTable)
          .where(eq(EventCheckpointTable.aggregate_id, sessionID))
          .get()
          .pipe(Effect.orDie)
        expect(EventV2.readStoredCheckpointBaseline(restored!.data).version).toBe(1)
        expect((yield* events.createCheckpoint(sessionID))?.baseline.version).toBe(
          SessionProjector.CheckpointAdapterVersion,
        )
        expect(yield* db.get(sql`SELECT title FROM session WHERE id = ${sessionID}`)).toEqual({
          title: "Version 1 checkpoint archive",
        })
      }),
    )
  })

  test("keeps archived file-mutation blobs reachable and validates dedicated references", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "active.sqlite")
    const archiveDirectory = path.join(tmp.path, "archives")
    const storeDirectory = path.join(tmp.path, "content")
    const journalDirectory = path.join(tmp.path, "gc-journals")
    const sessionID = SessionSchema.ID.make("ses_archive_mutation_refs")

    await mkdir(journalDirectory, { recursive: true })
    const before = await putManagedBlob(storeDirectory, "mutation before")
    const after = await putManagedBlob(storeDirectory, "mutation after")

    await run(
      filename,
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* seedSession(db, sessionID, now - 10 * day, 2)
        yield* db.run(sql`
          INSERT INTO content_blob(sha256, size_bytes, mime, storage_path, created_at)
          VALUES
            (${before.sha256}, ${before.sizeBytes}, 'text/plain', ${before.path}, ${now - 10 * day}),
            (${after.sha256}, ${after.sizeBytes}, 'text/plain', ${after.path}, ${now - 10 * day})
        `)
        yield* db.run(sql`
          INSERT INTO session_file_mutation(
            id, session_id, assistant_message_id, call_id, target, resource,
            before_exists, before_bytes, before_sha256, after_exists, after_bytes, after_sha256, time_created
          ) VALUES (
            'mutation_archive', ${sessionID}, ${`msg_${sessionID}_1`}, 'call_archive', '/project/file.txt',
            '/project/file.txt', 1, ${before.sizeBytes}, ${before.sha256}, 1, ${after.sizeBytes}, ${after.sha256},
            ${now - 10 * day}
          )
        `)
        const archive = yield* SessionArchive.make({
          directory: archiveDirectory,
          now: () => now,
          isIdle: () => Effect.succeed(true),
        })
        yield* archive.initialize
        const archived = yield* archive.archiveOne(sessionID)
        const shard = yield* db
          .select({ path: SessionArchiveShardTable.path })
          .from(SessionArchiveShardTable)
          .where(eq(SessionArchiveShardTable.id, archived!.shardID))
          .get()
        const gcInput = {
          storeDirectory,
          journalDirectory,
          databases: [{ kind: "active" as const, path: filename }],
          archiveShards: [shard!.path],
          rollbackManifests: [],
        }
        const plan = yield* Effect.promise(() => ContentGC.plan(gcInput))
        expect(plan.candidates).toEqual([])
        expect(plan.reachableBlobs).toBe(2)
        expect(yield* db.get(sql`SELECT id FROM session_file_mutation WHERE session_id = ${sessionID}`)).toBeUndefined()

        const reference = yield* Effect.tryPromise(async () => {
          const sqlite = await import("bun:sqlite")
          const database = new sqlite.Database(shard!.path)
          const row = database
            .query<
              {
                session_id: string
                revision: number
                mutation_id: string
                before_sha256: string
                after_sha256: string
                row_hash: string
              },
              []
            >("SELECT * FROM archive_file_mutation_ref")
            .get()!
          database.run("UPDATE archive_file_mutation_ref SET before_sha256 = 'corrupt'")
          database.close()
          return row
        }).pipe(Effect.orDie)
        expect(
          yield* Effect.promise(() =>
            ContentGC.plan(gcInput).then(
              () => undefined,
              (error) => error,
            ),
          ),
        ).toMatchObject({ code: "integrity" })

        yield* Effect.tryPromise(async () => {
          const sqlite = await import("bun:sqlite")
          const database = new sqlite.Database(shard!.path)
          database.run(
            `UPDATE archive_file_mutation_ref
             SET before_sha256 = ?, after_sha256 = ?, row_hash = ?
             WHERE session_id = ? AND revision = ? AND mutation_id = ?`,
            [
              reference.before_sha256,
              reference.after_sha256,
              reference.row_hash,
              reference.session_id,
              reference.revision,
              reference.mutation_id,
            ],
          )
          database.run("DELETE FROM archive_file_mutation_ref")
          database.close()
        }).pipe(Effect.orDie)
        expect(
          yield* Effect.promise(() =>
            ContentGC.plan(gcInput).then(
              () => undefined,
              (error) => error,
            ),
          ),
        ).toMatchObject({ code: "integrity" })

        yield* Effect.tryPromise(async () => {
          const sqlite = await import("bun:sqlite")
          const database = new sqlite.Database(shard!.path)
          database.run(
            `INSERT INTO archive_file_mutation_ref(
              session_id, revision, mutation_id, before_sha256, after_sha256, row_hash
             ) VALUES (?, ?, ?, ?, ?, ?)`,
            [
              reference.session_id,
              reference.revision,
              reference.mutation_id,
              reference.before_sha256,
              reference.after_sha256,
              reference.row_hash,
            ],
          )
          database.close()
        }).pipe(Effect.orDie)
        expect(yield* archive.ensureActive(sessionID)).toMatchObject({ reactivated: true })
        expect(
          yield* db.get<{ before_sha256: string; after_sha256: string }>(sql`
            SELECT before_sha256, after_sha256 FROM session_file_mutation WHERE session_id = ${sessionID}
          `),
        ).toEqual({ before_sha256: before.sha256, after_sha256: after.sha256 })

        const archivedAgain = yield* archive.archiveOne(sessionID)
        expect(archivedAgain?.revision).toBe(2)
        yield* Effect.tryPromise(async () => {
          const sqlite = await import("bun:sqlite")
          const database = new sqlite.Database(shard!.path)
          database.run("DROP TABLE archive_file_mutation_ref")
          database.close()
        }).pipe(Effect.orDie)
        expect((yield* Effect.promise(() => ContentGC.plan(gcInput))).candidates).toEqual([])
        const restarted = yield* SessionArchive.make({
          directory: archiveDirectory,
          now: () => now,
          isIdle: () => Effect.succeed(true),
        })
        yield* restarted.initialize
        expect(yield* restarted.ensureActive(sessionID)).toMatchObject({ reactivated: true })
        expect(
          yield* db.get<{ before_sha256: string; after_sha256: string }>(sql`
            SELECT before_sha256, after_sha256 FROM session_file_mutation WHERE session_id = ${sessionID}
          `),
        ).toEqual({ before_sha256: before.sha256, after_sha256: after.sha256 })
      }),
    )
  }, 30_000)

  test("selects only seven-day idle sessions and archives one session per call", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "active.sqlite")
    const eligible = SessionSchema.ID.make("ses_archive_eligible")
    const second = SessionSchema.ID.make("ses_archive_second")
    const migratedAttachment = SessionSchema.ID.make("ses_archive_migrated_attachment")
    const recent = SessionSchema.ID.make("ses_archive_recent")
    const queued = SessionSchema.ID.make("ses_archive_queued")
    const recentInput = SessionSchema.ID.make("ses_archive_recent_input")
    const running = SessionSchema.ID.make("ses_archive_running")
    const background = SessionSchema.ID.make("ses_archive_background")
    const question = SessionSchema.ID.make("ses_archive_question")

    await run(
      filename,
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        for (const [id, modified] of [
          [eligible, now - 12 * day],
          [second, now - 11 * day],
          [migratedAttachment, now - 10.5 * day],
          [recent, now - day],
          [queued, now - 10 * day],
          [recentInput, now - 10 * day],
          [running, now - 10 * day],
          [background, now - 10 * day],
          [question, now - 10 * day],
        ] as const)
          yield* seedSession(db, id, modified, 0)
        yield* db.run(sql`
          INSERT INTO content_blob(sha256, size_bytes, mime, storage_path, created_at)
          VALUES (${"c".repeat(64)}, 4, 'image/png', 'content/cc/blob', ${now})
        `)
        yield* db.run(sql`
          INSERT INTO attachment(id, session_id, mime, size_bytes, storage_path, blob_sha256, created_at)
          VALUES ('att_migrated_recent', ${migratedAttachment}, 'image/png', 4, 'content/cc/blob', ${"c".repeat(64)}, ${now})
        `)
        yield* db
          .insert(SessionInputTable)
          .values({
            id: SessionMessage.ID.make("msg_queued"),
            session_id: queued,
            prompt: { text: "queued" },
            delivery: "queue",
            admitted_seq: 0,
            time_created: now - 10 * day,
          })
          .run()
        yield* db
          .insert(SessionInputTable)
          .values({
            id: SessionMessage.ID.make("msg_recent_input"),
            session_id: recentInput,
            prompt: { text: "recent" },
            delivery: "steer",
            admitted_seq: 0,
            promoted_seq: 0,
            time_created: now - day,
          })
          .run()
        yield* db
          .insert(SessionActivityTable)
          .values({
            id: "activity_running",
            session_id: running,
            status: "running",
            kind: "prompt",
            time_created: now - 10 * day,
            time_updated: now - 10 * day,
          })
          .run()
        yield* db
          .insert(BackgroundJobTable)
          .values({
            id: "job_running",
            type: "test",
            status: "running",
            parent_session_id: background,
            time_created: now - 10 * day,
            time_updated: now - 10 * day,
          })
          .run()

        const oldestBusy = yield* SessionArchive.make({
          directory: path.join(tmp.path, "archives"),
          now: () => now,
          isIdle: (sessionID) => Effect.succeed(sessionID !== eligible && sessionID !== question),
        })
        yield* oldestBusy.initialize
        expect(yield* oldestBusy.candidateStats).toEqual({
          backlog: 4,
          oldestEligibleAt: now - 12 * day,
        })
        expect(yield* oldestBusy.candidates(1)).toEqual([second])

        const archive = yield* SessionArchive.make({
          directory: path.join(tmp.path, "archives"),
          now: () => now,
          isIdle: (sessionID) => Effect.succeed(sessionID !== question),
        })
        yield* archive.initialize
        expect(yield* archive.candidates()).toEqual([eligible, second, migratedAttachment])

        expect((yield* archive.archiveOne())?.sessionID).toBe(eligible)
        expect(yield* db.get<{ count: number }>(sql`SELECT COUNT(*) AS count FROM session`)).toEqual({ count: 8 })
        expect(yield* archive.candidates()).toEqual([second, migratedAttachment])
        expect((yield* archive.archiveOne())?.sessionID).toBe(second)
        expect(yield* db.get<{ count: number }>(sql`SELECT COUNT(*) AS count FROM session`)).toEqual({ count: 7 })
      }),
    )
  }, 30_000)

  test("permanently purges only archived sessions beyond the configured inactivity window", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "active.sqlite")
    const stale = SessionSchema.ID.make("ses_archive_retention_stale")
    const recent = SessionSchema.ID.make("ses_archive_retention_recent")
    const protectedSession = SessionSchema.ID.make("ses_archive_retention_protected")

    await run(
      filename,
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* seedSession(db, stale, now - 30 * day, 1)
        yield* seedSession(db, recent, now - 10 * day, 1)
        yield* seedSession(db, protectedSession, now - 30 * day, 1)
        yield* SessionProtection.setProtected(db, protectedSession, true, now)
        const archive = yield* SessionArchive.make({
          directory: path.join(tmp.path, "archives"),
          now: () => now,
          inactiveMs: 7 * day,
          isIdle: () => Effect.succeed(true),
        })
        yield* archive.initialize
        expect(yield* archive.candidates()).toEqual([stale, recent])
        const staleArchive = yield* archive.archiveOne()
        yield* archive.archiveOne(recent)
        expect(yield* archive.archiveOne(protectedSession)).toBeUndefined()
        expect(yield* db.get(sql`SELECT id FROM session WHERE id = ${protectedSession}`)).toEqual({
          id: protectedSession,
        })

        expect(yield* archive.purgeCandidates(21 * day)).toEqual([stale])
        expect(yield* archive.purgeOne(recent, 21 * day)).toBeUndefined()
        expect(yield* archive.purgeOne(stale, 21 * day)).toMatchObject({
          sessionID: stale,
          shardID: staleArchive!.shardID,
          revision: staleArchive!.revision,
        })
        expect(yield* archive.purgeCandidates(21 * day)).toEqual([])
        yield* SessionProtection.setProtected(db, protectedSession, false, now)
        const protectedArchive = yield* archive.archiveOne(protectedSession)
        expect(protectedArchive).toBeDefined()
        yield* SessionProtection.setProtected(db, protectedSession, true, now)
        expect(yield* SessionProtection.isProtected(db, protectedSession)).toBe(true)
        expect(yield* archive.purgeOne(protectedSession, 21 * day)).toBeUndefined()
        yield* SessionProtection.setProtected(db, protectedSession, false, now)
        expect(yield* archive.purgeCandidates(21 * day)).toEqual([protectedSession])
        expect(yield* archive.purgeOne(protectedSession, 21 * day)).toMatchObject({ sessionID: protectedSession })
        expect(
          yield* db
            .select({ id: SessionArchiveCatalogTable.session_id })
            .from(SessionArchiveCatalogTable)
            .where(eq(SessionArchiveCatalogTable.session_id, stale))
            .get(),
        ).toBeUndefined()
        expect((yield* Effect.exit(archive.readMessages(stale)))._tag).toBe("Failure")

        const shardPath = (yield* db
          .select({ path: SessionArchiveShardTable.path })
          .from(SessionArchiveShardTable)
          .where(eq(SessionArchiveShardTable.id, staleArchive!.shardID))
          .get())!.path
        expect(
          yield* Effect.tryPromise(async () => {
            const sqlite = await import("bun:sqlite")
            const shard = new sqlite.Database(shardPath, { readonly: true })
            const rows = shard
              .query<{ session_id: string }, []>("SELECT session_id FROM archive_session ORDER BY session_id")
              .all()
            shard.close()
            return rows
          }).pipe(Effect.orDie),
        ).toEqual([{ session_id: recent }])
        expect(
          yield* db
            .select({ operation: SessionArchiveJournalTable.operation, state: SessionArchiveJournalTable.state })
            .from(SessionArchiveJournalTable)
            .where(eq(SessionArchiveJournalTable.session_id, stale))
            .all(),
        ).toContainEqual({ operation: "purge", state: "completed" })
      }),
    )
  }, 30_000)

  test("pages past more than one thousand transiently busy candidates", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "active.sqlite")
    const eligible = SessionSchema.ID.make("ses_archive_after_busy_page")

    await run(
      filename,
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* seedSession(db, eligible, now - 9 * day, 0)
        yield* db.transaction((tx) =>
          Effect.forEach(
            range(0, 1_001),
            (seq) =>
              tx.run(sql`
                INSERT INTO session(id, project_id, slug, directory, title, version, time_created, time_updated)
                VALUES (${`ses_archive_busy_${seq.toString().padStart(4, "0")}`}, ${Project.ID.global}, ${`busy-${seq}`}, '/project', 'Busy', 'test', ${now - 10 * day + seq}, ${now - 10 * day + seq})
              `),
            { discard: true },
          ),
        )
        const archive = yield* SessionArchive.make({
          directory: path.join(tmp.path, "archives"),
          now: () => now,
          isIdle: (sessionID) => Effect.succeed(sessionID === eligible),
        })
        yield* archive.initialize

        expect(yield* archive.candidateStats).toEqual({
          backlog: 1_002,
          oldestEligibleAt: now - 10 * day,
        })
        expect(yield* archive.candidates(1)).toEqual([eligible])
      }),
    )
  }, 30_000)

  test("does not create a missing shard while reading", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "active.sqlite")
    const sessionID = SessionSchema.ID.make("ses_archive_missing_shard")

    await run(
      filename,
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* seedSession(db, sessionID, now - 10 * day, 1)
        const archive = yield* SessionArchive.make({
          directory: path.join(tmp.path, "archives"),
          now: () => now,
          isIdle: () => Effect.succeed(true),
        })
        yield* archive.initialize
        const result = yield* archive.archiveOne(sessionID)
        const shard = yield* db
          .select({ path: SessionArchiveShardTable.path })
          .from(SessionArchiveShardTable)
          .where(eq(SessionArchiveShardTable.id, result!.shardID))
          .get()
        const missingPath = `${shard!.path}.missing`
        yield* db
          .update(SessionArchiveShardTable)
          .set({ path: missingPath })
          .where(eq(SessionArchiveShardTable.id, result!.shardID))
          .run()

        const page = yield* Effect.exit(archive.readMessages(sessionID))
        expect(page._tag).toBe("Failure")
        expect(yield* Effect.promise(() => Bun.file(missingPath).exists())).toBe(false)
        yield* db
          .update(SessionArchiveShardTable)
          .set({ path: filename })
          .where(eq(SessionArchiveShardTable.id, result!.shardID))
          .run()
        expect((yield* Effect.exit(archive.readMessages(sessionID)))._tag).toBe("Failure")
      }),
    )
  })

  test("rejects corrupted rows and unsupported shard versions", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "active.sqlite")
    const corrupted = SessionSchema.ID.make("ses_archive_corrupted")
    const versioned = SessionSchema.ID.make("ses_archive_versioned")

    await run(
      filename,
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* seedSession(db, corrupted, now - 10 * day, 1)
        yield* seedSession(db, versioned, now - 10 * day, 1)
        const archive = yield* SessionArchive.make({
          directory: path.join(tmp.path, "archives"),
          maxShardBytes: 1,
          now: () => now,
          isIdle: () => Effect.succeed(true),
        })
        yield* archive.initialize
        const corruptedResult = yield* archive.archiveOne(corrupted)
        const versionedResult = yield* archive.archiveOne(versioned)
        const shards = yield* db
          .select({ id: SessionArchiveShardTable.id, path: SessionArchiveShardTable.path })
          .from(SessionArchiveShardTable)
          .all()
        const corruptedPath = shards.find((shard) => shard.id === corruptedResult!.shardID)!.path
        const versionedPath = shards.find((shard) => shard.id === versionedResult!.shardID)!.path
        yield* Effect.tryPromise(async () => {
          const sqlite = await import("bun:sqlite")
          const corruptedShard = new sqlite.Database(corruptedPath)
          corruptedShard.run("UPDATE archive_session_message SET data_json = '{}' WHERE session_id = ?", [corrupted])
          corruptedShard.close()
          const versionedShard = new sqlite.Database(versionedPath)
          versionedShard.run("UPDATE archive_metadata SET value = '99' WHERE key = 'format_version'")
          versionedShard.close()
        }).pipe(Effect.orDie)

        const corruptedPage = yield* Effect.exit(archive.readMessages(corrupted))
        const versionedPage = yield* Effect.exit(archive.readMessages(versioned))
        expect(corruptedPage._tag).toBe("Failure")
        expect(versionedPage._tag).toBe("Failure")
        yield* Effect.tryPromise(async () => {
          const sqlite = await import("bun:sqlite")
          const shard = new sqlite.Database(versionedPath)
          shard.run("UPDATE archive_metadata SET value = '1' WHERE key = 'format_version'")
          shard.run("UPDATE archive_session SET format_version = 99 WHERE session_id = ?", [versioned])
          shard.close()
        }).pipe(Effect.orDie)
        expect((yield* Effect.exit(archive.ensureActive(versioned)))._tag).toBe("Failure")
      }),
    )
  })

  test("coordinates parallel archive and reactivation exactly once", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "active.sqlite")
    const sessionID = SessionSchema.ID.make("ses_archive_parallel")

    await run(
      filename,
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* seedSession(db, sessionID, now - 10 * day, 12)
        const options = {
          directory: path.join(tmp.path, "archives"),
          now: () => now,
          isIdle: () => Effect.succeed(true),
        }
        const first = yield* SessionArchive.make(options)
        const second = yield* SessionArchive.make(options)
        yield* first.initialize
        const archived = yield* Effect.all([first.archiveOne(sessionID), second.archiveOne(sessionID)], {
          concurrency: "unbounded",
        })
        expect(archived.filter(Boolean).length).toBeGreaterThanOrEqual(1)
        expect(
          yield* db.get<{ count: number }>(sql`
            SELECT COUNT(*) AS count FROM session_archive_journal
            WHERE operation_key = ${`archive:${sessionID}:1`} AND state = 'completed'
          `),
        ).toEqual({ count: 1 })
        expect(
          yield* db.get<{ count: number }>(sql`
            SELECT COUNT(*) AS count FROM session_archive_shard WHERE session_count = 1
          `),
        ).toEqual({ count: 1 })

        const reactivated = yield* Effect.all([first.ensureActive(sessionID), second.ensureActive(sessionID)], {
          concurrency: "unbounded",
        })
        expect(reactivated.filter((result) => result.reactivated)).toHaveLength(1)
        expect(
          yield* db.get<{ count: number }>(sql`
            SELECT COUNT(*) AS count FROM session_message WHERE session_id = ${sessionID}
          `),
        ).toEqual({ count: 12 })
        expect(
          yield* db.get<{ count: number }>(sql`
            SELECT COUNT(*) AS count FROM session_archive_journal
            WHERE operation_key = ${`archive-access:${sessionID}:1`} AND state = 'completed'
          `),
        ).toEqual({ count: 1 })
      }),
    )
  }, 30_000)

  test("filters and keyset-pages active and archived catalog rows", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "active.sqlite")
    const alpha = SessionSchema.ID.make("ses_catalog_alpha")
    const beta = SessionSchema.ID.make("ses_catalog_beta")
    const gamma = SessionSchema.ID.make("ses_catalog_gamma")
    const hidden = SessionSchema.ID.make("ses_catalog_hidden")
    const modified = now - 10 * day

    await run(
      filename,
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* Effect.forEach([alpha, beta, gamma, hidden], (sessionID) => seedSession(db, sessionID, modified, 0), {
          discard: true,
        })
        yield* db.run(sql`
          INSERT INTO workspace(id, type, name, project_id, time_used)
          VALUES ('ws_catalog', 'local', 'Catalog', ${Project.ID.global}, ${modified})
        `)
        yield* db.run(sql`
          UPDATE session SET workspace_id = 'ws_catalog', directory = '/catalog/shared'
          WHERE id IN (${alpha}, ${beta})
        `)
        yield* db.run(sql`UPDATE session SET title = 'Alpha result' WHERE id = ${alpha}`)
        yield* db.run(sql`UPDATE session SET title = 'Beta result' WHERE id = ${beta}`)
        yield* db.run(sql`UPDATE session SET title = 'Gamma result', directory = '/catalog/other' WHERE id = ${gamma}`)
        yield* db.run(sql`UPDATE session SET title = 'Hidden result', time_archived = ${now} WHERE id = ${hidden}`)
        const archive = yield* SessionArchive.make({
          directory: path.join(tmp.path, "archives"),
          now: () => now,
          isIdle: () => Effect.succeed(true),
        })
        yield* archive.initialize
        yield* archive.refreshCatalog()
        yield* archive.archiveOne(beta)

        const first = yield* archive.listCatalog({ order: "created-desc", limit: 1 })
        expect(first.rows.map((row) => row.sessionID)).toEqual([gamma])
        expect(first.hasMore).toBe(true)
        const second = yield* archive.listCatalog({ order: "created-desc", anchor: first.nextAnchor, limit: 1 })
        expect(second.rows.map((row) => row.sessionID)).toEqual([beta])
        expect(second.rows[0]).toMatchObject({ location: "archived", timeCreated: modified })
        expect(
          (yield* archive.listCatalog({ workspaceID: "ws_catalog", directory: "/catalog/shared" })).rows.map(
            (row) => row.sessionID,
          ),
        ).toEqual([beta, alpha])
        expect((yield* archive.listCatalog({ search: "beta" })).rows.map((row) => row.sessionID)).toEqual([beta])
        expect((yield* archive.listCatalog({ location: "archived" })).rows.map((row) => row.sessionID)).toEqual([beta])
        expect((yield* archive.listCatalog({ location: "active" })).rows.map((row) => row.sessionID)).not.toContain(
          beta,
        )
        expect((yield* archive.listCatalog()).rows.map((row) => row.sessionID)).not.toContain(hidden)
        expect((yield* archive.listCatalog({ includeHidden: true })).rows.map((row) => row.sessionID)).toContain(hidden)
        expect(
          (yield* archive.listCatalog({ projectID: Project.ID.global, order: "title-desc" })).rows.map(
            (row) => row.title,
          ),
        ).toEqual(["Gamma result", "Beta result", "Alpha result"])
      }),
    )
  })

  test("keeps startup, catalog, and active sessions lazy while archive and blob files are unavailable", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "active.sqlite")
    const archiveDirectory = path.join(tmp.path, "archives")
    const archived = SessionSchema.ID.make("ses_archive_unavailable_storage")
    const active = SessionSchema.ID.make("ses_active_unavailable_storage")
    const attachmentID = "att_active_unavailable_storage"
    const blob = Buffer.from("lazy storage")
    const blobHash = new Bun.CryptoHasher("sha256").update(blob).digest("hex")

    await run(
      filename,
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* seedSession(db, archived, now - 10 * day, 2)
        yield* seedSession(db, active, now - day, 2)
        yield* db.run(sql`
          INSERT INTO content_blob(sha256, size_bytes, mime, storage_path, created_at)
          VALUES (${blobHash}, ${blob.byteLength}, 'text/plain',
            ${path.join(ContentStore.MANAGED_DIRECTORY, blobHash.slice(0, 2), blobHash)}, ${now - 10 * day})
        `)
        yield* db.run(sql`
          INSERT INTO attachment(id, session_id, message_id, mime, filename, size_bytes, storage_path, blob_sha256, created_at)
          VALUES ('att_archived_unavailable_storage', ${archived}, ${`msg_${archived}_0`}, 'text/plain',
            'archived.txt', ${blob.byteLength},
            ${path.join(ContentStore.MANAGED_DIRECTORY, blobHash.slice(0, 2), blobHash)},
            ${blobHash}, ${now - 10 * day})
        `)
        yield* db.run(sql`
          INSERT INTO attachment(id, session_id, message_id, mime, filename, size_bytes, storage_path, blob_sha256, created_at)
          VALUES (${attachmentID}, ${active}, ${`msg_${active}_0`}, 'text/plain', 'active.txt', ${blob.byteLength},
            ${path.join(ContentStore.MANAGED_DIRECTORY, blobHash.slice(0, 2), blobHash)},
            ${blobHash}, ${now - day})
        `)
        const archive = yield* SessionArchive.make({
          directory: archiveDirectory,
          now: () => now,
          isIdle: () => Effect.succeed(true),
        })
        yield* archive.initialize
        yield* archive.refreshCatalog()
        const result = yield* archive.archiveOne(archived)
        if (!result) return yield* Effect.die("Expected the old Session to be archived")
        const shard = yield* db
          .select({ path: SessionArchiveShardTable.path })
          .from(SessionArchiveShardTable)
          .where(eq(SessionArchiveShardTable.id, result.shardID))
          .get()
          .pipe(Effect.orDie)
        if (!shard) return yield* Effect.die("Expected the archive shard metadata")
        yield* db
          .update(SessionArchiveShardTable)
          .set({ path: `${shard.path}.unavailable` })
          .where(eq(SessionArchiveShardTable.id, result.shardID))
          .run()
          .pipe(Effect.orDie)
      }),
    )

    const database = Database.layerFromPath(filename).pipe(Layer.fresh)
    const content = ContentStore.layer.pipe(
      Layer.provide(database),
      Layer.provide(FSUtil.defaultLayer),
      Layer.provide(Global.layerWith({ data: tmp.path })),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const archive = yield* SessionArchive.make({
          directory: archiveDirectory,
          now: () => now,
          isIdle: () => Effect.succeed(true),
        })
        yield* archive.initialize
        yield* archive.refreshCatalog()

        expect((yield* archive.listCatalog()).rows.map((row) => row.sessionID)).toEqual([active, archived])
        expect((yield* archive.listCatalog({ search: "unavailable_storage" })).rows).toHaveLength(2)
        expect((yield* archive.readMessages(active)).rows.map((row) => row.id)).toEqual([
          `msg_${active}_1`,
          `msg_${active}_0`,
        ])

        expect(yield* Effect.flip(archive.readMessages(archived))).toMatchObject({
          _tag: "SessionArchive.IntegrityError",
        })
        expect(
          yield* Effect.flip(
            (yield* ContentStore.Service).resolve({
              uri: ContentStore.URI_PREFIX + attachmentID,
              sessionID: active,
            }),
          ),
        ).toMatchObject({ _tag: "ContentStore.StorageError", operation: "integrity" })

        expect((yield* archive.listCatalog({ location: "active" })).rows.map((row) => row.sessionID)).toEqual([active])
        expect((yield* archive.readMessages(active)).rows).toHaveLength(2)
      }).pipe(Effect.provide(Layer.mergeAll(database, content)), Effect.scoped),
    )
  })

  test("removes stale active catalog entries during reconciliation", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "active.sqlite")
    const sessionID = SessionSchema.ID.make("ses_archive_stale_catalog")

    await run(
      filename,
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* seedSession(db, sessionID, now - day, 0)
        const archive = yield* SessionArchive.make({
          directory: path.join(tmp.path, "archives"),
          now: () => now,
          isIdle: () => Effect.succeed(true),
        })
        yield* archive.initialize
        yield* archive.refreshCatalog()
        expect((yield* archive.listCatalog()).rows).toHaveLength(1)
        yield* db.run(sql`DELETE FROM session WHERE id = ${sessionID}`)
        yield* archive.refreshCatalog()
        expect((yield* archive.listCatalog()).rows).toEqual([])
      }),
    )
  })

  test("rechecks process-local idleness before archive cutover", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "active.sqlite")
    const sessionID = SessionSchema.ID.make("ses_archive_idle_race")
    let checks = 0

    await run(
      filename,
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* seedSession(db, sessionID, now - 10 * day, 1)
        const archive = yield* SessionArchive.make({
          directory: path.join(tmp.path, "archives"),
          now: () => now,
          isIdle: () => Effect.sync(() => ++checks === 1),
        })
        yield* archive.initialize
        expect((yield* Effect.exit(archive.archiveOne(sessionID)))._tag).toBe("Failure")
        expect(yield* db.get(sql`SELECT id FROM session WHERE id = ${sessionID}`)).toEqual({ id: sessionID })
        expect(
          yield* db.get<{ count: number }>(sql`
            SELECT COUNT(*) AS count FROM session_archive_journal WHERE state = 'failed'
          `),
        ).toEqual({ count: 1 })
      }),
    )
  })

  test("resumes a failed archive journal on its already-bound shard", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "active.sqlite")
    const sessionID = SessionSchema.ID.make("ses_archive_resume")

    await run(
      filename,
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* seedSession(db, sessionID, now - 10 * day, 2)
        const blobHash = "b".repeat(64)
        yield* db.run(sql`
          INSERT INTO content_blob(sha256, size_bytes, mime, storage_path, created_at)
          VALUES (${blobHash}, 4, 'image/png', 'content/bb/blob', ${now - 10 * day})
        `)
        yield* db.run(sql`
          INSERT INTO attachment(id, session_id, message_id, mime, filename, size_bytes, storage_path, blob_sha256, created_at)
          VALUES ('att_resume', ${sessionID}, ${`msg_${sessionID}_0`}, 'image/png', 'resume.png', 4,
            'content/bb/blob', ${blobHash}, ${now - 10 * day})
        `)
        const archive = yield* SessionArchive.make({
          directory: path.join(tmp.path, "archives"),
          leaseMs: 1,
          now: () => now,
          isIdle: () => Effect.succeed(true),
        })
        yield* archive.initialize
        const first = yield* archive.archiveOne(sessionID)
        yield* archive.ensureActive(sessionID)
        yield* db.run(sql`
          UPDATE session SET title = 'Changed after reactivation', time_updated = ${now - 9 * day}
          WHERE id = ${sessionID}
        `)
        yield* db
          .insert(SessionArchiveJournalTable)
          .values({
            id: "abandoned_archive_owner",
            operation_key: `archive:${sessionID}:2`,
            session_id: sessionID,
            operation: "archive",
            state: "failed",
            revision: 2,
            shard_id: first!.shardID,
            error: "simulated crash",
            time_created: now - 2,
            time_updated: now - 2,
          })
          .run()

        const resumed = yield* archive.archiveOne(sessionID)
        expect(resumed).toMatchObject({ sessionID, revision: 2, shardID: first!.shardID })
        expect(
          yield* db
            .select({ state: SessionArchiveJournalTable.state, error: SessionArchiveJournalTable.error })
            .from(SessionArchiveJournalTable)
            .where(eq(SessionArchiveJournalTable.operation_key, `archive:${sessionID}:2`))
            .get(),
        ).toEqual({ state: "completed", error: null })
        const shard = yield* db
          .select({ path: SessionArchiveShardTable.path, sessions: SessionArchiveShardTable.session_count })
          .from(SessionArchiveShardTable)
          .where(eq(SessionArchiveShardTable.id, resumed!.shardID))
          .get()
        const retained = yield* Effect.tryPromise(async () => {
          const sqlite = await import("bun:sqlite")
          const database = new sqlite.Database(shard!.path, { readonly: true })
          const sessions = database
            .query<{ revision: number }, []>("SELECT revision FROM archive_session ORDER BY revision")
            .all()
          const attachments = database
            .query<{ revision: number; blob_sha256: string }, []>(
              "SELECT revision, blob_sha256 FROM archive_attachment_ref ORDER BY revision",
            )
            .all()
          const autoVacuum = database.query<{ auto_vacuum: number }, []>("PRAGMA auto_vacuum").get()
          database.close()
          return { sessions, attachments, autoVacuum }
        }).pipe(Effect.orDie)
        expect(shard!.sessions).toBe(1)
        expect(retained).toEqual({
          sessions: [{ revision: 2 }],
          attachments: [{ revision: 2, blob_sha256: blobHash }],
          autoVacuum: { auto_vacuum: 2 },
        })
      }),
    )
  })
})

function run<A, E>(filename: string, effect: Effect.Effect<A, E, Database.Service | EventV2.Service>) {
  const database = Database.layerFromPath(filename)
  const events = EventV2.layer.pipe(Layer.provide(database))
  const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  return Effect.runPromise(effect.pipe(Effect.provide(Layer.mergeAll(database, events, projector)), Effect.scoped))
}

function setCheckpointAdapterVersion(db: Database.Interface["db"], sessionID: SessionSchema.ID, version: 1 | 2) {
  return Effect.gen(function* () {
    yield* SessionProjector.materializeActiveCheckpoint(db, sessionID)
    const row = yield* db
      .select({ data: EventCheckpointTable.data })
      .from(EventCheckpointTable)
      .where(eq(EventCheckpointTable.aggregate_id, sessionID))
      .get()
      .pipe(Effect.orDie)
    if (!row) return yield* Effect.die("Checkpoint is missing")
    const baseline = EventV2.readStoredCheckpointBaseline(row.data)
    const data = Object.fromEntries(
      Object.entries(baseline.data).filter(([key]) =>
        version === 1
          ? !["legacyMessages", "legacyParts", "legacyCheckpointOnly", "legacyProjectionReference"].includes(key)
          : !["legacyCheckpointOnly", "legacyProjectionReference"].includes(key),
      ),
    )
    yield* db
      .update(EventCheckpointTable)
      .set({
        data: EventV2.replaceStoredCheckpointBaseline(row.data, {
          adapter: SessionProjector.CheckpointAdapterID,
          version,
          data,
        }),
      })
      .where(eq(EventCheckpointTable.aggregate_id, sessionID))
      .run()
      .pipe(Effect.orDie)
  })
}

function seedSession(
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
  modified: number,
  messageCount: number,
) {
  return Effect.gen(function* () {
    yield* db
      .insert(ProjectTable)
      .values({
        id: Project.ID.global,
        worktree: AbsolutePath.make("/project"),
        sandboxes: [],
        time_created: modified,
        time_updated: modified,
      })
      .onConflictDoNothing()
      .run()
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: sessionID,
        directory: AbsolutePath.make("/project"),
        title: `Archive ${sessionID}`,
        version: "test",
        time_created: modified,
        time_updated: modified,
      })
      .run()
    yield* db.transaction((tx) =>
      Effect.forEach(
        range(0, messageCount),
        (seq) =>
          Effect.all(
            [
              tx.run(sql`
                INSERT INTO session_message(id, session_id, type, seq, time_created, time_updated, data)
                VALUES (${`msg_${sessionID}_${seq}`}, ${sessionID}, ${seq % 2 ? "assistant" : "user"}, ${seq}, ${modified + seq}, ${modified + seq}, ${JSON.stringify({ text: `turn ${seq}` })})
              `),
              tx.run(sql`
                INSERT INTO session_input(id, session_id, prompt, delivery, admitted_seq, promoted_seq, time_created)
                VALUES (${`input_${sessionID}_${seq}`}, ${sessionID}, ${JSON.stringify({ text: `turn ${seq}` })}, 'steer', ${seq}, ${seq}, ${modified + seq})
              `),
            ],
            { discard: true },
          ),
        { discard: true },
      ),
    )
  })
}

function range(start: number, end: number) {
  return Array.from({ length: end - start }, (_, index) => start + index)
}

async function putManagedBlob(directory: string, content: string) {
  const bytes = Buffer.from(content)
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
  const filename = path.join(directory, sha256.slice(0, 2), sha256)
  await mkdir(path.dirname(filename), { recursive: true })
  await Bun.write(filename, bytes)
  return { sha256, path: filename, sizeBytes: bytes.byteLength }
}
