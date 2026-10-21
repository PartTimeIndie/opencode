import { describe, expect } from "bun:test"
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Layer, Option, Schema, Stream } from "effect"
import { adjust } from "effect/testing/TestClock"
import { LLMError, TransportReason } from "@opencode-ai/llm"
import { AgentV2 } from "@opencode-ai/core/agent"
import { FanoutWorkflow } from "@opencode-ai/core/fanout-workflow"
import { ContentStore } from "@opencode-ai/core/content-store"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionStore } from "@opencode-ai/core/session/store"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { TaskTool } from "@opencode-ai/core/tool/task"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { testEffect } from "./lib/effect"
import { settleTool, toolDefinitions, toolIdentity } from "./lib/tool"

const parentID = SessionSchema.ID.make("ses_task_parent")
const existingID = SessionSchema.ID.make("ses_task_existing")
const childID = SessionSchema.ID.make("ses_task_child")
const otherParentID = SessionSchema.ID.make("ses_task_other_parent")
const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const otherLocation = Location.Ref.make({ directory: AbsolutePath.make("/other") })
const model = { id: ModelV2.ID.make("fake-model"), providerID: ProviderV2.ID.make("fake") }
const sol = {
  id: ModelV2.ID.make("gpt-5.6-sol"),
  providerID: ProviderV2.ID.make("openai"),
  variant: ModelV2.VariantID.make("high"),
}
const glm = {
  id: ModelV2.ID.make("glm-5.3"),
  providerID: ProviderV2.ID.make("zhipuai-coding-plan"),
  variant: ModelV2.VariantID.make("default"),
}
// Settings-shaped model chain: the active model plus ordered fallback steps.
const handoffChain = {
  id: "repo-chain",
  name: "Repo chain",
  active: 0,
  steps: [sol, { id: glm.id, providerID: glm.providerID }],
}
const general = new AgentV2.Info({
  id: AgentV2.ID.make("general"),
  model,
  request: { headers: {}, body: {} },
  mode: "subagent",
  hidden: false,
  permissions: [{ action: "read", resource: "*", effect: "allow" }],
})
const review = new AgentV2.Info({ ...general, id: AgentV2.ID.make("review") })
const build = new AgentV2.Info({ ...general, id: AgentV2.ID.make("build"), mode: "primary" })
const parent = sessionInfo(parentID, { title: "Parent", model })
const sessionsByID = new Map<SessionSchema.ID, SessionSchema.Info>()
const messagesByID = new Map<SessionSchema.ID, SessionMessage.Message[]>()
const permissionAssertions: PermissionV2.AssertInput[] = []
const created: SessionV2.CreateInput[] = []
const prompts: Parameters<SessionV2.Interface["prompt"]>[0][] = []
const resumed: SessionSchema.ID[] = []
const interrupted: SessionSchema.ID[] = []
let denyPermission = false
let deniedAction: string | undefined
let resumeOverride: ((id: SessionSchema.ID) => Effect.Effect<void, LLMError>) | undefined

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => permissionAssertions.push(input)).pipe(
        Effect.andThen(
          denyPermission || input.action === deniedAction
            ? Effect.fail(new PermissionV2.DeniedError({ rules: [] }))
            : Effect.void,
        ),
      ),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    materializationRules: () => Effect.succeed([]),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const agents = Layer.succeed(
  AgentV2.Service,
  AgentV2.Service.of({
    get: (id) =>
      Effect.succeed(id === general.id ? general : id === review.id ? review : id === build.id ? build : undefined),
    resolve: (id) =>
      Effect.succeed(id === general.id ? general : id === review.id ? review : id === build.id ? build : undefined),
    select: (id) =>
      Effect.succeed({
        id: AgentV2.ID.make(id ?? "build"),
        info: id === general.id ? general : id === review.id ? review : id === build.id ? build : undefined,
      }),
    default: () => Effect.succeed(undefined),
    all: () => Effect.succeed([build, general, review]),
    transform: () => Effect.die("unused"),
    update: () => Effect.die("unused"),
  }),
)
const sessions = Layer.succeed(
  SessionV2.Service,
  SessionV2.Service.of({
    create: (input) =>
      Effect.sync(() => {
        created.push(input)
        const child = sessionInfo(
          input.id ?? (created.length === 1 ? childID : SessionSchema.ID.make(`ses_task_child_${created.length}`)),
          {
            title: input.title ?? "Child",
            parentID: input.parentID,
            agent: input.agent,
            model: input.model,
          },
        )
        sessionsByID.set(child.id, child)
        return child
      }),
    get: (id) =>
      Effect.sync(() => sessionsByID.get(id)).pipe(
        Effect.flatMap((session) =>
          session ? Effect.succeed(session) : Effect.fail(new SessionV2.NotFoundError({ sessionID: id })),
        ),
      ),
    messages: (input) => Effect.succeed(messagesByID.get(input.sessionID) ?? []),
    messageContext: () => Effect.die("unused"),
    prompt: (input) =>
      Effect.sync(() => {
        prompts.push(input)
        return new SessionInput.Admitted({
          admittedSeq: prompts.length,
          id: input.id ?? SessionMessage.ID.make(`msg_task_prompt_${prompts.length}`),
          sessionID: input.sessionID,
          prompt: input.prompt,
          delivery: input.delivery ?? "steer",
          timeCreated: DateTime.makeUnsafe(0),
        })
      }),
    synthetic: () => Effect.die("unused"),
    resume: (id) =>
      Effect.sync(() => {
        resumed.push(id)
      }).pipe(
        Effect.andThen(
          resumeOverride ? resumeOverride(id) : Effect.sync(() => messagesByID.set(id, [assistant("Task finished")])),
        ),
        Effect.andThen(
          Effect.sync(() => {
            const prompt = prompts.at(-1)
            if (!prompt?.id) return
            const messages = messagesByID.get(id) ?? []
            if (messages.some((message) => message.id === prompt.id)) return
            messagesByID.set(id, [user(prompt.id, prompt.prompt.text), ...messages])
          }),
        ),
      ),
    interrupt: (id) => Effect.sync(() => interrupted.push(id)),
    list: () => Effect.die("unused"),
    message: () => Effect.die("unused"),
    context: () => Effect.die("unused"),
    events: () => Stream.die("unused"),
    switchAgent: () => Effect.die("unused"),
    heldInputs: () => Effect.die("unused"),
    releaseInput: () => Effect.die("unused"),
    switchModel: () => Effect.die("unused"),
    switchAgentAndPrompt: () => Effect.die("unused"),
    setTitle: () => Effect.die("unused"),
    patchMetadata: () => Effect.die("unused"),
    setShare: () => Effect.die("unused"),
    setSummary: () => Effect.die("unused"),
    revert: () => Effect.die("unused"),
    rollback: () => Effect.die("unused"),
    unrevert: () => Effect.die("unused"),
    cleanupRevert: () => Effect.die("unused"),
    shell: () => Effect.die("unused"),
    skill: () => Effect.die("unused"),
    compact: () => Effect.die("unused"),
    wait: () => Effect.die("unused"),
  }),
)
const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(permission))
const taskDatabase = Database.layerFromPath(":memory:")
const taskEvents = EventV2.layer.pipe(Layer.provide(taskDatabase))
const workflows = Layer.effectDiscard(
  Effect.gen(function* () {
    const service = yield* FanoutWorkflow.Service
    yield* service.register("neutral-plugin", {
      id: "neutral-analysis",
      configKey: "neutral",
      agentID: "review",
      agentAliases: ["analyst-alias"],
      commands: ["/neutral-analysis"],
      tools: ["read", "grep", "glob"],
      resultSchema: {
        type: "object",
        properties: { findings: { type: "array", items: {} }, notes: { type: "array", items: { type: "string" } } },
        required: ["findings", "notes"],
        additionalProperties: false,
      },
    })
    yield* service.register("review-plugin", {
      id: "review",
      configKey: "review",
      agentID: "review",
      commands: ["/multi-agent-review"],
      tools: ["read", "grep", "glob"],
      resultSchema: {
        type: "object",
        properties: { findings: { type: "array", items: {} }, notes: { type: "array", items: { type: "string" } } },
        required: ["findings", "notes"],
        additionalProperties: false,
      },
    })
  }),
).pipe(Layer.provideMerge(FanoutWorkflow.layer))
const task = TaskTool.layer.pipe(
  Layer.provide(registry),
  Layer.provide(permission),
  Layer.provide(agents),
  Layer.provide(sessions),
  Layer.provide(workflows),
  Layer.provide(taskEvents),
)
const it = testEffect(Layer.mergeAll(permission, agents, sessions, registry, workflows, taskDatabase, taskEvents, task))

const handoffRuns: { readonly sessionID: SessionSchema.ID; readonly model: ModelV2.Ref; readonly history: string[] }[] =
  []
const handoffDatabase = Database.layerFromPath(":memory:")
const handoffEvents = EventV2.layer.pipe(Layer.provide(handoffDatabase))
const handoffProjects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)
const handoffProjector = SessionProjector.layer.pipe(Layer.provide(handoffEvents), Layer.provide(handoffDatabase))
const handoffStore = SessionStore.layer.pipe(Layer.provide(handoffDatabase))
const handoffExecution = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const store = yield* SessionStore.Service
    return SessionExecution.Service.of({
      resumeOrJoin: () => Effect.void,
      resume: (sessionID) =>
        Effect.gen(function* () {
          yield* SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER)
          const session = yield* store.get(sessionID)
          if (!session?.model) return yield* Effect.die("Task handoff execution has no selected model")
          const context = yield* store.context(sessionID)
          handoffRuns.push({ sessionID, model: session.model, history: context.map((message) => message.id) })
          const attempt = handoffRuns.length
          const timestamp = DateTime.makeUnsafe(attempt * 10)
          const assistantMessageID = SessionMessage.ID.make(`msg_task_handoff_assistant_${attempt}`)
          const textID = `txt_task_handoff_${attempt}`
          yield* events.publish(SessionEvent.Step.Started, {
            sessionID,
            timestamp,
            assistantMessageID,
            agent: session.agent ?? "general",
            model: session.model,
          })
          yield* events.publish(SessionEvent.Text.Started, { sessionID, timestamp, assistantMessageID, textID })
          yield* events.publish(SessionEvent.Text.Ended, {
            sessionID,
            timestamp,
            assistantMessageID,
            textID,
            text: attempt === 1 ? "Plan ready" : "Implementation complete",
          })
          yield* events.publish(SessionEvent.Step.Ended, {
            sessionID,
            timestamp,
            assistantMessageID,
            finish: "stop",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          })
        }),
      queueContinuation: () => Effect.void,
      wake: () => Effect.void,
      interrupt: () => Effect.void,
      interruptActivity: () => Effect.succeed(false),
      wait: () => Effect.void,
      cancelTool: () => Effect.succeed(false),
    })
  }),
).pipe(Layer.provide(handoffDatabase), Layer.provide(handoffEvents), Layer.provide(handoffStore))
const handoffSessions = SessionV2.layer.pipe(
  Layer.provide(ContentStore.defaultLayer),
  Layer.provide(handoffDatabase),
  Layer.provide(handoffEvents),
  Layer.provide(handoffProjects),
  Layer.provide(handoffStore),
  Layer.provide(Snapshot.defaultLayer),
  Layer.provide(handoffExecution),
)
const handoffRegistry = ToolRegistry.defaultLayer.pipe(Layer.provide(permission))
const handoffTask = TaskTool.layer.pipe(
  Layer.provide(handoffRegistry),
  Layer.provide(permission),
  Layer.provide(agents),
  Layer.provide(handoffSessions),
)
const handoffIt = testEffect(
  Layer.mergeAll(
    permission,
    agents,
    handoffDatabase,
    handoffEvents,
    handoffProjects,
    handoffProjector,
    handoffStore,
    handoffExecution,
    handoffSessions,
    handoffRegistry,
    handoffTask,
  ),
)

describe("TaskTool", () => {
  it.effect("creates a linked child session and runs it through SessionV2 prompt/resume", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service

      const result = yield* settleTool(registry, {
        sessionID: parentID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-task", name: "task", input: taskInput() },
      })
      const spawnedID = taskSessionID(result)

      expect(result.result).toEqual({
        type: "text",
        value: `<task id="${spawnedID}" state="completed">\n<next_action>none</next_action>\n<task_result>\nTask finished\n</task_result>\n</task>`,
      })
      expect(result.output?.structured).toEqual({
        sessionID: spawnedID,
        task_id: spawnedID,
        state: "completed",
        text: "Task finished",
        next_action: "none",
      })
      expect(permissionAssertions).toMatchObject([{ sessionID: parentID, action: "task", resources: ["general"] }])
      expect(created).toMatchObject([
        {
          parentID,
          title: "Review code (@general subagent)",
          agent: general.id,
          model,
          location,
        },
      ])
      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toMatchObject({ sessionID: spawnedID, agent: general.id, model, resume: false })
      expect(prompts[0].prompt.text).toBe("Inspect the change")
      expect(resumed).toEqual([spawnedID])
    }),
  )

  it.effect("rejects a model override outside the configured agent and session chains", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service

      const result = yield* settleTool(registry, {
        sessionID: parentID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-task-unconfigured-model",
          name: "task",
          input: { ...taskInput(), model: "openai/gpt-5.5" },
        },
      })

      expect(result.result).toEqual({
        type: "error",
        value: expect.stringContaining("openai/gpt-5.5 is not configured"),
      })
      expect((result.result as { value: string }).value).toContain("fake/fake-model")
      expect((result.result as { value: string }).value).toContain("Allowed models:")
      expect(created).toEqual([])
      expect(prompts).toEqual([])
      expect(resumed).toEqual([])
    }),
  )

  it.effect("resolves a configured chain step by its bare model id and keeps the fallback chain", () =>
    Effect.gen(function* () {
      reset()
      const ox = {
        id: ModelV2.ID.make("stealth/ox-alpha"),
        providerID: ProviderV2.ID.make("openrouter"),
      }
      sessionsByID.set(
        parentID,
        sessionInfo(parentID, {
          title: "Parent",
          model: {
            ...ox,
            chain: {
              id: "repo-chain",
              name: "Repo chain",
              active: 0,
              steps: [ox, { id: glm.id, providerID: glm.providerID }],
            },
          },
        }),
      )
      const registry = yield* ToolRegistry.Service

      const result = yield* settleTool(registry, {
        sessionID: parentID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-task-chain-step",
          name: "task",
          input: { ...taskInput(), model: "stealth/ox-alpha" },
        },
      })

      expect(result.output?.structured).toMatchObject({ state: "completed", text: "Task finished" })
      expect(created[0]?.model).toMatchObject(ox)
      expect(created[0]?.model?.chain).toMatchObject({ active: 0 })
      expect(created[0]?.model?.chain?.steps.map((step) => String(step.id))).toEqual(["stealth/ox-alpha", "glm-5.3"])
      expect(prompts[0]?.model).toEqual(created[0]?.model)
    }),
  )

  it.effect("documents the configured-model restriction in the tool input schema", () =>
    Effect.gen(function* () {
      const document = Schema.toJsonSchemaDocument(TaskTool.Input)
      const properties = (
        document.schema as { readonly properties?: Record<string, { readonly description?: string }> }
      ).properties

      expect(properties?.model?.description).toContain("Only models configured")
      expect(properties?.model?.description).toContain("Omit this to inherit")
      expect(properties?.model?.description).not.toContain("gpt-5.5")
      expect(properties?.model?.description).toContain("Unconfigured models are rejected")
      expect(properties?.subagent_type?.description).toContain("plugin-registered alias")
      expect(properties?.workflow?.description).toContain("ID, command, or public name")
      expect(properties?.workflow?.description).toContain("leading slash")
      expect(TaskTool.description).toContain("unconfigured models are rejected")
    }),
  )

  it.effect("documents when fanout is requested and routes ordinary lookups to direct tools", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const definition = (yield* toolDefinitions(registry)).find((tool) => tool.name === TaskTool.fanoutName)

      expect(definition?.description).toContain("current user request explicitly asks for multiple independent agents")
      expect(definition?.description).toContain("already authorized workflow requires that fanout")
      expect(definition?.description).toContain("/multi-agent-review or /multi-agent-problem-solver")
      expect(definition?.description).toContain("document lookup, file search, or source inspection")
      expect(definition?.description).toContain("use read, grep, or glob directly")
      expect(definition?.description).toContain("A configured model chain selects models")
      expect(definition?.description).toContain("it is not a request for parallel reviewers")
      expect(definition?.description).toContain("look directly instead of using multiple agents, follow that instruction")
      expect(definition?.description).toContain("without reviewer runtime ceilings")
      expect(definition?.description).toContain("collect every worker exactly once")
    }),
  )

  it.effect("resolves a plugin-registered agent alias", () =>
    Effect.gen(function* () {
      reset()
      resumeOverride = (id) =>
        Effect.sync(() => {
          messagesByID.set(id, [assistant(JSON.stringify({ findings: [], notes: ["review complete"] }))])
        })
      const registry = yield* ToolRegistry.Service

      const result = yield* settleTool(registry, {
        sessionID: parentID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-task-review-alias",
          name: "task",
          input: { ...taskInput(), subagent_type: "analyst-alias", command: "/neutral-analysis" },
        },
      })

      expect(result.output?.structured).toMatchObject({ state: "completed" })
      expect(permissionAssertions).toMatchObject([{ resources: ["review"] }])
      expect(created).toMatchObject([{ agent: "review" }])
      expect(created[0]?.metadata).toBeUndefined()
      expect(prompts).toMatchObject([{ agent: "review" }])
      expect(prompts[0]?.prompt.format?.type).toBe("json_schema")
      expect(permissionAssertions[0]?.action).toBe("multi_agent_fanout")
    }),
  )

  it.effect("rejects unregistered workflows before creating any worker", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service
      const result = yield* settleTool(registry, {
        sessionID: parentID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "unknown-workflow",
          name: "multi_agent_fanout",
          input: { workflow: "missing", prompt: "Inspect" },
        },
      })
      expect(JSON.stringify(result)).toContain("Workflow is not registered")
      expect(JSON.stringify(result)).toContain('not the tool name \\"multi_agent_fanout\\"')
      expect(created).toEqual([])
      expect(prompts).toEqual([])
    }),
  )

  for (const reference of ["review", "/multi-agent-review", "multi-agent-review"]) {
    it.effect(`resolves fanout workflow reference ${reference}`, () =>
      Effect.gen(function* () {
        reset()
        resumeOverride = (id) =>
          Effect.sync(() => {
            messagesByID.set(id, [assistant(JSON.stringify({ findings: [], notes: ["review complete"] }))])
          })
        const registry = yield* ToolRegistry.Service

        const result = yield* settleTool(registry, {
          sessionID: parentID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: `call-task-fanout-reference-${reference.replaceAll("/", "slash")}`,
            name: "multi_agent_fanout",
            input: {
              workflow: reference,
              prompt: "Review the change",
              requested_reviewers: [{ model: "fake/fake-model" }],
            },
          },
        })

        expect(result.output?.structured).toMatchObject({ workflow: "review", results: [{ status: "success" }] })
        expect(created).toHaveLength(1)
        expect(prompts).toHaveLength(1)
      }),
    )
  }

  it.effect("keeps tool budgets opt-in and honors an explicit task budget", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service

      const result = yield* settleTool(registry, {
        sessionID: parentID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-task-explicit-budget",
          name: "task",
          input: { ...taskInput(), tool_budget: { read: 12, grep: 5 } },
        },
      })

      expect(result.output?.structured).toMatchObject({ state: "completed" })
      expect(created[0]?.metadata).toMatchObject({ tool_budget: { read: 12, grep: 5 } })
    }),
  )

  it.effect("collects three structured reviewers and one terminal no-output reviewer without waiting for timeout", () =>
    Effect.gen(function* () {
      reset()
      deniedAction = "task"
      // Reviewer models must resolve into the configured parent chain; the
      // fanout itself never authorizes catalog models.
      sessionsByID.set(
        parentID,
        sessionInfo(parentID, {
          title: "Parent",
          model: {
            ...model,
            chain: {
              id: "fanout-chain",
              name: "Fanout chain",
              active: 0,
              steps: [model, { id: glm.id, providerID: glm.providerID }],
            },
          },
        }),
      )
      resumeOverride = (id) =>
        Effect.sync(() => {
          if (resumed.length === 4) return
          messagesByID.set(id, [
            assistant(
              JSON.stringify({ findings: [], notes: ["review complete"] }),
              `msg_task_review_${resumed.length}`,
            ),
          ])
        })
      const registry = yield* ToolRegistry.Service

      const result = yield* settleTool(registry, {
        sessionID: parentID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-task-fanout-no-output",
          name: "multi_agent_fanout",
          input: {
            workflow: "neutral-analysis",
            prompt: "Review the change",
            requested_reviewers: [
              { model: "fake/fake-model" },
              { model: "zhipuai-coding-plan/glm-5.3" },
              { model: "fake/fake-model" },
              { model: "zhipuai-coding-plan/glm-5.3" },
            ],
            timeout_ms: 300_000,
            tool_budget: { read: 9, grep: 4, glob: 3 },
          },
        },
      })
      const output = result.output?.structured as
        { results: Array<{ status: "success" | "spawn_no_output" | "error"; task: TaskTool.Output }> } | undefined

      expect(output?.results.map((entry) => entry.status)).toEqual(["success", "success", "success", "spawn_no_output"])
      expect(output?.results[3]?.task).toMatchObject({
        state: "error",
        text: expect.stringContaining("spawn_no_output"),
      })
      expect(resumed).toHaveLength(4)
      expect(interrupted).toEqual([])
      expect(permissionAssertions).toHaveLength(4)
      expect(permissionAssertions.every((entry) => entry.action === "multi_agent_fanout")).toBe(true)
      expect(permissionAssertions.every((entry) => entry.resources[0] === "review")).toBe(true)
      expect(
        created.every(
          (entry) => JSON.stringify(entry.metadata?.tool_budget) === JSON.stringify({ read: 9, grep: 4, glob: 3 }),
        ),
      ).toBe(true)
    }),
  )

  it.live("settles from terminal child history while every reviewer run remains pending", () =>
    Effect.gen(function* () {
      reset()
      sessionsByID.set(
        parentID,
        sessionInfo(parentID, {
          title: "Parent",
          model: {
            ...model,
            chain: {
              id: "terminal-history-chain",
              name: "Terminal history chain",
              active: 0,
              steps: [model, { id: glm.id, providerID: glm.providerID }],
            },
          },
        }),
      )
      const events = yield* EventV2.Service
      resumeOverride = (id) =>
        Effect.gen(function* () {
          const index = resumed.indexOf(id)
          const prompt = prompts.find((entry) => entry.sessionID === id)
          if (!prompt?.id) return yield* Effect.die("Expected admitted reviewer prompt")
          const response =
            index === 0
              ? assistant("", `msg_task_terminal_${index}`, {
                  finish: "length",
                  structured: { findings: [], notes: ["usable partial result"] },
                })
              : index === 1
                ? assistant("", `msg_task_terminal_${index}`, {
                    error: { type: "unknown", message: "provider failed terminally" },
                  })
                : index === 2
                  ? assistant("", `msg_task_terminal_${index}`, {
                      error: { type: "unknown", message: "Model did not produce structured output" },
                    })
                  : undefined
          const previousStructuredFailure =
            index === 2
              ? [
                  assistant("", "msg_task_terminal_structured_retry", {
                    error: { type: "unknown", message: "Model did not produce structured output" },
                  }),
                ]
              : []
          if (index === 2) {
            messagesByID.set(id, [user(prompt.id, prompt.prompt.text), ...previousStructuredFailure])
            yield* events.publish(SessionEvent.Step.Failed, {
              sessionID: id,
              timestamp: DateTime.makeUnsafe(index),
              assistantMessageID: previousStructuredFailure[0]!.id,
              error: { type: "unknown", message: "Model did not produce structured output" },
            })
          }
          messagesByID.set(id, [
            user(prompt.id, prompt.prompt.text),
            ...previousStructuredFailure,
            ...(response ? [response] : []),
          ])
          const timestamp = DateTime.makeUnsafe(index + 1)
          if (index === 1 || index === 2) {
            yield* events.publish(SessionEvent.Step.Failed, {
              sessionID: id,
              timestamp,
              assistantMessageID: SessionMessage.ID.make(`msg_task_terminal_${index}`),
              error: {
                type: "unknown",
                message: index === 1 ? "provider failed terminally" : "Model did not produce structured output",
              },
            })
          } else if (response) {
            yield* events.publish(SessionEvent.Step.Ended, {
              sessionID: id,
              timestamp,
              assistantMessageID: response.id,
              finish: response.finish ?? "stop",
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              ...(response.structured === undefined ? {} : { structured: response.structured }),
            })
          } else {
            yield* events.publish(SessionEvent.Activity.Completed, {
              sessionID: id,
              timestamp,
              activityID: `activity-${index}`,
            })
          }
          return yield* Effect.never
        })
      const registry = yield* ToolRegistry.Service

      const result = yield* settleTool(registry, {
        sessionID: parentID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-task-fanout-terminal-history",
          name: "multi_agent_fanout",
          input: {
            workflow: "neutral-analysis",
            prompt: "Review the change",
            requested_reviewers: [
              { model: "fake/fake-model" },
              { model: "zhipuai-coding-plan/glm-5.3" },
              { model: "fake/fake-model" },
              { model: "zhipuai-coding-plan/glm-5.3" },
            ],
            timeout_ms: 30_000,
          },
        },
      }).pipe(Effect.timeout("2 seconds"))
      const output = result.output?.structured as
        | {
            results: Array<{
              status: "success" | "spawn_no_output" | "error"
              task: TaskTool.Output
              result?: unknown
            }>
          }
        | undefined

      expect(output?.results.map((entry) => entry.status)).toEqual(["success", "error", "error", "spawn_no_output"])
      expect(output?.results.map((entry) => entry.task.state)).toEqual(["completed", "error", "error", "error"])
      expect(output?.results[0]?.result).toEqual({ findings: [], notes: ["usable partial result"] })
      expect(output?.results[1]?.task.text).toBe("provider failed terminally")
      expect(output?.results[2]?.task.text).toBe("Model did not produce structured output")
      expect(output?.results[3]?.task.text).toContain("spawn_no_output")
      expect(resumed).toHaveLength(4)
      expect(interrupted).toEqual([])
    }),
  )

  it.effect("rejects requested reviewers whose models are not configured", () =>
    Effect.gen(function* () {
      reset()
      resumeOverride = (id) =>
        Effect.sync(() => {
          messagesByID.set(id, [
            assistant(JSON.stringify({ findings: [], notes: ["review complete"] }), "msg_task_review_configured"),
          ])
        })
      const registry = yield* ToolRegistry.Service

      const result = yield* settleTool(registry, {
        sessionID: parentID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-task-fanout-unconfigured",
          name: "multi_agent_fanout",
          input: {
            workflow: "neutral-analysis",
            prompt: "Review the change",
            requested_reviewers: [{ model: "openai/gpt-5.5" }, { model: "fake/fake-model" }],
          },
        },
      })
      const output = result.output?.structured as
        { results: Array<{ status: "success" | "spawn_no_output" | "error"; task: TaskTool.Output }> } | undefined

      expect(output?.results.map((entry) => entry.status)).toEqual(["error", "success"])
      expect(output?.results[0]?.task.text).toContain("openai/gpt-5.5 is not configured")
      expect(output?.results[0]?.task.text).toContain("Allowed models: fake/fake-model")
      expect(output?.results[1]?.task.state).toBe("completed")
      expect(created).toHaveLength(1)
      expect(resumed).toHaveLength(1)
      expect(String(resumed[0])).toBe(String(created[0]?.id))
    }),
  )

  it.live("starts in the background, times out without failing, and returns the durable result", () =>
    Effect.gen(function* () {
      reset()
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      resumeOverride = (id) =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.sync(() => messagesByID.set(id, [assistant("Background result")]))),
          Effect.andThen(Deferred.await(release)),
        )
      const registry = yield* ToolRegistry.Service

      const spawned = yield* settleTool(registry, {
        sessionID: parentID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-task-background",
          name: "task",
          input: { ...taskInput(), background: true },
        },
      })
      const spawnedID = taskSessionID(spawned)

      expect(spawned.output?.structured).toMatchObject({
        sessionID: spawnedID,
        task_id: spawnedID,
        state: "running",
        background: true,
      })
      expect(prompts).toHaveLength(1)
      yield* Deferred.await(started)
      expect(messagesByID.get(spawnedID)?.find((message) => message.type === "assistant")).toBeDefined()

      const pending = yield* settleTool(registry, {
        sessionID: parentID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-task-wait-timeout",
          name: "task_wait",
          input: { task_ids: [spawnedID], timeout_ms: 1 },
        },
      })
      expect(pending.output?.structured).toMatchObject({
        timed_out: true,
        tasks: [
          { task_id: spawnedID, state: "running", started_at: expect.any(Number), updated_at: expect.any(Number) },
        ],
      })
      expect(pending.output?.content).toMatchObject([
        {
          type: "text",
          text: expect.stringContaining("Do not treat this timeout as inactivity"),
        },
      ])

      yield* Deferred.succeed(release, undefined)
      const completed = yield* settleTool(registry, {
        sessionID: parentID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-task-wait-complete",
          name: "task_wait",
          input: { task_ids: [spawnedID], timeout_ms: 1_000 },
        },
      })
      expect(completed.output?.structured).toMatchObject({
        timed_out: false,
        tasks: [{ task_id: spawnedID, state: "completed", result: "Background result" }],
      })

      const result = yield* settleTool(registry, {
        sessionID: parentID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-task-result", name: "task_result", input: { task_id: spawnedID } },
      })
      expect(result.output?.structured).toMatchObject({
        task_id: spawnedID,
        state: "completed",
        result: "Background result",
      })
    }),
  )

  it.live("cancels a background task without interrupting its parent", () =>
    Effect.gen(function* () {
      reset()
      const started = yield* Deferred.make<void>()
      resumeOverride = () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
      const registry = yield* ToolRegistry.Service

      const spawned = yield* settleTool(registry, {
        sessionID: parentID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-task-background-cancel",
          name: "task",
          input: { ...taskInput(), background: true },
        },
      })
      const spawnedID = taskSessionID(spawned)
      yield* Deferred.await(started)
      const cancelled = yield* settleTool(registry, {
        sessionID: parentID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-task-cancel", name: "task_cancel", input: { task_id: spawnedID } },
      })

      expect(cancelled.output?.structured).toMatchObject({ task_id: spawnedID, state: "cancelled" })
      expect(interrupted).toEqual([spawnedID])
      expect(interrupted).not.toContain(parentID)
    }),
  )

  it.live("does not create an orphan child when background capacity is exhausted", () =>
    Effect.gen(function* () {
      reset()
      resumeOverride = () => Effect.never
      const registry = yield* ToolRegistry.Service
      const taskIDs: SessionSchema.ID[] = []
      for (let index = 0; index < 4; index++) {
        const result = yield* settleTool(registry, {
          sessionID: parentID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: `call-task-capacity-${index}`,
            name: "task",
            input: { ...taskInput(), description: `Task ${index}`, background: true },
          },
        })
        taskIDs.push(taskSessionID(result))
      }

      const rejected = yield* settleTool(registry, {
        sessionID: parentID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-task-capacity-rejected",
          name: "task",
          input: { ...taskInput(), description: "Rejected task", background: true },
        },
      })
      expect(rejected.result).toMatchObject({ type: "error", value: expect.stringContaining("limit reached") })
      expect(created).toHaveLength(4)

      yield* Effect.forEach(
        taskIDs,
        (taskID, index) =>
          settleTool(registry, {
            sessionID: parentID,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: `call-task-capacity-cancel-${index}`,
              name: "task_cancel",
              input: { task_id: taskID },
            },
          }),
        { discard: true },
      )
    }),
  )

  it.effect("does not reuse an assistant response from before the admitted prompt", () =>
    Effect.gen(function* () {
      reset()
      resumeOverride = (id) =>
        Effect.sync(() => {
          const prompt = prompts.at(-1)
          if (!prompt) return
          messagesByID.set(id, [assistant("Prior response", "msg_task_prior"), user(prompt.id!, prompt.prompt.text)])
        })
      const registry = yield* ToolRegistry.Service

      const result = yield* settleTool(registry, {
        sessionID: parentID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-task-correlated-result", name: "task", input: taskInput() },
      })

      expect(result.output?.structured).toMatchObject({
        state: "error",
        text: expect.stringContaining("never_settled"),
        next_action: "resume",
      })
      expect(result.result.value).not.toContain("Prior response")
    }),
  )

  it.effect("does not reuse an assistant response after the next admitted prompt", () =>
    Effect.gen(function* () {
      reset()
      resumeOverride = (id) =>
        Effect.sync(() => {
          const prompt = prompts.at(-1)
          if (!prompt) return
          messagesByID.set(id, [
            user(prompt.id!, prompt.prompt.text),
            user(SessionMessage.ID.make("msg_task_later_prompt"), "Later independent prompt"),
            assistant("Later response", "msg_task_later_response"),
          ])
        })
      const registry = yield* ToolRegistry.Service

      const result = yield* settleTool(registry, {
        sessionID: parentID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-task-result-window", name: "task", input: taskInput() },
      })

      expect(result.output?.structured).toMatchObject({
        state: "error",
        text: expect.stringContaining("never_settled"),
        next_action: "resume",
      })
      expect(result.result.value).not.toContain("Later response")
    }),
  )

  handoffIt.effect("resumes one general child from Sol High on GLM 5.3 while preserving its durable history", () =>
    Effect.gen(function* () {
      reset()
      handoffRuns.length = 0
      const registry = yield* ToolRegistry.Service
      const sessions = yield* SessionV2.Service
      const parent = yield* sessions.create({
        id: parentID,
        title: "Handoff parent",
        location,
        model: { ...sol, chain: handoffChain },
      })

      const planned = yield* settleTool(registry, {
        sessionID: parent.id,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-task-plan-sol",
          name: "task",
          input: {
            description: "Plan implementation",
            prompt: "Plan and review the implementation.",
            subagent_type: "general",
            model: "openai/gpt-5.6-sol",
            variant: "high",
          },
        },
      })
      const taskID = (planned.output?.structured as TaskTool.Output | undefined)?.sessionID
      if (!taskID) return yield* Effect.die("Expected planned task ID")

      const implemented = yield* settleTool(registry, {
        sessionID: parent.id,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-task-implement-glm",
          name: "task",
          input: {
            description: "Implement reviewed plan",
            prompt: "Implement the reviewed plan now.",
            subagent_type: "general",
            task_id: taskID,
            model: "zhipuai-coding-plan/glm-5.3",
          },
        },
      })

      expect(planned.output?.structured).toMatchObject({ sessionID: taskID, state: "completed", text: "Plan ready" })
      expect(implemented.output?.structured).toMatchObject({
        sessionID: taskID,
        state: "completed",
        text: "Implementation complete",
      })
      expect(handoffRuns.map((run) => ({ sessionID: run.sessionID }))).toEqual([
        { sessionID: taskID },
        { sessionID: taskID },
      ])
      // Model overrides stay inside the configured chain: Sol runs as the
      // active step and the GLM handoff activates the fallback step without
      // dropping the remaining Settings fallbacks.
      expect(handoffRuns[0]?.model).toMatchObject(sol)
      expect(handoffRuns[0]?.model?.chain).toMatchObject({ active: 0 })
      expect(handoffRuns[0]?.model?.chain?.steps).toHaveLength(2)
      expect(handoffRuns[1]?.model).toMatchObject(glm)
      expect(handoffRuns[1]?.model?.chain).toMatchObject({ active: 1 })
      expect(handoffRuns[1]?.model?.chain?.steps).toHaveLength(2)
      expect(handoffRuns[0]?.history).toHaveLength(1)
      expect(handoffRuns[0]?.history[0]).toMatch(/^msg_/)
      expect(handoffRuns[1]?.history).toContain("msg_task_handoff_assistant_1")
      expect(handoffRuns[1]?.history.some((id) => id.endsWith("_model"))).toBe(true)
      expect((yield* sessions.get(taskID)).model).toMatchObject(glm)
      expect((yield* sessions.get(taskID)).model?.chain).toMatchObject({ active: 1 })
      const history = yield* sessions.messages({ sessionID: taskID, order: "asc" })
      expect(history.filter((message) => message.type === "user").map((message) => message.text)).toEqual([
        "Plan and review the implementation.",
        "Implement the reviewed plan now.",
      ])
      expect(
        history
          .filter((message) => message.type === "assistant")
          .flatMap((message) => message.content.filter((part) => part.type === "text").map((part) => part.text)),
      ).toEqual(["Plan ready", "Implementation complete"])
    }),
  )

  it.effect("reuses an existing task session when task_id is provided", () =>
    Effect.gen(function* () {
      reset()
      sessionsByID.set(
        existingID,
        sessionInfo(existingID, {
          parentID,
          title: "Existing",
          agent: general.id,
          agentPolicy: {
            tools: { mode: "explicit", entries: {} },
            permissionLayers: [],
            source: { type: "task", sessionID: parentID, agent: build.id },
          },
        }),
      )
      const registry = yield* ToolRegistry.Service

      const result = yield* settleTool(registry, {
        sessionID: parentID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-task-existing",
          name: "task",
          input: { ...taskInput(), task_id: existingID },
        },
      })

      expect(result.output?.structured).toMatchObject({ sessionID: existingID, state: "completed" })
      expect(created).toEqual([])
      expect(prompts[0]).toMatchObject({ sessionID: existingID, agent: general.id, resume: false })
      expect(resumed).toEqual([existingID])
    }),
  )

  it.effect("resuming a saved chain-null child preserves the saved null without override", () =>
    Effect.gen(function* () {
      // Caller fix: resuming WITHOUT a model/variant override re-selects
      // from the saved child model (inherit), so an explicit chain null
      // survives instead of being overwritten by the parent chain. An
      // explicit new override is respected instead (next test).
      reset()
      const lunaNull = {
        id: ModelV2.ID.make("gpt-5.6-luna"),
        providerID: ProviderV2.ID.make("openai"),
        chain: null,
      }
      sessionsByID.set(parentID, sessionInfo(parentID, {
        title: "Parent",
        model: {
          id: ModelV2.ID.make("gpt-5.6-sol"),
          providerID: ProviderV2.ID.make("openai"),
          chain: {
            id: "standard",
            name: "Standard",
            active: 0,
            steps: [
              { id: ModelV2.ID.make("gpt-5.6-sol"), providerID: ProviderV2.ID.make("openai") },
              { id: ModelV2.ID.make("gpt-5.6-luna"), providerID: ProviderV2.ID.make("openai") },
            ],
          },
        },
      }))
      sessionsByID.set(
        existingID,
        sessionInfo(existingID, {
          parentID,
          title: "Saved null child",
          agent: general.id,
          model: lunaNull,
          agentPolicy: {
            tools: { mode: "explicit", entries: {} },
            permissionLayers: [],
            source: { type: "task", sessionID: parentID, agent: build.id },
          },
        }),
      )
      const registry = yield* ToolRegistry.Service

      const result = yield* settleTool(registry, {
        sessionID: parentID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-task-resume-null",
          name: "task",
          input: { ...taskInput(), task_id: existingID },
        },
      })

      expect(result.output?.structured).toMatchObject({ sessionID: existingID, state: "completed" })
      expect(created).toEqual([])
      // The resumed prompt carries the SAVED child model (Luna, chain null),
      // not a parent-derived standard-chain selection.
      expect(prompts[0]).toMatchObject({
        sessionID: existingID,
        agent: general.id,
        resume: false,
        model: { id: "gpt-5.6-luna", providerID: "openai", chain: null },
      })
      expect(resumed).toEqual([existingID])
    }),
  )

  it.effect("resuming a saved chain-null child respects an explicit new model override", () =>
    Effect.gen(function* () {
      // An explicit human override wins over the saved null: resuming with
      // model + variant re-selects from agent + parent and applies the
      // requested step, including its chain.
      reset()
      sessionsByID.set(parentID, sessionInfo(parentID, {
        title: "Parent",
        model: {
          id: ModelV2.ID.make("gpt-5.6-sol"),
          providerID: ProviderV2.ID.make("openai"),
          chain: {
            id: "standard",
            name: "Standard",
            active: 0,
            steps: [
              { id: ModelV2.ID.make("gpt-5.6-sol"), providerID: ProviderV2.ID.make("openai") },
              { id: ModelV2.ID.make("gpt-5.6-luna"), providerID: ProviderV2.ID.make("openai") },
            ],
          },
        },
      }))
      sessionsByID.set(
        existingID,
        sessionInfo(existingID, {
          parentID,
          title: "Saved null child",
          agent: general.id,
          model: {
            id: ModelV2.ID.make("gpt-5.6-luna"),
            providerID: ProviderV2.ID.make("openai"),
            chain: null,
          },
          agentPolicy: {
            tools: { mode: "explicit", entries: {} },
            permissionLayers: [],
            source: { type: "task", sessionID: parentID, agent: build.id },
          },
        }),
      )
      const registry = yield* ToolRegistry.Service

      const result = yield* settleTool(registry, {
        sessionID: parentID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-task-resume-null-override",
          name: "task",
          input: { ...taskInput(), task_id: existingID, model: "openai/gpt-5.6-sol" },
        },
      })

      expect(result.output?.structured).toMatchObject({ sessionID: existingID, state: "completed" })
      expect(prompts[0]?.model).toMatchObject({ id: "gpt-5.6-sol", providerID: "openai" })
      expect(prompts[0]?.model?.chain).not.toBeNull()
      expect(resumed).toEqual([existingID])
    }),
  )

  it.effect("returns the final assistant message from chronological child history", () =>
    Effect.gen(function* () {
      reset()
      resumeOverride = (id) =>
        Effect.sync(() => {
          messagesByID.set(id, [assistant("Working", "msg_task_working"), assistant("Final answer", "msg_task_final")])
        })
      const registry = yield* ToolRegistry.Service

      const result = yield* settleTool(registry, {
        sessionID: parentID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-task-final", name: "task", input: taskInput() },
      })

      expect(result.output?.structured).toEqual({
        sessionID: taskSessionID(result),
        task_id: taskSessionID(result),
        state: "completed",
        text: "Final answer",
        next_action: "none",
      })
      expect(result.result.value).toContain("Final answer")
      expect(result.result.value).not.toContain("Working")
    }),
  )

  it.effect("rejects an invalid task_id before spawning", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service

      const result = yield* settleTool(registry, {
        sessionID: parentID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-task-invalid-id",
          name: "task",
          input: { ...taskInput(), task_id: "not-a-session" },
        },
      })

      expect(result).toEqual({ result: { type: "error", value: "Invalid task_id: not-a-session" } })
      expect(created).toEqual([])
      expect(prompts).toEqual([])
      expect(resumed).toEqual([])
    }),
  )

  it.effect("rejects a task_id that does not exist", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service

      const result = yield* settleTool(registry, {
        sessionID: parentID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-task-missing-id",
          name: "task",
          input: { ...taskInput(), task_id: "ses_task_missing" },
        },
      })

      expect(result).toEqual({ result: { type: "error", value: "Task not found: ses_task_missing" } })
      expect(created).toEqual([])
      expect(prompts).toEqual([])
      expect(resumed).toEqual([])
    }),
  )

  it.effect("rejects a task_id owned by another parent session", () =>
    Effect.gen(function* () {
      reset()
      sessionsByID.set(
        existingID,
        sessionInfo(existingID, { parentID: otherParentID, title: "Wrong", agent: general.id }),
      )
      const registry = yield* ToolRegistry.Service

      const result = yield* settleTool(registry, {
        sessionID: parentID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-task-wrong-parent",
          name: "task",
          input: { ...taskInput(), task_id: existingID },
        },
      })

      expect(result).toEqual({
        result: { type: "error", value: "Task ses_task_existing does not belong to session ses_task_parent" },
      })
      expect(created).toEqual([])
      expect(prompts).toEqual([])
      expect(resumed).toEqual([])
    }),
  )

  it.effect("rejects a task_id from another location", () =>
    Effect.gen(function* () {
      reset()
      sessionsByID.set(
        existingID,
        sessionInfo(existingID, { parentID, title: "Wrong", agent: general.id, location: otherLocation }),
      )
      const registry = yield* ToolRegistry.Service

      const result = yield* settleTool(registry, {
        sessionID: parentID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-task-wrong-location",
          name: "task",
          input: { ...taskInput(), task_id: existingID },
        },
      })

      expect(result).toEqual({
        result: { type: "error", value: "Task ses_task_existing is not in this session location" },
      })
      expect(created).toEqual([])
      expect(prompts).toEqual([])
      expect(resumed).toEqual([])
    }),
  )

  it.effect("rejects a task_id for another agent", () =>
    Effect.gen(function* () {
      reset()
      sessionsByID.set(
        existingID,
        sessionInfo(existingID, { parentID, title: "Wrong", agent: AgentV2.ID.make("other") }),
      )
      const registry = yield* ToolRegistry.Service

      const result = yield* settleTool(registry, {
        sessionID: parentID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-task-wrong-agent",
          name: "task",
          input: { ...taskInput(), task_id: existingID },
        },
      })

      expect(result).toEqual({
        result: { type: "error", value: "Task ses_task_existing belongs to agent other, not general" },
      })
      expect(created).toEqual([])
      expect(prompts).toEqual([])
      expect(resumed).toEqual([])
    }),
  )

  it.effect("returns task_error output when child execution fails", () =>
    Effect.gen(function* () {
      reset()
      resumeOverride = () => Effect.fail(childFailure())
      const registry = yield* ToolRegistry.Service

      const result = yield* settleTool(registry, {
        sessionID: parentID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-task-error", name: "task", input: taskInput() },
      })

      expect(result.result.value).toContain(`<task id="${taskSessionID(result)}" state="error">`)
      expect(result.result.value).toContain("<summary>Task failed: Review code</summary>")
      expect(result.result.value).toContain("child failed")
      expect(result.output?.structured).toMatchObject({ sessionID: taskSessionID(result), state: "error" })
    }),
  )

  it.live("times out a stuck foreground child without interrupting its parent", () =>
    Effect.gen(function* () {
      reset()
      resumeOverride = () => Effect.never
      const registry = yield* ToolRegistry.Service

      const result = yield* settleTool(registry, {
        sessionID: parentID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-task-timeout",
          name: "task",
          input: { ...taskInput(), timeout_ms: 10 },
        },
      })
      const spawnedID = taskSessionID(result)

      expect(result.output?.structured).toEqual({
        sessionID: spawnedID,
        task_id: spawnedID,
        state: "error",
        summary: "Task failed: Review code",
        text: "Task timed out after 10ms",
        next_action: "resume",
      })
      expect(interrupted).toEqual([spawnedID])
      expect(interrupted).not.toContain(parentID)
    }),
  )

  it.live("reports stream failure before timeout when the child stream already failed", () =>
    Effect.gen(function* () {
      // Sol causal shape (evidence 1729): the child stream failed with
      // TypeError: terminated BEFORE the parent timeout fired. The harness
      // projects the stream failure as a terminal assistant error, then the
      // drain hangs (Effect.never AFTER the terminal history exists): the
      // foreground race observes the terminal failure first, so the durable
      // child error is the stream failure and no timeout interrupt fires.
      // Removing the stream-failure setup changes the outcome to a timeout,
      // so the test pins failure-before-timeout ordering, not just text.
      reset()
      const streamFailure = "Failed to read openai/openai-responses-codex stream: TypeError: terminated"
      const events = yield* EventV2.Service
      resumeOverride = (id) =>
        Effect.gen(function* () {
          const prompt = prompts.find((entry) => entry.sessionID === id)
          if (!prompt?.id) return yield* Effect.die("Expected admitted child prompt")
          const failedID = SessionMessage.ID.make("msg_task_timeout_stream_failed")
          messagesByID.set(id, [
            user(prompt.id, prompt.prompt.text),
            assistant("", failedID, { error: { type: "unknown", message: streamFailure } }),
          ])
          yield* events.publish(SessionEvent.Step.Failed, {
            sessionID: id,
            timestamp: DateTime.makeUnsafe(1),
            assistantMessageID: failedID,
            error: { type: "unknown", message: streamFailure },
          })
          return yield* Effect.never
        })
      const registry = yield* ToolRegistry.Service

      const result = yield* settleTool(registry, {
        sessionID: parentID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-task-timeout-after-stream-failure",
          name: "task",
          input: { ...taskInput(), timeout_ms: 10 },
        },
      })
      const spawnedID = taskSessionID(result)

      // Failure-before-timeout: the terminal stream error settles first, so
      // the parent reports the stream failure, NOT a synthetic timeout, and
      // no timeout interrupt fires (child already terminal).
      expect(result.output?.structured).toMatchObject({
        sessionID: spawnedID,
        state: "error",
        text: streamFailure,
        next_action: "resume",
      })
      expect(interrupted).toEqual([])
      expect(interrupted).not.toContain(parentID)
      // The durable stream failure survives: it was projected before the
      // race settled and is not overwritten by a timeout error.
      const childHistory = messagesByID.get(spawnedID) ?? []
      expect(childHistory.some((message) => JSON.stringify(message).includes("TypeError: terminated"))).toBe(true)
    }),
  )

  for (const input of [
    { subagent_type: "review" },
    { subagent_type: "review", workflow: "/multi-agent-review" },
    { subagent_type: "analyst-alias", command: "/neutral-analysis" },
  ]) {
    for (const background of [false, true]) {
      it.effect(`ignores reviewer runtime ceilings for ${JSON.stringify(input)}, background=${background}`, () =>
        Effect.gen(function* () {
          reset()
          const started = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          resumeOverride = (id) =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(
                Effect.sync(() =>
                  messagesByID.set(id, [assistant(JSON.stringify({ findings: [], notes: ["Completed later"] }))]),
                ),
              ),
            )
          const registry = yield* ToolRegistry.Service
          const fiber = yield* settleTool(registry, {
            sessionID: parentID,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-review-ignore-timeout",
              name: "task",
              input: { ...taskInput(), ...input, background, timeout_ms: 10 },
            },
          }).pipe(Effect.forkChild)
          yield* Deferred.await(started)
          yield* adjust("1 hour")
          expect(interrupted).toEqual([])
          if (!background) expect(fiber.pollUnsafe()).toBeUndefined()
          const spawned = background ? yield* Fiber.join(fiber) : undefined
          yield* Deferred.succeed(release, undefined)
          if (!spawned) {
            const result = yield* Fiber.join(fiber)
            expect(result.output?.structured).toMatchObject({
              state: "completed",
              text: expect.stringContaining("Completed later"),
            })
            expect(interrupted).toEqual([])
            return
          }
          const completed = yield* settleTool(registry, {
            sessionID: parentID,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-review-collect",
              name: "task_wait",
              input: { task_ids: [taskSessionID(spawned)] },
            },
          })
          expect(completed.output?.structured).toMatchObject({
            timed_out: false,
            tasks: [{ state: "completed", result: expect.stringContaining("Completed later") }],
          })
          expect(interrupted).toEqual([])
        }),
      )
    }
  }

  it.effect("collects every fanout reviewer despite an accidentally supplied runtime ceiling", () =>
    Effect.gen(function* () {
      reset()
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      resumeOverride = (id) =>
        Effect.gen(function* () {
          if (resumed.length === 2) yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(release)
          const prompt = prompts.find((entry) => entry.sessionID === id)
          if (!prompt?.id) return yield* Effect.die("Expected admitted reviewer prompt")
          messagesByID.set(id, [
            user(prompt.id, prompt.prompt.text),
            assistant(JSON.stringify({ findings: [], notes: ["Completed later"] })),
          ])
        })
      const registry = yield* ToolRegistry.Service
      const fiber = yield* settleTool(registry, {
        sessionID: parentID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-fanout-ignore-timeout",
          name: "multi_agent_fanout",
          input: {
            workflow: "review",
            prompt: "Inspect",
            requested_reviewers: [{ model: "fake/fake-model" }, { model: "fake/fake-model" }],
            timeout_ms: 10,
          },
        },
      }).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* adjust("1 hour")
      expect(fiber.pollUnsafe()).toBeUndefined()
      expect(interrupted).toEqual([])
      yield* Deferred.succeed(release, undefined)
      const result = yield* Fiber.join(fiber)
      expect(result.output?.structured).toMatchObject({ results: [{ status: "success" }, { status: "success" }] })
      expect(created).toHaveLength(2)
      expect(resumed).toHaveLength(2)
      expect(interrupted).toEqual([])
    }),
  )

  it.live("keeps foreground review tasks running when no timeout is configured", () =>
    Effect.gen(function* () {
      reset()
      const release = yield* Deferred.make<void>()
      resumeOverride = (id) =>
        Deferred.await(release).pipe(
          Effect.andThen(Effect.sync(() => messagesByID.set(id, [assistant("Completed later")]))),
        )
      const registry = yield* ToolRegistry.Service
      const fiber = yield* settleTool(registry, {
        sessionID: parentID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-task-no-timeout", name: "task", input: taskInput() },
      }).pipe(Effect.forkChild)

      expect(Option.isNone(yield* Fiber.await(fiber).pipe(Effect.timeoutOption(25)))).toBe(true)
      expect(interrupted).toEqual([])
      yield* Deferred.succeed(release, undefined)
      const result = yield* Fiber.join(fiber)

      expect(result.output?.structured).toMatchObject({ state: "completed", text: "Completed later" })
      expect(interrupted).toEqual([])
    }),
  )

  it.effect("returns task_error output when child execution finishes without assistant text", () =>
    Effect.gen(function* () {
      reset()
      resumeOverride = (id) => Effect.sync(() => messagesByID.set(id, [assistant("  ")]))
      const registry = yield* ToolRegistry.Service

      const result = yield* settleTool(registry, {
        sessionID: parentID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-task-empty", name: "task", input: taskInput() },
      })

      expect(result.result.value).toContain(`<task id="${taskSessionID(result)}" state="error">`)
      expect(result.result.value).toContain("Task fast_error")
      expect(result.output?.structured).toEqual({
        sessionID: taskSessionID(result),
        task_id: taskSessionID(result),
        state: "error",
        summary: "Task failed: Review code",
        text: "Task fast_error: no usable assistant response produced. Do not retry this task unchanged.",
        next_action: "resume",
      })
    }),
  )

  it.effect("returns task_error output when child execution finishes without an assistant message", () =>
    Effect.gen(function* () {
      reset()
      resumeOverride = (id) => Effect.sync(() => messagesByID.set(id, []))
      const registry = yield* ToolRegistry.Service

      const result = yield* settleTool(registry, {
        sessionID: parentID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-task-no-assistant", name: "task", input: taskInput() },
      })

      expect(result.result.value).toContain(`<task id="${taskSessionID(result)}" state="error">`)
      expect(result.result.value).toContain("Task never_settled")
      expect(result.output?.structured).toMatchObject({ sessionID: taskSessionID(result), state: "error" })
    }),
  )

  it.effect("propagates child runner defects instead of returning task_error", () =>
    Effect.gen(function* () {
      reset()
      resumeOverride = () => Effect.die("task resume defect")
      const registry = yield* ToolRegistry.Service

      const defect = yield* settleTool(registry, {
        sessionID: parentID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-task-defect", name: "task", input: taskInput() },
      }).pipe(Effect.catchDefect(Effect.succeed))

      expect(defect).toBe("task resume defect")
    }),
  )

  it.effect("interrupts the child session when parent task execution is interrupted", () =>
    Effect.gen(function* () {
      reset()
      const resumeStarted = yield* Deferred.make<void>()
      const releaseResume = yield* Deferred.make<void>()
      resumeOverride = () =>
        Deferred.succeed(resumeStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseResume)))
      const registry = yield* ToolRegistry.Service

      const fiber = yield* settleTool(registry, {
        sessionID: parentID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-task-interrupt", name: "task", input: taskInput() },
      }).pipe(Effect.forkChild)
      yield* Deferred.await(resumeStarted)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.join(fiber).pipe(Effect.exit)

      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      const interruptedChild = created[0]?.id
      expect(interruptedChild).toBeDefined()
      if (!interruptedChild) return
      expect(interrupted).toEqual([interruptedChild])
    }),
  )

  it.effect("fails before spawning when task permission is denied", () =>
    Effect.gen(function* () {
      reset()
      denyPermission = true
      const registry = yield* ToolRegistry.Service

      const result = yield* settleTool(registry, {
        sessionID: parentID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-task-denied", name: "task", input: taskInput() },
      })

      expect(result).toEqual({ result: { type: "error", value: "Permission denied: task general" } })
      expect(created).toEqual([])
      expect(prompts).toEqual([])
      expect(resumed).toEqual([])
    }),
  )

  it.effect("fails before spawning for an unknown subagent", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service

      const result = yield* settleTool(registry, {
        sessionID: parentID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-task-unknown",
          name: "task",
          input: { ...taskInput(), subagent_type: "missing" },
        },
      })

      expect(result).toEqual({
        result: {
          type: "error",
          value:
            "Unknown agent type: missing is not a valid agent type. Available agent types: build, general, review.",
        },
      })
      expect(created).toEqual([])
      expect(prompts).toEqual([])
      expect(resumed).toEqual([])
    }),
  )

  it.effect("returns a terminal error when the child run is interrupted", () =>
    Effect.gen(function* () {
      reset()
      resumeOverride = () => Effect.interrupt
      const registry = yield* ToolRegistry.Service

      const result = yield* settleTool(registry, {
        sessionID: parentID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-task-child-interrupt", name: "task", input: taskInput() },
      })

      expect(result.output?.structured).toMatchObject({
        state: "error",
        text: "Task was interrupted before completing",
        next_action: "resume",
      })
    }),
  )

  it.effect("settles fanout with a terminal reviewer error when a child run is interrupted", () =>
    Effect.gen(function* () {
      reset()
      resumeOverride = () => Effect.interrupt
      const registry = yield* ToolRegistry.Service

      const result = yield* settleTool(registry, {
        sessionID: parentID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-fanout-child-interrupt",
          name: "multi_agent_fanout",
          input: {
            workflow: "neutral-analysis",
            prompt: "Review the change",
            requested_reviewers: [{ model: "fake/fake-model" }],
          },
        },
      })
      const output = result.output?.structured as
        { results: Array<{ status: "success" | "spawn_no_output" | "error"; task: TaskTool.Output }> } | undefined

      expect(output?.results).toHaveLength(1)
      expect(output?.results[0]?.status).toBe("error")
      expect(output?.results[0]?.task).toMatchObject({
        state: "error",
        text: "Task was interrupted before completing",
        next_action: "resume",
      })
    }),
  )
})

function reset() {
  sessionsByID.clear()
  messagesByID.clear()
  sessionsByID.set(parentID, parent)
  permissionAssertions.length = 0
  created.length = 0
  prompts.length = 0
  resumed.length = 0
  interrupted.length = 0
  denyPermission = false
  deniedAction = undefined
  resumeOverride = undefined
}

function taskInput() {
  return {
    description: "Review code",
    prompt: "Inspect the change",
    subagent_type: "general",
  }
}

function taskSessionID(result: { output?: { structured?: unknown } }) {
  const output = result.output?.structured as TaskTool.Output | undefined
  if (!output) throw new Error("Task output did not include a structured result")
  return output.sessionID
}

function sessionInfo(id: SessionSchema.ID, input: Partial<SessionSchema.Info> = {}) {
  return new SessionSchema.Info({
    id,
    parentID: input.parentID,
    projectID: ProjectV2.ID.make("project"),
    agent: input.agent,
    model: input.model,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
    title: input.title ?? "Session",
    location: input.location ?? location,
    agentPolicy: input.agentPolicy,
  })
}

function assistant(
  text: string,
  id = "msg_task_assistant",
  input: { readonly finish?: string; readonly structured?: unknown; readonly error?: SessionEvent.UnknownError } = {},
) {
  return new SessionMessage.Assistant({
    id: SessionMessage.ID.make(id),
    type: "assistant",
    agent: "general",
    model,
    content: [new SessionMessage.AssistantText({ type: "text", id: "text", text })],
    ...(input.finish === undefined ? {} : { finish: input.finish }),
    ...(input.structured === undefined ? {} : { structured: input.structured }),
    ...(input.error === undefined ? {} : { error: input.error }),
    time: { created: DateTime.makeUnsafe(0), completed: DateTime.makeUnsafe(0) },
  })
}

function user(id: SessionMessage.ID, text: string) {
  return new SessionMessage.User({
    id,
    type: "user",
    text,
    files: [],
    agents: [],
    time: { created: DateTime.makeUnsafe(0) },
  })
}

function childFailure() {
  return new LLMError({
    module: "test",
    method: "stream",
    reason: new TransportReason({ message: "child failed" }),
  })
}
