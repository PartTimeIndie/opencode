import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { LLMEvent } from "@opencode-ai/llm"
import type { SessionSchema } from "@opencode-ai/core/session/schema"

// Exercise production Location tools and LocalExecution, isolated from installed
// plugins, credentials and the running desktop. No external provider is called.
test("production reviewers share managed execution, recover and survive compaction", async () => {
  if (process.env.OPENCODE_REVIEW_EXECUTION_PROBE === "1") return probe()
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-review-execution-"))
  // Keep the profile, database and caches outside the inspected repository.
  // Otherwise snapshot/cache files pollute and truncate real git_status output.
  const repository = path.join(root, "repository")
  await mkdir(repository)
  const child = Bun.spawn([process.execPath, "test", import.meta.path], {
    cwd: repository,
    env: {
      ...process.env,
      OPENCODE_REVIEW_EXECUTION_PROBE: "1",
      OPENCODE_TEST_HOME: root,
      OPENCODE_DB: path.join(root, "test.db"),
      OPENCODE_CONFIG_DIR: path.join(root, "config"),
      OPENCODE_CONFIG: "",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        permission: { "*": "allow" },
        multi_agent: { review: { reviewers: [{ model: "review-fixture/glm-fixture" }] } },
        agent: {
          build: {
            tools: {
              mode: "explicit",
              entries: {
                read: { visible: true, permission: "allow" },
                git_status: { visible: true, permission: "allow" },
                task: { visible: true, permission: "allow" },
                task_wait: { visible: true, permission: "allow" },
              },
            },
          },
        },
      }),
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_SESSION_RECOVERY: "1",
      // Native watcher callbacks are unrelated to this execution contract and
      // can crash Bun during temporary-repository teardown on Windows.
      OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "1",
      OPENCODE_PROVIDER_STREAM_IDLE_TIMEOUT_MS: "2000",
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
      .filter((line) => line.startsWith("REVIEW_EXECUTION_EVIDENCE "))
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

async function probe() {
  // All model traffic is supplied below. Also prohibit optional startup
  // downloads in the isolated home (for example search-binary provisioning).
  globalThis.fetch = Object.assign(
    async () => {
      throw new Error("Network disabled in reviewer execution fixture")
    },
    { preconnect: () => {} },
  )
  const { DateTime, Deferred, Effect, Fiber, Layer, Schema, Stream } = await import("effect")
  const { LLMEvent } = await import("@opencode-ai/llm")
  const { route } = await import("@opencode-ai/llm/protocols/openai-responses")
  const { eq } = await import("drizzle-orm")
  const { Database } = await import("@opencode-ai/core/database/database")
  const { EventV2 } = await import("@opencode-ai/core/event")
  const { LocationServiceMap } = await import("@opencode-ai/core/location-layer")
  const { SessionExecution } = await import("@opencode-ai/core/session/execution")
  const { SessionExecutionLocal } = await import("@opencode-ai/core/session/execution/local")
  const { SessionActivity } = await import("@opencode-ai/core/session/activity")
  const { SessionProjector } = await import("@opencode-ai/core/session/projector")
  const { SessionStore } = await import("@opencode-ai/core/session/store")
  const { SessionSchema } = await import("@opencode-ai/core/session/schema")
  const { SessionMessage } = await import("@opencode-ai/core/session/message")
  const { SessionHistory } = await import("@opencode-ai/core/session/history")
  const { SessionInput } = await import("@opencode-ai/core/session/input")
  const { Prompt } = await import("@opencode-ai/core/session/prompt")
  const { SessionEvent } = await import("@opencode-ai/core/session/event")
  const { SessionActivityTable, SessionTable } = await import("@opencode-ai/core/session/sql")
  const { ProjectTable } = await import("@opencode-ai/core/project/sql")
  const { Project } = await import("@opencode-ai/core/project")
  const { AbsolutePath } = await import("@opencode-ai/core/schema")
  const { PluginV2 } = await import("@opencode-ai/core/plugin")
  const { Catalog } = await import("@opencode-ai/core/catalog")
  const { ProviderV2 } = await import("@opencode-ai/core/provider")
  const { ModelV2 } = await import("@opencode-ai/core/model")
  const { FanoutWorkflow } = await import("@opencode-ai/core/fanout-workflow")
  const { PermissionV2 } = await import("@opencode-ai/core/permission")

  // Only this disposable fixture repository is changed. The reviewer sees both
  // sides of the index without borrowing a shell or the host's Git state.
  const git = (args: string[]) => execFileSync("git", args, { cwd: process.cwd(), windowsHide: true })
  git(["init", "-b", "main"])
  git(["config", "core.fsmonitor", "false"])
  git(["config", "commit.gpgsign", "false"])
  await Bun.write("tracked.txt", "original\n")
  git(["add", "tracked.txt"])
  git(["-c", "user.email=review@example.test", "-c", "user.name=Reviewer", "commit", "-m", "fixture"])
  await Bun.write("staged.txt", "staged reviewer evidence\n")
  git(["add", "staged.txt"])
  await Bun.write("tracked.txt", "original\nunstaged reviewer evidence\n")
  await Bun.write("untracked.txt", "untracked reviewer evidence\n")

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
    const eventService = yield* EventV2.Service
    const executionService = yield* SessionExecution.Service
    const storeService = yield* SessionStore.Service
    const locationsService = yield* LocationServiceMap
    const location = { directory: AbsolutePath.make(process.cwd()) }
    const parentID = SessionSchema.ID.make("ses_review_parent")
    const model = { providerID: ProviderV2.ID.make("review-fixture"), id: ModelV2.ID.make("glm-fixture") }
    yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: location.directory, sandboxes: [] }).run()
    yield* db
      .insert(SessionTable)
      .values({
        id: parentID,
        project_id: Project.ID.global,
        directory: location.directory,
        slug: "review-parent",
        title: "Review parent",
        version: "test",
        agent: "build",
        model,
      })
      .run()
    yield* Effect.promise(() => Bun.write(path.join(process.cwd(), "review.txt"), "Read exactly once"))

    yield* Effect.gen(function* () {
      const plugins = yield* PluginV2.Service
      const catalog = yield* Catalog.Service
      const workflows = yield* FanoutWorkflow.Service
      const permission = yield* PermissionV2.Service
      const schema = {
        type: "object",
        // Exercise the real review contract's bounded confidence at child
        // preflight, rather than an unconstrained schema that hides regressions.
        properties: { findings: { type: "array", items: {
          type: "object", properties: { confidence: { type: "number", minimum: 0, maximum: 1 } },
          required: ["confidence"], additionalProperties: false,
        } } },
        required: ["findings"],
        additionalProperties: false,
      }
      yield* workflows.register("fixture", {
        id: "fixture-review",
        configKey: "review",
        agentID: "review",
        commands: ["/fixture-review"],
        tools: ["read", "git_status"],
        resultSchema: schema,
      })
      const modes = [
        "join",
        "child-stop",
        "parent-stop",
        "recover",
        "compact",
        "compact-background",
        "steer",
        "steer-background",
        "steer-invalid",
        "steer-invalid-background",
        "git-patch",
      ] as const
      for (const [index, mode] of modes.entries()) {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let requests = 0
        let parentRequests = 0
        let parentCleaned = 0
        let reads = 0
        let cleaned = 0
        let childID: SessionSchema.ID | undefined
        let taskResult: Record<string, unknown> | undefined
        let collectedResult: Record<string, unknown> | undefined
        let consents = 0
        const failures: unknown[] = []
        const unsubscribe = yield* eventService.listen((event) => {
          if (event.type === PermissionV2.Event.Asked.type) {
            const request = Schema.decodeUnknownSync(PermissionV2.Event.Asked.data)(event.data)
            // This disposable fixture uses the actual single-use permission
            // round trip. It is not evidence of installed human consent.
            expect(request.sessionID).toBe(parentID)
            expect(request.action).toBe("task_main_write")
            consents++
            return permission.reply({ requestID: request.id, reply: "once" }).pipe(Effect.orDie)
          }
          if ((event.data as { sessionID?: string }).sessionID === parentID) {
            if (event.type === SessionEvent.Tool.Progress.type) {
              const progress = Schema.decodeUnknownSync(Schema.toType(SessionEvent.Tool.Progress.data))(event.data)
              if (typeof progress.structured.sessionID === "string")
                childID = SessionSchema.ID.make(progress.structured.sessionID)
            }
            if (event.type === SessionEvent.Tool.Success.type) {
              const success = Schema.decodeUnknownSync(Schema.toType(SessionEvent.Tool.Success.data))(event.data)
              if (success.callID === `review-${mode}`) taskResult = success.structured
              if (success.callID === "collect-background") collectedResult = success.structured
            }
          }
          if ((event.data as { sessionID?: string }).sessionID !== childID) return Effect.void
          if (
            event.type === SessionEvent.Tool.Success.type &&
            (event.data as { callID?: string }).callID === "call-recover-1"
          )
            reads++
          if (event.type === SessionEvent.Step.Failed.type) failures.push(event.data)
          return Effect.void
        })
        yield* Effect.addFinalizer(() => unsubscribe)
        yield* plugins.add({
          id: PluginV2.ID.make("review-fixture"),
          nativeModels: {
            "review-fixture": {
              resolve: async (input) => ({
                id: input.model.id,
                provider: input.model.providerID,
                route: {
                  ...route.with({ limits: { context: 1_000_000, output: 1024 } }),
                  streamPrepared: (_prepared, request) =>
                    Stream.unwrap(
                      Effect.gen(function* () {
                        if (request.tools.some((tool) => tool.name === "task")) {
                          parentRequests++
                          const name = parentRequests === 1 ? "task" : "task_wait"
                          if (parentRequests === 1 || (mode.endsWith("background") && parentRequests === 2))
                            return Stream.fromArray<LLMEvent>([
                              LLMEvent.stepStart({ index: 0 }),
                              LLMEvent.toolCall({
                                id: name === "task" ? `review-${mode}` : "collect-background",
                                name,
                                input: name === "task" ? {
                                  description: "Fixture reviewer", subagent_type: "review",
                                  prompt: `Inspect ${mode}`, workflow: "fixture-review",
                                  workspace: "main", background: mode.endsWith("background"),
                                } : { task_ids: [childID] },
                              }),
                              LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
                              LLMEvent.finish({ reason: "tool-calls" }),
                            ])
                          return Stream.fromArray<LLMEvent>([
                            LLMEvent.stepStart({ index: 0 }),
                            LLMEvent.textStart({ id: "parent-done" }),
                            LLMEvent.textDelta({ id: "parent-done", text: "Review collected" }),
                            LLMEvent.textEnd({ id: "parent-done" }),
                            LLMEvent.stepFinish({ index: 0, reason: "stop" }),
                            LLMEvent.finish({ reason: "stop" }),
                          ])
                        }
                        requests++
                        if (mode === "git-patch") {
                          const names = request.tools.map((tool) => tool.name)
                          expect(names).toContain("git_status")
                          expect(names).not.toContain("bash")
                          expect(names).not.toContain("write")
                          expect(names).not.toContain("edit")
                          expect(names).not.toContain("apply_patch")
                        }
                        if (requests === 1) {
                          yield* Deferred.succeed(entered, undefined)
                          yield* Deferred.await(release)
                        }
                        const call = (name: string, input: unknown) =>
                          Stream.fromArray<LLMEvent>([
                            LLMEvent.stepStart({ index: 0 }),
                            LLMEvent.toolCall({ id: `call-${mode}-${requests}`, name, input }),
                            LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
                            LLMEvent.finish({ reason: "tool-calls" }),
                          ])
                        if ((mode === "recover" || mode.startsWith("steer")) && requests === 1)
                          return call("read", { path: path.join(process.cwd(), "review.txt") })
                        if (mode.startsWith("steer") && requests >= 2) {
                          expect(JSON.stringify(request.messages)).toContain("Include the corrected review scope")
                          expect(request.tools.map((tool) => tool.name)).toContain("StructuredOutput")
                        }
                        if (mode.startsWith("steer-invalid") && requests === 2)
                          return Stream.fromArray<LLMEvent>([
                            LLMEvent.stepStart({ index: 0 }),
                            LLMEvent.textStart({ id: "missing-result" }),
                            LLMEvent.textDelta({ id: "missing-result", text: "Investigation finished but result is missing" }),
                            LLMEvent.textEnd({ id: "missing-result" }),
                            LLMEvent.stepFinish({ index: 0, reason: "stop" }),
                            LLMEvent.finish({ reason: "stop" }),
                          ])
                        if (mode === "git-patch" && requests === 1) return call("git_status", { scope: "patch" })
                        if (mode === "git-patch") {
                          const history = JSON.stringify(request.messages)
                          expect(history).toContain("+unstaged reviewer evidence")
                          expect(history).toContain("+staged reviewer evidence")
                          expect(history).toContain("?? untracked.txt")
                        }
                        if (mode === "recover" && requests === 2)
                          return Stream.fromArray<LLMEvent>([
                            LLMEvent.stepStart({ index: 0 }),
                            LLMEvent.textStart({ id: "partial" }),
                            LLMEvent.textDelta({ id: "partial", text: "Partial investigation" }),
                            LLMEvent.providerError({
                              message: "temporary fixture failure",
                              retryable: true,
                              retryAfterMs: 0,
                            }),
                          ])
                        return call("StructuredOutput", { findings: [] })
                      }),
                    ).pipe(
                      Stream.ensuring(
                         Effect.sync(() => {
                           if (request.tools.some((tool) => tool.name === "task")) parentCleaned++
                           else cleaned++
                        }),
                      ),
                    ),
                },
              }),
            },
          },
          effect: Effect.void,
        })
        const transform = yield* catalog.transform()
        yield* transform((editor) => {
          editor.provider.update(model.providerID, (provider) => {
            provider.api = { type: "aisdk", package: "review-fixture" }
          })
          editor.model.update(model.providerID, model.id, (entry) => {
            entry.api = { id: model.id, type: "aisdk", package: "review-fixture" }
            entry.capabilities.tools = true
            entry.capabilities.input = ["text/plain"]
            entry.capabilities.output = ["text/plain"]
            entry.limit.context = 1_000_000
            entry.limit.output = 1024
          })
        })
        const background = mode.endsWith("background")
        yield* SessionInput.admit(db, eventService, {
          id: SessionMessage.ID.make(`msg_parent_${mode}`), sessionID: parentID,
          prompt: new Prompt({ text: `Run reviewer lifecycle ${mode}`, model }),
          delivery: "steer", origin: "interactive",
        })
        const fiber = yield* executionService.resumeOrJoin(parentID).pipe(Effect.forkChild)
        // Admission failures must not strand the test at an unreachable signal.
        yield* Effect.raceFirst(
          Deferred.await(entered),
          Fiber.join(fiber).pipe(Effect.andThen(Effect.die("Parent settled before reviewer provider entry"))),
        )
        if (!childID) return yield* Effect.die("Expected child Session")
        const id = childID
        const running = yield* db
          .select()
          .from(SessionActivityTable)
          .where(eq(SessionActivityTable.session_id, id))
          .all()
        expect(running).toHaveLength(1)
        expect(running[0].status).toBe("running")
        expect(running[0].owner_id).toBeTruthy()
        const parentRunning = yield* db.select().from(SessionActivityTable)
          .where(eq(SessionActivityTable.session_id, parentID)).all()
        expect(parentRunning.filter((activity) => activity.status === "running" && activity.owner_id)).toHaveLength(1)
        if (mode.startsWith("steer")) {
          const correction = yield* SessionInput.admit(db, eventService, {
            id: SessionMessage.ID.make(`msg_correction_${mode}`), sessionID: id,
            prompt: new Prompt({ text: "Include the corrected review scope" }), delivery: "steer",
          })
          expect(correction.promotedSeq).toBeUndefined()
        }
        const joined = mode === "join" ? yield* executionService.resumeOrJoin(id).pipe(Effect.forkChild) : undefined
        for (let i = 0; i < 10; i++) yield* Effect.yieldNow
        expect(requests).toBe(1)
        if (mode === "child-stop") yield* executionService.interrupt(id)
        else if (mode === "parent-stop") yield* executionService.interrupt(parentID)
        else {
          if (mode.startsWith("compact")) {
            const history = yield* storeService.context(id)
            const prompt = history.find((message) => message.type === "user")
            if (!prompt) return yield* Effect.die("Expected promoted task prompt")
            yield* eventService.publish(SessionEvent.Compaction.Ended, {
              sessionID: id,
              timestamp: yield* DateTime.now,
              messageID: SessionMessage.ID.make(`msg_summary_${mode}`),
              reason: "manual",
              text: "Review summary",
              recent: "Continue investigation",
            })
            expect((yield* storeService.context(id)).some((message) => message.id === prompt.id)).toBe(false)
            expect((yield* SessionHistory.loadForTask(db, id, prompt.id))[0]?.id).toBe(prompt.id)
          }
          yield* Deferred.succeed(release, undefined)
        }
        if (mode !== "parent-stop") {
          yield* Fiber.join(fiber)
          if (background) {
            expect(collectedResult).toMatchObject({
              tasks: [{ state: "completed", result: '{"findings":[]}' }],
            })
          } else
            expect(taskResult).toMatchObject(
              mode === "child-stop" ? { state: "error" } : { state: "completed", text: '{"findings":[]}' },
            )
        }
        yield* executionService.wait(parentID)
        if (joined) yield* Fiber.join(joined)
        yield* executionService.wait(id)
        const rows = yield* db.select().from(SessionActivityTable).where(eq(SessionActivityTable.session_id, id)).all()
        expect(rows).toHaveLength(1)
        expect(rows[0].status).toBe(mode.endsWith("stop") ? "interrupted" : "completed")
        expect(cleaned).toBe(requests)
        expect(parentCleaned).toBe(parentRequests)
        if (mode === "recover") {
          expect(requests).toBe(3)
          expect(failures.length).toBeGreaterThan(0)
          expect(reads).toBe(1)
        }
        if (mode === "git-patch" || mode.startsWith("steer")) expect(requests).toBe(mode.startsWith("steer-invalid") ? 3 : 2)
        if (mode.startsWith("steer")) {
          const task = yield* storeService.get(id)
          const assignmentID = task?.agentPolicy?.mainWriteConsent?.inputID
          if (!assignmentID) return yield* Effect.die("Expected original task input binding")
          const history = yield* SessionHistory.loadForTask(db, id, SessionMessage.ID.make(assignmentID))
          const attempts = history.filter((message) => message.type === "assistant" && message.structuredOutputAttempt)
          expect(attempts).toHaveLength(requests)
          for (const message of attempts) {
            if (message.type !== "assistant") continue
            expect(message.structuredOutputAttempt?.inputID).toBe(SessionMessage.ID.make(assignmentID))
          }
          const final = attempts.at(-1)
          expect(final?.type === "assistant" ? final.structuredOutputAttempt?.phase : undefined)
            .toBe(mode.startsWith("steer-invalid") ? "correction" : "initial")
        }
        const before = requests
        yield* executionService.wake(id)
        yield* executionService.wait(id)
        expect(requests).toBe(before)
        const parentActivities = yield* db.select().from(SessionActivityTable)
          .where(eq(SessionActivityTable.session_id, parentID)).orderBy(SessionActivityTable.time_created).all()
        expect(parentActivities).toHaveLength(index + 1)
        expect(parentActivities.map((activity) => activity.status)).toEqual(
          modes.slice(0, index + 1).map((entry) => entry === "parent-stop" ? "interrupted" : "completed"),
        )
        expect(consents).toBe(1)
        console.log(
          "REVIEW_EXECUTION_EVIDENCE " +
            JSON.stringify({ mode, activity: rows[0].status, requests, cleaned, reads, failures: failures.length }),
        )
        yield* unsubscribe
        yield* plugins.remove(PluginV2.ID.make("review-fixture"))
      }
    }).pipe(Effect.provide(locationsService.get(location)))
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(dependencies, projector, execution)), Effect.runPromise)
}
