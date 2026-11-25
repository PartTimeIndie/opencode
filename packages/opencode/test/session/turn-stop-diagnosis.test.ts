import { expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionActivityTable } from "@opencode-ai/core/session/sql"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import endings from "./fixtures/turn-stop-endings.json"
import { eq, sql } from "drizzle-orm"
import { Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { HeadlessAI } from "@/headless-ai"
import { InstanceStore } from "@/project/instance-store"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { Todo } from "@/session/todo"
import { TurnCompletion } from "@/session/turn-completion"
import { TurnCompletionV2 } from "@/session/turn-completion-v2"
import { testEffect } from "../lib/effect"

const it = testEffect(Database.layerFromPath(":memory:"))

for (const ending of endings) {
  it.effect(`diagnosis C: synthetic ending ${ending.seq} is ${ending.expected}`, () =>
    Effect.gen(function* () {
      const sessionID = SessionID.make(`ses_ending_${ending.seq}`)
      const messageID = SessionV1.MessageID.ascending()
      const message: SessionV1.WithParts = {
        info: {
          id: messageID, sessionID, role: "assistant", time: { created: 1 },
          parentID: SessionV1.MessageID.ascending(), modelID: ModelV2.ID.make("fixture"),
          providerID: ProviderV2.ID.make("fixture"), mode: "normal", agent: "build",
          path: { cwd: "/fixture", root: "/fixture" }, cost: 0, finish: ending.finish,
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [{ id: SessionV1.PartID.ascending(), sessionID, messageID, type: "text", text: ending.text }],
      }
      const completion = TurnCompletion.layer.pipe(
        Layer.provide(Layer.mock(EventV2Bridge.Service, {})),
        Layer.provide(Layer.mock(Config.Service, { get: () => Effect.succeed({
          session: { turn_completion: { enabled: true, model: "fixture/unavailable" } },
        } as ConfigV1.Info) })),
        Layer.provide(Layer.mock(Todo.Service, { get: () => Effect.succeed([
          { content: "Original feature verification", status: "pending", priority: "high" },
        ]) })),
        Layer.provide(Layer.mock(Session.Service, {
          messages: () => Effect.succeed([message]), get: () => Effect.die(new Error("No legacy fixture")),
        })),
        Layer.provide(Layer.mock(Agent.Service, {})),
        Layer.provide(Layer.mock(HeadlessAI.Service, {
          text: () => Effect.die(new Error("Historical endings must resolve without a provider")),
        })),
      )
      const result = yield* TurnCompletion.Service.use((service) => service.resolve(sessionID)).pipe(Effect.provide(completion))
      if (ending.expected !== "done" && ending.expected !== "incomplete") throw new Error("Invalid fixture verdict")
      expect(result).toBe(ending.expected)
    }),
  )
}

// Characterization, not a proposed fix: both completion services are real.
// Only external model, legacy history, event transport and execution sinks are controlled.
it.effect("diagnosis A: quota failure persists unknown and does not enqueue continuation", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const sessionID = SessionID.make("ses_diagnosis_quota")
    const activityID = "diagnosis_quota_activity"
    const observed = { attempts: 0, resumes: 0, commits: 0, statuses: [] as string[] }
    const listeners: EventV2.Listener[] = []
    const events = Layer.mock(EventV2Bridge.Service, {
      listen: (listener) => Effect.sync(() => {
        listeners.push(listener)
        return Effect.void
      }),
      publish: (definition, data, options) => Effect.gen(function* () {
        if (options?.commit) {
          yield* options.commit(1)
          observed.commits++
        }
        if (typeof data === "object" && data !== null && "status" in data)
          observed.statuses.push(String(data.status))
        return { id: options?.id ?? EventV2.ID.create(), type: definition.type, data }
      }),
    })
    const completion = TurnCompletion.layer.pipe(
      Layer.provide(events),
      Layer.provide(Layer.mock(Config.Service, {
        get: () => Effect.succeed({ session: { turn_completion: {
          enabled: true, model: "zhipuai-coding-plan/glm-5.3-flash", variant: "high",
        } } } as ConfigV1.Info),
      })),
      Layer.provide(Layer.mock(Todo.Service, {
        get: () => Effect.succeed([{ content: "Verify implementation", status: "pending", priority: "high" }]),
      })),
      Layer.provide(Layer.mock(Session.Service, {
        messages: () => Effect.succeed([]),
        // No artifact or plugin requirements in this isolated history boundary.
        get: () => Effect.die(new Error("No legacy session fixture")),
      })),
      Layer.provide(Layer.mock(Agent.Service, {})),
      Layer.provide(Layer.mock(HeadlessAI.Service, {
        text: (request) => Effect.suspend(() => {
          observed.attempts++
          expect(request.model).toBe("zhipuai-coding-plan/glm-5.3-flash")
          expect(request.variant).toBe("high")
          return Effect.fail(new Error("HTTP 429: quota exhausted (synthetic diagnosis)"))
        }),
      })),
    )
    yield* Layer.build(TurnCompletionV2.layer.pipe(
      Layer.provide(completion),
      Layer.provide(events),
      Layer.provide(Layer.mock(InstanceStore.Service, { provide: (_input, effect) => effect })),
      Layer.provide(Layer.mock(SessionExecution.Service, {
        resume: () => Effect.sync(() => { observed.resumes++ }),
        queueContinuation: () => Effect.sync(() => { observed.resumes++ }),
      })),
      Layer.provide(Layer.succeed(Database.Service, database)),
    ))
    yield* database.db.run(sql`INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
      VALUES ('diagnosis_project', 'C:/diagnosis', '[]', 1, 1)`)
    yield* database.db.run(sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
      VALUES (${sessionID}, 'diagnosis_project', 'diagnosis', 'C:/diagnosis', 'Diagnosis', 'test', 1, 1)`)
    yield* database.db.insert(SessionActivityTable).values({
      id: activityID, session_id: sessionID, status: "completed", kind: "prompt", closed_seq: 1,
    }).run()
    expect(listeners).toHaveLength(1)
    const event: EventV2.Payload = {
      id: EventV2.ID.create(), type: SessionEvent.Activity.Completed.type,
      location: { directory: AbsolutePath.make("C:/diagnosis") },
      data: { sessionID, activityID, timestamp: 1 },
    }
    const fiber = yield* listeners[0]!(event).pipe(Effect.forkChild)
    yield* Effect.yieldNow
    yield* TestClock.adjust("10 seconds")
    yield* Fiber.join(fiber)
    expect(observed).toEqual({ attempts: 3, resumes: 0, commits: 1, statuses: ["unknown"] })
    const row = yield* database.db.select().from(SessionActivityTable)
      .where(eq(SessionActivityTable.id, activityID)).get()
    expect(row).toMatchObject({
      status: "completed", turn_completion_state: "done", turn_completion_result: "unknown",
      turn_completion_attempts: 1, turn_completion_error: null,
    })
    // Duplicate delivery must neither repeat evaluation nor enqueue work.
    yield* listeners[0]!(event)
    expect(observed.attempts).toBe(3)
    expect(observed.resumes).toBe(0)
    expect(observed.commits).toBe(1)
  }),
)
