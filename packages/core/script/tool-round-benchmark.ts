/**
 * Reproducible tool-round benchmark over the managed runner pipeline.
 *
 * A deterministic in-process provider runs read, then a guarded write, then a
 * short text reply per round, so every round exercises the full request
 * assembly (context epoch, history bound, tool materialization), real tool
 * execution, result storage, and the session file-mutation journal. Metrics
 * come from the existing request_assembly perf event, filtered by the
 * benchmark's own session IDs. Database, project, global data dir and blobs
 * live in one temporary directory; no user session, config or project file is
 * touched.
 *
 * Fidelity limits, stated honestly: skill/reference guidance stay empty (the
 * runner test harness mocks them the same way), and the system prompt is
 * small because the ambient instruction file is synthetic. Assembly numbers
 * therefore measure the local pipeline, not a production-size prompt. Live
 * 170-282 ms context samples from real sessions remain the reference for
 * production cost; this script attributes the local pipeline share.
 *
 * Usage (from packages/core):
 *   bun run script/tool-round-benchmark.ts --label baseline --sessions 1 --rounds 40
 *   bun run script/tool-round-benchmark.ts --write-bench
 */

import { route } from "@opencode-ai/llm/protocols/openai-chat"
import { Auth, LLMClient, RequestExecutor } from "@opencode-ai/llm/route"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Config } from "@opencode-ai/core/config"
import { ContentStore } from "@opencode-ai/core/content-store"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionRunCoordinator } from "@opencode-ai/core/session/run-coordinator"
import { SessionRunnerLLM } from "@opencode-ai/core/session/runner/llm"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { CapabilityLease } from "@opencode-ai/core/capability/lease"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionFileMutationTable } from "@opencode-ai/core/session/sql"
import { Location } from "@opencode-ai/core/location"
import { SessionToolCancellation } from "@opencode-ai/core/session/tool-cancellation"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemContextBuiltIns } from "@opencode-ai/core/system-context/builtins"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { ReadTool } from "@opencode-ai/core/tool/read"
import { WriteTool } from "@opencode-ai/core/tool/write"
import { ReadToolFileSystem } from "@opencode-ai/core/tool/read-filesystem"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { FileMutation } from "@opencode-ai/core/file-mutation"
import { Image } from "@opencode-ai/core/image"
import { SessionFileMutation } from "@opencode-ai/core/session/file-mutation"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Cause, Effect, Exit, Layer } from "effect"
import { HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { createHash } from "crypto"
import fs from "fs/promises"
import os from "os"
import path from "path"

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const value = (name: string, fallback: string) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const fail = (message: string): never => {
  console.error(`tool-round-benchmark: ${message}`)
  process.exit(1)
  throw new Error(message)
}

const label = value("--label", "run")
const sessionCount = Number(value("--sessions", "1"))
const rounds = Number(value("--rounds", "40"))
const warmupRounds = Number(value("--warmup", "5"))
const writeBenchOnly = flag("--write-bench")
// Three provider turns per round: read, guarded write, text reply.
const turnsPerRound = 3
if (!Number.isInteger(sessionCount) || sessionCount < 1 || sessionCount > 2) fail("--sessions must be 1 or 2")
if (!Number.isInteger(rounds) || rounds < 1) fail("--rounds must be a positive integer")
if (!Number.isInteger(warmupRounds) || warmupRounds < 0) fail("--warmup must be a non-negative integer")

const percentile = (samples: number[], p: number) => {
  if (samples.length === 0) return undefined
  const sorted = [...samples].toSorted((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}
const mean = (samples: number[]) => (samples.length === 0 ? undefined : samples.reduce((a, b) => a + b, 0) / samples.length)

// Deterministic provider seam: each round runs read (fixture file), then a
// guarded write (unique note file, journaled), then a short text reply. No
// network access, unlimited replays, and every round executes the real
// read, write, and journal paths.
const providerCalls = { current: 0 }
const writeCallCount = { current: 0 }
// Self-synchronizing answers: the request body decides the reply, so title
// requests or retries can never desynchronize the tool flow. Zero tool
// messages -> read call, one -> guarded write call, two or more -> text.
const readBodyText = (request: HttpClientRequest.HttpClientRequest): string | undefined => {
  const body = request.body as unknown as { readonly _tag?: string; readonly body?: unknown } | undefined
  if (!body) return undefined
  if (body._tag === "String" && typeof body.body === "string") return body.body
  if (body._tag === "Uint8Array" && body.body instanceof Uint8Array) return new TextDecoder().decode(body.body)
  return undefined
}
const countToolMessages = (raw: string): number | undefined => {
  try {
    const parsed = JSON.parse(raw) as { readonly messages?: ReadonlyArray<{ readonly role?: string }> }
    if (!Array.isArray(parsed.messages)) return undefined
    let lastUser = -1
    parsed.messages.forEach((message, index) => {
      if (message.role === "user") lastUser = index
    })
    // Only tool results after the latest user message belong to the current
    // round; older rounds must not desynchronize the read/write/text cycle.
    return parsed.messages.slice(lastUser + 1).filter((message) => message.role === "tool").length
  } catch {
    return undefined
  }
}
const fakeExecutor = Layer.succeed(
  RequestExecutor.Service,
  RequestExecutor.Service.of({
    execute: (_request) =>
      Effect.sync(() => {
        providerCalls.current += 1
        // Contract comparison across runs uses tool_count, tool_schema_bytes
        // and system_prompt_chars from request_assembly (see summary), not
        // the wire body: HttpClientRequest exposes no text accessor here.
        const sse = (json: string) => `data: ${json}\n\n`
        const step = (() => {
          const text = readBodyText(_request)
          if (text === undefined) return 0
          const counted = countToolMessages(text)
          if (counted === undefined) return 0
          return counted % 3
        })()
        if (process.env.BENCH_DEBUG_PROVIDER === "1")
          console.error(`[bench-provider] call=${providerCalls.current} toolMessages=${step} reply=${step === 0 ? "read" : step === 1 ? "write" : "text"}`)
        const toolCall =
          step === 0
            ? sse(
                '{"id":"chatcmpl-bench","object":"chat.completion.chunk","created":0,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_bench_read","type":"function","function":{"name":"read","arguments":"{\\"path\\":\\"big.txt\\",\\"limit\\":20}"}}]},"finish_reason":"tool_calls"}]}',
              )
            : step === 1
              ? sse(
                  `{"id":"chatcmpl-bench","object":"chat.completion.chunk","created":0,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_bench_write_${++writeCallCount.current}","type":"function","function":{"name":"write","arguments":"{\\"path\\":\\"note-${writeCallCount.current}.txt\\",\\"content\\":\\"benchmark note ${writeCallCount.current}\\",\\"expectedAbsent\\":true}"}}]},"finish_reason":"tool_calls"}]}`,
                )
              : sse(
                  '{"id":"chatcmpl-bench","object":"chat.completion.chunk","created":0,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"role":"assistant","content":"Done."}}]}',
                )
            const frames = [
              toolCall,
              sse(
                '{"id":"chatcmpl-bench","object":"chat.completion.chunk","created":0,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
              ),
              "data: [DONE]\n\n",
            ]
            const encoder = new TextEncoder()
            const stream = new ReadableStream<Uint8Array>({
              start(controller) {
                for (const frame of frames) controller.enqueue(encoder.encode(frame))
                controller.close()
              },
            })
            const wire = HttpClientRequest.post("https://api.openai.com/v1/chat/completions")
            return HttpClientResponse.fromWeb(
              wire,
              new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
            )
      }),
  }),
)

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.void,
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    materializationRules: () => Effect.succeed([]),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const makeLayers = (dataDir: string, projectDir: string) => {
  const database = Database.layerFromPath(":memory:")
  const events = EventV2.layer.pipe(Layer.provide(database))
  const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  const store = SessionStore.layer.pipe(Layer.provide(database))
  const executor = fakeExecutor
  const client = LLMClient.layer.pipe(Layer.provide(executor))
  const capabilityConfig = Layer.succeed(
    Config.Service,
    Config.Service.of({
      entries: () =>
        Effect.succeed([
          new Config.Document({
            type: "document",
            info: new Config.Info({ skill_capabilities: { "computer-use": ["browser_read"] } }),
          }),
        ]),
    }),
  )
  const capabilityLeases = CapabilityLease.layer.pipe(Layer.provide(capabilityConfig))
  const model = route
    .with({
      endpoint: { baseURL: "https://api.openai.com/v1" },
      auth: Auth.bearer("fixture"),
      generation: { maxTokens: 20, temperature: 0 },
    })
    .model({ id: "gpt-4o-mini" })
  const models = SessionRunnerModel.layerWith(() => Effect.succeed(model))
  const location = Location.layer({ directory: AbsolutePath.make(projectDir) }).pipe(Layer.provide(Project.defaultLayer))
  const skillGuidance = Layer.mock(SkillGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
  const referenceGuidance = Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
  const config = Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))
  const global = Global.layerWith({ data: dataDir })
  const contentStore = ContentStore.layer.pipe(
    Layer.provide(database),
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(global),
  )
  const toolOutputStore = ToolOutputStore.layer.pipe(
    Layer.provide(contentStore),
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(global),
  )
  const content = contentStore
  const registry = ToolRegistry.layer.pipe(
    Layer.provide(permission),
    Layer.provide(ApplicationTools.layer),
    Layer.provide(toolOutputStore),
    Layer.provide(capabilityLeases),
  )
  const snapshots = Layer.succeed(
    Snapshot.Service,
    Snapshot.Service.of({
      track: () => Effect.succeed(undefined),
      changedFiles: () => Effect.succeed([]),
      patch: (input) => Effect.succeed({ hash: input.hash, files: [] }),
      restore: () => Effect.void,
      revert: () => Effect.void,
      diff: () => Effect.succeed(undefined),
      diffFull: () => Effect.sync(() => []),
    }),
  )
  const mutationResolution = LocationMutation.locationLayer.pipe(
    Layer.provide(location),
    Layer.provide(store),
    Layer.provide(FSUtil.defaultLayer),
  )
  const files = FileMutation.locationLayer.pipe(Layer.provide(FSUtil.defaultLayer))
  const image = Image.layer.pipe(Layer.provide(config))
  const journal = SessionFileMutation.layer.pipe(Layer.provide(database), Layer.provide(FSUtil.defaultLayer), Layer.provide(content))
  const readWriteTools = Layer.mergeAll(
    ReadTool.layer.pipe(
      Layer.provide(registry),
      Layer.provide(ReadToolFileSystem.layer.pipe(Layer.provide(FSUtil.defaultLayer))),
      Layer.provide(mutationResolution),
      Layer.provide(image),
      Layer.provide(permission),
      Layer.provide(content),
      Layer.provide(FSUtil.defaultLayer),
      Layer.provide(global),
      Layer.provide(config),
    ),
    WriteTool.layer.pipe(
      Layer.provide(registry),
      Layer.provide(mutationResolution),
      Layer.provide(files),
      Layer.provide(permission),
      Layer.provide(journal),
      Layer.provide(config),
      Layer.provide(global),
    ),
  )
  const runner = SessionRunnerLLM.layer.pipe(
    Layer.provide(database),
    Layer.provide(store),
    Layer.provide(events),
    Layer.provide(client),
    Layer.provide(permission),
    Layer.provide(registry),
    Layer.provide(capabilityLeases),
    Layer.provide(contentStore),
    Layer.provide(toolOutputStore),
    Layer.provide(models),
    Layer.provide(SystemContextRegistry.layer),
    Layer.provide(location),
    Layer.provide(AgentV2.layer),
    Layer.provide(skillGuidance),
    Layer.provide(referenceGuidance),
    Layer.provide(snapshots),
    Layer.provide(config),
    Layer.provide(readWriteTools),
    Layer.provide(mutationResolution),
    Layer.provide(files),
  ).pipe(
    Layer.provide(image),
    Layer.provide(journal),
  )
  const coordinator = SessionRunCoordinator.layer.pipe(Layer.provide(runner))
  const execution = Layer.effect(
    SessionExecution.Service,
    Effect.gen(function* () {
      const coordinatorService = yield* SessionRunCoordinator.Service
      const cancellation = yield* SessionToolCancellation.Service
      return SessionExecution.Service.of({
        resume: coordinatorService.run,
        resumeOrJoin: coordinatorService.runOrJoin,
        wake: coordinatorService.wake,
        queueContinuation: coordinatorService.queueContinuation,
        wait: (sessionID) => coordinatorService.awaitIdle(sessionID).pipe(Effect.ignore),
        interrupt: coordinatorService.interrupt,
        interruptActivity: () => Effect.succeed(false),
        cancelTool: (sessionID, callID) => cancellation.cancel({ sessionID, callID }),
      })
    }),
  ).pipe(Layer.provide(coordinator), Layer.provide(SessionToolCancellation.layer), Layer.provide(store))
  // Same single-location wiring as the runner test harness: the runner is
  // already location-scoped; the map only serves the model-switch preflight.
  const sessionLocations = Layer.succeed(
    LocationServiceMap,
    LocationServiceMap.of({
      get: () => Layer.empty as never,
      invalidate: () => Effect.void,
    }),
  )
  const sessions = SessionV2.layer.pipe(
    Layer.provide(runner),
    Layer.provide(contentStore),
    Layer.provide(events),
    Layer.provide(database),
    Layer.provide(store),
    Layer.provide(Project.defaultLayer),
    Layer.provide(execution),
    Layer.provide(sessionLocations),
  )
  return Layer.mergeAll(
    database,
    events,
    projector,
    store,
    executor,
    client,
    permission,
    AgentV2.layer,
    registry,
    capabilityLeases,
    contentStore,
    toolOutputStore,
    models,
    SystemContextRegistry.layer,
    location,
    skillGuidance,
    referenceGuidance,
    snapshots,
    FSUtil.defaultLayer,
    global,
    config,
    readWriteTools,
    mutationResolution,
    files,
    image,
    journal,
    runner,
    coordinator,
    execution,
    sessions,
  )
}

const round = (session: SessionV2.Interface, ids: SessionV2.ID[], index: number) =>
  Effect.forEach(
    ids,
    (id) =>
      Effect.gen(function* () {
        yield* session.prompt({
          sessionID: id,
          prompt: new Prompt({ text: `benchmark round ${index}` }),
          resume: false,
        })
        yield* session.resume(id)
      }),
    { concurrency: ids.length, discard: true },
  )

const perfPath = path.join(Global.Path.log, "perf.jsonl")

const summarize = (samples: number[]) => ({
  n: samples.length,
  p50: percentile(samples, 50),
  p95: percentile(samples, 95),
  mean: mean(samples),
})

const readPerfEvents = async (since: number, sessionIDs: ReadonlySet<string>) => {
  const raw = await Bun.file(perfPath).text()
  const assemblies: Record<string, number | string>[] = []
  for (const line of raw.split("\n")) {
    if (!line) continue
    const event = JSON.parse(line) as Record<string, unknown>
    if (event.kind !== "request_assembly") continue
    const ts = Date.parse(String(event.ts))
    if (!Number.isFinite(ts) || ts < since) continue
    if (typeof event.sessionID !== "string" || !sessionIDs.has(event.sessionID)) continue
    assemblies.push(event as Record<string, number | string>)
  }
  return assemblies
}

const toolRoundProgram = Effect.gen(function* () {
  const tmp = benchTmp
  const projectDir = benchProject
  const fsUtil = yield* FSUtil.Service
  // Ambient instruction file plus fixture files; owned temp project only.
  yield* Effect.promise(() =>
    Bun.write(
      path.join(projectDir, "AGENTS.md"),
      Array.from({ length: 400 }, (_, i) => `Rule ${i}: keep tool output bounded and verify before reporting.`).join("\n") +
        "\n",
    ),
  )
  const bigLines = Array.from({ length: 200_000 }, (_, index) => `line-${index + 1}-${"x".repeat(64)}`)
  yield* Effect.promise(() => Bun.write(path.join(projectDir, "big.txt"), bigLines.join("\n") + "\n"))

  const database = yield* Database.Service
  yield* database.db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make(projectDir), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  const ids = Array.from({ length: sessionCount }, (_, index) => SessionV2.ID.make(`ses_bench_${index}`))
  yield* database.db
    .insert(SessionTable)
    .values(
      ids.map((id) => ({
        id,
        project_id: Project.ID.global,
        slug: "bench",
        directory: projectDir,
        title: "bench",
        version: "test",
      })),
    )
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)

  const session = yield* SessionV2.Service
  for (let index = 0; index < warmupRounds; index++) yield* round(session, ids, index)
  const measuredSince = Date.now()
  for (let index = 0; index < rounds; index++) yield* round(session, ids, warmupRounds + index)
  // The perf writer drains asynchronously; poll for the expected event count
  // instead of assuming a fixed sleep. Timeout is a hard error with counts.
  const owned = new Set(ids.map(String))
  const expected = rounds * sessionCount * turnsPerRound
  let assemblies: Record<string, number | string>[] = []
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    assemblies = yield* Effect.promise(() => readPerfEvents(measuredSince, owned))
    if (assemblies.length >= expected) break
    yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 250)))
  }
  if (assemblies.length !== expected)
    return yield* Effect.die(
      new Error(`expected ${expected} owned request_assembly events, found ${assemblies.length}`),
    )
  const assemblyOf = (selected: Record<string, number | string>[], field: string) =>
    selected.map((event) => Number(event[field])).filter(Number.isFinite)
  // Cold is approximately the first full round per session; ordering across
  // two parallel sessions interleaves, so this is documented, not exact.
  const cold = assemblies.slice(0, turnsPerRound * sessionCount)
  const warmAssemblies = assemblies.slice(turnsPerRound * sessionCount)
  const phaseMean = (field: string) => mean(assemblyOf(warmAssemblies, field))
  const warmAssembly = assemblyOf(warmAssemblies, "request_assembly_ms")
  const warmContext = assemblyOf(warmAssemblies, "context_epoch_ms")
  const journalRows = yield* database.db
    .select({ id: SessionFileMutationTable.id })
    .from(SessionFileMutationTable)
    .all()
    .pipe(Effect.orDie)

  // Direct read benchmarks through the real filesystem leaf: early/late page
  // of a 1 MiB and a 16 MiB file plus three parallel reads.
  const oneMiB = path.join(projectDir, "bench-1mib.txt")
  const sixteenMiB = path.join(projectDir, "bench-16mib.txt")
  yield* Effect.promise(() =>
    Bun.write(
      oneMiB,
      Array.from({ length: 14_000 }, (_, index) => `m1-${index}-${"x".repeat(64)}`).join("\n") + "\n",
    ),
  )
  yield* Effect.promise(() =>
    Bun.write(
      sixteenMiB,
      Array.from({ length: 224_000 }, (_, index) => `m16-${index}-${"x".repeat(64)}`).join("\n") + "\n",
    ),
  )
  const timeRead = (file: string, page: { offset?: number; limit?: number }) =>
    Effect.promise(async () => {
      const started = performance.now()
      const result = await Effect.runPromise(ReadToolFileSystem.read(fsUtil, file, path.basename(file), page))
      return { ms: performance.now() - started, result }
    })
  const early1 = yield* timeRead(oneMiB, { offset: 1, limit: 20 })
  const late1 = yield* timeRead(oneMiB, { offset: 13_900, limit: 20 })
  const early16 = yield* timeRead(sixteenMiB, { offset: 1, limit: 20 })
  const late16 = yield* timeRead(sixteenMiB, { offset: 223_900, limit: 20 })
  const parallelStarted = performance.now()
  yield* Effect.forEach([oneMiB, sixteenMiB, path.join(projectDir, "big.txt")], (file) =>
    Effect.promise(() => Effect.runPromise(ReadToolFileSystem.read(fsUtil, file, path.basename(file), { limit: 20 }))),
  )
  const parallelMs = performance.now() - parallelStarted

  const summary = {
    label,
    sessions: sessionCount,
    rounds,
    warmup_rounds: warmupRounds,
    env: process.env.OPENCODE_OPTIMIZATION_FEATURES ?? "",
    matched_assemblies: assemblies.length,
    expected_assemblies: expected,
    provider_calls: providerCalls.current,
    cold: {
      assembly: summarize(assemblyOf(cold, "request_assembly_ms")),
      context_epoch: summarize(assemblyOf(cold, "context_epoch_ms")),
    },
    warm: {
      assembly: summarize(warmAssembly),
      context_epoch: summarize(warmContext),
    },
    phases_mean: {
      context_source_load_ms: phaseMean("context_source_load_ms"),
      context_snapshot_decode_ms: phaseMean("context_snapshot_decode_ms"),
      context_compare_ms: phaseMean("context_compare_ms"),
      context_fence_ms: phaseMean("context_fence_ms"),
      samples: warmAssemblies.length,
    },
    contract: {
      tool_count: assemblies.length > 0 ? assemblies[assemblies.length - 1]?.tool_count : undefined,
      tool_schema_bytes: percentile(assemblyOf(warmAssemblies, "tool_schema_bytes"), 50),
      system_prompt_chars: percentile(assemblyOf(warmAssemblies, "system_prompt_chars"), 50),
      journal_rows: journalRows.length,
    },
    read_bench_ms: {
      mib1_early: early1.ms,
      mib1_late: late1.ms,
      mib16_early: early16.ms,
      mib16_late: late16.ms,
      three_parallel: parallelMs,
      early1_truncated: "truncated" in early1.result ? early1.result.truncated : undefined,
      late16_truncated: "truncated" in late16.result ? late16.result.truncated : undefined,
    },
  }
  console.log(JSON.stringify(summary, null, 2))
})

const writeBenchProgram = Effect.gen(function* () {
  const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "opencode-write-bench-")))
  const dataDir = path.join(tmp, "data")
  yield* Effect.promise(() => fs.mkdir(dataDir, { recursive: true }))
  const database = Database.layerFromPath(":memory:")
  const layers = ContentStore.layer.pipe(
    Layer.provide(database),
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(Global.layerWith({ data: dataDir })),
  )
  const result = yield* Effect.gen(function* () {
    const content = yield* ContentStore.Service
    const iteration = { current: 0 }
    const payload = () => {
      const bytes = new Uint8Array(256 * 1024).fill(65)
      bytes[iteration.current++ % bytes.length] = iteration.current % 251
      return bytes
    }
    const put = () => content.putBlob({ bytes: payload(), mime: "application/octet-stream" })
    for (let index = 0; index < 5; index++) yield* put()
    const samplesSerial: number[] = []
    for (let index = 0; index < 40; index++) {
      const started = performance.now()
      yield* put()
      samplesSerial.push(performance.now() - started)
    }
    // Rotated order on the second pass: parallel first, then serial, to avoid
    // warmup-order bias.
    yield* Effect.forEach(Array.from({ length: 40 }, () => 0), () => put(), { concurrency: 2, discard: true })
    const startedSerial2 = performance.now()
    for (let index = 0; index < 40; index++) yield* put()
    const serial2Ms = performance.now() - startedSerial2
    const startedParallel = performance.now()
    yield* Effect.forEach(Array.from({ length: 40 }, () => 0), () => put(), { concurrency: 2, discard: true })
    const parallelMs = performance.now() - startedParallel
    return {
      serial_ms_per_op: mean(samplesSerial),
      serial_p50_ms_per_op: percentile(samplesSerial, 50),
      serial_second_pass_ms_per_op: serial2Ms / 40,
      parallel_ms_per_op: parallelMs / 40,
    }
  }).pipe(Effect.provide(layers))
  console.log(JSON.stringify({ label: `${label}-write-bench`, ...result }, null, 2))
  const cleanup = yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }).then(
    () => undefined,
    (error) => `cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
  ))
  if (cleanup !== undefined) console.error(`tool-round-benchmark: ${cleanup}`)
})

const main = writeBenchOnly ? writeBenchProgram : toolRoundProgram
// One shared temp root: the Location service, session rows, global data dir and
// perf evidence must resolve to the same project directory or the runner
// interrupts the turn with a location mismatch.
const benchTmp = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-tool-round-bench-"))
const benchData = path.join(benchTmp, "data")
const benchProject = path.join(benchTmp, "project")
await fs.mkdir(path.join(benchData, "log"), { recursive: true })
await fs.mkdir(benchProject, { recursive: true })
const layers = makeLayers(benchData, benchProject)
const exit = await Effect.runPromiseExit(main.pipe(Effect.provide(layers)))
if (Exit.isFailure(exit)) {
  console.error(Cause.pretty(exit.cause))
  process.exitCode = 1
} else {
  const cleanup = await fs.rm(benchTmp, { recursive: true, force: true }).then(
    () => undefined,
    (error) => `cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
  )
  if (cleanup !== undefined) console.error(`tool-round-benchmark: ${cleanup}`)
}
