import { describe, expect } from "bun:test"
import { BackgroundJob } from "@opencode-ai/core/background-job"
import { BackgroundJobTable } from "@opencode-ai/core/background-job.sql"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { TaskJob } from "@opencode-ai/core/tool/task-job"
import { eq } from "drizzle-orm"
import { Context, Deferred, Effect, Exit, Layer, Scope } from "effect"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const settled: { type: string; sessionID?: string }[] = []
const events = Layer.mock(EventV2.Service, {
  publish: (definition, data) =>
    Effect.sync(() => {
      settled.push({
        type: definition.type,
        sessionID: typeof data === "object" && data !== null && "sessionID" in data ? String(data.sessionID) : undefined,
      })
      return { id: EventV2.ID.create(), type: definition.type, data }
    }),
})
const jobs = TaskJob.layer.pipe(
  Layer.provide(Layer.mergeAll(database, BackgroundJob.defaultLayer.pipe(Layer.provide(database)), events)),
)
const it = testEffect(Layer.mergeAll(database, jobs))
const memoryIt = testEffect(TaskJob.memory)
const parentID = SessionSchema.ID.make("ses_task_job_parent")
const rootID = SessionSchema.ID.make("ses_task_job_root")
const firstID = SessionSchema.ID.make("ses_task_job_first")
const secondID = SessionSchema.ID.make("ses_task_job_second")

const reserve = (taskID: SessionSchema.ID, maxThreads = 4): TaskJob.ReserveInput => ({
  taskID,
  parentSessionID: parentID,
  parentMessageID: "msg_task_job_parent",
  parentCallID: `call_${taskID}`,
  title: `Task ${taskID}`,
  metadata: { background: true, rootSessionID: rootID },
  rootSessionID: rootID,
  maxThreads,
})

describe("TaskJob.memory", () => {
  memoryIt.live("rejects a sequential reservation for an already-running task ID", () =>
    Effect.gen(function* () {
      const service = yield* TaskJob.Service
      const first = yield* service.reserve(reserve(firstID))

      const error = yield* service.reserve({ ...reserve(firstID), parentCallID: "call_replacement" }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(TaskJob.AlreadyRunningError)
      expect(yield* service.get(firstID)).toMatchObject({ parentCallID: first.parentCallID, status: "running" })
    }),
  )

  memoryIt.live("allows exactly one of two concurrent reservations for the same task ID", () =>
    Effect.gen(function* () {
      const service = yield* TaskJob.Service
      const results = yield* Effect.all(
        [
          service.reserve({ ...reserve(firstID), parentCallID: "call_concurrent_first" }).pipe(
            Effect.match({
              onFailure: (error) => ({ _tag: "failure" as const, error }),
              onSuccess: (info) => ({ _tag: "success" as const, info }),
            }),
          ),
          service.reserve({ ...reserve(firstID), parentCallID: "call_concurrent_second" }).pipe(
            Effect.match({
              onFailure: (error) => ({ _tag: "failure" as const, error }),
              onSuccess: (info) => ({ _tag: "success" as const, info }),
            }),
          ),
        ],
        { concurrency: "unbounded" },
      )
      const accepted = results.find((result) => result._tag === "success")
      const rejected = results.find((result) => result._tag === "failure")

      expect(results.map((result) => result._tag).toSorted()).toEqual(["failure", "success"])
      expect(rejected?._tag === "failure" ? rejected.error : undefined).toBeInstanceOf(TaskJob.AlreadyRunningError)
      expect(yield* service.get(firstID)).toMatchObject({
        parentCallID: accepted?._tag === "success" ? accepted.info.parentCallID : undefined,
        status: "running",
      })
    }),
  )
})

describe("TaskJob", () => {
  it.live("persists a completed result for later reads", () =>
    Effect.gen(function* () {
      const service = yield* TaskJob.Service
      yield* service.reserve(reserve(firstID))
      settled.length = 0
      yield* service.launch(firstID, Effect.succeed("durable result"))

      const result = yield* service.wait(firstID, 1_000)
      expect(result).toMatchObject({ timedOut: false, info: { taskID: firstID, status: "completed", output: "durable result" } })
      expect(yield* service.get(firstID)).toMatchObject({ status: "completed", output: "durable result" })
      expect(settled).toContainEqual({ sessionID: firstID, type: TaskJob.Settled.type })
    }),
  )

  it.live("marks a restart-visible running row interrupted without retrying provider work", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const now = Date.now()
      yield* db
        .insert(BackgroundJobTable)
        .values({
          id: firstID,
          type: "task",
          status: "running",
          parent_session_id: parentID,
          child_session_id: firstID,
          parent_message_id: "msg_restart",
          parent_call_id: "call_restart",
          title: "Interrupted task",
          metadata: { background: true, rootSessionID: rootID },
          delivery_status: "pending",
          time_created: now,
          time_updated: now,
        })
        .run()

      const result = yield* TaskJob.Service.pipe(Effect.flatMap((service) => service.get(firstID)))
      expect(result).toMatchObject({ taskID: firstID, status: "error" })
      // E4 contract: stale rows settle as typed lease-expiration failures, resumable from the checkpoint.
      expect(result?.error).toContain("lease expired")
    }),
  )

  it.live("enforces capacity and releases the slot on every terminal state", () =>
    Effect.gen(function* () {
      const service = yield* TaskJob.Service
      yield* service.reserve(reserve(firstID, 1))
      const error = yield* service.reserve(reserve(secondID, 1)).pipe(Effect.flip)
      expect(error).toBeInstanceOf(TaskJob.LimitError)
      if (error instanceof TaskJob.LimitError) expect(error.maxThreads).toBe(1)

      yield* service.fail(firstID, "failed")
      expect(yield* service.reserve(reserve(secondID, 1))).toMatchObject({ taskID: secondID, status: "running" })
      yield* service.cancel(secondID)
      expect(yield* service.reserve(reserve(firstID, 1))).toMatchObject({ taskID: firstID, status: "running" })
    }),
  )

  it.live("keeps cancellation terminal when completion races with cancel", () =>
    Effect.gen(function* () {
      const service = yield* TaskJob.Service
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* service.reserve(reserve(firstID))
      yield* service.launch(
        firstID,
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as("late result"),
        ),
      )
      yield* Deferred.await(started)

      expect(yield* service.cancel(firstID)).toMatchObject({ status: "cancelled" })
      yield* Deferred.succeed(release, undefined)
      yield* Effect.sleep("10 millis")
      expect(yield* service.get(firstID)).toMatchObject({ status: "cancelled" })
    }),
  )

  it.live("does not replace an actively owned same-ID task", () =>
    Effect.gen(function* () {
      const service = yield* TaskJob.Service
      const first = yield* service.reserve(reserve(firstID))

      const error = yield* service.reserve({ ...reserve(firstID), parentCallID: "call_replacement" }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(TaskJob.AlreadyRunningError)
      expect(yield* service.get(firstID)).toMatchObject({ parentCallID: first.parentCallID, status: "running" })
    }),
  )

  it.live("reclaims stale capacity before reserving a new task", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const now = Date.now()
      yield* db
        .insert(BackgroundJobTable)
        .values({
          id: firstID,
          type: "task",
          status: "running",
          parent_session_id: parentID,
          child_session_id: firstID,
          parent_message_id: "msg_stale",
          parent_call_id: "call_stale",
          title: "Stale task",
          metadata: { background: true, rootSessionID: rootID },
          owner_id: "job_stale",
          lease_until: now - 1,
          heartbeat_at: now - 20_000,
          delivery_status: "pending",
          time_created: now - 20_000,
          time_updated: now - 20_000,
        })
        .run()

      const service = yield* TaskJob.Service
      expect(yield* service.reserve(reserve(secondID, 1))).toMatchObject({ taskID: secondID, status: "running" })
      expect(yield* service.get(firstID)).toMatchObject({ status: "error", error: expect.stringContaining("lease expired") })
    }),
  )

  it.live("waits for a remotely owned task without stealing its live lease", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const now = Date.now()
      yield* db
        .insert(BackgroundJobTable)
        .values({
          id: firstID,
          type: "task",
          status: "running",
          parent_session_id: parentID,
          child_session_id: firstID,
          parent_message_id: "msg_remote",
          parent_call_id: "call_remote",
          title: "Remote task",
          metadata: { background: true, rootSessionID: rootID },
          owner_id: "job_remote",
          lease_until: now + 30_000,
          heartbeat_at: now,
          delivery_status: "pending",
          time_created: now,
          time_updated: now,
        })
        .run()
      const service = yield* TaskJob.Service

      expect(yield* service.wait(firstID, 10)).toMatchObject({ timedOut: true, info: { status: "running" } })
      yield* db
        .update(BackgroundJobTable)
        .set({ status: "completed", output: "remote result", time_completed: now + 1, time_updated: now + 1 })
        .where(eq(BackgroundJobTable.id, firstID))
        .run()
      expect(yield* service.wait(firstID, 1_000)).toMatchObject({
        timedOut: false,
        info: { status: "completed", output: "remote result" },
      })
    }),
  )

  it.live("does not let a former owner settle after ownership changes", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const service = yield* TaskJob.Service
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* service.reserve(reserve(firstID))
      yield* service.launch(
        firstID,
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as("stale result")),
      )
      yield* Deferred.await(started)
      yield* db
        .update(BackgroundJobTable)
        .set({ owner_id: "job_new_owner", lease_until: Date.now() + 30_000 })
        .where(eq(BackgroundJobTable.id, firstID))
        .run()
      yield* Deferred.succeed(release, undefined)
      yield* Effect.sleep("10 millis")

      expect(yield* service.get(firstID)).toMatchObject({ status: "running", ownerID: "job_new_owner" })
      yield* service.cancel(firstID)
    }),
  )

  it.live("interrupts the owner run when another service cancels the durable task", () =>
    Effect.gen(function* () {
      const sharedDatabase = Layer.succeed(Database.Service, yield* Database.Service)
      const firstScope = yield* Scope.make()
      const secondScope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(secondScope, Exit.void))
      yield* Effect.addFinalizer(() => Scope.close(firstScope, Exit.void))
      const first = Context.get(
        yield* Layer.buildWithScope(
          TaskJob.defaultLayer.pipe(Layer.provide(sharedDatabase), Layer.fresh),
          firstScope,
        ),
        TaskJob.Service,
      )
      const second = Context.get(
        yield* Layer.buildWithScope(
          TaskJob.defaultLayer.pipe(Layer.provide(sharedDatabase), Layer.fresh),
          secondScope,
        ),
        TaskJob.Service,
      )
      const started = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()

      yield* first.reserve(reserve(firstID))
      yield* first.launch(
        firstID,
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
        ),
      )
      yield* Deferred.await(started)

      expect(yield* second.cancel(firstID)).toMatchObject({ status: "cancelled" })
      yield* Deferred.await(interrupted).pipe(Effect.timeout("7 seconds"))
      expect(yield* first.get(firstID)).toMatchObject({ status: "cancelled" })
      expect(yield* second.get(firstID)).toMatchObject({ status: "cancelled" })
    }),
    10_000,
  )

  it.live("interrupts owned runs and releases their leases when the service scope closes", () =>
    Effect.gen(function* () {
      const sharedDatabase = Layer.succeed(Database.Service, yield* Database.Service)
      const firstScope = yield* Scope.make()
      const secondScope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(secondScope, Exit.void))
      const first = Context.get(
        yield* Layer.buildWithScope(
          TaskJob.defaultLayer.pipe(Layer.provide(sharedDatabase), Layer.fresh),
          firstScope,
        ),
        TaskJob.Service,
      )
      const second = Context.get(
        yield* Layer.buildWithScope(
          TaskJob.defaultLayer.pipe(Layer.provide(sharedDatabase), Layer.fresh),
          secondScope,
        ),
        TaskJob.Service,
      )
      const started = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()

      yield* first.reserve(reserve(firstID))
      yield* first.launch(
        firstID,
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
        ),
      )
      yield* Deferred.await(started)
      yield* Scope.close(firstScope, Exit.void)

      yield* Deferred.await(interrupted).pipe(Effect.timeout("1 second"))
      const result = yield* second.get(firstID)
      expect(result).toMatchObject({ status: "cancelled" })
      expect(result?.leaseUntil).toBeUndefined()
    }),
  )

  it.live("interrupts the local owner on scope close after remote cancellation wins the durable race", () =>
    Effect.gen(function* () {
      const sharedDatabase = Layer.succeed(Database.Service, yield* Database.Service)
      const firstScope = yield* Scope.make()
      const secondScope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(secondScope, Exit.void))
      const first = Context.get(
        yield* Layer.buildWithScope(
          TaskJob.defaultLayer.pipe(Layer.provide(sharedDatabase), Layer.fresh),
          firstScope,
        ),
        TaskJob.Service,
      )
      const second = Context.get(
        yield* Layer.buildWithScope(
          TaskJob.defaultLayer.pipe(Layer.provide(sharedDatabase), Layer.fresh),
          secondScope,
        ),
        TaskJob.Service,
      )
      const started = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()

      yield* first.reserve(reserve(firstID))
      yield* first.launch(
        firstID,
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
        ),
      )
      yield* Deferred.await(started)
      expect(yield* second.cancel(firstID)).toMatchObject({ status: "cancelled" })
      yield* Scope.close(firstScope, Exit.void)

      yield* Deferred.await(interrupted).pipe(Effect.timeout("1 second"))
      const result = yield* second.get(firstID)
      expect(result).toMatchObject({ status: "cancelled" })
      expect(result?.leaseUntil).toBeUndefined()
    }),
  )
})
