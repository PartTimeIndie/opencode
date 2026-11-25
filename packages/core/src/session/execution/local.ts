export * as SessionExecutionLocal from "./local"

import { Cause, Clock, Deferred, Effect, Exit, Fiber, Layer, Option } from "effect"
import { and, eq, inArray, isNotNull } from "drizzle-orm"
import { LocationServiceMap } from "../../location-layer"
import { SessionRunCoordinator } from "../run-coordinator"
import { SessionRunner } from "../runner"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { SessionExecution } from "../execution"
import { SessionActivity } from "../activity"
import { SessionToolCancellation } from "../tool-cancellation"
import { SessionInput } from "../input"
import { Identifier } from "../../util/identifier"
import { Database } from "../../database/database"
import { logFailure } from "../logging"
import { TaskJob } from "../../tool/task-job"
import { QuestionV2 } from "../../question"
import { QuestionTable } from "../../question/sql"
import { SessionWakeup } from "../wakeup"
import { EventV2 } from "../../event"
import { SessionEvent } from "../event"
import { SessionLinks } from "../links"
import { SessionFailure } from "../failure"
import { SessionSupervision } from "../supervision"
import { SettlementWatchdog } from "../settlement-watchdog"
import { SessionExecutionOwner } from "./owner"
import { WorkspaceCheckout } from "../workspace/checkout"
import { DesktopRecovery } from "../desktop-recovery"
import { SessionActivityTable } from "../sql"

export const DESKTOP_STARTUP_RECOVERY_DELAY_MS = 65_000

export function startupRecoveryDelayMs(env: Readonly<Record<string, string | undefined>> = process.env) {
  return env.OPENCODE_DEFER_BACKGROUND_STARTUP === "1" ? DESKTOP_STARTUP_RECOVERY_DELAY_MS : 5_000
}

export const hasPendingBlockingQuestion = (db: Database.Interface["db"], sessionID: SessionSchema.ID) =>
  db
    .select({ id: QuestionTable.id })
    .from(QuestionTable)
    .where(
      and(
        eq(QuestionTable.session_id, sessionID),
        eq(QuestionTable.detached, false),
        eq(QuestionTable.mode, "blocking"),
        inArray(QuestionTable.state, ["queued", "active"]),
      ),
    )
    .get()
    .pipe(
      Effect.orDie,
      Effect.map((row) => row !== undefined),
    )

/** Current-process routing for implicit-local Locations. Future remote placement belongs here. */
export const layer = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap
    const activity = yield* SessionActivity.Service
    const events = yield* EventV2.Service
    const { db } = yield* Database.Service
    const ownerID = DesktopRecovery.claimOwner("owner_" + Identifier.ascending())
    const crashRequests = new Map<SessionSchema.ID, { activityID: string; previousOwner: string }>()
    const crashCohort = new Set<string>()
    const activeActivityBySession = new Map<SessionSchema.ID, string>()
    const activityHeartbeatAt = new Map<string, number>()
    const explicitlyInterrupted = new Set<SessionSchema.ID>()
    const ownershipLost = new Map<SessionSchema.ID, string>()
    yield* Effect.addFinalizer(() =>
      activity.prepareOwnerShutdown(ownerID, SessionActivity.interruptReason("owner-shutdown")).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            activeActivityBySession.forEach(SessionActivity.releaseLocal)
            activeActivityBySession.clear()
            activityHeartbeatAt.clear()
            explicitlyInterrupted.clear()
            ownershipLost.clear()
          }),
        ),
        Effect.ignore,
      ),
    )
    const coordinator = yield* SessionRunCoordinator.make<SessionSchema.ID, void, SessionRunner.RunError>({
      drain: Effect.fnUntraced(function* (sessionID: SessionSchema.ID, mode) {
        const crash = mode === "recovery" ? crashRequests.get(sessionID) : undefined
        if (mode === "recovery") {
          crashRequests.delete(sessionID)
          if (!crash) return
        }
        const session = yield* store.get(sessionID)
        if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
        yield* WorkspaceCheckout.assertSession(db, sessionID)
        if (!crash && (yield* hasPendingBlockingQuestion(db, sessionID))) return
        // Advisory wakes may outlive the input already consumed by an active drain.
        // Do not let their no-op successors overwrite a failed run with a completed activity.
        if (
          mode === "wake" &&
          !(yield* SessionInput.hasPending(db, sessionID, "steer")) &&
          !(yield* SessionInput.hasPending(db, sessionID, "queue"))
        )
          return
        const openedSeq = yield* SessionInput.latestSeq(db, sessionID)
        return yield* Effect.scoped(
          withLocalActivity(
            activity,
            activeActivityBySession,
            activityHeartbeatAt,
            {
              sessionID,
              kind: mode === "recovery" ? "recovery" : mode === "run" ? "resume" : "prompt",
              crash,
              ownerID,
              leaseDurationMs: SessionActivity.LEASE_DURATION_MS,
              openedSeq,
            },
            (act) =>
              Effect.gen(function* () {
                const ownershipLostSignal = yield* Deferred.make<void>()
                activityHeartbeatAt.set(act.id, yield* Clock.currentTimeMillis)
                const heartbeatFiber = yield* activityHeartbeat(activity, act.id, ownerID, activityHeartbeatAt, () =>
                  Effect.sync(() => {
                    if (activeActivityBySession.get(sessionID) !== act.id) return false
                    ownershipLost.set(sessionID, act.id)
                    return true
                  }).pipe(
                    Effect.flatMap((marked) =>
                      marked ? Deferred.succeed(ownershipLostSignal, undefined).pipe(Effect.asVoid) : Effect.void,
                    ),
                  ),
                ).pipe(Effect.forkScoped)
                return yield* Effect.raceFirst(
                  SessionExecutionOwner.withOwner(
                    { sessionID, activityID: act.id, ownerID },
                    SessionRunner.Service.use((runner) => runner.run({ sessionID, force: mode !== "wake" })).pipe(
                      Effect.provide(locations.get(session.location)),
                    ),
                  ),
                  Deferred.await(ownershipLostSignal).pipe(Effect.andThen(Effect.interrupt)),
                ).pipe(
                  Effect.catchTag("SessionRunner.UserDeclinedError", () =>
                    Effect.sync(() => explicitlyInterrupted.add(sessionID)).pipe(Effect.andThen(Effect.interrupt)),
                  ),
                  Effect.onExit((exit) =>
                    Effect.uninterruptible(
                      Effect.gen(function* () {
                        const wasExplicitlyInterrupted = explicitlyInterrupted.delete(sessionID)
                        yield* Fiber.interrupt(heartbeatFiber)
                        deactivateLocalActivity(activeActivityBySession, activityHeartbeatAt, sessionID, act.id)
                        const lostOwnership = ownershipLost.get(sessionID) === act.id
                        if (lostOwnership) ownershipLost.delete(sessionID)
                        const closedSeq = yield* SessionInput.latestSeq(db, sessionID)
                        yield* terminalizeActivity(activity, {
                          activityID: act.id,
                          ownerID,
                          explicitlyInterrupted: wasExplicitlyInterrupted,
                          ownershipLost: lostOwnership,
                          closedSeq,
                          exit,
                          explicitInterruptReason: SessionActivity.interruptReason("user-stop"),
                        })
                        // Result delivery retries only a durable inbox admission. It must
                        // never change the worker's terminal outcome or rerun its provider.
                        yield* SessionLinks.Service.use((voice) => voice.deliver(sessionID)).pipe(
                          Effect.provide(locations.get(session.location)),
                          Effect.catchCause((cause) =>
                            Effect.logError("Failed to deliver linked session result", {
                              sessionID,
                              cause: Cause.pretty(cause),
                            }),
                          ),
                        )
                      }),
                    ),
                  ),
                )
              }),
          ),
        )
      }),
      onFailure: (sessionID, cause) => logFailure("Failed to drain Session", sessionID, cause),
    })

    // Provider streams can keep producing useful deltas while delaying the timer-driven
    // heartbeat fiber. Treat live, non-replayed session events as a throttled lease pulse too.
    const unsubscribeProgressHeartbeat = yield* events.listen((event) =>
      heartbeatActivityProgress(activity, activeActivityBySession, activityHeartbeatAt, ownerID, event, (sessionID, activityID) =>
        Effect.sync(() => {
          if (activeActivityBySession.get(sessionID) !== activityID) return false
          ownershipLost.set(sessionID, activityID)
          return true
        }).pipe(
          Effect.flatMap((marked) => (marked ? coordinator.interrupt(sessionID) : Effect.void)),
        ),
      ),
    )
    yield* Effect.addFinalizer(() => unsubscribeProgressHeartbeat)

    const executionService = SessionExecution.Service.of({
      interrupt: (sessionID, seq) =>
        Effect.gen(function* () {
          const session = yield* store.get(sessionID)
          if (session) {
            yield* Effect.all(
              [
                SessionToolCancellation.Service.use((cancellation) => cancellation.cancelSession(sessionID)),
                QuestionV2.Service.use((questions) => questions.dismissSession(sessionID)),
              ],
              { discard: true },
            ).pipe(Effect.provide(locations.get(session.location)))
          }
          yield* interruptActivity(
            activeActivityBySession,
            explicitlyInterrupted,
            sessionID,
            coordinator.interrupt(sessionID, seq),
          )
        }),
      interruptActivity: (sessionID, activityID, seq) =>
        interruptOwnedActivity(
          activeActivityBySession,
          explicitlyInterrupted,
          sessionID,
          activityID,
          coordinator.interrupt(sessionID, seq),
        ),
      cancelTool: (sessionID, callID) =>
        Effect.gen(function* () {
          const session = yield* store.get(sessionID)
          if (!session) return false
          const cancelled = yield* SessionToolCancellation.Service.use((cancellation) =>
            cancellation.cancel({ sessionID, callID }),
          ).pipe(Effect.provide(locations.get(session.location)))
          if (cancelled) return true
          return yield* reconcilePendingTool(store, coordinator, sessionID, callID)
        }),
      resume: coordinator.run,
      withIdle: coordinator.withIdle,
      resumeOrJoin: coordinator.runOrJoin,
      wake: coordinator.wake,
      queueContinuation: coordinator.queueContinuation,
      wait: (sessionID) =>
        coordinator.awaitIdle(sessionID).pipe(
          Effect.catchCause((cause) => {
            // switchAgent/interrupt settle the awaited run with a pure Interrupt
            // cause. That expected runner exit must not interrupt the awaiting
            // caller â€” an interrupted HTTP request fiber answers an empty 503.
            // Real typed failures and defects still propagate.
            const onlyInterrupts = cause.reasons.length > 0 && cause.reasons.every((reason) => Cause.isInterruptReason(reason))
            return onlyInterrupts ? Effect.void : Effect.failCause(cause)
          }),
          Effect.ignore,
        ),
    })

    yield* locations.bindExecution(executionService)
    yield* SessionWakeup.listen((sessionID, admittedSeq) =>
      executionService.wake(sessionID, admittedSeq).pipe(Effect.ignore),
    )
    yield* listenForControlledQuestionReplies(activity, db, executionService.queueContinuation)

    // Trigger startup recovery after the execution layer is fully constructed
    if (process.env.OPENCODE_DISABLE_SESSION_RECOVERY !== "1") {
      // The process-global loop resolves settings on each cycle: project config
      // can be published after this layer starts, and reloads can change it.
      yield* Effect.sleep(startupRecoveryDelayMs()).pipe(
        Effect.andThen(SettlementWatchdog.run({ activity, db, excludeIDs: () => crashCohort })),
        Effect.catchCause((cause) =>
          Effect.logError("SettlementWatchdog: loop failed", { cause: Cause.pretty(cause) }).pipe(Effect.asVoid),
        ),
        Effect.forkScoped,
      )
      yield* Effect.sleep(startupRecoveryDelayMs()).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const predecessors = DesktopRecovery.predecessors()
            if (predecessors.length) {
              const candidates = yield* db.select().from(SessionActivityTable).where(and(
                inArray(SessionActivityTable.owner_id, [...predecessors]),
                inArray(SessionActivityTable.status, ["running", "recovering"]),
              )).all().pipe(Effect.orDie)
              for (const candidate of candidates) {
                if (!candidate.owner_id) continue
                crashCohort.add(candidate.id)
                crashRequests.set(candidate.session_id, { activityID: candidate.id, previousOwner: candidate.owner_id })
                yield* coordinator.recover(candidate.session_id).pipe(
                  Effect.catchCause((cause) => Cause.hasInterruptsOnly(cause) ? Effect.void :
                    Effect.logError("Desktop crash recovery paused", { sessionID: candidate.session_id, cause: Cause.pretty(cause) })),
                  Effect.ensuring(Effect.sync(() => {
                    crashCohort.delete(candidate.id)
                    crashRequests.delete(candidate.session_id)
                  })),
                  Effect.forkScoped,
                )
              }
            }
            yield* runStartupRecovery(activity, db,
              () => new Set([...activeActivityBySession.values(), ...crashCohort]), executionService.resume)
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logError("SessionRecovery: startup failed", { cause: Cause.pretty(cause) }).pipe(Effect.asVoid),
        ),
        Effect.andThen(
          SessionLinks.reconcile(db, (sessionID) =>
            Effect.gen(function* () {
              const session = yield* store.get(sessionID)
              if (!session) return
              yield* SessionLinks.Service.use((voice) => voice.deliver(sessionID)).pipe(
                Effect.provide(locations.get(session.location)),
              )
            }),
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("SessionLinks: startup reconciliation failed", { cause: Cause.pretty(cause) }),
            ),
          ),
        ),
        Effect.forkScoped,
      )
    }

    return executionService
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(SessionStore.defaultLayer))

export const interruptActivity = (
  activeActivityBySession: Map<SessionSchema.ID, string>,
  explicitlyInterrupted: Set<SessionSchema.ID>,
  sessionID: SessionSchema.ID,
  interrupt: Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const activityID = activeActivityBySession.get(sessionID)
    if (activityID === undefined) return yield* interrupt
    explicitlyInterrupted.add(sessionID)
    yield* interrupt
  })

export const interruptOwnedActivity = (
  activeActivityBySession: Map<SessionSchema.ID, string>,
  explicitlyInterrupted: Set<SessionSchema.ID>,
  sessionID: SessionSchema.ID,
  activityID: string,
  interrupt: Effect.Effect<void>,
) =>
  Effect.suspend(() => {
    if (activeActivityBySession.get(sessionID) !== activityID) return Effect.succeed(false)
    return interruptActivity(activeActivityBySession, explicitlyInterrupted, sessionID, interrupt).pipe(Effect.as(true))
  })

export const reconcilePendingTool = (
  store: SessionStore.Interface,
  coordinator: SessionRunCoordinator.Coordinator<SessionSchema.ID, void, SessionRunner.RunError>,
  sessionID: SessionSchema.ID,
  callID: string,
) =>
  Effect.gen(function* () {
    const pending = (yield* store.context(sessionID).pipe(Effect.orDie)).some(
      (message) =>
        message.type === "assistant" &&
        message.content.some(
          (part) =>
            part.type === "tool" &&
            part.id === callID &&
            (part.state.status === "pending" || part.state.status === "running"),
        ),
    )
    if (!pending) return false
    yield* coordinator.interrupt(sessionID)
    yield* coordinator.queueContinuation(sessionID)
    return true
  })

export const terminalizeActivity = (
  activity: SessionActivity.Interface,
  input: {
    readonly activityID: string
    readonly ownerID: string
    readonly explicitlyInterrupted: boolean
    readonly ownershipLost?: boolean
    readonly closedSeq: number
    readonly exit: Exit.Exit<unknown, unknown>
    readonly explicitInterruptReason?: string
  },
) =>
  Effect.gen(function* () {
    if (input.ownershipLost) return
    if (input.exit._tag === "Success") {
      yield* activity.complete(input.activityID, input.ownerID, input.closedSeq).pipe(Effect.ignore)
      return
    }
    if (input.explicitlyInterrupted) {
      yield* activity
        .interrupt(input.activityID, input.ownerID, input.closedSeq, input.explicitInterruptReason)
        .pipe(Effect.ignore)
      return
    }
    if (
      Cause.hasInterrupts(input.exit.cause) &&
      input.exit.cause.reasons.some(
        (reason) => Cause.isFailReason(reason) && reason.error instanceof SessionRunner.ProviderInterruptedError,
      )
    ) {
      yield* activity.interrupt(input.activityID, input.ownerID, input.closedSeq, "owner-interrupted").pipe(Effect.ignore)
      return
    }
    if (Cause.hasInterruptsOnly(input.exit.cause)) {
      yield* activity.prepareOwnerShutdown(input.ownerID, "owner-interrupted").pipe(Effect.ignore)
      return
    }
    const error = Option.getOrUndefined(Cause.findErrorOption(input.exit.cause))
    const failure =
      error && typeof error === "object" && "_tag" in error && error._tag === "Integration.Authorization"
        ? SessionFailure.make("provider.auth")
        : undefined
    yield* activity
      .fail(input.activityID, input.ownerID, Cause.pretty(input.exit.cause), input.closedSeq, failure)
      .pipe(Effect.ignore)
  })

export const activityHeartbeat = (
  activity: SessionActivity.Interface,
  activityID: string,
  ownerID: string,
  heartbeatAt: Map<string, number>,
  onOwnershipLost: () => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    let missed = 0
    const renew = Effect.gen(function* () {
      const renewed = yield* activity.heartbeat(activityID, ownerID, SessionActivity.LEASE_DURATION_MS).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause)
            : Effect.as(
              Effect.logWarning("SessionActivity: heartbeat renewal failed", { activityID, missed }),
              "error" as const,
            )),
      )
      // Wall-clock backstop after the outcome: a slow or stalled renewal must
      // not postpone ownership loss past the durable lease window. Successful
      // renewals restamp the map, so staleness here means real silence.
      const now = yield* Clock.currentTimeMillis
      const lastStamp = heartbeatAt.get(activityID)
      if (lastStamp !== undefined &&
        now - lastStamp >= SessionActivity.LEASE_DURATION_MS - SessionActivity.HEARTBEAT_INTERVAL_MS) {
        yield* onOwnershipLost()
        return
      }
      // A thrown renewal defect may recover on the next tick, but two
      // consecutive misses must report ownership loss visibly instead of
      // running on a silently expired lease. A false renewal already proves
      // the row is lost and reports ownership loss immediately.
      if (renewed === "error") {
        missed++
        if (missed >= 2) { yield* onOwnershipLost(); return }
        return
      }
      if (!renewed) { yield* onOwnershipLost(); return }
      missed = 0
      heartbeatAt.set(activityID, now)
    })
    yield* Effect.forever(Effect.sleep(SessionActivity.HEARTBEAT_INTERVAL_MS).pipe(Effect.andThen(renew)))
  })

export const heartbeatActivityProgress = (
  activity: SessionActivity.Interface,
  activeActivityBySession: ReadonlyMap<SessionSchema.ID, string>,
  heartbeatAt: Map<string, number>,
  ownerID: string,
  event: { readonly type?: string; readonly data?: unknown; readonly replay?: boolean },
  onOwnershipLost: (sessionID: SessionSchema.ID, activityID: string) => Effect.Effect<void> = () => Effect.void,
) =>
  Effect.gen(function* () {
    if (event.replay) return
    if (
      event.type === SessionEvent.Activity.Completed.type ||
      event.type === SessionEvent.Activity.Failed.type ||
      event.type === SessionEvent.Activity.Interrupted.type ||
      event.type === QuestionV2.Event.Replied.type ||
      event.type === QuestionV2.Event.Dismissed.type
    )
      return
    const data = event.data
    if (!data || typeof data !== "object" || !("sessionID" in data) || typeof data.sessionID !== "string") return
    const activityID = activeActivityBySession.get(SessionSchema.ID.make(data.sessionID))
    if (!activityID) return
    const now = yield* Clock.currentTimeMillis
    if (now - (heartbeatAt.get(activityID) ?? 0) < SessionActivity.HEARTBEAT_INTERVAL_MS) return
    const renewed = yield* activity.heartbeat(activityID, ownerID, SessionActivity.LEASE_DURATION_MS)
    if (!renewed) return yield* onOwnershipLost(SessionSchema.ID.make(data.sessionID), activityID)
    heartbeatAt.set(activityID, now)
  }).pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterrupts(cause)) return Effect.failCause(cause)
      return Effect.logWarning("SessionActivity: progress heartbeat failed", { cause }).pipe(Effect.asVoid)
    }),
  )

export const withLocalActivity = <A, E, R>(
  activity: SessionActivity.Interface,
  activeActivityBySession: Map<SessionSchema.ID, string>,
  heartbeatAt: Map<string, number>,
  input: Parameters<SessionActivity.Interface["open"]>[0],
  use: (info: SessionActivity.Info) => Effect.Effect<A, E, R>,
) =>
  Effect.suspend(() => {
    const claimed = { id: "" }
    const cleanup = Effect.suspend(() => {
      if (!claimed.id) return Effect.void
      return activity
        .prepareActivityShutdown(claimed.id, input.ownerID, SessionActivity.interruptReason("owner-interrupted"))
        .pipe(
          Effect.ensuring(
            Effect.sync(() =>
              deactivateLocalActivity(activeActivityBySession, heartbeatAt, input.sessionID, claimed.id),
            ),
          ),
          Effect.ignore,
        )
    })
    return Effect.uninterruptibleMask((restore) =>
      restore(
        activity.open({
          ...input,
          onClaim: (info) => {
            claimed.id = info.id
            activeActivityBySession.set(input.sessionID, info.id)
            SessionActivity.retainLocal(info.id)
          },
        }),
      ).pipe(
        Effect.flatMap((info) => restore(use(info))),
        Effect.ensuring(cleanup),
      ),
    )
  })

function deactivateLocalActivity(
  activeActivityBySession: Map<SessionSchema.ID, string>,
  heartbeatAt: Map<string, number>,
  sessionID: SessionSchema.ID,
  activityID: string,
) {
  SessionActivity.releaseLocal(activityID)
  heartbeatAt.delete(activityID)
  if (activeActivityBySession.get(sessionID) === activityID) activeActivityBySession.delete(sessionID)
}

/**
 * Internal startup recovery terminalizes abandoned provider work without replaying durable pending inputs.
 * Only an activity explicitly released by a graceful owner shutdown is queued for one forced continuation.
 * Unknown/crashed owners remain interrupted until clustered execution has an explicit replay policy.
 *
 * A restart can happen before a foreign owner's lease expires. In that case the
 * initial scan must not steal it, but it also cannot be the only scan: schedule
 * exactly one guarded follow-up after the latest foreign lease expiry observed
 * in the startup cohort. The follow-up re-checks ownership through the
 * stale-lease predicate, so a live owner that heartbeats is never taken over.
 */
export const runStartupRecovery = (
  activity: SessionActivity.Interface,
  db: Database.Interface["db"],
  activeActivityIDs: () => ReadonlySet<string> = () => new Set(),
  resumeControlled?: (sessionID: SessionSchema.ID) => Effect.Effect<void, unknown>,
) =>
  Effect.gen(function* () {
    yield* Effect.logInfo("SessionRecovery: scanning for interrupted work")
    const recover = () =>
      Effect.all(
        [
          Effect.sync(activeActivityIDs).pipe(
            Effect.flatMap((ids) => interruptStaleActivities(activity, db, ids)),
            Effect.catchCause((cause) =>
              Effect.logError("SessionRecovery: stale activity scan failed", {
                cause: Cause.pretty(cause),
              }).pipe(Effect.as(new Set<SessionSchema.ID>())),
            ),
          ),
          recoverStaleTaskJobs(db),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.map(([sessions]) => sessions))
    const recoverAndResume = () =>
      recover().pipe(
        Effect.tap((sessions) =>
          resumeControlled ? resumeControlledShutdowns(resumeControlled, sessions) : Effect.void,
        ),
      )
    yield* recoverAndResume()
    const latestLeaseUntil = yield* activity.latestLeaseUntil(activeActivityIDs())
    if (latestLeaseUntil !== undefined) {
      const now = yield* Clock.currentTimeMillis
      const delay = SessionSupervision.recoveryScanDelayMs({ now, leaseUntil: latestLeaseUntil })
      yield* Effect.sleep(`${delay} millis`).pipe(
        Effect.andThen(recoverAndResume().pipe(Effect.asVoid)),
        Effect.forkScoped,
      )
    }

    yield* Effect.logInfo("SessionRecovery: startup scan complete")
  })

/**
 * A restarted process has no waiter attached to the old Surface tool promise. Once the
 * durable reply commits, atomically terminalize its released activity and force one retry
 * through the coordinator. The persisted tool key returns the recorded answer on that retry.
 */
export const listenForControlledQuestionReplies = (
  activity: SessionActivity.Interface,
  db: Database.Interface["db"],
  continueSession: (sessionID: SessionSchema.ID) => Effect.Effect<void, unknown>,
) =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const unsubscribe = yield* events.listen((event) => {
      if (event.type === QuestionV2.Event.Replied.type) {
        const data = event.data as EventV2.Data<typeof QuestionV2.Event.Replied>
        return resumeControlledQuestion(activity, db, continueSession, data.requestID)
      }
      if (event.type === QuestionV2.Event.Dismissed.type) {
        const data = event.data as EventV2.Data<typeof QuestionV2.Event.Dismissed>
        return resumeControlledQuestion(activity, db, continueSession, data.requestID)
      }
      return Effect.void
    })
    yield* Effect.addFinalizer(() => unsubscribe)
  })

const resumeControlledQuestion = (
  activity: SessionActivity.Interface,
  db: Database.Interface["db"],
  continueSession: (sessionID: SessionSchema.ID) => Effect.Effect<void, unknown>,
  requestID: QuestionV2.ID,
) =>
  Effect.gen(function* () {
    const question = yield* db
      .select({ activityID: QuestionTable.activity_id, sessionID: QuestionTable.session_id })
      .from(QuestionTable)
      .where(
        and(
          eq(QuestionTable.id, requestID),
          eq(QuestionTable.mode, "blocking"),
          eq(QuestionTable.detached, false),
          // Only durable tool waits have a replay key that can consume the settled answer.
          // Ordinary API questions may have a live waiter and must not restart provider work.
          isNotNull(QuestionTable.assistant_message_id),
          isNotNull(QuestionTable.tool_call_id),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    if (!question?.activityID) return
    const closedSeq = yield* SessionInput.latestSeq(db, question.sessionID)
    const terminalized = yield* activity.interruptStale(question.activityID, closedSeq)
    if (!terminalized) return
    yield* continueSession(terminalized.sessionID).pipe(
      Effect.tap(() =>
        Effect.logInfo("SessionRecovery: continued controlled-shutdown session after Surface reply", {
          sessionID: terminalized.sessionID,
          requestID,
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.logError("SessionRecovery: controlled-shutdown Surface continuation failed", {
          sessionID: terminalized.sessionID,
          requestID,
          cause: Cause.pretty(cause),
        }),
      ),
    )
  })

const interruptStaleActivities = (
  activity: SessionActivity.Interface,
  db: Database.Interface["db"],
  excludeIDs: ReadonlySet<string>,
) =>
  Effect.gen(function* () {
    const stale = yield* activity.listStale(50, excludeIDs)
    const terminalized = yield* Effect.forEach(stale, (info) =>
      Effect.gen(function* () {
        const closedSeq = yield* SessionInput.latestSeq(db, info.sessionID)
        return yield* activity.interruptStale(info.id, closedSeq)
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("SessionRecovery: failed to terminalize stale activity", {
            sessionID: info.sessionID,
            activityID: info.id,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(undefined)),
        ),
      ),
    )
    const count = terminalized.filter((row) => row !== undefined).length
    if (count > 0) yield* Effect.logInfo(`SessionRecovery: interrupted ${count} stale activities without replay`)
    return new Set(
      terminalized.flatMap((row) =>
        row?.reason === SessionActivity.interruptReason("owner-shutdown") ? [row.sessionID] : [],
      ),
    )
  })

const resumeControlledShutdowns = (
  resume: (sessionID: SessionSchema.ID) => Effect.Effect<void, unknown>,
  sessionIDs: ReadonlySet<SessionSchema.ID>,
) =>
  Effect.gen(function* () {
    yield* Effect.forEach(
      sessionIDs,
      (sessionID) =>
        resume(sessionID).pipe(
          Effect.tap(() => Effect.logInfo("SessionRecovery: resumed controlled-shutdown session", { sessionID })),
          Effect.catchCause((cause) =>
            Effect.logError("SessionRecovery: controlled-shutdown resume failed; continuing recovery", {
              sessionID,
              cause: Cause.pretty(cause),
            }),
          ),
          Effect.forkScoped,
        ),
      { discard: true },
    )
    yield* Effect.yieldNow
  })

const recoverStaleTaskJobs = (db: Database.Interface["db"]) =>
  TaskJob.recoverStale(db).pipe(
    Effect.flatMap((rows) =>
      rows.length > 0
        ? Effect.logInfo(`SessionRecovery: failed ${rows.length} stale background tasks without replay`)
        : Effect.void,
    ),
    Effect.catchCause((cause) =>
      Effect.logError("SessionRecovery: stale background task scan failed", { cause: Cause.pretty(cause) }),
    ),
  )
