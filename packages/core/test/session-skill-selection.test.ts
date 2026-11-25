import { expect, test } from "bun:test"
import { DateTime, Effect, Layer, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { ModelV2 } from "@opencode-ai/core/model"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionSkillSelection } from "@opencode-ai/core/session/skill-selection"
import { SessionInputTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SkillV2 } from "@opencode-ai/core/skill"

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const dependencies = Layer.mergeAll(database, events)
const layer = Layer.mergeAll(dependencies, SessionProjector.layer.pipe(Layer.provide(dependencies)))
const sessionID = SessionSchema.ID.make("ses_skill_selection")
const assistantMessageID = SessionMessage.ID.make("msg_skill_call")
const skill = new SkillV2.Info({
  name: "manual", aliases: ["manual-alias"], disableModelInvocation: true,
  description: "Manual workflow", content: "Guidance", location: AbsolutePath.make("/fixture/SKILL.md"),
})

const fixture = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const eventService = yield* EventV2.Service
  yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/fixture"), sandboxes: [] }).run()
  yield* db.insert(SessionTable).values({ id: sessionID, project_id: Project.ID.global, directory: "/fixture", slug: "skills", title: "Skills", version: "test" }).run()
  const user = Effect.fnUntraced(function* (
    id: string, seq: number, text: string, origin: "interactive" | "plugin" | null = "interactive", admittedText = text,
  ) {
    const message = new SessionMessage.User({
      id: SessionMessage.ID.make(id), type: "user", text, files: [], agents: [], time: { created: DateTime.makeUnsafe(1000) },
    })
    const { id: messageID, type, ...data } = Schema.encodeSync(SessionMessage.User)(message)
    yield* db.insert(SessionMessageTable).values({ id: SessionMessage.ID.make(messageID), session_id: sessionID, type, seq, data }).run()
    yield* db.insert(SessionInputTable).values({ id: message.id, session_id: sessionID, prompt: { text: admittedText },
      delivery: "steer", origin, admitted_seq: seq, promoted_seq: seq, time_created: 1000 }).run()
  })
  const assistant = new SessionMessage.Assistant({
    id: assistantMessageID, type: "assistant", agent: "build", content: [],
    model: Schema.decodeUnknownSync(ModelV2.Ref)({ id: "fixture", providerID: "fixture" }),
    time: { created: DateTime.makeUnsafe(2000) },
  })
  const { id, type, ...data } = Schema.encodeSync(SessionMessage.Assistant)(assistant)
  yield* db.insert(SessionMessageTable).values({ id: SessionMessage.ID.make(id), session_id: sessionID, type, seq: 100, data }).run()
  const gate = (now = 2000, limits = { minutes: 15, messages: 15 }, source = assistantMessageID) =>
    SessionSkillSelection.resolveForGate({ db, events: eventService, sessionID, skill, fenceSeq: 100, assistantMessageID: source, limits, now })
  return { db, events: eventService, user, gate }
})

test("adopts an attested alias once and remembers it across later dialogue", async () => {
  await Effect.gen(function* () {
    const f = yield* fixture
    yield* f.user("msg_selected", 1, "Bitte prüfen\n\n/manual-alias")
    yield* f.user("msg_followup", 2, "Continue")
    expect(yield* f.gate()).toMatchObject({ selected: true, row: { generation: 1, origin_id: "msg_selected" } })
    expect(yield* f.gate()).toMatchObject({ selected: true, row: { generation: 1 } })
    expect(yield* f.gate(2000, { minutes: 15, messages: 15 }, SessionMessage.ID.make("msg_foreign")))
      .toMatchObject({ selected: false, reason: "state_unavailable" })
  }).pipe(Effect.provide(layer), Effect.runPromise)
})

for (const origin of ["plugin", null] as const) {
  test(`does not adopt ${origin ?? "unattested"} slash text`, async () => {
    await Effect.gen(function* () {
      const f = yield* fixture
      yield* f.user("msg_untrusted", 1, "/manual", origin)
      expect(yield* f.gate()).toMatchObject({ selected: false, reason: "not_selected" })
    }).pipe(Effect.provide(layer), Effect.runPromise)
  })
}

test("rejects changed input text and a slash admitted after the consuming call", async () => {
  await Effect.gen(function* () {
    const f = yield* fixture
    yield* f.user("msg_changed", 1, "/manual", "interactive", "No slash")
    yield* f.user("msg_future", 101, "/manual")
    expect(yield* f.gate()).toMatchObject({ selected: false, reason: "not_selected" })
  }).pipe(Effect.provide(layer), Effect.runPromise)
})

test("time and message expiry never renew the same original selection", async () => {
  await Effect.gen(function* () {
    const f = yield* fixture
    yield* f.user("msg_selected", 1, "/manual")
    expect(yield* f.gate()).toMatchObject({ selected: true })
    expect(yield* f.gate(901000)).toMatchObject({ selected: false, reason: "expired_time", row: { generation: 1 } })
    yield* f.user("msg_later", 2, "Continue")
    expect(yield* f.gate(2000, { minutes: 15, messages: 1 })).toMatchObject({ selected: false, reason: "expired_messages" })
    yield* f.user("msg_reselected", 3, "/manual")
    expect(yield* f.gate()).toMatchObject({ selected: true, row: { generation: 2, origin_id: "msg_reselected" } })
  }).pipe(Effect.provide(layer), Effect.runPromise)
})

test("current limits may shorten but never extend a saved selection", async () => {
  await Effect.gen(function* () {
    const f = yield* fixture
    yield* f.user("msg_selected", 1, "/manual")
    expect(yield* f.gate(2000, { minutes: 1, messages: 1 })).toMatchObject({ selected: true })
    expect(yield* f.gate(61000, { minutes: 15, messages: 15 }))
      .toMatchObject({ selected: false, reason: "expired_time", row: { generation: 1 } })
    expect(yield* f.gate(2000, { minutes: 0, messages: 15 }))
      .toMatchObject({ selected: false, reason: "state_unavailable" })
    expect(yield* f.gate(0)).toMatchObject({ selected: false, reason: "state_unavailable" })
    yield* f.user("msg_later", 2, "Continue")
    expect(yield* f.gate(2000, { minutes: 15, messages: 15 }))
      .toMatchObject({ selected: false, reason: "expired_messages", row: { generation: 1 } })
  }).pipe(Effect.provide(layer), Effect.runPromise)
})

test("named and all-selection forget fences block lazy resurrection", async () => {
  await Effect.gen(function* () {
    const f = yield* fixture
    yield* f.user("msg_selected", 0, "/manual")
    expect(yield* f.gate()).toMatchObject({ selected: true })
    yield* f.events.publish(SessionEvent.SkillSelection.Mutation, {
      sessionID, timestamp: DateTime.makeUnsafe(2000), mutation: "forgotten", name: skill.name,
    })
    expect(yield* f.gate()).toMatchObject({ selected: false, reason: "forgotten" })
    yield* f.events.publish(SessionEvent.SkillSelection.Mutation, {
      sessionID, timestamp: DateTime.makeUnsafe(2000), mutation: "forgotten",
    })
    expect(yield* f.gate()).toMatchObject({ selected: false, reason: "forgotten" })
  }).pipe(Effect.provide(layer), Effect.runPromise)
})

test("renewal is generation-bound and declined generations stay suppressed", async () => {
  await Effect.gen(function* () {
    const f = yield* fixture
    yield* f.user("msg_selected", 0, "/manual")
    yield* f.gate()
    yield* SessionSkillSelection.recordRenewalDeclined(f.db, f.events, { sessionID, name: skill.name, generation: 99 })
    expect(yield* f.gate()).toMatchObject({ selected: true })
    yield* SessionSkillSelection.recordRenewalDeclined(f.db, f.events, { sessionID, name: skill.name, generation: 1 })
    expect(yield* f.gate()).toMatchObject({ selected: false, reason: "renewal_declined" })
    const receipt = { sessionID, name: skill.name, kind: "renewal" as const, receiptID: "host-receipt", limits: { minutes: 15, messages: 15 },
      boundMessageID: assistantMessageID, expectedGeneration: 1 }
    expect(yield* SessionSkillSelection.recordReceipt(f.db, f.events, { ...receipt, receiptID: "" })).toBe(false)
    expect(yield* SessionSkillSelection.recordReceipt(f.db, f.events, { ...receipt, expectedGeneration: 99 })).toBe(false)
    expect(yield* SessionSkillSelection.recordReceipt(f.db, f.events, receipt)).toBe(true)
    expect(yield* SessionSkillSelection.recordReceipt(f.db, f.events, receipt)).toBe(false)
    expect(yield* f.gate(Date.now())).toMatchObject({ selected: true, row: { generation: 2, bound_message_id: assistantMessageID } })
  }).pipe(Effect.provide(layer), Effect.runPromise)
})

test("overview is read-only, never adopts pending slash inputs and shares expiry with the real gate", async () => {
  await Effect.gen(function* () {
    const f = yield* fixture
    yield* f.user("msg_overview_slash", 1, "/manual")
    const inspect = (now = 2000, limits = { minutes: 15, messages: 15 }) =>
      SessionSkillSelection.inspect(f.db, { sessionID, limits, now, names: [skill.name] })
    expect((yield* inspect()).selections).toEqual([])
    expect(yield* SessionSkillSelection.row(f.db, sessionID, skill.name)).toBeUndefined()
    yield* f.gate()
    const before = yield* inspect()
    expect(before.selections).toMatchObject([{ name: skill.name, status: "active", generation: 1, recognized: true }])
    expect((yield* inspect()).revision).toBe(before.revision)
    expect((yield* SessionSkillSelection.inspect(f.db, { sessionID, limits: { minutes: 15, messages: 15 },
      now: 2000, names: [skill.name], enabled: false })).selections).toMatchObject([{ status: "state_unavailable" }])
    expect((yield* SessionSkillSelection.inspect(f.db, { sessionID, limits: { minutes: 15, messages: 15 },
      now: 2000, names: [] })).selections).toMatchObject([{ status: "missing", recognized: false }])
    expect((yield* inspect(901000)).selections).toMatchObject([{ status: "expired_time" }])
    yield* f.user("msg_overview_later", 2, "Continue")
    expect((yield* inspect(2000, { minutes: 15, messages: 1 })).selections).toMatchObject([{ status: "expired_messages" }])
    expect((yield* SessionSkillSelection.row(f.db, sessionID, skill.name))?.generation).toBe(1)
  }).pipe(Effect.provide(layer), Effect.runPromise)
})

test("forget compares the snapshot revision, serializes concurrent requests and never resurrects an old input", async () => {
  await Effect.gen(function* () {
    const f = yield* fixture
    yield* f.user("msg_forget_slash", 0, "/manual")
    yield* f.gate()
    const snapshot = yield* SessionSkillSelection.inspect(f.db, { sessionID, limits: { minutes: 15, messages: 15 }, now: 2000, names: [skill.name] })
    const request = { sessionID, name: skill.name, expectedRevision: snapshot.revision, operationID: "forget-first" }
    const results = yield* Effect.all([
      SessionSkillSelection.forget(f.db, f.events, request),
      SessionSkillSelection.forget(f.db, f.events, { ...request, operationID: "forget-racing" }),
    ], { concurrency: "unbounded" })
    expect(results.map((result) => result._tag).sort()).toEqual(["Forgotten", "RevisionConflict"])
    expect(yield* f.gate()).toMatchObject({ selected: false, reason: "forgotten" })
    const accepted = results[0]._tag === "Forgotten" ? request : { ...request, operationID: "forget-racing" }
    expect((yield* SessionSkillSelection.forget(f.db, f.events, accepted))._tag).toBe("DuplicateOperation")
    const current = yield* SessionSkillSelection.inspect(f.db, { sessionID, limits: { minutes: 15, messages: 15 }, now: 2000, names: [skill.name] })
    expect(current.selections).toMatchObject([{ status: "forgotten" }])
    const all = yield* SessionSkillSelection.forget(f.db, f.events, {
      sessionID, expectedRevision: current.revision, operationID: "forget-all",
    })
    expect(all._tag).toBe("Forgotten")
    expect(yield* f.gate()).toMatchObject({ selected: false, reason: "forgotten" })
  }).pipe(Effect.provide(layer), Effect.runPromise)
})
