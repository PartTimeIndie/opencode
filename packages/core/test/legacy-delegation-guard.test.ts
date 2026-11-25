import { describe, expect } from "bun:test"
import { Effect, Exit } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { LegacyDelegationGuard } from "@opencode-ai/core/session/legacy-delegation/guard"
import { SessionOrchestratorReservationTable, SessionOrchestratorTable, SessionOrchestratorTaskTable } from "@opencode-ai/core/session/legacy-delegation/sql"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionInputTable, SessionTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(Database.layerFromPath(":memory:"))
const main = SessionSchema.ID.make("ses_legacy_guard_main")
const child = SessionSchema.ID.make("ses_legacy_guard_child")
const input = SessionMessage.ID.make("msg_legacy_guard_input")
const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db.insert(ProjectTable).values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/fixture"), sandboxes: [] }).run().pipe(Effect.orDie)
  yield* db.insert(SessionTable).values([main, child].map((id) => ({
    id, project_id: ProjectV2.ID.global, directory: "/fixture", slug: id, title: id, version: "test",
  }))).run().pipe(Effect.orDie)
  return db
})

function blocked(exit: Exit.Exit<unknown, unknown>) {
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) expect(exit.cause.reasons.some((reason) =>
    reason._tag === "Fail" && reason.error instanceof LegacyDelegationGuard.Blocked &&
    reason.error.message.includes("has been removed"))).toBe(true)
}

describe("retired legacy delegation execution", () => {
  it.effect("leaves ordinary and native task Sessions to their existing admission owner", () => Effect.gen(function* () {
    const db = yield* setup
    expect(yield* LegacyDelegationGuard.assertAdmissible(db, main)).toBe(false)
    yield* db.update(SessionTable).set({ agent_policy: {
      tools: { mode: "inherit", entries: {} }, permissionLayers: [],
      source: { type: "task", sessionID: main, agent: AgentV2.ID.make("build") },
    } }).run().pipe(Effect.orDie)
    expect(yield* LegacyDelegationGuard.assertRunner(db, child)).toBe(false)
  }))

  it.effect("rejects a replayed legacy child even when local task rows are missing", () => Effect.gen(function* () {
    const db = yield* setup
    yield* db.update(SessionTable).set({ agent_policy: {
      tools: { mode: "inherit", entries: {} }, permissionLayers: [],
      source: { type: "orchestrator", sessionID: main, agent: AgentV2.ID.make("build") },
    } }).run().pipe(Effect.orDie)
    blocked(yield* Effect.exit(LegacyDelegationGuard.assertRunner(db, child)))
  }))

  for (const state of ["starting", "checking_cache", "running", "done", "cancelled"] as const)
    it.effect(`rejects historical ${state} children without changing evidence`, () => Effect.gen(function* () {
      const db = yield* setup
      yield* db.insert(SessionInputTable).values({ id: input, session_id: main, prompt: { text: "Historical assignment" }, delivery: "steer", admitted_seq: 1, promoted_seq: 2 }).run().pipe(Effect.orDie)
      yield* db.insert(SessionOrchestratorTable).values({ main_session_id: main }).run().pipe(Effect.orDie)
      yield* db.insert(SessionOrchestratorTaskTable).values({
        id: "legacy-task", main_session_id: main, request_id: "historical-request", origin_input_id: input,
        origin_user_message_id: input, goal: "Historical assignment", acceptance: "Retained evidence",
        resources: ["project:*"], dependencies: [], workspace_mode: "mirror", child_session_id: child,
        state, slot_claimed: state !== "done" && state !== "cancelled", cache_status: "low", cache_ratio: 0.31,
      }).run().pipe(Effect.orDie)
      const before = yield* db.select().from(SessionOrchestratorTaskTable).all().pipe(Effect.orDie)
      blocked(yield* Effect.exit(LegacyDelegationGuard.assertAdmissible(db, child)))
      blocked(yield* Effect.exit(LegacyDelegationGuard.assertFileWrite({ db }, child, "/fixture/file.ts")))
      blocked(yield* Effect.exit(LegacyDelegationGuard.assertShell({ db }, child, "/fixture")))
      expect(yield* db.select().from(SessionOrchestratorTaskTable).all().pipe(Effect.orDie)).toEqual(before)
      expect(yield* LegacyDelegationGuard.assertAdmissible(db, main)).toBe(false)
    }))
  for (const kind of ["task", "reservation"] as const)
    it.effect(`retains unresolved ${kind} claims without authorizing old execution`, () => Effect.gen(function* () {
      const db = yield* setup
      yield* db.insert(SessionInputTable).values({ id: input, session_id: main, prompt: { text: "Historical assignment" }, delivery: "steer", admitted_seq: 1 }).run().pipe(Effect.orDie)
      yield* db.insert(SessionOrchestratorTable).values({ main_session_id: main, checkout_id: "/fixture" }).run().pipe(Effect.orDie)
      yield* db.insert(SessionOrchestratorTaskTable).values({
        id: "legacy-claim", main_session_id: main, request_id: "claim-request", origin_input_id: input,
        origin_user_message_id: input, goal: "Retain", acceptance: "Retain", checkout_id: "/fixture",
        resources: kind === "task" ? ["path:/fixture/owned"] : [], dependencies: [],
        workspace_mode: "shared", state: "cancelled", slot_claimed: kind === "task",
      }).run().pipe(Effect.orDie)
      if (kind === "reservation") yield* db.insert(SessionOrchestratorReservationTable).values({
        task_id: "legacy-claim", directory: "/fixture", resource: "path:/fixture/owned",
      }).run().pipe(Effect.orDie)
      const env = { db, checkouts: { resolve: () => Effect.succeed("/fixture") } }
      expect(yield* LegacyDelegationGuard.assertFileWrite(env, main, "/fixture/unowned.ts")).toBe(true)
      for (const path of ["/fixture/owned/file.ts", "/fixture/owned", "/fixture"]) {
        const result = yield* Effect.exit(LegacyDelegationGuard.assertFileWrite(env, main, path))
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) expect(result.cause.reasons.some((reason) =>
          reason._tag === "Fail" && reason.error instanceof LegacyDelegationGuard.Blocked && reason.error.reason === "unreserved")).toBe(true)
      }
      expect(Exit.isFailure(yield* Effect.exit(LegacyDelegationGuard.assertShell(env, main, "/fixture")))).toBe(true)
    }))
})
