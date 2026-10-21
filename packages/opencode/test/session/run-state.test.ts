import { describe, expect } from "bun:test"
import { BackgroundJob } from "@/background/job"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Fiber, Layer } from "effect"
import { SessionID } from "../../src/session/schema"
import { SessionRunState } from "../../src/session/run-state"
import { SessionStatus } from "../../src/session/status"
import { TurnCompletion } from "../../src/session/turn-completion"
import { testEffect } from "../lib/effect"
import { withTmpdirInstance } from "../fixture/fixture"

let turnCompletionEvaluations = 0
const statusUpdates: SessionStatus.Info[] = []

const status = Layer.succeed(
  SessionStatus.Service,
  SessionStatus.Service.of({
    get: () => Effect.succeed(statusUpdates.at(-1) ?? { type: "idle" }),
    list: () => Effect.succeed(new Map()),
    set: (_sessionID, status) =>
      Effect.sync(() => {
        statusUpdates.push(status)
      }),
  }),
)

const turnCompletion = Layer.succeed(
  TurnCompletion.Service,
  TurnCompletion.Service.of({
    resolve: () => Effect.succeed(undefined),
    record: () => Effect.void,
    evaluate: () =>
      Effect.sync(() => {
        turnCompletionEvaluations++
      }).pipe(Effect.andThen(Effect.never)),
  }),
)

const it = testEffect(
  SessionRunState.layer.pipe(
    Layer.provide(BackgroundJob.defaultLayer),
    Layer.provide(status),
    Layer.provide(turnCompletion),
  ),
)

const message = (sessionID: SessionID): SessionV1.WithParts => ({
  info: {
    id: SessionV1.MessageID.ascending(),
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
  },
  parts: [],
})

describe("SessionRunState", () => {
  it.effect(
    "publishes idle immediately and never runs turn completion on idle",
    () =>
      Effect.gen(function* () {
        turnCompletionEvaluations = 0
        statusUpdates.length = 0
        const run = yield* SessionRunState.Service
        const sessionID = SessionID.make("ses_turn_completion_async")
        const output = message(sessionID)

        const fiber = yield* run
          .ensureRunning(sessionID, Effect.succeed(output), Effect.succeed(output))
          .pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* Effect.yieldNow
        yield* Effect.yieldNow

        // Turn completion verdicts are owned by TurnCompletionV2; the runner must
        // not invoke the evaluator and must not defer the idle status on it.
        expect(turnCompletionEvaluations).toBe(0)
        expect(yield* Fiber.join(fiber)).toBe(output)
        // A run start publishes busy (on the request fiber) and completion
        // publishes idle immediately, in that order.
        expect(statusUpdates).toHaveLength(2)
        expect(statusUpdates[0]?.type).toBe("busy")
        expect(statusUpdates.at(-1)?.type).toBe("idle")
      }).pipe(withTmpdirInstance()),
    5_000,
  )
})
