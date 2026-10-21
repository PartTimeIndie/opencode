import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { Memory } from "@opencode-ai/core/memory"
import { SystemContext } from "@opencode-ai/core/system-context"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const memory = Memory.layer.pipe(Layer.provide(database))
const it = testEffect(Layer.mergeAll(database, memory))

describe("Memory", () => {
  it.live("recalls only approved scoped memories and removes them from FTS on deletion", () =>
    Effect.gen(function* () {
      const service = yield* Memory.Service
      const candidate = yield* service.propose({
        scope: "project",
        scopeKey: "project-a",
        content: "Use bounded language server results",
        source: "night_run",
        provenance: {
          origin: "night-run/artifact.json",
          captured_at: 1,
          session_id: "ses_source",
          artifact: "artifact.json",
        },
      })

      expect(candidate.state).toBe("pending")
      expect(
        yield* service.recall({ projectID: "project-a", sessionID: "ses_target", query: "language" }),
      ).toEqual([])
      expect(yield* service.review({ id: candidate.id, decision: "approved", reviewedBy: "user" })).toMatchObject({
        state: "approved",
        reviewed_by: "user",
      })
      expect(
        yield* service.recall({ projectID: "project-b", sessionID: "ses_target", query: "language" }),
      ).toEqual([])
      expect(
        yield* service.recall({ projectID: "project-a", sessionID: "ses_target", query: "language" }),
      ).toMatchObject([{ id: candidate.id, state: "approved" }])
      expect(
        yield* service.recall({ projectID: "project-a", sessionID: "ses_target", query: 'language " unmatched' }),
      ).toEqual([])

      yield* service.putEmbedding({ memoryID: candidate.id, model: "test", vector: [0.1, 0.2] })
      expect(yield* service.remove(candidate.id, "user")).toMatchObject({ state: "deleted" })
      expect(
        yield* service.recall({ projectID: "project-a", sessionID: "ses_target", query: "language" }),
      ).toEqual([])
    }),
  )

  it.live("keeps session memories isolated while allowing global recall", () =>
    Effect.gen(function* () {
      const service = yield* Memory.Service
      const session = yield* service.propose({
        scope: "session",
        scopeKey: "ses_one",
        content: "Session-only fact",
        source: "manual",
        provenance: { origin: "chat", captured_at: 2, session_id: "ses_one" },
      })
      const global = yield* service.propose({
        scope: "global",
        scopeKey: "ignored",
        content: "Global reviewed fact",
        source: "manual",
        provenance: { origin: "chat", captured_at: 3 },
      })
      yield* service.review({ id: session.id, decision: "approved", reviewedBy: "user" })
      yield* service.review({ id: global.id, decision: "approved", reviewedBy: "user" })

      expect(yield* service.recall({ projectID: "project", sessionID: "ses_two" })).toMatchObject([
        { id: global.id },
      ])
      expect(yield* service.recall({ projectID: "project", sessionID: "ses_one" })).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: session.id }), expect.objectContaining({ id: global.id })]),
      )
      const context = yield* SystemContext.initialize(
        Memory.context(service, { projectID: "project", sessionID: "ses_one" }),
      )
      expect(context.baseline).toContain("Approved memories")
      expect(context.baseline).toContain("Session-only fact")
      expect(context.baseline).toContain("Global reviewed fact")
      expect(context.baseline).toContain("origin=chat")
    }),
  )
})
