import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Layer, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AgentV2 } from "@opencode-ai/core/agent"
import { EventV2 } from "@opencode-ai/core/event"
import { LLMEvent } from "@opencode-ai/llm"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionHistory } from "@opencode-ai/core/session/history"
import { SessionExecutionOwner } from "@opencode-ai/core/session/execution/owner"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionActivityTable, SessionInputTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { collectReviewResult } from "@opencode-ai/core/tool/review-result-recovery"
import { createLLMEventPublisher } from "@opencode-ai/core/session/runner/publish-llm-event"
import { testEffect } from "./lib/effect"
import { ModelV2 } from "@opencode-ai/core/model"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionMessageID } from "@opencode-ai/core/session/message-id"
import { StructuredOutputAttempt } from "@opencode-ai/core/session/structured-output-attempt"

const input = {
  inputID: SessionMessageID.ID.make("msg_structured_attempt"),
  input: { text: "Return answer" },
  schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
  model: { id: ModelV2.ID.make("fixture"), providerID: ProviderV2.ID.make("fixture"), variant: ModelV2.VariantID.make("high") },
  mode: "tool" as const,
}
const binding = StructuredOutputAttempt.bind(input)
const initial = StructuredOutputAttempt.next({ binding, previous: [], correction: false, retryCount: 1 })
const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const projector = SessionProjector.layer.pipe(Layer.provide(database), Layer.provide(events))
const it = testEffect(Layer.mergeAll(database, events, projector))

it.effect("collects original review evidence before closure, compaction and a later human assignment", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const sessionID = SessionSchema.ID.make("ses_review_history_preservation")
    yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/fixture"), sandboxes: [] }).run()
    yield* db.insert(SessionTable).values({ id: sessionID, project_id: Project.ID.global, directory: "/fixture",
      slug: "history", title: "history", version: "test" }).run()
    const time = { created: DateTime.makeUnsafe(0) }
    const prompt = new SessionMessage.User({ id: input.inputID, type: "user", text: "Review", files: [], agents: [], time })
    const report = { findings: [{ title: "Original concrete defect" }], notes: [] }
    const original = new SessionMessage.Assistant({ id: SessionMessageID.ID.make("msg_original_report"),
      type: "assistant", agent: "review", model: input.model, time, finish: "stop", structured: report,
      structuredOutputAttempt: initial,
      content: [new SessionMessage.AssistantText({ id: "original", type: "text", text: JSON.stringify(report) })],
    })
    const closure = new SessionMessage.Assistant({ ...original, id: SessionMessageID.ID.make("msg_closure"),
      structured: undefined, structuredOutputAttempt: undefined,
      content: [new SessionMessage.AssistantText({ id: "closure", type: "text", text: "Task marker: processing findings" })],
    })
    const next = new SessionMessage.User({ ...prompt, id: SessionMessageID.ID.make("msg_next_assignment"), text: "Different work" })
    const foreign = new SessionMessage.Assistant({ ...original, id: SessionMessageID.ID.make("msg_next_report"),
      structuredOutputAttempt: { ...initial, inputID: next.id } })
    const compaction = new SessionMessage.Compaction({ id: SessionMessageID.ID.make("msg_compacted_review"),
      type: "compaction", reason: "manual", summary: "Compacted", recent: "Recent", time })
    for (const [seq, message] of [prompt, original, closure, next, foreign, compaction].entries()) {
      const { id, type, ...data } = Schema.encodeSync(SessionMessage.Message)(message)
      yield* db.insert(SessionMessageTable).values({ id: SessionMessage.ID.make(id), session_id: sessionID, type, seq, data }).run()
    }
    expect((yield* SessionHistory.load(db, sessionID)).some((message) => message.id === original.id)).toBe(false)
    const history = yield* SessionHistory.loadForTask(db, sessionID, prompt.id)
    expect(history.map((message) => message.id)).toEqual([prompt.id, original.id, closure.id])
    const collected = collectReviewResult({ schema: { type: "object", properties: {
      findings: { type: "array", items: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } },
      notes: { type: "array", items: { type: "string" } },
    }, required: ["findings", "notes"] }, messages: history, promptID: prompt.id,
      completed: true, text: JSON.stringify({ findings: [{ title: "Task marker: processing" }], notes: [] }), recoveryEnabled: true })
    expect(collected.partial).toBe(true)
    expect(collected.result).toBeUndefined()
    expect(collected.recovery?.findings).toEqual(report.findings)
    expect((yield* StructuredOutputAttempt.load(db, sessionID, prompt.id))[0]?.completed).toBe(true)
  }),
)

for (const boundary of ["same-activity-steer", "queue", "later-activity-steer", "unknown-input", "mismatched-input", "missing-activity", "open-activity", "unknown-anchor", "structured-steer", "structured-no-final"] as const) {
  it.effect(`task collection preserves only a ledger-bound same-activity steer (${boundary})`, () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = SessionSchema.ID.make("ses_task_steer_history")
      yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/fixture"), sandboxes: [] }).run()
      yield* db.insert(SessionTable).values({ id: sessionID, project_id: Project.ID.global, directory: "/fixture",
        slug: "steer", title: "steer", version: "test" }).run()
      const time = { created: DateTime.makeUnsafe(0), completed: DateTime.makeUnsafe(1) }
      const prompt = new SessionMessage.User({ id: input.inputID, type: "user", text: "Review", files: [], agents: [], time })
      const correction = new SessionMessage.User({ ...prompt, id: SessionMessage.ID.make("msg_task_steer"), text: "Apply this correction" })
      const prior = new SessionMessage.Assistant({ id: SessionMessage.ID.make("msg_task_investigation"), type: "assistant",
        agent: "review", model: input.model, time, finish: "tool-calls", content: [],
        ...(boundary.startsWith("structured") ? { structuredOutputAttempt: initial } : {}) })
      const final = new SessionMessage.Assistant({ ...prior, id: SessionMessage.ID.make("msg_task_corrected_report"), finish: "stop",
        content: [new SessionMessage.AssistantText({ id: "final", type: "text", text: "Corrected task result" })] })
      for (const [seq, message] of [[1, prompt], [2, prior], [4, correction], [5, final]] as const) {
        if (boundary === "structured-no-final" && message.id === final.id) continue
        const { id, type, ...data } = Schema.encodeSync(SessionMessage.Message)(message)
        yield* db.insert(SessionMessageTable).values({ id: SessionMessage.ID.make(id), session_id: sessionID, type, seq, data }).run()
      }
      if (boundary !== "unknown-anchor") yield* db.insert(SessionInputTable).values({ id: prompt.id, session_id: sessionID, prompt: { text: prompt.text },
        delivery: "steer", admitted_seq: 0, promoted_seq: 1 }).run()
      if (boundary !== "unknown-input") yield* db.insert(SessionInputTable).values({ id: correction.id, session_id: sessionID,
        prompt: { text: correction.text }, delivery: boundary === "queue" ? "queue" : "steer", admitted_seq: 3,
        promoted_seq: boundary === "mismatched-input" ? 6 : 4 }).run()
      if (boundary !== "missing-activity") yield* db.insert(SessionActivityTable).values({ id: "act_task_history", session_id: sessionID,
        status: boundary === "open-activity" ? "running" : "completed", kind: "prompt",
        opened_seq: 0, closed_seq: boundary === "open-activity" ? null : boundary === "later-activity-steer" ? 3 : 10 }).run()
      // The provider's compacted working set is not the task's durable result boundary.
      const compaction = new SessionMessage.Compaction({ id: SessionMessage.ID.make("msg_task_steer_compaction"), type: "compaction",
        reason: "manual", summary: "Compacted", recent: "Recent", time })
      const { id, type, ...data } = Schema.encodeSync(SessionMessage.Message)(compaction)
      yield* db.insert(SessionMessageTable).values({ id: SessionMessage.ID.make(id), session_id: sessionID, type, seq: 12, data }).run()
      expect((yield* SessionHistory.load(db, sessionID)).some((message) => message.id === prompt.id)).toBe(false)
      expect((yield* SessionHistory.loadForTask(db, sessionID, prompt.id)).map((message) => message.id))
        .toEqual(boundary === "structured-steer" ? [prompt.id, prior.id, final.id]
          : [prompt.id, boundary === "same-activity-steer" ? final.id : prior.id])
    }),
  )
}

for (const boundary of ["steer", "queue", "unknown", "mismatched", "later-activity", "no-owner", "compacted"] as const)
  it.effect(`task result schema stays bound only across owned same-activity steers (${boundary})`, () => Effect.gen(function* () {
    const { db } = yield* Database.Service
    const sessionID = SessionSchema.ID.make("ses_task_schema_steer")
    yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/fixture"), sandboxes: [] }).run()
    yield* db.insert(SessionTable).values({ id: sessionID, project_id: Project.ID.global, directory: "/fixture",
      slug: "schema", title: "schema", version: "test", fork_dispatch_digest: "f".repeat(64), agent_policy: {
        tools: { mode: "explicit", entries: {} }, permissionLayers: [], source: { type: "task", sessionID: "ses_parent", agent: AgentV2.ID.make("build") },
        readOnlyInputID: input.inputID,
      } }).run()
    const time = { created: DateTime.makeUnsafe(0) }
    const prompt = new SessionMessage.User({ id: input.inputID, type: "user", text: "Return answer", files: [], agents: [], time,
      format: { type: "json_schema", schema: input.schema } })
    const correction = new SessionMessage.User({ ...prompt, id: SessionMessage.ID.make("msg_schema_steer"), text: "Refine this answer", format: undefined })
    for (const [seq, message] of [[1, prompt], [4, correction]] as const) {
      const { id, type, ...data } = Schema.encodeSync(SessionMessage.Message)(message)
      yield* db.insert(SessionMessageTable).values({ id: SessionMessage.ID.make(id), session_id: sessionID, seq, type, data }).run()
    }
    yield* db.insert(SessionInputTable).values({ id: prompt.id, session_id: sessionID, prompt: { text: prompt.text },
      delivery: "steer", admitted_seq: 0, promoted_seq: 1 }).run()
    if (boundary !== "unknown") yield* db.insert(SessionInputTable).values({ id: correction.id, session_id: sessionID,
      prompt: { text: correction.text }, delivery: boundary === "queue" ? "queue" : "steer", admitted_seq: 3,
      promoted_seq: boundary === "mismatched" ? 6 : 4 }).run()
    yield* db.insert(SessionActivityTable).values({ id: "act_schema", session_id: sessionID, status: "running", kind: "prompt",
      owner_id: "owner_schema", lease_until: Date.now() + 60_000, opened_seq: boundary === "later-activity" ? 3 : 0 }).run()
    if (boundary === "compacted") {
      const { id, type, ...data } = Schema.encodeSync(SessionMessage.Message)(new SessionMessage.Compaction({
        id: SessionMessage.ID.create(), type: "compaction", reason: "manual", summary: "Summary", recent: "Recent", time,
      }))
      yield* db.insert(SessionMessageTable).values({ id: SessionMessage.ID.make(id), session_id: sessionID, seq: 8, type, data }).run()
    }
    const lookup = StructuredOutputAttempt.taskInput(db, sessionID)
    const original = yield* (boundary === "no-owner" ? lookup : SessionExecutionOwner.withOwner({
      sessionID, activityID: "act_schema", ownerID: "owner_schema",
    }, lookup))
    expect(original?.id).toBe(boundary === "steer" || boundary === "compacted" ? prompt.id : undefined)
    if (original) expect(original.format).toEqual(prompt.format)
  }))

it.effect("persists the pre-HTTP receipt and keeps its consumed budget outside compacted history", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const sessionID = SessionSchema.ID.make("ses_durable_structured_attempt")
    yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/fixture"), sandboxes: [] }).run()
    yield* db.insert(SessionTable).values({
      id: sessionID, project_id: Project.ID.global, directory: "/fixture", slug: "attempt", title: "attempt", version: "test",
    }).run()
    const publisher = createLLMEventPublisher(events, {
      sessionID, agent: "build", model: input.model, cost: [], structuredOutputAttempt: initial,
    })
    yield* publisher.startAssistant()
    const pending = yield* StructuredOutputAttempt.load(db, sessionID, input.inputID)
    expect(pending).toEqual([{ receipt: initial, finish: undefined }])
    expect(() => StructuredOutputAttempt.next({ binding, previous: pending, correction: true, retryCount: 1 })).toThrow("clean")
    yield* publisher.publish(LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }))
    yield* publisher.finishStep()
    const original = yield* StructuredOutputAttempt.load(db, sessionID, input.inputID)
    const correction = StructuredOutputAttempt.next({ binding, previous: original, correction: true, retryCount: 1 })
    yield* createLLMEventPublisher(events, {
      sessionID, agent: "build", model: input.model, cost: [], structuredOutputAttempt: correction,
    }).startAssistant()
    yield* events.publish(SessionEvent.Compaction.Ended, {
      sessionID, messageID: SessionMessageID.ID.create(), timestamp: DateTime.makeUnsafe(1),
      reason: "manual", text: "Compacted evidence", recent: "Recent evidence",
    })
    expect((yield* SessionHistory.load(db, sessionID)).some((message) => message.type === "assistant")).toBe(false)
    const reloaded = yield* StructuredOutputAttempt.load(db, sessionID, input.inputID)
    expect(reloaded.map((item) => item.receipt.phase)).toEqual(["initial", "correction"])
    expect(() => StructuredOutputAttempt.next({ binding, previous: reloaded, correction: true, retryCount: 1 }))
      .toThrow("already consumed")
  }),
)

describe("durable structured output attempt", () => {
  test("does not reopen a completed assignment as another original or correction", () => {
    for (const correction of [false, true]) expect(() => StructuredOutputAttempt.next({
      binding, previous: [{ receipt: initial, finish: "stop", completed: true }], correction, retryCount: 10,
    })).toThrow("already completed")
    // Ordinary investigation tool turns still continue before the final report.
    expect(StructuredOutputAttempt.next({ binding, previous: [{ receipt: initial, finish: "tool-calls" }],
      correction: false, retryCount: 1 }).phase).toBe("initial")
  })

  test("binds canonical input/schema without storing their contents", () => {
    expect(binding).toEqual(StructuredOutputAttempt.bind({
      ...input, schema: { required: ["answer"], properties: { answer: { type: "string" } }, type: "object" },
    }))
    expect(JSON.stringify(binding)).not.toContain("Return answer")
    expect(JSON.stringify(binding)).not.toContain("properties")
    expect(binding.schemaDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(binding.inputDigest).toMatch(/^[a-f0-9]{64}$/)
  })

  test("supports old steps without receipts and preserves a versioned receipt through JSON decoding", () => {
    expect(Schema.decodeUnknownSync(StructuredOutputAttempt.Receipt)(JSON.parse(JSON.stringify(initial)))).toEqual(initial)
    expect(initial).toMatchObject({ version: 1, phase: "initial", inputID: input.inputID, mode: "tool" })
  })

  test("allows one correction after a clean original finish and never a third request", () => {
    const previous = [{ receipt: initial, finish: "tool-calls" }]
    const correction = StructuredOutputAttempt.next({ binding, previous, correction: true, retryCount: 10 })
    expect(correction.phase).toBe("correction")
    for (const requestCorrection of [false, true]) {
      expect(() => StructuredOutputAttempt.next({ binding, previous: [
        ...previous, { receipt: correction },
      ], correction: requestCorrection, retryCount: 10 })).toThrow("already consumed")
    }
  })

  test("fails closed on an unknown original outcome and invalid budget values", () => {
    expect(() => StructuredOutputAttempt.next({
      binding, previous: [{ receipt: initial }], correction: false, retryCount: 1,
    })).toThrow("unknown outcome")
    for (const retryCount of [-1, 0.5, NaN, Infinity]) {
      expect(() => StructuredOutputAttempt.next({ binding, previous: [], correction: false, retryCount })).toThrow("budget")
    }
  })

  test("never repairs an unknown, interrupted or refused original outcome", () => {
    for (const finish of [undefined, "error", "content-filter", "length"]) {
      expect(() => StructuredOutputAttempt.next({ binding, previous: [{ receipt: initial, finish }], correction: true, retryCount: 1 }))
        .toThrow("clean")
    }
    expect(() => StructuredOutputAttempt.next({ binding, previous: [], correction: true, retryCount: 1 })).toThrow("receipt")
  })

  test("preserves zero and rejects schema, input, model, variant or mode drift", () => {
    const previous = [{ receipt: initial, finish: "stop" }]
    expect(() => StructuredOutputAttempt.next({ binding, previous, correction: true, retryCount: 0 })).toThrow("disabled")
    for (const changed of [
      { ...input, input: { text: "Different work" } },
      { ...input, schema: { ...input.schema, required: [] } },
      { ...input, model: { ...input.model, id: ModelV2.ID.make("different") } },
      { ...input, model: { ...input.model, variant: "low" } },
      { ...input, mode: "json" as const },
    ]) expect(() => StructuredOutputAttempt.next({
      binding: StructuredOutputAttempt.bind(changed), previous, correction: true, retryCount: 1,
    })).toThrow("changed")
  })

  test("does not transfer an earlier input's consumed correction to new human work", () => {
    const correction = StructuredOutputAttempt.next({ binding, previous: [{ receipt: initial, finish: "stop" }], correction: true, retryCount: 1 })
    const next = StructuredOutputAttempt.next({
      binding: StructuredOutputAttempt.bind({ ...input, inputID: SessionMessageID.ID.make("msg_new_input") }),
      previous: [{ receipt: correction }], correction: false, retryCount: 1,
    })
    expect(next.phase).toBe("initial")
  })
})
