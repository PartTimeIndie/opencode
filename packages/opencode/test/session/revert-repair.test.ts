import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { SessionRevertRepair } from "@/session/revert-repair"
import { Project } from "@opencode-ai/core/project"
import { MessageID, SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(SessionRevertRepair.layer)

describe("SessionRevertRepair", () => {
  it.effect("never starts a writing repair agent for a blocked rollback", () =>
    Effect.gen(function* () {
      const repair = yield* SessionRevertRepair.Service
      const sessionID = SessionID.make("ses_blocked_revert")
      const messageID = MessageID.make("msg_blocked_revert")
      const session = {
        id: sessionID,
        slug: "blocked-revert",
        projectID: Project.ID.global,
        directory: "/project",
        title: "Blocked revert",
        version: "test",
        time: { created: 0, updated: 0 },
        revert: { messageID, status: "blocked" as const, conflicts: [] },
      }
      const result = yield* repair.ensureStarted({
        session,
        request: { sessionID, messageID },
      })
      expect(result).toBe(session)
    }),
  )
})
