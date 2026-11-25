import { describe, expect } from "bun:test"
import { asc, eq } from "drizzle-orm"
import { DateTime, Effect, Exit, Layer, Schema } from "effect"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { writeFile } from "node:fs/promises"
import { SessionForkAttachments } from "@opencode-ai/core/session/fork-attachments"
import { AgentV2 } from "@opencode-ai/core/agent"
import { AttachmentTable } from "@opencode-ai/core/attachment.sql"
import { ContentStore } from "@opencode-ai/core/content-store"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventCheckpointTable, EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { ModelV2 } from "@opencode-ai/core/model"
import { Location } from "@opencode-ai/core/location"
import { SystemContext } from "@opencode-ai/core/system-context/index"
import { SessionContextEpoch } from "@opencode-ai/core/session/context-epoch"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionForkImport } from "@opencode-ai/core/session/fork-import"
import { SessionForkEvent } from "@opencode-ai/core/session/fork-event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import {
  SessionActivityTable,
  SessionContextEpochTable,
  SessionInputTable,
  SessionMessageTable,
  SessionTable,
} from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const it = testEffect(Layer.empty)
const sourceID = SessionSchema.ID.make("ses_import_source")
const childID = SessionSchema.ID.make("ses_import_child")
const userID = SessionMessage.ID.make("msg_import_user")
const assistantID = SessionMessage.ID.make("msg_import_assistant")
const syntheticID = SessionMessage.ID.make("msg_import_synthetic")
const model = { id: ModelV2.ID.make("fixture"), providerID: ProviderV2.ID.make("fixture"), variant: "high" }

const fixture = (childAgent = "build") => Effect.gen(function* () {
  const { db } = yield* Database.Service
  const events = yield* EventV2.Service
  const content = yield* ContentStore.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/fork"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sourceID,
      project_id: ProjectV2.ID.global,
      directory: "/fork",
      slug: "source",
      title: "source",
      version: "test",
      agent: "build",
      model,
      metadata: { capabilityLease: "source-only" },
    })
    .run()
    .pipe(Effect.orDie)
  yield* events.publish(SessionV1.Event.Created, {
    sessionID: childID,
    info: SessionV1.SessionInfo.make({
      id: childID,
      parentID: sourceID,
      projectID: ProjectV2.ID.global,
      directory: "/fork/child",
      slug: "child",
      title: "child",
      version: "test",
      agent: childAgent,
      model,
      time: { created: 1, updated: 1 },
    }),
  })
  const file = yield* content.storeTextAttachment({
    sessionID: sourceID,
    messageID: userID,
    key: "fixture",
    text: "original bytes",
    mime: "text/plain",
    name: "evidence.txt",
  })
  yield* db.insert(EventSequenceTable).values({ aggregate_id: sourceID, seq: 10 }).run().pipe(Effect.orDie)
  yield* db
    .insert(SessionContextEpochTable)
    .values({
      session_id: sourceID,
      agent: AgentV2.ID.make("build"),
      baseline: "shared context",
      baseline_seq: 1,
      snapshot: {},
      revision: 4,
    })
    .run()
    .pipe(Effect.orDie)
  const history = [
    {
      id: userID,
      session_id: sourceID,
      seq: 1,
      type: "user",
      data: {
        text: `Read ${file.uri}`,
        files: [file],
        metadata: { oldGrant: true, unused: "attachment://att_not_inherited" },
        time: { created: 1 },
      },
    },
    {
      id: syntheticID,
      session_id: sourceID,
      seq: 2,
      type: "synthetic",
      data: { sessionID: sourceID, text: "Prior operational context", time: { created: 2 } },
    },
    {
      id: assistantID,
      session_id: sourceID,
      seq: 3,
      type: "assistant",
      data: {
        agent: "build",
        model,
        finish: "tool-calls",
        time: { created: 3, completed: 4 },
        metadata: { oldApproval: "not cloned" },
        snapshot: { start: "old-snapshot" },
        content: [
          {
            type: "tool",
            id: "call_probe",
            name: "read",
            state: {
              status: "completed",
              input: { path: "evidence.txt" },
              structured: { attachment: file.uri },
              content: [{ type: "file", uri: file.uri, mime: file.mime }],
              attachments: [file],
            },
            time: { created: 3, completed: 4 },
          },
          {
            type: "custom",
            id: "old-control",
            kind: "surface",
            data: { approval: true, uri: "attachment://att_not_inherited" },
          },
        ],
      },
    },
  ] as const
  yield* db
    .insert(SessionMessageTable)
    .values([...history])
    .run()
    .pipe(Effect.orDie)
  const prepare = () =>
    SessionForkImport.prepare(db, content, { sourceSessionID: sourceID, childSessionID: childID, throughSeq: 10 })
  const messages = () =>
    db
      .select()
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.session_id, childID))
      .orderBy(asc(SessionMessageTable.seq))
      .all()
      .pipe(Effect.orDie)
  return { db, events, content, file, prepare, messages }
})

function withFixture<A, E, R>(body: (value: Effect.Success<ReturnType<typeof fixture>>) => Effect.Effect<A, E, R>, childAgent = "build") {
  return Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => {
      const database = Database.layerFromPath(":memory:")
      const events = EventV2.layer.pipe(Layer.provide(database))
      const projector = SessionProjector.layer.pipe(Layer.provide(database), Layer.provide(events))
      const content = ContentStore.layer.pipe(
        Layer.provide(database),
        Layer.provide(FSUtil.defaultLayer),
        Layer.provide(Global.layerWith({ data: tmp.path })),
      )
      return fixture(childAgent).pipe(Effect.flatMap(body), Effect.provide(Layer.mergeAll(database, events, projector, content)))
    },
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )
}

describe("event-backed V2 fork materialization", () => {
  it.live("rejects a history boundary that is not bound to the child's imported history", () =>
    withFixture(({ db, events }) => Effect.gen(function* () {
      for (const input of [
        { sourceSessionID: SessionSchema.ID.make("ses_foreign"), throughSeq: -1 },
        { sourceSessionID: sourceID, throughSeq: 0 },
      ]) {
        expect(Exit.isFailure(yield* Effect.exit(events.publish(SessionForkEvent.HistoryBoundaryImported, {
          sessionID: childID, ...input,
        })))).toBe(true)
        expect((yield* db.select().from(SessionTable).where(eq(SessionTable.id, childID)).get().pipe(Effect.orDie))?.fork_history_seq).toBeNull()
      }
    })),
  )
  it.live("does not mark pre-existing non-imported messages as inherited history", () =>
    withFixture(({ db, events }) => Effect.gen(function* () {
      const foreignID = SessionMessage.ID.make("msg_child_preexisting")
      const { id: _id, type: _type, ...data } = Schema.encodeSync(SessionMessage.Message)(
        Schema.decodeUnknownSync(SessionMessage.Message)({
          id: foreignID, type: "user", text: "not imported", time: { created: 1 },
        }),
      )
      yield* db.insert(SessionMessageTable).values({
        id: foreignID, session_id: childID, seq: 0, type: "user", data,
      }).run().pipe(Effect.orDie)
      const message = Schema.decodeUnknownSync(SessionMessage.Message)({
        id: SessionMessage.ID.make("msg_child_imported"), type: "user", text: "imported", time: { created: 2 },
      })
      const imported = yield* events.publish(SessionForkEvent.MessageImported, {
        sessionID: childID, sourceSessionID: sourceID, sourceMessageID: userID,
        timestamp: yield* DateTime.now, message,
      })
      if (imported.seq === undefined) throw new Error("Missing imported sequence")
      expect(Exit.isFailure(yield* Effect.exit(events.publish(SessionForkEvent.HistoryBoundaryImported, {
        sessionID: childID, sourceSessionID: sourceID, throughSeq: imported.seq,
      })))).toBe(true)
      expect((yield* db.select().from(SessionTable).where(eq(SessionTable.id, childID)).get().pipe(Effect.orDie))?.fork_history_seq).toBeNull()
    })),
  )
  it.live("refuses an inherited parent epoch for a different child agent", () =>
    withFixture(({ db, events, prepare, messages }) => Effect.gen(function* () {
      const token = yield* prepare()
      expect(Exit.isFailure(yield* Effect.exit(SessionForkImport.materialize(db, events, token)))).toBe(true)
      expect(yield* messages()).toEqual([])
      expect(yield* db.select().from(SessionContextEpochTable).where(eq(SessionContextEpochTable.session_id, childID)).get().pipe(Effect.orDie)).toBeUndefined()
    }), "review"),
  )
  for (const drift of [false, true]) it.live(`revalidates a compacted dispatch input without restoring dialogue (drift=${drift})`, () =>
    withFixture(({ db, events, content, messages }) => Effect.gen(function* () {
      yield* db.delete(SessionMessageTable).where(eq(SessionMessageTable.id, syntheticID)).run().pipe(Effect.orDie)
      const makeData = (message: unknown) => {
        const { id: _id, type: _type, ...data } = Schema.encodeSync(SessionMessage.Message)(
          Schema.decodeUnknownSync(SessionMessage.Message)(message),
        )
        return data
      }
      yield* db.update(SessionMessageTable).set({ data: makeData({ id: userID, type: "user", text: "Original assignment", time: { created: 1 } }) })
        .where(eq(SessionMessageTable.id, userID)).run().pipe(Effect.orDie)
      yield* db.insert(SessionInputTable).values({ id: userID, session_id: sourceID,
        prompt: { text: "Original assignment" }, delivery: "steer", admitted_seq: 0, promoted_seq: 1 }).run().pipe(Effect.orDie)
      yield* db.insert(SessionMessageTable).values({ id: syntheticID, session_id: sourceID, type: "compaction", seq: 2,
        data: makeData({ id: syntheticID, type: "compaction", reason: "manual", summary: "Summary context only", recent: "", time: { created: 2 } }) }).run().pipe(Effect.orDie)
      yield* db.update(SessionMessageTable).set({ data: makeData({ id: assistantID, type: "assistant", agent: "build", model,
        time: { created: 3 }, content: [{ type: "tool", id: "dispatch", name: "multi_agent_fanout",
          state: { status: "running", input: {}, structured: {}, content: [] }, time: { created: 3 } }] }) })
        .where(eq(SessionMessageTable.id, assistantID)).run().pipe(Effect.orDie)
      const token = yield* SessionForkImport.prepare(db, content, { sourceSessionID: sourceID, childSessionID: childID,
        throughSeq: 10, dispatch: { assistantMessageID: assistantID, toolCallID: "dispatch" } })
      if (drift) {
        // Both rows still agree. The prepared token must nevertheless bind the
        // original assignment, even though it is not in the imported history.
        yield* db.update(SessionMessageTable).set({ data: makeData({ id: userID, type: "user", text: "Changed assignment", time: { created: 1 } }) })
          .where(eq(SessionMessageTable.id, userID)).run().pipe(Effect.orDie)
        yield* db.update(SessionInputTable).set({ prompt: { text: "Changed assignment" } })
          .where(eq(SessionInputTable.id, userID)).run().pipe(Effect.orDie)
        expect(Exit.isFailure(yield* Effect.exit(SessionForkImport.materialize(db, events, token)))).toBe(true)
        expect(yield* messages()).toEqual([])
        return
      }
      yield* SessionForkImport.materialize(db, events, token)
      expect((yield* messages()).map((row) => row.type)).toEqual(["compaction"])
      expect(yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.session_id, childID)).all().pipe(Effect.orDie)).toEqual([])
      expect(yield* db.select().from(AttachmentTable).where(eq(AttachmentTable.session_id, childID)).all().pipe(Effect.orDie)).toEqual([])
    })),
  )
  for (const drift of ["none", "progress", "policy", "missing-event", "other-event", "child-agent"] as const) it.live(`rechecks a native dispatch boundary with ${drift}`, () =>
    withFixture(({ db, events, content, file, messages }) => Effect.gen(function* () {
      yield* db.delete(SessionMessageTable).where(eq(SessionMessageTable.id, syntheticID)).run().pipe(Effect.orDie)
      const { id: _id, type: _type, ...data } = Schema.encodeSync(SessionMessage.Message)(
        Schema.decodeUnknownSync(SessionMessage.Message)({
          id: assistantID, type: "assistant", agent: "build", model, time: { created: 3 }, content: [
            { type: "tool", id: "dispatch", name: "task", state: { status: "running", input: {}, structured: {}, content: [] }, time: { created: 3 } },
            { type: "tool", id: "sibling", name: "bash", state: { status: "running", input: {}, structured: {}, content: [] }, time: { created: 3 } },
          ],
        }),
      )
      yield* db.update(SessionMessageTable).set({ data }).where(eq(SessionMessageTable.id, assistantID)).run().pipe(Effect.orDie)
      yield* db.insert(SessionInputTable).values({ id: userID, session_id: sourceID, prompt: { text: `Read ${file.uri}` },
        delivery: "steer", admitted_seq: 0, promoted_seq: 1 }).run().pipe(Effect.orDie)
      const dispatch = { assistantMessageID: assistantID, toolCallID: "dispatch" }
      const token = yield* SessionForkImport.prepare(db, content, { sourceSessionID: sourceID, childSessionID: childID,
        throughSeq: 10, dispatch })
      dispatch.toolCallID = "changed-after-prepare"
      if (drift !== "none") {
        yield* events.publish(SessionEvent.Tool.Progress, { sessionID: sourceID, assistantMessageID: assistantID,
          callID: "dispatch", timestamp: yield* DateTime.now, structured: { state: "running" }, content: [] })
      }
      if (drift === "missing-event")
        yield* db.delete(EventTable).where(eq(EventTable.aggregate_id, sourceID)).run().pipe(Effect.orDie)
      if (drift === "other-event")
        yield* db.update(EventTable).set({ type: "fixture.unrelated.v1" }).where(eq(EventTable.aggregate_id, sourceID)).run().pipe(Effect.orDie)
      if (drift === "policy")
        yield* db.update(SessionTable).set({ permission: [{ permission: "bash", pattern: "*", action: "deny" }] })
          .where(eq(SessionTable.id, sourceID)).run().pipe(Effect.orDie)
      if (drift === "policy" || drift === "missing-event" || drift === "other-event") {
        const notices: string[] = []
        yield* events.listen((event) => Effect.sync(() => { notices.push(event.type) }))
        expect(Exit.isFailure(yield* Effect.exit(SessionForkImport.materialize(db, events, token)))).toBe(true)
        expect(yield* messages()).toEqual([])
        expect(yield* db.select().from(AttachmentTable).where(eq(AttachmentTable.session_id, childID)).all().pipe(Effect.orDie)).toEqual([])
        expect(notices).toEqual([])
        return
      }
      const result = yield* SessionForkImport.materialize(db, events, token)
      const rows = yield* messages()
      expect(result.messages).toBe(1)
      const child = yield* db.select().from(SessionTable).where(eq(SessionTable.id, childID)).get().pipe(Effect.orDie)
      expect(child?.fork_history_seq).toBe(rows[0].seq)
      expect(yield* db.select().from(SessionContextEpochTable).where(eq(SessionContextEpochTable.session_id, childID)).get().pipe(Effect.orDie)).toBeUndefined()
      const checkpoint = yield* events.createCheckpoint(childID)
      if (!checkpoint) throw new Error("Expected native fork checkpoint")
      yield* db.delete(SessionTable).where(eq(SessionTable.id, childID)).run().pipe(Effect.orDie)
      yield* events.remove(childID)
      yield* events.replayCheckpoint(checkpoint)
      expect((yield* db.select().from(SessionTable).where(eq(SessionTable.id, childID)).get().pipe(Effect.orDie))?.fork_history_seq).toBe(rows[0].seq)
      const context = SystemContext.make({
        key: SystemContext.Key.make("test/child"),
        codec: Schema.toCodecJson(Schema.String),
        load: Effect.succeed("child-only instructions"),
        baseline: String,
        update: (_previous, current) => current,
      })
      const epoch = yield* SessionContextEpoch.initialize(db, Effect.succeed(context), childID,
        new Location.Ref({ directory: AbsolutePath.make("/fork/child") }), AgentV2.ID.make(drift === "child-agent" ? "review" : "build"))
      expect(epoch?.baseline).toContain("child-only instructions")
      expect(epoch?.baseline).not.toContain("shared context")
      expect(rows[0].id).not.toBe(userID)
      expect(rows[0].data).toMatchObject({ text: `Read ${file.uri}` })
      expect(JSON.stringify(rows)).not.toContain("sibling")
      expect(yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.session_id, childID)).all().pipe(Effect.orDie)).toEqual([])
      expect(new TextDecoder().decode((yield* content.resolve({ uri: file.uri, sessionID: childID }))?.bytes)).toBe("original bytes")
    }), drift === "child-agent" ? "review" : "build"),
  )
  for (const tool of ["task", "multi_agent_fanout"]) {
    for (const context of ["fork", "fresh"] as const)
    it.live(`materializes first-turn ${tool} with ${context} context without importing admission`, () =>
      withFixture(({ db, events, content, file, messages }) =>
        Effect.gen(function* () {
          // Import the verified assignment as context, never the native call
          // or its inbox authority.
          yield* db.delete(SessionMessageTable).where(eq(SessionMessageTable.id, syntheticID)).run().pipe(Effect.orDie)
          const { id: _id, type: _type, ...data } = Schema.encodeSync(SessionMessage.Message)(
            Schema.decodeUnknownSync(SessionMessage.Message)({
              id: assistantID, type: "assistant", agent: "build", model, time: { created: 3 }, content: [{
                type: "tool", id: "dispatch", name: tool,
                state: { status: "running", input: {}, structured: {}, content: [] }, time: { created: 3 },
              }],
            }),
          )
          yield* db.update(SessionMessageTable).set({ data }).where(eq(SessionMessageTable.id, assistantID)).run().pipe(Effect.orDie)
          yield* db.insert(SessionInputTable).values({
            id: userID, session_id: sourceID, prompt: { text: `Read ${file.uri}` },
            delivery: "steer", admitted_seq: 0, promoted_seq: 1,
          }).run().pipe(Effect.orDie)
          const dispatch = { assistantMessageID: assistantID, toolCallID: "dispatch" }
          const token = yield* SessionForkImport.prepare(db, content, {
            sourceSessionID: sourceID, childSessionID: childID, throughSeq: 10, dispatch, context,
          })
          // A caller cannot change the authority boundary after preparation.
          dispatch.toolCallID = "changed-after-prepare"
          const notices: string[] = []
          yield* events.listen((event) => Effect.sync(() => { notices.push(event.type) }))
          const result = yield* SessionForkImport.materialize(db, events, token)
          const rows = yield* messages()
          expect(result.messages).toBe(context === "fork" ? 1 : 0)
          expect(rows).toHaveLength(context === "fork" ? 1 : 0)
          expect(yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.session_id, childID)).all().pipe(Effect.orDie)).toEqual([])
          expect(yield* db.select().from(SessionActivityTable).where(eq(SessionActivityTable.session_id, childID)).all().pipe(Effect.orDie)).toEqual([])
          const attachments = yield* db.select().from(AttachmentTable).where(eq(AttachmentTable.session_id, childID)).all().pipe(Effect.orDie)
          expect(attachments).toHaveLength(context === "fork" ? 1 : 0)
          if (context === "fresh") {
            expect(notices).toEqual([SessionForkEvent.HistoryBoundaryImported.type])
            const child = yield* db.select().from(SessionTable).where(eq(SessionTable.id, childID)).get().pipe(Effect.orDie)
            expect(child?.fork_history_seq).toBe(-1)
            expect(yield* db.select().from(SessionContextEpochTable).where(eq(SessionContextEpochTable.session_id, childID)).all().pipe(Effect.orDie)).toEqual([])
            return
          }
          expect(rows[0].id).not.toBe(userID)
          expect(rows[0].data).not.toHaveProperty("metadata")
          expect(rows[0].data).toMatchObject({ text: `Read ${file.uri}` })
          expect(attachments[0].message_id).toBe(rows[0].id)
          expect(
            new TextDecoder().decode((yield* content.resolve({ uri: file.uri, sessionID: childID }))?.bytes ?? new Uint8Array()),
          ).toBe("original bytes")
          const checkpoint = yield* events.createCheckpoint(childID)
          if (!checkpoint) throw new Error("Expected commissioning history checkpoint")
          yield* db.delete(SessionTable).where(eq(SessionTable.id, childID)).run().pipe(Effect.orDie)
          yield* db.delete(AttachmentTable).where(eq(AttachmentTable.session_id, childID)).run().pipe(Effect.orDie)
          yield* events.remove(childID)
          yield* events.replayCheckpoint(checkpoint)
          expect(yield* messages()).toEqual(rows)
          expect(yield* db.select().from(AttachmentTable).where(eq(AttachmentTable.session_id, childID)).all().pipe(Effect.orDie)).toEqual(attachments)
          expect(yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.session_id, childID)).all().pipe(Effect.orDie)).toEqual([])
        }),
      ),
    )
  }

  it.live("retains parent attachment references for the cacheable wire prefix without copying grants, inboxes or runnable tools", () =>
    withFixture(({ db, events, content, file, prepare, messages }) =>
      Effect.gen(function* () {
        const token = yield* prepare()
        const notices: string[] = []
        yield* events.listen((event) =>
          Effect.sync(() => {
            notices.push(event.type)
          }),
        )
        const result = yield* SessionForkImport.materialize(db, events, token)
        expect(result.messages).toBe(3)
        const rows = yield* messages()
        expect(rows.map((row) => row.id)).not.toContain(userID)
        expect(rows.map((row) => row.id)).not.toContain(assistantID)
        expect(new Set(rows.map((row) => row.seq)).size).toBe(3)
        expect(rows.every((row) => row.data.metadata === undefined)).toBe(true)
        const attachments = yield* db
          .select()
          .from(AttachmentTable)
          .where(eq(AttachmentTable.session_id, childID))
          .all()
          .pipe(Effect.orDie)
        expect(attachments).toHaveLength(1)
        const uri = ContentStore.URI_PREFIX + attachments[0].id
        expect(uri).not.toBe(file.uri)
        expect(attachments[0].message_id).toBe(rows[0].id)
        expect(new TextDecoder().decode((yield* content.resolve({ uri, sessionID: childID }))?.bytes)).toBe(
          "original bytes",
        )
        // The serialized history keeps the parent's attachment reference so the
        // child's first provider request shares the parent's byte prefix, and the
        // retained reference resolves through the child's own fork row only.
        expect(JSON.stringify(rows)).toContain(file.uri)
        expect(
          new TextDecoder().decode((yield* content.resolve({ uri: file.uri, sessionID: childID }))?.bytes ?? new Uint8Array()),
        ).toBe("original bytes")
        expect(rows[1].data).toMatchObject({ sessionID: childID })
        expect(rows[2].data).toMatchObject({ content: [{ id: "call_probe", state: { status: "completed" } }] })
        expect(rows[2].data).not.toHaveProperty("snapshot")
        expect(JSON.stringify(rows)).not.toContain("old-control")
        expect(
          yield* db
            .select()
            .from(SessionContextEpochTable)
            .where(eq(SessionContextEpochTable.session_id, childID))
            .get()
            .pipe(Effect.orDie),
        ).toMatchObject({ baseline: "shared context", baseline_seq: rows[0].seq, revision: 0 })
        expect(yield* db.select().from(SessionInputTable).all().pipe(Effect.orDie)).toEqual([])
        expect(yield* db.select().from(SessionActivityTable).all().pipe(Effect.orDie)).toEqual([])
        expect(notices).toEqual([
          SessionForkEvent.AttachmentsImported.type,
          ...Array(3).fill(SessionForkEvent.MessageImported.type),
          SessionForkEvent.EpochImported.type,
        ])
        expect(Exit.isFailure(yield* Effect.exit(SessionForkImport.materialize(db, events, token)))).toBe(true)
        expect(yield* messages()).toEqual(rows)
      }),
    ),
  )

  it.live("never resolves foreign or unrelated attachment references through the fork alias", () =>
    withFixture(({ db, events, content, file, prepare, messages }) =>
      Effect.gen(function* () {
        const token = yield* prepare()
        yield* SessionForkImport.materialize(db, events, token)
        const rows = yield* messages()
        expect(JSON.stringify(rows)).toContain(file.uri)
        // An attachment the child never forked stays unresolvable even though the
        // URI shape is identical, and a non-attachment URI never resolves.
        const foreign = yield* content.storeTextAttachment({
          sessionID: SessionSchema.ID.create(),
          key: "foreign",
          text: "foreign bytes",
          mime: "text/plain",
          name: "foreign.txt",
        })
        expect(yield* content.resolve({ uri: foreign.uri, sessionID: childID })).toBeUndefined()
        expect(yield* content.resolve({ uri: "attachment://att_0000000000000000000000000000ffff", sessionID: childID })).toBeUndefined()
        expect(yield* content.locate({ uri: foreign.uri })).toBeDefined()
      }),
    ),
  )

  it.live("treats foreign attachment links in quoted tool output as text, not owned files", () =>
    withFixture(({ db, events, content, prepare, messages }) => Effect.gen(function* () {
      const foreign = yield* content.storeTextAttachment({ sessionID: SessionSchema.ID.create(),
        key: "foreign-report", text: "Foreign private bytes", mime: "text/plain" })
      const row = yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, assistantID)).get().pipe(Effect.orDie)
      if (!row || row.type !== "assistant") throw new Error("Missing fixture assistant")
      const message = yield* Schema.decodeUnknownEffect(SessionMessage.Assistant)({ ...row.data, id: row.id, type: row.type })
      const data = { ...row.data, content: [...Schema.encodeSync(SessionMessage.Assistant)(message).content, {
        type: "tool", id: "foreign-session-report", name: "session_read",
        state: { status: "completed", input: {}, content: [{ type: "text", text: "attachment://att_foreign_session_file" }],
          structured: { report: { evidence: foreign.uri } } },
        time: { created: 3, completed: 4 },
      }, {
        type: "text", id: "foreign-report", text: "Session report: attachment://att_foreign_session_file",
      }] }
      yield* db.update(SessionMessageTable).set({ data }).where(eq(SessionMessageTable.id, assistantID)).run().pipe(Effect.orDie)
      yield* SessionForkImport.materialize(db, events, yield* prepare())
      expect(JSON.stringify(yield* messages())).toContain("attachment://att_foreign_session_file")
      expect(JSON.stringify(yield* messages())).toContain(foreign.uri)
      expect(yield* db.select().from(AttachmentTable).where(eq(AttachmentTable.session_id, childID)).all().pipe(Effect.orDie)).toHaveLength(1)
      expect(yield* content.resolve({ uri: foreign.uri, sessionID: childID })).toBeUndefined()
      expect((yield* content.locate({ uri: foreign.uri }))?.sessionID).not.toBe(childID)
    })),
  )

  for (const kind of ["structured", "text", "output", "outputPaths"] as const)
  it.live(`refuses a missing canonical managed ${kind} reference instead of importing broken replay`, () =>
    withFixture(({ db, events, prepare, messages }) => Effect.gen(function* () {
      const row = yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, assistantID)).get().pipe(Effect.orDie)
      if (!row || row.type !== "assistant") throw new Error("Missing fixture assistant")
      const message = yield* Schema.decodeUnknownEffect(SessionMessage.Assistant)({ ...row.data, id: row.id, type: row.type })
      const reference = { type: "content-reference", uri: "attachment://att_missing_managed_output" }
      const content = [...Schema.encodeSync(SessionMessage.Assistant)(message).content, {
        type: "tool", id: "managed-output", name: "read", time: { created: 3, completed: 4 },
        state: { status: "completed", input: {}, content: [{ type: "text", text: "Preview" }],
          structured: kind === "outputPaths" ? {} : { $opencode: kind === "structured" ? reference : { [kind]: reference } },
          ...(kind === "outputPaths" ? { outputPaths: [reference.uri] } : {}),
        },
      }]
      const data = { ...row.data, content }
      yield* db.update(SessionMessageTable).set({ data }).where(eq(SessionMessageTable.id, assistantID)).run().pipe(Effect.orDie)
      const notices: string[] = []
      yield* events.listen((event) => Effect.sync(() => { notices.push(event.type) }))
      expect(yield* prepare().pipe(Effect.flip)).toMatchObject({ reason: "attachment" })
      expect(yield* messages()).toEqual([])
      expect(notices).toEqual([])
    })),
  )

  it.live("imports a descendant's verified inherited attachment alias without borrowing foreign ownership", () =>
    withFixture(({ db, events, content, file, prepare }) => Effect.gen(function* () {
      yield* SessionForkImport.materialize(db, events, yield* prepare())
      const descendantID = SessionSchema.ID.make("ses_import_descendant")
      yield* events.publish(SessionV1.Event.Created, {
        sessionID: descendantID,
        info: SessionV1.SessionInfo.make({ id: descendantID, parentID: childID, projectID: ProjectV2.ID.global,
          directory: "/fork/descendant", slug: "descendant", title: "descendant", version: "test",
          agent: "build", model, time: { created: 1, updated: 1 } }),
      })
      const fence = yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, childID)).get().pipe(Effect.orDie)
      if (!fence) throw new Error("Missing child fence")
      const token = yield* SessionForkImport.prepare(db, content, {
        sourceSessionID: childID, childSessionID: descendantID, throughSeq: fence.seq,
      })
      yield* SessionForkImport.materialize(db, events, token)
      const inherited = yield* content.resolve({ uri: file.uri, sessionID: descendantID })
      expect(new TextDecoder().decode(inherited?.bytes)).toBe("original bytes")
      const attachments = yield* db.select().from(AttachmentTable).where(eq(AttachmentTable.session_id, descendantID)).all().pipe(Effect.orDie)
      expect(attachments).toHaveLength(1)
      const source = yield* db.select().from(AttachmentTable).where(eq(AttachmentTable.session_id, childID)).all().pipe(Effect.orDie)
      expect(attachments[0].id).not.toBe(source[0].id)
      expect(attachments[0].blob_sha256).toBe(source[0].blob_sha256)
    })),
  )

  it.live("still refuses a missing declared file attachment", () =>
    withFixture(({ db, prepare }) => Effect.gen(function* () {
      const row = yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, userID)).get().pipe(Effect.orDie)
      if (!row || row.type !== "user") throw new Error("Missing fixture user")
      const data = { ...row.data,
        files: [{ uri: "attachment://att_missing_declared_file", mime: "text/plain" }],
      }
      yield* db.update(SessionMessageTable).set({ data }).where(eq(SessionMessageTable.id, userID)).run().pipe(Effect.orDie)
      expect(yield* prepare().pipe(Effect.flip)).toMatchObject({ reason: "attachment" })
    })),
  )

  for (const drift of ["fence", "policy", "attachment"] as const) {
    it.live(`rejects ${drift} drift after preparation without partial history or notifications`, () =>
      withFixture(({ db, events, file, prepare, messages }) =>
        Effect.gen(function* () {
          const token = yield* prepare()
          if (drift === "fence")
            yield* db
              .update(EventSequenceTable)
              .set({ seq: 11 })
              .where(eq(EventSequenceTable.aggregate_id, sourceID))
              .run()
              .pipe(Effect.orDie)
          if (drift === "policy")
            yield* db
              .update(SessionTable)
              .set({ permission: [{ permission: "bash", pattern: "*", action: "deny" }] })
              .where(eq(SessionTable.id, sourceID))
              .run()
              .pipe(Effect.orDie)
          if (drift === "attachment")
            yield* db
              .update(AttachmentTable)
              .set({ filename: "changed.txt" })
              .where(eq(AttachmentTable.id, file.uri.slice(ContentStore.URI_PREFIX.length)))
              .run()
              .pipe(Effect.orDie)
          const notices: string[] = []
          yield* events.listen((event) =>
            Effect.sync(() => {
              notices.push(event.type)
            }),
          )
          expect(Exit.isFailure(yield* Effect.exit(SessionForkImport.materialize(db, events, token)))).toBe(true)
          expect(yield* messages()).toEqual([])
          expect(
            yield* db
              .select()
              .from(AttachmentTable)
              .where(eq(AttachmentTable.session_id, childID))
              .all()
              .pipe(Effect.orDie),
          ).toEqual([])
          expect(notices).toEqual([])
        }),
      ),
    )
  }

  it.live("rolls back every imported row when a later projector rejects the epoch", () =>
    withFixture(({ db, events, prepare, messages }) =>
      Effect.gen(function* () {
        const token = yield* prepare()
        yield* events.beforeCommit((event) =>
          event.type === SessionForkEvent.EpochImported.type ? Effect.die("fixture failure") : Effect.void,
        )
        const notices: string[] = []
        yield* events.listen((event) =>
          Effect.sync(() => {
            notices.push(event.type)
          }),
        )
        expect(Exit.isFailure(yield* Effect.exit(SessionForkImport.materialize(db, events, token)))).toBe(true)
        expect(yield* messages()).toEqual([])
        expect(
          yield* db
            .select()
            .from(AttachmentTable)
            .where(eq(AttachmentTable.session_id, childID))
            .all()
            .pipe(Effect.orDie),
        ).toEqual([])
        expect(
          yield* db
            .select()
            .from(EventSequenceTable)
            .where(eq(EventSequenceTable.aggregate_id, childID))
            .get()
            .pipe(Effect.orDie),
        ).toMatchObject({ seq: 0 })
        expect(notices).toEqual([])
      }),
    ),
  )

  it.live("replays exact child history, epoch and attachment ownership from its own events", () =>
    withFixture(({ db, events, prepare, messages }) =>
      Effect.gen(function* () {
        yield* SessionForkImport.materialize(db, events, yield* prepare())
        const before = yield* messages()
        const epoch = yield* db
          .select()
          .from(SessionContextEpochTable)
          .where(eq(SessionContextEpochTable.session_id, childID))
          .get()
          .pipe(Effect.orDie)
        const attachments = yield* db
          .select()
          .from(AttachmentTable)
          .where(eq(AttachmentTable.session_id, childID))
          .all()
          .pipe(Effect.orDie)
        const recorded = yield* db
          .select()
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, childID))
          .orderBy(asc(EventTable.seq))
          .all()
          .pipe(Effect.orDie)
        yield* db.delete(SessionTable).where(eq(SessionTable.id, childID)).run().pipe(Effect.orDie)
        yield* db.delete(AttachmentTable).where(eq(AttachmentTable.session_id, childID)).run().pipe(Effect.orDie)
        yield* events.remove(childID)
        yield* EventV2.atomic(
          db,
          events.replayAll(
            recorded.map((event) => ({
              id: event.id,
              aggregateID: event.aggregate_id,
              seq: event.seq,
              type: event.type,
              data: EventV2.decodeStoredEventData(event.data),
            })),
          ),
        )
        expect(yield* messages()).toEqual(before)
        expect(
          yield* db
            .select()
            .from(SessionContextEpochTable)
            .where(eq(SessionContextEpochTable.session_id, childID))
            .get()
            .pipe(Effect.orDie),
        ).toEqual(epoch)
        expect(
          yield* db
            .select()
            .from(AttachmentTable)
            .where(eq(AttachmentTable.session_id, childID))
            .all()
            .pipe(Effect.orDie),
        ).toEqual(attachments)
        const checkpoint = yield* events.createCheckpoint(childID)
        if (!checkpoint) throw new Error("Expected fork checkpoint")
        expect(checkpoint.baseline.version).toBe(5)
        expect(checkpoint.baseline.data.forkAttachments).toEqual(attachments)
        yield* db.delete(SessionTable).where(eq(SessionTable.id, childID)).run().pipe(Effect.orDie)
        yield* db.delete(AttachmentTable).where(eq(AttachmentTable.session_id, childID)).run().pipe(Effect.orDie)
        yield* events.remove(childID)
        yield* db
          .delete(EventCheckpointTable)
          .where(eq(EventCheckpointTable.aggregate_id, childID))
          .run()
          .pipe(Effect.orDie)
        yield* events.replayCheckpoint(checkpoint)
        expect(yield* messages()).toEqual(before)
        expect(
          yield* db
            .select()
            .from(SessionContextEpochTable)
            .where(eq(SessionContextEpochTable.session_id, childID))
            .get()
            .pipe(Effect.orDie),
        ).toEqual(epoch)
        expect(
          yield* db
            .select()
            .from(AttachmentTable)
            .where(eq(AttachmentTable.session_id, childID))
            .all()
            .pipe(Effect.orDie),
        ).toEqual(attachments)
        // A checkpoint-only tail must retain attachment ownership too.
        expect(yield* events.createCheckpoint(childID)).toBeDefined()
      }),
    ),
  )

  it.live("upgrades a version-4 baseline before replaying a fork-import tail", () =>
    withFixture(({ db, events, prepare }) =>
      Effect.gen(function* () {
        yield* events.createCheckpoint(childID)
        const stored = yield* db
          .select()
          .from(EventCheckpointTable)
          .where(eq(EventCheckpointTable.aggregate_id, childID))
          .get()
          .pipe(Effect.orDie)
        if (!stored) throw new Error("Expected initial checkpoint")
        const baseline = EventV2.readStoredCheckpointBaseline(stored.data)
        const { forkAttachments: _attachments, ...data } = baseline.data
        const legacy = { ...baseline, version: 4, data }
        yield* db
          .update(EventCheckpointTable)
          .set({ data: EventV2.replaceStoredCheckpointBaseline(stored.data, legacy) })
          .where(eq(EventCheckpointTable.aggregate_id, childID))
          .run()
          .pipe(Effect.orDie)
        yield* SessionForkImport.materialize(db, events, yield* prepare())
        const upgraded = yield* events.createCheckpoint(childID)
        expect(upgraded?.baseline.version).toBe(5)
        expect(upgraded?.baseline.data.forkAttachments).toHaveLength(1)
      }),
    ),
  )

  for (const action of ["replay", "mutate"] as const) {
    it.live(`hydrates a populated normalized v4 checkpoint before ${action}`, () =>
      withFixture(({ db, events, messages }) =>
        Effect.gen(function* () {
          yield* events.publish(SessionEvent.Synthetic, {
            sessionID: childID,
            messageID: SessionMessage.ID.create(),
            text: "before",
            timestamp: yield* DateTime.now,
          })
          yield* events.createCheckpoint(childID)
          const compacted = yield* events.compactCheckpoint(childID)
          const stored = yield* db
            .select()
            .from(EventCheckpointTable)
            .where(eq(EventCheckpointTable.aggregate_id, childID))
            .get()
            .pipe(Effect.orDie)
          if (!stored || !compacted) throw new Error("Expected compacted checkpoint")
          const baseline = EventV2.readStoredCheckpointBaseline(stored.data)
          expect(baseline.data.legacyProjectionReference).toBeDefined()
          expect(baseline.data.messages).toEqual([])
          const { forkAttachments: _attachments, ...data } = baseline.data
          const legacy = { ...baseline, version: 4, data }
          const encoded = EventV2.replaceStoredCheckpointBaseline(stored.data, legacy)
          yield* db
            .update(EventCheckpointTable)
            .set({ data: encoded })
            .where(eq(EventCheckpointTable.aggregate_id, childID))
            .run()
            .pipe(Effect.orDie)
          if (action === "replay") {
            const hash = EventV2.decodeStoredEventData(encoded).baselineHash
            if (typeof hash !== "string") throw new Error("Expected checkpoint hash")
            const input = { ...compacted.checkpoint, baseline: legacy, baselineHash: hash }
            const hydrated = yield* events.checkpoint(childID)
            if (!hydrated || hydrated.version !== EventV2.CheckpointVersion)
              throw new Error("Expected hydrated checkpoint")
            expect(hydrated.baseline.data.messages).toHaveLength(1)
            yield* events.replayCheckpoint(input)
            yield* events.replayCheckpoint(input)
          }
          if (action === "mutate") {
            yield* events.publish(SessionEvent.Synthetic, {
              sessionID: childID,
              messageID: SessionMessage.ID.create(),
              text: "after",
              timestamp: yield* DateTime.now,
            })
            const updated = yield* db
              .select()
              .from(EventCheckpointTable)
              .where(eq(EventCheckpointTable.aggregate_id, childID))
              .get()
              .pipe(Effect.orDie)
            if (!updated) throw new Error("Expected materialized checkpoint")
            expect(EventV2.readStoredCheckpointBaseline(updated.data).data.legacyProjectionReference).toBeUndefined()
          }
          expect((yield* events.createCheckpoint(childID))?.baseline.version).toBe(5)
          expect(yield* events.compactCheckpoint(childID)).toBeDefined()
          expect(yield* messages()).toHaveLength(action === "replay" ? 1 : 2)
        }),
      ),
    )
  }

  it.live("message cleanup detaches fork attachments while preserving retained and foreign references", () =>
    withFixture(({ db, events, content, file, prepare, messages }) =>
      Effect.gen(function* () {
        yield* SessionForkImport.materialize(db, events, yield* prepare())
        const before = yield* messages()
        const attachments = yield* SessionForkAttachments.capture(db, childID)
        const ordinary = yield* content.storeTextAttachment({
          sessionID: childID,
          messageID: before[0].id,
          key: "ordinary",
          text: "ordinary",
          mime: "text/plain",
        })
        const foreign = yield* content.storeTextAttachment({
          sessionID: sourceID,
          messageID: before[0].id,
          key: "foreign",
          text: "foreign",
          mime: "text/plain",
        })
        const unaffected = yield* db
          .select()
          .from(AttachmentTable)
          .where(eq(AttachmentTable.id, ordinary.uri.slice(ContentStore.URI_PREFIX.length)))
          .get()
          .pipe(Effect.orDie)
        const foreignBefore = yield* db
          .select()
          .from(AttachmentTable)
          .where(eq(AttachmentTable.id, foreign.uri.slice(ContentStore.URI_PREFIX.length)))
          .get()
          .pipe(Effect.orDie)
        yield* events.publish(SessionEvent.Revert.Cleaned, {
          sessionID: childID,
          timestamp: yield* DateTime.now,
          revert: { messageID: before[0].id },
          messageIDs: [before[0].id],
        })
        const detached = yield* SessionForkAttachments.capture(db, childID)
        expect(detached).toMatchObject([{ id: attachments[0].id, message_id: null }])
        // The retained parent reference stays in history after cleanup and still
        // resolves through the detached, session-owned fork row.
        expect((yield* messages()).at(-1)?.data).toMatchObject({
          content: [{ state: { structured: { attachment: file.uri } } }],
        })
        expect(
          new TextDecoder().decode(
            (yield* content.resolve({ uri: ContentStore.URI_PREFIX + attachments[0].id, sessionID: childID }))?.bytes,
          ),
        ).toBe("original bytes")
        expect(
          new TextDecoder().decode((yield* content.resolve({ uri: file.uri, sessionID: childID }))?.bytes ?? new Uint8Array()),
        ).toBe("original bytes")
        const checkpoint = yield* events.createCheckpoint(childID)
        if (!checkpoint) throw new Error("Expected cleaned checkpoint")
        yield* db.delete(SessionTable).where(eq(SessionTable.id, childID)).run().pipe(Effect.orDie)
        yield* events.remove(childID)
        yield* db
          .delete(EventCheckpointTable)
          .where(eq(EventCheckpointTable.aggregate_id, childID))
          .run()
          .pipe(Effect.orDie)
        yield* events.replayCheckpoint(checkpoint)
        expect(yield* SessionForkAttachments.capture(db, childID)).toEqual(detached)
        expect(
          yield* db
            .select()
            .from(AttachmentTable)
            .where(eq(AttachmentTable.id, ordinary.uri.slice(ContentStore.URI_PREFIX.length)))
            .get()
            .pipe(Effect.orDie),
        ).toEqual(unaffected)
        expect(
          yield* db
            .select()
            .from(AttachmentTable)
            .where(eq(AttachmentTable.id, foreign.uri.slice(ContentStore.URI_PREFIX.length)))
            .get()
            .pipe(Effect.orDie),
        ).toEqual(foreignBefore)
      }),
    ),
  )

  it.live("rejects corrupted same-size source bytes rather than blessing a new hash", () =>
    withFixture(({ content, file, prepare, messages }) =>
      Effect.gen(function* () {
        const stored = yield* content.locate({ uri: file.uri, sessionID: sourceID })
        if (!stored) throw new Error("Expected source blob")
        yield* Effect.promise(() => writeFile(stored.path, "tampered bytes"))
        const result = yield* prepare().pipe(Effect.flip)
        expect(result).toBeInstanceOf(SessionForkImport.Conflict)
        expect(result).toMatchObject({ reason: "attachment" })
        expect(result.message).toBe("Session fork import refused (attachment)")
        expect(yield* messages()).toEqual([])
      }),
    ),
  )

  it.live("validates checkpoint attachment identity, ownership, ordering and parent messages", () =>
    withFixture(({ db, events, prepare, messages }) =>
      Effect.gen(function* () {
        yield* SessionForkImport.materialize(db, events, yield* prepare())
        const rows = yield* SessionForkAttachments.capture(db, childID)
        const ids = new Set((yield* messages()).map((message) => message.id))
        expect(SessionForkAttachments.read(rows, childID, ids)).toMatchObject(rows)
        for (const change of [
          { session_id: sourceID },
          { message_id: "msg_foreign" },
          { id: "att_ordinary" },
          { blob_sha256: "not-a-hash" },
          { source_path: "private-file" },
          { unexpected: true },
        ])
          expect(SessionForkAttachments.read([{ ...rows[0], ...change }], childID, ids)).toBeUndefined()
        expect(SessionForkAttachments.read([...rows, ...rows], childID, ids)).toBeUndefined()
      }),
    ),
  )

  it.live("a prepared token cannot be used with a different database", () =>
    withFixture((outer) =>
      Effect.gen(function* () {
        const token = yield* outer.prepare()
        yield* Effect.gen(function* () {
          const { db } = yield* Database.Service
          expect(db).not.toBe(outer.db)
          const result = yield* SessionForkImport.materialize(db, outer.events, token).pipe(Effect.flip)
          expect(result).toBeInstanceOf(SessionForkImport.Conflict)
          expect(result).toMatchObject({ reason: "prepared" })
          expect(yield* db.select().from(SessionMessageTable).all().pipe(Effect.orDie)).toEqual([])
        }).pipe(Effect.provide(Database.layerFromPath(":memory:")))
      }),
    ),
  )

  it.live("inherited provider accounting cannot be charged or refunded by child history cleanup", () =>
    withFixture(({ db, events, prepare, messages }) =>
      Effect.gen(function* () {
        const source = yield* db
          .select()
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.id, assistantID))
          .get()
          .pipe(Effect.orDie)
        if (!source) throw new Error("Expected source assistant")
        const data = {
          ...source.data,
          cost: 3.5,
          tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 80, write: 0 } },
          tokenMeasurement: { version: 1 as const, generationMilliseconds: 750 },
        }
        yield* db
          .update(SessionMessageTable)
          .set({ data })
          .where(eq(SessionMessageTable.id, assistantID))
          .run()
          .pipe(Effect.orDie)
        yield* SessionForkImport.materialize(db, events, yield* prepare())
        const imported = (yield* messages()).at(-1)
        if (!imported) throw new Error("Expected imported assistant")
        yield* events.publish(SessionEvent.Revert.Cleaned, {
          sessionID: childID,
          timestamp: yield* DateTime.now,
          revert: { messageID: imported.id },
          messageIDs: [imported.id],
        })
        expect(
          yield* db.select().from(SessionTable).where(eq(SessionTable.id, childID)).get().pipe(Effect.orDie),
        ).toMatchObject({
          cost: 0,
          tokens_input: 0,
          tokens_output: 0,
          tokens_reasoning: 0,
          tokens_cache_read: 0,
          tokens_cache_write: 0,
          generation_ms: 0,
        })
        expect(
          (yield* db
            .select()
            .from(SessionMessageTable)
            .where(eq(SessionMessageTable.id, assistantID))
            .get()
            .pipe(Effect.orDie))?.data,
        ).toMatchObject({ cost: 3.5, tokens: data.tokens, tokenMeasurement: data.tokenMeasurement })
        expect(yield* events.createCheckpoint(childID)).toBeDefined()
      }),
    ),
  )

  it.live("replayed imports cannot inject source accounting, live tools or controls", () =>
    withFixture(({ db, events, messages }) =>
      Effect.gen(function* () {
        for (const fields of [
          { cost: 1 },
          { tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
          { tokenMeasurement: { version: 1, generationMilliseconds: 10 } },
          { snapshot: { start: "foreign" } },
          { content: [{ type: "custom", id: "control", kind: "surface", data: {} }] },
          {
            content: [
              {
                type: "tool",
                id: "pending",
                name: "read",
                state: { status: "pending", input: "{}" },
                time: { created: 1 },
              },
            ],
          },
          { time: { created: 1 } },
        ]) {
          const message = yield* Schema.decodeUnknownEffect(SessionMessage.Message)({
            type: "assistant",
            id: SessionMessage.ID.create(),
            agent: "build",
            model,
            finish: "stop",
            content: [],
            time: { created: 1, completed: 2 },
            ...fields,
          }).pipe(Effect.orDie)
          expect(
            Exit.isFailure(
              yield* events
                .publish(SessionForkEvent.MessageImported, {
                  sessionID: childID,
                  sourceSessionID: sourceID,
                  sourceMessageID: assistantID,
                  timestamp: yield* DateTime.now,
                  message,
                })
                .pipe(Effect.exit),
            ),
          ).toBe(true)
        }
        expect(yield* messages()).toEqual([])
        expect(
          yield* db
            .select()
            .from(EventSequenceTable)
            .where(eq(EventSequenceTable.aggregate_id, childID))
            .get()
            .pipe(Effect.orDie),
        ).toMatchObject({ seq: 0 })
      }),
    ),
  )

  it.live("rejects caller-shaped preparation objects", () =>
    withFixture(({ db, events }) =>
      Effect.gen(function* () {
        expect(
          Exit.isFailure(yield* Effect.exit(SessionForkImport.materialize(db, events, { childSessionID: childID }))),
        ).toBe(true)
      }),
    ),
  )
})
