import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("private crash handoff resumes through LocalExecution and the real provider with saved model and tool results", async () => {
  if (process.env.OPENCODE_DESKTOP_DRAIN_FIXTURE === "1") return probe()
  const root = await mkdtemp(join(tmpdir(), "opencode-desktop-drain-"))
  const child = Bun.spawn([process.execPath, "test", "--test-name-pattern", "^private crash handoff", import.meta.path], {
    cwd: root,
    env: { ...process.env,
      OPENCODE_DESKTOP_DRAIN_FIXTURE: "1", OPENCODE_TEST_HOME: root, OPENCODE_DB: join(root, "test.db"),
      OPENCODE_CONFIG_DIR: join(root, "config"), OPENCODE_CONFIG: "", OPENCODE_CONFIG_CONTENT: "{}",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_SESSION_RECOVERY: "0",
      OPENCODE_DEFER_BACKGROUND_STARTUP: "0", OPENCODE_SETTLEMENT_WATCHDOG: "0",
      XDG_DATA_HOME: join(root, "data"), XDG_CONFIG_HOME: join(root, "config"),
      XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
    }, stdout: "pipe", stderr: "pipe",
  })
  const timeout = setTimeout(() => child.kill(), 60_000)
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(code, (stdout + stderr).slice(-14000)).toBe(0)
  } finally {
    clearTimeout(timeout)
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}, 70_000)

test("graceful full-process restart continues two live sessions without predecessor authority or repeated tools", async () => {
  const phase = process.env.OPENCODE_CONTROLLED_RESTART_FIXTURE
  if (phase === "release" || phase === "recover") return probe(phase)
  const root = await mkdtemp(join(tmpdir(), "opencode-controlled-restart-"))
  try {
    for (const phase of ["release", "recover"]) {
      const child = Bun.spawn([process.execPath, "test", "--test-name-pattern", "^graceful full-process restart", import.meta.path], {
        cwd: root,
        env: { ...process.env,
          OPENCODE_CONTROLLED_RESTART_FIXTURE: phase, OPENCODE_TEST_HOME: root, OPENCODE_DB: join(root, "test.db"),
          OPENCODE_CONFIG_DIR: join(root, "config"), OPENCODE_CONFIG: "", OPENCODE_CONFIG_CONTENT: "{}",
          OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_SESSION_RECOVERY: "0",
          OPENCODE_DEFER_BACKGROUND_STARTUP: "0", OPENCODE_SETTLEMENT_WATCHDOG: "0",
          XDG_DATA_HOME: join(root, "data"), XDG_CONFIG_HOME: join(root, "config"),
          XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
        }, stdout: "pipe", stderr: "pipe",
      })
      const timeout = setTimeout(() => child.kill(), 60_000)
      try {
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
        expect(code, `${phase}: ${(stdout + stderr).slice(-14000)}`).toBe(0)
      } finally { clearTimeout(timeout) }
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}, 140_000)

async function probe(phase?: "release" | "recover") {
  const { Effect, Layer } = await import("effect")
  const { eq } = await import("drizzle-orm")
  const { Database } = await import("@opencode-ai/core/database/database")
  const { EventV2 } = await import("@opencode-ai/core/event")
  const { EventSequenceTable } = await import("@opencode-ai/core/event/sql")
  const { LocationServiceMap } = await import("@opencode-ai/core/location-layer")
  const { Project } = await import("@opencode-ai/core/project")
  const { ProjectTable } = await import("@opencode-ai/core/project/sql")
  const { AbsolutePath } = await import("@opencode-ai/core/schema")
  const { SessionActivity } = await import("@opencode-ai/core/session/activity")
  const { SessionExecution } = await import("@opencode-ai/core/session/execution")
  const { SessionExecutionLocal } = await import("@opencode-ai/core/session/execution/local")
  const { SessionProjector } = await import("@opencode-ai/core/session/projector")
  const { SessionSchema } = await import("@opencode-ai/core/session/schema")
  const { SessionMessage } = await import("@opencode-ai/core/session/message")
  const { SessionStore } = await import("@opencode-ai/core/session/store")
  const { DesktopRecovery } = await import("@opencode-ai/core/session/desktop-recovery")
  const { SessionActivityTable, SessionMessageTable, SessionTable } = await import("@opencode-ai/core/session/sql")
  const { PluginV2 } = await import("@opencode-ai/core/plugin")
  const { Catalog } = await import("@opencode-ai/core/catalog")
  const { ProviderV2 } = await import("@opencode-ai/core/provider")
  const { ModelV2 } = await import("@opencode-ai/core/model")
  const predecessor = "desktop_00000000-0000-4000-8000-000000000001"
  const replacement = "desktop_00000000-0000-4000-8000-000000000002"
  const owners: string[] = []
  DesktopRecovery.configure({ ownerID: phase === "release" ? predecessor : replacement,
    previousOwners: phase ? [] : [predecessor] }, (owner) => owners.push(owner))
  const database = Database.defaultLayer
  const events = EventV2.layer.pipe(Layer.provide(database))
  const store = SessionStore.layer.pipe(Layer.provide(database))
  const activity = SessionActivity.layer.pipe(Layer.provide(database), Layer.provide(events))
  const locations = LocationServiceMap.layer.pipe(Layer.provide(database), Layer.provide(events), Layer.provide(store))
  const dependencies = Layer.mergeAll(database, events, store, activity, locations)
  const projector = SessionProjector.layer.pipe(Layer.provide(dependencies))
  const execution = SessionExecutionLocal.layer.pipe(Layer.provide(dependencies))
  await Effect.gen(function* () {
    const { db } = yield* Database.Service
    const locations = yield* LocationServiceMap
    const location = { directory: AbsolutePath.make(process.cwd()) }
    const bodies: string[] = []
    let toolCalls = 0
    const events = yield* EventV2.Service
    const unsubscribe = yield* events.listen((event) => {
      if (event.type === "session.next.tool.called") toolCalls++
      return Effect.void
    })
    yield* Effect.addFinalizer(() => unsubscribe)
    const server = yield* Effect.acquireRelease(Effect.sync(() => Bun.serve({ hostname: "127.0.0.1", port: 0,
      fetch: async (request) => {
        bodies.push(await request.text())
        if (phase === "release") return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"id":"before-shutdown","choices":[{"delta":{"role":"assistant","content":"In progress"},"finish_reason":null}]}\n\n'))
        } }), { headers: { "content-type": "text/event-stream" } })
        return new Response('data: {"id":"recovery","choices":[{"delta":{"role":"assistant","content":"Recovered safely"},"finish_reason":null}]}\n\n' +
          'data: {"id":"recovery","choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } })
      },
    })), (server) => Effect.promise(() => server.stop(true)))
    yield* Effect.gen(function* () {
      const plugins = yield* PluginV2.Service
      yield* plugins.add({ id: PluginV2.ID.make("desktop-recovery-fixture"),
        nativeModels: { "desktop-recovery-fixture": { resolve: async (input) => {
          const { route } = await import("@opencode-ai/llm/protocols/openai-chat")
          return { id: input.model.id, provider: input.model.providerID,
            route: route.with({ endpoint: { baseURL: `http://127.0.0.1:${server.port}/v1` }, limits: { context: 1_000_000, output: 1024 } }) }
        } } }, effect: Effect.void,
      })
      const catalog = yield* Catalog.Service
      const transform = yield* catalog.transform()
      yield* transform((editor) => {
        editor.provider.update(ProviderV2.ID.make("crash-fixture"), (provider) => {
          provider.api = { type: "aisdk", package: "desktop-recovery-fixture", url: `http://127.0.0.1:${server.port}/v1` }
        })
        editor.model.update(ProviderV2.ID.make("crash-fixture"), ModelV2.ID.make("saved-model"), (model) => {
          model.api = { id: ModelV2.ID.make("saved-model"), type: "aisdk", package: "desktop-recovery-fixture", url: `http://127.0.0.1:${server.port}/v1` }
          model.capabilities.tools = true
          model.capabilities.input = ["text/plain"]
          model.capabilities.output = ["text/plain"]
          model.limit.context = 1_000_000
          model.limit.output = 1024
        })
      })
    }).pipe(Effect.provide(locations.get(location)))
    if (phase !== "recover") yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: location.directory, sandboxes: [] }).run()
    const model = { id: "saved-model", providerID: "crash-fixture", variant: "high" }
    for (const suffix of phase === "recover" ? [] : phase ? ["safe", "parallel", "stopped"] : ["safe", "blocked", "foreign", "stopped"]) {
      const sessionID = SessionSchema.ID.make(`ses_crash_${suffix}`)
      yield* db.insert(SessionTable).values({ id: sessionID, project_id: Project.ID.global, directory: location.directory,
        slug: suffix, title: suffix, version: "test", agent: "build", model }).run()
      yield* db.insert(EventSequenceTable).values({ aggregate_id: sessionID, seq: 2 }).run()
      const user = { text: "Finish the saved work", files: [], agents: [], time: { created: 2 } }
      yield* db.insert(SessionMessageTable).values({ id: SessionMessage.ID.make(`msg_${suffix}_user`), session_id: sessionID, type: "user", seq: 1, time_created: 2, data: user }).run()
      const data = { agent: "build", model, time: { created: 3 }, content: [
        { type: "tool", id: "call_saved_result", name: "read", time: { created: 3, ran: 3, completed: 3 }, state: suffix === "blocked"
          ? { status: "running", input: { path: "never-repeat.txt" }, structured: {}, content: [] }
          : { status: "completed", input: { path: "never-repeat.txt" }, structured: {}, outputPaths: [], content: [{ type: "text", text: "Persisted tool result: unique-evidence-123" }] } },
        { type: "text", id: "partial", text: "Saved progress before crash" },
      ] }
      yield* db.insert(SessionMessageTable).values({ id: SessionMessage.ID.make(`msg_${suffix}_assistant`), session_id: sessionID, type: "assistant", seq: 2, time_created: 3, data }).run()
      if (!phase || suffix === "stopped") yield* db.insert(SessionActivityTable).values({ id: `act_${suffix}`, session_id: sessionID, kind: "prompt",
        status: suffix === "stopped" ? "interrupted" : "running", owner_id: suffix === "foreign" ? "other-owner" : predecessor,
        lease_until: suffix === "foreign" ? Date.now() + 120_000 : 0, opened_seq: 0, time_created: 1, time_updated: 1 }).run()
    }
    yield* Effect.gen(function* () {
      const execution = yield* SessionExecution.Service
      if (phase) {
        if (phase === "release") {
          for (const suffix of ["safe", "parallel"]) {
            yield* execution.resume(SessionSchema.ID.make(`ses_crash_${suffix}`)).pipe(Effect.forkScoped)
          }
        }
        for (let i = 0; i < 200; i++) {
          const rows = yield* db.select().from(SessionActivityTable).all()
          if (phase === "release" ? bodies.length === 2 : rows.filter((row) => row.status === "completed").length === 2) break
          yield* Effect.sleep("100 millis")
        }
        expect(bodies).toHaveLength(2)
        const rows = yield* db.select().from(SessionActivityTable).all()
        expect(rows.find((row) => row.id === "act_stopped")?.status).toBe("interrupted")
        expect(rows.filter((row) => row.status === (phase === "release" ? "running" : "completed"))).toHaveLength(2)
        for (const body of bodies) {
          expect(body).toContain("saved-model")
          expect(body).toContain("unique-evidence-123")
          expect(body).toContain("Saved progress before crash")
        }
        expect(toolCalls).toBe(0)
        expect(owners).toEqual([phase === "release" ? predecessor : replacement])
        return
      }
      for (let i = 0; i < 200; i++) {
        const row = yield* db.select().from(SessionActivityTable).where(eq(SessionActivityTable.id, "act_safe")).get()
        if (row?.status === "completed" || row?.status === "failed") break
        yield* Effect.sleep("100 millis")
      }
      const rows = yield* db.select().from(SessionActivityTable).all()
      expect(rows.find((row) => row.id === "act_safe")?.status).toBe("completed")
      expect(rows.find((row) => row.id === "act_blocked")?.reason).toBe("desktop-crash-blocked")
      expect(rows.find((row) => row.id === "act_foreign")?.owner_id).toBe("other-owner")
      expect(rows.find((row) => row.id === "act_stopped")?.status).toBe("interrupted")
      expect(bodies).toHaveLength(1)
      expect(bodies[0].includes("saved-model"), "stored model in provider request").toBe(true)
      expect(bodies[0].includes("unique-evidence-123"), "completed tool result in provider request").toBe(true)
      expect(bodies[0].includes("Saved progress before crash"), "partial history in provider request").toBe(true)
      expect(bodies[0].includes("unerwartet beendet"), "system notice in provider request after epoch initialization").toBe(true)
      const saved = yield* db.select().from(SessionTable).where(eq(SessionTable.id, SessionSchema.ID.make("ses_crash_safe"))).get()
      expect(saved?.model).toEqual(model)
      expect(owners).toEqual([replacement])
      expect(toolCalls).toBe(0)
      yield* execution.wake(SessionSchema.ID.make("ses_crash_safe"))
      yield* execution.wait(SessionSchema.ID.make("ses_crash_safe"))
      expect(bodies).toHaveLength(1)
    }).pipe(Effect.provide(execution))
    if (phase === "release") {
      const rows = yield* db.select().from(SessionActivityTable).all()
      const released = rows.filter((row) => row.id !== "act_stopped")
      expect(released).toHaveLength(2)
      expect(released.every((row) => row.status === "running" && row.reason === "owner-shutdown" && row.owner_id === predecessor)).toBe(true)
    }
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(dependencies, projector)), Effect.runPromise)
}
