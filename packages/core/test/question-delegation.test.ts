import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Exit, Fiber, Layer } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { QuestionV2 } from "@opencode-ai/core/question"
import { QuestionTable } from "@opencode-ai/core/question/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionOrchestratorTable, SessionOrchestratorTaskTable } from "@opencode-ai/core/session/legacy-delegation/sql"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionActivityTable, SessionInputTable, SessionTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const mainSessionID = SessionSchema.ID.make("ses_del_main")
const childSessionID = SessionSchema.ID.create()
const plainSessionID = SessionSchema.ID.create()
const origin = SessionMessage.ID.make("msg_del_origin")
const agent = AgentV2.ID.make("build")
const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const questions = QuestionV2.layer.pipe(Layer.provide(events), Layer.provide(database))
const fixture = Layer.effectDiscard(
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db.insert(ProjectTable).values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/fixture"), sandboxes: [] }).run().pipe(Effect.orDie)
    for (const [id, parent] of [[mainSessionID, null], [childSessionID, mainSessionID], [plainSessionID, null]] as const) {
      yield* db.insert(SessionTable).values({ id, parent_id: parent, project_id: ProjectV2.ID.global,
        directory: "/fixture", slug: id, title: id, version: "test", agent }).run().pipe(Effect.orDie)
      yield* db.insert(SessionActivityTable).values({ id: `act-${id}`, session_id: id, kind: "prompt", status: "running" }).run().pipe(Effect.orDie)
    }
    yield* db.insert(SessionOrchestratorTable).values({ main_session_id: mainSessionID, checkout_id: "fixture" }).run().pipe(Effect.orDie)
    yield* db.insert(SessionInputTable).values({ id: origin, session_id: mainSessionID, prompt: { text: "scope" },
      delivery: "steer", admitted_seq: 1, promoted_seq: 2 }).run().pipe(Effect.orDie)
    yield* db.insert(SessionOrchestratorTaskTable).values({ id: "task", request_id: "request", main_session_id: mainSessionID,
      origin_input_id: origin, origin_user_message_id: origin, goal: "goal", acceptance: "tests", resources: ["project:*"],
      dependencies: [], checkout_id: "fixture", workspace_mode: "mirror", state: "running", slot_claimed: true,
      child_session_id: childSessionID }).run().pipe(Effect.orDie)
  }),
).pipe(Layer.provide(database))
const it = testEffect(Layer.mergeAll(database, events, questions, fixture))

const makeFixture = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const service = yield* QuestionV2.Service
  const input = {
    sessionID: childSessionID,
    questions: [{ question: "Weiter?", options: [{ id: "yes", label: "Ja" }, { id: "no", label: "Nein" }], allowOther: true }],
    tool: { name: "surface", messageID: "msg_child_question", callID: "child-call" },
  }
  const rows = () => db.select().from(QuestionTable).all().pipe(Effect.orDie)
  const waitFor = (check: (value: ReadonlyArray<QuestionV2.Request>) => boolean) => Effect.gen(function* () {
    for (let index = 0; index < 100; index++) {
      const listed = yield* service.list()
      if (check(listed)) return listed
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.die("Question fixture did not reach the expected state")
  })
  // Stored links are compatibility evidence, not a production delegation path.
  // Seed only this fixture's historical mirror; ask() must never create one.
  const historicalPair = Effect.gen(function* () {
    const fiber = yield* service.ask(input).pipe(Effect.forkScoped)
    yield* waitFor((listed) => listed.some((request) => request.sessionID === childSessionID))
    const source = (yield* rows())[0]
    if (!source || source.request.mode !== "blocking") return yield* Effect.die("Missing child question")
    const mirrorID = QuestionV2.ID.ascending()
    const mirror = { ...source.request, id: mirrorID, sessionID: mainSessionID, tool: undefined, detached: true,
      delegatedFrom: { sessionID: childSessionID, requestID: source.id } }
    yield* db.update(QuestionTable).set({ request: { ...source.request, delegatedTo: mirrorID } })
      .where(eq(QuestionTable.id, source.id)).run().pipe(Effect.orDie)
    yield* db.insert(QuestionTable).values({ id: mirrorID, session_id: mainSessionID, seq: source.seq,
      state: "active", mode: "blocking", detached: true, allow_concurrent: true, request: mirror }).run().pipe(Effect.orDie)
    return { fiber, source, mirror }
  })
  return { db, service, input, rows, waitFor, historicalPair }
})

describe("historical delegated questions after engine retirement", () => {
  for (const sessionID of [plainSessionID, childSessionID])
    it.live(`new questions stay on their own session (${sessionID})`, () => Effect.gen(function* () {
      const fixture = yield* makeFixture
      const fiber = yield* fixture.service.ask({ ...fixture.input, sessionID }).pipe(Effect.forkScoped)
      const listed = yield* fixture.waitFor((listed) => listed.some((request) => request.sessionID === sessionID))
      expect(listed).toHaveLength(1)
      expect(listed[0]).not.toHaveProperty("delegatedFrom")
      expect(listed[0]).not.toHaveProperty("delegatedTo")
      yield* fixture.service.reply({ requestID: listed[0].id, answers: [["Ja"]] })
      expect(yield* Fiber.join(fiber)).toEqual([["Ja"]])
      expect(yield* fixture.rows()).toHaveLength(1)
    }))

  for (const source of ["main", "recommended"] as const)
    it.live(`automated ${source} answers cannot use old links or saved control state`, () => Effect.gen(function* () {
      const fixture = yield* makeFixture
      const pair = yield* fixture.historicalPair
      const before = yield* fixture.rows()
      expect(yield* fixture.service.replyFromMain({ mainSessionID, requestID: pair.mirror.id,
        expectedRevision: pair.mirror.revision, source, answers: [["Ja"]] }).pipe(Effect.flip))
        .toMatchObject({ reason: "Legacy delegated automated answers have been removed" })
      expect(yield* fixture.rows()).toEqual(before)
      yield* fixture.service.reply({ requestID: pair.mirror.id, answers: [["Nein"]] })
      expect(yield* Fiber.join(pair.fiber)).toEqual([["Nein"]])
      expect((yield* fixture.rows()).map((row) => row.answer_source)).toEqual(["user", "user"])
    }))

  for (const side of ["source", "mirror"] as const)
    it.live(`human answer at the historical ${side} settles both receipts`, () => Effect.gen(function* () {
      const fixture = yield* makeFixture
      const pair = yield* fixture.historicalPair
      expect(pair.mirror.tool).toBeUndefined()
      yield* fixture.service.reply({ requestID: side === "source" ? pair.source.id : pair.mirror.id, answers: [["Ja"]] })
      expect(yield* Fiber.join(pair.fiber)).toEqual([["Ja"]])
      const settled = yield* fixture.rows()
      expect(settled.map((row) => row.state)).toEqual(["replied", "replied"])
      expect(settled.map((row) => row.answer_source)).toEqual(["user", "user"])
      expect(Exit.isFailure(yield* fixture.service.reply({ requestID: pair.mirror.id, answers: [["Nein"]] }).pipe(Effect.exit))).toBe(true)
      expect(yield* fixture.rows()).toEqual(settled)
      const reloaded = yield* QuestionV2.Service.pipe(Effect.provide(QuestionV2.layer))
      expect(yield* reloaded.answerSourceForTool!({ sessionID: childSessionID, messageID: "msg_child_question", callID: "child-call" })).toBe("user")
      expect(yield* reloaded.answerSourceForTool!({ sessionID: mainSessionID, messageID: "msg_child_question", callID: "child-call" })).toBeNull()
    }))

  for (const source of ["main", "recommended"] as const)
    it.live(`reloaded historical ${source} provenance remains readable without new authority`, () => Effect.gen(function* () {
      const fixture = yield* makeFixture
      const pair = yield* fixture.historicalPair
      yield* fixture.service.reply({ requestID: pair.source.id, answers: [["Ja"]] })
      yield* Fiber.join(pair.fiber)
      // Simulate an already settled pre-retirement receipt, not a new answer.
      yield* fixture.db.update(QuestionTable).set({ answer_source: source }).run().pipe(Effect.orDie)
      const reloaded = yield* QuestionV2.Service.pipe(Effect.provide(QuestionV2.layer))
      expect(yield* reloaded.answerSourceForTool!({ sessionID: childSessionID, messageID: "msg_child_question", callID: "child-call" })).toBe(source)
    }))

  for (const side of [mainSessionID, childSessionID])
    it.live(`session dismissal at ${side} closes both historical rows`, () => Effect.gen(function* () {
      const fixture = yield* makeFixture
      const pair = yield* fixture.historicalPair
      yield* fixture.service.dismissSession(side)
      expect(Exit.isFailure(yield* Fiber.await(pair.fiber))).toBe(true)
      expect((yield* fixture.rows()).map((row) => row.state)).toEqual(["rejected", "rejected"])
    }))

  it.live("orphaned historical source closes its mirror", () => Effect.gen(function* () {
    const fixture = yield* makeFixture
    const pair = yield* fixture.historicalPair
    yield* fixture.db.update(SessionActivityTable).set({ status: "completed" })
      .where(eq(SessionActivityTable.session_id, childSessionID)).run().pipe(Effect.orDie)
    expect(Exit.isFailure(yield* Fiber.await(pair.fiber))).toBe(true)
    const states = (yield* fixture.rows()).map((row) => row.state)
    expect(states).toEqual(["orphaned", "rejected"])
  }))

  it.live("historical mirror does not occupy Main's exclusive question slot", () => Effect.gen(function* () {
    const fixture = yield* makeFixture
    const pair = yield* fixture.historicalPair
    const own = yield* fixture.service.ask({ ...fixture.input, sessionID: mainSessionID, tool: undefined }).pipe(Effect.forkScoped)
    const listed = yield* fixture.waitFor((listed) => listed.filter((request) => request.sessionID === mainSessionID).length === 2)
    const request = listed.find((request) => request.sessionID === mainSessionID && request.mode === "blocking" && !request.delegatedFrom)
    if (!request) return yield* Effect.die("Missing Main's own question")
    yield* fixture.service.reply({ requestID: request.id, answers: [["Ja"]] })
    yield* fixture.service.reply({ requestID: pair.mirror.id, answers: [["Nein"]] })
    expect(yield* Fiber.join(own)).toEqual([["Ja"]])
    expect(yield* Fiber.join(pair.fiber)).toEqual([["Nein"]])
  }))

  it.live("exact legacy tool retry reuses the stored pair without adding authority", () => Effect.gen(function* () {
    const fixture = yield* makeFixture
    const pair = yield* fixture.historicalPair
    const retry = yield* fixture.service.ask(fixture.input).pipe(Effect.forkScoped)
    yield* Effect.sleep("50 millis")
    expect(yield* fixture.rows()).toHaveLength(2)
    yield* fixture.service.reply({ requestID: pair.mirror.id, answers: [["Ja"]] })
    expect(yield* Fiber.join(pair.fiber)).toEqual([["Ja"]])
    expect(yield* Fiber.join(retry)).toEqual([["Ja"]])
  }))

  it.live("new child FIFO does not create more historical mirrors", () => Effect.gen(function* () {
    const fixture = yield* makeFixture
    const pair = yield* fixture.historicalPair
    const second = yield* fixture.service.ask({ ...fixture.input, tool: undefined }).pipe(Effect.forkScoped)
    yield* Effect.sleep("50 millis")
    const queued = yield* fixture.rows()
    expect(queued).toHaveLength(3)
    expect(queued.filter((row) => row.state === "queued")).toHaveLength(1)
    yield* fixture.service.reply({ requestID: pair.source.id, answers: [["Ja"]] })
    expect(yield* Fiber.join(pair.fiber)).toEqual([["Ja"]])
    const listed = yield* fixture.waitFor((listed) => listed.some((request) => request.sessionID === childSessionID))
    const next = listed.find((request) => request.sessionID === childSessionID)
    if (!next) return yield* Effect.die("Missing promoted child question")
    yield* fixture.service.reply({ requestID: next.id, answers: [["Nein"]] })
    expect(yield* Fiber.join(second)).toEqual([["Nein"]])
  }))

  it.live("broken reciprocal links refuse settlement without stranding one receipt", () => Effect.gen(function* () {
    const fixture = yield* makeFixture
    const pair = yield* fixture.historicalPair
    const request = { ...pair.source.request, delegatedTo: pair.mirror.id }
    yield* fixture.db.update(QuestionTable).set({ request: pair.source.request })
      .where(eq(QuestionTable.id, pair.source.id)).run().pipe(Effect.orDie)
    expect(yield* fixture.service.reply({ requestID: pair.mirror.id, answers: [["Ja"]] }).pipe(Effect.flip)).toBeInstanceOf(QuestionV2.ConflictError)
    expect((yield* fixture.rows()).map((row) => row.state)).toEqual(["active", "active"])
    yield* fixture.db.update(QuestionTable).set({ request }).where(eq(QuestionTable.id, pair.source.id)).run().pipe(Effect.orDie)
    yield* fixture.service.reject(pair.mirror.id)
    expect(Exit.isFailure(yield* Fiber.await(pair.fiber))).toBe(true)
  }))
})
