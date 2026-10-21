import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { QuestionV2 } from "@opencode-ai/core/question"
import { QuestionTable } from "@opencode-ai/core/question/sql"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionOrchestrator } from "@opencode-ai/core/session/orchestrator"
import { OrchestratorCheckout } from "@opencode-ai/core/session/orchestrator/checkout"
import { OrchestratorPolicy } from "@opencode-ai/core/session/orchestrator/policy"
import {
  SessionOrchestratorTable,
  SessionOrchestratorTaskTable,
  SessionOrchestratorReservationTable,
} from "@opencode-ai/core/session/orchestrator/sql"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import {
  SessionActivityTable,
  SessionInputTable,
  SessionMessageTable,
  SessionTable,
} from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const checkout = Layer.succeed(
  OrchestratorCheckout.Service,
  OrchestratorCheckout.Service.of({
    resolve: (directory) => Effect.succeed(OrchestratorCheckout.pathKey(directory).replace(/\/src$/, "")),
  }),
)
const store = SessionOrchestrator.layer.pipe(Layer.provide(database), Layer.provide(checkout))
const it = testEffect(Layer.merge(database, store))
const mainID = SessionSchema.ID.make("ses_orchestrator_main")
const otherID = SessionSchema.ID.make("ses_orchestrator_other")
const childID = SessionSchema.ID.make("ses_orchestrator_child")
const secondChildID = SessionSchema.ID.make("ses_orchestrator_child_two")
const originID = SessionMessage.ID.make("msg_orchestrator_origin")

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/orchestrator"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values([
      {
        id: mainID,
        project_id: ProjectV2.ID.global,
        slug: "main",
        title: "main",
        directory: "/orchestrator",
        version: "test",
      },
      {
        id: otherID,
        project_id: ProjectV2.ID.global,
        slug: "other",
        title: "other",
        directory: "/orchestrator",
        version: "test",
      },
      {
        id: childID,
        parent_id: mainID,
        project_id: ProjectV2.ID.global,
        slug: "child",
        title: "child",
        directory: "/orchestrator",
        version: "test",
      },
      {
        id: secondChildID,
        parent_id: mainID,
        project_id: ProjectV2.ID.global,
        slug: "child-two",
        title: "child-two",
        directory: "/orchestrator",
        version: "test",
      },
    ])
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionInputTable)
    .values({
      id: originID,
      session_id: mainID,
      prompt: { text: "Implement the assigned change" },
      delivery: "steer",
      admitted_seq: 1,
      promoted_seq: 2,
    })
    .run()
    .pipe(Effect.orDie)
  const data = { text: "Implement the assigned change", time: { created: 1 } }
  yield* db
    .insert(SessionMessageTable)
    .values({ id: originID, session_id: mainID, type: "user", seq: 2, data })
    .run()
    .pipe(Effect.orDie)
  const service = yield* SessionOrchestrator.Service
  yield* service.configure({ mainSessionID: mainID, expectedRevision: 0, ...OrchestratorPolicy.defaults })
  return service
})

function proposal(id: string, resources = [`path:/orchestrator/${id}.ts`]): SessionOrchestrator.PlanInput {
  return {
    id,
    requestID: `request-${id}`,
    mainSessionID: mainID,
    originInputID: originID,
    goal: `Implement ${id}`,
    acceptance: "Tests pass",
    resources,
    dependencies: [],
  }
}

function reason<A>(effect: Effect.Effect<A, SessionOrchestrator.Conflict>) {
  return Effect.gen(function* () {
    const result = yield* Effect.exit(effect)
    if (Exit.isSuccess(result)) throw new Error("Expected an Orchestrator conflict")
    const failure = result.cause.reasons.find((item) => item._tag === "Fail")
    return failure?._tag === "Fail" ? failure.error.reason : undefined
  })
}

describe("orchestrator planning store (not child execution authority)", () => {
  it.effect("refuses checkout drift at configure, plan and reserve without changing claims", () =>
    Effect.gen(function* () {
      const service = yield* setup
      yield* service.plan(proposal("before-move"))
      const { db } = yield* Database.Service
      const before = yield* service.get(mainID)
      yield* db
        .update(SessionTable)
        .set({ directory: "/moved" })
        .where(eq(SessionTable.id, mainID))
        .run()
        .pipe(Effect.orDie)
      expect(
        yield* reason(
          service.configure({ mainSessionID: mainID, expectedRevision: 1, ...OrchestratorPolicy.defaults }),
        ),
      ).toBe("resources")
      expect(yield* reason(service.plan(proposal("after-move")))).toBe("resources")
      expect(
        yield* reason(service.reserve({ mainSessionID: mainID, taskID: "before-move", expectedRevision: 1 })),
      ).toBe("resources")
      expect(yield* service.get(mainID)).toEqual(before)
      expect(yield* db.select().from(SessionOrchestratorReservationTable).all().pipe(Effect.orDie)).toEqual([])
      expect(yield* service.tasks(mainID)).toHaveLength(1)
    }),
  )

  it.effect("does not hold the database write lock while resolving checkout placement", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const service = yield* SessionOrchestrator.Service.pipe(
        Effect.provide(Layer.fresh(SessionOrchestrator.layer)),
        Effect.provideService(OrchestratorCheckout.Service, {
          resolve: (directory) =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(OrchestratorCheckout.pathKey(directory)),
            ),
        }),
      )
      const fiber = yield* service
        .configure({ mainSessionID: mainID, expectedRevision: 1, ...OrchestratorPolicy.defaults })
        .pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      // This independent writer must finish before the filesystem probe is released.
      yield* db
        .transaction((tx) =>
          tx.update(SessionTable).set({ title: "concurrent write" }).where(eq(SessionTable.id, mainID)).run(),
        )
        .pipe(Effect.orDie)
      yield* Deferred.succeed(release, undefined)
      expect((yield* Fiber.join(fiber)).revision).toBe(2)
    }),
  )

  it.effect("rechecks the session directory after an outside-transaction filesystem probe", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const service = yield* SessionOrchestrator.Service.pipe(
        Effect.provide(Layer.fresh(SessionOrchestrator.layer)),
        Effect.provideService(OrchestratorCheckout.Service, {
          resolve: (directory) =>
            db
              .update(SessionTable)
              .set({ directory: "/moved-during-probe" })
              .where(eq(SessionTable.id, mainID))
              .run()
              .pipe(Effect.orDie, Effect.as(OrchestratorCheckout.pathKey(directory))),
        }),
      )
      expect(
        yield* reason(
          service.configure({ mainSessionID: mainID, expectedRevision: 1, ...OrchestratorPolicy.defaults }),
        ),
      ).toBe("resources")
      expect((yield* service.get(mainID))?.revision).toBe(1)
    }),
  )

  it.effect("maps a failed checkout probe to a typed resource conflict", () =>
    Effect.gen(function* () {
      yield* setup
      const service = yield* SessionOrchestrator.Service.pipe(
        Effect.provide(Layer.fresh(SessionOrchestrator.layer)),
        Effect.provideService(OrchestratorCheckout.Service, {
          resolve: (directory) => Effect.fail(new OrchestratorCheckout.ResolutionError({ directory })),
        }),
      )
      expect(
        yield* reason(
          service.configure({ mainSessionID: mainID, expectedRevision: 1, ...OrchestratorPolicy.defaults }),
        ),
      ).toBe("resources")
    }),
  )

  for (const prompt of ["{}", "null", '{"text":3}']) {
    it.effect(`rejects malformed origin prompt ${prompt} as a typed conflict`, () =>
      Effect.gen(function* () {
        const service = yield* setup
        const { db } = yield* Database.Service
        yield* db.run(`UPDATE session_input SET prompt='${prompt}'`).pipe(Effect.orDie)
        expect(yield* reason(service.plan(proposal("malformed-origin")))).toBe("origin")
        expect(yield* service.tasks(mainID)).toEqual([])
      }),
    )
  }

  for (const directory of ["/orchestrator/src", "/independent"]) {
    it.effect(`keeps physical-file exclusion after repair from ${directory}`, () =>
      Effect.gen(function* () {
        const service = yield* setup
        const { db } = yield* Database.Service
        yield* db.update(SessionTable).set({ directory }).where(eq(SessionTable.id, otherID)).run().pipe(Effect.orDie)
        yield* service.configure({ mainSessionID: otherID, expectedRevision: 0, ...OrchestratorPolicy.defaults })
        const otherOrigin = SessionMessage.ID.make("msg_other_origin")
        yield* db
          .insert(SessionInputTable)
          .values({
            id: otherOrigin,
            session_id: otherID,
            prompt: { text: "Other work" },
            delivery: "steer",
            admitted_seq: 1,
            promoted_seq: 2,
          })
          .run()
          .pipe(Effect.orDie)
        const data = { text: "Other work", time: { created: 1 } }
        yield* db
          .insert(SessionMessageTable)
          .values({ id: otherOrigin, session_id: otherID, type: "user", seq: 2, data })
          .run()
          .pipe(Effect.orDie)
        yield* service.plan(proposal("base", ["path:/orchestrator/src"]))
        yield* service.plan({
          ...proposal("other", ["path:/orchestrator/src/file.ts"]),
          mainSessionID: otherID,
          originInputID: otherOrigin,
        })
        const held = yield* service.reserve({ mainSessionID: mainID, taskID: "base", expectedRevision: 1 })
        yield* db.run("DROP TABLE session_orchestrator_reservation").pipe(Effect.orDie)
        yield* DatabaseMigration.apply(db).pipe(Effect.orDie)
        expect(yield* service.reserve({ mainSessionID: otherID, taskID: "other", expectedRevision: 1 })).toMatchObject({
          state: "waiting",
        })
        yield* service.transition({
          mainSessionID: mainID,
          taskID: held.id,
          expectedRevision: held.revision,
          state: "cancelled",
        })
        yield* db
          .update(SessionTable)
          .set({ time_archived: 1 })
          .where(eq(SessionTable.id, mainID))
          .run()
          .pipe(Effect.orDie)
        expect(
          yield* reason(service.releaseUnstarted({ mainSessionID: otherID, taskID: held.id, expectedRevision: 3 })),
        ).toBe("missing")
        yield* service.releaseUnstarted({ mainSessionID: mainID, taskID: held.id, expectedRevision: 3 })
        expect(yield* service.reserve({ mainSessionID: otherID, taskID: "other", expectedRevision: 2 })).toMatchObject({
          state: "reserved",
        })
      }),
    )
  }

  it.effect("serializes overlapping races and exact proposal races without losing claims", () =>
    Effect.gen(function* () {
      const service = yield* setup
      const first = proposal("same", ["interface:shared"])
      const results = yield* Effect.all([service.plan(first), service.plan(first)], { concurrency: "unbounded" })
      expect(results[0]).toEqual(results[1])
      yield* service.plan(proposal("other", ["interface:shared"]))
      const reserved = yield* Effect.all(
        ["same", "other"].map((taskID) => service.reserve({ mainSessionID: mainID, taskID, expectedRevision: 1 })),
        { concurrency: "unbounded" },
      )
      expect(reserved.filter((task) => task.slot_claimed)).toHaveLength(1)
      expect(reserved.filter((task) => task.state === "waiting")).toHaveLength(1)
    }),
  )

  it.effect("resumes released unstarted pauses and reports corrupt state as a typed conflict", () =>
    Effect.gen(function* () {
      const service = yield* setup
      yield* service.plan(proposal("resume"))
      yield* service.reserve({ mainSessionID: mainID, taskID: "resume", expectedRevision: 1 })
      yield* service.transition({ mainSessionID: mainID, taskID: "resume", expectedRevision: 2, state: "paused" })
      expect(
        yield* reason(
          service.transition({ mainSessionID: mainID, taskID: "resume", expectedRevision: 3, state: "waiting" }),
        ),
      ).toBe("transition")
      yield* service.releaseUnstarted({ mainSessionID: mainID, taskID: "resume", expectedRevision: 3 })
      yield* service.transition({ mainSessionID: mainID, taskID: "resume", expectedRevision: 4, state: "waiting" })
      expect(yield* service.reserve({ mainSessionID: mainID, taskID: "resume", expectedRevision: 5 })).toMatchObject({
        state: "reserved",
      })
      const { db } = yield* Database.Service
      yield* db.run("UPDATE session_orchestrator_task SET state='corrupt' WHERE id='resume'").pipe(Effect.orDie)
      expect(
        yield* reason(
          service.transition({ mainSessionID: mainID, taskID: "resume", expectedRevision: 6, state: "failed" }),
        ),
      ).toBe("transition")
      yield* db.delete(SessionTable).where(eq(SessionTable.id, mainID)).run().pipe(Effect.orDie)
      expect(yield* db.select().from(SessionOrchestratorTaskTable).all().pipe(Effect.orDie)).toEqual([])
    }),
  )

  it.effect("keeps revision-checked settings per Main and rejects child configuration", () =>
    Effect.gen(function* () {
      const service = yield* setup
      expect(yield* service.get(otherID)).toBeUndefined()
      expect(
        yield* reason(
          service.configure({ mainSessionID: childID, expectedRevision: 0, ...OrchestratorPolicy.defaults }),
        ),
      ).toBe("role")
      expect(
        yield* reason(
          service.configure({ mainSessionID: mainID, expectedRevision: 0, ...OrchestratorPolicy.defaults }),
        ),
      ).toBe("revision")
      expect(
        yield* reason(
          service.configure({
            mainSessionID: mainID,
            expectedRevision: 1,
            ...OrchestratorPolicy.defaults,
            maxWorkers: 1.5,
          }),
        ),
      ).toBe("settings")
      const next = yield* service.configure({
        mainSessionID: mainID,
        expectedRevision: 1,
        ...OrchestratorPolicy.defaults,
        interaction: false,
        workspaceMode: "shared",
      })
      expect(next).toMatchObject({ revision: 2, interaction: false, workspace_mode: "shared" })
      expect(yield* service.get(otherID)).toBeUndefined()
    }),
  )

  it.effect("reconciles exact proposal retries and rejects conflicting IDs, foreign origins and dependencies", () =>
    Effect.gen(function* () {
      const service = yield* setup
      const input = proposal("task-one")
      const first = yield* service.plan(input)
      expect(yield* service.plan(input)).toEqual(first)
      expect(yield* reason(service.plan({ ...input, goal: "A different assignment" }))).toBe("retry")
      expect(yield* reason(service.plan({ ...input, requestID: "different-request" }))).toBe("retry")
      expect(
        yield* reason(service.plan({ ...proposal("task-two"), originInputID: SessionMessage.ID.make("msg_missing") })),
      ).toBe("origin")
      expect(yield* reason(service.plan({ ...proposal("task-two"), dependencies: ["missing-task"] }))).toBe(
        "dependency",
      )
      expect(yield* service.tasks(mainID)).toHaveLength(1)
      expect(yield* service.tasks(otherID)).toEqual([])
      expect(yield* reason(service.reserve({ mainSessionID: otherID, taskID: first.id, expectedRevision: 1 }))).toBe(
        "missing",
      )
    }),
  )

  it.effect("claims only four planning slots, retains blocked ownership, and serializes unknown write scopes", () =>
    Effect.gen(function* () {
      const service = yield* setup
      for (const id of ["one", "two", "three", "four", "five"]) yield* service.plan(proposal(id))
      for (const id of ["one", "two", "three", "four"]) {
        const row = yield* service.reserve({ mainSessionID: mainID, taskID: id, expectedRevision: 1 })
        expect(row).toMatchObject({ state: "reserved", slot_claimed: true, revision: 2 })
      }
      expect(yield* service.reserve({ mainSessionID: mainID, taskID: "five", expectedRevision: 1 })).toMatchObject({
        state: "waiting",
        slot_claimed: false,
      })
      yield* service.transition({ mainSessionID: mainID, taskID: "one", expectedRevision: 2, state: "paused" })
      expect(yield* service.reserve({ mainSessionID: mainID, taskID: "five", expectedRevision: 2 })).toMatchObject({
        state: "waiting",
        slot_claimed: false,
      })
      yield* service.configure({
        mainSessionID: mainID,
        expectedRevision: 1,
        ...OrchestratorPolicy.defaults,
        maxWorkers: 10,
      })
      yield* service.plan(proposal("shell", ["project:*"]))
      expect(yield* service.reserve({ mainSessionID: mainID, taskID: "shell", expectedRevision: 1 })).toMatchObject({
        state: "waiting",
        slot_claimed: false,
      })
    }),
  )

  it.effect("serializes concurrent slot claims and releases only unstarted settled reservations", () =>
    Effect.gen(function* () {
      const service = yield* setup
      const ids = ["one", "two", "three", "four", "five", "six"]
      for (const id of ids) yield* service.plan(proposal(id))
      const rows = yield* Effect.all(
        ids.map((taskID) => service.reserve({ mainSessionID: mainID, taskID, expectedRevision: 1 })),
        { concurrency: "unbounded" },
      )
      expect(rows.filter((row) => row.slot_claimed)).toHaveLength(4)
      const held = rows.find((row) => row.slot_claimed)
      const waiting = rows.find((row) => !row.slot_claimed)
      if (!held || !waiting) throw new Error("Missing concurrent reservation fixtures")
      expect(
        yield* reason(service.releaseUnstarted({ mainSessionID: mainID, taskID: held.id, expectedRevision: 2 })),
      ).toBe("transition")
      yield* service.transition({ mainSessionID: mainID, taskID: held.id, expectedRevision: 2, state: "paused" })
      expect(
        yield* service.releaseUnstarted({ mainSessionID: mainID, taskID: held.id, expectedRevision: 3 }),
      ).toMatchObject({ slot_claimed: false, revision: 4 })
      expect(yield* service.reserve({ mainSessionID: mainID, taskID: waiting.id, expectedRevision: 2 })).toMatchObject({
        state: "reserved",
        slot_claimed: true,
      })
    }),
  )

  it.effect("blocks dependency starts and overlapping paths without partial reservations", () =>
    Effect.gen(function* () {
      const service = yield* setup
      yield* service.plan(proposal("base", ["path:/orchestrator/src"]))
      yield* service.plan({ ...proposal("dependent"), dependencies: ["base"] })
      expect(yield* service.reserve({ mainSessionID: mainID, taskID: "dependent", expectedRevision: 1 })).toMatchObject(
        { state: "waiting" },
      )
      yield* service.reserve({ mainSessionID: mainID, taskID: "base", expectedRevision: 1 })
      yield* service.plan(proposal("overlap", ["path:/orchestrator/unrelated", "path:/orchestrator/src/file.ts"]))
      expect(yield* service.reserve({ mainSessionID: mainID, taskID: "overlap", expectedRevision: 1 })).toMatchObject({
        state: "waiting",
      })
      yield* service.plan(proposal("independent", ["path:/orchestrator/unrelated"]))
      expect(
        yield* service.reserve({ mainSessionID: mainID, taskID: "independent", expectedRevision: 1 }),
      ).toMatchObject({ state: "reserved" })
      expect(
        yield* reason(
          service.transition({ mainSessionID: mainID, taskID: "dependent", expectedRevision: 2, state: "reserved" }),
        ),
      ).toBe("transition")
    }),
  )

  for (const control of ["draining", "paused"] as const) {
    it.effect(`blocks new admission under ${control} without pretending tasks have settled`, () =>
      Effect.gen(function* () {
        const service = yield* setup
        yield* service.plan(proposal("one"))
        yield* service.reserve({ mainSessionID: mainID, taskID: "one", expectedRevision: 1 })
        yield* service.plan(proposal("two"))
        yield* service.control({ mainSessionID: mainID, expectedRevision: 1, control })
        expect(yield* reason(service.reserve({ mainSessionID: mainID, taskID: "two", expectedRevision: 1 }))).toBe(
          "control",
        )
        expect((yield* service.tasks(mainID)).find((row) => row.id === "one")?.state).toBe("reserved")
        yield* service.configure({
          mainSessionID: mainID,
          expectedRevision: 2,
          ...OrchestratorPolicy.defaults,
          interaction: false,
        })
        expect(yield* service.get(mainID)).toMatchObject({ interaction: false, control })
      }),
    )
  }

  it.effect("keeps unknown repaired checkout claims blocking independent admission", () =>
    Effect.gen(function* () {
      const service = yield* setup
      yield* service.plan(proposal("legacy-claim"))
      yield* service.reserve({ mainSessionID: mainID, taskID: "legacy-claim", expectedRevision: 1 })
      const { db } = yield* Database.Service
      yield* db
        .update(SessionOrchestratorTaskTable)
        .set({ checkout_id: "" })
        .where(eq(SessionOrchestratorTaskTable.id, "legacy-claim"))
        .run()
        .pipe(Effect.orDie)
      yield* service.plan(proposal("independent-new"))
      expect(
        yield* service.reserve({ mainSessionID: mainID, taskID: "independent-new", expectedRevision: 1 }),
      ).toMatchObject({ state: "waiting", slot_claimed: false })
    }),
  )

  for (const [label, usage, expected, fallback] of [
    ["threshold", { inputTokens: 1000, cacheReadInputTokens: 800 }, "running", "continue"],
    ["low", { inputTokens: 1000, cacheReadInputTokens: 790 }, "blocked_cache", "ask-main"],
    ["unknown", {}, "blocked_cache", "ask-main"],
  ] as const) {
    it.effect(`records ${label} first-request cache evidence without a generic running bypass`, () =>
      Effect.gen(function* () {
        const service = yield* setup
        yield* service.plan(proposal("cache"))
        yield* service.reserve({ mainSessionID: mainID, taskID: "cache", expectedRevision: 1 })
        yield* service.transition({
          mainSessionID: mainID,
          taskID: "cache",
          expectedRevision: 2,
          state: "snapshotting",
        })
        yield* service.transition({ mainSessionID: mainID, taskID: "cache", expectedRevision: 3, state: "starting" })
        yield* service.transition({
          mainSessionID: mainID,
          taskID: "cache",
          expectedRevision: 4,
          state: "checking_cache",
        })
        expect(
          yield* reason(
            service.transition({ mainSessionID: mainID, taskID: "cache", expectedRevision: 5, state: "running" }),
          ),
        ).toBe("transition")
        if (label === "low")
          yield* service.configure({
            mainSessionID: mainID,
            expectedRevision: 1,
            ...OrchestratorPolicy.defaults,
            minCacheReadRatio: 0,
          })
        const result = yield* service.recordCache({
          mainSessionID: mainID,
          taskID: "cache",
          expectedRevision: 5,
          profile: "model-route-tools-epoch",
          usage,
        })
        expect(result.task).toMatchObject({ state: expected, slot_claimed: true, revision: 6 })
        expect(result.fallback).toBe(fallback)
        expect(
          yield* reason(
            service.recordCache({
              mainSessionID: mainID,
              taskID: "cache",
              expectedRevision: 6,
              profile: "model-route-tools-epoch",
              usage,
            }),
          ),
        ).toBe("cache")
      }),
    )
  }

  it.effect("rejects a corrupt stored cache threshold as a typed conflict", () =>
    Effect.gen(function* () {
      const service = yield* setup
      yield* service.plan(proposal("corrupt-cache"))
      yield* service.reserve({ mainSessionID: mainID, taskID: "corrupt-cache", expectedRevision: 1 })
      for (const [revision, state] of [
        [2, "snapshotting"],
        [3, "starting"],
        [4, "checking_cache"],
      ] as const)
        yield* service.transition({ mainSessionID: mainID, taskID: "corrupt-cache", expectedRevision: revision, state })
      const { db } = yield* Database.Service
      yield* db
        .update(SessionOrchestratorTaskTable)
        .set({ min_cache_read_ratio: 2 })
        .where(eq(SessionOrchestratorTaskTable.id, "corrupt-cache"))
        .run()
        .pipe(Effect.orDie)
      expect(
        yield* reason(
          service.recordCache({
            mainSessionID: mainID,
            taskID: "corrupt-cache",
            expectedRevision: 5,
            profile: "profile",
            usage: { inputTokens: 100, cacheReadInputTokens: 100 },
          }),
        ),
      ).toBe("cache")
      expect((yield* service.tasks(mainID))[0]?.state).toBe("checking_cache")
    }),
  )

  it.effect("uses Main-only fallback with interaction off and preserves settings for earlier tasks", () =>
    Effect.gen(function* () {
      const service = yield* setup
      yield* service.plan(proposal("cache"))
      yield* service.configure({
        mainSessionID: mainID,
        expectedRevision: 1,
        ...OrchestratorPolicy.defaults,
        interaction: false,
        workspaceMode: "shared",
      })
      expect((yield* service.tasks(mainID))[0]?.workspace_mode).toBe("mirror")
      yield* service.reserve({ mainSessionID: mainID, taskID: "cache", expectedRevision: 1 })
      yield* service.transition({ mainSessionID: mainID, taskID: "cache", expectedRevision: 2, state: "snapshotting" })
      yield* service.transition({ mainSessionID: mainID, taskID: "cache", expectedRevision: 3, state: "starting" })
      yield* service.transition({
        mainSessionID: mainID,
        taskID: "cache",
        expectedRevision: 4,
        state: "checking_cache",
      })
      expect(
        (yield* service.recordCache({
          mainSessionID: mainID,
          taskID: "cache",
          expectedRevision: 5,
          profile: "profile",
          usage: {},
        })).fallback,
      ).toBe("main-only")
    }),
  )
})

describe("orchestrator child binding and settlement (store seam, not host attestation)", () => {
  it.effect("binds a started child atomically and idempotently without freeing the slot", () =>
    Effect.gen(function* () {
      const service = yield* setup
      const { db } = yield* Database.Service
      yield* service.plan(proposal("bind"))
      expect(
        yield* reason(
          service.assignChild({ mainSessionID: mainID, taskID: "bind", expectedRevision: 1, childSessionID: childID }),
        ),
      ).toBe("transition")
      yield* service.reserve({ mainSessionID: mainID, taskID: "bind", expectedRevision: 1 })
      yield* service.transition({ mainSessionID: mainID, taskID: "bind", expectedRevision: 2, state: "snapshotting" })
      expect(
        yield* reason(
          service.assignChild({ mainSessionID: mainID, taskID: "bind", expectedRevision: 3, childSessionID: otherID }),
        ),
      ).toBe("child")
      // A session that is itself a configured Main can never become a child;
      // simulate legacy/corrupt dual role by writing the orchestrator row directly.
      yield* db
        .insert(SessionOrchestratorTable)
        .values({ main_session_id: childID, checkout_id: "/elsewhere" })
        .run()
        .pipe(Effect.orDie)
      expect(
        yield* reason(
          service.assignChild({ mainSessionID: mainID, taskID: "bind", expectedRevision: 3, childSessionID: childID }),
        ),
      ).toBe("role")
      yield* db
        .delete(SessionOrchestratorTable)
        .where(eq(SessionOrchestratorTable.main_session_id, childID))
        .run()
        .pipe(Effect.orDie)
      yield* service.transition({ mainSessionID: mainID, taskID: "bind", expectedRevision: 3, state: "starting" })
      const bound = yield* service.assignChild({
        mainSessionID: mainID,
        taskID: "bind",
        expectedRevision: 4,
        childSessionID: childID,
      })
      expect(bound).toMatchObject({ child_session_id: childID, slot_claimed: true, revision: 5 })
      expect(
        yield* service.assignChild({
          mainSessionID: mainID,
          taskID: "bind",
          expectedRevision: 5,
          childSessionID: childID,
        }),
      ).toMatchObject({ child_session_id: childID, revision: 5 })
      expect(
        yield* reason(
          service.assignChild({
            mainSessionID: mainID,
            taskID: "bind",
            expectedRevision: 5,
            childSessionID: secondChildID,
          }),
        ),
      ).toBe("transition")
      yield* db
        .update(SessionTable)
        .set({ parent_id: otherID })
        .where(eq(SessionTable.id, secondChildID))
        .run()
        .pipe(Effect.orDie)
      yield* service.plan(proposal("second", ["path:/orchestrator/second.ts"]))
      yield* service.reserve({ mainSessionID: mainID, taskID: "second", expectedRevision: 1 })
      yield* service.transition({ mainSessionID: mainID, taskID: "second", expectedRevision: 2, state: "snapshotting" })
      yield* service.transition({ mainSessionID: mainID, taskID: "second", expectedRevision: 3, state: "starting" })
      expect(
        yield* reason(
          service.assignChild({
            mainSessionID: mainID,
            taskID: "second",
            expectedRevision: 4,
            childSessionID: childID,
          }),
        ),
      ).toBe("child")
      expect(
        yield* reason(
          service.assignChild({
            mainSessionID: mainID,
            taskID: "second",
            expectedRevision: 4,
            childSessionID: SessionSchema.ID.make("ses_orchestrator_missing"),
          }),
        ),
      ).toBe("child")
    }),
  )

  it.effect("settles only from durable child evidence, frees capacity and retains provenance", () =>
    Effect.gen(function* () {
      const service = yield* setup
      const { db } = yield* Database.Service
      yield* service.plan(proposal("settle"))
      yield* service.reserve({ mainSessionID: mainID, taskID: "settle", expectedRevision: 1 })
      yield* service.transition({ mainSessionID: mainID, taskID: "settle", expectedRevision: 2, state: "snapshotting" })
      yield* service.transition({ mainSessionID: mainID, taskID: "settle", expectedRevision: 3, state: "starting" })
      yield* service.assignChild({
        mainSessionID: mainID,
        taskID: "settle",
        expectedRevision: 4,
        childSessionID: childID,
      })
      expect(
        yield* reason(
          service.settleChild({
            mainSessionID: mainID,
            taskID: "settle",
            expectedRevision: 5,
            childSessionID: secondChildID,
          }),
        ),
      ).toBe("child")
      expect(
        yield* reason(
          service.settleChild({
            mainSessionID: mainID,
            taskID: "settle",
            expectedRevision: 5,
            childSessionID: childID,
          }),
        ),
      ).toBe("settlement")
      yield* db
        .insert(SessionActivityTable)
        .values({
          id: "act_settle_one",
          session_id: childID,
          status: "running",
          kind: "prompt",
          lease_until: Date.now() + 60_000,
          opened_seq: 1,
        })
        .run()
        .pipe(Effect.orDie)
      expect(
        yield* reason(
          service.settleChild({
            mainSessionID: mainID,
            taskID: "settle",
            expectedRevision: 5,
            childSessionID: childID,
          }),
        ),
      ).toBe("settlement")
      yield* db
        .update(SessionActivityTable)
        .set({ status: "completed", lease_until: Date.now() - 1, closed_seq: 2 })
        .where(eq(SessionActivityTable.id, "act_settle_one"))
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionInputTable)
        .values({
          id: SessionMessage.ID.make("msg_child_pending"),
          session_id: childID,
          prompt: { text: "still queued" },
          delivery: "queue",
          admitted_seq: 1,
        })
        .run()
        .pipe(Effect.orDie)
      expect(
        yield* reason(
          service.settleChild({
            mainSessionID: mainID,
            taskID: "settle",
            expectedRevision: 5,
            childSessionID: childID,
          }),
        ),
      ).toBe("settlement")
      const pendingInputID = SessionMessage.ID.make("msg_child_pending")
      const activeQuestionID = QuestionV2.ID.ascending("que_child_active")
      yield* db
        .update(SessionInputTable)
        .set({ promoted_seq: 2 })
        .where(eq(SessionInputTable.id, pendingInputID))
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(QuestionTable)
        .values({
          id: activeQuestionID,
          session_id: childID,
          seq: 1,
          state: "active",
          mode: "blocking",
          request: {
            id: activeQuestionID,
            sessionID: childID,
            revision: 1,
            actions: [],
            mode: "blocking",
            questions: [],
          },
        })
        .run()
        .pipe(Effect.orDie)
      expect(
        yield* reason(
          service.settleChild({
            mainSessionID: mainID,
            taskID: "settle",
            expectedRevision: 5,
            childSessionID: childID,
          }),
        ),
      ).toBe("settlement")
      yield* db
        .update(QuestionTable)
        .set({ state: "replied" })
        .where(eq(QuestionTable.id, activeQuestionID))
        .run()
        .pipe(Effect.orDie)
      const settled = yield* service.settleChild({
        mainSessionID: mainID,
        taskID: "settle",
        expectedRevision: 5,
        childSessionID: childID,
      })
      expect(settled).toMatchObject({ slot_claimed: false, child_session_id: childID, revision: 6, state: "starting" })
      expect(
        yield* db
          .select()
          .from(SessionOrchestratorReservationTable)
          .where(eq(SessionOrchestratorReservationTable.task_id, "settle"))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([])
      expect(
        yield* service.settleChild({
          mainSessionID: mainID,
          taskID: "settle",
          expectedRevision: 6,
          childSessionID: childID,
        }),
      ).toMatchObject({ revision: 6 })
      expect(
        yield* reason(
          service.transition({ mainSessionID: mainID, taskID: "settle", expectedRevision: 6, state: "waiting" }),
        ),
      ).toBe("transition")
      yield* service.plan(proposal("after", ["path:/orchestrator/settle.ts"]))
      expect(yield* service.reserve({ mainSessionID: mainID, taskID: "after", expectedRevision: 1 })).toMatchObject({
        state: "reserved",
      })
    }),
  )

  it.effect("never settles from task state alone while the bound child is still live", () =>
    Effect.gen(function* () {
      const service = yield* setup
      const { db } = yield* Database.Service
      yield* service.plan(proposal("terminal"))
      yield* service.reserve({ mainSessionID: mainID, taskID: "terminal", expectedRevision: 1 })
      yield* service.transition({
        mainSessionID: mainID,
        taskID: "terminal",
        expectedRevision: 2,
        state: "snapshotting",
      })
      yield* service.transition({ mainSessionID: mainID, taskID: "terminal", expectedRevision: 3, state: "starting" })
      yield* service.assignChild({
        mainSessionID: mainID,
        taskID: "terminal",
        expectedRevision: 4,
        childSessionID: secondChildID,
      })
      yield* service.transition({
        mainSessionID: mainID,
        taskID: "terminal",
        expectedRevision: 5,
        state: "checking_cache",
      })
      yield* service.recordCache({
        mainSessionID: mainID,
        taskID: "terminal",
        expectedRevision: 6,
        profile: "profile",
        usage: { inputTokens: 1000, cacheReadInputTokens: 800 },
      })
      yield* service.transition({ mainSessionID: mainID, taskID: "terminal", expectedRevision: 7, state: "reviewing" })
      yield* service.transition({
        mainSessionID: mainID,
        taskID: "terminal",
        expectedRevision: 8,
        state: "integrating",
      })
      yield* service.transition({ mainSessionID: mainID, taskID: "terminal", expectedRevision: 9, state: "done" })
      yield* db
        .insert(SessionActivityTable)
        .values({
          id: "act_terminal_live",
          session_id: secondChildID,
          status: "running",
          kind: "prompt",
          lease_until: Date.now() + 60_000,
          opened_seq: 1,
        })
        .run()
        .pipe(Effect.orDie)
      expect(
        yield* reason(
          service.settleChild({
            mainSessionID: mainID,
            taskID: "terminal",
            expectedRevision: 10,
            childSessionID: secondChildID,
          }),
        ),
      ).toBe("settlement")
      expect((yield* service.tasks(mainID)).find((row) => row.id === "terminal")?.slot_claimed).toBe(true)
    }),
  )
})

describe("orchestrator cache and resource policy", () => {
  test("normalizes resource aliases and rejects unbounded or relative keys", () => {
    for (const resource of [
      "path:../x",
      "path:relative",
      "path:/x/../y",
      "path:/x/./y",
      " path:/x",
      "path:/x\0",
      "unknown:resource",
    ])
      expect(OrchestratorPolicy.resourceKey(resource)).toBeUndefined()
    expect(OrchestratorPolicy.resourceKey("interface:api")).toBe("interface:api")
    expect(OrchestratorPolicy.resourceKey("path:/a//b/")).toBe("path:/a/b")
    for (const resource of ["path:/", "path:c:/", "path://server/share/file.ts"]) {
      expect(OrchestratorPolicy.resourceKey(resource)).toBe(resource)
      expect(OrchestratorPolicy.resourceKey(OrchestratorPolicy.resourceKey(resource) ?? "invalid")).toBe(resource)
    }
    expect(OrchestratorPolicy.resourceKey("path:\\\\server\\share\\file.ts")).toBe("path://server/share/file.ts")
    if (process.platform === "win32")
      expect(OrchestratorPolicy.resourceKey("path:C:\\Repo\\A.ts")).toBe("path:c:/repo/a.ts")
  })

  test("keeps missing and invalid provider usage unknown", () => {
    for (const usage of [
      {},
      { inputTokens: 0, cacheReadInputTokens: 0 },
      { inputTokens: NaN, cacheReadInputTokens: 1 },
      { inputTokens: Infinity, cacheReadInputTokens: 1 },
      { inputTokens: 100, cacheReadInputTokens: -1 },
      { inputTokens: 100, cacheReadInputTokens: 101 },
      { inputTokens: 10.5, cacheReadInputTokens: 9 },
      { inputTokens: 100, cacheReadInputTokens: NaN },
    ])
      expect(OrchestratorPolicy.cacheEvidence(usage)).toEqual({ status: "unknown" })
    expect(OrchestratorPolicy.cacheEvidence({ inputTokens: 100, cacheReadInputTokens: 80 })).toEqual({
      status: "accepted",
      ratio: 0.8,
    })
    expect(OrchestratorPolicy.cacheEvidence({ inputTokens: 100, cacheReadInputTokens: 79 })).toEqual({
      status: "low",
      ratio: 0.79,
    })
    expect(() => OrchestratorPolicy.cacheEvidence({}, NaN)).toThrow(RangeError)
  })
  test("treats path boundaries and symbolic resources separately", () => {
    expect(OrchestratorPolicy.overlaps("path:/src", "path:/src/file.ts")).toBe(true)
    expect(OrchestratorPolicy.overlaps("path:/", "path:/src/file.ts")).toBe(true)
    expect(OrchestratorPolicy.overlaps("path:c:/repo/file.ts", "path:c:/")).toBe(true)
    expect(OrchestratorPolicy.overlaps("path://server/share/file.ts", "path:/")).toBe(false)
    expect(OrchestratorPolicy.overlaps("path://server/share/file.ts", "path:/server/share/file.ts")).toBe(false)
    expect(OrchestratorPolicy.overlaps("path:/src", "path:/src-other/file.ts")).toBe(false)
    expect(OrchestratorPolicy.overlaps("interface:api", "interface:api")).toBe(true)
    expect(OrchestratorPolicy.overlaps("project:*", "interface:api")).toBe(true)
  })
})
