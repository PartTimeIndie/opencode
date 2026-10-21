import { describe, expect } from "bun:test"
import { DateTime, Effect, Fiber, Layer, Stream } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionInputTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { testEffect } from "./lib/effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ContentStore } from "@opencode-ai/core/content-store"
import { FileAttachment } from "@opencode-ai/core/session/prompt"

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
const store = SessionStore.layer.pipe(Layer.provide(database))
const executionCalls: SessionV2.ID[] = []
const interruptCalls: SessionV2.ID[] = []
const interruptSeqs: Array<number | undefined> = []
const waitCalls: SessionV2.ID[] = []
const wakeCalls: SessionV2.ID[] = []
const wakeSeqs: Array<number | undefined> = []
const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    resumeOrJoin: () => Effect.void,
    resume: (sessionID) =>
      Effect.sync(() => {
        executionCalls.push(sessionID)
      }),
    queueContinuation: () => Effect.void,
    interrupt: (sessionID, seq) =>
      Effect.sync(() => {
        interruptCalls.push(sessionID)
        interruptSeqs.push(seq)
      }),
    interruptActivity: () => Effect.succeed(false),
    cancelTool: () => Effect.succeed(false),
    wait: (sessionID) => Effect.sync(() => waitCalls.push(sessionID)),
    wake: (sessionID, seq) =>
      Effect.sync(() => {
        wakeCalls.push(sessionID)
        wakeSeqs.push(seq)
      }),
  }),
)
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
    normalizePrompt: (input) =>
      Effect.succeed(
        new Prompt({
          ...input.prompt,
          files: input.prompt.files?.map(
            (file, index) =>
              new FileAttachment({ ...file, uri: `${ContentStore.URI_PREFIX}${input.messageID}_${index}` }),
          ),
        }),
      ),
    normalizeFiles: (input) => Effect.succeed(input.files),
    locate: () => Effect.succeed(undefined),
    resolve: () => Effect.succeed(undefined),
    materialize: (input) => Effect.succeed(input.file),
  }),
)
const sessions = SessionV2.layer.pipe(
  Layer.provide(events),
  Layer.provide(database),
  Layer.provide(store),
  Layer.provide(Project.defaultLayer),
  Layer.provide(execution),
  Layer.provide(content),
)
const it = testEffect(Layer.mergeAll(database, events, projector, store, execution, content, sessions))
const sessionID = SessionV2.ID.make("ses_prompt_test")
const messageID = SessionMessage.ID.create()

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
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "test",
      directory: "/project",
      title: "test",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

const admitted = (id: SessionMessage.ID) => Database.Service.use(({ db }) => SessionInput.find(db, id))
const admittedCount = Database.Service.use(({ db }) =>
  db
    .select()
    .from(SessionInputTable)
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.length),
    ),
)
const eventCount = (type: string) =>
  Database.Service.use(({ db }) =>
    db
      .select()
      .from(EventTable)
      .where(eq(EventTable.type, type))
      .all()
      .pipe(
        Effect.orDie,
        Effect.map((rows) => rows.length),
      ),
  )

const interruptEvent = Database.Service.use(({ db }) =>
  db
    .select()
    .from(EventTable)
    .where(eq(EventTable.type, "session.next.interrupt.requested.1"))
    .get()
    .pipe(Effect.orDie),
)

describe("SessionV2.prompt", () => {
  it.effect("delegates execution continuation through SessionExecution", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      executionCalls.length = 0
      wakeCalls.length = 0
      yield* session.resume(sessionID)
      expect(executionCalls).toEqual([sessionID])
      expect(wakeCalls).toEqual([])
    }),
  )

  it.effect("delegates interruption through SessionExecution", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      interruptCalls.length = 0
      interruptSeqs.length = 0

      yield* session.interrupt(sessionID)
      expect(interruptCalls).toEqual([sessionID])
      expect(interruptSeqs).toHaveLength(1)
      expect(typeof interruptSeqs[0]).toBe("number")
      expect(yield* eventCount("session.next.interrupt.requested.1")).toBe(1)
      expect(yield* interruptEvent).toMatchObject({ aggregate_id: sessionID, seq: interruptSeqs[0] })
      expect(yield* session.messages({ sessionID })).toEqual([])
    }),
  )

  it.effect("delegates interruption without requiring a recorded Session", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      interruptCalls.length = 0
      interruptSeqs.length = 0

      yield* session.interrupt(SessionV2.ID.make("ses_missing"))
      expect(interruptCalls).toEqual([SessionV2.ID.make("ses_missing")])
      expect(interruptSeqs).toEqual([undefined])
    }),
  )

  it.effect("durably admits one user message before transcript promotion", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service

      const message = yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Fix the failing tests" }),
        resume: false,
      })

      expect(message.prompt.text).toBe("Fix the failing tests")
      expect(yield* session.messages({ sessionID })).toEqual([])
      expect(yield* admitted(message.id)).toMatchObject({
        id: message.id,
        sessionID,
        prompt: { text: "Fix the failing tests" },
        delivery: "steer",
      })
    }),
  )

  it.effect("normalizes inline attachments before durable prompt admission", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const session = yield* SessionV2.Service
      const message = yield* session.prompt({
        sessionID,
        prompt: new Prompt({
          text: "Inspect this image",
          files: [
            new FileAttachment({
              uri: "data:image/png;base64,aGVsbG8=",
              mime: "image/png",
              name: "pixel.png",
            }),
          ],
        }),
        resume: false,
      })

      expect(message.prompt.files?.[0]?.uri).toBe(`${ContentStore.URI_PREFIX}${message.id}_0`)
      const storedInput = yield* db
        .select({ prompt: SessionInputTable.prompt })
        .from(SessionInputTable)
        .where(eq(SessionInputTable.id, message.id))
        .get()
        .pipe(Effect.orDie)
      const storedEvents = yield* db.select({ data: EventTable.data }).from(EventTable).all().pipe(Effect.orDie)
      expect(JSON.stringify(storedInput?.prompt)).not.toContain(";base64,")
      expect(JSON.stringify(storedEvents)).not.toContain(";base64,")
    }),
  )

  it.effect("promotes durable execution context with the queued user message", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const message = yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Run with selected context" }),
        agent: AgentV2.ID.make("reviewer"),
        model: {
          providerID: ProviderV2.ID.make("openai"),
          id: ModelV2.ID.make("gpt-test"),
          variant: ModelV2.VariantID.make("high"),
        },
        system: "Use the compacted verifier context.",
        resume: false,
      })

      expect(yield* admitted(message.id)).toMatchObject({
        prompt: {
          text: "Run with selected context",
          agent: "reviewer",
          model: { providerID: "openai", id: "gpt-test", variant: "high" },
          system: "Use the compacted verifier context.",
        },
      })

      yield* SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER)

      expect(yield* session.messages({ sessionID })).toMatchObject([
        { id: message.id, type: "user", text: "Run with selected context" },
        { type: "system", text: "Use the compacted verifier context." },
        { type: "model-switched", model: { providerID: "openai", id: "gpt-test", variant: "high" } },
        { type: "agent-switched", agent: "reviewer" },
      ])
    }),
  )

  it.effect("does not persist an unchanged system context twice", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const first = yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "First" }),
        system: "Keep this context.",
        resume: false,
      })
      const second = yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Second" }),
        system: "Keep this context.",
        resume: false,
      })

      yield* SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER)

      const messages = yield* session.messages({ sessionID })
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: first.id, type: "user", text: "First" }),
          expect.objectContaining({ id: second.id, type: "user", text: "Second" }),
        ]),
      )
      expect(messages.filter((message) => message.type === "system")).toMatchObject([{ text: "Keep this context." }])
    }),
  )

  it.effect("streams durable Session events after an aggregate cursor", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const fiber = yield* session.events({ sessionID }).pipe(Stream.take(4), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First" }), resume: false })
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Second" }), resume: false })
      yield* SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER)
      const streamed = Array.from(yield* Fiber.join(fiber))

      expect(streamed.map((event) => [event.cursor, event.event.type])).toEqual([
        [EventV2.Cursor.make(0), "session.next.prompt.admitted"],
        [EventV2.Cursor.make(1), "session.next.prompt.admitted"],
        [EventV2.Cursor.make(2), "session.next.prompt.promoted"],
        [EventV2.Cursor.make(3), "session.next.prompt.promoted"],
      ])
      expect(
        Array.from(
          yield* session.events({ sessionID, after: streamed[0]!.cursor }).pipe(Stream.take(1), Stream.runCollect),
        ).map((event) => [event.cursor, event.event.type]),
      ).toEqual([[EventV2.Cursor.make(1), "session.next.prompt.admitted"]])
    }),
  )

  it.effect("resumes through a recorded message without appending another prompt", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const message = yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Fix the failing tests" }),
        resume: false,
      })

      executionCalls.length = 0
      wakeCalls.length = 0
      yield* session.resume(sessionID)

      expect(yield* session.messages({ sessionID })).toEqual([])
      expect(yield* admitted(message.id)).not.toHaveProperty("promotedSeq")
      expect(executionCalls).toEqual([sessionID])
      expect(wakeCalls).toEqual([])
    }),
  )

  it.effect("records distinct messages when the ID is omitted", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const input = { sessionID, prompt: new Prompt({ text: "Fix the failing tests" }), resume: false }

      const first = yield* session.prompt(input)
      const second = yield* session.prompt(input)

      expect(second.id).not.toBe(first.id)
      expect(yield* session.messages({ sessionID })).toEqual([])
      expect(yield* admittedCount).toBe(2)
    }),
  )

  it.effect("returns the original recorded message when the ID is retried", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const input = {
        sessionID,
        id: messageID,
        prompt: new Prompt({ text: "Fix the failing tests" }),
        resume: false,
      }

      const first = yield* session.prompt(input)
      const retried = yield* session.prompt(input)

      expect(retried).toEqual(first)
      expect(yield* session.messages({ sessionID })).toEqual([])
      expect(yield* admittedCount).toBe(1)
    }),
  )

  it.effect("wakes execution when an exact prompt retry recovers a committed message", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const input = {
        sessionID,
        id: messageID,
        prompt: new Prompt({ text: "Recover committed prompt" }),
        resume: false,
      }
      const first = yield* session.prompt(input)
      wakeCalls.length = 0

      const retried = yield* session.prompt({ ...input, resume: true })

      expect(retried).toEqual(first)
      expect(wakeCalls).toEqual([sessionID])
    }),
  )

  it.effect("rejects reuse of one ID with a different prompt", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service

      yield* session.prompt({
        sessionID,
        id: messageID,
        prompt: new Prompt({ text: "Fix the failing tests" }),
      })
      const failure = yield* session
        .prompt({
          sessionID,
          id: messageID,
          prompt: new Prompt({ text: "Delete the failing tests" }),
          resume: false,
        })
        .pipe(Effect.flip)

      expect(failure._tag).toBe("Session.PromptConflictError")
      expect(yield* session.messages({ sessionID })).toHaveLength(0)
      expect(yield* admittedCount).toBe(1)
    }),
  )

  it.effect("rejects reuse of one ID with a different delivery mode", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service

      yield* session.prompt({
        id: messageID,
        sessionID,
        prompt: new Prompt({ text: "Fix the failing tests" }),
        resume: false,
      })
      const failure = yield* session
        .prompt({
          id: messageID,
          sessionID,
          prompt: new Prompt({ text: "Fix the failing tests" }),
          delivery: "queue",
          resume: false,
        })
        .pipe(Effect.flip)

      expect(failure._tag).toBe("Session.PromptConflictError")
    }),
  )

  it.effect("returns one recorded message to concurrent exact retries", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const input = {
        sessionID,
        id: messageID,
        prompt: new Prompt({ text: "Fix the failing tests" }),
        resume: false,
      }

      const messages = yield* Effect.all([session.prompt(input), session.prompt(input)], { concurrency: "unbounded" })

      expect(messages[1]).toEqual(messages[0])
      expect(yield* session.messages({ sessionID })).toEqual([])
      expect(yield* admittedCount).toBe(1)
      expect(yield* eventCount(EventV2.versionedType(SessionEvent.PromptLifecycle.Admitted.type, 1))).toBe(1)
    }),
  )

  it.effect("atomically rolls back a woken active turn before admitting an unchanged resend", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const original = SessionMessage.ID.make("msg_rollback_original")
      const originalAssistant = SessionMessage.ID.make("msg_rollback_original_assistant")
      const resend = SessionMessage.ID.make("msg_rollback_resend")
      interruptCalls.length = 0
      waitCalls.length = 0
      wakeCalls.length = 0

      yield* session.prompt({
        id: original,
        sessionID,
        prompt: new Prompt({ text: "Keep this exact text" }),
      })
      yield* SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER)
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID: originalAssistant,
        timestamp: yield* DateTime.now,
        agent: "build",
        model: { id: ModelV2.ID.make("gpt-test"), providerID: ProviderV2.ID.make("openai") },
      })
      yield* events.publish(SessionEvent.Text.Started, {
        sessionID,
        assistantMessageID: originalAssistant,
        timestamp: yield* DateTime.now,
        textID: "text_rollback_original",
      })
      yield* events.publish(SessionEvent.Text.Ended, {
        sessionID,
        assistantMessageID: originalAssistant,
        timestamp: yield* DateTime.now,
        textID: "text_rollback_original",
        text: "ZWEI",
      })
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID,
        assistantMessageID: originalAssistant,
        timestamp: yield* DateTime.now,
        finish: "stop",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      expect(yield* session.messages({ sessionID })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: original, type: "user", text: "Keep this exact text" }),
          expect.objectContaining({ id: originalAssistant, type: "assistant" }),
        ]),
      )
      yield* session.prompt({
        id: SessionMessage.ID.make("msg_rollback_queued"),
        sessionID,
        prompt: new Prompt({ text: "queued residue" }),
        delivery: "queue",
        resume: false,
      })

      const rolledBack = yield* session.rollback({ sessionID, messageID: original, files: "messages_only" })

      expect(rolledBack.revert).toMatchObject({ messageID: original, fileAction: "messages_only" })
      expect(wakeCalls).toEqual([sessionID])
      expect(interruptCalls).toEqual([sessionID])
      expect(waitCalls).toEqual([sessionID])
      expect(yield* SessionInput.hasPending(db, sessionID, "queue")).toBe(false)
      expect(yield* session.messages({ sessionID })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: original, type: "user" }),
          expect.objectContaining({ id: originalAssistant, type: "assistant" }),
        ]),
      )

      const admittedBeforeResend = yield* admittedCount
      yield* session.prompt({
        id: resend,
        sessionID,
        prompt: new Prompt({ text: "Keep this exact text" }),
        resume: false,
      })
      yield* SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER)

      expect(yield* admittedCount).toBe(admittedBeforeResend + 1)
      const messages = yield* session.messages({ sessionID })
      expect(messages).toEqual([expect.objectContaining({ id: resend, type: "user", text: "Keep this exact text" })])
      expect(messages.some((message) => message.id === original || message.id === originalAssistant)).toBe(false)
    }),
  )

  it.effect("moves a messages-only rollback backward on repeated undo without losing recovery", () =>
    Effect.gen(function* () {
      yield* setup
      const db = (yield* Database.Service).db
      const events = yield* EventV2.Service
      const session = yield* SessionV2.Service
      const first = yield* session.prompt({ sessionID, prompt: new Prompt({ text: "first" }), resume: false })
      yield* SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER)
      const second = yield* session.prompt({ sessionID, prompt: new Prompt({ text: "second" }), resume: false })
      yield* SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER)
      yield* session.rollback({ sessionID, messageID: second.id, files: "messages_only" })
      expect((yield* session.rollback({ sessionID, messageID: first.id })).revert).toMatchObject({
        messageID: first.id, status: "reverted", fileAction: "messages_only",
      })
      expect(yield* session.messages({ sessionID })).toHaveLength(2)
      yield* session.unrevert({ sessionID })
      expect((yield* session.get(sessionID)).revert).toBeUndefined()
      expect(yield* session.messages({ sessionID })).toHaveLength(2)
    }),
  )

  it.effect("rejects prompts while rollback ownership is blocked until keep-files is explicit", () =>
    Effect.gen(function* () {
      yield* setup
      const db = (yield* Database.Service).db
      const events = yield* EventV2.Service
      const session = yield* SessionV2.Service
      const original = yield* session.prompt({ sessionID, prompt: new Prompt({ text: "original" }), resume: false })
      yield* SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER)
      yield* session.rollback({ sessionID, messageID: original.id })
      const count = yield* admittedCount
      const result = yield* session.prompt({ sessionID, prompt: new Prompt({ text: "replacement" }), resume: false }).pipe(Effect.exit)
      expect(result._tag).toBe("Failure")
      expect(yield* admittedCount).toBe(count)
      expect((yield* session.get(sessionID)).revert?.status).toBe("blocked")
      yield* session.rollback({ sessionID, messageID: original.id, files: "messages_only" })
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "replacement" }), resume: false })
      expect(yield* admittedCount).toBe(count + 1)
      expect((yield* session.get(sessionID)).revert).toBeUndefined()
    }),
  )

  it.effect("leaves an active turn and pending input untouched for a stale rollback message", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const original = SessionMessage.ID.make("msg_stale_message_original")
      interruptCalls.length = 0
      waitCalls.length = 0

      yield* session.prompt({ id: original, sessionID, prompt: new Prompt({ text: "active turn" }), resume: false })
      yield* SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER)
      yield* session.prompt({
        id: SessionMessage.ID.make("msg_stale_message_queue"),
        sessionID,
        prompt: new Prompt({ text: "must remain queued" }),
        delivery: "queue",
        resume: false,
      })

      const failure = yield* session
        .rollback({ sessionID, messageID: SessionMessage.ID.make("msg_stale_missing") })
        .pipe(Effect.flip)

      expect(failure).toMatchObject({
        _tag: "Session.RollbackTargetError",
        messageID: "msg_stale_missing",
        reason: "message",
      })
      expect(interruptCalls).toEqual([])
      expect(waitCalls).toEqual([])
      expect(yield* SessionInput.hasPending(db, sessionID, "queue")).toBe(true)
      expect((yield* session.get(sessionID)).revert).toBeUndefined()
      expect(yield* session.messages({ sessionID })).toEqual([
        expect.objectContaining({ id: original, type: "user", text: "active turn" }),
      ])
    }),
  )

  it.effect("leaves an active turn and pending input untouched for a stale rollback part", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const original = SessionMessage.ID.make("msg_stale_part_original")
      interruptCalls.length = 0
      waitCalls.length = 0

      yield* session.prompt({ id: original, sessionID, prompt: new Prompt({ text: "active turn" }), resume: false })
      yield* SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER)
      yield* session.prompt({
        id: SessionMessage.ID.make("msg_stale_part_queue"),
        sessionID,
        prompt: new Prompt({ text: "must remain queued" }),
        delivery: "queue",
        resume: false,
      })

      const failure = yield* session
        .rollback({ sessionID, messageID: original, partID: "part_stale_missing" })
        .pipe(Effect.flip)

      expect(failure).toMatchObject({
        _tag: "Session.RollbackTargetError",
        messageID: original,
        partID: "part_stale_missing",
        reason: "part",
      })
      expect(interruptCalls).toEqual([])
      expect(waitCalls).toEqual([])
      expect(yield* SessionInput.hasPending(db, sessionID, "queue")).toBe(true)
      expect((yield* session.get(sessionID)).revert).toBeUndefined()
      expect(yield* session.messages({ sessionID })).toEqual([
        expect.objectContaining({ id: original, type: "user", text: "active turn" }),
      ])
    }),
  )

  it.effect("promotes one message once under concurrent promotion attempts", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ id: messageID, sessionID, prompt: new Prompt({ text: "Promote once" }), resume: false })

      yield* Effect.all(
        [
          SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER),
          SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER),
        ],
        { concurrency: "unbounded" },
      )

      expect(yield* eventCount(EventV2.versionedType(SessionEvent.PromptLifecycle.Promoted.type, 1))).toBe(1)
      expect(yield* admitted(messageID)).toMatchObject({ promotedSeq: 1 })
      expect(yield* session.messages({ sessionID })).toMatchObject([
        { id: messageID, type: "user", text: "Promote once" },
      ])
    }),
  )

  it.effect("promotes an agent, model, and confirmed prompt as one execution context", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const model = ModelV2.Ref.make({
        id: ModelV2.ID.make("implementation-model"),
        providerID: ProviderV2.ID.anthropic,
        variant: ModelV2.VariantID.make("high"),
      })
      const admitted = yield* session.prompt({
        sessionID,
        agent: AgentV2.ID.make("build"),
        model,
        prompt: new Prompt({ text: "Implement the approved plan" }),
        resume: false,
      })

      expect(yield* session.get(sessionID)).not.toMatchObject({ agent: "build", model })
      expect(yield* session.messages({ sessionID })).toEqual([])

      yield* SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER)

      expect(yield* session.get(sessionID)).toMatchObject({ agent: "build", model })
      expect((yield* session.messages({ sessionID })).find((item) => item.type === "user")).toMatchObject({
        id: admitted.id,
        type: "user",
        text: "Implement the approved plan",
      })
      expect(yield* admittedCount).toBeGreaterThan(0)
    }),
  )

  it.effect("promotes steers only through the captured aggregate cutoff", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const first = yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Before cutoff" }), resume: false })
      const cutoff = yield* SessionInput.latestSeq(db, sessionID)
      const second = yield* session.prompt({ sessionID, prompt: new Prompt({ text: "After cutoff" }), resume: false })

      yield* SessionInput.promoteSteers(db, events, sessionID, cutoff)

      expect(yield* admitted(first.id)).toHaveProperty("promotedSeq")
      expect(yield* admitted(second.id)).not.toHaveProperty("promotedSeq")
    }),
  )

  it.effect("reprojects one pending lifecycle without scheduling execution", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      wakeCalls.length = 0
      yield* session.prompt({ id: messageID, sessionID, prompt: new Prompt({ text: "Replay pending" }), resume: false })
      const recorded = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .all()
        .pipe(Effect.orDie)

      yield* events.remove(sessionID)
      yield* db.delete(SessionInputTable).where(eq(SessionInputTable.session_id, sessionID)).run().pipe(Effect.orDie)
      yield* db
        .delete(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* events.replayAll(
        recorded.map((event) => ({
          id: event.id,
          aggregateID: event.aggregate_id,
          seq: event.seq,
          type: event.type,
          data: event.data,
        })),
      )

      expect(yield* admitted(messageID)).toMatchObject({ id: messageID, prompt: { text: "Replay pending" } })
      expect(yield* session.messages({ sessionID })).toEqual([])
      expect(wakeCalls).toEqual([])
    }),
  )

  it.effect("returns an exact retry of a legacy projected prompt", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const prompt = new Prompt({ text: "Historical prompt" })
      yield* events.publish(SessionEvent.Prompted, {
        sessionID,
        messageID,
        timestamp: yield* DateTime.now,
        prompt,
        delivery: "steer",
      })

      const retried = yield* session.prompt({ id: messageID, sessionID, prompt, resume: false })

      expect(retried).toMatchObject({ id: messageID, prompt: { text: "Historical prompt" } })
      expect(yield* admitted(messageID)).toHaveProperty("promotedSeq")
    }),
  )

  it.effect("returns an exact retry of a legacy projected queued prompt", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const prompt = new Prompt({ text: "Historical queued prompt" })
      yield* events.publish(SessionEvent.Prompted, {
        sessionID,
        messageID,
        timestamp: yield* DateTime.now,
        prompt,
        delivery: "queue",
      })

      const retried = yield* session.prompt({ id: messageID, sessionID, prompt, delivery: "queue", resume: false })

      expect(retried).toMatchObject({ id: messageID, prompt: { text: "Historical queued prompt" } })
      expect(yield* admitted(messageID)).toMatchObject({ delivery: "queue" })
    }),
  )

  it.effect("rejects an input ID already used by a durable non-prompt event", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* events.publish(SessionEvent.Synthetic, {
        sessionID,
        messageID,
        timestamp: yield* DateTime.now,
        text: "Collision",
      })

      const failure = yield* session
        .prompt({ id: messageID, sessionID, prompt: new Prompt({ text: "Collision" }), resume: false })
        .pipe(Effect.flip)

      expect(failure._tag).toBe("Session.PromptConflictError")
      expect(yield* admitted(messageID)).toBeUndefined()
    }),
  )

  it.effect("rejects a durable event ID reserved by an admitted prompt without poisoning promotion", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const prompt = new Prompt({ text: "Reserved prompt" })
      yield* session.prompt({ id: messageID, sessionID, prompt, resume: false })

      const failure = yield* events
        .publish(SessionEvent.Synthetic, {
          sessionID,
          messageID,
          timestamp: yield* DateTime.now,
          text: "Conflicting synthetic",
        })
        .pipe(Effect.catchDefect(Effect.succeed))

      expect(String(failure)).toContain("SessionInput.LifecycleConflict")
      expect(yield* admitted(messageID)).not.toHaveProperty("promotedSeq")
      expect(yield* session.messages({ sessionID })).toEqual([])

      yield* SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER)

      expect(yield* admitted(messageID)).toMatchObject({ promotedSeq: 1 })
      expect(yield* session.messages({ sessionID })).toMatchObject([
        { id: messageID, type: "user", text: "Reserved prompt" },
      ])
    }),
  )

  it.effect("rejects reuse of one globally unique message ID across sessions", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const session = yield* SessionV2.Service
      const other = SessionV2.ID.make("ses_prompt_other")
      yield* db
        .insert(SessionTable)
        .values({
          id: other,
          project_id: Project.ID.global,
          slug: "other",
          directory: "/project",
          title: "other",
          version: "test",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const prompt = new Prompt({ text: "Fix the failing tests" })

      yield* session.prompt({ id: messageID, sessionID, prompt, resume: false })
      const failure = yield* session
        .prompt({ id: messageID, sessionID: other, prompt, resume: false })
        .pipe(Effect.flip)

      expect(failure).toMatchObject({ _tag: "Session.PromptConflictError", sessionID: other, messageID })
    }),
  )

  it.effect("starts execution by default after recording the prompt", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      executionCalls.length = 0
      wakeCalls.length = 0
      wakeSeqs.length = 0

      const admitted = yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Run by default" }) })

      expect(executionCalls).toEqual([])
      expect(wakeCalls).toEqual([sessionID])
      expect(wakeSeqs).toEqual([admitted.admittedSeq])
    }),
  )

  it.effect("starts execution when resume is explicitly true", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      executionCalls.length = 0
      wakeCalls.length = 0
      wakeSeqs.length = 0

      const admitted = yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Run explicitly" }),
        resume: true,
      })

      expect(executionCalls).toEqual([])
      expect(wakeCalls).toEqual([sessionID])
      expect(wakeSeqs).toEqual([admitted.admittedSeq])
    }),
  )

  it.effect("only records the prompt when resume is false", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      executionCalls.length = 0
      wakeCalls.length = 0
      wakeSeqs.length = 0

      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Do not run" }), resume: false })

      expect(executionCalls).toEqual([])
      expect(wakeCalls).toEqual([])
      expect(wakeSeqs).toEqual([])
    }),
  )
})
