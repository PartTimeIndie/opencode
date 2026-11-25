import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// The production Location runtime must never load developer credentials/plugins.
// Only the loopback provider fixture receives requests; the installed app is untouched.
const modes = [
  "native-history-loopback",
  "native-history-deny",
  "native-capture",
  "native-task",
  "native-task-job",
  "native-task-job-denied",
  "native-task-failed",
  "native-task-interrupted",
  "native-task-active-join",
  "native-task-foreground-join",
  "native-task-background",
  "native-task-fanout",
  "native-task-compacted-fanout",
  "native-task-config-fanout",
  "native-task-chain-drift",
  "native-task-preferences-drift",
  "native-preferences-tool",
  "native-task-parallel",
  "native-task-sdk",
  "native-task-subdir",
  "native-task-placement-provider",
  "native-task-placement-tool-cache",
  "native-task-low-cache",
  "native-task-readonly-cache",
  "native-task-mirror-cache",
  "native-task-unknown-cache",
  "native-task-fresh",
  "native-task-fresh-failed",
  "native-task-fresh-interrupted",
  "native-task-fresh-background",
  "native-task-fresh-fanout",
  "native-task-fresh-readonly-cache",
  "native-task-fresh-mirror-cache",
  "native-task-queued",
  "native-task-fresh-queued",
] as const
for (const mode of modes.filter(
  (value) => !process.env.OPENCODE_ORCHESTRATOR_PROBE || process.env.OPENCODE_ORCHESTRATOR_PROBE === value,
))
  test(`managed child runtime: ${mode}`, async () => {
    if (process.env.OPENCODE_ORCHESTRATOR_PROBE) return probe(mode)
    const root = await mkdtemp(path.join(os.tmpdir(), "opencode-native-task-"))
    const workspace = mode === "native-task-subdir" ? path.join(root, "project", "nested")
       : mode.endsWith("mirror-cache") ? path.join(root, "workspace") : root
    await mkdir(workspace, { recursive: true })
    if (mode === "native-task-subdir") {
      const git = Bun.spawn(["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "init", "-q", "--", path.dirname(workspace)], {
        stdout: "pipe", stderr: "pipe", env: {
          ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_"))),
          GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
        },
      })
      expect(await git.exited, await new Response(git.stderr).text()).toBe(0)
    }
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      cwd: workspace,
      env: {
        ...process.env,
        OPENCODE_ORCHESTRATOR_PROBE: mode,
        OPENCODE_TEST_HOME: root,
        OPENCODE_DB: path.join(root, "test.db"),
        OPENCODE_CONFIG_DIR: path.join(root, "config"),
        OPENCODE_CONFIG: "",
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          ...(mode.endsWith("fanout") ? { multi_agent: { fixture_review: { reviewers: [
            { model: "native-task-fixture/fixture" }, ...(mode === "native-task-config-fanout" ? [] : [{ model: "native-task-fixture/fixture" }]),
          ] } } } : {}),
           permission: { cache_probe: "allow", ...(mode.startsWith("native-task") ? { task: "allow", multi_agent_fanout: "allow" } : {}), ...(mode.endsWith("mirror-cache") ? { edit: "allow" } : {}) },
        }),
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
    const timer = setTimeout(() => child.kill(), 90_000)
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(code, stdout + stderr).toBe(0)
    } finally {
      clearTimeout(timer)
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  }, 120_000)

async function probe(selectedMode: (typeof modes)[number]) {
  const fresh = selectedMode.includes("-fresh")
  const mode = modes.find((value) => value === selectedMode.replace("-fresh", "").replace("-queued", ""))
  if (!mode) throw new Error(`Unknown native runtime mode: ${selectedMode}`)
  // Production startup may attempt optional downloads. This fixture permits only
  // its loopback provider, never model catalogs, binaries or other network access.
  const fetch = globalThis.fetch
  globalThis.fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.hostname !== "127.0.0.1") return Promise.reject(new Error("Offline native task fixture"))
    return fetch(input, init)
  }, fetch)
  const { DateTime, Deferred, Effect, Exit, Layer, Schema, Scope, Stream } = await import("effect")
  const { ToolFailure } = await import("@opencode-ai/llm")
  const { Tool } = await import("@opencode-ai/core/tool/tool")
  const { ToolRegistry } = await import("@opencode-ai/core/tool/registry")
  const { SessionRunnerModel } = await import("@opencode-ai/core/session/runner/model")
  const { eq, desc } = await import("drizzle-orm")
  const { route } = await import("@opencode-ai/llm/protocols/openai-chat")
  const { Catalog } = await import("@opencode-ai/core/catalog")
  const { AgentV2 } = await import("@opencode-ai/core/agent")
  const { ContentStore } = await import("@opencode-ai/core/content-store")
  const { Database } = await import("@opencode-ai/core/database/database")
  const { EventV2 } = await import("@opencode-ai/core/event")
  const { FSUtil } = await import("@opencode-ai/core/fs-util")
  const { Global } = await import("@opencode-ai/core/global")
  const { LocationServiceMap } = await import("@opencode-ai/core/location-layer")
  const { ModelV2 } = await import("@opencode-ai/core/model")
  const { PluginV2 } = await import("@opencode-ai/core/plugin")
  const { PermissionSaved } = await import("@opencode-ai/core/permission/saved")
  const { Project } = await import("@opencode-ai/core/project")
  const { ProjectTable } = await import("@opencode-ai/core/project/sql")
  const { ProviderV2 } = await import("@opencode-ai/core/provider")
  const { AbsolutePath } = await import("@opencode-ai/core/schema")
  const { SessionAccess } = await import("@opencode-ai/core/session/access")
  const { SessionActivity } = await import("@opencode-ai/core/session/activity")
    const { SessionExecution } = await import("@opencode-ai/core/session/execution")
  const { SessionExecutionLocal } = await import("@opencode-ai/core/session/execution/local")
  const { SessionMessage } = await import("@opencode-ai/core/session/message")
  const { SessionEvent } = await import("@opencode-ai/core/session/event")
  const { SessionForkImport } = await import("@opencode-ai/core/session/fork-import")
  const { SessionForkEvent } = await import("@opencode-ai/core/session/fork-event")
  const { PermissionV2 } = await import("@opencode-ai/core/permission")
  const { EventSequenceTable } = await import("@opencode-ai/core/event/sql")
  const { SessionProjector } = await import("@opencode-ai/core/session/projector")
  const { Prompt } = await import("@opencode-ai/core/session/prompt")
  const { SessionRunner } = await import("@opencode-ai/core/session/runner")
  const { SessionSchema } = await import("@opencode-ai/core/session/schema")
  const { SessionStore } = await import("@opencode-ai/core/session/store")
  const { SessionV1 } = await import("@opencode-ai/core/v1/session")
  const { SessionActivityTable, SessionInputTable, SessionMessageTable, SessionTable } =
    await import("@opencode-ai/core/session/sql")

  const database = Database.defaultLayer
  const events = EventV2.layer.pipe(Layer.provide(database))
  const store = SessionStore.layer.pipe(Layer.provide(database))
  const activity = SessionActivity.layer.pipe(Layer.provide(database), Layer.provide(events))
  const locations = LocationServiceMap.layer.pipe(Layer.provide(database), Layer.provide(events), Layer.provide(store))
  const dependencies = Layer.mergeAll(
    database,
    events,
    store,
    activity,
    locations,
    PermissionSaved.layer.pipe(Layer.provide(database)),
  )
  const projector = SessionProjector.layer.pipe(Layer.provide(dependencies))
  const execution = SessionExecutionLocal.layer.pipe(Layer.provide(dependencies))
  const content = ContentStore.layer.pipe(
    Layer.provide(database),
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(Global.layerWith({ data: process.cwd() })),
  )
  const access = SessionAccess.layer.pipe(
    Layer.provide(database),
    Layer.provide(events),
    Layer.provide(store),
    Layer.provide(content),
  )

  await Effect.gen(function* () {
    const { db } = yield* Database.Service
    const locations = yield* LocationServiceMap
    const execution = yield* SessionExecution.Service
    const access = yield* SessionAccess.Service
    const placementRace = mode.includes("native-task-placement-")
    if (placementRace) yield* Effect.promise(async () => {
      for (const name of ["first", "second"]) {
        const git = Bun.spawn(["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "init", "-q", "--", path.join(process.cwd(), name)], {
          stdout: "ignore", stderr: "pipe", env: {
            ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_"))),
            GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
          },
        })
        expect(await git.exited, await new Response(git.stderr).text()).toBe(0)
      }
      await symlink(path.join(process.cwd(), "first"), path.join(process.cwd(), "alias"), process.platform === "win32" ? "junction" : "dir")
    })
    const location = { directory: AbsolutePath.make(placementRace ? path.join(process.cwd(), "alias") : process.cwd()) }
    const retargetPlacement = () => Effect.promise(async () => {
      await rm(location.directory, { recursive: true, force: true })
      await symlink(path.join(process.cwd(), "second"), location.directory, process.platform === "win32" ? "junction" : "dir")
    })
    if (mode === "native-task-mirror-cache")
      yield* Effect.promise(async () => {
        for (const args of [
          ["init"],
          [
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--allow-empty",
            "-m",
            "test: isolated mirror basis",
          ],
        ]) {
          const child = Bun.spawn(["git", "-c", "core.hooksPath=/dev/null", ...args], {
            cwd: location.directory,
            stdout: "pipe",
            stderr: "pipe",
          })
          if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text())
        }
      })
    const mainID = SessionSchema.ID.make("ses_runtime_main")
    const childID = SessionSchema.ID.make("ses_runtime_child")
    const siblingID = SessionSchema.ID.make("ses_runtime_sibling")
    let calls = 0
    let tools = 0
    let beforeHooks = 0
    let exactTaskRetries = 0
    let modelPolicyDrifted = false
    let mainWriteApprovals = 0
    let futureInputID: ReturnType<typeof SessionMessage.ID.create> | undefined
    const captures: { affinity: string | null; sessionID?: string | null; body: string }[] = []
    const toolReceived = yield* Deferred.make<void>()
    const joinedRequest = yield* Deferred.make<void>()
    const releaseJoinedRequest = yield* Deferred.make<void>()
    const foregroundAdmitted = yield* Deferred.make<void>()
    const foregroundResult = yield* Deferred.make<unknown>()
    const fixtureScope = yield* Effect.scope
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch: async (request) => {
            calls++
            if (mode === "native-preferences-tool" || mode === "native-history-loopback" || mode === "native-history-deny" || mode === "native-capture" || mode.startsWith("native-task")) {
              captures.push({ affinity: null, body: await request.text() })
              if (mode === "native-preferences-tool" && calls <= 2)
                return new Response(
                  `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `preferences-${calls}`, type: "function", function: {
                    name: "delegation_preferences", arguments: JSON.stringify(calls === 1
                      ? { operation: "patch", expectedRevision: 0, patch: { ordinaryQuestions: false } }
                      : { operation: "get" }),
                  } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
                  { headers: { "content-type": "text/event-stream" } },
                )
              if (mode === "native-task-foreground-join" && captures.at(-1)?.body.includes("Fixture worker baseline"))
                await Effect.runPromise(Deferred.await(foregroundAdmitted).pipe(Effect.timeout("10 seconds")))
              if (mode === "native-task-active-join" && captures.at(-1)?.body.includes("Fixture worker baseline")) {
                await Effect.runPromise(Deferred.succeed(joinedRequest, undefined))
                await Effect.runPromise(Deferred.await(releaseJoinedRequest))
              }
              if (mode.startsWith("native-task") && calls === 3)
                return new Response(
                  `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", tool_calls: Array.from({ length: mode.endsWith("parallel") ? 2 : 1 }, (_, index) => ({ index, id: `native_real_task${index ? "_sibling" : ""}`, type: "function", function: {
                    name: mode.endsWith("fanout") ? "multi_agent_fanout" : "task", arguments: JSON.stringify(mode.endsWith("fanout")
                       ? { workflow: "fixture-review", prompt: "Child fixture assignment", ...(fresh ? { context: "fresh" } : {}) }
                       : { description: "Check source history", prompt: "Child fixture assignment", subagent_type: "fixture-worker", ...(fresh ? { context: "fresh" } : {}), ...(mode === "native-task-readonly-cache" ? { workspace: "readonly" } : mode === "native-task-mirror-cache" ? {} : { workspace: "main" }), ...(mode.endsWith("background") || mode.endsWith("active-join") ? { background: true } : {}) }),
                  } })) }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
                  { headers: { "content-type": "text/event-stream" } },
                )
              if (mode === "native-task-failed" && calls === 4)
                return Response.json({ error: { message: "Fixture terminal invalid request", type: "invalid_request_error" } }, { status: 400 })
              if (mode.startsWith("native-task") && mode.endsWith("cache") && calls === 4 && captures.at(-1)?.body.includes("Fixture worker baseline"))
                return new Response(
                  `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "native_cache_probe", type: "function", function: mode === "native-task-mirror-cache"
                       ? { name: "apply_patch", arguments: JSON.stringify({
                           patchText: "*** Begin Patch\n*** Add File: native-child.txt\n+Private native child\n*** End Patch",
                           expectedStates: { "native-child.txt": { exists: false } },
                         }) }
                      : { name: "cache_probe", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
                    ...(mode.endsWith("low-cache") ? { usage: { prompt_tokens: 100, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0 } } } : {}),
                  })}\n\ndata: [DONE]\n\n`,
                  { headers: { "content-type": "text/event-stream" } },
                )
              if (mode.endsWith("fanout") && captures.at(-1)?.body.includes("Fixture worker baseline"))
                return new Response(
                  `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `structured-${calls}`, type: "function", function: { name: "StructuredOutput", arguments: JSON.stringify({ answer: "done" }) } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
                  { headers: { "content-type": "text/event-stream" } },
                )
              if (mode === "native-capture" && calls === 1)
                return new Response(
                  'data: {"id":"fixture","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"native_dispatch","type":"function","function":{"name":"task","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n',
                  { headers: { "content-type": "text/event-stream" } },
                )
              if (mode === "native-history-deny" && calls === 1)
                return new Response(
                  'data: {"id":"fixture","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"denied_call","type":"function","function":{"name":"cache_probe","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n',
                  { headers: { "content-type": "text/event-stream" } },
                )
              return new Response(
                'data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"Finished"},"finish_reason":null}]}\n\n' +
                  'data: {"id":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
                { headers: { "content-type": "text/event-stream" } },
              )
            }
            throw new Error(`Unexpected native runtime fixture mode: ${mode}`)
          },
        }),
      ),
      (server) => Effect.promise(() => server.stop(true)),
    )
    const configure = (placement: typeof location) =>
      Effect.gen(function* () {
        const plugins = yield* PluginV2.Service
        yield* plugins.add({
          id: PluginV2.ID.make("native-task-fixture"),
          effect: Effect.succeed({
            "chat.headers": (output) =>
              Effect.gen(function* () {
                if (mode === "native-task-placement-provider" && output.agent === "fixture-worker")
                  yield* retargetPlacement()
              }),
            "tool.execute.before": (input) =>
              Effect.gen(function* () {
                beforeHooks++
                if (selectedMode.endsWith("-queued") && input.tool === "task" && !futureInputID) {
                  const { SessionInput } = yield* Effect.promise(() => import("@opencode-ai/core/session/input"))
                  const queued = yield* SessionInput.admit(db, events, { id: SessionMessage.ID.create(), sessionID: mainID,
                    prompt: new Prompt({ text: "Future queue assignment must not reach the child" }), delivery: "queue" })
                  futureInputID = queued.id
                }
                if (mode === "native-task-placement-tool-cache" && input.tool === "cache_probe")
                  yield* retargetPlacement()
              }).pipe(Effect.orDie),
            "tool.execute.after": (input) => Effect.gen(function* () {
              if (input.tool !== "task" || !["native-task", "native-task-failed", "native-task-interrupted", "native-task-active-join", "native-task-mirror-cache"].includes(mode)) return
              if (mode === "native-task-active-join")
                yield* Deferred.await(joinedRequest).pipe(Effect.timeout("10 seconds"))
              // The real call is still running and privately owned here. Repeat
              // its full production admission/execution, not just wake/wait.
              const rows = yield* db.select().from(SessionMessageTable)
                .where(eq(SessionMessageTable.session_id, input.sessionID)).orderBy(desc(SessionMessageTable.seq)).all()
              const assistant = rows.find((row) => {
                const message = Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type })
                return message.type === "assistant" && message.content.some((part) => part.type === "tool" && part.id === input.callID)
              })
              if (!assistant) return yield* Effect.die("Missing running task assistant")
              const child = yield* db.select().from(SessionTable).where(eq(SessionTable.agent, "fixture-worker")).get()
              if (!child) return yield* Effect.die("Missing child for exact task retry")
              const beforeRequests = calls
              const activities = yield* db.select().from(SessionActivityTable).where(eq(SessionActivityTable.session_id, child.id)).all()
              const materialized = yield* registry.materialize(undefined, undefined, { sessionID: input.sessionID, agent: AgentV2.ID.make("build") })
              yield* Effect.forEach([0, 1], () => Effect.gen(function* () {
                const retry = yield* materialized.settle({ sessionID: input.sessionID, agent: AgentV2.ID.make("build"),
                  assistantMessageID: SessionMessage.ID.make(assistant.id),
                  call: { type: "tool-call", id: input.callID, name: "task", input: input.args } })
                if (mode === "native-task-active-join")
                  expect(retry.output?.structured).toMatchObject({ sessionID: child.id, task_id: child.id, state: "running", next_action: "wait" })
                else expect(retry.result).toEqual(input.result)
                exactTaskRetries++
              }))
              expect(calls).toBe(beforeRequests)
              expect(yield* db.select().from(SessionActivityTable).where(eq(SessionActivityTable.session_id, child.id)).all()).toEqual(activities)
              expect(yield* db.select().from(SessionTable).where(eq(SessionTable.agent, "fixture-worker")).all()).toHaveLength(1)
              if (futureInputID) {
                const { SessionInput } = yield* Effect.promise(() => import("@opencode-ai/core/session/input"))
                expect((yield* SessionInput.find(db, futureInputID))?.promotedSeq).toBeUndefined()
                // Hold only after dispatch/retries so the fixture can inspect
                // future work without asking its provider to run another activity.
                yield* SessionInput.holdPending(db, events, mainID)
              }
              if (mode === "native-task-active-join") yield* Deferred.succeed(releaseJoinedRequest, undefined)
            }).pipe(Effect.orDie),
          }),
          nativeModels: {
            "native-task-fixture": {
              resolve: async (input) => {
                const resolved = await (async () => {
                   if (mode !== "native-task-sdk")
                    return {
                      id: input.model.id,
                      provider: input.model.providerID,
                      route: route.with({
                        endpoint: {
                          baseURL: `http://127.0.0.1:${server.port}/v1`,
                        },
                        limits: { context: 1_000_000, output: 128 },
                      }),
                    }
                  const { createOpenAI } = await import("@ai-sdk/openai")
                  const sdk = createOpenAI({
                    apiKey: "fixture-not-a-secret",
                    baseURL: `http://127.0.0.1:${server.port}/v1`,
                  })
                  return SessionRunnerModel.fromAISDKModel(
                    Schema.decodeUnknownSync(ModelV2.Info)(input.model),
                    sdk.chat("fixture"),
                  )
                })()
                const configured = resolved.route
                return {
                  ...resolved,
                  route: {
                    ...configured,
                    streamPrepared: (...args: Parameters<typeof configured.streamPrepared>) =>
                       (mode === "native-task-interrupted" && args[1].system.some((part) => part.text.includes("Fixture worker baseline")))
                        ? Stream.fromEffect(Effect.interrupt)
                        : configured.streamPrepared(args[0], args[1], args[2]).pipe(
                            Stream.tap((event) => {
                              return event.type === "tool-call" || event.type === "tool-input-delta"
                                ? Deferred.succeed(toolReceived, undefined)
                                : Effect.void
                            }),
                          ),
                  },
                }
              },
            },
          },
        })
        const registry = yield* ToolRegistry.Service
        if (mode === "native-preferences-tool") {
          const agents = yield* AgentV2.Service
          const transform = yield* agents.transform()
          yield* transform((editor) => editor.update(AgentV2.ID.make("build"), (agent) => {
            agent.permissions = [...agent.permissions, { action: "delegation_preferences", resource: "*", effect: "allow" }]
            agent.tools = { mode: "explicit", entries: { delegation_preferences: { visible: true, permission: "allow" } } }
          }))
        }
        if (mode.startsWith("native-task")) {
          const agents = yield* AgentV2.Service
          const transform = yield* agents.transform()
          yield* transform((editor) => {
            editor.update(AgentV2.ID.make("build"), (agent) => {
              agent.system = "Fixture parent-only baseline"
              if (mode.endsWith("cache")) agent.permissions = [...agent.permissions, { action: "cache_probe", resource: "*", effect: "allow" }]
              agent.tools = { mode: "explicit", entries: { task: { visible: true, permission: "allow" }, multi_agent_fanout: { visible: true, permission: "allow" },
                ...(mode.endsWith("cache") ? { cache_probe: { visible: true, permission: "allow" as const } } : {}),
                ...(mode === "native-task-mirror-cache" ? { apply_patch: { visible: true, permission: "allow" as const } } : {}),
              } }
            })
            editor.update(AgentV2.ID.make("fixture-worker"), (agent) => {
              agent.mode = "subagent"
              agent.system = "Fixture worker baseline"
              if (mode === "native-task-chain-drift") agent.model = {
                id: ModelV2.ID.make("fixture"), providerID: ProviderV2.ID.make("native-task-fixture"),
                chain: { id: "fixture-chain", name: "Fixture chain", active: 0,
                  steps: [{ id: ModelV2.ID.make("fixture"), providerID: ProviderV2.ID.make("native-task-fixture") },
                    { id: ModelV2.ID.make("fixture"), providerID: ProviderV2.ID.make("native-task-fixture") }] },
              }
              if (mode.endsWith("cache")) agent.permissions = [...agent.permissions, { action: "cache_probe", resource: "*", effect: "allow" }]
            })
          })
          if (mode.endsWith("fanout")) {
            const { FanoutWorkflow } = yield* Effect.promise(() => import("@opencode-ai/core/fanout-workflow"))
            const workflows = yield* FanoutWorkflow.Service
            yield* workflows.register("fixture", {
              id: "fixture-review", configKey: "fixture_review", agentID: "fixture-worker", tools: [], commands: [],
              resultSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
            })
          }
        }
        if (mode === "native-capture") {
          const forkContent = yield* ContentStore.Service.pipe(Effect.provide(content))
          const forkEvents = yield* EventV2.Service
          const agents = yield* AgentV2.Service
          const transform = yield* agents.transform()
          yield* transform((editor) => {
            editor.update(AgentV2.ID.make("build"), (agent) => {
              agent.system = "Native parent baseline marker"
              agent.tools = { mode: "explicit", entries: { task: { visible: true, permission: "allow" } } }
            })
            editor.update(AgentV2.ID.make("plan"), (agent) => { agent.system = "Native child baseline marker" })
          })
          // Test-only task implementation exercises the real running-call capture
          // and import seam; it is not the production TaskTool admission path.
          yield* registry.register({ task: Tool.make({
            description: "Exercise the running task capture boundary",
            input: Schema.Struct({}),
            output: Schema.Struct({ ok: Schema.Boolean }),
            execute: (_, context) => Effect.gen(function* () {
              const fence = yield* db.select().from(EventSequenceTable)
                .where(eq(EventSequenceTable.aggregate_id, mainID)).get()
              if (!fence) return yield* Effect.die("Missing live dispatch event fence")
              const prepared = yield* SessionForkImport.prepare(db, forkContent, {
                sourceSessionID: mainID, childSessionID: childID, throughSeq: fence.seq,
                dispatch: { assistantMessageID: context.assistantMessageID, toolCallID: context.toolCallID },
              })
              yield* SessionForkImport.materialize(db, forkEvents, prepared)
              yield* access.send({ sessionID: childID, prompt: new Prompt({ text: "Child fixture assignment" }), delivery: "steer" })
              yield* execution.wait(childID)
              return { ok: true }
            }).pipe(Effect.orDie),
          }) })
        }
        if (mode === "native-history-loopback" || mode === "native-history-deny") {
          const agents = yield* AgentV2.Service
          const transform = yield* agents.transform()
          yield* transform((editor) => {
            editor.update(AgentV2.ID.make("build"), (agent) => { agent.system = "Child-only baseline marker" })
            editor.update(AgentV2.ID.make("plan"), (agent) => { agent.system = "Parent-only baseline marker" })
          })
        }
        const toolPermission = yield* PermissionV2.Service
        yield* registry.register({
          cache_probe: Tool.make({
            description: "Isolated cache gate execution probe",
            input: Schema.Struct({}),
            output: Schema.Struct({ ok: Schema.Boolean }),
            execute: (_, context) =>
              Effect.gen(function* () {
                if (mode === "native-history-deny" || (mode.startsWith("native-task") && mode.endsWith("cache")))
                  yield* toolPermission.assert({
                    action: "cache_probe", resources: ["fixture"], save: ["*"],
                    sessionID: context.sessionID, agent: context.agent,
                    source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                  }).pipe(Effect.mapError(() => new ToolFailure({ message: "Permission denied: cache_probe" })))
                tools++
                return { ok: true }
              }),
          }),
        })
        const catalog = yield* Catalog.Service
        const transform = yield* catalog.transform()
        yield* transform((editor) => {
          editor.provider.update(ProviderV2.ID.make("native-task-fixture"), (provider) => {
            provider.api = { type: "aisdk", package: "native-task-fixture", url: `http://127.0.0.1:${server.port}/v1` }
          })
          editor.model.update(ProviderV2.ID.make("native-task-fixture"), ModelV2.ID.make("fixture"), (model) => {
            model.api = {
              id: ModelV2.ID.make("fixture"),
              type: "aisdk",
              package: "native-task-fixture",
              url: `http://127.0.0.1:${server.port}/v1`,
            }
            model.capabilities.tools = true
            model.capabilities.input = ["text/plain"]
            model.capabilities.output = ["text/plain"]
            model.limit.context = 1_000_000
            model.limit.output = 128
            model.cost = [{ input: 1, output: 2, cache: { read: 0.25, write: 0.5 } }]
          })
        })
      }).pipe(Effect.provide(locations.get(placement)))
    yield* configure(location)
    if (mode === "native-task-mirror-cache") {
      const events = yield* EventV2.Service
      const context = yield* Effect.context<import("effect").Effect.Services<ReturnType<typeof configure>>>()
      const remove = yield* events.listen((event) => {
        if (event.type !== SessionV1.Event.Created.type) return Effect.void
        const created = Schema.decodeUnknownSync(
          Schema.Struct({
            info: Schema.Struct({ parentID: Schema.optional(Schema.String), directory: Schema.String }),
          }),
        )(event.data)
        return created.info.parentID === mainID
          ? configure({ directory: AbsolutePath.make(created.info.directory) }).pipe(
              Effect.provide(context),
              Effect.orDie,
            )
          : Effect.void
      })
      yield* Effect.addFinalizer(() => remove)
    }
    yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: location.directory, sandboxes: [] }).run()
    for (const id of [mainID, childID, siblingID])
      yield* db
        .insert(SessionTable)
        .values({
          id,
          parent_id: id === childID ? mainID : null,
          project_id: Project.ID.global,
          directory: location.directory,
          slug: id,
          title: "native-task-runtime",
          version: "test",
          agent: "build",
          model: { providerID: "native-task-fixture", id: "fixture" },
        })
        .run()
    let settled = 0
    const failures: unknown[] = []
    const events = yield* EventV2.Service
    if (["native-task-chain-drift", "native-task-config-fanout", "native-task-preferences-drift"].includes(mode))
      yield* events.beforeCommit((event) => Effect.gen(function* () {
        if (event.type !== "session.next.fork.history-boundary-imported") return
        modelPolicyDrifted = true
        if (mode === "native-task-chain-drift") {
          const agents = yield* AgentV2.Service
          yield* agents.update((editor) => editor.update(AgentV2.ID.make("fixture-worker"), (agent) => {
            agent.model = { id: ModelV2.ID.make("fixture"), providerID: ProviderV2.ID.make("native-task-fixture"),
              chain: { id: "fixture-chain", name: "Fixture chain", active: 0,
                steps: [{ id: ModelV2.ID.make("fixture"), providerID: ProviderV2.ID.make("native-task-fixture") },
                  { id: ModelV2.ID.make("changed-fallback"), providerID: ProviderV2.ID.make("native-task-fixture") }] } }
          }))
        }
        if (mode === "native-task-config-fanout") {
          const before = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))(process.env.OPENCODE_CONFIG_CONTENT ?? "{}")
          process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...before, multi_agent: { fixture_review: { reviewers: [] } } })
        }
        if (mode === "native-task-preferences-drift") {
          const before = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))(process.env.OPENCODE_CONFIG_CONTENT ?? "{}")
          process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...before,
            delegation: { rules: [{ allowed: [{ agent: "not-the-fixture-worker" }] }] } })
        }
      }).pipe(Effect.provide(locations.get(location)), Effect.provideService(Scope.Scope, fixtureScope)))
    let foregroundRetryStarted = false
    const unsubscribe = yield* events.listen((event) => {
      if (mode.startsWith("native-task") && event.type === PermissionV2.Event.Asked.type) {
        const request = Schema.decodeUnknownSync(PermissionV2.Request)(event.data)
        if (mode === "native-task-mirror-cache" && request.action === "edit") return Effect.gen(function* () {
          const child = yield* db.select({ directory: SessionTable.directory }).from(SessionTable)
            .where(eq(SessionTable.id, request.sessionID)).get().pipe(Effect.orDie)
          if (!child || child.directory === location.directory) return yield* Effect.die("Expected private child file approval")
          yield* PermissionV2.Service.use((permission) => permission.reply({ requestID: request.id, reply: "once" }))
            .pipe(Effect.provide(locations.get({ directory: AbsolutePath.make(child.directory) })))
        }).pipe(Effect.orDie, Effect.forkIn(fixtureScope), Effect.asVoid)
        if (request.action === "task_main_write") return Effect.gen(function* () {
          // This isolated fixture simulates the host click through the REAL
          // Permission owner. It is not installed or live human acceptance.
          expect(request.metadata?.[PermissionV2.SINGLE_USE_METADATA_KEY]).toBe(true)
          const permission = yield* PermissionV2.Service
          const reply = mode === "native-task-job-denied" ? "reject" : "once"
          yield* permission.reply({ requestID: request.id, reply })
          if (reply === "once") mainWriteApprovals++
        }).pipe(Effect.provide(locations.get(location)), Effect.orDie, Effect.forkIn(fixtureScope), Effect.asVoid)
      }
      if (event.type === "session.next.step.failed") failures.push(event.data)
      if (event.type === SessionRunner.Settled.type) settled++
      if (mode !== "native-task-foreground-join" || foregroundRetryStarted ||
        event.type !== SessionEvent.Tool.Progress.type) return Effect.void
      const progress = Schema.decodeUnknownSync(Schema.toType(SessionEvent.Tool.Progress.data))(event.data)
      if (progress.sessionID !== mainID) return Effect.void
      foregroundRetryStarted = true
      // The subscriber inherits the real current execution scope. The replay
      // remains an ordinary production TaskTool call, not a borrowed lease.
      return Effect.gen(function* () {
        const row = yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, progress.assistantMessageID)).get()
        if (!row) return yield* Effect.die("Missing foreground task message")
        const message = Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type })
        if (message.type !== "assistant") return yield* Effect.die("Expected foreground task assistant")
        const tool = message.content.find((part) => part.type === "tool" && part.id === progress.callID)
        if (!tool || tool.type !== "tool" || tool.state.status !== "running") return yield* Effect.die("Expected running foreground task")
        const registry = yield* ToolRegistry.Service
        const materialized = yield* registry.materialize(undefined, undefined, { sessionID: mainID, agent: AgentV2.ID.make("build") })
        const result = yield* materialized.settle({ sessionID: mainID, agent: AgentV2.ID.make("build"),
          assistantMessageID: progress.assistantMessageID,
          call: { type: "tool-call", id: progress.callID, name: "task", input: tool.state.input },
          progress: () => Deferred.succeed(foregroundAdmitted, undefined).pipe(Effect.asVoid),
        })
        yield* Deferred.succeed(foregroundResult, result.output?.structured ?? result.result)
      }).pipe(Effect.provide(locations.get(location)), Effect.orDie, Effect.forkIn(fixtureScope), Effect.asVoid)
    })
    yield* Effect.addFinalizer(() => unsubscribe)
    if (mode === "native-preferences-tool") {
      yield* access.send({ sessionID: mainID, prompt: new Prompt({ text: "Disable ordinary questions only in this Session, then read the saved scope" }), delivery: "steer" })
      yield* execution.wait(mainID)
      const { DelegationPreferences } = yield* Effect.promise(() => import("@opencode-ai/core/session/delegation-preferences"))
      const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, mainID)).get()
      expect(row?.metadata?.[DelegationPreferences.METADATA_KEY]).toMatchObject({ revision: 1, session: { ordinaryQuestions: false }, tasks: {} })
      expect(calls).toBe(3)
      expect(failures).toEqual([])
      expect(captures[0]?.body).toContain('"name":"delegation_preferences"')
      expect(captures[2]?.body).toContain('ordinaryQuestions')
      expect(captures[2]?.body).toContain('session')
      expect(mainWriteApprovals).toBe(0)
      return
    }
    if (mode.startsWith("native-task")) {
      if (mode === "native-task-job" || mode === "native-task-job-denied") {
        // A bound host job drives the real subtask → TaskTool → consent → Main
        // child path without any model-selected dispatch in the host Session.
        const { NativeJob } = yield* Effect.promise(() => import("@opencode-ai/core/session/native-job"))
        const job = { version: 1 as const, binding: "a".repeat(64), attempt: 1, title: "Native job fixture",
          prompt: "Child fixture assignment", agent: "fixture-worker" }
        const binding = { checkout: location.directory, binding: job.binding, attempt: 1 }
        const bridge = yield* NativeJob.Bridge.pipe(Effect.provide(locations.get(location)))
        expect(yield* Effect.promise(() => bridge.observe(binding))).toEqual({ state: "missing" })
        const dispatched = yield* Effect.promise(() => bridge.dispatch({ checkout: location.directory, job }))
        expect(dispatched.created).toBe(true)
        expect(yield* NativeJob.observe(locations, binding)).toMatchObject({ hostSessionID: dispatched.hostSessionID })
        const retry = yield* Effect.promise(() => bridge.dispatch({ checkout: location.directory, job }))
        expect(retry).toMatchObject({ created: false, hostSessionID: dispatched.hostSessionID, inputID: dispatched.inputID })
        // A declined consent fails the host activity; the wait reports that failure.
        // A declined consent lets the drain die; the waiter observes that Exit
        // instead of treating the defect as a crash of this fixture.
        yield* execution.wait(dispatched.hostSessionID).pipe(mode === "native-task-job-denied" ? Effect.exit : Effect.asVoid)
        const observation = yield* NativeJob.observe(locations, binding)
        if (mode === "native-task-job-denied") {
          // Declined single-use consent: the finished host input carries the
          // tool error and no child, input or Main write was ever admitted.
          expect(observation).toMatchObject({ state: "terminal", status: "failed", tool: { status: "error", error: expect.stringContaining("DeclinedError") } })
          if (observation.state !== "terminal") return yield* Effect.die("Missing terminal declined observation")
          expect(String(observation.lastError)).toContain("Declined")
          expect((yield* db.select().from(SessionTable).where(eq(SessionTable.parent_id, dispatched.hostSessionID)).all())).toEqual([])
          expect((yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.session_id, dispatched.hostSessionID)).all())).toHaveLength(1)
          expect(mainWriteApprovals).toBe(0)
          return
        }
        expect(observation).toMatchObject({ state: "terminal", status: "completed", inputID: dispatched.inputID,
          tool: { status: "completed", report: expect.stringContaining("Finished") } })
        if (observation.state !== "terminal" || !observation.child) return yield* Effect.die("Missing bound native child")
        const child = yield* db.select().from(SessionTable).where(eq(SessionTable.id, observation.child.sessionID)).get()
        expect(child?.directory).toBe(location.directory)
        expect(child?.parent_id).toBe(dispatched.hostSessionID)
        expect(child?.fork_dispatch_digest).toBe(observation.child.dispatchDigest)
        expect(child?.agent_policy?.mainWriteConsent).toMatchObject({ inputID: observation.child.inputID,
          dispatchDigest: observation.child.dispatchDigest, placementIdentity: observation.child.placementIdentity })
        expect((yield* db.select().from(SessionTable).where(eq(SessionTable.parent_id, dispatched.hostSessionID)).all())).toHaveLength(1)
        expect((yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.session_id, dispatched.hostSessionID)).all())).toHaveLength(1)
        expect((yield* db.select().from(SessionActivityTable).where(eq(SessionActivityTable.session_id, dispatched.hostSessionID)).all())).toHaveLength(1)
        expect(mainWriteApprovals).toBe(1)
        expect(failures).toEqual([])
        // Another attempt or binding never observes this finished input.
        expect(yield* NativeJob.observe(locations, { ...binding, attempt: 2 })).toEqual({ state: "missing" })
        expect(yield* NativeJob.observe(locations, { ...binding, binding: "b".repeat(64) })).toEqual({ state: "missing" })
        expect((yield* db.select().from(SessionTable).where(eq(SessionTable.directory, location.directory)).all()).map((row) => row.id).sort())
          .toEqual([dispatched.hostSessionID, childID, mainID, observation.child.sessionID, siblingID].sort())
        return
      }
      yield* access.send({ sessionID: mainID, prompt: new Prompt({ text: "Earlier parent evidence" }), delivery: "steer" })
      yield* execution.wait(mainID)
      // The real TaskTool must inherit exactly the runner's current compacted
      // work, not resurrect earlier raw dialogue or add a task-only summary.
      for (const [index, summary] of ["Superseded parent summary", "Current compacted parent evidence"].entries()) {
        yield* events.publish(SessionEvent.ContextUpdated, { sessionID: mainID,
          messageID: SessionMessage.ID.make(`msg_native_update_${index}`), timestamp: DateTime.makeUnsafe(Date.now()),
          text: `Parent chronological update ${index}` })
        const messageID = SessionMessage.ID.make(`msg_native_compaction_${index}`)
        yield* events.publish(SessionEvent.Compaction.Started, { sessionID: mainID, messageID,
          timestamp: DateTime.makeUnsafe(Date.now()), reason: "manual" })
        yield* events.publish(SessionEvent.Compaction.Ended, { sessionID: mainID, messageID,
          timestamp: DateTime.makeUnsafe(Date.now()), reason: "manual", text: summary, recent: "" })
      }
      yield* events.publish(SessionEvent.ContextUpdated, { sessionID: mainID,
        messageID: SessionMessage.ID.make("msg_native_update_after"), timestamp: DateTime.makeUnsafe(Date.now()),
        text: "Parent chronological update after compactions" })
      yield* access.send({ sessionID: mainID, prompt: new Prompt({ text: "Recent post-compaction evidence" }), delivery: "steer" })
      yield* execution.wait(mainID)
      if (mode === "native-task-compacted-fanout") {
        const { SessionInput } = yield* Effect.promise(() => import("@opencode-ai/core/session/input"))
        // Promote the actual assignment, then compact it out before the real
        // coordinator starts dispatch. No new User follows the compaction.
        yield* SessionInput.admit(db, events, { id: SessionMessage.ID.make("msg_compacted_dispatch_input"),
          sessionID: mainID, prompt: new Prompt({ text: "Parent dispatch instruction" }), delivery: "steer" })
        yield* SessionInput.promoteSteers(db, events, mainID, Number.MAX_SAFE_INTEGER)
        const messageID = SessionMessage.ID.make("msg_compacted_dispatch_context")
        yield* events.publish(SessionEvent.Compaction.Started, { sessionID: mainID, messageID,
          timestamp: DateTime.makeUnsafe(Date.now()), reason: "manual" })
        yield* events.publish(SessionEvent.Compaction.Ended, { sessionID: mainID, messageID,
          timestamp: DateTime.makeUnsafe(Date.now()), reason: "manual", text: "Dispatch compacted evidence", recent: "" })
        yield* execution.resume(mainID)
      } else {
        yield* access.send({ sessionID: mainID, prompt: new Prompt({ text: "Parent dispatch instruction" }), delivery: "steer" })
      }
      yield* execution.wait(mainID)
      expect(mainWriteApprovals).toBe(mode === "native-task-readonly-cache" || mode === "native-task-mirror-cache" || mode.endsWith("fanout") ? 0 : mode === "native-task-parallel" ? 2 : 1)
      if (["native-task-chain-drift", "native-task-config-fanout", "native-task-preferences-drift"].includes(mode)) {
        expect(modelPolicyDrifted).toBe(true)
        expect(yield* db.select().from(SessionTable).where(eq(SessionTable.agent, "fixture-worker")).all()).toHaveLength(0)
        expect(captures.some((capture) => capture.body.includes("Fixture worker baseline"))).toBe(false)
        expect(tools).toBe(0)
        expect(calls).toBe(4)
        expect(captures.at(-1)?.body).toContain(mode === "native-task-preferences-drift"
          ? "Task selection conflicts with binding delegation rules: OPENCODE_CONFIG_CONTENT"
          : mode === "native-task-config-fanout"
            ? "policy changed while the task was being prepared (extraModels[0])"
            : "model selection changed while the task was being prepared")
        return
      }
      if (mode.endsWith("background") || mode.endsWith("active-join")) {
        const { TaskJob } = yield* Effect.promise(() => import("@opencode-ai/core/tool/task-job"))
        const spawned = yield* db.select().from(SessionTable).where(eq(SessionTable.agent, "fixture-worker")).get()
        if (!spawned) return yield* Effect.die("Missing background task child")
        const job = yield* TaskJob.Service.use((jobs) => jobs.wait(spawned.id)).pipe(Effect.provide(locations.get(location)))
        expect(job.info?.status).toBe("completed")
      }
      if (placementRace) {
        const spawned = yield* db.select().from(SessionTable).where(eq(SessionTable.agent, "fixture-worker")).get()
        if (!spawned) return yield* Effect.die("Missing placement-bound task child")
        expect(spawned.agent_policy?.executionPlacement).toBeDefined()
        expect(tools).toBe(0)
        expect(captures.filter((capture) => capture.body.includes("Fixture worker baseline"))).toHaveLength(mode.endsWith("provider") ? 0 : 1)
        const requests = calls
        const settledBefore = settled
        const direct = yield* SessionRunner.Service.use((runner) => runner.run({ sessionID: spawned.id }))
          .pipe(Effect.provide(locations.get(location)), Effect.exit)
        expect(Exit.isFailure(direct)).toBe(true)
        expect(calls).toBe(requests)
        expect(settled).toBe(settledBefore)
        const { WorkspaceCheckout } = yield* Effect.promise(() => import("@opencode-ai/core/session/workspace/checkout"))
        const guarded = yield* WorkspaceCheckout.assertSession(db, spawned.id).pipe(Effect.exit)
        expect(Exit.isFailure(guarded)).toBe(true)
        return
      }
      if (mode === "native-task-foreground-join") {
        expect(foregroundRetryStarted).toBe(true)
        const children = yield* db.select().from(SessionTable).where(eq(SessionTable.agent, "fixture-worker")).all()
        expect(children).toHaveLength(1)
        const child = children[0]
        if (!child) return yield* Effect.die("Missing foreground joined child")
        expect(yield* Deferred.await(foregroundResult).pipe(Effect.timeout("10 seconds")))
          .toMatchObject({ sessionID: child.id, state: "completed" })
        expect(yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.session_id, child.id)).all()).toHaveLength(1)
        expect(yield* db.select().from(SessionActivityTable).where(eq(SessionActivityTable.session_id, child.id)).all()).toHaveLength(1)
      }
      if (mode === "native-task-failed") expect(failures.length).toBeGreaterThan(0)
      if (mode !== "native-task-failed") expect(failures).toEqual([])
      if (mode === "native-task-compacted-fanout") {
        expect(calls, captures.at(-1)?.body.slice(-6000)).toBe(6)
        const children = captures.filter((capture) => capture.body.includes("Fixture worker baseline"))
        expect(children).toHaveLength(2)
        for (const capture of children) {
          expect(capture.body).toContain("Dispatch compacted evidence")
          expect(capture.body).not.toContain("Parent dispatch instruction")
          expect(capture.body).not.toContain("Recent post-compaction evidence")
          expect(capture.body).not.toContain("native_real_task")
        }
        const final = JSON.parse(captures.at(-1)!.body)
        const outputs = final.messages.filter((message: { role: string }) => message.role === "tool")
        expect(outputs).toHaveLength(1)
        const collected = JSON.parse(outputs[0].content)
        expect(collected.results.map((result: { status: string }) => result.status)).toEqual(["success", "success"])
        expect(new Set(collected.results.map((result: { sessionID: string }) => result.sessionID)).size).toBe(2)
        return
      }
      if (["native-task", "native-task-failed", "native-task-interrupted", "native-task-active-join", "native-task-mirror-cache"].includes(mode)) {
        expect(exactTaskRetries).toBe(2)
        const { TaskTool } = yield* Effect.promise(() => import("@opencode-ai/core/tool/task"))
        const { SessionInput } = yield* Effect.promise(() => import("@opencode-ai/core/session/input"))
        const spawned = yield* db.select().from(SessionTable).where(eq(SessionTable.agent, "fixture-worker")).get()
        if (!spawned) return yield* Effect.die("Missing retry task child")
        const row = yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.session_id, spawned.id)).get()
        if (!row) return yield* Effect.die("Missing admitted task input")
        const admitted = yield* SessionInput.find(db, SessionMessage.ID.make(row.id))
        if (!admitted) return yield* Effect.die("Missing task admission")
        const beforeRetry = calls
        const activities = yield* db.select().from(SessionActivityTable).where(eq(SessionActivityTable.session_id, spawned.id)).all()
        const settledBefore = settled
        const hooksBefore = beforeHooks
        // A valid saved placement is not a private live execution owner. Reject
        // a direct runner before any title/settlement/provider/tool side effect.
        const direct = yield* SessionRunner.Service.use((runner) => runner.run({ sessionID: spawned.id, force: true }))
          .pipe(Effect.provide(locations.get(location)), Effect.exit)
        expect(Exit.isFailure(direct)).toBe(true)
        expect(settled).toBe(settledBefore)
        expect(beforeHooks).toBe(hooksBefore)
        expect(calls).toBe(beforeRetry)
        yield* TaskTool.runAdmitted(execution, admitted)
        yield* TaskTool.runAdmitted(execution, admitted)
        expect(calls).toBe(beforeRetry)
        expect(yield* db.select().from(SessionActivityTable).where(eq(SessionActivityTable.session_id, spawned.id)).all()).toEqual(activities)
      }
      if (mode === "native-task-interrupted") {
        expect(calls).toBe(4)
        expect(tools).toBe(0)
        expect(captures.some((capture) => capture.body.includes("Fixture worker baseline"))).toBe(false)
        const spawned = yield* db.select().from(SessionTable).where(eq(SessionTable.agent, "fixture-worker")).get()
        if (!spawned) return yield* Effect.die("Missing interrupted child")
        expect(spawned.agent_policy?.taskContext).toBe(fresh ? "fresh" : "fork")
        const activities = yield* db.select().from(SessionActivityTable).where(eq(SessionActivityTable.session_id, spawned.id)).all()
        expect(activities).toHaveLength(1)
        expect(activities[0]?.status).toBe("interrupted")
        return
      }
      expect(calls, captures.at(-1)?.body.slice(-6000)).toBe(mode.endsWith("fanout") || mode.endsWith("parallel") || mode.endsWith("cache") ? 6 : 5)
      if (mode.endsWith("cache")) {
        expect(tools).toBe(mode === "native-task-readonly-cache" || mode === "native-task-mirror-cache" ? 0 : 1)
        expect(captures.filter((capture) => capture.body.includes("Fixture worker baseline"))).toHaveLength(2)
      }
      if (mode === "native-task-mirror-cache") {
        const spawned = yield* db.select().from(SessionTable).where(eq(SessionTable.agent, "fixture-worker")).get()
        if (!spawned) return yield* Effect.die("Missing native mirror child")
        expect(spawned.directory).not.toBe(location.directory)
        expect(spawned.agent_policy?.mirrorWorkspace?.taskID).toBe(spawned.id)
        expect(spawned.agent_policy?.mainWriteConsent).toBeUndefined()
        const written = Bun.file(path.join(spawned.directory, "native-child.txt"))
        const request = JSON.parse(captures.filter((capture) => capture.body.includes("Fixture worker baseline")).at(-1)?.body ?? "{}")
        const writeResult = request.messages?.find((message: { role?: string; tool_call_id?: string }) =>
          message.role === "tool" && message.tool_call_id === "native_cache_probe")
        expect(yield* Effect.promise(() => written.exists()), JSON.stringify(writeResult)).toBe(true)
        expect(yield* Effect.promise(() => written.text())).toBe("Private native child\n")
        expect(yield* Effect.promise(() => Bun.file(path.join(location.directory, "native-child.txt")).exists())).toBe(false)
        expect(captures.filter((capture) => capture.body.includes("Fixture worker baseline")).at(-1)?.body).toContain("native-child.txt")
        const { SessionFileMutationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql"))
        const journal = yield* db.select().from(SessionFileMutationTable).where(eq(SessionFileMutationTable.session_id, spawned.id)).all()
        expect(journal).toHaveLength(1)
        expect(journal[0]?.after_sha256).toMatch(/^[a-f0-9]{64}$/)
        expect(journal[0]?.after_exists).toBe(true)
      }
      if (mode === "native-task-readonly-cache") {
        const spawned = yield* db.select().from(SessionTable).where(eq(SessionTable.agent, "fixture-worker")).get()
        expect(spawned?.agent_policy?.readOnly).toBe(true)
        expect(spawned?.agent_policy?.mainWriteConsent).toBeUndefined()
        for (const capture of captures.filter((capture) => capture.body.includes("Fixture worker baseline"))) {
          const request = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({
            tools: Schema.Array(Schema.Struct({ function: Schema.Struct({ name: Schema.String }) })).pipe(Schema.optional),
          })))(capture.body)
          expect((request.tools ?? []).every((tool) => ["read", "grep", "glob"].includes(tool.function.name))).toBe(true)
        }
      }
      const capturedChild = captures.find((capture) => capture.body.includes("Fixture worker baseline"))
      if (!capturedChild) return yield* Effect.die("Missing worker HTTP request")
      // Check the real TaskTool's first request and every child tool continuation.
      for (const capture of captures) {
        const messages: { role: string; content: unknown }[] = JSON.parse(capture.body).messages
        const handoff = messages.filter((message) => typeof message.content === "string" &&
          message.content.includes("directly assigned native execution fork"))
        if (fresh || !capture.body.includes("Fixture worker baseline")) {
          expect(handoff).toEqual([])
          continue
        }
        expect(handoff).toEqual([{ role: "system", content: expect.stringContaining("do not delegate it again") }])
        const users = messages.filter((message) => message.role === "user").map((message) => message.content)
        expect(users).toContain("Parent dispatch instruction")
        expect(users.at(-1)).toBe("Child fixture assignment")
      }
      const child = JSON.stringify(JSON.parse(capturedChild.body).messages)
      expect(child).toContain("Fixture worker baseline")
      expect(child).not.toContain("Future queue assignment must not reach the child")
      if (fresh) {
        expect(child).toContain("Child fixture assignment")
        for (const text of ["Current compacted parent evidence", "Recent post-compaction evidence", "Parent dispatch instruction",
          "Parent chronological update after compactions", "Earlier parent evidence", "Fixture parent-only baseline", "native_real_task"])
          expect(child).not.toContain(text)
        const children = yield* db.select().from(SessionTable).where(eq(SessionTable.agent, "fixture-worker")).all()
        expect(children).toHaveLength(mode.endsWith("fanout") ? 2 : 1)
        expect(children.every((row) => row.agent_policy?.taskContext === "fresh")).toBe(true)
        for (const capture of captures.filter((capture) => capture.body.includes("Fixture worker baseline"))) {
          expect(capture.body).not.toContain("Current compacted parent evidence")
          expect(capture.body).toContain("Child fixture assignment")
        }
        if (mode.endsWith("fanout")) {
          const final = JSON.parse(captures.at(-1)!.body)
          const outputs = final.messages.filter((message: { role: string }) => message.role === "tool")
          const collected = JSON.parse(outputs[0].content)
          expect(collected.results.map((result: { status: string }) => result.status)).toEqual(["success", "success"])
        }
        return
      }
      expect(child).toContain("Current compacted parent evidence")
      expect(child).not.toContain("Earlier parent evidence")
      expect(child).not.toContain("Superseded parent summary")
      expect(child).not.toContain("Fixture parent-only baseline")
      expect(child).toContain("Recent post-compaction evidence")
      expect(child).toContain("Finished")
      const parentDispatch = JSON.stringify(JSON.parse(captures[2]!.body).messages)
      // Compaction replaces the parent's own context epoch. Superseded updates
      // are not valid working context and must not reappear only in the child.
      for (const update of ["Parent chronological update 0", "Parent chronological update 1"]) {
        expect(parentDispatch).not.toContain(update)
        expect(child).not.toContain(update)
      }
      expect(parentDispatch).toContain("Parent chronological update after compactions")
      expect(child).toContain("Parent chronological update after compactions")
      expect(child.indexOf("Current compacted parent evidence")).toBeLessThan(child.indexOf("Parent chronological update after compactions"))
      expect(child.indexOf("Parent chronological update after compactions")).toBeLessThan(child.indexOf("Parent dispatch instruction"))
      expect(child).toContain("Parent dispatch instruction")
      expect(child).toContain("Child fixture assignment")
      expect(child).not.toContain("native_real_task")
      if (mode.endsWith("subdir")) {
        const { WorkspaceCheckout } = yield* Effect.promise(() => import("@opencode-ai/core/session/workspace/checkout"))
        const checkout = yield* WorkspaceCheckout.Service.use((service) => service.resolve(location.directory))
          .pipe(Effect.provide(WorkspaceCheckout.layer))
        const physicalRoot = yield* Effect.promise(() => realpath(path.dirname(location.directory)))
        expect(checkout).toBe(WorkspaceCheckout.pathKey(physicalRoot))
        const spawned = yield* db.select().from(SessionTable).where(eq(SessionTable.agent, "fixture-worker")).get()
        expect(spawned?.directory).toBe(location.directory)
        expect(child).toContain("nested")
      }
      if (mode.endsWith("fanout")) {
        const children = captures.filter((capture) => capture.body.includes("Fixture worker baseline"))
        expect(children).toHaveLength(2)
        for (const capture of children) {
          expect(capture.body).toContain("Current compacted parent evidence")
          expect(capture.body).not.toContain("Earlier parent evidence")
          expect(capture.body).toContain("Parent dispatch instruction")
          expect(capture.body).not.toContain("native_real_task")
        }
        const final = JSON.parse(captures.at(-1)!.body)
        const outputs = final.messages.filter((message: { role: string }) => message.role === "tool")
        expect(outputs).toHaveLength(1)
        const collected = JSON.parse(outputs[0].content)
        expect(collected.results.map((result: { status: string }) => result.status)).toEqual(["success", "success"])
        expect(new Set(collected.results.map((result: { sessionID: string }) => result.sessionID)).size).toBe(2)
      }
      if (mode.endsWith("parallel")) {
        const children = captures.filter((capture) => capture.body.includes("Fixture worker baseline"))
        expect(children).toHaveLength(2)
        for (const capture of children) {
          expect(capture.body).toContain("Current compacted parent evidence")
          expect(capture.body).toContain("Parent dispatch instruction")
          expect(capture.body).toContain("Child fixture assignment")
          expect(capture.body).not.toContain("native_real_task")
        }
        const final = JSON.parse(captures.at(-1)!.body)
        const outputs = final.messages.filter((message: { role: string }) => message.role === "tool")
        expect(outputs).toHaveLength(2)
        const childrenRows = yield* db.select({ id: SessionTable.id, parent: SessionTable.parent_id })
          .from(SessionTable).where(eq(SessionTable.agent, "fixture-worker"))
        expect(childrenRows).toHaveLength(2)
        expect(childrenRows.every((child) => child.parent === mainID)).toBe(true)
        expect(new Set(childrenRows.map((child) => child.id)).size).toBe(2)
      }
      return
    }
    if (mode === "native-capture") {
      yield* db.update(SessionTable).set({ agent: "plan" }).where(eq(SessionTable.id, childID)).run()
      yield* access.send({ sessionID: mainID, prompt: new Prompt({ text: "Parent source request" }), delivery: "steer" })
      yield* execution.wait(mainID)
      expect(failures).toEqual([])
      expect(calls).toBe(3)
      const child = JSON.stringify(JSON.parse(captures[1]!.body).messages)
      expect(child).toContain("Parent source request")
      expect(child).toContain("Child fixture assignment")
      expect(child).toContain("Native child baseline marker")
      expect(child).not.toContain("Native parent baseline marker")
      expect(child).not.toContain("native_dispatch")
      expect(child).toContain(childID)
      expect(child).not.toContain("directly assigned native execution fork")
      return
    }
    if (mode === "native-history-loopback" || mode === "native-history-deny") {
      yield* db.update(SessionTable).set({ agent: "plan" }).where(eq(SessionTable.id, mainID)).run()
      if (mode === "native-history-deny")
        yield* db.update(SessionTable).set({ agent_policy: {
          tools: { mode: "explicit", entries: { cache_probe: { visible: true, permission: "allow" } } },
          permissionLayers: [[{ action: "cache_probe", resource: "*", effect: "deny" }]],
          source: { type: "task", sessionID: mainID, agent: AgentV2.ID.make("plan") },
        } }).where(eq(SessionTable.id, childID)).run()
      const history = [
        { type: "system", text: "Update before compactions" },
        { type: "compaction", reason: "auto", summary: "Old summary", recent: "" },
        { type: "system", text: "Update between compactions" },
        { type: "compaction", reason: "auto", summary: "Latest summary", recent: "" },
        { type: "user", text: "Recent user" },
        { type: "system", text: "Update after compactions" },
      ] as const
      let throughSeq = -1
      for (const [index, item] of history.entries()) {
        const message = Schema.decodeUnknownSync(SessionMessage.Message)({
          ...item, id: SessionMessage.ID.make(`msg_wire_child_${index}`), time: { created: index + 1 },
        })
        const result = yield* events.publish(SessionForkEvent.MessageImported, {
          sessionID: childID, sourceSessionID: mainID,
          sourceMessageID: SessionMessage.ID.make(`msg_wire_parent_${index}`),
          timestamp: DateTime.makeUnsafe(index + 1), message,
        })
        if (result.seq === undefined) return yield* Effect.die("Missing imported sequence")
        throughSeq = result.seq
      }
      yield* events.publish(SessionForkEvent.HistoryBoundaryImported, {
        sessionID: childID, sourceSessionID: mainID, throughSeq,
      })
      yield* access.send({ sessionID: childID, prompt: new Prompt({ text: "Child assignment" }), delivery: "steer" })
      yield* execution.wait(childID)
      expect(failures).toEqual([])
      expect(calls).toBe(mode === "native-history-deny" ? 2 : 1)
      if (mode === "native-history-deny") {
        expect(tools).toBe(0)
        const continuation = JSON.stringify(JSON.parse(captures[1]!.body).messages)
        expect(continuation).toContain("denied_call")
        expect(continuation.toLowerCase()).toMatch(/denied|not available|not found|not permitted/)
      }
      const body = JSON.parse(captures[0]!.body)
      const serialized = JSON.stringify(body.messages)
      expect(serialized).toContain("Child-only baseline marker")
      expect(serialized).not.toContain("Parent-only baseline marker")
      for (const text of ["Update before compactions", "Update between compactions", "Latest summary", "Recent user", "Update after compactions", "Child assignment"])
        expect(serialized).toContain(text)
      expect(serialized).not.toContain("Old summary")
      expect(serialized.indexOf("Update before compactions")).toBeLessThan(serialized.indexOf("Latest summary"))
      expect(serialized.indexOf("Update between compactions")).toBeLessThan(serialized.indexOf("Latest summary"))
      expect(serialized.indexOf("Latest summary")).toBeLessThan(serialized.indexOf("Recent user"))
      expect(serialized.indexOf("Recent user")).toBeLessThan(serialized.indexOf("Update after compactions"))
      expect(serialized.indexOf("Update after compactions")).toBeLessThan(serialized.indexOf("Child assignment"))
      return
    }
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(dependencies, projector, execution, access)),
    Effect.runPromise,
  )
}
