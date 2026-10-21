import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventSequenceTable } from "@opencode-ai/core/event/sql"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionActivity } from "@opencode-ai/core/session/activity"
import { SettlementWatchdog } from "@opencode-ai/core/session/settlement-watchdog"
import { ConfigMaintenance } from "@opencode-ai/core/config/maintenance"
import { SessionActivityTable, SessionTable } from "@opencode-ai/core/session/sql"
import { QuestionV2 } from "@opencode-ai/core/question"
import { QuestionTable } from "@opencode-ai/core/question/sql"
import { Identifier } from "@opencode-ai/core/util/identifier"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const activityLayer = SessionActivity.layer.pipe(Layer.provide(events), Layer.provide(database))

const it = testEffect(Layer.mergeAll(database, events, activityLayer))
const sessionID = SessionV2.ID.make("ses_settlement_test")

const NOW = 1_000_000

const settings = (overrides: Partial<SettlementWatchdog.Settings> = {}): SettlementWatchdog.Settings => ({
  ...ConfigMaintenance.defaultWatchdog,
  ...overrides,
})

const insertSession = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "settlement-test",
      directory: "/project",
      title: "Settlement Test",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(EventSequenceTable)
    .values({ aggregate_id: sessionID, seq: 1 })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

const insertStaleActivity = (input: {
  readonly id: string
  readonly leaseUntil: number
  readonly timeUpdated?: number
}) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionActivityTable)
      .values({
        id: input.id,
        session_id: sessionID,
        status: "running",
        kind: "prompt",
        owner_id: "old_owner",
        opened_seq: -2,
        lease_until: input.leaseUntil,
        heartbeat_at: input.leaseUntil,
        time_created: input.timeUpdated ?? input.leaseUntil,
        time_updated: input.timeUpdated ?? input.leaseUntil,
      })
      .run()
      .pipe(Effect.orDie)
  })

describe("SettlementWatchdog", () => {
  describe("decision helpers", () => {
    test("isSettleDue respects the grace window after lease expiry", () => {
      const info = { leaseUntil: NOW, timeUpdated: NOW }
      expect(SettlementWatchdog.isSettleDue(info, NOW + 59_000, 60_000)).toBeFalse()
      expect(SettlementWatchdog.isSettleDue(info, NOW + 60_000, 60_000)).toBeTrue()
    })

    test("isSettleDue falls back to timeUpdated when no lease is stored", () => {
      const info = { timeUpdated: NOW }
      expect(SettlementWatchdog.isSettleDue(info, NOW + 59_999, 60_000)).toBeFalse()
      expect(SettlementWatchdog.isSettleDue(info, NOW + 60_000, 60_000)).toBeTrue()
    })

    test("settleDueAt prefers the lease boundary over timeUpdated", () => {
      expect(SettlementWatchdog.settleDueAt({ leaseUntil: 5_000, timeUpdated: 1_000 }, 100)).toBe(5_100)
      expect(SettlementWatchdog.settleDueAt({ timeUpdated: 1_000 }, 100)).toBe(1_100)
    })
  })

  describe("settingsFromEnv", () => {
    test("defaults match the maintenance config defaults and are enabled", () => {
      const resolved = SettlementWatchdog.settingsFromEnv({})
      expect(resolved.enabled).toBeTrue()
      expect(resolved.intervalMs).toBe(30_000)
      expect(resolved.leaseGraceMs).toBe(60_000)
      expect(resolved.bootstrapTimeoutMs).toBe(120_000)
    })

    test("valid positive integer overrides win; invalid values fall back", () => {
      const resolved = SettlementWatchdog.settingsFromEnv({
        OPENCODE_SETTLEMENT_INTERVAL_MS: "5000",
        OPENCODE_SETTLEMENT_LEASE_GRACE_MS: "-3",
      })
      expect(resolved.intervalMs).toBe(5_000)
      expect(resolved.leaseGraceMs).toBe(60_000)
    })

    test("OPENCODE_SETTLEMENT_WATCHDOG=0 disables the watchdog", () => {
      expect(SettlementWatchdog.settingsFromEnv({ OPENCODE_SETTLEMENT_WATCHDOG: "0" }).enabled).toBeFalse()
      expect(SettlementWatchdog.settingsFromEnv({ OPENCODE_SETTLEMENT_WATCHDOG: "1" }).enabled).toBeTrue()
    })
  })

  describe("settleOnce", () => {
    it.live("terminalizes stale activities past the grace window", () =>
      Effect.gen(function* () {
        yield* insertSession
        const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
        const activityID = Identifier.ascending()
        yield* insertStaleActivity({ id: activityID, leaseUntil: now - 120_000 })
        const activity = yield* SessionActivity.Service
        const { db } = yield* Database.Service

        const result = yield* SettlementWatchdog.settleOnce({ activity, db }, settings())

        expect(result.activities).toBe(1)
        const settled = yield* activity.get(activityID)
        expect(settled?.status).toBe("interrupted")
        expect(settled?.reason).toBe("stale-lease")
      }),
    )

    it.live("leaves activities inside the grace window running", () =>
      Effect.gen(function* () {
        yield* insertSession
        const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
        const activityID = Identifier.ascending()
        yield* insertStaleActivity({ id: activityID, leaseUntil: now - 1_000 })
        const activity = yield* SessionActivity.Service
        const { db } = yield* Database.Service

        const result = yield* SettlementWatchdog.settleOnce(
          { activity, db },
          settings({ leaseGraceMs: 60_000 }),
        )

        expect(result.activities).toBe(0)
        const settled = yield* activity.get(activityID)
        expect(settled?.status).toBe("running")
      }),
    )

    it.live("never terminalizes an expired activity holding a live blocking question", () =>
      Effect.gen(function* () {
        yield* insertSession
        const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
        const activityID = Identifier.ascending()
        yield* insertStaleActivity({ id: activityID, leaseUntil: now - 120_000 })
        const { db } = yield* Database.Service
        const questionID = QuestionV2.ID.make("que_settlement_guard")
        yield* db
          .insert(QuestionTable)
          .values({
            id: questionID,
            session_id: sessionID,
            activity_id: activityID,
            seq: 1,
            state: "active",
            mode: "blocking",
            detached: false,
            request: {
              id: questionID,
              sessionID,
              mode: "blocking",
              revision: 1,
              actions: [],
              questions: [{ question: "Continue?", options: [{ label: "Yes", description: "Continue" }] }],
            },
          })
          .run()
          .pipe(Effect.orDie)
        const activity = yield* SessionActivity.Service

        const result = yield* SettlementWatchdog.settleOnce({ activity, db }, settings())

        expect(result.activities).toBe(0)
        const settled = yield* activity.get(activityID)
        expect(settled?.status).toBe("running")
      }),
    )
  })
})
