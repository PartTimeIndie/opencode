import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { SessionActivity } from "@opencode-ai/core/session/activity"
import { SessionExecutionLocal } from "@opencode-ai/core/session/execution/local"
import { it } from "./lib/effect"

const heartbeatLoop = (
  activity: Pick<SessionActivity.Interface, "heartbeat">,
  lost: Deferred.Deferred<void>,
  heartbeatAt: Map<string, number> = new Map<string, number>(),
) =>
  SessionExecutionLocal.activityHeartbeat(
    activity as SessionActivity.Interface,
    "act_fixture",
    "owner_fixture",
    heartbeatAt,
    () => Deferred.succeed(lost, undefined).pipe(Effect.asVoid),
  ).pipe(Effect.forkScoped)

describe("session activity heartbeat", () => {
  it.effect("renews the lease and keeps ownership while heartbeats succeed", () =>
    Effect.gen(function* () {
      let calls = 0
      const lost = yield* Deferred.make<void>()
      const activity = {
        heartbeat: () =>
          Effect.sync(() => {
            calls++
            return true
          }),
      }
      const fiber = yield* heartbeatLoop(activity, lost)
      yield* TestClock.adjust("35 seconds")
      yield* Fiber.interrupt(fiber)
      expect(calls).toBeGreaterThanOrEqual(3)
      expect(yield* Deferred.isDone(lost)).toBe(false)
    }))

  it.effect("tolerates one heartbeat defect but loses ownership visibly on the next", () =>
    Effect.gen(function* () {
      let calls = 0
      const lost = yield* Deferred.make<void>()
      const activity = {
        heartbeat: () =>
          Effect.gen(function* () {
            calls++
            if (calls <= 2) return yield* Effect.die(new Error("fixture heartbeat storage failure"))
            return true
          }),
      }
      const fiber = yield* heartbeatLoop(activity, lost)
      // One defect is tolerated: the lease may still recover on the next tick.
      yield* TestClock.adjust("10 seconds" /* SessionActivity.HEARTBEAT_INTERVAL_MS */)
      for (let settle = 0; settle < 50 && !(yield* Deferred.isDone(lost)); settle++) yield* Effect.yieldNow
      expect(yield* Deferred.isDone(lost)).toBe(false)
      // A second consecutive defect must report ownership loss visibly within
      // the 30s lease instead of running on a silently expired lease.
      yield* TestClock.adjust("10 seconds" /* SessionActivity.HEARTBEAT_INTERVAL_MS */)
      for (let settle = 0; settle < 50 && !(yield* Deferred.isDone(lost)); settle++) yield* Effect.yieldNow
      yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
      expect(yield* Deferred.isDone(lost)).toBe(true)
      expect(calls).toBe(2)
    }))

  it.effect("a false renewal reports ownership loss immediately", () =>
    Effect.gen(function* () {
      const lost = yield* Deferred.make<void>()
      const activity = { heartbeat: () => Effect.succeed(false) }
      const fiber = yield* heartbeatLoop(activity, lost)
      yield* TestClock.adjust("10 seconds" /* SessionActivity.HEARTBEAT_INTERVAL_MS */)
      for (let settle = 0; settle < 50 && !(yield* Deferred.isDone(lost)); settle++) yield* Effect.yieldNow
      expect(yield* Deferred.isDone(lost)).toBe(true)
      yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
    }))

  it.effect("a slow stalled renewal cannot postpone ownership loss past the lease window", () =>
    Effect.gen(function* () {
      let calls = 0
      const lost = yield* Deferred.make<void>()
      const activity = {
        heartbeat: () =>
          Effect.gen(function* () {
            calls++
            yield* Effect.sleep("25 seconds")
            return yield* Effect.die(new Error("fixture stalled renewal"))
          }),
      }
      const heartbeatAt = new Map<string, number>([["act_fixture", 0]])
      const fiber = yield* heartbeatLoop(activity, lost, heartbeatAt)
      yield* TestClock.adjust("35 seconds" /* 10s tick + 25s stalled renewal */)
      for (let settle = 0; settle < 200 && !(yield* Deferred.isDone(lost)); settle++) yield* Effect.yieldNow
      yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
      expect(calls).toBe(1)
      expect(yield* Deferred.isDone(lost)).toBe(true)
    }))
})
