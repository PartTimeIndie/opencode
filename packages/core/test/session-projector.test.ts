import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Layer, Schema } from "effect"
import { asc, eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { ModelV2 } from "@opencode-ai/core/model"
import { Location } from "@opencode-ai/core/location"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { ContentStore } from "@opencode-ai/core/content-store"
import { boundedContentPreview, boundedPersistedContentPreview } from "@opencode-ai/core/content-preview"
import { CheckpointVerificationTransport } from "@opencode-ai/core/checkpoint-verification-transport"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { FileAttachment, Prompt } from "@opencode-ai/core/session/prompt"
import { SessionMessageUpdater } from "@opencode-ai/core/session/message-updater"
import { SessionPlanDocument } from "@opencode-ai/core/session/plan-document"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionFailure } from "@opencode-ai/core/session/failure"
import { MessageTable, PartTable, SessionInputTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { isRecord } from "@opencode-ai/core/util/record"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
const it = testEffect(Layer.mergeAll(database, events, projector))
const sessionID = SessionV2.ID.make("ses_projector_test")
const created = DateTime.makeUnsafe(0)
const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }
const encodeMessage = Schema.encodeSync(SessionMessage.Message)

describe("checkpoint verification input", () => {
  test("transports large semantic JSON strings to checkpoint workers exactly", () => {
    const toolInput = JSON.stringify({ command: "write", content: "x".repeat(2_000_000), nested: { enabled: true } })
    const input = {
      aggregateID: "ses_large_summary_verification",
      expected: {
        adapter: SessionProjector.CheckpointAdapterID,
        version: 2,
        data: { toolInput },
      },
      events: [
        {
          id: EventV2.ID.make("evt_large_summary_verification"),
          aggregateID: "ses_large_summary_verification",
          seq: 0,
          type: "session.next.summary.updated.1",
          data: {
            sessionID: "ses_large_summary_verification",
            timestamp: 1,
            toolInput,
          },
        },
      ],
    } satisfies SessionProjector.CheckpointVerificationInput

    const restored = CheckpointVerificationTransport.decode<SessionProjector.CheckpointVerificationInput>(
      CheckpointVerificationTransport.encode(input),
    )
    expect(restored).toEqual(input)
    expect((restored.events[0]?.data as { toolInput: string }).toolInput.length).toBe(toolInput.length)
    expect(JSON.parse((restored.events[0]?.data as { toolInput: string }).toolInput)).toEqual(JSON.parse(toolInput))
  })

  test("fresh replay preserves a large semantically relevant summary patch exactly", async () => {
    const largeSessionID = SessionV2.ID.make("ses_large_summary_exact_replay")
    const patch = "diff --git a/large b/large\n" + "x".repeat(2_000_000)
    const summary = { additions: 1, deletions: 0, files: 1, diffs: [{ file: "large", patch, additions: 1, deletions: 0, status: "modified" as const }] }
    const session = {
      id: largeSessionID,
      project_id: Project.ID.global,
      workspace_id: null,
      parent_id: null,
      slug: "large-summary",
      directory: "/project",
      path: null,
      title: "large-summary",
      version: "test",
      share_url: null,
      summary_additions: summary.additions,
      summary_deletions: summary.deletions,
      summary_files: summary.files,
      summary_diffs: summary.diffs,
      metadata: null,
      cost: 0,
      tokens_input: 0,
      tokens_output: 0,
      tokens_reasoning: 0,
      tokens_cache_read: 0,
      tokens_cache_write: 0,
      revert: null,
      permission: null,
      agent: null,
      model: null,
      time_created: 1,
      time_updated: 2,
      time_compacting: null,
      time_archived: null,
      agent_policy: null,
    }
    const input = {
      aggregateID: largeSessionID,
      expected: {
        adapter: SessionProjector.CheckpointAdapterID,
        version: 2,
        data: {
          session,
          legacyMessages: [],
          legacyParts: [],
          messages: [],
          inputs: [],
        },
      },
      events: [
        {
          id: EventV2.ID.make("evt_large_summary_created"),
          aggregateID: largeSessionID,
          seq: 0,
          type: EventV2.versionedType(SessionV1.Event.Created.type, SessionV1.Event.Created.sync?.version ?? 1),
          data: {
            sessionID: largeSessionID,
            info: SessionV1.SessionInfo.make({
              id: largeSessionID,
              projectID: Project.ID.global,
              slug: "large-summary",
              directory: "/project",
              title: "large-summary",
              version: "test",
              time: { created: 1, updated: 1 },
            }),
          },
        },
        {
          id: EventV2.ID.make("evt_large_summary_updated"),
          aggregateID: largeSessionID,
          seq: 1,
          type: EventV2.versionedType(SessionEvent.SummaryUpdated.type, SessionEvent.SummaryUpdated.sync?.version ?? 1),
          data: { sessionID: largeSessionID, timestamp: 2, summary },
        },
      ],
    } satisfies SessionProjector.CheckpointVerificationInput

    await Effect.runPromise(SessionProjector.verifyProjectionInFreshRuntime(input))
  })
})

const assistantRow = (
  id: SessionMessage.ID,
  seq: number,
  time: { created: DateTime.Utc; completed?: DateTime.Utc } = { created },
) => {
  const {
    id: _,
    type,
    ...data
  } = encodeMessage(new SessionMessage.Assistant({ id, type: "assistant", agent: "build", model, content: [], time }))
  return { id, session_id: sessionID, type, seq, time_created: DateTime.toEpochMillis(time.created), data }
}

const legacyEvidenceCheckpoint = (input: {
  readonly name: string
  readonly role: "user" | "assistant"
  readonly tailMessage?: boolean
  readonly tailV2Assistant?: boolean
  readonly tailAfterPrompt?: boolean
  readonly compactionAssistant?: string
  readonly compactionAssistantTime?: number
  readonly assistantSnapshot?: string
  readonly stepEndTime?: number
  readonly parts: ReadonlyArray<{
    readonly id: string
    readonly time?: number
    readonly updated?: number
    readonly data: Record<string, unknown>
  }>
  readonly publish: (
    events: EventV2.Interface,
    ids: { readonly sessionID: SessionV2.ID; readonly messageID: SessionMessage.ID },
  ) => Effect.Effect<void>
}) =>
  Effect.gen(function* () {
    const legacySessionID = SessionV2.ID.make(`ses_evidence_${input.name}`)
    const rootID = SessionV1.MessageID.make(`msg_evidence_root_${input.name}`)
    const messageID =
      input.role === "user" ? SessionMessage.ID.make(rootID) : SessionMessage.ID.make(`msg_evidence_${input.name}`)
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: legacySessionID,
        project_id: Project.ID.global,
        slug: input.name,
        directory: "/project",
        title: input.name,
        version: "legacy",
      })
      .run()
      .pipe(Effect.orDie)
    if (input.compactionAssistant)
      yield* db
        .insert(MessageTable)
        .values({
          id: SessionV1.MessageID.make(input.compactionAssistant),
          session_id: legacySessionID,
          time_created: input.compactionAssistantTime ?? 4,
          time_updated: input.compactionAssistantTime ?? 4,
          data: {
            role: "assistant",
            time: { created: input.compactionAssistantTime ?? 4 },
            parentID: SessionV1.MessageID.make(messageID),
            modelID: model.id,
            providerID: model.providerID,
            mode: "compaction",
            agent: "compaction",
            summary: true,
            path: { cwd: "/project", root: "/project" },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          } as unknown as (typeof MessageTable.$inferInsert)["data"],
        })
        .run()
        .pipe(Effect.orDie)
    yield* db
      .insert(MessageTable)
      .values({
        id: SessionV1.MessageID.make(messageID),
        session_id: legacySessionID,
        time_created: input.role === "user" ? 1 : 2,
        time_updated: input.role === "user" ? 1 : 2,
        data: (input.role === "user"
          ? {
              role: "user",
              time: { created: 1 },
              agent: "build",
              model: { providerID: model.providerID, modelID: model.id },
            }
          : {
              role: "assistant",
              time: { created: 2 },
              parentID: rootID,
              modelID: model.id,
              providerID: model.providerID,
              mode: "build",
              agent: "build",
              path: { cwd: "/project", root: "/project" },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            }) as unknown as (typeof MessageTable.$inferInsert)["data"],
      })
      .run()
      .pipe(Effect.orDie)
    if (input.tailMessage)
      yield* db
        .insert(MessageTable)
        .values({
          id: SessionV1.MessageID.make(`msg_evidence_tail_${input.name}`),
          session_id: legacySessionID,
          time_created: 0,
          time_updated: 0,
          data: (input.tailV2Assistant
            ? {
                role: "assistant",
                time: { created: 0 },
                parentID: rootID,
                modelID: model.id,
                providerID: model.providerID,
                mode: "build",
                agent: "build",
                path: { cwd: "/project", root: "/project" },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              }
            : {
                role: "user",
                time: { created: 0 },
                agent: "build",
                model: { providerID: model.providerID, modelID: model.id },
              }) as unknown as (typeof MessageTable.$inferInsert)["data"],
        })
        .run()
        .pipe(Effect.orDie)
    yield* db
      .insert(PartTable)
      .values(
        input.parts.map((part) => ({
          id: SessionV1.PartID.make(part.id),
          session_id: legacySessionID,
          message_id: SessionV1.MessageID.make(messageID),
          time_created: part.time ?? 2,
          time_updated: part.updated ?? part.time ?? 2,
          data: part.data as (typeof PartTable.$inferInsert)["data"],
        })),
      )
      .run()
      .pipe(Effect.orDie)
    const events = yield* EventV2.Service
    if (input.tailMessage && !input.tailV2Assistant && !input.tailAfterPrompt)
      yield* events.publish(SessionV1.Event.MessageUpdated, {
        sessionID: legacySessionID,
        info: {
          id: SessionV1.MessageID.make(`msg_evidence_tail_${input.name}`),
          sessionID: legacySessionID,
          role: "user",
          time: { created: 0 },
          agent: "build",
          model: { providerID: model.providerID, modelID: model.id },
        },
      })
    yield* events.publish(SessionV1.Event.MessageUpdated, {
      sessionID: legacySessionID,
      info: {
        id: rootID,
        sessionID: legacySessionID,
        role: "user",
        time: { created: 1 },
        agent: "build",
        model: { providerID: model.providerID, modelID: model.id },
      },
    })
    yield* events.publish(SessionV1.Event.Updated, {
      sessionID: legacySessionID,
      info: SessionV1.SessionInfo.make({
        id: legacySessionID,
        projectID: Project.ID.global,
        slug: input.name,
        directory: "/project",
        title: input.name,
        version: "legacy",
        time: { created: 0, updated: 2 },
      }),
    })
    if (input.tailMessage && input.tailV2Assistant && !input.tailAfterPrompt)
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID: legacySessionID,
        timestamp: DateTime.makeUnsafe(0),
        assistantMessageID: SessionMessage.ID.make(`msg_evidence_tail_${input.name}`),
        agent: "build",
        model,
      })
    if (input.role === "assistant")
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID: legacySessionID,
        timestamp: DateTime.makeUnsafe(3),
        assistantMessageID: messageID,
        agent: "build",
        model,
        snapshot: input.assistantSnapshot,
      })
    yield* input.publish(events, { sessionID: legacySessionID, messageID })
    if (input.tailMessage && input.tailAfterPrompt)
      yield* events.publish(SessionV1.Event.MessageUpdated, {
        sessionID: legacySessionID,
        info: {
          id: SessionV1.MessageID.make(`msg_evidence_tail_${input.name}`),
          sessionID: legacySessionID,
          role: "user",
          time: { created: 0 },
          agent: "build",
          model: { providerID: model.providerID, modelID: model.id },
        },
      })
    if (input.role === "assistant")
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID: legacySessionID,
        timestamp: DateTime.makeUnsafe(input.stepEndTime ?? 9),
        assistantMessageID: messageID,
        finish: "stop",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        snapshot: input.assistantSnapshot,
      })
    return yield* events.createCheckpoint(legacySessionID)
  })

const publishCompletedTool = (
  events: EventV2.Interface,
  ids: { readonly sessionID: SessionV2.ID; readonly messageID: SessionMessage.ID },
  input: {
    readonly callID: string
    readonly command?: string
    readonly output: string
    readonly tool?: string
    readonly toolInput?: Record<string, unknown>
    readonly eventOutput?: string
    readonly structured?: Record<string, unknown>
    readonly start?: number
    readonly end?: number
  },
) =>
  Effect.gen(function* () {
    const tool = input.tool ?? "shell"
    const toolInput = input.toolInput ?? { command: input.command ?? "" }
    yield* events.publish(SessionEvent.Tool.Input.Started, {
      sessionID: ids.sessionID,
      timestamp: DateTime.makeUnsafe(input.start ?? 6),
      assistantMessageID: ids.messageID,
      callID: input.callID,
      name: tool,
    })
    yield* events.publish(SessionEvent.Tool.Input.Ended, {
      sessionID: ids.sessionID,
      timestamp: DateTime.makeUnsafe(input.start ?? 6),
      assistantMessageID: ids.messageID,
      callID: input.callID,
      text: JSON.stringify(toolInput),
    })
    yield* events.publish(SessionEvent.Tool.Called, {
      sessionID: ids.sessionID,
      timestamp: DateTime.makeUnsafe(input.start ?? 6),
      assistantMessageID: ids.messageID,
      callID: input.callID,
      tool,
      input: toolInput,
      provider: { executed: false },
    })
    yield* events.publish(SessionEvent.Tool.Success, {
      sessionID: ids.sessionID,
      timestamp: DateTime.makeUnsafe(input.end ?? 8),
      assistantMessageID: ids.messageID,
      callID: input.callID,
      structured: input.structured ?? {},
      content: [{ type: "text", text: input.eventOutput ?? input.output }],
      result: { type: "text", value: input.eventOutput ?? input.output },
      provider: { executed: false },
    })
  })

describe("SessionProjector", () => {
  it.effect("projects custom parts into their assistant message", () =>
    Effect.gen(function* () {
      const customSessionID = SessionV2.ID.make("ses_custom_projector")
      const messageID = SessionMessage.ID.make("msg_custom_projector")
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* events.publish(SessionV1.Event.Created, {
        sessionID: customSessionID,
        info: SessionV1.SessionInfo.make({
          id: customSessionID,
          projectID: Project.ID.global,
          slug: "custom-projector",
          directory: "/project",
          title: "custom-projector",
          version: "test",
          time: { created: 1, updated: 1 },
        }),
      })
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID: customSessionID,
        timestamp: DateTime.makeUnsafe(2),
        assistantMessageID: messageID,
        agent: "build",
        model,
      })
      yield* events.publish(SessionEvent.Custom.Added, {
        sessionID: customSessionID,
        timestamp: DateTime.makeUnsafe(3),
        assistantMessageID: messageID,
        partID: "prt_custom_projector",
        kind: "opencode/control-panel",
        data: { version: 1 },
        title: "Project controls",
        fallback: "Project controls fallback",
        metadata: { source: "test" },
        time: { start: DateTime.makeUnsafe(3), end: DateTime.makeUnsafe(4) },
      })

      const message = yield* db
        .select({ data: SessionMessageTable.data })
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, messageID))
        .get()
        .pipe(Effect.orDie)
      expect(message?.data).toMatchObject({
        content: [
          {
            type: "custom",
            id: "prt_custom_projector",
            kind: "opencode/control-panel",
            data: { version: 1 },
            title: "Project controls",
            fallback: "Project controls fallback",
            metadata: { source: "test" },
            time: { start: 3, end: 4 },
          },
        ],
      })
      expect(yield* events.createCheckpoint(customSessionID)).toBeDefined()
    }),
  )

  it.effect("orders projected messages and context by durable aggregate sequence", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
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
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service

      yield* events.publish(
        SessionEvent.Prompted,
        {
          sessionID,
          messageID: SessionMessage.ID.make("msg_first"),
          timestamp: created,
          prompt: new Prompt({ text: "first" }),
          delivery: "steer",
        },
        { id: EventV2.ID.make("evt_z") },
      )
      yield* events.publish(
        SessionEvent.Prompted,
        {
          sessionID,
          messageID: SessionMessage.ID.make("msg_second"),
          timestamp: created,
          prompt: new Prompt({ text: "second" }),
          delivery: "steer",
        },
        { id: EventV2.ID.make("evt_a") },
      )

      const sessions = yield* SessionV2.Service
      const firstPage = yield* sessions.messages({ sessionID, limit: 1, order: "asc" })
      expect(firstPage.map((message) => (message.type === "user" ? message.text : message.type))).toEqual(["first"])
      const secondPage = yield* sessions.messages({
        sessionID,
        limit: 1,
        order: "asc",
        cursor: { id: firstPage[0]!.id, direction: "next" },
      })
      expect(secondPage.map((message) => (message.type === "user" ? message.text : message.type))).toEqual(["second"])
      expect(
        (yield* sessions.messages({
          sessionID,
          limit: 1,
          order: "asc",
          cursor: { id: secondPage[0]!.id, direction: "previous" },
        })).map((message) => (message.type === "user" ? message.text : message.type)),
      ).toEqual(["first"])
      expect(
        (yield* sessions.context(sessionID)).map((message) => (message.type === "user" ? message.text : message.type)),
      ).toEqual(["first", "second"])

      const projected = yield* db
        .select({ seq: SessionMessageTable.seq })
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      const latestSeq = Math.max(...projected.map((row) => row.seq))
      const assistantIDs = Array.from({ length: 601 }, (_, index) =>
        SessionMessage.ID.make(`msg_long_turn_${String(index + 1).padStart(3, "0")}`),
      )
      yield* db
        .insert(SessionMessageTable)
        .values(assistantIDs.map((id, index) => assistantRow(id, latestSeq + index + 1)))
        .run()
        .pipe(Effect.orDie)

      expect(yield* sessions.messages({ sessionID, limit: 25, order: "desc" })).toHaveLength(25)
      expect(
        (yield* sessions.messageContext({ sessionID, before: assistantIDs.at(-1)! })).map((message) =>
          message.type === "user" ? message.text : message.type,
        ),
      ).toEqual(["second"])
    }).pipe(
      Effect.provide(
        SessionV2.layer.pipe(
          Layer.provide(ContentStore.defaultLayer),
          Layer.provide(events),
          Layer.provide(database),
          Layer.provide(Project.defaultLayer),
          Layer.provide(SessionStore.layer.pipe(Layer.provide(database))),
          Layer.provide(SessionExecution.noopLayer),
        ),
      ),
    ),
  )

  it.effect("checkpoints a legacy backfilled stream that starts with a prompt", () =>
    Effect.gen(function* () {
      const legacySessionID = SessionV2.ID.make("ses_0dc71ff3dffelQJW381TC7YfZP")
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: legacySessionID,
          project_id: Project.ID.global,
          slug: "legacy-backfill",
          directory: "/project",
          title: "legacy backfill",
          version: "legacy",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      const promptMessageID = SessionMessage.ID.make("msg_f238e00c5001BqDeiTKyM91lZc")
      yield* events.publish(SessionEvent.Prompted, {
        sessionID: legacySessionID,
        messageID: promptMessageID,
        timestamp: created,
        prompt: new Prompt({ text: "legacy prompt" }),
        delivery: "steer",
      })
      const assistantMessageID = SessionMessage.ID.make("msg_legacy_backfill_assistant")
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID: legacySessionID,
        timestamp: DateTime.makeUnsafe(1),
        assistantMessageID,
        agent: "build",
        model,
      })
      const tokens = { input: 74_794, output: 512, reasoning: 128, cache: { read: 64, write: 32 } }
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID: legacySessionID,
        timestamp: DateTime.makeUnsafe(2),
        assistantMessageID,
        finish: "stop",
        cost: 1.25,
        tokens,
      })
      yield* db
        .insert(MessageTable)
        .values([
          {
            id: SessionV1.MessageID.make(promptMessageID),
            session_id: legacySessionID,
            time_created: 0,
            time_updated: 0,
            data: {
              role: "user",
              time: { created: 0 },
              agent: "build",
              model: { providerID: model.providerID, modelID: model.id },
            } as (typeof MessageTable.$inferInsert)["data"],
          },
          {
            id: SessionV1.MessageID.make(assistantMessageID),
            session_id: legacySessionID,
            time_created: 1,
            time_updated: 2,
            data: {
              role: "assistant",
              time: { created: 1, completed: 2 },
              parentID: SessionV1.MessageID.make(promptMessageID),
              modelID: model.id,
              providerID: model.providerID,
              mode: "build",
              agent: "build",
              path: { cwd: "/project", root: "/project" },
              cost: 1.25,
              tokens,
              finish: "stop",
            } as (typeof MessageTable.$inferInsert)["data"],
          },
          {
            id: SessionV1.MessageID.make("msg_unmatched_legacy_projection"),
            session_id: legacySessionID,
            time_created: 3,
            time_updated: 3,
            data: {
              role: "user",
              time: { created: 3 },
              agent: "build",
              model: { providerID: model.providerID, modelID: model.id },
            } as (typeof MessageTable.$inferInsert)["data"],
          },
        ])
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(PartTable)
        .values([
          {
            id: SessionV1.PartID.make("prt_legacy_backfill_text"),
            message_id: SessionV1.MessageID.make(promptMessageID),
            session_id: legacySessionID,
            time_created: 0,
            time_updated: 0,
            data: { type: "text", text: "legacy prompt", synthetic: true } as (typeof PartTable.$inferInsert)["data"],
          },
          {
            id: SessionV1.PartID.make("prt_legacy_backfill_step_finish"),
            message_id: SessionV1.MessageID.make(assistantMessageID),
            session_id: legacySessionID,
            time_created: 2,
            time_updated: 2,
            data: { type: "step-finish", reason: "stop", cost: 1.25, tokens } as (typeof PartTable.$inferInsert)["data"],
          },
        ])
        .run()
        .pipe(Effect.orDie)

      expect(
        (yield* db.select({ type: EventTable.type }).from(EventTable).orderBy(asc(EventTable.seq)).all()).map(
          (event) => event.type,
        ),
      ).toEqual(["session.next.prompted.1", "session.next.step.started.1", "session.next.step.ended.2"])
      expect(String(yield* events.createCheckpoint(legacySessionID).pipe(Effect.exit))).toContain(
        "legacyMessages count differs",
      )
      yield* db
        .delete(MessageTable)
        .where(eq(MessageTable.id, SessionV1.MessageID.make("msg_unmatched_legacy_projection")))
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(PartTable)
        .values({
          id: SessionV1.PartID.make("prt_unmatched_prompt_checkpoint_only"),
          message_id: SessionV1.MessageID.make(promptMessageID),
          session_id: legacySessionID,
          time_created: 0,
          time_updated: 0,
          data: { type: "text", text: "unmatched prompt data", synthetic: true } as (typeof PartTable.$inferInsert)["data"],
        })
        .run()
        .pipe(Effect.orDie)
      expect(String(yield* events.createCheckpoint(legacySessionID).pipe(Effect.exit))).toContain(
        "Checkpoint-only legacy causality failed",
      )
      yield* db
        .delete(PartTable)
        .where(eq(PartTable.id, SessionV1.PartID.make("prt_unmatched_prompt_checkpoint_only")))
        .run()
        .pipe(Effect.orDie)
      expect(yield* events.createCheckpoint(legacySessionID)).toMatchObject({
        aggregateID: legacySessionID,
        seq: 2,
      })
    }),
  )

  it.effect("rejects a no-create stream that does not match the historical prompt-first signature", () =>
    Effect.gen(function* () {
      const lifecycleSessionID = SessionV2.ID.make("ses_current_lifecycle_without_create")
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: lifecycleSessionID,
          project_id: Project.ID.global,
          slug: "current-lifecycle",
          directory: "/project",
          title: "current lifecycle",
          version: "current",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      yield* events.publish(SessionEvent.PromptLifecycle.Admitted, {
        sessionID: lifecycleSessionID,
        messageID: SessionMessage.ID.make("msg_current_lifecycle_admitted"),
        timestamp: created,
        prompt: new Prompt({ text: "must not use legacy compatibility" }),
        delivery: "steer",
      })

      const rejected = yield* events.createCheckpoint(lifecycleSessionID).pipe(Effect.exit)
      expect(rejected._tag).toBe("Failure")
      expect(String(rejected)).toContain("FOREIGN KEY constraint failed")
    }),
  )

  it.effect("checkpoints a legacy message-first stream with a later authoritative session root", () =>
    Effect.gen(function* () {
      const legacySessionID = SessionV2.ID.make("ses_0dca534ddffeUp4A5tfLBx3wKh")
      const messageID = SessionV1.MessageID.make("msg_legacy_message_first")
      const orphanAssistantID = SessionV1.MessageID.make("msg_f238d705_legacy_orphan")
      const orphanPromptID = SessionV1.MessageID.make("msg_f238d705_legacy_prompt")
      const tokens = { input: 12, output: 3, reasoning: 4, cache: { read: 5, write: 6 } }
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: legacySessionID,
          project_id: Project.ID.global,
          slug: "pre-root",
          directory: "/project",
          title: "pre-root",
          version: "legacy",
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(MessageTable)
        .values({
          id: messageID,
          session_id: legacySessionID,
          time_created: 1,
          time_updated: 1,
          data: {
            role: "user",
            time: { created: 1 },
            agent: "build",
            model: { providerID: model.providerID, modelID: model.id },
          } as (typeof MessageTable.$inferInsert)["data"],
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(MessageTable)
        .values({
          id: orphanAssistantID,
          session_id: legacySessionID,
          time_created: 4,
          time_updated: 4,
          data: {
            role: "assistant",
            time: { created: 4 },
            parentID: messageID,
            modelID: model.id,
            providerID: model.providerID,
            mode: "build",
            agent: "build",
            path: { cwd: "/project", root: "/project" },
            cost: 1,
            tokens,
          } as (typeof MessageTable.$inferInsert)["data"],
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(PartTable)
        .values({
          id: SessionV1.PartID.make("prt_legacy_message_first"),
          session_id: legacySessionID,
          message_id: messageID,
          time_created: 1,
          time_updated: 1,
          data: {
            type: "text",
            text: "projection written before its first update event",
          } as (typeof PartTable.$inferInsert)["data"],
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(PartTable)
        .values({
          id: SessionV1.PartID.make("prt_f238d705_legacy_usage"),
          session_id: legacySessionID,
          message_id: orphanAssistantID,
          time_created: 4,
          time_updated: 4,
          data: {
            type: "step-finish",
            reason: "stop",
            cost: 1,
            tokens: { ...tokens, total: 30 },
          } as (typeof PartTable.$inferInsert)["data"],
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(PartTable)
        .values({
          id: SessionV1.PartID.make("prt_f238d705_legacy_orphan"),
          session_id: legacySessionID,
          message_id: orphanAssistantID,
          time_created: 3,
          time_updated: 3,
          data: {
            type: "text",
            text: "projection written before its first update event",
          } as (typeof PartTable.$inferInsert)["data"],
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(MessageTable)
        .values({
          id: orphanPromptID,
          session_id: legacySessionID,
          time_created: 7,
          time_updated: 7,
          data: {
            role: "user",
            time: { created: 7 },
            agent: "build",
            model: { providerID: model.providerID, modelID: model.id },
          } as (typeof MessageTable.$inferInsert)["data"],
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(PartTable)
        .values({
          id: SessionV1.PartID.make("prt_f238d705_legacy_prompt"),
          session_id: legacySessionID,
          message_id: orphanPromptID,
          time_created: 7,
          time_updated: 7,
          data: {
            type: "text",
            text: "prompt projection written before its V2 event",
          } as (typeof PartTable.$inferInsert)["data"],
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      yield* events.publish(SessionV1.Event.MessageUpdated, {
        sessionID: legacySessionID,
        info: {
          id: messageID,
          sessionID: legacySessionID,
          role: "user",
          time: { created: 1 },
          agent: "build",
          model: { providerID: model.providerID, modelID: model.id },
        },
      })
      yield* events.publish(SessionV1.Event.PartUpdated, {
        sessionID: legacySessionID,
        part: {
          id: SessionV1.PartID.make("prt_legacy_message_first"),
          sessionID: legacySessionID,
          messageID,
          type: "text",
          text: "child before root",
        },
        time: 2,
      })
      yield* events.publish(SessionV1.Event.Updated, {
        sessionID: legacySessionID,
        info: SessionV1.SessionInfo.make({
          id: legacySessionID,
          projectID: Project.ID.global,
          slug: "authoritative-root",
          directory: "/project",
          title: "authoritative root",
          version: "legacy",
          cost: 1,
          tokens,
          time: { created: 0, updated: 3 },
        }),
      })
      yield* events.publish(SessionV1.Event.PartUpdated, {
        sessionID: legacySessionID,
        part: {
          id: SessionV1.PartID.make("prt_f238d705_legacy_orphan"),
          sessionID: legacySessionID,
          messageID: orphanAssistantID,
          type: "text",
          text: "child written before the V2 assistant projection",
        },
        time: 4,
      })
      yield* events.publish(SessionV1.Event.MessageUpdated, {
        sessionID: legacySessionID,
        info: {
          id: orphanAssistantID,
          sessionID: legacySessionID,
          role: "assistant",
          time: { created: 4 },
          parentID: messageID,
          modelID: model.id,
          providerID: model.providerID,
          mode: "build",
          agent: "build",
          path: { cwd: "/project", root: "/project" },
          cost: 1,
          tokens,
        },
      })
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID: legacySessionID,
        timestamp: DateTime.makeUnsafe(5),
        assistantMessageID: SessionMessage.ID.make(orphanAssistantID),
        agent: "build",
        model,
      })
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID: legacySessionID,
        timestamp: DateTime.makeUnsafe(6),
        assistantMessageID: SessionMessage.ID.make(orphanAssistantID),
        finish: "stop",
        cost: 1,
        tokens,
      })
      yield* events.publish(SessionEvent.Prompted, {
        sessionID: legacySessionID,
        timestamp: DateTime.makeUnsafe(7),
        messageID: SessionMessage.ID.make(orphanPromptID),
        prompt: new Prompt({ text: "prompt projection written before its V2 event" }),
        delivery: "steer",
      })

      expect(
        (yield* db.select({ type: EventTable.type }).from(EventTable).orderBy(asc(EventTable.seq)).all()).map(
          (event) => event.type,
        ),
      ).toEqual([
        "message.updated.1",
        "message.part.updated.1",
        "session.updated.1",
        "message.part.updated.1",
        "message.updated.1",
        "session.next.step.started.1",
        "session.next.step.ended.2",
        "session.next.prompted.1",
      ])
      expect(yield* events.createCheckpoint(legacySessionID)).toMatchObject({
        aggregateID: legacySessionID,
        seq: 7,
      })
    }),
  )

  it.effect("matches final V2 content when legacy text and reasoning part IDs differ", () =>
    Effect.gen(function* () {
      expect(
        yield* legacyEvidenceCheckpoint({
          name: "independent_part_ids",
          role: "assistant",
          parts: [
            { id: "prt_v1_text", time: 4, data: { type: "text", text: "final text", time: { start: 4, end: 5 } } },
            {
              id: "prt_v1_reasoning",
              time: 4,
              data: { type: "reasoning", text: "final reasoning", time: { start: 4, end: 5 } },
            },
            {
              id: "prt_v1_tool",
              data: {
                type: "tool",
                callID: "call-v2-tool",
                tool: "shell",
                state: {
                  status: "completed",
                  input: { command: "pwd" },
                  output: "done",
                  title: "shell",
                  metadata: {},
                  time: { start: 6, end: 8 },
                },
              },
            },
          ],
          publish: (events, ids) =>
            Effect.gen(function* () {
              yield* events.publish(SessionEvent.Text.Started, {
                sessionID: ids.sessionID,
                timestamp: DateTime.makeUnsafe(4),
                assistantMessageID: ids.messageID,
                textID: "v2-text-fragment-id",
              })
              yield* events.publish(SessionEvent.Text.Ended, {
                sessionID: ids.sessionID,
                timestamp: DateTime.makeUnsafe(5),
                assistantMessageID: ids.messageID,
                textID: "v2-text-fragment-id",
                text: "final text",
              })
              yield* events.publish(SessionEvent.Reasoning.Started, {
                sessionID: ids.sessionID,
                timestamp: DateTime.makeUnsafe(4),
                assistantMessageID: ids.messageID,
                reasoningID: "v2-reasoning-fragment-id",
              })
              yield* events.publish(SessionEvent.Reasoning.Ended, {
                sessionID: ids.sessionID,
                timestamp: DateTime.makeUnsafe(5),
                assistantMessageID: ids.messageID,
                reasoningID: "v2-reasoning-fragment-id",
                text: "final reasoning",
              })
              yield* publishCompletedTool(events, ids, { callID: "call-v2-tool", command: "pwd", output: "done" })
            }),
        }),
      ).toMatchObject({ aggregateID: "ses_evidence_independent_part_ids" })
    }),
  )

  it.effect("does not reuse one final V2 text event for duplicate legacy parts", () =>
    Effect.gen(function* () {
      const rejected = yield* legacyEvidenceCheckpoint({
        name: "duplicate_text",
        role: "assistant",
        parts: [
          { id: "prt_duplicate_text_a", data: { type: "text", text: "one final value" } },
          { id: "prt_duplicate_text_b", data: { type: "text", text: "one final value" } },
        ],
        publish: (events, ids) =>
          Effect.gen(function* () {
            yield* events.publish(SessionEvent.Text.Started, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(4),
              assistantMessageID: ids.messageID,
              textID: "v2-only-once",
            })
            yield* events.publish(SessionEvent.Text.Ended, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(5),
              assistantMessageID: ids.messageID,
              textID: "v2-only-once",
              text: "one final value",
            })
          }),
      }).pipe(Effect.exit)
      expect(rejected._tag).toBe("Failure")
      expect(String(rejected)).toContain("legacyParts count differs")
      expect(String(rejected)).toContain("missing IDs")
    }),
  )

  it.effect("does not use an empty prompt as legacy part evidence", () =>
    Effect.gen(function* () {
      const rejected = yield* legacyEvidenceCheckpoint({
        name: "empty_prompt",
        role: "user",
        parts: [{ id: "prt_empty_prompt", data: { type: "text", text: "" } }],
        publish: (events, ids) =>
          events
            .publish(SessionEvent.Prompted, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(3),
              messageID: ids.messageID,
              prompt: new Prompt({ text: "" }),
              delivery: "steer",
            })
            .pipe(Effect.asVoid),
      }).pipe(Effect.exit)
      expect(rejected._tag).toBe("Failure")
      expect(String(rejected)).toContain("legacyParts count differs")
    }),
  )

  it.effect("accepts historical compaction without an overflow flag only with its bounded step", () =>
    legacyEvidenceCheckpoint({
      name: "compaction",
      role: "user",
      tailMessage: true,
      compactionAssistant: "msg_evidence_compaction_assistant",
      parts: [
        {
          id: "prt_compaction",
          time: 5,
          data: {
            type: "compaction",
            auto: true,
          },
        },
      ],
      publish: (events, ids) =>
        Effect.gen(function* () {
          yield* events.publish(SessionEvent.Prompted, {
            sessionID: ids.sessionID,
            timestamp: DateTime.makeUnsafe(3),
            messageID: ids.messageID,
            prompt: new Prompt({ text: "" }),
            delivery: "steer",
          })
          yield* events.publish(SessionEvent.Step.Started, {
            sessionID: ids.sessionID,
            timestamp: DateTime.makeUnsafe(4),
            assistantMessageID: SessionMessage.ID.make("msg_evidence_compaction_assistant"),
            agent: "compaction",
            model,
          })
        }),
    }).pipe(Effect.asVoid),
  )

  it.effect("accepts a manual historical compaction with exact prompt and step evidence", () =>
    legacyEvidenceCheckpoint({
      name: "manual_compaction",
      role: "user",
      tailMessage: true,
      compactionAssistant: "msg_evidence_manual_compaction_assistant",
      parts: [
        {
          id: "prt_manual_compaction",
          time: 5,
          data: {
            type: "compaction",
            auto: false,
          },
        },
      ],
      publish: (events, ids) =>
        Effect.gen(function* () {
          yield* events.publish(SessionEvent.Prompted, {
            sessionID: ids.sessionID,
            timestamp: DateTime.makeUnsafe(3),
            messageID: ids.messageID,
            prompt: new Prompt({ text: "" }),
            delivery: "steer",
          })
          yield* events.publish(SessionEvent.Step.Started, {
            sessionID: ids.sessionID,
            timestamp: DateTime.makeUnsafe(4),
            assistantMessageID: SessionMessage.ID.make("msg_evidence_manual_compaction_assistant"),
            agent: "compaction",
            model,
          })
        }),
    }).pipe(Effect.asVoid),
  )

  it.effect("rejects a historical compaction whose auto marker is not boolean", () =>
    Effect.gen(function* () {
      const rejected = yield* legacyEvidenceCheckpoint({
        name: "invalid_auto_compaction",
        role: "user",
        tailMessage: true,
        compactionAssistant: "msg_evidence_invalid_auto_compaction_assistant",
        parts: [
          {
            id: "prt_invalid_auto_compaction",
            time: 5,
            data: {
              type: "compaction",
              auto: "false",
            },
          },
        ],
        publish: (events, ids) =>
          Effect.gen(function* () {
            yield* events.publish(SessionEvent.Prompted, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(3),
              messageID: ids.messageID,
              prompt: new Prompt({ text: "" }),
              delivery: "steer",
            })
            yield* events.publish(SessionEvent.Step.Started, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(4),
              assistantMessageID: SessionMessage.ID.make("msg_evidence_invalid_auto_compaction_assistant"),
              agent: "compaction",
              model,
            })
          }),
      }).pipe(Effect.exit)
      expect(rejected._tag).toBe("Failure")
      expect(String(rejected)).toContain("violates its legacy schema")
    }),
  )

  it.effect("accepts a historical compaction part inserted 14ms after its prompt", () =>
    legacyEvidenceCheckpoint({
      name: "delayed_compaction_part",
      role: "user",
      tailMessage: true,
      compactionAssistant: "msg_evidence_delayed_compaction_assistant",
      parts: [
        {
          id: "prt_delayed_compaction_part",
          time: 17,
          data: {
            type: "compaction",
            auto: true,
            overflow: true,
            tail_start_id: "msg_evidence_tail_delayed_compaction_part",
          },
        },
      ],
      publish: (events, ids) =>
        Effect.gen(function* () {
          yield* events.publish(SessionEvent.Prompted, {
            sessionID: ids.sessionID,
            timestamp: DateTime.makeUnsafe(3),
            messageID: ids.messageID,
            prompt: new Prompt({ text: "" }),
            delivery: "steer",
          })
          yield* events.publish(SessionEvent.Step.Started, {
            sessionID: ids.sessionID,
            timestamp: DateTime.makeUnsafe(4),
            assistantMessageID: SessionMessage.ID.make("msg_evidence_delayed_compaction_assistant"),
            agent: "compaction",
            model,
          })
        }),
    }).pipe(Effect.asVoid),
  )

  it.effect("accepts a historical compaction inserted between its prompt and delayed child step", () =>
    legacyEvidenceCheckpoint({
      name: "pre_step_compaction_part",
      role: "user",
      tailMessage: true,
      compactionAssistant: "msg_evidence_pre_step_compaction_assistant",
      compactionAssistantTime: 326,
      parts: [
        {
          id: "prt_pre_step_compaction_part",
          time: 271,
          data: {
            type: "compaction",
            auto: true,
            overflow: false,
            tail_start_id: "msg_evidence_tail_pre_step_compaction_part",
          },
        },
      ],
      publish: (events, ids) =>
        Effect.gen(function* () {
          yield* events.publish(SessionEvent.Prompted, {
            sessionID: ids.sessionID,
            timestamp: DateTime.makeUnsafe(3),
            messageID: ids.messageID,
            prompt: new Prompt({ text: "" }),
            delivery: "steer",
          })
          yield* events.publish(SessionEvent.Step.Started, {
            sessionID: ids.sessionID,
            timestamp: DateTime.makeUnsafe(326),
            assistantMessageID: SessionMessage.ID.make("msg_evidence_pre_step_compaction_assistant"),
            agent: "compaction",
            model,
          })
        }),
    }).pipe(Effect.asVoid),
  )

  it.effect("accepts a compaction tail introduced by an earlier V2 step", () =>
    legacyEvidenceCheckpoint({
      name: "compaction_v2_tail",
      role: "user",
      tailMessage: true,
      tailV2Assistant: true,
      compactionAssistant: "msg_evidence_compaction_v2_tail_assistant",
      parts: [
        {
          id: "prt_compaction_v2_tail",
          time: 5,
          data: {
            type: "compaction",
            auto: true,
            overflow: true,
            tail_start_id: "msg_evidence_tail_compaction_v2_tail",
          },
        },
      ],
      publish: (events, ids) =>
        Effect.gen(function* () {
          yield* events.publish(SessionEvent.Prompted, {
            sessionID: ids.sessionID,
            timestamp: DateTime.makeUnsafe(3),
            messageID: ids.messageID,
            prompt: new Prompt({ text: "" }),
            delivery: "steer",
          })
          yield* events.publish(SessionEvent.Step.Started, {
            sessionID: ids.sessionID,
            timestamp: DateTime.makeUnsafe(4),
            assistantMessageID: SessionMessage.ID.make("msg_evidence_compaction_v2_tail_assistant"),
            agent: "compaction",
            model,
          })
        }),
    }).pipe(Effect.asVoid),
  )

  it.effect("rejects a compaction tail whose durable message event follows the compaction prompt", () =>
    Effect.gen(function* () {
      const result = yield* legacyEvidenceCheckpoint({
        name: "late_compaction_tail",
        role: "user",
        tailMessage: true,
        tailAfterPrompt: true,
        compactionAssistant: "msg_evidence_late_compaction_assistant",
        parts: [
          {
            id: "prt_late_compaction_tail",
            time: 5,
            data: {
              type: "compaction",
              auto: true,
              overflow: true,
              tail_start_id: "msg_evidence_tail_late_compaction_tail",
            },
          },
        ],
        publish: (events, ids) =>
          Effect.gen(function* () {
            yield* events.publish(SessionEvent.Prompted, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(3),
              messageID: ids.messageID,
              prompt: new Prompt({ text: "" }),
              delivery: "steer",
            })
            yield* events.publish(SessionEvent.Step.Started, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(4),
              assistantMessageID: SessionMessage.ID.make("msg_evidence_late_compaction_assistant"),
              agent: "compaction",
              model,
            })
          }),
      }).pipe(Effect.exit)
      expect(result._tag).toBe("Failure")
      expect(String(result)).toContain("Checkpoint-only legacy causality failed")
    }),
  )

  it.effect("rejects a compaction step whose assistant is not the prompt's child", () =>
    Effect.gen(function* () {
      const rejected = yield* legacyEvidenceCheckpoint({
        name: "unrelated_compaction",
        role: "user",
        tailMessage: true,
        parts: [
          {
            id: "prt_unrelated_compaction",
            time: 3,
            data: {
              type: "compaction",
              auto: true,
              overflow: true,
              tail_start_id: "msg_evidence_tail_unrelated_compaction",
            },
          },
        ],
        publish: (events, ids) =>
          Effect.gen(function* () {
            yield* events.publish(SessionEvent.Prompted, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(3),
              messageID: ids.messageID,
              prompt: new Prompt({ text: "" }),
              delivery: "steer",
            })
            yield* events.publish(SessionEvent.Step.Started, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(4),
              assistantMessageID: SessionMessage.ID.make("msg_unrelated_compaction_assistant"),
              agent: "compaction",
              model,
            })
          }),
      }).pipe(Effect.exit)
      expect(rejected._tag).toBe("Failure")
      expect(String(rejected)).toContain("Checkpoint-only legacy causality failed")
    }),
  )

  it.effect("rejects final V2 evidence older than the legacy part", () =>
    Effect.gen(function* () {
      const rejected = yield* legacyEvidenceCheckpoint({
        name: "future_text",
        role: "assistant",
        parts: [{ id: "prt_future_text", time: 10_000, data: { type: "text", text: "future row" } }],
        publish: (events, ids) =>
          Effect.gen(function* () {
            yield* events.publish(SessionEvent.Text.Started, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(4),
              assistantMessageID: ids.messageID,
              textID: "v2-past-fragment",
            })
            yield* events.publish(SessionEvent.Text.Ended, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(5),
              assistantMessageID: ids.messageID,
              textID: "v2-past-fragment",
              text: "future row",
            })
          }),
      }).pipe(Effect.exit)
      expect(rejected._tag).toBe("Failure")
      expect(String(rejected)).toContain("legacyParts count differs")
    }),
  )

  it.effect("rejects final V2 evidence too far after the legacy part", () =>
    Effect.gen(function* () {
      const rejected = yield* legacyEvidenceCheckpoint({
        name: "past_text",
        role: "assistant",
        parts: [
          {
            id: "prt_past_text",
            time: -100,
            data: { type: "text", text: "past row", time: { start: 4, end: 5 } },
          },
        ],
        publish: (events, ids) =>
          Effect.gen(function* () {
            yield* events.publish(SessionEvent.Text.Started, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(4),
              assistantMessageID: ids.messageID,
              textID: "v2-future-fragment",
            })
            yield* events.publish(SessionEvent.Text.Ended, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(5),
              assistantMessageID: ids.messageID,
              textID: "v2-future-fragment",
              text: "past row",
            })
          }),
      }).pipe(Effect.exit)
      expect(rejected._tag).toBe("Failure")
      expect(String(rejected)).toContain("legacyParts count differs")
    }),
  )

  // The production samples measured prompt projection up to 1,084ms, step-start +965..6,498ms, patch up to 327ms
  // before step-end, step-finish -1,233..-139ms, and tool insertion up to 429,191ms before input-start. These cases guard both sides
  // of every widened compatibility window rather than accepting a global one-way clock drift.
  for (const time of [-8, 2_004])
    it.effect(`rejects prompt insertion time ${time} outside its bidirectional window`, () =>
      Effect.gen(function* () {
        const rejected = yield* legacyEvidenceCheckpoint({
          name: `prompt_time_${time}`,
          role: "user",
          parts: [{ id: `prt_prompt_time_${time}`, time, data: { type: "text", text: "bounded prompt" } }],
          publish: (events, ids) =>
            events
              .publish(SessionEvent.Prompted, {
                sessionID: ids.sessionID,
                timestamp: DateTime.makeUnsafe(3),
                messageID: ids.messageID,
                prompt: new Prompt({ text: "bounded prompt" }),
                delivery: "steer",
              })
              .pipe(Effect.asVoid),
        }).pipe(Effect.exit)
        expect(rejected._tag).toBe("Failure")
        expect(String(rejected)).toContain("legacyParts count differs")
      }),
    )

  it.effect("preserves a bounded historical prompt composition with checkpoint-owned text fields", () =>
    Effect.gen(function* () {
      const result = yield* legacyEvidenceCheckpoint({
        name: "prompt_composition",
        role: "user",
        parts: [
          { id: "prt_prompt_1_plain", time: 3, data: { type: "text", text: "plain prompt" } },
          {
            id: "prt_prompt_2_context",
            time: 18,
            data: {
              type: "text",
              text: "synthetic context",
              synthetic: true,
              time: { start: 18, end: 18 },
            },
          },
        ],
        publish: (events, ids) =>
          events
            .publish(SessionEvent.Prompted, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(3),
              messageID: ids.messageID,
              prompt: new Prompt({ text: "plain prompt\n\nsynthetic context" }),
              delivery: "steer",
            })
            .pipe(Effect.asVoid),
      }).pipe(Effect.exit)
      expect(result._tag).toBe("Success")
      expect(JSON.stringify(result)).toContain('"partID":"prt_prompt_2_context"')
    }),
  )

  it.effect("rejects a prompt part whose stored time does not match its row", () =>
    Effect.gen(function* () {
      const rejected = yield* legacyEvidenceCheckpoint({
        name: "prompt_stored_time",
        role: "user",
        parts: [
          {
            id: "prt_prompt_stored_time",
            time: 3,
            data: { type: "text", text: "bounded prompt", synthetic: true, time: { start: 4, end: 4 } },
          },
        ],
        publish: (events, ids) =>
          events
            .publish(SessionEvent.Prompted, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(3),
              messageID: ids.messageID,
              prompt: new Prompt({ text: "bounded prompt" }),
              delivery: "steer",
            })
            .pipe(Effect.asVoid),
      }).pipe(Effect.exit)
      expect(rejected._tag).toBe("Failure")
      expect(String(rejected)).toContain("Checkpoint-only legacy causality failed")
    }),
  )

  for (const time of [-8, 7_004])
    it.effect(`rejects step-start insertion time ${time} outside its bidirectional window`, () =>
      Effect.gen(function* () {
        const rejected = yield* legacyEvidenceCheckpoint({
          name: `step_start_time_${time}`,
          role: "assistant",
          parts: [{ id: `prt_step_start_time_${time}`, time, data: { type: "step-start" } }],
          publish: () => Effect.void,
        }).pipe(Effect.exit)
        expect(rejected._tag).toBe("Failure")
        expect(String(rejected)).toContain("legacyParts count differs")
      }),
    )

  it.effect("preserves a delayed step-start inserted before its first durable child", () =>
    legacyEvidenceCheckpoint({
      name: "delayed_step_start",
      role: "assistant",
      assistantSnapshot: "delayed-snapshot",
      parts: [
        {
          id: "prt_delayed_step_start",
          time: 14_000,
          data: { type: "step-start", snapshot: "delayed-snapshot" },
        },
      ],
      publish: (events, ids) =>
        Effect.gen(function* () {
          yield* events.publish(SessionEvent.Reasoning.Started, {
            sessionID: ids.sessionID,
            timestamp: DateTime.makeUnsafe(16_000),
            assistantMessageID: ids.messageID,
            reasoningID: "reasoning-after-delayed-step-start",
          })
          yield* events.publish(SessionEvent.Reasoning.Ended, {
            sessionID: ids.sessionID,
            timestamp: DateTime.makeUnsafe(16_001),
            assistantMessageID: ids.messageID,
            reasoningID: "reasoning-after-delayed-step-start",
            text: "verified child",
          })
        }),
    }),
  )

  for (const time of [-1_492, 20])
    it.effect(`rejects step-finish insertion time ${time} outside its bidirectional window`, () =>
      Effect.gen(function* () {
        const rejected = yield* legacyEvidenceCheckpoint({
          name: `step_finish_time_${time}`,
          role: "assistant",
          parts: [
            {
              id: `prt_step_finish_time_${time}`,
              time,
              data: {
                type: "step-finish",
                reason: "stop",
                cost: 0,
                tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              },
            },
          ],
          publish: () => Effect.void,
        }).pipe(Effect.exit)
        expect(rejected._tag).toBe("Failure")
        expect(String(rejected)).toContain("legacyParts count differs")
      }),
    )

  it.effect("preserves a patch snapshot written 327 ms before an interrupted step settles", () =>
    legacyEvidenceCheckpoint({
      name: "patch_before_interrupted_step",
      role: "assistant",
      assistantSnapshot: "hash",
      stepEndTime: 1_000,
      parts: [
        {
          id: "prt_patch_before_interrupted_step",
          time: 673,
          data: { type: "patch", hash: "hash", files: ["C:/project/a.ts"] },
        },
      ],
      publish: () => Effect.void,
    }),
  )

  it.effect("preserves a validated patch written at a historical step without a snapshot", () =>
    legacyEvidenceCheckpoint({
      name: "patch_without_step_snapshot",
      role: "assistant",
      parts: [
        {
          id: "prt_patch_without_step_snapshot",
          time: 7,
          data: { type: "patch", hash: "historical-hash", files: ["C:/project/a.ts"] },
        },
      ],
      publish: () => Effect.void,
    }),
  )

  it.effect("rejects a patch whose hash conflicts with a recorded step snapshot", () =>
    Effect.gen(function* () {
      const rejected = yield* legacyEvidenceCheckpoint({
        name: "patch_mismatched_step_snapshot",
        role: "assistant",
        assistantSnapshot: "recorded-hash",
        parts: [
          {
            id: "prt_patch_mismatched_step_snapshot",
            time: 7,
            data: { type: "patch", hash: "different-hash", files: ["C:/project/a.ts"] },
          },
        ],
        publish: () => Effect.void,
      }).pipe(Effect.exit)
      expect(rejected._tag).toBe("Failure")
      expect(String(rejected)).toContain("Checkpoint-only legacy causality failed")
    }),
  )

  for (const time of [-492, 11])
    it.effect(`rejects patch insertion time ${time} outside its bidirectional window`, () =>
      Effect.gen(function* () {
        const rejected = yield* legacyEvidenceCheckpoint({
          name: `patch_time_${time}`,
          role: "assistant",
          assistantSnapshot: "hash",
          parts: [
            {
              id: `prt_patch_time_${time}`,
              time,
              data: { type: "patch", hash: "hash", files: ["C:/project/a.ts"] },
            },
          ],
          publish: () => Effect.void,
        }).pipe(Effect.exit)
        expect(rejected._tag).toBe("Failure")
        expect(String(rejected)).toContain("Checkpoint-only legacy causality failed")
      }),
    )

  for (const time of [-599_995, 17])
    it.effect(`rejects tool insertion time ${time} outside its bidirectional window`, () =>
      Effect.gen(function* () {
        const rejected = yield* legacyEvidenceCheckpoint({
          name: `tool_time_window_${time}`,
          role: "assistant",
          parts: [
            {
              id: `prt_tool_time_window_${time}`,
              time,
              data: {
                type: "tool",
                callID: `call-tool-window-${time}`,
                tool: "shell",
                state: {
                  status: "completed",
                  input: { command: "pwd" },
                  output: "done",
                  title: "shell",
                  metadata: {},
                  time: { start: 6, end: 8 },
                },
              },
            },
          ],
          publish: (events, ids) =>
            publishCompletedTool(events, ids, {
              callID: `call-tool-window-${time}`,
              command: "pwd",
              output: "done",
            }),
        }).pipe(Effect.exit)
        expect(rejected._tag).toBe("Failure")
        expect(String(rejected)).toContain("legacyParts count differs")
      }),
    )

  for (const scenario of [
    { time: 4, checkpoint: false, accepted: true },
    { time: -8, checkpoint: false, accepted: false },
    { time: 800_000, checkpoint: true, accepted: true },
  ] as const)
    it.effect(`${scenario.accepted ? "preserves" : "rejects"} a tool created during a long provider step at ${scenario.time}`, () =>
      Effect.gen(function* () {
        const result = yield* legacyEvidenceCheckpoint({
          name: `tool_long_provider_step_${scenario.time}`,
          role: "assistant",
          stepEndTime: 700_009,
          parts: [
            {
              id: `prt_tool_long_provider_step_${scenario.time}`,
              time: scenario.time,
              updated: 700_008,
              data: {
                type: "tool",
                callID: `call-tool-long-provider-step-${scenario.time}`,
                tool: "shell",
                ...(scenario.checkpoint
                  ? { metadata: { openai: { itemId: `item-tool-long-provider-step-${scenario.time}` } } }
                  : {}),
                state: {
                  status: "completed",
                  input: { command: "pwd" },
                  output: "done",
                  title: "shell",
                  metadata: {},
                  time: { start: 700_006, end: 700_008 },
                },
              },
            },
          ],
          publish: (events, ids) =>
            publishCompletedTool(events, ids, {
              callID: `call-tool-long-provider-step-${scenario.time}`,
              command: "pwd",
              output: "done",
              start: 700_006,
              end: 700_008,
            }),
        }).pipe(Effect.exit)
        expect(result._tag).toBe(scenario.accepted ? "Success" : "Failure")
      }),
    )

  for (const matching of [true, false])
    it.effect(`${matching ? "preserves" : "rejects mismatched"} externalized legacy and V2 tool output references`, () =>
      Effect.gen(function* () {
        const reference = {
          type: "content-reference",
          uri: "attachment://att_11111111111111111111111111111111",
          mime: "text/plain",
          sizeBytes: 60_000,
        }
        const structuredReference = {
          type: "content-reference",
          uri: "attachment://att_44444444444444444444444444444444",
          mime: "application/json",
          sizeBytes: 320_000,
          preview: '{"command":"large-output",...}',
        }
        const result = yield* legacyEvidenceCheckpoint({
          name: `tool_externalized_event_${matching}`,
          role: "assistant",
          parts: [
            {
              id: `prt_tool_externalized_event_${matching}`,
              time: 4,
              data: {
                type: "tool",
                callID: `call-tool-externalized-event-${matching}`,
                tool: "shell",
                metadata: { openai: { itemId: `item-tool-externalized-event-${matching}` } },
                state: {
                  status: "completed",
                  input: { command: "large-output" },
                  output: "bounded output preview",
                  title: "shell",
                  metadata: {
                    $opencode: {
                      ...structuredReference,
                      output: {
                        ...reference,
                        ...(matching ? {} : { uri: "attachment://att_22222222222222222222222222222222" }),
                      },
                    },
                  },
                  time: { start: 6, end: 8 },
                },
              },
            },
          ],
          publish: (events, ids) =>
            Effect.gen(function* () {
              yield* events.publish(SessionEvent.Tool.Input.Started, {
                sessionID: ids.sessionID,
                timestamp: DateTime.makeUnsafe(6),
                assistantMessageID: ids.messageID,
                callID: `call-tool-externalized-event-${matching}`,
                name: "shell",
              })
              yield* events.publish(SessionEvent.Tool.Input.Ended, {
                sessionID: ids.sessionID,
                timestamp: DateTime.makeUnsafe(6),
                assistantMessageID: ids.messageID,
                callID: `call-tool-externalized-event-${matching}`,
                text: JSON.stringify({ command: "large-output" }),
              })
              yield* events.publish(SessionEvent.Tool.Called, {
                sessionID: ids.sessionID,
                timestamp: DateTime.makeUnsafe(6),
                assistantMessageID: ids.messageID,
                callID: `call-tool-externalized-event-${matching}`,
                tool: "shell",
                input: { command: "large-output" },
                provider: { executed: false },
              })
              yield* events.publish(SessionEvent.Tool.Success, {
                sessionID: ids.sessionID,
                timestamp: DateTime.makeUnsafe(8),
                assistantMessageID: ids.messageID,
                callID: `call-tool-externalized-event-${matching}`,
                structured: {
                  $opencode: {
                    ...structuredReference,
                    text: reference,
                    result: {
                      ...reference,
                      uri: "attachment://att_33333333333333333333333333333333",
                    },
                  },
                },
                content: [{ type: "text", text: "bounded output preview" }],
                result: { type: "text", value: "bounded output preview" },
                provider: { executed: false },
              })
            }),
        }).pipe(Effect.exit)
        expect(result._tag).toBe(matching ? "Success" : "Failure")
        if (!matching) expect(String(result)).toContain("Checkpoint-only legacy causality failed")
      }),
    )

  it.effect("preserves a full legacy tool output when only its V2 event was externalized", () =>
    Effect.gen(function* () {
      const output = "read output line\n".repeat(900).slice(0, 12_987)
      const preview = boundedPersistedContentPreview(output)
      const reference = {
        type: "content-reference",
        uri: "attachment://att_55555555555555555555555555555555",
        mime: "text/plain",
        sizeBytes: Buffer.byteLength(output, "utf8"),
      }
      const metadata = { preview: preview.slice(0, 1_000), loaded: [], linesReturned: 200, totalLines: 900 }
      const result = yield* legacyEvidenceCheckpoint({
        name: "tool_event_externalized_only",
        role: "assistant",
        parts: [
          {
            id: "prt_tool_event_externalized_only",
            time: 4,
            data: {
              type: "tool",
              callID: "call-tool-event-externalized-only",
              tool: "read",
              metadata: { providerExecuted: true },
              state: {
                status: "completed",
                input: { filePath: "/tmp/large.txt" },
                output,
                title: "/tmp/large.txt (200/900 lines)",
                metadata,
                time: { start: 6, end: 8 },
              },
            },
          },
        ],
        publish: (events, ids) =>
          publishCompletedTool(events, ids, {
            callID: "call-tool-event-externalized-only",
            tool: "read",
            toolInput: { filePath: "/tmp/large.txt" },
            output,
            eventOutput: preview,
            structured: { ...metadata, $opencode: { text: reference, result: reference } },
            start: 6,
            end: 8,
          }),
      }).pipe(Effect.exit)
      expect(result._tag).toBe("Success")
    }),
  )

  for (const field of ["metadata", "time"] as const)
    it.effect(`${field === "metadata" ? "preserves checkpoint-only" : "rejects unchecked"} legacy text ${field}`, () =>
      Effect.gen(function* () {
        const result = yield* legacyEvidenceCheckpoint({
          name: `text_${field}`,
          role: "assistant",
          parts: [
            {
              id: `prt_text_${field}`,
              time: 4,
              data: {
                type: "text",
                text: "checked text",
                time: { start: 4, end: field === "time" ? 6 : 5 },
                ...(field === "metadata" ? { metadata: { unchecked: true } } : {}),
              },
            },
          ],
          publish: (events, ids) =>
            Effect.gen(function* () {
              yield* events.publish(SessionEvent.Text.Started, {
                sessionID: ids.sessionID,
                timestamp: DateTime.makeUnsafe(4),
                assistantMessageID: ids.messageID,
                textID: `text-${field}`,
              })
              yield* events.publish(SessionEvent.Text.Ended, {
                sessionID: ids.sessionID,
                timestamp: DateTime.makeUnsafe(5),
                assistantMessageID: ids.messageID,
                textID: `text-${field}`,
                text: "checked text",
              })
            }),
        }).pipe(Effect.exit)
        if (field === "metadata") {
          expect(result._tag).toBe("Success")
          expect(JSON.stringify(result)).toContain(`\"partID\":\"prt_text_${field}\"`)
          return
        }
        expect(result._tag).toBe("Failure")
        expect(String(result)).toContain("legacyParts count differs")
      }),
    )

  for (const valid of [true, false])
    it.effect(`${valid ? "preserves" : "rejects malformed"} checkpoint-owned OpenRouter tool provenance`, () =>
      Effect.gen(function* () {
        const result = yield* legacyEvidenceCheckpoint({
          name: `tool_openrouter_metadata_${valid}`,
          role: "assistant",
          parts: [
            {
              id: `prt_tool_openrouter_metadata_${valid}`,
              time: 4,
              data: {
                type: "tool",
                callID: `call-tool-openrouter-metadata-${valid}`,
                tool: "shell",
                metadata: {
                  openrouter: {
                    reasoning_details: valid
                      ? [{ type: "reasoning.text", text: "verified reasoning", format: "unknown", index: 0 }]
                      : [{ type: "reasoning.text", text: "unchecked", format: "unknown", index: "0" }],
                  },
                },
                state: {
                  status: "completed",
                  input: { command: "pwd" },
                  output: "done",
                  title: "shell",
                  metadata: {},
                  time: { start: 6, end: 8 },
                },
              },
            },
          ],
          publish: (events, ids) =>
            publishCompletedTool(events, ids, {
              callID: `call-tool-openrouter-metadata-${valid}`,
              command: "pwd",
              output: "done",
            }),
        }).pipe(Effect.exit)
        expect(result._tag).toBe(valid ? "Success" : "Failure")
        if (!valid) expect(String(result)).toContain("Checkpoint-only legacy causality failed")
      }),
    )

  for (const valid of [true, false])
    it.effect(`${valid ? "preserves" : "rejects malformed"} checkpoint-owned provider-executed provenance`, () =>
      Effect.gen(function* () {
        const result = yield* legacyEvidenceCheckpoint({
          name: `tool_provider_executed_metadata_${valid}`,
          role: "assistant",
          parts: [
            {
              id: `prt_tool_provider_executed_metadata_${valid}`,
              time: 4,
              data: {
                type: "tool",
                callID: `call-tool-provider-executed-metadata-${valid}`,
                tool: "shell",
                metadata: { providerExecuted: valid },
                state: {
                  status: "completed",
                  input: { command: "pwd" },
                  output: "done",
                  title: "shell",
                  metadata: {},
                  time: { start: 6, end: 8 },
                },
              },
            },
          ],
          publish: (events, ids) =>
            publishCompletedTool(events, ids, {
              callID: `call-tool-provider-executed-metadata-${valid}`,
              command: "pwd",
              output: "done",
            }),
        }).pipe(Effect.exit)
        expect(result._tag).toBe(valid ? "Success" : "Failure")
        if (!valid) expect(String(result)).toContain("Checkpoint-only legacy causality failed")
      }),
    )

  it.effect("preserves an event-backed empty text whose checkpoint omits its end time", () =>
    Effect.gen(function* () {
      const result = yield* legacyEvidenceCheckpoint({
        name: "empty_text_end",
        role: "assistant",
        parts: [
          {
            id: "prt_empty_text_end",
            time: 4,
            data: { type: "text", text: "", time: { start: 4 }, metadata: { checkpoint: true } },
          },
        ],
        publish: (events, ids) =>
          Effect.gen(function* () {
            yield* events.publish(SessionEvent.Text.Started, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(4),
              assistantMessageID: ids.messageID,
              textID: "prt_empty_text_end",
            })
            yield* events.publish(SessionEvent.Text.Ended, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(5),
              assistantMessageID: ids.messageID,
              textID: "prt_empty_text_end",
              text: "",
            })
          }),
      }).pipe(Effect.exit)
      expect(result._tag).toBe("Success")
      expect(JSON.stringify(result)).toContain('"partID":"prt_empty_text_end"')
    }),
  )

  it.effect("preserves a schema-valid synthetic flag only through checkpoint provenance", () =>
    Effect.gen(function* () {
      const result = yield* legacyEvidenceCheckpoint({
        name: "synthetic_text",
        role: "user",
        parts: [
          {
            id: "prt_synthetic_text",
            time: 3,
            data: { type: "text", text: "synthetic context", synthetic: true },
          },
        ],
        publish: (events, ids) =>
          events
            .publish(SessionEvent.Prompted, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(3),
              messageID: ids.messageID,
              prompt: new Prompt({ text: "synthetic context" }),
              delivery: "steer",
            })
            .pipe(Effect.asVoid),
      }).pipe(Effect.exit)
      expect(result._tag).toBe("Success")
      expect(JSON.stringify(result)).toContain("\"partID\":\"prt_synthetic_text\"")
    }),
  )

  it.effect("rejects a checkpoint-only part whose final lifecycle event removed it", () =>
    Effect.gen(function* () {
      const removedSessionID = SessionV2.ID.make("ses_evidence_removed_checkpoint_only")
      const removedMessageID = SessionV1.MessageID.make("msg_evidence_root_removed_checkpoint_only")
      const removedPartID = SessionV1.PartID.make("prt_removed_checkpoint_only")
      const checkpoint = yield* legacyEvidenceCheckpoint({
        name: "removed_checkpoint_only",
        role: "user",
        parts: [
          {
            id: removedPartID,
            time: 3,
            data: { type: "text", text: "must stay deleted", synthetic: true },
          },
        ],
        publish: (events, ids) =>
          events
            .publish(SessionV1.Event.PartUpdated, {
              sessionID: ids.sessionID,
              part: {
                id: removedPartID,
                sessionID: ids.sessionID,
                messageID: removedMessageID,
                type: "text",
                text: "must stay deleted",
                synthetic: true,
              },
              time: 3,
            })
            .pipe(Effect.asVoid),
      })
      if (!checkpoint) return yield* Effect.die("Expected checkpoint-only baseline")
      const events = yield* EventV2.Service
      yield* events.publish(SessionV1.Event.PartRemoved, {
        sessionID: removedSessionID,
        messageID: removedMessageID,
        partID: removedPartID,
      })
      const { db } = yield* Database.Service
      const removed = yield* db.select().from(PartTable).where(eq(PartTable.id, removedPartID)).get().pipe(Effect.orDie)
      expect(removed).toBeUndefined()
      const tail = (yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, checkpoint.aggregateID))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)).map((event) => ({
        id: event.id,
        aggregateID: event.aggregate_id,
        seq: event.seq,
        type: event.type,
        data: EventV2.decodeStoredEventData(event.data),
      }))
      const result = yield* SessionProjector.verifyProjectionInFreshRuntime({
        aggregateID: checkpoint.aggregateID,
        expected: checkpoint.baseline,
        events: tail,
      }).pipe(Effect.exit)
      expect(result._tag).toBe("Failure")
      expect(String(result)).toContain("Checkpoint-only legacy causality failed")
    }),
  )

  it.effect("rejects a checkpoint-only row whose exact bytes no longer match its provenance digest", () =>
    Effect.gen(function* () {
      const checkpoint = yield* legacyEvidenceCheckpoint({
        name: "tampered_checkpoint_only",
        role: "user",
        parts: [
          {
            id: "prt_tampered_checkpoint_only",
            time: 3,
            data: { type: "text", text: "stable", synthetic: true },
          },
        ],
        publish: (events, ids) =>
          events
            .publish(SessionEvent.Prompted, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(3),
              messageID: ids.messageID,
              prompt: new Prompt({ text: "stable" }),
              delivery: "steer",
            })
            .pipe(Effect.asVoid),
      })
      if (!checkpoint) return yield* Effect.die("Expected checkpoint-only baseline")
      const baseline = structuredClone(checkpoint.baseline)
      const parts = baseline.data.legacyParts as Array<{ data: Record<string, unknown> }>
      parts[0]!.data.synthetic = false
      const { db } = yield* Database.Service
      const tail = (yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, checkpoint.aggregateID))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)).map((event) => ({
        id: event.id,
        aggregateID: event.aggregate_id,
        seq: event.seq,
        type: event.type,
        data: EventV2.decodeStoredEventData(event.data),
      }))
      const result = yield* SessionProjector.verifyProjectionInFreshRuntime({
        aggregateID: checkpoint.aggregateID,
        expected: baseline,
        events: tail,
      }).pipe(Effect.exit)
      expect(result._tag).toBe("Failure")
      expect(String(result)).toContain("checkpoint-only legacy row prt_tampered_checkpoint_only digest differs")
    }),
  )

  it.effect("preserves checkpoint-only legacy reasoning metadata", () =>
    Effect.gen(function* () {
      const result = yield* legacyEvidenceCheckpoint({
        name: "reasoning_metadata",
        role: "assistant",
        parts: [
          {
            id: "prt_reasoning_metadata",
            time: 4,
            data: {
              type: "reasoning",
              text: "checked reasoning",
              time: { start: 4, end: 5 },
              metadata: { unchecked: true },
            },
          },
        ],
        publish: (events, ids) =>
          Effect.gen(function* () {
            yield* events.publish(SessionEvent.Reasoning.Started, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(4),
              assistantMessageID: ids.messageID,
              reasoningID: "reasoning-metadata",
            })
            yield* events.publish(SessionEvent.Reasoning.Ended, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(5),
              assistantMessageID: ids.messageID,
              reasoningID: "reasoning-metadata",
              text: "checked reasoning",
            })
          }),
      }).pipe(Effect.exit)
      expect(result._tag).toBe("Success")
      expect(JSON.stringify(result)).toContain("\"partID\":\"prt_reasoning_metadata\"")
    }),
  )

  for (const [delay, accepted] of [
    [51, true],
    [61, false],
  ] as const)
    it.effect(`${accepted ? "preserves" : "rejects"} checkpoint-only reasoning inserted ${delay}ms after its start event`, () =>
      Effect.gen(function* () {
        const result = yield* legacyEvidenceCheckpoint({
          name: `reasoning_insert_delay_${delay}`,
          role: "assistant",
          parts: [
            {
              id: `prt_reasoning_insert_delay_${delay}`,
              time: 4 + delay,
              updated: 71,
              data: {
                type: "reasoning",
                text: "delayed reasoning",
                time: { start: 4, end: 70 },
                metadata: { openai: { itemId: `rs_reasoning_insert_delay_${delay}` } },
              },
            },
          ],
          publish: (events, ids) =>
            Effect.gen(function* () {
              yield* events.publish(SessionEvent.Reasoning.Started, {
                sessionID: ids.sessionID,
                timestamp: DateTime.makeUnsafe(4),
                assistantMessageID: ids.messageID,
                reasoningID: `reasoning-insert-delay-${delay}`,
              })
              yield* events.publish(SessionEvent.Reasoning.Ended, {
                sessionID: ids.sessionID,
                timestamp: DateTime.makeUnsafe(70),
                assistantMessageID: ids.messageID,
                reasoningID: `reasoning-insert-delay-${delay}`,
                text: "delayed reasoning",
              })
            }),
        }).pipe(Effect.exit)
        expect(result._tag).toBe(accepted ? "Success" : "Failure")
      }),
    )

  it.effect("rejects a legacy step total not derived from its V2 usage", () =>
    Effect.gen(function* () {
      const rejected = yield* legacyEvidenceCheckpoint({
        name: "step_total",
        role: "assistant",
        parts: [
          {
            id: "prt_step_total",
            time: 8,
            data: {
              type: "step-finish",
              reason: "stop",
              cost: 0,
              tokens: { total: 1, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            },
          },
        ],
        publish: () => Effect.void,
      }).pipe(Effect.exit)
      expect(rejected._tag).toBe("Failure")
      expect(String(rejected)).toContain("legacyParts count differs")
    }),
  )

  for (const files of [["relative.ts"], ["C:/z.ts", "C:/a.ts"], ["C:/a.ts", "C:/a.ts"]])
    it.effect(`preserves checkpoint-only patch files without claiming event provenance (${files.join(",")})`, () =>
      Effect.gen(function* () {
        const result = yield* legacyEvidenceCheckpoint({
          name: `patch_${files.join("_").replaceAll(/[^a-z]/gi, "")}`,
          role: "assistant",
          assistantSnapshot: "hash",
          parts: [
            { id: `prt_patch_${files.length}_${files[0]}`, time: 8, data: { type: "patch", hash: "hash", files } },
          ],
          publish: () => Effect.void,
        }).pipe(Effect.exit)
        expect(result._tag).toBe("Success")
        expect(JSON.stringify(result)).toContain(`\"partID\":\"prt_patch_${files.length}_${files[0]}\"`)
      }),
    )

  for (const source of [
    { type: "file", path: "/project/a.ts", text: { value: "x", start: 0, end: 1 } },
    {
      type: "symbol",
      path: "/project/a.ts",
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      name: "x",
      kind: 1,
      text: { value: "x", start: 0, end: 1 },
    },
    { type: "resource", clientName: "mcp", uri: "resource://a", text: { value: "x", start: 0, end: 1 } },
  ])
    it.effect(`preserves a checkpoint-only legacy ${source.type} source that Prompted cannot reconstruct`, () =>
      Effect.gen(function* () {
        const result = yield* legacyEvidenceCheckpoint({
          name: `file_source_${source.type}`,
          role: "user",
          parts: [
            {
              id: `prt_file_source_${source.type}`,
              time: 3,
              data: { type: "file", mime: "text/plain", filename: "a.ts", url: "file:///project/a.ts", source },
            },
          ],
          publish: (events, ids) =>
            events
              .publish(SessionEvent.Prompted, {
                sessionID: ids.sessionID,
                timestamp: DateTime.makeUnsafe(3),
                messageID: ids.messageID,
                prompt: new Prompt({
                  text: "",
                  files: [new FileAttachment({ uri: "file:///project/a.ts", mime: "text/plain", name: "a.ts" })],
                }),
                delivery: "steer",
              })
              .pipe(Effect.asVoid),
        }).pipe(Effect.exit)
        expect(result._tag).toBe("Success")
        expect(JSON.stringify(result)).toContain(`\"partID\":\"prt_file_source_${source.type}\"`)
      }),
    )

  for (const field of ["time", "compacted"] as const)
    it.effect(`rejects unchecked legacy tool ${field}`, () =>
      Effect.gen(function* () {
        const rejected = yield* legacyEvidenceCheckpoint({
          name: `tool_${field}`,
          role: "assistant",
          parts: [
            {
              id: `prt_tool_${field}`,
              time: 6,
              data: {
                type: "tool",
                callID: `call-tool-${field}`,
                tool: "shell",
                state: {
                  status: "completed",
                  input: { command: "pwd" },
                  output: "done",
                  title: "shell",
                  metadata: {},
                  time: { start: 6, end: field === "time" ? 7 : 8, ...(field === "compacted" ? { compacted: 7 } : {}) },
                },
              },
            },
          ],
          publish: (events, ids) =>
            publishCompletedTool(events, ids, { callID: `call-tool-${field}`, command: "pwd", output: "done" }),
        }).pipe(Effect.exit)
        expect(rejected._tag).toBe("Failure")
        expect(String(rejected)).toContain("legacyParts count differs")
      }),
    )

  it.effect("preserves a tool compacted after the first post-compaction turn settles", () =>
    Effect.gen(function* () {
      const result = yield* legacyEvidenceCheckpoint({
        name: "tool_compaction_settlement",
        role: "assistant",
        parts: [
          {
            id: "prt_tool_compaction_settlement",
            time: 6,
            updated: 23,
            data: {
              type: "tool",
              callID: "call-tool-compaction-settlement",
              tool: "shell",
              metadata: { openai: { itemId: "item-tool-compaction-settlement" } },
              state: {
                status: "completed",
                input: { command: "pwd" },
                output: "done",
                title: "shell",
                metadata: {},
                time: { start: 6, end: 8, compacted: 20 },
              },
            },
          },
        ],
        publish: (events, ids) =>
          Effect.gen(function* () {
            yield* publishCompletedTool(events, ids, {
              callID: "call-tool-compaction-settlement",
              command: "pwd",
              output: "done",
            })
            yield* events.publish(SessionEvent.Prompted, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(10),
              messageID: SessionMessage.ID.make("msg_tool_compaction_prompt"),
              prompt: new Prompt({ text: "" }),
              delivery: "steer",
            })
            yield* events.publish(SessionEvent.Step.Started, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(11),
              assistantMessageID: SessionMessage.ID.make("msg_tool_compaction_assistant"),
              agent: "compaction",
              model,
            })
            yield* events.publish(SessionEvent.Step.Ended, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(15),
              assistantMessageID: SessionMessage.ID.make("msg_tool_compaction_assistant"),
              finish: "stop",
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            })
            yield* events.publish(SessionEvent.Prompted, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(16),
              messageID: SessionMessage.ID.make("msg_tool_post_compaction_prompt"),
              prompt: new Prompt({ text: "continue" }),
              delivery: "steer",
            })
            yield* events.publish(SessionEvent.Step.Started, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(17),
              assistantMessageID: SessionMessage.ID.make("msg_tool_post_compaction_assistant"),
              agent: "build",
              model,
            })
            yield* events.publish(SessionEvent.Step.Ended, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(19),
              assistantMessageID: SessionMessage.ID.make("msg_tool_post_compaction_assistant"),
              finish: "stop",
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            })
          }),
      }).pipe(Effect.exit)
      expect(result._tag).toBe("Success")
      expect(JSON.stringify(result)).toContain('"compacted":20')
    }),
  )

  for (const scenario of [
    { name: "directly_after", compacted: 16, accepted: true },
    { name: "before_step_end", compacted: 14, accepted: false },
    { name: "after_bound", compacted: 1_016, accepted: false },
  ] as const)
    it.effect(`${scenario.accepted ? "preserves" : "rejects"} a tool compacted ${scenario.name} the compaction agent settlement`, () =>
      Effect.gen(function* () {
        const result = yield* legacyEvidenceCheckpoint({
          name: `tool_compaction_agent_${scenario.name}`,
          role: "assistant",
          parts: [
            {
              id: `prt_tool_compaction_agent_${scenario.name}`,
              time: 6,
              updated: scenario.compacted,
              data: {
                type: "tool",
                callID: `call-tool-compaction-agent-${scenario.name}`,
                tool: "shell",
                metadata: { openai: { itemId: `item-tool-compaction-agent-${scenario.name}` } },
                state: {
                  status: "completed",
                  input: { command: "pwd" },
                  output: "done",
                  title: "shell",
                  metadata: {},
                  time: { start: 6, end: 8, compacted: scenario.compacted },
                },
              },
            },
          ],
          publish: (events, ids) =>
            Effect.gen(function* () {
              yield* publishCompletedTool(events, ids, {
                callID: `call-tool-compaction-agent-${scenario.name}`,
                command: "pwd",
                output: "done",
              })
              yield* events.publish(SessionEvent.Prompted, {
                sessionID: ids.sessionID,
                timestamp: DateTime.makeUnsafe(10),
                messageID: SessionMessage.ID.make(`msg_tool_compaction_agent_prompt_${scenario.name}`),
                prompt: new Prompt({ text: "" }),
                delivery: "steer",
              })
              yield* events.publish(SessionEvent.Step.Started, {
                sessionID: ids.sessionID,
                timestamp: DateTime.makeUnsafe(11),
                assistantMessageID: SessionMessage.ID.make(`msg_tool_compaction_agent_assistant_${scenario.name}`),
                agent: "compaction",
                model,
              })
              yield* events.publish(SessionEvent.Step.Ended, {
                sessionID: ids.sessionID,
                timestamp: DateTime.makeUnsafe(15),
                assistantMessageID: SessionMessage.ID.make(`msg_tool_compaction_agent_assistant_${scenario.name}`),
                finish: "stop",
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              })
            }),
        }).pipe(Effect.exit)
        expect(result._tag).toBe(scenario.accepted ? "Success" : "Failure")
      }),
    )

  for (const scenario of [
    { name: "bounded", compacted: 2_000, updated: 2_005, pending: false, nextPrompt: true, accepted: true },
    { name: "final_batched", compacted: 2_000, updated: 2_088, pending: false, nextPrompt: false, accepted: true },
    { name: "final_late_update", compacted: 2_000, updated: 2_101, pending: false, nextPrompt: false, accepted: false },
    { name: "after_prompt", compacted: 3_001, updated: 3_002, pending: false, nextPrompt: true, accepted: false },
    { name: "late_update", compacted: 2_000, updated: 2_101, pending: false, nextPrompt: true, accepted: false },
    { name: "non_terminal", compacted: 2_000, updated: 2_005, pending: true, nextPrompt: true, accepted: false },
  ] as const)
    it.effect(`${scenario.accepted ? "preserves" : "rejects"} a ${scenario.name} asynchronous legacy tool prune`, () =>
      Effect.gen(function* () {
        const result = yield* legacyEvidenceCheckpoint({
          name: `tool_async_prune_${scenario.name}`,
          role: "assistant",
          parts: [
            {
              id: `prt_tool_async_prune_${scenario.name}`,
              time: 4,
              updated: scenario.updated,
              data: {
                type: "tool",
                callID: `call-tool-async-prune-${scenario.name}`,
                tool: "shell",
                metadata: { openai: { itemId: `item-tool-async-prune-${scenario.name}` } },
                state: {
                  status: "completed",
                  input: { command: "pwd" },
                  output: "done",
                  title: "shell",
                  metadata: {},
                  time: { start: 6, end: 8, compacted: scenario.compacted },
                },
              },
            },
          ],
          publish: (events, ids) =>
            Effect.gen(function* () {
              yield* publishCompletedTool(events, ids, {
                callID: `call-tool-async-prune-${scenario.name}`,
                command: "pwd",
                output: "done",
              })
              yield* events.publish(SessionEvent.Prompted, {
                sessionID: ids.sessionID,
                timestamp: DateTime.makeUnsafe(10),
                messageID: SessionMessage.ID.make(`msg_tool_async_prune_prompt_${scenario.name}`),
                prompt: new Prompt({ text: "continue" }),
                delivery: "steer",
              })
              yield* events.publish(SessionEvent.Step.Started, {
                sessionID: ids.sessionID,
                timestamp: DateTime.makeUnsafe(11),
                assistantMessageID: SessionMessage.ID.make(`msg_tool_async_prune_assistant_${scenario.name}`),
                agent: "build",
                model,
              })
              yield* events.publish(SessionEvent.Step.Ended, {
                sessionID: ids.sessionID,
                timestamp: DateTime.makeUnsafe(20),
                assistantMessageID: SessionMessage.ID.make(`msg_tool_async_prune_assistant_${scenario.name}`),
                finish: "stop",
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              })
              if (scenario.pending)
                yield* events.publish(SessionEvent.Step.Started, {
                  sessionID: ids.sessionID,
                  timestamp: DateTime.makeUnsafe(500),
                  assistantMessageID: SessionMessage.ID.make(`msg_tool_async_prune_pending_${scenario.name}`),
                  agent: "build",
                  model,
                })
              if (scenario.nextPrompt)
                yield* events.publish(SessionEvent.Prompted, {
                  sessionID: ids.sessionID,
                  timestamp: DateTime.makeUnsafe(3_000),
                  messageID: SessionMessage.ID.make(`msg_tool_async_prune_next_prompt_${scenario.name}`),
                  prompt: new Prompt({ text: "next" }),
                  delivery: "steer",
                })
            }),
        }).pipe(Effect.exit)
        expect(result._tag).toBe(scenario.accepted ? "Success" : "Failure")
      }),
    )

  it.effect("preserves a checkpoint-owned legacy tool title with exact lifecycle evidence", () =>
    Effect.gen(function* () {
      const result = yield* legacyEvidenceCheckpoint({
        name: "tool_legacy_title",
        role: "assistant",
        parts: [
          {
            id: "prt_tool_legacy_title",
            time: 4,
            data: {
              type: "tool",
              callID: "call-tool-legacy-title",
              tool: "shell",
              metadata: { openai: { itemId: "item-legacy-title" } },
              state: {
                status: "completed",
                input: { command: "pwd" },
                output: "done",
                title: "Historical display title",
                metadata: {},
                time: { start: 6, end: 8 },
              },
            },
          },
        ],
        publish: (events, ids) =>
          publishCompletedTool(events, ids, {
            callID: "call-tool-legacy-title",
            command: "pwd",
            output: "done",
          }),
      }).pipe(Effect.exit)
      expect(result._tag).toBe("Success")
      expect(JSON.stringify(result)).toContain('"partID":"prt_tool_legacy_title"')
    }),
  )

  it.effect("preserves tool compaction after an intermediate provider step settles", () =>
    Effect.gen(function* () {
      const result = yield* legacyEvidenceCheckpoint({
        name: "tool_normal_prompt_compaction",
        role: "assistant",
        parts: [
          {
            id: "prt_tool_normal_prompt_compaction",
            time: 4,
            updated: 12,
            data: {
              type: "tool",
              callID: "call-tool-normal-prompt-compaction",
              tool: "shell",
              metadata: { openai: { itemId: "item-tool-normal-prompt-compaction" } },
              state: {
                status: "completed",
                input: { command: "pwd" },
                output: "done",
                title: "shell",
                metadata: {},
                time: { start: 6, end: 8, compacted: 12 },
              },
            },
          },
        ],
        publish: (events, ids) =>
          Effect.gen(function* () {
            yield* publishCompletedTool(events, ids, {
              callID: "call-tool-normal-prompt-compaction",
              command: "pwd",
              output: "done",
            })
            const promptID = SessionMessage.ID.make("msg_tool_normal_prompt_compaction_followup")
            yield* events.publish(SessionEvent.Prompted, {
              sessionID: ids.sessionID,
              messageID: promptID,
              timestamp: DateTime.makeUnsafe(10),
              prompt: new Prompt({ text: "continue" }),
              delivery: "steer",
            })
            const assistantID = SessionMessage.ID.make("msg_tool_normal_prompt_compaction_assistant")
            yield* events.publish(SessionEvent.Step.Started, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(11),
              assistantMessageID: assistantID,
              agent: "build",
              model,
            })
            yield* events.publish(SessionEvent.Step.Ended, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(12),
              assistantMessageID: assistantID,
              finish: "stop",
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            })
            yield* events.publish(SessionEvent.Step.Started, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(13),
              assistantMessageID: SessionMessage.ID.make("msg_tool_normal_prompt_compaction_later_assistant"),
              agent: "build",
              model,
            })
            yield* events.publish(SessionEvent.Step.Ended, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(14),
              assistantMessageID: SessionMessage.ID.make("msg_tool_normal_prompt_compaction_later_assistant"),
              finish: "stop",
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            })
          }),
      }).pipe(Effect.exit)
      expect(result._tag).toBe("Success")
      expect(JSON.stringify(result)).toContain('"compacted":12')
    }),
  )

  it.effect("replays checkpoint-owned structured metadata for a still-running task", () =>
    Effect.gen(function* () {
      const structured = {
        parentSessionId: "ses_evidence_running_task",
        sessionId: "ses_evidence_running_task_child",
        model: { providerID: "openai", modelID: "gpt-5.5" },
      }
      const result = yield* legacyEvidenceCheckpoint({
        name: "running_task_metadata",
        role: "assistant",
        parts: [
          {
            id: "prt_running_task_metadata",
            time: 4,
            data: {
              type: "tool",
              callID: "call-running-task-metadata",
              tool: "task",
              metadata: { openai: { itemId: "item-running-task-metadata" } },
              state: {
                status: "running",
                input: { description: "Review", prompt: "Inspect the change" },
                title: "Review",
                metadata: structured,
                time: { start: 6 },
              },
            },
          },
        ],
        publish: (events, ids) =>
          Effect.gen(function* () {
            yield* events.publish(SessionEvent.Tool.Input.Started, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(6),
              assistantMessageID: ids.messageID,
              callID: "call-running-task-metadata",
              name: "task",
            })
            yield* events.publish(SessionEvent.Tool.Input.Ended, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(6),
              assistantMessageID: ids.messageID,
              callID: "call-running-task-metadata",
              text: JSON.stringify({ description: "Review", prompt: "Inspect the change" }),
            })
            yield* events.publish(SessionEvent.Tool.Called, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(6),
              assistantMessageID: ids.messageID,
              callID: "call-running-task-metadata",
              tool: "task",
              input: { description: "Review", prompt: "Inspect the change" },
              provider: { executed: false },
            })
          }),
      }).pipe(Effect.exit)
      expect(result._tag).toBe("Success")
      expect(JSON.stringify(result)).toContain(`"metadata":${JSON.stringify(structured)}`)
    }),
  )

  it.effect("replays checkpoint-owned running tool metadata without outer provider metadata", () =>
    Effect.gen(function* () {
      const structured = { output: "$ bun run build\n", description: "Close running OpenCode processes" }
      const toolInput = { command: "Get-Process OpenCode", description: structured.description }
      const result = yield* legacyEvidenceCheckpoint({
        name: "running_tool_after_step_end",
        role: "assistant",
        stepEndTime: 3.5,
        parts: [
          {
            id: "prt_running_tool_after_step_end",
            time: 4,
            data: {
              type: "tool",
              callID: "call-running-tool-after-step-end",
              tool: "bash",
              state: {
                status: "running",
                input: toolInput,
                metadata: structured,
                time: { start: 6 },
              },
            },
          },
        ],
        publish: (events, ids) =>
          Effect.gen(function* () {
            yield* events.publish(SessionEvent.Tool.Input.Started, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(6),
              assistantMessageID: ids.messageID,
              callID: "call-running-tool-after-step-end",
              name: "bash",
            })
            yield* events.publish(SessionEvent.Tool.Input.Ended, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(6),
              assistantMessageID: ids.messageID,
              callID: "call-running-tool-after-step-end",
              text: JSON.stringify(toolInput),
            })
            yield* events.publish(SessionEvent.Tool.Called, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(6),
              assistantMessageID: ids.messageID,
              callID: "call-running-tool-after-step-end",
              tool: "bash",
              input: toolInput,
              provider: { executed: false },
            })
          }),
      }).pipe(Effect.exit)
      expect(result._tag).toBe("Success")
      expect(JSON.stringify(result)).toContain(`"metadata":${JSON.stringify(structured)}`)
    }),
  )

  it.effect("rejects unchecked running tool metadata without outer provider metadata", () =>
    Effect.gen(function* () {
      const toolInput = { command: "Get-Process OpenCode", description: "Close running OpenCode processes" }
      const result = yield* legacyEvidenceCheckpoint({
        name: "running_tool_unchecked_metadata",
        role: "assistant",
        parts: [
          {
            id: "prt_running_tool_unchecked_metadata",
            time: 4,
            data: {
              type: "tool",
              callID: "call-running-tool-unchecked-metadata",
              tool: "bash",
              state: {
                status: "running",
                input: toolInput,
                metadata: { output: "$ bun run build\n", description: "Different operation" },
                time: { start: 6 },
              },
            },
          },
        ],
        publish: (events, ids) =>
          Effect.gen(function* () {
            yield* events.publish(SessionEvent.Tool.Input.Started, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(6),
              assistantMessageID: ids.messageID,
              callID: "call-running-tool-unchecked-metadata",
              name: "bash",
            })
            yield* events.publish(SessionEvent.Tool.Input.Ended, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(6),
              assistantMessageID: ids.messageID,
              callID: "call-running-tool-unchecked-metadata",
              text: JSON.stringify(toolInput),
            })
            yield* events.publish(SessionEvent.Tool.Called, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(6),
              assistantMessageID: ids.messageID,
              callID: "call-running-tool-unchecked-metadata",
              tool: "bash",
              input: toolInput,
              provider: { executed: false },
            })
          }),
      }).pipe(Effect.exit)
      expect(result._tag).toBe("Failure")
      expect(String(result)).toContain("legacyParts count differs")
    }),
  )

  it.effect("does not let duplicate checkpoint parts claim one tool lifecycle", () =>
    Effect.gen(function* () {
      const state = {
        status: "completed",
        input: { command: "pwd" },
        output: "done",
        title: "shell",
        metadata: {},
        time: { start: 6, end: 8 },
      }
      const rejected = yield* legacyEvidenceCheckpoint({
        name: "tool_duplicate_checkpoint",
        role: "assistant",
        parts: [
          {
            id: "prt_tool_duplicate_checkpoint_1",
            time: 4,
            data: {
              type: "tool",
              callID: "call-tool-duplicate-checkpoint",
              tool: "shell",
              metadata: { openai: { itemId: "item-duplicate-1" } },
              state,
            },
          },
          {
            id: "prt_tool_duplicate_checkpoint_2",
            time: 4,
            data: {
              type: "tool",
              callID: "call-tool-duplicate-checkpoint",
              tool: "shell",
              metadata: { openai: { itemId: "item-duplicate-2" } },
              state,
            },
          },
        ],
        publish: (events, ids) =>
          publishCompletedTool(events, ids, {
            callID: "call-tool-duplicate-checkpoint",
            command: "pwd",
            output: "done",
          }),
      }).pipe(Effect.exit)
      expect(rejected._tag).toBe("Failure")
      expect(String(rejected)).toContain("Checkpoint-only legacy causality failed")
    }),
  )

  it.effect("preserves a completed apply_patch created within the historical preparation window", () =>
    Effect.gen(function* () {
      const result = yield* legacyEvidenceCheckpoint({
        name: "apply_patch_preparation",
        role: "assistant",
        parts: [
          {
            id: "prt_apply_patch_preparation",
            time: -107_000,
            data: {
              type: "tool",
              callID: "call-apply-patch-preparation",
              tool: "apply_patch",
              metadata: { openai: { itemId: "item-apply-patch" } },
              state: {
                status: "completed",
                input: { patchText: "*** Begin Patch\n*** End Patch" },
                output: "Done!",
                title: "Applied patch",
                metadata: {},
                time: { start: 6, end: 8 },
              },
            },
          },
        ],
        publish: (events, ids) =>
          publishCompletedTool(events, ids, {
            callID: "call-apply-patch-preparation",
            output: "Done!",
            tool: "apply_patch",
            toolInput: { patchText: "*** Begin Patch\n*** End Patch" },
          }),
      }).pipe(Effect.exit)
      expect(result._tag).toBe("Success")
      expect(JSON.stringify(result)).toContain('"partID":"prt_apply_patch_preparation"')
    }),
  )

  it.effect("preserves verified historical metadata for an interrupted tool", () =>
    Effect.gen(function* () {
      const result = yield* legacyEvidenceCheckpoint({
        name: "tool_interrupted_metadata",
        role: "assistant",
        parts: [
          {
            id: "prt_tool_interrupted_metadata",
            time: 4,
            data: {
              type: "tool",
              callID: "call-tool-interrupted-metadata",
              tool: "shell",
              metadata: { openai: { itemId: "item-interrupted" } },
              state: {
                status: "error",
                input: { command: "sleep", description: "Long command" },
                error: "Tool execution aborted",
                metadata: {
                  interrupted: true,
                  output: "partial stdout before cancellation\n",
                  description: "Long command",
                },
                time: { start: 6, end: 8 },
              },
            },
          },
        ],
        publish: (events, ids) =>
          Effect.gen(function* () {
            yield* events.publish(SessionEvent.Tool.Input.Started, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(6),
              assistantMessageID: ids.messageID,
              callID: "call-tool-interrupted-metadata",
              name: "shell",
            })
            yield* events.publish(SessionEvent.Tool.Input.Ended, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(6),
              assistantMessageID: ids.messageID,
              callID: "call-tool-interrupted-metadata",
              text: JSON.stringify({ command: "sleep", description: "Long command" }),
            })
            yield* events.publish(SessionEvent.Tool.Called, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(6),
              assistantMessageID: ids.messageID,
              callID: "call-tool-interrupted-metadata",
              tool: "shell",
              input: { command: "sleep", description: "Long command" },
              provider: { executed: false },
            })
            yield* events.publish(SessionEvent.Tool.FailedV1, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(8),
              assistantMessageID: ids.messageID,
              callID: "call-tool-interrupted-metadata",
              error: { type: "unknown", message: "Tool execution aborted" },
              result: { type: "error", value: "Tool execution aborted" },
              provider: { executed: false },
            })
          }),
      }).pipe(Effect.exit)
      expect(result._tag).toBe("Success")
      expect(JSON.stringify(result)).toContain('"partID":"prt_tool_interrupted_metadata"')
      expect(JSON.stringify(result)).toContain(
        '"structured":{"interrupted":true,"output":"partial stdout before cancellation\\n","description":"Long command"}',
      )
    }),
  )

  for (const matching of [true, false])
    it.effect(`${matching ? "preserves" : "rejects"} checkpoint-owned task interruption metadata`, () =>
      Effect.gen(function* () {
        const name = `task_interrupted_child_${matching}`
        const result = yield* legacyEvidenceCheckpoint({
          name,
          role: "assistant",
          parts: [
            {
              id: `prt_${name}`,
              time: 4,
              data: {
                type: "tool",
                callID: `call-${name}`,
                tool: "task",
                state: {
                  status: "error",
                  input: { description: "Audit assets", prompt: "Inspect assets", subagent_type: "explore" },
                  error: "Tool execution aborted",
                  title: "Audit assets",
                  metadata: {
                    parentSessionId: matching ? `ses_evidence_${name}` : "ses_wrong_parent",
                    sessionId: `ses_child_${name}`,
                    model: { providerID: "openai", modelID: "gpt-5.5" },
                    interrupted: true,
                  },
                  time: { start: 6, end: 8 },
                },
              },
            },
          ],
          publish: (events, ids) =>
            Effect.gen(function* () {
              const input = { description: "Audit assets", prompt: "Inspect assets", subagent_type: "explore" }
              yield* events.publish(SessionEvent.Tool.Input.Started, {
                sessionID: ids.sessionID,
                timestamp: DateTime.makeUnsafe(6),
                assistantMessageID: ids.messageID,
                callID: `call-${name}`,
                name: "task",
              })
              yield* events.publish(SessionEvent.Tool.Input.Ended, {
                sessionID: ids.sessionID,
                timestamp: DateTime.makeUnsafe(6),
                assistantMessageID: ids.messageID,
                callID: `call-${name}`,
                text: JSON.stringify(input),
              })
              yield* events.publish(SessionEvent.Tool.Called, {
                sessionID: ids.sessionID,
                timestamp: DateTime.makeUnsafe(6),
                assistantMessageID: ids.messageID,
                callID: `call-${name}`,
                tool: "task",
                input,
                provider: { executed: false },
              })
              yield* events.publish(SessionEvent.Tool.FailedV1, {
                sessionID: ids.sessionID,
                timestamp: DateTime.makeUnsafe(8),
                assistantMessageID: ids.messageID,
                callID: `call-${name}`,
                error: { type: "unknown", message: "Tool execution aborted" },
                result: { type: "error", value: "Tool execution aborted" },
                provider: { executed: false },
              })
            }),
        }).pipe(Effect.exit)
        expect(result._tag).toBe(matching ? "Success" : "Failure")
      }),
    )

  it.effect("rejects partial-output provenance for an ordinary failed tool", () =>
    Effect.gen(function* () {
      const rejected = yield* legacyEvidenceCheckpoint({
        name: "tool_failed_partial_output",
        role: "assistant",
        parts: [
          {
            id: "prt_tool_failed_partial_output",
            time: 4,
            data: {
              type: "tool",
              callID: "call-tool-failed-partial-output",
              tool: "shell",
              metadata: { openai: { itemId: "item-tool-failed-partial-output" } },
              state: {
                status: "error",
                input: { command: "false", description: "Fail normally" },
                error: "Command failed",
                metadata: { interrupted: true, output: "partial output\n", description: "Fail normally" },
                time: { start: 6, end: 8 },
              },
            },
          },
        ],
        publish: (events, ids) =>
          Effect.gen(function* () {
            yield* events.publish(SessionEvent.Tool.Input.Started, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(6),
              assistantMessageID: ids.messageID,
              callID: "call-tool-failed-partial-output",
              name: "shell",
            })
            yield* events.publish(SessionEvent.Tool.Input.Ended, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(6),
              assistantMessageID: ids.messageID,
              callID: "call-tool-failed-partial-output",
              text: JSON.stringify({ command: "false", description: "Fail normally" }),
            })
            yield* events.publish(SessionEvent.Tool.Called, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(6),
              assistantMessageID: ids.messageID,
              callID: "call-tool-failed-partial-output",
              tool: "shell",
              input: { command: "false", description: "Fail normally" },
              provider: { executed: false },
            })
            yield* events.publish(SessionEvent.Tool.FailedV1, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(8),
              assistantMessageID: ids.messageID,
              callID: "call-tool-failed-partial-output",
              error: { type: "unknown", message: "Command failed" },
              result: { type: "error", value: "Command failed" },
              provider: { executed: false },
            })
          }),
      }).pipe(Effect.exit)
      expect(rejected._tag).toBe("Failure")
      expect(String(rejected)).toContain("Checkpoint-only legacy causality failed")
    }),
  )

  it.effect("rejects unchecked fields in interrupted tool provenance", () =>
    Effect.gen(function* () {
      const rejected = yield* legacyEvidenceCheckpoint({
        name: "tool_interrupted_unchecked_metadata",
        role: "assistant",
        parts: [
          {
            id: "prt_tool_interrupted_unchecked_metadata",
            time: 4,
            data: {
              type: "tool",
              callID: "call-tool-interrupted-unchecked-metadata",
              tool: "shell",
              metadata: { openai: { itemId: "item-interrupted-unchecked" } },
              state: {
                status: "error",
                input: { command: "sleep" },
                error: "Tool execution aborted",
                metadata: { interrupted: true, unchecked: "must not enter the checkpoint" },
                time: { start: 6, end: 8 },
              },
            },
          },
        ],
        publish: (events, ids) =>
          Effect.gen(function* () {
            yield* events.publish(SessionEvent.Tool.Input.Started, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(6),
              assistantMessageID: ids.messageID,
              callID: "call-tool-interrupted-unchecked-metadata",
              name: "shell",
            })
            yield* events.publish(SessionEvent.Tool.Input.Ended, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(6),
              assistantMessageID: ids.messageID,
              callID: "call-tool-interrupted-unchecked-metadata",
              text: JSON.stringify({ command: "sleep" }),
            })
            yield* events.publish(SessionEvent.Tool.Called, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(6),
              assistantMessageID: ids.messageID,
              callID: "call-tool-interrupted-unchecked-metadata",
              tool: "shell",
              input: { command: "sleep" },
              provider: { executed: false },
            })
            yield* events.publish(SessionEvent.Tool.FailedV1, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(8),
              assistantMessageID: ids.messageID,
              callID: "call-tool-interrupted-unchecked-metadata",
              error: { type: "unknown", message: "Tool execution aborted" },
              result: { type: "error", value: "Tool execution aborted" },
              provider: { executed: false },
            })
          }),
      }).pipe(Effect.exit)
      expect(rejected._tag).toBe("Failure")
      expect(String(rejected)).toContain("Checkpoint-only legacy causality failed")
    }),
  )

  it.effect("replays a delayed interrupted apply_patch whose historical empty input was not JSON encoded", () =>
    Effect.gen(function* () {
      const result = yield* legacyEvidenceCheckpoint({
        name: "tool_interrupted_empty_input",
        role: "assistant",
        parts: [
          {
            id: "prt_tool_interrupted_empty_input",
            time: -88_000,
            data: {
              type: "tool",
              callID: "call-tool-interrupted-empty-input",
              tool: "apply_patch",
              state: {
                status: "error",
                input: {},
                raw: "",
                error: "Tool execution aborted",
                metadata: { interrupted: true },
                time: { start: 6, end: 8 },
              },
            },
          },
        ],
        publish: (events, ids) =>
          Effect.gen(function* () {
            yield* events.publish(SessionEvent.Tool.Input.Started, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(6),
              assistantMessageID: ids.messageID,
              callID: "call-tool-interrupted-empty-input",
              name: "apply_patch",
            })
            yield* events.publish(SessionEvent.Tool.Input.Ended, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(6),
              assistantMessageID: ids.messageID,
              callID: "call-tool-interrupted-empty-input",
              text: "",
            })
            yield* events.publish(SessionEvent.Tool.Called, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(6),
              assistantMessageID: ids.messageID,
              callID: "call-tool-interrupted-empty-input",
              tool: "apply_patch",
              input: {},
              provider: { executed: false },
            })
            yield* events.publish(SessionEvent.Tool.FailedV1, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(8),
              assistantMessageID: ids.messageID,
              callID: "call-tool-interrupted-empty-input",
              error: { type: "unknown", message: "Tool execution aborted" },
              result: { type: "error", value: "Tool execution aborted" },
              provider: { executed: false },
            })
          }),
      }).pipe(Effect.exit)
      expect(result._tag).toBe("Success")
      expect(JSON.stringify(result)).toContain('"structured":{"interrupted":true}')
    }),
  )

  it.effect("rejects a tool lifecycle with more than one terminal event", () =>
    Effect.gen(function* () {
      const rejected = yield* legacyEvidenceCheckpoint({
        name: "tool_duplicate_terminal",
        role: "assistant",
        parts: [
          {
            id: "prt_tool_duplicate_terminal",
            time: 6,
            data: {
              type: "tool",
              callID: "call-tool-duplicate-terminal",
              tool: "shell",
              state: {
                status: "error",
                input: { command: "pwd" },
                error: "late failure",
                time: { start: 6, end: 8 },
              },
            },
          },
        ],
        publish: (events, ids) =>
          Effect.gen(function* () {
            yield* publishCompletedTool(events, ids, {
              callID: "call-tool-duplicate-terminal",
              command: "pwd",
              output: "done",
            })
            yield* events.publish(SessionEvent.Tool.Failed, {
              sessionID: ids.sessionID,
              timestamp: DateTime.makeUnsafe(8),
              assistantMessageID: ids.messageID,
              callID: "call-tool-duplicate-terminal",
              error: { type: "unknown", message: "late failure" },
              provider: { executed: false },
            })
          }),
      }).pipe(Effect.exit)
      expect(rejected._tag).toBe("Failure")
      expect(String(rejected)).toContain("legacyParts count differs")
    }),
  )

  it.effect("finds a complete assignment for crossed identical evidence", () =>
    Effect.sync(() => {
      const matched = SessionProjector.completeEvidenceAssignment(
        new Map([
          ["flexible", [{ key: "early" }, { key: "late" }]],
          ["constrained", [{ key: "early" }]],
        ]),
      )
      expect(matched).toEqual(new Set(["flexible", "constrained"]))
    }),
  )

  for (const mismatch of ["input", "outcome"] as const)
    it.effect(`rejects a V2 tool ${mismatch} mismatch`, () =>
      Effect.gen(function* () {
        const rejected = yield* legacyEvidenceCheckpoint({
          name: `tool_${mismatch}_mismatch`,
          role: "assistant",
          parts: [
            {
              id: `prt_tool_${mismatch}_mismatch`,
              data: {
                type: "tool",
                callID: `call-tool-${mismatch}`,
                tool: "shell",
                state: {
                  status: "completed",
                  input: { command: "pwd" },
                  output: "expected output",
                  title: "shell",
                  metadata: {},
                  time: { start: 4, end: 6 },
                },
              },
            },
          ],
          publish: (events, ids) =>
            publishCompletedTool(events, ids, {
              callID: `call-tool-${mismatch}`,
              command: mismatch === "input" ? "whoami" : "pwd",
              output: mismatch === "outcome" ? "different output" : "expected output",
            }),
        }).pipe(Effect.exit)
        expect(rejected._tag).toBe("Failure")
        expect(String(rejected)).toContain("legacyParts count differs")
      }),
    )

  it.effect("retains a V1-only structural part as explicit checkpoint provenance", () =>
    Effect.gen(function* () {
      const legacySessionID = SessionV2.ID.make("ses_message_first_unmatched_child")
      const messageID = SessionV1.MessageID.make("msg_message_first_root")
      const unmatchedID = SessionV1.MessageID.make("msg_unmatched_child_root")
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: legacySessionID,
          project_id: Project.ID.global,
          slug: "unmatched-child",
          directory: "/project",
          title: "unmatched child",
          version: "legacy",
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(MessageTable)
        .values({
          id: unmatchedID,
          session_id: legacySessionID,
          time_created: 2,
          time_updated: 2,
          data: {
            role: "assistant",
            time: { created: 2 },
            parentID: messageID,
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
      yield* db
        .insert(PartTable)
        .values({
          id: SessionV1.PartID.make("prt_unmatched_future_part"),
          session_id: legacySessionID,
          message_id: unmatchedID,
          time_created: 100,
          time_updated: 100,
          data: {
            type: "snapshot",
            snapshot: "not-proven-by-the-v2-stream",
          } as (typeof PartTable.$inferInsert)["data"],
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      yield* events.publish(SessionV1.Event.MessageUpdated, {
        sessionID: legacySessionID,
        info: {
          id: messageID,
          sessionID: legacySessionID,
          role: "user",
          time: { created: 1 },
          agent: "build",
          model: { providerID: model.providerID, modelID: model.id },
        },
      })
      yield* events.publish(SessionV1.Event.Updated, {
        sessionID: legacySessionID,
        info: SessionV1.SessionInfo.make({
          id: legacySessionID,
          projectID: Project.ID.global,
          slug: "unmatched-child",
          directory: "/project",
          title: "unmatched child",
          version: "legacy",
          time: { created: 0, updated: 2 },
        }),
      })
      yield* events.publish(SessionV1.Event.PartUpdated, {
        sessionID: legacySessionID,
        part: {
          id: SessionV1.PartID.make("prt_unmatched_child_root"),
          sessionID: legacySessionID,
          messageID: unmatchedID,
          type: "text",
          text: "must not admit an arbitrary expected legacy row",
        },
        time: 3,
      })
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID: legacySessionID,
        timestamp: DateTime.makeUnsafe(4),
        assistantMessageID: SessionMessage.ID.make(unmatchedID),
        agent: "build",
        model,
      })
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID: legacySessionID,
        timestamp: DateTime.makeUnsafe(5),
        assistantMessageID: SessionMessage.ID.make(unmatchedID),
        finish: "stop",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })

      const result = yield* events.createCheckpoint(legacySessionID).pipe(Effect.exit)
      expect(result._tag).toBe("Success")
      expect(JSON.stringify(result)).toContain("\"partID\":\"prt_unmatched_future_part\"")
    }),
  )

  it.effect("does not resurrect a legacy part after explicit removal", () =>
    Effect.gen(function* () {
      const legacySessionID = SessionV2.ID.make("ses_message_first_removed_child")
      const messageID = SessionV1.MessageID.make("msg_removed_child_root")
      const assistantID = SessionV1.MessageID.make("msg_removed_child_assistant")
      const partID = SessionV1.PartID.make("prt_removed_child")
      const part = {
        id: partID,
        session_id: legacySessionID,
        message_id: assistantID,
        time_created: 2,
        time_updated: 2,
        data: {
          type: "step-start",
          snapshot: "removed-snapshot",
        } as (typeof PartTable.$inferInsert)["data"],
      }
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: legacySessionID,
          project_id: Project.ID.global,
          slug: "removed-child",
          directory: "/project",
          title: "removed child",
          version: "legacy",
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(MessageTable)
        .values({
          id: assistantID,
          session_id: legacySessionID,
          time_created: 2,
          time_updated: 2,
          data: {
            role: "assistant",
            time: { created: 2 },
            parentID: messageID,
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
      yield* db.insert(PartTable).values(part).run().pipe(Effect.orDie)
      const events = yield* EventV2.Service
      yield* events.publish(SessionV1.Event.MessageUpdated, {
        sessionID: legacySessionID,
        info: {
          id: messageID,
          sessionID: legacySessionID,
          role: "user",
          time: { created: 1 },
          agent: "build",
          model: { providerID: model.providerID, modelID: model.id },
        },
      })
      yield* events.publish(SessionV1.Event.Updated, {
        sessionID: legacySessionID,
        info: SessionV1.SessionInfo.make({
          id: legacySessionID,
          projectID: Project.ID.global,
          slug: "removed-child",
          directory: "/project",
          title: "removed child",
          version: "legacy",
          time: { created: 0, updated: 2 },
        }),
      })
      yield* events.publish(SessionV1.Event.PartRemoved, {
        sessionID: legacySessionID,
        messageID: assistantID,
        partID,
      })
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID: legacySessionID,
        timestamp: DateTime.makeUnsafe(3),
        assistantMessageID: SessionMessage.ID.make(assistantID),
        agent: "build",
        model,
        snapshot: "removed-snapshot",
      })
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID: legacySessionID,
        timestamp: DateTime.makeUnsafe(4),
        assistantMessageID: SessionMessage.ID.make(assistantID),
        finish: "stop",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        snapshot: "removed-snapshot",
      })

      // A row that reappears outside the event stream is not safe to infer as pre-removal state.
      yield* db.insert(PartTable).values(part).run().pipe(Effect.orDie)
      const rejected = yield* events.createCheckpoint(legacySessionID).pipe(Effect.exit)
      expect(rejected._tag).toBe("Failure")
      expect(String(rejected)).toContain("legacyParts count differs")
    }),
  )

  it.effect("rejects a legacy message-first stream without a later session root", () =>
    Effect.gen(function* () {
      const legacySessionID = SessionV2.ID.make("ses_message_first_without_root")
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: legacySessionID,
          project_id: Project.ID.global,
          slug: "missing-root",
          directory: "/project",
          title: "missing root",
          version: "legacy",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      yield* events.publish(SessionV1.Event.MessageUpdated, {
        sessionID: legacySessionID,
        info: {
          id: SessionV1.MessageID.make("msg_message_first_without_root"),
          sessionID: legacySessionID,
          role: "user",
          time: { created: 1 },
          agent: "build",
          model: { providerID: model.providerID, modelID: model.id },
        },
      })

      const rejected = yield* events.createCheckpoint(legacySessionID).pipe(Effect.exit)
      expect(rejected._tag).toBe("Failure")
      expect(String(rejected)).toContain("FOREIGN KEY constraint failed")
    }),
  )

  it.effect("marks an admitted lifecycle row promoted with the PromptPromoted event sequence", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
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
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      const id = SessionMessage.ID.make("msg_admitted")
      yield* SessionInput.admit(db, events, {
        id,
        sessionID,
        prompt: new Prompt({ text: "promote me" }),
        delivery: "steer",
      })

      const event = yield* events.publish(SessionEvent.PromptLifecycle.Promoted, {
        sessionID,
        timestamp: created,
        messageID: id,
        prompt: new Prompt({ text: "promote me" }),
        timeCreated: created,
      })

      expect(
        yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.id, id)).get().pipe(Effect.orDie),
      ).toMatchObject({ promoted_seq: event.seq })
    }),
  )

  it.effect("updates session recency on prompt admission and activity settlement", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
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
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service

      yield* events.publish(SessionEvent.PromptLifecycle.Admitted, {
        sessionID,
        timestamp: DateTime.makeUnsafe(10),
        messageID: SessionMessage.ID.make("msg_recency"),
        prompt: new Prompt({ text: "start" }),
        delivery: "steer",
      })

      expect(
        yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie),
      ).toMatchObject({ time_updated: 10 })

      yield* events.publish(SessionEvent.Activity.Completed, {
        sessionID,
        timestamp: DateTime.makeUnsafe(20),
        activityID: "activity-recency",
      })

      expect(
        yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie),
      ).toMatchObject({ time_updated: 20 })
    }),
  )

  it.effect("projects an actionable assistant failure when model resolution fails before a step starts", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
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
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
          agent: "build",
          model,
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      yield* events.publish(SessionEvent.Prompted, {
        sessionID,
        messageID: SessionMessage.ID.make("msg_early_failure_user"),
        timestamp: created,
        prompt: new Prompt({ text: "Use GPT-5.6 max" }),
        delivery: "steer",
      })

      yield* events.publish(SessionEvent.Activity.Failed, {
        sessionID,
        activityID: "activity-early-model-failure",
        timestamp: DateTime.makeUnsafe(1),
        error: { type: "unknown", message: "GPT-5.6 max is unavailable for the current OAuth connection" },
        failure: SessionFailure.make("provider.auth"),
      })

      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie)
      const messages = rows.map((row) =>
        Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }),
      )
      expect(messages[0]).toMatchObject({ type: "user", text: "Use GPT-5.6 max" })
      expect(messages[1]).toMatchObject({
        type: "assistant",
        finish: "error",
        content: [],
        error: { type: "unknown", message: "GPT-5.6 max is unavailable for the current OAuth connection" },
        failure: SessionFailure.make("provider.auth"),
      })
      const assistant = messages[1]
      if (assistant?.type !== "assistant" || !assistant.time.completed) return
      expect(DateTime.toEpochMillis(assistant.time.completed)).toBe(1)
    }),
  )

  it.effect("projects an activity failure from its predecessor when replay already contains later messages", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
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
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
          agent: "build",
          model,
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      yield* events.publish(SessionEvent.Prompted, {
        sessionID,
        messageID: SessionMessage.ID.make("msg_replay_failure_user"),
        timestamp: created,
        prompt: new Prompt({ text: "Use the unavailable model" }),
        delivery: "steer",
      })
      yield* db
        .insert(SessionMessageTable)
        .values(assistantRow(SessionMessage.ID.make("msg_replay_later_assistant"), 2))
        .run()
        .pipe(Effect.orDie)

      yield* events.publish(SessionEvent.Activity.Failed, {
        sessionID,
        activityID: "activity-replay-early-model-failure",
        timestamp: DateTime.makeUnsafe(1),
        error: { type: "unknown", message: "model unavailable" },
      })

      const projected = yield* db
        .select()
        .from(SessionMessageTable)
        .where(
          eq(
            SessionMessageTable.id,
            SessionMessage.ID.make("msg_activity_failure_activity-replay-early-model-failure"),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      expect(projected).toMatchObject({ type: "assistant", seq: 1 })
      expect(projected?.data).toMatchObject({
        finish: "error",
        content: [],
        error: { type: "unknown", message: "model unavailable" },
      })
    }),
  )

  it.effect("preserves selectively projected v1 activity failures during fresh replay", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const legacySessionID = SessionV2.ID.make("ses_legacy_projected_activity_failures")
      const projected = [
        { activityID: "f6f9ed2b7001CTPizNZFFkK0lh", messageID: "msg_legacy_projected_failure_1", seq: 4 },
        { activityID: "f6f9fe354001aTcipVHP9MhMLM", messageID: "msg_legacy_projected_failure_2", seq: 8 },
      ] as const
      const unprojected = { activityID: "f6fa0ef05001UXI8Q3jOuVQw5t", messageID: "msg_legacy_unprojected_failure", seq: 12 }
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)

      yield* events.replayAll([
        {
          id: EventV2.ID.make("evt_legacy_projected_failure_created"),
          aggregateID: legacySessionID,
          seq: 0,
          type: "session.created.1",
          data: {
            sessionID: legacySessionID,
            info: {
              id: legacySessionID,
              slug: "legacy-projected-activity-failures",
              projectID: Project.ID.global,
              directory: "/project",
              title: "legacy projected activity failures",
              version: "test",
              time: { created: 0, updated: 0 },
            },
          },
        },
        ...[...projected, unprojected].flatMap((failure, index) => {
          const promotedSeq = failure.seq - 1
          const timestamp = index * 10 + 1
          return [
            {
              id: EventV2.ID.make(`evt_legacy_projected_failure_started_${index}`),
              aggregateID: legacySessionID,
              seq: failure.seq - 3,
              type: "session.next.activity.started.1",
              data: {
                timestamp,
                sessionID: legacySessionID,
                activityID: failure.activityID,
                kind: "prompt",
              },
            },
            {
              id: EventV2.ID.make(`evt_legacy_projected_failure_admitted_${index}`),
              aggregateID: legacySessionID,
              seq: failure.seq - 2,
              type: "session.next.prompt.admitted.1",
              data: {
                timestamp,
                sessionID: legacySessionID,
                messageID: SessionMessage.ID.make(failure.messageID),
                prompt: { text: `prompt ${index + 1}` },
                delivery: "steer",
              },
            },
            {
              id: EventV2.ID.make(`evt_legacy_projected_failure_promoted_${index}`),
              aggregateID: legacySessionID,
              seq: promotedSeq,
              type: "session.next.prompt.promoted.1",
              data: {
                timestamp,
                sessionID: legacySessionID,
                messageID: SessionMessage.ID.make(failure.messageID),
                prompt: { text: `prompt ${index + 1}` },
                timeCreated: timestamp,
              },
            },
            {
              id: EventV2.ID.make(`evt_legacy_projected_failure_failed_${index}`),
              aggregateID: legacySessionID,
              seq: failure.seq,
              type: "session.next.activity.failed.1",
              data: {
                timestamp: timestamp + 1,
                sessionID: legacySessionID,
                activityID: failure.activityID,
                error: { type: "unknown", message: "legacy decoding failure" },
              },
            },
          ]
        }),
      ])

      yield* db
        .insert(SessionMessageTable)
        .values(
          projected.map((failure, index) => {
            const timestamp = index * 10 + 2
            const id = SessionMessage.ID.make(`msg_activity_failure_${failure.activityID}`)
            const encoded = encodeMessage(
              new SessionMessage.Assistant({
                id,
                type: "assistant",
                agent: "build",
                model: { id: ModelV2.ID.make("unknown"), providerID: ProviderV2.ID.make("unknown") },
                content: [],
                finish: "error",
                error: { type: "unknown", message: "legacy decoding failure" },
                time: { created: DateTime.makeUnsafe(timestamp), completed: DateTime.makeUnsafe(timestamp) },
              }),
            )
            const { id: _, type, ...data } = encoded
            return {
              id,
              session_id: legacySessionID,
              type,
              seq: failure.seq,
              time_created: timestamp,
              time_updated: timestamp,
              data,
            }
          }),
        )
        .run()
        .pipe(Effect.orDie)

      expect(yield* events.createCheckpoint(legacySessionID)).toBeDefined()
      expect(
        yield* db
          .select({ id: SessionMessageTable.id })
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, legacySessionID))
          .orderBy(asc(SessionMessageTable.seq))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([
        { id: SessionMessage.ID.make(projected[0].messageID) },
        { id: SessionMessage.ID.make(`msg_activity_failure_${projected[0].activityID}`) },
        { id: SessionMessage.ID.make(projected[1].messageID) },
        { id: SessionMessage.ID.make(`msg_activity_failure_${projected[1].activityID}`) },
        { id: SessionMessage.ID.make(unprojected.messageID) },
      ])
    }),
  )

  it.effect("replays legacy pre-step failures without inventing a synthetic assistant", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const legacySessionID = SessionV2.ID.make("ses_legacy_pre_step_failure")
      const messageID = SessionMessage.ID.make("msg_legacy_pre_step_failure")
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)

      yield* events.replayAll([
        {
          id: EventV2.ID.make("evt_legacy_failure_created"),
          aggregateID: legacySessionID,
          seq: 0,
          type: "session.created.1",
          data: {
            sessionID: legacySessionID,
            info: {
              id: legacySessionID,
              slug: "legacy-pre-step-failure",
              projectID: Project.ID.global,
              directory: "/project",
              title: "legacy pre-step failure",
              version: "test",
              time: { created: 0, updated: 0 },
            },
          },
        },
        {
          id: EventV2.ID.make("evt_legacy_failure_admitted"),
          aggregateID: legacySessionID,
          seq: 1,
          type: "session.next.prompt.admitted.1",
          data: {
            timestamp: 1,
            sessionID: legacySessionID,
            messageID,
            prompt: { text: "Use the unavailable model" },
            delivery: "steer",
          },
        },
        {
          id: EventV2.ID.make("evt_legacy_failure_activity"),
          aggregateID: legacySessionID,
          seq: 2,
          type: "session.next.activity.started.1",
          data: { timestamp: 2, sessionID: legacySessionID, activityID: "legacy-activity", kind: "prompt" },
        },
        {
          id: EventV2.ID.make("evt_legacy_failure_promoted"),
          aggregateID: legacySessionID,
          seq: 3,
          type: "session.next.prompt.promoted.1",
          data: {
            timestamp: 3,
            sessionID: legacySessionID,
            messageID,
            prompt: { text: "Use the unavailable model" },
            timeCreated: 1,
          },
        },
        {
          id: EventV2.ID.make("evt_legacy_failure_failed"),
          aggregateID: legacySessionID,
          seq: 4,
          type: "session.next.activity.failed.1",
          data: {
            timestamp: 4,
            sessionID: legacySessionID,
            activityID: "legacy-activity",
            error: { type: "unknown", message: "legacy provider failure" },
          },
        },
      ])

      expect(
        yield* db
          .select({ id: SessionMessageTable.id, type: SessionMessageTable.type, seq: SessionMessageTable.seq })
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, legacySessionID))
          .orderBy(asc(SessionMessageTable.seq))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([{ id: messageID, type: "user", seq: 3 }])
    }),
  )

  it.effect("projects durable context messages supported by the updater", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
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
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service

      yield* events.publish(SessionEvent.AgentSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: created,
        agent: "build",
      })
      yield* events.publish(SessionEvent.ModelSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: created,
        model,
      })
      yield* events.publish(SessionEvent.Synthetic, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: created,
        text: "synthetic context",
      })
      yield* events.publish(SessionEvent.Shell.Started, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: created,
        callID: "shell-1",
        command: "pwd",
      })
      yield* events.publish(SessionEvent.Shell.Ended, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        callID: "shell-1",
        output: "/project",
      })
      const compactionID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID: compactionID,
        timestamp: created,
        reason: "manual",
      })
      yield* events.publish(SessionEvent.Compaction.Delta, {
        sessionID,
        messageID: compactionID,
        timestamp: created,
        text: "partial",
      })
      expect(
        yield* db
          .select({ id: EventTable.id })
          .from(EventTable)
          .where(eq(EventTable.type, SessionEvent.Compaction.Delta.type))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([])
      expect(
        yield* db
          .select({ id: SessionMessageTable.id })
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.type, "compaction"))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([])
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(1),
        reason: "manual",
        text: "summary",
        recent: "recent context",
      })

      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie)
      const messages = rows.map((row) =>
        Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }),
      )

      expect(messages.map((message) => message.type)).toEqual([
        "agent-switched",
        "model-switched",
        "synthetic",
        "shell",
        "compaction",
      ])
      expect(messages.find((message) => message.type === "shell")).toMatchObject({
        output: "/project",
        time: { completed: DateTime.makeUnsafe(1) },
      })
      expect(messages.find((message) => message.type === "compaction")).toMatchObject({
        summary: "summary",
        recent: "recent context",
      })
      expect(
        yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie),
      ).toMatchObject({
        agent: "build",
        model,
        time_updated: DateTime.toEpochMillis(created),
      })
    }),
  )

  it.effect("rejects distinct creator events that reuse one projected message ID", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
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
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      const id = SessionMessage.ID.make("msg_creator_collision")

      yield* events.publish(SessionEvent.Synthetic, { sessionID, messageID: id, timestamp: created, text: "keep me" })
      const exit = yield* events
        .publish(SessionEvent.Step.Started, {
          sessionID,
          assistantMessageID: id,
          timestamp: created,
          agent: "build",
          model,
        })
        .pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      expect(
        yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, id)).get().pipe(Effect.orDie),
      ).toMatchObject({ type: "synthetic" })
    }),
  )

  it.effect("rejects a Prompted event that conflicts with an admitted inbox row", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
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
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      const id = SessionMessage.ID.make("msg_conflict")
      yield* SessionInput.admit(db, events, {
        id,
        sessionID,
        prompt: new Prompt({ text: "admitted" }),
        delivery: "steer",
      })

      const exit = yield* events
        .publish(SessionEvent.Prompted, {
          sessionID,
          messageID: id,
          timestamp: created,
          prompt: new Prompt({ text: "different" }),
          delivery: "steer",
        })
        .pipe(Effect.exit)

      expect(String(exit)).toContain("SessionInput.LifecycleConflict")
      expect(
        yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.id, id)).get().pipe(Effect.orDie),
      ).toMatchObject({ promoted_seq: null })
    }),
  )

  it.effect("rejects an assistant message ID that conflicts with an admitted inbox row", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
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
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      const id = SessionMessage.ID.make("msg_conflict")
      yield* SessionInput.admit(db, events, {
        id,
        sessionID,
        prompt: new Prompt({ text: "admitted" }),
        delivery: "steer",
      })

      const exit = yield* events
        .publish(SessionEvent.Step.Started, {
          sessionID,
          timestamp: created,
          assistantMessageID: id,
          agent: "build",
          model,
        })
        .pipe(Effect.exit)

      expect(String(exit)).toContain("SessionInput.LifecycleConflict")
      expect(
        yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, id)).get().pipe(Effect.orDie),
      ).toBeUndefined()
    }),
  )

  it.effect("rejects a Prompted delivery mode that conflicts with an admitted inbox row", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
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
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      const id = SessionMessage.ID.make("msg_delivery_conflict")
      const prompt = new Prompt({ text: "admitted" })
      yield* SessionInput.admit(db, events, { id, sessionID, prompt, delivery: "queue" })

      const exit = yield* events
        .publish(SessionEvent.Prompted, { sessionID, messageID: id, timestamp: created, prompt, delivery: "steer" })
        .pipe(Effect.exit)

      expect(String(exit)).toContain("SessionInput.LifecycleConflict")
      expect(
        yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.id, id)).get().pipe(Effect.orDie),
      ).toMatchObject({ delivery: "queue", promoted_seq: null })
    }),
  )

  it.effect("does not revive a stale incomplete in-memory assistant projection", () =>
    Effect.gen(function* () {
      const stale = new SessionMessage.Assistant({
        id: SessionMessage.ID.make("msg_assistant_stale"),
        type: "assistant",
        agent: "build",
        model,
        content: [],
        time: { created },
      })
      const completed = new SessionMessage.Assistant({
        id: SessionMessage.ID.make("msg_assistant_completed"),
        type: "assistant",
        agent: "build",
        model,
        content: [],
        time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
      })

      expect(
        yield* SessionMessageUpdater.memory({ messages: [stale, completed] }).getCurrentAssistant(),
      ).toBeUndefined()
    }),
  )

  it.effect("accepts a historical V1 interruption projected without synthetic structured metadata", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* events.publish(SessionV1.Event.Created, {
        sessionID,
        info: SessionV1.SessionInfo.make({
          id: sessionID,
          projectID: Project.ID.global,
          slug: "legacy-v1-interruption-projection",
          directory: "/project",
          title: "legacy-v1-interruption-projection",
          version: "test",
          time: { created: 1, updated: 1 },
        }),
      })
      const messageID = SessionMessage.ID.make("msg_legacy_v1_interruption_projection")
      const callID = "call_legacy_v1_interruption_projection"
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        timestamp: DateTime.makeUnsafe(2),
        assistantMessageID: messageID,
        agent: "build",
        model,
      })
      yield* events.publish(SessionEvent.Tool.Input.Started, {
        sessionID,
        timestamp: DateTime.makeUnsafe(3),
        assistantMessageID: messageID,
        callID,
        name: "question",
      })
      yield* events.publish(SessionEvent.Tool.Input.Ended, {
        sessionID,
        timestamp: DateTime.makeUnsafe(3),
        assistantMessageID: messageID,
        callID,
        text: JSON.stringify({ questions: [] }),
      })
      yield* events.publish(SessionEvent.Tool.Called, {
        sessionID,
        timestamp: DateTime.makeUnsafe(3),
        assistantMessageID: messageID,
        callID,
        tool: "question",
        input: { questions: [] },
        provider: { executed: false },
      })
      yield* events.publish(SessionEvent.Tool.FailedV1, {
        sessionID,
        timestamp: DateTime.makeUnsafe(4),
        assistantMessageID: messageID,
        callID,
        error: { type: "unknown", message: "Tool execution interrupted" },
        provider: { executed: false },
      })
      const row = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, messageID))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* Effect.die("Expected interrupted assistant projection")
      const data = row.data as unknown as Record<string, unknown>
      if (!Array.isArray(data.content)) return yield* Effect.die("Expected assistant content")
      const content = data.content.map((item: unknown) => {
        if (!isRecord(item) || item.type !== "tool" || item.id !== callID || !isRecord(item.state)) return item
        const structured = isRecord(item.state.structured) ? { ...item.state.structured } : {}
        delete structured.interrupted
        return { ...item, state: { ...item.state, structured } }
      })
      yield* db
        .update(SessionMessageTable)
        .set({ data: { ...data, content } as unknown as typeof row.data })
        .where(eq(SessionMessageTable.id, messageID))
        .run()
        .pipe(Effect.orDie)

      expect(yield* events.compactCheckpoint(sessionID)).toBeDefined()
    }),
  )

  it.effect("updates only the newest incomplete assistant projection", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
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
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionMessageTable)
        .values([
          assistantRow(SessionMessage.ID.make("msg_assistant_1"), 0),
          assistantRow(SessionMessage.ID.make("msg_assistant_2"), 1),
        ])
        .run()
        .pipe(Effect.orDie)

      const service = yield* EventV2.Service
      yield* service.publish(SessionEvent.Step.Ended, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        assistantMessageID: SessionMessage.ID.make("msg_assistant_2"),
        finish: "stop",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })

      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.id))
        .all()
        .pipe(Effect.orDie)
      const messages = rows.map((row) =>
        Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }),
      )
      expect(messages[0]).not.toHaveProperty("time.completed")
      expect(messages[1]).toMatchObject({
        type: "assistant",
        finish: "stop",
        time: { completed: DateTime.makeUnsafe(1) },
      })
    }),
  )

  it.effect("does not count dual-written legacy and V2 step usage twice", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      yield* events.publish(SessionV1.Event.Created, {
        sessionID,
        info: SessionV1.SessionInfo.make({
          id: sessionID,
          projectID: Project.ID.global,
          slug: "dual-write-usage",
          directory: "/project",
          title: "dual-write-usage",
          version: "test",
          agent: "build",
          time: { created: 1, updated: 1 },
        }),
      })
      const messageID = SessionV1.MessageID.make("msg_dual_write_usage")
      const tokens = { input: 12, output: 3, reasoning: 4, cache: { read: 5, write: 6 } }
      yield* events.publish(SessionV1.Event.MessageUpdated, {
        sessionID,
        info: {
          id: messageID,
          sessionID,
          role: "assistant",
          time: { created: 1, completed: 2 },
          parentID: SessionV1.MessageID.make("msg_dual_write_parent"),
          modelID: ModelV2.ID.make("model"),
          providerID: ProviderV2.ID.make("provider"),
          mode: "build",
          agent: "build",
          path: { cwd: "/project", root: "/project" },
          cost: 1,
          tokens,
        },
      })
      yield* events.publish(SessionV1.Event.PartUpdated, {
        sessionID,
        part: {
          id: SessionV1.PartID.make("prt_dual_write_usage"),
          sessionID,
          messageID,
          type: "step-finish",
          reason: "stop",
          cost: 1,
          tokens: { ...tokens, total: 24 },
        },
        time: 2,
      })
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        assistantMessageID: SessionMessage.ID.make(messageID),
        agent: "build",
        model,
      })
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID,
        timestamp: DateTime.makeUnsafe(2),
        assistantMessageID: SessionMessage.ID.make(messageID),
        finish: "stop",
        cost: 1,
        tokens,
      })

      expect(yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get()).toMatchObject({
        cost: 1,
        tokens_input: 12,
        tokens_output: 3,
        tokens_reasoning: 4,
        tokens_cache_read: 5,
        tokens_cache_write: 6,
      })
      yield* db.update(MessageTable).set({ time_updated: 999 }).where(eq(MessageTable.session_id, sessionID)).run()
      yield* db.update(PartTable).set({ time_updated: 999 }).where(eq(PartTable.session_id, sessionID)).run()
      const assistant = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, SessionMessage.ID.make(messageID)))
        .get()
        .pipe(Effect.orDie)
      if (!assistant) return yield* Effect.die("Expected projected assistant")
      yield* db
        .update(SessionMessageTable)
        .set({ time_updated: 2, data: { ...assistant.data, snapshot: {} } as typeof assistant.data })
        .where(eq(SessionMessageTable.id, assistant.id))
        .run()
      expect(yield* events.compactCheckpoint(sessionID)).toBeDefined()
    }),
  )

  it.effect("does not count V2-first dual-written step usage twice", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      yield* events.publish(SessionV1.Event.Created, {
        sessionID,
        info: SessionV1.SessionInfo.make({
          id: sessionID,
          projectID: Project.ID.global,
          slug: "v2-first-dual-write-usage",
          directory: "/project",
          title: "v2-first-dual-write-usage",
          version: "test",
          agent: "build",
          time: { created: 1, updated: 1 },
        }),
      })
      const messageID = SessionV1.MessageID.make("msg_v2_first_dual_write_usage")
      const tokens = { input: 12, output: 3, reasoning: 4, cache: { read: 5, write: 6 } }
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        assistantMessageID: SessionMessage.ID.make(messageID),
        agent: "build",
        model,
      })
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID,
        timestamp: DateTime.makeUnsafe(2),
        assistantMessageID: SessionMessage.ID.make(messageID),
        finish: "stop",
        cost: 1,
        tokens,
      })
      yield* events.publish(SessionV1.Event.MessageUpdated, {
        sessionID,
        info: {
          id: messageID,
          sessionID,
          role: "assistant",
          time: { created: 1, completed: 2 },
          parentID: SessionV1.MessageID.make("msg_v2_first_dual_write_parent"),
          modelID: ModelV2.ID.make("model"),
          providerID: ProviderV2.ID.make("provider"),
          mode: "build",
          agent: "build",
          path: { cwd: "/project", root: "/project" },
          cost: 1,
          tokens,
        },
      })
      yield* events.publish(SessionV1.Event.PartUpdated, {
        sessionID,
        part: {
          id: SessionV1.PartID.make("prt_v2_first_dual_write_usage"),
          sessionID,
          messageID,
          type: "step-finish",
          reason: "stop",
          cost: 1,
          tokens: { ...tokens, total: 24 },
        },
        time: 2,
      })

      expect(yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get()).toMatchObject({
        cost: 1,
        tokens_input: 12,
        tokens_output: 3,
        tokens_reasoning: 4,
        tokens_cache_read: 5,
        tokens_cache_write: 6,
      })
      yield* events.publish(SessionV1.Event.PartRemoved, {
        sessionID,
        messageID,
        partID: SessionV1.PartID.make("prt_v2_first_dual_write_usage"),
      })
      expect(yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get()).toMatchObject({
        cost: 1,
        tokens_input: 12,
        tokens_output: 3,
        tokens_reasoning: 4,
        tokens_cache_read: 5,
        tokens_cache_write: 6,
      })
      yield* events.publish(SessionV1.Event.PartUpdated, {
        sessionID,
        part: {
          id: SessionV1.PartID.make("prt_v2_first_dual_write_usage"),
          sessionID,
          messageID,
          type: "step-finish",
          reason: "stop",
          cost: 1,
          tokens: { ...tokens, total: 24 },
        },
        time: 3,
      })
      yield* events.publish(SessionV1.Event.MessageRemoved, { sessionID, messageID })
      expect(yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get()).toMatchObject({
        cost: 1,
        tokens_input: 12,
        tokens_output: 3,
        tokens_reasoning: 4,
        tokens_cache_read: 5,
        tokens_cache_write: 6,
      })
      yield* events.publish(SessionEvent.Revert.Cleaned, {
        sessionID,
        timestamp: DateTime.makeUnsafe(4),
        revert: { messageID: SessionMessage.ID.make(messageID) },
        messageIDs: [SessionMessage.ID.make(messageID)],
      })
      expect(yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get()).toMatchObject({
        cost: 0,
        tokens_input: 0,
        tokens_output: 0,
        tokens_reasoning: 0,
        tokens_cache_read: 0,
        tokens_cache_write: 0,
      })
    }),
  )

  it.effect("accepts initial legacy message clock drift but keeps current checkpoint tails strict", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      yield* events.publish(SessionV1.Event.Created, {
        sessionID,
        info: SessionV1.SessionInfo.make({
          id: sessionID,
          projectID: Project.ID.global,
          slug: "message-update-time",
          directory: "/project",
          title: "message-update-time",
          version: "test",
          time: { created: 1, updated: 1 },
        }),
      })
      yield* events.publish(SessionEvent.AgentSwitched, {
        sessionID,
        messageID: SessionMessage.ID.make("msg_message_update_time_agent"),
        timestamp: DateTime.makeUnsafe(10),
        agent: "reviewer",
      })

      yield* db
        .update(SessionMessageTable)
        .set({ time_updated: 66 })
        .where(eq(SessionMessageTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)

      expect(yield* events.compactCheckpoint(sessionID)).toBeDefined()

      yield* db
        .update(SessionMessageTable)
        .set({ time_updated: 77 })
        .where(eq(SessionMessageTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)

      const rejected = yield* events.compactCheckpoint(sessionID).pipe(Effect.exit)
      expect(String(rejected)).toContain("active checkpoint projection reference hash or counts differ")
    }),
  )

  it.effect("accepts stale legacy tool raw input only before the current checkpoint", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      yield* events.publish(SessionV1.Event.Created, {
        sessionID,
        info: SessionV1.SessionInfo.make({
          id: sessionID,
          projectID: Project.ID.global,
          slug: "legacy-tool-raw",
          directory: "/project",
          title: "legacy-tool-raw",
          version: "test",
          time: { created: 1, updated: 1 },
        }),
      })
      const messageID = SessionV1.MessageID.make("msg_legacy_tool_raw")
      const partID = SessionV1.PartID.make("prt_legacy_tool_raw")
      yield* events.publish(SessionV1.Event.MessageUpdated, {
        sessionID,
        info: {
          id: messageID,
          sessionID,
          role: "assistant",
          time: { created: 2 },
          parentID: SessionV1.MessageID.make("msg_legacy_tool_raw_parent"),
          modelID: ModelV2.ID.make("model"),
          providerID: ProviderV2.ID.make("provider"),
          mode: "build",
          agent: "build",
          path: { cwd: "/project", root: "/project" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      })
      yield* events.publish(SessionV1.Event.PartUpdated, {
        sessionID,
        part: {
          id: partID,
          sessionID,
          messageID,
          type: "tool",
          callID: "call_legacy_tool_raw",
          tool: "glob",
          state: { status: "pending", input: {}, raw: "" },
        },
        time: 3,
      })
      yield* events.publish(SessionV1.Event.PartUpdated, {
        sessionID,
        part: {
          id: partID,
          sessionID,
          messageID,
          type: "tool",
          callID: "call_legacy_tool_raw",
          tool: "glob",
          state: {
            status: "error",
            input: {},
            error: "Tool execution aborted",
            metadata: { interrupted: true },
            time: { start: 4, end: 4 },
          },
        },
        time: 4,
      })
      const part = yield* db.select().from(PartTable).where(eq(PartTable.id, partID)).get().pipe(Effect.orDie)
      const data = part?.data as unknown as Record<string, unknown> | undefined
      if (!part || data?.type !== "tool" || !data.state || typeof data.state !== "object" || Array.isArray(data.state))
        return yield* Effect.die("Expected projected tool part")
      yield* db
        .update(PartTable)
        .set({
          data: { ...part.data, state: { ...(data.state as Record<string, unknown>), raw: "" } } as typeof part.data,
          time_updated: part.time_updated,
        })
        .where(eq(PartTable.id, partID))
        .run()
        .pipe(Effect.orDie)

      expect(yield* events.compactCheckpoint(sessionID)).toBeDefined()

      yield* db
        .update(PartTable)
        .set({ data: part.data, time_updated: part.time_updated })
        .where(eq(PartTable.id, partID))
        .run()
        .pipe(Effect.orDie)
      const rejected = yield* events.compactCheckpoint(sessionID).pipe(Effect.exit)
      expect(String(rejected)).toContain("active checkpoint projection reference hash or counts differ")
    }),
  )

  it.effect("accepts externalized legacy tool output only before the current checkpoint", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      yield* events.publish(SessionV1.Event.Created, {
        sessionID,
        info: SessionV1.SessionInfo.make({
          id: sessionID,
          projectID: Project.ID.global,
          slug: "externalized-legacy-tool-output",
          directory: "/project",
          title: "externalized-legacy-tool-output",
          version: "test",
          time: { created: 1, updated: 1 },
        }),
      })
      const messageID = SessionV1.MessageID.make("msg_externalized_legacy_tool_output")
      const partID = SessionV1.PartID.make("prt_externalized_legacy_tool_output")
      const output = "production tool output\n".repeat(600).slice(0, 12_987)
      const command = "findstr /s /n /i opencode *"
      yield* events.publish(SessionV1.Event.MessageUpdated, {
        sessionID,
        info: {
          id: messageID,
          sessionID,
          role: "assistant",
          time: { created: 2 },
          parentID: SessionV1.MessageID.make("msg_externalized_legacy_tool_output_parent"),
          modelID: ModelV2.ID.make("model"),
          providerID: ProviderV2.ID.make("provider"),
          mode: "build",
          agent: "build",
          path: { cwd: "/project", root: "/project" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      })
      yield* events.publish(SessionV1.Event.PartUpdated, {
        sessionID,
        part: {
          id: partID,
          sessionID,
          messageID,
          type: "tool",
          callID: "tool_externalized_legacy_tool_output",
          tool: "bash",
          state: { status: "pending", input: { command }, raw: "" },
          metadata: { providerExecuted: true },
        },
        time: 3,
      })
      yield* events.publish(SessionV1.Event.PartUpdated, {
        sessionID,
        part: {
          id: partID,
          sessionID,
          messageID,
          type: "tool",
          callID: "tool_externalized_legacy_tool_output",
          tool: "bash",
          state: {
            status: "running",
            input: { command },
            title: command,
            metadata: { command },
            time: { start: 4 },
          },
          metadata: { providerExecuted: true },
        },
        time: 4,
      })
      yield* events.publish(SessionV1.Event.PartUpdated, {
        sessionID,
        part: {
          id: partID,
          sessionID,
          messageID,
          type: "tool",
          callID: "tool_externalized_legacy_tool_output",
          tool: "bash",
          state: {
            status: "completed",
            input: { command },
            output,
            title: command,
            metadata: { command, output, exit: 0 },
            time: { start: 4, end: 5 },
          },
          metadata: { providerExecuted: true },
        },
        time: 5,
      })

      const part = yield* db.select().from(PartTable).where(eq(PartTable.id, partID)).get().pipe(Effect.orDie)
      const data = part?.data as unknown as Record<string, unknown> | undefined
      if (!part || data?.type !== "tool" || !data.state || typeof data.state !== "object" || Array.isArray(data.state))
        return yield* Effect.die("Expected projected tool part")
      const state = data.state as Record<string, unknown>
      if (!state.metadata || typeof state.metadata !== "object" || Array.isArray(state.metadata))
        return yield* Effect.die("Expected projected tool metadata")
      const migrated = {
        ...part.data,
        state: {
          ...state,
          output: boundedPersistedContentPreview(output),
          metadata: {
            ...(state.metadata as Record<string, unknown>),
            output: boundedPersistedContentPreview(output),
            $opencode: {
              output: {
                type: "content-reference",
                uri: "attachment://att_6e5c6ec9a9d8ddcca0bcd44fe3d205e5",
                mime: "text/plain",
                sizeBytes: Buffer.byteLength(output, "utf8"),
              },
            },
          },
        },
      } as typeof part.data
      yield* db
        .update(PartTable)
        .set({ data: migrated, time_updated: part.time_updated })
        .where(eq(PartTable.id, partID))
        .run()
        .pipe(Effect.orDie)

      expect(yield* events.compactCheckpoint(sessionID)).toBeDefined()

      yield* db
        .update(PartTable)
        .set({
          data: {
            ...migrated,
            state: { ...state, output: boundedPersistedContentPreview(output), metadata: state.metadata },
          } as typeof part.data,
          time_updated: part.time_updated,
        })
        .where(eq(PartTable.id, partID))
        .run()
        .pipe(Effect.orDie)
      const rejected = yield* events.compactCheckpoint(sessionID).pipe(Effect.exit)
      expect(String(rejected)).toContain("active checkpoint projection reference hash or counts differ")
    }),
  )

  it.effect("accepts empty legacy snapshot boundaries in projected assistant messages", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      yield* events.publish(SessionV1.Event.Created, {
        sessionID,
        info: SessionV1.SessionInfo.make({
          id: sessionID,
          projectID: Project.ID.global,
          slug: "empty-snapshot-boundaries",
          directory: "/project",
          title: "empty-snapshot-boundaries",
          version: "test",
          time: { created: 1, updated: 1 },
        }),
      })
      const messageID = SessionMessage.ID.make("msg_empty_snapshot_boundaries")
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        timestamp: DateTime.makeUnsafe(2),
        assistantMessageID: messageID,
        agent: "build",
        model,
        snapshot: "",
      })
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID,
        timestamp: DateTime.makeUnsafe(3),
        assistantMessageID: messageID,
        finish: "tool-calls",
        cost: 0,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        snapshot: "",
      })
      const assistant = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, messageID))
        .get()
        .pipe(Effect.orDie)
      if (!assistant) return yield* Effect.die("Expected projected assistant")
      yield* db
        .update(SessionMessageTable)
        .set({ data: { ...assistant.data, snapshot: { start: "", end: "" } } as typeof assistant.data })
        .where(eq(SessionMessageTable.id, messageID))
        .run()
        .pipe(Effect.orDie)

      expect(yield* events.compactCheckpoint(sessionID)).toBeDefined()
    }),
  )

  it.effect("seeds source and destination projects when checkpointing a moved session", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sourceProject = Project.ID.make("checkpoint-source-project")
      const destinationProject = Project.ID.make("checkpoint-destination-project")
      yield* db
        .insert(ProjectTable)
        .values([
          { id: sourceProject, worktree: AbsolutePath.make("/source"), sandboxes: [] },
          { id: destinationProject, worktree: AbsolutePath.make("/destination"), sandboxes: [] },
        ])
        .run()
        .pipe(Effect.orDie)
      expect(
        yield* db.select({ id: ProjectTable.id }).from(ProjectTable).where(eq(ProjectTable.id, sourceProject)).all(),
      ).toEqual([{ id: sourceProject }])
      const events = yield* EventV2.Service
      yield* events.publish(SessionV1.Event.Created, {
        sessionID,
        info: SessionV1.SessionInfo.make({
          id: sessionID,
          projectID: sourceProject,
          slug: "moved-session",
          directory: "/source",
          title: "moved-session",
          version: "test",
          time: { created: 1, updated: 1 },
        }),
      })
      yield* events.publish(SessionEvent.Moved, {
        sessionID,
        timestamp: DateTime.makeUnsafe(2),
        location: Location.Ref.make({ directory: AbsolutePath.make("/destination") }),
        projectID: destinationProject,
      })

      expect(yield* events.compactCheckpoint(sessionID)).toBeDefined()
    }),
  )

  it.effect("replays a legacy global SessionCreated event after canonical project and clock migration", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const legacySessionID = SessionV2.ID.make("ses_legacy_global_project_migration")
      const canonicalProjectID = Project.ID.make("0123456789abcdef0123456789abcdef01234567")
      yield* db
        .insert(ProjectTable)
        .values([
          { id: Project.ID.global, worktree: AbsolutePath.make("/legacy-global"), sandboxes: [] },
          { id: canonicalProjectID, worktree: AbsolutePath.make("/legacy-global"), sandboxes: [] },
        ])
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      yield* events.publish(SessionV1.Event.Created, {
        sessionID: legacySessionID,
        info: SessionV1.SessionInfo.make({
          id: legacySessionID,
          projectID: Project.ID.global,
          slug: "legacy-global-project-migration",
          directory: "/legacy-global",
          title: "legacy-global-project-migration",
          version: "test",
          time: { created: 1, updated: 1 },
        }),
      })
      yield* events.publish(SessionV1.Event.Updated, {
        sessionID: legacySessionID,
        info: SessionV1.SessionInfo.make({
          id: legacySessionID,
          projectID: Project.ID.global,
          slug: "legacy-global-project-migration",
          directory: "/legacy-global",
          title: "later legacy title",
          version: "test",
          time: { created: 1, updated: 14 },
        }),
      })
      yield* db
        .update(SessionTable)
        .set({ project_id: canonicalProjectID, time_updated: 20 })
        .where(eq(SessionTable.id, legacySessionID))
        .run()
        .pipe(Effect.orDie)

      expect(yield* events.compactCheckpoint(legacySessionID)).toBeDefined()
    }),
  )

  it.effect("replays a valid legacy plan document written directly to materialized session metadata", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const legacySessionID = SessionV2.ID.make("ses_legacy_plan_document_metadata")
      const metadata = { access_control: { mode: "plan" } }
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/legacy-plan"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      yield* events.publish(SessionV1.Event.Created, {
        sessionID: legacySessionID,
        info: SessionV1.SessionInfo.make({
          id: legacySessionID,
          projectID: Project.ID.global,
          slug: "legacy-plan-document",
          directory: "/legacy-plan",
          title: "legacy-plan-document",
          version: "legacy",
          metadata,
          time: { created: 1, updated: 1 },
        }),
      })
      yield* events.publish(SessionV1.Event.Updated, {
        sessionID: legacySessionID,
        info: SessionV1.SessionInfo.make({
          id: legacySessionID,
          projectID: Project.ID.global,
          slug: "legacy-plan-document",
          directory: "/legacy-plan",
          title: "updated legacy plan document",
          version: "legacy",
          metadata,
          time: { created: 1, updated: 2 },
        }),
      })
      yield* db
        .update(SessionTable)
        .set({
          metadata: {
            ...metadata,
            [SessionPlanDocument.MetadataKey]: { markdown: "# Historical plan", revision: 4, updatedAt: 1784796654179 },
          },
          time_updated: 2,
        })
        .where(eq(SessionTable.id, legacySessionID))
        .run()
        .pipe(Effect.orDie)

      expect(yield* events.compactCheckpoint(legacySessionID)).toBeDefined()
    }),
  )

  for (const scenario of [
    { name: "malformed plan metadata", plan: { markdown: "# Invalid", revision: "4", updatedAt: 1784796654179 } },
    {
      name: "unrelated metadata drift",
      plan: { markdown: "# Valid", revision: 4, updatedAt: 1784796654179 },
      unrelated: true,
    },
  ])
    it.effect(`rejects ${scenario.name} during legacy plan replay repair`, () =>
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const legacySessionID = SessionV2.ID.make(`ses_legacy_plan_reject_${scenario.unrelated ? "drift" : "malformed"}`)
        const metadata = { access_control: { mode: "plan" } }
        yield* db
          .insert(ProjectTable)
          .values({ id: Project.ID.global, worktree: AbsolutePath.make("/legacy-plan-reject"), sandboxes: [] })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        const events = yield* EventV2.Service
        yield* events.publish(SessionV1.Event.Created, {
          sessionID: legacySessionID,
          info: SessionV1.SessionInfo.make({
            id: legacySessionID,
            projectID: Project.ID.global,
            slug: "legacy-plan-reject",
            directory: "/legacy-plan-reject",
            title: "legacy-plan-reject",
            version: "legacy",
            metadata,
            time: { created: 1, updated: 1 },
          }),
        })
        yield* db
          .update(SessionTable)
          .set({
            metadata: {
              ...metadata,
              [SessionPlanDocument.MetadataKey]: scenario.plan,
              ...(scenario.unrelated ? { unrelated: "drift" } : {}),
            },
            time_updated: 1,
          })
          .where(eq(SessionTable.id, legacySessionID))
          .run()
          .pipe(Effect.orDie)

        const result = yield* events.compactCheckpoint(legacySessionID).pipe(Effect.exit)
        expect(result._tag).toBe("Failure")
        expect(String(result)).toContain("session.metadata")
      }),
    )

  it.effect("rejects arbitrary session timestamp drift outside the legacy global project migration", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const migratedSessionID = SessionV2.ID.make("ses_non_global_project_mismatch")
      const eventProjectID = Project.ID.make("legacy-project-id")
      yield* db
        .insert(ProjectTable)
        .values({ id: eventProjectID, worktree: AbsolutePath.make("/non-global"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      yield* events.publish(SessionV1.Event.Created, {
        sessionID: migratedSessionID,
        info: SessionV1.SessionInfo.make({
          id: migratedSessionID,
          projectID: eventProjectID,
          slug: "non-global-project-mismatch",
          directory: "/non-global",
          title: "non-global-project-mismatch",
          version: "test",
          time: { created: 1, updated: 1 },
        }),
      })
      yield* db
        .update(SessionTable)
        .set({ project_id: eventProjectID, time_updated: 10 })
        .where(eq(SessionTable.id, migratedSessionID))
        .run()
        .pipe(Effect.orDie)

      const result = yield* events.compactCheckpoint(migratedSessionID).pipe(Effect.exit)
      expect(result._tag).toBe("Failure")
      expect(String(result)).toContain("session.time_updated differs")
    }),
  )

  it.effect("rejects a non-global SessionCreated project that differs from the current projection", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const migratedSessionID = SessionV2.ID.make("ses_non_global_project_mismatch")
      const eventProjectID = Project.ID.make("legacy-project-id")
      const canonicalProjectID = Project.ID.make("89abcdef0123456789abcdef0123456789abcdef")
      yield* db
        .insert(ProjectTable)
        .values([
          { id: eventProjectID, worktree: AbsolutePath.make("/non-global"), sandboxes: [] },
          { id: canonicalProjectID, worktree: AbsolutePath.make("/non-global"), sandboxes: [] },
        ])
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      yield* events.publish(SessionV1.Event.Created, {
        sessionID: migratedSessionID,
        info: SessionV1.SessionInfo.make({
          id: migratedSessionID,
          projectID: eventProjectID,
          slug: "non-global-project-mismatch",
          directory: "/non-global",
          title: "non-global-project-mismatch",
          version: "test",
          time: { created: 1, updated: 1 },
        }),
      })
      yield* db
        .update(SessionTable)
        .set({ project_id: canonicalProjectID, time_updated: 1 })
        .where(eq(SessionTable.id, migratedSessionID))
        .run()
        .pipe(Effect.orDie)

      const result = yield* events.compactCheckpoint(migratedSessionID).pipe(Effect.exit)
      expect(result._tag).toBe("Failure")
      expect(String(result)).toContain("session.project_id differs")
    }),
  )

  it.effect("replays OpenCode turn completion events while preserving the Session projection", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      yield* events.publish(SessionV1.Event.Created, {
        sessionID,
        info: SessionV1.SessionInfo.make({
          id: sessionID,
          projectID: Project.ID.global,
          slug: "turn-completion-replay",
          directory: "/project",
          title: "turn-completion-replay",
          version: "test",
          time: { created: 1, updated: 1 },
        }),
      })
      yield* events.publish(SessionEvent.TurnCompleted, { sessionID, status: "incomplete" })

      expect(yield* events.compactCheckpoint(sessionID)).toBeDefined()
      expect(
        yield* db
          .select({ type: EventTable.type, data: EventTable.data })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, sessionID))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([])
    }),
  )

  it.effect("does not revive a stale incomplete assistant projection", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
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
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionMessageTable)
        .values([
          assistantRow(SessionMessage.ID.make("msg_assistant_stale"), 0),
          assistantRow(SessionMessage.ID.make("msg_assistant_completed"), 1, {
            created: DateTime.makeUnsafe(1),
            completed: DateTime.makeUnsafe(2),
          }),
        ])
        .run()
        .pipe(Effect.orDie)

      const service = yield* EventV2.Service
      yield* service.publish(SessionEvent.Text.Started, {
        sessionID,
        assistantMessageID: SessionMessage.ID.make("msg_assistant_completed"),
        timestamp: DateTime.makeUnsafe(3),
        textID: "text-stale",
      })

      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.id))
        .all()
        .pipe(Effect.orDie)
      const messages = rows.map((row) =>
        Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }),
      )
      expect(messages).toEqual([
        new SessionMessage.Assistant({
          id: SessionMessage.ID.make("msg_assistant_completed"),
          type: "assistant",
          agent: "build",
          model,
          content: [new SessionMessage.AssistantText({ type: "text", id: "text-stale", text: "" })],
          time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
        }),
        new SessionMessage.Assistant({
          id: SessionMessage.ID.make("msg_assistant_stale"),
          type: "assistant",
          agent: "build",
          model,
          content: [],
          time: { created },
        }),
      ])
    }),
  )

  it.effect("atomically preserves a manual title over a stale generated title", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const defaultTitle = "New session - 2026-07-08T00:00:00.000Z"
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
          slug: "test",
          directory: "/project",
          title: defaultTitle,
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)

      const service = yield* EventV2.Service
      yield* service.publish(SessionEvent.TitleUpdated, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        title: "Manual Title",
      })
      const generated = yield* service
        .publish(
          SessionEvent.TitleUpdated,
          { sessionID, timestamp: DateTime.makeUnsafe(2), title: "Generated Title" },
          { metadata: { [SessionEvent.GeneratedTitleExpectedMetadataKey]: defaultTitle } },
        )
        .pipe(Effect.exit)

      expect(generated._tag).toBe("Failure")
      expect(
        yield* db
          .select({ title: SessionTable.title })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ title: "Manual Title" })
      expect(
        yield* db
          .select({ id: EventTable.id })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, sessionID))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(1)
    }),
  )
})
