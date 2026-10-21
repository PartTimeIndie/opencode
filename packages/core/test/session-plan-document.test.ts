import { describe, expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionPlanDocument } from "@opencode-ai/core/session/plan-document"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AgentV2 } from "@opencode-ai/core/agent"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { PlanDocumentTool } from "@opencode-ai/core/tool/plan-document"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { executeTool } from "./lib/tool"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const documents = SessionPlanDocument.layer.pipe(Layer.provide(database))
const assertions: PermissionV2.AssertInput[] = []
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) => Effect.sync(() => assertions.push(input)),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    materializationRules: () => Effect.succeed([]),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(permission))
const tool = PlanDocumentTool.layer.pipe(
  Layer.provide(registry),
  Layer.provide(permission),
  Layer.provide(documents),
)
const it = testEffect(Layer.mergeAll(database, documents, permission, registry, tool))
const sessionID = SessionV2.ID.make("ses_plan_document")
const otherSessionID = SessionV2.ID.make("ses_plan_document_other")

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).onConflictDoNothing().run().pipe(Effect.orDie)
  yield* db.insert(SessionTable).values([
    { id: sessionID, project_id: Project.ID.global, slug: "plan", directory: "/project", title: "plan", version: "test" },
    { id: otherSessionID, project_id: Project.ID.global, slug: "other", directory: "/project", title: "other", version: "test" },
  ]).onConflictDoNothing().run().pipe(Effect.orDie)
})

describe("SessionPlanDocument", () => {
  it.effect("stores one revision-checked document in session metadata", () =>
    Effect.gen(function* () {
      yield* setup
      const service = yield* SessionPlanDocument.Service
      expect(yield* service.read(sessionID)).toBeUndefined()
      expect(yield* service.replace({ sessionID, markdown: "# Plan", expectedRevision: 0 })).toMatchObject({ markdown: "# Plan", revision: 1 })
      expect(yield* service.patch({ sessionID, expected: "Plan", replacement: "Final", expectedRevision: 1 })).toMatchObject({ markdown: "# Final", revision: 2 })
      const conflict = yield* Effect.exit(service.replace({ sessionID, markdown: "stale", expectedRevision: 1 }))
      expect(Exit.isFailure(conflict)).toBeTrue()
      if (Exit.isFailure(conflict)) expect(conflict.cause.reasons.some((reason) => reason._tag === "Fail" && reason.error._tag === "SessionPlanDocument.RevisionConflictError")).toBeTrue()
    }),
  )

  it.effect("isolates documents by session and enforces size, patch, and revision constraints", () =>
    Effect.gen(function* () {
      yield* setup
      const service = yield* SessionPlanDocument.Service
      yield* service.replace({ sessionID, markdown: "same same", expectedRevision: 0 })
      expect(yield* service.read(otherSessionID)).toBeUndefined()

      const duplicate = yield* Effect.exit(
        service.patch({ sessionID, expected: "same", replacement: "changed", expectedRevision: 1 }),
      )
      expect(Exit.isFailure(duplicate)).toBeTrue()
      if (Exit.isFailure(duplicate))
        expect(duplicate.cause.reasons.some((reason) => reason._tag === "Fail" && reason.error._tag === "SessionPlanDocument.PatchTargetError")).toBeTrue()

      const stale = yield* Effect.exit(service.replace({ sessionID, markdown: "stale", expectedRevision: 0 }))
      expect(Exit.isFailure(stale)).toBeTrue()
      const oversized = yield* Effect.exit(
        service.replace({ sessionID: otherSessionID, markdown: "x".repeat(SessionPlanDocument.MAX_MARKDOWN_BYTES + 1) }),
      )
      expect(Exit.isFailure(oversized)).toBeTrue()
      if (Exit.isFailure(oversized))
        expect(oversized.cause.reasons.some((reason) => reason._tag === "Fail" && reason.error._tag === "SessionPlanDocument.SizeLimitError")).toBeTrue()
    }),
  )

  it.effect("binds plan_document operations and permission checks to the calling session", () =>
    Effect.gen(function* () {
      yield* setup
      assertions.length = 0
      const tools = yield* ToolRegistry.Service
      const result = yield* executeTool(tools, {
        sessionID,
        agent: AgentV2.ID.make("plan"),
        assistantMessageID: SessionMessage.ID.make("msg_plan_document"),
        call: {
          type: "tool-call",
          id: "call-plan-document",
          name: "plan_document",
          input: { operation: "replace", markdown: "# Tool plan", revision: 0, sessionID: otherSessionID },
        },
      })

      expect(result.type).not.toBe("error")
      expect(yield* (yield* SessionPlanDocument.Service).read(sessionID)).toMatchObject({ markdown: "# Tool plan" })
      expect(yield* (yield* SessionPlanDocument.Service).read(otherSessionID)).toBeUndefined()
      expect(assertions).toMatchObject([
        {
          action: "plan_document",
          resources: ["*"],
          sessionID,
          agent: "plan",
          source: { type: "tool", messageID: "msg_plan_document", callID: "call-plan-document" },
        },
      ])
    }),
  )
})
