import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { ContentStore } from "@opencode-ai/core/content-store"
import { SessionAccess } from "@opencode-ai/core/session/access"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { FileAttachment, Prompt } from "@opencode-ai/core/session/prompt"
import { SessionStore } from "@opencode-ai/core/session/store"
import {
  SessionActivityTable,
  SessionInputTable,
  SessionMessageTable,
  SessionTable,
} from "@opencode-ai/core/session/sql"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionWakeup } from "@opencode-ai/core/session/wakeup"
import { testEffect } from "./lib/effect"
import { eq } from "drizzle-orm"
import { SessionLinks } from "@opencode-ai/core/session/links"
import { SessionDispatchTable } from "@opencode-ai/core/session/sql"
import { ModelV2 } from "@opencode-ai/core/model"
import { AgentV2 } from "@opencode-ai/core/agent"
import { SessionDispatchOrigin } from "@opencode-ai/core/session/dispatch-origin"

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
const store = SessionStore.layer.pipe(Layer.provide(database))
const content = Layer.succeed(
  ContentStore.Service,
  ContentStore.Service.of({
    putBlob: (input) =>
      Effect.succeed({ sha256: "0".repeat(64), mime: input.mime, path: "content", sizeBytes: input.bytes.byteLength }),
    locateBlob: () => Effect.succeed(undefined),
    readBlob: () => Effect.succeed(undefined),
    storeAttachment: (input) =>
      Effect.succeed(new FileAttachment({ uri: "attachment://fake", mime: input.mime, name: input.name })),
    storeTextAttachment: (input) =>
      Effect.succeed(new FileAttachment({ uri: "attachment://fake-text", mime: input.mime, name: input.name })),
    normalizePrompt: (input) => Effect.succeed(input.prompt),
    normalizeFiles: (input) => Effect.succeed(input.files),
    locate: () => Effect.succeed(undefined),
    resolve: () => Effect.succeed(undefined),
    materialize: (input) => Effect.succeed(input.file),
  }),
)
const access = SessionAccess.layer.pipe(
  Layer.provide(database),
  Layer.provide(events),
  Layer.provide(store),
  Layer.provide(content),
)
const voice = SessionLinks.layer.pipe(Layer.provide(database), Layer.provide(access))
const it = testEffect(Layer.mergeAll(database, events, projector, store, content, access, voice))
const pluginID = "test-links"
const linkPolicy = { pluginID, permissionPolicy: "single-use" as const }
const startPolicy = { ...linkPolicy, agent: AgentV2.ID.make("test-source"), title: "Linked source" }
const sessionA = SessionV2.ID.make("ses_access_a")
const sessionB = SessionV2.ID.make("ses_access_b")
const encodeMessage = Schema.encodeSync(SessionMessage.Message)

function messageRow(message: SessionMessage.Message, sessionID: SessionV2.ID, seq: number) {
  const { id, type, ...data } = encodeMessage(message)
  return {
    id: SessionMessage.ID.make(id),
    session_id: sessionID,
    type,
    seq,
    time_created: DateTime.toEpochMillis(message.time.created),
    data,
  }
}

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values(
      [sessionA, sessionB].map((id) => ({
        id,
        project_id: Project.ID.global,
        slug: id,
        directory: "/project",
        title: id,
        version: "test",
      })),
    )
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

const insertMessage = (sessionID: SessionV2.ID, seq: number, text: string) =>
  Effect.gen(function* () {
    const message = new SessionMessage.User({
      id: SessionMessage.ID.make(`msg_${sessionID}_${seq}`),
      type: "user",
      text,
      files: [],
      agents: [],
      time: { created: DateTime.makeUnsafe(Date.now() + seq) },
    })
    yield* (yield* Database.Service).db
      .insert(SessionMessageTable)
      .values(messageRow(message, sessionID, seq))
      .run()
      .pipe(Effect.orDie)
  })

const setupVoice = Effect.gen(function* () {
  yield* setup
  const { db } = yield* Database.Service
  yield* db
    .update(SessionTable)
    .set({ agent: "voice-moderator" })
    .where(eq(SessionTable.id, sessionA))
    .run()
    .pipe(Effect.orDie)
  yield* db
    .update(SessionTable)
    .set({
      agent: "build",
      model: { id: "worker-model", providerID: "test", variant: "high" },
      permission: [{ permission: "edit", pattern: "*", action: "ask" }],
    })
    .where(eq(SessionTable.id, sessionB))
    .run()
    .pipe(Effect.orDie)
  const message = new SessionMessage.Assistant({
    id: SessionMessage.ID.create(),
    type: "assistant",
    agent: "voice-moderator",
    model: Schema.decodeUnknownSync(ModelV2.Ref)({ id: "moderator-model", providerID: "test", variant: "default" }),
    content: [],
    time: { created: DateTime.makeUnsafe(Date.now()) },
  })
  yield* db
    .insert(SessionMessageTable)
    .values(messageRow(message, sessionA, 1))
    .run()
    .pipe(Effect.orDie)
  return {
    pluginID,
    delivery: "queue" as const,
    sourceSessionID: sessionA,
    sourceMessageID: message.id,
    sourceCallID: "call_worker",
    text: "Implement the requested fix",
  }
})

describe("SessionLinks durable dispatch", () => {
  it.effect("concurrent sources binding one target return one controlled link conflict", () =>
    Effect.gen(function* () {
      yield* setupVoice
      const service = yield* SessionLinks.Service
      const { db } = yield* Database.Service
      const other = SessionV2.ID.make("ses_other_link_source")
      yield* db.insert(SessionTable).values({ id: other, project_id: Project.ID.global, slug: other,
        directory: "/project", title: "Other source", version: "test" }).run().pipe(Effect.orDie)
      const results = yield* Effect.all([sessionA, other].map((sourceSessionID) => service.bind({
        ...linkPolicy, sourceSessionID, targetSessionID: sessionB,
      }).pipe(Effect.match({ onSuccess: () => "ok", onFailure: (error) => error.reason }))), { concurrency: "unbounded" })
      expect(results.sort()).toEqual(["linked", "ok"])
    }),
  )
  it.effect("delivers another owner's terminal result even when an earlier link is stale", () =>
    Effect.gen(function* () {
      const input = yield* setupVoice
      const service = yield* SessionLinks.Service
      const { db } = yield* Database.Service
      const staleID = SessionV2.ID.make("ses_stale_plugin_source")
      yield* db.insert(SessionTable).values({ id: staleID, project_id: Project.ID.global, slug: staleID,
        directory: "/project", title: "Stale source", version: "test" }).run().pipe(Effect.orDie)
      yield* service.bind({ pluginID: "a-stale-plugin", permissionPolicy: "inherit", sourceSessionID: staleID, targetSessionID: sessionB })
      yield* service.bind({ ...linkPolicy, sourceSessionID: sessionA, targetSessionID: sessionB })
      const admitted = yield* service.send(input)
      yield* SessionInput.promoteNextQueued(db, yield* EventV2.Service, sessionB)
      const promoted = yield* SessionInput.find(db, admitted.id)
      if (promoted?.promotedSeq === undefined) throw new Error("Missing promoted input")
      yield* db.insert(SessionActivityTable).values({ id: "act_multi_owner", session_id: sessionB, kind: "prompt", status: "failed",
        opened_seq: admitted.admittedSeq, closed_seq: promoted.promotedSeq }).run().pipe(Effect.orDie)
      yield* db.update(SessionTable).set({ time_archived: Date.now() }).where(eq(SessionTable.id, staleID)).run().pipe(Effect.orDie)
      expect(yield* service.deliver(sessionB).pipe(Effect.flip)).toMatchObject({ reason: "missing" })
      expect((yield* db.select().from(SessionDispatchTable).get().pipe(Effect.orDie))?.time_result_delivered).not.toBeNull()
      expect(yield* db.select().from(SessionInputTable).all().pipe(Effect.orDie)).toHaveLength(2)
    }),
  )

  it.effect("supports a second owner on the same sessions and uses steer by default", () =>
    Effect.gen(function* () {
      const input = yield* setupVoice
      const service = yield* SessionLinks.Service
      yield* service.bind({ ...linkPolicy, sourceSessionID: sessionA, targetSessionID: sessionB })
      yield* service.bind({ pluginID: "second-plugin", permissionPolicy: "inherit", sourceSessionID: sessionA, targetSessionID: sessionB })
      const first = yield* service.send(input)
      const second = yield* service.send({ ...input, pluginID: "second-plugin", delivery: undefined })
      expect(first.id).not.toBe(second.id)
      expect(second.delivery).toBe("steer")
      expect(second.prompt.text).toBe(input.text)
      expect(yield* service.bind({ ...linkPolicy, permissionPolicy: "inherit", sourceSessionID: sessionA, targetSessionID: sessionB }).pipe(Effect.flip)).toMatchObject({ reason: "retry" })
      yield* service.end({ pluginID, sourceSessionID: sessionA })
      expect((yield* service.get({ pluginID: "second-plugin", sessionID: sessionB }))?.source_session_id).toBe(sessionA)
    }),
  )

  it.effect("start repairs a reserved normal session, coalesces concurrent starts and preserves worker policies", () =>
    Effect.gen(function* () {
      yield* setupVoice
      const { db } = yield* Database.Service
      const service = yield* SessionLinks.Service
      const access = yield* SessionAccess.Service
      const worker = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionB)).get().pipe(Effect.orDie)
      const model = Schema.decodeUnknownSync(ModelV2.Ref)({ id: "moderator-model", providerID: "test" })
      const created: SessionV2.CreateInput[] = []
      const create: SessionV2.Interface["create"] = (input) => Effect.gen(function* () {
        created.push(input)
        return yield* access.get(sessionA).pipe(Effect.orDie)
      })
      expect((yield* service.start({ ...startPolicy, sourceSessionID: sessionA, targetSessionID: sessionB }, create).pipe(Effect.flip))).toMatchObject({ _tag: "SessionLinks.Conflict", reason: "retry" })
      expect(created).toEqual([])
      yield* db.update(SessionTable).set({ metadata: { "opencode.session-link": { pluginID, targetSessionID: sessionB } } })
        .where(eq(SessionTable.id, sessionA)).run().pipe(Effect.orDie)
      const links = yield* Effect.all([
        service.start({ ...startPolicy, sourceSessionID: sessionA, targetSessionID: sessionB, model }, create),
        service.start({ ...startPolicy, sourceSessionID: sessionA, targetSessionID: sessionB, model }, create),
      ], { concurrency: "unbounded" })
      expect(links[0]).toEqual(links[1])
      expect(yield* service.start({ ...startPolicy, sourceSessionID: SessionV2.ID.create(), targetSessionID: sessionB, model }, create).pipe(Effect.flip)).toMatchObject({ reason: "linked" })
      expect(created).toEqual([{
        id: sessionA, title: "Linked source", agent: AgentV2.ID.make("test-source"), model,
        location: { directory: AbsolutePath.make("/project") }, metadata: { "opencode.session-link": { pluginID, targetSessionID: sessionB } },
      }])
      expect(yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionB)).get().pipe(Effect.orDie)).toEqual(worker)
      expect(yield* db.select().from(SessionInputTable).all().pipe(Effect.orDie)).toEqual([])
      yield* service.end({ pluginID, sourceSessionID: sessionA })
      expect((yield* service.start({ ...startPolicy, sourceSessionID: sessionA, targetSessionID: sessionB }, create).pipe(Effect.flip))).toMatchObject({ _tag: "SessionLinks.Conflict", reason: "ended" })
      yield* db.update(SessionTable).set({ time_archived: Date.now() }).where(eq(SessionTable.id, sessionB)).run().pipe(Effect.orDie)
      expect((yield* service.start({ ...startPolicy, sourceSessionID: SessionV2.ID.create(), targetSessionID: sessionB }, create).pipe(Effect.flip))).toMatchObject({ _tag: "SessionLinks.Conflict", reason: "missing" })
    }),
  )

  it.effect("startup reconciliation delivers terminal results without waking worker work and ignores ended links", () =>
    Effect.gen(function* () {
      const input = yield* setupVoice
      const { db } = yield* Database.Service
      const service = yield* SessionLinks.Service
      yield* service.bind({ ...linkPolicy, sourceSessionID: sessionA, targetSessionID: sessionB })
      const admitted = yield* service.send(input)
      const wakes: string[] = []
      yield* SessionWakeup.listen((id) => Effect.sync(() => { wakes.push(id) }))
      yield* SessionLinks.reconcile(db, service.deliver)
      expect(wakes).toEqual([])
      yield* SessionInput.promoteNextQueued(db, yield* EventV2.Service, sessionB)
      const promoted = yield* SessionInput.find(db, admitted.id)
      if (promoted?.promotedSeq === undefined) throw new Error("Missing promoted fixture")
      yield* db.insert(SessionActivityTable).values({
        id: "startup_result",
        session_id: sessionB,
        kind: "prompt",
        status: "failed",
        opened_seq: admitted.admittedSeq,
        closed_seq: promoted.promotedSeq,
      }).run().pipe(Effect.orDie)
      // A failed Location must leave the durable result pending for a later retry.
      yield* SessionLinks.reconcile(db, () => Effect.fail("Location unavailable"))
      expect(wakes).toEqual([])
      yield* SessionLinks.Service.use((recovered) => SessionLinks.reconcile(db, recovered.deliver)).pipe(
        Effect.provide(SessionLinks.layer),
      )
      expect(wakes).toEqual([sessionA])
      yield* SessionLinks.reconcile(db, service.deliver)
      expect(wakes).toEqual([sessionA])
      const result = yield* db.select().from(SessionDispatchTable).get().pipe(Effect.orDie)
      expect(result?.time_result_delivered).not.toBeNull()
      yield* db.update(SessionDispatchTable).set({ time_result_delivered: null }).run().pipe(Effect.orDie)
      yield* service.end({ pluginID, sourceSessionID: sessionA })
      const visited: string[] = []
      yield* SessionLinks.reconcile(db, (id) => Effect.sync(() => { visited.push(id) }))
      expect(visited).toEqual([])
      expect(wakes).not.toContain(sessionB)
    }),
  )

  it.effect("rejects an exact dispatch retry whose legacy row names another target", () =>
    Effect.gen(function* () {
      const input = yield* setupVoice
      const { db } = yield* Database.Service
      const service = yield* SessionLinks.Service
      yield* service.bind({ ...linkPolicy, sourceSessionID: sessionA, targetSessionID: sessionB })
      const admitted = yield* service.send(input)
      yield* db.delete(SessionInputTable).where(eq(SessionInputTable.id, admitted.id)).run().pipe(Effect.orDie)
      yield* db.update(SessionDispatchTable).set({target_session_id:sessionA}).run().pipe(Effect.orDie)
      expect(yield* service.send(input).pipe(Effect.flip)).toMatchObject({reason:"retry"})
      expect(yield* db.select().from(SessionInputTable).all().pipe(Effect.orDie)).toEqual([])
    }),
  )

  it.effect("reconciliation ignores legacy dispatch rows for a different target", () =>
    Effect.gen(function* () {
      const input = yield* setupVoice
      const { db } = yield* Database.Service
      const service = yield* SessionLinks.Service
      yield* service.bind({ ...linkPolicy, sourceSessionID: sessionA, targetSessionID: sessionB })
      yield* service.send(input)
      yield* db.update(SessionDispatchTable).set({target_session_id:sessionA,result_text:"frozen result"}).run().pipe(Effect.orDie)
      const visited: SessionV2.ID[] = []
      yield* SessionLinks.reconcile(db,(id) => Effect.sync(() => {visited.push(id)}))
      expect(visited).toEqual([])
      yield* db.update(SessionDispatchTable).set({target_session_id:sessionB}).run().pipe(Effect.orDie)
      yield* SessionLinks.reconcile(db,(id) => Effect.sync(() => {visited.push(id)}))
      expect(visited).toEqual([sessionB])
    }),
  )

  it.effect("delivers failures before any assistant output and retries frozen results after source cleanup", () =>
    Effect.gen(function* () {
      const input = yield* setupVoice
      const { db } = yield* Database.Service
      const service = yield* SessionLinks.Service
      yield* service.bind({ ...linkPolicy, sourceSessionID: sessionA, targetSessionID: sessionB })
      const admitted = yield* service.send(input)
      yield* SessionInput.promoteNextQueued(db, yield* EventV2.Service, sessionB)
      const promoted = yield* SessionInput.find(db, admitted.id)
      if (promoted?.promotedSeq === undefined) throw new Error("Missing promoted fixture")
      yield* db
        .insert(SessionActivityTable)
        .values({
          id: "early_failure",
          session_id: sessionB,
          kind: "prompt",
          status: "failed",
          opened_seq: admitted.admittedSeq,
          closed_seq: promoted.promotedSeq,
        })
        .run()
        .pipe(Effect.orDie)
      yield* service.deliver(sessionB)
      const dispatch = yield* db.select().from(SessionDispatchTable).get().pipe(Effect.orDie)
      if (!dispatch?.result_text) throw new Error("Missing frozen failure")
      expect(dispatch.result_text).toContain('"status":"failed"')
      expect(dispatch.result_text).toContain('"text":""')
      yield* db.update(SessionDispatchTable).set({ time_result_delivered: null }).run().pipe(Effect.orDie)
      yield* db
        .delete(SessionActivityTable)
        .where(eq(SessionActivityTable.id, "early_failure"))
        .run()
        .pipe(Effect.orDie)
      yield* db.delete(SessionInputTable).where(eq(SessionInputTable.id, admitted.id)).run().pipe(Effect.orDie)
      yield* SessionLinks.Service.use((recovered) => recovered.deliver(sessionB)).pipe(
        Effect.provide(SessionLinks.layer),
      )
      expect(
        (yield* db.select().from(SessionDispatchTable).get().pipe(Effect.orDie))?.time_result_delivered,
      ).not.toBeNull()
      expect((yield* SessionInput.find(db, dispatch.result_input_id))?.prompt.text).toBe(dispatch.result_text)
      expect(
        yield* db
          .select()
          .from(SessionInputTable)
          .where(eq(SessionInputTable.session_id, sessionA))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(1)
    }),
  )

  for (const status of ["failed", "interrupted"] as const) {
    it.effect(`does not invent a completed early queue result in a ${status} drain without an assistant answer`, () =>
      Effect.gen(function* () {
        const input = yield* setupVoice
        const { db } = yield* Database.Service
        const service = yield* SessionLinks.Service
        yield* service.bind({ ...linkPolicy, sourceSessionID: sessionA, targetSessionID: sessionB })
        const first = yield* service.send(input)
        const second = yield* service.send({ ...input, sourceCallID: "later_call", text: "Later work" })
        for (const [id, seq] of [[first.id, 10], [second.id, 20]] as const)
          yield* db.update(SessionInputTable).set({ promoted_seq: seq }).where(eq(SessionInputTable.id, id)).run().pipe(Effect.orDie)
        yield* db.insert(SessionActivityTable).values({ id: "early_queue_no_answer", session_id: sessionB,
          kind: "prompt", status, opened_seq: 0, closed_seq: 30 }).run().pipe(Effect.orDie)
        yield* service.deliver(sessionB)
        const dispatch = yield* db.select().from(SessionDispatchTable).where(eq(SessionDispatchTable.target_input_id, first.id)).get().pipe(Effect.orDie)
        expect(dispatch?.result_text).toContain(`"status":"${status}"`)
        expect(dispatch?.result_text).toContain('"text":""')
      }),
    )
  }

  it.effect("separates queue groups within one drain and does not extend voice approvals into later manual work", () =>
    Effect.gen(function* () {
      const input = yield* setupVoice
      const { db } = yield* Database.Service
      const service = yield* SessionLinks.Service
      yield* service.bind({ ...linkPolicy, sourceSessionID: sessionA, targetSessionID: sessionB })
      const first = yield* service.send(input)
      const second = yield* service.send({ ...input, sourceCallID: "call_second", text: "Second instruction" })
      const manual = yield* (yield* SessionAccess.Service).send({
        sessionID: sessionB,
        delivery: "queue",
        prompt: new Prompt({ text: "Later manual work" }),
      })
      for (const [id, seq] of [
        [first.id, 10],
        [second.id, 20],
        [manual.id, 30],
      ] as const)
        yield* db
          .update(SessionInputTable)
          .set({ promoted_seq: seq })
          .where(eq(SessionInputTable.id, id))
          .run()
          .pipe(Effect.orDie)
      const messages = ["First result", "Second result", "Manual result"].map(
        (text) =>
          new SessionMessage.Assistant({
            id: SessionMessage.ID.create(),
            type: "assistant",
            agent: "build",
            model: Schema.decodeUnknownSync(ModelV2.Ref)({ id: "worker-model", providerID: "test" }),
            content: [new SessionMessage.AssistantText({ type: "text", id: "text", text })],
            time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
          }),
      )
      yield* db
        .insert(SessionMessageTable)
        .values(messages.map((message, index) => messageRow(message, sessionB, 15 + index * 10)))
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionActivityTable)
        .values({
          id: "multi_queue",
          session_id: sessionB,
          kind: "prompt",
          status: "failed",
          opened_seq: 0,
          closed_seq: 40,
        })
        .run()
        .pipe(Effect.orDie)
      yield* service.deliver(sessionB)
      const dispatches = yield* db.select().from(SessionDispatchTable).all().pipe(Effect.orDie)
      expect(dispatches.find((row) => row.target_input_id === first.id)?.result_text).toContain('"text":"First result"')
      expect(dispatches.find((row) => row.target_input_id === second.id)?.result_text).toContain(
        '"text":"Second result"',
      )
      expect(dispatches.every((row) => row.result_text?.includes('"status":"completed"'))).toBe(true)
      expect(yield* SessionDispatchOrigin.contains(db, sessionB, messages[0].id)).toBe(true)
      expect(yield* SessionDispatchOrigin.contains(db, sessionB, messages[1].id)).toBe(true)
      expect(yield* SessionDispatchOrigin.contains(db, sessionB, messages[2].id)).toBe(false)
    }),
  )

  for (const status of ["completed", "failed", "interrupted"]) {
    it.effect(
      `correlates ${status} worker results once, across service recreation and lost delivery acknowledgements`,
      () =>
        Effect.gen(function* () {
          const input = yield* setupVoice
          const { db } = yield* Database.Service
          const service = yield* SessionLinks.Service
          yield* service.bind({ ...linkPolicy, sourceSessionID: sessionA, targetSessionID: sessionB })
          const admitted = yield* service.send(input)
          // Merely admitted work must not be mistaken for a result.
          yield* service.deliver(sessionB)
          expect(yield* db.select().from(SessionInputTable).all().pipe(Effect.orDie)).toHaveLength(1)
          yield* SessionInput.promoteNextQueued(db, yield* EventV2.Service, sessionB)
          const promoted = yield* SessionInput.find(db, admitted.id)
          if (promoted?.promotedSeq === undefined) throw new Error("Missing promoted fixture")
          const message = new SessionMessage.Assistant({
            id: SessionMessage.ID.create(),
            type: "assistant",
            agent: "build",
            model: Schema.decodeUnknownSync(ModelV2.Ref)({ id: "worker-model", providerID: "test" }),
            time: { created: DateTime.makeUnsafe(10), completed: DateTime.makeUnsafe(11) },
            content: [
              new SessionMessage.AssistantText({
                type: "text",
                id: "text",
                text: "Result evidence " + "x".repeat(5_000),
              }),
              new SessionMessage.AssistantReasoning({ type: "reasoning", id: "reasoning", text: "private reasoning" }),
            ],
          })
          yield* db
            .insert(SessionMessageTable)
            .values([
              messageRow(message, sessionB, promoted.promotedSeq + 2),
              messageRow(
                new SessionMessage.Assistant({
                  ...message,
                  id: SessionMessage.ID.create(),
                  content: [
                    new SessionMessage.AssistantText({ type: "text", id: "later", text: "Unrelated future result" }),
                  ],
                }),
                sessionB,
                promoted.promotedSeq + 20,
              ),
            ])
            .run()
            .pipe(Effect.orDie)
          yield* db
            .insert(SessionActivityTable)
            .values({
              id: "activity_correlated",
              session_id: sessionB,
              kind: "prompt",
              status: "running",
              opened_seq: admitted.admittedSeq,
              closed_seq: promoted.promotedSeq + 10,
            })
            .run()
            .pipe(Effect.orDie)
          yield* service.deliver(sessionB)
          expect(yield* db.select().from(SessionInputTable).all().pipe(Effect.orDie)).toHaveLength(1)
          yield* db
            .update(SessionActivityTable)
            .set({ status })
            .where(eq(SessionActivityTable.id, "activity_correlated"))
            .run()
            .pipe(Effect.orDie)
          const wakes: SessionV2.ID[] = []
          yield* SessionWakeup.listen((sessionID) =>
            Effect.sync(() => {
              wakes.push(sessionID)
            }),
          )
          yield* Effect.all([service.deliver(sessionB), service.deliver(sessionB)], { concurrency: "unbounded" })
          const dispatch = yield* db.select().from(SessionDispatchTable).get().pipe(Effect.orDie)
          if (!dispatch?.result_text) throw new Error("Result was not frozen")
          expect(dispatch.time_result_delivered).not.toBeNull()
          const result = yield* SessionInput.find(db, dispatch.result_input_id)
          expect(result).toMatchObject({ sessionID: sessionA, delivery: "queue" })
          expect(result?.prompt.agent).toBeUndefined()
          expect(result?.prompt.model).toBeUndefined()
          const payload = JSON.parse(dispatch.result_text.split("\n").slice(1).join("\n"))
          expect(payload).toMatchObject({
            status,
            inputID: admitted.id,
            sourceMessageID: input.sourceMessageID,
            sourceCallID: input.sourceCallID,
            activityID: "activity_correlated",
            truncated: true,
          })
          expect(payload.text).toHaveLength(4_000)
          expect(dispatch.result_text).not.toContain("private reasoning")
          expect(dispatch.result_text).not.toContain("Unrelated future result")
          expect(wakes).toEqual([sessionA])
          // Simulate a process dying after admission but before its delivery marker.
          yield* db.update(SessionDispatchTable).set({ time_result_delivered: null }).run().pipe(Effect.orDie)
          yield* db.delete(SessionMessageTable).where(eq(SessionMessageTable.id, message.id)).run().pipe(Effect.orDie)
          yield* SessionLinks.Service.use((recovered) => recovered.deliver(sessionB)).pipe(
            Effect.provide(SessionLinks.layer),
          )
          expect((yield* SessionInput.find(db, dispatch.result_input_id))?.prompt.text).toBe(dispatch.result_text)
          expect(yield* db.select().from(SessionInputTable).all().pipe(Effect.orDie)).toHaveLength(2)
          expect(wakes.every((id) => id === sessionA)).toBe(true)
          yield* db.update(SessionDispatchTable).set({ time_result_delivered: null }).run().pipe(Effect.orDie)
          yield* service.end({ pluginID, sourceSessionID: sessionA })
          yield* service.deliver(sessionB)
          expect(wakes).toHaveLength(2)
        }),
    )
  }

  it.effect("dispatch and snapshots reject a different owner without changing either session", () =>
    Effect.gen(function* () {
      const input = yield* setupVoice
      const service = yield* SessionLinks.Service
      yield* service.bind({ ...linkPolicy, sourceSessionID: sessionA, targetSessionID: sessionB })
      expect(yield* service.send({ ...input, pluginID: "foreign-plugin" }).pipe(Effect.flip)).toMatchObject({ reason: "ended" })
      expect(yield* service.read({ pluginID: "foreign-plugin", sourceSessionID: sessionA }).pipe(Effect.flip)).toMatchObject({ reason: "ended" })
      expect(yield* service.get({ pluginID: "foreign-plugin", sessionID: sessionB })).toBeUndefined()
      yield* service.end({ pluginID: "foreign-plugin", sourceSessionID: sessionA })
      const first = yield* service.send(input)
      expect(yield* service.send(input)).toEqual(first)
      expect((yield* service.read({ pluginID, sourceSessionID: sessionA })).targetSessionID).toBe(sessionB)
      expect(yield* (yield* Database.Service).db.select().from(SessionInputTable).all().pipe(Effect.orDie)).toHaveLength(1)
    }),
  )

  it.effect("links two ordinary sessions without modifying the worker and admits exactly one input per origin", () =>
    Effect.gen(function* () {
      const input = yield* setupVoice
      const { db } = yield* Database.Service
      const service = yield* SessionLinks.Service
      const before = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionB)).get().pipe(Effect.orDie)
      if (!before) throw new Error("Worker fixture is missing")
      const link = yield* service.bind({ ...linkPolicy, sourceSessionID: sessionA, targetSessionID: sessionB })
      expect(yield* service.bind({ ...linkPolicy, sourceSessionID: sessionA, targetSessionID: sessionB })).toEqual(link)
      expect(yield* service.get({ pluginID, sessionID: sessionB })).toEqual(link)
      expect(
        yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionB)).get().pipe(Effect.orDie),
      ).toEqual(before)
      const replies = yield* Effect.all([service.send(input), service.send(input)], { concurrency: "unbounded" })
      expect(replies[0]).toEqual(replies[1])
      expect(replies[0]).toMatchObject({ sessionID: sessionB, delivery: "queue" })
      expect(replies[0].prompt.agent).toBeUndefined()
      expect(replies[0].prompt.model).toBeUndefined()
      expect(replies[0].prompt.system).toBeUndefined()
      expect(yield* db.select().from(SessionInputTable).all().pipe(Effect.orDie)).toHaveLength(1)
      expect(yield* db.select().from(SessionDispatchTable).all().pipe(Effect.orDie)).toHaveLength(1)
      expect(
        yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionB)).get().pipe(Effect.orDie),
      ).toEqual({
        ...before,
        time_updated: DateTime.toEpochMillis(replies[0].timeCreated),
      })
      expect(yield* db.select().from(SessionTable).all().pipe(Effect.orDie)).toHaveLength(2)
    }),
  )

  it.effect("rejects changed retries and foreign origins, while explicit corrections use steer", () =>
    Effect.gen(function* () {
      const input = yield* setupVoice
      const service = yield* SessionLinks.Service
      yield* service.bind({ ...linkPolicy, sourceSessionID: sessionA, targetSessionID: sessionB })
      yield* service.send(input)
      for (const changed of [{ text: "Different work" }, { delivery: "steer" as const }]) {
        const error = yield* service.send({ ...input, ...changed }).pipe(Effect.flip)
        expect(error).toMatchObject({ _tag: "SessionLinks.Conflict", reason: "retry" })
      }
      const foreign = yield* service.send({ ...input, sourceMessageID: SessionMessage.ID.create() }).pipe(Effect.flip)
      expect(foreign).toMatchObject({ _tag: "SessionLinks.Conflict", reason: "origin" })
      const correction = yield* service.send({
        ...input,
        sourceCallID: "call_correction",
        delivery: "steer",
        text: "Use the existing test",
      })
      expect(correction.delivery).toBe("steer")
      expect(
        yield* (yield* Database.Service).db.select().from(SessionInputTable).all().pipe(Effect.orDie),
      ).toHaveLength(2)
    }),
  )

  it.effect("ending a link prevents later sends and cannot silently resurrect it", () =>
    Effect.gen(function* () {
      const input = yield* setupVoice
      const service = yield* SessionLinks.Service
      yield* service.bind({ ...linkPolicy, sourceSessionID: sessionA, targetSessionID: sessionB })
      const admitted = yield* service.send(input)
      yield* service.end({ pluginID, sourceSessionID: sessionA })
      yield* service.end({ pluginID, sourceSessionID: sessionA })
      expect(yield* service.get({ pluginID, sessionID: sessionA })).toBeUndefined()
      expect(yield* service.send(input).pipe(Effect.flip)).toMatchObject({ reason: "ended" })
      expect(
        yield* service.bind({ ...linkPolicy, sourceSessionID: sessionA, targetSessionID: sessionB }).pipe(Effect.flip),
      ).toMatchObject({ reason: "ended" })
      expect(yield* Database.Service.use(({ db }) => SessionInput.find(db, admitted.id))).toEqual(admitted)
    }),
  )

  it.effect("revalidates placement and role before every dispatch", () =>
    Effect.gen(function* () {
      const input = yield* setupVoice
      const service = yield* SessionLinks.Service
      const { db } = yield* Database.Service
      yield* service.bind({ ...linkPolicy, sourceSessionID: sessionA, targetSessionID: sessionB })
      yield* db
        .update(SessionTable)
        .set({ directory: "/moved" })
        .where(eq(SessionTable.id, sessionB))
        .run()
        .pipe(Effect.orDie)
      expect(yield* service.send(input).pipe(Effect.flip)).toMatchObject({ reason: "placement" })
      yield* db
        .update(SessionTable)
        .set({ directory: "/project", agent: "voice-moderator" })
        .where(eq(SessionTable.id, sessionB))
        .run()
        .pipe(Effect.orDie)
      expect((yield* service.send(input)).sessionID).toBe(sessionB)
      expect(yield* db.select().from(SessionInputTable).all().pipe(Effect.orDie)).toHaveLength(1)
    }),
  )

  it.effect("a recreated service resumes a reserved dispatch without replacing its input ID", () =>
    Effect.gen(function* () {
      const input = yield* setupVoice
      const service = yield* SessionLinks.Service
      const { db } = yield* Database.Service
      yield* service.bind({ ...linkPolicy, sourceSessionID: sessionA, targetSessionID: sessionB })
      yield* db
        .update(SessionTable)
        .set({ revert: { messageID: "msg_revert" } })
        .where(eq(SessionTable.id, sessionB))
        .run()
        .pipe(Effect.orDie)
      expect(yield* service.send(input).pipe(Effect.flip)).toMatchObject({ _tag: "SessionAccess.RevertActiveError" })
      const reserved = yield* db.select().from(SessionDispatchTable).get().pipe(Effect.orDie)
      if (!reserved) throw new Error("Dispatch was not reserved")
      yield* db.update(SessionTable).set({ revert: null }).where(eq(SessionTable.id, sessionB)).run().pipe(Effect.orDie)
      const admitted = yield* SessionLinks.Service.use((fresh) => fresh.send(input)).pipe(
        Effect.provide(SessionLinks.layer),
      )
      expect(admitted.id).toBe(reserved.target_input_id)
      expect(yield* db.select().from(SessionInputTable).all().pipe(Effect.orDie)).toHaveLength(1)
    }),
  )

  it.effect("bounds moderator context on a worker with more than 160 turns without changing its history", () =>
    Effect.gen(function* () {
      yield* setupVoice
      const service = yield* SessionLinks.Service
      yield* service.bind({ ...linkPolicy, sourceSessionID: sessionA, targetSessionID: sessionB })
      yield* Effect.forEach(
        Array.from({ length: 180 }, (_, index) => index + 1),
        (seq) => insertMessage(sessionB, seq, `turn ${seq}: ${"x".repeat(2_000)}`),
      )
      const snapshot = yield* service.read({ pluginID, sourceSessionID: sessionA })
      expect(snapshot.targetSessionID).toBe(sessionB)
      expect(snapshot.messages).toHaveLength(12)
      expect(snapshot.messages[0].text).toStartWith("turn 169:")
      expect(snapshot.messages.at(-1)?.text).toStartWith("turn 180:")
      expect(snapshot.messages.reduce((size, message) => size + message.text.length, 0)).toBe(12_000)
      expect(snapshot.truncated).toBe(true)
      expect(snapshot.activity.type).toBe("idle")
      const complete = yield* (yield* SessionAccess.Service).messages({ sessionID: sessionB, limit: 200, order: "asc" })
      expect(complete.messages).toHaveLength(180)
      yield* service.end({ pluginID, sourceSessionID: sessionA })
      expect(yield* service.read({ pluginID, sourceSessionID: sessionA }).pipe(Effect.flip)).toMatchObject({ reason: "ended" })
    }),
  )

  it.effect("allows only one active voice per worker, but retains ended links when a new conversation starts", () =>
    Effect.gen(function* () {
      yield* setupVoice
      const service = yield* SessionLinks.Service
      const { db } = yield* Database.Service
      const second = SessionV2.ID.create()
      yield* db
        .insert(SessionTable)
        .values({
          id: second,
          project_id: Project.ID.global,
          slug: second,
          directory: "/project",
          title: "Second voice",
          version: "test",
          agent: "voice-moderator",
        })
        .run()
        .pipe(Effect.orDie)
      const results = yield* Effect.all(
        [sessionA, second].map((sourceSessionID) =>
          service.bind({ ...linkPolicy, sourceSessionID, targetSessionID: sessionB }).pipe(Effect.exit),
        ),
        { concurrency: "unbounded" },
      )
      expect(results.filter((result) => result._tag === "Success")).toHaveLength(1)
      expect(results.filter((result) => result._tag === "Failure")).toHaveLength(1)
      const current = yield* service.get({ pluginID, sessionID: sessionB })
      if (!current) throw new Error("Active link missing")
      yield* service.end({ pluginID, sourceSessionID: current.source_session_id })
      const replacement = yield* service.bind({ ...linkPolicy,
        sourceSessionID: current.source_session_id === sessionA ? second : sessionA,
        targetSessionID: sessionB,
      })
      expect(replacement.source_session_id).not.toBe(current.source_session_id)
    }),
  )

  it.effect("does not bind across locations and accepts ordinary source agents", () =>
    Effect.gen(function* () {
      yield* setup
      const service = yield* SessionLinks.Service
      expect((yield* service.bind({ ...linkPolicy, sourceSessionID: sessionA, targetSessionID: sessionB })).source_session_id).toBe(sessionA)
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ agent: "voice-moderator", directory: "/other" })
        .where(eq(SessionTable.id, sessionA))
        .run()
        .pipe(Effect.orDie)
      expect(
        yield* service.bind({ ...linkPolicy, sourceSessionID: sessionA, targetSessionID: sessionB }).pipe(Effect.flip),
      ).toMatchObject({ reason: "placement" })
    }),
  )
})

describe("SessionAccess", () => {
  it.effect("pages projected messages without crossing Session boundaries", () =>
    Effect.gen(function* () {
      yield* setup
      yield* insertMessage(sessionA, 1, "a1")
      yield* insertMessage(sessionA, 2, "a2")
      yield* insertMessage(sessionA, 3, "a3")
      yield* insertMessage(sessionB, 1, "b1")
      const sessions = yield* SessionAccess.Service

      const first = yield* sessions.messages({ sessionID: sessionA, limit: 2, order: "asc" })
      expect(first.messages.map((message) => message.type === "user" && message.text)).toEqual(["a1", "a2"])
      expect(first.hasMore).toBe(true)

      const second = yield* sessions.messages({
        sessionID: sessionA,
        limit: 2,
        order: "asc",
        cursor: { id: first.messages.at(-1)!.id, direction: "next" },
      })
      expect(second.messages.map((message) => message.type === "user" && message.text)).toEqual(["a3"])
      expect(second.hasMore).toBe(false)
    }),
  )

  it.effect("durably admits a message and requests an advisory wake", () =>
    Effect.gen(function* () {
      yield* setup
      const sessions = yield* SessionAccess.Service
      const wakes: Array<{ sessionID: SessionV2.ID; admittedSeq: number }> = []
      yield* SessionWakeup.listen((sessionID, admittedSeq) => Effect.sync(() => wakes.push({ sessionID, admittedSeq })))
      const admitted = yield* sessions.send({
        sessionID: sessionB,
        prompt: new Prompt({ text: "from another Session" }),
        delivery: "queue",
      })
      const stored = yield* Database.Service.use(({ db }) => SessionInput.find(db, admitted.id))
      expect(stored).toMatchObject({ sessionID: sessionB, delivery: "queue" })
      expect(wakes).toEqual([{ sessionID: sessionB, admittedSeq: admitted.admittedSeq }])
    }),
  )

  it.effect("reconciles stable dispatch IDs without duplicating durable inputs", () =>
    Effect.gen(function* () {
      yield* setup
      const sessions = yield* SessionAccess.Service
      const input = {
        id: SessionMessage.ID.create(),
        sessionID: sessionB,
        prompt: new Prompt({ text: "one voice dispatch" }),
        delivery: "queue" as const,
      }
      const first = yield* sessions.send(input)
      const retry = yield* sessions.send(input)
      expect(first.id).toBe(input.id)
      expect(retry).toEqual(first)
      const rows = yield* (yield* Database.Service).db.select().from(SessionInputTable).all().pipe(Effect.orDie)
      expect(rows).toHaveLength(1)
    }),
  )

  it.effect("rejects conflicting dispatch ID reuse without waking the wrong worker", () =>
    Effect.gen(function* () {
      yield* setup
      const sessions = yield* SessionAccess.Service
      const input = {
        id: SessionMessage.ID.create(),
        sessionID: sessionB,
        prompt: new Prompt({ text: "original instruction" }),
        delivery: "queue" as const,
      }
      const first = yield* sessions.send(input)
      const wakes: string[] = []
      yield* SessionWakeup.listen((sessionID) => Effect.sync(() => wakes.push(sessionID)))
      for (const change of [
        { sessionID: sessionA },
        { prompt: new Prompt({ text: "changed instruction" }) },
        { delivery: "steer" as const },
      ]) {
        const result = yield* sessions.send({ ...input, ...change }).pipe(Effect.exit)
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") expect(String(result.cause)).toContain("SessionAccess.PromptConflictError")
      }
      expect(wakes).toEqual([])
      expect(yield* Database.Service.use(({ db }) => SessionInput.find(db, input.id))).toEqual(first)
    }),
  )

  it.effect("rejects a cursor from another Session", () =>
    Effect.gen(function* () {
      yield* setup
      yield* insertMessage(sessionA, 1, "a1")
      yield* insertMessage(sessionB, 1, "b1")
      const sessions = yield* SessionAccess.Service
      const exit = yield* sessions
        .messages({
          sessionID: sessionA,
          limit: 1,
          order: "asc",
          cursor: { id: SessionMessage.ID.make(`msg_${sessionB}_1`), direction: "next" },
        })
        .pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(String(exit.cause)).toContain("SessionAccess.InvalidCursorError")
    }),
  )
})
