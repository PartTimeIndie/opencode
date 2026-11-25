import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { DateTime, Effect, Exit, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventCheckpointTable, EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import type { LegacyDelegationRecord } from "@opencode-ai/core/session/legacy-delegation/record"
import {
  SessionOrchestratorTable,
  SessionOrchestratorTaskTable,
  SessionOrchestratorReservationTable,
} from "@opencode-ai/core/session/legacy-delegation/sql"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionProtection } from "@opencode-ai/core/session/protection"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
const it = testEffect(Layer.mergeAll(database, events, projector))
const mainID = SessionSchema.ID.make("ses_protection_main")
const childID = SessionSchema.ID.make("ses_protection_child")
const originID = SessionMessage.ID.make("msg_protection_origin")

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const service = yield* EventV2.Service
  yield* db
    .insert(ProjectTable)
    .values({
      id: ProjectV2.ID.global,
      worktree: AbsolutePath.make("/protection"),
      sandboxes: [],
    })
    .run()
    .pipe(Effect.orDie)
  for (const id of [mainID, childID]) {
    yield* service.publish(SessionV1.Event.Created, {
      sessionID: id,
      info: SessionV1.SessionInfo.make({
        id,
        projectID: ProjectV2.ID.global,
        ...(id === childID ? { parentID: mainID } : {}),
        slug: id,
        title: id,
        directory: "/protection",
        version: "test",
        time: { created: 1, updated: 1 },
      }),
    })
  }
  yield* service.publish(SessionEvent.Prompted, {
    sessionID: mainID,
    messageID: originID,
    timestamp: DateTime.makeUnsafe(2),
    prompt: new Prompt({ text: "Assigned work" }),
    delivery: "steer",
  })
  return { db, service }
})

const configure = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db.insert(SessionOrchestratorTable).values({ main_session_id: mainID }).run().pipe(Effect.orDie)
})

function bind(state: LegacyDelegationRecord.TaskState, claimed = true) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionOrchestratorTaskTable)
      .values({
        id: "task-protection",
        main_session_id: mainID,
        request_id: "request-protection",
        origin_input_id: originID,
        origin_user_message_id: originID,
        goal: "Assigned work",
        acceptance: "Verified",
        resources: ["path:/protection/file.ts"],
        dependencies: [],
        workspace_mode: "shared",
        state,
        slot_claimed: claimed,
        child_session_id: childID,
      })
      .run()
      .pipe(Effect.orDie)
    if (claimed)
      yield* db
        .insert(SessionOrchestratorReservationTable)
        .values({
          directory: "/protection",
          resource: "path:/protection/file.ts",
          task_id: "task-protection",
        })
        .run()
        .pipe(Effect.orDie)
  })
}

function blocked<A>(exit: Exit.Exit<A, unknown>, sessionID: SessionSchema.ID) {
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isSuccess(exit)) throw new Error("Expected ownership protection")
  expect(
    exit.cause.reasons.some(
      (reason) =>
        (reason._tag === "Fail" &&
          reason.error instanceof SessionProtection.ProtectedError &&
          reason.error.sessionID === sessionID) ||
        (reason._tag === "Die" &&
          reason.defect instanceof SessionProtection.ProtectedError &&
          reason.defect.sessionID === sessionID),
    ),
  ).toBe(true)
}

const snapshot = Effect.gen(function* () {
  const { db } = yield* Database.Service
  return {
    sessions: yield* db.select().from(SessionTable).all().pipe(Effect.orDie),
    mains: yield* db.select().from(SessionOrchestratorTable).all().pipe(Effect.orDie),
    tasks: yield* db.select().from(SessionOrchestratorTaskTable).all().pipe(Effect.orDie),
    claims: yield* db.select().from(SessionOrchestratorReservationTable).all().pipe(Effect.orDie),
    events: yield* db.select().from(EventTable).all().pipe(Effect.orDie),
    sequences: yield* db.select().from(EventSequenceTable).all().pipe(Effect.orDie),
    checkpoints: yield* db.select().from(EventCheckpointTable).all().pipe(Effect.orDie),
  }
})

function remove(sessionID: SessionSchema.ID) {
  return Effect.gen(function* () {
    const service = yield* EventV2.Service
    yield* service.publish(SessionV1.Event.Deleted, {
      sessionID,
      info: SessionV1.SessionInfo.make({
        id: sessionID,
        projectID: ProjectV2.ID.global,
        slug: sessionID,
        title: sessionID,
        directory: "/protection",
        version: "test",
        time: { created: 1, updated: 1 },
      }),
    })
  })
}

describe("orchestrator ownership survives deletion and projection replacement", () => {
  it.effect("retains ordinary pin override and unmanaged deletion", () =>
    Effect.gen(function* () {
      const { db } = yield* setup
      yield* SessionProtection.setProtected(db, childID, true)
      blocked(yield* Effect.exit(SessionProtection.requireDeletable(db, childID, false)), childID)
      yield* SessionProtection.requireDeletable(db, childID, true)
      yield* remove(childID)
      expect(
        yield* db.select().from(SessionTable).where(eq(SessionTable.id, childID)).get().pipe(Effect.orDie),
      ).toBeUndefined()
    }),
  )

  it.effect("protects configured Mains even without tasks and despite user-pin override", () =>
    Effect.gen(function* () {
      const { db } = yield* setup
      yield* configure
      yield* SessionProtection.setProtected(db, mainID, true)
      yield* SessionProtection.setProtected(db, mainID, false)
      for (const override of [false, true])
        blocked(yield* Effect.exit(SessionProtection.requireDeletable(db, mainID, override)), mainID)
      const before = yield* snapshot
      blocked(yield* Effect.exit(remove(mainID)), mainID)
      expect(yield* snapshot).toEqual(before)
    }),
  )

  for (const state of [
    "checking_cache",
    "running",
    "reviewing",
    "integrating",
    "blocked_cache",
    "paused",
    "done",
    "failed",
    "cancelled",
  ] as const) {
    it.effect(`retains Main/child evidence in ${state}, including released terminal tombstones`, () =>
      Effect.gen(function* () {
        const { db } = yield* setup
        yield* configure
            yield* bind(state, !["done", "failed", "cancelled"].includes(state))
        const before = yield* snapshot
        for (const id of [mainID, childID]) {
          blocked(yield* Effect.exit(SessionProtection.requireDeletable(db, id, true)), id)
          blocked(yield* Effect.exit(remove(id)), id)
          expect(yield* snapshot).toEqual(before)
        }
      }),
    )
  }

  it.effect("rechecks ownership in the event transaction after an earlier clean preflight", () =>
    Effect.gen(function* () {
      const { db, service } = yield* setup
      yield* SessionProtection.requireDeletable(db, mainID, true)
      yield* configure
      const notices: string[] = []
      yield* service.listen((event) =>
        Effect.sync(() => {
          notices.push(event.type)
        }),
      )
      const before = yield* snapshot
      blocked(yield* Effect.exit(remove(mainID)), mainID)
      expect(notices).toEqual([])
      expect(yield* snapshot).toEqual(before)
    }),
  )

  for (const target of ["unmanaged", "main", "child"] as const) {
    it.effect(
      `checkpoint restore ${target === "unmanaged" ? "preserves ordinary recovery" : `cannot erase ${target} ownership`}`,
      () =>
        Effect.gen(function* () {
          const { db, service } = yield* setup
          const id = target === "main" ? mainID : childID
          const checkpoint = yield* service.createCheckpoint(id)
          if (!checkpoint) throw new Error("Expected checkpoint")
          if (target !== "unmanaged") {
            yield* configure
            yield* bind("running")
          }
          // Simulate a missing event stream with its live projection still present.
          // Recovery must not treat that absence as permission to cascade ownership.
          yield* service.remove(id)
          yield* db
            .delete(EventCheckpointTable)
            .where(eq(EventCheckpointTable.aggregate_id, id))
            .run()
            .pipe(Effect.orDie)
          const before = yield* snapshot
          const result = yield* Effect.exit(service.replayCheckpoint(checkpoint))
          if (target !== "unmanaged") {
            blocked(result, id)
            expect(yield* snapshot).toEqual(before)
            return
          }
          expect(Exit.isSuccess(result)).toBe(true)
          expect(yield* db.select().from(SessionTable).all().pipe(Effect.orDie)).toEqual(before.sessions)
          expect(
            yield* db
              .select()
              .from(EventSequenceTable)
              .where(eq(EventSequenceTable.aggregate_id, id))
              .get()
              .pipe(Effect.orDie),
          ).toMatchObject({ seq: checkpoint.seq })
        }),
    )
  }
})
