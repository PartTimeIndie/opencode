import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { CrashActivity } from "../src/observability/crash-activity"

test("emits paired activity on completion, failure and interruption", async () => {
  const updates: CrashActivity.Update[] = []
  const trace = CrashActivity.create()
  trace.configure((update) => updates.push(update))
  const operation = { kind: "tool", sessionID: "ses_test", name: "task_wait" } as const
  await Effect.runPromise(Effect.gen(function* () {
    yield* trace.track(operation, Effect.void)
    yield* trace.track(operation, Effect.fail("failed")).pipe(Effect.exit)
    const entered = yield* Deferred.make<void>()
    const fiber = yield* trace.track(operation, Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)))
      .pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    yield* Fiber.interrupt(fiber)
  }))
  expect(updates.map(({ id, phase }) => [id, phase])).toEqual([
    [1, "start"], [1, "end"], [2, "start"], [2, "end"], [3, "start"], [3, "end"],
  ])
  expect(updates[0]).toEqual({ id: 1, phase: "start", ...operation })
  expect(updates.flatMap((update) => update.phase === "end" ? [update.outcome] : [])).toEqual([
    "success", "failure", "interrupted",
  ])
})

test("diagnostic transport failure preserves the operation result", async () => {
  const trace = CrashActivity.create()
  trace.configure(() => { throw new Error("IPC closed") })
  expect(await Effect.runPromise(trace.track({ kind: "provider", sessionID: "ses_test", name: "provider/model" }, Effect.succeed(42))))
    .toBe(42)
})

test("records native and plugin boundaries without copying their arguments or errors", async () => {
  const updates: CrashActivity.Update[] = []
  const trace = CrashActivity.create()
  const stop = trace.configure((update) => updates.push(update))
  const error = new Error("private error")
  const sqlite = { kind: "sqlite", name: "all.rows", params: ["private"] } as const
  const plugin = { kind: "plugin", pluginID: "@example/plugin", name: "server.event" } as const
  expect(() => trace.trackSync(sqlite, () => { throw error })).toThrow(error)
  let complete!: (value: number) => void
  const result = trace.trackPromise(plugin, () => new Promise<number>((resolve) => { complete = resolve }))
  expect(updates).toEqual([
    { phase: "start", id: 1, kind: "sqlite", name: "all.rows" },
    { phase: "end", id: 1, outcome: "failure" },
    { phase: "start", id: 2, ...plugin },
  ])
  complete(42)
  expect(await result).toBe(42)
  await expect(trace.trackPromise(plugin, () => Promise.reject(error))).rejects.toBe(error)
  expect(updates.slice(-3)).toEqual([
    { phase: "end", id: 2, outcome: "success" },
    { phase: "start", id: 3, ...plugin },
    { phase: "end", id: 3, outcome: "failure" },
  ])
  stop()
  expect(trace.trackSync(sqlite, () => "unchanged")).toBe("unchanged")
  expect(updates).toHaveLength(6)
})
