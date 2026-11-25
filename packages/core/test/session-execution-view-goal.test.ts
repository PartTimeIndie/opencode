import { expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionExecutionView } from "@opencode-ai/core/session/execution-view"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { testEffect } from "./lib/effect"

const it = testEffect(Database.layerFromPath(":memory:"))

for (const status of ["interrupted", "failed", "completed"] as const) {
  it.effect(`preserves an explicitly bound ${status} activity without inventing a legacy closing sequence`, () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const db = database.db
      yield* db.run(sql`INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
        VALUES ('project_terminal', 'C:/repo', '[]', 1, 1)`)
      yield* db.run(sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
        VALUES ('ses_terminal', 'project_terminal', 'terminal', 'C:/repo', 'Terminal', 'dev', 1, 1)`)
      yield* db.run(sql`INSERT INTO session_input (id, session_id, prompt, delivery, admitted_seq, promoted_seq, time_created)
        VALUES ('msg_terminal', 'ses_terminal', '{}', 'queue', 1, 3, 1)`)
      yield* db.run(sql`INSERT INTO session_activity (id, session_id, status, kind, opened_seq, closed_seq, time_created, time_updated)
        VALUES ('activity_terminal', 'ses_terminal', ${status}, 'prompt', 2, NULL, 1, 2),
               ('activity_later', 'ses_terminal', 'completed', 'prompt', 7, 10, 3, 4)`)
      const unbound = yield* SessionExecutionView.read(database, { sessionID: "ses_terminal", messageID: "msg_terminal" })
      expect(unbound.phase).toBe("promoted")
      const view = yield* SessionExecutionView.read(database, {
        sessionID: "ses_terminal", messageID: "msg_terminal", activityID: "activity_terminal",
      })
      expect(view.phase).toBe("activity")
      if (view.phase !== "activity") return
      expect(view.activity).toMatchObject({ id: "activity_terminal", status, closed_seq: null })
      expect(view.assistants).toEqual([])
      expect(view.laterInputs).toEqual([])
      const stored = yield* db.all(sql`SELECT status, closed_seq FROM session_activity WHERE id = 'activity_terminal'`)
      expect(stored).toEqual([{ status, closed_seq: null }])
    }),
  )
}

it.effect("binds a verification response to the admitted activity and reports later queued input", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    yield* db.run(sql`INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
      VALUES ('project_goal_activity', 'C:/repo', '[]', 1, 1)`)
    yield* db.run(sql`INSERT INTO session (id, project_id, slug, directory, title, version, metadata, time_created, time_updated)
      VALUES ('ses_goal_activity', 'project_goal_activity', 'goal', 'C:/repo', 'Goal', 'dev', '{}', 1, 1)`)
    yield* db.run(sql`INSERT INTO session_input (id, session_id, prompt, delivery, admitted_seq, promoted_seq, time_created)
      VALUES ('msg_goal_input', 'ses_goal_activity', '{}', 'queue', 1, 3, 1)`)
    yield* db.run(sql`INSERT INTO session_activity (id, session_id, status, kind, opened_seq, closed_seq, time_created, time_updated)
      VALUES ('activity_goal_verify', 'ses_goal_activity', 'completed', 'prompt', 2, 5, 1, 2)`)
    yield* db.run(sql`INSERT INTO session_message (id, session_id, type, seq, data, time_created, time_updated)
      VALUES ('msg_goal_confirm', 'ses_goal_activity', 'assistant', 4, '{}', 1, 2)`)
    const before = yield* SessionExecutionView.read(database, { sessionID: "ses_goal_activity", messageID: "msg_goal_input" })
    expect(before.phase).toBe("activity")
    if (before.phase !== "activity") return
    expect(before.activity.status).toBe("completed")
    expect(before.assistants.at(-1)?.id).toBe(SessionMessage.ID.make("msg_goal_confirm"))
    expect(before.laterAdmissions).toEqual([])

    yield* db.run(sql`INSERT INTO session_input (id, session_id, prompt, delivery, admitted_seq, time_created)
      VALUES ('msg_user_queued', 'ses_goal_activity', '{}', 'queue', 2, 3)`)
    const after = yield* SessionExecutionView.read(database, { sessionID: "ses_goal_activity", messageID: "msg_goal_input" })
    expect(after.phase).toBe("activity")
    if (after.phase !== "activity") return
    expect(after.laterInputs).toEqual([])
    expect(after.laterAdmissions).toEqual([SessionMessage.ID.make("msg_user_queued")])
    yield* db.run(sql`INSERT INTO session_activity (id, session_id, status, kind, opened_seq, closed_seq, time_created, time_updated)
      VALUES ('activity_foreign', 'ses_goal_activity', 'completed', 'prompt', 7, 9, 4, 5),
             ('activity_before', 'ses_goal_activity', 'completed', 'prompt', 0, 1, 0, 1)`)
    for (const activityID of ['activity_foreign', 'activity_before']) {
      const mismatched = yield* SessionExecutionView.read(database, {
        sessionID: "ses_goal_activity", messageID: "msg_goal_input", activityID, requireOriginalActivity: true,
      })
      expect(mismatched).toEqual({ phase: "promoted" })
    }
    const strict = yield* SessionExecutionView.read(database, { sessionID: "ses_goal_activity", messageID: "msg_goal_input",
      activityID: "activity_goal_verify", requireOriginalActivity: true, followContinuations: true })
    expect(strict).toMatchObject({ phase: "activity", activity: { id: "activity_goal_verify" } })
  }),
)

it.effect("observes only the native Main task bound to the parent, dispatch, physical placement and input", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const binding = {
      parentSessionID: "ses_parent",
      sessionID: "ses_bound",
      messageID: "msg_bound",
      dispatchDigest: "a".repeat(64),
      placementIdentity: "physical-root",
    }
    const policy = {
      source: { type: "task", sessionID: binding.parentSessionID, agent: "build" },
      executionPlacement: { version: 1, directory: "C:/repo", checkout: "C:/repo", identity: binding.placementIdentity },
      mainWriteConsent: { version: 1, permissionID: "per_bound", inputID: binding.messageID,
        dispatchDigest: binding.dispatchDigest, placementIdentity: binding.placementIdentity },
    }
    yield* db.run(sql`INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
      VALUES ('bound_project', 'C:/repo', '[]', 1, 1)`)
    yield* db.run(sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
      VALUES (${binding.parentSessionID}, 'bound_project', 'parent', 'C:/repo', 'Parent', 'dev', 1, 1)`)
    yield* db.run(sql`INSERT INTO session (id, parent_id, project_id, slug, directory, title, version, time_created,
      time_updated, fork_dispatch_digest, agent_policy)
      VALUES (${binding.sessionID}, ${binding.parentSessionID}, 'bound_project', 'bound', 'C:/repo', 'Bound', 'dev',
        1, 1, ${binding.dispatchDigest}, ${JSON.stringify(policy)})`)
    yield* db.run(sql`INSERT INTO session_input (id, session_id, prompt, delivery, admitted_seq, promoted_seq, time_created)
      VALUES (${binding.messageID}, ${binding.sessionID}, '{}', 'steer', 1, 3, 1)`)
    yield* db.run(sql`INSERT INTO session_activity (id, session_id, status, kind, opened_seq, closed_seq, time_created, time_updated)
      VALUES ('activity_bound', ${binding.sessionID}, 'failed', 'prompt', 2, 6, 1, 2),
             ('activity_other', ${binding.sessionID}, 'completed', 'prompt', 7, 9, 3, 4)`)
    expect(yield* SessionExecutionView.readMainTask(database, binding)).toMatchObject({
      phase: "activity", activity: { id: "activity_bound", status: "failed", closed_seq: 6 },
    })
    expect(yield* SessionExecutionView.readMainTask(database, { ...binding, activityID: "activity_other" })).toEqual({
      phase: "promoted",
    })
    for (const mismatch of [
      { parentSessionID: "ses_unrelated" }, { sessionID: "ses_unrelated" }, { messageID: "msg_other" },
      { dispatchDigest: "b".repeat(64) }, { placementIdentity: "different-root" },
    ]) {
      expect(yield* SessionExecutionView.readMainTask(database, { ...binding, ...mismatch })).toEqual({
        phase: "task_binding_mismatch",
      })
    }
    yield* db.run(sql`UPDATE session SET agent_policy = ${JSON.stringify({ ...policy,
      mainWriteConsent: { ...policy.mainWriteConsent, inputID: "msg_followup" },
    })} WHERE id = ${binding.sessionID}`)
    expect(yield* SessionExecutionView.readMainTask(database, binding)).toEqual({ phase: "task_binding_mismatch" })
  }),
)
