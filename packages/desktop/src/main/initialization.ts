import { Deferred, Effect } from "effect"
import type { ServerState } from "../preload/server-state"

export function completeHealthyInitialization<A>(
  initialization: Deferred.Deferred<A, unknown>,
  data: A,
  state: ServerState,
) {
  // The endpoint exists before its routes do. Publish it only after the
  // supervisor has verified health, including after a failed first attempt.
  if (state.phase !== "healthy") return Effect.void
  return Deferred.succeed(initialization, data).pipe(Effect.asVoid)
}

export function forwardInitializationFailure<A>(initialization: Deferred.Deferred<A, unknown>) {
  return <B, E, R>(effect: Effect.Effect<B, E, R>) =>
    effect.pipe(Effect.tapCause((cause) => Deferred.failCause(initialization, cause)))
}
