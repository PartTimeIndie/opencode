import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Exit } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Database } from "@opencode-ai/core/database/database"
import { EventSequenceTable } from "@opencode-ai/core/event/sql"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionFork } from "@opencode-ai/core/session/fork"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import {
  SessionContextEpochTable,
  SessionInputTable,
  SessionMessageTable,
  SessionTable,
} from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(Database.layerFromPath(":memory:"))
const sessionID = SessionSchema.ID.make("ses_fork_source")
const userID = SessionMessage.ID.make("msg_fork_user")
const assistantID = SessionMessage.ID.make("msg_fork_assistant")
const model = { id: "model", providerID: "provider", variant: "high" }
const user = { text: "Do the work", time: { created: 1 } }
const assistant = {
  agent: "build",
  model,
  content: [{ type: "text", id: "text", text: "Completed turn" }],
  finish: "stop",
  time: { created: 2, completed: 3 },
}

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/fork"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: ProjectV2.ID.global,
      directory: "/fork",
      slug: "fork",
      title: "source",
      version: "test",
      agent: "build",
      model,
      metadata: { main: true, capabilityLease: "not inherited" },
      permission: [{ permission: "bash", pattern: "*", action: "deny" }],
    })
    .run()
    .pipe(Effect.orDie)
  yield* db.insert(EventSequenceTable).values({ aggregate_id: sessionID, seq: 10 }).run().pipe(Effect.orDie)
  yield* db
    .insert(SessionContextEpochTable)
    .values({
      session_id: sessionID,
      agent: AgentV2.ID.make("build"),
      baseline: "baseline",
      baseline_seq: 0,
      snapshot: {},
      revision: 2,
    })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionMessageTable)
    .values([
      { id: userID, session_id: sessionID, type: "user", seq: 1, data: user },
      { id: assistantID, session_id: sessionID, type: "assistant", seq: 3, data: assistant },
    ])
    .run()
    .pipe(Effect.orDie)
  return db
})

function reason(effect: ReturnType<typeof SessionFork.capture>) {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    if (Exit.isSuccess(exit)) throw new Error("Expected capture to fail closed")
    const failure = exit.cause.reasons.find((cause) => cause._tag === "Fail")
    return failure?._tag === "Fail" ? failure.error.reason : undefined
  })
}

describe("read-only V2 fork capture (not child provisioning)", () => {
  it.effect(
    "captures an exact event fence, completed history, epoch and actual model without metadata or admissions",
    () =>
      Effect.gen(function* () {
        const db = yield* setup
        const result = yield* SessionFork.capture(db, { sessionID, throughSeq: 10 })
        expect(result).toMatchObject({
          sourceSessionID: sessionID,
          throughSeq: 10,
          selectedModel: model,
          actualModel: model,
          epoch: { baseline: "baseline", revision: 2, baseline_seq: 0 },
          permission: [{ permission: "bash", action: "deny" }],
        })
        expect(result.entries.map((entry) => entry.message.id)).toEqual([userID, assistantID])
        expect(result).not.toHaveProperty("metadata")
        expect(result).not.toHaveProperty("input")
        expect(yield* db.select().from(SessionTable).all().pipe(Effect.orDie)).toHaveLength(1)
        expect(yield* db.select().from(SessionInputTable).all().pipe(Effect.orDie)).toEqual([])
      }),
  )

  for (const throughSeq of [-1, 9, 11, 10.5, NaN]) {
    it.effect(`rejects a stale, future or invalid fence ${throughSeq}`, () =>
      Effect.gen(function* () {
        const db = yield* setup
        expect(yield* reason(SessionFork.capture(db, { sessionID, throughSeq }))).toBe("boundary")
      }),
    )
  }

  it.effect("uses the observed agent without inventing a default for a nullable selection", () =>
    Effect.gen(function* () {
      const db = yield* setup
      yield* db.update(SessionTable).set({ agent: null }).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
      expect(yield* SessionFork.capture(db, { sessionID, throughSeq: 10 })).toMatchObject({
        selectedAgent: null,
        actualAgent: "build",
      })
      yield* db
        .update(SessionContextEpochTable)
        .set({ agent: AgentV2.ID.make("other") })
        .where(eq(SessionContextEpochTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)
      expect(yield* reason(SessionFork.capture(db, { sessionID, throughSeq: 10 }))).toBe("epoch")
    }),
  )

  it.effect("rejects queued and held inputs instead of silently omitting assigned work", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const pendingID = SessionMessage.ID.make("msg_fork_pending")
      yield* db
        .insert(SessionInputTable)
        .values({
          id: pendingID,
          session_id: sessionID,
          admitted_seq: 9,
          prompt: { text: "New assignment" },
          delivery: "queue",
          held_at: 1,
        })
        .run()
        .pipe(Effect.orDie)
      expect(yield* reason(SessionFork.capture(db, { sessionID, throughSeq: 10 }))).toBe("pending")
    }),
  )

  for (const change of [
    { replacement_seq: 8 },
    { baseline_seq: 11 },
    { agent: AgentV2.ID.make("other") },
    { revision: -1 },
    { snapshot: { invalid: { revision: "wrong" } } },
  ]) {
    it.effect(`rejects incompatible context state ${JSON.stringify(change)}`, () =>
      Effect.gen(function* () {
        const db = yield* setup
        // The malformed persisted snapshot deliberately exercises the decoder.
        yield* db
          .run(
            `UPDATE session_context_epoch SET ${Object.entries(change)
              .map(([key, value]) => `${key} = '${typeof value === "object" ? JSON.stringify(value) : value}'`)
              .join(", ")}`,
          )
          .pipe(Effect.orDie)
        expect(yield* reason(SessionFork.capture(db, { sessionID, throughSeq: 10 }))).toBe("epoch")
      }),
    )
  }

  it.effect("refuses a half-finished tool pair even in an earlier assistant message", () =>
    Effect.gen(function* () {
      const db = yield* setup
      const data = {
        ...assistant,
        content: [
          { type: "tool", id: "call", name: "write", state: { status: "pending", input: "{}" }, time: { created: 2 } },
        ],
      }
      yield* db
        .insert(SessionMessageTable)
        .values({
          id: SessionMessage.ID.make("msg_earlier_tool"),
          session_id: sessionID,
          type: "assistant",
          seq: 2,
          data,
        })
        .run()
        .pipe(Effect.orDie)
      expect(yield* reason(SessionFork.capture(db, { sessionID, throughSeq: 10 }))).toBe("history")
    }),
  )

  it.effect("rejects a still-streaming last assistant and corrupt persisted history", () =>
    Effect.gen(function* () {
      const db = yield* setup
      yield* db
        .update(SessionMessageTable)
        .set({ data: { ...assistant, time: { created: 2 } } })
        .where(eq(SessionMessageTable.id, assistantID))
        .run()
        .pipe(Effect.orDie)
      expect(yield* reason(SessionFork.capture(db, { sessionID, throughSeq: 10 }))).toBe("boundary")
      yield* db.run("UPDATE session_message SET data='{}' WHERE type='assistant'").pipe(Effect.orDie)
      expect(yield* reason(SessionFork.capture(db, { sessionID, throughSeq: 10 }))).toBe("history")
    }),
  )

  for (const finish of ["length", "unknown", "error", "content-filter"]) {
    it.effect(`rejects incomplete or failed last finish ${finish}`, () =>
      Effect.gen(function* () {
        const db = yield* setup
        const data = { ...assistant, finish }
        yield* db
          .update(SessionMessageTable)
          .set({ data })
          .where(eq(SessionMessageTable.id, assistantID))
          .run()
          .pipe(Effect.orDie)
        expect(yield* reason(SessionFork.capture(db, { sessionID, throughSeq: 10 }))).toBe("boundary")
      }),
    )
  }
})
