import { describe, expect } from "bun:test"
import { BackgroundJob } from "@opencode-ai/core/background-job"
import { Deferred, Effect, Exit, Scope } from "effect"
import { it } from "./lib/effect"

describe("BackgroundJob", () => {
  it.live("attests owner cleanup only after job-scope finalizers and refuses replacement until then", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const cleanup = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const attested = yield* Deferred.make<void>()
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
      const job = yield* jobs.start({
        id: "cleanup-fence",
        type: "test",
        onSettled: Deferred.succeed(attested, undefined).pipe(Effect.asVoid),
        run: Effect.addFinalizer(() =>
          Deferred.succeed(cleanup, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ).pipe(Effect.as("done")),
      })
      yield* Deferred.await(cleanup).pipe(Effect.timeout("1 second"))
      expect(yield* Deferred.isDone(attested)).toBe(false)
      let replacements = 0
      const rejected = yield* jobs.start({
        id: job.id,
        type: "test",
        run: Effect.sync(() => {
          replacements++
          return "replacement"
        }),
      })
      expect(rejected).toMatchObject({ accepted: false })
      expect(replacements).toBe(0)
      yield* Deferred.succeed(release, undefined)
      yield* Deferred.await(attested).pipe(Effect.timeout("1 second"))
    }).pipe(Effect.provide(BackgroundJob.layer)),
  )

  it.live("accepts a new generation after scope drain even while the old acknowledgement returns", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const acknowledged = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
      yield* jobs.start({
        id: "acknowledgement-window",
        type: "test",
        onSettled: Deferred.succeed(acknowledged, undefined).pipe(Effect.andThen(Deferred.await(release))),
        run: Effect.succeed("first"),
      })
      yield* Deferred.await(acknowledged).pipe(Effect.timeout("1 second"))
      const next = yield* jobs.start({ id: "acknowledgement-window", type: "test", run: Effect.succeed("second") })
      expect(next).toMatchObject({ accepted: true })
      expect((yield* jobs.wait({ id: next.id })).info).toMatchObject({ output: "second" })
    }).pipe(Effect.provide(BackgroundJob.layer)),
  )

  it.live("tracks process-local work through explicit observation", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const latch = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        type: "test",
        metadata: { durable: false },
        run: Deferred.await(latch).pipe(Effect.as("done")),
      })

      expect(job).toMatchObject({ type: "test", status: "running", metadata: { durable: false } })
      expect(yield* jobs.wait({ id: job.id, timeout: 0 })).toMatchObject({
        timedOut: true,
        info: { status: "running" },
      })

      yield* Deferred.succeed(latch, undefined)
      expect(yield* jobs.wait({ id: job.id })).toMatchObject({
        timedOut: false,
        info: { status: "completed", output: "done" },
      })
    }).pipe(Effect.provide(BackgroundJob.layer)),
  )

  it.live("cancellation waits only for its own generation when acknowledgement installs a successor", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
      yield* jobs.start({ id: "cancel-generation", type: "test",
        onSettled: jobs.start({ id: "cancel-generation", type: "test",
          run: Deferred.await(release).pipe(Effect.as("successor")),
        }).pipe(Effect.tap((receipt) => Effect.sync(() => expect(receipt.accepted).toBe(true))), Effect.asVoid),
        run: Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      })
      yield* Deferred.await(started)
      expect(yield* jobs.cancel("cancel-generation").pipe(Effect.timeout("1 second")))
        .toMatchObject({ status: "cancelled" })
      expect(yield* jobs.get("cancel-generation")).toMatchObject({ status: "running" })
    }).pipe(Effect.provide(BackgroundJob.layer)),
  )

  it.live("publishes jobs before starting immediately settling work", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service

      yield* Effect.forEach(Array.from({ length: 100 }), (_, index) => {
        const id = `job_immediate_start_${index}`
        return Effect.gen(function* () {
          const job = yield* jobs.start({
            id,
            type: "test",
            run: jobs
              .get(id)
              .pipe(
                Effect.flatMap((info) =>
                  info?.status === "running"
                    ? Effect.succeed(`done-${index}`)
                    : Effect.fail("job started before publish"),
                ),
              ),
          })

          expect(yield* jobs.wait({ id: job.id })).toMatchObject({
            timedOut: false,
            info: { status: "completed", output: `done-${index}` },
          })
        })
      })
    }).pipe(Effect.provide(BackgroundJob.layer)),
  )

  it.live("increments pending work before starting immediately settling extensions", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service

      yield* Effect.forEach(Array.from({ length: 100 }), (_, index) =>
        Effect.gen(function* () {
          const first = yield* Deferred.make<void>()
          const job = yield* jobs.start({
            type: "test",
            run: Deferred.await(first).pipe(Effect.as(`first-${index}`)),
          })

          expect(yield* jobs.extend({ id: job.id, run: Effect.succeed(`second-${index}`) })).toBe(true)
          expect((yield* jobs.get(job.id))?.status).toBe("running")

          yield* Deferred.succeed(first, undefined)
          expect(yield* jobs.wait({ id: job.id })).toMatchObject({
            timedOut: false,
            info: { status: "completed", output: `second-${index}` },
          })
        }),
      )
    }).pipe(Effect.provide(BackgroundJob.layer)),
  )

  it.live("interrupts live work without promising settlement after the owning process-local scope closes", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const interrupted = yield* Deferred.make<void>()
      const jobs = yield* BackgroundJob.make.pipe(Scope.provide(scope))
      const job = yield* jobs.start({
        type: "test",
        run: Effect.never.pipe(Effect.ensuring(Deferred.succeed(interrupted, undefined))),
      })

      yield* Scope.close(scope, Exit.void)

      yield* Deferred.await(interrupted).pipe(Effect.timeout("1 second"))
      // The abandoned in-memory registry is not a durable observation channel.
      expect((yield* jobs.get(job.id))?.status).toBe("running")
    }),
  )
})
