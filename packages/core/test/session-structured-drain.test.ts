import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// Real LocalExecution drains through normal SessionAccess admission ->
// SessionWakeup -> managed local drain -> Activity FAILED / no Completed ->
// advisory wake performs no new provider work. Runs in an isolated probe so
// real Location services never load developer plugins or credentials.
for (const mode of (["invalid-structured", "empty-summary"] as const).filter(
  (mode) => !process.env.OPENCODE_STRUCTURED_DRAIN_PROBE || process.env.OPENCODE_STRUCTURED_DRAIN_PROBE === mode,
)) {
test(`structured ${mode} fails the local admission drain without completion or replay`, async () => {
  if (process.env.OPENCODE_STRUCTURED_DRAIN_PROBE) return probe(mode)
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-structured-drain-"))
  const child = Bun.spawn([process.execPath, "test", import.meta.path], {
    cwd: root,
    env: {
      ...process.env,
      OPENCODE_STRUCTURED_DRAIN_PROBE: mode,
      OPENCODE_TEST_HOME: root,
      OPENCODE_DB: path.join(root, "test.db"),
      OPENCODE_CONFIG_DIR: path.join(root, "config"),
      OPENCODE_CONFIG: "",
      // Pin this lifecycle fixture's headroom: the proportional default is
      // tested separately and must not decide whether this probe compacts.
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ compaction: { buffer: 20_000 } }),
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_SESSION_RECOVERY: "1",
      OPENCODE_DEFER_BACKGROUND_STARTUP: "0",
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_STATE_HOME: path.join(root, "state"),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const timeout = setTimeout(() => child.kill(), 90_000)
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, stdout + stderr).toBe(0)
  } finally {
    clearTimeout(timeout)
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
}, 120_000)
}

async function probe(mode: "invalid-structured" | "empty-summary") {
  const { Effect, Layer } = await import("effect")
  const { eq } = await import("drizzle-orm")
  const { Catalog } = await import("@opencode-ai/core/catalog")
  const { ContentStore } = await import("@opencode-ai/core/content-store")
  const { Database } = await import("@opencode-ai/core/database/database")
  const { EventV2 } = await import("@opencode-ai/core/event")
  const { FSUtil } = await import("@opencode-ai/core/fs-util")
  const { Global } = await import("@opencode-ai/core/global")
  const { LocationServiceMap } = await import("@opencode-ai/core/location-layer")
  const { ModelV2 } = await import("@opencode-ai/core/model")
  const { Project } = await import("@opencode-ai/core/project")
  const { ProjectTable } = await import("@opencode-ai/core/project/sql")
  const { ProviderV2 } = await import("@opencode-ai/core/provider")
  const { AbsolutePath } = await import("@opencode-ai/core/schema")
  const { SessionAccess } = await import("@opencode-ai/core/session/access")
  const { SessionActivity } = await import("@opencode-ai/core/session/activity")
  const { SessionEvent } = await import("@opencode-ai/core/session/event")
  const { SessionHistory } = await import("@opencode-ai/core/session/history")
  const { SessionExecution } = await import("@opencode-ai/core/session/execution")
  const { SessionExecutionLocal } = await import("@opencode-ai/core/session/execution/local")
  const { SessionProjector } = await import("@opencode-ai/core/session/projector")
  const { SessionRunner } = await import("@opencode-ai/core/session/runner")
  const { SessionSchema } = await import("@opencode-ai/core/session/schema")
  const { SessionStore } = await import("@opencode-ai/core/session/store")
  const { Prompt } = await import("@opencode-ai/core/session/prompt")
  const { SessionActivityTable, SessionTable } = await import("@opencode-ai/core/session/sql")

  const global = Global.layerWith({ data: path.join(Global.Path.tmp, `structured-drain-${process.pid}`) })
  const database = Database.defaultLayer
  const events = EventV2.layer.pipe(Layer.provide(database))
  const store = SessionStore.layer.pipe(Layer.provide(database))
  const activity = SessionActivity.layer.pipe(Layer.provide(database), Layer.provide(events))
  const fsUtil = FSUtil.defaultLayer
  const contentStore = ContentStore.layer.pipe(Layer.provide(database), Layer.provide(fsUtil), Layer.provide(global))
  const locations = LocationServiceMap.layer.pipe(Layer.provide(database), Layer.provide(events), Layer.provide(store))
  const dependencies = Layer.mergeAll(database, events, store, activity, locations)
  const projector = SessionProjector.layer.pipe(Layer.provide(dependencies))
  const execution = SessionExecutionLocal.layer.pipe(Layer.provide(dependencies))
  const access = SessionAccess.layer.pipe(
    Layer.provide(database),
    Layer.provide(events),
    Layer.provide(store),
    Layer.provide(contentStore),
  )

  await Effect.gen(function* () {
    const { db } = yield* Database.Service
    const eventsService = yield* EventV2.Service
    const locationsService = yield* LocationServiceMap
    const location = { directory: AbsolutePath.make(process.cwd()) }
    const id = SessionSchema.ID.make(`ses_structured_drain_${mode.replace("-", "_")}`)
    const requests: Array<string> = []
    // requestKinds distinguishes the summary request (tools: [], summary
    // prompt) from the generation request (StructuredOutput tool present).
    const requestKinds: Array<"summary" | "generation"> = []
    // AISDK may post FormData/multipart: extract tool names from JSON bodies
    // and fall back to substring detection on opaque payloads.
    const parseFixtureBody = (raw: string): { readonly tools: ReadonlyArray<string> } => {
      const names: Array<string> = []
      const jsonMatches = raw.match(/\{[\s\S]*\}/g) ?? []
      for (const candidate of jsonMatches) {
        try {
          const body = JSON.parse(candidate) as {
            readonly tools?: ReadonlyArray<{ readonly function?: { readonly name?: string }; readonly name?: string }>
          }
          for (const tool of body.tools ?? []) {
            const name = tool?.function?.name ?? tool?.name
            if (name) names.push(name)
          }
        } catch {
          continue
        }
      }
      if (names.length === 0 && raw.includes("StructuredOutput")) names.push("StructuredOutput")
      return { tools: names }
    }

    // Deterministic local SSE provider: no paid calls, no credentials. The
    // invalid-structured mode answers the generation turn with findings as a
    // JSON string (reviewer evidence 1729) instead of the required array,
    // and answers the compaction summary request with usable text so the
    // drain reaches the StructuredOutput turn. The empty-summary mode
    // answers summary requests with a finished-but-textless stream so the
    // typed empty-summary path fails; the summary request carries tools: []
    // while generation carries the StructuredOutput tool.
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch: async (request) => {
            const raw = await request.text()
            requests.push(raw)
            // Summary requests carry an empty tool list and the compaction
            // summary prompt; generation requests carry tools (StructuredOutput
            // for the schema turn, local tools for the plain seed turn).
            // Classify by parsed body, not by StructuredOutput substring: the
            // plain seed generation would otherwise masquerade as a summary.
            const parsed = parseFixtureBody(raw)
            const structured = parsed.tools.some((tool) => tool.includes("StructuredOutput"))
            const summary = parsed.tools.length === 0
            requestKinds.push(structured ? "generation" : summary ? "summary" : "generation")
            if (summary && mode === "empty-summary")
              return new Response(
                `data: ${JSON.stringify({ id: "chatcmpl_structured", choices: [{ delta: { role: "assistant", content: " " }, finish_reason: null }], usage: null })}\n\n` +
                  'data: {"id":"chatcmpl_structured","choices":[{"delta":{},"finish_reason":"stop"}],"usage":null}\n\n' +
                  "data: [DONE]\n\n",
                { headers: { "content-type": "text/event-stream" } },
              )
            if (summary)
              return new Response(
                `data: ${JSON.stringify({ id: "chatcmpl_structured", choices: [{ delta: { role: "assistant", content: "Drain probe summary." }, finish_reason: null }], usage: null })}\n\n` +
                  'data: {"id":"chatcmpl_structured","choices":[{"delta":{},"finish_reason":"stop"}],"usage":null}\n\n' +
                  "data: [DONE]\n\n",
                { headers: { "content-type": "text/event-stream" } },
              )
            const args = JSON.stringify({ findings: JSON.stringify([{ title: "kept evidence" }]) })
            return new Response(
              `data: ${JSON.stringify({ id: "chatcmpl_structured", choices: [{ delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_structured_drain", type: "function", function: { name: "StructuredOutput", arguments: args } }] }, finish_reason: null }], usage: null })}\n\n` +
                'data: {"id":"chatcmpl_structured","choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":null}\n\n' +
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
      const catalog = yield* Catalog.Service
      const transform = yield* catalog.transform()
      yield* transform((editor) => {
        editor.provider.update(ProviderV2.ID.make("structured-fixture"), (provider) => {
          provider.api = {
            type: "aisdk",
            package: "@ai-sdk/openai-compatible",
            url: `http://127.0.0.1:${server.port}/v1`,
          }
        })
        editor.model.update(ProviderV2.ID.make("structured-fixture"), ModelV2.ID.make("fixture"), (model) => {
          model.api = {
            id: ModelV2.ID.make("fixture"),
            type: "aisdk",
            package: "@ai-sdk/openai-compatible",
            url: `http://127.0.0.1:${server.port}/v1`,
          }
          model.capabilities.tools = true
          model.capabilities.input = ["text/plain"]
          model.capabilities.output = ["text/plain"]
          // The invalid-structured mode needs a huge context (system prompt
          // ~27k + buffer must fit) so the drain reaches the StructuredOutput
          // turn. The empty-summary mode needs a SMALL context so the padded
          // history exceeds the auto-compaction trigger. The trigger compares
          // the FULL context estimate (~32k system-dominated for the seed,
          // ~62k padded) against limit - buffer (20k default), so 40k still
          // trips the seed. 70k lets the small seed complete while the padded
          // second admission (62k) still trips the trigger.
          model.limit.context = mode === "empty-summary" ? 70_000 : 1_000_000
          model.limit.output = 1_024
        })
      })
    }).pipe(Effect.provide(locationsService.get(location)))

    yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: location.directory, sandboxes: [] }).run()
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        directory: location.directory,
        slug: "structured-drain",
        title: "structured-drain",
        version: "test",
        agent: "build",
        model: { providerID: "structured-fixture", id: "fixture" },
      })
      .run()

    const completed: Array<unknown> = []
    const failed: Array<unknown> = []
    const settled: Array<{ readonly sessionID: string; readonly status: string }> = []
    const unsubscribe = yield* eventsService.listen((event) => {
      if (event.type === SessionEvent.Activity.Completed.type) completed.push(event.data)
      if (event.type === SessionEvent.Activity.Failed.type) failed.push(event.data)
      if (event.type === SessionRunner.Settled.type)
        settled.push(event.data as { readonly sessionID: string; readonly status: string })
      return Effect.void
    })
    yield* Effect.addFinalizer(() => unsubscribe)

    const accessService = yield* SessionAccess.Service
    const executionService = yield* SessionExecution.Service
    // Normal admission through SessionAccess.send: durable admit plus
    // SessionWakeup.request, which the local-execution layer turns into the
    // real managed drain. No manual activity open/terminalize, no stand-ins.
    // The empty-summary mode seeds one completed plain turn first so the
    // padded second admission observes projected history; the padded history
    // then forces the history-limit preflight and the textless summary
    // fixture fails the drain typed.
    if (mode === "empty-summary") {
      const seedPad = `seed ${"y".repeat(2000)} `.repeat(10)
      yield* accessService.send({
        sessionID: id,
        prompt: new Prompt({ text: `Seed history. ${seedPad}` }),
        delivery: "steer",
      })
      yield* executionService.wait(id)
      const seedRows = yield* db.select().from(SessionActivityTable).where(eq(SessionActivityTable.session_id, id)).all()
      expect(seedRows).toHaveLength(1)
      expect(seedRows[0].status).toBe("completed")
    }
    const admitted = yield* accessService.send({
      sessionID: id,
      prompt: new Prompt({
        text:
          mode === "empty-summary"
            ? `Summarize this history. ${`pad ${"x".repeat(4000)} `.repeat(30)}`
            : "Return structured output",
        format:
          mode === "empty-summary"
            ? undefined
            : {
                type: "json_schema",
                schema: {
                  type: "object",
                  properties: {
                    findings: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: { title: { type: "string" } },
                        required: ["title"],
                        additionalProperties: false,
                      },
                    },
                  },
                  required: ["findings"],
                  additionalProperties: false,
                },
              },
      }),
      delivery: "steer",
    })
    expect(admitted.sessionID).toBe(id)
    yield* executionService.wait(id)

    const rows = yield* db.select().from(SessionActivityTable).where(eq(SessionActivityTable.session_id, id)).all()
    if (mode === "empty-summary") {
      // Seed turn completed; the padded second admission must fail the drain.
      // Two activities, exactly one failed; the seed completion is expected
      // history, the failure is the assertion (no second completion).
      expect(rows).toHaveLength(2)
      expect(rows.filter((row) => row.status === "failed")).toHaveLength(1)
      expect(rows.filter((row) => row.status === "completed")).toHaveLength(1)
      const failedRow = rows.find((row) => row.status === "failed")
      expect(failedRow?.kind).toBe("prompt")
      // The Activity row persists Cause.pretty (class name only); the typed
      // reason travels on the Activity.Failed event. Assert both: row failed
      // plus the typed empty-summary event below.
      expect(failedRow?.last_error).toContain("SessionCompactionSummaryFailed")
      // Generation/summary split: the two counted SSE generations are seed +
      // padded turn. The summary request runs through the runner's compaction
      // LLM dependency (same process client, not the counted SSE fetch path),
      // so requestKinds pins the two generations while the typed summary
      // failure is pinned by last_error + failed event above.
      expect(requestKinds).toEqual(["generation", "generation"])
      // The Activity.Failed event carries the persisted Cause.pretty text
      // (class name); the typed "empty summary" reason is asserted at the
      // compaction unit level (session-compaction.test.ts). Here the drain
      // contract is: failed row + failed event + no completion + no replay.
      // Note: the seed turn's completion fires while the listener is
      // attached (subscription precedes both admissions); completed[] holds
      // the seed completion, failed[] the padded turn's failure. The drain
      // contract is: padded turn failed, and no completion arrived AFTER the
      // failure (asserted by row counts + wake-no-replay below).
      expect(failed).toHaveLength(1)
      expect(completed).toHaveLength(1)
    } else {
      expect(rows).toHaveLength(1)
      expect(rows[0].status).toBe("failed")
      expect(rows[0].kind).toBe("prompt")
      expect(rows[0].last_error).toContain("StructuredOutput input does not match")
      expect(failed).toHaveLength(1)
      expect(settled).toEqual([{ sessionID: id, status: "error" }])
      expect(completed).toHaveLength(0)
      // The original schema error receives exactly one inert correction.
      // Its second schema error fails the same Activity, not a new one.
      expect(requestKinds).toEqual(["generation", "generation"])
      const assistants = (yield* SessionHistory.load(db, id)).filter((message) => message.type === "assistant")
      expect(assistants.map((message) => message.structuredOutputAttempt?.phase)).toEqual(["initial", "correction"])
      expect(assistants[0]?.error).toBeUndefined()
      expect(assistants[1]?.failure?.code).toBe("provider.invalid-response")
    }
    if (mode === "invalid-structured") {
      expect(requests.length).toBe(2)
    } else {
      // Seed completion + padded-turn failure: both settlements observed
      // (listener precedes both admissions). The failed drain's error
      // settlement is the assertion; the seed completion is history.
      expect(settled).toEqual([
        { sessionID: id, status: "completed" },
        { sessionID: id, status: "error" },
      ])
    }

    // Advisory wake without pending input must not replay the provider or
    // overwrite the failed activity with a completion.
    const providerTurns = requests.length
    yield* executionService.wake(id)
    yield* executionService.wait(id)
    expect(requests.length).toBe(providerTurns)
    const after = yield* db.select().from(SessionActivityTable).where(eq(SessionActivityTable.session_id, id)).all()
    if (mode === "empty-summary") {
      expect(after).toHaveLength(2)
      expect(after.filter((row) => row.status === "failed")).toHaveLength(1)
      expect(after.filter((row) => row.status === "completed")).toHaveLength(1)
      // No NEW completion after the failure: completed[] still holds only
      // the seed completion.
      expect(completed).toHaveLength(1)
    } else {
      expect(completed).toHaveLength(0)
      expect(after).toHaveLength(1)
      expect(after[0]).toMatchObject({ status: "failed" })
    }
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(dependencies, projector, execution, access)), Effect.runPromise)
}
