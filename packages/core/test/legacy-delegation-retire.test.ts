import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { LegacyDelegationRetire } from "@opencode-ai/core/session/legacy-delegation/retire"
import { SessionOrchestratorReservationTable, SessionOrchestratorTable, SessionOrchestratorTaskTable } from "@opencode-ai/core/session/legacy-delegation/sql"
import { SessionActivityTable, SessionInputTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { testEffect } from "./lib/effect"

const it = testEffect(Database.layerFromPath(":memory:"))
const now = 1_800_000_000_000
const hour = 60 * 60 * 1000
const main = SessionSchema.ID.make("ses_retire_main")
const child = SessionSchema.ID.make("ses_retire_child")
const input = SessionMessage.ID.make("msg_retire_input")

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db.insert(ProjectTable).values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/fixture"), sandboxes: [] }).run().pipe(Effect.orDie)
  yield* db.insert(SessionTable).values([main, child].map((id) => ({
    id, project_id: ProjectV2.ID.global, directory: "/fixture", slug: id, title: id, version: "test",
  }))).run().pipe(Effect.orDie)
  yield* db.insert(SessionInputTable).values({ id: input, session_id: main, prompt: { text: "Historical assignment" }, delivery: "steer", admitted_seq: 1 }).run().pipe(Effect.orDie)
  yield* db.insert(SessionOrchestratorTable).values({ main_session_id: main }).run().pipe(Effect.orDie)
  return db
})

const insertTask = (db: Database.Interface["db"], overrides: Partial<typeof SessionOrchestratorTaskTable.$inferInsert> = {}) =>
  db.insert(SessionOrchestratorTaskTable).values({
    id: overrides.id ?? "task-stuck",
    main_session_id: main,
    request_id: overrides.request_id ?? "request-1",
    origin_input_id: input,
    origin_user_message_id: input,
    goal: "Historical assignment",
    acceptance: "Retained evidence",
    resources: ["project:*"],
    dependencies: [],
    workspace_mode: "shared",
    child_session_id: child,
    state: "blocked_cache",
    slot_claimed: true,
    time_updated: now - 48 * hour,
    ...overrides,
  }).run().pipe(Effect.orDie)

describe("legacy stuck task retirement", () => {
  it.effect("retires a stuck pre-run task, frees its slot and releases its reservations", () => Effect.gen(function* () {
    const db = yield* setup
    yield* insertTask(db)
    yield* db.insert(SessionOrchestratorReservationTable).values([
      { task_id: "task-stuck", directory: "e:/gitrepros/pu", resource: "build:opencode-host-actions" },
      { task_id: "task-stuck", directory: "e:/gitrepros/pu", resource: "build:opencode-orchestrator-management" },
    ]).run().pipe(Effect.orDie)

    const outcome = yield* LegacyDelegationRetire.retireStale(db, { now })

    expect(outcome.skipped).toEqual([])
    expect(outcome.retired).toHaveLength(1)
    expect(outcome.retired[0]).toMatchObject({
      id: "task-stuck",
      previousState: "blocked_cache",
      freedSlot: true,
    })
    expect(outcome.retired[0].releasedReservations).toEqual([
      { directory: "e:/gitrepros/pu", resource: "build:opencode-host-actions" },
      { directory: "e:/gitrepros/pu", resource: "build:opencode-orchestrator-management" },
    ])
    const rows = yield* db.select().from(SessionOrchestratorTaskTable).all().pipe(Effect.orDie)
    expect(rows).toHaveLength(1)
    expect(rows[0].state).toBe("cancelled")
    expect(rows[0].slot_claimed).toBe(false)
    expect(rows[0].time_updated).toBe(now) // history row retained, only state flipped
    const reservations = yield* db.select().from(SessionOrchestratorReservationTable).all().pipe(Effect.orDie)
    expect(reservations).toEqual([])
  }))

  it.effect("skips a stuck task whose child still shows a live activity", () => Effect.gen(function* () {
    const db = yield* setup
    yield* insertTask(db)
    yield* db.insert(SessionActivityTable).values({
      id: "act_child", session_id: child, status: "running", kind: "prompt",
      owner_id: "owner", lease_until: now + hour,
    }).run().pipe(Effect.orDie)

    const outcome = yield* LegacyDelegationRetire.retireStale(db, { now })

    expect(outcome.retired).toEqual([])
    expect(outcome.skipped).toEqual([{ id: "task-stuck", reason: "active" }])
    const row = yield* db.select().from(SessionOrchestratorTaskTable).all().pipe(Effect.orDie)
    expect(row).toHaveLength(1)
    expect(row[0].state).toBe("blocked_cache")
    expect(row[0].slot_claimed).toBe(true)
  }))

  it.effect("keeps human-gated and terminal states untouched", () => Effect.gen(function* () {
    const db = yield* setup
    yield* insertTask(db, { id: "task-paused", request_id: "r1", state: "paused", slot_claimed: true, child_session_id: undefined })
    yield* insertTask(db, { id: "task-decision", request_id: "r2", state: "blocked_decision", slot_claimed: true, child_session_id: undefined })
    yield* insertTask(db, { id: "task-done", request_id: "r3", state: "done", slot_claimed: false, child_session_id: undefined })

    const outcome = yield* LegacyDelegationRetire.retireStale(db, { now })

    expect(outcome.retired).toEqual([])
    expect(outcome.skipped).toEqual([])
    const states = yield* db.select({ id: SessionOrchestratorTaskTable.id, state: SessionOrchestratorTaskTable.state }).from(SessionOrchestratorTaskTable).all().pipe(Effect.orDie)
    expect(Object.fromEntries(states.map((s) => [s.id, s.state]))).toEqual({
      "task-paused": "paused",
      "task-decision": "blocked_decision",
      "task-done": "done",
    })
  }))

  it.effect("keeps recently updated stuck tasks inside the age window", () => Effect.gen(function* () {
    const db = yield* setup
    yield* insertTask(db, { time_updated: now - hour })

    const outcome = yield* LegacyDelegationRetire.retireStale(db, { now })

    expect(outcome.retired).toEqual([])
    expect(outcome.skipped).toEqual([{ id: "task-stuck", reason: "recent" }])
    const rows = yield* db.select().from(SessionOrchestratorTaskTable).all().pipe(Effect.orDie)
    expect(rows[0].state).toBe("blocked_cache")
    expect(rows[0].slot_claimed).toBe(true)
  }))

  it.effect("dry-run reports the full retirement without writing anything", () => Effect.gen(function* () {
    const db = yield* setup
    yield* insertTask(db)
    yield* db.insert(SessionOrchestratorReservationTable).values({
      task_id: "task-stuck", directory: "e:/gitrepros/pu", resource: "build:opencode-host-actions",
    }).run().pipe(Effect.orDie)

    const outcome = yield* LegacyDelegationRetire.retireStale(db, { now, dryRun: true })

    expect(outcome.retired).toHaveLength(1)
    expect(outcome.retired[0]).toMatchObject({ id: "task-stuck", previousState: "blocked_cache", freedSlot: true })
    expect(outcome.retired[0].releasedReservations).toEqual([
      { directory: "e:/gitrepros/pu", resource: "build:opencode-host-actions" },
    ])
    // Dry-run is read-only: the stuck state, slot claim and reservation survive.
    const rows = yield* db.select().from(SessionOrchestratorTaskTable).all().pipe(Effect.orDie)
    expect(rows[0].state).toBe("blocked_cache")
    expect(rows[0].slot_claimed).toBe(true)
    const reservations = yield* db.select().from(SessionOrchestratorReservationTable).all().pipe(Effect.orDie)
    expect(reservations).toHaveLength(1)
  }))
})
