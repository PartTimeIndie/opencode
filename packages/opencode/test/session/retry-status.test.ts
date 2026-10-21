import { describe, expect } from "bun:test"
import { ProjectV2 } from "@opencode-ai/core/project"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import { TaskJob } from "@opencode-ai/core/tool/task-job"
import { DateTime, Effect, Exit, Layer } from "effect"
import { TestClock } from "effect/testing"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { InstanceRef, WorkspaceRef } from "../../src/effect/instance-ref"
import type { InstanceContext } from "../../src/project/instance-context"
import { SessionRetryStatus } from "../../src/session/retry-status"
import { SessionRetry } from "../../src/session/retry"
import { SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { testEffect } from "../lib/effect"

let statusUpdates: Array<{ sessionID: SessionID; status: SessionStatus.Info }> = []
const status = Layer.succeed(
  SessionStatus.Service,
  SessionStatus.Service.of({
    get: (sessionID) =>
      Effect.succeed(
        [...statusUpdates].reverse().find((update) => update.sessionID === sessionID)?.status ?? {
          type: "idle" as const,
        },
      ),
    list: () => Effect.succeed(new Map()),
    set: (sessionID, status) =>
      Effect.sync(() => {
        statusUpdates.push({ sessionID, status })
      }),
  }),
)

let listener: EventV2.Listener = () => Effect.void
const events = Layer.mock(EventV2Bridge.Service, {
  listen: (next) =>
    Effect.sync(() => {
      listener = next
      return Effect.sync(() => {
        if (listener === next) listener = () => Effect.void
      })
    }),
})

const graph = Layer.mergeAll(
  SessionRetryStatus.layer.pipe(Layer.provide(events), Layer.provide(status)),
  status,
)
const it = testEffect(graph)

let instanceListener: EventV2.Listener = () => Effect.void
let instanceStatusEvents: Array<EventV2.Data<typeof SessionStatus.Event.Status>> = []
let statusDuringPublish: SessionStatus.Info[] = []
let statusUnderTest: SessionStatus.Interface | undefined
const instanceEvents = Layer.mock(EventV2Bridge.Service, {
  listen: (next) =>
    Effect.sync(() => {
      instanceListener = next
      return Effect.sync(() => {
        if (instanceListener === next) instanceListener = () => Effect.void
      })
    }),
  publish: (definition, data) =>
    Effect.gen(function* () {
      if (definition.type === SessionStatus.Event.Status.type) {
        instanceStatusEvents.push(data as EventV2.Data<typeof SessionStatus.Event.Status>)
        if (statusUnderTest) {
          statusDuringPublish.push(yield* statusUnderTest.get(
            (data as EventV2.Data<typeof SessionStatus.Event.Status>).sessionID,
          ))
        }
      }
      return {
        id: EventV2.ID.create(),
        type: definition.type,
        data,
      }
    }),
})
const instanceStatusLayer = SessionStatus.layer.pipe(Layer.provide(instanceEvents))
const instanceAwareGraph = Layer.mergeAll(
  SessionRetryStatus.layer.pipe(Layer.provide(Layer.mergeAll(instanceEvents, instanceStatusLayer))),
  instanceStatusLayer,
)
const instanceAwareIt = testEffect(instanceAwareGraph)

const instanceDirectory = "C:/repo/retry-status"

function provideTestInstance<A, E, R>(effect: Effect.Effect<A, E, R>) {
  const ctx: InstanceContext = {
    directory: instanceDirectory,
    worktree: instanceDirectory,
    project: {
      id: ProjectV2.ID.make("prj_retry_status"),
      worktree: instanceDirectory,
      sandboxes: [],
      time: { created: 1, updated: 1 },
    },
  }
  return effect.pipe(Effect.provideService(InstanceRef, ctx))
}

function retriedPayload(input: {
  sessionID: SessionID
  attempt: number
  next?: number
  directory?: string
  workspaceID?: string
  replay?: boolean
  error?: { message: string; isRetryable: boolean; statusCode?: number; responseBody?: string }
}): EventV2.Payload<typeof SessionEvent.Retried> {
  return {
    id: EventV2.ID.create(),
    type: SessionEvent.Retried.type,
    ...(input.replay ? { replay: true } : {}),
    location: {
      directory: AbsolutePath.make(input.directory ?? instanceDirectory),
      ...(input.workspaceID === undefined ? {} : { workspaceID: WorkspaceV2.ID.make(input.workspaceID) }),
    },
    data: {
      sessionID: input.sessionID,
      timestamp: DateTime.makeUnsafe(Date.now()),
      attempt: input.attempt,
      error: input.error ?? {
        message: "Provider is overloaded",
        isRetryable: true,
      },
      provider: "test",
      ...(input.next === undefined ? {} : { next: input.next }),
    },
  }
}

function stepStartedPayload(input: {
  sessionID: SessionID
  directory?: string
  workspaceID?: string
  replay?: boolean
}): EventV2.Payload<typeof SessionEvent.Step.Started> {
  // The retry listener only reads `sessionID` from provider progress; the
  // remaining branded fields are opaque fixtures for the real payload shape.
  return {
    id: EventV2.ID.create(),
    type: SessionEvent.Step.Started.type,
    ...(input.replay ? { replay: true } : {}),
    location: {
      directory: AbsolutePath.make(input.directory ?? instanceDirectory),
      ...(input.workspaceID === undefined ? {} : { workspaceID: WorkspaceV2.ID.make(input.workspaceID) }),
    },
    data: {
      sessionID: input.sessionID,
      timestamp: DateTime.makeUnsafe(Date.now()),
      assistantMessageID: "msg_retry_status_step" as EventV2.Data<
        typeof SessionEvent.Step.Started
      >["assistantMessageID"],
      agent: "build",
      model: { id: "model_retry_status", providerID: "test" } as EventV2.Data<
        typeof SessionEvent.Step.Started
      >["model"],
    },
  }
}

function activityCompletedPayload(input: {
  sessionID: SessionID
  activityID?: string
  directory?: string
  replay?: boolean
}): EventV2.Payload<typeof SessionEvent.Activity.Completed> {
  return {
    id: EventV2.ID.create(),
    type: SessionEvent.Activity.Completed.type,
    ...(input.replay ? { replay: true } : {}),
    location: {
      directory: AbsolutePath.make(input.directory ?? instanceDirectory),
    },
    data: {
      sessionID: input.sessionID,
      timestamp: DateTime.makeUnsafe(Date.now()),
      activityID: input.activityID ?? "activity_retry_status_completed",
    },
  }
}

function activityStartedPayload(sessionID: SessionID): EventV2.Payload<typeof SessionEvent.Activity.Started> {
  return {
    id: EventV2.ID.create(),
    type: SessionEvent.Activity.Started.type,
    location: { directory: AbsolutePath.make(instanceDirectory) },
    data: {
      sessionID,
      timestamp: DateTime.makeUnsafe(Date.now()),
      activityID: "activity_retry_status_running",
      kind: "prompt",
    },
  }
}

function activityFailedPayload(sessionID: SessionID): EventV2.Payload<typeof SessionEvent.Activity.Failed> {
  return {
    id: EventV2.ID.create(),
    type: SessionEvent.Activity.Failed.type,
    location: { directory: AbsolutePath.make(instanceDirectory) },
    data: {
      sessionID,
      timestamp: DateTime.makeUnsafe(Date.now()),
      activityID: "activity_retry_status_failed",
      error: { type: "unknown", message: "Provider failed after retry" },
    },
  }
}

function activityInterruptedPayload(sessionID: SessionID): EventV2.Payload<typeof SessionEvent.Activity.Interrupted> {
  return {
    id: EventV2.ID.create(),
    type: SessionEvent.Activity.Interrupted.type,
    location: { directory: AbsolutePath.make(instanceDirectory) },
    data: {
      sessionID,
      timestamp: DateTime.makeUnsafe(Date.now()),
      activityID: "activity_retry_status_interrupted",
      reason: "User interrupted the activity",
    },
  }
}

function taskSettledPayload(sessionID: SessionID): EventV2.Payload<typeof TaskJob.Settled> {
  return {
    id: EventV2.ID.create(),
    type: TaskJob.Settled.type,
    location: { directory: AbsolutePath.make(instanceDirectory) },
    data: {
      sessionID,
      status: "error",
    },
  }
}

function runnerSettledPayload(
  sessionID: SessionID,
  status: EventV2.Data<typeof SessionRunner.Settled>["status"] = "error",
): EventV2.Payload<typeof SessionRunner.Settled> {
  return {
    id: EventV2.ID.create(),
    type: SessionRunner.Settled.type,
    location: { directory: AbsolutePath.make(instanceDirectory) },
    data: { sessionID, status },
  }
}

instanceAwareIt.effect(
  "publishes status events after the observable state changes",
  provideTestInstance(
    Effect.gen(function* () {
      statusDuringPublish = []
      statusUnderTest = yield* SessionStatus.Service
      const sessionID = SessionID.make("ses_status_publish_order")

      yield* statusUnderTest.set(sessionID, { type: "busy" })
      expect(statusDuringPublish.at(-1)).toEqual({ type: "busy" })

      yield* statusUnderTest.set(sessionID, { type: "idle" })
      expect(statusDuringPublish.at(-1)).toEqual({ type: "idle" })
      statusUnderTest = undefined
    }),
  ),
)

instanceAwareIt.effect(
  "handles bridge callbacks without an ambient InstanceRef",
  provideTestInstance(
    Effect.gen(function* () {
      instanceStatusEvents = []
      const sessionID = SessionID.make("ses_retry_status_instance_context")
      yield* SessionRetryStatus.Service.use((service) => service.init())

      const exit = yield* instanceListener(
        retriedPayload({ sessionID, attempt: 1, next: Date.now() + 60_000 }),
      ).pipe(
        Effect.provideService(InstanceRef, undefined as never),
        Effect.exit,
      )

      expect(Exit.isSuccess(exit)).toBe(true)
      expect(instanceStatusEvents.find((event) => event.sessionID === sessionID)?.status).toMatchObject({
        type: "retry",
        attempt: 1,
      })
    }),
  ),
)

instanceAwareIt.effect(
  "hydration keeps an active retry visible until real provider progress arrives",
  provideTestInstance(
    Effect.gen(function* () {
      instanceStatusEvents = []
      const sessionID = SessionID.make("ses_retry_status_hydration")
      yield* SessionRetryStatus.Service.use((service) => service.init())

      yield* instanceListener(retriedPayload({ sessionID, attempt: 1, next: Date.now() + 60_000 }))

      // Initial hydration and a later refresh both observe the retry, not an
      // empty busy/"Thinking" state.
      expect(yield* SessionStatus.Service.use((service) => service.get(sessionID))).toMatchObject({
        type: "retry",
        attempt: 1,
      })
      expect(yield* SessionStatus.Service.use((service) => service.get(sessionID))).toMatchObject({
        type: "retry",
        attempt: 1,
      })

      yield* instanceListener(stepStartedPayload({ sessionID }))
      expect(yield* SessionStatus.Service.use((service) => service.get(sessionID))).toMatchObject({
        type: "busy",
      })
    }),
  ),
)

instanceAwareIt.effect(
  "hydration does not resurrect a retry after the session settled to idle",
  provideTestInstance(
    Effect.gen(function* () {
      instanceStatusEvents = []
      const sessionID = SessionID.make("ses_retry_status_hydration_idle")
      yield* SessionRetryStatus.Service.use((service) => service.init())

      yield* instanceListener(retriedPayload({ sessionID, attempt: 1, next: Date.now() + 60_000 }))
      // run-state owns the terminal idle transition when the runner settles.
      yield* SessionStatus.Service.use((service) => service.set(sessionID, { type: "idle" }))

      yield* instanceListener(stepStartedPayload({ sessionID }))

      expect(yield* SessionStatus.Service.use((service) => service.get(sessionID))).toMatchObject({
        type: "idle",
      })
      expect(instanceStatusEvents.map((event) => event.status.type)).toEqual(["retry", "idle"])
    }),
  ),
)

describe("SessionRetryStatus", () => {
  it.effect(
    "mirrors a retried event into the retry session status",
    provideTestInstance(
      Effect.gen(function* () {
        statusUpdates = []
        yield* SessionRetryStatus.Service.use((service) => service.init())
        const sessionID = SessionID.make("ses_retry_status_mirror")

        yield* listener(retriedPayload({ sessionID, attempt: 1, next: Date.now() + 60_000 }))

        expect(statusUpdates).toHaveLength(1)
        expect(statusUpdates[0].status).toMatchObject({
          type: "retry",
          attempt: 1,
          message: "Provider is overloaded",
        })
      }),
    ),
  )

  it.effect(
    "keeps the retry status while only the countdown elapses",
    provideTestInstance(
      Effect.gen(function* () {
        statusUpdates = []
        yield* SessionRetryStatus.Service.use((service) => service.init())
        const sessionID = SessionID.make("ses_retry_status_busy")

        yield* listener(retriedPayload({ sessionID, attempt: 1, next: Date.now() + 10 }))
        yield* TestClock.adjust("50 millis")

        expect(statusUpdates.map((update) => update.status.type)).toEqual(["retry"])
      }),
    ),
  )

  it.effect(
    "replaces retry with busy on the first real provider step of the same session",
    provideTestInstance(
      Effect.gen(function* () {
        statusUpdates = []
        yield* SessionRetryStatus.Service.use((service) => service.init())
        const sessionID = SessionID.make("ses_retry_status_progress")

        yield* listener(retriedPayload({ sessionID, attempt: 1, next: Date.now() + 60_000 }))
        yield* listener(stepStartedPayload({ sessionID }))

        expect(statusUpdates.map((update) => update.status.type)).toEqual(["retry", "busy"])

        // The pending marker is retired with the transition; later progress of
        // the same turn does not republish busy on top of the runner's status.
        yield* listener(stepStartedPayload({ sessionID }))
        expect(statusUpdates.map((update) => update.status.type)).toEqual(["retry", "busy"])
      }),
    ),
  )

  it.effect(
    "clears a V2 retry status when its durable activity settles",
    provideTestInstance(
      Effect.gen(function* () {
        statusUpdates = []
        yield* SessionRetryStatus.Service.use((service) => service.init())
        const sessionID = SessionID.make("ses_retry_status_activity_completed")

        yield* listener(retriedPayload({ sessionID, attempt: 1, next: Date.now() + 60_000 }))
        yield* listener(stepStartedPayload({ sessionID }))
        yield* listener(activityCompletedPayload({ sessionID }))

        expect(statusUpdates.map((update) => update.status.type)).toEqual(["retry", "busy", "idle"])
      }),
    ),
  )

  it.effect(
    "clears a V2 retry status when its durable activity fails",
    provideTestInstance(
      Effect.gen(function* () {
        statusUpdates = []
        yield* SessionRetryStatus.Service.use((service) => service.init())
        const sessionID = SessionID.make("ses_retry_status_activity_failed")

        yield* listener(retriedPayload({ sessionID, attempt: 1, next: Date.now() + 60_000 }))
        yield* listener(activityFailedPayload(sessionID))

        expect(statusUpdates.map((update) => update.status.type)).toEqual(["retry", "idle"])
      }),
    ),
  )

  it.effect(
    "clears a V2 retry status when its durable activity is interrupted",
    provideTestInstance(
      Effect.gen(function* () {
        statusUpdates = []
        yield* SessionRetryStatus.Service.use((service) => service.init())
        const sessionID = SessionID.make("ses_retry_status_activity_interrupted")

        yield* listener(retriedPayload({ sessionID, attempt: 1, next: Date.now() + 60_000 }))
        yield* listener(activityInterruptedPayload(sessionID))

        expect(statusUpdates.map((update) => update.status.type)).toEqual(["retry", "idle"])
      }),
    ),
  )

  it.effect(
    "clears retry-derived busy status when a background task settles",
    provideTestInstance(
      Effect.gen(function* () {
        statusUpdates = []
        yield* SessionRetryStatus.Service.use((service) => service.init())
        const sessionID = SessionID.make("ses_retry_status_task_settled")

        yield* listener(retriedPayload({ sessionID, attempt: 1, next: Date.now() + 60_000 }))
        yield* listener(stepStartedPayload({ sessionID }))
        yield* listener(taskSettledPayload(sessionID))

        expect(statusUpdates.map((update) => update.status.type)).toEqual(["retry", "busy", "idle"])
      }),
    ),
  )

  it.effect(
    "clears retry-derived busy status when a foreground runner settles without an activity",
    provideTestInstance(
      Effect.gen(function* () {
        statusUpdates = []
        yield* SessionRetryStatus.Service.use((service) => service.init())
        const sessionID = SessionID.make("ses_retry_status_runner_settled")

        yield* listener(retriedPayload({ sessionID, attempt: 1, next: Date.now() + 60_000 }))
        yield* listener(stepStartedPayload({ sessionID }))
        yield* listener(runnerSettledPayload(sessionID))

        expect(statusUpdates.map((update) => update.status.type)).toEqual(["retry", "busy", "idle"])
      }),
    ),
  )

  it.effect(
    "keeps activity and runner settlement idempotent for normal runs",
    provideTestInstance(
      Effect.gen(function* () {
        statusUpdates = []
        yield* SessionRetryStatus.Service.use((service) => service.init())
        const sessionID = SessionID.make("ses_retry_status_double_settled")

        yield* listener(retriedPayload({ sessionID, attempt: 1, next: Date.now() + 60_000 }))
        yield* listener(stepStartedPayload({ sessionID }))
        yield* listener(activityStartedPayload(sessionID))
        yield* listener(runnerSettledPayload(sessionID))
        expect(statusUpdates.map((update) => update.status.type)).toEqual(["retry", "busy"])

        yield* listener(activityCompletedPayload({ sessionID, activityID: "activity_retry_status_running" }))

        expect(statusUpdates.map((update) => update.status.type)).toEqual(["retry", "busy", "idle"])
      }),
    ),
  )

  it.effect(
    "ignores replayed or other-directory activity settlement",
    provideTestInstance(
      Effect.gen(function* () {
        statusUpdates = []
        yield* SessionRetryStatus.Service.use((service) => service.init())
        const sessionID = SessionID.make("ses_retry_status_activity_ignored")

        yield* listener(retriedPayload({ sessionID, attempt: 1, next: Date.now() + 60_000 }))
        yield* listener(activityCompletedPayload({ sessionID, replay: true }))
        yield* listener(activityCompletedPayload({ sessionID, directory: "Z:/elsewhere" }))

        expect(statusUpdates.map((update) => update.status.type)).toEqual(["retry"])
      }),
    ),
  )

  it.effect(
    "ignores provider progress that predates the retry",
    provideTestInstance(
      Effect.gen(function* () {
        statusUpdates = []
        yield* SessionRetryStatus.Service.use((service) => service.init())
        const sessionID = SessionID.make("ses_retry_status_stale_progress")
        // Built first so its ascending event ID is older than the retry's.
        const staleProgress = stepStartedPayload({ sessionID })

        yield* listener(retriedPayload({ sessionID, attempt: 1, next: Date.now() + 60_000 }))
        yield* listener(staleProgress)

        expect(statusUpdates.map((update) => update.status.type)).toEqual(["retry"])
      }),
    ),
  )

  it.effect(
    "ignores replayed provider progress",
    provideTestInstance(
      Effect.gen(function* () {
        statusUpdates = []
        yield* SessionRetryStatus.Service.use((service) => service.init())
        const sessionID = SessionID.make("ses_retry_status_replay_progress")

        yield* listener(retriedPayload({ sessionID, attempt: 1, next: Date.now() + 60_000 }))
        yield* listener(stepStartedPayload({ sessionID, replay: true }))

        expect(statusUpdates.map((update) => update.status.type)).toEqual(["retry"])
      }),
    ),
  )

  it.effect(
    "ignores provider progress for another session or directory",
    provideTestInstance(
      Effect.gen(function* () {
        statusUpdates = []
        yield* SessionRetryStatus.Service.use((service) => service.init())
        const sessionID = SessionID.make("ses_retry_status_other_session")

        yield* listener(retriedPayload({ sessionID, attempt: 1, next: Date.now() + 60_000 }))
        yield* listener(stepStartedPayload({ sessionID: SessionID.make("ses_retry_status_elsewhere") }))
        yield* listener(stepStartedPayload({ sessionID, directory: "Z:/elsewhere" }))

        expect(statusUpdates).toHaveLength(1)
        expect(statusUpdates[0].status.type).toBe("retry")
      }),
    ),
  )

  it.effect(
    "keeps a replaced status instead of resurrecting the retry",
    provideTestInstance(
      Effect.gen(function* () {
        statusUpdates = []
        yield* SessionRetryStatus.Service.use((service) => service.init())
        const sessionID = SessionID.make("ses_retry_status_no_resurrect")

        yield* listener(retriedPayload({ sessionID, attempt: 1, next: Date.now() + 60_000 }))
        yield* SessionStatus.Service.use((service) => service.set(sessionID, { type: "idle" }))
        yield* listener(stepStartedPayload({ sessionID }))

        expect(statusUpdates.map((update) => update.status.type)).toEqual(["retry", "idle"])
      }),
    ),
  )

  it.effect(
    "does not restore busy when a newer retry replaced the countdown",
    provideTestInstance(
      Effect.gen(function* () {
        statusUpdates = []
        yield* SessionRetryStatus.Service.use((service) => service.init())
        const sessionID = SessionID.make("ses_retry_status_replace")

        yield* listener(retriedPayload({ sessionID, attempt: 1, next: Date.now() + 10 }))
        yield* listener(retriedPayload({ sessionID, attempt: 2, next: Date.now() + 60_000 }))
        yield* TestClock.adjust("50 millis")

        expect(statusUpdates.map((update) => update.status.type)).toEqual(["retry", "retry"])
      }),
    ),
  )

  it.effect(
    "ignores retries published for other directories",
    provideTestInstance(
      Effect.gen(function* () {
        statusUpdates = []
        yield* SessionRetryStatus.Service.use((service) => service.init())
        const sessionID = SessionID.make("ses_retry_status_other")

        yield* listener(
          retriedPayload({ sessionID, attempt: 1, next: Date.now() + 60_000, directory: "Z:/elsewhere" }),
        )

        expect(statusUpdates).toHaveLength(0)
      }),
    ),
  )

  it.effect(
    "ignores replayed retried events",
    provideTestInstance(
      Effect.gen(function* () {
        statusUpdates = []
        yield* SessionRetryStatus.Service.use((service) => service.init())
        const sessionID = SessionID.make("ses_retry_status_replay")

        yield* listener(retriedPayload({ sessionID, attempt: 1, next: Date.now() + 60_000, replay: true }))

        expect(statusUpdates).toHaveLength(0)
      }),
    ),
  )

  it.effect(
    "ignores retries published for another workspace in the same directory",
    provideTestInstance(
      Effect.gen(function* () {
        statusUpdates = []
        yield* SessionRetryStatus.Service.use((service) => service.init())
        const sessionID = SessionID.make("ses_retry_status_ws_other")

        yield* listener(
          retriedPayload({ sessionID, attempt: 1, next: Date.now() + 60_000, workspaceID: "wrk_other" }),
        )

        expect(statusUpdates).toHaveLength(0)
      }),
    ),
  )

  it.effect(
    "mirrors retries without a workspace identity",
    provideTestInstance(
      Effect.gen(function* () {
        statusUpdates = []
        yield* SessionRetryStatus.Service.use((service) => service.init())
        const sessionID = SessionID.make("ses_retry_status_ws_match")

        // No workspace identity on the event behaves like the server boundary.
        yield* listener(retriedPayload({ sessionID, attempt: 1, next: Date.now() + 60_000 }))
        expect(statusUpdates).toHaveLength(1)
      }),
    ),
  )

  it.effect(
    "mirrors retries carrying the matching instance workspace",
    provideTestInstance(
      Effect.gen(function* () {
        statusUpdates = []
        yield* SessionRetryStatus.Service.use((service) => service.init())
        const sessionID = SessionID.make("ses_retry_status_ws_explicit_match")

        yield* listener(
          retriedPayload({ sessionID, attempt: 1, next: Date.now() + 60_000, workspaceID: "wrk_match" }),
        )

        expect(statusUpdates).toHaveLength(1)
      }).pipe(Effect.provideService(WorkspaceRef, WorkspaceV2.ID.make("wrk_match"))),
    ),
  )

  it.effect(
    "restores the Go upsell action from the retried error body",
    provideTestInstance(
      Effect.gen(function* () {
        statusUpdates = []
        yield* SessionRetryStatus.Service.use((service) => service.init())
        const sessionID = SessionID.make("ses_retry_status_go_upsell")
        const next = Date.now() + 60_000

        yield* listener(
          retriedPayload({
            sessionID,
            attempt: 1,
            next,
            error: {
              message: "Free usage exceeded",
              isRetryable: true,
              responseBody: JSON.stringify({ error: { type: "FreeUsageLimitError" } }),
            },
          }),
        )

        expect(statusUpdates).toHaveLength(1)
        expect(statusUpdates[0].status).toMatchObject({
          type: "retry",
          attempt: 1,
          message: SessionRetry.GO_UPSELL_MESSAGE,
          next,
          action: {
            reason: "free_tier_limit",
            provider: "test",
            title: "Free limit reached",
            label: "subscribe",
            link: SessionRetry.GO_UPSELL_URL,
          },
        })
      }),
    ),
  )
})
