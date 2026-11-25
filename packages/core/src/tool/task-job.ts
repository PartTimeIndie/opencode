export * as TaskJob from "./task-job"

import { BackgroundJob } from "../background-job"
import { BackgroundJobTable } from "../background-job.sql"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { Identifier } from "../id/id"
import { SessionSchema } from "../session/schema"
import { SessionSupervision } from "../session/supervision"
import { and, eq, isNull, lte, or } from "drizzle-orm"
import { Cause, Clock, Context, Deferred, Effect, Fiber, Layer, Schema, Scope, SynchronizedRef } from "effect"

export type Status = "running" | "completed" | "error" | "cancelled"

// Compatibility status is process-local while background_job is the durable
// source of truth. This event retires transient retry/busy UI state without
// expanding the large durable SessionEvent projection union.
export const Settled = EventV2.define({
  type: "task.job.settled",
  schema: {
    sessionID: SessionSchema.ID,
    status: Schema.Literals(["completed", "error", "cancelled"]),
  },
})

export type Info = {
  taskID: SessionSchema.ID
  parentSessionID: SessionSchema.ID
  childSessionID: SessionSchema.ID
  parentMessageID: string
  parentCallID: string
  title: string
  status: Status
  timeCreated: number
  timeUpdated: number
  timeCompleted?: number
  output?: string
  error?: string
  ownerID?: string
  leaseUntil?: number
  heartbeatAt?: number
  metadata: Record<string, unknown>
}

export type ReserveInput = {
  taskID: SessionSchema.ID
  parentSessionID: SessionSchema.ID
  parentMessageID: string
  parentCallID: string
  title: string
  metadata: Record<string, unknown>
  rootSessionID: SessionSchema.ID
  maxThreads: number
}

export class LimitError extends Error {
  readonly _tag = "TaskJobLimitError"

  constructor(readonly maxThreads: number) {
    super(`Background task limit reached (${maxThreads}). Wait for or cancel an active task before spawning another.`)
  }
}

export class AlreadyRunningError extends Error {
  readonly _tag = "TaskJobAlreadyRunningError"

  constructor(readonly taskID: SessionSchema.ID) {
    super(`Task ${taskID} is already running.`)
  }
}

export interface Interface {
  readonly list: (parentSessionID?: SessionSchema.ID) => Effect.Effect<Info[]>
  readonly reserve: (input: ReserveInput) => Effect.Effect<Info, LimitError | AlreadyRunningError>
  readonly launch: (taskID: SessionSchema.ID, run: Effect.Effect<string, unknown, Scope.Scope>) => Effect.Effect<Info>
  readonly fail: (taskID: SessionSchema.ID, error: string) => Effect.Effect<Info | undefined>
  readonly get: (taskID: SessionSchema.ID) => Effect.Effect<Info | undefined>
  readonly wait: (taskID: SessionSchema.ID, timeout?: number) => Effect.Effect<{ info?: Info; timedOut: boolean }>
  readonly cancel: (taskID: SessionSchema.ID) => Effect.Effect<Info | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/TaskJob") {}

const interrupted = SessionSupervision.staleJobError()
const leaseDuration = 15_000
const heartbeatInterval = 5_000
const remoteWaitInterval = 500

export const recoverStale = Effect.fn("TaskJob.recoverStale")(function* (
  db: Database.Interface["db"],
  taskID?: SessionSchema.ID,
) {
  const now = yield* Clock.currentTimeMillis
  return yield* db
    .update(BackgroundJobTable)
    .set({
      status: "error",
      error: interrupted,
      delivery_status: "available",
      lease_until: null,
      time_completed: now,
      time_updated: now,
    })
    .where(
      and(
        eq(BackgroundJobTable.type, "task"),
        eq(BackgroundJobTable.status, "running"),
        or(isNull(BackgroundJobTable.lease_until), lte(BackgroundJobTable.lease_until, now)),
        ...(taskID ? [eq(BackgroundJobTable.id, taskID)] : []),
      ),
    )
    .returning()
    .all()
    .pipe(Effect.orDie)
})

function memoryLayer() {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const background = yield* BackgroundJob.Service
      const jobs = yield* SynchronizedRef.make(new Map<SessionSchema.ID, Info>())

      const update = Effect.fn("TaskJob.memory.update")(function* (
        taskID: SessionSchema.ID,
        status: Exclude<Status, "running">,
        value?: string,
      ) {
        const now = yield* Clock.currentTimeMillis
        return yield* SynchronizedRef.modify(jobs, (state) => {
          const current = state.get(taskID)
          if (!current || current.status !== "running") return [current, state] as const
          const next: Info = {
            ...current,
            status,
            timeUpdated: now,
            timeCompleted: now,
            ...(status === "completed" ? { output: value } : {}),
            ...(status === "error" ? { error: value } : {}),
          }
          return [next, new Map(state).set(taskID, next)] as const
        })
      })

      const get: Interface["get"] = (taskID) => SynchronizedRef.get(jobs).pipe(Effect.map((state) => state.get(taskID)))

      return Service.of({
        list: (parentSessionID) =>
          SynchronizedRef.get(jobs).pipe(
            Effect.map((state) =>
              [...state.values()]
                .filter((job) => parentSessionID === undefined || job.parentSessionID === parentSessionID)
                .toSorted((left, right) => left.timeCreated - right.timeCreated),
            ),
          ),
        reserve: Effect.fn("TaskJob.memory.reserve")(function* (input) {
          const now = yield* Clock.currentTimeMillis
          return yield* SynchronizedRef.modifyEffect(
            jobs,
            Effect.fnUntraced(function* (state) {
              if (state.get(input.taskID)?.status === "running")
                return yield* Effect.fail(new AlreadyRunningError(input.taskID))
              const active = [...state.values()].filter(
                (job) => job.status === "running" && job.metadata.rootSessionID === input.rootSessionID,
              )
              if (active.length >= input.maxThreads) return yield* Effect.fail(new LimitError(input.maxThreads))
              const info: Info = {
                taskID: input.taskID,
                parentSessionID: input.parentSessionID,
                childSessionID: input.taskID,
                parentMessageID: input.parentMessageID,
                parentCallID: input.parentCallID,
                title: input.title,
                status: "running",
                timeCreated: now,
                timeUpdated: now,
                metadata: input.metadata,
              }
              return [info, new Map(state).set(input.taskID, info)] as const
            }),
          )
        }),
        launch: Effect.fn("TaskJob.memory.launch")(function* (taskID, run) {
          const info = yield* get(taskID)
          if (!info) return yield* Effect.die(`Task job not reserved: ${taskID}`)
          yield* background.start({
            id: taskID,
            type: "task",
            title: info.title,
            metadata: info.metadata,
            run: run.pipe(
              Effect.matchCauseEffect({
                onSuccess: (output) => update(taskID, "completed", output).pipe(Effect.as(output)),
                onFailure: (cause) => {
                  if (Cause.hasInterruptsOnly(cause))
                    return update(taskID, "cancelled").pipe(Effect.andThen(Effect.failCause(cause)))
                  const error = Cause.squash(cause)
                  return update(taskID, "error", error instanceof Error ? error.message : String(error)).pipe(
                    Effect.andThen(Effect.failCause(cause)),
                  )
                },
              }),
            ),
          })
          return info
        }),
        fail: (taskID, error) => update(taskID, "error", error),
        get,
        wait: Effect.fn("TaskJob.memory.wait")(function* (taskID, timeout) {
          const info = yield* get(taskID)
          if (!info || info.status !== "running") return { info, timedOut: false }
          const result = yield* background.wait({ id: taskID, timeout })
          if (result.timedOut) return { info: yield* get(taskID), timedOut: true }
          return { info: yield* get(taskID), timedOut: false }
        }),
        cancel: Effect.fn("TaskJob.memory.cancel")(function* (taskID) {
          const info = yield* update(taskID, "cancelled")
          yield* background.cancel(taskID).pipe(Effect.timeoutOption(2_000), Effect.ignore)
          return info
        }),
      })
    }),
  )
}

export const memory = memoryLayer().pipe(Layer.provide(BackgroundJob.defaultLayer))

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const background = yield* BackgroundJob.Service
    const events = yield* EventV2.Service
    const scope = yield* Scope.Scope
    const ownerID = Identifier.ascending("job")
    const owned = new Map<SessionSchema.ID, {
      token: string
      state: "reserved" | "running" | "closing" | "settled"
      lost: Deferred.Deferred<void>
      heartbeat?: Fiber.Fiber<void, never>
    }>()

    // A result, cancellation or expired lease is not proof that its independent
    // execution scope finished. Only this generation's owner may acknowledge it.
    const acknowledge = Effect.fn("TaskJob.acknowledge")(function* (taskID: SessionSchema.ID, token: string) {
      const now = yield* Clock.currentTimeMillis
      const row = yield* db
        .update(BackgroundJobTable)
        .set({ time_owner_settled: now })
        .where(
          and(
            eq(BackgroundJobTable.id, taskID),
            eq(BackgroundJobTable.owner_id, ownerID),
            eq(BackgroundJobTable.cleanup_token, token),
            or(
              eq(BackgroundJobTable.status, "completed"),
              eq(BackgroundJobTable.status, "error"),
              eq(BackgroundJobTable.status, "cancelled"),
            ),
          ),
        )
        .returning({ id: BackgroundJobTable.id })
        .get()
        .pipe(Effect.orDie)
      // A foreign/replaced generation stays unknown. Finishing this local scope
      // cannot attest the new owner's effects or repair its durable evidence.
      if (!row) return
      const current = owned.get(taskID)
      if (current?.token === token) {
        current.state = "settled"
        if (current.heartbeat) yield* Fiber.interrupt(current.heartbeat)
        if (owned.get(taskID)?.token === token) owned.delete(taskID)
      }
    })

    yield* Effect.addFinalizer(() =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const local = yield* background.list()
          const now = yield* Clock.currentTimeMillis
          yield* Effect.forEach([...owned.entries()], ([taskID, owner]) => db
            .update(BackgroundJobTable)
            .set({
              status: "cancelled",
              delivery_status: "available",
              lease_until: null,
              time_completed: now,
              time_updated: now,
            })
            .where(
              and(
                eq(BackgroundJobTable.type, "task"),
                eq(BackgroundJobTable.status, "running"),
                eq(BackgroundJobTable.owner_id, ownerID),
                eq(BackgroundJobTable.id, taskID),
                eq(BackgroundJobTable.cleanup_token, owner.token),
              ),
            )
            .run()
            .pipe(Effect.orDie), { discard: true })
          yield* Effect.forEach(
            local.filter((job) => job.type === "task" && owned.has(SessionSchema.ID.make(job.id))),
            (job) => background.cancel(job.id).pipe(Effect.timeoutOption(2_000), Effect.ignore),
            { discard: true },
          )
          yield* Effect.forEach(
            [...owned.entries()].filter(([, owner]) => owner.state === "reserved"),
            ([id, owner]) => acknowledge(id, owner.token),
            { discard: true },
          )
        }),
      ),
    )

    const fromRow = (row: typeof BackgroundJobTable.$inferSelect): Info => ({
      taskID: SessionSchema.ID.make(row.child_session_id ?? row.id),
      parentSessionID: SessionSchema.ID.make(row.parent_session_id ?? ""),
      childSessionID: SessionSchema.ID.make(row.child_session_id ?? row.id),
      parentMessageID: row.parent_message_id ?? "",
      parentCallID: row.parent_call_id ?? "",
      title: row.title ?? "Background task",
      status: row.status as Status,
      timeCreated: row.time_created,
      timeUpdated: row.time_updated,
      ...(row.time_completed === null ? {} : { timeCompleted: row.time_completed }),
      ...(row.output === null ? {} : { output: row.output }),
      ...(row.error === null ? {} : { error: row.error }),
      ...(row.owner_id === null ? {} : { ownerID: row.owner_id }),
      ...(row.lease_until === null ? {} : { leaseUntil: row.lease_until }),
      ...(row.heartbeat_at === null ? {} : { heartbeatAt: row.heartbeat_at }),
      metadata: row.metadata ?? {},
    })

    const read = Effect.fn("TaskJob.read")(function* (taskID: SessionSchema.ID) {
      const row = yield* db
        .select()
        .from(BackgroundJobTable)
        .where(and(eq(BackgroundJobTable.id, taskID), eq(BackgroundJobTable.type, "task")))
        .get()
        .pipe(Effect.orDie)
      return row ? fromRow(row) : undefined
    })

    const expireStale = Effect.fn("TaskJob.expireStale")(function* (taskID?: SessionSchema.ID) {
      const rows = yield* recoverStale(db, taskID)
      return rows.map(fromRow)
    })

    const settle = Effect.fn("TaskJob.settle")(function* (
      taskID: SessionSchema.ID,
      token: string,
      status: Exclude<Status, "running">,
      value?: string,
    ) {
      const now = yield* Clock.currentTimeMillis
      const row = yield* db
        .update(BackgroundJobTable)
        .set({
          status,
          time_updated: now,
          time_completed: now,
          lease_until: null,
          ...(status === "completed" ? { output: value ?? "", error: null, delivery_status: "available" } : {}),
          ...(status === "error" ? { error: value ?? "Task failed", delivery_status: "available" } : {}),
          ...(status === "cancelled" ? { delivery_status: "available" } : {}),
        })
        .where(
          and(
            eq(BackgroundJobTable.id, taskID),
            eq(BackgroundJobTable.type, "task"),
            eq(BackgroundJobTable.status, "running"),
            eq(BackgroundJobTable.owner_id, ownerID),
            eq(BackgroundJobTable.cleanup_token, token),
          ),
        )
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (row)
        yield* events.publish(Settled, {
          sessionID: SessionSchema.ID.make(row.child_session_id ?? row.id),
          status,
        })
      return row ? fromRow(row) : yield* read(taskID)
    })

    const get: Interface["get"] = Effect.fn("TaskJob.get")(function* (taskID) {
      const info = yield* read(taskID)
      if (!info || info.status !== "running") return info
      const local = yield* background.get(taskID)
      if (local?.status === "running") return info
      if (info.leaseUntil !== undefined && info.leaseUntil > (yield* Clock.currentTimeMillis)) return info
      yield* expireStale(taskID)
      return yield* read(taskID)
    })

    return Service.of({
      list: Effect.fn("TaskJob.list")(function* (parentSessionID) {
        yield* expireStale()
        const rows = yield* db
          .select()
          .from(BackgroundJobTable)
          .where(
            parentSessionID === undefined
              ? eq(BackgroundJobTable.type, "task")
              : and(eq(BackgroundJobTable.type, "task"), eq(BackgroundJobTable.parent_session_id, parentSessionID)),
          )
          .all()
          .pipe(Effect.orDie)
        return rows.map(fromRow).toSorted((left, right) => left.timeCreated - right.timeCreated)
      }),
      reserve: Effect.fn("TaskJob.reserve")(function* (input) {
        const now = yield* Clock.currentTimeMillis
        const token = Identifier.ascending("job")
        const result = yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .update(BackgroundJobTable)
                .set({
                  status: "error",
                  error: interrupted,
                  delivery_status: "available",
                  lease_until: null,
                  time_completed: now,
                  time_updated: now,
                })
                .where(
                  and(
                    eq(BackgroundJobTable.type, "task"),
                    eq(BackgroundJobTable.status, "running"),
                    or(isNull(BackgroundJobTable.lease_until), lte(BackgroundJobTable.lease_until, now)),
                  ),
                )
                .run()
              const existing = yield* tx
                .select()
                .from(BackgroundJobTable)
                .where(and(eq(BackgroundJobTable.id, input.taskID), eq(BackgroundJobTable.type, "task")))
                .get()
              if (existing && (existing.status === "running" || existing.time_owner_settled === null))
                return yield* Effect.fail(new AlreadyRunningError(input.taskID))
              const active = yield* tx
                .select({ metadata: BackgroundJobTable.metadata })
                .from(BackgroundJobTable)
                .where(and(eq(BackgroundJobTable.type, "task"), eq(BackgroundJobTable.status, "running")))
                .all()
              if (
                active.filter((row) => row.metadata?.rootSessionID === input.rootSessionID).length >= input.maxThreads
              )
                return yield* Effect.fail(new LimitError(input.maxThreads))
              const values = {
                id: input.taskID,
                type: "task",
                status: "running",
                parent_session_id: input.parentSessionID,
                child_session_id: input.taskID,
                parent_message_id: input.parentMessageID,
                parent_call_id: input.parentCallID,
                title: input.title,
                metadata: input.metadata,
                owner_id: ownerID,
                lease_until: now + leaseDuration,
                heartbeat_at: now,
                cleanup_token: token,
                time_owner_settled: null,
                delivery_status: "pending",
                time_created: now,
                time_updated: now,
                time_completed: null,
                output: null,
                error: null,
              }
              const row = existing
                ? yield* tx
                    .update(BackgroundJobTable)
                    .set(values)
                    .where(and(eq(BackgroundJobTable.id, input.taskID), eq(BackgroundJobTable.status, existing.status)))
                    .returning()
                    .get()
                : yield* tx.insert(BackgroundJobTable).values(values).returning().get()
              if (!row) return yield* Effect.fail(new AlreadyRunningError(input.taskID))
              return fromRow(row)
            }),
          )
          .pipe(
            Effect.catch((error) =>
              error instanceof LimitError || error instanceof AlreadyRunningError
                ? Effect.fail(error)
                : Effect.die(error),
            ),
          )
        const owner = { token, state: "reserved" as const, lost: yield* Deferred.make<void>() }
        owned.set(input.taskID, owner)
        // Preparation can take longer than a lease (history, consent, clone).
        // One generation-bound heartbeat owns the whole reserve-to-run interval.
        const heartbeat = yield* Effect.gen(function* () {
          while (true) {
            yield* Effect.sleep(heartbeatInterval)
            const now = yield* Clock.currentTimeMillis
            const row = yield* db.update(BackgroundJobTable)
              .set({ heartbeat_at: now, lease_until: now + leaseDuration, time_updated: now })
              .where(and(eq(BackgroundJobTable.id, input.taskID), eq(BackgroundJobTable.type, "task"),
                eq(BackgroundJobTable.status, "running"), eq(BackgroundJobTable.owner_id, ownerID),
                eq(BackgroundJobTable.cleanup_token, token)))
              .returning({ id: BackgroundJobTable.id }).get().pipe(Effect.orDie)
            if (!row) return
          }
        }).pipe(
          Effect.ensuring(Deferred.succeed(owner.lost, undefined)),
          Effect.interruptible,
          Effect.forkIn(scope, { startImmediately: true }),
        )
        owned.get(input.taskID)!.heartbeat = heartbeat
        return result
      }, Effect.uninterruptible),
      launch: Effect.fn("TaskJob.launch")(function* (taskID, run) {
        const owner = owned.get(taskID)
        if (!owner || owner.state !== "reserved") return yield* Effect.die(`Task job is not reserved here: ${taskID}`)
        const info = yield* read(taskID)
        const row = yield* db.select().from(BackgroundJobTable).where(eq(BackgroundJobTable.id, taskID)).get().pipe(Effect.orDie)
        if (!info || info.status !== "running" || info.ownerID !== ownerID || row?.cleanup_token !== owner.token || owner.state !== "reserved")
          return yield* Effect.die(`Task job is not owned by this process: ${taskID}`)
        owner.state = "running"
        const started = yield* background.start({
          id: taskID,
          type: "task",
          title: info.title,
          metadata: info.metadata,
          onSettled: acknowledge(taskID, owner.token),
          run: Effect.raceFirst(
            run.pipe(
              Effect.matchCauseEffect({
                onSuccess: (output) => settle(taskID, owner.token, "completed", output).pipe(Effect.as(output)),
                onFailure: (cause) => {
                  if (Cause.hasInterruptsOnly(cause))
                    return settle(taskID, owner.token, "cancelled").pipe(Effect.andThen(Effect.failCause(cause)))
                  const error = Cause.squash(cause)
                  return settle(taskID, owner.token, "error", error instanceof Error ? error.message : String(error)).pipe(
                    Effect.andThen(Effect.failCause(cause)),
                  )
                },
              }),
            ),
            Deferred.await(owner.lost).pipe(Effect.andThen(Effect.interrupt)),
          ).pipe(Effect.interruptible),
        })
        if (!started.accepted) {
          owner.state = "closing"
          yield* settle(taskID, owner.token, "error", "Task execution scope was not accepted; prior job is still draining")
          yield* acknowledge(taskID, owner.token)
          return yield* Effect.die(`Task execution scope was not accepted: ${taskID}`)
        }
        return info
      }, Effect.uninterruptible),
      fail: Effect.fn("TaskJob.fail")(function* (taskID, error) {
        const owner = owned.get(taskID)
        const reserved = owner?.state === "reserved"
        if (reserved) owner.state = "closing"
        if (!owner) return yield* read(taskID)
        const result = yield* settle(taskID, owner.token, "error", error)
        if (reserved) yield* acknowledge(taskID, owner.token)
        else yield* background.cancel(taskID).pipe(Effect.timeoutOption(2_000), Effect.ignore)
        return result
      }),
      get,
      wait: Effect.fn("TaskJob.wait")(function* (taskID, timeout) {
        const info = yield* get(taskID)
        if (!info || info.status !== "running") return { info, timedOut: false }
        const local = yield* background.get(taskID)
        if (local?.status === "running") {
          const result = yield* background.wait({ id: taskID, timeout })
          if (result.timedOut) return { info: yield* read(taskID), timedOut: true }
          return { info: yield* read(taskID), timedOut: false }
        }
        const started = yield* Clock.currentTimeMillis
        return yield* Effect.suspend(function loop(): Effect.Effect<{ info?: Info; timedOut: boolean }> {
          return Effect.gen(function* () {
            const current = yield* get(taskID)
            if (!current || current.status !== "running") return { info: current, timedOut: false }
            if (timeout !== undefined && (yield* Clock.currentTimeMillis) - started >= timeout)
              return { info: current, timedOut: true }
            yield* Effect.sleep(remoteWaitInterval)
            return yield* loop()
          })
        })
      }),
      cancel: Effect.fn("TaskJob.cancel")(function* (taskID) {
        const now = yield* Clock.currentTimeMillis
        const row = yield* db
          .update(BackgroundJobTable)
          .set({
            status: "cancelled",
            delivery_status: "available",
            lease_until: null,
            time_completed: now,
            time_updated: now,
          })
          .where(
            and(
              eq(BackgroundJobTable.id, taskID),
              eq(BackgroundJobTable.type, "task"),
              eq(BackgroundJobTable.status, "running"),
            ),
          )
          .returning()
          .get()
          .pipe(Effect.orDie)
        if (row)
          yield* events.publish(Settled, {
            sessionID: SessionSchema.ID.make(row.child_session_id ?? row.id),
            status: "cancelled",
          })
        yield* background.cancel(taskID).pipe(Effect.timeoutOption(2_000), Effect.ignore)
        // Cancellation does not prove an in-flight preparation has drained.
        // Its caller confirms that boundary through fail, or the service closes.
        return row ? fromRow(row) : yield* read(taskID)
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(BackgroundJob.defaultLayer), Layer.provide(EventV2.defaultLayer))
