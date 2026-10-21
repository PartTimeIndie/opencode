import { GlobalBus } from "@/bus/global"
import { InstanceStore } from "@/project/instance-store"
import { Duration, Effect, Fiber } from "effect"
import { Event } from "./event"

export const emitGlobalDisposed = Effect.sync(() =>
  GlobalBus.emit("event", {
    directory: "global",
    payload: {
      type: Event.Disposed.type,
      properties: {},
    },
  }),
)

export const disposeAllInstancesAndEmitGlobalDisposed = Effect.fn("Server.disposeAllInstancesAndEmitGlobalDisposed")(
  function* (options?: { swallowErrors?: boolean; fresh?: boolean }) {
    const store = yield* InstanceStore.Service
    const sweep = options?.fresh ? store.disposeAllFresh() : store.disposeAll()
    yield* Effect.gen(function* () {
      yield* options?.swallowErrors
        ? sweep.pipe(Effect.catchCause((cause) => Effect.logWarning("global disposal failed", { cause })))
        : sweep
      yield* emitGlobalDisposed
    }).pipe(Effect.uninterruptible)
  },
)

/**
 * Upper bound a config-update response waits for the reload disposal. The
 * disposal itself keeps running past the deadline; only the response stops
 * blocking on it, so a wedged instance disposer can never freeze settings
 * saves forever.
 */
export function configReloadDisposeDeadlineMs(env: Readonly<Record<string, string | undefined>> = process.env) {
  const value = Number(env.OPENCODE_CONFIG_RELOAD_DISPOSE_DEADLINE_MS)
  return Number.isInteger(value) && value > 0 ? value : 10_000
}

export const disposeAllInstancesForConfigReload = Effect.fn("Server.disposeAllInstancesForConfigReload")(
  function* () {
    const timeoutMs = configReloadDisposeDeadlineMs()
    // fresh: every config write gets its own sweep snapshot, so instances that
    // reloaded while an earlier (possibly over-deadline) sweep is still running
    // are not skipped by a later save joining that old sweep.
    const disposal = yield* disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true, fresh: true }).pipe(
      Effect.forkDetach,
    )
    const finished = yield* Fiber.join(disposal).pipe(
      Effect.as(true),
      Effect.timeoutOrElse({
        duration: Duration.millis(timeoutMs),
        orElse: () => Effect.succeed(false),
      }),
    )
    if (!finished)
      yield* Effect.logWarning("global instance disposal missed the config update deadline; continuing in background", {
        timeoutMs,
      })
  },
)

export * as GlobalLifecycle from "./global-lifecycle"
