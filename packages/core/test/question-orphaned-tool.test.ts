import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { DateTime, Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { QuestionV2 } from "@opencode-ai/core/question"
import { QuestionTable } from "@opencode-ai/core/question/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionActivity } from "@opencode-ai/core/session/activity"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionActivityTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
const questions = QuestionV2.layer.pipe(Layer.provide(events), Layer.provide(database))
const activities = SessionActivity.layer.pipe(Layer.provide(events), Layer.provide(database))
const it = testEffect(Layer.mergeAll(database, events, projector, questions, activities))
const model = { id: ModelV2.ID.make("test-model"), providerID: ProviderV2.ID.make("test-provider") }

const question: QuestionV2.Info = {
  question: "Continue?",
  header: "Recovery",
  options: [{ label: "Yes", description: "Continue the recovered workflow" }],
}

describe("orphaned blocking Surface tools", () => {
  it.effect("terminalizes the running tool when its activity is interrupted", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_orphaned_tool_activity")
      const assistantMessageID = SessionMessage.ID.make("msg_orphaned_tool_activity")
      const activityID = "activity_orphaned_tool_activity"
      const callID = "call_orphaned_tool_activity"
      yield* seedSession(sessionID, activityID, "running")
      yield* seedRunningTool(sessionID, assistantMessageID, callID)
      const service = yield* QuestionV2.Service
      const requested = yield* Deferred.make<QuestionV2.BlockingRequest>()
      const unsubscribe = yield* (yield* EventV2.Service).listen((event) =>
        event.type === QuestionV2.Event.Requested.type
          ? Deferred.succeed(requested, event.data as QuestionV2.BlockingRequest).pipe(Effect.asVoid)
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const waiting = yield* service
        .ask({ sessionID, questions: [question], tool: { messageID: assistantMessageID, callID } })
        .pipe(Effect.forkScoped)
      yield* Deferred.await(requested)

      yield* SessionActivity.Service.use((activity) => activity.interrupt(activityID, `owner_${activityID}`, 0))

      yield* Fiber.await(waiting)
      expect((yield* projectedTool(sessionID, assistantMessageID, callID)).state).toMatchObject({
        status: "error",
        error: { type: "unknown", message: "Tool execution interrupted" },
        interruption: { source: "session" },
      })
    }),
  )

  it.effect("repairs an already orphaned running tool once", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_orphaned_tool_legacy")
      const assistantMessageID = SessionMessage.ID.make("msg_orphaned_tool_legacy")
      const activityID = "activity_orphaned_tool_legacy"
      const callID = "call_orphaned_tool_legacy"
      const requestID = QuestionV2.ID.make("que_orphaned_tool_legacy")
      yield* seedSession(sessionID, activityID, "completed")
      yield* seedRunningTool(sessionID, assistantMessageID, callID)
      const now = Date.now()
      const request: QuestionV2.BlockingRequest = {
        id: requestID,
        sessionID,
        mode: "blocking",
        revision: 1,
        actions: [],
        questions: [question],
        tool: { messageID: assistantMessageID, callID },
      }
      const { db } = yield* Database.Service
      yield* db
        .insert(QuestionTable)
        .values({
          id: requestID,
          session_id: sessionID,
          seq: 1,
          state: "orphaned",
          request,
          mode: "blocking",
          revision: 1,
          action_metadata: [],
          detached: false,
          allow_concurrent: false,
          activity_id: activityID,
          assistant_message_id: assistantMessageID,
          tool_call_id: callID,
          time_settled: now,
          time_created: now,
          time_updated: now,
        })
        .run()
        .pipe(Effect.orDie)
      let failures = 0
      const unsubscribe = yield* (yield* EventV2.Service).listen((event) =>
        event.type === SessionEvent.Tool.Failed.type
          ? Effect.sync(() => {
              failures++
            })
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const service = yield* QuestionV2.Service

      yield* service.list()
      expect((yield* projectedTool(sessionID, assistantMessageID, callID)).state).toMatchObject({
        status: "error",
        interruption: { source: "recovery" },
      })
      yield* service.list()
      expect(failures).toBe(1)
    }),
  )
})

function seedSession(sessionID: SessionV2.ID, activityID: string, status: "running" | "completed") {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = Date.now()
    const projectID = ProjectV2.ID.make(`project_${sessionID}`)
    yield* db
      .insert(ProjectTable)
      .values({ id: projectID, worktree: AbsolutePath.make(`/project/${sessionID}`), sandboxes: [] })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: projectID,
        slug: sessionID,
        directory: `/project/${sessionID}`,
        title: sessionID,
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionActivityTable)
      .values({
        id: activityID,
        session_id: sessionID,
        status,
        kind: "prompt",
        owner_id: `owner_${activityID}`,
        ...(status === "completed" ? { closed_seq: 0 } : {}),
        time_created: now,
        time_updated: now,
      })
      .run()
      .pipe(Effect.orDie)
  })
}

function seedRunningTool(sessionID: SessionV2.ID, assistantMessageID: SessionMessage.ID, callID: string) {
  return Effect.gen(function* () {
    const events = yield* EventV2.Service
    yield* events.publish(SessionEvent.Step.Started, {
      sessionID,
      assistantMessageID,
      timestamp: yield* DateTime.now,
      agent: "build",
      model,
    })
    yield* events.publish(SessionEvent.Tool.Input.Started, {
      sessionID,
      assistantMessageID,
      timestamp: yield* DateTime.now,
      callID,
      name: "surface",
    })
    yield* events.publish(SessionEvent.Tool.Input.Ended, {
      sessionID,
      assistantMessageID,
      timestamp: yield* DateTime.now,
      callID,
      text: '{"mode":"blocking"}',
    })
    yield* events.publish(SessionEvent.Tool.Called, {
      sessionID,
      assistantMessageID,
      timestamp: yield* DateTime.now,
      callID,
      tool: "surface",
      input: { mode: "blocking" },
      provider: { executed: false },
    })
  })
}

function projectedTool(sessionID: SessionV2.ID, assistantMessageID: SessionMessage.ID, callID: string) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const row = yield* db
      .select()
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.id, assistantMessageID))
      .get()
      .pipe(Effect.orDie)
    if (!row || row.session_id !== sessionID) return yield* Effect.die("Projected assistant message was not found")
    const message = Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type })
    if (message.type !== "assistant") return yield* Effect.die("Projected message was not an assistant message")
    const tool = message.content.find(
      (item): item is SessionMessage.AssistantTool => item.type === "tool" && item.id === callID,
    )
    if (!tool) return yield* Effect.die("Projected Surface tool was not found")
    return tool
  })
}
