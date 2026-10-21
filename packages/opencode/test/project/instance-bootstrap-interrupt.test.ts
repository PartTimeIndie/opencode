import { expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { InstanceState } from "../../src/effect/instance-state"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceStore, InstanceUnavailableError } from "../../src/project/instance-store"
import { tmpdirScoped } from "../fixture/fixture"
import { it } from "../lib/effect"

function unavailableReason(exit: Exit.Exit<unknown, unknown>) {
  if (!Exit.isFailure(exit)) return
  const reason = exit.cause.reasons.find(Cause.isFailReason)
  return reason && InstanceUnavailableError.isInstance(reason.error) ? reason.error.reason : undefined
}

// Reproduces the 2026-10-03T13:56:28Z cold start: a boot fiber dies with a
// pure interrupt (Config.waitForDependencies joined an interrupted dependency
// fiber and escaped as InterruptError). Waiters used to inherit the raw
// interruption, which the HTTP layer rendered as an empty-body 503. They must
// receive the typed InstanceUnavailableError instead, and the poisoned cache
// entry must be gone so the next request boots a fresh instance.
it.live("an interrupt-only boot death hands waiters the typed 503 contract", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped({ config: { formatter: false, lsp: false } })
    let attempts = 0
    const state = yield* InstanceState.make(() =>
      Effect.gen(function* () {
        attempts++
        if (attempts === 1) return yield* Effect.interrupt
        return { recovered: true }
      }),
    )
    const bootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({
      run: InstanceState.get(state).pipe(Effect.asVoid),
    }))
    yield* Effect.gen(function* () {
      const store = yield* InstanceStore.Service
      const first = yield* store.load({ directory }).pipe(Effect.exit)
      expect(Exit.isFailure(first)).toBe(true)
      expect(unavailableReason(first)).toContain("instance bootstrap was interrupted")
      expect(attempts).toBe(1)

      const second = yield* store.load({ directory }).pipe(Effect.exit)
      expect(Exit.isSuccess(second)).toBe(true)
      expect(attempts).toBe(2)
    }).pipe(Effect.provide(InstanceStore.defaultLayer.pipe(Layer.provide(bootstrap))))
  }).pipe(Effect.provide(CrossSpawnSpawner.defaultLayer)),
)
