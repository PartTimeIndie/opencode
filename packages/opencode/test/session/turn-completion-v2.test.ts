import { describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { ModelV2 } from "@opencode-ai/core/model"
import { Location } from "@opencode-ai/core/location"
import { Project } from "@opencode-ai/core/project"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionActivityTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionTurnContinuation } from "@opencode-ai/core/session/turn-continuation"
import type { SessionV2 } from "@opencode-ai/core/session"
import { eq, sql } from "drizzle-orm"
import { Clock, Context, DateTime, Effect, Exit, Fiber, Layer, Schema, Scope } from "effect"
import { TestClock } from "effect/testing"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceStore } from "@/project/instance-store"
import { InstanceRef } from "@/effect/instance-ref"
import { SessionID } from "@/session/schema"
import { TurnCompletion } from "@/session/turn-completion"
import { TurnCompletionV2 } from "@/session/turn-completion-v2"
import { testEffect } from "../lib/effect"

const evaluated: SessionID[] = []
const evaluatedMessages = new Map<SessionID, TurnCompletion.CompletionMessage[] | undefined>()
const published: Array<{ id: EventV2.ID; sessionID: SessionID; status: TurnCompletion.Status }> = []
const publishedLocations = new Map<SessionID, Location.Ref | undefined>()
const publishedInstanceDirectories = new Map<SessionID, string | undefined>()
const failingSessions = new Set<string>()
const POLL_YIELD_LIMIT = 1_000
let resolution: "success" | "failure" | "timeout" = "success"
let completionStatus: TurnCompletion.Status = "done"
let listener: EventV2.Listener = () => Effect.void

const events = Layer.mock(EventV2Bridge.Service, {
  listen: (next) =>
    Effect.sync(() => {
      listener = next
      return Effect.sync(() => {
        if (listener === next) listener = () => Effect.void
      })
    }),
  publish: (definition, data, options) =>
    Effect.gen(function* () {
      if (options?.commit) yield* options.commit(1)
      const event = {
        id: options?.id ?? EventV2.ID.create(),
        type: definition.type,
        data,
      } as EventV2.Payload<typeof definition>
      if (definition.type === "session.turn.completed") {
        const completion = data as { sessionID: SessionID; status: TurnCompletion.Status }
        published.push({ id: event.id, sessionID: completion.sessionID, status: completion.status })
        publishedLocations.set(completion.sessionID, options?.location)
        publishedInstanceDirectories.set(completion.sessionID, (yield* InstanceRef)?.directory)
      }
      return event
    }),
})
const completion = Layer.mock(TurnCompletion.Service, {
  resolve: (sessionID, input) => {
    evaluated.push(sessionID)
    evaluatedMessages.set(sessionID, input?.messages)
    if (resolution === "failure" || failingSessions.has(sessionID)) return Effect.die(new Error("evaluation failed"))
    if (resolution === "timeout") return Effect.never
    return Effect.succeed(input?.status ?? completionStatus)
  },
  evaluate: () => Effect.void,
  record: () => Effect.void,
})
const instances = Layer.mock(InstanceStore.Service, {
  provide: (_input, effect) => effect,
})
const database = Database.layerFromPath(":memory:")
const service = TurnCompletionV2.layer.pipe(
  Layer.provide(events),
  Layer.provide(completion),
  Layer.provide(instances),
  Layer.provideMerge(database),
)
const it = testEffect(service)
const itWithManualService = testEffect(Layer.mergeAll(database, events, instances))

function terminal(sessionID: SessionID, activityID: string): EventV2.Payload {
  return {
    id: EventV2.ID.create(),
    type: SessionEvent.Activity.Completed.type,
    location: { directory: AbsolutePath.make("C:/repo") },
    data: { sessionID, activityID, timestamp: Date.now() },
  }
}

function failed(sessionID: SessionID, activityID: string): EventV2.Payload {
  return {
    id: EventV2.ID.create(),
    type: SessionEvent.Activity.Failed.type,
    location: { directory: AbsolutePath.make("C:/repo") },
    data: { sessionID, activityID, timestamp: Date.now(), error: { type: "unknown", message: "failed" } },
  }
}

function interrupted(sessionID: SessionID, activityID: string): EventV2.Payload {
  return {
    id: EventV2.ID.create(),
    type: SessionEvent.Activity.Interrupted.type,
    location: { directory: AbsolutePath.make("C:/repo") },
    data: { sessionID, activityID, timestamp: Date.now(), reason: "user-stop" },
  }
}

const seed = Effect.fn("TurnCompletionV2Test.seed")(function* (sessionID: SessionID, activityID: string) {
  const { db } = yield* Database.Service
  yield* db.run(sql`
    INSERT OR IGNORE INTO project (id, worktree, sandboxes, time_created, time_updated)
    VALUES ('project_completion', 'C:/repo', '[]', 1, 1)
  `)
  yield* db.run(sql`
    INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
    VALUES (${sessionID}, 'project_completion', 'completion', 'C:/repo', 'Completion', 'dev', 1, 1)
  `)
  yield* db
    .insert(SessionActivityTable)
    .values({
      id: activityID,
      session_id: sessionID,
      status: "completed",
      kind: "prompt",
      closed_seq: 1,
    })
    .run()
    .pipe(Effect.orDie)
})

const marker = (activityID: string) =>
  Database.Service.use(({ db }) =>
    db
      .select({
        state: SessionActivityTable.turn_completion_state,
        result: SessionActivityTable.turn_completion_result,
        attempts: SessionActivityTable.turn_completion_attempts,
        error: SessionActivityTable.turn_completion_error,
        owner: SessionActivityTable.turn_completion_owner_id,
        lease: SessionActivityTable.turn_completion_lease_until,
      })
      .from(SessionActivityTable)
      .where(eq(SessionActivityTable.id, activityID))
      .get()
      .pipe(Effect.orDie),
  )

const poisonAttempts = () =>
  Database.Service.use(({ db }) =>
    db
      .get<{ total: number }>(
        sql`SELECT COALESCE(SUM(turn_completion_attempts), 0) AS total FROM session_activity WHERE id LIKE 'activity_poison_%'`,
      )
      .pipe(Effect.orDie),
  )

const waitForPoisonAttempts = (total: number) =>
  Effect.gen(function* () {
    for (const _ of Array.from({ length: POLL_YIELD_LIMIT })) {
      if ((yield* poisonAttempts())?.total === total) return
      yield* Effect.yieldNow
    }
    const actual = (yield* poisonAttempts())?.total
    return yield* Effect.die(
      new Error(
        `Expected ${total} poison attempts, received ${actual ?? "no row"} after ${POLL_YIELD_LIMIT} scheduler yields`,
      ),
    )
  })

const waitForState = (activityID: string, state: string) =>
  Effect.gen(function* () {
    for (const _ of Array.from({ length: POLL_YIELD_LIMIT })) {
      if ((yield* marker(activityID))?.state === state) return
      yield* Effect.yieldNow
    }
    const actual = (yield* marker(activityID))?.state
    return yield* Effect.die(
      new Error(
        `Expected ${activityID} to reach ${state}, received ${actual ?? "no row"} after ${POLL_YIELD_LIMIT} scheduler yields`,
      ),
    )
  })

function reset() {
  evaluated.length = 0
  published.length = 0
  publishedLocations.clear()
  publishedInstanceDirectories.clear()
  failingSessions.clear()
  resolution = "success"
  completionStatus = "done"
}

describe("TurnCompletionV2", () => {
  for (const status of ["success", "failed", "unbound"] as const) {
    itWithManualService.effect(`settles a scheduled turn with a ${status} result receipt`, () =>
      Effect.gen(function* () {
        reset()
        completionStatus = "incomplete"
        const sessionID = SessionID.make(`ses_scheduled_${status}`)
        const activityID = `activity_scheduled_${status}`
        const contract = "opencode.scheduled-job-result/v1"
        yield* seed(sessionID, activityID)
        const { db } = yield* Database.Service
        yield* db
          .update(SessionActivityTable)
          .set({ closed_seq: 3 })
          .where(eq(SessionActivityTable.id, activityID))
          .run()
          .pipe(Effect.orDie)
        const model = { id: "test-model", providerID: "test" }
        const result = status === "failed" ? { contract, status, error: "Job check failed" } : { contract, status: "success" }
        const messages = [
          {
            id: "msg_scheduled_prompt",
            type: "user",
            text: status === "unbound" ? "Normal task" : contract,
            time: { created: 1 },
          },
          {
            id: "msg_scheduled_receipt",
            type: "assistant",
            agent: "build",
            model,
            finish: "tool-calls",
            time: { created: 2, completed: 2 },
            content: [
              {
                type: "tool",
                id: "call_scheduled_job_result",
                name: "scheduled_job_result",
                time: { created: 2 },
                state: {
                  status: "completed",
                  input: {},
                  content: [],
                  outputPaths: [],
                  structured: { metadata: { result } },
                },
              },
            ],
          },
          {
            id: "msg_scheduled_final",
            type: "assistant",
            agent: "build",
            model,
            finish: "stop",
            time: { created: 3, completed: 3 },
            content: [{ type: "text", id: "text", text: "Run ended." }],
          },
        ] as const
        yield* db
          .insert(SessionMessageTable)
          .values(messages.map(({ id, type, ...data }, index) => ({
            id: SessionMessage.ID.make(id),
            session_id: sessionID,
            type,
            seq: index + 1,
            time_created: index + 1,
            time_updated: index + 1,
            data,
          })))
          .run()
          .pipe(Effect.orDie)
        const queued: SessionV2.ID[] = []
        const execution = Layer.mock(SessionExecution.Service, {
          queueContinuation: (target) => Effect.sync(() => void queued.push(target)),
        })
        yield* Layer.build(TurnCompletionV2.layer.pipe(
          Layer.provide(events),
          Layer.provide(completion),
          Layer.provide(instances),
          Layer.provide(execution),
          Layer.provide(Layer.succeed(Database.Service, { db })),
        ))
        yield* listener(terminal(sessionID, activityID))

        expect(yield* marker(activityID)).toMatchObject({
          state: "done",
          result: status === "unbound" ? "incomplete" : "done",
        })
        expect(evaluated.includes(sessionID)).toBe(status === "unbound")
        expect(queued).toEqual(status === "unbound" ? [sessionID] : [])
      }),
    )
  }

  for (const scenario of ["failed", "interrupted", "saved-done", "saved-incomplete"] as const) {
    itWithManualService.effect(`settles historical ${scenario} with only the required legacy project startup`, () =>
      Effect.gen(function* () {
        reset()
        const sessionID = SessionID.make(`ses_v2_historical_${scenario}`)
        const activityID = `activity_historical_${scenario}`
        yield* seed(sessionID, activityID)
        const { db } = yield* Database.Service
        const directory = AbsolutePath.make(`C:/historical/${scenario}`)
        const workspaceID = WorkspaceV2.ID.make("wrk_historical_startup")
        yield* db
          .update(SessionTable)
          .set({ directory, workspace_id: workspaceID })
          .where(eq(SessionTable.id, sessionID))
          .run()
          .pipe(Effect.orDie)
        yield* db
          .update(SessionActivityTable)
          .set({
            status: scenario === "failed" || scenario === "interrupted" ? scenario : "completed",
            turn_completion_state: "ready",
            turn_completion_result:
              scenario === "saved-done" ? "done" : scenario === "saved-incomplete" ? "incomplete" : null,
          })
          .where(eq(SessionActivityTable.id, activityID))
          .run()
          .pipe(Effect.orDie)
        const legacyStarts: string[] = []
        const continuations: SessionV2.ID[] = []
        const service = TurnCompletionV2.layer.pipe(
          Layer.provide(events),
          Layer.provide(completion),
          Layer.provide(
            Layer.mock(InstanceStore.Service, {
              provide: (input, effect) =>
                Effect.sync(() => legacyStarts.push(input.directory)).pipe(Effect.andThen(effect)),
            }),
          ),
          Layer.provide(
            Layer.mock(SessionExecution.Service, {
              queueContinuation: (target) =>
                Effect.sync(() => {
                  continuations.push(target)
                }),
            }),
          ),
          Layer.provide(Layer.succeed(Database.Service, { db })),
        )
        const scope = yield* Scope.make()
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
        yield* Layer.buildWithScope(Layer.fresh(service), scope).pipe(
          Effect.provideService(InstanceRef, {
            directory: "C:/foreign",
            worktree: "C:/foreign",
            project: {
              id: Project.ID.make("prj_historical_foreign"),
              worktree: "C:/foreign",
              sandboxes: [],
              time: { created: 1, updated: 1 },
            },
          }),
        )
        // The initial scan settles the durable row before any fresh event arrives.
        yield* waitForState(activityID, "done")
        const event =
          scenario === "failed"
            ? failed(sessionID, activityID)
            : scenario === "interrupted"
              ? interrupted(sessionID, activityID)
              : terminal(sessionID, activityID)
        yield* listener(event)
        yield* TestClock.adjust("5 seconds")
        yield* Effect.yieldNow

        expect(evaluated).toEqual([])
        expect(continuations).toEqual(scenario === "saved-incomplete" ? [sessionID] : [])
        expect(yield* marker(activityID)).toMatchObject({
          state: "done",
          result: scenario === "saved-done" ? "done" : "incomplete",
          attempts: 1,
          owner: null,
          lease: null,
          error: null,
        })
        expect(published).toEqual(
          scenario === "saved-incomplete"
            ? []
            : [
                {
                  id: EventV2.ID.fromExternal({ namespace: "session-turn-completion", key: activityID }),
                  sessionID,
                  status: scenario === "saved-done" ? "done" : "incomplete",
                },
              ],
        )
        const ended = yield* db
          .select({ at: SessionActivityTable.turn_completion_completed_at })
          .from(SessionActivityTable)
          .where(eq(SessionActivityTable.id, activityID))
          .get()
          .pipe(Effect.orDie)
        expect(ended?.at).toEqual(expect.any(Number))
        expect(legacyStarts.map((value) => value.replaceAll("\\", "/"))).toEqual(
          scenario === "saved-incomplete" ? [directory] : [],
        )
        if (scenario !== "saved-incomplete") {
          const location = publishedLocations.get(sessionID)
          expect(location?.directory.replaceAll("\\", "/")).toBe(directory)
          expect(location?.workspaceID).toBe(workspaceID)
          expect(publishedInstanceDirectories.get(sessionID)).toBeUndefined()
        }
      }),
    )
  }

  for (const turns of [2, 205]) {
    it.effect(`keeps the original admitted task with ${turns} assistant messages and ignores later turns`, () =>
      Effect.gen(function* () {
        reset()
        const sessionID = SessionID.make(`ses_v2_task_anchor_${turns}`)
        const activityID = `activity_task_anchor_${turns}`
        yield* seed(sessionID, activityID)
        const { db } = yield* Database.Service
        const task = 'Return exactly {"findings":[],"notes":["night-output-probe-ok"]}.'
        yield* db
          .update(SessionActivityTable)
          .set({ closed_seq: turns + 1 })
          .where(eq(SessionActivityTable.id, activityID))
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(SessionMessageTable)
          .values(
            [
              new SessionMessage.User({
                id: SessionMessage.ID.make(`msg_task_${turns}`),
                type: "user",
                text: task,
                time: { created: DateTime.makeUnsafe(1) },
              }),
              ...Array.from(
                { length: turns },
                (_, i) =>
                  new SessionMessage.Assistant({
                    id: SessionMessage.ID.make(`msg_answer_${turns}_${i}`),
                    type: "assistant",
                    agent: "build",
                    model: Schema.decodeUnknownSync(ModelV2.Ref)({ id: "test-model", providerID: "test" }),
                    finish: "stop",
                    time: {
                      created: DateTime.makeUnsafe(i + 2),
                      completed: DateTime.makeUnsafe(i + 2),
                    },
                    content: [
                      new SessionMessage.AssistantText({
                        id: `text_${i}`,
                        type: "text",
                        text: i === turns - 1 ? '{"findings":[],"notes":["night-output-probe-ok"]}' : "intermediate",
                      }),
                    ],
                  }),
              ),
              new SessionMessage.User({
                id: SessionMessage.ID.make(`msg_later_task_${turns}`),
                type: "user",
                text: "Unrelated later admitted task",
                time: { created: DateTime.makeUnsafe(turns + 2) },
              }),
              new SessionMessage.Assistant({
                id: SessionMessage.ID.make(`msg_later_answer_${turns}`),
                type: "assistant",
                agent: "build",
                model: Schema.decodeUnknownSync(ModelV2.Ref)({ id: "test-model", providerID: "test" }),
                finish: "stop",
                time: {
                  created: DateTime.makeUnsafe(turns + 3),
                  completed: DateTime.makeUnsafe(turns + 3),
                },
                content: [
                  new SessionMessage.AssistantText({
                    id: "text_future",
                    type: "text",
                    text: "Unrelated later answer",
                  }),
                ],
              }),
            ].map((message, i) => {
              const { id, type, ...data } = Schema.encodeSync(SessionMessage.Message)(message)
              return {
                id: SessionMessage.ID.make(id),
                session_id: sessionID,
                type,
                seq: i + 1,
                time_created: i + 1,
                time_updated: i + 1,
                data,
              }
            }),
          )
          .run()
          .pipe(Effect.orDie)
        yield* TurnCompletionV2.Service
        yield* listener(terminal(sessionID, activityID))
        const messages = evaluatedMessages.get(sessionID)!
        expect(messages.length).toBeLessThanOrEqual(201)
        expect(messages[0]).toEqual({ info: { role: "user" }, parts: [{ type: "text", text: task }] })
        expect(messages.at(-1)?.parts[0]?.text).toBe('{"findings":[],"notes":["night-output-probe-ok"]}')
        expect(JSON.stringify(messages)).not.toContain("Unrelated later")
        expect(yield* marker(activityID)).toMatchObject({ state: "done", result: "done", attempts: 1 })
      }),
    )
  }

  it.effect("forwards the live execution service from the production session runtime", () =>
    Effect.gen(function* () {
      const { sessionRuntimeLayer } = yield* Effect.promise(() => import("@opencode-ai/server/handlers"))
      const runtime = yield* Layer.build(sessionRuntimeLayer)

      expect(Context.get(runtime, SessionExecution.Service)).toBeDefined()
    }),
  )

  for (const [kind, terminalEvent] of [
    ["failed", failed],
    ["user-interrupted", interrupted],
  ] as const) {
    itWithManualService.effect(`does not auto-resume a ${kind} activity`, () =>
      Effect.gen(function* () {
        reset()
        const sessionID = SessionID.make(`ses_v2_${kind}`)
        const activityID = `activity_${kind}`
        yield* seed(sessionID, activityID)
        const { db } = yield* Database.Service
        yield* db
          .update(SessionActivityTable)
          .set({ status: kind === "failed" ? "failed" : "interrupted" })
          .where(eq(SessionActivityTable.id, activityID))
          .run()
          .pipe(Effect.orDie)
        const continuations: SessionV2.ID[] = []
        const service = TurnCompletionV2.layer.pipe(
          Layer.provide(events),
          Layer.provide(instances),
          Layer.provide(
            Layer.mock(TurnCompletion.Service, {
              resolve: () => Effect.succeed("incomplete" as const),
            }),
          ),
          Layer.provide(
            Layer.mock(SessionExecution.Service, {
              queueContinuation: (target) =>
                Effect.sync(() => {
                  continuations.push(target)
                }),
            }),
          ),
          Layer.provide(Layer.succeed(Database.Service, { db })),
        )
        const scope = yield* Scope.make()
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
        yield* Layer.buildWithScope(Layer.fresh(service), scope)
        yield* listener(terminalEvent(sessionID, activityID))

        expect(continuations).toEqual([])
        expect(published).toContainEqual(expect.objectContaining({ sessionID, status: "incomplete" }))
        expect(yield* marker(activityID)).toMatchObject({ state: "done", result: "incomplete", attempts: 1 })
      }),
    )
  }

  it.effect("defers desktop background maintenance without changing normal startup", () =>
    Effect.sync(() => {
      expect(TurnCompletionV2.backgroundStartupDelayMs({})).toBe(0)
      expect(TurnCompletionV2.backgroundStartupDelayMs({ OPENCODE_DEFER_BACKGROUND_STARTUP: "1" })).toBe(
        TurnCompletionV2.DESKTOP_BACKGROUND_STARTUP_DELAY_MS,
      )
    }),
  )

  itWithManualService.effect("observes live terminal events while historical desktop scanning is deferred", () =>
    Effect.gen(function* () {
      reset()
      const previous = process.env.OPENCODE_DEFER_BACKGROUND_STARTUP
      process.env.OPENCODE_DEFER_BACKGROUND_STARTUP = "1"
      yield* Effect.addFinalizer(() => Effect.sync(() => {
        if (previous === undefined) delete process.env.OPENCODE_DEFER_BACKGROUND_STARTUP
        else process.env.OPENCODE_DEFER_BACKGROUND_STARTUP = previous
      }))
      const historicalSessionID = SessionID.make("ses_deferred_historical")
      const historicalActivityID = "activity_deferred_historical"
      const liveSessionID = SessionID.make("ses_deferred_live")
      const liveActivityID = "activity_deferred_live"
      yield* seed(historicalSessionID, historicalActivityID)
      yield* seed(liveSessionID, liveActivityID)
      const databaseService = yield* Database.Service
      const deferred = TurnCompletionV2.layer.pipe(
        Layer.provide(events),
        Layer.provide(completion),
        Layer.provide(instances),
        Layer.provide(Layer.succeed(Database.Service, databaseService)),
      )
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      yield* Layer.buildWithScope(Layer.fresh(deferred), scope)
      expect((yield* marker(historicalActivityID))?.attempts).toBe(0)
      yield* listener(terminal(liveSessionID, liveActivityID))
      expect(yield* marker(liveActivityID)).toMatchObject({ state: "done", result: "done", attempts: 1 })
      expect(published).toContainEqual({
        id: EventV2.ID.fromExternal({ namespace: "session-turn-completion", key: liveActivityID }),
        sessionID: liveSessionID,
        status: "done",
      })
      expect((yield* marker(historicalActivityID))?.attempts).toBe(0)
      yield* TestClock.adjust(TurnCompletionV2.DESKTOP_BACKGROUND_STARTUP_DELAY_MS)
      yield* waitForState(historicalActivityID, "done")
      expect((yield* marker(liveActivityID))?.attempts).toBe(1)
    }),
  )

  it.effect("durably terminalizes one activity exactly once across duplicate events and service restart", () =>
    Effect.gen(function* () {
      reset()
      const sessionID = SessionID.make("ses_v2_completed")
      const activityID = "activity_completed"
      yield* seed(sessionID, activityID)
      yield* TurnCompletionV2.Service

      const completed = terminal(sessionID, activityID)
      yield* listener(completed)
      yield* listener({ ...completed, id: EventV2.ID.create() })

      expect(evaluated).toEqual([sessionID])
      expect(published).toHaveLength(1)
      expect(yield* marker(activityID)).toMatchObject({ state: "done", result: "done", attempts: 1, error: null })

      const databaseService = yield* Database.Service
      const restarted = TurnCompletionV2.layer.pipe(
        Layer.provide(events),
        Layer.provide(completion),
        Layer.provide(instances),
        Layer.provide(Layer.succeed(Database.Service, databaseService)),
      )
      const scope = yield* Scope.make()
      yield* Layer.buildWithScope(Layer.fresh(restarted), scope)
      yield* listener({ ...completed, id: EventV2.ID.create() })
      yield* Scope.close(scope, Exit.void)

      expect(evaluated).toEqual([sessionID])
      expect(published).toHaveLength(1)
      expect(yield* marker(activityID)).toMatchObject({ state: "done", result: "done", attempts: 1 })
    }),
  )

  it.effect("does not persist unknown when V2 already has a substantial completed report", () =>
    Effect.gen(function* () {
      reset()
      completionStatus = "unknown"
      const sessionID = SessionID.make("ses_v2_completed_report")
      const activityID = "activity_completed_report"
      yield* seed(sessionID, activityID)
      const { db } = yield* Database.Service
      const message = new SessionMessage.Assistant({
        id: SessionMessage.ID.make("msg_completed_report"),
        type: "assistant",
        agent: "build",
        model: Schema.decodeUnknownSync(ModelV2.Ref)({ id: "gpt-5.6-luna", providerID: "openai" }),
        time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(1) },
        finish: "stop",
        content: [
          new SessionMessage.AssistantText({
            type: "text",
            id: "text_report",
            text: "Verified implementation and audit evidence. ".repeat(8),
          }),
        ],
      })
      const encoded = Schema.encodeSync(SessionMessage.Message)(message)
      const { id, type, ...data } = encoded
      yield* db
        .insert(SessionMessageTable)
        .values({
          id: SessionMessage.ID.make(id),
          session_id: sessionID,
          type,
          seq: 1,
          time_created: 1,
          time_updated: 1,
          data,
        })
        .run()
        .pipe(Effect.orDie)

      yield* TurnCompletionV2.Service
      yield* listener(terminal(sessionID, activityID))

      expect(yield* marker(activityID)).toMatchObject({ state: "done", result: "done", attempts: 1 })
      expect(published).toEqual([expect.objectContaining({ sessionID, status: "done" })])
      expect(evaluatedMessages.get(sessionID)).toEqual([
        {
          info: { role: "assistant", finish: "stop", error: undefined },
          parts: [
            expect.objectContaining({ type: "text", text: "Verified implementation and audit evidence. ".repeat(8) }),
          ],
        },
      ])
    }),
  )

  it.effect("does not turn a continue-only announcement into done when the evaluator is unavailable", () =>
    Effect.gen(function* () {
      reset()
      completionStatus = "unknown"
      const sessionID = SessionID.make("ses_continue_announcement_fallback")
      const activityID = "activity_continue_announcement_fallback"
      yield* seed(sessionID, activityID)
      const { db } = yield* Database.Service
      const encoded = Schema.encodeSync(SessionMessage.Message)(
        new SessionMessage.Assistant({
          id: SessionMessage.ID.make("msg_continue_announcement_fallback"),
          type: "assistant",
          agent: "build",
          model: Schema.decodeUnknownSync(ModelV2.Ref)({ id: "test-model", providerID: "test" }),
          time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(1) },
          finish: "stop",
          content: [
            new SessionMessage.AssistantText({
              type: "text",
              id: "text",
              text: "Erst verifizieren, dann reparieren — ich prüfe den Choice-Prefab-Stand, bevor ich ihn anfasse.",
            }),
          ],
        }),
      )
      const { id, type, ...data } = encoded
      yield* db
        .insert(SessionMessageTable)
        .values({
          id: SessionMessage.ID.make(id),
          session_id: sessionID,
          type,
          seq: 1,
          time_created: 1,
          time_updated: 1,
          data,
        })
        .run()
        .pipe(Effect.orDie)
      yield* TurnCompletionV2.Service
      yield* listener(terminal(sessionID, activityID))
      expect(yield* marker(activityID)).toMatchObject({ state: "done", result: "incomplete", attempts: 1 })
      expect(published).toEqual([expect.objectContaining({ sessionID, status: "incomplete" })])
    }),
  )

  it.effect("uses durable text evidence when a completed activity evaluator returns unknown", () =>
    Effect.gen(function* () {
      reset()
      completionStatus = "unknown"
      const sessionID = SessionID.make("ses_v2_short_completed_text")
      const activityID = "activity_short_completed_text"
      yield* seed(sessionID, activityID)
      const { db } = yield* Database.Service
      const message = new SessionMessage.Assistant({
        id: SessionMessage.ID.make("msg_short_completed_text"),
        type: "assistant",
        agent: "build",
        model: Schema.decodeUnknownSync(ModelV2.Ref)({ id: "gpt-5.6-luna", providerID: "openai" }),
        time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(1) },
        finish: "stop",
        content: [new SessionMessage.AssistantText({ type: "text", id: "text_short", text: "Done." })],
      })
      const encoded = Schema.encodeSync(SessionMessage.Message)(message)
      const { id, type, ...data } = encoded
      yield* db
        .insert(SessionMessageTable)
        .values({
          id: SessionMessage.ID.make(id),
          session_id: sessionID,
          type,
          seq: 1,
          time_created: 1,
          time_updated: 1,
          data,
        })
        .run()
        .pipe(Effect.orDie)

      yield* TurnCompletionV2.Service
      yield* listener(terminal(sessionID, activityID))

      expect(yield* marker(activityID)).toMatchObject({ state: "done", result: "done", attempts: 1 })
      expect(published).toEqual([expect.objectContaining({ sessionID, status: "done" })])
    }),
  )

  it.effect("uses durable settled-tool evidence when a completed activity evaluator returns unknown", () =>
    Effect.gen(function* () {
      reset()
      completionStatus = "unknown"
      const sessionID = SessionID.make("ses_v2_settled_tool")
      const activityID = "activity_settled_tool"
      yield* seed(sessionID, activityID)
      const { db } = yield* Database.Service
      const message = new SessionMessage.Assistant({
        id: SessionMessage.ID.make("msg_settled_tool"),
        type: "assistant",
        agent: "build",
        model: Schema.decodeUnknownSync(ModelV2.Ref)({ id: "gpt-5.6-luna", providerID: "openai" }),
        time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(1) },
        finish: "tool-calls",
        content: [
          new SessionMessage.AssistantTool({
            type: "tool",
            id: "call_settled_tool",
            name: "web_search",
            provider: { executed: true },
            state: new SessionMessage.ToolStateCompleted({
              status: "completed",
              input: { query: "status" },
              content: [{ type: "text", text: "ok" }],
              outputPaths: [],
              structured: { ok: true },
            }),
            time: {
              created: DateTime.makeUnsafe(1),
              ran: DateTime.makeUnsafe(1),
              completed: DateTime.makeUnsafe(1),
            },
          }),
        ],
      })
      const encoded = Schema.encodeSync(SessionMessage.Message)(message)
      const { id, type, ...data } = encoded
      yield* db
        .insert(SessionMessageTable)
        .values({
          id: SessionMessage.ID.make(id),
          session_id: sessionID,
          type,
          seq: 1,
          time_created: 1,
          time_updated: 1,
          data,
        })
        .run()
        .pipe(Effect.orDie)

      yield* TurnCompletionV2.Service
      yield* listener(terminal(sessionID, activityID))

      expect(yield* marker(activityID)).toMatchObject({ state: "done", result: "done", attempts: 1 })
      expect(published).toEqual([expect.objectContaining({ sessionID, status: "done" })])
      expect(evaluatedMessages.get(sessionID)?.[0]?.parts).toEqual([
        {
          type: "tool",
          tool: "web_search",
          state: { status: "completed", metadata: { ok: true } },
        },
      ])
    }),
  )

  it.effect("uses durable empty-provider evidence as incomplete instead of successful", () =>
    Effect.gen(function* () {
      reset()
      completionStatus = "unknown"
      const sessionID = SessionID.make("ses_v2_empty_provider")
      const activityID = "activity_empty_provider"
      yield* seed(sessionID, activityID)
      const { db } = yield* Database.Service
      const message = new SessionMessage.Assistant({
        id: SessionMessage.ID.make("msg_empty_provider"),
        type: "assistant",
        agent: "build",
        model: Schema.decodeUnknownSync(ModelV2.Ref)({ id: "gpt-5.6-luna", providerID: "openai" }),
        time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(1) },
        finish: "stop",
        content: [new SessionMessage.AssistantText({ type: "text", id: "text_empty", text: "" })],
        tokens: { input: 5, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      const encoded = Schema.encodeSync(SessionMessage.Message)(message)
      const { id, type, ...data } = encoded
      yield* db
        .insert(SessionMessageTable)
        .values({
          id: SessionMessage.ID.make(id),
          session_id: sessionID,
          type,
          seq: 1,
          time_created: 1,
          time_updated: 1,
          data,
        })
        .run()
        .pipe(Effect.orDie)

      yield* TurnCompletionV2.Service
      yield* listener(terminal(sessionID, activityID))

      expect(yield* marker(activityID)).toMatchObject({ state: "done", result: "incomplete", attempts: 1 })
      expect(published).toEqual([expect.objectContaining({ sessionID, status: "incomplete" })])
    }),
  )

  it.effect("startup scan skips historical markers and publishes retryable saved results", () =>
    Effect.gen(function* () {
      reset()
      const historicalSessionID = SessionID.make("ses_v2_historical")
      const historicalActivityID = "activity_historical"
      const pendingSessionID = SessionID.make("ses_v2_saved_pending")
      const pendingActivityID = "activity_saved_pending"
      yield* seed(historicalSessionID, historicalActivityID)
      yield* seed(pendingSessionID, pendingActivityID)
      const { db } = yield* Database.Service
      yield* db
        .update(SessionActivityTable)
        .set({ turn_completion_state: "done", turn_completion_result: "skipped" })
        .where(eq(SessionActivityTable.id, historicalActivityID))
        .run()
        .pipe(Effect.orDie)
      yield* db
        .update(SessionActivityTable)
        .set({ turn_completion_state: "ready", turn_completion_result: "done" })
        .where(eq(SessionActivityTable.id, pendingActivityID))
        .run()
        .pipe(Effect.orDie)

      const databaseService = yield* Database.Service
      const restarted = TurnCompletionV2.layer.pipe(
        Layer.provide(events),
        Layer.provide(completion),
        Layer.provide(instances),
        Layer.provide(Layer.succeed(Database.Service, databaseService)),
      )
      const scope = yield* Scope.make()
      yield* Layer.buildWithScope(Layer.fresh(restarted), scope)
      yield* Effect.yieldNow
      yield* Effect.yieldNow

      expect(evaluated).toEqual([])
      expect(published).toEqual([expect.objectContaining({ sessionID: pendingSessionID, status: "done" })])
      expect(yield* marker(historicalActivityID)).toMatchObject({ state: "done", result: "skipped", attempts: 0 })
      expect(yield* marker(pendingActivityID)).toMatchObject({ state: "done", result: "done", attempts: 1 })
      yield* Scope.close(scope, Exit.void)
    }),
  )

  it.effect("releases a failed claim and retries without losing terminalization", () =>
    Effect.gen(function* () {
      reset()
      yield* TurnCompletionV2.Service
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      const sessionID = SessionID.make("ses_v2_retry_failure")
      const activityID = "activity_retry_failure"
      yield* seed(sessionID, activityID)
      resolution = "failure"
      const now = yield* Clock.currentTimeMillis

      yield* listener(terminal(sessionID, activityID))
      expect(yield* marker(activityID)).toMatchObject({ state: null, result: null, attempts: 1, lease: now + 5_000 })

      resolution = "success"
      yield* listener(terminal(sessionID, activityID))
      expect(evaluated).toEqual([sessionID])
      expect(yield* marker(activityID)).toMatchObject({ state: null, attempts: 1, lease: now + 5_000 })

      const databaseService = yield* Database.Service
      const restarted = TurnCompletionV2.layer.pipe(
        Layer.provide(events),
        Layer.provide(completion),
        Layer.provide(instances),
        Layer.provide(Layer.succeed(Database.Service, databaseService)),
      )
      const scope = yield* Scope.make()
      yield* Layer.buildWithScope(Layer.fresh(restarted), scope)
      yield* Effect.yieldNow
      expect(yield* marker(activityID)).toMatchObject({ state: null, attempts: 1, lease: now + 5_000 })
      yield* TestClock.adjust(4_999)
      expect(yield* marker(activityID)).toMatchObject({ state: null, attempts: 1 })
      yield* TestClock.adjust(1)
      yield* Effect.yieldNow

      expect(evaluated).toEqual([sessionID, sessionID])
      expect(published).toHaveLength(1)
      expect(yield* marker(activityID)).toMatchObject({ state: "done", result: "done", attempts: 2, error: null })
      yield* Scope.close(scope, Exit.void)
    }),
  )

  it.effect("backs off a timed out claim until its persisted due time", () =>
    Effect.gen(function* () {
      reset()
      yield* TurnCompletionV2.Service
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      const sessionID = SessionID.make("ses_v2_retry_timeout")
      const activityID = "activity_retry_timeout"
      yield* seed(sessionID, activityID)
      resolution = "timeout"

      const fiber = yield* listener(terminal(sessionID, activityID)).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* TestClock.adjust(54_999)
      expect(yield* marker(activityID)).toMatchObject({ state: "running", attempts: 1, lease: 120_000 })
      yield* TestClock.adjust(1)
      yield* Fiber.join(fiber)
      expect(yield* marker(activityID)).toMatchObject({
        state: null,
        result: null,
        attempts: 1,
        error: "terminal evaluation timed out",
        lease: 60_000,
      })

      resolution = "success"
      yield* listener(terminal(sessionID, activityID))
      yield* TestClock.adjust(4_999)
      yield* listener(terminal(sessionID, activityID))
      expect(evaluated).toEqual([sessionID])
      expect(yield* marker(activityID)).toMatchObject({ state: null, attempts: 1, lease: 60_000 })
      yield* TestClock.adjust(1)
      yield* listener(terminal(sessionID, activityID))
      expect(evaluated).toEqual([sessionID, sessionID])
      expect(published).toHaveLength(1)
      expect(yield* marker(activityID)).toMatchObject({ state: "done", result: "done", attempts: 2, error: null })
    }),
  )

  it.effect("processes a never-tried row after a full poison batch without hot-looping", () =>
    Effect.gen(function* () {
      reset()
      yield* TurnCompletionV2.Service
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      const poison = Array.from({ length: 100 }, (_, index) => ({
        sessionID: SessionID.make(`ses_v2_poison_${index.toString().padStart(3, "0")}`),
        activityID: `activity_poison_${index.toString().padStart(3, "0")}`,
      }))
      yield* Effect.forEach(poison, (item) => seed(item.sessionID, item.activityID), { discard: true })
      poison.forEach((item) => failingSessions.add(item.sessionID))
      const sessionID = SessionID.make("ses_v2_work_100")
      const activityID = "activity_work_100"
      yield* seed(sessionID, activityID)

      yield* TestClock.adjust(5_000)
      yield* waitForPoisonAttempts(100)
      expect((yield* poisonAttempts())?.total).toBe(100)
      expect(yield* marker(activityID)).toMatchObject({ state: null, attempts: 0 })
      yield* Effect.yieldNow
      expect((yield* poisonAttempts())?.total).toBe(100)

      yield* TestClock.adjust(5_000)
      yield* waitForState(activityID, "done")
      yield* waitForPoisonAttempts(199)
      expect(yield* marker(activityID)).toMatchObject({ state: "done", result: "done", attempts: 1 })
      expect(yield* marker(poison[0].activityID)).toMatchObject({ state: null, attempts: 2, lease: 20_000 })
      expect(published).toContainEqual(expect.objectContaining({ sessionID, status: "done" }))
    }),
  )

  it.effect("restart scans expired running leases but leaves future leases alone", () =>
    Effect.gen(function* () {
      reset()
      yield* TurnCompletionV2.Service
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      const futureSessionID = SessionID.make("ses_v2_future_lease")
      const futureActivityID = "activity_future_lease"
      const expiredSessionID = SessionID.make("ses_v2_expired_lease")
      const expiredActivityID = "activity_expired_lease"
      yield* seed(futureSessionID, futureActivityID)
      yield* seed(expiredSessionID, expiredActivityID)
      const { db } = yield* Database.Service
      yield* db
        .update(SessionActivityTable)
        .set({
          turn_completion_state: "running",
          turn_completion_owner_id: "old-owner",
          turn_completion_lease_until: 10_000,
          turn_completion_attempts: 1,
        })
        .where(eq(SessionActivityTable.id, futureActivityID))
        .run()
        .pipe(Effect.orDie)
      yield* db
        .update(SessionActivityTable)
        .set({
          turn_completion_state: "running",
          turn_completion_owner_id: "old-owner",
          turn_completion_lease_until: -1,
          turn_completion_attempts: 1,
        })
        .where(eq(SessionActivityTable.id, expiredActivityID))
        .run()
        .pipe(Effect.orDie)

      const databaseService = yield* Database.Service
      const restarted = TurnCompletionV2.layer.pipe(
        Layer.provide(events),
        Layer.provide(completion),
        Layer.provide(instances),
        Layer.provide(Layer.succeed(Database.Service, databaseService)),
      )
      const scope = yield* Scope.make()
      yield* Layer.buildWithScope(Layer.fresh(restarted), scope)
      yield* Effect.yieldNow
      yield* Effect.yieldNow

      expect(yield* marker(expiredActivityID)).toMatchObject({ state: "done", attempts: 2 })
      expect(yield* marker(futureActivityID)).toMatchObject({ state: "running", attempts: 1, lease: 10_000 })
      expect(published).toEqual([expect.objectContaining({ sessionID: expiredSessionID, status: "done" })])

      yield* TestClock.adjust(10_000)
      yield* Effect.yieldNow
      expect(yield* marker(futureActivityID)).toMatchObject({ state: "done", attempts: 2 })
      expect(published).toContainEqual(expect.objectContaining({ sessionID: futureSessionID, status: "done" }))
      yield* Scope.close(scope, Exit.void)
    }),
  )

  itWithManualService.effect(
    "auto-resumes an incomplete completed activity within the configured limit and stops at it",
    () =>
      Effect.gen(function* () {
        reset()
        const sessionID = SessionID.make("ses_v2_auto_resume")
        const activityID = "activity_auto_resume"
        const secondID = "activity_auto_resume_second"
        yield* seed(sessionID, activityID)
        const { db } = yield* Database.Service

        // First evaluation reports unfinished work; the resumed drain finishes it.
        let evaluations = 0
        resolution = "success"
        const completionMock = Layer.mock(TurnCompletion.Service, {
          resolve: (target) => {
            evaluated.push(target)
            return Effect.succeed(evaluations++ === 0 ? ("incomplete" as const) : ("done" as const))
          },
          evaluate: () => Effect.void,
          record: () => Effect.void,
        })
        const resumes: Array<{ sessionID: SessionV2.ID; seq?: number }> = []
        const execution = Layer.mock(SessionExecution.Service, {
          resume: (target) =>
            Effect.sync(() => {
              resumes.push({ sessionID: target })
            }),
          queueContinuation: (target) =>
            Effect.sync(() => {
              resumes.push({ sessionID: target })
            }),
          wake: () => Effect.void,
          interrupt: () => Effect.void,
          interruptActivity: () => Effect.succeed(false),
          wait: () => Effect.void,
          cancelTool: () => Effect.succeed(false),
        })

        const service = TurnCompletionV2.layer.pipe(
          Layer.provide(events),
          Layer.provide(completionMock),
          Layer.provide(instances),
          Layer.provide(execution),
          Layer.provide(Layer.succeed(Database.Service, { db })),
        )
        const scope = yield* Scope.make()
        yield* Layer.buildWithScope(Layer.fresh(service), scope)
        yield* Effect.yieldNow
        yield* Effect.yieldNow

        yield* listener(terminal(sessionID, activityID))
        for (let i = 0; i < POLL_YIELD_LIMIT && (yield* marker(activityID))?.state !== "done"; i++) {
          yield* Effect.yieldNow
        }

        // The incomplete verdict triggered exactly one bounded resume of the Session.
        // While a resume is armed, the TurnCompleted event stays deferred; the UI sees
        // the session continue instead of flashing incomplete first.
        expect(resumes).toEqual([{ sessionID }])

        // A second terminal event on the same activity is idempotent: the marker is done.
        const before = evaluated.length
        yield* listener(terminal(sessionID, activityID))
        yield* Effect.yieldNow
        expect(resumes).toHaveLength(1)
        expect(evaluated.length).toBeGreaterThanOrEqual(before)
        yield* Scope.close(scope, Exit.void)
        void secondID
      }),
  )

  itWithManualService.effect("does not enqueue a second continuation when the slow successor changes todos", () =>
    Effect.gen(function* () {
      reset()
      const sessionID = SessionID.make("ses_v2_slow_successor")
      const activityID = "activity_slow_successor"
      yield* seed(sessionID, activityID)
      yield* setTodo(sessionID, "implement the fix", "pending")
      const { db } = yield* Database.Service
      const continuations: SessionV2.ID[] = []
      const execution = Layer.mock(SessionExecution.Service, {
        queueContinuation: (target) =>
          Effect.sync(() => {
            continuations.push(target)
          }),
      })
      const service = TurnCompletionV2.layer.pipe(
        Layer.provide(events),
        Layer.provide(Layer.mock(TurnCompletion.Service, { resolve: () => Effect.succeed("incomplete" as const) })),
        Layer.provide(instances),
        Layer.provide(execution),
        Layer.provide(Layer.succeed(Database.Service, { db })),
      )
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      yield* Layer.buildWithScope(Layer.fresh(service), scope)
      yield* listener(terminal(sessionID, activityID))
      expect(continuations).toEqual([sessionID])
      // The successor is still executing its first provider/tool turn at the next scan.
      yield* setTodo(sessionID, "implement the fix", "in_progress")
      yield* TestClock.adjust(5_001)
      yield* listener(terminal(sessionID, activityID))
      expect(continuations).toEqual([sessionID])
      expect(published).toHaveLength(0)
      expect(yield* marker(activityID)).toMatchObject({ state: "done", result: "incomplete", attempts: 1 })
      expect(yield* SessionTurnContinuation.pending(db, sessionID)).toMatchObject({ activityID, attempts: 1 })
    }),
  )

  for (const verdict of ["done", undefined] as const) {
    itWithManualService.effect(
      `respects the completion evaluator's ${verdict ?? "disabled"} decision with stale pending todos`,
      () =>
        Effect.gen(function* () {
          reset()
          const sessionID = SessionID.make(`ses_v2_policy_${verdict ?? "disabled"}`)
          const activityID = `activity_policy_${verdict ?? "disabled"}`
          yield* seed(sessionID, activityID)
          yield* setTodo(sessionID, "outdated task left in the list", "pending")
          const { db } = yield* Database.Service
          const continuations: SessionV2.ID[] = []
          const service = TurnCompletionV2.layer.pipe(
            Layer.provide(events),
            Layer.provide(instances),
            Layer.provide(
              Layer.mock(TurnCompletion.Service, {
                resolve: (target) =>
                  Effect.sync(() => {
                    evaluated.push(target)
                    return verdict
                  }),
              }),
            ),
            Layer.provide(
              Layer.mock(SessionExecution.Service, {
                queueContinuation: (target) =>
                  Effect.sync(() => {
                    continuations.push(target)
                  }),
              }),
            ),
            Layer.provide(Layer.succeed(Database.Service, { db })),
          )
          const scope = yield* Scope.make()
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
          yield* Layer.buildWithScope(Layer.fresh(service), scope)
          yield* listener(terminal(sessionID, activityID))
          expect(continuations).toEqual([])
          expect(evaluated).toEqual([sessionID])
          expect(yield* marker(activityID)).toMatchObject({ state: "done", result: verdict ?? "skipped" })
          expect(published.map((event) => event.status)).toEqual(verdict ? [verdict] : [])
        }),
    )
  }

  itWithManualService.effect("queues continuation when the evaluator reports incomplete for a short stopped turn", () =>
    Effect.gen(function* () {
      reset()
      const sessionID = SessionID.make("ses_v2_short_stopped_open_todo")
      const activityID = "activity_short_stopped_open_todo"
      yield* seed(sessionID, activityID)
      yield* setTodo(sessionID, "finish the requested implementation", "pending")
      const { db } = yield* Database.Service
      const message = new SessionMessage.Assistant({
        id: SessionMessage.ID.make("msg_v2_short_stopped_open_todo"),
        type: "assistant",
        agent: "build",
        model: Schema.decodeUnknownSync(ModelV2.Ref)({ id: "gpt-5.6-luna", providerID: "openai" }),
        time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(1) },
        finish: "stop",
        content: [
          new SessionMessage.AssistantText({ type: "text", id: "short_report", text: "Implemented a first part." }),
        ],
      })
      const encoded = Schema.encodeSync(SessionMessage.Message)(message)
      const { id, type, ...data } = encoded
      yield* db
        .insert(SessionMessageTable)
        .values({
          id: SessionMessage.ID.make(id),
          session_id: sessionID,
          type,
          seq: 1,
          time_created: 1,
          time_updated: 1,
          data,
        })
        .run()
        .pipe(Effect.orDie)
      const continuations: SessionV2.ID[] = []
      const service = TurnCompletionV2.layer.pipe(
        Layer.provide(events),
        Layer.provide(instances),
        Layer.provide(
          Layer.mock(TurnCompletion.Service, {
            resolve: (target, input) => {
              expect(target).toBe(sessionID)
              expect(input?.messages?.at(-1)?.parts[0]?.text).toBe("Implemented a first part.")
              return Effect.succeed("incomplete" as const)
            },
          }),
        ),
        Layer.provide(
          Layer.mock(SessionExecution.Service, {
            queueContinuation: (target) =>
              Effect.sync(() => {
                continuations.push(target)
              }),
          }),
        ),
        Layer.provide(Layer.succeed(Database.Service, { db })),
      )
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      yield* Layer.buildWithScope(Layer.fresh(service), scope)
      yield* listener(terminal(sessionID, activityID))
      expect(continuations).toEqual([sessionID])
      expect(published).toEqual([])
      expect(yield* marker(activityID)).toMatchObject({ state: "done", result: "incomplete", attempts: 1 })
    }),
  )

  itWithManualService.effect("retries a failed continuation enqueue without releasing ownership prematurely", () =>
    Effect.gen(function* () {
      reset()
      const sessionID = SessionID.make("ses_v2_enqueue_retry")
      const activityID = "activity_enqueue_retry"
      yield* seed(sessionID, activityID)
      yield* setTodo(sessionID, "finish work", "pending")
      const { db } = yield* Database.Service
      let attempts = 0
      const continuations: SessionV2.ID[] = []
      const service = TurnCompletionV2.layer.pipe(
        Layer.provide(events),
        Layer.provide(instances),
        Layer.provide(Layer.mock(TurnCompletion.Service, { resolve: () => Effect.succeed("incomplete" as const) })),
        Layer.provide(
          Layer.mock(SessionExecution.Service, {
            queueContinuation: (target) =>
              Effect.suspend(() => {
                attempts++
                if (attempts <= 2) return Effect.die(new Error("enqueue unavailable"))
                continuations.push(target)
                return Effect.void
              }),
          }),
        ),
        Layer.provide(Layer.succeed(Database.Service, { db })),
      )
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      yield* Layer.buildWithScope(Layer.fresh(service), scope)
      yield* listener(terminal(sessionID, activityID))
      expect(yield* marker(activityID)).toMatchObject({
        state: "ready",
        attempts: 1,
        error: expect.stringContaining("enqueue unavailable"),
      })
      expect(continuations).toEqual([])
      yield* TestClock.adjust(5_001)
      yield* listener(terminal(sessionID, activityID))
      expect(continuations).toEqual([])
      expect(yield* marker(activityID)).toMatchObject({ state: "ready", attempts: 2 })
      yield* TestClock.adjust(10_001)
      yield* listener(terminal(sessionID, activityID))
      expect(continuations).toEqual([sessionID])
      expect(published).toEqual([])
      expect(yield* marker(activityID)).toMatchObject({ state: "done", attempts: 3, error: null })
      expect(yield* SessionTurnContinuation.pending(db, sessionID)).toMatchObject({ activityID, attempts: 1 })
    }),
  )

  for (const changed of [false, true]) {
    itWithManualService.effect(
      `reconciles a legacy consumed marker with ${changed ? "changed" : "unchanged"} progress before successor question gating`,
      () =>
        Effect.gen(function* () {
          reset()
          const sessionID = SessionID.make(`ses_v2_legacy_consumed_${changed}`)
          const activityID = `activity_legacy_consumed_${changed}`
          yield* seed(sessionID, activityID)
          yield* setTodo(sessionID, "finish work", changed ? "in_progress" : "pending")
          const { db } = yield* Database.Service
          yield* SessionTurnContinuation.arm(
            db,
            sessionID,
            activityID,
            JSON.stringify([{ order: 0, content: "finish work", status: "pending" }]),
          )
          yield* SessionTurnContinuation.consume(db, sessionID, activityID)
          // Old versions could leave the parent retryable after consuming its successor.
          yield* db
            .update(SessionActivityTable)
            .set({
              turn_completion_state: "ready",
              turn_completion_result: "incomplete",
              turn_completion_attempts: 7,
            })
            .where(eq(SessionActivityTable.id, activityID))
            .run()
            .pipe(Effect.orDie)
          yield* db.run(sql`INSERT INTO session_question (id, session_id, seq, state, request, time_created, time_updated)
          VALUES ('successor_question', ${sessionID}, 1, 'active', '{}', 1, 1)`)
          const continuations: SessionV2.ID[] = []
          const service = TurnCompletionV2.layer.pipe(
            Layer.provide(events),
            Layer.provide(instances),
            Layer.provide(completion),
            Layer.provide(
              Layer.mock(SessionExecution.Service, {
                queueContinuation: (target) =>
                  Effect.sync(() => {
                    continuations.push(target)
                  }),
              }),
            ),
            Layer.provide(Layer.succeed(Database.Service, { db })),
          )
          const scope = yield* Scope.make()
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
          yield* Layer.buildWithScope(Layer.fresh(service), scope)
          yield* listener(terminal(sessionID, activityID))
          expect(continuations).toEqual([])
          expect(published).toEqual([])
          expect(evaluated).toEqual([])
          expect(yield* marker(activityID)).toMatchObject({
            state: "done",
            result: "incomplete",
            attempts: 8,
            owner: null,
            lease: null,
          })
        }),
    )

    itWithManualService.effect(
      `recovers consumed enqueue after parent update failure with ${changed ? "changed" : "unchanged"} progress`,
      () =>
        Effect.gen(function* () {
          reset()
          const sessionID = SessionID.make(`ses_v2_consumed_recovery_${changed}`)
          const activityID = `activity_consumed_recovery_${changed}`
          yield* seed(sessionID, activityID)
          yield* setTodo(sessionID, "finish work", "pending")
          const { db } = yield* Database.Service
          const continuations: SessionV2.ID[] = []
          const service = TurnCompletionV2.layer.pipe(
            Layer.provide(events),
            Layer.provide(instances),
            Layer.provide(Layer.mock(TurnCompletion.Service, { resolve: () => Effect.succeed("incomplete" as const) })),
            Layer.provide(
              Layer.mock(SessionExecution.Service, {
                queueContinuation: (target) =>
                  Effect.gen(function* () {
                    continuations.push(target)
                    expect(yield* SessionTurnContinuation.consume(db, target, activityID)).toBe(true)
                    // The successor ran, but the parent's later completion write cannot commit.
                    yield* db
                      .run(
                        sql`CREATE TRIGGER fail_parent_completion BEFORE UPDATE ON session_activity
                      WHEN NEW.turn_completion_state = 'done'
                      BEGIN SELECT RAISE(ABORT, 'parent completion write unavailable'); END`,
                      )
                      .pipe(Effect.orDie)
                  }),
              }),
            ),
            Layer.provide(Layer.succeed(Database.Service, { db })),
          )
          const first = yield* Scope.make()
          yield* Layer.buildWithScope(Layer.fresh(service), first)
          yield* listener(terminal(sessionID, activityID))
          yield* Scope.close(first, Exit.void)
          expect(continuations).toEqual([sessionID])
          yield* db.run(sql`DROP TRIGGER fail_parent_completion`)
          if (changed) yield* setTodo(sessionID, "finish work", "in_progress")
          yield* TestClock.adjust(5_001)
          const restarted = yield* Scope.make()
          yield* Effect.addFinalizer(() => Scope.close(restarted, Exit.void))
          yield* Layer.buildWithScope(Layer.fresh(service), restarted)
          yield* listener(terminal(sessionID, activityID))
          expect(continuations).toEqual([sessionID])
          expect(published).toEqual([])
          expect(yield* marker(activityID)).toMatchObject({
            state: "done",
            result: "incomplete",
            owner: null,
            lease: null,
          })
          expect(yield* SessionTurnContinuation.pending(db, sessionID)).toBeUndefined()
        }),
    )
  }

  itWithManualService.effect("auto-resume respects a pending blocking question instead of resuming immediately", () =>
    Effect.gen(function* () {
      reset()
      const sessionID = SessionID.make("ses_v2_question_gate")
      const activityID = "activity_question_gate"
      yield* seed(sessionID, activityID)
      const { db } = yield* Database.Service
      resolution = "success"
      failingSessions.clear()
      // Force the resolve mock to report incomplete through the shared harness.
      const completionMock = Layer.mock(TurnCompletion.Service, {
        resolve: (target) => {
          evaluated.push(target)
          return Effect.succeed("incomplete" as const)
        },
        evaluate: () => Effect.void,
        record: () => Effect.void,
      })
      const resumes: SessionV2.ID[] = []
      const execution = Layer.mock(SessionExecution.Service, {
        resume: (target) =>
          Effect.sync(() => {
            resumes.push(target)
          }),
        queueContinuation: () => Effect.void,
        wake: () => Effect.void,
        interrupt: () => Effect.void,
        interruptActivity: () => Effect.succeed(false),
        wait: () => Effect.void,
        cancelTool: () => Effect.succeed(false),
      })

      // Simulate an open blocking question row owned by this activity.
      yield* db.run(sql`
        INSERT INTO session_question (id, session_id, seq, state, request, time_created, time_updated)
        VALUES ('question_pending', ${sessionID}, 1, 'active', '{}', 1, 1)
      `)

      const service = TurnCompletionV2.layer.pipe(
        Layer.provide(events),
        Layer.provide(completionMock),
        Layer.provide(instances),
        Layer.provide(execution),
        Layer.provide(Layer.succeed(Database.Service, { db })),
      )
      const scope = yield* Scope.make()
      yield* Layer.buildWithScope(Layer.fresh(service), scope)
      yield* Effect.yieldNow
      yield* Effect.yieldNow

      yield* listener(terminal(sessionID, activityID))
      for (let i = 0; i < POLL_YIELD_LIMIT && (yield* marker(activityID))?.state !== "done"; i++) {
        yield* Effect.yieldNow
      }

      // The pending question blocks the auto-resume; the user stays in control.
      expect(resumes).toEqual([])
      // The question gate must be checked before the atomic claim: the resume budget
      // stays untouched so a later activity can still use both continuations.
      expect((yield* marker(activityID))?.attempts).toBe(0)
    }),
  )

  itWithManualService.effect(
    "auto-resume publishes incomplete after two successor activities exhaust the session lineage",
    () =>
      Effect.gen(function* () {
        reset()
        const sessionID = SessionID.make("ses_v2_budget")
        const activityIDs = ["activity_budget_1", "activity_budget_2", "activity_budget_3"]
        yield* seed(sessionID, activityIDs[0]!)
        yield* setTodo(sessionID, "finish the first step", "pending")
        const { db } = yield* Database.Service
        yield* db
          .update(SessionTable)
          .set({ metadata: { foreign: { keep: true } } })
          .where(eq(SessionTable.id, sessionID))
          .run()
          .pipe(Effect.orDie)
        const completionMock = Layer.mock(TurnCompletion.Service, {
          resolve: (target) => {
            evaluated.push(target)
            return Effect.succeed("incomplete" as const)
          },
          evaluate: () => Effect.void,
          record: () => Effect.void,
        })
        const continuations: SessionV2.ID[] = []
        const execution = Layer.mock(SessionExecution.Service, {
          resume: () => Effect.void,
          queueContinuation: (target) =>
            Effect.sync(() => {
              continuations.push(target)
            }),
          wake: () => Effect.void,
          interrupt: () => Effect.void,
          interruptActivity: () => Effect.succeed(false),
          wait: () => Effect.void,
          cancelTool: () => Effect.succeed(false),
        })

        const service = TurnCompletionV2.layer.pipe(
          Layer.provide(events),
          Layer.provide(completionMock),
          Layer.provide(instances),
          Layer.provide(execution),
          Layer.provide(Layer.succeed(Database.Service, { db })),
        )
        const scope = yield* Scope.make()
        yield* Layer.buildWithScope(Layer.fresh(service), scope)
        yield* Effect.yieldNow
        yield* Effect.yieldNow

        for (const [index, activityID] of activityIDs.entries()) {
          if (index > 0)
            yield* db
              .insert(SessionActivityTable)
              .values({ id: activityID, session_id: sessionID, status: "completed", kind: "resume", closed_seq: 1 })
              .run()
              .pipe(Effect.orDie)
          yield* listener(terminal(sessionID, activityID))
          for (let i = 0; i < POLL_YIELD_LIMIT; i++) {
            if (continuations.length === Math.min(index + 1, 2) || published.length > 0) break
            yield* Effect.yieldNow
          }
          if (index < SessionTurnContinuation.MaxAttempts) {
            expect(yield* SessionTurnContinuation.consume(db, sessionID, activityID)).toBe(true)
            expect(yield* SessionTurnContinuation.pending(db, sessionID)).toBeUndefined()
          }
        }

        expect(continuations).toEqual([sessionID, sessionID])
        expect(published).toContainEqual(expect.objectContaining({ sessionID, status: "incomplete" }))
        expect(yield* SessionTurnContinuation.read(db, sessionID)).toMatchObject({
          activityID: activityIDs[1],
          attempts: SessionTurnContinuation.MaxAttempts,
        })
        expect(
          (yield* db
            .select({ metadata: SessionTable.metadata })
            .from(SessionTable)
            .where(eq(SessionTable.id, sessionID))
            .get()
            .pipe(Effect.orDie))?.metadata?.foreign,
        ).toEqual({ keep: true })
        yield* listener(terminal(sessionID, activityIDs[2]!))
        yield* Effect.yieldNow
        expect(continuations).toHaveLength(SessionTurnContinuation.MaxAttempts)
        yield* Scope.close(scope, Exit.void)
      }),
  )

  itWithManualService.effect("auto-resume continues beyond two activities when actionable todo progress changes", () =>
    Effect.gen(function* () {
      reset()
      const sessionID = SessionID.make("ses_v2_progress")
      const activityIDs = ["activity_progress_1", "activity_progress_2", "activity_progress_3", "activity_progress_4"]
      yield* seed(sessionID, activityIDs[0]!)
      const { db } = yield* Database.Service
      const completionMock = Layer.mock(TurnCompletion.Service, {
        resolve: (target) => {
          evaluated.push(target)
          return Effect.succeed("incomplete" as const)
        },
        evaluate: () => Effect.void,
        record: () => Effect.void,
      })
      const continuations: SessionV2.ID[] = []
      const execution = Layer.mock(SessionExecution.Service, {
        resume: () => Effect.void,
        queueContinuation: (target) =>
          Effect.sync(() => {
            continuations.push(target)
          }),
        wake: () => Effect.void,
        interrupt: () => Effect.void,
        interruptActivity: () => Effect.succeed(false),
        wait: () => Effect.void,
        cancelTool: () => Effect.succeed(false),
      })

      const service = TurnCompletionV2.layer.pipe(
        Layer.provide(events),
        Layer.provide(completionMock),
        Layer.provide(instances),
        Layer.provide(execution),
        Layer.provide(Layer.succeed(Database.Service, { db })),
      )
      const scope = yield* Scope.make()
      yield* Layer.buildWithScope(Layer.fresh(service), scope)
      yield* Effect.yieldNow
      yield* Effect.yieldNow

      for (const [index, activityID] of activityIDs.entries()) {
        if (index > 0)
          yield* db
            .insert(SessionActivityTable)
            .values({ id: activityID, session_id: sessionID, status: "completed", kind: "resume", closed_seq: 1 })
            .run()
            .pipe(Effect.orDie)
        yield* setTodo(sessionID, `finish step ${index + 1}`, "pending")
        yield* listener(terminal(sessionID, activityID))
        for (let i = 0; i < POLL_YIELD_LIMIT; i++) {
          if (continuations.length === index + 1) break
          yield* Effect.yieldNow
        }
        expect(continuations).toHaveLength(index + 1)
        expect(yield* SessionTurnContinuation.consume(db, sessionID, activityID)).toBe(true)
      }

      expect(continuations).toEqual([sessionID, sessionID, sessionID, sessionID])
      expect(published).toHaveLength(0)
      expect(yield* SessionTurnContinuation.read(db, sessionID)).toMatchObject({
        activityID: activityIDs[3],
        attempts: 1,
      })
      yield* Scope.close(scope, Exit.void)
    }),
  )

  it.effect("completed todos allow the completion evaluator to return done", () =>
    Effect.gen(function* () {
      reset()
      const sessionID = SessionID.make("ses_v2_completed_todos")
      const activityID = "activity_completed_todos"
      yield* seed(sessionID, activityID)
      yield* setTodo(sessionID, "already finished", "completed")
      const { db } = yield* Database.Service
      yield* listener(terminal(sessionID, activityID))
      for (let i = 0; i < POLL_YIELD_LIMIT; i++) {
        if (published.length > 0) break
        yield* Effect.yieldNow
      }

      expect(published).toContainEqual(expect.objectContaining({ sessionID, status: "done" }))
      expect(evaluated).toEqual([sessionID])
      expect(yield* SessionTurnContinuation.pending(db, sessionID)).toBeUndefined()
    }),
  )
})

function setTodo(sessionID: SessionID, content: string, status: "pending" | "in_progress" | "completed") {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = Date.now()
    yield* db.run(sql`DELETE FROM todo WHERE session_id = ${sessionID}`).pipe(Effect.orDie)
    yield* db
      .run(
        sql`
        INSERT INTO todo (session_id, content, status, priority, position, time_created, time_updated)
        VALUES (${sessionID}, ${content}, ${status}, 'medium', 0, ${now}, ${now})
      `,
      )
      .pipe(Effect.orDie)
  })
}
