import { expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { SessionRunCoordinator } from "@opencode-ai/core/session/run-coordinator"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)
it.effect("crash recovery is a distinct drain and never joins or queues behind existing work", () => Effect.gen(function* () {
  const entered = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  const modes: string[] = []
  const coordinator = yield* SessionRunCoordinator.make<string, void, never>({
    drain: (_id, mode) => Effect.gen(function* () {
      modes.push(mode)
      yield* Deferred.succeed(entered, undefined)
      yield* Deferred.await(release)
    }),
  })
  const recovery = yield* coordinator.recover("session").pipe(Effect.forkChild)
  yield* Deferred.await(entered)
  yield* coordinator.recover("session")
  yield* Deferred.succeed(release, undefined)
  yield* Fiber.join(recovery)
  expect(modes).toEqual(["recovery"])
}))

for (const seq of [undefined, 4]) {
  it.effect(`stop ${seq ?? "unsequenced"} suppresses a late crash continuation, not a later explicit run`, () => Effect.gen(function* () {
    const modes: string[] = []
    const coordinator = yield* SessionRunCoordinator.make<string, void, never>({
      drain: (_id, mode) => Effect.sync(() => { modes.push(mode) }),
    })
    yield* coordinator.interrupt("session", seq)
    yield* coordinator.recover("session")
    expect(modes).toEqual([])
    yield* coordinator.run("session")
    expect(modes).toEqual(["run"])
  }))
}

it.effect("an idle host transaction excludes recovery instead of delaying it until after release", () => Effect.gen(function* () {
  let runs = 0
  const coordinator = yield* SessionRunCoordinator.make<string, void, never>({ drain: () => Effect.sync(() => { runs++ }) })
  yield* coordinator.withIdle("session", coordinator.recover("session"))
  expect(runs).toBe(0)
}))
