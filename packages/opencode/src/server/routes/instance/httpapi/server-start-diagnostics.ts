import { Cause, Clock, Effect, Exit, Layer, Logger, References } from "effect"

export type ServerStartPhase = "app-service-graph" | "httpapi-route-layer"

export function measureServerStartLayer<A, E, R>(
  phase: ServerStartPhase,
  layer: Layer.Layer<A, E, R>,
): Layer.Layer<A, E, R> {
  return Layer.effectContext(
    Effect.gen(function* () {
      const loggers = yield* Logger.CurrentLoggers
      const minimumLogLevel = yield* References.MinimumLogLevel
      const startedAt = yield* Clock.currentTimeMillis
      const startedNanos = yield* Clock.currentTimeNanos
      return yield* Layer.build(layer).pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            const finishedNanos = yield* Clock.currentTimeNanos
            const finishedAt = yield* Clock.currentTimeMillis
            yield* Effect.logInfo("server startup phase", {
              phase,
              startedAt,
              finishedAt,
              durationMs: Math.round(Math.max(0, Number(finishedNanos - startedNanos) / 1_000_000) * 1_000) / 1_000,
              outcome: phaseOutcome(exit),
            }).pipe(
              Effect.provideService(Logger.CurrentLoggers, loggers),
              Effect.provideService(References.MinimumLogLevel, minimumLogLevel),
            )
          }).pipe(Effect.catchCause(() => Effect.void)),
        ),
      )
    }),
  )
}

function phaseOutcome(exit: Exit.Exit<unknown, unknown>) {
  if (Exit.isSuccess(exit)) return "success"
  if (Cause.hasInterruptsOnly(exit.cause)) return "interrupted"
  return "failure"
}
