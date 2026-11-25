import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { mkdir, rm, symlink } from "node:fs/promises"
import { DateTime, Effect, Layer, Schema } from "effect"
import { z } from "zod"
import { AgentV2 } from "@opencode-ai/core/agent"
import { FanoutWorkflow } from "@opencode-ai/core/fanout-workflow"
import { Database } from "@opencode-ai/core/database/database"
import { SessionArchiveCatalogTable } from "@opencode-ai/core/archive.sql"
import { SessionArchive } from "@opencode-ai/core/session-archive"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { ModelV2 } from "@opencode-ai/core/model"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionActivityTable, SessionInputTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { EffectBridge } from "../../src/effect/bridge"
import { createPluginHost } from "../../src/plugin/host"
import { completionRegistry } from "../../src/plugin/completion"
import { PluginLoader } from "../../src/plugin/loader"
import { mediaRegistry } from "../../src/plugin/media"
import type { MediaProvider } from "@opencode-ai/plugin/media"
import { tmpdir } from "../../../core/test/fixture/tmpdir"

const layer = Layer.mergeAll(LocationServiceMap.layer, SessionV2.defaultLayer, Database.defaultLayer, EventV2.defaultLayer)

const fixture = (directory: string) => Effect.gen(function* () {
  const bridge = yield* EffectBridge.make()
  const locations = yield* LocationServiceMap
  const ref = Location.Ref.make({ directory: AbsolutePath.make(directory) })
  const disposers: Array<() => Promise<void>> = []
  yield* Effect.addFinalizer(() => Effect.promise(() => Promise.all(disposers.map((dispose) => dispose()))))
  return {
    bridge, locations, ref,
    first: createPluginHost({ pluginID: "neutral-first", directory, bridge, disposers }),
    firstDuplicate: createPluginHost({ pluginID: "neutral-first", directory, bridge, disposers }),
    second: createPluginHost({ pluginID: "neutral-second", directory, bridge, disposers }),
  }
})

describe("server plugin host", () => {
  test("Goal status CAS and admission fence metadata replacement and persist the exact receipt", async () => {
    await using directory = await tmpdir()
    await Effect.runPromise(Effect.gen(function* () {
      const f = yield* fixture(directory.path)
      const sessions = yield* SessionV2.Service
      const session = yield* sessions.create({ title: "Goal atomic state", location: f.ref })
      const status = JSON.stringify({ runID: "run-1", stopped: false })
      yield* sessions.patchMetadata({ sessionID: session.id, patch: { set: { "opencode.session.goal": "ship it", "opencode.session.goal_run": "run-1" } } })
      const project = { sessionID: session.id, condition: "ship it", runID: "run-1", status }
      expect(yield* Effect.promise(() => f.first.host.sessions.goalOwnership.project!(project))).toBe(true)
      expect(yield* Effect.promise(() => f.first.host.sessions.goalOwnership.project!({ ...project, status: "stale" }))).toBe(false)
      yield* sessions.patchMetadata({ sessionID: session.id, patch: { set: { "opencode.session.goal_run": "run-2" }, unset: ["opencode.session.goal_status"] } })
      yield* Effect.promise(async () => expect(f.first.host.sessions.prompt({ sessionID: session.id, text: "stale", expectedLatestInputID: null,
        goal: { condition: "ship it", runID: "run-1", expectedStatus: status, status },
      })).rejects.toMatchObject({ _tag: "SessionBusyError" }))
      const admitted = yield* Effect.promise(() => f.first.host.sessions.prompt({ sessionID: session.id, text: "fresh", expectedLatestInputID: null,
        goal: { condition: "ship it", runID: "run-2", status: JSON.stringify({ runID: "run-2", stopped: false }) },
      }))
      expect(JSON.parse(admitted.goalStatus!).active).toEqual({ promptID: admitted.id })
      expect((yield* sessions.get(session.id)).metadata?.["opencode.session.goal_status"]).toBe(admitted.goalStatus)
      expect(yield* Effect.promise(() => f.first.host.sessions.inputOrigin({ sessionID: session.id, inputID: admitted.id }))).toBe("plugin")
      yield* Effect.promise(() => f.first.dispose())
      expect(f.first.host.signal?.aborted).toBe(true)
      yield* Effect.promise(async () => expect(f.first.host.sessions.goalOwnership.project!({ ...project, runID: "run-2", expectedStatus: admitted.goalStatus })).rejects.toThrow("unloaded"))
    }).pipe(Effect.provide(layer), Effect.scoped))
  }, 30_000)
  test("Goal cleanup and automatic admission reject stale run and inbox identities", async () => {
    await using directory = await tmpdir()
    await Effect.runPromise(Effect.gen(function* () {
      const f = yield* fixture(directory.path)
      const sessions = yield* SessionV2.Service
      const session = yield* sessions.create({ title: "Goal fences", location: f.ref })
      yield* sessions.patchMetadata({ sessionID: session.id, patch: { set: { "opencode.session.goal": "ship it", "opencode.session.goal_run": "new-run", "opencode.session.goal_status": "new-status" } } })
      yield* Effect.promise(() => f.first.host.sessions.goalOwnership.clear!({ sessionID: session.id, condition: "ship it", runID: "old-run" }))
      expect((yield* sessions.get(session.id)).metadata?.["opencode.session.goal"]).toBe("ship it")
      expect((yield* sessions.get(session.id)).metadata?.["opencode.session.goal_status"]).toBe("new-status")
      yield* Effect.promise(() => f.first.host.sessions.goalOwnership.clear!({ sessionID: session.id, condition: "different objective", runID: "new-run" }))
      expect((yield* sessions.get(session.id)).metadata?.["opencode.session.goal_run"]).toBe("new-run")
      yield* Effect.promise(() => f.first.host.sessions.goalOwnership.clear!({ sessionID: session.id, condition: "ship it", runID: "new-run" }))
      const cleared = (yield* sessions.get(session.id)).metadata
      expect(cleared?.["opencode.session.goal"]).toBeUndefined()
      expect(cleared?.["opencode.session.goal_run"]).toBeUndefined()
      expect(cleared?.["opencode.session.goal_status"]).toBeUndefined()
      const head = yield* Effect.promise(() => f.first.host.sessions.admissionHead!({ sessionID: session.id }))
      expect(head.id).toBeNull()
      const human = yield* sessions.prompt({ sessionID: session.id, prompt: { text: "Wait, new instruction" }, origin: "interactive", resume: false })
      yield* Effect.promise(async () => expect(f.first.host.sessions.prompt({ sessionID: session.id, text: "Stale continuation", expectedLatestInputID: head.id })).rejects.toThrow())
      const { db } = yield* Database.Service
      const rows = yield* db.select().from(SessionInputTable).all().pipe(Effect.orDie)
      expect(rows.map((item) => item.id)).toEqual([human.id])
      expect((yield* Effect.promise(() => f.first.host.sessions.admissionHead!({ sessionID: session.id }))).id).toBe(human.id)
    }).pipe(Effect.provide(layer), Effect.scoped))
  }, 30_000)
  test("plugin prompt preserves validated output format and noninteractive provenance", async () => {
    await using directory = await tmpdir()
    await Effect.runPromise(Effect.gen(function* () {
      const f = yield* fixture(directory.path)
      const session = yield* (yield* SessionV2.Service).create({ title: "Goal format", location: f.ref })
      const format = { type: "json_schema" as const, schema: { type: "object", properties: { done: { type: "boolean" } }, required: ["done"], additionalProperties: false } }
      const admitted = yield* Effect.promise(() => f.first.host.sessions.prompt({ sessionID: session.id, text: "Verify", format }))
      const { db } = yield* Database.Service
      const rows = yield* db.select().from(SessionInputTable).all().pipe(Effect.orDie)
      const row = rows.find((item) => item.id === admitted.id)
      expect(row?.prompt.format).toEqual(format)
      expect(row?.origin).toBe("plugin")
      yield* Effect.promise(async () => expect(f.first.host.sessions.prompt({ sessionID: session.id, text: "Bad format", format: { type: "invalid" } })).rejects.toThrow())
      const after = yield* db.select().from(SessionInputTable).all().pipe(Effect.orDie)
      expect(after).toHaveLength(rows.length)
    }).pipe(Effect.provide(layer), Effect.scoped))
  }, 30_000)
  test("loads a separate media package and isolates credentials, project scope and cancellation", async () => {
    await using directory = await tmpdir()
    await Effect.runPromise(Effect.gen(function* () {
      const f = yield* fixture(directory.path)
      const spec = new URL("../../../../../opencode-openrouter-media/",import.meta.url).href
      const resolved = yield* Effect.promise(() => PluginLoader.resolve({spec,options:undefined,deprecated:false},"server"))
      if (!resolved.ok) throw new Error(`Media resolve failed: ${JSON.stringify(resolved)}`)
      const loaded = yield* Effect.promise(() => PluginLoader.load(resolved.value))
      if (!loaded.ok) throw loaded.error
      const entry = loaded.value.mod.default as {server(input: {host: typeof f.first.host}): Promise<unknown>}
      yield* Effect.promise(() => entry.server({host:f.first.host}))
      const openrouter = mediaRegistry.list(directory.path)[0]
      expect(openrouter.providerID).toBe("openrouter")
      yield* Effect.promise(async () => expect(openrouter.transcription!.transcribe({provider:{id:"openrouter",options:{}},modelID:"qwen/qwen3-asr",audio:new Uint8Array([1]),mimeType:"audio/wav"})).rejects.toMatchObject({code:"missing_credentials"}))
      expect(mediaRegistry.list(`${directory.path}/elsewhere`)).toEqual([])
      const received: MediaProvider[] = []
      const started = Promise.withResolvers<AbortSignal>()
      let cancelled = false
      yield* Effect.promise(() => f.second.host.media.register({providerID:"neutral-media",speech:{...{privateToken:"speech-secret"},supports:() => true,async speak(input) {
        received.push(input.provider)
        return {providerID:input.provider.id,modelID:input.modelID,format:"mp3",mimeType:"audio/mpeg",voice:input.voice,stream:new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array([1,2]))},cancel(){cancelled=true}})}
      }},transcription:{...{privateToken:"transcription-secret"},supports:() => true,transcribe(input){received.push(input.provider);started.resolve(input.signal!);return new Promise(() => {})}}}))
      const neutral = mediaRegistry.list(directory.path).find((item) => item.providerID === "neutral-media")!
      expect(Object.keys(neutral.speech!).sort()).toEqual(["speak","supports"])
      expect(Object.keys(neutral.transcription!).sort()).toEqual(["supports","transcribe"])
      const provider = {id:"neutral-media",key:"own-only",options:{baseURL:"https://example.invalid"},models:{hidden:"not part of public DTO"}}
      const speech = yield* Effect.promise(() => neutral.speech!.speak({provider,modelID:"speaker",text:"Hallo",voice:"local"}))
      const reader = speech.stream.getReader()
      expect([...(yield* Effect.promise(() => reader.read())).value!]).toEqual([1,2])
      const pending = neutral.transcription!.transcribe({provider,modelID:"recognizer",audio:new Uint8Array([1]),mimeType:"audio/wav"}).then(() => undefined,(error: unknown) => error)
      const signal = yield* Effect.promise(() => started.promise)
      yield* Effect.promise(async () => expect(neutral.speech!.speak({provider:{...provider,id:"openrouter"},modelID:"speaker",text:"No",voice:"local"})).rejects.toThrow("identity mismatch"))
      expect(received.every((item) => Object.keys(item).sort().join(",") === "id,key,options")).toBe(true)
      yield* Effect.promise(() => f.second.dispose())
      expect(signal.aborted).toBe(true)
      expect(yield* Effect.promise(() => pending)).toMatchObject({name:"AbortError"})
      yield* Effect.promise(async () => expect(reader.read()).rejects.toMatchObject({name:"AbortError"}))
      expect(cancelled).toBe(true)
      expect(mediaRegistry.list(directory.path).map((item) => item.providerID)).toEqual(["openrouter"])
      yield* Effect.promise(() => f.first.dispose())
      expect(mediaRegistry.list(directory.path)).toEqual([])
    }).pipe(Effect.provide(layer),Effect.scoped))
  },30_000)
  test("loads independent workflow packages and releases only the unloading owner's registrations", async () => {
    await using directory = await tmpdir()
    await Effect.runPromise(Effect.gen(function* () {
      const f = yield* fixture(directory.path)
      const workflows = yield* FanoutWorkflow.Service.pipe(Effect.provide(f.locations.get(f.ref)))
      for (const [name, binding] of [["opencode-review", f.first], ["opencode-problem-solver", f.second]] as const) {
        const spec = new URL(`../../../../../${name}/`, import.meta.url).href
        const resolved = yield* Effect.promise(() => PluginLoader.resolve({spec, options:undefined,deprecated:false}, "server"))
        if (!resolved.ok) throw new Error(`Plugin resolve failed: ${JSON.stringify(resolved)}`)
        const loaded = yield* Effect.promise(() => PluginLoader.load(resolved.value))
        if (!loaded.ok) throw loaded.error
        const entry = loaded.value.mod.default as {server(input: {host: typeof binding.host}): Promise<unknown>}
        expect(yield* Effect.promise(() => entry.server({host:binding.host}))).toEqual({})
        if (name === "opencode-review") expect(yield* Effect.promise(() => entry.server({host:f.firstDuplicate.host}))).toEqual({})
      }
      expect(workflows.command("/multi-agent-review")?.id).toBe("review")
      expect(workflows.command("/multi-agent-problem-solver")?.configKey).toBe("problem_solver")
      expect(workflows.agent("review-agent")).toBe("review")
      expect(workflows.get("review")?.decode('{"findings":[],"notes":[]}')).toEqual({findings:[],notes:[]})
      expect(workflows.get("review")?.decode('{"findings":[{"confidence":2}],"notes":[]}')).toBeUndefined()
      const neutral = {id:"neutral",configKey:"custom",agentID:"neutral-agent",commands:["/neutral"],tools:["read"],resultSchema:{type:"object",properties:{answer:{type:"string"}},required:["answer"]}}
      yield* Effect.promise(async () => expect(f.second.host.fanout.register({...neutral,commands:["/multi-agent-review"]})).rejects.toThrow("already registered"))
      yield* Effect.promise(async () => expect(f.second.host.fanout.register({...neutral,agentAliases:["review-agent"]})).rejects.toThrow("already registered"))
      yield* Effect.promise(async () => expect(f.second.host.fanout.register({...neutral,configKey:"max_threads"})).rejects.toThrow("Invalid"))
      yield* Effect.promise(() => f.second.host.fanout.register(neutral))
      expect(workflows.get("neutral")?.decode('{"answer":"valid"}')).toEqual({answer:"valid"})
      expect(workflows.get("neutral")?.decode('{"answer":3}')).toBeUndefined()
      yield* Effect.promise(() => f.first.dispose())
      expect(workflows.command("/multi-agent-review")?.id).toBe("review")
      yield* Effect.promise(() => f.firstDuplicate.dispose())
      expect(workflows.command("/multi-agent-review")).toBeUndefined()
      expect(workflows.agent("review-agent")).toBe("review")
      expect(workflows.get("neutral")).toBeDefined()
      yield* Effect.promise(() => f.second.dispose())
      expect(workflows.agent("review-agent")).toBe("review-agent")
      expect(workflows.get("neutral")).toBeUndefined()
      expect(workflows.get("problem_solver")).toBeUndefined()
      yield* Effect.promise(async () => expect(f.first.host.fanout.register(neutral)).rejects.toThrow("unloaded"))
    }).pipe(Effect.provide(layer), Effect.scoped))
  }, 30_000)
  test("shares plugin workflows with workspace-scoped session locations", async () => {
    await using directory = await tmpdir()
    await Effect.runPromise(Effect.gen(function* () {
      const f = yield* fixture(directory.path)
      const workspace = WorkspaceV2.ID.make("wrk-review")
      const projectLocation = f.locations.get(f.ref)
      const workspaceLocation = f.locations.get(Location.Ref.make({
        directory: AbsolutePath.make(directory.path),
        workspaceID: workspace,
      }))
      const workflows = yield* FanoutWorkflow.Service.pipe(Effect.provide(projectLocation))
      const workspaceWorkflows = yield* FanoutWorkflow.Service.pipe(Effect.provide(workspaceLocation))
      yield* Effect.promise(() => f.first.host.fanout.register({
        id: "review",
        configKey: "review",
        agentID: "review",
        agentAliases: ["review-agent"],
        commands: ["/multi-agent-review"],
        tools: ["read"],
        resultSchema: { type: "object" },
      }))
      expect(workflows.agent("review-agent")).toBe("review")
      expect(workspaceWorkflows.agent("review-agent")).toBe("review")
      yield* Effect.promise(() => f.first.dispose())
      expect(workspaceWorkflows.agent("review-agent")).toBe("review-agent")
    }).pipe(Effect.provide(layer), Effect.scoped))
  }, 30_000)
  test("reads active and archived identities only in its location and cleans up completion policies", async () => {
    await using directory = await tmpdir()
    await Effect.runPromise(Effect.gen(function* () {
      const f = yield* fixture(directory.path)
      const sessions = yield* SessionV2.Service
      const session = yield* sessions.create({ title: "Visible", location: f.ref })
      const foreign = yield* sessions.create({ title: "Foreign", location: Location.Ref.make({ directory: AbsolutePath.make(`${directory.path}/foreign`) }) })
      expect(yield* Effect.promise(() => f.first.host.sessions.exists(session.id))).toBe(true)
      expect(yield* Effect.promise(() => f.first.host.sessions.exists(foreign.id))).toBe(false)
      expect(yield* Effect.promise(() => f.first.host.sessions.exists("ses_missing"))).toBe(false)
      expect(yield* Effect.promise(() => f.first.host.sessions.execution.read({sessionID:session.id,messageID:"msg_missing"}))).toEqual({phase:"admission_missing"})
      yield* Effect.promise(async () => expect(f.first.host.sessions.execution.read({sessionID:foreign.id,messageID:"msg_missing"})).rejects.toThrow("another plugin location"))
      const readMainTask = f.first.host.sessions.execution.readMainTask!
      const attempt = { parentSessionID: session.id, sessionID: session.id, messageID: "msg_missing",
        dispatchDigest: "a".repeat(64), placementIdentity: "fixture-checkout" }
      expect(yield* Effect.promise(() => readMainTask(attempt))).toEqual({ phase: "task_binding_mismatch" })
      for (const binding of [{ ...attempt, parentSessionID: foreign.id }, { ...attempt, sessionID: foreign.id }]) {
        yield* Effect.promise(async () => expect(readMainTask(binding)).rejects.toThrow("another plugin location"))
      }
      const archived = SessionV2.ID.create()
      const database = yield* Database.Service
      const child = yield* sessions.create({ title: "Native task fixture", parentID: session.id, location: f.ref })
      const admitted = yield* sessions.prompt({ sessionID: child.id, prompt: { text: "Bound input" }, resume: false })
      const bound = { ...attempt, sessionID: child.id, messageID: admitted.id }
      yield* database.db.update(SessionTable).set({ fork_dispatch_digest: bound.dispatchDigest, agent_policy: {
        tools: { mode: "explicit", entries: {} }, permissionLayers: [],
        source: { type: "task", sessionID: session.id, agent: AgentV2.ID.make("build") },
        executionPlacement: { version: 1, directory: directory.path, checkout: directory.path, identity: bound.placementIdentity },
        mainWriteConsent: { version: 1, permissionID: "per_fixture", inputID: bound.messageID,
          dispatchDigest: bound.dispatchDigest, placementIdentity: bound.placementIdentity },
      } }).where(eq(SessionTable.id, child.id)).run()
      expect(yield* Effect.promise(() => readMainTask(bound))).toEqual({ phase: "admitted" })
      expect(yield* Effect.promise(() => readMainTask({ ...bound, messageID: attempt.messageID })))
        .toEqual({ phase: "task_binding_mismatch" })
      expect(yield* database.db.select().from(SessionActivityTable).where(eq(SessionActivityTable.session_id, child.id)).all()).toEqual([])
      const inputs = yield* database.db.select().from(SessionInputTable).where(eq(SessionInputTable.session_id, child.id)).all()
      expect(inputs.map((row) => row.id)).toEqual([admitted.id])
      yield* database.db.insert(SessionArchiveCatalogTable).values({
        session_id: archived, project_id: "global", title: "Archived", directory: directory.path, location: "archived",
        time_created: 1, time_updated: 1, time_last_modified: 1,
      }).run().pipe(Effect.orDie)
      expect(yield* Effect.promise(() => f.first.host.sessions.exists(archived))).toBe(true)
      yield* Effect.promise(() => f.first.host.sessions.completion.register(async () => "incomplete"))
      expect(yield* Effect.promise(() => completionRegistry.check(directory.path,{sessionID:session.id,messages:[]}))).toBe("incomplete")
      yield* Effect.promise(() => f.first.dispose())
      expect(yield* Effect.promise(() => completionRegistry.check(directory.path,{sessionID:session.id,messages:[]}))).toBeUndefined()
      yield* Effect.promise(async () => expect(readMainTask(attempt)).rejects.toThrow("unloaded"))
    }).pipe(Effect.provide(SessionArchive.layer({directory:`${directory.path}/archive`,isIdle:()=>Effect.succeed(true)}).pipe(Layer.provideMerge(layer))), Effect.scoped))
  }, 30_000)
  test.skipIf(process.platform !== "win32")("accepts case and separator drift of the same plugin location", async () => {
    await using directory = await tmpdir()
    await Effect.runPromise(Effect.gen(function* () {
      const f = yield* fixture(directory.path)
      const sessions = yield* SessionV2.Service
      const drifted = directory.path.replaceAll("\\", "/").toUpperCase()
      const session = yield* sessions.create({ title: "Drifted location", location: Location.Ref.make({ directory: AbsolutePath.make(drifted) }) })
      expect(yield* Effect.promise(() => f.first.host.sessions.exists(session.id))).toBe(true)
      expect((yield* Effect.promise(() => f.first.host.sessions.admissionHead!({ sessionID: session.id }))).id).toBeNull()
      const foreign = yield* sessions.create({ title: "Foreign location", location: Location.Ref.make({ directory: AbsolutePath.make(`${directory.path}/foreign`) }) })
      expect(yield* Effect.promise(() => f.first.host.sessions.exists(foreign.id))).toBe(false)
      yield* Effect.promise(async () => expect(f.first.host.sessions.admissionHead!({ sessionID: foreign.id })).rejects.toThrow("another plugin location"))
    }).pipe(Effect.provide(layer), Effect.scoped))
  }, 30_000)
  test.skipIf(process.platform !== "win32")("resolves junction aliases of the same plugin location", async () => {
    await using directory = await tmpdir()
    const alias = `${directory.path}-junction-alias`
    try {
      await symlink(directory.path, alias, "junction")
      await Effect.runPromise(Effect.gen(function* () {
        const f = yield* fixture(directory.path)
        const sessions = yield* SessionV2.Service
        const session = yield* sessions.create({ title: "Aliased location", location: Location.Ref.make({ directory: AbsolutePath.make(alias) }) })
        expect(yield* Effect.promise(() => f.first.host.sessions.exists(session.id))).toBe(true)
        expect((yield* Effect.promise(() => f.first.host.sessions.admissionHead!({ sessionID: session.id }))).id).toBeNull()
      }).pipe(Effect.provide(layer), Effect.scoped))
    } finally {
      await rm(alias, { force: true, recursive: true })
    }
  }, 30_000)
  test.skipIf(process.platform === "win32")("rejects case-different POSIX directories and accepts symlink aliases", async () => {
    await using directory = await tmpdir()
    const upper = `${directory.path}/PROJ`
    const lower = `${directory.path}/proj`
    const alias = `${directory.path}/alias`
    try {
      await mkdir(upper, { recursive: true })
      await mkdir(lower, { recursive: true })
      await symlink(directory.path, alias, "dir")
      await Effect.runPromise(Effect.gen(function* () {
        const f = yield* fixture(directory.path)
        const sessions = yield* SessionV2.Service
        // Two existing siblings differing only by case are distinct projects:
        // the case fold must never run on POSIX roots (win32.isAbsolute
        // claims those), and realpath must not equate them either.
        const sibling = yield* sessions.create({ title: "Case sibling", location: Location.Ref.make({ directory: AbsolutePath.make(upper) }) })
        expect(yield* Effect.promise(() => f.first.host.sessions.exists(sibling.id))).toBe(false)
        yield* Effect.promise(async () => expect(f.first.host.sessions.admissionHead!({ sessionID: sibling.id })).rejects.toThrow("another plugin location"))
        const aliased = yield* sessions.create({ title: "Symlink alias", location: Location.Ref.make({ directory: AbsolutePath.make(alias) }) })
        expect(yield* Effect.promise(() => f.first.host.sessions.exists(aliased.id))).toBe(true)
        expect((yield* Effect.promise(() => f.first.host.sessions.admissionHead!({ sessionID: aliased.id }))).id).toBeNull()
      }).pipe(Effect.provide(layer), Effect.scoped))
    } finally {
      await rm(alias, { force: true })
    }
  }, 30_000)
  test("keeps neutral agent/tool registrations alive and removes them on unload", async () => {
    await using directory = await tmpdir()
    await Effect.runPromise(Effect.gen(function* () {
      const f = yield* fixture(directory.path)
      const agents = yield* AgentV2.Service.pipe(Effect.provide(f.locations.get(f.ref)))
      const registry = yield* ToolRegistry.Service.pipe(Effect.provide(f.locations.get(f.ref)))
      const sessions = yield* SessionV2.Service
      const calls: Array<{ text: string; callID: string; directory: string }> = []
      const entered = Promise.withResolvers<void>()
      let cancelled = false
      yield* Effect.promise(() => f.first.host.agents.register({ id: "neutral-agent", system: "Neutral test agent",
        permissions: [{ action: "neutral_tool", resource: "*", effect: "allow" }] }))
      yield* Effect.promise(() => f.first.host.tools.register({ neutral_tool: {
        description: "Neutral test tool", args: { text: z.string() },
        async execute(input, context) {
          calls.push({ text: String(input.text), callID: context.callID, directory: context.directory })
          if (input.text === "wait") {
            entered.resolve()
            await new Promise<void>((resolve) => context.abort.addEventListener("abort", () => { cancelled = true; resolve() }, { once: true }))
          }
          return `neutral:${input.text}`
        },
      } }))
      expect((yield* agents.get(AgentV2.ID.make("neutral-agent")))?.system).toBe("Neutral test agent")
      const session = yield* sessions.create({ title: "Neutral", agent: AgentV2.ID.make("neutral-agent"), location: f.ref })
      const materialized = yield* registry.materialize([{ action: "neutral_tool", resource: "*", effect: "allow" }])
      expect(materialized.definitions.some((item) => item.name === "neutral_tool")).toBe(true)
      const context = { sessionID: session.id, agent: AgentV2.ID.make("neutral-agent"), assistantMessageID: SessionMessage.ID.make("msg_neutral") }
      const result = yield* materialized.settle({ ...context, call: { type: "tool-call", id: "call_valid", name: "neutral_tool", input: { text: "hello" } } })
      expect(JSON.stringify(result)).toContain("neutral:hello")
      yield* materialized.settle({ ...context, call: { type: "tool-call", id: "call_invalid", name: "neutral_tool", input: { text: 42 } } })
      expect(calls).toEqual([{ text: "hello", callID: "call_valid", directory: directory.path }])
      const running = f.bridge.promise(materialized.settle({ ...context, call: { type: "tool-call", id: "call_wait", name: "neutral_tool", input: { text: "wait" } } }))
      yield* Effect.promise(() => entered.promise)
      yield* Effect.promise(() => f.first.dispose())
      yield* Effect.promise(() => running)
      expect(cancelled).toBe(true)
      expect(yield* agents.get(AgentV2.ID.make("neutral-agent"))).toBeUndefined()
      expect((yield* registry.materialize()).definitions.some((item) => item.name === "neutral_tool")).toBe(false)
      yield* Effect.promise(async () => expect(f.first.host.sessions.links.get(session.id)).rejects.toThrow("unloaded"))
      yield* Effect.promise(async () => expect(f.first.host.agents.register({ id: "after-unload", system: "No" })).rejects.toThrow("unloaded"))
      yield* Effect.promise(() => f.first.dispose())
    }).pipe(Effect.provide(layer), Effect.scoped))
  }, 30_000)

  test("keeps an always-visible protocol tool materialized after the plugin unloads", async () => {
    await using directory = await tmpdir()
    await Effect.runPromise(Effect.gen(function* () {
      const f = yield* fixture(directory.path)
      const registry = yield* ToolRegistry.Service.pipe(Effect.provide(f.locations.get(f.ref)))
      yield* Effect.promise(() => f.first.host.tools.register({ persistent_protocol_tool: {
        description: "Protocol tool that must survive plugin reloads",
        alwaysVisible: true,
        args: { text: z.string() },
        async execute(input) {
          return `persistent:${input.text}`
        },
      } }))
      expect((yield* registry.materialize()).definitions.some((item) => item.name === "persistent_protocol_tool")).toBe(true)
      yield* Effect.promise(() => f.first.dispose())
      expect((yield* registry.materialize()).definitions.some((item) => item.name === "persistent_protocol_tool")).toBe(true)
    }).pipe(Effect.provide(layer), Effect.scoped))
  }, 30_000)

  test("keeps an always-visible protocol tool materialized after the location scope is evicted", async () => {
    await using directory = await tmpdir()
    await Effect.runPromise(Effect.gen(function* () {
      const f = yield* fixture(directory.path)
      const registry = yield* ToolRegistry.Service.pipe(Effect.provide(f.locations.get(f.ref)))
      yield* Effect.promise(() => f.first.host.tools.register({
        evicted_scoped_tool: {
          description: "Scoped tool that must vanish with the location scope",
          args: { text: z.string() },
          async execute(input) {
            return `scoped:${input.text}`
          },
        },
        evicted_protocol_tool: {
          description: "Protocol tool that must survive location scope eviction",
          alwaysVisible: true,
          args: { text: z.string() },
          async execute(input) {
            return `protocol:${input.text}`
          },
        },
      }))
      expect((yield* registry.materialize()).definitions.some((item) => item.name === "evicted_protocol_tool")).toBe(true)
      yield* f.locations.invalidate(f.ref)
      const fresh = yield* ToolRegistry.Service.pipe(Effect.provide(f.locations.get(f.ref)))
      const materialized = yield* fresh.materialize()
      expect(materialized.definitions.some((item) => item.name === "evicted_protocol_tool")).toBe(true)
      expect(materialized.definitions.some((item) => item.name === "evicted_scoped_tool")).toBe(false)
    }).pipe(Effect.provide(layer), Effect.scoped))
  }, 30_000)

  test("removes an always-visible protocol tool after unload and eviction but re-registers a fresh host", async () => {
    await using directory = await tmpdir()
    await Effect.runPromise(Effect.gen(function* () {
      const f = yield* fixture(directory.path)
      const registry = yield* ToolRegistry.Service.pipe(Effect.provide(f.locations.get(f.ref)))
      yield* Effect.promise(() => f.first.host.tools.register({ disposal_protocol_tool: {
        description: "Protocol tool that must disappear once its plugin unloads and the location is evicted",
        alwaysVisible: true,
        args: { text: z.string() },
        async execute(input) {
          return `disposal:${input.text}`
        },
      } }))
      expect((yield* registry.materialize()).definitions.some((item) => item.name === "disposal_protocol_tool")).toBe(true)
      yield* Effect.promise(() => f.first.dispose())
      yield* f.locations.invalidate(f.ref)
      const fresh = yield* ToolRegistry.Service.pipe(Effect.provide(f.locations.get(f.ref)))
      expect((yield* fresh.materialize()).definitions.some((item) => item.name === "disposal_protocol_tool")).toBe(false)
      yield* Effect.promise(() => f.second.host.tools.register({ disposal_protocol_tool: {
        description: "Fresh owner of the protocol tool name",
        alwaysVisible: true,
        args: { text: z.string() },
        async execute(input) {
          return `disposal:${input.text}`
        },
      } }))
      expect((yield* fresh.materialize()).definitions.some((item) => item.name === "disposal_protocol_tool")).toBe(true)
    }).pipe(Effect.provide(layer), Effect.scoped))
  }, 30_000)

  test("rolls back a failed colliding registration without poisoning either plugin", async () => {
    await using directory = await tmpdir()
    await Effect.runPromise(Effect.gen(function* () {
      const f = yield* fixture(directory.path)
      const agents = yield* AgentV2.Service.pipe(Effect.provide(f.locations.get(f.ref)))
      yield* Effect.promise(() => f.first.host.agents.register({ id: "shared-agent", system: "First owner" }))
      yield* Effect.promise(async () => expect(f.second.host.agents.register({ id: "shared-agent", system: "Replacement" })).rejects.toThrow("already registered"))
      yield* Effect.promise(() => f.second.host.agents.register({ id: "independent-agent", system: "Second owner" }))
      expect((yield* agents.get(AgentV2.ID.make("shared-agent")))?.system).toBe("First owner")
      yield* Effect.promise(() => f.second.dispose())
      expect(yield* agents.get(AgentV2.ID.make("independent-agent"))).toBeUndefined()
      expect((yield* agents.get(AgentV2.ID.make("shared-agent")))?.system).toBe("First owner")
      yield* Effect.promise(() => f.first.dispose())
      expect(yield* agents.get(AgentV2.ID.make("shared-agent"))).toBeUndefined()
    }).pipe(Effect.provide(layer), Effect.scoped))
  }, 30_000)

  test("rejects a linked target outside the plugin location before creating a source", async () => {
    await using directory = await tmpdir()
    await Effect.runPromise(Effect.gen(function* () {
      const f = yield* fixture(directory.path)
      const sessions = yield* SessionV2.Service
      const target = yield* sessions.create({ title: "Foreign target", location: Location.Ref.make({ directory: AbsolutePath.make(`${directory.path}/foreign`) }) })
      const sourceSessionID = SessionV2.ID.create()
      yield* Effect.promise(async () => expect(f.first.host.sessions.links.start({ sourceSessionID, targetSessionID: target.id, agent: "build", permissionPolicy: "single-use" })).rejects.toThrow("another plugin location"))
      expect((yield* sessions.get(sourceSessionID).pipe(Effect.option))._tag).toBe("None")
      expect(yield* Effect.promise(() => f.first.host.sessions.links.get(target.id))).toBeUndefined()
    }).pipe(Effect.provide(layer), Effect.scoped))
  }, 30_000)

  test("binds session ownership to the loader and rejects forged owner fields", async () => {
    await using directory = await tmpdir()
    await Effect.runPromise(Effect.gen(function* () {
      const f = yield* fixture(directory.path)
      const sessions = yield* SessionV2.Service
      const target = yield* sessions.create({ title: "Target", location: f.ref })
      const sourceSessionID = SessionV2.ID.create()
      yield* Effect.promise(() => f.first.host.sessions.links.start({ sourceSessionID, targetSessionID: target.id, agent: "build", permissionPolicy: "single-use" }))
      expect(yield* Effect.promise(() => f.first.host.sessions.links.get(target.id))).toEqual({ sourceSessionID, targetSessionID: target.id })
      expect(yield* Effect.promise(() => f.second.host.sessions.links.get(target.id))).toBeUndefined()
      const message = new SessionMessage.Assistant({ id: SessionMessage.ID.create(), type: "assistant", agent: "build",
        model: Schema.decodeUnknownSync(ModelV2.Ref)({ providerID: "fixture", id: "fixture" }), content: [], time: { created: DateTime.makeUnsafe(Date.now()) } })
      const encoded = Schema.encodeSync(SessionMessage.Message)(message)
      const { id, type, ...data } = encoded
      yield* (yield* Database.Service).db.insert(SessionMessageTable).values({ id: SessionMessage.ID.make(id), type, session_id: sourceSessionID, seq: 1, data }).run().pipe(Effect.orDie)
      const request = { sourceSessionID, sourceMessageID: message.id, sourceCallID: "call_owner", text: "Inspect target", pluginID: "neutral-first" }
      yield* Effect.promise(async () => expect(f.second.host.sessions.dispatch.send(request)).rejects.toThrow())
      const receipt = yield* Effect.promise(() => f.first.host.sessions.dispatch.send(request))
      expect(receipt.sessionID).toBe(target.id)
      expect(receipt.delivery).toBe("steer")
      expect(yield* Effect.promise(() => f.first.host.sessions.dispatch.send(request))).toEqual(receipt)
      yield* Effect.promise(() => f.second.host.sessions.links.end(sourceSessionID))
      expect(yield* Effect.promise(() => f.first.host.sessions.links.get(target.id))).toBeDefined()
      yield* Effect.promise(() => f.first.dispose())
      expect((yield* sessions.get(target.id)).id).toBe(target.id)
      expect((yield* sessions.get(sourceSessionID)).id).toBe(sourceSessionID)
    }).pipe(Effect.provide(layer), Effect.scoped))
  }, 30_000)
})
