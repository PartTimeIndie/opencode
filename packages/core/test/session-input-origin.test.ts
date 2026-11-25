import { describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionInputTable } from "@opencode-ai/core/session/sql"
import { sql } from "drizzle-orm"
import { DateTime, Effect } from "effect"
import { testEffect } from "./lib/effect"

const it = testEffect(Database.layerFromPath(":memory:"))

const seed = Effect.fn("SessionInputOriginTest.seed")(function* (db: Database.Interface["db"], sessionID: SessionSchema.ID) {
  yield* db.run(sql`
    INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
    VALUES ('project_input_origin', 'C:/repo', '[]', 1, 1)
  `)
  yield* db.run(sql`
    INSERT INTO session (id, project_id, slug, directory, title, version, metadata, time_created, time_updated)
    VALUES (${sessionID}, 'project_input_origin', 'origin', 'C:/repo', 'Origin', 'dev', '{}', 1, 1)
  `)
})

describe("SessionInput origin attestation", () => {
  it.effect("persists an attested plugin origin on the durable admission row", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = SessionSchema.ID.make("ses_input_origin_plugin")
      yield* seed(db, sessionID)
      yield* SessionInput.projectAdmitted(db, {
        admittedSeq: 1,
        id: SessionMessage.ID.make("msg_origin_plugin"),
        sessionID,
        prompt: new Prompt({ text: "continue" }),
        delivery: "steer",
        timeCreated: DateTime.makeUnsafe(1),
        origin: "plugin",
      })
      const admitted = yield* SessionInput.find(db, SessionMessage.ID.make("msg_origin_plugin"))
      expect(admitted?.origin).toBe("plugin")
      expect(
        (
          yield* db
            .select({ origin: SessionInputTable.origin })
            .from(SessionInputTable)
            .limit(1)
            .all()
            .pipe(Effect.orDie)
        ).at(0)?.origin,
      ).toBe("plugin")
    }),
  )

  it.effect("leaves admissions without attestation unattested", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = SessionSchema.ID.make("ses_input_origin_unknown")
      yield* seed(db, sessionID)
      yield* SessionInput.projectAdmitted(db, {
        admittedSeq: 1,
        id: SessionMessage.ID.make("msg_origin_legacy"),
        sessionID,
        prompt: new Prompt({ text: "hello" }),
        delivery: "steer",
        timeCreated: DateTime.makeUnsafe(1),
      })
      const admitted = yield* SessionInput.find(db, SessionMessage.ID.make("msg_origin_legacy"))
      expect(admitted?.origin).toBeUndefined()
    }),
  )
})
