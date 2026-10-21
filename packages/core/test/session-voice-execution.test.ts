import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// Run with an isolated home/config before importing Core: real Location services
// must never load the developer's plugins, credentials or provider configuration.
for (const mode of (["terminal", "startup", "success"] as const).filter(
  (mode) => !process.env.OPENCODE_VOICE_EXECUTION_PROBE || process.env.OPENCODE_VOICE_EXECUTION_PROBE === mode,
)) {
  test(`voice ${mode} delivery uses real local execution and Location services`, async () => {
    if (process.env.OPENCODE_VOICE_EXECUTION_PROBE) return probe(mode)
    const root = await mkdtemp(path.join(os.tmpdir(), "opencode-voice-execution-"))
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      cwd: root,
      env: {
        ...process.env,
        OPENCODE_VOICE_EXECUTION_PROBE: mode,
        OPENCODE_TEST_HOME: root,
        OPENCODE_DB: path.join(root, "test.db"),
        OPENCODE_CONFIG_DIR: path.join(root, "config"),
        OPENCODE_CONFIG: "",
        OPENCODE_CONFIG_CONTENT: "{}",
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_DISABLE_SESSION_RECOVERY: mode === "startup" ? "0" : "1",
        OPENCODE_DEFER_BACKGROUND_STARTUP: "0",
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_STATE_HOME: path.join(root, "state"),
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const timeout = setTimeout(() => child.kill(), 45_000)
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(code, stdout + stderr).toBe(0)
    } finally {
      clearTimeout(timeout)
      // The spawned probe may still hold the temp dir open for a moment after
      // exit on Windows; retry briefly instead of failing the assertions on EBUSY.
      for (let attempt = 0; ; attempt++) {
        try {
          await rm(root, { recursive: true, force: true })
          break
        } catch (error) {
          if (attempt >= 9 || (error as NodeJS.ErrnoException)?.code !== "EBUSY") throw error
          await new Promise((resolve) => setTimeout(resolve, 200))
        }
      }
    }
  }, 50_000)
}

async function probe(mode: "terminal" | "startup" | "success") {
  const { DateTime, Deferred, Effect, Layer, Schema } = await import("effect")
  const { eq } = await import("drizzle-orm")
  const { Database } = await import("@opencode-ai/core/database/database")
  const { Catalog } = await import("@opencode-ai/core/catalog")
  const { PluginBoot } = await import("@opencode-ai/core/plugin/boot")
  const { ProviderV2 } = await import("@opencode-ai/core/provider")
  const { EventV2 } = await import("@opencode-ai/core/event")
  const { LocationServiceMap } = await import("@opencode-ai/core/location-layer")
  const { ModelV2 } = await import("@opencode-ai/core/model")
  const { Project } = await import("@opencode-ai/core/project")
  const { ProjectTable } = await import("@opencode-ai/core/project/sql")
  const { AbsolutePath } = await import("@opencode-ai/core/schema")
  const { SessionActivity } = await import("@opencode-ai/core/session/activity")
  const { SessionExecution } = await import("@opencode-ai/core/session/execution")
  const { SessionExecutionLocal } = await import("@opencode-ai/core/session/execution/local")
  const { SessionInput } = await import("@opencode-ai/core/session/input")
  const { SessionMessage } = await import("@opencode-ai/core/session/message")
  const { SessionProjector } = await import("@opencode-ai/core/session/projector")
  const { SessionSchema } = await import("@opencode-ai/core/session/schema")
  const { SessionStore } = await import("@opencode-ai/core/session/store")
  const { SessionLinks } = await import("@opencode-ai/core/session/links")
  const { SessionWakeup } = await import("@opencode-ai/core/session/wakeup")
  const { SessionActivityTable, SessionInputTable, SessionMessageTable, SessionTable, SessionDispatchTable } =
    await import("@opencode-ai/core/session/sql")

  const database = Database.defaultLayer
  const events = EventV2.layer.pipe(Layer.provide(database))
  const store = SessionStore.layer.pipe(Layer.provide(database))
  const activity = SessionActivity.layer.pipe(Layer.provide(database), Layer.provide(events))
  const locations = LocationServiceMap.layer.pipe(Layer.provide(database), Layer.provide(events), Layer.provide(store))
  const dependencies = Layer.mergeAll(database, events, store, activity, locations)
  const projector = SessionProjector.layer.pipe(Layer.provide(dependencies))
  const execution = SessionExecutionLocal.layer.pipe(Layer.provide(dependencies))
  const workerID = SessionSchema.ID.make("ses_voice_execution_worker")
  const voiceID = SessionSchema.ID.make("ses_voice_execution_moderator")
  const sourceID = SessionMessage.ID.make("msg_voice_execution_source")

  await Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const locations = yield* LocationServiceMap
    const location = { directory: AbsolutePath.make(process.cwd()) }
    const requests: string[] = []
    if (mode === "success") {
      // Exercise the actual provider adapter and runner, with deterministic local
      // SSE instead of a paid provider or a replacement SessionRunner service.
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: async (request) => {
              requests.push(await request.text())
              return new Response(
                `data: ${JSON.stringify({ id: "chatcmpl_voice", choices: [{ delta: { role: "assistant", content: requests.length === 1 ? "Verified worker result." : "Moderator summarized the verified result." }, finish_reason: null }], usage: null })}\n\n` +
                  'data: {"id":"chatcmpl_voice","choices":[{"delta":{},"finish_reason":"stop"}],"usage":null}\n\n' +
                  "data: [DONE]\n\n",
                { headers: { "content-type": "text/event-stream" } },
              )
            },
          }),
        ),
        (server) =>
          Effect.promise(async () => {
            await server.stop(true)
          }),
      )
      yield* Effect.gen(function* () {
        yield* PluginBoot.Service.use((boot) => boot.wait())
        const catalog = yield* Catalog.Service
        const transform = yield* catalog.transform()
        yield* transform((editor) => {
          editor.provider.update(ProviderV2.ID.make("voice-fixture"), (provider) => {
            provider.api = {
              type: "aisdk",
              package: "@ai-sdk/openai-compatible",
              url: `http://127.0.0.1:${server.port}/v1`,
            }
          })
          editor.model.update(ProviderV2.ID.make("voice-fixture"), ModelV2.ID.make("fixture"), (model) => {
            model.api = {
              id: ModelV2.ID.make("fixture"),
              type: "aisdk",
              package: "@ai-sdk/openai-compatible",
              url: `http://127.0.0.1:${server.port}/v1`,
            }
            model.capabilities.tools = true
            model.capabilities.input = ["text/plain"]
            model.capabilities.output = ["text/plain"]
            model.limit.context = 32_768
            model.limit.output = 1_024
          })
        })
      }).pipe(Effect.provide(locations.get(location)))
    }
    yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: location.directory, sandboxes: [] }).run()
    yield* db
      .insert(SessionTable)
      .values(
        [workerID, voiceID].map((id) => ({
          id,
          project_id: Project.ID.global,
          directory: location.directory,
          slug: id,
          title: id,
          version: "test",
          agent: id === voiceID ? "voice-moderator" : "build",
          // Pin both successful runs; failure modes keep an empty catalog/model.
          model: mode === "success" ? { providerID: "voice-fixture", id: "fixture" } : null,
        })),
      )
      .run()
    const { id, type, ...data } = Schema.encodeSync(SessionMessage.Assistant)(
      new SessionMessage.Assistant({
        id: sourceID,
        type: "assistant",
        agent: "voice-moderator",
        model: Schema.decodeUnknownSync(ModelV2.Ref)({ id: "fixture", providerID: "fixture" }),
        content: [],
        time: { created: DateTime.makeUnsafe(Date.now()) },
      }),
    )
    yield* db
      .insert(SessionMessageTable)
      .values({
        id: SessionMessage.ID.make(id),
        session_id: voiceID,
        type,
        seq: 0,
        data,
      })
      .run()
    const voice = yield* SessionLinks.Service.pipe(Effect.provide(locations.get(location)))
    yield* voice.bind({ pluginID: "test-links", permissionPolicy: "single-use", sourceSessionID: voiceID, targetSessionID: workerID })
    // Admit before the execution listener exists. Startup must not wake this worker.
    const receipt = yield* voice.send({ pluginID: "test-links", delivery: "queue",
      sourceSessionID: voiceID,
      sourceMessageID: sourceID,
      sourceCallID: "call_fixture",
      text: "Run the fixture",
    })
    if (mode === "startup") {
      const openedSeq = yield* SessionInput.latestSeq(db, workerID)
      yield* SessionInput.promoteNextQueued(db, events, workerID)
      yield* db
        .insert(SessionActivityTable)
        .values({
          id: "act_crashed_voice_worker",
          session_id: workerID,
          status: "running",
          kind: "prompt",
          owner_id: "crashed-process",
          lease_until: 0,
          heartbeat_at: 0,
          opened_seq: openedSeq,
        })
        .run()
    }
    const wakes: string[] = []
    const delivered = yield* Deferred.make<void>()
    yield* SessionWakeup.listen((id) =>
      Effect.gen(function* () {
        wakes.push(id)
        if (id === voiceID) yield* Deferred.succeed(delivered, undefined)
      }),
    )
    yield* Effect.gen(function* () {
      const execution = yield* SessionExecution.Service
      if (mode !== "startup") yield* execution.wake(workerID, receipt.admittedSeq)
      yield* Deferred.await(delivered).pipe(Effect.timeout("20 seconds"))
      // Wake is emitted during admission, before the delivery marker commits.
      // Await that durable boundary without calling deliver ourselves.
      const dispatch = yield* Effect.sleep("10 millis").pipe(
        Effect.andThen(() => db.select().from(SessionDispatchTable).get()),
        Effect.repeat({ while: (row) => row?.time_result_delivered == null }),
        Effect.timeout("5 seconds"),
      )
      if (!dispatch) throw new Error("Missing delivered dispatch")
      yield* execution.wait(workerID)
      yield* execution.wait(voiceID)
      const workers = yield* db
        .select()
        .from(SessionActivityTable)
        .where(eq(SessionActivityTable.session_id, workerID))
        .all()
      expect(workers).toHaveLength(1)
      expect(workers[0].status).toBe(mode === "terminal" ? "failed" : mode === "startup" ? "interrupted" : "completed")
      if (mode === "terminal") expect(workers[0].last_error).toContain("ModelNotSelectedError")
      if (mode === "startup") expect(workers[0].id).toBe("act_crashed_voice_worker")
      expect(wakes).toEqual([voiceID])
      expect(dispatch?.time_result_delivered).toBeNumber()
      expect(dispatch?.result_text).toContain(workerID)
      expect(dispatch?.result_text).toContain(receipt.id)
      expect(dispatch?.result_text).toContain(
        mode === "terminal" ? "failed" : mode === "startup" ? "interrupted" : "completed",
      )
      if (mode === "success") {
        expect(dispatch.result_text).toContain("Verified worker result.")
        expect(requests).toHaveLength(2)
        expect(requests[0]).toContain("Run the fixture")
        expect(requests[1]).toContain("Verified worker result.")
        expect(requests[1]).toContain(receipt.id)
        const moderatorActivities = yield* db
          .select()
          .from(SessionActivityTable)
          .where(eq(SessionActivityTable.session_id, voiceID))
          .all()
        expect(moderatorActivities).toHaveLength(1)
        expect(moderatorActivities[0].status).toBe("completed")
        const answers = yield* db
          .select()
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, voiceID))
          .all()
        expect(
          answers.filter(
            (message) =>
              message.type === "assistant" &&
              JSON.stringify(message.data).includes("Moderator summarized the verified result."),
          ),
        ).toHaveLength(1)
      }
      yield* voice.deliver(workerID)
      yield* voice.deliver(workerID)
      expect(wakes).toEqual([voiceID])
      if (mode === "success") expect(requests).toHaveLength(2)
      const results = yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.session_id, voiceID)).all()
      expect(results).toHaveLength(1)
      expect(results[0].id).toBe(dispatch?.result_input_id)
      expect(results[0].delivery).toBe("queue")
      expect(
        (yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.id, receipt.id)).get())?.promoted_seq,
      ).toBeNumber()
    }).pipe(Effect.provide(execution))
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(dependencies, projector)), Effect.runPromise)
}
