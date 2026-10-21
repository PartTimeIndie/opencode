import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { SessionArchive } from "@opencode-ai/core/session-archive"
import { SessionArchiveMaintenance } from "@opencode-ai/core/session-archive-maintenance"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { it } from "./lib/effect"

const sessionID = SessionSchema.ID.make("ses_archive_maintenance")
const archived = {
  sessionID,
  shardID: "archive-000001",
  revision: 1,
  contentHash: "a".repeat(64),
  logicalBytes: 512,
}
const purged = {
  sessionID,
  shardID: "archive-000001",
  revision: 1,
  logicalBytes: 512,
}

describe("SessionArchiveMaintenance", () => {
  it.effect("records idle and archived outcomes", () =>
    Effect.gen(function* () {
      const results = [undefined, archived] as const
      let calls = 0
      let currentTime = 1_000
      const maintenance = yield* make(
        Effect.sync(() => results[calls++]),
        () => currentTime,
      )

      expect(yield* maintenance.runOnce).toEqual({ outcome: "idle", backlog: 0 })
      currentTime = 2_000
      expect(yield* maintenance.runOnce).toEqual({ outcome: "archived", archives: [archived], backlog: 0 })
      expect(calls).toBe(2)
      expect(yield* maintenance.status).toMatchObject({
        schedulerActive: false,
        phase: "stopped",
        runs: 2,
        archived: 1,
        idle: 1,
        failed: 0,
        lastStartedAt: 2_000,
        lastFinishedAt: 2_000,
        lastSucceededAt: 2_000,
        lastResult: { outcome: "archived" },
      })
    }),
  )

  it.effect("drains a bounded batch and reports the remaining backlog", () =>
    Effect.gen(function* () {
      const candidates = [
        SessionSchema.ID.make("ses_archive_batch_1"),
        SessionSchema.ID.make("ses_archive_batch_2"),
        SessionSchema.ID.make("ses_archive_batch_3"),
      ]
      const remaining = new Set(candidates)
      const calls: string[] = []
      const maintenance = yield* make(
        Effect.die("unused"),
        () => 10_000,
        { maxArchivesPerRun: 2 },
        {
          candidateStats: Effect.sync(() => ({
            backlog: remaining.size,
            oldestEligibleAt: remaining.size ? 100 : undefined,
          })),
          candidates: (limit = 100) => Effect.sync(() => [...remaining].slice(0, limit)),
          archiveOne: (candidate) =>
            Effect.sync(() => {
              calls.push(candidate ?? "missing")
              if (!candidate) return
              remaining.delete(candidate)
              return { ...archived, sessionID: candidate }
            }),
        },
      )

      expect(yield* maintenance.runOnce).toMatchObject({
        outcome: "archived",
        archives: [{ sessionID: candidates[0] }, { sessionID: candidates[1] }],
        backlog: 1,
        oldestEligibleAt: 100,
        deferredReason: "batch-limit",
      })
      expect(calls).toEqual(candidates.slice(0, 2))
      expect(yield* maintenance.status).toMatchObject({
        runs: 1,
        archived: 2,
        backlog: 1,
        oldestEligibleAt: 100,
        deferredReason: "batch-limit",
      })
    }),
  )

  it.effect("stops a drain at its time budget after completing the current Session", () =>
    Effect.gen(function* () {
      const candidates = [
        SessionSchema.ID.make("ses_archive_budget_1"),
        SessionSchema.ID.make("ses_archive_budget_2"),
        SessionSchema.ID.make("ses_archive_budget_3"),
      ]
      const remaining = new Set(candidates)
      let currentTime = 1_000
      const maintenance = yield* make(
        Effect.die("unused"),
        () => currentTime,
        {
          maxArchivesPerRun: 3,
          maxRunMs: 50,
        },
        {
          candidateStats: Effect.sync(() => ({ backlog: remaining.size, oldestEligibleAt: 100 })),
          candidates: () => Effect.sync(() => [...remaining]),
          archiveOne: (candidate) =>
            Effect.sync(() => {
              if (!candidate) return
              remaining.delete(candidate)
              currentTime += 100
              return { ...archived, sessionID: candidate }
            }),
        },
      )

      expect(yield* maintenance.runOnce).toMatchObject({
        outcome: "archived",
        archives: [{ sessionID: candidates[0] }],
        backlog: 2,
        deferredReason: "time-budget",
      })
      expect(remaining).toEqual(new Set(candidates.slice(1)))
    }),
  )

  it.effect("backs off an unchanged failed candidate and retries after expiry", () =>
    Effect.gen(function* () {
      let calls = 0
      let currentTime = 1_000
      const maintenance = yield* make(
        Effect.suspend(() => {
          calls++
          if (calls === 1)
            return Effect.fail(new SessionArchive.IntegrityError({ sessionID, message: "candidate checksum mismatch" }))
          return Effect.succeed(undefined)
        }),
        () => currentTime,
        { failureRetryMs: 100 },
        {
          candidateStats: Effect.sync(() => ({ backlog: calls < 2 ? 1 : 0 })),
        },
      )

      expect(yield* maintenance.runOnce).toMatchObject({
        outcome: "deferred",
        deferredReason: "candidate-failed",
        failedCandidates: 1,
        candidateFailures: [{ sessionID, failedAt: 1_000, retryAt: 1_100 }],
      })
      const failedStatus = yield* maintenance.status
      expect(failedStatus).toMatchObject({
        phase: "stopped",
        runs: 1,
        failed: 1,
        candidateFailures: [{ sessionID, failedAt: 1_000, retryAt: 1_100 }],
      })
      expect(failedStatus.lastError).toBeUndefined()
      expect(failedStatus.lastFailure).toContain("candidate checksum mismatch")
      expect(failedStatus.lastFailedAt).toBe(1_000)

      currentTime = 1_050
      expect(yield* maintenance.runOnce).toMatchObject({
        outcome: "deferred",
        deferredReason: "candidate-failed",
        failedCandidates: 0,
      })
      expect(calls).toBe(1)

      currentTime = 1_100
      expect(yield* maintenance.runOnce).toEqual({ outcome: "idle", backlog: 0 })
      const retried = yield* maintenance.status
      expect(retried).toMatchObject({
        runs: 3,
        idle: 1,
        failed: 1,
        candidateFailures: [],
        lastError: undefined,
      })
      expect(retried.lastFailure).toContain("candidate checksum mismatch")
      expect(retried.lastSucceededAt).toBe(1_100)
      expect(calls).toBe(2)
    }),
  )

  it.effect("continues past a poisoned candidate and archives a healthy candidate in the same run", () =>
    Effect.gen(function* () {
      const bad = SessionSchema.ID.make("ses_archive_bad")
      const good = SessionSchema.ID.make("ses_archive_good")
      const remaining = new Set([bad, good])
      const calls: string[] = []
      const maintenance = yield* make(
        Effect.die("unused"),
        () => 2_000,
        { maxArchivesPerRun: 2 },
        {
          candidateStats: Effect.sync(() => ({ backlog: remaining.size })),
          candidates: () => Effect.sync(() => [...remaining]),
          archiveOne: (candidate) =>
            Effect.suspend(() => {
              if (!candidate) return Effect.succeed(undefined)
              calls.push(candidate)
              if (candidate === bad)
                return Effect.fail(
                  new SessionArchive.IntegrityError({ sessionID: candidate, message: "poisoned projection" }),
                )
              remaining.delete(candidate)
              return Effect.succeed({ ...archived, sessionID: candidate })
            }),
        },
      )

      expect(yield* maintenance.runOnce).toMatchObject({
        outcome: "archived",
        archives: [{ sessionID: good }],
        backlog: 1,
        deferredReason: "candidate-failed",
        failedCandidates: 1,
        candidateFailures: [{ sessionID: bad, error: "poisoned projection" }],
      })
      expect(calls).toEqual([bad, good])
      expect(yield* maintenance.status).toMatchObject({ archived: 1, failed: 1, backlog: 1 })
    }),
  )

  it.effect("starts once per scope, runs daily-style cycles, and stops without a timer leak", () =>
    Effect.gen(function* () {
      let calls = 0
      const maintenance = yield* make(
        Effect.sync(() => {
          calls++
          return archived
        }),
        Date.now,
        { intervalMs: 100, initialDelayMs: 50 },
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          expect(yield* maintenance.start).toBe(true)
          expect(yield* maintenance.start).toBe(false)
          expect(yield* maintenance.status).toMatchObject({ schedulerActive: true, phase: "waiting" })
          yield* Effect.yieldNow

          yield* TestClock.adjust(49)
          expect(calls).toBe(0)
          yield* TestClock.adjust(1)
          yield* Effect.yieldNow
          expect(calls).toBe(1)
          yield* TestClock.adjust(100)
          yield* Effect.yieldNow
          expect(calls).toBe(2)
        }),
      )

      expect(yield* maintenance.status).toMatchObject({
        schedulerActive: false,
        phase: "stopped",
        archived: 2,
      })
      yield* TestClock.adjust(500)
      expect(calls).toBe(2)
    }),
  )

  it.effect("bounds checkpoint defects and continues archiving healthy candidates", () =>
    Effect.gen(function* () {
      const bad = SessionSchema.ID.make("ses_archive_large_checkpoint_failure")
      const good = SessionSchema.ID.make("ses_archive_after_large_checkpoint_failure")
      const remaining = new Set([bad, good])
      const maintenance = yield* make(
        Effect.die("unused"),
        () => 3_000,
        {
          maxArchivesPerRun: 2,
          prepare: (candidate) =>
            candidate === bad
              ? Effect.die(new Error(`checkpoint replay failed: ${"x".repeat(100_000)}`))
              : Effect.void,
        },
        {
          candidateStats: Effect.sync(() => ({ backlog: remaining.size })),
          candidates: () => Effect.sync(() => [...remaining]),
          archiveOne: (candidate) =>
            Effect.sync(() => {
              if (!candidate) return
              remaining.delete(candidate)
              return { ...archived, sessionID: candidate }
            }),
        },
      )

      const result = yield* maintenance.runOnce
      expect(result).toMatchObject({
        outcome: "archived",
        archives: [{ sessionID: good }],
        failedCandidates: 1,
        candidateFailures: [{ sessionID: bad }],
      })
      const failure = result.candidateFailures?.[0]
      expect(failure?.error).toContain("checkpoint replay failed")
      expect(failure?.error).toContain("truncated")
      expect(failure?.error.length).toBeLessThanOrEqual(SessionArchiveMaintenance.MAX_FAILURE_DIAGNOSTIC_CHARS)
      expect(remaining).toEqual(new Set([bad]))
    }),
  )

  it.effect("keeps the scheduler alive without hot-retrying a failed archive", () =>
    Effect.gen(function* () {
      let calls = 0
      let currentTime = 1_000
      const maintenance = yield* make(
        Effect.suspend(() => {
          calls++
          if (calls === 1)
            return Effect.fail(new SessionArchive.IntegrityError({ sessionID, message: "temporary mismatch" }))
          return Effect.succeed(archived)
        }),
        () => currentTime,
        { intervalMs: 100, initialDelayMs: 10, backlogIntervalMs: 10, failureRetryMs: 20 },
        {
          candidateStats: Effect.sync(() => ({ backlog: calls < 2 ? 1 : 0 })),
        },
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          expect(yield* maintenance.start).toBe(true)
          yield* Effect.yieldNow
          yield* TestClock.adjust(10)
          yield* Effect.yieldNow
          expect(yield* maintenance.status).toMatchObject({ schedulerActive: true, failed: 1, archived: 0 })

          currentTime = 1_019
          yield* TestClock.adjust(19)
          expect(calls).toBe(1)
          expect(yield* maintenance.status).toMatchObject({ schedulerActive: true, failed: 1, archived: 0 })

          currentTime = 1_020
          yield* TestClock.adjust(1)
          yield* Effect.yieldNow
          expect(calls).toBe(2)
          expect(yield* maintenance.status).toMatchObject({ schedulerActive: true, failed: 1, archived: 1 })
        }),
      )
      expect(calls).toBe(2)
    }),
  )

  it.effect("uses a short follow-up delay while an archive backlog remains", () =>
    Effect.gen(function* () {
      const candidates = [
        SessionSchema.ID.make("ses_archive_backlog_1"),
        SessionSchema.ID.make("ses_archive_backlog_2"),
      ]
      const remaining = new Set(candidates)
      const maintenance = yield* make(
        Effect.die("unused"),
        Date.now,
        {
          intervalMs: 1_000,
          initialDelayMs: 10,
          backlogIntervalMs: 20,
          maxArchivesPerRun: 1,
        },
        {
          candidateStats: Effect.sync(() => ({ backlog: remaining.size })),
          candidates: () => Effect.sync(() => [...remaining].slice(0, 1)),
          archiveOne: (candidate) =>
            Effect.sync(() => {
              if (!candidate) return
              remaining.delete(candidate)
              return { ...archived, sessionID: candidate }
            }),
        },
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          expect(yield* maintenance.start).toBe(true)
          yield* Effect.yieldNow
          yield* TestClock.adjust(10)
          yield* Effect.yieldNow
          expect(yield* maintenance.status).toMatchObject({ archived: 1, backlog: 1 })
          yield* TestClock.adjust(19)
          expect(yield* maintenance.status).toMatchObject({ archived: 1, backlog: 1 })
          yield* TestClock.adjust(1)
          yield* Effect.yieldNow
          expect(yield* maintenance.status).toMatchObject({ archived: 2, backlog: 0 })
        }),
      )
    }),
  )

  it.effect("defers when inactive backlog exists but every candidate is busy", () =>
    Effect.gen(function* () {
      let calls = 0
      const maintenance = yield* make(
        Effect.sync(() => {
          calls++
          return archived
        }),
        Date.now,
        undefined,
        {
          candidateStats: Effect.succeed({ backlog: 2, oldestEligibleAt: 123 }),
          candidates: () => Effect.succeed([]),
        },
      )

      expect(yield* maintenance.runOnce).toEqual({
        outcome: "deferred",
        backlog: 2,
        oldestEligibleAt: 123,
        deferredReason: "candidate-busy",
      })
      expect(calls).toBe(0)
      expect(yield* maintenance.status).toMatchObject({
        deferred: 1,
        archived: 0,
        backlog: 2,
        oldestEligibleAt: 123,
        deferredReason: "candidate-busy",
      })
    }),
  )

  it.effect("requires preparation before archiving and leaves a failed candidate active", () =>
    Effect.gen(function* () {
      const order: string[] = []
      const failed = yield* make(
        Effect.sync(() => {
          order.push("archive")
          return archived
        }),
        Date.now,
        {
          prepare: (candidate) => {
            order.push(`prepare:${candidate}`)
            return Effect.fail(
              new SessionArchive.IntegrityError({ sessionID: candidate, message: "checkpoint failed" }),
            )
          },
        },
        {
          candidateStats: Effect.succeed({ backlog: 1 }),
        },
      )

      expect(yield* failed.runOnce).toMatchObject({
        outcome: "deferred",
        deferredReason: "candidate-failed",
        failedCandidates: 1,
      })
      expect(order).toEqual([`prepare:${sessionID}`])

      const prepared = yield* make(
        Effect.sync(() => {
          order.push("archive")
          return archived
        }),
        Date.now,
        {
          prepare: (candidate) => Effect.sync(() => order.push(`prepared:${candidate}`)),
        },
      )
      expect(yield* prepared.runOnce).toEqual({ outcome: "archived", archives: [archived], backlog: 0 })
      expect(order.slice(1)).toEqual([`prepared:${sessionID}`, "archive"])
    }),
  )

  it.effect("purges archived sessions with a live configurable retention", () =>
    Effect.gen(function* () {
      const inactivity: number[] = []
      let enabledCalls = 0
      const maintenance = yield* make(Effect.succeed(undefined), Date.now, undefined, {
        candidates: () => Effect.succeed([]),
        purgeCandidates: (inactiveMs) => {
          inactivity.push(inactiveMs)
          return Effect.succeed(enabledCalls++ === 0 ? [sessionID] : [])
        },
        purgeOne: (_candidate, inactiveMs) => {
          inactivity.push(inactiveMs)
          return Effect.succeed(purged)
        },
      })

      expect((yield* maintenance.status).retention).toEqual(SessionArchiveMaintenance.retentionFromDays(false, 21))
      yield* maintenance.runOnce
      expect(yield* maintenance.status).toMatchObject({ purged: 0 })
      expect(inactivity).toEqual([])

      yield* maintenance.configureRetention(SessionArchiveMaintenance.retentionFromDays(true, 30))
      yield* maintenance.runOnce
      expect(enabledCalls).toBe(1)
      expect((yield* maintenance.status).retention).toEqual(SessionArchiveMaintenance.retentionFromDays(true, 30))
    }),
  )
})

function make(
  archiveOne: ReturnType<SessionArchive.Interface["archiveOne"]>,
  now?: () => number,
  options?: SessionArchiveMaintenance.Options,
  service?: {
    readonly candidateStats?: SessionArchive.Interface["candidateStats"]
    readonly candidates?: SessionArchive.Interface["candidates"]
    readonly archiveOne?: SessionArchive.Interface["archiveOne"]
    readonly purgeCandidates?: SessionArchive.Interface["purgeCandidates"]
    readonly purgeOne?: SessionArchive.Interface["purgeOne"]
  },
) {
  return SessionArchiveMaintenance.make({ ...options, now }).pipe(
    Effect.provideService(SessionArchive.Service, archiveService(archiveOne, service)),
  )
}

function archiveService(
  archiveOne: ReturnType<SessionArchive.Interface["archiveOne"]>,
  options?: {
    readonly candidateStats?: SessionArchive.Interface["candidateStats"]
    readonly candidates?: SessionArchive.Interface["candidates"]
    readonly archiveOne?: SessionArchive.Interface["archiveOne"]
    readonly purgeCandidates?: SessionArchive.Interface["purgeCandidates"]
    readonly purgeOne?: SessionArchive.Interface["purgeOne"]
  },
) {
  const unused = Effect.die("unused SessionArchive operation")
  return SessionArchive.Service.of({
    initialize: unused,
    refreshCatalog: () => unused,
    getCatalog: () => unused,
    listCatalog: () => unused,
    candidateStats: options?.candidateStats ?? Effect.succeed({ backlog: 0 }),
    candidates: options?.candidates ?? (() => Effect.succeed([sessionID])),
    archiveOne: options?.archiveOne ?? (() => archiveOne),
    purgeCandidates: options?.purgeCandidates ?? (() => Effect.succeed([])),
    purgeOne: options?.purgeOne ?? (() => unused),
    readMessages: () => unused,
    readMessage: () => unused,
    readLegacyMessages: () => unused,
    readLegacyMessage: () => unused,
    resolveMessageTarget: () => unused,
    readAttachment: () => unused,
    readInputs: () => unused,
    readEventReplay: () => unused,
    ensureActive: () => unused,
  })
}
