import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "../src/database/database"
import { Project } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { AbsolutePath } from "../src/schema"
import { SessionAttentionState } from "../src/session/attention-state"
import { SessionSchema } from "../src/session/schema"
import { SessionActivityTable, SessionTable } from "../src/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(Database.layerFromPath(":memory:"))
const sessionID = SessionSchema.ID.make("ses_attention_contract")

describe("session attention terminal evidence", () => {
  it.effect("counts completed and failed activities without treating interruptions as completion", () => Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).run().pipe(Effect.orDie)
    yield* db.insert(SessionTable).values({ id: sessionID, project_id: Project.ID.global, slug: "attention", directory: "/project", title: "Attention", version: "test" }).run().pipe(Effect.orDie)
    yield* db.insert(SessionActivityTable).values([
      { id: "first", session_id: sessionID, kind: "prompt", status: "completed", closed_seq: 4 },
      { id: "second", session_id: sessionID, kind: "queue", status: "failed", closed_seq: 8 },
      { id: "stop", session_id: sessionID, kind: "prompt", status: "interrupted", closed_seq: 9 },
      { id: "third", session_id: sessionID, kind: "prompt", status: "running", opened_seq: 10, lease_until: Date.now() + 60_000 },
      { id: "expired", session_id: sessionID, kind: "prompt", status: "running", opened_seq: 11, lease_until: Date.now() - 60_000 },
    ]).run().pipe(Effect.orDie)
    const all = yield* SessionAttentionState.read({ db, sessionID, afterSeq: 0 })
    expect(all).toMatchObject({ cursor: 9, count: 2, last: { id: "second", status: "failed", closedSeq: 8 }, lastFailureSeq: 8, working: true })
    const next = yield* SessionAttentionState.read({ db, sessionID, afterSeq: 4 })
    if (!next) throw new Error("Existing session lost during attention read")
    expect(next.count).toBe(1)
    const settled = yield* SessionAttentionState.read({ db, sessionID, afterSeq: 9 })
    if (!settled) throw new Error("Existing session lost during attention read")
    expect(settled.count).toBe(0)
    yield* db.update(SessionActivityTable).set({ lease_until: Date.now() - 1000 }).where(eq(SessionActivityTable.id, "third")).run().pipe(Effect.orDie)
    expect((yield* SessionAttentionState.read({ db, sessionID, afterSeq: 9 }))?.working).toBe(false)
  }))
})
