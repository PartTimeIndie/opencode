import { describe, expect } from "bun:test"
import { eq, sql } from "drizzle-orm"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const it = testEffect(Layer.mergeAll(database, events))
const Changed = EventV2.define({
  type: "test.atomic.changed",
  sync: { version: 1, aggregate: "id" },
  schema: { id: Schema.String, value: Schema.String },
})
const Notice = EventV2.define({ type: "test.atomic.notice", schema: { text: Schema.String } })

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const service = yield* EventV2.Service
  yield* db.run(sql`CREATE TABLE atomic_projection (value TEXT NOT NULL)`).pipe(Effect.orDie)
  yield* service.project(Changed, (event) =>
    db.run(sql`INSERT INTO atomic_projection (value) VALUES (${event.data.value})`).pipe(Effect.orDie, Effect.asVoid),
  )
  return { db, service }
})

const projection = (db: Database.Interface["db"]) =>
  db.all<{ value: string }>(sql`SELECT value FROM atomic_projection`).pipe(Effect.orDie)

describe("atomic event publication", () => {
  it.effect("commits every projection before any sync or UI notification", () =>
    Effect.gen(function* () {
      const { db, service } = yield* setup
      const observed: Array<{ kind: string; count: number }> = []
      const observe = (kind: string) =>
        projection(db).pipe(
          Effect.map((rows) => {
            observed.push({ kind, count: rows.length })
          }),
        )
      yield* service.sync(() => observe("sync"))
      yield* service.listen((event) => observe(event.type))
      const value = yield* EventV2.atomic(
        db,
        Effect.gen(function* () {
          const first = yield* service.publish(Changed, { id: "aggregate", value: "one" })
          expect(first.seq).toBe(0)
          yield* service.publish(Notice, { text: "batch" })
          yield* EventV2.atomic(db, service.publish(Changed, { id: "aggregate", value: "two" }))
          expect(observed).toEqual([])
          return "committed"
        }),
      )
      expect(value).toBe("committed")
      expect(observed).toEqual([
        { kind: "sync", count: 2 },
        { kind: Changed.type, count: 2 },
        { kind: Notice.type, count: 2 },
        { kind: "sync", count: 2 },
        { kind: Changed.type, count: 2 },
      ])
      expect(yield* db.select().from(EventTable).all().pipe(Effect.orDie)).toHaveLength(2)
      expect(yield* db.select().from(EventSequenceTable).get().pipe(Effect.orDie)).toMatchObject({ seq: 1 })
    }),
  )

  it.effect("rolls back events, projections and all notifications when a later step fails", () =>
    Effect.gen(function* () {
      const { db, service } = yield* setup
      const notices: string[] = []
      yield* service.sync(() =>
        Effect.sync(() => {
          notices.push("sync")
        }),
      )
      yield* service.listen(() =>
        Effect.sync(() => {
          notices.push("ui")
        }),
      )
      const result = yield* Effect.exit(
        EventV2.atomic(
          db,
          Effect.gen(function* () {
            yield* service.publish(Changed, { id: "aggregate", value: "one" })
            yield* service.publish(Notice, { text: "not committed" })
            return yield* Effect.fail("later failure")
          }),
        ),
      )
      expect(result).toEqual(Exit.fail("later failure"))
      expect(yield* projection(db)).toEqual([])
      expect(yield* db.select().from(EventTable).all().pipe(Effect.orDie)).toEqual([])
      expect(yield* db.select().from(EventSequenceTable).all().pipe(Effect.orDie)).toEqual([])
      expect(notices).toEqual([])
      yield* service.publish(Changed, { id: "aggregate", value: "normal" })
      expect(notices).toEqual(["sync", "ui"])
    }),
  )

  it.effect("a caught nested failure rolls back its savepoint and discards only its notifications", () =>
    Effect.gen(function* () {
      const { db, service } = yield* setup
      const notices: string[] = []
      yield* service.listen((event) =>
        Effect.sync(() => {
          notices.push(event.type)
        }),
      )
      yield* EventV2.atomic(
        db,
        Effect.gen(function* () {
          yield* service.publish(Changed, { id: "aggregate", value: "before" })
          const nested = yield* EventV2.atomic(
            db,
            Effect.gen(function* () {
              yield* service.publish(Changed, { id: "aggregate", value: "rolled back" })
              yield* service.publish(Notice, { text: "discard" })
              return yield* Effect.fail("nested failure")
            }),
          ).pipe(Effect.exit)
          expect(nested).toEqual(Exit.fail("nested failure"))
          yield* service.publish(Changed, { id: "aggregate", value: "after" })
          expect(notices).toEqual([])
        }),
      )
      expect(yield* projection(db)).toEqual([{ value: "before" }, { value: "after" }])
      expect(notices).toEqual([Changed.type, Changed.type])
      expect(yield* db.select().from(EventTable).all().pipe(Effect.orDie)).toHaveLength(2)
    }),
  )

  it.live("interruption before commit discards the batch and does not poison the writer", () =>
    Effect.gen(function* () {
      const { db, service } = yield* setup
      const reached = yield* Deferred.make<void>()
      const notices: string[] = []
      yield* service.listen(() =>
        Effect.sync(() => {
          notices.push("ui")
        }),
      )
      const writer = yield* EventV2.atomic(
        db,
        Effect.gen(function* () {
          yield* service.publish(Changed, { id: "aggregate", value: "interrupted" })
          yield* Deferred.succeed(reached, undefined)
          yield* Effect.never
        }),
      ).pipe(Effect.forkScoped)
      yield* Deferred.await(reached)
      const started = performance.now()
      yield* Fiber.interrupt(writer)
      const exit = yield* Fiber.await(writer)
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(performance.now() - started).toBeLessThan(1_000)
      expect(yield* projection(db)).toEqual([])
      expect(notices).toEqual([])
      yield* service.publish(Changed, { id: "aggregate", value: "after" })
      expect(yield* projection(db)).toEqual([{ value: "after" }])
      expect(notices).toEqual(["ui"])
    }),
  )

  it.effect("refuses a plain outer SQL transaction that could roll back after notifications", () =>
    Effect.gen(function* () {
      const { db, service } = yield* setup
      const notices: string[] = []
      yield* service.listen(() =>
        Effect.sync(() => {
          notices.push("ui")
        }),
      )
      const result = yield* db
        .transaction(() => EventV2.atomic(db, service.publish(Changed, { id: "aggregate", value: "unsafe-nesting" })))
        .pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(yield* projection(db)).toEqual([])
      expect(notices).toEqual([])
    }),
  )

  it.effect("refuses publication from a plain nested savepoint even when its failure is caught", () =>
    Effect.gen(function* () {
      const { db, service } = yield* setup
      const notices: string[] = []
      yield* service.listen((event) =>
        Effect.sync(() => {
          notices.push(event.type)
        }),
      )
      yield* EventV2.atomic(
        db,
        Effect.gen(function* () {
          const nested = yield* db
            .transaction(() => service.publish(Changed, { id: "aggregate", value: "unsafe" }))
            .pipe(Effect.exit)
          expect(Exit.isFailure(nested)).toBe(true)
          yield* service.publish(Changed, { id: "aggregate", value: "safe" })
        }),
      )
      expect(yield* projection(db)).toEqual([{ value: "safe" }])
      expect(notices).toEqual([Changed.type])
    }),
  )

  for (const rollback of [false, true]) {
    it.effect(`rejects inherited publishers before guards when the owner ${rollback ? "rolls back" : "commits"}`, () =>
      Effect.gen(function* () {
        const { db, service } = yield* setup
        let guards = 0
        yield* service.beforeCommit(() =>
          Effect.sync(() => {
            guards++
          }),
        )
        const result = yield* EventV2.atomic(
          db,
          Effect.gen(function* () {
            const children = yield* Effect.all(
              ["one", "two"].map((value) => service.publish(Changed, { id: "aggregate", value }).pipe(Effect.exit)),
              { concurrency: "unbounded" },
            )
            expect(children.every(Exit.isFailure)).toBe(true)
            expect(guards).toBe(0)
            yield* service.publish(Changed, { id: "aggregate", value: "owner" })
            if (rollback) return yield* Effect.fail("rollback")
          }),
        ).pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(rollback)
        expect(yield* projection(db)).toEqual(rollback ? [] : [{ value: "owner" }])
        yield* service.publish(Changed, { id: "aggregate", value: "after" })
        expect(guards).toBe(2)
      }),
    )
  }

  it.effect("rejects overlapping inherited atomic scopes before either can open a savepoint", () =>
    Effect.gen(function* () {
      const { db, service } = yield* setup
      const release = yield* Deferred.make<void>()
      yield* EventV2.atomic(
        db,
        Effect.gen(function* () {
          const first = yield* Deferred.await(release).pipe(
            Effect.andThen(EventV2.atomic(db, service.publish(Changed, { id: "aggregate", value: "one" }))),
            Effect.exit,
            Effect.forkScoped,
          )
          const second = yield* Deferred.await(release).pipe(
            Effect.andThen(EventV2.atomic(db, service.publish(Changed, { id: "aggregate", value: "two" }))),
            Effect.exit,
            Effect.forkScoped,
          )
          yield* Deferred.succeed(release, undefined)
          expect(Exit.isFailure(yield* Fiber.join(first))).toBe(true)
          expect(Exit.isFailure(yield* Fiber.join(second))).toBe(true)
          yield* service.publish(Changed, { id: "aggregate", value: "owner" })
        }),
      )
      expect(yield* projection(db)).toEqual([{ value: "owner" }])
    }),
  )

  it.live("cancels a stalled post-commit observer without rolling back committed rows", () =>
    Effect.gen(function* () {
      const { db, service } = yield* setup
      const reached = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const delivered: string[] = []
      yield* service.listen(() => Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(release))))
      yield* service.listen(() =>
        Effect.sync(() => {
          delivered.push("later observer")
        }),
      )
      const writer = yield* EventV2.atomic(db, service.publish(Changed, { id: "aggregate", value: "committed" })).pipe(
        Effect.forkScoped,
      )
      yield* Deferred.await(reached)
      const stopped = yield* Fiber.interrupt(writer).pipe(
        Effect.timeoutOption("500 millis"),
        Effect.ensuring(Deferred.succeed(release, undefined)),
      )
      expect(stopped._tag).toBe("Some")
      expect(Exit.isFailure(yield* Fiber.await(writer))).toBe(true)
      expect(yield* projection(db)).toEqual([{ value: "committed" }])
      expect(delivered).toEqual([])
      yield* service.publish(Changed, { id: "aggregate", value: "after" })
      expect(yield* projection(db)).toHaveLength(2)
      expect(delivered).toEqual(["later observer"])
    }),
  )

  it.effect("a delayed inherited publisher cannot use an expired transaction scope", () =>
    Effect.gen(function* () {
      const { db, service } = yield* setup
      const release = yield* Deferred.make<void>()
      const late = yield* EventV2.atomic(
        db,
        Effect.gen(function* () {
          yield* service.publish(Changed, { id: "aggregate", value: "committed" })
          return yield* Deferred.await(release).pipe(
            Effect.andThen(service.publish(Changed, { id: "aggregate", value: "late" })),
            Effect.exit,
            Effect.forkScoped,
          )
        }),
      )
      yield* Deferred.succeed(release, undefined)
      expect(Exit.isFailure(yield* Fiber.join(late))).toBe(true)
      expect(yield* projection(db)).toEqual([{ value: "committed" }])
      expect(
        yield* db
          .select()
          .from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, "aggregate"))
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({ seq: 0 })
    }),
  )
})
