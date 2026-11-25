import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { LLMEvent } from "@opencode-ai/llm"

// Isolate the real admission / Location runtime from developer plugins,
// credentials and the installed app. Only the loopback fixture receives calls.
const modes = [
  "event-error",
  "interrupted",
  "chain-tool",
  "same-tool",
  "patch-tool",
  "abort-tool",
  "final-partial",
  "final-exhausted",
  "auth-abort",
  "auth-chain",
  "chain-retry-success",
  "chain-retry-fallback",
  "chain-empty-retry",
  "chain-empty-filter",
  "chain-retry-stop",
  "chain-empty-stop",
  "quota-abort",
  "auth-idle",
  "quota-idle",
  "structured-chain",
  "structured-abort",
  "budget-exhausted",
  "empty-error-budget",
  "question",
  "catalog-budget",
  "retry-deferred",
  "raw-retry-deferred",
  "raw-read-after-auth",
  "capability-schema",
  "capability-terminal",
  "capability-exhausted",
  "overflow-auth",
  "overflow-interrupted",
  "final-missing",
  "final-missing-recovered",
  "final-forbidden",
  "final-forbidden-recovered",
  "normal-missing",
  "normal-missing-exhausted",
  "responses-eof-tool",
  "responses-eof-exhausted",
  "content-filter",
  "content-filter-abort",
  "preflight-overflow",
  "error-finish",
  "error-finish-empty",
  "length-tool",
  "length-exhausted",
  "unknown-tool",
  "final-length",
  "reasoning-only",
  "final-reasoning-only",
  "reasoning-delayed-hook",
  "sdk-tpm-tool",
  "sdk-tpm-exhausted",
  "sdk-tpm-deferred",
  "sdk-tpm-stop",
  "sdk-auth",
  "sdk-quota",
  "sdk-invalid",
  "native-tpm-tool",
] as const
for (const mode of modes.filter(
  (mode) => !process.env.OPENCODE_PROVIDER_DRAIN_PROBE || process.env.OPENCODE_PROVIDER_DRAIN_PROBE === mode,
)) {
  test(`provider ${mode} settles normal admission without false completion or advisory replay`, async () => {
    if (process.env.OPENCODE_PROVIDER_DRAIN_PROBE) return probe(mode)
    const root = await mkdtemp(path.join(os.tmpdir(), "opencode-provider-drain-"))
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      cwd: root,
      env: {
        ...process.env,
        OPENCODE_PROVIDER_DRAIN_PROBE: mode,
        OPENCODE_TEST_HOME: root,
        OPENCODE_DB: path.join(root, "test.db"),
        OPENCODE_CONFIG_DIR: path.join(root, "config"),
        OPENCODE_CONFIG: "",
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          permission: { skill: "allow" },
          skill_capabilities: { "computer-use": ["browser_read"] },
        }),
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_DISABLE_SESSION_RECOVERY: "1",
        OPENCODE_DEFER_BACKGROUND_STARTUP: "0",
        OPENCODE_PROVIDER_STREAM_IDLE_TIMEOUT_MS: mode.endsWith("-idle") ? "80" : "0",
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
      stdout
        .split("\n")
        .filter((line) => line.startsWith("PROVIDER_DRAIN_EVIDENCE "))
        .forEach((line) => console.log(line))
    } finally {
      clearTimeout(timeout)
      for (let attempt = 0; ; attempt++) {
        try {
          await rm(root, { recursive: true, force: true })
          break
        } catch (error) {
          if (attempt >= 9 || (error as NodeJS.ErrnoException).code !== "EBUSY") throw error
          await new Promise((resolve) => setTimeout(resolve, 200))
        }
      }
    }
  }, 120_000)
}

async function probe(mode: (typeof modes)[number]) {
  const { Deferred, Effect, Layer, Schema, Stream } = await import("effect")
  const { AuthenticationReason, LLMError, LLMEvent, TransportReason } = await import("@opencode-ai/llm")
  const { CapabilityLease } = await import("@opencode-ai/core/capability/lease")
  const { Tool } = await import("@opencode-ai/core/tool/tool")
  const { ToolRegistry } = await import("@opencode-ai/core/tool/registry")
  const { AgentV2 } = await import("@opencode-ai/core/agent")
  const { eq } = await import("drizzle-orm")
  const { Catalog } = await import("@opencode-ai/core/catalog")
  const { ContentStore } = await import("@opencode-ai/core/content-store")
  const { Database } = await import("@opencode-ai/core/database/database")
  const { EventV2 } = await import("@opencode-ai/core/event")
  const { FSUtil } = await import("@opencode-ai/core/fs-util")
  const { Global } = await import("@opencode-ai/core/global")
  const { LocationServiceMap } = await import("@opencode-ai/core/location-layer")
  const { ModelV2 } = await import("@opencode-ai/core/model")
  const { PluginV2 } = await import("@opencode-ai/core/plugin")
  const { Project } = await import("@opencode-ai/core/project")
  const { ProjectTable } = await import("@opencode-ai/core/project/sql")
  const { ProviderV2 } = await import("@opencode-ai/core/provider")
  const { AbsolutePath } = await import("@opencode-ai/core/schema")
  const { SessionAccess } = await import("@opencode-ai/core/session/access")
  const { SessionActivity } = await import("@opencode-ai/core/session/activity")
  const { SessionEvent } = await import("@opencode-ai/core/session/event")
  const { SessionExecution } = await import("@opencode-ai/core/session/execution")
  const { SessionExecutionLocal } = await import("@opencode-ai/core/session/execution/local")
  const { SessionProjector } = await import("@opencode-ai/core/session/projector")
  const { SessionRunner } = await import("@opencode-ai/core/session/runner")
  const { SessionSchema } = await import("@opencode-ai/core/session/schema")
  const { SessionStore } = await import("@opencode-ai/core/session/store")
  const { Prompt } = await import("@opencode-ai/core/session/prompt")
  const { QuestionV2 } = await import("@opencode-ai/core/question")
  const { SessionActivityTable, SessionTable } = await import("@opencode-ai/core/session/sql")

  const database = Database.defaultLayer
  const events = EventV2.layer.pipe(Layer.provide(database))
  const store = SessionStore.layer.pipe(Layer.provide(database))
  const activity = SessionActivity.layer.pipe(Layer.provide(database), Layer.provide(events))
  const content = ContentStore.layer.pipe(
    Layer.provide(database),
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(Global.layerWith({ data: path.join(Global.Path.tmp, `provider-drain-${process.pid}`) })),
  )
  const locations = LocationServiceMap.layer.pipe(Layer.provide(database), Layer.provide(events), Layer.provide(store))
  const dependencies = Layer.mergeAll(database, events, store, activity, locations)
  const projector = SessionProjector.layer.pipe(Layer.provide(dependencies))
  const execution = SessionExecutionLocal.layer.pipe(Layer.provide(dependencies))
  const access = SessionAccess.layer.pipe(
    Layer.provide(database),
    Layer.provide(events),
    Layer.provide(store),
    Layer.provide(content),
  )

  await Effect.gen(function* () {
    const databaseService = yield* Database.Service
    const eventsService = yield* EventV2.Service
    const locationsService = yield* LocationServiceMap
    const location = { directory: AbsolutePath.make(process.cwd()) }
    const id = SessionSchema.ID.make(`ses_provider_drain_${mode.replace("-", "_")}`)
    const requests: string[] = []
    const requestTimes: number[] = []
    const successfulTools: unknown[] = []
    const hookEntered = yield* Deferred.make<void>()
    const releaseHook = yield* Deferred.make<void>()
    const providerEnded = yield* Deferred.make<void>()
    yield* Effect.addFinalizer(() => Deferred.succeed(releaseHook, undefined))
    let seeded = !mode.startsWith("overflow-")
    const priorActivityIDs: string[] = []
    const responses =
      !mode.startsWith("sdk-") &&
      mode !== "native-tpm-tool" &&
      mode !== "interrupted" &&
      mode !== "chain-tool" &&
      mode !== "same-tool" &&
      mode !== "patch-tool" &&
      mode !== "abort-tool" &&
      mode !== "final-partial" &&
      mode !== "final-exhausted" &&
      mode !== "question"
    const chain =
      mode === "chain-tool" ||
      mode === "auth-chain" ||
      mode === "chain-retry-success" ||
      mode === "chain-retry-fallback" ||
      mode === "chain-empty-retry" ||
      mode === "chain-empty-filter" ||
      mode === "chain-retry-stop" ||
      mode === "chain-empty-stop" ||
      mode === "structured-chain" ||
      mode === "empty-error-budget" ||
      mode === "catalog-budget"
    const toolMode = [
      "chain-tool",
      "same-tool",
      "patch-tool",
      "abort-tool",
      "final-partial",
      "final-exhausted",
      "budget-exhausted",
      "responses-eof-tool",
      "responses-eof-exhausted",
      "length-tool",
      "length-exhausted",
      "unknown-tool",
      "final-length",
      "final-reasoning-only",
      "reasoning-delayed-hook",
      "sdk-tpm-tool",
      "sdk-tpm-exhausted",
      "native-tpm-tool",
    ].includes(mode)
    const errorMessage = mode.startsWith("auth-")
      ? "invalid_api_key: fixture rejection"
      : "insufficient_quota: fixture rejection"
    const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`
    const partial = responses
      ? frame({ type: "response.output_text.delta", item_id: "partial", delta: "Partial" })
      : frame({ id: "partial", choices: [{ delta: { content: "Partial" }, finish_reason: null }] })
    const failure = frame({ type: "error", message: "connection reset fixture", code: "server_error" })
    const readInput = { path: path.join(process.cwd(), "probe.txt") }
    const call = (name: string, input: unknown, id = "call_read_once") =>
      responses
        ? frame({
            type: "response.output_item.added",
            item: { type: "function_call", id, call_id: id, name, arguments: "" },
          }) +
          frame({
            type: "response.output_item.done",
            item: { type: "function_call", id, call_id: id, name, arguments: JSON.stringify(input) },
          })
        : frame({
            id: "tool",
            choices: [
              {
                delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(input) } }] },
                finish_reason: "tool_calls",
              },
            ],
          })
    const finish = responses
      ? frame({ type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 1 } } })
      : "data: [DONE]\n\n"
    const recovered = responses
      ? frame({ type: "response.output_text.delta", item_id: "recovered", delta: "Recovered" }) + finish
      : frame({ id: "recovered", choices: [{ delta: { content: "Recovered" }, finish_reason: null }] }) +
        frame({ id: "recovered", choices: [{ delta: {}, finish_reason: "stop" }] }) +
        finish
    yield* Effect.promise(() => Bun.write(path.join(process.cwd(), "probe.txt"), "Read exactly once"))
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch: async (request) => {
            requests.push(await request.text())
            requestTimes.push(Date.now())
            const headers = { "content-type": "text/event-stream" }
            if (mode.startsWith("sdk-") || mode === "native-tpm-tool") {
              if (toolMode && requests.length === 1) return new Response(call("read", readInput) + finish, { headers })
              if ((mode === "sdk-tpm-tool" || mode === "native-tpm-tool") && requests.length === 3)
                return new Response(recovered, { headers })
              return Response.json(
                {
                  message: "Tokens per minute limit exceeded - too many tokens processed.",
                  type: "too_many_tokens_error",
                  param: "quota",
                  code: mode === "sdk-quota" ? "insufficient_quota" : "token_quota_exceeded",
                },
                {
                  status: mode === "sdk-auth" ? 401 : mode === "sdk-invalid" ? 422 : 429,
                  headers: {
                    "retry-after-ms":
                      mode === "sdk-tpm-deferred"
                        ? "600000"
                        : mode === "sdk-tpm-stop"
                          ? "1000"
                          : mode === "sdk-tpm-tool" || mode === "native-tpm-tool"
                            ? "60"
                            : "0",
                    "x-request-id": "sdk-fixture-request",
                  },
                },
              )
            }
            if ((mode === "chain-retry-stop" || mode === "chain-empty-stop") && requests.length === 2)
              return new Response(new ReadableStream({ start() {} }), { headers })
            if (mode === "chain-retry-stop")
              return new Response(frame({ type: "error", message: "temporary provider outage", code: "server_error" }), { headers })
            if (mode === "chain-empty-stop") return new Response(finish, { headers })
            if (mode === "chain-empty-retry" || mode === "chain-empty-filter")
              return new Response(requests.length === 1 ? finish : mode === "chain-empty-filter"
                ? frame({ type: "response.output_text.delta", item_id: "blocked", delta: "Partial" }) +
                  frame({ type: "response.incomplete", response: { incomplete_details: { reason: "content_filter" } } })
                : recovered, { headers })
            if (mode === "chain-retry-success" || mode === "chain-retry-fallback")
              return new Response(
                requests.length === 1 || (mode === "chain-retry-fallback" && requests.length === 2)
                  ? frame({ type: "error", message: "temporary provider outage", code: "server_error" })
                  : recovered,
                { headers },
              )
            if (mode === "raw-retry-deferred")
              return new Response('{"error":{"message":"rate limit fixture","type":"rate_limit_error"}}', {
                status: 429,
                headers: { "content-type": "application/json", "retry-after": "600" },
              })
            if (!seeded) return new Response(recovered, { headers })
            if (mode.startsWith("error-finish"))
              return new Response(mode === "error-finish-empty" ? finish : recovered, { headers })
            if (mode === "reasoning-delayed-hook")
              return new Response(
                requests.length === 1
                  ? frame({
                      type: "response.output_item.added",
                      item: { type: "reasoning", id: "pending-hook", summary: [] },
                    }) +
                      frame({
                        type: "response.reasoning_summary_text.delta",
                        item_id: "pending-hook",
                        summary_index: 0,
                        delta: "Preparing the tool",
                      }) +
                      frame({
                        type: "response.output_item.done",
                        item: {
                          type: "reasoning",
                          id: "pending-hook",
                          summary: [{ type: "summary_text", text: "Preparing the tool" }],
                          encrypted_content: null,
                        },
                      }) +
                      call("read", readInput) +
                      finish
                  : recovered,
                { headers },
              )
            if (mode === "reasoning-only" || mode === "final-reasoning-only") {
              if (mode === "final-reasoning-only" && requests.length === 1)
                return new Response(call("read", readInput) + finish, { headers })
              return new Response(
                requests.length === (mode === "reasoning-only" ? 1 : 2)
                  ? frame({
                      type: "response.output_item.added",
                      item: { type: "reasoning", id: "reasoning-only", summary: [] },
                    }) +
                      frame({
                        type: "response.reasoning_summary_text.delta",
                        item_id: "reasoning-only",
                        summary_index: 0,
                        delta: "Preserved thinking",
                      }) +
                      frame({
                        type: "response.output_item.done",
                        item: {
                          type: "reasoning",
                          id: "reasoning-only",
                          summary: [{ type: "summary_text", text: "Preserved thinking" }],
                          encrypted_content: null,
                        },
                      }) +
                      finish
                  : recovered,
                { headers },
              )
            }
            if (["length-tool", "length-exhausted", "unknown-tool", "final-length"].includes(mode)) {
              if (requests.length === 1) return new Response(call("read", readInput) + finish, { headers })
              return new Response(
                mode === "length-exhausted" || requests.length === 2
                  ? partial +
                      frame({
                        type: "response.incomplete",
                        response: {
                          incomplete_details: {
                            reason: mode === "unknown-tool" ? "unknown_fixture" : "max_output_tokens",
                          },
                          usage: { input_tokens: 5, output_tokens: 1 },
                        },
                      })
                  : recovered,
                { headers },
              )
            }
            if (mode.startsWith("content-filter"))
              return new Response(
                frame({
                  type: "response.incomplete",
                  response: {
                    incomplete_details: { reason: "content_filter" },
                    usage: { input_tokens: 5, output_tokens: 0 },
                  },
                }),
                { headers },
              )
            if (mode.startsWith("responses-eof-")) {
              if (requests.length === 1) return new Response(call("read", readInput) + finish, { headers })
              return new Response(mode === "responses-eof-exhausted" || requests.length === 2 ? partial : recovered, {
                headers,
              })
            }
            if (mode.startsWith("normal-missing")) return new Response(recovered, { headers })
            if (mode === "raw-read-after-auth")
              return new Response(
                requests.length === 1
                  ? frame({ type: "error", message: "invalid_api_key: fixture rejection", code: "invalid_api_key" })
                  : recovered,
                { headers },
              )
            if (mode.startsWith("overflow-"))
              return new Response(
                requests.length === 1
                  ? frame({
                      type: "error",
                      message: "context_length_exceeded fixture",
                      code: "context_length_exceeded",
                    })
                  : recovered,
                { headers },
              )
            if (mode.startsWith("capability-")) {
              if (mode === "capability-exhausted" && requests.length <= 5) return new Response(failure, { headers })
              if (requests.length > (mode === "capability-exhausted" ? 6 : 1))
                return new Response(recovered, { headers })
              return new Response(
                call("skill", { name: "computer-use" }, "call_skill_once") +
                  (mode === "capability-schema"
                    ? call("StructuredOutput", { findings: "invalid array" }, "call_invalid") + finish
                    : mode === "capability-exhausted"
                      ? partial + failure
                      : frame({ type: "error", message: "invalid_api_key fixture", code: "invalid_api_key" })),
                { headers },
              )
            }
            if (
              ["final-missing", "final-missing-recovered", "final-forbidden", "final-forbidden-recovered"].includes(
                mode,
              )
            ) {
              if (requests.length === 1) return new Response(call("read", readInput) + finish, { headers })
              if (mode.endsWith("-recovered") && requests.length === 2)
                return new Response(partial + failure, { headers })
              if (mode.startsWith("final-missing")) return new Response(recovered, { headers })
              return new Response(
                call(
                  "apply_patch",
                  {
                    patchText: "*** Begin Patch\n*** Add File: forbidden.txt\n+Must not be written\n*** End Patch",
                    expectedStates: { "forbidden.txt": { exists: false } },
                  },
                  "call_forbidden",
                ) + finish,
                { headers },
              )
            }
            if (mode.startsWith("auth-") || mode.startsWith("quota-")) {
              if (requests.length > 1) return new Response(recovered, { headers })
              const error = frame({
                type: "error",
                message: errorMessage,
                code: mode.startsWith("auth-") ? "invalid_api_key" : "insufficient_quota",
              })
              if (!mode.endsWith("-idle")) return new Response(error, { headers })
              return new Response(
                new ReadableStream({
                  start(controller) {
                    controller.enqueue(new TextEncoder().encode(error))
                  },
                }),
                { headers },
              )
            }
            if (mode === "structured-chain" || mode === "structured-abort")
              return new Response(
                requests.length > 1
                  ? recovered
                  : call("read", readInput) +
                      call("StructuredOutput", { findings: "invalid array" }, "call_invalid") +
                      failure,
                { headers },
              )
            if (mode === "budget-exhausted") {
              if (requests.length === 4) return new Response(call("read", readInput) + finish, { headers })
              return new Response(([3, 5, 7].includes(requests.length) ? partial : "") + failure, { headers })
            }
            if (mode === "empty-error-budget") return new Response(failure, { headers })
            if (mode === "retry-deferred")
              return new Response(
                frame({ type: "error", message: "rate_limit_exceeded fixture", code: "server_error" }),
                { headers },
              )
            if (mode === "question")
              return new Response(
                call("surface", {
                  mode: "blocking",
                  questions: [{ question: "Continue fixture?", options: [{ label: "Yes" }], allowOther: true }],
                }) + finish,
                { headers },
              )
            if (toolMode && mode !== "chain-tool") {
              if (requests.length === 1)
                return new Response(
                  (mode === "patch-tool"
                    ? call(
                        "apply_patch",
                        {
                          patchText: "*** Begin Patch\n*** Add File: changed.txt\n+Patched exactly once\n*** End Patch",
                          expectedStates: { "changed.txt": { exists: false } },
                        },
                        "call_patch_once",
                      )
                    : call("read", readInput)) + finish,
                  { headers },
                )
              if (requests.length === 2 || mode === "final-exhausted") return new Response(partial, { headers })
              return new Response(recovered, { headers })
            }
            if (mode === "chain-tool") {
              if (requests.length > 2)
                return new Response(
                  'data: {"id":"recovered","choices":[{"delta":{"role":"assistant","content":"Recovered on fallback"},"finish_reason":null}]}\n\n' +
                    'data: {"id":"recovered","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
                    "data: [DONE]\n\n",
                  { headers: { "content-type": "text/event-stream" } },
                )
              // The first turn executes the read. The second ends prematurely
              // after partial text. The third must reuse the completed result.
              if (requests.length === 2)
                return new Response(
                  'data: {"id":"partial","choices":[{"delta":{"content":"Partial"},"finish_reason":null}]}\n\n',
                  { headers: { "content-type": "text/event-stream" } },
                )
              return new Response(
                `data: ${JSON.stringify({ id: "tool", choices: [{ delta: { tool_calls: [{ index: 0, id: "call_read_once", function: { name: "read", arguments: JSON.stringify({ path: path.join(process.cwd(), "probe.txt") }) } }] }, finish_reason: "tool_calls" }] })}\n\n` +
                  "data: [DONE]\n\n",
                { headers: { "content-type": "text/event-stream" } },
              )
            }
            if (mode === "interrupted") {
              return new Response(
                new ReadableStream({
                  start(controller) {
                    controller.enqueue(
                      new TextEncoder().encode(
                        'data: {"id":"probe","choices":[{"delta":{"role":"assistant","content":"Partial"},"finish_reason":null}]}\n\n',
                      ),
                    )
                  },
                }),
                { headers: { "content-type": "text/event-stream" } },
              )
            }
            return new Response('data: {"type":"error","message":"fixture rejection","code":"invalid_api_key"}\n\n', {
              headers: { "content-type": "text/event-stream" },
            })
          },
        }),
      ),
      (server) => Effect.promise(() => server.stop(true)),
    )
    yield* Effect.gen(function* () {
      // Use the supported native-provider seam to exercise actual wire
      // parsing. An error payload is valid in Responses, not Chat Completions.
      const plugins = yield* PluginV2.Service
      yield* plugins.add({
        id: PluginV2.ID.make("provider-drain-fixture"),
        nativeModels: {
          "provider-drain-fixture": {
            resolve: async (input) => {
              if (mode.startsWith("sdk-")) {
                const { createSDK } = await import("../../provider-plugins/cerebras/src/sdk")
                const { SessionRunnerModel } = await import("@opencode-ai/core/session/runner/model")
                const sdk = await createSDK({ apiKey: "fixture-key", baseURL: `http://127.0.0.1:${server.port}/v1` })
                return SessionRunnerModel.fromAISDKModel(
                  Schema.decodeUnknownSync(ModelV2.Info)(input.model),
                  sdk("qwen-3.8-27b"),
                )
              }
              const { route } = await import(
                responses ? "@opencode-ai/llm/protocols/openai-responses" : "@opencode-ai/llm/protocols/openai-chat"
              )
              const configured = route.with({
                endpoint: { baseURL: `http://127.0.0.1:${server.port}/v1` },
                limits:
                  mode === "preflight-overflow" ? { context: 128, output: 64 } : { context: 1_000_000, output: 1_024 },
              })
              return {
                id: input.model.id,
                provider: input.model.providerID,
                route: {
                  ...configured,
                  streamPrepared: (...args: Parameters<typeof configured.streamPrepared>) => {
                    const attempt = requests.length + 1
                    return configured.streamPrepared(...args).pipe(
                      (stream: ReturnType<typeof configured.streamPrepared>) =>
                        attempt !== 1 || !seeded
                          ? stream
                          : mode === "raw-read-after-auth"
                            ? Stream.concat(
                                stream,
                                Stream.fail(
                                  new LLMError({
                                    module: "fixture",
                                    method: "read",
                                    reason: new TransportReason({
                                      message: "genuine fixture read failure",
                                      kind: "read",
                                      canRetry: true,
                                    }),
                                  }),
                                ),
                              )
                            : mode === "overflow-auth"
                              ? Stream.concat(
                                  stream,
                                  Stream.fail(
                                    new LLMError({
                                      module: "fixture",
                                      method: "read",
                                      reason: new AuthenticationReason({
                                        message: "raw authentication rejection",
                                        kind: "invalid",
                                      }),
                                    }),
                                  ),
                                )
                              : mode === "overflow-interrupted"
                                ? Stream.concat(stream, Stream.fromEffect(Effect.interrupt))
                                : stream,
                      // Only fixture timing and lifecycle cleanup are injected.
                      // Admission, wire parsing, tools and settlement are real.
                      Stream.map((event: LLMEvent) =>
                        mode === "reasoning-delayed-hook" && (event.type === "step-finish" || event.type === "finish")
                          ? { ...event, reason: "stop" as const }
                          : mode.startsWith("error-finish") && (event.type === "step-finish" || event.type === "finish")
                            ? { ...event, reason: "error" as const }
                            : event.type === "provider-error"
                              ? LLMEvent.providerError({
                                  ...event,
                                  retryAfterMs: mode === "retry-deferred" ? 86_400_000 : 0,
                                })
                              : event,
                      ),
                      Stream.ensuring(
                        mode === "reasoning-delayed-hook" ? Deferred.succeed(providerEnded, undefined) : Effect.void,
                      ),
                      Stream.ensuring(
                        Effect.sync(() => {
                          if ((mode.endsWith("-abort") && attempt === 1) || (mode === "abort-tool" && attempt === 2)) {
                            const controller = new AbortController()
                            controller.abort()
                            controller.signal.throwIfAborted()
                          }
                        }),
                      ),
                    )
                  },
                },
              }
            },
          },
        },
        effect:
          mode === "reasoning-delayed-hook"
            ? Effect.succeed({
                "tool.execute.before": Effect.fn(function* (event) {
                  if (event.tool !== "read") return
                  yield* Deferred.succeed(hookEntered, undefined)
                  yield* Deferred.await(releaseHook)
                }),
              })
            : Effect.void,
      })
      const catalog = yield* Catalog.Service
      if (mode.startsWith("capability-")) {
        const registry = yield* ToolRegistry.Service
        const leases = yield* CapabilityLease.Service
        yield* registry.register({
          skill: Tool.make({
            description: "Activate the isolated fixture capability",
            input: Schema.Struct({ name: Schema.String }),
            output: Schema.Struct({ name: Schema.String }),
            execute: (input, context) =>
              leases
                .activate({
                  sessionID: context.sessionID,
                  agent: context.agent,
                  skill: input.name,
                  requested: ["browser_read"],
                })
                .pipe(
                  Effect.as({ name: input.name }),
                  Effect.mapError((error) => new Tool.Failure({ message: error.message })),
                ),
          }),
        })
      }
      const agents = yield* AgentV2.Service
      yield* agents.update((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          if (mode.startsWith("final-")) agent.steps = 1
        }),
      )
      const transform = yield* catalog.transform()
      yield* transform((editor) => {
        editor.provider.update(ProviderV2.ID.make("provider-fixture"), (provider) => {
          provider.api = { type: "aisdk", package: "provider-drain-fixture", url: `http://127.0.0.1:${server.port}/v1` }
        })
        for (const id of ["fixture", "fallback", ...Array.from({ length: 7 }, (_, index) => `fallback-${index}`)])
          editor.model.update(ProviderV2.ID.make("provider-fixture"), ModelV2.ID.make(id), (model) => {
            model.api = {
              id: ModelV2.ID.make(id),
              type: "aisdk",
              package: "provider-drain-fixture",
              url: `http://127.0.0.1:${server.port}/v1`,
            }
            model.capabilities.tools = true
            model.capabilities.input = ["text/plain"]
            model.capabilities.output = ["text/plain"]
            model.limit.context = mode === "preflight-overflow" ? 128 : 1_000_000
            model.limit.output = mode === "preflight-overflow" ? 64 : 1_024
          })
      })
    }).pipe(Effect.provide(locationsService.get(location)))
    yield* databaseService.db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: location.directory, sandboxes: [] })
      .run()
    yield* databaseService.db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        directory: location.directory,
        slug: "provider-drain",
        title: "provider-drain",
        version: "test",
        agent: "build",
        model: {
          providerID: "provider-fixture",
          id: mode === "catalog-budget" ? "missing-0" : "fixture",
          ...(!chain
            ? {}
            : {
                chain: {
                  id: "fixture-chain",
                  name: "Fixture",
                  active: 0,
                  steps:
                    mode === "empty-error-budget"
                      ? [
                          { providerID: "provider-fixture", id: "fixture" },
                          ...Array.from({ length: 7 }, (_, index) => ({
                            providerID: "provider-fixture",
                            id: `fallback-${index}`,
                          })),
                        ]
                      : mode === "catalog-budget"
                        ? [
                            ...Array.from({ length: 7 }, (_, index) => ({
                              providerID: "provider-fixture",
                              id: `missing-${index}`,
                            })),
                            { providerID: "provider-fixture", id: "fixture" },
                          ]
                        : [
                            { providerID: "provider-fixture", id: "fixture" },
                            { providerID: "provider-fixture", id: "fallback" },
                          ],
                },
              }),
        },
      })
      .run()

    const completed: unknown[] = []
    const failed: unknown[] = []
    const textDeltas: unknown[] = []
    const retried: number[] = []
    const retryMessages: string[] = []
    const retryDetails: unknown[] = []
    const stepFailures: unknown[] = []
    const stepEndings: unknown[] = []
    const switches: unknown[] = []
    const settled: Array<{ sessionID: string; status: string }> = []
    const executionService = yield* SessionExecution.Service
    const unsubscribe = yield* eventsService.listen((event) => {
      if (event.type === SessionEvent.Activity.Completed.type) completed.push(event.data)
      if (event.type === SessionEvent.Activity.Failed.type) failed.push(event.data)
      if (event.type === SessionEvent.Tool.Success.type) successfulTools.push(event.data)
      if (event.type === SessionEvent.Text.Delta.type) textDeltas.push(event.data)
      if (event.type === SessionEvent.Retried.type) {
        retryDetails.push(event.data)
        retried.push((event.data as { attempt: number }).attempt)
        retryMessages.push((event.data as { error: { message: string } }).error.message)
      }
      if (event.type === SessionEvent.Step.Failed.type) stepFailures.push(event.data)
      if (event.type === SessionEvent.Step.Ended.type) stepEndings.push(event.data)
      if (event.type === SessionEvent.ModelSwitched.type) switches.push(event.data)
      if (event.type === SessionRunner.Settled.type) settled.push(event.data as { sessionID: string; status: string })
      return Effect.void
    })
    yield* Effect.addFinalizer(() => unsubscribe)
    const accessService = yield* SessionAccess.Service
    if (!seeded) {
      yield* accessService.send({
        sessionID: id,
        prompt: new Prompt({ text: "Seed real durable history" }),
        delivery: "steer",
      })
      yield* executionService.wait(id)
      const prior = yield* databaseService.db
        .select()
        .from(SessionActivityTable)
        .where(eq(SessionActivityTable.session_id, id))
        .all()
      expect(prior).toHaveLength(1)
      expect(prior[0].status).toBe("completed")
      priorActivityIDs.push(prior[0].id)
      requests.length = 0
      completed.length = 0
      failed.length = 0
      settled.length = 0
      textDeltas.length = 0
      stepFailures.length = 0
      seeded = true
    }
    yield* accessService.send({
      sessionID: id,
      prompt: new Prompt({
        text: "Exercise provider settlement",
        ...(mode.startsWith("structured-") ||
        mode.startsWith("final-missing") ||
        mode.startsWith("normal-missing") ||
        mode === "capability-schema"
          ? {
              format: {
                type: "json_schema" as const,
                ...(mode === "normal-missing-exhausted" ? { retryCount: 1 } : {}),
                schema: {
                  type: "object",
                  properties: { findings: { type: "array", items: { type: "string" } } },
                  required: ["findings"],
                  additionalProperties: false,
                },
              },
            }
          : {}),
      }),
      delivery: "steer",
    })
    if (mode === "reasoning-delayed-hook") {
      yield* Deferred.await(hookEntered)
      yield* Deferred.await(providerEnded)
      for (let turn = 0; turn < 10; turn++) yield* Effect.yieldNow
      expect(stepEndings).toHaveLength(0)
      yield* Deferred.succeed(releaseHook, undefined)
    }
    if (mode === "interrupted" || mode === "chain-retry-stop" || mode === "chain-empty-stop") {
      yield* Effect.gen(function* () {
        if (mode === "interrupted") {
          while (requests.length === 0 || textDeltas.length === 0) yield* Effect.sleep(10)
        } else {
          while (requests.length < 2) yield* Effect.sleep(10)
        }
        yield* executionService.interrupt(id)
      }).pipe(Effect.timeout(15_000))
    }
    if (mode === "retry-deferred" || mode === "sdk-tpm-deferred" || mode === "sdk-tpm-stop") {
      // Bound the baseline hang without waiting a day. A wrongly scheduled
      // retry is recorded, then explicitly stopped; it must fail the contract.
      yield* Effect.gen(function* () {
        while (retried.length === 0 && settled.length === 0) yield* Effect.sleep(10)
        if (retried.length > 0) yield* executionService.interrupt(id)
      }).pipe(Effect.timeout(15_000))
    }
    if (mode === "question") {
      yield* Effect.gen(function* () {
        const questions = yield* QuestionV2.Service
        while ((yield* questions.list()).length === 0) yield* Effect.sleep(10)
        expect(requests).toHaveLength(1)
        expect(retried).toEqual([])
        expect(completed).toEqual([])
        const pending = (yield* questions.list()).find((request) => request.sessionID === id)
        expect(pending).toBeDefined()
        if (pending) yield* questions.reject(pending.id, id)
      }).pipe(Effect.provide(locationsService.get(location)), Effect.timeout(15_000))
    }
    yield* executionService.wait(id)
    const allRows = yield* databaseService.db
      .select()
      .from(SessionActivityTable)
      .where(eq(SessionActivityTable.session_id, id))
      .all()
    const rows = allRows.filter((row) => !priorActivityIDs.includes(row.id))
    const expected = {
      "event-error": { activity: "failed", settled: "error", requests: 1, completed: 0, failed: 1, tools: 0 },
      interrupted: { activity: "interrupted", settled: "interrupted", requests: 1, completed: 0, failed: 0, tools: 0 },
      "chain-tool": { activity: "completed", settled: "completed", requests: 3, completed: 1, failed: 0, tools: 1 },
      "same-tool": { activity: "completed", settled: "completed", requests: 3, completed: 1, failed: 0, tools: 1 },
      "patch-tool": { activity: "completed", settled: "completed", requests: 3, completed: 1, failed: 0, tools: 1 },
      "abort-tool": { activity: "completed", settled: "completed", requests: 3, completed: 1, failed: 0, tools: 1 },
      "final-partial": { activity: "completed", settled: "completed", requests: 3, completed: 1, failed: 0, tools: 1 },
      "final-exhausted": { activity: "failed", settled: "error", requests: 7, completed: 0, failed: 1, tools: 1 },
      "auth-abort": { activity: "failed", settled: "error", requests: 1, completed: 0, failed: 1, tools: 0 },
      "auth-chain": { activity: "completed", settled: "completed", requests: 2, completed: 1, failed: 0, tools: 0 },
      "chain-retry-success": { activity: "completed", settled: "completed", requests: 2, completed: 1, failed: 0, tools: 0 },
      "chain-retry-fallback": { activity: "completed", settled: "completed", requests: 3, completed: 1, failed: 0, tools: 0 },
      "chain-empty-retry": { activity: "completed", settled: "completed", requests: 2, completed: 1, failed: 0, tools: 0 },
      "chain-empty-filter": { activity: "failed", settled: "error", requests: 2, completed: 0, failed: 1, tools: 0 },
      "chain-retry-stop": { activity: "interrupted", settled: "interrupted", requests: 2, completed: 0, failed: 0, tools: 0 },
      "chain-empty-stop": { activity: "interrupted", settled: "interrupted", requests: 2, completed: 0, failed: 0, tools: 0 },
      "quota-abort": { activity: "failed", settled: "error", requests: 1, completed: 0, failed: 1, tools: 0 },
      "auth-idle": { activity: "failed", settled: "error", requests: 1, completed: 0, failed: 1, tools: 0 },
      "quota-idle": { activity: "failed", settled: "error", requests: 1, completed: 0, failed: 1, tools: 0 },
      "structured-chain": { activity: "failed", settled: "error", requests: 1, completed: 0, failed: 1, tools: 1 },
      "structured-abort": { activity: "failed", settled: "error", requests: 1, completed: 0, failed: 1, tools: 1 },
      "budget-exhausted": { activity: "failed", settled: "error", requests: 7, completed: 0, failed: 1, tools: 1 },
      "empty-error-budget": { activity: "failed", settled: "error", requests: 6, completed: 0, failed: 1, tools: 0 },
      question: { activity: "interrupted", settled: "error", requests: 1, completed: 0, failed: 0, tools: 0 },
      "catalog-budget": { activity: "failed", settled: "error", requests: 0, completed: 0, failed: 1, tools: 0 },
      "retry-deferred": { activity: "failed", settled: "error", requests: 1, completed: 0, failed: 1, tools: 0 },
      "raw-retry-deferred": { activity: "failed", settled: "error", requests: 1, completed: 0, failed: 1, tools: 0 },
      "raw-read-after-auth": { activity: "failed", settled: "error", requests: 1, completed: 0, failed: 1, tools: 0 },
      "capability-schema": { activity: "failed", settled: "error", requests: 1, completed: 0, failed: 1, tools: 1 },
      "capability-terminal": { activity: "failed", settled: "error", requests: 1, completed: 0, failed: 1, tools: 1 },
      "capability-exhausted": { activity: "failed", settled: "error", requests: 6, completed: 0, failed: 1, tools: 1 },
      "overflow-auth": { activity: "failed", settled: "error", requests: 1, completed: 0, failed: 1, tools: 0 },
      "overflow-interrupted": {
        activity: "interrupted",
        settled: "interrupted",
        requests: 1,
        completed: 0,
        failed: 0,
        tools: 0,
      },
      "final-missing": { activity: "failed", settled: "error", requests: 2, completed: 0, failed: 1, tools: 1 },
      "final-missing-recovered": {
        activity: "failed",
        settled: "error",
        requests: 3,
        completed: 0,
        failed: 1,
        tools: 1,
      },
      "final-forbidden": { activity: "failed", settled: "error", requests: 2, completed: 0, failed: 1, tools: 1 },
      "final-forbidden-recovered": {
        activity: "failed",
        settled: "error",
        requests: 3,
        completed: 0,
        failed: 1,
        tools: 1,
      },
      "normal-missing": { activity: "failed", settled: "error", requests: 1, completed: 0, failed: 1, tools: 0 },
      "normal-missing-exhausted": {
        activity: "failed",
        settled: "error",
        requests: 2,
        completed: 0,
        failed: 1,
        tools: 0,
      },
      "responses-eof-tool": {
        activity: "completed",
        settled: "completed",
        requests: 3,
        completed: 1,
        failed: 0,
        tools: 1,
      },
      "responses-eof-exhausted": {
        activity: "failed",
        settled: "error",
        requests: 7,
        completed: 0,
        failed: 1,
        tools: 1,
      },
      "content-filter": { activity: "failed", settled: "error", requests: 1, completed: 0, failed: 1, tools: 0 },
      "content-filter-abort": { activity: "failed", settled: "error", requests: 1, completed: 0, failed: 1, tools: 0 },
      "preflight-overflow": { activity: "failed", settled: "error", requests: 0, completed: 0, failed: 1, tools: 0 },
      "error-finish": { activity: "failed", settled: "error", requests: 1, completed: 0, failed: 1, tools: 0 },
      "error-finish-empty": { activity: "failed", settled: "error", requests: 1, completed: 0, failed: 1, tools: 0 },
      "length-tool": { activity: "completed", settled: "completed", requests: 3, completed: 1, failed: 0, tools: 1 },
      "length-exhausted": { activity: "failed", settled: "error", requests: 7, completed: 0, failed: 1, tools: 1 },
      "unknown-tool": { activity: "completed", settled: "completed", requests: 3, completed: 1, failed: 0, tools: 1 },
      "final-length": { activity: "completed", settled: "completed", requests: 3, completed: 1, failed: 0, tools: 1 },
      "reasoning-only": { activity: "completed", settled: "completed", requests: 2, completed: 1, failed: 0, tools: 0 },
      "final-reasoning-only": {
        activity: "completed",
        settled: "completed",
        requests: 3,
        completed: 1,
        failed: 0,
        tools: 1,
      },
      "reasoning-delayed-hook": {
        activity: "completed",
        settled: "completed",
        requests: 2,
        completed: 1,
        failed: 0,
        tools: 1,
      },
      "sdk-tpm-tool": { activity: "completed", settled: "completed", requests: 3, completed: 1, failed: 0, tools: 1 },
      "sdk-tpm-exhausted": { activity: "failed", settled: "error", requests: 7, completed: 0, failed: 1, tools: 1 },
      "sdk-tpm-deferred": { activity: "failed", settled: "error", requests: 1, completed: 0, failed: 1, tools: 0 },
      "sdk-tpm-stop": {
        activity: "interrupted",
        settled: "interrupted",
        requests: 1,
        completed: 0,
        failed: 0,
        tools: 0,
      },
      "sdk-auth": { activity: "failed", settled: "error", requests: 1, completed: 0, failed: 1, tools: 0 },
      "sdk-quota": { activity: "failed", settled: "error", requests: 1, completed: 0, failed: 1, tools: 0 },
      "sdk-invalid": { activity: "failed", settled: "error", requests: 1, completed: 0, failed: 1, tools: 0 },
      "native-tpm-tool": {
        activity: "completed",
        settled: "completed",
        requests: 3,
        completed: 1,
        failed: 0,
        tools: 1,
      },
    }[mode]
    expect(rows).toHaveLength(1)
    if (mode === "overflow-interrupted")
      console.log(
        "OWNER_INTERRUPT_EVIDENCE " +
          JSON.stringify({
            status: rows[0].status,
            leaseUntil: rows[0].lease_until,
            lastError: rows[0].last_error,
            requests: requests.length,
            settled,
            completed: completed.length,
            failed: failed.length,
          }),
      )
    expect(rows[0].status).toBe(expected.activity)
    expect(completed).toHaveLength(expected.completed)
    expect(failed).toHaveLength(expected.failed)
    expect(settled).toEqual([{ sessionID: id, status: expected.settled }])
    expect(requests).toHaveLength(expected.requests)
    if (mode.startsWith("sdk-") || mode === "native-tpm-tool") {
      expect(successfulTools).toHaveLength(expected.tools)
      expect(switches).toEqual([])
      if (["sdk-auth", "sdk-quota", "sdk-invalid", "sdk-tpm-deferred"].includes(mode)) expect(retried).toEqual([])
      if (mode === "sdk-tpm-exhausted") expect(retried).toEqual([1, 2, 3, 4, 5])
      if (mode === "sdk-tpm-deferred") {
        expect(rows[0].last_error).toContain("Automatic retry deferred")
        expect(rows[0].last_error).toContain("600000")
        expect(stepFailures).toHaveLength(1)
      }
      if (mode === "sdk-tpm-stop") expect(retried).toEqual([1])
      if (mode === "sdk-tpm-tool" || mode === "native-tpm-tool") {
        expect(retried).toEqual([1])
        expect(requestTimes[2] - requestTimes[1]).toBeGreaterThanOrEqual(60)
        expect(JSON.stringify(JSON.parse(requests[2]).messages)).toContain("Read exactly once")
        expect(retryDetails[0]).toMatchObject({
          error: {
            statusCode: 429,
            responseHeaders: { "retry-after-ms": "60", "x-request-id": "sdk-fixture-request" },
          },
        })
      }
      if (["sdk-auth", "sdk-quota", "sdk-invalid", "sdk-tpm-exhausted"].includes(mode)) {
        expect(JSON.stringify(stepFailures)).toContain(
          mode === "sdk-auth"
            ? "provider.auth"
            : mode === "sdk-invalid"
              ? "provider.invalid-request"
              : "provider.rate-limit",
        )
        expect(JSON.stringify(stepFailures)).not.toContain("provider.context-overflow")
        expect(stepFailures[0]).toMatchObject({
          failure: { httpStatus: mode === "sdk-auth" ? 401 : mode === "sdk-invalid" ? 422 : 429, retryAfterMs: 0 },
        })
        const history = yield* SessionStore.Service.use((store) => store.context(id))
        expect(JSON.stringify(history)).toContain('"httpStatus":')
      }
    }
    if (mode.startsWith("final-forbidden"))
      expect(yield* Effect.promise(() => Bun.file(path.join(process.cwd(), "forbidden.txt")).exists())).toBe(false)
    if (
      ["structured-chain", "structured-abort", "retry-deferred", "raw-retry-deferred", "capability-schema"].includes(
        mode,
      )
    )
      expect(stepFailures).toHaveLength(1)
    if (mode === "overflow-auth") expect(rows[0].last_error).toContain("raw authentication rejection")
    if (mode === "raw-read-after-auth") expect(rows[0].last_error).toContain("genuine fixture read failure")
    if (mode === "capability-exhausted") expect(retried).toEqual([1, 2, 3, 4, 5])
    if (mode === "event-error") expect(rows[0].last_error).toContain("fixture rejection")
    if (mode !== "auth-chain" && (mode.startsWith("auth-") || mode.startsWith("quota-"))) {
      expect(rows[0].last_error).toContain(errorMessage)
      expect(retried).toEqual([])
    }
    if (mode.startsWith("structured-")) {
      expect(rows[0].last_error).toContain("StructuredOutput input does not match")
      expect(retried).toEqual([])
      expect(switches).toEqual([])
    }
    if (mode === "empty-error-budget") {
      expect(rows[0].last_error).toContain("connection reset fixture")
      expect(retryMessages.some((message) => message.includes("empty completion"))).toBe(false)
    }
    if (mode === "catalog-budget") expect(switches).toHaveLength(5)
    if (mode === "retry-deferred") {
      expect(retried).toEqual([])
      expect(rows[0].last_error).toContain("Automatic retry deferred")
      expect(rows[0].last_error).toContain("86400000")
    }
    if (
      mode === "budget-exhausted" ||
      mode === "final-exhausted" ||
      mode === "responses-eof-exhausted" ||
      mode === "length-exhausted"
    )
      expect(retried).toEqual([1, 2, 3, 4, 5])
    if (["responses-eof-tool", "length-tool", "unknown-tool", "final-length"].includes(mode)) {
      expect(successfulTools).toHaveLength(1)
      expect(JSON.stringify(JSON.parse(requests[2]).input)).toContain("Read exactly once")
      expect(JSON.stringify(JSON.parse(requests[2]).input)).toContain("Partial")
      expect(textDeltas).toContainEqual(expect.objectContaining({ delta: expect.stringContaining("Recovered") }))
    }
    if (mode === "final-length") expect(JSON.parse(requests[2]).tools ?? []).toEqual([])
    if (mode === "reasoning-delayed-hook") {
      expect(retried).toEqual([])
      expect(stepFailures).toEqual([])
      expect(switches).toEqual([])
      expect(successfulTools).toHaveLength(1)
      expect(JSON.stringify(JSON.parse(requests[1]).input)).toContain("Read exactly once")
      const history = yield* SessionStore.Service.use((store) => store.context(id))
      expect(JSON.stringify(history)).toContain("Preparing the tool")
    }
    if (mode === "reasoning-only" || mode === "final-reasoning-only") {
      expect(JSON.stringify(JSON.parse(requests.at(-1)!).input)).toContain("reasoning-only")
      const history = yield* SessionStore.Service.use((store) => store.context(id))
      expect(JSON.stringify(history)).toContain("Preserved thinking")
      expect(textDeltas).toContainEqual(expect.objectContaining({ delta: expect.stringContaining("Recovered") }))
      if (mode === "final-reasoning-only") expect(JSON.parse(requests[2]).tools ?? []).toEqual([])
    }
    if (mode.startsWith("content-filter")) {
      expect(rows[0].last_error).toContain("content filter")
      expect(retried).toEqual([])
      expect(stepFailures).toHaveLength(1)
    }
    if (mode === "auth-chain") {
      expect(switches).toHaveLength(1)
      expect(retried).toEqual([])
      expect(JSON.parse(requests[1]).model).toBe("fallback")
    }
    if (["chain-retry-success", "chain-retry-fallback", "chain-empty-retry", "chain-empty-filter", "chain-retry-stop", "chain-empty-stop"].includes(mode)) {
      expect(retried).toEqual([1])
      expect(switches).toHaveLength(mode === "chain-retry-fallback" ? 1 : 0)
      expect(requests.map((request) => JSON.parse(request).model)).toEqual(
        mode === "chain-retry-fallback" ? ["fixture", "fixture", "fallback"] : ["fixture", "fixture"],
      )
      if (mode === "chain-empty-filter") {
        expect(JSON.stringify(stepFailures)).toContain("provider.content-policy")
        expect(rows[0].last_error).toContain("content filter")
      } else expect(stepFailures).toEqual([])
    }
    if (["chain-tool", "same-tool", "patch-tool", "abort-tool", "final-partial"].includes(mode)) {
      expect(successfulTools).toHaveLength(1)
      const request = JSON.parse(requests[2]) as { model: string; messages: Array<{ role: string; content: unknown }> }
      expect(request.model).toBe(mode === "chain-tool" ? "fallback" : "fixture")
      expect(request.messages).toContainEqual(
        expect.objectContaining({
          role: "tool",
          content: expect.stringContaining(mode === "patch-tool" ? "changed.txt" : "Read exactly once"),
        }),
      )
      expect(request.messages).toContainEqual(
        expect.objectContaining({ role: "assistant", content: expect.stringContaining("Partial") }),
      )
      expect(textDeltas).toContainEqual(expect.objectContaining({ delta: expect.stringContaining("Recovered") }))
    }
    if (mode === "patch-tool")
      expect(yield* Effect.promise(() => Bun.file(path.join(process.cwd(), "changed.txt")).text())).toBe(
        "Patched exactly once\n",
      )
    yield* executionService.wake(id)
    yield* executionService.wait(id)
    expect(requests).toHaveLength(expected.requests)
    expect(completed).toHaveLength(expected.completed)
    expect(failed).toHaveLength(expected.failed)
    expect(successfulTools).toHaveLength(expected.tools)
    expect(settled).toEqual([{ sessionID: id, status: expected.settled }])
    const afterRows = yield* databaseService.db
      .select()
      .from(SessionActivityTable)
      .where(eq(SessionActivityTable.session_id, id))
      .all()
    const after = afterRows.filter((row) => !priorActivityIDs.includes(row.id))
    expect(after).toHaveLength(1)
    expect(after[0].status).toBe(rows[0].status)
    console.log(
      "PROVIDER_DRAIN_EVIDENCE " +
        JSON.stringify({
          mode,
          ...expected,
          advisoryWake: "no replay",
          textDeltas: textDeltas.length,
          retried,
          stepFailures: stepFailures.length,
        }),
    )
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(dependencies, projector, execution, access)), Effect.runPromise)
}
