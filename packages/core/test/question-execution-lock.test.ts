import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { QuestionV2 } from "@opencode-ai/core/question"
import { SessionV2 } from "@opencode-ai/core/session"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const questions = QuestionV2.layer.pipe(Layer.provide(events), Layer.provide(database))
const sessionID = SessionV2.ID.make("ses_execution_lock")
const fixture = Layer.effectDiscard(
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = Date.now()
    yield* db
      .insert(ProjectTable)
      .values({
        id: ProjectV2.ID.make("project_execution_lock"),
        worktree: AbsolutePath.make("/execution-lock"),
        sandboxes: [],
        time_created: now,
        time_updated: now,
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: ProjectV2.ID.make("project_execution_lock"),
        slug: "execution-lock",
        directory: "/execution-lock",
        title: "Execution lock",
        version: "1",
        time_created: now,
        time_updated: now,
      })
      .run()
      .pipe(Effect.orDie)
  }),
).pipe(Layer.provide(database))
const it = testEffect(Layer.mergeAll(database, events, questions, fixture))

const composer = {
  version: 1 as const,
  controlID: "email-composer-lock",
  controls: [
    {
      id: "composer",
      type: "form" as const,
      label: "Composer",
      form: {
        version: 1 as const,
        id: "email-composer.v1",
        fields: [],
        actions: [
          {
            id: "send",
            trigger: { event: "submit" as const, when: { field: "action", equals: "send" } },
            steps: [{ type: "gmail" as const, mode: "send" as const }],
          },
        ],
      },
    },
  ],
}

describe("Surface action execution lock", () => {
  it.live("claims a once execution key exactly once across different invocation ids", () =>
    Effect.gen(function* () {
      const service = yield* QuestionV2.Service
      const request = yield* service.present({ sessionID, mode: "interactive", surface: composer })
      const key = `x:request:${request.id}:${request.revision}:email-composer.v1:outbound`
      const begin = (id: string) =>
        service.beginActionInvocation({
          id,
          target: { kind: "request", id: request.id, revision: request.revision },
          actionID: "send",
          values: { action: "send" },
        })

      yield* begin("inv_lock_a")
      yield* begin("inv_lock_b")

      const first = yield* service.beginActionEffect({ invocationID: "inv_lock_a", executionKey: key })
      expect(first.claimed).toBeTrue()
      expect(first.invocation.executionKey).toBe(key)
      expect(first.invocation.effectStartedAt).toBeDefined()

      const second = yield* service.beginActionEffect({ invocationID: "inv_lock_b", executionKey: key })
      expect(second.claimed).toBeFalse()
      expect(second.invocation.id).toBe("inv_lock_a")
    }),
  )

  it.live("rejects a once execution key bound to a different payload", () =>
    Effect.gen(function* () {
      const service = yield* QuestionV2.Service
      const request = yield* service.present({ sessionID, mode: "interactive", surface: composer })
      const key = `x:request:${request.id}:${request.revision}:email-composer.v1:outbound`
      yield* service.beginActionInvocation({
        id: "inv_lock_c",
        target: { kind: "request", id: request.id, revision: request.revision },
        actionID: "send",
        values: { action: "send", body: "first" },
      })
      const claim = yield* service.beginActionEffect({ invocationID: "inv_lock_c", executionKey: key })
      expect(claim.claimed).toBeTrue()

      yield* service.beginActionInvocation({
        id: "inv_lock_d",
        target: { kind: "request", id: request.id, revision: request.revision },
        actionID: "send",
        values: { action: "send", body: "second" },
      })
      const conflict = yield* service
        .beginActionEffect({ invocationID: "inv_lock_d", executionKey: key })
        .pipe(Effect.flip)
      expect(conflict._tag).toBe("QuestionV2.ConflictError")
    }),
  )

  it.live("marks unknown outcomes after the effect started without retryable state", () =>
    Effect.gen(function* () {
      const service = yield* QuestionV2.Service
      const request = yield* service.present({ sessionID, mode: "interactive", surface: composer })
      const key = `x:request:${request.id}:${request.revision}:email-composer.v1:outbound`
      yield* service.beginActionInvocation({
        id: "inv_lock_e",
        target: { kind: "request", id: request.id, revision: request.revision },
        actionID: "send",
        values: { action: "send" },
      })
      yield* service.beginActionEffect({ invocationID: "inv_lock_e", executionKey: key })

      const unknown = yield* service.failActionInvocation("inv_lock_e", "provider timeout", "unknown")
      expect(unknown.state).toBe("failed")
      expect(unknown.errorClass).toBe("unknown")

      const stored = yield* service.getActionInvocation("inv_lock_e")
      expect(stored.executionKey).toBe(key)
      expect(stored.errorClass).toBe("unknown")
    }),
  )

  it.live("keeps preflight failures retry-safe", () =>
    Effect.gen(function* () {
      const service = yield* QuestionV2.Service
      const request = yield* service.present({ sessionID, mode: "interactive", surface: composer })
      const key = `x:request:${request.id}:${request.revision}:email-composer.v1:outbound`
      yield* service.beginActionInvocation({
        id: "inv_lock_f",
        target: { kind: "request", id: request.id, revision: request.revision },
        actionID: "send",
        values: { action: "send" },
      })
      const failed = yield* service.failActionInvocation("inv_lock_f", "missing attachment file", "preflight")
      expect(failed.state).toBe("failed")
      expect(failed.errorClass).toBe("preflight")
      expect(failed.effectStartedAt).toBeUndefined()
      expect(failed.executionKey).toBeUndefined()

      // The once slot is still free: a fresh invocation of the same intent can claim it.
      yield* service.beginActionInvocation({
        id: "inv_lock_g",
        target: { kind: "request", id: request.id, revision: request.revision },
        actionID: "send",
        values: { action: "send" },
      })
      const claim = yield* service.beginActionEffect({ invocationID: "inv_lock_g", executionKey: key })
      expect(claim.claimed).toBeTrue()
    }),
  )
})
