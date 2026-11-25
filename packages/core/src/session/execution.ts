export * as SessionExecution from "./execution"

import { Context, Effect, Layer } from "effect"
import { SessionRunner } from "./runner/index"
import { SessionSchema } from "./schema"
import type { SessionRunCoordinator } from "./run-coordinator"

export interface Interface {
  /** Explicitly drain one Session, making at least one provider attempt. */
  readonly resume: (sessionID: SessionSchema.ID) => Effect.Effect<void, SessionRunner.RunError>
  /** Resume an idle Session or join active work without scheduling a duplicate successor Activity. */
  readonly resumeOrJoin: (sessionID: SessionSchema.ID) => Effect.Effect<void, SessionRunner.RunError>
  /** Schedule a drain after durable work is recorded. Repeated wakeups may coalesce. */
  readonly wake: (sessionID: SessionSchema.ID, seq?: number) => Effect.Effect<void, SessionRunner.RunError>
  /** Queue an explicit successor drain for a durable incomplete-turn continuation. */
  readonly queueContinuation: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  /** Interrupt active work owned by this process. Idle interruption is a no-op. */
  readonly interrupt: (sessionID: SessionSchema.ID, seq?: number) => Effect.Effect<void>
  /** Interrupt one known active Activity only when this process still owns that exact Activity. */
  readonly interruptActivity: (sessionID: SessionSchema.ID, activityID: string, seq?: number) => Effect.Effect<boolean>
  /** Wait until active work owned by this process settles. Idle wait is a no-op. */
  readonly wait: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  /** Cancel one active tool call owned by this process. Idle or missing calls return false. */
  readonly cancelTool: (sessionID: SessionSchema.ID, callID: string) => Effect.Effect<boolean>
  /** Only real execution owners supply this guard. Missing support must fail closed. */
  readonly withIdle?: SessionRunCoordinator.Interface["withIdle"]
}

/** Routes execution from a Session ID to the runner owned by that Session's Location. */
export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionExecution") {}

/** Low-level compatibility layer for callers that only need durable Session recording. */
export const noopLayer = Layer.succeed(
  Service,
  Service.of({
    resume: () => Effect.void,
    resumeOrJoin: () => Effect.void,
    wake: () => Effect.void,
    queueContinuation: () => Effect.void,
    interrupt: () => Effect.void,
    interruptActivity: () => Effect.succeed(false),
    wait: () => Effect.void,
    cancelTool: () => Effect.succeed(false),
  }),
)
