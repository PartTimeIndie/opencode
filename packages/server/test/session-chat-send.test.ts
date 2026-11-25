import { expect, test } from "bun:test"
import { DateTime, Effect, Layer, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { ModelV2 } from "@opencode-ai/core/model"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { QuestionV2 } from "@opencode-ai/core/question"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionSkillSelection } from "@opencode-ai/core/session/skill-selection"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SkillV2 } from "@opencode-ai/core/skill"
import { admitQuestionChatSend } from "../src/handlers/session"

const sessionID = SessionV2.ID.make("ses_chat_send_fixture")
const request: QuestionV2.BlockingRequest = {
  id: QuestionV2.ID.make("que_chat_send_fixture"), sessionID, revision: 1, actions: [], mode: "blocking",
  questions: [{ question: "Run this skill?", options: [], chatSend: { text: "/manual-workflow" } }],
}
const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const layer = Layer.mergeAll(database, events, SessionProjector.layer.pipe(Layer.provide(database), Layer.provide(events)))

test("chat-send admits the exact attested input before replying but never mints a selection or starts a runner", async () => {
  await Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/fixture"), sandboxes: [] }).run()
    yield* db.insert(SessionTable).values({ id: sessionID, project_id: Project.ID.global, directory: "/fixture",
      slug: "chat-send", title: "chat-send", version: "test" }).run()
    let replies = 0
    const result = yield* admitQuestionChatSend({ sessionID, requestID: request.id, text: "/manual-workflow", id: "msg_chat_send",
      questions: { get: () => Effect.succeed(request), reply: () => Effect.gen(function* () {
        const input = yield* SessionInput.find(db, resultID)
        expect(input).toMatchObject({ origin: "interactive", delivery: "queue", prompt: { text: "/manual-workflow" } })
        expect(input?.promotedSeq).toBeUndefined()
        expect(yield* SessionSkillSelection.row(db, sessionID, "manual-workflow")).toBeUndefined()
        replies++
      }) },
      session: { prompt: (input) => {
        expect(input.id).toBe(resultID)
        expect(input.resume).toBe(false)
        expect(input.origin).toBe("interactive")
        return SessionInput.admit(db, events, { id: resultID, sessionID: input.sessionID,
          prompt: new Prompt(input.prompt), delivery: input.delivery ?? "steer", origin: input.origin })
      } },
    })
    expect(result).toMatchObject({ selections: [] })
    expect(result.admitted.id).toBe(resultID)
    expect(replies).toBe(1)
    const skill = new SkillV2.Info({ name: "manual-workflow", disableModelInvocation: true,
      description: "Fixture", content: "Guidance", location: AbsolutePath.make("/fixture/SKILL.md") })
    const assistantMessageID = SessionMessage.ID.make("msg_consuming_gate")
    const gate = (fenceSeq: number) => SessionSkillSelection.resolveForGate({ db, events, sessionID, skill, fenceSeq, assistantMessageID,
      limits: { minutes: 15, messages: 15 }, now: Date.now() })
    expect(yield* gate(yield* SessionInput.latestSeq(db, sessionID))).toMatchObject({ selected: false, reason: "state_unavailable" })
    expect(yield* SessionInput.promoteNextQueued(db, events, sessionID)).toBe(true)
    expect(yield* SessionSkillSelection.row(db, sessionID, skill.name)).toBeUndefined()
    yield* events.publish(SessionEvent.Step.Started, { sessionID, timestamp: DateTime.makeUnsafe(Date.now()),
      assistantMessageID, agent: "build", model: Schema.decodeUnknownSync(ModelV2.Ref)({ id: "fixture", providerID: "fixture" }) })
    const fenceSeq = yield* SessionInput.latestSeq(db, sessionID)
    expect(yield* gate(fenceSeq)).toMatchObject({ selected: true, row: { generation: 1, origin_kind: "input", origin_id: resultID } })
    expect(yield* gate(fenceSeq)).toMatchObject({ selected: true, row: { generation: 1, origin_id: resultID, receipt_input_id: null } })
  }).pipe(Effect.provide(layer), Effect.runPromise)
})

const resultID = SessionMessage.ID.make("msg_chat_send")

test("chat-send refuses missing, foreign, mismatched or multi-question requests before admission", async () => {
  for (const candidate of [undefined, { ...request, id: QuestionV2.ID.make("que_other") },
    { ...request, sessionID: SessionV2.ID.make("ses_other") },
    { ...request, questions: [...request.questions, ...request.questions] },
    { ...request, questions: [{ ...request.questions[0], chatSend: { text: "Different text" } }] },
  ]) {
    let admitted = false
    const exit = await admitQuestionChatSend({ sessionID, requestID: request.id, text: "/manual-workflow", id: "msg_refused",
      questions: { get: () => Effect.succeed(candidate), reply: () => Effect.die("Must not reply") },
      session: { prompt: () => Effect.sync(() => { admitted = true }).pipe(Effect.andThen(Effect.die("Must not admit"))) },
    }).pipe(Effect.exit, Effect.runPromise)
    expect(exit._tag).toBe("Failure")
    expect(admitted).toBe(false)
  }
})

test("chat-send preserves prompt admission errors without settling the question", async () => {
  const conflict = new SessionV2.PromptConflictError({ sessionID, messageID: resultID })
  let replies = 0
  const result = await admitQuestionChatSend({ sessionID, requestID: request.id, text: "/manual-workflow", id: resultID,
    questions: { get: () => Effect.succeed(request), reply: () => Effect.sync(() => { replies++ }) },
    session: { prompt: () => Effect.fail(conflict) },
  }).pipe(Effect.result, Effect.runPromise)
  expect(result).toMatchObject({ _tag: "Failure", failure: conflict })
  expect(replies).toBe(0)
})

test("chat-send settlement failure retains one stable queued input for an explicit retry", async () => {
  await Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/fixture"), sandboxes: [] }).run()
    yield* db.insert(SessionTable).values({ id: sessionID, project_id: Project.ID.global, directory: "/fixture",
      slug: "chat-send", title: "chat-send", version: "test" }).run()
    const session = { prompt: (input: SessionV2.PromptInput) => SessionInput.admit(db, events, {
      id: resultID, sessionID: input.sessionID, prompt: new Prompt(input.prompt), delivery: input.delivery ?? "steer", origin: input.origin,
    }) }
    const failed = yield* admitQuestionChatSend({ session, sessionID, requestID: request.id, text: "/manual-workflow", id: resultID,
      questions: { get: () => Effect.succeed(request), reply: () => Effect.fail(new QuestionV2.ConflictError({ requestID: request.id, reason: "Changed" })) },
    }).pipe(Effect.result)
    expect(failed).toMatchObject({ _tag: "Failure", failure: { kind: "question_settlement_failed" } })
    const stored = yield* SessionInput.find(db, resultID)
    if (!stored) throw new Error("Failed settlement lost its admitted input")
    const retried = yield* admitQuestionChatSend({ session, sessionID, requestID: request.id, text: "/manual-workflow", id: resultID,
      questions: { get: () => Effect.succeed(request), reply: () => Effect.void },
    })
    expect(retried.admitted.admittedSeq).toBe(stored.admittedSeq)
    expect(yield* SessionInput.find(db, resultID)).toEqual(stored)
    expect(yield* SessionSkillSelection.row(db, sessionID, "manual-workflow")).toBeUndefined()
  }).pipe(Effect.provide(layer), Effect.runPromise)
})
