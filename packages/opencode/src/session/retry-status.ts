export * as SessionRetryStatus from "./retry-status"

import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import { TaskJob } from "@opencode-ai/core/tool/task-job"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Context, Effect, Layer } from "effect"
import path from "node:path"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { InstanceRef } from "@/effect/instance-ref"
import { SessionID } from "./schema"
import { SessionRetry } from "./retry"
import { SessionStatus } from "./status"

export interface Interface {
  /** Registers the per-instance retry listener. Wired through instance bootstrap. */
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRetryStatus") {}

/**
 * Translates durable core `SessionEvent.Retried` publications into the
 * user-facing `session.status` retry state so clients can render the retry
 * countdown again after the V2 runtime cutover.
 *
 * Countdown expiry alone never replaces the retry status: the scheduled delay
 * elapsing does not mean the provider has started, and flipping to busy too
 * early renders an empty "Thinking" bubble. The retry is retired only by the
 * first real provider-progress event of the same session (`session.next.step.started`,
 * published when the retried provider turn actually begins) or by a durable
 * Activity terminal event. Legacy runs also settle through `run-state`, but V2
 * execution bypasses that runner and must clear the compatibility status here.
 */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const status = yield* SessionStatus.Service

    const state = yield* InstanceState.make(
      Effect.fn("SessionRetryStatus.state")(function* (ctx) {
        // Retry publications keyed by session ID. The originating event ID is
        // the generation marker: only strictly newer provider progress of the
        // same session may retire the retry, so a late delivery of an event
        // that predates the retry cannot flip the status.
        const pending = new Map<SessionID, { eventID: EventV2.ID; attempt: number; next: number }>()
        const activities = new Map<SessionID, Set<string>>()
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            pending.clear()
            activities.clear()
          }),
        )

        // Match the server event boundary: same directory AND no conflicting
        // workspace identity.
        const workspaceID = yield* InstanceState.workspaceID

        const handleRetried = Effect.fn("SessionRetryStatus.handleRetried")(function* (
          data: EventV2.Data<typeof SessionEvent.Retried>,
          eventID: EventV2.ID,
        ) {
          const retryable = SessionRetry.retryable(
            new SessionV1.APIError({
              message: data.error.message,
              isRetryable: data.error.isRetryable,
              ...(data.error.statusCode === undefined ? {} : { statusCode: data.error.statusCode }),
              ...(data.error.responseHeaders === undefined ? {} : { responseHeaders: data.error.responseHeaders }),
              ...(data.error.responseBody === undefined ? {} : { responseBody: data.error.responseBody }),
              ...(data.error.metadata === undefined ? {} : { metadata: data.error.metadata }),
            }).toObject(),
            data.provider ?? "",
          )
          const next = data.next ?? Date.now()
          pending.set(data.sessionID, { eventID, attempt: data.attempt, next })
          yield* status.set(data.sessionID, {
            type: "retry",
            attempt: data.attempt,
            message: retryable?.message ?? data.error.message,
            ...(retryable?.action ? { action: retryable.action } : {}),
            next,
          })
        })

        const handleProviderProgress = Effect.fn("SessionRetryStatus.handleProviderProgress")(function* (
          data: EventV2.Data<typeof SessionEvent.Step.Started>,
          eventID: EventV2.ID,
        ) {
          const active = pending.get(data.sessionID)
          if (!active) return
          // Only strictly newer progress retires the retry. Ascending event
          // IDs are monotonic within the publishing process.
          if (!(active.eventID < eventID)) return
          const current = yield* status.get(data.sessionID)
          // Anything that already replaced our retry snapshot (busy from the
          // runner, idle from run-state) wins: retire the marker instead of
          // resurrecting the retry or forcing another busy transition.
          if (current.type !== "retry" || current.attempt !== active.attempt || current.next !== active.next) {
            pending.delete(data.sessionID)
            return
          }
          pending.delete(data.sessionID)
          yield* status.set(data.sessionID, { type: "busy" })
        })

        const handleActivityStarted = Effect.fn("SessionRetryStatus.handleActivityStarted")(function* (data: {
          sessionID: SessionID
          activityID: string
        }) {
          const active = activities.get(data.sessionID) ?? new Set<string>()
          active.add(data.activityID)
          activities.set(data.sessionID, active)
        })

        const handleActivitySettled = Effect.fn("SessionRetryStatus.handleActivitySettled")(function* (data: {
          sessionID: SessionID
          activityID?: string
        }) {
          if (data.activityID) {
            const active = activities.get(data.sessionID)
            active?.delete(data.activityID)
            if (active?.size === 0) activities.delete(data.sessionID)
          }
          if (activities.get(data.sessionID)?.size) return
          pending.delete(data.sessionID)
          if ((yield* status.get(data.sessionID)).type === "idle") return
          yield* status.set(data.sessionID, { type: "idle" })
        })

        const unsubscribe = yield* events.listen((event) => {
          // Replaying historical retries must not resurrect stale countdowns,
          // and replayed progress must not retire an active one.
          if (event.replay) return Effect.void
          if (
            event.type !== SessionEvent.Retried.type &&
            event.type !== SessionEvent.Step.Started.type &&
            event.type !== SessionEvent.Activity.Started.type &&
            event.type !== SessionEvent.Activity.Recovered.type &&
            event.type !== SessionEvent.Activity.Completed.type &&
            event.type !== SessionEvent.Activity.Failed.type &&
            event.type !== SessionEvent.Activity.Interrupted.type &&
            event.type !== TaskJob.Settled.type &&
            event.type !== SessionRunner.Settled.type
          )
            return Effect.void
          const location = event.location
          if (!location || !sameEventDirectory(location.directory, ctx.directory)) return Effect.void
          if (location.workspaceID !== undefined && location.workspaceID !== workspaceID) return Effect.void
          // Listeners observe already-decoded payloads (matching project.ts/vcs.ts).
          // The bridge invokes listener effects outside the instance request
          // context, so restore the instance captured by this state lookup
          // before touching SessionStatus' InstanceState-backed service.
          const effect =
            event.type === SessionEvent.Retried.type
              ? handleRetried(event.data as EventV2.Data<typeof SessionEvent.Retried>, event.id)
              : event.type === SessionEvent.Step.Started.type
                ? handleProviderProgress(event.data as EventV2.Data<typeof SessionEvent.Step.Started>, event.id)
                : event.type === SessionEvent.Activity.Started.type || event.type === SessionEvent.Activity.Recovered.type
                  ? handleActivityStarted(event.data as { sessionID: SessionID; activityID: string })
                  : handleActivitySettled(event.data as { sessionID: SessionID; activityID?: string })
          return effect.pipe(Effect.provideService(InstanceRef, ctx))
        })
        yield* Effect.addFinalizer(() => unsubscribe)
        return true
      }),
    )

    return Service.of({
      init: () => InstanceState.get(state),
    })
  }),
)

export const node = LayerNode.make(layer, [EventV2Bridge.node, SessionStatus.node])

// Windows path comparison must be case/separator-insensitive; keep in sync
// with the server's `sameEventDirectory` SSE instance filter.
function sameEventDirectory(left: string, right: string) {
  if (process.platform !== "win32") return path.normalize(left) === path.normalize(right)
  return path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase()
}
