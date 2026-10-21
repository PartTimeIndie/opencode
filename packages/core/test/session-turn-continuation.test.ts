import { describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionActivityTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionTurnContinuation } from "@opencode-ai/core/session/turn-continuation"
import { eq, sql } from "drizzle-orm"
import { Effect } from "effect"
import { testEffect } from "./lib/effect"

const it = testEffect(Database.layerFromPath(":memory:"))

const seed = Effect.fn("SessionTurnContinuationTest.seed")(function* (sessionID: SessionSchema.ID) {
  const { db } = yield* Database.Service
  yield* db.run(sql`
    INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
    VALUES ('project_turn_continuation', 'C:/repo', '[]', 1, 1)
  `)
  yield* db.run(sql`
    INSERT INTO session (id, project_id, slug, directory, title, version, metadata, time_created, time_updated)
    VALUES (${sessionID}, 'project_turn_continuation', 'continuation', 'C:/repo', 'Continuation', 'dev', '{"foreign":{"keep":true}}', 1, 1)
  `)
})

const metadata = (sessionID: SessionSchema.ID) =>
  Database.Service.use(({ db }) =>
    db
      .select({ metadata: SessionTable.metadata })
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID))
      .get()
      .pipe(Effect.orDie),
  )

describe("SessionTurnContinuation", () => {
  it.effect("consumption durably retires the parent completion claim before the lineage can be reset", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = SessionSchema.ID.make("ses_turn_continuation_handoff")
      yield* seed(sessionID)
      yield* db
        .insert(SessionActivityTable)
        .values({
          id: "activity_handoff",
          session_id: sessionID,
          status: "completed",
          kind: "resume",
          closed_seq: 1,
          turn_completion_state: "running",
          turn_completion_result: "incomplete",
          turn_completion_owner_id: "old_owner",
          turn_completion_lease_until: 100,
        })
        .run()
        .pipe(Effect.orDie)
      yield* SessionTurnContinuation.arm(db, sessionID, "activity_handoff", "pending")
      expect(yield* SessionTurnContinuation.consume(db, sessionID, "activity_handoff")).toBe(true)
      yield* SessionTurnContinuation.reset(db, sessionID)
      expect(
        yield* db
          .select()
          .from(SessionActivityTable)
          .where(eq(SessionActivityTable.id, "activity_handoff"))
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({
        turn_completion_state: "done",
        turn_completion_result: "incomplete",
        turn_completion_owner_id: null,
        turn_completion_lease_until: null,
        turn_completion_completed_at: expect.any(Number),
      })
    }),
  )

  it.effect("reconciles the same consumed activity without rearming for successor progress", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = SessionSchema.ID.make("ses_turn_continuation_consumed")
      yield* seed(sessionID)
      yield* SessionTurnContinuation.arm(db, sessionID, "activity_consumed", "pending")
      expect(yield* SessionTurnContinuation.consume(db, sessionID, "activity_consumed")).toBe(true)
      const consumed = yield* SessionTurnContinuation.read(db, sessionID)
      expect(yield* SessionTurnContinuation.arm(db, sessionID, "activity_consumed", "pending")).toEqual(consumed)
      expect(yield* SessionTurnContinuation.arm(db, sessionID, "activity_consumed", "in_progress")).toEqual(consumed)
      expect(yield* SessionTurnContinuation.pending(db, sessionID)).toBeUndefined()
    }),
  )

  it.effect("rolls back parent retirement when persisting consumption fails", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = SessionSchema.ID.make("ses_turn_continuation_rollback")
      yield* seed(sessionID)
      yield* db
        .insert(SessionActivityTable)
        .values({
          id: "activity_rollback",
          session_id: sessionID,
          status: "completed",
          kind: "resume",
          closed_seq: 1,
          turn_completion_state: "running",
          turn_completion_result: "incomplete",
          turn_completion_owner_id: "owner",
        })
        .run()
        .pipe(Effect.orDie)
      yield* SessionTurnContinuation.arm(db, sessionID, "activity_rollback")
      yield* db.run(sql`CREATE TRIGGER fail_consumption BEFORE UPDATE OF metadata ON session
        BEGIN SELECT RAISE(ABORT, 'consumption unavailable'); END`)
      expect((yield* SessionTurnContinuation.consume(db, sessionID, "activity_rollback").pipe(Effect.exit))._tag).toBe(
        "Failure",
      )
      expect(yield* SessionTurnContinuation.pending(db, sessionID)).toMatchObject({ activityID: "activity_rollback" })
      expect(
        yield* db
          .select()
          .from(SessionActivityTable)
          .where(eq(SessionActivityTable.id, "activity_rollback"))
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({
        turn_completion_state: "running",
        turn_completion_owner_id: "owner",
        turn_completion_completed_at: null,
      })
      yield* db.run(sql`DROP TRIGGER fail_consumption`)
      expect(yield* SessionTurnContinuation.consume(db, sessionID, "activity_rollback")).toBe(true)
    }),
  )

  it.effect("keeps a session-wide two-continuation lineage across consumed successor instructions", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = SessionSchema.ID.make("ses_turn_continuation_lineage")
      yield* seed(sessionID)

      const first = yield* SessionTurnContinuation.arm(db, sessionID, "activity_1")
      expect(first).toMatchObject({ activityID: "activity_1", attempts: 1 })
      expect(yield* SessionTurnContinuation.arm(db, sessionID, "activity_1")).toEqual(first)
      expect(yield* SessionTurnContinuation.consume(db, sessionID, "activity_1")).toBe(true)
      expect(yield* SessionTurnContinuation.pending(db, sessionID)).toBeUndefined()

      const second = yield* SessionTurnContinuation.arm(db, sessionID, "activity_2")
      expect(second).toMatchObject({ activityID: "activity_2", attempts: 2 })
      expect(yield* SessionTurnContinuation.consume(db, sessionID, "activity_2")).toBe(true)

      expect(yield* SessionTurnContinuation.arm(db, sessionID, "activity_3")).toBeUndefined()
      expect(yield* SessionTurnContinuation.read(db, sessionID)).toMatchObject({
        activityID: "activity_2",
        attempts: SessionTurnContinuation.MaxAttempts,
      })
      expect((yield* metadata(sessionID))?.metadata?.foreign).toEqual({ keep: true })

      expect(yield* SessionTurnContinuation.reset(db, sessionID)).toBe(true)
      expect((yield* metadata(sessionID))?.metadata).toEqual({ foreign: { keep: true } })
    }),
  )

  it.effect("resets the stalled-attempt count when todo progress changes", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = SessionSchema.ID.make("ses_turn_continuation_progress")
      yield* seed(sessionID)

      for (const [index, progressFingerprint] of ["todo_1", "todo_2", "todo_3", "todo_4"].entries()) {
        const activityID = `activity_progress_${index + 1}`
        const marker = yield* SessionTurnContinuation.arm(db, sessionID, activityID, progressFingerprint)
        expect(marker).toMatchObject({ activityID, attempts: 1, progressFingerprint })
        expect(yield* SessionTurnContinuation.consume(db, sessionID, activityID)).toBe(true)
      }

      expect(yield* SessionTurnContinuation.read(db, sessionID)).toMatchObject({
        activityID: "activity_progress_4",
        attempts: 1,
        progressFingerprint: "todo_4",
      })
    }),
  )

  it.effect("stops unchanged todo progress at the bounded attempt cap", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = SessionSchema.ID.make("ses_turn_continuation_stalled")
      yield* seed(sessionID)
      const progressFingerprint = "same_todos"

      for (const [index, activityID] of ["activity_stalled_1", "activity_stalled_2"].entries()) {
        expect(yield* SessionTurnContinuation.arm(db, sessionID, activityID, progressFingerprint)).toMatchObject({
          activityID,
          attempts: index + 1,
          progressFingerprint,
        })
        expect(yield* SessionTurnContinuation.consume(db, sessionID, activityID)).toBe(true)
      }

      expect(yield* SessionTurnContinuation.arm(db, sessionID, "activity_stalled_3", progressFingerprint)).toBeUndefined()
      expect(yield* SessionTurnContinuation.read(db, sessionID)).toMatchObject({
        activityID: "activity_stalled_2",
        attempts: SessionTurnContinuation.MaxAttempts,
        progressFingerprint,
      })
    }),
  )

  it.effect("starts a fresh lineage after reset even when todo progress is unchanged", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = SessionSchema.ID.make("ses_turn_continuation_reset")
      yield* seed(sessionID)
      const progressFingerprint = "same_todos"

      expect(yield* SessionTurnContinuation.arm(db, sessionID, "activity_reset_1", progressFingerprint)).toMatchObject({ attempts: 1 })
      expect(yield* SessionTurnContinuation.consume(db, sessionID, "activity_reset_1")).toBe(true)
      expect(yield* SessionTurnContinuation.arm(db, sessionID, "activity_reset_2", progressFingerprint)).toMatchObject({ attempts: 2 })
      expect(yield* SessionTurnContinuation.consume(db, sessionID, "activity_reset_2")).toBe(true)

      expect(yield* SessionTurnContinuation.reset(db, sessionID)).toBe(true)
      expect(yield* SessionTurnContinuation.arm(db, sessionID, "activity_reset_3", progressFingerprint)).toMatchObject({
        activityID: "activity_reset_3",
        attempts: 1,
        progressFingerprint,
      })
    }),
  )

  it.effect("removes an expired lineage without deleting unrelated metadata", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = SessionSchema.ID.make("ses_turn_continuation_stale")
      yield* seed(sessionID)
      yield* db
        .update(SessionTable)
        .set({
          metadata: {
            foreign: { keep: true },
            [SessionTurnContinuation.MetadataKey]: {
              reason: "incomplete",
              activityID: "activity_stale",
              attempts: 2,
              timeCreated: Date.now() - SessionTurnContinuation.LineageTtlMs - 1,
            },
          },
        })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)

      expect(yield* SessionTurnContinuation.pending(db, sessionID)).toBeUndefined()
      expect((yield* metadata(sessionID))?.metadata).toEqual({ foreign: { keep: true } })
      expect(yield* SessionTurnContinuation.arm(db, sessionID, "activity_fresh")).toMatchObject({ attempts: 1 })
    }),
  )
})
