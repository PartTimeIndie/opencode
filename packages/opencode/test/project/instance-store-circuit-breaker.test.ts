import { afterEach, expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Cause, Effect, Exit, Layer } from "effect"
import { InstanceStore, InstanceUnavailableError } from "../../src/project/instance-store"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { it } from "../lib/effect"

function failureOf(exit: Exit.Exit<unknown, unknown>): unknown {
  if (!Exit.isFailure(exit)) return undefined
  const reason = exit.cause.reasons.find((item) => Cause.isFailReason(item))
  return reason && Cause.isFailReason(reason) ? (reason as { error: unknown }).error : undefined
}

let boots = 0
let failBootstrap = true
const failingBootstrap = Layer.succeed(
  InstanceBootstrap.Service,
  InstanceBootstrap.Service.of({
    run: Effect.flatMap(Effect.sync(() => void boots++), () => (failBootstrap ? Effect.die("boom") : Effect.void)),
  }),
)
const storeLayer = Layer.mergeAll(
  InstanceStore.defaultLayer.pipe(Layer.provide(failingBootstrap)),
  CrossSpawnSpawner.defaultLayer,
)

it.live("bootstrap failures open the circuit, surface the typed 503, and reset after the window", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped({ config: { formatter: false, lsp: false } })
    boots = 0
    failBootstrap = true
    const previousMax = process.env.OPENCODE_SETTLEMENT_MAX_INSTANCE_RELOADS_PER_HOUR
    const previousCooldown = process.env.OPENCODE_SETTLEMENT_CIRCUIT_COOLDOWN_MS
    process.env.OPENCODE_SETTLEMENT_MAX_INSTANCE_RELOADS_PER_HOUR = "2"
    process.env.OPENCODE_SETTLEMENT_CIRCUIT_COOLDOWN_MS = "150"
    try {
      const store = yield* InstanceStore.Service
      // provide() keeps a successful entry cached, so every attempt disposes the
      // directory afterward to guarantee the next attempt boots fresh.
      const attempt = Effect.gen(function* () {
        const exit = yield* Effect.exit(store.provide({ directory: dir }, Effect.void))
        yield* store.disposeDirectory(dir)
        return exit
      })

      // Two immediate failures reach the configured limit; the second opens the
      // circuit and hands waiters the typed error with a retry hint.
      const firstExit = yield* attempt
      expect(Exit.isFailure(firstExit)).toBe(true)
      const firstError = failureOf(firstExit as Exit.Exit<unknown, unknown>)
      expect(InstanceUnavailableError.isInstance(firstError)).toBe(true)
      expect((firstError as { reason: string }).reason).toContain("instance bootstrap failed")
      expect((firstError as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(0)

      const secondExit = yield* attempt
      const secondError = failureOf(secondExit as Exit.Exit<unknown, unknown>)
      expect(InstanceUnavailableError.isInstance(secondError)).toBe(true)
      expect(boots).toBe(2)

      // The open circuit fails fast without starting another bootstrap.
      const thirdExit = yield* attempt
      const thirdError = failureOf(thirdExit as Exit.Exit<unknown, unknown>)
      expect(InstanceUnavailableError.isInstance(thirdError)).toBe(true)
      expect((thirdError as { reason: string }).reason).toContain("failed repeatedly")
      expect(boots).toBe(2)

      // After the cooldown window clears, a healthy bootstrap succeeds and the
      // success resets the failure accounting.
      yield* Effect.sleep(180)
      failBootstrap = false
      yield* attempt
      expect(boots).toBe(3)

      // A fresh failure sequence opens the circuit again on the second failure,
      // proving the expired window did not carry stale failures forward.
      failBootstrap = true
      const fourthExit = yield* attempt
      expect(InstanceUnavailableError.isInstance(failureOf(fourthExit as Exit.Exit<unknown, unknown>))).toBe(true)
      expect(boots).toBe(4)
      const fifthExit = yield* attempt
      expect(InstanceUnavailableError.isInstance(failureOf(fifthExit as Exit.Exit<unknown, unknown>))).toBe(true)
      expect(boots).toBe(5)
      const sixthExit = yield* attempt
      const sixthError = failureOf(sixthExit as Exit.Exit<unknown, unknown>)
      expect(InstanceUnavailableError.isInstance(sixthError)).toBe(true)
      expect((sixthError as { reason: string }).reason).toContain("failed repeatedly")
      expect(boots).toBe(5)
    } finally {
      if (previousMax === undefined) delete process.env.OPENCODE_SETTLEMENT_MAX_INSTANCE_RELOADS_PER_HOUR
      else process.env.OPENCODE_SETTLEMENT_MAX_INSTANCE_RELOADS_PER_HOUR = previousMax
      if (previousCooldown === undefined) delete process.env.OPENCODE_SETTLEMENT_CIRCUIT_COOLDOWN_MS
      else process.env.OPENCODE_SETTLEMENT_CIRCUIT_COOLDOWN_MS = previousCooldown
    }
  }).pipe(Effect.provide(storeLayer)),
)

afterEach(async () => {
  await disposeAllInstances()
})
