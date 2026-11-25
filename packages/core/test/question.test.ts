import { describe, expect, spyOn } from "bun:test"
import { eq } from "drizzle-orm"
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core/errors"
import { Cause, Context, DateTime, Deferred, Effect, Exit, Fiber, Layer, Schema, Scope, Stream } from "effect"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { Control } from "@opencode-ai/core/control"
import { EventV2 } from "@opencode-ai/core/event"
import { QuestionTransaction } from "@opencode-ai/core/question/transaction"
import { QuestionV2 } from "@opencode-ai/core/question"
import { QuestionWakeup } from "@opencode-ai/core/question/wakeup"
import { SessionV2 } from "@opencode-ai/core/session"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionActivityTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionActivity } from "@opencode-ai/core/session/activity"
import { QuestionTable } from "@opencode-ai/core/question/sql"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { Location } from "@opencode-ai/core/location"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const questions = QuestionV2.layer.pipe(Layer.provide(events), Layer.provide(database))
const activities = SessionActivity.layer.pipe(Layer.provide(events), Layer.provide(database))
const sessionID = SessionV2.ID.make("ses_question_test")
const fixture = Layer.effectDiscard(
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = Date.now()
    yield* db
      .insert(ProjectTable)
      .values({
        id: ProjectV2.ID.make("project_question_test"),
        worktree: AbsolutePath.make("/project"),
        sandboxes: [],
        time_created: now,
        time_updated: now,
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: ProjectV2.ID.make("project_question_test"),
        slug: "question-test",
        directory: "/project",
        title: "Question test",
        version: "1",
        time_created: now,
        time_updated: now,
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionActivityTable)
      .values({
        id: "activity_question_test",
        session_id: sessionID,
        status: "running",
        kind: "prompt",
        owner_id: "owner_question_test",
        time_created: now,
        time_updated: now,
      })
      .run()
      .pipe(Effect.orDie)
  }),
).pipe(Layer.provide(database))
const it = testEffect(Layer.mergeAll(database, events, questions, activities, fixture))

const question: QuestionV2.Info = {
  question: "Which option?",
  header: "Option",
  options: [{ label: "One", description: "First option" }],
}

function questionConnection(filename: string) {
  const database = Database.layerFromPath(filename)
  const events = EventV2.layer.pipe(Layer.provide(database))
  // Keep each file-backed test connection independent from the module-level test layer.
  return Layer.mergeAll(
    database,
    events,
    QuestionV2.layer.pipe(Layer.provide(database), Layer.provide(events)),
  ).pipe(Layer.fresh)
}

function seedQuestionSession(
  db: Database.Interface["db"],
  input: { readonly sessionID: SessionV2.ID; readonly projectID: ProjectV2.ID; readonly directory: string },
) {
  const now = Date.now()
  return Effect.gen(function* () {
    yield* db
      .insert(ProjectTable)
      .values({
        id: input.projectID,
        worktree: AbsolutePath.make(input.directory),
        sandboxes: [],
        time_created: now,
        time_updated: now,
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: input.sessionID,
        project_id: input.projectID,
        slug: "question-file-test",
        directory: input.directory,
        title: "Question file test",
        version: "1",
        time_created: now,
        time_updated: now,
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionActivityTable)
      .values({
        id: `activity_${input.sessionID}`,
        session_id: input.sessionID,
        status: "running",
        kind: "prompt",
        owner_id: `owner_${input.sessionID}`,
        time_created: now,
        time_updated: now,
      })
      .run()
      .pipe(Effect.orDie)
  })
}

const waitForAsk = Effect.fn("QuestionV2Test.waitForAsk")(function* (
  service: QuestionV2.Interface,
  input: QuestionV2.AskInput,
) {
  const events = yield* EventV2.Service
  const asked = yield* Deferred.make<QuestionV2.BlockingRequest>()
  const unsubscribe = yield* events.listen((event) =>
    event.type === QuestionV2.Event.Requested.type
      ? Deferred.succeed(asked, event.data as QuestionV2.BlockingRequest).pipe(Effect.asVoid)
      : Effect.void,
  )
  yield* Effect.addFinalizer(() => unsubscribe)
  const fiber = yield* service.ask(input).pipe(Effect.forkScoped)
  return { fiber, request: yield* Deferred.await(asked) }
})

describe("QuestionV2", () => {
  it.effect("keeps lifecycle error messages actionable", () =>
    Effect.sync(() => {
      const requestID = QuestionV2.ID.make("que_error_message")
      expect(
        new QuestionV2.ConflictError({
          requestID,
          reason: "A blocking question requires a live Session activity",
        }).message,
      ).toBe("A blocking question requires a live Session activity")
      expect(new QuestionV2.NotFoundError({ requestID }).message).toBe(`Surface request not found: ${requestID}`)
      expect(
        new QuestionV2.PersistentToolNotFoundError({
          toolID: QuestionV2.PersistentToolID.make("sft_missing"),
        }).message,
      ).toContain("sft_missing")
      expect(new QuestionV2.ActionInvocationNotFoundError({ invocationID: "invoke_missing" }).message).toContain(
        "invoke_missing",
      )
    }),
  )

  it.live("delivers every lifecycle event after an earlier listener defect", () =>
    Effect.gen(function* () {
      const service = yield* QuestionV2.Service
      const events = yield* EventV2.Service
      const fail = yield* events.listen((event) =>
        event.type.startsWith("surface.") ? Effect.die("listener failed") : Effect.void,
      )
      yield* Effect.addFinalizer(() => fail)
      const ui: EventV2.Payload[] = []
      const collect = yield* events.listen((event) =>
          event.type.startsWith("surface.")
          ? Effect.sync(() => {
              ui.push(event)
            })
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => collect)
      const asked = yield* events.subscribe(QuestionV2.Event.Requested).pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped)
      const replied = yield* events
        .subscribe(QuestionV2.Event.Replied)
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      const rejected = yield* events
        .subscribe(QuestionV2.Event.Dismissed)
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      const all = yield* events
        .all()
        .pipe(
          Stream.filter((event) => event.type.startsWith("surface.")),
          Stream.take(4),
          Stream.runCollect,
          Effect.forkScoped,
        )
      yield* Effect.yieldNow

      const first = yield* service.open({ sessionID, questions: [{ ...question, question: "First lifecycle?" }] })
      const second = yield* service.open({ sessionID, questions: [{ ...question, question: "Promoted lifecycle?" }] })
      yield* service.reply({ requestID: first.id, answers: [["One"]] })
      yield* service.reject(second.id)

      const expected = [
        QuestionV2.Event.Requested.type,
        QuestionV2.Event.Replied.type,
        QuestionV2.Event.Requested.type,
        QuestionV2.Event.Dismissed.type,
      ]
      expect(ui.map((event) => event.type)).toEqual(expected)
      expect(Array.from(yield* Fiber.join(asked)).map((event) => event.data.id)).toEqual([first.id, second.id])
      expect(Array.from(yield* Fiber.join(replied)).map((event) => event.data.requestID)).toEqual([first.id])
      expect(Array.from(yield* Fiber.join(rejected)).map((event) => event.data.requestID)).toEqual([second.id])
      expect(Array.from(yield* Fiber.join(all)).map((event) => event.type)).toEqual(expected)
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.live("releases a wakeup entry when interrupted before waiter registration", () =>
    Effect.gen(function* () {
      const requestID = "que_interrupted_before_wait"
      const entered = yield* Deferred.make<void>()
      const fiber = yield* QuestionWakeup.wait(requestID, () =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      ).pipe(Effect.forkScoped)
      yield* Deferred.await(entered)

      expect(QuestionWakeup.hasEntry(requestID)).toBeTrue()
      yield* Fiber.interrupt(fiber)
      expect(QuestionWakeup.hasEntry(requestID)).toBeFalse()
    }),
  )

  it.live("publishes lifecycle events and settles a pending reply", () =>
    Effect.gen(function* () {
      const service = yield* QuestionV2.Service
      const events = yield* EventV2.Service
      const published: EventV2.Payload[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type.startsWith("surface.")) published.push(event)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const { fiber, request } = yield* waitForAsk(service, {
        sessionID,
        questions: [question],
        phase: "implementation_complete_followup",
      })

      expect(request.id).toMatch(/^que_/)
      expect(request.phase).toBe("implementation_complete_followup")
      expect(yield* service.list()).toEqual([request])
      yield* service.reply({ requestID: request.id, answers: [["One"]] })

      expect(yield* Fiber.join(fiber)).toEqual([["One"]])
      expect(yield* service.list()).toEqual([])
      expect(published.map((event) => [event.type, event.data])).toEqual([
        [QuestionV2.Event.Requested.type, request],
        [QuestionV2.Event.Replied.type, { sessionID, requestID: request.id, answers: [["One"]], source: "user" }],
      ])
    }),
  )

  it.live("decodes recursive question/control sections and forms", () =>
    Effect.sync(() => {
      const sections = [
        {
          id: "root",
          title: "Root",
          content: "Top level",
          children: [{ id: "child", title: "Child", content: "Nested", meta: { risk: "low" } }],
        },
      ]
      expect(
        Schema.decodeUnknownSync(QuestionV2.ToolInput)({
          questions: [{ type: "object_tree", question: "Review?", sections }],
        }).questions[0]?.sections?.[0]?.children?.[0]?.meta,
      ).toEqual({ risk: "low" })
      expect(
        Schema.decodeUnknownSync(Control.Definition)({ id: "plan", type: "object_tree", label: "Plan", sections })
          .sections?.[0]?.children?.[0]?.title,
      ).toBe("Child")
      const form = {
        version: 1,
        id: "email-composer.v1",
        title: "Email Composer",
        fields: [
          { id: "to", type: "recipient_list", required: true },
          { id: "body", type: "rich_text", rows: 12, toolbar: ["bold", "italic"] },
        ],
        layout: {
          type: "vstack",
          children: [
            { type: "field", field: "to" },
            { type: "field", field: "body", height: "fill" },
          ],
        },
      }
      expect(
        Schema.decodeUnknownSync(QuestionV2.ToolInput)({
          questions: [{ type: "form", question: "Review email", form }],
        }).questions[0]?.form?.layout?.children?.[1]?.height,
      ).toBe("fill")
      expect(
        Schema.decodeUnknownSync(Control.Definition)({ id: "compose", type: "form", label: "Compose", form }).form
          ?.fields[1]?.toolbar?.[0],
      ).toBe("bold")
      expect(() =>
        Schema.decodeUnknownSync(QuestionV2.ToolInput)({
          questions: [{ question: "Review?", sections: [{ id: "root", title: "Root", content: "Top", children: {} }] }],
        }),
      ).toThrow()
    }),
  )

  it.live("decodes legacy Daily Review handoffs without treating them as immutable snapshots", () =>
    Effect.sync(() => {
      const legacy = Schema.decodeUnknownSync(QuestionV2.Tool)({
        name: "switch_agent",
        purpose: "daily_review_implementation",
        planDocument: { revision: 7, updatedAt: 100 },
        messageID: "msg_legacy_handoff",
        callID: "call_legacy_handoff",
      })
      expect(legacy.planDocument).toEqual({ revision: 7, updatedAt: 100 })
      expect(legacy.planDocument?.sha256).toBeUndefined()
      expect(legacy.planDocument?.markdown).toBeUndefined()
    }),
  )

  it.live("validates form surface definitions before tool execution", () =>
    Effect.sync(() => {
      expect(
        QuestionV2.validateToolInput({
          questions: [
            {
              type: "form",
              question: "Preview?",
              form: {
                version: 1,
                fields: [
                  { id: "preview", type: "video_preview" },
                  { id: "cut_range", type: "duration_range" },
                ],
                actions: [
                  {
                    id: "mark_start",
                    trigger: { event: "markStart", source: "preview" },
                    steps: [{ type: "setValue", target: "values.cut_range.start", value: "${state.preview.currentTime}" }],
                  },
                ],
              },
            },
          ],
        }),
      ).toBeUndefined()
      expect(
        QuestionV2.validateToolInput({
          questions: [
            {
              type: "form",
              question: "Preview?",
              form: { version: 1, fields: [{ id: "preview", type: "video_preview", rangeField: "cut_range" }] },
            },
          ],
        }),
      ).toContain("SURFACE_REMOVED_FIELD")
    }),
  )

  it.live("serializes pending asks for the same session", () =>
    Effect.gen(function* () {
      const service = yield* QuestionV2.Service
      const first = yield* waitForAsk(service, { sessionID, questions: [question] })
      const secondFiber = yield* service
        .ask({
          sessionID,
          questions: [{ ...question, question: "Second question?" }],
        })
        .pipe(Effect.forkScoped)

      yield* Effect.yieldNow
      expect(yield* service.list()).toEqual([first.request])

      yield* service.reply({ requestID: first.request.id, answers: [["One"]] })
      expect(yield* Fiber.join(first.fiber)).toEqual([["One"]])

      let pending = yield* service.list()
      while (pending.length === 0) {
        yield* Effect.yieldNow
        pending = yield* service.list()
      }
      expect(pending).toHaveLength(1)
      expect(pending[0]?.mode).toBe("blocking")
      if (pending[0]?.mode !== "blocking") return yield* Effect.die("Expected blocking surface")
      expect(pending[0].questions[0]?.question).toBe("Second question?")

      yield* service.reply({ requestID: pending[0]!.id, answers: [["Two"]] })
      expect(yield* Fiber.join(secondFiber)).toEqual([["Two"]])
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.live("queues detached questions until the visible request settles", () =>
    Effect.gen(function* () {
      const service = yield* QuestionV2.Service
      const events = yield* EventV2.Service
      const published: EventV2.Payload[] = []
      const unsubscribe = yield* events.listen((event) =>
          event.type.startsWith("surface.")
          ? Effect.sync(() => {
              published.push(event)
            })
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      const first = yield* service.open({ sessionID, questions: [{ ...question, question: "First detached question?" }] })
      const second = yield* service.open({ sessionID, questions: [{ ...question, question: "Second detached question?" }] })

      expect((yield* service.list()).map((item) => item.id)).toEqual([first.id])
      expect(yield* service.reply({ requestID: second.id, answers: [["Two"]] }).pipe(Effect.flip)).toEqual(
        new QuestionV2.ConflictError({ requestID: second.id, reason: "The question is not active yet" }),
      )

      yield* service.reply({ requestID: first.id, answers: [["One"]] })
      expect((yield* service.list()).map((item) => item.id)).toEqual([second.id])
      expect(published.map((event) => event.type)).toEqual([
        QuestionV2.Event.Requested.type,
        QuestionV2.Event.Replied.type,
        QuestionV2.Event.Requested.type,
      ])

      yield* service.reject(second.id)
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.live("keeps a concurrent request and the normal FIFO head active together", () =>
    Effect.gen(function* () {
      const service = yield* QuestionV2.Service
      const concurrent = yield* service.open({
        sessionID,
        questions: [{ ...question, question: "Concurrent request?" }],
        allowConcurrent: true,
      })
      const normal = yield* service.open({
        sessionID,
        questions: [{ ...question, question: "Normal request?" }],
      })

      expect((yield* service.list()).map((request) => request.id)).toEqual([concurrent.id, normal.id])
      const { db } = yield* Database.Service
      const rows = yield* db
        .select({ id: QuestionTable.id, state: QuestionTable.state, allowConcurrent: QuestionTable.allow_concurrent })
        .from(QuestionTable)
        .where(eq(QuestionTable.session_id, sessionID))
        .orderBy(QuestionTable.seq)
        .all()
        .pipe(Effect.orDie)
      expect(rows).toEqual([
        { id: concurrent.id, state: "active", allowConcurrent: true },
        { id: normal.id, state: "active", allowConcurrent: false },
      ])

      yield* service.reject(concurrent.id)
      yield* service.reject(normal.id)
    }),
  )

  it.live("dismisses the visible and queued requests for a session", () =>
    Effect.gen(function* () {
      const service = yield* QuestionV2.Service
      yield* service.open({ sessionID, questions: [{ ...question, question: "Visible detached question?" }] })
      const queued = yield* service
        .ask({ sessionID, questions: [{ ...question, question: "Queued blocking question?" }] })
        .pipe(Effect.forkScoped)

      yield* Effect.yieldNow
      expect(yield* service.list()).toHaveLength(1)
      yield* service.dismissSession(sessionID)
      expect(yield* service.list()).toEqual([])
      expect(Exit.isFailure(yield* Fiber.await(queued))).toBe(true)
    }),
  )

  it.live("publishes rejection, fails the ask, and rejects unknown IDs", () =>
    Effect.gen(function* () {
      const service = yield* QuestionV2.Service
      const events = yield* EventV2.Service
      const published: EventV2.Payload[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === QuestionV2.Event.Dismissed.type) published.push(event)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const { fiber, request } = yield* waitForAsk(service, { sessionID, questions: [question] })

      expect(yield* service.settlementTarget(request.id, sessionID)).toEqual({
        detached: false,
        activityID: "activity_question_test",
      })
      expect(yield* service.reject(request.id)).toBeTrue()
      expect(yield* service.reject(request.id)).toBeFalse()
      expect(yield* service.settlementTarget(request.id, sessionID)).toEqual({
        detached: false,
        activityID: "activity_question_test",
      })
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(exit.cause.toString()).toContain("QuestionV2.RejectedError")
      expect(published.map((event) => event.data)).toEqual([{ sessionID, requestID: request.id }])

      const unknown = QuestionV2.ID.ascending("que_unknown")
      expect(yield* service.reply({ requestID: unknown, answers: [] }).pipe(Effect.flip)).toEqual(
        new QuestionV2.NotFoundError({ requestID: unknown }),
      )
      expect(yield* service.reject(unknown).pipe(Effect.flip)).toEqual(
        new QuestionV2.NotFoundError({ requestID: unknown }),
      )
    }),
  )

  it.live("resolves an unambiguous legacy blocking question without selecting a newer activity", () =>
    Effect.gen(function* () {
      const service = yield* QuestionV2.Service
      const { db } = yield* Database.Service
      const { fiber, request } = yield* waitForAsk(service, { sessionID, questions: [question] })
      const legacyTime = Date.now() + 10_000
      yield* db
        .update(QuestionTable)
        .set({ activity_id: null, time_created: legacyTime })
        .where(eq(QuestionTable.id, request.id))
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionActivityTable)
        .values({
          id: "activity_question_newer",
          session_id: sessionID,
          status: "running",
          kind: "prompt",
          owner_id: "owner_question_newer",
          time_created: legacyTime,
          time_updated: legacyTime,
        })
        .run()
        .pipe(Effect.orDie)

      expect(yield* service.settlementTarget(request.id, sessionID)).toEqual({ detached: false })
      yield* db
        .update(SessionActivityTable)
        .set({ time_created: legacyTime + 1, time_updated: legacyTime + 1 })
        .where(eq(SessionActivityTable.id, "activity_question_newer"))
        .run()
        .pipe(Effect.orDie)
      expect(yield* service.settlementTarget(request.id, sessionID)).toEqual({
        detached: false,
        activityID: "activity_question_test",
      })
      yield* service.reject(request.id)
      expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true)
    }),
  )

  it.live("publishes rejection when a pending ask is interrupted", () =>
    Effect.gen(function* () {
      const service = yield* QuestionV2.Service
      const events = yield* EventV2.Service
      const published: EventV2.Payload[] = []
      const unsubscribe = yield* events.listen((event) =>
        event.type === QuestionV2.Event.Dismissed.type
          ? Effect.sync(() => {
              published.push(event)
            })
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const { fiber, request } = yield* waitForAsk(service, { sessionID, questions: [question] })

      yield* Fiber.interrupt(fiber)

      expect(yield* service.list()).toEqual([])
      expect(published.map((event) => event.data)).toEqual([{ sessionID, requestID: request.id }])
    }),
  )

  it.live("keeps a durable ask active until the session dismisses it", () =>
    Effect.gen(function* () {
      const service = yield* QuestionV2.Service
      const fiber = yield* service.askDurable({ sessionID, questions: [question] }).pipe(Effect.forkScoped)
      let pending = yield* service.list()
      while (pending.length === 0) {
        yield* Effect.yieldNow
        pending = yield* service.list()
      }
      const interrupted = yield* Fiber.interrupt(fiber).pipe(Effect.forkScoped)

      yield* Effect.yieldNow
      expect((yield* service.list()).map((request) => request.id)).toEqual([pending[0]!.id])

      yield* service.dismissSession(sessionID)
      yield* Fiber.join(interrupted)
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.live("waits for a detached blocking answer without a live Session activity", () =>
    Effect.gen(function* () {
      const service = yield* QuestionV2.Service
      const { db } = yield* Database.Service
      yield* db
        .update(SessionActivityTable)
        .set({ status: "completed" })
        .where(eq(SessionActivityTable.id, "activity_question_test"))
        .run()
        .pipe(Effect.orDie)
      const fiber = yield* service.askDetached({ sessionID, questions: [question] }).pipe(Effect.forkScoped)
      let pending = yield* service.list()
      while (pending.length === 0) {
        yield* Effect.yieldNow
        pending = yield* service.list()
      }

      expect(yield* service.settlementTarget(pending[0]!.id, sessionID)).toEqual({ detached: true })
      yield* service.reply({ requestID: pending[0]!.id, answers: [["One"]] })
      expect(yield* Fiber.join(fiber)).toEqual([["One"]])
    }),
  )

  it.live("promotes the next FIFO request when the active waiter is interrupted", () =>
    Effect.gen(function* () {
      const service = yield* QuestionV2.Service
      const first = yield* waitForAsk(service, { sessionID, questions: [question] })
      const second = yield* service.open({
        sessionID,
        questions: [{ ...question, question: "Promote after interrupt?" }],
      })

      yield* Fiber.interrupt(first.fiber)

      expect((yield* service.list()).map((request) => request.id)).toEqual([second.id])
      yield* service.reject(second.id)
    }),
  )

  it.live("settles through the database fallback when another connection replies without a wakeup", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
      )
      const filename = path.join(tmp.path, "question-fallback.sqlite")
      const firstScope = yield* Scope.make()
      const secondScope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(secondScope, Exit.void))
      yield* Effect.addFinalizer(() => Scope.close(firstScope, Exit.void))
      const firstContext = yield* Layer.buildWithScope(questionConnection(filename), firstScope)
      const secondContext = yield* Layer.buildWithScope(Database.layerFromPath(filename).pipe(Layer.fresh), secondScope)
      const firstDatabase = Context.get(firstContext, Database.Service).db
      const secondDatabase = Context.get(secondContext, Database.Service).db
      const service = Context.get(firstContext, QuestionV2.Service)
      const fallbackSessionID = SessionV2.ID.make("ses_question_fallback")
      yield* seedQuestionSession(firstDatabase, {
        sessionID: fallbackSessionID,
        projectID: ProjectV2.ID.make("project_question_fallback"),
        directory: tmp.path,
      })

      const fiber = yield* service.ask({ sessionID: fallbackSessionID, questions: [question] }).pipe(Effect.forkScoped)
      let row = yield* secondDatabase
        .select({ request: QuestionTable.request })
        .from(QuestionTable)
        .where(eq(QuestionTable.session_id, fallbackSessionID))
        .get()
        .pipe(Effect.orDie)
      while (!row || !QuestionWakeup.hasEntry(row.request.id)) {
        yield* Effect.sleep("10 millis")
        row = yield* secondDatabase
          .select({ request: QuestionTable.request })
          .from(QuestionTable)
          .where(eq(QuestionTable.session_id, fallbackSessionID))
          .get()
          .pipe(Effect.orDie)
      }
      if (!row) return yield* Effect.die("Expected a pending question")
      const requestID = row.request.id
      yield* Effect.sleep("100 millis")
      expect((yield* Fiber.join(fiber).pipe(Effect.timeoutOption("100 millis")))._tag).toBe("None")

      const updatedAt = Date.now()
      // Bypass QuestionV2 so this second connection emits no process-local wakeup.
      yield* secondDatabase
        .update(QuestionTable)
        .set({
          state: "replied",
          answers: [["One"]],
          receipt: "qrc_external_connection",
          time_settled: updatedAt,
          time_updated: updatedAt,
        })
        .where(eq(QuestionTable.id, requestID))
        .run()
        .pipe(Effect.orDie)

      expect((yield* Fiber.join(fiber).pipe(Effect.timeoutOption("1 second")))._tag).toBe("None")
      expect(yield* Fiber.join(fiber).pipe(Effect.timeout("2 seconds"))).toEqual([["One"]])
      expect(Date.now() - updatedAt).toBeGreaterThanOrEqual(1_000)
      expect(QuestionWakeup.hasEntry(requestID)).toBeFalse()
    }),
  )

  it.live("shares durable pending requests across rebuilt location layers", () =>
    Effect.gen(function* () {
      const firstScope = yield* Scope.make()
      const secondScope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(secondScope, Exit.void))
      yield* Effect.addFinalizer(() => Scope.close(firstScope, Exit.void))
      const shared = Layer.mergeAll(
        Layer.succeed(Database.Service, yield* Database.Service),
        Layer.succeed(EventV2.Service, yield* EventV2.Service),
      )
      const location = () =>
        Layer.succeed(
          Location.Service,
          Location.Service.of({
            directory: AbsolutePath.make("/project"),
            project: { id: ProjectV2.ID.make("project_question_test"), directory: AbsolutePath.make("/project") },
          }),
        )
      const first = Context.get(
        yield* Layer.buildWithScope(QuestionV2.layer.pipe(Layer.provide(shared), Layer.provide(location())), firstScope),
        QuestionV2.Service,
      )
      const second = Context.get(
        yield* Layer.buildWithScope(QuestionV2.layer.pipe(Layer.provide(shared), Layer.provide(location())), secondScope),
        QuestionV2.Service,
      )
      const { db } = yield* Database.Service
      const select = spyOn(db, "select")
      yield* Effect.addFinalizer(() => Effect.sync(() => select.mockRestore()))
      const fiber = yield* first.ask({ sessionID, questions: [question] }).pipe(Effect.forkScoped)
      let pending = yield* second.list()
      while (pending.length === 0) {
        yield* Effect.sleep("10 millis")
        pending = yield* second.list()
      }
      const request = pending[0]!

      yield* Effect.sleep("100 millis")
      const idleReads = select.mock.calls.length
      yield* Effect.sleep("250 millis")
      expect(select.mock.calls.length - idleReads).toBeLessThanOrEqual(1)

      yield* second.reply({ sessionID, requestID: request.id, answers: [["One"]] })
      expect(yield* Fiber.join(fiber).pipe(Effect.timeout("1 second"))).toEqual([["One"]])
    }),
  )

  it.live("accepts an identical reply retry once and rejects a conflicting receipt", () =>
    Effect.gen(function* () {
      const service = yield* QuestionV2.Service
      const request = yield* service.open({ sessionID, questions: [question] })
      const replied: EventV2.Payload[] = []
      const events = yield* EventV2.Service
      const unsubscribe = yield* events.listen((event) =>
        event.type === QuestionV2.Event.Replied.type
          ? Effect.sync(() => {
              replied.push(event)
            })
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      yield* service.reply({ sessionID, requestID: request.id, answers: [["One"]] })
      yield* service.reply({ sessionID, requestID: request.id, answers: [["One"]] })
      expect(
        yield* service
          .reply({ sessionID, requestID: request.id, answers: [["Different"]] })
          .pipe(Effect.flip),
      ).toEqual(
        new QuestionV2.ConflictError({
          requestID: request.id,
          reason: "The question already has a different durable receipt",
        }),
      )
      expect(
        yield* service
          .reply({ sessionID: SessionV2.ID.make("ses_wrong"), requestID: request.id, answers: [["One"]] })
          .pipe(Effect.flip),
      ).toEqual(new QuestionV2.NotFoundError({ requestID: request.id }))

      const { db } = yield* Database.Service
      const row = yield* db.select().from(QuestionTable).where(eq(QuestionTable.id, request.id)).get().pipe(Effect.orDie)
      expect(row?.state).toBe("replied")
      expect(row?.answers).toEqual([["One"]])
      expect(row?.receipt).toMatch(/^qrc_/)
      expect(replied).toHaveLength(1)
    }),
  )

  ;(process.platform === "win32" ? it.live : it.live.skip)(
    "keeps a blocking question active across Windows directory case and separator variants",
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const variantSessionID = SessionV2.ID.make("ses_question_windows_location")
      const variantProjectID = ProjectV2.ID.make("project_question_windows_location")
      yield* seedQuestionSession(db, {
        sessionID: variantSessionID,
        projectID: variantProjectID,
        directory: "C:\\GitRepros\\QuestionLocation",
      })
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const shared = Layer.mergeAll(
        Layer.succeed(Database.Service, yield* Database.Service),
        Layer.succeed(EventV2.Service, yield* EventV2.Service),
      )
      const location = Layer.succeed(
        Location.Service,
        Location.Service.of({
          directory: AbsolutePath.make("c:/gitrepros/questionlocation"),
          project: {
            id: variantProjectID,
            directory: AbsolutePath.make("c:/gitrepros/questionlocation"),
          },
        }),
      )
      const service = Context.get(
        yield* Layer.buildWithScope(QuestionV2.layer.pipe(Layer.provide(shared), Layer.provide(location)), scope),
        QuestionV2.Service,
      )
      const fiber = yield* service
        .askDurable({ sessionID: variantSessionID, questions: [question] })
        .pipe(Effect.forkScoped)
      let pending = yield* service.list()
      while (pending.length === 0) {
        expect(fiber.pollUnsafe()).toBeUndefined()
        yield* Effect.yieldNow
        pending = yield* service.list()
      }

      expect(pending.map((request) => request.sessionID)).toEqual([variantSessionID])
      expect(fiber.pollUnsafe()).toBeUndefined()
      yield* service.reply({ requestID: pending[0]!.id, answers: [["One"]] })
      expect(yield* Fiber.join(fiber)).toEqual([["One"]])
    }),
  )

  it.live("keeps a 32-question request active until every answer is present", () =>
    Effect.gen(function* () {
      const service = yield* QuestionV2.Service
      const questions = Array.from({ length: 32 }, (_, index) => ({
        ...question,
        header: `Review ${index + 1}`,
        question: `Review question ${index + 1}?`,
      }))
      const request = yield* service.open({ sessionID, questions })
      const incomplete = questions.slice(1).map(() => ["One"])

      expect(yield* service.reply({ requestID: request.id, answers: incomplete }).pipe(Effect.flip)).toEqual(
        new QuestionV2.ConflictError({
          requestID: request.id,
          reason: "Expected 32 answers but received 31",
        }),
      )
      expect((yield* service.list()).map((pending) => pending.id)).toEqual([request.id])

      const answers = questions.map(() => ["One"])
      yield* service.reply({ requestID: request.id, answers })
      const { db } = yield* Database.Service
      const row = yield* db.select().from(QuestionTable).where(eq(QuestionTable.id, request.id)).get().pipe(Effect.orDie)
      expect(row?.answers).toEqual(answers)
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.live("deduplicates exact tool retries and rejects changed payloads", () =>
    Effect.gen(function* () {
      const service = yield* QuestionV2.Service
      const tool = { messageID: "msg_question_retry", callID: "call_question_retry" }
      const first = yield* service.open({ sessionID, questions: [question], tool })
      const retry = yield* service.open({ sessionID, questions: [question], tool })

      expect(retry.id).toBe(first.id)
      expect(
        yield* service
          .open({ sessionID, questions: [{ ...question, question: "Changed?" }], tool })
          .pipe(Effect.flip),
      ).toEqual(
        new QuestionV2.ConflictError({
          requestID: first.id,
          reason: "The tool retry key is already bound to a different question payload",
        }),
      )
      yield* service.reject(first.id)
    }),
  )

  it.live("serializes parallel writers with one active FIFO head", () =>
    Effect.gen(function* () {
      const service = yield* QuestionV2.Service
      yield* Effect.all(
        ["First", "Second", "Third"].map((label) =>
          service.open({ sessionID, questions: [{ ...question, question: `${label}?` }] }),
        ),
        { concurrency: "unbounded" },
      )

      const { db } = yield* Database.Service
      const rows = yield* db
        .select()
        .from(QuestionTable)
        .where(eq(QuestionTable.session_id, sessionID))
        .orderBy(QuestionTable.seq)
        .all()
        .pipe(Effect.orDie)
      expect(rows.map((row) => row.seq)).toEqual([1, 2, 3])
      expect(rows.map((row) => row.state)).toEqual(["active", "queued", "queued"])
      expect(yield* service.list()).toHaveLength(1)

      for (const row of rows) {
        expect((yield* service.list())[0]?.id).toBe(row.id)
        yield* service.reject(row.id)
      }
    }),
  )

  it.live("retries FIFO and tool-key races across two file database connections", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
      )
      const filename = path.join(tmp.path, "question-races.sqlite")
      const firstScope = yield* Scope.make()
      const secondScope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(secondScope, Exit.void))
      yield* Effect.addFinalizer(() => Scope.close(firstScope, Exit.void))
      const firstContext = yield* Layer.buildWithScope(questionConnection(filename), firstScope)
      const secondContext = yield* Layer.buildWithScope(questionConnection(filename), secondScope)
      const firstDatabase = Context.get(firstContext, Database.Service).db
      const secondDatabase = Context.get(secondContext, Database.Service).db
      const first = Context.get(firstContext, QuestionV2.Service)
      const second = Context.get(secondContext, QuestionV2.Service)
      const raceSessionID = SessionV2.ID.make("ses_question_file_race")
      const now = Date.now()
      yield* firstDatabase
        .insert(ProjectTable)
        .values({
          id: ProjectV2.ID.make("project_question_file_race"),
          worktree: AbsolutePath.make(tmp.path),
          sandboxes: [],
          time_created: now,
          time_updated: now,
        })
        .run()
        .pipe(Effect.orDie)
      yield* firstDatabase
        .insert(SessionTable)
        .values({
          id: raceSessionID,
          project_id: ProjectV2.ID.make("project_question_file_race"),
          slug: "question-file-race",
          directory: tmp.path,
          title: "Question file race",
          version: "1",
          time_created: now,
          time_updated: now,
        })
        .run()
        .pipe(Effect.orDie)
      expect(
        yield* secondDatabase
          .select({ id: SessionTable.id })
          .from(SessionTable)
          .where(eq(SessionTable.id, raceSessionID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ id: raceSessionID })

      yield* Effect.all(
        [
          first.open({ sessionID: raceSessionID, questions: [{ ...question, question: "First connection?" }] }),
          second.open({ sessionID: raceSessionID, questions: [{ ...question, question: "Second connection?" }] }),
        ],
        { concurrency: "unbounded" },
      )
      const fifo = yield* firstDatabase
        .select()
        .from(QuestionTable)
        .where(eq(QuestionTable.session_id, raceSessionID))
        .orderBy(QuestionTable.seq)
        .all()
        .pipe(Effect.orDie)
      expect(fifo.map((row) => row.seq)).toEqual([1, 2])
      expect(fifo.map((row) => row.state)).toEqual(["active", "queued"])
      yield* first.reject(fifo[0]!.id)
      yield* first.reject(fifo[1]!.id)

      const tool = { messageID: "msg_question_file_retry", callID: "call_question_file_retry" }
      const retries = yield* Effect.all(
        [
          first.open({ sessionID: raceSessionID, questions: [question], tool }),
          second.open({ sessionID: raceSessionID, questions: [question], tool }),
        ],
        { concurrency: "unbounded" },
      )
      expect(retries[0].id).toBe(retries[1].id)
      expect(
        (yield* firstDatabase
          .select({ id: QuestionTable.id })
          .from(QuestionTable)
          .where(eq(QuestionTable.tool_call_id, tool.callID))
          .all()
          .pipe(Effect.orDie)).map((row) => row.id),
      ).toEqual([retries[0].id])
      yield* second.reject(retries[0].id)
    }),
  )

  it.live("retries a synchronized SQLite lock competition and keeps the write idempotent", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
      )
      const filename = path.join(tmp.path, "question-lock-retry.sqlite")
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* Layer.buildWithScope(Database.layerFromPath(filename).pipe(Layer.fresh), scope)
      const database = Context.get(context, Database.Service).db
      yield* database.run("PRAGMA busy_timeout = 0")
      expect(yield* database.all<{ timeout: number }>("PRAGMA busy_timeout")).toEqual([{ timeout: 0 }])
      yield* database.run("CREATE TABLE question_retry_probe (id text PRIMARY KEY)")
      const attached = yield* database.all<{ file: string; name: string }>("PRAGMA database_list")
      const databaseFilename = attached.find((item) => item.name === "main")?.file
      if (!databaseFilename) return yield* Effect.die("Expected a file-backed SQLite database")
      const sqlite = yield* Effect.promise(() => import("bun:sqlite"))
      const holder = yield* Effect.acquireRelease(
        Effect.sync(() => new sqlite.Database(databaseFilename)),
        (connection) =>
          Effect.sync(() => {
            if (connection.inTransaction) connection.run("ROLLBACK")
            connection.close()
          }),
      )
      holder.run("PRAGMA busy_timeout = 0")
      const firstAttempt = yield* Deferred.make<void>()
      const lockReady = yield* Deferred.make<void>()
      const firstFailure = yield* Deferred.make<unknown>()
      const attempts: number[] = []
      const insert = () =>
        QuestionTransaction.run(database, (tx) =>
          Effect.sync(() => attempts.push(Date.now())).pipe(
            Effect.tap((attempt) =>
              attempt === 1
                ? Deferred.succeed(firstAttempt, undefined).pipe(Effect.andThen(Deferred.await(lockReady)))
                : Effect.void,
            ),
            Effect.andThen(tx.run("INSERT OR IGNORE INTO question_retry_probe (id) VALUES ('stable')")),
            Effect.tapError((error) => Deferred.succeed(firstFailure, error).pipe(Effect.asVoid)),
            Effect.asVoid,
          ),
        )
      const fiber = yield* insert().pipe(Effect.forkScoped)
      yield* Deferred.await(firstAttempt).pipe(Effect.timeout("1 second"))
      expect(attempts).toHaveLength(1)
      // Acquire the competing lock only after the production transaction is ready to write.
      holder.run("BEGIN IMMEDIATE")
      holder.run("INSERT INTO question_retry_probe (id) VALUES ('holder')")
      expect(holder.inTransaction).toBeTrue()
      yield* Deferred.succeed(lockReady, undefined)
      const failure = yield* Deferred.await(firstFailure).pipe(Effect.timeout("1 second"))
      if (!(failure instanceof EffectDrizzleQueryError) || !Cause.isCause(failure.cause))
        return yield* Effect.die("Expected a real SQLite lock error")
      expect(Cause.pretty(failure.cause)).toMatch(/locktimeouterror|database is locked/i)

      holder.run("ROLLBACK")
      yield* Fiber.join(fiber).pipe(Effect.timeout("2 seconds"))
      const attemptsAfterRetry = attempts.length
      expect(attemptsAfterRetry).toBeGreaterThanOrEqual(2)

      yield* insert()
      expect(yield* database.all<{ id: string }>("SELECT id FROM question_retry_probe")).toEqual([{ id: "stable" }])
      expect(attempts).toHaveLength(attemptsAfterRetry + 1)
    }),
  )

  it.live("commits replies and wakes the waiter even when an event listener fails", () =>
    Effect.gen(function* () {
      const service = yield* QuestionV2.Service
      const events = yield* EventV2.Service
      const unsubscribe = yield* events.listen((event) =>
        event.type === QuestionV2.Event.Replied.type ? Effect.die("listener failed") : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const { fiber, request } = yield* waitForAsk(service, { sessionID, questions: [question] })

      yield* service.reply({ requestID: request.id, answers: [["One"]] })

      expect(yield* Fiber.join(fiber)).toEqual([["One"]])
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.live("orphans blocking questions from terminal activities and promotes restart-safe detached work", () =>
    Effect.gen(function* () {
      const service = yield* QuestionV2.Service
      const events = yield* EventV2.Service
      const fail = yield* events.listen((event) =>
        event.type === QuestionV2.Event.Dismissed.type ? Effect.die("question listener failed") : Effect.void,
      )
      yield* Effect.addFinalizer(() => fail)
      const published: EventV2.Payload[] = []
      const collect = yield* events.listen((event) =>
          event.type.startsWith("surface.")
          ? Effect.sync(() => {
              published.push(event)
            })
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => collect)
      const { fiber, request } = yield* waitForAsk(service, { sessionID, questions: [question] })
      const detached = yield* service.open({
        sessionID,
        questions: [{ ...question, question: "Detached survives?" }],
      })
      const { db } = yield* Database.Service
      yield* SessionActivity.Service.use((activity) =>
        activity.interrupt("activity_question_test", "owner_question_test", 0),
      )

      expect((yield* service.list()).map((item) => item.id)).toEqual([detached.id])
      const exit = yield* Fiber.await(fiber).pipe(Effect.timeout("1 second"))
      expect(Exit.isFailure(exit)).toBe(true)
      const orphan = yield* db.select().from(QuestionTable).where(eq(QuestionTable.id, request.id)).get().pipe(Effect.orDie)
      expect(orphan?.state).toBe("orphaned")
      expect(
        yield* service.reply({ requestID: request.id, answers: [["Zombie"]] }).pipe(Effect.flip),
      ).toEqual(
        new QuestionV2.ConflictError({
          requestID: request.id,
          reason: "The provider activity ended before this blocking question was answered",
        }),
      )
      expect(published.map((event) => event.type)).toEqual([
        QuestionV2.Event.Requested.type,
        QuestionV2.Event.Dismissed.type,
        QuestionV2.Event.Requested.type,
      ])
      yield* service.reject(detached.id)
    }),
  )

  it.live("new prompt admission preserves interactive and passive surfaces", () =>
    Effect.gen(function* () {
      const service = yield* QuestionV2.Service
      const events = yield* EventV2.Service
      const stale = yield* service.open({
        sessionID,
        questions: [{ ...question, question: "Old followup?" }],
        phase: "implementation_complete_followup",
      })
      const control = yield* service.present({
        sessionID,
        mode: "interactive",
        surface: {
          version: 1,
          controlID: "keep-control",
          controls: [{ id: "speed", type: "slider", label: "Speed" }],
          actions: [
            {
              id: "save",
              trigger: { event: "change", source: "speed" },
              steps: [{ type: "configWrite", target: { path: "config.json", format: "json" } }],
            },
          ],
        },
      })
      const passive = yield* service.present({
        sessionID,
        mode: "passive",
        surface: {
          version: 1,
          controlID: "keep-passive",
          markdown: "Read-only status",
          controls: [],
        },
      })
      const blocking = yield* service
        .ask({ sessionID, questions: [{ ...question, question: "Keep blocking?" }] })
        .pipe(Effect.forkScoped)
      const { db } = yield* Database.Service
      for (;;) {
        const rows = yield* db
          .select({ id: QuestionTable.id })
          .from(QuestionTable)
          .where(eq(QuestionTable.session_id, sessionID))
          .all()
          .pipe(Effect.orDie)
        if (rows.length === 4) break
        yield* Effect.sleep("10 millis")
      }

      yield* events.publish(SessionEvent.PromptLifecycle.Admitted, {
        sessionID,
        timestamp: DateTime.makeUnsafe(10),
        messageID: SessionMessage.ID.make("msg_question_new_prompt"),
        prompt: new Prompt({ text: "new prompt" }),
        delivery: "steer",
      })

      const pending = yield* service.list()
      expect(pending.filter((item) => item.mode !== "blocking").map((item) => item.id)).toEqual([
        control.id,
        passive.id,
      ])
      expect(pending.filter((item) => item.mode === "blocking")).toHaveLength(1)
      expect((yield* db.select().from(QuestionTable).where(eq(QuestionTable.id, stale.id)).get().pipe(Effect.orDie))?.state).toBe(
        "rejected",
      )
      expect(
        (yield* db.select().from(QuestionTable).where(eq(QuestionTable.id, control.id)).get().pipe(Effect.orDie))?.state,
      ).toBe("active")
      expect(
        (yield* db.select().from(QuestionTable).where(eq(QuestionTable.id, control.id)).get().pipe(Effect.orDie))
          ?.action_metadata,
      ).toEqual([
        {
          id: "save",
          path: "actions[0]",
          permissions: [{ action: "edit", resources: ["config.json"] }],
        },
      ])
      expect(
        (yield* db
          .select()
          .from(QuestionTable)
          .where(eq(QuestionTable.detached, false))
          .get()
          .pipe(Effect.orDie))?.state,
      ).toBe("active")

      yield* service.dismissSession(sessionID)
      expect(Exit.isFailure(yield* Fiber.await(blocking))).toBe(true)
      expect((yield* service.list()).map((item) => item.id)).toEqual([control.id, passive.id])
      yield* service.reject(control.id)
      yield* service.reject(passive.id)
    }),
  )

  it.live("creates independent project tools with versioned state, hide, restore, and remove", () =>
    Effect.gen(function* () {
      const service = yield* QuestionV2.Service
      const request = yield* service.present({
        sessionID,
        mode: "interactive",
        tool: { name: "switch_agent", messageID: "msg_handoff", callID: "call_handoff" },
        surface: {
          version: 1,
          controlID: "persistent-speed",
          controls: [{ id: "speed", type: "slider", label: "Speed" }],
          values: { speed: 2 },
        },
      })
      const tool = yield* service.createPersistentTool({
        requestID: request.id,
        sessionID,
        expectedRevision: request.revision,
        scope: "project",
      })
      const duplicate = yield* service.createPersistentTool({
        requestID: request.id,
        sessionID,
        expectedRevision: request.revision,
        scope: "project",
      })
      expect(duplicate.id).toBe(tool.id)
      expect(tool.state).toEqual({ version: 1, revision: 1, values: { speed: 2 } })

      const updated = yield* service.updatePersistentToolState({
        toolID: tool.id,
        expectedRevision: 1,
        values: { speed: 4 },
      })
      expect(updated.state).toEqual({ version: 1, revision: 2, values: { speed: 4 } })
      expect(
        yield* service
          .updatePersistentToolState({ toolID: tool.id, expectedRevision: 1, values: { speed: 8 } })
          .pipe(Effect.flip, Effect.map((error) => error._tag)),
      ).toBe("QuestionV2.ConflictError")

      yield* service.setPersistentToolHidden(tool.id, true)
      expect((yield* service.listPersistentTools()).some((item) => item.id === tool.id)).toBeFalse()
      expect((yield* service.listPersistentTools(true)).find((item) => item.id === tool.id)?.hidden).toBeTrue()
      yield* service.setPersistentToolHidden(tool.id, false)
      expect((yield* service.listPersistentTools()).some((item) => item.id === tool.id)).toBeTrue()
      yield* service.removePersistentTool(tool.id)
      expect((yield* service.listPersistentTools(true)).some((item) => item.id === tool.id)).toBeFalse()
      yield* service.reject(request.id)
    }),
  )

  it.live("limits app-global tools to passive action-free surfaces", () =>
    Effect.gen(function* () {
      const service = yield* QuestionV2.Service
      const interactive = yield* service.present({
        sessionID,
        mode: "interactive",
        surface: { version: 1, controlID: "unsafe-global", controls: [] },
      })
      expect(
        yield* service
          .createPersistentTool({
            requestID: interactive.id,
            sessionID,
            expectedRevision: interactive.revision,
            scope: "global",
          })
          .pipe(Effect.flip, Effect.map((error) => error._tag)),
      ).toBe("QuestionV2.ConflictError")

      const passive = yield* service.present({
        sessionID,
        mode: "passive",
        surface: { version: 1, controlID: "safe-global", markdown: "Status", controls: [] },
      })
      const tool = yield* service.createPersistentTool({
        requestID: passive.id,
        sessionID,
        expectedRevision: passive.revision,
        scope: "global",
      })
      expect(tool.scope).toBe("global")
      yield* service.removePersistentTool(tool.id)
      yield* service.reject(interactive.id)
      yield* service.reject(passive.id)
    }),
  )

  it.live("binds action invocations to one authorized revision and idempotency payload", () =>
    Effect.gen(function* () {
      const service = yield* QuestionV2.Service
      const request = yield* service.present({
        sessionID,
        mode: "interactive",
        surface: {
          version: 1,
          controlID: "action-receipt",
          controls: [],
          actions: [
            {
              id: "save",
              trigger: { event: "submit" },
              steps: [{ type: "command", command: "echo", arguments: ["saved"] }],
            },
          ],
        },
      })
      const input: QuestionV2.BeginActionInvocationInput = {
        id: "inv_surface_action_receipt",
        target: { kind: "request", id: request.id, revision: request.revision },
        actionID: "save",
        values: { value: 1 },
      }
      const first = yield* service.beginActionInvocation(input)
      const retry = yield* service.beginActionInvocation(input)
      expect(first.claimed).toBeTrue()
      expect(retry).toEqual({ invocation: first.invocation, claimed: false })
      expect(
        yield* service
          .beginActionInvocation({ ...input, values: { value: 2 } })
          .pipe(Effect.flip, Effect.map((error) => error._tag)),
      ).toBe("QuestionV2.ConflictError")

      const completed = yield* service.completeActionInvocation(input.id, { ok: true })
      expect(completed.state).toBe("completed")
      expect(yield* service.actionInvocations(sessionID)).toEqual([{ invocation: completed, request }])
      expect(yield* service.actionInvocations(SessionV2.ID.make("ses_foreign"))).toEqual([])
      expect((yield* service.beginActionInvocation(input)).invocation).toEqual(completed)
      yield* service.reject(request.id)
      expect((yield* service.beginActionInvocation(input)).invocation).toEqual(completed)
    }),
  )

  it.live("authorizes host actions declared by blocking forms", () =>
    Effect.gen(function* () {
      const service = yield* QuestionV2.Service
      const request = yield* service.open({
        sessionID,
        questions: [
          {
            type: "form",
            question: "Open the vault?",
            form: {
              version: 1,
              id: "vault-review",
              fields: [{ id: "open_vault", type: "button", label: "Open vault" }],
              actions: [
                {
                  id: "open-vault",
                  trigger: { event: "click", source: "open_vault" },
                  steps: [{ type: "command", command: "echo", arguments: ["opened"] }],
                },
              ],
            },
          },
        ],
      })

      expect(request.actions).toEqual([
        {
          id: "open-vault",
          path: "questions[0].form.actions[0]",
          permissions: [{ action: "bash", resources: ["echo opened"] }],
        },
      ])
      const claim = yield* service.beginActionInvocation({
        id: "inv_blocking_vault_action",
        target: { kind: "request", id: request.id, revision: request.revision },
        actionID: "open-vault",
        source: "open_vault",
        values: {},
      })
      expect(claim.claimed).toBeTrue()
      yield* service.completeActionInvocation(claim.invocation.id, { ok: true })
      yield* service.reject(request.id)
    }),
  )
})


  it.live("controlled restart keeps blocking questions pending and their activity alive", () =>
    Effect.gen(function* () {
      const service = yield* QuestionV2.Service
      const { db } = yield* Database.Service
      const { fiber, request } = yield* waitForAsk(service, { sessionID, questions: [question] })

      const row = yield* db.select().from(QuestionTable).where(eq(QuestionTable.id, request.id)).get().pipe(Effect.orDie)
      const activityID = row?.activity_id
      expect(activityID).toBeTruthy()
      const info = yield* SessionActivity.Service.use((activity) => activity.get(activityID!))
      expect(info?.ownerID).toBeTruthy()

      // Controlled process/desktop restart: the owner releases its lease on shutdown.
      yield* SessionActivity.Service.use((activity) => activity.prepareOwnerShutdown(info!.ownerID!, "owner-shutdown"))
      // Startup recovery must not terminalize an activity that still waits on a persisted Surface.
      yield* SessionActivity.Service.use((activity) => activity.interruptStale(activityID!, 0))

      const after = yield* db.select().from(QuestionTable).where(eq(QuestionTable.id, request.id)).get().pipe(Effect.orDie)
      expect(after?.state).toBe("active")
      expect(after?.time_settled).toBe(null)
      const activityAfter = yield* SessionActivity.Service.use((activity) => activity.get(activityID!))
      expect(activityAfter !== undefined && ["running", "recovering"].includes(activityAfter.status)).toBe(true)
      expect((yield* service.list()).map((item) => item.id)).toContain(request.id)

      // The user can still answer after the restart and the waiting turn settles normally.
      yield* service.reply({ requestID: request.id, answers: [["One"]] })
      expect(yield* Fiber.join(fiber)).toEqual([["One"]])
    }),
  )
