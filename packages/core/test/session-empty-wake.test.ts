import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// Isolate config before importing real Location services: never load user plugins or credentials.
test("advisory wake without durable input must not create a completed activity", async () => {
  if (process.env.OPENCODE_EMPTY_WAKE_PROBE === "1") return probe()
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-empty-wake-"))
  const child = Bun.spawn([process.execPath, "test", import.meta.path], {
    cwd: root,
    env: {
      ...process.env,
      OPENCODE_EMPTY_WAKE_PROBE: "1",
      OPENCODE_TEST_HOME: root,
      OPENCODE_DB: path.join(root, "test.db"),
      OPENCODE_CONFIG_DIR: path.join(root, "config"),
      OPENCODE_CONFIG: "",
      OPENCODE_CONFIG_CONTENT: "{}",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_SESSION_RECOVERY: "1",
      OPENCODE_DEFER_BACKGROUND_STARTUP: "0",
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_STATE_HOME: path.join(root, "state"),
    },
    stdout: "pipe", stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill(), 60_000)
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    expect(code, stdout + stderr).toBe(0)
  } finally {
    clearTimeout(timer)
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}, 70_000)

async function probe() {
  const { Effect, Layer } = await import("effect")
  const { Database } = await import("@opencode-ai/core/database/database")
  const { EventV2 } = await import("@opencode-ai/core/event")
  const { LocationServiceMap } = await import("@opencode-ai/core/location-layer")
  const { Project } = await import("@opencode-ai/core/project")
  const { ProjectTable } = await import("@opencode-ai/core/project/sql")
  const { AbsolutePath } = await import("@opencode-ai/core/schema")
  const { SessionActivity } = await import("@opencode-ai/core/session/activity")
  const { SessionExecution } = await import("@opencode-ai/core/session/execution")
  const { SessionExecutionLocal } = await import("@opencode-ai/core/session/execution/local")
  const { SessionInput } = await import("@opencode-ai/core/session/input")
  const { SessionProjector } = await import("@opencode-ai/core/session/projector")
  const { SessionSchema } = await import("@opencode-ai/core/session/schema")
  const { SessionStore } = await import("@opencode-ai/core/session/store")
  const { SessionActivityTable, SessionTable } = await import("@opencode-ai/core/session/sql")
  const database = Database.defaultLayer
  const events = EventV2.layer.pipe(Layer.provide(database))
  const store = SessionStore.layer.pipe(Layer.provide(database))
  const activity = SessionActivity.layer.pipe(Layer.provide(database), Layer.provide(events))
  const locations = LocationServiceMap.layer.pipe(Layer.provide(database), Layer.provide(events), Layer.provide(store))
  const dependencies = Layer.mergeAll(database, events, store, activity, locations)
  const projector = SessionProjector.layer.pipe(Layer.provide(dependencies))
  const execution = SessionExecutionLocal.layer.pipe(Layer.provide(dependencies))
  await Effect.gen(function* () {
    const database = yield* Database.Service
    const id = SessionSchema.ID.make("ses_empty_wake_regression")
    yield* database.db.insert(ProjectTable).values({
      id: Project.ID.global, worktree: AbsolutePath.make(process.cwd()), sandboxes: [],
    }).run()
    yield* database.db.insert(SessionTable).values({
      id, project_id: Project.ID.global, directory: process.cwd(), slug: "empty", title: "empty", version: "test",
    }).run()
    expect(yield* SessionInput.hasPending(database.db, id, "steer")).toBe(false)
    expect(yield* SessionInput.hasPending(database.db, id, "queue")).toBe(false)
    yield* Effect.gen(function* () {
      const execution = yield* SessionExecution.Service
      yield* execution.wake(id)
      yield* execution.wait(id)
      const rows = yield* database.db.select().from(SessionActivityTable).all()
      expect(rows.map((row) => ({ status: row.status, kind: row.kind }))).toEqual([])
      yield* database.db.insert(SessionActivityTable).values({
        id: "act_previous_failure", session_id: id, status: "failed", kind: "prompt",
        last_error: "Synthetic provider stream failure", closed_seq: 1,
        turn_completion_state: "done", turn_completion_result: "incomplete",
      }).run()
      yield* execution.wake(id)
      yield* execution.wait(id)
      const afterFailure = yield* database.db.select().from(SessionActivityTable).all()
      expect(afterFailure).toHaveLength(1)
      expect(afterFailure[0]).toMatchObject({
        id: "act_previous_failure", status: "failed", last_error: "Synthetic provider stream failure",
        turn_completion_state: "done", turn_completion_result: "incomplete",
      })
    }).pipe(Effect.provide(execution))
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(dependencies, projector)), Effect.runPromise)
}
