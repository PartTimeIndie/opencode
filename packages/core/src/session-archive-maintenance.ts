export * as SessionArchiveMaintenance from "./session-archive-maintenance"

import { Cause, Context, Effect, Exit, Layer, Ref, Scope, Semaphore } from "effect"
import { SessionArchive } from "./session-archive"

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1_000
const DEFAULT_ACTIVE_BACKLOG_INTERVAL_MS = 30_000
const DEFAULT_MAX_ARCHIVES_PER_RUN = 25
const DEFAULT_MAX_PURGES_PER_RUN = 25
const DEFAULT_MAX_RUN_MS = 30_000
const DEFAULT_FAILURE_RETRY_MS = 60 * 60 * 1_000
export const MAX_FAILURE_DIAGNOSTIC_CHARS = 8_192
export const DEFAULT_RETENTION_DAYS = 21
export const MAX_RETENTION_DAYS = 3_650
const DAY_MS = 24 * 60 * 60 * 1_000

export type Retention = {
  readonly enabled: boolean
  readonly inactivityMs: number
}

export type DeferredReason = "candidate-busy" | "candidate-failed" | "batch-limit" | "time-budget"

export type CandidateFailure = {
  readonly sessionID: SessionArchive.ArchiveResult["sessionID"]
  readonly error: string
  readonly failedAt: number
  readonly retryAt: number
}

type RunObservation = {
  readonly backlog: number
  readonly oldestEligibleAt?: number
  readonly deferredReason?: DeferredReason
  readonly candidateFailures?: ReadonlyArray<CandidateFailure>
  readonly failedCandidates?: number
}

export type RunResult =
  | (RunObservation & { readonly outcome: "archived"; readonly archives: ReadonlyArray<SessionArchive.ArchiveResult> })
  | (RunObservation & { readonly outcome: "idle" })
  | (RunObservation & { readonly outcome: "deferred"; readonly deferredReason: DeferredReason })

export type Status = {
  readonly schedulerActive: boolean
  readonly phase: "stopped" | "waiting" | "running"
  readonly runs: number
  readonly archived: number
  readonly purged: number
  readonly idle: number
  readonly deferred: number
  readonly failed: number
  readonly candidateFailures: ReadonlyArray<CandidateFailure>
  readonly backlog: number
  readonly oldestEligibleAt?: number
  readonly deferredReason?: DeferredReason
  readonly lastStartedAt?: number
  readonly lastFinishedAt?: number
  readonly lastSucceededAt?: number
  readonly lastFailedAt?: number
  readonly nextRunAt?: number
  readonly lastResult?: RunResult
  readonly lastError?: string
  readonly lastFailure?: string
  readonly retention: Retention
}

export type Options = {
  readonly intervalMs?: number
  readonly initialDelayMs?: number
  readonly backlogIntervalMs?: number
  readonly maxArchivesPerRun?: number
  readonly maxPurgesPerRun?: number
  readonly maxRunMs?: number
  readonly failureRetryMs?: number
  readonly retention?: Partial<Retention>
  readonly prepare?: (
    sessionID: SessionArchive.ArchiveResult["sessionID"],
  ) => Effect.Effect<void, SessionArchive.IntegrityError>
  readonly now?: () => number
}

export interface Interface {
  /** Sequentially archives a bounded number of eligible Sessions; each archive keeps its own atomic cutover. */
  readonly runOnce: Effect.Effect<RunResult, SessionArchive.IntegrityError>
  /** Starts one scope-owned scheduler. A second start while active is a no-op. */
  readonly start: Effect.Effect<boolean, never, Scope.Scope>
  readonly configureRetention: (retention: Retention) => Effect.Effect<Retention>
  readonly status: Effect.Effect<Status>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionArchiveMaintenance") {}

export function make(options: Options = {}) {
  return Effect.gen(function* () {
    const archive = yield* SessionArchive.Service
    const now = options.now ?? Date.now
    const intervalMs = positiveDuration(options.intervalMs ?? DEFAULT_INTERVAL_MS)
    const initialDelayMs = nonNegativeDuration(
      options.initialDelayMs ?? Math.min(intervalMs, DEFAULT_ACTIVE_BACKLOG_INTERVAL_MS),
    )
    const backlogIntervalMs = positiveDuration(
      options.backlogIntervalMs ?? Math.min(intervalMs, DEFAULT_ACTIVE_BACKLOG_INTERVAL_MS),
    )
    const maxArchivesPerRun = positiveCount(options.maxArchivesPerRun ?? DEFAULT_MAX_ARCHIVES_PER_RUN)
    const maxPurgesPerRun = positiveCount(
      options.maxPurgesPerRun ?? DEFAULT_MAX_PURGES_PER_RUN,
      DEFAULT_MAX_PURGES_PER_RUN,
    )
    const maxRunMs = positiveDuration(options.maxRunMs ?? DEFAULT_MAX_RUN_MS, DEFAULT_MAX_RUN_MS)
    const failureRetryMs = positiveDuration(
      options.failureRetryMs ?? DEFAULT_FAILURE_RETRY_MS,
      DEFAULT_FAILURE_RETRY_MS,
    )
    const exclusive = Semaphore.makeUnsafe(1).withPermit
    const candidateFailures = new Map<SessionArchive.ArchiveResult["sessionID"], CandidateFailure>()
    const state = yield* Ref.make<Status>({
      schedulerActive: false,
      phase: "stopped",
      runs: 0,
      archived: 0,
      purged: 0,
      idle: 0,
      deferred: 0,
      failed: 0,
      candidateFailures: [],
      backlog: 0,
      retention: normalizeRetention(options.retention),
    })

    const drain = (
      candidates: ReadonlyArray<SessionArchive.ArchiveResult["sessionID"]>,
      startedAt: number,
      archives: ReadonlyArray<SessionArchive.ArchiveResult> = [],
      failures: ReadonlyArray<CandidateFailure> = [],
      backedOff = 0,
    ): Effect.Effect<{
      readonly archives: ReadonlyArray<SessionArchive.ArchiveResult>
      readonly failures: ReadonlyArray<CandidateFailure>
      readonly backedOff: number
      readonly timeLimited: boolean
    }, SessionArchive.IntegrityError> => {
      const candidate = candidates[0]
      if (!candidate || archives.length >= maxArchivesPerRun)
        return Effect.succeed({ archives, failures, backedOff, timeLimited: false })
      if (archives.length > 0 && now() - startedAt >= maxRunMs)
        return Effect.succeed({ archives, failures, backedOff, timeLimited: true })
      const blocked = candidateFailures.get(candidate)
      if (blocked && blocked.retryAt > now())
        return drain(candidates.slice(1), startedAt, archives, failures, backedOff + 1)
      candidateFailures.delete(candidate)
      return Effect.gen(function* () {
        const attempted = yield* Effect.gen(function* () {
          if (options.prepare) yield* options.prepare(candidate)
          return yield* archive.archiveOne(candidate)
        }).pipe(Effect.exit)
        if (Exit.isSuccess(attempted))
          return yield* drain(
            candidates.slice(1),
            startedAt,
            attempted.value ? [...archives, attempted.value] : archives,
            failures,
            backedOff,
          )
        if (Cause.hasInterruptsOnly(attempted.cause)) return yield* Effect.failCause(attempted.cause)
        const failedAt = now()
        const failure = {
          sessionID: candidate,
          error: failureDiagnostic(attempted.cause),
          failedAt,
          retryAt: failedAt + failureRetryMs,
        } satisfies CandidateFailure
        candidateFailures.set(candidate, failure)
        return yield* drain(candidates.slice(1), startedAt, archives, [...failures, failure], backedOff)
      })
    }

    const archiveRun = Effect.gen(function* () {
      const observed = yield* archive.candidateStats
      yield* Ref.update(state, (current) => ({
        ...current,
        backlog: observed.backlog,
        oldestEligibleAt: observed.oldestEligibleAt,
        deferredReason: undefined,
      }))
      const candidates = yield* archive.candidates(Math.min(1_000, maxArchivesPerRun + candidateFailures.size))
      if (candidates.length === 0) {
        if (observed.backlog === 0) return { outcome: "idle", ...observed } as const
        return { outcome: "deferred", ...observed, deferredReason: "candidate-busy" } as const
      }

      const drained = yield* drain(candidates, now())
      const remaining = yield* archive.candidateStats
      const failures = candidateFailures.size > 0 ? [...candidateFailures.values()] : undefined
      if (drained.archives.length === 0) {
        if (remaining.backlog === 0) return { outcome: "idle", ...remaining } as const
        if (drained.failures.length > 0 || drained.backedOff > 0)
          return {
            outcome: "deferred",
            ...remaining,
            deferredReason: "candidate-failed",
            failedCandidates: drained.failures.length,
            ...(failures ? { candidateFailures: failures } : {}),
          } as const
        return { outcome: "deferred", ...remaining, deferredReason: "candidate-busy" } as const
      }
      const deferredReason =
        remaining.backlog === 0
          ? undefined
          : drained.timeLimited
            ? ("time-budget" as const)
            : drained.archives.length === maxArchivesPerRun
              ? ("batch-limit" as const)
              : drained.failures.length > 0 || drained.backedOff > 0
                ? ("candidate-failed" as const)
                : ("candidate-busy" as const)
      return {
        outcome: "archived",
        archives: drained.archives,
        ...remaining,
        ...(deferredReason ? { deferredReason } : {}),
        ...(drained.failures.length > 0 ? { failedCandidates: drained.failures.length } : {}),
        ...(failures ? { candidateFailures: failures } : {}),
      } as const
    })

    const purgeRun = Effect.gen(function* () {
      const retention = (yield* Ref.get(state)).retention
      if (!retention.enabled) return []
      const candidates = yield* archive.purgeCandidates(retention.inactivityMs, maxPurgesPerRun)
      return yield* Effect.forEach(candidates, (candidate) => archive.purgeOne(candidate, retention.inactivityMs), {
        concurrency: 1,
      }).pipe(Effect.map((results) => results.filter((result): result is SessionArchive.PurgeResult => !!result)))
    })

    const runOnce = exclusive(
      Effect.gen(function* () {
        yield* Ref.update(state, (current) => ({
          ...current,
          phase: "running" as const,
          runs: current.runs + 1,
          lastStartedAt: now(),
          lastError: undefined,
        }))

        const exit = yield* Effect.gen(function* () {
          const purged = yield* purgeRun
          const result = yield* archiveRun
          return { purged, result }
        }).pipe(Effect.exit)
        if (Exit.isFailure(exit)) {
          const failure = Cause.hasInterruptsOnly(exit.cause) ? undefined : Cause.pretty(exit.cause)
          const finishedAt = now()
          yield* Ref.update(state, (current) => ({
            ...current,
            phase: current.schedulerActive ? ("waiting" as const) : ("stopped" as const),
            failed: current.failed + (failure ? 1 : 0),
            lastFinishedAt: finishedAt,
            lastFailedAt: failure ? finishedAt : current.lastFailedAt,
            lastError: failure ?? current.lastError,
            lastFailure: failure ?? current.lastFailure,
          }))
          return yield* Effect.failCause(exit.cause)
        }

        const result: RunResult = exit.value.result
        const finishedAt = now()
        const latestFailure = result.candidateFailures?.at(-1)
        yield* Ref.update(state, (current) => ({
          ...current,
          phase: current.schedulerActive ? ("waiting" as const) : ("stopped" as const),
          archived: current.archived + (result.outcome === "archived" ? result.archives.length : 0),
          purged: current.purged + exit.value.purged.length,
          idle: current.idle + (result.outcome === "idle" ? 1 : 0),
          deferred: current.deferred + (result.outcome === "deferred" ? 1 : 0),
          failed: current.failed + (result.failedCandidates ?? 0),
          candidateFailures: result.candidateFailures ?? [],
          backlog: result.backlog,
          oldestEligibleAt: result.oldestEligibleAt,
          deferredReason: result.deferredReason,
          lastFinishedAt: finishedAt,
          lastSucceededAt: finishedAt,
          lastFailedAt: latestFailure?.failedAt ?? current.lastFailedAt,
          lastResult: result,
          lastError: undefined,
          lastFailure: latestFailure?.error ?? current.lastFailure,
        }))
        return result
      }),
    )

    const scheduledRun = runOnce.pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
        return Effect.logError("Session archive maintenance failed", { cause: Cause.pretty(cause) })
      }),
      Effect.asVoid,
    )

    const waitAndRun = (delay: number) =>
      Effect.gen(function* () {
        yield* Ref.update(state, (current) => ({
          ...current,
          phase: "waiting" as const,
          nextRunAt: now() + delay,
        }))
        yield* Effect.sleep(delay)
        yield* scheduledRun
      })

    const schedule = (delay: number): Effect.Effect<void, SessionArchive.IntegrityError> =>
      waitAndRun(delay).pipe(
        Effect.andThen(
          Effect.suspend(() =>
            Ref.get(state).pipe(
              Effect.flatMap((current) => {
                if (current.deferredReason !== "candidate-failed")
                  return schedule(current.backlog > 0 ? backlogIntervalMs : intervalMs)
                const retryAt = current.candidateFailures.reduce(
                  (earliest, failure) => Math.min(earliest, failure.retryAt),
                  Number.POSITIVE_INFINITY,
                )
                const delay = Number.isFinite(retryAt)
                  ? Math.max(backlogIntervalMs, Math.min(intervalMs, retryAt - now()))
                  : intervalMs
                return schedule(delay)
              }),
            ),
          ),
        ),
      )

    const start = Effect.gen(function* () {
      const claimed = yield* Ref.modify(state, (current) => {
        if (current.schedulerActive) return [false, current] as const
        return [
          true,
          {
            ...current,
            schedulerActive: true,
            phase: "waiting" as const,
            nextRunAt: now() + initialDelayMs,
          },
        ] as const
      })
      if (!claimed) return false

      yield* Effect.forkScoped(
        schedule(initialDelayMs).pipe(
          Effect.ensuring(
            Ref.update(state, (current) => ({
              ...current,
              schedulerActive: false,
              phase: "stopped" as const,
              nextRunAt: undefined,
            })),
          ),
        ),
      )
      return true
    })

    const configureRetention: Interface["configureRetention"] = (retention) =>
      Ref.modify(state, (current) => {
        const normalized = normalizeRetention(retention)
        return [normalized, { ...current, retention: normalized }] as const
      })

    return Service.of({ runOnce, start, configureRetention, status: Ref.get(state) })
  })
}

export const layer = (options?: Options) => Layer.effect(Service, make(options))

function positiveDuration(value: number, fallback = DEFAULT_INTERVAL_MS) {
  if (Number.isFinite(value) && value > 0) return value
  return fallback
}

function positiveCount(value: number, fallback = DEFAULT_MAX_ARCHIVES_PER_RUN) {
  if (Number.isFinite(value) && value > 0) return Math.floor(value)
  return fallback
}

function nonNegativeDuration(value: number) {
  if (Number.isFinite(value) && value >= 0) return value
  return DEFAULT_INTERVAL_MS
}

function failureDiagnostic(cause: Cause.Cause<unknown>) {
  const error = Cause.squash(cause)
  const value =
    error instanceof SessionArchive.IntegrityError
      ? error.message
      : error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error)
  if (value.length <= MAX_FAILURE_DIAGNOSTIC_CHARS) return value
  const marker = `... diagnostic truncated (${value.length} chars total) ...`
  const remaining = MAX_FAILURE_DIAGNOSTIC_CHARS - marker.length
  return `${value.slice(0, Math.ceil(remaining / 2))}${marker}${value.slice(-Math.floor(remaining / 2))}`
}

export function retentionFromDays(enabled = false, inactivityDays = DEFAULT_RETENTION_DAYS): Retention {
  const days =
    Number.isFinite(inactivityDays) && inactivityDays > 0
      ? Math.min(Math.floor(inactivityDays), MAX_RETENTION_DAYS)
      : DEFAULT_RETENTION_DAYS
  return { enabled, inactivityMs: days * DAY_MS }
}

function normalizeRetention(retention?: Partial<Retention>) {
  const fallback = retentionFromDays()
  return {
    enabled: retention?.enabled ?? fallback.enabled,
    inactivityMs: positiveDuration(retention?.inactivityMs ?? fallback.inactivityMs, fallback.inactivityMs),
  }
}
