import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { QuestionV2 } from "@opencode-ai/core/question"
import { QuestionTable } from "@opencode-ai/core/question/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionActivity } from "@opencode-ai/core/session/activity"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionExecutionLocal } from "@opencode-ai/core/session/execution/local"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionActivityTable, SessionInputTable, SessionTable } from "@opencode-ai/core/session/sql"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const questions = QuestionV2.layer.pipe(Layer.provide(events), Layer.provide(database))
const activities = SessionActivity.layer.pipe(Layer.provide(events), Layer.provide(database))
const it = testEffect(Layer.mergeAll(database, events, questions, activities))

const sessionID = SessionV2.ID.make("ses_controlled_restart_surface")
const requestID = QuestionV2.ID.make("que_controlled_restart_surface")
const nonToolRequestID = QuestionV2.ID.make("que_controlled_restart_surface_first")
const assistantMessageID = "msg_controlled_restart_surface"
const callID = "call_controlled_restart_surface"
const info: QuestionV2.Info = {
  question: "Continue after restart?",
  header: "Controlled restart",
  options: [{ label: "Continue", description: "Resume the durable turn" }],
}
const request: QuestionV2.BlockingRequest = {
  id: requestID,
  sessionID,
  mode: "blocking",
  revision: 1,
  actions: [],
  questions: [info],
  tool: { messageID: assistantMessageID, callID },
}
const nonToolRequest: QuestionV2.BlockingRequest = {
  id: nonToolRequestID,
  sessionID,
  mode: "blocking",
  revision: 1,
  actions: [],
  questions: [info],
}

describe("controlled restart blocking Surface recovery", () => {
  for (const settlement of ["reply", "dismiss"] as const) {
    for (const identity of ["none", "message-only", "call-only", "durable-shutdown"] as const) {
      it.live(`settles ${settlement} with ${identity} identity without replaying unrelated work`, () =>
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          const activity = yield* SessionActivity.Service
          const question = yield* QuestionV2.Service
          yield* db
            .insert(ProjectTable)
            .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
          yield* db.insert(SessionTable).values({
            id: sessionID,
            project_id: Project.ID.global,
            slug: "non-tool-surface",
            directory: "/project",
            title: "Non-tool Surface",
            version: "test",
          })
          const running = yield* activity.open({ sessionID, kind: "prompt", ownerID: "live_waiter", openedSeq: 0 })
          yield* db.update(SessionActivityTable).set({ lease_until: -1 }).where(eq(SessionActivityTable.id, running.id))
          yield* db.insert(QuestionTable).values({
            id: nonToolRequestID,
            session_id: sessionID,
            seq: 1,
            state: "active",
            request: identity === "durable-shutdown" ? { ...request, id: nonToolRequestID } : nonToolRequest,
            mode: "blocking",
            activity_id: running.id,
            ...(identity === "message-only" ? { assistant_message_id: assistantMessageID } : {}),
            ...(identity === "call-only" ? { tool_call_id: callID } : {}),
            ...(identity === "durable-shutdown"
              ? { assistant_message_id: assistantMessageID, tool_call_id: callID }
              : {}),
            time_created: Date.now(),
            time_updated: Date.now(),
          })
          if (identity === "durable-shutdown") yield* activity.prepareOwnerShutdown("live_waiter", "owner-shutdown")
          const before = yield* activity.get(running.id)
          const continuations: string[] = []
          yield* SessionExecutionLocal.listenForControlledQuestionReplies(activity, db, (id) =>
            Effect.sync(() => {
              continuations.push(id)
            }),
          )
          if (settlement === "reply")
            yield* question.reply({ requestID: nonToolRequestID, sessionID, answers: [["Continue"]] })
          if (settlement === "dismiss") yield* question.reject(nonToolRequestID, sessionID)
          if (identity === "durable-shutdown") {
            expect(yield* activity.get(running.id)).toMatchObject({ status: "interrupted", reason: "owner-shutdown" })
            expect(continuations).toEqual([sessionID])
          }
          if (identity !== "durable-shutdown") {
            expect(yield* activity.get(running.id)).toEqual(before)
            expect(continuations).toEqual([])
          }
          expect(
            yield* db
              .select({ state: QuestionTable.state })
              .from(QuestionTable)
              .where(eq(QuestionTable.id, nonToolRequestID))
              .get(),
          ).toEqual({ state: settlement === "reply" ? "replied" : "rejected" })
        }),
      )
    }
  }

  it.live("preserves a crashed tool waiter, then continues and completes exactly once", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const activity = yield* SessionActivity.Service
      const question = yield* QuestionV2.Service
      const eventService = yield* EventV2.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "controlled-restart-surface",
          directory: "/project",
          title: "Controlled restart Surface",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)

      const interrupted = yield* activity.open({
        sessionID,
        kind: "prompt",
        ownerID: "owner_before_restart",
        openedSeq: 0,
      })
      yield* db
        .insert(QuestionTable)
        .values({
          id: requestID,
          session_id: sessionID,
          seq: 1,
          state: "active",
          request,
          mode: "blocking",
          revision: 1,
          action_metadata: [],
          activity_id: interrupted.id,
          assistant_message_id: assistantMessageID,
          tool_call_id: callID,
          time_created: Date.now(),
          time_updated: Date.now(),
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .update(SessionActivityTable)
        .set({ lease_until: -1, heartbeat_at: -SessionActivity.LEASE_DURATION_MS - 1 })
        .where(eq(SessionActivityTable.id, interrupted.id))
        .run()
        .pipe(Effect.orDie)
      const queueInputID = SessionMessage.ID.make("msg_controlled_restart_surface_queue")
      yield* db
        .insert(SessionInputTable)
        .values({
          id: queueInputID,
          session_id: sessionID,
          prompt: { text: "Continue with the queued follow-up" },
          delivery: "queue",
          admitted_seq: 1,
          time_created: Date.now(),
        })
        .run()
        .pipe(Effect.orDie)

      const lifecycle: string[] = []
      yield* eventService.listen((event) =>
        Effect.sync(() => {
          if (
            event.type !== SessionEvent.Activity.Interrupted.type &&
            event.type !== SessionEvent.Activity.Completed.type
          )
            return
          lifecycle.push(`${event.type}:${(event.data as { activityID: string }).activityID}`)
        }),
      )

      let continuations = 0
      const completed = yield* Deferred.make<string>()
      const resume = (target: SessionV2.ID) =>
        Effect.gen(function* () {
          continuations++
          expect(target).toBe(sessionID)
          expect(
            yield* db
              .select({ promotedSeq: SessionInputTable.promoted_seq })
              .from(SessionInputTable)
              .where(eq(SessionInputTable.id, queueInputID))
              .get()
              .pipe(Effect.orDie),
          ).toEqual({ promotedSeq: null })
          const next = yield* activity.open({
            sessionID: target,
            kind: "resume",
            ownerID: "owner_after_restart",
            openedSeq: 1,
          })
          expect(
            yield* question.askDurable({
              sessionID: target,
              questions: [info],
              tool: { messageID: assistantMessageID, callID },
            }),
          ).toEqual([["Continue"]])
          yield* db
            .update(SessionInputTable)
            .set({ promoted_seq: 2 })
            .where(eq(SessionInputTable.id, queueInputID))
            .run()
            .pipe(Effect.orDie)
          yield* activity.complete(next.id, "owner_after_restart", 2)
          yield* Deferred.succeed(completed, next.id)
        })

      // The new process installs its durable reply listener before running startup recovery.
      yield* SessionExecutionLocal.listenForControlledQuestionReplies(activity, db, resume)
      yield* SessionExecutionLocal.runStartupRecovery(activity, db, () => new Set(), resume)

      expect(continuations).toBe(0)
      const preserved = yield* activity.get(interrupted.id)
      expect(preserved).toMatchObject({ status: "running" })
      expect(preserved?.reason).toBeUndefined()
      expect(yield* db.select().from(QuestionTable).where(eq(QuestionTable.id, requestID)).get().pipe(Effect.orDie)).toMatchObject({
        state: "active",
        time_settled: null,
      })
      expect((yield* question.list()).map((item) => item.id)).toContain(requestID)

      yield* question.reply({ requestID, sessionID, answers: [["Continue"]] })
      const resumedActivityID = yield* Deferred.await(completed).pipe(Effect.timeout("2 seconds"))
      yield* Effect.sleep("25 millis")

      expect(continuations).toBe(1)
      expect(yield* activity.get(interrupted.id)).toMatchObject({
        status: "interrupted",
        reason: "stale-lease",
      })
      expect(yield* db.select().from(QuestionTable).where(eq(QuestionTable.id, requestID)).get().pipe(Effect.orDie)).toMatchObject({
        state: "replied",
        answers: [["Continue"]],
      })
      expect(
        yield* db
          .select({ promotedSeq: SessionInputTable.promoted_seq })
          .from(SessionInputTable)
          .where(eq(SessionInputTable.id, queueInputID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ promotedSeq: 2 })
      expect(lifecycle).toEqual([
        `${SessionEvent.Activity.Interrupted.type}:${interrupted.id}`,
        `${SessionEvent.Activity.Completed.type}:${resumedActivityID}`,
      ])
      expect(
        (yield* activity.listForSession(sessionID)).filter(
          (item) => item.status === "running" || item.status === "recovering",
        ),
      ).toHaveLength(0)
      expect((yield* activity.listForSession(sessionID)).filter((item) => item.status === "completed")).toHaveLength(1)
    }),
  )

  it.live("continues a crashed tool waiter after the user dismisses its durable question", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const activity = yield* SessionActivity.Service
      const question = yield* QuestionV2.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "controlled-restart-surface-dismissed",
          directory: "/project",
          title: "Controlled restart Surface dismissed",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const interrupted = yield* activity.open({
        sessionID,
        kind: "prompt",
        ownerID: "owner_before_restart",
        openedSeq: 0,
      })
      yield* db
        .insert(QuestionTable)
        .values({
          id: requestID,
          session_id: sessionID,
          seq: 1,
          state: "active",
          request,
          mode: "blocking",
          revision: 1,
          action_metadata: [],
          activity_id: interrupted.id,
          assistant_message_id: assistantMessageID,
          tool_call_id: callID,
          time_created: Date.now(),
          time_updated: Date.now(),
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .update(SessionActivityTable)
        .set({ lease_until: -1, heartbeat_at: -SessionActivity.LEASE_DURATION_MS - 1 })
        .where(eq(SessionActivityTable.id, interrupted.id))
        .run()
        .pipe(Effect.orDie)

      let continuations = 0
      const completed = yield* Deferred.make<void>()
      const resume = (target: SessionV2.ID) =>
        Effect.gen(function* () {
          continuations++
          expect(target).toBe(sessionID)
          yield* Deferred.succeed(completed, undefined)
        })

      yield* SessionExecutionLocal.listenForControlledQuestionReplies(activity, db, resume)
      yield* SessionExecutionLocal.runStartupRecovery(activity, db, () => new Set(), resume)
      yield* question.reject(requestID, sessionID)
      yield* Deferred.await(completed).pipe(Effect.timeout("2 seconds"))

      expect(continuations).toBe(1)
      expect(yield* activity.get(interrupted.id)).toMatchObject({ status: "interrupted", reason: "stale-lease" })
      expect(yield* db.select().from(QuestionTable).where(eq(QuestionTable.id, requestID)).get().pipe(Effect.orDie)).toMatchObject({
        state: "rejected",
      })
    }),
  )

  it.live("preserves a completed activity while its durable tool question awaits input", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const activity = yield* SessionActivity.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "controlled-restart-surface",
          directory: "/project",
          title: "Controlled restart Surface",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const waiting = yield* activity.open({
        sessionID,
        kind: "prompt",
        ownerID: "owner_before_complete",
        openedSeq: 0,
      })
      yield* db
        .insert(QuestionTable)
        .values([
          {
            id: nonToolRequestID,
            session_id: sessionID,
            seq: 1,
            state: "queued",
            request: nonToolRequest,
            mode: "blocking",
            revision: 1,
            action_metadata: [],
            activity_id: waiting.id,
            time_created: Date.now(),
            time_updated: Date.now(),
          },
          {
            id: requestID,
            session_id: sessionID,
            seq: 2,
            state: "active",
            request,
            mode: "blocking",
            revision: 1,
            action_metadata: [],
            activity_id: waiting.id,
            assistant_message_id: assistantMessageID,
            tool_call_id: callID,
            time_created: Date.now(),
            time_updated: Date.now(),
          },
        ])
        .run()
        .pipe(Effect.orDie)

      yield* activity.complete(waiting.id, "owner_before_complete", 0)

      expect(yield* activity.get(waiting.id)).toMatchObject({ status: "running", reason: "owner-shutdown" })
      expect(yield* db.select().from(QuestionTable).where(eq(QuestionTable.id, requestID)).get().pipe(Effect.orDie)).toMatchObject({
        state: "active",
        time_settled: null,
      })
    }),
  )
})

test("stale interruption observes a blocking wait admitted by a contending writer", async () => {
  await using tmp = await tmpdir()
  const filename = `${tmp.path}/stale-blocking-wait.sqlite`
  const database = Database.layerFromPath(filename)
  const events = EventV2.layer.pipe(Layer.provide(database))
  const activities = SessionActivity.layer.pipe(Layer.provide(events), Layer.provide(database))

  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const activity = yield* SessionActivity.Service
      yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      yield* db.insert(SessionTable).values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "stale-blocking-wait",
        directory: "/project",
        title: "Stale blocking wait",
        version: "test",
      })
      const running = yield* activity.open({
        sessionID,
        kind: "prompt",
        ownerID: "stale_owner",
        openedSeq: 0,
      })
      yield* db.update(SessionActivityTable).set({ lease_until: 0 }).where(eq(SessionActivityTable.id, running.id))
      yield* db.run("PRAGMA busy_timeout = 0")

      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          `import { Database } from "bun:sqlite";
           const db = new Database(process.env.OPENCODE_ACTIVITY_TEST_DB);
           db.run("PRAGMA busy_timeout = 0");
           db.run("BEGIN IMMEDIATE");
           console.log("ready");
           await Bun.sleep(50);
           db.prepare("INSERT INTO session_question (id, session_id, seq, state, request, mode, revision, action_metadata, detached, allow_concurrent, activity_id, time_created, time_updated) VALUES (?, ?, 1, 'active', '{}', 'blocking', 1, '[]', 0, 0, ?, ?, ?)").run(process.env.OPENCODE_ACTIVITY_QUESTION_ID, process.env.OPENCODE_ACTIVITY_SESSION_ID, process.env.OPENCODE_ACTIVITY_ID, Date.now(), Date.now());
           db.run("COMMIT");
           db.close();`,
        ],
        {
          env: {
            ...process.env,
            OPENCODE_ACTIVITY_TEST_DB: filename,
            OPENCODE_ACTIVITY_QUESTION_ID: "que_stale_contention",
            OPENCODE_ACTIVITY_SESSION_ID: sessionID,
            OPENCODE_ACTIVITY_ID: running.id,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const reader = child.stdout.getReader()
      expect(new TextDecoder().decode((yield* Effect.promise(() => reader.read())).value).trim()).toBe("ready")

      expect(yield* activity.interruptStale(running.id, 1)).toBeUndefined()
      const [exitCode, stderr] = yield* Effect.promise(() =>
        Promise.all([child.exited, new Response(child.stderr).text()]),
      )
      expect(exitCode, stderr).toBe(0)
      expect(yield* activity.get(running.id)).toMatchObject({ status: "running" })
    }).pipe(Effect.provide(Layer.mergeAll(database, events, activities)), Effect.scoped),
  )
})
