import { describe, expect } from "bun:test"
import { asc, eq } from "drizzle-orm"
import { DateTime, Effect, Layer, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { ModelV2 } from "@opencode-ai/core/model"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { MessageTable, PartTable, SessionTable, SessionMessageTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
const it = testEffect(Layer.mergeAll(database, events, projector))
const timestamp = DateTime.makeUnsafe(1)
const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }

const content = (text: string) => [{ type: "text" as const, text }]

describe("Tool.Progress", () => {
  it.effect("projects durable progress and keeps final settlements durable", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const service = yield* EventV2.Service
      const sessionID = SessionV2.ID.make("ses_tool_progress_projector")
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "progress",
          directory: "/project",
          title: "progress",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const assistantMessageID = SessionMessage.ID.create()
      yield* service.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        timestamp,
        agent: "build",
        model,
      })
      const readAssistant = Effect.gen(function* () {
        const row = yield* db
          .select()
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.id, assistantMessageID))
          .get()
          .pipe(Effect.orDie)
        if (!row) return yield* Effect.die("Missing projected assistant")
        return Schema.decodeUnknownSync(SessionMessage.Assistant)({ ...row.data, id: row.id, type: row.type })
      })
      const start = (callID: string) =>
        Effect.gen(function* () {
          yield* service.publish(SessionEvent.Tool.Input.Started, {
            sessionID,
            timestamp,
            assistantMessageID,
            callID,
            name: "bash",
          })
          yield* service.publish(SessionEvent.Tool.Input.Ended, {
            sessionID,
            timestamp,
            assistantMessageID,
            callID,
            text: '{"command":"pwd"}',
          })
          yield* service.publish(SessionEvent.Tool.Called, {
            sessionID,
            timestamp,
            assistantMessageID,
            callID,
            tool: "bash",
            input: { command: "pwd" },
            provider: { executed: false },
          })
        })

      yield* start("call-success")
      expect((yield* readAssistant).content[0]).toMatchObject({
        state: { status: "running", structured: {}, content: [] },
      })

      yield* service.publish(SessionEvent.Tool.Progress, {
        sessionID,
        timestamp,
        assistantMessageID,
        callID: "call-success",
        structured: { phase: "checkpoint" },
        content: content("saved"),
      })
      expect((yield* readAssistant).content[0]).toMatchObject({
        state: { status: "running", structured: { phase: "checkpoint" }, content: content("saved") },
      })

      const success = yield* service.publish(SessionEvent.Tool.Success, {
        sessionID,
        timestamp,
        assistantMessageID,
        callID: "call-success",
        structured: { phase: "done" },
        content: content("complete"),
        provider: { executed: false },
      })
      expect((yield* readAssistant).content[0]).toMatchObject({
        state: { status: "completed", structured: { phase: "done" }, content: content("complete") },
      })

      yield* start("call-failed")
      yield* service.publish(SessionEvent.Tool.Progress, {
        sessionID,
        timestamp,
        assistantMessageID,
        callID: "call-failed",
        structured: { phase: "checkpoint" },
        content: content("before failure"),
      })
      const failed = yield* service.publish(SessionEvent.Tool.Failed, {
        sessionID,
        timestamp,
        assistantMessageID,
        callID: "call-failed",
        error: { type: "unknown", message: "boom" },
        provider: { executed: false },
      })
      expect((yield* readAssistant).content[1]).toMatchObject({
        state: {
          status: "error",
          structured: { phase: "checkpoint" },
          content: content("before failure"),
          error: { type: "unknown", message: "boom" },
        },
      })
      expect(Schema.is(SessionEvent.Durable)(success)).toBe(true)
      expect(Schema.is(SessionEvent.Durable)(failed)).toBe(true)

      const rows = yield* db
        .select({ type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)
      expect(rows.map((row) => row.type)).toContain(EventV2.versionedType(SessionEvent.Tool.Progress.type, 1))
      expect(rows.map((row) => row.type)).toContain(EventV2.versionedType(SessionEvent.Tool.Success.type, 1))
      expect(rows.map((row) => row.type)).toContain(EventV2.versionedType(SessionEvent.Tool.Failed.type, 2))
    }),
  )

  it.effect("marks only explicit tool interruption failures as interrupted", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const service = yield* EventV2.Service
      const sessionID = SessionV2.ID.make("ses_tool_interruption_projector")
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "interruption",
          directory: "/project",
          title: "interruption",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const legacyRootID = SessionV1.MessageID.make("msg_tool_interruption_root")
      yield* service.publish(SessionV1.Event.MessageUpdated, {
        sessionID,
        info: {
          id: legacyRootID,
          sessionID,
          role: "user",
          time: { created: 0 },
          agent: "build",
          model: { providerID: model.providerID, modelID: model.id },
        },
      })
      yield* service.publish(SessionV1.Event.Updated, {
        sessionID,
        info: SessionV1.SessionInfo.make({
          id: sessionID,
          projectID: Project.ID.global,
          slug: "interruption",
          directory: "/project",
          title: "interruption",
          version: "test",
          time: { created: 0, updated: 0 },
        }),
      })
      const assistantMessageID = SessionMessage.ID.create()
      yield* service.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        timestamp,
        agent: "build",
        model,
      })
      const start = (callID: string) =>
        Effect.gen(function* () {
          yield* service.publish(SessionEvent.Tool.Input.Started, {
            sessionID,
            timestamp,
            assistantMessageID,
            callID,
            name: "bash",
          })
          yield* service.publish(SessionEvent.Tool.Input.Ended, {
            sessionID,
            timestamp,
            assistantMessageID,
            callID,
            text: '{"command":"pwd"}',
          })
          yield* service.publish(SessionEvent.Tool.Called, {
            sessionID,
            timestamp,
            assistantMessageID,
            callID,
            tool: "bash",
            input: { command: "pwd" },
            provider: { executed: false },
          })
        })
      const addLegacyPart = (
        id: string,
        callID: string,
        state: Record<string, unknown>,
        metadata?: Record<string, unknown>,
      ) =>
        db
          .insert(PartTable)
          .values({
            id: SessionV1.PartID.make(id),
            session_id: sessionID,
            message_id: SessionV1.MessageID.make(assistantMessageID),
            time_created: 1,
            time_updated: 1,
            data: {
              type: "tool",
              tool: "bash",
              callID,
              state,
              metadata,
            } as (typeof PartTable.$inferInsert)["data"],
          })
          .run()
          .pipe(Effect.orDie)

      yield* start("call-explicit-session")
      yield* service.publish(SessionEvent.Tool.Failed, {
        sessionID,
        timestamp,
        assistantMessageID,
        callID: "call-explicit-session",
        error: { type: "unknown", message: "Tool execution aborted" },
        interruption: { source: "session" },
        provider: { executed: false },
      })
      yield* start("call-explicit-provider")
      yield* service.publish(SessionEvent.Tool.Progress, {
        sessionID,
        timestamp,
        assistantMessageID,
        callID: "call-explicit-provider",
        structured: { phase: "checkpoint" },
        content: content("before interruption"),
      })
      yield* service.publish(SessionEvent.Tool.Failed, {
        sessionID,
        timestamp,
        assistantMessageID,
        callID: "call-explicit-provider",
        error: { type: "unknown", message: "Tool execution interrupted" },
        interruption: { source: "provider" },
        provider: { executed: false },
      })
      yield* start("call-provider-same-text")
      yield* service.publish(SessionEvent.Tool.FailedV1, {
        sessionID,
        timestamp,
        assistantMessageID,
        callID: "call-provider-same-text",
        error: { type: "unknown", message: "Tool execution interrupted" },
        provider: { executed: true },
      })
      yield* start("call-domain-same-text")
      yield* service.publish(SessionEvent.Tool.FailedV1, {
        sessionID,
        timestamp,
        assistantMessageID,
        callID: "call-domain-same-text",
        error: { type: "unknown", message: "Tool execution interrupted" },
        result: { type: "error", value: "domain failure" },
        provider: { executed: false },
      })
      yield* start("call-legacy-provenance")
      yield* db
        .insert(MessageTable)
        .values({
          id: SessionV1.MessageID.make(assistantMessageID),
          session_id: sessionID,
          time_created: 1,
          time_updated: 1,
          data: {
            role: "assistant",
            time: { created: 1 },
            parentID: SessionV1.MessageID.make("msg_legacy_interruption_parent"),
            modelID: model.id,
            providerID: model.providerID,
            mode: "build",
            agent: "build",
            path: { cwd: "/project", root: "/project" },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          } as (typeof MessageTable.$inferInsert)["data"],
        })
        .run()
        .pipe(Effect.orDie)
      yield* addLegacyPart("prt_legacy_interruption_provenance", "call-legacy-provenance", {
        status: "error",
        input: { command: "pwd" },
        raw: "",
        error: "Tool execution aborted",
        metadata: { interrupted: true },
        time: { start: 1, end: 1 },
      })
      yield* service.publish(SessionEvent.Tool.FailedV1, {
        sessionID,
        timestamp,
        assistantMessageID,
        callID: "call-legacy-provenance",
        error: { type: "unknown", message: "Tool execution aborted" },
        result: { type: "error", value: "Tool execution aborted" },
        provider: { executed: false },
      })
      yield* start("call-legacy-running-provenance")
      yield* addLegacyPart("prt_legacy_running_provenance", "call-legacy-running-provenance", {
        status: "running",
        input: { command: "pwd" },
        raw: "",
        error: "Tool execution aborted",
        metadata: { interrupted: true },
        time: { start: 1 },
      })
      yield* service.publish(SessionEvent.Tool.FailedV1, {
        sessionID,
        timestamp,
        assistantMessageID,
        callID: "call-legacy-running-provenance",
        error: { type: "unknown", message: "Tool execution aborted" },
        result: { type: "error", value: "Tool execution aborted" },
        provider: { executed: false },
      })
      yield* start("call-legacy-completed-provenance")
      yield* addLegacyPart("prt_legacy_completed_provenance", "call-legacy-completed-provenance", {
        status: "completed",
        input: { command: "pwd" },
        output: "done",
        error: "Tool execution aborted",
        metadata: { interrupted: true },
        time: { start: 1, end: 1 },
      })
      yield* service.publish(SessionEvent.Tool.FailedV1, {
        sessionID,
        timestamp,
        assistantMessageID,
        callID: "call-legacy-completed-provenance",
        error: { type: "unknown", message: "Tool execution aborted" },
        result: { type: "error", value: "Tool execution aborted" },
        provider: { executed: false },
      })
      yield* start("call-legacy-metadata-collision")
      yield* addLegacyPart(
        "prt_legacy_metadata_collision",
        "call-legacy-metadata-collision",
        {
          status: "error",
          input: { command: "pwd" },
          raw: "",
          error: "Tool execution aborted",
          metadata: { nested: { interrupted: true } },
          time: { start: 1, end: 1 },
        },
        { interrupted: true },
      )
      yield* service.publish(SessionEvent.Tool.FailedV1, {
        sessionID,
        timestamp,
        assistantMessageID,
        callID: "call-legacy-metadata-collision",
        error: { type: "unknown", message: "Tool execution aborted" },
        result: { type: "error", value: "Tool execution aborted" },
        provider: { executed: false },
      })
      yield* start("call-legacy-error-mismatch")
      yield* addLegacyPart("prt_legacy_error_mismatch", "call-legacy-error-mismatch", {
        status: "error",
        input: { command: "pwd" },
        raw: "",
        error: "Different legacy error",
        metadata: { interrupted: true },
        time: { start: 1, end: 1 },
      })
      yield* service.publish(SessionEvent.Tool.FailedV1, {
        sessionID,
        timestamp,
        assistantMessageID,
        callID: "call-legacy-error-mismatch",
        error: { type: "unknown", message: "Tool execution aborted" },
        result: { type: "error", value: "Tool execution aborted" },
        provider: { executed: false },
      })
      yield* start("call-legacy-result-mismatch")
      yield* addLegacyPart("prt_legacy_result_mismatch", "call-legacy-result-mismatch", {
        status: "error",
        input: { command: "pwd" },
        raw: "",
        error: "Tool execution aborted",
        metadata: { interrupted: true },
        time: { start: 1, end: 1 },
      })
      yield* service.publish(SessionEvent.Tool.FailedV1, {
        sessionID,
        timestamp,
        assistantMessageID,
        callID: "call-legacy-result-mismatch",
        error: { type: "unknown", message: "Tool execution aborted" },
        result: { type: "error", value: "Different provider result" },
        provider: { executed: false },
      })
      yield* start("call-late-legacy-provenance")
      yield* service.publish(SessionEvent.Tool.FailedV1, {
        sessionID,
        timestamp,
        assistantMessageID,
        callID: "call-late-legacy-provenance",
        error: { type: "unknown", message: "Tool execution aborted" },
        result: { type: "error", value: "Tool execution aborted" },
        provider: { executed: false },
      })
      yield* service.publish(SessionV1.Event.PartUpdated, {
        sessionID,
        part: {
          id: SessionV1.PartID.make("prt_late_legacy_provenance"),
          sessionID,
          messageID: SessionV1.MessageID.make(assistantMessageID),
          type: "tool",
          tool: "bash",
          callID: "call-late-legacy-provenance",
          state: {
            status: "error",
            input: { command: "pwd" },
            error: "Tool execution aborted",
            metadata: { interrupted: true },
            time: { start: 1, end: 1 },
          },
        },
        time: 1,
      })
      yield* start("call-legacy-interrupted")
      yield* service.publish(SessionEvent.Tool.FailedV1, {
        sessionID,
        timestamp,
        assistantMessageID,
        callID: "call-legacy-interrupted",
        error: { type: "unknown", message: "Tool execution interrupted" },
        provider: { executed: false },
      })
      yield* start("call-legacy-structured")
      yield* service.publish(SessionEvent.Tool.Progress, {
        sessionID,
        timestamp,
        assistantMessageID,
        callID: "call-legacy-structured",
        structured: { phase: "checkpoint", interrupted: false },
        content: content("before legacy interruption"),
      })
      yield* service.publish(SessionEvent.Tool.FailedV1, {
        sessionID,
        timestamp,
        assistantMessageID,
        callID: "call-legacy-structured",
        error: { type: "unknown", message: "Tool execution interrupted" },
        provider: { executed: false },
      })

      const row = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, assistantMessageID))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* Effect.die("Missing projected assistant")
      const assistant = Schema.decodeUnknownSync(SessionMessage.Assistant)({ ...row.data, id: row.id, type: row.type })
      expect(assistant.content[0]).toMatchObject({
        state: { status: "error", structured: {}, interruption: { source: "session" } },
      })
      expect(assistant.content[1]).toMatchObject({
        state: { status: "error", structured: { phase: "checkpoint" }, interruption: { source: "provider" } },
      })
      expect(assistant.content[2]).toMatchObject({
        state: { status: "error", structured: {} },
      })
      expect(assistant.content[3]).toMatchObject({ state: { status: "error", structured: {} } })
      expect(assistant.content[4]).toMatchObject({
        state: { status: "error", structured: { interrupted: true } },
      })
      for (const index of [5, 6, 7, 8, 9, 10])
        expect(assistant.content[index]).toMatchObject({ state: { status: "error", structured: {} } })
      expect(assistant.content[11]).toMatchObject({
        state: { status: "error", structured: { interrupted: true } },
      })
      expect(assistant.content[12]).toMatchObject({
        state: { status: "error", structured: { phase: "checkpoint", interrupted: false } },
      })
      for (const index of [2, 3, 5, 6, 7, 8, 9, 10])
        expect(assistant.content[index]?.type === "tool" && assistant.content[index].state.status === "error"
          ? assistant.content[index].state.structured
          : undefined).not.toHaveProperty("interrupted")
      for (const index of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
        expect(assistant.content[index]?.type === "tool" && assistant.content[index].state.status === "error"
          ? assistant.content[index].state
          : undefined).not.toHaveProperty("interruption")
      yield* Effect.forEach(
        [
          "prt_legacy_running_provenance",
          "prt_legacy_completed_provenance",
          "prt_legacy_metadata_collision",
          "prt_legacy_error_mismatch",
          "prt_legacy_result_mismatch",
        ],
        (id) => db.delete(PartTable).where(eq(PartTable.id, SessionV1.PartID.make(id))).run().pipe(Effect.orDie),
      )
      expect(yield* service.createCheckpoint(sessionID)).toMatchObject({ aggregateID: sessionID })
    }),
  )
})
