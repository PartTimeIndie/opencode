export * as SessionRecovery from "./recovery"

import { Cause, Effect, Context, Layer } from "effect"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { SessionActivity } from "./activity"
import { SessionInput } from "./input"
import { TaskJob } from "../tool/task-job"

export interface Interface {
  readonly startup: () => Effect.Effect<void>
  readonly isEnabled: () => boolean
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionRecovery") {}

const isRecoveryDisabled = () =>
  Effect.sync(() => process.env.OPENCODE_DISABLE_SESSION_RECOVERY === "1")

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const activity = yield* SessionActivity.Service

    const recoverStaleActivities = Effect.fn("SessionRecovery.recoverStaleActivities")(function* () {
      const stale = yield* activity.listStale(50)
      const terminalized = yield* Effect.forEach(stale, (info) =>
        Effect.gen(function* () {
          const closedSeq = yield* SessionInput.latestSeq(db, info.sessionID)
          return yield* activity.interruptStale(info.id, closedSeq)
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("SessionRecovery: failed to terminalize stale activity", {
              sessionID: info.sessionID,
              activityID: info.id,
              kind: info.kind,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(undefined)),
          ),
        ),
      )
      const count = terminalized.filter((row) => row !== undefined).length
      if (count > 0)
        yield* Effect.logInfo(`SessionRecovery: interrupted ${count} stale activities without replay`)
    })

    const recoverStaleTaskJobs = Effect.fn("SessionRecovery.recoverStaleTaskJobs")(function* () {
      const rows = yield* TaskJob.recoverStale(db)
      if (rows.length > 0)
        yield* Effect.logInfo(`SessionRecovery: failed ${rows.length} stale background tasks without replay`)
    })

    const startup = Effect.fn("SessionRecovery.startup")(function* () {
      const disabled = yield* isRecoveryDisabled()
      if (disabled) {
        yield* Effect.logInfo("SessionRecovery: disabled via OPENCODE_DISABLE_SESSION_RECOVERY")
        return
      }
      yield* Effect.logInfo("SessionRecovery: scanning for interrupted work")
      yield* recoverStaleTaskJobs().pipe(
        Effect.catchCause((cause) =>
          Effect.logError("SessionRecovery: stale background task recovery phase failed", {
            cause: Cause.pretty(cause),
          }),
        ),
      )
      yield* recoverStaleActivities().pipe(
        Effect.catchCause((cause) =>
          Effect.logError("SessionRecovery: stale activity recovery phase failed", { cause: Cause.pretty(cause) }),
        ),
      )
      yield* Effect.logInfo("SessionRecovery: startup scan complete")
    })

    return Service.of({
      startup: () => startup(),
      isEnabled: () => process.env.OPENCODE_DISABLE_SESSION_RECOVERY !== "1",
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(SessionActivity.defaultLayer),
  Layer.provide(EventV2.defaultLayer),
  Layer.provide(Database.defaultLayer),
)
